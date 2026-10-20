'use strict';
// Admins resetting passwords and unlocking people who are locked out.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-accounts-'));
let srv, admin, ids = {};
const user = (name) => (async () => (await admin('GET', '/api/users')).data.find((u) => u.username === name))();
test.before(async () => {
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data') });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  ids.sam = (await admin('POST', '/api/users', { username: 'sam', password: 'sampass11' })).data.id;
  ids.kid = (await admin('POST', '/api/users', { username: 'kid', password: 'kidpass11' })).data.id;
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('a temporary password: they must choose their own before anything else', async () => {
  const sam = srv.client();
  await sam('POST', '/api/auth/login', { username: 'sam', password: 'sampass11' });
  assert.equal((await sam('GET', '/api/home')).status, 200);
  const r = (await admin('POST', `/api/users/${ids.sam}/reset-password`, {})).data;
  assert.match(r.temporaryPassword, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  assert.equal(r.user.mustChangePassword, true);
  assert.equal((await sam('GET', '/api/home')).status, 401, 'signed out everywhere');
  assert.equal((await srv.client()('POST', '/api/auth/login', { username: 'sam', password: 'sampass11' })).status, 401, 'the old password is gone');
  const again = srv.client();
  const login = await again('POST', '/api/auth/login', { username: 'sam', password: r.temporaryPassword });
  assert.equal(login.data.user.mustChangePassword, true);
  const blocked = await again('GET', '/api/home');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.mustChangePassword, true);
  assert.equal((await again('POST', '/api/auth/password', { newPassword: r.temporaryPassword })).status, 400, 'not the temporary one again');
  assert.equal((await again('POST', '/api/auth/password', { newPassword: 'short' })).status, 400);
  assert.equal((await again('POST', '/api/auth/password', { newPassword: 'mynewpass1' })).status, 200, 'no current password asked for');
  assert.equal((await again('GET', '/api/home')).status, 200);
  assert.equal((await again('GET', '/api/auth/me')).data.user.mustChangePassword, false);
  assert.equal((await again('POST', '/api/auth/password', { newPassword: 'another11' })).status, 400, 'afterwards the current password is needed again');
});

test('or a password the admin chooses, without forcing a change; and a forgotten PIN removed', async () => {
  const kid = srv.client();
  await kid('POST', '/api/auth/login', { username: 'kid', password: 'kidpass11' });
  await kid('POST', '/api/auth/pin', { currentPassword: 'kidpass11', pin: '1234' });
  assert.equal((await user('kid')).hasPin, true);
  assert.equal((await admin('POST', `/api/users/${ids.kid}/reset-password`, { password: 'seven77' })).status, 400, '8 characters');
  const r = (await admin('POST', `/api/users/${ids.kid}/reset-password`, { password: 'chosen888', mustChange: false, signOut: false, removePin: true })).data;
  assert.equal(r.temporaryPassword, null);
  assert.equal(r.user.mustChangePassword, false);
  assert.equal(r.user.hasPin, false);
  assert.equal((await kid('GET', '/api/home')).status, 200, 'still signed in');
  assert.equal((await srv.client()('POST', '/api/auth/login', { username: 'kid', password: 'chosen888' })).status, 200);
  assert.equal((await kid('POST', `/api/users/${ids.sam}/reset-password`, {})).status, 403, 'admins only');
});

test('locked out by wrong passwords or PINs: shown, and Unlock lifts it', async () => {
  const someone = srv.client();
  for (let i = 0; i < 8; i++) await someone('POST', '/api/auth/login', { username: 'sam', password: `nope${i}` });
  assert.equal((await someone('POST', '/api/auth/login', { username: 'sam', password: 'mynewpass1' })).status, 429);
  const locked = await user('sam');
  assert.ok(locked.locks.signIn, 'shown as locked');
  assert.equal(locked.locks.pin, null);
  const after = (await admin('POST', `/api/users/${ids.sam}/unlock`)).data;
  assert.equal(after.locks.signIn, null);
  assert.equal((await someone('POST', '/api/auth/login', { username: 'sam', password: 'mynewpass1' })).status, 200, 'the device they used works again');
  // Wrong PINs on the shared TV.
  await someone('POST', '/api/auth/pin', { currentPassword: 'mynewpass1', pin: '4321' });
  const tv = srv.client();
  await tv('POST', '/api/auth/login', { username: 'kid', password: 'chosen888' });
  for (let i = 0; i < 5; i++) await tv('POST', '/api/auth/switch', { userId: ids.sam, pin: `000${i}` });
  assert.equal((await tv('POST', '/api/auth/switch', { userId: ids.sam, pin: '4321' })).status, 429);
  assert.ok((await user('sam')).locks.pin);
  await admin('POST', `/api/users/${ids.sam}/unlock`);
  assert.equal((await tv('POST', '/api/auth/switch', { userId: ids.sam, pin: '4321' })).status, 200);
});
