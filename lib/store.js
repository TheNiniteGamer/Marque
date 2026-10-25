'use strict';
// Tiny JSON-file database. Everything lives in memory and is written to disk shortly after changes.
//
// Saving is crash-safe: the new data goes to db.json.tmp and is forced onto the disk, the previous
// db.json is renamed to db.json.bak, and then the new file takes its place. If db.json is ever missing or
// unreadable or damaged (e.g. after a power cut), the newest usable of db.json.tmp / db.json.bak is
// used. If none can be, `lost` is set so the server can restore the latest backup instead of
// starting empty, and, if that fails too, wait for an admin rather than start again (see `held`).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EMPTY = () => ({ version: 1, libraries: [], items: {}, shows: {}, progress: {} });
const SAVE_DELAY_MS = 1500; // changes within this time are written together
// Watch positions arrive every 10 seconds per viewer; writing the whole database for each one was
// most of Marquee's disk writing. They are written within a minute (and on shutdown) instead.
const LAZY_DELAY_MS = 60_000;
const RETRY_MS = 60_000; // after a failed save

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// What each part of the database must be, when it's there (most are added as they're first used).
const LISTS = ['libraries', 'users', 'downloads', 'optimizeDirs'];
const MAPS = ['items', 'shows', 'progress', 'settings', 'sessions', 'requests', 'collections', 'collectionOrder', 'collectionOverrides',
  'watchlist', 'thumbs', 'trackPrefs', 'cwHidden', 'notifications', 'notifyState', 'screenTime', 'healthState', 'autoLibraries',
  'autoSubsState', 'mediaKeys', 'rokus'];
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Whether `d` is a Marquee database, not just any JSON: a damaged or wrong file that happens to parse
 * ("[]", a half-written copy with the library missing) mustn't be used, or a good older copy would be
 * passed over. Returns null when it's fine, else what's wrong.
 */
function problemWith(d) {
  try { return shapeProblem(d); } catch { return 'damaged'; } // (anything unforeseen is a problem too, never a crash)
}
function shapeProblem(d) {
  if (!isMap(d)) return 'not a database';
  // (Only the libraries list is always there: backups from older versions may lack the rest.)
  if (!Array.isArray(d.libraries)) return 'no libraries';
  for (const k of LISTS) if (d[k] != null && !Array.isArray(d[k])) return `${k} is not a list`;
  for (const k of MAPS) if (d[k] != null && !isMap(d[k])) return `${k} is damaged`;
  if (!d.libraries.every((l) => isMap(l) && typeof l.id === 'string' && Array.isArray(l.paths))) return 'a library is damaged';
  if (!(d.users || []).every((u) => isMap(u) && typeof u.id === 'string')) return 'an account is damaged';
  for (const k of ['items', 'shows']) if (!Object.values(d[k] || {}).every(isMap)) return `${k} are damaged`;
  return null;
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = EMPTY();
    this.lost = false;           // a database existed but no copy of it could be read
    this.held = false;           // …and no backup either: nothing is saved, so no copy is overwritten
    // Written when Marquee has to wait (held), so the next start waits too, even though the damaged
    // file was put aside: without it, a restart would find no database and offer a fresh setup.
    this.marker = `${file}.recovery-needed`;
    this.recoveredFrom = null;   // which copy was used when db.json itself was unreadable
    this.timer = null;
    this.due = 0;
    this.rev = 0;                // goes up with each change to the library or accounts (see save)
    this.written = null;         // { rev, items, shows }: the library as last turned into text
    const candidates = [file, `${file}.tmp`, `${file}.bak`];
    const exists = candidates.filter((f) => fs.existsSync(f));
    const usable = (f) => { const d = readJson(f); return d && !problemWith(d) ? d : null; };
    for (const f of candidates) {
      const data = usable(f);
      if (!data) {
        if (fs.existsSync(f)) console.error(`[store] ${path.basename(f)} can't be used: ${readJson(f) === null ? 'unreadable' : problemWith(readJson(f))}`);
        continue;
      }
      this.data = { ...EMPTY(), ...data };
      if (f !== file) {
        this.recoveredFrom = f;
        console.error(`[store] ${path.basename(file)} could not be read; recovered from ${path.basename(f)}`);
      }
      break;
    }
    const waiting = fs.existsSync(this.marker);
    if (waiting && usable(file) || waiting && this.recoveredFrom) this.recovered(); // (a copy put back by hand)
    if ((exists.length || waiting) && !this.recoveredFrom && !usable(file)) {
      this.lost = true;
      console.error(`[store] no usable copy of ${path.basename(file)} was found`);
    }
    // Keep the damaged file for inspection.
    if (fs.existsSync(file) && !usable(file)) fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
  }

  // lazy: fine to write within a minute (a sooner save takes it along).
  // personal: only one person's own state changed (watch position, sign-in times, thumbs, language
  // choices), which the library's lookup tables don't depend on, so those are kept.
  save({ lazy = false, personal = false } = {}) {
    if (!personal) this.rev++;
    const delay = lazy ? LAZY_DELAY_MS : SAVE_DELAY_MS;
    if (this.timer && this.due <= Date.now() + delay) return;
    clearTimeout(this.timer);
    this.due = Date.now() + delay;
    this.timer = setTimeout(() => this.flushOrRetry(), delay);
  }

  // A save that fails (e.g. the disk is full) mustn't stop the server: everything is still in
  // memory, so it's tried again a minute later. The health check shows the error meanwhile.
  flushOrRetry() {
    try {
      this.flush({ reuse: true });
      if (this.saveError) console.log('[store] saving works again');
      this.saveError = null;
    } catch (err) {
      if (!this.saveError) console.error(`[store] couldn't save (trying again every minute): ${err.message}`);
      this.saveError = { at: Date.now(), message: err.code === 'ENOSPC' ? 'The disk is full' : err.message };
      clearTimeout(this.timer);
      this.due = Date.now() + RETRY_MS;
      this.timer = setTimeout(() => this.flushOrRetry(), RETRY_MS);
    }
  }

  // reuse: when only personal state changed since the last save, the titles and shows (nearly all
  // of the file) are written from the text made then: turning them into text again froze the
  // server for ~25 ms per save with a few thousand titles. Saves on request (shutdown, backups)
  // make it all afresh.
  flush({ reuse = false } = {}) {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.held) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const { items, shows, ...rest } = this.data;
    if (!reuse || this.written?.rev !== this.rev) this.written = { rev: this.rev, items: JSON.stringify(items ?? {}), shows: JSON.stringify(shows ?? {}) };
    const head = JSON.stringify(rest);
    const text = `${head.slice(0, -1)}${head === '{}' ? '' : ','}"items":${this.written.items},"shows":${this.written.shows}}`;
    const tmp = `${this.file}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd); // on disk before it replaces anything
    } finally { fs.closeSync(fd); }
    // Renaming instead of copying: no second write of the whole file. Between the two renames the
    // complete db.json.tmp is there to load from.
    if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.bak`);
    fs.renameSync(tmp, this.file);
  }

  library(id) { return this.data.libraries.find((l) => l.id === id) || null; }

  /** Nothing could be restored: wait, now and after restarts, until a copy is back (or the marker is deleted). */
  hold() {
    this.held = true;
    try { fs.mkdirSync(path.dirname(this.marker), { recursive: true }); fs.writeFileSync(this.marker, `${new Date().toISOString()}\n`); } catch { /* (still held for now) */ }
  }

  recovered() {
    this.held = false;
    fs.rmSync(this.marker, { force: true });
  }
}

const hashId = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const randomId = () => crypto.randomBytes(6).toString('hex');

module.exports = { Store, hashId, randomId, problemWith };
