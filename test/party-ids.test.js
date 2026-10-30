'use strict';
// Watch together: each player's client id is its own. Someone else in the party who learns it
// (every member is told which player made the last change) can't take that player's place or make
// changes that look like its own, and odd values aren't passed on to everyone.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Parties } = require('../lib/party');

const ann = { id: 'ann', username: 'ann' };
const bob = { id: 'bob', username: 'bob' };
// An event stream to a player: what it was sent, and whether it was ended.
const stream = () => Object.assign(new EventEmitter(), {
  sent: [], ended: false,
  writeHead() {}, write(s) { if (s.startsWith('data: ')) this.sent.push(JSON.parse(s.slice(6))); }, end() { this.ended = true; },
});

test('a player’s id stays its own', () => {
  const parties = new Parties();
  const p = parties.create(ann, 'film1');
  const annTab = stream();
  parties.join(p, ann, 'ann-tab-1', annTab);
  // Bob can't take Ann's player's place…
  assert.throws(() => parties.join(p, bob, 'ann-tab-1', stream()), (err) => err.status === 409);
  assert.equal(annTab.ended, false);
  assert.deepEqual(parties.view(p).members, ['ann']);
  // …not even once it has gone for a moment.
  annTab.emit('close');
  assert.throws(() => parties.join(p, bob, 'ann-tab-1', stream()), (err) => err.status === 409);
  const again = stream();
  parties.join(p, ann, 'ann-tab-1', again);
  assert.deepEqual(parties.view(p).members, ['ann'], 'Ann’s player came back');

  // Nor speak for it: his change is stamped as nobody's, so Ann's player doesn't ignore it.
  const bobPhone = stream();
  parties.join(p, bob, 'bob-phone-1', bobPhone);
  parties.update(p, bob, { clientId: 'ann-tab-1', playing: true, position: 30 });
  assert.equal(again.sent.at(-1).from, null);
  parties.update(p, bob, { clientId: 'bob-phone-1', playing: true, position: 31 });
  assert.equal(again.sent.at(-1).from, 'bob-phone-1');
  // Odd values go no further.
  parties.update(p, bob, { clientId: { x: 1 }, itemId: ['film2'], playing: 'yes', position: '40' });
  assert.deepEqual([p.from, p.itemId, p.playing, p.position], [null, 'film2', true, 40]);
  for (const bad of ['', 'x', 'a'.repeat(41), 'has spaces!', '<b>hi</b>']) {
    assert.throws(() => parties.join(p, bob, bad, stream()), (err) => err.status === 400, bad);
  }
  parties.closeAll();
});
