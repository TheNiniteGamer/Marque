'use strict';
// Small rules behind the family fixes: a request is found when it arrives whatever Marquee matched
// it with; a full text subtitle is still fetched when a title only has picture or "forced" ones;
// and which titles count as not identified yet (hidden from age-limited profiles).

const test = require('node:test');
const assert = require('node:assert/strict');
const requests = require('../lib/requests');
const { AutoSubs } = require('../lib/autosubs');
const { unidentified, allowedFor } = require('../lib/ratings');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../lib/store');
const lib = require('../lib/library');

const storeWith = ({ shows = {}, items = {}, reqs = {} }) => ({ data: {
  users: [{ id: 'mum', username: 'mum', role: 'user' }],
  libraries: [{ id: 'tv', name: 'TV', type: 'show' }, { id: 'films', name: 'Films', type: 'movie' }],
  items, shows, notifications: {}, settings: {}, requests: reqs,
}, save() {}, rev: 1 });

test('a show sent to Sonarr is found by Sonarr’s TheTVDB id, though Marquee matched it on another site', () => {
  const store = storeWith({
    shows: { s1: { id: 's1', libraryId: 'tv', title: 'The Office (US)', meta: { provider: 'tvdb', providerId: '73244', title: 'The Office (US)', year: 2005 } } },
    reqs: { r1: { id: 'r1', kind: 'show', status: 'approved', userIds: ['mum'], title: 'The Office', year: 2005, provider: 'tmdb', providerId: '2316', createdAt: 1,
      arr: { app: 'sonarr', id: 7, tvdbId: 73244 } } },
  });
  assert.equal(requests.checkArrivals(store), 1);
  assert.equal(store.data.requests.r1.availableId, 's1');
});

test('a name with a country in brackets still matches the request', () => {
  const store = storeWith({
    shows: { s1: { id: 's1', libraryId: 'tv', title: 'The Office (US)', meta: { provider: 'tvmaze', providerId: '526', title: 'The Office (US)', year: 2005 } } },
    reqs: { r1: { id: 'r1', kind: 'show', status: 'approved', userIds: ['mum'], title: 'The Office', year: 2005, provider: 'tmdb', providerId: '2316', createdAt: 1 } },
  });
  assert.equal(requests.checkArrivals(store), 1);
});

test('picture and "forced" subtitles don’t stop a full text one being fetched', () => {
  const subs = new AutoSubs({ data: { settings: {} }, save() {} }, null, '/tmp');
  const dvd = { media: { subtitles: [{ index: 2, codec: 'dvd_subtitle', text: false, lang: 'eng' }] } };
  assert.equal(subs.has(dvd, 'en'), false, 'a DVD’s picture subtitles');
  const forced = { media: { subtitles: [{ index: 2, codec: 'subrip', text: true, forced: true, lang: 'eng' }] }, sidecarSubs: [{ lang: 'en', forced: true }] };
  assert.equal(subs.has(forced, 'en'), false, 'only the foreign-language bits');
  assert.equal(subs.has({ media: { subtitles: [{ index: 2, codec: 'subrip', text: true, lang: 'eng' }] } }, 'en'), true);
});

test('which titles aren’t identified yet', () => {
  const store = storeWith({});
  assert.equal(unidentified(store, { meta: null }), true, 'never matched');
  assert.equal(unidentified(store, { meta: { notFound: true } }), true);
  assert.equal(unidentified(store, { meta: { provider: 'tmdb', uncertain: true, contentRating: { cert: 'G', age: 0 } } }), true, 'a doubtful match’s rating may be another film’s');
  assert.equal(unidentified(store, { meta: { provider: 'tmdb' } }), false);
  assert.equal(unidentified(store, { meta: { unmatched: true } }), false, 'an admin said it isn’t a film (home videos)');
  assert.equal(unidentified(store, { meta: { provider: 'video' } }), false, 'downloaded videos');
  assert.equal(unidentified(store, { meta: null, edits: { contentRating: 'PG' } }), false, 'an admin gave it a rating');
  const kid = { id: 'k', role: 'user', maxAge: 10 };
  assert.equal(allowedFor(store, kid, { meta: null }), false);
  assert.equal(allowedFor(store, { id: 'a', role: 'admin' }, { meta: null }), true);
  assert.equal(allowedFor(store, { id: 'g', role: 'user', maxAge: null }, { meta: null }), true, 'no limit, no change');
});

test('a converted copy lists the original’s DVD subtitles, and they’re drawn in from the original', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-family-'));
  try {
    const store = new Store(path.join(dir, 'db.json'));
    store.data.libraries.push({ id: 'films', name: 'Films', type: 'movie', paths: [dir] });
    const subtitles = [{ index: 2, codec: 'dvd_subtitle', text: false, lang: 'eng' }, { index: 3, codec: 'subrip', text: true, lang: 'fre' }];
    store.data.items.f1 = {
      id: 'f1', type: 'movie', libraryId: 'films', title: 'Old Film', year: 1999, file: path.join(dir, 'Old Film.mkv'), size: 1, mtime: 1, addedAt: 1,
      media: { duration: 5400, video: { codec: 'mpeg2video', width: 720, height: 480 }, audio: [{ codec: 'ac3', channels: 6 }], subtitles },
      optimized: { file: path.join(dir, 'f1-1.mp4'), size: 1, createdAt: 2, media: { duration: 5400, video: { codec: 'h264', width: 854, height: 480 }, audio: [{ codec: 'aac', channels: 2 }], subtitles: [{ index: 2, codec: 'mov_text', text: true, lang: 'fre' }] } },
    };
    const admin = { id: 'a', role: 'admin', libraries: null };
    const copy = lib.resolveItem(store, 'f1~o');
    const picture = lib.itemDetail(store, admin, copy).subtitles.find((s) => s.burn != null);
    assert.deepEqual([picture?.id, picture?.burn, picture?.lang], ['img2', 2, 'eng'], 'listed though the copy has none');
    assert.equal(lib.pictureSubsOf(store, copy), store.data.items.f1, 'drawn in from the original');
    assert.equal(lib.pictureSubsOf(store, store.data.items.f1), store.data.items.f1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
