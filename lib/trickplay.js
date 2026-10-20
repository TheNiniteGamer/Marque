'use strict';
// Seek preview thumbnails ("trickplay"): small pictures shown above the seek bar while you drag or
// hover. They are made on demand the first time a video is opened: ffmpeg decodes only keyframes
// (fast) and tiles one picture every INTERVAL seconds into 10×10 JPEG sheets.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { lowPriority } = require('./media');
const { withToneMap } = require('./hdr');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const INTERVAL = 10;   // seconds between thumbnails
const COLS = 10, ROWS = 10;
const WIDTH = 240;

class Trickplay {
  constructor(dataDir) {
    this.root = path.join(dataDir, 'trickplay');
    this.queue = [];
    this.running = null;
    this.failed = new Set(); // ids of videos ffmpeg couldn't make pictures from (until restart)
  }

  dir(item) { return path.join(this.root, `${item.id}-${Math.round(item.mtime || 0)}`); }

  // { ready: true, interval, cols, rows, width, height, count, sheets } — or { ready: false } while
  // they are being made (generation is started by the first request).
  info(item) {
    try { return { ready: true, ...JSON.parse(fs.readFileSync(path.join(this.dir(item), 'info.json'), 'utf8')) }; } catch { /* not made yet */ }
    if (item.media?.video && item.media.duration > INTERVAL && !this.failed.has(item.id) && fs.existsSync(item.file)) this.enqueue(item);
    return { ready: false };
  }

  sheet(item, n) {
    const file = path.join(this.dir(item), `sheet-${n}.jpg`);
    return /^\d+$/.test(String(n)) && fs.existsSync(file) ? file : null;
  }

  enqueue(item) {
    if (this.running?.id === item.id || this.queue.some((i) => i.id === item.id)) return;
    this.queue.unshift(item); // the video someone just opened goes first
    this.next();
  }

  async next() {
    if (this.running || !this.queue.length) return;
    const item = (this.running = this.queue.shift());
    try {
      // Keyframes only is far faster; files with very few keyframes need every frame decoded.
      await this.generate(item, true).catch(() => this.generate(item, false));
    } catch (err) {
      this.failed.add(item.id);
      console.warn(`[trickplay] ${path.basename(item.file)}: ${err.message}`);
    }
    this.running = null;
    this.next();
  }

  generate(item, keyframesOnly) {
    const v = item.media.video;
    const height = Math.max(2, Math.round((WIDTH * v.height) / v.width / 2) * 2);
    const dir = this.dir(item);
    const tmp = `${dir}.tmp`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    return new Promise((resolve, reject) => {
      lowPriority(execFile(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...(keyframesOnly ? ['-skip_frame', 'nokey'] : []), '-i', item.file, '-an', '-sn', '-dn',
        '-vf', `fps=1/${INTERVAL},${withToneMap(`scale=${WIDTH}:${height}`, v)},tile=${COLS}x${ROWS}`, '-fps_mode', 'vfr', '-q:v', '5', path.join(tmp, 'sheet-%d.jpg')],
      { timeout: 30 * 60_000 }, (err, stdout, stderr) => {
        const sheets = fs.readdirSync(tmp).filter((f) => /^sheet-\d+\.jpg$/.test(f)).length;
        if (err || !sheets) {
          fs.rmSync(tmp, { recursive: true, force: true });
          return reject(new Error(String(stderr || err?.message || 'no pictures').trim().split('\n').pop()));
        }
        const info = { interval: INTERVAL, cols: COLS, rows: ROWS, width: WIDTH, height, count: Math.ceil(item.media.duration / INTERVAL), sheets };
        fs.writeFileSync(path.join(tmp, 'info.json'), JSON.stringify(info));
        // Thumbnails for an older version of this file are no longer needed.
        for (const old of fs.readdirSync(this.root)) if (old.startsWith(`${item.id}-`) && !old.endsWith('.tmp')) fs.rmSync(path.join(this.root, old), { recursive: true, force: true });
        fs.renameSync(tmp, dir);
        resolve(info);
      }));
    });
  }
}

module.exports = { Trickplay, INTERVAL };
