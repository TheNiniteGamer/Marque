'use strict';
// Video encoders for converting on the fly: software (x264 on the CPU) or a graphics card
// (NVIDIA NVENC, Intel/AMD VAAPI, Intel Quick Sync). "auto" tests each one with a real encode
// and uses the first that works; if a hardware encoder fails during playback, Marquee falls
// back to the CPU for that stream.

const { execFile } = require('node:child_process');
const fs = require('node:fs');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const VAAPI_DEVICE = process.env.VAAPI_DEVICE || '/dev/dri/renderD128';
const PRESET = process.env.TRANSCODE_PRESET || 'veryfast';

const KINDS = {
  software: 'CPU (software)',
  nvenc: 'NVIDIA graphics card (NVENC)',
  qsv: 'Intel Quick Sync',
  vaapi: 'Intel/AMD graphics (VAAPI)',
};
const AUTO_ORDER = ['nvenc', 'qsv', 'vaapi'];

/**
 * ffmpeg arguments for encoding video with `kind`.
 *   maxHeight: scale down to at most this height (keeps aspect ratio)
 *   bitrate:   target bits/s (HLS renditions), or null for constant quality
 *   keyframeEvery: seconds between forced keyframes (HLS segment boundaries)
 * Returns { input: [...before -i], output: [...after -i] }.
 */
function videoArgs(kind, { maxHeight = 1080, bitrate = null, keyframeEvery = null } = {}) {
  // Scaling happens on the CPU for every kind: simple and reliable; the encode is what's expensive.
  const scale = `scale=-2:'min(${maxHeight},ih)'`;
  const rate = bitrate
    ? ['-b:v', String(Math.round(bitrate)), '-maxrate', String(Math.round(bitrate * 1.25)), '-bufsize', String(Math.round(bitrate * 2))]
    : null;
  const keys = keyframeEvery ? ['-force_key_frames', `expr:gte(t,n_forced*${keyframeEvery})`] : ['-g', '96'];
  switch (kind) {
    case 'nvenc':
      return {
        input: [],
        output: ['-vf', `${scale},format=yuv420p`, '-c:v', 'h264_nvenc', '-preset', 'p4', '-profile:v', 'high',
          ...(rate ? ['-rc', 'vbr', ...rate] : ['-rc', 'vbr', '-cq', '23', '-b:v', '0']), ...keys, '-forced-idr', '1'],
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

// Encode one second of a test pattern; resolves { ok, error }.
function test(kind) {
  if (kind === 'vaapi' && !fs.existsSync(VAAPI_DEVICE)) return Promise.resolve({ ok: false, error: `${VAAPI_DEVICE} not found (no graphics device passed to Marquee)` });
  const { input, output } = videoArgs(kind, { maxHeight: 720, bitrate: 2e6 });
  const args = ['-hide_banner', '-loglevel', 'error', ...input, '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '1',
    ...output, '-f', 'null', '-'];
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
    this.failures = 0;
  }

  setting() { return this.store.data.settings?.hwaccel || process.env.HWACCEL || 'auto'; }

  // (Re)detect which encoder to use. Called at startup and when the setting changes.
  detect() {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const wanted = this.setting();
      const candidates = wanted === 'auto' ? AUTO_ORDER : wanted === 'software' ? [] : [wanted];
      this.results = {};
      let chosen = 'software';
      for (const kind of candidates) {
        this.results[kind] = await test(kind);
        if (this.results[kind].ok) { chosen = kind; break; }
      }
      this.active = chosen;
      this.failures = 0;
      this.checkedAt = Date.now();
      console.log(`[hwaccel] converting video with: ${KINDS[chosen]}`);
      return this.status();
    })().finally(() => { this.checking = null; });
    return this.checking;
  }

  // A hardware encode failed mid-playback: after two failures, stop using it until re-checked.
  reportFailure(kind, error) {
    if (kind === 'software') return;
    this.failures++;
    console.warn(`[hwaccel] ${KINDS[kind]} failed: ${error}`);
    if (this.failures >= 2 && this.active === kind) {
      this.results[kind] = { ok: false, error: `Stopped using it after repeated errors: ${error}` };
      this.active = 'software';
    }
  }

  status() {
    return {
      setting: this.setting(), active: this.active, activeName: KINDS[this.active], checkedAt: this.checkedAt,
      results: Object.entries(this.results).map(([kind, r]) => ({ kind, name: KINDS[kind], ...r })),
      options: Object.entries({ auto: 'Automatic (use a graphics card if one works)', ...KINDS }).map(([id, name]) => ({ id, name })),
    };
  }
}

module.exports = { HwAccel, videoArgs, test, KINDS };
