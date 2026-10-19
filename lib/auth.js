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
const PLAYER_PREFS = { autoplayNext: true, autoSkipIntro: false, skipFade: 10, nightMode: false };
const SKIP_FADES = [0, 5, 10, 15, 30];
function playerPrefs(u) { return { ...PLAYER_PREFS, ...(u?.prefs || {}) }; }
function cleanPrefs(body) {
  const out = {};
  for (const k of ['autoplayNext', 'autoSkipIntro', 'nightMode']) if (typeof body[k] === 'boolean') out[k] = body[k];
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
  createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null,
  hasPin: !!u.pin, noPin: u.role !== 'admin' && !!u.noPin,
  // A kids profile: titles rated above this age are hidden (admins see everything).
  maxAge: u.role === 'admin' ? null : (u.maxAge ?? null), allowUnrated: u.allowUnrated !== false,
  prefs: playerPrefs(u), prefsSaved: !!u.prefs,
});

// "Who's watching?" lists people with a PIN, and accounts an admin has allowed without one (kids).
const onPicker = (u) => !!u.pin || (u.role !== 'admin' && !!u.noPin);
const PIN_RE = /^\d{4,8}$/;

class Auth {
  constructor(store) {
    this.store = store;
    store.data.users ||= [];
    store.data.sessions ||= {};
    this.failures = new Map(); // ip -> [timestamps]
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
  }

  // Returns the logged-in user (raw record) or null; slides the session expiry forward.
  // queryToken: a device token given in the address (only accepted for playback files and artwork).
  authenticate(req, { queryToken = null } = {}) {
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    const token = parseCookies(req.headers.cookie)[COOKIE] || bearer?.[1] || queryToken;
    if (!token) return null;
    const key = tokenKey(token);
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
    this.store.data.sessions[tokenKey(token)] = { ...old, userId: user.id, createdAt: Date.now(), lastSeenAt: Date.now(), expiresAt: Date.now() + DEVICE_TTL };
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

  endSessionsFor(userId, exceptKey = null) {
    for (const [k, s] of Object.entries(this.store.data.sessions)) if (s.userId === userId && k !== exceptKey) delete this.store.data.sessions[k];
    this.store.save();
  }

  // Simple brute-force protection: 8 failed logins per IP per 10 minutes.
  isLimited(ip) {
    const recent = (this.failures.get(ip) || []).filter((t) => t > Date.now() - 600_000);
    this.failures.set(ip, recent);
    return recent.length >= 8;
  }
  recordFailure(ip) { this.failures.set(ip, [...(this.failures.get(ip) || []), Date.now()]); }

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
  // profile is locked for 10 minutes, so a 4-digit PIN can't simply be guessed.
  async checkSwitch(target, pin) {
    if (!target || !onPicker(target)) throw Object.assign(new Error('That profile isn’t available here'), { status: 404 });
    if (!target.pin) return;
    const recent = (this.pinFailures.get(target.id) || []).filter((t) => t > Date.now() - 600_000);
    if (recent.length >= 5) throw Object.assign(new Error('Too many wrong PINs. Try again in a few minutes.'), { status: 429 });
    if (!(await verifyPassword(String(pin || ''), target.pin))) {
      this.pinFailures.set(target.id, [...recent, Date.now()]);
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
    return out;
  }

  async createUser(input) {
    const v = this.validate(input);
    const user = {
      id: randomId(), username: v.username, password: await hashPassword(v.password),
      role: v.role || 'user', libraries: v.libraries ?? null, canDownload: v.canDownload ?? false, noPin: v.noPin ?? false,
      maxAge: v.maxAge ?? null, allowUnrated: v.allowUnrated ?? true, createdAt: Date.now(),
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
    for (const k of ['username', 'role', 'libraries', 'canDownload', 'noPin', 'maxAge', 'allowUnrated']) if (v[k] !== undefined) user[k] = v[k];
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
