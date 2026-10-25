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

test('accounts: changes at the same moment are all-or-nothing, and checked against each other', async () => {
  const srv = await startServer({ DATA_DIR: path.join(ROOT, 'accounts'), TVMAZE_DISABLED: '1' });
  try {
    const a = srv.client();
    await a('POST', '/api/auth/setup', { username: 'ann', password: 'password1' });
    const bob = (await a('POST', '/api/users', { username: 'bob', password: 'password2', role: 'admin' })).data;
    const b = srv.client();
    await b('POST', '/api/auth/login', { username: 'bob', password: 'password2' });
    const annId = (await a('GET', '/api/auth/me')).data.user.id;
    // Two admins take each other's admin away (and change passwords, which takes a moment).
    const demote = await Promise.all([
      a('PATCH', `/api/users/${bob.id}`, { role: 'user', password: 'bobnew123' }),
      b('PATCH', `/api/users/${annId}`, { role: 'user', password: 'annnew123' }),
    ]);
    assert.deepEqual(demote.map((r) => r.status).sort(), [200, 400]);
    const db = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'accounts', 'db.json'), 'utf8'));
    await new Promise((r) => setTimeout(r, 1800)); // (saved shortly after)
    assert.equal(db().users.filter((u) => u.role === 'admin').length, 1, 'one admin is left');
    // The refused one changed nothing, its password included.
    const refused = demote.find((r) => r.status === 400) === demote[0] ? { name: 'bob', pw: 'password2' } : { name: 'ann', pw: 'password1' };
    const c = srv.client();
    assert.equal((await c('POST', '/api/auth/login', { username: refused.name, password: refused.pw })).status, 200, 'old password still works');

    // Two edits after one username, both with new passwords: the refused one keeps its password.
    const admin = (await c('GET', '/api/auth/me')).data.user.role === 'admin' ? c : srv.client();
    if (admin !== c) await admin('POST', '/api/auth/login', { username: refused.name === 'ann' ? 'bob' : 'ann', password: refused.name === 'ann' ? 'bobnew123' : 'annnew123' });
    const u1 = (await admin('POST', '/api/users', { username: 'cara', password: 'password3' })).data;
    const u2 = (await admin('POST', '/api/users', { username: 'dan', password: 'password4' })).data;
    const both = await Promise.all([admin('PATCH', `/api/users/${u1.id}`, { username: 'same', password: 'caranew12' }), admin('PATCH', `/api/users/${u2.id}`, { username: 'same', password: 'dannew123' })]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 400]);
    const [loser, oldPw] = both[0].status === 400 ? ['cara', 'password3'] : ['dan', 'password4'];
    assert.equal((await srv.client()('POST', '/api/auth/login', { username: loser, password: oldPw })).status, 200);
  } finally { await srv.stop(); }
});

test('a forced password change needs a real new password', async () => {
  const srv = await startServer({ DATA_DIR: path.join(ROOT, 'forced'), TVMAZE_DISABLED: '1' });
  try {
    const admin = srv.client();
    await admin('POST', '/api/auth/setup', { username: 'ann', password: 'password1' });
    const kid = (await admin('POST', '/api/users', { username: 'kid', password: 'password2' })).data;
    const temp = (await admin('POST', `/api/users/${kid.id}/reset-password`, {})).data.temporaryPassword;
    const k = srv.client();
    await k('POST', '/api/auth/login', { username: 'kid', password: temp });
    for (const body of [{}, { newPassword: '' }, { newPassword: 'short' }]) assert.equal((await k('POST', '/api/auth/password', body)).status, 400, JSON.stringify(body));
    assert.equal((await k('GET', '/api/libraries')).status, 403, 'still has to choose one');
    assert.equal((await k('POST', '/api/auth/password', { newPassword: 'kidschoice1' })).status, 200);
    assert.equal((await k('GET', '/api/libraries')).status, 200);
  } finally { await srv.stop(); }
});

test('guessing a PIN many times at once is still only five guesses', async () => {
  const srv = await startServer({ DATA_DIR: path.join(ROOT, 'pins'), TVMAZE_DISABLED: '1' });
  try {
    const admin = srv.client();
    await admin('POST', '/api/auth/setup', { username: 'ann', password: 'password1' });
    await admin('POST', '/api/auth/pin', { currentPassword: 'password1', pin: '4321' });
    const annId = (await admin('GET', '/api/auth/me')).data.user.id;
    // (A TV signed in as someone else, asking to switch to Ann.)
    await admin('POST', '/api/users', { username: 'kid', password: 'password2' });
    const tv = srv.client();
    await tv('POST', '/api/auth/login', { username: 'kid', password: 'password2' });
    const tries = await Promise.all(Array.from({ length: 20 }, (_, i) => tv('POST', '/api/auth/switch', { userId: annId, pin: String(1000 + i) })));
    const wrong = tries.filter((r) => r.status === 401).length;
    assert.ok(wrong <= 5, `${wrong} guesses were checked`);
    assert.equal(tries.filter((r) => r.status === 429).length, 20 - wrong);
    assert.equal((await tv('POST', '/api/auth/switch', { userId: annId, pin: '4321' })).status, 429, 'locked, even with the right one');
  } finally { await srv.stop(); }
});

test('a new password stops that person’s playback links, and nobody else’s', async () => {
  const film = path.join(ROOT, 'links', 'Films', 'Clip (2001).mp4');
  require('./helpers').clip(film);
  const srv = await startServer({ DATA_DIR: path.join(ROOT, 'links', 'data'), TVMAZE_DISABLED: '1' });
  try {
    const admin = srv.client();
    await admin('POST', '/api/auth/setup', { username: 'ann', password: 'password1' });
    const lib = (await admin('POST', '/api/libraries', { name: 'Films', type: 'movie', paths: [path.dirname(film)] })).data.id;
    const item = await until(async () => (await admin('GET', `/api/libraries/${lib}/items`)).data.items[0]);
    const bob = (await admin('POST', '/api/users', { username: 'bob', password: 'password2' })).data;
    const b = srv.client();
    await b('POST', '/api/auth/login', { username: 'bob', password: 'password2' });
    const link = async (c) => (await c('GET', `/api/items/${item.id}/playback`)).data.token;
    const plays = async (token) => (await fetch(`${srv.base}/api/items/${item.id}/stream?mt=${token}`, { headers: { range: 'bytes=0-9' } })).status;
    const [annLink, bobLink] = [await link(admin), await link(b)];
    assert.equal(await plays(bobLink), 206);
    // Ann changes her own password: Bob's link carries on, hers stops.
    assert.equal((await admin('POST', '/api/auth/password', { currentPassword: 'password1', newPassword: 'annnew123' })).status, 200);
    assert.equal(await plays(bobLink), 206, 'someone else’s link still plays');
    assert.notEqual(await plays(annLink), 206);
    // An admin changes Bob's password: his link stops too.
    assert.equal((await admin('PATCH', `/api/users/${bob.id}`, { password: 'bobnew123' })).status, 200);
    assert.notEqual(await plays(bobLink), 206);
    assert.equal(await plays(await link(admin)), 206, 'new links work');
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
    assert.equal(hls.full(), true);
    // Everyone has asked for video recently: nobody is stopped.
    assert.throws(() => hls.makeRoom(), (err) => err.status === 503 && /busy/.test(err.message));
    assert.deepEqual(dropped, []);
    // The same profile starting the same film on another TV is another viewer: nobody is stopped.
    assert.throws(() => hls.makeRoom(), (err) => err.status === 503);
    assert.deepEqual(dropped, []);
    // One that's been quiet for over a minute (paused or gone) makes way.
    hls.sessions.set('s3', { sid: 's3', userId: 'u3', item: { id: 'film3' }, last: now - 5 * 60_000 });
    hls.makeRoom();
    assert.deepEqual(dropped, ['s3']);
    // The older one-file-per-request conversions count towards the same places.
    hls.sessions.set('new', { sid: 'new', userId: 'new', item: { id: 'film-x' }, last: now });
    hls.sessions.delete('s0');
    assert.equal(hls.full(), false);
    hls.others = () => 1;
    assert.equal(hls.full(), true);
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
