'use strict';
// Guessing passwords: the sign-in limits hold however the guesses arrive, all at once included, and
// also cover the current password asked for when changing your password or PIN.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-guesses-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// A fresh server with an admin (ann) and someone else (bob), each signed in.
async function setUp(name) {
  const srv = await startServer({ DATA_DIR: path.join(ROOT, name), TVMAZE_DISABLED: '1' });
  const ann = srv.client();
  await ann('POST', '/api/auth/setup', { username: 'ann', password: 'password1' });
  await ann('POST', '/api/users', { username: 'bob', password: 'password2' });
  const bob = srv.client();
  await bob('POST', '/api/auth/login', { username: 'bob', password: 'password2' });
  return { srv, ann, bob };
}

test('many wrong passwords sent at once are still only eight guesses', async () => {
  const { srv } = await setUp('login');
  try {
    const tries = await Promise.all(Array.from({ length: 25 }, (_, i) => srv.client()('POST', '/api/auth/login', { username: 'bob', password: `guess${i}xx` })));
    const checked = tries.filter((r) => r.status === 401).length;
    assert.ok(checked <= 8, `${checked} guesses were checked`);
    assert.equal(tries.filter((r) => r.status === 429).length, 25 - checked);
    assert.equal((await srv.client()('POST', '/api/auth/login', { username: 'bob', password: 'password2' })).status, 429, 'locked, even with the right one');
  } finally { await srv.stop(); }
});

test('the current password asked for by a PIN change is limited like signing in', async () => {
  const { srv, bob } = await setUp('pin');
  try {
    const tries = await Promise.all(Array.from({ length: 15 }, (_, i) => bob('POST', '/api/auth/pin', { currentPassword: `guess${i}xx`, pin: '1234' })));
    const checked = tries.filter((r) => r.status === 400).length;
    assert.ok(checked <= 8, `${checked} guesses were checked`);
    assert.equal(tries.filter((r) => r.status === 429).length, 15 - checked);
    const right = await bob('POST', '/api/auth/pin', { currentPassword: 'password2', pin: '1234' });
    assert.equal(right.status, 429);
    assert.match(right.data.error, /Too many wrong passwords/);
    assert.equal((await bob('GET', '/api/auth/me')).data.user.hasPin, false, 'no PIN was set');
  } finally { await srv.stop(); }
});

test('the current password asked for by a password change is limited too, and a right one still counts', async () => {
  const { srv, ann, bob } = await setUp('password');
  try {
    // A right password isn't held against anyone.
    for (let i = 0; i < 10; i++) assert.equal((await ann('POST', '/api/auth/pin', { currentPassword: 'password1', pin: '' })).status, 200);
    for (let i = 0; i < 8; i++) assert.equal((await bob('POST', '/api/auth/password', { currentPassword: `wrong${i}xx`, newPassword: 'bobnew123' })).status, 400);
    assert.equal((await bob('POST', '/api/auth/password', { currentPassword: 'password2', newPassword: 'bobnew123' })).status, 429);
    assert.equal((await srv.client()('POST', '/api/auth/login', { username: 'bob', password: 'password2' })).status, 429, 'the same limit as signing in');
    // An admin's Unlock lifts it.
    const bobId = (await ann('GET', '/api/users')).data.find((u) => u.username === 'bob').id;
    assert.equal((await ann('POST', `/api/users/${bobId}/unlock`)).status, 200);
    assert.equal((await bob('POST', '/api/auth/password', { currentPassword: 'password2', newPassword: 'bobnew123' })).status, 200);
  } finally { await srv.stop(); }
});
