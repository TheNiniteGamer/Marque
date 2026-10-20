'use strict';
/* Marquee web client — Settings (admins). A calm, Netflix-style account area: a menu of pages on the
   left (a row of tabs on phones), each page made of cards. Every page lives in SETTINGS_PAGES:
   to add one, add an entry with what it loads, how it looks and what its buttons do.
   Loaded before app.js; helpers from app.js, extras.js and manage.js are used only when called. */

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
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
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
      const homeOn = ['hero', 'top10', 'watchlist', 'recent', 'because', 'liked'].filter((k) => rows[k]).length + (rows.genres ? 1 : 0) + (rows.collections ? 1 : 0);
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
    id: 'users', label: 'Users',
    load: () => Promise.all([api('/api/users'), refreshLibraries()]),
    actions: () => html`<button class="btn small primary" id="add-user">＋ Add user</button>`,
    render: ([users]) => usersSection(users, { heading: false }),
    bind: ([users]) => bindUsersSection(users),
  },
  {
    id: 'home', label: 'Home screen',
    load: () => api('/api/settings'),
    render: (st) => {
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
          ${count('collections', 'Collection rows', 'The first collections, in the order you arranged them')}
          ${count('genres', 'Genre rows', 'The biggest genres in your libraries')}
        </div>`;
    },
    bind: () => {
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
    render: ([t, intro, settings]) => transcodingSection(t, intro, settings),
    bind: () => bindTranscodingSection(),
  },
  {
    id: 'metadata', label: 'Metadata & subtitles',
    load: () => api('/api/settings'),
    render: (st) => metadataSection(st, { heading: false }),
    bind: () => bindMetadataSection(),
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
