'use strict';
// After a request goes to Sonarr / Radarr (mocked): a show is "here" only once Sonarr has all it
// was asked for (its first episodes are told on their own); asking for more seasons of a show
// that's here; requests that skip approval waiting when space is low or a weekly limit is reached;
// and things not found after some days flagged, with Look again / another quality.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');
const { fakeArr, listen, urlOf } = require('./fake-arr');
const requests = require('../lib/requests');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-arrfu-'));
const MOVIES = path.join(ROOT, 'Movies'), TV = path.join(ROOT, 'TV');
const KEY = { radarr: 'r'.repeat(32), sonarr: 's'.repeat(32) };
const radarr = fakeArr('radarr', { key: KEY.radarr, rootFolder: MOVIES });
const sonarr = fakeArr('sonarr', { key: KEY.sonarr, rootFolder: TV });

// TMDB: Breaking Bad (five seasons of 7 episodes, as far as these tests care).
const tmdb = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname.replace(/^\/3/, '');
  const send = (body) => { res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }); res.end(JSON.stringify(body || {})); };
  if (p === '/search/tv') return send({ results: [{ id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20' }] });
  if (p === '/search/movie') return send({ results: [] });
  if (p === '/tv/1396/external_ids') return send({ id: 1396, tvdb_id: 81189 });
  if (p === '/tv/1396') {
    return send({ id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20', genres: [], credits: { cast: [] }, images: {},
      seasons: [0, 1, 2, 3, 4, 5].map((n) => ({ season_number: n, episode_count: 7, name: n ? `Season ${n}` : 'Specials', air_date: `${2007 + n}-01-20` })) });
  }
  if (/^\/tv\/1396\/season\/\d+$/.test(p)) return send({ episodes: [] });
  send(null);
});

let srv, admin, kid, kidId, tvLib;
const notes = async (c) => (await c('GET', '/api/notifications')).data.items.map((n) => n.title);
const reqs = async (c = admin) => (await c('GET', '/api/requests')).data.requests;
const rescan = async () => {
  await admin('POST', `/api/libraries/${tvLib}/scan`, {});
  await until(async () => !(await admin('GET', '/api/status')).data.scanning);
};

test.before(async () => {
  for (const s of [radarr.server, sonarr.server, tmdb]) await listen(s);
  clip(path.join(MOVIES, 'Old (2001).mp4'));
  clip(path.join(TV, 'Other', 'Season 1', 'Other S01E01.mp4'));
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1', TMDB_API_KEY: 'k', TMDB_API_BASE: `${urlOf(tmdb)}/3`,
    REQUEST_FOLLOWUP_MS: '300', AUTO_LIBRARIES: `Movies:movie:${MOVIES};TV:show:${TV}` });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'dad', password: 'password1' });
  await until(async () => (await admin('GET', '/api/libraries')).data.every((l) => l.scannedAt));
  tvLib = (await admin('GET', '/api/libraries')).data.find((l) => l.name === 'TV').id;
  kidId = (await admin('POST', '/api/users', { username: 'kid', password: 'password2', autoApprove: { movie: true, show: true } })).data.id;
  kid = srv.client();
  await kid('POST', '/api/auth/login', { username: 'kid', password: 'password2' });
  assert.equal((await admin('PUT', '/api/arr/radarr', { url: urlOf(radarr.server), apiKey: KEY.radarr, profileId: 4, rootFolder: MOVIES })).status, 200);
  assert.equal((await admin('PUT', '/api/arr/sonarr', { url: urlOf(sonarr.server), apiKey: KEY.sonarr, profileId: 4, rootFolder: TV, monitor: 'firstSeason' })).status, 200);
  assert.equal((await admin('PUT', '/api/request-rules', { minFreeGb: 0 })).status, 200);
});
test.after(async () => {
  await srv?.stop();
  for (const s of [radarr.server, sonarr.server, tmdb]) s.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('a show is “here” only when Sonarr has it all; the first episodes are told on their own', async () => {
  const r = (await kid('POST', '/api/requests', { kind: 'show', title: 'Breaking Bad', year: 2008, provider: 'tmdb', providerId: '1396' })).data;
  assert.equal(r.sent, true);
  const series = Object.values(sonarr.items)[0];
  assert.deepEqual(series.seasons.filter((x) => x.monitored).map((x) => x.seasonNumber), [1], 'first season only');

  // Season 1's first episode lands.
  clip(path.join(TV, 'Breaking Bad', 'Season 1', 'Breaking Bad S01E01.mp4'));
  await rescan();
  await until(async () => (await reqs(kid)).find((x) => x.id === r.id).firstHere);
  let mine = (await reqs(kid)).find((x) => x.id === r.id);
  assert.equal(mine.status, 'approved', 'not "here" yet');
  assert.ok(mine.availableId, 'but it can be watched');
  assert.ok((await notes(kid)).includes('The first episodes of Breaking Bad are here'));
  assert.ok(!(await notes(kid)).includes('Breaking Bad is here'));

  // Sonarr has the whole season: now it's here.
  series.statistics = { episodeFileCount: 7, episodeCount: 7, percentOfEpisodes: 100 };
  await until(async () => (await reqs(kid)).find((x) => x.id === r.id).status === 'available');
  assert.ok((await notes(kid)).includes('Breaking Bad is here'));
});

test('asking for more seasons of a show that’s here', async () => {
  const show = (await kid('GET', '/api/search?q=Breaking')).data.shows[0];
  const d = (await kid('GET', `/api/shows/${show.id}/seasons`)).data;
  assert.equal(d.sonarr, true);
  assert.deepEqual(d.seasons.map((x) => [x.season, x.episodes, x.here, x.asked]), [[1, 7, 1, false], [2, 7, 0, false], [3, 7, 0, false], [4, 7, 0, false], [5, 7, 0, false]], 'specials left out');

  const r = (await kid('POST', '/api/requests', { showId: show.id, seasons: [3, 2, 2] })).data;
  assert.equal(r.sent, true, JSON.stringify(r));
  assert.deepEqual(r.seasons, [2, 3]);
  const series = Object.values(sonarr.items)[0];
  assert.deepEqual(series.seasons.filter((x) => x.monitored).map((x) => x.seasonNumber), [1, 2, 3], 'Sonarr now watches seasons 2 and 3 as well');
  assert.deepEqual(sonarr.sent.filter((x) => x.path === '/command').map((x) => [x.body.name, x.body.seasonNumber]), [['SeasonSearch', 2], ['SeasonSearch', 3]]);
  assert.equal(sonarr.sent.filter((x) => x.method === 'POST' && x.path === '/series').length, 1, 'not added twice');
  assert.equal((await kid('POST', '/api/requests', { showId: show.id, seasons: [2] })).data.id, r.id, 'asking again joins it');
  assert.equal((await kid('GET', `/api/shows/${show.id}/seasons`)).data.seasons.find((x) => x.season === 2).asked, true);
  assert.equal((await kid('POST', '/api/requests', { showId: show.id, seasons: [] })).status, 400);
  assert.equal((await kid('POST', '/api/requests', { showId: 'nope', seasons: [2] })).status, 404);

  // Progress counts only seasons 2 and 3.
  series.seasons = series.seasons.map((x) => ({ ...x, statistics: x.seasonNumber === 2 ? { episodeFileCount: 7, episodeCount: 7 } : x.seasonNumber === 3 ? { episodeFileCount: 0, episodeCount: 7 } : x.statistics }));
  await until(async () => (await reqs()).find((x) => x.id === r.id).progress?.label === '7 of 14 episodes downloaded');

  clip(path.join(TV, 'Breaking Bad', 'Season 2', 'Breaking Bad S02E01.mp4'));
  await rescan();
  await until(async () => (await reqs(kid)).find((x) => x.id === r.id).firstHere);
  series.seasons = series.seasons.map((x) => (x.seasonNumber === 3 ? { ...x, statistics: { episodeFileCount: 7, episodeCount: 7 } } : x));
  await until(async () => (await reqs(kid)).find((x) => x.id === r.id).status === 'available');
  assert.ok((await notes(kid)).includes('Breaking Bad (seasons 2 and 3) is here'));
});

test('skipping approval waits for an admin when space is low or a weekly limit is reached', async () => {
  assert.equal((await admin('PUT', '/api/request-rules', { minFreeGb: 600 })).data.minFreeGb, 600);
  const before = radarr.sent.length;
  let r = (await kid('POST', '/api/requests', { kind: 'movie', title: 'The Matrix', year: 1999, provider: 'tmdb', providerId: '603' })).data;
  assert.equal(r.status, 'pending');
  assert.equal(r.sent, false);
  assert.match(r.held, /only 500 GB free where downloads go \(the limit is 600 GB\)/);
  assert.equal(radarr.sent.length, before, 'nothing sent');
  assert.ok((await admin('GET', '/api/notifications')).data.items.some((n) => n.title === 'kid asked for The Matrix (1999)' && /Waiting for you: only 500 GB/.test(n.body)));
  // An admin's approval still sends it.
  assert.equal((await admin('PATCH', `/api/requests/${r.id}`, { status: 'approved' })).data.arr.app, 'radarr');
  assert.equal((await reqs()).find((x) => x.id === r.id).held, null);

  await admin('PUT', '/api/request-rules', { minFreeGb: 0, weekly: { show: 2 } });
  const show = (await kid('GET', '/api/search?q=Breaking')).data.shows[0];
  r = (await kid('POST', '/api/requests', { showId: show.id, seasons: [4] })).data;
  assert.equal(r.status, 'pending', 'two shows this week already');
  assert.match(r.held, /kid has had 2 shows this week \(the limit is 2\)/);
  assert.equal((await admin('POST', '/api/requests', { showId: show.id, seasons: [5] })).data.sent, true, 'admins are never held');
  assert.equal((await kid('PUT', '/api/request-rules', { minFreeGb: 1 })).status, 403);
  assert.equal((await admin('PUT', '/api/request-rules', { stuckDays: -1 })).status, 400);
});

test('look again, or switch to another quality and look again', async () => {
  const film = (await reqs()).find((x) => x.title === 'The Matrix');
  const n = radarr.sent.length;
  assert.equal((await admin('POST', `/api/requests/${film.id}/search-again`, {})).status, 200);
  assert.deepEqual(radarr.sent.slice(n).map((x) => [x.method, x.path, x.body.name]), [['POST', '/command', 'MoviesSearch']]);
  assert.equal((await admin('POST', `/api/requests/${film.id}/search-again`, { profileId: 1 })).status, 200);
  const put = radarr.sent.find((x) => x.method === 'PUT');
  assert.deepEqual([put.path, put.body.qualityProfileId], [`/movie/${film.arr.id}`, 1]);
  assert.equal((await reqs()).find((x) => x.id === film.id).arr.profile, 'Any');
  assert.equal((await kid('POST', `/api/requests/${film.id}/search-again`, {})).status, 403);
});

test('something not found after the set number of days is flagged to admins, once', async () => {
  const day = 86400_000;
  const store = { data: { users: [{ id: 'a', role: 'admin' }, { id: 'k', role: 'user' }], settings: { requestRules: { stuckDays: 7 } }, shows: {}, items: {},
    requests: { r1: { id: 'r1', kind: 'movie', title: 'Rare', status: 'approved', userIds: ['k'], arr: { app: 'radarr', id: 5, sentAt: 0 } } } }, save() {} };
  const fake = (state) => ({ progress: async () => ({ r1: { state } }) });
  assert.equal(await requests.followUp(store, fake('searching'), 6 * day), 0, 'not yet');
  assert.equal(await requests.followUp(store, fake('notReleased'), 9 * day), 0, 'not out yet is not stuck');
  assert.equal(await requests.followUp(store, fake('searching'), 9 * day), 1);
  assert.equal(store.data.requests.r1.arr.stuckAt, 9 * day);
  assert.deepEqual(store.data.notifications.a.map((x) => x.title), ['Rare hasn’t been found in 9 days']);
  assert.equal(store.data.notifications.k, undefined, 'only admins');
  await requests.followUp(store, fake('searching'), 12 * day);
  assert.equal(store.data.notifications.a.length, 1, 'told once');
  await requests.followUp(store, fake('downloading'), 13 * day);
  assert.equal(store.data.requests.r1.arr.stuckAt, undefined, 'found after all');
});
