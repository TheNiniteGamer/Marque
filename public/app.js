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
  $('#toast-root').append(el);
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
    <div class="section">Libraries</div>
    ${state.libraries.map((l) => html`
      <a href="#/library/${l.id}" class="${path === `/library/${l.id}` ? 'active' : ''}">${icon(l.type)} ${l.name}<span class="count">${l.count}</span></a>`)}
    ${state.libraries.length ? '' : state.user?.role === 'admin' ? html`<a href="#/settings">＋ Add a library</a>` : html`<div class="muted" style="padding:8px 12px;font-size:13px">No libraries shared with you yet.</div>`}
    <div class="section">${state.user?.role === 'admin' ? 'Manage' : 'You'}</div>
    ${state.user?.canDownload ? html`<a href="#/downloads" class="${path === '/downloads' ? 'active' : ''}">⤓ Downloads</a>` : ''}
    ${state.user?.role === 'admin' ? html`<a href="#/settings" class="${path === '/settings' ? 'active' : ''}">⚙ Settings</a>` : ''}
    <a href="#/account" class="${path === '/account' ? 'active' : ''}">👤 Account</a>
  `.s;
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

function posterCard(x) {
  const sub = x.type === 'show'
    ? (x.seasonCount > 1 ? `${x.seasonCount} seasons` : `${x.episodeCount} episode${x.episodeCount === 1 ? '' : 's'}`)
    : x.type === 'episode' ? `${x.showTitle} · ${epLabel(x)}` : (x.year || '');
  let badge = '';
  if (x.type === 'show' && x.unwatchedCount > 0) badge = html`<span class="badge" title="Unwatched episodes">${x.unwatchedCount}</span>`;
  else if ((x.type === 'show' && x.episodeCount && !x.unwatchedCount) || x.progress?.watched) badge = html`<span class="badge check" title="Watched">✓</span>`;
  return html`
    <div class="card">
      <div class="art">
        <a class="cover" href="${hrefFor(x)}"><img loading="lazy" src="/api/art/poster/${x.id}" alt="${x.title}"></a>
        ${badge}${progressBar(x)}
        <button class="play-hover" data-play="${x.type === 'show' ? `show:${x.id}` : x.id}" aria-label="Play ${x.title}">▶</button>
      </div>
      <a href="${hrefFor(x)}"><div class="title" title="${x.title}">${x.title}</div><div class="sub">${sub}</div></a>
    </div>`;
}

function wideCard(x) {
  const isEp = x.type === 'episode';
  const kind = isEp ? 'thumb' : 'backdrop';
  const title = isEp ? x.showTitle : x.title;
  const sub = isEp ? [epLabel(x), x.title].filter(Boolean).join(' — ') : [x.year, x.progress?.position ? `${fmtClock(x.duration - x.progress.position)} left` : ''].filter(Boolean).join(' · ');
  return html`
    <div class="card wide">
      <div class="art">
        <a class="cover" href="${hrefFor(x)}"><img loading="lazy" src="/api/art/${kind}/${x.id}" alt="${title}"></a>
        ${x.progress?.watched ? html`<span class="badge check">✓</span>` : ''}${progressBar(x)}
        <button class="play-hover" data-play="${x.id}" aria-label="Play">▶</button>
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
  const homeData = await api('/api/home');
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
      <div class="hub-head"><h2>${hub.title}</h2>${hub.libraryId ? html`<a href="#/library/${hub.libraryId}">See all ›</a>` : ''}</div>
      <div class="shelf ${hub.style}">${hub.items.map((x) => (hub.style === 'wide' ? wideCard(x) : posterCard(x)))}</div>
    </section>`));
}

async function viewLibrary({ params: [id], seq }) {
  const data = await api(`/api/libraries/${id}/items`);
  const lib = data.library;
  const prefs = store.get(`lib:${id}`, { sort: 'title', filter: 'all' });
  const sorters = {
    title: (a, b) => sortTitle(a.title).localeCompare(sortTitle(b.title), undefined, { numeric: true }),
    added: (a, b) => (b.lastAddedAt || b.addedAt) - (a.lastAddedAt || a.addedAt),
    year: (a, b) => (b.year || 0) - (a.year || 0),
    rating: (a, b) => (b.rating || 0) - (a.rating || 0),
    duration: (a, b) => (b.duration || 0) - (a.duration || 0),
  };
  const unwatched = (x) => (x.type === 'show' ? x.unwatchedCount > 0 : !x.progress?.watched);
  const render = () => {
    const list = data.items.filter((x) => prefs.filter === 'all' || unwatched(x)).sort(sorters[prefs.sort] || sorters.title);
    $('#lib-count').textContent = `${list.length}`;
    $('#lib-grid').innerHTML = list.length ? list.map((x) => posterCard(x).s).join('')
      : html`<div class="empty" style="grid-column:1/-1">${data.items.length ? 'Nothing matches this filter.' : state.status?.scanning ? 'Scanning…' : 'This library is empty.'}</div>`.s;
  };
  if (!setView(seq, html`
    <div class="toolbar">
      <h1>${lib.name}<span class="count" id="lib-count"></span></h1>
      <div class="seg" id="lib-filter">
        <button data-f="all" class="${prefs.filter === 'all' ? 'on' : ''}">All</button>
        <button data-f="unwatched" class="${prefs.filter === 'unwatched' ? 'on' : ''}">Unwatched</button>
      </div>
      <select id="lib-sort" aria-label="Sort by">
        ${[['title', 'Title'], ['added', 'Date added'], ['year', 'Year'], ['rating', 'Rating'], ...(lib.type === 'movie' ? [['duration', 'Duration']] : [])]
          .map(([k, label]) => html`<option value="${k}" ${prefs.sort === k ? 'selected' : ''}>${label}</option>`)}
      </select>
      ${state.user.role === 'admin' ? html`<button class="btn small" id="lib-scan">↻ Scan</button>` : ''}
    </div>
    <div class="grid" id="lib-grid"></div>`)) return;
  render();
  $('#lib-sort').onchange = (e) => { prefs.sort = e.target.value; store.set(`lib:${id}`, prefs); render(); };
  $('#lib-filter').onclick = (e) => {
    const f = e.target.dataset.f; if (!f) return;
    prefs.filter = f; store.set(`lib:${id}`, prefs);
    $$('#lib-filter button').forEach((b) => b.classList.toggle('on', b.dataset.f === f));
    render();
  };
  if ($('#lib-scan')) $('#lib-scan').onclick = async () => { await api(`/api/libraries/${id}/scan`, { method: 'POST' }); toast(`Scanning ${lib.name}…`); pollStatus(); };
}

function backdrop(id) {
  return html`<div class="backdrop"><img src="/api/art/backdrop/${id}" alt="" onerror="this.remove()"></div>`;
}

async function viewShow({ params: [id], query, seq }) {
  const show = await api(`/api/shows/${id}`);
  const seasonKey = (s) => String(s.season);
  let current = query.get('season') ?? (show.upNext ? String(show.upNext.season) : show.seasons[0] && seasonKey(show.seasons[0]));
  if (!show.seasons.some((s) => seasonKey(s) === current)) current = show.seasons[0] && seasonKey(show.seasons[0]);
  const up = show.upNext;
  const upLabel = up ? `${up.progress?.position && !up.progress.watched ? 'Resume' : 'Play'} ${epLabel(up)}` : null;

  const episodeRow = (e) => html`
    <div class="episode">
      <div class="art">
        <a href="#/item/${e.id}"><img loading="lazy" src="/api/art/thumb/${e.id}" alt="${e.title}"></a>
        ${progressBar(e)}
        <button class="play-hover" data-play="${e.id}" aria-label="Play">▶</button>
      </div>
      <a href="#/item/${e.id}">
        <div class="ep-title">${e.episode != null ? `${e.episode}. ` : ''}${e.title}</div>
        <div class="muted" style="font-size:13px">${[epLabel(e), fmtDuration(e.duration)].filter(Boolean).join(' · ')}</div>
        ${e.overview ? html`<div class="ep-overview">${e.overview}</div>` : ''}
      </a>
      <button class="watch-toggle ${e.progress?.watched ? 'on' : ''}" data-watch="${e.id}" title="${e.progress?.watched ? 'Mark unwatched' : 'Mark watched'}">✓</button>
    </div>`;

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
      ${backdrop(id)}
      <div class="detail-body">
        <div class="poster"><img src="/api/art/poster/${id}" alt="${show.title}"></div>
        <div class="info">
          <h1>${show.title}</h1>
          <div class="meta-line">
            ${show.year ? html`<span>${show.year}</span>` : ''}
            <span>${show.seasonCount} season${show.seasonCount === 1 ? '' : 's'}</span>
            <span>${show.episodeCount} episodes</span>
            ${show.unwatchedCount ? html`<span>${show.unwatchedCount} unwatched</span>` : ''}
            ${show.rating ? html`<span>★ ${show.rating}</span>` : ''}
          </div>
          ${show.genres.length ? html`<div class="row">${show.genres.map((g) => html`<span class="chip">${g}</span>`)}</div>` : ''}
          ${show.overview ? html`<p class="overview">${show.overview}</p>` : ''}
          <div class="row actions">
            ${up ? html`<button class="btn primary" data-play="${up.id}">▶ ${upLabel}</button>` : ''}
            <button class="btn" id="show-watch">${allWatched ? 'Mark unwatched' : 'Mark all watched'}</button>
          </div>
        </div>
      </div>
    </div>
    <div class="seasons-nav">${show.seasons.map((s) => html`<button class="btn small" data-season="${seasonKey(s)}">${s.title}</button>`)}</div>
    <div id="season-body"></div>`)) return;

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
  const p = it.progress;
  const resumable = p && !p.watched && p.position > 15;
  const v = it.media?.video, a = it.media?.audio?.[0];
  const res = resLabel(v);
  if (!setView(seq, html`
    <div class="detail">
      ${backdrop(id)}
      <div class="detail-body">
        <div class="poster ${isEp ? 'wide' : ''}"><img src="/api/art/${isEp ? 'thumb' : 'poster'}/${id}" alt="${it.title}"></div>
        <div class="info">
          ${isEp ? html`<div class="eyebrow"><a href="#/show/${it.showId}?season=${it.season}">${it.showTitle}</a> · ${epLabel(it)}</div>` : ''}
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
          ${it.genres.length ? html`<div class="row">${it.genres.map((g) => html`<span class="chip">${g}</span>`)}</div>` : ''}
          <div class="row actions">
            ${it.media ? html`
              <button class="btn primary" data-play="${id}" ${resumable ? '' : 'data-t="0"'}>▶ ${resumable ? `Resume from ${fmtClock(p.position)}` : 'Play'}</button>
              ${resumable ? html`<button class="btn" data-play="${id}" data-t="0">Play from start</button>` : ''}` : html`<span class="error-box">This file could not be read by ffprobe.</span>`}
            <button class="btn" id="item-watch">${p?.watched ? 'Mark unwatched' : 'Mark watched'}</button>
            <a class="btn" href="/api/items/${id}/stream?download=1" download>⤓ Download</a>
          </div>
          ${resumable ? html`<div class="resume-note">${fmtClock(it.duration - p.position)} remaining</div>` : ''}
          ${it.overview ? html`<p class="overview">${it.overview}</p>` : ''}
          ${isEp && (it.prev || it.next) ? html`<div class="row" style="margin:12px 0">
            ${it.prev ? html`<a class="btn small" href="#/item/${it.prev.id}">‹ ${epLabel(it.prev)}</a>` : ''}
            ${it.next ? html`<a class="btn small" href="#/item/${it.next.id}">${epLabel(it.next)} ›</a>` : ''}</div>` : ''}
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
    </div>`)) return;
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
  const [, s, users] = await Promise.all([refreshLibraries(), api('/api/status'), api('/api/users')]);
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
          ${s.tmdb ? html`<button class="btn small" data-act="meta">Refresh metadata</button>` : ''}
          <button class="btn small" data-act="edit">Edit</button>
          <button class="btn small danger" data-act="delete">Delete</button>
        </div>
      </div>`) : html`<div class="panel muted">No libraries yet. Add one to get started.</div>`}
    ${usersSection(users)}
    <h2 style="margin:28px 0 12px">Server</h2>
    <div class="panel">
      <dl class="kv">
        <dt>Version</dt><dd>${s.name} ${s.version}</dd>
        <dt>Web address</dt><dd><code>${location.origin}</code>${/^(localhost|127\.)/.test(location.hostname) ? html` <span class="muted">— from phones, TVs and other computers, use this PC's name or IP address instead of “localhost”</span>` : ''}</dd>
        <dt>Online metadata</dt><dd>${s.tmdb ? 'TMDB enabled' : html`Off — start the server with <code>TMDB_API_KEY=…</code> to fetch posters, summaries and ratings`}</dd>
        <dt>Active streams</dt><dd>${s.activeTranscodes} transcoding</dd>
        <dt>Video downloader</dt><dd>${s.downloader.available ? html`yt-dlp ${s.downloader.version} — <a href="#/downloads">Downloads</a>` : 'yt-dlp not installed'}</dd>
        <dt>Data folder</dt><dd><code>${s.dataDir}</code></dd>
      </dl>
    </div>`)) return;

  $('#add-lib').onclick = () => showLibraryForm();
  bindUsersSection(users);
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
  player = new Player(item, start);
}

class Player {
  constructor(item, start) {
    this.item = item;
    this.duration = item.duration || 0;
    this.mode = item.directPlay ? 'direct' : 'transcode';
    this.offset = 0;
    this.audio = 0;
    this.subId = store.get('subsOn', false) ? this.pickDefaultSub() : null;
    this.lastReported = -1;
    this.dragging = false;

    const it = item;
    const subtitle = it.type === 'episode' ? [it.showTitle, epLabel(it)].filter(Boolean).join(' · ') : it.year;
    this.root = document.createElement('div');
    this.root.className = 'player';
    this.root.innerHTML = html`
      <video playsinline preload="auto" crossorigin="anonymous"></video>
      <div class="p-subs" aria-live="off"></div>
      <div class="p-spinner"></div>
      <div class="p-top">
        <button class="p-btn" data-a="close" title="Back (Esc)">←</button>
        <div class="p-title">${it.title}<small>${subtitle}</small></div>
        <span class="p-spacer"></span>
        <span class="p-badge" id="p-mode"></span>
      </div>
      <div class="p-bottom">
        <div class="p-seek"><div class="p-buffer"></div><input type="range" class="p-range" min="0" step="0.1" value="0" aria-label="Seek"><div class="p-hover-time" hidden></div></div>
        <div class="p-row">
          <button class="p-btn big" data-a="toggle" title="Play/Pause (Space)">▶</button>
          <button class="p-btn" data-a="back" title="Back 10s (←)">⟲</button>
          <button class="p-btn" data-a="fwd" title="Forward 30s (→)">⟳</button>
          <span class="p-time">0:00 / ${fmtClock(this.duration)}</span>
          <span class="p-spacer"></span>
          ${it.audioTracks.length > 1 ? html`<select data-a="audio" class="p-hide-sm" title="Audio">${it.audioTracks.map((t) => html`<option value="${t.index}">${t.label}</option>`)}</select>` : ''}
          ${it.subtitles.length ? html`<select data-a="subs" title="Subtitles (c)"><option value="">Subtitles off</option>${it.subtitles.map((s) => html`<option value="${s.id}" ${s.id === this.subId ? 'selected' : ''}>${s.label}</option>`)}</select>` : ''}
          <button class="p-btn" data-a="mute" title="Mute (m)">🔊</button>
          <input type="range" class="p-volume" min="0" max="1" step="0.05" aria-label="Volume">
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
    this.load(start);
    this.reportTimer = setInterval(() => this.report(), 10_000);
    document.title = `${it.type === 'episode' ? `${it.showTitle} - ` : ''}${it.title} · Marquee`;
  }

  pickDefaultSub() {
    const subs = this.item.subtitles;
    const lang = (navigator.language || 'en').slice(0, 2);
    return (subs.find((s) => s.lang && s.lang.toLowerCase().startsWith(lang)) || subs[0])?.id || null;
  }

  get time() { return this.offset + (this.v.currentTime || 0); }
  get total() { return this.mode === 'direct' && Number.isFinite(this.v.duration) && this.v.duration > 0 ? this.v.duration : this.duration; }

  load(t) {
    t = Math.max(0, this.duration ? Math.min(t, this.duration - 2) : t);
    this.spinner(true);
    if (this.mode === 'direct') {
      this.offset = 0;
      const seekTo = () => { this.v.currentTime = t; };
      if (!this.v.src.includes('/stream')) {
        this.v.src = `/api/items/${this.item.id}/stream`;
        this.v.addEventListener('loadedmetadata', seekTo, { once: true });
      } else seekTo();
    } else {
      // Copied video streams can only start on a keyframe; ask where the stream will really begin.
      const seq = (this.loadSeq = (this.loadSeq || 0) + 1);
      this.offset = t;
      this.updateTime();
      const req = t.toFixed(3);
      api(`/api/items/${this.item.id}/seekpoint?t=${req}`).catch(() => ({ start: t })).then(({ start }) => {
        if (seq !== this.loadSeq || !this.root.isConnected) return;
        this.offset = start;
        this.v.src = `/api/items/${this.item.id}/transcode?start=${req}&audio=${this.audio}`;
        this.applySubs();
        this.v.play().catch(() => this.spinner(false));
      });
    }
    $('#p-mode', this.root).textContent = this.mode === 'direct' ? 'Direct Play' : 'Transcoding';
    if (this.mode === 'direct') {
      this.applySubs();
      this.v.play().catch(() => this.spinner(false));
    }
    this.updateTime();
  }

  seek(t) {
    t = Math.max(0, Math.min(t, this.total || t));
    if (this.mode === 'direct') { this.v.currentTime = t; return; }
    // Within what the current transcode has already buffered? Seek locally instead of restarting ffmpeg.
    const b = this.v.buffered;
    const local = t - this.offset;
    for (let i = 0; i < b.length; i++) if (local >= b.start(i) && local <= b.end(i) - 0.5) { this.v.currentTime = local; return; }
    const wasPaused = this.v.paused;
    this.load(t);
    if (wasPaused) this.v.addEventListener('playing', () => this.v.pause(), { once: true });
  }

  applySubs() {
    $$('track', this.v).forEach((t) => t.remove());
    const box = $('.p-subs', this.root);
    box.replaceChildren();
    if (!this.subId) return;
    const sub = this.item.subtitles.find((s) => s.id === this.subId);
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = sub?.label || 'Subtitles';
    if (sub?.lang) track.srclang = sub.lang;
    track.src = `/api/items/${this.item.id}/subtitles/${this.subId}?offset=${this.offset.toFixed(2)}`;
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

  spinner(on) { $('.p-spinner', this.root).hidden = !on; }

  updateTime() {
    const t = this.time, total = this.total;
    if (!this.dragging) {
      this.range.max = total || 0;
      this.range.value = t;
      this.range.style.setProperty('--pct', `${pct(t, total)}%`);
    }
    $('.p-time', this.root).textContent = `${fmtClock(this.dragging ? Number(this.range.value) : t)} / ${fmtClock(total)}`;
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
    if (!this.v.paused) this.idleTimer = setTimeout(() => this.root.classList.add('idle'), 3000);
  }

  toggle() { if (this.v.paused) this.v.play().catch(() => {}); else this.v.pause(); }

  report(force = false) {
    const t = this.time;
    if (!force && (this.v.paused || Math.abs(t - this.lastReported) < 2)) return;
    this.lastReported = t;
    fetch(`/api/items/${this.item.id}/progress`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ position: t }),
    }).catch(() => {});
  }

  close() {
    if (state.inAppNav) history.back();
    else location.hash = `#/item/${this.item.id}`;
  }

  playNext() {
    if (this.item.next) location.replace(`#/play/${this.item.next.id}?t=0`);
  }

  onEnded() {
    this.report(true);
    if (!this.item.next) return setTimeout(() => this.close(), 800);
    const n = this.item.next;
    let left = 10;
    const box = document.createElement('div');
    box.className = 'p-upnext';
    box.innerHTML = html`<div class="muted">Up next in <b id="un-count">${left}</b>s</div>
      <img src="/api/art/thumb/${n.id}" alt="">
      <div><b>${epLabel(n)}</b> — ${n.title}</div>
      <div class="row"><button class="btn primary small" data-a="next">▶ Play now</button><button class="btn small" data-a="cancel-next">Cancel</button></div>`.s;
    this.root.append(box);
    this.root.classList.remove('idle');
    this.upNextTimer = setInterval(() => {
      left--;
      const c = $('#un-count', box); if (c) c.textContent = left;
      if (left <= 0) { clearInterval(this.upNextTimer); this.playNext(); }
    }, 1000);
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else this.root.requestFullscreen?.().catch(() => {});
  }

  bind() {
    const v = this.v;
    v.addEventListener('timeupdate', () => this.updateTime());
    v.addEventListener('progress', () => this.updateBuffer());
    v.addEventListener('waiting', () => this.spinner(true));
    v.addEventListener('seeking', () => this.spinner(true));
    for (const ev of ['playing', 'canplay', 'seeked', 'pause']) v.addEventListener(ev, () => { if (ev !== 'pause' || v.readyState >= 3) this.spinner(false); });
    v.addEventListener('play', () => { $('[data-a=toggle]', this.root).textContent = '❚❚'; this.showControls(); });
    v.addEventListener('pause', () => { $('[data-a=toggle]', this.root).textContent = '▶'; this.showControls(); this.report(true); });
    v.addEventListener('ended', () => this.onEnded());
    v.addEventListener('volumechange', () => {
      store.set('volume', v.volume); store.set('muted', v.muted);
      $('[data-a=mute]', this.root).textContent = v.muted || v.volume === 0 ? '🔇' : '🔊';
      $('.p-volume', this.root).value = v.muted ? 0 : v.volume;
    });
    v.addEventListener('error', () => {
      if (!v.error || !v.getAttribute('src')) return;
      if (this.mode === 'direct') {
        // Browser refused the original file: fall back to server-side transcoding.
        toast('Direct play failed — switching to transcoding');
        const t = this.time;
        this.mode = 'transcode';
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
    });
    this.root.addEventListener('change', (e) => {
      const a = e.target.dataset.a;
      if (a === 'subs') { this.subId = e.target.value || null; store.set('subsOn', !!this.subId); this.applySubs(); }
      if (a === 'audio') { this.audio = Number(e.target.value); if (this.mode === 'direct') this.mode = 'transcode'; this.load(this.time); }
    });
    $('.p-volume', this.root).addEventListener('input', (e) => { v.volume = Number(e.target.value); v.muted = v.volume === 0; });

    const hover = $('.p-hover-time', this.root);
    this.range.addEventListener('input', () => {
      this.dragging = true;
      this.range.style.setProperty('--pct', `${pct(Number(this.range.value), this.total)}%`);
      this.updateTime();
    });
    this.range.addEventListener('change', () => { this.dragging = false; this.seek(Number(this.range.value)); });
    this.range.addEventListener('mousemove', (e) => {
      const r = this.range.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      hover.hidden = false;
      hover.style.left = `${f * 100}%`;
      hover.textContent = fmtClock(f * this.total);
    });
    this.range.addEventListener('mouseleave', () => { hover.hidden = true; });

    this.onMove = () => this.showControls();
    this.root.addEventListener('mousemove', this.onMove);
    this.root.addEventListener('touchstart', this.onMove, { passive: true });
    this.onKey = (e) => {
      if (e.target.tagName === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      const handled = {
        ' ': () => this.toggle(), k: () => this.toggle(),
        ArrowLeft: () => this.seek(this.time - 10), j: () => this.seek(this.time - 10),
        ArrowRight: () => this.seek(this.time + 30), l: () => this.seek(this.time + 30),
        ArrowUp: () => { v.volume = Math.min(1, v.volume + 0.05); v.muted = false; },
        ArrowDown: () => { v.volume = Math.max(0, v.volume - 0.05); },
        m: () => { v.muted = !v.muted; }, f: () => this.toggleFullscreen(),
        c: () => { const sel = $('[data-a=subs]', this.root); if (!sel) return; sel.value = this.subId ? '' : (this.pickDefaultSub() || ''); sel.dispatchEvent(new Event('change', { bubbles: true })); },
        Escape: () => { if (!document.fullscreenElement) this.close(); },
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
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.v.pause();
    this.v.removeAttribute('src'); // stops the download and lets the server kill ffmpeg
    this.v.load();
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
];

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
  } catch (err) {
    if (isPlay) { toast(err.message, true); return; }
    setView(seq, html`<div class="empty"><h2>Something went wrong</h2><p class="error-box" style="display:inline-block">${err.message}</p><br><a class="btn" href="#/">Go home</a></div>`);
  }
}

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
}

(async function init() {
  const res = await fetch('/api/auth/me').catch(() => null);
  const data = res ? await res.json().catch(() => ({})) : {};
  if (!res?.ok) return showAuth({ setupRequired: !!data.setupRequired, message: res ? '' : 'Cannot reach the server.' });
  state.user = data.user;
  startApp();
})();
