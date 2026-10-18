'use strict';
// Subtitle downloads from OpenSubtitles.com (REST API v1). Needs a free API key ("consumer"), set by
// an admin in Settings → Metadata. Signing in with an OpenSubtitles account is optional and raises
// the daily download limit. Results that match the file's hash (same video file) are listed first.

const fs = require('node:fs');
const path = require('node:path');

const API = process.env.OPENSUBTITLES_API_BASE || 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = `Marquee v${require('../package.json').version}`;
const httpError = (status, msg) => Object.assign(new Error(msg), { status });

// OpenSubtitles' file hash: size + the sum of the first and last 64 KiB as 64-bit little-endian words.
async function fileHash(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const CHUNK = 65536;
    if (size < CHUNK * 2) return null;
    let sum = BigInt(size);
    for (const pos of [0, size - CHUNK]) {
      const buf = Buffer.alloc(CHUNK);
      await fh.read(buf, 0, CHUNK, pos);
      for (let i = 0; i < CHUNK; i += 8) sum += buf.readBigUInt64LE(i);
    }
    return (sum & 0xffffffffffffffffn).toString(16).padStart(16, '0');
  } finally { await fh.close(); }
}

class OpenSubtitles {
  constructor(getSettings) {
    this.settings = () => getSettings().opensubtitles || {};
    this.token = null; // { value, base, user, until }
  }

  configured() { return !!this.settings().apiKey; }

  async call(method, pathname, { query, body, auth = false, base = API } = {}) {
    const st = this.settings();
    if (!st.apiKey) throw httpError(400, 'Add an OpenSubtitles API key in Settings → Metadata first');
    const url = new URL(base + pathname);
    // The API asks for parameters sorted and lower-case (otherwise it redirects).
    for (const [k, v] of Object.entries(query || {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (v != null && v !== '') url.searchParams.set(k, String(v).toLowerCase());
    }
    const headers = { 'Api-Key': st.apiKey, 'User-Agent': USER_AGENT, Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (auth) { const t = await this.login(); if (t) headers.Authorization = `Bearer ${t.value}`; }
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.message || data.errors?.[0] || `HTTP ${res.status}`;
      throw httpError(res.status === 401 || res.status === 403 ? 400 : 502, `OpenSubtitles: ${msg}`);
    }
    return data;
  }

  // Sign in when an account is set (cached for a day); returns null without one.
  async login() {
    const st = this.settings();
    if (!st.username || !st.password) return null;
    if (this.token && this.token.user === st.username && this.token.until > Date.now()) return this.token;
    const r = await this.call('POST', '/login', { body: { username: st.username, password: st.password } });
    this.token = { value: r.token, base: r.base_url ? `https://${r.base_url}/api/v1` : API, user: st.username, until: Date.now() + 23 * 3600_000 };
    return this.token;
  }

  // Check the key (and account, if set) before saving them.
  async test() {
    await this.call('GET', '/infos/formats');
    if (this.settings().username) { this.token = null; await this.login(); }
  }

  /** `target`: the item; `show`: its show for episodes; `languages`: e.g. "en" or "en,fr". */
  async search(target, show, languages) {
    const query = { languages };
    const hash = await fileHash(target.file).catch(() => null);
    if (hash) query.moviehash = hash;
    if (target.type === 'episode') {
      Object.assign(query, { type: 'episode', season_number: target.season, episode_number: target.episode });
      if (show?.meta?.provider === 'tmdb') query.parent_tmdb_id = show.meta.providerId;
      else query.query = show?.edits?.title || show?.meta?.title || target.showTitle;
    } else {
      query.type = 'movie';
      if (target.meta?.provider === 'tmdb') query.tmdb_id = target.meta.providerId;
      else Object.assign(query, { query: target.edits?.title || target.meta?.title || target.title, year: target.year || undefined });
    }
    const r = await this.call('GET', '/subtitles', { query });
    return (r.data || []).flatMap((d) => {
      const a = d.attributes || {};
      const f = a.files?.[0];
      return f ? [{
        fileId: f.file_id, language: a.language, release: a.release || f.file_name || '', downloads: a.download_count || 0,
        hashMatch: !!a.moviehash_match, hearingImpaired: !!a.hearing_impaired, machineTranslated: !!a.machine_translated,
      }] : [];
    }).sort((x, y) => y.hashMatch - x.hashMatch || y.downloads - x.downloads).slice(0, 40);
  }

  // Downloads one subtitle file as SRT text.
  async download(fileId) {
    const t = await this.login().catch(() => null);
    const r = await this.call('POST', '/download', { body: { file_id: Number(fileId), sub_format: 'srt' }, auth: !!t, base: t?.base || API });
    if (!r.link) throw httpError(502, `OpenSubtitles: ${r.message || 'no download link'}`);
    const res = await fetch(r.link, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw httpError(502, `OpenSubtitles download failed (HTTP ${res.status})`);
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
    if (!/-->/.test(text)) throw httpError(502, 'OpenSubtitles sent something that is not a subtitle file');
    return { text, remaining: r.remaining ?? null };
  }
}

module.exports = { OpenSubtitles, fileHash };
