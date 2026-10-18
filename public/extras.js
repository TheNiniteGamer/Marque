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
    { label: '▦  Add to collection…', hidden: !admin || !['movie', 'show'].includes(x.type), onClick: () => openCollectionPicker(x) },
    { label: '✕  Remove from this collection', hidden: !ctx?.startsWith('collection:'), onClick: async () => {
      await api(`/api/collections/${ctx.slice(11)}/members/${x.id}`, { method: 'DELETE' }); toast('Removed from the collection'); router();
    } },
    { label: '★  Use as the collection’s cover', hidden: !ctx?.startsWith('collection:'), onClick: async () => {
      await api(`/api/collections/${ctx.slice(11)}`, { method: 'PATCH', body: { cover: x.id } }); toast('Cover changed'); router();
    } },
    { label: '💬  Find subtitles…', hidden: !state.status?.subtitleSearch || !['movie', 'episode'].includes(x.type), onClick: () => openSubtitleSearch(x.id, () => router()) },
    { label: '⏭  Edit intro & credits…', hidden: !admin || x.type !== 'episode', onClick: () => openIntroEditor(x.id) },
    { label: '⌕  Fix match…', hidden: !admin || x.type === 'episode' || x.type === 'extra', onClick: () => openMatcher(x.id) },
    { label: '↻  Refresh metadata', hidden: !admin || x.type === 'extra', onClick: () => refreshMetadata(x.type === 'episode' ? x.showId : x.id) },
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
      <h3 style="margin:12px 0 0">Subtitles from OpenSubtitles.com</h3>
      <span class="muted" style="font-size:13px">Lets everyone search for missing subtitles from the player (Subtitles → Search online…).
        Get a free API key at <a href="https://www.opensubtitles.com/en/consumers" target="_blank" rel="noopener">opensubtitles.com → API consumers</a>.
        Without an OpenSubtitles account only a few downloads a day are allowed; signing in raises the limit.</span>
      <div class="row">
        <label style="flex:1;min-width:200px">API key <span class="muted" style="font-weight:400">— ${st.opensubtitles.keySet ? `saved (${st.opensubtitles.keyHint})` : 'not set'}</span>
          <input class="input" id="os-key" type="password" autocomplete="off" placeholder="${st.opensubtitles.keySet ? 'Paste a new key to replace it' : 'API key'}"></label>
        <label style="min-width:150px">Account (optional)<input class="input" id="os-user" autocomplete="off" value="${st.opensubtitles.username}" placeholder="Username"></label>
        <label style="min-width:150px">Password<input class="input" id="os-pass" type="password" autocomplete="new-password" placeholder="${st.opensubtitles.username ? 'Unchanged' : ''}"></label>
      </div>
      <div class="row"><button class="btn small" id="os-save">Save</button>
        ${st.opensubtitles.keySet ? html`<button class="btn small danger" id="os-remove">Remove</button>` : ''}</div>
    </div>`;
}

function bindMetadataSection() {
  const patch = async (body, msg) => {
    try { await api('/api/settings', { method: 'PATCH', body }); toast(msg); router(); } catch (err) { toast(err.message, true); }
  };
  $('#os-save').onclick = (e) => {
    const o = { username: $('#os-user').value.trim() };
    if ($('#os-key').value.trim()) o.apiKey = $('#os-key').value.trim();
    if ($('#os-pass').value) o.password = $('#os-pass').value;
    e.target.disabled = true;
    patch({ opensubtitles: o }, 'OpenSubtitles settings saved');
  };
  if ($('#os-remove')) $('#os-remove').onclick = () => patch({ opensubtitles: { apiKey: '' } }, 'Removed');
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
    <div class="toolbar"><h1>My List<span class="count">${list.length}</span></h1>${list.length ? selectButton() : ''}</div>
    ${list.length ? html`<div class="grid">${list.map(posterCard)}</div>`
      : html`<div class="empty"><h2>Nothing here yet</h2><p>Use the ⋯ menu on any movie or show, or the ♡ button on its page, to save it for later.</p></div>`}`);
  bindSelect({ root: () => $('#view'), kind: 'titles' });
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
  else if (c.status === 'available') {
    summary = c.significant
      ? html`<div class="upd-state new">★ Significant update available <span class="muted" style="font-weight:400">(${c.behindBy} change${c.behindBy === 1 ? '' : 's'})</span></div>
          <div class="muted" style="font-size:13px">This update adds major new features. Read the notes below; a backup is a good idea before updating.</div>`
      : html`<div class="upd-state new">${c.behindBy} update${c.behindBy === 1 ? '' : 's'} available</div>`;
  }
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
        <ul>${c.changes.map((x) => html`<li class="${x.significant ? 'significant' : ''}"><a href="${x.url || '#'}" target="_blank" rel="noopener"><code>${x.sha}</code></a> ${x.significant ? html`<span class="sig-tag">Significant update</span> ` : ''}${x.message}
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
  const menuLink = $('#user-pop .upd-link');
  if (menuLink) menuLink.textContent = status?.significantUpdate ? 'Significant update available' : 'Update available';
  if (on && !sessionStorage.getItem('marquee:update-toast')) {
    try { sessionStorage.setItem('marquee:update-toast', '1'); } catch { /* ignore */ }
    toast(status.significantUpdate ? 'A significant Marquee update is available — see Settings → Updates' : 'A Marquee update is available — see Settings → Updates');
  }
  if (status?.updating && state.user?.role === 'admin') watchUpdate();
}
async function refreshStatus() {
  try { state.status = await api('/api/status'); noteUpdateAvailable(state.status); } catch { /* ignore */ }
}

// ---------- Settings → Remote access ----------
function remoteSection(r) {
  const names = { tailscale: 'Tailscale', cloudflare: 'Cloudflare Tunnel' };
  const on = r.configured.map((x) => names[x] || x);
  let body;
  if (r.seen) {
    body = html`
      <div class="upd-state ok">✓ Marquee is reachable away from home</div>
      <div class="row" style="margin-top:6px">
        <code class="remote-url">${r.seen.origin}</code>
        <button class="btn small" id="copy-remote" data-url="${r.seen.origin}">Copy</button>
      </div>
      <div class="muted" style="font-size:13px">Via ${r.seen.via === 'Tailscale' ? 'Tailscale' : 'your tunnel'} · last used ${fmtDate(r.seen.at)}.
        Use this address in the Android app or any browser${r.seen.via === 'Tailscale' ? ' on a device signed in to Tailscale' : ''}.</div>`;
  } else if (on.length) {
    body = html`
      <div class="upd-state">${on.join(' and ')} ${on.length > 1 ? 'are' : 'is'} switched on</div>
      <div class="muted" style="font-size:14px;margin-top:4px">${r.configured.includes('tailscale')
        ? html`Open <code>https://marquee.&lt;your-tailnet&gt;.ts.net</code> on a phone or laptop signed in to Tailscale. The exact address is in the Tailscale app under <b>Machines</b>. Once you've used it, it will show here.`
        : 'Open the public hostname you set up in Cloudflare. Once you have used it, it will show here.'}</div>`;
  } else {
    body = html`
      <div class="upd-state">Only available at home</div>
      <p class="muted" style="font-size:14px;margin:6px 0 0">To watch from anywhere, the easiest way is <b>Tailscale</b> (free).
        Create an account, paste an auth key into <code>TS_AUTHKEY</code> in the <code>.env</code> file next to <code>start-marquee.bat</code>,
        then run <b>start-marquee.bat</b> again. Your phone also needs the Tailscale app. The README has step-by-step instructions, including a Cloudflare Tunnel option.</p>`;
  }
  return html`
    <h2 style="margin:28px 0 12px">Remote access</h2>
    <div class="panel" id="remote-panel">${body}
      ${r.viaRemoteNow ? html`<p class="muted" style="font-size:13px;margin:10px 0 0">🔒 You're connected remotely over HTTPS right now.</p>` : ''}
    </div>`;
}

function bindRemoteSection() {
  const b = $('#copy-remote');
  if (b) b.onclick = () => navigator.clipboard?.writeText(b.dataset.url).then(() => toast('Address copied'), () => toast(b.dataset.url));
}

// ---------- Settings → Backups ----------
const KIND = { auto: 'Automatic', manual: 'Manual', 'pre-restore': 'Before restore' };
function backupsSection(b) {
  const s = b.settings;
  return html`
    <h2 style="margin:28px 0 12px" id="backups">Backups</h2>
    <div class="panel form" id="backups-panel" style="max-width:none">
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <div>
          <div class="upd-state ${b.backups.length ? 'ok' : ''}">${b.backups.length ? `✓ Last backup ${fmtDate(b.backups[0].createdAt)}` : 'No backups yet'}</div>
          <div class="muted" style="font-size:13px;margin-top:4px">Saved in <code>${b.dirLabel}</code> on the server PC.
            Includes users, watch history, My List, libraries, your edits, artwork and settings.</div>
        </div>
        <div class="row">
          <button class="btn small primary" id="bk-now">Back up now</button>
          <a class="btn small" href="/api/backups/download" download>⤓ Download a backup</a>
          <label class="btn small file-btn">⤒ Restore from a file…<input type="file" id="bk-upload" accept=".gz,.tgz,application/gzip" hidden></label>
        </div>
      </div>
      <div class="row bk-settings">
        <label class="check"><input type="checkbox" id="bk-auto" ${s.auto ? 'checked' : ''}> Back up automatically every day at</label>
        <input class="input" type="time" id="bk-time" value="${s.time}" style="width:120px">
        <span class="bk-keep muted">keep the last <input class="input" type="number" id="bk-keep" min="1" max="365" value="${s.keep}" aria-label="Number of automatic backups to keep"> automatic backups</span>
      </div>
      ${b.backups.length ? html`<div class="bk-list">${b.backups.map((x) => html`
        <div class="bk-row" data-name="${x.name}">
          <span>${fmtDate(x.createdAt)}</span><span class="chip">${KIND[x.kind] || x.kind}</span><span class="muted">${fmtSize(x.size)}</span>
          <span class="row bk-actions">
            <a class="btn small" href="/api/backups/file/${encodeURIComponent(x.name)}" download>Download</a>
            <button class="btn small" data-bk="restore">Restore</button>
            <button class="btn small danger" data-bk="delete" aria-label="Delete backup">✕</button>
          </span>
        </div>`)}</div>` : ''}
    </div>`;
}

async function runRestore(doIt, label) {
  if (!confirm(`Restore ${label}?\n\nUsers, watch history, libraries, edits and settings will be replaced by the ones in the backup. A safety backup of how things are now is made first.`)) return;
  showRestarting();
  $('#restart-overlay h2').textContent = 'Restoring backup…';
  $('#restart-overlay p').textContent = 'This page will reload when it is done.';
  try {
    const r = await doIt();
    sessionStorage.setItem('marquee:restored', r.restoredFrom || '1');
    location.reload();
  } catch (err) {
    $('#restart-overlay')?.remove();
    toast(err.message, true);
  }
}

function bindBackupsSection() {
  const patch = async (body) => {
    try { await api('/api/backups/settings', { method: 'PATCH', body }); toast('Saved'); } catch (err) { toast(err.message, true); router(); }
  };
  $('#bk-auto').onchange = (e) => patch({ auto: e.target.checked });
  $('#bk-time').onchange = (e) => patch({ time: e.target.value });
  $('#bk-keep').onchange = (e) => patch({ keep: Number(e.target.value) });
  $('#bk-now').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Backing up…';
    try { const b = await api('/api/backups', { method: 'POST' }); toast(`Backup saved (${fmtSize(b.size)})`); } catch (err) { toast(err.message, true); }
    router();
  };
  $('#bk-upload').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    runRestore(async () => {
      const res = await fetch('/api/backups/restore', { method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body: file });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Restore failed');
      return data;
    }, `the backup “${file.name}”`);
    e.target.value = '';
  };
  $('#backups-panel').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-bk]');
    if (!b) return;
    const name = b.closest('[data-name]').dataset.name;
    if (b.dataset.bk === 'delete') {
      if (!confirm('Delete this backup?')) return;
      try { await api(`/api/backups/file/${encodeURIComponent(name)}`, { method: 'DELETE' }); router(); } catch (err) { toast(err.message, true); }
    } else {
      const row = b.closest('[data-name]').querySelector('span').textContent;
      runRestore(() => api(`/api/backups/file/${encodeURIComponent(name)}/restore`, { method: 'POST' }), `the backup from ${row}`);
    }
  });
}

// After a restore the page reloads; say what happened.
if (sessionStorage.getItem('marquee:restored')) {
  sessionStorage.removeItem('marquee:restored');
  setTimeout(() => toast('Backup restored'), 800);
}

// ---------- settings: transcoding, casting and skip intro ----------
function transcodingSection(t, intro, settings) {
  const why = t.results.filter((r) => !r.ok);
  return html`
    <h2 style="margin:28px 0 12px" id="transcoding">Transcoding &amp; streaming</h2>
    <div class="panel form" style="max-width:none" id="tc-panel">
      <div class="upd-state ${t.active !== 'software' ? 'ok' : ''}">${t.checking ? 'Checking graphics cards…' : html`Converting video with: <b>${t.activeName}</b>`}</div>
      <label>Video converter
        <select id="tc-hw">${t.options.map((o) => html`<option value="${o.id}" ${o.id === t.setting ? 'selected' : ''}>${o.name}</option>`)}</select></label>
      ${why.length ? html`<details class="muted" style="font-size:13px"><summary>Why isn't a graphics card being used?</summary>
        <ul>${why.map((r) => html`<li><b>${r.name}:</b> ${r.error}</li>`)}</ul>
        <div>A graphics card has to be passed through to Docker first: set <code>GPU=nvidia</code> (or <code>intel</code> / <code>amd</code> on Linux hosts) in the <code>.env</code> file and run <b>start-marquee.bat</b> again. See the README.</div></details>` : ''}
      <div class="row"><button class="btn small" id="tc-test">Test again</button>
        <span class="muted" style="font-size:13px">Videos your browser can already play are never converted.</span></div>
      <label>Maximum quality away from home
        <select id="tc-remote">${[['', 'No limit'], ['1080p', '1080p (about 8 Mbps)'], ['720p', '720p (about 4 Mbps)'], ['480p', '480p (about 1.5 Mbps)'], ['360p', '360p (under 1 Mbps)']]
          .map(([v, l]) => html`<option value="${v}" ${t.remoteMaxQuality === v ? 'selected' : ''}>${l}</option>`)}</select></label>
      <div class="muted" style="font-size:13px;margin-top:-6px">For people watching through Tailscale, Cloudflare or from outside your network, so one viewer can't use up your home internet's upload.
        Videos are converted down to this quality; at home nothing changes.</div>
      <label>Address for cast devices <span class="muted" style="font-weight:400">(optional)</span>
        <input class="input" id="tc-cast" placeholder="${t.castUrlFromEnv || 'e.g. http://192.168.1.20:32500'}" value="${t.castUrl}"></label>
      <div class="muted" style="font-size:13px;margin-top:-6px">Chromecasts and TVs fetch the video from Marquee themselves, so they need an address that works on your network —
        this PC's IP address and port. Only needed when you open Marquee as “localhost”. Casting works from Chrome or Edge on pages opened as <code>localhost</code> or over HTTPS.</div>
      <div class="row"><button class="btn small primary" id="tc-save-cast">Save address</button></div>
    </div>
    <h2 style="margin:28px 0 12px" id="intro">Skip intro</h2>
    <div class="panel form" style="max-width:none">
      <label class="check"><input type="checkbox" id="intro-on" ${settings.introDetection ? 'checked' : ''}> Find TV show intros automatically after scans</label>
      <div class="muted" style="font-size:14px">${intro.running && intro.current
        ? `Looking at ${intro.current.show}, season ${intro.current.season} (${intro.current.done}/${intro.current.total})${intro.queued ? ` · ${intro.queued} more season(s) waiting` : ''}…`
        : `${intro.found} of ${intro.episodes} episodes have a detected intro (${intro.checked} checked).`}
        Episodes in the same season are compared to find the theme song they share.</div>
      <div class="row"><button class="btn small" id="intro-run">Find intros now</button><button class="btn small" id="intro-redo">Redo all</button></div>
    </div>`;
}

function bindTranscodingSection() {
  const save = async (body, msg) => {
    try { await api('/api/transcoding', { method: 'PATCH', body }); toast(msg); } catch (err) { toast(err.message, true); }
    router();
  };
  $('#tc-hw').onchange = (e) => { e.target.disabled = true; toast('Testing…'); save({ hwaccel: e.target.value }, 'Saved'); };
  $('#tc-test').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Testing…';
    try { const r = await api('/api/transcoding/test', { method: 'POST' }); toast(`Using: ${r.activeName}`); } catch (err) { toast(err.message, true); }
    router();
  };
  $('#tc-save-cast').onclick = () => save({ castUrl: $('#tc-cast').value }, 'Saved');
  $('#tc-remote').onchange = (e) => save({ remoteMaxQuality: e.target.value }, 'Saved');
  $('#intro-on').onchange = async (e) => {
    try { await api('/api/settings', { method: 'PATCH', body: { introDetection: e.target.checked } }); toast('Saved'); } catch (err) { toast(err.message, true); }
  };
  const run = (force) => async () => {
    if (force && !confirm('Look for intros in every episode again? This can take a while for big libraries.')) return;
    try { await api('/api/intro/detect', { method: 'POST', body: { force } }); toast('Looking for intros…'); } catch (err) { toast(err.message, true); }
    setTimeout(router, 1500);
  };
  $('#intro-run').onclick = run(false);
  $('#intro-redo').onclick = run(true);
}

// ---------- edit an episode's intro by hand (admins) ----------
// "1:23", "01:02:03" or plain seconds → seconds (NaN if unreadable).
function parseClock(s) {
  const parts = String(s).trim().split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0)) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

async function openIntroEditor(id) {
  let it = await api(`/api/items/${id}`);
  const inPlayer = typeof player !== 'undefined' && player?.item?.id === id;
  const field = (name, label, value) => html`<label>${label}
    <span class="row"><input class="input" name="${name}" value="${value != null ? fmtClock(value) : ''}" placeholder="m:ss" style="max-width:120px">
    ${inPlayer ? html`<button type="button" class="btn small" data-now="${name}">Use current position</button>` : ''}</span></label>`;
  const how = (part, setByHand) => (it[part] ? (setByHand ? 'Set by hand.' : 'Found automatically.') : setByHand ? `Marked as having none.` : 'Not found.');
  const m = openModal({
    title: `Intro & credits — ${epLabel(it)} ${it.title}`,
    body: html`<form class="form" id="intro-form">
      <p class="muted" style="margin:0">Times are minutes:seconds from the start of the episode.</p>
      <h3 style="margin:4px 0 0">Intro <span class="muted" style="font-weight:400;font-size:13px">${how('intro', it.introSetByHand)}</span></h3>
      ${field('start', 'Starts at', it.intro?.start ?? null)}
      ${field('end', 'Ends at', it.intro?.end ?? null)}
      <div class="row"><button type="button" class="btn small" data-set="intro:none">No intro</button>
        <button type="button" class="btn small" data-set="intro:auto" title="Forget the manual setting and look for it automatically">Detect automatically</button></div>
      <h3 style="margin:8px 0 0">Credits <span class="muted" style="font-weight:400;font-size:13px">${how('credits', it.creditsSetByHand)}</span></h3>
      ${field('credits', 'Start at', it.credits?.start ?? null)}
      <div class="row"><button type="button" class="btn small" data-set="credits:none">No credits</button>
        <button type="button" class="btn small" data-set="credits:auto">Detect automatically</button></div>
    </form>`.s,
    footer: html`<button class="btn" data-close>Cancel</button><button class="btn primary" data-save>Save</button>`.s,
  });
  const form = $('#intro-form', m.el);
  const initial = Object.fromEntries(['start', 'end', 'credits'].map((n) => [n, form.elements[n].value]));
  const done = (updated, msg) => {
    if (inPlayer) Object.assign(player.item, { intro: updated.intro, credits: updated.credits });
    toast(msg);
    m.close();
    if (!inPlayer) router();
  };
  m.el.querySelector('footer [data-close]').onclick = () => m.close();
  m.el.addEventListener('click', async (e) => {
    const now = e.target.closest('[data-now]');
    if (now) { form.elements[now.dataset.now].value = fmtClock(player.time); return; }
    const set = e.target.closest('[data-set]')?.dataset.set;
    try {
      if (set) {
        const [part, what] = set.split(':');
        const updated = await api(`/api/items/${id}/${part}`, { method: 'PUT', body: { [what]: true } });
        return done(updated, what === 'auto' ? 'Looking for it automatically…' : 'Saved');
      }
      if (!e.target.closest('[data-save]')) return;
      // Only the parts whose times were changed are saved.
      let updated = it;
      if (form.elements.start.value !== initial.start || form.elements.end.value !== initial.end) {
        const body = { start: parseClock(form.elements.start.value), end: parseClock(form.elements.end.value) };
        if (Number.isNaN(body.start) || Number.isNaN(body.end)) return toast('Enter intro times like 1:05', true);
        updated = await api(`/api/items/${id}/intro`, { method: 'PUT', body });
      }
      if (form.elements.credits.value !== initial.credits) {
        const start = parseClock(form.elements.credits.value);
        if (Number.isNaN(start)) return toast('Enter the credits time like 41:30', true);
        updated = await api(`/api/items/${id}/credits`, { method: 'PUT', body: { start } });
      }
      done(updated, 'Saved');
    } catch (err) { toast(err.message, true); }
  });
}

// ---------- settings: problem finder ----------
function problemsSection(p) {
  const link = (x) => html`<a href="#/${x.type === 'show' ? 'show' : 'item'}/${x.id}">${x.title}</a>`;
  const where = (x) => (x.file ? html` <span class="muted path-inner">${x.file}</span>` : '');
  const yr = (y) => (y ? ` (${y})` : '');
  const groups = [
    { key: 'offline', title: 'Folders that are offline or missing', items: p.offline,
      row: (x) => html`<li><b>${x.library}</b>: <code>${x.path}</code></li>`,
      help: 'A drive is unplugged or a folder was moved. Its titles and watch history are kept until it comes back.' },
    { key: 'unreadable', title: 'Files that can’t be read', items: p.unreadable,
      row: (x) => html`<li>${link(x)}${where(x)}</li>`, help: 'ffprobe couldn’t open these. They may be damaged or still copying.' },
    { key: 'review', title: 'Matches that need a check', items: p.review || [], open: true,
      row: (x) => html`<li class="review-row">
        <div><b>${x.name}${yr(x.year)}</b> <span class="muted">· ${x.library}${x.duration >= 60 ? ` · ${Math.round(x.duration / 60)} min` : ''}</span>${where(x)}</div>
        <div class="review-now">${x.current
          ? html`Now: ${link(x)}${yr(x.current.year)} <span class="muted">(${x.current.score != null ? `${x.current.score}% sure` : 'not sure'})</span>
              <button class="btn small" data-review-ok="${x.id}">✓ It's right</button>`
          : html`<span class="muted">Not matched — no result was close enough.</span>`}</div>
        ${x.candidates.length ? html`<div class="review-cands">${x.candidates.map((c) => html`
          <button class="review-cand" data-review-pick="${x.id}" data-provider="${c.provider}" data-pid="${c.id}" title="Use ${c.title}${yr(c.year)}">
            ${c.thumb ? html`<img src="${c.thumb}" alt="" loading="lazy">` : html`<span class="review-noimg">?</span>`}
            <span>${c.title}${yr(c.year)}<br><span class="muted">${c.score}% · ${c.provider === 'tvmaze' ? 'TVmaze' : 'TMDB'}</span></span></button>`)}</div>` : ''}
        <div class="review-more"><button class="link-btn" data-fix-match="${x.id}">Search…</button> · <button class="link-btn" data-review-none="${x.id}">Don't match it</button></div>
      </li>`,
      help: 'Marquee wasn’t sure about these. Pick the right one, confirm the current match, or search. Titles renamed with an id, like “Heat (1995) {tmdb-949}”, always match exactly.' },
    { key: 'unmatched', title: 'No online match', items: p.unmatched,
      row: (x) => html`<li>${link(x)} <button class="link-btn" data-fix-match="${x.id}">Find a match…</button></li>`,
      help: 'No poster or details were found. Renaming the file as “Title (Year)”, or Find a match, usually fixes it.' },
    { key: 'duplicates', title: 'Duplicates', items: p.duplicates,
      row: (g) => html`<li><b>${g.title}</b> — ${g.copies.length} copies<ul>${g.copies.map((x) => html`<li>${link(x)} <span class="muted">(${x.library})</span>${where(x)}</li>`)}</ul></li>`,
      help: 'The same movie or episode more than once (fine if you keep several versions on purpose).' },
    { key: 'missing', title: 'Missing episodes', items: p.missingEpisodes,
      row: (s) => html`<li><a href="#/show/${s.showId}?season=${s.season}">${s.show}</a>, season ${s.season}: episode${s.missing.length === 1 ? '' : 's'} ${s.missing.join(', ')}</li>`,
      help: 'Gaps in episode numbers, up to the last episode you have.' },
  ];
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const r = p.recheck, last = p.lastRecheck;
  return html`
    <h2 style="margin:28px 0 12px" id="problems">Library problems</h2>
    <div class="panel problems">
      <div class="upd-state ${total ? '' : 'ok'}">${total ? `${total} thing${total === 1 ? '' : 's'} to look at` : '✓ No problems found'}</div>
      <div class="row recheck-row"><span class="muted">Re-check matches:</span>
        ${state.libraries.map((l) => html`<button class="btn small" data-recheck="${l.id}" ${r ? 'disabled' : ''} title="Look up every automatic match in ${l.name} again with the current rules (matches you picked or confirmed are kept)">${l.name}</button>`)}
        <span class="muted" style="font-size:13px">${r ? `Checking ${r.library}: ${r.done} of ${r.total}…`
          : last ? `Last check (${last.library}): ${last.total} title${last.total === 1 ? '' : 's'}, ${last.changed} changed, ${last.review} to look at.` : ''}</span></div>
      ${groups.filter((g) => g.items.length).map((g) => html`<details ${g.open ? 'open' : ''}>
        <summary><b>${g.title}</b> <span class="muted">(${g.items.length})</span></summary>
        <p class="muted" style="font-size:13px;margin:6px 0">${g.help}</p>
        <ul>${g.items.slice(0, 200).map(g.row)}</ul>${g.items.length > 200 ? html`<p class="muted">…and ${g.items.length - 200} more.</p>` : ''}
      </details>`)}
    </div>`;
}

// Redraw the problems panel (after fixing something there, and while a re-check runs).
let problemsTimer = null;
async function refreshProblems() {
  clearTimeout(problemsTimer);
  const wrap = $('#problems-wrap');
  if (!wrap) return;
  const p = await api('/api/problems');
  const open = new Set($$('details[open] summary b', wrap).map((b) => b.textContent));
  wrap.innerHTML = problemsSection(p).s;
  for (const d of $$('details', wrap)) if (open.has($('summary b', d).textContent)) d.open = true;
  if (p.recheck) problemsTimer = setTimeout(refreshProblems, 2000);
}
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-review-ok], [data-review-pick], [data-review-none], [data-recheck]');
  if (!t) return;
  const inPanel = !!t.closest('#problems-wrap');
  const after = (msg) => { toast(msg); if (inPanel) refreshProblems(); else router(); };
  try {
    if (t.dataset.reviewOk) { await api(`/api/meta/${t.dataset.reviewOk}/confirm`, { method: 'POST' }); after('Match confirmed'); }
    if (t.dataset.reviewPick) {
      t.disabled = true;
      await api(`/api/meta/${t.dataset.reviewPick}/match`, { method: 'POST', body: { provider: t.dataset.provider, id: t.dataset.pid } });
      after('Match changed');
    }
    if (t.dataset.reviewNone) { await api(`/api/meta/${t.dataset.reviewNone}/unmatch`, { method: 'POST' }); after('Left unmatched (it uses the file name)'); }
    if (t.dataset.recheck) {
      const lib = state.libraries.find((l) => l.id === t.dataset.recheck);
      if (!confirm(`Look up every automatic match in ${lib?.name} again? Matches you picked or confirmed are kept; anything doubtful is listed under “Matches that need a check”.`)) return;
      await api(`/api/libraries/${t.dataset.recheck}/recheck-matches`, { method: 'POST' });
      refreshProblems();
    }
  } catch (err) { t.disabled = false; toast(err.message, true); }
});

// ---------- collections ----------
// "Group into collections": titles that belong to a collection are shown as that collection's card
// (in the first collection they're in). Each group keeps what the library view sorts and filters by.
function groupByCollection(items, cols) {
  const owner = new Map();
  for (const c of cols) if (!c.hidden) for (const id of c.memberIds || []) if (!owner.has(id)) owner.set(id, c);
  const out = [];
  const groups = new Map();
  for (const x of items) {
    const c = owner.get(x.id);
    if (!c) { out.push(x); continue; }
    if (!groups.has(c.id)) {
      const g = { type: 'collection', id: c.id, title: c.name, name: c.name, sortTitle: null, kind: c.kind, cover: c.cover, hidden: false, members: [] };
      groups.set(c.id, g);
      out.push(g);
    }
    groups.get(c.id).members.push(x);
  }
  for (const g of groups.values()) {
    const m = g.members;
    Object.assign(g, {
      count: m.length,
      addedAt: Math.max(...m.map((x) => x.lastAddedAt || x.addedAt || 0)),
      year: Math.min(...m.map((x) => x.year || 9999)) === 9999 ? null : Math.min(...m.map((x) => x.year || 9999)),
      rating: Math.max(...m.map((x) => x.rating || 0)) || null,
      duration: m.reduce((n, x) => n + (x.duration || 0), 0),
      genres: [...new Set(m.flatMap((x) => x.genres || []))],
    });
  }
  return out;
}
const groupingOn = () => store.get('groupCollections', true);

function collectionCard(c) {
  knownItems.set(c.id, c);
  return html`<div class="card ${c.hidden ? 'is-hidden' : ''}" data-sel="${c.id}">
    <div class="art"><a class="cover" href="#/collection/${c.id}">
      ${c.cover ? html`<img loading="lazy" src="${artUrl('poster', c.cover)}" alt="${c.name}">` : html`<div class="collection-empty">▦</div>`}</a>
      <span class="badge" title="Titles in this collection">${c.count}</span></div>
    <a href="#/collection/${c.id}"><div class="title" title="${c.name}">${c.name}</div>
      <div class="sub">${c.hidden ? 'Hidden' : `Collection · ${c.count} title${c.count === 1 ? '' : 's'}`}</div></a>
  </div>`;
}

function collectionChips(x) {
  return x.collections?.length ? html`<div class="row collection-chips">${x.collections.map((c) => html`<a class="chip link" href="#/collection/${c.id}">▦ ${c.name}</a>`)}</div>` : '';
}

// Collections are listed in sections: Movies, TV and YouTube (each collection's section is worked out
// from its titles, or picked by an admin).
const SECTION_HEAD = { movies: 'Movie collections', shows: 'TV collections', videos: 'YouTube collections' };
async function viewCollections({ query, seq }) {
  const libraryId = query.get('library');
  const admin = state.user.role === 'admin';
  const showHidden = admin && query.has('hidden');
  const all = await api(`/api/collections?${libraryId ? `library=${libraryId}&` : ''}${admin ? 'hidden=1' : ''}`);
  const list = all.filter((c) => showHidden || !c.hidden);
  const hiddenCount = all.filter((c) => c.hidden).length;
  const lib = libraryId && state.libraries.find((l) => l.id === libraryId);
  const base = `#/collections${libraryId ? `?library=${libraryId}` : ''}`;
  const sections = Object.keys(SECTION_HEAD).map((k) => [k, list.filter((c) => c.section === k)]).filter(([, l]) => l.length);
  if (!setView(seq, html`
    <div class="toolbar"><h1>${lib ? `${lib.name} · ` : ''}Collections<span class="count">${list.length}</span></h1>
      ${lib ? html`<a class="btn small" href="#/library/${lib.id}">‹ Back to ${lib.name}</a>` : ''}
      ${sections.length > 1 ? html`<div class="seg" id="cols-jump">${sections.map(([k, l]) => html`<button data-jump="${k}">${SECTION_LABEL[k]} (${l.length})</button>`)}</div>` : ''}
      ${admin && list.length ? selectButton() : ''}
      ${admin && hiddenCount ? html`<a class="btn small" href="${showHidden ? base : `${base}${libraryId ? '&' : '?'}hidden`}">${showHidden ? 'Hide hidden' : `Show hidden (${hiddenCount})`}</a>` : ''}
      ${admin ? html`<button class="btn small" id="col-find" title="Look for series in video titles (“… Ep 3”) and offer them as collections">⌕ Find series</button>` : ''}
      ${admin ? html`<button class="btn small primary" id="col-new">＋ New collection</button>` : ''}</div>
    <div id="cols-body">${list.length ? sections.map(([k, l]) => html`
      <section class="hub col-section" id="sec-${k}">
        <div class="hub-head"><h2>${SECTION_HEAD[k]} <span class="muted" style="font-weight:400;font-size:14px">${l.length}</span></h2>
          ${admin && l.length > 1 ? html`<button class="btn small" data-arrange="${k}">⇅ Arrange</button>` : ''}</div>
        <div class="grid" data-grid="${k}">${l.map(collectionCard)}</div>
      </section>`) : html`<div class="empty"><h2>No collections yet</h2>
      <p>Film series like “The Matrix Collection” appear here automatically once two of their movies are matched with TMDB.${admin ? ' You can also make your own with ＋ New collection, by selecting titles in a library (☑ Select), or with ⌕ Find series for YouTube series.' : ''}</p></div>`}</div>`)) return;
  if ($('#cols-jump')) $('#cols-jump').onclick = (e) => { const k = e.target.dataset.jump; if (k) $(`#sec-${k}`)?.scrollIntoView({ behavior: 'smooth' }); };
  if (!admin) return;
  bindSelect({ root: () => $('#cols-body'), kind: 'collections' });
  $('#col-find').onclick = () => openSeriesFinder();
  $('#col-new').onclick = async () => {
    const name = prompt('Name of the new collection');
    if (!name) return;
    try { const c = await api('/api/collections', { method: 'POST', body: { name } }); location.hash = `#/collection/${c.id}`; } catch (err) { toast(err.message, true); }
  };
  $('#cols-body').onclick = (e) => {
    const k = e.target.closest('[data-arrange]')?.dataset.arrange;
    if (!k) return;
    const mine = list.filter((c) => c.section === k);
    const section = $(`#sec-${k} .grid`);
    reorderList(section, {
      items: mine.map((c) => ({ id: c.id, title: c.name, sub: c.kind === 'auto' ? 'From TMDB' : `${c.count} titles`, img: c.cover ? artUrl('poster', c.cover) : null })),
      note: `Drag ${SECTION_HEAD[k].toLowerCase()} into the order you want them listed (for everyone), or use the arrows.`,
      // The other sections (and collections not shown here) keep their places.
      save: (order) => {
        const others = all.map((c) => c.id).filter((id) => !order.includes(id));
        return api('/api/collection-order', { method: 'PUT', body: { order: [...order, ...others] } });
      },
      reset: () => api('/api/collection-order', { method: 'PUT', body: { order: null } }),
      resetLabel: 'Back to alphabetical (all sections)',
    });
  };
}

// "Find series": groups of videos whose titles share a name before "Ep 1", "Part 2"… offered as new
// collections ordered by episode number.
async function openSeriesFinder() {
  const found = await api('/api/collection-suggestions');
  const m = openModal({
    title: 'Find series',
    wide: true,
    body: found.length ? html`<p class="muted" style="margin-top:0">Videos whose titles share a name before an episode number (“… Ep 3”, “Part 2”, “#12”). Tick the ones to turn into collections; they'll be ordered by episode number, and new episodes join them when you add them by hand or with ☑ Select.</p>
      <div class="form">${found.map((f, i) => html`<div class="series-row"><input type="checkbox" data-i="${i}" checked aria-label="Make a collection of ${f.name}">
        <div style="flex:1;min-width:0"><input class="input" data-name="${i}" value="${f.name}" aria-label="Collection name" style="width:min(360px,100%)">
          <span class="muted">${f.count} videos${f.channel ? ` · ${f.channel}` : ''} · ${SECTION_LABEL[f.section]}</span>
          <div class="muted" style="font-size:12px;margin-top:4px">${f.titles.join(' · ')}${f.count > f.titles.length ? ' …' : ''}</div></div></div>`)}</div>`.s
      : html`<p>No new series found. This looks for at least two videos whose titles share a name followed by an episode number, like “Hardcore Survival Ep 1” and “Hardcore Survival Ep 2”, that aren't already in one collection.</p>`.s,
    footer: found.length ? html`<button class="btn" data-close>Cancel</button><button class="btn primary" id="sf-create">Create collections</button>`.s : html`<button class="btn primary" data-close>OK</button>`.s,
  });
  for (const b of $$('footer [data-close]', m.el)) b.onclick = () => m.close();
  if (!found.length) return;
  $('#sf-create', m.el).onclick = async () => {
    const picked = $$('input[data-i]', m.el).filter((x) => x.checked).map((x) => Number(x.dataset.i));
    if (!picked.length) return toast('Nothing ticked', true);
    try {
      for (const i of picked) {
        const name = $(`[data-name="${i}"]`, m.el).value.trim() || found[i].name;
        await api('/api/collections', { method: 'POST', body: { name, members: found[i].memberIds, sort: 'episode', section: found[i].section } });
      }
      toast(`Made ${picked.length} collection${picked.length === 1 ? '' : 's'}`);
      m.close();
      router();
    } catch (err) { toast(err.message, true); }
  };
}

async function viewCollection({ params: [id], seq }) {
  const c = await api(`/api/collections/${id}`);
  const admin = state.user.role === 'admin';
  const auto = c.kind === 'auto';
  if (!setView(seq, html`
    <div class="toolbar"><h1>${c.name}<span class="count">${c.count}</span></h1>
      <span class="muted">${auto ? `From TMDB${c.tmdbName && c.tmdbName !== c.name ? ` (“${c.tmdbName}”)` : ''}${c.changed ? ' · changed by an admin' : ''}` : 'Collection'} · ${SECTION_LABEL[c.section]}</span>
      ${admin && c.items.length ? selectButton() : ''}
      ${admin ? html`<button class="btn small" id="col-rename">Rename</button>` : ''}
      ${admin && auto && c.changed ? html`<button class="btn small" id="col-reset" title="Undo every change made to this TMDB collection">Reset to TMDB</button>` : ''}
      ${admin ? html`<button class="btn small danger" id="col-delete">${auto ? (c.hidden ? 'Show again' : 'Hide') : 'Delete'}</button>` : ''}</div>
    ${c.hidden ? html`<div class="filter-note">This collection is hidden from everyone. Use “Show again” to bring it back.</div>` : ''}
    ${admin ? html`<div class="row col-options">
      <label>Order <select id="col-sort">${Object.entries(SORT_LABEL).map(([k, l]) => html`<option value="${k}" ${c.sort === k ? 'selected' : ''}>${l}</option>`)}</select></label>
      ${c.sort !== 'custom' ? html`<button class="btn small ${c.reverse ? 'on' : ''}" id="col-reverse" aria-pressed="${c.reverse ? 'true' : 'false'}" title="Show the order the other way round (last first)">⇵ ${c.reverse ? 'Reversed' : 'Reverse'}</button>` : ''}
      ${c.items.length > 1 ? html`<button class="btn small" id="col-reorder" title="Drag the titles into any order">✋ Arrange by hand</button>` : ''}
      <label>Show under <select id="col-section"><option value="" ${c.sectionSetByHand ? '' : 'selected'}>Automatic</option>
        ${Object.entries(SECTION_LABEL).map(([k, l]) => html`<option value="${k}" ${c.sectionSetByHand && c.section === k ? 'selected' : ''}>${l}</option>`)}</select></label>
      ${c.sort === 'episode' ? html`<span class="muted" style="font-size:13px">Uses numbers in the titles: “Ep 12”, “Episode 12”, “S2E5”, “Part 3”, “#12”, or a number at the end.</span>` : ''}
    </div>` : ''}
    <div id="col-body">${c.items.length ? html`<div class="grid">${c.items.map((x) => posterCard(x, admin ? `collection:${c.id}` : ''))}</div>`
      : html`<div class="empty"><p>This collection is empty. Use “Add to collection…” in the ⋯ menu of a movie or show.</p></div>`}</div>
    ${admin ? html`<p class="muted" style="font-size:13px">Tip: ☑ Select removes several titles at once; each title's ⋯ menu can also make its poster the collection's cover.</p>` : ''}`)) return;
  if (!admin) return;
  const patch = async (body, msg) => { try { await api(`/api/collections/${id}`, { method: 'PATCH', body }); toast(msg); router(); } catch (err) { toast(err.message, true); } };
  bindSelect({ root: () => $('#col-body'), kind: 'titles', collectionId: id });
  $('#col-sort').onchange = (e) => patch({ sort: e.target.value }, `Ordered by ${SORT_LABEL[e.target.value].toLowerCase()}`);
  if ($('#col-reverse')) $('#col-reverse').onclick = () => patch({ reverse: !c.reverse }, 'Order reversed');
  $('#col-section').onchange = (e) => patch({ section: e.target.value || null }, e.target.value ? `Shown under ${SECTION_LABEL[e.target.value]}` : 'Section decided from the titles');
  if ($('#col-reorder')) $('#col-reorder').onclick = () => reorderList($('#col-body'), {
    items: c.items.map((x) => ({ id: x.id, title: x.title, sub: x.year || '', img: artUrl('poster', x) })),
    note: 'Drag titles into the order you want, or use the arrows. Everyone sees this order; titles added later go at the end.',
    save: (order) => api(`/api/collections/${id}/order`, { method: 'PUT', body: { order } }),
    reset: c.customOrder ? () => api(`/api/collections/${id}/order`, { method: 'PUT', body: { order: null } }) : null,
    resetLabel: 'Stop arranging by hand (back to release date)',
  });
  $('#col-rename').onclick = () => {
    const name = prompt(auto ? `New name (leave empty to use TMDB's name, “${c.tmdbName}”)` : 'New name', c.name);
    if (name === null || name === c.name) return;
    patch({ name }, 'Renamed');
  };
  if ($('#col-reset')) $('#col-reset').onclick = async () => {
    if (!confirm('Undo every change to this collection (name, titles, order, cover, hidden) and use TMDB’s version again?')) return;
    try { await api(`/api/collections/${id}/reset`, { method: 'POST' }); toast('Back to TMDB’s version'); router(); } catch (err) { toast(err.message, true); }
  };
  $('#col-delete').onclick = async () => {
    if (auto) return patch({ hidden: !c.hidden }, c.hidden ? 'Shown again' : 'Hidden from everyone');
    if (!confirm(`Delete the collection “${c.name}”? The movies and shows in it are not affected.`)) return;
    await api(`/api/collections/${id}`, { method: 'DELETE' });
    toast('Collection deleted'); history.back();
  };
}

// Drag-and-drop list (with ▲ ▼ for touch screens and keyboards) used to arrange collections and
// the titles in them. items: [{ id, title, sub, img }]; save(order) / reset() return promises.
function reorderList(container, { items, note, save, reset, resetLabel }) {
  let order = items.map((x) => x.id);
  const byId = new Map(items.map((x) => [x.id, x]));
  const render = () => {
    container.innerHTML = html`<div class="panel reorder">
      <p class="muted" style="margin:0 0 8px">${note}</p>
      <ol class="reorder-list">${order.map((id, i) => { const x = byId.get(id); return html`
        <li draggable="true" data-id="${id}">
          <span class="drag-handle" aria-hidden="true">⋮⋮</span>
          ${x.img ? html`<img src="${x.img}" alt="">` : html`<span class="reorder-noimg">▦</span>`}
          <span class="reorder-title"><b>${x.title}</b> <span class="muted">${x.sub}</span></span>
          <button class="btn small" data-move="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move ${x.title} up">▲</button>
          <button class="btn small" data-move="1" ${i === order.length - 1 ? 'disabled' : ''} aria-label="Move ${x.title} down">▼</button>
        </li>`; })}</ol>
      <div class="row" style="margin-top:10px"><button class="btn primary" data-ro="save">Save order</button>
        <button class="btn" data-ro="cancel">Cancel</button>
        ${reset ? html`<button class="btn" data-ro="reset">${resetLabel}</button>` : ''}</div>
    </div>`.s;
  };
  const done = (p, msg) => p.then(() => { toast(msg); router(); }, (err) => toast(err.message, true));
  let dragging = null;
  container.onclick = (e) => {
    const mv = e.target.closest('[data-move]');
    if (mv) {
      const id = mv.closest('li').dataset.id;
      const i = order.indexOf(id), j = i + Number(mv.dataset.move);
      [order[i], order[j]] = [order[j], order[i]];
      render();
      $(`li[data-id="${id}"] [data-move="${mv.dataset.move}"]`, container)?.focus();
      return;
    }
    const act = e.target.closest('[data-ro]')?.dataset.ro;
    if (act === 'save') done(save(order), 'Order saved');
    if (act === 'cancel') router();
    if (act === 'reset') done(reset(), 'Order reset');
  };
  container.ondragstart = (e) => { dragging = e.target.closest('li')?.dataset.id; e.dataTransfer.effectAllowed = 'move'; };
  container.ondragover = (e) => {
    const li = e.target.closest('li');
    if (!dragging || !li || li.dataset.id === dragging) return;
    e.preventDefault();
    // Drop before or after the row under the pointer, depending on which half it's over.
    const r = li.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    order = order.filter((x) => x !== dragging);
    order.splice(order.indexOf(li.dataset.id) + (after ? 1 : 0), 0, dragging);
    render();
  };
  container.ondragend = () => { dragging = null; };
  render();
}

// "Add to collection…": tick the collections a movie or show should be in (TMDB ones too), or make a new one.
async function openCollectionPicker(x) {
  const [all, detail] = await Promise.all([api('/api/collections?hidden=1'), api(x.type === 'show' ? `/api/shows/${x.id}` : `/api/items/${x.id}`)]);
  const inIds = new Set((detail.collections || []).map((c) => c.id));
  const m = openModal({
    title: `Collections — ${x.title}`,
    body: html`<div class="form">
      ${all.length ? all.map((c) => html`<label class="check"><input type="checkbox" data-col="${c.id}" ${inIds.has(c.id) ? 'checked' : ''}> ${c.name}
          <span class="muted">(${c.count}${c.kind === 'auto' ? ', from TMDB' : ''}${c.hidden ? ', hidden' : ''})</span></label>`)
        : html`<p class="muted" style="margin:0">There are no collections yet.</p>`}
      <label>New collection <span class="row"><input class="input" id="col-new-name" placeholder="e.g. Christmas movies"><button class="btn small" id="col-new-add">Add</button></span></label>
    </div>`.s,
    footer: html`<button class="btn primary" data-close>Done</button>`.s,
    onClose: () => router(),
  });
  m.el.addEventListener('change', async (e) => {
    const id = e.target.dataset.col; if (!id) return;
    try { await api(`/api/collections/${id}/members/${x.id}`, { method: e.target.checked ? 'PUT' : 'DELETE' }); } catch (err) { toast(err.message, true); }
  });
  $('#col-new-add', m.el).onclick = async () => {
    const name = $('#col-new-name', m.el).value.trim();
    if (!name) return;
    try { await api('/api/collections', { method: 'POST', body: { name, members: [x.id] } }); toast(`Added to ${name}`); m.close(); } catch (err) { toast(err.message, true); }
  };
  m.el.querySelector('footer [data-close]').onclick = () => m.close();
}

// ---------- subtitles from OpenSubtitles.com ----------
// Search and download subtitles for an item; onAdded(detail, newSubId) runs after a download.
async function openSubtitleSearch(id, onAdded) {
  const it = knownItems.get(id) || await api(`/api/items/${id}`);
  const m = openModal({
    title: `Find subtitles — ${it.type === 'episode' ? `${it.showTitle} ${epLabel(it)}` : it.title}`,
    wide: true,
    body: html`<form class="row" id="subs-form" style="margin-bottom:12px">
        <label>Language <input class="input" name="lang" value="${store.get('subsLang', (navigator.language || 'en').slice(0, 2).toLowerCase())}" style="max-width:110px" placeholder="en"></label>
        <button class="btn primary" style="align-self:flex-end">Search</button>
        <span class="muted" style="font-size:13px;align-self:flex-end">Two-letter codes, e.g. en, es, fr — several with commas.</span>
      </form><div id="subs-results" class="muted">Searching…</div>`.s,
  });
  const box = $('#subs-results', m.el);
  const form = $('#subs-form', m.el);
  let results = [];
  const search = async () => {
    const lang = form.elements.lang.value.trim() || 'en';
    store.set('subsLang', lang);
    box.textContent = 'Searching…';
    try {
      results = (await api(`/api/items/${id}/subtitle-search?lang=${encodeURIComponent(lang)}`)).results;
      box.innerHTML = results.length ? html`<div class="subs-list">${results.map((r, i) => html`
        <div class="subs-row">
          <div><b>${r.language?.toUpperCase()}</b> ${r.release || 'Unnamed'}
            <div class="muted" style="font-size:12px">${r.downloads.toLocaleString()} downloads${r.hashMatch ? ' · ✓ made for this exact file' : ''}${r.hearingImpaired ? ' · for deaf and hard of hearing' : ''}${r.machineTranslated ? ' · machine translated' : ''}</div></div>
          <button class="btn small" data-get="${i}">Download</button>
        </div>`)}</div>`.s : html`<p>No subtitles found in that language.</p>`.s;
    } catch (err) { box.textContent = err.message; }
  };
  form.onsubmit = (e) => { e.preventDefault(); search(); };
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-get]'); if (!b) return;
    const r = results[Number(b.dataset.get)];
    b.disabled = true; b.textContent = 'Downloading…';
    try {
      const d = await api(`/api/items/${id}/subtitle-download`, { method: 'POST', body: { fileId: r.fileId, language: r.language, release: r.release } });
      toast(`Subtitles added${d.remaining != null ? ` (${d.remaining} downloads left today)` : ''}`);
      m.close();
      onAdded?.(d, d.added);
    } catch (err) { toast(err.message, true); b.disabled = false; b.textContent = 'Download'; }
  });
  search();
}

// ---------- activity (admins): who is watching what right now ----------
async function viewActivity({ seq }) {
  if (state.user.role !== 'admin') { location.replace('#/'); return; }
  const modeLabel = (s) => {
    const c = s.conversion;
    const by = c?.encoderName ? ` on ${c.encoderName}` : '';
    if (s.mode === 'cast') return 'Casting to a TV';
    if (s.mode === 'direct') return 'Direct Play';
    if (s.mode === 'hls' || c?.kind === 'hls') return `Adaptive · ${s.quality === 'auto' || !s.quality ? (c?.quality ? `Auto (${c.quality})` : 'Auto') : s.quality}${c ? ` · converting${by}` : ''}`;
    if (c) return c.encoder ? `Converting${by}` : 'Converting audio only (video copied)';
    return s.mode === 'transcode' ? 'Converting' : 'Playing';
  };
  const title = (it) => (!it ? 'Unknown video' : it.type === 'episode' ? `${it.showTitle} · ${epLabel(it)} — ${it.title}` : it.title);
  const render = (a) => html`
    <div class="toolbar"><h1>Activity<span class="count">${a.streams.length}</span></h1>
      <span class="muted">Updates every few seconds</span></div>
    <div class="activity-stats">
      <div class="panel"><div class="muted">Server CPU</div><b>${a.cpu.percent}%</b><div class="meter"><span style="width:${a.cpu.percent}%"></span></div><div class="muted">${a.cpu.cores} cores</div></div>
      <div class="panel"><div class="muted">Memory in use</div><b>${Math.round((1 - a.memory.free / a.memory.total) * 100)}%</b><div class="meter"><span style="width:${(1 - a.memory.free / a.memory.total) * 100}%"></span></div><div class="muted">${fmtSize(a.memory.total)} total</div></div>
      <div class="panel"><div class="muted">Converting video with</div><b>${a.encoder.name}</b><div class="muted">${a.streams.filter((s) => s.conversion?.encoder).length + a.others.filter((o) => o.encoder).length} video conversion(s) running</div></div>
    </div>
    ${a.streams.length ? a.streams.map((s) => html`
      <div class="panel activity-row">
        ${s.item ? html`<img src="${artUrl(s.item.type === 'episode' ? 'thumb' : 'backdrop', s.item)}" alt="">` : html`<div></div>`}
        <div class="activity-info">
          <div><b>${s.user}</b> <span class="muted">· ${s.device}${s.remote ? ' · away from home' : ''} · ${s.ip}</span></div>
          <a href="#/item/${s.itemId}" style="font-weight:600">${title(s.item)}</a>
          <div class="muted" style="font-size:13px">${s.paused ? '❚❚ Paused' : '▶ Playing'} · ${modeLabel(s)} · started ${new Date(s.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
          ${s.item?.duration ? html`<div class="activity-progress"><span style="width:${pct(s.position, s.item.duration)}%"></span></div>
            <div class="muted" style="font-size:12px">${fmtClock(s.position)} / ${fmtClock(s.item.duration)}</div>` : ''}
        </div>
      </div>`) : html`<div class="panel muted">Nobody is watching right now.</div>`}
    ${a.others.length ? html`<h2 style="margin:24px 0 12px">Other conversions</h2>
      <p class="muted" style="margin:-6px 0 10px;font-size:13px">Streams with no player reporting back, for example a Chromecast fetching the video itself.</p>
      ${a.others.map((o) => html`<div class="panel" style="padding:10px 14px">${title(o.item)} <span class="muted">· ${o.user || 'someone'} · ${o.kind === 'hls' ? `adaptive ${o.quality}` : 'converting'}${o.encoderName ? ` on ${o.encoderName}` : ''}</span></div>`)}` : ''}`;
  const load = async () => {
    const a = await api('/api/activity');
    if (parseHash().path !== '/activity') return false;
    view.innerHTML = render(a).s;
    return true;
  };
  const a = await api('/api/activity');
  if (!setView(seq, render(a))) return;
  // Refresh while the page is open (one timer, even when the page is opened again).
  clearInterval(activityTimer);
  activityTimer = setInterval(async () => { if (!(await load().catch(() => true))) clearInterval(activityTimer); }, 3000);
}
let activityTimer = null;

// ---------- settings: logs ----------
function logsSection() {
  return html`
    <h2 style="margin:28px 0 12px" id="logs">Logs</h2>
    <div class="panel">
      <div class="row" style="justify-content:space-between">
        <div class="seg" id="logs-filter"><button data-all="0" class="on">Problems</button><button data-all="1">Everything</button></div>
        <button class="btn small" id="logs-copy" title="Copy these messages, e.g. to send to whoever helps you">Copy</button>
      </div>
      <div id="logs-list" class="logs-list muted">Loading…</div>
    </div>`;
}

function bindLogsSection() {
  let all = false, entries = [];
  const time = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const load = async () => {
    entries = (await api(`/api/logs${all ? '?all' : ''}`)).entries;
    $('#logs-list').innerHTML = entries.length ? entries.slice(0, 200).map((e) => html`
      <div class="log-entry ${e.level}">
        <span class="log-time">${time(e.at)}</span><span class="log-level">${e.level === 'error' ? 'Error' : e.level === 'warning' ? 'Warning' : 'Info'}</span>
        <div class="log-msg">${e.hint ? html`<b>${e.hint}</b><br>` : ''}<code>${e.message}</code></div>
      </div>`.s).join('') : html`<p style="margin:0">${all ? 'No messages since the server started.' : '✓ No problems since the server started.'}</p>`.s;
  };
  $('#logs-filter').onclick = (e) => {
    if (e.target.dataset.all == null) return;
    all = e.target.dataset.all === '1';
    $$('#logs-filter button').forEach((b) => b.classList.toggle('on', b === e.target));
    load().catch((err) => toast(err.message, true));
  };
  $('#logs-copy').onclick = () => {
    const text = entries.map((e) => `${new Date(e.at).toISOString()} ${e.level.toUpperCase()} ${e.message}`).join('\n') || 'No messages';
    navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast("Couldn't copy", true));
  };
  load().catch((err) => { $('#logs-list').textContent = err.message; });
}
