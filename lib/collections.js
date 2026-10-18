'use strict';
// Collections: groups of movies (and shows). Automatic ones come from TMDB ("The Matrix Collection"),
// shown once at least two of their films are in the library; admins can also make their own.

const { randomId } = require('./store');
const { itemSummary, showSummary, pick } = require('./library');
const { canSeeLibrary } = require('./auth');

const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const yearOf = (o) => pick(o, 'year') || o.year || 9999;

function autoCollections(store) {
  const map = new Map();
  for (const it of Object.values(store.data.items)) {
    const c = it.type === 'movie' && it.meta?.collection;
    if (!c) continue;
    const id = `tmdb-${c.id}`;
    if (!map.has(id)) map.set(id, { id, name: c.name, kind: 'auto', members: [] });
    map.get(id).members.push(it.id);
  }
  return [...map.values()];
}

const manualCollections = (store) => Object.values(store.data.collections || {}).map((c) => ({ ...c, kind: 'manual' }));

// Members this user can see, oldest first.
function visibleMembers(store, user, col) {
  return col.members.map((id) => store.data.items[id] || store.data.shows[id])
    .filter((o) => o && canSeeLibrary(user, o.libraryId))
    .sort((a, b) => yearOf(a) - yearOf(b));
}

function summary(store, user, col, members = visibleMembers(store, user, col)) {
  const cover = members[0];
  return {
    id: col.id, name: col.name, kind: col.kind, count: members.length,
    cover: cover ? { id: cover.id, artV: `${cover.edits?.updatedAt || 0}${cover.meta?.fetchedAt || 0}` } : null,
    libraryIds: [...new Set(members.map((m) => m.libraryId))],
  };
}

function list(store, user, { libraryId = null } = {}) {
  const out = [];
  for (const col of [...manualCollections(store), ...autoCollections(store)]) {
    const members = visibleMembers(store, user, col);
    if (col.kind === 'auto' && members.length < 2) continue;
    if (col.kind === 'manual' && !members.length && user.role !== 'admin') continue;
    const s = summary(store, user, col, members);
    if (libraryId && !s.libraryIds.includes(libraryId) && (members.length || col.kind === 'auto')) continue;
    out.push(s);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function find(store, id) {
  const col = id.startsWith('tmdb-') ? autoCollections(store).find((c) => c.id === id) : store.data.collections?.[id] && { ...store.data.collections[id], kind: 'manual' };
  if (!col) throw httpError(404, 'Collection not found');
  return col;
}

function detail(store, user, id) {
  const col = find(store, id);
  const members = visibleMembers(store, user, col);
  if (!members.length && !(col.kind === 'manual' && user.role === 'admin')) throw httpError(404, 'Collection not found');
  return { ...summary(store, user, col, members), items: members.map((o) => (store.data.shows[o.id] ? showSummary(store, user, o) : itemSummary(store, user, o))) };
}

// Collections a movie or show is in (for its page).
function of(store, user, targetId) {
  return [...manualCollections(store), ...autoCollections(store)]
    .filter((c) => c.members.includes(targetId) && (c.kind === 'manual' || visibleMembers(store, user, c).length >= 2))
    .map((c) => ({ id: c.id, name: c.name }));
}

// ---- admin: manual collections ----
function manual(store, id) {
  const c = store.data.collections?.[id];
  if (!c) throw httpError(id.startsWith('tmdb-') ? 400 : 404, id.startsWith('tmdb-') ? 'Collections from TMDB can’t be changed' : 'Collection not found');
  return c;
}
const cleanName = (name) => {
  const n = String(name || '').trim().slice(0, 80);
  if (!n) throw httpError(400, 'Give the collection a name');
  return n;
};
function create(store, { name, members = [] }) {
  const c = { id: randomId(), name: cleanName(name), members: [], createdAt: Date.now() };
  (store.data.collections ||= {})[c.id] = c;
  for (const m of members) addMember(store, c.id, m);
  store.save();
  return c;
}
function rename(store, id, name) { manual(store, id).name = cleanName(name); store.save(); }
function remove(store, id) { manual(store, id); delete store.data.collections[id]; store.save(); }
function addMember(store, id, targetId) {
  const c = manual(store, id);
  const t = store.data.items[targetId] || store.data.shows[targetId];
  if (!t || !(t.type === 'movie' || store.data.shows[targetId])) throw httpError(400, 'Only movies and shows can be added to a collection');
  if (!c.members.includes(targetId)) c.members.push(targetId);
  store.save();
}
function removeMember(store, id, targetId) {
  const c = manual(store, id);
  c.members = c.members.filter((m) => m !== targetId);
  store.save();
}

module.exports = { list, detail, of, create, rename, remove, addMember, removeMember };
