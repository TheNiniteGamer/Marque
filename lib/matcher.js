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

const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const norm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^\p{L}\p{N}]+/gu, '');

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

  episodesOf(show) { return Object.values(this.store.data.items).filter((e) => e.showId === show.id); }

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

  async apply(target, kind, providerId, id) {
    if (kind === 'episode') throw httpError(400, 'Match the show instead of a single episode');
    const p = md.PROVIDERS[providerId];
    if (!p || !p.kinds.includes(kind)) throw httpError(400, 'Unknown metadata source');
    if (!p.enabled()) throw httpError(400, `${p.name} is not configured`);
    const d = await p.details(kind, id);
    if (!d) throw httpError(404, `${p.name} has no entry with id ${id}`);
    const img = (url, suffix) => md.downloadImage(url, this.imagesDir, `${target.id}-${suffix}`).catch(() => null);
    target.meta = {
      provider: p.id, providerId: d.providerId,
      title: d.title || null, year: d.year || null, overview: d.overview, tagline: d.tagline, genres: d.genres || [],
      rating: d.rating, cast: d.cast || [],
      ...(kind === 'movie' ? { collection: d.collection || null } : {}),
      poster: await img(d.posterUrl, 'poster'), backdrop: await img(d.backdropUrl, 'backdrop'),
      fetchedAt: Date.now(),
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

  // Pick the best search result: exact title and year beat the provider's own ranking.
  best(results, title, year) {
    let best = null, bestScore = -1;
    results.forEach((r, i) => {
      let score = 0;
      if (norm(r.title) === norm(title)) score += 2;
      if (year && r.year === year) score += 1.5;
      else if (year && r.year && Math.abs(r.year - year) === 1) score += 0.5;
      score -= i * 0.01;
      if (score > bestScore) { best = r; bestScore = score; }
    });
    return best;
  }

  async autoMatch(target, kind) {
    const query = target.title;
    const year = target.year || null;
    let failed = false; // did any provider fail to answer?
    for (const p of md.providersFor(kind)) {
      let results;
      try { results = await p.search(kind, query, year); } catch (err) { failed = true; console.warn(`[meta] ${p.name} search "${query}": ${err.message}`); continue; }
      const pick = this.best(results, query, year);
      if (pick) {
        try { await this.apply(target, kind, pick.provider, pick.id); return true; } catch (err) { console.warn(`[meta] ${p.name} ${pick.id}: ${err.message}`); }
      }
    }
    // A source was offline or down: leave it unmatched so the next scan tries again.
    if (failed) return false;
    target.meta = { notFound: true, fetchedAt: Date.now() };
    this.store.save();
    return false;
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

module.exports = { Matcher, EDITABLE, ART_KINDS };
