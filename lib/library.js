'use strict';
// Read-side helpers: turn stored records into API responses, build hubs, compute "up next".

const path = require('node:path');
const media = require('./media');
const { langName } = require('./subtitles');

const WATCHED_RATIO = 0.9;
const epOrder = (a, b) => (a.season ?? 999) - (b.season ?? 999) || (a.episode ?? 9999) - (b.episode ?? 9999) ||
  String(a.title || '').localeCompare(String(b.title || ''));

function progressOf(store, id) {
  const p = store.data.progress[id];
  return p ? { position: p.position || 0, watched: !!p.watched, updatedAt: p.updatedAt } : null;
}

function itemSummary(store, it) {
  const show = it.showId ? store.data.shows[it.showId] : null;
  return {
    id: it.id, type: it.type, libraryId: it.libraryId,
    title: it.meta?.title || it.title || (it.type === 'episode' && it.episode != null ? `Episode ${it.episode}` : path.basename(it.file)),
    year: it.meta?.year || it.year || null,
    showId: it.showId || null,
    showTitle: show ? show.meta?.title || show.title : it.showTitle || null,
    season: it.season ?? null, episode: it.episode ?? null, episodeEnd: it.episodeEnd ?? null,
    duration: it.media?.duration || 0,
    addedAt: it.addedAt,
    overview: it.meta?.overview || null,
    rating: it.meta?.rating || null,
    progress: progressOf(store, it.id),
  };
}

function itemDetail(store, it) {
  const subs = [
    ...(it.sidecarSubs || []).map((s, i) => ({
      id: `ext${i}`, label: [langName(s.lang) || path.basename(s.file), s.forced && 'Forced', s.sdh && 'SDH', `(${s.format.toUpperCase()})`].filter(Boolean).join(' '),
      lang: s.lang,
    })),
    ...(it.media?.subtitles || []).filter((s) => s.text).map((s) => ({
      id: `emb${s.index}`, label: [s.title || langName(s.lang) || `Track ${s.index + 1}`, s.forced && 'Forced', '(Embedded)'].filter(Boolean).join(' '),
      lang: s.lang,
    })),
  ];
  const detail = {
    ...itemSummary(store, it),
    tagline: it.meta?.tagline || null,
    genres: it.meta?.genres || [],
    airDate: it.meta?.airDate || null,
    file: it.file, fileName: path.basename(it.file), size: it.size,
    media: it.media,
    directPlay: !!it.media && media.canDirectPlay(it),
    subtitles: subs,
    audioTracks: (it.media?.audio || []).map((a, i) => ({
      index: i, label: [a.title || langName(a.lang) || `Track ${i + 1}`, a.codec?.toUpperCase(), a.channels && `${a.channels}ch`].filter(Boolean).join(' · '),
    })),
  };
  if (it.type === 'episode') {
    const eps = episodesOf(store, it.showId);
    const i = eps.findIndex((e) => e.id === it.id);
    detail.next = i >= 0 && eps[i + 1] ? itemSummary(store, eps[i + 1]) : null;
    detail.prev = i > 0 ? itemSummary(store, eps[i - 1]) : null;
  }
  return detail;
}

function episodesOf(store, showId) {
  return Object.values(store.data.items).filter((e) => e.showId === showId).sort(epOrder);
}

function showSummary(store, s) {
  const eps = episodesOf(store, s.id);
  const watched = eps.filter((e) => store.data.progress[e.id]?.watched).length;
  return {
    id: s.id, type: 'show', libraryId: s.libraryId,
    title: s.meta?.title || s.title, year: s.meta?.year || s.year || null,
    overview: s.meta?.overview || null, rating: s.meta?.rating || null, genres: s.meta?.genres || [],
    addedAt: s.addedAt, lastAddedAt: s.lastAddedAt,
    episodeCount: eps.length, unwatchedCount: eps.length - watched,
    seasonCount: new Set(eps.map((e) => e.season)).size,
  };
}

function showDetail(store, s) {
  const eps = episodesOf(store, s.id);
  const seasons = new Map();
  for (const e of eps) {
    const key = e.season ?? -1;
    if (!seasons.has(key)) seasons.set(key, []);
    seasons.get(key).push(itemSummary(store, e));
  }
  return {
    ...showSummary(store, s),
    seasons: [...seasons].map(([n, episodes]) => ({
      season: n === -1 ? null : n,
      title: n === -1 ? 'Unsorted' : n === 0 ? 'Specials' : `Season ${n}`,
      episodes,
    })),
    upNext: upNextForShow(store, eps),
  };
}

// Next episode to watch: continue an in-progress one, else the one after the latest watched.
function upNextForShow(store, eps) {
  const prog = store.data.progress;
  let lastWatchedIdx = -1, lastAt = -1;
  eps.forEach((e, i) => {
    const p = prog[e.id];
    if (p && (p.watched || p.position > 0) && p.updatedAt > lastAt) { lastAt = p.updatedAt; lastWatchedIdx = i; }
  });
  if (lastWatchedIdx === -1) {
    const first = eps.find((e) => (e.season ?? 1) > 0) || eps[0];
    return first ? itemSummary(store, first) : null;
  }
  const last = eps[lastWatchedIdx];
  if (!prog[last.id].watched) return itemSummary(store, last);
  const next = eps.slice(lastWatchedIdx + 1).find((e) => !prog[e.id]?.watched);
  return next ? itemSummary(store, next) : null;
}

function continueWatching(store, limit = 20) {
  const { items, shows, progress } = store.data;
  const out = [];
  for (const it of Object.values(items)) {
    const p = progress[it.id];
    if (it.type === 'movie' && p && !p.watched && p.position > 15) out.push({ at: p.updatedAt, item: it });
  }
  for (const s of Object.values(shows)) {
    const eps = episodesOf(store, s.id);
    const lastAt = Math.max(-1, ...eps.map((e) => progress[e.id]?.updatedAt || -1));
    if (lastAt < 0) continue;
    const next = upNextForShow(store, eps);
    if (next) out.push({ at: lastAt, item: items[next.id] });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit).map((x) => itemSummary(store, x.item));
}

function libraryContents(store, library) {
  if (library.type === 'show') {
    return Object.values(store.data.shows).filter((s) => s.libraryId === library.id).map((s) => showSummary(store, s));
  }
  return Object.values(store.data.items).filter((i) => i.libraryId === library.id).map((i) => itemSummary(store, i));
}

function home(store) {
  const hubs = [];
  const cw = continueWatching(store);
  if (cw.length) hubs.push({ key: 'continue', title: 'Continue Watching', style: 'wide', items: cw });
  for (const lib of store.data.libraries) {
    const contents = libraryContents(store, lib)
      .sort((a, b) => (b.lastAddedAt || b.addedAt) - (a.lastAddedAt || a.addedAt)).slice(0, 24);
    if (contents.length) hubs.push({ key: `recent-${lib.id}`, title: `Recently Added in ${lib.name}`, libraryId: lib.id, style: 'poster', items: contents });
  }
  return { hubs };
}

function search(store, q, limit = 30) {
  const needle = q.trim().toLowerCase();
  if (!needle) return { movies: [], shows: [], episodes: [] };
  const match = (...fields) => fields.some((f) => f && String(f).toLowerCase().includes(needle));
  const items = Object.values(store.data.items);
  return {
    movies: items.filter((i) => i.type === 'movie' && match(i.title, i.meta?.title)).slice(0, limit).map((i) => itemSummary(store, i)),
    shows: Object.values(store.data.shows).filter((s) => match(s.title, s.meta?.title)).slice(0, limit).map((s) => showSummary(store, s)),
    episodes: items.filter((i) => i.type === 'episode' && match(i.title, i.meta?.title)).slice(0, limit).map((i) => itemSummary(store, i)),
  };
}

function setProgress(store, it, position) {
  const duration = it.media?.duration || 0;
  const prev = store.data.progress[it.id] || {};
  const watched = duration > 0 && position >= duration * WATCHED_RATIO;
  store.data.progress[it.id] = {
    position: watched ? 0 : Math.max(0, position),
    watched: watched || (!!prev.watched && position < 15), // re-watching from the start keeps the mark
    updatedAt: Date.now(),
  };
  store.save();
  return progressOf(store, it.id);
}

function setWatched(store, ids, watched) {
  const now = Date.now();
  for (const id of ids) {
    if (watched) store.data.progress[id] = { position: 0, watched: true, updatedAt: now };
    else delete store.data.progress[id];
  }
  store.save();
}

module.exports = {
  itemSummary, itemDetail, showSummary, showDetail, episodesOf, libraryContents, home, search,
  setProgress, setWatched, continueWatching,
};
