'use strict';
// HDR films and shows (HDR10, HLG). Their colours are meant for HDR screens: a browser or TV
// that plays the file as it is shows them properly by itself, but whenever the server converts
// the picture (a lower quality, a TV that can't play the file, thumbnails, seek previews,
// preview clips) the colours must be mapped to ordinary (SDR) ones, or they come out grey and
// washed out. That's "tone mapping", done with ffmpeg's zscale (zimg) and tonemap filters.
//
// Dolby Vision files with an HDR10 base layer (profiles 7 and 8, most of them) are tone-mapped
// as HDR10; profile 5 (no base layer, from streaming-service rips) keeps odd colours when converted.

const { execFile } = require('node:child_process');
const os = require('node:os');

// (Not media.js's: that loads hwaccel.js, which loads this.)
const lowPriority = (child) => { try { os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW); } catch { /* fine */ } return child; };

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

/** 'hdr10', 'hlg' or null, from a probed video stream ({ colorTransfer }). */
function hdrKind(v) {
  if (v?.colorTransfer === 'smpte2084') return 'hdr10';
  if (v?.colorTransfer === 'arib-std-b67') return 'hlg';
  return null;
}

let available = null; // does this ffmpeg have the filters? (checked at startup)
function check() {
  return new Promise((resolve) => {
    execFile(FFMPEG, ['-hide_banner', '-filters'], { timeout: 20_000 }, (err, stdout) => {
      available = !err && /\szscale\s/.test(stdout) && /\stonemap\s/.test(stdout);
      if (!available) console.warn('[hdr] this ffmpeg has no zscale filter: HDR videos will look washed out when converted');
      resolve(available);
    });
  });
}
const toneMapping = () => available === true;

/**
 * Filters that turn an HDR picture into ordinary colours (yuv420p), to put after scaling it
 * down (cheaper on a smaller picture); '' when the video isn't HDR or it can't be done.
 * The input's colours are given explicitly, as files aren't always labelled.
 */
function toneMap(v) {
  const kind = hdrKind(v);
  if (!kind || !available) return '';
  const tin = kind === 'hlg' ? 'arib-std-b67' : 'smpte2084';
  return `zscale=tin=${tin}:pin=bt2020:min=bt2020nc:rin=tv:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,`
    + 'tonemap=tonemap=mobius:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';
}
/** `filter` followed by the tone mapping, if any. */
const withToneMap = (filter, v) => [filter, toneMap(v)].filter(Boolean).join(',');

function probeColour(file) {
  return new Promise((resolve, reject) => {
    lowPriority(execFile(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_transfer,color_primaries',
      '-of', 'json', file], { timeout: 30_000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const s = JSON.parse(stdout).streams?.[0] || {};
        resolve({ colorTransfer: s.color_transfer || null, colorPrimaries: s.color_primaries || null });
      } catch (e) { reject(e); }
    }));
  });
}

/** Titles scanned before Marquee noted colours get them read now (once, in the background);
 * `onHdr(item)` for each HDR one found (its pictures made before were washed out). */
async function backfill(store, onHdr = () => {}) {
  const todo = Object.values(store.data.items).filter((i) => i.media?.video && i.media.video.colorTransfer === undefined && i.file);
  let n = 0, found = 0;
  for (const it of todo) {
    let c;
    try { c = await probeColour(it.file); } catch { c = { colorTransfer: null, colorPrimaries: null }; }
    if (!it.media?.video) continue; // rescanned meanwhile
    Object.assign(it.media.video, c);
    if (hdrKind(it.media.video)) { found++; try { onHdr(it); } catch { /* fine */ } }
    if (++n % 200 === 0) store.save({ lazy: true });
  }
  if (n) {
    store.save();
    console.log(`[hdr] checked the colours of ${n} video(s): ${found} HDR`);
  }
  return { checked: n, hdr: found };
}

module.exports = { hdrKind, check, toneMapping, toneMap, withToneMap, backfill, probeColour };
