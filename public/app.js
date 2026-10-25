'use strict';
/* Marquee web client — vanilla JS single page app. This file: app state, the top bar, the pages
   (home, libraries, shows, search…) and the router; it loads last and starts the app. The other
   files (index.html lists them) share one scope and use each other's helpers only when called. */

// ---------- app state ----------
const state = { user: null, libraries: [], status: null, inAppNav: false };
let renderSeq = 0;
const view = $('#view');
// Where the current page is drawn: the page itself, or the "More info" pop-up for movies, shows and episodes.
let viewEl = view;
// A new page fades in; the same page drawn again (after a change, or a refresh) doesn't.
let fadeNext = false;
function setView(seq, content) {
  if (seq !== renderSeq) return false;
  viewEl.innerHTML = renderVal(content);
  if (fadeNext) { fadeNext = false; viewEl.classList.remove('page-in'); void viewEl.offsetWidth; viewEl.classList.add('page-in'); }
  return true;
}

// Grey outlines of what's coming while a page loads, shaped like it (rows on Home, a grid in a
// library), so it doesn't jump about when the real thing arrives.
function skeleton(path) {
  const cards = (n) => Array.from({ length: n }, () => '<div class="card skel-card"><div class="art skel"></div><div class="skel skel-line"></div></div>').join('');
  if (path === '/') {
    return `<div class="skel skel-hero"></div>${[0, 1, 2].map(() => `<section class="hub"><div class="skel skel-title"></div><div class="rail"><div class="shelf">${cards(7)}</div></div></section>`).join('')}`;
  }
  if (/^\/(library|collections?|watchlist|search|person)\b/.test(path)) return `<div class="skel skel-title skel-h1"></div><div class="grid">${cards(18)}</div>`;
  return '<div class="spinner"></div>';
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
let pollTimer, polling = false;
async function pollStatus() {
  clearTimeout(pollTimer);
  // (One at a time: two running at once would each keep a loop going.)
  if (!state.user || polling) return;
  polling = true;
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
  polling = false;
  // Not while the tab or app is out of sight: it catches up as soon as it's back.
  if (!document.hidden) pollTimer = setTimeout(pollStatus, state.status?.scanning ? 2000 : 15000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollStatus(); });

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
    return setView(seq, emptyState({ art: 'lock', title: `Welcome, ${state.user.username}`, text: 'Nothing has been shared with you yet. Ask whoever runs Marquee to give you access to a library.' }));
  }
  if (!state.libraries.length) {
    return setView(seq, emptyState({ art: 'folder', title: 'Welcome to Marquee', text: 'Point Marquee at the folders where you keep your films and TV shows, and it will organise them into libraries to browse.',
      actions: html`<a class="btn primary" href="#/settings/libraries?add=1">Add a library</a>` }));
  }
  if (!homeData.hubs.length) {
    return setView(seq, emptyState({ art: state.status?.scanning ? 'wave' : 'film', title: state.status?.scanning ? 'Looking through your libraries…' : 'No films or shows found yet',
      text: state.status?.scanning ? 'Titles appear here as they are found.' : 'Check that the library folders have video files in them, then scan again.',
      actions: html`<a class="btn" href="#/settings/libraries">Manage libraries</a>` }));
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
      : (data.items.length ? emptyState({ art: 'search', title: 'Nothing matches', text: 'Try fewer filters, or another word.', style: 'grid-column:1/-1' })
        : emptyState({ art: state.status?.scanning ? 'wave' : 'film', title: state.status?.scanning ? 'Looking for titles…' : 'This library is empty', text: state.status?.scanning ? 'They appear here as they are found.' : 'Anything added to its folders shows up after the next scan.', style: 'grid-column:1/-1' })).s;
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
      ${selectButton()}
      <button class="btn small more-btn" id="lib-more" data-popmenu aria-haspopup="menu" title="More: shuffle, card size, collections${state.user.role === 'admin' ? ', scan' : ''}">⋯</button>
    </div>
    ${genre ? html`<div class="filter-note">Showing <b>${genre}</b> · <a href="#/library/${id}">clear</a></div>` : ''}
    <div class="lib-wrap"><div class="grid sized" id="lib-grid"></div><nav class="jump" id="lib-jump" aria-label="Jump to letter" hidden></nav></div>`)) return;
  render();
  bindSelect({ root: () => $('#lib-grid'), kind: 'titles' });
  const save = () => store.set(`lib:${id}`, prefs);
  $('#lib-sort').onchange = (e) => { prefs.sort = e.target.value; save(); render(); };
  // The things used now and then sit in ⋯ so the toolbar stays one tidy row.
  const SIZES = [['Small cards', 200], ['Medium cards', 260], ['Large cards', 340]];
  const nearest = () => SIZES.reduce((a, b) => (Math.abs(b[1] - prefs.cardW) < Math.abs(a[1] - prefs.cardW) ? b : a))[1];
  $('#lib-more').onclick = (e) => (openPop ? closeMenu() : openMenu(e.currentTarget, [
    { label: '⤮ Shuffle: play something random', onClick: () => shuffle() },
    { sep: true },
    ...SIZES.map(([label, w]) => ({ label: `${nearest() === w ? '✓ ' : '\u2003'}${label}`, onClick: () => { prefs.cardW = w; save(); $('#lib-grid').style.setProperty('--card-w', `${w}px`); } })),
    ...(cols.length ? [{ sep: true },
      { label: groupingOn() ? 'Show every title on its own' : '▦ Group titles into their collections', onClick: () => { store.set('groupCollections', !groupingOn()); render(); } },
      { label: `Browse collections (${cols.length})`, onClick: () => { location.hash = `#/collections?library=${id}`; } }] : []),
    ...(state.user.role === 'admin' ? [{ sep: true }, { label: '↻ Scan this library for new files', onClick: () => scan() }] : []),
  ]));
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
  $('#lib-jump').onclick = (e) => {
    const c = e.target.dataset.letter; if (!c) return;
    const idx = current.findIndex((x) => { const f = titleKey(x)[0]?.toUpperCase() || '#'; return c === '#' ? !/[A-Z]/.test(f) : f === c; });
    $$('#lib-grid .card')[idx]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const shuffle = async () => {
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
  const scan = async () => { await api(`/api/libraries/${id}/scan`, { method: 'POST' }); toast(`Scanning ${lib.name}…`); pollStatus(); };
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
// The page before this one (for the back button on collections and people's pages).
let cameFrom = null;
const pageNames = new Map(); // collection pages: '/collection/<id>' -> its name
function pageName(path) {
  if (path === '/') return 'Home';
  const lib = /^\/library\/(\w+)$/.exec(path);
  if (lib) return state.libraries.find((l) => l.id === lib[1])?.name || 'Library';
  const fixed = { '/collections': 'Collections', '/watchlist': 'My List', '/search': 'Search', '/requests': 'Requests', '/activity': 'Activity' };
  if (fixed[path]) return fixed[path];
  if (path.startsWith('/person/')) return decodeURIComponent(path.slice(8));
  return pageNames.get(path) || 'Back';
}
/** "‹ Movies": to the page you came from (a title's pop-up in between doesn't count), or `fallback`. */
function pageBack(fallback = '#/collections', fallbackName = 'Collections', { over = false } = {}) {
  const from = cameFrom && cameFrom.path !== parseHash().path ? cameFrom : null;
  return html`<a class="page-back ${over ? 'over' : ''}" href="${from ? `#${from.path}` : fallback}">${icon('left')}<span>${from ? from.title : fallbackName}</span></a>`;
}

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
  if (!isPlay && !isDetail) {
    if (changedPage && lastPath) cameFrom = { path: lastPath, title: pageName(lastPath) };
    lastPath = path;
  }
  // On a TV, the pages made for a keyboard point to a phone or computer instead.
  const match = tv.on && TV_ELSEWHERE.test(path) ? [/^.*$/, viewTvElsewhere] : routes.find(([re]) => re.test(path));
  if (!match) { closeDetailLayer(); return setView(seq, emptyState({ art: 'compass', title: 'Page not found', text: 'That link doesn’t go anywhere in Marquee.', actions: html`<a class="btn" href="#/">Go home</a>` })); }
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
      view.className = path === '/' ? 'has-hero' : ''; // (Home's banner outline sits under the top bar, as the banner does)
      view.innerHTML = skeleton(path);
      fadeNext = true;
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
    if (setView(seq, emptyState({ art: 'warn', error: true, title: 'Something went wrong', text: err.message, actions: html`<button class="btn" data-retry>Try again</button><a class="btn" href="#/">Go home</a>` }))) {
      $('[data-retry]', viewEl).onclick = () => router();
    }
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
  // (Its database couldn't be opened: nothing to sign in to until an admin restores a backup.)
  if (data.held) { view.innerHTML = html`<div class="auth-wrap"><div class="auth-card"><div class="auth-brand">MARQUEE</div><h1>Marquee needs a hand</h1><p>${data.error}</p></div></div>`.s; return; }
  if (!res?.ok) return showAuth({ setupRequired: !!data.setupRequired, message: res ? '' : 'Cannot reach the server.' });
  state.user = data.user;
  state.away = data.away;
  startApp();
})();
