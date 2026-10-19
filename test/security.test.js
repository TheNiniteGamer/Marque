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

test('ids that are names built into JavaScript find nothing, and change nothing', async () => {
  for (const id of ['__proto__', 'constructor', 'toString']) {
    assert.equal((await admin('GET', `/api/items/${id}`)).status, 404, id);
    assert.equal((await admin('POST', `/api/items/${id}/subtitle-download`, { fileId: 1 })).status, 404, id);
    assert.equal((await admin('PATCH', `/api/meta/${id}`, { title: 'x' })).status, 404, id);
  }
  assert.equal({}.downloadedSubs, undefined);
  assert.equal({}.edits, undefined);
});

test('changes asked for by another site are refused; apps and this site are fine', async () => {
  const send = (site) => fetch(`${srv.base}/api/auth/prefs`, { method: 'PUT', headers: { 'content-type': 'application/json', ...(site ? { 'sec-fetch-site': site } : {}), cookie: srv.cookieOf?.(admin) || '' }, body: '{"skipFade":5}' });
  assert.equal((await send('cross-site')).status, 403);
  assert.equal((await send('same-site')).status, 403, 'another port or subdomain counts as another site');
  assert.notEqual((await send('same-origin')).status, 403);
  assert.notEqual((await send(null)).status, 403, 'apps don’t send it');
});

test('an image address typed in can’t point at the server itself', async () => {
  const { downloadImage } = require('../lib/metadata');
  const dir = path.join(ROOT, 'img');
  for (const url of ['http://127.0.0.1:1/x.png', 'http://localhost:1/x.png', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]:1/x.png', 'http://0.0.0.0:1/']) {
    await assert.rejects(downloadImage(url, dir, 'x', { untrusted: true }), /server itself/, url);
  }
  await assert.rejects(downloadImage('file:///etc/passwd', dir, 'x', { untrusted: true }), /http\(s\)/);
});
