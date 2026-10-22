'use strict';
// The library's lookup tables are kept between requests (big libraries were slow without), so they
// must follow every change: anything saved to the database, apart from personal things like watch
// positions, starts them afresh.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../lib/store');
const lib = require('../lib/library');
const collections = require('../lib/collections');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-caching-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const tick = () => new Promise((r) => setImmediate(r));

const movie = (id, title, extra = {}) => ({ id, libraryId: 'L', type: 'movie', title, file: `/m/${title}.mp4`, addedAt: 1,
  media: { duration: 3600, video: { codec: 'h264' } }, meta: { title, genres: ['Drama'], contentRating: { cert: 'PG', age: 7 }, ...extra } });

test('changes show up at once; watch positions keep the tables', async () => {
  const store = new Store(path.join(ROOT, 'db.json'));
  store.data.libraries = [{ id: 'L', name: 'Movies', type: 'movie', paths: [] }];
  store.data.items = { a1: movie('a1', 'Alpha'), b2: movie('b2', 'Bravo', { collection: { id: 9, name: 'Saga' } }), c3: movie('c3', 'Charlie', { collection: { id: 9, name: 'Saga' } }) };
  store.data.users = [{ id: 'k', username: 'kid', role: 'user', libraries: null, maxAge: 10, allowUnrated: true }];
  const kid = store.data.users[0];
  store.save();
  const names = () => lib.search(store, kid, 'drama').movies.map((m) => m.title).sort();
  assert.deepEqual(names(), ['Alpha', 'Bravo', 'Charlie']);
  await tick();

  // A rating change (an edit, or ratings being filled in) hides the film from the kids profile…
  store.data.items.b2.meta.contentRating = { cert: 'R', age: 17 };
  store.save({ lazy: true });
  assert.deepEqual(names(), ['Alpha', 'Charlie']);
  await tick();
  // …as does a new limit on the profile.
  kid.maxAge = 5;
  store.save();
  assert.deepEqual(names(), []);
  kid.maxAge = 10;
  store.save();
  await tick();

  // A new film and a new TMDB collection member appear straight away.
  store.data.items.d4 = movie('d4', 'Delta', { collection: { id: 9, name: 'Saga' } });
  store.save();
  assert.deepEqual(names(), ['Alpha', 'Charlie', 'Delta']);
  assert.equal(collections.list(store, kid).find((c) => c.name === 'Saga').count, 2, 'Bravo (R) hidden, Charlie and Delta');
  await tick();

  // Watch positions don't start the tables again, but Continue Watching still follows them.
  const rev = store.rev;
  lib.setProgress(store, kid, store.data.items.a1, 600);
  assert.equal(store.rev, rev, 'a watch position is personal');
  assert.deepEqual(lib.continueWatching(store, kid).map((x) => x.title), ['Alpha']);
  store.flush();
});

test('reaching the end credits counts as watched', () => {
  const store = new Store(path.join(ROOT, 'credits.json'));
  store.data.libraries = [{ id: 'L', name: 'Movies', type: 'movie', paths: [] }];
  store.data.items = { e1: movie('e1', 'Episode', {}), e2: movie('e2', 'Early credits') };
  store.data.items.e1.credits = { start: 3000 }; // 50 minutes into an hour: credits for the last 10
  store.data.items.e2.credits = { start: 600 }; // too early to be the end credits: not used
  store.data.users = [{ id: 'u', username: 'dad', role: 'admin' }];
  const u = store.data.users[0];
  assert.equal(lib.setProgress(store, u, store.data.items.e1, 2990).watched, false);
  assert.equal(lib.setProgress(store, u, store.data.items.e1, 3005).watched, true, 'into the credits');
  assert.equal(lib.setProgress(store, u, store.data.items.e2, 700).watched, false);
  assert.equal(lib.setProgress(store, u, store.data.items.e2, 3300).watched, true, 'still 90% as before');
  store.flush();
});
