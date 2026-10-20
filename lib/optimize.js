'use strict';
// Overnight conversions: files most players can't play as they are (DVD rips, 4K, HEVC…) get a
// 1080p H.264 copy with AAC sound in an MP4, made at night on the graphics card. The copy is
// offered as another version of the title (library.js "~o"): the Shield with the OLED still plays
// the 4K original, while 1080p TVs, the Roku and browsers play the copy as it is instead of the
// server converting the original every time. The originals are never touched.
//
// Settings (store.data.settings.optimize): which kinds of files, the hours it may run, and how much
// space the copies may take. While someone is watching, the conversion under way is paused.
// item.optimized = { file, size, media, createdAt, sourceMtime } once made; item.optimizeFailed =
// { at, error } skips it for a week.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { videoArgs } = require('./hwaccel');
const { lowPriority, canCopyVideo } = require('./media');
const { interlaced } = require('./picture');
const { fare } = require('./report');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const KINDS = {
  dvd: 'DVD rips and older formats (MPEG-2, VC-1, DivX…), and interlaced video',
  uhd: '4K files (a 1080p copy for the TVs that aren’t 4K)',
  hevc: 'HEVC, AV1 and VP9 files up to 1080p',
  other: 'Anything else the 1080p TVs can’t play as it is',
};
const DEFAULTS = { enabled: false, kinds: { dvd: true, uhd: false, hevc: false, other: false }, start: '01:00', end: '07:00', maxGb: 200 };
const OLD_CODECS = new Set(['mpeg2video', 'mpeg1video', 'vc1', 'wmv3', 'wmv2', 'mpeg4', 'msmpeg4v3', 'msmpeg4v2', 'h263', 'theora']);
const RETRY_FAILED_MS = 7 * 86400_000;
const AUDIO_BITRATE = 192_000;

const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const pad = (n) => String(n).padStart(2, '0');
const height = (v) => Math.max(v?.height || 0, Math.round(((v?.width || 0) * 9) / 16));

/** Which kind of file this is for conversions, or null when the 1080p TVs play it as it is. */
function kindOf(it) {
  const v = it.media?.video;
  if (!v) return null;
  if (fare(it).hd.how === 'direct') return null;
  if (OLD_CODECS.has(v.codec) || interlaced(v)) return 'dvd';
  if (height(v) > 1100) return 'uhd';
  if (['hevc', 'av1', 'vp9'].includes(v.codec)) return 'hevc';
  return 'other';
}

class Optimizer {
  // probe(file) -> media info (media.probe); isBusy() -> someone is watching.
  constructor(store, dir, hwaccel, { probe, isBusy = () => false, label = null, now = () => new Date() } = {}) {
    this.store = store;
    this.dir = dir;
    this.hwaccel = hwaccel;
    this.probe = probe;
    this.isBusy = isBusy;
    this.label = label || dir;
    this.now = now;
    this.running = null; // { item, proc, progress, paused, startedAt }
    this.runUntil = 0; // "Start now": run outside the hours until then
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.tmp')) fs.rmSync(path.join(dir, f), { force: true }); // unfinished
  }

  settings() {
    const s = this.store.data.settings?.optimize || {};
    return { ...DEFAULTS, ...s, kinds: { ...DEFAULTS.kinds, ...(s.kinds || {}) } };
  }

  update(input = {}) {
    const s = this.settings();
    if (input.enabled !== undefined) s.enabled = !!input.enabled;
    for (const k of Object.keys(KINDS)) if (input.kinds?.[k] !== undefined) s.kinds[k] = !!input.kinds[k];
    for (const k of ['start', 'end']) {
      if (input[k] === undefined) continue;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input[k])) throw httpError(400, 'Times look like 01:00');
      s[k] = input[k];
    }
    if (input.maxGb !== undefined) {
      const n = Number(input.maxGb);
      if (!Number.isInteger(n) || n < 10 || n > 100000) throw httpError(400, 'Space must be between 10 GB and 100 TB');
      s.maxGb = n;
    }
    (this.store.data.settings ||= {}).optimize = s;
    this.store.save();
    if (!s.enabled) this.stopRunning();
    return s;
  }

  // ---- what to convert ----
  /** Titles that would get a copy (with the kinds switched on), newest first. */
  candidates({ kinds = this.settings().kinds } = {}) {
    const now = Date.now();
    const out = [];
    for (const it of Object.values(this.store.data.items)) {
      if ((it.type !== 'movie' && it.type !== 'episode') || it.optimized) continue;
      if (it.optimizeFailed && now - it.optimizeFailed.at < RETRY_FAILED_MS) continue;
      const k = kindOf(it);
      if (k && kinds[k]) out.push(it);
    }
    // DVD rips first (the most work saved per copy), then the newest additions.
    const rank = { dvd: 0, uhd: 1, hevc: 2, other: 3 };
    return out.sort((a, b) => rank[kindOf(a)] - rank[kindOf(b)] || (b.addedAt || 0) - (a.addedAt || 0));
  }

  counts() {
    const out = { dvd: 0, uhd: 0, hevc: 0, other: 0 };
    let done = 0;
    for (const it of Object.values(this.store.data.items)) {
      if (it.optimized) { done++; continue; }
      if (it.type !== 'movie' && it.type !== 'episode') continue;
      const k = kindOf(it);
      if (k) out[k]++;
    }
    return { ...out, done };
  }

  used() {
    let n = 0;
    for (const it of Object.values(this.store.data.items)) n += it.optimized?.size || 0;
    if (this.running) { try { n += fs.statSync(this.running.tmp).size; } catch { /* not started */ } }
    return n;
  }

  /** Within the hours set (or after "Start now")? */
  inHours(d = this.now()) {
    if (Date.now() < this.runUntil) return true;
    const { start, end } = this.settings();
    const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return start <= end ? t >= start && t < end : t >= start || t < end;
  }

  status() {
    const s = this.settings();
    const r = this.running;
    const queue = s.enabled ? this.candidates().length : 0;
    let state = 'off';
    if (s.enabled) {
      state = r ? (r.paused ? 'paused' : 'converting')
        : !queue ? 'done' : this.used() >= s.maxGb * 1e9 ? 'full' : !this.inHours() ? 'waiting' : this.isBusy() ? 'paused' : 'starting';
    }
    return {
      settings: s, kinds: KINDS, state, folder: this.label, used: this.used(), counts: this.counts(), queue,
      running: r ? { id: r.item.id, title: titleOf(this.store, r.item), progress: Math.round(r.progress * 1000) / 1000 } : null,
      runUntil: this.runUntil > Date.now() ? this.runUntil : null,
      last: this.store.data.optimizeLast || null,
    };
  }

  /** "Start now": run outside the set hours for the next `hours`. */
  startNow(hours = 6) {
    this.runUntil = Date.now() + hours * 3600_000;
    this.tick();
  }

  // ---- running ----
  /** Every minute: start the next conversion when it's time; pause / resume around viewers. */
  tick() {
    const s = this.settings();
    const r = this.running;
    if (r?.proc && process.platform !== 'win32') {
      const busy = this.isBusy();
      if (busy && !r.paused) { r.proc.kill('SIGSTOP'); r.paused = true; }
      else if (!busy && r.paused) { r.proc.kill('SIGCONT'); r.paused = false; }
    }
    if (r || !s.enabled || !this.inHours() || this.isBusy()) return;
    if (this.used() >= s.maxGb * 1e9) return;
    const next = this.candidates()[0];
    if (next) this.run(next);
  }

  run(item, encoder = this.hwaccel?.active || 'software') {
    const name = `${item.id}-${Math.round(item.mtime || 0)}.mp4`;
    const out = path.join(this.dir, name);
    const tmp = `${out}.tmp`;
    const v = item.media.video;
    // A picture the TVs can already play (only the sound or the file type was the trouble) is copied.
    const copy = canCopyVideo(v) && height(v) <= 1100;
    const enc = copy ? { input: [], map: ['-map', '0:v:0'], output: ['-c:v', 'copy'], kind: 'copy' } : videoArgs(encoder, { maxHeight: 1080, video: v });
    encoder = enc.kind;
    // Every sound track, as stereo AAC; text subtitles go along (picture ones stay with the original).
    const audio = (item.media.audio || []).map((a, i) => ['-map', `0:a:${i}`]).flat();
    const subs = (item.media.subtitles || []).filter((s) => s.text).map((s) => ['-map', `0:s:${s.index}`]).flat();
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...enc.input, '-i', item.file, ...enc.map, ...audio, ...subs, '-dn',
      ...enc.output, '-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', String(AUDIO_BITRATE), ...(subs.length ? ['-c:s', 'mov_text'] : []),
      '-map_metadata', '0', '-movflags', '+faststart', '-max_muxing_queue_size', '4096', '-progress', 'pipe:1', '-f', 'mp4', tmp];
    const proc = lowPriority(spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] }));
    const job = { item, proc, tmp, progress: 0, paused: false, startedAt: Date.now() };
    this.running = job;
    const duration = item.media.duration || 0;
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    proc.stdout.on('data', (d) => {
      const m = /out_time_us=(\d+)/.exec(String(d).split('\n').filter((l) => l.startsWith('out_time_us=')).pop() || '');
      if (m && duration > 0) job.progress = Math.min(0.99, Number(m[1]) / 1e6 / duration);
    });
    proc.on('close', async (code) => {
      this.running = null;
      if (job.stopped) { fs.rmSync(tmp, { force: true }); return; }
      if (code === 0) {
        try {
          fs.renameSync(tmp, out);
          const media = await this.probe(out);
          const st = fs.statSync(out);
          if (this.store.data.items[item.id] !== item) throw new Error('the original changed while it was being converted');
          item.optimized = { file: out, size: st.size, media, createdAt: Date.now(), sourceMtime: item.mtime || 0 };
          delete item.optimizeFailed;
          this.store.data.optimizeLast = { at: Date.now(), id: item.id, title: titleOf(this.store, item), ok: true, seconds: Math.round((Date.now() - job.startedAt) / 1000) };
          this.store.save();
          console.log(`[optimize] ${path.basename(item.file)}: ${Math.round(st.size / 1e6)} MB in ${this.store.data.optimizeLast.seconds}s`);
        } catch (err) {
          fs.rmSync(out, { force: true });
          this.failed(item, err.message);
        }
      } else {
        fs.rmSync(tmp, { force: true });
        const msg = stderr.trim().split('\n').pop() || `exit ${code}`;
        if (encoder !== 'software' && encoder !== 'copy' && Date.now() - job.startedAt < 20_000 && this.hwaccel) {
          // A graphics-card encoder that can't run this one: the CPU does it.
          this.hwaccel.reportFailure?.(encoder, msg);
          this.run(item, this.hwaccel.fallback?.(encoder) || 'software');
          return;
        }
        this.failed(item, msg);
      }
      setImmediate(() => this.tick());
    });
  }

  failed(item, error) {
    item.optimizeFailed = { at: Date.now(), error };
    this.store.data.optimizeLast = { at: Date.now(), id: item.id, title: titleOf(this.store, item), ok: false, error };
    this.store.save();
    console.warn(`[optimize] ${path.basename(item.file)}: ${error}`);
  }

  stopRunning() {
    if (!this.running?.proc) return;
    this.running.stopped = true;
    this.running.proc.kill('SIGKILL');
  }

  /** Copies whose original changed or went away are removed, and so are stray files. */
  cleanup() {
    const keep = new Set();
    for (const it of Object.values(this.store.data.items)) {
      if (!it.optimized) continue;
      if (Math.round(it.optimized.sourceMtime) !== Math.round(it.mtime || 0) || !fs.existsSync(it.optimized.file)) { delete it.optimized; continue; }
      keep.add(path.resolve(it.optimized.file));
    }
    let removed = 0;
    for (const f of fs.readdirSync(this.dir)) {
      const p = path.resolve(this.dir, f);
      if (keep.has(p) || (this.running && p === path.resolve(this.running.tmp))) continue;
      fs.rmSync(p, { force: true });
      removed++;
    }
    return removed;
  }

  /** Remove every copy (they're made again if conversions stay on). */
  removeAll() {
    this.stopRunning();
    for (const it of Object.values(this.store.data.items)) delete it.optimized;
    this.store.save();
    return this.cleanup();
  }

  start() {
    try { this.cleanup(); } catch { /* next time */ }
    setInterval(() => { try { this.tick(); } catch (err) { console.warn(`[optimize] ${err.message}`); } }, 30_000).unref();
    setInterval(() => { try { this.cleanup(); } catch { /* next time */ } }, 6 * 3600_000).unref();
  }

  stop() { this.stopRunning(); }
}

function titleOf(store, it) {
  if (it.type === 'episode') {
    const show = store.data.shows[it.showId];
    const name = show?.edits?.title || show?.meta?.title || show?.title || it.showTitle || '';
    return `${name} S${pad(it.season ?? 0)}E${pad(it.episode ?? 0)}`;
  }
  return it.edits?.title || it.meta?.title || it.title;
}

module.exports = { Optimizer, kindOf, KINDS };
