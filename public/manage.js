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
    <button class="avatar ${avatarClass(u)}" id="user-btn" aria-haspopup="true" aria-expanded="false" title="${u.username}" aria-label="${u.username}: account menu" style="background:${avatarBg(u)}">${avatarPic(u)}</button>
    <div class="user-pop" id="user-pop" hidden>
      <div class="user-pop-head"><b>${u.username}</b><span class="muted">${u.role === 'admin' ? 'Administrator' : 'User'}</span></div>
      ${tv.on ? html`<a href="#/account">Settings</a>` : html`<a href="#/account">Account</a>
      <a href="#/requests">Requests</a>
      ${phoneDownloads() ? html`<button id="phone-downloads">Downloads on this phone</button>` : ''}
      ${u.canDownload ? html`<a href="#/downloads">${phoneDownloads() ? 'Video downloader' : 'Downloads'}</a>` : ''}
      ${u.role === 'admin' ? html`<a href="#/activity">Activity</a>` : ''}
      ${u.role === 'admin' ? html`<a href="#/settings">Settings</a>` : ''}
      ${u.role === 'admin' ? html`<a href="#/settings/server" class="upd-link">Update available</a>` : ''}`}
      <button id="switch-profile">Switch profile</button>
      ${window.MarqueeAndroid ? html`<button id="switch-server">Switch server</button>` : ''}
      <button id="sign-out">Sign out</button>
    </div>`.s;
  const pop = $('#user-pop');
  $('#user-btn').onclick = (e) => {
    e.stopPropagation();
    $('#bell-pop').hidden = true; // (one menu at a time: this click doesn't reach the bell's own closing)
    pop.hidden = !pop.hidden;
    $('#user-btn').setAttribute('aria-expanded', String(!pop.hidden));
  };
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
      ${tvToggle('data-local', 'intro', store.get('intro', true), 'Opening animation when Marquee opens')}
      ${tvToggle('data-local', 'introSound', store.get('introSound', true), 'Sound with the opening animation')}
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
// In the style of Settings (and Netflix's account pages): cards of rows, small pop-ups for the
// things that need typing (PIN, password, a TV's code), about a screen tall.
const SUB_SIZES = [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['xlarge', 'Extra large']];
const SUB_STYLES = [['box', 'White on a dark box'], ['shadow', 'White with an outline'], ['yellow', 'Yellow with an outline']];
const optionsOf = (list, current) => list.map(([v, l]) => html`<option value="${v}" ${String(current) === String(v) ? 'selected' : ''}>${l}</option>`);
const stToggle = (label, note, attrs, on) => html`<label class="st-row st-toggle"><span class="st-row-label">${label}${note ? html`<span class="st-row-note">${note}</span>` : ''}</span>
  <input type="checkbox" class="switch" ${raw(attrs)} ${on ? 'checked' : ''}></label>`;
const stSelect = (label, note, attrs, options) => html`<label class="st-row"><span class="st-row-label">${label}${note ? html`<span class="st-row-note">${note}</span>` : ''}</span>
  <select class="st-select" ${raw(attrs)}>${options}</select></label>`;
const stButton = (label, value, id) => html`<button class="st-row st-btn" type="button" id="${id}"><span class="st-row-label">${label}</span><span class="st-row-value">${value}</span>${chevron()}</button>`;

// "20:30" -> "8:30 pm"
const clock12 = (t) => { const h = Number(t.slice(0, 2)); return `${h % 12 || 12}:${t.slice(3)} ${h < 12 ? 'am' : 'pm'}`; };

async function viewAccount({ query, seq }) {
  if (tv.on) return viewTvSettings({ seq });
  const u = state.user;
  const [devices, sessions, time] = await Promise.all([api('/api/devices').catch(() => []), api('/api/auth/sessions').catch(() => null), api('/api/screen-time').catch(() => null)]);
  const inApp = !!window.MarqueeAndroid;
  const appVersion = inApp ? (() => { try { return window.MarqueeAndroid.version(); } catch { return ''; } })() : '';
  const langs = (none) => [['', none], ...LANG_CHOICES];
  if (!setView(seq, html`
    <div class="acct">
      <div class="acct-head">
        <button class="acct-avatar ${avatarClass(u)}" id="acct-avatar" style="background:${avatarBg(u)}" title="Change your picture" aria-label="Change your picture">${avatarPic(u)}<span class="acct-avatar-edit">${icon('pencil')}</span></button>
        <div class="acct-who"><h1>${u.username}</h1>
          <span class="muted">${u.role === 'admin' ? 'Administrator' : u.maxAge != null ? 'Kids profile' : 'Member'}${u.libraries ? ` · ${u.libraries.length} librar${u.libraries.length === 1 ? 'y' : 'ies'}` : ''}</span></div>
        <div class="row acct-actions"><button class="btn small" id="acct-switch">Switch profile</button><button class="btn small" id="acct-signout">Sign out</button></div>
      </div>

      ${time && (time.bedtime || time.dailyMinutes) ? html`<h2 class="st-sub">Screen time <span class="acct-scope">· set by ${u.role === 'admin' ? 'you' : 'a grown-up'}</span></h2>
      <div class="st-card">
        ${time.bedtime ? html`<div class="st-row"><span class="st-row-label">Bedtime<span class="st-row-note">${time.bedtime.schoolNights ? 'School nights (Sunday to Thursday)' : 'Every night'}</span></span>
          <span class="st-row-value">${clock12(time.bedtime.start)} – ${clock12(time.bedtime.end)}</span></div>` : ''}
        ${time.dailyMinutes ? html`<div class="st-row ${time.minutesLeft === 0 ? 'warn' : ''}"><span class="st-row-label">Today<span class="st-row-note">${time.dailyMinutes} minutes a day</span></span>
          <span class="st-row-value">${time.minutesLeft ? `${time.minutesLeft} min left` : 'All used up; more tomorrow'}</span></div>` : ''}
      </div>` : ''}

      <h2 class="st-sub">Playback <span class="acct-scope">· on every device you use</span></h2>
      <div class="st-card" id="player-prefs">
        ${stToggle('Play the next episode automatically', 'A 10-second countdown at the credits', 'data-acct="autoplayNext"', playerPref('autoplayNext'))}
        ${stToggle('Skip intros automatically', '', 'data-acct="autoSkipIntro"', playerPref('autoSkipIntro'))}
        ${stToggle('Night mode', 'Clearer dialogue, quieter loud scenes', 'data-acct="nightMode"', playerPref('nightMode'))}
        ${stSelect('Skip Intro and Skip Credits buttons', 'A faded button comes back when you bring up the controls', 'data-acct="skipFade" data-num',
    optionsOf([[5, 'Fade after 5 s'], [10, 'Fade after 10 s'], [15, 'Fade after 15 s'], [30, 'Fade after 30 s'], [0, 'Stay up']], playerPref('skipFade')))}
        ${stSelect('Subtitles', 'Turned on when a title has them in this language (a show’s own choice still wins)', 'data-acct="subLang"', optionsOf(langs('Off unless I turn them on'), playerPref('subLang')))}
        ${stSelect('Sound', 'Picked when a title has more than one language', 'data-acct="audioLang"', optionsOf(langs('The title’s own'), playerPref('audioLang')))}
        ${stButton('Subtitle appearance', subLook(), 'acct-sublook')}
      </div>

      <h2 class="st-sub">On this ${inApp ? 'app' : 'browser'}</h2>
      <div class="st-card" id="prefs">
        ${stSelect('Streaming quality', '', 'data-pref="quality"', optionsOf([['', 'Automatic (original at home, adaptive away)'], ['original', 'Original'], ['auto', 'Adaptive'],
    ['1080p', '1080p'], ['720p', '720p'], ['480p', '480p'], ['360p', '360p']], store.get('quality', '') || ''))}
        ${stToggle('Subtitles on by default', 'In any language, when there’s no choice above', 'data-pref="subsOn"', store.get('subsOn', false))}
        ${stToggle('Show films in a collection as the collection', 'On the home page and in libraries', 'data-pref="groupCollections"', store.get('groupCollections', true))}
        ${stToggle('Ask “Who’s watching?” when Marquee opens', 'For a shared TV or tablet', 'data-pref="askProfile"', store.get('askProfile', false))}
        ${stToggle('Opening animation', 'The MARQUEE intro when Marquee opens', 'data-pref="intro"', store.get('intro', true))}
        ${stToggle('Sound with the opening animation', 'Browsers may only play it once you’ve used the page', 'data-pref="introSound"', store.get('introSound', true))}
        ${stToggle('TV mode', 'Bigger highlights; the arrow keys or a remote move between titles', 'id="tv-mode"', tv.on)}
        ${inApp ? (typeof window.MarqueeAndroid.checkUpdates === 'function'
    ? stButton('Marquee app', `${appVersion} · Check for updates`, 'app-update')
    : html`<div class="st-row"><span class="st-row-label">Marquee app</span><span class="st-row-value">${appVersion}</span></div>`) : ''}
      </div>

      <h2 class="st-sub">Profile and security</h2>
      <div class="st-card">
        <a class="st-row" href="#/account/history"><span class="st-row-label">Viewing activity<span class="st-row-note">What you’ve watched, newest first</span></span>${chevron()}</a>
        ${stButton('Profile PIN', u.hasPin ? 'Set · Change' : u.noPin ? 'Not needed (set by an admin)' : 'Not set', 'acct-pin')}
        ${stButton('Password', 'Change', 'acct-password')}
        ${sessions ? stButton('Signed in', `${sessions.signIns.length} browser${sessions.signIns.length === 1 ? '' : 's'} or phone${sessions.signIns.length === 1 ? '' : 's'} · Manage`, 'acct-sessions') : ''}
      </div>

      <h2 class="st-sub" id="tvs">TVs and apps</h2>
      <div class="st-card">
        ${devices.map((d) => html`<div class="st-row"><span class="st-row-label">📺 ${d.name}<span class="st-row-note">Linked ${fmtDate(d.createdAt)}${d.lastSeenAt ? ` · last used ${fmtDate(d.lastSeenAt)}` : ''}</span></span>
          <button class="btn small" type="button" data-unlink="${d.id}">Unlink</button></div>`)}
        ${stButton('Link a TV', 'Type the code it shows', 'acct-link')}
        ${inApp ? '' : html`<a class="st-row" href="/downloads/Marquee.apk" download="Marquee.apk"><span class="st-row-label">Android phone and tablet app<span class="st-row-note">Plays more files without converting. Open this page on the phone and tap here.</span></span>${chevron()}</a>`}
        <a class="st-row" href="/downloads/Marquee-TV.apk" download="Marquee-TV.apk"><span class="st-row-label">Android TV app<span class="st-row-note">For Google TV, the NVIDIA Shield and other Android TV boxes</span></span>${chevron()}</a>
        ${u.role === 'admin' ? html`<a class="st-row" href="/downloads/Marquee-Roku.zip" download="Marquee-Roku.zip"><span class="st-row-label">Roku channel<span class="st-row-note">Added from a computer with the Roku in developer mode: see roku/README.md</span></span>${chevron()}</a>` : ''}
      </div>
    </div>`)) return;

  $('#acct-signout').onclick = signOut;
  $('#acct-switch').onclick = () => showProfilePicker();
  $('#acct-avatar').onclick = () => showAvatarPicker();
  $('#tv-mode').onchange = (e) => { try { localStorage.setItem('marquee:tvMode', String(e.target.checked)); } catch { /* ignore */ } initTvMode(); toast(e.target.checked ? 'TV mode on' : 'TV mode off'); };
  $('#app-update')?.addEventListener('click', () => { try { window.MarqueeAndroid.checkUpdates(); } catch { toast('Update check failed', true); } });
  $('#player-prefs').onchange = async (e) => {
    const k = e.target.dataset.acct;
    if (!k) return;
    const v = e.target.type === 'checkbox' ? e.target.checked : 'num' in e.target.dataset ? Number(e.target.value) : e.target.value;
    try { await savePlayerPrefs({ [k]: v }); toast('Saved for every device'); } catch (err) { toast(err.message, true); }
  };
  $('#acct-sublook').onclick = () => subtitleDialog(() => { $('#acct-sublook .st-row-value').textContent = subLook(); });
  $('#prefs').onchange = (e) => { const k = e.target.dataset.pref; if (k) { store.set(k, e.target.type === 'checkbox' ? e.target.checked : e.target.value); toast('Saved'); } };
  $('.acct').onclick = async (e) => {
    const id = e.target.closest('[data-unlink]')?.dataset.unlink;
    if (!id || !confirm('Unlink this TV? It will need a new code to sign in again.')) return;
    await api(`/api/devices/${id}`, { method: 'DELETE' });
    toast('TV unlinked');
    router();
  };
  $('#acct-pin').onclick = () => pinDialog(u);
  $('#acct-password').onclick = () => passwordDialog();
  $('#acct-sessions')?.addEventListener('click', () => sessionsDialog(sessions));
  $('#acct-link').onclick = () => linkDialog();
  // "#/link" (what a TV tells you to open) and "?code=" (from its QR code) open the code box.
  if (query?.get('code') || parseHash().path === '/link') linkDialog(query?.get('code') || '');
}

const subLook = () => `${SUB_SIZES.find(([v]) => v === playerPref('subSize'))?.[1]} · ${SUB_STYLES.find(([v]) => v === playerPref('subStyle'))?.[1]}`;

// Subtitle size and look, with a sample that changes as you choose.
function subtitleDialog(onSaved) {
  const m = openModal({
    title: 'Subtitle appearance',
    body: html`<div style="display:grid;gap:14px" id="sublook">
      <div class="acct-sub-sample"><span class="acct-sample subs-${playerPref('subSize')} subs-${playerPref('subStyle')}"><span>This is how subtitles look.</span></span></div>
      <label>Size <select class="st-select" data-k="subSize">${optionsOf(SUB_SIZES, playerPref('subSize'))}</select></label>
      <label>Look <select class="st-select" data-k="subStyle">${optionsOf(SUB_STYLES, playerPref('subStyle'))}</select></label>
      <p class="muted" style="margin:0;font-size:13px">For the web player and the Android apps. A Roku shows subtitles in its own style (its Settings → Accessibility → Captions style).</p>
    </div>`,
  });
  $('#sublook', m.body).onchange = async (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    try {
      await savePlayerPrefs({ [k]: e.target.value });
      $('.acct-sample', m.body).className = `acct-sample subs-${playerPref('subSize')} subs-${playerPref('subStyle')}`;
      onSaved();
      toast('Saved for every device');
    } catch (err) { toast(err.message, true); }
  };
}

function linkDialog(code = '') {
  const m = openModal({
    title: 'Link a TV',
    body: html`<form class="form" id="link-form" style="display:grid;gap:12px">
      <p class="muted" style="margin:0">Open Marquee on your Roku or Android TV (or the TV’s web browser). It shows a code: type it here to sign that TV in as you.</p>
      <div class="row"><input class="input code-input" name="code" maxlength="7" placeholder="ABC123" value="${code}" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Code shown on the TV">
        <button class="btn primary" type="submit">Link TV</button></div>
      <div class="form-error"></div>
      <p class="muted" style="margin:0;font-size:13px">On a phone, <b>${location.host}/#/link</b> opens this box.</p>
    </form>`,
  });
  const form = $('form', m.body);
  form.elements.code.focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/devices/link', { method: 'POST', body: { code: form.elements.code.value } });
      m.close();
      toast(`${r.name} is signed in`);
      history.replaceState(null, '', '#/account');
      router();
    } catch (err) { $('.form-error', form).textContent = err.message; }
  };
}

function pinDialog(u) {
  const m = openModal({
    title: 'Profile PIN',
    body: html`<form class="form" style="display:grid;gap:12px">
      <p class="muted" style="margin:0">${u.hasPin ? 'You have a PIN. Change it, or remove it.' : 'A PIN lets people sharing a device switch to your profile on “Who’s watching?” with it instead of your password.'}</p>
      <label>Current password<input class="input" type="password" name="currentPassword" autocomplete="current-password" required></label>
      <label>${u.hasPin ? 'New PIN' : 'PIN'}<input class="input" name="pin" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" placeholder="4–8 digits" autocomplete="off"></label>
      <div class="form-error"></div>
      <div class="row"><button class="btn primary" type="submit">${u.hasPin ? 'Change PIN' : 'Set PIN'}</button>
        ${u.hasPin ? html`<button class="btn danger" type="button" data-remove>Remove PIN</button>` : ''}</div>
    </form>`,
  });
  const form = $('form', m.body);
  const save = async (pin) => {
    try {
      state.user = (await api('/api/auth/pin', { method: 'POST', body: { currentPassword: form.elements.currentPassword.value, pin } })).user;
      m.close();
      toast(pin ? 'PIN saved' : 'PIN removed');
      router();
    } catch (err) { $('.form-error', form).textContent = err.message; }
  };
  form.onsubmit = (e) => { e.preventDefault(); save(form.elements.pin.value); };
  $('[data-remove]', form)?.addEventListener('click', () => { if (form.elements.currentPassword.reportValidity()) save(''); });
}

function passwordDialog() {
  const m = openModal({
    title: 'Change password',
    body: html`<form class="form" style="display:grid;gap:12px">
      <label>Current password<input class="input" type="password" name="currentPassword" autocomplete="current-password" required></label>
      <label>New password<input class="input" type="password" name="newPassword" autocomplete="new-password" minlength="8" required></label>
      <label>Confirm new password<input class="input" type="password" name="confirm" autocomplete="new-password" required></label>
      <div class="form-error"></div>
      <div><button class="btn primary" type="submit">Change password</button></div>
      <p class="muted" style="margin:0;font-size:13px">This signs you out on your other browsers and phones.</p>
    </form>`,
  });
  const form = $('form', m.body);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = form.elements;
    if (f.newPassword.value !== f.confirm.value) { $('.form-error', form).textContent = 'Passwords do not match'; return; }
    try {
      await api('/api/auth/password', { method: 'POST', body: { currentPassword: f.currentPassword.value, newPassword: f.newPassword.value } });
      m.close();
      toast('Password changed');
    } catch (err) { $('.form-error', form).textContent = err.message; }
  };
}

function sessionsDialog(sessions) {
  const others = sessions.signIns.filter((s) => !s.current).length;
  const m = openModal({
    title: 'Where you’re signed in',
    body: html`<div style="display:grid;gap:12px">
      <div class="st-card" style="margin:0">${sessions.signIns.map((s) => html`<div class="st-row"><span class="st-row-label">${s.device}<span class="st-row-note">Since ${fmtDate(s.createdAt)}</span></span>
        ${s.current ? html`<span class="st-row-value">This one</span>` : ''}</div>`)}</div>
      ${sessions.tvs.length ? html`<p class="muted" style="margin:0;font-size:13px">Linked TVs (${sessions.tvs.length}) stay signed in: unlink them one by one under TVs and apps.</p>` : ''}
      <div class="row"><button class="btn primary" type="button" data-out ${others ? '' : 'disabled'}>Sign out everywhere else</button></div>
    </div>`,
  });
  $('[data-out]', m.body).onclick = async () => {
    try {
      const r = await api('/api/auth/signout-others', { method: 'POST' });
      m.close();
      toast(r.signedOut ? `Signed out of ${r.signedOut} other place${r.signedOut === 1 ? '' : 's'}` : 'Nowhere else to sign out of');
      router();
    } catch (err) { toast(err.message, true); }
  };
}

// Account → Viewing activity: what this profile has watched, newest first.
async function viewHistory({ seq }) {
  const list = await api('/api/history');
  const day = (t) => new Date(t).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  const groups = [];
  for (const x of list) {
    const d = day(x.watchedAt);
    if (groups[groups.length - 1]?.day !== d) groups.push({ day: d, items: [] });
    groups[groups.length - 1].items.push(x);
  }
  const title = (x) => (x.type === 'episode' ? html`<b>${x.showTitle}</b> <span class="muted">· ${epLabel(x)} ${x.title}</span>` : html`<b>${x.title}</b>${x.year ? html` <span class="muted">· ${x.year}</span>` : ''}`);
  if (!setView(seq, html`<div class="acct">
    <div class="st-head"><h1>Viewing activity</h1><a class="btn small" href="#/account">‹ Account</a></div>
    ${groups.length ? groups.map((g) => html`<h2 class="st-sub">${g.day}</h2><div class="st-card">${g.items.map((x) => html`<div class="st-row hist-row">
      <a class="st-row-label" href="#/item/${x.id}"><span>${title(x)}</span><span class="st-row-note">${x.progress?.watched ? 'Watched' : x.duration ? `${fmtClock(x.progress?.position || 0)} of ${fmtClock(x.duration)}` : ''}</span></a>
      <button class="icon-btn" type="button" data-forget="${x.id}" title="Remove from your activity" aria-label="Remove ${x.title} from your activity">✕</button></div>`)}</div>`)
    : html`<div class="st-card"><div class="st-row muted">Nothing watched yet.</div></div>`}
    <p class="muted acct-note">Removing something forgets where you got to and whether you’ve watched it.</p>
  </div>`)) return;
  $('.acct').onclick = async (e) => {
    const id = e.target.closest('[data-forget]')?.dataset.forget;
    if (!id) return;
    await api(`/api/history/${id}`, { method: 'DELETE' });
    e.target.closest('.hist-row').remove();
    toast('Removed from your activity');
  };
}

// ---------- users (admin, part of Settings) ----------
// After an admin reset your password: choose your own before anything else (the server allows
// nothing else until then).
function showChoosePassword() {
  const root = document.createElement('div');
  root.className = 'modal-backdrop';
  root.innerHTML = html`<form class="modal" role="dialog" aria-modal="true" aria-label="Choose your own password">
      <header class="modal-head"><h2>Choose your own password</h2></header>
      <div class="modal-body form" style="display:grid;gap:12px">
        <p class="muted" style="margin:0">Hi ${state.user.username}. You signed in with a temporary password from whoever runs this server. Choose your own to carry on.</p>
        <label>New password<input class="input" type="password" name="pw" autocomplete="new-password" minlength="8" required></label>
        <label>The same again<input class="input" type="password" name="pw2" autocomplete="new-password" minlength="8" required></label>
        <div class="form-error"></div>
      </div>
      <footer class="row" style="justify-content:space-between"><button type="button" class="btn" data-out>Sign out</button><button class="btn primary">Save and carry on</button></footer>
    </form>`.s;
  document.body.append(root);
  const form = $('form', root);
  form.elements.pw.focus();
  $('[data-out]', root).onclick = () => { root.remove(); signOut(); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = form.elements;
    if (f.pw.value !== f.pw2.value) { $('.form-error', form).textContent = 'Those two don’t match'; return; }
    try {
      await api('/api/auth/password', { method: 'POST', body: { newPassword: f.pw.value } });
      location.reload();
    } catch (err) { $('.form-error', form).textContent = err.message; }
  };
}

// The Users list's lock badge: "Locked: wrong password" / "PIN locked", until when.
function lockBadge(u) {
  const parts = [];
  if (u.locks?.signIn) parts.push('wrong passwords');
  if (u.locks?.pin) parts.push(u.locks.pin.forToday ? 'wrong PINs (for today)' : 'wrong PINs');
  if (!parts.length) return '';
  const until = Math.max(u.locks.signIn?.until || 0, u.locks.pin?.until || 0);
  return html`<span class="chip lock-chip" title="Until ${fmtDate(until)}">🔒 Locked: ${parts.join(', ')}</span>`;
}

function showResetPassword(u) {
  const self = u.id === state.user.id;
  const m = openModal({
    title: `Reset ${u.username}’s password`,
    body: html`<form class="form reset-form" style="display:grid;gap:12px">
      <label class="check"><input type="radio" name="how" value="temp" checked> Make a temporary password for me to give them</label>
      <label class="check"><input type="radio" name="how" value="set"> Set a password
        <input class="input" type="text" name="password" minlength="8" autocomplete="off" placeholder="At least 8 characters" style="margin-left:8px;width:220px" disabled></label>
      <label class="check"><input type="checkbox" name="mustChange" checked> They choose their own when they next sign in</label>
      ${self ? '' : html`<label class="check"><input type="checkbox" name="signOut" checked> Sign them out everywhere (TVs need linking again)</label>`}
      ${u.hasPin ? html`<label class="check"><input type="checkbox" name="removePin"> Remove their PIN too (if they've forgotten it)</label>` : ''}
      <div class="form-error"></div>
      <div class="row"><button class="btn primary">Reset password</button></div>
    </form>`,
  });
  const form = $('form', m.body);
  form.addEventListener('change', () => { form.elements.password.disabled = form.elements.how.value !== 'set'; if (!form.elements.password.disabled) form.elements.password.focus(); });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = form.elements;
    try {
      const r = await api(`/api/users/${u.id}/reset-password`, {
        method: 'POST',
        body: { password: f.how.value === 'set' ? f.password.value : null, mustChange: f.mustChange.checked, signOut: f.signOut ? f.signOut.checked : false, removePin: !!f.removePin?.checked },
      });
      if (r.temporaryPassword) {
        m.body.innerHTML = html`<div style="display:grid;gap:12px">
          <p style="margin:0">${u.username}’s temporary password:</p>
          <div class="row"><code class="temp-pw">${r.temporaryPassword}</code><button class="btn small" id="copy-pw">Copy</button></div>
          <p class="muted" style="margin:0;font-size:13px">Give it to them${f.mustChange.checked ? '; they’ll choose their own when they sign in' : ''}. It isn’t shown again.</p>
          <div class="row"><button class="btn primary" data-close-done>Done</button></div></div>`.s;
        $('#copy-pw', m.body).onclick = () => navigator.clipboard?.writeText(r.temporaryPassword).then(() => toast('Copied'), () => {});
        $('[data-close-done]', m.body).onclick = () => { m.close(); router(); };
      } else { toast('Password reset'); m.close(); router(); }
    } catch (err) { $('.form-error', form).textContent = err.message; }
  };
}

function usersSection(users, { heading = true } = {}) {
  const libName = (id) => state.libraries.find((l) => l.id === id)?.name;
  return html`
    ${heading ? html`<div class="row" style="justify-content:space-between;margin:28px 0 12px">
      <h2>Users</h2><button class="btn small" id="add-user">＋ Add user</button>
    </div>` : ''}
    <div id="user-form-slot"></div>
    ${users.map((u) => html`
      <div class="panel lib-row" data-user="${u.id}">
        <button class="avatar static ${avatarClass(u)}" data-avatar-for="${u.id}" style="background:${avatarBg(u)}" title="Change ${u.username}'s picture" aria-label="Change ${u.username}'s picture">${avatarPic(u)}</button>
        <div class="lib-info">
          <div style="font-weight:600">${u.username}${u.id === state.user.id ? html` <span class="muted" style="font-weight:400">(you)</span>` : ''}
            <span class="chip" style="margin-left:6px">${u.role === 'admin' ? 'Admin' : 'User'}</span> ${lockBadge(u)}
            ${u.mustChangePassword ? html`<span class="chip">Temporary password</span>` : ''}</div>
          <div class="muted" style="font-size:13px">
            ${u.libraries === null ? 'All libraries' : u.libraries.length ? u.libraries.map(libName).filter(Boolean).join(', ') : 'No libraries'}
            · Downloads ${u.canDownload ? 'allowed' : 'off'}${u.maxAge != null ? html` · <b>Kids: ${maturityLabel(u.maxAge)}</b>` : ''} · Last sign-in: ${fmtDate(u.lastLoginAt)}
          </div>
        </div>
        <div class="row">
          ${u.locks?.signIn || u.locks?.pin ? html`<button class="btn small primary" data-uact="unlock">Unlock</button>` : ''}
          <button class="btn small" data-uact="edit">Edit</button>
          <button class="btn small" data-uact="reset">Reset password</button>
          ${u.id !== state.user.id ? html`<button class="btn small danger" data-uact="delete">Delete</button>` : ''}
        </div>
      </div>`)}`;
}

function bindUsersSection(users) {
  $('#add-user').onclick = () => showUserForm();
  $$('[data-avatar-for]').forEach((b) => { b.onclick = () => showAvatarPicker(users.find((x) => x.id === b.dataset.avatarFor)); });
  $$('[data-uact]').forEach((b) => {
    b.onclick = async () => {
      const u = users.find((x) => x.id === b.closest('[data-user]').dataset.user);
      if (b.dataset.uact === 'edit') return showUserForm(u);
      if (b.dataset.uact === 'reset') return showResetPassword(u);
      if (b.dataset.uact === 'unlock') {
        try { await api(`/api/users/${u.id}/unlock`, { method: 'POST' }); toast(`${u.username} can sign in again`); router(); } catch (err) { toast(err.message, true); }
        return;
      }
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
        <label class="check"><input type="checkbox" name="allowUnrated" ${user?.allowUnrated !== false ? 'checked' : ''}> Also titles without a rating (YouTube, home videos, and titles with no rating online)</label>
        <p class="muted" style="margin:0;font-size:13px">Titles rated above this are hidden for this person everywhere: home, libraries, search and the TV apps. Ratings come from TMDB (G, PG, TV-Y7…); set one by hand in a title's ⋯ → Edit.</p>
      </fieldset>
      <fieldset class="access" id="time-fields">
        <legend>Screen time</legend>
        <label class="check"><input type="checkbox" name="bedOn" ${user?.bedtime ? 'checked' : ''}> Bedtime: nothing plays from
          <input class="input" type="time" name="bedStart" value="${user?.bedtime?.start || '20:30'}" style="width:120px"> until
          <input class="input" type="time" name="bedEnd" value="${user?.bedtime?.end || '07:00'}" style="width:120px"></label>
        <label class="check" style="margin-left:26px"><input type="checkbox" name="bedSchool" ${user?.bedtime?.schoolNights ? 'checked' : ''}> Only on school nights (Sunday to Thursday)</label>
        <label>A day, at most
          <select name="dailyMinutes">${[[null, 'No limit'], [30, '30 minutes'], [45, '45 minutes'], [60, '1 hour'], [90, '1½ hours'], [120, '2 hours'], [180, '3 hours'], [240, '4 hours']]
    .map(([v, l]) => html`<option value="${v ?? ''}" ${(user?.dailyMinutes ?? null) === v ? 'selected' : ''}>${l}</option>`)}</select></label>
        <p class="muted" style="margin:0;font-size:13px">On every TV, phone and browser: what's playing stops when bedtime starts or the time's used up, with a message. Counts reset at midnight.</p>
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
    $('#time-fields').disabled = admin;
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
      bedtime: f.bedOn.checked ? { start: f.bedStart.value, end: f.bedEnd.value, schoolNights: f.bedSchool.checked } : null,
      dailyMinutes: f.dailyMinutes.value === '' ? null : Number(f.dailyMinutes.value),
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
  if (!state.user.canDownload) return setView(seq, emptyState({ art: 'lock', title: 'Downloads aren’t switched on for you', text: 'Ask whoever runs Marquee to turn them on for your account.' }));
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
        ${admin ? html`<a href="#/settings/libraries?add=1">Create one</a> — for example a library named “YouTube”.` : 'Ask an administrator to share one with you.'}</div>` : html`
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

// ---------- profile picture ----------
// A built-in face on a colour, or a photo (made into a small square here before it's sent). Your
// own from the Account page; admins can also set anyone's from Settings → Users.
function showAvatarPicker(who = state.user) {
  const self = who.id === state.user.id;
  const q = self ? '' : `?user=${encodeURIComponent(who.id)}`;
  let face = who.avatar?.face || 1, color = who.avatar?.color || FACE_COLORS[5];
  const m = openModal({ title: self ? 'Your picture' : `${who.username}’s picture`, wide: true, body: html`
    <div class="av-pick">
      <div class="av-preview" aria-hidden="true"></div>
      <div class="av-side">
        <h3 class="av-h">Pick a face</h3>
        <div class="av-faces">${Array.from({ length: FACE_COUNT }, (_, i) => html`<button type="button" class="av-face" data-face="${i + 1}" aria-label="Face ${i + 1}"><img src="${faceUrl(i + 1)}" alt=""></button>`)}</div>
        <h3 class="av-h">And a colour</h3>
        <div class="av-colors">${FACE_COLORS.map((c) => html`<button type="button" class="av-color" data-color="${c}" style="background:${c}" aria-label="Colour ${c}"></button>`)}</div>
        <div class="row av-actions">
          <button type="button" class="btn primary" data-av="save">Use this picture</button>
          <label class="btn">Upload a photo<input type="file" accept="image/*" hidden data-av="file"></label>
          ${who.avatar ? html`<button type="button" class="btn" data-av="reset">Use ${self ? 'my' : 'their'} initial</button>` : ''}
        </div>
        <div class="form-error"></div>
      </div>
    </div>`.s });
  const root = m.body, err = $('.form-error', root);
  const paint = () => {
    $('.av-preview', root).style.background = color;
    $('.av-preview', root).innerHTML = html`<img src="${faceUrl(face)}" alt="">`.s;
    for (const b of $$('.av-face', root)) { b.style.background = color; b.classList.toggle('on', +b.dataset.face === face); }
    for (const b of $$('.av-color', root)) b.classList.toggle('on', b.dataset.color === color);
  };
  paint();
  const done = (user) => {
    if (self) { state.user = { ...state.user, avatar: user.avatar }; renderUserMenu(); }
    m.close();
    toast('Picture changed');
    router();
  };
  root.addEventListener('click', async (e) => {
    const f = e.target.closest('[data-face]'), c = e.target.closest('[data-color]'), act = e.target.closest('button[data-av]')?.dataset.av;
    if (f) { face = +f.dataset.face; paint(); }
    if (c) { color = c.dataset.color; paint(); }
    if (!act) return;
    try {
      const r = await api(`/api/auth/avatar${q}`, { method: 'PUT', body: act === 'save' ? { face, color } : {} });
      done(r.user);
    } catch (e2) { err.textContent = e2.message; }
  });
  $('[data-av="file"]', root).onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    err.textContent = '';
    try {
      const blob = await squarePhoto(file, 320);
      const res = await fetch(`/api/auth/avatar/photo${q}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Upload failed (${res.status})`);
      done(data.user);
    } catch (e2) { err.textContent = e2.message || 'Couldn’t use that picture'; }
  };
}

// The middle square of a photo, `size` pixels across, as a JPEG.
async function squarePhoto(file, size) {
  let img;
  try { img = await createImageBitmap(file); } catch { throw new Error('Couldn’t open that picture: try a JPEG or PNG'); }
  const side = Math.min(img.width, img.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Couldn’t use that picture'))), 'image/jpeg', 0.88));
}

// ---------- "Who's watching?" ----------
async function showProfilePicker({ atStart = false } = {}) {
  if ($('.profile-picker')) return;
  let data;
  try { data = await api('/api/profiles'); } catch { return; }
  const list = data.profiles.some((p) => p.id === data.current) ? data.profiles
    : [{ id: data.current, username: state.user.username, avatar: state.user.avatar, needsPin: false }, ...data.profiles];
  if (atStart && list.length < 2) return; // nobody else to switch to
  const root = document.createElement('div');
  root.className = 'profile-picker';
  root.innerHTML = html`<div class="pp-inner">
      <h1>Who's watching?</h1>
      <div class="pp-list">${list.map((p) => html`<button class="pp-profile ${p.id === data.current ? 'current' : ''}" data-pid="${p.id}">
        <span class="pp-avatar ${avatarClass(p)}" style="background:${avatarBg(p)}">${avatarPic(p)}${p.needsPin && p.id !== data.current
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
