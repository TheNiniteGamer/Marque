'use strict';
// Tiny JSON-file database. Everything lives in memory and is written to disk shortly after changes.
//
// Saving is crash-safe: the new data goes to db.json.tmp and is forced onto the disk, the previous
// db.json becomes db.json.bak, and then the new file takes its place. If db.json is ever missing or
// unreadable (e.g. after a power cut), the newest readable of db.json.tmp / db.json.bak is used.
// If none can be read, `lost` is set so the server can restore the latest backup instead of
// starting empty.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EMPTY = () => ({ version: 1, libraries: [], items: {}, shows: {}, progress: {} });
const SAVE_DELAY_MS = 1500; // changes within this time are written together

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

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
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
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    fs.renameSync(tmp, this.file);
  }

  library(id) { return this.data.libraries.find((l) => l.id === id) || null; }
}

const hashId = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const randomId = () => crypto.randomBytes(6).toString('hex');

module.exports = { Store, hashId, randomId };
