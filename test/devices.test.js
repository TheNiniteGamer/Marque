'use strict';
// Linking a TV with a code, then using its device token; trailers for previews.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-dev-'));
let srv, admin, movieId;
test.before(async () => {
  clip(path.join(ROOT, 'Movies', 'Heat (1995)', 'Heat (1995).mp4'));
  clip(path.join(ROOT, 'Movies', 'Heat (1995)', 'Heat (1995)-trailer.mp4'));
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), AUTO_LIBRARIES: `Movies:movie:${path.join(ROOT, 'Movies')}` });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  await until(async () => (await admin('GET', '/api/libraries')).data[0]?.scannedAt);
  const lib = (await admin('GET', '/api/libraries')).data[0].id;
  movieId = (await admin('GET', `/api/libraries/${lib}/items`)).data.items[0].id;
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const call = (method, url, { token, body } = {}) => fetch(srv.base + url, {
  method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
});

test('a TV gets a code, someone enters it, and the TV is signed in', async () => {
  const pair = await (await call('POST', '/api/devices/pair', { body: { name: 'Living room Roku' } })).json();
  assert.match(pair.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.deepEqual(await (await call('GET', `/api/devices/pair/${pair.id}`)).json(), { status: 'waiting' });
  assert.equal((await admin('POST', '/api/devices/link', { code: 'WRONG1' })).status, 404);
  assert.equal((await call('POST', '/api/devices/link', { body: { code: pair.code } })).status, 401, 'only someone signed in can link');
  const linked = await admin('POST', '/api/devices/link', { code: pair.code.toLowerCase() });
  assert.deepEqual(linked.data, { ok: true, name: 'Living room Roku' });

  const got = await (await call('GET', `/api/devices/pair/${pair.id}`)).json();
  assert.equal(got.status, 'linked');
  assert.equal(got.user.username, 'admin');
  assert.equal((await call('GET', `/api/devices/pair/${pair.id}`)).status, 404, 'handed out once');

  // The token works as a sign-in, and in the address for playback files and artwork only.
  assert.equal((await (await call('GET', '/api/auth/me', { token: got.token })).json()).user.username, 'admin');
  assert.equal((await call('GET', `/api/art/poster/${movieId}?at=${got.token}`)).status, 200);
  assert.equal((await call('GET', `/api/items/${movieId}/stream?at=${got.token}`)).status, 200);
  assert.equal((await call('GET', `/api/home?at=${got.token}`)).status, 401);
  // Adaptive streaming passes the token on to every playlist and piece, as a Roku can't send headers there.
  const master = await (await call('GET', `/api/items/${movieId}/hls/master.m3u8?sid=abc&at=${got.token}`)).text();
  const variant = master.split('\n').find((l) => l.endsWith(`at=${got.token}`));
  assert.ok(variant, master);
  const playlist = await (await call('GET', `/api/items/${movieId}/hls/${variant}`)).text();
  assert.match(playlist, new RegExp(`seg-0\\.ts\\?sid=abc&at=${got.token}`));

  // Listed on the Account page, and can be unlinked there.
  const list = (await admin('GET', '/api/devices')).data;
  assert.deepEqual(list.map((d) => d.name), ['Living room Roku']);
  assert.equal((await admin('DELETE', `/api/devices/${list[0].id}`)).status, 200);
  assert.equal((await call('GET', '/api/auth/me', { token: got.token })).status, 401);
});

test('the web interface on a TV can sign itself in with a code', async () => {
  const pair = await (await call('POST', '/api/devices/pair', { body: { name: 'TV browser' } })).json();
  await admin('POST', '/api/devices/link', { code: pair.code });
  const r = await call('GET', `/api/devices/pair/${pair.id}?cookie=1`);
  assert.match(r.headers.get('set-cookie'), /^mq_session=/);
});

test('movies say which trailer can be previewed', async () => {
  const lib = (await admin('GET', '/api/libraries')).data[0].id;
  const item = (await admin('GET', `/api/libraries/${lib}/items`)).data.items[0];
  assert.ok(item.trailerId, 'the trailer next to the movie');
  assert.equal((await admin('GET', `/api/items/${item.trailerId}`)).data.extraLabel, 'Trailer');
});

test('player settings follow the account to every device', async () => {
  const me = (await admin('GET', '/api/auth/me')).data.user;
  assert.deepEqual(me.prefs, { autoplayNext: true, autoSkipIntro: false, skipFade: 10 });
  assert.equal(me.prefsSaved, false);
  const r = await admin('PUT', '/api/auth/prefs', { skipFade: 5, autoplayNext: false, junk: 1 });
  assert.deepEqual(r.data.prefs, { autoplayNext: false, autoSkipIntro: false, skipFade: 5 });
  assert.equal((await admin('PUT', '/api/auth/prefs', { skipFade: 7 })).status, 400);
  assert.equal((await admin('GET', '/api/auth/me')).data.user.prefsSaved, true);
  // Players (the Roku's included) get them with the playback details.
  assert.deepEqual((await admin('GET', `/api/items/${movieId}/playback`)).data.prefs, { autoplayNext: false, autoSkipIntro: false, skipFade: 5 });
});
