'use strict';
// How sure matches are: scoring, running time, ids in names, "Needs a check" and re-checking a library.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');
const { similarity, scoreResults, runtimePoints } = require('../lib/matcher');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-match-'));
// The test clips are 1 second long, so "the right film" has a 1-minute running time here.
const MOVIES = {
  10: { title: 'Dune', release_date: '1984-12-14', runtime: 137 },
  11: { title: 'Dune', release_date: '2021-09-15', runtime: 1 },
  20: { title: 'The Lion King', release_date: '1994-06-15', runtime: 1 },
  21: { title: 'The Lion King', release_date: '2019-07-12', runtime: 118 },
  30: { title: 'Randomized', release_date: '2011-01-01', runtime: 90 },
  40: { title: 'Alien', release_date: '1979-05-25', runtime: null }, // unknown: no help from the running time
  50: { title: 'Gamma', release_date: '2005-01-01', runtime: 1 },
  51: { title: 'Gamma Rays', release_date: '2007-01-01', runtime: 1 },
  949: { title: 'Heat', release_date: '1995-12-15', runtime: 1 },
  950: { title: 'Heat Wave', release_date: '1995-01-01', runtime: 1 },
};
const searchable = new Set(Object.keys(MOVIES).filter((id) => id !== '51'));
const requests = [];
const mock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  requests.push(url.pathname + url.search);
  const send = (body) => { res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }); res.end(JSON.stringify(body || {})); };
  const p = url.pathname.replace(/^\/3/, '');
  const asResult = (id) => ({ id: Number(id), title: MOVIES[id].title, original_title: MOVIES[id].title, release_date: MOVIES[id].release_date });
  if (p === '/search/movie') {
    const words = url.searchParams.get('query').toLowerCase().split(/\s+/);
    return send({ results: [...searchable].filter((id) => words.some((w) => w.length > 2 && MOVIES[id].title.toLowerCase().includes(w))).map(asResult) });
  }
  if (p === '/find/tt0113277') return send({ movie_results: [{ id: 949 }], tv_results: [] });
  if (p === '/find/73244') return send({ movie_results: [], tv_results: [{ id: 2316 }] });
  if (p === '/tv/2316') return send({ id: 2316, name: 'The Office', first_air_date: '2005-03-24', genres: [], credits: { cast: [] }, images: {} });
  if (p === '/tv/2316/season/1') return send({ episodes: [{ episode_number: 1, name: 'Pilot' }] });
  if (p === '/search/tv') return send({ results: [] });
  const m = /^\/movie\/(\d+)$/.exec(p);
  send(m && MOVIES[m[1]] ? { id: Number(m[1]), ...MOVIES[m[1]], genres: [], credits: { cast: [] }, images: {} } : null);
});

let srv, admin, lib;
const titles = {};
const meta = async (file) => (await admin('GET', `/api/items/${titles[file]}`)).data;

test.before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${mock.address().port}`;
  for (const name of ['Dune (2021)', 'The Lion King', 'Random Home Video', 'Alien Directors Cut (1979)', 'Gamma (2005)', 'Heat (1995) {tmdb-949}', 'Heat Wave [imdbid-tt0113277]']) {
    clip(path.join(ROOT, 'Movies', `${name}.mp4`));
  }
  clip(path.join(ROOT, 'TV', 'Office {tvdb-73244}', 'Season 1', 'Office S01E01.mp4'));
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TMDB_API_KEY: 'k', TMDB_API_BASE: `${base}/3`, TMDB_IMAGE_BASE: `${base}/img`, TVMAZE_DISABLED: '1',
    AUTO_LIBRARIES: `Movies:movie:${path.join(ROOT, 'Movies')};TV:show:${path.join(ROOT, 'TV')}` });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  await until(async () => { const l = (await admin('GET', '/api/libraries')).data; return l.length === 2 && l.every((x) => x.scannedAt) && !(await admin('GET', '/api/status')).data.scanning; });
  const libs = Object.fromEntries((await admin('GET', '/api/libraries')).data.map((l) => [l.name, l.id]));
  lib = libs.Movies;
  // By file name (titles change once matched).
  for (const it of (await admin('GET', `/api/libraries/${lib}/items`)).data.items) {
    const d = (await admin('GET', `/api/items/${it.id}`)).data;
    titles[d.fileName.replace(/\.mp4$/, '')] = it.id;
    for (const v of d.versions || []) titles[v.fileName.replace(/\.mp4$/, '')] = v.id; // (copies of one film are listed once)
  }
  titles.office = (await admin('GET', `/api/libraries/${libs.TV}/items`)).data.items[0].id;
});
test.after(async () => { await srv?.stop(); mock.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('titles are compared the way people write them', () => {
  assert.equal(similarity('The Lord of the Rings Fellowship of the Ring', 'The Lord of the Rings: The Fellowship of the Ring'), 1);
  assert.equal(similarity('Rocky II', 'Rocky 2'), 1);
  assert.equal(similarity('Fast & Furious', 'Fast and Furious'), 1);
  assert.equal(similarity('Amelie', 'Amélie'), 1);
  assert.equal(similarity('Alien', 'Alien: Director’s Cut'), 0.85);
  assert.ok(similarity('Fresh Show', 'Some Show') < 0.6);
  const [top] = scoreResults([{ title: 'Dune', year: 1984 }, { title: 'Dune', year: 2021 }], 'Dune', 2021);
  assert.equal(top.year, 2021);
  assert.ok(top.score >= 80);
  assert.equal(runtimePoints(120, 118), 15);
  assert.equal(runtimePoints(120, 60), -25);
});

test('the year and the running time pick the right film', async () => {
  assert.deepEqual([(await meta('Dune (2021)')).year, (await meta('Dune (2021)')).match.uncertain], [2021, false]);
  // No year in the name: two films called The Lion King; the 1-minute file is the 1-minute one.
  const lion = await meta('The Lion King');
  assert.deepEqual([lion.year, lion.match.providerId, lion.match.uncertain], [1994, '20', false]);
});

test('a poor match is not applied; doubtful ones are listed to check', async () => {
  const home = await meta('Random Home Video');
  assert.equal(home.title, 'Random Home Video', 'keeps its own name instead of a wrong film');
  assert.deepEqual(home.match, { notFound: true });
  const alien = await meta('Alien Directors Cut (1979)');
  assert.deepEqual([alien.title, alien.match.uncertain], ['Alien', true], 'probably right, but listed');

  const p = (await admin('GET', '/api/problems')).data;
  const review = Object.fromEntries(p.review.map((r) => [r.name, r]));
  assert.ok(review['Random Home Video'] && !review['Random Home Video'].current);
  assert.equal(review['Random Home Video'].candidates[0].title, 'Randomized');
  assert.equal(review['Alien Directors Cut'].current.title, 'Alien');
  assert.ok(!p.unmatched.some((x) => x.title === 'Random Home Video'), 'listed once, with its guesses');

  // "It's right" and picking a guess both take it off the list.
  assert.equal((await admin('POST', `/api/meta/${titles['Alien Directors Cut (1979)']}/confirm`)).status, 200);
  assert.equal((await meta('Alien Directors Cut (1979)')).match.uncertain, false);
  await admin('POST', `/api/meta/${titles['Random Home Video']}/match`, { provider: 'tmdb', id: '30' });
  const left = (await admin('GET', '/api/problems')).data.review.map((r) => r.name);
  assert.ok(!left.includes('Alien Directors Cut') && !left.includes('Random Home Video'));
});

test('ids in file and folder names match exactly', async () => {
  const heat = await meta('Heat (1995) {tmdb-949}');
  assert.deepEqual([heat.match.providerId, heat.year], ['949', 1995]);
  // "Heat Wave" would be the obvious search result, but the IMDb id says it's Heat.
  const wave = await meta('Heat Wave [imdbid-tt0113277]');
  assert.equal(wave.match.providerId, '949');
  assert.equal(wave.versionOf || heat.versionOf, wave.versionOf ? heat.id : wave.id, 'two copies of the same film: one title, two versions');
  assert.ok(requests.includes('/3/find/tt0113277?language=en-US&external_source=imdb_id&api_key=k'));
  const office = (await admin('GET', `/api/shows/${titles.office}`)).data;
  assert.deepEqual([office.title, office.match.providerId], ['The Office', '2316']);
  assert.equal(office.seasons[0].episodes[0].title, 'Pilot');
});

test('re-checking a library fixes matches that no longer hold up, and keeps chosen ones', async () => {
  // TMDB now also lists "Gamma Rays"; Gamma (2005) still matches Gamma, nothing changes there.
  searchable.add('51');
  const before = (await meta('Gamma (2005)')).match.providerId;
  // Make the old match of Dune doubtful: TMDB stops listing it.
  searchable.delete('11');
  const r = await admin('POST', `/api/libraries/${lib}/recheck-matches`);
  assert.equal(r.status, 202);
  const done = await until(async () => { const p = (await admin('GET', '/api/problems')).data; return !p.recheck && p.lastRecheck; });
  assert.equal(done.library, 'Movies');
  assert.equal((await meta('Gamma (2005)')).match.providerId, before);
  const dune = await meta('Dune (2021)');
  assert.deepEqual([dune.match.providerId, dune.match.uncertain], ['11', true], 'kept, but listed to check');
  const chosen = await meta('Random Home Video');
  assert.equal(chosen.match?.providerId, '30', `chosen by hand: left alone (${JSON.stringify(chosen.match)} ${chosen.title})`);
  searchable.add('11');
});
