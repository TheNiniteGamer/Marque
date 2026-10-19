'use strict';
// Libraries, browsing, watch state, collections, My List and the folder picker.
// Registered by server.js, which passes the shared helpers and services in `app`.

module.exports = function register(app) {
  const {
    fs, os, path, randomId, canSeeLibrary, canDownload, lib, metadata, collections,
    DATA_DIR, MEDIA_ROOT, hostLabel, store, scanner, updater, hls, opensubs,
    activity, downloader, transcodes, HttpError, json, readBody, getItem, getShow,
    getLibrary, librarySummary, validateLibraryInput, removeLibraryData, clientIp, isRemote, getTarget, route,
    matcher, fromHostPath, folderPlaces, crypto, sendFile,
  } = app;

  // --- server + libraries ---
  route('GET', '/api/status', async (req, res, p, url, user) => json(res, 200, {
    name: 'Marquee', version: require('../package.json').version, hostname: os.hostname(),
    metadataProviders: metadata.available(), ...scanner.status(), activeTranscodes: transcodes.size + hls.active,
    downloader: downloader.status(), subtitleSearch: opensubs.configured(),
    // Your own downloads: how many are in progress, and which finished lately (for the "done" notice).
    myDownloads: canDownload(user) ? {
      active: downloader.jobs.filter((j) => j.userId === user.id && ['queued', 'running'].includes(j.status)).length,
      finished: downloader.jobs.filter((j) => j.userId === user.id && ['done', 'failed'].includes(j.status) && j.finishedAt > Date.now() - 86400_000)
        .map((j) => ({ id: j.id, title: j.title || j.url, status: j.status, finishedAt: j.finishedAt, files: j.files.length })),
    } : null,
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
  route('GET', '/api/home', async (req, res, p, url, user) => {
    const h = lib.home(store, user);
    // Collections as rows of their own (the first few, in the order an admin arranged them), after "New in …".
    const rows = collections.list(store, user).filter((c) => !c.hidden && c.count >= 3).slice(0, 3)
      .map((c) => { const d = collections.detail(store, user, c.id); return { key: `col-${c.id}`, title: c.name, note: `Collection · ${c.count} titles`, link: `#/collection/${c.id}`, style: 'poster', items: d.items }; });
    const at = h.hubs.findLastIndex((x) => x.key.startsWith('recent-')) + 1 || h.hubs.length;
    h.hubs.splice(at, 0, ...rows);
    json(res, 200, h);
  });

  route('GET', '/api/search', async (req, res, p, url, user) => json(res, 200, lib.search(store, user, url.searchParams.get('q') || '')));

  route('GET', '/api/shows/:id', async (req, res, { id }, url, user) => {
    const show = getShow(id, user);
    json(res, 200, { ...lib.showDetail(store, user, show), collections: collections.of(store, user, id), similar: lib.similar(store, user, show) });
  });

  route('POST', '/api/shows/:id/watched', async (req, res, { id }, url, user) => {
    const body = await readBody(req);
    const show = getShow(id, user);
    let eps = lib.episodesOf(store, show.id);
    if (body.season !== undefined) eps = eps.filter((e) => (e.season ?? null) === body.season);
    lib.setWatched(store, user, eps.map((e) => e.id), body.watched !== false);
    json(res, 200, lib.showDetail(store, user, show));
  });

  route('GET', '/api/items/:id', async (req, res, { id }, url, user) => {
    const it = getItem(id, user);
    json(res, 200, { ...lib.itemDetail(store, user, it), collections: collections.of(store, user, id), similar: it.type === 'movie' ? lib.similar(store, user, it) : [] });
  });

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
  // Many titles at once: { ids: [...] }.
  route('POST', '/api/collections/:id/members', async (req, res, { id }, url, user) => {
    collections.addMembers(store, id, (await readBody(req)).ids);
    json(res, 200, collections.detail(store, user, id));
  }, 'admin');
  route('POST', '/api/collections/:id/members/remove', async (req, res, { id }, url, user) => {
    collections.removeMembers(store, id, (await readBody(req)).ids);
    json(res, 200, collections.detail(store, user, id));
  }, 'admin');
  // Series found in video titles ("… Ep 3"), offered as new collections.
  route('GET', '/api/collection-suggestions', async (req, res, p, url, user) => json(res, 200, collections.suggest(store, user)), 'admin');

  // --- select several titles and act on them all ---
  // { ids, action }: watched, unwatched, watchlist-add, watchlist-remove (anyone);
  // refresh, genre-add, genre-remove with { genre } (admins).
  const BULK_ADMIN = new Set(['refresh', 'genre-add', 'genre-remove']);
  route('POST', '/api/bulk', async (req, res, p, url, user) => {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(String))] : [];
    if (!ids.length) throw new HttpError(400, 'Nothing selected');
    if (ids.length > 5000) throw new HttpError(400, 'Too many titles at once');
    const action = String(body.action || '');
    if (BULK_ADMIN.has(action) && user.role !== 'admin') throw new HttpError(403, 'Only admins can do that');
    const targets = ids.map((id) => getTarget(id, user));
    const episodesOf = ({ target, kind }) => (kind === 'show' ? lib.episodesOf(store, target.id).map((e) => e.id) : [target.id]);
    switch (action) {
      case 'watched': case 'unwatched':
        lib.setWatched(store, user, targets.flatMap(episodesOf), action === 'watched');
        break;
      case 'watchlist-add': case 'watchlist-remove':
        for (const { target, kind } of targets) if (kind !== 'episode') lib.setWatchlist(store, user, target.id, action === 'watchlist-add');
        break;
      case 'genre-add': case 'genre-remove': {
        const genre = String(body.genre || '').trim().slice(0, 60);
        if (!genre) throw new HttpError(400, 'Which genre?');
        const same = (g) => g.toLowerCase() === genre.toLowerCase();
        for (const { target, kind } of targets) {
          if (kind === 'episode') continue;
          const current = target.edits?.genres ?? target.meta?.genres ?? [];
          const next = action === 'genre-add' ? (current.some(same) ? current : [...current, genre]) : current.filter((g) => !same(g));
          if (next.length !== current.length) matcher.edit(target, kind, { genres: next.length ? next : null });
        }
        break;
      }
      case 'refresh':
        // Can take a while (one lookup per title), so it carries on after answering.
        (async () => {
          const seen = new Set();
          for (const { target, kind } of targets) {
            const t = kind === 'episode' ? store.data.shows[target.showId] : target;
            if (!t || seen.has(t.id)) continue;
            seen.add(t.id);
            await matcher.refresh(t, kind === 'episode' ? 'show' : kind).catch((err) => console.warn(`[metadata] refresh ${t.title}: ${err.message}`));
          }
        })();
        break;
      default:
        throw new HttpError(400, `Unknown action: ${action}`);
    }
    json(res, 200, { ok: true, count: ids.length });
  });

  route('POST', '/api/items/:id/progress', async (req, res, { id }, url, user) => {
    const item = getItem(id, user);
    const body = await readBody(req);
    const position = Number(body.position);
    if (!Number.isFinite(position)) throw new HttpError(400, 'position (seconds) required');
    activity.report(user, item, { ...body, position, ip: clientIp(req), remote: isRemote(req), ua: String(req.headers['user-agent'] || '') });
    // Players also report while paused (for the Activity page); the resume point only changes when it moved.
    const prev = store.data.progress[user.id]?.[item.id];
    if (body.paused && prev && !body.stopped && Math.abs((prev.position || 0) - position) < 1) {
      if (store.timer) store.save(); // a position still waiting to be written goes now
      return json(res, 200, lib.progressOf(store, user, item.id));
    }
    // Stopping or pausing is saved straight away; the reports in between can wait a little.
    json(res, 200, lib.setProgress(store, user, item, position, { lazy: !body.stopped && !body.paused }));
  });

  route('POST', '/api/items/:id/watched', async (req, res, { id }, url, user) => {
    const item = getItem(id, user);
    const body = await readBody(req);
    lib.setWatched(store, user, [item.id], body.watched !== false);
    json(res, 200, lib.itemSummary(store, user, item));
  });

  // --- people: the titles an actor is in, and their photo (fetched from TMDB once, then kept) ---
  route('GET', '/api/people/:name', async (req, res, { name }, url, user) => {
    const p = lib.person(store, user, name);
    if (!p.titles.length) throw new HttpError(404, 'Nobody by that name in your library');
    json(res, 200, { name: p.name, photo: p.photoSource ? `/api/people/${encodeURIComponent(p.name)}/photo` : null, titles: p.titles });
  });
  route('GET', '/api/people/:name/photo', async (req, res, { name }, url, user) => {
    const p = lib.person(store, user, name);
    if (!p.photoSource) throw new HttpError(404, 'No photo');
    const dir = path.join(DATA_DIR, 'people');
    const key = crypto.createHash('sha1').update(p.photoSource).digest('hex');
    let file = ['.jpg', '.png', '.webp', '.gif'].map((e) => path.join(dir, key + e)).find((f) => fs.existsSync(f));
    if (!file) {
      try { file = await metadata.downloadImage(p.photoSource, dir, key); } catch { throw new HttpError(404, 'No photo'); }
    }
    sendFile(req, res, file, { headers: { 'Cache-Control': 'private, max-age=604800' } });
  }, 'media');

  // --- thumbs up / down (a film or show; an episode counts for its show) ---
  route('PUT', '/api/thumbs/:id', async (req, res, { id }, url, user) => {
    const { target } = getTarget(id, user);
    const body = await readBody(req);
    const key = target.type === 'episode' ? target.showId : target.id;
    json(res, 200, { thumb: lib.setThumb(store, user, key, Number(body?.value) || 0) });
  });

  // --- the sound / subtitle languages a person picked, remembered per show ---
  route('PUT', '/api/items/:id/tracks', async (req, res, { id }, url, user) => {
    const it = getItem(id, user);
    const body = await readBody(req);
    json(res, 200, { tracks: it.showId ? lib.setTrackPrefs(store, user, it.showId, body || {}) : null });
  });

  // --- my list + continue watching ---
  route('GET', '/api/watchlist', async (req, res, p, url, user) => json(res, 200, lib.watchlist(store, user)));
  route('PUT', '/api/watchlist/:id', async (req, res, { id }, url, user) => { getTarget(id, user); lib.setWatchlist(store, user, id, true); json(res, 200, { ok: true }); });
  route('DELETE', '/api/watchlist/:id', async (req, res, { id }, url, user) => { lib.setWatchlist(store, user, id, false); json(res, 200, { ok: true }); });
  route('POST', '/api/continue/:id/hide', async (req, res, { id }, url, user) => { getTarget(id, user); lib.hideFromContinue(store, user, id); json(res, 200, { ok: true }); });

  // --- folder picker for adding libraries (admin) ---
  route('GET', '/api/fs', async (req, res, p, url) => {
    const asked = url.searchParams.get('path');
    let dir = path.resolve(asked || MEDIA_ROOT || os.homedir());
    if (asked && !fs.existsSync(dir)) dir = fromHostPath(asked) || dir;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { throw new HttpError(400, `Cannot read ${dir}: ${err.code}`); }
    const dirs = entries.filter((e) => !e.name.startsWith('.') && (e.isDirectory() || (e.isSymbolicLink() && (() => {
      try { return fs.statSync(path.join(dir, e.name)).isDirectory(); } catch { return false; }
    })()))).map((e) => e.name).sort((a, b) => a.localeCompare(b));
    const parent = path.dirname(dir);
    const labels = Object.fromEntries(dirs.map((d) => [d, hostLabel(path.join(dir, d))]).filter(([, v]) => v));
    json(res, 200, { path: dir, label: hostLabel(dir), parent: parent === dir ? null : parent, dirs, labels, home: MEDIA_ROOT || os.homedir(), places: folderPlaces() });
  }, 'admin');
  // How many videos a library made from this folder would find (it includes every folder inside it).
  route('GET', '/api/fs/preview', async (req, res, p, url) => {
    const dir = path.resolve(url.searchParams.get('path') || '');
    if (!fs.existsSync(dir)) throw new HttpError(400, 'Folder not found');
    json(res, 200, await scanner.preview(dir));
  }, 'admin');
};
