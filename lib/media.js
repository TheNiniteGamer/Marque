'use strict';
// ffprobe / ffmpeg helpers: probing, thumbnails, browser compatibility and live transcoding.

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const { videoArgs } = require('./hwaccel');
const { withToneMap } = require('./hdr');
const { interlaced, deinterlace, scaleWidth, chain } = require('./picture');
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
// Background jobs (scanning, thumbnails, intro detection, seek previews) run at low priority so
// they never slow down a video someone is watching.
function lowPriority(child) {
  try { os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW); } catch { /* not allowed or already finished */ }
  return child;
}

const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
// Picture-based subtitles (Blu-ray, DVD, DVB): shown by drawing them into the converted video.
const IMAGE_SUB_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);

function probe(file) {
  return new Promise((resolve, reject) => {
    lowPriority(execFile(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }, (err, stdout) => {
        if (err) return reject(new Error(`ffprobe failed: ${err.message.split('\n')[0]}`));
        let info;
        try { info = JSON.parse(stdout); } catch (e) { return reject(e); }
        const streams = info.streams || [];
        const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
        const audio = streams.filter((s) => s.codec_type === 'audio');
        const subs = streams.filter((s) => s.codec_type === 'subtitle');
        resolve({
          duration: Number(info.format?.duration) || Number(v?.duration) || 0,
          bitrate: Number(info.format?.bit_rate) || null,
          container: info.format?.format_name || null,
          video: v ? {
            codec: v.codec_name, profile: v.profile || null, pixFmt: v.pix_fmt || null,
            width: v.width, height: v.height,
            // (HDR: smpte2084 = HDR10, arib-std-b67 = HLG; see hdr.js)
            colorTransfer: v.color_transfer || null, colorPrimaries: v.color_primaries || null,
            // (Interlaced: tt / bb / tb / bt; DVD pixels: a sample aspect ratio like 32:27. See picture.js.)
            fieldOrder: v.field_order || null, sar: v.sample_aspect_ratio || null,
          } : null,
          audio: audio.map((a) => ({
            codec: a.codec_name, channels: a.channels, lang: a.tags?.language || null, title: a.tags?.title || null,
          })),
          subtitles: subs.map((s, i) => ({
            index: i, codec: s.codec_name, lang: s.tags?.language || null, title: s.tags?.title || null,
            text: TEXT_SUB_CODECS.has(s.codec_name), forced: !!s.disposition?.forced,
          })),
        });
      }));
  });
}

// Can a typical modern browser play this file as-is?
function canDirectPlay(item) {
  const ext = path.extname(item.file).toLowerCase();
  if (interlaced(item.media?.video)) return false; // (browsers don't deinterlace: converted instead)
  if (!['.mp4', '.m4v', '.mov', '.webm'].includes(ext)) return false;
  const v = item.media?.video;
  if (v) {
    if (!['h264', 'vp8', 'vp9', 'av1'].includes(v.codec)) return false;
    if (v.codec === 'h264' && (/10/.test(v.profile || '') || (v.pixFmt && v.pixFmt !== 'yuv420p' && v.pixFmt !== 'yuvj420p'))) return false;
  }
  const a = item.media?.audio?.[0];
  if (a && !['aac', 'mp3', 'opus', 'vorbis', 'flac'].includes(a.codec)) return false;
  return true;
}

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.webm' ? 'video/webm' : ext === '.mkv' ? 'video/x-matroska' : 'video/mp4';
}

// Streamed without converting the picture (adaptive streaming's "source" quality): H.264 that
// browsers decode, in a file they can't open as it is (an MKV, say) or with more than one sound
// track (a browser can't switch between them itself).
const canRemux = (item) => canCopyVideo(item.media?.video) && (!canDirectPlay(item) || (item.media?.audio || []).length > 1);

// The picture is sent as it is: H.264 any browser decodes, or HEVC when the player says it can.
const copiesVideo = (v, hevc = false) => canCopyVideo(v) || (hevc && v?.codec === 'hevc');

// (Not interlaced H.264, e.g. a TV recording: it's converted so it can be deinterlaced, which
// browsers don't do.)
const canCopyVideo = (v) => v && v.codec === 'h264' && !/10/.test(v.profile || '') &&
  (!v.pixFmt || v.pixFmt === 'yuv420p' || v.pixFmt === 'yuvj420p') && !interlaced(v);

// When the video stream is copied, ffmpeg can only start on a keyframe, and which one it lands on
// depends on the container's index. Run the same seek for a single copied frame and read its real
// timestamp, so the client knows where the stream truly starts (keeps the clock and subtitles in sync).
function seekPoint(item, t, { hevc = false } = {}) {
  if (t <= 0 || !copiesVideo(item.media?.video, hevc)) return Promise.resolve(Math.max(0, t));
  return new Promise((resolve) => {
    execFile(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', item.file, '-map', '0:v:0',
      '-c', 'copy', '-copyts', '-frames:v', '1', '-f', 'framecrc', '-'],
    { timeout: 15_000 }, (err, stdout) => {
      if (err) return resolve(t);
      const tb = /#tb 0: (\d+)\/(\d+)/.exec(stdout);
      const pkt = stdout.split('\n').find((l) => /^0,/.test(l));
      if (!tb || !pkt) return resolve(t);
      const pts = Number(pkt.split(',')[2]);
      const start = (pts * Number(tb[1])) / Number(tb[2]);
      resolve(Number.isFinite(start) && start <= t + 0.01 ? Math.max(0, start) : t);
    });
  });
}

// Night mode / clearer dialogue: rumble cut, speech frequencies lifted, loud and quiet evened out.
const NIGHT_FILTER = 'highpass=f=90,equalizer=f=2200:t=q:w=1.2:g=4,acompressor=threshold=0.04:ratio=5:attack=8:release=220:makeup=2.2,alimiter=limit=0.9';

// Spawn a live transcode to fragmented MP4 starting at `start` seconds.
// The video stream is copied when the browser can already decode it, which is nearly free.
// `hevc`: the player decodes HEVC (x265) itself, so that's copied too.
function transcode(item, { start = 0, audioIndex = 0, encoder = 'software', burn = null, night = false, hevc = false } = {}) {
  const v = item.media?.video;
  const a = item.media?.audio?.[audioIndex];
  const copyVideo = copiesVideo(v, hevc) && burn == null;
  // (When drawing subtitles in, ffmpeg only clears them on time if the audio is converted too.)
  const copyAudio = a && a.codec === 'aac' && (a.channels || 2) <= 2 && burn == null && !night;

  const enc = copyVideo ? null : videoArgs(encoder, { maxHeight: 1080, burn, video: v });
  const args = ['-hide_banner', '-loglevel', 'error', '-fflags', '+genpts', ...(enc ? enc.input : [])];
  if (start > 0) args.push('-ss', start.toFixed(3));
  args.push('-i', item.file, ...(enc ? enc.map : ['-map', '0:v:0?']), '-map', `0:a:${audioIndex}?`, '-sn', '-dn');
  if (copyVideo) args.push('-c:v', 'copy', ...(v.codec === 'hevc' ? ['-tag:v', 'hvc1'] : [])); // (hvc1: what browsers expect)
  else args.push(...enc.output);
  if (copyAudio) args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k', ...(night ? ['-af', NIGHT_FILTER] : []));
  args.push('-avoid_negative_ts', 'make_zero', '-max_muxing_queue_size', '1024',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.encoder = enc ? enc.kind : null; // (null: the picture is copied)
  return proc;
}

const thumbJobs = new Map();
function thumbnail(file, out, atSeconds, { video = null } = {}) {
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (thumbJobs.has(out)) return thumbJobs.get(out);
  const job = new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const tmp = `${out}.tmp.jpg`;
    lowPriority(execFile(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.max(0, atSeconds)),
      '-i', file, '-frames:v', '1', '-vf', withToneMap(chain(deinterlace(video), scaleWidth(640), 'setsar=1'), video), '-q:v', '4', tmp], { timeout: 60_000 }, (err) => {
      if (err || !fs.existsSync(tmp)) { fs.rmSync(tmp, { force: true }); return reject(err || new Error('no frame')); }
      fs.renameSync(tmp, out);
      resolve(out);
    }));
  }).finally(() => thumbJobs.delete(out));
  thumbJobs.set(out, job);
  return job;
}

// Extract an embedded text subtitle track as WebVTT.
function extractSubtitle(file, streamIndex) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', `0:s:${streamIndex}`, '-f', 'webvtt', 'pipe:1'],
      { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

function checkFfmpeg() {
  return new Promise((resolve) => execFile(FFPROBE, ['-version'], (err) => resolve(!err)));
}

module.exports = { NIGHT_FILTER, IMAGE_SUB_CODECS, lowPriority, probe, canDirectPlay, canCopyVideo, copiesVideo, canRemux, mimeFor, seekPoint, transcode, thumbnail, extractSubtitle, checkFfmpeg };
