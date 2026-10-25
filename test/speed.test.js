'use strict';
// Settings → Logs → Speed (how quickly Marquee answers), and the page's scripts being kept by
// browsers until they change (named with a stamp of their contents).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-speed-'));
let srv, admin;
test.before(async () => {
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1' });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('the page names its scripts with a stamp, and stamped scripts are kept', async () => {
  const page = await fetch(`${srv.base}/`);
  assert.equal(page.headers.get('cache-control'), 'no-cache', 'the page itself is always checked');
  const html = await page.text();
  const app = /src="\/app\.js\?v=([0-9a-f]{10})"/.exec(html);
  assert.ok(app, 'app.js has a stamp');
  assert.match(html, /href="\/app\.css\?v=[0-9a-f]{10}"/);
  assert.match(html, /href="\/fonts\/figtree\.woff2"/, 'fonts are left as they are (the stylesheet names them too)');
  const kept = await fetch(`${srv.base}/app.js?v=${app[1]}`);
  assert.equal(kept.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal((await fetch(`${srv.base}/app.js?v=0000000000`)).headers.get('cache-control'), 'no-cache', 'a stamp that doesn’t match isn’t kept');
  assert.equal((await fetch(`${srv.base}/app.js`)).headers.get('cache-control'), 'no-cache');
  // Compressed, and a browser that has the page gets "not modified".
  const gz = await fetch(`${srv.base}/#/`, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gz.headers.get('content-encoding'), 'gzip');
  assert.equal((await fetch(`${srv.base}/`, { headers: { 'if-none-match': page.headers.get('etag') } })).status, 304);
  assert.equal((await fetch(`${srv.base}/some/page`)).headers.get('etag'), page.headers.get('etag'), 'any page address gets the same page');
});

test('the speed report counts answers by kind of request, for admins only', async () => {
  for (let i = 0; i < 3; i++) await admin('GET', '/api/libraries');
  const s = (await admin('GET', '/api/speed')).data;
  const libs = s.routes.find((r) => r.what === 'GET /api/libraries');
  assert.ok(libs && libs.count >= 3, JSON.stringify(s.routes));
  assert.ok(s.routes.every((r) => !/\?/.test(r.what)), 'routes as written, never addresses');
  assert.equal(typeof s.stalls.maxMs, 'number');
  assert.equal(s.slowMs, 1000);
  assert.ok('scanning' in s.jobs);
  assert.equal((await admin('POST', '/api/speed/reset')).data.routes.length, 0);
  const user = srv.client();
  await admin('POST', '/api/users', { username: 'kid', password: 'password2' });
  await user('POST', '/api/auth/login', { username: 'kid', password: 'password2' });
  assert.equal((await user('GET', '/api/speed')).status, 403);
});
