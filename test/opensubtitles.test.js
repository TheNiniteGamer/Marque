'use strict';
// Subtitle search and download, against a local mock of the OpenSubtitles.com API.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileHash } = require('../lib/opensubtitles');
const { clip, startServer, until } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-os-'));
const SRT = '1\n00:00:01,000 --> 00:00:02,000\nHola\n';
const seen = [];
let downloadsLeft = 5;
const mock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), key: req.headers['api-key'], auth: req.headers.authorization || null, ua: req.headers['user-agent'] });
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/file.srt') { res.writeHead(200); return res.end(SRT); }
  if (req.headers['api-key'] !== 'good-key') return send(403, { message: 'You cannot consume this service' });
  if (url.pathname === '/api/v1/infos/formats') return send(200, { data: { output_formats: ['srt'] } });
  if (url.pathname === '/api/v1/login') {
    let body = ''; req.on('data', (c) => { body += c; });
    return req.on('end', () => (JSON.parse(body).password === 'pw' ? send(200, { token: 'tok123', base_url: null }) : send(401, { message: 'Invalid username/password' })));
  }
  if (url.pathname === '/api/v1/subtitles') {
    return send(200, { data: [
      { attributes: { language: 'es', release: 'Other.Release', download_count: 900, files: [{ file_id: 11 }] } },
      { attributes: { language: 'es', release: 'Exact.Match', download_count: 5, moviehash_match: true, files: [{ file_id: 22 }] } },
      { attributes: { language: 'es', release: 'No files', files: [] } },
    ] });
  }
  if (url.pathname === '/api/v1/download' && req.method === 'POST') return send(200, { link: `http://127.0.0.1:${mock.address().port}/file.srt`, remaining: --downloadsLeft });
  send(404, { message: 'not found' });
});

let srv, admin, viewer, movie;
test.before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  clip(path.join(ROOT, 'Movies', 'Film (2020).mp4'), 30); // big enough to hash (128 KiB+)
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1', OPENSUBTITLES_API_BASE: `http://127.0.0.1:${mock.address().port}/api/v1`,
    AUTO_LIBRARIES: `Movies:movie:${path.join(ROOT, 'Movies')}` });
  admin = srv.client();
  viewer = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  await until(async () => (await admin('GET', '/api/libraries')).data.every((l) => l.scannedAt));
  const lib = (await admin('GET', '/api/libraries')).data[0];
  movie = (await admin('GET', `/api/libraries/${lib.id}/items`)).data.items[0];
  await admin('POST', '/api/users', { username: 'viewer', password: 'viewerpw1' });
  await viewer('POST', '/api/auth/login', { username: 'viewer', password: 'viewerpw1' });
});
test.after(async () => { await srv?.stop(); mock.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('file hash follows the OpenSubtitles definition (little-endian 64-bit words)', async () => {
  const f = path.join(ROOT, 'hash.bin');
  const buf = Buffer.alloc(200_000);
  for (let i = 0; i < buf.length; i += 8) buf[i] = 1; // every 64-bit LE word = 1
  fs.writeFileSync(f, buf);
  // size + 8192 words in each of the two 64 KiB chunks
  assert.equal(await fileHash(f), (200_000 + 16_384).toString(16).padStart(16, '0'));
  fs.writeFileSync(f, Buffer.alloc(1000));
  assert.equal(await fileHash(f), null, 'too small to hash');
});

test('without an API key, searching explains what to do', async () => {
  assert.equal((await viewer('GET', '/api/status')).data.subtitleSearch, false);
  const r = await viewer('GET', `/api/items/${movie.id}/subtitle-search?lang=es`);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /API key/);
});

test('admin settings are checked before saving', async () => {
  assert.equal((await admin('PATCH', '/api/settings', { opensubtitles: { apiKey: 'bad-key' } })).status, 400);
  assert.equal((await admin('GET', '/api/settings')).data.opensubtitles.keySet, false);
  assert.equal((await admin('PATCH', '/api/settings', { opensubtitles: { apiKey: 'good-key', username: 'me', password: 'nope' } })).status, 400, 'wrong password is rejected');
  const ok = await admin('PATCH', '/api/settings', { opensubtitles: { apiKey: 'good-key', username: 'me', password: 'pw' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.opensubtitles, { keySet: true, keyHint: '••••-key', username: 'me' });
  assert.equal((await viewer('PATCH', '/api/settings', { opensubtitles: { apiKey: '' } })).status, 403);
});

test('any user can search and download; best matches first', async () => {
  assert.equal((await viewer('GET', '/api/status')).data.subtitleSearch, true);
  const r = (await viewer('GET', `/api/items/${movie.id}/subtitle-search?lang=ES,xx-bad-`)).data;
  assert.deepEqual(r.results.map((x) => [x.fileId, x.hashMatch]), [[22, true], [11, false]]);
  const q = seen.find((s) => s.path === '/api/v1/subtitles');
  assert.equal(q.query.languages, 'es');
  assert.equal(q.query.query, 'film');
  assert.equal(q.query.year, '2020');
  assert.match(q.query.moviehash, /^[0-9a-f]{16}$/);
  assert.match(q.ua, /^Marquee v/);

  const d = (await viewer('POST', `/api/items/${movie.id}/subtitle-download`, { fileId: 22, language: 'es', release: 'Exact.Match' })).data;
  assert.equal(d.added, 'dl0');
  assert.equal(d.remaining, 4);
  assert.deepEqual(d.subtitles.map((s) => [s.id, s.label]), [['dl0', 'Spanish (OpenSubtitles)']]);
  assert.equal(seen.find((s) => s.path === '/api/v1/download').auth, 'Bearer tok123', 'signed in for a higher limit');
  const vtt = (await viewer('GET', `/api/items/${movie.id}/subtitles/dl0`)).data.toString();
  assert.match(vtt, /^WEBVTT/);
  assert.match(vtt, /00:00:01\.000 --> 00:00:02\.000\nHola/);

  assert.equal((await viewer('DELETE', `/api/items/${movie.id}/subtitles/dl0`)).status, 403, 'only admins remove them');
  assert.equal((await admin('DELETE', `/api/items/${movie.id}/subtitles/dl0`)).data.subtitles.length, 0);
});
