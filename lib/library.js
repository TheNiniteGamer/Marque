'use strict';
// Read-side helpers: turn stored records into API responses, build hubs, compute "up next".
// Everything is per user: watch progress lives in store.data.progress[userId][itemId], and users only
// see libraries they have access to. Displayed values come from (highest first) admin edits,
// matched online metadata, then what was parsed from the file name.

const path = require('node:path');
const media = require('./media');
const { langName } = require('./subtitles');
const { canSeeLibrary } = require('./auth');
const { EXTRA_LABELS } = require('./parse');

const WATCHED_RATIO = 0.9;
const epOrder = (a, b) => (a.season ?? 999) - (b.season ?? 999) || (a.episode ?? 9999) - (b.episode ?? 9999) ||
  String(a.title || '').localeCompare(String(b.title || ''));

// Layered field lookup: edits > meta > parsed.
const pick = (o, field) => o.edits?.[field] ?? o.meta?.[field] ?? null;
// Changes whenever artwork may have changed, so clients can bust their image cache.
const artVersion = (o) => `${o.edits?.updatedAt || 0}${o.meta?.fetchedAt || 0}`.replace(/^0+/, '') || '0';

const progressMap = (store, user) => store.data.progress[user.id] || {};
const watchlistMap = (store, user) => store.data.watchlist?.[user.id] || {};
const visibleItems = (store, user) => Object.values(store.data.items).filter((i) => canSeeLibrary(user, i.libraryId));
const visibleShows = (store, user) => Object.values(store.data.shows).filter((s) => canSeeLibrary(user, s.libraryId));

function progressOf(store, user, id) {
  const p = progressMap(store, user)[id];
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
    duration: it.media?.duration || 0,
    addedAt: it.addedAt,
    overview: pick(it, 'overview'),
    rating: it.meta?.rating || null,
    genres: pick(it, 'genres') || [],
    artV: artVersion(it),
    progress: progressOf(store, user, it.id),
    inWatchlist: !!watchlistMap(store, user)[it.id],
  };
}

function itemDetail(store, user, it) {
  const subs = [
    ...(it.sidecarSubs || []).map((s, i) => ({
      id: `ext${i}`, label: [langName(s.lang) || path.basename(s.file), s.forced && 'Forced', s.sdh && 'SDH', `(${s.format.toUpperCase()})`].filter(Boolean).join(' '),
      lang: s.lang,
    })),
    ...(it.media?.subtitles || []).filter((s) => s.text).map((s) => ({
      id: `emb${s.index}`, label: [s.title || langName(s.lang) || `Track ${s.index + 1}`, s.forced && 'Forced', '(Embedded)'].filter(Boolean).join(' '),
      lang: s.lang,
    })),
    ...(it.downloadedSubs || []).map((s, i) => ({
      id: `dl${i}`, label: [langName(s.lang) || 'Subtitles', '(OpenSubtitles)'].join(' '), lang: s.lang, downloaded: true, release: s.release || null,
    })),
    // Blu-ray / DVD subtitles are pictures: the server draws them into the video (`burn` = stream index).
    ...(it.media?.subtitles || []).filter((s) => media.IMAGE_SUB_CODECS.has(s.codec)).map((s) => ({
      id: `img${s.index}`, label: [s.title || langName(s.lang) || `Track ${s.index + 1}`, s.forced && 'Forced', '(Picture)'].filter(Boolean).join(' '),
      lang: s.lang, burn: s.index,
    })),
  ];
  const show = it.showId ? store.data.shows[it.showId] : null;
  const detail = {
    ...itemSummary(store, user, it),
    tagline: pick(it, 'tagline'),
    airDate: it.meta?.airDate || null,
    cast: (it.type === 'episode' ? show?.meta?.cast : it.meta?.cast) || [],
    match: matchInfo(it.type === 'episode' ? show : it),
    edited: Object.keys(it.edits || {}).filter((k) => k !== 'updatedAt'),
    file: user.role === 'admin' ? it.file : null,
    fileName: path.basename(it.file), size: it.size,
    media: it.media,
    directPlay: !!it.media && media.canDirectPlay(it),
    intro: it.intro?.end ? { start: it.intro.start, end: it.intro.end, manual: !!it.intro.manual } : null,
    introSetByHand: !!it.intro?.manual,
    credits: it.credits?.start ? { start: it.credits.start, manual: !!it.credits.manual } : null,
    channel: it.meta?.channel || null, sourceUrl: it.meta?.url || null, chapters: it.chapters || [],
    creditsSetByHand: !!it.credits?.manual,
    subtitles: subs,
    audioTracks: (it.media?.audio || []).map((a, i) => ({
      index: i, label: [a.title || langName(a.lang) || `Track ${i + 1}`, a.codec?.toUpperCase(), a.channels && `${a.channels}ch`].filter(Boolean).join(' · '),
    })),
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
  return Object.values(store.data.items).filter((x) => x.type === 'extra' && x.parentId === parentId)
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((x) => ({ ...itemSummary(store, user, x), extraLabel: EXTRA_LABELS[x.extraKind] || 'Extra' }));
}

function matchInfo(o) {
  const m = o?.meta;
  if (!m) return null;
  if (m.provider || m.tmdbId) return { provider: m.provider || 'tmdb', providerId: m.providerId || String(m.tmdbId), uncertain: !!m.uncertain };
  return m.unmatched ? { unmatched: true } : m.notFound ? { notFound: true } : null;
}

// Episodes grouped by show. A page can ask for hundreds of shows' episodes (Continue Watching, the
// TV library), and looking through every item for each one took seconds on big libraries, so the
// grouping is built once and reused until the next turn of the event loop (so it never goes stale).
let epIndex = null;
function episodeIndex(store) {
  if (epIndex?.store !== store) {
    const map = new Map();
    for (const it of Object.values(store.data.items)) {
      if (!it.showId) continue;
      let list = map.get(it.showId);
      if (!list) map.set(it.showId, (list = []));
      list.push(it);
    }
    for (const list of map.values()) list.sort(epOrder);
    epIndex = { store, map };
    setImmediate(() => { epIndex = null; });
  }
  return epIndex.map;
}

function episodesOf(store, showId) {
  return (episodeIndex(store).get(showId) || []).slice();
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
    addedAt: s.addedAt, lastAddedAt: s.lastAddedAt,
    episodeCount: eps.length, unwatchedCount: eps.length - watched,
    seasonCount: new Set(eps.map((e) => e.season)).size,
    artV: artVersion(s),
    inWatchlist: !!watchlistMap(store, user)[s.id],
  };
}

function showDetail(store, user, s) {
  const eps = episodesOf(store, s.id);
  const seasons = new Map();
  for (const e of eps) {
    const key = e.season ?? -1;
    if (!seasons.has(key)) seasons.set(key, []);
    seasons.get(key).push(itemSummary(store, user, e));
  }
  return {
    ...showSummary(store, user, s),
    cast: s.meta?.cast || [],
    match: matchInfo(s),
    edited: Object.keys(s.edits || {}).filter((k) => k !== 'updatedAt'),
    seasons: [...seasons].map(([n, episodes]) => ({
      season: n === -1 ? null : n,
      title: n === -1 ? 'Unsorted' : n === 0 ? 'Specials' : `Season ${n}`,
      episodes,
    })),
    upNext: upNextForShow(store, user, eps),
    extras: extrasOf(store, user, s.id),
  };
}

// Next episode to watch: continue an in-progress one, else the one after the latest watched.
function upNextForShow(store, user, eps) {
  const prog = progressMap(store, user);
  let lastWatchedIdx = -1, lastAt = -1;
  eps.forEach((e, i) => {
    const p = prog[e.id];
    if (p && (p.watched || p.position > 0) && p.updatedAt > lastAt) { lastAt = p.updatedAt; lastWatchedIdx = i; }
  });
  if (lastWatchedIdx === -1) {
    const first = eps.find((e) => (e.season ?? 1) > 0) || eps[0];
    return first ? itemSummary(store, user, first) : null;
  }
  const last = eps[lastWatchedIdx];
  if (!prog[last.id].watched) return itemSummary(store, user, last);
  const next = eps.slice(lastWatchedIdx + 1).find((e) => !prog[e.id]?.watched);
  return next ? itemSummary(store, user, next) : null;
}

function continueWatching(store, user, limit = 20) {
  const { items } = store.data;
  const progress = progressMap(store, user);
  const hidden = store.data.cwHidden?.[user.id] || {};
  const out = [];
  for (const it of visibleItems(store, user)) {
    const p = progress[it.id];
    if (it.type === 'movie' && p && !p.watched && p.position > 15 && !(hidden[it.id] >= p.updatedAt)) out.push({ at: p.updatedAt, item: it });
  }
  for (const s of visibleShows(store, user)) {
    const eps = episodesOf(store, s.id);
    const lastAt = Math.max(-1, ...eps.map((e) => progress[e.id]?.updatedAt || -1));
    if (lastAt < 0 || hidden[s.id] >= lastAt) continue;
    const next = upNextForShow(store, user, eps);
    if (next) out.push({ at: lastAt, item: items[next.id] });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit).map((x) => itemSummary(store, user, x.item));
}

// "Remove from Continue Watching": hidden until there is new activity.
function hideFromContinue(store, user, id) {
  const it = store.data.items[id];
  const key = it?.type === 'episode' ? it.showId : id;
  ((store.data.cwHidden ||= {})[user.id] ||= {})[key] = Date.now();
  store.save();
}

function watchlist(store, user) {
  const list = watchlistMap(store, user);
  return Object.entries(list).sort((a, b) => b[1] - a[1]).map(([id]) => {
    const it = store.data.items[id];
    if (it && canSeeLibrary(user, it.libraryId)) return itemSummary(store, user, it);
    const s = store.data.shows[id];
    if (s && canSeeLibrary(user, s.libraryId)) return showSummary(store, user, s);
    return null;
  }).filter(Boolean);
}

function setWatchlist(store, user, id, on) {
  const map = ((store.data.watchlist ||= {})[user.id] ||= {});
  if (on) map[id] = Date.now(); else delete map[id];
  store.save();
}

const libraryTargets = (store, library) => (library.type === 'show'
  ? Object.values(store.data.shows).filter((s) => s.libraryId === library.id)
  : Object.values(store.data.items).filter((i) => i.libraryId === library.id && i.type === 'movie'));
const summaryOf = (store, user, o) => (o.type === 'movie' ? itemSummary(store, user, o) : showSummary(store, user, o));

function libraryContents(store, user, library) {
  return libraryTargets(store, library).map((o) => summaryOf(store, user, o));
}

// Newest first; only the ones shown are turned into summaries.
function recentlyAdded(store, user, library, limit) {
  return libraryTargets(store, library).sort((a, b) => (b.lastAddedAt || b.addedAt) - (a.lastAddedAt || a.addedAt))
    .slice(0, limit).map((o) => summaryOf(store, user, o));
}

// ---------- home page ----------
const genresOf = (o) => pick(o, 'genres') || [];
const hasBackdrop = (o) => !!(o.edits?.backdrop || o.meta?.backdrop || o.backdrop);
const titlesOf = (store, user) => [...visibleItems(store, user).filter((i) => i.type === 'movie'), ...visibleShows(store, user)];
// The same order all day, a different one tomorrow (so rows and the banner change daily, not on every visit).
const dayKey = () => Math.floor(Date.now() / 86400_000);
function dailyOrder(list) {
  const day = dayKey();
  const h = (s) => { let x = day; for (const c of s) x = (Math.imul(x, 31) + c.charCodeAt(0)) | 0; return x; };
  return [...list].sort((a, b) => h(a.id) - h(b.id));
}

// Movies and shows sharing genres with this one, most shared first ("More like this").
function similar(store, user, target, limit = 12) {
  const mine = new Set(genresOf(target).map((g) => g.toLowerCase()));
  if (!mine.size) return [];
  return titlesOf(store, user)
    .filter((o) => o.id !== target.id)
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
  const pool = titlesOf(store, user).filter((o) => hasBackdrop(o) && pick(o, 'overview'));
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
  // A trailer the browser can play as it is plays quietly behind the banner.
  const trailer = Object.values(store.data.items).find((x) => x.type === 'extra' && x.parentId === o.id && x.extraKind === 'trailer' && x.media && media.canDirectPlay(x));
  return { ...summary, overview: pick(o, 'overview'), play, trailerId: trailer?.id || null };
}

function home(store, user) {
  const hubs = [];
  const cw = continueWatching(store, user);
  if (cw.length) hubs.push({ key: 'continue', title: 'Continue Watching', style: 'wide', items: cw });
  const mine = watchlist(store, user).filter((x) => (x.type === 'show' ? x.unwatchedCount > 0 : !x.progress?.watched));
  if (mine.length) hubs.push({ key: 'watchlist', title: 'My List', style: 'poster', items: mine.slice(0, 24), link: '#/watchlist' });
  for (const lib of store.data.libraries.filter((l) => canSeeLibrary(user, l.id))) {
    const contents = recentlyAdded(store, user, lib, 24);
    if (contents.length) hubs.push({ key: `recent-${lib.id}`, title: `New in ${lib.name}`, libraryId: lib.id, style: 'poster', items: contents });
  }
  // "Because you watched …": like the last thing watched.
  const last = Object.entries(progressMap(store, user)).sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .map(([id]) => store.data.items[id]).find((it) => it && canSeeLibrary(user, it.libraryId) && (it.type === 'movie' || it.type === 'episode'));
  const seed = last && (last.type === 'episode' ? store.data.shows[last.showId] : last);
  const like = seed ? similar(store, user, seed, 20) : [];
  if (like.length >= 4) hubs.push({ key: 'because', title: `Because you watched ${pick(seed, 'title') || seed.title}`, style: 'poster', items: like });
  // A few of the biggest genres.
  const counts = new Map();
  const all = titlesOf(store, user);
  for (const o of all) for (const g of genresOf(o)) counts.set(g, (counts.get(g) || 0) + 1);
  const top = [...counts].filter(([, n]) => n >= 6).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g]) => g);
  for (const g of top) {
    const items = dailyOrder(all.filter((o) => genresOf(o).includes(g))).slice(0, 20).map((o) => summaryOf(store, user, o));
    hubs.push({ key: `genre-${g}`, title: g, style: 'poster', items });
  }
  return { hero: featured(store, user), hubs };
}

function search(store, user, q, limit = 30) {
  const needle = q.trim().toLowerCase();
  if (!needle) return { movies: [], shows: [], episodes: [] };
  const match = (o) => [o.title, o.meta?.title, o.edits?.title, o.edits?.sortTitle].some((f) => f && String(f).toLowerCase().includes(needle));
  const items = visibleItems(store, user);
  return {
    movies: items.filter((i) => i.type === 'movie' && match(i)).slice(0, limit).map((i) => itemSummary(store, user, i)),
    shows: visibleShows(store, user).filter(match).slice(0, limit).map((s) => showSummary(store, user, s)),
    episodes: items.filter((i) => i.type === 'episode' && match(i)).slice(0, limit).map((i) => itemSummary(store, user, i)),
  };
}

// lazy: an ordinary "still playing" report; saved within a minute rather than straight away.
function setProgress(store, user, it, position, { lazy = false } = {}) {
  const duration = it.media?.duration || 0;
  const map = (store.data.progress[user.id] ||= {});
  const prev = map[it.id] || {};
  const watched = duration > 0 && position >= duration * WATCHED_RATIO;
  map[it.id] = {
    position: watched ? 0 : Math.max(0, position),
    watched: watched || (!!prev.watched && position < 15), // re-watching from the start keeps the mark
    updatedAt: Date.now(),
  };
  store.save({ lazy: lazy && map[it.id].watched === !!prev.watched });
  return progressOf(store, user, it.id);
}

function setWatched(store, user, ids, watched) {
  const now = Date.now();
  const map = (store.data.progress[user.id] ||= {});
  for (const id of ids) {
    if (watched) map[id] = { position: 0, watched: true, updatedAt: now };
    else delete map[id];
  }
  store.save();
}

module.exports = {
  pick, progressOf, itemSummary, itemDetail, showSummary, showDetail, episodesOf, libraryContents, home, search, similar,
  setProgress, setWatched, continueWatching, hideFromContinue, watchlist, setWatchlist,
};
