'use strict';
// Updating the Roku channel from Settings, instead of uploading the zip to each Roku by hand.
//
// A Roku that has opened Marquee is remembered by its home-network address. Its name, model, the
// channel's installed version and what it's doing come from the Roku itself (its network control,
// port 8060, open to the home network). A new channel is sent to the Roku's developer installer
// (port 80, the "rokudev" account and the password set when developer mode was turned on), as
// the Upload page does. Installing opens the channel, so it isn't sent while something's playing,
// and a Roku that was on its home screen is put back there.

const crypto = require('node:crypto');
const fs = require('node:fs');
const zlib = require('node:zlib');

const FORGET_MS = 60 * 86400_000; // not seen for two months: probably gone (or a new address)
const ASK_MS = 2500;
const INSTALL_MS = 120_000;

const tag = (xml, name) => {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  return m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim() : null;
};
// "1.17.0" -> 1017 (major and minor; the build number isn't used)
const rank = (v) => { const [a = 0, b = 0] = String(v || '').split('.').map(Number); return a * 1000 + b; };

// The version in a channel zip's manifest (major_version / minor_version / build_version).
function zipVersion(file) {
  const buf = fs.readFileSync(file);
  for (let at = 0; at + 30 <= buf.length && buf.readUInt32LE(at) === 0x04034b50;) {
    const method = buf.readUInt16LE(at + 8);
    const size = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const start = at + 30 + nameLen + buf.readUInt16LE(at + 28);
    if (buf.toString('utf8', at + 30, at + 30 + nameLen) === 'manifest') {
      const raw = buf.subarray(start, start + size);
      const text = (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
      const get = (k) => (new RegExp(`^${k}=(\\d+)`, 'm').exec(text) || [])[1] || '0';
      return `${get('major_version')}.${get('minor_version')}.${get('build_version')}`;
    }
    at = start + size;
  }
  return null;
}

// The Authorization header answering a Digest challenge (the Roku's installer uses one).
function digest(challenge, { user, pass, method, uri }) {
  const p = {};
  String(challenge).replace(/(\w+)=(?:"([^"]*)"|([^\s,]*))/g, (_, k, q, v) => { p[k] = q ?? v; });
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
  const ha1 = md5(`${user}:${p.realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const nc = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const qop = p.qop ? 'auth' : null;
  const response = qop ? md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
  return `Digest username="${user}", realm="${p.realm}", nonce="${p.nonce}", uri="${uri}", response="${response}"`
    + (qop ? `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"` : '') + (p.opaque ? `, opaque="${p.opaque}"` : '');
}

class Rokus {
  // zip: the channel to install. ports (tests): { ecp, dev }.
  constructor(store, { zip, isHomeIp, ports = {} }) {
    this.store = store;
    this.zip = zip;
    this.isHomeIp = isHomeIp;
    this.ecpPort = ports.ecp || 8060;
    this.devPort = ports.dev || 80;
    this.busy = new Set();
    this.versionCache = null;
  }

  get known() { return (this.store.data.rokus ||= {}); }

  /** The channel's requests carry a "Roku/…" user agent: remember where it is. */
  seen(req, ip) {
    if (!/^Roku\//.test(String(req.headers['user-agent'] || ''))) return;
    const a = String(ip || '').replace(/^::ffff:/, '');
    if (!this.isHomeIp(a)) return;
    const r = this.known[a];
    if (r && Date.now() - r.lastSeenAt < 3600_000) return;
    this.known[a] = { ...r, lastSeenAt: Date.now() };
    this.store.save({ lazy: true, personal: true });
  }

  /** The version of the channel Marquee would install, e.g. "1.17.0" (null without the zip). */
  latest() {
    try {
      const mtime = fs.statSync(this.zip).mtimeMs;
      if (this.versionCache?.mtime !== mtime) this.versionCache = { mtime, version: zipVersion(this.zip) };
      return this.versionCache.version;
    } catch { return null; }
  }

  async ask(ip, what) {
    const res = await fetch(`http://${ip}:${this.ecpPort}/query/${what}`, { signal: AbortSignal.timeout(ASK_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  // What a Roku is doing now: on, and which channel is open (Marquee: playing or not).
  async state(ip) {
    const [info, apps, active] = await Promise.all([this.ask(ip, 'device-info'), this.ask(ip, 'apps'), this.ask(ip, 'active-app')]);
    const dev = /<app id="dev"[^>]*version="([^"]*)"[^>]*>([^<]*)</.exec(apps);
    const app = /<app(?: id="([^"]*)")?[^>]*>([^<]*)<\/app>/.exec(active);
    const out = {
      name: tag(info, 'user-device-name') || tag(info, 'friendly-device-name') || tag(info, 'model-name') || 'Roku',
      model: tag(info, 'friendly-model-name') || tag(info, 'model-name'),
      serial: tag(info, 'serial-number'),
      on: !/^(DisplayOff|Ready|Headless)/i.test(tag(info, 'power-mode') || 'PowerOn'),
      developerMode: tag(info, 'developer-enabled') !== 'false',
      installed: dev && /marquee/i.test(dev[2]) ? dev[1] : null,
      otherChannel: dev && !/marquee/i.test(dev[2]) ? dev[2].trim() : null,
      // (No id: the Roku's home screen. A screensaver shows over it.)
      app: !app || !app[1] ? 'home' : app[1] === 'dev' ? 'marquee' : 'other',
      appName: app ? app[2].trim() : null,
      playing: false,
    };
    if (out.app === 'marquee') out.playing = /state="play"/.test(await this.ask(ip, 'media-player').catch(() => ''));
    return out;
  }

  // Each Roku Marquee knows of, with what it's doing and whether it needs the new channel.
  async list() {
    const now = Date.now();
    for (const [ip, r] of Object.entries(this.known)) if (now - r.lastSeenAt > FORGET_MS) delete this.known[ip];
    const latest = this.latest();
    const rows = await Promise.all(Object.entries(this.known).map(async ([ip, r]) => {
      let s = null;
      try { s = await this.state(ip); } catch { /* off at the wall, or a new address */ }
      if (s?.serial && r.serial !== s.serial) { r.serial = s.serial; this.store.save({ lazy: true, personal: true }); }
      return {
        ip, lastSeenAt: r.lastSeenAt, online: !!s, ...(s || { name: r.name || 'Roku' }),
        hasPassword: !!(r.password || this.store.data.settings.rokuPassword),
        needsUpdate: !!(s && latest && s.installed && rank(s.installed) < rank(latest)),
        updating: this.busy.has(ip),
        lastUpdate: r.lastUpdate || null,
      };
    }));
    if (rows.some((x) => x.online && x.name !== this.known[x.ip]?.name)) {
      for (const x of rows) if (x.online && this.known[x.ip]) this.known[x.ip].name = x.name;
      this.store.save({ lazy: true, personal: true });
    }
    // The same Roku at an old address (the router gave it a new one): keep the newest.
    const bySerial = new Map();
    for (const x of rows.sort((a, b) => b.lastSeenAt - a.lastSeenAt)) {
      if (x.serial && bySerial.has(x.serial)) { delete this.known[x.ip]; continue; }
      if (x.serial) bySerial.set(x.serial, x);
    }
    return { latest, rokus: rows.filter((x) => this.known[x.ip]).sort((a, b) => String(a.name).localeCompare(String(b.name))) };
  }

  /**
   * Installs the channel on one Roku. password: the developer password (kept for next time when it
   * works); force: even though something's on. Returns { result, message }.
   */
  async update(ip, { password, force = false } = {}) {
    const r = this.known[ip];
    if (!r) throw Object.assign(new Error('Marquee doesn’t know that Roku'), { status: 404 });
    if (this.busy.has(ip)) throw Object.assign(new Error('That Roku is already being updated'), { status: 409 });
    const pass = String(password || r.password || this.store.data.settings.rokuPassword || '');
    if (!pass) return { result: 'password', message: 'Type the Roku’s developer password (the one set when developer mode was turned on).' };
    let s;
    try { s = await this.state(ip); } catch { return { result: 'offline', message: 'The Roku didn’t answer. Is it plugged in and on the network?' }; }
    if (!s.developerMode) return { result: 'failed', message: 'Developer mode is off on this Roku, so channels can’t be installed on it.' };
    if (s.otherChannel && !force) return { result: 'busy', message: `This Roku's developer slot has “${s.otherChannel}” in it. Installing Marquee replaces it.` };
    if (!force && s.on && (s.playing || s.app === 'other')) {
      return { result: 'busy', message: s.playing ? 'Something’s playing in Marquee on it right now.' : `It’s showing ${s.appName || 'another channel'} right now.` };
    }
    this.busy.add(ip);
    try {
      const zip = fs.readFileSync(this.zip);
      const url = `http://${ip}:${this.devPort}/plugin_install`;
      const send = (auth) => {
        const form = new FormData();
        form.append('mysubmit', 'Install');
        form.append('archive', new Blob([zip], { type: 'application/zip' }), 'Marquee-Roku.zip');
        return fetch(url, { method: 'POST', headers: auth ? { Authorization: auth } : {}, body: form, signal: AbortSignal.timeout(INSTALL_MS) });
      };
      let res = await send(null);
      if (res.status === 401) {
        await res.arrayBuffer().catch(() => {});
        res = await send(digest(res.headers.get('www-authenticate'), { user: 'rokudev', pass, method: 'POST', uri: '/plugin_install' }));
      }
      const text = await res.text().catch(() => '');
      if (res.status === 401) return { result: 'password', message: 'The Roku said the developer password isn’t right.' };
      const ok = res.ok && /Install Success|Identical to previous version|Application Received/i.test(text);
      if (!ok) {
        const why = /<font color="red">([^<]+)</i.exec(text)?.[1] || (/"(Install Failure[^"]*)"/i.exec(text) || [])[1] || `HTTP ${res.status}`;
        return { result: 'failed', message: `The Roku couldn’t install it: ${why.trim()}` };
      }
      r.password = pass;
      this.store.data.settings.rokuPassword = pass;
      r.lastUpdate = { at: Date.now(), version: this.latest() };
      this.store.save();
      // Installing opens the channel: put a Roku that was on its home screen back there.
      if (s.on && s.app === 'home') {
        await new Promise((done) => setTimeout(done, 4000));
        await fetch(`http://${ip}:${this.ecpPort}/keypress/Home`, { method: 'POST', signal: AbortSignal.timeout(ASK_MS) }).catch(() => {});
      }
      return { result: 'updated', message: /Identical/i.test(text) ? 'It already had this version.' : `Updated to ${this.latest()}.` };
    } catch (err) {
      return { result: 'failed', message: `The Roku couldn’t be updated: ${err.name === 'TimeoutError' ? 'it stopped answering' : err.message}` };
    } finally {
      this.busy.delete(ip);
    }
  }
}

module.exports = { Rokus, zipVersion, digest };
