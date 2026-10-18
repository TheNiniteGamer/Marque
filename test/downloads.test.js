'use strict';
// The video downloader: no duplicates, video details, download hours, retries and "finished" status.
// Uses yt-dlp against a local web server (skipped when yt-dlp isn't installed).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { archiveKey, PERMANENT_ERROR, Downloader } = require('../lib/downloader');
const { clip, startServer, until } = require('./helpers');

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
let hasYtdlp = true;
try { execFileSync(YTDLP, ['--version'], { stdio: 'ignore' }); } catch { hasYtdlp = false; }

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-dl-'));
let flakyHits = 0;
const web = http.createServer((req, res) => {
  const file = path.join(ROOT, 'web', 'clip.mp4');
  if (req.url === '/missing.mp4') { res.writeHead(404); return res.end(); }
  // Fails the first time, works afterwards (like a dropped connection).
  if (req.url === '/flaky.mp4' && flakyHits++ === 0) { res.writeHead(503); return res.end(); }
  if (!/^\/(clip|again|later|flaky)\.mp4$/.test(req.url)) { res.writeHead(404); return res.end(); }
  const data = fs.readFileSync(file);
  res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': data.length });
  res.end(req.method === 'HEAD' ? undefined : data);
});
let srv, admin, lib, base;

test('YouTube links are recognised for the duplicate check', () => {
  assert.equal(archiveKey('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10'), 'youtube dQw4w9WgXcQ');
  assert.equal(archiveKey('https://youtu.be/dQw4w9WgXcQ?si=x'), 'youtube dQw4w9WgXcQ');
  assert.equal(archiveKey('https://m.youtube.com/shorts/dQw4w9WgXcQ'), 'youtube dQw4w9WgXcQ');
  assert.equal(archiveKey('https://music.youtube.com/watch?v=dQw4w9WgXcQ'), 'youtube dQw4w9WgXcQ');
  assert.equal(archiveKey('https://www.youtube.com/playlist?list=PL123'), null);
  assert.equal(archiveKey('https://vimeo.com/123'), null);
});

test('errors that retrying will not fix are recognised', () => {
  for (const e of ['Private video. Sign in if you\'ve been granted access', 'Video unavailable', 'This video has been removed by the uploader',
    'Join this channel to get access to members-only content', 'Unable to download webpage: HTTP Error 404: Not Found']) assert.match(e, PERMANENT_ERROR);
  for (const e of ['Unable to download webpage: HTTP Error 503: Service Unavailable', 'The read operation timed out', 'Connection reset by peer']) assert.doesNotMatch(e, PERMANENT_ERROR);
});

test('download hours work across midnight', () => {
  const d = new Downloader({ data: { settings: { downloads: { windowStart: '23:00', windowEnd: '06:00' } }, downloads: [] }, save() {} });
  const at = (h, m = 0) => new Date(2026, 0, 1, h, m);
  assert.equal(d.inWindow(at(23, 30)), true);
  assert.equal(d.inWindow(at(3)), true);
  assert.equal(d.inWindow(at(6)), false);
  assert.equal(d.inWindow(at(12)), false);
  assert.throws(() => d.updateSettings({ windowStart: '25:00' }), /01:00/);
  assert.throws(() => d.updateSettings({ windowStart: null }), /both/);
  assert.throws(() => d.updateSettings({ rateLimit: -1 }), /MB\/s/);
  assert.deepEqual(d.updateSettings({ windowStart: null, windowEnd: null, rateLimit: 1.5 }), { windowStart: null, windowEnd: null, rateLimit: 1.5, autoUpdate: true });
  assert.equal(d.inWindow(at(12)), true, 'no hours set: any time');
});

test.before(async () => {
  if (!hasYtdlp) return;
  clip(path.join(ROOT, 'web', 'clip.mp4'), 3);
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${web.address().port}`;
  fs.mkdirSync(path.join(ROOT, 'Downloads'));
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), YTDLP_PATH: YTDLP, TVMAZE_DISABLED: '1', WATCH_INTERVAL: '0',
    AUTO_LIBRARIES: `YouTube:movie:${path.join(ROOT, 'Downloads')}` });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  lib = (await admin('GET', '/api/libraries')).data[0];
});
test.after(async () => { await srv?.stop(); web.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const job = async (id) => (await admin('GET', '/api/downloads')).data.jobs.find((j) => j.id === id);
const add = (url, extra = {}) => admin('POST', '/api/downloads', { url, libraryId: lib.id, folder: '', ...extra });

test('a download saves the video details, and the library uses them', { skip: !hasYtdlp && 'yt-dlp not installed' }, async () => {
  const r = await add(`${base}/clip.mp4`);
  assert.equal(r.status, 201);
  const done = await until(async () => { const j = await job(r.data.id); return ['done', 'failed'].includes(j.status) && j; }, 60000);
  assert.equal(done.status, 'done', done.error);
  const info = fs.readdirSync(path.join(ROOT, 'Downloads')).find((f) => f.endsWith('.info.json'));
  assert.ok(info, 'details file written next to the video');
  const details = JSON.parse(fs.readFileSync(path.join(ROOT, 'Downloads', info), 'utf8'));
  assert.equal(details.webpage_url, `${base}/clip.mp4`);

  const item = await until(async () => (await admin('GET', `/api/libraries/${lib.id}/items`)).data.items[0], 20000);
  const d = (await admin('GET', `/api/items/${item.id}`)).data;
  assert.equal(d.title, 'clip');
  assert.equal(d.sourceUrl, `${base}/clip.mp4`);
  assert.equal(d.match.provider, 'video', 'not looked up in movie databases');
  assert.deepEqual(d.chapters, []);

  // The status everyone's browser polls reports it as finished (for the "Downloaded" notice).
  const status = (await admin('GET', '/api/status')).data.myDownloads;
  assert.equal(status.active, 0);
  assert.ok(status.finished.some((j) => j.id === r.data.id && j.status === 'done'));
});

test('the same video is not downloaded twice unless asked', { skip: !hasYtdlp && 'yt-dlp not installed' }, async () => {
  const again = await add(`${base}/clip.mp4`);
  assert.equal(again.status, 409);
  assert.equal(again.data.duplicate, true);
  assert.match(again.data.error, /Already downloaded/);
  assert.match(fs.readFileSync(path.join(ROOT, 'data', 'downloads-archive.txt'), 'utf8'), /^generic clip$/m);

  const forced = await add(`${base}/clip.mp4`, { force: true });
  assert.equal(forced.status, 201);
  const done = await until(async () => { const j = await job(forced.data.id); return ['done', 'failed'].includes(j.status) && j; }, 60000);
  assert.equal(done.status, 'done', done.error);
});

test('download hours hold new downloads until "Start now"', { skip: !hasYtdlp && 'yt-dlp not installed' }, async () => {
  // A window that's closed right now.
  const t = new Date(Date.now() + 3 * 3600_000);
  const hh = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const s = await admin('PATCH', '/api/downloads/settings', { windowStart: hh(t), windowEnd: hh(new Date(t.getTime() + 3600_000)), rateLimit: 50 });
  assert.equal(s.status, 200);
  assert.equal(s.data.inWindow, false);
  const r = await add(`${base}/later.mp4`);
  await new Promise((res) => setTimeout(res, 1500));
  assert.equal((await job(r.data.id)).status, 'queued', 'waits for download hours');
  await admin('POST', `/api/downloads/${r.data.id}/start`);
  const done = await until(async () => { const j = await job(r.data.id); return j.status === 'done' && j; }, 60000);
  assert.equal(done.status, 'done');
  await admin('PATCH', '/api/downloads/settings', { windowStart: null, windowEnd: null, rateLimit: null });
});

test('failures are retried automatically, but not hopeless ones', { skip: !hasYtdlp && 'yt-dlp not installed' }, async () => {
  const missing = await add(`${base}/missing.mp4`);
  const failed = await until(async () => { const j = await job(missing.data.id); return j.status === 'failed' && j; }, 60000);
  assert.equal(failed.attempts, 1, 'a 404 is not retried');

  const flaky = await add(`${base}/flaky.mp4`);
  const waiting = await until(async () => { const j = await job(flaky.data.id); return j.status === 'queued' && j.retryAt && j; }, 60000);
  assert.equal(waiting.attempts, 1);
  assert.ok(waiting.retryAt - Date.now() > 30_000, 'waits a minute before trying again');
  assert.match(waiting.error, /503/);
  await admin('POST', `/api/downloads/${flaky.data.id}/start`); // don't wait the minute in a test
  const done = await until(async () => { const j = await job(flaky.data.id); return j.status === 'done' && j; }, 60000);
  assert.equal(done.attempts, 2);
});
