'use strict';
// HDR films and shows (HDR10, HLG). Their colours are meant for HDR screens: a browser or TV
// that plays the file as it is shows them properly by itself, but whenever the server converts
// the picture (a lower quality, a TV that can't play the file, thumbnails, seek previews,
// preview clips) the colours must be mapped to ordinary (SDR) ones, or they come out grey and
// washed out. That's "tone mapping". Jellyfin's ffmpeg (in the Docker image) does it on an NVIDIA
// card (tonemap_cuda) or quickly on the CPU (tonemapx, about a fifth of the work of zscale's);
// other builds of ffmpeg use zscale (zimg) and tonemap, which look the same but cost far more.
//
// Dolby Vision files with an HDR10 base layer (profiles 7 and 8, most of them) are tone-mapped
// as HDR10. Profile 5 (no base layer, from streaming-service rips) needs Jellyfin's filters, which
// read its colour instructions; other builds leave it with odd purple and green colours.

const { execFile } = require('node:child_process');
const os = require('node:os');

// (Not media.js's: that loads hwaccel.js, which loads this.)
const lowPriority = (child) => { try { os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW); } catch { /* fine */ } return child; };
const { interlaced, anamorphic } = require('./picture');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

/** 'hdr10', 'hlg', 'dovi' (Dolby Vision profile 5) or null, from a probed video stream. */
function hdrKind(v) {
  if (v?.dvProfile === 5) return 'dovi';
  if (v?.colorTransfer === 'smpte2084') return 'hdr10';
  if (v?.colorTransfer === 'arib-std-b67') return 'hlg';
  return null;
}

let available = null; // does this ffmpeg have the filters? (checked at startup)
const has = { tonemapx: false, tonemap_cuda: false };
function check() {
  return new Promise((resolve) => {
    execFile(FFMPEG, ['-hide_banner', '-filters'], { timeout: 20_000 }, (err, stdout) => {
      const filter = (name) => !err && new RegExp(`\\s${name}\\s`).test(stdout);
      has.tonemapx = filter('tonemapx');
      has.tonemap_cuda = filter('tonemap_cuda');
      available = has.tonemapx || (filter('zscale') && filter('tonemap'));
      if (!available) console.warn('[hdr] this ffmpeg has no zscale filter: HDR videos will look washed out when converted');
      resolve(available);
    });
  });
}
const toneMapping = () => available === true;
/** Can an NVIDIA card tone-map (so the picture needn't come back to the CPU)? */
const cudaToneMapping = () => available === true && has.tonemap_cuda;

/**
 * Filters that turn an HDR picture into ordinary colours (yuv420p), to put after scaling it
 * down (cheaper on a smaller picture); '' when the video isn't HDR or it can't be done.
 * The input's colours are given explicitly, as files aren't always labelled.
 */
function toneMap(v) {
  const kind = hdrKind(v);
  if (!kind || !available) return '';
  if (has.tonemapx) return `${labels(kind)}tonemapx=${TONEMAP}:format=yuv420p`;
  if (kind === 'dovi') return '';
  const tin = kind === 'hlg' ? 'arib-std-b67' : 'smpte2084';
  return `zscale=tin=${tin}:pin=bt2020:min=bt2020nc:rin=tv:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,`
    + 'tonemap=tonemap=mobius:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';
}
/** The same on an NVIDIA card, for CUDA frames (10-bit, p010); '' when it can't be done there. */
function toneMapCuda(v) {
  const kind = hdrKind(v);
  if (!kind || !cudaToneMapping()) return '';
  // ("itp" keeps colours closest to the zscale look; the CPU filter does this by itself.)
  return `${labels(kind)}tonemap_cuda=${TONEMAP}:tonemap_mode=itp:format=nv12`;
}
// Mobius keeps the brightest parts from blowing out while leaving the rest as it was. Picked by
// comparing frames: the filters' default (bt2390) looked grey and dull.
const TONEMAP = 'tonemap=mobius:desat=0:t=bt709:m=bt709:p=bt709';
// The input's colours are stated, as files aren't always labelled (Dolby Vision brings its own).
const labels = (kind) => (kind === 'dovi' ? ''
  : `setparams=color_primaries=bt2020:color_trc=${kind === 'hlg' ? 'arib-std-b67' : 'smpte2084'}:colorspace=bt2020nc,`);
/** `filter` followed by the tone mapping, if any. */
const withToneMap = (filter, v) => [filter, toneMap(v)].filter(Boolean).join(',');

function probeColour(file) {
  return new Promise((resolve, reject) => {
    lowPriority(execFile(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_transfer,color_primaries,field_order,sample_aspect_ratio',
      '-of', 'json', file], { timeout: 30_000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const s = JSON.parse(stdout).streams?.[0] || {};
        resolve({ colorTransfer: s.color_transfer || null, colorPrimaries: s.color_primaries || null, fieldOrder: s.field_order || null, sar: s.sample_aspect_ratio || null });
      } catch (e) { reject(e); }
    }));
  });
}

/** Titles scanned before Marquee noted colours, interlacing and pixel shape get them read now
 * (once, in the background); `onHdr(item)` for each HDR, interlaced or DVD-shaped one found (its
 * pictures made before were washed out, combed or squashed). */
async function backfill(store, onHdr = () => {}) {
  const todo = Object.values(store.data.items).filter((i) => i.media?.video && (i.media.video.colorTransfer === undefined || i.media.video.fieldOrder === undefined) && i.file);
  let n = 0, found = 0;
  for (const it of todo) {
    let c;
    try { c = await probeColour(it.file); } catch { c = { colorTransfer: null, colorPrimaries: null, fieldOrder: null, sar: null }; }
    if (!it.media?.video) continue; // rescanned meanwhile
    Object.assign(it.media.video, c);
    const v = it.media.video;
    if (hdrKind(v)) found++;
    if (hdrKind(v) || interlaced(v) || anamorphic(v)) { try { onHdr(it); } catch { /* fine */ } }
    if (++n % 200 === 0) store.save({ lazy: true });
  }
  if (n) {
    store.save();
    console.log(`[picture] checked the colours and shape of ${n} video(s): ${found} HDR`);
  }
  return { checked: n, hdr: found };
}

module.exports = { hdrKind, check, toneMapping, cudaToneMapping, toneMap, toneMapCuda, withToneMap, backfill, probeColour };
