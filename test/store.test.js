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
