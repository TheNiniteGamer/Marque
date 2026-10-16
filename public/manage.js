'use strict';
/* Marquee web client — accounts, users and downloads. Loaded before app.js; the functions here
   use helpers from app.js (html, api, $, toast, ...) only when called. */

// ---------- sign in / first-run setup ----------
function showAuth({ setupRequired = false, message = '' } = {}) {
  closePlayer();
  state.user = null;
  renderSeq++; // drop any in-flight page renders
  clearTimeout(pollTimer);
  document.body.classList.add('auth-mode');
  document.title = 'Sign in · Marquee';
  view.innerHTML = html`
    <div class="auth-wrap">
      <form class="auth-card" id="auth-form">
        <div class="auth-brand"><img src="/icon.svg" alt=""> Marquee</div>
        <h1>${setupRequired ? 'Create your admin account' : 'Sign in'}</h1>
        ${setupRequired ? html`<p class="muted">Welcome! This first account can manage libraries, users and downloads.</p>` : ''}
        <label>Username<input class="input" name="username" autocomplete="username" required autofocus></label>
        <label>Password<input class="input" type="password" name="password" autocomplete="${setupRequired ? 'new-password' : 'current-password'}" required></label>
        ${setupRequired ? html`<label>Confirm password<input class="input" type="password" name="confirm" autocomplete="new-password" required></label>` : ''}
        <div class="form-error" id="auth-error">${message}</div>
        <button class="btn primary" type="submit">${setupRequired ? 'Create account' : 'Sign in'}</button>
      </form>
    </div>`.s;
  $('#auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const err = $('#auth-error');
    if (setupRequired && f.password.value !== f.confirm.value) { err.textContent = 'Passwords do not match'; return; }
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const res = await fetch(setupRequired ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: f.username.value, password: f.password.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Sign in failed');
      state.user = data.user;
      startApp();
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      f.password.select();
    }
  };
}

async function signOut() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  history.replaceState(null, '', '#/');
  showAuth();
}

function renderUserMenu() {
  const u = state.user;
  const root = $('#user-menu');
  if (!u) { root.innerHTML = ''; return; }
  root.innerHTML = html`
    <button class="avatar" id="user-btn" aria-haspopup="true" aria-expanded="false" title="${u.username}">${u.username.slice(0, 1).toUpperCase()}</button>
    <div class="user-pop" id="user-pop" hidden>
      <div class="user-pop-head"><b>${u.username}</b><span class="muted">${u.role === 'admin' ? 'Administrator' : 'User'}</span></div>
      <a href="#/account">Account</a>
      ${u.canDownload ? html`<a href="#/downloads">Downloads</a>` : ''}
      ${u.role === 'admin' ? html`<a href="#/settings">Settings</a>` : ''}
      ${u.role === 'admin' ? html`<a href="#/settings?section=updates" class="upd-link">Update available</a>` : ''}
      ${window.MarqueeAndroid ? html`<button id="switch-server">Switch server</button>` : ''}
      <button id="sign-out">Sign out</button>
    </div>`.s;
  const pop = $('#user-pop');
  $('#user-btn').onclick = (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; $('#user-btn').setAttribute('aria-expanded', String(!pop.hidden)); };
  pop.onclick = (e) => {
    if (e.target.id === 'sign-out') signOut();
    if (e.target.id === 'switch-server') window.MarqueeAndroid?.changeServer();
    pop.hidden = true;
  };
}
document.addEventListener('click', (e) => { const pop = $('#user-pop'); if (pop && !e.target.closest('#user-menu')) pop.hidden = true; });

// ---------- account ----------
async function viewAccount({ seq }) {
  const u = state.user;
  if (!setView(seq, html`
    <div class="toolbar"><h1>Account</h1><button class="btn" id="acct-signout">Sign out</button></div>
    <div class="panel">
      <dl class="kv">
        <dt>Username</dt><dd>${u.username}</dd>
        <dt>Role</dt><dd>${u.role === 'admin' ? 'Administrator' : 'User'}</dd>
        <dt>Libraries</dt><dd>${u.libraries === null ? 'All libraries' : `${u.libraries.length} shared with you`}</dd>
        <dt>Downloads</dt><dd>${u.canDownload ? 'Allowed' : 'Not allowed'}</dd>
      </dl>
    </div>
    <div class="panel form" id="prefs">
      <h2>Playback</h2>
      <label class="check"><input type="checkbox" data-pref="autoplayNext" ${store.get('autoplayNext', true) ? 'checked' : ''}> Play the next episode automatically</label>
      <label class="check"><input type="checkbox" data-pref="subsOn" ${store.get('subsOn', false) ? 'checked' : ''}> Turn on subtitles by default</label>
      <p class="muted" style="margin:0;font-size:13px">These are saved in this browser.</p>
    </div>
    ${window.MarqueeAndroid ? '' : html`<div class="panel">
      <h2 style="margin-top:0">Android app</h2>
      <p class="muted" style="margin:0 0 10px">Watch on your Android phone or tablet with the Marquee app. It plays videos in the phone's own player,
        so more files play without converting. Open this page on your phone and tap the button; Android will ask you to allow
        installing apps from your browser once.</p>
      <a class="btn" href="/downloads/Marquee.apk" download="Marquee.apk">⤓ Get the Android app</a>
    </div>`}
    <form class="panel form" id="pw-form">
      <h2>Change password</h2>
      <label>Current password<input class="input" type="password" name="currentPassword" autocomplete="current-password" required></label>
      <label>New password<input class="input" type="password" name="newPassword" autocomplete="new-password" minlength="6" required></label>
      <label>Confirm new password<input class="input" type="password" name="confirm" autocomplete="new-password" required></label>
      <div class="form-error" id="pw-error"></div>
      <div><button class="btn primary" type="submit">Update password</button></div>
      <p class="muted" style="margin:0;font-size:13px">Changing your password signs you out on your other devices.</p>
    </form>`)) return;
  $('#acct-signout').onclick = signOut;
  $('#prefs').onchange = (e) => { const k = e.target.dataset.pref; if (k) { store.set(k, e.target.checked); toast('Saved'); } };
  $('#pw-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    if (f.newPassword.value !== f.confirm.value) { $('#pw-error').textContent = 'Passwords do not match'; return; }
    try {
      await api('/api/auth/password', { method: 'POST', body: { currentPassword: f.currentPassword.value, newPassword: f.newPassword.value } });
      e.target.reset();
      $('#pw-error').textContent = '';
      toast('Password updated');
    } catch (err) { $('#pw-error').textContent = err.message; }
  };
}

// ---------- users (admin, part of Settings) ----------
function usersSection(users) {
  const libName = (id) => state.libraries.find((l) => l.id === id)?.name;
  return html`
    <div class="row" style="justify-content:space-between;margin:28px 0 12px">
      <h2>Users</h2><button class="btn small" id="add-user">＋ Add user</button>
    </div>
    <div id="user-form-slot"></div>
    ${users.map((u) => html`
      <div class="panel lib-row" data-user="${u.id}">
        <div class="avatar static">${u.username.slice(0, 1).toUpperCase()}</div>
        <div class="lib-info">
          <div style="font-weight:600">${u.username}${u.id === state.user.id ? html` <span class="muted" style="font-weight:400">(you)</span>` : ''}
            <span class="chip" style="margin-left:6px">${u.role === 'admin' ? 'Admin' : 'User'}</span></div>
          <div class="muted" style="font-size:13px">
            ${u.libraries === null ? 'All libraries' : u.libraries.length ? u.libraries.map(libName).filter(Boolean).join(', ') : 'No libraries'}
            · Downloads ${u.canDownload ? 'allowed' : 'off'} · Last sign-in: ${fmtDate(u.lastLoginAt)}
          </div>
        </div>
        <div class="row">
          <button class="btn small" data-uact="edit">Edit</button>
          ${u.id !== state.user.id ? html`<button class="btn small danger" data-uact="delete">Delete</button>` : ''}
        </div>
      </div>`)}`;
}

function bindUsersSection(users) {
  $('#add-user').onclick = () => showUserForm();
  $$('[data-uact]').forEach((b) => {
    b.onclick = async () => {
      const u = users.find((x) => x.id === b.closest('[data-user]').dataset.user);
      if (b.dataset.uact === 'edit') return showUserForm(u);
      if (!confirm(`Delete the user “${u.username}”? Their watch history will be removed.`)) return;
      try { await api(`/api/users/${u.id}`, { method: 'DELETE' }); toast('User deleted'); router(); } catch (err) { toast(err.message, true); }
    };
  });
}

function showUserForm(user = null) {
  const slot = $('#user-form-slot');
  const self = user && user.id === state.user.id;
  slot.innerHTML = html`
    <form class="panel form" id="user-form" style="max-width:none">
      <h2>${user ? `Edit ${user.username}` : 'Add user'}</h2>
      <div class="row" style="align-items:flex-end">
        <label style="flex:1;min-width:180px">Username<input class="input" name="username" required value="${user?.username || ''}" autocomplete="off"></label>
        <label style="flex:1;min-width:180px">${user ? 'New password' : 'Password'}
          <input class="input" type="password" name="password" autocomplete="new-password" ${user ? 'placeholder="Leave blank to keep"' : 'required minlength="6"'}></label>
        <label style="flex:1;min-width:140px">Role
          <select name="role" ${self ? 'disabled' : ''}>
            <option value="user" ${user?.role !== 'admin' ? 'selected' : ''}>User</option>
            <option value="admin" ${user?.role === 'admin' ? 'selected' : ''}>Administrator</option>
          </select></label>
      </div>
      <fieldset class="access" id="access-fields">
        <legend>Library access</legend>
        <label class="check"><input type="radio" name="access" value="all" ${!user || user.libraries === null ? 'checked' : ''}> All libraries (including ones added later)</label>
        <label class="check"><input type="radio" name="access" value="some" ${user && user.libraries !== null ? 'checked' : ''}> Only these:</label>
        <div class="checks">
          ${state.libraries.map((l) => html`<label class="check"><input type="checkbox" name="lib" value="${l.id}" ${user?.libraries?.includes(l.id) ? 'checked' : ''}> ${l.name}</label>`)}
        </div>
        <label class="check"><input type="checkbox" name="canDownload" ${user?.canDownload ? 'checked' : ''}> Can download videos (YouTube downloader)</label>
      </fieldset>
      <p class="muted" id="admin-note" style="margin:0;font-size:13px" hidden>Administrators can see every library and use all features.</p>
      <div class="form-error" id="user-error"></div>
      <div class="row"><button class="btn primary" type="submit">${user ? 'Save' : 'Create user'}</button><button class="btn" type="button" id="user-cancel">Cancel</button></div>
    </form>`.s;
  const form = $('#user-form');
  const f = form.elements;
  const sync = () => {
    const admin = f.role.value === 'admin';
    $('#access-fields').disabled = admin;
    $('#admin-note').hidden = !admin;
    $$('input[name=lib]', form).forEach((c) => { c.disabled = admin || f.access.value !== 'some'; });
  };
  form.onchange = sync;
  sync();
  $('#user-cancel').onclick = () => { slot.innerHTML = ''; };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = {
      username: f.username.value,
      libraries: f.access.value === 'all' ? null : $$('input[name=lib]:checked', form).map((c) => c.value),
      canDownload: f.canDownload.checked,
    };
    if (!self) body.role = f.role.value;
    if (f.password.value) body.password = f.password.value;
    try {
      if (user) await api(`/api/users/${user.id}`, { method: 'PATCH', body });
      else await api('/api/users', { method: 'POST', body });
      toast(user ? 'User updated' : 'User created');
      if (self) state.user = (await api('/api/auth/me')).user;
      router();
    } catch (err) { $('#user-error').textContent = err.message; }
  };
  f.username.focus();
  slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- downloads ----------
const STATUS_LABEL = { queued: 'Queued', running: 'Downloading', done: 'Done', failed: 'Failed', canceled: 'Canceled' };

function jobRow(j) {
  const active = j.status === 'queued' || j.status === 'running';
  const lib = state.libraries.find((l) => l.id === j.libraryId);
  return html`
    <div class="panel dl-row" data-job="${j.id}">
      <div class="dl-main">
        <div class="dl-title" title="${j.url}">${j.title || j.url}</div>
        <div class="muted dl-meta">
          <span class="status ${j.status}">${STATUS_LABEL[j.status] || j.status}</span>
          ${j.status === 'running' ? html`<span>${j.progress.toFixed(1)}%</span>${j.speed ? html`<span>${j.speed}</span>` : ''}${j.eta ? html`<span>ETA ${j.eta}</span>` : ''}` : ''}
          ${j.playlist ? html`<span>Playlist · ${j.files.length} saved${j.status === 'running' && j.current ? ` · now: ${j.current}` : ''}</span>` : ''}
          ${lib ? html`<span>→ ${lib.name}${j.folder ? ` / ${j.folder}` : ''}</span>` : ''}
          ${state.user.role === 'admin' && j.userId !== state.user.id ? html`<span>by ${j.username}</span>` : ''}
          <span>${fmtDate(j.createdAt)}</span>
        </div>
        ${active ? html`<div class="bar"><i style="width:${j.status === 'running' ? j.progress : 0}%"></i></div>` : ''}
        ${j.error ? html`<div class="dl-error">${j.error}</div>` : ''}
      </div>
      <div class="row">
        ${j.status === 'done' && lib ? html`<a class="btn small" href="#/library/${lib.id}">Open library</a>` : ''}
        ${active ? html`<button class="btn small" data-jact="cancel">Cancel</button>` : ''}
        ${j.status === 'failed' || j.status === 'canceled' ? html`<button class="btn small" data-jact="retry">Retry</button>` : ''}
        ${!active ? html`<button class="btn small danger" data-jact="remove" aria-label="Remove from list">✕</button>` : ''}
      </div>
    </div>`;
}

async function viewDownloads({ seq }) {
  if (!state.user.canDownload) return setView(seq, html`<div class="empty"><h2>Downloads aren't enabled for your account</h2><p>Ask an administrator to turn them on.</p></div>`);
  let data = await api('/api/downloads');
  const prefs = store.get('download', { libraryId: null, folder: 'YouTube', quality: 'compatible' });
  if (!data.targets.some((t) => t.id === prefs.libraryId)) prefs.libraryId = data.targets[0]?.id || null;
  const admin = state.user.role === 'admin';

  if (!setView(seq, html`
    <div class="toolbar"><h1>Downloads</h1>
      ${admin && data.available ? html`<span class="muted" style="font-size:13px">yt-dlp ${data.version}</span><button class="btn small" id="ytdlp-update">Update yt-dlp</button>` : ''}
    </div>
    ${!data.available ? html`<div class="error-box" style="margin-bottom:16px">The video downloader (yt-dlp) isn't installed on the server. The Docker image includes it; for a manual install see the README.</div>` : ''}
    ${!data.targets.length ? html`<div class="panel">To download videos you need a <b>Movies</b>-type library to save them into.
        ${admin ? html`<a href="#/settings?add=1">Create one</a> — for example a library named “YouTube”.` : 'Ask an administrator to share one with you.'}</div>` : html`
    <form class="panel form dl-form" id="dl-form" style="max-width:none">
      <label>Video or playlist URL
        <input class="input" name="url" type="url" required placeholder="https://www.youtube.com/watch?v=…" autocomplete="off"></label>
      <div class="row" style="align-items:flex-end">
        <label style="flex:1;min-width:160px">Save to library
          <select name="libraryId">${data.targets.map((t) => html`<option value="${t.id}" ${t.id === prefs.libraryId ? 'selected' : ''}>${t.name}</option>`)}</select></label>
        <label style="flex:1;min-width:140px">Folder inside library
          <input class="input" name="folder" value="${prefs.folder}" placeholder="(library root)"></label>
        <label style="flex:1;min-width:220px">Quality
          <select name="quality">${data.qualities.map((q) => html`<option value="${q.id}" ${q.id === prefs.quality ? 'selected' : ''}>${q.label}</option>`)}</select></label>
      </div>
      <label class="check"><input type="checkbox" name="playlist"> If the link is part of a playlist, download the whole playlist</label>
      <div class="form-error" id="dl-error"></div>
      <div class="row"><button class="btn primary" type="submit" ${data.available ? '' : 'disabled'}>⤓ Download</button>
        <span class="muted" style="font-size:13px">Only download videos you have the right to save. Downloads appear in the library automatically when finished.</span></div>
    </form>`}
    <h2 style="margin:24px 0 12px">Queue & history</h2>
    <div id="dl-jobs"></div>`)) return;

  const renderJobs = () => {
    const box = $('#dl-jobs');
    if (!box) return;
    box.innerHTML = data.jobs.length ? data.jobs.map((j) => jobRow(j).s).join('') : html`<div class="panel muted">Nothing downloaded yet.</div>`.s;
  };
  renderJobs();

  // Poll while anything is in flight and we're still on this page.
  let timer;
  const poll = async () => {
    clearTimeout(timer);
    if (seq !== renderSeq) return;
    try { data = await api('/api/downloads'); } catch { return; }
    if (seq !== renderSeq) return;
    renderJobs();
    const busy = data.jobs.some((j) => j.status === 'queued' || j.status === 'running');
    timer = setTimeout(poll, busy ? 1500 : 10000);
  };
  timer = setTimeout(poll, 1500);

  const form = $('#dl-form');
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = form.elements;
      const body = { url: f.url.value, libraryId: f.libraryId.value, folder: f.folder.value, quality: f.quality.value, playlist: f.playlist.checked };
      store.set('download', { libraryId: body.libraryId, folder: body.folder, quality: body.quality });
      try {
        await api('/api/downloads', { method: 'POST', body });
        f.url.value = '';
        $('#dl-error').textContent = '';
        toast('Added to the download queue');
        poll();
      } catch (err) { $('#dl-error').textContent = err.message; }
    };
  }
  if ($('#ytdlp-update')) {
    $('#ytdlp-update').onclick = async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Updating…';
      try {
        const r = await api('/api/downloads/update-tool', { method: 'POST' });
        toast(r.ok ? `yt-dlp is up to date (${r.version})` : `Update failed: ${r.output}`, !r.ok);
      } catch (err) { toast(err.message, true); }
      router();
    };
  }
  $('#dl-jobs').onclick = async (e) => {
    const b = e.target.closest('[data-jact]');
    if (!b) return;
    const id = b.closest('[data-job]').dataset.job;
    const act = b.dataset.jact;
    try {
      if (act === 'remove') await api(`/api/downloads/${id}`, { method: 'DELETE' });
      else await api(`/api/downloads/${id}/${act}`, { method: 'POST' });
      poll();
    } catch (err) { toast(err.message, true); }
  };
}
