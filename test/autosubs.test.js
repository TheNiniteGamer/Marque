'use strict';
// Automatic subtitles (OpenSubtitles mocked): titles without subtitles in the family's languages
// get them by themselves, the one made for the same file first; titles that have them are left
// alone; it stops for the day when the allowance runs out.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');
const { sameLang } = require('../lib/autosubs');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-autosubs-'));
const SRT = '1\n00:00:01,000 --> 00:00:02,000\nHola\n';
const searches = [];
let downloadsLeft = 3;
const mock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/file.srt') { res.writeHead(200); return res.end(SRT); }
  if (url.pathname === '/api/v1/infos/formats') return send(200, { data: {} });
  if (url.pathname === '/api/v1/subtitles') {
    searches.push(Object.fromEntries(url.searchParams));
    const lang = url.searchParams.get('languages');
    return send(200, { data: url.searchParams.get('query') === 'nothing' ? [] : [
      { attributes: { language: lang, release: 'Machine.Made', download_count: 9999, machine_translated: true, files: [{ file_id: 1 }] } },
      { attributes: { language: lang, release: 'Popular.Release', download_count: 900, files: [{ file_id: 11 }] } },
      { attributes: { language: lang, release: 'Same.File', download_count: 5, moviehash_match: true, files: [{ file_id: 22 }] } },
    ] });
  }
  if (url.pathname === '/api/v1/download') return send(200, { link: `http://127.0.0.1:${mock.address().port}/file.srt`, remaining: --downloadsLeft });
  send(404, {});
});

let srv, admin;
test.before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  clip(path.join(ROOT, 'Movies', 'Film (2020).mp4'), 30);
  clip(path.join(ROOT, 'Movies', 'Second (2021).mp4'), 30);
  clip(path.join(ROOT, 'Movies', 'Nothing (2022).mp4'), 30);
  fs.writeFileSync(path.join(ROOT, 'Movies', 'Second (2021).es.srt'), SRT); // has Spanish already
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1', OPENSUBTITLES_API_BASE: `http://127.0.0.1:${mock.address().port}/api/v1`,
    AUTO_LIBRARIES: `Movies:movie:${path.join(ROOT, 'Movies')}` });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'dad', password: 'password1' });
  await until(async () => (await admin('GET', '/api/libraries')).data.every((l) => l.scannedAt));
  await admin('PATCH', '/api/settings', { opensubtitles: { apiKey: 'good-key' } });
});
test.after(async () => { await srv?.stop(); mock.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const movie = async (title) => (await admin('GET', `/api/search?q=${title}`)).data.movies.find((m) => m.title === title);

test('language codes match whichever way they’re written', () => {
  assert.ok(sameLang('spa', 'es') && sameLang('es-MX', 'es') && sameLang('eng', 'en'));
  assert.ok(!sameLang('en', 'es') && !sameLang(null, 'es'));
});

test('the languages are the family’s picks unless set here', async () => {
  let a = (await admin('GET', '/api/autosubs')).data;
  assert.deepEqual(a.languages, [], 'nobody has picked one yet');
  await admin('PUT', '/api/auth/prefs', { subLang: 'es' });
  a = (await admin('GET', '/api/autosubs')).data;
  assert.deepEqual([a.languages, a.settings.enabled, a.configured], [['es'], false, true]);
  assert.equal((await admin('PATCH', '/api/autosubs', { languages: 'spanish' })).status, 400);
  assert.deepEqual((await admin('PATCH', '/api/autosubs', { languages: ' FR, es ' })).data.languages, ['fr', 'es']);
  assert.deepEqual((await admin('PATCH', '/api/autosubs', { languages: '' })).data.languages, ['es'], 'back to the family’s');
});

test('missing subtitles are fetched: the one for the same file first, never machine-translated', async () => {
  // "Nothing" finds no results (it's looked for again in a month).
  const nothing = await movie('Nothing');
  await admin('PATCH', `/api/meta/${nothing.id}`, { title: 'nothing' });
  let a = (await admin('PATCH', '/api/autosubs', { enabled: true })).data;
  assert.equal(a.missing, 2, 'Second has Spanish beside it already');
  a = (await admin('POST', '/api/autosubs/run')).data;
  assert.equal(a.got, 1);
  const film = (await admin('GET', `/api/items/${(await movie('Film')).id}`)).data;
  const sub = film.subtitles.find((s) => s.downloaded);
  assert.deepEqual([sub.lang, sub.release], ['es', 'Same.File']);
  assert.equal(searches.length, 2);
  assert.equal(searches.every((q) => q.languages === 'es'), true);
  a = (await admin('GET', '/api/autosubs')).data;
  assert.deepEqual([a.today, a.total, a.missing], [1, 1, 0], 'tried ones wait a month');
  const vtt = await fetch(`${srv.base}/api/items/${film.id}/subtitles/${sub.id}`, { headers: { cookie: '' } });
  assert.ok(vtt.status === 200 || vtt.status === 401);
});

test('it stops for the day when OpenSubtitles’ allowance is used up', async () => {
  await admin('PATCH', '/api/autosubs', { languages: 'fr,de,it' });
  const a = (await admin('POST', '/api/autosubs/run')).data;
  assert.equal(a.got, 2, 'two downloads left');
  assert.match(a.paused.why, /used up/);
  assert.equal((await admin('POST', '/api/autosubs/run')).data.got, 0, 'paused');
});
