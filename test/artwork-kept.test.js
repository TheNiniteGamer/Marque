'use strict';
// Refreshing a title's details when its pictures can't be downloaded (the source busy or down for
// a moment) keeps the pictures it had, rather than leaving it with none. A title matched to
// something else doesn't keep the old one's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const md = require('../lib/metadata');
const { Matcher } = require('../lib/matcher');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-artwork-'));
test.after(() => { delete md.PROVIDERS.fake; fs.rmSync(ROOT, { recursive: true, force: true }); });

// A metadata source, and downloads that work until `down` is set.
let down = false;
md.PROVIDERS.fake = {
  id: 'fake', name: 'Fake', kinds: ['movie', 'show'], enabled: () => true,
  details: async (kind, id) => ({ providerId: id, title: `Title ${id}`, year: 2001, posterUrl: `https://img.example/${id}-p.jpg`, backdropUrl: `https://img.example/${id}-b.jpg`,
    episodeMap: new Map([[1, new Map([[1, { title: 'Pilot', stillUrl: `https://img.example/${id}-s1e1.jpg` }]])]]) }),
};
const realDownload = md.downloadImage;
test.before(() => {
  md.downloadImage = async (url, dir, name) => {
    if (down) throw new Error('Image download failed (HTTP 503)');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}-${path.basename(url)}`);
    fs.writeFileSync(file, 'picture');
    return file;
  };
});
test.after(() => { md.downloadImage = realDownload; });

test('pictures that can’t be fetched this time are kept, for the same title only', async () => {
  const store = { data: { items: { m1: { id: 'm1', type: 'movie', title: 'Film' } }, shows: {} }, save() {} };
  const matcher = new Matcher(store, path.join(ROOT, 'images'));
  const film = store.data.items.m1;
  down = false;
  await matcher.apply(film, 'movie', 'fake', '100');
  const { poster, backdrop } = film.meta;
  assert.ok(poster && fs.existsSync(poster));

  down = true;
  await matcher.apply(film, 'movie', 'fake', '100'); // a refresh
  assert.equal(film.meta.poster, poster);
  assert.equal(film.meta.backdrop, backdrop);
  assert.ok(film.meta.fetchedAt);

  await matcher.apply(film, 'movie', 'fake', '200'); // matched to another title
  assert.equal(film.meta.poster, null, 'not the other title’s picture');
});

test('episode pictures are kept the same way', async () => {
  const store = { data: { items: { e1: { id: 'e1', type: 'episode', showId: 's1', season: 1, episode: 1, file: '/tv/Show/S01E01.mkv' } }, shows: { s1: { id: 's1', title: 'Show' } } }, save() {} };
  const matcher = new Matcher(store, path.join(ROOT, 'images'));
  const show = store.data.shows.s1, ep = store.data.items.e1;
  down = false;
  await matcher.apply(show, 'show', 'fake', '300');
  const still = ep.meta.still;
  assert.ok(still && fs.existsSync(still));
  down = true;
  await matcher.apply(show, 'show', 'fake', '300');
  assert.equal(ep.meta.still, still);
  assert.equal(ep.meta.title, 'Pilot');
  await matcher.apply(show, 'show', 'fake', '400');
  assert.equal(ep.meta.still, null);
});
