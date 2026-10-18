'use strict';
// Matching media to online metadata, plus user edits.
//
// Every movie/show/episode has up to three layers, highest priority first:
//   edits  – what an admin typed or uploaded (never touched by scans or refreshes)
//   meta   – what a metadata provider returned for the matched title
//   (base) – what was parsed from the file name
// Clearing an edit falls back to the layer below.

const path = require('node:path');
const fs = require('node:fs');
const md = require('./metadata');
const lib = require('./library');

const httpError = (status, msg) => Object.assign(new Error(msg), { status });

// ---------- how sure a match is ----------
// Each search result gets a score out of about 100 from how well its title, year and (for movies)
// running time fit the file. 70 or more is taken as right; 50-69 is used but listed under
// "Needs a check" in Settings; below 50 nothing is applied and the best guesses are kept for the admin.
const CONFIDENT = 70;
const PROBABLE = 50;
const ROMAN = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' };
const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ')
  .split(/[^\p{L}\p{N}]+/u).filter((w) => w && !['the', 'a', 'an'].includes(w)).map((w) => ROMAN[w] || w);
const titleKey = (s) => words(s).join(' ');
function bigrams(s) {
  const t = s.replace(/ /g, ''), m = new Map();
  for (let i = 0; i < t.length - 1; i++) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) || 0) + 1);
  return m;
}
// 1 for the same title (ignoring case, punctuation, "The", "II" vs "2"), less the more they differ.
function similarity(a, b) {
  const x = titleKey(a), y = titleKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  // "Alien" vs "Alien: Director's Cut", "Dune" vs "Dune: Part One": the file leaves part of the name out.
  const partly = x.startsWith(`${y} `) || y.startsWith(`${x} `) ? 0.85 : 0;
  const A = bigrams(x), B = bigrams(y);
  let both = 0, total = 0;
  for (const [g, n] of A) { both += Math.min(n, B.get(g) || 0); total += n; }
  for (const n of B.values()) total += n;
  return Math.max(partly, total ? (2 * both) / total : 0);
}

function scoreResults(results, title, year) {
  const sims = results.map((r) => Math.max(similarity(title, r.title), similarity(title, r.originalTitle)));
  const exact = sims.filter((x) => x === 1).length;
  return results.map((r, i) => {
    let score = sims[i] === 1 ? 60 : sims[i] * 50;
    if (year && r.year) score += r.year === year ? 25 : Math.abs(r.year - year) === 1 ? 10 : -30;
    // Without a year, an exact title nothing else shares is still a safe bet (remakes are not).
    if (!year && sims[i] === 1 && exact === 1) score += 15;
    score -= i * 0.01; // the provider's own order breaks ties
    return { ...r, score };
  }).sort((a, b) => b.score - a.score);
}

// Running time: a 2-hour file is not the 90-minute film of the same name.
function runtimePoints(fileMinutes, runtime) {
  if (!fileMinutes || !runtime) return 0;
  if (Math.abs(fileMinutes - runtime) <= Math.max(6, runtime * 0.08)) return 15;
  if (fileMinutes < runtime * 0.6 || fileMinutes > runtime * 1.6) return -25;
  return 0;
}
const percent = (score) => Math.max(0, Math.min(100, Math.round(score)));
const candidate = (r) => ({ provider: r.provider, id: r.id, title: r.title, year: r.year || null, thumb: r.thumb || null, score: percent(r.score) });

const EDITABLE = {
  movie: ['title', 'sortTitle', 'year', 'tagline', 'overview', 'genres'],
  show: ['title', 'sortTitle', 'year', 'overview', 'genres'],
  episode: ['title', 'overview'],
};
const ART_KINDS = { movie: ['poster', 'backdrop'], show: ['poster', 'backdrop'], episode: ['thumb'] };

class Matcher {
  constructor(store, imagesDir) {
    this.store = store;
    this.imagesDir = imagesDir;
    this.customDir = path.join(imagesDir, 'custom');
  }

  settings() { return this.store.data.settings || {}; }

  // Resolve an id to { target, kind } where kind is movie | show | episode.
  resolve(id) {
    const item = this.store.data.items[id];
    if (item) return { target: item, kind: item.type === 'episode' ? 'episode' : 'movie' };
    const show = this.store.data.shows[id];
    if (show) return { target: show, kind: 'show' };
    throw httpError(404, 'Not found');
  }

  episodesOf(show) { return lib.episodesOf(this.store, show.id); }

  // ---------- matching ----------
  async search(kind, query, year, providerId) {
    const providers = md.providersFor(kind).filter((p) => !providerId || p.id === providerId);
    if (!providers.length) {
      throw httpError(400, kind === 'movie' ? 'Add a TMDB API key in Settings → Metadata to look up movies' : 'No metadata provider is available');
    }
    const results = [];
    const errors = [];
    for (const p of providers) {
      try { results.push(...await p.search(kind, query, year)); } catch (err) { errors.push(`${p.name}: ${err.message}`); }
    }
    if (!results.length && errors.length) throw httpError(502, errors.join('; '));
    return results;
  }

  // `how`: { matchedBy: 'hand' | 'id' | 'auto', score, uncertain, candidates } kept with the match.
  // Without it (a refresh), what was known about the match is kept if it's the same title.
  async apply(target, kind, providerId, id, { details = null, how = null } = {}) {
    if (kind === 'episode') throw httpError(400, 'Match the show instead of a single episode');
    const p = md.PROVIDERS[providerId];
    if (!p || !p.kinds.includes(kind)) throw httpError(400, 'Unknown metadata source');
    if (!p.enabled()) throw httpError(400, `${p.name} is not configured`);
    const d = details || await p.details(kind, id);
    if (!d) throw httpError(404, `${p.name} has no entry with id ${id}`);
    const old = target.meta || {};
    const same = old.provider === p.id && old.providerId === d.providerId;
    const known = how || (same ? { matchedBy: old.matchedBy, score: old.score, uncertain: old.uncertain, candidates: old.candidates } : {});
    const img = (url, suffix) => md.downloadImage(url, this.imagesDir, `${target.id}-${suffix}`).catch(() => null);
    target.meta = {
      provider: p.id, providerId: d.providerId,
      title: d.title || null, year: d.year || null, overview: d.overview, tagline: d.tagline, genres: d.genres || [],
      rating: d.rating, cast: d.cast || [],
      ...(kind === 'movie' ? { collection: d.collection || null, runtime: d.runtime || null } : {}),
      poster: await img(d.posterUrl, 'poster'), backdrop: await img(d.backdropUrl, 'backdrop'),
      fetchedAt: Date.now(),
      ...(known.matchedBy ? { matchedBy: known.matchedBy } : {}),
      ...(known.score != null ? { score: known.score } : {}),
      ...(known.uncertain ? { uncertain: true, candidates: known.candidates || [] } : {}),
    };
    if (kind === 'show') await this.applyEpisodes(target, p, d);
    this.store.save();
    return target.meta;
  }

  async applyEpisodes(show, provider, details) {
    const eps = this.episodesOf(show);
    const seasons = [...new Set(eps.map((e) => e.season).filter((n) => n != null))];
    const map = details.episodeMap || await provider.episodes(details.providerId, seasons);
    for (const e of eps) {
      const m = map.get(e.season)?.get(e.episode);
      if (!m) { e.meta = { notFound: true }; continue; }
      e.meta = {
        title: m.title, overview: m.overview, airDate: m.airDate, fetchedAt: Date.now(),
        still: m.stillUrl ? await md.downloadImage(m.stillUrl, this.imagesDir, `${e.id}-still`).catch(() => null) : null,
      };
    }
  }

  // "{tmdb-603}", "[imdbid-tt0133093]", "{tvdb-81189}" in the name: the exact title, no guessing.
  async matchById(target, kind) {
    const ids = target.ids;
    if (!ids) return false;
    let provider = null, id = null;
    if (ids.tmdb && md.tmdb.enabled()) [provider, id] = ['tmdb', ids.tmdb];
    else if (ids.tvmaze && kind === 'show' && md.tvmaze.enabled()) [provider, id] = ['tvmaze', ids.tvmaze];
    else {
      for (const p of md.providersFor(kind)) {
        const found = await p.find?.(kind, ids).catch((err) => { console.warn(`[meta] ${p.name} lookup ${JSON.stringify(ids)}: ${err.message}`); return null; });
        if (found) { [provider, id] = [p.id, found]; break; }
      }
    }
    if (!provider) return false;
    const m = target.meta || {};
    if (m.provider === provider && m.providerId === id && m.matchedBy === 'id') return true;
    await this.apply(target, kind, provider, id, { how: { matchedBy: 'id', score: 100 } });
    return true;
  }

  // Search every source and score what comes back. Movies whose best results are close also get
  // their running time compared with the file's (one extra lookup per close result, at most 3).
  async candidates(target, kind) {
    const query = target.title;
    const year = target.year || null;
    const minutes = kind === 'movie' && target.media?.duration ? target.media.duration / 60 : null;
    const all = [];
    let failed = false; // did any source fail to answer?
    for (const p of md.providersFor(kind)) {
      let results;
      try { results = await p.search(kind, query, year); } catch (err) { failed = true; console.warn(`[meta] ${p.name} search "${query}": ${err.message}`); continue; }
      const scored = scoreResults(results, query, year);
      const top = scored[0];
      if (minutes && top && (top.score < 80 || scored[1]?.score > top.score - 20)) {
        for (const r of scored.filter((x) => x.score >= 40 && x.score > top.score - 20).slice(0, 3)) {
          r.details = await p.details(kind, r.id).catch(() => null);
          r.score += runtimePoints(minutes, r.details?.runtime);
        }
        scored.sort((x, y) => y.score - x.score);
      }
      all.push(...scored);
      if (scored[0]?.score >= CONFIDENT) break;
    }
    return { list: all.sort((x, y) => y.score - x.score), failed };
  }

  // keepCurrent (re-checking): a title that is already matched keeps its match unless a confident,
  // different one turns up; if the current match doesn't hold up, it is listed under "Needs a check".
  async autoMatch(target, kind, { keepCurrent = false } = {}) {
    if (await this.matchById(target, kind).catch((err) => { console.warn(`[meta] ${target.title}: ${err.message}`); return false; })) return true;
    const { list, failed } = await this.candidates(target, kind);
    const best = list[0];
    const guesses = list.slice(0, 4).map(candidate);
    const cur = target.meta || {};
    const current = !!cur.provider && cur.provider !== 'video';
    const isCurrent = (r) => current && r.provider === cur.provider && r.id === cur.providerId;
    if (best && (best.score >= CONFIDENT || (best.score >= PROBABLE && !(keepCurrent && current && !isCurrent(best))))) {
      const how = { matchedBy: 'auto', score: percent(best.score), uncertain: best.score < CONFIDENT, candidates: guesses };
      if (isCurrent(best)) Object.assign(target.meta, { matchedBy: 'auto', score: how.score }, how.uncertain ? { uncertain: true, candidates: guesses } : {});
      else await this.apply(target, kind, best.provider, best.id, { details: best.details, how });
      if (!how.uncertain) { delete target.meta.uncertain; delete target.meta.candidates; }
      this.store.save();
      return true;
    }
    // A source was offline: leave it as it is so the next scan tries again.
    if (failed && !list.length) return false;
    if (keepCurrent && current) {
      Object.assign(target.meta, { uncertain: true, candidates: guesses, score: list.find(isCurrent) ? percent(list.find(isCurrent).score) : null });
    } else {
      target.meta = { notFound: true, candidates: guesses, fetchedAt: Date.now() };
    }
    this.store.save();
    return false;
  }

  // Admin: "this match is right".
  confirm(target) {
    if (!target.meta?.provider) throw httpError(400, 'This title has no match to confirm');
    target.meta.matchedBy = 'hand';
    delete target.meta.uncertain;
    delete target.meta.candidates;
    this.store.save();
  }

  // Re-run matching over a library's existing matches (except ones an admin chose or confirmed).
  // Runs in the background; `rechecking` shows how far it got.
  recheck(library) {
    if (this.rechecking) throw httpError(409, 'Already re-checking a library');
    const kind = library.type === 'show' ? 'show' : 'movie';
    if (!md.providersFor(kind).length) throw httpError(400, kind === 'movie' ? 'Add a TMDB API key in Settings → Metadata first' : 'No metadata source is available');
    const pool = kind === 'show' ? Object.values(this.store.data.shows) : Object.values(this.store.data.items).filter((i) => i.type === 'movie');
    const todo = pool.filter((t) => t.libraryId === library.id && t.meta?.provider !== 'video' && !t.meta?.unmatched && t.meta?.matchedBy !== 'hand');
    const job = this.rechecking = { libraryId: library.id, library: library.name, done: 0, total: todo.length, changed: 0, review: 0 };
    (async () => {
      for (const t of todo) {
        const before = t.meta?.providerId;
        try { await this.autoMatch(t, kind, { keepCurrent: true }); } catch (err) { console.warn(`[meta] re-check ${t.title}: ${err.message}`); }
        if (t.meta?.providerId !== before) job.changed++;
        if (t.meta?.uncertain || t.meta?.notFound) job.review++;
        job.done++;
      }
    })().finally(() => {
      this.lastRecheck = { ...job, finishedAt: Date.now() };
      this.rechecking = null;
      this.store.save();
    });
    return job;
  }

  async refresh(target, kind) {
    if (kind === 'episode') {
      const show = this.store.data.shows[target.showId];
      if (!show) throw httpError(404, 'Show not found');
      return this.refresh(show, 'show');
    }
    const m = target.meta || {};
    if (m.provider === 'video') return m; // details come from the video's own .info.json
    const provider = m.provider || (m.tmdbId ? 'tmdb' : null);
    const providerId = m.providerId || (m.tmdbId ? String(m.tmdbId) : null);
    if (provider && providerId && md.PROVIDERS[provider]?.enabled()) return this.apply(target, kind, provider, providerId);
    await this.autoMatch(target, kind);
    return target.meta;
  }

  unmatch(target, kind) {
    if (kind === 'episode') throw httpError(400, 'Unmatch the show instead of a single episode');
    target.meta = { unmatched: true, fetchedAt: Date.now() };
    if (kind === 'show') for (const e of this.episodesOf(target)) delete e.meta;
    this.store.save();
  }

  // Background matching during library scans.
  autoEnabled() { return this.settings().autoMatch !== false; }

  async matchLibrary(library, { force = false, onProgress = () => {} } = {}) {
    if (!this.autoEnabled() && !force) return;
    const kind = library.type === 'show' ? 'show' : 'movie';
    if (!md.providersFor(kind).length) return;
    const pool = kind === 'show' ? Object.values(this.store.data.shows) : Object.values(this.store.data.items);
    // (Downloaded videos with their own details are not looked up in movie databases.)
    const todo = pool.filter((t) => t.libraryId === library.id && (kind === 'show' || t.type === 'movie') && t.meta?.provider !== 'video' && (force ? !t.meta?.unmatched : !t.meta));
    let done = 0;
    onProgress(0, todo.length);
    for (const t of todo) {
      try { force && t.meta?.provider ? await this.refresh(t, kind) : await this.autoMatch(t, kind); } catch (err) { console.warn(`[meta] ${t.title}: ${err.message}`); }
      onProgress(++done, todo.length);
    }
    // Shows matched earlier: fill in metadata for newly added episodes.
    if (kind === 'show' && !force) {
      for (const s of pool.filter((t) => t.libraryId === library.id && t.meta?.provider)) {
        if (this.episodesOf(s).some((e) => !e.meta && e.episode != null)) {
          await this.applyEpisodes(s, md.PROVIDERS[s.meta.provider], { providerId: s.meta.providerId }).catch(() => {});
        }
      }
      this.store.save();
    }
  }

  // Movies matched before collections were supported: look up which TMDB collection they belong to.
  async backfillCollections() {
    if (!md.tmdb.enabled()) return;
    const todo = Object.values(this.store.data.items).filter((i) => i.type === 'movie' && i.meta?.provider === 'tmdb' && !('collection' in i.meta));
    for (const it of todo) {
      try {
        const d = await md.tmdb.call(`/movie/${encodeURIComponent(it.meta.providerId)}`);
        const c = d?.belongs_to_collection;
        it.meta.collection = c ? { id: String(c.id), name: c.name } : null;
      } catch (err) { console.warn(`[meta] collection for ${it.title}: ${err.message}`); return; } // offline: try next start
    }
    if (todo.length) this.store.save();
  }

  // ---------- edits ----------
  edit(target, kind, changes) {
    const allowed = EDITABLE[kind];
    const edits = { ...(target.edits || {}) };
    for (const [field, raw] of Object.entries(changes || {})) {
      if (!allowed.includes(field)) continue;
      if (raw === null || raw === '' || (Array.isArray(raw) && !raw.length)) { delete edits[field]; continue; }
      if (field === 'year') {
        const y = Number(raw);
        if (!Number.isInteger(y) || y < 1870 || y > 2200) throw httpError(400, 'Year must be a 4-digit year');
        edits.year = y;
      } else if (field === 'genres') {
        const list = (Array.isArray(raw) ? raw : String(raw).split(',')).map((g) => String(g).trim()).filter(Boolean).slice(0, 20);
        if (list.length) edits.genres = list; else delete edits.genres;
      } else {
        const v = String(raw).trim().slice(0, field === 'overview' ? 5000 : 300);
        if (v) edits[field] = v; else delete edits[field];
      }
    }
    for (const k of ART_KINDS[kind]) if (target.edits?.[k]) edits[k] = target.edits[k];
    edits.updatedAt = Date.now();
    target.edits = edits;
    this.store.save();
    return edits;
  }

  async setArt(target, kind, artKind, { url, buffer }) {
    if (!ART_KINDS[kind].includes(artKind)) throw httpError(400, `A ${kind} has no ${artKind} image`);
    const name = `${target.id}-${artKind}`;
    const file = buffer ? md.saveImage(buffer, this.customDir, name) : await md.downloadImage(url, this.customDir, name);
    const old = target.edits?.[artKind];
    target.edits = { ...(target.edits || {}), [artKind]: file, updatedAt: Date.now() };
    if (old && old !== file && old.startsWith(this.customDir)) fs.rm(old, { force: true }, () => {});
    this.store.save();
  }

  resetArt(target, kind, artKind) {
    if (!ART_KINDS[kind].includes(artKind)) throw httpError(400, `A ${kind} has no ${artKind} image`);
    const old = target.edits?.[artKind];
    if (target.edits) { delete target.edits[artKind]; target.edits.updatedAt = Date.now(); }
    if (old && old.startsWith(this.customDir)) fs.rm(old, { force: true }, () => {});
    this.store.save();
  }

  // Images offered by the matched provider (for the "choose artwork" picker).
  async providerImages(target, kind) {
    const m = target.meta || {};
    const p = md.PROVIDERS[m.provider || (m.tmdbId ? 'tmdb' : '')];
    if (kind === 'episode' || !p?.enabled()) return { poster: [], backdrop: [] };
    const d = await p.details(kind, m.providerId || String(m.tmdbId));
    return d?.images || { poster: [], backdrop: [] };
  }

  // Everything the edit dialog needs.
  describe(target, kind) {
    const fields = {};
    for (const f of EDITABLE[kind]) {
      const base = f === 'sortTitle' ? null : f === 'genres' ? [] : target[f] ?? null;
      fields[f] = { edited: target.edits?.[f] ?? null, fetched: target.meta?.[f] ?? null, file: base };
    }
    return {
      id: target.id, kind, fields,
      art: Object.fromEntries(ART_KINDS[kind].map((k) => [k, !!target.edits?.[k]])),
      match: target.meta?.provider || target.meta?.tmdbId
        ? { provider: target.meta.provider || 'tmdb', providerId: target.meta.providerId || String(target.meta.tmdbId), title: target.meta.title, year: target.meta.year, fetchedAt: target.meta.fetchedAt }
        : null,
      unmatched: !!target.meta?.unmatched,
      notFound: !!target.meta?.notFound,
      searchTitle: kind === 'episode' ? null : target.title,
      searchYear: kind === 'episode' ? null : target.year || null,
    };
  }
}

module.exports = { Matcher, EDITABLE, ART_KINDS, similarity, scoreResults, runtimePoints, CONFIDENT, PROBABLE };
