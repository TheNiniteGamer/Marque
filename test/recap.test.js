'use strict';
// Recaps: the start of an episode made of short clips from the episodes before it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { findRecap, ITEM_SEC } = require('../lib/intro');

let seed = 42;
const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
const noise = (n) => Uint32Array.from({ length: n }, rand);
const join = (...parts) => { const out = new Uint32Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

test('clips from the last episode at the start are found as a recap', () => {
  const previous = noise(20000); // ~41 minutes of "audio"
  const before = noise(15000);
  // 5 s of a new scene, then clips (5–7 s each) from both earlier episodes with a little narration between.
  const start = join(noise(40),
    previous.slice(3000, 3050), noise(8), previous.slice(9000, 9045), noise(8),
    before.slice(1200, 1260), noise(8), previous.slice(18000, 18055), noise(8), previous.slice(500, 548),
    noise(60)); // then the episode itself
  const r = findRecap(start, [previous, before]);
  assert.ok(r, 'recap found');
  assert.ok(Math.abs(r.start - 40 * ITEM_SEC) < 1, JSON.stringify(r));
  assert.ok(Math.abs(r.end - (start.length - 60) * ITEM_SEC) < 1, JSON.stringify(r));
});

test('a cold open (new scenes) is not a recap', () => {
  assert.equal(findRecap(noise(400), [noise(20000), noise(20000)]), null);
  // A single short shared sound isn't one either.
  const previous = noise(20000);
  assert.equal(findRecap(join(noise(200), previous.slice(100, 115), noise(200)), [previous]), null);
});
