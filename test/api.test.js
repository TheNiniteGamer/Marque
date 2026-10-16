'use strict';
// Integration tests: boots a real server on temporary media and talks to it over HTTP.
// Needs ffmpeg; the download test also needs yt-dlp (set YTDLP_PATH or have it on PATH).

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-test-'));
const PORT = 40000 + Math.floor(Math.random() * 10000);
const BASE = `http://127.0.0.1:${PORT}`;
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
let hasYtdlp = true;
try { execFileSync(YTDLP, ['--version'], { stdio: 'ignore' }); } catch { hasYtdlp = false; }

function clip(file, seconds = 2) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=24:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=duration=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
}

// Minimal cookie-aware client.
function client() {
  let cookie = '';
  return async function call(method, url, body) {
    const res = await fetch(BASE + url, {
      method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
}

async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 200));
  }
}

let server;
const admin = client();
const bob = client();
const anon = client();
const ids = {};

test.before(async () => {
  clip(path.join(ROOT, 'Movies', 'Test Clip (2020).mp4'));
  clip(path.join(ROOT, 'TV', 'Some Show', 'Season 01', 'Some Show - S01E01.mp4'));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: path.join(ROOT, 'data'), SCAN_INTERVAL: '0',
      YTDLP_PATH: YTDLP, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', TMDB_API_KEY: '', TMDB_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.env.DEBUG && process.stderr.write(d));
  await until(() => fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false));
});

test.after(() => {
  server?.kill();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('fresh server requires setup and rejects anonymous requests', async () => {
  const me = await anon('GET', '/api/auth/me');
  assert.equal(me.status, 401);
  assert.equal(me.data.setupRequired, true);
  assert.equal((await anon('GET', '/api/home')).status, 401);
});

test('setup creates the admin once, then login is required', async () => {
  assert.equal((await admin('POST', '/api/auth/setup', { username: 'Admin', password: 'short' })).status, 400);
  const r = await admin('POST', '/api/auth/setup', { username: 'Admin', password: 'correct horse' });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.role, 'admin');
  assert.equal((await anon('POST', '/api/auth/setup', { username: 'x', password: 'whatever1' })).status, 409);
  assert.equal((await anon('POST', '/api/auth/login', { username: 'admin', password: 'nope-nope' })).status, 401);
  assert.equal((await admin('GET', '/api/auth/me')).data.user.username, 'Admin');
});

test('admin creates libraries and they get scanned', async () => {
  const movies = await admin('POST', '/api/libraries', { name: 'Movies', type: 'movie', paths: [path.join(ROOT, 'Movies')] });
  const tv = await admin('POST', '/api/libraries', { name: 'TV', type: 'show', paths: [path.join(ROOT, 'TV')] });
  assert.equal(movies.status, 201);
  ids.movies = movies.data.id;
  ids.tv = tv.data.id;
  await until(async () => (await admin('GET', '/api/libraries')).data.every((l) => l.count === 1));
  ids.movie = (await admin('GET', `/api/libraries/${ids.movies}/items`)).data.items[0].id;
  ids.show = (await admin('GET', `/api/libraries/${ids.tv}/items`)).data.items[0].id;
});

test('a restricted user only sees shared libraries and cannot use admin features', async () => {
  const created = await admin('POST', '/api/users', { username: 'bob', password: 'bobspassword', libraries: [ids.movies] });
  assert.equal(created.status, 201);
  ids.bob = created.data.id;
  assert.equal((await admin('POST', '/api/users', { username: 'BOB', password: 'another1' })).status, 400, 'usernames are case-insensitive unique');
  assert.equal((await bob('POST', '/api/auth/login', { username: 'Bob', password: 'bobspassword' })).status, 200);

  const libs = (await bob('GET', '/api/libraries')).data;
  assert.deepEqual(libs.map((l) => l.name), ['Movies']);
  assert.equal(libs[0].paths, undefined, 'folder paths are hidden from non-admins');
  assert.equal((await bob('GET', `/api/shows/${ids.show}`)).status, 404);
  assert.equal((await bob('GET', `/api/libraries/${ids.tv}/items`)).status, 404);
  assert.equal((await bob('GET', `/api/art/poster/${ids.show}`)).status, 404);
  const s = await bob('GET', `/api/items/${ids.movie}`);
  assert.equal(s.status, 200);
  assert.equal(s.data.file, null);
  for (const [m, u] of [['GET', '/api/users'], ['GET', '/api/fs'], ['POST', '/api/scan'], ['GET', '/api/downloads'], ['DELETE', `/api/libraries/${ids.movies}`]]) {
    assert.equal((await bob(m, u)).status, 403, `${m} ${u}`);
  }
});

test('watch progress is separate per user', async () => {
  await bob('POST', `/api/items/${ids.movie}/progress`, { position: 0.5 });
  assert.equal((await bob('GET', `/api/items/${ids.movie}`)).data.progress.position, 0.5);
  assert.equal((await admin('GET', `/api/items/${ids.movie}`)).data.progress, null);
  await admin('POST', `/api/items/${ids.movie}/watched`, { watched: true });
  assert.equal((await bob('GET', `/api/items/${ids.movie}`)).data.progress.watched, false);
});

test('changing access and permissions takes effect immediately', async () => {
  await admin('PATCH', `/api/users/${ids.bob}`, { libraries: null, canDownload: true });
  assert.equal((await bob('GET', '/api/libraries')).data.length, 2);
  assert.equal((await bob('GET', '/api/downloads')).status, 200);
});

test('guards: no self-delete, no removing the last admin', async () => {
  const me = (await admin('GET', '/api/auth/me')).data.user;
  assert.equal((await admin('DELETE', `/api/users/${me.id}`)).status, 400);
  assert.equal((await admin('PATCH', `/api/users/${me.id}`, { role: 'user' })).status, 400);
});

test('password change signs out other sessions', async () => {
  const bob2 = client();
  await bob2('POST', '/api/auth/login', { username: 'bob', password: 'bobspassword' });
  assert.equal((await bob('POST', '/api/auth/password', { currentPassword: 'wrong', newPassword: 'newpassword' })).status, 400);
  assert.equal((await bob('POST', '/api/auth/password', { currentPassword: 'bobspassword', newPassword: 'newpassword' })).status, 200);
  assert.equal((await bob('GET', '/api/home')).status, 200, 'current session survives');
  assert.equal((await bob2('GET', '/api/home')).status, 401, 'other session is ended');
  await bob('POST', '/api/auth/logout');
  assert.equal((await bob('GET', '/api/home')).status, 401);
});

test('downloads reject bad input', async () => {
  assert.equal((await admin('POST', '/api/downloads', { url: 'not a url', libraryId: ids.movies })).status, 400);
  assert.equal((await admin('POST', '/api/downloads', { url: 'file:///etc/passwd', libraryId: ids.movies })).status, 400);
  assert.equal((await admin('POST', '/api/downloads', { url: 'https://example.com/v', libraryId: ids.tv })).status, 400, 'show libraries are not targets');
  assert.equal((await admin('POST', '/api/downloads', { url: 'https://example.com/v', libraryId: ids.movies, folder: '../../etc' })).status, 400);
});

test('download a video with yt-dlp into a library', { skip: !hasYtdlp && 'yt-dlp not installed' }, async () => {
  const src = path.join(ROOT, 'remote', 'Downloaded Clip.mp4');
  clip(src, 3);
  const remote = http.createServer((req, res) => {
    const st = fs.statSync(src);
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': st.size });
    fs.createReadStream(src).pipe(res);
  });
  await new Promise((r) => remote.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${remote.address().port}/downloaded-clip.mp4`;
    const job = await admin('POST', '/api/downloads', { url, libraryId: ids.movies, folder: 'YouTube' });
    assert.equal(job.status, 201);
    const done = await until(async () => {
      const j = (await admin('GET', '/api/downloads')).data.jobs.find((x) => x.id === job.data.id);
      return ['done', 'failed'].includes(j.status) && j;
    }, 60000);
    assert.equal(done.status, 'done', done.error);
    assert.equal(done.files.length, 1);
    assert.ok(fs.existsSync(path.join(ROOT, 'Movies', 'YouTube', done.files[0])));
    assert.equal(done.files[0], 'downloaded-clip [downloaded-clip].mp4', 'no empty "()" when there is no upload date');
    // The finished download is picked up by a rescan, with a clean title.
    const items = await until(async () => {
      const list = (await admin('GET', `/api/libraries/${ids.movies}/items`)).data.items;
      return list.length === 2 && list;
    });
    assert.ok(items.some((i) => i.title === 'downloaded-clip'));
  } finally {
    remote.close();
  }
});
