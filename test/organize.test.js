'use strict';
// Organising: choosing several titles at once, collection order rules (episode numbers in titles),
// Movies / TV / YouTube sections, "Find series", shows in nested folders, and folders on other drives.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');
const { titleNumber, seriesName } = require('../lib/collections');
const { parseEpisode } = require('../lib/parse');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-org-'));
const DRIVE = path.join(ROOT, 'drive-e');   // stands in for a whole drive shared with Docker as E:
let srv, admin, viewer, ids;

test.before(async () => {
  for (const name of ['Alpha (2001)', 'Beta (2005)']) clip(path.join(ROOT, 'Movies', `${name}.mp4`));
  for (const name of ['Hardcore Survival Ep 10', 'Hardcore Survival Ep 2', 'Hardcore Survival Ep. 1', 'Random vlog']) clip(path.join(ROOT, 'YouTube', 'Channel', `${name}.mp4`));
  for (const rel of ['Kids/Bluey/Season 1/Bluey S01E01.mp4', 'Kids/Bluey/Season 1/Bluey S01E02.mp4', 'Kids/Bluey/Extras/Making Bluey.mp4',
    'Kids/Peppa Pig/Peppa Pig S01E01.mp4', 'Grown-ups/The Office/Season 1/The Office S01E01.mp4', 'Flat Show/Flat Show S01E01.mp4']) clip(path.join(ROOT, 'TV', rel));
  clip(path.join(DRIVE, 'Films', 'Old Films', 'Gamma (1999).mp4'));
  clip(path.join(DRIVE, 'Films', 'Delta (2010).mp4'));
  fs.mkdirSync(path.join(ROOT, 'OldMount'));
  srv = await startServer({
    DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1',
    AUTO_LIBRARIES: `Movies:movie:${path.join(ROOT, 'Movies')};YouTube:movie:${path.join(ROOT, 'YouTube')};TV Shows:show:${path.join(ROOT, 'TV')}`,
    // OldMount is the same PC folder as E:/Films/Old Films, shared with Docker a second time.
    MEDIA_LABELS: `${DRIVE}=E:/|${path.join(ROOT, 'Movies')}=D:/Movies|${path.join(ROOT, 'OldMount')}=E:/Films/Old Films`,
  });
  admin = srv.client();
  viewer = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  await until(async () => { const l = (await admin('GET', '/api/libraries')).data; return l.length === 3 && l.every((x) => x.scannedAt); });
  const libs = Object.fromEntries((await admin('GET', '/api/libraries')).data.map((l) => [l.name, l.id]));
  const titles = async (lib) => Object.fromEntries((await admin('GET', `/api/libraries/${lib}/items`)).data.items.map((i) => [i.title, i.id]));
  ids = { libs, movies: await titles(libs.Movies), videos: await titles(libs.YouTube), shows: await titles(libs['TV Shows']) };
  await admin('POST', '/api/users', { username: 'kid', password: 'kidpass1' });
  await viewer('POST', '/api/auth/login', { username: 'kid', password: 'kidpass1' });
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('episode numbers are found in titles', () => {
  const n = (t) => { const r = titleNumber(t); return r && [r.season, r.episode]; };
  assert.deepEqual(n('Hardcore Survival Ep 12'), [0, 12]);
  assert.deepEqual(n('Hardcore Survival Ep. 3 - The End'), [0, 3]);
  assert.deepEqual(n('Let’s Play | Episode 7'), [0, 7]);
  assert.deepEqual(n('Show S02E05 Title'), [2, 5]);
  assert.deepEqual(n('Season 2 Episode 5'), [2, 5]);
  assert.deepEqual(n('Video #12'), [0, 12]);
  assert.deepEqual(n('Making a Base (Part 3)'), [0, 3]);
  assert.deepEqual(n('Toy Story 3'), [0, 3], 'a number at the end');
  assert.equal(n('Blade Runner 2049'), null, 'years are not episode numbers');
  assert.equal(n('Ep 1080p test'), null, 'nor are video sizes');
  assert.equal(n('Nothing here'), null);
  assert.equal(seriesName('Hardcore Survival Ep 12'), 'Hardcore Survival');
  assert.equal(seriesName('Let’s Play | Episode 7'), 'Let’s Play');
  assert.equal(seriesName('Toy Story 3'), null, 'only titles with an episode marker make a series');
});

test('shows inside folders of their own are still found as shows', async () => {
  const p = (rel) => { const e = parseEpisode(rel); return [e.show, e.showDirIndex]; };
  assert.deepEqual(p('Kids/Bluey/Season 1/Bluey S01E01.mkv'), ['Bluey', 1]);
  assert.deepEqual(p('Kids/Bluey/Episode 05.mkv'), ['Bluey', 1]);
  assert.deepEqual(p('Anime/Naruto/Arc 1/Naruto - 01.mkv'), ['Naruto', 1], 'the folder named like the show wins');
  assert.deepEqual(p('Breaking Bad/Breaking.Bad.S01E01.720p/Breaking.Bad.S01E01.720p.mkv'), ['Breaking Bad', 0], 'release folders are skipped');
  assert.deepEqual(p('Breaking Bad/Season 01/Breaking Bad - S01E02.mkv'), ['Breaking Bad', 0]);
  assert.deepEqual(p('The.Office.US.S03E10.720p.mkv'), ['The Office US', -1]);

  assert.deepEqual(Object.keys(ids.shows).sort(), ['Bluey', 'Flat Show', 'Peppa Pig', 'The Office']);
  const bluey = (await admin('GET', `/api/shows/${ids.shows.Bluey}`)).data;
  assert.equal(bluey.episodeCount, 2);
  assert.deepEqual(bluey.extras.map((x) => x.title), ['Making Bluey'], 'extras inside the show folder belong to it');
});

test('collections are shown under Movies, TV or YouTube', async () => {
  const mk = async (name, members) => (await admin('POST', '/api/collections', { name, members })).data;
  const films = await mk('Films', [ids.movies.Alpha, ids.movies.Beta]);
  const kids = await mk('Kids TV', [ids.shows.Bluey, ids.shows['Peppa Pig']]);
  const vids = await mk('Vlogs', [ids.videos['Random vlog']]);
  assert.deepEqual([films.section, kids.section, vids.section], ['movies', 'shows', 'videos']);
  // An admin can move one; null goes back to deciding from the titles.
  const moved = (await admin('PATCH', `/api/collections/${films.id}`, { section: 'videos' })).data;
  assert.deepEqual([moved.section, moved.sectionSetByHand], ['videos', true]);
  assert.equal((await admin('PATCH', `/api/collections/${films.id}`, { section: 'nope' })).status, 400);
  assert.equal((await admin('PATCH', `/api/collections/${films.id}`, { section: null })).data.section, 'movies');
  assert.equal((await admin('GET', '/api/collections')).data.find((c) => c.id === kids.id).section, 'shows');
  for (const c of [films, kids, vids]) await admin('DELETE', `/api/collections/${c.id}`);
});

test('"Find series" offers videos sharing a name before an episode number, ordered by it', async () => {
  const found = (await admin('GET', '/api/collection-suggestions')).data;
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].name, found[0].count, found[0].section], ['Hardcore Survival', 3, 'videos']);
  assert.equal((await viewer('GET', '/api/collection-suggestions')).status, 403);

  const made = (await admin('POST', '/api/collections', { name: found[0].name, members: found[0].memberIds, sort: 'episode', section: found[0].section })).data;
  const order = (c) => c.items.map((i) => i.title);
  assert.deepEqual(order(made), ['Hardcore Survival Ep 1', 'Hardcore Survival Ep 2', 'Hardcore Survival Ep 10'], 'by number, not alphabetically');
  assert.equal(made.sort, 'episode');
  assert.deepEqual(order((await admin('PATCH', `/api/collections/${made.id}`, { reverse: true })).data), ['Hardcore Survival Ep 10', 'Hardcore Survival Ep 2', 'Hardcore Survival Ep 1']);
  assert.deepEqual((await admin('GET', '/api/collection-suggestions')).data, [], 'not offered again once it is a collection');

  // Arranging by hand starts from the order shown, and can be undone.
  const custom = (await admin('PATCH', `/api/collections/${made.id}`, { sort: 'custom' })).data;
  assert.deepEqual([custom.sort, order(custom)], ['custom', ['Hardcore Survival Ep 10', 'Hardcore Survival Ep 2', 'Hardcore Survival Ep 1']]);
  const back = (await admin('PUT', `/api/collections/${made.id}/order`, { order: null })).data;
  assert.equal(back.sort, 'release');
  assert.equal((await admin('PATCH', `/api/collections/${made.id}`, { sort: 'shuffle' })).status, 400);
  await admin('DELETE', `/api/collections/${made.id}`);
});

test('many titles can be added to or removed from a collection at once', async () => {
  const c = (await admin('POST', '/api/collections', { name: 'Bulk' })).data;
  const all = [ids.movies.Alpha, ids.movies.Beta, ids.shows.Bluey];
  assert.equal((await admin('POST', `/api/collections/${c.id}/members`, { ids: all })).data.count, 3);
  // One bad id: nothing changes.
  assert.equal((await admin('POST', `/api/collections/${c.id}/members`, { ids: [ids.videos['Random vlog'], 'nope'] })).status, 400);
  assert.equal((await admin('GET', `/api/collections/${c.id}`)).data.count, 3);
  assert.equal((await admin('POST', `/api/collections/${c.id}/members/remove`, { ids: [ids.movies.Alpha, ids.shows.Bluey] })).data.count, 1);
  assert.equal((await viewer('POST', `/api/collections/${c.id}/members`, { ids: all })).status, 403);
  // A new collection can be made straight from a selection.
  const made = await admin('POST', '/api/collections', { name: 'From selection', members: all, sort: 'title' });
  assert.deepEqual(made.data.items.map((i) => i.title), ['Alpha', 'Beta', 'Bluey']);
  await admin('DELETE', `/api/collections/${c.id}`);
  await admin('DELETE', `/api/collections/${made.data.id}`);
});

test('bulk actions: watched, My List and genres', async () => {
  const bulk = (who, action, extra = {}) => who('POST', '/api/bulk', { ids: [ids.movies.Alpha, ids.shows.Bluey], action, ...extra });
  assert.equal((await bulk(viewer, 'watched')).status, 200);
  const bluey = (await viewer('GET', `/api/shows/${ids.shows.Bluey}`)).data;
  assert.equal(bluey.unwatchedCount, 0, 'a show counts as all its episodes');
  assert.equal((await viewer('GET', `/api/items/${ids.movies.Alpha}`)).data.progress.watched, true);
  assert.equal((await admin('GET', `/api/items/${ids.movies.Alpha}`)).data.progress, null, 'only for the person who did it');
  await bulk(viewer, 'unwatched');
  assert.equal((await viewer('GET', `/api/shows/${ids.shows.Bluey}`)).data.unwatchedCount, 2);

  await bulk(viewer, 'watchlist-add');
  assert.deepEqual((await viewer('GET', '/api/watchlist')).data.map((x) => x.title).sort(), ['Alpha', 'Bluey']);
  await bulk(viewer, 'watchlist-remove');
  assert.deepEqual((await viewer('GET', '/api/watchlist')).data, []);

  assert.equal((await bulk(viewer, 'genre-add', { genre: 'Family' })).status, 403, 'genres are for admins');
  await bulk(admin, 'genre-add', { genre: 'Family' });
  await bulk(admin, 'genre-add', { genre: 'family' });
  assert.deepEqual((await admin('GET', `/api/items/${ids.movies.Alpha}`)).data.genres, ['Family'], 'added once');
  assert.deepEqual((await admin('GET', `/api/shows/${ids.shows.Bluey}`)).data.genres, ['Family']);
  await bulk(admin, 'genre-remove', { genre: 'FAMILY' });
  assert.deepEqual((await admin('GET', `/api/items/${ids.movies.Alpha}`)).data.genres, []);

  assert.equal((await admin('POST', '/api/bulk', { ids: [], action: 'watched' })).status, 400);
  assert.equal((await admin('POST', '/api/bulk', { ids: [ids.movies.Alpha], action: 'explode' })).status, 400);
  assert.equal((await admin('POST', '/api/bulk', { ids: ['nope'], action: 'watched' })).status, 404);
});

test('folders on other drives: shortcuts, typing the PC path, and what a folder holds', async () => {
  // (From a folder of the test's own: the home folder can be anything, or unreadable, on another machine.)
  const listed = await admin('GET', `/api/fs?path=${encodeURIComponent(ROOT)}`);
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  const fsList = listed.data;
  assert.ok(fsList.places.some((p) => p.path === DRIVE && p.label === 'E: drive'), 'shared drives are offered');
  // The PC's name for a folder works in the picker and when saving a library.
  const films = (await admin('GET', `/api/fs?path=${encodeURIComponent('e:/Films')}`)).data;
  assert.deepEqual([films.path, films.label, films.dirs], [path.join(DRIVE, 'Films'), 'E:/Films', ['Old Films']]);
  const preview = (await admin('GET', `/api/fs/preview?path=${encodeURIComponent(films.path)}`)).data;
  assert.deepEqual([preview.videos, preview.folders, preview.partial], [2, 1, false], 'folders inside count too');

  const made = await admin('POST', '/api/libraries', { name: 'Drive E', type: 'movie', paths: ['E:/Films'] });
  assert.equal(made.status, 201);
  assert.deepEqual(made.data.paths, [path.join(DRIVE, 'Films')]);
  await until(async () => (await admin('GET', '/api/libraries')).data.find((l) => l.id === made.data.id)?.scannedAt);
  const found = (await admin('GET', `/api/libraries/${made.data.id}/items`)).data.items.map((i) => i.title).sort();
  assert.deepEqual(found, ['Delta', 'Gamma'], 'movies in folders inside are found');

  const missing = await admin('POST', '/api/libraries', { name: 'Nope', type: 'movie', paths: ['Z:/Movies'] });
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /DRIVE_1/, 'explains how to share another drive with Docker');
  const twice = await admin('POST', '/api/libraries', { name: 'Twice', type: 'movie', paths: [path.join(ROOT, 'OldMount'), path.join(DRIVE, 'Films', 'Old Films')] });
  assert.equal(twice.status, 400, 'the same PC folder reached two ways');
  assert.match(twice.data.error, /E:\/Films\/Old Films is in the list twice/);
  assert.equal((await viewer('GET', '/api/fs/preview?path=/')).status, 403);
});
