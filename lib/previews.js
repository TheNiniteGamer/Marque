'use strict';
// Preview clips: what plays when the pointer rests on a title (and on the home page's banner) when
// it has no trailer of its own, like the big streaming apps. A clip is 30 seconds from a little way
// into the film (past the opening credits), or from a show's first episode (past its intro), made
// small (480p) the first time it's wanted, one at a time, in the background, and never while
// someone is watching something being converted. Clips not asked for in two months are removed.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { lowPriority } = require('./media');
const { withToneMap } = require('./hdr');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const CLIP_SEC = 30;
const KEEP_MS = 60 * 86400_000;
const MAX_QUEUE = 50;

class Previews {
  constructor(store, dir, { isBusy = () => false, episodesOf = () => [] } = {}) {
    this.store = store;
    this.dir = dir;
    this.isBusy = isBusy;
    this.episodesOf = episodesOf;
    this.queue = [];          // ids (films / shows) waiting
    this.failed = new Map();  // id -> when it failed (not tried again for a day)
    this.running = null;
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.tmp')) fs.rmSync(path.join(dir, f), { force: true });
  }

  enabled() { return this.store.data.settings?.previewClips !== false; }

  /** The video a title's clip comes from: the film itself, or a show's first proper episode. */
  sourceOf(id) {
    const { items, shows } = this.store.data;
    if (Object.hasOwn(shows, id)) {
      const eps = this.episodesOf(this.store, id).filter((e) => e.media?.video);
      return eps.find((e) => (e.season ?? 1) > 0) || eps[0] || null;
    }
    const it = Object.hasOwn(items, id) ? items[id] : null;
    return it?.type === 'movie' && it.media?.video ? it : null;
  }

  // The clip's name changes when the video file does (a new copy, a better version).
  file(id, src) { return path.join(this.dir, `${id}-${src.id}-${Math.round(src.mtime || 0)}.mp4`); }

  /** The clip's path if it's been made; otherwise asks for it (when allowed) and returns null. */
  get(id) {
    if (!this.enabled()) return null;
    const src = this.sourceOf(id);
    if (!src) return null;
    const f = this.file(id, src);
    if (fs.existsSync(f)) {
      const now = new Date();
      try { fs.utimesSync(f, now, now); } catch { /* fine */ } // still wanted: kept
      return f;
    }
    if (!(this.failed.get(id) > Date.now() - 86400_000) && !this.queue.includes(id) && this.running !== id && this.queue.length < MAX_QUEUE) {
      this.queue.push(id);
      this.next();
    }
    return null;
  }

  /** Where in the video the clip starts: past a film's opening, past a show's intro. */
  startOf(src) {
    const d = src.duration || src.media?.duration || 0;
    if (src.type === 'episode') {
      const after = src.intro?.end || src.recap?.end || 0;
      return Math.min(Math.max(after + 30, d * 0.15), Math.max(0, d - CLIP_SEC - 5));
    }
    return Math.max(0, Math.min(d * 0.2, d - CLIP_SEC - 60));
  }

  next() {
    if (this.running || !this.queue.length || this.isBusy()) return;
    const id = this.queue.shift();
    const src = this.sourceOf(id);
    if (!src) { this.next(); return; }
    this.running = id;
    const out = this.file(id, src);
    const tmp = `${out}.tmp`;
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', String(Math.round(this.startOf(src))), '-t', String(CLIP_SEC),
      '-i', src.file, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
      '-vf', withToneMap("scale=-2:'min(480,ih)',format=yuv420p", src.media?.video), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-profile:v', 'main',
      '-c:a', 'aac', '-ac', '2', '-b:a', '96k', '-movflags', '+faststart', '-f', 'mp4', tmp];
    const proc = lowPriority(spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] }));
    let err = '';
    proc.stderr.on('data', (d) => { err = (err + d).slice(-500); });
    proc.on('close', (code) => {
      this.running = null;
      if (code === 0) {
        try {
          // Older clips of the same title (from a file that's since been replaced) go.
          for (const f of fs.readdirSync(this.dir)) if (f.startsWith(`${id}-`) && path.join(this.dir, f) !== out && f.endsWith('.mp4')) fs.rmSync(path.join(this.dir, f), { force: true });
          fs.renameSync(tmp, out);
        } catch { /* gone */ }
      } else {
        fs.rmSync(tmp, { force: true });
        this.failed.set(id, Date.now());
        console.warn(`[previews] ${path.basename(src.file)}: ${err.trim().split('\n').pop() || `exit ${code}`}`);
      }
      this.next();
    });
  }

  /** Removes clips nobody has looked at in two months, and all of them when turned off. */
  cleanup() {
    const off = !this.enabled();
    for (const f of fs.readdirSync(this.dir)) {
      const p = path.join(this.dir, f);
      try { if (off || Date.now() - fs.statSync(p).mtimeMs > KEEP_MS) fs.rmSync(p, { force: true }); } catch { /* gone */ }
    }
    if (off) this.queue = [];
  }

  start() {
    setInterval(() => this.next(), 15_000).unref(); // carries on once nobody is watching
    setInterval(() => { try { this.cleanup(); } catch { /* next time */ } }, 24 * 3600_000).unref();
  }
}

module.exports = { Previews, CLIP_SEC };
