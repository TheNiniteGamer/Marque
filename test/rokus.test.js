'use strict';
// Updating Rokus from Settings: a pretend Roku answers its network control (the version installed,
// what it's showing) and takes the channel on its developer installer, with the password check a
// real Roku makes (HTTP Digest).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers');
const { zipVersion } = require('../lib/rokus');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-rokus-'));
const ZIP = path.join(__dirname, '..', 'public', 'downloads', 'Marquee-Roku.zip');
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

// The pretend Roku.
const roku = { version: '1.1.0', app: '<app>Roku</app>', password: 'hunter22', installs: 0, keys: [] };
const listen = (handler) => new Promise((done) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => done(s)); });
let ecp; let dev; let srv; let cookie;

const call = (url, { method = 'GET', headers = {}, body } = {}) => fetch(srv.base + url, {
  method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

test.before(async () => {
  ecp = await listen((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/keypress/')) { roku.keys.push(req.url.slice(10)); return res.end(); }
    const xml = {
      '/query/device-info': '<device-info><serial-number>X123</serial-number><user-device-name>Living room</user-device-name><friendly-model-name>TCL Roku TV</friendly-model-name><power-mode>PowerOn</power-mode><developer-enabled>true</developer-enabled></device-info>',
      '/query/apps': `<apps><app id="12" version="5.0">Netflix</app><app id="dev" type="appl" version="${roku.version}">Marquee</app></apps>`,
      '/query/active-app': `<active-app>${roku.app}</active-app>`,
      '/query/media-player': '<player state="close" error="false"/>',
    }[req.url];
    res.writeHead(xml ? 200 : 404, { 'content-type': 'text/xml' }).end(xml || '');
  });
  dev = await listen((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const auth = String(req.headers.authorization || '');
      const p = {};
      auth.replace(/(\w+)=(?:"([^"]*)"|([^\s,]*))/g, (_, k, q, v) => { p[k] = q ?? v; });
      const want = md5(`${md5(`rokudev:rokudev:${roku.password}`)}:abc:${p.nc}:${p.cnonce}:auth:${md5(`POST:${req.url}`)}`);
      if (!auth.startsWith('Digest ') || p.response !== want) {
        return res.writeHead(401, { 'www-authenticate': 'Digest qop="auth", realm="rokudev", nonce="abc"' }).end('');
      }
      const body = Buffer.concat(chunks);
      assert.ok(body.includes('name="mysubmit"') && body.includes('Install'));
      assert.ok(body.length > fs.statSync(ZIP).size, 'the whole channel zip is sent');
      roku.installs++;
      roku.version = zipVersion(ZIP);
      res.end('<html><font color="red">Install Success.</font></html>');
    });
  });
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1', ROKU_ECP_PORT: String(ecp.address().port), ROKU_DEV_PORT: String(dev.address().port) });
  await call('/api/auth/setup', { method: 'POST', body: { username: 'admin', password: 'password1' } });
  const login = await fetch(`${srv.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'password1' }) });
  cookie = login.headers.get('set-cookie').split(';')[0];
});
test.after(async () => { await srv?.stop(); ecp?.close(); dev?.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('the channel zip says its version', () => {
  const manifest = fs.readFileSync(path.join(__dirname, '..', 'roku', 'manifest'), 'utf8');
  const v = (k) => new RegExp(`^${k}=(\\d+)`, 'm').exec(manifest)[1];
  assert.equal(zipVersion(ZIP), `${v('major_version')}.${v('minor_version')}.${v('build_version')}`, 'run roku/package.sh after changing the manifest');
});

test('a Roku that opened Marquee at home is listed with its version, and updated with its password', async () => {
  assert.deepEqual((await call('/api/rokus', { headers: { cookie } })).data.rokus, []);
  // The channel's own requests (a "Roku/…" user agent) make it known; browsers don't.
  await call('/api/auth/me', { headers: { cookie, 'user-agent': 'Mozilla/5.0' } });
  assert.equal((await call('/api/rokus', { headers: { cookie } })).data.rokus.length, 0);
  await call('/api/auth/me', { headers: { cookie, 'user-agent': 'Roku/DVP-14.5 (14.5.4.5934-46)' } });
  let list = (await call('/api/rokus', { headers: { cookie } })).data;
  assert.equal(list.latest, zipVersion(ZIP));
  assert.equal(list.rokus.length, 1);
  const r = list.rokus[0];
  assert.equal(r.name, 'Living room');
  assert.equal(r.model, 'TCL Roku TV');
  assert.equal(r.installed, '1.1.0');
  assert.equal(r.needsUpdate, true);
  assert.equal(r.app, 'home');
  assert.equal(r.hasPassword, false);

  const update = (body) => call(`/api/rokus/${encodeURIComponent(r.ip)}/update`, { method: 'POST', headers: { cookie }, body });
  // No password yet, then a wrong one: asked for.
  assert.equal((await update({})).data.result, 'password');
  assert.equal((await update({ password: 'nope' })).data.result, 'password');
  assert.equal(roku.installs, 0);

  // Showing another channel: not interrupted unless asked to.
  roku.app = '<app id="12" version="5.0">Netflix</app>';
  const busy = (await update({ password: 'hunter22' })).data;
  assert.equal(busy.result, 'busy');
  assert.match(busy.message, /Netflix/);
  assert.equal(roku.installs, 0);

  // On the home screen: installed, and put back on the home screen afterwards.
  roku.app = '<app>Roku</app>';
  const done = (await update({ password: 'hunter22' })).data;
  assert.equal(done.result, 'updated', done.message);
  assert.equal(roku.installs, 1);
  assert.deepEqual(roku.keys, ['Home']);

  list = (await call('/api/rokus', { headers: { cookie } })).data;
  assert.equal(list.rokus[0].installed, zipVersion(ZIP));
  assert.equal(list.rokus[0].needsUpdate, false);
  assert.equal(list.rokus[0].hasPassword, true, 'the password is kept for next time');

  // Next time the kept password is used.
  roku.version = '1.1.0';
  assert.equal((await update({})).data.result, 'updated');
  assert.equal(roku.installs, 2);
});

test('only admins see or update Rokus, and only ones Marquee knows', async () => {
  assert.equal((await call('/api/rokus')).status, 401);
  const r = await call('/api/rokus/192.168.1.250/update', { method: 'POST', headers: { cookie }, body: {} });
  assert.equal(r.status, 404);
});
