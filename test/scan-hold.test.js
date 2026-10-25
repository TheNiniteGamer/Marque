'use strict';
// A folder that reads without an error but comes back short (a drive hiccup): when many titles
// vanish in one scan they're kept, with their history, until a later scan confirms they're gone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-scan-hold-'));
const FILMS = path.join(ROOT, 'Films');
const AWAY = path.join(ROOT, 'away');
let srv, admin, lib;

const titles = async () => (await admin('GET', `/api/libraries/${lib.id}/items`)).data.items.map((x) => x.title).sort();
async function scan() {
  const at = async () => (await admin('GET', '/api/libraries')).data.find((l) => l.id === lib.id).scannedAt;
  const before = await at();
  await admin('POST', `/api/libraries/${lib.id}/scan`);
  await until(async () => (await at()) !== before, 30_000);
}

test.before(async () => {
  // One film stays; three sit in a folder that will "drop out" without an error.
  clip(path.join(FILMS, 'Keeper (2000).mp4'));
  for (const n of ['One', 'Two', 'Three']) clip(path.join(FILMS, 'Shelf', `${n} (2001).mp4`));
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1', SCAN_MASS_MISSING: '2', SCAN_HOLD_MS: '1500', AUTO_LIBRARIES: `Films:movie:${FILMS}` });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'dad', password: 'password1' });
  lib = await until(async () => (await admin('GET', '/api/libraries')).data.find((l) => l.scannedAt && l.count === 4));
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('many titles vanishing at once are kept until a later scan, and come back with their history', async () => {
  const one = (await admin('GET', `/api/libraries/${lib.id}/items`)).data.items.find((x) => x.title === 'One');
  assert.equal((await admin('POST', `/api/items/${one.id}/progress`, { position: 0.5 })).status, 200);
  fs.renameSync(path.join(FILMS, 'Shelf'), path.join(AWAY));
  await scan();
  assert.deepEqual(await titles(), ['Keeper', 'One', 'Three', 'Two'], 'kept after the first scan');
  // Back before the next scan: nothing lost.
  fs.renameSync(AWAY, path.join(FILMS, 'Shelf'));
  await new Promise((r) => setTimeout(r, 1600));
  await scan();
  const back = (await admin('GET', `/api/libraries/${lib.id}/items`)).data.items.find((x) => x.title === 'One');
  assert.equal(back.id, one.id);
  assert.ok(back.progress?.position > 0, 'history kept');
});

test('really gone: removed on a scan after the wait', async () => {
  fs.renameSync(path.join(FILMS, 'Shelf'), AWAY);
  await scan();
  assert.equal((await titles()).length, 4, 'still held');
  await scan();
  assert.equal((await titles()).length, 4, 'a scan straight after still waits');
  await new Promise((r) => setTimeout(r, 1600));
  await scan();
  assert.deepEqual(await titles(), ['Keeper']);
});
