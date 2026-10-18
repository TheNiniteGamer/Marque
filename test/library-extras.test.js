'use strict';
// Extras (trailers, featurettes…) and live folder watching.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const parse = require('../lib/parse');
const { clip, startServer, until } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-extras-'));
let srv, admin;

test('extras are recognised by folder or by name suffix', () => {
  const x = (p) => parse.extraInfo(p.split('/').join(path.sep));
  assert.equal(x('Film (2020)/Film (2020).mkv'), null);
  assert.deepEqual(x('Film (2020)/Extras/Making of.mkv'), { kind: 'extra', ownerDir: 'Film (2020)', ownerBase: null, title: 'Making of' });
  assert.equal(x('Film (2020)/Behind The Scenes/Stunts.mp4').kind, 'behindthescenes');
  assert.deepEqual(x('Film (2020)/Film (2020)-trailer.mp4'), { kind: 'trailer', ownerDir: 'Film (2020)', ownerBase: 'Film (2020)', title: 'Trailer' });
  assert.equal(x('Show/Season 01/Trailers/Teaser.mp4').ownerDir, path.join('Show', 'Season 01'));
  assert.equal(x('Shorts (2019)/Shorts (2019).mp4'), null, 'a movie called "Shorts" is not an extra');
});

test.before(async () => {
  clip(path.join(ROOT, 'Movies', 'Film (2020)', 'Film (2020).mp4'));
  clip(path.join(ROOT, 'Movies', 'Film (2020)', 'Film (2020)-trailer.mp4'));
  clip(path.join(ROOT, 'Movies', 'Film (2020)', 'Extras', 'Making of.mp4'));
  fs.writeFileSync(path.join(ROOT, 'Movies', 'Film (2020)', 'poster.jpg'), 'x');
  clip(path.join(ROOT, 'TV', 'Show', 'Season 01', 'Show - S01E01.mp4'));
  clip(path.join(ROOT, 'TV', 'Show', 'Featurettes', 'Cast interview.mp4'));
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1', WATCH_INTERVAL: '1',
    AUTO_LIBRARIES: `Movies:movie:${path.join(ROOT, 'Movies')};TV:show:${path.join(ROOT, 'TV')}` });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  await until(async () => (await admin('GET', '/api/libraries')).data.every((l) => l.scannedAt));
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const libs = async () => Object.fromEntries((await admin('GET', '/api/libraries')).data.map((l) => [l.name, l]));

test('extras stay out of the library and appear on their movie or show', async () => {
  const { Movies, TV } = await libs();
  assert.equal(Movies.count, 1, 'only the film itself is listed');
  const [film] = (await admin('GET', `/api/libraries/${Movies.id}/items`)).data.items;
  const detail = (await admin('GET', `/api/items/${film.id}`)).data;
  assert.deepEqual(detail.extras.map((e) => [e.title, e.extraLabel]).sort(), [['Making of', 'Extra'], ['Trailer', 'Trailer']]);
  assert.equal((await admin('GET', '/api/search?q=Making')).data.movies.length, 0);

  const trailer = (await admin('GET', `/api/items/${detail.extras.find((e) => e.title === 'Trailer').id}`)).data;
  assert.deepEqual(trailer.parent, { id: film.id, type: 'movie', title: 'Film' });

  const [show] = (await admin('GET', `/api/libraries/${TV.id}/items`)).data.items;
  const sd = (await admin('GET', `/api/shows/${show.id}`)).data;
  assert.equal(sd.episodeCount, 1);
  assert.deepEqual(sd.extras.map((e) => e.title), ['Cast interview']);
});

test('a trailer next to the movie does not hide the folder poster', async () => {
  const { Movies } = await libs();
  const [film] = (await admin('GET', `/api/libraries/${Movies.id}/items`)).data.items;
  const res = await admin('GET', `/api/art/poster/${film.id}`);
  assert.equal(res.data.toString(), 'x', 'poster.jpg from the folder is used');
});

test('new files are noticed without a manual scan', async () => {
  // Like moving a finished download into the library: a file whose copy completed a while ago.
  const tmp = path.join(ROOT, 'incoming.mp4');
  clip(tmp);
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(tmp, old, old);
  fs.mkdirSync(path.join(ROOT, 'Movies', 'Second (2021)'));
  fs.renameSync(tmp, path.join(ROOT, 'Movies', 'Second (2021)', 'Second (2021).mp4'));
  await until(async () => (await libs()).Movies.count === 2, 15000);

  fs.rmSync(path.join(ROOT, 'Movies', 'Second (2021)'), { recursive: true });
  await until(async () => (await libs()).Movies.count === 1, 15000);
});

test('problem finder: offline folders, unreadable, unmatched, duplicates, missing episodes', () => {
  const { findProblems } = require('../lib/problems');
  const ep = (id, season, episode, extra = {}) => ({ id, type: 'episode', libraryId: 'tv', showId: 's1', showTitle: 'Show', season, episode, file: `/tv/${id}.mkv`, media: {}, ...extra });
  const store = { data: {
    libraries: [{ id: 'mv', name: 'Movies', paths: [ROOT, path.join(ROOT, 'nope')] }, { id: 'tv', name: 'TV', paths: [ROOT] }],
    shows: { s1: { id: 's1', libraryId: 'tv', title: 'Show', meta: null }, s2: { id: 's2', libraryId: 'tv', title: 'Lost Show', meta: { notFound: true } } },
    items: {
      a: { id: 'a', type: 'movie', libraryId: 'mv', title: 'The Film', year: 2001, file: '/m/a.mkv', media: {}, meta: null },
      b: { id: 'b', type: 'movie', libraryId: 'mv', title: 'Film', year: 2001, file: '/m/b.mp4', media: {}, meta: null },
      c: { id: 'c', type: 'movie', libraryId: 'mv', title: 'Broken', file: '/m/c.avi', media: null, meta: { notFound: true } },
      e1: ep('e1', 1, 1), e2: ep('e2', 1, 2, { episodeEnd: 3 }), e5: ep('e5', 1, 5), e5b: ep('e5b', 1, 5), sp: ep('sp', 0, 7),
    },
  } };
  const p = findProblems(store, { providersFor: () => [{}] });
  assert.deepEqual(p.offline, [{ library: 'Movies', path: path.join(ROOT, 'nope') }]);
  assert.deepEqual(p.unreadable.map((x) => x.id), ['c']);
  assert.deepEqual(p.unmatched.map((x) => x.id).sort(), ['c', 's2']);
  assert.deepEqual(p.duplicates.map((g) => g.copies.map((x) => x.id).sort()), [['a', 'b'], ['e5', 'e5b']]);
  assert.deepEqual(p.missingEpisodes, [{ showId: 's1', show: 'Show', season: 1, missing: [4] }], 'S01E02-E03 covers 3; specials are ignored');
  assert.deepEqual(findProblems(store, { providersFor: () => [] }).unmatched, [], 'nothing is "unmatched" without a metadata source');
});

test('seek preview thumbnails are made on first request', async () => {
  const { Movies } = await libs();
  const [film] = (await admin('GET', `/api/libraries/${Movies.id}/items`)).data.items;
  assert.deepEqual((await admin('GET', `/api/items/${film.id}/trickplay`)).data, { ready: false }, 'clips under 10 s get none');

  const long = path.join(ROOT, 'long.mp4');
  clip(long, 25);
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(long, old, old);
  fs.mkdirSync(path.join(ROOT, 'Movies', 'Long (2022)'));
  fs.renameSync(long, path.join(ROOT, 'Movies', 'Long (2022)', 'Long (2022).mp4'));
  const item = await until(async () => (await admin('GET', `/api/libraries/${Movies.id}/items`)).data.items.find((i) => i.title === 'Long'), 15000);
  assert.deepEqual((await admin('GET', `/api/items/${item.id}/trickplay`)).data, { ready: false });
  const info = await until(async () => { const d = (await admin('GET', `/api/items/${item.id}/trickplay`)).data; return d.ready && d; });
  // 160x120 source → 240x180 thumbnails, one every 10 s.
  assert.deepEqual(info, { ready: true, interval: 10, cols: 10, rows: 10, width: 240, height: 180, count: 3, sheets: 1 });
  const sheet = await admin('GET', `/api/items/${item.id}/trickplay/1`);
  assert.equal(sheet.status, 200);
  assert.equal(sheet.data.subarray(0, 2).toString('hex'), 'ffd8', 'a JPEG');
  assert.equal((await admin('GET', `/api/items/${item.id}/trickplay/2`)).status, 404);
  assert.equal((await admin('GET', `/api/items/${item.id}/trickplay/..%2Finfo.json`)).status, 404);
});
