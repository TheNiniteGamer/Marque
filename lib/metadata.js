'use strict';
// Online metadata providers, normalised to one shape:
//   TMDB  (movies + TV, needs a free API key: Settings → Metadata, or TMDB_API_KEY / TMDB_TOKEN)
//   TVmaze (TV only, no key needed)
//   TheTVDB (TV only, needs a project key, and a subscriber PIN with a "user-supported" key:
//            Settings → Metadata, or TVDB_API_KEY / TVDB_PIN). Sonarr numbers episodes its way.
// Base URLs can be overridden (used by the tests to point at a mock server).

const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const net = require('node:net');
const crypto = require('node:crypto');

const TMDB_API = process.env.TMDB_API_BASE || 'https://api.themoviedb.org/3';
const TMDB_IMG = process.env.TMDB_IMAGE_BASE || 'https://image.tmdb.org/t/p';
const TVMAZE_API = process.env.TVMAZE_API_BASE || 'https://api.tvmaze.com';
const TVDB_API = process.env.TVDB_API_BASE || 'https://api4.thetvdb.com/v4';
const TVDB_IMG = 'https://artworks.thetvdb.com';
const MAX_IMAGE = 15 * 1024 * 1024;

let settings = () => ({});
// The server passes a getter for the admin-editable settings (key, language).
function configure(getSettings) { settings = getSettings; }

const tmdbCredentials = (override) => {
  const key = override ?? settings().tmdbKey ?? process.env.TMDB_API_KEY ?? '';
  const token = process.env.TMDB_TOKEN || '';
  return { key: String(key).trim(), token };
};
const tvdbCredentials = (override = {}) => ({
  key: String(override.key ?? settings().tvdbKey ?? process.env.TVDB_API_KEY ?? '').trim(),
  pin: String(override.pin ?? settings().tvdbPin ?? process.env.TVDB_PIN ?? '').trim(),
});
const language = () => settings().language || process.env.METADATA_LANGUAGE || 'en-US';
// Whose maturity ratings to use: the language's country ("en-GB" -> GB), else the US.
const region = () => (process.env.RATINGS_COUNTRY || (/-([A-Z]{2})$/i.exec(language())?.[1]) || 'US').toUpperCase();

// TMDB's certifications for a film (release_dates) or show (content_ratings), for our country first.
function certificationOf(isMovie, d) {
  const want = [region(), 'US'];
  if (isMovie) {
    for (const cc of want) {
      const r = (d.release_dates?.results || []).find((x) => x.iso_3166_1 === cc);
      const c = (r?.release_dates || []).map((x) => x.certification).find(Boolean);
      if (c) return c;
    }
  } else {
    for (const cc of want) {
      const r = (d.content_ratings?.results || []).find((x) => x.iso_3166_1 === cc);
      if (r?.rating) return r.rating;
    }
  }
  return null;
}
const yearOf = (date) => (date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null);
const stripHtml = (s) => (s ? String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() || null : null);

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).host} returned HTTP ${res.status}`), { status: res.status });
  return res.json();
}

const { rating: ratingFor } = require('./ratings');

/** The first 15 of a TMDB cast, with a photo when there is one. */
function castOf(credits, t) {
  return (credits?.cast || []).slice(0, 15).map((c) => ({ name: c.name, character: c.character || null, ...(c.profile_path ? { photo: t.img(c.profile_path, 'w185') } : {}) }));
}

// ---------------- TMDB ----------------
const tmdb = {
  id: 'tmdb',
  name: 'TMDB',
  kinds: ['movie', 'show'],
  enabled: () => { const c = tmdbCredentials(); return !!(c.key || c.token); },

  async call(pathname, params = {}, keyOverride) {
    const url = new URL(TMDB_API + pathname);
    for (const [k, v] of Object.entries({ language: language(), ...params })) if (v != null && v !== '') url.searchParams.set(k, v);
    const { key, token } = tmdbCredentials(keyOverride);
    const headers = {};
    if (key) url.searchParams.set('api_key', key);
    else if (token) headers.authorization = `Bearer ${token}`;
    return getJson(url, headers);
  },

  img: (p, size) => (p ? `${TMDB_IMG}/${size}${p}` : null),

  // Used by the Settings "Test" button.
  async test(key) {
    try { await this.call('/configuration', {}, key); return { ok: true }; } catch (err) {
      return { ok: false, error: err.status === 401 ? 'TMDB rejected this API key' : err.message };
    }
  },

  async search(kind, query, year) {
    const isMovie = kind === 'movie';
    const run = (y) => this.call(isMovie ? '/search/movie' : '/search/tv', { query, ...(y ? (isMovie ? { year: y } : { first_air_date_year: y }) : {}) });
    let res = await run(year);
    if (!res?.results?.length && year) res = await run(null);
    return (res?.results || []).slice(0, 12).map((r) => ({
      provider: 'tmdb', id: String(r.id), title: isMovie ? r.title : r.name,
      originalTitle: (isMovie ? r.original_title : r.original_name) || null,
      year: yearOf(isMovie ? r.release_date : r.first_air_date),
      overview: r.overview || null, thumb: this.img(r.poster_path, 'w185'),
    }));
  },

  // TMDB id of a film or show known by its IMDb ("tt0133093") or TheTVDB id.
  async find(kind, { imdb, tvdb }) {
    const id = imdb || tvdb;
    if (!id) return null;
    const r = await this.call(`/find/${encodeURIComponent(id)}`, { external_source: imdb ? 'imdb_id' : 'tvdb_id' });
    const hit = (kind === 'movie' ? r?.movie_results : r?.tv_results)?.[0];
    return hit ? String(hit.id) : null;
  },

  async details(kind, id) {
    const isMovie = kind === 'movie';
    const d = await this.call(`/${isMovie ? 'movie' : 'tv'}/${encodeURIComponent(id)}`,
      { append_to_response: `credits,images,keywords,${isMovie ? 'release_dates' : 'content_ratings'}`, include_image_language: `${language().slice(0, 2)},en,null` });
    if (!d) return null;
    const images = d.images || {};
    return {
      provider: 'tmdb', providerId: String(d.id),
      title: isMovie ? d.title : d.name,
      year: yearOf(isMovie ? d.release_date : d.first_air_date),
      overview: d.overview || null,
      tagline: d.tagline || null,
      runtime: isMovie ? d.runtime || null : null, // minutes
      genres: (d.genres || []).map((g) => g.name),
      rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
      contentRating: ratingFor(certificationOf(isMovie, d)),
      cast: castOf(d.credits, this),
      posterUrl: this.img(d.poster_path, 'w500'),
      backdropUrl: this.img(d.backdrop_path, 'w1280'),
      collection: d.belongs_to_collection ? { id: String(d.belongs_to_collection.id), name: d.belongs_to_collection.name } : null,
      ...franchiseFacts(d),
      images: {
        poster: (images.posters || []).slice(0, 24).map((i) => ({ url: this.img(i.file_path, 'w500'), thumb: this.img(i.file_path, 'w185') })),
        backdrop: (images.backdrops || []).slice(0, 24).map((i) => ({ url: this.img(i.file_path, 'w1280'), thumb: this.img(i.file_path, 'w300') })),
      },
    };
  },

  // Every season's episodes (Fix episode lists them all).
  async allEpisodes(showId) {
    const d = await this.call(`/tv/${encodeURIComponent(showId)}`);
    return this.episodes(showId, (d?.seasons || []).map((s) => s.season_number).filter((n) => n != null));
  },

  // Map(seasonNumber -> Map(episodeNumber -> { title, overview, airDate, stillUrl }))
  async episodes(showId, seasons) {
    const out = new Map();
    for (const n of seasons) {
      const d = await this.call(`/tv/${encodeURIComponent(showId)}/season/${n}`).catch(() => undefined);
      // A season that couldn't be fetched (TMDB down a moment) is null: its episodes are left as they
      // are and tried again, rather than marked "not found" for good.
      if (d === undefined) { out.set(n, null); continue; }
      const map = new Map();
      for (const e of d?.episodes || []) {
        map.set(e.episode_number, { title: e.name || null, overview: e.overview || null, airDate: e.air_date || null, stillUrl: this.img(e.still_path, 'w500') });
      }
      out.set(n, map);
    }
    return out;
  },
};

// ---------------- TVmaze ----------------
const tvmaze = {
  id: 'tvmaze',
  name: 'TVmaze',
  kinds: ['show'],
  enabled: () => process.env.TVMAZE_DISABLED !== '1',

  async search(kind, query, year) {
    if (kind !== 'show') return [];
    const res = (await getJson(`${TVMAZE_API}/search/shows?q=${encodeURIComponent(query)}`)) || [];
    const list = res.map(({ show: s }) => ({
      provider: 'tvmaze', id: String(s.id), title: s.name, year: yearOf(s.premiered),
      overview: stripHtml(s.summary), thumb: s.image?.medium || null,
    }));
    // Prefer an exact year match when we have one.
    return year ? [...list.filter((r) => r.year === year), ...list.filter((r) => r.year !== year)] : list;
  },

  async details(kind, id) {
    if (kind !== 'show') return null;
    const s = await getJson(`${TVMAZE_API}/shows/${encodeURIComponent(id)}?embed[]=episodes&embed[]=cast&embed[]=images`);
    if (!s) return null;
    const imgs = s._embedded?.images || [];
    const pick = (type) => imgs.filter((i) => i.type === type).map((i) => ({
      url: i.resolutions?.original?.url, thumb: i.resolutions?.medium?.url || i.resolutions?.original?.url,
    })).filter((i) => i.url);
    const backdrops = pick('background');
    const episodes = new Map();
    for (const e of s._embedded?.episodes || []) {
      if (!episodes.has(e.season)) episodes.set(e.season, new Map());
      episodes.get(e.season).set(e.number, {
        title: e.name || null, overview: stripHtml(e.summary), airDate: e.airdate || null, stillUrl: e.image?.original || null,
      });
    }
    return {
      provider: 'tvmaze', providerId: String(s.id), title: s.name, year: yearOf(s.premiered),
      overview: stripHtml(s.summary), tagline: null, genres: s.genres || [],
      rating: s.rating?.average ?? null,
      cast: (s._embedded?.cast || []).slice(0, 15).map((c) => ({ name: c.person?.name, character: c.character?.name || null, ...(c.person?.image?.medium ? { photo: c.person.image.medium } : {}) })).filter((c) => c.name),
      posterUrl: s.image?.original || null,
      backdropUrl: backdrops[0]?.url || null,
      images: { poster: pick('poster'), backdrop: backdrops },
      episodeMap: episodes,
    };
  },

  async episodes(showId) {
    return (await this.details('show', showId))?.episodeMap || new Map();
  },
  allEpisodes(showId) { return this.episodes(showId); },

  // TVmaze id of a show known by its IMDb or TheTVDB id.
  async find(kind, { imdb, tvdb }) {
    if (kind !== 'show' || !(imdb || tvdb)) return null;
    const s = await getJson(`${TVMAZE_API}/lookup/shows?${imdb ? `imdb=${encodeURIComponent(imdb)}` : `thetvdb=${encodeURIComponent(tvdb)}`}`);
    return s?.id ? String(s.id) : null;
  },
};

// ---------------- TheTVDB ----------------
// TheTVDB uses three-letter languages and countries ("eng", "usa").
const TVDB_LANGS = { en: 'eng', fr: 'fra', de: 'deu', es: 'spa', it: 'ita', pt: 'por', nl: 'nld', sv: 'swe', da: 'dan', no: 'nor', nb: 'nor', fi: 'fin', pl: 'pol', ja: 'jpn', ko: 'kor', zh: 'zho', ru: 'rus' };
const TVDB_COUNTRIES = { US: 'usa', GB: 'gbr', CA: 'can', AU: 'aus', NZ: 'nzl', IE: 'irl', DE: 'deu', FR: 'fra', NL: 'nld', ES: 'esp', IT: 'ita' };
const tvdbLang = () => TVDB_LANGS[language().slice(0, 2).toLowerCase()] || 'eng';
// Its artwork addresses are sometimes whole and sometimes start at "/banners/…".
const tvdbImg = (u) => (!u ? null : /^https?:/.test(u) ? u : `${TVDB_IMG}${u.startsWith('/') ? '' : '/'}${u}`);
// A record's name or overview in our language, then English, then as it was first written.
function tvdbText(list, field, fallback) {
  const t = (list || []).filter((x) => x?.[field]);
  return (t.find((x) => x.language === tvdbLang()) || t.find((x) => x.language === 'eng'))?.[field] || fallback || null;
}

const tvdb = {
  id: 'tvdb',
  name: 'TheTVDB',
  kinds: ['show'],
  enabled: () => !!tvdbCredentials().key,
  token: null, // { value, key, at }: a sign-in lasts a month; a fresh one is made after 3 weeks
  episodeCache: new Map(), // show id -> { at, list }: one fetch serves the details, seasons and next episode

  async login(creds = tvdbCredentials()) {
    const res = await fetch(`${TVDB_API}/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ apikey: creds.key, ...(creds.pin ? { pin: creds.pin } : {}) }), signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw Object.assign(new Error(res.status === 401 ? 'TheTVDB didn’t accept this key (or PIN)' : `TheTVDB returned HTTP ${res.status}`), { status: res.status });
    const value = (await res.json())?.data?.token;
    if (!value) throw new Error('TheTVDB didn’t sign in');
    return value;
  },

  async call(pathname, params = {}) {
    const creds = tvdbCredentials();
    const url = new URL(TVDB_API + pathname);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      if (!this.token || this.token.key !== `${creds.key}|${creds.pin}` || Date.now() - this.token.at > 21 * 86400_000) {
        this.token = { value: await this.login(creds), key: `${creds.key}|${creds.pin}`, at: Date.now() };
      }
      try { return (await getJson(url, { authorization: `Bearer ${this.token.value}` }))?.data ?? null; } catch (err) {
        if (err.status !== 401 || attempt) throw err;
        this.token = null; // signed out early: sign in again once
      }
    }
  },

  // Used by the Settings "Test" button.
  async test(key, pin) {
    try { await this.login(tvdbCredentials({ key, pin })); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
  },

  async search(kind, query, year) {
    if (kind !== 'show') return [];
    const run = (y) => this.call('/search', { query, type: 'series', year: y, limit: 12 });
    let res = await run(year);
    if (!res?.length && year) res = await run(null);
    return (res || []).slice(0, 12).map((r) => ({
      provider: 'tvdb', id: String(r.tvdb_id || String(r.id).replace(/^series-/, '')),
      title: r.translations?.[tvdbLang()] || r.translations?.eng || r.name,
      originalTitle: r.name || null, year: Number(r.year) || yearOf(r.first_air_time),
      overview: r.overviews?.[tvdbLang()] || r.overviews?.eng || r.overview || null, thumb: tvdbImg(r.thumbnail || r.image_url),
    }));
  },

  // TheTVDB id of a show known by its IMDb or TheTVDB id.
  async find(kind, { imdb, tvdb: id }) {
    if (kind !== 'show') return null;
    if (id) return String(id);
    if (!imdb) return null;
    const hit = (await this.call(`/search/remoteid/${encodeURIComponent(imdb)}`))?.find((x) => x.series)?.series;
    return hit?.id ? String(hit.id) : null;
  },

  // Every episode in the show's usual order (what Sonarr uses), page by page.
  async episodeList(showId) {
    const hit = this.episodeCache.get(showId);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.list;
    const list = [];
    for (let page = 0; page < 40; page++) {
      const path = `/series/${encodeURIComponent(showId)}/episodes/default/${tvdbLang()}`;
      const d = await this.call(path, { page }).catch((err) => {
        if (err.status === 400 || err.status === 404) return this.call(`/series/${encodeURIComponent(showId)}/episodes/default`, { page }); // (no translation)
        throw err;
      });
      const eps = d?.episodes || d?.series?.episodes || [];
      list.push(...eps);
      if (eps.length < 500) break; // (pages hold 500)
    }
    this.episodeCache.set(showId, { at: Date.now(), list });
    if (this.episodeCache.size > 200) this.episodeCache.delete(this.episodeCache.keys().next().value);
    return list;
  },

  async details(kind, id) {
    if (kind !== 'show') return null;
    const s = await this.call(`/series/${encodeURIComponent(id)}/extended`, { meta: 'translations' });
    if (!s) return null;
    const art = (type) => (s.artworks || []).filter((a) => a.type === type && a.image && (!a.language || a.language === tvdbLang() || a.language === 'eng'))
      .sort((a, b) => (b.language === tvdbLang()) - (a.language === tvdbLang()) || (b.score || 0) - (a.score || 0))
      .slice(0, 24).map((a) => ({ url: tvdbImg(a.image), thumb: tvdbImg(a.thumbnail || a.image) }));
    const posters = art(2); // (TheTVDB's artwork types: 2 a show's poster, 3 its background)
    const backdrops = art(3);
    const want = [TVDB_COUNTRIES[region()] || 'usa', 'usa'];
    const cert = want.map((c) => (s.contentRatings || []).find((r) => r.country === c && r.name)).find(Boolean)?.name || null;
    const episodeMap = new Map();
    for (const e of await this.episodeList(String(s.id)).catch(() => [])) {
      if (e.seasonNumber == null || e.number == null) continue;
      if (!episodeMap.has(e.seasonNumber)) episodeMap.set(e.seasonNumber, new Map());
      episodeMap.get(e.seasonNumber).set(e.number, { title: e.name || null, overview: e.overview || null, airDate: e.aired || null, stillUrl: tvdbImg(e.image) });
    }
    return {
      provider: 'tvdb', providerId: String(s.id),
      title: tvdbText(s.translations?.nameTranslations, 'name', s.name),
      year: Number(s.year) || yearOf(s.firstAired),
      overview: tvdbText(s.translations?.overviewTranslations, 'overview', s.overview),
      tagline: null,
      genres: (s.genres || []).map((g) => g.name).filter(Boolean),
      rating: null, // (TheTVDB's "score" is how popular a show is, not a rating)
      contentRating: ratingFor(cert),
      cast: (s.characters || []).filter((c) => c.peopleType === 'Actor' || c.type === 3).sort((a, b) => (a.sort ?? 99) - (b.sort ?? 99)).slice(0, 15)
        .map((c) => ({ name: c.personName, character: c.name || null, ...(c.personImgURL || c.image ? { photo: tvdbImg(c.personImgURL || c.image) } : {}) })).filter((c) => c.name),
      posterUrl: posters[0]?.url || tvdbImg(s.image),
      backdropUrl: backdrops[0]?.url || null,
      images: { poster: posters, backdrop: backdrops },
      episodeMap,
    };
  },

  async episodes(showId) {
    return (await this.details('show', showId))?.episodeMap || new Map();
  },
  allEpisodes(showId) { return this.episodes(showId); },
};

const PROVIDERS = { tmdb, tvmaze, tvdb };

// Providers usable for a kind, best first. (TheTVDB comes first for shows when Settings say so.)
function providersFor(kind) {
  const list = Object.values(PROVIDERS).filter((p) => p.kinds.includes(kind) && p.enabled());
  return kind === 'show' && settings().preferTvdb ? [...list.filter((p) => p.id === 'tvdb'), ...list.filter((p) => p.id !== 'tvdb')] : list;
}

function available() {
  return Object.values(PROVIDERS).map((p) => ({ id: p.id, name: p.name, kinds: p.kinds, enabled: p.enabled() }));
}

// Download an image to `dir`, returning the local path. Only http(s) and real image bytes are accepted.
// Addresses on the server itself (loopback) or "link-local" ones (where cloud machines answer
// questions about themselves): an image address someone types in mustn't make the server fetch from
// those. (Other home-network addresses are fine: a poster on your NAS, say.)
function privateAddress(ip) {
  if (process.env.IMAGE_URLS_ALLOW_LOCAL === '1') return false; // (the tests' stand-in for TMDB runs on this PC)
  const a = ip.replace(/^::ffff:/i, '');
  if (net.isIPv4(a)) {
    const [x, y] = a.split('.').map(Number);
    return x === 0 || x === 127 || x >= 224 || (x === 169 && y === 254);
  }
  return a === '::' || a === '::1' || /^fe[89ab]/i.test(a);
}

async function checkPublic(u) {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((x) => x.address);
  if (!addrs.length) throw new Error('That image address can’t be found');
  if (addrs.some(privateAddress)) throw new Error('Images can’t be fetched from the server itself');
}

// Read at most `max` bytes (a huge or endless answer is stopped, not kept in memory first).
async function readCapped(res, max) {
  if (Number(res.headers.get('content-length')) > max) throw new Error('Image is larger than 15 MB');
  const chunks = [];
  let n = 0;
  for await (const c of res.body) {
    n += c.length;
    if (n > max) throw new Error('Image is larger than 15 MB');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// untrusted: an address typed in by someone (artwork by URL), not from a metadata source: it (and
// every redirect) must be on the internet.
async function downloadImage(url, dir, name, { untrusted = false } = {}) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { throw new Error('Invalid image URL'); }
  for (let hop = 0; ; hop++) {
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) image URLs are supported');
    if (untrusted) await checkPublic(u);
    const res = await fetch(u, { redirect: untrusted ? 'manual' : 'follow', signal: AbortSignal.timeout(30_000) });
    const next = untrusted && res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (next) {
      if (hop >= 3) throw new Error('The image address redirects too many times');
      u = new URL(next, u);
      continue;
    }
    if (!res.ok) throw new Error(`Image download failed (HTTP ${res.status})`);
    return saveImage(await readCapped(res, MAX_IMAGE), dir, name);
  }
}

function imageExt(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return '.webp';
  if (buf.length > 6 && /^GIF8[79]a/.test(buf.subarray(0, 6).toString())) return '.gif';
  return null;
}

// Content-addressed so a changed image gets a new file (and a new URL version).
function saveImage(buf, dir, name) {
  if (buf.length > MAX_IMAGE) throw new Error('Image is larger than 15 MB');
  const ext = imageExt(buf);
  if (!ext) throw new Error('That file is not a JPEG, PNG, WebP or GIF image');
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${name}-${hash}${ext}`);
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
  return dest;
}

const contentRatingOf = (isMovie, d) => ratingFor(certificationOf(isMovie, d));

// A show's seasons as its source lists them: [{ season, episodes, name, airDate }] (specials left out).
async function seasonsOf(provider, id) {
  if (provider === 'tmdb' && tmdb.enabled()) {
    const d = await tmdb.call(`/tv/${encodeURIComponent(id)}`);
    return (d?.seasons || []).filter((x) => x.season_number > 0)
      .map((x) => ({ season: x.season_number, episodes: x.episode_count || 0, name: x.name || `Season ${x.season_number}`, airDate: x.air_date || null }));
  }
  if (provider === 'tvdb' && tvdb.enabled()) {
    const by = new Map();
    for (const e of await tvdb.episodeList(String(id))) {
      if (!(e.seasonNumber > 0)) continue;
      const x = by.get(e.seasonNumber) || { season: e.seasonNumber, episodes: 0, name: `Season ${e.seasonNumber}`, airDate: null };
      x.episodes++;
      if (e.aired && (!x.airDate || e.aired < x.airDate)) x.airDate = e.aired;
      by.set(e.seasonNumber, x);
    }
    return [...by.values()].sort((a, b) => a.season - b.season);
  }
  if (provider === 'tvmaze') {
    const list = (await getJson(`${TVMAZE_API}/shows/${encodeURIComponent(id)}/seasons`)) || [];
    return list.filter((x) => x.number > 0)
      .map((x) => ({ season: x.number, episodes: x.episodeOrder || 0, name: x.name || `Season ${x.number}`, airDate: x.premiereDate || null }));
  }
  return [];
}

// A show's next episode to air, from its source: { season, episode, title, airDate } or null.
async function nextEpisodeOf(provider, id) {
  if (provider === 'tmdb' && tmdb.enabled()) {
    const n = (await tmdb.call(`/tv/${encodeURIComponent(id)}`))?.next_episode_to_air;
    return n?.air_date ? { season: n.season_number, episode: n.episode_number, title: n.name || null, airDate: n.air_date } : null;
  }
  if (provider === 'tvdb' && tvdb.enabled()) {
    const today = new Date().toISOString().slice(0, 10);
    const n = (await tvdb.episodeList(String(id))).filter((e) => e.aired && e.aired >= today && e.seasonNumber > 0)
      .sort((a, b) => a.aired.localeCompare(b.aired) || a.number - b.number)[0];
    return n ? { season: n.seasonNumber, episode: n.number, title: n.name || null, airDate: n.aired } : null;
  }
  if (provider === 'tvmaze') {
    const n = (await getJson(`${TVMAZE_API}/shows/${encodeURIComponent(id)}?embed=nextepisode`))?._embedded?.nextepisode;
    return n?.airdate ? { season: n.season, episode: n.number, title: n.name || null, airDate: n.airstamp || n.airdate } : null;
  }
  return null;
}

// A show's TheTVDB id (what Sonarr knows shows by), from whichever source the request came from.
async function tvdbIdOf(provider, id) {
  if (provider === 'tmdb' && tmdb.enabled()) return (await tmdb.call(`/tv/${encodeURIComponent(id)}/external_ids`))?.tvdb_id || null;
  if (provider === 'tvmaze') return (await getJson(`${TVMAZE_API}/shows/${encodeURIComponent(id)}`))?.externals?.thetvdb || null;
  if (provider === 'tvdb') return id ? Number(id) || null : null;
  return null;
}

// What franchises are worked out from (see franchises.js): the studios that made a film or show,
// and TMDB's keywords for it ("marvel cinematic universe (mcu)"…); and its release date, so
// films from the same year are in the order they came out.
function franchiseFacts(d) {
  return {
    released: d.release_date || d.first_air_date || null,
    companies: (d.production_companies || []).map((c) => c.name).filter(Boolean).slice(0, 10),
    keywords: (d.keywords?.keywords || d.keywords?.results || []).map((k) => String(k.name).toLowerCase()).slice(0, 60),
  };
}

module.exports = { nextEpisodeOf, seasonsOf, tvdbIdOf, franchiseFacts, contentRatingOf, castOf: (credits) => castOf(credits, tmdb), configure, PROVIDERS, providersFor, available, downloadImage, saveImage, tmdb, tvmaze, tvdb, MAX_IMAGE };
