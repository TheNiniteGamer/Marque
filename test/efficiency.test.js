'use strict';
// Doing less work: episode grouping, fewer database writes while watching, compressed and cached
// responses.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../lib/store');
const lib = require('../lib/library');
const { clip, startServer, until } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-eff-'));
let srv, admin, movieId, libId;
const DB = path.join(ROOT, 'data', 'db.json');

// A raw request, to see exactly what the server sends (fetch would unpack it).
function raw(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(srv.base + urlPath);
    http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { ...headers, cookie: admin.cookie } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test.before(async () => {
  for (let i = 1; i <= 6; i++) clip(path.join(ROOT, 'Movies', `Film Number ${i} (200${i}).mp4`), 6);
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), AUTO_LIBRARIES: `Movies:movie:${path.join(ROOT, 'Movies')}` });
  const c = srv.client();
  await c('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  await until(async () => (await c('GET', '/api/libraries')).data[0]?.scannedAt);
  libId = (await c('GET', '/api/libraries')).data[0].id;
  movieId = (await c('GET', `/api/libraries/${libId}/items`)).data.items[0].id;
  // Reuse the session cookie for raw requests.
  const login = await fetch(`${srv.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'password1' }) });
  admin = Object.assign(c, { cookie: login.headers.get('set-cookie').split(';')[0] });
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('episodes are grouped by show once, and changes show up on the next request', async () => {
  const store = { data: { items: {
    a: { id: 'a', showId: 's', season: 1, episode: 2 }, b: { id: 'b', showId: 's', season: 1, episode: 1 }, m: { id: 'm', type: 'movie' },
  } } };
  assert.deepEqual(lib.episodesOf(store, 's').map((e) => e.id), ['b', 'a'], 'in episode order');
  lib.episodesOf(store, 's').pop(); // callers get their own list
  assert.equal(lib.episodesOf(store, 's').length, 2);
  store.data.items.c = { id: 'c', showId: 's', season: 1, episode: 3 };
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(lib.episodesOf(store, 's').map((e) => e.id), ['b', 'a', 'c']);
  assert.deepEqual(lib.episodesOf(store, 'nope'), []);
});

test('ordinary saves happen soon; lazy ones wait but are taken along by the next save', async () => {
  const file = path.join(ROOT, 'lazy', 'db.json');
  const s = new Store(file);
  s.data.n = 1; s.flush();
  s.data.n = 2; s.save({ lazy: true });
  await new Promise((r) => setTimeout(r, 1800));
  assert.equal(JSON.parse(fs.readFileSync(file)).n, 1, 'a lazy save waits');
  s.data.n = 3; s.save();
  await new Promise((r) => setTimeout(r, 1800));
  assert.equal(JSON.parse(fs.readFileSync(file)).n, 3, 'an ordinary save comes sooner');
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`)).n, 1);
  clearTimeout(s.timer);
});

test('watch progress while playing is not written to disk every time; pausing is', async () => {
  const onDisk = () => Object.values(JSON.parse(fs.readFileSync(DB)).progress || {}).find((m) => m[movieId])?.[movieId].position;
  await new Promise((r) => setTimeout(r, 1800)); // earlier changes written
  await admin('POST', `/api/items/${movieId}/progress`, { position: 0.3 });
  assert.equal((await admin('GET', `/api/items/${movieId}`)).data.progress.position, 0.3, 'known straight away');
  await new Promise((r) => setTimeout(r, 1800));
  assert.equal(onDisk(), undefined, 'not written yet');
  // Paused right after the last report: the position waiting to be written goes now.
  await admin('POST', `/api/items/${movieId}/progress`, { position: 0.4, paused: true });
  await until(async () => onDisk() === 0.3);
  await admin('POST', `/api/items/${movieId}/progress`, { position: 3, paused: true });
  await until(async () => onDisk() === 3);
});

test('JSON and the web app are compressed; files the browser has get "not modified"', async () => {
  const list = await raw(`/api/libraries/${libId}/items`, { 'accept-encoding': 'gzip' });
  assert.equal(list.headers['content-encoding'], 'gzip');
  assert.equal(JSON.parse(require('node:zlib').gunzipSync(list.body)).items.length, 6);
  assert.equal((await raw(`/api/libraries/${libId}/items`)).headers['content-encoding'], undefined, 'only when asked for');

  const app = await raw('/app.js', { 'accept-encoding': 'gzip, br' });
  assert.equal(app.headers['content-encoding'], 'gzip');
  assert.ok(app.body.length < fs.statSync(path.join(__dirname, '..', 'public', 'app.js')).size / 2);
  const again = await raw('/app.js', { 'if-none-match': app.headers.etag });
  assert.deepEqual([again.status, again.body.length], [304, 0]);

  // Posters: addresses carry ?v=…, so the browser keeps them.
  const poster = await raw(`/api/art/poster/${movieId}?v=1`);
  assert.equal(poster.status, 200);
  assert.match(poster.headers['cache-control'], /immutable/);
  assert.equal((await raw(`/api/art/poster/${movieId}?v=1`, { 'if-none-match': poster.headers.etag })).status, 304);
  // Video ranges are unaffected.
  const part = await raw(`/api/items/${movieId}/stream`, { range: 'bytes=0-99', 'accept-encoding': 'gzip' });
  assert.deepEqual([part.status, part.body.length, part.headers['content-encoding']], [206, 100, undefined]);
});
