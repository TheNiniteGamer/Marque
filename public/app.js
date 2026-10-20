'use strict';
/* Marquee web client — vanilla JS single page app. */

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

// ---------- app state ----------
const state = { user: null, libraries: [], status: null, inAppNav: false };
let renderSeq = 0;
const view = $('#view');
// Where the current page is drawn: the page itself, or the "More info" pop-up for movies, shows and episodes.
let viewEl = view;
function setView(seq, content) {
  if (seq !== renderSeq) return false;
  viewEl.innerHTML = renderVal(content);
  return true;
}

async function refreshLibraries() {
  state.libraries = await api('/api/libraries');
  renderSidebar();
}

// Top bar: Home, each library, Collections, My List. On phones the libraries become a row of
// buttons and Home / Search / My List sit in a bar at the bottom.
function renderNav() {
  const { path } = parseHash();
  const on = (test) => (test ? 'active' : '');
  $('#nav-links').innerHTML = html`
    <a href="#/" class="desk-only ${on(path === '/')}">Home</a>
    ${state.libraries.map((l) => html`<a href="#/library/${l.id}" class="${on(path === `/library/${l.id}`)}">${l.name}</a>`)}
    ${state.libraries.length ? html`<a href="#/collections" class="${on(path.startsWith('/collection'))}">Collections</a>` : ''}
    <a href="#/watchlist" class="desk-only ${on(path === '/watchlist')}">My List</a>
    ${!state.libraries.length && state.user?.role === 'admin' ? html`<a href="#/settings/libraries?add=1">＋ Add a library</a>` : ''}`.s;
  $('#tabbar').innerHTML = html`
    <a href="#/" class="${on(path === '/')}">${icon('home')}Home</a>
    <button type="button" data-tab="search">${icon('search')}Search</button>
    <a href="#/watchlist" class="${on(path === '/watchlist')}">${icon('plus')}My List</a>
    ${phoneDownloads() ? html`<button type="button" data-phone-downloads>${icon('download')}Downloads</button>`
      : state.user?.canDownload ? html`<a href="#/downloads" class="${on(path === '/downloads')}">${icon('download')}Downloads</a>`
      : html`<a href="#/collections" class="${on(path.startsWith('/collection'))}">${icon('stack')}Collections</a>`}`.s;
  if (state.status) { noteUpdateAvailable(state.status); noteDownloads(state.status.myDownloads); }
}
const renderSidebar = renderNav;

// The search box opens from the magnifier (or "/", or Search in the phone bar).
function openSearch() { $('#search-form').classList.add('open'); $('#search-input').focus(); }
$('#search-btn').addEventListener('click', openSearch);
$('#search-input').addEventListener('blur', () => { if (!$('#search-input').value) $('#search-form').classList.remove('open'); });
document.addEventListener('click', (e) => { if (e.target.closest('[data-tab="search"]')) openSearch(); });
document.addEventListener('click', (e) => { const b = e.target.closest('[data-ask]'); if (b) openRequestDialog(b.dataset.ask); });
// The phone app keeps downloads for watching offline (its own Downloads screen).
function phoneDownloads() { return !!window.MarqueeAndroid?.offlineDownloads?.(); }
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-phone-downloads]')) window.MarqueeAndroid.openDownloads();
  const d = e.target.closest('[data-offline]');
  if (d) window.MarqueeAndroid.download(d.dataset.offline);
});
// Voice search: the Android TV app listens (the mic button, the remote's search key, or "Hey Google,
// search Marquee for…") and hands back what was said.
const voiceSearch = () => window.MarqueeAndroid?.voiceSearch?.();
$('#voice-btn').hidden = !(tv.on && window.MarqueeAndroid?.voiceSearch);
$('#voice-btn').addEventListener('click', voiceSearch);
document.addEventListener('click', (e) => { if (e.target.closest('[data-voice]')) voiceSearch(); });
window.marqueeVoiceResult = (text) => {
  const q = String(text || '').trim();
  if (q) location.hash = `#/search?q=${encodeURIComponent(q)}`;
};
// The bar is see-through over the banner and turns solid once the page scrolls.
window.addEventListener('scroll', () => document.body.classList.toggle('scrolled', window.scrollY > 10), { passive: true });

// ---------- scan status polling ----------
let pollTimer;
async function pollStatus() {
  clearTimeout(pollTimer);
  if (!state.user) return;
  try {
    const prev = state.status;
    state.status = await api('/api/status');
    const s = state.status;
    noteUpdateAvailable(s);
    noteDownloads(s.myDownloads);
    noteRequests(s.requestsPending);
    refreshBell();
    const ind = $('#scan-indicator');
    ind.hidden = !s.scanning;
    if (s.scanning && s.current) {
      const phase = s.current.phase === 'metadata' ? 'Fetching metadata' : 'Scanning';
      ind.textContent = `${phase} ${s.current.name}${s.current.total ? ` (${s.current.done}/${s.current.total})` : ''}`;
    }
    const before = state.libraries.reduce((n, l) => n + l.count, 0);
    if (s.scanning || prev?.scanning) await refreshLibraries();
    const after = state.libraries.reduce((n, l) => n + l.count, 0);
    const finished = prev?.scanning && !s.scanning;
    if (s.scanning && !prev?.scanning) state.scanBaseline = before;
    if (finished && state.scanBaseline != null) {
      const added = after - state.scanBaseline;
      toast(added > 0 ? `Scan complete — ${added} new title${added === 1 ? '' : 's'} added` : 'Library scan complete');
      state.scanBaseline = null;
    }
    const { path } = parseHash();
    if ((finished || after !== before) && !player && (path === '/' || path.startsWith('/library/') || path === '/settings')) router();
  } catch { /* server unreachable; try again later */ }
  pollTimer = setTimeout(pollStatus, state.status?.scanning ? 2000 : 15000);
}

// Admins: how many requests are waiting, on the Requests link.
function noteRequests(n) {
  for (const link of $$('#user-pop a[href="#/requests"]')) {
    link.querySelector('.count')?.remove();
    if (n) link.insertAdjacentHTML('beforeend', html`<span class="count" title="Requests waiting">${n}</span>`.s);
  }
}

// A notice when one of your downloads finishes (or gives up), and a count on the Downloads link.
function noteDownloads(d) {
  if (!d) return;
  for (const link of $$('#user-pop a[href="#/downloads"], #tabbar a[href="#/downloads"]')) {
    link.querySelector('.count')?.remove();
    if (d.active) link.insertAdjacentHTML('beforeend', html`<span class="count" title="Downloads in progress">${d.active}</span>`.s);
  }
  const seen = store.get('downloadsSeen', 0);
  // First time on this device: start from now rather than announcing old downloads.
  if (!seen) { store.set('downloadsSeen', Math.max(Date.now(), ...d.finished.map((j) => j.finishedAt))); return; }
  const fresh = d.finished.filter((j) => j.finishedAt > seen);
  if (fresh.length) store.set('downloadsSeen', Math.max(...fresh.map((j) => j.finishedAt)));
  for (const j of fresh.slice(0, 3)) {
    toast(j.status === 'done' ? (j.files ? `Downloaded: ${j.title}` : `Already downloaded: ${j.title}`) : `Download failed: ${j.title}`, j.status !== 'done');
  }
  if (fresh.length && parseHash().path === '/downloads') router();
}

// Pictures that fail to load (e.g. an actor's photo) are taken away, showing what's behind them.
// (One listener instead of inline onerror handlers, which the Content-Security-Policy doesn't allow.)
document.addEventListener('error', (e) => { if (e.target instanceof HTMLImageElement && e.target.hasAttribute('data-hide-broken')) e.target.remove(); }, true);

// ---------- cards ----------
function progressBar(x) {
  if (!x.progress || x.progress.watched || !x.progress.position) return '';
  return html`<div class="progress"><i style="width:${pct(x.progress.position, x.duration).toFixed(1)}%"></i></div>`;
}
function hrefFor(x) { return x.type === 'show' ? `#/show/${x.id}` : `#/item/${x.id}`; }

// "NEW" / "NEW EPISODES" on titles added in the last week (not for a library's first scan).
const NEW_MS = 7 * 86400_000;
function ribbonFor(x) {
  const lib = state.libraries.find((l) => l.id === x.libraryId);
  const since = (t) => t && Date.now() - t < NEW_MS && (!lib?.createdAt || t - lib.createdAt > 86400_000);
  if (since(x.addedAt)) return 'NEW';
  if (x.type === 'show' && since(x.lastAddedAt)) return 'NEW EPISODES';
  return '';
}

// Wide card with the title on the artwork (rows and grids). ctx: where it is shown (for its ⋯ menu).
function posterCard(x, ctx = '') {
  if (x.type === 'collection') return collectionCard(x);
  const sub = x.type === 'show'
    ? (x.seasonCount > 1 ? `${x.seasonCount} seasons` : `${x.episodeCount} episode${x.episodeCount === 1 ? '' : 's'}`) + (x.year ? ` · ${x.year}` : '')
    : x.type === 'episode' ? `${epLabel(x)} · ${x.title}` : [x.year, fmtDuration(x.duration)].filter(Boolean).join(' · ');
  let badge = '';
  if (x.type === 'show' && x.unwatchedCount > 0 && x.unwatchedCount < x.episodeCount) badge = html`<span class="badge" title="Unwatched episodes">${x.unwatchedCount}</span>`;
  else if ((x.type === 'show' && x.episodeCount && !x.unwatchedCount) || x.progress?.watched) badge = html`<span class="badge check" title="Watched">✓</span>`;
  const ribbon = ribbonFor(x);
  const title = x.type === 'episode' ? x.showTitle : x.title;
  knownItems.set(x.id, x);
  return html`
    <div class="card" data-sel="${x.id}">
      <div class="art ${ribbon ? 'has-ribbon' : ''}">
        <a class="cover" href="${hrefFor(x)}" aria-label="${title}"><img loading="lazy" src="${artUrl(x.type === 'episode' ? 'thumb' : 'backdrop', x)}" alt=""></a>
        <i class="scrim"></i><span class="art-title">${title}</span>
        ${ribbon ? html`<span class="ribbon">${ribbon}</span>` : ''}${badge}${progressBar(x)}
        <button class="play-hover" data-play="${x.type === 'show' ? `show:${x.id}` : x.id}" aria-label="Play ${title}">▶</button>
        <button class="card-menu" data-menu="${x.id}" data-ctx="${ctx}" aria-label="More options for ${title}" title="More">⋯</button>
      </div>
      <a class="card-text" href="${hrefFor(x)}" tabindex="-1"><span class="sub" title="${sub}">${sub}</span></a>
    </div>`;
}

// Continue Watching: the episode or film, where you are in it, and the time left.
function wideCard(x, ctx = '') {
  knownItems.set(x.id, x);
  const isEp = x.type === 'episode';
  const title = isEp ? x.showTitle : x.title;
  const sub = isEp ? [epLabel(x).replace(' · ', ':'), x.title].filter(Boolean).join(' · ') : (x.year || '');
  return html`
    <div class="card cw" data-sel="${x.id}">
      <div class="art">
        <a class="cover" href="${hrefFor(x)}" aria-label="${title}"><img loading="lazy" src="${artUrl(isEp ? 'thumb' : 'backdrop', x)}" alt=""></a>
        <i class="scrim"></i><span class="art-title">${title}</span>
        ${x.progress?.watched ? html`<span class="badge check">✓</span>` : ''}${progressBar(x)}
        <button class="play-hover" data-play="${x.id}" aria-label="Play ${title}">▶</button>
        <button class="card-menu" data-menu="${x.id}" data-ctx="${ctx}" aria-label="More options" title="More">⋯</button>
      </div>
      <a class="card-text" href="${hrefFor(x)}" tabindex="-1"><span class="sub" title="${sub}">${sub}</span><span class="left">${fmtLeft(x)}</span></a>
    </div>`;
}

// "Coming soon": a show's next episode (its artwork) or a film on its way (Radarr's picture), with when.
function soonDate(iso) {
  const d = new Date(iso);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date())) / 86400_000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
function upcomingCard(x) {
  const ep = x.kind === 'episode';
  const img = ep ? artUrl('backdrop', { id: x.showId, artV: x.artV }) : x.image;
  const sub = ep ? [`S${x.season}:E${x.episode}`, x.episodeTitle].filter(Boolean).join(' · ') : [x.release, x.year].filter(Boolean).join(' · ');
  return html`
    <div class="card soon">
      <div class="art"><a class="cover" href="${x.href}" aria-label="${x.title}">${img ? html`<img loading="lazy" src="${img}" alt="">` : html`<div class="collection-empty">🎬</div>`}</a>
        <i class="scrim"></i><span class="art-title">${x.title}</span><span class="soon-date">${soonDate(x.airDate)}</span></div>
      <a class="card-text" href="${x.href}" tabindex="-1"><span class="sub" title="${sub}">${sub}</span></a>
    </div>`;
}

// A row that scrolls sideways, with arrows on hover.
function rail(items, render) {
  return html`<div class="rail">
    <button class="rail-btn prev off" data-rail="-1" tabindex="-1" aria-label="Scroll left">${icon('left')}</button>
    <div class="shelf">${items.map(render)}</div>
    <button class="rail-btn next" data-rail="1" tabindex="-1" aria-label="Scroll right">${icon('right')}</button>
  </div>`;
}
function updateRail(shelf) {
  const r = shelf.parentElement;
  r.querySelector('.prev')?.classList.toggle('off', shelf.scrollLeft <= 2);
  r.querySelector('.next')?.classList.toggle('off', shelf.scrollLeft >= shelf.scrollWidth - shelf.clientWidth - 2);
}
const updateRails = () => $$('.shelf').forEach(updateRail);
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-rail]');
  if (!b) return;
  const shelf = b.parentElement.querySelector('.shelf');
  shelf.scrollBy({ left: Number(b.dataset.rail) * shelf.clientWidth * 0.85, behavior: 'smooth' });
});
document.addEventListener('scroll', (e) => { if (e.target.classList?.contains('shelf')) updateRail(e.target); }, true);
window.addEventListener('resize', updateRails);

// ---------- hover previews ----------
// Resting the mouse on a card for a moment grows it into a panel: play, My List, watched, more info,
// and the trailer playing quietly when there is one. Computers with a mouse only (not TV mode).
let previewTimer = null, previewEl = null, previewCard = null;
const canPreview = () => matchMedia('(hover: hover) and (pointer: fine)').matches && !tv.on && !document.body.classList.contains('selecting');
function closePreview() {
  clearTimeout(previewTimer);
  const el = previewEl;
  previewEl = null; previewCard = null;
  if (!el) return;
  el.querySelector('video')?.pause();
  el.classList.remove('open');
  setTimeout(() => el.remove(), 200);
}
function showPreview(card) {
  const x = knownItems.get(card.dataset.sel);
  if (!x || x.type === 'collection' || x.kind || !document.contains(card)) return;
  closePreview();
  const art = card.querySelector('.art').getBoundingClientRect();
  const w = Math.min(art.width * 1.5, window.innerWidth - 24);
  const left = Math.max(12, Math.min(art.left + art.width / 2 - w / 2, window.innerWidth - w - 12));
  const top = Math.max(window.scrollY + 8, art.top + window.scrollY - art.height * 0.25);
  const isShow = x.type === 'show', isEp = x.type === 'episode';
  const watched = isShow ? x.episodeCount > 0 && !x.unwatchedCount : !!x.progress?.watched;
  const title = isEp ? x.showTitle : x.title;
  const ribbon = ribbonFor(x);
  const clip = previewSrc(x);
  const el = document.createElement('div');
  el.className = 'hover-preview';
  el.style.cssText = `left:${left}px;top:${top}px;width:${w}px;transform-origin:${((art.left + art.width / 2 - left) / w) * 100}% 30%`;
  el.innerHTML = html`
    <a class="hp-art" href="${hrefFor(x)}" aria-label="${title}"><img src="${artUrl(isEp ? 'thumb' : 'backdrop', x)}" alt="">
      ${clip ? html`<video muted loop playsinline preload="none"></video>` : ''}<span class="art-title">${title}</span></a>
    <div class="hp-body">
      <div class="hp-actions">
        <button class="round white" data-play="${isShow ? `show:${x.id}` : x.id}" aria-label="Play ${title}">${icon('play')}</button>
        ${!isEp ? html`<button class="round" data-hp="list" aria-label="${x.inWatchlist ? 'Remove from My List' : 'Add to My List'}" title="${x.inWatchlist ? 'Remove from My List' : 'Add to My List'}">${icon(x.inWatchlist ? 'check' : 'plus')}</button>` : ''}
        <button class="round" data-hp="watched" aria-label="${watched ? 'Mark unwatched' : 'Mark watched'}" title="${watched ? 'Mark unwatched' : 'Mark watched'}">${watched ? '↺' : icon('check')}</button>
        <a class="round more" href="${hrefFor(x)}" aria-label="More info" title="More info"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></a>
      </div>
      <div class="hp-meta">
        ${ribbon ? html`<span class="new">${ribbon === 'NEW' ? 'New' : 'New episodes'}</span>` : ''}
        ${isEp ? html`<span>${epLabel(x).replace(' · ', ':')} · ${x.title}</span>` : ''}
        ${x.year && !isEp ? html`<span>${x.year}</span>` : ''}
        <span>${isShow ? `${x.seasonCount} season${x.seasonCount === 1 ? '' : 's'}` : fmtDuration(x.duration)}</span>
        ${x.contentRating ? html`<span class="age-badge">${x.contentRating}</span>` : ''}${x.rating ? html`<span>★ ${x.rating}</span>` : ''}
      </div>
      ${fmtLeft(x) ? html`<div class="hp-left">${fmtLeft(x)}</div>` : ''}
      ${x.genres?.length ? html`<div class="hp-genres">${x.genres.slice(0, 3).join(' • ')}</div>` : ''}
    </div>`.s;
  document.body.append(el);
  previewEl = el; previewCard = card;
  requestAnimationFrame(() => el.classList.add('open'));
  el.addEventListener('mouseleave', (e) => { if (!card.contains(e.relatedTarget)) closePreview(); });
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-hp]');
    if (!b) { if (e.target.closest('a, [data-play]')) closePreview(); return; }
    closePreview();
    if (b.dataset.hp === 'list') await toggleWatchlist(x).catch((err) => toast(err.message, true));
    if (b.dataset.hp === 'watched') await setWatchedFor(x, !watched).catch((err) => toast(err.message, true));
  });
  const v = el.querySelector('video');
  if (v && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    setTimeout(() => {
      if (previewEl !== el) return;
      v.src = clip;
      v.play().then(() => v.classList.add('playing')).catch(() => {});
    }, 700);
  }
}
document.addEventListener('mouseover', (e) => {
  if (!canPreview() || e.target.closest('.hover-preview')) return;
  const card = e.target.closest('.shelf .card, .grid .card');
  if (!card) { if (!previewEl) clearTimeout(previewTimer); return; }
  if (card === previewCard) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => showPreview(card), 650);
});
document.addEventListener('mouseout', (e) => {
  const card = e.target.closest('.card');
  if (!card || card.contains(e.relatedTarget)) return;
  if (previewEl && e.relatedTarget && previewEl.contains(e.relatedTarget)) return;
  if (card === previewCard) closePreview(); else clearTimeout(previewTimer);
});
document.addEventListener('scroll', () => { if (previewEl) closePreview(); }, true);

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-play]');
  if (!btn) return;
  e.preventDefault();
  let id = btn.dataset.play;
  if (id.startsWith('show:')) {
    const show = await api(`/api/shows/${id.slice(5)}`).catch(() => null);
    if (!show?.upNext) return toast('Nothing to play');
    id = show.upNext.id;
  }
  const t = btn.dataset.t;
  // A version picked on the film's page (else the player picks the best for this device).
  const v = btn.closest('.dlg-actions')?.querySelector('[data-version]')?.value;
  const q = new URLSearchParams();
  if (t != null) q.set('t', t);
  if (v) q.set('v', v);
  location.hash = `#/play/${id}${q.size ? `?${q}` : ''}`;
});

// What plays behind a title: its trailer, else (when the server makes them) a preview clip from the
// title itself (an episode: its show's). The clip 404s until it's been made, and then nothing plays.
function previewSrc(x) {
  if (x.trailerId) return `/api/items/${x.trailerId}/stream`;
  if (state.status?.previewClips === false) return null;
  if (x.type === 'movie' || x.type === 'show') return `/api/previews/${x.id}`;
  if (x.type === 'episode' && x.showId) return `/api/previews/${x.showId}`;
  return null;
}

// ---------- views ----------
// The banner: a featured title, with its trailer (or a preview clip) playing quietly behind it.
function heroBanner(h) {
  knownItems.set(h.id, h);
  const clip = previewSrc(h);
  const isShow = h.type === 'show';
  const lib = state.libraries.find((l) => l.id === h.libraryId);
  return html`<section class="hero" aria-label="Featured: ${h.title}">
    <div class="hero-art"><img src="${artUrl('backdrop', h)}" alt="">
      ${clip ? html`<video id="hero-video" muted playsinline loop preload="none" data-src="${clip}"></video>` : ''}</div>
    <div class="hero-body">
      <div class="hero-kind"><span class="m-badge" aria-hidden="true">M</span>${isShow ? 'SERIES' : /youtube/i.test(lib?.name || '') ? 'VIDEO' : 'FILM'}</div>
      <h1 class="hero-title${h.title.length > 18 ? ' long' : ''}"><a href="${hrefFor(h)}">${h.title}</a></h1>
      <div class="hero-meta">
        ${h.year ? html`<span>${h.year}</span>` : ''}
        <span>${isShow ? `${h.seasonCount} season${h.seasonCount === 1 ? '' : 's'}` : fmtDuration(h.duration)}</span>
        ${h.contentRating ? html`<span class="age-badge">${h.contentRating}</span>` : ''}${h.rating ? html`<span>★ ${h.rating}</span>` : ''}
        ${h.genres?.length ? html`<span>${h.genres.slice(0, 3).join(' · ')}</span>` : ''}
      </div>
      <p class="hero-overview">${h.overview}</p>
      <div class="hero-actions">
        ${h.play ? html`<button class="btn play" data-play="${h.play.id}" ${h.play.t === 0 ? raw('data-t="0"') : ''}>${icon('play')}${h.play.label}</button>` : ''}
        <a class="btn ghost" href="${hrefFor(h)}">${icon('info')}More info</a>
      </div>
    </div>
    ${clip ? html`<button class="hero-mute" id="hero-mute" aria-label="Turn the sound on" hidden>${icon('mute')}</button>` : ''}
  </section>`;
}
function startHeroTrailer() {
  const v = $('#hero-video');
  if (!v || window.innerWidth < 900 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  setTimeout(() => {
    if (!document.contains(v) || document.body.classList.contains('detail-open') || player) return;
    v.src = v.dataset.src;
    v.play().then(() => { v.classList.add('playing'); $('#hero-mute').hidden = false; }).catch(() => {});
  }, 2500);
  // Only while the banner is on screen.
  new IntersectionObserver(([e]) => { if (!v.src) return; if (e.isIntersecting && !document.body.classList.contains('detail-open')) v.play().catch(() => {}); else v.pause(); }, { threshold: 0.25 }).observe(v);
  $('#hero-mute').onclick = () => {
    v.muted = !v.muted;
    $('#hero-mute').innerHTML = icon(v.muted ? 'mute' : 'sound').s;
    $('#hero-mute').setAttribute('aria-label', v.muted ? 'Turn the sound on' : 'Turn the sound off');
  };
}
const pauseHero = () => $('#hero-video')?.pause();

// Top 10: a big outlined number beside the title, as on the big streamers.
function rankCard(x) {
  return html`<div class="rank-card"><span class="rank-num" aria-hidden="true">${x.rank}</span>${posterCard(x)}</div>`;
}

function hubSection(hub) {
  const link = hub.libraryId ? `#/library/${hub.libraryId}` : hub.link;
  return html`<section class="hub">
    <div class="hub-head"><h2>${hub.title}</h2>${hub.note ? html`<span class="hub-note">${hub.note}</span>` : ''}${link ? html`<a class="see-all" href="${link}">See all ›</a>` : ''}</div>
    ${rail(hub.items, (x) => (hub.style === 'wide' ? wideCard(x, hub.key) : hub.style === 'top10' ? rankCard(x) : hub.style === 'upcoming' ? upcomingCard(x) : posterCard(x)))}
  </section>`;
}

async function viewHome({ seq }) {
  const [homeData, cols] = await Promise.all([api('/api/home'), groupingOn() ? api('/api/collections').catch(() => []) : []]);
  // Recently added titles that belong to a collection show as the collection.
  if (cols.length) for (const hub of homeData.hubs) if (hub.libraryId) hub.items = groupByCollection(hub.items, cols);
  if (!state.libraries.length && state.user.role !== 'admin') {
    return setView(seq, html`<div class="empty"><h2>Welcome, ${state.user.username}</h2><p>No libraries have been shared with you yet. Ask the server's administrator for access.</p></div>`);
  }
  if (!state.libraries.length) {
    return setView(seq, html`<div class="empty"><h2>Welcome to Marquee</h2>
      <p>Point Marquee at the folders where you keep your movies and TV shows,<br>and it will organize them into a browsable library.</p>
      <a class="btn primary" href="#/settings/libraries?add=1">Add a library</a></div>`);
  }
  if (!homeData.hubs.length) {
    return setView(seq, html`<div class="empty"><h2>${state.status?.scanning ? 'Scanning your libraries…' : 'No media found yet'}</h2>
      <p>${state.status?.scanning ? 'New items will appear here as they are found.' : 'Check that your library folders contain video files, then scan again.'}</p>
      <a class="btn" href="#/settings/libraries">Manage libraries</a></div>`);
  }
  if (seq !== renderSeq) return;
  view.classList.toggle('has-hero', !!homeData.hero);
  setView(seq, html`${homeData.hero ? heroBanner(homeData.hero) : ''}${homeData.hubs.map(hubSection)}`);
  updateRails();
  startHeroTrailer();
}

async function viewLibrary({ params: [id], query, seq }) {
  const [data, cols] = await Promise.all([api(`/api/libraries/${id}/items`), api(`/api/collections?library=${id}`).catch(() => [])]);
  const lib = data.library;
  const prefs = { sort: 'title', filter: 'all', ...store.get(`lib:${id}`, {}) };
  prefs.cardW ||= 260; // card width (wide cards; the old poster size setting is not reused)
  // Genre and text filters live in the URL so they survive back/forward and can be linked to.
  let genre = query.get('genre') || '';
  let text = '';
  const titleKey = (x) => sortTitle(x.sortTitle || x.title);
  const sorters = {
    title: (a, b) => titleKey(a).localeCompare(titleKey(b), undefined, { numeric: true }),
    added: (a, b) => (b.lastAddedAt || b.addedAt) - (a.lastAddedAt || a.addedAt),
    year: (a, b) => (b.year || 0) - (a.year || 0),
    rating: (a, b) => (b.rating || 0) - (a.rating || 0),
    duration: (a, b) => (b.duration || 0) - (a.duration || 0),
  };
  const genres = [...new Set(data.items.flatMap((x) => x.genres || []))].sort((a, b) => a.localeCompare(b));
  const unwatched = (x) => (x.type === 'show' ? x.unwatchedCount > 0 : !x.progress?.watched);
  let current = [];
  const render = () => {
    const t = text.trim().toLowerCase();
    const matching = data.items
      .filter((x) => prefs.filter === 'all' || unwatched(x))
      .filter((x) => !genre || (x.genres || []).includes(genre))
      .filter((x) => !t || x.title.toLowerCase().includes(t));
    current = (cols.length && groupingOn() ? groupByCollection(matching, cols) : matching).sort(sorters[prefs.sort] || sorters.title);
    $('#lib-count').textContent = `${current.length}`;
    queueMicrotask(markSelected);
    const grid = $('#lib-grid');
    grid.style.setProperty('--card-w', `${prefs.cardW}px`);
    grid.innerHTML = current.length ? current.map((x) => posterCard(x).s).join('')
      : html`<div class="empty" style="grid-column:1/-1">${data.items.length ? 'Nothing matches these filters.' : state.status?.scanning ? 'Scanning…' : 'This library is empty.'}</div>`.s;
    // A–Z jump bar only makes sense when sorted by title.
    const jump = $('#lib-jump');
    jump.hidden = prefs.sort !== 'title' || current.length < 20;
    if (!jump.hidden) {
      const letters = new Set(current.map((x) => { const c = titleKey(x)[0]?.toUpperCase() || '#'; return /[A-Z]/.test(c) ? c : '#'; }));
      jump.innerHTML = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((c) => html`<button data-letter="${c}" ${letters.has(c) ? '' : 'disabled'}>${c}</button>`.s).join('');
    }
  };
  if (!setView(seq, html`
    <div class="toolbar">
      <h1>${lib.name}<span class="count" id="lib-count"></span></h1>
      <input class="input lib-filter-text" id="lib-text" type="search" placeholder="Filter…" aria-label="Filter by title">
      ${genres.length ? html`<select id="lib-genre" aria-label="Genre"><option value="">All genres</option>${genres.map((g) => html`<option ${g === genre ? 'selected' : ''}>${g}</option>`)}</select>` : ''}
      <div class="seg" id="lib-filter">
        <button data-f="all" class="${prefs.filter === 'all' ? 'on' : ''}">All</button>
        <button data-f="unwatched" class="${prefs.filter === 'unwatched' ? 'on' : ''}">Unwatched</button>
      </div>
      <select id="lib-sort" aria-label="Sort by">
        ${[['title', 'Title'], ['added', 'Date added'], ['year', 'Year'], ['rating', 'Rating'], ...(lib.type === 'movie' ? [['duration', 'Duration']] : [])]
          .map(([k, label]) => html`<option value="${k}" ${prefs.sort === k ? 'selected' : ''}>${label}</option>`)}
      </select>
      <input type="range" id="lib-size" min="180" max="420" step="20" value="${prefs.cardW}" title="Card size" aria-label="Card size">
      <button class="btn small" id="lib-shuffle" title="Play something random from this view">⤮ Shuffle</button>
      ${selectButton()}
      ${cols.length ? html`<div class="seg" id="lib-group" title="Show titles that are in a collection as the collection, or every title on its own">
        <button data-g="1" class="${groupingOn() ? 'on' : ''}">▦ Collections</button><button data-g="0" class="${groupingOn() ? '' : 'on'}">All titles</button></div>
        <a class="btn small" href="#/collections?library=${id}">Browse collections (${cols.length})</a>` : ''}
      ${state.user.role === 'admin' ? html`<button class="btn small" id="lib-scan">↻ Scan</button>` : ''}
    </div>
    ${genre ? html`<div class="filter-note">Showing <b>${genre}</b> · <a href="#/library/${id}">clear</a></div>` : ''}
    <div class="lib-wrap"><div class="grid sized" id="lib-grid"></div><nav class="jump" id="lib-jump" aria-label="Jump to letter" hidden></nav></div>`)) return;
  render();
  bindSelect({ root: () => $('#lib-grid'), kind: 'titles' });
  const save = () => store.set(`lib:${id}`, prefs);
  $('#lib-sort').onchange = (e) => { prefs.sort = e.target.value; save(); render(); };
  $('#lib-size').oninput = (e) => { prefs.cardW = Number(e.target.value); save(); $('#lib-grid').style.setProperty('--card-w', `${prefs.cardW}px`); };
  // Redrawn once typing pauses, not on every key (big libraries have thousands of cards).
  let typing = null;
  $('#lib-text').oninput = (e) => { text = e.target.value; clearTimeout(typing); typing = setTimeout(render, 150); };
  if ($('#lib-genre')) $('#lib-genre').onchange = (e) => { location.hash = e.target.value ? `#/library/${id}?genre=${encodeURIComponent(e.target.value)}` : `#/library/${id}`; };
  $('#lib-filter').onclick = (e) => {
    const f = e.target.dataset.f; if (!f) return;
    prefs.filter = f; save();
    $$('#lib-filter button').forEach((b) => b.classList.toggle('on', b.dataset.f === f));
    render();
  };
  if ($('#lib-group')) $('#lib-group').onclick = (e) => {
    const g = e.target.dataset.g; if (g == null) return;
    store.set('groupCollections', g === '1');
    $$('#lib-group button').forEach((b) => b.classList.toggle('on', b.dataset.g === g));
    render();
  };
  $('#lib-jump').onclick = (e) => {
    const c = e.target.dataset.letter; if (!c) return;
    const idx = current.findIndex((x) => { const f = titleKey(x)[0]?.toUpperCase() || '#'; return c === '#' ? !/[A-Z]/.test(f) : f === c; });
    $$('#lib-grid .card')[idx]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $('#lib-shuffle').onclick = async () => {
    const titles = current.flatMap((x) => (x.type === 'collection' ? x.members : [x]));
    const pool = titles.filter(unwatched).length ? titles.filter(unwatched) : titles;
    if (!pool.length) return toast('Nothing to play', true);
    const pickOne = pool[Math.floor(Math.random() * pool.length)];
    if (pickOne.type !== 'show') { location.hash = `#/play/${pickOne.id}`; return; }
    const show = await api(`/api/shows/${pickOne.id}`);
    const eps = show.seasons.flatMap((x) => x.episodes);
    const fresh = eps.filter((x) => !x.progress?.watched);
    const ep = (fresh.length ? fresh : eps)[Math.floor(Math.random() * (fresh.length || eps.length))];
    if (ep) location.hash = `#/play/${ep.id}?t=0`;
  };
  if ($('#lib-scan')) $('#lib-scan').onclick = async () => { await api(`/api/libraries/${id}/scan`, { method: 'POST' }); toast(`Scanning ${lib.name}…`); pollStatus(); };
}

// ---------- "More info" pop-up: movies, shows, episodes and extras ----------
// Buttons shared by the pop-ups: My List and the ⋯ menu (edit, fix match, collections… for admins).
function listButton(x) {
  if (x.type === 'episode' || x.type === 'extra') return '';
  return html`<button class="round" id="list-toggle" aria-label="${x.inWatchlist ? 'Remove from My List' : 'Add to My List'}" title="${x.inWatchlist ? 'Remove from My List' : 'Add to My List'}">${icon(x.inWatchlist ? 'check' : 'plus')}</button>
    <button class="round thumb ${x.thumb === 1 ? 'on' : ''}" data-thumb="1" aria-pressed="${x.thumb === 1}" aria-label="I like this" title="I like this">${icon('up')}</button>
    <button class="round thumb ${x.thumb === -1 ? 'on' : ''}" data-thumb="-1" aria-pressed="${x.thumb === -1}" aria-label="Not for me" title="Not for me (keeps it out of suggestions)">${icon('down')}</button>`;
}
function dlgTop(x) {
  knownItems.set(x.id, x);
  const prev = detailTrail.at(-1);
  return html`${prev ? html`<button class="dlg-back" id="dlg-back" title="Back to ${prev.title}" aria-label="Back to ${prev.title}">${icon('left')}<span>${prev.title}</span></button>` : ''}
  <div class="dlg-top">
    <button class="round solid" data-menu="${x.id}" aria-label="More options" title="More options">${icon('dots')}</button>
    <button class="round solid" id="dlg-close" aria-label="Close" title="Close">${icon('close')}</button>
  </div>`;
}
function bindDetailActions(x) {
  if ($('#list-toggle')) $('#list-toggle').onclick = () => toggleWatchlist(x).catch((err) => toast(err.message, true));
  // Thumbs up / down: pressing the lit one again clears it.
  for (const b of $$('[data-thumb]', viewEl)) {
    b.onclick = async () => {
      const want = Number(b.dataset.thumb) === x.thumb ? 0 : Number(b.dataset.thumb);
      try {
        x.thumb = (await api(`/api/thumbs/${x.id}`, { method: 'PUT', body: { value: want } })).thumb;
        for (const o of $$('[data-thumb]', viewEl)) { const on = Number(o.dataset.thumb) === x.thumb; o.classList.toggle('on', on); o.setAttribute('aria-pressed', String(on)); }
        toast(x.thumb === 1 ? 'Thanks — more like this' : x.thumb === -1 ? "Got it — we won't suggest this" : 'Rating removed');
      } catch (err) { toast(err.message, true); }
    };
  }
  $('#dlg-close').onclick = closeDetail;
  if ($('#dlg-back')) $('#dlg-back').onclick = detailBack;
}
// Genres, cast, collections and library, on the right of the pop-up.
function sideInfo(x) {
  const lib = state.libraries.find((l) => l.id === x.libraryId);
  const list = (items) => items.map((v, i) => [v, i < items.length - 1 ? ', ' : '']);
  return html`<div class="dlg-side">
    ${x.cast?.length ? html`<div>Cast: <span class="v">${x.cast.slice(0, 5).map((c) => c.name).join(', ')}</span></div>` : ''}
    ${x.genres?.length ? html`<div>Genres: ${list(x.genres.map((g) => html`<a href="#/library/${x.libraryId}?genre=${encodeURIComponent(g)}">${g}</a>`))}</div>` : ''}
    ${x.collections?.some((c) => c.franchise) ? html`<div>Part of: ${list(x.collections.filter((c) => c.franchise).map((c) => html`<a href="#/collection/${c.id}">${c.name}</a>`))}</div>` : ''}
    ${x.collections?.some((c) => !c.franchise) ? html`<div>Collections: ${list(x.collections.filter((c) => !c.franchise).map((c) => html`<a href="#/collection/${c.id}">${c.name}</a>`))}</div>` : ''}
    ${lib ? html`<div>Library: <a href="#/library/${lib.id}">${lib.name}</a></div>` : ''}
  </div>`;
}
function matchNote(x) {
  if (state.user.role !== 'admin' || !x.match) return '';
  const id = x.type === 'episode' ? x.showId : x.id;
  if (x.match.notFound) return html`<p class="match-note">No online match was found. <button class="link-btn" data-fix-match="${id}">Find a match…</button></p>`;
  if (x.match.uncertain) {
    return html`<p class="match-note">Marquee isn't sure this is the right ${x.type === 'movie' ? 'movie' : 'show'}.
      <button class="link-btn" data-review-ok="${id}">✓ It's right</button> · <button class="link-btn" data-fix-match="${id}">Find another…</button></p>`;
  }
  return '';
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-fix-match]');
  if (b) openMatcher(b.dataset.fixMatch).catch((err) => toast(err.message, true));
});
function progressLine(x, label) {
  const p = x.progress;
  if (!p?.position || p.watched || !x.duration) return '';
  return html`<div class="dlg-progress"><div class="bar"><i style="width:${pct(p.position, x.duration).toFixed(1)}%"></i></div><span>${label ? `${label} — ` : ''}${fmtLeft(x)}</span></div>`;
}

// Trailers, featurettes and other extras.
function extrasSection(list) {
  if (!list?.length) return '';
  return html`<section class="dlg-section"><h2 style="margin-bottom:14px">Trailers &amp; extras</h2><div class="similar-grid">${list.map((x) => {
    knownItems.set(x.id, x);
    const sub = [x.title !== x.extraLabel ? x.extraLabel : '', fmtDuration(x.duration)].filter(Boolean).join(' · ');
    return html`<a class="similar-card" href="#/item/${x.id}" data-play="${x.id}" data-t="0">
      <div class="art"><img loading="lazy" src="${artUrl('thumb', x)}" alt=""><span class="art-title">${x.title}</span></div>
      <div class="txt"><span class="m">${sub}</span></div></a>`;
  })}</div></section>`;
}
// The cast, with photos: each opens the person's page (the titles in your library they're in).
function personCard(c) {
  return html`<a class="person-card" href="#/person/${encodeURIComponent(c.name)}">
    <span class="person-photo" style="background:${avatarColor(c.name)}">${c.photo ? html`<img loading="lazy" src="${c.photo}" alt="" data-hide-broken>` : ''}<b>${c.name.slice(0, 1)}</b></span>
    <span class="person-name">${c.name}</span>${c.character ? html`<span class="person-role">${c.character}</span>` : ''}</a>`;
}
function castSection(cast) {
  if (!cast?.length) return '';
  return html`<section class="dlg-section"><h2 style="margin-bottom:14px">Cast</h2><div class="cast-row">${cast.slice(0, 12).map(personCard)}</div></section>`;
}

async function viewPerson({ params: [name], seq }) {
  const p = await api(`/api/people/${name}`);
  document.title = `${p.name} · Marquee`;
  for (const t of p.titles) knownItems.set(t.id, t);
  setView(seq, html`<div class="person-head">
      <span class="person-photo big" style="background:${avatarColor(p.name)}">${p.photo ? html`<img src="${p.photo}" alt="" data-hide-broken>` : ''}<b>${p.name.slice(0, 1)}</b></span>
      <div><h1>${p.name}</h1><p class="muted">${p.titles.length} title${p.titles.length === 1 ? '' : 's'} in your library</p></div></div>
    <div class="grid sized">${p.titles.map((t) => posterCard(t))}</div>`);
}

// The franchise a title is part of ("◆ Marvel Cinematic Universe"), above its name.
function sagaChip(x) {
  return x.franchise ? html`<a class="saga-chip" href="#/collection/${x.franchise.id}">◆ ${x.franchise.name}</a>` : '';
}
// "More from the Marvel Cinematic Universe": the franchise's other titles, in its order.
function franchiseSection(f) {
  if (!f?.items.length) return '';
  return similarSection(f.items.slice(0, 9), html`More from ${f.name} <a class="see-all" href="#/collection/${f.id}">All ${f.count} ›</a>`);
}

// "More like this": other titles sharing genres.
function similarSection(list, heading = 'More like this') {
  if (!list?.length) return '';
  return html`<section class="dlg-section"><h2 class="similar-head" style="margin-bottom:14px">${heading}</h2><div class="similar-grid">${list.map((x) => {
    knownItems.set(x.id, x);
    const m = [x.year, x.type === 'show' ? `${x.seasonCount} season${x.seasonCount === 1 ? '' : 's'}` : fmtDuration(x.duration)].filter(Boolean).join(' · ');
    return html`<a class="similar-card" href="${hrefFor(x)}">
      <div class="art"><img loading="lazy" src="${artUrl('backdrop', x)}" alt=""><span class="art-title">${x.title}</span></div>
      <div class="txt"><span class="m">${m}</span>${x.overview ? html`<span class="o">${x.overview}</span>` : ''}</div></a>`;
  })}</div></section>`;
}

// Admins: where a show's files are on disk, season by season.
function showFilesBox(f) {
  const bySeason = new Map();
  for (const e of f.episodes) {
    const k = e.season ?? -1;
    if (!bySeason.has(k)) bySeason.set(k, []);
    bySeason.get(k).push(e);
  }
  const label = (e) => (e.episode == null ? '' : `E${String(e.episode).padStart(2, '0')}${e.episodeEnd ? `–E${String(e.episodeEnd).padStart(2, '0')}` : ''}`);
  return html`<details class="tech-box"><summary>Files (${f.episodes.length})</summary>
    ${f.folder ? html`<div class="file-path" style="margin:8px 0 12px">📁 <code>${f.folder}</code> <button class="btn small" data-copy="${f.folder}">Copy</button></div>` : ''}
    ${[...bySeason].map(([s, eps]) => html`
      <div class="files-season">${s === -1 ? 'Unsorted' : s === 0 ? 'Specials' : `Season ${s}`}</div>
      ${eps.map((e) => html`<div class="file-row"><a href="#/item/${e.id}">${label(e) || 'Episode'}</a>
        <code title="${e.file}">${e.file.split(/[\\/]/).pop()}</code><span class="muted">${[e.video, e.size ? fmtSize(e.size) : ''].filter(Boolean).join(' · ')}</span>
        <button class="btn small" data-copy="${e.file}" aria-label="Copy the path of ${label(e)}">Copy</button></div>`)}`)}
  </details>`;
}

// "Copy" next to a file path (admins).
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  navigator.clipboard?.writeText(b.dataset.copy).then(() => toast('Path copied'), () => toast(b.dataset.copy));
});

async function viewShow({ params: [id], query, seq }) {
  const show = await api(`/api/shows/${id}`);
  const seasonKey = (s) => String(s.season);
  let current = query.get('season') ?? (show.upNext ? String(show.upNext.season) : show.seasons[0] && seasonKey(show.seasons[0]));
  if (!show.seasons.some((s) => seasonKey(s) === current)) current = show.seasons[0] && seasonKey(show.seasons[0]);
  const up = show.upNext;
  const resuming = up?.progress?.position && !up.progress.watched;
  const upLabel = up ? `${resuming ? 'Resume' : 'Play'} ${epLabel(up).replace(' · ', ':')}` : null;
  document.title = `${show.title} · Marquee`;

  const episodeRow = (e) => { knownItems.set(e.id, e); return html`
    <div class="episode ${up?.id === e.id ? 'current' : ''}">
      <span class="ep-num">${e.episode ?? ''}</span>
      <div class="art">
        <a href="#/item/${e.id}" aria-label="${e.title}"><img loading="lazy" src="${artUrl('thumb', e)}" alt=""></a>
        ${progressBar(e)}
        <button class="play-hover" data-play="${e.id}" aria-label="Play ${e.title}">▶</button>
      </div>
      <a href="#/item/${e.id}">
        <div class="ep-title"><span>${e.title}</span><span class="muted">${fmtDuration(e.duration)}</span></div>
        ${e.overview ? html`<div class="ep-overview">${e.overview}</div>` : ''}
      </a>
      <div class="ep-actions">
        ${phoneDownloads() ? html`<button class="watch-toggle ep-dl" data-offline="${e.id}" title="Download to watch offline" aria-label="Download ${e.title} to watch offline">${icon('download')}</button>` : ''}
        <button class="watch-toggle ${e.progress?.watched ? 'on' : ''}" data-watch="${e.id}" title="${e.progress?.watched ? 'Mark unwatched' : 'Mark watched'}" aria-label="${e.progress?.watched ? 'Mark unwatched' : 'Mark watched'}">✓</button>
        <button class="card-menu static" data-menu="${e.id}" aria-label="More options">⋯</button>
      </div>
    </div>`; };

  const renderSeason = () => {
    const season = show.seasons.find((s) => seasonKey(s) === current);
    const allWatched = season.episodes.every((e) => e.progress?.watched);
    $('#season-watch').textContent = allWatched ? 'Mark season unwatched' : 'Mark season watched';
    $('#season-body').innerHTML = html`<div class="episodes">${season.episodes.map(episodeRow)}</div>`.s;
    $('#season-watch').onclick = async () => {
      await api(`/api/shows/${id}/watched`, { method: 'POST', body: { season: season.season, watched: !allWatched } });
      router();
    };
    if ($('#season-dl')) $('#season-dl').onclick = () => window.MarqueeAndroid.downloadMany(JSON.stringify(season.episodes.map((e) => e.id)));
  };

  const allWatched = show.unwatchedCount === 0;
  if (!setView(seq, html`
    <div class="dlg-hero">
      <img src="${artUrl('backdrop', show)}" alt="">
      ${dlgTop(show)}
      <div class="dlg-head">
        ${sagaChip(show)}
        <h1 class="dlg-title">${show.title}</h1>
        <div class="dlg-actions">
          ${up ? html`<button class="btn play" data-play="${up.id}">${icon('play')}${upLabel}</button>` : ''}
          ${listButton(show)}
          <button class="round" id="show-watch" aria-label="${allWatched ? 'Mark the whole show unwatched' : 'Mark the whole show watched'}" title="${allWatched ? 'Mark the whole show unwatched' : 'Mark the whole show watched'}">${allWatched ? '↺' : icon('check')}</button>
        </div>
      </div>
    </div>
    <div class="dlg-body">
      <div>
        <div class="dlg-meta">
          ${show.year ? html`<span>${show.year}</span>` : ''}
          <span>${show.seasonCount} season${show.seasonCount === 1 ? '' : 's'}</span>
          <span>${show.episodeCount} episodes</span>
          ${show.unwatchedCount && !allWatched ? html`<span class="muted">${show.unwatchedCount} unwatched</span>` : ''}
          ${show.contentRating ? html`<span class="age-badge">${show.contentRating}</span>` : ''}${show.rating ? html`<span>★ ${show.rating}</span>` : ''}
        </div>
        ${resuming ? progressLine(up, `${epLabel(up).replace(' · ', ':')} · ${up.title}`) : ''}
        ${show.overview ? html`<p class="overview">${show.overview}</p>` : ''}
        ${matchNote(show)}
      </div>
      ${sideInfo(show)}
    </div>
    ${show.seasons.length ? html`<section class="dlg-section">
      <div class="dlg-section-head"><h2>Episodes</h2>
        <div class="row">
          ${show.seasons.length > 1 ? html`<select id="season-pick" aria-label="Season">${show.seasons.map((s) => html`<option value="${seasonKey(s)}" ${seasonKey(s) === current ? 'selected' : ''}>${s.title}</option>`)}</select>`
            : html`<span class="muted">${show.seasons[0].title}</span>`}
          <button class="btn small" id="season-watch"></button>
          ${phoneDownloads() ? html`<button class="btn small" id="season-dl">Download season</button>` : ''}
          <button class="btn small" id="more-seasons" title="Ask for seasons that aren't here yet">＋ More seasons</button>
        </div></div>
      <div id="season-body"></div>
    </section>` : ''}
    ${extrasSection(show.extras)}
    ${castSection(show.cast)}
    ${franchiseSection(show.franchise)}
    ${similarSection(show.similar)}
    ${show.files ? showFilesBox(show.files) : ''}`)) return;

  bindDetailActions(show);
  if (current != null && show.seasons.length) renderSeason();
  if ($('#season-pick')) $('#season-pick').onchange = (e) => {
    current = e.target.value;
    history.replaceState(null, '', `#/show/${id}?season=${current}`);
    renderSeason();
  };
  $('#show-watch').onclick = async () => { await api(`/api/shows/${id}/watched`, { method: 'POST', body: { watched: !allWatched } }); router(); };
  if ($('#more-seasons')) $('#more-seasons').onclick = () => openMoreSeasons(show);
  viewEl.onclick = async (e) => {
    const b = e.target.closest('[data-watch]'); if (!b) return;
    await api(`/api/items/${b.dataset.watch}/watched`, { method: 'POST', body: { watched: !b.classList.contains('on') } });
    router();
  };
}

async function viewItem({ params: [id], seq }) {
  const it = await api(`/api/items/${id}`);
  viewEl.onclick = null;
  const isEp = it.type === 'episode';
  const isExtra = it.type === 'extra';
  const p = it.progress;
  const resumable = p && !p.watched && p.position > 15;
  const v = it.media?.video, a = it.media?.audio?.[0];
  const res = resLabel(v);
  document.title = `${isEp ? `${it.showTitle} · ` : ''}${it.title} · Marquee`;
  if (!setView(seq, html`
    <div class="dlg-hero">
      <img src="${artUrl(isEp || isExtra ? 'thumb' : 'backdrop', it)}" alt="">
      ${dlgTop(it)}
      <div class="dlg-head">
        ${isEp ? html`<div class="dlg-eyebrow"><a href="#/show/${it.showId}?season=${it.season}">${it.showTitle}</a> · ${epLabel(it).replace(' · ', ':')}</div>` : ''}
        ${isExtra ? html`<div class="dlg-eyebrow">${it.extraLabel}${it.parent ? html` · <a href="#/${it.parent.type === 'show' ? 'show' : 'item'}/${it.parent.id}">${it.parent.title}</a>` : ''}</div>` : ''}
        ${isEp || isExtra ? '' : sagaChip(it)}
        <h1 class="dlg-title">${it.title}</h1>
        <div class="dlg-actions">
          ${it.media ? html`
            <button class="btn play" data-play="${id}" ${resumable ? '' : raw('data-t="0"')}>${icon('play')}${resumable ? 'Resume' : 'Play'}</button>
            ${resumable ? html`<button class="btn ghost" data-play="${id}" data-t="0">From the start</button>` : ''}` : ''}
          ${it.versions?.length > 1 ? html`<select class="version-pick" data-version title="Which version to play" aria-label="Version">
            <option value="">Best for this device</option>${it.versions.map((v) => html`<option value="${v.id}">${v.label}</option>`)}</select>` : ''}
          ${listButton(it)}
          <button class="round" id="item-watch" aria-label="${p?.watched ? 'Mark unwatched' : 'Mark watched'}" title="${p?.watched ? 'Mark unwatched' : 'Mark watched'}">${p?.watched ? '↺' : icon('check')}</button>
          ${phoneDownloads() ? html`<button class="round" data-offline="${id}" aria-label="Download to watch offline" title="Download to watch offline">${icon('download')}</button>`
            : html`<a class="round" href="/api/items/${id}/stream?download=1" download aria-label="Download the original file" title="Download the original file">${icon('download')}</a>`}
          ${it.sourceUrl ? html`<a class="round" href="${it.sourceUrl}" target="_blank" rel="noopener" aria-label="Open the original video page" title="Open the original video page">${icon('link')}</a>` : ''}
        </div>
      </div>
    </div>
    <div class="dlg-body">
      <div>
        <div class="dlg-meta">
          ${it.year && !isEp ? html`<span>${it.year}</span>` : ''}
          ${it.airDate ? html`<span>${it.airDate}</span>` : ''}
          ${it.channel ? html`<span title="Channel">${it.channel}</span>` : ''}
          ${it.duration ? html`<span>${fmtDuration(it.duration)}</span>` : ''}
          ${it.contentRating ? html`<span class="age-badge">${it.contentRating}</span>` : ''}${it.rating ? html`<span>★ ${it.rating}</span>` : ''}
          ${res ? html`<span class="tag">${res}</span>` : ''}
          ${v?.colorTransfer === 'smpte2084' ? html`<span class="tag" title="High dynamic range">HDR10</span>` : v?.colorTransfer === 'arib-std-b67' ? html`<span class="tag" title="High dynamic range">HLG</span>` : ''}
          ${p?.watched ? html`<span class="tag">✓ Watched</span>` : ''}
        </div>
        ${resumable ? progressLine(it, `Paused at ${fmtClock(p.position)}`) : ''}
        ${!it.media ? html`<p class="error-box">This file could not be read by ffprobe.</p>` : ''}
        ${it.tagline ? html`<p class="tagline">${it.tagline}</p>` : ''}
        ${it.overview ? html`<p class="overview">${it.overview}</p>` : ''}
        ${matchNote(it)}
        ${isEp && (it.prev || it.next) ? html`<div class="ep-links">
          ${it.prev ? html`<a class="btn small" data-swap href="#/item/${it.prev.id}">‹ ${epLabel(it.prev).replace(' · ', ':')}</a>` : ''}
          ${it.next ? html`<a class="btn small" data-swap href="#/item/${it.next.id}">${epLabel(it.next).replace(' · ', ':')} ›</a>` : ''}</div>` : ''}
      </div>
      ${sideInfo(it)}
    </div>
    ${extrasSection(it.extras)}
    ${it.type !== 'episode' ? castSection(it.cast) : ''}
    ${franchiseSection(it.franchise)}
    ${similarSection(it.similar)}
    <details class="tech-box" ${it.file ? raw('open') : ''}><summary>${it.file ? 'File' : 'File and playback details'}</summary>
      <dl class="tech">
        ${it.file ? html`<dt>File</dt><dd class="file-path"><code>${it.file}</code> <button class="btn small" data-copy="${it.file}">Copy</button></dd>` : ''}
        <dt>Plays</dt><dd>${it.directPlay ? 'Directly in this browser' : 'Converted on the fly by the server'}</dd>
        ${it.file ? '' : html`<dt>File</dt><dd>${it.fileName}</dd>`}
        <dt>Size</dt><dd>${fmtSize(it.size)}</dd>
        ${it.media ? html`
          <dt>Container</dt><dd>${it.media.container}</dd>
          ${v ? html`<dt>Video</dt><dd>${v.codec?.toUpperCase()} ${v.profile ? `(${v.profile})` : ''} · ${v.width}×${v.height}</dd>` : ''}
          ${a ? html`<dt>Audio</dt><dd>${it.audioTracks.map((t) => t.label).join(', ')}</dd>` : ''}
          ${it.media.bitrate ? html`<dt>Bitrate</dt><dd>${(it.media.bitrate / 1e6).toFixed(1)} Mbps</dd>` : ''}` : ''}
        <dt>Subtitles</dt><dd>${it.subtitles.length ? it.subtitles.map((x) => x.label).join(', ') : 'None'}</dd>
      </dl>
    </details>`)) return;
  bindDetailActions(it);
  $('#item-watch').onclick = async () => {
    await api(`/api/items/${id}/watched`, { method: 'POST', body: { watched: !p?.watched } });
    router();
  };
}

async function viewSearch({ query, seq }) {
  const q = query.get('q') || '';
  if ($('#search-input') !== document.activeElement) $('#search-input').value = q;
  if (q) $('#search-form').classList.add('open');
  const ask = html`<div class="req-ask"><span class="muted">Not finding what you want?</span> <button class="btn small" data-ask="${q}">Ask for it</button></div>`;
  if (!q.trim()) {
    return setView(seq, $('#voice-btn').hidden ? html`<div class="empty">Type to search your libraries.</div>`
      : html`<div class="empty">Type to search your libraries, or <button class="btn" data-voice>${icon('mic')} Search by voice</button></div>`);
  }
  const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
  const total = r.movies.length + r.shows.length + r.episodes.length;
  if (!setView(seq, html`
    <div class="toolbar"><h1>Results for “${q}”</h1>${total ? selectButton() : ''}</div>
    ${!total ? html`<div class="empty">No matches.</div>` : ''}
    ${!tv.on || !total ? ask : ''}
    ${r.movies.length ? html`<section class="hub"><div class="hub-head"><h2>Movies</h2></div><div class="grid">${r.movies.map(posterCard)}</div></section>` : ''}
    ${r.shows.length ? html`<section class="hub"><div class="hub-head"><h2>Shows</h2></div><div class="grid">${r.shows.map(posterCard)}</div></section>` : ''}
    ${r.episodes.length ? html`<section class="hub"><div class="hub-head"><h2>Episodes</h2></div><div class="grid wide">${r.episodes.map(wideCard)}</div></section>` : ''}`)) return;
  bindSelect({ root: () => view, kind: 'titles' });
}

// ---------- settings ----------
function cacheSummary(m) {
  const labels = { database: 'Database', artwork: 'Artwork', thumbs: 'Thumbnails', trickplay: 'Seek previews', fingerprints: 'Intro detection',
    subtitles: 'Subtitle copies', downloadedSubtitles: 'Downloaded subtitles', conversions: 'Converting now', offline: 'Copies for phone downloads', previews: 'Preview clips', keyframes: 'Keyframe lists' };
  const parts = Object.entries(labels).filter(([k]) => m.sizes[k] > 0).map(([k, l]) => `${l} ${fmtSize(m.sizes[k])}`);
  return parts.length ? parts.join(' · ') : 'Nothing yet';
}


function showLibraryForm(lib = null) {
  const slot = $('#lib-form-slot');
  const paths = lib ? [...lib.paths] : [''];
  const draw = () => {
    slot.innerHTML = html`
      <form class="panel form" id="lib-form" style="max-width:none">
        <h2>${lib ? `Edit ${lib.name}` : 'Add library'}</h2>
        <div class="row" style="align-items:flex-end">
          <label style="flex:1;min-width:200px">Type
            <select name="type" ${lib ? 'disabled' : ''}>
              <option value="movie" ${lib?.type === 'movie' ? 'selected' : ''}>Movies</option>
              <option value="show" ${lib?.type === 'show' ? 'selected' : ''}>TV Shows</option>
            </select>
          </label>
          <label style="flex:2;min-width:200px">Name
            <input class="input" name="name" required value="${lib?.name || ''}" placeholder="Movies">
          </label>
        </div>
        <label>Folders
          ${paths.map((p, i) => html`<div class="path-row">
            <input class="input" data-path="${i}" value="${p}" placeholder="/path/to/media">
            <button type="button" class="btn small" data-browse="${i}">Browse…</button>
            ${paths.length > 1 ? html`<button type="button" class="btn small danger" data-rm="${i}" aria-label="Remove folder">✕</button>` : ''}
          </div>`)}
        </label>
        <div class="row"><button type="button" class="btn small" id="add-path">＋ Add another folder</button>
          <span class="muted" style="font-size:13px">A library can combine folders from several drives — they show up as one collection. Folders inside the ones you pick are searched too.</span></div>
        <p class="muted" style="margin:0;font-size:13px">Movies: <code>Movie Name (Year).mkv</code> or <code>Movie Name (Year)/file.mkv</code>.
          TV: <code>Show Name/Season 01/Show Name - S01E01.mkv</code> — shows can also sit in folders of their own, like <code>Kids/Bluey/Season 1/…</code>.</p>
        <div class="form-error" id="form-error"></div>
        <div class="row"><button class="btn primary" type="submit">${lib ? 'Save' : 'Add library'}</button><button class="btn" type="button" id="cancel-form">Cancel</button></div>
      </form>`.s;
    const form = $('#lib-form');
    const sync = () => $$('[data-path]', form).forEach((inp) => { paths[Number(inp.dataset.path)] = inp.value; });
    const typeSel = form.elements.type, nameInp = form.elements.name;
    typeSel.onchange = () => { if (!nameInp.dataset.touched) nameInp.value = typeSel.value === 'show' ? 'TV Shows' : 'Movies'; };
    nameInp.oninput = () => { nameInp.dataset.touched = '1'; };
    if (!lib && !nameInp.value) nameInp.value = 'Movies';
    $('#add-path').onclick = () => { sync(); paths.push(''); draw(); };
    $('#cancel-form').onclick = () => { slot.innerHTML = ''; };
    form.onclick = async (e) => {
      const rm = e.target.closest('[data-rm]');
      if (rm) { sync(); paths.splice(Number(rm.dataset.rm), 1); draw(); return; }
      const br = e.target.closest('[data-browse]');
      if (br) {
        sync();
        const i = Number(br.dataset.browse);
        const picked = await pickFolder(paths[i] || undefined);
        if (picked) { paths[i] = picked; const keepName = nameInp.value, keepType = typeSel.value; draw(); $('#lib-form').elements.name.value = keepName; $('#lib-form').elements.type.value = keepType; }
      }
    };
    form.onsubmit = async (e) => {
      e.preventDefault(); sync();
      const body = { name: nameInp.value, paths: paths.filter((p) => p.trim()) };
      if (!lib) body.type = typeSel.value;
      try {
        if (lib) await api(`/api/libraries/${lib.id}`, { method: 'PATCH', body });
        else await api('/api/libraries', { method: 'POST', body });
        toast(lib ? 'Library updated' : 'Library added — scanning now');
        await refreshLibraries(); pollStatus();
        history.replaceState(null, '', '#/settings/libraries'); router();
      } catch (err) { $('#form-error').textContent = err.message; }
    };
    nameInp.focus();
  };
  draw();
  slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Folder picker: drives and shared folders on the left, the folder's subfolders on the right, and a
// count of the videos a library would find in it (subfolders included).
function pickFolder(start) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    let cur = null, previewFor = null;
    const close = (val) => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); resolve(val); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    const showPreview = async (p) => {
      previewFor = p;
      const el = $('#pick-preview');
      el.textContent = 'Looking for videos in this folder and the folders inside it…';
      try {
        const r = await api(`/api/fs/preview?path=${encodeURIComponent(p)}`);
        if (previewFor !== p || !$('#pick-preview')) return;
        const inside = r.folders ? ` and the ${r.folders} folder${r.folders === 1 ? '' : 's'} inside it` : '';
        el.innerHTML = r.videos
          ? html`<b>${r.partial ? 'At least ' : ''}${r.videos} video${r.videos === 1 ? '' : 's'}</b> in this folder${inside} — a library made from it gets all of them.
              <span class="muted" title="${r.sample.join('\n')}">e.g. ${r.sample.slice(0, 2).join(', ')}</span>`.s
          : html`No videos here${r.folders ? ` or in the ${r.folders} folder${r.folders === 1 ? '' : 's'} inside it` : ''}${r.partial ? ' (stopped looking — this folder is very large)' : ''}.`.s;
      } catch { if (previewFor === p && $('#pick-preview')) el.textContent = ''; }
    };
    const load = async (p) => {
      try { cur = await api(`/api/fs${p ? `?path=${encodeURIComponent(p)}` : ''}`); }
      catch (err) { toast(err.message, true); if (!cur) cur = await api('/api/fs'); else return; }
      const inPlace = (pl) => cur.path === pl.path || cur.path.startsWith(pl.path.replace(/[\\/]$/, '') + (pl.path.includes('\\') ? '\\' : '/'));
      // Only the closest one is highlighted (a drive can sit inside the media folder).
      const here = (cur.places || []).filter(inPlace).sort((a, b) => b.path.length - a.path.length)[0];
      root.innerHTML = html`
        <div class="modal-backdrop" id="mb">
          <div class="modal wide" role="dialog" aria-label="Choose a folder">
            <header><h2>Choose a folder</h2>
              <form id="pick-go" class="row" style="margin-top:8px"><input class="input" id="pick-path" style="flex:1" value="${cur.label || cur.path}" aria-label="Folder path" spellcheck="false"><button class="btn small">Go</button></form>
              ${cur.label ? html`<div class="cwd muted">${cur.path}</div>` : ''}</header>
            <div class="modal-body picker">
              <nav class="places" aria-label="Drives and folders">
                <div class="muted places-head">Drives & folders</div>
                ${(cur.places || []).map((pl) => html`<button data-dir="${pl.path}" class="${pl === here ? 'on' : ''}" title="${pl.path}">${/drive$/.test(pl.label) ? '💽' : pl.label === 'Home folder' ? '🏠' : '📁'} ${pl.label}</button>`)}
              </nav>
              <div class="dir-list">
                ${cur.parent ? html`<button data-dir="${cur.parent}">⬆ ..</button>` : ''}
                ${cur.dirs.map((d) => html`<button data-dir="${cur.path.replace(/[\\/]$/, '')}${cur.path.includes('\\') ? '\\' : '/'}${d}">📁 ${d}${cur.labels?.[d] ? html` <span class="muted">— ${cur.labels[d]}</span>` : ''}</button>`)}
                ${cur.dirs.length ? '' : html`<div class="muted" style="padding:12px">No folders inside this one</div>`}
              </div>
            </div>
            <div class="pick-preview" id="pick-preview" aria-live="polite"></div>
            <footer><span class="muted pick-hint">Missing a drive? See “Other drives” in the README.</span>
              <button class="btn" id="pick-cancel">Cancel</button><button class="btn primary" id="pick-ok">Select this folder</button></footer>
          </div>
        </div>`.s;
      $('#mb').onclick = (e) => {
        if (e.target.id === 'mb' || e.target.id === 'pick-cancel') return close(null);
        if (e.target.id === 'pick-ok') return close(cur.path);
        const d = e.target.closest('[data-dir]'); if (d) load(d.dataset.dir);
      };
      $('#pick-go').onsubmit = (e) => { e.preventDefault(); load($('#pick-path').value.trim()); };
      showPreview(cur.path);
    };
    load(start);
  });
}

// ---------- player ----------
let player = null;
// Whether the server answers (a player that loses its stream checks this before giving up on it).
const serverUp = () => fetch('/api/health', { cache: 'no-store' }).then((r) => r.ok).catch(() => false);
function closePlayer() { if (player) { player.destroy(); player = null; } }

// HEVC (x265) this browser decodes itself (Safari; Chrome and Edge with a graphics card that can).
let probeVideo = null;
function browserHevc(v) {
  if (v?.codec !== 'hevc' && v?.videoCodec !== 'hevc') return false;
  const ten = /10/.test(v.profile || '') || /10/.test(v.pixFmt || '');
  const type = `video/mp4; codecs="${ten ? 'hvc1.2.4.L153.B0' : 'hvc1.1.6.L153.B0'}"`;
  probeVideo ||= document.createElement('video');
  return !!window.MediaSource?.isTypeSupported?.(type) || probeVideo.canPlayType(type) === 'probably';
}

// Which copy of a film this browser plays: the best one it plays as it is, else the best whose
// picture it takes unconverted, else the smallest (the least work for the server). Away from
// home, the smallest of those instead.
function chooseVersion(list) {
  const away = defaultQuality() !== 'original';
  const best = (l) => { const s = [...l].sort((a, b) => (b.height || 0) - (a.height || 0)); return away ? s[s.length - 1] : s[0]; };
  const asIs = (v) => v.directPlay || (browserHevc(v) && /\.(mp4|m4v|mov)$/i.test(v.fileName || '') && ['aac', 'mp3', 'opus', 'flac', null].includes(v.audioCodec));
  const direct = list.filter(asIs);
  if (direct.length) return best(direct);
  const remux = list.filter((v) => v.remux);
  if (remux.length) return best(remux);
  return [...list].sort((a, b) => (a.height || 0) - (b.height || 0))[0];
}

// Bedtime or the day's screen time (set by an admin for a profile): a message instead of the video.
function screenTimeNotice(b) {
  const m = openModal({ title: b.reason === 'bedtime' ? 'Bedtime' : 'That’s enough for today', body: html`<p style="margin:0;font-size:18px">${b.message}</p>`.s,
    footer: html`<button class="btn primary" data-close>OK</button>`.s });
  $('[data-close]', m.el).onclick = m.close;
  $('[data-close]', m.el).focus();
}

async function viewPlay({ params: [id], query }) {
  closePlayer();
  let item = await api(`/api/items/${id}`);
  if (!item.media) { toast('This file cannot be played', true); return history.back(); }
  if (item.watchBlock) { screenTimeNotice(item.watchBlock); return history.back(); } // bedtime, or today's time used up
  let start = query.has('t') ? Number(query.get('t')) || 0 : 0;
  if (!query.has('t') && item.progress && !item.progress.watched && item.progress.position > 15) start = item.progress.position;
  // Watch together: start where the party is.
  const partyId = query.get('party');
  if (partyId) {
    const p = await api(`/api/parties/${partyId}`).catch((err) => { toast(err.message, true); return null; });
    if (p) start = partyPosition(p, p.serverNow - Date.now());
  }
  // Inside the Android app, videos open in the phone's native player (watch parties stay in the web player).
  if (window.MarqueeAndroid?.play && !partyId) {
    window.MarqueeAndroid.play(JSON.stringify({ id: item.id, start, autoplayNext: playerPref('autoplayNext'), subsOn: store.get('subsOn', false),
      autoSkipIntro: playerPref('autoSkipIntro'), skipFade: playerPref('skipFade'), nightMode: playerPref('nightMode'), quality: store.get('quality', ''),
      subLang: playerPref('subLang'), audioLang: playerPref('audioLang'), subSize: playerPref('subSize'), subStyle: playerPref('subStyle'),
      ...(query.get('v') ? { version: query.get('v') } : {}) }));
    if (state.inAppNav) history.back(); else location.replace(`#/item/${item.id}`);
    return;
  }
  // A film with several versions: the one picked on its page, or the best for this browser.
  if (item.versions?.length > 1) {
    const chosen = item.versions.find((v) => v.id === query.get('v')) || chooseVersion(item.versions);
    if (chosen && chosen.id !== item.id) item = { ...(await api(`/api/items/${chosen.id}`)), progress: item.progress };
  }
  player = new Player(item, start, { partyId });
}

// Where a watch party is now: its last known position, plus the time since then if it's playing.
// clockOffset = server clock − this device's clock.
function partyPosition(p, clockOffset) {
  return p.position + (p.playing ? Math.max(0, Date.now() + clockOffset - p.updatedAt) / 1000 : 0);
}

async function viewParty({ params: [id] }) {
  try {
    const p = await api(`/api/parties/${id}`);
    location.replace(`#/play/${p.itemId}?party=${p.id}`);
  } catch (err) {
    view.innerHTML = html`<div class="empty"><h2>Can't join this watch party</h2><p>${err.message}</p><a class="btn" href="#/">Go home</a></div>`.s;
  }
}

const loadedScripts = new Map();
function loadScript(src) {
  if (!loadedScripts.has(src)) {
    loadedScripts.set(src, new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = src; s.onload = () => resolve(true); s.onerror = () => resolve(false);
      document.head.append(s);
    }));
  }
  return loadedScripts.get(src);
}

// On the home network the original file is best; from outside, adaptive streaming copes with
// slower connections. Users can pick a fixed choice on the Account page or in the player.
function defaultQuality() {
  const q = store.get('quality', '');
  if (q) return q;
  const h = location.hostname;
  const home = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(h) || h.endsWith('.local') || !h.includes('.');
  return home ? 'original' : 'auto';
}

// Identifies this browser tab on the Activity page.
const PAGE_ID = Math.random().toString(36).slice(2, 12);

class Player {
  constructor(item, start, { partyId = null } = {}) {
    this.item = item;
    this.duration = item.duration || 0;
    this.quality = defaultQuality();
    this.mode = item.directPlay ? 'direct' : 'transcode';
    this.offset = 0;
    this.audio = 0;
    this.subId = store.get('subsOn', false) ? this.pickDefaultSub() : null;
    // The languages last picked for this show win (e.g. Japanese with English subtitles).
    const pref = item.tracks;
    if (pref?.audio) this.audio = Math.max(0, (item.audioTracks || []).findIndex((t) => t.lang === pref.audio));
    if (pref?.subs === 'off') this.subId = null;
    else if (pref?.subs) {
      const subs = [...item.subtitles].sort((a, b) => (a.burn != null) - (b.burn != null));
      this.subId = subs.find((s) => s.lang === pref.subs)?.id || this.subId;
    }
    // Otherwise the account's languages (Account → Playback), when the title has them.
    if (!pref?.audio && playerPref('audioLang')) {
      const i = (item.audioTracks || []).findIndex((t) => sameLang(t.lang, playerPref('audioLang')));
      if (i >= 0) this.audio = i;
    }
    if (!pref?.subs && playerPref('subLang')) {
      const s = [...item.subtitles].sort((a, b) => (a.burn != null) - (b.burn != null)).find((x) => sameLang(x.lang, playerPref('subLang')));
      if (s) this.subId = s.id;
    }
    this.lastReported = -1;
    this.dragging = false;
    this.pb = null;          // signed links + streaming session from /playback
    this.hls = null;
    this.casting = false;
    this.castTime = 0;

    const it = item;
    const subtitle = it.type === 'episode' ? [it.showTitle, epLabel(it)].filter(Boolean).join(' · ') : it.year;
    this.root = document.createElement('div');
    this.root.className = `player subs-${playerPref('subSize')} subs-${playerPref('subStyle')}`;
    this.root.innerHTML = html`
      <video playsinline preload="auto" crossorigin="anonymous" x-webkit-airplay="allow"></video>
      <div class="p-subs" aria-live="off"></div>
      <div class="p-spinner"></div>
      <div class="p-cast-msg" hidden><div class="p-cast-icon">📺</div><div>Playing on <b class="p-cast-name"></b></div>
        <button class="btn small" data-a="cast-stop">Stop casting</button></div>
      <button class="btn p-skip" data-a="skip-intro" hidden>Skip Intro ⏭</button>
      ${it.cast?.length ? html`<div class="p-cast" hidden><div class="p-cast-head">In this</div><div class="cast-row">${it.cast.slice(0, 6).map(personCard)}</div></div>` : ''}
      <div class="p-top">
        <button class="p-btn" data-a="close" title="Back (Esc)">←</button>
        <div class="p-title">${it.title}<small>${subtitle}</small></div>
        <span class="p-spacer"></span>
        <span class="p-badge" id="p-mode"></span>
        <button class="p-btn p-party" data-a="party" title="Watch together">👥<span class="p-party-count"></span></button>
        <button class="p-btn" data-a="airplay" title="AirPlay" hidden>⇪</button>
        <button class="p-btn" data-a="cast" title="Cast to a TV" hidden><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M1 18v3h3a3 3 0 0 0-3-3zm0-4v2a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7zm0-4v2a9 9 0 0 1 9 9h2A11 11 0 0 0 1 10zm20-7H3a2 2 0 0 0-2 2v3h2V5h18v14h-7v2h7a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/></svg></button>
      </div>
      <div class="p-bottom">
        <div class="p-seek"><div class="p-buffer"></div><div class="p-chapters"></div><input type="range" class="p-range" min="0" step="0.1" value="0" aria-label="Seek"><div class="p-hover-thumb" hidden></div><div class="p-hover-time" hidden></div></div>
        <div class="p-row">
          <button class="p-btn big" data-a="toggle" title="Play/Pause (Space)">▶</button>
          <button class="p-btn" data-a="back" title="Back 10s (←)">⟲</button>
          <button class="p-btn" data-a="fwd" title="Forward 30s (→)">⟳</button>
          <span class="p-time">0:00 / ${fmtClock(this.duration)}</span>
          <span class="p-spacer"></span>
          ${it.audioTracks.length > 1 ? html`<select data-a="audio" class="p-hide-sm" title="Audio">${it.audioTracks.map((t) => html`<option value="${t.index}">${t.label}</option>`)}</select>` : ''}
          ${it.subtitles.length || state.status?.subtitleSearch ? html`<select data-a="subs" title="Subtitles (c)">${this.subOptions()}</select>` : ''}
          <select data-a="quality" title="Quality" hidden></select>
          <button class="p-btn" data-a="mute" title="Mute (m)">🔊</button>
          <input type="range" class="p-volume" min="0" max="1" step="0.05" aria-label="Volume">
          <button class="p-btn p-hide-sm ${playerPref('nightMode') ? 'on' : ''}" data-a="night" title="Night mode: clearer dialogue, quieter loud scenes">☾</button>
          <select data-a="speed" class="p-speed" title="Playback speed (&lt; &gt;)">${[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => html`<option value="${r}" ${r === 1 ? 'selected' : ''}>${r === 1 ? 'Normal' : `${r}×`}</option>`)}</select>
          ${document.pictureInPictureEnabled ? html`<button class="p-btn p-hide-sm" data-a="pip" title="Picture-in-picture (p)">⧉</button>` : ''}
          ${it.type === 'episode' && state.user.role === 'admin' ? html`<button class="p-btn p-hide-sm" data-a="intro-edit" title="Edit this episode's intro">✂</button>` : ''}
          ${it.next ? html`<button class="p-btn" data-a="next" title="Next episode">⏭</button>` : ''}
          <button class="p-btn" data-a="fs" title="Fullscreen (f)">⛶</button>
        </div>
      </div>`.s;
    $('#player-root').append(this.root);
    this.v = $('video', this.root);
    if (playerPref('nightMode')) this.setNight(true);
    this.range = $('.p-range', this.root);
    this.range.max = this.duration || 0;
    this.v.volume = store.get('volume', 1);
    this.v.muted = store.get('muted', false);
    $('.p-volume', this.root).value = this.v.volume;
    this.bind();
    this.spinner(true);
    this.init(start).then(() => { if (partyId && this.root.isConnected) this.joinParty(partyId); });
    this.reportTimer = setInterval(() => this.report(), 10_000);
    document.title = `${it.type === 'episode' ? `${it.showTitle} - ` : ''}${it.title} · Marquee`;
  }

  async init(start) {
    try { this.pb = await api(`/api/items/${this.item.id}/playback`); } catch { this.pb = null; }
    if (!this.root.isConnected) return;
    const qs = this.pb?.qualities || [];
    // Adaptive streams are H.264 + AAC; a browser without H.264 (some Linux builds) can't use them.
    const h264 = window.MediaSource?.isTypeSupported?.('video/mp4; codecs="avc1.640028,mp4a.40.2"');
    this.canHls = qs.length > 0 && (this.nativeHls() || (h264 && await loadScript('/vendor/hls.light.min.js') && window.Hls?.isSupported()));
    if (!this.root.isConnected) return;
    if (this.canHls) {
      const sel = $('[data-a=quality]', this.root);
      // Away from home the admin may have limited the quality: then the original file isn't offered.
      const original = this.pb.originalAllowed !== false;
      if (!original && this.quality === 'original') this.quality = 'auto';
      sel.innerHTML = html`${original ? html`<option value="original">Original</option>` : ''}<option value="auto">Auto</option>${qs.map((q) => html`<option value="${q.id}">${q.label}</option>`)}`.s;
      sel.title = this.pb.limit ? `Quality is limited to ${this.pb.limit} away from home` : 'Quality';
      if (![...(original ? ['original'] : []), 'auto', ...qs.map((q) => q.id)].includes(this.quality)) {
        // A fixed quality above this video's resolution: use the best one it has.
        this.quality = /^\d+p$/.test(this.quality) ? qs[0].id : 'original';
      }
      sel.value = this.quality;
      sel.hidden = false;
    } else this.quality = 'original';
    this.setModeFromQuality();
    this.setupRemote();
    this.loadTrickplay();
    this.renderChapters();
    this.v.addEventListener('loadedmetadata', () => this.renderChapters());
    if (Cast.state() === 'CONNECTED') this.startCasting(start);
    else this.load(start);
  }

  // Chapter marks on the seek bar (from the video's own chapters, e.g. downloaded YouTube videos).
  renderChapters() {
    const box = $('.p-chapters', this.root);
    const chapters = this.item.chapters || [];
    box.innerHTML = this.total ? chapters.filter((c) => c.start > 0 && c.start < this.total)
      .map((c) => html`<i style="left:${pct(c.start, this.total)}%" title="${c.title}"></i>`.s).join('') : '';
  }

  chapterAt(t) {
    let found = null;
    for (const c of this.item.chapters || []) if (c.start <= t) found = c.title;
    return found;
  }

  // Seek preview thumbnails: the server makes them the first time a video is opened.
  async loadTrickplay() {
    for (let tries = 0; tries < 120 && this.root.isConnected; tries++) {
      const info = await api(`/api/items/${this.item.id}/trickplay`).catch(() => null);
      if (!info) return;
      if (info.ready) { this.trick = info; return; }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  showThumb(el, f) {
    const t = this.trick;
    if (!t) { el.hidden = true; return; }
    const i = Math.min(t.count - 1, Math.floor((f * this.total) / t.interval));
    const perSheet = t.cols * t.rows;
    const sheet = Math.min(t.sheets, Math.floor(i / perSheet) + 1);
    const k = i % perSheet;
    el.hidden = false;
    const w = el.parentElement.clientWidth; // keep the picture on screen at either end
    el.style.left = `${Math.min(w - t.width / 2, Math.max(t.width / 2, f * w))}px`;
    el.style.width = `${t.width}px`;
    el.style.height = `${t.height}px`;
    el.style.backgroundImage = `url("/api/items/${this.item.id}/trickplay/${sheet}${this.tok()}")`;
    el.style.backgroundPosition = `-${(k % t.cols) * t.width}px -${Math.floor(k / t.cols) * t.height}px`;
  }

  nativeHls() { return !!this.v.canPlayType('application/vnd.apple.mpegurl') && !/Android/.test(navigator.userAgent); }

  // Original quality: the file as it is if the browser can play it; else, for an MKV's H.264 (say),
  // its picture unconverted in adaptive streaming ("source"); else converted by the server.
  setModeFromQuality() {
    this.remux = false;
    if (this.quality !== 'original' && this.canHls) this.mode = 'hls';
    else if ((this.item.directPlay || this.hevcFile()) && this.audio === 0 && this.burn == null && !this.directFailed) this.mode = 'direct';
    else if (this.pb?.remux && this.canHls && this.burn == null && !this.remuxFailed) { this.mode = 'hls'; this.remux = true; }
    else this.mode = 'transcode';
  }

  // HEVC (x265) this browser decodes itself (Safari; Chrome and Edge with a graphics card that can).
  hevcOk() { return !this.hevcFailed && browserHevc(this.item.media?.video); }
  // …in an MP4 with sound the browser plays too: played as it is.
  hevcFile() {
    const ext = (this.item.fileName || '').toLowerCase().split('.').pop();
    const a = this.item.media?.audio?.[0]?.codec;
    return ['mp4', 'm4v', 'mov'].includes(ext) && (!a || ['aac', 'mp3', 'opus', 'flac'].includes(a)) && this.hevcOk();
  }
  // …in anything else (an MKV): the server sends the picture as it is, converting only the sound.
  // (Not in Safari, which can't play the server's one-piece stream.)
  hevcQuery() { return this.hevcOk() && !this.nativeHls() && this.burn == null ? '&hevc=1' : ''; }

  // Picture subtitles (Blu-ray / DVD) are drawn into the video by the server: index of that track, or null.
  get burn() { return this.item.subtitles.find((s) => s.id === this.subId)?.burn ?? null; }
  burnQuery() { return this.burn != null ? `&burn=${this.burn}` : ''; }

  subOptions() {
    return html`<option value="">Subtitles off</option>${this.item.subtitles.map((s) => html`<option value="${s.id}" ${s.id === this.subId ? 'selected' : ''}>${s.label}</option>`)}
      ${state.status?.subtitleSearch && ['movie', 'episode'].includes(this.item.type) ? html`<option value="__search">Search online…</option>` : ''}`;
  }

  // Night mode: rumble cut, speech lifted, loud and quiet evened out (Web Audio, so it works for
  // direct play too). Once routed through Web Audio the video stays routed; off is a straight path.
  setNight(on) {
    this.night = on;
    if (!this.audioCtx && !on) return;
    try {
      if (!this.audioCtx) {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const src = ctx.createMediaElementSource(this.v);
        const hp = Object.assign(ctx.createBiquadFilter(), { type: 'highpass' }); hp.frequency.value = 90;
        const eq = Object.assign(ctx.createBiquadFilter(), { type: 'peaking' }); eq.frequency.value = 2200; eq.Q.value = 1.2; eq.gain.value = 4;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -28; comp.knee.value = 12; comp.ratio.value = 5; comp.attack.value = 0.008; comp.release.value = 0.22;
        const gain = ctx.createGain(); gain.gain.value = 1.8;
        this.audioCtx = ctx;
        this.nightChain = [src, hp, eq, comp, gain];
        this.v.addEventListener('play', () => ctx.resume().catch(() => {}));
      }
      const [src, hp, eq, comp, gain] = this.nightChain;
      for (const n of this.nightChain) n.disconnect();
      const out = this.audioCtx.destination;
      if (on) { src.connect(hp); hp.connect(eq); eq.connect(comp); comp.connect(gain); gain.connect(out); } else src.connect(out);
      this.audioCtx.resume().catch(() => {});
    } catch { /* no Web Audio: plain sound */ }
    $('[data-a=night]', this.root)?.classList.toggle('on', on);
  }

  // Episodes: the show remembers the sound and subtitle languages picked.
  rememberTracks() {
    if (this.item.type !== 'episode') return;
    const audio = this.item.audioTracks?.[this.audio]?.lang || null;
    const subs = this.subId ? this.item.subtitles.find((s) => s.id === this.subId)?.lang || null : 'off';
    api(`/api/items/${this.item.id}/tracks`, { method: 'PUT', body: { audio, subs } }).catch(() => {});
  }

  pickDefaultSub() {
    // Text subtitles first: picture ones need the video converted.
    const subs = [...this.item.subtitles].sort((a, b) => (a.burn != null) - (b.burn != null));
    const lang = (navigator.language || 'en').slice(0, 2);
    return (subs.find((s) => s.lang && s.lang.toLowerCase().startsWith(lang)) || subs[0])?.id || null;
  }

  // Signed links work without the login cookie, which AirPlay and cast devices don't have.
  tok(sep = '?') { return this.pb?.token ? `${sep}mt=${encodeURIComponent(this.pb.token)}` : ''; }

  hlsUrl({ sid = this.pb.sid, quality = this.remux ? 'source' : this.quality } = {}) {
    return `/api/items/${this.item.id}/hls/master.m3u8?sid=${sid}&audio=${this.audio}${quality !== 'auto' ? `&q=${quality}` : ''}${this.burnQuery()}${this.tok('&')}`;
  }

  get time() {
    if (this.casting) return this.castTime;
    // Until the new source has loaded, the position is where we asked it to start.
    if (this.pendingStart != null && this.v.readyState < 1) return this.pendingStart;
    return this.offset + (this.v.currentTime || 0);
  }
  get total() {
    return this.mode !== 'transcode' && !this.casting && Number.isFinite(this.v.duration) && this.v.duration > 0 ? this.v.duration : this.duration;
  }

  destroyHls() { if (this.hls) { this.hls.destroy(); this.hls = null; } }

  load(t) {
    t = Math.max(0, this.duration ? Math.min(t, this.duration - 2) : t);
    this.spinner(true);
    this.pendingStart = t;
    if (this.mode !== 'hls') this.destroyHls();
    if (this.mode === 'direct') {
      this.offset = 0;
      const seekTo = () => { this.v.currentTime = t; };
      if (!this.v.src.includes('/stream')) {
        this.v.src = `/api/items/${this.item.id}/stream${this.tok()}`;
        this.v.addEventListener('loadedmetadata', seekTo, { once: true });
      } else seekTo();
      this.applySubs();
      this.v.play().catch(() => this.spinner(false));
    } else if (this.mode === 'hls') {
      this.offset = 0;
      this.loadHls(t);
    } else {
      // Copied video streams can only start on a keyframe; ask where the stream will really begin.
      const seq = (this.loadSeq = (this.loadSeq || 0) + 1);
      this.offset = t;
      this.updateTime();
      const req = t.toFixed(3);
      api(`/api/items/${this.item.id}/seekpoint?t=${req}${this.burnQuery()}${this.hevcQuery()}`).catch(() => ({ start: t })).then(({ start }) => {
        if (seq !== this.loadSeq || !this.root.isConnected) return;
        this.offset = start;
        this.v.src = `/api/items/${this.item.id}/transcode?start=${req}&audio=${this.audio}${this.burnQuery()}${this.hevcQuery()}${this.tok('&')}`;
        this.applySubs();
        this.v.play().catch(() => this.spinner(false));
      });
    }
    this.updateBadge();
    this.updateTime();
  }

  loadHls(t) {
    this.destroyHls();
    const src = this.hlsUrl();
    if (window.Hls?.isSupported() && !this.nativeHls()) {
      const Hls = window.Hls;
      const slow = { maxTimeToFirstByteMs: 60_000, maxLoadTimeMs: 120_000, timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 }, errorRetry: { maxNumRetry: 4, retryDelayMs: 1000, maxRetryDelayMs: 8000 } };
      const hls = (this.hls = new Hls({ startPosition: t, maxBufferLength: 40, backBufferLength: 60, fragLoadPolicy: { default: slow }, enableWorker: true }));
      this.hlsRecoveries = 0;
      hls.on(Hls.Events.ERROR, (ev, d) => {
        if (!d.fatal || hls !== this.hls) return;
        if (this.hlsRecoveries++ < 2 && hls.levels?.length) {
          if (d.type === Hls.ErrorTypes.MEDIA_ERROR) return hls.recoverMediaError();
          if (d.type === Hls.ErrorTypes.NETWORK_ERROR) return hls.startLoad();
        }
        this.hlsFailed(d.details);
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, () => this.updateBadge());
      hls.loadSource(src);
      hls.attachMedia(this.v);
    } else {
      // Safari plays HLS itself (and can AirPlay it).
      this.v.src = src;
      this.v.addEventListener('loadedmetadata', () => { if (t > 0) this.v.currentTime = t; }, { once: true });
    }
    this.applySubs();
    this.v.play().catch(() => this.spinner(false));
  }

  async hlsFailed(why) {
    if (!(await serverUp())) return this.reconnect();
    if (!this.root.isConnected || this.reconnecting) return;
    console.warn('Adaptive streaming failed:', why);
    if (this.remux) {
      // The unconverted picture didn't play: the server converts it instead.
      const t = this.time;
      this.destroyHls();
      this.remuxFailed = true;
      this.setModeFromQuality();
      this.load(t);
      return;
    }
    const t = this.time;
    this.destroyHls();
    toast('Adaptive streaming failed — switching to Original quality');
    this.quality = 'original';
    const sel = $('[data-a=quality]', this.root); if (sel) sel.value = 'original';
    this.setModeFromQuality();
    this.load(t);
  }

  setQuality(q) {
    const t = this.time;
    const wasPaused = this.v.paused;
    this.quality = q;
    store.set('quality', q);
    this.setModeFromQuality();
    if (this.casting) { this.startCasting(t); return; }
    this.v.removeAttribute('src');
    this.load(t);
    if (wasPaused) this.v.addEventListener('playing', () => this.v.pause(), { once: true });
  }

  updateBadge() {
    const el = $('#p-mode', this.root);
    if (!el) return;
    if (this.mode === 'hls' && this.remux) el.textContent = 'Original · not converted';
    else if (this.mode === 'hls') {
      const lvl = this.hls?.levels?.[this.hls.currentLevel];
      const name = lvl ? `${lvl.height}p` : this.quality === 'auto' ? '' : this.quality;
      el.textContent = this.quality === 'auto' ? `Auto${name ? ` · ${name}` : ''}` : `Converting · ${name}`;
    } else el.textContent = this.mode === 'direct' ? 'Direct Play' : 'Transcoding';
  }

  seek(t) {
    t = Math.max(0, Math.min(t, this.total || t));
    if (this.casting) {
      Cast.player.currentTime = t;
      Cast.controller.seek();
      this.castTime = t;
      this.updateTime();
      this.partySend();
      return;
    }
    if (this.mode !== 'transcode') { this.v.currentTime = t; return; }
    // Within what the current transcode has already buffered? Seek locally instead of restarting ffmpeg.
    const b = this.v.buffered;
    const local = t - this.offset;
    for (let i = 0; i < b.length; i++) if (local >= b.start(i) && local <= b.end(i) - 0.5) { this.v.currentTime = local; return; }
    const wasPaused = this.v.paused;
    this.load(t);
    if (wasPaused) this.v.addEventListener('playing', () => this.v.pause(), { once: true });
  }

  subUrl(id, offset = 0) { return `/api/items/${this.item.id}/subtitles/${id}?offset=${offset.toFixed(2)}${this.tok('&')}`; }

  applySubs() {
    $$('track', this.v).forEach((t) => t.remove());
    const box = $('.p-subs', this.root);
    box.replaceChildren();
    if (!this.subId || this.burn != null) return;
    const sub = this.item.subtitles.find((s) => s.id === this.subId);
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = sub?.label || 'Subtitles';
    if (sub?.lang) track.srclang = sub.lang;
    track.src = this.subUrl(this.subId, this.offset);
    track.default = true;
    this.v.append(track);
    // Cues are rendered in our own overlay (track mode "hidden") so they can move clear of the controls.
    const tt = track.track;
    for (const other of this.v.textTracks) other.mode = other === tt ? 'hidden' : 'disabled';
    tt.addEventListener('cuechange', () => {
      box.replaceChildren(...[...(tt.activeCues || [])].map((c) => {
        const line = document.createElement('span');
        line.append(c.getCueAsHTML());
        return line;
      }));
    });
  }

  spinner(on) { $('.p-spinner', this.root).hidden = !on || this.casting; }

  updateTime() {
    const t = this.time, total = this.total;
    if (!this.dragging) {
      this.range.max = total || 0;
      this.range.value = t;
      this.range.style.setProperty('--pct', `${pct(t, total)}%`);
    }
    $('.p-time', this.root).textContent = `${fmtClock(this.dragging ? Number(this.range.value) : t)} / ${fmtClock(total)}`;
    this.updateIntro(t);
  }

  // "Skip Intro" while the detected theme song plays (or skip it automatically, once), and "Skip
  // Credits" at the end of a film (episodes get the Up Next card). The button fades after the
  // account's skipFade seconds and comes back while the controls are showing.
  updateIntro(t) {
    const credits = this.item.credits;
    if (credits && this.item.next && t >= credits.start && t < credits.start + 30 && !this.creditsShown && !this.dragging) {
      this.creditsShown = true;
      this.showUpNext(true);
    }
    const intro = this.item.intro;
    const btn = $('[data-a=skip-intro]', this.root);
    const inIntro = !!intro && t >= intro.start && t < intro.end - 1;
    if (inIntro && playerPref('autoSkipIntro') && !this.autoSkipped && (this.casting || !this.v.paused)) {
      this.autoSkipped = true;
      this.seek(intro.end);
      toast('Skipped the intro');
      return;
    }
    const inCredits = !!credits && !this.item.next && this.total > 0 && t >= credits.start && t < this.total - 2;
    const recap = this.item.recap;
    const inRecap = !!recap && t >= recap.start && t < recap.end - 1;
    const part = inRecap ? 'recap' : inIntro ? 'intro' : inCredits ? 'credits' : null;
    if (part !== this.skipPart) {
      this.skipPart = part;
      this.skipSince = Date.now();
      if (part) btn.textContent = { recap: 'Skip Recap ⏭', intro: 'Skip Intro ⏭', credits: 'Skip Credits ⏭' }[part];
    }
    btn.hidden = !part;
    const fade = playerPref('skipFade');
    btn.classList.toggle('faded', !!part && fade > 0 && Date.now() - this.skipSince > fade * 1000 && this.root.classList.contains('idle'));
  }

  updateBuffer() {
    const b = this.v.buffered, total = this.total;
    if (!b.length || !total) return;
    const ct = this.v.currentTime;
    let end = 0;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= ct + 1) end = Math.max(end, b.end(i));
    $('.p-buffer', this.root).style.width = `${pct(this.offset + end, total)}%`;
  }

  showControls() {
    this.root.classList.remove('idle');
    clearTimeout(this.idleTimer);
    if (!this.paused) this.idleTimer = setTimeout(() => this.root.classList.add('idle'), 3000);
  }

  get paused() { return this.casting ? !!Cast.player?.isPaused : this.v.paused; }

  toggle() {
    if (this.casting) return Cast.controller.playOrPause();
    if (this.v.paused) this.v.play().catch(() => {}); else this.v.pause();
  }

  // Saves the resume position, and tells the admin's Activity page what's playing (every 10 s,
  // also while paused; `stopped` when the player closes).
  report(stopped = false) {
    if (this.markedWatched || (this.reconnecting && !stopped)) return;
    const t = this.reconnecting ? this.lastGood ?? this.time : this.time;
    if (this.casting && t <= 0) return;
    this.lastReported = t;
    fetch(`/api/items/${this.item.id}/progress`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ position: t, paused: this.paused, mode: this.casting ? 'cast' : this.mode, quality: this.mode === 'hls' ? (this.remux ? 'source' : this.quality) : null, client: PAGE_ID, stopped }),
    }).then((r) => r.json()).then((d) => {
      // Bedtime has started, or today's screen time is used up (lib/screentime.js).
      if (d?.stop && !stopped && this.root.isConnected) { this.v.pause(); screenTimeNotice(d.stop); this.close(); }
    }).catch(() => {});
  }

  // ---- casting (Chromecast) and AirPlay ----
  setupRemote() {
    if (window.WebKitPlaybackTargetAvailabilityEvent) {
      this.v.addEventListener('webkitplaybacktargetavailabilitychanged', (e) => { $('[data-a=airplay]', this.root).hidden = e.availability !== 'available'; });
    }
    if (!Cast.supported()) return;
    Cast.load().then((ok) => {
      if (!ok || !this.root.isConnected) return;
      const btn = $('[data-a=cast]', this.root);
      const refresh = (state) => {
        btn.hidden = state === 'NO_DEVICES_AVAILABLE' || !state;
        btn.classList.toggle('on', state === 'CONNECTED');
        // Disconnected from the TV (or the TV stopped): carry on here.
        if (this.casting && state !== 'CONNECTED') this.stopCasting(false);
      };
      this.offCast = Cast.on(refresh);
      refresh(Cast.state());
    });
  }

  // Where the TV can reach Marquee: the admin's setting, else this page's address unless it is
  // "localhost" (meaningless to a TV), else this computer's network address.
  castBase() {
    const c = this.pb?.cast || {};
    if (c.configured) return c.configured;
    if (!/^(localhost|127\.|\[::1\])/.test(location.hostname)) return location.origin;
    return c.lan?.[0] || null;
  }

  async castClicked() {
    if (Cast.state() === 'CONNECTED' && this.casting) { Cast.disconnect(); return; }
    if (!(await Cast.connect())) return;
    this.startCasting(this.time);
  }

  async startCasting(t) {
    const base = this.castBase();
    if (!base || !this.pb) {
      toast('Your TV can’t reach “localhost”. Set the address for cast devices in Settings → Transcoding.', true);
      return this.load(t);
    }
    const it = this.item;
    // MP4 files TVs can play are sent as they are; everything else as adaptive streaming.
    const direct = it.directPlay && this.audio === 0 && this.burn == null && /\.(mp4|m4v)$/i.test(it.fileName || '') && (this.quality === 'original' || !this.canHls) && this.pb.originalAllowed !== false;
    const media = direct
      ? { url: `${base}/api/items/${it.id}/stream${this.tok()}`, contentType: 'video/mp4' }
      : { url: base + this.hlsUrl({ sid: `${this.pb.sid}c`, quality: this.quality === 'original' || !/^\d+p$/.test(this.quality) ? 'auto' : this.quality }), contentType: 'application/x-mpegURL', hls: true };
    if (!direct && !this.pb.qualities.length) { toast('This video can’t be cast', true); return this.load(t); }
    this.v.pause();
    this.destroyHls();
    this.v.removeAttribute('src');
    this.v.load();
    this.casting = true;
    this.castTime = t;
    this.root.classList.add('casting');
    $('.p-cast-msg', this.root).hidden = false;
    $('.p-cast-name', this.root).textContent = Cast.deviceName();
    $('#p-mode', this.root).textContent = `Casting${media.hls ? '' : ' · Original'}`;
    $('[data-a=toggle]', this.root).textContent = '❚❚';
    this.spinner(false);
    this.bindCastEvents();
    try {
      await Cast.play({
        ...media, title: it.title, subtitle: it.type === 'episode' ? [it.showTitle, epLabel(it)].filter(Boolean).join(' · ') : it.year,
        image: `${base}/api/art/backdrop/${it.id}${this.tok()}`, duration: this.duration, startTime: t,
        subtitles: it.subtitles.filter((s) => s.burn == null).map((s) => ({ id: s.id, label: s.label, lang: s.lang, url: base + this.subUrl(s.id) })), activeSub: this.subId,
      });
    } catch (err) {
      toast(`Casting failed${err?.code ? ` (${err.code})` : ''}`, true);
      this.stopCasting(false);
    }
  }

  bindCastEvents() {
    if (this.castBound) return;
    this.castBound = true;
    const T = window.cast.framework.RemotePlayerEventType;
    this.castHandlers = {
      [T.CURRENT_TIME_CHANGED]: () => { if (!this.casting) return; this.castTime = Cast.player.currentTime || 0; this.updateTime(); },
      [T.IS_PAUSED_CHANGED]: () => { if (!this.casting) return; $('[data-a=toggle]', this.root).textContent = Cast.player.isPaused ? '▶' : '❚❚'; this.report(); this.showControls(); this.partySend(); },
      [T.PLAYER_STATE_CHANGED]: () => {
        if (!this.casting) return;
        // IDLE after playing to the end: same as reaching the end locally.
        if (Cast.player.playerState === 'IDLE' && this.duration && this.castTime > this.duration - 5) { this.castFinished = true; this.onEnded(); }
      },
    };
    for (const [ev, fn] of Object.entries(this.castHandlers)) Cast.controller.addEventListener(ev, fn);
  }

  unbindCastEvents() {
    if (!this.castBound) return;
    for (const [ev, fn] of Object.entries(this.castHandlers)) Cast.controller.removeEventListener(ev, fn);
    this.castBound = false;
  }

  stopCasting(disconnect = true) {
    if (!this.casting) return;
    this.report();
    const t = this.castTime;
    this.casting = false;
    this.unbindCastEvents();
    this.root.classList.remove('casting');
    $('.p-cast-msg', this.root).hidden = true;
    if (disconnect) Cast.disconnect();
    if (!this.castFinished && this.root.isConnected) { this.v.removeAttribute('src'); this.load(t); }
  }

  close() {
    if (state.inAppNav) history.back();
    else location.hash = `#/item/${this.item.id}`;
  }

  playNext(auto = false) {
    if (!this.item.next) return;
    // Three episodes in a row started by themselves, with nobody touching anything: ask first
    // (as the TV apps do), so a forgotten TV doesn't play all night.
    if (auto && (Number(new URLSearchParams(location.hash.split('?')[1] || '').get('chain')) || 0) >= 3) return this.askStillWatching();
    // Leaving during the credits counts as having watched the episode.
    if (this.item.credits && this.time >= this.item.credits.start - 1) {
      this.markedWatched = true; // (and no position report afterwards, which would undo it)
      fetch(`/api/items/${this.item.id}/watched`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true, body: '{"watched":true}' }).catch(() => {});
    }
    // In a watch party, everyone moves on to the next episode together.
    if (this.partyId) this.partyPost({ itemId: this.item.next.id, playing: true, position: 0 });
    const chain = auto && !this.touched ? (Number(new URLSearchParams(location.hash.split('?')[1] || '').get('chain')) || 0) + 1 : 0;
    location.replace(`#/play/${this.item.next.id}?t=0${this.partyId ? `&party=${this.partyId}` : ''}${chain ? `&chain=${chain}` : ''}`);
  }

  askStillWatching() {
    $('.p-upnext', this.root)?.remove();
    const box = document.createElement('div');
    box.className = 'p-upnext';
    box.innerHTML = html`<div><b>Are you still watching?</b></div><div class="muted">${this.item.showTitle || this.item.title}</div>
      <div class="row"><button class="btn primary small" data-a="still-yes">Continue watching</button><button class="btn small" data-a="still-no">Back to browsing</button></div>`.s;
    this.root.append(box);
    this.root.classList.remove('idle');
    $('[data-a=still-yes]', box).onclick = () => { this.touched = true; this.playNext(); };
    $('[data-a=still-no]', box).onclick = () => this.close();
    $('[data-a=still-yes]', box).focus();
  }

  // ---- watch together ----
  async partyClicked() {
    if (!this.partyId) {
      try {
        // The party starts exactly where (and as) this player is.
        const p = await api('/api/parties', { method: 'POST', body: { itemId: this.item.id, position: this.time, playing: !this.paused } });
        this.joinParty(p.id);
        history.replaceState(null, '', `#/play/${this.item.id}?party=${p.id}`);
      } catch (err) { return toast(err.message, true); }
    }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    const link = `${location.origin}${location.pathname}#/party/${this.partyId}`;
    const m = openModal({
      title: 'Watch together',
      body: html`<div class="form">
        <p style="margin:0">Send this link to people with an account on this server. Play, pause and skipping stay in sync for everyone, and so does moving on to the next episode.</p>
        <div class="row"><input class="input" readonly value="${link}" id="party-link" style="flex:1"><button class="btn small primary" id="party-copy">Copy</button></div>
        <p class="muted" style="margin:0">Watching now: <b id="party-members">${(this.partyState?.members || []).join(', ') || '…'}</b></p>
      </div>`.s,
      footer: html`<button class="btn danger" id="party-leave">Leave the party</button><button class="btn" data-close>Close</button>`.s,
    });
    $('#party-copy', m.el).onclick = () => { $('#party-link', m.el).select(); navigator.clipboard?.writeText(link).then(() => toast('Link copied'), () => document.execCommand('copy')); };
    $('#party-leave', m.el).onclick = () => { this.leaveParty(); m.close(); toast('You left the watch party'); };
    m.el.querySelector('footer [data-close]').onclick = () => m.close();
  }

  joinParty(id) {
    this.partyId = id;
    this.clientId = Math.random().toString(36).slice(2, 12);
    this.clockOffset = 0;
    this.es = new EventSource(`/api/parties/${id}/events?client=${this.clientId}`);
    this.es.onmessage = (e) => this.onPartyState(JSON.parse(e.data));
    this.es.onerror = () => {
      if (this.es?.readyState === EventSource.CLOSED) { toast('The watch party has ended', true); this.leaveParty(); }
    };
    this.root.classList.add('in-party');
    this.driftTimer = setInterval(() => this.checkDrift(), 4000);
  }

  leaveParty() {
    this.es?.close();
    this.es = null;
    clearInterval(this.driftTimer);
    this.partyId = null;
    this.partyState = null;
    this.root.classList.remove('in-party');
    $('.p-party-count', this.root).textContent = '';
    if (location.hash.includes('party=')) history.replaceState(null, '', `#/play/${this.item.id}`);
  }

  onPartyState(s) {
    this.partyState = s;
    this.clockOffset = s.serverNow - Date.now();
    $('.p-party-count', this.root).textContent = s.members.length > 1 ? String(s.members.length) : '';
    $('[data-a=party]', this.root).title = `Watch together: ${s.members.join(', ')}`;
    const names = $('#party-members'); if (names) names.textContent = s.members.join(', ');
    if (s.from === this.clientId) return; // our own change coming back
    if (s.itemId !== this.item.id) { location.replace(`#/play/${s.itemId}?t=0&party=${s.id}`); return; }
    this.applyParty();
  }

  // Does this player match the party (playing/paused, and within `slack` seconds)?
  inSync(slack) {
    const s = this.partyState;
    return s.playing === !this.paused && Math.abs(this.time - partyPosition(s, this.clockOffset)) < slack;
  }

  // Bring this player in line with the party.
  applyParty() {
    const s = this.partyState;
    const t = partyPosition(s, this.clockOffset);
    if (Math.abs(this.time - t) > 1.5) this.seek(t);
    if (s.playing === this.paused) this.toggle();
  }

  // Every few seconds: catch up if this player fell behind (slow connection) or missed a change.
  checkDrift() {
    if (!this.partyState || this.v.seeking || (!this.casting && this.v.readyState < 3)) return;
    if (Date.now() - (this.lastPartySend || 0) < 3000) return; // our own change is on its way
    if (!this.inSync(2.5)) this.applyParty();
  }

  // After a play, pause or seek: if this player now differs from the party, the person here did
  // something, so tell everyone. (Changes made to follow the party match it, so they aren't echoed.)
  partySend() {
    if (!this.partyId || !this.partyState) return;
    clearTimeout(this.partySendTimer);
    this.partySendTimer = setTimeout(() => {
      if (!this.partyState || this.inSync(1.5)) return;
      this.lastPartySend = Date.now();
      this.partyPost({ itemId: this.item.id, playing: !this.paused, position: this.time });
    }, 250);
  }

  partyPost(state) {
    fetch(`/api/parties/${this.partyId}/state`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ clientId: this.clientId, ...state }),
    }).catch(() => {});
  }

  onEnded() {
    // A stream that stops well before the end may just be the server restarting.
    if (this.mode !== 'direct' && this.duration && this.time < this.duration - 60) {
      serverUp().then((up) => { if (!this.root.isConnected) return; if (up) this.finish(); else this.reconnect(); });
      return;
    }
    this.finish();
  }
  finish() {
    this.report();
    if (!this.item.next) return setTimeout(() => this.close(), 800);
    this.showUpNext(false);
  }

  // "Up next" card: at the end of an episode, or as soon as its credits start.
  showUpNext(atCredits) {
    if ($('.p-upnext', this.root)) return;
    const n = this.item.next;
    const auto = playerPref('autoplayNext');
    let left = 10;
    const box = document.createElement('div');
    box.className = 'p-upnext';
    box.innerHTML = html`<div class="muted">${auto ? html`Up next in <b id="un-count">${left}</b>s` : 'Up next'}</div>
      <img src="${artUrl('thumb', n)}" alt="">
      <div><b>${epLabel(n)}</b> — ${n.title}</div>
      <div class="row"><button class="btn primary small" data-a="next">▶ Play now</button>
        <button class="btn small" data-a="cancel-next">${atCredits ? 'Watch credits' : 'Cancel'}</button></div>`.s;
    this.root.append(box);
    this.root.classList.remove('idle');
    if (!auto) {
      // Without a countdown, the card at the credits fades like the skip buttons (N still plays next).
      const fade = playerPref('skipFade');
      if (atCredits && fade > 0) setTimeout(() => { box.classList.add('faded'); setTimeout(() => box.remove(), 700); }, fade * 1000);
      return;
    }
    this.upNextTimer = setInterval(() => {
      if (atCredits && this.paused) return; // the countdown waits while paused
      left--;
      const c = $('#un-count', box); if (c) c.textContent = left;
      if (left <= 0) { clearInterval(this.upNextTimer); this.playNext(true); }
    }, 1000);
  }

  setSpeed(rate) {
    // defaultPlaybackRate survives the source reloads that seeking in a transcode causes.
    this.v.defaultPlaybackRate = rate;
    this.v.playbackRate = rate;
    const sel = $('[data-a=speed]', this.root);
    if (sel) sel.value = String(rate);
  }

  stepSpeed(dir) {
    const rates = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    const i = rates.indexOf(this.v.playbackRate);
    const next = rates[Math.max(0, Math.min(rates.length - 1, (i === -1 ? 2 : i) + dir))];
    this.setSpeed(next);
    toast(`Speed: ${next === 1 ? 'normal' : `${next}×`}`);
  }

  togglePip() {
    if (!document.pictureInPictureEnabled || this.casting) return;
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    else this.v.requestPictureInPicture().catch(() => {});
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else this.root.requestFullscreen?.().catch(() => {});
  }

  bind() {
    const v = this.v;
    v.addEventListener('timeupdate', () => { if (!this.casting) this.updateTime(); });
    v.addEventListener('loadedmetadata', () => { if (this.mode === 'transcode') this.pendingStart = null; });
    v.addEventListener('seeked', () => { this.pendingStart = null; });
    v.addEventListener('playing', () => { this.pendingStart = null; this.lastGood = this.time; });
    v.addEventListener('timeupdate', () => { if (!v.paused && !this.reconnecting && v.readyState >= 3) this.lastGood = this.time; });
    v.addEventListener('progress', () => this.updateBuffer());
    v.addEventListener('waiting', () => { this.spinner(true); this.watchStall(); });
    v.addEventListener('seeking', () => this.spinner(true));
    for (const ev of ['playing', 'canplay', 'seeked', 'pause']) v.addEventListener(ev, () => { if (ev !== 'pause' || v.readyState >= 3) this.spinner(false); });
    // Paused for a moment: who's in it (each opens their page).
    const castBox = $('.p-cast', this.root);
    v.addEventListener('play', () => { $('[data-a=toggle]', this.root).textContent = '❚❚'; this.showControls(); clearTimeout(this.castTimer); if (castBox) castBox.hidden = true; });
    v.addEventListener('pause', () => {
      if (this.casting) return;
      $('[data-a=toggle]', this.root).textContent = '▶'; this.showControls(); this.report();
      clearTimeout(this.castTimer);
      if (castBox) this.castTimer = setTimeout(() => { if (this.v.paused && !this.v.ended) castBox.hidden = false; }, 2500);
    });
    v.addEventListener('ended', () => { if (!this.casting) this.onEnded(); });
    for (const ev of ['play', 'pause', 'seeked']) v.addEventListener(ev, () => { if (!this.casting) this.partySend(); });
    v.addEventListener('volumechange', () => {
      store.set('volume', v.volume); store.set('muted', v.muted);
      $('[data-a=mute]', this.root).textContent = v.muted || v.volume === 0 ? '🔇' : '🔊';
      $('.p-volume', this.root).value = v.muted ? 0 : v.volume;
    });
    v.addEventListener('error', async () => {
      if (!v.error || !v.getAttribute('src') || this.casting || this.reconnecting) return;
      if (!(await serverUp())) return this.reconnect();
      if (!this.root.isConnected) return;
      if (this.mode === 'direct') {
        // Browser refused the original file: fall back to server-side transcoding.
        toast('Direct play failed — switching to transcoding');
        const t = this.time;
        this.directFailed = true;
        if (this.item.media?.video?.codec === 'hevc') this.hevcFailed = true;
        this.setModeFromQuality();
        this.load(t);
      } else if (this.mode === 'hls') {
        this.hlsFailed(v.error.message || `media error ${v.error.code}`);
      } else if (this.hevcQuery()) {
        // The browser couldn't play the HEVC picture after all: convert it.
        const t = this.time;
        this.hevcFailed = true;
        this.load(t);
      } else {
        this.spinner(false);
        const msg = document.createElement('div');
        msg.className = 'p-center-msg';
        msg.innerHTML = html`<h2>Playback error</h2><p class="muted">The server could not stream this file. Check the server log for ffmpeg output.</p><button class="btn" data-a="close">Go back</button>`.s;
        this.root.append(msg);
      }
    });
    v.addEventListener('click', () => this.toggle());
    v.addEventListener('dblclick', () => this.toggleFullscreen());

    this.root.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'close') this.close();
      else if (a === 'toggle') this.toggle();
      else if (a === 'back') this.seek(this.time - 10);
      else if (a === 'fwd') this.seek(this.time + 30);
      else if (a === 'mute') v.muted = !v.muted;
      else if (a === 'fs') this.toggleFullscreen();
      else if (a === 'next') this.playNext();
      else if (a === 'cancel-next') { clearInterval(this.upNextTimer); $('.p-upnext', this.root)?.remove(); }
      else if (a === 'pip') this.togglePip();
      else if (a === 'night') { this.setNight(!this.night); savePlayerPrefs({ nightMode: this.night }).catch(() => {}); toast(this.night ? 'Night mode on: clearer dialogue, quieter loud scenes' : 'Night mode off'); }
      else if (a === 'skip-intro' && this.skipPart === 'credits') this.close(); // leaving in the credits counts as watched
      else if (a === 'skip-intro' && this.skipPart === 'recap') { this.seek(this.item.recap.end); $('[data-a=skip-intro]', this.root).hidden = true; }
      else if (a === 'skip-intro' && this.item.intro) { this.seek(this.item.intro.end); $('[data-a=skip-intro]', this.root).hidden = true; }
      else if (a === 'cast') this.castClicked();
      else if (a === 'party') this.partyClicked();
      else if (a === 'intro-edit') { v.pause(); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); openIntroEditor(this.item.id).catch((err) => toast(err.message, true)); }
      else if (a === 'cast-stop') this.stopCasting(true);
      else if (a === 'airplay') v.webkitShowPlaybackTargetPicker?.();
    });
    this.root.addEventListener('change', (e) => {
      const a = e.target.dataset.a;
      if (a === 'subs' && e.target.value === '__search') {
        e.target.value = this.subId || '';
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        openSubtitleSearch(this.item.id, (detail, added) => {
          this.item.subtitles = detail.subtitles;
          e.target.innerHTML = this.subOptions().s;
          e.target.value = added;
          e.target.dispatchEvent(new Event('change', { bubbles: true }));
        });
        return;
      }
      if (a === 'subs') {
        const burnBefore = this.burn;
        this.subId = e.target.value || null; store.set('subsOn', !!this.subId);
        this.rememberTracks();
        if (this.burn !== burnBefore) {
          // Picture subtitles switched on, off or changed: the video itself changes.
          if (this.burn != null) toast('Picture subtitles are drawn into the video, so it is converted');
          this.setModeFromQuality();
          if (this.casting) this.startCasting(this.time); else { this.v.removeAttribute('src'); this.load(this.time); }
        } else if (this.casting) Cast.setSubtitle(this.item.subtitles.filter((s) => s.burn == null).findIndex((s) => s.id === this.subId));
        else this.applySubs();
      }
      if (a === 'speed') this.setSpeed(Number(e.target.value));
      if (a === 'quality') this.setQuality(e.target.value);
      if (a === 'audio') {
        this.audio = Number(e.target.value);
        this.rememberTracks();
        this.setModeFromQuality();
        if (this.casting) this.startCasting(this.time); else this.load(this.time);
      }
    });
    $('.p-volume', this.root).addEventListener('input', (e) => { v.volume = Number(e.target.value); v.muted = v.volume === 0; });

    const hover = $('.p-hover-time', this.root);
    const thumb = $('.p-hover-thumb', this.root);
    // Time label + preview picture over the seek bar at fraction f.
    const preview = (f) => {
      hover.hidden = false;
      hover.style.left = `${f * 100}%`;
      const chapter = this.chapterAt(f * this.total);
      hover.textContent = chapter ? `${fmtClock(f * this.total)} · ${chapter}` : fmtClock(f * this.total);
      this.showThumb(thumb, f);
    };
    const hidePreview = () => { hover.hidden = true; thumb.hidden = true; };
    this.range.addEventListener('input', () => {
      this.dragging = true;
      this.range.style.setProperty('--pct', `${pct(Number(this.range.value), this.total)}%`);
      this.updateTime();
      if (this.total) preview(Number(this.range.value) / this.total); // also while dragging on touch screens
    });
    this.range.addEventListener('change', () => { this.dragging = false; hidePreview(); this.seek(Number(this.range.value)); });
    this.range.addEventListener('mousemove', (e) => {
      const r = this.range.getBoundingClientRect();
      preview(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
    });
    this.range.addEventListener('mouseleave', hidePreview);

    this.onMove = () => this.showControls();
    this.root.addEventListener('mousemove', this.onMove);
    this.root.addEventListener('touchstart', this.onMove, { passive: true });
    // Any key, tap or click counts as someone being there ("Are you still watching?").
    this.root.addEventListener('pointerdown', () => { this.touched = true; });
    this.onKey = (e) => {
      this.touched = true;
      if (['SELECT', 'INPUT', 'TEXTAREA'].includes(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      const handled = {
        ' ': () => this.toggle(), k: () => this.toggle(),
        ArrowLeft: () => this.seek(this.time - 10), j: () => this.seek(this.time - 10),
        ArrowRight: () => this.seek(this.time + 30), l: () => this.seek(this.time + 30),
        ArrowUp: () => { v.volume = Math.min(1, v.volume + 0.05); v.muted = false; },
        ArrowDown: () => { v.volume = Math.max(0, v.volume - 0.05); },
        m: () => { v.muted = !v.muted; }, f: () => this.toggleFullscreen(),
        c: () => { const sel = $('[data-a=subs]', this.root); if (!sel) return; sel.value = this.subId ? '' : (this.pickDefaultSub() || ''); sel.dispatchEvent(new Event('change', { bubbles: true })); },
        s: () => { const b = $('[data-a=skip-intro]', this.root); if (b && !b.hidden) b.click(); },
        Escape: () => { if (!document.fullscreenElement) this.close(); },
        // TV remotes
        MediaPlayPause: () => this.toggle(), MediaPlay: () => this.toggle(), MediaPause: () => this.toggle(),
        MediaFastForward: () => this.seek(this.time + 30), MediaRewind: () => this.seek(this.time - 10),
        GoBack: () => this.close(), BrowserBack: () => this.close(),
        Enter: () => { if (!e.target.closest?.('button, select, input, a')) this.toggle(); },
        n: () => { if (this.item.next) this.playNext(); },
        p: () => this.togglePip(),
        '<': () => this.stepSpeed(-1), '>': () => this.stepSpeed(1),
      }[k];
      if (handled) { e.preventDefault(); handled(); this.showControls(); }
    };
    document.addEventListener('keydown', this.onKey);
  }

  // Stuck loading for a while: if the server has gone away, wait for it rather than spin forever.
  watchStall() {
    clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(async () => {
      if (!this.root.isConnected || this.casting || this.reconnecting || this.v.readyState >= 3 || this.v.paused) return;
      if (!(await serverUp())) this.reconnect();
    }, 10_000);
  }

  // The server went away mid-film (restarting into an update, the PC rebooting): wait for it to come
  // back (up to a minute and a half), then carry on from the same moment.
  reconnect() {
    if (this.reconnecting || this.casting || !this.root.isConnected) return;
    const t = this.v.seeking || this.lastGood == null ? this.time : this.lastGood; // (mid-seek: where it was going)
    const paused = this.v.paused && this.v.readyState >= 2 && !this.v.ended;
    this.reconnecting = true;
    clearTimeout(this.stallTimer);
    this.destroyHls();
    this.v.pause();
    this.spinner(false);
    $('.p-center-msg', this.root)?.remove();
    const box = document.createElement('div');
    box.className = 'p-center-msg p-reconnect';
    box.innerHTML = html`<div class="spinner"></div><h2>Reconnecting to Marquee…</h2><p class="muted">The server is restarting. This carries on where you were in a moment.</p>`.s;
    this.root.append(box);
    const started = Date.now();
    const attempt = async () => {
      if (!this.root.isConnected) return;
      if (await serverUp()) {
        // A restarted server has forgotten its streaming sessions: ask for fresh links.
        try { this.pb = await api(`/api/items/${this.item.id}/playback`); } catch { /* the old ones may still do */ }
        if (!this.root.isConnected) return;
        box.remove();
        this.reconnecting = false;
        if (this.mode === 'direct') this.v.removeAttribute('src'); // load() only re-points a fresh element
        this.load(t);
        if (paused) this.v.addEventListener('playing', () => this.v.pause(), { once: true });
        return;
      }
      if (Date.now() - started < 90_000) { this.reconnectTimer = setTimeout(attempt, 2000); return; }
      this.reconnecting = false;
      box.innerHTML = html`<h2>Can't reach Marquee</h2><p class="muted">The server hasn't come back yet. Check the PC it runs on.</p>
        <div class="row" style="justify-content:center"><button class="btn primary" data-a="reconnect">Try again</button><button class="btn" data-a="close">Go back</button></div>`.s;
      $('[data-a=reconnect]', box).onclick = () => { box.remove(); this.lastGood = t; this.reconnect(); };
    };
    this.reconnectTimer = setTimeout(attempt, 2000);
  }

  destroy() {
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.stallTimer);
    this.report(true);
    clearInterval(this.reportTimer);
    clearInterval(this.upNextTimer);
    clearTimeout(this.idleTimer);
    document.removeEventListener('keydown', this.onKey);
    this.offCast?.();
    this.es?.close();
    clearInterval(this.driftTimer);
    if (this.casting) {
      // Leaving the player stops the video on the TV but stays connected, so the next one casts too.
      this.unbindCastEvents();
      if (!this.castFinished) Cast.controller?.stop();
      this.casting = false;
    }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (document.pictureInPictureElement === this.v) document.exitPictureInPicture().catch(() => {});
    this.destroyHls();
    this.v.pause();
    this.v.removeAttribute('src'); // stops the download and lets the server kill ffmpeg
    this.v.load();
    if (this.pb?.sid && this.quality !== 'original') fetch(`/api/hls/${this.pb.sid}`, { method: 'DELETE', keepalive: true }).catch(() => {});
    this.root.remove();
    document.title = 'Marquee';
  }
}

// ---------- router ----------
function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = h.split('?');
  return { path: path || '/', query: new URLSearchParams(qs || '') };
}

const routes = [
  [/^\/$/, viewHome],
  [/^\/library\/(\w+)$/, viewLibrary],
  [/^\/show\/(\w+)$/, viewShow],
  [/^\/item\/(\w+)$/, viewItem],
  [/^\/play\/(\w+)$/, viewPlay],
  [/^\/search$/, viewSearch],
  [/^\/settings(?:\/(\w+))?$/, viewSettings],
  [/^\/account$/, viewAccount],
  [/^\/account\/history$/, viewHistory],
  [/^\/link$/, viewAccount],
  [/^\/downloads$/, viewDownloads],
  [/^\/watchlist$/, viewWatchlist],
  [/^\/requests$/, viewRequests],
  [/^\/collections$/, viewCollections],
  [/^\/activity$/, viewActivity],
  [/^\/party\/(\w+)$/, viewParty],
  [/^\/collection\/([\w-]+)$/, viewCollection],
  [/^\/person\/(.+)$/, viewPerson],
];

// Scroll position per page, so "back" returns to where you were in a long library.
const scrollMemo = new Map();
let lastPath = null;

// The pop-up layer for movie, show and episode pages. `openedFromPage`: it was opened from a page in
// the app (so closing goes back to it); otherwise (a link opened directly) closing goes home.
let openedFromPage = false;
// Titles opened from inside the pop-up (an episode from its show, a film from "More like this"):
// where you came from, so ‹ Back returns there, scrolled to where you were. Moving to the next or
// previous episode (data-swap) doesn't add a step: Back from any of them goes to the show.
let detailTrail = [];
let detailScroll = null;
const hashPath = (h) => h.replace(/^#/, '').split('?')[0];
function detailBack() {
  const prev = detailTrail.pop();
  if (!prev) return false;
  detailScroll = prev.scroll;
  location.replace(prev.hash);
  return true;
}
function openDetailLayer() {
  if (!$('#detail-layer')) {
    detailTrail = [];
    openedFromPage = !firstRoute && !!view.dataset.path;
    tv.returnHref = document.activeElement?.getAttribute?.('href') || null;
    $('#detail-root').innerHTML = '<div class="detail-layer" id="detail-layer"><div class="dlg" id="detail-panel" role="dialog" aria-modal="true" aria-label="Details"></div></div>';
    $('#detail-layer').addEventListener('mousedown', (e) => { if (e.target.id === 'detail-layer') closeDetail(); });
    // Moving between titles inside the pop-up replaces it, so closing (or Back) returns to the page.
    $('#detail-layer').addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="#/show/"], a[href^="#/item/"]');
      if (!a || e.defaultPrevented || e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      const to = a.getAttribute('href');
      if (hashPath(to) === hashPath(location.hash)) return;
      // Going back to where you came from (an episode's link to its show) is the same as ‹ Back.
      if (detailTrail.length && hashPath(detailTrail.at(-1).hash) === hashPath(to)) { detailBack(); return; }
      if (!a.hasAttribute('data-swap')) {
        const title = $('#detail-panel .dlg-title')?.textContent.trim() || 'Back';
        detailTrail.push({ hash: location.hash, scroll: $('#detail-layer').scrollTop, title: title.length > 28 ? `${title.slice(0, 27)}…` : title });
      }
      location.replace(to);
    });
  }
  viewEl = $('#detail-panel');
  document.body.classList.add('detail-open');
}
function closeDetailLayer() {
  viewEl = view;
  detailTrail = [];
  if (!$('#detail-layer')) return;
  $('#detail-root').innerHTML = '';
  document.body.classList.remove('detail-open');
}
function closeDetail() {
  if (openedFromPage) history.back();
  else location.hash = '#/';
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !$('#detail-layer') || player || openPop || $('.modal-backdrop') || $('.profile-picker')) return;
  closeDetail();
});

async function router() {
  if (!state.user) return;
  const { path, query } = parseHash();
  document.body.classList.remove('nav-open');
  if ($('#user-pop')) $('#user-pop').hidden = true;
  const isPlay = path.startsWith('/play/');
  const isDetail = /^\/(show|item)\//.test(path);
  if (!isPlay) closePlayer();
  if (path !== '/search' && !isPlay) { $('#search-input').value = ''; if (document.activeElement !== $('#search-input')) $('#search-form').classList.remove('open'); }
  renderNav();
  endSelect();
  closePreview();
  if (isPlay || isDetail) pauseHero();
  const seq = ++renderSeq;
  const changedPage = path !== lastPath;
  if (!isDetail && changedPage && lastPath && !lastPath.startsWith('/play/')) scrollMemo.set(lastPath, window.scrollY);
  if (!isPlay && !isDetail) lastPath = path;
  // On a TV, the pages made for a keyboard point to a phone or computer instead.
  const match = tv.on && TV_ELSEWHERE.test(path) ? [/^.*$/, viewTvElsewhere] : routes.find(([re]) => re.test(path));
  if (!match) { closeDetailLayer(); return setView(seq, html`<div class="empty"><h2>Page not found</h2><a class="btn" href="#/">Go home</a></div>`); }
  if (isDetail) {
    // Movies, shows and episodes open over the page you were on.
    openDetailLayer();
    viewEl.onclick = null;
    if (viewEl.dataset.path !== path) { viewEl.innerHTML = '<div class="spinner"></div>'; $('#detail-layer').scrollTop = 0; }
    viewEl.dataset.path = path;
  } else if (!isPlay) {
    closeDetailLayer();
    view.onclick = null;
    if (!view.innerHTML || !view.dataset.path || view.dataset.path !== path) {
      view.className = '';
      view.innerHTML = '<div class="spinner"></div>';
      window.scrollTo(0, 0);
    }
    view.dataset.path = path;
    document.title = 'Marquee';
  }
  try {
    await match[1]({ params: match[0].exec(path).slice(1), query, seq });
    if (isDetail && detailScroll != null && seq === renderSeq) {
      const top = detailScroll;
      detailScroll = null;
      requestAnimationFrame(() => { if ($('#detail-layer')) $('#detail-layer').scrollTop = top; });
    }
    if (seq === renderSeq && !isPlay) tvStart();
    if (!isPlay && changedPage && seq === renderSeq && scrollMemo.has(path)) {
      requestAnimationFrame(() => window.scrollTo(0, scrollMemo.get(path)));
    }
  } catch (err) {
    if (isPlay) { toast(err.message, true); return; }
    setView(seq, html`<div class="empty"><h2>Something went wrong</h2><p class="error-box" style="display:inline-block">${err.message}</p><br><a class="btn" href="#/">Go home</a></div>`);
  }
}

// The Android app's player closed: refresh progress, Continue Watching, etc.
window.addEventListener('marquee-native-closed', () => router());

let firstRoute = true;
window.addEventListener('hashchange', () => {
  if (!firstRoute) state.inAppNav = true;
  router();
});

// Search box: live results with debounce.
let searchTimer;
$('#search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = e.target.value;
    const target = `#/search?q=${encodeURIComponent(q)}`;
    if (parseHash().path === '/search') { history.replaceState(null, '', target); router(); }
    else location.hash = target;
  }, 250);
});
$('#search-form').addEventListener('submit', (e) => e.preventDefault());
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !player && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) { e.preventDefault(); openSearch(); }
});

async function startApp() {
  document.body.classList.remove('auth-mode');
  if (state.user?.mustChangePassword) return showChoosePassword();
  renderUserMenu();
  await Promise.all([refreshLibraries().catch(() => {}), api('/api/status').then((s) => { state.status = s; }).catch(() => {})]);
  view.innerHTML = '';
  await router();
  firstRoute = false;
  pollStatus();
  noteRequests(state.status?.requestsPending);
  // Player settings used to be kept in each browser: bring this browser's over to the account once.
  if (state.user && !state.user.prefsSaved) {
    const old = {};
    for (const k of ['autoplayNext', 'autoSkipIntro']) { const v = store.get(k, null); if (typeof v === 'boolean') old[k] = v; }
    if (Object.keys(old).length) savePlayerPrefs(old).catch(() => {});
  }
  // A shared device can ask who's watching once per visit.
  if (store.get('askProfile', false) && !sessionStorage.getItem('marquee:asked')) {
    try { sessionStorage.setItem('marquee:asked', '1'); } catch { /* ignore */ }
    showProfilePicker({ atStart: true });
  }
}

(async function init() {
  const res = await fetch('/api/auth/me').catch(() => null);
  const data = res ? await res.json().catch(() => ({})) : {};
  if (!res?.ok) return showAuth({ setupRequired: !!data.setupRequired, message: res ? '' : 'Cannot reach the server.' });
  state.user = data.user;
  startApp();
})();
