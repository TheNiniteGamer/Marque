'use strict';
/* Marquee web client — collections and franchises: the hub, a collection's page, saga heroes and
   editing collections. Helpers from app.js are used only when called. */

// ---------- collections ----------
// "Group into collections": titles that belong to a collection are shown as that collection's card
// (in the first collection they're in). Each group keeps what the library view sorts and filters by.
// Franchises are too big for that (a library would be one MCU card): their film series group instead.
function groupByCollection(items, cols) {
  const owner = new Map();
  for (const c of cols) if (!c.hidden && c.section !== 'franchises') for (const id of c.memberIds || []) if (!owner.has(id)) owner.set(id, c);
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
  const what = c.section === 'franchises' ? (c.studio ? 'Studio' : 'Franchise') : 'Collection';
  const sub = c.hidden ? 'Hidden' : `${what} · ${c.count} title${c.count === 1 ? '' : 's'}`;
  return html`<div class="card ${c.hidden ? 'is-hidden' : ''} ${c.section === 'franchises' ? 'franchise-card' : ''}" data-sel="${c.id}">
    <div class="art"><a class="cover" href="#/collection/${c.id}" aria-label="${c.name}">
      ${c.cover ? html`<img loading="lazy" src="${artUrl('backdrop', c.cover)}" alt="">` : html`<div class="collection-empty">▦</div>`}</a>
      <i class="scrim"></i><span class="art-title">${c.name}</span>
      <span class="badge" title="Titles in this collection">${c.count}</span></div>
    <a class="card-text" href="#/collection/${c.id}" tabindex="-1"><span class="sub">${sub}</span></a>
  </div>`;
}

// Collections are listed in sections: Franchises, Movies, TV and YouTube (each collection's section is
// worked out from its titles, or picked by an admin).
const SECTION_HEAD = { franchises: 'Franchises', movies: 'Movie collections', shows: 'TV collections', videos: 'YouTube collections' };
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
      <p>Film series like “The Matrix Collection”, and franchises like the Marvel Cinematic Universe or Pixar, appear here automatically once two of their titles are matched with TMDB.${admin ? ' You can also make your own with ＋ New collection, by selecting titles in a library (☑ Select), or with ⌕ Find series for YouTube series.' : ''}</p></div>`}</div>`)) return;
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
      items: mine.map((c) => ({ id: c.id, title: c.name, sub: c.kind === 'auto' ? 'From TMDB' : c.kind === 'franchise' ? `${c.studio ? 'Studio' : 'Franchise'} · ${c.count} titles` : `${c.count} titles`, img: c.cover ? artUrl('poster', c.cover) : null })),
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

// The banner at the top of a franchise: its cover's artwork, what it is, how much of it you've seen,
// and a button to carry on with it (in the order shown, which an admin can make the story order).
function sagaHero(c) {
  const films = c.items.filter((x) => x.type !== 'show').length, series = c.items.length - films;
  const years = c.items.map((x) => x.year).filter(Boolean);
  const span = years.length ? (Math.min(...years) === Math.max(...years) ? Math.min(...years) : `${Math.min(...years)}–${Math.max(...years)}`) : '';
  const n = c.next;
  const label = !n ? '' : n.started ? `Continue ${n.title}` : n.first && !c.watched ? `Start with ${n.title}` : `Up next: ${n.title}`;
  return html`<section class="saga-hero">
    <div class="saga-art">${c.cover ? html`<img src="${artUrl('backdrop', c.cover)}" alt="">` : ''}</div>
    <div class="saga-body">
      <span class="hero-kind">${c.studio ? 'STUDIO' : 'FRANCHISE'}</span>
      <h1 class="saga-title">${c.name}</h1>
      <div class="hero-meta">${[films && `${films} film${films === 1 ? '' : 's'}`, series && `${series} series`, span].filter(Boolean).join(' · ')}</div>
      ${c.about ? html`<p class="saga-about">${c.about}</p>` : ''}
      ${c.items.length ? html`<div class="saga-progress"><div class="bar"><i style="width:${((100 * c.watched) / c.items.length).toFixed(1)}%"></i></div>
        <span>${c.watched === c.items.length ? `You’ve seen all ${c.items.length} ✓` : c.watched ? `You’ve seen ${c.watched} of ${c.items.length}` : `${c.items.length} titles to watch`}</span></div>` : ''}
      ${n ? html`<div class="hero-actions"><button class="btn play" data-play="${n.type === 'show' ? `show:${n.id}` : n.id}" ${!n.started && n.type !== 'show' ? raw('data-t="0"') : ''}>${icon('play')}${label}</button>
        <a class="btn" href="${n.type === 'show' ? `#/show/${n.id}` : `#/item/${n.id}`}">More info</a></div>` : ''}
    </div>
  </section>`;
}

async function viewCollection({ params: [id], seq }) {
  const c = await api(`/api/collections/${id}`);
  const admin = state.user.role === 'admin';
  const auto = c.kind !== 'manual';
  const saga = c.section === 'franchises';
  const renamed = c.tmdbName && c.tmdbName !== c.name ? ` (“${c.tmdbName}”)` : '';
  const source = c.kind === 'auto' ? `From TMDB${renamed}` : c.kind === 'franchise' ? `${c.studio ? 'Studio' : 'Franchise'} found from TMDB’s details${renamed}` : 'Collection';
  const sorts = saga ? { ...SORT_LABEL, custom: 'Story order (arranged by hand)' } : SORT_LABEL;
  // Franchises: rows by film series ("Iron Man", "The Avengers"…) or every title in one grid.
  const rows = saga && c.parts?.length && store.get('sagaView', 'rows') === 'rows';
  const byId = new Map(c.items.map((x) => [x.id, x]));
  const ctx = admin ? `collection:${c.id}` : '';
  if (!setView(seq, html`
    ${saga ? sagaHero(c) : ''}
    <div class="toolbar">${saga ? '' : html`<h1>${c.name}<span class="count">${c.count}</span></h1>`}
      <span class="muted">${source}${c.changed ? ' · changed by an admin' : ''}${saga ? '' : ` · ${SECTION_LABEL[c.section]}`}</span>
      ${saga && c.parts?.length ? html`<div class="seg" id="saga-view"><button data-v="rows" class="${rows ? 'on' : ''}">☰ By series</button><button data-v="all" class="${rows ? '' : 'on'}">▦ All titles</button></div>` : ''}
      ${admin && c.items.length ? selectButton() : ''}
      ${admin ? html`<button class="btn small" id="col-rename">Rename</button>` : ''}
      ${admin && auto && c.changed ? html`<button class="btn small" id="col-reset" title="Undo every change made to this collection">${c.kind === 'franchise' ? 'Reset' : 'Reset to TMDB'}</button>` : ''}
      ${admin ? html`<button class="btn small danger" id="col-delete">${auto ? (c.hidden ? 'Show again' : 'Hide') : 'Delete'}</button>` : ''}</div>
    ${c.hidden ? html`<div class="filter-note">This collection is hidden from everyone. Use “Show again” to bring it back.</div>` : ''}
    ${admin ? html`<div class="row col-options">
      <label>Order <select id="col-sort">${Object.entries(sorts).map(([k, l]) => html`<option value="${k}" ${c.sort === k ? 'selected' : ''}>${l}</option>`)}</select></label>
      ${c.sort !== 'custom' ? html`<button class="btn small ${c.reverse ? 'on' : ''}" id="col-reverse" aria-pressed="${c.reverse ? 'true' : 'false'}" title="Show the order the other way round (last first)">⇵ ${c.reverse ? 'Reversed' : 'Reverse'}</button>` : ''}
      ${c.items.length > 1 ? html`<button class="btn small" id="col-reorder" title="${saga ? 'Drag the titles into the order the story happens in' : 'Drag the titles into any order'}">✋ ${saga ? 'Arrange story order' : 'Arrange by hand'}</button>` : ''}
      <label>Show under <select id="col-section"><option value="" ${c.sectionSetByHand ? '' : 'selected'}>Automatic</option>
        ${Object.entries(SECTION_LABEL).map(([k, l]) => html`<option value="${k}" ${c.sectionSetByHand && c.section === k ? 'selected' : ''}>${l}</option>`)}</select></label>
      ${c.sort === 'episode' ? html`<span class="muted" style="font-size:13px">Uses numbers in the titles: “Ep 12”, “Episode 12”, “S2E5”, “Part 3”, “#12”, or a number at the end.</span>` : ''}
    </div>` : ''}
    <div id="col-body">${!c.items.length ? html`<div class="empty"><p>This collection is empty. Use “Add to collection…” in the ⋯ menu of a movie or show.</p></div>`
      : rows ? c.parts.map((p) => html`<section class="hub"><div class="hub-head"><h2>${p.name}</h2><span class="hub-note">${p.ids.length}</span></div>
          ${rail(p.ids.map((i) => byId.get(i)).filter(Boolean), (x) => posterCard(x, ctx))}</section>`)
      : html`<div class="grid">${c.items.map((x) => posterCard(x, ctx))}</div>`}</div>
    ${admin ? html`<p class="muted" style="font-size:13px">Tip: ☑ Select removes several titles at once; each title's ⋯ menu can also make its poster the collection's cover.${saga ? ' Franchises are worked out from TMDB’s keywords and studios; add anything it missed with “Add to collection…”.' : ''}</p>` : ''}`)) return;
  view.classList.toggle('has-hero', saga); // (the banner goes under the top bar, as on the home page)
  updateRails();
  if ($('#saga-view')) $('#saga-view').onclick = (e) => { const v = e.target.closest('[data-v]')?.dataset.v; if (v) { store.set('sagaView', v); router(); } };
  if (!admin) return;
  const patch = async (body, msg) => { try { await api(`/api/collections/${id}`, { method: 'PATCH', body }); toast(msg); router(); } catch (err) { toast(err.message, true); } };
  bindSelect({ root: () => $('#col-body'), kind: 'titles', collectionId: id });
  $('#col-sort').onchange = (e) => patch({ sort: e.target.value }, `Ordered by ${sorts[e.target.value].toLowerCase()}`);
  if ($('#col-reverse')) $('#col-reverse').onclick = () => patch({ reverse: !c.reverse }, 'Order reversed');
  $('#col-section').onchange = (e) => patch({ section: e.target.value || null }, e.target.value ? `Shown under ${SECTION_LABEL[e.target.value]}` : 'Section decided from the titles');
  if ($('#col-reorder')) $('#col-reorder').onclick = () => reorderList($('#col-body'), {
    items: c.items.map((x) => ({ id: x.id, title: x.title, sub: x.year || '', img: artUrl('poster', x) })),
    note: saga ? 'Drag titles into the order the story happens in (or any order you like). Everyone sees this order, and “Continue” follows it; titles added later go at the end.'
      : 'Drag titles into the order you want, or use the arrows. Everyone sees this order; titles added later go at the end.',
    save: (order) => api(`/api/collections/${id}/order`, { method: 'PUT', body: { order } }),
    reset: c.customOrder ? () => api(`/api/collections/${id}/order`, { method: 'PUT', body: { order: null } }) : null,
    resetLabel: 'Stop arranging by hand (back to release date)',
  });
  $('#col-rename').onclick = () => {
    const name = prompt(auto ? `New name (leave empty to go back to “${c.tmdbName}”)` : 'New name', c.name);
    if (name === null || name === c.name) return;
    patch({ name }, 'Renamed');
  };
  if ($('#col-reset')) $('#col-reset').onclick = async () => {
    if (!confirm('Undo every change to this collection (name, titles, order, cover, hidden) and go back to the automatic version?')) return;
    try { await api(`/api/collections/${id}/reset`, { method: 'POST' }); toast('Back to the automatic version'); router(); } catch (err) { toast(err.message, true); }
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
          <span class="muted">(${c.count}${colSource(c)}${c.hidden ? ', hidden' : ''})</span></label>`)
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
