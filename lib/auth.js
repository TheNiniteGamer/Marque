'use strict';
// Users, password hashing (scrypt) and cookie sessions.

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { randomId } = require('./store');

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'mq_session';
const SESSION_TTL = 30 * 24 * 3600 * 1000;
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

const publicUser = (u) => u && ({
  id: u.id, username: u.username, role: u.role,
  libraries: u.role === 'admin' ? null : (u.libraries ?? null),
  canDownload: u.role === 'admin' || !!u.canDownload,
  createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null,
});

class Auth {
  constructor(store) {
    this.store = store;
    store.data.users ||= [];
    store.data.sessions ||= {};
    this.failures = new Map(); // ip -> [timestamps]
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
  authenticate(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const key = tokenKey(token);
    const s = this.store.data.sessions[key];
    if (!s || s.expiresAt < Date.now()) return null;
    const user = this.byId(s.userId);
    if (!user) return null;
    if (s.expiresAt - Date.now() < SESSION_TTL - 24 * 3600 * 1000) { s.expiresAt = Date.now() + SESSION_TTL; this.store.save(); }
    req.sessionKey = key;
    return user;
  }

  createSession(req, res, user) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.store.data.sessions[tokenKey(token)] = { userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL, ua: String(req.headers['user-agent'] || '').slice(0, 120) };
    user.lastLoginAt = Date.now();
    this.store.save();
    res.setHeader('Set-Cookie', sessionCookie(req, token, SESSION_TTL / 1000));
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
      if (typeof input.password !== 'string' || input.password.length < 6) throw Object.assign(new Error('Password must be at least 6 characters'), { status: 400 });
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
    return out;
  }

  async createUser(input) {
    const v = this.validate(input);
    const user = {
      id: randomId(), username: v.username, password: await hashPassword(v.password),
      role: v.role || 'user', libraries: v.libraries ?? null, canDownload: v.canDownload ?? false, createdAt: Date.now(),
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
    for (const k of ['username', 'role', 'libraries', 'canDownload']) if (v[k] !== undefined) user[k] = v[k];
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
    this.store.save();
  }
}

const canSeeLibrary = (user, libraryId) => user.role === 'admin' || !Array.isArray(user.libraries) || user.libraries.includes(libraryId);
const canDownload = (user) => user.role === 'admin' || !!user.canDownload;

module.exports = { Auth, publicUser, canSeeLibrary, canDownload, hashPassword, verifyPassword };
