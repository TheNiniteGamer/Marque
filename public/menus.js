'use strict';
/* Marquee web client — item menus and actions, and the dialogs they open: edit details, fix match,
   episode numbering, fix episode, edit an intro by hand, subtitles from OpenSubtitles; My List and
   the keyboard shortcut overlay. Helpers from app.js are used only when called. */

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
// ([data-popmenu]: a button that opens its own menu with openMenu, e.g. a page's ⋯ in its toolbar.)
document.addEventListener('click', (e) => { if (openPop && !e.target.closest('.popmenu, [data-menu], [data-popmenu]')) closeMenu(); });
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
      const s = await api(`/api/shows/${x.id}?episodes=none`);
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
    { label: '⌕  Fix episode…', hidden: !admin || x.type !== 'episode', onClick: () => openEpisodeFixer(x.id) },
    { label: '#  Episode numbering…', hidden: !admin || x.type !== 'show', onClick: () => openNumbering(x) },
    { label: '⌕  Fix show match…', hidden: !admin || x.type !== 'episode' || !x.showId, onClick: () => openMatcher(x.showId) },
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
const FIELD_LABEL = { title: 'Title', sortTitle: 'Sort title', year: 'Year', tagline: 'Tagline', overview: 'Summary', genres: 'Genres', contentRating: 'Age rating (e.g. PG, TV-Y7, 12)' };
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
        ${d.match && k !== 'thumb' ? html`<button class="btn small" data-choose="${k}">Choose from ${sourceName(d.match.provider)}…</button>` : ''}
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
    ? html`Currently matched to <b>${d.match.title || '?'}</b>${d.match.year ? ` (${d.match.year})` : ''} on ${sourceName(d.match.provider)}.`
    : d.unmatched ? 'Currently unmatched (using information from the file name only).' : 'Not matched yet.';
  const m = openModal({
    title: `Fix match`,
    wide: true,
    body: html`
      <p class="muted" style="margin-top:0">${current}</p>
      ${!providers.length ? html`<div class="error-box">${d.kind === 'movie'
        ? html`To look up movies, add a free TMDB API key in <a href="#/settings/metadata" data-close>Settings → Metadata</a>.`
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
            <span class="chip">${sourceName(x.provider)}</span>
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

// ---------- episode numbering (anime) ----------
// Shows numbered straight through ("One Piece - 1071") are placed in their seasons automatically;
// this sets it for one show when the automatic choice is wrong.
async function openNumbering(show) {
  const d = await api(`/api/shows/${show.id}?episodes=none`);
  const now = d.numbering || 'auto';
  const opts = [
    ['auto', 'Automatic', 'Episode numbers without a season (“Show - 1071”) are counted through the whole show when they don’t exist in their season.'],
    ['absolute', 'Counted straight through', 'For anime and other shows whose files are numbered 1, 2, 3… across every season.'],
    ['season', 'By season', 'Each season starts again at episode 1, as in “Season 2/Episode 05”.'],
  ];
  const m = openModal({
    title: `Episode numbering — ${show.title}`,
    body: html`<div class="form">${opts.map(([k, l, note]) => html`<label class="check" style="align-items:flex-start"><input type="radio" name="num" value="${k}" ${k === now ? 'checked' : ''}>
      <span><b>${l}</b><br><span class="muted" style="font-size:13px">${note}</span></span></label>`)}</div>`.s,
    footer: html`<button class="btn" data-close>Cancel</button><button class="btn primary" id="num-save">Save</button>`.s,
  });
  $$('[data-close]', m.el).forEach((b) => { b.onclick = m.close; });
  $('#num-save', m.el).onclick = async (e) => {
    e.target.disabled = true;
    try {
      await api(`/api/meta/${show.id}/numbering`, { method: 'PUT', body: { numbering: $('input[name=num]:checked', m.el).value } });
      toast('Episodes renumbered'); m.close(); router();
    } catch (err) { toast(err.message, true); e.target.disabled = false; }
  };
}

// ---------- fix episode ----------
// A file whose name has the wrong numbers (DVD order, specials, a double episode named as one) shows
// another episode's title and picture. Pick the episode it really is from the show's list; the
// choice is kept when files are rescanned.
async function openEpisodeFixer(id) {
  const d = await api(`/api/meta/${id}/episodes`);
  const label = (s, e) => `S${String(s ?? 0).padStart(2, '0')}E${String(e ?? 0).padStart(2, '0')}`;
  const seasons = [...new Set(d.choices.map((c) => c.season))];
  let season = seasons.includes(d.current.season) ? d.current.season : seasons[0];
  const m = openModal({
    title: 'Fix episode',
    wide: true,
    body: html`
      <p class="muted" style="margin-top:0"><code>${d.file}</code> is now <b>${label(d.current.season, d.current.episode)}</b> of ${d.show.title}${d.current.byHand ? ' (set by hand)' : ' (from its file name)'}.
        Pick the episode it really is.</p>
      ${d.show.matched ? (seasons.length ? html`<div class="row" style="margin-bottom:10px"><label>Season <select id="ef-season">${seasons.map((s) => html`<option value="${s}" ${s === season ? 'selected' : ''}>${s === 0 ? 'Specials' : `Season ${s}`}</option>`)}</select></label></div>
        <div id="ef-list" class="match-results"></div>` : html`<p class="muted">The show's source has no episode list.</p>`)
        : html`<div class="filter-note">${d.show.title} isn't matched online, so there's no episode list. Set the numbers below, or match the show first (⋯ → Fix show match…).</div>`}
      <form class="row" id="ef-form" style="margin-top:14px;align-items:center;gap:8px">
        <span class="muted">Or by number:</span>
        <label>Season <input class="input" name="season" type="number" min="0" max="999" value="${d.current.season ?? ''}" style="width:80px" required></label>
        <label>Episode <input class="input" name="episode" type="number" min="0" max="9999" value="${d.current.episode ?? ''}" style="width:90px" required></label>
        <button class="btn" type="submit">Set</button>
      </form>`.s,
    footer: html`${d.current.byHand ? html`<button class="btn" id="ef-reset" style="margin-right:auto">Use the file name's numbers</button>` : ''}<button class="btn" data-close>Close</button>`.s,
  });
  const el = m.el;
  $$('[data-close]', el).forEach((b) => { b.onclick = m.close; });
  const save = async (body, msg) => {
    try { await api(`/api/meta/${id}/episode`, { method: 'PUT', body }); toast(msg); m.close(); router(); } catch (err) { toast(err.message, true); }
  };
  const render = () => {
    if (!$('#ef-list', el)) return;
    $('#ef-list', el).innerHTML = d.choices.filter((c) => c.season === season).map((c) => html`
      <button class="match-row ${c.season === d.current.season && c.episode === d.current.episode ? 'current' : ''}" data-s="${c.season}" data-e="${c.episode}">
        <span class="match-thumb wide">${c.thumb ? html`<img loading="lazy" src="${c.thumb}" alt="">` : ''}</span>
        <span class="match-info"><span class="match-line"><b>${c.episode}. ${c.title || `Episode ${c.episode}`}</b> ${c.airDate ? html`<span class="muted">${c.airDate}</span>` : ''}
          ${c.season === d.current.season && c.episode === d.current.episode ? html`<span class="chip current">Now</span>` : ''}</span>
          ${c.takenBy ? html`<span class="match-overview">Already: <code>${c.takenBy}</code></span>` : ''}</span>
      </button>`.s).join('');
  };
  render();
  if ($('#ef-season', el)) $('#ef-season', el).onchange = (e) => { season = Number(e.target.value); render(); };
  el.addEventListener('click', (e) => {
    const b = e.target.closest('.match-row[data-s]');
    if (b) save({ season: Number(b.dataset.s), episode: Number(b.dataset.e) }, `Now ${label(b.dataset.s, b.dataset.e)}`);
  });
  $('#ef-form', el).onsubmit = (e) => {
    e.preventDefault();
    const f = e.target.elements;
    save({ season: Number(f.season.value), episode: Number(f.episode.value) }, `Now ${label(f.season.value, f.episode.value)}`);
  };
  if ($('#ef-reset', el)) $('#ef-reset', el).onclick = () => save({ season: null, episode: null }, 'Back to the file name’s numbers');
}

// ---------- My List ----------
async function viewWatchlist({ seq }) {
  const list = await api('/api/watchlist');
  setView(seq, html`
    <div class="toolbar"><h1>My List<span class="count">${list.length}</span></h1>${list.length ? selectButton() : ''}</div>
    ${list.length ? html`<div class="grid">${list.map(posterCard)}</div>`
      : emptyState({ art: 'heart', title: 'Nothing saved yet', text: 'Use the ⋯ menu on any film or show, or the ♡ button on its page, to keep it here for later.', actions: html`<a class="btn" href="#/">Find something</a>` })}`);
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
