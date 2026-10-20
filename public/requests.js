'use strict';
/* Marquee web client — requests ("can we get …?") and the bell (each person's notifications).
   Loaded before app.js; helpers from the other files are used only when called. */

// ---------- asking for something ----------
function openRequestDialog(initial = '', kind = 'movie') {
  const m = openModal({
    title: 'Ask for a film or show', wide: true,
    body: html`
      <form class="req-search">
        <div class="seg" role="group" aria-label="Film or show"><button type="button" data-kind="movie" class="${kind === 'movie' ? 'on' : ''}">Film</button><button type="button" data-kind="show" class="${kind === 'show' ? 'on' : ''}">Show</button></div>
        <input class="input" name="q" value="${initial}" placeholder="Title" autocomplete="off" required>
        <button class="btn primary">Search</button>
      </form>
      <div class="req-results"></div>
      <details class="req-manual"><summary>Not listed? Ask for it by name</summary>
        <form class="req-byname">
          <input class="input" name="title" placeholder="Title" required maxlength="200">
          <input class="input" name="year" placeholder="Year" inputmode="numeric" maxlength="4" style="width:90px">
          <button class="btn">Ask for it</button>
        </form></details>
      <label class="req-note">A note for whoever runs the server (optional)
        <input class="input" name="note" maxlength="500" placeholder="e.g. the 2019 one, or just season 1"></label>
      <div class="req-when-slot"></div>`,
  });
  const box = m.body;
  const results = $('.req-results', box);
  const form = $('.req-search', box);
  const note = () => $('.req-note input', box).value.trim();
  const currentKind = () => $('.req-search .seg .on', box).dataset.kind;
  let found = [];
  const search = async () => {
    const q = form.elements.q.value.trim();
    if (!q) return;
    results.innerHTML = '<div class="spinner small"></div>';
    try {
      const r = await api(`/api/requests/search?${new URLSearchParams({ kind: currentKind(), q })}`);
      found = r.results;
      $('.req-when-slot', box).innerHTML = r.canSend ? whenChoice().s : '';
      if (r.unavailable) {
        results.innerHTML = html`<div class="muted" style="padding:12px">Searching online isn't available (${r.unavailable}). Ask for it by name below.</div>`.s;
        $('.req-manual', box).open = true;
        $('.req-byname', box).elements.title.value = q;
        return;
      }
      results.innerHTML = found.length ? found.map((x, i) => html`
        <div class="match-row req-row">
          <span class="match-thumb">${x.thumb ? html`<img loading="lazy" src="${x.thumb}" alt="">` : ''}</span>
          <span class="match-info"><span class="match-line"><b>${x.title}</b> ${x.year ? html`<span class="muted">(${x.year})</span>` : ''}</span>
            <span class="match-overview">${x.overview || ''}</span></span>
          <span class="req-act">${x.inLibrary ? html`<a class="btn small" href="${x.inLibrary.link}">Already here</a>`
            : x.request ? html`<span class="chip">${REQUEST_STATUS[x.request.status] || 'Asked for'}</span><button class="btn small" data-req="${i}">Me too</button>`
              : html`<button class="btn small primary" data-req="${i}">Ask for it</button>`}</span>
        </div>`.s).join('') : '<div class="muted" style="padding:12px">Nothing found. Try a shorter title, or ask for it by name below.</div>';
    } catch (err) { results.innerHTML = html`<div class="error-box">${err.message}</div>`.s; }
  };
  const send = async (body) => {
    try {
      const r = await api('/api/requests', { method: 'POST', body: { ...body, note: note(), wait: waitChosen(box) } });
      toast(r.sent ? `${r.title} is on its way. You'll get a notification when it's here.` : `Asked for ${r.title}. You'll get a notification when it's here.`);
      m.close();
      if (parseHash().path === '/requests') router();
    } catch (err) { toast(err.message, true); }
  };
  box.addEventListener('click', (e) => {
    const k = e.target.closest('.req-search .seg button');
    if (k) { $$('.req-search .seg button', box).forEach((b) => b.classList.toggle('on', b === k)); if (form.elements.q.value.trim()) search(); return; }
    const b = e.target.closest('[data-req]');
    if (b) {
      const x = found[Number(b.dataset.req)];
      b.disabled = true;
      send({ kind: currentKind(), title: x.title, year: x.year, provider: x.provider, providerId: x.id, thumb: x.thumb, overview: x.overview });
    }
  });
  form.onsubmit = (e) => { e.preventDefault(); search(); };
  $('.req-byname', box).onsubmit = (e) => {
    e.preventDefault();
    const f = e.target.elements;
    send({ kind: currentKind(), title: f.title.value, year: f.year.value || null });
  };
  if (initial) search(); else form.elements.q.focus();
}

// For people allowed to skip approval: send it to Radarr / Sonarr straight away, or leave it with
// the requests for now (to look at later, or for an admin to decide). The last choice is kept.
function whenChoice() {
  const now = store.get('requestNow', true);
  return html`<div class="req-when"><span class="muted">When I ask</span>
    <div class="seg" role="group" aria-label="When I ask"><button type="button" data-when="now" class="${now ? 'on' : ''}">Download now</button><button type="button" data-when="wait" class="${now ? '' : 'on'}">Add to requests</button></div></div>`;
}
const waitChosen = (root) => !!$('.req-when [data-when="wait"].on', root);
document.addEventListener('click', (e) => {
  const b = e.target.closest('.req-when [data-when]');
  if (!b) return;
  $$('[data-when]', b.parentElement).forEach((x) => x.classList.toggle('on', x === b));
  store.set('requestNow', b.dataset.when === 'now');
});

// ---------- more seasons of a show that's here ----------
async function openMoreSeasons(show) {
  let d;
  try { d = await api(`/api/shows/${show.id}/seasons`); } catch (err) { toast(err.message, true); return; }
  const full = (x) => x.episodes != null && x.episodes > 0 && x.here >= x.episodes;
  const m = openModal({
    title: `More of ${show.title}`,
    body: html`${d.seasons.length ? html`<div class="form ms-list">${d.seasons.map((x) => html`<label class="check ms-row ${full(x) || x.asked ? 'done' : ''}">
        <input type="checkbox" value="${x.season}" ${full(x) || x.asked ? 'disabled' : ''}>
        <span><b>${x.name}</b> <span class="muted">${x.episodes ? `${x.episodes} episodes` : ''}${x.airDate ? ` · ${x.airDate.slice(0, 4)}` : ''}</span></span>
        <span class="ms-state">${full(x) ? '✓ Here' : x.asked ? 'Asked for' : x.here ? `${x.here} of ${x.episodes ?? '?'} here` : ''}</span></label>`)}</div>`
      : html`<p class="muted">No season list for this show (it isn't matched online). Ask for it by name with a note instead.</p>`}
      <label class="req-note">A note (optional) <input class="input" id="ms-note" maxlength="500"></label>
      ${d.canSend ? whenChoice() : ''}`.s,
    footer: html`<button class="btn" data-close>Cancel</button><button class="btn primary" id="ms-go" ${d.seasons.length ? '' : 'disabled'}>Ask for these seasons</button>`.s,
  });
  $$('[data-close]', m.el).forEach((b) => { b.onclick = m.close; });
  $('#ms-go', m.el).onclick = async (e) => {
    const seasons = $$('.ms-row input:checked', m.el).map((x) => Number(x.value));
    if (!seasons.length) return toast('Tick the seasons you’d like', true);
    e.target.disabled = true;
    try {
      const r = await api('/api/requests', { method: 'POST', body: { showId: show.id, seasons, note: $('#ms-note', m.el).value.trim(), wait: waitChosen(m.el) } });
      toast(r.sent ? `On its way. You'll get a notification when it's here.` : `Asked for. You'll get a notification when it's here.`);
      m.close();
    } catch (err) { toast(err.message, true); e.target.disabled = false; }
  };
}

const REQUEST_STATUS = { pending: 'Waiting', approved: 'On its way', declined: 'Declined', available: 'Here' };

// ---------- the list (#/requests): everyone's for admins, your own for everyone else ----------
const ARR_NAME = { radarr: 'Radarr', sonarr: 'Sonarr' };
// How a request sent to Radarr / Sonarr is getting on ("Downloading · 45% · 20 min left").
function arrLine(r, admin) {
  if (r.arr?.error) {
    return admin ? html`<div class="req-arr bad">Couldn’t send it to ${ARR_NAME[r.arr.app]}: ${r.arr.error} <button class="btn small" data-retry>Try again</button></div>` : '';
  }
  if (!r.arr || r.status === 'available' || r.status === 'declined') return '';
  const p = r.progress;
  // Not found after a while (Settings → Radarr & Sonarr → Limits): look again, or at another quality.
  const stuck = admin && r.arr.stuckAt ? html`<div class="req-arr bad">Not found in ${Math.round((r.arr.stuckAt - r.arr.sentAt) / 86400_000)} days.
    <button class="btn small" data-again>Look again</button> <button class="btn small" data-other>Try another quality…</button></div>` : '';
  const sent = admin ? html`<span class="muted">${r.arr.existing ? 'Already in' : 'Sent to'} ${ARR_NAME[r.arr.app]}${r.arr.profile ? ` · ${r.arr.profile}` : ''}${r.arr.auto ? ' · automatically' : ''}</span>` : '';
  return html`<div class="req-arr ${p?.state || ''}">
    ${p?.label ? html`<span class="req-arr-state">${p.label}</span>` : ''}${p?.label && sent ? ' · ' : ''}${sent}
    ${p?.percent != null && p.state !== 'downloaded' ? html`<div class="bar"><i style="width:${p.percent}%"></i></div>` : ''}</div>${stuck}`;
}

// "Try another quality…" for something that hasn't been found.
async function otherQualityDialog(r) {
  let o;
  try { o = await api(`/api/arr/${r.arr.app}/options`); } catch (err) { toast(err.message, true); return; }
  const res = (x) => (!x ? 'any size' : x >= 2160 ? 'up to 4K' : `up to ${x}p`);
  const m = openModal({
    title: `Another quality for ${r.title}`,
    body: html`<form class="form" id="oq-form"><label>Quality <select name="profileId">${o.profiles.map((p) => html`<option value="${p.id}" ${p.name === r.arr.profile ? 'selected' : ''}>${p.name} · ${res(p.maxRes)}</option>`)}</select></label>
      <p class="muted" style="margin:0;font-size:13px">${ARR_NAME[r.arr.app]} switches it to this profile and looks again.</p></form>`.s,
    footer: html`<button class="btn" data-close>Cancel</button><button class="btn primary" id="oq-go">Switch and look again</button>`.s,
  });
  $$('[data-close]', m.el).forEach((b) => { b.onclick = m.close; });
  $('#oq-go', m.el).onclick = async (e) => {
    e.target.disabled = true;
    try { await api(`/api/requests/${r.id}/search-again`, { method: 'POST', body: { profileId: Number($('#oq-form', m.el).elements.profileId.value) } }); toast('Looking again'); m.close(); router(); } catch (err) { toast(err.message, true); e.target.disabled = false; }
  };
}

// Approving with Radarr / Sonarr set up: which quality profile (and for a show, which seasons).
async function approveDialog(r) {
  const app = r.kind === 'show' ? 'sonarr' : 'radarr';
  let o;
  try { o = await api(`/api/arr/${app}/options`); } catch (err) { toast(err.message, true); return; }
  const res = (x) => (!x ? 'any size' : x >= 2160 ? 'up to 4K' : `up to ${x}p`);
  const m = openModal({
    title: `Approve ${r.title}`,
    body: html`<form class="form" id="ap-form">
      <label>Quality <select name="profileId">${o.profiles.map((p) => html`<option value="${p.id}" ${p.id === o.defaults.profileId ? 'selected' : ''}>${p.name} · ${res(p.maxRes)}</option>`)}</select></label>
      ${r.seasons ? html`<p style="margin:0">Seasons: <b>${r.seasons.join(', ')}</b> <span class="muted">(${r.title} is here already; Sonarr gets these seasons)</span></p>` : ''}
      ${app === 'sonarr' && !r.seasons ? html`<label>Seasons <select name="monitor">${Object.entries(o.monitorOptions).map(([k, l]) => html`<option value="${k}" ${k === o.defaults.monitor ? 'selected' : ''}>${l}</option>`)}</select></label>` : ''}
      ${r.note ? html`<p class="muted" style="margin:0">They said: “${r.note}”</p>` : ''}
      ${(() => { const f = o.rootFolders.find((x) => x.path === o.defaults.rootFolder); return f?.freeSpace != null ? html`<p class="muted" style="margin:0;font-size:13px">${fmtSize(f.freeSpace)} free in <code>${f.path}</code></p>` : ''; })()}
      <p class="muted" style="margin:0;font-size:13px">It's added to ${ARR_NAME[app]}, which looks for it and downloads it. Whoever asked is told it's on its way, and again when it's here.</p>
    </form>`.s,
    footer: html`<button class="btn" id="ap-only" style="margin-right:auto" title="Mark it approved without sending it to ${ARR_NAME[app]} (you'll get it some other way)">Approve only</button>
      <button class="btn" data-close>Cancel</button><button class="btn primary" id="ap-send">Approve &amp; send to ${ARR_NAME[app]}</button>`.s,
  });
  $$('[data-close]', m.el).forEach((b) => { b.onclick = m.close; });
  const go = async (body, btn) => {
    btn.disabled = true;
    try { await api(`/api/requests/${r.id}`, { method: 'PATCH', body: { status: 'approved', ...body } }); m.close(); router(); } catch (err) { toast(err.message, true); btn.disabled = false; }
  };
  $('#ap-send', m.el).onclick = (e) => {
    const f = $('#ap-form', m.el).elements;
    go({ profileId: Number(f.profileId.value), monitor: f.monitor?.value }, e.target).then(() => toast(`Sent to ${ARR_NAME[app]}`));
  };
  $('#ap-only', m.el).onclick = (e) => go({ send: false }, e.target);
}

async function viewRequests({ seq }) {
  const { requests, arr } = await api('/api/requests');
  const admin = state.user.role === 'admin';
  const row = (r) => html`
    <div class="panel req-item ${r.status}" data-rid="${r.id}">
      <span class="match-thumb">${r.thumb ? html`<img loading="lazy" src="${r.thumb}" alt="">` : html`<span class="req-noimg">${r.kind === 'show' ? '📺' : '🎬'}</span>`}</span>
      <div class="req-main">
        <div class="req-title"><b>${r.title}</b> ${r.seasons ? html`<span class="muted">· more seasons: ${r.seasons.join(', ')}</span>` : r.year ? html`<span class="muted">(${r.year})</span>` : ''}
          <span class="chip">${r.kind === 'show' ? 'Show' : 'Film'}</span> <span class="chip req-status ${r.status}">${REQUEST_STATUS[r.status]}</span></div>
        <div class="muted req-meta">${admin ? html`Asked for by <b>${r.requestedBy}</b>${r.alsoWanted?.length ? html` (and ${r.alsoWanted.join(', ')})` : ''} · ` : ''}${fmtDate(r.createdAt)}</div>
        ${r.note ? html`<div class="req-note-text">“${r.note}”</div>` : ''}
        ${r.adminNote ? html`<div class="req-note-text admin">${admin ? 'Your note' : 'From the server'}: ${r.adminNote}</div>` : ''}
        ${r.overview && !r.note ? html`<div class="muted req-overview">${r.overview}</div>` : ''}
        ${r.held && r.status === 'pending' ? html`<div class="req-arr notReleased"><span class="req-arr-state">${admin ? `Waiting for you: ${r.held}` : 'Waiting for approval'}</span></div>` : ''}
        ${r.firstHere && r.status === 'approved' ? html`<div class="req-arr downloading"><span class="req-arr-state">The first episodes are here; more on the way</span></div>` : ''}
        ${arrLine(r, admin)}
      </div>
      <div class="req-actions">
        ${(r.status === 'available' || r.firstHere) && r.availableId ? html`<a class="btn small primary" href="#/${r.kind === 'show' ? 'show' : 'item'}/${r.availableId}">Watch</a>` : ''}
        ${admin ? html`
          ${r.status !== 'approved' && r.status !== 'available' ? html`<button class="btn small" data-set="approved">Approve</button>` : ''}
          ${r.status !== 'available' ? html`<button class="btn small" data-set="available" title="It's been added (Marquee also notices by itself)">Added</button>` : ''}
          ${r.status !== 'declined' ? html`<button class="btn small" data-set="declined">Decline</button>` : ''}
          <button class="btn small" data-note>Note</button>
          <button class="btn small danger" data-remove>Remove</button>`
        : r.status === 'pending' || r.status === 'approved' ? html`<button class="btn small" data-remove>${r.requestedBy === state.user.username && r.status === 'pending' ? 'Withdraw' : 'Stop following'}</button>` : ''}
      </div>
    </div>`;
  const open = requests.filter((r) => r.status === 'pending' || r.status === 'approved');
  const done = requests.filter((r) => r.status !== 'pending' && r.status !== 'approved');
  if (!setView(seq, html`
    <div class="toolbar"><h1>Requests</h1><button class="btn primary" id="new-request">＋ Ask for something</button></div>
    <p class="muted" style="margin-top:-6px">${admin ? 'What people have asked to be added. When a title turns up in a library it’s marked as here and they get a notification.'
      : 'What you’ve asked to be added. You’ll get a notification when it’s here.'}</p>
    ${requests.length ? '' : html`<div class="panel muted">Nothing asked for yet.</div>`}
    ${open.length ? html`<h2 class="req-h">Open (${open.length})</h2>${open.map(row)}` : ''}
    ${done.length ? html`<h2 class="req-h">Done</h2>${done.map(row)}` : ''}`)) return;
  $('#new-request').onclick = () => openRequestDialog();
  // While something is downloading, the page keeps itself up to date.
  if (requests.some((r) => ['downloading', 'importing', 'searching', 'downloaded'].includes(r.progress?.state))) {
    setTimeout(() => { if (seq === renderSeq && parseHash().path === '/requests' && !document.querySelector('.modal-backdrop')) router(); }, 20_000);
  }
  view.onclick = async (e) => {
    const item = e.target.closest('[data-rid]');
    if (!item) return;
    const id = item.dataset.rid;
    const r = requests.find((x) => x.id === id);
    try {
      if (e.target.closest('[data-again]')) {
        e.target.disabled = true;
        await api(`/api/requests/${id}/search-again`, { method: 'POST', body: {} });
        toast('Looking again');
        router();
      } else if (e.target.closest('[data-other]')) {
        otherQualityDialog(r);
      } else if (e.target.closest('[data-retry]')) {
        e.target.disabled = true;
        await api(`/api/requests/${id}/send`, { method: 'POST', body: {} });
        toast(`Sent to ${ARR_NAME[r.kind === 'show' ? 'sonarr' : 'radarr']}`);
        router();
      } else if (e.target.closest('[data-set="approved"]') && arr?.[r.kind]) {
        approveDialog(r);
      } else if (e.target.closest('[data-set]')) {
        await api(`/api/requests/${id}`, { method: 'PATCH', body: { status: e.target.closest('[data-set]').dataset.set } });
        router();
      } else if (e.target.closest('[data-note]')) {
        const text = prompt(`A note for ${r.requestedBy} (they'll see it)`, r.adminNote || '');
        if (text !== null) { await api(`/api/requests/${id}`, { method: 'PATCH', body: { adminNote: text } }); router(); }
      } else if (e.target.closest('[data-remove]')) {
        if (admin && !confirm(`Remove the request for ${r.title}?`)) return;
        await api(`/api/requests/${id}`, { method: 'DELETE' });
        router();
      }
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- the bell ----------
const NOTE_ICON = { episode: '📺', request: '🙋', health: '⚠️' };
function renderBell(data) {
  const root = $('#bell');
  if (!root) return;
  const n = data?.unread || 0;
  root.hidden = !state.user;
  $('#bell-count').textContent = n > 9 ? '9+' : String(n);
  $('#bell-count').hidden = !n;
  $('#bell-btn').setAttribute('aria-label', n ? `Notifications: ${n} new` : 'Notifications');
  state.notifications = data;
}

async function refreshBell() {
  if (!state.user) return;
  try { renderBell(await api('/api/notifications')); } catch { /* offline */ }
}

function openBell() {
  const pop = $('#bell-pop');
  if (!pop.hidden) { pop.hidden = true; return; }
  const items = state.notifications?.items || [];
  pop.innerHTML = html`
    <div class="bell-head"><b>Notifications</b>${items.length ? html`<button class="btn small" id="bell-clear">Clear</button>` : ''}</div>
    ${items.length ? items.slice(0, 30).map((x) => html`
      <a class="bell-item ${x.read ? '' : 'unread'}" href="${x.link || '#/'}" data-nid="${x.id}">
        <span class="bell-icon">${NOTE_ICON[x.kind] || '🔔'}</span>
        <span><span class="bell-title">${x.title}</span>${x.body ? html`<span class="bell-body">${x.body}</span>` : ''}<span class="bell-when">${fmtDate(x.at)}</span></span>
      </a>`) : html`<div class="muted" style="padding:14px">Nothing new. New episodes of shows you watch, and things you've asked for, show up here.</div>`}
    <a class="bell-foot" href="#/requests">Requests</a>`.s;
  pop.hidden = false;
  // Opening the bell counts as having seen them.
  if (state.notifications?.unread) api('/api/notifications/read', { method: 'POST', body: {} }).then(renderBell).catch(() => {});
  $('#bell-clear', pop)?.addEventListener('click', async (e) => {
    e.preventDefault();
    await api('/api/notifications', { method: 'DELETE' }).catch(() => {});
    renderBell({ items: [], unread: 0 });
    pop.hidden = true;
  });
}

document.addEventListener('click', (e) => {
  if (e.target.closest('#bell-btn')) { e.stopPropagation(); openBell(); return; }
  const pop = $('#bell-pop');
  if (pop && !pop.hidden && (!e.target.closest('#bell-pop') || e.target.closest('a'))) pop.hidden = true;
});
