'use strict';
// One show in two folders (the old copy, and the folder Sonarr makes for a new season) is one show
// once both are matched to the same title and year, even by different sources. Near misses (another
// year, a match Marquee isn't sure of) stay apart.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip } = require('./helpers');
const { Store } = require('../lib/store');
const { Scanner } = require('../lib/scanner');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-show-merge-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// Matches each new show by its folder's name, as the real matcher would from TVmaze, TMDB or TheTVDB.
function setup(name, matches) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const store = new Store(path.join(ROOT, `${name}.json`));
  const lib = { id: `lib-${name}`, name, type: 'show', paths: [dir] };
  store.data.libraries.push(lib);
  const matcher = {
    async matchLibrary(library) {
      for (const s of Object.values(store.data.shows)) {
        if (s.libraryId === library.id && !s.meta) s.meta = { ...matches[path.basename(s.dir)] };
      }
    },
  };
  const scanner = new Scanner(store, path.join(ROOT, `${name}-data`), matcher);
  const scan = () => new Promise((resolve) => { scanner.once('done', resolve); scanner.enqueue(lib.id); });
  const shows = () => Object.values(store.data.shows);
  return { dir, store, scan, shows };
}
const ep = (dir, folder, s, e) => clip(path.join(dir, folder, `Season ${s}`, `${folder} - S0${s}E0${e}.mp4`));

test('a new season in its own folder joins the show, keeping its history and place on My List', async () => {
  const { dir, store, scan, shows } = setup('split', {
    mushokutensei: { provider: 'tmdb', providerId: '94664', title: 'Mushoku Tensei: Jobless Reincarnation', year: 2021 },
    'Mushoku Tensei - Jobless Reincarnation': { provider: 'tvdb', providerId: '371310', title: 'Mushoku Tensei: Jobless Reincarnation', year: 2021 },
  });
  for (const e of [1, 2]) ep(dir, 'mushokutensei', 1, e);
  await scan();
  const old = shows()[0];
  const first = Object.values(store.data.items)[0];
  store.data.progress = { u1: { [first.id]: { position: 90, updatedAt: Date.now() } } };
  store.data.watchlist = { u1: { [old.id]: Date.now() } };

  ep(dir, 'Mushoku Tensei - Jobless Reincarnation', 3, 1);
  await scan();
  assert.equal(shows().length, 1, 'one show');
  const show = shows()[0];
  assert.equal(show.id, old.id, 'the first show kept its id');
  assert.equal(show.episodeCount, 3);
  assert.equal(show.dir, path.join(dir, 'mushokutensei'));
  assert.ok(store.data.watchlist.u1[old.id], 'still on My List');
  assert.equal(store.data.progress.u1[first.id].position, 90);
  assert.ok(Object.values(store.data.items).every((it) => it.showId === old.id));

  // Later episodes in the new folder go straight into it.
  ep(dir, 'Mushoku Tensei - Jobless Reincarnation', 3, 2);
  await scan();
  assert.equal(shows().length, 1);
  assert.equal(shows()[0].episodeCount, 4);
});

test('another year, or a match Marquee isn’t sure of, stays a separate show', async () => {
  const { dir, scan, shows } = setup('apart', {
    'Doctor Who (1963)': { provider: 'tvmaze', providerId: '1', title: 'Doctor Who', year: 1963 },
    'Doctor Who (2005)': { provider: 'tvmaze', providerId: '2', title: 'Doctor Who', year: 2005 },
    Bluey: { provider: 'tvmaze', providerId: '3', title: 'Bluey', year: 2018 },
    'Bluey Shorts': { provider: 'tvmaze', providerId: '3', title: 'Bluey', year: 2018, uncertain: true },
  });
  for (const f of ['Doctor Who (1963)', 'Doctor Who (2005)', 'Bluey', 'Bluey Shorts']) ep(dir, f, 1, 1);
  await scan();
  await scan();
  assert.equal(shows().length, 4);
});

test('when the merged folder goes, the merge is forgotten and the show carries on', async () => {
  const { dir, store, scan, shows } = setup('gone', {
    beasttamer: { provider: 'tvmaze', providerId: '5', title: 'Beast Tamer', year: 2022 },
    'Beast Tamer': { provider: 'tvdb', providerId: '6', title: 'Beast Tamer', year: 2022 },
  });
  for (const e of [1, 2]) ep(dir, 'beasttamer', 1, e);
  await scan();
  ep(dir, 'Beast Tamer', 2, 1);
  await scan();
  assert.equal(shows().length, 1);
  assert.equal(Object.keys(store.data.showMerges).length, 1);
  fs.rmSync(path.join(dir, 'Beast Tamer'), { recursive: true });
  await scan();
  assert.equal(shows().length, 1);
  assert.equal(shows()[0].episodeCount, 2);
  assert.deepEqual(store.data.showMerges, {});
});
