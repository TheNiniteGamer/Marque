'use strict';
// Libraries, browsing, watch state, collections, My List and the folder picker.
// Registered by server.js, which passes the shared helpers and services in `app`.

module.exports = function register(app) {
  const {
    fs, os, path, randomId, canSeeLibrary, lib, metadata, collections,
    DATA_DIR, MEDIA_ROOT, hostLabel, store, scanner, updater, hls, opensubs,
    activity, downloader, transcodes, HttpError, json, readBody, getItem, getShow,
    getLibrary, librarySummary, validateLibraryInput, removeLibraryData, clientIp, isRemote, getTarget, route,
  } = app;

  // --- server + libraries ---
  route('GET', '/api/status', async (req, res, p, url, user) => json(res, 200, {
    name: 'Marquee', version: require('../package.json').version, hostname: os.hostname(),
    metadataProviders: metadata.available(), ...scanner.status(), activeTranscodes: transcodes.size + hls.active,
    downloader: downloader.status(), subtitleSearch: opensubs.configured(),
    ...(user.role === 'admin' ? { dataDir: DATA_DIR, mediaRoot: MEDIA_ROOT, updateAvailable: updater.updateAvailable(), significantUpdate: updater.significantUpdate(), updating: updater.helper().state === 'updating' } : {}),
  }));

  route('GET', '/api/libraries', async (req, res, p, url, user) =>
    json(res, 200, store.data.libraries.filter((l) => canSeeLibrary(user, l.id)).map((l) => librarySummary(l, user))));

  route('POST', '/api/libraries', async (req, res, p, url, user) => {
    const input = validateLibraryInput(await readBody(req));
    const library = { id: randomId(), ...input, createdAt: Date.now() };
    store.data.libraries.push(library);
    store.save();
    scanner.enqueue(library.id);
    json(res, 201, librarySummary(library, user));
  }, 'admin');

  route('PATCH', '/api/libraries/:id', async (req, res, { id }, url, user) => {
    const library = getLibrary(id, user);
    const input = validateLibraryInput(await readBody(req), true);
    if (input.type && input.type !== library.type) removeLibraryData(library.id);
    Object.assign(library, input);
    store.save();
    if (input.paths || input.type) scanner.enqueue(library.id);
    json(res, 200, librarySummary(library, user));
  }, 'admin');

  route('DELETE', '/api/libraries/:id', async (req, res, { id }, url, user) => {
    getLibrary(id, user);
    removeLibraryData(id);
    store.data.libraries = store.data.libraries.filter((l) => l.id !== id);
    store.save();
    json(res, 200, { ok: true });
  }, 'admin');

  route('POST', '/api/libraries/:id/scan', async (req, res, { id }, url, user) => {
    getLibrary(id, user);
    const body = await readBody(req);
    scanner.enqueue(id, { refreshMeta: !!body.refreshMetadata });
    json(res, 202, scanner.status());
  }, 'admin');

  route('POST', '/api/scan', async (req, res) => { scanner.enqueueAll(); json(res, 202, scanner.status()); }, 'admin');

  route('GET', '/api/libraries/:id/items', async (req, res, { id }, url, user) => {
    const library = getLibrary(id, user);
    json(res, 200, { library: librarySummary(library, user), items: lib.libraryContents(store, user, library) });
  });

  // --- browsing + watch state ---
  route('GET', '/api/home', async (req, res, p, url, user) => json(res, 200, lib.home(store, user)));

  route('GET', '/api/search', async (req, res, p, url, user) => json(res, 200, lib.search(store, user, url.searchParams.get('q') || '')));

  route('GET', '/api/shows/:id', async (req, res, { id }, url, user) => json(res, 200, { ...lib.showDetail(store, user, getShow(id, user)), collections: collections.of(store, user, id) }));

  route('POST', '/api/shows/:id/watched', async (req, res, { id }, url, user) => {
    const body = await readBody(req);
    const show = getShow(id, user);
    let eps = lib.episodesOf(store, show.id);
    if (body.season !== undefined) eps = eps.filter((e) => (e.season ?? null) === body.season);
    lib.setWatched(store, user, eps.map((e) => e.id), body.watched !== false);
    json(res, 200, lib.showDetail(store, user, show));
  });

  route('GET', '/api/items/:id', async (req, res, { id }, url, user) => json(res, 200, { ...lib.itemDetail(store, user, getItem(id, user)), collections: collections.of(store, user, id) }));

  // --- collections ---
  route('GET', '/api/collections', async (req, res, p, url, user) => json(res, 200, collections.list(store, user, { libraryId: url.searchParams.get('library'), includeHidden: url.searchParams.has('hidden') })));
  // Arrange the list of collections: { order: [ids] } or { order: null } for alphabetical.
  route('PUT', '/api/collection-order', async (req, res, p, url, user) => {
    collections.setListOrder(store, (await readBody(req)).order ?? null);
    json(res, 200, collections.list(store, user, { includeHidden: true }));
  }, 'admin');
  route('GET', '/api/collections/:id', async (req, res, { id }, url, user) => json(res, 200, collections.detail(store, user, id)));
  route('POST', '/api/collections', async (req, res, p, url, user) => {
    const c = collections.create(store, await readBody(req));
    json(res, 201, collections.detail(store, user, c.id));
  }, 'admin');
  // { name, cover, hidden } — works for TMDB collections too.
  route('PATCH', '/api/collections/:id', async (req, res, { id }, url, user) => {
    collections.update(store, id, await readBody(req));
    json(res, 200, collections.detail(store, user, id));
  }, 'admin');
  route('POST', '/api/collections/:id/reset', async (req, res, { id }, url, user) => {
    collections.reset(store, id);
    json(res, 200, collections.detail(store, user, id));
  }, 'admin');
  route('DELETE', '/api/collections/:id', async (req, res, { id }) => { collections.remove(store, id); json(res, 200, { ok: true }); }, 'admin');
  route('PUT', '/api/collections/:id/order', async (req, res, { id }, url, user) => {
    collections.setOrder(store, id, (await readBody(req)).order ?? null);
    json(res, 200, collections.detail(store, user, id));
  }, 'admin');
  route('PUT', '/api/collections/:id/members/:target', async (req, res, { id, target }, url, user) => {
    collections.addMember(store, id, target);
    json(res, 200, collections.detail(store, user, id));
  }, 'admin');
  route('DELETE', '/api/collections/:id/members/:target', async (req, res, { id, target }, url, user) => {
    collections.removeMember(store, id, target);
    json(res, 200, collections.detail(store, user, id));
  }, 'admin');

  route('POST', '/api/items/:id/progress', async (req, res, { id }, url, user) => {
    const item = getItem(id, user);
    const body = await readBody(req);
    const position = Number(body.position);
    if (!Number.isFinite(position)) throw new HttpError(400, 'position (seconds) required');
    activity.report(user, item, { ...body, position, ip: clientIp(req), remote: isRemote(req), ua: String(req.headers['user-agent'] || '') });
    // Players also report while paused (for the Activity page); the resume point only changes when it moved.
    const prev = store.data.progress[user.id]?.[item.id];
    if (body.paused && prev && !body.stopped && Math.abs((prev.position || 0) - position) < 1) return json(res, 200, lib.progressOf(store, user, item.id));
    json(res, 200, lib.setProgress(store, user, item, position));
  });

  route('POST', '/api/items/:id/watched', async (req, res, { id }, url, user) => {
    const item = getItem(id, user);
    const body = await readBody(req);
    lib.setWatched(store, user, [item.id], body.watched !== false);
    json(res, 200, lib.itemSummary(store, user, item));
  });

  // --- my list + continue watching ---
  route('GET', '/api/watchlist', async (req, res, p, url, user) => json(res, 200, lib.watchlist(store, user)));
  route('PUT', '/api/watchlist/:id', async (req, res, { id }, url, user) => { getTarget(id, user); lib.setWatchlist(store, user, id, true); json(res, 200, { ok: true }); });
  route('DELETE', '/api/watchlist/:id', async (req, res, { id }, url, user) => { lib.setWatchlist(store, user, id, false); json(res, 200, { ok: true }); });
  route('POST', '/api/continue/:id/hide', async (req, res, { id }, url, user) => { getTarget(id, user); lib.hideFromContinue(store, user, id); json(res, 200, { ok: true }); });

  // --- folder picker for adding libraries (admin) ---
  route('GET', '/api/fs', async (req, res, p, url) => {
    const dir = path.resolve(url.searchParams.get('path') || MEDIA_ROOT || os.homedir());
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { throw new HttpError(400, `Cannot read ${dir}: ${err.code}`); }
    const dirs = entries.filter((e) => !e.name.startsWith('.') && (e.isDirectory() || (e.isSymbolicLink() && (() => {
      try { return fs.statSync(path.join(dir, e.name)).isDirectory(); } catch { return false; }
    })()))).map((e) => e.name).sort((a, b) => a.localeCompare(b));
    const parent = path.dirname(dir);
    const labels = Object.fromEntries(dirs.map((d) => [d, hostLabel(path.join(dir, d))]).filter(([, v]) => v));
    json(res, 200, { path: dir, label: hostLabel(dir), parent: parent === dir ? null : parent, dirs, labels, home: MEDIA_ROOT || os.homedir() });
  }, 'admin');
};
