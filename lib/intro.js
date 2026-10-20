'use strict';
// Intro and credits detection. Episodes of a season usually open with the same theme song and end
// with the same credits music, so the stretch of audio two episodes share near their start is the
// intro, and near their end the credits. Each episode's first 10 and last 6 minutes are turned into
// audio fingerprints (Chromaprint, built into ffmpeg) and compared with a neighbouring episode's;
// the longest matching stretch becomes ep.intro = { start, end } and ep.credits = { start }.
// Recaps ("previously on…") are short clips of earlier episodes before the theme: when most of the
// stretch before an episode's intro is found in the previous episode or the one before it,
// ep.recap = { start, end }.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { lowPriority } = require('./media');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const ITEM_SEC = 4096 / 3 / 11025;   // time covered by one Chromaprint point (≈0.124 s)
const SCAN_SEC = Number(process.env.INTRO_SCAN_SECONDS) || 600; // only look at the first 10 minutes
const TAIL_SEC = 360;                // credits are looked for in the last 6 minutes
const MIN_SEC = 15;
const MAX_SEC = 150;                 // longest believable intro
const MAX_CREDITS_SEC = 330;
const MAX_BIT_ERRORS = 6;            // average differing bits (of 32) for audio to count as the same
const MAX_GAP = Math.round(2 / ITEM_SEC); // short dropouts (a sound effect over the theme) are bridged
const VERSION = 1;                   // bump to re-run detection after algorithm changes
const RECAP_VERSION = 1;
const RECAP_MIN_SEC = 15;            // shorter than this isn't worth a button
const RECAP_MAX_SEC = 240;           // recaps are looked for in the first 4 minutes
const CLIP_SEC = 1.5;                // the shortest clip counted as coming from an earlier episode

const popcount = (x) => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

// The fingerprint being made (so the detector can pause it while someone watches).
let working = null;

// Fingerprint of `seconds` of audio starting at `from` (one thread: lossless film soundtracks
// take real work to decode, and this is background work).
function fingerprint(file, seconds = SCAN_SEC, from = 0) {
  return new Promise((resolve, reject) => {
    const p = lowPriority(spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', ...(from > 0 ? ['-ss', String(from)] : []), '-t', String(seconds), '-i', file,
      '-map', '0:a:0', '-ac', '1', '-f', 'chromaprint', '-fp_format', 'raw', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }));
    working = p;
    const out = []; let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err = (err + d).slice(-1000); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (working === p) working = null;
      if (code) return reject(new Error(err.trim().split('\n').pop() || `ffmpeg exited ${code}`));
      const buf = Buffer.concat(out);
      const fp = new Uint32Array(Math.floor(buf.length / 4));
      for (let i = 0; i < fp.length; i++) fp[i] = buf.readUInt32LE(i * 4);
      resolve(fp);
    });
  });
}

// The longest stretch the two fingerprints share, as { aStart, aEnd, bStart, bEnd } in seconds, or null.
function compare(a, b) {
  // Candidate alignments: where identical points occur in both (the shared theme produces many
  // hits at the same shift). Also index with the lowest bits dropped to tolerate small differences.
  const shifts = new Map();
  for (const mask of [0xffffffff, 0xfffffff0 >>> 0]) {
    const index = new Map();
    for (let j = 0; j < b.length; j++) {
      const k = (b[j] & mask) >>> 0;
      const list = index.get(k);
      if (list) { if (list.length < 8) list.push(j); } else index.set(k, [j]);
    }
    for (let i = 0; i < a.length; i++) {
      const list = index.get((a[i] & mask) >>> 0);
      if (!list) continue;
      for (const j of list) shifts.set(j - i, (shifts.get(j - i) || 0) + 1);
    }
  }
  // Neighbouring shifts are the same alignment, give or take a point; merge their votes.
  const ranked = [...shifts.entries()].filter(([, n]) => n >= 4).sort((x, y) => y[1] - x[1]).slice(0, 12);
  let best = null;
  const tried = new Set();
  for (const [base] of ranked) {
    for (const shift of [base - 1, base, base + 1]) {
      if (tried.has(shift)) continue;
      tried.add(shift);
      const r = longestRun(a, b, shift);
      if (r && (!best || r.len > best.len)) best = r;
    }
  }
  if (!best || best.len * ITEM_SEC < MIN_SEC) return null;
  const s = best.shift;
  return {
    aStart: best.start * ITEM_SEC, aEnd: (best.start + best.len) * ITEM_SEC,
    bStart: (best.start + s) * ITEM_SEC, bEnd: (best.start + best.len + s) * ITEM_SEC,
  };
}

function longestRun(a, b, shift) {
  let best = null;
  for (const r of runsAt(a, b, shift)) if (!best || r.len > best.len) best = r;
  return best;
}

// Every stretch where a and b match at this alignment, as [{ start, len, shift }] (positions in a).
function runsAt(a, b, shift) {
  const from = Math.max(0, -shift), to = Math.min(a.length, b.length - shift);
  if (to - from < 8) return [];
  // Bit errors averaged over about a second: matching audio stays well under the limit, while
  // unrelated audio only dips below it now and then.
  const err = new Float32Array(to - from);
  for (let i = from; i < to; i++) err[i - from] = popcount((a[i] ^ b[i + shift]) >>> 0);
  const W = 4;
  const runs = [];
  let runStart = -1, lastGood = -1;
  const close = () => {
    if (runStart < 0) return;
    runs.push({ start: runStart, len: lastGood - runStart + 1, shift });
  };
  for (let k = 0; k < err.length; k++) {
    let sum = 0, n = 0;
    for (let d = Math.max(0, k - W); d <= Math.min(err.length - 1, k + W); d++) { sum += err[d]; n++; }
    if (sum / n <= MAX_BIT_ERRORS && err[k] <= MAX_BIT_ERRORS + 3) {
      const i = k + from;
      if (runStart < 0 || i - lastGood > MAX_GAP) { close(); runStart = i; }
      lastGood = i;
    }
  }
  close();
  return runs;
}

// Which points of `a` (seconds of audio) also occur somewhere in `b`, in stretches of at least
// CLIP_SEC: a recap is many short clips taken from all over earlier episodes.
function covered(a, b, into = new Uint8Array(a.length)) {
  const shifts = new Map();
  const index = new Map();
  for (let j = 0; j < b.length; j++) {
    const list = index.get(b[j]);
    if (list) { if (list.length < 8) list.push(j); } else index.set(b[j], [j]);
  }
  for (let i = 0; i < a.length; i++) {
    const list = index.get(a[i]);
    if (list) for (const j of list) shifts.set(j - i, (shifts.get(j - i) || 0) + 1);
  }
  const minLen = Math.round(CLIP_SEC / ITEM_SEC);
  for (const [shift] of [...shifts.entries()].filter(([, n]) => n >= 3).sort((x, y) => y[1] - x[1]).slice(0, 60)) {
    for (const r of runsAt(a, b, shift)) if (r.len >= minLen) into.fill(1, r.start, r.start + r.len);
  }
  return into;
}

// The recap in `a` (the start of an episode, up to its intro) from earlier episodes' audio, or null.
function findRecap(a, earlier) {
  if (a.length * ITEM_SEC < RECAP_MIN_SEC) return null;
  const hit = new Uint8Array(a.length);
  for (const b of earlier) if (b) covered(a, b, hit);
  const first = hit.indexOf(1), last = hit.lastIndexOf(1);
  if (first < 0) return null;
  let n = 0;
  for (let i = first; i <= last; i++) n += hit[i];
  const span = (last - first + 1) * ITEM_SEC;
  // Mostly clips (narration and music in between are fine), and long enough to be worth skipping.
  if (span < RECAP_MIN_SEC || n / (last - first + 1) < 0.35) return null;
  return { start: first * ITEM_SEC, end: (last + 1) * ITEM_SEC };
}

const round = (x) => Math.round(x * 10) / 10;
// Intros/credits set (or cleared) by an admin are never replaced by detection.
const PARTS = ['intro', 'credits'];
const partChecked = (e, part) => !!e[part]?.manual || e[part]?.v === (part === 'recap' ? RECAP_VERSION : VERSION);
const checked = (e) => PARTS.every((part) => partChecked(e, part)) && partChecked(e, 'recap');
// Where the end-of-episode fingerprint starts: the last 6 minutes, but never the first half
// (in short episodes that would reach back to the intro).
const tailFrom = (ep) => Math.max((ep.media?.duration || 0) / 2, (ep.media?.duration || 0) - TAIL_SEC);

class IntroDetector {
  // isBusy(): true while someone is watching; detection waits meanwhile, and the episode it was
  // in the middle of is paused (not on Windows hosts, which can't pause a process).
  constructor(store, dataDir, { isBusy = () => false } = {}) {
    this.store = store;
    this.isBusy = isBusy;
    if (process.platform !== 'win32') {
      setInterval(() => {
        const p = working;
        if (!p || p.exitCode !== null) return;
        const busy = this.isBusy();
        if (busy && !p.paused) { p.kill('SIGSTOP'); p.paused = true; } else if (!busy && p.paused) { p.kill('SIGCONT'); p.paused = false; }
      }, 2000).unref();
    }
    this.cacheDir = path.join(dataDir, 'fingerprints');
    this.queue = [];
    this.current = null;
    this.running = false;
  }

  enabled() { return this.store.data.settings?.introDetection !== false; }

  status() {
    const eps = Object.values(this.store.data.items).filter((i) => i.type === 'episode');
    return {
      enabled: this.enabled(), running: !!this.current, current: this.current, queued: this.queue.length,
      found: eps.filter((e) => e.intro?.end).length, creditsFound: eps.filter((e) => e.credits?.start).length,
      recapsFound: eps.filter((e) => e.recap?.end).length,
      checked: eps.filter(checked).length, episodes: eps.length,
    };
  }

  // Queue every season (of a library, or all) that has episodes not yet checked; `force` redoes them all.
  enqueue({ libraryId = null, force = false } = {}) {
    if (!force && !this.enabled()) return;
    if (force) {
      for (const it of Object.values(this.store.data.items)) {
        if (it.type !== 'episode' || (libraryId && it.libraryId !== libraryId)) continue;
        for (const part of [...PARTS, 'recap']) if (!it[part]?.manual) delete it[part];
      }
    }
    for (const [key, eps] of this.seasons(libraryId)) {
      if (eps.length < 2 || eps.every(checked)) continue;
      if (!this.queue.includes(key) && this.current?.key !== key) this.queue.push(key);
    }
    this.run();
  }

  seasons(libraryId) {
    const map = new Map();
    for (const it of Object.values(this.store.data.items)) {
      if (it.type !== 'episode' || !it.media?.audio?.length || (libraryId && it.libraryId !== libraryId)) continue;
      const key = `${it.showId}|${it.season ?? 0}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(it);
    }
    for (const eps of map.values()) eps.sort((x, y) => (x.episode ?? 0) - (y.episode ?? 0) || x.file.localeCompare(y.file));
    return map;
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const key = this.queue.shift();
        const eps = this.seasons(null).get(key);
        if (!eps) continue;
        const show = this.store.data.shows[eps[0].showId];
        this.current = { key, show: show?.edits?.title || show?.meta?.title || show?.title || eps[0].showTitle, season: eps[0].season, done: 0, total: eps.length };
        try { await this.detectSeason(eps); } catch (err) { console.warn(`[intro] ${this.current.show} season ${this.current.season}: ${err.message}`); }
        this.store.save();
      }
    } finally {
      this.current = null;
      this.running = false;
    }
  }

  async fingerprintOf(ep, part) {
    const cache = path.join(this.cacheDir, `${ep.id}-${Math.round(ep.mtime)}${part === 'credits' ? '-end' : part === 'full' ? '-full' : ''}.fp`);
    try { const b = fs.readFileSync(cache); return new Uint32Array(b.buffer, b.byteOffset, b.length / 4); } catch { /* not cached */ }
    const fp = part === 'credits' ? await fingerprint(ep.file, TAIL_SEC, tailFrom(ep))
      : part === 'full' ? await fingerprint(ep.file, Math.ceil(ep.media?.duration || 3600))
        : await fingerprint(ep.file);
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.writeFileSync(cache, Buffer.from(fp.buffer, fp.byteOffset, fp.byteLength));
    return fp;
  }

  async detectSeason(eps) {
    const fps = new Map();
    const fpOf = async (ep, part) => {
      const key = `${ep.id}|${part}`;
      if (!fps.has(key)) fps.set(key, await this.fingerprintOf(ep, part).catch((err) => { console.warn(`[intro] ${path.basename(ep.file)}: ${err.message}`); return null; }));
      return fps.get(key);
    };
    for (let i = 0; i < eps.length; i++) {
      const ep = eps[i];
      while (this.isBusy()) await new Promise((r) => setTimeout(r, 5000));
      for (const part of PARTS) {
        if (partChecked(ep, part)) continue;
        const mine = await fpOf(ep, part);
        let found = null;
        // Compare with the next episode, then the previous, then one further away (a recap, a cold
        // open or a different closing scene can hide the match with a direct neighbour).
        for (const j of [i + 1, i - 1, i + 2, i - 2]) {
          if (!mine || j < 0 || j >= eps.length) continue;
          const other = await fpOf(eps[j], part);
          if (!other) continue;
          const m = compare(mine, other);
          const len = m ? m.aEnd - m.aStart : 0;
          if (part === 'intro' && m && len <= MAX_SEC) { found = m; break; }
          if (part === 'credits' && m && len <= MAX_CREDITS_SEC) { found = m; break; }
        }
        if (part === 'intro') {
          ep.intro = found
            ? { v: VERSION, start: round(found.aStart < 3 ? 0 : found.aStart), end: round(found.aEnd), at: Date.now() }
            : { v: VERSION, at: Date.now() };
        } else {
          ep.credits = found ? { v: VERSION, start: round(tailFrom(ep) + found.aStart), at: Date.now() } : { v: VERSION, at: Date.now() };
        }
      }
      this.current.done++;
    }
    // Recaps: the stretch before the intro, compared with the whole of the one or two episodes before.
    for (let i = 0; i < eps.length; i++) {
      const ep = eps[i];
      if (partChecked(ep, 'recap')) continue;
      const before = Math.min(ep.intro?.start || 0, RECAP_MAX_SEC);
      let found = null;
      if (i > 0 && before >= RECAP_MIN_SEC) {
        while (this.isBusy()) await new Promise((r) => setTimeout(r, 5000));
        const mine = await fpOf(ep, 'intro');
        const earlier = [];
        for (const j of [i - 1, i - 2]) if (j >= 0) earlier.push(await fpOf(eps[j], 'full'));
        if (mine) found = findRecap(mine.subarray(0, Math.round(before / ITEM_SEC)), earlier);
      }
      ep.recap = found ? { v: RECAP_VERSION, start: round(found.start < 3 ? 0 : found.start), end: round(found.end), at: Date.now() } : { v: RECAP_VERSION, at: Date.now() };
    }
    // Fingerprints of files that no longer exist are removed.
    try {
      const live = new Set(Object.values(this.store.data.items).flatMap((i) => ['', '-end', '-full'].map((s) => `${i.id}-${Math.round(i.mtime)}${s}.fp`)));
      for (const f of fs.readdirSync(this.cacheDir)) if (!live.has(f)) fs.rmSync(path.join(this.cacheDir, f), { force: true });
    } catch { /* no cache dir */ }
  }
}

module.exports = { IntroDetector, fingerprint, compare, findRecap, ITEM_SEC, VERSION, TAIL_SEC };
