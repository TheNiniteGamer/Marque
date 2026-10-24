'use strict';
/* Marquee web client — the "More info" pop-up for movies, shows, episodes and extras. Helpers from
   app.js are used only when called. */

// ---------- "More info" pop-up: movies, shows, episodes and extras ----------
// Buttons shared by the pop-ups: My List and the ⋯ menu (edit, fix match, collections… for admins).
function listButton(x) {
  if (x.type === 'episode' || x.type === 'extra') return '';
  return html`<button class="round" id="list-toggle" aria-label="${x.inWatchlist ? 'Remove from My List' : 'Add to My List'}" title="${x.inWatchlist ? 'Remove from My List' : 'Add to My List'}">${icon(x.inWatchlist ? 'check' : 'plus')}</button>
    <button class="round thumb ${x.thumb === 1 ? 'on' : ''}" data-thumb="1" aria-pressed="${x.thumb === 1}" aria-label="I like this" title="I like this">${icon('up')}</button>
    <button class="round thumb ${x.thumb === -1 ? 'on' : ''}" data-thumb="-1" aria-pressed="${x.thumb === -1}" aria-label="Not for me" title="Not for me (keeps it out of suggestions)">${icon('down')}</button>`;
}
function dlgTop(x) {
  knownItems.set(x.id, x);
  const prev = detailTrail.at(-1);
  return html`${prev ? html`<button class="dlg-back" id="dlg-back" title="Back to ${prev.title}" aria-label="Back to ${prev.title}">${icon('left')}<span>${prev.title}</span></button>` : ''}
  <div class="dlg-top">
    <button class="round solid" data-menu="${x.id}" aria-label="More options" title="More options">${icon('dots')}</button>
    <button class="round solid" id="dlg-close" aria-label="Close" title="Close">${icon('close')}</button>
  </div>`;
}
function bindDetailActions(x) {
  if ($('#list-toggle')) $('#list-toggle').onclick = () => toggleWatchlist(x).catch((err) => toast(err.message, true));
  // Thumbs up / down: pressing the lit one again clears it.
  for (const b of $$('[data-thumb]', viewEl)) {
    b.onclick = async () => {
      const want = Number(b.dataset.thumb) === x.thumb ? 0 : Number(b.dataset.thumb);
      try {
        x.thumb = (await api(`/api/thumbs/${x.id}`, { method: 'PUT', body: { value: want } })).thumb;
        for (const o of $$('[data-thumb]', viewEl)) { const on = Number(o.dataset.thumb) === x.thumb; o.classList.toggle('on', on); o.setAttribute('aria-pressed', String(on)); }
        toast(x.thumb === 1 ? 'Thanks — more like this' : x.thumb === -1 ? "Got it — we won't suggest this" : 'Rating removed');
      } catch (err) { toast(err.message, true); }
    };
  }
  $('#dlg-close').onclick = closeDetail;
  if ($('#dlg-back')) $('#dlg-back').onclick = detailBack;
}
// Genres, cast, collections and library, on the right of the pop-up.
function sideInfo(x) {
  const lib = state.libraries.find((l) => l.id === x.libraryId);
  const list = (items) => items.map((v, i) => [v, i < items.length - 1 ? ', ' : '']);
  return html`<div class="dlg-side">
    ${x.cast?.length ? html`<div>Cast: <span class="v">${x.cast.slice(0, 5).map((c) => c.name).join(', ')}</span></div>` : ''}
    ${x.genres?.length ? html`<div>Genres: ${list(x.genres.map((g) => html`<a href="#/library/${x.libraryId}?genre=${encodeURIComponent(g)}">${g}</a>`))}</div>` : ''}
    ${x.collections?.some((c) => c.franchise) ? html`<div>Part of: ${list(x.collections.filter((c) => c.franchise).map((c) => html`<a href="#/collection/${c.id}">${c.name}</a>`))}</div>` : ''}
    ${x.collections?.some((c) => !c.franchise) ? html`<div>Collections: ${list(x.collections.filter((c) => !c.franchise).map((c) => html`<a href="#/collection/${c.id}">${c.name}</a>`))}</div>` : ''}
    ${lib ? html`<div>Library: <a href="#/library/${lib.id}">${lib.name}</a></div>` : ''}
    ${x.match?.provider === 'tvdb' ? html`<div class="muted">Show information from <a href="https://thetvdb.com/dereferrer/series/${x.match.providerId}" target="_blank" rel="noopener">TheTVDB</a></div>` : ''}
  </div>`;
}
function matchNote(x) {
  if (state.user.role !== 'admin' || !x.match) return '';
  const id = x.type === 'episode' ? x.showId : x.id;
  if (x.match.notFound) return html`<p class="match-note">No online match was found. <button class="link-btn" data-fix-match="${id}">Find a match…</button></p>`;
  if (x.match.uncertain) {
    return html`<p class="match-note">Marquee isn't sure this is the right ${x.type === 'movie' ? 'movie' : 'show'}.
      <button class="link-btn" data-review-ok="${id}">✓ It's right</button> · <button class="link-btn" data-fix-match="${id}">Find another…</button></p>`;
  }
  return '';
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-fix-match]');
  if (b) openMatcher(b.dataset.fixMatch).catch((err) => toast(err.message, true));
});
function progressLine(x, label) {
  const p = x.progress;
  if (!p?.position || p.watched || !x.duration) return '';
  return html`<div class="dlg-progress"><div class="bar"><i style="width:${pct(p.position, x.duration).toFixed(1)}%"></i></div><span>${label ? `${label} — ` : ''}${fmtLeft(x)}</span></div>`;
}

// Trailers, featurettes and other extras.
function extrasSection(list) {
  if (!list?.length) return '';
  return html`<section class="dlg-section"><h2 style="margin-bottom:14px">Trailers &amp; extras</h2><div class="similar-grid">${list.map((x) => {
    knownItems.set(x.id, x);
    const sub = [x.title !== x.extraLabel ? x.extraLabel : '', fmtDuration(x.duration)].filter(Boolean).join(' · ');
    return html`<a class="similar-card" href="#/item/${x.id}" data-play="${x.id}" data-t="0">
      <div class="art"><img loading="lazy" src="${artUrl('thumb', x)}" alt=""><span class="art-title">${x.title}</span></div>
      <div class="txt"><span class="m">${sub}</span></div></a>`;
  })}</div></section>`;
}
// The cast, with photos: each opens the person's page (the titles in your library they're in).
function personCard(c) {
  return html`<a class="person-card" href="#/person/${encodeURIComponent(c.name)}">
    <span class="person-photo" style="background:${avatarColor(c.name)}">${c.photo ? html`<img loading="lazy" src="${c.photo}" alt="" data-hide-broken>` : ''}<b>${c.name.slice(0, 1)}</b></span>
    <span class="person-name">${c.name}</span>${c.character ? html`<span class="person-role">${c.character}</span>` : ''}</a>`;
}
function castSection(cast) {
  if (!cast?.length) return '';
  return html`<section class="dlg-section"><h2 style="margin-bottom:14px">Cast</h2><div class="cast-row">${cast.slice(0, 12).map(personCard)}</div></section>`;
}

async function viewPerson({ params: [name], seq }) {
  const p = await api(`/api/people/${name}`);
  document.title = `${p.name} · Marquee`;
  for (const t of p.titles) knownItems.set(t.id, t);
  setView(seq, html`${pageBack('#/', 'Home')}<div class="person-head">
      <span class="person-photo big" style="background:${avatarColor(p.name)}">${p.photo ? html`<img src="${p.photo}" alt="" data-hide-broken>` : ''}<b>${p.name.slice(0, 1)}</b></span>
      <div><h1>${p.name}</h1><p class="muted">${p.titles.length} title${p.titles.length === 1 ? '' : 's'} in your library</p></div></div>
    <div class="grid sized">${p.titles.map((t) => posterCard(t))}</div>`);
}

// The franchise a title is part of ("◆ Marvel Cinematic Universe"), above its name.
function sagaChip(x) {
  return x.franchise ? html`<a class="saga-chip" href="#/collection/${x.franchise.id}">◆ ${x.franchise.name}</a>` : '';
}
// "More from the Marvel Cinematic Universe": the franchise's other titles, in its order.
function franchiseSection(f) {
  if (!f?.items.length) return '';
  return similarSection(f.items.slice(0, 9), html`More from ${f.name} <a class="see-all" href="#/collection/${f.id}">All ${f.count} ›</a>`);
}

// "More like this": other titles sharing genres.
function similarSection(list, heading = 'More like this') {
  if (!list?.length) return '';
  return html`<section class="dlg-section"><h2 class="similar-head" style="margin-bottom:14px">${heading}</h2><div class="similar-grid">${list.map((x) => {
    knownItems.set(x.id, x);
    const m = [x.year, x.type === 'show' ? `${x.seasonCount} season${x.seasonCount === 1 ? '' : 's'}` : fmtDuration(x.duration)].filter(Boolean).join(' · ');
    return html`<a class="similar-card" href="${hrefFor(x)}">
      <div class="art"><img loading="lazy" src="${artUrl('backdrop', x)}" alt=""><span class="art-title">${x.title}</span></div>
      <div class="txt"><span class="m">${m}</span>${x.overview ? html`<span class="o">${x.overview}</span>` : ''}</div></a>`;
  })}</div></section>`;
}

// Admins: where a show's files are on disk, season by season.
function showFilesBox(f) {
  const bySeason = new Map();
  for (const e of f.episodes) {
    const k = e.season ?? -1;
    if (!bySeason.has(k)) bySeason.set(k, []);
    bySeason.get(k).push(e);
  }
  const label = (e) => (e.episode == null ? '' : `E${String(e.episode).padStart(2, '0')}${e.episodeEnd ? `–E${String(e.episodeEnd).padStart(2, '0')}` : ''}`);
  return html`<details class="tech-box"><summary>Files (${f.episodes.length})</summary>
    ${f.folder ? html`<div class="file-path" style="margin:8px 0 12px">📁 <code>${f.folder}</code> <button class="btn small" data-copy="${f.folder}">Copy</button></div>` : ''}
    ${[...bySeason].map(([s, eps]) => html`
      <div class="files-season">${s === -1 ? 'Unsorted' : s === 0 ? 'Specials' : `Season ${s}`}</div>
      ${eps.map((e) => html`<div class="file-row"><a href="#/item/${e.id}">${label(e) || 'Episode'}</a>
        <code title="${e.file}">${e.file.split(/[\\/]/).pop()}</code><span class="muted">${[e.video, e.size ? fmtSize(e.size) : ''].filter(Boolean).join(' · ')}</span>
        <button class="btn small" data-copy="${e.file}" aria-label="Copy the path of ${label(e)}">Copy</button></div>`)}`)}
  </details>`;
}

// "Copy" next to a file path (admins).
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  navigator.clipboard?.writeText(b.dataset.copy).then(() => toast('Path copied'), () => toast(b.dataset.copy));
});

async function viewShow({ params: [id], query, seq }) {
  // One season's episodes at a time (the one asked for, else the next to watch's): the others are
  // loaded when picked, so a show with a thousand episodes opens as quickly as any other.
  const show = await api(`/api/shows/${id}?episodes=${encodeURIComponent(query.get('season') ?? 'auto')}`);
  const seasonKey = (s) => String(s.season);
  let current = show.seasons.find((s) => s.episodes) && seasonKey(show.seasons.find((s) => s.episodes));
  const up = show.upNext;
  const resuming = up?.progress?.position && !up.progress.watched;
  const upLabel = up ? `${resuming ? 'Resume' : 'Play'} ${epLabel(up).replace(' · ', ':')}` : null;
  document.title = `${show.title} · Marquee`;

  const episodeRow = (e) => { knownItems.set(e.id, e); return html`
    <div class="episode ${up?.id === e.id ? 'current' : ''}">
      <span class="ep-num">${e.episode ?? ''}</span>
      <div class="art">
        <a href="#/item/${e.id}" aria-label="${e.title}"><img loading="lazy" src="${artUrl('thumb', e)}" alt=""></a>
        ${progressBar(e)}
        <button class="play-hover" data-play="${e.id}" aria-label="Play ${e.title}">▶</button>
      </div>
      <a href="#/item/${e.id}">
        <div class="ep-title"><span>${e.title}</span><span class="muted">${fmtDuration(e.duration)}</span></div>
        ${e.overview ? html`<div class="ep-overview">${e.overview}</div>` : ''}
      </a>
      <div class="ep-actions">
        ${phoneDownloads() ? html`<button class="watch-toggle ep-dl" data-offline="${e.id}" title="Download to watch offline" aria-label="Download ${e.title} to watch offline">${icon('download')}</button>` : ''}
        <button class="watch-toggle ${e.progress?.watched ? 'on' : ''}" data-watch="${e.id}" title="${e.progress?.watched ? 'Mark unwatched' : 'Mark watched'}" aria-label="${e.progress?.watched ? 'Mark unwatched' : 'Mark watched'}">✓</button>
        <button class="card-menu static" data-menu="${e.id}" aria-label="More options">⋯</button>
      </div>
    </div>`; };

  const renderSeason = async () => {
    const season = show.seasons.find((s) => seasonKey(s) === current);
    if (!season.episodes) {
      const body = $('#season-body');
      body.innerHTML = html`<div class="muted">Loading ${season.title}…</div>`.s;
      const got = await api(`/api/shows/${id}/episodes?season=${encodeURIComponent(current)}`).catch((err) => { toast(err.message, true); return null; });
      // (Not if another season was picked meanwhile, or the page left.)
      if (!got || seasonKey(season) !== current || !body.isConnected) return;
      season.episodes = got.episodes;
    }
    const allWatched = season.episodes.every((e) => e.progress?.watched);
    $('#season-watch').textContent = allWatched ? 'Mark season unwatched' : 'Mark season watched';
    $('#season-body').innerHTML = html`<div class="episodes">${season.episodes.map(episodeRow)}</div>`.s;
    $('#season-watch').onclick = async () => {
      await api(`/api/shows/${id}/watched`, { method: 'POST', body: { season: season.season, watched: !allWatched } });
      router();
    };
    if ($('#season-dl')) $('#season-dl').onclick = () => window.MarqueeAndroid.downloadMany(JSON.stringify(season.episodes.map((e) => e.id)));
  };

  const allWatched = show.unwatchedCount === 0;
  if (!setView(seq, html`
    <div class="dlg-hero">
      <img src="${artUrl('backdrop', show)}" alt="">
      ${dlgTop(show)}
      <div class="dlg-head">
        ${sagaChip(show)}
        <h1 class="dlg-title">${show.title}</h1>
        <div class="dlg-actions">
          ${up ? html`<button class="btn play" data-play="${up.id}">${icon('play')}${upLabel}</button>` : ''}
          ${listButton(show)}
          <button class="round" id="show-watch" aria-label="${allWatched ? 'Mark the whole show unwatched' : 'Mark the whole show watched'}" title="${allWatched ? 'Mark the whole show unwatched' : 'Mark the whole show watched'}">${allWatched ? '↺' : icon('check')}</button>
        </div>
      </div>
    </div>
    <div class="dlg-body">
      <div>
        <div class="dlg-meta">
          ${show.year ? html`<span>${show.year}</span>` : ''}
          <span>${show.seasonCount} season${show.seasonCount === 1 ? '' : 's'}</span>
          <span>${show.episodeCount} episodes</span>
          ${show.unwatchedCount && !allWatched ? html`<span class="muted">${show.unwatchedCount} unwatched</span>` : ''}
          ${show.contentRating ? html`<span class="age-badge">${show.contentRating}</span>` : ''}${show.rating ? html`<span>★ ${show.rating}</span>` : ''}
        </div>
        ${resuming ? progressLine(up, `${epLabel(up).replace(' · ', ':')} · ${up.title}`) : ''}
        ${show.overview ? html`<p class="overview">${show.overview}</p>` : ''}
        ${matchNote(show)}
      </div>
      ${sideInfo(show)}
    </div>
    ${show.seasons.length ? html`<section class="dlg-section">
      <div class="dlg-section-head"><h2>Episodes</h2>
        <div class="row">
          ${show.seasons.length > 1 ? html`<select id="season-pick" aria-label="Season">${show.seasons.map((s) => html`<option value="${seasonKey(s)}" ${seasonKey(s) === current ? 'selected' : ''}>${s.title}</option>`)}</select>`
            : html`<span class="muted">${show.seasons[0].title}</span>`}
          <button class="btn small" id="season-watch"></button>
          ${phoneDownloads() ? html`<button class="btn small" id="season-dl">Download season</button>` : ''}
          <button class="btn small" id="more-seasons" title="Ask for seasons that aren't here yet">＋ More seasons</button>
        </div></div>
      <div id="season-body"></div>
    </section>` : ''}
    ${extrasSection(show.extras)}
    ${castSection(show.cast)}
    ${franchiseSection(show.franchise)}
    ${similarSection(show.similar)}
    ${show.files ? (show.files.episodes ? showFilesBox(show.files) : html`<details class="tech-box" id="show-files"><summary>Files (${show.files.count})</summary><div class="muted">Loading…</div></details>`) : ''}`)) return;

  bindDetailActions(show);
  if (current != null && show.seasons.length) renderSeason();
  // Admins: every episode's file, fetched when opened.
  const filesBox = $('#show-files');
  if (filesBox) filesBox.ontoggle = async () => {
    if (!filesBox.open || filesBox.dataset.loaded) return;
    filesBox.dataset.loaded = '1';
    const f = await api(`/api/shows/${id}/files`).catch(() => null);
    if (!f) return;
    const box = document.createElement('div');
    box.innerHTML = showFilesBox(f).s;
    box.firstElementChild.open = true;
    filesBox.replaceWith(box.firstElementChild);
  };
  if ($('#season-pick')) $('#season-pick').onchange = (e) => {
    current = e.target.value;
    history.replaceState(null, '', `#/show/${id}?season=${current}`);
    renderSeason();
  };
  $('#show-watch').onclick = async () => { await api(`/api/shows/${id}/watched`, { method: 'POST', body: { watched: !allWatched } }); router(); };
  if ($('#more-seasons')) $('#more-seasons').onclick = () => openMoreSeasons(show);
  viewEl.onclick = async (e) => {
    const b = e.target.closest('[data-watch]'); if (!b) return;
    await api(`/api/items/${b.dataset.watch}/watched`, { method: 'POST', body: { watched: !b.classList.contains('on') } });
    router();
  };
}

async function viewItem({ params: [id], seq }) {
  const it = await api(`/api/items/${id}`);
  viewEl.onclick = null;
  const isEp = it.type === 'episode';
  const isExtra = it.type === 'extra';
  const p = it.progress;
  const resumable = p && !p.watched && p.position > 15;
  const v = it.media?.video, a = it.media?.audio?.[0];
  const res = resLabel(v);
  document.title = `${isEp ? `${it.showTitle} · ` : ''}${it.title} · Marquee`;
  if (!setView(seq, html`
    <div class="dlg-hero">
      <img src="${artUrl(isEp || isExtra ? 'thumb' : 'backdrop', it)}" alt="">
      ${dlgTop(it)}
      <div class="dlg-head">
        ${isEp ? html`<div class="dlg-eyebrow"><a href="#/show/${it.showId}?season=${it.season}">${it.showTitle}</a> · ${epLabel(it).replace(' · ', ':')}</div>` : ''}
        ${isExtra ? html`<div class="dlg-eyebrow">${it.extraLabel}${it.parent ? html` · <a href="#/${it.parent.type === 'show' ? 'show' : 'item'}/${it.parent.id}">${it.parent.title}</a>` : ''}</div>` : ''}
        ${isEp || isExtra ? '' : sagaChip(it)}
        <h1 class="dlg-title">${it.title}</h1>
        <div class="dlg-actions">
          ${it.media ? html`
            <button class="btn play" data-play="${id}" ${resumable ? '' : raw('data-t="0"')}>${icon('play')}${resumable ? 'Resume' : 'Play'}</button>
            ${resumable ? html`<button class="btn ghost" data-play="${id}" data-t="0">From the start</button>` : ''}` : ''}
          ${it.versions?.length > 1 ? html`<select class="version-pick" data-version title="Which version to play" aria-label="Version">
            <option value="">Best for this device</option>${it.versions.map((v) => html`<option value="${v.id}">${v.label}</option>`)}</select>` : ''}
          ${listButton(it)}
          <button class="round" id="item-watch" aria-label="${p?.watched ? 'Mark unwatched' : 'Mark watched'}" title="${p?.watched ? 'Mark unwatched' : 'Mark watched'}">${p?.watched ? '↺' : icon('check')}</button>
          ${phoneDownloads() ? html`<button class="round" data-offline="${id}" aria-label="Download to watch offline" title="Download to watch offline">${icon('download')}</button>`
            : html`<a class="round" href="/api/items/${id}/stream?download=1" download aria-label="Download the original file" title="Download the original file">${icon('download')}</a>`}
          ${it.sourceUrl ? html`<a class="round" href="${it.sourceUrl}" target="_blank" rel="noopener" aria-label="Open the original video page" title="Open the original video page">${icon('link')}</a>` : ''}
        </div>
      </div>
    </div>
    <div class="dlg-body">
      <div>
        <div class="dlg-meta">
          ${it.year && !isEp ? html`<span>${it.year}</span>` : ''}
          ${it.airDate ? html`<span>${it.airDate}</span>` : ''}
          ${it.channel ? html`<span title="Channel">${it.channel}</span>` : ''}
          ${it.duration ? html`<span>${fmtDuration(it.duration)}</span>` : ''}
          ${it.contentRating ? html`<span class="age-badge">${it.contentRating}</span>` : ''}${it.rating ? html`<span>★ ${it.rating}</span>` : ''}
          ${res ? html`<span class="tag">${res}</span>` : ''}
          ${v?.colorTransfer === 'smpte2084' ? html`<span class="tag" title="High dynamic range">HDR10</span>` : v?.colorTransfer === 'arib-std-b67' ? html`<span class="tag" title="High dynamic range">HLG</span>` : ''}
          ${p?.watched ? html`<span class="tag">✓ Watched</span>` : ''}
        </div>
        ${resumable ? progressLine(it, `Paused at ${fmtClock(p.position)}`) : ''}
        ${!it.media ? html`<p class="error-box">This file could not be read by ffprobe.</p>` : ''}
        ${it.tagline ? html`<p class="tagline">${it.tagline}</p>` : ''}
        ${it.overview ? html`<p class="overview">${it.overview}</p>` : ''}
        ${matchNote(it)}
        ${isEp && (it.prev || it.next) ? html`<div class="ep-links">
          ${it.prev ? html`<a class="btn small" data-swap href="#/item/${it.prev.id}">‹ ${epLabel(it.prev).replace(' · ', ':')}</a>` : ''}
          ${it.next ? html`<a class="btn small" data-swap href="#/item/${it.next.id}">${epLabel(it.next).replace(' · ', ':')} ›</a>` : ''}</div>` : ''}
      </div>
      ${sideInfo(it)}
    </div>
    ${extrasSection(it.extras)}
    ${it.type !== 'episode' ? castSection(it.cast) : ''}
    ${franchiseSection(it.franchise)}
    ${similarSection(it.similar)}
    <details class="tech-box" ${it.file ? raw('open') : ''}><summary>${it.file ? 'File' : 'File and playback details'}</summary>
      <dl class="tech">
        ${it.file ? html`<dt>File</dt><dd class="file-path"><code>${it.file}</code> <button class="btn small" data-copy="${it.file}">Copy</button></dd>` : ''}
        <dt>Plays</dt><dd>${it.directPlay ? 'Directly in this browser' : 'Converted on the fly by the server'}</dd>
        ${it.file ? '' : html`<dt>File</dt><dd>${it.fileName}</dd>`}
        <dt>Size</dt><dd>${fmtSize(it.size)}</dd>
        ${it.media ? html`
          <dt>Container</dt><dd>${it.media.container}</dd>
          ${v ? html`<dt>Video</dt><dd>${v.codec?.toUpperCase()} ${v.profile ? `(${v.profile})` : ''} · ${v.width}×${v.height}</dd>` : ''}
          ${a ? html`<dt>Audio</dt><dd>${it.audioTracks.map((t) => t.label).join(', ')}</dd>` : ''}
          ${it.media.bitrate ? html`<dt>Bitrate</dt><dd>${(it.media.bitrate / 1e6).toFixed(1)} Mbps</dd>` : ''}` : ''}
        <dt>Subtitles</dt><dd>${it.subtitles.length ? it.subtitles.map((x) => x.label).join(', ') : 'None'}</dd>
      </dl>
    </details>`)) return;
  bindDetailActions(it);
  $('#item-watch').onclick = async () => {
    await api(`/api/items/${id}/watched`, { method: 'POST', body: { watched: !p?.watched } });
    router();
  };
}

async function viewSearch({ query, seq }) {
  const q = query.get('q') || '';
  if ($('#search-input') !== document.activeElement) $('#search-input').value = q;
  if (q) $('#search-form').classList.add('open');
  const ask = html`<div class="req-ask"><span class="muted">Not finding what you want?</span> <button class="btn small" data-ask="${q}">Ask for it</button></div>`;
  if (!q.trim()) {
    return setView(seq, $('#voice-btn').hidden ? html`<div class="empty">Type to search your libraries.</div>`
      : html`<div class="empty">Type to search your libraries, or <button class="btn" data-voice>${icon('mic')} Search by voice</button></div>`);
  }
  const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
  const total = r.movies.length + r.shows.length + r.episodes.length;
  if (!setView(seq, html`
    <div class="toolbar"><h1>Results for “${q}”</h1>${total ? selectButton() : ''}</div>
    ${total && r.understood?.length ? html`<div class="muted" style="margin:-6px 0 12px">Showing ${r.understood.join(' · ')}</div>` : ''}
    ${!total ? html`<div class="empty">No matches.</div>` : ''}
    ${!tv.on || !total ? ask : ''}
    ${r.movies.length ? html`<section class="hub"><div class="hub-head"><h2>Movies</h2></div><div class="grid">${r.movies.map(posterCard)}</div></section>` : ''}
    ${r.shows.length ? html`<section class="hub"><div class="hub-head"><h2>Shows</h2></div><div class="grid">${r.shows.map(posterCard)}</div></section>` : ''}
    ${r.episodes.length ? html`<section class="hub"><div class="hub-head"><h2>Episodes</h2></div><div class="grid wide">${r.episodes.map(wideCard)}</div></section>` : ''}`)) return;
  bindSelect({ root: () => view, kind: 'titles' });
}
