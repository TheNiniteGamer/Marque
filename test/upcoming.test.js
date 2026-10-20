'use strict';
// "Coming soon": next episodes from Sonarr's calendar (and TMDB for shows Sonarr doesn't follow),
// films on their way from Radarr's; only what each profile may see.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');
const { fakeArr, listen, urlOf } = require('./fake-arr');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-upcoming-'));
const KEY = { radarr: 'r'.repeat(32), sonarr: 's'.repeat(32) };
const radarr = fakeArr('radarr', { key: KEY.radarr, rootFolder: path.join(ROOT, 'Movies') });
const sonarr = fakeArr('sonarr', { key: KEY.sonarr, rootFolder: path.join(ROOT, 'TV') });
const day = (n) => new Date(Date.now() + n * 86400_000).toISOString();
const SHOWS = { bluey: { id: 82728, name: 'Bluey', first_air_date: '2018-10-01' }, office: { id: 2316, name: 'The Office', first_air_date: '2005-03-24' } };
const tmdb = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/^\/3/, '');
  const send = (body) => { res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }); res.end(JSON.stringify(body || {})); };
  if (p === '/search/tv') return send({ results: Object.values(SHOWS).filter((s) => s.name.toLowerCase() === url.searchParams.get('query').toLowerCase()) });
  if (p === '/search/movie') return send({ results: [] });
  const m = /^\/tv\/(\d+)$/.exec(p);
  if (m) {
    const s = Object.values(SHOWS).find((x) => x.id === Number(m[1]));
    return send(s && { ...s, genres: [], credits: { cast: [] }, images: {}, next_episode_to_air: s.id === 2316 ? { air_date: day(3).slice(0, 10), season_number: 10, episode_number: 1, name: 'Reunion' } : null });
  }
  if (/^\/tv\/\d+\/season\/\d+$/.test(p)) return send({ episodes: [] });
  send(null);
});

let srv, admin, kid, bluey, office;
test.before(async () => {
  for (const s of [radarr.server, sonarr.server, tmdb]) await listen(s);
  clip(path.join(ROOT, 'TV', 'Bluey', 'Season 1', 'Bluey S01E01.mp4'));
  clip(path.join(ROOT, 'TV', 'The Office', 'Season 1', 'The Office S01E01.mp4'));
  fs.mkdirSync(path.join(ROOT, 'Movies'), { recursive: true });
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1', TMDB_API_KEY: 'k', TMDB_API_BASE: `${urlOf(tmdb)}/3`,
    AUTO_LIBRARIES: `TV:show:${path.join(ROOT, 'TV')};Movies:movie:${path.join(ROOT, 'Movies')}` });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'dad', password: 'password1' });
  await until(async () => (await admin('GET', '/api/libraries')).data.every((l) => l.scannedAt));
  await until(async () => (await admin('GET', '/api/search?q=Bluey')).data.shows[0]?.year === 2018);
  bluey = (await admin('GET', '/api/search?q=Bluey')).data.shows[0];
  office = (await admin('GET', '/api/search?q=Office')).data.shows[0];
  await admin('PUT', '/api/arr/sonarr', { url: urlOf(sonarr.server), apiKey: KEY.sonarr });
  await admin('PUT', '/api/arr/radarr', { url: urlOf(radarr.server), apiKey: KEY.radarr });
  await admin('POST', '/api/users', { username: 'kid', password: 'password2', maxAge: 7 });
  kid = srv.client();
  await kid('POST', '/api/auth/login', { username: 'kid', password: 'password2' });
});
test.after(async () => {
  await srv?.stop();
  for (const s of [radarr.server, sonarr.server, tmdb]) s.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('next episodes and films on their way, soonest first, one card per show', async () => {
  sonarr.calendar = [
    { seriesId: 1, seasonNumber: 3, episodeNumber: 6, title: 'Later One', airDateUtc: day(8), hasFile: false, series: { title: 'Bluey', tmdbId: 82728 } },
    { seriesId: 1, seasonNumber: 3, episodeNumber: 5, title: 'Sticky Gecko', airDateUtc: day(1), hasFile: false, series: { title: 'Bluey', tmdbId: 82728 } },
    { seriesId: 1, seasonNumber: 3, episodeNumber: 4, title: 'Here Already', airDateUtc: day(0.2), hasFile: true, series: { title: 'Bluey', tmdbId: 82728 } },
    { seriesId: 9, seasonNumber: 1, episodeNumber: 1, title: 'Not ours', airDateUtc: day(2), hasFile: false, series: { title: 'Some Other Show', tmdbId: 1 } },
  ];
  radarr.calendar = [{ id: 3, tmdbId: 693134, title: 'Dune: Part Three', year: 2026, hasFile: false, inCinemas: day(-60), digitalRelease: day(5),
    images: [{ coverType: 'fanart', remoteUrl: 'https://image.tmdb.org/t/p/original/x.jpg' }] }];
  // The Office isn't in Sonarr: its next episode comes from TMDB, as someone's been watching it.
  const ep = (await admin('GET', `/api/shows/${office.id}`)).data.seasons[0].episodes[0];
  await admin('POST', `/api/items/${ep.id}/progress`, { position: 0.5 });

  const list = (await admin('GET', '/api/upcoming?refresh=1')).data;
  assert.deepEqual(list.map((x) => [x.kind, x.title, x.season ?? null, x.episode ?? null]),
    [['episode', 'Bluey', 3, 5], ['episode', 'The Office', 10, 1], ['movie', 'Dune: Part Three', null, null]]);
  assert.equal(list[0].showId, bluey.id);
  assert.equal(list[0].href, `#/show/${bluey.id}`);
  assert.deepEqual([list[2].release, list[2].image], ['To stream or buy', 'https://image.tmdb.org/t/p/original/x.jpg']);
  assert.equal(sonarr.calendarQuery.unmonitored, 'false');

  const home = (await admin('GET', '/api/home')).data.hubs.find((h) => h.key === 'upcoming');
  assert.equal(home.title, 'Coming soon');
  assert.equal(home.items.length, 3);
});

test('kids see their shows’ episodes but not films that aren’t here yet; the row can be turned off', async () => {
  assert.deepEqual((await kid('GET', '/api/upcoming')).data.map((x) => x.title), ['Bluey', 'The Office']);
  await admin('PATCH', '/api/settings', { home: { upcoming: false } });
  assert.ok(!(await admin('GET', '/api/home')).data.hubs.some((h) => h.key === 'upcoming'));
});
