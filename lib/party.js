'use strict';
// Watch together: a "party" keeps everyone's player on the same video, position and play/pause.
// Whoever presses play, pause or seeks sends the new state; the server stamps it with its own clock
// and pushes it to every member over a Server-Sent Events stream. Players extrapolate the position
// from that stamp and correct themselves when they drift.

const crypto = require('node:crypto');

const EMPTY_TTL = 10 * 60_000; // a party with nobody in it is forgotten after this
const CLIENT_RE = /^[\w-]{6,40}$/;
const MAX_CLIENTS = 100; // client ids one party remembers
const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const newId = () => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/I)
  // 12 letters (about 60 bits): a party's link can't be found by trying.
  return Array.from(crypto.randomBytes(12), (b) => abc[b % abc.length]).join('');
};

class Parties {
  constructor() {
    this.parties = new Map();
    setInterval(() => this.sweep(), 60_000).unref();
    setInterval(() => this.heartbeat(), 25_000).unref();
  }

  get(id) {
    const p = this.parties.get(String(id).toUpperCase());
    if (!p) throw httpError(404, 'This watch party has ended');
    return p;
  }

  create(user, itemId, { position = 0, playing = false } = {}) {
    if ([...this.parties.values()].filter((x) => x.host === user.username).length >= 5) throw httpError(429, 'You have 5 watch parties going already; end one first');
    const p = { id: newId(), host: user.username, itemId, playing: !!playing, position, updatedAt: Date.now(), from: null, members: new Map(), clients: new Map(), emptySince: Date.now() };
    this.parties.set(p.id, p);
    return p;
  }

  view(p) {
    return { id: p.id, host: p.host, itemId: p.itemId, playing: p.playing, position: p.position, updatedAt: p.updatedAt, from: p.from,
      serverNow: Date.now(), members: [...p.members.values()].map((m) => m.name) };
  }

  send(res, msg) { res.write(`data: ${JSON.stringify(msg)}\n\n`); }
  broadcast(p) { const v = this.view(p); for (const m of p.members.values()) this.send(m.res, v); }

  // Opens a member's event stream; it stays open until they leave. A player's client id (made up by
  // the player, and shown to everyone as who made the last change) is its own for as long as the
  // party lasts: someone else using it can't take its place or speak for it.
  join(p, user, clientId, res) {
    if (!CLIENT_RE.test(clientId || '')) throw httpError(400, 'Missing client id');
    const owner = p.clients.get(clientId);
    if (owner && owner !== user.id) throw httpError(409, 'That player is already in this watch party');
    if (!owner && p.clients.size >= MAX_CLIENTS) {
      // (Each player that joins has its own, so a long evening adds up: the ones gone are forgotten.)
      for (const id of p.clients.keys()) if (!p.members.has(id)) p.clients.delete(id);
      if (p.clients.size >= MAX_CLIENTS) throw httpError(429, 'Too many players are in this watch party');
    }
    p.clients.set(clientId, user.id);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    p.members.get(clientId)?.res.end();
    p.members.set(clientId, { name: user.username, res });
    p.emptySince = null;
    res.on('close', () => {
      if (p.members.get(clientId)?.res !== res) return;
      p.members.delete(clientId);
      if (!p.members.size) p.emptySince = Date.now();
      this.broadcast(p);
    });
    this.broadcast(p);
  }

  // (`from`, the player that made the change, only when it's one of this person's own.)
  update(p, user, { clientId, itemId, playing, position }) {
    if (!Number.isFinite(Number(position)) || Number(position) < 0) throw httpError(400, 'Bad position');
    const from = typeof clientId === 'string' && p.clients.get(clientId) === user.id ? clientId : null;
    Object.assign(p, { itemId: itemId ? String(itemId) : p.itemId, playing: !!playing, position: Number(position), updatedAt: Date.now(), from });
    this.broadcast(p);
  }

  // A comment line now and then keeps proxies and tunnels from closing quiet streams.
  heartbeat() { for (const p of this.parties.values()) for (const m of p.members.values()) m.res.write(': ping\n\n'); }

  sweep() {
    for (const [id, p] of this.parties) if (p.emptySince && Date.now() - p.emptySince > EMPTY_TTL) this.parties.delete(id);
  }

  closeAll() { for (const p of this.parties.values()) for (const m of p.members.values()) m.res.end(); }
}

module.exports = { Parties };
