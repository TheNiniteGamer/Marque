'use strict';
// Tiny JSON-file database. Everything lives in memory and is written to disk shortly after changes.
//
// Saving is crash-safe: the new data goes to db.json.tmp and is forced onto the disk, the previous
// db.json is renamed to db.json.bak, and then the new file takes its place. If db.json is ever missing or
// unreadable (e.g. after a power cut), the newest readable of db.json.tmp / db.json.bak is used.
// If none can be read, `lost` is set so the server can restore the latest backup instead of
// starting empty.

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

class Store {
  constructor(file) {
    this.file = file;
    this.data = EMPTY();
    this.lost = false;           // a database existed but no copy of it could be read
    this.recoveredFrom = null;   // which copy was used when db.json itself was unreadable
    this.timer = null;
    this.due = 0;
    this.rev = 0;                // goes up with each change to the library or accounts (see save)
    const candidates = [file, `${file}.tmp`, `${file}.bak`];
    const exists = candidates.filter((f) => fs.existsSync(f));
    for (const f of candidates) {
      const data = readJson(f);
      if (!data || typeof data !== 'object') continue;
      this.data = { ...EMPTY(), ...data };
      if (f !== file) {
        this.recoveredFrom = f;
        console.error(`[store] ${path.basename(file)} could not be read; recovered from ${path.basename(f)}`);
      }
      break;
    }
    if (exists.length && !this.recoveredFrom && readJson(file) === null) {
      this.lost = true;
      console.error(`[store] no readable copy of ${path.basename(file)} was found`);
    }
    // Keep the unreadable file for inspection.
    if (fs.existsSync(file) && readJson(file) === null) fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
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
      this.flush();
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

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(this.data));
      fs.fsyncSync(fd); // on disk before it replaces anything
    } finally { fs.closeSync(fd); }
    // Renaming instead of copying: no second write of the whole file. Between the two renames the
    // complete db.json.tmp is there to load from.
    if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.bak`);
    fs.renameSync(tmp, this.file);
  }

  library(id) { return this.data.libraries.find((l) => l.id === id) || null; }
}

const hashId = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const randomId = () => crypto.randomBytes(6).toString('hex');

module.exports = { Store, hashId, randomId };
