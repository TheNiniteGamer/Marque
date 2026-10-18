'use strict';
// "Now playing" for the admin's Activity page. Players report their position (every 10 s, playing
// or paused) with how they play the video; anything not heard from for 30 s has stopped.

const os = require('node:os');

const STALE_MS = 30_000;

// A short description of the device from its User-Agent.
function deviceName(ua = '') {
  if (/Dalvik|MarqueeAndroid/i.test(ua)) return 'Android app';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const system = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : '';
  return system ? `${browser} on ${system}` : browser;
}

class Activity {
  constructor() {
    this.sessions = new Map();
    this.cpuBefore = os.cpus();
  }

  report(user, item, { client, position, paused, mode, quality, ip, remote, ua, stopped }) {
    const key = `${user.id}|${client || `${ip}|${ua}`}`;
    if (stopped) { this.sessions.delete(key); return; }
    const prev = this.sessions.get(key);
    this.sessions.set(key, {
      key, userId: user.id, user: user.username, itemId: item.id, position, paused: !!paused,
      mode: ['direct', 'transcode', 'hls', 'cast'].includes(mode) ? mode : null, quality: quality || null,
      device: deviceName(ua), ip, remote,
      startedAt: prev?.itemId === item.id ? prev.startedAt : Date.now(), updatedAt: Date.now(),
    });
  }

  list() {
    const now = Date.now();
    for (const [k, s] of this.sessions) if (now - s.updatedAt > STALE_MS) this.sessions.delete(k);
    return [...this.sessions.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  // Whole-machine CPU use since the previous call, in percent.
  cpu() {
    const now = os.cpus();
    let idle = 0, total = 0;
    now.forEach((c, i) => {
      const b = this.cpuBefore[i]?.times;
      if (!b) return;
      const t = c.times;
      idle += t.idle - b.idle;
      total += (t.user - b.user) + (t.nice - b.nice) + (t.sys - b.sys) + (t.irq - b.irq) + (t.idle - b.idle);
    });
    this.cpuBefore = now;
    return { percent: total > 0 ? Math.round((1 - idle / total) * 100) : 0, cores: now.length };
  }
}

module.exports = { Activity, deviceName };
