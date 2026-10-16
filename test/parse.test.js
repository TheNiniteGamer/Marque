'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMovie, parseEpisode, findSidecarSubs, cleanName } = require('../lib/parse');

test('movie: title and year in parens', () => {
  assert.deepEqual(parseMovie('/m/The Matrix (1999).mkv'), { title: 'The Matrix', year: 1999 });
});

test('movie: dotted scene release name', () => {
  assert.deepEqual(parseMovie('/m/The.Grand.Budapest.Hotel.2014.1080p.BluRay.x264-GRP.mkv'),
    { title: 'The Grand Budapest Hotel', year: 2014 });
});

test('movie: numeric titles keep the real year', () => {
  assert.deepEqual(parseMovie('/m/1917 (2019).mp4'), { title: '1917', year: 2019 });
  assert.deepEqual(parseMovie('/m/Blade Runner 2049 (2017).mp4'), { title: 'Blade Runner 2049', year: 2017 });
  assert.deepEqual(parseMovie('/m/2001 A Space Odyssey (1968).mp4'), { title: '2001 A Space Odyssey', year: 1968 });
});

test('movie: year taken from parent folder', () => {
  assert.deepEqual(parseMovie('/m/Heat (1995)/heat.mkv'), { title: 'Heat', year: 1995 });
});

test('movie: no year at all', () => {
  assert.deepEqual(parseMovie('/m/Home Video [720p].mp4'), { title: 'Home Video', year: null });
});

test('episode: standard folder layout', () => {
  const e = parseEpisode('Breaking Bad/Season 01/Breaking Bad - S01E02 - Cat in the Bag.mkv');
  assert.equal(e.show, 'Breaking Bad');
  assert.equal(e.season, 1);
  assert.equal(e.episode, 2);
  assert.equal(e.title, 'Cat in the Bag');
});

test('episode: flat file with scene naming', () => {
  const e = parseEpisode('The.Office.US.S03E10.720p.WEB-DL.mkv');
  assert.equal(e.show, 'The Office US');
  assert.equal(e.season, 3);
  assert.equal(e.episode, 10);
  assert.equal(e.title, null);
});

test('episode: 1x02 format and multi-episode', () => {
  assert.deepEqual(
    [parseEpisode('Show/Show 2x05.mkv').season, parseEpisode('Show/Show 2x05.mkv').episode], [2, 5]);
  const multi = parseEpisode('Show/Season 1/Show S01E01-E02.mkv');
  assert.equal(multi.episode, 1);
  assert.equal(multi.episodeEnd, 2);
});

test('episode: season from folder, episode from name', () => {
  const e = parseEpisode('Planet Earth (2006)/Season 2/Episode 05.mkv');
  assert.equal(e.show, 'Planet Earth');
  assert.equal(e.showYear, 2006);
  assert.equal(e.season, 2);
  assert.equal(e.episode, 5);
});

test('episode: specials folder', () => {
  const e = parseEpisode('Doctor Who/Specials/Doctor Who - S00E01 - Christmas.mkv');
  assert.equal(e.season, 0);
  assert.equal(e.episode, 1);
});

test('sidecar subtitles with language tags', () => {
  const subs = findSidecarSubs('/m/Movie (2000).mkv',
    ['Movie (2000).mkv', 'Movie (2000).en.srt', 'Movie (2000).es.forced.srt', 'Other.srt']);
  assert.equal(subs.length, 2);
  assert.equal(subs[0].lang, 'en');
  assert.equal(subs[1].lang, 'es');
  assert.equal(subs[1].forced, true);
});

test('cleanName strips bracket tags and junk', () => {
  assert.equal(cleanName('[Group] Some_Show_Name 1080p HEVC'), 'Some Show Name');
});
