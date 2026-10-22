'use strict';
// Filename parsing for movies and TV episodes, following the common
// "Movie (Year)/Movie (Year).ext" and "Show/Season 01/Show - S01E02 - Title.ext" layouts.

const fs = require('node:fs');
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
    .replace(/\{[^}]*\}/g, ' ')              // {tmdb-603} ids
    .replace(/\((?:tmdb|imdb|tvdb|tvmaze)(?:id)?\s*[-=:][^)]*\)/gi, ' ')
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

// Discs ripped with MakeMKV: every title on the disc is "<disc name>_t00.mkv", "_t01"… (the film
// and its extras). { name, n } for such a file, else null.
const DISC_TITLE_RE = /_t(\d{2,3})$/i;
function discTitle(file) {
  const stem = path.basename(file, path.extname(file));
  const m = DISC_TITLE_RE.exec(stem);
  return m ? { name: stem.slice(0, m.index), n: Number(m[1]) } : null;
}
// Disc names that say nothing ("title_t00", "B1_t00", "DISC1_t00"): the folder names the film.
const GENERIC_DISC_RE = /^(title|disc|disk|bd|dvd|b\d|d\d|disc\s*\d+|movie)?$/i;

function parseMovie(file) {
  const disc = discTitle(file);
  const base = disc ? disc.name.replace(/_/g, ' ') : path.basename(file, path.extname(file));
  let { title, year } = disc && GENERIC_DISC_RE.test(disc.name.trim()) ? { title: '', year: null } : parseTitleYear(base);
  if (!year || !title) {
    // Fall back to the parent folder: "Movie (2019)/movie.mkv"
    const parent = parseTitleYear(path.basename(path.dirname(file)));
    if (parent.year || !title) ({ title, year } = parent);
  }
  return { title, year };
}

const SEASON_DIR_RE = /^(?:season|series|staffel|saison|temporada)[\s._-]*(\d{1,3})$|^s(\d{1,3})$/i;
const EPISODE_PATTERNS = [
  // S01E02, S01E02E03, S01E02-E03, S01E02-03, s1.e2. (Not "S03E07 - 42": after a space, a number is the
  // episode's title.)
  /(?:^|[^a-z0-9])s(\d{1,3})[\s._-]*e(\d{1,4})((?:(?:[._-]?e|-)\d{1,4}(?![\dp]))*)/i,
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

  let season = null, episode = null, episodeEnd = null, before = base, after = '', absolute = false;
  for (const re of EPISODE_PATTERNS) {
    const m = re.exec(base);
    if (m) {
      season = Number(m[1]);
      episode = Number(m[2]);
      const end = m[3] && Number(/(\d+)$/.exec(m[3])[1]); // (the last of "E01E02E03")
      if (end > episode && end - episode < 20) episodeEnd = end;
      before = base.slice(0, m.index + (m[0].length - m[0].trimStart().length));
      after = base.slice(m.index + m[0].length);
      break;
    }
  }

  // Season folder wins if the filename had no season, e.g. "Season 2/Episode 05.mkv".
  const seasonDirIdx = dirs.findIndex((d) => seasonFromDir(d) !== null);
  if (season === null && seasonDirIdx !== -1) season = seasonFromDir(dirs[seasonDirIdx]);
  if (episode === null) {
    // "Episode 5", "E05", "05 - Title", or "Show - 05 [1080p]" (common for anime).
    const m = /(?:^|[^a-z])(?:ep?|episode)[\s._-]*(\d{1,4})(?!\d)/i.exec(base) || /^(\d{1,3})(?:[\s._-]|$)/.exec(base)
      || /\s-\s(?!(?:19|20)\d\d(?:\s|$))(\d{1,4})(?=\s|$)/.exec(base);
    if (m) {
      episode = Number(m[1]);
      after = base.slice(m.index + m[0].length);
      before = base.slice(0, m.index);
      // A number without a season in the name: maybe counted across the whole show (anime's
      // "One Piece - 1071"). matcher.js decides, from the show's episode list.
      absolute = true;
    }
  }

  // Show name: the show's folder (see showFolderIndex), otherwise whatever precedes the episode
  // marker in the filename.
  const fromFile = cleanName(before) ? before : null;
  const showDirIndex = showFolderIndex(dirs, fromFile);
  const show = parseTitleYear(showDirIndex >= 0 ? dirs[showDirIndex] : fromFile || base);

  let title = cleanName(after.replace(/^[\s._-]+/, ''));
  if (!title && episode === null) title = cleanName(base);

  return {
    show: show.title,
    showYear: show.year,
    season: season ?? (episode !== null ? 1 : null),
    episode,
    episodeEnd,
    absolute,
    title: title || null,
    showDirIndex,
    showIds: idsFromName(showDirIndex >= 0 ? dirs[showDirIndex] : base),
  };
}

// Folders named after a release or a disc rather than the show: "Show.S01.1080p", "Show S01E02 720p",
// "Season 1 Complete", "Disc 2".
const RELEASE_DIR_RE = /(?:^|[^a-z0-9])(?:s\d{1,3}(?:[\s._-]*e\d{1,4})?|\d{1,2}x\d{2,3}|season[\s._-]*\d{1,3}|complete|(?:disc|disk|dvd|cd)[\s._-]*\d{1,2})(?![a-z0-9])/i;
const sameName = (a, b) => {
  const n = (s) => parseTitleYear(s).title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const x = n(a), y = n(b);
  return !!x && !!y && (x.includes(y) || y.includes(x));
};

// Which of the folders above an episode is the show's own folder (index into dirs, or -1 for none).
// Shows can sit in folders of their own ("TV/Kids/Bluey/Season 1/…", "TV/Anime/Naruto/…"):
//  - the folder holding the season folders, if there is one;
//  - else the deepest folder named like the show in the file name ("Naruto/Arc 1/Naruto - 01.mkv");
//  - else the deepest folder that isn't a release or disc folder ("Kids/Bluey/Episode 05.mkv").
function showFolderIndex(dirs, showFromFile) {
  const seasonIdx = dirs.findIndex((d) => seasonFromDir(d) !== null);
  if (seasonIdx >= 0) return seasonIdx - 1;
  const candidates = dirs.map((d, i) => i).filter((i) => !RELEASE_DIR_RE.test(dirs[i]));
  if (!candidates.length) return dirs.length ? 0 : -1;
  if (showFromFile) {
    for (const i of [...candidates].reverse()) if (sameName(dirs[i], showFromFile)) return i;
  }
  return candidates[candidates.length - 1];
}

// Database ids in a file or folder name, as Plex, Jellyfin and Emby use them:
// "The Matrix (1999) {tmdb-603}", "[imdbid-tt0133093]", "{tvdb-81189}", or a bare "[tt0133093]".
const ID_RE = /[[{(]\s*(tmdb|imdb|tvdb|tvmaze)(?:id)?\s*[-=:\s]\s*(tt\d{5,10}|\d{1,10})\s*[\]})]/gi;
function idsFromName(name) {
  const out = {};
  for (const m of String(name || '').matchAll(ID_RE)) {
    const kind = m[1].toLowerCase(), id = m[2].toLowerCase();
    if ((kind === 'imdb') !== id.startsWith('tt')) continue;
    out[kind] ??= id;
  }
  const bare = /[[{(](tt\d{7,10})[\]})]/i.exec(String(name || ''));
  if (bare) out.imdb ??= bare[1].toLowerCase();
  return Object.keys(out).length ? out : null;
}

function isVideo(file) { return VIDEO_EXT.has(path.extname(file).toLowerCase()); }

// Extras, following Plex's layout: files inside an "Extras" / "Trailers" / "Behind The Scenes"… folder,
// or named "<movie>-trailer.mp4", "<movie>-featurette.mkv"… next to the movie.
const EXTRA_DIRS = {
  extras: 'extra', trailers: 'trailer', featurettes: 'featurette', 'behind the scenes': 'behindthescenes',
  'deleted scenes': 'deleted', interviews: 'interview', scenes: 'scene', shorts: 'short', other: 'other', others: 'other',
};
const EXTRA_SUFFIX_RE = /-(trailer|behindthescenes|featurette|deleted|interview|scene|short|other)$/i;
const EXTRA_LABELS = {
  extra: 'Extra', trailer: 'Trailer', featurette: 'Featurette', behindthescenes: 'Behind the scenes', deleted: 'Deleted scene',
  interview: 'Interview', scene: 'Scene', short: 'Short', other: 'Extra',
};

/**
 * For a path relative to the library folder: null for normal media, else
 * { kind, ownerDir (relative folder the extra belongs to), ownerBase (movie file name stem, for "-trailer" files), title }.
 */
function extraInfo(relPath) {
  const parts = relPath.split(/[\\/]/);
  const stem = path.basename(relPath, path.extname(relPath));
  for (let i = parts.length - 2; i >= 0; i--) {
    const kind = EXTRA_DIRS[parts[i].toLowerCase()];
    if (kind) return { kind, ownerDir: parts.slice(0, i).join(path.sep), ownerBase: null, title: cleanName(stem) || stem };
  }
  const m = EXTRA_SUFFIX_RE.exec(stem);
  if (!m) return null;
  const ownerBase = stem.slice(0, m.index);
  return { kind: m[1].toLowerCase(), ownerDir: parts.slice(0, -1).join(path.sep), ownerBase, title: EXTRA_LABELS[m[1].toLowerCase()] };
}
const isExtraName = (name) => EXTRA_SUFFIX_RE.test(path.basename(name, path.extname(name)));

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

// Details saved next to a downloaded video ("<name>.info.json", written by Marquee's downloader or
// yt-dlp's --write-info-json): title, description, upload date, channel, link and chapters.
function readVideoInfo(videoFile, siblings) {
  const base = path.basename(videoFile, path.extname(videoFile));
  if (!siblings.includes(`${base}.info.json`)) return null;
  let d = null;
  try {
    const file = path.join(path.dirname(videoFile), `${base}.info.json`);
    if (fs.statSync(file).size > 20 * 1024 * 1024) return null;
    const text = fs.readFileSync(file, 'utf8').trim();
    // Marquee appends one line per download; the last one is the newest.
    try { d = JSON.parse(text.split('\n').pop()); } catch { d = JSON.parse(text); }
  } catch { return null; }
  if (!d || typeof d !== 'object') return null;
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(String(d.upload_date || ''));
  return {
    id: d.id ? String(d.id) : null,
    title: d.title ? String(d.title).slice(0, 300) : null,
    description: d.description ? String(d.description).slice(0, 5000) : null,
    uploadDate: date ? `${date[1]}-${date[2]}-${date[3]}` : null,
    year: date ? Number(date[1]) : null,
    channel: d.channel || d.uploader || null,
    url: /^https?:\/\//.test(d.webpage_url || '') ? d.webpage_url : null,
    chapters: Array.isArray(d.chapters)
      ? d.chapters.filter((c) => Number.isFinite(Number(c?.start_time))).map((c) => ({ start: Number(c.start_time), title: String(c.title || '').slice(0, 200) }))
      : [],
  };
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
  VIDEO_EXT, isVideo, extraInfo, discTitle, isExtraName, EXTRA_LABELS, cleanName, parseTitleYear, parseMovie, parseEpisode, seasonFromDir,
  findSidecarSubs, findLocalArt, findFolderArt, readVideoInfo, idsFromName,
};
