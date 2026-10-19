'use strict';
// Notifications for each person: new episodes of shows they watch (or have on My List), requests
// that have arrived, and, for admins, problems the health check finds. Shown under the bell in the
// web app, and as phone notifications by the Android app (which checks every so often).
//
// store.data.notifications[userId] = [{ id, kind, title, body, link, at, read }], newest first.

const crypto = require('node:crypto');
const { canSeeTitle } = require('./ratings');

const KEEP = 60;                      // per person
const MAX_AGE_MS = 60 * 86400_000;    // and nothing older than two months

function add(store, userId, { kind, title, body = '', link = null, key = null }) {
  const all = (store.data.notifications ||= {});
  const list = (all[userId] ||= []);
  // The same thing twice (e.g. a health problem seen again) updates the one already there.
  const old = key ? list.findIndex((n) => n.key === key) : -1;
  if (old >= 0) list.splice(old, 1);
  list.unshift({ id: crypto.randomBytes(6).toString('hex'), kind, title, body, link, key, at: Date.now(), read: false });
  const cutoff = Date.now() - MAX_AGE_MS;
  all[userId] = list.filter((n) => n.at > cutoff).slice(0, KEEP);
  store.save({ personal: true }); // (the library's lookup tables don't depend on these)
}

function list(store, user, { since = 0 } = {}) {
  const items = (store.data.notifications?.[user.id] || []).filter((n) => n.at > since);
  return { items, unread: items.filter((n) => !n.read).length };
}

function markRead(store, user, ids = null) {
  for (const n of store.data.notifications?.[user.id] || []) if (!ids || ids.includes(n.id)) n.read = true;
  store.save({ lazy: true, personal: true });
}

function clear(store, user) {
  if (store.data.notifications) delete store.data.notifications[user.id];
  store.save({ lazy: true, personal: true });
}

/**
 * After a scan: episodes added since the last check, told to everyone who has watched some of that
 * show or has it on My List (and is allowed to see it). One notification per show and person.
 * The first check only notes the time, so a new server (or a first scan) doesn't flood anyone.
 */
function newEpisodes(store) {
  const state = (store.data.notifyState ||= {});
  const since = state.episodesCheckedAt;
  const now = Date.now();
  state.episodesCheckedAt = now;
  if (!since) { store.save({ personal: true }); return 0; }
  const byShow = new Map();
  for (const it of Object.values(store.data.items)) {
    if (it.type !== 'episode' || !it.showId || !(it.addedAt > since) || !(it.addedAt <= now)) continue;
    if (!byShow.has(it.showId)) byShow.set(it.showId, []);
    byShow.get(it.showId).push(it);
  }
  let sent = 0;
  if (byShow.size) {
    // Which episodes of each show each person has touched (one pass over everyone's history).
    const showsOf = new Map(); // userId -> Set(showId)
    for (const [uid, map] of Object.entries(store.data.progress || {})) {
      const set = new Set();
      for (const id of Object.keys(map || {})) { const s = store.data.items[id]?.showId; if (s) set.add(s); }
      showsOf.set(uid, set);
    }
    for (const [showId, eps] of byShow) {
      const show = store.data.shows[showId];
      if (!show) continue;
      const name = show.edits?.title || show.meta?.title || show.title;
      eps.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
      const first = eps[0];
      const label = (e) => `S${e.season ?? 1}:E${e.episode ?? '?'}${e.meta?.title || e.edits?.title ? ` · ${e.edits?.title || e.meta.title}` : ''}`;
      for (const user of store.data.users || []) {
        const follows = showsOf.get(user.id)?.has(showId) || !!store.data.watchlist?.[user.id]?.[showId];
        if (!follows || !canSeeTitle(store, user, show)) continue;
        add(store, user.id, {
          kind: 'episode',
          title: eps.length === 1 ? `New episode of ${name}` : `${eps.length} new episodes of ${name}`,
          body: eps.length === 1 ? label(first) : `From ${label(first)}`,
          link: `#/show/${showId}?season=${first.season ?? 1}`,
          key: `episodes-${showId}-${first.id}`,
        });
        sent++;
      }
    }
  }
  store.save({ personal: true });
  return sent;
}

module.exports = { add, list, markRead, clear, newEpisodes };
