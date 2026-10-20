'use strict';
/* Marquee web client — the shared basics every other file uses: html templates, api(), formatting,
   icons, toasts and the player preferences. Loaded first. */

// ---------- tiny templating (auto-escapes interpolations) ----------
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const renderVal = (v) => (v == null || v === false ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(renderVal).join('') : esc(v));
function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += renderVal(v) + strings[i + 1]; });
  return raw(out);
}
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- api ----------
async function api(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  // Reset by an admin while this page was open: choose a new password first.
  if (res.status === 403 && data?.mustChangePassword && state.user && !$('.modal-backdrop form[aria-label="Choose your own password"]')) {
    state.user.mustChangePassword = true;
    showChoosePassword();
  }
  if (res.status === 401 && state.user) showAuth({ setupRequired: data?.setupRequired, message: 'Your session has ended. Please sign in again.' });
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

// ---------- formatting ----------
function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtDuration(sec) {
  if (!sec) return '';
  const m = Math.round(sec / 60);
  if (m < 1) return `${Math.round(sec)} sec`;
  return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60 ? `${m % 60} min` : ''}`.trim() : `${m} min`;
}
function fmtSize(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}
const fmtDate = (t) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Never');
const fmtTime = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
// "about 12 min left" (a conversion's time to go)
const fmtEta = (sec) => (sec < 60 ? 'less than a minute left' : `about ${fmtDuration(sec)} left`);
function resLabel(v) {
  if (!v?.height) return null;
  const h = Math.max(v.height, v.width * 9 / 16);
  return h >= 2000 ? '4K' : h >= 1400 ? '1440p' : h >= 1000 ? '1080p' : h >= 700 ? '720p' : 'SD';
}
function epLabel(x) {
  if (x.season == null && x.episode == null) return '';
  const s = x.season != null ? `S${x.season}` : '';
  const e = x.episode != null ? `E${x.episode}${x.episodeEnd ? `–E${x.episodeEnd}` : ''}` : '';
  return [s, e].filter(Boolean).join(' · ') + (x.absoluteNumber ? ` (#${x.absoluteNumber})` : '');
}
const sortTitle = (t) => String(t || '').toLowerCase().replace(/^(the|a|an)\s+/, '');
// "1 hr 14 min left" / "9 min left"
const fmtLeft = (x) => (x.progress?.position && !x.progress.watched && x.duration ? `${fmtDuration(Math.max(60, x.duration - x.progress.position))} left` : '');

// ---------- icons (inline, drawn with the text colour) ----------
const ICONS = {
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  info: '<circle cx="12" cy="12" r="9.5"/><path d="M12 11v6M12 7.5v.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  dots: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
  left: '<path d="M15 5l-7 7 7 7"/>',
  right: '<path d="M9 5l7 7-7 7"/>',
  mute: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l4 6M21 9l-4 6"/>',
  sound: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 8.5a5 5 0 010 7M19.5 6a8.5 8.5 0 010 12"/>',
  home: '<path d="M12 3l9 8h-3v9h-5v-6h-2v6H6v-9H3z" fill="currentColor" stroke="none"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  stack: '<rect x="3" y="7" width="14" height="13" rx="1.5"/><path d="M7 4h13a1 1 0 011 1v12"/>',
  link: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  up: '<path d="M7 11v9H4v-9zM7 11l4-8a2 2 0 012.6 2.4L12.5 9H18a2 2 0 012 2.3l-1.2 7A2 2 0 0116.8 20H7"/>',
  down: '<path d="M7 13V4H4v9zM7 13l4 8a2 2 0 002.6-2.4L12.5 15H18a2 2 0 002-2.3l-1.2-7A2 2 0 0016.8 4H7"/>',
};
const icon = (name) => raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`);
// A steady colour per person for avatars and profile squares.
const AVATAR_COLORS = ['#2f6fb3', '#b3402f', '#7a4fb3', '#2f8a5c', '#b3862f', '#2f9bb3', '#b32f7a', '#5c6b2f'];
const avatarColor = (name) => AVATAR_COLORS[[...String(name || '')].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATAR_COLORS.length];
const pct = (p, d) => (d ? Math.min(100, Math.max(0, (p / d) * 100)) : 0);

// ---------- ui helpers ----------
function toast(msg, error = false) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.textContent = msg;
  const root = $('#toast-root');
  root.append(el);
  while (root.children.length > 2) root.firstElementChild.remove();
  setTimeout(() => el.remove(), 3500);
}
// Image fallback: swap broken artwork for a text placeholder.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName !== 'IMG' || !img.closest('.art, .poster')) return;
  const ph = document.createElement('div');
  ph.className = 'ph';
  ph.textContent = img.alt || '';
  img.replaceWith(ph);
}, true);

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(`marquee:${k}`)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`marquee:${k}`, JSON.stringify(v)); } catch { /* ignore */ } },
};
// Player settings saved with your account (Account → Player), so TVs and phones follow them too.
const PLAYER_DEFAULTS = { autoplayNext: true, autoSkipIntro: false, skipFade: 10, nightMode: false, subLang: '', audioLang: '', subSize: 'medium', subStyle: 'box' };
// Languages offered for "subtitles / sound in…" (Account), and the other codes files label them with.
const LANG_CHOICES = [['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'],
  ['nl', 'Dutch'], ['sv', 'Swedish'], ['pl', 'Polish'], ['ru', 'Russian'], ['tr', 'Turkish'], ['ar', 'Arabic'], ['hi', 'Hindi'],
  ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese']];
const LANG_ALIASES = { en: ['eng'], es: ['spa'], fr: ['fre', 'fra'], de: ['ger', 'deu'], it: ['ita'], pt: ['por'], nl: ['dut', 'nld'], sv: ['swe'],
  pl: ['pol'], ru: ['rus'], tr: ['tur'], ar: ['ara'], hi: ['hin'], ja: ['jpn'], ko: ['kor'], zh: ['chi', 'zho'] };
/** Whether a track's language ("eng", "en-US"…) is `code` ("en"). */
function sameLang(lang, code) {
  const l = String(lang || '').toLowerCase().split(/[-_]/)[0];
  return !!l && !!code && (l === code || (LANG_ALIASES[code] || []).includes(l));
}
function playerPref(k) { return state.user?.prefs?.[k] ?? PLAYER_DEFAULTS[k]; }
async function savePlayerPrefs(change) {
  const r = await api('/api/auth/prefs', { method: 'PUT', body: change });
  if (state.user) { state.user.prefs = r.prefs; state.user.prefsSaved = true; }
}
