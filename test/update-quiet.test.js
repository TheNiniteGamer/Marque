'use strict';
// Updates restart Marquee only when nobody's watching: the go-ahead to the host's update helper,
// "Restart now", and automatic updates at night.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-quiet-'));
process.env.CONTROL_DIR = path.join(ROOT, 'control');
fs.mkdirSync(process.env.CONTROL_DIR);
const { Updater } = require('../lib/updates');
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const ctl = (f) => path.join(process.env.CONTROL_DIR, f);
const helperSays = (state) => fs.writeFileSync(ctl('status.json'), JSON.stringify({ state, heartbeat: new Date().toISOString(), readyAt: new Date().toISOString() }));
const read = (f) => JSON.parse(fs.readFileSync(ctl(f), 'utf8'));
const store = { data: { settings: {} }, save() {} };
const u = new Updater(store, path.join(__dirname, '..'));
const at = (h, m = 0, s = 0) => new Date(2026, 9, 21, h, m, s);

test('an update asks the helper to wait for a quiet moment unless told "now"', () => {
  helperSays('idle');
  u.requestUpdate({ username: 'admin' });
  assert.equal(read('update-request.json').when, 'idle');
  u.requestUpdate({ username: 'admin' }, { when: 'now' });
  assert.equal(read('update-request.json').when, 'now');
  fs.rmSync(ctl('update-request.json'));
});

test('a waiting new version gets the go-ahead after a minute with nobody watching', () => {
  helperSays('ready');
  assert.ok(u.helper().readyAt);
  u.tick(false, at(20, 0, 0));
  u.tick(true, at(20, 0, 10));
  assert.ok(!fs.existsSync(ctl('restart-ok.json')), 'not straight away');
  u.tick(false, at(20, 0, 40)); // someone pressed play
  u.tick(true, at(20, 1, 0));
  u.tick(true, at(20, 1, 50));
  assert.ok(!fs.existsSync(ctl('restart-ok.json')), 'the minute starts again');
  u.tick(true, at(20, 2, 1));
  assert.equal(read('restart-ok.json').by, 'nobody watching');
  fs.rmSync(ctl('restart-ok.json'));
});

test('"Restart now" only when something is waiting', () => {
  helperSays('idle');
  assert.throws(() => u.restartNow({ username: 'admin' }), /No update is waiting/);
  helperSays('ready');
  u.restartNow({ username: 'admin' });
  assert.equal(read('restart-ok.json').by, 'admin');
  fs.rmSync(ctl('restart-ok.json'));
});

test('automatic updates: at night, when quiet, once a night', () => {
  helperSays('idle');
  store.data.updateCheck = { forCommit: u.build.commit, status: 'available', checkedAt: Date.now() };
  u.idleSince = null;
  u.tick(true, at(3, 0)); u.tick(true, at(3, 2));
  assert.ok(!fs.existsSync(ctl('update-request.json')), 'off unless turned on');
  store.data.settings.updateAutoInstall = true;
  u.idleSince = null;
  u.tick(true, at(14, 0)); u.tick(true, at(14, 5));
  assert.ok(!fs.existsSync(ctl('update-request.json')), 'not in the daytime');
  u.idleSince = null;
  u.tick(false, at(3, 0)); u.tick(true, at(3, 1));
  assert.ok(!fs.existsSync(ctl('update-request.json')), 'not while someone was just watching');
  u.tick(true, at(3, 3));
  assert.equal(read('update-request.json').when, 'idle');
  fs.rmSync(ctl('update-request.json'));
  u.tick(true, at(3, 30));
  assert.ok(!fs.existsSync(ctl('update-request.json')), 'once a night');
});

test('a player left paused for a long time does not hold up an update', () => {
  const { Activity } = require('../lib/activity');
  const a = new Activity();
  const user = { id: 'u1', username: 'Dad' };
  a.report(user, { id: 'film' }, { client: 'tv-1', position: 10, paused: false });
  a.report(user, { id: 'film2' }, { client: 'phone-1', position: 50, paused: true });
  assert.equal(a.watching().length, 2, 'playing and just paused both count');
  const since = a.list().find((s) => s.itemId === 'film2').pausedSince;
  a.report(user, { id: 'film2' }, { client: 'phone-1', position: 50, paused: true });
  assert.equal(a.list().find((s) => s.itemId === 'film2').pausedSince, since, 'still paused since the first time');
  assert.equal(a.watching(Date.now() + 16 * 60_000).length, 1, 'paused for over 15 minutes: not counted');
  assert.equal(a.list().length, 2, 'but it still shows on the Activity page');
});
