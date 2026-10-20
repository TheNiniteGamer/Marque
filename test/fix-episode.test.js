'use strict';
// Fix episode: a file whose name has the wrong numbers is pointed at the episode it really is
// (from the show's episode list on TMDB, mocked), and that sticks when files are rescanned.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-fixep-'));
const SEASONS = {
  1: [{ episode_number: 1, name: 'Magic Xylophone' }, { episode_number: 2, name: 'Hospital' }],
  2: [{ episode_number: 5, name: 'Bin Night', still_path: '/bin.jpg' }],
};
const mock = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname.replace(/^\/3/, '');
  const send = (body) => { res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }); res.end(JSON.stringify(body || {})); };
  if (p === '/search/tv') return send({ results: [{ id: 10, name: 'Bluey', first_air_date: '2018-10-01' }] });
  if (p === '/tv/10') return send({ id: 10, name: 'Bluey', first_air_date: '2018-10-01', genres: [], credits: { cast: [] }, images: {}, seasons: [{ season_number: 1 }, { season_number: 2 }] });
  const m = /^\/tv\/10\/season\/(\d+)$/.exec(p);
  if (m) return send({ episodes: SEASONS[m[1]] || [] });
  send(null);
});

let srv, admin, eps;
test.before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${mock.address().port}`;
  clip(path.join(ROOT, 'TV', 'Bluey', 'Season 1', 'Bluey S01E01.mp4'));
  clip(path.join(ROOT, 'TV', 'Bluey', 'Season 1', 'Bluey S01E02.mp4')); // really S02E05
  clip(path.join(ROOT, 'Movies', 'Film (2020).mp4'));
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TMDB_API_KEY: 'k', TMDB_API_BASE: `${base}/3`, TMDB_IMAGE_BASE: 'https://img.example', TVMAZE_DISABLED: '1',
    AUTO_LIBRARIES: `TV:show:${path.join(ROOT, 'TV')};Movies:movie:${path.join(ROOT, 'Movies')}` });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  await until(async () => (await admin('GET', '/api/libraries')).data.every((l) => l.scannedAt));
  const show = (await admin('GET', '/api/search?q=Bluey')).data.shows[0];
  await until(async () => (await admin('GET', `/api/shows/${show.id}`)).data.seasons[0]?.episodes.every((e) => e.title !== 'Episode 1' && e.title !== 'Episode 2'));
  eps = (await admin('GET', `/api/shows/${show.id}`)).data.seasons[0].episodes;
});
test.after(async () => { await srv?.stop(); mock.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('the show’s episodes are listed to pick from, with which file each is now', async () => {
  const wrong = eps.find((e) => e.episode === 2);
  assert.equal(wrong.title, 'Hospital', 'named S01E02, so it shows S01E02’s details');
  const d = (await admin('GET', `/api/meta/${wrong.id}/episodes`)).data;
  assert.equal(d.show.title, 'Bluey');
  assert.equal(d.show.matched, true);
  assert.deepEqual(d.current, { season: 1, episode: 2, byHand: false });
  assert.deepEqual(d.choices.map((c) => [c.season, c.episode, c.title]), [[1, 1, 'Magic Xylophone'], [1, 2, 'Hospital'], [2, 5, 'Bin Night']]);
  assert.equal(d.choices[0].takenBy, 'Bluey S01E01.mp4');
  assert.equal(d.choices[1].takenBy, null, '(itself)');
  assert.equal(d.choices[2].thumb, 'https://img.example/w500/bin.jpg');
});

test('picking the right episode moves the file there, and it sticks through a rescan', async () => {
  const wrong = eps.find((e) => e.episode === 2);
  const r = await admin('PUT', `/api/meta/${wrong.id}/episode`, { season: 2, episode: 5 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let it = (await admin('GET', `/api/items/${wrong.id}`)).data;
  assert.deepEqual([it.season, it.episode, it.title], [2, 5, 'Bin Night']);
  const show = (await admin('GET', `/api/shows/${it.showId}`)).data;
  assert.deepEqual(show.seasons.map((s) => s.episodes.length), [1, 1], 'now in season 2');

  await admin('POST', '/api/scan');
  await until(async () => !(await admin('GET', '/api/status')).data.scanning);
  it = (await admin('GET', `/api/items/${wrong.id}`)).data;
  assert.deepEqual([it.season, it.episode, it.title], [2, 5, 'Bin Night'], 'kept after rescanning');

  // And back to what the file name says.
  assert.equal((await admin('PUT', `/api/meta/${wrong.id}/episode`, { season: null, episode: null })).status, 200);
  it = (await admin('GET', `/api/items/${wrong.id}`)).data;
  assert.deepEqual([it.season, it.episode, it.title], [1, 2, 'Hospital']);
  assert.equal((await admin('GET', `/api/meta/${wrong.id}/episodes`)).data.current.byHand, false);
});

test('bad numbers, movies and other people are turned away', async () => {
  const ep = eps[0];
  assert.equal((await admin('PUT', `/api/meta/${ep.id}/episode`, { season: -1, episode: 2 })).status, 400);
  assert.equal((await admin('PUT', `/api/meta/${ep.id}/episode`, { season: 1, episode: 'two' })).status, 400);
  const film = (await admin('GET', '/api/search?q=Film')).data.movies[0];
  assert.equal((await admin('GET', `/api/meta/${film.id}/episodes`)).status, 400);
  await admin('POST', '/api/users', { username: 'kid', password: 'password2' });
  const kid = srv.client();
  await kid('POST', '/api/auth/login', { username: 'kid', password: 'password2' });
  assert.equal((await kid('PUT', `/api/meta/${ep.id}/episode`, { season: 1, episode: 2 })).status, 403);
});
