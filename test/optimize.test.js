'use strict';
// Overnight conversions: a DVD-style file (MPEG-2, interlaced, non-square pixels) gets an H.264 MP4
// copy that's offered as another version; watching the copy counts for the original; files the
// TVs already play are left alone; the copies can be removed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');
const { kindOf } = require('../lib/optimize');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-optimize-'));
const OUT = path.join(ROOT, 'copies');
let srv, admin, dvd, ep, plain;

const dvdClip = (file) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=720x480:rate=30000/1001:duration=3', '-f', 'lavfi', '-i', 'sine=d=3',
    '-vf', 'tinterlace=interleave_top,fieldorder=tff', '-pix_fmt', 'yuv420p', '-c:v', 'mpeg2video', '-b:v', '4M', '-flags', '+ilme+ildct', '-top', '1',
    '-aspect', '16:9', '-c:a', 'ac3', file]);
};

test.before(async () => {
  dvdClip(path.join(ROOT, 'Movies', 'Old Film (1999)', 'Old Film (1999).mkv'));
  dvdClip(path.join(ROOT, 'TV', 'Old Show', 'Season 1', 'Old Show S01E01.mkv'));
  clip(path.join(ROOT, 'Movies', 'New Film (2020)', 'New Film (2020).mp4'), 2);
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), OPTIMIZED_DIR: OUT, TVMAZE_DISABLED: '1',
    AUTO_LIBRARIES: `Movies:movie:${path.join(ROOT, 'Movies')};TV:show:${path.join(ROOT, 'TV')}` });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'dad', password: 'password1' });
  await until(async () => (await admin('GET', '/api/libraries')).data.every((l) => l.scannedAt));
  const find = async (q) => (await admin('GET', `/api/search?q=${encodeURIComponent(q)}`)).data;
  dvd = (await find('Old Film')).movies[0];
  plain = (await find('New Film')).movies[0];
  const show = (await find('Old Show')).shows[0];
  ep = (await admin('GET', `/api/shows/${show.id}`)).data.seasons[0].episodes[0];
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('which files get a copy', () => {
  assert.equal(kindOf({ file: 'a.mkv', media: { video: { codec: 'mpeg2video', width: 720, height: 480, fieldOrder: 'tt' }, audio: [{ codec: 'ac3' }] } }), 'dvd');
  assert.equal(kindOf({ file: 'a.mkv', media: { video: { codec: 'hevc', width: 3840, height: 2160 }, audio: [{ codec: 'eac3' }] } }), 'uhd');
  assert.equal(kindOf({ file: 'a.mkv', media: { video: { codec: 'hevc', width: 1920, height: 1080 }, audio: [{ codec: 'aac' }] } }), 'hevc');
  assert.equal(kindOf({ file: 'a.mp4', media: { video: { codec: 'h264', width: 1920, height: 1080, pixFmt: 'yuv420p', profile: 'High' }, audio: [{ codec: 'aac' }] } }), null, 'plays as it is');
  assert.equal(kindOf({ file: 'a.mkv', media: { video: { codec: 'h264', width: 1920, height: 1080, pixFmt: 'yuv420p', profile: 'High' }, audio: [{ codec: 'dts' }] } }), 'other');
});

test('a DVD rip gets a copy overnight (or with Start now), offered as another version', async () => {
  let o = (await admin('GET', '/api/optimize')).data;
  assert.equal(o.state, 'off');
  assert.equal(o.counts.dvd, 2, 'the film and the episode');
  assert.equal((await admin('PATCH', '/api/optimize', { enabled: true, start: '25:00' })).status, 400);
  o = (await admin('PATCH', '/api/optimize', { enabled: true, kinds: { dvd: true } })).data;
  assert.equal(o.queue, 2);
  await admin('POST', '/api/optimize/start-now');
  await until(async () => (await admin('GET', '/api/optimize')).data.counts.done === 2, 120_000);
  o = (await admin('GET', '/api/optimize')).data;
  assert.equal(o.state, 'done');
  assert.ok(o.used > 0);
  assert.equal(fs.readdirSync(OUT).length, 2, 'in the folder set for copies');

  const film = (await admin('GET', `/api/items/${dvd.id}`)).data;
  assert.equal(film.versions.length, 2);
  const copy = film.versions.find((v) => v.id === `${dvd.id}~o`);
  assert.equal(copy.label, 'Converted SD');
  assert.deepEqual([copy.videoCodec, copy.audioCodec, copy.directPlay], ['h264', 'aac', true]);
  assert.equal(copy.width, 854, 'square pixels at 16:9');
  assert.equal(film.versions.find((v) => v.id === dvd.id).directPlay, false);
  // Episodes get the choice too.
  assert.deepEqual((await admin('GET', `/api/items/${ep.id}`)).data.versions.map((v) => v.id), [ep.id, `${ep.id}~o`]);
  assert.equal((await admin('GET', `/api/items/${plain.id}`)).data.versions, null, 'a file the TVs play as it is gets no copy');
});

test('the copy plays as it is, and watching it counts for the original', async () => {
  const id = `${dvd.id}~o`;
  const c = (await admin('GET', `/api/items/${id}`)).data;
  assert.equal(c.versionOf, dvd.id);
  assert.equal(c.directPlay, true);
  assert.equal(c.title, dvd.title);
  const r = await fetch(`${srv.base}/api/items/${id}/stream`, { headers: { range: 'bytes=0-99', cookie: admin.cookie?.() || '' } });
  const pb = (await admin('GET', `/api/items/${id}/playback`)).data;
  const s = await fetch(`${srv.base}/api/items/${id}/stream?mt=${pb.token}`, { headers: { range: 'bytes=0-99' } });
  assert.equal(s.status, 206, `stream (${r.status})`);
  await admin('POST', `/api/items/${id}/progress`, { position: 1.5 });
  assert.equal((await admin('GET', `/api/items/${dvd.id}`)).data.progress.position, 1.5);
  assert.equal((await admin('GET', `/api/items/${dvd.id}~x`)).status, 404);
  assert.equal((await admin('GET', `/api/items/${plain.id}~o`)).status, 404);
});

test('removing the copies', async () => {
  const o = (await admin('DELETE', '/api/optimize')).data;
  assert.equal(o.counts.done, 0);
  assert.deepEqual(fs.readdirSync(OUT), []);
  assert.equal((await admin('GET', `/api/items/${dvd.id}`)).data.versions, null);
  await admin('PATCH', '/api/optimize', { enabled: false });
  assert.equal((await srv.client()('GET', '/api/optimize')).status, 401);
});
