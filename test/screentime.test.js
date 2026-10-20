'use strict';
// Kids' screen time: bedtime (every night or school nights only) and a daily limit, enforced by the
// server for every device: nothing starts, streams are refused, and players are told to stop.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clip, startServer, until } = require('./helpers');
const st = require('../lib/screentime');

const at = (day, time) => new Date(`2026-10-${String(day).padStart(2, '0')}T${time}:00`); // 18 = Sunday … 24 = Saturday

test('bedtime across midnight, every night or school nights', () => {
  const b = { start: '20:30', end: '07:00' };
  assert.equal(st.inBedtime(b, at(20, '20:29')), null);
  assert.deepEqual(st.inBedtime(b, at(20, '20:30')), { until: '07:00' });
  assert.ok(st.inBedtime(b, at(21, '06:59')));
  assert.equal(st.inBedtime(b, at(21, '07:00')), null);
  const school = { ...b, schoolNights: true };
  assert.ok(st.inBedtime(school, at(18, '21:00')), 'Sunday night');
  assert.ok(st.inBedtime(school, at(22, '21:00')), 'Thursday night');
  assert.ok(st.inBedtime(school, at(23, '06:00')), 'Friday morning: still Thursday night');
  assert.equal(st.inBedtime(school, at(23, '21:00')), null, 'Friday night');
  assert.equal(st.inBedtime(school, at(25, '06:00')), null, 'Sunday morning (Saturday night)');
  assert.ok(st.inBedtime({ start: '13:00', end: '15:00' }, at(24, '14:00')), 'a daytime window');
  assert.equal(st.inBedtime({ start: '13:00', end: '15:00', schoolNights: true }, at(24, '14:00')), null, 'not on Saturday');
});

test('the daily limit counts playing time between reports, from midnight', () => {
  const store = { data: {} };
  const kid = { id: 'k', role: 'user', dailyMinutes: 30 };
  let t = at(20, '16:00').getTime();
  for (let i = 0; i < 6 * 29; i++) { st.tick(store, kid, new Date(t)); t += 10_000; } // 29 minutes of reports
  assert.equal(st.blocked(store, kid, new Date(t)), null);
  st.tick(store, kid, new Date(t + 2 * 3600_000)); // a long gap isn't counted
  assert.equal(st.summary(store, kid, new Date(t + 2 * 3600_000)).minutesLeft, 2); // (28.8 minutes counted)
  t += 2 * 3600_000;
  for (let i = 0; i < 9; i++) { t += 10_000; st.tick(store, kid, new Date(t)); }
  assert.equal(st.blocked(store, kid, new Date(t)).reason, 'limit');
  assert.match(st.blocked(store, kid, new Date(t)).message, /today’s 30 minutes/);
  assert.equal(st.blocked(store, kid, at(21, '09:00')), null, 'a new day');
  assert.equal(st.blocked(store, { ...kid, role: 'admin' }, new Date(t)), null, 'not for admins');
  assert.throws(() => st.clean({ dailyMinutes: 5 }), /10 to 1440/);
  assert.throws(() => st.clean({ bedtime: { start: '8pm', end: '07:00' } }), /look like/);
});

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-screentime-'));
let srv, admin, kid, kidId, film;
test.before(async () => {
  clip(path.join(ROOT, 'Movies', 'Film (2020).mp4'), 3);
  srv = await startServer({ DATA_DIR: path.join(ROOT, 'data'), TVMAZE_DISABLED: '1', AUTO_LIBRARIES: `Movies:movie:${path.join(ROOT, 'Movies')}` });
  admin = srv.client();
  await admin('POST', '/api/auth/setup', { username: 'dad', password: 'password1' });
  await until(async () => (await admin('GET', '/api/libraries')).data.every((l) => l.scannedAt));
  film = (await admin('GET', '/api/search?q=Film')).data.movies[0];
  kidId = (await admin('POST', '/api/users', { username: 'kid', password: 'password2' })).data.id;
  kid = srv.client();
  await kid('POST', '/api/auth/login', { username: 'kid', password: 'password2' });
});
test.after(async () => { await srv?.stop(); fs.rmSync(ROOT, { recursive: true, force: true }); });

test('at bedtime nothing plays, and a player is told to stop', async () => {
  const now = new Date();
  const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const bedtime = { start: hm(new Date(now - 3600_000)), end: hm(new Date(now.getTime() + 3600_000)) };
  const r = await admin('PATCH', `/api/users/${kidId}`, { bedtime, dailyMinutes: 60 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.bedtime.start, r.data.dailyMinutes], [bedtime.start, 60]);

  const item = (await kid('GET', `/api/items/${film.id}`)).data;
  assert.equal(item.watchBlock.reason, 'bedtime');
  assert.match(item.watchBlock.message, /It’s bedtime/);
  const pb = await kid('GET', `/api/items/${film.id}/playback`);
  assert.equal(pb.status, 403);
  assert.match(pb.data.error, /bedtime/);
  assert.equal((await kid('GET', `/api/items/${film.id}/stream`)).status, 403);
  assert.equal((await kid('GET', `/api/items/${film.id}/hls/master.m3u8`)).status, 403);
  const p = (await kid('POST', `/api/items/${film.id}/progress`, { position: 1 })).data;
  assert.equal(p.stop.reason, 'bedtime');
  assert.equal((await kid('GET', '/api/screen-time')).data.blocked.reason, 'bedtime');
  assert.equal((await admin('GET', `/api/items/${film.id}`)).data.watchBlock, null, 'grown-ups are fine');

  await admin('PATCH', `/api/users/${kidId}`, { bedtime: null, dailyMinutes: null });
  assert.equal((await kid('GET', `/api/items/${film.id}/playback`)).status, 200, 'switched off again');
  assert.equal((await kid('PATCH', `/api/users/${kidId}`, { bedtime: null })).status, 403, 'only admins set it');
});
