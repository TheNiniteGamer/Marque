'use strict';
// Requests ("can we get …?") and each person's notifications (the bell). Registered by server.js.

const requests = require('../lib/requests');
const notifications = require('../lib/notifications');

module.exports = function register(app) {
  const { store, matcher, arr, metadata, lib, getShow, HttpError, json, readBody, route } = app;

  // Searching the metadata sources costs the server's TMDB quota, so each person gets a sensible pace.
  const searches = new Map(); // userId -> recent times
  const paced = (user) => {
    const recent = (searches.get(user.id) || []).filter((t) => t > Date.now() - 60_000);
    if (recent.length >= 30) throw new HttpError(429, 'Too many searches; wait a minute');
    recent.push(Date.now());
    searches.set(user.id, recent);
  };

  route('GET', '/api/requests/search', async (req, res, p, url, user) => {
    const kind = url.searchParams.get('kind') === 'show' ? 'show' : 'movie';
    const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
    if (!q) throw new HttpError(400, 'Enter a title to search for');
    paced(user);
    let results = [];
    try { results = await matcher.search(kind, q, null, null); } catch (err) {
      // No TMDB key (films) or the source is down: a request can still be typed in by hand.
      return json(res, 200, { results: [], unavailable: err.message });
    }
    json(res, 200, { results: requests.markResults(store, user, kind, results.slice(0, 12)), canSend: requests.autoApproves(user, kind) && arr.ready(kind) });
  });
  // With how each one sent to Radarr / Sonarr is getting on (downloading 45%, not out yet…).
  route('GET', '/api/requests', async (req, res, p, url, user) => {
    const list = requests.list(store, user);
    const progress = await arr.progress(list.map((r) => store.data.requests[r.id]).filter((r) => r?.arr?.id)).catch(() => ({}));
    for (const r of list) if (progress[r.id]) r.progress = user.role === 'admin' ? progress[r.id] : { state: progress[r.id].state, label: progress[r.id].label, percent: progress[r.id].percent };
    json(res, 200, { requests: list, pending: user.role === 'admin' ? requests.pendingCount(store) : undefined, arr: { movie: arr.ready('movie'), show: arr.ready('show') } });
  });
  route('POST', '/api/requests', async (req, res, p, url, user) => {
    const body = await readBody(req);
    const before = new Set(Object.keys(store.data.requests || {}));
    const kind = body.kind === 'show' || body.showId ? 'show' : 'movie';
    // Someone who may skip approval can still choose to leave it with the requests ({ wait: true }).
    let autoSend = body.wait !== true && requests.autoApproves(user, kind) && arr.ready(kind);
    // Someone who skips approval still waits for an admin when space is low or they've had their week's worth.
    // (A place in their weekly allowance is kept while it's sent: released once it has been, or not.)
    const { reason: held, release } = autoSend ? await requests.holdReason(store, arr, user, kind) : { reason: null, release: () => {} };
    if (held) autoSend = false;
    let r;
    try {
      try { r = requests.create(store, user, body, { autoSend, held }); } catch (err) { throw new HttpError(err.status || 400, err.message); }
      // A new request from someone allowed to skip approval goes straight to Radarr / Sonarr.
      if (autoSend && !before.has(r.id)) {
        try { r = await requests.send(store, arr, r.id, { auto: true }); } catch { r = store.data.requests[r.id]; }
      }
    } finally { release(); }
    json(res, 200, { ...r, sent: !!(r.arr && !r.arr.error), arr: undefined, held: r.held || null });
  });

  // "More seasons": the show's seasons as its source lists them, with how many episodes of each are
  // here and which are asked for already.
  route('GET', '/api/shows/:id/seasons', async (req, res, { id }, url, user) => {
    const show = getShow(id, user);
    const here = new Map();
    for (const e of lib.episodesOf(store, show.id)) if (e.season != null) here.set(e.season, (here.get(e.season) || 0) + 1);
    let seasons = [];
    if (show.meta?.provider && show.meta.providerId) {
      try { seasons = await metadata.seasonsOf(show.meta.provider, show.meta.providerId); } catch { /* listed from the library only */ }
    }
    for (const n of here.keys()) if (n > 0 && !seasons.some((x) => x.season === n)) seasons.push({ season: n, episodes: null, name: `Season ${n}` });
    const asked = Object.values(store.data.requests || {}).filter((r) => r.showId === show.id && (r.status === 'pending' || r.status === 'approved'));
    json(res, 200, {
      sonarr: arr.ready('show'),
      canSend: requests.autoApproves(user, 'show') && arr.ready('show'),
      seasons: seasons.sort((a, b) => a.season - b.season).map((x) => ({ ...x, here: here.get(x.season) || 0, asked: asked.some((r) => r.seasons.includes(x.season)) })),
    });
  });
  // Approving sends it to Radarr / Sonarr when they're set up (with { profileId, monitor } to use a
  // different quality profile or seasons than the defaults; send: false to only mark it approved).
  route('PATCH', '/api/requests/:id', async (req, res, { id }, url, user) => {
    const body = await readBody(req);
    const r = store.data.requests?.[id] && Object.hasOwn(store.data.requests, id) ? store.data.requests[id] : null;
    try {
      if (body.status === 'approved' && r && arr.ready(r.kind) && body.send !== false) {
        if (body.adminNote !== undefined) requests.update(store, user, id, { adminNote: body.adminNote });
        return json(res, 200, await requests.send(store, arr, id, { profileId: body.profileId, monitor: body.monitor }));
      }
      json(res, 200, requests.update(store, user, id, body));
    } catch (err) { throw new HttpError(err.status || 400, err.message); }
  }, 'admin');
  // Not found yet: look again, or move it to another quality profile and look again.
  route('POST', '/api/requests/:id/search-again', async (req, res, { id }) => {
    const r = Object.hasOwn(store.data.requests || {}, id) ? store.data.requests[id] : null;
    if (!r) throw new HttpError(404, 'Request not found');
    const body = await readBody(req);
    if (body.profileId) r.arr.profile = (await arr.changeProfile(r, body.profileId)).name;
    else await arr.searchAgain(r);
    Object.assign(r.arr, { sentAt: Date.now() });
    delete r.arr.stuckAt;
    store.save();
    json(res, 200, { ok: true });
  }, 'admin');
  route('GET', '/api/request-rules', async (req, res) => json(res, 200, requests.rules(store)), 'admin');
  route('PUT', '/api/request-rules', async (req, res) => {
    try { json(res, 200, requests.setRules(store, await readBody(req))); } catch (err) { throw new HttpError(err.status || 400, err.message); }
  }, 'admin');
  route('POST', '/api/requests/:id/send', async (req, res, { id }) => {
    const body = await readBody(req);
    try { json(res, 200, await requests.send(store, arr, id, { profileId: body.profileId, monitor: body.monitor })); } catch (err) { throw new HttpError(err.status || 400, err.message); }
  }, 'admin');

  // --- Radarr & Sonarr (admins) ---
  const appOf = (name) => { if (!['radarr', 'sonarr'].includes(name)) throw new HttpError(404, 'Unknown app'); return name; };
  route('GET', '/api/arr', async (req, res) => json(res, 200, arr.publicSettings()), 'admin');
  route('POST', '/api/arr/:app/test', async (req, res, { app: name }) => json(res, 200, await arr.test(appOf(name), await readBody(req))), 'admin');
  route('GET', '/api/arr/:app/options', async (req, res, { app: name }) => json(res, 200, await arr.options(appOf(name))), 'admin');
  route('PUT', '/api/arr/:app', async (req, res, { app: name }) => json(res, 200, await arr.update(appOf(name), await readBody(req))), 'admin');
  route('DELETE', '/api/arr/:app', async (req, res, { app: name }) => { arr.disconnect(appOf(name)); json(res, 200, arr.publicSettings()); }, 'admin');
  route('DELETE', '/api/requests/:id', async (req, res, { id }, url, user) => {
    try { requests.remove(store, user, id); } catch (err) { throw new HttpError(err.status || 400, err.message); }
    json(res, 200, { ok: true });
  });

  // ?since=<ms>: only newer ones (the phone app's background check).
  route('GET', '/api/notifications', async (req, res, p, url, user) => json(res, 200, notifications.list(store, user, { since: Number(url.searchParams.get('since')) || 0 })));
  route('POST', '/api/notifications/read', async (req, res, p, url, user) => {
    const body = await readBody(req);
    notifications.markRead(store, user, Array.isArray(body?.ids) ? body.ids.map(String) : null);
    json(res, 200, notifications.list(store, user));
  });
  route('DELETE', '/api/notifications', async (req, res, p, url, user) => { notifications.clear(store, user); json(res, 200, { ok: true }); });
};
