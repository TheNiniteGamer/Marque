'use strict';
/* Marquee web client — TV mode: for TV browsers and the Android TV app. Bigger focus highlights, and
   the arrow keys (a TV remote's direction pad) move to the nearest item in that direction; Back
   closes pop-ups and goes back. Loaded before app.js; helpers from app.js are used only when called.

   Turned on by: the Android TV app, a TV's own browser (recognised by its name), "?tv=1" in the
   address, or Account → "TV mode". */

const TV_BROWSER = /MarqueeTV|Android TV|\bAFT[A-Z]|SMART-TV|SmartTV|Tizen|Web0S|webOS|BRAVIA|CrKey|HbbTV/i;
function tvModeWanted() {
  const q = new URLSearchParams(location.search).get('tv');
  if (q === '1' || q === '0') try { localStorage.setItem('marquee:tvMode', q === '1' ? 'true' : 'false'); } catch { /* private mode */ }
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('marquee:tvMode')); } catch { /* none */ }
  return saved ?? TV_BROWSER.test(navigator.userAgent);
}
const tv = { on: false };
function initTvMode() {
  tv.on = tvModeWanted();
  document.body.classList.toggle('tv', tv.on);
}
initTvMode();

// ---------- moving with the arrow keys ----------
// Things on a card besides the card itself (play, ⋯) are reached through the card's pop-up instead.
const TV_SKIP = '.brand, .play-hover, .card-menu, .card-text, .rail-btn, .hero-title a, .dlg-side a, .tabbar *, [tabindex="-1"], [disabled]';
const FOCUSABLE = 'a[href], button, select, input:not([type=hidden]), textarea, [tabindex]';
function tvScope() {
  return [...document.querySelectorAll('.modal-backdrop')].pop() || document.querySelector('.profile-picker')
    || document.querySelector('.popmenu') || document.querySelector('#detail-layer') || document.body;
}
function tvVisible(el) {
  if (el.closest('[hidden], .hover-preview')) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const st = getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
}
function tvCandidates() {
  const scope = tvScope();
  return [...scope.querySelectorAll(FOCUSABLE)].filter((el) => !el.matches(TV_SKIP) && !el.closest('.player') && tvVisible(el));
}
// The nearest candidate in a direction: along that direction first, then how far off to the side.
function tvNeighbour(from, dir) {
  const a = from.getBoundingClientRect();
  const ac = { x: a.left + a.width / 2, y: a.top + a.height / 2 };
  let best = null, bestScore = Infinity;
  for (const el of tvCandidates()) {
    if (el === from || el.contains(from) || from.contains(el)) continue;
    const b = el.getBoundingClientRect();
    const bc = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    let along, side;
    if (dir === 'ArrowRight') { if (bc.x <= ac.x + 1 || b.left < a.left + 2) continue; along = Math.max(0, b.left - a.right); side = Math.abs(bc.y - ac.y); }
    else if (dir === 'ArrowLeft') { if (bc.x >= ac.x - 1 || b.right > a.right - 2) continue; along = Math.max(0, a.left - b.right); side = Math.abs(bc.y - ac.y); }
    else if (dir === 'ArrowDown') { if (bc.y <= ac.y + 1 || b.top < a.top + 2) continue; along = Math.max(0, b.top - a.bottom); side = Math.abs(bc.x - ac.x); }
    else { if (bc.y >= ac.y - 1 || b.bottom > a.bottom - 2) continue; along = Math.max(0, a.top - b.bottom); side = Math.abs(bc.x - ac.x); }
    // Moving up or down a page of rows: go to the item at the start of the next row, like TV apps.
    const score = along + side * (dir === 'ArrowUp' || dir === 'ArrowDown' ? 0.6 : 2.5);
    if (score < bestScore) { best = el; bestScore = score; }
  }
  return best;
}
// Text boxes: a TV pops its on-screen keyboard up as soon as one gets focus, so moving onto one only
// highlights it (read-only); OK opens the keyboard, and leaving it makes it read-only again.
const TEXT_BOX = 'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]), textarea';
function tvLockText(el) {
  if (!el.matches?.(TEXT_BOX)) return;
  if (!el.dataset.tvManaged) {
    if (el.readOnly) return; // really read-only
    el.dataset.tvManaged = '1';
    el.addEventListener('blur', () => { if (tv.on && !el.dataset.tvOpening) el.readOnly = true; });
  }
  el.readOnly = true;
}
function tvUnlockText(el) {
  el.dataset.tvOpening = '1';
  el.readOnly = false;
  el.blur(); // focusing again is what brings up the keyboard
  el.focus({ preventScroll: true });
  delete el.dataset.tvOpening;
  try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* not a text type */ }
}
function tvFocus(el) {
  if (!el) return false;
  tvLockText(el);
  el.focus({ preventScroll: true });
  const shelf = el.closest('.shelf');
  if (shelf) {
    // A row slides so the highlighted title sits at its start (as on Netflix or Google TV), which
    // keeps the rows lined up with each other; the page then centres the row.
    const pad = parseFloat(getComputedStyle(shelf).paddingLeft) || 0;
    const card = (el.closest('.rank-card') || el.closest('.card') || el).getBoundingClientRect();
    shelf.scrollTo({ left: shelf.scrollLeft + card.left - shelf.getBoundingClientRect().left - pad, behavior: 'smooth' });
    const rail = (shelf.closest('.rail') || shelf).getBoundingClientRect();
    window.scrollBy({ top: rail.top + rail.height / 2 - innerHeight / 2, behavior: 'smooth' });
    return true;
  }
  el.scrollIntoView({ block: el.closest('.hero') ? 'end' : 'center', inline: 'nearest', behavior: 'smooth' });
  return true;
}
// Where focus starts on a new page: the pop-up's Play button, the banner's, or the first card.
function tvStart() {
  if (!tv.on) return;
  // Back from a pop-up: return to the card it was opened from.
  const back = tv.returnHref && !document.querySelector('#detail-layer') ? tv.returnHref : null;
  if (back) {
    tv.returnHref = null;
    const el = [...document.querySelectorAll(`main a[href="${CSS.escape(back)}"]`)].find((a) => !a.matches(TV_SKIP) && tvVisible(a));
    if (el) { tvFocus(el); return; }
  }
  const active = document.activeElement;
  if (active && active !== document.body && tvScope().contains(active) && tvVisible(active)) return;
  const scope = tvScope();
  // (Only something that can be highlighted: admin buttons hidden on TVs, like Collections' "New
  // collection", left nothing highlighted and the remote dead.)
  const first = [...scope.querySelectorAll('#detail-panel .btn.play, .hero .btn.play, .profile-picker .pp-profile, .card .cover, main .btn.primary, .tv-settings .btn')]
    .find((el) => !el.matches(TV_SKIP) && tvVisible(el)) || tvCandidates()[0];
  if (first) { tvLockText(first); first.focus({ preventScroll: true }); }
}

document.addEventListener('keydown', (e) => {
  if (!tv.on || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
  if (typeof player !== 'undefined' && player) return; // the player has its own keys
  const t = e.target;
  const typing = t.matches?.(TEXT_BOX) && !t.readOnly;
  // OK on a list of choices (Genre, Sort): open it. The arrows move on past it.
  if (e.key === 'Enter' && t.tagName === 'SELECT') { try { t.showPicker(); e.preventDefault(); } catch { /* the browser opens it */ } return; }
  // OK on a highlighted text box: now open the keyboard.
  if (e.key === 'Enter' && t.dataset?.tvManaged && t.readOnly) { e.preventDefault(); tvUnlockText(t); return; }
  const isArrow = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key);
  if (isArrow) {
    if (typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return; // move the cursor
    if (t.type === 'range' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    e.preventDefault();
    const from = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    if (!from) { tvStart(); return; }
    tvFocus(tvNeighbour(from, e.key));
    return;
  }
  // Back on a remote: close what's open, else go back a page.
  if (e.key === 'GoBack' || e.key === 'BrowserBack' || (e.key === 'Backspace' && !typing)) {
    e.preventDefault();
    marqueeBack();
  }
}, true);

// Back: closes the innermost thing that's open, else goes back a page. Returns false on the home page
// (the Android apps then leave). Also used for the Back button of the Android apps.
function marqueeBack() {
  if (typeof openPop !== 'undefined' && openPop) { closeMenu(); return true; }
  const modal = [...document.querySelectorAll('.modal-backdrop')].pop();
  if (modal) { modal.querySelector('[data-close], #pick-cancel')?.click(); return true; }
  if (document.querySelector('.profile-picker')) { document.querySelector('.profile-picker [data-pp="close"]')?.click(); return true; }
  if (document.querySelector('#detail-layer')) { if (!detailBack()) closeDetail(); return true; }
  if (typeof selecting !== 'undefined' && selecting.on) { endSelect(); return true; }
  if (location.hash && location.hash !== '#/' && location.hash !== '#') {
    if (state.inAppNav) history.back(); else location.hash = '#/';
    return true;
  }
  return false;
}
window.marqueeBack = marqueeBack;
