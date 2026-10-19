'use strict';
// The sound and subtitle languages picked for an episode are remembered for the whole show.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-tracks-'));
let srv, admin, eps, movie;
test.before(async () => {
  clip(path.join(ROOT, 'TV', 'Bluey', 'Season 01', 'Bluey - S01E01.mp4'));
  clip(path.join(ROOT, 'TV', 'Bluey', 'Season 01', 'Bluey - S01E02.mp4'));
  clip(path.join(ROOT, 'Movies', 'Heat (1995)', 'Heat (1995).mp4'));
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), AUTO_LIBRARIES: `TV:show:${path.join(ROOT, 'TV')};Movies:movie:${path.join(ROOT, 'Movies')}` });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  await until(async () => (await admin('GET', '/api/libraries')).data.every((l) => l.scannedAt));
  const libs = (await admin('GET', '/api/libraries')).data;
  const show = (await admin('GET', `/api/libraries/${libs.find((l) => l.type === 'show').id}/items`)).data.items[0];
  eps = (await admin('GET', `/api/shows/${show.id}`)).data.seasons.flatMap((s) => s.episodes);
  movie = (await admin('GET', `/api/libraries/${libs.find((l) => l.type === 'movie').id}/items`)).data.items[0];
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('a show remembers the languages picked in any of its episodes', async () => {
  assert.equal((await admin('GET', `/api/items/${eps[1].id}`)).data.tracks, null);
  const r = await admin('PUT', `/api/items/${eps[0].id}/tracks`, { audio: 'JPN', subs: 'eng' });
  assert.deepEqual(r.data.tracks, { audio: 'jpn', subs: 'eng' });
  assert.deepEqual((await admin('GET', `/api/items/${eps[1].id}`)).data.tracks, { audio: 'jpn', subs: 'eng' });
  await admin('PUT', `/api/items/${eps[1].id}/tracks`, { audio: null, subs: 'off' });
  assert.deepEqual((await admin('GET', `/api/items/${eps[0].id}`)).data.tracks, { audio: null, subs: 'off' });
  // Junk is dropped; films aren't remembered.
  assert.deepEqual((await admin('PUT', `/api/items/${eps[0].id}/tracks`, { audio: '<script>', subs: 42 })).data.tracks, { audio: null, subs: null });
  assert.equal((await admin('PUT', `/api/items/${movie.id}/tracks`, { audio: 'eng' })).data.tracks, null);
});
