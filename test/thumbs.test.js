'use strict';
// Thumbs up / down: a thumbs-down keeps a title out of suggestions; a thumbs-up seeds "Because you liked".

const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../lib/library');

const movie = (id, title, genres) => ({ id, type: 'movie', libraryId: 'L', title, file: `/m/${id}.mp4`, addedAt: 1, meta: { genres, overview: 'x', backdrop: '/b.jpg' } });
const store = {
  save() {},
  data: {
    libraries: [{ id: 'L', type: 'movie' }],
    items: Object.fromEntries([
      movie('a', 'Toy Story', ['Animation', 'Family']), movie('b', 'Cars', ['Animation', 'Family']),
      movie('c', 'Up', ['Animation', 'Family']), movie('d', 'Coco', ['Animation', 'Family']),
      movie('e', 'Brave', ['Animation', 'Family']), movie('f', 'Moana', ['Animation', 'Family']),
    ].map((m) => [m.id, m])),
    shows: {}, progress: {}, watchlist: {},
  },
};
const user = { id: 'u', role: 'admin' };

test('thumbs-down titles leave suggestions; thumbs-up seeds a row', () => {
  assert.equal(lib.setThumb(store, user, 'b', -1), -1);
  assert.ok(!lib.similar(store, user, store.data.items.a).some((x) => x.id === 'b'), 'not in More like this');
  assert.equal(lib.setThumb(store, user, 'a', 1), 1);
  const h = lib.home(store, user);
  const liked = h.hubs.find((x) => x.key === 'liked');
  assert.match(liked.title, /Because you liked Toy Story/);
  assert.ok(!liked.items.some((x) => x.id === 'b'));
  assert.notEqual(h.hero?.id, 'b');
  assert.equal(lib.itemSummary(store, user, store.data.items.a).thumb, 1);
  assert.equal(lib.setThumb(store, user, 'a', 0), 0);
  assert.equal(lib.itemSummary(store, user, store.data.items.a).thumb, 0);
});
