'use strict';
// Adaptive streaming, signed playback links, graphics-card fallback and skip-intro detection.
// Needs ffmpeg (with Chromaprint, as in Ubuntu's and Docker's ffmpeg builds).

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hls = require('../lib/hls');
const { HwAccel, videoArgs, useGpuCodecs } = require('../lib/hwaccel');
const hdr = require('../lib/hdr');
const { MediaTokens } = require('../lib/tokens');
const intro = require('../lib/intro');
const { makeSup } = require('./pgs');
const BOX = { width: 720, height: 480, x: 260, y: 400, w: 200, h: 40 };
// Average brightness (0-255) of the subtitle box area in the frame at `t` seconds of a video URL or file.
function boxBrightness(input, t, extra = []) {
  const out = execFileSync('ffmpeg', ['-v', 'error', ...extra, '-i', input, '-ss', String(t), '-frames:v', '1',
    '-vf', `scale=720:480,crop=${BOX.w}:${BOX.h}:${BOX.x}:${BOX.y}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  return out.reduce((a, b) => a + b, 0) / out.length;
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-stream-'));
const PORT = 40000 + Math.floor(Math.random() * 10000);
const BASE = `http://127.0.0.1:${PORT}`;
const memStore = (data = {}) => ({ data: { settings: {}, ...data }, save() {} });
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);

// An episode: some episode-specific sound, the shared theme (30 s), more episode audio (30 s),
// the shared end credits (20 s), then a short episode-specific ending (4 s).
function episode(file, n, themeAt, theme, credits) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tail = 30;
  const tone = (d, f) => `aevalsrc='0.4*sin(2*PI*(${f}+${90 * n}*sin(${0.9 + n / 10}*t+${n}))*t)*(0.6+0.4*sin(2*PI*1.7*t/${n}))':d=${d}:s=44100`;
  ff(['-f', 'lavfi', '-i', tone(themeAt, 200 + 40 * n), '-i', theme, '-f', 'lavfi', '-i', tone(tail, 500 + 30 * n),
    '-i', credits, '-f', 'lavfi', '-i', tone(4, 900 + 20 * n),
    '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=10:d=${themeAt + 30 + tail + 24}`,
    '-filter_complex', '[0][1][2][3][4]concat=n=5:v=0:a=1[a]', '-map', '5:v', '-map', '[a]',
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
  const credits = path.join(ROOT, 'credits.wav');
  ff(['-f', 'lavfi', '-i', 'anoisesrc=d=20:c=white:seed=99:a=0.2', '-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*(700+300*sin(1.3*t))*t)':d=20",
    '-filter_complex', 'amix=inputs=2', '-ar', '44100', credits]);
  const season = path.join(ROOT, 'TV', 'Theme Show', 'Season 01');
  episode(path.join(season, 'Theme Show - S01E01.mp4'), 1, 8, theme, credits);
  episode(path.join(season, 'Theme Show - S01E02.mp4'), 2, 15, theme, credits);
  episode(path.join(season, 'Theme Show - S01E03.mp4'), 3, 3, theme, credits);
  fs.mkdirSync(path.join(ROOT, 'Movies'));
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '15M', '-pix_fmt', 'yuv420p',
    path.join(ROOT, 'Movies', 'Big (2020).mp4')]);
  // A DVD-sized film with a Blu-ray (PGS) subtitle: a white box from 1–4 s and 5–8 s.
  fs.writeFileSync(path.join(ROOT, 'box.sup'), makeSup([{ start: 1, end: 4 }, { start: 5, end: 8 }], BOX));
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=720x480:rate=24:d=10', '-f', 'lavfi', '-i', 'sine=d=10', '-i', path.join(ROOT, 'box.sup'),
    '-map', '0', '-map', '1', '-map', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'copy',
    '-metadata:s:s:0', 'language=eng', path.join(ROOT, 'Movies', 'Boxed (2019).mkv')]);
  // An MKV with H.264 video (browsers can't open MKV files) and Dolby Digital sound, a keyframe every 2.5 s.
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:d=41', '-f', 'lavfi', '-i', 'sine=d=41:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '60', '-sc_threshold', '0', '-c:a', 'ac3', '-ac', '6',
    path.join(ROOT, 'Movies', 'Remux (2021).mkv')]);
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: path.join(ROOT, 'data'), SCAN_INTERVAL: '0', TVMAZE_DISABLED: '1',
      TMDB_API_KEY: '', TMDB_TOKEN: '', HWACCEL: 'auto', TRANSCODE_DIR: path.join(ROOT, 'transcode'),
      AUTO_LIBRARIES: `TV:show:${path.join(ROOT, 'TV')};Movies:movie:${path.join(ROOT, 'Movies')}`, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
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

test('an NVIDIA card decodes and resizes too, when it can', async () => {
  await hdr.check();
  useGpuCodecs(['h264', 'hevc', 'mpeg2video', 'vc1']);
  try {
    const sdr = videoArgs('nvdec', { maxHeight: 720, bitrate: 4e6, video: { codec: 'hevc', pixFmt: 'yuv420p10le' } });
    assert.equal(sdr.kind, 'nvdec');
    assert.deepEqual(sdr.input, ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda']);
    assert.equal(sdr.output[sdr.output.indexOf('-vf') + 1], "scale_cuda=w='round(min(720,ih)*dar/2)*2':h='min(720,ih)':format=nv12,setsar=1", 'stays on the card all the way to the encoder');
    assert.ok(sdr.output.includes('h264_nvenc'));

    // HDR: shrunk on the card, then brought back for tone mapping on the CPU.
    const h = videoArgs('nvdec', { maxHeight: 1080, video: { codec: 'hevc', pixFmt: 'yuv420p10le', colorTransfer: 'smpte2084' } });
    const vf = h.output[h.output.indexOf('-vf') + 1];
    if (hdr.toneMapping()) assert.match(vf, /^scale_cuda=w='round\(min\(1080,ih\)\*dar\/2\)\*2':h='min\(1080,ih\)':format=p010le,setsar=1,hwdownload,format=p010le,zscale.*tonemap.*format=yuv420p$/);

    // What the card can't decode (10-bit H.264, 4:2:2, codecs it wasn't seen decoding) and drawn-in
    // subtitles are decoded on the CPU, and only encoded on the card.
    for (const [why, opts] of [['10-bit H.264', { video: { codec: 'h264', pixFmt: 'yuv420p10le', profile: 'High 10' } }],
      ['4:2:2', { video: { codec: 'hevc', pixFmt: 'yuv422p10le' } }], ['AV1 not seen', { video: { codec: 'av1', pixFmt: 'yuv420p' } }],
      ['subtitles drawn in', { burn: 2, video: { codec: 'h264', pixFmt: 'yuv420p' } }]]) {
      const a = videoArgs('nvdec', opts);
      assert.equal(a.kind, 'nvenc', why);
      assert.ok(!a.input.includes('-hwaccel') && a.output.includes('h264_nvenc'), why);
    }
  } finally { useGpuCodecs(['h264']); }

  // Failing to start falls back step by step: card decoding → card encoding only → the CPU.
  const hw = new HwAccel(memStore());
  assert.equal(hw.fallback('nvdec'), 'nvenc');
  assert.equal(hw.fallback('nvenc'), 'software');
  hw.active = 'nvdec';
  hw.reportFailure('nvdec', 'no NVDEC');
  hw.reportFailure('nvdec', 'no NVDEC');
  assert.equal(hw.active, 'nvenc', 'repeated failures drop decoding, not the card');
});

test('HLS falls back from NVIDIA decoding to the CPU when the card cannot start', async () => {
  const file = path.join(ROOT, 'fallback-nvdec.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
  const failures = [];
  const hw = { active: 'nvdec', reportFailure: (kind) => failures.push(kind), fallback: (k) => (k === 'nvdec' ? 'nvenc' : 'software') };
  const mgr = new hls.HlsManager(path.join(ROOT, 'hls-nvdec'), hw);
  const item = { id: 'nd', file, media: { duration: 6, bitrate: 1e6, video: { codec: 'h264', pixFmt: 'yuv420p', width: 640, height: 360 }, audio: [] } };
  try {
    const seg = await mgr.segment(item, { quality: '360p', sid: 'unit-test-nvdec' }, 0);
    assert.ok(fs.statSync(seg).size > 0);
    assert.deepEqual(failures, ['nvdec', 'nvenc'], 'this machine has no NVIDIA card: both steps fail, then the CPU does it');
    assert.equal(mgr.status()[0].encoder, 'software');
  } finally { mgr.stopAll(); }
});

test('conversion pauses a short way ahead of the player instead of racing to the end', { skip: process.platform === 'win32' }, async () => {
  const file = path.join(ROOT, 'long.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10:d=160', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
  const mgr = new hls.HlsManager(path.join(ROOT, 'hls-pace'), { active: 'software', reportFailure() {} });
  const item = { id: 'pace', file, media: { duration: 160, bitrate: 3e5, video: { codec: 'h264', pixFmt: 'yuv420p', width: 320, height: 180 }, audio: [] } };
  try {
    await mgr.segment(item, { quality: '360p', sid: 'unit-test-pace' }, 0);
    await until(() => mgr.status()[0]?.paused, 20000);
    const made = mgr.lastProduced([...mgr.sessions.values()][0]);
    assert.ok(made >= 10 && made <= 16, `paused about 12 segments ahead, not at the end of 40 (made ${made})`);
  } finally { mgr.stopAll(); }
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

test('a graphics card that was dropped is tried again later, and used once it works', async () => {
  const hw = new HwAccel(memStore());
  hw.retryMs = 20;
  hw.settle('auto', 'nvdec');
  assert.equal(hw.retry, null, 'nothing to retry while the best one is in use');
  // The first re-check finds the card still failing, the second finds it working again.
  const found = ['software', 'nvdec'];
  const used = [];
  hw.detect = async () => { hw.settle('auto', found[used.length]); used.push(hw.active); };
  hw.reportFailure('nvdec', 'out of memory');
  hw.reportFailure('nvdec', 'out of memory');
  assert.equal(hw.active, 'nvenc');
  await until(() => used.length === 2, 2000);
  assert.deepEqual(used, ['software', 'nvdec'], 'keeps trying while it fails, then goes back to the card');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(used.length, 2, 'and stops trying once it works');
  assert.equal(hw.retry, null);
});

test('no retries where no graphics card ever worked, or after the setting changes', () => {
  const hw = new HwAccel(memStore());
  hw.settle('auto', 'software');
  assert.equal(hw.retry, null, 'a PC without a working card is not tested over and over');
  hw.settle('auto', 'nvdec');
  hw.settle('nvenc', 'nvenc');
  assert.equal(hw.best, 'nvenc', 'choosing an encoder in Settings starts afresh');
  assert.equal(hw.retry, null);
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
    // Credits start 60 s after the theme does.
    assert.ok(d.credits && Math.abs(d.credits.start - (s + 60 + (d.episode === 3 ? 3 : 0))) < 3, `episode ${d.episode} credits: ${JSON.stringify(d.credits)}`);
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
  const tampered = pb.token.slice(0, -1) + (pb.token.endsWith('A') ? 'B' : 'A'); // (always a different last character)
  assert.equal((await anonGet(`/api/items/${ep.id}/stream?mt=${tampered}`)).status, 401);

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
  // (Asynchronous so this process keeps noticing the server closing idle connections meanwhile.)
  await promisify(execFile)('ffmpeg', ['-v', 'error', '-y', '-i', `${BASE}/api/items/${ep.id}/hls/360p/index.m3u8?${q}`, '-c', 'copy', out]);
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

test('an admin can set, clear and reset an intro by hand', async () => {
  const put = (body) => call('PUT', `/api/items/${ep.id}/intro`, body);
  assert.equal((await put({ start: 50, end: 40 })).status, 400);
  assert.equal((await put({ start: 0, end: 9999 })).status, 400, 'must end within the episode');
  const set = (await put({ start: 10, end: 39.04 })).data;
  assert.deepEqual(set.intro, { start: 10, end: 39, manual: true });
  // Re-running detection leaves a manual intro alone.
  await call('POST', '/api/intro/detect', { force: true });
  await until(async () => !(await call('GET', '/api/intro')).data.running);
  assert.deepEqual((await call('GET', `/api/items/${ep.id}`)).data.intro, { start: 10, end: 39, manual: true });

  const none = (await put({ none: true })).data;
  assert.equal(none.intro, null);
  assert.equal(none.introSetByHand, true);
  assert.equal((await call('GET', `/api/items/${ep.id}/playback`)).data.intro, null);

  await put({ auto: true });
  await until(async () => (await call('GET', `/api/items/${ep.id}`)).data.intro?.end > 0);

  // Credits the same way.
  const putCredits = (body) => call('PUT', `/api/items/${ep.id}/credits`, body);
  assert.equal((await putCredits({ start: 99999 })).status, 400);
  assert.deepEqual((await putCredits({ start: 70.04 })).data.credits, { start: 70, manual: true });
  assert.equal((await call('GET', `/api/items/${ep.id}/playback`)).data.credits.start, 70);
  assert.equal((await putCredits({ none: true })).data.credits, null);
  await putCredits({ auto: true });
  await until(async () => (await call('GET', `/api/items/${ep.id}`)).data.credits?.start > 0);
  assert.equal((await call('GET', `/api/items/${ep.id}`)).data.creditsSetByHand, false);
  assert.equal((await call('GET', `/api/items/${ep.id}`)).data.introSetByHand, false);
});

test('an admin can cap the quality for viewers away from home', async () => {
  const movies = (await call('GET', '/api/libraries')).data.find((l) => l.name === 'Movies');
  const big = (await call('GET', `/api/libraries/${movies.id}/items`)).data.items.find((i) => i.title === 'Big');
  const away = { 'x-forwarded-proto': 'https' }; // what Tailscale / Cloudflare add
  const pb = async (headers) => (await call('GET', `/api/items/${big.id}/playback`, null, headers)).data;

  assert.deepEqual((await pb(away)).qualities.map((q) => q.id), ['1080p', '720p', '480p', '360p'], 'no limit by default');
  assert.equal((await call('PATCH', '/api/transcoding', { remoteMaxQuality: '4K' })).status, 400);
  assert.equal((await call('PATCH', '/api/transcoding', { remoteMaxQuality: '720p' })).data.remoteMaxQuality, '720p');

  const remote = await pb(away);
  assert.equal(remote.limit, '720p');
  assert.equal(remote.originalAllowed, false, 'a 15 Mbps file is over the limit');
  assert.deepEqual(remote.qualities.map((q) => q.id), ['720p', '480p', '360p']);
  const q = `sid=${remote.sid}&mt=${remote.token}`;
  assert.equal((await anonGet(`/api/items/${big.id}/stream?mt=${remote.token}`, away)).status, 403);
  assert.equal((await anonGet(`/api/items/${big.id}/transcode?mt=${remote.token}`, away)).status, 403);
  const master = await (await anonGet(`/api/items/${big.id}/hls/master.m3u8?${q}`, away)).text();
  assert.doesNotMatch(master, /1080p/);
  assert.equal((await anonGet(`/api/items/${big.id}/hls/1080p/index.m3u8?${q}`, away)).status, 404);
  assert.equal((await anonGet(`/api/items/${big.id}/hls/1080p/seg-0.ts?${q}`, away)).status, 404);

  // At home nothing changes, and small files may still play as they are when away.
  const home = await pb({});
  assert.equal(home.limit, null);
  assert.equal(home.originalAllowed, true);
  assert.equal((await anonGet(`/api/items/${big.id}/stream?mt=${home.token}`, { range: 'bytes=0-9' })).status, 206);
  const small = (await call('GET', `/api/items/${ep.id}/playback`, null, away)).data;
  assert.equal(small.originalAllowed, true);
  assert.equal((await call('PATCH', '/api/transcoding', { remoteMaxQuality: '' })).data.remoteMaxQuality, '');
});

test('Blu-ray / DVD picture subtitles are drawn into the converted video', async () => {
  const movies = (await call('GET', '/api/libraries')).data.find((l) => l.name === 'Movies');
  const all = (await call('GET', `/api/libraries/${movies.id}/items`)).data.items;
  const film = all.find((i) => i.title === 'Boxed');
  assert.ok(film, JSON.stringify(all.map((i) => i.title)));
  const d = (await call('GET', `/api/items/${film.id}`)).data;
  assert.deepEqual(d.subtitles.map((x) => [x.id, x.burn, x.label]), [['img0', 0, 'English (Picture)']]);
  const pb = (await call('GET', `/api/items/${film.id}/playback`)).data;
  const mt = `mt=${pb.token}`;

  assert.equal((await anonGet(`/api/items/${film.id}/transcode?burn=7&${mt}`)).status, 400);
  assert.equal((await anonGet(`/api/items/${ep.id}/seekpoint?t=3&burn=0&${mt}`)).status, 401, 'token is for another item');
  assert.deepEqual(await (await anonGet(`/api/items/${film.id}/seekpoint?t=2.5&burn=0&${mt}`)).json(), { t: 2.5, start: 2.5 });

  // Progressive stream starting at 2 s: the box is on screen; without burn it is not.
  const file = path.join(ROOT, 'burn.mp4');
  await promisify(execFile)('ffmpeg', ['-v', 'error', '-y', '-i', `${BASE}/api/items/${film.id}/transcode?start=2&burn=0&${mt}`, '-c', 'copy', file]);
  assert.ok(boxBrightness(file, 0.2) > 240, 'box drawn at 2.2 s');
  assert.ok(boxBrightness(file, 2.8) < 200, 'and gone at 4.8 s');
  assert.ok(boxBrightness(path.join(ROOT, 'Movies', 'Boxed (2019).mkv'), 2.2) < 200, 'the original has no box burned in');

  // Adaptive stream: segment 0 (0–4 s) with the box at 2 s.
  const q = `sid=burn-test-1&burn=0&${mt}`;
  const master = await (await anonGet(`/api/items/${film.id}/hls/master.m3u8?${q}`)).text();
  assert.match(master, /index\.m3u8\?sid=burn-test-1&burn=0&mt=/, 'burn is kept in playlist links');
  const seg = await anonGet(`/api/items/${film.id}/hls/360p/seg-0.ts?${q}`);
  const segFile = path.join(ROOT, 'burn-seg0.ts');
  fs.writeFileSync(segFile, Buffer.from(await seg.arrayBuffer()));
  assert.ok(boxBrightness(segFile, 2) > 240, 'box drawn in the HLS segment');
  await call('DELETE', '/api/hls/burn-test-1');
});

test('an MKV streams with its original picture, cut at its keyframes', async () => {
  const film = (await call('GET', '/api/search?q=Remux')).data.movies[0];
  const src = path.join(ROOT, 'Movies', 'Remux (2021).mkv');
  const pb = (await call('GET', `/api/items/${film.id}/playback`)).data;
  assert.equal(pb.directPlay, false);
  assert.equal(pb.remux, true, 'its keyframes were found');
  const q = `sid=${pb.sid}&mt=${pb.token}`;
  assert.match(await (await anonGet(`/api/items/${film.id}/hls/master.m3u8?q=source&${q}`)).text(), /source\/index\.m3u8/);

  // Segments start on keyframes (every 2.5 s here), at least 4 s apart, and cover the whole film.
  const list = await (await anonGet(`/api/items/${film.id}/hls/source/index.m3u8?${q}`)).text();
  const lens = [...list.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
  assert.ok(lens.length >= 8 && lens.slice(0, -1).every((l) => Math.abs(l - 5) < 0.01), `5 s segments: ${lens}`);
  assert.ok(Math.abs(lens.reduce((a, b) => a + b, 0) - 41) < 0.1);

  // Jump ahead first (as a seek would), then from the start: each segment starts where the
  // playlist says, whichever job made it.
  const probe = (f, what) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', what, '-of', 'csv=p=0', f]).toString().trim().split('\n')[0]; // (MPEG-TS lists streams twice)
  for (const n of [5, 0, 1, 2]) {
    const seg = await anonGet(`/api/items/${film.id}/hls/source/seg-${n}.ts?${q}`);
    assert.equal(seg.status, 200);
    const f = path.join(ROOT, `src-${n}.ts`);
    fs.writeFileSync(f, Buffer.from(await seg.arrayBuffer()));
    assert.ok(Math.abs(Number(probe(f, 'stream=start_time')) - n * 5) < 0.1, `segment ${n} starts at ${n * 5} s`);
    assert.equal(probe(f, 'stream=codec_name'), 'h264');
  }
  // The picture isn't converted: the very same frames as in the file (5–10 s: frames 120–239).
  const md5s = (f, extra = []) => execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:v:0', ...extra, '-f', 'framemd5', '-']).toString()
    .split('\n').filter((l) => /^0,/.test(l)).map((l) => l.split(',').pop().trim());
  const seg = md5s(path.join(ROOT, 'src-1.ts'));
  assert.equal(seg.length, 120);
  assert.deepEqual(seg, md5s(src, ['-vf', 'select=between(n\\,120\\,239)', '-vsync', '0']));
  const out = path.join(ROOT, 'src-all.mp4');
  await promisify(execFile)('ffmpeg', ['-v', 'error', '-y', '-i', `${BASE}/api/items/${film.id}/hls/source/index.m3u8?${q}`, '-c', 'copy', out]);
  assert.ok(Math.abs(Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString()) - 41) < 1);
  assert.equal(probe(out, 'stream=nb_frames') || '984', '984', 'every frame');
  assert.equal((await call('DELETE', `/api/hls/${pb.sid}`)).status, 200);

  // Not for a file browsers play as it is.
  const other = (await call('GET', `/api/items/${ep.id}/playback`)).data;
  assert.equal(other.remux, false);
  assert.equal((await anonGet(`/api/items/${ep.id}/hls/source/index.m3u8?sid=${other.sid}&mt=${other.token}`)).status, 404);
});
