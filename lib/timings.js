'use strict';
// How quickly Marquee answers, for Settings → Logs → Speed: the slowest kinds of request since it
// started, the last few that took over a second, and whether the server itself stalled (busy
// working something out instead of answering anyone). So "it feels slow" comes with evidence.

const { monitorEventLoopDelay } = require('node:perf_hooks');

const SLOW_MS = 1000;
const KEEP_SLOW = 30;

class Timings {
  constructor() {
    this.started = Date.now();
    this.routes = new Map(); // "GET /api/libraries/:id/items" -> { count, totalMs, maxMs }
    this.slow = [];          // newest first: { at, what, ms, status, user }
    this.loop = monitorEventLoopDelay({ resolution: 20 });
    this.loop.enable();
  }

  /** One answered request. what: the route as written ("GET /api/shows/:id"), never the address itself (it can hold links' keys). */
  record(what, ms, { status = 200, user = null } = {}) {
    const r = this.routes.get(what) || { count: 0, totalMs: 0, maxMs: 0 };
    r.count++;
    r.totalMs += ms;
    r.maxMs = Math.max(r.maxMs, ms);
    this.routes.set(what, r);
    if (ms >= SLOW_MS) {
      this.slow.unshift({ at: Date.now(), what, ms: Math.round(ms), status, user });
      this.slow.length = Math.min(this.slow.length, KEEP_SLOW);
    }
  }

  report() {
    const ms = (ns) => Math.round(ns / 1e6);
    const routes = [...this.routes].map(([what, r]) => ({ what, count: r.count, avgMs: Math.round(r.totalMs / r.count), maxMs: Math.round(r.maxMs) }))
      .sort((a, b) => b.avgMs * b.count - a.avgMs * a.count).slice(0, 15);
    return {
      since: this.started,
      slowMs: SLOW_MS,
      slow: this.slow,
      routes,
      // How long the server went without being able to answer anyone (a long sort, a big save…).
      stalls: { p99Ms: ms(this.loop.percentile(99)), maxMs: ms(this.loop.max) },
    };
  }

  reset() {
    this.routes.clear();
    this.slow = [];
    this.loop.reset();
    this.started = Date.now();
  }
}

module.exports = { Timings, SLOW_MS };
