'use strict';
// Watch together: party state is shared with every member over Server-Sent Events.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-party-'));
let srv, admin, bob, kid, libs, film, other;

// Reads a member's event stream; `events` collects every message.
function listen(base, cookie, partyId, client) {
  const events = [];
  const ctrl = new AbortController();
  const done = (async () => {
    const res = await fetch(`${base}/api/parties/${partyId}/events?client=${client}`, { headers: { cookie }, signal: ctrl.signal });
    events.status = res.status;
    if (!res.ok) return;
    let buf = '';
    const dec = new TextDecoder();
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
        }
      }
    } catch { /* aborted */ }
  })();
  return { events, close: () => ctrl.abort(), done };
}
const cookies = {};
async function login(client, name, pass) {
  const r = await fetch(`${srv.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password: pass }) });
  cookies[name] = r.headers.get('set-cookie').split(';')[0];
  await client('POST', '/api/auth/login', { username: name, password: pass });
}

test.before(async () => {
  clip(path.join(ROOT, 'Movies', 'Film (2020).mp4'));
  clip(path.join(ROOT, 'Movies', 'Other (2021).mp4'));
  clip(path.join(ROOT, 'Kids', 'Cartoon (2015).mp4'));
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1',
    AUTO_LIBRARIES: `Movies:movie:${path.join(ROOT, 'Movies')};Kids:movie:${path.join(ROOT, 'Kids')}` });
  admin = srv.client(); bob = srv.client(); kid = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'admin', password: 'password1' });
  await until(async () => (await admin('GET', '/api/libraries')).data.every((l) => l.scannedAt));
  libs = Object.fromEntries((await admin('GET', '/api/libraries')).data.map((l) => [l.name, l.id]));
  const items = (await admin('GET', `/api/libraries/${libs.Movies}/items`)).data.items;
  film = items.find((i) => i.title === 'Film');
  other = items.find((i) => i.title === 'Other');
  await admin('POST', '/api/users', { username: 'bob', password: 'bobpass12' });
  await admin('POST', '/api/users', { username: 'kid', password: 'kidpass12', libraries: [libs.Kids] });
  await login(admin, 'admin', 'password1');
  await login(bob, 'bob', 'bobpass12');
  await login(kid, 'kid', 'kidpass12');
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('members share play, pause, seek and the next video', async () => {
  const created = (await admin('POST', '/api/parties', { itemId: film.id, position: 12 })).data;
  assert.match(created.id, /^[A-Z2-9]{12}$/);
  assert.equal(created.position, 12);
  assert.equal(created.playing, false);

  const a = listen(srv.base, cookies.admin, created.id, 'admin-tab-1');
  await until(() => a.events.length >= 1);
  const b = listen(srv.base, cookies.bob, created.id.toLowerCase(), 'bob-phone-1'); // codes work in any case
  await until(() => a.events.at(-1)?.members.length === 2);
  assert.deepEqual(a.events.at(-1).members.sort(), ['admin', 'bob']);
  assert.equal(b.events.at(-1).itemId, film.id);

  // Bob presses play at 30 s: everyone hears about it, stamped with the server's clock.
  const before = Date.now();
  await bob('POST', `/api/parties/${created.id}/state`, { clientId: 'bob-phone-1', itemId: film.id, playing: true, position: 30 });
  await until(() => a.events.at(-1)?.position === 30);
  const s = a.events.at(-1);
  assert.equal(s.playing, true);
  assert.equal(s.from, 'bob-phone-1');
  assert.ok(s.updatedAt >= before - 5 && s.updatedAt <= Date.now());

  // Moving to another video takes everyone along.
  await admin('POST', `/api/parties/${created.id}/state`, { clientId: 'admin-tab-1', itemId: other.id, playing: true, position: 0 });
  await until(() => b.events.at(-1)?.itemId === other.id);

  assert.equal((await bob('POST', `/api/parties/${created.id}/state`, { position: -5 })).status, 400);
  b.close();
  await until(() => a.events.at(-1)?.members.length === 1);
  a.close();
});

test('only people who can see the video can join', async () => {
  const p = (await admin('POST', '/api/parties', { itemId: film.id })).data;
  assert.equal((await kid('GET', `/api/parties/${p.id}`)).status, 404, 'kid has no access to Movies');
  const k = listen(srv.base, cookies.kid, p.id, 'kid-tablet-1');
  await k.done;
  assert.equal(k.events.status, 404);
  assert.equal((await kid('POST', '/api/parties', { itemId: film.id })).status, 404);
  assert.equal((await bob('GET', '/api/parties/NOPE42')).status, 404);
  const bad = listen(srv.base, cookies.bob, p.id, 'x');
  await bad.done;
  assert.equal(bad.events.status, 400, 'client id required');
  assert.equal((await fetch(`${srv.base}/api/parties/${p.id}`)).status, 401);
});
