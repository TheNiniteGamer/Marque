'use strict';
// Online metadata providers, normalised to one shape:
//   TMDB  (movies + TV, needs a free API key: Settings → Metadata, or TMDB_API_KEY / TMDB_TOKEN)
//   TVmaze (TV only, no key needed)
// Base URLs can be overridden (used by the tests to point at a mock server).

const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const net = require('node:net');
const crypto = require('node:crypto');

const TMDB_API = process.env.TMDB_API_BASE || 'https://api.themoviedb.org/3';
const TMDB_IMG = process.env.TMDB_IMAGE_BASE || 'https://image.tmdb.org/t/p';
const TVMAZE_API = process.env.TVMAZE_API_BASE || 'https://api.tvmaze.com';
const MAX_IMAGE = 15 * 1024 * 1024;

let settings = () => ({});
// The server passes a getter for the admin-editable settings (key, language).
function configure(getSettings) { settings = getSettings; }

const tmdbCredentials = (override) => {
  const key = override ?? settings().tmdbKey ?? process.env.TMDB_API_KEY ?? '';
  const token = process.env.TMDB_TOKEN || '';
  return { key: String(key).trim(), token };
};
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
      const d = await this.call(`/tv/${encodeURIComponent(showId)}/season/${n}`).catch(() => null);
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

const PROVIDERS = { tmdb, tvmaze };

// Providers usable for a kind, best first.
function providersFor(kind) {
  return Object.values(PROVIDERS).filter((p) => p.kinds.includes(kind) && p.enabled());
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
  if (provider === 'tvmaze') {
    const list = (await getJson(`${TVMAZE_API}/shows/${encodeURIComponent(id)}/seasons`)) || [];
    return list.filter((x) => x.number > 0)
      .map((x) => ({ season: x.number, episodes: x.episodeOrder || 0, name: x.name || `Season ${x.number}`, airDate: x.premiereDate || null }));
  }
  return [];
}

// A show's TheTVDB id (what Sonarr knows shows by), from whichever source the request came from.
async function tvdbIdOf(provider, id) {
  if (provider === 'tmdb' && tmdb.enabled()) return (await tmdb.call(`/tv/${encodeURIComponent(id)}/external_ids`))?.tvdb_id || null;
  if (provider === 'tvmaze') return (await getJson(`${TVMAZE_API}/shows/${encodeURIComponent(id)}`))?.externals?.thetvdb || null;
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

module.exports = { seasonsOf, tvdbIdOf, franchiseFacts, contentRatingOf, castOf: (credits) => castOf(credits, tmdb), configure, PROVIDERS, providersFor, available, downloadImage, saveImage, tmdb, tvmaze, MAX_IMAGE };
