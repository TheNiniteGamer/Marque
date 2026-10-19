'use strict';
/* Marquee web client — accounts, users and downloads. Loaded before app.js; the functions here
   use helpers from app.js (html, api, $, toast, ...) only when called. */

// Kids profiles: the oldest ratings a person may watch (same choices as the server's lib/ratings.js).
const MATURITY = [[7, 'Little kids (G, TV-Y7)'], [10, 'Kids (PG, TV-PG)'], [13, 'Older kids (PG-13)'], [16, 'Teens (TV-14, 15)']];
const maturityLabel = (age) => (MATURITY.find(([a]) => a === age) || [age, `up to age ${age}`])[1];

// ---------- sign in / first-run setup ----------
function showAuth({ setupRequired = false, message = '' } = {}) {
  closePlayer();
  state.user = null;
  renderBell(null);
  renderSeq++; // drop any in-flight page renders
  clearTimeout(pollTimer);
  document.body.classList.add('auth-mode');
  document.title = 'Sign in · Marquee';
  // On a TV, linking with a code is the way in; the password form is there behind a button.
  const byCode = tv.on && !setupRequired;
  view.innerHTML = html`
    <div class="auth-wrap">
      <form class="auth-card" id="auth-form" ${byCode ? 'hidden' : ''}>
        <div class="auth-brand">MARQUEE</div>
        <h1>${setupRequired ? 'Create your admin account' : 'Sign in'}</h1>
        ${setupRequired ? html`<p class="muted">Welcome! This first account can manage libraries, users and downloads.</p>` : ''}
        <label>Username<input class="input" name="username" autocomplete="username" required ${byCode ? '' : 'autofocus'}></label>
        <label>Password<input class="input" type="password" name="password" autocomplete="${setupRequired ? 'new-password' : 'current-password'}" ${setupRequired ? raw('minlength="8"') : ''} required></label>
        ${setupRequired ? html`<label>Confirm password<input class="input" type="password" name="confirm" autocomplete="new-password" required></label>` : ''}
        <div class="form-error" id="auth-error">${message}</div>
        <button class="btn primary" type="submit">${setupRequired ? 'Create account' : 'Sign in'}</button>
      </form>
    </div>`.s;
  if (byCode) tvCodeSignIn();
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

// On a TV, typing a password with a remote is slow: the TV shows a code to enter on a phone instead.
async function tvCodeSignIn() {
  const box = document.createElement('div');
  box.className = 'auth-card tv-code';
  box.innerHTML = html`<div class="auth-brand">MARQUEE</div><p class="muted">Getting a code…</p>`.s;
  $('.auth-wrap').prepend(box);
  const form = $('#auth-form');
  const usePassword = () => {
    form.hidden = false;
    box.querySelector('#tv-use-password')?.remove();
    form.elements.username.focus();
  };
  let stop = false;
  const ask = async () => {
    let pair;
    try { pair = await (await fetch('/api/devices/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: /MarqueeTV/.test(navigator.userAgent) ? 'Android TV' : 'TV browser' }) })).json(); } catch { /* below */ }
    if (!pair?.code) { box.remove(); usePassword(); return; } // no code to be had (e.g. too many tries): passwords still work
    const passwordShown = !form.hidden;
    box.innerHTML = html`<div class="auth-brand">MARQUEE</div>
      <h1>Link this TV</h1>
      <ol class="tv-steps muted">
        <li>On your phone or computer, open <b>${location.host}/#/link</b><br>(or Marquee → <b>Account</b> → <b>Watch on a TV</b>)</li>
        <li>Enter this code:</li>
      </ol>
      <div class="tv-code-value" aria-live="polite">${pair.code.slice(0, 3)} ${pair.code.slice(3)}</div>
      <p class="muted" style="font-size:13px">This TV signs in by itself a few seconds later, and stays signed in.</p>
      ${passwordShown ? '' : html`<button class="btn" type="button" id="tv-use-password">Sign in with a password instead</button>`}`.s;
    box.querySelector('#tv-use-password')?.addEventListener('click', usePassword);
    if (!passwordShown) box.querySelector('#tv-use-password').focus();
    const expires = Date.now() + pair.expiresIn * 1000 - 5000;
    const poll = async () => {
      if (stop || !document.contains(box)) return;
      if (Date.now() > expires) return ask(); // a fresh code
      const r = await fetch(`/api/devices/pair/${pair.id}?cookie=1`).then((x) => x.json()).catch(() => null);
      if (r?.status === 'linked') { stop = true; location.reload(); return; }
      setTimeout(poll, 3000);
    };
    setTimeout(poll, 3000);
  };
  ask();
}

async function signOut() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  history.replaceState(null, '', '#/');
  showAuth();
}

function renderUserMenu() {
  const u = state.user;
  const root = $('#user-menu');
  document.body.classList.toggle('kids', !!u && u.maxAge != null); // the "KIDS" label by the logo
  if (!u) { root.innerHTML = ''; return; }
  root.innerHTML = html`
    <button class="avatar" id="user-btn" aria-haspopup="true" aria-expanded="false" title="${u.username}" aria-label="${u.username}: account menu" style="background:${avatarColor(u.username)}">${u.username.slice(0, 1).toUpperCase()}</button>
    <div class="user-pop" id="user-pop" hidden>
      <div class="user-pop-head"><b>${u.username}</b><span class="muted">${u.role === 'admin' ? 'Administrator' : 'User'}</span></div>
      ${tv.on ? html`<a href="#/account">Settings</a>` : html`<a href="#/account">Account</a>
      <a href="#/requests">Requests</a>
      ${phoneDownloads() ? html`<button id="phone-downloads">Downloads on this phone</button>` : ''}
      ${u.canDownload ? html`<a href="#/downloads">${phoneDownloads() ? 'Video downloader' : 'Downloads'}</a>` : ''}
      ${u.role === 'admin' ? html`<a href="#/activity">Activity</a>` : ''}
      ${u.role === 'admin' ? html`<a href="#/settings">Settings</a>` : ''}
      ${u.role === 'admin' ? html`<a href="#/settings?section=updates" class="upd-link">Update available</a>` : ''}`}
      <button id="switch-profile">Switch profile</button>
      ${window.MarqueeAndroid ? html`<button id="switch-server">Switch server</button>` : ''}
      <button id="sign-out">Sign out</button>
    </div>`.s;
  const pop = $('#user-pop');
  $('#user-btn').onclick = (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; $('#user-btn').setAttribute('aria-expanded', String(!pop.hidden)); };
  pop.onclick = (e) => {
    if (e.target.id === 'sign-out') signOut();
    if (e.target.id === 'switch-server') window.MarqueeAndroid?.changeServer();
    if (e.target.id === 'switch-profile') showProfilePicker();
    if (e.target.id === 'phone-downloads') window.MarqueeAndroid.openDownloads();
    pop.hidden = true;
  };
}
document.addEventListener('click', (e) => { const pop = $('#user-pop'); if (pop && !e.target.closest('#user-menu')) pop.hidden = true; });

// ---------- on a TV: a short Settings page ----------
// A TV gets only what's worth doing with a remote. Passwords, PINs, linking TVs, libraries, users,
// downloads and the rest are in Marquee on a phone or computer.
const TV_ELSEWHERE = /^\/(settings|downloads|activity|link)$/;
function viewTvElsewhere({ seq }) {
  setView(seq, html`<div class="tv-settings">
    <h1>On a phone or computer</h1>
    <p class="muted">This part of Marquee is easier with a keyboard: open <b>${location.host}</b> on your phone or computer.</p>
    <div class="row"><a class="btn primary" href="#/account">TV settings</a><a class="btn" href="#/">Home</a></div>
  </div>`);
}

function tvToggle(attr, key, on, label) {
  return html`<button class="tv-toggle" type="button" ${attr}="${key}" aria-pressed="${on ? 'true' : 'false'}"><span>${label}</span><b>${on ? 'On' : 'Off'}</b></button>`;
}
async function viewTvSettings({ seq }) {
  const u = state.user;
  const app = window.MarqueeAndroid;
  const appVersion = (() => { try { return app?.version?.() || ''; } catch { return ''; } })();
  const fade = playerPref('skipFade');
  if (!setView(seq, html`<div class="tv-settings">
    <h1>Settings</h1>
    <section class="panel">
      <h2>Who's watching</h2>
      <p>Signed in as <b>${u.username}</b></p>
      <div class="row"><button class="btn" type="button" data-tv="profile">Switch profile</button><button class="btn" type="button" data-tv="signout">Sign out</button></div>
    </section>
    <section class="panel">
      <h2>Playing</h2>
      ${tvToggle('data-acct', 'autoplayNext', playerPref('autoplayNext'), 'Play the next episode automatically')}
      ${tvToggle('data-acct', 'autoSkipIntro', playerPref('autoSkipIntro'), 'Skip intros automatically')}
      ${tvToggle('data-acct', 'nightMode', playerPref('nightMode'), 'Night mode: clearer dialogue, quieter loud scenes')}
      ${tvToggle('data-local', 'subsOn', store.get('subsOn', false), 'Turn on subtitles by default')}
      <div class="tv-choice"><span>Skip Intro / Skip Credits buttons fade after</span>
        <div class="seg">${[[5, '5 s'], [10, '10 s'], [15, '15 s'], [30, '30 s'], [0, 'Never']].map(([v, l]) => html`<button type="button" data-fade="${v}" class="${fade === v ? 'on' : ''}">${l}</button>`)}</div></div>
    </section>
    ${app ? html`<section class="panel">
      <h2>This app</h2>
      <p>Marquee for ${/MarqueeTV/.test(navigator.userAgent) ? 'Android TV' : 'Android'} ${appVersion}</p>
      <div class="row">${typeof app.checkUpdates === 'function' ? html`<button class="btn" type="button" data-tv="update">Check for updates</button>` : ''}
        ${typeof app.changeServer === 'function' ? html`<button class="btn" type="button" data-tv="server">Switch server</button>` : ''}</div>
    </section>` : ''}
    <p class="muted">Passwords, PINs, libraries and everything else are in Marquee on a phone or computer: <b>${location.host}</b></p>
  </div>`)) return;
  view.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const act = b.dataset.tv;
    if (act === 'profile') return showProfilePicker();
    if (act === 'signout') return signOut();
    if (act === 'update') { try { app.checkUpdates(); } catch { toast('Update check failed', true); } return; }
    if (act === 'server') return app.changeServer();
    const flip = (on) => { b.setAttribute('aria-pressed', String(on)); b.querySelector('b').textContent = on ? 'On' : 'Off'; };
    if (b.dataset.acct) {
      const on = b.getAttribute('aria-pressed') !== 'true';
      try { await savePlayerPrefs({ [b.dataset.acct]: on }); flip(on); } catch (err) { toast(err.message, true); }
    } else if (b.dataset.local) {
      const on = b.getAttribute('aria-pressed') !== 'true';
      store.set(b.dataset.local, on);
      flip(on);
    } else if (b.dataset.fade !== undefined) {
      try {
        await savePlayerPrefs({ skipFade: Number(b.dataset.fade) });
        $$('[data-fade]', view).forEach((x) => x.classList.toggle('on', x === b));
      } catch (err) { toast(err.message, true); }
    }
  };
}

// ---------- account ----------
async function viewAccount({ query, seq }) {
  if (tv.on) return viewTvSettings({ seq });
  const u = state.user;
  const devices = await api('/api/devices').catch(() => []);
  const host = location.host;
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
    <div class="panel form" id="player-prefs">
      <h2>Player</h2>
      <label class="check"><input type="checkbox" data-acct="autoplayNext" ${playerPref('autoplayNext') ? 'checked' : ''}> Play the next episode automatically (a 10-second countdown at the credits)</label>
      <label class="check"><input type="checkbox" data-acct="autoSkipIntro" ${playerPref('autoSkipIntro') ? 'checked' : ''}> Skip intros automatically</label>
      <label class="check"><input type="checkbox" data-acct="nightMode" ${playerPref('nightMode') ? 'checked' : ''}> Night mode: clearer dialogue and quieter loud scenes</label>
      <label>Skip Intro / Skip Credits buttons
        <select data-acct="skipFade">${[[5, 'Fade after 5 seconds'], [10, 'Fade after 10 seconds'], [15, 'Fade after 15 seconds'], [30, 'Fade after 30 seconds'], [0, 'Stay until the intro or credits end']]
          .map(([v, l]) => html`<option value="${v}" ${playerPref('skipFade') === v ? 'selected' : ''}>${l}</option>`)}</select></label>
      <p class="muted" style="margin:0;font-size:13px">Saved with your account: they apply on every device you watch on, TVs included. A faded button comes back when you bring up the controls.</p>
    </div>
    <div class="panel form" id="prefs">
      <h2>This browser</h2>
      <label class="check"><input type="checkbox" data-pref="subsOn" ${store.get('subsOn', false) ? 'checked' : ''}> Turn on subtitles by default</label>
      <label>Streaming quality
        <select data-pref="quality">${[['', 'Automatic (original at home, adaptive when away)'], ['original', 'Original'], ['auto', 'Adaptive (adjusts to your connection)'],
          ['1080p', '1080p'], ['720p', '720p'], ['480p', '480p'], ['360p', '360p']].map(([v, l]) => html`<option value="${v}" ${(store.get('quality', '') || '') === v ? 'selected' : ''}>${l}</option>`)}</select></label>
      <label class="check"><input type="checkbox" data-pref="groupCollections" ${store.get('groupCollections', true) ? 'checked' : ''}> Show movies that are in a collection as the collection (home page and libraries)</label>
      <label class="check"><input type="checkbox" data-pref="askProfile" ${store.get('askProfile', false) ? 'checked' : ''}> Ask “Who's watching?” when Marquee opens (for a shared TV or tablet)</label>
      <label class="check"><input type="checkbox" id="tv-mode" ${tv.on ? 'checked' : ''}> TV mode: bigger highlights, and the arrow keys or a remote move between titles</label>
      <p class="muted" style="margin:0;font-size:13px">These are saved in this browser.</p>
    </div>
    ${window.MarqueeAndroid ? html`<div class="panel form" id="app-panel">
      <h2>This app</h2>
      <p class="muted" style="margin:0">Marquee for ${/MarqueeTV/.test(navigator.userAgent) ? 'Android TV' : 'Android'} ${(() => { try { return window.MarqueeAndroid.version(); } catch { return ''; } })()}</p>
      ${typeof window.MarqueeAndroid.checkUpdates === 'function'
        ? html`<div class="row"><button class="btn" type="button" id="app-update">Check for updates</button></div>
          <p class="muted" style="margin:0;font-size:13px">The app also checks when it opens. Updates come from this server and keep you signed in.</p>`
        : html`<p class="muted" style="margin:0;font-size:13px">This version can't update itself: install the new one once from the link below, and later versions can.</p>`}
    </div>` : ''}
    <form class="panel form" id="link-form">
      <h2>Watch on a TV</h2>
      <p class="muted" style="margin:0">Open Marquee on your Roku or Android TV (or the TV's web browser). It shows a code: type it here to sign that TV in as you.</p>
      <div class="row"><input class="input code-input" name="code" maxlength="7" placeholder="ABC123" value="${query?.get('code') || ''}" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Code shown on the TV">
        <button class="btn primary" type="submit">Link TV</button></div>
      <div class="form-error" id="link-error"></div>
      ${devices.length ? html`<div class="device-list">${devices.map((d) => html`<div class="device-row"><span><b>${d.name}</b> <span class="muted">· linked ${fmtDate(d.createdAt)}${d.lastSeenAt ? ` · last used ${fmtDate(d.lastSeenAt)}` : ''}</span></span>
        <button class="btn small danger" type="button" data-unlink="${d.id}">Unlink</button></div>`)}</div>` : ''}
      <p class="muted" style="margin:0;font-size:13px">The apps: <a class="link" href="/downloads/Marquee-TV.apk" download="Marquee-TV.apk">Android TV app</a> ·
        <a class="link" href="/downloads/Marquee-Roku.zip" download="Marquee-Roku.zip">Roku channel</a> (added from a computer with the Roku in developer mode: see <code>roku/README.md</code>).
        On a phone, <b>${host}/#/link</b> opens this box.</p>
    </form>
    <form class="panel form" id="pin-form">
      <h2>Profile PIN</h2>
      <p class="muted" style="margin:0">${u.hasPin ? 'You have a PIN.' : u.noPin ? 'Your profile can be picked on “Who\'s watching?” without a PIN (set by an admin).' : 'Set a PIN to appear on the “Who\'s watching?” screen, so people sharing a device can switch to your profile with it instead of your password.'}</p>
      <div class="row" style="align-items:flex-end">
        <label style="min-width:160px">Current password<input class="input" type="password" name="currentPassword" autocomplete="current-password" required></label>
        <label style="min-width:120px">${u.hasPin ? 'New PIN' : 'PIN'}<input class="input" name="pin" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" placeholder="4–8 digits" autocomplete="off"></label>
        <button class="btn primary" type="submit">${u.hasPin ? 'Change PIN' : 'Set PIN'}</button>
        ${u.hasPin ? html`<button class="btn danger" type="button" id="pin-remove">Remove PIN</button>` : ''}
      </div>
      <div class="form-error" id="pin-error"></div>
    </form>
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
      <label>New password<input class="input" type="password" name="newPassword" autocomplete="new-password" minlength="8" required></label>
      <label>Confirm new password<input class="input" type="password" name="confirm" autocomplete="new-password" required></label>
      <div class="form-error" id="pw-error"></div>
      <div><button class="btn primary" type="submit">Update password</button></div>
      <p class="muted" style="margin:0;font-size:13px">Changing your password signs you out on your other devices.</p>
    </form>`)) return;
  $('#acct-signout').onclick = signOut;
  $('#tv-mode').onchange = (e) => { try { localStorage.setItem('marquee:tvMode', String(e.target.checked)); } catch { /* ignore */ } initTvMode(); toast(e.target.checked ? 'TV mode on' : 'TV mode off'); };
  $('#link-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/devices/link', { method: 'POST', body: { code: e.target.elements.code.value } });
      toast(`${r.name} is signed in`);
      history.replaceState(null, '', '#/account');
      router();
    } catch (err) { $('#link-error').textContent = err.message; }
  };
  $('#link-form').onclick = async (e) => {
    const id = e.target.closest('[data-unlink]')?.dataset.unlink;
    if (!id || !confirm('Unlink this TV? It will need a new code to sign in again.')) return;
    await api(`/api/devices/${id}`, { method: 'DELETE' });
    toast('TV unlinked');
    router();
  };
  if (query?.get('code') || parseHash().path === '/link') $('#link-form').scrollIntoView({ block: 'center' });
  $('#app-update')?.addEventListener('click', () => { try { window.MarqueeAndroid.checkUpdates(); } catch { toast('Update check failed', true); } });
  $('#player-prefs').onchange = async (e) => {
    const k = e.target.dataset.acct;
    if (!k) return;
    const v = e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value);
    try { await savePlayerPrefs({ [k]: v }); toast('Saved for your account'); } catch (err) { toast(err.message, true); }
  };
  $('#prefs').onchange = (e) => { const k = e.target.dataset.pref; if (k) { store.set(k, e.target.type === 'checkbox' ? e.target.checked : e.target.value); toast('Saved'); } };
  const savePin = async (pin) => {
    const f = $('#pin-form').elements;
    try {
      state.user = (await api('/api/auth/pin', { method: 'POST', body: { currentPassword: f.currentPassword.value, pin } })).user;
      toast(pin ? 'PIN saved' : 'PIN removed');
      router();
    } catch (err) { $('#pin-error').textContent = err.message; }
  };
  $('#pin-form').onsubmit = (e) => { e.preventDefault(); savePin(e.target.elements.pin.value); };
  if ($('#pin-remove')) $('#pin-remove').onclick = () => { if ($('#pin-form').elements.currentPassword.reportValidity()) savePin(''); };
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
            · Downloads ${u.canDownload ? 'allowed' : 'off'}${u.maxAge != null ? html` · <b>Kids: ${maturityLabel(u.maxAge)}</b>` : ''} · Last sign-in: ${fmtDate(u.lastLoginAt)}
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
          <input class="input" type="password" name="password" autocomplete="new-password" ${user ? 'placeholder="Leave blank to keep"' : 'required minlength="8"'}></label>
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
        <label class="check"><input type="checkbox" name="noPin" ${user?.noPin ? 'checked' : ''}> Show on “Who's watching?” without a PIN (e.g. for children)</label>
      </fieldset>
      <fieldset class="access" id="age-fields">
        <legend>Maturity (kids profiles)</legend>
        <label>Can watch
          <select name="maxAge">${[[null, 'Everything'], ...MATURITY].map(([v, l]) => html`<option value="${v ?? ''}" ${(user?.maxAge ?? null) === v ? 'selected' : ''}>${l}</option>`)}</select></label>
        <label class="check"><input type="checkbox" name="allowUnrated" ${user?.allowUnrated !== false ? 'checked' : ''}> Also titles without a rating (YouTube, home videos, titles not matched online)</label>
        <p class="muted" style="margin:0;font-size:13px">Titles rated above this are hidden for this person everywhere: home, libraries, search and the TV apps. Ratings come from TMDB (G, PG, TV-Y7…); set one by hand in a title's ⋯ → Edit.</p>
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
    $('#age-fields').disabled = admin;
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
      noPin: f.noPin.checked,
      maxAge: f.maxAge.value === '' ? null : Number(f.maxAge.value),
      allowUnrated: f.allowUnrated.checked,
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

const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function jobRow(j, dl) {
  const active = j.status === 'queued' || j.status === 'running';
  // Why a queued download isn't running yet.
  const waitingForHours = j.status === 'queued' && !j.retryAt && !j.startNow && !dl.inWindow;
  let note = '';
  if (j.status === 'queued' && j.retryAt) note = `Trying again at ${clock(j.retryAt)} (attempt ${(j.attempts || 0) + 1} of 3)`;
  else if (waitingForHours) note = `Waiting for download hours (${dl.settings.windowStart}–${dl.settings.windowEnd})`;
  else if (j.status === 'done' && j.skipped) note = j.files.length ? `${j.skipped} already downloaded before, skipped` : 'Already downloaded before: nothing new';
  const lib = state.libraries.find((l) => l.id === j.libraryId);
  return html`
    <div class="panel dl-row" data-job="${j.id}">
      <div class="dl-main">
        <div class="dl-title" title="${j.url}">${j.title || j.url}</div>
        <div class="muted dl-meta">
          <span class="status ${j.status}">${STATUS_LABEL[j.status] || j.status}</span>
          ${note ? html`<span>${note}</span>` : ''}
          ${j.status === 'running' ? html`<span>${j.progress.toFixed(1)}%</span>${j.speed ? html`<span>${j.speed}</span>` : ''}${j.eta ? html`<span>ETA ${j.eta}</span>` : ''}` : ''}
          ${j.playlist ? html`<span>Playlist · ${j.files.length} saved${j.status === 'running' && j.current ? ` · now: ${j.current}` : ''}</span>` : ''}
          ${lib ? html`<span>→ ${lib.name}${j.folder ? ` / ${j.folder}` : ''}</span>` : ''}
          ${state.user.role === 'admin' && j.userId !== state.user.id ? html`<span>by ${j.username}</span>` : ''}
          <span>${fmtDate(j.createdAt)}</span>
        </div>
        ${active ? html`<div class="bar"><i style="width:${j.status === 'running' ? j.progress : 0}%"></i></div>` : ''}
        ${j.error ? html`<div class="dl-error">${j.status === 'queued' ? 'Last attempt: ' : ''}${j.error}</div>` : ''}
      </div>
      <div class="row">
        ${j.status === 'done' && lib ? html`<a class="btn small" href="#/library/${lib.id}">Open library</a>` : ''}
        ${j.status === 'queued' && (waitingForHours || j.retryAt) ? html`<button class="btn small" data-jact="start">Start now</button>` : ''}
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
      <div id="dl-again" hidden><button class="btn small" type="button" id="dl-force">Download again anyway</button></div>
      <div class="row"><button class="btn primary" type="submit" ${data.available ? '' : 'disabled'}>⤓ Download</button>
        <span class="muted" style="font-size:13px">Only download videos you have the right to save. Downloads appear in the library automatically when finished.</span></div>
    </form>`}
    ${admin && data.available ? html`<details class="panel form dl-settings" style="max-width:none" ${data.settings.windowStart || data.settings.rateLimit ? 'open' : ''}>
      <summary><b>Download settings</b> <span class="muted">${[data.settings.windowStart ? `only ${data.settings.windowStart}–${data.settings.windowEnd}` : 'any time', data.settings.rateLimit ? `max ${data.settings.rateLimit} MB/s` : 'full speed'].join(' · ')}</span></summary>
      <div class="row dls-line"><label class="check"><input type="checkbox" id="dls-window" ${data.settings.windowStart ? 'checked' : ''}> Only download between</label>
        <input class="input" type="time" id="dls-start" value="${data.settings.windowStart || '01:00'}" aria-label="From"> and
        <input class="input" type="time" id="dls-end" value="${data.settings.windowEnd || '07:00'}" aria-label="Until"></div>
      <div class="row dls-line"><label class="check"><input type="checkbox" id="dls-rate" ${data.settings.rateLimit ? 'checked' : ''}> Limit the speed to</label>
        <input class="input" type="number" id="dls-rate-mb" min="0.1" step="0.1" value="${data.settings.rateLimit || 2}" aria-label="MB per second"> MB/s</div>
      <label class="check"><input type="checkbox" id="dls-auto" ${data.settings.autoUpdate ? 'checked' : ''}> Keep yt-dlp up to date automatically (checks once a day)
        ${data.lastToolUpdate ? html`<span class="muted"> — last check ${fmtDate(data.lastToolUpdate.at)}${data.lastToolUpdate.ok ? '' : ' (failed)'}</span>` : ''}</label>
      <p class="muted" style="margin:0;font-size:13px">Downloads added outside these hours wait in the queue; “Start now” overrides that for one download.
        Failed downloads are tried again automatically (up to 3 times) and continue where they stopped.</p>
      <div class="row"><button class="btn small primary" type="button" id="dls-save">Save</button></div>
    </details>` : ''}
    <h2 style="margin:24px 0 12px">Queue & history</h2>
    <div id="dl-jobs"></div>`)) return;

  const renderJobs = () => {
    const box = $('#dl-jobs');
    if (!box) return;
    box.innerHTML = data.jobs.length ? data.jobs.map((j) => jobRow(j, data).s).join('') : html`<div class="panel muted">Nothing downloaded yet.</div>`.s;
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
      const send = async (force) => {
        try {
          await api('/api/downloads', { method: 'POST', body: { ...body, force } });
          f.url.value = '';
          $('#dl-error').textContent = '';
          $('#dl-again').hidden = true;
          toast(data.inWindow ? 'Added to the download queue' : `Added: it will download during download hours (${data.settings.windowStart}–${data.settings.windowEnd})`);
          poll();
        } catch (err) {
          $('#dl-error').textContent = err.message;
          $('#dl-again').hidden = !err.data?.duplicate; // "Download again anyway"
          $('#dl-force').onclick = () => send(true);
        }
      };
      send(false);
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
  if ($('#dls-save')) $('#dls-save').onclick = async () => {
    const win = $('#dls-window').checked;
    const body = {
      windowStart: win ? $('#dls-start').value : null, windowEnd: win ? $('#dls-end').value : null,
      rateLimit: $('#dls-rate').checked ? Number($('#dls-rate-mb').value) : null, autoUpdate: $('#dls-auto').checked,
    };
    try { await api('/api/downloads/settings', { method: 'PATCH', body }); toast('Saved'); router(); } catch (err) { toast(err.message, true); }
  };
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

// ---------- "Who's watching?" ----------
async function showProfilePicker({ atStart = false } = {}) {
  if ($('.profile-picker')) return;
  let data;
  try { data = await api('/api/profiles'); } catch { return; }
  const list = data.profiles.some((p) => p.id === data.current) ? data.profiles
    : [{ id: data.current, username: state.user.username, needsPin: false }, ...data.profiles];
  if (atStart && list.length < 2) return; // nobody else to switch to
  const root = document.createElement('div');
  root.className = 'profile-picker';
  root.innerHTML = html`<div class="pp-inner">
      <h1>Who's watching?</h1>
      <div class="pp-list">${list.map((p) => html`<button class="pp-profile ${p.id === data.current ? 'current' : ''}" data-pid="${p.id}">
        <span class="pp-avatar" style="background:${avatarColor(p.username)}">${p.username.slice(0, 1).toUpperCase()}${p.needsPin && p.id !== data.current
          ? html`<span class="pp-lock" title="Needs a PIN">${icon('lock')}</span>` : ''}${p.kids ? html`<span class="pp-kids">KIDS</span>` : ''}</span><span>${p.username}</span></button>`)}</div>
      <form class="pp-pin" hidden><label>PIN for <b class="pp-name"></b>
        <input class="input" name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off"></label>
        <div class="row"><button class="btn primary">Continue</button><button class="btn" type="button" data-pp="back">Back</button></div>
        <div class="form-error"></div></form>
      <p class="muted" style="font-size:13px">${data.profiles.length ? 'Not listed? Set a PIN on your Account page, or sign in with your password.' : 'Nobody has set a PIN yet: set one on the Account page to appear here.'}</p>
      <div class="row" style="justify-content:center"><button class="btn small" data-pp="close">${atStart ? 'Continue as ' + state.user.username : 'Cancel'}</button>
        <button class="btn small" data-pp="signin">Sign in with a password</button></div>
    </div>`.s;
  document.body.append(root);
  const form = $('.pp-pin', root);
  let target = null;
  const go = async (pin) => {
    try {
      await api('/api/auth/switch', { method: 'POST', body: { userId: target.id, pin } });
      location.hash = '#/';
      location.reload(); // start fresh as the new profile
    } catch (err) { $('.form-error', form).textContent = err.message; form.elements.pin.select(); }
  };
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pid]');
    if (b) {
      target = list.find((p) => p.id === b.dataset.pid);
      if (target.id === data.current) return root.remove();
      if (!target.needsPin) return go('');
      $('.pp-list', root).hidden = true;
      form.hidden = false;
      $('.pp-name', form).textContent = target.username;
      form.elements.pin.value = '';
      $('.form-error', form).textContent = '';
      form.elements.pin.focus();
      return;
    }
    const act = e.target.closest('[data-pp]')?.dataset.pp;
    if (act === 'close') root.remove();
    if (act === 'back') { form.hidden = true; $('.pp-list', root).hidden = false; }
    if (act === 'signin') { root.remove(); signOut(); }
  });
  form.onsubmit = (e) => { e.preventDefault(); go(form.elements.pin.value); };
}
