'use strict';
// The health check: what it finds, and admins told once when something turns bad.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Health } = require('../lib/health');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-health-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('finds offline folders, stopped backups and failing copies, and tells admins once', () => {
  const lib = path.join(ROOT, 'Movies');
  fs.mkdirSync(lib);
  const store = {
    data: { libraries: [{ id: 'L', name: 'Movies', paths: [lib, path.join(ROOT, 'Unplugged')] }], users: [{ id: 'a', role: 'admin' }, { id: 'u', role: 'user' }] },
    save() {},
  };
  let backups = [{ name: 'x', createdAt: Date.now() - 5 * 86400_000 }];
  const fakeBackups = { settings: () => ({ auto: true, copyTo: ROOT }), list: () => backups };
  store.data.backupCopy = { ok: false, error: 'EACCES' };
  const h = new Health({ store, dataDir: ROOT, backups: fakeBackups, logs: { recent: () => [] } });
  const r = h.run();
  const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
  assert.equal(r.level, 'bad');
  assert.equal(by.folders.level, 'bad');
  assert.match(by.folders.detail, /Unplugged/);
  assert.equal(by['backup-age'].level, 'bad', 'automatic backups but the newest is 5 days old');
  assert.equal(by['backup-copy'].level, 'bad');
  assert.equal(by['disk-data'].level === 'ok' || by['disk-data'].level === 'warn' || by['disk-data'].level === 'bad', true);
  assert.equal(r.checks[0].level, 'bad', 'worst first');
  const told = store.data.notifications.a.map((n) => n.title);
  assert.ok(told.includes('1 library folder is offline'));
  assert.ok(told.includes('Backups have stopped'));
  assert.equal(store.data.notifications.u, undefined, 'only admins');
  // The same problems again: nobody is told twice.
  const before = store.data.notifications.a.length;
  h.run();
  assert.equal(store.data.notifications.a.length, before);
  // Fixed: back to fine.
  fs.mkdirSync(path.join(ROOT, 'Unplugged'));
  backups = [{ name: 'y', createdAt: Date.now() }];
  store.data.backupCopy = { ok: true };
  const r2 = h.run();
  assert.equal(r2.checks.find((c) => c.id === 'folders').level, 'ok');
  assert.equal(r2.checks.find((c) => c.id === 'backup-age').level, 'ok');
  assert.equal(r2.checks.find((c) => c.id === 'backup-copy').level, 'ok');
});
