'use strict';
// AUTO_LIBRARIES (used by the Docker setup): libraries spanning several folders/drives, folders added
// to the config later, and respecting what the admin removed in the UI. Restarts the server between steps.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-autolib-'));
const PORT = 40000 + Math.floor(Math.random() * 10000);
const BASE = `http://127.0.0.1:${PORT}`;
const drive = (n) => path.join(ROOT, `drive${n}`, 'Movies');
let server = null;
let cookie = '';

function clip(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
}

async function start(autoLibraries) {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: path.join(ROOT, 'data'), SCAN_INTERVAL: '0',
      AUTO_LIBRARIES: autoLibraries, TMDB_API_KEY: '', TMDB_TOKEN: '', YTDLP_PATH: '/nonexistent' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function stop() {
  if (!server) return;
  const exited = new Promise((r) => server.once('exit', r));
  server.kill('SIGTERM'); // flushes the database
  await exited;
  server = null;
}

async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return res.json();
}

const libraries = () => call('GET', '/api/libraries');
const movies = async () => (await libraries()).find((l) => l.name === 'Movies');

test.before(() => {
  clip(path.join(drive(1), 'One (2001).mp4'));
  clip(path.join(drive(2), 'Two (2002).mp4'));
  clip(path.join(drive(2), 'Three (2003).mp4'));
  fs.mkdirSync(drive(3), { recursive: true });
});
test.after(async () => { await stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('one library spans folders on several drives', async () => {
  await start(`Movies:movie:${drive(1)},${drive(2)}; TV:show:${path.join(ROOT, 'nope')}`);
  await call('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  const lib = await movies();
  assert.deepEqual(lib.paths, [drive(1), drive(2)]);
  assert.equal((await libraries()).length, 1, 'library with no existing folders is not created');
  // Scan sees both drives, and per-folder counts are reported.
  for (let i = 0; i < 100 && (await movies()).count < 3; i++) await new Promise((r) => setTimeout(r, 100));
  const scanned = await movies();
  assert.equal(scanned.count, 3);
  assert.deepEqual(scanned.pathCounts, { [drive(1)]: 1, [drive(2)]: 2 });
  await stop();
});

test('a drive added to the config later joins the existing library', async () => {
  await start(`Movies:movie:${drive(1)},${drive(2)},${drive(3)}`);
  const lib = await movies();
  assert.deepEqual(lib.paths, [drive(1), drive(2), drive(3)]);
  assert.equal((await libraries()).length, 1, 'no duplicate library');
  await stop();
});

test('folders removed in the UI are not re-added on restart', async () => {
  await start(`Movies:movie:${drive(1)},${drive(2)},${drive(3)}`);
  const lib = await movies();
  await call('PATCH', `/api/libraries/${lib.id}`, { paths: [drive(1), drive(2)] });
  await stop();
  await start(`Movies:movie:${drive(1)},${drive(2)},${drive(3)}`);
  assert.deepEqual((await movies()).paths, [drive(1), drive(2)]);
  await stop();
});

test('an offline drive is skipped and attached once it is back', async () => {
  const later = path.join(ROOT, 'drive4', 'Movies');
  await start(`Movies:movie:${drive(1)},${drive(2)},${later}`);
  assert.ok(!(await movies()).paths.includes(later));
  await stop();
  fs.mkdirSync(later, { recursive: true });
  await start(`Movies:movie:${drive(1)},${drive(2)},${later}`);
  assert.ok((await movies()).paths.includes(later));
  await stop();
});

test('a library deleted in the UI stays deleted', async () => {
  await start(`Movies:movie:${drive(1)},${drive(2)}`);
  await call('DELETE', `/api/libraries/${(await movies()).id}`);
  await stop();
  await start(`Movies:movie:${drive(1)},${drive(2)},${drive(3)}`);
  assert.equal(await movies(), undefined);
  await stop();
});
