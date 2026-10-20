'use strict';
// Automatic subtitles: films and episodes without subtitles in the languages the family uses get
// them from OpenSubtitles.com by themselves, newest titles first, within the daily allowance (an
// OpenSubtitles account raises it). A subtitle made for the exact same video file is preferred;
// machine-translated ones are left out. What wasn't found is looked for again a month later.
//
// Settings (store.data.settings.autoSubs): { enabled, languages: ['en', …] } — no languages means
// the ones people picked on their Account pages ("Subtitles in"). Downloads land where the manual
// ones do (item.downloadedSubs, marked auto).

const fs = require('node:fs');
const path = require('node:path');

const ALIASES = { en: ['eng'], es: ['spa'], fr: ['fre', 'fra'], de: ['ger', 'deu'], it: ['ita'], pt: ['por'], nl: ['dut', 'nld'], sv: ['swe'],
  pl: ['pol'], ru: ['rus'], tr: ['tur'], ar: ['ara'], hi: ['hin'], ja: ['jpn'], ko: ['kor'], zh: ['chi', 'zho'], da: ['dan'], no: ['nor', 'nob'], fi: ['fin'], he: ['heb'] };
/** Whether a track's language ("eng", "en-US"…) is `code` ("en"). */
function sameLang(lang, code) {
  const l = String(lang || '').toLowerCase().split(/[-_]/)[0];
  return !!l && !!code && (l === code || (ALIASES[code] || []).includes(l));
}
const RETRY_MS = 30 * 86400_000;
const PER_RUN = 10;

const httpError = (status, msg) => Object.assign(new Error(msg), { status });

/** Keeps a downloaded subtitle with its title (also used for the ones people download by hand). */
function saveDownloaded(store, dir, item, { fileId, text, lang, release, auto = false }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = `${item.id}-${fileId}.srt`;
  fs.writeFileSync(path.join(dir, file), text);
  item.downloadedSubs = [...(item.downloadedSubs || []).filter((s) => s.file !== file),
    { file, lang, release: String(release || '').slice(0, 200), at: Date.now(), ...(auto ? { auto: true } : {}) }];
  store.save();
  return item.downloadedSubs.length - 1;
}

class AutoSubs {
  constructor(store, opensubs, dir, { isOtherVersion = () => false } = {}) {
    this.store = store;
    this.opensubs = opensubs;
    this.dir = dir;
    this.isOtherVersion = isOtherVersion;
    this.running = false;
  }

  settings() {
    const s = this.store.data.settings?.autoSubs || {};
    return { enabled: !!s.enabled, languages: Array.isArray(s.languages) ? s.languages : [] };
  }

  /** The languages looked for: the ones set here, else everyone's "Subtitles in" choice. */
  languages() {
    const set = this.settings().languages;
    if (set.length) return set;
    return [...new Set((this.store.data.users || []).map((u) => u.prefs?.subLang).filter(Boolean))];
  }

  update(input = {}) {
    const s = this.settings();
    if (input.enabled !== undefined) s.enabled = !!input.enabled;
    if (input.languages !== undefined) {
      const list = (Array.isArray(input.languages) ? input.languages : String(input.languages).split(','))
        .map((l) => String(l).trim().toLowerCase()).filter(Boolean);
      if (list.some((l) => !/^[a-z]{2}$/.test(l))) throw httpError(400, 'Languages are two-letter codes, like en, es, fr');
      s.languages = [...new Set(list)].slice(0, 5);
    }
    (this.store.data.settings ||= {}).autoSubs = s;
    this.store.save();
    return this.status();
  }

  /** Whether a title has subtitles in `lang` already (in the file, beside it, or downloaded). */
  has(it, lang) {
    return (it.media?.subtitles || []).some((s) => sameLang(s.lang, lang))
      || (it.sidecarSubs || []).some((s) => sameLang(s.lang, lang))
      || (it.downloadedSubs || []).some((s) => sameLang(s.lang, lang));
  }

  /** [{ item, lang }] still to look for, newest titles first. */
  wanted(now = Date.now()) {
    const langs = this.languages();
    const out = [];
    for (const it of Object.values(this.store.data.items)) {
      if ((it.type !== 'movie' && it.type !== 'episode') || !it.media || this.isOtherVersion(it)) continue;
      for (const lang of langs) {
        if (this.has(it, lang)) continue;
        if (now - (it.autoSubTried?.[lang] || 0) < RETRY_MS) continue;
        out.push({ item: it, lang });
      }
    }
    return out.sort((a, b) => (b.item.addedAt || 0) - (a.item.addedAt || 0));
  }

  status() {
    const st = this.store.data.autoSubsState || {};
    const today = new Date().toDateString();
    return {
      settings: this.settings(), languages: this.languages(), configured: this.opensubs.configured(),
      missing: this.settings().enabled ? this.wanted().length : null,
      today: st.day === today ? st.count || 0 : 0, total: st.total || 0,
      paused: st.pausedUntil > Date.now() ? { until: st.pausedUntil, why: st.why } : null,
      last: st.last || null,
    };
  }

  /** One round: a few titles each time; stops for the day when the allowance runs out. */
  async run() {
    if (this.running || !this.settings().enabled || !this.opensubs.configured()) return 0;
    const st = (this.store.data.autoSubsState ||= {});
    if (st.pausedUntil > Date.now()) return 0;
    this.running = true;
    let got = 0;
    try {
      for (const { item, lang } of this.wanted().slice(0, PER_RUN)) {
        const show = item.showId ? this.store.data.shows[item.showId] : null;
        (item.autoSubTried ||= {})[lang] = Date.now();
        let results;
        try { results = await this.opensubs.search(item, show, lang); } catch (err) { this.pause(err); break; }
        const pick = results.filter((r) => !r.machineTranslated && sameLang(r.language, lang))
          .sort((a, b) => b.hashMatch - a.hashMatch || a.hearingImpaired - b.hearingImpaired || b.downloads - a.downloads)[0];
        if (!pick) continue;
        let dl;
        try { dl = await this.opensubs.download(pick.fileId); } catch (err) { this.pause(err); break; }
        saveDownloaded(this.store, this.dir, item, { fileId: pick.fileId, text: dl.text, lang, release: pick.release, auto: true });
        got++;
        const today = new Date().toDateString();
        if (st.day !== today) Object.assign(st, { day: today, count: 0 });
        st.count++;
        st.total = (st.total || 0) + 1;
        st.last = { at: Date.now(), id: item.id, lang, release: pick.release, hashMatch: pick.hashMatch };
        if (dl.remaining === 0) { this.pause({ message: 'today’s OpenSubtitles downloads are used up' }); break; }
      }
    } finally {
      this.running = false;
      this.store.save();
    }
    if (got) console.log(`[subs] fetched ${got} subtitle file${got === 1 ? '' : 's'} automatically`);
    return got;
  }

  // Out of downloads (or OpenSubtitles is down): try again in a few hours.
  pause(err) {
    const st = (this.store.data.autoSubsState ||= {});
    Object.assign(st, { pausedUntil: Date.now() + 6 * 3600_000, why: err.message });
    console.warn(`[subs] automatic subtitles paused: ${err.message}`);
  }

  start(everyMs = Number(process.env.AUTOSUBS_EVERY_MS) || 30 * 60_000) {
    const go = () => this.run().catch((err) => console.warn(`[subs] ${err.message}`));
    setTimeout(go, 90_000).unref();
    setInterval(go, everyMs).unref();
  }
}

module.exports = { AutoSubs, saveDownloaded, sameLang };
