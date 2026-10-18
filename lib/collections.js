'use strict';
// Collections: groups of movies (and shows). Automatic ones come from TMDB ("The Matrix Collection"),
// shown once at least two of their films are in the library; admins can also make their own.
//
// Admins can override everything: rename any collection, add or remove titles (also in TMDB ones),
// arrange the titles, pick the cover, hide TMDB collections, and arrange the list of collections.
// Changes to TMDB collections are kept separately (store.data.collectionOverrides) so new films
// still join them, and "reset" goes back to what TMDB says.

const { randomId } = require('./store');
const { itemSummary, showSummary, pick } = require('./library');
const { canSeeLibrary } = require('./auth');

const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const yearOf = (o) => pick(o, 'year') || o.year || 9999;
const isAuto = (id) => String(id).startsWith('tmdb-');
const target = (store, id) => store.data.items[id] || store.data.shows[id];
const overridesOf = (store, id) => store.data.collectionOverrides?.[id] || {};

function autoCollections(store) {
  const map = new Map();
  for (const it of Object.values(store.data.items)) {
    const c = it.type === 'movie' && it.meta?.collection;
    if (!c) continue;
    const id = `tmdb-${c.id}`;
    if (!map.has(id)) map.set(id, { id, name: c.name, kind: 'auto', members: [] });
    map.get(id).members.push(it.id);
  }
  return [...map.values()].map((c) => {
    const o = overridesOf(store, c.id);
    const removed = new Set(o.removed || []);
    const members = [...c.members.filter((m) => !removed.has(m)), ...(o.added || []).filter((m) => target(store, m) && !c.members.includes(m))];
    return { ...c, tmdbName: c.name, name: o.name || c.name, members, hidden: !!o.hidden, cover: o.cover || null, changed: Object.keys(o).length > 0 };
  });
}

const manualCollections = (store) => Object.values(store.data.collections || {}).map((c) => ({ ...c, kind: 'manual' }));
const allCollections = (store) => [...manualCollections(store), ...autoCollections(store)];

// Members this user can see: in the order an admin arranged (store.data.collectionOrder[id]),
// otherwise oldest first. Titles added after arranging go at the end.
function visibleMembers(store, user, col) {
  const order = store.data.collectionOrder?.[col.id] || [];
  const rank = (o) => { const i = order.indexOf(o.id); return i < 0 ? Infinity : i; };
  return col.members.map((id) => target(store, id))
    .filter((o) => o && canSeeLibrary(user, o.libraryId))
    .sort((a, b) => rank(a) - rank(b) || yearOf(a) - yearOf(b));
}

function summary(store, user, col, members = visibleMembers(store, user, col)) {
  const cover = members.find((m) => m.id === col.cover) || members[0];
  return {
    id: col.id, name: col.name, kind: col.kind, count: members.length, customOrder: !!store.data.collectionOrder?.[col.id],
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
  const col = isAuto(id) ? autoCollections(store).find((c) => c.id === id) : store.data.collections?.[id] && { ...store.data.collections[id], kind: 'manual' };
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
  const c = store.data.collections?.[id];
  if (!c) throw httpError(404, 'Collection not found');
  return c;
}
const checkTarget = (store, targetId) => {
  const t = target(store, targetId);
  if (!t || !(t.type === 'movie' || store.data.shows[targetId])) throw httpError(400, 'Only movies and shows can be added to a collection');
};

function create(store, { name, members = [] }) {
  const c = { id: randomId(), name: cleanName(name), members: [], createdAt: Date.now() };
  (store.data.collections ||= {})[c.id] = c;
  for (const m of members) addMember(store, c.id, m);
  store.save();
  return c;
}

// { name, cover, hidden }: name '' on a TMDB collection goes back to TMDB's name; cover null = automatic.
function update(store, id, { name, cover, hidden } = {}) {
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
  if (order === null) { delete store.data.collectionOrder?.[id]; store.save(); return; }
  if (!Array.isArray(order) || order.some((m) => !col.members.includes(m)) || new Set(order).size !== order.length) {
    throw httpError(400, 'The order must list titles from this collection, each once');
  }
  (store.data.collectionOrder ||= {})[id] = order.map(String);
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

module.exports = { list, detail, of, create, update, remove, reset, addMember, removeMember, setOrder, setListOrder };
