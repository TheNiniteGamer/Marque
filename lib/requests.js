'use strict';
// Requests: anyone can ask for a film or show that isn't on the server. Admins see the list
// (Requests in the menu) and mark each one approved, declined or added. When the title turns up
// in a library (the same TMDB / TVmaze entry, or the same name and year), the request is marked
// available and whoever asked is told.
//
// With Radarr / Sonarr connected (arr.js), approving a request adds it there; admins, and people an
// admin lets (separately for films and shows), skip the waiting and go straight there.
//
// store.data.requests[id] = { id, kind: 'movie' | 'show', title, year, provider, providerId, thumb,
//   overview, note, userIds: [first asker, …others who asked for it too], status, adminNote,
//   availableId, arr (see arr.js), createdAt, updatedAt }

const crypto = require('node:crypto');
const notifications = require('./notifications');
const { canSeeTitle } = require('./ratings');

const STATUSES = ['pending', 'approved', 'declined', 'available'];
const OPEN = new Set(['pending', 'approved']);
const LIMIT_OPEN_PER_USER = 30;

const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const norm = (s) => String(s || '').toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, '');
const all = (store) => (store.data.requests ||= {});

/** What's already in the libraries, by provider id and by name + year, for one kind (only what
 * `user` can see, when given: others mustn't learn what's in libraries hidden from them). */
function libraryIndex(store, kind, user = null) {
  const byId = new Map(), byName = new Map();
  const list = (kind === 'show' ? Object.values(store.data.shows) : Object.values(store.data.items).filter((i) => i.type === 'movie'))
    .filter((o) => !user || canSeeTitle(store, user, o));
  for (const o of list) {
    if (o.meta?.provider && o.meta?.providerId) byId.set(`${o.meta.provider}:${o.meta.providerId}`, o);
    const title = o.edits?.title || o.meta?.title || o.title;
    const year = o.edits?.year || o.meta?.year || o.year || '';
    if (title) { byName.set(`${norm(title)}|${year}`, o); if (!byName.has(`${norm(title)}|`)) byName.set(`${norm(title)}|`, o); }
  }
  return { byId, byName };
}

function findInLibrary(idx, r) {
  return (r.provider && r.providerId && idx.byId.get(`${r.provider}:${r.providerId}`))
    || idx.byName.get(`${norm(r.title)}|${r.year || ''}`) || (!r.year ? idx.byName.get(`${norm(r.title)}|`) : null) || null;
}

function clean(input) {
  const kind = input.kind === 'show' ? 'show' : input.kind === 'movie' ? 'movie' : null;
  if (!kind) throw httpError(400, 'Say whether it’s a film or a show');
  const title = String(input.title || '').trim().slice(0, 200);
  if (!title) throw httpError(400, 'What’s it called?');
  const year = Number(input.year) || null;
  if (year && (year < 1870 || year > 2100)) throw httpError(400, 'That year doesn’t look right');
  const provider = ['tmdb', 'tvmaze'].includes(input.provider) ? input.provider : null;
  const providerId = provider && /^\d{1,12}$/.test(String(input.providerId || '')) ? String(input.providerId) : null;
  const thumb = typeof input.thumb === 'string' && /^https:\/\/(image\.tmdb\.org|static\.tvmaze\.com)\//.test(input.thumb) ? input.thumb.slice(0, 300) : null;
  return {
    kind, title, year, provider: providerId ? provider : null, providerId, thumb,
    overview: input.overview ? String(input.overview).slice(0, 1000) : null,
    note: input.note ? String(input.note).trim().slice(0, 500) : null,
  };
}

/** Whether this person's requests of this kind skip an admin's approval. */
const autoApproves = (user, kind) => user.role === 'admin' || !!user.autoApprove?.[kind];

/** A new request (asking again for something already asked for adds you to it). `autoSend`: it
 * goes straight to Radarr / Sonarr (the caller sends it), so admins aren't asked to approve it. */
function create(store, user, input, { autoSend = false } = {}) {
  const r = clean(input);
  const inLibrary = findInLibrary(libraryIndex(store, r.kind, user), r);
  if (inLibrary) throw httpError(409, `${r.title} is already here`);
  const same = Object.values(all(store)).find((x) => x.kind === r.kind && x.status !== 'declined' && x.status !== 'available'
    && ((r.providerId && x.provider === r.provider && x.providerId === r.providerId) || (norm(x.title) === norm(r.title) && (x.year || null) === r.year)));
  if (same) {
    if (!same.userIds.includes(user.id)) { same.userIds.push(user.id); same.updatedAt = Date.now(); store.save(); }
    return same;
  }
  const open = Object.values(all(store)).filter((x) => x.userIds[0] === user.id && OPEN.has(x.status)).length;
  if (open >= LIMIT_OPEN_PER_USER) throw httpError(429, `You have ${open} requests waiting; ask again once some have been sorted`);
  const id = crypto.randomBytes(6).toString('hex');
  const req = { id, ...r, userIds: [user.id], status: 'pending', adminNote: null, availableId: null, createdAt: Date.now(), updatedAt: Date.now() };
  all(store)[id] = req;
  store.save();
  if (autoSend) return req; // (admins hear if sending fails)
  for (const admin of (store.data.users || []).filter((u) => u.role === 'admin' && u.id !== user.id)) {
    notifications.add(store, admin.id, { kind: 'request', title: `${user.username} asked for ${r.title}${r.year ? ` (${r.year})` : ''}`, body: r.note || (r.kind === 'show' ? 'A show' : 'A film'), link: '#/requests', key: `request-new-${id}` });
  }
  return req;
}

const nameOf = (store, id) => store.data.users?.find((u) => u.id === id)?.username || 'Someone';
const view = (store, r, admin) => ({
  ...r,
  requestedBy: nameOf(store, r.userIds[0]),
  ...(admin ? { alsoWanted: r.userIds.slice(1).map((id) => nameOf(store, id)) } : { userIds: undefined, mine: true }),
  // (Others only see that it was sent, not Radarr's details or errors.)
  arr: admin ? r.arr || null : r.arr && !r.arr.error ? { app: r.arr.app } : null,
});

/** Admins: everyone's. Others: the ones they asked for (or joined). Open ones first, newest first. */
function list(store, user) {
  const admin = user.role === 'admin';
  const rank = (r) => ({ pending: 0, approved: 1, available: 2, declined: 3 })[r.status];
  return Object.values(all(store)).filter((r) => admin || r.userIds.includes(user.id))
    .sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt)
    .map((r) => view(store, r, admin));
}

const find = (store, id) => (Object.hasOwn(all(store), id) ? all(store)[id] : null);

// The people who asked are told it's been approved (or declined).
function tell(store, r, status) {
  for (const uid of r.userIds) {
    notifications.add(store, uid, {
      kind: 'request',
      title: status === 'approved' ? `${r.title} is on its way` : `${r.title} won't be added`,
      body: r.adminNote || (status === 'approved' ? 'Your request was approved.' : 'Your request was declined.'),
      link: '#/requests', key: `request-${r.id}-${status}`,
    });
  }
}

/**
 * Adds a request to Radarr / Sonarr and marks it approved. opts: { profileId, monitor, auto }.
 * If that fails the request stays as it was, with the reason (admins see it, with Retry).
 */
async function send(store, arr, id, opts = {}) {
  const r = find(store, id);
  if (!r) throw httpError(404, 'Request not found');
  const app = r.kind === 'show' ? 'sonarr' : 'radarr';
  try {
    r.arr = { ...(await arr.add(r, opts)), auto: !!opts.auto };
  } catch (err) {
    r.arr = { app, error: err.message, failedAt: Date.now() };
    r.updatedAt = Date.now();
    store.save();
    if (opts.auto) {
      for (const admin of (store.data.users || []).filter((u) => u.role === 'admin')) {
        notifications.add(store, admin.id, { kind: 'request', title: `${r.title} couldn’t be sent to ${app === 'radarr' ? 'Radarr' : 'Sonarr'}`, body: err.message, link: '#/requests', key: `request-${id}-sendfail` });
      }
    }
    throw err;
  }
  const was = r.status;
  if (r.status !== 'available') r.status = 'approved';
  r.updatedAt = Date.now();
  store.save();
  if (was !== r.status) tell(store, r, 'approved');
  return view(store, r, true);
}

function update(store, user, id, { status, adminNote }) {
  const r = find(store, id);
  if (!r) throw httpError(404, 'Request not found');
  if (status !== undefined && !STATUSES.includes(status)) throw httpError(400, 'Unknown status');
  const was = r.status;
  if (status !== undefined) r.status = status;
  if (adminNote !== undefined) r.adminNote = adminNote ? String(adminNote).trim().slice(0, 500) : null;
  r.updatedAt = Date.now();
  store.save();
  if (status && status !== was && (status === 'declined' || status === 'approved')) tell(store, r, status);
  return view(store, r, true);
}

/** The asker can withdraw a request until it's been dealt with; admins can remove any. */
function remove(store, user, id) {
  const r = find(store, id);
  if (!r) throw httpError(404, 'Request not found');
  if (user.role !== 'admin') {
    if (!r.userIds.includes(user.id)) throw httpError(404, 'Request not found');
    if (r.userIds[0] !== user.id || r.status !== 'pending') {
      r.userIds = r.userIds.filter((u) => u !== user.id); // just stop following it
      if (!r.userIds.length) delete all(store)[id];
      store.save();
      return;
    }
  }
  delete all(store)[id];
  store.save();
}

/** Open requests whose title has arrived: marked available, and everyone who asked is told. */
function checkArrivals(store) {
  const open = Object.values(all(store)).filter((r) => OPEN.has(r.status));
  if (!open.length) return 0;
  const idx = { movie: libraryIndex(store, 'movie'), show: libraryIndex(store, 'show') };
  let n = 0;
  const users = new Map((store.data.users || []).map((u) => [u.id, u]));
  for (const r of open) {
    const o = findInLibrary(idx[r.kind], r);
    if (!o) continue;
    // Told only to those who can watch it (a title in a library hidden from someone stays unsaid).
    const can = r.userIds.filter((uid) => users.has(uid) && canSeeTitle(store, users.get(uid), o));
    if (!can.length) continue;
    Object.assign(r, { status: 'available', availableId: o.id, updatedAt: Date.now() });
    n++;
    for (const uid of can) {
      notifications.add(store, uid, {
        kind: 'request', title: `${r.title} is here`, body: 'What you asked for is ready to watch.',
        link: r.kind === 'show' ? `#/show/${o.id}` : `#/item/${o.id}`, key: `request-${r.id}-available`,
      });
    }
  }
  if (n) store.save();
  return n;
}

/** Search results (from the metadata sources) marked with whether each is here or already asked for. */
function markResults(store, user, kind, results) {
  const idx = libraryIndex(store, kind, user);
  const reqs = Object.values(all(store)).filter((r) => r.kind === kind);
  return results.map((x) => {
    const r = { provider: x.provider, providerId: x.id, title: x.title, year: x.year };
    const here = findInLibrary(idx, r);
    const asked = reqs.find((q) => q.provider === x.provider && q.providerId === String(x.id) && q.status !== 'declined');
    return { ...x, inLibrary: here ? { id: here.id, link: kind === 'show' ? `#/show/${here.id}` : `#/item/${here.id}` } : null, request: asked ? { id: asked.id, status: asked.status } : null };
  });
}

const pendingCount = (store) => Object.values(all(store)).filter((r) => r.status === 'pending').length;

module.exports = { create, list, update, send, remove, checkArrivals, markResults, pendingCount, autoApproves, STATUSES };
