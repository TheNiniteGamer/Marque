'use strict';
// Adaptive streaming (HLS). Every video is described as a complete VOD playlist of fixed 4-second
// segments for each quality, so players know the full length and can seek anywhere. Segments are
// produced on demand: one ffmpeg job per playback session converts from the requested segment
// onward, is paused when it gets far ahead of the viewer, and is restarted when the viewer jumps.
//
// The "source" quality is the original picture, not converted (an MKV's H.264 video, for browsers
// that can't open MKV files): only the sound is. It can only be cut at the file's keyframes, so its
// segments start at keyframes about 4 s apart (see keyframes.js), and every job cuts at exactly
// the same places, wherever it starts.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { videoArgs } = require('./hwaccel');
const { NIGHT_FILTER } = require('./media');
const { darOf } = require('./picture');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const SEG = 4;                 // seconds per segment
// Conversion runs ahead of the player in short bursts: paused this many segments past what the
// player last asked for, resumed a little later. (Racing far ahead at full speed kept the CPU
// busy for nothing, e.g. mapping HDR colours that a graphics card can't.)
const AHEAD_PAUSE = 12;        // pause conversion this many segments ahead of the viewer…
const AHEAD_RESUME = 10;       // …and resume when they get within this many
const IDLE_MS = 90_000;        // drop sessions nobody has asked for anything in this long
// With every place taken, one this quiet makes way for a newcomer. (A player with a minute of
// video saved up can go about this long between asks, so a quieter one is paused or gone.)
const QUIET_MS = 60_000;
const MAX_SESSIONS = Number(process.env.HLS_MAX_SESSIONS) || 6;

// Highest first. Bitrates are for H.264 video; audio is AAC stereo 160 kb/s.
const QUALITIES = [
  { id: '1080p', height: 1080, bitrate: 8_000_000, label: '1080p · 8 Mbps' },
  { id: '720p', height: 720, bitrate: 4_000_000, label: '720p · 4 Mbps' },
  { id: '480p', height: 480, bitrate: 1_500_000, label: '480p · 1.5 Mbps' },
  { id: '360p', height: 360, bitrate: 750_000, label: '360p · 0.75 Mbps' },
];
const AUDIO_BITRATE = 160_000;

const httpError = (status, msg) => Object.assign(new Error(msg), { status });

// Qualities that make sense for this file: nothing above the source resolution (always at least one),
// and nothing above `maxHeight` (the admin's limit for viewers away from home).
function qualitiesFor(item, maxHeight = Infinity) {
  const h = item.media?.video?.height || 1080;
  const w = item.media?.video?.width || 1920;
  const effective = Math.max(h, Math.round((w * 9) / 16)); // ultra-wide films are short but still "1080p"
  const fit = QUALITIES.filter((q) => q.height <= effective * 1.05 && q.height <= maxHeight);
  return fit.length ? fit : [QUALITIES[QUALITIES.length - 1]];
}

function segmentCount(duration) { return Math.max(1, Math.ceil(duration / SEG - 1e-6)); }

/** Where each "source" segment starts: the first keyframe at least SEG after the previous one. */
function sourceStarts(keyframes, duration) {
  const starts = [0];
  for (const t of keyframes) if (t >= starts[starts.length - 1] + SEG && t < duration - 0.5) starts.push(t);
  return starts;
}
const sourceLength = (starts, i, duration) => (i + 1 < starts.length ? starts[i + 1] : duration) - starts[i];

/** Master playlist listing the qualities; `query` is appended to every URL (session id, token…). */
function masterPlaylist(item, { only = null, query = '', maxHeight } = {}) {
  const w = item.media?.video?.width || 1920;
  const h = item.media?.video?.height || 1080;
  if (only === 'source') {
    const bw = (item.media?.bitrate || 8_000_000) + AUDIO_BITRATE;
    return ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS',
      `#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(bw * 1.5)},AVERAGE-BANDWIDTH=${Math.round(bw)},RESOLUTION=${w}x${h},CODECS="avc1.640028,mp4a.40.2",NAME="source"`,
      `source/index.m3u8${query}`].join('\n') + '\n';
  }
  const list = qualitiesFor(item, maxHeight).filter((q) => !only || q.id === only);
  if (!list.length) throw httpError(404, 'Unknown quality');
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const q of list) {
    const height = Math.min(q.height, h);
    const width = Math.round((height * darOf(item.media?.video || { width: w, height: h })) / 2) * 2; // (at its real shape: DVDs)
    const bw = q.bitrate * 1.25 + AUDIO_BITRATE;
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(bw)},AVERAGE-BANDWIDTH=${q.bitrate + AUDIO_BITRATE},RESOLUTION=${width}x${height},CODECS="avc1.640028,mp4a.40.2",NAME="${q.id}"`);
    lines.push(`${q.id}/index.m3u8${query}`);
  }
  return lines.join('\n') + '\n';
}

/** Complete VOD playlist for one quality. */
function mediaPlaylist(item, quality, { query = '', maxHeight, keyframes = null } = {}) {
  if (quality === 'source') {
    const duration = item.media?.duration || 0;
    if (!keyframes || !duration) throw httpError(404, 'This video can\'t be streamed without converting it yet');
    const starts = sourceStarts(keyframes, duration);
    const lens = starts.map((_, i) => sourceLength(starts, i, duration));
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...lens))}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS'];
    lens.forEach((len, i) => lines.push(`#EXTINF:${len.toFixed(3)},`, `seg-${i}.ts${query}`));
    lines.push('#EXT-X-ENDLIST');
    return lines.join('\n') + '\n';
  }
  if (!qualitiesFor(item, maxHeight).some((q) => q.id === quality)) throw httpError(404, 'Unknown quality');
  const duration = item.media?.duration || 0;
  if (!duration) throw httpError(400, 'This file has no duration to stream');
  const n = segmentCount(duration);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEG}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (let i = 0; i < n; i++) {
    const len = Math.min(SEG, duration - i * SEG);
    lines.push(`#EXTINF:${len.toFixed(3)},`, `seg-${i}.ts${query}`);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

class HlsManager {
  constructor(tmpRoot, hwaccel) {
    this.root = tmpRoot;
    this.hwaccel = hwaccel;
    this.sessions = new Map();
    fs.rmSync(tmpRoot, { recursive: true, force: true }); // leftovers from a previous run
    fs.mkdirSync(tmpRoot, { recursive: true });
    this.timer = setInterval(() => this.sweep(), 5000);
    this.timer.unref();
    // Running jobs are checked often, so a fast one (a graphics card) doesn't overshoot by much.
    this.pacer = setInterval(() => { for (const s of this.sessions.values()) if (s.proc && !s.stopped) this.throttle(s); }, 1000);
    this.pacer.unref();
  }

  get active() { return [...this.sessions.values()].filter((s) => s.proc).length; }

  stopAll() { for (const s of this.sessions.values()) this.drop(s); }

  // Path of segment `n`, converting it first if needed.
  async segment(item, { quality, audio = 0, burn = null, night = false, sid, maxHeight, userId = null, keyframes = null }, n) {
    const source = quality === 'source';
    if (source && (!keyframes || burn != null)) throw httpError(404, 'Unknown quality');
    const q = source ? { id: 'source', starts: sourceStarts(keyframes, item.media?.duration || 0) } : qualitiesFor(item, maxHeight).find((x) => x.id === quality);
    if (!q) throw httpError(404, 'Unknown quality');
    const total = source ? q.starts.length : segmentCount(item.media?.duration || 0);
    if (!Number.isInteger(n) || n < 0 || n >= total) throw httpError(404, 'No such segment');
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(sid || '')) throw httpError(400, 'Missing playback session');

    const key = `${item.id}|${q.id}|${audio}|${burn ?? ''}|${night ? 'n' : ''}`;
    let s = this.sessions.get(sid);
    if (s && s.key !== key) { this.drop(s, true); s = null; }  // quality / audio change: start over
    if (!s) {
      if (this.full(userId, item.id)) this.makeRoom(userId, item.id);
      s = { sid, key, item, q, audio, burn, night, userId, copy: source, complete: new Map(), jobs: 0, dir: path.join(this.root, sid, `${q.id}-${audio}-${burn ?? 'n'}${night ? '-night' : ''}`), proc: null, start: -1, stopped: false, last: Date.now(), want: n, encoder: null };
      fs.mkdirSync(s.dir, { recursive: true });
      // Each new segment is a chance to pause the job (fast ones would overshoot between checks).
      try { s.watcher = fs.watch(s.dir, () => { if (s.proc && !s.stopped) this.throttle(s); }); s.watcher.on('error', () => {}); } catch { /* the 1 s check does */ }
      this.sessions.set(sid, s);
    }
    s.last = Date.now();
    s.want = n;
    if (this.ready(s, n)) { this.throttle(s); return this.fileOf(s, n); }
    const file = this.fileOf(s, n);

    // Is the running job going to produce it soon? Otherwise (a seek) restart from n. One it already
    // made but that was cleaned up since (the viewer went back more than a minute) needs a restart too.
    const produced = this.lastProduced(s);
    if (!s.proc || n < s.start || s.swept?.has(n) || n > Math.max(s.start, produced) + 3) this.startJob(s, n);
    this.throttle(s);
    return this.waitFor(s, file);
  }

  // A converted segment appears only when it's finished (ffmpeg writes it under another name first).
  // An uncut one is written in place, so it's finished once ffmpeg lists it; each job writes in its
  // own folder, so a job started again never rewrites a segment a player may be reading.
  ready(s, n) {
    if (!s.copy) return fs.existsSync(path.join(s.dir, `seg-${n}.ts`));
    if (s.complete.has(n)) return true;
    this.readList(s);
    return s.complete.has(n);
  }

  fileOf(s, n) { return s.copy ? s.complete.get(n) || path.join(s.jobDir || s.dir, `seg-${n}.ts`) : path.join(s.dir, `seg-${n}.ts`); }

  readList(s) {
    if (!s.jobDir) return;
    try {
      for (const l of fs.readFileSync(path.join(s.jobDir, 'list.csv'), 'utf8').split('\n')) {
        const m = /^seg-(\d+)\.ts,/.exec(l);
        const file = m && path.join(s.jobDir, `seg-${m[1]}.ts`);
        // (Not one cleaned up already: the list still names it.)
        if (m && !s.complete.has(Number(m[1])) && !s.sweptFiles?.has(file)) s.complete.set(Number(m[1]), file);
      }
    } catch { /* not started yet */ }
  }

  lastProduced(s) {
    if (s.copy) { this.readList(s); return s.complete.size ? Math.max(...s.complete.keys()) : -1; }
    let last = -1;
    try { for (const f of fs.readdirSync(s.dir)) { const m = /^seg-(\d+)\.ts$/.exec(f); if (m) last = Math.max(last, Number(m[1])); } } catch { /* gone */ }
    return last;
  }

  startJob(s, n, encoder = this.hwaccel.active) {
    if (s.proc) { s.killed = s.proc; s.proc.kill('SIGKILL'); }
    s.swept?.clear(); // (the new job makes them again from n; earlier ones are before its start)
    if (s.copy) return this.startCopyJob(s, n);
    const v = s.item.media?.video;
    const enc = videoArgs(encoder, { maxHeight: s.q.height, bitrate: Math.min(s.q.bitrate, Math.max(500_000, (s.item.media?.bitrate || Infinity) * 1.1)), keyframeEvery: SEG, burn: s.burn, video: s.item.media?.video });
    encoder = enc.kind; // (an NVIDIA card can't decode every video: then it only encodes)
    const offset = n * SEG;
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...enc.input];
    if (offset > 0) args.push('-ss', String(offset));
    args.push('-i', s.item.file, ...enc.map, '-map', `0:a:${s.audio}?`, '-sn', '-dn',
      ...enc.output,
      '-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', String(AUDIO_BITRATE), ...(s.night ? ['-af', NIGHT_FILTER] : []),
      // Keep the real timeline so segments from different jobs line up.
      '-output_ts_offset', String(offset), '-muxdelay', '0', '-max_muxing_queue_size', '2048',
      '-f', 'hls', '-hls_time', String(SEG), '-hls_list_size', '0', '-hls_segment_type', 'mpegts',
      '-start_number', String(n), '-hls_flags', 'temp_file+independent_segments',
      '-hls_segment_filename', path.join(s.dir, 'seg-%d.ts'), path.join(s.dir, 'job.m3u8'));
    if (!v) throw httpError(400, 'This file has no video');
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    const startedAt = Date.now();
    proc.on('close', (code, signal) => {
      if (s.proc === proc) s.proc = null;
      if (s.killed === proc || signal === 'SIGKILL') return;
      s.done = code === 0;
      if (code) {
        const msg = stderr.trim().split('\n').pop() || `exit ${code}`;
        // A graphics-card encoder that can't run: retry this stream on the CPU.
        if (encoder !== 'software' && Date.now() - startedAt < 20_000 && this.lastProduced(s) < n) {
          this.hwaccel.reportFailure(encoder, msg);
          this.startJob(s, n, this.hwaccel.fallback?.(encoder) || 'software');
          return;
        }
        s.error = msg;
        console.warn(`[hls] ${path.basename(s.item.file)} ${s.q.id}: ${msg}`);
      }
    });
    Object.assign(s, { proc, start: n, stopped: false, done: false, error: null, encoder });
  }

  // The original picture, cut at keyframes; only the sound is converted. ffmpeg compares the cut
  // times with the job's own clock (from where it started), and the output keeps the real timeline.
  startCopyJob(s, n) {
    const starts = s.q.starts;
    // Just past the segment's keyframe, so the seek lands on that keyframe and not the one before.
    const from = n > 0 ? starts[n] + 0.005 : 0;
    s.jobDir = path.join(s.dir, `job-${++s.jobs}`);
    fs.mkdirSync(s.jobDir, { recursive: true });
    const cuts = starts.slice(n + 1).map((t) => (t - from).toFixed(3));
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (from > 0) args.push('-ss', from.toFixed(3));
    args.push('-i', s.item.file, '-map', '0:v:0', '-map', `0:a:${s.audio}?`, '-sn', '-dn', '-c:v', 'copy',
      '-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', String(AUDIO_BITRATE), ...(s.night ? ['-af', NIGHT_FILTER] : []),
      ...(from > 0 ? ['-output_ts_offset', from.toFixed(3)] : []), '-muxdelay', '0', '-max_muxing_queue_size', '4096',
      '-f', 'segment', '-segment_format', 'mpegts', ...(cuts.length ? ['-segment_times', cuts.join(',')] : ['-segment_time', '999999']),
      '-segment_time_delta', '0.05', '-segment_start_number', String(n), '-reset_timestamps', '0',
      '-segment_list', path.join(s.jobDir, 'list.csv'), '-segment_list_type', 'csv', path.join(s.jobDir, 'seg-%d.ts'));
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    proc.on('close', (code, signal) => {
      if (s.proc === proc) s.proc = null;
      if (s.killed === proc || signal === 'SIGKILL') return;
      this.readList(s);
      s.done = code === 0;
      if (code) {
        s.error = stderr.trim().split('\n').pop() || `exit ${code}`;
        console.warn(`[hls] ${path.basename(s.item.file)} source: ${s.error}`);
      }
    });
    Object.assign(s, { proc, start: n, stopped: false, done: false, error: null, encoder: 'copy' });
  }

  // Pause the conversion when it's far ahead of the viewer (not available on Windows hosts).
  throttle(s) {
    if (!s.proc || process.platform === 'win32') return;
    const lead = this.leadOf(s);
    if (!s.stopped && lead > AHEAD_PAUSE) { s.proc.kill('SIGSTOP'); s.stopped = true; }
    else if (s.stopped && lead < AHEAD_RESUME) { s.proc.kill('SIGCONT'); s.stopped = false; }
  }

  // How many segments are ready in a row from the viewer's. (Not the furthest one made: after going
  // back, the old ones further on would get the new job paused before it made anything.)
  leadOf(s) {
    if (s.copy) this.readList(s);
    const has = (n) => (s.copy ? s.complete.has(n) : fs.existsSync(path.join(s.dir, `seg-${n}.ts`)));
    let k = 0;
    while (k <= AHEAD_PAUSE + 1 && has(s.want + k)) k++;
    return k - 1;
  }

  waitFor(s, file, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const n = Number(/seg-(\d+)\.ts$/.exec(file)[1]);
      const check = () => {
        if (this.ready(s, n)) return resolve(this.fileOf(s, n));
        if (s.error && !s.proc) return reject(httpError(500, `Conversion failed: ${s.error}`));
        if (!this.sessions.has(s.sid)) return reject(httpError(410, 'Playback session ended'));
        if (Date.now() - t0 > timeoutMs) return reject(httpError(504, 'The server is taking too long to convert this video'));
        if (s.stopped) this.throttle(s);
        setTimeout(check, 100);
      };
      check();
    });
  }

  sweep() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (now - s.last > IDLE_MS) { this.drop(s); continue; }
      this.throttle(s);
      // Old segments the viewer has passed are deleted to save disk space.
      try {
        if (s.copy) {
          for (const [n, f] of s.complete) {
            if (n < s.want - 15) { fs.rmSync(f, { force: true }); s.complete.delete(n); (s.sweptFiles ||= new Set()).add(f); (s.swept ||= new Set()).add(n); }
          }
        } else {
          for (const f of fs.readdirSync(s.dir)) {
            const m = /^seg-(\d+)\.ts$/.exec(f);
            if (m && Number(m[1]) < s.want - 15) { fs.rmSync(path.join(s.dir, f), { force: true }); (s.swept ||= new Set()).add(Number(m[1])); }
          }
        }
      } catch { /* gone */ }
    }
  }

  // Conversions for players that can't use HLS (one per request, see /transcode) share the places;
  // server.js counts those (others), leaving out the asker's own one of this title (a seek ends it).
  full(userId, itemId) { return this.sessions.size + (this.others?.(userId, itemId) || 0) >= MAX_SESSIONS; }

  // Full: the same person's earlier playback of this title (a reloaded page or player) gives up its
  // place, else the quietest session if nobody's been watching it for a while. Someone watching is
  // never stopped for a newcomer: the newcomer is told the server is busy instead.
  makeRoom(userId, itemId) {
    const all = [...this.sessions.values()].sort((a, b) => a.last - b.last);
    const victim = all.find((x) => userId && x.userId === userId && x.item.id === itemId)
      || all.find((x) => Date.now() - x.last > QUIET_MS);
    if (!victim) throw Object.assign(httpError(503, `The server is busy converting video for ${all.length} people right now. Try again in a little while, or pick Original quality if this device can play it.`), { busy: true });
    this.drop(victim);
  }

  // `replaced`: the same playback carries on in a new folder next to this one, which must survive
  // (removing the whole session folder in the background could delete it after it's made).
  drop(s, replaced = false) {
    s.watcher?.close();
    if (s.proc) { s.killed = s.proc; if (s.stopped) s.proc.kill('SIGCONT'); s.proc.kill('SIGKILL'); }
    this.sessions.delete(s.sid);
    fs.rm(replaced ? s.dir : path.join(this.root, s.sid), { recursive: true, force: true }, () => {});
  }

  end(sid) { const s = this.sessions.get(sid); if (s) this.drop(s); }

  status() {
    return [...this.sessions.values()].map((s) => ({ item: s.item.id, userId: s.userId, quality: s.q.id, encoder: s.encoder, running: !!s.proc, paused: s.stopped }));
  }
}

module.exports = { HlsManager, masterPlaylist, mediaPlaylist, qualitiesFor, sourceStarts, QUALITIES, SEG, MAX_SESSIONS };
