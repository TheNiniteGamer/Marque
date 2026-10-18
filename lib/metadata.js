'use strict';
// Online metadata providers, normalised to one shape:
//   TMDB  (movies + TV, needs a free API key: Settings → Metadata, or TMDB_API_KEY / TMDB_TOKEN)
//   TVmaze (TV only, no key needed)
// Base URLs can be overridden (used by the tests to point at a mock server).

const fs = require('node:fs');
const path = require('node:path');
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
const yearOf = (date) => (date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null);
const stripHtml = (s) => (s ? String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() || null : null);

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).host} returned HTTP ${res.status}`), { status: res.status });
  return res.json();
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
      year: yearOf(isMovie ? r.release_date : r.first_air_date),
      overview: r.overview || null, thumb: this.img(r.poster_path, 'w185'),
    }));
  },

  async details(kind, id) {
    const isMovie = kind === 'movie';
    const d = await this.call(`/${isMovie ? 'movie' : 'tv'}/${encodeURIComponent(id)}`,
      { append_to_response: 'credits,images', include_image_language: `${language().slice(0, 2)},en,null` });
    if (!d) return null;
    const images = d.images || {};
    return {
      provider: 'tmdb', providerId: String(d.id),
      title: isMovie ? d.title : d.name,
      year: yearOf(isMovie ? d.release_date : d.first_air_date),
      overview: d.overview || null,
      tagline: d.tagline || null,
      genres: (d.genres || []).map((g) => g.name),
      rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
      cast: (d.credits?.cast || []).slice(0, 15).map((c) => ({ name: c.name, character: c.character || null })),
      posterUrl: this.img(d.poster_path, 'w500'),
      backdropUrl: this.img(d.backdrop_path, 'w1280'),
      collection: d.belongs_to_collection ? { id: String(d.belongs_to_collection.id), name: d.belongs_to_collection.name } : null,
      images: {
        poster: (images.posters || []).slice(0, 24).map((i) => ({ url: this.img(i.file_path, 'w500'), thumb: this.img(i.file_path, 'w185') })),
        backdrop: (images.backdrops || []).slice(0, 24).map((i) => ({ url: this.img(i.file_path, 'w1280'), thumb: this.img(i.file_path, 'w300') })),
      },
    };
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
      cast: (s._embedded?.cast || []).slice(0, 15).map((c) => ({ name: c.person?.name, character: c.character?.name || null })).filter((c) => c.name),
      posterUrl: s.image?.original || null,
      backdropUrl: backdrops[0]?.url || null,
      images: { poster: pick('poster'), backdrop: backdrops },
      episodeMap: episodes,
    };
  },

  async episodes(showId) {
    return (await this.details('show', showId))?.episodeMap || new Map();
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
async function downloadImage(url, dir, name) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { throw new Error('Invalid image URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) image URLs are supported');
  const res = await fetch(u, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Image download failed (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  return saveImage(buf, dir, name);
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

module.exports = { configure, PROVIDERS, providersFor, available, downloadImage, saveImage, tmdb, tvmaze, MAX_IMAGE };
