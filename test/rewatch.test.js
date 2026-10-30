'use strict';
// Watching again, specials, new episodes and "Undo": a finished show can be started again and
// carries on in order; a special doesn't move your place; a show you'd caught up with comes back
// to the front of Continue Watching when a new episode arrives (even if you'd removed it); and a
// whole show marked watched by mistake can be put back.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-rewatch-'));
const TV = path.join(ROOT, 'TV');
const epFile = (s, e) => path.join(TV, 'Bluey', `Season ${s}`, `Bluey - S0${s}E0${e}.mp4`);
let srv, me, lib, show, eps;

test.before(async () => {
  for (const [s, e] of [[0, 1], [1, 1], [1, 2], [1, 3]]) clip(epFile(s, e), 60);
  clip(path.join(TV, 'Other Show', 'Season 1', 'Other Show - S01E01.mp4'), 60);
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1', AUTO_LIBRARIES: `TV:show:${TV}` });
  me = srv.client();
  await me('POST', '/api/auth/setup', { username: 'mum', password: 'password1' });
  lib = await until(async () => (await me('GET', '/api/libraries')).data.find((l) => l.scannedAt));
  show = await until(async () => (await me('GET', '/api/search?q=Bluey')).data.shows[0]);
  const d = await until(async () => { const x = (await me('GET', `/api/shows/${show.id}`)).data; return x.episodeCount === 4 && x; });
  eps = Object.fromEntries(d.seasons.flatMap((s) => s.episodes).map((e) => [`${e.season}x${e.episode}`, e.id]));
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const watch = (id, position) => me('POST', `/api/items/${id}/progress`, { position, stopped: true });
const upNext = async () => (await me('GET', `/api/shows/${show.id}?episodes=none`)).data.upNext;
const continueRow = async () => ((await me('GET', '/api/home')).data.hubs.find((h) => h.key === 'continue')?.items || []).map((x) => x.id);

test('a special doesn’t move your place in the show', async () => {
  await watch(eps['1x1'], 60);
  assert.equal((await upNext()).id, eps['1x2']);
  await watch(eps['0x1'], 60); // the show's film, in Season 0
  assert.equal((await upNext()).id, eps['1x2'], 'still the next episode, not the next special');
  await watch(eps['0x1'], 30); // part-way through it again: that's what to carry on with
  assert.equal((await upNext()).id, eps['0x1']);
  await watch(eps['0x1'], 60);
});

test('a finished show offers to start again, and a rewatch carries on in order', async () => {
  for (const e of ['1x2', '1x3']) await watch(eps[e], 60);
  assert.ok(!(await continueRow()).includes(eps['1x1']), 'nothing left to watch: not in Continue Watching');
  const again = await upNext();
  assert.equal(again.id, eps['1x1']);
  assert.equal(again.again, true, '“Watch again from the start”');
  await watch(eps['1x1'], 30);
  const part = (await me('GET', `/api/items/${eps['1x1']}`)).data.progress;
  assert.equal(part.watched, false, 'part-way through a rewatch: every app offers to resume it');
  assert.equal(part.position, 30);
  assert.equal((await continueRow())[0], eps['1x1']);
  await watch(eps['1x1'], 60);
  assert.equal((await upNext()).id, eps['1x2'], 'the very next one, though it was watched before');
  assert.equal((await continueRow())[0], eps['1x2']);
});

test('a new episode of a show you’d caught up with comes back to the front, even if you’d removed it', async () => {
  for (const e of ['1x2', '1x3']) await watch(eps[e], 60);
  const other = (await me('GET', '/api/search?q=Other Show')).data.shows[0];
  const otherEp = (await me('GET', `/api/shows/${other.id}`)).data.seasons[0].episodes[0];
  await me('POST', `/api/continue/${show.id}/hide`);
  await new Promise((r) => setTimeout(r, 20));
  await watch(otherEp.id, 20); // watched something else since
  clip(epFile(1, 4), 60);
  const old = Date.now() / 1000 - 3600; // (settled: not still being copied)
  fs.utimesSync(epFile(1, 4), old, old);
  await me('POST', `/api/libraries/${lib.id}/scan`);
  await until(async () => (await upNext())?.episode === 4);
  assert.equal((await continueRow())[0], (await upNext()).id, 'the new episode is first, ahead of what was watched since');
});

test('marking a whole show watched can be undone', async () => {
  const before = (await me('GET', `/api/shows/${show.id}`)).data;
  const was = Object.fromEntries(before.seasons.flatMap((s) => s.episodes).map((e) => [e.id, !!e.progress?.watched]));
  const r = await me('POST', `/api/shows/${show.id}/watched`, { watched: false });
  assert.ok(r.data.undo);
  assert.equal(r.data.unwatchedCount, 5);
  assert.equal((await me('POST', '/api/watched/undo', { undo: r.data.undo })).status, 200);
  const after = (await me('GET', `/api/shows/${show.id}`)).data;
  assert.deepEqual(Object.fromEntries(after.seasons.flatMap((s) => s.episodes).map((e) => [e.id, !!e.progress?.watched])), was, 'as it was');
  assert.equal((await me('POST', '/api/watched/undo', { undo: r.data.undo })).status, 410, 'once only');
  const r2 = await me('POST', `/api/shows/${show.id}/watched`, { watched: true });
  const stranger = srv.client();
  assert.equal((await stranger('POST', '/api/watched/undo', { undo: r2.data.undo })).status, 401, 'signed in only');
});
