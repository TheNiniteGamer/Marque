'use strict';
/* Marquee web client — the opening animation and sound when Marquee opens (in a browser, and in the
   Android and Android TV apps, which show this web interface). Runs before everything else so it
   covers the page while it loads. Any key skips it; it never blocks clicks. Turned off under
   Account → On this browser / app (or the TV's Settings). */
(function intro() {
  const el = document.getElementById('intro');
  const pref = (k) => { try { return localStorage.getItem(`marquee:${k}`); } catch { return null; } };
  if (!el) return;
  if (pref('intro') === 'false' || /[?&]nointro\b/.test(location.search)) { el.remove(); return; }
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.classList.add(still ? 'still' : 'play');
  // (Browsers may not play sound before the page has been used; then it's just the picture.)
  if (pref('introSound') !== 'false') {
    const a = new Audio('/sounds/intro.mp3');
    a.volume = 0.8;
    a.play().catch(() => {});
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    el.classList.add('out');
    setTimeout(() => el.remove(), 500);
  };
  setTimeout(finish, still ? 900 : 2100);
  addEventListener('keydown', finish, { once: true });
})();
