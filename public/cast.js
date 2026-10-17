/* Marquee web client — casting to Chromecast / Google TV (Google Cast, Default Media Receiver).
   The Cast SDK only loads in Chrome-family browsers on secure pages (https or localhost); the TV
   then fetches the video itself, using a signed link because it has no login cookie. */
'use strict';

const Cast = {
  ctx: null,
  player: null,
  controller: null,
  loading: null,
  listeners: new Set(),

  supported() { return !!window.chrome && window.isSecureContext && !window.MarqueeAndroid; },

  // Resolves true once the Cast framework is ready (false if unavailable: not Chrome, offline, blocked).
  load() {
    if (this.loading) return this.loading;
    if (!this.supported()) return (this.loading = Promise.resolve(false));
    this.loading = new Promise((resolve) => {
      const done = (ok) => { clearTimeout(timer); resolve(ok); };
      const timer = setTimeout(() => done(false), 15_000);
      window.__onGCastApiAvailable = (ok) => {
        if (ok) { try { this.init(); } catch (err) { console.warn('Cast init failed', err); ok = false; } }
        done(ok);
      };
      if (window.cast?.framework) return window.__onGCastApiAvailable(true);
      const s = document.createElement('script');
      s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
      s.onerror = () => done(false);
      document.head.append(s);
    });
    return this.loading;
  },

  init() {
    const fw = window.cast.framework;
    this.ctx = fw.CastContext.getInstance();
    this.ctx.setOptions({
      receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    });
    this.player = new fw.RemotePlayer();
    this.controller = new fw.RemotePlayerController(this.player);
    this.ctx.addEventListener(fw.CastContextEventType.CAST_STATE_CHANGED, () => this.emit());
  },

  // 'NO_DEVICES_AVAILABLE' | 'NOT_CONNECTED' | 'CONNECTING' | 'CONNECTED' | null (not loaded)
  state() { return this.ctx ? this.ctx.getCastState() : null; },
  session() { return this.ctx?.getCurrentSession() || null; },
  deviceName() { return this.session()?.getCastDevice()?.friendlyName || 'TV'; },

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  emit() { for (const fn of this.listeners) fn(this.state()); },

  // Shows Chrome's device picker; resolves true when connected.
  async connect() {
    if (this.state() === 'CONNECTED') return true;
    try { await this.ctx.requestSession(); return true; } catch { return false; } // cancelled
  },

  disconnect() { this.ctx?.endCurrentSession(true); },

  async play({ url, contentType, hls = false, title, subtitle, image, duration, startTime = 0, subtitles = [], activeSub = null }) {
    const m = window.chrome.cast.media;
    const info = new m.MediaInfo(url, contentType);
    info.streamType = m.StreamType.BUFFERED;
    if (duration) info.duration = duration;
    if (hls) {
      info.hlsSegmentFormat = m.HlsSegmentFormat.TS;
      if (m.HlsVideoSegmentFormat) info.hlsVideoSegmentFormat = m.HlsVideoSegmentFormat.MPEG2_TS;
    }
    const meta = new m.GenericMediaMetadata();
    meta.title = title;
    if (subtitle) meta.subtitle = String(subtitle);
    if (image) meta.images = [new window.chrome.cast.Image(image)];
    info.metadata = meta;
    info.tracks = subtitles.map((s, i) => {
      const t = new m.Track(i + 1, m.TrackType.TEXT);
      t.trackContentId = s.url;
      t.trackContentType = 'text/vtt';
      t.subtype = m.TextTrackType.SUBTITLES;
      t.name = s.label;
      t.language = s.lang || 'und';
      return t;
    });
    const req = new m.LoadRequest(info);
    req.currentTime = startTime;
    req.autoplay = true;
    const active = subtitles.findIndex((s) => s.id === activeSub);
    req.activeTrackIds = active >= 0 ? [active + 1] : [];
    await this.session().loadMedia(req);
  },

  setSubtitle(index) {
    const media = this.session()?.getMediaSession();
    if (!media) return;
    const m = window.chrome.cast.media;
    media.editTracksInfo(new m.EditTracksInfoRequest(index >= 0 ? [index + 1] : []), () => {}, () => {});
  },
};
window.MarqueeCastApi = Cast;
