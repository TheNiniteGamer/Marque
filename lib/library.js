'use strict';
// Read-side helpers: turn stored records into API responses, build hubs, compute "up next".
// Everything is per user: watch progress lives in store.data.progress[userId][itemId], and users only
// see libraries they have access to. Displayed values come from (highest first) admin edits,
// matched online metadata, then what was parsed from the file name.

const path = require('node:path');
const media = require('./media');
const { langName } = require('./subtitles');
const { canSeeLibrary } = require('./auth');
const { canSeeTitle, allowedFor, ratingOf } = require('./ratings');
const { EXTRA_LABELS, normTitle } = require('./parse');
const searchLib = require('./search');

const WATCHED_RATIO = 0.9;
const epOrder = (a, b) => (a.season ?? 999) - (b.season ?? 999) || (a.episode ?? 9999) - (b.episode ?? 9999) ||
  String(a.title || '').localeCompare(String(b.title || ''));

// Layered field lookup: edits > meta > parsed.
const pick = (o, field) => o.edits?.[field] ?? o.meta?.[field] ?? null;
// Changes whenever artwork may have changed, so clients can bust their image cache.
const artVersion = (o) => `${o.edits?.updatedAt || 0}${o.meta?.fetchedAt || 0}`.replace(/^0+/, '') || '0';

const progressMap = (store, user) => store.data.progress[user.id] || {};
const watchlistMap = (store, user) => store.data.watchlist?.[user.id] || {};
// Cast for the apps: photos come through the server (cached), so the TVs never need the internet.
const castList = (cast) => cast.map((c) => ({ name: c.name, character: c.character || null, photo: c.photo ? `/api/people/${encodeURIComponent(c.name)}/photo` : null }));

/** A person's page: the titles this user can see that list them in the cast. */
function person(store, user, name) {
  const want = String(name).trim().toLowerCase();
  let photo = null;
  const titles = [];
  for (const o of titlesOf(store, user)) {
    const c = (o.meta?.cast || []).find((x) => x.name?.toLowerCase() === want);
    if (!c) continue;
    if (c.photo && !photo) photo = c.photo;
    titles.push({ ...(o.type === 'movie' ? itemSummary(store, user, o) : showSummary(store, user, o)), character: c.character || null });
  }
  titles.sort((a, b) => (b.year || 0) - (a.year || 0));
  return { name: String(name).trim(), photoSource: photo, titles };
}
// Thumbs up / down per film or show: { id: { v: 1 | -1, at } }. A thumbs-down keeps a title out of
// suggestions (banner, "Because you…", genre rows, More like this); a thumbs-up seeds "Because you liked".
const thumbsMap = (store, user) => store.data.thumbs?.[user.id] || {};
const thumbOf = (store, user, id) => thumbsMap(store, user)[id]?.v || 0;
function setThumb(store, user, id, value) {
  if (store.data.items[id]) id = primaryId(store, id);
  const map = ((store.data.thumbs ||= {})[user.id] ||= {});
  if (value === 1 || value === -1) map[id] = { v: value, at: Date.now() }; else delete map[id];
  store.save({ lazy: true, personal: true });
  return map[id]?.v || 0;
}
const suggestable = (store, user) => { const t = thumbsMap(store, user); return (o) => t[o.id]?.v !== -1; };

// Per show: { audio: language, subs: language | 'off' }, as last chosen in a player.
const trackPrefs = (store, user) => store.data.trackPrefs?.[user.id] || {};
const LANG_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i;
function setTrackPrefs(store, user, showId, { audio, subs }) {
  const clean = (v, off) => (v === off && off ? off : typeof v === 'string' && LANG_RE.test(v) ? v.toLowerCase() : null);
  const pref = { audio: clean(audio), subs: clean(subs, 'off') };
  ((store.data.trackPrefs ||= {})[user.id] ||= {})[showId] = pref;
  store.save({ lazy: true, personal: true });
  return pref;
}
// Lookup tables built from the whole library (episodes per show, trailers, what each profile can
// see…). Building them means going through every video, which on a big library was most of a page's
// time, so they're kept until the database changes (store.rev goes up with every change apart from
// watch positions and the like) and for a minute at most. A store without a revision (tests' plain
// objects) gets fresh ones on each turn of the event loop. The results are shared: don't change them.
const memos = new WeakMap();
const MEMO_MAX_AGE_MS = 60_000;
function memo(store, key, build) {
  let m = memos.get(store);
  const rev = store.rev;
  if (!m || m.rev !== rev || Date.now() - m.at > MEMO_MAX_AGE_MS) {
    m = { rev, at: Date.now(), values: new Map() };
    memos.set(store, m);
    if (rev === undefined) setImmediate(() => { if (memos.get(store) === m) memos.delete(store); });
  }
  if (!m.values.has(key)) m.values.set(key, build());
  return m.values.get(key);
}

// ---------- versions of a film ----------
// Several copies of one film (a 4K HDR one for the big TV and a 1080p one for everything else; a
// theatrical and an extended cut) are one title: same library, and matched to the same online
// entry, or with the same name and year. The copy added first is the title (its watch progress,
// My List entry and edits count for all); the others are its versions, and each player plays the
// one it can play as it is (see versionsOf).
function versionIndex(store) {
  return memo(store, 'versions', () => {
    const groups = new Map();
    for (const it of Object.values(store.data.items)) {
      if (it.type !== 'movie') continue;
      const m = it.meta;
      const year = pick(it, 'year') || it.year;
      // (A match Marquee isn't sure of doesn't group: two different films wrongly matched to one
      // entry would otherwise hide one behind the other.)
      const key = m?.provider && m.providerId && !m.notFound && !m.uncertain ? `${it.libraryId}|${m.provider}:${m.providerId}`
        : year ? `${it.libraryId}|${normTitle(pick(it, 'title') || it.title)}|${year}` : null;
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    const byId = new Map();
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      g.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0) || a.id.localeCompare(b.id));
      for (const it of g) byId.set(it.id, g);
    }
    return byId;
  });
}
/** The title a copy belongs to (itself, unless it's another version of a film or a converted copy). */
const primaryOf = (store, it) => {
  if (it?.optimizedOf) it = store.data.items[it.optimizedOf] || it;
  return (it && versionIndex(store).get(it.id)?.[0]) || it;
};
const primaryId = (store, id) => primaryOf(store, resolveItem(store, id))?.id || id;
const isOtherVersion = (store, it) => primaryOf(store, it) !== it;

// ---------- converted copies (optimize.js) ----------
// A file most players can't play as it is (a DVD rip, 4K, HEVC) can have a 1080p H.264 copy made
// overnight. The copy is offered as another version of the film or episode, with the id
// "<id>~o"; everything else about it (its progress, intro, subtitle files…) is the original's.
const OPTIMIZED = '~o';
function optimizedView(base) {
  const o = base.optimized;
  return Object.assign(Object.create(base), { id: base.id + OPTIMIZED, file: o.file, size: o.size, media: o.media, mtime: o.createdAt, optimizedOf: base.id });
}
/** An item by id, including converted copies ("<id>~o"); null when there's none. */
function resolveItem(store, id) {
  id = String(id ?? '');
  if (Object.hasOwn(store.data.items, id)) return store.data.items[id];
  if (!id.endsWith(OPTIMIZED)) return null;
  const base = Object.hasOwn(store.data.items, id.slice(0, -OPTIMIZED.length)) ? store.data.items[id.slice(0, -OPTIMIZED.length)] : null;
  return base?.optimized ? optimizedView(base) : null;
}
/** The item a converted copy was made from (or the item itself). */
const realItem = (store, it) => (it?.optimizedOf ? store.data.items[it.optimizedOf] : it);
// A converted copy leaves picture subtitles with the original (overnight copies keep text ones
// only): its list shows the original's, and drawing one in converts from the original instead.
const pictureSubsOf = (store, it) => realItem(store, it) || it;

const RES = (v) => { const h = Math.max(v?.height || 0, Math.round(((v?.width || 0) * 9) / 16)); return h >= 2000 ? '4K' : h >= 1400 ? '1440p' : h >= 1000 ? '1080p' : h >= 700 ? '720p' : h ? 'SD' : ''; };
const CODEC = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', mpeg2video: 'MPEG-2', mpeg4: 'MPEG-4', vc1: 'VC-1' };
/** A title's copies (a film's versions, and converted copies), for players to choose from (and
 * people, on its page); null for just one. */
function versionsOf(store, it) {
  const base = realItem(store, it);
  const g = (base.type === 'movie' && versionIndex(store).get(base.id)) || [base];
  const copies = g.flatMap((x) => (x.optimized ? [x, optimizedView(x)] : [x]));
  if (copies.length < 2) return null;
  const list = copies.map((x) => {
    const v = x.media?.video || {};
    const hdr = v.colorTransfer === 'smpte2084' ? 'HDR10' : v.colorTransfer === 'arib-std-b67' ? 'HLG' : null;
    // "Dune (2021) - 4K HDR.mkv" (Plex's way of naming versions) gives its own label.
    const named = x.optimizedOf ? `Converted ${RES(v) || 'copy'}` : / - ([^-]+)$/.exec(path.basename(x.file, path.extname(x.file)))?.[1]?.trim();
    return {
      id: x.id, label: named || [RES(v), hdr, CODEC[v.codec] || v.codec].filter(Boolean).join(' · ') || 'Version',
      fileName: path.basename(x.file), size: x.size || null, duration: x.media?.duration || 0,
      width: v.width || null, height: v.height || null, hdr, videoCodec: v.codec || null, profile: v.profile || null, pixFmt: v.pixFmt || null,
      audioCodec: x.media?.audio?.[0]?.codec || null, container: x.media?.container || null,
      directPlay: !!x.media && media.canDirectPlay(x), remux: !!x.media && media.canRemux(x),
    };
  });
  // Two copies with the same label (two cuts at 1080p): told apart by their file names.
  for (const v of list) if (list.filter((o) => o.label === v.label).length > 1) v.label = path.basename(v.fileName, path.extname(v.fileName));
  return list;
}

// What a profile can see. A page asks many times (each home row, "More like this", search…).
function visible(store, user) {
  return memo(store, `visible:${user?.id}`, () => {
    const items = Object.values(store.data.items).filter((i) => canSeeTitle(store, user, i) && !isOtherVersion(store, i));
    const shows = Object.values(store.data.shows).filter((s) => canSeeTitle(store, user, s));
    return { items, shows, titles: [...items.filter((i) => i.type === 'movie'), ...shows] };
  });
}
const visibleItems = (store, user) => visible(store, user).items;
const visibleShows = (store, user) => visible(store, user).shows;

function progressOf(store, user, id) {
  const p = progressMap(store, user)[primaryId(store, id)];
  return p ? { position: p.position || 0, watched: !!p.watched, updatedAt: p.updatedAt } : null;
}

function showTitleOf(store, it) {
  const show = it.showId ? store.data.shows[it.showId] : null;
  return show ? pick(show, 'title') || show.title : it.showTitle || null;
}

function itemSummary(store, user, it) {
  const episodeTitle = it.type === 'episode' && it.episode != null ? `Episode ${it.episode}` : null;
  return {
    id: it.id, type: it.type, libraryId: it.libraryId,
    title: pick(it, 'title') || it.title || episodeTitle || path.basename(it.file),
    sortTitle: it.edits?.sortTitle || null,
    year: pick(it, 'year') || it.year || null,
    showId: it.showId || null,
    showTitle: showTitleOf(store, it),
    season: it.season ?? null, episode: it.episode ?? null, episodeEnd: it.episodeEnd ?? null,
    absoluteNumber: it.absMapped ? it.absMapped.from : null, // ("One Piece - 1071", placed in its season)
    duration: it.media?.duration || 0,
    addedAt: it.addedAt,
    overview: pick(it, 'overview'),
    rating: it.meta?.rating || null,
    contentRating: ratingOf(store, it)?.cert || null,
    thumb: thumbOf(store, user, it.type === 'episode' ? it.showId : primaryId(store, it.id)),
    genres: pick(it, 'genres') || [],
    artV: artVersion(it),
    progress: progressOf(store, user, it.id),
    inWatchlist: !!watchlistMap(store, user)[primaryId(store, it.id)],
    ...(it.type === 'movie' ? { trailerId: trailerOf(store, it.id) } : {}),
  };
}

function itemDetail(store, user, it) {
  // `forced`: only the bits in another language (shown even with subtitles off, in that language).
  const subs = [
    ...(it.sidecarSubs || []).map((s, i) => ({
      id: `ext${i}`, label: [langName(s.lang) || path.basename(s.file), s.forced && 'Forced', s.sdh && 'SDH', `(${s.format.toUpperCase()})`].filter(Boolean).join(' '),
      lang: s.lang, forced: !!s.forced,
    })),
    ...(it.media?.subtitles || []).filter((s) => s.text).map((s) => ({
      id: `emb${s.index}`, label: [s.title || langName(s.lang) || `Track ${s.index + 1}`, s.forced && 'Forced', '(Embedded)'].filter(Boolean).join(' '),
      lang: s.lang, forced: !!s.forced,
    })),
    ...(it.downloadedSubs || []).map((s, i) => ({
      id: `dl${i}`, label: [langName(s.lang) || 'Subtitles', '(OpenSubtitles)'].join(' '), lang: s.lang, downloaded: true, release: s.release || null,
    })),
    // Blu-ray / DVD subtitles are pictures: the server draws them into the video (`burn` = stream index).
    // A converted copy leaves them out, so its list has the original's (drawn in from the original).
    ...(pictureSubsOf(store, it).media?.subtitles || []).filter((s) => media.IMAGE_SUB_CODECS.has(s.codec)).map((s) => ({
      id: `img${s.index}`, label: [s.title || langName(s.lang) || `Track ${s.index + 1}`, s.forced && 'Forced', '(Picture)'].filter(Boolean).join(' '),
      lang: s.lang, burn: s.index, forced: !!s.forced,
    })),
  ];
  const show = it.showId ? store.data.shows[it.showId] : null;
  const detail = {
    ...itemSummary(store, user, it),
    tagline: pick(it, 'tagline'),
    airDate: it.meta?.airDate || null,
    cast: castList((it.type === 'episode' ? show?.meta?.cast : it.meta?.cast) || []),
    match: matchInfo(it.type === 'episode' ? show : it),
    edited: Object.keys(it.edits || {}).filter((k) => k !== 'updatedAt'),
    file: user.role === 'admin' ? it.file : null,
    fileName: path.basename(it.file), size: it.size,
    media: it.media,
    directPlay: !!it.media && media.canDirectPlay(it),
    // Other copies of this film (see versionsOf), and the title this copy is a version of.
    versions: it.type === 'movie' || it.type === 'episode' ? versionsOf(store, it) : null,
    versionOf: (it.type === 'movie' || it.optimizedOf) && isOtherVersion(store, it) ? primaryOf(store, it).id : null,
    intro: it.intro?.end ? { start: it.intro.start, end: it.intro.end, manual: !!it.intro.manual } : null,
    recap: it.recap?.end ? { start: it.recap.start, end: it.recap.end } : null,
    introSetByHand: !!it.intro?.manual,
    credits: it.credits?.start ? { start: it.credits.start, manual: !!it.credits.manual } : null,
    channel: it.meta?.channel || null, sourceUrl: it.meta?.url || null, chapters: it.chapters || [],
    creditsSetByHand: !!it.credits?.manual,
    subtitles: subs,
    audioTracks: (it.media?.audio || []).map((a, i) => ({
      index: i, label: [a.title || langName(a.lang) || `Track ${i + 1}`, a.codec?.toUpperCase(), a.channels && `${a.channels}ch`].filter(Boolean).join(' · '),
      lang: a.lang || null,
    })),
    // The sound and subtitle languages this person last chose for the show (players start with them).
    tracks: it.showId ? trackPrefs(store, user)[it.showId] || null : null,
  };
  if (it.type === 'movie') detail.extras = extrasOf(store, user, it.id);
  if (it.type === 'extra') {
    const parent = store.data.items[it.parentId] || store.data.shows[it.parentId];
    detail.extraLabel = EXTRA_LABELS[it.extraKind] || 'Extra';
    detail.parent = parent ? { id: parent.id, type: parent.type === 'movie' ? 'movie' : 'show', title: pick(parent, 'title') || parent.title } : null;
  }
  if (it.type === 'episode') {
    const eps = episodesOf(store, it.showId);
    const i = eps.findIndex((e) => e.id === it.id);
    detail.next = i >= 0 && eps[i + 1] ? itemSummary(store, user, eps[i + 1]) : null;
    detail.prev = i > 0 ? itemSummary(store, user, eps[i - 1]) : null;
  }
  return detail;
}

// Trailers, featurettes… belonging to a movie or show (see parse.extraInfo).
function extrasOf(store, user, parentId) {
  const byParent = memo(store, 'extras', () => {
    const map = new Map();
    for (const x of Object.values(store.data.items)) {
      if (x.type !== 'extra' || !x.parentId) continue;
      if (!map.has(x.parentId)) map.set(x.parentId, []);
      map.get(x.parentId).push(x);
    }
    for (const list of map.values()) list.sort((a, b) => a.file.localeCompare(b.file));
    return map;
  });
  return (byParent.get(parentId) || []).map((x) => ({ ...itemSummary(store, user, x), extraLabel: EXTRA_LABELS[x.extraKind] || 'Extra' }));
}

function matchInfo(o) {
  const m = o?.meta;
  if (!m) return null;
  if (m.provider || m.tmdbId) return { provider: m.provider || 'tmdb', providerId: m.providerId || String(m.tmdbId), uncertain: !!m.uncertain };
  return m.unmatched ? { unmatched: true } : m.notFound ? { notFound: true } : null;
}

// Episodes grouped by show. A page can ask for hundreds of shows' episodes (Continue Watching, the
// TV library), and looking through every item for each one took seconds on big libraries.
function episodeIndex(store) {
  return memo(store, 'episodes', () => {
    const map = new Map();
    for (const it of Object.values(store.data.items)) {
      if (!it.showId) continue;
      let list = map.get(it.showId);
      if (!list) map.set(it.showId, (list = []));
      list.push(it);
    }
    for (const list of map.values()) list.sort(epOrder);
    return map;
  });
}

function episodesOf(store, showId) {
  return (episodeIndex(store).get(showId) || []).slice();
}

// A trailer for each movie or show that browsers can play as it is (for previews).
function trailerOf(store, id) {
  return memo(store, 'trailers', () => {
    const map = new Map();
    for (const x of Object.values(store.data.items)) {
      if (x.type === 'extra' && x.extraKind === 'trailer' && x.parentId && !map.has(x.parentId) && x.media && media.canDirectPlay(x)) map.set(x.parentId, x.id);
    }
    return map;
  }).get(id) || null;
}

function showSummary(store, user, s) {
  const eps = episodesOf(store, s.id);
  const prog = progressMap(store, user);
  const watched = eps.filter((e) => prog[e.id]?.watched).length;
  return {
    id: s.id, type: 'show', libraryId: s.libraryId,
    title: pick(s, 'title') || s.title, sortTitle: s.edits?.sortTitle || null,
    year: pick(s, 'year') || s.year || null,
    overview: pick(s, 'overview'), rating: s.meta?.rating || null, genres: pick(s, 'genres') || [],
    contentRating: ratingOf(store, s)?.cert || null,
    thumb: thumbOf(store, user, s.id),
    addedAt: s.addedAt, lastAddedAt: s.lastAddedAt,
    episodeCount: eps.length, unwatchedCount: eps.length - watched,
    seasonCount: new Set(eps.map((e) => e.season)).size,
    artV: artVersion(s),
    inWatchlist: !!watchlistMap(store, user)[s.id],
    trailerId: trailerOf(store, s.id),
  };
}

const seasonTitle = (n) => (n == null ? 'Unsorted' : n === 0 ? 'Specials' : `Season ${n}`);
/** A season named in a request ("3", "0", "null" for Unsorted) as stored on episodes. */
const seasonParam = (v) => (v === 'null' || v === '' ? null : Number.isInteger(Number(v)) ? Number(v) : undefined);

/**
 * A show's page. `episodes` says how much of it to send: all of it (the default, which older TV
 * apps expect), 'none', or one season's episodes ('auto' = the season of the next episode to watch,
 * or a season number). Long-running shows (a thousand episodes) load far faster on a Roku a
 * season at a time; the other seasons come with their episode count and whether they're watched.
 */
function showDetail(store, user, s, { episodes: only = 'all' } = {}) {
  const eps = episodesOf(store, s.id);
  const prog = progressMap(store, user);
  const seasons = new Map();
  for (const e of eps) {
    const key = e.season ?? null;
    if (!seasons.has(key)) seasons.set(key, []);
    seasons.get(key).push(e);
  }
  let upNext = upNextForShow(store, user, eps);
  // All watched: Play starts the show again (`again`), from its first episode.
  if (!upNext && eps.length) upNext = { ...itemSummary(store, user, eps.find((e) => (e.season ?? 1) > 0) || eps[0]), again: true };
  let loaded = null; // the season sent in full (undefined: every season)
  if (only === 'all') loaded = undefined;
  else if (only !== 'none') {
    const want = only === 'auto' ? undefined : seasonParam(only);
    loaded = seasons.has(want) ? want : upNext && seasons.has(upNext.season ?? null) ? upNext.season ?? null : seasons.keys().next().value;
  }
  const sendAll = loaded === undefined;
  return {
    ...showSummary(store, user, s),
    numbering: s.edits?.numbering || 'auto',
    cast: castList(s.meta?.cast || []),
    match: matchInfo(s),
    edited: Object.keys(s.edits || {}).filter((k) => k !== 'updatedAt'),
    seasons: [...seasons].map(([n, list]) => ({
      season: n,
      title: seasonTitle(n),
      count: list.length,
      watched: list.every((e) => prog[e.id]?.watched),
      episodes: sendAll || n === loaded ? list.map((e) => itemSummary(store, user, e)) : null,
    })),
    upNext,
    extras: extrasOf(store, user, s.id),
    // Admins: where the show is on disk, and each episode's file (on its own when sent a season at a time).
    ...(user.role === 'admin' ? { files: sendAll ? showFiles(s, eps) : { folder: s.dir || null, count: eps.length, episodes: null } } : {}),
  };
}

/** One season's episodes, for a show page sent a season at a time. */
function seasonEpisodes(store, user, s, season) {
  const n = seasonParam(season);
  const list = episodesOf(store, s.id).filter((e) => (e.season ?? null) === n);
  return { season: n ?? null, title: seasonTitle(n ?? null), episodes: list.map((e) => itemSummary(store, user, e)) };
}

function showFiles(s, eps) {
  return {
    folder: s.dir || null,
    count: eps.length,
    episodes: eps.map((e) => ({
      id: e.id, season: e.season ?? null, episode: e.episode ?? null, episodeEnd: e.episodeEnd ?? null, file: e.file, size: e.size || null,
      video: e.media?.video ? `${String(e.media.video.codec || '').toUpperCase()} ${e.media.video.width}×${e.media.video.height}` : null,
    })),
  };
}

// Next episode to watch: continue an in-progress one, else the one after the latest watched (the
// very next one when that was a rewatch, so watching a show again carries on in order).
function upNextForShow(store, user, eps) {
  const prog = progressMap(store, user);
  const latest = (pick) => {
    let idx = -1, at = -1;
    eps.forEach((e, i) => {
      const p = prog[e.id];
      // (Ties, like a season marked watched at once, go to the later episode.)
      if (pick(e) && p && (p.watched || p.position > 0) && p.updatedAt >= at) { at = p.updatedAt; idx = i; }
    });
    return idx;
  };
  // Specials (Season 0: a show's films and one-offs) don't move your place in the series, unless
  // one is part-way through or they're all you've watched.
  let i = latest(() => true);
  if (i >= 0 && eps[i].season === 0 && prog[eps[i].id].watched) {
    const main = latest((e) => e.season !== 0);
    if (main >= 0) i = main;
  }
  if (i === -1) {
    const first = eps.find((e) => (e.season ?? 1) > 0) || eps[0];
    return first ? itemSummary(store, user, first) : null;
  }
  const last = eps[i], p = prog[last.id];
  if (!p.watched) return itemSummary(store, user, last);
  const after = eps.slice(i + 1);
  const next = p.again ? after[0] : after.find((e) => !prog[e.id]?.watched);
  return next ? itemSummary(store, user, next) : null;
}

// Goes through what this person has watched (not the whole library): films part-way through, and
// for each show with activity, its next episode.
function continueWatching(store, user, limit = 20) {
  const { items, shows } = store.data;
  const progress = progressMap(store, user);
  const hidden = store.data.cwHidden?.[user.id] || {};
  const out = [];
  const showLast = new Map(); // show id -> latest activity
  const films = new Set();
  for (const [id, p] of Object.entries(progress)) {
    const it = primaryOf(store, items[id]); // (progress kept from before a film had versions)
    if (!it || !p) continue;
    if (it.type === 'movie') {
      if (!p.watched && p.position > 15 && !(hidden[it.id] >= p.updatedAt) && canSeeTitle(store, user, it) && !films.has(it.id)) { films.add(it.id); out.push({ at: p.updatedAt, item: it }); }
    } else if (it.type === 'episode' && it.showId && (p.updatedAt || 0) > (showLast.get(it.showId) ?? -1)) {
      showLast.set(it.showId, p.updatedAt || 0);
    }
  }
  for (const [showId, lastAt] of showLast) {
    const s = shows[showId];
    if (!s || !canSeeTitle(store, user, s)) continue;
    const next = upNextForShow(store, user, episodesOf(store, s.id));
    if (!next) continue;
    // A new episode of a show you'd caught up with comes in at the time it arrived, not when you
    // last watched (and the show comes back if you'd removed it from the row before then).
    const added = items[next.id]?.addedAt || 0;
    const at = !progress[next.id] && added > lastAt ? added : lastAt;
    if (hidden[s.id] >= at) continue;
    out.push({ at, item: items[next.id] });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit).map((x) => itemSummary(store, user, x.item));
}

// Viewing activity: what this profile has watched, most recent first (each film or episode once,
// at the last time it was played), with how far they got.
function history(store, user, { limit = 200 } = {}) {
  const { items } = store.data;
  return Object.entries(progressMap(store, user))
    .map(([id, p]) => ({ it: primaryOf(store, items[id]), p }))
    .filter(({ it, p }) => it && p?.updatedAt && (it.type === 'movie' || it.type === 'episode' || it.type === 'extra') && canSeeTitle(store, user, it))
    .sort((a, b) => b.p.updatedAt - a.p.updatedAt)
    .slice(0, limit)
    .map(({ it, p }) => ({ ...itemSummary(store, user, it), watchedAt: p.updatedAt }));
}
// Removing something from the history forgets it altogether (where it got to, and "watched").
function forget(store, user, id) {
  const map = progressMap(store, user);
  delete map[primaryId(store, id)];
  delete map[id];
  topCache = null;
  store.save({ personal: true });
}

// "Remove from Continue Watching": hidden until there is new activity.
function hideFromContinue(store, user, id) {
  const it = store.data.items[id];
  const key = it?.type === 'episode' ? it.showId : primaryId(store, id);
  ((store.data.cwHidden ||= {})[user.id] ||= {})[key] = Date.now();
  store.save();
}

function watchlist(store, user) {
  const list = watchlistMap(store, user);
  return Object.entries(list).sort((a, b) => b[1] - a[1]).map(([id]) => {
    const it = primaryOf(store, store.data.items[id]);
    if (canSeeTitle(store, user, it)) return itemSummary(store, user, it);
    const s = store.data.shows[id];
    if (canSeeTitle(store, user, s)) return showSummary(store, user, s);
    return null;
  }).filter(Boolean);
}

function setWatchlist(store, user, id, on) {
  id = primaryId(store, id);
  const map = ((store.data.watchlist ||= {})[user.id] ||= {});
  if (on) map[id] = Date.now(); else delete map[id];
  store.save();
}

const libraryTargets = (store, library, user) => memo(store, `library:${library.id}:${library.type}`, () => (library.type === 'show'
  ? Object.values(store.data.shows).filter((s) => s.libraryId === library.id)
  : Object.values(store.data.items).filter((i) => i.libraryId === library.id && i.type === 'movie' && !isOtherVersion(store, i))))
  .filter((o) => !user || allowedFor(store, user, o));
const summaryOf = (store, user, o) => (o.type === 'movie' ? itemSummary(store, user, o) : showSummary(store, user, o));

function libraryContents(store, user, library) {
  return libraryTargets(store, library, user).map((o) => summaryOf(store, user, o));
}

// Newest first; only the ones shown are turned into summaries.
function recentlyAdded(store, user, library, limit) {
  return libraryTargets(store, library, user).sort((a, b) => (b.lastAddedAt || b.addedAt) - (a.lastAddedAt || a.addedAt))
    .slice(0, limit).map((o) => summaryOf(store, user, o));
}

// ---------- home page ----------
const genresOf = (o) => pick(o, 'genres') || [];
const hasBackdrop = (o) => !!(o.edits?.backdrop || o.meta?.backdrop || o.backdrop);
const titlesOf = (store, user) => visible(store, user).titles;
// The same order all day, a different one tomorrow (so rows and the banner change daily, not on every visit).
const dayKey = () => Math.floor(Date.now() / 86400_000);
function dailyOrder(list) {
  const day = dayKey();
  const h = (s) => { let x = day; for (const c of s) x = (Math.imul(x, 31) + c.charCodeAt(0)) | 0; return x; };
  return list.map((o) => ({ o, k: h(o.id) })).sort((a, b) => a.k - b.k).map((x) => x.o);
}

// Movies and shows sharing genres with this one, most shared first ("More like this").
function similar(store, user, target, limit = 12) {
  const mine = new Set(genresOf(target).map((g) => g.toLowerCase()));
  if (!mine.size) return [];
  return titlesOf(store, user)
    .filter((o) => o.id !== target.id)
    .filter(suggestable(store, user))
    .map((o) => ({ o, n: genresOf(o).filter((g) => mine.has(g.toLowerCase())).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || (b.o.meta?.rating || 0) - (a.o.meta?.rating || 0))
    .slice(0, limit)
    .map(({ o }) => summaryOf(store, user, o));
}

// The banner at the top of the home page: a title with artwork and a summary, preferring ones
// added lately that this person hasn't finished; a different one each day.
function featured(store, user) {
  const prog = progressMap(store, user);
  const finished = (o) => (store.data.shows[o.id] ? episodesOf(store, o.id).every((e) => prog[e.id]?.watched) : !!prog[o.id]?.watched);
  const pool = titlesOf(store, user).filter((o) => hasBackdrop(o) && pick(o, 'overview')).filter(suggestable(store, user));
  if (!pool.length) return null;
  const fresh = pool.filter((o) => !finished(o)).sort((a, b) => (b.lastAddedAt || b.addedAt) - (a.lastAddedAt || a.addedAt)).slice(0, 8);
  const o = dailyOrder(fresh.length ? fresh : pool)[0];
  const isShow = !!store.data.shows[o.id];
  const summary = summaryOf(store, user, o);
  let play = null;
  if (isShow) {
    const next = upNextForShow(store, user, episodesOf(store, o.id));
    if (next) play = { id: next.id, label: `${next.progress?.position > 15 && !next.progress.watched ? 'Resume' : 'Play'} S${next.season ?? 1}:E${next.episode ?? 1}`, t: null };
  } else {
    const p = prog[o.id];
    play = p && !p.watched && p.position > 15 ? { id: o.id, label: 'Resume', t: null } : { id: o.id, label: 'Play', t: 0 };
  }
  return { ...summary, overview: pick(o, 'overview'), play, trailerId: trailerOf(store, o.id) };
}

// "Top 10 in your house this week": what everyone on this server watched in the last 7 days, by how
// many people watched each film or show, then how much (episodes count for their show).
// Everyone's history is counted at most every couple of minutes, and again when something starts or
// stops counting (see setProgress), not on every home page. (Not kept for stores without a revision.)
let topCache = null;
const TOP_TTL_MS = 120_000;
const WEEK_MS = 7 * 86400_000;
const countsForTop = (p, since = Date.now() - WEEK_MS) => !!p && p.updatedAt >= since && !!(p.watched || p.position > 120);
function topScores(store) {
  if (store.rev !== undefined && topCache?.store === store && topCache.rev === store.rev && Date.now() - topCache.at < TOP_TTL_MS) return topCache.score;
  const since = Date.now() - WEEK_MS;
  const score = new Map(); // title id -> { people: Set, plays }
  for (const [uid, map] of Object.entries(store.data.progress || {})) {
    if (!map || typeof map !== 'object') continue;
    for (const [id, p] of Object.entries(map)) {
      if (!countsForTop(p, since)) continue;
      const it = store.data.items[id];
      if (!it || (it.type !== 'movie' && it.type !== 'episode')) continue;
      const key = it.type === 'episode' ? it.showId : it.id;
      if (!key) continue;
      const s = score.get(key) || { people: new Set(), plays: 0 };
      s.people.add(uid);
      s.plays++;
      score.set(key, s);
    }
  }
  topCache = { store, rev: store.rev, at: Date.now(), score };
  return score;
}

function topThisWeek(store, user, limit = 10) {
  return [...topScores(store).entries()].map(([id, s]) => ({ o: store.data.items[id] || store.data.shows[id], s }))
    .filter(({ o }) => canSeeTitle(store, user, o))
    .sort((a, b) => b.s.people.size - a.s.people.size || b.s.plays - a.s.plays)
    .slice(0, limit)
    .map(({ o }, i) => ({ ...summaryOf(store, user, o), rank: i + 1 }));
}

// What the home page shows, set by an admin (Settings → Home screen) for everyone. Continue
// Watching is always there; genres / collections: how many of those rows (0 for none).
const HOME_DEFAULTS = { hero: true, top10: true, watchlist: true, recent: true, because: true, liked: true, franchises: true, upcoming: true, genres: 3, collections: 3 };
const homeSettings = (store) => ({ ...HOME_DEFAULTS, ...(store.data.settings?.home || {}) });
function cleanHome(input, current = HOME_DEFAULTS) {
  const out = { ...current };
  for (const [k, v] of Object.entries(input || {})) {
    if (!Object.hasOwn(HOME_DEFAULTS, k)) continue;
    if (typeof HOME_DEFAULTS[k] === 'boolean') out[k] = !!v;
    else {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 8) throw Object.assign(new Error('Between 0 and 8 rows'), { status: 400 });
      out[k] = n;
    }
  }
  return out;
}

function home(store, user) {
  const show = homeSettings(store);
  const hubs = [];
  const cw = continueWatching(store, user);
  if (cw.length) hubs.push({ key: 'continue', title: 'Continue Watching', style: 'wide', items: cw });
  const top = show.top10 ? topThisWeek(store, user) : [];
  if (top.length >= 3) hubs.push({ key: 'top10', title: 'Top 10 in your house this week', style: 'top10', items: top });
  const mine = watchlist(store, user).filter((x) => (x.type === 'show' ? x.unwatchedCount > 0 : !x.progress?.watched));
  if (mine.length && show.watchlist) hubs.push({ key: 'watchlist', title: 'My List', style: 'poster', items: mine.slice(0, 24), link: '#/watchlist' });
  for (const lib of show.recent ? store.data.libraries.filter((l) => canSeeLibrary(user, l.id)) : []) {
    const contents = recentlyAdded(store, user, lib, 24);
    if (contents.length) hubs.push({ key: `recent-${lib.id}`, title: `New in ${lib.name}`, libraryId: lib.id, style: 'poster', items: contents });
  }
  // "Because you watched …": like the last thing watched.
  let last = null, lastAt = -Infinity;
  for (const [id, p] of Object.entries(progressMap(store, user))) {
    const it = store.data.items[id];
    if (p?.updatedAt > lastAt && (it?.type === 'movie' || it?.type === 'episode') && canSeeTitle(store, user, it)) { last = it; lastAt = p.updatedAt; }
  }
  const seed = last && (last.type === 'episode' ? store.data.shows[last.showId] : last);
  // "Because you liked …": like the latest thumbs-up (when it isn't what was just watched).
  const liked = Object.entries(thumbsMap(store, user)).filter(([, t]) => t.v === 1).sort((a, b) => b[1].at - a[1].at)
    .map(([id]) => store.data.items[id] || store.data.shows[id]).find((o) => canSeeTitle(store, user, o) && o.id !== seed?.id);
  const likeThat = liked && show.liked ? similar(store, user, liked, 20) : [];
  if (likeThat.length >= 4) hubs.push({ key: 'liked', title: `Because you liked ${pick(liked, 'title') || liked.title}`, style: 'poster', items: likeThat });
  const like = show.because && seed && thumbOf(store, user, seed.id) !== -1 ? similar(store, user, seed, 20) : [];
  if (like.length >= 4) hubs.push({ key: 'because', title: `Because you watched ${pick(seed, 'title') || seed.title}`, style: 'poster', items: like });
  // A few of the biggest genres.
  const counts = new Map();
  const all = titlesOf(store, user).filter(suggestable(store, user));
  for (const o of all) for (const g of genresOf(o)) counts.set(g, (counts.get(g) || 0) + 1);
  const topGenres = [...counts].filter(([, n]) => n >= 6).sort((a, b) => b[1] - a[1]).slice(0, show.genres).map(([g]) => g);
  for (const g of topGenres) {
    const items = dailyOrder(all.filter((o) => genresOf(o).includes(g))).slice(0, 20).map((o) => summaryOf(store, user, o));
    hubs.push({ key: `genre-${g}`, title: g, style: 'poster', items });
  }
  return { hero: show.hero ? featured(store, user) : null, hubs };
}

// Titles, cast, genres, years and story, forgiving spelling mistakes (see search.js).
function search(store, user, q, limit = 30) {
  if (!q.trim()) return { movies: [], shows: [], episodes: [], understood: [] };
  const { titles, items } = visible(store, user);
  const found = searchLib.find(store, titles, items.filter((i) => i.type === 'episode'), q, limit);
  const summary = (o) => (o.type === 'movie' ? itemSummary(store, user, o) : showSummary(store, user, o));
  return {
    movies: found.titles.filter((r) => r.o.type === 'movie').map((r) => summary(r.o)),
    shows: found.titles.filter((r) => r.o.type !== 'movie').map((r) => summary(r.o)),
    episodes: found.episodes.map((r) => itemSummary(store, user, r.o)),
    understood: found.understood,
  };
}

// lazy: an ordinary "still playing" report; saved within a minute rather than straight away.
function setProgress(store, user, it, position, { lazy = false } = {}) {
  const duration = it.media?.duration || 0;
  // Into the end credits (when they were found, past the halfway point) counts as watched too, so
  // "Next episode" at the credits doesn't leave this one half-watched on any device.
  const credits = it.credits?.start > duration * 0.5 ? it.credits.start : Infinity;
  it = primaryOf(store, it); // (whichever version was played, it's the film's progress)
  const map = (store.data.progress[user.id] ||= {});
  const prev = map[it.id] || {};
  const watched = duration > 0 && (position >= duration * WATCHED_RATIO || position >= credits);
  // `seen`: finished at least once. `again`: this time round is a rewatch (Up next then carries on
  // in order). While a rewatch is part-way, `watched` is off so every app offers to resume it.
  const seen = !!(prev.watched || prev.seen);
  map[it.id] = {
    position: watched ? 0 : Math.max(0, position),
    watched: watched || (!!prev.watched && position < 15), // re-watching from the start keeps the mark
    ...(seen || watched ? { seen: true } : {}),
    ...(seen && (position >= 15 || prev.again) ? { again: true } : {}),
    updatedAt: Date.now(),
  };
  if (countsForTop(map[it.id]) !== countsForTop(prev)) topCache = null;
  store.save({ lazy: lazy && map[it.id].watched === !!prev.watched, personal: true });
  return progressOf(store, user, it.id);
}

// Marking things watched or unwatched returns an undo id: what each one was before is kept for a
// few minutes, so a slip (a whole show marked with one tap) can be put back.
const UNDO_MS = 10 * 60_000;
const undos = new Map(); // id -> { userId, at, before: { itemId: progress record | null } }
function setWatched(store, user, ids, watched) {
  const now = Date.now();
  const map = (store.data.progress[user.id] ||= {});
  const before = {};
  for (const raw of ids) {
    const id = primaryId(store, raw);
    for (const k of [id, raw]) if (!(k in before)) before[k] = map[k] ? { ...map[k] } : null;
    if (watched) map[id] = { position: 0, watched: true, seen: true, updatedAt: now };
    else { delete map[id]; delete map[raw]; }
  }
  topCache = null;
  store.save();
  for (const [k, u] of undos) if (u.at < now - UNDO_MS) undos.delete(k);
  const undo = require('node:crypto').randomBytes(9).toString('base64url');
  undos.set(undo, { userId: user.id, at: now, before });
  return undo;
}
function undoWatched(store, user, undo) {
  const u = undos.get(String(undo || ''));
  if (!u || u.userId !== user.id || u.at < Date.now() - UNDO_MS) return false;
  undos.delete(undo);
  const map = (store.data.progress[user.id] ||= {});
  for (const [id, rec] of Object.entries(u.before)) { if (rec) map[id] = rec; else delete map[id]; }
  topCache = null;
  store.save();
  return true;
}

module.exports = {
  homeSettings, cleanHome, memo, pick, progressOf, itemSummary, itemDetail, setTrackPrefs, person, setThumb, showSummary, showDetail, seasonEpisodes, showFiles, episodesOf, libraryContents, home, search, similar,
  setProgress, setWatched, undoWatched, continueWatching, hideFromContinue, watchlist, setWatchlist,
  versionsOf, primaryOf, primaryId, isOtherVersion, resolveItem, realItem, pictureSubsOf, optimizedView, history, forget,
};
