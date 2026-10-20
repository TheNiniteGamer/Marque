'use strict';
// Discs ripped with MakeMKV (one film and its extras), and several versions of one film
// (4K and 1080p, say) shown as one title.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const parse = require('../lib/parse');
const { execFileSync } = require('node:child_process');
const { clip, startServer, until } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-versions-'));
let srv, admin;

test('MakeMKV titles are named after the disc, or the folder when the disc name says nothing', () => {
  const p = (f) => parse.parseMovie(f.split('/').join(path.sep));
  assert.deepEqual(p('/m/Men In Black (1997)/Men In Black_t00.mkv'), { title: 'Men In Black', year: 1997 });
  assert.deepEqual(p('/m/Heat (1995)/title_t03.mkv'), { title: 'Heat', year: 1995 });
  assert.deepEqual(parse.discTitle('/m/x/MIB_t12.mkv'), { name: 'MIB', n: 12 });
  assert.equal(parse.discTitle('/m/Se7en (1995)/Se7en.mkv'), null);
});

test.before(async () => {
  const disc = path.join(ROOT, 'Movies', 'Men In Black (1997)');
  clip(path.join(disc, 'Men In Black_t00.mkv'), 20);
  clip(path.join(disc, 'Men In Black_t01.mkv'), 2);
  clip(path.join(disc, 'Men In Black_t02.mkv'), 3);
  // The same film twice: a 1080p H.264 MP4, and a 4K HDR10 HEVC MKV (Plex's "- label" naming).
  const dune = path.join(ROOT, 'Movies', 'Dune (2021)');
  fs.mkdirSync(dune, { recursive: true });
  const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=1:duration=2', ...args]);
  ff(['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(dune, 'Dune (2021) - 1080p.mp4')]);
  ff(['-vf', 'scale=3840:2160', '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le',
    '-x265-params', 'log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc', path.join(dune, 'Dune (2021) - 4K HDR.mkv')]);
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1',
    AUTO_LIBRARIES: `Movies:movie:${path.join(ROOT, 'Movies')}` });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  await until(async () => (await admin('GET', '/api/libraries')).data.every((l) => l.scannedAt));
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const movies = async () => {
  const lib = (await admin('GET', '/api/libraries')).data.find((l) => l.name === 'Movies');
  return (await admin('GET', `/api/libraries/${lib.id}/items`)).data.items;
};

test('a disc ripped with MakeMKV is one film with its extras', async () => {
  const list = await movies();
  assert.ok(list.some((m) => m.title === 'Men In Black'));
  assert.equal(list.filter((m) => /Men In Black/.test(m.title)).length, 1, 'one film, named after the disc');
  const film = (await admin('GET', `/api/items/${list.find((m) => m.title === 'Men In Black').id}`)).data;
  assert.equal(film.year, 1997);
  assert.ok(film.duration > 15, 'the longest title is the film');
  assert.deepEqual(film.extras.map((e) => [e.title, e.extraLabel]), [['Disc extra 1', 'Extra'], ['Disc extra 2', 'Extra']]);
});

test('two copies of a film are one title with two versions', async () => {
  const dunes = (await movies()).filter((m) => m.title === 'Dune');
  assert.equal(dunes.length, 1, 'listed once');
  const film = (await admin('GET', `/api/items/${dunes[0].id}`)).data;
  assert.equal(film.versionOf, null);
  const byLabel = Object.fromEntries(film.versions.map((v) => [v.label, v]));
  assert.deepEqual(Object.keys(byLabel).sort(), ['1080p', '4K HDR'], 'labelled from "- 1080p" / "- 4K HDR" in the names');
  assert.equal(byLabel['4K HDR'].hdr, 'HDR10');
  assert.equal(byLabel['4K HDR'].height, 2160);
  assert.equal(byLabel['4K HDR'].videoCodec, 'hevc');
  assert.equal(byLabel['1080p'].directPlay, true, 'browsers play the 1080p MP4 as it is');
  assert.equal(byLabel['4K HDR'].directPlay, false);

  // Watching or listing either copy counts for the film.
  const other = film.versions.find((v) => v.id !== film.id);
  assert.equal((await admin('GET', `/api/items/${other.id}`)).data.versionOf, film.id);
  await admin('POST', `/api/items/${other.id}/progress`, { position: 1 });
  assert.equal((await admin('GET', `/api/items/${film.id}`)).data.progress.position, 1, 'progress from the other version');
  await admin('PUT', `/api/watchlist/${other.id}`);
  assert.deepEqual((await admin('GET', '/api/watchlist')).data.map((x) => x.id), [film.id]);
  assert.equal((await admin('GET', '/api/search?q=Dune')).data.movies.length, 1);
  assert.deepEqual((await admin('GET', '/api/problems')).data.duplicates, [], 'not a problem');
});
