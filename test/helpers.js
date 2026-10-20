'use strict';
// Shared helpers for integration tests that boot a real server.

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function clip(file, seconds = 1) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=160x120:rate=10:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
}

async function startServer(env) {
  const port = 40000 + Math.floor(Math.random() * 10000);
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, TMDB_API_KEY: '', TMDB_TOKEN: '', YTDLP_PATH: '/nonexistent', SCAN_INTERVAL: '0',
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', ...env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', process.env.DEBUG ? 'inherit' : 'ignore', process.env.DEBUG ? 'inherit' : 'ignore'],
  });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // (Resolves at once for a server that has already exited; one that ignores SIGTERM is killed after
  // 15 s, with a warning, since a real server must stop when Docker asks it to.)
  const stop = () => new Promise((r) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return r();
    const t = setTimeout(() => { console.error(`[helpers] server on port ${port} ignored SIGTERM; killing it`); proc.kill('SIGKILL'); }, 15_000);
    proc.once('exit', () => { clearTimeout(t); r(); });
    proc.kill('SIGTERM');
  });
  return { base, stop, client: () => client(base) };
}

// Cookie-aware JSON client. call(method, url, body, {raw, type}) — raw sends bytes instead of JSON.
function client(base) {
  let cookie = '';
  return async function call(method, url, body, { raw, type } = {}) {
    const headers = { ...(cookie ? { cookie } : {}) };
    if (raw) headers['content-type'] = type;
    else if (body) headers['content-type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: raw || (body ? JSON.stringify(body) : undefined) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data };
  };
}

async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 150));
  }
}

module.exports = { clip, startServer, client, until };
