'use strict';
// Walks library folders, probes new/changed files, removes missing ones and groups episodes into shows.

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const parse = require('./parse');
const media = require('./media');
const { hashId } = require('./store');

const SKIP_DIRS = /^(\.|@eaDir$|#recycle$|\$RECYCLE\.BIN$|System Volume Information$|lost\+found$)/i;
const SETTLE_MS = 30_000;
const SKIP_FILES = /(^\.|[-._ ]sample\.[^.]+$)/i;

async function walk(dir, out) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  const names = entries.map((e) => e.name);
  const videos = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory(), isFile = e.isFile();
    if (e.isSymbolicLink()) {
      try { const st = await fs.promises.stat(full); isDir = st.isDirectory(); isFile = st.isFile(); } catch { continue; }
    }
    if (isDir && !SKIP_DIRS.test(e.name)) await walk(full, out);
    else if (isFile && !SKIP_FILES.test(e.name) && parse.isVideo(e.name)) videos.push(full);
  }
  // A movie with a "-trailer" file next to it still has the folder to itself (for poster.jpg etc.).
  const main = videos.filter((f) => !parse.isExtraName(f)).length;
  for (const file of videos) out.push({ file, siblings: names, ownFolder: main === 1 });
}

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  }));
}

class Scanner extends EventEmitter {
  constructor(store, dataDir, matcher = null) {
    super();
    this.store = store;
    this.imagesDir = path.join(dataDir, 'images');
    this.matcher = matcher;
    this.queue = [];
    this.current = null;
  }

  status() {
    return { scanning: !!this.current, current: this.current, queued: this.queue.map((q) => q.id) };
  }

  enqueue(libraryId, opts = {}) {
    if (!this.queue.some((q) => q.id === libraryId)) this.queue.push({ id: libraryId, opts });
    this._run();
  }

  enqueueAll(opts) { for (const l of this.store.data.libraries) this.enqueue(l.id, opts); }

  // What a library made from `dir` would find, for the folder picker: videos in it and every folder
  // below it. Stops after `limitMs` on huge drives (then `partial` is set).
  async preview(dir, { limitMs = 4000 } = {}) {
    const until = Date.now() + limitMs;
    let videos = 0, folders = 0, partial = false;
    const sample = [];
    const visit = async (d) => {
      if (Date.now() > until) { partial = true; return; }
      let entries;
      try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
      folders++;
      for (const e of entries) {
        const full = path.join(d, e.name);
        let isDir = e.isDirectory(), isFile = e.isFile();
        if (e.isSymbolicLink()) { try { const st = await fs.promises.stat(full); isDir = st.isDirectory(); isFile = st.isFile(); } catch { continue; } }
        if (isDir && !SKIP_DIRS.test(e.name)) await visit(full);
        else if (isFile && !SKIP_FILES.test(e.name) && parse.isVideo(e.name)) {
          videos++;
          if (sample.length < 6) sample.push(path.relative(dir, full));
        }
      }
    };
    await visit(dir);
    return { videos, folders: Math.max(0, folders - 1), sample, partial };
  }

  async _run() {
    if (this.current) return;
    while (this.queue.length) {
      const { id, opts } = this.queue.shift();
      const library = this.store.library(id);
      if (!library) continue;
      this.current = { id, name: library.name, phase: 'listing', total: 0, done: 0 };
      const t0 = Date.now();
      try {
        await this.scanLibrary(library, opts);
        library.scannedAt = Date.now();
        console.log(`[scan] ${library.name}: done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (err) {
        console.error(`[scan] ${library.name} failed:`, err);
      }
      this.store.save();
      this.current = null;
      this.emit('done', id);
    }
  }

  // settle: skip new or changed files modified in the last SETTLE_MS (probably still being copied) and
  // look again later. Used for scans started by the folder watcher.
  async scanLibrary(library, { refreshMeta = false, settle = false } = {}) {
    const { items, shows } = this.store.data;
    const found = [];
    const availableRoots = [];
    for (const root of library.paths) {
      if (!fs.existsSync(root)) { console.warn(`[scan] ${library.name}: path not found, skipping: ${root}`); continue; }
      availableRoots.push(root);
      const before = found.length;
      await walk(root, found);
      for (let i = before; i < found.length; i++) found[i].root = root;
    }

    this.current.phase = 'probing';
    this.current.total = found.length;
    const seen = new Set();
    let unsettled = false;

    await pool(found, 3, async ({ file, siblings, ownFolder, root }) => {
      const id = hashId(file);
      seen.add(id);
      let st;
      try { st = await fs.promises.stat(file); } catch { return; }
      let item = items[id];
      const changed = !item || item.size !== st.size || item.mtime !== st.mtimeMs || item.libraryId !== library.id;
      if (changed && settle && Date.now() - st.mtimeMs < SETTLE_MS) { unsettled = true; this.current.done++; return; }
      if (changed) {
        let probeInfo = null;
        try { probeInfo = await media.probe(file); } catch (err) { console.warn(`[scan] ${err.message}: ${file}`); }
        item = {
          id, libraryId: library.id, file, size: st.size, mtime: st.mtimeMs,
          addedAt: item?.addedAt || Date.now(), media: probeInfo, meta: item?.meta || null, edits: item?.edits,
        };
        items[id] = item;
      }
      // Cheap to recompute every scan: parse result, sidecar subs, local art.
      const rel = path.relative(root, file);
      const extra = parse.extraInfo(rel);
      if (extra) {
        // Linked to its movie or show below, once every file has been seen.
        Object.assign(item, { type: 'extra', title: extra.title, extraKind: extra.kind, ownerDir: path.join(root, extra.ownerDir), ownerBase: extra.ownerBase });
        for (const k of ['season', 'episode', 'episodeEnd', 'showTitle', 'showYear', 'showIds', 'showId', 'showDir', 'year', 'ids', 'poster', 'backdrop']) delete item[k];
      } else if (library.type === 'show') {
        const ep = parse.parseEpisode(rel);
        Object.assign(item, { type: 'episode', title: ep.title, season: ep.season, episode: ep.episode,
          episodeEnd: ep.episodeEnd, showTitle: ep.show, showYear: ep.showYear, showIds: ep.showIds });
        const showDir = ep.showDirIndex >= 0 ? path.join(root, ...rel.split(path.sep).slice(0, ep.showDirIndex + 1)) : null;
        item.showId = hashId(`${library.id}|${(showDir || ep.show).toLowerCase()}`);
        item.showDir = showDir;
      } else {
        const mv = parse.parseMovie(file);
        Object.assign(item, { type: 'movie', title: mv.title, year: mv.year });
        // "{tmdb-603}" / "[imdbid-tt0133093]" in the file or folder name: an exact match.
        item.ids = parse.idsFromName(path.basename(file)) || (ownFolder ? parse.idsFromName(path.basename(path.dirname(file))) : null);
        Object.assign(item, parse.findLocalArt(file, siblings, ownFolder));
        // Downloaded videos: their own details instead of a (wrong) movie database match.
        const info = parse.readVideoInfo(file, siblings);
        item.chapters = info?.chapters || [];
        if (info && (!item.meta || item.meta.provider === 'video' || item.meta.notFound || item.meta.unmatched)) {
          item.meta = {
            provider: 'video', providerId: info.id, title: info.title, year: info.year, overview: info.description,
            airDate: info.uploadDate, channel: info.channel, url: info.url, genres: [], cast: [], rating: null,
            fetchedAt: item.meta?.fetchedAt || Date.now(),
          };
        }
      }
      item.sidecarSubs = parse.findSidecarSubs(file, siblings);
      this.current.done++;
      if (this.current.done % 25 === 0) this.store.save();
    });

    // Remove items that disappeared, but never those under a root that is currently unavailable
    // (e.g. an unmounted USB drive), so watch history survives.
    for (const it of Object.values(items)) {
      if (it.libraryId !== library.id || seen.has(it.id)) continue;
      const underMissingRoot = library.paths.some((r) => !availableRoots.includes(r) && it.file.startsWith(r));
      if (!underMissingRoot) delete items[it.id];
    }

    if (library.type === 'show') this.rebuildShows(library);
    this.linkExtras(library);
    if (unsettled) setTimeout(() => this.enqueue(library.id, { settle: true }), SETTLE_MS + 5000).unref();
    for (const s of Object.values(shows)) if (s.libraryId === library.id && !s.episodeCount) delete shows[s.id];

    if (this.matcher) {
      this.current.phase = 'metadata';
      await this.matcher.matchLibrary(library, {
        force: refreshMeta,
        onProgress: (done, total) => Object.assign(this.current, { done, total }),
      }).catch((err) => console.warn('[meta]', err.message));
    }
  }

  // Attach each extra to the movie in its folder (the one it is named after, if several) or to its show.
  linkExtras(library) {
    const all = Object.values(this.store.data.items).filter((i) => i.libraryId === library.id);
    for (const x of all) {
      if (x.type !== 'extra') continue;
      x.parentId = null;
      if (library.type === 'show') {
        // The show whose folder it is in ("Show/Extras/…", "Kids/Show/Season 1/Trailers/…").
        const owner = Object.values(this.store.data.shows)
          .filter((s) => s.libraryId === library.id && s.dir && x.file.startsWith(s.dir + path.sep))
          .sort((a, b) => b.dir.length - a.dir.length)[0];
        x.parentId = owner?.id || null;
      } else {
        const movies = all.filter((m) => m.type === 'movie' && path.dirname(m.file) === x.ownerDir);
        const named = x.ownerBase && movies.find((m) => path.basename(m.file, path.extname(m.file)).toLowerCase() === x.ownerBase.toLowerCase());
        x.parentId = (named || movies[0])?.id || null;
      }
    }
  }

  rebuildShows(library) {
    const { items, shows } = this.store.data;
    const groups = new Map();
    for (const it of Object.values(items)) {
      if (it.libraryId !== library.id || it.type !== 'episode') continue;
      if (!groups.has(it.showId)) groups.set(it.showId, []);
      groups.get(it.showId).push(it);
    }
    for (const s of Object.values(shows)) if (s.libraryId === library.id) s.episodeCount = 0;
    for (const [showId, eps] of groups) {
      const first = eps[0];
      const show = shows[showId] || { id: showId, libraryId: library.id, addedAt: Date.now(), meta: null };
      show.title = first.showTitle;
      show.year = eps.find((e) => e.showYear)?.showYear || null;
      show.ids = eps.find((e) => e.showIds)?.showIds || null;
      show.dir = first.showDir;
      show.episodeCount = eps.length;
      show.lastAddedAt = Math.max(...eps.map((e) => e.addedAt));
      Object.assign(show, { poster: null, backdrop: null });
      if (show.dir) {
        try { Object.assign(show, parse.findFolderArt(show.dir, fs.readdirSync(show.dir))); } catch { /* ignore */ }
      }
      shows[showId] = show;
    }
  }
}

module.exports = { Scanner, SETTLE_MS, SKIP_DIRS };
