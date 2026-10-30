'use strict';
// Overnight conversions: files most players can't play as they are (DVD rips, 4K, HEVC…) get a
// 1080p H.264 copy with AAC sound in an MP4, made at night on the graphics card. The copy is
// offered as another version of the title (library.js "~o"): the Shield with the OLED still plays
// the 4K original, while 1080p TVs, the Roku and browsers play the copy as it is instead of the
// server converting the original every time. The originals are never touched.
//
// Settings (store.data.settings.optimize): which kinds of files, the hours it may run, and how much
// space the copies may take, and where they're kept: Marquee's copies folder (OPTIMIZED_DIR), a
// ".marquee-converted" folder next to each original (hidden from the library scan, Radarr, Sonarr and
// Plex, which all skip folders starting with a dot), or a folder picked in Settings. While anyone is
// watching something, the conversion under way is paused (and none start); admins can also pause
// it, or stop for tonight (store.data.optimizeHold), from Settings or the Activity page. A conversion
// on the graphics card isn't just paused but ended cleanly, so the card's memory is free for the
// people watching; it carries on from there in another part, and the parts are joined at the end.
// item.optimized = { file, size, media, createdAt, sourceMtime } once made; item.optimizeFailed =
// { at, error } skips it for a week. store.data.optimizeDirs: the other folders copies were put in
// (for cleaning up and moving).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
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
const DEFAULTS = { enabled: false, kinds: { dvd: true, uhd: false, hevc: false, other: false }, start: '01:00', end: '07:00', maxGb: 200, place: 'default', folder: null };
const PLACES = ['default', 'beside', 'folder'];
const BESIDE = '.marquee-converted';
// The copies' file names, and their unfinished parts (nothing else in a folder is touched).
const NAME_RE = /^[\w-]+-\d+\.mp4(\.p\d+)?(\.tmp)?$/;
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
  // probe(file) -> media info (media.probe); isBusy() -> someone is watching. labelFor(path) and
  // fromHost(path): a folder's name on the PC and back (in Docker, "E:/Converted" <-> "/drives/1/Converted").
  constructor(store, dir, hwaccel, { probe, isBusy = () => false, label = null, labelFor = () => null, fromHost = () => null, now = () => new Date() } = {}) {
    this.store = store;
    this.dir = dir;
    this.labelFor = labelFor;
    this.fromHost = fromHost;
    this.moving = null; // { done, total, failed }
    this.hwaccel = hwaccel;
    this.probe = probe;
    this.isBusy = isBusy;
    this.label = label || dir;
    this.now = now;
    this.running = null; // { item, proc, encoder, tmp, parts, done, progress, paused, pausedAt, pausedMs, startedAt }
    this.runUntil = 0; // "Start now": run outside the hours until then
    fs.mkdirSync(dir, { recursive: true });
    // Unfinished ones are removed, except the parts of one stopped for a restart (resumable()).
    const keep = new Set((store.data.optimizeResume?.parts || []).map((f) => path.resolve(f)));
    for (const d of this.dirs()) {
      try {
        for (const f of fs.readdirSync(d)) if (NAME_RE.test(f) && f.endsWith('.tmp') && !keep.has(path.resolve(d, f))) fs.rmSync(path.join(d, f), { force: true });
      } catch { /* gone */ }
    }
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
    if (input.place !== undefined) {
      if (!PLACES.includes(input.place)) throw httpError(400, 'Unknown place');
      if (input.place === 'folder') s.folder = this.checkFolder(input.folder ?? s.folder);
      s.place = input.place;
    }
    (this.store.data.settings ||= {}).optimize = s;
    this.store.save();
    if (!s.enabled) this.stopRunning();
    return s;
  }

  // ---- where copies go ----
  /** A folder picked in Settings: it must exist, Marquee must be able to write there, and it can't be
   *  inside a library (the copies would turn up as films). */
  checkFolder(asked) {
    if (!asked) throw httpError(400, 'Pick a folder');
    let dir = path.resolve(String(asked));
    if (!fs.existsSync(dir)) dir = this.fromHost(String(asked)) || dir;
    let isDir = false;
    try { isDir = fs.statSync(dir).isDirectory(); } catch { /* missing */ }
    if (!isDir) throw httpError(400, 'That folder can’t be found on the server. In Docker, its drive must be shared (see Other drives in the README).');
    const inside = (a, b) => a === b || a.startsWith(b + path.sep);
    for (const l of this.store.data.libraries || []) {
      for (const p of l.paths || []) {
        if (inside(dir, path.resolve(p))) throw httpError(400, `That folder is inside the ${l.name} library, so the copies would show up there. Pick one outside your libraries, or “Next to the originals”.`);
      }
    }
    const probe = path.join(dir, `.marquee-write-test-${process.pid}`);
    try { fs.writeFileSync(probe, 'ok'); fs.rmSync(probe, { force: true }); } catch (err) {
      throw httpError(400, `Marquee can’t write to that folder (${err.code || err.message})${err.code === 'EROFS' ? '. In Docker, set DRIVES_ACCESS=rw in .env and run start-marquee.bat again.' : ''}`);
    }
    return dir;
  }

  /** Where this item's copy goes now; next to the original falls back to the copies folder when
   *  that folder is read-only. */
  dirFor(item) {
    const s = this.settings();
    if (s.place === 'folder' && s.folder) return s.folder;
    if (s.place === 'beside' && item.file) {
      const d = path.join(path.dirname(item.file), BESIDE);
      try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch { /* read-only */ }
    }
    return this.dir;
  }

  /** The copies folder and every other folder copies have been put in. */
  dirs() {
    const out = new Set([path.resolve(this.dir), ...(this.store.data.optimizeDirs || [])]);
    const s = this.settings();
    if (s.place === 'folder' && s.folder) out.add(path.resolve(s.folder));
    for (const it of Object.values(this.store.data.items)) if (it.optimized?.file) out.add(path.dirname(path.resolve(it.optimized.file)));
    return [...out];
  }

  remember(dir) {
    dir = path.resolve(dir);
    if (dir === path.resolve(this.dir)) return;
    const list = (this.store.data.optimizeDirs ||= []);
    if (!list.includes(dir)) list.push(dir);
  }

  placeLabel(s = this.settings()) {
    if (s.place === 'beside') return 'a “.marquee-converted” folder next to each original';
    if (s.place === 'folder' && s.folder) return this.labelFor(s.folder) || s.folder;
    return this.label;
  }

  /** Copies that aren't where they'd go now (after the place was changed). */
  elsewhere() {
    let count = 0, size = 0;
    for (const it of Object.values(this.store.data.items)) {
      if (!it.optimized?.file || this.wanted(it) === path.dirname(path.resolve(it.optimized.file))) continue;
      count++;
      size += it.optimized.size || 0;
    }
    return { count, size };
  }

  // Where a copy would go, without creating anything (for counting).
  wanted(item) {
    const s = this.settings();
    if (s.place === 'folder' && s.folder) return path.resolve(s.folder);
    if (s.place === 'beside' && item.file) {
      const d = path.join(path.dirname(path.resolve(item.file)), BESIDE);
      try { fs.accessSync(fs.existsSync(d) ? d : path.dirname(d), fs.constants.W_OK); return d; } catch { /* read-only */ }
    }
    return path.resolve(this.dir);
  }

  /** Moves the copies that aren't where they'd go now, one by one, in the background. */
  moveAll() {
    if (this.moving) throw httpError(409, 'Already moving the copies');
    this.stopRunning();
    const items = Object.values(this.store.data.items).filter((it) => it.optimized?.file && this.wanted(it) !== path.dirname(path.resolve(it.optimized.file)));
    const job = { done: 0, total: items.length, failed: 0, error: null };
    this.moving = job;
    const moveOne = async (it) => {
      const from = it.optimized.file;
      const dir = this.dirFor(it);
      const to = path.join(dir, path.basename(from));
      if (path.resolve(to) === path.resolve(from)) return;
      try { await fs.promises.rename(from, to); } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        // Another drive: copied, then the old one removed.
        const tmp = `${to}.tmp`;
        try { await fs.promises.copyFile(from, tmp); await fs.promises.rename(tmp, to); } catch (e) { await fs.promises.rm(tmp, { force: true }); throw e; }
        if (this.store.data.items[it.id] !== it || it.optimized?.file !== from) { await fs.promises.rm(to, { force: true }); return; }
        await fs.promises.rm(from, { force: true });
      }
      if (this.store.data.items[it.id] === it && it.optimized?.file === from) { it.optimized.file = to; this.remember(dir); this.store.save(); }
    };
    (async () => {
      for (const it of items) {
        try { if (it.optimized?.file) await moveOne(it); } catch (err) {
          job.failed++;
          job.error = err.code || err.message;
          console.warn(`[optimize] couldn't move ${path.basename(it.optimized?.file || '')}: ${job.error}`);
        }
        job.done++;
      }
      this.store.data.optimizeMoved = { at: Date.now(), moved: job.done - job.failed, failed: job.failed, error: job.error };
      this.store.save();
      this.moving = null;
      try { this.cleanup(); } catch { /* next time */ }
      setImmediate(() => this.tick());
    })();
    return job;
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
    for (const f of this.running ? [this.running.tmp, ...this.running.parts] : []) { try { n += fs.statSync(f).size; } catch { /* not started */ } }
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
    const hold = this.hold();
    let state = 'off';
    if (s.enabled) {
      state = hold ? (hold.kind === 'pause' ? 'held' : 'tonight') : r ? (r.paused ? 'paused' : 'converting') : this.moving ? 'moving'
        : !queue ? 'done' : this.used() >= s.maxGb * 1e9 ? 'full' : !this.inHours() ? 'waiting' : this.isBusy() ? 'paused' : 'starting';
    }
    return {
      settings: s, kinds: KINDS, state, folder: this.placeLabel(s), defaultFolder: this.label, used: this.used(), counts: this.counts(), queue,
      free: freeSpace(s.place === 'folder' && s.folder ? s.folder : s.place === 'beside' ? null : this.dir),
      folderLabel: s.folder ? this.labelFor(s.folder) || s.folder : null,
      elsewhere: this.elsewhere(), moving: this.moving ? { ...this.moving } : null, moved: this.store.data.optimizeMoved || null,
      running: r ? { id: r.item.id, title: titleOf(this.store, r.item), progress: Math.round(r.progress * 1000) / 1000, secondsLeft: secondsLeft(r), paused: r.paused, startedAt: r.startedAt } : null,
      hold,
      runUntil: this.runUntil > Date.now() ? this.runUntil : null,
      last: this.store.data.optimizeLast || null,
    };
  }

  // Pausing stops the ffmpeg process where it is (it carries on from there). On the graphics card,
  // where a stopped process would keep holding the card's memory, ffmpeg is ended cleanly instead:
  // what's done is kept as a part, and carrying on starts the next part from there. The time
  // paused isn't counted in the time left.
  setPaused(job, want) {
    if (want === job.paused || process.platform === 'win32') return;
    if (this.freesCard(job.encoder)) {
      if (want) {
        if (!job.proc) return;
        job.suspending = true;
        try { job.proc.kill('SIGINT'); } catch { return; }
      } else if (job.proc) {
        return; // still ending the last part: carries on at the next tick
      }
    } else {
      try { job.proc.kill(want ? 'SIGSTOP' : 'SIGCONT'); } catch { return; }
    }
    job.paused = want;
    if (want) job.pausedAt = Date.now();
    else {
      job.pausedMs += Date.now() - job.pausedAt;
      job.pausedAt = null;
      if (!job.proc) this.run(job.item, job.encoder, job);
    }
  }

  /** Whether a conversion with this encoder is ended (not just stopped) on a pause: the graphics cards'. */
  freesCard(encoder) { return !['software', 'copy'].includes(encoder); }

  // ---- admins: pause, carry on, stop for tonight ----
  /** The hold an admin put on conversions, if it still applies: { kind: 'pause' | 'tonight', at, until, by }. */
  hold() {
    const h = this.store.data.optimizeHold;
    if (!h) return null;
    if (h.kind === 'tonight' && this.now().getTime() >= h.until) { delete this.store.data.optimizeHold; return null; }
    return h;
  }

  /** Pause (the conversion under way waits where it is) until resumed. */
  pause(by = null) {
    this.store.data.optimizeHold = { kind: 'pause', at: Date.now(), by };
    this.runUntil = 0;
    this.store.save();
    this.tick();
  }

  /** Stop the conversion under way (its partial copy is thrown away) and make no more until the next night. */
  stopForTonight(by = null, now = this.now()) {
    const { end } = this.settings();
    const until = new Date(now);
    until.setHours(Number(end.slice(0, 2)), Number(end.slice(3)), 0, 0);
    if (until <= now) until.setDate(until.getDate() + 1);
    this.store.data.optimizeHold = { kind: 'tonight', at: Date.now(), until: until.getTime(), by };
    this.runUntil = 0;
    this.store.save();
    this.stopRunning();
  }

  resume() {
    delete this.store.data.optimizeHold;
    this.store.save();
    this.tick();
  }

  /** "Start now": run outside the set hours for the next `hours`. */
  startNow(hours = 6) {
    delete this.store.data.optimizeHold;
    this.runUntil = Date.now() + hours * 3600_000;
    this.tick();
  }

  // ---- running ----
  /** Every minute: start the next conversion when it's time; pause / resume around viewers. */
  tick() {
    const s = this.settings();
    const r = this.running;
    const hold = this.hold();
    if (this.closing) return;
    if (r) this.setPaused(r, this.isBusy() || hold?.kind === 'pause');
    if (r || hold || this.moving || !s.enabled || !this.inHours() || this.isBusy()) return;
    const again = this.resumable();
    if (again) { // (first: it's partly done)
      delete this.store.data.optimizeResume;
      this.run(again.item, undefined, { item: again.item, parts: again.parts, done: again.done, progress: 0, paused: false, pausedAt: null, pausedMs: 0, startedAt: Date.now() });
      return;
    }
    if (this.used() >= s.maxGb * 1e9) return;
    // (Not one whose drive is missing: it would fail at once, and quick failures make Marquee stop
    // using the graphics card for everyone.)
    const next = this.candidates().find((it) => fs.existsSync(it.file));
    if (next) this.run(next);
  }

  // `job`: carrying on with a conversion that was paused (or moved to another encoder) partway.
  run(item, encoder = this.hwaccel?.active || 'software', job = null) {
    const name = `${item.id}-${Math.round(item.mtime || 0)}.mp4`;
    const dir = this.dirFor(item);
    const out = path.join(dir, name);
    this.remember(dir); // (so an emptied folder next to the original is cleaned up if this fails)
    const tmp = `${out}.tmp`;
    const v = item.media.video;
    // A picture the TVs can already play (only the sound or the file type was the trouble) is copied.
    const copy = canCopyVideo(v) && height(v) <= 1100;
    const enc = copy ? { input: [], map: ['-map', '0:v:0'], output: ['-c:v', 'copy'], kind: 'copy' } : videoArgs(encoder, { maxHeight: 1080, video: v });
    encoder = enc.kind;
    // Every sound track, as stereo AAC; text subtitles go along (picture ones stay with the original).
    const audio = (item.media.audio || []).map((a, i) => ['-map', `0:a:${i}`]).flat();
    const subs = (item.media.subtitles || []).filter((s) => s.text).map((s) => ['-map', `0:s:${s.index}`]).flat();
    const from = job?.done || 0; // seconds already converted, in the earlier parts
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...enc.input, ...(from ? ['-ss', from.toFixed(3)] : []), '-i', item.file, ...enc.map, ...audio, ...subs, '-dn',
      ...enc.output, '-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', String(AUDIO_BITRATE), ...(subs.length ? ['-c:s', 'mov_text'] : []),
      '-map_metadata', '0', '-movflags', '+faststart', '-max_muxing_queue_size', '4096', '-progress', 'pipe:1', '-f', 'mp4', tmp];
    const proc = lowPriority(spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] }));
    job ||= { item, tmp, parts: [], done: 0, progress: 0, paused: false, pausedAt: null, pausedMs: 0, startedAt: Date.now() };
    Object.assign(job, { proc, encoder, tmp, partTime: 0, partStartedAt: Date.now() });
    this.running = job;
    const duration = item.media.duration || 0;
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    proc.stdout.on('data', (d) => {
      const m = /out_time_us=(\d+)/.exec(String(d).split('\n').filter((l) => l.startsWith('out_time_us=')).pop() || '');
      if (m) job.partTime = Number(m[1]) / 1e6;
      if (m && duration > 0) job.progress = Math.min(0.99, (from + job.partTime) / duration);
    });
    proc.on('close', async (code) => {
      job.proc = null;
      if (job.stopped) { this.running = null; for (const f of [tmp, ...job.parts]) fs.rmSync(f, { force: true }); return; }
      if (job.suspending) {
        // Paused on the graphics card: keep what's done as a part, and carry on from there later.
        job.suspending = false;
        let size = 0;
        try { size = fs.statSync(tmp).size; } catch { /* nothing written */ }
        if (job.partTime > 1 && size > 0) {
          const part = `${out}.p${job.parts.length + 1}.tmp`;
          fs.renameSync(tmp, part);
          job.parts.push(part);
          job.done += job.partTime;
        } else {
          fs.rmSync(tmp, { force: true });
        }
        setImmediate(() => this.tick());
        return;
      }
      this.running = null;
      if (code === 0) {
        try {
          if (job.parts.length) await join([...job.parts, tmp], out);
          else fs.renameSync(tmp, out);
          const media = await this.probe(out);
          // ffmpeg can finish "successfully" after a read error partway: a copy that's much shorter
          // than the original, or missing a sound track, would replace it on the TVs.
          const want = item.media.duration || 0, got = media?.duration || 0;
          if (want > 60 && !(got >= want * 0.9 - 10)) throw new Error(`the copy is ${Math.round(got / 60)} minutes long, the original ${Math.round(want / 60)}`);
          if ((media?.audio?.length || 0) < (item.media.audio || []).length) throw new Error('the copy is missing a sound track');
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
        for (const f of [tmp, ...job.parts]) fs.rmSync(f, { force: true });
      } else {
        fs.rmSync(tmp, { force: true });
        const msg = stderr.trim().split('\n').pop() || `exit ${code}`;
        // (Not the graphics card's fault if the original went: its drive was unplugged.)
        if (encoder !== 'software' && encoder !== 'copy' && Date.now() - job.partStartedAt < 20_000 && this.hwaccel && fs.existsSync(item.file)) {
          // A graphics-card encoder that can't run this one: the CPU does it (from where it got to).
          this.hwaccel.reportFailure?.(encoder, msg);
          this.run(item, this.hwaccel.fallback?.(encoder) || 'software', job);
          return;
        }
        for (const f of job.parts) fs.rmSync(f, { force: true });
        // An original that went (its drive unplugged) is simply tried again another night.
        if (fs.existsSync(item.file)) this.failed(item, msg);
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

  /**
   * Marquee is stopping (an update, a restart): the conversion under way ends cleanly, what's done
   * is kept as a part, and it carries on from there once Marquee is back (resumable()). Resolves
   * when that's saved, or after `timeoutMs`.
   */
  suspendForRestart(timeoutMs = 20_000) {
    this.closing = true;
    const job = this.running;
    const save = () => {
      if (job?.parts.length) this.store.data.optimizeResume = { itemId: job.item.id, mtime: job.item.mtime || 0, parts: job.parts, done: job.done, at: Date.now() };
    };
    // (Windows can't end ffmpeg cleanly from here: what's done there is lost, as before.)
    if (!job?.proc || process.platform === 'win32') { save(); return Promise.resolve(); }
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      job.proc.once('close', () => setImmediate(() => { clearTimeout(timer); save(); resolve(); }));
      job.suspending = true;
      try { job.proc.kill('SIGCONT'); job.proc.kill('SIGINT'); } catch { clearTimeout(timer); resolve(); }
    });
  }

  /** The conversion stopped for a restart, if it can carry on: { item, parts, done }. */
  resumable() {
    const r = this.store.data.optimizeResume;
    if (!r) return null;
    const item = this.store.data.items[r.itemId];
    if (item && (item.mtime || 0) === r.mtime && !item.optimized && Date.now() - r.at < 3 * 86400_000
      && fs.existsSync(item.file) && r.parts?.length && r.parts.every((f) => fs.existsSync(f))) return { item, parts: r.parts, done: r.done };
    for (const f of r.parts || []) fs.rmSync(f, { force: true });
    delete this.store.data.optimizeResume;
    this.store.save();
    return null;
  }

  stopRunning() {
    const r = this.running;
    if (!r) return;
    if (!r.proc) { this.running = null; for (const f of r.parts) fs.rmSync(f, { force: true }); return; } // paused between parts
    r.stopped = true;
    r.proc.kill('SIGKILL');
  }

  /** Copies whose original changed or went away are removed, and so are stray copies (only files
   *  named like copies: a folder picked in Settings may hold other things). */
  cleanup() {
    const keep = new Set();
    let changed = false;
    for (const it of Object.values(this.store.data.items)) {
      if (!it.optimized) continue;
      // A copy is forgotten when its original changed, or when its folder is there but it isn't (with
      // the folder's whole drive missing, it's kept for when the drive is back).
      const lost = !fs.existsSync(it.optimized.file) && fs.existsSync(path.dirname(it.optimized.file));
      if (Math.round(it.optimized.sourceMtime) !== Math.round(it.mtime || 0) || lost) { delete it.optimized; changed = true; continue; }
      keep.add(path.resolve(it.optimized.file));
    }
    let removed = 0;
    const still = [];
    for (const dir of this.dirs()) {
      let files;
      try { files = fs.readdirSync(dir); } catch { continue; } // gone (a drive unplugged: kept in the list)
      for (const f of files) {
        const p = path.resolve(dir, f);
        const running = this.running && [this.running.tmp, ...this.running.parts].some((x) => path.resolve(x) === p);
        if (!NAME_RE.test(f) || keep.has(p) || running) continue;
        if (this.moving && f.endsWith('.tmp')) continue;
        fs.rmSync(p, { force: true });
        removed++;
      }
      // An emptied ".marquee-converted" folder goes too.
      if (path.basename(dir) === BESIDE && !(this.running && path.dirname(path.resolve(this.running.tmp)) === dir)) { try { fs.rmdirSync(dir); continue; } catch { /* not empty */ } }
      still.push(dir);
    }
    const before = this.store.data.optimizeDirs || [];
    const after = before.filter((d) => still.includes(d) || !fs.existsSync(path.dirname(d)));
    if (after.length !== before.length) { this.store.data.optimizeDirs = after; changed = true; }
    if (changed) this.store.save();
    return removed;
  }

  /** Remove every copy (they're made again if conversions stay on). */
  removeAll() {
    if (this.moving) throw httpError(409, 'Wait until the copies have been moved');
    this.stopRunning();
    for (const it of Object.values(this.store.data.items)) delete it.optimized;
    this.store.save();
    return this.cleanup();
  }

  start() {
    try { this.cleanup(); } catch { /* next time */ }
    // (Often, so a conversion pauses within seconds of someone pressing play.)
    setInterval(() => { try { this.tick(); } catch (err) { console.warn(`[optimize] ${err.message}`); } }, 10_000).unref();
    setInterval(() => { try { this.cleanup(); } catch { /* next time */ } }, 6 * 3600_000).unref();
  }

  stop() { this.stopRunning(); }
}

// Time left from how fast it's gone so far, not counting time spent paused (null until there's enough to go on).
function secondsLeft(job, now = Date.now()) {
  if (!(job.progress >= 0.02)) return null;
  const active = now - job.startedAt - job.pausedMs - (job.paused && job.pausedAt ? now - job.pausedAt : 0);
  return Math.max(0, Math.round((active / 1000) * (1 - job.progress) / job.progress));
}

// Join a conversion's parts into the copy, without converting them again.
function join(parts, out) {
  const list = path.join(os.tmpdir(), `marquee-join-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(list, parts.map((f) => `file '${path.resolve(f).replace(/'/g, "'\\''")}'`).join('\n'));
  const tmp = `${out}.p0.tmp`;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', list,
    '-map', '0', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', tmp];
  return new Promise((resolve, reject) => {
    let stderr = '';
    const proc = lowPriority(spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] }));
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    proc.on('close', (code) => {
      fs.rmSync(list, { force: true });
      if (code === 0) { fs.renameSync(tmp, out); resolve(); return; }
      fs.rmSync(tmp, { force: true });
      reject(new Error(`couldn't join the parts: ${stderr.trim().split('\n').pop() || `exit ${code}`}`));
    });
  });
}

function freeSpace(dir) {
  if (!dir || !fs.statfsSync) return null;
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return null; }
}

function titleOf(store, it) {
  if (it.type === 'episode') {
    const show = store.data.shows[it.showId];
    const name = show?.edits?.title || show?.meta?.title || show?.title || it.showTitle || '';
    return `${name} S${pad(it.season ?? 0)}E${pad(it.episode ?? 0)}`;
  }
  return it.edits?.title || it.meta?.title || it.title;
}

module.exports = { Optimizer, kindOf, KINDS, secondsLeft };
