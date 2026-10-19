'use strict';
// The home page's banner and rows, and "More like this", from a small made-up library.

const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../lib/library');

const DAY = 86400_000;
function makeStore() {
  const store = { data: { libraries: [{ id: 'M', name: 'Movies', type: 'movie' }, { id: 'T', name: 'TV', type: 'show' }], items: {}, shows: {}, progress: {}, watchlist: {} }, save() {}, library(id) { return this.data.libraries.find((l) => l.id === id); } };
  const movie = (id, title, genres, extra = {}) => { store.data.items[id] = { id, type: 'movie', libraryId: 'M', file: `/m/${id}.mkv`, title, addedAt: Date.now() - DAY, media: { duration: 5400 }, meta: { provider: 'tmdb', genres, overview: `${title} story`, backdrop: `/img/${id}.jpg` }, ...extra }; };
  movie('m1', 'Space One', ['Science Fiction']);
  movie('m2', 'Space Two', ['Science Fiction', 'Adventure']);
  movie('m3', 'Funny Film', ['Comedy']);
  movie('m4', 'No Art', ['Comedy'], { meta: { genres: ['Comedy'], overview: 'x' } });
  store.data.shows.s1 = { id: 's1', libraryId: 'T', title: 'Kids Show', addedAt: Date.now() - DAY, lastAddedAt: Date.now() - DAY, meta: { genres: ['Comedy', 'Kids'], overview: 'A show', backdrop: '/img/s1.jpg' } };
  for (let e = 1; e <= 3; e++) store.data.items[`e${e}`] = { id: `e${e}`, type: 'episode', libraryId: 'T', showId: 's1', season: 1, episode: e, file: `/t/${e}.mkv`, title: `Ep ${e}`, addedAt: 1, media: { duration: 600 } };
  return store;
}
const user = { id: 'u', role: 'admin' };

test('"More like this" shares genres, most shared first, never the title itself', () => {
  const store = makeStore();
  const like = lib.similar(store, user, store.data.items.m2).map((x) => x.title);
  assert.deepEqual(like, ['Space One']);
  assert.deepEqual(lib.similar(store, user, store.data.items.m3).map((x) => x.title).sort(), ['Kids Show', 'No Art']);
  assert.deepEqual(lib.similar(store, user, { id: 'z', meta: { genres: [] } }), []);
});

test('the banner is a title with artwork and a summary, with what to play', () => {
  const store = makeStore();
  const { hero } = lib.home(store, user);
  assert.ok(hero, 'there is a banner');
  assert.notEqual(hero.title, 'No Art', 'titles without artwork are not featured');
  assert.ok(hero.overview && hero.play?.id);
  // A show starts at its first episode; after watching some, it carries on.
  store.data.items.m1.meta.backdrop = null; store.data.items.m2.meta.backdrop = null; store.data.items.m3.meta.backdrop = null;
  assert.deepEqual([lib.home(store, user).hero.title, lib.home(store, user).hero.play], ['Kids Show', { id: 'e1', label: 'Play S1:E1', t: null }]);
  store.data.progress.u = { e1: { watched: true, position: 0, updatedAt: 1 }, e2: { position: 200, updatedAt: 2 } };
  assert.equal(lib.home(store, user).hero.play.label, 'Resume S1:E2');
});

test('home rows: New in each library, Because you watched, and big genres', () => {
  const store = makeStore();
  store.data.progress.u = { m3: { position: 100, updatedAt: 5 } };
  for (let i = 0; i < 6; i++) store.data.items[`c${i}`] = { id: `c${i}`, type: 'movie', libraryId: 'M', file: `/m/c${i}.mkv`, title: `Comedy ${i}`, addedAt: i, meta: { genres: ['Comedy'] } };
  const titles = lib.home(store, user).hubs.map((h) => h.title);
  assert.ok(titles.includes('New in Movies') && titles.includes('New in TV'));
  assert.ok(titles.includes('Because you watched Funny Film'));
  assert.ok(titles.includes('Comedy'), 'a genre with at least 6 titles gets a row');
  assert.ok(!titles.includes('Science Fiction'), 'small genres do not');
});
