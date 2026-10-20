'use strict';
// Radarr (films) and Sonarr (shows): approved requests are added to them, they find and download
// the file into a folder Marquee watches, and the request turns "here" when it shows up.
//
// Each app needs its address and API key (Radarr/Sonarr → Settings → General), the quality profile
// requests are added with (the profile decides the biggest size: an "HD-1080p" profile keeps 4K
// files out) and the root folder they go to. For Sonarr also which seasons to get, since a long
// show can be hundreds of gigabytes. Talks to their v3 API (Radarr 3–5, Sonarr 3 and 4).
//
// store.data.settings.arr = { radarr: { url, apiKey, profileId, rootFolder, search },
//                             sonarr: { url, apiKey, profileId, rootFolder, search, monitor } }
// request.arr = { app, id, title, profile, monitor, seasons, sentAt, auto, existing } once sent, or
//               { app, error, failedAt } when sending failed (shown with Retry).

const APPS = {
  radarr: { name: 'Radarr', kind: 'movie', port: 7878 },
  sonarr: { name: 'Sonarr', kind: 'show', port: 8989 },
};
// Which seasons of a show Sonarr gets (its own "monitor" options).
const MONITOR = {
  firstSeason: 'First season only',
  latestSeason: 'Latest season only',
  future: 'New episodes from now on',
  all: 'Every season',
};
const TIMEOUT_MS = 15_000;
const STATUS_TTL_MS = 5_000;

const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const appFor = (kind) => (kind === 'show' ? 'sonarr' : 'radarr');
const cleanUrl = (u) => String(u || '').trim().replace(/\/+$/, '').replace(/\/api(\/v3)?$/i, '');

class Arr {
  // tvdbIdOf(provider, id): a show's TheTVDB id. libraryFor(path): the Marquee library a folder
  // on the PC belongs to (shown next to Radarr's root folders), or null.
  constructor(store, { tvdbIdOf = async () => null, libraryFor = () => null, fetchImpl = (...a) => fetch(...a) } = {}) {
    this.store = store;
    this.tvdbIdOf = tvdbIdOf;
    this.libraryFor = libraryFor;
    this.fetch = fetchImpl;
    this.cache = new Map(); // app -> { at, queue, items: Map(id -> record) }
    this.versions = {}; // app -> version string (Sonarr 3 needs a language profile)
    this.lastError = {}; // app -> { at, message } (health check)
  }

  settings(app) { return this.store.data.settings?.arr?.[app] || {}; }
  connected(app) { const s = this.settings(app); return !!(s.url && s.apiKey); }
  /** Whether requests for this kind go to Radarr / Sonarr (connected, with a profile and folder). */
  ready(kind) { const s = this.settings(appFor(kind)); return !!(s.url && s.apiKey && s.profileId && s.rootFolder); }

  /** For the settings page: never the API key itself. */
  publicSettings() {
    const out = {};
    for (const [app, info] of Object.entries(APPS)) {
      const s = this.settings(app);
      out[app] = {
        name: info.name, kind: info.kind, url: s.url || '', keySet: !!s.apiKey, keyHint: s.apiKey ? `…${s.apiKey.slice(-4)}` : null,
        profileId: s.profileId || null, profileName: s.profileName || null, rootFolder: s.rootFolder || null, search: s.search !== false,
        ...(app === 'sonarr' ? { monitor: s.monitor || 'firstSeason' } : {}),
        ready: this.ready(info.kind), suggestedUrl: `http://host.docker.internal:${info.port}`,
        lastError: this.lastError[app] || null,
      };
    }
    return { ...out, monitorOptions: MONITOR };
  }

  // ---- talking to them ----
  async call(app, method, pathname, { query, body, conn } = {}) {
    const s = conn || this.settings(app);
    if (!s.url || !s.apiKey) throw httpError(400, `${APPS[app].name} isn't connected (Settings → Radarr & Sonarr)`);
    const url = new URL(`${cleanUrl(s.url)}/api/v3${pathname}`);
    for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
    let res;
    try {
      res = await this.fetch(url, {
        method, headers: { 'X-Api-Key': s.apiKey, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const why = err.name === 'TimeoutError' ? 'it didn’t answer in time' : (err.cause?.code || err.message);
      throw this.failed(app, 502, `Can’t reach ${APPS[app].name} at ${cleanUrl(s.url)} (${why}). Is it running? From Docker, use ${`http://host.docker.internal:${APPS[app].port}`}.`);
    }
    if (res.status === 401) throw this.failed(app, 502, `${APPS[app].name} turned down the API key (Settings → General → API Key in ${APPS[app].name})`);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      // Their validation errors come as [{ errorMessage }]; others as { message }.
      const msg = Array.isArray(data) ? data.map((e) => e.errorMessage).filter(Boolean).join('; ') : data?.message;
      const err = this.failed(app, res.status === 404 ? 404 : 502, `${APPS[app].name}: ${msg || `HTTP ${res.status}`}`);
      err.arrStatus = res.status;
      throw err;
    }
    if (data === null && text) throw this.failed(app, 502, `That address doesn’t look like ${APPS[app].name} (it didn’t answer with JSON)`);
    delete this.lastError[app];
    return data;
  }
  failed(app, status, message) {
    if (status !== 404) this.lastError[app] = { at: Date.now(), message };
    return httpError(status, message);
  }

  /** Check an address and key (typed in, or the saved ones) and list what can be picked. */
  async test(app, { url, apiKey } = {}) {
    const saved = this.settings(app);
    const conn = { url: cleanUrl(url || saved.url), apiKey: apiKey || saved.apiKey };
    if (!/^https?:\/\/[^/\s]+/i.test(conn.url)) throw httpError(400, `Enter ${APPS[app].name}’s address, like http://host.docker.internal:${APPS[app].port}`);
    if (!conn.apiKey) throw httpError(400, `Enter ${APPS[app].name}’s API key`);
    const st = await this.call(app, 'GET', '/system/status', { conn });
    if (st?.appName && st.appName.toLowerCase() !== app) throw httpError(400, `That address is ${st.appName}, not ${APPS[app].name}`);
    this.versions[app] = st?.version || null;
    const [profiles, folders] = await Promise.all([this.call(app, 'GET', '/qualityprofile', { conn }), this.call(app, 'GET', '/rootfolder', { conn })]);
    return { version: st?.version || null, profiles: (profiles || []).map(profileView), rootFolders: (folders || []).map((f) => this.folderView(f)) };
  }

  /** The saved connection's profiles and folders (approving a request picks from them). */
  async options(app) {
    const r = await this.test(app);
    const s = this.settings(app);
    return { ...r, defaults: { profileId: s.profileId || null, rootFolder: s.rootFolder || null, monitor: s.monitor || 'firstSeason' }, monitorOptions: app === 'sonarr' ? MONITOR : undefined };
  }

  folderView(f) {
    return { path: f.path, freeSpace: f.freeSpace ?? null, accessible: f.accessible !== false, library: this.libraryFor(f.path) };
  }

  /** Save settings; the address and key are checked first, and the profile and folder must exist. */
  async update(app, input = {}) {
    if (!APPS[app]) throw httpError(404, 'Unknown app');
    const cur = this.settings(app);
    const next = { ...cur };
    if (input.url !== undefined) next.url = cleanUrl(input.url);
    if (input.apiKey) next.apiKey = String(input.apiKey).trim();
    if (input.search !== undefined) next.search = !!input.search;
    if (app === 'sonarr' && input.monitor !== undefined) {
      if (!MONITOR[input.monitor]) throw httpError(400, `Seasons must be one of: ${Object.keys(MONITOR).join(', ')}`);
      next.monitor = input.monitor;
    }
    const opts = await this.test(app, next);
    if (input.profileId !== undefined) {
      const p = opts.profiles.find((x) => x.id === Number(input.profileId));
      if (!p) throw httpError(400, 'Pick one of the quality profiles');
      Object.assign(next, { profileId: p.id, profileName: p.name });
    }
    if (input.rootFolder !== undefined) {
      if (!opts.rootFolders.some((f) => f.path === input.rootFolder)) throw httpError(400, 'Pick one of the root folders');
      next.rootFolder = input.rootFolder;
    }
    const st = (this.store.data.settings ||= {});
    (st.arr ||= {})[app] = next;
    this.store.save();
    return this.publicSettings()[app];
  }

  disconnect(app) {
    if (this.store.data.settings?.arr) delete this.store.data.settings.arr[app];
    delete this.lastError[app];
    this.cache.delete(app);
    this.store.save();
  }

  // ---- adding a request ----
  /**
   * Adds a request's film or show (already there: just linked) and starts the search.
   * opts: { profileId, monitor } to override the defaults. Resolves to the request's `arr` record.
   */
  async add(request, opts = {}) {
    const app = appFor(request.kind);
    const s = this.settings(app);
    if (!this.ready(request.kind)) throw httpError(400, `${APPS[app].name} isn’t set up yet (Settings → Radarr & Sonarr)`);
    const profileId = Number(opts.profileId) || s.profileId;
    const profiles = (await this.call(app, 'GET', '/qualityprofile')).map(profileView);
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) throw httpError(400, `The quality profile isn’t in ${APPS[app].name} any more; pick another in Settings`);
    const search = s.search !== false;
    if (app === 'sonarr' && request.seasons?.length) return this.addSeasons(request, profile, profiles, search);
    if (app === 'radarr') {
      const tmdbId = request.provider === 'tmdb' ? Number(request.providerId) : null;
      if (tmdbId) {
        const have = await this.call(app, 'GET', '/movie', { query: { tmdbId } });
        if (have?.length) return this.record(app, have[0], profile, { existing: true });
      }
      const found = tmdbId ? await this.call(app, 'GET', '/movie/lookup/tmdb', { query: { tmdbId } }) : pickByYear(await this.call(app, 'GET', '/movie/lookup', { query: { term: `${request.title}${request.year ? ` ${request.year}` : ''}` } }), request.year);
      if (!found?.tmdbId) throw httpError(404, `Radarr couldn’t find ${request.title}${request.year ? ` (${request.year})` : ''}`);
      if (found.id) return this.record(app, found, profile, { existing: true }); // (lookups say when it's already added)
      const added = await this.call(app, 'POST', '/movie', {
        body: { ...found, qualityProfileId: profile.id, rootFolderPath: s.rootFolder, monitored: true, minimumAvailability: 'released', addOptions: { searchForMovie: search } },
      });
      return this.record(app, added, profile);
    }
    // Sonarr knows shows by their TheTVDB id.
    const tvdbId = request.provider ? Number(await this.tvdbIdOf(request.provider, request.providerId).catch(() => null)) || null : null;
    if (tvdbId) {
      const have = await this.call(app, 'GET', '/series', { query: { tvdbId } });
      if (have?.length) return this.record(app, have[0], profile, { existing: true });
    }
    const results = await this.call(app, 'GET', '/series/lookup', { query: { term: tvdbId ? `tvdb:${tvdbId}` : request.title } });
    const found = tvdbId ? (results || []).find((x) => x.tvdbId === tvdbId) || results?.[0] : pickByYear(results, request.year);
    if (!found?.tvdbId) throw httpError(404, `Sonarr couldn’t find ${request.title}${request.year ? ` (${request.year})` : ''}`);
    if (found.id) return this.record(app, found, profile, { existing: true });
    const monitor = MONITOR[opts.monitor] ? opts.monitor : s.monitor || 'firstSeason';
    const body = {
      ...found, qualityProfileId: profile.id, rootFolderPath: s.rootFolder, seasonFolder: true, monitored: true,
      addOptions: { monitor, searchForMissingEpisodes: search, searchForCutoffUnmetEpisodes: false },
    };
    // Sonarr 3 also wants a language profile (Sonarr 4 has none).
    if (!this.versions[app]) this.versions[app] = (await this.call(app, 'GET', '/system/status'))?.version || null;
    if (/^3\./.test(this.versions[app] || '')) body.languageProfileId = (await this.call(app, 'GET', '/languageprofile'))?.[0]?.id || 1;
    const added = await this.call(app, 'POST', '/series', { body });
    return this.record(app, added, profile, { monitor });
  }

  // "More seasons of a show": the show is added to Sonarr if it isn't there (watching nothing),
  // then those seasons are watched and searched for. Seasons it already had stay as they were.
  async addSeasons(request, profile, profiles, search) {
    const app = 'sonarr';
    const s = this.settings(app);
    const tvdbId = request.provider ? Number(await this.tvdbIdOf(request.provider, request.providerId).catch(() => null)) || null : null;
    let series = tvdbId ? (await this.call(app, 'GET', '/series', { query: { tvdbId } }))?.[0] : null;
    let existing = !!series;
    if (!series) {
      const results = await this.call(app, 'GET', '/series/lookup', { query: { term: tvdbId ? `tvdb:${tvdbId}` : request.title } });
      const found = tvdbId ? (results || []).find((x) => x.tvdbId === tvdbId) || results?.[0] : pickByYear(results, request.year);
      if (!found?.tvdbId) throw httpError(404, `Sonarr couldn’t find ${request.title}${request.year ? ` (${request.year})` : ''}`);
      if (found.id) { series = found; existing = true; } else {
        const body = { ...found, qualityProfileId: profile.id, rootFolderPath: s.rootFolder, seasonFolder: true, monitored: true,
          seasons: (found.seasons || []).map((x) => ({ ...x, monitored: false })), addOptions: { monitor: 'none', searchForMissingEpisodes: false } };
        if (!this.versions[app]) this.versions[app] = (await this.call(app, 'GET', '/system/status'))?.version || null;
        if (/^3\./.test(this.versions[app] || '')) body.languageProfileId = (await this.call(app, 'GET', '/languageprofile'))?.[0]?.id || 1;
        series = await this.call(app, 'POST', '/series', { body });
      }
    }
    await this.watchSeasons(series.id, request.seasons, search);
    const used = profiles.find((p) => p.id === series.qualityProfileId) || profile;
    return { ...this.record(app, series, used, { existing }), seasons: [...request.seasons] };
  }

  // Sonarr watches these seasons (and the episodes in them) and looks for each.
  async watchSeasons(seriesId, seasons, search = true) {
    const series = await this.call('sonarr', 'GET', `/series/${seriesId}`);
    const want = new Set(seasons.map(Number));
    const known = new Set((series.seasons || []).map((x) => x.seasonNumber));
    const updated = {
      ...series, monitored: true,
      seasons: [...(series.seasons || []).map((x) => (want.has(x.seasonNumber) ? { ...x, monitored: true } : x)),
        ...[...want].filter((n) => !known.has(n)).map((n) => ({ seasonNumber: n, monitored: true }))],
    };
    await this.call('sonarr', 'PUT', `/series/${seriesId}`, { body: updated });
    if (search) for (const n of want) await this.call('sonarr', 'POST', '/command', { body: { name: 'SeasonSearch', seriesId, seasonNumber: n } });
    this.cache.delete('sonarr');
  }

  /** Look again for a request that hasn't been found (only its seasons, for a seasons request). */
  async searchAgain(request) {
    const { app, id, seasons } = request.arr || {};
    if (!id) throw httpError(400, 'This request isn’t in Radarr or Sonarr');
    if (app === 'radarr') await this.call(app, 'POST', '/command', { body: { name: 'MoviesSearch', movieIds: [id] } });
    else if (seasons?.length) for (const n of seasons) await this.call(app, 'POST', '/command', { body: { name: 'SeasonSearch', seriesId: id, seasonNumber: n } });
    else await this.call(app, 'POST', '/command', { body: { name: 'SeriesSearch', seriesId: id } });
    this.cache.delete(app);
  }

  /** Move a sent request to another quality profile (when none turned up at that one) and look again. */
  async changeProfile(request, profileId) {
    const { app, id } = request.arr || {};
    if (!id) throw httpError(400, 'This request isn’t in Radarr or Sonarr');
    const profile = (await this.call(app, 'GET', '/qualityprofile')).map(profileView).find((p) => p.id === Number(profileId));
    if (!profile) throw httpError(400, 'Pick one of the quality profiles');
    const kind = app === 'radarr' ? 'movie' : 'series';
    const item = await this.call(app, 'GET', `/${kind}/${id}`);
    await this.call(app, 'PUT', `/${kind}/${id}`, { body: { ...item, qualityProfileId: profile.id } });
    await this.searchAgain(request);
    return profile;
  }

  /** Free space (bytes) in the folder downloads go to, or null when it can't be told. */
  async freeSpace(kind) {
    const app = appFor(kind);
    const folders = await this.call(app, 'GET', '/rootfolder');
    return (folders || []).find((x) => x.path === this.settings(app).rootFolder)?.freeSpace ?? null;
  }

  record(app, x, profile, { existing = false, monitor = null } = {}) {
    this.cache.delete(app);
    return { app, id: x.id, title: x.title, profile: profile.name, maxRes: profile.maxRes, monitor, existing, sentAt: Date.now() };
  }

  // ---- how it's going ----
  /**
   * Live state of sent requests: { [requestId]: { state, label, percent, … } }. state is one of
   * downloading, importing, searching, notReleased, partial, downloaded, gone, unknown.
   */
  async progress(requests) {
    const out = {};
    for (const app of Object.keys(APPS)) {
      const mine = requests.filter((r) => r.arr?.app === app && r.arr.id && (r.status === 'approved' || r.status === 'pending'));
      if (!mine.length || !this.connected(app)) continue;
      let data;
      try { data = await this.snapshot(app, mine.map((r) => r.arr.id)); } catch (err) {
        for (const r of mine) out[r.id] = { state: 'unknown', label: err.message };
        continue;
      }
      for (const r of mine) {
        out[r.id] = describe(app, data.items.get(r.arr.id), data.queue.filter((q) => (app === 'radarr' ? q.movieId : q.seriesId) === r.arr.id
          && (!r.arr.seasons || q.seasonNumber == null || r.arr.seasons.includes(q.seasonNumber))), r.arr.seasons);
      }
    }
    return out;
  }

  // Their download queue and the films / shows asked about, kept for a few seconds.
  async snapshot(app, ids) {
    const c = this.cache.get(app);
    if (c && Date.now() - c.at < STATUS_TTL_MS && ids.every((id) => c.items.has(id))) return c;
    const queue = (await this.call(app, 'GET', '/queue', { query: { pageSize: 500 } }))?.records || [];
    const items = new Map();
    for (const id of new Set(ids)) {
      try { items.set(id, await this.call(app, 'GET', `/${app === 'radarr' ? 'movie' : 'series'}/${id}`)); } catch (err) {
        if (err.arrStatus === 404) items.set(id, null); else throw err; // null: removed from Radarr / Sonarr
      }
    }
    const snap = { at: Date.now(), queue, items };
    this.cache.set(app, snap);
    return snap;
  }
}

// "HD-1080p" → { id, name, maxRes: 1080 }: the biggest picture the profile lets in.
function profileView(p) {
  let maxRes = 0;
  const visit = (items) => {
    for (const it of items || []) {
      if (it.items?.length) { if (it.allowed !== false) visit(it.items.map((x) => ({ ...x, allowed: x.allowed ?? it.allowed }))); continue; }
      if (it.allowed && it.quality?.resolution > maxRes) maxRes = it.quality.resolution;
    }
  };
  visit(p.items);
  return { id: p.id, name: p.name, maxRes: maxRes || null };
}

function pickByYear(list, year) {
  if (!Array.isArray(list) || !list.length) return null;
  return (year && list.find((x) => x.year === year)) || list[0];
}

const fmtLeft = (t) => {
  const m = /^(?:(\d+)\.)?(\d+):(\d+):(\d+)/.exec(t || '');
  if (!m) return null;
  const mins = Number(m[1] || 0) * 1440 + Number(m[2]) * 60 + Number(m[3]);
  return mins < 1 ? 'under a minute left' : mins < 60 ? `${mins} min left` : `${Math.round(mins / 6) / 10} h left`;
};

// Sonarr's counts for the whole show, or only for the seasons a request asked for.
function seasonStats(item, seasons) {
  if (!seasons?.length) return item.statistics || {};
  const picked = (item.seasons || []).filter((x) => seasons.includes(x.seasonNumber)).map((x) => x.statistics || {});
  const episodeFileCount = picked.reduce((n, x) => n + (x.episodeFileCount || 0), 0);
  const episodeCount = picked.reduce((n, x) => n + (x.episodeCount || 0), 0);
  return { episodeFileCount, episodeCount, percentOfEpisodes: episodeCount ? (100 * episodeFileCount) / episodeCount : 0 };
}

function describe(app, item, queue, seasons = null) {
  if (item === null) return { state: 'gone', label: `Removed from ${APPS[app].name}` };
  if (!item) return { state: 'unknown', label: '' };
  if (queue.length) {
    const size = queue.reduce((n, q) => n + (q.size || 0), 0), left = queue.reduce((n, q) => n + (q.sizeleft || 0), 0);
    const percent = size ? Math.round((100 * (size - left)) / size) : 0;
    const importing = queue.some((q) => /import/i.test(q.trackedDownloadState || ''));
    const problem = queue.find((q) => q.trackedDownloadStatus === 'warning' || q.trackedDownloadStatus === 'error');
    const eps = app === 'sonarr' ? ` (${queue.length} episode${queue.length === 1 ? '' : 's'})` : '';
    if (importing) return { state: 'importing', label: `Downloaded, being added${eps}`, percent: 100 };
    const why = problem?.statusMessages?.[0]?.messages?.[0] || problem?.errorMessage;
    return { state: 'downloading', label: `Downloading${eps} · ${percent}%${fmtLeft(queue[0].timeleft) ? ` · ${fmtLeft(queue[0].timeleft)}` : ''}${why ? ` · ${why}` : ''}`, percent };
  }
  if (app === 'radarr') {
    if (item.hasFile) return { state: 'downloaded', label: 'Downloaded, appearing here shortly', percent: 100 };
    if (item.isAvailable === false) {
      const when = item.digitalRelease || item.physicalRelease || item.inCinemas;
      return { state: 'notReleased', label: when ? `Not out yet (expected ${String(when).slice(0, 10)})` : 'Not out yet', releaseDate: when || null };
    }
    return { state: 'searching', label: 'Looking for a copy' };
  }
  const st = seasonStats(item, seasons);
  if (st.episodeCount > 0 && st.episodeFileCount >= st.episodeCount) return { state: 'downloaded', label: `All ${st.episodeFileCount} episodes downloaded`, percent: 100 };
  if (st.episodeFileCount > 0) return { state: 'partial', label: `${st.episodeFileCount} of ${st.episodeCount} episodes downloaded`, percent: Math.round(st.percentOfEpisodes || 0) };
  if (item.status === 'upcoming' || (!st.episodeCount && item.status !== 'ended')) return { state: 'notReleased', label: 'No episodes out yet' };
  return { state: 'searching', label: 'Looking for episodes' };
}

module.exports = { Arr, APPS, MONITOR, appFor, profileView, describe };
