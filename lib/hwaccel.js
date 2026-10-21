'use strict';
// Video encoders for converting on the fly: software (x264 on the CPU) or a graphics card
// (NVIDIA NVENC, Intel/AMD VAAPI, Intel Quick Sync). "auto" tests each one with a real encode
// and uses the first that works; if a hardware encoder fails during playback, Marquee falls
// back to the next one for that stream (NVIDIA decoding → NVIDIA encoding only → the CPU).
//
// "nvdec": an NVIDIA card also decodes the video and shrinks it (the heaviest part with 4K HEVC),
// so the CPU barely works. HDR pictures are brought back to the CPU after shrinking for tone
// mapping (ffmpeg has no tone mapping on CUDA), which is cheap at 1080p. Videos the card can't
// decode, and Blu-ray subtitles drawn in, use the CPU for decoding as "nvenc" does.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { toneMap, toneMapping } = require('./hdr');
const { deinterlace, scaleTo, chain } = require('./picture');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const VAAPI_DEVICE = process.env.VAAPI_DEVICE || '/dev/dri/renderD128';
const PRESET = process.env.TRANSCODE_PRESET || 'veryfast';

const KINDS = {
  software: 'CPU (software)',
  nvdec: 'NVIDIA graphics card, decoding too (NVDEC + NVENC)',
  nvenc: 'NVIDIA graphics card (NVENC)',
  qsv: 'Intel Quick Sync',
  vaapi: 'Intel/AMD graphics (VAAPI)',
};
const AUTO_ORDER = ['nvdec', 'nvenc', 'qsv', 'vaapi'];
// When a stream fails to start with one, it's tried with the next.
const FALLBACK = { nvdec: 'nvenc' };
const fallback = (kind) => FALLBACK[kind] || 'software';
// After falling back from an encoder that worked, how often to try it again.
const RETRY_MS = 10 * 60_000;

// Formats the NVIDIA decoder takes (8-bit 4:2:0 H.264; 8- or 10-bit 4:2:0 HEVC, VP9, AV1, MPEG-2,
// VC-1), narrowed at startup to the codecs this card was seen decoding (AV1 needs an RTX 30 or later).
let gpuCodecs = new Set(['h264']);
function gpuDecodes(v) {
  if (!v || !gpuCodecs.has(v.codec)) return false;
  const px = v.pixFmt || 'yuv420p';
  if (!['yuv420p', 'yuvj420p', 'yuv420p10le'].includes(px)) return false;
  if (v.codec === 'h264') return px !== 'yuv420p10le' && !/10/.test(v.profile || '');
  return true;
}

/**
 * ffmpeg arguments for encoding video with `kind`.
 *   maxHeight: scale down to at most this height (keeps aspect ratio)
 *   bitrate:   target bits/s (HLS renditions), or null for constant quality
 *   keyframeEvery: seconds between forced keyframes (HLS segment boundaries)
 *   burn: index of an image subtitle stream (Blu-ray / DVD) to draw into the picture
 *   video: the source's probed video stream (an HDR one is tone-mapped to ordinary colours, an
 *          interlaced one deinterlaced, and DVD-shaped pixels made square: see picture.js)
 * Returns { input: [...before -i], map: [...video -map], output: [...after -i], kind: what's really used }.
 */
function videoArgs(kind, { burn = null, ...opts } = {}) {
  if (kind === 'nvdec' && (burn != null || !gpuDecodes(opts.video))) kind = 'nvenc';
  if (burn == null) return { ...encoderArgs(kind, opts), kind, map: ['-map', '0:v:0'] };
  // The subtitle pictures are laid over the (deinterlaced) video before scaling and encoding.
  const enc = encoderArgs(kind, { ...opts, deint: false });
  const output = [...enc.output];
  const i = output.indexOf('-vf');
  const first = deinterlace(opts.video);
  output.splice(i, 2, '-filter_complex', `[0:v:0]${first ? `${first}[dv];[dv]` : ''}[0:s:${burn}]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=pass,${output[i + 1]}[v]`);
  return { input: enc.input, map: ['-map', '[v]'], output, kind };
}

function encoderArgs(kind, { maxHeight = 1080, bitrate = null, keyframeEvery = null, video = null, deint = true } = {}) {
  // Deinterlacing, scaling (and HDR tone mapping) happen on the CPU for every kind but "nvdec":
  // simple and reliable; the encode is what's expensive.
  const scale = chain(deint && deinterlace(video), scaleTo(maxHeight), 'setsar=1', toneMap(video));
  const rate = bitrate
    ? ['-b:v', String(Math.round(bitrate)), '-maxrate', String(Math.round(bitrate * 1.25)), '-bufsize', String(Math.round(bitrate * 2))]
    : null;
  const keys = keyframeEvery ? ['-force_key_frames', `expr:gte(t,n_forced*${keyframeEvery})`] : ['-g', '96'];
  const nvenc = ['-c:v', 'h264_nvenc', '-preset', 'p4', '-profile:v', 'high',
    ...(rate ? ['-rc', 'vbr', ...rate] : ['-rc', 'vbr', '-cq', '23', '-b:v', '0']), ...keys, '-forced-idr', '1'];
  switch (kind) {
    case 'nvdec': {
      // Decoded and shrunk on the card; an HDR picture comes back (still 10-bit) for tone mapping.
      const size = chain(deint && deinterlace(video, { cuda: true }), scaleTo(maxHeight, { cuda: true }));
      const tm = toneMap(video);
      return {
        input: ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'],
        output: ['-vf', tm ? `${size}:format=p010le,setsar=1,hwdownload,format=p010le,${tm}` : `${size}:format=nv12,setsar=1`, ...nvenc],
      };
    }
    case 'nvenc':
      return {
        input: [],
        output: ['-vf', `${scale},format=yuv420p`, ...nvenc],
      };
    case 'qsv':
      return {
        input: ['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw'],
        output: ['-vf', `${scale},format=nv12,hwupload=extra_hw_frames=64`, '-c:v', 'h264_qsv', '-preset', 'faster', '-profile:v', 'high',
          ...(rate || ['-global_quality', '23']), ...keys],
      };
    case 'vaapi':
      return {
        input: ['-vaapi_device', VAAPI_DEVICE],
        output: ['-vf', `${scale},format=nv12,hwupload`, '-c:v', 'h264_vaapi', '-profile:v', 'high',
          ...(rate || ['-qp', '23']), ...keys],
      };
    default:
      return {
        input: [],
        output: ['-vf', `${scale},format=yuv420p`, '-c:v', 'libx264', '-preset', PRESET, '-profile:v', 'high',
          ...(rate || ['-crf', '22']), ...keys, ...(keyframeEvery ? ['-sc_threshold', '0'] : [])],
      };
  }
}

// Encode one second of a test pattern (decoding a sample of `codec` for "nvdec"); resolves { ok, error }.
function test(kind, { codec = 'h264' } = {}) {
  if (kind === 'vaapi' && !fs.existsSync(VAAPI_DEVICE)) return Promise.resolve({ ok: false, error: `${VAAPI_DEVICE} not found (no graphics device passed to Marquee)` });
  if (kind === 'nvdec') return testDecode(codec);
  const { input, output } = videoArgs(kind, { maxHeight: 720, bitrate: 2e6 });
  return run(['-hide_banner', '-loglevel', 'error', ...input, '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '1', ...output, '-f', 'null', '-']);
}

// Samples to decode, made on the CPU (once): the decoder has to be tried on a real file.
const SAMPLES = {
  h264: ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
  hevc: ['-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-x265-params', 'log-level=error'],
  vp9: ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt', 'yuv420p'],
  av1: ['-c:v', 'libsvtav1', '-preset', '12', '-pix_fmt', 'yuv420p'],
};
async function testDecode(codec) {
  const file = path.join(os.tmpdir(), `marquee-nvdec-${codec}.mkv`);
  if (!fs.existsSync(file)) {
    const made = await run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24', '-t', '1', ...SAMPLES[codec], file]);
    if (!made.ok) return { ok: false, error: `couldn't make a ${codec} sample: ${made.error}` };
  }
  const v = { codec, pixFmt: codec === 'hevc' ? 'yuv420p10le' : 'yuv420p' };
  const was = gpuCodecs;
  gpuCodecs = new Set([codec]);
  const { input, output } = videoArgs('nvdec', { maxHeight: 360, bitrate: 1e6, video: v });
  gpuCodecs = was;
  return run(['-hide_banner', '-loglevel', 'error', ...input, '-i', file, ...output, '-f', 'null', '-']);
}

function run(args) {
  return new Promise((resolve) => {
    execFile(FFMPEG, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true });
      // The first line usually says why (e.g. "Cannot load libcuda.so.1" = no NVIDIA driver in the container).
      const lines = String(stderr || err.message).trim().split('\n').map((l) => l.replace(/^\[[^\]]*\]\s*/, '').trim()).filter(Boolean);
      const msg = lines.find((l) => /cannot|failed|no |not |error/i.test(l)) || lines[0] || 'failed';
      resolve({ ok: false, error: msg.slice(0, 200) });
    });
  });
}

class HwAccel {
  constructor(store) {
    this.store = store;
    this.active = 'software';
    this.results = {};
    this.checkedAt = null;
    this.checking = null;
    this.failures = {};
    // The best encoder seen working under the current setting, so a fall-back can be undone.
    this.best = null;
    this.bestFor = null;
    this.retry = null;
    this.retryMs = RETRY_MS;
  }

  /** What to try when a stream fails to start with `kind`. */
  fallback(kind) { return fallback(kind); }

  setting() { return this.store.data.settings?.hwaccel || process.env.HWACCEL || 'auto'; }

  // (Re)detect which encoder to use. Called at startup and when the setting changes.
  detect() {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const wanted = this.setting();
      const candidates = wanted === 'auto' ? AUTO_ORDER : wanted === 'software' ? [] : wanted === 'nvdec' ? ['nvdec', 'nvenc'] : [wanted];
      this.results = {};
      let chosen = 'software';
      for (const kind of candidates) {
        this.results[kind] = await test(kind);
        if (this.results[kind].ok) { chosen = kind; break; }
      }
      if (chosen === 'nvdec') {
        // Which other codecs this card decodes (MPEG-2 and VC-1: every NVIDIA card that has NVDEC).
        const codecs = new Set(['h264', 'mpeg2video', 'vc1']);
        for (const c of ['hevc', 'vp9', 'av1']) if ((await test('nvdec', { codec: c })).ok) codecs.add(c);
        gpuCodecs = codecs;
        this.results.nvdec.codecs = [...codecs];
      }
      this.settle(wanted, chosen);
      this.failures = {};
      this.checkedAt = Date.now();
      console.log(`[hwaccel] converting video with: ${KINDS[chosen]}`);
      return this.status();
    })().finally(() => { this.checking = null; });
    return this.checking;
  }

  // Use `chosen`, remembering the best encoder that has worked under this setting.
  settle(wanted, chosen) {
    if (this.bestFor !== wanted) { this.best = null; this.bestFor = wanted; }
    const rank = (k) => AUTO_ORDER.indexOf(k);
    if (chosen !== 'software' && (!this.best || rank(chosen) < rank(this.best))) this.best = chosen;
    this.active = chosen;
    this.scheduleRetry();
  }

  // Running below the best encoder seen working (it failed mid-playback, or the card was briefly
  // out of memory, e.g. shared with another program): test again every so often and go back to it
  // once it works, rather than staying on the slower one until Marquee restarts.
  scheduleRetry() {
    clearTimeout(this.retry);
    this.retry = null;
    if (!this.best || this.active === this.best) return;
    console.warn(`[hwaccel] trying ${KINDS[this.best]} again in ${Math.round(this.retryMs / 60_000)} minutes`);
    this.retry = setTimeout(() => { this.retry = null; this.detect(); }, this.retryMs);
    this.retry.unref?.();
  }

  // A hardware encode failed mid-playback: after two failures, stop using it until re-checked
  // (and use the next one: NVIDIA decoding → NVIDIA encoding only → the CPU).
  reportFailure(kind, error) {
    if (kind === 'software') return;
    this.failures[kind] = (this.failures[kind] || 0) + 1;
    console.warn(`[hwaccel] ${KINDS[kind]} failed: ${error}`);
    if (this.failures[kind] >= 2 && this.active === kind) {
      this.results[kind] = { ok: false, error: `Stopped using it after repeated errors: ${error}` };
      this.active = fallback(kind);
      this.scheduleRetry();
    }
  }

  status() {
    return {
      setting: this.setting(), active: this.active, activeName: KINDS[this.active], checkedAt: this.checkedAt, toneMapping: toneMapping(),
      results: Object.entries(this.results).map(([kind, r]) => ({ kind, name: KINDS[kind], ...r })),
      options: Object.entries({ auto: 'Automatic (use a graphics card if one works)', ...KINDS }).map(([id, name]) => ({ id, name })),
    };
  }
}

// (Detection sets it; tests too.)
const useGpuCodecs = (list) => { gpuCodecs = new Set(list); };

module.exports = { HwAccel, videoArgs, test, gpuDecodes, useGpuCodecs, KINDS };
