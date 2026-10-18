'use strict';
/* Marquee web client — picking several titles (or collections) at once and acting on them all:
   add to a collection, mark watched, My List, genres, refresh. Loaded before app.js; helpers from
   app.js and extras.js are used only when called. */

const SECTION_LABEL = { movies: 'Movies', shows: 'TV', videos: 'YouTube' };
const SORT_LABEL = { release: 'Release date', episode: 'Episode number in the title', title: 'Title (A–Z)', added: 'Date added', custom: 'Arranged by hand' };

// opts: { root: () => element holding the cards, kind: 'titles' | 'collections', collectionId }
const selecting = { on: false, ids: new Set(), last: null, opts: null, bar: null };

const selectButton = () => html`<button class="btn small" data-select-toggle title="Pick several and act on them all at once">☑ Select</button>`;
function bindSelect(opts) {
  for (const b of $$('[data-select-toggle]')) b.onclick = () => (selecting.on ? endSelect() : startSelect(opts));
}

function startSelect(opts) {
  endSelect();
  Object.assign(selecting, { on: true, ids: new Set(), last: null, opts });
  document.body.classList.add('selecting');
  for (const b of $$('[data-select-toggle]')) { b.classList.add('on'); b.textContent = '✕ Stop selecting'; }
  selecting.bar = document.createElement('div');
  selecting.bar.className = 'select-bar';
  selecting.bar.setAttribute('role', 'toolbar');
  selecting.bar.onclick = onBarClick;
  document.body.append(selecting.bar);
  renderSelectBar();
}

function endSelect() {
  if (!selecting.on) return;
  selecting.on = false;
  selecting.ids.clear();
  selecting.bar?.remove();
  selecting.bar = null;
  document.body.classList.remove('selecting');
  for (const c of $$('.selected[data-sel]')) c.classList.remove('selected');
  for (const b of $$('[data-select-toggle]')) { b.classList.remove('on'); b.textContent = '☑ Select'; }
}

const selectableCards = () => (selecting.opts?.root() ? $$('[data-sel]', selecting.opts.root()) : []);
// Called after a grid is redrawn (filters, sorting) so the ticks come back.
function markSelected() {
  if (!selecting.on) return;
  for (const c of selectableCards()) c.classList.toggle('selected', selecting.ids.has(c.dataset.sel));
}

// While selecting, a click (or Enter on a focused card) ticks the card instead of opening it.
// Shift+click ticks everything between the last card and this one.
document.addEventListener('click', (e) => {
  if (!selecting.on || e.target.closest('.select-bar')) return;
  const card = e.target.closest('[data-sel]');
  if (!card || !selecting.opts.root()?.contains(card)) return;
  e.preventDefault();
  e.stopPropagation();
  const id = card.dataset.sel;
  const on = !selecting.ids.has(id);
  if (e.shiftKey && selecting.last) {
    const order = selectableCards().map((c) => c.dataset.sel);
    const [a, b] = [order.indexOf(selecting.last), order.indexOf(id)].sort((x, y) => x - y);
    if (a >= 0) for (const x of order.slice(a, b + 1)) selecting.ids.add(x);
    else selecting.ids.add(id);
  } else if (on) selecting.ids.add(id);
  else selecting.ids.delete(id);
  selecting.last = id;
  markSelected();
  renderSelectBar();
}, true);
document.addEventListener('keydown', (e) => {
  if (!selecting.on || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  if (e.key === 'Escape' && !$('.modal-backdrop')) { endSelect(); e.stopPropagation(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); }
}, true);

function selectAll() {
  const cards = selectableCards();
  const all = cards.every((c) => selecting.ids.has(c.dataset.sel));
  for (const c of cards) { if (all) selecting.ids.delete(c.dataset.sel); else selecting.ids.add(c.dataset.sel); }
  markSelected();
  renderSelectBar();
}

// Titles behind the selection: a collection card (when titles are grouped) stands for its titles.
function selectedTitleIds() {
  return [...new Set([...selecting.ids].flatMap((id) => {
    const x = knownItems.get(id);
    if (x?.type === 'collection') return x.members ? x.members.map((m) => m.id) : x.memberIds || [];
    return [id];
  }))];
}

function selectActions() {
  const admin = state.user.role === 'admin';
  if (selecting.opts.kind === 'collections') {
    return admin ? [
      { key: 'section', label: '⇄ Show under…' },
      { key: 'sort', label: '⇅ Order titles by…' },
      { key: 'hide', label: '✕ Hide or delete…', danger: true },
    ] : [];
  }
  return [
    { key: 'collect', label: '▦ Add to collection…', hidden: !admin },
    { key: 'uncollect', label: '✕ Remove from this collection', hidden: !admin || !selecting.opts.collectionId },
    { key: 'watched', label: '✓ Mark watched' },
    { key: 'unwatched', label: '○ Mark unwatched' },
    { key: 'list', label: '♡ My List…' },
    { key: 'more', label: '⋯ More', hidden: !admin },
  ].filter((a) => !a.hidden);
}

function renderSelectBar() {
  const bar = selecting.bar;
  if (!bar) return;
  const n = selecting.ids.size;
  const total = selectableCards().length;
  const titles = selecting.opts.kind === 'titles' ? selectedTitleIds().length : n;
  const what = selecting.opts.kind === 'collections' ? 'collection' : 'title';
  bar.innerHTML = html`
    <span class="sel-count"><b>${n}</b> selected${titles !== n ? html` <span class="muted">(${titles} titles)</span>` : ''}</span>
    <button class="btn small" data-sa="all">${total && n === total ? 'Select none' : `Select all (${total})`}</button>
    <span class="sel-actions">${selectActions().map((a) => html`<button class="btn small ${a.danger ? 'danger' : ''}" data-sa="${a.key}" ${n ? '' : 'disabled'}>${a.label}</button>`)}</span>
    <span class="muted sel-hint">${n ? '' : `Click ${what}s to pick them · Shift+click picks a range`}</span>
    <button class="btn small primary" data-sa="done">Done</button>`.s;
}

async function onBarClick(e) {
  const b = e.target.closest('[data-sa]');
  if (!b || b.disabled) return;
  e.stopPropagation(); // the page closes menus on clicks elsewhere; this one may open a menu
  if (openPop) { closeMenu(); return; }
  const act = b.dataset.sa;
  if (act === 'done') return endSelect();
  if (act === 'all') return selectAll();
  try {
    if (selecting.opts.kind === 'collections') await collectionsAction(act, b);
    else await titlesAction(act, b);
  } catch (err) { toast(err.message, true); }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
function finish(msg) { toast(msg); endSelect(); router(); }

async function bulk(action, extra = {}) {
  const ids = selectedTitleIds();
  await api('/api/bulk', { method: 'POST', body: { ids, action, ...extra } });
  return ids.length;
}

async function titlesAction(act, anchor) {
  const ids = selectedTitleIds();
  if (act === 'collect') return openBulkCollect(ids);
  if (act === 'uncollect') {
    const id = selecting.opts.collectionId;
    await api(`/api/collections/${id}/members/remove`, { method: 'POST', body: { ids } });
    return finish(`Removed ${plural(ids.length, 'title')} from the collection`);
  }
  if (act === 'watched' || act === 'unwatched') return finish(`${plural(await bulk(act), 'title')} marked as ${act}`);
  if (act === 'list') {
    return openMenu(anchor, [
      { label: '♡  Add to My List', onClick: async () => finish(`Added ${plural(await bulk('watchlist-add'), 'title')} to My List`) },
      { label: '♥  Remove from My List', onClick: async () => finish(`Removed ${plural(await bulk('watchlist-remove'), 'title')} from My List`) },
    ]);
  }
  if (act === 'more') {
    const genre = async (action, verb) => {
      const g = prompt(`Genre to ${verb} (e.g. Christmas, Family, Minecraft)`);
      if (g?.trim()) finish(`${action === 'genre-add' ? 'Added' : 'Removed'} “${g.trim()}” for ${plural(await bulk(action, { genre: g }), 'title')}`);
    };
    return openMenu(anchor, [
      { label: '🏷  Add a genre…', onClick: () => genre('genre-add', 'add to every selected title') },
      { label: '🏷  Remove a genre…', onClick: () => genre('genre-remove', 'remove from every selected title') },
      { label: '↻  Refresh metadata', onClick: async () => finish(`Refreshing metadata for ${plural(await bulk('refresh'), 'title')}… (this carries on in the background)`) },
    ]);
  }
}

async function collectionsAction(act, anchor) {
  const ids = [...selecting.ids];
  const patchAll = async (body, msg) => {
    for (const id of ids) await api(`/api/collections/${id}`, { method: 'PATCH', body });
    finish(msg);
  };
  if (act === 'section') {
    return openMenu(anchor, [
      ...Object.entries(SECTION_LABEL).map(([k, label]) => ({ label: `Show under ${label}`, onClick: () => patchAll({ section: k }, `Moved ${plural(ids.length, 'collection')} to ${label}`) })),
      { sep: true },
      { label: 'Decide from the titles in it', onClick: () => patchAll({ section: null }, 'Sections reset') },
    ]);
  }
  if (act === 'sort') {
    return openMenu(anchor, Object.entries(SORT_LABEL).filter(([k]) => k !== 'custom')
      .map(([k, label]) => ({ label, onClick: () => patchAll({ sort: k }, `${plural(ids.length, 'collection')} now ordered by ${label.toLowerCase()}`) })));
  }
  if (act === 'hide') {
    const cols = ids.map((id) => knownItems.get(id)).filter(Boolean);
    const own = cols.filter((c) => c.kind === 'manual'), auto = cols.filter((c) => c.kind === 'auto');
    const parts = [own.length && `delete ${plural(own.length, 'collection')} you made`, auto.length && `hide ${plural(auto.length, 'TMDB collection')}`].filter(Boolean);
    if (!confirm(`This will ${parts.join(' and ')}. The movies and shows in them are not affected. Continue?`)) return;
    for (const c of own) await api(`/api/collections/${c.id}`, { method: 'DELETE' });
    for (const c of auto) await api(`/api/collections/${c.id}`, { method: 'PATCH', body: { hidden: true } });
    finish('Done');
  }
}

// "Add to collection…" for many titles: pick an existing collection, or make a new one with them.
async function openBulkCollect(ids) {
  const all = await api('/api/collections?hidden=1');
  const sections = Object.keys(SECTION_LABEL).map((k) => [k, all.filter((c) => c.section === k)]).filter(([, l]) => l.length);
  const m = openModal({
    title: `Add ${plural(ids.length, 'title')} to a collection`,
    body: html`<div class="form">
      <div class="panel" style="margin:0">
        <b>New collection</b>
        <div class="row" style="margin-top:8px"><input class="input" id="bc-name" placeholder="e.g. Hardcore Survival series" style="flex:1;min-width:180px">
          <select id="bc-section" aria-label="Show under"><option value="">Section: decide from the titles</option>${Object.entries(SECTION_LABEL).map(([k, l]) => html`<option value="${k}">Show under ${l}</option>`)}</select>
          <select id="bc-sort" aria-label="Order">${Object.entries(SORT_LABEL).filter(([k]) => k !== 'custom').map(([k, l]) => html`<option value="${k}">Order: ${l}</option>`)}</select>
          <button class="btn primary" id="bc-create">Create</button></div>
      </div>
      ${all.length ? html`<input class="input" id="bc-filter" type="search" placeholder="Find a collection…">
        <div class="bc-list">${sections.map(([k, list]) => html`<h3>${SECTION_LABEL[k]}</h3>${list.map((c) => html`
          <div class="bc-row" data-name="${c.name.toLowerCase()}"><span>${c.name} <span class="muted">(${c.count}${c.kind === 'auto' ? ', from TMDB' : ''}${c.hidden ? ', hidden' : ''})</span></span>
            <button class="btn small" data-bc="${c.id}">Add here</button></div>`)}`)}</div>`
        : html`<p class="muted" style="margin:0">There are no collections yet — make the first one above.</p>`}
    </div>`.s,
    wide: true,
  });
  // A sensible starting guess for the new collection's order: episode numbers if the titles have them.
  const titles = ids.map((id) => knownItems.get(id)?.title || '');
  if (titles.filter((t) => /(?:^|[^a-z0-9])(?:ep|episode|part|pt|s\d+\s*e)\s*\.?\s*#?\d|#\d/i.test(t)).length * 2 >= titles.length) $('#bc-sort', m.el).value = 'episode';
  const done = (name) => { toast(`Added ${plural(ids.length, 'title')} to “${name}”`); m.close(); endSelect(); router(); };
  if ($('#bc-filter', m.el)) $('#bc-filter', m.el).oninput = (e) => {
    const t = e.target.value.trim().toLowerCase();
    for (const r of $$('.bc-row', m.el)) r.hidden = !!t && !r.dataset.name.includes(t);
  };
  m.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-bc]');
    if (!b) return;
    try { const c = await api(`/api/collections/${b.dataset.bc}/members`, { method: 'POST', body: { ids } }); done(c.name); } catch (err) { toast(err.message, true); }
  });
  $('#bc-create', m.el).onclick = async () => {
    const name = $('#bc-name', m.el).value.trim();
    if (!name) { $('#bc-name', m.el).focus(); return toast('Give the collection a name', true); }
    try {
      await api('/api/collections', { method: 'POST', body: { name, members: ids, sort: $('#bc-sort', m.el).value, section: $('#bc-section', m.el).value || null } });
      done(name);
    } catch (err) { toast(err.message, true); }
  };
  $('#bc-name', m.el).focus();
}
