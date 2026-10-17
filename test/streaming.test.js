'use strict';
// Adaptive streaming, signed playback links, graphics-card fallback and skip-intro detection.
// Needs ffmpeg (with Chromaprint, as in Ubuntu's and Docker's ffmpeg builds).

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hls = require('../lib/hls');
const { HwAccel, videoArgs } = require('../lib/hwaccel');
const { MediaTokens } = require('../lib/tokens');
const intro = require('../lib/intro');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-stream-'));
const PORT = 40000 + Math.floor(Math.random() * 10000);
const BASE = `http://127.0.0.1:${PORT}`;
const memStore = (data = {}) => ({ data: { settings: {}, ...data }, save() {} });
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);

// An episode: some episode-specific sound, the shared theme (30 s), then more episode audio.
function episode(file, n, themeAt, theme) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tail = 30;
  const tone = (d, f) => `aevalsrc='0.4*sin(2*PI*(${f}+${90 * n}*sin(${0.9 + n / 10}*t+${n}))*t)*(0.6+0.4*sin(2*PI*1.7*t/${n}))':d=${d}:s=44100`;
  ff(['-f', 'lavfi', '-i', tone(themeAt, 200 + 40 * n), '-i', theme, '-f', 'lavfi', '-i', tone(tail, 500 + 30 * n),
    '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=10:d=${themeAt + 30 + tail}`,
    '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1[a]', '-map', '3:v', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
}

let server;
let cookie = '';
async function call(method, url, body, headers = {}) {
  const res = await fetch(BASE + url, {
    method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : type.includes('mpegurl') || type.includes('text') ? await res.text() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data, headers: res.headers };
}
const anonGet = (url, headers) => fetch(BASE + url, { headers });
async function until(fn, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 250));
  }
}

test.before(async () => {
  const theme = path.join(ROOT, 'theme.wav');
  ff(['-f', 'lavfi', '-i', 'anoisesrc=d=30:c=pink:seed=7:a=0.3', '-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*(300+200*sin(0.7*t))*t)':d=30",
    '-filter_complex', 'amix=inputs=2', '-ar', '44100', theme]);
  const season = path.join(ROOT, 'TV', 'Theme Show', 'Season 01');
  episode(path.join(season, 'Theme Show - S01E01.mp4'), 1, 8, theme);
  episode(path.join(season, 'Theme Show - S01E02.mp4'), 2, 15, theme);
  episode(path.join(season, 'Theme Show - S01E03.mp4'), 3, 3, theme);
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: path.join(ROOT, 'data'), SCAN_INTERVAL: '0', TVMAZE_DISABLED: '1',
      TMDB_API_KEY: '', TMDB_TOKEN: '', HWACCEL: 'auto', TRANSCODE_DIR: path.join(ROOT, 'transcode'),
      AUTO_LIBRARIES: `TV:show:${path.join(ROOT, 'TV')}`, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.env.DEBUG && process.stderr.write(d));
  server.stderr.on('data', (d) => process.env.DEBUG && process.stderr.write(d));
  await until(() => fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false));
  assert.equal((await call('POST', '/api/auth/setup', { username: 'admin', password: 'correct horse' })).status, 201);
});

test.after(async () => {
  if (server && server.exitCode === null) await new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
  // ffmpeg jobs the server was running can still be writing segments for a moment.
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ---------- units ----------
test('qualities never go above the source resolution', () => {
  const item = (w, h) => ({ media: { duration: 10, video: { width: w, height: h } } });
  assert.deepEqual(hls.qualitiesFor(item(1920, 1080)).map((q) => q.id), ['1080p', '720p', '480p', '360p']);
  assert.deepEqual(hls.qualitiesFor(item(1920, 800)).map((q) => q.id), ['1080p', '720p', '480p', '360p'], 'wide films count as 1080p');
  assert.deepEqual(hls.qualitiesFor(item(1280, 720)).map((q) => q.id), ['720p', '480p', '360p']);
  assert.deepEqual(hls.qualitiesFor(item(320, 240)).map((q) => q.id), ['360p'], 'always at least one');
});

test('playlists describe the whole video in 4-second segments', () => {
  const item = { media: { duration: 30.5, video: { width: 1280, height: 720 } } };
  const master = hls.masterPlaylist(item, { query: '?sid=abc' });
  assert.match(master, /RESOLUTION=1280x720/);
  assert.match(master, /^720p\/index\.m3u8\?sid=abc$/m);
  assert.equal(hls.masterPlaylist(item, { only: '480p' }).match(/STREAM-INF/g).length, 1);
  assert.throws(() => hls.masterPlaylist(item, { only: '1080p' }), /Unknown quality/);
  const media = hls.mediaPlaylist(item, '480p', { query: '?sid=abc' });
  const durations = [...media.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
  assert.equal(durations.length, 8);
  assert.equal(durations.at(-1), 2.5);
  assert.ok(Math.abs(durations.reduce((a, b) => a + b, 0) - 30.5) < 1e-6);
  assert.match(media, /seg-7\.ts\?sid=abc\n#EXT-X-ENDLIST/);
});

test('encoder arguments for each kind of graphics card', () => {
  assert.ok(videoArgs('software').output.includes('libx264'));
  const nv = videoArgs('nvenc', { bitrate: 4e6, keyframeEvery: 4 });
  assert.ok(nv.output.includes('h264_nvenc') && nv.output.includes('4000000') && nv.output.includes('expr:gte(t,n_forced*4)'));
  assert.deepEqual(videoArgs('vaapi').input.slice(0, 1), ['-vaapi_device']);
  assert.ok(videoArgs('qsv').output.includes('h264_qsv'));
});

test('a graphics card that keeps failing is dropped for the CPU', () => {
  const hw = new HwAccel(memStore());
  hw.active = 'nvenc';
  hw.reportFailure('nvenc', 'boom');
  assert.equal(hw.active, 'nvenc', 'one failure can be a fluke');
  hw.reportFailure('nvenc', 'boom again');
  assert.equal(hw.active, 'software');
  assert.match(hw.status().results.find((r) => r.kind === 'nvenc').error, /boom again/);
});

test('signed playback links: valid, scoped and tamper-proof', () => {
  const t = new MediaTokens(memStore());
  const tok = t.create('item1', 'user1');
  assert.deepEqual(t.verify(tok), { itemId: 'item1', userId: 'user1' });
  assert.equal(t.verify(tok.replace('item1', 'item2')), null, 'item id is signed');
  assert.equal(t.verify(tok.slice(0, -2) + 'xx'), null);
  assert.equal(t.verify(t.create('item1', 'user1', -1000)), null, 'expired');
  assert.equal(t.verify('garbage'), null);
  t.rotate();
  assert.equal(t.verify(tok), null, 'rotating the secret revokes every link');
});

test('HLS falls back to the CPU when the graphics card cannot start', async () => {
  // This machine has no NVIDIA card, so the NVENC job fails and the segment must still arrive.
  const file = path.join(ROOT, 'fallback.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:d=12', '-f', 'lavfi', '-i', 'sine=d=12', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
  const failures = [];
  const hw = { active: 'nvenc', reportFailure: (kind, err) => failures.push(kind, err) };
  const mgr = new hls.HlsManager(path.join(ROOT, 'hls-unit'), hw);
  const item = { id: 'fb', file, media: { duration: 12, bitrate: 1e6, video: { width: 640, height: 360 }, audio: [{ codec: 'aac' }] } };
  try {
    const seg = await mgr.segment(item, { quality: '360p', sid: 'unit-test-1' }, 1);
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', seg]));
    assert.equal(failures[0], 'nvenc');
    assert.equal(mgr.status()[0].encoder, 'software');
    assert.deepEqual(info.streams.map((s) => s.codec_name).sort(), ['aac', 'h264']);
    assert.ok(Math.abs(Number(info.format.start_time) - 4) < 0.3, `segment 1 starts at 4 s (got ${info.format.start_time})`);
  } finally { mgr.stopAll(); }
});

test('intro fingerprints line up the shared theme', async () => {
  const dir = path.join(ROOT, 'TV', 'Theme Show', 'Season 01');
  const [a, b] = await Promise.all([1, 2].map((n) => intro.fingerprint(path.join(dir, `Theme Show - S01E0${n}.mp4`))));
  const m = intro.compare(a, b);
  assert.ok(m, 'match found');
  // Theme is at 8–38 s in episode 1 and 15–45 s in episode 2 (fingerprint edges blur ~2 s).
  assert.ok(Math.abs(m.aStart - 8) < 2.5 && Math.abs(m.aEnd - 38) < 3, JSON.stringify(m));
  assert.ok(Math.abs(m.bStart - 15) < 2.5 && Math.abs(m.bEnd - 45) < 3, JSON.stringify(m));
});

// ---------- through the server ----------
let ep;
test('episodes get their intro detected after the scan', async () => {
  await until(async () => (await call('GET', '/api/intro')).data.checked === 3);
  const st = (await call('GET', '/api/intro')).data;
  assert.equal(st.found, 3);
  const showId = (await call('GET', '/api/search?q=Theme')).data.shows[0].id;
  const detail = (await call('GET', `/api/shows/${showId}`)).data;
  const eps = detail.seasons.flatMap((s) => s.episodes);
  const want = { 1: [8, 38], 2: [15, 45], 3: [0, 33] };
  for (const e of eps) {
    const d = (await call('GET', `/api/items/${e.id}`)).data;
    const [s, end] = want[d.episode];
    assert.ok(d.intro, `episode ${d.episode} has an intro`);
    assert.ok(Math.abs(d.intro.start - s) < 3 && Math.abs(d.intro.end - end) < 3, `episode ${d.episode}: ${JSON.stringify(d.intro)}`);
    if (d.episode === 2) ep = d;
  }
});

test('playback info gives a signed link that works without the cookie', async () => {
  const pb = (await call('GET', `/api/items/${ep.id}/playback`)).data;
  assert.ok(pb.token && pb.sid);
  assert.deepEqual(pb.qualities.map((q) => q.id), ['360p']);
  assert.equal(pb.intro.end, ep.intro.end);

  assert.equal((await anonGet(`/api/items/${ep.id}/stream`)).status, 401, 'no cookie, no token');
  const r = await anonGet(`/api/items/${ep.id}/stream?mt=${pb.token}`, { range: 'bytes=0-99' });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('access-control-allow-origin'), '*', 'cast receivers need CORS');
  assert.notEqual((await anonGet(`/api/art/backdrop/${ep.showId}?mt=${pb.token}`)).status, 401, "the item's show artwork opens too");

  // The link only opens its own item, and never the rest of the API.
  const other = ep.prev || ep.next;
  assert.equal((await anonGet(`/api/items/${other.id}/stream?mt=${pb.token}`)).status, 401);
  assert.equal((await anonGet(`/api/items/${ep.id}?mt=${pb.token}`)).status, 401);
  assert.equal((await anonGet(`/api/home?mt=${pb.token}`)).status, 401);
  assert.equal((await anonGet(`/api/items/${ep.id}/stream?mt=${pb.token.slice(0, -1)}A`)).status, 401);

  const pre = await fetch(`${BASE}/api/items/${ep.id}/hls/master.m3u8`, { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
});

test('adaptive streaming plays end to end and seeks', async () => {
  const pb = (await call('GET', `/api/items/${ep.id}/playback`)).data;
  const q = `sid=${pb.sid}&mt=${pb.token}`;
  const master = await anonGet(`/api/items/${ep.id}/hls/master.m3u8?${q}`);
  assert.equal(master.status, 200);
  assert.match(master.headers.get('content-type'), /mpegurl/);
  assert.match(await master.text(), new RegExp(`360p/index\\.m3u8\\?sid=${pb.sid}&mt=`));

  // Jump to the middle first (as a seek would), then back to the start.
  for (const n of [10, 0]) {
    const seg = await anonGet(`/api/items/${ep.id}/hls/360p/seg-${n}.ts?${q}`);
    assert.equal(seg.status, 200);
    assert.equal(seg.headers.get('content-type'), 'video/mp2t');
    const f = path.join(ROOT, `seg-${n}.ts`);
    fs.writeFileSync(f, Buffer.from(await seg.arrayBuffer()));
    const start = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=start_time', '-of', 'csv=p=0', f]).toString());
    assert.ok(Math.abs(start - n * hls.SEG) < 0.3, `segment ${n} starts at ${n * hls.SEG}s (got ${start})`);
  }
  assert.equal((await anonGet(`/api/items/${ep.id}/hls/360p/seg-999.ts?${q}`)).status, 404);
  assert.equal((await anonGet(`/api/items/${ep.id}/hls/1080p/index.m3u8?${q}`)).status, 404);
  assert.equal((await anonGet(`/api/items/${ep.id}/hls/360p/seg-1.ts?mt=${pb.token}`)).status, 400, 'needs a session id');

  // A whole-file read through the playlist, like a player would do.
  const out = path.join(ROOT, 'all.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', `${BASE}/api/items/${ep.id}/hls/360p/index.m3u8?${q}`, '-c', 'copy', out]);
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString());
  assert.ok(Math.abs(dur - ep.duration) < 1, `full length (${dur} vs ${ep.duration})`);
  assert.equal((await call('DELETE', `/api/hls/${pb.sid}`)).status, 200);
});

test('transcoding settings: status, choice and re-test', async () => {
  const st = (await call('GET', '/api/transcoding')).data;
  assert.equal(st.setting, 'auto');
  assert.ok(['software', 'nvenc', 'qsv', 'vaapi'].includes(st.active));
  const sw = (await call('PATCH', '/api/transcoding', { hwaccel: 'software', castUrl: 'http://192.168.1.20:32500/' })).data;
  assert.equal(sw.active, 'software');
  assert.equal(sw.castUrl, 'http://192.168.1.20:32500');
  assert.equal((await call('PATCH', '/api/transcoding', { hwaccel: 'warp-drive' })).status, 400);
  assert.equal((await call('PATCH', '/api/transcoding', { castUrl: 'not a url' })).status, 400);
  const pb = (await call('GET', `/api/items/${ep.id}/playback`)).data;
  assert.equal(pb.cast.configured, 'http://192.168.1.20:32500');
  // The progressive transcode reports which encoder it used.
  const r = await fetch(`${BASE}/api/items/${ep.id}/transcode?start=0&mt=${pb.token}`);
  assert.equal(r.headers.get('x-encoder'), 'software');
  await r.body.cancel();
});
