'use strict';
// Filename parsing for movies and TV episodes, following the common
// "Movie (Year)/Movie (Year).ext" and "Show/Season 01/Show - S01E02 - Title.ext" layouts.

const path = require('node:path');

const VIDEO_EXT = new Set([
  '.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.wmv', '.flv',
  '.ts', '.m2ts', '.mts', '.mpg', '.mpeg', '.3gp', '.ogv', '.divx',
]);
const SUB_EXT = new Set(['.srt', '.vtt']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

// Release-group noise: everything from the first of these tokens onward is dropped.
const JUNK = new RegExp(
  '(?:^|\\s)(?:2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr|hdr10|dv|dovi|bluray|blu-ray|bdrip|brrip|' +
  'webrip|web-dl|webdl|web|hdtv|dvdrip|dvd|hdrip|x264|x265|h264|h265|h\\.264|h\\.265|hevc|avc|xvid|divx|' +
  'aac|ac3|eac3|dts|ddp?5\\.1|atmos|truehd|10bit|8bit|remux|proper|repack|extended|unrated|imax|' +
  'internal|limited|multi|subbed|dubbed)(?:\\s|$).*$', 'i');

function cleanName(s) {
  return s
    .replace(/\[[^\]]*\]/g, ' ')            // [group] tags
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(JUNK, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/[\s\-–:(]+$/g, '')
    .replace(/^[\s\-–:)]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const YEAR_RE = /(?:^|[\s._\-(\[])((?:19|20)\d{2})(?=$|[\s._\-)\]])/g;

// Returns { title, year } where year may be null.
function parseTitleYear(name) {
  let best = null;
  for (const m of name.matchAll(YEAR_RE)) {
    const yearStart = m.index + m[0].length - 4;
    const before = cleanName(name.slice(0, yearStart));
    if (before) best = { title: before, year: Number(m[1]) }; // keep the last valid candidate
  }
  if (best) return best;
  return { title: cleanName(name) || name, year: null };
}

function parseMovie(file) {
  const base = path.basename(file, path.extname(file));
  let { title, year } = parseTitleYear(base);
  if (!year) {
    // Fall back to the parent folder: "Movie (2019)/movie.mkv"
    const parent = parseTitleYear(path.basename(path.dirname(file)));
    if (parent.year) ({ title, year } = parent);
  }
  return { title, year };
}

const SEASON_DIR_RE = /^(?:season|series|staffel|saison|temporada)[\s._-]*(\d{1,3})$|^s(\d{1,3})$/i;
const EPISODE_PATTERNS = [
  // S01E02, S01E02E03, S01E02-E03, s1.e2
  /(?:^|[^a-z0-9])s(\d{1,3})[\s._-]*e(\d{1,4})(?:[\s._-]*e?(\d{1,4})(?![\dp]))?/i,
  // 1x02
  /(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?![\dp])/i,
];

function seasonFromDir(name) {
  if (/^specials?$/i.test(name)) return 0;
  const m = SEASON_DIR_RE.exec(name.trim());
  return m ? Number(m[1] ?? m[2]) : null;
}

// relPath is relative to the library root, e.g. "Show/Season 1/Show - S01E02.mkv".
function parseEpisode(relPath) {
  const parts = relPath.split(/[\\/]/).filter(Boolean);
  const file = parts[parts.length - 1];
  const base = path.basename(file, path.extname(file));
  const dirs = parts.slice(0, -1);

  let season = null, episode = null, episodeEnd = null, before = base, after = '';
  for (const re of EPISODE_PATTERNS) {
    const m = re.exec(base);
    if (m) {
      season = Number(m[1]);
      episode = Number(m[2]);
      if (m[3] && Number(m[3]) > episode) episodeEnd = Number(m[3]);
      before = base.slice(0, m.index + (m[0].length - m[0].trimStart().length));
      after = base.slice(m.index + m[0].length);
      break;
    }
  }

  // Season folder wins if the filename had no season, e.g. "Season 2/Episode 05.mkv".
  const seasonDirIdx = dirs.findIndex((d) => seasonFromDir(d) !== null);
  if (season === null && seasonDirIdx !== -1) season = seasonFromDir(dirs[seasonDirIdx]);
  if (episode === null) {
    const m = /(?:^|[^a-z])(?:ep?|episode)[\s._-]*(\d{1,4})(?!\d)/i.exec(base) || /^(\d{1,3})(?:[\s._-]|$)/.exec(base);
    if (m) {
      episode = Number(m[1]);
      after = base.slice(m.index + m[0].length);
      before = base.slice(0, m.index);
    }
  }

  // Show name: first folder under the library root (unless it is itself a season folder),
  // otherwise whatever precedes the episode marker in the filename.
  let showRaw = null;
  if (dirs.length && seasonFromDir(dirs[0]) === null) showRaw = dirs[0];
  else if (cleanName(before)) showRaw = before;
  else showRaw = base;
  const show = parseTitleYear(showRaw);

  let title = cleanName(after.replace(/^[\s._-]+/, ''));
  if (!title && episode === null) title = cleanName(base);

  return {
    show: show.title,
    showYear: show.year,
    season: season ?? (episode !== null ? 1 : null),
    episode,
    episodeEnd,
    title: title || null,
  };
}

function isVideo(file) { return VIDEO_EXT.has(path.extname(file).toLowerCase()); }

// Sidecar subtitles: "Movie.srt", "Movie.en.srt", "Movie.English.forced.srt"
function findSidecarSubs(videoFile, siblings) {
  const base = path.basename(videoFile, path.extname(videoFile)).toLowerCase();
  const out = [];
  for (const name of siblings) {
    const ext = path.extname(name).toLowerCase();
    if (!SUB_EXT.has(ext)) continue;
    const stem = name.slice(0, -ext.length);
    if (!stem.toLowerCase().startsWith(base)) continue;
    const rest = stem.slice(base.length).replace(/^[._\s-]+/, '');
    const tags = rest.split(/[._\s-]+/).filter(Boolean);
    const forced = tags.some((t) => /^forced$/i.test(t));
    const sdh = tags.some((t) => /^(sdh|cc|hi)$/i.test(t));
    const lang = tags.find((t) => !/^(forced|sdh|cc|hi|default)$/i.test(t)) || null;
    out.push({ file: path.join(path.dirname(videoFile), name), lang, forced, sdh, format: ext.slice(1) });
  }
  return out;
}

// Local artwork next to the media: "poster.jpg", "folder.jpg", "<base>-poster.jpg", "fanart.jpg"...
function findLocalArt(videoFile, siblings, ownFolder) {
  const base = path.basename(videoFile, path.extname(videoFile)).toLowerCase();
  const dir = path.dirname(videoFile);
  const imgs = siblings.filter((n) => IMAGE_EXT.has(path.extname(n).toLowerCase()));
  const pick = (names) => {
    for (const want of names) {
      const hit = imgs.find((n) => n.slice(0, -path.extname(n).length).toLowerCase() === want);
      if (hit) return path.join(dir, hit);
    }
    return null;
  };
  const posterNames = [`${base}-poster`, `${base}.poster`, base];
  const backdropNames = [`${base}-fanart`, `${base}-backdrop`, `${base}.fanart`];
  if (ownFolder) {
    posterNames.push('poster', 'folder', 'cover', 'movie');
    backdropNames.push('fanart', 'backdrop', 'background', 'art');
  }
  return { poster: pick(posterNames), backdrop: pick(backdropNames) };
}

function findFolderArt(dir, siblings) {
  const imgs = siblings.filter((n) => IMAGE_EXT.has(path.extname(n).toLowerCase()));
  const pick = (names) => {
    const hit = imgs.find((n) => names.includes(n.slice(0, -path.extname(n).length).toLowerCase()));
    return hit ? path.join(dir, hit) : null;
  };
  return {
    poster: pick(['poster', 'folder', 'cover', 'show']),
    backdrop: pick(['fanart', 'backdrop', 'background', 'art']),
  };
}

module.exports = {
  VIDEO_EXT, isVideo, cleanName, parseTitleYear, parseMovie, parseEpisode, seasonFromDir,
  findSidecarSubs, findLocalArt, findFolderArt,
};
