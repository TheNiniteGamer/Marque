'use strict';
// Metadata matching, editing and artwork, against a local mock of the TMDB and TVmaze APIs.
// Also covers My List and "remove from Continue Watching".

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-meta-'));
// Smallest valid PNG (1x1), with a byte we vary so different images have different content.
const png = (n = 0) => Buffer.from(`89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8${(0xff - n).toString(16).padStart(2, '0')}ff3f0005fe02fe0d0a2db40000000049454e44ae426082`, 'hex');
const GOOD_KEY = 'goodkey123';

// ---------- mock providers ----------
const MOVIES = {
  101: { id: 101, title: 'Test Clip', release_date: '2020-05-01', overview: 'The real test clip.', tagline: 'It is a test.', vote_average: 7.46,
    genres: [{ name: 'Drama' }, { name: 'Mystery' }], poster_path: '/p101.png', backdrop_path: '/b101.png',
    credits: { cast: [{ name: 'Ada Actor', character: 'Lead' }, { name: 'Bo Bit', character: 'Friend' }] },
    images: { posters: [{ file_path: '/p101.png' }, { file_path: '/p101alt.png' }], backdrops: [{ file_path: '/b101.png' }] } },
  202: { id: 202, title: 'Totally Different Film', release_date: '1999-01-01', overview: 'Another movie.', genres: [{ name: 'Comedy' }],
    poster_path: '/p202.png', credits: { cast: [] }, images: { posters: [], backdrops: [] } },
};
const requests = [];
let tvmazeDown = false;
const mock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  requests.push(url.pathname + url.search);
  if (tvmazeDown && url.pathname.startsWith('/tvmaze/')) { res.writeHead(503); return res.end(); }
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname.startsWith('/img/')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(png(url.pathname.length % 50)); }
  if (url.pathname.startsWith('/3/')) {
    if (url.searchParams.get('api_key') !== GOOD_KEY) return send(401, { status_message: 'Invalid API key' });
    const p = url.pathname.slice(2);
    if (p === '/configuration') return send(200, { images: {} });
    if (p === '/search/movie') {
      const q = url.searchParams.get('query').toLowerCase();
      return send(200, { results: Object.values(MOVIES).filter((m) => m.title.toLowerCase().includes(q) || q.includes('other')) });
    }
    const m = /^\/movie\/(\d+)$/.exec(p);
    if (m) return MOVIES[m[1]] ? send(200, MOVIES[m[1]]) : send(404, {});
    if (p === '/search/tv') return send(200, { results: [] });
    return send(404, {});
  }
  if (url.pathname === '/tvmaze/search/shows') {
    const name = /fresh/i.test(url.searchParams.get('q')) ? 'Fresh Show' : 'Some Show';
    return send(200, [{ score: 1, show: { id: 55, name, premiered: '2019-02-03', summary: '<p>A <b>great</b> show.</p>', image: { medium: `${BASE}/img/tvm/poster.png` } } }]);
  }
  if (url.pathname === '/tvmaze/shows/55') {
    return send(200, {
      id: 55, name: 'Some Show', premiered: '2019-02-03', summary: '<p>A <b>great</b> show.</p>', genres: ['Comedy'], rating: { average: 8.1 },
      image: { original: `${BASE}/img/tvm/poster.png` },
      _embedded: {
        episodes: [{ season: 1, number: 1, name: 'Pilot', summary: '<p>It begins.</p>', airdate: '2019-02-03', image: { original: `${BASE}/img/tvm/e1.png` } }],
        cast: [{ person: { name: 'Cam Comic' }, character: { name: 'Host' } }],
        images: [{ type: 'background', resolutions: { original: { url: `${BASE}/img/tvm/bg.png` } } }],
      },
    });
  }
  send(404, {});
});
let BASE;

let srv, admin, viewer;
const ids = {};

test.before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${mock.address().port}`;
  clip(path.join(ROOT, 'Movies', 'Test Clip (2020).mp4'));
  clip(path.join(ROOT, 'TV', 'Some Show', 'Season 01', 'Some Show - S01E01.mp4'));
  srv = await startServer({
    IMAGE_URLS_ALLOW_LOCAL: '1', // (the stand-in for TMDB runs on this PC)
    DATA_DIR: path.join(ROOT, 'data'),
    TMDB_API_BASE: `${BASE}/3`, TMDB_IMAGE_BASE: `${BASE}/img`, TVMAZE_API_BASE: `${BASE}/tvmaze`,
  });
  admin = srv.client();
  viewer = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  ids.movies = (await admin('POST', '/api/libraries', { name: 'Movies', type: 'movie', paths: [path.join(ROOT, 'Movies')] })).data.id;
  ids.tv = (await admin('POST', '/api/libraries', { name: 'TV', type: 'show', paths: [path.join(ROOT, 'TV')] })).data.id;
  await until(async () => (await admin('GET', '/api/status')).data.scanning === false &&
    (await admin('GET', '/api/libraries')).data.every((l) => l.count === 1));
  ids.movie = (await admin('GET', `/api/libraries/${ids.movies}/items`)).data.items[0].id;
  ids.show = (await admin('GET', `/api/libraries/${ids.tv}/items`)).data.items[0].id;
});

test.after(async () => {
  await srv?.stop();
  mock.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('TV shows are matched through TVmaze without any API key', async () => {
  const show = await until(async () => { const s = (await admin('GET', `/api/shows/${ids.show}`)).data; return s.match?.provider && s; });
  assert.equal(show.match.provider, 'tvmaze');
  assert.equal(show.overview, 'A great show.', 'HTML is stripped from summaries');
  assert.deepEqual(show.genres, ['Comedy']);
  assert.equal(show.cast[0].name, 'Cam Comic');
  const ep = show.seasons[0].episodes[0];
  assert.equal(ep.title, 'Pilot');
  assert.equal(ep.overview, 'It begins.');
  const poster = await admin('GET', `/api/art/poster/${ids.show}`);
  assert.equal(poster.status, 200);
  assert.ok(poster.data.subarray(1, 4).equals(Buffer.from('PNG')));
});

test('movies need a TMDB key; a bad key is rejected and a good one is saved', async () => {
  const noKey = await admin('GET', '/api/metadata/search?kind=movie&q=test');
  assert.equal(noKey.status, 400);
  assert.match(noKey.data.error, /TMDB API key/);
  assert.equal((await admin('PATCH', '/api/settings', { tmdbKey: 'wrong' })).status, 400);
  const ok = await admin('PATCH', '/api/settings', { tmdbKey: GOOD_KEY });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.tmdbKeySet, true);
  assert.equal(ok.data.tmdbKeyHint, '••••y123', 'the key itself is never sent back');
  assert.ok(!JSON.stringify(ok.data).includes(GOOD_KEY));
});

test('refresh matches the movie and pulls title, genres, cast and artwork', async () => {
  const r = await admin('POST', `/api/meta/${ids.movie}/refresh`);
  assert.equal(r.status, 200);
  assert.equal(r.data.title, 'Test Clip');
  assert.equal(r.data.tagline, 'It is a test.');
  assert.deepEqual(r.data.genres, ['Drama', 'Mystery']);
  assert.equal(r.data.rating, 7.5);
  assert.deepEqual(r.data.cast.map((c) => c.name), ['Ada Actor', 'Bo Bit']);
  assert.deepEqual(r.data.match, { provider: 'tmdb', providerId: '101', uncertain: false });
  const imgs = await admin('GET', `/api/meta/${ids.movie}/images`);
  assert.equal(imgs.data.poster.length, 2);
});

test('fix match: search and pick a different title', async () => {
  const s = await admin('GET', '/api/metadata/search?kind=movie&q=other');
  assert.ok(s.data.results.some((x) => x.id === '202' && x.year === 1999 && x.thumb));
  const r = await admin('POST', `/api/meta/${ids.movie}/match`, { provider: 'tmdb', id: '202' });
  assert.equal(r.data.title, 'Totally Different Film');
  assert.equal((await admin('POST', `/api/meta/${ids.movie}/match`, { provider: 'tmdb', id: '999' })).status, 404);
  await admin('POST', `/api/meta/${ids.movie}/match`, { provider: 'tmdb', id: '101' });
});

test('edits beat fetched metadata, survive refresh and rescans, and can be reset', async () => {
  const e = await admin('PATCH', `/api/meta/${ids.movie}`, { title: 'My Custom Title', sortTitle: 'Custom', genres: 'Home Movies, Favourites', year: 1988 });
  assert.equal(e.data.title, 'My Custom Title');
  assert.equal(e.data.year, 1988);
  assert.deepEqual(e.data.genres, ['Home Movies', 'Favourites']);
  assert.equal((await admin('PATCH', `/api/meta/${ids.movie}`, { year: 'abc' })).status, 400);

  await admin('POST', `/api/meta/${ids.movie}/refresh`);
  // Touch the file so the scanner re-probes it (this used to drop edits).
  const file = path.join(ROOT, 'Movies', 'Test Clip (2020).mp4');
  fs.appendFileSync(file, Buffer.alloc(16));
  await admin('POST', `/api/libraries/${ids.movies}/scan`);
  await until(async () => !(await admin('GET', '/api/status')).data.scanning);
  const after = (await admin('GET', `/api/items/${ids.movie}`)).data;
  assert.equal(after.title, 'My Custom Title');
  assert.equal(after.overview, 'The real test clip.', 'fields that were not edited still come from TMDB');
  assert.ok((await admin('GET', '/api/search?q=custom')).data.movies.length, 'search finds edited titles');

  const reset = await admin('PATCH', `/api/meta/${ids.movie}`, { title: null, year: null });
  assert.equal(reset.data.title, 'Test Clip');
  assert.equal(reset.data.year, 2020);
  const desc = (await admin('GET', `/api/meta/${ids.movie}`)).data;
  assert.deepEqual(desc.fields.title, { edited: null, fetched: 'Test Clip', file: 'Test Clip' });
});

test('custom artwork: upload, set from URL, reject non-images, reset', async () => {
  const before = (await admin('GET', `/api/items/${ids.movie}`)).data.artV;
  const up = await admin('PUT', `/api/meta/${ids.movie}/art/poster`, null, { raw: png(7), type: 'image/png' });
  assert.equal(up.status, 200);
  assert.notEqual(up.data.artV, before, 'art version changes so browsers refetch');
  assert.ok((await admin('GET', `/api/art/poster/${ids.movie}`)).data.equals(png(7)));

  const fromUrl = await admin('PUT', `/api/meta/${ids.movie}/art/backdrop`, { url: `${BASE}/img/custom-bg.png` });
  assert.equal(fromUrl.status, 200);
  assert.equal((await admin('PUT', `/api/meta/${ids.movie}/art/poster`, null, { raw: Buffer.from('not an image'), type: 'image/png' })).status, 400);
  assert.equal((await admin('PUT', `/api/meta/${ids.movie}/art/poster`, { url: 'file:///etc/passwd' })).status, 400);
  assert.equal((await admin('PUT', `/api/meta/${ids.movie}/art/thumb`, null, { raw: png(1), type: 'image/png' })).status, 400, 'movies have no thumb');

  await admin('DELETE', `/api/meta/${ids.movie}/art/poster`);
  assert.ok(!(await admin('GET', `/api/art/poster/${ids.movie}`)).data.equals(png(7)));
});

test('episodes can be edited too', async () => {
  const ep = (await admin('GET', `/api/shows/${ids.show}`)).data.seasons[0].episodes[0];
  const r = await admin('PATCH', `/api/meta/${ep.id}`, { title: 'The Real Pilot', year: 2000 });
  assert.equal(r.data.title, 'The Real Pilot');
  assert.equal((await admin('POST', `/api/meta/${ep.id}/unmatch`)).status, 400);
});

test('unmatch reverts to file info and is not re-matched by scans', async () => {
  const r = await admin('POST', `/api/meta/${ids.show}/unmatch`);
  assert.equal(r.data.overview, null);
  assert.deepEqual(r.data.match, { unmatched: true });
  assert.equal(r.data.seasons[0].episodes[0].title, 'The Real Pilot', 'edits stay');
  await admin('POST', `/api/libraries/${ids.tv}/scan`);
  await until(async () => !(await admin('GET', '/api/status')).data.scanning);
  assert.deepEqual((await admin('GET', `/api/shows/${ids.show}`)).data.match, { unmatched: true });
});

test('My List: add, show on home, remove; only for visible titles', async () => {
  await admin('PUT', `/api/watchlist/${ids.movie}`);
  await admin('PUT', `/api/watchlist/${ids.show}`);
  const list = (await admin('GET', '/api/watchlist')).data;
  assert.deepEqual(list.map((x) => x.id).sort(), [ids.movie, ids.show].sort());
  const hub = (await admin('GET', '/api/home')).data.hubs.find((h) => h.key === 'watchlist');
  assert.equal(hub.items.length, 2);
  assert.equal((await admin('GET', `/api/items/${ids.movie}`)).data.inWatchlist, true);
  await admin('DELETE', `/api/watchlist/${ids.movie}`);
  assert.equal((await admin('GET', '/api/watchlist')).data.length, 1);

  await admin('POST', '/api/users', { username: 'viewer', password: 'password2', libraries: [ids.tv] });
  await viewer('POST', '/api/auth/login', { username: 'viewer', password: 'password2' });
  assert.equal((await viewer('PUT', `/api/watchlist/${ids.movie}`)).status, 404, 'cannot add a title from a hidden library');
  assert.equal((await viewer('GET', '/api/watchlist')).data.length, 0, 'lists are per user');
  assert.equal((await viewer('PATCH', `/api/meta/${ids.show}`, { title: 'x' })).status, 403, 'only admins edit');
});

test('remove from Continue Watching until there is new activity', async () => {
  await admin('POST', `/api/items/${ids.movie}/progress`, { position: 0.3 });
  const cw = async () => (await admin('GET', '/api/home')).data.hubs.find((h) => h.key === 'continue')?.items.map((x) => x.id) || [];
  // Movies need > 15 s of progress to count; use the episode (show "up next") instead.
  const ep = (await admin('GET', `/api/shows/${ids.show}`)).data.seasons[0].episodes[0];
  await admin('POST', `/api/items/${ep.id}/progress`, { position: 0.2 });
  assert.ok((await cw()).includes(ep.id));
  await admin('POST', `/api/continue/${ep.id}/hide`);
  assert.ok(!(await cw()).includes(ep.id));
  await new Promise((r) => setTimeout(r, 5));
  await admin('POST', `/api/items/${ep.id}/progress`, { position: 0.4 });
  assert.ok((await cw()).includes(ep.id), 'comes back after watching again');
});

test('a show added while the provider is unreachable is matched on a later scan', async () => {
  clip(path.join(ROOT, 'TV', 'Fresh Show', 'Season 01', 'Fresh Show - S01E01.mp4'));
  tvmazeDown = true;
  await admin('POST', `/api/libraries/${ids.tv}/scan`);
  const fresh = await until(async () => {
    if ((await admin('GET', '/api/status')).data.scanning) return null;
    return (await admin('GET', `/api/libraries/${ids.tv}/items`)).data.items.find((x) => x.title === 'Fresh Show');
  });
  assert.equal((await admin('GET', `/api/shows/${fresh.id}`)).data.match, null, 'not marked as "no match" while offline');
  tvmazeDown = false;
  await admin('POST', `/api/libraries/${ids.tv}/scan`);
  await until(async () => !(await admin('GET', '/api/status')).data.scanning && (await admin('GET', `/api/shows/${fresh.id}`)).data.match?.provider);
});

test('API keys go to the provider, not the browser; image downloads use https/http only', () => {
  assert.ok(requests.some((r) => r.startsWith('/3/movie/101')));
  assert.ok(requests.every((r) => !r.includes('file:')));
});
