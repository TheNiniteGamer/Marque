'use strict';
// Watch together: a "party" keeps everyone's player on the same video, position and play/pause.
// Whoever presses play, pause or seeks sends the new state; the server stamps it with its own clock
// and pushes it to every member over a Server-Sent Events stream. Players extrapolate the position
// from that stamp and correct themselves when they drift.

const crypto = require('node:crypto');

const EMPTY_TTL = 10 * 60_000; // a party with nobody in it is forgotten after this
const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const newId = () => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/I)
  return Array.from(crypto.randomBytes(6), (b) => abc[b % abc.length]).join('');
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
    const p = { id: newId(), host: user.username, itemId, playing: !!playing, position, updatedAt: Date.now(), from: null, members: new Map(), emptySince: Date.now() };
    this.parties.set(p.id, p);
    return p;
  }

  view(p) {
    return { id: p.id, host: p.host, itemId: p.itemId, playing: p.playing, position: p.position, updatedAt: p.updatedAt, from: p.from,
      serverNow: Date.now(), members: [...p.members.values()].map((m) => m.name) };
  }

  send(res, msg) { res.write(`data: ${JSON.stringify(msg)}\n\n`); }
  broadcast(p) { const v = this.view(p); for (const m of p.members.values()) this.send(m.res, v); }

  // Opens a member's event stream; it stays open until they leave.
  join(p, user, clientId, res) {
    if (!/^[\w-]{6,40}$/.test(clientId || '')) throw httpError(400, 'Missing client id');
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

  update(p, { clientId, itemId, playing, position }) {
    if (!Number.isFinite(Number(position)) || Number(position) < 0) throw httpError(400, 'Bad position');
    Object.assign(p, { itemId: itemId || p.itemId, playing: !!playing, position: Number(position), updatedAt: Date.now(), from: clientId || null });
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
