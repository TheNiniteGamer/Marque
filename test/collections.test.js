'use strict';
// Collections: automatic ones from TMDB (mocked) and ones made by admins.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-col-'));
const COL = { id: 900, name: 'Alpha Collection' };
const MOVIES = {
  1: { id: 1, title: 'Alpha', release_date: '2001-01-01', belongs_to_collection: COL },
  2: { id: 2, title: 'Alpha Two', release_date: '2003-01-01', belongs_to_collection: COL },
  3: { id: 3, title: 'Solo', release_date: '2010-01-01', belongs_to_collection: null },
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

let srv, admin, viewer, ids;
test.before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${mock.address().port}`;
  for (const name of ['Alpha (2001)', 'Alpha Two (2003)', 'Solo (2010)']) clip(path.join(ROOT, 'Movies', `${name}.mp4`));
  clip(path.join(ROOT, 'Kids', 'Cartoon (2015).mp4'));
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TMDB_API_KEY: 'k', TMDB_API_BASE: `${base}/3`, TMDB_IMAGE_BASE: `${base}/img`, TVMAZE_DISABLED: '1',
    AUTO_LIBRARIES: `Movies:movie:${path.join(ROOT, 'Movies')};Kids:movie:${path.join(ROOT, 'Kids')}` });
  admin = srv.client();
  viewer = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  await until(async () => (await admin('GET', '/api/libraries')).data.every((l) => l.scannedAt));
  const libs = Object.fromEntries((await admin('GET', '/api/libraries')).data.map((l) => [l.name, l.id]));
  const items = Object.fromEntries((await admin('GET', `/api/libraries/${libs.Movies}/items`)).data.items.map((i) => [i.title, i.id]));
  const kids = (await admin('GET', `/api/libraries/${libs.Kids}/items`)).data.items[0].id;
  ids = { libs, items, kids };
  await admin('POST', '/api/users', { username: 'kid', password: 'kidpass1', libraries: [libs.Kids] });
  await viewer('POST', '/api/auth/login', { username: 'kid', password: 'kidpass1' });
});
test.after(async () => { await srv?.stop(); mock.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('films from the same TMDB collection are grouped automatically', async () => {
  const list = (await admin('GET', `/api/collections?library=${ids.libs.Movies}`)).data;
  assert.deepEqual(list.map((c) => [c.id, c.name, c.count, c.kind]), [['tmdb-900', 'Alpha Collection', 2, 'auto']]);
  const detail = (await admin('GET', '/api/collections/tmdb-900')).data;
  assert.deepEqual(detail.items.map((i) => i.title), ['Alpha', 'Alpha Two'], 'oldest first');
  assert.deepEqual((await admin('GET', `/api/items/${ids.items.Alpha}`)).data.collections, [{ id: 'tmdb-900', name: 'Alpha Collection' }]);
  assert.deepEqual((await admin('GET', `/api/items/${ids.items.Solo}`)).data.collections, []);
  assert.equal((await admin('PATCH', '/api/collections/tmdb-900', { name: 'x' })).status, 400, 'TMDB collections are read-only');
});

test('admins make their own collections; users only see what they have access to', async () => {
  const made = await admin('POST', '/api/collections', { name: 'Favourites', members: [ids.items.Solo, ids.kids] });
  assert.equal(made.status, 201);
  const id = made.data.id;
  assert.equal(made.data.count, 2);
  assert.equal((await admin('POST', '/api/collections', { name: '  ' })).status, 400);

  // The kid can only see the Kids library: just the cartoon, and no TMDB collection.
  assert.deepEqual((await viewer('GET', '/api/collections')).data.map((c) => [c.name, c.count]), [['Favourites', 1]]);
  assert.deepEqual((await viewer('GET', `/api/collections/${id}`)).data.items.map((i) => i.title), ['Cartoon']);
  assert.equal((await viewer('GET', '/api/collections/tmdb-900')).status, 404);
  assert.equal((await viewer('POST', '/api/collections', { name: 'Mine' })).status, 403);

  assert.equal((await admin('PATCH', `/api/collections/${id}`, { name: 'Faves' })).data.name, 'Faves');
  assert.equal((await admin('DELETE', `/api/collections/${id}/members/${ids.kids}`)).data.count, 1);
  assert.equal((await admin('PUT', `/api/collections/${id}/members/${ids.items.Alpha}`)).data.count, 2);
  assert.equal((await admin('PUT', `/api/collections/${id}/members/nope`)).status, 400);
  assert.deepEqual((await admin('GET', `/api/items/${ids.items.Alpha}`)).data.collections.map((c) => c.name).sort(), ['Alpha Collection', 'Faves']);
  assert.equal((await admin('DELETE', `/api/collections/${id}`)).status, 200);
  assert.equal((await admin('GET', `/api/collections/${id}`)).status, 404);
});
