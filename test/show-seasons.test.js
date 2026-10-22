'use strict';
// A show's page a season at a time (long-running shows have a thousand episodes, slow for a Roku
// to take in at once), with the other seasons and the admin's file list fetched when wanted.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, until } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-seasons-'));
const SHOW = path.join(ROOT, 'TV', 'Bluey');
let srv, admin, user, show;
test.before(async () => {
  const clip = path.join(ROOT, 'clip.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip]);
  for (const [s, e] of [[0, 1], [1, 1], [1, 2], [2, 1], [2, 2], [3, 1]]) {
    const dir = path.join(SHOW, s ? `Season ${s}` : 'Specials');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(clip, path.join(dir, `Bluey - S0${s}E0${e}.mp4`));
  }
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1', AUTO_LIBRARIES: `TV:show:${path.join(ROOT, 'TV')}` });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  await until(async () => (await admin('GET', '/api/libraries')).data.every((l) => l.scannedAt));
  const lib = (await admin('GET', '/api/libraries')).data[0];
  show = (await admin('GET', `/api/libraries/${lib.id}/items`)).data.items[0];
  await admin('POST', '/api/users', { username: 'sam', password: 'sampass11' });
  user = srv.client();
  await user('POST', '/api/auth/login', { username: 'sam', password: 'sampass11' });
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const loaded = (d) => d.seasons.filter((s) => s.episodes).map((s) => s.season);

test('without asking, every season comes in full (as older TV apps expect)', async () => {
  const d = (await user('GET', `/api/shows/${show.id}`)).data;
  assert.deepEqual(d.seasons.map((s) => s.season), [0, 1, 2, 3]);
  assert.deepEqual(loaded(d), [0, 1, 2, 3]);
  assert.deepEqual(d.seasons.map((s) => s.count), [1, 2, 2, 1]);
});

test('a season at a time: the next one to watch, or the one asked for', async () => {
  // Season 1 watched: the next episode is in season 2, so that's the one sent.
  await user('POST', `/api/shows/${show.id}/watched`, { season: 1, watched: true });
  let d = (await user('GET', `/api/shows/${show.id}?episodes=auto`)).data;
  assert.equal(d.upNext.season, 2);
  assert.deepEqual(loaded(d), [2]);
  assert.deepEqual(d.seasons.map((s) => [s.season, s.count, s.watched]), [[0, 1, false], [1, 2, true], [2, 2, false], [3, 1, false]]);
  assert.equal(d.seasons[2].episodes.length, 2);

  assert.deepEqual(loaded((await user('GET', `/api/shows/${show.id}?episodes=3`)).data), [3]);
  assert.deepEqual(loaded((await user('GET', `/api/shows/${show.id}?episodes=0`)).data), [0], 'specials');
  assert.deepEqual(loaded((await user('GET', `/api/shows/${show.id}?episodes=9`)).data), [2], 'a season that isn’t there: the next to watch');
  assert.deepEqual(loaded((await user('GET', `/api/shows/${show.id}?episodes=none`)).data), []);

  // The rest, a season at a time.
  const s0 = (await user('GET', `/api/shows/${show.id}/episodes?season=0`)).data;
  assert.equal(s0.title, 'Specials');
  assert.equal(s0.episodes.length, 1);
  const s1 = (await user('GET', `/api/shows/${show.id}/episodes?season=1`)).data;
  assert.deepEqual(s1.episodes.map((e) => [e.episode, e.progress?.watched]), [[1, true], [2, true]]);
  assert.deepEqual((await user('GET', `/api/shows/${show.id}/episodes?season=7`)).data.episodes, []);

  // Marking a season watched answers with the show, without every episode.
  const r = (await user('POST', `/api/shows/${show.id}/watched`, { season: 1, watched: false })).data;
  assert.deepEqual(loaded(r), []);
  assert.equal(r.seasons[1].watched, false);
});

test('admins get the file list on its own when the page comes a season at a time', async () => {
  const d = (await admin('GET', `/api/shows/${show.id}?episodes=auto`)).data;
  assert.deepEqual(d.files, { folder: SHOW, count: 6, episodes: null });
  const f = (await admin('GET', `/api/shows/${show.id}/files`)).data;
  assert.equal(f.episodes.length, 6);
  assert.equal(f.episodes[0].file, path.join(SHOW, 'Specials', 'Bluey - S00E01.mp4'));
  assert.equal((await user('GET', `/api/shows/${show.id}/files`)).status, 403);
  assert.equal((await user('GET', `/api/shows/${show.id}?episodes=auto`)).data.files, undefined);
});
