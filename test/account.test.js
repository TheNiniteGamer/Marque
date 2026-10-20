'use strict';
// The Account page's server side: languages and subtitle looks that follow the account, where you're
// signed in and signing out everywhere else, and viewing activity.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-account-'));
let srv, me, film, ep;

test.before(async () => {
  clip(path.join(ROOT, 'Movies', 'Film (2020)', 'Film (2020).mp4'), 3);
  clip(path.join(ROOT, 'TV', 'Show', 'Season 01', 'Show - S01E01.mp4'), 3);
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1',
    AUTO_LIBRARIES: `Movies:movie:${path.join(ROOT, 'Movies')};TV:show:${path.join(ROOT, 'TV')}` });
  me = srv.client();
  await me('POST', '/api/auth/setup', { username: 'dad', password: 'password1' });
  await until(async () => (await me('GET', '/api/libraries')).data.every((l) => l.scannedAt));
  film = (await me('GET', '/api/search?q=Film')).data.movies[0];
  const show = (await me('GET', '/api/search?q=Show')).data.shows[0];
  ep = (await me('GET', `/api/shows/${show.id}`)).data.seasons[0].episodes[0];
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('subtitle and sound languages and subtitle looks follow the account', async () => {
  const before = (await me('GET', '/api/auth/me')).data.user.prefs;
  assert.deepEqual([before.subLang, before.audioLang, before.subSize, before.subStyle], ['', '', 'medium', 'box'], 'defaults keep things as they were');
  const r = await me('PUT', '/api/auth/prefs', { subLang: 'EN', audioLang: 'jpn', subSize: 'large', subStyle: 'yellow' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.prefs.subLang, r.data.prefs.audioLang, r.data.prefs.subSize, r.data.prefs.subStyle], ['en', 'jpn', 'large', 'yellow']);
  for (const bad of [{ subLang: 'english' }, { subSize: 'huge' }, { subStyle: 'comic sans' }]) assert.equal((await me('PUT', '/api/auth/prefs', bad)).status, 400, JSON.stringify(bad));
  assert.equal((await me('PUT', '/api/auth/prefs', { subLang: '' })).data.prefs.subLang, '', 'turned off again');
  // Players get them with each video, as with the other player settings.
  assert.equal((await me('GET', `/api/items/${film.id}/playback`)).data.prefs.subStyle, 'yellow');
});

test('where you are signed in, and signing out everywhere else', async () => {
  const phone = srv.client(), laptop = srv.client();
  for (const c of [phone, laptop]) assert.equal((await c('POST', '/api/auth/login', { username: 'dad', password: 'password1' })).status, 200);
  const s = (await me('GET', '/api/auth/sessions')).data;
  assert.equal(s.signIns.length, 3);
  assert.equal(s.signIns.filter((x) => x.current).length, 1, 'this one is marked');
  assert.ok(s.signIns.every((x) => x.device && x.createdAt));
  assert.equal((await me('POST', '/api/auth/signout-others')).data.signedOut, 2);
  assert.equal((await phone('GET', '/api/auth/me')).status, 401, 'the others are signed out');
  assert.equal((await laptop('GET', '/api/auth/me')).status, 401);
  assert.equal((await me('GET', '/api/auth/me')).status, 200, 'this one stays');
  assert.equal((await me('GET', '/api/auth/sessions')).data.signIns.length, 1);
});

test('viewing activity lists what was watched, newest first, and can forget it', async () => {
  await me('POST', `/api/items/${ep.id}/progress`, { position: 1 });
  await new Promise((r) => setTimeout(r, 20));
  await me('POST', `/api/items/${film.id}/progress`, { position: 2 });
  const h = (await me('GET', '/api/history')).data;
  assert.deepEqual(h.map((x) => x.id), [film.id, ep.id]);
  assert.ok(h[0].watchedAt >= h[1].watchedAt);
  assert.equal(h[1].type, 'episode');
  assert.equal((await me('DELETE', `/api/history/${film.id}`)).status, 200);
  assert.deepEqual((await me('GET', '/api/history')).data.map((x) => x.id), [ep.id]);
  assert.equal((await me('GET', `/api/items/${film.id}`)).data.progress, null, 'forgotten altogether');
  const other = srv.client();
  await me('POST', '/api/users', { username: 'kid', password: 'password2' });
  await other('POST', '/api/auth/login', { username: 'kid', password: 'password2' });
  assert.deepEqual((await other('GET', '/api/history')).data, [], 'each profile has its own');
});
