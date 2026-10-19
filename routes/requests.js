'use strict';
// Requests ("can we get …?") and each person's notifications (the bell). Registered by server.js.

const requests = require('../lib/requests');
const notifications = require('../lib/notifications');

module.exports = function register(app) {
  const { store, matcher, HttpError, json, readBody, route } = app;

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
    json(res, 200, { results: requests.markResults(store, user, kind, results.slice(0, 12)) });
  });
  route('GET', '/api/requests', async (req, res, p, url, user) => json(res, 200, { requests: requests.list(store, user), pending: user.role === 'admin' ? requests.pendingCount(store) : undefined }));
  route('POST', '/api/requests', async (req, res, p, url, user) => {
    try { json(res, 200, requests.create(store, user, await readBody(req))); } catch (err) { throw new HttpError(err.status || 400, err.message); }
  });
  route('PATCH', '/api/requests/:id', async (req, res, { id }, url, user) => {
    try { json(res, 200, requests.update(store, user, id, await readBody(req))); } catch (err) { throw new HttpError(err.status || 400, err.message); }
  }, 'admin');
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
