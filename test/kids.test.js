'use strict';
// Kids profiles: titles rated above a profile's age limit are hidden everywhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');
const { ageFor } = require('../lib/ratings');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-kids-'));
let srv, admin, kid, ids;
test.before(async () => {
  clip(path.join(ROOT, 'Movies', 'Toy Story (1995)', 'Toy Story (1995).mp4'));
  clip(path.join(ROOT, 'Movies', 'Alien (1979)', 'Alien (1979).mp4'));
  clip(path.join(ROOT, 'Movies', 'Home Video (2020)', 'Home Video (2020).mp4'));
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), AUTO_LIBRARIES: `Movies:movie:${path.join(ROOT, 'Movies')}` });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  await until(async () => (await admin('GET', '/api/libraries')).data[0]?.scannedAt);
  const lib = (await admin('GET', '/api/libraries')).data[0].id;
  const items = (await admin('GET', `/api/libraries/${lib}/items`)).data.items;
  ids = Object.fromEntries(items.map((i) => [i.title, i.id]));
  // Ratings by hand (no TMDB in tests): G and R; the home video has none.
  assert.equal((await admin('PATCH', `/api/meta/${ids['Toy Story']}`, { contentRating: 'g' })).status, 200);
  await admin('PATCH', `/api/meta/${ids.Alien}`, { contentRating: 'R' });
  assert.equal((await admin('PATCH', `/api/meta/${ids.Alien}`, { contentRating: 'Banana' })).status, 400);
  await admin('POST', '/api/users', { username: 'Ellie', password: 'password1' });
  kid = srv.client();
  await kid('POST', '/api/auth/login', { username: 'Ellie', password: 'password1' });
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('ratings from different countries become ages', () => {
  assert.equal(ageFor('PG-13'), 13);
  assert.equal(ageFor('TV-Y7'), 7);
  assert.equal(ageFor('12A'), 12);
  assert.equal(ageFor('MA15+'), 15);
  assert.equal(ageFor('FSK 16'), 16);
  assert.equal(ageFor('NR'), null);
});

test('a kids profile only sees titles rated for its age', async () => {
  const titles = async () => {
    const lib = (await kid('GET', '/api/libraries')).data[0];
    return (await kid('GET', `/api/libraries/${lib.id}/items`)).data.items.map((i) => i.title).sort();
  };
  assert.deepEqual(await titles(), ['Alien', 'Home Video', 'Toy Story']);
  const users = (await admin('GET', '/api/users')).data;
  const ellie = users.find((u) => u.username === 'Ellie');
  await admin('PATCH', `/api/users/${ellie.id}`, { maxAge: 7 });
  assert.deepEqual(await titles(), ['Home Video', 'Toy Story'], 'R is hidden, unrated still shown');
  // Hidden titles look like they don't exist: details, playback, artwork, search.
  assert.equal((await kid('GET', `/api/items/${ids.Alien}`)).status, 404);
  assert.equal((await kid('GET', `/api/items/${ids.Alien}/playback`)).status, 404);
  assert.equal((await kid('GET', `/api/art/backdrop/${ids.Alien}`)).status, 404);
  assert.equal((await kid('GET', '/api/search?q=alien')).data.movies.length, 0);
  assert.equal((await admin('GET', '/api/search?q=alien')).data.movies.length, 1);
  assert.equal((await kid('GET', `/api/items/${ids['Toy Story']}`)).data.contentRating, 'G');
  // Without unrated titles too.
  await admin('PATCH', `/api/users/${ellie.id}`, { allowUnrated: false });
  assert.deepEqual(await titles(), ['Toy Story']);
  assert.equal((await kid('GET', '/api/auth/me')).data.user.maxAge, 7);
  // Admins always see everything.
  const lib = (await admin('GET', '/api/libraries')).data[0];
  assert.equal((await admin('GET', `/api/libraries/${lib.id}/items`)).data.items.length, 3);
  assert.equal((await admin('PATCH', `/api/users/${ellie.id}`, { maxAge: 40 })).status, 400);
});

test('TMDB certifications: our country first, then the US', () => {
  const md = require('../lib/metadata');
  const film = { release_dates: { results: [
    { iso_3166_1: 'FR', release_dates: [{ certification: '12' }] },
    { iso_3166_1: 'US', release_dates: [{ certification: '' }, { certification: 'PG-13' }] },
  ] } };
  assert.deepEqual(md.contentRatingOf(true, film), { cert: 'PG-13', age: 13 });
  const show = { content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-Y7' }] } };
  assert.deepEqual(md.contentRatingOf(false, show), { cert: 'TV-Y7', age: 7 });
  assert.equal(md.contentRatingOf(false, {}), null);
});
