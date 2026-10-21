'use strict';
// Radarr and Sonarr (mocked, with the shapes of Radarr 5 and Sonarr 4's v3 API): connecting,
// quality profiles and their size cap, who can skip approval (films and shows separately),
// approving with a chosen profile and seasons, live download status, and failures with Retry.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');
const { Arr, profileView, describe } = require('../lib/arr');
const { fakeArr, PROFILES } = require('./fake-arr');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-arr-'));
const MOVIES = path.join(ROOT, 'Movies'), TV = path.join(ROOT, 'TV');
const KEY = { radarr: 'r'.repeat(32), sonarr: 's'.repeat(32) };

const radarr = fakeArr('radarr', { key: KEY.radarr, rootFolder: MOVIES }), sonarr = fakeArr('sonarr', { key: KEY.sonarr, rootFolder: TV });
const tmdb = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname.replace(/^\/3/, '');
  res.writeHead(p === '/tv/1396/external_ids' ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(p === '/tv/1396/external_ids' ? { id: 1396, tvdb_id: 81189 } : {}));
});
const urlOf = (s) => `http://127.0.0.1:${s.address().port}`;

let srv, admin, kid, kidId;
test.before(async () => {
  for (const s of [radarr.server, sonarr.server, tmdb]) await new Promise((r) => s.listen(0, '127.0.0.1', r));
  clip(path.join(MOVIES, 'Old (2001).mp4'));
  clip(path.join(TV, 'Show', 'Season 1', 'Show S01E01.mp4'));
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1', TMDB_API_KEY: 'k', TMDB_API_BASE: `${urlOf(tmdb)}/3`,
    AUTO_LIBRARIES: `Movies:movie:${MOVIES};TV:show:${TV}` });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'dad', password: 'password1' });
  await until(async () => (await admin('GET', '/api/libraries')).data.every((l) => l.scannedAt));
  kidId = (await admin('POST', '/api/users', { username: 'kid', password: 'password2' })).data.id;
  kid = srv.client();
  await kid('POST', '/api/auth/login', { username: 'kid', password: 'password2' });
});
test.after(async () => {
  await srv?.stop();
  for (const s of [radarr.server, sonarr.server, tmdb]) s.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('quality profiles show the biggest picture they let in', () => {
  assert.deepEqual(PROFILES.map(profileView), [{ id: 1, name: 'Any', maxRes: 2160 }, { id: 4, name: 'HD-1080p', maxRes: 1080 }]);
  assert.equal(profileView({ id: 9, name: 'Off group', items: [{ name: 'g', allowed: false, items: [{ quality: { resolution: 2160 }, allowed: true }] }] }).maxRes, null);
});

test('connecting checks the address and key, and lists profiles and folders', async () => {
  let r = await admin('POST', '/api/arr/radarr/test', { url: urlOf(radarr.server), apiKey: 'wrong' });
  assert.equal(r.status, 502);
  assert.match(r.data.error, /API key/);
  r = await admin('POST', '/api/arr/radarr/test', { url: urlOf(sonarr.server), apiKey: KEY.sonarr });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Sonarr, not Radarr/);
  r = await admin('POST', '/api/arr/radarr/test', { url: 'http://127.0.0.1:1', apiKey: KEY.radarr });
  assert.match(r.data.error, /Can’t reach Radarr.*host\.docker\.internal:7878/);

  r = await admin('POST', '/api/arr/radarr/test', { url: `${urlOf(radarr.server)}/api/v3/`, apiKey: KEY.radarr });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.version, '5.14.0.9383');
  assert.deepEqual(r.data.rootFolders.map((f) => [f.path, f.library]), [[MOVIES, 'Movies'], ['E:\\Elsewhere', null]], 'which Marquee library each folder is');

  r = await admin('PUT', '/api/arr/radarr', { url: urlOf(radarr.server), apiKey: KEY.radarr, profileId: 4, rootFolder: MOVIES });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.ready, r.data.profileName, r.data.keyHint], [true, 'HD-1080p', '…rrrr']);
  assert.equal(JSON.stringify((await admin('GET', '/api/arr')).data).includes(KEY.radarr), false, 'the key is never sent back');
  assert.equal((await admin('PUT', '/api/arr/radarr', { profileId: 99 })).status, 400);
  r = await admin('PUT', '/api/arr/sonarr', { url: urlOf(sonarr.server), apiKey: KEY.sonarr, profileId: 4, rootFolder: TV, monitor: 'firstSeason' });
  assert.equal(r.data.ready, true);
  assert.equal((await kid('GET', '/api/arr')).status, 403);
});

test('who can skip approval is set separately for films and shows', async () => {
  const r = await admin('PATCH', `/api/users/${kidId}`, { autoApprove: { movie: true } });
  assert.deepEqual(r.data.autoApprove, { movie: true, show: false });

  // A film from the kid: straight to Radarr with the default 1080p profile.
  const film = (await kid('POST', '/api/requests', { kind: 'movie', title: 'The Matrix', year: 1999, provider: 'tmdb', providerId: '603' })).data;
  assert.equal(film.status, 'approved');
  assert.equal(film.sent, true);
  const added = radarr.sent.find((x) => x.path === '/movie');
  assert.deepEqual([added.body.tmdbId, added.body.qualityProfileId, added.body.rootFolderPath, added.body.monitored, added.body.addOptions.searchForMovie], [603, 4, MOVIES, true, true]);

  // A show from the kid: waits for an admin; nothing sent to Sonarr.
  const show = (await kid('POST', '/api/requests', { kind: 'show', title: 'Breaking Bad', year: 2008, provider: 'tmdb', providerId: '1396' })).data;
  assert.equal(show.status, 'pending');
  assert.equal(sonarr.sent.length, 0);
  const told = (await admin('GET', '/api/notifications')).data.items.map((n) => n.title);
  assert.ok(told.some((t) => /kid asked for Breaking Bad/.test(t)));
  assert.ok(!told.some((t) => /kid asked for The Matrix/.test(t)), 'nothing to approve for the film');

  // Allowed to skip approval, but chose "Add to requests": it waits, and nothing goes to Radarr.
  const sentBefore = radarr.sent.length;
  const later = (await kid('POST', '/api/requests', { kind: 'movie', title: 'Waiting Film', year: 2001, wait: true })).data;
  assert.deepEqual([later.status, later.sent], ['pending', false]);
  assert.equal(radarr.sent.length, sentBefore);
});

test('approving a show sends it with the profile and seasons picked', async () => {
  const show = (await admin('GET', '/api/requests')).data.requests.find((r) => r.title === 'Breaking Bad');
  const r = await admin('PATCH', `/api/requests/${show.id}`, { status: 'approved', profileId: 1, monitor: 'all' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'approved');
  assert.deepEqual([r.data.arr.app, r.data.arr.profile, r.data.arr.monitor], ['sonarr', 'Any', 'all']);
  const added = sonarr.sent.find((x) => x.path === '/series');
  assert.equal(added.body.tvdbId, 81189, 'TheTVDB id looked up from TMDB');
  assert.deepEqual([added.body.qualityProfileId, added.body.addOptions.monitor, added.body.seasonFolder], [1, 'all', true]);
  assert.equal(added.body.languageProfileId, undefined, 'Sonarr 4 has no language profiles');
  assert.ok((await kid('GET', '/api/notifications')).data.items.some((n) => n.title === 'Breaking Bad is on its way'));
});

test('the requests page shows how each download is going', async () => {
  const filmId = Object.values(radarr.items)[0].id;
  const showId = Object.values(sonarr.items)[0].id;
  radarr.queue = [{ movieId: filmId, size: 4000, sizeleft: 1000, timeleft: '00:20:00', status: 'downloading', trackedDownloadState: 'downloading' }];
  sonarr.items[showId].statistics = { episodeFileCount: 7, episodeCount: 62, percentOfEpisodes: 11.3 };
  let list;
  await until(async () => {
    list = (await admin('GET', '/api/requests')).data.requests;
    return list.find((r) => r.title === 'The Matrix').progress?.state === 'downloading'; // (status is kept for a few seconds)
  });
  const by = Object.fromEntries(list.map((r) => [r.title, r]));
  assert.equal(by['The Matrix'].progress.state, 'downloading');
  assert.equal(by['The Matrix'].progress.label, 'Downloading · 75% · 20 min left');
  assert.equal(by['Breaking Bad'].progress.label, '7 of 62 episodes downloaded');
  // The kid sees how it's going, but not Radarr's details.
  list = (await kid('GET', '/api/requests')).data.requests;
  const mine = list.find((r) => r.title === 'The Matrix');
  assert.equal(mine.progress.percent, 75);
  assert.deepEqual(mine.arr, { app: 'radarr' });
});

test('when Radarr can’t be reached the request waits, admins are told why, and Retry sends it', async () => {
  radarr.down = true;
  const r = (await kid('POST', '/api/requests', { kind: 'movie', title: 'Something', year: 2020, provider: 'tmdb', providerId: '777' })).data;
  assert.equal(r.status, 'pending');
  assert.equal(r.sent, false);
  const seen = (await admin('GET', '/api/requests')).data.requests.find((x) => x.id === r.id);
  assert.match(seen.arr.error, /Database is locked/);
  assert.equal((await kid('GET', '/api/requests')).data.requests.find((x) => x.id === r.id).arr, null, 'not shown to the kid');
  assert.ok((await admin('GET', '/api/notifications')).data.items.some((n) => /Something couldn’t be sent to Radarr/.test(n.title)));
  assert.ok((await admin('GET', '/api/health-check')).data.checks.some((c) => c.id === 'arr-radarr' && c.level === 'warn'));

  radarr.down = false;
  const again = await admin('POST', `/api/requests/${r.id}/send`, {});
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.status, 'approved');
  assert.equal(again.data.arr.error, undefined);
});

test('a saved folder Radarr no longer has (a Windows one from a restored backup) is explained, not sent', async () => {
  const store = { data: { settings: { arr: { radarr: { url: urlOf(radarr.server), apiKey: KEY.radarr, profileId: 4, rootFolder: 'F:\\movies' } } } }, save() {} };
  const before = radarr.sent.length;
  await assert.rejects(new Arr(store).add({ kind: 'movie', title: 'The Matrix', year: 1999, provider: 'tmdb', providerId: '603' }),
    /doesn’t have the folder “F:\\movies” any more: pick one in Settings → Radarr & Sonarr/);
  assert.equal(radarr.sent.length, before, 'nothing was sent to Radarr');
});

test('something already in Radarr is linked, not added twice; "approve only" sends nothing', async () => {
  const before = radarr.sent.length;
  await admin('PATCH', `/api/users/${kidId}`, { autoApprove: { movie: false } });
  // The first request is cleared away; asking again finds the film already in Radarr.
  const first = (await admin('GET', '/api/requests')).data.requests.find((x) => x.title === 'The Matrix');
  await admin('DELETE', `/api/requests/${first.id}`);
  const other = (await admin('POST', '/api/requests', { kind: 'movie', title: 'The Matrix', year: 1999, provider: 'tmdb', providerId: '603' })).data;
  assert.equal(other.status, 'approved');
  assert.equal(radarr.sent.length, before, 'nothing added: it was there already');
  const linked = (await admin('GET', '/api/requests')).data.requests.find((x) => x.id === other.id);
  assert.equal(linked.arr.existing, true);

  const later = (await kid('POST', '/api/requests', { kind: 'movie', title: 'Elsewhere', year: 2010 })).data;
  assert.equal(later.status, 'pending');
  const ok = await admin('PATCH', `/api/requests/${later.id}`, { status: 'approved', send: false });
  assert.equal(ok.data.status, 'approved');
  assert.equal(ok.data.arr, null);
  assert.equal(radarr.sent.length, before);
});

test('download states read from Radarr and Sonarr', () => {
  assert.equal(describe('radarr', null, []).state, 'gone');
  assert.equal(describe('radarr', { hasFile: true }, []).state, 'downloaded');
  assert.match(describe('radarr', { isAvailable: false, digitalRelease: '2027-03-12T00:00:00Z' }, []).label, /Not out yet \(expected 2027-03-12\)/);
  assert.equal(describe('radarr', { isAvailable: true }, []).state, 'searching');
  assert.equal(describe('radarr', { id: 1 }, [{ size: 10, sizeleft: 0, trackedDownloadState: 'importPending' }]).state, 'importing');
  assert.equal(describe('sonarr', { statistics: { episodeFileCount: 10, episodeCount: 10 } }, []).state, 'downloaded');
  assert.match(describe('sonarr', { statistics: {} }, [{ size: 10, sizeleft: 5, timeleft: '01:30:00' }, { size: 10, sizeleft: 5 }]).label, /Downloading \(2 episodes\) · 50% · 1\.5 h left/);
});
