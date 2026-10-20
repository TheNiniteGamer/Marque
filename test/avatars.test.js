'use strict';
// Profile pictures: a built-in face on a colour, or an uploaded photo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-avatars-'));
const DATA = path.join(ROOT, 'data');
let srv, admin, sam, samId;
// The smallest JPEG start a check looks at (the server only checks what kind of file it is).
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
test.before(async () => {
  srv = await startServer({ DATA_DIR: DATA, TVMAZE_DISABLED: '1' });
  admin = srv.client();
  sam = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  samId = (await admin('POST', '/api/users', { username: 'sam', password: 'sampass1' })).data.id;
  await sam('POST', '/api/auth/login', { username: 'sam', password: 'sampass1' });
  await sam('POST', '/api/auth/pin', { currentPassword: 'sampass1', pin: '1234' });
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('a face on a colour: checked, shown to you and on the picker; {} goes back to the initial', async () => {
  assert.equal((await sam('GET', '/api/auth/me')).data.user.avatar, null);
  assert.equal((await sam('PUT', '/api/auth/avatar', { face: 99, color: '#e5484d' })).status, 400);
  assert.equal((await sam('PUT', '/api/auth/avatar', { face: 3, color: 'red' })).status, 400);
  const r = await sam('PUT', '/api/auth/avatar', { face: 3, color: '#E5484D' });
  assert.deepEqual(r.data.user.avatar, { face: 3, color: '#e5484d' });
  assert.deepEqual((await sam('GET', '/api/auth/me')).data.user.avatar, { face: 3, color: '#e5484d' });
  const picker = (await admin('GET', '/api/profiles')).data.profiles;
  assert.deepEqual(picker.find((p) => p.username === 'sam').avatar, { face: 3, color: '#e5484d' });
  assert.equal((await sam('PUT', '/api/auth/avatar', {})).data.user.avatar, null);
});

test('a photo: only pictures, served to anyone signed in, removed with the user', async () => {
  assert.equal((await sam('POST', '/api/auth/avatar/photo', null, { raw: Buffer.from('not a picture'), type: 'image/jpeg' })).status, 400);
  const r = await sam('POST', '/api/auth/avatar/photo', null, { raw: JPEG, type: 'image/jpeg' });
  assert.equal(r.status, 200);
  assert.match(r.data.user.avatar.photo, new RegExp(`^/api/avatars/${samId}\\?v=\\d+$`));
  const got = await fetch(srv.base + r.data.user.avatar.photo, { headers: { cookie: (await loginCookie()) } });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), JPEG);
  assert.equal((await fetch(srv.base + r.data.user.avatar.photo)).status, 401, 'not without signing in');
  // Choosing a face instead removes the photo.
  await sam('PUT', '/api/auth/avatar', { face: 1, color: '#46a758' });
  assert.equal(fs.existsSync(path.join(DATA, 'avatars', samId)), false);
  await sam('POST', '/api/auth/avatar/photo', null, { raw: JPEG, type: 'image/jpeg' });
  assert.equal(fs.existsSync(path.join(DATA, 'avatars', samId)), true);
  await admin('DELETE', `/api/users/${samId}`);
  assert.equal(fs.existsSync(path.join(DATA, 'avatars', samId)), false);
});

test("only admins change someone else's picture", async () => {
  const kidId = (await admin('POST', '/api/users', { username: 'kid', password: 'kidpass1' })).data.id;
  const kid = srv.client();
  await kid('POST', '/api/auth/login', { username: 'kid', password: 'kidpass1' });
  const adminId = (await admin('GET', '/api/auth/me')).data.user.id;
  assert.equal((await kid('PUT', `/api/auth/avatar?user=${adminId}`, { face: 2, color: '#46a758' })).status, 403);
  const r = await admin('PUT', `/api/auth/avatar?user=${kidId}`, { face: 7, color: '#3e8ed0' });
  assert.equal(r.data.user.username, 'kid');
  assert.deepEqual((await kid('GET', '/api/auth/me')).data.user.avatar, { face: 7, color: '#3e8ed0' });
  assert.equal((await admin('GET', '/api/auth/me')).data.user.avatar, null, "the admin's own is unchanged");
});

async function loginCookie() {
  const r = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'password1' }) });
  return r.headers.get('set-cookie').split(';')[0];
}
