'use strict';
/* Marquee web client — the video player: direct play, adaptive streaming and converting, tracks and
   subtitles, skip intro / credits, Up Next, casting and watch together. Helpers from app.js are used
   only when called. */

// ---------- player ----------
let player = null;
// Whether the server answers (a player that loses its stream checks this before giving up on it).
const serverUp = () => fetch('/api/health', { cache: 'no-store' }).then((r) => r.ok).catch(() => false);
function closePlayer() { if (player) { player.destroy(); player = null; } }
// A tab or browser closed mid-film: its place is saved (the reports send with keepalive).
window.addEventListener('pagehide', () => player?.report(true));

// HEVC (x265) this browser decodes itself (Safari; Chrome and Edge with a graphics card that can).
let probeVideo = null;
function browserHevc(v) {
  if (v?.codec !== 'hevc' && v?.videoCodec !== 'hevc') return false;
  const ten = /10/.test(v.profile || '') || /10/.test(v.pixFmt || '');
  const type = `video/mp4; codecs="${ten ? 'hvc1.2.4.L153.B0' : 'hvc1.1.6.L153.B0'}"`;
  probeVideo ||= document.createElement('video');
  return !!window.MediaSource?.isTypeSupported?.(type) || probeVideo.canPlayType(type) === 'probably';
}

// Which copy of a film this browser plays: the best one it plays as it is, else the best whose
// picture it takes unconverted, else the smallest (the least work for the server). Away from
// home, the smallest of those instead.
function chooseVersion(list) {
  const away = defaultQuality() !== 'original';
  const best = (l) => { const s = [...l].sort((a, b) => (b.height || 0) - (a.height || 0)); return away ? s[s.length - 1] : s[0]; };
  const asIs = (v) => v.directPlay || (browserHevc(v) && /\.(mp4|m4v|mov)$/i.test(v.fileName || '') && ['aac', 'mp3', 'opus', 'flac', null].includes(v.audioCodec));
  const direct = list.filter(asIs);
  if (direct.length) return best(direct);
  const remux = list.filter((v) => v.remux);
  if (remux.length) return best(remux);
  return [...list].sort((a, b) => (a.height || 0) - (b.height || 0))[0];
}

// Bedtime or the day's screen time (set by an admin for a profile): a message instead of the video.
function screenTimeNotice(b) {
  const m = openModal({ title: b.reason === 'bedtime' ? 'Bedtime' : b.reason === 'admin' ? 'Stopped' : 'That’s enough for today', body: html`<p style="margin:0;font-size:18px">${b.message}</p>`.s,
    footer: html`<button class="btn primary" data-close>OK</button>`.s });
  $('[data-close]', m.el).onclick = m.close;
  $('[data-close]', m.el).focus();
}

async function viewPlay({ params: [id], query, seq }) {
  closePlayer();
  // (Left, or another title picked, while this one was loading: the newer page wins.)
  const stale = () => seq !== renderSeq;
  let item = await api(`/api/items/${id}`);
  if (stale()) return;
  if (!item.media) { toast('This file cannot be played', true); return history.back(); }
  if (item.watchBlock) { screenTimeNotice(item.watchBlock); return history.back(); } // bedtime, or today's time used up
  let start = query.has('t') ? Number(query.get('t')) || 0 : 0;
  if (!query.has('t') && item.progress && !item.progress.watched && item.progress.position > 15) start = item.progress.position;
  // Watch together: start where the party is.
  const partyId = query.get('party');
  if (partyId) {
    const p = await api(`/api/parties/${partyId}`).catch((err) => { toast(err.message, true); return null; });
    if (stale()) return;
    if (p) start = partyPosition(p, p.serverNow - Date.now());
  }
  // Inside the Android app, videos open in the phone's native player (watch parties stay in the web player).
  if (window.MarqueeAndroid?.play && !partyId) {
    window.MarqueeAndroid.play(JSON.stringify({ id: item.id, start, autoplayNext: playerPref('autoplayNext'), subsOn: store.get('subsOn', false),
      autoSkipIntro: playerPref('autoSkipIntro'), skipFade: playerPref('skipFade'), nightMode: playerPref('nightMode'), quality: store.get('quality', ''),
      subLang: playerPref('subLang'), audioLang: playerPref('audioLang'), subSize: playerPref('subSize'), subStyle: playerPref('subStyle'),
      ...(query.get('v') ? { version: query.get('v') } : {}) }));
    if (state.inAppNav) history.back(); else location.replace(`#/item/${item.id}`);
    return;
  }
  // A film with several versions: the one picked on its page, or the best for this browser.
  if (item.versions?.length > 1) {
    const chosen = item.versions.find((v) => v.id === query.get('v')) || chooseVersion(item.versions);
    if (chosen && chosen.id !== item.id) item = { ...(await api(`/api/items/${chosen.id}`)), progress: item.progress };
    if (stale()) return;
  }
  closePlayer();
  player = new Player(item, start, { partyId });
}

// Where a watch party is now: its last known position, plus the time since then if it's playing.
// clockOffset = server clock − this device's clock.
function partyPosition(p, clockOffset) {
  return p.position + (p.playing ? Math.max(0, Date.now() + clockOffset - p.updatedAt) / 1000 : 0);
}

async function viewParty({ params: [id] }) {
  try {
    const p = await api(`/api/parties/${id}`);
    location.replace(`#/play/${p.itemId}?party=${p.id}`);
  } catch (err) {
    view.innerHTML = emptyState({ art: 'warn', error: true, title: 'Can’t join this watch party', text: err.message, actions: html`<a class="btn" href="#/">Go home</a>` }).s;
  }
}

const loadedScripts = new Map();
function loadScript(src) {
  if (!loadedScripts.has(src)) {
    loadedScripts.set(src, new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = src; s.onload = () => resolve(true); s.onerror = () => resolve(false);
      document.head.append(s);
    }));
  }
  return loadedScripts.get(src);
}

// On the home network the original file is best; from outside, adaptive streaming copes with
// slower connections (the server says which, since Tailscale reaches home addresses too). Users can pick a fixed choice on the Account page or in the player.
function defaultQuality() {
  const q = store.get('quality', '');
  if (q) return q;
  if (typeof state.away === 'boolean') return state.away ? 'auto' : 'original';
  const h = location.hostname;
  const home = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(h) || h.endsWith('.local') || !h.includes('.');
  return home ? 'original' : 'auto';
}

// Identifies this browser tab on the Activity page.
const PAGE_ID = Math.random().toString(36).slice(2, 12);

// Subtitles to turn on, best first: full ones before "forced" ones (only the foreign-language bits),
// text before pictures (those need the video converted).
const bySubRank = (subs) => [...subs].sort((a, b) => ((a.burn != null) * 2 + !!a.forced) - ((b.burn != null) * 2 + !!b.forced));

class Player {
  constructor(item, start, { partyId = null } = {}) {
    this.item = item;
    this.duration = item.duration || 0;
    this.quality = defaultQuality();
    this.mode = item.directPlay ? 'direct' : 'transcode';
    this.offset = 0;
    this.audio = 0;
    this.subId = store.get('subsOn', false) ? this.pickDefaultSub() : null;
    // The languages last picked for this show win (e.g. Japanese with English subtitles).
    const pref = item.tracks;
    if (pref?.audio) this.audio = Math.max(0, (item.audioTracks || []).findIndex((t) => t.lang === pref.audio));
    if (pref?.subs === 'off') this.subId = null;
    else if (pref?.subs) this.subId = bySubRank(item.subtitles).find((s) => s.lang === pref.subs)?.id || this.subId;
    // Otherwise the account's languages (Account → Playback), when the title has them.
    if (!pref?.audio && playerPref('audioLang')) {
      const i = (item.audioTracks || []).findIndex((t) => sameLang(t.lang, playerPref('audioLang')));
      if (i >= 0) this.audio = i;
    }
    if (!pref?.subs && playerPref('subLang')) {
      const s = bySubRank(item.subtitles).find((x) => sameLang(x.lang, playerPref('subLang')));
      if (s) this.subId = s.id;
    }
    // Subtitles off: a "forced" track in the language being listened to still shows (just the bits
    // in another language, as the film intends).
    const heard = item.audioTracks?.[this.audio]?.lang;
    if (!this.subId && heard) this.subId = item.subtitles.find((x) => x.forced && x.burn == null && sameLang(x.lang, heard))?.id || null;
    this.lastReported = -1;
    this.dragging = false;
    this.pb = null;          // signed links + streaming session from /playback
    this.hls = null;
    this.casting = false;
    this.castTime = 0;

    const it = item;
    const subtitle = it.type === 'episode' ? [it.showTitle, epLabel(it)].filter(Boolean).join(' · ') : it.year;
    this.root = document.createElement('div');
    this.root.className = `player subs-${playerPref('subSize')} subs-${playerPref('subStyle')}`;
    this.root.innerHTML = html`
      <video playsinline preload="auto" crossorigin="anonymous" x-webkit-airplay="allow"></video>
      <div class="p-subs" aria-live="off"></div>
      <div class="p-spinner"></div>
      <div class="p-cast-msg" hidden><div class="p-cast-icon">📺</div><div>Playing on <b class="p-cast-name"></b></div>
        <button class="btn small" data-a="cast-stop">Stop casting</button></div>
      <button class="btn p-skip" data-a="skip-intro" hidden>Skip Intro ⏭</button>
      ${it.cast?.length ? html`<div class="p-cast" hidden><div class="p-cast-head">In this</div><div class="cast-row">${it.cast.slice(0, 6).map(personCard)}</div></div>` : ''}
      <div class="p-top">
        <button class="p-btn" data-a="close" title="Back (Esc)">←</button>
        <div class="p-title">${it.title}<small>${subtitle}</small></div>
        <span class="p-spacer"></span>
        <span class="p-badge" id="p-mode"></span>
        <button class="p-btn p-party" data-a="party" title="Watch together">👥<span class="p-party-count"></span></button>
        <button class="p-btn" data-a="airplay" title="AirPlay" hidden>⇪</button>
        <button class="p-btn" data-a="cast" title="Cast to a TV" hidden><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M1 18v3h3a3 3 0 0 0-3-3zm0-4v2a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7zm0-4v2a9 9 0 0 1 9 9h2A11 11 0 0 0 1 10zm20-7H3a2 2 0 0 0-2 2v3h2V5h18v14h-7v2h7a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/></svg></button>
      </div>
      <div class="p-bottom">
        <div class="p-seek"><div class="p-buffer"></div><div class="p-chapters"></div><input type="range" class="p-range" min="0" step="0.1" value="0" aria-label="Seek"><div class="p-hover-thumb" hidden></div><div class="p-hover-time" hidden></div></div>
        <div class="p-row">
          <button class="p-btn big" data-a="toggle" title="Play/Pause (Space)">▶</button>
          <button class="p-btn" data-a="back" title="Back 10s (←)">⟲</button>
          <button class="p-btn" data-a="fwd" title="Forward 30s (→)">⟳</button>
          <span class="p-time">0:00 / ${fmtClock(this.duration)}</span>
          <span class="p-spacer"></span>
          ${it.audioTracks.length > 1 ? html`<select data-a="audio" class="p-hide-sm" title="Audio">${it.audioTracks.map((t) => html`<option value="${t.index}">${t.label}</option>`)}</select>` : ''}
          ${it.subtitles.length || state.status?.subtitleSearch ? html`<select data-a="subs" title="Subtitles (c)">${this.subOptions()}</select>` : ''}
          <select data-a="quality" title="Quality" hidden></select>
          <button class="p-btn" data-a="mute" title="Mute (m)">🔊</button>
          <input type="range" class="p-volume" min="0" max="1" step="0.05" aria-label="Volume">
          <button class="p-btn p-hide-sm ${playerPref('nightMode') ? 'on' : ''}" data-a="night" title="Night mode: clearer dialogue, quieter loud scenes">☾</button>
          <select data-a="speed" class="p-speed" title="Playback speed (&lt; &gt;)">${[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => html`<option value="${r}" ${r === 1 ? 'selected' : ''}>${r === 1 ? 'Normal' : `${r}×`}</option>`)}</select>
          ${document.pictureInPictureEnabled ? html`<button class="p-btn p-hide-sm" data-a="pip" title="Picture-in-picture (p)">⧉</button>` : ''}
          ${it.type === 'episode' && state.user.role === 'admin' ? html`<button class="p-btn p-hide-sm" data-a="intro-edit" title="Edit this episode's intro">✂</button>` : ''}
          ${it.next ? html`<button class="p-btn" data-a="next" title="Next episode">⏭</button>` : ''}
          <button class="p-btn" data-a="fs" title="Fullscreen (f)">⛶</button>
        </div>
      </div>`.s;
    $('#player-root').append(this.root);
    this.v = $('video', this.root);
    this.pendingStart = start; // (closed before it loads: the resume point stays where it was)
    if (playerPref('nightMode')) this.setNight(true);
    this.range = $('.p-range', this.root);
    this.range.max = this.duration || 0;
    this.v.volume = store.get('volume', 1);
    this.v.muted = store.get('muted', false);
    $('.p-volume', this.root).value = this.v.volume;
    this.bind();
    this.spinner(true);
    this.init(start).then(() => { if (partyId && this.root.isConnected) this.joinParty(partyId); });
    this.reportTimer = setInterval(() => this.report(), 10_000);
    document.title = `${it.type === 'episode' ? `${it.showTitle} - ` : ''}${it.title} · Marquee`;
  }

  async init(start) {
    try { this.pb = await api(`/api/items/${this.item.id}/playback`); } catch { this.pb = null; }
    if (!this.root.isConnected) return;
    const qs = this.pb?.qualities || [];
    // Adaptive streams are H.264 + AAC; a browser without H.264 (some Linux builds) can't use them.
    const h264 = window.MediaSource?.isTypeSupported?.('video/mp4; codecs="avc1.640028,mp4a.40.2"');
    this.canHls = qs.length > 0 && (this.nativeHls() || (h264 && await loadScript('/vendor/hls.light.min.js') && window.Hls?.isSupported()));
    if (!this.root.isConnected) return;
    if (this.canHls) {
      const sel = $('[data-a=quality]', this.root);
      // Away from home the admin may have limited the quality: then the original file isn't offered.
      const original = this.pb.originalAllowed !== false;
      if (!original && this.quality === 'original') this.quality = 'auto';
      sel.innerHTML = html`${original ? html`<option value="original">Original</option>` : ''}<option value="auto">Auto</option>${qs.map((q) => html`<option value="${q.id}">${q.label}</option>`)}`.s;
      sel.title = this.pb.limit ? `Quality is limited to ${this.pb.limit} away from home` : 'Quality';
      if (![...(original ? ['original'] : []), 'auto', ...qs.map((q) => q.id)].includes(this.quality)) {
        // A fixed quality above this video's resolution: use the best one it has.
        this.quality = /^\d+p$/.test(this.quality) ? qs[0].id : 'original';
      }
      sel.value = this.quality;
      sel.hidden = false;
    } else this.quality = 'original';
    this.setModeFromQuality();
    this.setupRemote();
    this.loadTrickplay();
    this.renderChapters();
    this.v.addEventListener('loadedmetadata', () => this.renderChapters());
    if (Cast.state() === 'CONNECTED') this.startCasting(start);
    else this.load(start);
  }

  // Chapter marks on the seek bar (from the video's own chapters, e.g. downloaded YouTube videos).
  renderChapters() {
    const box = $('.p-chapters', this.root);
    const chapters = this.item.chapters || [];
    box.innerHTML = this.total ? chapters.filter((c) => c.start > 0 && c.start < this.total)
      .map((c) => html`<i style="left:${pct(c.start, this.total)}%" title="${c.title}"></i>`.s).join('') : '';
  }

  chapterAt(t) {
    let found = null;
    for (const c of this.item.chapters || []) if (c.start <= t) found = c.title;
    return found;
  }

  // Seek preview thumbnails: the server makes them the first time a video is opened.
  async loadTrickplay() {
    for (let tries = 0; tries < 120 && this.root.isConnected; tries++) {
      const info = await api(`/api/items/${this.item.id}/trickplay`).catch(() => null);
      if (!info) return;
      if (info.ready) { this.trick = info; return; }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  showThumb(el, f) {
    const t = this.trick;
    if (!t) { el.hidden = true; return; }
    const i = Math.min(t.count - 1, Math.floor((f * this.total) / t.interval));
    const perSheet = t.cols * t.rows;
    const sheet = Math.min(t.sheets, Math.floor(i / perSheet) + 1);
    const k = i % perSheet;
    el.hidden = false;
    const w = el.parentElement.clientWidth; // keep the picture on screen at either end
    el.style.left = `${Math.min(w - t.width / 2, Math.max(t.width / 2, f * w))}px`;
    el.style.width = `${t.width}px`;
    el.style.height = `${t.height}px`;
    el.style.backgroundImage = `url("/api/items/${this.item.id}/trickplay/${sheet}${this.tok()}")`;
    el.style.backgroundPosition = `-${(k % t.cols) * t.width}px -${Math.floor(k / t.cols) * t.height}px`;
  }

  nativeHls() { return !!this.v.canPlayType('application/vnd.apple.mpegurl') && !/Android/.test(navigator.userAgent); }

  // Original quality: the file as it is if the browser can play it; else, for an MKV's H.264 (say),
  // its picture unconverted in adaptive streaming ("source"); else converted by the server.
  setModeFromQuality() {
    this.remux = false;
    if (this.quality !== 'original' && this.canHls) this.mode = 'hls';
    else if ((this.item.directPlay || this.hevcFile()) && this.audio === 0 && this.burn == null && !this.directFailed) this.mode = 'direct';
    else if (this.pb?.remux && this.canHls && this.burn == null && !this.remuxFailed) { this.mode = 'hls'; this.remux = true; }
    else this.mode = 'transcode';
  }

  // HEVC (x265) this browser decodes itself (Safari; Chrome and Edge with a graphics card that can).
  hevcOk() { return !this.hevcFailed && browserHevc(this.item.media?.video); }
  // …in an MP4 with sound the browser plays too: played as it is.
  hevcFile() {
    const ext = (this.item.fileName || '').toLowerCase().split('.').pop();
    const a = this.item.media?.audio?.[0]?.codec;
    return ['mp4', 'm4v', 'mov'].includes(ext) && (!a || ['aac', 'mp3', 'opus', 'flac'].includes(a)) && this.hevcOk();
  }
  // …in anything else (an MKV): the server sends the picture as it is, converting only the sound.
  // (Not in Safari, which can't play the server's one-piece stream.)
  hevcQuery() { return this.hevcOk() && !this.nativeHls() && this.burn == null ? '&hevc=1' : ''; }

  // Picture subtitles (Blu-ray / DVD) are drawn into the video by the server: index of that track, or null.
  get burn() { return this.item.subtitles.find((s) => s.id === this.subId)?.burn ?? null; }
  burnQuery() { return this.burn != null ? `&burn=${this.burn}` : ''; }

  subOptions() {
    return html`<option value="">Subtitles off</option>${this.item.subtitles.map((s) => html`<option value="${s.id}" ${s.id === this.subId ? 'selected' : ''}>${s.label}</option>`)}
      ${state.status?.subtitleSearch && ['movie', 'episode'].includes(this.item.type) ? html`<option value="__search">Search online…</option>` : ''}`;
  }

  // Night mode: rumble cut, speech lifted, loud and quiet evened out (Web Audio, so it works for
  // direct play too). Once routed through Web Audio the video stays routed; off is a straight path.
  setNight(on) {
    this.night = on;
    if (!this.audioCtx && !on) return;
    try {
      if (!this.audioCtx) {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const src = ctx.createMediaElementSource(this.v);
        const hp = Object.assign(ctx.createBiquadFilter(), { type: 'highpass' }); hp.frequency.value = 90;
        const eq = Object.assign(ctx.createBiquadFilter(), { type: 'peaking' }); eq.frequency.value = 2200; eq.Q.value = 1.2; eq.gain.value = 4;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -28; comp.knee.value = 12; comp.ratio.value = 5; comp.attack.value = 0.008; comp.release.value = 0.22;
        const gain = ctx.createGain(); gain.gain.value = 1.8;
        this.audioCtx = ctx;
        this.nightChain = [src, hp, eq, comp, gain];
        this.v.addEventListener('play', () => ctx.resume().catch(() => {}));
      }
      const [src, hp, eq, comp, gain] = this.nightChain;
      for (const n of this.nightChain) n.disconnect();
      const out = this.audioCtx.destination;
      if (on) { src.connect(hp); hp.connect(eq); eq.connect(comp); comp.connect(gain); gain.connect(out); } else src.connect(out);
      this.audioCtx.resume().catch(() => {});
    } catch { /* no Web Audio: plain sound */ }
    $('[data-a=night]', this.root)?.classList.toggle('on', on);
  }

  // Episodes: the show remembers the sound and subtitle languages picked.
  rememberTracks() {
    if (this.item.type !== 'episode') return;
    const audio = this.item.audioTracks?.[this.audio]?.lang || null;
    const subs = this.subId ? this.item.subtitles.find((s) => s.id === this.subId)?.lang || null : 'off';
    api(`/api/items/${this.item.id}/tracks`, { method: 'PUT', body: { audio, subs } }).catch(() => {});
  }

  pickDefaultSub() {
    const subs = bySubRank(this.item.subtitles);
    const lang = (navigator.language || 'en').slice(0, 2);
    return (subs.find((s) => s.lang && s.lang.toLowerCase().startsWith(lang)) || subs[0])?.id || null;
  }

  // Signed links work without the login cookie, which AirPlay and cast devices don't have.
  tok(sep = '?') { return this.pb?.token ? `${sep}mt=${encodeURIComponent(this.pb.token)}` : ''; }

  hlsUrl({ sid = this.pb.sid, quality = this.remux ? 'source' : this.quality } = {}) {
    return `/api/items/${this.item.id}/hls/master.m3u8?sid=${sid}&audio=${this.audio}${quality !== 'auto' ? `&q=${quality}` : ''}${this.burnQuery()}${this.tok('&')}`;
  }

  get time() {
    if (this.casting) return this.castTime;
    // Until the new source has loaded, the position is where we asked it to start.
    if (this.pendingStart != null && this.v.readyState < 1) return this.pendingStart;
    return this.offset + (this.v.currentTime || 0);
  }
  get total() {
    return this.mode !== 'transcode' && !this.casting && Number.isFinite(this.v.duration) && this.v.duration > 0 ? this.v.duration : this.duration;
  }

  destroyHls() { if (this.hls) { this.hls.destroy(); this.hls = null; } }

  load(t) {
    t = Math.max(0, this.duration ? Math.min(t, this.duration - 2) : t);
    this.spinner(true);
    this.pendingStart = t;
    if (this.mode !== 'hls') this.destroyHls();
    if (this.mode === 'direct') {
      this.offset = 0;
      const seekTo = () => { this.v.currentTime = t; };
      if (!this.v.src.includes('/stream')) {
        this.v.src = `/api/items/${this.item.id}/stream${this.tok()}`;
        this.v.addEventListener('loadedmetadata', seekTo, { once: true });
      } else seekTo();
      this.applySubs();
      this.v.play().catch(() => this.spinner(false));
    } else if (this.mode === 'hls') {
      this.offset = 0;
      this.loadHls(t);
    } else {
      // Copied video streams can only start on a keyframe; ask where the stream will really begin.
      const seq = (this.loadSeq = (this.loadSeq || 0) + 1);
      this.offset = t;
      this.updateTime();
      const req = t.toFixed(3);
      api(`/api/items/${this.item.id}/seekpoint?t=${req}${this.burnQuery()}${this.hevcQuery()}`).catch(() => ({ start: t })).then(({ start }) => {
        if (seq !== this.loadSeq || !this.root.isConnected) return;
        this.offset = start;
        this.v.src = `/api/items/${this.item.id}/transcode?start=${req}&audio=${this.audio}${this.pb?.sid ? `&sid=${this.pb.sid}` : ''}${this.burnQuery()}${this.hevcQuery()}${this.tok('&')}`;
        this.applySubs();
        this.v.play().catch(() => this.spinner(false));
      });
    }
    this.updateBadge();
    this.updateTime();
  }

  loadHls(t) {
    this.destroyHls();
    const src = this.hlsUrl();
    if (window.Hls?.isSupported() && !this.nativeHls()) {
      const Hls = window.Hls;
      const slow = { maxTimeToFirstByteMs: 60_000, maxLoadTimeMs: 120_000, timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 }, errorRetry: { maxNumRetry: 4, retryDelayMs: 1000, maxRetryDelayMs: 8000 } };
      const hls = (this.hls = new Hls({ startPosition: t, maxBufferLength: 40, backBufferLength: 60, fragLoadPolicy: { default: slow }, enableWorker: true }));
      this.hlsRecoveries = 0;
      hls.on(Hls.Events.ERROR, (ev, d) => {
        if (!d.fatal || hls !== this.hls) return;
        // (Every conversion place is taken by people watching: trying again won't help.)
        if (d.response?.code === 503) return this.hlsFailed('busy');
        if (this.hlsRecoveries++ < 2 && hls.levels?.length) {
          if (d.type === Hls.ErrorTypes.MEDIA_ERROR) return hls.recoverMediaError();
          if (d.type === Hls.ErrorTypes.NETWORK_ERROR) return hls.startLoad();
        }
        this.hlsFailed(d.details);
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, () => this.updateBadge());
      hls.loadSource(src);
      hls.attachMedia(this.v);
    } else {
      // Safari plays HLS itself (and can AirPlay it).
      this.v.src = src;
      this.v.addEventListener('loadedmetadata', () => { if (t > 0) this.v.currentTime = t; }, { once: true });
    }
    this.applySubs();
    this.v.play().catch(() => this.spinner(false));
  }

  async hlsFailed(why) {
    if (!(await serverUp())) return this.reconnect();
    if (!this.root.isConnected || this.reconnecting) return;
    console.warn('Adaptive streaming failed:', why);
    if (this.remux) {
      // The unconverted picture didn't play: the server converts it instead.
      const t = this.time;
      this.destroyHls();
      this.remuxFailed = true;
      this.setModeFromQuality();
      this.load(t);
      return;
    }
    const t = this.time;
    this.destroyHls();
    toast(why === 'busy' ? 'The server is busy converting for other people — trying Original quality' : 'Adaptive streaming failed — switching to Original quality', why === 'busy');
    this.quality = 'original';
    const sel = $('[data-a=quality]', this.root); if (sel) sel.value = 'original';
    this.setModeFromQuality();
    this.load(t);
  }

  setQuality(q) {
    const t = this.time;
    const wasPaused = this.v.paused;
    this.quality = q;
    store.set('quality', q);
    this.setModeFromQuality();
    if (this.casting) { this.startCasting(t); return; }
    this.v.removeAttribute('src');
    this.load(t);
    if (wasPaused) this.v.addEventListener('playing', () => this.v.pause(), { once: true });
  }

  updateBadge() {
    const el = $('#p-mode', this.root);
    if (!el) return;
    if (this.mode === 'hls' && this.remux) el.textContent = 'Original · not converted';
    else if (this.mode === 'hls') {
      const lvl = this.hls?.levels?.[this.hls.currentLevel];
      const name = lvl ? `${lvl.height}p` : this.quality === 'auto' ? '' : this.quality;
      el.textContent = this.quality === 'auto' ? `Auto${name ? ` · ${name}` : ''}` : `Converting · ${name}`;
    } else el.textContent = this.mode === 'direct' ? 'Direct Play' : 'Transcoding';
  }

  seek(t) {
    t = Math.max(0, Math.min(t, this.total || t));
    if (this.casting) {
      Cast.player.currentTime = t;
      Cast.controller.seek();
      this.castTime = t;
      this.updateTime();
      this.partySend();
      return;
    }
    if (this.mode !== 'transcode') { this.v.currentTime = t; return; }
    // Within what the current transcode has already buffered? Seek locally instead of restarting ffmpeg.
    const b = this.v.buffered;
    const local = t - this.offset;
    for (let i = 0; i < b.length; i++) if (local >= b.start(i) && local <= b.end(i) - 0.5) { this.v.currentTime = local; return; }
    const wasPaused = this.v.paused;
    this.load(t);
    if (wasPaused) this.v.addEventListener('playing', () => this.v.pause(), { once: true });
  }

  subUrl(id, offset = 0) { return `/api/items/${this.item.id}/subtitles/${id}?offset=${offset.toFixed(2)}${this.tok('&')}`; }

  applySubs() {
    $$('track', this.v).forEach((t) => t.remove());
    const box = $('.p-subs', this.root);
    box.replaceChildren();
    if (!this.subId || this.burn != null) return;
    const sub = this.item.subtitles.find((s) => s.id === this.subId);
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = sub?.label || 'Subtitles';
    if (sub?.lang) track.srclang = sub.lang;
    track.src = this.subUrl(this.subId, this.offset);
    track.default = true;
    this.v.append(track);
    // Cues are rendered in our own overlay (track mode "hidden") so they can move clear of the controls.
    const tt = track.track;
    for (const other of this.v.textTracks) other.mode = other === tt ? 'hidden' : 'disabled';
    tt.addEventListener('cuechange', () => {
      box.replaceChildren(...[...(tt.activeCues || [])].map((c) => {
        const line = document.createElement('span');
        line.append(c.getCueAsHTML());
        return line;
      }));
    });
  }

  spinner(on) { $('.p-spinner', this.root).hidden = !on || this.casting; }

  updateTime() {
    const t = this.time, total = this.total;
    if (!this.dragging) {
      this.range.max = total || 0;
      this.range.value = t;
      this.range.style.setProperty('--pct', `${pct(t, total)}%`);
    }
    $('.p-time', this.root).textContent = `${fmtClock(this.dragging ? Number(this.range.value) : t)} / ${fmtClock(total)}`;
    this.updateIntro(t);
  }

  // "Skip Intro" while the detected theme song plays (or skip it automatically, once), and "Skip
  // Credits" at the end of a film (episodes get the Up Next card). The button fades after the
  // account's skipFade seconds and comes back while the controls are showing.
  updateIntro(t) {
    const credits = this.item.credits;
    if (credits && this.item.next && t >= credits.start && t < credits.start + 30 && !this.creditsShown && !this.dragging) {
      this.creditsShown = true;
      this.showUpNext(true);
    }
    const intro = this.item.intro;
    const btn = $('[data-a=skip-intro]', this.root);
    const inIntro = !!intro && t >= intro.start && t < intro.end - 1;
    if (inIntro && playerPref('autoSkipIntro') && !this.autoSkipped && (this.casting || !this.v.paused)) {
      this.autoSkipped = true;
      this.seek(intro.end);
      toast('Skipped the intro');
      return;
    }
    const inCredits = !!credits && !this.item.next && this.total > 0 && t >= credits.start && t < this.total - 2;
    const recap = this.item.recap;
    const inRecap = !!recap && t >= recap.start && t < recap.end - 1;
    const part = inRecap ? 'recap' : inIntro ? 'intro' : inCredits ? 'credits' : null;
    if (part !== this.skipPart) {
      this.skipPart = part;
      this.skipSince = Date.now();
      if (part) btn.textContent = { recap: 'Skip Recap ⏭', intro: 'Skip Intro ⏭', credits: 'Skip Credits ⏭' }[part];
    }
    btn.hidden = !part;
    const fade = playerPref('skipFade');
    btn.classList.toggle('faded', !!part && fade > 0 && Date.now() - this.skipSince > fade * 1000 && this.root.classList.contains('idle'));
  }

  updateBuffer() {
    const b = this.v.buffered, total = this.total;
    if (!b.length || !total) return;
    const ct = this.v.currentTime;
    let end = 0;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= ct + 1) end = Math.max(end, b.end(i));
    $('.p-buffer', this.root).style.width = `${pct(this.offset + end, total)}%`;
  }

  showControls() {
    this.root.classList.remove('idle');
    clearTimeout(this.idleTimer);
    if (!this.paused) this.idleTimer = setTimeout(() => this.root.classList.add('idle'), 3000);
  }

  get paused() { return this.casting ? !!Cast.player?.isPaused : this.v.paused; }

  toggle() {
    if (this.casting) return Cast.controller.playOrPause();
    if (this.v.paused) this.v.play().catch(() => {}); else this.v.pause();
  }

  // Saves the resume position, and tells the admin's Activity page what's playing (every 10 s,
  // also while paused; `stopped` when the player closes).
  report(stopped = false) {
    if (this.markedWatched || (this.reconnecting && !stopped)) return;
    const t = this.reconnecting ? this.lastGood ?? this.time : this.time;
    if (this.casting && t <= 0) return;
    this.lastReported = t;
    fetch(`/api/items/${this.item.id}/progress`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ position: t, paused: this.paused, mode: this.casting ? 'cast' : this.mode, quality: this.mode === 'hls' ? (this.remux ? 'source' : this.quality) : null, client: PAGE_ID, stopped }),
    }).then((r) => r.json()).then((d) => {
      // Bedtime has started, or today's screen time is used up (lib/screentime.js).
      if (d?.stop && !stopped && this.root.isConnected) { this.v.pause(); screenTimeNotice(d.stop); this.close(); }
    }).catch(() => {});
  }

  // ---- casting (Chromecast) and AirPlay ----
  setupRemote() {
    if (window.WebKitPlaybackTargetAvailabilityEvent) {
      this.v.addEventListener('webkitplaybacktargetavailabilitychanged', (e) => { $('[data-a=airplay]', this.root).hidden = e.availability !== 'available'; });
    }
    if (!Cast.supported()) return;
    Cast.load().then((ok) => {
      if (!ok || !this.root.isConnected) return;
      const btn = $('[data-a=cast]', this.root);
      const refresh = (state) => {
        btn.hidden = state === 'NO_DEVICES_AVAILABLE' || !state;
        btn.classList.toggle('on', state === 'CONNECTED');
        // Disconnected from the TV (or the TV stopped): carry on here.
        if (this.casting && state !== 'CONNECTED') this.stopCasting(false);
      };
      this.offCast = Cast.on(refresh);
      refresh(Cast.state());
    });
  }

  // Where the TV can reach Marquee: the admin's setting, else this page's address unless it is
  // "localhost" (meaningless to a TV), else this computer's network address.
  castBase() {
    const c = this.pb?.cast || {};
    if (c.configured) return c.configured;
    if (!/^(localhost|127\.|\[::1\])/.test(location.hostname)) return location.origin;
    return c.lan?.[0] || null;
  }

  async castClicked() {
    if (Cast.state() === 'CONNECTED' && this.casting) { Cast.disconnect(); return; }
    if (!(await Cast.connect())) return;
    this.startCasting(this.time);
  }

  async startCasting(t) {
    const base = this.castBase();
    if (!base || !this.pb) {
      toast('Your TV can’t reach “localhost”. Set the address for cast devices in Settings → Transcoding.', true);
      return this.load(t);
    }
    const it = this.item;
    // MP4 files TVs can play are sent as they are; everything else as adaptive streaming.
    const direct = it.directPlay && this.audio === 0 && this.burn == null && /\.(mp4|m4v)$/i.test(it.fileName || '') && (this.quality === 'original' || !this.canHls) && this.pb.originalAllowed !== false;
    const media = direct
      ? { url: `${base}/api/items/${it.id}/stream${this.tok()}`, contentType: 'video/mp4' }
      : { url: base + this.hlsUrl({ sid: `${this.pb.sid}c`, quality: this.quality === 'original' || !/^\d+p$/.test(this.quality) ? 'auto' : this.quality }), contentType: 'application/x-mpegURL', hls: true };
    if (!direct && !this.pb.qualities.length) { toast('This video can’t be cast', true); return this.load(t); }
    this.v.pause();
    this.destroyHls();
    this.v.removeAttribute('src');
    this.v.load();
    this.casting = true;
    this.castTime = t;
    this.root.classList.add('casting');
    $('.p-cast-msg', this.root).hidden = false;
    $('.p-cast-name', this.root).textContent = Cast.deviceName();
    $('#p-mode', this.root).textContent = `Casting${media.hls ? '' : ' · Original'}`;
    $('[data-a=toggle]', this.root).textContent = '❚❚';
    this.spinner(false);
    this.bindCastEvents();
    try {
      await Cast.play({
        ...media, title: it.title, subtitle: it.type === 'episode' ? [it.showTitle, epLabel(it)].filter(Boolean).join(' · ') : it.year,
        image: `${base}/api/art/backdrop/${it.id}${this.tok()}`, duration: this.duration, startTime: t,
        subtitles: it.subtitles.filter((s) => s.burn == null).map((s) => ({ id: s.id, label: s.label, lang: s.lang, url: base + this.subUrl(s.id) })), activeSub: this.subId,
      });
    } catch (err) {
      toast(`Casting failed${err?.code ? ` (${err.code})` : ''}`, true);
      this.stopCasting(false);
    }
  }

  bindCastEvents() {
    if (this.castBound) return;
    this.castBound = true;
    const T = window.cast.framework.RemotePlayerEventType;
    this.castHandlers = {
      [T.CURRENT_TIME_CHANGED]: () => { if (!this.casting) return; this.castTime = Cast.player.currentTime || 0; this.updateTime(); },
      [T.IS_PAUSED_CHANGED]: () => { if (!this.casting) return; $('[data-a=toggle]', this.root).textContent = Cast.player.isPaused ? '▶' : '❚❚'; this.report(); this.showControls(); this.partySend(); },
      [T.PLAYER_STATE_CHANGED]: () => {
        if (!this.casting) return;
        // IDLE after playing to the end: same as reaching the end locally.
        if (Cast.player.playerState === 'IDLE' && this.duration && this.castTime > this.duration - 5) { this.castFinished = true; this.onEnded(); }
      },
    };
    for (const [ev, fn] of Object.entries(this.castHandlers)) Cast.controller.addEventListener(ev, fn);
  }

  unbindCastEvents() {
    if (!this.castBound) return;
    for (const [ev, fn] of Object.entries(this.castHandlers)) Cast.controller.removeEventListener(ev, fn);
    this.castBound = false;
  }

  stopCasting(disconnect = true) {
    if (!this.casting) return;
    this.report();
    const t = this.castTime;
    this.casting = false;
    this.unbindCastEvents();
    this.root.classList.remove('casting');
    $('.p-cast-msg', this.root).hidden = true;
    if (disconnect) Cast.disconnect();
    if (!this.castFinished && this.root.isConnected) { this.v.removeAttribute('src'); this.load(t); }
  }

  close() {
    if (state.inAppNav) history.back();
    else location.hash = `#/item/${this.item.id}`;
  }

  playNext(auto = false) {
    if (!this.item.next) return;
    // Three episodes in a row started by themselves, with nobody touching anything: ask first
    // (as the TV apps do), so a forgotten TV doesn't play all night.
    if (auto && (Number(new URLSearchParams(location.hash.split('?')[1] || '').get('chain')) || 0) >= 3) return this.askStillWatching();
    // Leaving during the credits counts as having watched the episode.
    if (this.item.credits && this.time >= this.item.credits.start - 1) {
      this.markedWatched = true; // (and no position report afterwards, which would undo it)
      fetch(`/api/items/${this.item.id}/watched`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true, body: '{"watched":true}' }).catch(() => {});
    }
    // In a watch party, everyone moves on to the next episode together.
    if (this.partyId) this.partyPost({ itemId: this.item.next.id, playing: true, position: 0 });
    const chain = auto && !this.touched ? (Number(new URLSearchParams(location.hash.split('?')[1] || '').get('chain')) || 0) + 1 : 0;
    location.replace(`#/play/${this.item.next.id}?t=0${this.partyId ? `&party=${this.partyId}` : ''}${chain ? `&chain=${chain}` : ''}`);
  }

  askStillWatching() {
    $('.p-upnext', this.root)?.remove();
    const box = document.createElement('div');
    box.className = 'p-upnext';
    box.innerHTML = html`<div><b>Are you still watching?</b></div><div class="muted">${this.item.showTitle || this.item.title}</div>
      <div class="row"><button class="btn primary small" data-a="still-yes">Continue watching</button><button class="btn small" data-a="still-no">Back to browsing</button></div>`.s;
    this.root.append(box);
    this.root.classList.remove('idle');
    $('[data-a=still-yes]', box).onclick = () => { this.touched = true; this.playNext(); };
    $('[data-a=still-no]', box).onclick = () => this.close();
    $('[data-a=still-yes]', box).focus();
  }

  // ---- watch together ----
  async partyClicked() {
    if (!this.partyId) {
      try {
        // The party starts exactly where (and as) this player is.
        const p = await api('/api/parties', { method: 'POST', body: { itemId: this.item.id, position: this.time, playing: !this.paused } });
        this.joinParty(p.id);
        history.replaceState(null, '', `#/play/${this.item.id}?party=${p.id}`);
      } catch (err) { return toast(err.message, true); }
    }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    const link = `${location.origin}${location.pathname}#/party/${this.partyId}`;
    const m = openModal({
      title: 'Watch together',
      body: html`<div class="form">
        <p style="margin:0">Send this link to people with an account on this server. Play, pause and skipping stay in sync for everyone, and so does moving on to the next episode.</p>
        <div class="row"><input class="input" readonly value="${link}" id="party-link" style="flex:1"><button class="btn small primary" id="party-copy">Copy</button></div>
        <p class="muted" style="margin:0">Watching now: <b id="party-members">${(this.partyState?.members || []).join(', ') || '…'}</b></p>
      </div>`.s,
      footer: html`<button class="btn danger" id="party-leave">Leave the party</button><button class="btn" data-close>Close</button>`.s,
    });
    $('#party-copy', m.el).onclick = () => { $('#party-link', m.el).select(); navigator.clipboard?.writeText(link).then(() => toast('Link copied'), () => document.execCommand('copy')); };
    $('#party-leave', m.el).onclick = () => { this.leaveParty(); m.close(); toast('You left the watch party'); };
    m.el.querySelector('footer [data-close]').onclick = () => m.close();
  }

  joinParty(id) {
    this.partyId = id;
    this.clientId = Math.random().toString(36).slice(2, 12);
    this.clockOffset = 0;
    this.es = new EventSource(`/api/parties/${id}/events?client=${this.clientId}`);
    this.es.onmessage = (e) => this.onPartyState(JSON.parse(e.data));
    this.es.onerror = () => {
      if (this.es?.readyState === EventSource.CLOSED) { toast('The watch party has ended', true); this.leaveParty(); }
    };
    this.root.classList.add('in-party');
    this.driftTimer = setInterval(() => this.checkDrift(), 4000);
  }

  leaveParty() {
    this.es?.close();
    this.es = null;
    clearInterval(this.driftTimer);
    this.partyId = null;
    this.partyState = null;
    this.root.classList.remove('in-party');
    $('.p-party-count', this.root).textContent = '';
    if (location.hash.includes('party=')) history.replaceState(null, '', `#/play/${this.item.id}`);
  }

  onPartyState(s) {
    this.partyState = s;
    this.clockOffset = s.serverNow - Date.now();
    $('.p-party-count', this.root).textContent = s.members.length > 1 ? String(s.members.length) : '';
    $('[data-a=party]', this.root).title = `Watch together: ${s.members.join(', ')}`;
    const names = $('#party-members'); if (names) names.textContent = s.members.join(', ');
    if (s.from === this.clientId) return; // our own change coming back
    if (s.itemId !== this.item.id) { location.replace(`#/play/${s.itemId}?t=0&party=${s.id}`); return; }
    this.applyParty();
  }

  // Does this player match the party (playing/paused, and within `slack` seconds)?
  inSync(slack) {
    const s = this.partyState;
    return s.playing === !this.paused && Math.abs(this.time - partyPosition(s, this.clockOffset)) < slack;
  }

  // Bring this player in line with the party.
  applyParty() {
    const s = this.partyState;
    const t = partyPosition(s, this.clockOffset);
    if (Math.abs(this.time - t) > 1.5) this.seek(t);
    if (s.playing === this.paused) this.toggle();
  }

  // Every few seconds: catch up if this player fell behind (slow connection) or missed a change.
  checkDrift() {
    if (!this.partyState || this.v.seeking || (!this.casting && this.v.readyState < 3)) return;
    if (Date.now() - (this.lastPartySend || 0) < 3000) return; // our own change is on its way
    if (!this.inSync(2.5)) this.applyParty();
  }

  // After a play, pause or seek: if this player now differs from the party, the person here did
  // something, so tell everyone. (Changes made to follow the party match it, so they aren't echoed.)
  partySend() {
    if (!this.partyId || !this.partyState) return;
    clearTimeout(this.partySendTimer);
    this.partySendTimer = setTimeout(() => {
      if (!this.partyState || this.inSync(1.5)) return;
      this.lastPartySend = Date.now();
      this.partyPost({ itemId: this.item.id, playing: !this.paused, position: this.time });
    }, 250);
  }

  partyPost(state) {
    fetch(`/api/parties/${this.partyId}/state`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ clientId: this.clientId, ...state }),
    }).catch(() => {});
  }

  onEnded() {
    // A stream that stops well before the end may just be the server restarting.
    if (this.mode !== 'direct' && this.duration && this.time < this.duration - 60) {
      serverUp().then((up) => { if (!this.root.isConnected) return; if (up) this.finish(); else this.reconnect(); });
      return;
    }
    this.finish();
  }
  finish() {
    this.report();
    if (!this.item.next) return setTimeout(() => this.close(), 800);
    this.showUpNext(false);
  }

  // "Up next" card: at the end of an episode, or as soon as its credits start.
  showUpNext(atCredits) {
    if ($('.p-upnext', this.root)) return;
    const n = this.item.next;
    const auto = playerPref('autoplayNext');
    let left = 10;
    const box = document.createElement('div');
    box.className = 'p-upnext';
    box.innerHTML = html`<div class="muted">${auto ? html`Up next in <b id="un-count">${left}</b>s` : 'Up next'}</div>
      <img src="${artUrl('thumb', n)}" alt="">
      <div><b>${epLabel(n)}</b> — ${n.title}</div>
      <div class="row"><button class="btn primary small" data-a="next">▶ Play now</button>
        <button class="btn small" data-a="cancel-next">${atCredits ? 'Watch credits' : 'Cancel'}</button></div>`.s;
    this.root.append(box);
    this.root.classList.remove('idle');
    if (!auto) {
      // Without a countdown, the card at the credits fades like the skip buttons (N still plays next).
      const fade = playerPref('skipFade');
      if (atCredits && fade > 0) setTimeout(() => { box.classList.add('faded'); setTimeout(() => box.remove(), 700); }, fade * 1000);
      return;
    }
    this.upNextTimer = setInterval(() => {
      if (atCredits && this.paused) return; // the countdown waits while paused
      left--;
      const c = $('#un-count', box); if (c) c.textContent = left;
      if (left <= 0) { clearInterval(this.upNextTimer); this.playNext(true); }
    }, 1000);
  }

  setSpeed(rate) {
    // defaultPlaybackRate survives the source reloads that seeking in a transcode causes.
    this.v.defaultPlaybackRate = rate;
    this.v.playbackRate = rate;
    const sel = $('[data-a=speed]', this.root);
    if (sel) sel.value = String(rate);
  }

  stepSpeed(dir) {
    const rates = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    const i = rates.indexOf(this.v.playbackRate);
    const next = rates[Math.max(0, Math.min(rates.length - 1, (i === -1 ? 2 : i) + dir))];
    this.setSpeed(next);
    toast(`Speed: ${next === 1 ? 'normal' : `${next}×`}`);
  }

  togglePip() {
    if (!document.pictureInPictureEnabled || this.casting) return;
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    else this.v.requestPictureInPicture().catch(() => {});
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else this.root.requestFullscreen?.().catch(() => {});
  }

  bind() {
    const v = this.v;
    v.addEventListener('timeupdate', () => { if (!this.casting) this.updateTime(); });
    v.addEventListener('loadedmetadata', () => { if (this.mode === 'transcode') this.pendingStart = null; });
    v.addEventListener('seeked', () => { this.pendingStart = null; });
    v.addEventListener('playing', () => { this.pendingStart = null; this.lastGood = this.time; });
    v.addEventListener('timeupdate', () => { if (!v.paused && !this.reconnecting && v.readyState >= 3) this.lastGood = this.time; });
    v.addEventListener('progress', () => this.updateBuffer());
    v.addEventListener('waiting', () => { this.spinner(true); this.watchStall(); });
    v.addEventListener('seeking', () => this.spinner(true));
    for (const ev of ['playing', 'canplay', 'seeked', 'pause']) v.addEventListener(ev, () => { if (ev !== 'pause' || v.readyState >= 3) this.spinner(false); });
    // Paused for a moment: who's in it (each opens their page).
    const castBox = $('.p-cast', this.root);
    v.addEventListener('play', () => { $('[data-a=toggle]', this.root).textContent = '❚❚'; this.showControls(); clearTimeout(this.castTimer); if (castBox) castBox.hidden = true; });
    v.addEventListener('pause', () => {
      if (this.casting) return;
      $('[data-a=toggle]', this.root).textContent = '▶'; this.showControls(); this.report();
      clearTimeout(this.castTimer);
      if (castBox) this.castTimer = setTimeout(() => { if (this.v.paused && !this.v.ended) castBox.hidden = false; }, 2500);
    });
    v.addEventListener('ended', () => { if (!this.casting) this.onEnded(); });
    for (const ev of ['play', 'pause', 'seeked']) v.addEventListener(ev, () => { if (!this.casting) this.partySend(); });
    v.addEventListener('volumechange', () => {
      store.set('volume', v.volume); store.set('muted', v.muted);
      $('[data-a=mute]', this.root).textContent = v.muted || v.volume === 0 ? '🔇' : '🔊';
      $('.p-volume', this.root).value = v.muted ? 0 : v.volume;
    });
    v.addEventListener('error', async () => {
      if (!v.error || !v.getAttribute('src') || this.casting || this.reconnecting) return;
      if (!(await serverUp())) return this.reconnect();
      if (!this.root.isConnected) return;
      if (this.mode === 'direct') {
        // Browser refused the original file: fall back to server-side transcoding.
        toast('Direct play failed — switching to transcoding');
        const t = this.time;
        this.directFailed = true;
        if (this.item.media?.video?.codec === 'hevc') this.hevcFailed = true;
        this.setModeFromQuality();
        this.load(t);
      } else if (this.mode === 'hls') {
        this.hlsFailed(v.error.message || `media error ${v.error.code}`);
      } else if (this.hevcQuery()) {
        // The browser couldn't play the HEVC picture after all: convert it.
        const t = this.time;
        this.hevcFailed = true;
        this.load(t);
      } else {
        this.spinner(false);
        const msg = document.createElement('div');
        msg.className = 'p-center-msg';
        msg.innerHTML = html`<h2>Playback error</h2><p class="muted">The server could not stream this file. Check the server log for ffmpeg output.</p><button class="btn" data-a="close">Go back</button>`.s;
        this.root.append(msg);
      }
    });
    v.addEventListener('click', () => this.toggle());
    v.addEventListener('dblclick', () => this.toggleFullscreen());

    this.root.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'close') this.close();
      else if (a === 'toggle') this.toggle();
      else if (a === 'back') this.seek(this.time - 10);
      else if (a === 'fwd') this.seek(this.time + 30);
      else if (a === 'mute') v.muted = !v.muted;
      else if (a === 'fs') this.toggleFullscreen();
      else if (a === 'next') this.playNext();
      else if (a === 'cancel-next') { clearInterval(this.upNextTimer); $('.p-upnext', this.root)?.remove(); }
      else if (a === 'pip') this.togglePip();
      else if (a === 'night') { this.setNight(!this.night); savePlayerPrefs({ nightMode: this.night }).catch(() => {}); toast(this.night ? 'Night mode on: clearer dialogue, quieter loud scenes' : 'Night mode off'); }
      else if (a === 'skip-intro' && this.skipPart === 'credits') this.close(); // leaving in the credits counts as watched
      else if (a === 'skip-intro' && this.skipPart === 'recap') { this.seek(this.item.recap.end); $('[data-a=skip-intro]', this.root).hidden = true; }
      else if (a === 'skip-intro' && this.item.intro) { this.seek(this.item.intro.end); $('[data-a=skip-intro]', this.root).hidden = true; }
      else if (a === 'cast') this.castClicked();
      else if (a === 'party') this.partyClicked();
      else if (a === 'intro-edit') { v.pause(); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); openIntroEditor(this.item.id).catch((err) => toast(err.message, true)); }
      else if (a === 'cast-stop') this.stopCasting(true);
      else if (a === 'airplay') v.webkitShowPlaybackTargetPicker?.();
    });
    this.root.addEventListener('change', (e) => {
      const a = e.target.dataset.a;
      if (a === 'subs' && e.target.value === '__search') {
        e.target.value = this.subId || '';
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        openSubtitleSearch(this.item.id, (detail, added) => {
          this.item.subtitles = detail.subtitles;
          e.target.innerHTML = this.subOptions().s;
          e.target.value = added;
          e.target.dispatchEvent(new Event('change', { bubbles: true }));
        });
        return;
      }
      if (a === 'subs') {
        const burnBefore = this.burn;
        this.subId = e.target.value || null; store.set('subsOn', !!this.subId);
        this.rememberTracks();
        if (this.burn !== burnBefore) {
          // Picture subtitles switched on, off or changed: the video itself changes.
          if (this.burn != null) toast('Picture subtitles are drawn into the video, so it is converted');
          this.setModeFromQuality();
          if (this.casting) this.startCasting(this.time); else { this.v.removeAttribute('src'); this.load(this.time); }
        } else if (this.casting) Cast.setSubtitle(this.item.subtitles.filter((s) => s.burn == null).findIndex((s) => s.id === this.subId));
        else this.applySubs();
      }
      if (a === 'speed') this.setSpeed(Number(e.target.value));
      if (a === 'quality') this.setQuality(e.target.value);
      if (a === 'audio') {
        this.audio = Number(e.target.value);
        this.rememberTracks();
        this.setModeFromQuality();
        if (this.casting) this.startCasting(this.time); else this.load(this.time);
      }
    });
    $('.p-volume', this.root).addEventListener('input', (e) => { v.volume = Number(e.target.value); v.muted = v.volume === 0; });

    const hover = $('.p-hover-time', this.root);
    const thumb = $('.p-hover-thumb', this.root);
    // Time label + preview picture over the seek bar at fraction f.
    const preview = (f) => {
      hover.hidden = false;
      hover.style.left = `${f * 100}%`;
      const chapter = this.chapterAt(f * this.total);
      hover.textContent = chapter ? `${fmtClock(f * this.total)} · ${chapter}` : fmtClock(f * this.total);
      this.showThumb(thumb, f);
    };
    const hidePreview = () => { hover.hidden = true; thumb.hidden = true; };
    this.range.addEventListener('input', () => {
      this.dragging = true;
      this.range.style.setProperty('--pct', `${pct(Number(this.range.value), this.total)}%`);
      this.updateTime();
      if (this.total) preview(Number(this.range.value) / this.total); // also while dragging on touch screens
    });
    this.range.addEventListener('change', () => { this.dragging = false; hidePreview(); this.seek(Number(this.range.value)); });
    this.range.addEventListener('mousemove', (e) => {
      const r = this.range.getBoundingClientRect();
      preview(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
    });
    this.range.addEventListener('mouseleave', hidePreview);

    this.onMove = () => this.showControls();
    this.root.addEventListener('mousemove', this.onMove);
    this.root.addEventListener('touchstart', this.onMove, { passive: true });
    // Any key, tap or click counts as someone being there ("Are you still watching?").
    this.root.addEventListener('pointerdown', () => { this.touched = true; });
    this.onKey = (e) => {
      this.touched = true;
      if (['SELECT', 'INPUT', 'TEXTAREA'].includes(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      const handled = {
        ' ': () => this.toggle(), k: () => this.toggle(),
        ArrowLeft: () => this.seek(this.time - 10), j: () => this.seek(this.time - 10),
        ArrowRight: () => this.seek(this.time + 30), l: () => this.seek(this.time + 30),
        ArrowUp: () => { v.volume = Math.min(1, v.volume + 0.05); v.muted = false; },
        ArrowDown: () => { v.volume = Math.max(0, v.volume - 0.05); },
        m: () => { v.muted = !v.muted; }, f: () => this.toggleFullscreen(),
        c: () => { const sel = $('[data-a=subs]', this.root); if (!sel) return; sel.value = this.subId ? '' : (this.pickDefaultSub() || ''); sel.dispatchEvent(new Event('change', { bubbles: true })); },
        s: () => { const b = $('[data-a=skip-intro]', this.root); if (b && !b.hidden) b.click(); },
        Escape: () => { if (!document.fullscreenElement) this.close(); },
        // TV remotes
        MediaPlayPause: () => this.toggle(), MediaPlay: () => this.toggle(), MediaPause: () => this.toggle(),
        MediaFastForward: () => this.seek(this.time + 30), MediaRewind: () => this.seek(this.time - 10),
        GoBack: () => this.close(), BrowserBack: () => this.close(),
        Enter: () => { if (!e.target.closest?.('button, select, input, a')) this.toggle(); },
        n: () => { if (this.item.next) this.playNext(); },
        p: () => this.togglePip(),
        '<': () => this.stepSpeed(-1), '>': () => this.stepSpeed(1),
      }[k];
      if (handled) { e.preventDefault(); handled(); this.showControls(); }
    };
    document.addEventListener('keydown', this.onKey);
  }

  // Stuck loading for a while: if the server has gone away, wait for it rather than spin forever.
  watchStall() {
    clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(async () => {
      if (!this.root.isConnected || this.casting || this.reconnecting || this.v.readyState >= 3 || this.v.paused) return;
      if (!(await serverUp())) this.reconnect();
    }, 10_000);
  }

  // The server went away mid-film (restarting into an update, the PC rebooting): wait for it to come
  // back (up to a minute and a half), then carry on from the same moment.
  reconnect() {
    if (this.reconnecting || this.casting || !this.root.isConnected) return;
    const t = this.v.seeking || this.lastGood == null ? this.time : this.lastGood; // (mid-seek: where it was going)
    const paused = this.v.paused && this.v.readyState >= 2 && !this.v.ended;
    this.reconnecting = true;
    clearTimeout(this.stallTimer);
    this.destroyHls();
    this.v.pause();
    this.spinner(false);
    $('.p-center-msg', this.root)?.remove();
    const box = document.createElement('div');
    box.className = 'p-center-msg p-reconnect';
    box.innerHTML = html`<div class="spinner"></div><h2>Reconnecting to Marquee…</h2><p class="muted">The server is restarting. This carries on where you were in a moment.</p>`.s;
    this.root.append(box);
    const started = Date.now();
    const attempt = async () => {
      if (!this.root.isConnected) return;
      if (await serverUp()) {
        // A restarted server has forgotten its streaming sessions: ask for fresh links.
        try { this.pb = await api(`/api/items/${this.item.id}/playback`); } catch { /* the old ones may still do */ }
        if (!this.root.isConnected) return;
        box.remove();
        this.reconnecting = false;
        if (this.mode === 'direct') this.v.removeAttribute('src'); // load() only re-points a fresh element
        this.load(t);
        if (paused) this.v.addEventListener('playing', () => this.v.pause(), { once: true });
        return;
      }
      if (Date.now() - started < 90_000) { this.reconnectTimer = setTimeout(attempt, 2000); return; }
      this.reconnecting = false;
      box.innerHTML = html`<h2>Can't reach Marquee</h2><p class="muted">The server hasn't come back yet. Check the PC it runs on.</p>
        <div class="row" style="justify-content:center"><button class="btn primary" data-a="reconnect">Try again</button><button class="btn" data-a="close">Go back</button></div>`.s;
      $('[data-a=reconnect]', box).onclick = () => { box.remove(); this.lastGood = t; this.reconnect(); };
    };
    this.reconnectTimer = setTimeout(attempt, 2000);
  }

  destroy() {
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.stallTimer);
    this.report(true);
    clearInterval(this.reportTimer);
    clearInterval(this.upNextTimer);
    clearTimeout(this.idleTimer);
    document.removeEventListener('keydown', this.onKey);
    this.offCast?.();
    this.es?.close();
    clearInterval(this.driftTimer);
    if (this.casting) {
      // Leaving the player stops the video on the TV but stays connected, so the next one casts too.
      this.unbindCastEvents();
      if (!this.castFinished) Cast.controller?.stop();
      this.casting = false;
    }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (document.pictureInPictureElement === this.v) document.exitPictureInPicture().catch(() => {});
    this.destroyHls();
    this.v.pause();
    this.v.removeAttribute('src'); // stops the download and lets the server kill ffmpeg
    this.v.load();
    if (this.pb?.sid && this.mode === 'hls') fetch(`/api/hls/${this.pb.sid}`, { method: 'DELETE', keepalive: true }).catch(() => {});
    this.root.remove();
    document.title = 'Marquee';
  }
}
