'use strict';
// A player still opening a title (on its way to the resume point) reports position 0; closing it
// then mustn't wipe where the viewer had got to. Every app did this; older ones still do.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-resume-'));
let srv, admin, film;

test.before(async () => {
  clip(path.join(ROOT, 'Films', 'Long Film (2001).mp4'), 60);
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1', AUTO_LIBRARIES: `Films:movie:${path.join(ROOT, 'Films')}` });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'mum', password: 'password1' });
  const lib = await until(async () => (await admin('GET', '/api/libraries')).data.find((l) => l.count === 1));
  film = (await admin('GET', `/api/libraries/${lib.id}/items`)).data.items[0];
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

const position = async () => (await admin('GET', `/api/items/${film.id}`)).data.progress?.position;

test('leaving a title before it starts keeps the resume point', async () => {
  await admin('POST', `/api/items/${film.id}/progress`, { position: 40, paused: true });
  assert.equal(await position(), 40);
  for (const body of [{ position: 0, paused: true }, { position: 0, stopped: true }, { position: 0.2 }]) {
    assert.equal((await admin('POST', `/api/items/${film.id}/progress`, body)).status, 200);
    assert.equal(await position(), 40, JSON.stringify(body));
  }
});

test('starting over and watching a little still moves it back', async () => {
  await admin('POST', `/api/items/${film.id}/progress`, { position: 3, stopped: true });
  assert.equal(await position(), 3);
});
