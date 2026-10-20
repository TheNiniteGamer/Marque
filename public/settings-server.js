'use strict';
/* Marquee web client — settings panels about the server: cache sizes, updates, remote access,
   backups and the health check, activity and logs. Helpers from app.js are used only when called. */

// ---------- settings ----------
function cacheSummary(m) {
  const labels = { database: 'Database', artwork: 'Artwork', thumbs: 'Thumbnails', trickplay: 'Seek previews', fingerprints: 'Intro detection',
    subtitles: 'Subtitle copies', downloadedSubtitles: 'Downloaded subtitles', conversions: 'Converting now', offline: 'Copies for phone downloads', previews: 'Preview clips', keyframes: 'Keyframe lists' };
  const parts = Object.entries(labels).filter(([k]) => m.sizes[k] > 0).map(([k, l]) => `${l} ${fmtSize(m.sizes[k])}`);
  return parts.length ? parts.join(' · ') : 'Nothing yet';
}

// ---------- Settings → Updates ----------
const shortSha = (s) => (s ? s.slice(0, 7) : '');
function updatesSection(u) {
  const c = u.check;
  const h = u.helper;
  const b = u.build;
  const updating = h.state === 'updating';
  const ready = h.state === 'ready';
  const ago = (t) => (t ? fmtDate(t) : 'never');
  let summary;
  if (updating) summary = html`<div class="upd-state busy"><span class="spin"></span> ${h.message || 'Updating…'}</div>`;
  else if (ready) {
    summary = html`<div class="upd-state new">New version ready: Marquee restarts into it once nobody's watching</div>
      <div class="muted" style="font-size:13px">${u.watching ? `${u.watching} ${u.watching === 1 ? 'person is' : 'people are'} watching right now.` : 'Nobody is watching: restarting in a moment.'}
        Restarting takes about a minute; anyone watching then is reconnected where they were.</div>`;
  }
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
  const canApply = b.install === 'docker' && h.alive && !updating && !ready && (c?.status === 'available' || c?.status === 'unknown');

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
          <button class="btn small" id="upd-check" ${updating || ready ? 'disabled' : ''}>↻ Check now</button>
          ${canApply ? html`<button class="btn primary small" id="upd-apply">⤓ Update</button>` : ''}
          ${ready ? html`<button class="btn primary small" id="upd-restart">Restart now anyway</button>` : ''}
        </div>
      </div>
      ${c?.status === 'available' && c.changes.length ? html`<div class="changes"><b>What's new</b>
        <ul>${c.changes.map((x) => html`<li class="${x.significant ? 'significant' : ''}"><a href="${x.url || '#'}" target="_blank" rel="noopener"><code>${x.sha}</code></a> ${x.significant ? html`<span class="sig-tag">Significant update</span> ` : ''}${x.message}
          ${x.date ? html`<span class="muted">· ${new Date(x.date).toLocaleDateString()}</span>` : ''}</li>`)}</ul></div>` : ''}
      ${updating || h.state === 'failed' ? html`<pre class="upd-log ${h.state === 'failed' ? 'bad' : ''}">${h.state === 'failed' ? `Update failed: ${h.message}\n\n` : ''}${(h.log || []).join('\n')}</pre>` : ''}
      ${h.state === 'done' && h.finishedAt ? html`<div class="muted" style="font-size:13px">Last update finished ${fmtDate(h.finishedAt)} — ${h.message}.</div>` : ''}
      <div>${how}</div>
      <label class="check"><input type="checkbox" id="upd-auto" ${u.autoCheck ? 'checked' : ''}> Check for updates automatically (twice a day)</label>
      ${b.install === 'docker' ? html`<label class="check"><input type="checkbox" id="upd-auto-install" ${u.autoInstall ? 'checked' : ''}> Install updates by itself at night (2–5 am), when nobody's watching</label>` : ''}
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
    $('#upd-apply').onclick = () => {
      const m = openModal({
        title: 'Update Marquee?',
        body: html`<p>The new version downloads and builds while Marquee keeps running. It then restarts into it (about a minute)
          ${u.watching ? html`once nobody's watching — <b>${u.watching} ${u.watching === 1 ? 'person is' : 'people are'}</b> right now` : 'straight away, as nobody is watching'}.</p>
        <p class="muted" style="font-size:13px">Restarting straight away pauses anyone watching instead; their player reconnects and carries on where it was.</p>
        <div class="row" style="justify-content:flex-end;margin-top:16px">
          <button class="btn" id="upd-go-now">Update and restart now</button>
          <button class="btn primary" id="upd-go">Update</button>
        </div>`,
      });
      const go = async (when) => {
        m.close();
        try { await api('/api/updates/apply', { method: 'POST', body: { when } }); toast('Update requested — the helper will start in a few seconds'); watchUpdate(); router(); } catch (err) { toast(err.message, true); }
      };
      $('#upd-go', m.el).onclick = () => go('idle');
      $('#upd-go-now', m.el).onclick = () => go('now');
    };
  }
  if ($('#upd-restart')) {
    $('#upd-restart').onclick = async () => {
      if (u.watching && !confirm(`Restart now? ${u.watching} ${u.watching === 1 ? 'person is' : 'people are'} watching; their player pauses for about a minute, then carries on.`)) return;
      try { await api('/api/updates/restart-now', { method: 'POST' }); toast('Restarting into the new version…'); watchUpdate(); } catch (err) { toast(err.message, true); }
    };
  }
  if ($('#upd-auto-install')) {
    $('#upd-auto-install').onchange = async (e) => {
      try { await api('/api/settings', { method: 'PATCH', body: { updateAutoInstall: e.target.checked } }); toast('Saved'); } catch (err) { toast(err.message, true); }
    };
  }
  $('#upd-auto').onchange = async (e) => {
    try { await api('/api/settings', { method: 'PATCH', body: { updateCheck: e.target.checked } }); toast('Saved'); } catch (err) { toast(err.message, true); }
  };
  if (u.helper.state === 'updating' || u.helper.state === 'ready' || u.helper.pending) watchUpdate();
}

// Follow an update: refresh the panel while it runs, then wait out the restart and reload into the new version.
let updateWatch = null;
function watchUpdate() {
  if (updateWatch) return;
  let sawUpdating = false;
  updateWatch = setInterval(async () => {
    try {
      const u = await fetch('/api/updates').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));
      if (u.helper.state === 'updating' || u.helper.state === 'ready') sawUpdating = true;
      if (parseHash().path.startsWith('/settings') && !$('.modal-backdrop')) {
        const panel = $('#updates-panel');
        if (panel) { const fresh = document.createElement('div'); fresh.innerHTML = updatesSection(u).s; panel.replaceWith(fresh.querySelector('#updates-panel')); bindUpdatesSection(u); }
      }
      if (sawUpdating && u.helper.state !== 'updating' && u.helper.state !== 'ready') {
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
  const link = $('#user-pop a[href="#/settings"]');
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
function remoteSection(r, { heading = true } = {}) {
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
      ${helpText(html`To watch from anywhere, the easiest way is <b>Tailscale</b> (free).
        Create an account, paste an auth key into <code>TS_AUTHKEY</code> in the <code>.env</code> file next to <code>start-marquee.bat</code>,
        then run <b>start-marquee.bat</b> again. Your phone also needs the Tailscale app. The README has step-by-step instructions, including a Cloudflare Tunnel option.`, 'How do I watch away from home?')}`;
  }
  return html`
    ${heading ? html`<h2 style="margin:28px 0 12px">Remote access</h2>` : ''}
    <div class="panel" id="remote-panel">${body}
      ${r.viaRemoteNow ? html`<p class="muted" style="font-size:13px;margin:10px 0 0">🔒 You're connected remotely over HTTPS right now.</p>` : ''}
      <label class="check" style="margin-top:12px"><input type="checkbox" id="admin-home-only" ${r.adminAtHomeOnly ? 'checked' : ''}>
        Admin settings only at home</label>
      ${helpText('Away from home, admins can still watch, but Settings, users and the other admin pages only work on your home network, so a leaked admin password can’t be used to change anything from outside. Switch it on from home.')}
    </div>`;
}

function bindRemoteSection() {
  const b = $('#copy-remote');
  if (b) b.onclick = () => navigator.clipboard?.writeText(b.dataset.url).then(() => toast('Address copied'), () => toast(b.dataset.url));
  const home = $('#admin-home-only');
  if (home) {
    home.onchange = async () => {
      try { await api('/api/remote', { method: 'PATCH', body: { adminAtHomeOnly: home.checked } }); toast(home.checked ? 'Admin settings now only work at home' : 'Admin settings work from anywhere again'); } catch (err) { toast(err.message, true); home.checked = !home.checked; }
    };
  }
}

// ---------- Settings → Backups ----------
const KIND = { auto: 'Automatic', manual: 'Manual', 'pre-restore': 'Before restore' };
// ---------- health check ----------
const HEALTH_MARK = { ok: '✓', info: 'ℹ', warn: '!', bad: '✕' };
function healthSection(h) {
  const problems = h.checks.filter((c) => c.level !== 'ok');
  const fine = h.checks.filter((c) => c.level === 'ok');
  const row = (c) => html`<div class="health-row ${c.level}"><span class="health-mark">${HEALTH_MARK[c.level]}</span>
    <div><div class="health-title">${c.link ? html`<a href="${c.link}">${c.title}</a>` : c.title}</div>${c.detail ? html`<div class="muted health-detail">${c.detail}</div>` : ''}</div></div>`;
  const head = { ok: '✓ Everything looks fine', info: '✓ Fine, with a suggestion or two', warn: 'Something needs a look', bad: 'Something is wrong' }[h.level];
  return html`
    <div class="panel health ${h.level}" id="health">
      <div class="row" style="justify-content:space-between">
        <div><b class="health-head">${head}</b> <span class="muted" style="font-size:13px">Health check · ${fmtDate(h.at)}</span></div>
        <button class="btn small" id="health-run">Check now</button>
      </div>
      ${problems.map(row)}
      ${fine.length ? html`<details class="health-fine"><summary class="muted">${fine.length} check${fine.length === 1 ? '' : 's'} passed</summary>${fine.map(row)}</details>` : ''}
    </div>`;
}

function bindHealthSection() {
  const b = $('#health-run');
  if (!b) return;
  b.onclick = async () => {
    b.disabled = true; b.textContent = 'Checking…';
    try { const h = await api('/api/health-check?run=1'); $('#health').outerHTML = healthSection(h).s; bindHealthSection(); } catch (err) { toast(err.message, true); b.disabled = false; }
  };
}

function backupsSection(b, { heading = true } = {}) {
  const s = b.settings;
  return html`
    ${heading ? html`<h2 style="margin:28px 0 12px" id="backups">Backups</h2>` : ''}
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
      <div class="bk-copy">
        <div><b>Also keep a copy somewhere else</b></div>
        ${helpText('Another drive, a network share, or a OneDrive / Google Drive / Dropbox folder (which then copies it off this PC), so the backups survive if this PC’s disk dies.')}
        ${b.copy ? html`
          <div class="row bk-settings">📁 <code>${b.copy.label}</code>
            <span class="bk-keep muted">keep the last <input class="input" type="number" id="bk-copy-keep" min="1" max="365" value="${b.copy.keep}" aria-label="Number of copies to keep there"> there</span>
            <button class="btn small" id="bk-copy-pick">Change…</button><button class="btn small" id="bk-copy-now">Copy the latest now</button><button class="btn small" id="bk-copy-off">Stop copying</button></div>
          <div class="${b.copy.last && !b.copy.last.ok ? 'bk-copy-bad' : 'muted'}" style="font-size:13px">${b.copy.last ? (b.copy.last.ok
            ? `✓ Last copied ${fmtDate(b.copy.last.at)} · ${b.copy.count} backup${b.copy.count === 1 ? '' : 's'} there`
            : `✕ The last copy failed (${fmtDate(b.copy.last.at)}): ${b.copy.last.error}`) : 'Nothing copied yet: each backup from now on is.'}</div>`
        : html`<div class="row bk-settings"><button class="btn small" id="bk-copy-pick">Choose a folder…</button></div>`}
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
  $('#bk-copy-pick').onclick = async () => {
    const dir = await pickFolder();
    if (!dir) return;
    try { await api('/api/backups/settings', { method: 'PATCH', body: { copyTo: dir } }); toast('Backups will also be copied there'); } catch (err) { toast(err.message, true); }
    router();
  };
  if ($('#bk-copy-keep')) $('#bk-copy-keep').onchange = (e) => patch({ copyKeep: Number(e.target.value) });
  if ($('#bk-copy-off')) $('#bk-copy-off').onclick = async () => { await patch({ copyTo: '' }); router(); };
  if ($('#bk-copy-now')) {
    $('#bk-copy-now').onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = 'Copying…';
      try { await api('/api/backups/copy', { method: 'POST' }); toast('Copied'); } catch (err) { toast(err.message, true); }
      router();
    };
  }
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

// ---------- activity (admins): who is watching what right now ----------
async function viewActivity({ seq }) {
  if (state.user.role !== 'admin') { location.replace('#/'); return; }
  // How each one is playing, and why it's being converted when it is.
  const howLabel = (s) => {
    const c = s.conversion;
    const by = c?.encoderName ? ` on ${c.encoderName}` : '';
    if (s.mode === 'cast') return { text: 'Casting to a TV', ok: true };
    if (s.mode === 'direct') return { text: 'Plays as it is', ok: true };
    if (s.quality === 'source' || c?.quality === 'source') return { text: 'Original picture · only the sound converted', ok: true };
    if (s.mode === 'hls' || c?.kind === 'hls') return { text: `Converting${by} · adaptive ${s.quality === 'auto' || !s.quality ? (c?.quality ? `(${c.quality})` : '') : s.quality}`.trim() };
    if (c) return { text: c.encoder ? `Converting${by}` : 'Converting the sound only' };
    return { text: s.mode === 'transcode' ? 'Converting' : 'Playing', ok: s.mode !== 'transcode' };
  };
  const title = (it) => (!it ? 'Unknown video' : it.type === 'episode' ? `${it.showTitle} · ${epLabel(it)} — ${it.title}` : it.title);
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} hr ago`; };
  const who = (name) => html`<span class="act-avatar" style="background:${avatarColor(name)}">${String(name).slice(0, 1).toUpperCase()}</span>`;
  const streamCard = (s) => {
    const how = howLabel(s);
    return html`<div class="panel act-card">
      <a class="act-art" href="#/item/${s.itemId}">${s.item ? html`<img src="${artUrl(s.item.type === 'episode' ? 'thumb' : 'backdrop', s.item)}" alt="">` : ''}
        ${s.item?.duration ? html`<span class="act-bar"><i style="width:${pct(s.position, s.item.duration)}%"></i></span>` : ''}</a>
      <div class="act-info">
        <div class="act-who">${who(s.user)}<b>${s.user}</b><span class="muted">· ${s.device}${s.remote ? ' · away from home' : ''}</span></div>
        <a class="act-title" href="#/item/${s.itemId}">${title(s.item)}</a>
        <div class="act-state">${s.paused ? '❚❚ Paused' : '▶ Playing'} · ${s.item?.duration ? `${fmtClock(s.position)} of ${fmtClock(s.item.duration)}` : fmtClock(s.position)}</div>
        <div class="act-how ${how.ok ? 'ok' : ''}">${how.text}${s.why ? html`<span class="muted"> · because of ${s.why}</span>` : ''}</div>
        <button class="btn small act-stop" data-stop="${s.key}" data-who="${s.user}" ${s.stopping ? 'disabled' : ''}>${s.stopping ? 'Stopping…' : 'Stop'}</button>
      </div>
    </div>`;
  };
  const optimizeCard = (o) => {
    if (!o?.settings.enabled && !o?.running) return '';
    const r = o.running;
    const words = { held: 'Paused by you', tonight: `Stopped for tonight, until ${o.hold ? fmtTime(o.hold.until) : ''}`, paused: 'Paused while someone watches', converting: 'Converting',
      waiting: `Waiting for ${o.settings.start}`, done: 'Everything chosen has a copy', full: 'Paused: the space allowed is used up', starting: 'Starting…', moving: 'Moving the copies' };
    return html`<div class="panel act-job">
      <div class="act-job-head"><b>Overnight conversions</b><span class="muted">${words[o.state] || ''}</span>
        <span class="act-job-btns">${optimizeButtons(o)}</span></div>
      ${r ? html`<div class="act-job-line"><span>${r.title}</span><span class="muted">${Math.round(r.progress * 100)}%${r.secondsLeft != null ? ` · ${fmtEta(r.secondsLeft)}` : ''}</span></div>
        <div class="meter"><span style="width:${r.progress * 100}%"></span></div>` : ''}
      <div class="muted act-job-note">${o.queue ? `${o.queue} waiting` : 'Nothing waiting'} · ${o.counts.done} made so far · <a href="#/settings/convert">Settings</a></div>
    </div>`;
  };
  const render = (a) => html`
    <div class="toolbar"><h1>Activity<span class="count">${a.streams.length}</span></h1>
      <span class="muted">Updates every few seconds</span></div>
    <div class="activity-stats">
      <div class="panel"><div class="muted">Server CPU</div><b>${a.cpu.percent}%</b><div class="meter"><span style="width:${a.cpu.percent}%"></span></div><div class="muted">${a.cpu.cores} cores</div></div>
      <div class="panel"><div class="muted">Memory in use</div><b>${Math.round((1 - a.memory.free / a.memory.total) * 100)}%</b><div class="meter"><span style="width:${(1 - a.memory.free / a.memory.total) * 100}%"></span></div><div class="muted">${fmtSize(a.memory.total)} total</div></div>
      <div class="panel"><div class="muted">Converting video with</div><b>${a.encoder.name}</b><div class="muted">${a.streams.filter((s) => s.conversion?.encoder).length + a.others.filter((o) => o.encoder).length} video conversion(s) for viewers</div></div>
    </div>
    <h2 class="act-h">Watching now</h2>
    ${a.streams.length ? html`<div class="act-grid">${a.streams.map(streamCard)}</div>` : html`<div class="panel muted">Nobody is watching right now.</div>`}
    ${a.others.length ? html`<h2 class="act-h">Other conversions</h2>
      <p class="muted act-note">Streams with no player reporting back, for example a Chromecast fetching the video itself.</p>
      ${a.others.map((o) => html`<div class="panel act-line">${title(o.item)} <span class="muted">· ${o.user || 'someone'} · ${o.kind === 'hls' ? `adaptive ${o.quality}` : 'converting'}${o.encoderName ? ` on ${o.encoderName}` : ''}</span></div>`)}` : ''}
    <h2 class="act-h">Background work</h2>
    <p class="muted act-note">What the server does by itself. It waits while anyone is watching.</p>
    ${optimizeCard(a.optimize)}
    ${a.background.length ? a.background.map((b) => html`<div class="panel act-line">${b.what}${b.title ? html` <span class="muted">· ${b.title}</span>` : ''}${b.gpu ? html` <span class="muted">· on the graphics card</span>` : ''}</div>`)
      : html`<div class="panel muted act-line">Nothing else running.</div>`}
    <h2 class="act-h">The last 24 hours</h2>
    ${a.recent.length ? html`<div class="panel act-recent">${a.recent.map((r) => html`<div class="act-recent-row">${who(r.user)}<b>${r.user}</b>
        <a href="#/item/${r.item.id}">${title(r.item)}</a>
        <span class="muted">${r.watched ? 'watched' : `stopped at ${fmtClock(r.position)}`} · ${ago(r.at)}</span></div>`)}</div>`
      : html`<div class="panel muted">Nothing watched in the last day.</div>`}`;
  const bind = () => {
    bindOptimizeButtons(view, () => load());
    for (const b of $$('[data-stop]', view)) {
      b.onclick = async () => {
        if (!confirm(`Stop ${b.dataset.who}'s video? Their player stops within a few seconds and tells them you stopped it.`)) return;
        b.disabled = true;
        try { await api('/api/activity/stop', { method: 'POST', body: { key: b.dataset.stop } }); toast('Stopping it'); } catch (err) { toast(err.message, true); }
        load();
      };
    }
  };
  const load = async () => {
    const a = await api('/api/activity');
    if (parseHash().path !== '/activity') return false;
    // (Not while a button is being pressed or a dialog is open.)
    if (!document.querySelector('.modal-backdrop')) { view.innerHTML = render(a).s; bind(); }
    return true;
  };
  const a = await api('/api/activity');
  if (!setView(seq, render(a))) return;
  bind();
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

// ---------- overnight conversions: pause, carry on, stop for tonight (Settings and Activity) ----------
function optimizeButtons(o) {
  if (!o.settings.enabled) return '';
  if (o.hold) return html`<button class="btn small" data-opt-act="resume">${o.hold.kind === 'pause' ? 'Carry on' : 'Start again'}</button>`;
  return html`${o.running ? html`<button class="btn small" data-opt-act="pause" title="It waits where it is until you carry on">Pause</button>` : ''}
    ${o.running || o.queue ? html`<button class="btn small" data-opt-act="stop-tonight" title="Stop the one under way and make no more until tomorrow night">Stop for tonight</button>` : ''}
    ${o.queue && !o.running ? html`<button class="btn small" data-opt-act="start-now" title="Don't wait for the night: run for the next 6 hours">Start now</button>` : ''}`;
}
function bindOptimizeButtons(root, done) {
  const said = { pause: 'Paused', resume: 'Carrying on', 'stop-tonight': 'Stopped until tomorrow night', 'start-now': 'Converting for the next 6 hours' };
  for (const b of $$('[data-opt-act]', root)) {
    b.onclick = async () => {
      b.disabled = true;
      try { await api(`/api/optimize/${b.dataset.optAct}`, { method: 'POST' }); toast(said[b.dataset.optAct]); } catch (err) { toast(err.message, true); }
      done();
    };
  }
}
