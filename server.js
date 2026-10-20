#!/usr/bin/env node
'use strict';
// Marquee — a small self-hosted media server. No dependencies beyond Node and ffmpeg.

// Recent messages are kept for Settings → Logs (set up first, so nothing is missed).
const logs = require('./lib/logs');
logs.install();

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const path = require('node:path');
const { pipeline } = require('node:stream');
const zlib = require('node:zlib');
const { Store, randomId } = require('./lib/store');
const { Scanner } = require('./lib/scanner');
const { Auth, publicUser, canSeeLibrary, canDownload } = require('./lib/auth');
const { canSeeTitle, allowedFor } = require('./lib/ratings');
const { Downloader } = require('./lib/downloader');
const media = require('./lib/media');
const hdr = require('./lib/hdr');
const subs = require('./lib/subtitles');
const lib = require('./lib/library');
const metadata = require('./lib/metadata');
const { Matcher } = require('./lib/matcher');
const { Updater } = require('./lib/updates');
const { Backups } = require('./lib/backup');
const { HwAccel } = require('./lib/hwaccel');
const hlsLib = require('./lib/hls');
const { MediaTokens } = require('./lib/tokens');
const { IntroDetector } = require('./lib/intro');
const { FolderWatcher } = require('./lib/watcher');
const { findProblems } = require('./lib/problems');
const collections = require('./lib/collections');
const { OpenSubtitles } = require('./lib/opensubtitles');
const { Parties } = require('./lib/party');
const { Trickplay } = require('./lib/trickplay');
const { Keyframes } = require('./lib/keyframes');
const { Activity } = require('./lib/activity');
const { Maintenance } = require('./lib/maintenance');
const offlineLib = require('./lib/offline');
const notifications = require('./lib/notifications');
const requests = require('./lib/requests');
const { Arr } = require('./lib/arr');
const { Optimizer } = require('./lib/optimize');
const { AutoSubs } = require('./lib/autosubs');
const { Health } = require('./lib/health');
const { Previews } = require('./lib/previews');
const { KINDS: ENCODER_NAMES } = require('./lib/hwaccel');

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
// The other way round: "E:/Movies" typed in the web page -> "/drives/1/Movies" in the container.
function fromHostPath(p) {
  const norm = (x) => x.replace(/\\/g, '/').replace(/\/+$/, '');
  const want = norm(String(p || '').trim());
  if (!want) return null;
  // Windows paths are not case-sensitive.
  const same = (a, b) => (/^[a-z]:/i.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b);
  for (const [inner, host] of [...MEDIA_LABELS].sort((a, b) => b[1].length - a[1].length)) {
    const h = norm(host);
    if (same(want, h) || (/^[a-z]:$/i.test(h) && same(want, `${h}/`))) return inner;
    if (want.length > h.length && same(want.slice(0, h.length + 1), `${h}/`)) return path.join(inner, ...want.slice(h.length + 1).split('/'));
  }
  return null;
}
// Places the folder picker offers as shortcuts: the folders and drives shared with Docker, the
// drive letters on Windows, and mounted disks on Linux and macOS.
function folderPlaces() {
  const places = [];
  const add = (p, label) => { if (!places.some((x) => x.path === p)) places.push({ path: p, label }); };
  for (const [inner, host] of MEDIA_LABELS) if (fs.existsSync(inner)) add(inner, /^[a-z]:$/i.test(host) ? `${host.toUpperCase()} drive` : host);
  if (process.platform === 'win32') {
    for (const c of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (fs.existsSync(`${c}:\\`)) add(`${c}:\\`, `${c}: drive`);
  } else {
    const user = os.userInfo().username;
    for (const base of ['/mnt', '/media', `/media/${user}`, `/run/media/${user}`, '/Volumes']) {
      let dirs = [];
      try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')); } catch { continue; }
      for (const e of dirs) {
        const full = path.join(base, e.name);
        if (e.name === user || MEDIA_LABELS.some(([inner]) => inner === full)) continue;
        add(full, hostLabel(full) || full);
      }
    }
  }
  if (MEDIA_ROOT) add(MEDIA_ROOT, hostLabel(MEDIA_ROOT) || MEDIA_ROOT);
  add(os.homedir(), 'Home folder');
  return places;
}
const PUBLIC_DIR = path.join(__dirname, 'public');
const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
const SUB_CACHE = path.join(DATA_DIR, 'subs');
const SUB_DOWNLOADS = path.join(DATA_DIR, 'subs-downloaded');

fs.mkdirSync(DATA_DIR, { recursive: true });
const store = new Store(path.join(DATA_DIR, 'db.json'));
store.data.settings ||= {};
metadata.configure(() => store.data.settings);
const matcher = new Matcher(store, path.join(DATA_DIR, 'images'));
const scanner = new Scanner(store, DATA_DIR, matcher);
const updater = new Updater(store, __dirname);
const hwaccel = new HwAccel(store);
const TRANSCODE_DIR = path.resolve(process.env.TRANSCODE_DIR || path.join(os.tmpdir(), `marquee-transcode-${PORT}`));
const hls = new hlsLib.HlsManager(TRANSCODE_DIR, hwaccel);
const tokens = new MediaTokens(store);
const opensubs = new OpenSubtitles(() => store.data.settings);
const autoSubs = new AutoSubs(store, opensubs, SUB_DOWNLOADS, { isOtherVersion: (it) => lib.isOtherVersion(store, it) });
const parties = new Parties();
const trickplay = new Trickplay(DATA_DIR, { hwaccel });
const keyframes = new Keyframes(path.join(DATA_DIR, 'keyframes'));
const activity = new Activity();
const maintenance = new Maintenance(store, DATA_DIR, { transcodeDir: TRANSCODE_DIR });
// Background work (phone download copies, preview clips, intro finding) waits while anyone is
// watching, converted or not (a film playing as it is still needs the disk and a calm machine).
const someoneWatching = () => transcodes.size > 0 || hls.active > 0 || activity.watching().length > 0;
const offline = new offlineLib.Offline(path.join(DATA_DIR, 'offline'), hwaccel, { isBusy: someoneWatching });
// Overnight conversions (optimize.js) wait only while the server is converting something for a viewer.
const optimizer = new Optimizer(store, path.resolve(process.env.OPTIMIZED_DIR || path.join(DATA_DIR, 'optimized')), hwaccel, {
  probe: (f) => media.probe(f), isBusy: () => transcodes.size > 0 || hls.active > 0, label: process.env.OPTIMIZED_LABEL || null,
});
const previews = new Previews(store, path.join(DATA_DIR, 'previews'), { isBusy: someoneWatching, episodesOf: lib.episodesOf });
const intro = new IntroDetector(store, DATA_DIR, { isBusy: someoneWatching });
scanner.on('done', (libraryId) => intro.enqueue({ libraryId }));
// New episodes for the people who watch those shows, and requests that have arrived.
scanner.on('done', () => {
  try { notifications.newEpisodes(store); requests.checkArrivals(store); } catch (err) { console.warn(`[notify] ${err.message}`); }
});
const watcher = new FolderWatcher(store, scanner, Number(process.env.WATCH_INTERVAL ?? 15) * 1000);
// Radarr / Sonarr: Windows folders they report ("D:\Movies") are matched to Marquee's libraries.
const arr = new Arr(store, {
  tvdbIdOf: metadata.tvdbIdOf,
  libraryFor: (hostPath) => {
    const inner = fromHostPath(hostPath) || hostPath;
    const lib = (store.data.libraries || []).find((l) => l.paths.some((p) => inner === p || inner.startsWith(p + path.sep) || p.startsWith(inner + path.sep)));
    return lib ? lib.name : null;
  },
});
const backups = new Backups(store, {
  dataDir: DATA_DIR,
  dir: path.resolve(process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups')),
  label: process.env.BACKUP_LABEL || null,
  pauseScans: () => scanner.pause(),
  resumeScans: () => scanner.resume(),
  labelFor: hostLabel,
  onRestored: () => { auth.prune(); tokens.rotate(); scanner.enqueueAll(); },
});
const auth = new Auth(store);
const health = new Health({ store, dataDir: DATA_DIR, transcodeDir: TRANSCODE_DIR, backups, updater, hwaccel, logs, arr, labelFor: hostLabel });
const downloader = new Downloader(store, { dataDir: DATA_DIR, onFinished: (job) => scanner.enqueue(job.libraryId) });
const transcodes = new Set();

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// Compressed when the browser accepts it and it's worth it: a 3,000-movie library list goes from
// about 900 KB to 35 KB, which matters on phones and away from home.
const acceptsGzip = (req) => /\bgzip\b/.test(String(req?.headers['accept-encoding'] || ''));
function json(res, status, body) {
  let data = Buffer.from(JSON.stringify(body));
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  if (data.length > 1400 && acceptsGzip(res.req)) {
    data = zlib.gzipSync(data, { level: 5 });
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = data.length;
  res.writeHead(status, headers);
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
  '.apk': 'application/vnd.android.package-archive',
  '.woff2': 'font/woff2',
};

// Text files worth compressing; kept compressed in memory (the web app's own files, subtitles).
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|manifest\+json|vnd\.apple\.mpegurl)|image\/svg)/;
const gzipCache = new Map(); // file -> { tag, data }

// Serve a file with HTTP Range support (needed for seeking in <video>). Browsers that already have
// the file get "304 Not Modified" instead of the whole file again.
function sendFile(req, res, file, { type, headers = {} } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { throw new HttpError(404, 'File not found on disk'); }
  if (!st.isFile()) throw new HttpError(404, 'Not a file');
  const contentType = type || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const etag = `W/"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
  const base = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', ETag: etag, 'Last-Modified': st.mtime.toUTCString(), ...headers };
  const range = req.headers.range;
  if (!range && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, ...(headers['Cache-Control'] ? { 'Cache-Control': headers['Cache-Control'] } : {}) });
    return res.end();
  }
  if (!range && COMPRESSIBLE.test(contentType) && st.size > 1400 && st.size < 8 * 1024 * 1024 && acceptsGzip(req)) {
    let c = gzipCache.get(file);
    if (c?.tag !== etag) {
      c = { tag: etag, data: zlib.gzipSync(fs.readFileSync(file), { level: 9 }) };
      gzipCache.set(file, c);
      if (gzipCache.size > 200) gzipCache.delete(gzipCache.keys().next().value);
    }
    delete base['Accept-Ranges'];
    res.writeHead(200, { ...base, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': c.data.length });
    return res.end(req.method === 'HEAD' ? undefined : c.data);
  }
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
// (Object.hasOwn: an id like "__proto__" or "constructor" must not find something built into JavaScript.)
// (Converted copies, "<id>~o", are found too; `real`: the original, for changing it.)
function getItem(id, user, { real = false } = {}) {
  let it = lib.resolveItem(store, id);
  if (real) it = lib.realItem(store, it);
  if (!canSeeTitle(store, user, it)) throw new HttpError(404, 'Item not found');
  return it;
}
function getShow(id, user) {
  const s = Object.hasOwn(store.data.shows, id) ? store.data.shows[id] : null;
  if (!canSeeTitle(store, user, s)) throw new HttpError(404, 'Show not found');
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
  const items = lib.memo(store, `libraryItems:${l.id}`, () => Object.values(store.data.items).filter((i) => i.libraryId === l.id && i.type !== 'extra'));
  const admin = user.role === 'admin';
  return {
    id: l.id, name: l.name, type: l.type, createdAt: l.createdAt, scannedAt: l.scannedAt || null,
    count: l.type === 'show' ? Object.values(store.data.shows).filter((s) => s.libraryId === l.id && allowedFor(store, user, s)).length : items.filter((i) => allowedFor(store, user, i)).length,
    episodeCount: l.type === 'show' ? items.filter((i) => allowedFor(store, user, i)).length : undefined,
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
    // A folder can be typed as it's called on the PC ("E:/Movies") when it's shared with Docker.
    const resolve = (p) => (fs.existsSync(path.resolve(p)) ? path.resolve(p) : fromHostPath(p) || path.resolve(p));
    const typed = [...new Set(body.paths.map((p) => String(p).trim()).filter(Boolean))];
    for (const p of typed) {
      const r = resolve(p);
      if (fs.existsSync(r) && fs.statSync(r).isDirectory()) continue;
      // In Docker, a Windows folder only exists if its drive is shared in .env.
      throw new HttpError(400, MEDIA_LABELS.length && /^[a-z]:[\\/]/i.test(p)
        ? `Folder not found: ${p}. Marquee runs in Docker and can only see folders on the drives listed in .env (DRIVE_1 to DRIVE_4, MOVIES_DIR, TV_DIR…). Add the drive there, then run start-marquee.bat again.`
        : `Folder not found: ${p}`);
    }
    out.paths = [...new Set(typed.map(resolve))];
    // The same PC folder can be reachable twice in Docker (as D:/Movies and inside the whole D: drive).
    const seen = new Map();
    for (const p of out.paths) {
      const key = (hostLabel(p) || p).toLowerCase();
      if (seen.has(key)) throw new HttpError(400, `${hostLabel(p) || p} is in the list twice`);
      seen.set(key, p);
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
    return media.thumbnail(it.file, path.join(THUMB_DIR, `${it.id}.jpg`), dur ? Math.min(dur * 0.15, 300) : 5, { video: it.media?.video }).catch(() => null);
  };
  if (canSeeTitle(store, user, item)) {
    if (kind === 'thumb') return exists(item.edits?.thumb) || exists(item.meta?.still) || frame(item);
    const parentShow = item.showId && store.data.shows[item.showId];
    const showArt = (k) => parentShow && (exists(parentShow.edits?.[k]) || exists(parentShow.meta?.[k]) || exists(parentShow[k]));
    if (kind === 'poster') return exists(item.edits?.poster) || exists(item.meta?.poster) || exists(item.poster) || showArt('poster') || frame(item);
    if (kind === 'backdrop') return exists(item.edits?.backdrop) || exists(item.meta?.backdrop) || exists(item.backdrop) || showArt('backdrop') ||
      exists(item.edits?.thumb) || exists(item.meta?.still) || frame(item);
  }
  if (canSeeTitle(store, user, show)) {
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
  if ((m = /^dl(\d+)$/.exec(subId))) {
    const s = item.downloadedSubs?.[Number(m[1])];
    if (!s) throw new HttpError(404, 'Subtitle not found');
    return subs.srtToVtt(fs.readFileSync(path.join(SUB_DOWNLOADS, s.file), 'utf8'));
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

// Private / local addresses: the home network, this machine, Docker networks, and Tailscale (100.64.0.0/10).
function isPrivateIp(ip) {
  const a = String(ip || '').replace(/^::ffff:/, '');
  if (a === '::1' || a === '127.0.0.1' || a.startsWith('127.')) return true;
  if (/^(10\.|192\.168\.|169\.254\.)/.test(a)) return true;
  const m = /^172\.(\d+)\./.exec(a); if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  const t = /^100\.(\d+)\./.exec(a); if (t && +t[1] >= 64 && +t[1] <= 127) return true;
  return /^f[cd]/i.test(a) || /^fe80:/i.test(a);
}
// Behind Tailscale serve / Cloudflare Tunnel / a reverse proxy, the real visitor is the last address
// the proxy added to X-Forwarded-For. Only trusted when the request came from a local proxy.
const TRUST_PROXY = process.env.TRUST_PROXY !== '0';
function clientIp(req) {
  const direct = req.socket.remoteAddress || 'unknown';
  const xff = req.headers['x-forwarded-for'];
  if (TRUST_PROXY && xff && isPrivateIp(direct)) {
    const parts = String(xff).split(',').map((x) => x.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return direct;
}
const viaHttpsProxy = (req) => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

// Remember the address Marquee is reached at from outside (shown in Settings → Remote access).
// Only from someone signed in, through a proxy on this PC or its Docker network: the address is
// shown to the admin as the one to use, so a stranger mustn't be able to set it with made-up headers.
function noteRemoteOrigin(req) {
  if (!viaHttpsProxy(req) || !isPrivateIp(req.socket.remoteAddress)) return;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  if (!host || /^(localhost|\d+\.\d+\.\d+\.\d+|\[)/.test(host)) return;
  const origin = `https://${host}`;
  const prev = store.data.remoteSeen;
  if (prev?.origin === origin && Date.now() - prev.at < 10 * 60_000) return;
  store.data.remoteSeen = { origin, at: Date.now(), via: host.endsWith('.ts.net') ? 'Tailscale' : 'tunnel' };
  store.save();
}

// A signed playback link stands in for the login cookie, but only for its own item (and that
// item's show artwork). Library access is still checked by the route as usual.
function mediaTokenUser(token, id) {
  const t = tokens.verify(token);
  if (!t) return null;
  const item = lib.resolveItem(store, t.itemId); // (converted copies too)
  if (!item || (id !== t.itemId && id !== item.showId)) return null;
  return auth.byId(t.userId);
}

// Addresses a Chromecast on the network could use to reach Marquee. An admin-set address wins;
// otherwise the browser falls back to the address it is using (unless that is "localhost").
function castAddresses() {
  const configured = (store.data.settings.castUrl || process.env.CAST_URL || '').replace(/\/+$/, '') || null;
  const lan = [];
  if (!fs.existsSync('/.dockerenv')) {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal && isPrivateIp(a.address)) lan.push(`http://${a.address}:${PORT}`);
    }
  }
  return { configured, public: store.data.remoteSeen?.origin || null, lan };
}

// ---------- helpers shared by several route groups ----------
// The admin can cap the quality for viewers away from home (Settings → Transcoding), so one remote
// viewer can't use up the home upload. Away = through Tailscale / Cloudflare, or from outside the network.
// Returns null (no limit) or { maxHeight, originalAllowed }.
const isRemote = (req) => viaHttpsProxy(req) || !isPrivateIp(clientIp(req));
function remoteLimit(req, item) {
  const q = hlsLib.QUALITIES.find((x) => x.id === store.data.settings.remoteMaxQuality);
  if (!q || !isRemote(req)) return null;
  // The original file is fine when its bitrate already fits the limit.
  const bitrate = item.media?.bitrate || Infinity;
  return { maxHeight: q.height, quality: q.id, originalAllowed: bitrate <= q.bitrate * 1.25 + 192_000 };
}

function getTarget(id, user) {
  const r = matcher.resolve(id);
  if (!canSeeTitle(store, user, r.target)) throw new HttpError(404, 'Not found');
  return r;
}

// ---------- routes ----------
// access: 'public' (no login), 'user' (any logged-in user), 'admin', 'download' (admin or users allowed to download)
const routes = [];
const route = (method, pattern, handler, access = 'user') =>
  routes.push({ method, access, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

// Route groups (each file registers its routes with `route`).
const app = {
  logs, http, fs, os, crypto, path, pipeline, Store,
  randomId, Scanner, Auth, publicUser, canSeeLibrary, canDownload, Downloader, media,
  subs, lib, metadata, Matcher, Updater, Backups, HwAccel, hlsLib,
  MediaTokens, IntroDetector, FolderWatcher, findProblems, collections, OpenSubtitles, Parties, Trickplay,
  Activity, Maintenance, ENCODER_NAMES, PORT, HOST, DATA_DIR, MEDIA_ROOT, SCAN_INTERVAL_MIN,
  MEDIA_LABELS, hostLabel, fromHostPath, folderPlaces, PUBLIC_DIR, THUMB_DIR, SUB_CACHE, SUB_DOWNLOADS, store, matcher,
  scanner, updater, hwaccel, TRANSCODE_DIR, hls, offline, offlineLib, health, previews, tokens, opensubs, parties,
  trickplay, keyframes, activity, maintenance, intro, watcher, backups, auth, downloader, arr, optimizer, autoSubs,
  transcodes, HttpError, json, readBody, readRaw, MIME, sendFile, getItem,
  getShow, getLibrary, getUser, librarySummary, validateLibraryInput, removeLibraryData, resolveArt, subtitleVtt,
  isPrivateIp, TRUST_PROXY, clientIp, viaHttpsProxy, noteRemoteOrigin, mediaTokenUser, castAddresses, isRemote,
  remoteLimit, getTarget, route,
};
for (const group of ['auth', 'library', 'playback', 'admin', 'downloads', 'requests']) require(`./routes/${group}`)(app);

// ---------- server ----------
function serveStatic(req, res, pathname) {
  const rel = safeDecode(pathname).replace(/^\/+/, '');
  let file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !rel || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
  sendFile(req, res, file, { headers: { 'Cache-Control': 'no-cache' } });
}

const MUST_CHANGE_ALLOWED = new Set(['GET /api/auth/me', 'POST /api/auth/password', 'POST /api/auth/logout', 'GET /api/health']);
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf']);

// A malformed %-escape in an address is the client's mistake (400), not a server error.
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { throw new HttpError(400, 'Bad address'); }
}

// What the web page may load: its own scripts (and Google's Cast SDK), pictures from anywhere over
// https (posters in search results), video from Marquee itself (blob: for adaptive streaming), and
// nothing may frame it. Inline scripts aren't allowed, so injected markup can't run code.
const CSP = [
  "default-src 'self'", "script-src 'self' https://www.gstatic.com", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:", "media-src 'self' blob:", "connect-src 'self' https://www.gstatic.com",
  "worker-src 'self' blob:", "font-src 'self' data:", "frame-src 'none'", "object-src 'none'",
  "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  // Some addresses can't be parsed at all ("//["): answered as a bad request. (This used to throw
  // outside the error handling below, and an unhandled error stops the whole server.)
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Bad address');
  }
  if (viaHttpsProxy(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  try {
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') {
        // CORS preflight from cast receivers fetching playback files with a signed link.
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': 'Range, Content-Type', 'Access-Control-Max-Age': '86400' });
        return res.end();
      }
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      for (const r of routes) {
        const m = r.method === method && r.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, safeDecode(v)]));
        // Ids are looked up in plain objects: names JavaScript gives every object never match anything.
        if (Object.values(params).some((v) => PROTO_KEYS.has(v))) throw new HttpError(404, 'Not found');
        // Changes asked for by another site's page (a form or script there, using this browser's
        // sign-in) are refused. Browsers say where a request comes from in Sec-Fetch-Site; apps
        // (TVs, the Android app's own requests) don't send it.
        const site = req.headers['sec-fetch-site'];
        if (method !== 'GET' && site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Requests from other sites are not allowed');
        let user = auth.authenticate(req, { queryToken: r.access === 'media' ? url.searchParams.get('at') : null });
        if (r.access === 'media') {
          // Playback files also open with a signed link (Chromecast, AirPlay, the Android player).
          if (!user && url.searchParams.has('mt')) user = mediaTokenUser(url.searchParams.get('mt'), params.id);
          if (url.searchParams.has('mt')) {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
          }
        }
        if (user) noteRemoteOrigin(req);
        // A temporary password from an admin: nothing but choosing their own (and signing out) until then.
        if (user?.mustChangePassword && !MUST_CHANGE_ALLOWED.has(`${method} ${url.pathname}`)) {
          throw Object.assign(new HttpError(403, 'Choose a new password first'), { mustChangePassword: true });
        }
        if (r.access !== 'public') {
          if (!user) throw Object.assign(new HttpError(401, 'Please sign in'), { setupRequired: !auth.hasUsers() });
          if (r.access === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Admins only');
          // Optional: admin settings only from home, so a leaked admin password is no use from outside.
          if (r.access === 'admin' && store.data.settings.adminAtHomeOnly && isRemote(req)) throw new HttpError(403, 'Admin settings can only be used at home (Settings → Remote access)');
          if (r.access === 'download' && !canDownload(user)) throw new HttpError(403, 'You are not allowed to download videos');
        }
        return await r.handler(req, res, params, url, user);
      }
      throw new HttpError(404, 'Not found');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(`[http] ${req.method} ${url.pathname}:`, err);
    // Unexpected errors can mention files and folders on the server: details go to the log only.
    const message = !err.status ? 'Something went wrong on the server (details are in Settings → Logs)' : err.message || 'Internal error';
    if (!res.headersSent) json(res, status, { error: message, ...(err.setupRequired ? { setupRequired: true } : {}), ...(err.mustChangePassword ? { mustChangePassword: true } : {}), ...(err.duplicate ? { duplicate: true } : {}) });
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

// The database file existed but no copy of it could be read: put back the newest backup rather than
// starting empty (which would look like a brand-new install).
async function recoverLostDatabase() {
  const latest = backups.list()[0];
  if (!latest) {
    console.error('[store] No backup to restore from: starting with an empty database.');
    return;
  }
  try {
    const r = await backups.restore(fs.createReadStream(path.join(backups.dir, latest.name)), { safetyCopy: false });
    console.error(`[store] Restored the database from the backup made ${r.restoredFrom}.`);
  } catch (err) {
    console.error(`[store] Could not restore ${latest.name}: ${err.message}`);
  }
}

async function main() {
  if (!(await media.checkFfmpeg())) {
    console.error('ffprobe/ffmpeg not found. Install ffmpeg (or set FFMPEG_PATH / FFPROBE_PATH).');
    process.exit(1);
  }
  await hdr.check();
  if (store.lost) await recoverLostDatabase();
  applyAutoLibraries();
  hwaccel.detect();
  server.listen(PORT, HOST, () => {
    console.log(`Marquee is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`Data directory: ${DATA_DIR} · metadata: ${metadata.available().filter((p) => p.enabled).map((p) => p.name).join(', ') || 'off'}`);
    if (!auth.hasUsers()) console.log('First run: open the web UI to create the admin account.');
    downloader.checkTool().then((v) => console.log(v ? `yt-dlp ${v} available for downloads` : 'yt-dlp not found: video downloads disabled'));
  });
  scanner.enqueueAll();
  updater.startSchedule();
  watcher.start();
  maintenance.start();
  offline.start();
  optimizer.start();
  autoSubs.start();
  health.start();
  previews.start();
  // Titles from before HDR, interlacing and DVD pixel shapes were noted: checked once, and
  // pictures made from those (washed out, combed or squashed) are made again.
  setTimeout(() => hdr.backfill(store, (it) => {
    fs.rmSync(path.join(THUMB_DIR, `${it.id}.jpg`), { force: true });
    fs.rmSync(trickplay.dir(it), { recursive: true, force: true });
    const owner = it.showId || it.id;
    for (const f of fs.readdirSync(previews.dir)) if (f.startsWith(`${owner}-`)) fs.rmSync(path.join(previews.dir, f), { force: true });
  }).catch((err) => console.warn(`[hdr] ${err.message}`)), 90_000).unref();
  // A downloaded update restarts Marquee only once nobody is watching (see updater.tick).
  setInterval(() => { try { updater.tick(activity.watching().length === 0 && transcodes.size === 0 && hls.active === 0); } catch (err) { console.warn(`[updates] ${err.message}`); } }, 10_000).unref();
  // Matching (which gives titles their TMDB / TVmaze ids) finishes after scans, so arrivals are
  // also checked every minute.
  setInterval(() => { try { requests.checkArrivals(store); } catch { /* next time */ } }, 60_000).unref();
  // Requests sent to Radarr / Sonarr: shows finished, and searches that are getting nowhere.
  const followUp = () => requests.followUp(store, arr).catch((err) => console.warn(`[requests] ${err.message}`));
  setTimeout(followUp, 30_000).unref();
  setInterval(followUp, Number(process.env.REQUEST_FOLLOWUP_MS) || 180_000).unref();
  downloader.startAutoUpdate();
  setTimeout(() => matcher.backfillCollections().then(() => matcher.backfillRatings()).then(() => matcher.backfillFranchiseFacts()).catch((err) => console.warn('[meta]', err.message)), 60_000).unref();
  backups.startSchedule();
  // With new files noticed by the folder watcher, full rescans (which look at every file) are only a
  // safety net, so they run at most every 6 hours.
  const scanEvery = watcher.intervalMs > 0 ? Math.max(SCAN_INTERVAL_MIN, 360) : SCAN_INTERVAL_MIN;
  if (scanEvery > 0) setInterval(() => scanner.enqueueAll(), scanEvery * 60_000).unref();
}

function shutdown() {
  for (const p of transcodes) p.kill('SIGKILL');
  hls.stopAll();
  offline.stop();
  parties.closeAll();
  for (const p of downloader.procs.values()) p.kill('SIGTERM'); // interrupted downloads are requeued on next start
  store.flush();
  process.exit(0);
}
// A stray error in some background job shouldn't take the whole server down (Node stops on an
// unhandled rejection): it's written to the log (Settings → Logs) instead.
process.on('unhandledRejection', (err) => console.error('[server] unexpected error (the server keeps running):', err));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();
