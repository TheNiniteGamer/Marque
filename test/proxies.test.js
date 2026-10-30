'use strict';
// Forwarded headers (X-Forwarded-For, -Proto, -Host) are only believed from a proxy on this PC or
// beside it in Docker. Another device at home can't use them to get round the sign-in limits, look
// like a visitor from outside, set the remote address shown in Settings, or have its Roku
// remembered somewhere else. (A test server here takes every connection as coming from another
// address: see fake-peer.js.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-proxies-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const fromPeer = (name, peer) => startServer({
  DATA_DIR: path.join(ROOT, name), TVMAZE_DISABLED: '1', FAKE_PEER: peer, NODE_OPTIONS: `--require ${JSON.stringify(path.join(__dirname, 'fake-peer.js'))}`,
});
const call = (srv, url, { method = 'GET', headers = {}, body } = {}) => fetch(srv.base + url, {
  method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, headers: r.headers, data: await r.json().catch(() => null) }));
const signIn = async (srv, username, password, headers = {}) => {
  const r = await call(srv, '/api/auth/login', { method: 'POST', headers, body: { username, password } });
  return r.headers.get('set-cookie')?.split(';')[0];
};

test('a device at home isn’t believed when it names other addresses', async () => {
  const srv = await fromPeer('home', '192.168.1.50');
  try {
    assert.equal((await call(srv, '/api/auth/setup', { method: 'POST', body: { username: 'admin', password: 'password1' } })).status, 201);
    // Wrong passwords "from" different addresses all count against the device itself.
    for (let i = 0; i < 8; i++) {
      await call(srv, '/api/auth/login', { method: 'POST', headers: { 'x-forwarded-for': `203.0.113.${i}` }, body: { username: 'admin', password: 'wrong' } });
    }
    assert.equal((await call(srv, '/api/auth/login', { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.7' }, body: { username: 'admin', password: 'password1' } })).status, 429);
  } finally { await srv.stop(); }
});

test('nor can it look like a visitor from outside, set the remote address, or move a Roku', async () => {
  const srv = await fromPeer('away', '192.168.1.50');
  try {
    await call(srv, '/api/auth/setup', { method: 'POST', body: { username: 'admin', password: 'password1' } });
    const cookie = await signIn(srv, 'admin', 'password1');
    const away = async (headers) => (await call(srv, '/api/auth/me', { headers: { ...headers, cookie } })).data.away;
    assert.equal(await away({ 'x-forwarded-for': '203.0.113.9' }), false, 'still the device at home');
    // An HTTPS proxy Marquee doesn't believe: taken as away (the careful choice), and its made-up
    // address isn't remembered for Settings → Remote access.
    assert.equal(await away({ 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.168.1.60', 'x-forwarded-host': 'evil.example' }), true);
    assert.equal((await call(srv, '/api/remote', { headers: { cookie } })).data.seen, null);
    // The Roku channel's requests: remembered at the address they came from.
    await call(srv, '/api/auth/me', { headers: { cookie, 'user-agent': 'Roku/DVP-14.5 (14.5.4.5934-46)', 'x-forwarded-for': '192.168.1.99' } });
    assert.deepEqual((await call(srv, '/api/rokus', { headers: { cookie } })).data.rokus.map((r) => r.ip), ['192.168.1.50']);
  } finally { await srv.stop(); }
});

test('the remote address is only taken from an admin’s requests', async () => {
  const srv = await startServer({ DATA_DIR: path.join(ROOT, 'origin'), TVMAZE_DISABLED: '1' });
  try {
    await call(srv, '/api/auth/setup', { method: 'POST', body: { username: 'admin', password: 'password1' } });
    const admin = await signIn(srv, 'admin', 'password1');
    await call(srv, '/api/users', { method: 'POST', headers: { cookie: admin }, body: { username: 'bob', password: 'password2' } });
    const bob = await signIn(srv, 'bob', 'password2');
    const proxy = (host) => ({ 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9', 'x-forwarded-host': host });
    await call(srv, '/api/auth/me', { headers: { ...proxy('bobs.example'), cookie: bob } });
    assert.equal((await call(srv, '/api/remote', { headers: { cookie: admin } })).data.seen, null);
    await call(srv, '/api/auth/me', { headers: { ...proxy('marquee.tail1234.ts.net'), cookie: admin } });
    assert.equal((await call(srv, '/api/remote', { headers: { cookie: admin } })).data.seen.origin, 'https://marquee.tail1234.ts.net');
  } finally { await srv.stop(); }
});

// A proxy in another container on Marquee's Docker network (Tailscale, Cloudflare Tunnel): only
// when these tests themselves run in a container, with an address on its network to come from.
const dockerPeer = (() => {
  if (!fs.existsSync('/.dockerenv')) return null;
  const all = Object.entries(os.networkInterfaces());
  if (all.some(([name]) => /^docker\d+$/.test(name))) return null; // (sharing the PC's network)
  const a = all.flatMap(([, list]) => list).find((x) => x.family === 'IPv4' && !x.internal);
  if (!a) return null;
  const parts = a.address.split('.').map(Number);
  parts[3] = parts[3] === 1 ? 2 : 1; // (another address on the same network, like its gateway's)
  return parts.join('.');
})();

test('a proxy beside Marquee in Docker is believed', { skip: !dockerPeer && 'not running in a container' }, async () => {
  const srv = await fromPeer('docker', dockerPeer);
  try {
    await call(srv, '/api/auth/setup', { method: 'POST', headers: { 'x-forwarded-for': '192.168.1.20' }, body: { username: 'admin', password: 'password1' } });
    for (let i = 0; i < 8; i++) {
      await call(srv, '/api/auth/login', { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.50' }, body: { username: 'admin', password: 'wrong' } });
    }
    assert.equal((await call(srv, '/api/auth/login', { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.50' }, body: { username: 'admin', password: 'password1' } })).status, 429);
    const other = await call(srv, '/api/auth/login', { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.7' }, body: { username: 'admin', password: 'password1' } });
    assert.equal(other.status, 200, 'someone else coming through it can still sign in');
  } finally { await srv.stop(); }
});
