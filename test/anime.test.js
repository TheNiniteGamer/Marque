'use strict';
// Shows numbered straight through ("[Group] Frieren - 30", "One Piece - 1071"): placed in the season
// the source has each episode in, kept through rescans, and settable per show.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');
const parse = require('../lib/parse');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-anime-'));
// Frieren: season 1 has 28 episodes, season 2 has 10. Bluey: seasons of 52, numbered by season.
const SHOWS = {
  209867: { name: 'Frieren', first_air_date: '2023-09-29', seasons: { 1: 28, 2: 10 } },
  82728: { name: 'Bluey', first_air_date: '2018-10-01', seasons: { 1: 52, 2: 52 } },
};
const tmdb = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/^\/3/, '');
  const send = (body) => { res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }); res.end(JSON.stringify(body || {})); };
  if (p === '/search/tv') {
    const q = url.searchParams.get('query').toLowerCase();
    return send({ results: Object.entries(SHOWS).filter(([, s]) => s.name.toLowerCase() === q).map(([id, s]) => ({ id: Number(id), name: s.name, first_air_date: s.first_air_date })) });
  }
  if (p === '/search/movie') return send({ results: [] });
  let m = /^\/tv\/(\d+)$/.exec(p);
  if (m && SHOWS[m[1]]) {
    const s = SHOWS[m[1]];
    return send({ id: Number(m[1]), name: s.name, first_air_date: s.first_air_date, genres: [], credits: { cast: [] }, images: {},
      seasons: [0, ...Object.keys(s.seasons).map(Number)].map((n) => ({ season_number: n, episode_count: s.seasons[n] || 3 })) });
  }
  m = /^\/tv\/(\d+)\/season\/(\d+)$/.exec(p);
  if (m && SHOWS[m[1]]) {
    const count = SHOWS[m[1]].seasons[m[2]] || 0;
    return send({ episodes: Array.from({ length: count }, (_, i) => ({ episode_number: i + 1, name: `Season ${m[2]} episode ${i + 1}` })) });
  }
  send(null);
});

let srv, admin, frieren, bluey;
const episodes = async (show) => (await admin('GET', `/api/shows/${show.id}`)).data.seasons.flatMap((s) => s.episodes);
const rescan = async () => {
  const lib = (await admin('GET', '/api/libraries')).data[0];
  await admin('POST', `/api/libraries/${lib.id}/scan`, {});
  await until(async () => !(await admin('GET', '/api/status')).data.scanning);
};

test('file names with only a number are noted as maybe counted straight through', () => {
  const p = (f) => parse.parseEpisode(f);
  assert.deepEqual([p('Frieren/[SubsPlease] Frieren - 30 (1080p) [A1B2C3D4].mkv').episode, p('Frieren/[SubsPlease] Frieren - 30 (1080p) [A1B2C3D4].mkv').absolute], [30, true]);
  assert.deepEqual([p('One Piece/One Piece - 1071.mkv').episode, p('One Piece/One Piece - 1071.mkv').absolute], [1071, true]);
  assert.equal(p('Bluey/Season 1/Bluey S01E05.mkv').absolute, false);
});

test.before(async () => {
  await new Promise((r) => tmdb.listen(0, '127.0.0.1', r));
  for (const n of [1, 28, 29, 30]) clip(path.join(ROOT, 'TV', 'Frieren', `[SubsPlease] Frieren - ${String(n).padStart(2, '0')} (1080p) [A1B2C3D4].mkv`));
  clip(path.join(ROOT, 'TV', 'Bluey', 'Season 2', 'Bluey - 05.mkv')); // numbered by season (and that episode exists)
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1', TMDB_API_KEY: 'k', TMDB_API_BASE: `http://127.0.0.1:${tmdb.address().port}/3`,
    AUTO_LIBRARIES: `TV:show:${path.join(ROOT, 'TV')}` });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'dad', password: 'password1' });
  await until(async () => (await admin('GET', '/api/libraries')).data.every((l) => l.scannedAt));
  await until(async () => (await admin('GET', '/api/search?q=Frieren')).data.shows[0]?.year === 2023);
  frieren = (await admin('GET', '/api/search?q=Frieren')).data.shows[0];
  bluey = (await admin('GET', '/api/search?q=Bluey')).data.shows[0];
  await until(async () => (await episodes(frieren)).every((e) => /Season/.test(e.title)));
});
test.after(async () => { await srv?.stop(); tmdb.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const summary = (eps) => eps.map((e) => [e.season, e.episode, e.absoluteNumber, e.title]);

test('episodes past the end of season 1 are placed in season 2, and stay there after a rescan', async () => {
  const expected = [[1, 1, 1, 'Season 1 episode 1'], [1, 28, 28, 'Season 1 episode 28'], [2, 1, 29, 'Season 2 episode 1'], [2, 2, 30, 'Season 2 episode 2']];
  assert.deepEqual(summary(await episodes(frieren)), expected);
  assert.equal((await admin('GET', `/api/shows/${frieren.id}`)).data.numbering, 'auto');
  await rescan();
  assert.deepEqual(summary(await episodes(frieren)), expected, 'kept after rescanning');
  // A show numbered by season is left alone.
  assert.deepEqual(summary(await episodes(bluey)), [[2, 5, null, 'Season 2 episode 5']]);
});

test('numbering can be set for a show', async () => {
  let r = await admin('PUT', `/api/meta/${frieren.id}/numbering`, { numbering: 'season' });
  assert.equal(r.data.numbering, 'season');
  assert.deepEqual((await episodes(frieren)).map((e) => [e.season, e.episode]), [[1, 1], [1, 28], [1, 29], [1, 30]], 'as the files say');
  r = await admin('PUT', `/api/meta/${frieren.id}/numbering`, { numbering: 'auto' });
  assert.deepEqual((await episodes(frieren)).map((e) => [e.season, e.episode]), [[1, 1], [1, 28], [2, 1], [2, 2]]);
  assert.equal((await admin('PUT', `/api/meta/${frieren.id}/numbering`, { numbering: 'sideways' })).status, 400);
  const ep = (await episodes(frieren))[0];
  assert.equal((await admin('PUT', `/api/meta/${ep.id}/numbering`, { numbering: 'auto' })).status, 400, 'shows only');
});
