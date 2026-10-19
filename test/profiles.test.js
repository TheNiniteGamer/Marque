'use strict';
// "Who's watching?": PINs, profile switching and its brute-force lock.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-profiles-'));
let srv, admin, tv, ids = {};
test.before(async () => {
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1' });
  admin = srv.client();
  tv = srv.client(); // a shared TV, signed in as mum
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  for (const [name, extra] of [['mum', {}], ['dad', {}], ['kid', { noPin: true }], ['lodger', {}]]) {
    ids[name] = (await admin('POST', '/api/users', { username: name, password: `${name}pass1`, ...extra })).data.id;
  }
  await tv('POST', '/api/auth/login', { username: 'mum', password: 'mumpass1' });
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const me = async (c) => (await c('GET', '/api/auth/me')).data.user?.username;

test('setting a PIN needs your password and puts you on the picker', async () => {
  const dad = srv.client();
  await dad('POST', '/api/auth/login', { username: 'dad', password: 'dadpass1' });
  assert.equal((await dad('POST', '/api/auth/pin', { currentPassword: 'wrong', pin: '1234' })).status, 400);
  assert.equal((await dad('POST', '/api/auth/pin', { currentPassword: 'dadpass1', pin: '12ab' })).status, 400);
  assert.equal((await dad('POST', '/api/auth/pin', { currentPassword: 'dadpass1', pin: '123' })).status, 400, 'at least 4 digits');
  const r = await dad('POST', '/api/auth/pin', { currentPassword: 'dadpass1', pin: '4321' });
  assert.equal(r.data.user.hasPin, true);

  const list = (await tv('GET', '/api/profiles')).data;
  assert.equal(list.current, ids.mum);
  assert.deepEqual(list.profiles.map((p) => [p.username, p.needsPin]), [['dad', true], ['kid', false]], 'lodger has no PIN and is not listed');
});

test('switching needs the right PIN; kids allowed without one', async () => {
  assert.equal((await tv('POST', '/api/auth/switch', { userId: ids.dad, pin: '0000' })).status, 401);
  assert.equal(await me(tv), 'mum', 'still mum after a wrong PIN');
  assert.equal((await tv('POST', '/api/auth/switch', { userId: ids.lodger })).status, 404, 'not on the picker');
  const ok = await tv('POST', '/api/auth/switch', { userId: ids.dad, pin: '4321' });
  assert.equal(ok.data.user.username, 'dad');
  assert.equal(await me(tv), 'dad');
  assert.equal((await tv('POST', '/api/auth/switch', { userId: ids.kid })).data.user.username, 'kid');
  assert.equal(await me(tv), 'kid');
});

test('a linked Roku switching profile gets a new token and stays linked', async () => {
  const call = (method, url, { token, body } = {}) => fetch(srv.base + url, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const mum = srv.client();
  await mum('POST', '/api/auth/login', { username: 'mum', password: 'mumpass1' });
  const pair = await (await call('POST', '/api/devices/pair', { body: { name: 'Bedroom Roku' } })).json();
  await mum('POST', '/api/devices/link', { code: pair.code });
  const { token } = await (await call('GET', `/api/devices/pair/${pair.id}`)).json();
  const r = await (await call('POST', '/api/auth/switch', { token, body: { userId: ids.kid } })).json();
  assert.equal(r.user.username, 'kid');
  assert.ok(r.token && r.token !== token, 'a new token for the new profile');
  assert.equal((await call('GET', '/api/auth/me', { token })).status, 401, 'the old one is gone');
  assert.equal((await (await call('GET', '/api/auth/me', { token: r.token })).json()).user.username, 'kid');
  assert.deepEqual((await (await call('GET', '/api/devices', { token: r.token })).json()).map((d) => d.name), ['Bedroom Roku'], 'still a linked TV');
  assert.equal((await mum('GET', '/api/devices')).data.length, 0);
});

test('five wrong PINs lock that profile for a while', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await tv('POST', '/api/auth/switch', { userId: ids.dad, pin: `000${i}` })).status, 401);
  const locked = await tv('POST', '/api/auth/switch', { userId: ids.dad, pin: '4321' });
  assert.equal(locked.status, 429, 'even the right PIN is refused while locked');
  assert.equal(await me(tv), 'kid');
});

test('admins always need a PIN, and removing a PIN takes you off the picker', async () => {
  await admin('PATCH', `/api/users/${ids.kid}`, { noPin: false });
  assert.deepEqual((await admin('GET', '/api/profiles')).data.profiles.map((p) => p.username), ['dad']);
  // "No PIN needed" has no effect on an admin account.
  const me2 = (await admin('GET', '/api/auth/me')).data.user;
  await admin('PATCH', `/api/users/${me2.id}`, { noPin: true });
  assert.ok(!(await admin('GET', '/api/profiles')).data.profiles.some((p) => p.username === 'admin'));
  const dad = srv.client();
  await dad('POST', '/api/auth/login', { username: 'dad', password: 'dadpass1' });
  assert.equal((await dad('POST', '/api/auth/pin', { currentPassword: 'dadpass1', pin: '' })).data.user.hasPin, false);
  assert.deepEqual((await admin('GET', '/api/profiles')).data.profiles, []);
});
