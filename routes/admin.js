'use strict';
// Admin pages: activity, logs, maintenance, settings, metadata, updates, transcoding, remote access and backups.
// Registered by server.js, which passes the shared helpers and services in `app`.

const { fare } = require('../lib/report');
const { avatarOf } = require('../lib/auth');

module.exports = function register(app) {
  const {
    logs, fs, os, pipeline, lib, metadata, hlsLib, findProblems,
    ENCODER_NAMES, store, matcher, updater, hwaccel, hls, opensubs, activity,
    maintenance, intro, backups, auth, transcodes, HttpError, json, readBody, trickplay, keyframes, offline,
    readRaw, sendFile, getItem, viaHttpsProxy, getTarget, route, getLibrary, path, fromHostPath, health, isRemote, previews,
    INTRO_SOUND,
  } = app;

  // The opening sound: any audio file, made into a short MP3 without the silence at its start (so
  // it lines up with the animation), at most 6 seconds. It stays on this server (not in backups).
  route('GET', '/api/intro-sound', async (req, res) => json(res, 200, { custom: fs.existsSync(INTRO_SOUND) }), 'admin');
  route('PUT', '/api/intro-sound', async (req, res, p, url, me) => {
    const buf = await readRaw(req, 10 * 1024 * 1024);
    const tmp = `${INTRO_SOUND}.upload`, out = `${INTRO_SOUND}.new.mp3`;
    fs.writeFileSync(tmp, buf);
    try {
      await new Promise((resolve, reject) => require('node:child_process').execFile(process.env.FFMPEG_PATH || 'ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', tmp, '-vn',
        '-af', 'silenceremove=start_periods=1:start_threshold=-45dB,afade=t=out:st=5.4:d=0.6', '-t', '6',
        '-ac', '2', '-ar', '44100', '-b:a', '128k', out,
      ], { timeout: 30000 }, (err) => (err ? reject(err) : resolve())));
      if (!fs.statSync(out).size) throw new Error('empty');
      fs.renameSync(out, INTRO_SOUND);
    } catch {
      throw new HttpError(400, 'Couldn’t read that sound: try an MP3, WAV or M4A file');
    } finally {
      fs.rmSync(tmp, { force: true });
      fs.rmSync(out, { force: true });
    }
    console.log(`[settings] ${me.username} changed the opening sound`);
    json(res, 200, { custom: true });
  }, 'admin');
  route('DELETE', '/api/intro-sound', async (req, res) => {
    fs.rmSync(INTRO_SOUND, { force: true });
    json(res, 200, { custom: false });
  }, 'admin');

  // --- activity (admin): who is watching what right now ---
  route('GET', '/api/activity', async (req, res) => {
    // Videos being converted, by item and user: progressive (one ffmpeg per viewer) and adaptive streams.
    const conversions = [
      ...[...transcodes].filter((p) => p.meta).map((p) => ({ itemId: p.meta.itemId, userId: p.meta.userId, kind: 'transcode', encoder: p.meta.encoder, quality: null })),
      ...hls.status().filter((s) => s.running || s.paused).map((s) => ({ itemId: s.item, userId: s.userId, kind: 'hls', encoder: s.encoder, quality: s.quality })),
    ];
    const describe = (id) => {
      const it = store.data.items[id];
      if (!it) return null;
      const s = lib.itemSummary(store, { id: '' }, it); // (no one's own progress needed here)
      return { id, type: it.type, title: s.title, showTitle: s.showTitle, season: s.season, episode: s.episode, duration: s.duration, artV: s.artV };
    };
    const used = new Set();
    const capped = store.data.settings.remoteMaxQuality;
    const streams = activity.list().map((s) => {
      const conv = conversions.find((c, i) => !used.has(i) && c.itemId === s.itemId && (!c.userId || c.userId === s.userId) && used.add(i));
      // Why it isn't playing as it is on that kind of player (from the library report's rules).
      let why = null;
      const it = store.data.items[s.itemId];
      if (it?.media && s.mode !== 'direct' && s.mode !== 'cast') {
        const player = /roku/i.test(s.device) ? 'roku' : /android|shield/i.test(s.device) ? 'android' : 'browser';
        why = (fare(it)[player]?.why || []).filter(Boolean);
        if (s.remote && capped) why.push(`away from home: up to ${capped}`);
        why = why.length ? why.join(', ') : null;
      }
      return { ...s, stopBy: undefined, stopping: !!s.stopBy, why, item: describe(s.itemId), conversion: conv ? { ...conv, encoderName: conv.encoder ? ENCODER_NAMES[conv.encoder] : null } : null };
    });
    // Conversions with no player reporting (e.g. a Chromecast fetching the stream itself).
    const others = conversions.filter((c, i) => !used.has(i)).map((c) => ({
      ...c, encoderName: c.encoder ? ENCODER_NAMES[c.encoder] : null, item: describe(c.itemId), user: auth.byId(c.userId)?.username || null,
    }));
    // Work the server does by itself, which also uses the CPU (or the graphics card).
    const titleOf = (id) => { const d = describe(id) || (store.data.shows[id] && { title: store.data.shows[id].title }); return d ? (d.showTitle ? `${d.showTitle} · S${d.season}E${d.episode}` : d.title) : null; };
    const background = [
      trickplay.running && { what: 'Making seek-bar previews', title: titleOf(trickplay.running.id), gpu: trickplay.onGpu },
      previews.running && { what: 'Making a hover preview clip', title: titleOf(previews.running) },
      keyframes.current && { what: 'Finding keyframes (reading the file)', title: titleOf(keyframes.current.id) },
      intro.current && { what: activity.watching().length ? 'Finding intros (paused while someone watches)' : 'Finding intros', title: `${intro.current.show}, season ${intro.current.season}` },
      offline.running && { what: 'Making a copy for a phone download', title: titleOf(offline.running.item?.id) },
      app.scanner.status().scanning && { what: 'Scanning a library for new files', title: store.data.libraries.find((l) => l.id === app.scanner.status().current)?.name || null },
      app.autoSubs.running && { what: 'Fetching missing subtitles from OpenSubtitles', title: null },
    ].filter(Boolean);
    // What was watched in the last day, by anyone (newest first).
    const dayAgo = Date.now() - 86400_000;
    const recent = [];
    for (const [userId, map] of Object.entries(store.data.progress || {})) {
      const who = auth.byId(userId)?.username;
      if (!who) continue;
      for (const [itemId, p] of Object.entries(map)) {
        if (!(p.updatedAt > dayAgo) || !(p.watched || p.position > 60)) continue;
        const item = describe(itemId);
        if (item) recent.push({ user: who, item, at: p.updatedAt, watched: !!p.watched, position: p.position || 0 });
      }
    }
    recent.sort((a, b) => b.at - a.at);
    json(res, 200, {
      streams, others, background, recent: recent.slice(0, 25), optimize: app.optimizer.status(),
      cpu: activity.cpu(), memory: { total: os.totalmem(), free: os.freemem() },
      encoder: { active: hwaccel.active, name: ENCODER_NAMES[hwaccel.active] },
      avatars: Object.fromEntries(auth.users.map((u) => [u.username, avatarOf(u)])),
    });
  }, 'admin');

  // Stop someone's video (their player is told on its next report, within a few seconds).
  route('POST', '/api/activity/stop', async (req, res, p, url, user) => {
    const body = await readBody(req);
    if (!activity.stop(String(body.key || ''), user.username)) throw new HttpError(404, 'That video has already stopped');
    json(res, 200, { ok: true });
  }, 'admin');

  // --- logs (admin) ---
  route('GET', '/api/logs', async (req, res, p, url) => json(res, 200, { entries: logs.recent({ all: url.searchParams.has('all') }) }), 'admin');

  // --- maintenance (admin): cache sizes and clean-up ---
  route('GET', '/api/maintenance', async (req, res) => json(res, 200, maintenance.sizes()), 'admin');
  route('POST', '/api/maintenance/cleanup', async (req, res) => json(res, 200, { ...maintenance.cleanup(), ...maintenance.sizes() }), 'admin');

  // --- settings (admin) ---
  const settingsView = () => {
    const st = store.data.settings;
    return {
      tmdbKeySet: !!st.tmdbKey, tmdbKeyFromEnv: !st.tmdbKey && !!(process.env.TMDB_API_KEY || process.env.TMDB_TOKEN),
      tmdbKeyHint: st.tmdbKey ? `••••${st.tmdbKey.slice(-4)}` : null,
      language: st.language || process.env.METADATA_LANGUAGE || 'en-US',
      autoMatch: st.autoMatch !== false,
      updateCheck: st.updateCheck !== false,
      updateAutoInstall: st.updateAutoInstall === true,
      introDetection: st.introDetection !== false,
      home: lib.homeSettings(store),
      previewClips: st.previewClips !== false,
      providers: metadata.available(),
      opensubtitles: { keySet: !!st.opensubtitles?.apiKey, keyHint: st.opensubtitles?.apiKey ? `••••${st.opensubtitles.apiKey.slice(-4)}` : null, username: st.opensubtitles?.username || '' },
    };
  };
  route('GET', '/api/settings', async (req, res) => json(res, 200, settingsView()), 'admin');
  route('PATCH', '/api/settings', async (req, res) => {
    const body = await readBody(req);
    const st = store.data.settings;
    if (body.tmdbKey !== undefined) {
      const key = String(body.tmdbKey || '').trim();
      if (key) {
        const t = await metadata.tmdb.test(key);
        if (!t.ok) throw new HttpError(400, t.error);
        st.tmdbKey = key;
      } else delete st.tmdbKey;
    }
    if (body.language !== undefined) {
      if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(body.language)) throw new HttpError(400, 'Language must look like en-US');
      st.language = body.language;
    }
    if (body.autoMatch !== undefined) st.autoMatch = !!body.autoMatch;
    if (body.updateCheck !== undefined) st.updateCheck = !!body.updateCheck;
    if (body.updateAutoInstall !== undefined) st.updateAutoInstall = !!body.updateAutoInstall;
    if (body.opensubtitles !== undefined) {
      // { apiKey, username, password }: an empty apiKey removes the whole setup.
      const o = body.opensubtitles || {};
      const prev = st.opensubtitles || {};
      const next = {
        apiKey: o.apiKey !== undefined ? String(o.apiKey || '').trim() : prev.apiKey,
        username: o.username !== undefined ? String(o.username || '').trim() : prev.username,
        password: o.password ? String(o.password) : o.username === '' ? '' : prev.password,
      };
      if (!next.apiKey && o.apiKey === undefined) throw new HttpError(400, 'Paste the OpenSubtitles API key first');
      if (!next.apiKey) delete st.opensubtitles;
      else {
        st.opensubtitles = next;
        try { await opensubs.test(); } catch (err) { st.opensubtitles = prev.apiKey ? prev : undefined; if (!prev.apiKey) delete st.opensubtitles; throw err; }
      }
    }
    if (body.previewClips !== undefined) {
      st.previewClips = !!body.previewClips;
      if (!st.previewClips) setImmediate(() => previews.cleanup()); // turned off: the clips go
    }
    if (body.home !== undefined) {
      try { st.home = lib.cleanHome(body.home, lib.homeSettings(store)); } catch (err) { throw new HttpError(400, err.message); }
    }
    if (body.introDetection !== undefined) {
      st.introDetection = !!body.introDetection;
      if (st.introDetection) setImmediate(() => intro.enqueue());
    }
    store.save();
    json(res, 200, settingsView());
  }, 'admin');
  route('POST', '/api/settings/test-tmdb', async (req, res) => {
    const body = await readBody(req);
    json(res, 200, await metadata.tmdb.test(body.tmdbKey ? String(body.tmdbKey).trim() : undefined));
  }, 'admin');

  // --- metadata: search, match, edit (admin) ---
  // :id is a movie, episode or show id.
  const afterMetaChange = (id, user) => {
    const { target, kind } = getTarget(id, user);
    return kind === 'show' ? lib.showDetail(store, user, target) : lib.itemDetail(store, user, target);
  };

  route('GET', '/api/metadata/search', async (req, res, p, url) => {
    const kind = url.searchParams.get('kind') === 'show' ? 'show' : 'movie';
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) throw new HttpError(400, 'Enter a title to search for');
    const year = Number(url.searchParams.get('year')) || null;
    json(res, 200, { results: await matcher.search(kind, q, year, url.searchParams.get('provider') || null) });
  }, 'admin');

  route('GET', '/api/meta/:id', async (req, res, { id }, url, user) => {
    const { target, kind } = getTarget(id, user);
    json(res, 200, { ...matcher.describe(target, kind), providers: metadata.available().filter((pr) => pr.enabled && pr.kinds.includes(kind === 'episode' ? 'show' : kind)) });
  }, 'admin');

  route('PATCH', '/api/meta/:id', async (req, res, { id }, url, user) => {
    const { target, kind } = getTarget(id, user);
    matcher.edit(target, kind, await readBody(req));
    json(res, 200, afterMetaChange(id, user));
  }, 'admin');

  route('POST', '/api/meta/:id/match', async (req, res, { id }, url, user) => {
    const { target, kind } = getTarget(id, user);
    const body = await readBody(req);
    await matcher.apply(target, kind, String(body.provider || ''), String(body.id || ''), { how: { matchedBy: 'hand' } });
    json(res, 200, afterMetaChange(id, user));
  }, 'admin');

  // "Looks right" on a match listed under Needs a check.
  route('POST', '/api/meta/:id/confirm', async (req, res, { id }, url, user) => {
    const { target, kind } = getTarget(id, user);
    if (kind === 'episode') throw new HttpError(400, 'Confirm the show instead of a single episode');
    matcher.confirm(target);
    json(res, 200, afterMetaChange(id, user));
  }, 'admin');

  // Re-check every automatic match in a library with the current matching rules (in the background).
  route('POST', '/api/libraries/:id/recheck-matches', async (req, res, { id }, url, user) => {
    json(res, 202, matcher.recheck(getLibrary(id, user)));
  }, 'admin');

  route('POST', '/api/meta/:id/refresh', async (req, res, { id }, url, user) => {
    const { target, kind } = getTarget(id, user);
    await matcher.refresh(target, kind);
    json(res, 200, afterMetaChange(id, user));
  }, 'admin');

  route('POST', '/api/meta/:id/unmatch', async (req, res, { id }, url, user) => {
    const { target, kind } = getTarget(id, user);
    matcher.unmatch(target, kind);
    json(res, 200, afterMetaChange(id, user));
  }, 'admin');

  // How a show's episodes are numbered: { numbering: "auto" | "absolute" | "season" } (anime).
  route('PUT', '/api/meta/:id/numbering', async (req, res, { id }, url, user) => {
    const { target, kind } = getTarget(id, user);
    if (kind !== 'show') throw new HttpError(400, 'Only shows have episode numbering');
    const numbering = await matcher.setNumbering(target, String((await readBody(req)).numbering || ''));
    json(res, 200, { numbering, ...afterMetaChange(id, user) });
  }, 'admin');

  // Fix episode: the show's episodes to pick from, and setting which one a file really is.
  const getEpisode = (id, user) => {
    const { target, kind } = getTarget(id, user);
    if (kind !== 'episode') throw new HttpError(400, 'Only episodes can be fixed this way');
    return target;
  };
  route('GET', '/api/meta/:id/episodes', async (req, res, { id }, url, user) => json(res, 200, await matcher.episodeChoices(getEpisode(id, user))), 'admin');
  route('PUT', '/api/meta/:id/episode', async (req, res, { id }, url, user) => {
    await matcher.setEpisode(getEpisode(id, user), await readBody(req));
    json(res, 200, afterMetaChange(id, user));
  }, 'admin');

  route('GET', '/api/meta/:id/images', async (req, res, { id }, url, user) => {
    const { target, kind } = getTarget(id, user);
    json(res, 200, await matcher.providerImages(target, kind).catch((err) => { throw new HttpError(502, err.message); }));
  }, 'admin');

  // Set artwork: JSON {url} to download, or the raw image bytes as the request body.
  route('PUT', '/api/meta/:id/art/:kind', async (req, res, { id, kind: artKind }, url, user) => {
    const { target, kind } = getTarget(id, user);
    const type = String(req.headers['content-type'] || '');
    try {
      if (type.startsWith('image/')) await matcher.setArt(target, kind, artKind, { buffer: await readRaw(req, metadata.MAX_IMAGE) });
      else await matcher.setArt(target, kind, artKind, { url: (await readBody(req)).url });
    } catch (err) { throw err.status ? err : new HttpError(400, err.message); }
    json(res, 200, afterMetaChange(id, user));
  }, 'admin');

  route('DELETE', '/api/meta/:id/art/:kind', async (req, res, { id, kind: artKind }, url, user) => {
    const { target, kind } = getTarget(id, user);
    matcher.resetArt(target, kind, artKind);
    json(res, 200, afterMetaChange(id, user));
  }, 'admin');

  // --- updates (admin) ---

  // --- transcoding + skip intro (admin) ---
  const transcodingView = () => ({ ...hwaccel.status(), checking: !!hwaccel.checking, sessions: hls.status(), castUrl: store.data.settings.castUrl || '', castUrlFromEnv: process.env.CAST_URL || null,
    remoteMaxQuality: store.data.settings.remoteMaxQuality || '' });
  route('GET', '/api/transcoding', async (req, res) => json(res, 200, transcodingView()), 'admin');

  // --- automatic subtitles (admin; lib/autosubs.js) ---
  route('GET', '/api/autosubs', async (req, res) => json(res, 200, app.autoSubs.status()), 'admin');
  route('PATCH', '/api/autosubs', async (req, res) => json(res, 200, app.autoSubs.update(await readBody(req))), 'admin');
  route('POST', '/api/autosubs/run', async (req, res) => { const got = await app.autoSubs.run(); json(res, 200, { ...app.autoSubs.status(), got }); }, 'admin');

  // --- overnight conversions (admin; lib/optimize.js) ---
  route('GET', '/api/optimize', async (req, res) => json(res, 200, app.optimizer.status()), 'admin');
  route('PATCH', '/api/optimize', async (req, res) => { app.optimizer.update(await readBody(req)); json(res, 200, app.optimizer.status()); }, 'admin');
  route('POST', '/api/optimize/start-now', async (req, res) => { app.optimizer.startNow(); json(res, 200, app.optimizer.status()); }, 'admin');
  route('POST', '/api/optimize/pause', async (req, res, p, url, user) => { app.optimizer.pause(user.username); json(res, 200, app.optimizer.status()); }, 'admin');
  route('POST', '/api/optimize/resume', async (req, res) => { app.optimizer.resume(); json(res, 200, app.optimizer.status()); }, 'admin');
  route('POST', '/api/optimize/stop-tonight', async (req, res, p, url, user) => { app.optimizer.stopForTonight(user.username); json(res, 200, app.optimizer.status()); }, 'admin');
  route('POST', '/api/optimize/move', async (req, res) => { app.optimizer.moveAll(); json(res, 202, app.optimizer.status()); }, 'admin');
  route('DELETE', '/api/optimize', async (req, res) => { app.optimizer.removeAll(); json(res, 200, app.optimizer.status()); }, 'admin');
  route('PATCH', '/api/transcoding', async (req, res) => {
    const body = await readBody(req);
    const st = store.data.settings;
    if (body.remoteMaxQuality !== undefined) {
      if (body.remoteMaxQuality && !hlsLib.QUALITIES.some((q) => q.id === body.remoteMaxQuality)) throw new HttpError(400, 'Unknown quality');
      if (body.remoteMaxQuality) st.remoteMaxQuality = body.remoteMaxQuality; else delete st.remoteMaxQuality;
    }
    if (body.castUrl !== undefined) {
      const u = String(body.castUrl || '').trim().replace(/\/+$/, '');
      if (u && !/^https?:\/\/[^/\s]+$/i.test(u)) throw new HttpError(400, 'Enter an address like http://192.168.1.20:32500');
      if (u) st.castUrl = u; else delete st.castUrl;
    }
    let redetect = false;
    if (body.hwaccel !== undefined) {
      if (!['auto', ...Object.keys(require('../lib/hwaccel').KINDS)].includes(body.hwaccel)) throw new HttpError(400, 'Unknown encoder');
      st.hwaccel = body.hwaccel;
      redetect = true;
    }
    store.save();
    if (redetect) await hwaccel.detect();
    json(res, 200, transcodingView());
  }, 'admin');
  route('POST', '/api/transcoding/test', async (req, res) => { await hwaccel.detect(); json(res, 200, transcodingView()); }, 'admin');
  // Set an episode's intro by hand ({ start, end } in seconds), mark it as having none ({ none: true }),
  // or go back to automatic detection ({ auto: true }).
  route('PUT', '/api/items/:id/intro', async (req, res, { id }, url, user) => {
    const item = getItem(id, user, { real: true });
    if (item.type !== 'episode') throw new HttpError(400, 'Only TV episodes have intros');
    const body = await readBody(req);
    if (body.auto) {
      delete item.intro;
      intro.enqueue({ libraryId: item.libraryId });
    } else if (body.none) {
      item.intro = { manual: true, at: Date.now() };
    } else {
      const start = Number(body.start), end = Number(body.end);
      const dur = item.media?.duration || Infinity;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > dur) {
        throw new HttpError(400, 'The intro must end after it starts, within the episode');
      }
      item.intro = { manual: true, start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10, at: Date.now() };
    }
    store.save();
    json(res, 200, lib.itemDetail(store, user, item));
  }, 'admin');
  // Formats & space: which titles need converting for which players (see lib/report.js).
  route('GET', '/api/library-report', async (req, res) => json(res, 200, require('../lib/report').libraryReport(store)), 'admin');

  route('GET', '/api/problems', async (req, res) => json(res, 200, {
    ...findProblems(store, metadata), recheck: matcher.rechecking, lastRecheck: matcher.lastRecheck || null,
  }), 'admin');
  // Same for where the end credits start: { start } | { none: true } | { auto: true }.
  route('PUT', '/api/items/:id/credits', async (req, res, { id }, url, user) => {
    const item = getItem(id, user, { real: true });
    if (item.type !== 'episode') throw new HttpError(400, 'Only TV episodes have credits detection');
    const body = await readBody(req);
    if (body.auto) {
      delete item.credits;
      intro.enqueue({ libraryId: item.libraryId });
    } else if (body.none) {
      item.credits = { manual: true, at: Date.now() };
    } else {
      const start = Number(body.start);
      if (!Number.isFinite(start) || start <= 0 || start >= (item.media?.duration || Infinity)) throw new HttpError(400, 'The credits must start within the episode');
      item.credits = { manual: true, start: Math.round(start * 10) / 10, at: Date.now() };
    }
    store.save();
    json(res, 200, lib.itemDetail(store, user, item));
  }, 'admin');
  route('GET', '/api/intro', async (req, res) => json(res, 200, intro.status()), 'admin');
  route('POST', '/api/intro/detect', async (req, res) => {
    const body = await readBody(req);
    intro.enqueue({ libraryId: body.libraryId || null, force: !!body.force });
    json(res, 202, intro.status());
  }, 'admin');

  // watching: how many are watching right now (a downloaded update waits for that to be 0).
  const updatesView = () => ({ ...updater.status(), watching: activity.watching().length });
  route('GET', '/api/updates', async (req, res) => json(res, 200, updatesView()), 'admin');
  route('POST', '/api/updates/check', async (req, res) => { await updater.check(); json(res, 200, updater.status()); }, 'admin');
  // { when: 'idle' (default: restart once nobody is watching) | 'now' }
  route('POST', '/api/updates/apply', async (req, res, p, url, user) => {
    const body = await readBody(req);
    updater.requestUpdate(user, { when: body?.when === 'now' ? 'now' : 'idle' });
    json(res, 202, updatesView());
  }, 'admin');
  route('POST', '/api/updates/restart-now', async (req, res, p, url, user) => { updater.restartNow(user); json(res, 200, updatesView()); }, 'admin');

  // --- remote access (admin) ---
  route('GET', '/api/remote', async (req, res) => json(res, 200, {
    configured: (process.env.REMOTE_ACCESS || '').split(',').map((x) => x.trim()).filter(Boolean),
    seen: store.data.remoteSeen || null,
    viaRemoteNow: viaHttpsProxy(req),
    adminAtHomeOnly: !!store.data.settings.adminAtHomeOnly,
  }), 'admin');
  route('PATCH', '/api/remote', async (req, res) => {
    const body = await readBody(req);
    if (body.adminAtHomeOnly !== undefined) {
      // Switching it on from outside would lock you out of the switch itself.
      if (body.adminAtHomeOnly && isRemote(req)) throw new HttpError(400, 'Switch this on from a device at home');
      store.data.settings.adminAtHomeOnly = !!body.adminAtHomeOnly;
      store.save();
    }
    json(res, 200, { adminAtHomeOnly: !!store.data.settings.adminAtHomeOnly });
  }, 'admin');

  // --- the health check (admin): ?run=1 checks again now ---
  route('GET', '/api/health-check', async (req, res, p, url) => json(res, 200, url.searchParams.has('run') ? health.run() : health.status()), 'admin');

  // --- backups (admin) ---
  route('GET', '/api/backups', async (req, res) => json(res, 200, backups.status()), 'admin');
  route('POST', '/api/backups', async (req, res) => json(res, 201, await backups.create('manual')), 'admin');
  route('PATCH', '/api/backups/settings', async (req, res) => {
    const body = await readBody(req);
    // A folder typed as the host PC knows it ("E:\\Backups") is found where Docker shows it.
    if (body.copyTo) {
      const typed = String(body.copyTo).trim();
      body.copyTo = fs.existsSync(path.resolve(typed)) ? path.resolve(typed) : fromHostPath(typed) || path.resolve(typed);
    }
    try { backups.update(body); } catch (err) { throw new HttpError(err.status || 400, err.message); }
    json(res, 200, backups.status());
  }, 'admin');
  route('POST', '/api/backups/copy', async (req, res) => {
    const r = await backups.copyOut();
    if (!r) throw new HttpError(400, 'Choose a folder to copy backups to, and make a backup first');
    if (!r.ok) throw new HttpError(500, `Couldn't copy the backup: ${r.error}`);
    json(res, 200, backups.status());
  }, 'admin');
  // A fresh backup straight to the browser (nothing is stored on the server).
  route('GET', '/api/backups/download', async (req, res) => {
    const name = `marquee-backup-${new Date().toISOString().slice(0, 10)}.tar.gz`;
    res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
    pipeline(backups.stream(), res, () => {});
  }, 'admin');
  route('GET', '/api/backups/file/:name', async (req, res, { name }) => {
    sendFile(req, res, backups.file(name), { type: 'application/gzip', headers: { 'Content-Disposition': `attachment; filename="${name}"` } });
  }, 'admin');
  route('DELETE', '/api/backups/file/:name', async (req, res, { name }) => { backups.remove(name); json(res, 200, backups.status()); }, 'admin');
  route('POST', '/api/backups/file/:name/restore', async (req, res, { name }) => {
    json(res, 200, await backups.restore(fs.createReadStream(backups.file(name))));
  }, 'admin');
  // Restore from an uploaded file (the raw .tar.gz as the request body).
  route('POST', '/api/backups/restore', async (req, res) => json(res, 200, await backups.restore(req)), 'admin');
};
