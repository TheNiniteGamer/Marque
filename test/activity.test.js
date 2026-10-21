'use strict';
// The admin's Activity page: who is watching what, and how it plays.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');
const { deviceName } = require('../lib/activity');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-activity-'));
let srv, admin, bob, film;
test.before(async () => {
  clip(path.join(ROOT, 'Movies', 'Film (2020).mp4'), 240); // long enough that its conversion is still going
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1', AUTO_LIBRARIES: `Movies:movie:${path.join(ROOT, 'Movies')}`, DASHBOARD_KEY: 'wall-key' });
  admin = srv.client(); bob = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  await until(async () => (await admin('GET', '/api/libraries')).data.every((l) => l.scannedAt));
  film = (await admin('GET', `/api/libraries/${(await admin('GET', '/api/libraries')).data[0].id}/items`)).data.items[0];
  await admin('POST', '/api/users', { username: 'bob', password: 'bobpass12' });
  await bob('POST', '/api/auth/login', { username: 'bob', password: 'bobpass12' });
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('device names from browsers and the Android app', () => {
  assert.equal(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0'), 'Edge on Windows');
  assert.equal(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'), 'Safari on iPhone/iPad');
  assert.equal(deviceName('Dalvik/2.1.0 (Linux; U; Android 14; Pixel 8)'), 'Android app');
  assert.equal(deviceName('Roku/DVP-14.0 (14.0.4.5112-46)'), 'Roku');
  assert.equal(deviceName('Mozilla/5.0 (Linux; Android 11; SHIELD Android TV) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 MarqueeAndroid/1.9.0 MarqueeTV'), 'Android TV app');
  assert.equal(deviceName(''), 'Browser');
});

test('a wall dashboard reads a summary with its key, and nothing without it', async () => {
  const get = (url, headers = {}) => fetch(srv.base + url, { headers }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
  assert.equal((await get('/api/dashboard')).status, 401, 'no key');
  assert.equal((await get('/api/dashboard', { 'X-Dashboard-Key': 'guess' })).status, 401, 'wrong key');
  await bob('POST', `/api/items/${film.id}/progress`, { position: 2, paused: false, mode: 'direct', client: 'wall-1' });
  const d = (await get('/api/dashboard', { 'X-Dashboard-Key': 'wall-key' })).data;
  assert.equal(d.watching, 1);
  assert.deepEqual(d.streams.map((s) => [s.user, s.title, s.how]), [['bob', 'Film', 'Playing as it is']]);
  assert.equal(d.libraries.Movies, 1);
  assert.equal(typeof d.overnight.state, 'string');
  assert.equal(d.requests, 0);
  assert.equal((await get('/api/dashboard?key=wall-key')).status, 200, 'or as ?key=');
  await bob('POST', `/api/items/${film.id}/progress`, { position: 2, stopped: true, client: 'wall-1' });

  const off = await startServer({ DATA_DIR: path.join(ROOT, 'data-nokey'), TVMAZE_DISABLED: '1' });
  try {
    assert.equal((await fetch(`${off.base}/api/dashboard?key=`).then((r) => r.status)), 404, 'off unless DASHBOARD_KEY is set');
  } finally { await off.stop(); }
});

test('players show up while playing or paused, and disappear when they stop', async () => {
  assert.deepEqual((await admin('GET', '/api/activity')).data.streams, []);
  assert.equal((await bob('GET', '/api/activity')).status, 403, 'admins only');

  await bob('POST', `/api/items/${film.id}/progress`, { position: 2, paused: false, mode: 'direct', client: 'tab-1' });
  let a = (await admin('GET', '/api/activity')).data;
  assert.equal(a.streams.length, 1);
  const s = a.streams[0];
  assert.deepEqual([s.user, s.itemId, s.position, s.paused, s.mode, s.item.title, s.remote], ['bob', film.id, 2, false, 'direct', 'Film', false]);
  assert.ok(a.cpu.cores > 0 && a.cpu.percent >= 0 && a.cpu.percent <= 100);
  assert.equal(a.encoder.active, 'software');

  // Paused: still listed, and the resume point isn't rewritten by the heartbeat.
  await bob('POST', `/api/items/${film.id}/progress`, { position: 2.2, paused: true, mode: 'direct', client: 'tab-1' });
  a = (await admin('GET', '/api/activity')).data;
  assert.equal(a.streams[0].paused, true);
  assert.equal(a.streams[0].startedAt, s.startedAt, 'same session');
  assert.equal((await bob('GET', `/api/items/${film.id}`)).data.progress.position, 2);

  // A second device is a second session; closing the player removes it.
  await admin('POST', `/api/items/${film.id}/progress`, { position: 1, mode: 'hls', quality: '720p', client: 'tv' });
  assert.equal((await admin('GET', '/api/activity')).data.streams.length, 2);
  await bob('POST', `/api/items/${film.id}/progress`, { position: 3, stopped: true, client: 'tab-1' });
  assert.deepEqual((await admin('GET', '/api/activity')).data.streams.map((x) => x.user), ['admin']);
});

test('a running conversion is matched to its viewer', async () => {
  const pb = (await bob('GET', `/api/items/${film.id}/playback`)).data;
  const seg = await fetch(`${srv.base}/api/items/${film.id}/hls/360p/seg-0.ts?sid=act-test-1&mt=${pb.token}`);
  assert.equal(seg.status, 200);
  await seg.arrayBuffer();
  await bob('POST', `/api/items/${film.id}/progress`, { position: 1, mode: 'hls', quality: 'auto', client: 'tab-2' });
  const a = (await admin('GET', '/api/activity')).data;
  const mine = a.streams.find((x) => x.user === 'bob');
  assert.deepEqual([mine.conversion.kind, mine.conversion.quality, mine.conversion.encoder], ['hls', '360p', 'software']);
  assert.ok(!a.others.some((o) => o.userId === mine.userId && o.itemId === film.id), 'not listed twice');
});

test('an admin can stop someone’s video; the last day is listed', async () => {
  await bob('POST', `/api/items/${film.id}/progress`, { position: 90, paused: false, mode: 'transcode', client: 'tab-2' });
  let a = (await admin('GET', '/api/activity')).data;
  const s = a.streams.find((x) => x.user === 'bob');
  assert.ok(s.why === null || typeof s.why === 'string');
  assert.ok(a.optimize && a.optimize.settings, 'overnight conversions shown too');
  assert.ok(a.recent.some((r) => r.user === 'bob' && r.item.id === film.id), 'in the last 24 hours');
  assert.equal((await bob('POST', '/api/activity/stop', { key: s.key })).status, 403, 'admins only');
  assert.equal((await admin('POST', '/api/activity/stop', { key: s.key })).status, 200);
  assert.equal((await admin('GET', '/api/activity')).data.streams.find((x) => x.user === 'bob').stopping, true);
  // Bob's player hears it on its next report, playing or paused.
  const r = (await bob('POST', `/api/items/${film.id}/progress`, { position: 92, paused: true, mode: 'transcode', client: 'tab-2' })).data;
  assert.deepEqual([r.stop.reason, r.stop.message], ['admin', 'admin stopped this from the Activity page.']);
  await bob('POST', `/api/items/${film.id}/progress`, { position: 92, stopped: true, client: 'tab-2' });
  assert.equal((await admin('POST', '/api/activity/stop', { key: s.key })).status, 404, 'gone once stopped');
});
