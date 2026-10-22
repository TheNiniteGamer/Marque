'use strict';
// Sign-in, "Who's watching?" profiles and user accounts.
// Registered by server.js, which passes the shared helpers and services in `app`.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { playerPrefs, cleanPrefs, cleanAvatar } = require('../lib/auth');

module.exports = function register(app) {
  const {
    publicUser, store, auth, HttpError, json, readBody, getUser, isPrivateIp,
    clientIp, isRemote, route, tokens, readRaw, sendFile, DATA_DIR,
  } = app;

  // Profile pictures: a built-in face on a colour, or an uploaded photo. Your own, or (admins)
  // anyone's with ?user=<id>.
  const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
  const photoFile = (id) => path.join(AVATAR_DIR, path.basename(id));
  const removePhoto = (id) => fs.rmSync(photoFile(id), { force: true });
  const avatarTarget = (url, me) => {
    const id = url.searchParams.get('user');
    if (!id || id === me.id) return me;
    if (me.role !== 'admin') throw new HttpError(403, 'Admins only');
    return getUser(id);
  };
  const IMAGE_TYPES = [['image/jpeg', [0xff, 0xd8, 0xff]], ['image/png', [0x89, 0x50, 0x4e, 0x47]], ['image/webp', [0x52, 0x49, 0x46, 0x46]]];

  // --- auth ---
  // Public: also used by the Android app to recognise Marquee servers on the network.
  // `server`: the PC's name, so TVs and phones looking for Marquee on the network can show which one it is.
  const serverName = (() => {
    const n = (process.env.MARQUEE_NAME || os.hostname() || '').trim();
    return n && !/^[0-9a-f]{12}$/.test(n) ? n.slice(0, 60) : null; // (a Docker container's id isn't a name)
  })();
  route('GET', '/api/health', async (req, res) => json(res, 200, { ok: true, name: 'Marquee', version: require('../package.json').version, server: serverName }), 'public');

  route('GET', '/api/auth/me', async (req, res, p, url, user) => {
    if (!user) return json(res, 401, { error: 'Not signed in', setupRequired: !auth.hasUsers() });
    json(res, 200, { user: publicUser(user) });
  }, 'public');

  route('POST', '/api/auth/setup', async (req, res) => {
    if (auth.hasUsers()) throw new HttpError(409, 'Setup is already complete');
    // Before an admin exists, anyone reaching the page could claim the server; only allow that at home.
    if (!isPrivateIp(clientIp(req))) throw new HttpError(403, 'Create the first account from your home network, then sign in from anywhere.');
    const body = await readBody(req);
    const user = await auth.createUser({ username: body.username, password: body.password, role: 'admin' });
    // Watch history recorded before accounts existed (flat itemId -> progress) belongs to the first admin.
    const flat = Object.entries(store.data.progress).filter(([, v]) => v && typeof v.updatedAt === 'number');
    if (flat.length) {
      store.data.progress[user.id] = Object.fromEntries(flat);
      for (const [k] of flat) delete store.data.progress[k];
    }
    auth.createSession(req, res, user);
    json(res, 201, { user: publicUser(user) });
  }, 'public');

  route('POST', '/api/auth/login', async (req, res) => {
    const ip = clientIp(req);
    const body = await readBody(req);
    const name = String(body.username || '').slice(0, 64);
    const where = isRemote(req) ? 'away' : 'home';
    if (auth.isLimited(ip, name, where)) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
    const user = await auth.login(name, body.password);
    if (!user) { auth.recordFailure(ip, name, where); throw new HttpError(401, 'Wrong username or password'); }
    auth.createSession(req, res, user);
    json(res, 200, { user: publicUser(user) });
  }, 'public');

  // For TVs: the key to put in picture and video addresses instead of the sign-in (see auth.mediaKey).
  route('GET', '/api/auth/media-key', async (req, res) => {
    const key = auth.mediaKey(req);
    if (!key) throw new HttpError(400, 'No sign-in to make a key for');
    json(res, 200, { key });
  });

  route('POST', '/api/auth/logout', async (req, res, p, url, user) => {
    if (user) auth.destroySession(req, res);
    json(res, 200, { ok: true });
  }, 'public');

  // --- linking a TV with a code ---
  const pairLimits = new Map(); // ip -> [timestamps]
  route('POST', '/api/devices/pair', async (req, res) => {
    const ip = clientIp(req);
    if (pairLimits.size > 5000) for (const [k, v] of pairLimits) if (!v.some((t) => t > Date.now() - 600_000)) pairLimits.delete(k);
    const recent = (pairLimits.get(ip) || []).filter((t) => t > Date.now() - 600_000);
    if (recent.length >= 20) throw new HttpError(429, 'Too many codes asked for. Try again in a few minutes.');
    pairLimits.set(ip, [...recent, Date.now()]);
    const body = await readBody(req);
    try { json(res, 200, auth.startPairing(body.name)); } catch (err) { throw new HttpError(err.status || 400, err.message); }
  }, 'public');
  // The TV asks until someone enters the code. ?cookie=1 (the web interface on a TV) signs that browser in.
  route('GET', '/api/devices/pair/:id', async (req, res, { id }, url) => {
    const r = auth.claimPairing(id);
    if (!r) throw new HttpError(404, 'This code has expired. Ask for a new one.');
    if (r.status === 'linked' && url.searchParams.get('cookie') === '1') res.setHeader('Set-Cookie', auth.deviceCookie(req, r.token));
    json(res, 200, r.status === 'linked' ? { status: 'linked', token: r.token, user: publicUser(r.user) } : r);
  }, 'public');
  route('POST', '/api/devices/link', async (req, res, p, url, user) => {
    try { json(res, 200, { ok: true, name: auth.linkDevice(req, user, (await readBody(req)).code) }); } catch (err) { throw new HttpError(err.status || 400, err.message); }
  });
  route('GET', '/api/devices', async (req, res, p, url, user) => json(res, 200, auth.devices(user)));
  route('DELETE', '/api/devices/:id', async (req, res, { id }, url, user) => {
    try { auth.removeDevice(user, id); } catch (err) { throw new HttpError(err.status || 400, err.message); }
    json(res, 200, { ok: true });
  });

  // --- profiles ("Who's watching?") ---
  route('GET', '/api/profiles', async (req, res, p, url, user) => json(res, 200, { current: user.id, currentName: user.username, profiles: auth.profiles() }));
  route('POST', '/api/auth/switch', async (req, res, p, url, user) => {
    const body = await readBody(req);
    const target = auth.byId(String(body.userId || ''));
    if (target?.id === user.id) return json(res, 200, { user: publicUser(user) });
    await auth.checkSwitch(target, body.pin);
    const token = auth.switchSession(req, res, target);
    json(res, 200, { user: publicUser(target), ...(token ? { token } : {}) });
  });
  // Set or remove your own PIN (needs your password).
  route('POST', '/api/auth/pin', async (req, res, p, url, user) => {
    const body = await readBody(req);
    if (!(await auth.login(user.username, body.currentPassword))) throw new HttpError(400, 'Current password is incorrect');
    await auth.setPin(user, body.pin || null);
    json(res, 200, { user: publicUser(user) });
  });

  // { face, color } for a built-in picture, or {} to go back to your initial.
  route('PUT', '/api/auth/avatar', async (req, res, p, url, me) => {
    const target = avatarTarget(url, me);
    const body = await readBody(req);
    let avatar = null;
    if (body.face != null) {
      try { avatar = cleanAvatar(body); } catch (err) { throw new HttpError(400, err.message); }
    }
    removePhoto(target.id);
    if (avatar) target.avatar = avatar; else delete target.avatar;
    store.save();
    json(res, 200, { user: publicUser(target) });
  });
  // A photo (the page makes it a small square JPEG first): the image itself as the body.
  route('POST', '/api/auth/avatar/photo', async (req, res, p, url, me) => {
    const target = avatarTarget(url, me);
    const buf = await readRaw(req, 2 * 1024 * 1024);
    const type = IMAGE_TYPES.find(([, magic]) => magic.every((b, i) => buf[i] === b))?.[0];
    if (!type) throw new HttpError(400, 'That isn’t a JPEG, PNG or WebP picture');
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
    fs.writeFileSync(photoFile(target.id), buf);
    target.avatar = { photo: Date.now(), type };
    store.save();
    json(res, 200, { user: publicUser(target) });
  });
  route('GET', '/api/avatars/:id', async (req, res, { id }) => {
    const u = getUser(id);
    if (!u.avatar?.photo || !fs.existsSync(photoFile(u.id))) throw new HttpError(404, 'No photo');
    sendFile(req, res, photoFile(u.id), { type: u.avatar.type || 'image/jpeg', headers: { 'Cache-Control': 'private, max-age=31536000, immutable' } });
  }, 'media');

  // Where you're signed in (browsers and the phone app), and signing out of all of them but this one.
  route('GET', '/api/auth/sessions', async (req, res, p, url, user) => {
    const { deviceName } = require('../lib/activity');
    json(res, 200, { signIns: auth.signIns(user, req.sessionKey).map(({ ua, ...s }) => ({ ...s, device: deviceName(ua) })), tvs: auth.devices(user) });
  });
  route('POST', '/api/auth/signout-others', async (req, res, p, url, user) => json(res, 200, { signedOut: auth.signOutOthers(user, req.sessionKey) }));

  // Player settings for your account (they apply on every device you watch on).
  route('PUT', '/api/auth/prefs', async (req, res, p, url, user) => {
    const body = await readBody(req);
    let clean;
    try { clean = cleanPrefs(body || {}); } catch (err) { throw new HttpError(400, err.message); }
    user.prefs = { ...(user.prefs || {}), ...clean };
    store.save();
    json(res, 200, { prefs: playerPrefs(user) });
  });

  route('POST', '/api/auth/password', async (req, res, p, url, user) => {
    const body = await readBody(req);
    // After an admin's reset, the temporary password was just used to sign in: not asked again.
    if (!user.mustChangePassword && !(await auth.login(user.username, body.currentPassword))) throw new HttpError(400, 'Current password is incorrect');
    if (user.mustChangePassword && body.newPassword && (await auth.login(user.username, body.newPassword))) throw new HttpError(400, 'Choose a password that isn’t the temporary one');
    await auth.updateUser(user, { password: body.newPassword || '' });
    delete user.mustChangePassword;
    auth.endSessionsFor(user.id, req.sessionKey); // sign out other devices
    tokens.rotate(); // and playback links handed out before (they last up to 12 hours)
    json(res, 200, { ok: true });
  });

  // --- users (admin) ---
  route('GET', '/api/users', async (req, res) => json(res, 200, auth.users.map((u) => ({ ...publicUser(u), locks: auth.lockInfo(u) }))), 'admin');

  // Reset someone's password (a temporary one is made unless one is given; see auth.resetPassword).
  route('POST', '/api/users/:id/reset-password', async (req, res, { id }, url, me) => {
    const target = getUser(id);
    const body = await readBody(req);
    let temporary;
    try {
      temporary = await auth.resetPassword(target, {
        password: body.password ? String(body.password) : null, mustChange: body.mustChange !== false, signOut: body.signOut !== false,
        removePin: !!body.removePin, keepSession: target.id === me.id ? req.sessionKey : null,
      });
    } catch (err) { throw new HttpError(err.status || 400, err.message); }
    tokens.rotate(); // playback links handed out to them before stop working
    console.log(`[users] ${me.username} reset the password of ${target.username}`);
    json(res, 200, { user: { ...publicUser(target), locks: auth.lockInfo(target) }, temporaryPassword: temporary });
  }, 'admin');

  // Lift a lockout (too many wrong passwords or PINs).
  route('POST', '/api/users/:id/unlock', async (req, res, { id }, url, me) => {
    const target = getUser(id);
    auth.unlock(target);
    console.log(`[users] ${me.username} unlocked ${target.username}`);
    json(res, 200, { ...publicUser(target), locks: auth.lockInfo(target) });
  }, 'admin');

  route('POST', '/api/users', async (req, res) => {
    const user = await auth.createUser(await readBody(req));
    json(res, 201, publicUser(user));
  }, 'admin');

  route('PATCH', '/api/users/:id', async (req, res, { id }, url, me) => {
    const target = getUser(id);
    const body = await readBody(req);
    if (target.id === me.id && body.role === 'user') throw new HttpError(400, 'You cannot remove your own admin role');
    await auth.updateUser(target, body);
    if (body.password) auth.endSessionsFor(target.id, target.id === me.id ? req.sessionKey : null);
    json(res, 200, publicUser(target));
  }, 'admin');

  route('DELETE', '/api/users/:id', async (req, res, { id }, url, me) => {
    const target = getUser(id);
    if (target.id === me.id) throw new HttpError(400, 'You cannot delete your own account');
    auth.deleteUser(target);
    removePhoto(target.id);
    tokens.rotate(); // playback links they were given stop working too
    json(res, 200, { ok: true });
  }, 'admin');
};
