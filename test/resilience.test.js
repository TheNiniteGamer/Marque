'use strict';
// Things going wrong around Marquee: a disk that can't be written, someone online guessing at a
// family member's password, a request landing where the asker can't see it, a converted copy whose
// drive is unplugged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../lib/store');
const { Auth } = require('../lib/auth');
const requests = require('../lib/requests');
const { Optimizer } = require('../lib/optimize');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-resilience-'));
test.after(() => { fs.chmodSync(path.join(ROOT, 'ro'), 0o755); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('a save that fails (a full disk) is tried again instead of stopping the server', () => {
  const dir = path.join(ROOT, 'ro');
  fs.mkdirSync(dir);
  const store = new Store(path.join(dir, 'db.json'));
  store.data.settings = { name: 'before' };
  store.flush();
  fs.chmodSync(dir, 0o555); // can't write any more
  store.data.settings.name = 'after';
  assert.doesNotThrow(() => store.flushOrRetry());
  assert.ok(store.saveError, 'the problem is remembered for the health check');
  assert.ok(store.timer, 'and another try is lined up');
  fs.chmodSync(dir, 0o755);
  store.flushOrRetry();
  assert.equal(store.saveError, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).settings.name, 'after', 'nothing was lost');
  clearTimeout(store.timer);
});

test('wrong passwords from outside can’t lock someone out at home', () => {
  const auth = new Auth({ data: { users: [{ id: 'u1', username: 'Joshua' }], sessions: {} }, save() {} });
  for (let i = 0; i < 25; i++) auth.recordFailure(`203.0.113.${i % 5}`, 'joshua', 'away');
  assert.equal(auth.isLimited('203.0.113.99', 'joshua', 'away'), true, 'more guesses from outside are refused');
  assert.equal(auth.isLimited('192.168.1.20', 'joshua', 'home'), false, 'but at home Joshua can still sign in');
  assert.ok(auth.lockInfo({ id: 'u1', username: 'Joshua' }).signIn, 'the admin sees the lock');
  auth.unlock({ id: 'u1', username: 'Joshua' });
  assert.equal(auth.isLimited('203.0.113.99', 'joshua', 'away'), false, 'and Unlock lifts it');
});

test('a request is "here" even when it landed in a library the asker can’t see', () => {
  const store = { data: {
    users: [{ id: 'kid', username: 'kid', role: 'user', libraries: ['kids'] }],
    libraries: [{ id: 'films', name: 'Films', type: 'movie' }, { id: 'kids', name: 'Kids', type: 'movie' }],
    items: { m1: { id: 'm1', type: 'movie', libraryId: 'films', title: 'The Matrix', year: 1999, meta: { provider: 'tmdb', providerId: '603', title: 'The Matrix', year: 1999 } } },
    shows: {}, notifications: {}, settings: {},
    requests: { r1: { id: 'r1', kind: 'movie', status: 'approved', userIds: ['kid'], title: 'The Matrix', year: 1999, provider: 'tmdb', providerId: '603', createdAt: 1 } },
  }, save() {}, rev: 1 };
  assert.equal(requests.checkArrivals(store), 1);
  assert.equal(store.data.requests.r1.status, 'available', 'not "on its way" for ever');
  assert.equal((store.data.notifications.kid || []).length, 0, 'the kid isn’t told about a film they can’t open');
});

test('a converted copy whose drive is unplugged is kept for when it’s back', () => {
  const items = { m1: { id: 'm1', type: 'movie', mtime: 5, optimized: { file: path.join(ROOT, 'gone-drive', 'copies', 'm1-5.mp4'), sourceMtime: 5 } } };
  const o = new Optimizer({ data: { items, settings: {} }, save() {} }, path.join(ROOT, 'copies'), null, { probe: async () => ({}) });
  o.cleanup();
  assert.ok(items.m1.optimized, 'still known');
  fs.mkdirSync(path.dirname(items.m1.optimized.file), { recursive: true }); // the drive is back, but the copy isn't on it
  o.cleanup();
  assert.equal(items.m1.optimized, undefined, 'now it is really gone');
});
