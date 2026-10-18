'use strict';
// Backups of everything that can't be rebuilt by rescanning: users and passwords, watch history,
// My List, libraries, edits, custom artwork, downloaded metadata images and settings.
// Sign-in sessions are left out on purpose. Files are standard .tar.gz archives.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createTarGz, extractTarGz } = require('./tar');

const FORMAT = 1;
const NAME_RE = /^marquee-backup-(\d{4}-\d{2}-\d{2})_(\d{6})-(auto|manual|pre-restore)\.tar\.gz$/;
const KEEP_PRE_RESTORE = 3;
const httpError = (status, msg) => Object.assign(new Error(msg), { status });

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

function walk(dir, base = dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else if (e.isFile() && !e.name.endsWith('.tmp')) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

// Replace a path prefix everywhere in the data (backups made under a different data folder,
// e.g. a plain Windows install restored into Docker).
function remapPaths(value, from, to) {
  if (!from || from === to) return value;
  if (typeof value === 'string') return value === from || value.startsWith(from + '/') || value.startsWith(from + '\\') ? to + value.slice(from.length).replace(/\\/g, '/') : value;
  if (Array.isArray(value)) return value.map((v) => remapPaths(v, from, to));
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) value[k] = remapPaths(value[k], from, to);
  }
  return value;
}

class Backups {
  constructor(store, { dataDir, dir, label, isBusy = () => false, onRestored = () => {} }) {
    this.store = store;
    this.dataDir = dataDir;
    this.imagesDir = path.join(dataDir, 'images');
    // Folders copied into backups as they are: artwork, and subtitles downloaded from OpenSubtitles.
    this.folders = [['images', this.imagesDir], ['subs-downloaded', path.join(dataDir, 'subs-downloaded')]];
    this.dir = dir;
    this.label = label || dir;
    this.isBusy = isBusy;
    this.onRestored = onRestored;
    this.running = null;
  }

  settings() {
    const st = this.store.data.settings || {};
    return { auto: st.backupAuto !== false, time: st.backupTime || '03:00', keep: st.backupKeep || 7 };
  }

  update({ auto, time, keep } = {}) {
    const st = (this.store.data.settings ||= {});
    if (auto !== undefined) st.backupAuto = !!auto;
    if (time !== undefined) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw httpError(400, 'Time must look like 03:00');
      st.backupTime = time;
    }
    if (keep !== undefined) {
      const k = Number(keep);
      if (!Number.isInteger(k) || k < 1 || k > 365) throw httpError(400, 'Keep between 1 and 365 backups');
      st.backupKeep = k;
    }
    this.store.save();
    return this.settings();
  }

  list() {
    let files = [];
    try { files = fs.readdirSync(this.dir); } catch { return []; }
    return files.map((name) => {
      const m = NAME_RE.exec(name);
      if (!m) return null;
      let st;
      try { st = fs.statSync(path.join(this.dir, name)); } catch { return null; }
      return { name, kind: m[3], size: st.size, createdAt: st.mtimeMs };
    }).filter(Boolean).sort((a, b) => b.name.localeCompare(a.name));
  }

  file(name) {
    if (!NAME_RE.test(name || '')) throw httpError(404, 'Backup not found');
    const f = path.join(this.dir, name);
    if (!fs.existsSync(f)) throw httpError(404, 'Backup not found');
    return f;
  }

  // The archive contents, as a .tar.gz stream.
  stream() {
    const data = { ...this.store.data, sessions: {} };
    const counts = {
      users: data.users?.length || 0, libraries: data.libraries?.length || 0,
      items: Object.keys(data.items || {}).length, shows: Object.keys(data.shows || {}).length,
    };
    const manifest = {
      format: FORMAT, app: 'Marquee', version: require('../package.json').version,
      createdAt: new Date().toISOString(), imagesDir: this.imagesDir, counts,
    };
    return createTarGz([
      { name: 'marquee-backup.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
      { name: 'db.json', data: Buffer.from(JSON.stringify(data)) },
      ...this.folders.flatMap(([name, dir]) => walk(dir).map((rel) => ({ name: `${name}/${rel}`, file: path.join(dir, rel) }))),
    ]);
  }

  async create(kind = 'manual') {
    if (this.running) await this.running.catch(() => {});
    this.running = (async () => {
      fs.mkdirSync(this.dir, { recursive: true });
      let name = `marquee-backup-${stamp(new Date())}-${kind}.tar.gz`;
      // Two backups in the same second: nudge the name.
      for (let i = 1; fs.existsSync(path.join(this.dir, name)); i++) name = `marquee-backup-${stamp(new Date(Date.now() + i * 1000))}-${kind}.tar.gz`;
      const final = path.join(this.dir, name);
      const tmp = `${final}.partial`;
      try {
        await new Promise((resolve, reject) => {
          const out = fs.createWriteStream(tmp);
          const src = this.stream();
          src.on('error', reject);
          out.on('error', reject);
          out.on('finish', resolve);
          src.pipe(out);
        });
        fs.renameSync(tmp, final);
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw httpError(500, `Could not write the backup to ${this.label}: ${err.code || err.message}`);
      }
      this.prune();
      return this.list().find((b) => b.name === name);
    })();
    try { return await this.running; } finally { this.running = null; }
  }

  // Automatic backups keep the newest N; safety copies made before a restore keep the newest 3.
  // Backups you made yourself are never deleted automatically.
  prune() {
    const all = this.list();
    const drop = [
      ...all.filter((b) => b.kind === 'auto').slice(this.settings().keep),
      ...all.filter((b) => b.kind === 'pre-restore').slice(KEEP_PRE_RESTORE),
    ];
    for (const b of drop) fs.rmSync(path.join(this.dir, b.name), { force: true });
  }

  remove(name) { fs.rmSync(this.file(name), { force: true }); }

  // Restore from a .tar.gz stream. Whoever is signed in stays signed in if their account
  // (same id) exists in the backup.
  async restore(input, { safetyCopy = true } = {}) {
    if (this.isBusy()) throw httpError(409, 'A library scan is running. Try again when it has finished.');
    const tmp = path.join(this.dataDir, `.restore-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(tmp, { recursive: true });
    try {
      try { await extractTarGz(input, tmp); } catch (err) { throw httpError(400, err.message); }
      let manifest, data;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'marquee-backup.json'), 'utf8'));
        data = JSON.parse(fs.readFileSync(path.join(tmp, 'db.json'), 'utf8'));
      } catch { throw httpError(400, 'This is not a Marquee backup (it is missing marquee-backup.json or db.json)'); }
      if (manifest.app !== 'Marquee' || manifest.format !== FORMAT) throw httpError(400, 'This backup was made by an incompatible version of Marquee');
      if (!Array.isArray(data.users) || !data.users.length || !Array.isArray(data.libraries)) throw httpError(400, 'This backup has no user accounts in it');

      // Safety copy of the current state first, so a restore can always be undone.
      const safety = safetyCopy ? await this.create('pre-restore') : null;

      remapPaths(data, manifest.imagesDir, this.imagesDir);
      // Keep current sign-ins for accounts that still exist (matched by id).
      const ids = new Set(data.users.map((u) => u.id));
      const sessions = Object.fromEntries(Object.entries(this.store.data.sessions || {}).filter(([, s]) => ids.has(s.userId)));
      for (const k of Object.keys(this.store.data)) delete this.store.data[k];
      Object.assign(this.store.data, { items: {}, shows: {}, progress: {}, libraries: [], users: [], settings: {} }, data, { sessions });

      // Artwork and downloaded subtitles: replace the folders with the backup's.
      for (const [name, dir] of this.folders) {
        const old = `${dir}.old-${Date.now()}`;
        if (fs.existsSync(dir)) fs.renameSync(dir, old);
        if (fs.existsSync(path.join(tmp, name))) fs.renameSync(path.join(tmp, name), dir);
        else fs.mkdirSync(dir, { recursive: true });
        fs.rmSync(old, { recursive: true, force: true });
      }

      this.store.flush();
      this.onRestored();
      return { restoredFrom: manifest.createdAt, counts: manifest.counts, safetyBackup: safety?.name || null };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // Runs the daily automatic backup at the configured local time (uses the TZ setting).
  // Makes today's automatic backup if it's due (also catches up if the PC was off at that time).
  // Returns the backup promise, or null when nothing is due.
  runIfDue(now = new Date()) {
    const s = this.settings();
    if (!s.auto || this.running) return null;
    const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    if (hhmm < s.time || this.store.data.lastAutoBackup === now.toDateString()) return null;
    this.store.data.lastAutoBackup = now.toDateString(); // claim today's slot even if the backup fails
    return this.create('auto');
  }

  startSchedule() {
    const tick = () => {
      const p = this.runIfDue();
      if (p) p.then((b) => console.log(`[backup] saved ${b?.name}`)).catch((err) => console.warn(`[backup] ${err.message}`));
    };
    setTimeout(tick, 60_000).unref();
    setInterval(tick, 60_000).unref();
  }

  status() {
    return { settings: this.settings(), dir: this.dir, dirLabel: this.label, lastAuto: this.store.data.lastAutoBackup || null, backups: this.list() };
  }
}

module.exports = { Backups, remapPaths, NAME_RE };
