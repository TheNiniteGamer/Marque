'use strict';
// Requests ("can we get …?") and notifications: new episodes for the people who watch a show, and
// requests that have arrived.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-requests-'));
let srv, admin, ann, bob, movies, tv;
const scanned = async (lib) => {
  const before = (await admin('GET', '/api/libraries')).data.find((l) => l.id === lib).scannedAt;
  await admin('POST', `/api/libraries/${lib}/scan`);
  await until(async () => (await admin('GET', '/api/libraries')).data.find((l) => l.id === lib).scannedAt > before && !(await admin('GET', '/api/status')).data.scanning);
};
test.before(async () => {
  clip(path.join(ROOT, 'Movies', 'Alien (1979)', 'Alien (1979).mp4'));
  clip(path.join(ROOT, 'TV', 'Bluey', 'Season 1', 'Bluey - S01E01.mp4'));
  clip(path.join(ROOT, 'TV', 'Bluey', 'Season 1', 'Bluey - S01E02.mp4'));
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1', AUTO_LIBRARIES: `Movies:movie:${path.join(ROOT, 'Movies')};TV:show:${path.join(ROOT, 'TV')}` });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  await until(async () => (await admin('GET', '/api/libraries')).data.every((l) => l.scannedAt));
  const libs = (await admin('GET', '/api/libraries')).data;
  movies = libs.find((l) => l.type === 'movie').id;
  tv = libs.find((l) => l.type === 'show').id;
  for (const name of ['ann', 'bob']) await admin('POST', '/api/users', { username: name, password: 'password1' });
  ann = srv.client(); bob = srv.client();
  await ann('POST', '/api/auth/login', { username: 'ann', password: 'password1' });
  await bob('POST', '/api/auth/login', { username: 'bob', password: 'password1' });
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('asking for a film: one request however many ask, the admin decides, everyone is told', async () => {
  assert.equal((await ann('POST', '/api/requests', { kind: 'movie', title: 'Alien', year: 1979 })).status, 409, 'already here');
  assert.equal((await ann('POST', '/api/requests', { kind: 'movie', title: '' })).status, 400);
  const r = (await ann('POST', '/api/requests', { kind: 'movie', title: 'Heat', year: 1995, note: 'the Pacino one' })).data;
  assert.equal(r.status, 'pending');
  assert.equal((await bob('POST', '/api/requests', { kind: 'movie', title: 'heat', year: 1995 })).data.id, r.id, 'Bob joins Ann’s request');
  // The admin hears about it, and sees who asked.
  const list = (await admin('GET', '/api/requests')).data;
  assert.equal(list.pending, 1);
  assert.equal(list.requests[0].requestedBy, 'ann');
  assert.deepEqual(list.requests[0].alsoWanted, ['bob']);
  assert.match((await admin('GET', '/api/notifications')).data.items[0].title, /ann asked for Heat \(1995\)/);
  assert.equal((await admin('GET', '/api/status')).data.requestsPending, 1);
  // Others see only their own; only admins decide.
  assert.equal((await bob('GET', '/api/requests')).data.requests.length, 1);
  assert.equal((await bob('PATCH', `/api/requests/${r.id}`, { status: 'approved' })).status, 403);
  await admin('PATCH', `/api/requests/${r.id}`, { status: 'approved', adminNote: 'This weekend' });
  for (const c of [ann, bob]) {
    const n = (await c('GET', '/api/notifications')).data;
    assert.equal(n.unread, 1);
    assert.equal(n.items[0].title, 'Heat is on its way');
    assert.equal(n.items[0].body, 'This weekend');
  }
  // It arrives: marked as here, and both are told where to watch it.
  clip(path.join(ROOT, 'Movies', 'Heat (1995)', 'Heat (1995).mp4'));
  await scanned(movies);
  await until(async () => (await ann('GET', '/api/requests')).data.requests[0].status === 'available');
  const here = (await ann('GET', '/api/notifications')).data.items[0];
  assert.equal(here.title, 'Heat is here');
  assert.match(here.link, /^#\/item\//);
  // Read and cleared.
  assert.equal((await ann('POST', '/api/notifications/read', {})).data.unread, 0);
  await ann('DELETE', '/api/notifications');
  assert.equal((await ann('GET', '/api/notifications')).data.items.length, 0);
});

test('withdrawing: the asker can until it’s been dealt with', async () => {
  const r = (await bob('POST', '/api/requests', { kind: 'show', title: 'Severance' })).data;
  assert.equal((await ann('DELETE', `/api/requests/${r.id}`)).status, 404, 'not Ann’s');
  assert.equal((await bob('DELETE', `/api/requests/${r.id}`)).status, 200);
  assert.ok(!(await admin('GET', '/api/requests')).data.requests.some((x) => x.id === r.id));
});

test('new episodes are told to the people watching that show, once', async () => {
  const show = (await admin('GET', `/api/libraries/${tv}/items`)).data.items[0];
  const eps = (await admin('GET', `/api/shows/${show.id}`)).data.seasons[0].episodes;
  await ann('POST', `/api/items/${eps[0].id}/progress`, { position: 30 });
  for (const c of [ann, bob]) await c('DELETE', '/api/notifications');
  clip(path.join(ROOT, 'TV', 'Bluey', 'Season 1', 'Bluey - S01E03.mp4'));
  clip(path.join(ROOT, 'TV', 'Bluey', 'Season 1', 'Bluey - S01E04.mp4'));
  await scanned(tv);
  const n = (await ann('GET', '/api/notifications')).data.items;
  assert.equal(n.length, 1);
  assert.equal(n[0].title, '2 new episodes of Bluey');
  assert.match(n[0].body, /^From S1:E3/);
  assert.equal((await bob('GET', '/api/notifications')).data.items.length, 0, 'Bob doesn’t watch it');
  await scanned(tv);
  assert.equal((await ann('GET', '/api/notifications')).data.items.length, 1, 'not again on the next scan');
});
