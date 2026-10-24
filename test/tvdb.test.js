'use strict';
// TheTVDB as a third source for shows, against a local stand-in for its API (and TVmaze's): signing
// in with a key and PIN, searching, matching a show with its episodes numbered TheTVDB's way (as
// Sonarr numbers them), and looking new shows up there first when Settings say so.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-tvdb-'));
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fe0d0a2db40000000049454e44ae426082', 'hex');
const KEY = 'tvdb-project-key';
const PIN = '4321';

const tvdb = { logins: 0, tokens: new Set(), expire: false };
// "Odd Show": TVmaze has its first episode as "Maze Pilot"; TheTVDB (and Sonarr) has two, in English
// translation, with a Japanese original title.
const SERIES = {
  4242: {
    id: 4242, name: '奇妙なショー', year: '2018', firstAired: '2018-04-01', image: '/banners/posters/4242.png', genres: [{ name: 'Animation' }],
    contentRatings: [{ name: 'TV-14', country: 'usa' }, { name: '12', country: 'deu' }],
    translations: { nameTranslations: [{ language: 'jpn', name: '奇妙なショー' }, { language: 'eng', name: 'Odd Show' }], overviewTranslations: [{ language: 'eng', overview: 'A very odd show.' }] },
    artworks: [{ type: 2, image: 'https://artworks.thetvdb.com/p-de.png', language: 'deu', score: 99 }, { type: 2, image: '/banners/p-en.png', language: 'eng', score: 5 }, { type: 3, image: '/banners/bg.png', language: null, score: 1 }],
    characters: [{ name: 'Hero', personName: 'Vo Ice', peopleType: 'Actor', sort: 1 }, { name: null, personName: 'Di Rector', peopleType: 'Director', sort: 0 }],
    episodes: [
      { seasonNumber: 1, number: 1, name: 'TVDB Pilot', overview: 'Where it starts.', aired: '2018-04-01', image: '/banners/e1.png' },
      { seasonNumber: 1, number: 2, name: 'Second Wind', aired: '2018-04-08' },
      { seasonNumber: 2, number: 1, name: 'Coming Soon', aired: '2999-01-01' },
    ],
  },
  5151: { id: 5151, name: 'Later Show', year: '2021', translations: { nameTranslations: [{ language: 'eng', name: 'Later Show' }] }, artworks: [], episodes: [{ seasonNumber: 1, number: 1, name: 'Later Pilot' }] },
};

let BASE;
const mock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname.startsWith('/img/') || url.pathname.startsWith('/banners/') || url.pathname.endsWith('.png')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(png); }
  if (url.pathname === '/tvmaze/search/shows') {
    const later = /later/i.test(url.searchParams.get('q'));
    return send(200, [{ score: 1, show: { id: later ? 66 : 65, name: later ? 'Later Show' : 'Odd Show', premiered: later ? '2021-01-01' : '2018-04-01' } }]);
  }
  if (/^\/tvmaze\/shows\/6[56]$/.test(url.pathname)) {
    return send(200, { id: 65, name: 'Odd Show', premiered: '2018-04-01', _embedded: { episodes: [{ season: 1, number: 1, name: 'Maze Pilot' }] } });
  }
  if (url.pathname.startsWith('/tvdb/')) {
    const p = url.pathname.slice(5);
    if (p === '/login') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const b = JSON.parse(body);
        if (b.apikey !== KEY || b.pin !== PIN) return send(401, { status: 'failure', message: 'Unauthorized' });
        tvdb.logins++;
        const token = `tok${tvdb.logins}`;
        tvdb.tokens.add(token);
        send(200, { status: 'success', data: { token } });
      });
      return;
    }
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!tvdb.tokens.has(token)) return send(401, { status: 'failure' });
    if (tvdb.expire) { tvdb.expire = false; tvdb.tokens.clear(); return send(401, { status: 'failure' }); }
    if (p === '/search') {
      const q = url.searchParams.get('query').toLowerCase();
      const hits = Object.values(SERIES).filter((s) => s.translations.nameTranslations.some((t) => t.name.toLowerCase().includes(q)));
      return send(200, { data: hits.map((s) => ({ tvdb_id: String(s.id), name: s.name, year: s.year, translations: { eng: s.translations.nameTranslations.find((t) => t.language === 'eng').name }, thumbnail: `${BASE}/img/t.png` })) });
    }
    let m = /^\/series\/(\d+)\/extended$/.exec(p);
    if (m) { const s = SERIES[m[1]]; return s ? send(200, { data: { ...s, episodes: undefined } }) : send(404, {}); }
    m = /^\/series\/(\d+)\/episodes\/default\/eng$/.exec(p);
    if (m) { const s = SERIES[m[1]]; return s ? send(200, { data: { series: { id: s.id }, episodes: s.episodes } }) : send(404, {}); }
  }
  send(404, {});
});

let srv, admin;
const ids = {};

test.before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${mock.address().port}`;
  clip(path.join(ROOT, 'TV', 'Odd Show', 'Season 01', 'Odd Show - S01E01.mp4'));
  clip(path.join(ROOT, 'TV', 'Odd Show', 'Season 01', 'Odd Show - S01E02.mp4'));
  srv = await startServer({
    IMAGE_URLS_ALLOW_LOCAL: '1', DATA_DIR: path.join(ROOT, 'data'),
    TMDB_API_BASE: `${BASE}/3`, TVMAZE_API_BASE: `${BASE}/tvmaze`, TVDB_API_BASE: `${BASE}/tvdb`,
  });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  ids.tv = (await admin('POST', '/api/libraries', { name: 'TV', type: 'show', paths: [path.join(ROOT, 'TV')] })).data.id;
  ids.show = (await until(async () => (await admin('GET', `/api/libraries/${ids.tv}/items`)).data.items[0])).id;
});

test.after(async () => {
  await srv?.stop();
  mock.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const showOf = async (id) => (await admin('GET', `/api/shows/${id}`)).data;

test('TheTVDB is off without a key; a key is checked by signing in (with the PIN) and never sent back', async () => {
  const s = (await admin('GET', '/api/settings')).data;
  assert.equal(s.providers.find((p) => p.id === 'tvdb').enabled, false);
  assert.equal(s.tvdbKeySet, false);
  await until(async () => (await showOf(ids.show)).match?.provider === 'tvmaze');

  assert.equal((await admin('PATCH', '/api/settings', { tvdbKey: 'wrong', tvdbPin: PIN })).status, 400);
  const noPin = await admin('PATCH', '/api/settings', { tvdbKey: KEY });
  assert.equal(noPin.status, 400, 'this key needs a subscriber PIN');
  assert.match(noPin.data.error, /TheTVDB/);
  const ok = await admin('PATCH', '/api/settings', { tvdbKey: KEY, tvdbPin: PIN });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.tvdbKeySet, true);
  assert.equal(ok.data.tvdbPinSet, true);
  assert.ok(!JSON.stringify(ok.data).includes(KEY) && !JSON.stringify(ok.data).includes(PIN));
  assert.equal(ok.data.providers.find((p) => p.id === 'tvdb').enabled, true);
});

test('Fix match: a show moved to TheTVDB gets its English title, rating, cast, artwork and episode names', async () => {
  const found = await admin('GET', '/api/metadata/search?kind=show&q=odd&provider=tvdb');
  assert.deepEqual(found.data.results.map((x) => [x.provider, x.id, x.title, x.year]), [['tvdb', '4242', 'Odd Show', 2018]]);
  const r = await admin('POST', `/api/meta/${ids.show}/match`, { provider: 'tvdb', id: '4242' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const show = await showOf(ids.show);
  assert.equal(show.title, 'Odd Show', 'the English name, not the original Japanese one');
  assert.equal(show.overview, 'A very odd show.');
  assert.equal(show.contentRating, 'TV-14', 'the US rating');
  assert.deepEqual(show.cast.map((c) => c.name), ['Vo Ice'], 'actors only');
  assert.deepEqual(show.match, { provider: 'tvdb', providerId: '4242', uncertain: false });
  const eps = show.seasons[0].episodes;
  assert.deepEqual(eps.map((e) => e.title), ['TVDB Pilot', 'Second Wind'], 'numbered as TheTVDB (and Sonarr) number them');
  assert.equal((await admin('GET', `/api/art/poster/${ids.show}`)).status, 200);
  const imgs = (await admin('GET', `/api/meta/${ids.show}/images`)).data;
  assert.equal(imgs.poster[0].url, `https://artworks.thetvdb.com/banners/p-en.png`, 'English artwork first, whole addresses');
  assert.equal(imgs.backdrop.length, 1);
});

test('one sign-in serves many lookups, and an expired one is renewed', async () => {
  const before = tvdb.logins;
  for (let i = 0; i < 3; i++) await admin('GET', '/api/metadata/search?kind=show&q=odd&provider=tvdb');
  assert.equal(tvdb.logins, before, 'no new sign-ins');
  tvdb.expire = true;
  const r = await admin('GET', '/api/metadata/search?kind=show&q=odd&provider=tvdb');
  assert.equal(r.data.results.length, 1);
  assert.equal(tvdb.logins, before + 1);
});

test('with “TheTVDB first”, a new show is matched there', async () => {
  assert.equal((await admin('PATCH', '/api/settings', { preferTvdb: true })).data.preferTvdb, true);
  clip(path.join(ROOT, 'TV', 'Later Show', 'Season 01', 'Later Show - S01E01.mp4'));
  await admin('POST', `/api/libraries/${ids.tv}/scan`);
  const later = await until(async () => (await admin('GET', `/api/libraries/${ids.tv}/items`)).data.items.find((x) => x.title === 'Later Show'));
  const show = await until(async () => { const s = await showOf(later.id); return s.match?.provider && s; });
  assert.equal(show.match.provider, 'tvdb');
  assert.equal(show.seasons[0].episodes[0].title, 'Later Pilot');
  assert.equal((await showOf(ids.show)).match.provider, 'tvdb', 'Odd Show keeps its match');
});

test('removing the key turns it off; shows keep what they have', async () => {
  const r = await admin('PATCH', '/api/settings', { tvdbKey: '' });
  assert.equal(r.data.tvdbKeySet, false);
  assert.equal(r.data.preferTvdb, false);
  assert.equal((await showOf(ids.show)).title, 'Odd Show');
});
