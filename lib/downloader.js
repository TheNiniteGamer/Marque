'use strict';
// Video downloader built on yt-dlp (YouTube and the many other sites it supports).
// Files land in a folder of a Movies-type library, with the thumbnail saved as the poster and
// English subtitles as a sidecar .srt, then the library is rescanned.

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomId } = require('./store');

const BIN = process.env.YTDLP_PATH || 'yt-dlp';
const MAX_JOBS = 100;
const CONCURRENCY = Math.max(1, Number(process.env.DOWNLOAD_CONCURRENCY) || 1);

// Prefer H.264 + AAC so downloads direct-play in every browser without transcoding.
const QUALITIES = {
  compatible: { label: 'Best compatible (H.264, up to 1080p)', format: 'bv*[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]/b[vcodec^=avc1][height<=1080]/bv*[height<=1080]+ba/b' },
  best: { label: 'Highest available quality', format: 'bv*+ba/b' },
  720: { label: '720p', format: 'bv*[vcodec^=avc1][height<=720]+ba[acodec^=mp4a]/b[height<=720]/bv*[height<=720]+ba/b' },
  480: { label: '480p (small files)', format: 'bv*[vcodec^=avc1][height<=480]+ba[acodec^=mp4a]/b[height<=480]/bv*[height<=480]+ba/b' },
};

const httpError = (status, msg) => Object.assign(new Error(msg), { status });

class Downloader {
  constructor(store, { onFinished } = {}) {
    this.store = store;
    this.onFinished = onFinished || (() => {});
    this.procs = new Map();
    store.data.downloads ||= [];
    // Jobs that were running when the server stopped can't be resumed mid-process; requeue them.
    for (const j of store.data.downloads) if (j.status === 'running') Object.assign(j, { status: 'queued', progress: 0 });
    this.version = null;
    this.checkTool().then(() => this.pump());
  }

  get jobs() { return this.store.data.downloads; }

  checkTool() {
    return new Promise((resolve) => execFile(BIN, ['--version'], { timeout: 15_000 }, (err, stdout) => {
      this.version = err ? null : stdout.trim();
      resolve(this.version);
    }));
  }

  // Resolve (and validate) the destination folder inside a Movies library.
  destination(libraryId, folder) {
    const library = this.store.library(libraryId);
    if (!library) throw httpError(400, 'Choose a library to save into');
    if (library.type !== 'movie') throw httpError(400, 'Downloads can only be saved to a Movies-type library');
    const root = path.resolve(library.paths[0]);
    const sub = String(folder ?? '').trim().replace(/^[\\/]+/, '');
    const dest = path.resolve(root, sub);
    if (dest !== root && !dest.startsWith(root + path.sep)) throw httpError(400, 'Folder must be inside the library');
    return { library, dest };
  }

  add({ url, libraryId, folder = 'YouTube', quality = 'compatible', playlist = false }, user) {
    let parsed;
    try { parsed = new URL(String(url).trim()); } catch { throw httpError(400, 'Enter a valid video URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw httpError(400, 'Only http(s) links are supported');
    if (!QUALITIES[quality]) throw httpError(400, 'Unknown quality');
    const { dest } = this.destination(libraryId, folder);
    const job = {
      id: randomId(), url: parsed.href, libraryId, folder: String(folder || ''), dest, quality, playlist: !!playlist,
      status: 'queued', progress: 0, speed: null, eta: null, title: null, files: [], error: null,
      userId: user.id, username: user.username, createdAt: Date.now(), finishedAt: null,
    };
    this.jobs.unshift(job);
    this.trim();
    this.store.save();
    this.pump();
    return job;
  }

  trim() {
    const finished = this.jobs.filter((j) => !['queued', 'running'].includes(j.status));
    while (this.jobs.length > MAX_JOBS && finished.length) {
      const old = finished.pop();
      this.store.data.downloads = this.jobs.filter((j) => j !== old);
    }
  }

  cancel(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw httpError(404, 'Download not found');
    if (job.status === 'queued' || job.status === 'running') {
      job.status = 'canceled';
      job.finishedAt = Date.now();
      this.procs.get(id)?.kill('SIGTERM');
      this.store.save();
    }
    return job;
  }

  remove(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw httpError(404, 'Download not found');
    if (job.status === 'running') throw httpError(400, 'Cancel the download first');
    this.store.data.downloads = this.jobs.filter((j) => j.id !== id);
    this.store.save();
  }

  retry(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw httpError(404, 'Download not found');
    if (!['failed', 'canceled'].includes(job.status)) throw httpError(400, 'Only failed or canceled downloads can be retried');
    Object.assign(job, { status: 'queued', progress: 0, error: null, finishedAt: null, files: [] });
    this.store.save();
    this.pump();
    return job;
  }

  pump() {
    if (!this.version) {
      for (const j of this.jobs) if (j.status === 'queued') Object.assign(j, { status: 'failed', error: 'yt-dlp is not installed on the server', finishedAt: Date.now() });
      return;
    }
    const running = this.jobs.filter((j) => j.status === 'running').length;
    const next = this.jobs.filter((j) => j.status === 'queued').reverse(); // oldest first
    for (const job of next.slice(0, Math.max(0, CONCURRENCY - running))) this.run(job);
  }

  run(job) {
    try { fs.mkdirSync(job.dest, { recursive: true }); } catch (err) {
      Object.assign(job, { status: 'failed', error: `Cannot write to ${job.dest}: ${err.code}`, finishedAt: Date.now() });
      this.store.save();
      return;
    }
    Object.assign(job, { status: 'running', progress: 0, error: null, startedAt: Date.now() });
    const args = [
      '--ignore-config', '--newline', '--no-colors', '--no-simulate', '--progress',
      job.playlist ? '--yes-playlist' : '--no-playlist',
      '-f', QUALITIES[job.quality].format, '--merge-output-format', 'mp4',
      '--write-thumbnail', '--convert-thumbnails', 'jpg',
      '--write-subs', '--sub-langs', 'en.*,en', '--convert-subs', 'srt',
      '--windows-filenames', '--no-overwrites', '--no-part',
      '-P', job.dest, '-P', 'temp:' + path.join(job.dest, '.marquee-tmp'),
      // "Title (2024) [videoId].mp4" — the year and [id] are understood by Marquee's filename parser.
      // The " (2024)" part is built as its own field so it disappears cleanly when there is no upload date.
      '--parse-metadata', 'upload_date:(?P<mq_year>\\d{4})',
      '--replace-in-metadata', 'mq_year', '^(\\d{4})$', ' (\\1)',
      '-o', '%(title).150B%(mq_year|)s [%(id)s].%(ext)s',
      '--progress-template', 'download:[mq-progress] %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
      '--print', 'before_dl:[mq-title] %(title)s',
      '--print', 'after_move:[mq-file] %(filepath)s',
      '--', job.url,
    ];
    const proc = spawn(BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.procs.set(job.id, proc);
    let lastError = '';
    let saveTimer = null;
    const touch = () => { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; this.store.save(); }, 2000); };
    const onLine = (line) => {
      line = line.trim();
      if (!line) return;
      let m;
      if ((m = /^\[mq-progress\]\s*([\d.]+)%?\|([^|]*)\|(.*)$/.exec(line))) {
        job.progress = Math.min(100, Number(m[1]) || 0);
        job.speed = m[2].trim() !== 'NA' && m[2].trim() !== 'Unknown B/s' ? m[2].trim() : null;
        job.eta = m[3].trim() !== 'NA' && m[3].trim() !== 'Unknown' ? m[3].trim() : null;
        touch();
      } else if ((m = /^\[mq-title\] (.*)$/.exec(line))) {
        job.current = m[1];
        if (!job.title) job.title = m[1];
        touch();
      } else if ((m = /^\[mq-file\] (.*)$/.exec(line))) {
        job.files.push(path.basename(m[1]));
        touch();
      } else if (/^ERROR:/.test(line)) {
        lastError = line.replace(/^ERROR:\s*/, '');
      }
    };
    const lines = (stream) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (d) => { buf += d; const parts = buf.split(/\r?\n|\r/); buf = parts.pop(); parts.forEach(onLine); });
      stream.on('end', () => onLine(buf));
    };
    lines(proc.stdout);
    lines(proc.stderr);
    proc.on('error', (err) => { lastError = err.message; });
    proc.on('close', (code) => {
      clearTimeout(saveTimer);
      this.procs.delete(job.id);
      fs.rm(path.join(job.dest, '.marquee-tmp'), { recursive: true, force: true }, () => {});
      if (job.status !== 'canceled') {
        if (code === 0 && job.files.length) Object.assign(job, { status: 'done', progress: 100, eta: null, speed: null });
        else Object.assign(job, { status: 'failed', error: lastError || (code === 0 ? 'Nothing was downloaded' : `yt-dlp exited with code ${code}`) });
        job.finishedAt = Date.now();
      }
      this.store.save();
      if (job.files.length) this.onFinished(job);
      this.pump();
    });
  }

  // Update yt-dlp in place (sites change often; an old yt-dlp is the #1 cause of failed downloads).
  selfUpdate() {
    return new Promise((resolve) => {
      execFile(BIN, ['-U'], { timeout: 120_000 }, async (err, stdout, stderr) => {
        await this.checkTool();
        resolve({ ok: !err, output: `${stdout}${stderr}`.trim().split('\n').slice(-4).join('\n'), version: this.version });
      });
    });
  }

  status() {
    return { available: !!this.version, version: this.version, qualities: Object.entries(QUALITIES).map(([id, q]) => ({ id, label: q.label })) };
  }
}

module.exports = { Downloader };
