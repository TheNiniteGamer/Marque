'use strict';
// Scans that must not lose anything: a library folder that is empty or can't be read (an unmounted or
// dropped-out drive) keeps its titles, and a renamed or replaced file (a Radarr/Sonarr upgrade) keeps
// its history.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');
const { identity } = require('../lib/scanner');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-scan-safety-'));
const MOVIES = path.join(ROOT, 'Movies');
const TV = path.join(ROOT, 'TV');
let srv, admin;

const libraries = async () => (await admin('GET', '/api/libraries')).data;
const itemsOf = async (lib) => (await admin('GET', `/api/libraries/${lib.id}/items`)).data.items;
async function scan(lib) {
  const before = (await libraries()).find((l) => l.id === lib.id).scannedAt;
  await admin('POST', `/api/libraries/${lib.id}/scan`);
  await until(async () => (await libraries()).find((l) => l.id === lib.id).scannedAt !== before, 30_000);
}

test.before(async () => {
  clip(path.join(MOVIES, 'Film A (2001)', 'Film A (2001) Bluray-720p.mp4'), 2);
  clip(path.join(MOVIES, 'Film B (2002)', 'Film B (2002).mp4'), 2);
  clip(path.join(TV, 'Some Show', 'Season 1', 'Some Show - S01E01 - Pilot HDTV-720p.mp4'), 2);
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1',
    AUTO_LIBRARIES: `Movies:movie:${MOVIES};TV:show:${TV}` });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'dad', password: 'password1' });
  await until(async () => (await libraries()).every((l) => l.scannedAt));
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('titles stay while their drive is missing, empty or unreadable', async () => {
  const lib = (await libraries()).find((l) => l.name === 'Movies');
  assert.equal((await itemsOf(lib)).length, 2);
  // An unmounted drive: the folder is there, but empty.
  const away = path.join(ROOT, 'away');
  fs.renameSync(MOVIES, away);
  fs.mkdirSync(MOVIES);
  await scan(lib);
  assert.equal((await itemsOf(lib)).length, 2, 'an empty library folder keeps its titles');
  fs.rmdirSync(MOVIES);
  fs.renameSync(away, MOVIES);
  await scan(lib);
  assert.equal((await itemsOf(lib)).length, 2);
});

test('a file Radarr or Sonarr renamed or upgraded keeps its history', async () => {
  const movies = (await libraries()).find((l) => l.name === 'Movies');
  const tv = (await libraries()).find((l) => l.name === 'TV');
  const film = (await itemsOf(movies)).find((i) => /Film A/.test(i.title));
  const show = (await admin('GET', `/api/libraries/${tv.id}/items`)).data;
  const showId = (show.items || show.shows || [])[0]?.id;
  const ep = (await admin('GET', `/api/shows/${showId}`)).data.seasons[0].episodes[0];
  await admin('POST', `/api/items/${film.id}/progress`, { position: 1.5, mode: 'direct', client: 'tab-1' });
  await admin('POST', `/api/items/${ep.id}/progress`, { position: 1, mode: 'direct', client: 'tab-2' });
  await admin('POST', `/api/items/${film.id}/progress`, { stopped: true, client: 'tab-1' });
  await admin('POST', `/api/items/${ep.id}/progress`, { stopped: true, client: 'tab-2' });
  const added = (await admin('GET', `/api/items/${film.id}`)).data.addedAt;

  // The upgrade: a new file with a new name, the old one gone.
  fs.renameSync(path.join(MOVIES, 'Film A (2001)', 'Film A (2001) Bluray-720p.mp4'), path.join(MOVIES, 'Film A (2001)', 'Film A (2001) Bluray-1080p.mp4'));
  fs.renameSync(path.join(TV, 'Some Show', 'Season 1', 'Some Show - S01E01 - Pilot HDTV-720p.mp4'), path.join(TV, 'Some Show', 'Season 1', 'Some Show - S01E01 - Pilot WEBDL-1080p.mp4'));
  await scan(movies);
  await scan(tv);

  const now = (await itemsOf(movies)).find((i) => /Film A/.test(i.title));
  assert.notEqual(now.id, film.id, 'a new file');
  const item = (await admin('GET', `/api/items/${now.id}`)).data;
  assert.equal(item.progress?.position, 1.5, 'the film kept its watch position');
  assert.equal(item.addedAt, added, 'and when it was added');
  const ep2 = (await admin('GET', `/api/shows/${showId}`)).data.seasons[0].episodes[0];
  assert.notEqual(ep2.id, ep.id);
  assert.equal((await admin('GET', `/api/items/${ep2.id}`)).data.progress?.position, 1, 'the episode kept its watch position');
});

test('only the same film or episode carries history over', () => {
  assert.equal(identity({ type: 'movie', title: 'Film A', year: 2001 }), identity({ type: 'movie', title: 'film a', year: 2001 }));
  assert.notEqual(identity({ type: 'movie', title: 'Film A', year: 2001 }), identity({ type: 'movie', title: 'Film A', year: 2002 }));
  assert.notEqual(identity({ type: 'episode', showTitle: 'Show', season: 1, episode: 1 }), identity({ type: 'episode', showTitle: 'Show', season: 1, episode: 2 }));
  assert.equal(identity({ type: 'extra', title: 'Trailer' }), null, 'extras are left alone');
});
