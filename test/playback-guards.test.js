'use strict';
// Limits around playing: phone downloads keep to a kid's screen time, a conversion a player has
// stopped taking doesn't run for ever, and players asking for the same embedded subtitles at once
// share one extraction.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { clip, startServer, until } = require('./helpers');
const media = require('../lib/media');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-playback-guards-'));
const BIG = path.join(ROOT, 'Films', 'Big (2020).mp4');
let srv, admin, kid, small, big;

test.before(async () => {
  clip(path.join(ROOT, 'Films', 'Small (2019).mp4'));
  // Big enough (about 50 MB) that a player that stops reading leaves the conversion waiting.
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=30',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p', BIG]);
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1', TRANSCODE_STALL_MS: '1500', AUTO_LIBRARIES: `Films:movie:${path.join(ROOT, 'Films')}` });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  await until(async () => (await admin('GET', '/api/libraries')).data.every((l) => l.scannedAt));
  const lib = (await admin('GET', '/api/libraries')).data[0].id;
  const items = (await admin('GET', `/api/libraries/${lib}/items`)).data.items;
  small = items.find((i) => i.title === 'Small');
  big = items.find((i) => i.title === 'Big');
  // A kid whose bedtime is now.
  const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const bedtime = { start: hm(new Date(Date.now() - 3600_000)), end: hm(new Date(Date.now() + 3600_000)) };
  await admin('POST', '/api/users', { username: 'kid', password: 'password2', bedtime });
  kid = srv.client();
  await kid('POST', '/api/auth/login', { username: 'kid', password: 'password2' });
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('phone downloads keep to bedtime, like playing', async () => {
  assert.equal((await kid('GET', `/api/items/${small.id}/stream`)).status, 403, 'playing is refused');
  for (const [method, url, body] of [
    ['GET', `/api/items/${small.id}/offline`],
    ['POST', `/api/items/${small.id}/offline`, { quality: '480p', audio: 0 }],
    ['GET', `/api/items/${small.id}/offline/file?quality=480p&audio=0`],
  ]) {
    const r = await kid(method, url, body);
    assert.equal(r.status, 403, `${method} ${url}`);
    assert.match(r.data.error, /bedtime/);
  }
  assert.equal((await admin('GET', `/api/items/${small.id}/offline`)).status, 200, 'others can still download');
});

test('a conversion the player has stopped taking is stopped after a while', async () => {
  const cookie = (await fetch(`${srv.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'password1' }) }))
    .headers.get('set-cookie').split(';')[0];
  const conversions = async () => (await admin('GET', '/api/activity')).data.others.filter((c) => c.kind === 'transcode').length;
  const req = http.get(`${srv.base}/api/items/${big.id}/transcode?start=0`, { headers: { cookie } });
  try {
    const res = await new Promise((resolve, reject) => { req.on('response', resolve); req.on('error', reject); });
    assert.equal(res.statusCode, 200);
    let got = 0;
    // The player takes the start, then stops reading (but doesn't hang up).
    await new Promise((resolve) => res.once('data', (c) => { got += c.length; res.pause(); resolve(); }));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await conversions(), 1, 'still waiting for the player');
    await until(async () => (await conversions()) === 0, 10_000);
    // What was already on its way still arrives; the rest was never made.
    res.on('data', (c) => { got += c.length; });
    res.resume();
    await new Promise((resolve) => { res.on('end', resolve); res.on('close', resolve); });
    assert.ok(got < fs.statSync(BIG).size * 0.8, `${got} of ${fs.statSync(BIG).size} bytes sent`);
  } finally { req.destroy(); }
});

test('the same embedded subtitles asked for twice at once are extracted once, at low priority', async () => {
  const film = path.join(ROOT, 'subs', 'Subbed.mkv');
  const srt = path.join(ROOT, 'subs', 'Subbed.srt');
  clip(path.join(ROOT, 'subs', 'plain.mp4'), 2);
  fs.writeFileSync(srt, '1\n00:00:00,500 --> 00:00:01,500\nHello there\n');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(ROOT, 'subs', 'plain.mp4'), '-i', srt, '-map', '0', '-map', '1', '-c', 'copy', '-c:s', 'srt', film]);
  const lowered = [];
  const setPriority = os.setPriority;
  os.setPriority = (pid, p) => { lowered.push([pid, p]); };
  try {
    const a = media.extractSubtitle(film, 0);
    const b = media.extractSubtitle(film, 0);
    assert.equal(a, b, 'the second waits for the first');
    const vtt = await a;
    assert.match(vtt, /^WEBVTT/);
    assert.match(vtt, /Hello there/);
    assert.equal(lowered.length, 1, 'one ffmpeg');
    assert.equal(lowered[0][1], os.constants.priority.PRIORITY_LOW);
    const again = media.extractSubtitle(film, 0);
    assert.notEqual(again, a, 'asked for again later: extracted again');
    assert.equal(await again, vtt);
  } finally { os.setPriority = setPriority; }
});
