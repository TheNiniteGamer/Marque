'use strict';
// Cache clean-up: files for videos that are gone or replaced are removed, everything in use stays.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Maintenance } = require('../lib/maintenance');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-maint-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const put = (rel, content = 'x', old = true) => {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  if (old) { const t = new Date(Date.now() - 2 * 3600_000); fs.utimesSync(p, t, t); }
  return p;
};
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

test('removes caches for gone or replaced videos and keeps the rest', () => {
  const poster = put('images/aaaaaaaaaaaa-poster.jpg');
  const upload = put('images/custom/my-upload.png');
  put('images/bbbbbbbbbbbb-poster.jpg');            // its title was deleted
  put('images/cccccccccccc-still.jpg', 'x', false); // brand new: maybe still downloading
  put('thumbs/aaaaaaaaaaaa.jpg'); put('thumbs/dddddddddddd.jpg');
  put('trickplay/aaaaaaaaaaaa-1000/sheet-1.jpg'); put('trickplay/aaaaaaaaaaaa-900/sheet-1.jpg'); put('trickplay/eeeeeeeeeeee-5.tmp/sheet-1.jpg');
  put('subs/aaaaaaaaaaaa-0-1000.vtt'); put('subs/aaaaaaaaaaaa-0-900.vtt');
  put('subs-downloaded/aaaaaaaaaaaa-11.srt'); put('subs-downloaded/aaaaaaaaaaaa-22.srt');
  put('fingerprints/aaaaaaaaaaaa-1000.fp'); put('fingerprints/aaaaaaaaaaaa-1000-end.fp'); put('fingerprints/ffffffffffff-1-end.fp');
  const store = { data: {
    items: { aaaaaaaaaaaa: { id: 'aaaaaaaaaaaa', mtime: 1000, meta: { poster }, edits: { backdrop: upload }, downloadedSubs: [{ file: 'aaaaaaaaaaaa-11.srt' }] } },
    shows: {},
  } };
  const m = new Maintenance(store, ROOT, { transcodeDir: path.join(ROOT, 'transcode') });
  const r = m.cleanup();
  assert.equal(r.files, 6);
  for (const kept of ['images/aaaaaaaaaaaa-poster.jpg', 'images/custom/my-upload.png', 'images/cccccccccccc-still.jpg', 'thumbs/aaaaaaaaaaaa.jpg',
    'trickplay/aaaaaaaaaaaa-1000', 'trickplay/eeeeeeeeeeee-5.tmp', 'subs/aaaaaaaaaaaa-0-1000.vtt', 'subs-downloaded/aaaaaaaaaaaa-11.srt',
    'fingerprints/aaaaaaaaaaaa-1000.fp', 'fingerprints/aaaaaaaaaaaa-1000-end.fp']) assert.ok(exists(kept), `kept ${kept}`);
  for (const gone of ['images/bbbbbbbbbbbb-poster.jpg', 'thumbs/dddddddddddd.jpg', 'trickplay/aaaaaaaaaaaa-900', 'subs/aaaaaaaaaaaa-0-900.vtt',
    'subs-downloaded/aaaaaaaaaaaa-22.srt', 'fingerprints/ffffffffffff-1-end.fp']) assert.ok(!exists(gone), `removed ${gone}`);
  assert.ok(m.sizes().sizes.artwork > 0);
});

test('does nothing when the database has no titles (e.g. it was just lost)', () => {
  put('thumbs/zzzzzzzzzzzz.jpg');
  const m = new Maintenance({ data: { items: {}, shows: {} } }, ROOT, { transcodeDir: path.join(ROOT, 'transcode') });
  assert.deepEqual(m.cleanup(), { files: 0, bytes: 0 });
  assert.ok(exists('thumbs/zzzzzzzzzzzz.jpg'));
});

test('logs keep recent problems with a plain-language hint', async () => {
  const { hintFor } = require('../lib/logs');
  assert.match(hintFor('[scan] ffprobe failed: Invalid data: /media/movies/x.mkv'), /couldn't be read/);
  assert.match(hintFor('[scan] Movies: path not found, skipping: E:/Movies'), /drive plugged in/);
  assert.match(hintFor("Error: EACCES: permission denied, open '/media/youtube/a.mp4'"), /allowed to read or write/);
  assert.equal(hintFor('something unusual'), null);

  const { startServer } = require('./helpers');
  const srv = await startServer({ DATA_DIR: path.join(ROOT, 'logs-data'), TVMAZE_DISABLED: '1', AUTO_LIBRARIES: `Movies:movie:${path.join(ROOT, 'no-such-drive')}` });
  try {
    const admin = srv.client();
    await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
    const problems = (await admin('GET', '/api/logs')).data.entries;
    const missing = problems.find((e) => /folder not found/.test(e.message));
    assert.ok(missing, JSON.stringify(problems));
    assert.equal(missing.level, 'warning');
    assert.match(missing.hint, /drive plugged in/);
    assert.ok(problems.every((e) => e.level !== 'info'), 'problems only by default');
    assert.ok((await admin('GET', '/api/logs?all')).data.entries.some((e) => /Marquee is running/.test(e.message)));
    const viewer = srv.client();
    await admin('POST', '/api/users', { username: 'kid', password: 'kidpass1' });
    await viewer('POST', '/api/auth/login', { username: 'kid', password: 'kidpass1' });
    assert.equal((await viewer('GET', '/api/logs')).status, 403);
  } finally { await srv.stop(); }
});
