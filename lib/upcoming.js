'use strict';
// "Coming soon" on the home page: new episodes of shows in the libraries, and films on their way
// (in Radarr, so not here yet) with their release dates.
//
// Episodes come from Sonarr's calendar when Sonarr is connected; shows it doesn't follow (or
// without Sonarr) from TMDB / TVmaze's "next episode" for the shows people have been watching.
// Films come from Radarr's calendar. Worked out every few hours and kept in memory.

const { canSeeTitle } = require('./ratings');

const DAYS_AHEAD = 30;
const REFRESH_MS = 3 * 3600_000;
const MAX_LOOKUPS = 60; // shows looked up on TMDB / TVmaze per round
const RECENT_MS = 90 * 86400_000;

const norm = (s) => String(s || '').toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, '');
const ymd = (d) => d.toISOString().slice(0, 10);

class Upcoming {
  // nextEpisodeOf(provider, id): { season, episode, title, airDate } | null (metadata.js).
  constructor(store, arr, { nextEpisodeOf = async () => null } = {}) {
    this.store = store;
    this.arr = arr;
    this.nextEpisodeOf = nextEpisodeOf;
    this.items = [];
    this.at = 0;
    this.running = null;
  }

  // Library shows by their ids at TMDB / TVmaze, and by name.
  showIndex() {
    const byId = new Map(), byName = new Map();
    for (const s of Object.values(this.store.data.shows)) {
      if (s.meta?.provider && s.meta.providerId) byId.set(`${s.meta.provider}:${s.meta.providerId}`, s);
      byName.set(norm(s.edits?.title || s.meta?.title || s.title), s);
    }
    return { byId, byName };
  }

  episode(show, { season, episode, title, airDate }) {
    return {
      type: 'upcoming', kind: 'episode', id: `up-${show.id}-${season}-${episode}`, showId: show.id,
      title: show.edits?.title || show.meta?.title || show.title, episodeTitle: title || null, season, episode, airDate,
      artV: `${show.edits?.updatedAt || 0}${show.meta?.fetchedAt || 0}`, href: `#/show/${show.id}`,
    };
  }

  async refresh(now = new Date()) {
    if (this.running) return this.running;
    this.running = this.build(now).finally(() => { this.running = null; });
    return this.running;
  }

  async build(now) {
    const start = new Date(now.getTime() - 12 * 3600_000), end = new Date(now.getTime() + DAYS_AHEAD * 86400_000);
    const out = [];
    const covered = new Set(); // shows Sonarr told us about
    const { byId, byName } = this.showIndex();

    if (this.arr.connected('sonarr')) {
      try {
        const eps = await this.arr.call('sonarr', 'GET', '/calendar', { query: { start: ymd(start), end: ymd(end), includeSeries: true, unmonitored: false } });
        for (const e of eps || []) {
          const s = e.series || {};
          const show = byId.get(`tmdb:${s.tmdbId}`) || byId.get(`tvmaze:${s.tvMazeId}`) || byName.get(norm(s.title));
          if (!show) continue;
          covered.add(show.id);
          if (e.hasFile || !e.airDateUtc || new Date(e.airDateUtc) < start) continue;
          out.push(this.episode(show, { season: e.seasonNumber, episode: e.episodeNumber, title: e.title, airDate: e.airDateUtc }));
        }
      } catch (err) { console.warn(`[upcoming] Sonarr: ${err.message}`); }
    }

    // Shows people have watched lately that Sonarr didn't cover: their next episode, from TMDB / TVmaze.
    const recent = new Set();
    for (const map of Object.values(this.store.data.progress || {})) {
      for (const [id, p] of Object.entries(map)) {
        if (now.getTime() - (p.updatedAt || 0) > RECENT_MS) continue;
        const it = this.store.data.items[id];
        if (it?.showId) recent.add(it.showId);
      }
    }
    let looked = 0;
    for (const showId of recent) {
      const show = this.store.data.shows[showId];
      if (!show?.meta?.provider || covered.has(show.id) || looked >= MAX_LOOKUPS) continue;
      looked++;
      try {
        const n = await this.nextEpisodeOf(show.meta.provider, show.meta.providerId);
        if (n && new Date(n.airDate) >= start && new Date(n.airDate) <= end) out.push(this.episode(show, n));
      } catch { /* that source is down: next time */ }
    }

    if (this.arr.connected('radarr')) {
      try {
        const films = await this.arr.call('radarr', 'GET', '/calendar', { query: { start: ymd(start), end: ymd(end), unmonitored: false } });
        for (const f of films || []) {
          if (f.hasFile) continue;
          const dates = [['In cinemas', f.inCinemas], ['To stream or buy', f.digitalRelease], ['On disc', f.physicalRelease]]
            .filter(([, d]) => d && new Date(d) >= start && new Date(d) <= end).sort((a, b) => new Date(a[1]) - new Date(b[1]));
          if (!dates.length) continue;
          const img = (f.images || []).find((i) => i.coverType === 'fanart') || (f.images || []).find((i) => i.coverType === 'poster');
          out.push({
            type: 'upcoming', kind: 'movie', id: `up-m-${f.tmdbId || f.id}`, title: f.title, year: f.year || null,
            airDate: dates[0][1], release: dates[0][0], image: /^https:\/\//.test(img?.remoteUrl || '') ? img.remoteUrl : null, href: '#/requests',
          });
        }
      } catch (err) { console.warn(`[upcoming] Radarr: ${err.message}`); }
    }

    // One card per show (its next episode), soonest first.
    const seen = new Set();
    this.items = out.sort((a, b) => new Date(a.airDate) - new Date(b.airDate))
      .filter((x) => { const k = x.showId || x.id; if (seen.has(k)) return false; seen.add(k); return true; });
    this.at = Date.now();
    return this.items;
  }

  /** What this person sees: shows they can watch; films only for those without a maturity limit. */
  forUser(user, limit = 20) {
    return this.items.filter((x) => (x.showId ? canSeeTitle(this.store, user, this.store.data.shows[x.showId]) : user.role === 'admin' || user.maxAge == null))
      .slice(0, limit);
  }

  start() {
    const go = () => this.refresh().catch((err) => console.warn(`[upcoming] ${err.message}`));
    setTimeout(go, 45_000).unref();
    setInterval(go, Number(process.env.UPCOMING_REFRESH_MS) || REFRESH_MS).unref();
  }
}

module.exports = { Upcoming };
