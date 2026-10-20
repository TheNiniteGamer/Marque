'use strict';
// Where a video's keyframes are. The original picture can only be cut at a keyframe, so streaming
// a file without converting it (an MKV whose H.264 video browsers can play, put into adaptive
// streaming segments as it is) needs the list to know where each segment starts. Finding them
// means reading the whole file once (a few seconds to a minute, depending on its size and the
// disk); the list is kept with the file's size and date, so it's only done again if the file changes.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { lowPriority } = require('./media');

const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const TIMEOUT_MS = 10 * 60_000;
const MAX_QUEUE = 20;

class Keyframes {
  constructor(dir) {
    this.dir = dir;
    this.memo = new Map();    // file name -> times
    this.jobs = new Map();    // file name -> promise
    this.queue = [];          // [item, resolve] waiting for their turn (one file read at a time)
    this.running = 0;
    fs.mkdirSync(dir, { recursive: true });
  }

  name(item) { return `${item.id}-${item.size || 0}-${Math.round(item.mtime || 0)}.json`; }

  /** The keyframe times (seconds from the start), if known; null otherwise. */
  get(item) {
    const n = this.name(item);
    if (this.memo.has(n)) return this.memo.get(n);
    try {
      const times = JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8'));
      if (Array.isArray(times)) { this.remember(n, times); return times; }
    } catch { /* not made yet */ }
    return null;
  }

  remember(n, times) {
    this.memo.set(n, times);
    if (this.memo.size > 50) this.memo.delete(this.memo.keys().next().value);
  }

  /** The keyframe times, finding them first if needed (null if they can't be found). */
  ensure(item) {
    const known = this.get(item);
    if (known) return Promise.resolve(known);
    const n = this.name(item);
    if (this.jobs.has(n)) return this.jobs.get(n);
    if (this.queue.length >= MAX_QUEUE) return Promise.resolve(null);
    const job = new Promise((resolve) => { this.queue.push([item, resolve]); this.next(); })
      .finally(() => this.jobs.delete(n));
    this.jobs.set(n, job);
    return job;
  }

  next() {
    if (this.running || !this.queue.length) return;
    const [item, resolve] = this.queue.shift();
    this.running++;
    this.current = item;
    this.probe(item.file).then((times) => {
      if (times?.length) {
        const n = this.name(item);
        // Earlier lists for this title (from a file since replaced) go.
        for (const f of fs.readdirSync(this.dir)) if (f.startsWith(`${item.id}-`) && f !== n) fs.rmSync(path.join(this.dir, f), { force: true });
        fs.writeFileSync(path.join(this.dir, n), JSON.stringify(times));
        this.remember(n, times);
      }
      resolve(times?.length ? times : null);
    }, () => resolve(null)).finally(() => { this.running--; this.current = null; this.next(); });
  }

  /** Reads the file's video packets and keeps the keyframes' times, from the file's start. */
  probe(file) {
    return new Promise((resolve, reject) => {
      const proc = lowPriority(spawn(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=start_time:packet=pts_time,flags',
        '-of', 'csv=p=0', file], { stdio: ['ignore', 'pipe', 'pipe'] }));
      const times = [];
      let start = null, rest = '', err = '';
      const timer = setTimeout(() => proc.kill('SIGKILL'), TIMEOUT_MS);
      const line = (l) => {
        const [a, b] = l.split(',');
        if (b === undefined) { if (a && a !== 'N/A') start = Number(a); return; } // format=start_time (comes last)
        if (b.startsWith('K') && a !== 'N/A') times.push(Number(a));
      };
      proc.stdout.on('data', (d) => {
        const lines = (rest + d).split('\n');
        rest = lines.pop();
        for (const l of lines) line(l.trim());
      });
      proc.stderr.on('data', (d) => { err = (err + d).slice(-500); });
      proc.on('error', reject);
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (rest.trim()) line(rest.trim());
        if (code !== 0) return reject(new Error(err.trim() || `ffprobe exit ${code}`));
        // ffmpeg counts time from the file's start time, so the list does too.
        const s0 = Number.isFinite(start) ? start : 0;
        const out = [...new Set(times.filter(Number.isFinite).map((t) => Math.round((t - s0) * 1e6) / 1e6))].sort((x, y) => x - y);
        resolve(out);
      });
    });
  }
}

module.exports = { Keyframes };
