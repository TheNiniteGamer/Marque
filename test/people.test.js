'use strict';
// A person's page: the titles in the library (that this user may see) with them in the cast.

const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../lib/library');

const store = {
  save() {},
  data: {
    libraries: [{ id: 'L', type: 'movie' }],
    items: {
      a: { id: 'a', type: 'movie', libraryId: 'L', title: 'Heat', year: 1995, file: '/m/heat.mp4', meta: { cast: [{ name: 'Al Pacino', character: 'Vincent Hanna', photo: 'https://img/al.jpg' }], contentRating: { cert: 'R', age: 17 } } },
      b: { id: 'b', type: 'movie', libraryId: 'L', title: 'Scarface', year: 1983, file: '/m/s.mp4', meta: { cast: [{ name: 'Al Pacino', character: 'Tony Montana' }] } },
      c: { id: 'c', type: 'movie', libraryId: 'L', title: 'Toy Story', year: 1995, file: '/m/t.mp4', meta: { cast: [{ name: 'Tom Hanks' }] } },
    },
    shows: {}, progress: {}, watchlist: {},
  },
};

test('a person page lists the titles they are in, newest first', () => {
  const p = lib.person(store, { id: 'u', role: 'admin' }, 'al pacino');
  assert.deepEqual(p.titles.map((t) => [t.title, t.character]), [['Heat', 'Vincent Hanna'], ['Scarface', 'Tony Montana']]);
  assert.equal(p.photoSource, 'https://img/al.jpg');
  assert.equal(lib.person(store, { id: 'u', role: 'admin' }, 'Nobody').titles.length, 0);
});

test('kids limits apply on person pages too', () => {
  const p = lib.person(store, { id: 'k', role: 'user', maxAge: 10, allowUnrated: true }, 'Al Pacino');
  assert.deepEqual(p.titles.map((t) => t.title), ['Scarface']); // Heat is R; Scarface has no rating here
});

test('cast in details links photos through the server', () => {
  const d = lib.itemDetail(store, { id: 'u', role: 'admin' }, store.data.items.a);
  assert.deepEqual(d.cast[0], { name: 'Al Pacino', character: 'Vincent Hanna', photo: '/api/people/Al%20Pacino/photo' });
});
