'use strict';
// Sign-in, "Who's watching?" profiles and user accounts.
// Registered by server.js, which passes the shared helpers and services in `app`.

module.exports = function register(app) {
  const {
    publicUser, store, auth, HttpError, json, readBody, getUser, isPrivateIp,
    clientIp, route,
  } = app;

  // --- auth ---
  // Public: also used by the Android app to recognise Marquee servers on the network.
  route('GET', '/api/health', async (req, res) => json(res, 200, { ok: true, name: 'Marquee', version: require('../package.json').version }), 'public');

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
    if (auth.isLimited(ip)) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
    const body = await readBody(req);
    const user = await auth.login(body.username, body.password);
    if (!user) { auth.recordFailure(ip); throw new HttpError(401, 'Wrong username or password'); }
    auth.createSession(req, res, user);
    json(res, 200, { user: publicUser(user) });
  }, 'public');

  route('POST', '/api/auth/logout', async (req, res, p, url, user) => {
    if (user) auth.destroySession(req, res);
    json(res, 200, { ok: true });
  }, 'public');

  // --- profiles ("Who's watching?") ---
  route('GET', '/api/profiles', async (req, res, p, url, user) => json(res, 200, { current: user.id, profiles: auth.profiles() }));
  route('POST', '/api/auth/switch', async (req, res, p, url, user) => {
    const body = await readBody(req);
    const target = auth.byId(String(body.userId || ''));
    if (target?.id === user.id) return json(res, 200, { user: publicUser(user) });
    await auth.checkSwitch(target, body.pin);
    auth.destroySession(req, res);
    auth.createSession(req, res, target);
    json(res, 200, { user: publicUser(target) });
  });
  // Set or remove your own PIN (needs your password).
  route('POST', '/api/auth/pin', async (req, res, p, url, user) => {
    const body = await readBody(req);
    if (!(await auth.login(user.username, body.currentPassword))) throw new HttpError(400, 'Current password is incorrect');
    await auth.setPin(user, body.pin || null);
    json(res, 200, { user: publicUser(user) });
  });

  route('POST', '/api/auth/password', async (req, res, p, url, user) => {
    const body = await readBody(req);
    if (!(await auth.login(user.username, body.currentPassword))) throw new HttpError(400, 'Current password is incorrect');
    await auth.updateUser(user, { password: body.newPassword || '' });
    auth.endSessionsFor(user.id, req.sessionKey); // sign out other devices
    json(res, 200, { ok: true });
  });

  // --- users (admin) ---
  route('GET', '/api/users', async (req, res) => json(res, 200, auth.users.map(publicUser)), 'admin');

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
    json(res, 200, { ok: true });
  }, 'admin');
};
