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
const { kindOf, secondsLeft, Optimizer } = require('../lib/optimize');

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

test('time left, not counting time spent paused', () => {
  const now = 1_000_000;
  assert.equal(secondsLeft({ progress: 0.01, startedAt: now - 60_000, pausedMs: 0 }, now), null, 'too early to tell');
  // A quarter done in 40 s of converting (20 s of the minute were paused): 2 minutes to go.
  assert.equal(secondsLeft({ progress: 0.25, startedAt: now - 60_000, pausedMs: 20_000, paused: false }, now), 120);
  assert.equal(secondsLeft({ progress: 0.25, startedAt: now - 70_000, pausedMs: 20_000, paused: true, pausedAt: now - 10_000 }, now), 120, 'paused right now');
});

test('a conversion on the graphics card is ended on a pause, carries on where it was, and the parts are joined', async () => {
  const dir = path.join(ROOT, 'parts');
  const file = path.join(dir, 'Long Film.mkv');
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=60', '-f', 'lavfi', '-i', 'sine=d=60',
    '-c:v', 'mpeg2video', '-b:v', '6M', '-c:a', 'ac3', file]);
  const { probe } = require('../lib/media');
  const item = { id: 'long1', type: 'movie', title: 'Long Film', file, mtime: 1, media: await probe(file) };
  const store = { data: { items: { long1: item }, settings: { optimize: { enabled: true } } }, save() {} };
  let busy = false;
  const o = new Optimizer(store, path.join(dir, 'copies'), { active: 'software' }, { probe, isBusy: () => busy });
  o.freesCard = () => true; // no graphics card here: treat the CPU's like one
  o.run(item);
  await until(() => o.running?.progress > 0.2, 60_000);
  busy = true;
  o.tick();
  await until(() => o.running && !o.running.proc, 30_000);
  const job = o.running;
  assert.equal(job.parts.length, 1, 'what was done is kept as a part');
  assert.ok(job.done > 5 && job.done < 55, `part of the way (${job.done}s)`);
  assert.equal(o.status().running.paused, true);
  assert.ok(o.used() > 0, 'the part counts towards the space used');
  busy = false;
  o.tick();
  await until(() => item.optimized, 120_000);
  assert.ok(Math.abs(item.optimized.media.duration - 60) < 1, `the whole film, once (${item.optimized.media.duration}s)`);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'copies')), [path.basename(item.optimized.file)], 'the parts are gone');
});

test('a conversion stopped for a restart carries on from there afterwards', async () => {
  const dir = path.join(ROOT, 'restart');
  const file = path.join(dir, 'Long Film.mkv');
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=60', '-f', 'lavfi', '-i', 'sine=d=60',
    '-c:v', 'mpeg2video', '-b:v', '6M', '-c:a', 'ac3', file]);
  const { probe } = require('../lib/media');
  const item = { id: 'long2', type: 'movie', title: 'Long Film', file, mtime: 1, media: await probe(file) };
  const store = { data: { items: { long2: item }, settings: { optimize: { enabled: true } } }, save() {} };
  const copies = path.join(dir, 'copies');
  const before = new Optimizer(store, copies, { active: 'software' }, { probe });
  before.run(item);
  await until(() => before.running?.progress > 0.2, 60_000);
  await before.suspendForRestart();
  const saved = store.data.optimizeResume;
  assert.equal(saved?.parts.length, 1, 'what was done is kept');
  assert.ok(saved.done > 5 && saved.done < 55, `part of the way (${saved.done}s)`);
  before.tick();
  assert.equal(before.running.proc, null, 'nothing more starts while Marquee is stopping');
  const after = new Optimizer(store, copies, { active: 'software' }, { probe }); // Marquee started again
  assert.ok(fs.existsSync(saved.parts[0]), 'the part survives the start-up tidy');
  after.startNow(1);
  await until(() => item.optimized, 120_000);
  assert.ok(Math.abs(item.optimized.media.duration - 60) < 1, `the whole film, once (${item.optimized.media.duration}s)`);
  assert.equal(store.data.optimizeResume, undefined);
  assert.deepEqual(fs.readdirSync(copies), [path.basename(item.optimized.file)], 'the parts are gone');
});

test('a copy much shorter than the original isn’t used', async () => {
  const dir = path.join(ROOT, 'short');
  const file = path.join(dir, 'Cut Short.mkv');
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=70', '-f', 'lavfi', '-i', 'sine=d=70',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', file]);
  const { probe } = require('../lib/media');
  const item = { id: 'short1', type: 'movie', title: 'Cut Short', file, mtime: 1, media: await probe(file) };
  const store = { data: { items: { short1: item }, settings: { optimize: { enabled: true } } }, save() {} };
  // As if ffmpeg stopped halfway through without saying so.
  const halfway = async (f) => { const m = await probe(f); return f === file ? m : { ...m, duration: m.duration / 2 }; };
  const copies = path.join(dir, 'copies');
  const o = new Optimizer(store, copies, { active: 'software' }, { probe: halfway });
  o.run(item);
  await until(() => item.optimizeFailed, 60_000);
  assert.match(item.optimizeFailed.error, /long/);
  assert.equal(item.optimized, undefined);
  assert.deepEqual(fs.readdirSync(copies), []);
});

test('admins pause, carry on, or stop for tonight', () => {
  const store = { data: { items: {}, settings: { optimize: { enabled: true, end: '07:00' } } }, save() {} };
  const o = new Optimizer(store, path.join(ROOT, 'hold'), null, { now: () => new Date('2026-10-20T23:30:00') });
  o.pause('dad');
  assert.deepEqual([o.status().state, o.status().hold.by], ['held', 'dad']);
  o.resume();
  assert.equal(o.status().hold, null);
  o.stopForTonight('dad');
  assert.equal(o.status().state, 'tonight');
  assert.equal(new Date(o.hold().until).toString(), new Date('2026-10-21T07:00:00').toString(), 'until the morning');
  store.data.optimizeHold.until = new Date('2026-10-20T23:30:00').getTime() - 1;
  assert.equal(o.hold(), null, 'over by the next night');
  o.startNow();
  assert.equal(o.hold(), null, 'Start now carries on too');
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

test('where copies are kept: a folder you pick, or next to the originals; existing ones can be moved', async () => {
  const PICKED = path.join(ROOT, 'Picked');
  fs.mkdirSync(PICKED);
  fs.writeFileSync(path.join(PICKED, 'notes.txt'), 'mine');
  let r = await admin('PATCH', '/api/optimize', { place: 'folder', folder: path.join(ROOT, 'Movies') });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /inside the Movies library/);
  assert.equal((await admin('PATCH', '/api/optimize', { place: 'folder', folder: path.join(ROOT, 'nowhere') })).status, 400);
  assert.equal((await admin('PATCH', '/api/optimize', { place: 'sideways' })).status, 400);

  let o = (await admin('PATCH', '/api/optimize', { place: 'folder', folder: PICKED })).data;
  assert.deepEqual([o.settings.place, o.settings.folder, o.folderLabel], ['folder', PICKED, PICKED]);
  assert.equal(o.elsewhere.count, 2, 'the two copies made before are still in the old folder');
  assert.ok(o.free > 0);
  const moved = async () => {
    assert.equal((await admin('POST', '/api/optimize/move')).status, 202);
    await until(async () => !(await admin('GET', '/api/optimize')).data.moving);
    return (await admin('GET', '/api/optimize')).data;
  };
  o = await moved();
  assert.deepEqual([o.elsewhere.count, o.counts.done, o.moved.failed], [0, 2, 0]);
  assert.deepEqual(fs.readdirSync(OUT), []);
  assert.equal(fs.readdirSync(PICKED).filter((f) => f.endsWith('.mp4')).length, 2);
  const playsFrom = async () => {
    const pb = (await admin('GET', `/api/items/${dvd.id}~o/playback`)).data;
    return (await fetch(`${srv.base}/api/items/${dvd.id}~o/stream?mt=${pb.token}`, { headers: { range: 'bytes=0-99' } })).status;
  };
  assert.equal(await playsFrom(), 206, 'plays from the new folder');

  o = (await admin('PATCH', '/api/optimize', { place: 'beside' })).data;
  assert.equal(o.elsewhere.count, 2);
  o = await moved();
  assert.equal(o.elsewhere.count, 0);
  const beside = path.join(ROOT, 'Movies', 'Old Film (1999)', '.marquee-converted');
  assert.equal(fs.readdirSync(beside).length, 1, 'next to the film');
  assert.equal(fs.readdirSync(path.join(ROOT, 'TV', 'Old Show', 'Season 1', '.marquee-converted')).length, 1, 'next to the episode');
  assert.deepEqual(fs.readdirSync(PICKED), ['notes.txt'], 'only the copies were moved');
  assert.equal(await playsFrom(), 206);
  // The library doesn't count the copies as films.
  const lib = (await admin('GET', '/api/libraries')).data.find((l) => l.name === 'Movies');
  await admin('POST', `/api/libraries/${lib.id}/scan`, {});
  await until(async () => !(await admin('GET', '/api/status')).data.scanning);
  assert.equal((await admin('GET', '/api/search?q=Old%20Film')).data.movies.length, 1);
  assert.equal((await admin('GET', `/api/items/${dvd.id}`)).data.versions.length, 2);
});

test('removing the copies', async () => {
  const o = (await admin('DELETE', '/api/optimize')).data;
  assert.equal(o.counts.done, 0);
  assert.deepEqual(fs.readdirSync(OUT), []);
  assert.equal(fs.existsSync(path.join(ROOT, 'Movies', 'Old Film (1999)', '.marquee-converted')), false, 'emptied folders next to the originals go too');
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'Picked')), ['notes.txt'], 'nothing else in a picked folder is touched');
  assert.equal((await admin('GET', `/api/items/${dvd.id}`)).data.versions, null);
  await admin('PATCH', '/api/optimize', { enabled: false });
  assert.equal((await srv.client()('GET', '/api/optimize')).status, 401);
});
