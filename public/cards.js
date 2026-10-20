'use strict';
/* Marquee web client — cards and rows (posters, wide cards, shelves with arrows) and the hover
   previews on them. Helpers from app.js are used only when called. */

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
