'use strict';
// Update checks against the GitHub repository, and one-click updates through the host helper.
//
// The app runs inside Docker and cannot rebuild its own container. Instead, a small helper on the
// host (marquee.ps1 Watch, installed as a logon task on Windows) shares a folder with the container
// (CONTROL_DIR). The helper writes a heartbeat + progress to status.json; the app asks for an update
// by writing update-request.json, and the helper pulls the new code, rebuilds and restarts.

const fs = require('node:fs');
const path = require('node:path');

const REPO = process.env.MARQUEE_REPO || 'TheNiniteGamer/Marque';
const BRANCH = process.env.MARQUEE_BRANCH || 'main';
const API = process.env.UPDATE_API_BASE || 'https://api.github.com';
const CONTROL_DIR = process.env.CONTROL_DIR ? path.resolve(process.env.CONTROL_DIR) : null;
const QUIET_MS = 60_000; // nobody watching for this long before restarting into a new version

function writeControl(name, data) {
  const file = path.join(CONTROL_DIR, name);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
  fs.renameSync(`${file}.tmp`, file);
}
const CHECK_EVERY = 12 * 3600 * 1000;
const HELPER_STALE = 2 * 60 * 1000; // helper writes a heartbeat every ~15 s

const httpError = (status, msg) => Object.assign(new Error(msg), { status });

// Commit of a plain git checkout, read straight from .git (no git binary needed).
function gitHead(dir) {
  try {
    const gitDir = path.join(dir, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = head.replace(/^ref:\s*/, '');
    const loose = path.join(gitDir, ref);
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim();
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    return packed.split('\n').find((l) => l.endsWith(` ${ref}`))?.split(' ')[0] || null;
  } catch { return null; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

const isSignificant = (message) => /^\s*\[significant\]/i.test(message || '') || /^update-type:\s*(significant|major)\s*$/im.test(message || '');

class Updater {
  constructor(store, appDir) {
    this.store = store;
    this.appDir = appDir;
    const commit = (process.env.MARQUEE_COMMIT || '').trim() || gitHead(appDir) || null;
    this.build = {
      version: require(path.join(appDir, 'package.json')).version,
      commit: /^[0-9a-f]{7,40}$/i.test(commit || '') ? commit.toLowerCase() : null,
      builtAt: process.env.MARQUEE_BUILT_AT || null,
      install: CONTROL_DIR ? 'docker' : fs.existsSync(path.join(appDir, '.git')) ? 'git' : 'manual',
      repo: REPO, branch: BRANCH,
    };
    this.checking = null;
  }

  autoCheckEnabled() { return this.store.data.settings?.updateCheck !== false; }

  // A saved result only applies to the build it was made for (after an update it is stale).
  lastCheck() {
    const c = this.store.data.updateCheck;
    return c && c.forCommit === this.build.commit ? c : null;
  }

  startSchedule() {
    const tick = () => {
      const last = this.lastCheck()?.checkedAt || 0;
      if (this.autoCheckEnabled() && Date.now() - last > CHECK_EVERY) this.check().catch(() => {});
    };
    // Re-check soon after starting a new version, so "update available" clears right after updating.
    setTimeout(tick, this.store.data.updateCheck && !this.lastCheck() ? 3_000 : 30_000).unref();
    setInterval(tick, 3600_000).unref();
  }

  async github(pathname) {
    const res = await fetch(`${API}/repos/${REPO}${pathname}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'marquee-update-check' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) throw httpError(404, `GitHub has no ${pathname.includes('compare') ? 'record of this version' : `repository ${REPO}`}`);
    if (res.status === 403 || res.status === 429) throw httpError(429, 'GitHub rate limit reached — try again in an hour');
    if (!res.ok) throw httpError(502, `GitHub returned HTTP ${res.status}`);
    return res.json();
  }

  // Compare the running build with the newest commit on the branch.
  // A commit marked as a significant update (an "Update-Type: significant" line in its message,
  // or a subject starting with "[Significant]") is highlighted in the web UI.
  check() {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const result = { checkedAt: Date.now(), forCommit: this.build.commit, status: 'unknown', behindBy: 0, changes: [], latest: null, error: null };
      try {
        const latest = await this.github(`/commits/${encodeURIComponent(BRANCH)}`);
        result.latest = { sha: latest.sha, date: latest.commit?.committer?.date || null, message: (latest.commit?.message || '').split('\n')[0] };
        const current = this.build.commit;
        if (!current) result.status = 'unknown';
        else if (latest.sha.startsWith(current)) result.status = 'current';
        else {
          let cmp = null;
          try { cmp = await this.github(`/compare/${current}...${encodeURIComponent(BRANCH)}`); } catch (err) { if (err.status !== 404) throw err; }
          if (!cmp) result.status = 'unknown';
          else if (cmp.status === 'identical' || cmp.status === 'behind') result.status = 'current';
          else {
            result.status = 'available';
            result.behindBy = cmp.ahead_by || (cmp.commits || []).length;
            result.changes = (cmp.commits || []).slice(-30).reverse().map((c) => ({
              sha: c.sha.slice(0, 7), message: (c.commit?.message || '').split('\n')[0].replace(/^\[significant\]\s*/i, ''),
              date: c.commit?.committer?.date || null, url: c.html_url || null,
              significant: isSignificant(c.commit?.message),
            }));
            result.significant = result.changes.some((c) => c.significant);
          }
        }
      } catch (err) {
        result.error = err.message;
        result.status = 'error';
      }
      this.store.data.updateCheck = result;
      this.store.save();
      return result;
    })().finally(() => { this.checking = null; });
    return this.checking;
  }

  helper() {
    if (!CONTROL_DIR) return { configured: false, alive: false };
    const s = readJson(path.join(CONTROL_DIR, 'status.json')) || {};
    const beat = Date.parse(s.heartbeat || '') || 0;
    return {
      configured: true,
      alive: Date.now() - beat < HELPER_STALE,
      lastSeen: beat || null,
      state: s.state || 'idle',
      message: s.message || null,
      startedAt: Date.parse(s.startedAt || '') || null,
      finishedAt: Date.parse(s.finishedAt || '') || null,
      log: Array.isArray(s.log) ? s.log.slice(-15) : [],
      pending: fs.existsSync(path.join(CONTROL_DIR, 'update-request.json')),
      readyAt: Date.parse(s.readyAt || '') || null,
    };
  }

  // when: 'idle' — the helper downloads and rebuilds straight away (Marquee keeps running), then
  // waits for nobody to be watching before restarting into the new version; 'now' — restart as soon
  // as it's built. (Asking for 'now' while an update waits makes it go ahead.)
  requestUpdate(user, { when = 'idle' } = {}) {
    const h = this.helper();
    if (!h.configured) throw httpError(409, 'One-click updates need the Docker setup with the update helper');
    if (!h.alive) throw httpError(409, 'The update helper on the server PC is not running');
    if (h.state === 'updating') throw httpError(409, 'An update is already running');
    writeControl('update-request.json', { requestedAt: new Date().toISOString(), by: user.username, when: when === 'now' ? 'now' : 'idle' });
    return this.helper();
  }

  /** "Restart now": the waiting new version starts without waiting for a quiet moment. */
  restartNow(user) {
    if (this.helper().state !== 'ready') throw httpError(409, 'No update is waiting to restart');
    writeControl('restart-ok.json', { at: new Date().toISOString(), by: user.username });
    return this.helper();
  }

  /**
   * Called every few seconds with whether anyone is watching. While a new version waits ('ready'),
   * gives the helper the go-ahead once nobody has watched for a minute. With automatic updates on,
   * also starts one at night (2–5 am, server time) when there's one to install and nobody's watching.
   */
  tick(idle, now = new Date()) {
    if (!CONTROL_DIR) return;
    const h = this.helper();
    if (!idle) this.idleSince = null;
    else if (!this.idleSince) this.idleSince = now.getTime();
    const quietFor = this.idleSince ? now.getTime() - this.idleSince : 0;
    if (h.state === 'ready' && quietFor >= QUIET_MS && !fs.existsSync(path.join(CONTROL_DIR, 'restart-ok.json'))) {
      writeControl('restart-ok.json', { at: now.toISOString(), by: 'nobody watching' });
      console.log('[updates] nobody is watching: restarting into the new version');
    }
    const night = now.getHours() >= 2 && now.getHours() < 5;
    const today = now.toDateString();
    if (this.autoInstallEnabled() && night && quietFor >= QUIET_MS && this.updateAvailable() && h.alive && !h.pending
      && !['updating', 'ready'].includes(h.state) && this.store.data.autoInstallTried !== today) {
      this.store.data.autoInstallTried = today; // once a night, even if it fails
      this.store.save();
      try { this.requestUpdate({ username: 'automatic update' }, { when: 'idle' }); console.log('[updates] installing the update automatically (night, nobody watching)'); } catch (err) { console.warn(`[updates] automatic update: ${err.message}`); }
    }
  }

  autoInstallEnabled() { return this.store.data.settings?.updateAutoInstall === true; }

  status() {
    return { build: this.build, check: this.lastCheck(), autoCheck: this.autoCheckEnabled(), autoInstall: this.autoInstallEnabled(), helper: this.helper() };
  }

  updateAvailable() { return this.lastCheck()?.status === 'available'; }
  significantUpdate() { return this.updateAvailable() && !!this.lastCheck()?.significant; }
}

module.exports = { Updater, gitHead };
