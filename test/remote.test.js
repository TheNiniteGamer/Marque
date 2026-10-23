'use strict';
// Running behind Tailscale serve / Cloudflare Tunnel: real client addresses, first-run setup only
// from home, security headers, and detecting the remote address. The test sends the headers a
// local proxy would add.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-remote-'));
let srv;
const viaProxy = (ip, extra = {}) => ({ 'x-forwarded-for': ip, 'x-forwarded-proto': 'https', 'x-forwarded-host': 'marquee.tail1234.ts.net', ...extra });
const call = (url, { method = 'GET', headers = {}, body } = {}) => fetch(srv.base + url, {
  method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, headers: r.headers, data: await r.json().catch(() => null) }));

test.before(async () => {
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1', REMOTE_ACCESS: 'tailscale' });
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('nobody can claim a fresh server from outside the home network', async () => {
  const outside = await call('/api/auth/setup', { method: 'POST', headers: viaProxy('203.0.113.9'), body: { username: 'evil', password: 'password1' } });
  assert.equal(outside.status, 403);
  assert.match(outside.data.error, /home network/);
  const tailnet = await call('/api/auth/setup', { method: 'POST', headers: viaProxy('100.101.102.103'), body: { username: 'admin', password: 'password1' } });
  assert.equal(tailnet.status, 201, 'your own Tailscale devices count as home');
});

test('login rate limits apply per real visitor, not to the whole tunnel', async () => {
  for (let i = 0; i < 8; i++) await call('/api/auth/login', { method: 'POST', headers: viaProxy('203.0.113.50'), body: { username: 'admin', password: 'wrong' } });
  assert.equal((await call('/api/auth/login', { method: 'POST', headers: viaProxy('203.0.113.50'), body: { username: 'admin', password: 'password1' } })).status, 429);
  const other = await call('/api/auth/login', { method: 'POST', headers: viaProxy('198.51.100.7'), body: { username: 'admin', password: 'password1' } });
  assert.equal(other.status, 200, 'someone else can still sign in');
  // A visitor can't dodge the limit by sending their own X-Forwarded-For: the proxy appends the real one.
  const spoofed = await call('/api/auth/login', { method: 'POST', headers: viaProxy('1.2.3.4, 203.0.113.50'), body: { username: 'admin', password: 'password1' } });
  assert.equal(spoofed.status, 429);
});

test('security headers, HSTS only over HTTPS, secure cookies through the tunnel', async () => {
  const plain = await call('/api/health');
  assert.equal(plain.headers.get('x-frame-options'), 'DENY');
  assert.equal(plain.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(plain.headers.get('strict-transport-security'), null);
  const tunneled = await call('/api/health', { headers: viaProxy('100.101.102.103') });
  assert.match(tunneled.headers.get('strict-transport-security'), /max-age/);
  const login = await call('/api/auth/login', { method: 'POST', headers: viaProxy('100.101.102.104'), body: { username: 'admin', password: 'password1' } });
  assert.match(login.headers.get('set-cookie'), /; Secure/);
});

test('settings show the remote address once it has been used', async () => {
  const login = await call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'password1' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  // Requests nobody signed in to don't count: anyone could make up the headers.
  await call('/api/health', { headers: { ...viaProxy('203.0.113.9'), 'x-forwarded-host': 'evil.example' } });
  assert.equal((await call('/api/remote', { headers: { cookie } })).data.seen, null);
  await call('/api/auth/me', { headers: { ...viaProxy('100.101.102.103'), cookie } });
  const r = await call('/api/remote', { headers: { cookie } });
  assert.deepEqual(r.data.configured, ['tailscale']);
  assert.equal(r.data.seen.origin, 'https://marquee.tail1234.ts.net');
  assert.equal(r.data.seen.via, 'Tailscale');
  assert.equal(r.data.viaRemoteNow, false);
});

test('Tailscale and outside viewers count as away; people at home through the house proxy as home', async () => {
  const login = await call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'password1' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const away = async (headers) => (await call('/api/auth/me', { headers: { ...headers, cookie } })).data.away;
  assert.equal(await away({}), false);
  assert.equal(await away(viaProxy('100.101.102.103')), true); // Tailscale
  assert.equal(await away(viaProxy('fd7a:115c:a1e0::1')), true);
  assert.equal(await away(viaProxy('203.0.113.9')), true); // Cloudflare
  // Nginx Proxy Manager in the house passes on the visitor's home address.
  assert.equal(await away(viaProxy('192.168.1.50', { 'x-forwarded-host': 'marquee.home.example.com' })), false);
  // An HTTPS proxy that doesn't say who's behind it: assume away.
  assert.equal(await away({ 'x-forwarded-proto': 'https' }), true);
});
