'use strict';
// Downloads for watching offline (the phone app). When the phone can't play the original file, or
// a smaller copy is wanted, the server makes an ordinary MP4 at a phone-friendly size in the
// background, one at a time, for the phone to download. Copies are removed a week after they were
// last asked for. While someone is watching (a conversion for playback is running), making copies
// waits: the one under way is paused and carries on afterwards.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { videoArgs } = require('./hwaccel');
const { lowPriority } = require('./media');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const SIZES = {
  '1080p': { height: 1080, bitrate: 5_000_000, label: 'Best (1080p)' },
  '720p': { height: 720, bitrate: 2_500_000, label: 'Standard (720p)' },
  '480p': { height: 480, bitrate: 1_000_000, label: 'Smaller (480p)' },
};
const AUDIO_BITRATE = 160_000;
const KEEP_MS = 7 * 24 * 3600_000;

const httpError = (status, msg) => Object.assign(new Error(msg), { status });

/** About how big a copy will be, in bytes (for the phone to show before downloading). */
function estimateSize(item, quality) {
  const q = SIZES[quality];
  const duration = item.duration || item.media?.duration || 0;
  const video = Math.min(q.bitrate, (item.media?.bitrate || Infinity) * 1.1);
  return Math.round(((video + AUDIO_BITRATE) / 8) * duration);
}

/** The sizes worth offering for a file: nothing taller than the video itself (always at least one). */
function sizesFor(item) {
  const h = item.media?.video?.height || 1080;
  const w = item.media?.video?.width || 1920;
  const effective = Math.max(h, Math.round((w * 9) / 16));
  const fit = Object.entries(SIZES).filter(([, q]) => q.height <= effective * 1.05);
  return (fit.length ? fit : [['480p', SIZES['480p']]]).map(([id, q]) => ({ id, label: q.label, height: q.height, size: estimateSize(item, id) }));
}

class Offline {
  constructor(dir, hwaccel, { isBusy = () => false } = {}) {
    this.dir = dir;
    this.hwaccel = hwaccel;
    this.isBusy = isBusy;
    this.jobs = new Map(); // key -> job
    this.queue = [];
    this.running = null;
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.tmp')) fs.rmSync(path.join(dir, f), { force: true }); // unfinished
  }

  key(item, quality, audio) { return `${item.id}-${Math.round(item.mtime || 0)}-${quality}-${audio}`; }
  file(key) { return path.join(this.dir, `${key}.mp4`); }

  check(item, quality, audio) {
    if (!SIZES[quality]) throw httpError(400, 'Unknown size');
    if (!item.media?.video) throw httpError(400, 'This file has no video');
    const n = Number(audio) || 0;
    if (!Number.isInteger(n) || n < 0 || n >= Math.max(1, item.media.audio?.length || 0)) throw httpError(400, 'No such sound track');
    return n;
  }

  /** { status: 'ready', size } | { status: 'queued' | 'converting', progress } | { status: 'failed', error } | { status: 'none' } */
  status(item, { quality, audio = 0 }) {
    const key = this.key(item, quality, this.check(item, quality, audio));
    const file = this.file(key);
    try {
      const st = fs.statSync(file);
      const now = new Date();
      fs.utimesSync(file, now, now); // asked for again: keep it another week
      return { status: 'ready', size: st.size };
    } catch { /* not made yet */ }
    const job = this.jobs.get(key);
    if (!job) return { status: 'none' };
    if (job.status === 'failed') return { status: 'failed', error: job.error };
    // waiting: held back while someone is watching
    const waiting = job.status === 'queued' ? this.isBusy() : !!job.paused;
    return { status: job.status, progress: Math.round(job.progress * 100) / 100, ...(waiting ? { waiting: true } : {}) };
  }

  /** Makes the copy unless it's there or on the way (a failed one is tried again). */
  request(item, { quality, audio = 0 }) {
    const a = this.check(item, quality, audio);
    const key = this.key(item, quality, a);
    const now = this.status(item, { quality, audio: a });
    if (now.status !== 'none' && now.status !== 'failed') return now;
    const job = { key, item, quality, audio: a, status: 'queued', progress: 0, error: null, proc: null };
    this.jobs.set(key, job);
    this.queue.push(job);
    this.next();
    return this.status(item, { quality, audio: a });
  }

  /** The finished copy's path (404 until it's ready). */
  path(item, { quality, audio = 0 }) {
    const file = this.file(this.key(item, quality, this.check(item, quality, audio)));
    if (!fs.existsSync(file)) throw httpError(404, 'Not ready yet');
    return file;
  }

  next() {
    if (this.running || !this.queue.length || this.isBusy()) return;
    this.run(this.queue.shift());
  }

  run(job, encoder = this.hwaccel?.active || 'software') {
    const { item } = job;
    const q = SIZES[job.quality];
    const duration = item.duration || item.media?.duration || 0;
    const enc = videoArgs(encoder, { maxHeight: q.height, bitrate: Math.min(q.bitrate, (item.media?.bitrate || Infinity) * 1.1) });
    const tmp = `${this.file(job.key)}.tmp`;
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...enc.input, '-i', item.file, ...enc.map,
      '-map', `0:a:${job.audio}?`, '-sn', '-dn', ...enc.output,
      '-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', String(AUDIO_BITRATE),
      '-movflags', '+faststart', '-max_muxing_queue_size', '2048', '-progress', 'pipe:1', '-f', 'mp4', tmp];
    const proc = lowPriority(spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] }));
    Object.assign(job, { status: 'converting', proc, progress: 0 });
    this.running = job;
    const startedAt = Date.now();
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    proc.stdout.on('data', (d) => {
      const m = /out_time_us=(\d+)/.exec(String(d).split('\n').filter((l) => l.startsWith('out_time_us=')).pop() || '');
      if (m && duration > 0) job.progress = Math.min(0.99, Number(m[1]) / 1e6 / duration);
    });
    proc.on('close', (code) => {
      job.proc = null;
      this.running = null;
      if (code === 0) {
        try { fs.renameSync(tmp, this.file(job.key)); job.status = 'ready'; job.progress = 1; } catch (err) { job.status = 'failed'; job.error = err.message; }
      } else {
        fs.rmSync(tmp, { force: true });
        const msg = stderr.trim().split('\n').pop() || `exit ${code}`;
        if (encoder !== 'software' && Date.now() - startedAt < 20_000) {
          // A graphics-card encoder that can't run: do this one on the CPU.
          this.hwaccel.reportFailure(encoder, msg);
          this.run(job, 'software');
          return;
        }
        job.status = 'failed';
        job.error = msg;
        console.warn(`[offline] ${path.basename(item.file)} ${job.quality}: ${msg}`);
      }
      if (job.status === 'ready') this.jobs.delete(job.key);
      this.next();
    });
  }

  /** Checked every few seconds: pauses the copy under way while someone is watching, then resumes. */
  yieldToViewers() {
    const busy = this.isBusy();
    const job = this.running;
    if (job?.proc && process.platform !== 'win32') {
      if (busy && !job.paused) { job.proc.kill('SIGSTOP'); job.paused = true; }
      else if (!busy && job.paused) { job.proc.kill('SIGCONT'); job.paused = false; }
    }
    if (!busy) this.next();
  }

  /** Removes copies nobody has asked for in a week. */
  cleanup() {
    let removed = 0;
    for (const f of fs.readdirSync(this.dir)) {
      const p = path.join(this.dir, f);
      if (this.running && p.startsWith(this.file(this.running.key))) continue;
      try { if (Date.now() - fs.statSync(p).mtimeMs > KEEP_MS) { fs.rmSync(p, { force: true }); removed++; } } catch { /* gone */ }
    }
    return removed;
  }

  start() {
    setInterval(() => { try { this.cleanup(); } catch { /* next time */ } }, 6 * 3600_000).unref();
    setInterval(() => this.yieldToViewers(), 5000).unref();
  }

  stop() { this.running?.proc?.kill('SIGKILL'); }
}

module.exports = { Offline, SIZES, sizesFor, estimateSize };
