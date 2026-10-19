'use strict';
// Backups copied to a second place (another drive, a share, a cloud-synced folder).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../lib/store');
const { Backups } = require('../lib/backup');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-bkcopy-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('each backup is also copied to the second folder, which keeps its own number', async () => {
  const store = new Store(path.join(ROOT, 'data', 'db.json'));
  store.data.users = [{ id: 'u', username: 'admin', role: 'admin' }];
  const b = new Backups(store, { dataDir: path.join(ROOT, 'data'), dir: path.join(ROOT, 'data', 'backups') });
  const other = path.join(ROOT, 'OneDrive', 'Marquee');
  assert.throws(() => b.update({ copyTo: other }), /can’t be found/);
  assert.throws(() => b.update({ copyTo: path.join(ROOT, 'data', 'backups', 'x') }), /can’t be found|somewhere other/);
  fs.mkdirSync(other, { recursive: true });
  b.update({ copyTo: other, copyKeep: 2 });
  assert.equal(b.status().copy.last, null);
  for (let i = 0; i < 3; i++) await b.create('manual');
  const copies = fs.readdirSync(other).sort();
  assert.equal(copies.length, 2, 'the newest two kept there');
  assert.deepEqual(copies, b.list().slice(0, 2).map((x) => x.name).sort());
  assert.equal(b.list().length, 3, 'backups made by hand are all kept at home');
  const s = b.status().copy;
  assert.equal(s.last.ok, true);
  assert.equal(s.count, 2);
  // The folder goes away (a drive unplugged): the backup is still made, and the failure is reported.
  fs.rmSync(other, { recursive: true, force: true });
  const made = await b.create('manual');
  assert.ok(made.name);
  assert.equal(b.status().copy.last.ok, false);
  assert.match(b.status().copy.last.error, /isn’t there any more/);
  b.update({ copyTo: '' });
  assert.equal(b.status().copy, null);
  store.flush();
});
