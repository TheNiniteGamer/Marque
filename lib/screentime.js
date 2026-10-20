'use strict';
// Kids' screen time, set by an admin for each profile: a bedtime (nothing starts in it, and what's
// playing stops when it begins), on every night or only on school nights, and a daily limit in
// minutes. Enforced by the server, so it holds on every TV, phone and browser.
//
// user.bedtime = { start: "20:30", end: "07:00", schoolNights: false } | null
// user.dailyMinutes = 90 | null
// store.data.screenTime[userId] = { day: "2026-10-20", seconds, last } (time spent playing today,
// from the players' progress reports every ~10 s).

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const GAP_MS = 90_000; // a longer gap between reports isn't counted as watching

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const fmt = (t) => { const h = Number(t.slice(0, 2)); return `${h % 12 || 12}:${t.slice(3)} ${h < 12 ? 'am' : 'pm'}`; };

/** Checks and tidies { bedtime, dailyMinutes } from an admin (each may be null to switch it off). */
function clean(input) {
  const out = {};
  if (input.bedtime !== undefined) {
    const b = input.bedtime;
    if (!b) out.bedtime = null;
    else {
      if (!TIME_RE.test(b.start || '') || !TIME_RE.test(b.end || '')) throw Object.assign(new Error('Bedtime times look like 20:30'), { status: 400 });
      if (b.start === b.end) throw Object.assign(new Error('Bedtime needs different start and end times'), { status: 400 });
      out.bedtime = { start: b.start, end: b.end, schoolNights: !!b.schoolNights };
    }
  }
  if (input.dailyMinutes !== undefined) {
    const n = input.dailyMinutes === null || input.dailyMinutes === '' ? null : Number(input.dailyMinutes);
    if (n !== null && !(Number.isInteger(n) && n >= 10 && n <= 1440)) throw Object.assign(new Error('The daily limit is 10 to 1440 minutes'), { status: 400 });
    out.dailyMinutes = n;
  }
  return out;
}

/**
 * Inside bedtime at `now`? Returns { until: "07:00" } or null. A bedtime across midnight belongs to
 * the evening it starts on; "school nights" are Sunday to Thursday evenings.
 */
function inBedtime(b, now) {
  if (!b) return null;
  const t = toMin(hhmm(now)), s = toMin(b.start), e = toMin(b.end);
  let evening; // the date the night started on
  if (s < e) { if (t < s || t >= e) return null; evening = now; }
  else if (t >= s) evening = now;
  else if (t < e) evening = new Date(now.getTime() - 86400_000);
  else return null;
  if (b.schoolNights) {
    // Sunday to Thursday nights (a window that doesn't cross midnight: Monday to Friday).
    const d = evening.getDay();
    if (!(s < e ? d >= 1 && d <= 5 : d <= 4)) return null;
  }
  return { until: b.end };
}

function record(store, user, now) {
  const all = (store.data.screenTime ||= {});
  let r = all[user.id];
  if (!r || r.day !== dayKey(now)) r = all[user.id] = { day: dayKey(now), seconds: 0, last: 0 };
  return r;
}

/** Counts playing time (call on each progress report while not paused). */
function tick(store, user, now = new Date()) {
  if (!user || user.role === 'admin' || !user.dailyMinutes) return;
  const r = record(store, user, now);
  const gap = now.getTime() - (r.last || 0);
  if (r.last && gap > 0 && gap <= GAP_MS) r.seconds += gap / 1000;
  r.last = now.getTime();
}

/** Why this person can't watch right now ({ reason, message, until }), or null. */
function blocked(store, user, now = new Date()) {
  if (!user || user.role === 'admin') return null;
  const bed = inBedtime(user.bedtime, now);
  if (bed) return { reason: 'bedtime', message: `It’s bedtime. Marquee is back at ${fmt(bed.until)}.`, until: bed.until };
  if (user.dailyMinutes) {
    const r = store.data.screenTime?.[user.id];
    const used = r?.day === dayKey(now) ? r.seconds : 0;
    if (used >= user.dailyMinutes * 60) return { reason: 'limit', message: `That’s today’s ${label(user.dailyMinutes)} of watching. More tomorrow!`, until: '00:00' };
  }
  return null;
}

/** For the Account page and admins: { bedtime, dailyMinutes, minutesToday, minutesLeft, blocked }. */
function summary(store, user, now = new Date()) {
  const r = store.data.screenTime?.[user.id];
  const used = r?.day === dayKey(now) ? Math.floor(r.seconds / 60) : 0;
  return {
    bedtime: user.bedtime || null, dailyMinutes: user.dailyMinutes || null, minutesToday: used,
    minutesLeft: user.dailyMinutes ? Math.max(0, user.dailyMinutes - used) : null, blocked: blocked(store, user, now),
  };
}

const label = (m) => (m % 60 ? (m > 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} minutes`) : `${m / 60} hour${m === 60 ? '' : 's'}`);

module.exports = { clean, tick, blocked, summary, inBedtime, label };
