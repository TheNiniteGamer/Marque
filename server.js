#!/usr/bin/env node
'use strict';
// Marquee — a small self-hosted media server. No dependencies beyond Node and ffmpeg.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream');
const { Store, randomId } = require('./lib/store');
const { Scanner } = require('./lib/scanner');
const { Auth, publicUser, canSeeLibrary, canDownload } = require('./lib/auth');
const { Downloader } = require('./lib/downloader');
const media = require('./lib/media');
const subs = require('./lib/subtitles');
const lib = require('./lib/library');
const metadata = require('./lib/metadata');
const { Matcher } = require('./lib/matcher');
const { Updater } = require('./lib/updates');

const PORT = Number(process.env.PORT) || 32500;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MEDIA_ROOT = process.env.MEDIA_ROOT ? path.resolve(process.env.MEDIA_ROOT) : null;
const SCAN_INTERVAL_MIN = Number(process.env.SCAN_INTERVAL ?? 30);
// MEDIA_LABELS="/media/movies=D:/Movies|/media/movies2=E:/Movies": the host folder behind each
// container folder, so the UI can show names people recognise. ('|' never appears in Windows paths.)
const MEDIA_LABELS = (process.env.MEDIA_LABELS || '').split('|').map((s) => {
  const i = s.indexOf('=');
  return i > 0 && s.slice(i + 1).trim() ? [path.resolve(s.slice(0, i).trim()), s.slice(i + 1).trim().replace(/[\\/]+$/, '')] : null;
}).filter(Boolean);
function hostLabel(p) {
  for (const [inner, host] of MEDIA_LABELS) {
    if (p === inner) return host;
    if (p.startsWith(inner + path.sep)) return `${host}/${p.slice(inner.length + 1)}`;
  }
  return null;
}
const PUBLIC_DIR = path.join(__dirname, 'public');
const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
const SUB_CACHE = path.join(DATA_DIR, 'subs');

fs.mkdirSync(DATA_DIR, { recursive: true });
const store = new Store(path.join(DATA_DIR, 'db.json'));
store.data.settings ||= {};
metadata.configure(() => store.data.settings);
const matcher = new Matcher(store, path.join(DATA_DIR, 'images'));
const scanner = new Scanner(store, DATA_DIR, matcher);
const updater = new Updater(store, __dirname);
const auth = new Auth(store);
const downloader = new Downloader(store, { onFinished: (job) => scanner.enqueue(job.libraryId) });
const transcodes = new Set();

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1e6) { reject(new HttpError(413, 'Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'File too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.vtt': 'text/vtt; charset=utf-8',
};

// Serve a file with HTTP Range support (needed for seeking in <video>).
function sendFile(req, res, file, { type, headers = {} } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { throw new HttpError(404, 'File not found on disk'); }
  if (!st.isFile()) throw new HttpError(404, 'Not a file');
  const base = { 'Content-Type': type || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', ...headers };
  const range = req.headers.range;
  let start = 0, end = st.size - 1, status = 200;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (!m[1] && !m[2])) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), st.size - 1); }
    else start = Math.max(0, st.size - Number(m[2]));
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    status = 206;
    base['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  base['Content-Length'] = end - start + 1;
  res.writeHead(status, base);
  if (req.method === 'HEAD') return res.end();
  pipeline(fs.createReadStream(file, { start, end }), res, () => {});
}

// Lookups that also enforce the user's library access (hidden items look like they don't exist).
function getItem(id, user) {
  const it = store.data.items[id];
  if (!it || !canSeeLibrary(user, it.libraryId)) throw new HttpError(404, 'Item not found');
  return it;
}
function getShow(id, user) {
  const s = store.data.shows[id];
  if (!s || !canSeeLibrary(user, s.libraryId)) throw new HttpError(404, 'Show not found');
  return s;
}
function getLibrary(id, user) {
  const l = store.library(id);
  if (!l || !canSeeLibrary(user, l.id)) throw new HttpError(404, 'Library not found');
  return l;
}
function getUser(id) {
  const u = auth.byId(id);
  if (!u) throw new HttpError(404, 'User not found');
  return u;
}

function librarySummary(l, user) {
  const items = Object.values(store.data.items).filter((i) => i.libraryId === l.id);
  const admin = user.role === 'admin';
  return {
    id: l.id, name: l.name, type: l.type, createdAt: l.createdAt, scannedAt: l.scannedAt || null,
    count: l.type === 'show' ? Object.values(store.data.shows).filter((s) => s.libraryId === l.id).length : items.length,
    episodeCount: l.type === 'show' ? items.length : undefined,
    ...(admin ? {
      paths: l.paths,
      missingPaths: l.paths.filter((p) => !fs.existsSync(p)),
      pathLabels: Object.fromEntries(l.paths.map((p) => [p, hostLabel(p)]).filter(([, v]) => v)),
      // How many files each folder contributes, so multi-drive libraries are easy to check.
      pathCounts: Object.fromEntries(l.paths.map((p) => [p, items.filter((i) => i.file === p || i.file.startsWith(p.endsWith(path.sep) ? p : p + path.sep)).length])),
    } : {}),
  };
}

function validateLibraryInput(body, partial = false) {
  const out = {};
  if (!partial || body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, 'Name is required');
    out.name = body.name.trim().slice(0, 80);
  }
  if (!partial || body.type !== undefined) {
    if (!['movie', 'show'].includes(body.type)) throw new HttpError(400, 'Type must be "movie" or "show"');
    out.type = body.type;
  }
  if (!partial || body.paths !== undefined) {
    if (!Array.isArray(body.paths) || !body.paths.length) throw new HttpError(400, 'At least one folder is required');
    out.paths = [...new Set(body.paths.map((p) => String(p).trim()).filter(Boolean).map((p) => path.resolve(p)))];
    for (const p of out.paths) {
      if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new HttpError(400, `Folder not found: ${p}`);
    }
  }
  return out;
}

function removeLibraryData(libraryId) {
  for (const it of Object.values(store.data.items)) {
    if (it.libraryId !== libraryId) continue;
    delete store.data.items[it.id];
    for (const map of Object.values(store.data.progress)) delete map[it.id];
  }
  for (const s of Object.values(store.data.shows)) if (s.libraryId === libraryId) delete store.data.shows[s.id];
  for (const u of store.data.users) if (Array.isArray(u.libraries)) u.libraries = u.libraries.filter((id) => id !== libraryId);
}

// Artwork, falling back to a frame grabbed from the video.
async function resolveArt(kind, id, user) {
  const item = store.data.items[id];
  const show = store.data.shows[id];
  const exists = (p) => p && fs.existsSync(p) ? p : null;
  const frame = async (it) => {
    if (!it) return null;
    const dur = it.media?.duration || 0;
    return media.thumbnail(it.file, path.join(THUMB_DIR, `${it.id}.jpg`), dur ? Math.min(dur * 0.15, 300) : 5).catch(() => null);
  };
  if (item && canSeeLibrary(user, item.libraryId)) {
    if (kind === 'thumb') return exists(item.edits?.thumb) || exists(item.meta?.still) || frame(item);
    const parentShow = item.showId && store.data.shows[item.showId];
    const showArt = (k) => parentShow && (exists(parentShow.edits?.[k]) || exists(parentShow.meta?.[k]) || exists(parentShow[k]));
    if (kind === 'poster') return exists(item.edits?.poster) || exists(item.meta?.poster) || exists(item.poster) || showArt('poster') || frame(item);
    if (kind === 'backdrop') return exists(item.edits?.backdrop) || exists(item.meta?.backdrop) || exists(item.backdrop) || showArt('backdrop') ||
      exists(item.edits?.thumb) || exists(item.meta?.still) || frame(item);
  }
  if (show && canSeeLibrary(user, show.libraryId)) {
    const eps = lib.episodesOf(store, show.id);
    if (kind === 'poster') return exists(show.edits?.poster) || exists(show.meta?.poster) || exists(show.poster) || frame(eps[0]);
    return exists(show.edits?.backdrop) || exists(show.meta?.backdrop) || exists(show.backdrop) || frame(eps[0]);
  }
  return null;
}

async function subtitleVtt(item, subId) {
  let m;
  if ((m = /^ext(\d+)$/.exec(subId))) {
    const s = item.sidecarSubs?.[Number(m[1])];
    if (!s) throw new HttpError(404, 'Subtitle not found');
    const text = fs.readFileSync(s.file, 'utf8');
    return s.format === 'vtt' ? text : subs.srtToVtt(text);
  }
  if ((m = /^emb(\d+)$/.exec(subId))) {
    const cache = path.join(SUB_CACHE, `${item.id}-${m[1]}-${Math.round(item.mtime)}.vtt`);
    if (fs.existsSync(cache)) return fs.readFileSync(cache, 'utf8');
    const vtt = await media.extractSubtitle(item.file, Number(m[1]));
    fs.mkdirSync(SUB_CACHE, { recursive: true });
    fs.writeFileSync(cache, vtt);
    return vtt;
  }
  throw new HttpError(404, 'Subtitle not found');
}

const clientIp = (req) => req.socket.remoteAddress || 'unknown';

// ---------- routes ----------
// access: 'public' (no login), 'user' (any logged-in user), 'admin', 'download' (admin or users allowed to download)
const routes = [];
const route = (method, pattern, handler, access = 'user') =>
  routes.push({ method, access, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

// --- auth ---
// Public: also used by the Android app to recognise Marquee servers on the network.
route('GET', '/api/health', async (req, res) => json(res, 200, { ok: true, name: 'Marquee', version: require('./package.json').version }), 'public');

route('GET', '/api/auth/me', async (req, res, p, url, user) => {
  if (!user) return json(res, 401, { error: 'Not signed in', setupRequired: !auth.hasUsers() });
  json(res, 200, { user: publicUser(user) });
}, 'public');

route('POST', '/api/auth/setup', async (req, res) => {
  if (auth.hasUsers()) throw new HttpError(409, 'Setup is already complete');
  const body = await readBody(req);
  const user = await auth.createUser({ username: body.username, password: body.password, role: 'admin' });
  // Watch history recorded before accounts existed (flat itemId -> progress) belongs to the first admin.
  const flat = Object.entries(store.data.progress).filter(([, v]) => v && typeof v.updatedAt === 'number');
  if (flat.length) {
    store.data.progress[user.id] = Object.fromEntries(flat);
    for (const [k] of flat) delete store.data.progress[k];
  }
  auth.createSession(req, res, user);
  json(res, 201, { user: publicUser(user) });
}, 'public');

route('POST', '/api/auth/login', async (req, res) => {
  const ip = clientIp(req);
  if (auth.isLimited(ip)) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
  const body = await readBody(req);
  const user = await auth.login(body.username, body.password);
  if (!user) { auth.recordFailure(ip); throw new HttpError(401, 'Wrong username or password'); }
  auth.createSession(req, res, user);
  json(res, 200, { user: publicUser(user) });
}, 'public');

route('POST', '/api/auth/logout', async (req, res, p, url, user) => {
  if (user) auth.destroySession(req, res);
  json(res, 200, { ok: true });
}, 'public');

route('POST', '/api/auth/password', async (req, res, p, url, user) => {
  const body = await readBody(req);
  if (!(await auth.login(user.username, body.currentPassword))) throw new HttpError(400, 'Current password is incorrect');
  await auth.updateUser(user, { password: body.newPassword || '' });
  auth.endSessionsFor(user.id, req.sessionKey); // sign out other devices
  json(res, 200, { ok: true });
});

// --- users (admin) ---
route('GET', '/api/users', async (req, res) => json(res, 200, auth.users.map(publicUser)), 'admin');

route('POST', '/api/users', async (req, res) => {
  const user = await auth.createUser(await readBody(req));
  json(res, 201, publicUser(user));
}, 'admin');

route('PATCH', '/api/users/:id', async (req, res, { id }, url, me) => {
  const target = getUser(id);
  const body = await readBody(req);
  if (target.id === me.id && body.role === 'user') throw new HttpError(400, 'You cannot remove your own admin role');
  await auth.updateUser(target, body);
  if (body.password) auth.endSessionsFor(target.id, target.id === me.id ? req.sessionKey : null);
  json(res, 200, publicUser(target));
}, 'admin');

route('DELETE', '/api/users/:id', async (req, res, { id }, url, me) => {
  const target = getUser(id);
  if (target.id === me.id) throw new HttpError(400, 'You cannot delete your own account');
  auth.deleteUser(target);
  json(res, 200, { ok: true });
}, 'admin');

// --- server + libraries ---
route('GET', '/api/status', async (req, res, p, url, user) => json(res, 200, {
  name: 'Marquee', version: require('./package.json').version, hostname: os.hostname(),
  metadataProviders: metadata.available(), ...scanner.status(), activeTranscodes: transcodes.size,
  downloader: downloader.status(),
  ...(user.role === 'admin' ? { dataDir: DATA_DIR, mediaRoot: MEDIA_ROOT, updateAvailable: updater.updateAvailable(), updating: updater.helper().state === 'updating' } : {}),
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

route('GET', '/api/shows/:id', async (req, res, { id }, url, user) => json(res, 200, lib.showDetail(store, user, getShow(id, user))));

route('POST', '/api/shows/:id/watched', async (req, res, { id }, url, user) => {
  const body = await readBody(req);
  const show = getShow(id, user);
  let eps = lib.episodesOf(store, show.id);
  if (body.season !== undefined) eps = eps.filter((e) => (e.season ?? null) === body.season);
  lib.setWatched(store, user, eps.map((e) => e.id), body.watched !== false);
  json(res, 200, lib.showDetail(store, user, show));
});

route('GET', '/api/items/:id', async (req, res, { id }, url, user) => json(res, 200, lib.itemDetail(store, user, getItem(id, user))));

route('POST', '/api/items/:id/progress', async (req, res, { id }, url, user) => {
  const item = getItem(id, user);
  const body = await readBody(req);
  const position = Number(body.position);
  if (!Number.isFinite(position)) throw new HttpError(400, 'position (seconds) required');
  json(res, 200, lib.setProgress(store, user, item, position));
});

route('POST', '/api/items/:id/watched', async (req, res, { id }, url, user) => {
  const item = getItem(id, user);
  const body = await readBody(req);
  lib.setWatched(store, user, [item.id], body.watched !== false);
  json(res, 200, lib.itemSummary(store, user, item));
});

// --- playback ---
route('GET', '/api/items/:id/stream', async (req, res, { id }, url, user) => {
  const item = getItem(id, user);
  const headers = url.searchParams.has('download')
    ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(item.file))}` } : {};
  sendFile(req, res, item.file, { type: url.searchParams.has('download') ? 'application/octet-stream' : media.mimeFor(item.file), headers });
});

route('GET', '/api/items/:id/seekpoint', async (req, res, { id }, url, user) => {
  const item = getItem(id, user);
  const t = Math.max(0, Number(url.searchParams.get('t')) || 0);
  // Request the transcode with `t`; the stream's first frame will be at `start` (<= t).
  json(res, 200, { t, start: await media.seekPoint(item, t) });
});

route('GET', '/api/items/:id/transcode', async (req, res, { id }, url, user) => {
  const item = getItem(id, user);
  if (!fs.existsSync(item.file)) throw new HttpError(404, 'File not found on disk');
  const start = Math.max(0, Number(url.searchParams.get('start')) || 0);
  const audioIndex = Math.max(0, Number(url.searchParams.get('audio')) || 0);
  const proc = media.transcode(item, { start, audioIndex });
  transcodes.add(proc);
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
  proc.on('close', (code, signal) => {
    transcodes.delete(proc);
    if (code && !signal) console.warn(`[transcode] ${path.basename(item.file)} exited ${code}: ${stderr.trim()}`);
  });
  const stop = () => { if (proc.exitCode === null) proc.kill('SIGKILL'); };
  req.on('close', stop);
  res.on('close', stop);
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'X-Transcode-Start': String(start) });
  pipeline(proc.stdout, res, () => stop());
});

route('GET', '/api/items/:id/subtitles/:sub', async (req, res, { id, sub }, url, user) => {
  const item = getItem(id, user);
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const vtt = subs.shiftVtt(await subtitleVtt(item, sub), offset);
  res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(vtt);
});

route('GET', '/api/art/:kind/:id', async (req, res, { kind, id }, url, user) => {
  if (!['poster', 'backdrop', 'thumb'].includes(kind)) throw new HttpError(404, 'Unknown art kind');
  const file = await resolveArt(kind, id, user);
  if (!file) throw new HttpError(404, 'No artwork');
  sendFile(req, res, file, { headers: { 'Cache-Control': 'private, max-age=3600' } });
});

// --- settings (admin) ---
const settingsView = () => {
  const st = store.data.settings;
  return {
    tmdbKeySet: !!st.tmdbKey, tmdbKeyFromEnv: !st.tmdbKey && !!(process.env.TMDB_API_KEY || process.env.TMDB_TOKEN),
    tmdbKeyHint: st.tmdbKey ? `••••${st.tmdbKey.slice(-4)}` : null,
    language: st.language || process.env.METADATA_LANGUAGE || 'en-US',
    autoMatch: st.autoMatch !== false,
    updateCheck: st.updateCheck !== false,
    providers: metadata.available(),
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
  store.save();
  json(res, 200, settingsView());
}, 'admin');
route('POST', '/api/settings/test-tmdb', async (req, res) => {
  const body = await readBody(req);
  json(res, 200, await metadata.tmdb.test(body.tmdbKey ? String(body.tmdbKey).trim() : undefined));
}, 'admin');

// --- metadata: search, match, edit (admin) ---
// :id is a movie, episode or show id.
function getTarget(id, user) {
  const r = matcher.resolve(id);
  if (!canSeeLibrary(user, r.target.libraryId)) throw new HttpError(404, 'Not found');
  return r;
}
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
  await matcher.apply(target, kind, String(body.provider || ''), String(body.id || ''));
  json(res, 200, afterMetaChange(id, user));
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
route('GET', '/api/updates', async (req, res) => json(res, 200, updater.status()), 'admin');
route('POST', '/api/updates/check', async (req, res) => { await updater.check(); json(res, 200, updater.status()); }, 'admin');
route('POST', '/api/updates/apply', async (req, res, p, url, user) => { updater.requestUpdate(user); json(res, 202, updater.status()); }, 'admin');

// --- my list + continue watching ---
route('GET', '/api/watchlist', async (req, res, p, url, user) => json(res, 200, lib.watchlist(store, user)));
route('PUT', '/api/watchlist/:id', async (req, res, { id }, url, user) => { getTarget(id, user); lib.setWatchlist(store, user, id, true); json(res, 200, { ok: true }); });
route('DELETE', '/api/watchlist/:id', async (req, res, { id }, url, user) => { lib.setWatchlist(store, user, id, false); json(res, 200, { ok: true }); });
route('POST', '/api/continue/:id/hide', async (req, res, { id }, url, user) => { getTarget(id, user); lib.hideFromContinue(store, user, id); json(res, 200, { ok: true }); });

// --- downloads (yt-dlp) ---
const jobView = (j) => ({ ...j, dest: undefined });
const ownJobs = (user) => downloader.jobs.filter((j) => user.role === 'admin' || j.userId === user.id);
function getJob(id, user) {
  const job = ownJobs(user).find((j) => j.id === id);
  if (!job) throw new HttpError(404, 'Download not found');
  return job;
}

route('GET', '/api/downloads', async (req, res, p, url, user) => json(res, 200, {
  ...downloader.status(),
  targets: store.data.libraries.filter((l) => l.type === 'movie' && canSeeLibrary(user, l.id)).map((l) => ({ id: l.id, name: l.name })),
  jobs: ownJobs(user).map(jobView),
}), 'download');

route('POST', '/api/downloads', async (req, res, p, url, user) => {
  const body = await readBody(req);
  if (!canSeeLibrary(user, body.libraryId)) throw new HttpError(400, 'Choose a library to save into');
  json(res, 201, jobView(downloader.add(body, user)));
}, 'download');

route('POST', '/api/downloads/:id/cancel', async (req, res, { id }, url, user) => { getJob(id, user); json(res, 200, jobView(downloader.cancel(id))); }, 'download');
route('POST', '/api/downloads/:id/retry', async (req, res, { id }, url, user) => { getJob(id, user); json(res, 200, jobView(downloader.retry(id))); }, 'download');
route('DELETE', '/api/downloads/:id', async (req, res, { id }, url, user) => { getJob(id, user); downloader.remove(id); json(res, 200, { ok: true }); }, 'download');
route('POST', '/api/downloads/update-tool', async (req, res) => json(res, 200, await downloader.selfUpdate()), 'admin');

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

// ---------- server ----------
function serveStatic(req, res, pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  let file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !rel || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
  sendFile(req, res, file, { headers: { 'Cache-Control': 'no-cache' } });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      for (const r of routes) {
        const m = r.method === method && r.re.exec(url.pathname);
        if (!m) continue;
        const user = auth.authenticate(req);
        if (r.access !== 'public') {
          if (!user) throw Object.assign(new HttpError(401, 'Please sign in'), { setupRequired: !auth.hasUsers() });
          if (r.access === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Admins only');
          if (r.access === 'download' && !canDownload(user)) throw new HttpError(403, 'You are not allowed to download videos');
        }
        const params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
        return await r.handler(req, res, params, url, user);
      }
      throw new HttpError(404, 'Not found');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(`[http] ${req.method} ${url.pathname}:`, err);
    if (!res.headersSent) json(res, status, { error: err.message || 'Internal error', ...(err.setupRequired ? { setupRequired: true } : {}) });
    else res.destroy();
  }
});

// AUTO_LIBRARIES="Movies:movie:/media/movies,/media/movies2;TV Shows:show:/media/tv" sets up libraries
// from configuration (used by the Docker setup, where each drive is mounted as its own folder).
// Runs on every start: a library is created once, and folders added to the configuration later are
// attached to it. Anything the admin removes or deletes in the UI is remembered and not re-added.
function applyAutoLibraries() {
  const spec = process.env.AUTO_LIBRARIES;
  if (!spec) return;
  const auto = (store.data.autoLibraries ||= {}); // name -> { id, paths: [every path ever auto-added] }
  if (store.data.autoLibrariesDone) {
    // Installs from before multi-folder support: adopt the libraries created back then.
    for (const l of store.data.libraries) auto[l.name] ||= { id: l.id, paths: [...l.paths] };
    delete store.data.autoLibrariesDone;
  }
  for (const entry of spec.split(';').map((s) => s.trim()).filter(Boolean)) {
    const [rawName, type, ...rest] = entry.split(':');
    const name = (rawName || '').trim();
    const dirs = rest.join(':').split(',').map((p) => p.trim()).filter(Boolean).map((p) => path.resolve(p));
    if (!name || !['movie', 'show'].includes(type) || !dirs.length) {
      console.warn(`[auto-libraries] skipping "${entry}" (expected Name:movie|show:/path[,/path2…])`);
      continue;
    }
    const fresh = dirs.filter((d) => !auto[name]?.paths.includes(d));
    const missing = fresh.filter((d) => !fs.existsSync(d));
    for (const d of missing) console.warn(`[auto-libraries] "${name}": folder not found, skipping for now: ${d}`);
    const toAdd = fresh.filter((d) => fs.existsSync(d) && !store.data.libraries.some((l) => l.paths.includes(d)));
    if (!toAdd.length) continue;

    const known = auto[name];
    let library = known && store.library(known.id);
    if (known && !library) {
      // The admin deleted this library; leave it deleted.
      known.paths.push(...toAdd);
      continue;
    }
    if (!library) {
      library = { id: randomId(), name, type, paths: [], createdAt: Date.now() };
      store.data.libraries.push(library);
      console.log(`[auto-libraries] created "${name}" (${type})`);
    }
    library.paths.push(...toAdd);
    auto[name] = { id: library.id, paths: [...(known?.paths || []), ...toAdd] };
    for (const d of toAdd) console.log(`[auto-libraries] "${name}" += ${d}`);
  }
  store.save();
}

async function main() {
  if (!(await media.checkFfmpeg())) {
    console.error('ffprobe/ffmpeg not found. Install ffmpeg (or set FFMPEG_PATH / FFPROBE_PATH).');
    process.exit(1);
  }
  applyAutoLibraries();
  server.listen(PORT, HOST, () => {
    console.log(`Marquee is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`Data directory: ${DATA_DIR} · metadata: ${metadata.available().filter((p) => p.enabled).map((p) => p.name).join(', ') || 'off'}`);
    if (!auth.hasUsers()) console.log('First run: open the web UI to create the admin account.');
    downloader.checkTool().then((v) => console.log(v ? `yt-dlp ${v} available for downloads` : 'yt-dlp not found: video downloads disabled'));
  });
  scanner.enqueueAll();
  updater.startSchedule();
  if (SCAN_INTERVAL_MIN > 0) setInterval(() => scanner.enqueueAll(), SCAN_INTERVAL_MIN * 60_000).unref();
}

function shutdown() {
  for (const p of transcodes) p.kill('SIGKILL');
  for (const p of downloader.procs.values()) p.kill('SIGTERM'); // interrupted downloads are requeued on next start
  store.flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();
