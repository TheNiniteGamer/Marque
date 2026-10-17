'use strict';
// Update checks (against a mock GitHub API) and the handshake with the host update helper.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-updates-'));
const CONTROL = path.join(ROOT, 'control');
fs.mkdirSync(CONTROL);
const OLD = 'a'.repeat(40);
const NEW = 'c'.repeat(40);
let mode = 'normal';

const github = http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (mode === 'limited') return send(403, { message: 'API rate limit exceeded' });
  if (!req.headers['user-agent']) return send(403, { message: 'User-Agent required' });
  if (req.url === '/repos/me/marquee/commits/main') return send(200, { sha: NEW, commit: { message: 'Newest change\n\nDetails', committer: { date: '2026-10-01T00:00:00Z' } } });
  if (req.url === `/repos/me/marquee/compare/${OLD}...main`) {
    return send(200, { status: 'ahead', ahead_by: 2, commits: [
      { sha: 'b'.repeat(40), html_url: 'https://github.com/me/marquee/commit/bbb', commit: { message: 'Older change', committer: { date: '2026-09-01T00:00:00Z' } } },
      { sha: NEW, html_url: 'https://github.com/me/marquee/commit/ccc', commit: { message: 'Newest change\n\nDetails\n\nUpdate-Type: significant', committer: { date: '2026-10-01T00:00:00Z' } } },
    ] });
  }
  send(404, { message: 'Not Found' });
});

let base;
const servers = [];
async function boot(commit) {
  const s = await startServer({
    DATA_DIR: path.join(ROOT, `data-${servers.length}`), UPDATE_API_BASE: base, MARQUEE_REPO: 'me/marquee',
    MARQUEE_COMMIT: commit, CONTROL_DIR: CONTROL, TVMAZE_DISABLED: '1',
  });
  servers.push(s);
  const admin = s.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  return { s, admin };
}
const writeStatus = (obj) => fs.writeFileSync(path.join(CONTROL, 'status.json'), JSON.stringify(obj));

test.before(async () => {
  await new Promise((r) => github.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${github.address().port}`;
});
test.after(async () => {
  for (const s of servers) await s.stop();
  github.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('an older build sees the new changes, newest first', async () => {
  const { admin } = await boot(OLD);
  const r = (await admin('POST', '/api/updates/check')).data;
  assert.equal(r.build.commit, OLD);
  assert.equal(r.build.install, 'docker');
  assert.equal(r.check.status, 'available');
  assert.equal(r.check.behindBy, 2);
  assert.deepEqual(r.check.changes.map((c) => c.message), ['Newest change', 'Older change']);
  assert.deepEqual(r.check.changes.map((c) => c.significant), [true, false], 'the "Update-Type: significant" marker is picked up');
  assert.equal(r.check.significant, true);
  const status = (await admin('GET', '/api/status')).data;
  assert.equal(status.updateAvailable, true);
  assert.equal(status.significantUpdate, true);
});

test('the latest build is up to date', async () => {
  const { admin } = await boot(NEW);
  assert.equal((await admin('POST', '/api/updates/check')).data.check.status, 'current');
  assert.equal((await admin('GET', '/api/status')).data.updateAvailable, false);
});

test('an unknown build and GitHub errors are reported, not crashed on', async () => {
  const { admin } = await boot('not-a-sha');
  const r = (await admin('POST', '/api/updates/check')).data;
  assert.equal(r.build.commit, null);
  assert.equal(r.check.status, 'unknown');
  assert.equal(r.check.latest.message, 'Newest change');
  mode = 'limited';
  const limited = (await admin('POST', '/api/updates/check')).data.check;
  mode = 'normal';
  assert.equal(limited.status, 'error');
  assert.match(limited.error, /rate limit/);
});

test('"Update now" needs a live helper, then leaves a request for it', async () => {
  const { s, admin } = await boot(OLD);
  fs.rmSync(path.join(CONTROL, 'status.json'), { force: true });
  let r = await admin('POST', '/api/updates/apply');
  assert.equal(r.status, 409);
  assert.match(r.data.error, /helper/);

  writeStatus({ heartbeat: new Date(Date.now() - 10 * 60_000).toISOString(), state: 'idle' });
  assert.equal((await admin('GET', '/api/updates')).data.helper.alive, false, 'stale heartbeat = not running');

  writeStatus({ heartbeat: new Date().toISOString(), state: 'idle' });
  r = await admin('POST', '/api/updates/apply');
  assert.equal(r.status, 202);
  assert.equal(r.data.helper.pending, true);
  const req = JSON.parse(fs.readFileSync(path.join(CONTROL, 'update-request.json'), 'utf8'));
  assert.equal(req.by, 'admin');

  // The helper reports progress through status.json (written with a BOM by some Windows tools).
  fs.rmSync(path.join(CONTROL, 'update-request.json'));
  fs.writeFileSync(path.join(CONTROL, 'status.json'), '﻿' + JSON.stringify({ heartbeat: new Date().toISOString(), state: 'updating', message: 'Rebuilding…', log: ['a', 'b'] }));
  const u = (await admin('GET', '/api/updates')).data.helper;
  assert.equal(u.state, 'updating');
  assert.deepEqual(u.log, ['a', 'b']);
  assert.equal((await admin('POST', '/api/updates/apply')).status, 409, 'no double updates');
  assert.equal((await admin('GET', '/api/status')).data.updating, true);

  const user = s.client();
  await admin('POST', '/api/users', { username: 'kid', password: 'password2' });
  await user('POST', '/api/auth/login', { username: 'kid', password: 'password2' });
  assert.equal((await user('GET', '/api/updates')).status, 403);
  assert.equal((await user('GET', '/api/status')).data.updateAvailable, undefined);
});

test('after updating, the old "update available" result is not shown and a new check runs', async () => {
  const dataDir = path.join(ROOT, 'data-restart');
  const first = await startServer({ DATA_DIR: dataDir, UPDATE_API_BASE: base, MARQUEE_REPO: 'me/marquee', MARQUEE_COMMIT: OLD, CONTROL_DIR: CONTROL, TVMAZE_DISABLED: '1' });
  const a1 = first.client();
  await a1('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  assert.equal((await a1('POST', '/api/updates/check')).data.check.status, 'available');
  await first.stop();
  const second = await startServer({ DATA_DIR: dataDir, UPDATE_API_BASE: base, MARQUEE_REPO: 'me/marquee', MARQUEE_COMMIT: NEW, CONTROL_DIR: CONTROL, TVMAZE_DISABLED: '1' });
  servers.push(second);
  const a2 = second.client();
  await a2('POST', '/api/auth/login', { username: 'admin', password: 'password1' });
  assert.equal((await a2('GET', '/api/status')).data.updateAvailable, false, 'stale result ignored');
  for (let i = 0; i < 40 && !(await a2('GET', '/api/updates')).data.check; i++) await new Promise((r) => setTimeout(r, 200));
  assert.equal((await a2('GET', '/api/updates')).data.check.status, 'current', 'checked again on its own after starting');
});

test('the auto-check setting can be turned off', async () => {
  const { admin } = await boot(OLD);
  assert.equal((await admin('GET', '/api/settings')).data.updateCheck, true);
  await admin('PATCH', '/api/settings', { updateCheck: false });
  assert.equal((await admin('GET', '/api/updates')).data.autoCheck, false);
});
