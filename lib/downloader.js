'use strict';
// Video downloader built on yt-dlp (YouTube and the many other sites it supports).
// Files land in a folder of a Movies-type library, with the thumbnail saved as the poster,
// English subtitles as a sidecar .srt and the video's details (description, date, channel,
// chapters) as a small "<name>.info.json", then the library is rescanned.
//
// - Nothing is downloaded twice: yt-dlp keeps a record (downloads-archive.txt in the data folder),
//   and a link already downloaded is refused unless "download again" is chosen.
// - An admin can limit downloads to certain hours (e.g. overnight) and cap the speed.
// - Failed downloads are retried automatically (unless the error can't be fixed by trying again),
//   and partly downloaded files are resumed instead of starting over.
// - yt-dlp updates itself once a day, as sites change often.

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomId } = require('./store');

const BIN = process.env.YTDLP_PATH || 'yt-dlp';
const MAX_JOBS = 100;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS = [60_000, 5 * 60_000]; // before the 2nd and 3rd attempt
// Errors that trying again won't fix.
const PERMANENT_ERROR = /HTTP Error (404|410)|private video|video unavailable|has been removed|no longer available|copyright|members?[- ]only|join this channel|sign in to confirm your age|age[- ]restricted|unsupported url|is not a valid url|not available in your country|account .*terminated|premieres in|live event will begin|nothing was downloaded/i;
// "youtube <id>" for YouTube links (the form yt-dlp's archive uses), so duplicates are caught when added.
function archiveKey(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' && u.pathname === '/watch') id = u.searchParams.get('v');
    else if (host === 'youtube.com') id = (/^\/(?:shorts|live|embed)\/([\w-]{11})/.exec(u.pathname) || [])[1];
    return id && /^[\w-]{11}$/.test(id) ? `youtube ${id}` : null;
  } catch { return null; }
}
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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
  constructor(store, { onFinished, dataDir } = {}) {
    this.store = store;
    this.onFinished = onFinished || (() => {});
    this.procs = new Map();
    this.archive = dataDir ? path.join(dataDir, 'downloads-archive.txt') : null;
    store.data.downloads ||= [];
    // Jobs that were running when the server stopped can't be resumed mid-process; requeue them.
    for (const j of store.data.downloads) if (j.status === 'running') Object.assign(j, { status: 'queued', progress: 0 });
    this.version = null;
    this.toolChecked = false; // until the first check finishes, queued downloads just wait
    this.checkTool().then(() => { this.toolChecked = true; this.pump(); });
    // Queued downloads wait for their time window or retry time; look again every half minute.
    setInterval(() => this.pump(), 30_000).unref();
  }

  // { windowStart, windowEnd ("HH:MM", both or neither), rateLimit (MB/s or null), autoUpdate }
  settings() {
    const s = this.store.data.settings?.downloads || {};
    return { windowStart: s.windowStart || null, windowEnd: s.windowEnd || null, rateLimit: s.rateLimit || null, autoUpdate: s.autoUpdate !== false };
  }

  updateSettings(input) {
    const cur = this.settings();
    const next = { ...cur };
    const time = (v) => {
      if (v === null || v === '') return null;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) throw httpError(400, 'Times look like 01:00');
      return String(v);
    };
    if (input.windowStart !== undefined) next.windowStart = time(input.windowStart);
    if (input.windowEnd !== undefined) next.windowEnd = time(input.windowEnd);
    if (!next.windowStart !== !next.windowEnd) throw httpError(400, 'Set both a start and an end time (or neither)');
    if (next.windowStart && next.windowStart === next.windowEnd) throw httpError(400, 'The start and end times must differ');
    if (input.rateLimit !== undefined) {
      const r = input.rateLimit === null || input.rateLimit === '' ? null : Number(input.rateLimit);
      if (r !== null && !(r > 0 && r <= 1000)) throw httpError(400, 'The speed limit is in MB/s, e.g. 2');
      next.rateLimit = r;
    }
    if (input.autoUpdate !== undefined) next.autoUpdate = !!input.autoUpdate;
    (this.store.data.settings ||= {}).downloads = next;
    this.store.save();
    this.pump();
    return next;
  }

  // Inside the allowed hours? (A window like 23:00–06:00 runs past midnight.)
  inWindow(now = new Date()) {
    const { windowStart: a, windowEnd: b } = this.settings();
    if (!a) return true;
    const t = hhmm(now);
    return a < b ? t >= a && t < b : t >= a || t < b;
  }

  archived() {
    try { return new Set(fs.readFileSync(this.archive, 'utf8').split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean)); } catch { return new Set(); }
  }

  // Update yt-dlp once a day (when enabled and nothing is downloading).
  startAutoUpdate() {
    const tick = async () => {
      const last = this.store.data.downloadTool?.at || 0;
      if (!this.settings().autoUpdate || !this.version || this.procs.size || Date.now() - last < 23 * 3600_000) return;
      const r = await this.selfUpdate();
      if (!r.ok) console.warn(`[downloads] yt-dlp self-update failed: ${r.output}`);
    };
    setTimeout(tick, 10 * 60_000).unref();
    setInterval(tick, 3600_000).unref();
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

  // `force` downloads again even if this video was downloaded before.
  add({ url, libraryId, folder = 'YouTube', quality = 'compatible', playlist = false, force = false }, user) {
    let parsed;
    try { parsed = new URL(String(url).trim()); } catch { throw httpError(400, 'Enter a valid video URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw httpError(400, 'Only http(s) links are supported');
    if (!QUALITIES[quality]) throw httpError(400, 'Unknown quality');
    const { dest } = this.destination(libraryId, folder);
    if (this.jobs.some((j) => j.url === parsed.href && ['queued', 'running'].includes(j.status))) {
      throw httpError(409, 'This link is already in the download queue');
    }
    if (!force && !playlist) {
      const key = archiveKey(parsed.href);
      const earlier = this.jobs.find((j) => j.url === parsed.href && j.status === 'done' && j.files.length);
      if ((key && this.archived().has(key)) || earlier) {
        throw Object.assign(httpError(409, `Already downloaded${earlier?.title ? `: “${earlier.title}”` : ''}. Choose “Download again” to get it anyway.`), { duplicate: true });
      }
    }
    const job = {
      id: randomId(), url: parsed.href, libraryId, folder: String(folder || ''), dest, quality, playlist: !!playlist, force: !!force,
      status: 'queued', progress: 0, speed: null, eta: null, title: null, files: [], skipped: 0, error: null,
      attempts: 0, retryAt: null, startNow: false,
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
      job.retryAt = null;
      const proc = this.procs.get(id);
      if (proc) proc.once('close', () => this.dropTemp(job)); else this.dropTemp(job);
      proc?.kill('SIGTERM');
      this.store.save();
    }
    return job;
  }

  remove(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw httpError(404, 'Download not found');
    if (job.status === 'running') throw httpError(400, 'Cancel the download first');
    this.dropTemp(job);
    this.store.data.downloads = this.jobs.filter((j) => j.id !== id);
    this.store.save();
  }

  retry(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw httpError(404, 'Download not found');
    if (!['failed', 'canceled'].includes(job.status)) throw httpError(400, 'Only failed or canceled downloads can be retried');
    // A manual retry starts now and gets a fresh set of automatic retries.
    Object.assign(job, { status: 'queued', progress: 0, error: null, finishedAt: null, files: [], skipped: 0, attempts: 0, retryAt: null, startNow: true });
    this.store.save();
    this.pump();
    return job;
  }

  // Start a download that is waiting for the download hours.
  startNow(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw httpError(404, 'Download not found');
    if (job.status !== 'queued') throw httpError(400, 'Only waiting downloads can be started');
    Object.assign(job, { startNow: true, retryAt: null });
    this.store.save();
    this.pump();
    return job;
  }

  tempDir(job) { return path.join(job.dest, '.marquee-tmp', job.id); }
  dropTemp(job) {
    fs.rm(this.tempDir(job), { recursive: true, force: true }, () => {
      fs.rmdir(path.join(job.dest, '.marquee-tmp'), () => {}); // removed only when empty
    });
  }

  pump() {
    if (!this.toolChecked) return;
    if (!this.version) {
      for (const j of this.jobs) if (j.status === 'queued') Object.assign(j, { status: 'failed', error: 'yt-dlp is not installed on the server', finishedAt: Date.now() });
      return;
    }
    const running = this.jobs.filter((j) => j.status === 'running').length;
    const now = Date.now();
    const open = this.inWindow();
    const next = this.jobs.filter((j) => j.status === 'queued' && (!j.retryAt || j.retryAt <= now) && (open || j.startNow)).reverse(); // oldest first
    for (const job of next.slice(0, Math.max(0, CONCURRENCY - running))) this.run(job);
  }

  run(job) {
    try { fs.mkdirSync(job.dest, { recursive: true }); } catch (err) {
      Object.assign(job, { status: 'failed', error: `Cannot write to ${job.dest}: ${err.code}`, finishedAt: Date.now() });
      this.store.save();
      return;
    }
    Object.assign(job, { status: 'running', progress: 0, error: null, retryAt: null, startedAt: Date.now(), attempts: (job.attempts || 0) + 1 });
    const { rateLimit } = this.settings();
    const name = '%(title).150B%(mq_year|)s [%(id)s]';
    const args = [
      '--ignore-config', '--newline', '--no-colors', '--no-simulate', '--progress', '--no-quiet',
      job.playlist ? '--yes-playlist' : '--no-playlist',
      '-f', QUALITIES[job.quality].format, '--merge-output-format', 'mp4',
      '--write-thumbnail', '--convert-thumbnails', 'jpg',
      '--write-subs', '--sub-langs', 'en.*,en', '--convert-subs', 'srt',
      '--windows-filenames', '--no-overwrites',
      // Partly downloaded files stay in this job's temp folder, so a retry continues where it stopped.
      '--continue', '--retries', '10', '--fragment-retries', '10', '--retry-sleep', 'exp=2:60',
      ...(rateLimit ? ['--limit-rate', `${rateLimit}M`] : []),
      // The download record: videos already in it are skipped (not when downloading again on purpose).
      ...(this.archive && !job.force ? ['--download-archive', this.archive] : []),
      '-P', job.dest, '-P', 'temp:' + this.tempDir(job),
      // Description, date, channel and chapters for Marquee's title page and player.
      '--print-to-file', 'after_move:%(.{id,title,description,upload_date,uploader,channel,webpage_url,duration,chapters})j', `${name}.info.json`,
      '--print', 'after_move:[mq-id] %(extractor_key)s %(id)s',
      // "Title (2024) [videoId].mp4" — the year and [id] are understood by Marquee's filename parser.
      // The " (2024)" part is built as its own field so it disappears cleanly when there is no upload date.
      '--parse-metadata', 'upload_date:(?P<mq_year>\\d{4})',
      '--replace-in-metadata', 'mq_year', '^(\\d{4})$', ' (\\1)',
      '-o', `${name}.%(ext)s`,
      '--progress-template', 'download:[mq-progress] %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
      '--print', 'before_dl:[mq-title] %(title)s',
      '--print', 'after_move:[mq-file] %(filepath)s',
      '--', job.url,
    ];
    const proc = spawn(BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.procs.set(job.id, proc);
    let lastError = '';
    let saveTimer = null;
    const ids = [];
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
      } else if ((m = /^\[mq-id\] (\S+) (\S+)$/.exec(line))) {
        ids.push(`${m[1].toLowerCase()} ${m[2]}`);
      } else if (/has already been recorded in the archive/.test(line)) {
        job.skipped = (job.skipped || 0) + 1;
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
      // Downloading again on purpose skips the record; add what was fetched to it now.
      if (this.archive && job.force && ids.length) {
        try { fs.appendFileSync(this.archive, ids.map((k) => `${k}\n`).join('')); } catch { /* best effort */ }
      }
      if (job.status !== 'canceled') {
        if (code === 0 && (job.files.length || job.skipped)) {
          // (Nothing new is fine when everything had been downloaded before.)
          Object.assign(job, { status: 'done', progress: 100, eta: null, speed: null, startNow: false });
          this.dropTemp(job);
        } else {
          const error = lastError || (code === 0 ? 'Nothing was downloaded' : `yt-dlp exited with code ${code}`);
          if (job.attempts < MAX_ATTEMPTS && !PERMANENT_ERROR.test(error)) {
            // Try again later; the partly downloaded file is kept and continued.
            const wait = RETRY_DELAYS[job.attempts - 1] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1];
            Object.assign(job, { status: 'queued', error, retryAt: Date.now() + wait, speed: null, eta: null });
            this.store.save();
            this.pump();
            return;
          }
          Object.assign(job, { status: 'failed', error });
        }
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
        const result = { ok: !err, output: `${stdout}${stderr}`.trim().split('\n').slice(-4).join('\n'), version: this.version };
        this.store.data.downloadTool = { at: Date.now(), ...result };
        this.store.save();
        resolve(result);
      });
    });
  }

  status() {
    return {
      available: !!this.version, version: this.version, qualities: Object.entries(QUALITIES).map(([id, q]) => ({ id, label: q.label })),
      settings: this.settings(), inWindow: this.inWindow(), lastToolUpdate: this.store.data.downloadTool || null,
    };
  }
}

module.exports = { Downloader, archiveKey, PERMANENT_ERROR };
