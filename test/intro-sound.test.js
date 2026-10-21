'use strict';
// The opening sound: an admin can upload their own (kept on the server), or go back to the built-in one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServer } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-introsound-'));
let srv, admin, user;
test.before(async () => {
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1' });
  admin = srv.client();
  user = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  await admin('POST', '/api/users', { username: 'sam', password: 'sampass1' });
  await user('POST', '/api/auth/login', { username: 'sam', password: 'sampass1' });
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const builtIn = fs.readFileSync(path.join(__dirname, '..', 'public', 'sounds', 'intro.mp3'));
const served = async () => Buffer.from(await (await fetch(srv.base + '/sounds/intro.mp3')).arrayBuffer());

test('an uploaded sound replaces the built-in one, without its silent start; removing it goes back', async () => {
  // One second of silence, then a 2-second tone, as a WAV.
  const wav = path.join(ROOT, 'tone.wav');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=1', '-f', 'lavfi', '-i', 'sine=f=440:d=2',
    '-filter_complex', '[0][1]concat=n=2:v=0:a=1', wav]);
  assert.deepEqual(await served(), builtIn);
  assert.equal((await user('PUT', '/api/intro-sound', null, { raw: fs.readFileSync(wav), type: 'audio/wav' })).status, 403, 'admins only');
  assert.equal((await admin('PUT', '/api/intro-sound', null, { raw: Buffer.from('not a sound'), type: 'audio/mpeg' })).status, 400);
  const r = await admin('PUT', '/api/intro-sound', null, { raw: fs.readFileSync(wav), type: 'audio/wav' });
  assert.deepEqual(r.data, { custom: true });
  assert.deepEqual((await admin('GET', '/api/intro-sound')).data, { custom: true });
  assert.ok(fs.existsSync(path.join(ROOT, 'data', 'custom', 'intro-sound.mp3')), 'kept where backups include it');
  const mp3 = path.join(ROOT, 'got.mp3');
  fs.writeFileSync(mp3, await served());
  const secs = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp3]).toString());
  assert.ok(secs > 1.8 && secs < 2.4, `the silent second is cut (${secs}s)`);
  await admin('DELETE', '/api/intro-sound');
  assert.deepEqual(await served(), builtIn);
});
