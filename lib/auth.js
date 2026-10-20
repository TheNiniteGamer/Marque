'use strict';
// Users, password hashing (scrypt) and cookie sessions. TVs (Roku, Android TV) sign in by showing a
// short code that someone enters on their phone or computer ("Link a TV"); they then use a device
// session sent as `Authorization: Bearer <token>` (or `?at=<token>` on playback files and artwork).

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { randomId } = require('./store');

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'mq_session';
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const DEVICE_TTL = 365 * 24 * 3600 * 1000;
const PAIR_TTL = 10 * 60 * 1000;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const USERNAME_RE = /^[\p{L}\p{N} _.\-]{1,32}$/u;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const tokenKey = (token) => crypto.createHash('sha256').update(token).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(req, token, maxAgeSec) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

// Player settings that follow the account to every device (web, Android, Roku).
// skipFade: seconds the Skip Intro / Skip Credits buttons stay up before fading (0 = until the part ends).
// nightMode: clearer dialogue, quieter loud scenes (compressed sound).
// subLang / audioLang: the subtitles turned on, and the sound picked, when a title has them in that
// language (a two- or three-letter code; '' = none / the title's own), unless chosen for the show.
// subSize / subStyle: how subtitles look (in the web player and the Android apps; a Roku uses its
// own caption settings).
const PLAYER_PREFS = { autoplayNext: true, autoSkipIntro: false, skipFade: 10, nightMode: false, subLang: '', audioLang: '', subSize: 'medium', subStyle: 'box' };
const SKIP_FADES = [0, 5, 10, 15, 30];
const SUB_SIZES = ['small', 'medium', 'large', 'xlarge'];
const SUB_STYLES = ['shadow', 'box', 'yellow'];
function playerPrefs(u) { return { ...PLAYER_PREFS, ...(u?.prefs || {}) }; }
function cleanPrefs(body) {
  const out = {};
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  for (const k of ['autoplayNext', 'autoSkipIntro', 'nightMode']) if (typeof body[k] === 'boolean') out[k] = body[k];
  for (const k of ['subLang', 'audioLang']) {
    if (body[k] === undefined) continue;
    const v = String(body[k] || '').toLowerCase();
    if (v && !/^[a-z]{2,3}$/.test(v)) throw bad(`${k} must be a language code like "en"`);
    out[k] = v;
  }
  if (body.subSize !== undefined) { if (!SUB_SIZES.includes(body.subSize)) throw bad(`subSize must be one of ${SUB_SIZES.join(', ')}`); out.subSize = body.subSize; }
  if (body.subStyle !== undefined) { if (!SUB_STYLES.includes(body.subStyle)) throw bad(`subStyle must be one of ${SUB_STYLES.join(', ')}`); out.subStyle = body.subStyle; }
  if (body.skipFade !== undefined) {
    const n = Number(body.skipFade);
    if (!SKIP_FADES.includes(n)) throw Object.assign(new Error(`skipFade must be one of ${SKIP_FADES.join(', ')}`), { status: 400 });
    out.skipFade = n;
  }
  return out;
}

const publicUser = (u) => u && ({
  id: u.id, username: u.username, role: u.role,
  libraries: u.role === 'admin' ? null : (u.libraries ?? null),
  canDownload: u.role === 'admin' || !!u.canDownload,
  // Requests that go straight to Radarr (films) / Sonarr (shows) without waiting for an admin.
  autoApprove: u.role === 'admin' ? { movie: true, show: true } : { movie: !!u.autoApprove?.movie, show: !!u.autoApprove?.show },
  createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null,
  hasPin: !!u.pin, noPin: u.role !== 'admin' && !!u.noPin,
  // A kids profile: titles rated above this age are hidden (admins see everything).
  maxAge: u.role === 'admin' ? null : (u.maxAge ?? null), allowUnrated: u.allowUnrated !== false,
  prefs: playerPrefs(u), prefsSaved: !!u.prefs,
  // After an admin reset their password: they choose their own before doing anything else.
  mustChangePassword: !!u.mustChangePassword,
});

// A temporary password that's easy to read out or type: no look-alike letters (0/O, 1/l/I).
function temporaryPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const part = () => Array.from(crypto.randomBytes(4), (b) => abc[b % abc.length]).join('');
  return `${part()}-${part()}-${part()}`;
}

// "Who's watching?" lists people with a PIN, and accounts an admin has allowed without one (kids).
const onPicker = (u) => !!u.pin || (u.role !== 'admin' && !!u.noPin);
const PIN_RE = /^\d{4,8}$/;

class Auth {
  constructor(store) {
    this.store = store;
    store.data.users ||= [];
    store.data.sessions ||= {};
    this.failures = new Map(); // ip, or "user:<name>" -> [timestamps]
    this.failedFrom = new Map(); // username -> Set of addresses wrong passwords for it came from
    this.pinFailures = new Map(); // userId -> [timestamps]
    this.pairings = new Map(); // id -> { code, name, expiresAt, userId, token }
    this.prune();
    setInterval(() => this.prune(), 3600_000).unref();
  }

  get users() { return this.store.data.users; }
  hasUsers() { return this.users.length > 0; }
  byId(id) { return this.users.find((u) => u.id === id) || null; }
  byName(name) { return this.users.find((u) => u.username.toLowerCase() === String(name).trim().toLowerCase()) || null; }

  prune() {
    const now = Date.now();
    for (const [k, s] of Object.entries(this.store.data.sessions)) if (s.expiresAt < now || !this.byId(s.userId)) delete this.store.data.sessions[k];
    for (const [k, sk] of Object.entries(this.store.data.mediaKeys || {})) if (!this.store.data.sessions[sk]) delete this.store.data.mediaKeys[k];
  }

  // A media key: what a TV puts in picture and video addresses (?at=) instead of its sign-in. It
  // opens only artwork and playback files (see the 'media' routes), so an address that ends up in a
  // log or history doesn't hand over the account. One per sign-in; it ends with it.
  mediaKey(req) {
    const s = req.sessionKey && this.store.data.sessions[req.sessionKey];
    if (!s) return null;
    if (!s.mk) {
      s.mk = crypto.randomBytes(24).toString('base64url');
      (this.store.data.mediaKeys ||= {})[tokenKey(s.mk)] = req.sessionKey;
      this.store.save({ personal: true });
    }
    return s.mk;
  }

  // Returns the logged-in user (raw record) or null; slides the session expiry forward.
  // queryToken: a device token given in the address (only accepted for playback files and artwork).
  authenticate(req, { queryToken = null } = {}) {
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    let token = parseCookies(req.headers.cookie)[COOKIE] || bearer?.[1] || null;
    let key = token ? tokenKey(token) : null;
    if (!token && queryToken) {
      // A media key (see mediaKey). Older Roku builds still send their sign-in itself: accepted
      // for now (only on media routes), until they've been updated.
      const viaKey = this.store.data.mediaKeys?.[tokenKey(queryToken)];
      key = viaKey && Object.hasOwn(this.store.data.sessions, viaKey) ? viaKey : tokenKey(queryToken);
      token = queryToken;
    }
    if (!token) return null;
    const s = this.store.data.sessions[key];
    if (!s || s.expiresAt < Date.now()) return null;
    const user = this.byId(s.userId);
    if (!user) return null;
    const ttl = s.device ? DEVICE_TTL : SESSION_TTL;
    if (s.expiresAt - Date.now() < ttl - 24 * 3600 * 1000) { s.expiresAt = Date.now() + ttl; this.store.save({ lazy: true, personal: true }); }
    if (s.device && !(s.lastSeenAt > Date.now() - 3600_000)) { s.lastSeenAt = Date.now(); this.store.save({ lazy: true, personal: true }); }
    req.sessionKey = key;
    return user;
  }

  // ---- linking a TV with a code ----
  // The TV asks for a code and shows it; someone signed in enters it ("Link a TV"); the TV, which
  // keeps asking, then receives its own long-lived session once.
  startPairing(name) {
    const now = Date.now();
    for (const [id, p] of this.pairings) if (p.expiresAt < now) this.pairings.delete(id);
    if (this.pairings.size > 50) throw Object.assign(new Error('Too many TVs are waiting to be linked; try again in a few minutes'), { status: 429 });
    let code;
    do { code = Array.from(crypto.randomBytes(6), (b) => CODE_CHARS[b % CODE_CHARS.length]).join(''); }
    while ([...this.pairings.values()].some((p) => p.code === code));
    const id = crypto.randomBytes(16).toString('base64url');
    this.pairings.set(id, { code, name: String(name || 'TV').trim().slice(0, 40) || 'TV', expiresAt: now + PAIR_TTL, userId: null, token: null });
    return { id, code, expiresIn: PAIR_TTL / 1000 };
  }

  linkDevice(req, user, code) {
    const want = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const p = [...this.pairings.values()].find((x) => x.code === want && x.expiresAt > Date.now() && !x.token);
    if (!p) throw Object.assign(new Error('That code is not right, or has expired. Check the code on the TV.'), { status: 404 });
    const token = crypto.randomBytes(32).toString('base64url');
    this.store.data.sessions[tokenKey(token)] = { userId: user.id, device: p.name, createdAt: Date.now(), lastSeenAt: Date.now(), expiresAt: Date.now() + DEVICE_TTL, ua: String(req.headers['user-agent'] || '').slice(0, 120) };
    this.store.save();
    Object.assign(p, { userId: user.id, token });
    return p.name;
  }

  // { status: 'waiting' } until linked, then the session once: { status: 'linked', token, user }.
  claimPairing(id) {
    const p = this.pairings.get(id);
    if (!p || p.expiresAt < Date.now()) return null;
    if (!p.token) return { status: 'waiting' };
    this.pairings.delete(id);
    return { status: 'linked', token: p.token, user: this.byId(p.userId) };
  }

  devices(user) {
    return Object.entries(this.store.data.sessions).filter(([, s]) => s.device && s.userId === user.id)
      .map(([k, s]) => ({ id: k.slice(0, 16), name: s.device, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt || null }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  removeDevice(user, id) {
    const key = Object.keys(this.store.data.sessions).find((k) => k.startsWith(String(id)) && this.store.data.sessions[k].device && this.store.data.sessions[k].userId === user.id);
    if (!key || String(id).length < 16) throw Object.assign(new Error('Device not found'), { status: 404 });
    delete this.store.data.sessions[key];
    this.store.save();
  }

  deviceCookie(req, token) { return sessionCookie(req, token, DEVICE_TTL / 1000); }

  createSession(req, res, user) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.store.data.sessions[tokenKey(token)] = { userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL, ua: String(req.headers['user-agent'] || '').slice(0, 120) };
    user.lastLoginAt = Date.now();
    this.store.save();
    res.setHeader('Set-Cookie', sessionCookie(req, token, SESSION_TTL / 1000));
  }

  // "Who's watching?": the device carries on as another profile. A linked TV keeps its long-lived
  // device session (now the new profile's); apps signed in with a token (the Roku) get the new token.
  switchSession(req, res, user) {
    const old = req.sessionKey && this.store.data.sessions[req.sessionKey];
    if (!old?.device) { this.destroySession(req, res); this.createSession(req, res, user); return null; }
    delete this.store.data.sessions[req.sessionKey];
    const token = crypto.randomBytes(32).toString('base64url');
    const rest = { ...old };
    delete rest.mk; // (the new sign-in gets its own media key)
    this.store.data.sessions[tokenKey(token)] = { ...rest, userId: user.id, createdAt: Date.now(), lastSeenAt: Date.now(), expiresAt: Date.now() + DEVICE_TTL };
    user.lastLoginAt = Date.now();
    this.store.save();
    if (parseCookies(req.headers.cookie)[COOKIE]) { res.setHeader('Set-Cookie', this.deviceCookie(req, token)); return null; }
    return token;
  }

  destroySession(req, res) {
    if (req.sessionKey) delete this.store.data.sessions[req.sessionKey];
    this.store.save();
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
  }

  /** Where this account is signed in with a browser or the phone app (linked TVs: see devices). */
  signIns(user, currentKey) {
    return Object.entries(this.store.data.sessions).filter(([, s]) => !s.device && s.userId === user.id && s.expiresAt > Date.now())
      .map(([k, s]) => ({ ua: s.ua || '', createdAt: s.createdAt, current: k === currentKey }))
      .sort((a, b) => b.current - a.current || b.createdAt - a.createdAt);
  }

  /** Signs out every browser and phone but this one (linked TVs stay; they're unlinked one by one). */
  signOutOthers(user, exceptKey) {
    let n = 0;
    for (const [k, s] of Object.entries(this.store.data.sessions)) if (s.userId === user.id && !s.device && k !== exceptKey) { delete this.store.data.sessions[k]; n++; }
    this.store.save();
    return n;
  }

  endSessionsFor(userId, exceptKey = null) {
    for (const [k, s] of Object.entries(this.store.data.sessions)) if (s.userId === userId && k !== exceptKey) delete this.store.data.sessions[k];
    this.store.save();
  }

  // Simple brute-force protection: 8 failed logins per IP per 10 minutes.
  // Also per username (20 per 10 minutes, from anywhere): addresses can be made up on the home
  // network, a username can't. The record of attempts is trimmed so it can't grow without end.
  isLimited(ip, username = null) {
    const now = Date.now();
    if (this.failures.size > 5000) for (const [k, v] of this.failures) if (!v.some((t) => t > now - 600_000)) this.failures.delete(k);
    const count = (key) => {
      const recent = (this.failures.get(key) || []).filter((t) => t > now - 600_000);
      if (recent.length) this.failures.set(key, recent); else this.failures.delete(key);
      return recent.length;
    };
    return count(ip) >= 8 || (username != null && count(`user:${String(username).toLowerCase()}`) >= 20);
  }
  recordFailure(ip, username = null) {
    for (const key of [ip, ...(username != null ? [`user:${String(username).toLowerCase()}`] : [])]) {
      this.failures.set(key, [...(this.failures.get(key) || []), Date.now()].slice(-50));
    }
    // Remembered so an admin's Unlock can also lift the block on the device they were using.
    if (username != null && this.byName(username)) {
      const name = String(username).toLowerCase();
      const from = this.failedFrom.get(name) || new Set();
      if (from.size < 50) from.add(ip);
      this.failedFrom.set(name, from);
    }
  }

  /**
   * Whether someone is locked out, for the admin's Users list: signIn (too many wrong passwords,
   * for the name or from where they sign in) and pin (too many wrong PINs), each { until } or null.
   */
  lockInfo(user) {
    const now = Date.now();
    const name = user.username.toLowerCase();
    const recent = (key) => (this.failures.get(key) || []).filter((t) => t > now - 600_000);
    let signIn = null;
    const until = (list) => Math.min(...list) + 600_000;
    const own = recent(`user:${name}`);
    if (own.length >= 20) signIn = { until: until(own) };
    for (const ip of this.failedFrom.get(name) || []) {
      const r = recent(ip);
      if (r.length >= 8) signIn = { until: Math.max(signIn?.until || 0, until(r)) };
    }
    let pin = null;
    const day = (this.pinFailures.get(user.id) || []).filter((t) => t > now - 86400_000);
    if (day.length >= 15) pin = { until: Math.min(...day) + 86400_000, forToday: true };
    else {
      const ten = day.filter((t) => t > now - 600_000);
      if (ten.length >= 5) pin = { until: Math.min(...ten) + 600_000 };
    }
    return { signIn, pin };
  }

  /** An admin's Unlock: forgets the wrong passwords and PINs that locked this person out. */
  unlock(user) {
    const name = user.username.toLowerCase();
    this.failures.delete(`user:${name}`);
    for (const ip of this.failedFrom.get(name) || []) this.failures.delete(ip);
    this.failedFrom.delete(name);
    this.pinFailures.delete(user.id);
  }

  /**
   * An admin resets someone's password: to `password`, or a temporary one that's returned. With
   * mustChange they choose their own when they next sign in; signOut ends all their sign-ins (TVs
   * too); removePin takes their PIN away (a forgotten PIN). Any lockout is lifted.
   */
  async resetPassword(user, { password = null, mustChange = true, signOut = true, removePin = false, keepSession = null } = {}) {
    const chosen = password ? String(password) : temporaryPassword();
    await this.updateUser(user, { password: chosen });
    if (mustChange) user.mustChangePassword = true; else delete user.mustChangePassword;
    if (removePin) delete user.pin;
    if (signOut) this.endSessionsFor(user.id, keepSession);
    this.unlock(user);
    this.store.save();
    return password ? null : chosen;
  }

  async login(username, password) {
    const user = this.byName(username || '');
    // Hash even for unknown users so response time doesn't reveal which usernames exist.
    const ok = await verifyPassword(password || '', user?.password || 'scrypt$AAAA$AAAA');
    return ok && user ? user : null;
  }

  // ---- profiles ("Who's watching?") ----
  profiles() {
    return this.users.filter(onPicker).map((u) => ({ id: u.id, username: u.username, needsPin: !!u.pin, kids: u.role !== 'admin' && u.maxAge != null }))
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  async setPin(user, pin) {
    if (pin === null || pin === '') { delete user.pin; this.store.save(); return; }
    if (!PIN_RE.test(String(pin))) throw Object.assign(new Error('A PIN is 4 to 8 digits'), { status: 400 });
    user.pin = await hashPassword(String(pin));
    this.store.save();
  }

  // Switching to a profile needs its PIN (unless it's one allowed without). After 5 wrong PINs the
  // profile is locked for 10 minutes, and after 15 in a day for the rest of that day (signing in
  // with the password still works), so a 4-digit PIN can't be guessed by trying for days.
  async checkSwitch(target, pin) {
    if (!target || !onPicker(target)) throw Object.assign(new Error('That profile isn’t available here'), { status: 404 });
    if (!target.pin) return;
    const now = Date.now();
    const day = (this.pinFailures.get(target.id) || []).filter((t) => t > now - 86400_000);
    if (day.length >= 15) throw Object.assign(new Error('Too many wrong PINs today. Sign in with the password instead.'), { status: 429 });
    if (day.filter((t) => t > now - 600_000).length >= 5) throw Object.assign(new Error('Too many wrong PINs. Try again in a few minutes.'), { status: 429 });
    if (!(await verifyPassword(String(pin || ''), target.pin))) {
      this.pinFailures.set(target.id, [...day, now]);
      throw Object.assign(new Error('Wrong PIN'), { status: 401 });
    }
    this.pinFailures.delete(target.id);
  }

  validate(input, { existing = null, requirePassword = true } = {}) {
    const out = {};
    if (input.username !== undefined || !existing) {
      const name = String(input.username || '').trim();
      if (!USERNAME_RE.test(name)) throw Object.assign(new Error('Username must be 1–32 letters, numbers, spaces, dots, dashes or underscores'), { status: 400 });
      const clash = this.byName(name);
      if (clash && clash.id !== existing?.id) throw Object.assign(new Error('That username is taken'), { status: 400 });
      out.username = name;
    }
    if ((input.password !== undefined && input.password !== '') || (requirePassword && !existing)) {
      if (typeof input.password !== 'string' || input.password.length < 8) throw Object.assign(new Error('Password must be at least 8 characters'), { status: 400 });
      out.password = input.password;
    }
    if (input.role !== undefined) {
      if (!['admin', 'user'].includes(input.role)) throw Object.assign(new Error('Role must be admin or user'), { status: 400 });
      out.role = input.role;
    }
    if (input.libraries !== undefined) {
      if (input.libraries !== null && !Array.isArray(input.libraries)) throw Object.assign(new Error('libraries must be null (all) or a list'), { status: 400 });
      out.libraries = input.libraries === null ? null : input.libraries.filter((id) => this.store.library(id)).map(String);
    }
    if (input.canDownload !== undefined) out.canDownload = !!input.canDownload;
    if (input.noPin !== undefined) out.noPin = !!input.noPin;
    // Kids: the oldest age of ratings this person may watch (null = everything), and whether titles
    // without a rating (home videos, YouTube) show too.
    if (input.maxAge !== undefined) {
      const n = input.maxAge === null || input.maxAge === '' ? null : Number(input.maxAge);
      if (n !== null && !(Number.isInteger(n) && n >= 0 && n <= 18)) throw Object.assign(new Error('maxAge must be an age from 0 to 18, or null'), { status: 400 });
      out.maxAge = n;
    }
    if (input.allowUnrated !== undefined) out.allowUnrated = !!input.allowUnrated;
    if (input.autoApprove !== undefined) {
      const a = input.autoApprove || {};
      out.autoApprove = { movie: !!(a.movie ?? existing?.autoApprove?.movie), show: !!(a.show ?? existing?.autoApprove?.show) };
    }
    return out;
  }

  async createUser(input) {
    const v = this.validate(input);
    const user = {
      id: randomId(), username: v.username, password: await hashPassword(v.password),
      role: v.role || 'user', libraries: v.libraries ?? null, canDownload: v.canDownload ?? false, noPin: v.noPin ?? false,
      maxAge: v.maxAge ?? null, allowUnrated: v.allowUnrated ?? true, autoApprove: v.autoApprove ?? { movie: false, show: false }, createdAt: Date.now(),
    };
    this.users.push(user);
    this.store.save();
    return user;
  }

  async updateUser(user, input) {
    const v = this.validate(input, { existing: user, requirePassword: false });
    if (v.role === 'user' && user.role === 'admin' && this.users.filter((u) => u.role === 'admin').length === 1) {
      throw Object.assign(new Error('There must be at least one admin'), { status: 400 });
    }
    if (v.password) { user.password = await hashPassword(v.password); }
    for (const k of ['username', 'role', 'libraries', 'canDownload', 'noPin', 'maxAge', 'allowUnrated', 'autoApprove']) if (v[k] !== undefined) user[k] = v[k];
    this.store.save();
    return user;
  }

  deleteUser(user) {
    if (user.role === 'admin' && this.users.filter((u) => u.role === 'admin').length === 1) {
      throw Object.assign(new Error('Cannot delete the last admin'), { status: 400 });
    }
    this.store.data.users = this.users.filter((u) => u.id !== user.id);
    this.endSessionsFor(user.id);
    delete this.store.data.progress[user.id];
    delete this.store.data.watchlist?.[user.id];
    delete this.store.data.cwHidden?.[user.id];
    this.store.save();
  }
}

const canSeeLibrary = (user, libraryId) => user.role === 'admin' || !Array.isArray(user.libraries) || user.libraries.includes(libraryId);
const canDownload = (user) => user.role === 'admin' || !!user.canDownload;

module.exports = { Auth, publicUser, playerPrefs, cleanPrefs, canSeeLibrary, canDownload, hashPassword, verifyPassword };
