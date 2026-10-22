'use strict';
// Search beyond titles: spelling mistakes, actors, genres and moods, years and decades, the story.

const test = require('node:test');
const assert = require('node:assert/strict');
const { find, close, norm } = require('../lib/search');

const film = (id, title, year, meta = {}) => ({ id, type: 'movie', title, year, meta: { title, year, ...meta } });
const items = {
  a: film('a', 'Batman Begins', 2005, { cast: [{ name: 'Christian Bale' }], genres: ['Action'], overview: 'A young Bruce Wayne trains to fight crime.' }),
  b: film('b', 'Toy Story', 1995, { cast: [{ name: 'Tom Hanks' }], genres: ['Animation', 'Comedy', 'Family'] }),
  c: film('c', 'Apollo 13', 1995, { cast: [{ name: 'Tom Hanks' }], genres: ['Drama', 'History'] }),
  d: film('d', 'Elf', 2003, { genres: ['Comedy'], keywords: ['christmas', 'north pole'], overview: 'Raised by elves at the North Pole.' }),
  e: film('e', 'It', 2017, { genres: ['Horror'] }),
  f: film('f', 'Spider-Man: Homecoming', 2017, { genres: ['Action'] }),
  g: film('g', 'Pokémon: The First Movie', 1998, { genres: ['Animation'] }),
  h: film('h', '[000089]', 2001, { title: 'A Minecraft Movie' }),
  e1: { id: 'e1', type: 'episode', title: 'A Very Merry Christmas', showTitle: 'Family Guy', meta: { overview: 'Lois tries to make Christmas perfect.' } },
  e2: { id: 'e2', type: 'episode', title: 'Road to Rhode Island', showTitle: 'Family Guy', meta: { overview: 'Brian and Stewie travel.' } },
};
const store = { rev: 1, data: { items, shows: {} } };
const titles = Object.values(items).filter((i) => i.type === 'movie');
const eps = Object.values(items).filter((i) => i.type === 'episode');
const search = (q) => find(store, titles, eps, q);
const ids = (q) => search(q).titles.map((r) => r.o.id);

test('words are compared without accents, case or punctuation', () => {
  assert.equal(norm('Pokémon: The First Movie'), 'pokemon the first movie');
  assert.deepEqual(ids('pokemon'), ['g']);
  assert.deepEqual(ids('spiderman'), ['f']);
  assert.deepEqual(ids('spider man'), ['f']);
  assert.deepEqual(ids('minecraft'), ['h'], 'the proper title, not the file’s name');
});

test('spelling mistakes are forgiven, but not for words that are in the library', () => {
  assert.ok(close('batmn', 'batman') && close('stroy', 'story') && !close('cat', 'bat'));
  assert.deepEqual(ids('batmn'), ['a']);
  assert.deepEqual(ids('toy stroy'), ['b']);
  // "christmas" is a word here, so it isn't taken as a misspelt "Christian" (Bale).
  assert.deepEqual(ids('christmas'), ['d']);
});

test('actors, moods, genres, years and decades', () => {
  const tom = search('tom hanks');
  assert.deepEqual(tom.titles.map((r) => r.o.id).sort(), ['b', 'c']);
  assert.deepEqual(tom.understood, ['with Tom Hanks']);
  assert.deepEqual(ids('funny').sort(), ['b', 'd']);
  assert.deepEqual(search('funny').understood, ['Comedy']);
  assert.deepEqual(ids('scary'), ['e']);
  assert.deepEqual(ids('90s comedy'), ['b']);
  assert.deepEqual(search('90s comedy').understood, ['the 1990s']);
  assert.deepEqual(ids('1995').sort(), ['b', 'c']);
  assert.deepEqual(ids('tom hanks 90s drama'), ['c']);
});

test('every word has to be found; small words alone only match a title', () => {
  assert.deepEqual(ids('tom hanks horror'), []);
  assert.deepEqual(ids('it'), ['e']);
  assert.deepEqual(ids('the'), []);
  assert.deepEqual(ids('north pole'), ['d'], 'from the story and keywords');
});

test('episodes by their own title or story, not the show’s name', () => {
  assert.deepEqual(search('christmas').episodes.map((r) => r.o.id), ['e1']);
  assert.deepEqual(search('family guy').episodes, []);
  assert.deepEqual(search('rhode island').episodes.map((r) => r.o.id), ['e2']);
});
