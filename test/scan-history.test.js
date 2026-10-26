'use strict';
// Watch history follows a title when its file is renamed or replaced: an upgrade whose new file
// arrives a scan later (Radarr deletes the old one first), a rename of many films at once, a rename
// that keeps the same video (its overnight copy and markers come too), and a show's folder renamed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip } = require('./helpers');
const { Store } = require('../lib/store');
const { Scanner } = require('../lib/scanner');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-scan-history-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function setup(name, type) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const store = new Store(path.join(ROOT, `${name}.json`));
  const lib = { id: `lib-${name}`, name, type, paths: [dir] };
  store.data.libraries.push(lib);
  const scanner = new Scanner(store, path.join(ROOT, `${name}-data`));
  const scan = (opts) => new Promise((resolve) => { scanner.once('done', resolve); scanner.enqueue(lib.id, opts); });
  const find = (pred) => Object.values(store.data.items).find(pred);
  return { dir, store, scan, find };
}
const watch = (store, item, position) => { ((store.data.progress ||= {}).u1 ||= {})[item.id] = { position, updatedAt: Date.now() }; };

test('an upgrade whose new file turns up a scan later keeps its history', async () => {
  const { dir, store, scan, find } = setup('upgrade', 'movie');
  clip(path.join(dir, 'Keeper (2000).mp4')); // (a library left empty looks like an unplugged drive)
  clip(path.join(dir, 'Heat (1995)', 'Heat (1995) DVD.mp4'));
  await scan();
  const old = find((x) => x.title === 'Heat');
  watch(store, old, 42);
  (store.data.watchlist ||= {}).u1 = { [old.id]: Date.now() };
  // Radarr deletes the old file, a scan runs, then the better copy arrives.
  fs.rmSync(path.join(dir, 'Heat (1995)', 'Heat (1995) DVD.mp4'));
  await scan();
  assert.equal(find((x) => x.title === 'Heat'), undefined, 'gone for now');
  clip(path.join(dir, 'Heat (1995)', 'Heat (1995) Bluray-1080p.mp4'), 2);
  await scan();
  const now = find((x) => x.title === 'Heat');
  assert.notEqual(now.id, old.id);
  assert.equal(store.data.progress.u1[now.id]?.position, 42, 'progress moved');
  assert.ok(store.data.watchlist.u1[now.id], 'still on My List');
  assert.equal(store.data.progress.u1[old.id], undefined);
  assert.equal(store.data.removedTitles.length, 0, 'used up');
});

test('a file still being copied is matched once it has settled', async () => {
  const { dir, store, scan, find } = setup('settle', 'movie');
  const file = path.join(dir, 'Alien (1979).mp4');
  clip(file);
  clip(path.join(dir, 'Keeper (2000).mp4'));
  const t = Date.now() / 1000 - 3600;
  for (const f of [file, path.join(dir, 'Keeper (2000).mp4')]) fs.utimesSync(f, t, t);
  await scan({ settle: true });
  const old = find((x) => x.title === 'Alien');
  watch(store, old, 7);
  fs.rmSync(file);
  clip(path.join(dir, 'Alien (1979) Remastered.mp4')); // brand new: "still copying" to a settling scan
  await scan({ settle: true });
  assert.equal(find((x) => x.title === 'Alien'), undefined);
  const late = Date.now() / 1000 - 3600;
  fs.utimesSync(path.join(dir, 'Alien (1979) Remastered.mp4'), late, late);
  await scan({ settle: true });
  assert.equal(store.data.progress.u1[find((x) => x.title === 'Alien').id]?.position, 7);
});

test('renaming many films at once keeps every one’s history, with no waiting copies', async () => {
  const { dir, store, scan, find } = setup('mass', 'movie');
  const names = Array.from({ length: 24 }, (_, i) => `Film ${String.fromCharCode(65 + i)} (20${10 + i})`);
  for (const n of names) clip(path.join(dir, `${n}.mp4`));
  await scan();
  for (const it of Object.values(store.data.items)) watch(store, it, 30);
  for (const n of names) fs.renameSync(path.join(dir, `${n}.mp4`), path.join(dir, `${n} - Renamed.mp4`));
  await scan();
  const items = Object.values(store.data.items);
  assert.equal(items.length, 24, 'no doubles held back');
  assert.ok(items.every((it) => it.file.includes('Renamed') && store.data.progress.u1[it.id]?.position === 30));
  assert.ok(!items.some((it) => it.missingSince));
});

test('a renamed episode keeps its overnight copy, subtitles and markers', async () => {
  const { dir, store, scan, find } = setup('rename', 'show');
  const from = path.join(dir, 'Bluey', 'Season 01', 'Bluey - S01E01.mp4');
  clip(from);
  await scan();
  const ep = find((x) => x.type === 'episode');
  Object.assign(ep, {
    optimized: { file: '/copies/x.mp4', size: 5, createdAt: 1, sourceMtime: ep.mtime },
    downloadedSubs: [{ file: `${ep.id}-1.srt`, lang: 'en' }], intro: { start: 0, end: 30 }, credits: { start: 500 },
  });
  watch(store, ep, 12);
  fs.renameSync(from, path.join(dir, 'Bluey', 'Season 01', 'Bluey - S01E01 - Magic Xylophone.mp4'));
  await scan();
  const now = find((x) => x.type === 'episode');
  assert.notEqual(now.id, ep.id);
  assert.equal(store.data.progress.u1[now.id]?.position, 12);
  assert.equal(now.optimized?.file, '/copies/x.mp4');
  assert.deepEqual(now.downloadedSubs, ep.downloadedSubs);
  assert.deepEqual([now.intro, now.credits], [{ start: 0, end: 30 }, { start: 500 }]);
});

test('an upgraded file doesn’t take the old one’s copy or markers (they were made from the old video)', async () => {
  const { dir, store, scan, find } = setup('replace', 'show');
  const from = path.join(dir, 'Bluey', 'Season 01', 'Bluey - S01E02 SDTV.mp4');
  clip(from);
  await scan();
  const ep = find((x) => x.type === 'episode');
  Object.assign(ep, { intro: { start: 0, end: 30 }, optimized: { file: '/copies/y.mp4', sourceMtime: ep.mtime } });
  watch(store, ep, 5);
  fs.rmSync(from);
  clip(path.join(dir, 'Bluey', 'Season 01', 'Bluey - S01E02 WEBDL-1080p.mp4'), 2);
  await scan();
  const now = find((x) => x.type === 'episode');
  assert.equal(store.data.progress.u1[now.id]?.position, 5, 'history moved');
  assert.equal(now.intro, undefined);
  assert.equal(now.optimized, undefined);
});

test('a show whose folder is renamed keeps its details, fixes and place on My List', async () => {
  const { dir, store, scan, find } = setup('showdir', 'show');
  for (const e of [1, 2]) clip(path.join(dir, 'Bluey', 'Season 01', `Bluey - S01E0${e}.mp4`));
  await scan();
  const oldShow = Object.values(store.data.shows)[0];
  Object.assign(oldShow, { meta: { title: 'Bluey', provider: 'tvmaze', providerId: '1' }, edits: { numbering: 'season' } });
  (store.data.watchlist ||= {}).u1 = { [oldShow.id]: Date.now() };
  (store.data.trackPrefs ||= {}).u1 = { [oldShow.id]: { audio: 'en' } };
  fs.renameSync(path.join(dir, 'Bluey'), path.join(dir, 'Bluey (2018)'));
  await scan();
  const shows = Object.values(store.data.shows);
  assert.equal(shows.length, 1);
  const show = shows[0];
  assert.notEqual(show.id, oldShow.id);
  assert.deepEqual(show.edits, { numbering: 'season' });
  assert.equal(show.meta?.providerId, '1');
  assert.ok(store.data.watchlist.u1[show.id]);
  assert.deepEqual(store.data.trackPrefs.u1[show.id], { audio: 'en' });
  assert.ok(find((x) => x.type === 'episode').showId === show.id);
});
