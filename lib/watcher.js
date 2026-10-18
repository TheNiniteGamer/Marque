'use strict';
// Notices new, removed and renamed files without waiting for the next full scan. Every few seconds
// it reads only the folder tree (no files are opened or probed) and compares each folder's
// "modified" time; adding, deleting or renaming a file changes its folder's time. When something
// changed, that library is scanned with `settle`, so files still being copied are picked up later.
// Polling is used rather than file-system events because those don't reach Docker containers from
// Windows folders or network drives.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SKIP_DIRS } = require('./scanner');

async function folderSignature(roots) {
  const hash = crypto.createHash('sha1');
  const visit = async (dir) => {
    let st, entries;
    try { st = await fs.promises.stat(dir); entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { hash.update(`${dir}|missing\n`); return; }
    hash.update(`${dir}|${st.mtimeMs}\n`);
    for (const e of entries) {
      if (SKIP_DIRS.test(e.name)) continue;
      if (e.isDirectory()) await visit(path.join(dir, e.name));
      else if (e.isSymbolicLink()) {
        const full = path.join(dir, e.name);
        if (await fs.promises.stat(full).then((s) => s.isDirectory(), () => false)) await visit(full);
      }
    }
  };
  for (const r of roots) await visit(r);
  return hash.digest('hex');
}

class FolderWatcher {
  constructor(store, scanner, intervalMs) {
    this.store = store;
    this.scanner = scanner;
    this.intervalMs = intervalMs;
    this.seen = new Map(); // libraryId -> signature
    this.busy = false;
  }

  start() {
    if (!(this.intervalMs > 0)) return;
    this.check(); // the starting point: changes are counted from now
    setInterval(() => this.check(), this.intervalMs).unref();
  }

  async check() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const lib of this.store.data.libraries) {
        const sig = await folderSignature(lib.paths);
        const prev = this.seen.get(lib.id);
        this.seen.set(lib.id, sig);
        if (prev !== undefined && prev !== sig) {
          console.log(`[watch] ${lib.name}: folder contents changed, scanning`);
          this.scanner.enqueue(lib.id, { settle: true });
        }
      }
    } finally { this.busy = false; }
  }
}

module.exports = { FolderWatcher, folderSignature };
