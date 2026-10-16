'use strict';
// Optional online metadata from TMDB (https://www.themoviedb.org). Enabled when TMDB_API_KEY
// (v3 key) or TMDB_TOKEN (v4 read token) is set. Without it, Marquee uses filenames + local art.

const fs = require('node:fs');
const path = require('node:path');

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';

const enabled = () => !!(process.env.TMDB_API_KEY || process.env.TMDB_TOKEN);

async function tmdb(pathname, params = {}) {
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const headers = { accept: 'application/json' };
  if (process.env.TMDB_TOKEN) headers.authorization = `Bearer ${process.env.TMDB_TOKEN}`;
  else url.searchParams.set('api_key', process.env.TMDB_API_KEY);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`TMDB ${pathname} -> HTTP ${res.status}`);
  return res.json();
}

async function download(remotePath, size, dir, name) {
  if (!remotePath) return null;
  const dest = path.join(dir, `${name}${path.extname(remotePath) || '.jpg'}`);
  if (fs.existsSync(dest)) return dest;
  const res = await fetch(`${IMG}/${size}${remotePath}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

async function movie(title, year, imagesDir, id) {
  let res = await tmdb('/search/movie', { query: title, year: year || undefined });
  if (!res.results?.length && year) res = await tmdb('/search/movie', { query: title });
  const hit = res.results?.[0];
  if (!hit) return null;
  const d = await tmdb(`/movie/${hit.id}`);
  return {
    tmdbId: hit.id,
    title: d.title,
    year: d.release_date ? Number(d.release_date.slice(0, 4)) : year,
    overview: d.overview || null,
    tagline: d.tagline || null,
    genres: (d.genres || []).map((g) => g.name),
    rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
    poster: await download(d.poster_path, 'w500', imagesDir, `${id}-poster`),
    backdrop: await download(d.backdrop_path, 'w1280', imagesDir, `${id}-backdrop`),
  };
}

async function show(title, year, imagesDir, id) {
  let res = await tmdb('/search/tv', { query: title, first_air_date_year: year || undefined });
  if (!res.results?.length && year) res = await tmdb('/search/tv', { query: title });
  const hit = res.results?.[0];
  if (!hit) return null;
  const d = await tmdb(`/tv/${hit.id}`);
  return {
    tmdbId: hit.id,
    title: d.name,
    year: d.first_air_date ? Number(d.first_air_date.slice(0, 4)) : year,
    overview: d.overview || null,
    genres: (d.genres || []).map((g) => g.name),
    rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
    poster: await download(d.poster_path, 'w500', imagesDir, `${id}-poster`),
    backdrop: await download(d.backdrop_path, 'w1280', imagesDir, `${id}-backdrop`),
  };
}

// Returns Map(episodeNumber -> { title, overview, airDate, stillRemote })
async function season(tmdbId, seasonNumber) {
  const d = await tmdb(`/tv/${tmdbId}/season/${seasonNumber}`);
  const map = new Map();
  for (const e of d.episodes || []) {
    map.set(e.episode_number, { title: e.name, overview: e.overview || null, airDate: e.air_date || null, still: e.still_path });
  }
  return map;
}

module.exports = { enabled, movie, show, season, download };
