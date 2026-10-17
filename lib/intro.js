'use strict';
// Skip-intro detection. Episodes of a season usually open with the same theme song, so the
// stretch of audio that two episodes share near their start is the intro. Each episode's first
// minutes are turned into an audio fingerprint (Chromaprint, built into ffmpeg) and compared with
// a neighbouring episode; the longest matching stretch becomes { start, end } on the episode.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const ITEM_SEC = 4096 / 3 / 11025;   // time covered by one Chromaprint point (≈0.124 s)
const SCAN_SEC = Number(process.env.INTRO_SCAN_SECONDS) || 600; // only look at the first 10 minutes
const MIN_SEC = 15;
const MAX_SEC = 150;
const MAX_BIT_ERRORS = 6;            // average differing bits (of 32) for audio to count as the same
const MAX_GAP = Math.round(2 / ITEM_SEC); // short dropouts (a sound effect over the theme) are bridged
const VERSION = 1;                   // bump to re-run detection after algorithm changes

const popcount = (x) => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

function fingerprint(file, seconds = SCAN_SEC) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-t', String(seconds), '-i', file,
      '-map', '0:a:0', '-ac', '1', '-f', 'chromaprint', '-fp_format', 'raw', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = []; let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err = (err + d).slice(-1000); });
    p.on('error', reject);
    p.on('close', (code) => {
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
  const from = Math.max(0, -shift), to = Math.min(a.length, b.length - shift);
  if (to - from < 8) return null;
  // Bit errors averaged over about a second: matching audio stays well under the limit, while
  // unrelated audio only dips below it now and then.
  const err = new Float32Array(to - from);
  for (let i = from; i < to; i++) err[i - from] = popcount((a[i] ^ b[i + shift]) >>> 0);
  const W = 4;
  let best = null, runStart = -1, lastGood = -1;
  const close = () => {
    if (runStart < 0) return;
    const len = lastGood - runStart + 1;
    if (!best || len > best.len) best = { start: runStart, len, shift };
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
  return best;
}

const round = (x) => Math.round(x * 10) / 10;

class IntroDetector {
  constructor(store, dataDir) {
    this.store = store;
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
      found: eps.filter((e) => e.intro?.end).length, checked: eps.filter((e) => e.intro?.v === VERSION).length, episodes: eps.length,
    };
  }

  // Queue every season (of a library, or all) that has episodes not yet checked; `force` redoes them all.
  enqueue({ libraryId = null, force = false } = {}) {
    if (!force && !this.enabled()) return;
    if (force) for (const it of Object.values(this.store.data.items)) if (it.type === 'episode' && (!libraryId || it.libraryId === libraryId)) delete it.intro;
    for (const [key, eps] of this.seasons(libraryId)) {
      if (eps.length < 2 || !eps.some((e) => e.intro?.v !== VERSION)) continue;
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

  async fingerprintOf(ep) {
    const cache = path.join(this.cacheDir, `${ep.id}-${Math.round(ep.mtime)}.fp`);
    try { const b = fs.readFileSync(cache); return new Uint32Array(b.buffer, b.byteOffset, b.length / 4); } catch { /* not cached */ }
    const fp = await fingerprint(ep.file);
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.writeFileSync(cache, Buffer.from(fp.buffer, fp.byteOffset, fp.byteLength));
    return fp;
  }

  async detectSeason(eps) {
    const fps = new Map();
    const fpOf = async (ep) => {
      if (!fps.has(ep.id)) fps.set(ep.id, await this.fingerprintOf(ep).catch((err) => { console.warn(`[intro] ${path.basename(ep.file)}: ${err.message}`); return null; }));
      return fps.get(ep.id);
    };
    for (let i = 0; i < eps.length; i++) {
      const ep = eps[i];
      if (ep.intro?.v === VERSION) { this.current.done++; continue; }
      const mine = await fpOf(ep);
      let found = null;
      // Compare with the next episode, then the previous, then one further away (a recap or a
      // cold open can hide the match with a direct neighbour).
      for (const j of [i + 1, i - 1, i + 2, i - 2]) {
        if (!mine || j < 0 || j >= eps.length) continue;
        const other = await fpOf(eps[j]);
        if (!other) continue;
        const m = compare(mine, other);
        if (m && m.aEnd - m.aStart <= MAX_SEC) { found = m; break; }
      }
      ep.intro = found
        ? { v: VERSION, start: round(found.aStart < 3 ? 0 : found.aStart), end: round(found.aEnd), at: Date.now() }
        : { v: VERSION, at: Date.now() };
      this.current.done++;
    }
    // Fingerprints of files that no longer exist are removed.
    try {
      const live = new Set(Object.values(this.store.data.items).map((i) => `${i.id}-${Math.round(i.mtime)}.fp`));
      for (const f of fs.readdirSync(this.cacheDir)) if (!live.has(f)) fs.rmSync(path.join(this.cacheDir, f), { force: true });
    } catch { /* no cache dir */ }
  }
}

module.exports = { IntroDetector, fingerprint, compare, ITEM_SEC, VERSION };
