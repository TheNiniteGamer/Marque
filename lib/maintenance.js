'use strict';
// Housekeeping: cached files Marquee made for videos that are gone or have been replaced
// (thumbnails, seek previews, subtitle copies, audio fingerprints, unused artwork) are removed
// once a day, and Settings shows how much space each kind of cache uses.

const fs = require('node:fs');
const path = require('node:path');

function sizeOf(p) {
  let st;
  try { st = fs.statSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of fs.readdirSync(p)) total += sizeOf(path.join(p, name));
  return total;
}

const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

class Maintenance {
  constructor(store, dataDir, { transcodeDir }) {
    this.store = store;
    this.dirs = {
      thumbs: path.join(dataDir, 'thumbs'),
      trickplay: path.join(dataDir, 'trickplay'),
      subtitles: path.join(dataDir, 'subs'),
      downloadedSubtitles: path.join(dataDir, 'subs-downloaded'),
      fingerprints: path.join(dataDir, 'fingerprints'),
      artwork: path.join(dataDir, 'images'),
      conversions: transcodeDir,
      offline: path.join(dataDir, 'offline'),
      previews: path.join(dataDir, 'previews'),
    };
    this.dataDir = dataDir;
    this.lastCleanup = null;
  }

  sizes() {
    const out = Object.fromEntries(Object.entries(this.dirs).map(([k, d]) => [k, sizeOf(d)]));
    out.database = ['db.json', 'db.json.bak'].reduce((n, f) => n + sizeOf(path.join(this.dataDir, f)), 0);
    return { sizes: out, lastCleanup: this.lastCleanup };
  }

  // Removes cached files nothing refers to any more. Returns { files, bytes }.
  cleanup() {
    const { items, shows } = this.store.data;
    // With no titles at all (e.g. the database was just lost) nothing is touched.
    if (!Object.keys(items).length) return { files: 0, bytes: 0 };
    const version = (id) => (items[id] ? String(Math.round(items[id].mtime || 0)) : null);
    let files = 0, bytes = 0;
    const drop = (p) => { const n = sizeOf(p); fs.rmSync(p, { recursive: true, force: true }); files++; bytes += n; };

    // <id>.jpg
    for (const f of list(this.dirs.thumbs)) if (!items[f.replace(/\.jpg$/, '').replace(/\.tmp$/, '')]) drop(path.join(this.dirs.thumbs, f));
    // <id>-<mtime>/ (a .tmp folder is a job in progress)
    for (const f of list(this.dirs.trickplay)) {
      const m = /^([0-9a-f]+)-(\d+)$/.exec(f);
      if (m && version(m[1]) !== m[2]) drop(path.join(this.dirs.trickplay, f));
    }
    // <id>-<stream>-<mtime>.vtt
    for (const f of list(this.dirs.subtitles)) {
      const m = /^([0-9a-f]+)-\d+-(\d+)\.vtt$/.exec(f);
      if (m && version(m[1]) !== m[2]) drop(path.join(this.dirs.subtitles, f));
    }
    // Downloaded subtitles that no title lists any more.
    const usedSubs = new Set(Object.values(items).flatMap((i) => (i.downloadedSubs || []).map((s) => s.file)));
    for (const f of list(this.dirs.downloadedSubtitles)) if (!usedSubs.has(f)) drop(path.join(this.dirs.downloadedSubtitles, f));
    // <id>-<mtime>[-end].fp
    for (const f of list(this.dirs.fingerprints)) {
      const m = /^([0-9a-f]+)-(\d+)(-end)?\.fp$/.exec(f);
      if (m && version(m[1]) !== m[2]) drop(path.join(this.dirs.fingerprints, f));
    }
    // Artwork: kept if the database mentions the file anywhere (posters, stills, uploads…).
    const used = new Set();
    const collect = (v) => {
      if (typeof v === 'string') used.add(v);
      else if (v && typeof v === 'object') for (const x of Object.values(v)) collect(x);
    };
    collect({ items, shows });
    collect(this.store.data.collectionOverrides);
    const walkArt = (dir) => {
      for (const f of list(dir)) {
        const p = path.join(dir, f);
        let st; try { st = fs.statSync(p); } catch { continue; }
        if (st.isDirectory()) walkArt(p);
        else if (!used.has(p) && Date.now() - st.mtimeMs > 3600_000) drop(p); // (an hour's grace for downloads in progress)
      }
    };
    walkArt(this.dirs.artwork);
    this.lastCleanup = { at: Date.now(), files, bytes };
    if (files) console.log(`[maintenance] removed ${files} unused cached file(s), ${(bytes / 1048576).toFixed(1)} MB`);
    return { files, bytes };
  }

  start() {
    const run = () => { try { this.cleanup(); } catch (err) { console.warn(`[maintenance] ${err.message}`); } };
    setTimeout(run, 10 * 60_000).unref(); // after the first scans
    setInterval(run, 24 * 3600_000).unref();
  }
}

module.exports = { Maintenance };
