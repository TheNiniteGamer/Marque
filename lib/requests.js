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
//   availableId, arr (see arr.js), seasons + showId (more seasons of a show already here),
//   firstHere (a show's first episodes have arrived), held (why it waits despite skipping approval),
//   createdAt, updatedAt }

const crypto = require('node:crypto');
const notifications = require('./notifications');
const { canSeeTitle } = require('./ratings');
const lib = require('./library');

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

// "More seasons of …": a show that's here already, and which seasons (numbers from 1).
function cleanSeasons(store, user, input) {
  const show = Object.hasOwn(store.data.shows, String(input.showId || '')) ? store.data.shows[input.showId] : null;
  if (!show || !canSeeTitle(store, user, show)) throw httpError(404, 'Show not found');
  const seasons = [...new Set((Array.isArray(input.seasons) ? input.seasons : []).map(Number))].filter((n) => Number.isInteger(n) && n >= 1 && n <= 300).sort((a, b) => a - b).slice(0, 60);
  if (!seasons.length) throw httpError(400, 'Pick the seasons you’d like');
  const m = show.meta || {};
  return {
    kind: 'show', showId: show.id, seasons, title: show.edits?.title || m.title || show.title, year: show.edits?.year || m.year || show.year || null,
    provider: ['tmdb', 'tvmaze'].includes(m.provider) ? m.provider : null, providerId: ['tmdb', 'tvmaze'].includes(m.provider) ? String(m.providerId) : null,
    thumb: null, overview: null, note: input.note ? String(input.note).trim().slice(0, 500) : null,
  };
}
const seasonsLabel = (list) => (list.length === 1 ? `season ${list[0]}` : `seasons ${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);
const titleOf = (r) => (r.seasons?.length ? `${r.title} (${seasonsLabel(r.seasons)})` : r.title);

/** Whether this person's requests of this kind skip an admin's approval. */
const autoApproves = (user, kind) => user.role === 'admin' || !!user.autoApprove?.[kind];

/** A new request (asking again for something already asked for adds you to it). `autoSend`: it
 * goes straight to Radarr / Sonarr (the caller sends it), so admins aren't asked to approve it. */
function create(store, user, input, { autoSend = false, held = null } = {}) {
  const r = input.showId ? cleanSeasons(store, user, input) : clean(input);
  if (!r.seasons) {
    const inLibrary = findInLibrary(libraryIndex(store, r.kind, user), r);
    if (inLibrary) throw httpError(409, `${r.title} is already here`);
  }
  const same = Object.values(all(store)).find((x) => x.kind === r.kind && x.status !== 'declined' && x.status !== 'available' && (r.seasons
    ? x.showId === r.showId && r.seasons.every((n) => x.seasons?.includes(n)) // (asked for already, with these seasons)
    : !x.seasons && ((r.providerId && x.provider === r.provider && x.providerId === r.providerId) || (norm(x.title) === norm(r.title) && (x.year || null) === r.year))));
  if (same) {
    if (!same.userIds.includes(user.id)) { same.userIds.push(user.id); same.updatedAt = Date.now(); store.save(); }
    return same;
  }
  const open = Object.values(all(store)).filter((x) => x.userIds[0] === user.id && OPEN.has(x.status)).length;
  if (open >= LIMIT_OPEN_PER_USER) throw httpError(429, `You have ${open} requests waiting; ask again once some have been sorted`);
  const id = crypto.randomBytes(6).toString('hex');
  const req = { id, ...r, userIds: [user.id], status: 'pending', adminNote: null, availableId: r.showId || null, held, createdAt: Date.now(), updatedAt: Date.now() };
  if (!req.seasons) { delete req.seasons; delete req.showId; }
  all(store)[id] = req;
  store.save();
  if (autoSend) return req; // (admins hear if sending fails)
  for (const admin of (store.data.users || []).filter((u) => u.role === 'admin' && u.id !== user.id)) {
    notifications.add(store, admin.id, {
      kind: 'request', title: `${user.username} asked for ${titleOf(req)}${r.year && !r.seasons ? ` (${r.year})` : ''}`,
      body: held ? `Waiting for you: ${held}` : r.note || (r.kind === 'show' ? 'A show' : 'A film'), link: '#/requests', key: `request-new-${id}`,
    });
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
      title: status === 'approved' ? `${titleOf(r)} is on its way` : `${titleOf(r)} won't be added`,
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
  r.held = null;
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

// Everyone who asked and can watch it (a title in a library hidden from someone stays unsaid).
function tellArrived(store, r, o, { all: whole = true } = {}) {
  const users = new Map((store.data.users || []).map((u) => [u.id, u]));
  const can = r.userIds.filter((uid) => users.has(uid) && canSeeTitle(store, users.get(uid), o));
  for (const uid of can) {
    notifications.add(store, uid, whole
      ? { kind: 'request', title: `${titleOf(r)} is here`, body: 'What you asked for is ready to watch.', link: r.kind === 'show' ? `#/show/${o.id}` : `#/item/${o.id}`, key: `request-${r.id}-available` }
      : { kind: 'request', title: `The first episodes of ${titleOf(r)} are here`, body: 'More are on the way; you’ll hear when they’re all in.', link: `#/show/${o.id}`, key: `request-${r.id}-first` });
  }
  return can.length > 0;
}
const arrived = (store, r, o) => { Object.assign(r, { status: 'available', availableId: o.id, firstHere: false, updatedAt: Date.now() }); tellArrived(store, r, o); };

/**
 * Open requests whose title has arrived: marked available, and everyone who asked is told. A show
 * Sonarr is getting is only "here" once Sonarr has every episode it was asked for (followUp
 * checks); its first episodes arriving is told on its own. More seasons of a show: here when
 * each of those seasons has episodes.
 */
function checkArrivals(store) {
  const open = Object.values(all(store)).filter((r) => OPEN.has(r.status));
  if (!open.length) return 0;
  const idx = { movie: libraryIndex(store, 'movie'), show: libraryIndex(store, 'show') };
  let n = 0;
  for (const r of open) {
    const viaSonarr = r.kind === 'show' && r.arr?.app === 'sonarr' && r.arr.id && !r.arr.error;
    let o;
    if (r.seasons) {
      o = store.data.shows[r.showId];
      const have = new Set(o ? lib.episodesOf(store, o.id).map((e) => e.season) : []);
      if (!o || !r.seasons.some((x) => have.has(x))) continue;
      if (!viaSonarr && !r.seasons.every((x) => have.has(x))) continue;
    } else {
      o = findInLibrary(idx[r.kind], r);
      if (!o) continue;
    }
    if (viaSonarr) {
      if (r.firstHere) continue;
      if (tellArrived(store, r, o, { all: false })) { Object.assign(r, { firstHere: true, availableId: o.id, updatedAt: Date.now() }); n++; }
      continue;
    }
    if (!tellArrived(store, r, o)) continue;
    Object.assign(r, { status: 'available', availableId: o.id, firstHere: false, updatedAt: Date.now() });
    n++;
  }
  if (n) store.save();
  return n;
}

// ---- rules for requests that skip approval, and following up on sent ones ----
const RULE_DEFAULTS = { minFreeGb: 100, weekly: { movie: 0, show: 0 }, stuckDays: 7 };
function rules(store) {
  const r = store.data.settings?.requestRules || {};
  return { ...RULE_DEFAULTS, ...r, weekly: { ...RULE_DEFAULTS.weekly, ...(r.weekly || {}) } };
}
function setRules(store, input = {}) {
  const cur = rules(store);
  const int = (v, max, what) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > max) throw httpError(400, `${what} must be a whole number from 0 to ${max}`);
    return n;
  };
  if (input.minFreeGb !== undefined) cur.minFreeGb = int(input.minFreeGb, 100000, 'Free space');
  if (input.stuckDays !== undefined) cur.stuckDays = int(input.stuckDays, 365, 'Days');
  for (const k of ['movie', 'show']) if (input.weekly?.[k] !== undefined) cur.weekly[k] = int(input.weekly[k], 100, 'The weekly limit');
  (store.data.settings ||= {}).requestRules = cur;
  store.save();
  return cur;
}

/**
 * Why a request from someone who skips approval should wait for an admin after all, or null:
 * too little space left where downloads go, or their weekly limit reached. Admins are never held.
 */
async function holdReason(store, arr, user, kind) {
  if (user.role === 'admin') return null;
  const r = rules(store);
  const limit = r.weekly[kind];
  if (limit) {
    const weekAgo = Date.now() - 7 * 86400_000;
    const used = Object.values(all(store)).filter((x) => x.kind === kind && x.userIds[0] === user.id && x.arr?.auto && x.arr.sentAt > weekAgo).length;
    if (used >= limit) return `${user.username} has had ${used} ${kind === 'show' ? (used === 1 ? 'show' : 'shows') : (used === 1 ? 'film' : 'films')} this week (the limit is ${limit})`;
  }
  if (r.minFreeGb) {
    const free = await arr.freeSpace(kind).catch(() => null);
    if (free != null && free < r.minFreeGb * 1e9) return `only ${Math.floor(free / 1e9)} GB free where downloads go (the limit is ${r.minFreeGb} GB)`;
  }
  return null;
}

/**
 * Checks on what's been sent (every few minutes): a show Sonarr has finished is marked here, and
 * something still not found after `stuckDays` is flagged to admins (once).
 */
async function followUp(store, arr, now = Date.now()) {
  const sent = Object.values(all(store)).filter((r) => OPEN.has(r.status) && r.arr?.id && !r.arr.error);
  if (!sent.length) return 0;
  const progress = await arr.progress(sent).catch(() => ({}));
  const stuckMs = rules(store).stuckDays * 86400_000;
  let n = 0;
  for (const r of sent) {
    const p = progress[r.id];
    if (!p) continue;
    if (r.kind === 'show' && r.firstHere && (p.state === 'downloaded' || p.state === 'gone')) {
      const o = store.data.shows[r.availableId];
      if (o) { arrived(store, r, o); n++; }
      continue;
    }
    if (stuckMs && p.state === 'searching' && now - (r.arr.sentAt ?? now) > stuckMs && !r.arr.stuckAt) {
      r.arr.stuckAt = now;
      n++;
      const days = Math.round((now - r.arr.sentAt) / 86400_000);
      for (const admin of (store.data.users || []).filter((u) => u.role === 'admin')) {
        notifications.add(store, admin.id, { kind: 'request', title: `${titleOf(r)} hasn’t been found in ${days} days`, body: 'Look again, try another quality, or decline it.', link: '#/requests', key: `request-${r.id}-stuck` });
      }
    } else if (r.arr.stuckAt && p.state !== 'searching') delete r.arr.stuckAt;
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

module.exports = { create, list, update, send, remove, checkArrivals, followUp, holdReason, rules, setRules, markResults, pendingCount, autoApproves, seasonsLabel, STATUSES };
