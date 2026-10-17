'use strict';
// Backups: create, download, restore (from the folder and by upload), safety copies, retention,
// schedule, and rejecting files that aren't Marquee backups.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { clip, startServer, until } = require('./helpers');
const { Backups, remapPaths } = require('../lib/backup');
const { createTarGz } = require('../lib/tar');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-backup-'));
const BACKUP_DIR = path.join(ROOT, 'backups');
const png = (n) => Buffer.from(`89504e470d0a1a0a0000000d4948445200000001000000010806000000${n.toString(16).padStart(2, '0')}15c4890000000049454e44ae426082`, 'hex');
let srv, admin;
const ids = {};

const writeStream = (stream, file) => new Promise((resolve, reject) => {
  const out = fs.createWriteStream(file);
  stream.on('error', reject);
  out.on('finish', resolve);
  stream.pipe(out);
});

test.before(async () => {
  clip(path.join(ROOT, 'Movies', 'Keeper (2001).mp4'));
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), BACKUP_DIR, TVMAZE_DISABLED: '1' });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  ids.lib = (await admin('POST', '/api/libraries', { name: 'Movies', type: 'movie', paths: [path.join(ROOT, 'Movies')] })).data.id;
  await until(async () => (await admin('GET', '/api/libraries')).data[0].count === 1);
  ids.movie = (await admin('GET', `/api/libraries/${ids.lib}/items`)).data.items[0].id;
  ids.bob = (await admin('POST', '/api/users', { username: 'bob', password: 'password2' })).data.id;
  await admin('POST', `/api/items/${ids.movie}/progress`, { position: 0.4 });
  await admin('PUT', `/api/watchlist/${ids.movie}`);
  await admin('PATCH', `/api/meta/${ids.movie}`, { title: 'Before Backup' });
  await admin('PUT', `/api/meta/${ids.movie}/art/poster`, null, { raw: png(1), type: 'image/png' });
});

test.after(async () => {
  await srv?.stop();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('back up now saves a standard .tar.gz with everything but sign-ins', async () => {
  const r = await admin('POST', '/api/backups');
  assert.equal(r.status, 201);
  assert.match(r.data.name, /^marquee-backup-\d{4}-\d{2}-\d{2}_\d{6}-manual\.tar\.gz$/);
  ids.backup = r.data.name;
  const file = path.join(BACKUP_DIR, r.data.name);
  const listing = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(listing.includes('marquee-backup.json') && listing.includes('db.json'));
  assert.ok(listing.some((n) => n.startsWith('images/custom/')), 'custom artwork included');
  const db = JSON.parse(execFileSync('tar', ['-xzOf', file, 'db.json'], { encoding: 'utf8' }));
  assert.deepEqual(db.sessions, {}, 'sign-in sessions are not in backups');
  assert.equal(db.users.length, 2);
  const status = (await admin('GET', '/api/backups')).data;
  assert.equal(status.backups[0].name, r.data.name);
  assert.equal(status.dir, BACKUP_DIR);
});

test('download a backup straight to the browser', async () => {
  const r = await admin('GET', '/api/backups/download');
  assert.equal(r.status, 200);
  ids.downloaded = path.join(ROOT, 'downloaded.tar.gz');
  fs.writeFileSync(ids.downloaded, r.data);
  assert.ok(execFileSync('tar', ['-tzf', ids.downloaded], { encoding: 'utf8' }).includes('db.json'));
});

test('restore from the backups folder brings everything back and keeps you signed in', async () => {
  // Change things after the backup.
  await admin('DELETE', `/api/users/${ids.bob}`);
  await admin('PATCH', `/api/meta/${ids.movie}`, { title: 'Changed Later' });
  await admin('DELETE', `/api/watchlist/${ids.movie}`);
  await admin('DELETE', `/api/meta/${ids.movie}/art/poster`);
  assert.equal((await admin('GET', '/api/users')).data.length, 1);

  const r = await admin('POST', `/api/backups/file/${ids.backup}/restore`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.safetyBackup, /pre-restore/);

  assert.equal((await admin('GET', '/api/auth/me')).status, 200, 'still signed in');
  assert.deepEqual((await admin('GET', '/api/users')).data.map((u) => u.username).sort(), ['admin', 'bob']);
  const item = (await admin('GET', `/api/items/${ids.movie}`)).data;
  assert.equal(item.title, 'Before Backup');
  assert.equal(item.inWatchlist, true);
  assert.equal(item.progress.position, 0.4);
  assert.ok((await admin('GET', `/api/art/poster/${ids.movie}`)).data.equals(png(1)), 'custom poster restored');
  const bob = srv.client();
  assert.equal((await bob('POST', '/api/auth/login', { username: 'bob', password: 'password2' })).status, 200, "bob's password works again");
});

test('restore by uploading a downloaded backup', async () => {
  await admin('PATCH', `/api/meta/${ids.movie}`, { title: 'Changed Again' });
  const r = await admin('POST', '/api/backups/restore', null, { raw: fs.readFileSync(ids.downloaded), type: 'application/gzip' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await admin('GET', `/api/items/${ids.movie}`)).data.title, 'Before Backup');
});

test('files that are not Marquee backups are rejected without changing anything', async () => {
  const before = (await admin('GET', '/api/users')).data.length;
  let r = await admin('POST', '/api/backups/restore', null, { raw: Buffer.from('definitely not a backup'), type: 'application/gzip' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /not a valid/);

  const noManifest = path.join(ROOT, 'nomanifest.tar.gz');
  await writeStream(createTarGz([{ name: 'db.json', data: Buffer.from('{}') }]), noManifest);
  r = await admin('POST', '/api/backups/restore', null, { raw: fs.readFileSync(noManifest), type: 'application/gzip' });
  assert.equal(r.status, 400);

  const evilDir = path.join(ROOT, 'evil');
  fs.mkdirSync(evilDir);
  fs.writeFileSync(path.join(evilDir, 'x'), 'x');
  const evil = path.join(ROOT, 'evil.tar.gz');
  execFileSync('tar', ['-czf', evil, '-C', evilDir, '--transform', 's|x|../../escaped|', 'x']);
  r = await admin('POST', '/api/backups/restore', null, { raw: fs.readFileSync(evil), type: 'application/gzip' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Unsafe path/);

  assert.equal((await admin('POST', '/api/backups/file/..%2F..%2Fetc%2Fpasswd/restore')).status, 404);
  assert.equal((await admin('GET', '/api/users')).data.length, before);
});

test('only admins can back up or restore', async () => {
  const bob = srv.client();
  await bob('POST', '/api/auth/login', { username: 'bob', password: 'password2' });
  assert.equal((await bob('GET', '/api/backups')).status, 403);
  assert.equal((await bob('GET', '/api/backups/download')).status, 403);
  assert.equal((await bob('POST', '/api/backups/restore', null, { raw: fs.readFileSync(ids.downloaded), type: 'application/gzip' })).status, 403);
});

test('settings are validated', async () => {
  assert.equal((await admin('PATCH', '/api/backups/settings', { time: '25:00' })).status, 400);
  assert.equal((await admin('PATCH', '/api/backups/settings', { keep: 0 })).status, 400);
  const ok = await admin('PATCH', '/api/backups/settings', { time: '04:30', keep: 5, auto: true });
  assert.deepEqual(ok.data.settings, { auto: true, time: '04:30', keep: 5 });
});

// ---------- unit tests of the backup manager ----------
function manager(name) {
  const dataDir = path.join(ROOT, name);
  fs.mkdirSync(dataDir, { recursive: true });
  const store = { data: { users: [{ id: 'u1' }], libraries: [], items: {}, settings: {} }, save() {}, flush() {} };
  return { b: new Backups(store, { dataDir, dir: path.join(dataDir, 'backups') }), store };
}

test('automatic backups keep the newest N; your own backups are never pruned', async () => {
  const { b, store } = manager('retention');
  store.data.settings.backupKeep = 2;
  await b.create('manual');
  for (let i = 0; i < 4; i++) await b.create('auto');
  for (let i = 0; i < 5; i++) await b.create('pre-restore');
  const kinds = b.list().map((x) => x.kind);
  assert.equal(kinds.filter((k) => k === 'auto').length, 2);
  assert.equal(kinds.filter((k) => k === 'manual').length, 1);
  assert.equal(kinds.filter((k) => k === 'pre-restore').length, 3);
});

test('the daily backup runs once a day at (or after) the chosen time', async () => {
  const { b, store } = manager('schedule');
  store.data.settings.backupTime = '03:00';
  assert.equal(b.runIfDue(new Date(2026, 9, 17, 2, 59)), null, 'not yet');
  const first = b.runIfDue(new Date(2026, 9, 17, 3, 0));
  assert.ok(first);
  await first;
  assert.equal(b.runIfDue(new Date(2026, 9, 17, 9, 0)), null, 'already done today');
  const next = b.runIfDue(new Date(2026, 9, 18, 7, 45)); // PC was off at 03:00: catch up
  assert.ok(next);
  await next;
  store.data.settings.backupAuto = false;
  assert.equal(b.runIfDue(new Date(2026, 9, 19, 3, 0)), null, 'turned off');
  assert.equal(b.list().filter((x) => x.kind === 'auto').length, 2);
});

test('paths from a different data folder are remapped on restore', () => {
  const data = { items: { a: { meta: { poster: 'C:\\Marquee\\data\\images\\a-poster.jpg' }, edits: { backdrop: '/old/images/custom/b.png' } } }, other: '/old/imagesX/no' };
  remapPaths(data, '/old/images', '/data/images');
  assert.equal(data.items.a.edits.backdrop, '/data/images/custom/b.png');
  assert.equal(data.other, '/old/imagesX/no', 'only whole path prefixes');
  remapPaths(data, 'C:\\Marquee\\data\\images', '/data/images');
  assert.equal(data.items.a.meta.poster, '/data/images/a-poster.jpg');
});
