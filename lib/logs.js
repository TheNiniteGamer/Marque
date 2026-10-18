'use strict';
// Keeps the server's recent messages in memory (Settings → Logs), with a plain-language hint for
// common problems, so nobody has to open Docker to see what went wrong.

const util = require('node:util');

const MAX = 500;
const entries = [];

const HINTS = [
  [/ffprobe failed/i, "This file couldn't be read. It may be damaged, or still being copied."],
  [/(folder|path) not found/i, "A library folder can't be reached. Is the drive plugged in, or the folder moved?"],
  [/EACCES|EPERM|permission denied/i, "Marquee isn't allowed to read or write this folder. Check the folder's permissions."],
  [/ENOSPC|no space left/i, 'The disk is full. Free up some space.'],
  [/\[meta\].*(fetch failed|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|returned HTTP 5)/i, "Couldn't reach the internet to look up details. Marquee will try again on the next scan."],
  [/\[hwaccel\].*failed/i, "The graphics card couldn't convert a video, so the CPU was used instead."],
  [/\[(transcode|hls)\]/i, "A video couldn't be converted. The file may be damaged or in an unusual format."],
  [/opensubtitles/i, 'OpenSubtitles had a problem. Check the API key in Settings → Metadata.'],
  [/\[store\]/i, 'There was a problem with the database file (see the message). Backups are in Settings → Backups.'],
  [/yt-dlp/i, 'The video downloader had a problem. Try “Update yt-dlp” on the Downloads page.'],
  [/\[intro\]/i, "Intro or credits detection couldn't read this episode's audio. Skip Intro just won't appear for it."],
];
const hintFor = (msg) => HINTS.find(([re]) => re.test(msg))?.[1] || null;

// Mirror console.log / warn / error into the in-memory list.
function install() {
  for (const [method, level] of [['log', 'info'], ['warn', 'warning'], ['error', 'error']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      const message = util.format(...args);
      entries.push({ at: Date.now(), level, message, hint: level === 'info' ? null : hintFor(message) });
      if (entries.length > MAX) entries.splice(0, entries.length - MAX);
    };
  }
}

// Newest first; problems only unless `all`.
function recent({ all = false } = {}) {
  return entries.filter((e) => all || e.level !== 'info').slice().reverse();
}

module.exports = { install, recent, hintFor };
