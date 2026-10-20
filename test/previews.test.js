'use strict';
// Preview clips (hovering over a title) and admins seeing where files are.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, until } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-previews-'));
const video = (file, seconds) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=24:d=${seconds}`, '-f', 'lavfi', '-i', `sine=d=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
};
let srv, admin, user, movie, show;
test.before(async () => {
  video(path.join(ROOT, 'Movies', 'Heat (1995)', 'Heat (1995).mkv'), 50);
  video(path.join(ROOT, 'TV', 'Bluey', 'Season 1', 'Bluey - S01E01.mp4'), 40);
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1', AUTO_LIBRARIES: `Movies:movie:${path.join(ROOT, 'Movies')};TV:show:${path.join(ROOT, 'TV')}` });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  await until(async () => (await admin('GET', '/api/libraries')).data.every((l) => l.scannedAt));
  const libs = (await admin('GET', '/api/libraries')).data;
  movie = (await admin('GET', `/api/libraries/${libs.find((l) => l.type === 'movie').id}/items`)).data.items[0];
  show = (await admin('GET', `/api/libraries/${libs.find((l) => l.type === 'show').id}/items`)).data.items[0];
  await admin('POST', '/api/users', { username: 'sam', password: 'sampass11' });
  user = srv.client();
  await user('POST', '/api/auth/login', { username: 'sam', password: 'sampass11' });
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('a preview clip is made the first time it’s wanted, then plays', async () => {
  assert.equal((await user('GET', '/api/status')).data.previewClips, true);
  assert.equal((await fetch(`${srv.base}/api/previews/${movie.id}`)).status, 401, 'needs a sign-in');
  for (const id of [movie.id, show.id]) {
    assert.equal((await user('GET', `/api/previews/${id}`)).status, 404, 'not made yet: asking starts it');
    await until(async () => (await user('GET', `/api/previews/${id}`)).status === 200, 30000);
  }
  const r = await user('GET', `/api/previews/${movie.id}`);
  assert.ok(r.data.length > 10_000, 'a video');
  const clip = path.join(ROOT, 'data', 'previews', fs.readdirSync(path.join(ROOT, 'data', 'previews')).find((f) => f.startsWith(`${movie.id}-`)));
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', clip]));
  assert.deepEqual(probe.streams.map((s) => s.codec_name), ['h264', 'aac']);
  assert.equal(probe.streams[0].height, 480, 'made small');
  assert.ok(Math.abs(Number(probe.format.duration) - 30) < 1.5, '30 seconds');
  assert.equal((await user('GET', '/api/previews/nope')).status, 404);
});

test('turning previews off removes the clips', async () => {
  await admin('PATCH', '/api/settings', { previewClips: false });
  assert.equal((await user('GET', '/api/status')).data.previewClips, false);
  await until(async () => fs.readdirSync(path.join(ROOT, 'data', 'previews')).length === 0);
  assert.equal((await user('GET', `/api/previews/${movie.id}`)).status, 404);
  await admin('PATCH', '/api/settings', { previewClips: true });
});

test('admins see where a film’s and a show’s files are; others don’t', async () => {
  const m = (await admin('GET', `/api/items/${movie.id}`)).data;
  assert.equal(m.file, path.join(ROOT, 'Movies', 'Heat (1995)', 'Heat (1995).mkv'));
  assert.equal((await user('GET', `/api/items/${movie.id}`)).data.file, null);
  const s = (await admin('GET', `/api/shows/${show.id}`)).data.files;
  assert.equal(s.folder, path.join(ROOT, 'TV', 'Bluey'));
  assert.equal(s.episodes[0].file, path.join(ROOT, 'TV', 'Bluey', 'Season 1', 'Bluey - S01E01.mp4'));
  assert.match(s.episodes[0].video, /H264 1280×720/);
  assert.equal((await user('GET', `/api/shows/${show.id}`)).data.files, undefined);
});
