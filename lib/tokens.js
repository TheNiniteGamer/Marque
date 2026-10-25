'use strict';
// Signed, expiring links to one video. Players that can't send the login cookie (Chromecast,
// AirPlay, the Android app's native player, hls.js segment requests from a TV) use these instead.
// A token only opens the playback files of the item it was made for.

const crypto = require('node:crypto');

const TTL_MS = 12 * 3600 * 1000;

class MediaTokens {
  constructor(store) { this.store = store; }

  secret() {
    if (!this.store.data.mediaSecret) {
      this.store.data.mediaSecret = crypto.randomBytes(32).toString('base64url');
      this.store.save();
    }
    return this.store.data.mediaSecret;
  }

  sign(body) { return crypto.createHmac('sha256', this.secret()).update(body).digest('base64url').slice(0, 32); }

  create(itemId, userId, ttl = TTL_MS) {
    const body = `${itemId}.${userId}.${(Date.now() + ttl).toString(36)}`;
    return `${body}.${this.sign(body)}`;
  }

  // One person's links handed out until now stop working (their password changed); others' carry on.
  revoke(userId) {
    const now = Date.now();
    const list = (this.store.data.linksRevoked ||= {});
    for (const [id, at] of Object.entries(list)) if (now - at > TTL_MS) delete list[id]; // (their links have run out anyway)
    list[userId] = now;
    this.store.save();
  }

  // { itemId, userId } when valid, else null.
  verify(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 4) return null;
    const [itemId, userId, exp, sig] = parts;
    const want = this.sign(`${itemId}.${userId}.${exp}`);
    if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
    if (parseInt(exp, 36) < Date.now()) return null;
    // (Made before their links were revoked: a link is made TTL_MS before it runs out.)
    const revoked = this.store.data.linksRevoked?.[userId];
    if (revoked && parseInt(exp, 36) - TTL_MS < revoked) return null;
    return { itemId, userId };
  }

  // Changing the secret invalidates every link handed out (after restoring a backup).
  rotate() { delete this.store.data.mediaSecret; this.secret(); }
}

module.exports = { MediaTokens, TTL_MS };
