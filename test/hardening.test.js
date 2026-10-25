'use strict';
// Requests that arrive at the same moment, and a full server: two first-account requests make one
// admin, two people can't take one username, and someone watching isn't stopped for a newcomer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServer, until } = require('./helpers');
const { HlsManager, MAX_SESSIONS } = require('../lib/hls');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-hardening-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('two setup requests at once make one admin account', async () => {
  const srv = await startServer({ DATA_DIR: path.join(ROOT, 'setup'), TVMAZE_DISABLED: '1' });
  try {
    const tries = await Promise.all(['first', 'second', 'third'].map((name) => srv.client()('POST', '/api/auth/setup', { username: name, password: 'password1' })));
    assert.deepEqual(tries.map((r) => r.status).sort(), [201, 409, 409]);
    const admin = srv.client();
    const winner = tries.find((r) => r.status === 201).data.user.username;
    await admin('POST', '/api/auth/login', { username: winner, password: 'password1' });
    assert.equal((await admin('GET', '/api/users')).data.length, 1);

    // The same for a username asked for twice at once.
    const both = await Promise.all([1, 2].map(() => admin('POST', '/api/users', { username: 'Gran', password: 'password2' })));
    assert.deepEqual(both.map((r) => r.status).sort(), [201, 400]);
    assert.equal((await admin('GET', '/api/users')).data.filter((u) => u.username === 'Gran').length, 1);
  } finally { await srv.stop(); }
});

test('a full server keeps its viewers and tells a newcomer it’s busy', () => {
  const hls = new HlsManager(path.join(ROOT, 'hls'), { active: 'software' });
  try {
    const dropped = [];
    hls.drop = (s) => { dropped.push(s.sid); hls.sessions.delete(s.sid); };
    const now = Date.now();
    for (let i = 0; i < MAX_SESSIONS; i++) {
      hls.sessions.set(`s${i}`, { sid: `s${i}`, userId: `u${i}`, item: { id: `film${i}` }, last: now - 1000 * i });
    }
    assert.equal(hls.full('new', 'film-x'), true);
    // Everyone has asked for video recently: nobody is stopped.
    assert.throws(() => hls.makeRoom('new', 'film-x'), (err) => err.status === 503 && /busy/.test(err.message));
    assert.deepEqual(dropped, []);
    // Someone reopening what they were watching gets their own place back.
    hls.makeRoom('u3', 'film3');
    assert.deepEqual(dropped, ['s3']);
    // One that's been quiet for over a minute (paused or gone) makes way.
    hls.sessions.set('s3', { sid: 's3', userId: 'u3', item: { id: 'film3' }, last: now - 5 * 60_000 });
    hls.makeRoom('new', 'film-x');
    assert.deepEqual(dropped, ['s3', 's3']);
    // The older one-file-per-request conversions count towards the same places.
    hls.sessions.set('new', { sid: 'new', userId: 'new', item: { id: 'film-x' }, last: now });
    hls.sessions.delete('s0');
    assert.equal(hls.full('new', 'film-x'), false);
    hls.others = () => 1;
    assert.equal(hls.full('new', 'film-x'), true);
  } finally { clearInterval(hls.timer); clearInterval(hls.pacer); }
});

test('the older converter: one place per player, and no more than the limit', async () => {
  // A video big enough that a converter nobody reads from keeps running.
  const film = path.join(ROOT, 'conv', 'Films', 'Long Film (2001).mkv');
  fs.mkdirSync(path.dirname(film), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=60', '-f', 'lavfi', '-i', 'sine=duration=60',
    '-c:v', 'mpeg2video', '-q:v', '2', '-c:a', 'mp2', film]);
  const srv = await startServer({ DATA_DIR: path.join(ROOT, 'conv', 'data'), TVMAZE_DISABLED: '1', HLS_MAX_SESSIONS: '2' });
  const open = [];
  try {
    const admin = srv.client();
    await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
    const lib = (await admin('POST', '/api/libraries', { name: 'Films', type: 'movie', paths: [path.dirname(film)] })).data.id;
    const item = await until(async () => (await admin('GET', `/api/libraries/${lib}/items`)).data.items[0]);
    const { token } = (await admin('GET', `/api/items/${item.id}/playback`)).data;
    const active = async () => (await admin('GET', '/api/status')).data.activeTranscodes;
    const start = async (extra) => {
      const ac = new AbortController();
      const r = await fetch(`${srv.base}/api/items/${item.id}/transcode?start=0&mt=${token}${extra}`, { signal: ac.signal });
      open.push(ac);
      return r.status;
    };
    // Seeking five times in one player: its earlier conversions are stopped, one place used.
    for (let i = 0; i < 5; i++) assert.equal(await start('&sid=player-one'), 200);
    assert.equal(await active(), 1);
    // The same for an app that sends no session: by person, title and device.
    for (let i = 0; i < 3; i++) assert.equal(await start(''), 200);
    assert.equal(await active(), 2);
    // A different player is a newcomer: the two places are taken by people watching.
    assert.equal(await start('&sid=player-two'), 503);
    assert.equal(await active(), 2);
  } finally {
    for (const ac of open) ac.abort();
    await srv.stop();
  }
});
