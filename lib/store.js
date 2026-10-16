'use strict';
// Tiny JSON-file database. Everything lives in memory and is flushed atomically to disk.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EMPTY = () => ({ version: 1, libraries: [], items: {}, shows: {}, progress: {} });

class Store {
  constructor(file) {
    this.file = file;
    this.data = EMPTY();
    if (fs.existsSync(file)) {
      try {
        this.data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch (err) {
        const bad = `${file}.corrupt-${Date.now()}`;
        fs.renameSync(file, bad);
        console.error(`[store] could not parse ${file} (${err.message}); moved to ${bad}`);
      }
    }
    this.timer = null;
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  library(id) { return this.data.libraries.find((l) => l.id === id) || null; }
}

const hashId = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const randomId = () => crypto.randomBytes(6).toString('hex');

module.exports = { Store, hashId, randomId };
