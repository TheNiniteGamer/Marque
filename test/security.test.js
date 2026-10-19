'use strict';
// Requests that used to cause trouble: addresses that can't be parsed (one stopped the whole
// server), bad %-escapes, climbing out of the web folder; and the protective headers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-security-'));
let srv, admin;
test.before(async () => {
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data') });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

// A request line sent as it is (fetch would tidy the address up first).
function raw(line) {
  const { port } = new URL(srv.base);
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`${line}\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let d = '';
    s.on('data', (x) => { d += x; });
    s.on('close', () => resolve(d));
    s.on('error', () => resolve(''));
  });
}

test('addresses that can’t be read get a 400, and the server keeps running', async () => {
  for (const line of ['GET //[ HTTP/1.1', 'GET //x:99999/ HTTP/1.1', 'GET /api/items/%zz HTTP/1.1', 'GET /%E0%A4%A HTTP/1.1']) {
    assert.match((await raw(line)).split('\r\n')[0], / 400 /, line);
  }
  assert.equal((await fetch(`${srv.base}/api/health`)).status, 200, 'still up');
});

test('nothing outside the web folder is served', async () => {
  for (const line of ['GET /../package.json HTTP/1.1', 'GET /..%2fserver.js HTTP/1.1', 'GET /%2e%2e/%2e%2e/etc/passwd HTTP/1.1']) {
    const body = await raw(line);
    assert.doesNotMatch(body, /"name": "marquee"|require\(|root:/, line);
  }
});

test('protective headers: no framing, no inline scripts, no sniffing', async () => {
  const h = (await fetch(`${srv.base}/`)).headers;
  assert.equal(h.get('x-frame-options'), 'DENY');
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  const csp = h.get('content-security-policy');
  assert.match(csp, /script-src 'self' https:\/\/www\.gstatic\.com(;|$)/, 'no unsafe-inline for scripts');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
});

test('passwords need 8 characters', async () => {
  assert.equal((await admin('POST', '/api/users', { username: 'kim', password: 'seven77' })).status, 400);
  assert.equal((await admin('POST', '/api/users', { username: 'kim', password: 'eight888' })).status, 201);
});
