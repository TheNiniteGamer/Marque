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

// unreadable: folders that couldn't be read are listed in it (a drive dropping out mid-scan).
async function walk(dir, out, unreadable = []) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { unreadable.push(dir); return; }
  const names = entries.map((e) => e.name);
  const videos = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory(), isFile = e.isFile();
    if (e.isSymbolicLink()) {
      try { const st = await fs.promises.stat(full); isDir = st.isDirectory(); isFile = st.isFile(); } catch { continue; }
    }
    if (isDir && !SKIP_DIRS.test(e.name)) await walk(full, out, unreadable);
    else if (isFile && !SKIP_FILES.test(e.name) && parse.isVideo(e.name)) videos.push(full);
  }
  // A movie with a "-trailer" file next to it still has the folder to itself (for poster.jpg etc.);
  // so does a disc ripped with MakeMKV (its titles "_t00", "_t01"… are one film and its extras).
  const main = new Set(videos.filter((f) => !parse.isExtraName(f)).map((f) => (parse.discTitle(f) ? `disc:${parse.discTitle(f).name}` : f))).size;
  for (const file of videos) out.push({ file, siblings: names, ownFolder: main === 1 });
}

const underRoot = (file, root) => file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

// A file that was renamed or replaced (Radarr and Sonarr do this when they upgrade one) gets a new id,
// as ids come from paths. When a title disappears and a new one with the same identity appears in the
// same scan, its history moves across: watch progress, My List, thumbs, Continue Watching, collections,
// its match and fixes, and when it was added (so it doesn't come back as new). Only one-to-one pairs.
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
function identity(it) {
  if (it.type === 'episode' && it.season != null && it.episode != null) return `e|${norm(it.showTitle)}|${it.season}|${it.episode}`;
  if (it.type === 'movie' && it.title) return `m|${norm(it.title)}|${it.year || ''}`;
  return null;
}
function carryOver(store, gone, fresh) {
  const unique = (list) => {
    const m = new Map();
    for (const it of list) { const k = identity(it); if (k) m.set(k, m.has(k) ? null : it); }
    return m;
  };
  const after = unique(fresh);
  let moved = 0;
  for (const [k, old] of unique(gone)) {
    const now = after.get(k);
    if (!old || !now) continue;
    moveHistory(store, old, now);
    moved++;
  }
  return moved;
}
function moveHistory(store, old, now) {
  now.addedAt = old.addedAt || now.addedAt;
  if (!now.meta && old.meta) now.meta = old.meta;
  if (!now.edits && old.edits) now.edits = old.edits;
  for (const key of ['progress', 'watchlist', 'thumbs', 'cwHidden']) {
    for (const map of Object.values(store.data[key] || {})) {
      if (!map || !(old.id in map)) continue;
      if (!(now.id in map)) map[now.id] = map[old.id];
      delete map[old.id];
    }
  }
  const swap = (list) => (Array.isArray(list) ? list.map((id) => (id === old.id ? now.id : id)) : list);
  for (const c of Object.values(store.data.collections || {})) {
    c.members = swap(c.members);
    if (c.cover === old.id) c.cover = now.id;
  }
  for (const o of Object.values(store.data.collectionOverrides || {})) {
    o.added = swap(o.added);
    o.removed = swap(o.removed);
    if (o.cover === old.id) o.cover = now.id;
  }
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
    this.paused = false;
  }

  // A restore replaces the database under a running scan: pause() ends the current scan at the next
  // file (without removing anything it hadn't reached) and holds scans asked for meanwhile until
  // resume(). Resolves once nothing is scanning.
  async pause() {
    this.paused = true;
    if (!this.current) return;
    await new Promise((resolve) => this.once('idle', resolve));
  }
  resume() {
    this.paused = false;
    this._run();
  }
  get stopping() { return this.paused && !!this.current; }

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
    if (this.current || this.paused) return;
    while (this.queue.length && !this.paused) {
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
        if (err.stopped) {
          console.log(`[scan] ${library.name}: stopped (it will be scanned again)`);
          if (!this.queue.some((q) => q.id === id)) this.queue.unshift({ id, opts });
        } else console.error(`[scan] ${library.name} failed:`, err);
      }
      this.store.save();
      this.current = null;
      this.emit('done', id);
    }
    this.emit('idle');
  }

  // settle: skip new or changed files modified in the last SETTLE_MS (probably still being copied) and
  // look again later. Used for scans started by the folder watcher.
  async scanLibrary(library, { refreshMeta = false, settle = false } = {}) {
    const { items, shows } = this.store.data;
    const found = [];
    const prunableRoots = []; // the folders whose missing titles may be removed
    for (const root of library.paths) {
      if (!fs.existsSync(root)) { console.warn(`[scan] ${library.name}: path not found, skipping: ${root}`); continue; }
      const before = found.length;
      const unreadable = [];
      await walk(root, found, unreadable);
      for (let i = before; i < found.length; i++) found[i].root = root;
      // An unmounted drive leaves an empty folder behind, and one dropping out mid-scan can't be read:
      // either way its titles are kept, as removing them loses their fixes, markers and copies.
      const had = Object.values(items).some((it) => it.libraryId === library.id && underRoot(it.file, root));
      if (unreadable.length) console.warn(`[scan] ${library.name}: couldn't read ${unreadable[0]}; keeping the titles under ${root}`);
      else if (found.length === before && had) console.warn(`[scan] ${library.name}: ${root} is empty (drive not mounted?); keeping its titles`);
      else prunableRoots.push(root);
    }

    this.current.phase = 'probing';
    this.current.total = found.length;
    const seen = new Set();
    const fresh = new Set(); // ids that weren't in the library before this scan
    let unsettled = false;

    const stopped = () => Object.assign(new Error('scan stopped'), { stopped: true });
    await pool(found, 3, async ({ file, siblings, ownFolder, root }) => {
      if (this.stopping) return;
      const id = hashId(file);
      seen.add(id);
      let st;
      try { st = await fs.promises.stat(file); } catch { return; }
      let item = items[id];
      if (!item) fresh.add(id);
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
        // A running number ("Show - 1071") the matcher placed in its season (absMapped), then
        // numbers an admin picked by hand (Fix episode), win over the file name's.
        item.absolute = ep.absolute;
        if (ep.absolute && item.absMapped?.from === ep.episode && (item.absMapped.parsedSeason ?? ep.season) === ep.season) {
          Object.assign(item, { season: item.absMapped.season, episode: item.absMapped.episode, episodeEnd: null });
        } else delete item.absMapped;
        if (item.edits?.season != null) item.season = item.edits.season;
        if (item.edits?.episode != null) Object.assign(item, { episode: item.edits.episode, episodeEnd: null });
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

    if (this.stopping) throw stopped(); // (before removing anything: most files weren't looked at)

    // Remove items that disappeared, but never those under a root that is unavailable, empty or
    // couldn't be read (e.g. an unmounted USB drive), so their history survives.
    const gone = Object.values(items).filter((it) => it.libraryId === library.id && !seen.has(it.id)
      && !library.paths.some((r) => !prunableRoots.includes(r) && underRoot(it.file, r)));
    const moved = carryOver(this.store, gone, [...fresh].map((id) => items[id]).filter(Boolean));
    if (moved) console.log(`[scan] ${library.name}: ${moved} renamed or replaced file${moved === 1 ? '' : 's'} kept ${moved === 1 ? 'its' : 'their'} history`);
    for (const it of gone) delete items[it.id];

    if (library.type === 'show') this.rebuildShows(library);
    else this.groupDiscRips(library);
    this.linkExtras(library);
    if (unsettled) setTimeout(() => this.enqueue(library.id, { settle: true }), SETTLE_MS + 5000).unref();
    for (const s of Object.values(shows)) if (s.libraryId === library.id && !s.episodeCount) delete shows[s.id];

    if (this.matcher) {
      this.current.phase = 'metadata';
      await this.matcher.matchLibrary(library, {
        force: refreshMeta,
        onProgress: (done, total) => Object.assign(this.current, { done, total }),
        shouldStop: () => this.stopping,
      }).catch((err) => console.warn('[meta]', err.message));
      if (this.stopping) throw stopped();
    }
  }

  // Discs ripped with MakeMKV: "<disc>_t00.mkv", "_t01"… side by side. The longest title is the
  // film; titles under half its length are the disc's extras (featurettes, storyboards, deleted
  // scenes…). Long ones (another cut of the film) stay films: they become its other versions.
  groupDiscRips(library) {
    const groups = new Map();
    for (const it of Object.values(this.store.data.items)) {
      if (it.libraryId !== library.id || it.type !== 'movie') continue;
      const d = parse.discTitle(it.file);
      if (!d) continue;
      const key = `${path.dirname(it.file)}|${d.name.toLowerCase()}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const len = (x) => x.media?.duration || 0;
      const film = g.reduce((a, b) => (len(b) > len(a) ? b : a));
      for (const it of g) {
        if (it === film || len(it) >= len(film) * 0.5) continue;
        Object.assign(it, {
          type: 'extra', extraKind: 'other', title: `Disc extra ${parse.discTitle(it.file).n}`,
          ownerDir: path.dirname(it.file), ownerBase: path.basename(film.file, path.extname(film.file)),
        });
        for (const k of ['year', 'ids', 'poster', 'backdrop', 'meta', 'chapters']) delete it[k];
      }
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

module.exports = { carryOver, identity, Scanner, SETTLE_MS, SKIP_DIRS };
