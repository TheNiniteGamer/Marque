'use strict';
// The database file: crash-safe saves, and recovery when db.json can't be read.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../lib/store');
const { startServer } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-store-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const quiet = (fn) => { const e = console.error; console.error = () => {}; try { return fn(); } finally { console.error = e; } };

test('each save keeps the previous version as db.json.bak', () => {
  const file = path.join(ROOT, 'a', 'db.json');
  const s = new Store(file);
  s.data.marker = 1; s.flush();
  s.data.marker = 2; s.flush();
  assert.equal(JSON.parse(fs.readFileSync(file)).marker, 2);
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`)).marker, 1);
  assert.ok(!fs.existsSync(`${file}.tmp`));
});

test('saves after watching reuse the library text, and still write everything', () => {
  const file = path.join(ROOT, 'reuse', 'db.json');
  const s = new Store(file);
  s.data.items.a = { id: 'a', title: 'First' };
  s.data.shows.x = { id: 'x', title: 'Show' };
  s.save(); s.flushOrRetry();
  const made = s.written.items;
  // Only watch progress changed: the titles' text isn't made again, but the file has it all.
  s.data.progress.u = { a: { position: 42 } };
  s.save({ personal: true }); s.flushOrRetry();
  assert.equal(s.written.items, made);
  let disk = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(disk.progress.u.a, { position: 42 });
  assert.deepEqual(disk.items.a, { id: 'a', title: 'First' });
  assert.deepEqual(disk.shows.x, { id: 'x', title: 'Show' });
  // A change to the library is written.
  s.data.items.b = { id: 'b', title: 'Second' };
  s.save(); s.flushOrRetry();
  disk = JSON.parse(fs.readFileSync(file));
  assert.ok(disk.items.b);
  // A save on request (shutdown, backups) writes everything afresh.
  s.data.items.c = { id: 'c' };
  s.flush();
  assert.ok(JSON.parse(fs.readFileSync(file)).items.c);
  clearTimeout(s.timer);
});

test('an unreadable db.json is recovered from the previous copy', () => {
  const file = path.join(ROOT, 'b', 'db.json');
  const s = new Store(file);
  s.data.users = [{ id: 'u1' }]; s.flush();
  s.data.users.push({ id: 'u2' }); s.flush();
  fs.writeFileSync(file, '{"users": [ {"id"'); // cut off mid-write
  const r = quiet(() => new Store(file));
  assert.equal(r.recoveredFrom, `${file}.bak`);
  assert.deepEqual(r.data.users.map((u) => u.id), ['u1']);
  assert.equal(r.lost, false);
  assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.startsWith('db.json.corrupt-')), 'the damaged file is kept');
});

test('nothing readable: flagged as lost (a fresh install is not)', () => {
  const file = path.join(ROOT, 'c', 'db.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '\0\0\0');
  assert.equal(quiet(() => new Store(file)).lost, true);
  assert.equal(new Store(path.join(ROOT, 'fresh', 'db.json')).lost, false);
});

test('the server restores the newest backup instead of starting empty', async () => {
  const data = path.join(ROOT, 'srv', 'data');
  const backupsDir = path.join(ROOT, 'srv', 'backups');
  let srv = await startServer({ DATA_DIR: data, BACKUP_DIR: backupsDir, TVMAZE_DISABLED: '1' });
  const admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'mum', password: 'password1' });
  assert.equal((await admin('POST', '/api/backups')).status, 201);
  await srv.stop();

  fs.writeFileSync(path.join(data, 'db.json'), 'garbage');
  for (const f of ['db.json.bak', 'db.json.tmp']) fs.rmSync(path.join(data, f), { force: true });
  srv = await startServer({ DATA_DIR: data, BACKUP_DIR: backupsDir, TVMAZE_DISABLED: '1' });
  try {
    const me = await srv.client()('GET', '/api/auth/me');
    assert.equal(me.data.setupRequired, false, 'no first-run screen');
    const again = srv.client();
    assert.equal((await again('POST', '/api/auth/login', { username: 'mum', password: 'password1' })).status, 200);
  } finally { await srv.stop(); }
});

test('a file that reads but isn’t a working database is passed over for one that is', () => {
  const { problemWith } = require('../lib/store');
  const file = path.join(ROOT, 'shape', 'db.json');
  const s = new Store(file);
  s.data.users = [{ id: 'u1', username: 'mum', password: 'x' }];
  s.data.libraries = [{ id: 'l1', name: 'Films', paths: ['/films'] }];
  s.flush(); s.flush(); // (so the .bak is a good copy too)
  for (const bad of ['[]', '{}', '{"libraries":5,"items":{},"shows":{}}', '{"libraries":[],"items":[],"shows":{}}',
    '{"libraries":[{"name":"no id"}],"items":{},"shows":{}}', '{"libraries":[],"items":{"a":3},"shows":{}}', '{"libraries":[],"items":{},"shows":{},"users":[null]}']) {
    assert.ok(problemWith(JSON.parse(bad)), `${bad} is refused`);
    fs.writeFileSync(file, bad);
    const r = quiet(() => new Store(file));
    assert.equal(r.recoveredFrom, `${file}.bak`, `${bad}: the good copy is used`);
    assert.equal(r.data.users[0].username, 'mum');
    fs.copyFileSync(`${file}.bak`, file);
  }
  assert.equal(problemWith(JSON.parse(fs.readFileSync(file, 'utf8'))), null);
});

test('with no usable copy and no backup, the server waits instead of starting empty', async () => {
  const data = path.join(ROOT, 'held', 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'db.json'), '{"libraries":"broken"}');
  fs.writeFileSync(path.join(data, 'db.json.bak'), '[]');
  const srv = await startServer({ DATA_DIR: data, BACKUP_DIR: path.join(ROOT, 'held', 'backups'), TVMAZE_DISABLED: '1' });
  try {
    const call = srv.client();
    const me = await call('GET', '/api/auth/me');
    assert.equal(me.status, 503);
    assert.equal(me.data.held, true);
    assert.equal((await call('POST', '/api/auth/setup', { username: 'stranger', password: 'password1' })).status, 503, 'nobody can claim it');
    assert.equal((await call('GET', '/api/health')).data.held, true);
  } finally { await srv.stop(); }
  assert.equal(fs.readFileSync(path.join(data, 'db.json.bak'), 'utf8'), '[]', 'nothing was saved over the copies');
  assert.ok(!fs.existsSync(path.join(data, 'db.json')), '(the damaged one was put aside)');
});

test('a malformed database is a problem to report, never a crash', () => {
  const { problemWith } = require('../lib/store');
  for (const bad of [null, 5, 'x', { libraries: null }, { libraries: [null] }, { libraries: [], items: null, shows: { a: null } }, { libraries: [], users: [5] }]) {
    assert.equal(typeof problemWith(bad), 'string', JSON.stringify(bad));
  }
  const file = path.join(ROOT, 'nulls', 'db.json');
  const s = new Store(file);
  s.data.libraries = [{ id: 'l1', paths: ['/films'] }];
  s.flush(); s.flush();
  fs.writeFileSync(file, '{"libraries":null}');
  const r = quiet(() => new Store(file));
  assert.equal(r.recoveredFrom, `${file}.bak`);
  assert.equal(r.data.libraries[0].id, 'l1');
});

test('waiting for a database carries on after a restart, until a copy is back or it’s reset', async () => {
  const data = path.join(ROOT, 'held2', 'data');
  const env = { DATA_DIR: data, BACKUP_DIR: path.join(ROOT, 'held2', 'backups'), TVMAZE_DISABLED: '1' };
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'db.json'), 'garbage');
  const waits = async () => {
    const srv = await startServer(env);
    try {
      const call = srv.client();
      return { me: await call('GET', '/api/auth/me'), setup: await call('POST', '/api/auth/setup', { username: 'stranger', password: 'password1' }) };
    } finally { await srv.stop(); }
  };
  for (const start of ['first', 'second']) {
    const r = await waits();
    assert.equal(r.me.status, 503, `${start} start waits`);
    assert.equal(r.setup.status, 503, `${start} start: nobody can claim it`);
  }
  // Starting afresh is a deliberate step: deleting the marker.
  fs.rmSync(path.join(data, 'db.json.recovery-needed'));
  const r = await waits();
  assert.equal(r.me.data.setupRequired, true);
  assert.equal(r.setup.status, 201);
});
