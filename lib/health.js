'use strict';
// The health check: things that quietly go wrong on a home server, looked at every 10 minutes and
// shown under Settings → Health. When something turns bad (or worse), admins get a notification;
// it's not repeated while it stays the same.
//
// Each check: { id, level: 'ok' | 'info' | 'warn' | 'bad', title, detail, link }.

const fs = require('node:fs');
const path = require('node:path');
const notifications = require('./notifications');

const GB = 1024 ** 3;
const RANK = { ok: 0, info: 1, warn: 2, bad: 3 };
const CHECK_EVERY_MS = 10 * 60_000;

function freeSpace(dir) {
  try {
    const s = fs.statfsSync(dir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch { return null; }
}

const gb = (n) => `${(n / GB).toFixed(n < 10 * GB ? 1 : 0)} GB`;

class Health {
  /**
   * deps: { store, dataDir, transcodeDir, backups, updater, hwaccel, logs, labelFor, arr }, each optional
   * apart from store, so tests can check a part at a time.
   */
  constructor(deps) {
    this.d = deps;
    this.last = null;
  }

  checks() {
    const { store, dataDir, transcodeDir, backups, updater, hwaccel, logs, arr, labelFor = () => null } = this.d;
    const out = [];
    const add = (c) => out.push({ link: null, detail: '', ...c });

    // --- disk space where Marquee writes: its data (database, artwork, backups), conversions, backup copies
    const places = [['data', dataDir, 'Marquee’s data (database, artwork, backups)'], ['conversions', transcodeDir, 'Video conversions']];
    const copyTo = backups?.settings().copyTo;
    if (copyTo) places.push(['backup-copies', copyTo, 'The second copy of backups']);
    for (const [id, dir, what] of places) {
      if (!dir) continue;
      const s = freeSpace(dir);
      if (!s || !s.total) continue;
      const pct = s.free / s.total;
      const level = s.free < 1 * GB || pct < 0.02 ? 'bad' : s.free < 5 * GB || pct < 0.05 ? 'warn' : 'ok';
      add({ id: `disk-${id}`, level, title: level === 'ok' ? `Disk space: ${what}` : `Running out of disk space: ${what}`,
        detail: `${gb(s.free)} free of ${gb(s.total)} on ${labelFor(dir) || dir}.${level === 'ok' ? '' : ' When it fills up, saving and converting stop working.'}` });
    }

    // --- library folders that can't be found (a drive unplugged, or not shared with Docker)
    const missing = [];
    for (const l of store.data.libraries || []) for (const p of l.paths || []) if (!fs.existsSync(p)) missing.push(`${l.name}: ${labelFor(p) || p}`);
    add(missing.length
      ? { id: 'folders', level: 'bad', title: `${missing.length} library folder${missing.length === 1 ? ' is' : 's are'} offline`, detail: `${missing.join(' · ')}. Their titles stay, but won't play until the folder is back.`, link: '#/settings/libraries' }
      : { id: 'folders', level: 'ok', title: 'Library folders are all there' });

    // --- backups
    if (backups) {
      const s = backups.settings();
      const latest = backups.list()[0];
      const age = latest ? Date.now() - latest.createdAt : Infinity;
      const failed = store.data.backupFailed;
      if (failed && (!latest || failed.at > latest.createdAt)) add({ id: 'backup-age', level: 'bad', title: 'The last automatic backup failed', detail: failed.error, link: '#/settings/backups' });
      else if (!latest) add({ id: 'backup-age', level: s.auto ? 'info' : 'warn', title: 'No backups yet', detail: s.auto ? 'The first automatic one is made tonight.' : 'Automatic backups are off.', link: '#/settings/backups' });
      else if (s.auto && age > 3 * 86400_000) add({ id: 'backup-age', level: 'bad', title: 'Backups have stopped', detail: `The newest is from ${new Date(latest.createdAt).toLocaleString()}. Check Settings → Logs for why.`, link: '#/settings/backups' });
      else if (!s.auto) add({ id: 'backup-age', level: 'warn', title: 'Automatic backups are off', detail: 'Turn them on under Settings → Backups.', link: '#/settings/backups' });
      else add({ id: 'backup-age', level: 'ok', title: 'Backups are up to date', detail: `Newest: ${new Date(latest.createdAt).toLocaleString()}` });
      const copy = store.data.backupCopy;
      if (!s.copyTo) add({ id: 'backup-copy', level: 'info', title: 'Backups are only on this PC', detail: 'Keep a second copy on another drive or a cloud-synced folder (Settings → Backups), so a dead disk doesn’t take them too.', link: '#/settings/backups' });
      else if (copy && !copy.ok) add({ id: 'backup-copy', level: 'bad', title: 'Backups aren’t being copied', detail: `The copy to ${labelFor(s.copyTo) || s.copyTo} failed: ${copy.error}`, link: '#/settings/backups' });
      else add({ id: 'backup-copy', level: 'ok', title: 'Backups are copied somewhere else', detail: labelFor(s.copyTo) || s.copyTo });
    }

    // --- Radarr / Sonarr: the last time Marquee talked to each, did it work?
    if (arr) {
      for (const [app, s] of Object.entries(arr.publicSettings())) {
        if (!s?.url) continue;
        if (s.lastError) add({ id: `arr-${app}`, level: 'warn', title: `${s.name} isn’t answering`, detail: s.lastError.message, link: '#/settings/arr' });
        else if (!s.ready) add({ id: `arr-${app}`, level: 'info', title: `${s.name} isn’t finished being set up`, detail: 'Pick a quality profile and a folder, or requests won’t be sent to it.', link: '#/settings/arr' });
        else add({ id: `arr-${app}`, level: 'ok', title: `${s.name} is connected` });
      }
    }

    // --- updates
    if (updater) {
      const h = updater.helper();
      const check = updater.lastCheck?.();
      if (h.configured && h.state === 'failed') add({ id: 'update', level: 'bad', title: 'The last update failed', detail: h.message || 'See Settings → Updates.', link: '#/settings/server' });
      else if (check?.status === 'error') add({ id: 'update', level: 'info', title: 'Couldn’t check for updates', detail: check.error || '', link: '#/settings/server' });
      else if (updater.updateAvailable()) add({ id: 'update', level: 'info', title: 'An update is available', detail: 'Settings → Updates', link: '#/settings/server' });
      else add({ id: 'update', level: 'ok', title: 'Marquee is up to date' });
      if (h.configured && !h.alive) add({ id: 'update-helper', level: 'info', title: 'The update helper isn’t running', detail: 'One-click updates need it (see Updating in the README); update-marquee.bat does the same by hand.' });
    }

    // --- the graphics card stopped working for conversions
    if (hwaccel) {
      const st = hwaccel.status();
      const broken = st.setting !== 'software' && st.results.find((r) => r.ok === false && /repeated errors/.test(r.error || ''));
      add(broken
        ? { id: 'gpu', level: 'warn', title: `Stopped using ${broken.name} for conversions`, detail: `${broken.error}. Videos are converted on the CPU instead (slower). A restart tries the graphics card again.`, link: '#/settings/playback' }
        : { id: 'gpu', level: 'ok', title: `Converting with ${st.activeName}` });
    }

    // --- lots of errors lately
    if (logs) {
      const day = Date.now() - 86400_000;
      const errors = logs.recent().filter((e) => e.level === 'error' && e.at > day);
      add(errors.length >= 10
        ? { id: 'errors', level: 'warn', title: `${errors.length} errors in the last day`, detail: `Latest: ${errors[0].message.slice(0, 160)}`, link: '#/settings/server' }
        : { id: 'errors', level: 'ok', title: errors.length ? `${errors.length} error${errors.length === 1 ? '' : 's'} in the last day` : 'No errors in the last day', link: errors.length ? '#/settings/server' : null });
    }

    // --- the database file itself
    if (dataDir) {
      let size = 0;
      try { size = fs.statSync(path.join(dataDir, 'db.json')).size; } catch { /* not saved yet */ }
      if (size > 200 * 1024 ** 2) add({ id: 'database', level: 'warn', title: 'The database is very large', detail: `${gb(size)}. Saving it takes longer; let us know how big your library is.` });
    }
    return out;
  }

  /** Runs the checks, tells admins about anything that got worse, and remembers the results. */
  run() {
    const { store } = this.d;
    const checks = this.checks();
    const before = (store.data.healthState ||= {});
    const now = {};
    for (const c of checks) {
      now[c.id] = c.level;
      if (RANK[c.level] >= RANK.warn && RANK[c.level] > RANK[before[c.id] || 'ok']) {
        for (const admin of (store.data.users || []).filter((u) => u.role === 'admin')) {
          notifications.add(store, admin.id, { kind: 'health', title: c.title, body: c.detail, link: c.link || '#/settings', key: `health-${c.id}` });
        }
      }
    }
    store.data.healthState = now;
    store.save({ personal: true });
    const worst = checks.reduce((w, c) => (RANK[c.level] > RANK[w] ? c.level : w), 'ok');
    this.last = { at: Date.now(), level: worst, checks: checks.sort((a, b) => RANK[b.level] - RANK[a.level]) };
    return this.last;
  }

  status() { return this.last || this.run(); }

  start() {
    setTimeout(() => this.safeRun(), 2 * 60_000).unref(); // once things have settled after start-up
    setInterval(() => this.safeRun(), CHECK_EVERY_MS).unref();
  }

  safeRun() { try { this.run(); } catch (err) { console.warn(`[health] ${err.message}`); } }
}

module.exports = { Health, RANK };
