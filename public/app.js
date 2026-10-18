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
  if (res.status === 401 && state.user) showAuth({ setupRequired: data?.setupRequired, message: 'Your session has ended. Please sign in again.' });
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
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
  return [s, e].filter(Boolean).join(' · ');
}
const sortTitle = (t) => String(t || '').toLowerCase().replace(/^(the|a|an)\s+/, '');
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

// ---------- app state ----------
const state = { user: null, libraries: [], status: null, inAppNav: false };
let renderSeq = 0;
const view = $('#view');
function setView(seq, content) {
  if (seq !== renderSeq) return false;
  view.innerHTML = renderVal(content);
  return true;
}

async function refreshLibraries() {
  state.libraries = await api('/api/libraries');
  renderSidebar();
}

function renderSidebar() {
  const { path } = parseHash();
  const icon = (t) => (t === 'show' ? '📺' : '🎬');
  $('#sidebar').innerHTML = html`
    <a href="#/" class="${path === '/' ? 'active' : ''}">🏠 Home</a>
    <a href="#/watchlist" class="${path === '/watchlist' ? 'active' : ''}">♡ My List</a>
    <div class="section">Libraries</div>
    ${state.libraries.map((l) => html`
      <a href="#/library/${l.id}" class="${path === `/library/${l.id}` ? 'active' : ''}">${icon(l.type)} ${l.name}<span class="count">${l.count}</span></a>`)}
    ${state.libraries.length ? '' : state.user?.role === 'admin' ? html`<a href="#/settings">＋ Add a library</a>` : html`<div class="muted" style="padding:8px 12px;font-size:13px">No libraries shared with you yet.</div>`}
    <div class="section">${state.user?.role === 'admin' ? 'Manage' : 'You'}</div>
    ${state.user?.canDownload ? html`<a href="#/downloads" class="${path === '/downloads' ? 'active' : ''}">⤓ Downloads</a>` : ''}
    ${state.user?.role === 'admin' ? html`<a href="#/activity" class="${path === '/activity' ? 'active' : ''}">📊 Activity</a>` : ''}
    ${state.user?.role === 'admin' ? html`<a href="#/settings" data-nav="settings" class="${path === '/settings' ? 'active' : ''}">⚙ Settings</a>` : ''}
    <a href="#/account" class="${path === '/account' ? 'active' : ''}">👤 Account</a>
  `.s;
  if (state.status) noteUpdateAvailable(state.status);
}

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

// ---------- cards ----------
function progressBar(x) {
  if (!x.progress || x.progress.watched || !x.progress.position) return '';
  return html`<div class="progress"><i style="width:${pct(x.progress.position, x.duration).toFixed(1)}%"></i></div>`;
}
function hrefFor(x) { return x.type === 'show' ? `#/show/${x.id}` : `#/item/${x.id}`; }

function posterCard(x, ctx = '') {
  if (x.type === 'collection') return collectionCard(x);
  const sub = x.type === 'show'
    ? (x.seasonCount > 1 ? `${x.seasonCount} seasons` : `${x.episodeCount} episode${x.episodeCount === 1 ? '' : 's'}`)
    : x.type === 'episode' ? `${x.showTitle} · ${epLabel(x)}` : (x.year || '');
  let badge = '';
  if (x.type === 'show' && x.unwatchedCount > 0) badge = html`<span class="badge" title="Unwatched episodes">${x.unwatchedCount}</span>`;
  else if ((x.type === 'show' && x.episodeCount && !x.unwatchedCount) || x.progress?.watched) badge = html`<span class="badge check" title="Watched">✓</span>`;
  knownItems.set(x.id, x);
  return html`
    <div class="card">
      <div class="art">
        <a class="cover" href="${hrefFor(x)}"><img loading="lazy" src="${artUrl('poster', x)}" alt="${x.title}"></a>
        ${badge}${progressBar(x)}
        <button class="play-hover" data-play="${x.type === 'show' ? `show:${x.id}` : x.id}" aria-label="Play ${x.title}">▶</button>
        <button class="card-menu" data-menu="${x.id}" data-ctx="${ctx}" aria-label="More options for ${x.title}" title="More">⋯</button>
      </div>
      <a href="${hrefFor(x)}"><div class="title" title="${x.title}">${x.title}</div><div class="sub">${sub}</div></a>
    </div>`;
}

function wideCard(x, ctx = '') {
  knownItems.set(x.id, x);
  const isEp = x.type === 'episode';
  const kind = isEp ? 'thumb' : 'backdrop';
  const title = isEp ? x.showTitle : x.title;
  const sub = isEp ? [epLabel(x), x.title].filter(Boolean).join(' — ') : [x.year, x.progress?.position ? `${fmtClock(x.duration - x.progress.position)} left` : ''].filter(Boolean).join(' · ');
  return html`
    <div class="card wide">
      <div class="art">
        <a class="cover" href="${hrefFor(x)}"><img loading="lazy" src="${artUrl(kind, x)}" alt="${title}"></a>
        ${x.progress?.watched ? html`<span class="badge check">✓</span>` : ''}${progressBar(x)}
        <button class="play-hover" data-play="${x.id}" aria-label="Play">▶</button>
        <button class="card-menu" data-menu="${x.id}" data-ctx="${ctx}" aria-label="More options" title="More">⋯</button>
      </div>
      <a href="${hrefFor(x)}"><div class="title" title="${title}">${title}</div><div class="sub" title="${sub}">${sub}</div></a>
    </div>`;
}

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
  location.hash = `#/play/${id}${t != null ? `?t=${t}` : ''}`;
});

// ---------- views ----------
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
      <a class="btn primary" href="#/settings?add=1">Add a library</a></div>`);
  }
  if (!homeData.hubs.length) {
    return setView(seq, html`<div class="empty"><h2>${state.status?.scanning ? 'Scanning your libraries…' : 'No media found yet'}</h2>
      <p>${state.status?.scanning ? 'New items will appear here as they are found.' : 'Check that your library folders contain video files, then scan again.'}</p>
      <a class="btn" href="#/settings">Manage libraries</a></div>`);
  }
  setView(seq, homeData.hubs.map((hub) => html`
    <section class="hub">
      <div class="hub-head"><h2>${hub.title}</h2>${hub.libraryId ? html`<a href="#/library/${hub.libraryId}">See all ›</a>` : hub.link ? html`<a href="${hub.link}">See all ›</a>` : ''}</div>
      <div class="shelf ${hub.style}">${hub.items.map((x) => (hub.style === 'wide' ? wideCard(x, hub.key) : posterCard(x)))}</div>
    </section>`));
}

async function viewLibrary({ params: [id], query, seq }) {
  const [data, cols] = await Promise.all([api(`/api/libraries/${id}/items`), api(`/api/collections?library=${id}`).catch(() => [])]);
  const lib = data.library;
  const prefs = { sort: 'title', filter: 'all', size: 150, ...store.get(`lib:${id}`, {}) };
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
    const grid = $('#lib-grid');
    grid.style.setProperty('--card-w', `${prefs.size}px`);
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
      <input type="range" id="lib-size" min="110" max="230" step="10" value="${prefs.size}" title="Poster size" aria-label="Poster size">
      <button class="btn small" id="lib-shuffle" title="Play something random from this view">⤮ Shuffle</button>
      ${cols.length ? html`<div class="seg" id="lib-group" title="Show titles that are in a collection as the collection, or every title on its own">
        <button data-g="1" class="${groupingOn() ? 'on' : ''}">▦ Collections</button><button data-g="0" class="${groupingOn() ? '' : 'on'}">All titles</button></div>
        <a class="btn small" href="#/collections?library=${id}">Browse collections (${cols.length})</a>` : ''}
      ${state.user.role === 'admin' ? html`<button class="btn small" id="lib-scan">↻ Scan</button>` : ''}
    </div>
    ${genre ? html`<div class="filter-note">Showing <b>${genre}</b> · <a href="#/library/${id}">clear</a></div>` : ''}
    <div class="lib-wrap"><div class="grid sized" id="lib-grid"></div><nav class="jump" id="lib-jump" aria-label="Jump to letter" hidden></nav></div>`)) return;
  render();
  const save = () => store.set(`lib:${id}`, prefs);
  $('#lib-sort').onchange = (e) => { prefs.sort = e.target.value; save(); render(); };
  $('#lib-size').oninput = (e) => { prefs.size = Number(e.target.value); save(); $('#lib-grid').style.setProperty('--card-w', `${prefs.size}px`); };
  $('#lib-text').oninput = (e) => { text = e.target.value; render(); };
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

function backdrop(x) {
  return html`<div class="backdrop"><img src="${artUrl('backdrop', x)}" alt="" onerror="this.remove()"></div>`;
}

// Buttons shared by movie, show and episode pages: My List, Edit (admins), and the ⋯ menu.
function detailActions(x) {
  knownItems.set(x.id, x);
  return html`
    ${x.type !== 'episode' ? html`<button class="btn icon-only ${x.inWatchlist ? 'on' : ''}" id="list-toggle" title="${x.inWatchlist ? 'Remove from My List' : 'Add to My List'}">${x.inWatchlist ? '♥' : '♡'} My List</button>` : ''}
    ${state.user.role === 'admin' ? html`<button class="btn" id="edit-btn">✎ Edit</button>` : ''}
    <button class="btn" data-menu="${x.id}" aria-label="More options">⋯</button>`;
}
function bindDetailActions(x) {
  if ($('#list-toggle')) $('#list-toggle').onclick = () => toggleWatchlist(x).catch((err) => toast(err.message, true));
  if ($('#edit-btn')) $('#edit-btn').onclick = () => openEditor(x.id).catch((err) => toast(err.message, true));
}
function genreChips(x) {
  return x.genres.length ? html`<div class="row">${x.genres.map((g) => html`<a class="chip link" href="#/library/${x.libraryId}?genre=${encodeURIComponent(g)}">${g}</a>`)}</div>` : '';
}
function castList(x) {
  return x.cast?.length ? html`<div class="cast"><h3>Cast</h3><div class="cast-list">${x.cast.map((c) => html`
    <div class="cast-member"><span class="cast-initial">${c.name.slice(0, 1)}</span><span><b>${c.name}</b>${c.character ? html`<br><span class="muted">${c.character}</span>` : ''}</span></div>`)}</div></div>` : '';
}
function matchNote(x) {
  if (state.user.role !== 'admin' || !x.match) return '';
  if (x.match.notFound) return html`<p class="match-note">No online match was found. <button class="link-btn" data-fix-match="${x.type === 'episode' ? x.showId : x.id}">Find a match…</button></p>`;
  return '';
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-fix-match]');
  if (b) openMatcher(b.dataset.fixMatch).catch((err) => toast(err.message, true));
});

// Trailers, featurettes and other extras on a movie or show page.
function extrasRow(list) {
  if (!list?.length) return '';
  return html`<section class="hub extras"><div class="hub-head"><h2>Extras</h2></div><div class="grid wide">${list.map((x) => {
    knownItems.set(x.id, x);
    const sub = [x.title !== x.extraLabel ? x.extraLabel : '', fmtDuration(x.duration)].filter(Boolean).join(' · ');
    return html`<div class="card wide">
      <div class="art">
        <a class="cover" href="#/item/${x.id}"><img loading="lazy" src="${artUrl('thumb', x)}" alt="${x.title}"></a>
        ${progressBar(x)}<button class="play-hover" data-play="${x.id}" data-t="0" aria-label="Play">▶</button>
      </div>
      <a href="#/item/${x.id}"><div class="title" title="${x.title}">${x.title}</div><div class="sub">${sub}</div></a>
    </div>`;
  })}</div></section>`;
}

async function viewShow({ params: [id], query, seq }) {
  const show = await api(`/api/shows/${id}`);
  const seasonKey = (s) => String(s.season);
  let current = query.get('season') ?? (show.upNext ? String(show.upNext.season) : show.seasons[0] && seasonKey(show.seasons[0]));
  if (!show.seasons.some((s) => seasonKey(s) === current)) current = show.seasons[0] && seasonKey(show.seasons[0]);
  const up = show.upNext;
  const upLabel = up ? `${up.progress?.position && !up.progress.watched ? 'Resume' : 'Play'} ${epLabel(up)}` : null;

  const episodeRow = (e) => { knownItems.set(e.id, e); return html`
    <div class="episode">
      <div class="art">
        <a href="#/item/${e.id}"><img loading="lazy" src="${artUrl('thumb', e)}" alt="${e.title}"></a>
        ${progressBar(e)}
        <button class="play-hover" data-play="${e.id}" aria-label="Play">▶</button>
      </div>
      <a href="#/item/${e.id}">
        <div class="ep-title">${e.episode != null ? `${e.episode}. ` : ''}${e.title}</div>
        <div class="muted" style="font-size:13px">${[epLabel(e), fmtDuration(e.duration)].filter(Boolean).join(' · ')}</div>
        ${e.overview ? html`<div class="ep-overview">${e.overview}</div>` : ''}
      </a>
      <div class="ep-actions">
        <button class="watch-toggle ${e.progress?.watched ? 'on' : ''}" data-watch="${e.id}" title="${e.progress?.watched ? 'Mark unwatched' : 'Mark watched'}">✓</button>
        <button class="card-menu static" data-menu="${e.id}" aria-label="More options">⋯</button>
      </div>
    </div>`; };

  const renderSeason = () => {
    const season = show.seasons.find((s) => seasonKey(s) === current);
    $$('.seasons-nav button').forEach((b) => b.classList.toggle('primary', b.dataset.season === current));
    const allWatched = season.episodes.every((e) => e.progress?.watched);
    $('#season-body').innerHTML = html`
      <div class="row" style="justify-content:space-between;margin-bottom:8px">
        <h2>${season.title} <span class="muted" style="font-weight:400;font-size:14px">${season.episodes.length} episodes</span></h2>
        <button class="btn small" id="season-watch">${allWatched ? 'Mark season unwatched' : 'Mark season watched'}</button>
      </div>
      <div class="episodes">${season.episodes.map(episodeRow)}</div>`.s;
    $('#season-watch').onclick = async () => {
      await api(`/api/shows/${id}/watched`, { method: 'POST', body: { season: season.season, watched: !allWatched } });
      router();
    };
  };

  const allWatched = show.unwatchedCount === 0;
  if (!setView(seq, html`
    <div class="detail">
      ${backdrop(show)}
      <div class="detail-body">
        <div class="poster"><img src="${artUrl('poster', show)}" alt="${show.title}"></div>
        <div class="info">
          <h1>${show.title}</h1>
          <div class="meta-line">
            ${show.year ? html`<span>${show.year}</span>` : ''}
            <span>${show.seasonCount} season${show.seasonCount === 1 ? '' : 's'}</span>
            <span>${show.episodeCount} episodes</span>
            ${show.unwatchedCount ? html`<span>${show.unwatchedCount} unwatched</span>` : ''}
            ${show.rating ? html`<span>★ ${show.rating}</span>` : ''}
          </div>
          ${genreChips(show)}
          ${collectionChips(show)}
          ${show.overview ? html`<p class="overview">${show.overview}</p>` : ''}
          ${matchNote(show)}
          <div class="row actions">
            ${up ? html`<button class="btn primary" data-play="${up.id}">▶ ${upLabel}</button>` : ''}
            <button class="btn" id="show-watch">${allWatched ? 'Mark unwatched' : 'Mark all watched'}</button>
            ${detailActions(show)}
          </div>
          ${castList(show)}
        </div>
      </div>
    </div>
    <div class="seasons-nav">${show.seasons.map((s) => html`<button class="btn small" data-season="${seasonKey(s)}">${s.title}</button>`)}</div>
    <div id="season-body"></div>
    ${extrasRow(show.extras)}`)) return;

  bindDetailActions(show);
  if (current != null) renderSeason();
  $('.seasons-nav').onclick = (e) => {
    const b = e.target.closest('[data-season]'); if (!b) return;
    current = b.dataset.season;
    history.replaceState(null, '', `#/show/${id}?season=${current}`);
    renderSeason();
  };
  $('#show-watch').onclick = async () => { await api(`/api/shows/${id}/watched`, { method: 'POST', body: { watched: !allWatched } }); router(); };
  view.onclick = async (e) => {
    const b = e.target.closest('[data-watch]'); if (!b) return;
    await api(`/api/items/${b.dataset.watch}/watched`, { method: 'POST', body: { watched: !b.classList.contains('on') } });
    router();
  };
}

async function viewItem({ params: [id], seq }) {
  const it = await api(`/api/items/${id}`);
  view.onclick = null;
  const isEp = it.type === 'episode';
  const isExtra = it.type === 'extra';
  const p = it.progress;
  const resumable = p && !p.watched && p.position > 15;
  const v = it.media?.video, a = it.media?.audio?.[0];
  const res = resLabel(v);
  if (!setView(seq, html`
    <div class="detail">
      ${backdrop(it)}
      <div class="detail-body">
        <div class="poster ${isEp || isExtra ? 'wide' : ''}"><img src="${artUrl(isEp || isExtra ? 'thumb' : 'poster', it)}" alt="${it.title}"></div>
        <div class="info">
          ${isEp ? html`<div class="eyebrow"><a href="#/show/${it.showId}?season=${it.season}">${it.showTitle}</a> · ${epLabel(it)}</div>` : ''}
          ${isExtra ? html`<div class="eyebrow">${it.extraLabel}${it.parent ? html` · <a href="#/${it.parent.type === 'show' ? 'show' : 'item'}/${it.parent.id}">${it.parent.title}</a>` : ''}</div>` : ''}
          <h1>${it.title}</h1>
          ${it.tagline ? html`<p class="tagline">${it.tagline}</p>` : ''}
          <div class="meta-line">
            ${it.year && !isEp ? html`<span>${it.year}</span>` : ''}
            ${it.airDate ? html`<span>${it.airDate}</span>` : ''}
            ${it.duration ? html`<span>${fmtDuration(it.duration)}</span>` : ''}
            ${it.rating ? html`<span>★ ${it.rating}</span>` : ''}
            ${res ? html`<span class="chip">${res}</span>` : ''}
            <span class="chip" title="${it.directPlay ? 'Your browser can play this file as-is' : 'Converted on the fly by the server'}">${it.directPlay ? 'Direct Play' : 'Transcode'}</span>
            ${p?.watched ? html`<span class="chip" style="color:var(--accent)">✓ Watched</span>` : ''}
          </div>
          ${genreChips(it)}
          ${collectionChips(it)}
          ${matchNote(it)}
          <div class="row actions">
            ${it.media ? html`
              <button class="btn primary" data-play="${id}" ${resumable ? '' : 'data-t="0"'}>▶ ${resumable ? `Resume from ${fmtClock(p.position)}` : 'Play'}</button>
              ${resumable ? html`<button class="btn" data-play="${id}" data-t="0">Play from start</button>` : ''}` : html`<span class="error-box">This file could not be read by ffprobe.</span>`}
            <button class="btn" id="item-watch">${p?.watched ? 'Mark unwatched' : 'Mark watched'}</button>
            <a class="btn" href="/api/items/${id}/stream?download=1" download title="Download the original file">⤓</a>
            ${detailActions(it)}
          </div>
          ${resumable ? html`<div class="resume-note">${fmtClock(it.duration - p.position)} remaining</div>` : ''}
          ${it.overview ? html`<p class="overview">${it.overview}</p>` : ''}
          ${isEp && (it.prev || it.next) ? html`<div class="row" style="margin:12px 0">
            ${it.prev ? html`<a class="btn small" href="#/item/${it.prev.id}">‹ ${epLabel(it.prev)}</a>` : ''}
            ${it.next ? html`<a class="btn small" href="#/item/${it.next.id}">${epLabel(it.next)} ›</a>` : ''}</div>` : ''}
          ${castList(it)}
          <dl class="tech">
            <dt>File</dt><dd>${it.file || it.fileName}</dd>
            <dt>Size</dt><dd>${fmtSize(it.size)}</dd>
            ${it.media ? html`
              <dt>Container</dt><dd>${it.media.container}</dd>
              ${v ? html`<dt>Video</dt><dd>${v.codec?.toUpperCase()} ${v.profile ? `(${v.profile})` : ''} · ${v.width}×${v.height}</dd>` : ''}
              ${a ? html`<dt>Audio</dt><dd>${it.audioTracks.map((t) => t.label).join(', ')}</dd>` : ''}
              ${it.media.bitrate ? html`<dt>Bitrate</dt><dd>${(it.media.bitrate / 1e6).toFixed(1)} Mbps</dd>` : ''}` : ''}
            <dt>Subtitles</dt><dd>${it.subtitles.length ? it.subtitles.map((s) => s.label).join(', ') : 'None'}</dd>
          </dl>
        </div>
      </div>
    </div>
    ${extrasRow(it.extras)}`)) return;
  bindDetailActions(it);
  $('#item-watch').onclick = async () => {
    await api(`/api/items/${id}/watched`, { method: 'POST', body: { watched: !p?.watched } });
    router();
  };
}

async function viewSearch({ query, seq }) {
  const q = query.get('q') || '';
  if ($('#search-input') !== document.activeElement) $('#search-input').value = q;
  if (!q.trim()) return setView(seq, html`<div class="empty">Type to search your libraries.</div>`);
  const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
  const total = r.movies.length + r.shows.length + r.episodes.length;
  setView(seq, html`
    <h1 style="margin-bottom:20px">Results for “${q}”</h1>
    ${!total ? html`<div class="empty">No matches.</div>` : ''}
    ${r.movies.length ? html`<section class="hub"><div class="hub-head"><h2>Movies</h2></div><div class="grid">${r.movies.map(posterCard)}</div></section>` : ''}
    ${r.shows.length ? html`<section class="hub"><div class="hub-head"><h2>Shows</h2></div><div class="grid">${r.shows.map(posterCard)}</div></section>` : ''}
    ${r.episodes.length ? html`<section class="hub"><div class="hub-head"><h2>Episodes</h2></div><div class="grid wide">${r.episodes.map(wideCard)}</div></section>` : ''}`);
}

// ---------- settings ----------
async function viewSettings({ query, seq }) {
  view.onclick = null;
  if (state.user.role !== 'admin') { location.replace('#/account'); return; }
  const [, s, users, metaSettings, updates, remote, backupInfo, transcoding, introInfo, problems] = await Promise.all([refreshLibraries(), api('/api/status'), api('/api/users'),
    api('/api/settings'), api('/api/updates'), api('/api/remote'), api('/api/backups'), api('/api/transcoding'), api('/api/intro'), api('/api/problems')]);
  state.status = s;
  const libs = state.libraries;
  if (!setView(seq, html`
    <div class="toolbar"><h1>Settings</h1>
      ${libs.length ? html`<button class="btn" id="scan-all">↻ Scan all</button>` : ''}
      <button class="btn primary" id="add-lib">＋ Add library</button>
    </div>
    <div id="lib-form-slot"></div>
    <h2 style="margin:8px 0 12px">Libraries</h2>
    ${libs.length ? libs.map((l) => html`
      <div class="panel lib-row" data-lib="${l.id}">
        <div style="font-size:28px">${l.type === 'show' ? '📺' : '🎬'}</div>
        <div class="lib-info">
          <div style="font-weight:600">${l.name} <span class="muted" style="font-weight:400">· ${l.type === 'show' ? `${l.count} shows, ${l.episodeCount} episodes` : `${l.count} movies`}</span></div>
          <div class="paths">${l.paths.map((p) => html`<div class="path-line">📁 ${l.pathLabels?.[p] ? html`${l.pathLabels[p]} <span class="path-inner">(${p})</span>` : p}
            ${l.missingPaths.includes(p) ? html`<span class="path-tag bad">offline / not found</span>` : html`<span class="path-tag">${l.pathCounts[p]} file${l.pathCounts[p] === 1 ? '' : 's'}</span>`}</div>`)}</div>
          <div class="muted" style="font-size:12px;margin-top:4px">Last scanned: ${fmtDate(l.scannedAt)}</div>
        </div>
        <div class="row">
          <button class="btn small" data-act="scan">↻ Scan</button>
          ${metaSettings.providers.some((p) => p.enabled && p.kinds.includes(l.type)) ? html`<button class="btn small" data-act="meta" title="Look up every title again (your edits are kept)">Refresh metadata</button>` : ''}
          <button class="btn small" data-act="edit">Edit</button>
          <button class="btn small danger" data-act="delete">Delete</button>
        </div>
      </div>`) : html`<div class="panel muted">No libraries yet. Add one to get started.</div>`}
    ${libs.length ? problemsSection(problems) : ''}
    ${updates.check?.status === 'available' || updates.helper.state === 'updating' ? updatesSection(updates) : ''}
    ${metadataSection(metaSettings)}
    ${usersSection(users)}
    ${remoteSection(remote)}
    ${transcodingSection(transcoding, introInfo, metaSettings)}
    ${backupsSection(backupInfo)}
    ${updates.check?.status === 'available' || updates.helper.state === 'updating' ? '' : updatesSection(updates)}
    <h2 style="margin:28px 0 12px">Server</h2>
    <div class="panel">
      <dl class="kv">
        <dt>Version</dt><dd>${s.name} ${s.version}</dd>
        <dt>Web address</dt><dd><code>${location.origin}</code>${/^(localhost|127\.)/.test(location.hostname) ? html` <span class="muted">— from phones, TVs and other computers, use this PC's name or IP address instead of “localhost”</span>` : ''}</dd>
        <dt>Active streams</dt><dd>${s.activeTranscodes} transcoding</dd>
        <dt>Video downloader</dt><dd>${s.downloader.available ? html`yt-dlp ${s.downloader.version} — <a href="#/downloads">Downloads</a>` : 'yt-dlp not installed'}</dd>
        <dt>Data folder</dt><dd><code>${s.dataDir}</code></dd>
      </dl>
    </div>`)) return;

  $('#add-lib').onclick = () => showLibraryForm();
  bindUsersSection(users);
  bindMetadataSection();
  bindUpdatesSection(updates);
  bindRemoteSection();
  bindBackupsSection();
  bindTranscodingSection();
  if (query.get('section')) $(`#${query.get('section')}`)?.scrollIntoView({ block: 'start' });
  if ($('#scan-all')) $('#scan-all').onclick = async () => { await api('/api/scan', { method: 'POST' }); toast('Scanning all libraries…'); pollStatus(); };
  if (query.get('add')) showLibraryForm();
  view.onclick = async (e) => {
    const b = e.target.closest('[data-act]'); if (!b || !b.closest('[data-lib]')) return;
    const lib = libs.find((l) => l.id === b.closest('[data-lib]').dataset.lib);
    try {
      if (b.dataset.act === 'scan' || b.dataset.act === 'meta') {
        await api(`/api/libraries/${lib.id}/scan`, { method: 'POST', body: { refreshMetadata: b.dataset.act === 'meta' } });
        toast(`Scanning ${lib.name}…`); pollStatus();
      } else if (b.dataset.act === 'edit') showLibraryForm(lib);
      else if (b.dataset.act === 'delete' && confirm(`Remove the library “${lib.name}”? Your files are not touched, but watch history for it is cleared.`)) {
        await api(`/api/libraries/${lib.id}`, { method: 'DELETE' });
        toast('Library removed'); router();
      }
    } catch (err) { toast(err.message, true); }
  };
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
          <span class="muted" style="font-size:13px">A library can combine folders from several drives — they show up as one collection.</span></div>
        <p class="muted" style="margin:0;font-size:13px">Movies: <code>Movie Name (Year).mkv</code> or <code>Movie Name (Year)/file.mkv</code>.
          TV: <code>Show Name/Season 01/Show Name - S01E01.mkv</code>.</p>
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
        history.replaceState(null, '', '#/settings'); router();
      } catch (err) { $('#form-error').textContent = err.message; }
    };
    nameInp.focus();
  };
  draw();
  slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function pickFolder(start) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    let cur = null;
    const close = (val) => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); resolve(val); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    const load = async (p) => {
      try { cur = await api(`/api/fs${p ? `?path=${encodeURIComponent(p)}` : ''}`); }
      catch (err) { toast(err.message, true); if (!cur) cur = await api('/api/fs'); }
      root.innerHTML = html`
        <div class="modal-backdrop" id="mb">
          <div class="modal" role="dialog" aria-label="Choose a folder">
            <header><h2>Choose a folder</h2><div class="cwd">${cur.label ? `${cur.label}  (${cur.path})` : cur.path}</div></header>
            <div class="modal-body dir-list">
              ${cur.parent ? html`<button data-dir="${cur.parent}">⬆ ..</button>` : ''}
              ${cur.dirs.map((d) => html`<button data-dir="${cur.path.replace(/\/$/, '')}/${d}">📁 ${d}${cur.labels?.[d] ? html` <span class="muted">— ${cur.labels[d]}</span>` : ''}</button>`)}
              ${cur.dirs.length ? '' : html`<div class="muted" style="padding:12px">No subfolders</div>`}
            </div>
            <footer><button class="btn small" data-dir="${cur.home}" style="margin-right:auto">Home</button>
              <button class="btn" id="pick-cancel">Cancel</button><button class="btn primary" id="pick-ok">Select this folder</button></footer>
          </div>
        </div>`.s;
      $('#mb').onclick = (e) => {
        if (e.target.id === 'mb' || e.target.id === 'pick-cancel') return close(null);
        if (e.target.id === 'pick-ok') return close(cur.path);
        const d = e.target.closest('[data-dir]'); if (d) load(d.dataset.dir);
      };
    };
    load(start);
  });
}

// ---------- player ----------
let player = null;
function closePlayer() { if (player) { player.destroy(); player = null; } }

async function viewPlay({ params: [id], query }) {
  closePlayer();
  const item = await api(`/api/items/${id}`);
  if (!item.media) { toast('This file cannot be played', true); return history.back(); }
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
    window.MarqueeAndroid.play(JSON.stringify({ id: item.id, start, autoplayNext: store.get('autoplayNext', true), subsOn: store.get('subsOn', false),
      autoSkipIntro: store.get('autoSkipIntro', false), quality: store.get('quality', '') }));
    if (state.inAppNav) history.back(); else location.replace(`#/item/${item.id}`);
    return;
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
    this.lastReported = -1;
    this.dragging = false;
    this.pb = null;          // signed links + streaming session from /playback
    this.hls = null;
    this.casting = false;
    this.castTime = 0;

    const it = item;
    const subtitle = it.type === 'episode' ? [it.showTitle, epLabel(it)].filter(Boolean).join(' · ') : it.year;
    this.root = document.createElement('div');
    this.root.className = 'player';
    this.root.innerHTML = html`
      <video playsinline preload="auto" crossorigin="anonymous" x-webkit-airplay="allow"></video>
      <div class="p-subs" aria-live="off"></div>
      <div class="p-spinner"></div>
      <div class="p-cast-msg" hidden><div class="p-cast-icon">📺</div><div>Playing on <b class="p-cast-name"></b></div>
        <button class="btn small" data-a="cast-stop">Stop casting</button></div>
      <button class="btn p-skip" data-a="skip-intro" hidden>Skip Intro ⏭</button>
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
        <div class="p-seek"><div class="p-buffer"></div><input type="range" class="p-range" min="0" step="0.1" value="0" aria-label="Seek"><div class="p-hover-thumb" hidden></div><div class="p-hover-time" hidden></div></div>
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
          <select data-a="speed" class="p-speed" title="Playback speed (&lt; &gt;)">${[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => html`<option value="${r}" ${r === 1 ? 'selected' : ''}>${r === 1 ? 'Normal' : `${r}×`}</option>`)}</select>
          ${document.pictureInPictureEnabled ? html`<button class="p-btn p-hide-sm" data-a="pip" title="Picture-in-picture (p)">⧉</button>` : ''}
          ${it.type === 'episode' && state.user.role === 'admin' ? html`<button class="p-btn p-hide-sm" data-a="intro-edit" title="Edit this episode's intro">✂</button>` : ''}
          ${it.next ? html`<button class="p-btn" data-a="next" title="Next episode">⏭</button>` : ''}
          <button class="p-btn" data-a="fs" title="Fullscreen (f)">⛶</button>
        </div>
      </div>`.s;
    $('#player-root').append(this.root);
    this.v = $('video', this.root);
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
    if (Cast.state() === 'CONNECTED') this.startCasting(start);
    else this.load(start);
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

  setModeFromQuality() {
    if (this.quality !== 'original' && this.canHls) this.mode = 'hls';
    else this.mode = this.item.directPlay && this.audio === 0 && this.burn == null && !this.directFailed ? 'direct' : 'transcode';
  }

  // Picture subtitles (Blu-ray / DVD) are drawn into the video by the server: index of that track, or null.
  get burn() { return this.item.subtitles.find((s) => s.id === this.subId)?.burn ?? null; }
  burnQuery() { return this.burn != null ? `&burn=${this.burn}` : ''; }

  subOptions() {
    return html`<option value="">Subtitles off</option>${this.item.subtitles.map((s) => html`<option value="${s.id}" ${s.id === this.subId ? 'selected' : ''}>${s.label}</option>`)}
      ${state.status?.subtitleSearch && ['movie', 'episode'].includes(this.item.type) ? html`<option value="__search">Search online…</option>` : ''}`;
  }

  pickDefaultSub() {
    // Text subtitles first: picture ones need the video converted.
    const subs = [...this.item.subtitles].sort((a, b) => (a.burn != null) - (b.burn != null));
    const lang = (navigator.language || 'en').slice(0, 2);
    return (subs.find((s) => s.lang && s.lang.toLowerCase().startsWith(lang)) || subs[0])?.id || null;
  }

  // Signed links work without the login cookie, which AirPlay and cast devices don't have.
  tok(sep = '?') { return this.pb?.token ? `${sep}mt=${encodeURIComponent(this.pb.token)}` : ''; }

  hlsUrl({ sid = this.pb.sid, quality = this.quality } = {}) {
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
      api(`/api/items/${this.item.id}/seekpoint?t=${req}${this.burnQuery()}`).catch(() => ({ start: t })).then(({ start }) => {
        if (seq !== this.loadSeq || !this.root.isConnected) return;
        this.offset = start;
        this.v.src = `/api/items/${this.item.id}/transcode?start=${req}&audio=${this.audio}${this.burnQuery()}${this.tok('&')}`;
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

  hlsFailed(why) {
    console.warn('Adaptive streaming failed:', why);
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
    if (this.mode === 'hls') {
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

  // "Skip Intro" while the detected theme song plays (or skip it automatically, once).
  updateIntro(t) {
    const credits = this.item.credits;
    if (credits && this.item.next && t >= credits.start && t < credits.start + 30 && !this.creditsShown && !this.dragging) {
      this.creditsShown = true;
      this.showUpNext(true);
    }
    const intro = this.item.intro;
    const btn = $('[data-a=skip-intro]', this.root);
    const inIntro = !!intro && t >= intro.start && t < intro.end - 1;
    if (inIntro && store.get('autoSkipIntro', false) && !this.autoSkipped && (this.casting || !this.v.paused)) {
      this.autoSkipped = true;
      this.seek(intro.end);
      toast('Skipped the intro');
      return;
    }
    btn.hidden = !inIntro;
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
    if (this.markedWatched) return;
    const t = this.time;
    if (this.casting && t <= 0) return;
    this.lastReported = t;
    fetch(`/api/items/${this.item.id}/progress`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ position: t, paused: this.paused, mode: this.casting ? 'cast' : this.mode, quality: this.mode === 'hls' ? this.quality : null, client: PAGE_ID, stopped }),
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

  playNext() {
    if (!this.item.next) return;
    // Leaving during the credits counts as having watched the episode.
    if (this.item.credits && this.time >= this.item.credits.start - 1) {
      this.markedWatched = true; // (and no position report afterwards, which would undo it)
      fetch(`/api/items/${this.item.id}/watched`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true, body: '{"watched":true}' }).catch(() => {});
    }
    // In a watch party, everyone moves on to the next episode together.
    if (this.partyId) this.partyPost({ itemId: this.item.next.id, playing: true, position: 0 });
    location.replace(`#/play/${this.item.next.id}?t=0${this.partyId ? `&party=${this.partyId}` : ''}`);
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
    this.report();
    if (!this.item.next) return setTimeout(() => this.close(), 800);
    this.showUpNext(false);
  }

  // "Up next" card: at the end of an episode, or as soon as its credits start.
  showUpNext(atCredits) {
    if ($('.p-upnext', this.root)) return;
    const n = this.item.next;
    const auto = store.get('autoplayNext', true);
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
    if (!auto) return;
    this.upNextTimer = setInterval(() => {
      if (atCredits && this.paused) return; // the countdown waits while paused
      left--;
      const c = $('#un-count', box); if (c) c.textContent = left;
      if (left <= 0) { clearInterval(this.upNextTimer); this.playNext(); }
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
    v.addEventListener('playing', () => { this.pendingStart = null; });
    v.addEventListener('progress', () => this.updateBuffer());
    v.addEventListener('waiting', () => this.spinner(true));
    v.addEventListener('seeking', () => this.spinner(true));
    for (const ev of ['playing', 'canplay', 'seeked', 'pause']) v.addEventListener(ev, () => { if (ev !== 'pause' || v.readyState >= 3) this.spinner(false); });
    v.addEventListener('play', () => { $('[data-a=toggle]', this.root).textContent = '❚❚'; this.showControls(); });
    v.addEventListener('pause', () => { if (this.casting) return; $('[data-a=toggle]', this.root).textContent = '▶'; this.showControls(); this.report(); });
    v.addEventListener('ended', () => { if (!this.casting) this.onEnded(); });
    for (const ev of ['play', 'pause', 'seeked']) v.addEventListener(ev, () => { if (!this.casting) this.partySend(); });
    v.addEventListener('volumechange', () => {
      store.set('volume', v.volume); store.set('muted', v.muted);
      $('[data-a=mute]', this.root).textContent = v.muted || v.volume === 0 ? '🔇' : '🔊';
      $('.p-volume', this.root).value = v.muted ? 0 : v.volume;
    });
    v.addEventListener('error', () => {
      if (!v.error || !v.getAttribute('src') || this.casting) return;
      if (this.mode === 'direct') {
        // Browser refused the original file: fall back to server-side transcoding.
        toast('Direct play failed — switching to transcoding');
        const t = this.time;
        this.directFailed = true;
        this.mode = 'transcode';
        this.load(t);
      } else if (this.mode === 'hls') {
        this.hlsFailed(v.error.message || `media error ${v.error.code}`);
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
      hover.textContent = fmtClock(f * this.total);
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
    this.onKey = (e) => {
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
        n: () => { if (this.item.next) this.playNext(); },
        p: () => this.togglePip(),
        '<': () => this.stepSpeed(-1), '>': () => this.stepSpeed(1),
      }[k];
      if (handled) { e.preventDefault(); handled(); this.showControls(); }
    };
    document.addEventListener('keydown', this.onKey);
  }

  destroy() {
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
  [/^\/settings$/, viewSettings],
  [/^\/account$/, viewAccount],
  [/^\/downloads$/, viewDownloads],
  [/^\/watchlist$/, viewWatchlist],
  [/^\/collections$/, viewCollections],
  [/^\/activity$/, viewActivity],
  [/^\/party\/(\w+)$/, viewParty],
  [/^\/collection\/([\w-]+)$/, viewCollection],
];

// Scroll position per page, so "back" returns to where you were in a long library.
const scrollMemo = new Map();
let lastPath = null;

async function router() {
  if (!state.user) return;
  const { path, query } = parseHash();
  document.body.classList.remove('nav-open');
  if ($('#user-pop')) $('#user-pop').hidden = true;
  const isPlay = path.startsWith('/play/');
  if (!isPlay) closePlayer();
  if (path !== '/search' && !isPlay) $('#search-input').value = '';
  renderSidebar();
  const seq = ++renderSeq;
  const changedPage = path !== lastPath;
  if (changedPage && lastPath && !lastPath.startsWith('/play/')) scrollMemo.set(lastPath, window.scrollY);
  if (!isPlay) lastPath = path;
  const match = routes.find(([re]) => re.test(path));
  if (!match) return setView(seq, html`<div class="empty"><h2>Page not found</h2><a class="btn" href="#/">Go home</a></div>`);
  if (!isPlay) {
    view.onclick = null;
    if (!view.innerHTML || !view.dataset.path || view.dataset.path !== path) {
      view.innerHTML = '<div class="spinner"></div>';
      window.scrollTo(0, 0);
    }
    view.dataset.path = path;
    document.title = 'Marquee';
  }
  try {
    await match[1]({ params: match[0].exec(path).slice(1), query, seq });
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
  if (e.key === '/' && !player && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) { e.preventDefault(); $('#search-input').focus(); }
});
$('#menu-btn').addEventListener('click', () => document.body.classList.toggle('nav-open'));
document.addEventListener('click', (e) => { if (document.body.classList.contains('nav-open') && !e.target.closest('.sidebar, #menu-btn')) document.body.classList.remove('nav-open'); });

async function startApp() {
  document.body.classList.remove('auth-mode');
  renderUserMenu();
  await Promise.all([refreshLibraries().catch(() => {}), api('/api/status').then((s) => { state.status = s; }).catch(() => {})]);
  view.innerHTML = '';
  await router();
  firstRoute = false;
  pollStatus();
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
