'use strict';
// Copies for watching offline on a phone: made in the background as ordinary MP4s.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Offline, sizesFor } = require('../lib/offline');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-offline-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('the sizes on offer stop at the video\'s own', () => {
  assert.deepEqual(sizesFor({ duration: 60, media: { video: { width: 1920, height: 1080 } } }).map((s) => s.id), ['1080p', '720p', '480p']);
  assert.deepEqual(sizesFor({ duration: 60, media: { video: { width: 1280, height: 720 } } }).map((s) => s.id), ['720p', '480p']);
  assert.deepEqual(sizesFor({ duration: 60, media: { video: { width: 640, height: 360 } } }).map((s) => s.id), ['480p'], 'always one');
  const [s] = sizesFor({ duration: 100, media: { video: { width: 640, height: 360 }, bitrate: 400_000 } });
  assert.equal(s.size, Math.round(((400_000 * 1.1 + 160_000) / 8) * 100), 'small sources stay small');
});

test('a copy is made once, in the background, and is a phone-friendly MP4', async () => {
  const file = path.join(ROOT, 'film.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:d=4', '-f', 'lavfi', '-i', 'sine=d=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', file]);
  const item = { id: 'abc123', file, mtime: 1, duration: 4, media: { video: { width: 640, height: 360 }, audio: [{ codec: 'opus' }], bitrate: 500_000 } };
  const off = new Offline(path.join(ROOT, 'offline'), null);
  assert.throws(() => off.request(item, { quality: '4k' }), /Unknown size/);
  assert.throws(() => off.request(item, { quality: '480p', audio: 3 }), /sound track/);
  assert.equal(off.status(item, { quality: '480p' }).status, 'none');
  assert.throws(() => off.path(item, { quality: '480p' }), /Not ready/);
  const first = off.request(item, { quality: '480p' });
  assert.equal(first.status, 'converting');
  assert.equal(off.request(item, { quality: '480p' }).status, 'converting', 'asked twice, made once');
  for (let i = 0; i < 100 && off.status(item, { quality: '480p' }).status !== 'ready'; i++) await new Promise((r) => setTimeout(r, 200));
  const done = off.status(item, { quality: '480p' });
  assert.equal(done.status, 'ready');
  const out = off.path(item, { quality: '480p' });
  assert.equal(fs.statSync(out).size, done.size);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', out]));
  assert.deepEqual(probe.streams.map((s) => s.codec_name), ['h264', 'aac']);
  assert.match(probe.format.format_name, /mp4/);
  const bytes = fs.readFileSync(out);
  assert.ok(bytes.indexOf('moov') < bytes.indexOf('mdat'), 'the index first, so it plays and seeks straight away');
  // Changed file: a new copy is needed.
  assert.equal(off.status({ ...item, mtime: 2 }, { quality: '480p' }).status, 'none');
});

test('copies wait while someone is watching, and a copy under way pauses', async () => {
  const file = path.join(ROOT, 'show.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:d=20', '-f', 'lavfi', '-i', 'sine=d=20',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  const item = { id: 'def456', file, mtime: 1, duration: 20, media: { video: { width: 640, height: 360 }, audio: [{ codec: 'aac' }], bitrate: 500_000 } };
  let busy = true;
  const off = new Offline(path.join(ROOT, 'offline2'), null, { isBusy: () => busy });
  const q = { quality: '480p' };
  assert.deepEqual(off.request(item, q), { status: 'queued', progress: 0, waiting: true }, 'not started while someone watches');
  busy = false;
  off.yieldToViewers();
  assert.equal(off.status(item, q).status, 'converting');
  if (process.platform !== 'win32') {
    busy = true;
    off.yieldToViewers();
    assert.equal(off.status(item, q).waiting, true, 'paused');
    const before = off.status(item, q).progress;
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(off.status(item, q).progress, before, 'no progress while paused');
    busy = false;
    off.yieldToViewers();
  }
  for (let i = 0; i < 150 && off.status(item, q).status !== 'ready'; i++) await new Promise((r) => setTimeout(r, 200));
  assert.equal(off.status(item, q).status, 'ready');
});
