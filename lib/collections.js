'use strict';
// Collections: groups of movies (and shows). Automatic ones come from TMDB ("The Matrix Collection"),
// shown once at least two of their films are in the library; admins can also make their own.
//
// Admins can override everything: rename any collection, add or remove titles (also in TMDB ones),
// arrange the titles, pick the cover, hide TMDB collections, and arrange the list of collections.
// Changes to TMDB collections are kept separately (store.data.collectionOverrides) so new films
// still join them, and "reset" goes back to what TMDB says.
//
// Each collection is shown under Movies, TV or YouTube (worked out from what's in it, or picked by an
// admin), and has a sort rule: release date, episode number found in the titles ("Ep 12", "S2E5",
// "Part 3"), title, date added, or an order arranged by hand. New titles fall into place by the rule.

const { randomId } = require('./store');
const { itemSummary, showSummary, pick, memo, isOtherVersion } = require('./library');
const { canSeeTitle } = require('./ratings');

const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const yearOf = (o) => pick(o, 'year') || o.year || 9999;
const isAuto = (id) => String(id).startsWith('tmdb-');
const own = (obj, id) => (obj && Object.hasOwn(obj, id) ? obj[id] : undefined); // ("__proto__" is not an id)
const target = (store, id) => own(store.data.items, id) || own(store.data.shows, id);
const overridesOf = (store, id) => own(store.data.collectionOverrides, id) || {};
const titleOf = (o) => pick(o, 'title') || o.title || '';

const SORTS = ['release', 'episode', 'title', 'added', 'custom'];
const SECTIONS = ['movies', 'shows', 'videos'];

// Downloaded web videos (they have the video's own details), or anything in a library named YouTube.
function isWebVideo(store, o) {
  return o.meta?.provider === 'video' || /youtube/i.test(store.library(o.libraryId)?.name || '');
}

// Season and episode number in a title: "S02E05", "2x05", "Season 2 Episode 5", "Ep. 12", "Episode 12",
// "Part 3", "Pt 3", "#12", "Day 4", "Chapter 7", or else a number at the very end ("Minecraft 12").
// Returns { season, episode, explicit } or null. Years (1999, 2024) and sizes (1080p) are not numbers.
const NUM = String.raw`(\d{1,4})(?![\d.]*\s*(?:p\b|fps|k\b|%))`;
const MARKER = String.raw`(?:episode|episodio|épisode|folge|ep|e|part|pt|chapter|ch|day|vol(?:ume)?|no|#)`;
function titleNumber(title) {
  const t = String(title || '');
  let m = /(?:^|[^a-z0-9])s(\d{1,3})\s*[._-]?\s*e(\d{1,4})(?!\d)/i.exec(t) || /(?:^|[^a-z0-9])(\d{1,2})x(\d{1,3})(?![\dp])/i.exec(t);
  if (m) return { season: Number(m[1]), episode: Number(m[2]), explicit: true };
  const season = /(?:^|[^a-z0-9])(?:season|series|s)\s*\.?\s*(\d{1,3})(?!\d)/i.exec(t);
  m = new RegExp(String.raw`(?:^|[^a-z0-9])${MARKER}\s*[.:#]?\s*#?\s*${NUM}`, 'i').exec(t);
  if (m && !(season && m.index === season.index)) return { season: season ? Number(season[1]) : 0, episode: Number(m[1]), explicit: true };
  m = /(?:^|[^\d.])(\d{1,4})\s*[)\]]?\s*$/.exec(t);
  if (m && !/^(19|20)\d\d$/.test(m[1])) return { season: season ? Number(season[1]) : 0, episode: Number(m[1]), explicit: false };
  return null;
}

// (One collator for all comparisons: localeCompare with options makes a new one each time.)
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const natural = (a, b) => collator.compare(a, b);
const sortKeyTitle = (o) => (o.edits?.sortTitle || titleOf(o)).replace(/^(the|a|an)\s+/i, '');
// Upload date for videos, otherwise the year.
const releaseKey = (o) => o.meta?.airDate || String(pick(o, 'year') || o.year || 9999);

const SORTERS = {
  release: (a, b) => natural(releaseKey(a), releaseKey(b)) || natural(sortKeyTitle(a), sortKeyTitle(b)),
  title: (a, b) => natural(sortKeyTitle(a), sortKeyTitle(b)),
  added: (a, b) => (a.addedAt || 0) - (b.addedAt || 0) || natural(sortKeyTitle(a), sortKeyTitle(b)),
  // Titles with a number first, in order; the rest after them by title.
  episode: (a, b) => {
    const x = titleNumber(titleOf(a)), y = titleNumber(titleOf(b));
    if (!x || !y) return (x ? -1 : 0) + (y ? 1 : 0) || SORTERS.release(a, b);
    return x.season - y.season || x.episode - y.episode || SORTERS.release(a, b);
  },
};

// TMDB's film series, from the films' details (worked out again when the library changes).
const tmdbGroups = (store) => memo(store, 'tmdbCollections', () => {
  const map = new Map();
  for (const it of Object.values(store.data.items)) {
    const c = it.type === 'movie' && it.meta?.collection;
    if (!c || isOtherVersion(store, it)) continue; // (a film's other versions aren't listed twice)
    const id = `tmdb-${c.id}`;
    if (!map.has(id)) map.set(id, { id, name: c.name, kind: 'auto', members: [] });
    map.get(id).members.push(it.id);
  }
  return [...map.values()];
});

function autoCollections(store) {
  return tmdbGroups(store).map((c) => {
    const o = overridesOf(store, c.id);
    const removed = new Set(o.removed || []);
    const members = [...c.members.filter((m) => !removed.has(m)), ...(o.added || []).filter((m) => target(store, m) && !c.members.includes(m))];
    return { ...c, tmdbName: c.name, name: o.name || c.name, members, hidden: !!o.hidden, cover: o.cover || null,
      sort: o.sort, reverse: !!o.reverse, section: o.section, changed: Object.keys(o).some((k) => !['sort', 'reverse', 'section'].includes(k)) };
  });
}

const manualCollections = (store) => Object.values(store.data.collections || {}).map((c) => ({ ...c, kind: 'manual' }));
const allCollections = (store) => [...manualCollections(store), ...autoCollections(store)];

// The sort rule: chosen by an admin, else "custom" for collections arranged before rules existed.
const sortOf = (store, col) => (SORTS.includes(col.sort) ? col.sort : store.data.collectionOrder?.[col.id] ? 'custom' : 'release');

function sortMembers(store, col, members) {
  const sort = sortOf(store, col);
  let cmp = SORTERS[sort];
  if (sort === 'custom') {
    // Arranged by hand (store.data.collectionOrder[id]); titles added after that go at the end.
    const order = store.data.collectionOrder?.[col.id] || [];
    const rank = (o) => { const i = order.indexOf(o.id); return i < 0 ? Infinity : i; };
    cmp = (a, b) => rank(a) - rank(b) || yearOf(a) - yearOf(b);
  }
  const out = [...members].sort(cmp);
  return col.reverse && sort !== 'custom' ? out.reverse() : out;
}

// Members this user can see, in the collection's order.
function visibleMembers(store, user, col) {
  return sortMembers(store, col, col.members.map((id) => target(store, id)).filter((o) => canSeeTitle(store, user, o)));
}

// Movies, TV or YouTube: what an admin picked, otherwise what most of the titles are.
function sectionOf(store, col) {
  if (SECTIONS.includes(col.section)) return col.section;
  const n = { movies: 0, shows: 0, videos: 0 };
  for (const id of col.members) {
    const o = target(store, id);
    if (o) n[store.data.shows[id] ? 'shows' : isWebVideo(store, o) ? 'videos' : 'movies']++;
  }
  return n.shows > n.movies && n.shows >= n.videos ? 'shows' : n.videos > n.movies ? 'videos' : 'movies';
}

function summary(store, user, col, members = visibleMembers(store, user, col)) {
  const cover = members.find((m) => m.id === col.cover) || members[0];
  return {
    id: col.id, name: col.name, kind: col.kind, count: members.length, customOrder: sortOf(store, col) === 'custom',
    sort: sortOf(store, col), reverse: !!col.reverse, section: sectionOf(store, col), sectionSetByHand: SECTIONS.includes(col.section),
    hidden: !!col.hidden, coverId: col.cover || null, tmdbName: col.tmdbName || null, changed: !!col.changed,
    cover: cover ? { id: cover.id, artV: `${cover.edits?.updatedAt || 0}${cover.meta?.fetchedAt || 0}` } : null,
    libraryIds: [...new Set(members.map((m) => m.libraryId))],
    memberIds: members.map((m) => m.id),
  };
}

// Admins can ask for hidden TMDB collections too (to show them again).
function list(store, user, { libraryId = null, includeHidden = false } = {}) {
  const listOrder = store.data.collectionListOrder || [];
  const rank = (c) => { const i = listOrder.indexOf(c.id); return i < 0 ? Infinity : i; };
  const out = [];
  for (const col of allCollections(store)) {
    if (col.hidden && !(includeHidden && user.role === 'admin')) continue;
    const members = visibleMembers(store, user, col);
    if (col.kind === 'auto' && members.length < 2 && !col.changed) continue;
    if (!members.length && user.role !== 'admin') continue;
    const s = summary(store, user, col, members);
    if (libraryId && !s.libraryIds.includes(libraryId) && members.length) continue;
    out.push(s);
  }
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function find(store, id) {
  const col = isAuto(id) ? autoCollections(store).find((c) => c.id === id) : own(store.data.collections, id) && { ...store.data.collections[id], kind: 'manual' };
  if (!col) throw httpError(404, 'Collection not found');
  return col;
}

function detail(store, user, id) {
  const col = find(store, id);
  const members = visibleMembers(store, user, col);
  if (user.role !== 'admin' && (!members.length || col.hidden)) throw httpError(404, 'Collection not found');
  return { ...summary(store, user, col, members), items: members.map((o) => (store.data.shows[o.id] ? showSummary(store, user, o) : itemSummary(store, user, o))) };
}

// Collections a movie or show is in (for its page).
function of(store, user, targetId) {
  return allCollections(store)
    .filter((c) => !c.hidden && c.members.includes(targetId) && (c.kind === 'manual' || c.changed || visibleMembers(store, user, c).length >= 2))
    .map((c) => ({ id: c.id, name: c.name }));
}

// ---- admin changes ----
function overrides(store, id) {
  find(store, id);
  return ((store.data.collectionOverrides ||= {})[id] ||= {});
}
const cleanName = (name) => {
  const n = String(name || '').trim().slice(0, 80);
  if (!n) throw httpError(400, 'Give the collection a name');
  return n;
};
function manual(store, id) {
  const c = own(store.data.collections, id);
  if (!c) throw httpError(404, 'Collection not found');
  return c;
}
const checkTarget = (store, targetId) => {
  const t = target(store, targetId);
  if (!t || !(t.type === 'movie' || store.data.shows[targetId])) throw httpError(400, 'Only movies and shows can be added to a collection');
};

function create(store, { name, members = [], sort, reverse, section }) {
  const c = { id: randomId(), name: cleanName(name), members: [], createdAt: Date.now() };
  if (!Array.isArray(members)) throw httpError(400, 'members must be a list');
  for (const m of members) checkTarget(store, m);
  (store.data.collections ||= {})[c.id] = c;
  for (const m of members) addMember(store, c.id, m);
  if (sort !== undefined || reverse !== undefined || section !== undefined) update(store, c.id, { sort, reverse, section });
  store.save();
  return c;
}

// { name, cover, hidden, sort, reverse, section }: name '' on a TMDB collection goes back to TMDB's
// name; cover null = automatic; section null = worked out from the titles.
function update(store, id, { name, cover, hidden, sort, reverse, section } = {}) {
  const col = find(store, id);
  const o = isAuto(id) ? overrides(store, id) : manual(store, id);
  if (name !== undefined) {
    if (isAuto(id) && !String(name || '').trim()) delete o.name;
    else o.name = cleanName(name);
  }
  if (cover !== undefined) {
    if (cover && !col.members.includes(cover)) throw httpError(400, 'The cover must be one of the collection’s titles');
    if (cover) o.cover = cover; else delete o.cover;
  }
  if (hidden !== undefined) {
    if (!isAuto(id)) throw httpError(400, 'Delete your own collections instead of hiding them');
    if (hidden) o.hidden = true; else delete o.hidden;
  }
  if (sort !== undefined) {
    if (!SORTS.includes(sort)) throw httpError(400, `sort must be one of: ${SORTS.join(', ')}`);
    if (sort === 'custom' && !store.data.collectionOrder?.[id]) {
      // Arranging starts from the order shown now.
      (store.data.collectionOrder ||= {})[id] = sortMembers(store, col, col.members.map((m) => target(store, m)).filter(Boolean)).map((m) => m.id);
    }
    o.sort = sort;
  }
  if (reverse !== undefined) { if (reverse) o.reverse = true; else delete o.reverse; }
  if (section !== undefined) {
    if (section !== null && !SECTIONS.includes(section)) throw httpError(400, `section must be one of: ${SECTIONS.join(', ')}`);
    if (section) o.section = section; else delete o.section;
  }
  store.save();
}

// Your own collections are deleted; TMDB collections are hidden (they would come back otherwise).
function remove(store, id) {
  if (isAuto(id)) return update(store, id, { hidden: true });
  manual(store, id);
  delete store.data.collections[id];
  delete store.data.collectionOrder?.[id];
  store.save();
}

// Forget every change to a TMDB collection.
function reset(store, id) {
  if (!isAuto(id)) throw httpError(400, 'Only collections from TMDB can be reset');
  find(store, id);
  delete store.data.collectionOverrides?.[id];
  delete store.data.collectionOrder?.[id];
  store.save();
}

function addMember(store, id, targetId) {
  checkTarget(store, targetId);
  if (isAuto(id)) {
    const o = overrides(store, id);
    o.removed = (o.removed || []).filter((m) => m !== targetId);
    if (!find(store, id).members.includes(targetId)) o.added = [...(o.added || []), targetId];
  } else {
    const c = manual(store, id);
    if (!c.members.includes(targetId)) c.members.push(targetId);
  }
  store.save();
}

function removeMember(store, id, targetId) {
  if (isAuto(id)) {
    const o = overrides(store, id);
    if ((o.added || []).includes(targetId)) o.added = o.added.filter((m) => m !== targetId);
    else if (!(o.removed || []).includes(targetId)) o.removed = [...(o.removed || []), targetId];
    if (o.cover === targetId) delete o.cover;
  } else {
    const c = manual(store, id);
    c.members = c.members.filter((m) => m !== targetId);
    if (c.cover === targetId) delete c.cover;
  }
  store.save();
}

// Arrange a collection: `order` lists its titles first to last; null goes back to release order.
function setOrder(store, id, order) {
  const col = find(store, id);
  const o = isAuto(id) ? overrides(store, id) : manual(store, id);
  if (order === null) {
    delete store.data.collectionOrder?.[id];
    if (o.sort === 'custom') delete o.sort;
    store.save();
    return;
  }
  if (!Array.isArray(order) || order.some((m) => !col.members.includes(m)) || new Set(order).size !== order.length) {
    throw httpError(400, 'The order must list titles from this collection, each once');
  }
  (store.data.collectionOrder ||= {})[id] = order.map(String);
  o.sort = 'custom';
  delete o.reverse;
  store.save();
}

// Arrange the list of collections; null goes back to alphabetical.
function setListOrder(store, order) {
  if (order === null) { delete store.data.collectionListOrder; store.save(); return; }
  const known = new Set(allCollections(store).map((c) => c.id));
  if (!Array.isArray(order) || order.some((id) => !known.has(id)) || new Set(order).size !== order.length) {
    throw httpError(400, 'The order must list existing collections, each once');
  }
  store.data.collectionListOrder = order.map(String);
  store.save();
}

// Add or remove many titles at once (from "Select"). Everything is checked before anything changes.
function addMembers(store, id, ids) {
  find(store, id);
  if (!Array.isArray(ids) || !ids.length) throw httpError(400, 'Nothing selected');
  for (const m of ids) checkTarget(store, m);
  for (const m of ids) addMember(store, id, m);
}
function removeMembers(store, id, ids) {
  find(store, id);
  if (!Array.isArray(ids)) throw httpError(400, 'Nothing selected');
  for (const m of ids) removeMember(store, id, m);
}

// "Find series": downloaded videos (and movies) whose titles share a name before an episode marker,
// e.g. "Hardcore Survival Ep 1", "Hardcore Survival Ep 2" -> a "Hardcore Survival" collection sorted
// by episode number. Groups whose titles are already all in one collection are left out.
const seriesName = (title) => {
  const t = String(title || '');
  const m = new RegExp(String.raw`(?:^|[^a-z0-9])(?:s\d{1,3}\s*[._-]?\s*e\d|\d{1,2}x\d|(?:season|series)\s*\d|${MARKER}\s*[.:#]?\s*#?\s*\d)`, 'i').exec(t);
  if (!m) return null;
  const name = t.slice(0, m.index).replace(/[\s|:;,.\-–—_(\[#]+$/u, '').trim();
  return name.length >= 3 ? name : null;
};
const normName = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function suggest(store, user) {
  const groups = new Map();
  for (const it of Object.values(store.data.items)) {
    if (it.type !== 'movie' || !canSeeTitle(store, user, it)) continue;
    const name = seriesName(titleOf(it));
    if (!name) continue;
    const key = `${it.meta?.channel || it.libraryId}|${normName(name)}`;
    if (!groups.has(key)) groups.set(key, { names: new Map(), items: [] });
    const g = groups.get(key);
    g.names.set(name, (g.names.get(name) || 0) + 1);
    g.items.push(it);
  }
  const existing = allCollections(store).filter((c) => !c.hidden).map((c) => new Set(c.members));
  const out = [];
  for (const g of groups.values()) {
    if (g.items.length < 2) continue;
    if (existing.some((set) => g.items.every((it) => set.has(it.id)))) continue;
    const name = [...g.names.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const items = [...g.items].sort(SORTERS.episode);
    out.push({
      name, count: items.length, channel: items[0].meta?.channel || null,
      section: items.filter((it) => isWebVideo(store, it)).length * 2 > items.length ? 'videos' : 'movies',
      memberIds: items.map((it) => it.id), titles: items.slice(0, 4).map(titleOf),
    });
  }
  return out.sort((a, b) => b.count - a.count || natural(a.name, b.name));
}

module.exports = {
  list, detail, of, create, update, remove, reset, addMember, removeMember, addMembers, removeMembers, setOrder, setListOrder,
  suggest, titleNumber, seriesName, SORTS, SECTIONS,
};
