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
const media = require('./lib/media');
const subs = require('./lib/subtitles');
const lib = require('./lib/library');
const metadata = require('./lib/metadata');

const PORT = Number(process.env.PORT) || 32500;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const SCAN_INTERVAL_MIN = Number(process.env.SCAN_INTERVAL ?? 30);
const PUBLIC_DIR = path.join(__dirname, 'public');
const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
const SUB_CACHE = path.join(DATA_DIR, 'subs');

fs.mkdirSync(DATA_DIR, { recursive: true });
const store = new Store(path.join(DATA_DIR, 'db.json'));
const scanner = new Scanner(store, DATA_DIR);
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

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
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

const getItem = (id) => store.data.items[id] || (() => { throw new HttpError(404, 'Item not found'); })();
const getShow = (id) => store.data.shows[id] || (() => { throw new HttpError(404, 'Show not found'); })();
const getLibrary = (id) => store.library(id) || (() => { throw new HttpError(404, 'Library not found'); })();

function librarySummary(l) {
  const items = Object.values(store.data.items).filter((i) => i.libraryId === l.id);
  return {
    id: l.id, name: l.name, type: l.type, paths: l.paths, createdAt: l.createdAt, scannedAt: l.scannedAt || null,
    count: l.type === 'show' ? Object.values(store.data.shows).filter((s) => s.libraryId === l.id).length : items.length,
    episodeCount: l.type === 'show' ? items.length : undefined,
    missingPaths: l.paths.filter((p) => !fs.existsSync(p)),
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
  for (const it of Object.values(store.data.items)) if (it.libraryId === libraryId) { delete store.data.items[it.id]; delete store.data.progress[it.id]; }
  for (const s of Object.values(store.data.shows)) if (s.libraryId === libraryId) delete store.data.shows[s.id];
}

// Artwork, falling back to a frame grabbed from the video.
async function resolveArt(kind, id) {
  const item = store.data.items[id];
  const show = store.data.shows[id];
  const exists = (p) => p && fs.existsSync(p) ? p : null;
  const frame = async (it) => {
    if (!it) return null;
    const dur = it.media?.duration || 0;
    return media.thumbnail(it.file, path.join(THUMB_DIR, `${it.id}.jpg`), dur ? Math.min(dur * 0.15, 300) : 5).catch(() => null);
  };
  if (item) {
    if (kind === 'thumb') return exists(item.meta?.still) || frame(item);
    const parentShow = item.showId && store.data.shows[item.showId];
    if (kind === 'poster') return exists(item.meta?.poster) || exists(item.poster) ||
      (parentShow && (exists(parentShow.meta?.poster) || exists(parentShow.poster))) || frame(item);
    if (kind === 'backdrop') return exists(item.meta?.backdrop) || exists(item.backdrop) ||
      (parentShow && (exists(parentShow.meta?.backdrop) || exists(parentShow.backdrop))) || exists(item.meta?.still) || frame(item);
  }
  if (show) {
    const eps = lib.episodesOf(store, show.id);
    if (kind === 'poster') return exists(show.meta?.poster) || exists(show.poster) || frame(eps[0]);
    return exists(show.meta?.backdrop) || exists(show.backdrop) || frame(eps[0]);
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

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

route('GET', '/api/status', async (req, res) => json(res, 200, {
  name: 'Marquee', version: require('./package.json').version, hostname: os.hostname(),
  tmdb: metadata.enabled(), ...scanner.status(), activeTranscodes: transcodes.size,
}));

route('GET', '/api/libraries', async (req, res) => json(res, 200, store.data.libraries.map(librarySummary)));

route('POST', '/api/libraries', async (req, res) => {
  const input = validateLibraryInput(await readBody(req));
  const library = { id: randomId(), ...input, createdAt: Date.now() };
  store.data.libraries.push(library);
  store.save();
  scanner.enqueue(library.id);
  json(res, 201, librarySummary(library));
});

route('PATCH', '/api/libraries/:id', async (req, res, { id }) => {
  const library = getLibrary(id);
  const input = validateLibraryInput(await readBody(req), true);
  if (input.type && input.type !== library.type) removeLibraryData(library.id);
  Object.assign(library, input);
  store.save();
  if (input.paths || input.type) scanner.enqueue(library.id);
  json(res, 200, librarySummary(library));
});

route('DELETE', '/api/libraries/:id', async (req, res, { id }) => {
  getLibrary(id);
  removeLibraryData(id);
  store.data.libraries = store.data.libraries.filter((l) => l.id !== id);
  store.save();
  json(res, 200, { ok: true });
});

route('POST', '/api/libraries/:id/scan', async (req, res, { id }) => {
  getLibrary(id);
  const body = await readBody(req);
  scanner.enqueue(id, { refreshMeta: !!body.refreshMetadata });
  json(res, 202, scanner.status());
});

route('POST', '/api/scan', async (req, res) => { scanner.enqueueAll(); json(res, 202, scanner.status()); });

route('GET', '/api/libraries/:id/items', async (req, res, { id }) => {
  const library = getLibrary(id);
  json(res, 200, { library: librarySummary(library), items: lib.libraryContents(store, library) });
});

route('GET', '/api/home', async (req, res) => json(res, 200, lib.home(store)));

route('GET', '/api/search', async (req, res, p, url) => json(res, 200, lib.search(store, url.searchParams.get('q') || '')));

route('GET', '/api/shows/:id', async (req, res, { id }) => json(res, 200, lib.showDetail(store, getShow(id))));

route('POST', '/api/shows/:id/watched', async (req, res, { id }) => {
  const body = await readBody(req);
  const show = getShow(id);
  let eps = lib.episodesOf(store, show.id);
  if (body.season !== undefined) eps = eps.filter((e) => (e.season ?? null) === body.season);
  lib.setWatched(store, eps.map((e) => e.id), body.watched !== false);
  json(res, 200, lib.showDetail(store, show));
});

route('GET', '/api/items/:id', async (req, res, { id }) => json(res, 200, lib.itemDetail(store, getItem(id))));

route('POST', '/api/items/:id/progress', async (req, res, { id }) => {
  const item = getItem(id);
  const body = await readBody(req);
  const position = Number(body.position);
  if (!Number.isFinite(position)) throw new HttpError(400, 'position (seconds) required');
  json(res, 200, lib.setProgress(store, item, position));
});

route('POST', '/api/items/:id/watched', async (req, res, { id }) => {
  const item = getItem(id);
  const body = await readBody(req);
  lib.setWatched(store, [item.id], body.watched !== false);
  json(res, 200, lib.itemSummary(store, item));
});

route('GET', '/api/items/:id/stream', async (req, res, { id }, url) => {
  const item = getItem(id);
  const headers = url.searchParams.has('download')
    ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(item.file))}` } : {};
  sendFile(req, res, item.file, { type: url.searchParams.has('download') ? 'application/octet-stream' : media.mimeFor(item.file), headers });
});

route('GET', '/api/items/:id/seekpoint', async (req, res, { id }, url) => {
  const item = getItem(id);
  const t = Math.max(0, Number(url.searchParams.get('t')) || 0);
  // Request the transcode with `t`; the stream's first frame will be at `start` (<= t).
  json(res, 200, { t, start: await media.seekPoint(item, t) });
});

route('GET', '/api/items/:id/transcode', async (req, res, { id }, url) => {
  const item = getItem(id);
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

route('GET', '/api/items/:id/subtitles/:sub', async (req, res, { id, sub }, url) => {
  const item = getItem(id);
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const vtt = subs.shiftVtt(await subtitleVtt(item, sub), offset);
  res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(vtt);
});

route('GET', '/api/art/:kind/:id', async (req, res, { kind, id }) => {
  if (!['poster', 'backdrop', 'thumb'].includes(kind)) throw new HttpError(404, 'Unknown art kind');
  const file = await resolveArt(kind, id);
  if (!file) throw new HttpError(404, 'No artwork');
  sendFile(req, res, file, { headers: { 'Cache-Control': 'private, max-age=3600' } });
});

// Folder picker for adding libraries.
route('GET', '/api/fs', async (req, res, p, url) => {
  const dir = path.resolve(url.searchParams.get('path') || os.homedir());
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { throw new HttpError(400, `Cannot read ${dir}: ${err.code}`); }
  const dirs = entries.filter((e) => !e.name.startsWith('.') && (e.isDirectory() || (e.isSymbolicLink() && (() => {
    try { return fs.statSync(path.join(dir, e.name)).isDirectory(); } catch { return false; }
  })()))).map((e) => e.name).sort((a, b) => a.localeCompare(b));
  const parent = path.dirname(dir);
  json(res, 200, { path: dir, parent: parent === dir ? null : parent, dirs, home: os.homedir() });
});

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
        if (m) {
          const params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
          return await r.handler(req, res, params, url);
        }
      }
      throw new HttpError(404, 'Not found');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(`[http] ${req.method} ${url.pathname}:`, err);
    if (!res.headersSent) json(res, status, { error: err.message || 'Internal error' });
    else res.destroy();
  }
});

async function main() {
  if (!(await media.checkFfmpeg())) {
    console.error('ffprobe/ffmpeg not found. Install ffmpeg (or set FFMPEG_PATH / FFPROBE_PATH).');
    process.exit(1);
  }
  server.listen(PORT, HOST, () => {
    console.log(`Marquee is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`Data directory: ${DATA_DIR}${metadata.enabled() ? ' · TMDB metadata enabled' : ''}`);
  });
  scanner.enqueueAll();
  if (SCAN_INTERVAL_MIN > 0) setInterval(() => scanner.enqueueAll(), SCAN_INTERVAL_MIN * 60_000).unref();
}

function shutdown() {
  for (const p of transcodes) p.kill('SIGKILL');
  store.flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();
