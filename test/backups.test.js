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
const { createTarGz, extractTarGz } = require('../lib/tar');
const { Scanner } = require('../lib/scanner');

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

test('restoring again straight away works: the rescan after a restore is stopped, not in the way', async () => {
  for (let i = 0; i < 3; i++) {
    const r = await admin('POST', '/api/backups/restore', null, { raw: fs.readFileSync(ids.downloaded), type: 'application/gzip' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  await until(async () => !(await admin('GET', '/api/status')).data.scanning);
  assert.equal((await admin('GET', `/api/libraries/${ids.lib}/items`)).data.items.length, 1, 'scanned again afterwards');
});

test('a damaged backup (cut short) is refused and changes nothing', async () => {
  const whole = fs.readFileSync(ids.downloaded);
  for (const cut of [whole.subarray(0, Math.floor(whole.length / 2)), whole.subarray(0, whole.length - 40)]) {
    const r = await admin('POST', '/api/backups/restore', null, { raw: cut, type: 'application/gzip' });
    assert.equal(r.status, 400, `${cut.length} of ${whole.length} bytes`);
  }
  assert.equal((await admin('GET', `/api/items/${ids.movie}`)).data.title, 'Before Backup');
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
  assert.deepEqual(ok.data.settings, { auto: true, time: '04:30', keep: 5, copyTo: null, copyKeep: 14 });
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

test('each backup is read back before it counts, and checking an archive writes nothing', async () => {
  const { b } = manager('verify');
  const made = await b.create('manual');
  const names = await extractTarGz(fs.createReadStream(path.join(b.dir, made.name)), null);
  assert.ok(names.includes('db.json') && names.includes('marquee-backup.json'));
  assert.deepEqual(fs.readdirSync(b.dir), [made.name], 'no half-written files left');
});

test('a backup copes with artwork that changes size while it is being written', async () => {
  const dir = path.join(ROOT, 'growing');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'poster.jpg');
  fs.writeFileSync(file, Buffer.alloc(1000, 1));
  const stream = createTarGz([{ name: 'a.jpg', file }, { name: 'b.txt', data: Buffer.from('after') }]);
  fs.appendFileSync(file, Buffer.alloc(5000, 2)); // replaced by a bigger one meanwhile
  const out = path.join(ROOT, 'growing.tar.gz');
  await writeStream(stream, out);
  const dest = path.join(ROOT, 'growing-out');
  assert.deepEqual(await extractTarGz(fs.createReadStream(out), dest), ['a.jpg', 'b.txt']);
  assert.equal(fs.readFileSync(path.join(dest, 'b.txt'), 'utf8'), 'after', 'what follows it is intact');
});

test('two restores at once: the second is turned away', async () => {
  const { b } = manager('twice');
  const made = await b.create('manual');
  let release;
  b.pauseScans = () => new Promise((r) => { release = r; });
  const first = b.restore(fs.createReadStream(path.join(b.dir, made.name)), { safetyCopy: false });
  await until(async () => release);
  await assert.rejects(b.restore(fs.createReadStream(path.join(b.dir, made.name))), (err) => err.status === 409);
  release();
  await first;
});

test('pausing scans stops one part-way without removing what it had not reached, and holds the rest', async () => {
  const dir = path.join(ROOT, 'pause-lib');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(dir, `Film ${i} (2000).mp4`), 'not really a video');
  const store = {
    data: { libraries: [{ id: 'L', name: 'Films', type: 'movie', paths: [dir] }], items: { gone: { id: 'gone', libraryId: 'L', file: path.join(dir, 'gone.mp4') } }, shows: {} },
    library(id) { return this.data.libraries.find((l) => l.id === id); }, save() {},
  };
  const scanner = new Scanner(store, path.join(ROOT, 'pause-data'));
  scanner.enqueue('L');
  await until(async () => scanner.current?.phase === 'probing' && scanner.current.done > 0);
  await scanner.pause();
  assert.equal(scanner.status().scanning, false);
  assert.ok(store.data.items.gone, 'a stopped scan removes nothing');
  scanner.enqueue('L');
  assert.equal(scanner.status().scanning, false, 'held while paused');
  scanner.resume();
  await until(async () => !scanner.status().scanning && !store.data.items.gone);
  assert.equal(Object.keys(store.data.items).length, 40, 'scanned in full afterwards');
});

test('a restore that can’t save its database (a full disk) puts everything back as it was', async () => {
  const { b, store } = manager('disk-full');
  const art = path.join(b.dataDir, 'images', 'poster.jpg');
  fs.mkdirSync(path.dirname(art), { recursive: true });
  fs.writeFileSync(art, 'restored');
  store.data.users = [{ id: 'old-account', username: 'from-the-backup' }];
  const made = await b.create('manual');
  // Now: other accounts and other artwork.
  fs.writeFileSync(art, 'current');
  store.data.users = [{ id: 'now', username: 'current' }];
  store.flush = () => { throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); };
  await assert.rejects(b.restore(fs.createReadStream(path.join(b.dir, made.name)), { safetyCopy: false }), (err) => err.status === 500 && /disk is full/.test(err.message));
  assert.deepEqual(store.data.users.map((u) => u.username), ['current'], 'the accounts in use are kept');
  assert.equal(fs.readFileSync(art, 'utf8'), 'current', 'and the artwork');
  assert.ok(!fs.readdirSync(b.dataDir).some((f) => /\.old-\d+$/.test(f)), 'nothing left over');
});
