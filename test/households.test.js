'use strict';
// Households: "Who's watching?" on a device only lists the profiles from the signed-in person's
// household, so a friend's TV doesn't show (or let them switch into) the family's children.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-households-'));
let srv, admin, ids = {};
test.before(async () => {
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1' });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  for (const [name, extra] of [['mum', {}], ['kid', { noPin: true }], ['sam', { household: '  The   Smiths ' }], ['samkid', { noPin: true, household: 'The Smiths' }]]) {
    ids[name] = (await admin('POST', '/api/users', { username: name, password: `${name}pass1`, ...extra })).data.id;
  }
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const signIn = async (name) => { const c = srv.client(); await c('POST', '/api/auth/login', { username: name, password: `${name}pass1` }); return c; };
const picker = async (c) => (await c('GET', '/api/profiles')).data.profiles.map((p) => p.username);

test('each household only sees its own profiles', async () => {
  const users = (await admin('GET', '/api/users')).data;
  assert.equal(users.find((u) => u.username === 'sam').household, 'The Smiths', 'tidied');
  assert.equal(users.find((u) => u.username === 'mum').household, '');
  assert.deepEqual(await picker(await signIn('mum')), ['kid']);
  assert.deepEqual(await picker(await signIn('sam')), ['samkid']);
});

test('switching into another household’s profile is refused', async () => {
  const sam = await signIn('sam');
  assert.equal((await sam('POST', '/api/auth/switch', { userId: ids.kid })).status, 404);
  assert.equal((await sam('GET', '/api/auth/me')).data.user.username, 'sam');
  assert.equal((await sam('POST', '/api/auth/switch', { userId: ids.samkid })).status, 200, 'their own child still works');
});

test('a household name has a sensible length', async () => {
  assert.equal((await admin('PATCH', `/api/users/${ids.sam}`, { household: 'x'.repeat(41) })).status, 400);
  for (const name of ['sam', 'samkid']) assert.equal((await admin('PATCH', `/api/users/${ids[name]}`, { household: '' })).status, 200);
  assert.deepEqual(await picker(await signIn('mum')), ['kid', 'samkid'], 'back in the family: their child shows too');
});
