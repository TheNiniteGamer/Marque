'use strict';
/* Marquee web client — item menus, metadata editing/matching, My List, metadata settings and the
   keyboard shortcut overlay. Loaded before app.js; helpers from app.js are used only when called. */

// Image URLs carry a version so edited artwork shows up immediately.
const artUrl = (kind, x) => `/api/art/${kind}/${x.id}?v=${encodeURIComponent(x.artV || '0')}`;
// Cards register the object they show, so menus can act on it without another request.
const knownItems = new Map();

// ---------- generic popover menu ----------
let openPop = null;
function closeMenu() { openPop?.remove(); openPop = null; }
function openMenu(anchor, entries) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'popmenu';
  m.setAttribute('role', 'menu');
  m.innerHTML = entries.map((e, i) => (e.hidden ? '' : e.sep ? '<hr>'
    : html`<button role="menuitem" data-i="${i}" class="${e.danger ? 'danger' : ''}">${e.label}</button>`.s)).join('');
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
  m.style.top = `${r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
  m.onclick = (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    closeMenu();
    Promise.resolve(entries[b.dataset.i].onClick()).catch((err) => toast(err.message, true));
  };
  openPop = m;
  m.querySelector('button')?.focus();
}
document.addEventListener('click', (e) => { if (openPop && !e.target.closest('.popmenu, [data-menu]')) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openPop) { closeMenu(); e.stopPropagation(); } }, true);
window.addEventListener('resize', closeMenu);
window.addEventListener('scroll', closeMenu, { passive: true });

// ---------- actions on items ----------
async function setWatchedFor(x, watched) {
  if (x.type === 'show') await api(`/api/shows/${x.id}/watched`, { method: 'POST', body: { watched } });
  else await api(`/api/items/${x.id}/watched`, { method: 'POST', body: { watched } });
  toast(watched ? 'Marked as watched' : 'Marked as unwatched');
  router();
}

async function toggleWatchlist(x) {
  await api(`/api/watchlist/${x.id}`, { method: x.inWatchlist ? 'DELETE' : 'PUT' });
  toast(x.inWatchlist ? 'Removed from My List' : 'Added to My List');
  router();
}

async function refreshMetadata(id) {
  toast('Refreshing metadata…');
  await api(`/api/meta/${id}/refresh`, { method: 'POST' });
  toast('Metadata updated');
  router();
}

function itemMenu(anchor, x, { ctx } = {}) {
  const admin = state.user.role === 'admin';
  const watched = x.type === 'show' ? x.episodeCount > 0 && !x.unwatchedCount : !!x.progress?.watched;
  openMenu(anchor, [
    { label: '▶  Play', onClick: async () => {
      if (x.type !== 'show') { location.hash = `#/play/${x.id}`; return; }
      const s = await api(`/api/shows/${x.id}`);
      if (s.upNext) location.hash = `#/play/${s.upNext.id}`; else toast('Nothing to play');
    } },
    { label: watched ? '○  Mark as unwatched' : '✓  Mark as watched', onClick: () => setWatchedFor(x, !watched) },
    { label: x.inWatchlist ? '♥  Remove from My List' : '♡  Add to My List', hidden: x.type === 'episode', onClick: () => toggleWatchlist(x) },
    { label: '✕  Remove from Continue Watching', hidden: ctx !== 'continue', onClick: async () => {
      await api(`/api/continue/${x.id}/hide`, { method: 'POST' }); toast('Removed from Continue Watching'); router();
    } },
    { label: '📺  Go to show', hidden: x.type !== 'episode', onClick: () => { location.hash = `#/show/${x.showId}`; } },
    { sep: true, hidden: !admin },
    { label: '✎  Edit details…', hidden: !admin, onClick: () => openEditor(x.id) },
    { label: '⌕  Fix match…', hidden: !admin || x.type === 'episode', onClick: () => openMatcher(x.id) },
    { label: '↻  Refresh metadata', hidden: !admin, onClick: () => refreshMetadata(x.type === 'episode' ? x.showId : x.id) },
  ]);
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-menu]');
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  if (openPop) { closeMenu(); return; }
  const x = knownItems.get(b.dataset.menu);
  if (x) itemMenu(b, x, { ctx: b.dataset.ctx });
});

// ---------- modal helper ----------
function openModal({ title, body, footer = '', wide = false, onClose }) {
  const root = document.createElement('div');
  root.className = 'modal-backdrop';
  root.innerHTML = html`<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
      <header class="modal-head"><h2>${title}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></header>
      <div class="modal-body">${raw(body)}</div>
      ${footer ? html`<footer>${raw(footer)}</footer>` : ''}
    </div>`.s;
  $('#modal-root').append(root);
  const close = () => { root.remove(); document.removeEventListener('keydown', onKey, true); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
  root.querySelector('[data-close]').onclick = close;
  return { el: root, close, body: root.querySelector('.modal-body') };
}

const KIND_LABEL = { movie: 'movie', show: 'show', episode: 'episode' };
const FIELD_LABEL = { title: 'Title', sortTitle: 'Sort title', year: 'Year', tagline: 'Tagline', overview: 'Summary', genres: 'Genres' };
const ART_LABEL = { poster: 'Poster', backdrop: 'Background', thumb: 'Thumbnail' };

// ---------- edit details ----------
async function openEditor(id, tab = 'general') {
  const d = await api(`/api/meta/${id}`);
  const auto = (f) => {
    const v = f.fetched ?? f.file;
    return Array.isArray(v) ? v.join(', ') : v ?? '';
  };
  const fieldRow = (name) => {
    const f = d.fields[name];
    const val = Array.isArray(f.edited) ? f.edited.join(', ') : f.edited ?? '';
    const ph = name === 'sortTitle' ? 'Same as title (e.g. "Matrix, The")' : auto(f) ? `Automatic: ${auto(f)}` : 'Not set';
    const input = name === 'overview'
      ? html`<textarea class="input" name="${name}" rows="5" placeholder="${ph}">${val}</textarea>`
      : html`<input class="input" name="${name}" ${name === 'year' ? 'type="number" min="1870" max="2200"' : ''} value="${val}" placeholder="${ph}">`;
    return html`<label class="edit-field ${f.edited != null ? 'locked' : ''}">
      <span class="edit-label">${FIELD_LABEL[name]}${f.edited != null ? html` <span class="lock" title="Edited — kept when metadata refreshes">🔒</span>` : ''}
        ${f.edited != null ? html`<button type="button" class="link-btn" data-reset="${name}">reset to automatic</button>` : ''}</span>
      ${input}</label>`;
  };
  const artSection = (k) => html`
    <div class="art-edit" data-art="${k}">
      <div class="art-preview ${k === 'poster' ? 'tall' : ''}"><img alt="" src="/api/art/${k}/${id}?t=${Date.now()}"></div>
      <div class="art-actions">
        <h3>${ART_LABEL[k]} ${d.art[k] ? html`<span class="chip">Custom</span>` : html`<span class="chip">Automatic</span>`}</h3>
        <label class="btn small file-btn">⤒ Upload image…<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" data-upload="${k}" hidden></label>
        <div class="row url-row"><input class="input" placeholder="…or paste an image URL" data-url="${k}"><button class="btn small" data-use-url="${k}">Use</button></div>
        ${d.match && k !== 'thumb' ? html`<button class="btn small" data-choose="${k}">Choose from ${d.match.provider === 'tvmaze' ? 'TVmaze' : 'TMDB'}…</button>` : ''}
        ${d.art[k] ? html`<button class="btn small danger" data-art-reset="${k}">Reset to automatic</button>` : ''}
        <div class="art-choices" data-choices="${k}"></div>
      </div>
    </div>`;

  const kindLabel = KIND_LABEL[d.kind];
  const m = openModal({
    title: `Edit ${kindLabel}`,
    wide: true,
    body: html`
      <div class="tabs"><button data-tab="general">Details</button><button data-tab="art">Artwork</button></div>
      <form id="edit-form" class="edit-grid" data-pane="general">
        ${Object.keys(d.fields).map(fieldRow)}
        <p class="muted small-note">Changes you make here are kept when metadata is refreshed or files are rescanned. Clear a field to go back to the automatic value.</p>
      </form>
      <div data-pane="art">${Object.keys(d.art).map(artSection)}</div>`.s,
    footer: html`<span class="form-error" id="edit-error"></span><button class="btn" data-close>Cancel</button><button class="btn primary" id="edit-save">Save</button>`.s,
    onClose: () => router(),
  });
  const el = m.el;
  $$('[data-close]', el).forEach((b) => { b.onclick = m.close; });
  const showTab = (t) => {
    $$('.tabs button', el).forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    $$('[data-pane]', el).forEach((p) => { p.hidden = p.dataset.pane !== t; });
    $('#edit-save', el).hidden = t !== 'general';
  };
  $('.tabs', el).onclick = (e) => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); };
  showTab(tab);

  const form = $('#edit-form', el);
  form.onclick = (e) => {
    const r = e.target.closest('[data-reset]');
    if (r) { form.elements[r.dataset.reset].value = ''; r.closest('.edit-field').classList.remove('locked'); }
  };
  const save = async () => {
    const body = {};
    for (const name of Object.keys(d.fields)) {
      const v = form.elements[name].value.trim();
      body[name] = v === '' ? null : name === 'genres' ? v.split(',').map((g) => g.trim()).filter(Boolean) : v;
    }
    try {
      await api(`/api/meta/${id}`, { method: 'PATCH', body });
      toast('Saved');
      m.close();
    } catch (err) { $('#edit-error', el).textContent = err.message; }
  };
  $('#edit-save', el).onclick = save;
  form.onsubmit = (e) => { e.preventDefault(); save(); };

  // Artwork actions apply immediately.
  const reopen = () => { m.close(); openEditor(id, 'art'); };
  const setArt = async (k, opts) => {
    try { await api(`/api/meta/${id}/art/${k}`, opts); toast(`${ART_LABEL[k]} updated`); reopen(); } catch (err) { toast(err.message, true); }
  };
  el.addEventListener('change', async (e) => {
    const k = e.target.dataset.upload;
    if (!k || !e.target.files[0]) return;
    const file = e.target.files[0];
    if (file.size > 15 * 1024 * 1024) return toast('Images must be under 15 MB', true);
    try {
      const res = await fetch(`/api/meta/${id}/art/${k}`, { method: 'PUT', headers: { 'Content-Type': file.type || 'image/jpeg' }, body: file });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
      toast(`${ART_LABEL[k]} updated`);
      reopen();
    } catch (err) { toast(err.message, true); }
  });
  el.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.dataset.useUrl) {
      const url = $(`[data-url="${t.dataset.useUrl}"]`, el).value.trim();
      if (url) setArt(t.dataset.useUrl, { method: 'PUT', body: { url } });
    } else if (t.dataset.artReset) {
      try { await api(`/api/meta/${id}/art/${t.dataset.artReset}`, { method: 'DELETE' }); reopen(); } catch (err) { toast(err.message, true); }
    } else if (t.dataset.choose) {
      const k = t.dataset.choose;
      const box = $(`[data-choices="${k}"]`, el);
      box.innerHTML = '<div class="spinner small"></div>';
      try {
        const imgs = (await api(`/api/meta/${id}/images`))[k] || [];
        box.innerHTML = imgs.length ? imgs.map((i) => html`<button class="choice ${k}" data-pick="${i.url}" data-kind="${k}" title="Use this image"><img loading="lazy" src="${i.thumb || i.url}" alt=""></button>`.s).join('')
          : '<div class="muted">No other images available.</div>';
      } catch (err) { box.textContent = err.message; }
    } else if (t.closest('[data-pick]')) {
      const b = t.closest('[data-pick]');
      setArt(b.dataset.kind, { method: 'PUT', body: { url: b.dataset.pick } });
    }
  });
  if (tab === 'general') form.elements[Object.keys(d.fields)[0]]?.focus();
}

// ---------- fix match ----------
async function openMatcher(id) {
  const d = await api(`/api/meta/${id}`);
  if (d.kind === 'episode') return openMatcher((knownItems.get(id) || {}).showId);
  const providers = d.providers;
  const current = d.match
    ? html`Currently matched to <b>${d.match.title || '?'}</b>${d.match.year ? ` (${d.match.year})` : ''} on ${d.match.provider === 'tvmaze' ? 'TVmaze' : 'TMDB'}.`
    : d.unmatched ? 'Currently unmatched (using information from the file name only).' : 'Not matched yet.';
  const m = openModal({
    title: `Fix match`,
    wide: true,
    body: html`
      <p class="muted" style="margin-top:0">${current}</p>
      ${!providers.length ? html`<div class="error-box">${d.kind === 'movie'
        ? html`To look up movies, add a free TMDB API key in <a href="#/settings" data-close>Settings → Metadata</a>.`
        : 'No metadata source is available.'}</div>` : html`
      <form class="row match-form" id="match-form">
        <input class="input" name="q" value="${d.searchTitle || ''}" placeholder="Title" required style="flex:3;min-width:180px">
        <input class="input" name="year" type="number" value="${d.searchYear || ''}" placeholder="Year" style="width:100px">
        ${providers.length > 1 ? html`<select name="provider"><option value="">All sources</option>${providers.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select>` : ''}
        <button class="btn primary" type="submit">Search</button>
      </form>
      <div id="match-results" class="match-results"></div>`}`.s,
    footer: html`${d.match ? html`<button class="btn danger" id="unmatch" style="margin-right:auto">Unmatch</button>` : ''}<button class="btn" data-close>Close</button>`.s,
    onClose: () => router(),
  });
  const el = m.el;
  $$('[data-close]', el).forEach((b) => { b.onclick = m.close; });
  if ($('#unmatch', el)) {
    $('#unmatch', el).onclick = async () => {
      if (!confirm('Remove the online metadata for this title? Your own edits are kept.')) return;
      await api(`/api/meta/${id}/unmatch`, { method: 'POST' });
      toast('Unmatched');
      m.close();
    };
  }
  const form = $('#match-form', el);
  if (!form) return;
  const results = $('#match-results', el);
  const search = async () => {
    const f = form.elements;
    results.innerHTML = '<div class="spinner small"></div>';
    try {
      const qs = new URLSearchParams({ kind: d.kind, q: f.q.value, year: f.year.value, provider: f.provider?.value || '' });
      const r = await api(`/api/metadata/search?${qs}`);
      results.innerHTML = r.results.length ? r.results.map((x) => html`
        <button class="match-row" data-provider="${x.provider}" data-id="${x.id}">
          <span class="match-thumb">${x.thumb ? html`<img loading="lazy" src="${x.thumb}" alt="">` : ''}</span>
          <span class="match-info"><span class="match-line"><b>${x.title}</b> ${x.year ? html`<span class="muted">(${x.year})</span>` : ''}
            <span class="chip">${x.provider === 'tvmaze' ? 'TVmaze' : 'TMDB'}</span>
            ${d.match && d.match.provider === x.provider && d.match.providerId === x.id ? html`<span class="chip current">Current</span>` : ''}</span>
            <span class="match-overview">${x.overview || ''}</span></span>
        </button>`.s).join('') : '<div class="muted" style="padding:12px">No results. Try a shorter title or remove the year.</div>';
    } catch (err) { results.innerHTML = html`<div class="error-box">${err.message}</div>`.s; }
  };
  form.onsubmit = (e) => { e.preventDefault(); search(); };
  results.onclick = async (e) => {
    const b = e.target.closest('.match-row');
    if (!b) return;
    $$('.match-row', results).forEach((r) => { r.disabled = true; });
    b.classList.add('busy');
    try {
      await api(`/api/meta/${id}/match`, { method: 'POST', body: { provider: b.dataset.provider, id: b.dataset.id } });
      toast('Match updated');
      m.close();
    } catch (err) {
      toast(err.message, true);
      $$('.match-row', results).forEach((r) => { r.disabled = false; });
      b.classList.remove('busy');
    }
  };
  search();
}

// ---------- Settings → Metadata ----------
const LANGUAGES = [['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['es-ES', 'Español'], ['es-MX', 'Español (México)'],
  ['fr-FR', 'Français'], ['de-DE', 'Deutsch'], ['it-IT', 'Italiano'], ['pt-BR', 'Português (Brasil)'], ['pt-PT', 'Português'],
  ['nl-NL', 'Nederlands'], ['sv-SE', 'Svenska'], ['da-DK', 'Dansk'], ['nb-NO', 'Norsk'], ['fi-FI', 'Suomi'], ['pl-PL', 'Polski'],
  ['ru-RU', 'Русский'], ['tr-TR', 'Türkçe'], ['ja-JP', '日本語'], ['ko-KR', '한국어'], ['zh-CN', '中文'], ['hi-IN', 'हिन्दी'], ['ar-SA', 'العربية']];

function metadataSection(st) {
  const keyStatus = st.tmdbKeySet ? html`Saved (${st.tmdbKeyHint})` : st.tmdbKeyFromEnv ? 'Set by the server configuration' : html`<span style="color:var(--danger)">Not set</span> — movies can't be looked up online`;
  return html`
    <h2 style="margin:28px 0 12px">Metadata</h2>
    <div class="panel form" id="meta-settings" style="max-width:none">
      <div class="meta-sources">
        ${st.providers.map((p) => html`<div class="source ${p.enabled ? 'on' : ''}"><b>${p.name}</b>
          <span class="muted">${p.kinds.includes('movie') ? 'Movies & TV' : 'TV shows'} · ${p.enabled ? 'Active' : p.id === 'tmdb' ? 'Needs API key' : 'Off'}</span></div>`)}
      </div>
      <label>TMDB API key <span class="muted" style="font-weight:400">— ${keyStatus}</span>
        <div class="row">
          <input class="input" id="tmdb-key" type="password" autocomplete="off" placeholder="${st.tmdbKeySet ? 'Paste a new key to replace it' : 'Paste your TMDB API key (v3)'}" style="flex:1;min-width:220px">
          <button class="btn small" id="tmdb-save">Save key</button>
          ${st.tmdbKeySet ? html`<button class="btn small danger" id="tmdb-remove">Remove</button>` : ''}
        </div>
        <span class="muted" style="font-size:13px">Free: create an account at <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">themoviedb.org → Settings → API</a> and copy the “API Key”.</span>
      </label>
      <div class="row" style="align-items:flex-end">
        <label style="min-width:220px">Language for titles and summaries
          <select id="meta-lang">${LANGUAGES.map(([c, n]) => html`<option value="${c}" ${st.language === c ? 'selected' : ''}>${n}</option>`)}
            ${LANGUAGES.some(([c]) => c === st.language) ? '' : html`<option value="${st.language}" selected>${st.language}</option>`}</select></label>
        <label class="check" style="margin-bottom:8px"><input type="checkbox" id="meta-auto" ${st.autoMatch ? 'checked' : ''}> Match new items automatically when scanning</label>
      </div>
      <div class="row"><button class="btn small" id="meta-refresh-all">↻ Refresh metadata for all libraries</button>
        <span class="muted" style="font-size:13px">Your own edits are always kept.</span></div>
    </div>`;
}

function bindMetadataSection() {
  const patch = async (body, msg) => {
    try { await api('/api/settings', { method: 'PATCH', body }); toast(msg); router(); } catch (err) { toast(err.message, true); }
  };
  $('#tmdb-save').onclick = async (e) => {
    const key = $('#tmdb-key').value.trim();
    if (!key) return toast('Paste a key first', true);
    e.target.disabled = true; e.target.textContent = 'Checking…';
    await patch({ tmdbKey: key }, 'TMDB key saved — use “Refresh metadata” to look up your movies');
    e.target.disabled = false; e.target.textContent = 'Save key';
  };
  if ($('#tmdb-remove')) $('#tmdb-remove').onclick = () => confirm('Remove the TMDB key?') && patch({ tmdbKey: '' }, 'Key removed');
  $('#meta-lang').onchange = (e) => patch({ language: e.target.value }, 'Language saved — refresh metadata to apply it');
  $('#meta-auto').onchange = (e) => patch({ autoMatch: e.target.checked }, e.target.checked ? 'Automatic matching on' : 'Automatic matching off');
  $('#meta-refresh-all').onclick = async () => {
    for (const l of state.libraries) await api(`/api/libraries/${l.id}/scan`, { method: 'POST', body: { refreshMetadata: true } });
    toast('Refreshing metadata…');
    pollStatus();
  };
}

// ---------- My List ----------
async function viewWatchlist({ seq }) {
  const list = await api('/api/watchlist');
  setView(seq, html`
    <div class="toolbar"><h1>My List<span class="count">${list.length}</span></h1></div>
    ${list.length ? html`<div class="grid">${list.map(posterCard)}</div>`
      : html`<div class="empty"><h2>Nothing here yet</h2><p>Use the ⋯ menu on any movie or show, or the ♡ button on its page, to save it for later.</p></div>`}`);
}

// ---------- keyboard shortcut help ----------
function showShortcuts() {
  if ($('.shortcuts-modal')) return;
  const rows = [
    ['Anywhere', [['/', 'Search'], ['?', 'Show this help'], ['g h', 'Go home'], ['g l', 'Go to My List']]],
    ['Player', [['Space / K', 'Play / pause'], ['← / J', 'Back 10 seconds'], ['→ / L', 'Forward 30 seconds'], ['↑ / ↓', 'Volume'],
      ['M', 'Mute'], ['F', 'Fullscreen'], ['C', 'Subtitles on/off'], ['N', 'Next episode'], ['< / >', 'Slower / faster'], ['P', 'Picture-in-picture'], ['Esc', 'Close player']]],
  ];
  const m = openModal({
    title: 'Keyboard shortcuts',
    body: rows.map(([group, keys]) => html`<h3 class="kbd-group">${group}</h3><dl class="kbd-list">${keys.map(([k, d]) => html`<dt>${k.split(' / ').map((x, i) => html`${i ? ' / ' : ''}<kbd>${x}</kbd>`)}</dt><dd>${d}</dd>`)}</dl>`.s).join(''),
  });
  m.el.querySelector('.modal').classList.add('shortcuts-modal');
}

let gPending = 0;
document.addEventListener('keydown', (e) => {
  if (!state.user || player || e.ctrlKey || e.metaKey || e.altKey) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) || $('.modal-backdrop')) return;
  if (e.key === '?') { e.preventDefault(); showShortcuts(); return; }
  if (e.key === 'g') { gPending = Date.now(); return; }
  if (Date.now() - gPending < 1000) {
    if (e.key === 'h') location.hash = '#/';
    if (e.key === 'l') location.hash = '#/watchlist';
    gPending = 0;
  }
});

// ---------- Settings → Updates ----------
const shortSha = (s) => (s ? s.slice(0, 7) : '');
function updatesSection(u) {
  const c = u.check;
  const h = u.helper;
  const b = u.build;
  const updating = h.state === 'updating';
  const ago = (t) => (t ? fmtDate(t) : 'never');
  let summary;
  if (updating) summary = html`<div class="upd-state busy"><span class="spin"></span> ${h.message || 'Updating…'}</div>`;
  else if (!c) summary = html`<div class="upd-state">Not checked yet.</div>`;
  else if (c.status === 'current') summary = html`<div class="upd-state ok">✓ Marquee is up to date</div>`;
  else if (c.status === 'available') summary = html`<div class="upd-state new">${c.behindBy} update${c.behindBy === 1 ? '' : 's'} available</div>`;
  else if (c.status === 'error') summary = html`<div class="upd-state bad">Couldn't check for updates: ${c.error}</div>`;
  else summary = html`<div class="upd-state">Can't tell which version is installed${b.install === 'docker' ? ' (it was probably set up from a ZIP download). Running an update once fixes this.' : '.'}
    ${c.latest ? html`<br><span class="muted">Latest version: ${shortSha(c.latest.sha)} — ${c.latest.message}</span>` : ''}</div>`;

  let how = '';
  if (b.install === 'docker') {
    how = h.alive
      ? html`<span class="muted">The update helper is running on the server PC.</span>`
      : html`<span class="muted">To update from this page, turn on the update helper on the server PC: run <b>start-marquee.bat</b> and answer <b>Y</b>
          (or run <code>marquee.ps1 InstallHelper</code>). You can always update by running <b>update-marquee.bat</b> there.</span>`;
  } else if (b.install === 'git') {
    how = html`<span class="muted">To update: run <code>git pull</code> in the Marquee folder, then restart the server.</span>`;
  } else {
    how = html`<span class="muted">To update: download the latest version from GitHub and restart the server.</span>`;
  }
  const canApply = b.install === 'docker' && h.alive && !updating && (c?.status === 'available' || c?.status === 'unknown');

  return html`
    <h2 style="margin:28px 0 12px" id="updates">Updates</h2>
    <div class="panel form" id="updates-panel" style="max-width:none">
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <div>
          ${summary}
          <div class="muted" style="font-size:13px;margin-top:4px">
            Running version ${b.version}${b.commit ? html` · <code>${shortSha(b.commit)}</code>` : ''}${b.builtAt ? ` · built ${fmtDate(Date.parse(b.builtAt))}` : ''}
            · checked ${ago(c?.checkedAt)} · from <a href="https://github.com/${b.repo}" target="_blank" rel="noopener">github.com/${b.repo}</a>
          </div>
        </div>
        <div class="row">
          <button class="btn small" id="upd-check" ${updating ? 'disabled' : ''}>↻ Check now</button>
          ${canApply ? html`<button class="btn primary small" id="upd-apply">⤓ Update now</button>` : ''}
        </div>
      </div>
      ${c?.status === 'available' && c.changes.length ? html`<div class="changes"><b>What's new</b>
        <ul>${c.changes.map((x) => html`<li><a href="${x.url || '#'}" target="_blank" rel="noopener"><code>${x.sha}</code></a> ${x.message}
          ${x.date ? html`<span class="muted">· ${new Date(x.date).toLocaleDateString()}</span>` : ''}</li>`)}</ul></div>` : ''}
      ${updating || h.state === 'failed' ? html`<pre class="upd-log ${h.state === 'failed' ? 'bad' : ''}">${h.state === 'failed' ? `Update failed: ${h.message}\n\n` : ''}${(h.log || []).join('\n')}</pre>` : ''}
      ${h.state === 'done' && h.finishedAt ? html`<div class="muted" style="font-size:13px">Last update finished ${fmtDate(h.finishedAt)} — ${h.message}.</div>` : ''}
      <div>${how}</div>
      <label class="check"><input type="checkbox" id="upd-auto" ${u.autoCheck ? 'checked' : ''}> Check for updates automatically (twice a day)</label>
    </div>`;
}

function bindUpdatesSection(u) {
  $('#upd-check').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Checking…';
    try {
      const r = await api('/api/updates/check', { method: 'POST' });
      toast(r.check.status === 'available' ? `${r.check.behindBy} update(s) available` : r.check.status === 'current' ? 'Marquee is up to date' : r.check.error || 'Checked');
      await refreshStatus();
    } catch (err) { toast(err.message, true); }
    router();
  };
  if ($('#upd-apply')) {
    $('#upd-apply').onclick = async () => {
      if (!confirm('Update Marquee now? It will be unavailable for a minute or two while it rebuilds and restarts. Anyone watching will be interrupted.')) return;
      try { await api('/api/updates/apply', { method: 'POST' }); toast('Update requested — the helper will start in a few seconds'); watchUpdate(); router(); } catch (err) { toast(err.message, true); }
    };
  }
  $('#upd-auto').onchange = async (e) => {
    try { await api('/api/settings', { method: 'PATCH', body: { updateCheck: e.target.checked } }); toast('Saved'); } catch (err) { toast(err.message, true); }
  };
  if (u.helper.state === 'updating' || u.helper.pending) watchUpdate();
}

// Follow an update: refresh the panel while it runs, then wait out the restart and reload into the new version.
let updateWatch = null;
function watchUpdate() {
  if (updateWatch) return;
  let sawUpdating = false;
  updateWatch = setInterval(async () => {
    try {
      const u = await fetch('/api/updates').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));
      if (u.helper.state === 'updating') sawUpdating = true;
      if (parseHash().path === '/settings' && !$('.modal-backdrop')) {
        const panel = $('#updates-panel');
        if (panel) { const fresh = document.createElement('div'); fresh.innerHTML = updatesSection(u).s; panel.replaceWith(fresh.querySelector('#updates-panel')); bindUpdatesSection(u); }
      }
      if (sawUpdating && u.helper.state !== 'updating') {
        clearInterval(updateWatch); updateWatch = null;
        if (u.helper.state === 'done') { showRestarting(); waitForRestart(); } else toast(`Update failed: ${u.helper.message}`, true);
      }
    } catch {
      // The server went away: the new version is starting.
      clearInterval(updateWatch); updateWatch = null;
      showRestarting();
      waitForRestart();
    }
  }, 2500);
}
function showRestarting() {
  if ($('#restart-overlay')) return;
  const el = document.createElement('div');
  el.id = 'restart-overlay';
  el.className = 'restart-overlay';
  el.innerHTML = '<div class="spinner"></div><h2>Marquee is restarting with the new version…</h2><p class="muted">This page will reload by itself.</p>';
  document.body.append(el);
}
function waitForRestart() {
  let downSeen = false;
  const waitStarted = Date.now();
  const t = setInterval(async () => {
    const ok = await fetch('/api/health', { cache: 'no-store' }).then((r) => r.ok).catch(() => false);
    if (!ok) { downSeen = true; return; }
    // Up again: reload once it has been down, or after a short grace period if the restart was too quick to notice.
    if (downSeen || (Date.now() - waitStarted > 20000)) { clearInterval(t); location.reload(); }
  }, 2000);
}

// A small dot on the avatar and a one-time toast when an update is waiting (admins only).
function noteUpdateAvailable(status) {
  const on = state.user?.role === 'admin' && !!status?.updateAvailable;
  $('#user-menu')?.classList.toggle('has-update', on);
  const link = $('.sidebar a[data-nav="settings"]');
  if (link) link.classList.toggle('has-update', on);
  if (on && !sessionStorage.getItem('marquee:update-toast')) {
    try { sessionStorage.setItem('marquee:update-toast', '1'); } catch { /* ignore */ }
    toast('A Marquee update is available — see Settings → Updates');
  }
  if (status?.updating && state.user?.role === 'admin') watchUpdate();
}
async function refreshStatus() {
  try { state.status = await api('/api/status'); noteUpdateAvailable(state.status); } catch { /* ignore */ }
}
