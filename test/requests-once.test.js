'use strict';
// Requests acted on twice at once, or shared: approving one twice (two admins, a double click)
// sends it to Radarr / Sonarr once, and one person withdrawing a request others asked for too
// takes away only their part.

const test = require('node:test');
const assert = require('node:assert/strict');
const requests = require('../lib/requests');

const ann = { id: 'ann', username: 'ann', role: 'user' };
const bob = { id: 'bob', username: 'bob', role: 'user' };
const dad = { id: 'dad', username: 'dad', role: 'admin' };
const storeWith = (...reqs) => ({ data: { users: [ann, bob, dad], items: {}, shows: {}, requests: Object.fromEntries(reqs.map((r) => [r.id, r])) }, save() {} });
const request = (id, userIds, status = 'pending') => ({ id, kind: 'movie', title: 'Heat', year: 1995, provider: 'tmdb', providerId: '949', userIds, status, createdAt: 1, updatedAt: 1 });

// Radarr, slow to answer (as it is when it looks the film up first).
function slowArr() {
  const arr = { adds: 0 };
  arr.add = async () => {
    arr.adds++;
    await new Promise((r) => setTimeout(r, 50));
    return { app: 'radarr', id: 11, title: 'Heat', profile: 'HD-1080p', sentAt: Date.now() };
  };
  return arr;
}

test('approving the same request twice at once sends it once', async () => {
  const store = storeWith(request('r1', ['ann']));
  const arr = slowArr();
  const [a, b] = await Promise.all([requests.send(store, arr, 'r1', { profileId: 4 }), requests.send(store, arr, 'r1', { profileId: 4 })]);
  assert.equal(arr.adds, 1);
  assert.deepEqual(a, b);
  assert.equal(store.data.requests.r1.status, 'approved');
  assert.equal(store.data.notifications.ann.filter((n) => /on its way/.test(n.title)).length, 1, 'told once');
  // A moment later (the second admin's page was out of date): approved already, not sent again.
  await requests.send(store, arr, 'r1', {});
  assert.equal(arr.adds, 1);
});

test('one that couldn’t be sent can be tried again', async () => {
  const store = storeWith(request('r2', ['ann']));
  const arr = slowArr();
  const add = arr.add;
  arr.add = async () => { arr.adds++; throw new Error('Radarr is down'); };
  await assert.rejects(requests.send(store, arr, 'r2', {}), /down/);
  assert.equal(store.data.requests.r2.status, 'pending');
  arr.add = add;
  await requests.send(store, arr, 'r2', {});
  assert.equal(arr.adds, 2);
  assert.equal(store.data.requests.r2.status, 'approved');
});

test('withdrawing a request others asked for too leaves it for them', () => {
  const store = storeWith(request('r3', ['ann', 'bob']));
  requests.remove(store, ann, 'r3');
  assert.deepEqual(store.data.requests.r3.userIds, ['bob'], 'Bob still wants it (and now counts as asking)');
  assert.equal(store.data.requests.r3.status, 'pending');
  assert.equal(requests.list(store, ann).length, 0, 'gone from Ann’s list');
  assert.throws(() => requests.remove(store, ann, 'r3'), /not found/);
  requests.remove(store, bob, 'r3');
  assert.equal(store.data.requests.r3, undefined, 'gone once nobody wants it');
  // Admins can still remove one outright.
  const both = storeWith(request('r4', ['ann', 'bob']));
  requests.remove(both, dad, 'r4');
  assert.equal(both.data.requests.r4, undefined);
});
