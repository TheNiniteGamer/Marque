'use strict';
// Franchises (the Marvel Cinematic Universe, Pixar…): worked out from TMDB's keywords, studios and
// film series (mocked), listed as collections of their own, with rows by series, how much you've
// seen and what's next, and shown on each title's page.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');
const franchises = require('../lib/franchises');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-franchise-'));
const MARVEL = [{ name: 'Marvel Studios' }];
const MCU = { keywords: [{ name: 'Marvel Cinematic Universe (MCU)' }, { name: 'superhero' }] };
const IRON = { id: 131292, name: 'Iron Man Collection' };
const MOVIES = {
  1: { id: 1, title: 'Iron Man', release_date: '2008-05-02', belongs_to_collection: IRON, production_companies: MARVEL, keywords: MCU },
  2: { id: 2, title: 'Iron Man 2', release_date: '2010-05-07', belongs_to_collection: IRON, production_companies: MARVEL, keywords: MCU },
  3: { id: 3, title: 'The Avengers', release_date: '2012-05-04', belongs_to_collection: { id: 86311, name: 'The Avengers Collection' }, production_companies: MARVEL, keywords: MCU },
  // No MCU keyword on TMDB: the studio and year are enough.
  4: { id: 4, title: 'Thor', release_date: '2011-05-06', belongs_to_collection: null, production_companies: MARVEL, keywords: { keywords: [] } },
  5: { id: 5, title: 'Toy Story', release_date: '1995-11-22', belongs_to_collection: { id: 10194, name: 'Toy Story Collection' }, production_companies: [{ name: 'Pixar' }], keywords: { keywords: [] } },
  6: { id: 6, title: 'Up', release_date: '2009-05-29', belongs_to_collection: null, production_companies: [{ name: 'Pixar' }], keywords: { keywords: [] } },
  7: { id: 7, title: 'Heat', release_date: '1995-12-15', belongs_to_collection: null, production_companies: [{ name: 'Regency' }], keywords: { keywords: [] } },
};
const mock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (body) => { res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }); res.end(JSON.stringify(body || {})); };
  if (url.pathname === '/3/search/movie') {
    const q = url.searchParams.get('query').toLowerCase();
    return send({ results: Object.values(MOVIES).filter((m) => m.title.toLowerCase() === q) });
  }
  const m = /^\/3\/movie\/(\d+)$/.exec(url.pathname);
  send(m && MOVIES[m[1]] ? { ...MOVIES[m[1]], genres: [], credits: { cast: [] }, images: {} } : null);
});

let srv, admin, ids;
test.before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${mock.address().port}`;
  for (const m of Object.values(MOVIES)) clip(path.join(ROOT, 'Movies', `${m.title} (${m.release_date.slice(0, 4)}).mp4`), 10);
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TMDB_API_KEY: 'k', TMDB_API_BASE: `${base}/3`, TMDB_IMAGE_BASE: `${base}/img`, TVMAZE_DISABLED: '1',
    AUTO_LIBRARIES: `Movies:movie:${path.join(ROOT, 'Movies')}` });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  await until(async () => (await admin('GET', '/api/libraries')).data.every((l) => l.scannedAt));
  const lib = (await admin('GET', '/api/libraries')).data[0];
  await until(async () => (await admin('GET', '/api/collections')).data.find((c) => c.id === 'franchise-mcu')?.count === 4);
  ids = Object.fromEntries((await admin('GET', `/api/libraries/${lib.id}/items`)).data.items.map((i) => [i.title, i.id]));
});
test.after(async () => { await srv?.stop(); mock.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('franchises are found from keywords, studios and film series, in a section of their own', async () => {
  const list = (await admin('GET', '/api/collections')).data;
  const mcu = list.find((c) => c.id === 'franchise-mcu');
  assert.ok(mcu, JSON.stringify(list.map((c) => c.id)));
  assert.equal(mcu.name, 'Marvel Cinematic Universe');
  assert.equal(mcu.kind, 'franchise');
  assert.equal(mcu.section, 'franchises');
  assert.equal(mcu.count, 4, 'Thor too, from the studio');
  assert.equal(mcu.studio, false);
  const pixar = list.find((c) => c.id === 'franchise-pixar');
  assert.deepEqual([pixar.count, pixar.studio], [2, true]);
  // The film series inside them are still collections of their own (one Toy Story film isn't one).
  assert.ok(list.some((c) => c.id === 'tmdb-131292' && c.section === 'movies'));
  assert.ok(!list.some((c) => c.id === 'tmdb-10194'));
  assert.ok(!list.some((c) => c.memberIds.includes(ids.Heat)));
});

test('a franchise page has rows by series, what you have seen, and what is next', async () => {
  let d = (await admin('GET', '/api/collections/franchise-mcu')).data;
  assert.deepEqual(d.items.map((i) => i.title), ['Iron Man', 'Iron Man 2', 'Thor', 'The Avengers'], 'release order');
  assert.deepEqual(d.parts.map((p) => [p.name, p.ids.length]), [['Iron Man', 2], ['More films', 2]], 'a series of one is with the other films');
  assert.equal(d.watched, 0);
  assert.deepEqual([d.next.title, d.next.first, d.next.started], ['Iron Man', true, false]);
  assert.match(d.about, /Iron Man/);

  await admin('POST', `/api/items/${ids['Iron Man']}/watched`, { watched: true });
  await admin('POST', `/api/items/${ids.Thor}/progress`, { position: 1 });
  d = (await admin('GET', '/api/collections/franchise-mcu')).data;
  assert.equal(d.watched, 1);
  assert.deepEqual([d.next.title, d.next.started], ['Thor', true], 'something half-watched comes first');

  // An admin's story order is what "next" follows.
  const order = [ids.Thor, ids['Iron Man'], ids['Iron Man 2'], ids['The Avengers']];
  assert.equal((await admin('PUT', '/api/collections/franchise-mcu/order', { order })).status, 200);
  await admin('POST', `/api/items/${ids.Thor}/watched`, { watched: true });
  d = (await admin('GET', '/api/collections/franchise-mcu')).data;
  assert.deepEqual(d.items.map((i) => i.title), ['Thor', 'Iron Man', 'Iron Man 2', 'The Avengers']);
  assert.equal(d.next.title, 'Iron Man 2');
  assert.equal((await admin('POST', '/api/collections/franchise-mcu/reset')).status, 200);
});

test('a title shows the franchise it is part of, and more from it', async () => {
  const it = (await admin('GET', `/api/items/${ids['Iron Man 2']}`)).data;
  assert.deepEqual(it.collections.find((c) => c.id === 'franchise-mcu'), { id: 'franchise-mcu', name: 'Marvel Cinematic Universe', franchise: true });
  assert.equal(it.franchise.id, 'franchise-mcu');
  assert.equal(it.franchise.count, 4);
  assert.deepEqual(it.franchise.items.map((i) => i.title), ['Thor', 'The Avengers', 'Iron Man'], 'what comes after it first');
  assert.equal((await admin('GET', `/api/items/${ids.Heat}`)).data.franchise, null);
});

test('franchises can be renamed, hidden and given more titles like any automatic collection', async () => {
  assert.equal((await admin('PATCH', '/api/collections/franchise-mcu', { name: 'Marvel' })).data.name, 'Marvel');
  assert.equal((await admin('PUT', `/api/collections/franchise-mcu/members/${ids.Heat}`)).data.count, 5);
  assert.equal((await admin('PATCH', '/api/collections/franchise-pixar', { hidden: true })).status, 200);
  assert.ok(!(await admin('GET', '/api/collections')).data.some((c) => c.id === 'franchise-pixar'));
  // Any collection can be moved into Franchises (and gets the franchise page).
  const mine = (await admin('POST', '/api/collections', { name: 'Heat & Up', members: [ids.Heat, ids.Up], section: 'franchises' })).data;
  assert.equal(mine.section, 'franchises');
  assert.equal(mine.watched, 0);
  assert.equal((await admin('POST', '/api/collections/franchise-mcu/reset')).data.name, 'Marvel Cinematic Universe');
  assert.equal((await admin('PATCH', '/api/collections/franchise-pixar', { hidden: false })).status, 200);
});

test('the home page has a row of franchises', async () => {
  const hubs = (await admin('GET', '/api/home')).data.hubs;
  const row = hubs.find((h) => h.key === 'franchises');
  assert.ok(row, hubs.map((h) => h.key).join());
  assert.ok(row.items.every((c) => c.type === 'collection' && c.section === 'franchises'));
  assert.ok(row.items.some((c) => c.id === 'franchise-mcu'));
  assert.equal((await admin('PATCH', '/api/settings', { home: { franchises: false } })).status, 200);
  assert.ok(!(await admin('GET', '/api/home')).data.hubs.some((h) => h.key === 'franchises'), 'can be turned off');
});

test('the catalogue: shows, film series and studios', () => {
  const store = { data: { items: {}, shows: {
    a: { id: 'a', title: 'The Mandalorian', meta: { year: 2019, keywords: [], companies: ['Lucasfilm Ltd.'] } },
    b: { id: 'b', title: 'Andor', meta: { year: 2022, keywords: ['star wars'], companies: [] } },
    c: { id: 'c', title: 'Indiana Jones', meta: { year: 1981, keywords: [], companies: ['Lucasfilm Ltd.'] } },
  } } };
  store.data.items = {
    d: { id: 'd', type: 'movie', title: 'Harry Potter and the Philosopher’s Stone', meta: { collection: { name: 'Harry Potter Collection' } } },
    e: { id: 'e', type: 'movie', title: 'Fantastic Beasts and Where to Find Them', meta: { collection: { name: 'Fantastic Beasts Collection' } } },
    f: { id: 'f', type: 'movie', title: 'Spirited Away', meta: { companies: ['Studio Ghibli'] } },
    g: { id: 'g', type: 'movie', title: 'Captain America', meta: { year: 1990, companies: ['Marvel Studios'] } }, // (before the MCU)
  };
  const found = Object.fromEntries(franchises.groups(store).map((f) => [f.id, f.members.sort()]));
  assert.deepEqual(found['franchise-star-wars'], ['a', 'b']);
  assert.deepEqual(found['franchise-wizarding-world'], ['d', 'e']);
  assert.deepEqual(found['franchise-ghibli'], ['f']);
  assert.equal(found['franchise-mcu'], undefined);
  assert.equal(franchises.info('franchise-mcu').name, 'Marvel Cinematic Universe');
});
