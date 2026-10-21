'use strict';
/* Marquee web client — Settings (admins). A calm, Netflix-style account area: a menu of pages on the
   left (a row of tabs on phones), each page made of cards. Every page lives in SETTINGS_PAGES:
   to add one, add an entry with what it loads, how it looks and what its buttons do.
   The panels for some pages are in settings-libraries.js, settings-media.js and settings-server.js;
   helpers from the other files are used only when called. */

const ST_ICON = {
  overview: '<path d="M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1z"/>',
  libraries: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0113 0M16 4.5a3.5 3.5 0 010 7M18 14a6 6 0 013.5 6"/>',
  home: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><rect x="3" y="12" width="5" height="8" rx="1"/><rect x="10" y="12" width="5" height="8" rx="1"/><rect x="17" y="12" width="4" height="8" rx="1"/>',
  playback: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5l6 3.5-6 3.5z"/>',
  metadata: '<path d="M4 4h9l7 7-9 9-7-7z"/><circle cx="8.5" cy="8.5" r="1.5"/>',
  remote: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/>',
  backups: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  requests: '<path d="M4 5h16v11H8l-4 4z"/>',
  report: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  convert: '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>',
  arr: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/>',
};
const stIcon = (k) => raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ST_ICON[k] || ''}</svg>`);
const chevron = () => raw('<svg class="st-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>');

// A row in a card: a label, what it's set to, and where it leads.
const stRow = (label, value, href, { warn = false } = {}) => html`<a class="st-row ${warn ? 'warn' : ''}" href="${href}">
  <span class="st-row-label">${label}</span><span class="st-row-value">${value}</span>${chevron()}</a>`;

const SETTINGS_PAGES = [
  {
    id: 'overview', label: 'Overview',
    badge: () => (['warn', 'bad'].includes(state.status?.health) ? '!' : ''),
    load: () => Promise.all([api('/api/status'), api('/api/health-check').catch(() => null), api('/api/users'), api('/api/backups'),
      api('/api/remote'), api('/api/transcoding'), api('/api/settings'), refreshLibraries()]),
    render: ([s, health, users, backups, remote, tc, settings]) => {
      const libs = state.libraries;
      const movies = libs.filter((l) => l.type === 'movie').reduce((n, l) => n + l.count, 0);
      const shows = libs.filter((l) => l.type === 'show').reduce((n, l) => n + l.count, 0);
      const locked = users.filter((u) => u.locks?.signIn || u.locks?.pin).length;
      const last = backups.backups[0];
      const rows = settings.home;
      const homeOn = ['hero', 'top10', 'watchlist', 'recent', 'because', 'liked', 'franchises', 'upcoming'].filter((k) => rows[k]).length + (rows.genres ? 1 : 0) + (rows.collections ? 1 : 0);
      const needs = [
        s.requestsPending ? stRow('Requests', `${s.requestsPending} waiting`, '#/requests', { warn: true }) : '',
        s.updateAvailable ? stRow('Update', 'A new version is ready', '#/settings/server', { warn: true }) : '',
        locked ? stRow('Locked out', `${locked} ${locked === 1 ? 'person' : 'people'}`, '#/settings/users', { warn: true }) : '',
      ].filter(Boolean);
      return html`
        ${health ? healthSection(health) : ''}
        ${needs.length ? html`<h2 class="st-sub">Needs you</h2><div class="st-card">${needs}</div>` : ''}
        <h2 class="st-sub">At a glance</h2>
        <div class="st-card">
          ${stRow('Libraries', libs.length ? `${libs.length} · ${movies} films · ${shows} shows` : 'None yet: add one', '#/settings/libraries', { warn: !libs.length })}
          ${stRow('Users', `${users.length} ${users.length === 1 ? 'person' : 'people'}`, '#/settings/users')}
          ${stRow('Home screen', `${homeOn} kinds of rows${rows.hero ? ' and a banner' : ''}`, '#/settings/home')}
          ${stRow('Playback', `Converting with ${tc.activeName}${tc.remoteMaxQuality ? ` · away from home up to ${tc.remoteMaxQuality}` : ''}`, '#/settings/playback')}
          ${stRow('Metadata', `TMDB ${settings.tmdbKeySet || settings.tmdbKeyFromEnv ? '✓' : 'not set up'} · OpenSubtitles ${settings.opensubtitles.keySet ? '✓' : 'off'}`, '#/settings/metadata')}
          ${stRow('Remote access', remote.seen ? `Reachable at ${remote.seen.origin.replace(/^https:\/\//, '')}` : remote.configured.length ? 'Switched on' : 'Only at home', '#/settings/remote')}
          ${stRow('Backups', last ? `Last ${fmtDate(last.createdAt)}${backups.copy ? ' · copied elsewhere' : ' · only on this PC'}` : 'None yet', '#/settings/backups', { warn: !!(backups.copy?.last && !backups.copy.last.ok) })}
          ${stRow('Server', `Marquee ${s.version}${s.updateAvailable ? ' · update available' : ''}`, '#/settings/server')}
        </div>`;
    },
    bind: () => bindHealthSection(),
  },
  {
    id: 'libraries', label: 'Libraries',
    load: () => Promise.all([refreshLibraries(), api('/api/settings'), api('/api/problems')]),
    actions: () => html`${state.libraries.length ? html`<button class="btn small" id="scan-all">↻ Scan all</button>` : ''}<button class="btn small primary" id="add-lib">＋ Add library</button>`,
    render: ([, metaSettings, problems]) => {
      const libs = state.libraries;
      return html`
        <div id="lib-form-slot"></div>
        ${libs.length ? libs.map((l) => html`
          <div class="panel lib-row" data-lib="${l.id}">
            <div class="lib-icon">${l.type === 'show' ? '📺' : '🎬'}</div>
            <div class="lib-info">
              <div style="font-weight:600">${l.name} <span class="muted" style="font-weight:400">· ${l.type === 'show' ? `${l.count} shows, ${l.episodeCount} episodes` : `${l.count} movies`}</span></div>
              <div class="paths">${l.paths.map((p) => html`<div class="path-line">📁 ${l.pathLabels?.[p] ? html`${l.pathLabels[p]} <span class="path-inner">(${p})</span>` : p}
                ${l.missingPaths.includes(p) ? html`<span class="path-tag bad">offline / not found</span>` : html`<span class="path-tag">${l.pathCounts[p]} file${l.pathCounts[p] === 1 ? '' : 's'}</span>`}</div>`)}</div>
              <div class="muted" style="font-size:12px;margin-top:4px">Last scanned: ${fmtDate(l.scannedAt)}</div>
            </div>
            <div class="row">
              <button class="btn small" data-act="scan">↻ Scan</button>
              ${metaSettings.providers.some((p) => p.enabled && p.kinds.includes(l.type)) ? html`<button class="btn small" data-act="meta" title="Look up every title again (your edits are kept)">Refresh metadata</button>` : ''}
              <button class="btn small" data-act="edit">Edit</button>
              <button class="btn small danger" data-act="delete">Delete</button>
            </div>
          </div>`) : html`<div class="panel muted">No libraries yet. Add one to get started.</div>`}
        ${libs.length ? html`<div id="problems-wrap">${problemsSection(problems)}</div>` : ''}`;
    },
    bind: ([, , problems], { query }) => {
      const libs = state.libraries;
      if (problems.recheck) setTimeout(refreshProblems, 2000);
      $('#add-lib').onclick = () => showLibraryForm();
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
    },
  },
  {
    // Which titles need converting for which players, and what the space goes on (lib/report.js).
    id: 'report', label: 'Formats & space',
    load: () => api('/api/library-report'),
    render: (r) => {
      const order = ['4K', '1440p', '1080p', '720p', 'SD', '?'];
      const res = order.filter((k) => r.byRes[k]);
      return html`
        <h2 class="st-sub" style="margin-top:0">Space</h2>
        <div class="st-card rep-space">
          <div class="rep-bar">${res.map((k) => html`<span class="rep-${k.replace('?', 'x')}" style="width:${(r.byRes[k].bytes / (r.total || 1)) * 100}%" title="${k}"></span>`)}</div>
          ${res.map((k) => html`<div class="st-row rep-line"><span class="rep-dot rep-${k.replace('?', 'x')}"></span><span class="st-row-label">${k === '?' ? 'Unknown' : k}</span>
            <span class="st-row-value">${r.byRes[k].count} file${r.byRes[k].count === 1 ? '' : 's'} · ${fmtSize(r.byRes[k].bytes)}</span></div>`)}
          <div class="st-row rep-line"><span class="rep-dot"></span><span class="st-row-label">HDR</span><span class="st-row-value">${r.hdr.count} file${r.hdr.count === 1 ? '' : 's'} · ${fmtSize(r.hdr.bytes)}</span></div>
          <div class="st-row rep-line"><span class="rep-dot"></span><span class="st-row-label">Altogether</span><span class="st-row-value">${r.files} files · ${fmtSize(r.total)}</span></div>
        </div>
        <h2 class="st-sub">Converted for each kind of player</h2>
        <div class="rep-players">${r.players.map((p) => html`<button class="rep-player" data-player="${p.id}">
          <b>${r.counts[p.id].convert}</b><span>${p.label}</span><small class="muted">picture converted${r.counts[p.id].light ? ` · ${r.counts[p.id].light} sound only` : ''}</small></button>`)}</div>
        ${helpText(html`Converting the picture is what keeps a server busy; converting only the sound (or the file type) is cheap.
          A <b>1080p H.264 MP4 with AAC sound</b> plays as it is everywhere. To keep a 4K copy for a big TV as well, put both in the film’s folder,
          e.g. <code>Dune (2021) - 4K.mkv</code> and <code>Dune (2021) - 1080p.mp4</code>: they show as one film, and each device plays the copy it can.`, 'What should I replace?')}
        <div class="row rep-filter">
          <label>Player <select id="rep-player"><option value="">Any</option>${r.players.map((p) => html`<option value="${p.id}">${p.label}</option>`)}</select></label>
          <label class="check"><input type="checkbox" id="rep-light"> Include sound-only conversions</label>
          <span class="muted" id="rep-count"></span>
        </div>
        <div class="st-card rep-list" id="rep-list"></div>`;
    },
    bind: (r) => {
      const icon = { direct: '✓', light: '◐', convert: '✕' };
      const word = { direct: 'plays as it is', light: 'sound converted', convert: 'picture converted' };
      let limit = 60;
      const draw = () => {
        const only = $('#rep-player').value;
        const light = $('#rep-light').checked;
        const bad = (t, id) => t.players[id].how === 'convert' || (light && t.players[id].how === 'light');
        const list = r.titles.filter((t) => (only ? bad(t, only) : r.players.some((p) => bad(t, p.id))));
        $('#rep-count').textContent = `${list.length} title${list.length === 1 ? '' : 's'}`;
        $('#rep-list').innerHTML = list.length ? html`${list.slice(0, limit).map((t) => html`<div class="rep-item">
          <div class="rep-title"><a href="#/item/${t.id}">${t.title}</a>
            <span class="rep-tags"><span class="tag">${t.res}</span>${t.hdr ? html`<span class="tag">${t.hdr}</span>` : ''}<span class="tag">${t.codec}</span>${t.audio ? html`<span class="tag">${t.audio}</span>` : ''}<span class="tag">${t.container}</span>${t.interlaced ? html`<span class="tag" title="Deinterlaced when converted">Interlaced</span>` : ''}${t.versions > 1 ? html`<span class="tag">${t.versions} versions</span>` : ''}</span>
            <span class="muted rep-size">${fmtSize(t.size)}</span></div>
          <div class="rep-fates">${r.players.map((p) => { const f = t.players[p.id]; return html`<span class="rep-fate ${f.how}" title="${p.label}: ${word[f.how]}${f.why.length ? ` (${f.why.join(', ')})` : ''}">${icon[f.how]} ${p.label}${f.how !== 'direct' && f.why.length ? html` <small>· ${f.why.join(', ')}</small>` : ''}</span>`; })}</div>
        </div>`)}${list.length > limit ? html`<button class="btn small" id="rep-more" style="margin:12px 20px">Show more</button>` : ''}`.s
          : html`<div class="st-row muted">Everything here plays as it is${only ? ' on that player' : ''}.</div>`.s;
        $('#rep-more')?.addEventListener('click', () => { limit += 100; draw(); });
      };
      $('#rep-player').onchange = () => { limit = 60; draw(); };
      $('#rep-light').onchange = () => { limit = 60; draw(); };
      for (const b of $$('.rep-player')) b.onclick = () => { $('#rep-player').value = b.dataset.player; limit = 60; draw(); };
      draw();
    },
  },
  {
    id: 'users', label: 'Users',
    load: () => Promise.all([api('/api/users'), refreshLibraries()]),
    actions: () => html`<button class="btn small primary" id="add-user">＋ Add user</button>`,
    render: ([users]) => usersSection(users, { heading: false }),
    bind: ([users]) => bindUsersSection(users),
  },
  {
    id: 'home', label: 'Home screen',
    load: () => Promise.all([api('/api/settings'), api('/api/intro-sound')]),
    render: ([st, sound]) => {
      const h = st.home;
      const toggle = (k, label, note = '') => html`<label class="st-row st-toggle"><span class="st-row-label">${label}${note ? html`<span class="st-row-note">${note}</span>` : ''}</span>
        <input type="checkbox" class="switch" data-home="${k}" ${h[k] ? 'checked' : ''}></label>`;
      const count = (k, label, note) => html`<label class="st-row st-toggle"><span class="st-row-label">${label}<span class="st-row-note">${note}</span></span>
        <select class="st-select" data-home="${k}">${[0, 1, 2, 3, 4, 5, 6].map((n) => html`<option value="${n}" ${h[k] === n ? 'selected' : ''}>${n === 0 ? 'None' : n}</option>`)}</select></label>`;
      return html`
        <p class="muted st-intro">What everyone’s home page shows, top to bottom. <b>Continue Watching</b> is always there.</p>
        <div class="st-card">
          ${toggle('hero', 'Banner at the top', 'A title with its artwork (and trailer, when there is one)')}
          ${toggle('top10', 'Top 10 in your house this week')}
          ${toggle('watchlist', 'My List')}
          ${toggle('recent', 'New in each library')}
          ${toggle('because', 'Because you watched …', 'Like the last thing each person watched')}
          ${toggle('liked', 'Because you liked …', 'Like their latest thumbs-up')}
          ${toggle('franchises', 'Franchises', 'The film worlds and studios in your libraries (Marvel, Star Wars, Pixar…)')}
          ${toggle('upcoming', 'Coming soon', 'New episodes of shows you watch, and films on their way in Radarr')}
          ${count('collections', 'Collection rows', 'The first collections, in the order you arranged them')}
          ${count('genres', 'Genre rows', 'The biggest genres in your libraries')}
        </div>
        <h2 class="st-sub">When Marquee opens</h2>
        <div class="st-card">
          <div class="st-row"><span class="st-row-label">Opening sound<span class="st-row-note">${sound.custom ? 'Your own sound' : 'The built-in whoosh'} · plays with the MARQUEE animation on every browser, phone and TV (the Roku fetches it from this server). Any audio file; the silence at its start is cut and it stops after 6 seconds.</span></span>
            <span class="row" style="gap:8px;flex-wrap:wrap;justify-content:flex-end">
              <button type="button" class="btn small" id="sound-play">Play</button>
              <label class="btn small" style="cursor:pointer">Upload a sound<input type="file" accept="audio/*" hidden id="sound-file"></label>
              ${sound.custom ? html`<button type="button" class="btn small" id="sound-reset">Use the built-in one</button>` : ''}
            </span></div>
        </div>`;
    },
    bind: () => {
      let playing = null;
      $('#sound-play').onclick = () => { playing?.pause(); playing = new Audio(`/sounds/intro.mp3?t=${Date.now()}`); playing.play().catch(() => toast('Couldn’t play it here', true)); };
      $('#sound-reset')?.addEventListener('click', async () => {
        try { await api('/api/intro-sound', { method: 'DELETE' }); toast('Back to the built-in sound'); router(); } catch (err) { toast(err.message, true); }
      });
      $('#sound-file').onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        toast('Uploading…');
        try {
          const res = await fetch('/api/intro-sound', { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
          const data = await res.json().catch(() => null);
          if (!res.ok) throw new Error(data?.error || `Upload failed (${res.status})`);
          toast('Opening sound changed');
          router();
        } catch (err) { toast(err.message, true); }
      };
      view.onchange = async (e) => {
        const el = e.target.closest('[data-home]');
        if (!el) return;
        const v = el.type === 'checkbox' ? el.checked : Number(el.value);
        try { await api('/api/settings', { method: 'PATCH', body: { home: { [el.dataset.home]: v } } }); toast('Saved'); } catch (err) { toast(err.message, true); router(); }
      };
    },
  },
  {
    id: 'playback', label: 'Playback',
    load: () => Promise.all([api('/api/transcoding'), api('/api/intro'), api('/api/settings')]),
    render: ([t, intro, settings]) => html`
      <h2 style="margin:0 0 12px">Previews</h2>
      <div class="st-card">
        <label class="st-row st-toggle"><span class="st-row-label">Play a preview when the pointer rests on a title
          <span class="st-row-note">Its trailer, or a 30-second clip from the film or show itself (also behind the home page’s banner). Clips are made the first time they’re wanted, never while someone is watching, and take a few MB each.</span></span>
          <input type="checkbox" class="switch" id="pv-on" ${settings.previewClips ? 'checked' : ''}></label>
      </div>
      ${transcodingSection(t, intro, settings)}`,
    bind: () => {
      bindTranscodingSection();
      $('#pv-on').onchange = async (e) => {
        try { await api('/api/settings', { method: 'PATCH', body: { previewClips: e.target.checked } }); toast(e.target.checked ? 'Previews on' : 'Previews off (the clips made so far are removed)'); } catch (err) { toast(err.message, true); }
        if (state.status) state.status.previewClips = e.target.checked;
      };
    },
  },
  {
    // Overnight conversions (lib/optimize.js): 1080p copies of files most TVs can't play as they are.
    id: 'convert', label: 'Overnight conversions',
    load: () => api('/api/optimize'),
    render: (o) => {
      const s = o.settings;
      const times = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
      const gbs = (g) => (g >= 1000 ? `${g / 1000} TB` : `${g} GB`);
      const placeNote = { default: `Marquee’s copies folder: ${o.defaultFolder}`, beside: 'In a “.marquee-converted” folder beside each film or episode (Radarr, Sonarr and Plex skip folders starting with a dot). Where that drive is read-only, the copies folder is used.', folder: '' }[s.place];
      const word = { off: 'Off', held: `Paused by ${o.hold?.by || 'an admin'}`, tonight: `Stopped for tonight (until ${o.hold ? fmtTime(o.hold.until) : ''})`, moving: 'Moving the copies', done: 'Everything chosen has a copy', full: 'Paused: the space allowed is used up', waiting: `Waiting for ${s.start}`, paused: 'Paused while someone watches', starting: 'Starting…', converting: 'Converting' };
      return html`
        <p class="muted st-intro">Files most of your TVs can't play as they are (DVD rips, 4K, HEVC) get a 1080p copy made at night on the graphics card.
          Each TV then plays whichever copy it can play as it is: a 4K TV still gets the original, the others the copy, so the server isn't converting while you watch.
          The originals are never changed.</p>
        <div class="st-card">
          ${stToggle('Make copies overnight', `${o.counts.done} made so far · ${fmtSize(o.used)} of ${gbs(s.maxGb)} used`, 'id="opt-on"', s.enabled)}
          ${s.enabled ? html`<div class="st-row ${['full'].includes(o.state) ? 'warn' : ''}"><span class="st-row-label">${word[o.state]}${o.running ? html`: ${o.running.title} · ${Math.round(o.running.progress * 100)}%${o.running.secondsLeft != null ? ` · ${fmtEta(o.running.secondsLeft)}` : ''}` : ''}
              <span class="st-row-note">${o.state === 'paused' ? 'It carries on when nobody is watching. · ' : ''}${o.queue ? `${o.queue} to go` : 'Nothing waiting'}${o.runUntil ? ` · running until ${fmtDate(o.runUntil)}` : ''}${o.last ? ` · last: ${o.last.title} ${o.last.ok ? `(${Math.round(o.last.seconds / 60)} min)` : `failed: ${o.last.error}`}` : ''}</span></span>
            ${optimizeButtons(o)}</div>` : ''}
        </div>
        <h2 class="st-sub">Which files</h2>
        <div class="st-card">${Object.entries(o.kinds).map(([k, label]) => stToggle(label, `${o.counts[k]} without a copy`, `data-kind="${k}"`, s.kinds[k]))}</div>
        <h2 class="st-sub">When and how much</h2>
        <div class="st-card">
          ${stSelect('From', 'Conversions start at this time…', 'data-opt="start"', html`${times.map((t) => html`<option ${t === s.start ? 'selected' : ''}>${t}</option>`)}`)}
          ${stSelect('Until', '…and none start after this one (one under way finishes).', 'data-opt="end"', html`${times.map((t) => html`<option ${t === s.end ? 'selected' : ''}>${t}</option>`)}`)}
          ${stSelect('Space for copies', 'When the copies reach this, no more are made.', 'data-opt="maxGb"',
            html`${[50, 100, 200, 500, 1000, 2000, 4000].map((g) => html`<option value="${g}" ${g === s.maxGb ? 'selected' : ''}>${gbs(g)}</option>`)}`)}
        </div>
        <h2 class="st-sub">Where copies are kept</h2>
        <div class="st-card">
          ${stSelect('Keep copies', [placeNote, o.free != null ? `${fmtSize(o.free)} free there` : ''].filter(Boolean).join(' · '), 'id="opt-place"', html`
            <option value="default" ${s.place === 'default' ? 'selected' : ''}>In the copies folder</option>
            <option value="beside" ${s.place === 'beside' ? 'selected' : ''}>Next to the originals</option>
            <option value="folder" ${s.place === 'folder' ? 'selected' : ''}>In a folder you pick…</option>`)}
          ${s.place === 'folder' ? html`<div class="st-row"><span class="st-row-label">📁 ${o.folderLabel}</span><button class="btn small" id="opt-folder">Change…</button></div>` : ''}
          ${o.moving ? html`<div class="st-row"><span class="st-row-label">Moving the copies: ${o.moving.done} of ${o.moving.total}
              <span class="st-row-note">Conversions wait until it’s finished.</span></span></div>`
            : o.elsewhere.count ? html`<div class="st-row warn"><span class="st-row-label">${o.elsewhere.count} ${o.elsewhere.count === 1 ? 'copy is' : 'copies are'} still where ${o.elsewhere.count === 1 ? 'it was' : 'they were'} (${fmtSize(o.elsewhere.size)})
              <span class="st-row-note">They still play from there. New copies go to the new place.</span></span>
              <button class="btn small" id="opt-move">Move them here</button></div>` : ''}
          ${!o.moving && o.moved?.failed ? html`<div class="st-row warn"><span class="st-row-label">${o.moved.failed} couldn’t be moved (${o.moved.error})</span></div>` : ''}
        </div>
        ${helpText(html`A DVD film's copy is about 1–2 GB and takes a few minutes on an NVIDIA card; a 4K film's 1080p copy is about 4–8 GB.
          Copies keep every sound track (as stereo) and text subtitles; picture subtitles (DVD / Blu-ray) stay with the original, which is still there to pick.
          In Docker, the copies folder is <code>OPTIMIZED_DIR</code> in <code>.env</code>, and a folder you pick must be on a drive shared with Marquee (<code>DRIVE_1</code>… in <code>.env</code>).`, 'How big, and where?')}
        ${o.counts.done ? html`<p><button class="btn small danger" id="opt-clear">Remove all copies</button></p>` : ''}`;
    },
    bind: (o) => {
      const patch = async (body, msg) => { try { await api('/api/optimize', { method: 'PATCH', body }); toast(msg); router(); } catch (err) { toast(err.message, true); } };
      const pickPlace = async () => {
        const dir = await pickFolder(o.settings.folder || undefined);
        if (!dir) return router();
        patch({ place: 'folder', folder: dir }, 'New copies go there');
      };
      view.onchange = (e) => {
        const el = e.target;
        if (el.id === 'opt-place') return el.value === 'folder' ? pickPlace() : patch({ place: el.value }, 'New copies go there');
        if (el.id === 'opt-on') return patch({ enabled: el.checked }, el.checked ? 'Overnight conversions on' : 'Overnight conversions off');
        if (el.dataset.kind) return patch({ kinds: { [el.dataset.kind]: el.checked } }, 'Saved');
        if (el.dataset.opt) return patch({ [el.dataset.opt]: el.dataset.opt === 'maxGb' ? Number(el.value) : el.value }, 'Saved');
      };
      if ($('#opt-folder')) $('#opt-folder').onclick = pickPlace;
      if ($('#opt-move')) $('#opt-move').onclick = async () => {
        try { await api('/api/optimize/move', { method: 'POST' }); toast('Moving the copies'); } catch (err) { toast(err.message, true); }
        router();
      };
      bindOptimizeButtons(view, () => router());
      if ($('#opt-clear')) $('#opt-clear').onclick = async () => {
        if (!confirm(`Remove all ${o.counts.done} copies (${fmtSize(o.used)})? The originals stay; copies are made again if conversions are on.`)) return;
        await api('/api/optimize', { method: 'DELETE' }); toast('Copies removed'); router();
      };
      if (o.running || o.moving) setTimeout(() => { if (location.hash === '#/settings/convert') router(); }, 15000);
    },
  },
  {
    // Radarr / Sonarr: approved requests are sent to them (lib/arr.js).
    id: 'arr', label: 'Radarr & Sonarr',
    load: async () => {
      const [cfg, users, rules] = await Promise.all([api('/api/arr'), api('/api/users'), api('/api/request-rules')]);
      const opts = {};
      await Promise.all(['radarr', 'sonarr'].filter((a) => cfg[a].keySet).map(async (a) => {
        try { opts[a] = await api(`/api/arr/${a}/options`); } catch (err) { opts[a] = { error: err.message }; }
      }));
      return { cfg, users, opts, rules };
    },
    render: ({ cfg, users, opts, rules }) => html`
      <p class="muted st-intro">Approved requests are added to Radarr (films) or Sonarr (shows), which find and download them into a folder Marquee watches.
        When the file arrives, the request is marked as here and whoever asked gets a notification.</p>
      ${['radarr', 'sonarr'].map((a) => arrCard(a, cfg[a], opts[a], cfg.monitorOptions))}
      <h2 class="st-sub">Who can skip approval</h2>
      <p class="muted" style="margin:-4px 0 10px;font-size:13px">Their requests go straight to Radarr / Sonarr. Films and shows are separate, since a show can take far more space. Everyone else's wait for you on the Requests page.</p>
      <div class="st-card">${users.map((u) => html`<div class="st-row arr-user" data-uid="${u.id}">
        <span class="st-row-label">${u.username}${u.role === 'admin' ? html`<span class="st-row-note">Admin: always</span>` : ''}</span>
        <label class="arr-auto">Films <input type="checkbox" class="switch" data-auto="movie" ${u.autoApprove?.movie ? 'checked' : ''} ${u.role === 'admin' ? 'disabled' : ''}></label>
        <label class="arr-auto">Shows <input type="checkbox" class="switch" data-auto="show" ${u.autoApprove?.show ? 'checked' : ''} ${u.role === 'admin' ? 'disabled' : ''}></label>
      </div>`)}</div>
      <h2 class="st-sub">Limits</h2>
      <div class="st-card">
        ${stSelect('Keep free space', 'When the folder downloads go to has less than this, requests that would skip approval wait for you instead.', 'data-rule="minFreeGb"',
          html`${[[0, 'No limit'], [50, '50 GB'], [100, '100 GB'], [200, '200 GB'], [500, '500 GB'], [1000, '1 TB'], [2000, '2 TB']].map(([v, l]) => html`<option value="${v}" ${rules.minFreeGb === v ? 'selected' : ''}>${l}</option>`)}`)}
        ${stSelect('Films per person each week', 'Beyond this, someone’s film requests wait for you (for the rest of the week).', 'data-rule="weekly.movie"',
          html`${[0, 1, 2, 3, 5, 7, 10, 20].map((v) => html`<option value="${v}" ${rules.weekly.movie === v ? 'selected' : ''}>${v ? v : 'No limit'}</option>`)}`)}
        ${stSelect('Shows per person each week', 'The same for shows (or more seasons of one).', 'data-rule="weekly.show"',
          html`${[0, 1, 2, 3, 5, 10].map((v) => html`<option value="${v}" ${rules.weekly.show === v ? 'selected' : ''}>${v ? v : 'No limit'}</option>`)}`)}
        ${stSelect('Tell me when something isn’t found after', 'Radarr / Sonarr keep looking; you get a notification, and the request shows Look again and Try another quality.', 'data-rule="stuckDays"',
          html`${[[0, 'Never'], [3, '3 days'], [7, '7 days'], [14, '2 weeks'], [30, 'a month']].map(([v, l]) => html`<option value="${v}" ${rules.stuckDays === v ? 'selected' : ''}>${l}</option>`)}`)}
      </div>`,
    bind: ({ cfg, users }) => {
      const save = async (a, body, msg) => {
        try { await api(`/api/arr/${a}`, { method: 'PUT', body }); toast(msg); router(); } catch (err) { toast(err.message, true); }
      };
      view.onsubmit = async (e) => {
        const form = e.target.closest('[data-arr-form]');
        if (!form) return;
        e.preventDefault();
        const a = form.dataset.arrForm;
        const f = form.elements;
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        btn.textContent = 'Checking…';
        // Checked first, then saved with the first profile capped at 1080p (or the first) and folder.
        try {
          const t = await api(`/api/arr/${a}/test`, { method: 'POST', body: { url: f.url.value, apiKey: f.apiKey.value } });
          const p = t.profiles.find((x) => x.maxRes && x.maxRes <= 1080 && /1080/.test(x.name)) || t.profiles.find((x) => x.maxRes && x.maxRes <= 1080) || t.profiles[0];
          const body = { url: f.url.value, apiKey: f.apiKey.value };
          if (!cfg[a].profileId && p) body.profileId = p.id;
          if (!cfg[a].rootFolder && t.rootFolders.length) body.rootFolder = (t.rootFolders.find((r) => r.library) || t.rootFolders[0]).path;
          await save(a, body, `Connected to ${cfg[a].name} ${t.version || ''}`);
        } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Connect'; }
      };
      view.onchange = async (e) => {
        const el = e.target;
        const a = el.closest('[data-arr]')?.dataset.arr;
        if (a && el.dataset.set) {
          const v = el.type === 'checkbox' ? el.checked : el.dataset.set === 'profileId' ? Number(el.value) : el.value;
          return save(a, { [el.dataset.set]: v }, 'Saved');
        }
        if (el.dataset.rule) {
          const [k, sub] = el.dataset.rule.split('.');
          try { await api('/api/request-rules', { method: 'PUT', body: sub ? { [k]: { [sub]: Number(el.value) } } : { [k]: Number(el.value) } }); toast('Saved'); } catch (err) { toast(err.message, true); }
          return;
        }
        const row = el.closest('.arr-user');
        if (row && el.dataset.auto) {
          const u = users.find((x) => x.id === row.dataset.uid);
          try {
            const r = await api(`/api/users/${u.id}`, { method: 'PATCH', body: { autoApprove: { [el.dataset.auto]: el.checked } } });
            u.autoApprove = r.autoApprove;
            toast(`${u.username}'s ${el.dataset.auto === 'movie' ? 'film' : 'show'} requests ${el.checked ? 'now go straight through' : 'now wait for you'}`);
          } catch (err) { toast(err.message, true); el.checked = !el.checked; }
        }
      };
      view.onclick = async (e) => {
        const a = e.target.closest('[data-arr]')?.dataset.arr;
        if (!a) return;
        if (e.target.closest('[data-arr-change]')) { $(`#arr-form-${a}`).hidden = false; e.target.closest('.st-row').remove(); return; }
        if (e.target.closest('[data-arr-off]') && confirm(`Disconnect ${cfg[a].name}? Requests will only be marked approved; nothing already in ${cfg[a].name} changes.`)) {
          try { await api(`/api/arr/${a}`, { method: 'DELETE' }); toast('Disconnected'); router(); } catch (err) { toast(err.message, true); }
        }
      };
    },
  },
  {
    id: 'metadata', label: 'Metadata & subtitles',
    load: () => Promise.all([api('/api/settings'), api('/api/autosubs')]),
    render: ([st, a]) => html`${metadataSection(st, { heading: false })}${autoSubsSection(a)}`,
    bind: ([, a]) => { bindMetadataSection(); bindAutoSubs(a); },
  },
  {
    id: 'remote', label: 'Remote access',
    load: () => api('/api/remote'),
    render: (r) => remoteSection(r, { heading: false }),
    bind: () => bindRemoteSection(),
  },
  {
    id: 'backups', label: 'Backups',
    load: () => api('/api/backups'),
    render: (b) => backupsSection(b, { heading: false }),
    bind: () => bindBackupsSection(),
  },
  {
    id: 'server', label: 'Server & updates',
    badge: () => (state.status?.updateAvailable ? '1' : ''),
    load: () => Promise.all([api('/api/status'), api('/api/updates'), api('/api/maintenance')]),
    render: ([s, updates, maint]) => html`
      ${updatesSection(updates)}
      <h2 style="margin:28px 0 12px">This server</h2>
      <div class="panel">
        <dl class="kv">
          <dt>Version</dt><dd>${s.name} ${s.version}</dd>
          <dt>Web address</dt><dd><code>${location.origin}</code>${/^(localhost|127\.)/.test(location.hostname) ? html` <span class="muted">— from phones, TVs and other computers, use this PC's name or IP address instead of “localhost”</span>` : ''}</dd>
          <dt>Active streams</dt><dd>${s.activeTranscodes} converting</dd>
          <dt>Video downloader</dt><dd>${s.downloader.available ? html`yt-dlp ${s.downloader.version} — <a href="#/downloads">Downloads</a>` : 'yt-dlp not installed'}</dd>
          <dt>Data folder</dt><dd><code>${s.dataDir}</code></dd>
          <dt>Space used</dt><dd>${cacheSummary(maint)}</dd>
        </dl>
        <div class="row"><button class="btn small" id="maint-clean">Clean up now</button>
          <span class="muted" style="font-size:13px">Removes cached pictures and files for videos that are gone. Runs by itself once a day${maint.lastCleanup ? ` (last: ${fmtDate(maint.lastCleanup.at)})` : ''}.</span></div>
      </div>
      ${logsSection()}`,
    bind: ([, updates]) => {
      bindUpdatesSection(updates);
      bindLogsSection();
      $('#maint-clean').onclick = async (e) => {
        e.target.disabled = true;
        try { const r = await api('/api/maintenance/cleanup', { method: 'POST' }); toast(r.files ? `Removed ${r.files} file(s), ${fmtSize(r.bytes)}` : 'Nothing to clean up'); router(); } catch (err) { toast(err.message, true); }
      };
    },
  },
];

// Automatic subtitles (lib/autosubs.js), under the OpenSubtitles settings.
function autoSubsSection(a) {
  const names = (codes) => codes.map((c) => LANG_CHOICES.find(([k]) => k === c)?.[1] || c).join(', ');
  return html`<h2 class="st-sub">Automatic subtitles</h2>
    <div class="st-card" id="autosubs">
      ${stToggle('Fetch missing subtitles by themselves', a.configured
        ? `Films and episodes without subtitles in ${a.languages.length ? names(a.languages) : 'your family’s languages'} get them from OpenSubtitles, newest first, within its daily allowance. One made for the same video file is preferred.`
        : 'Connect OpenSubtitles above first.', 'id="as-on"' + (a.configured ? '' : ' disabled'), a.settings.enabled)}
      <label class="st-row"><span class="st-row-label">Languages<span class="st-row-note">${a.settings.languages.length ? 'Set here.' : a.languages.length
        ? `The ones people picked on their Account pages (${names(a.languages)}). Type others to use those instead.` : 'Nobody has picked a subtitle language on their Account page yet; type them here.'}</span></span>
        <input class="input" id="as-langs" value="${a.settings.languages.join(', ')}" placeholder="${a.languages.join(', ') || 'en'}" style="width:160px"></label>
      ${a.settings.enabled ? html`<div class="st-row ${a.paused ? 'warn' : ''}"><span class="st-row-label">${a.today} fetched today · ${a.total} altogether
          <span class="st-row-note">${a.paused ? `Paused until ${fmtDate(a.paused.until)}: ${a.paused.why}` : `${a.missing} still to look for`}${a.last ? ` · last: ${a.last.release}` : ''}</span></span>
        <button class="btn small" id="as-run" ${a.paused ? 'disabled' : ''}>Look now</button></div>` : ''}
    </div>`;
}
function bindAutoSubs() {
  const patch = async (body, msg) => { try { await api('/api/autosubs', { method: 'PATCH', body }); toast(msg); router(); } catch (err) { toast(err.message, true); } };
  if ($('#as-on')) $('#as-on').onchange = (e) => patch({ enabled: e.target.checked }, e.target.checked ? 'Automatic subtitles on' : 'Automatic subtitles off');
  $('#as-langs').onchange = (e) => patch({ languages: e.target.value }, 'Saved');
  if ($('#as-run')) $('#as-run').onclick = async (e) => {
    e.target.disabled = true;
    try { const r = await api('/api/autosubs/run', { method: 'POST' }); toast(r.got ? `Fetched ${r.got}` : 'Nothing new found this time'); router(); } catch (err) { toast(err.message, true); }
  };
}

// One app's card on the Radarr & Sonarr page: connect, then pick the quality profile and folder.
const arrRes = (r) => (!r ? 'any size' : r >= 2160 ? 'up to 4K' : `up to ${r}p`);
function arrCard(a, c, o, monitorOptions) {
  const form = html`<form class="st-card arr-form" data-arr-form="${a}" id="arr-form-${a}" ${c.keySet ? raw('hidden') : ''}>
    <label class="st-row"><span class="st-row-label">Address<span class="st-row-note">On this PC, from Docker: ${c.suggestedUrl}</span></span>
      <input class="input" name="url" value="${c.url || c.suggestedUrl}" required autocomplete="off" spellcheck="false"></label>
    <label class="st-row"><span class="st-row-label">API key<span class="st-row-note">${c.name} → Settings → General → API Key</span></span>
      <input class="input" name="apiKey" ${c.keySet ? raw(`placeholder="Saved (${c.keyHint}): leave empty to keep"`) : raw('required')} autocomplete="off" spellcheck="false"></label>
    <div class="st-row"><span class="st-row-label"></span><button class="btn primary" type="submit">Connect</button></div>
  </form>`;
  if (!c.keySet) return html`<h2 class="st-sub">${c.name} <span style="font-weight:400">· ${a === 'radarr' ? 'films' : 'shows'}</span></h2>${form}`;
  const profile = o?.profiles?.find((p) => p.id === c.profileId);
  const folder = o?.rootFolders?.find((f) => f.path === c.rootFolder);
  return html`<h2 class="st-sub">${c.name} <span style="font-weight:400">· ${a === 'radarr' ? 'films' : 'shows'}${o?.version ? ` · ${o.version}` : ''}</span></h2>
    <div class="st-card" data-arr="${a}">
      <div class="st-row arr-conn ${o?.error ? 'warn' : ''}"><span class="st-row-label">Connected to<span class="st-row-note">${c.url}</span></span>
        <span class="st-row-value">${o?.error ? o.error : c.ready ? '✓ Ready' : 'Pick a profile and folder'}</span>
        <button class="btn small" type="button" data-arr-change>Change</button><button class="btn small danger" type="button" data-arr-off>Disconnect</button></div>
      ${o?.profiles ? html`
        ${stSelect('Quality profile', profile?.maxRes > 1080 ? html`<span style="color:#ffd479">⚠ This profile lets in ${arrRes(profile.maxRes).replace('up to ', '')} files, which are several times bigger. Pick one capped at 1080p to save space.</span>` : 'What every request is added with. You can pick another when you approve one.',
          'data-set="profileId"', html`${!c.profileId ? html`<option value="">Pick one…</option>` : ''}${o.profiles.map((p) => html`<option value="${p.id}" ${p.id === c.profileId ? 'selected' : ''}>${p.name} · ${arrRes(p.maxRes)}</option>`)}`)}
        ${stSelect('Folder', folder ? (folder.library ? `In your “${folder.library}” library` : html`<span style="color:#ffd479">⚠ Not a folder any Marquee library uses, so downloads won't show up. Add it to a library, or pick another.</span>`) : 'Where downloads go',
          'data-set="rootFolder"', html`${!c.rootFolder ? html`<option value="">Pick one…</option>` : ''}${o.rootFolders.map((f) => html`<option value="${f.path}" ${f.path === c.rootFolder ? 'selected' : ''}>${f.path}${f.freeSpace != null ? ` · ${fmtSize(f.freeSpace)} free` : ''}${f.library ? ` · ${f.library}` : ''}</option>`)}`)}
        ${a === 'sonarr' ? stSelect('Seasons', 'Which seasons a show gets when its request goes straight through. You can pick when you approve one yourself.',
          'data-set="monitor"', html`${Object.entries(monitorOptions).map(([k, l]) => html`<option value="${k}" ${k === c.monitor ? 'selected' : ''}>${l}</option>`)}`) : ''}
        ${stToggle('Start looking straight away', `Otherwise it's only added to ${c.name}, and searched for on its own schedule`, 'data-set="search"', c.search)}` : ''}
    </div>${form}`;
}

// Old links (#/settings?section=backups) lead to the page that has that section now.
const SECTION_PAGE = { health: 'overview', problems: 'libraries', updates: 'server', logs: 'server', transcoding: 'playback', intro: 'playback', backups: 'backups' };

async function viewSettings({ params: [pageId], query, seq }) {
  view.onclick = null;
  view.onchange = null;
  if (state.user.role !== 'admin') { location.replace('#/account'); return; }
  if (!pageId && query.get('section') && SECTION_PAGE[query.get('section')]) { location.replace(`#/settings/${SECTION_PAGE[query.get('section')]}`); return; }
  if (state.status?.adminBlockedHere) {
    setView(seq, html`<div class="toolbar"><h1>Settings</h1></div><div class="panel">🔒 Settings are switched to <b>only at home</b> (Settings → Remote access). Open Marquee on your home network to change them.</div>`);
    return;
  }
  const page = SETTINGS_PAGES.find((p) => p.id === (pageId || 'overview')) || SETTINGS_PAGES[0];
  const data = await page.load();
  const nav = html`
    <nav class="st-nav" aria-label="Settings">
      ${SETTINGS_PAGES.map((p) => {
        const badge = p.badge?.() || '';
        return html`<a href="#/settings/${p.id}" class="${p === page ? 'on' : ''}" ${p === page ? raw('aria-current="page"') : ''}>${stIcon(p.id)}<span>${p.label}</span>${badge ? html`<i class="st-badge">${badge}</i>` : ''}</a>`;
      })}
      <span class="st-nav-sep"></span>
      <a href="#/requests">${stIcon('requests')}<span>Requests</span>${state.status?.requestsPending ? html`<i class="st-badge">${state.status.requestsPending}</i>` : ''}</a>
      <a href="#/activity">${stIcon('activity')}<span>Activity</span></a>
    </nav>`;
  if (!setView(seq, html`
    <div class="st">
      ${nav}
      <section class="st-main">
        <header class="st-head"><h1>${page.label}</h1>${page.actions ? html`<div class="row">${page.actions(data)}</div>` : ''}</header>
        ${page.render(data)}
      </section>
    </div>`)) return;
  // Keep the highlighted page in view in the phone's row of tabs.
  $('.st-nav a.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  page.bind?.(data, { query });
}

// "Change" next to something already set up (a key, an address) shows its form.
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-reveal]');
  if (!b) return;
  const target = document.getElementById(b.dataset.reveal);
  if (!target) return;
  target.hidden = false;
  b.closest('.setup-done')?.remove();
  target.querySelector('input, select')?.focus();
});
