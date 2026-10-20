'use strict';
// DVD-style video (MPEG-2, interlaced, non-square pixels): deinterlaced and made the right shape
// whenever the server converts it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const media = require('../lib/media');
const picture = require('../lib/picture');
const { videoArgs, useGpuCodecs } = require('../lib/hwaccel');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-picture-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const DVD = path.join(ROOT, 'dvd.mkv');
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);

test.before(() => {
  // Like a DVD: 720×480 NTSC, interlaced (top field first), 16:9 with non-square pixels, MPEG-2 and Dolby Digital.
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=720x480:rate=30000/1001:duration=4', '-f', 'lavfi', '-i', 'sine=d=4',
    '-vf', 'tinterlace=interleave_top,fieldorder=tff', '-pix_fmt', 'yuv420p', '-c:v', 'mpeg2video', '-b:v', '6M', '-flags', '+ilme+ildct', '-top', '1',
    '-aspect', '16:9', '-c:a', 'ac3', DVD]);
});

// How many frames ffmpeg's interlace detector calls interlaced vs progressive.
function idet(file) {
  const log = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-vf', 'idet', '-f', 'null', '-']).stderr.toString();
  const m = [...log.matchAll(/Multi frame detection: TFF:\s*(\d+) BFF:\s*(\d+) Progressive:\s*(\d+)/g)].pop(); // (the last report)
  return { interlaced: Number(m[1]) + Number(m[2]), progressive: Number(m[3]) };
}
function convert(video, out) {
  const e = videoArgs('software', { maxHeight: 480, video });
  ff(['-i', DVD, ...e.map, ...e.output, '-an', out]);
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,sample_aspect_ratio', '-of', 'json', out])).streams[0];
}

test('scanning notes interlacing and DVD pixel shapes', async () => {
  const v = (await media.probe(DVD)).video;
  assert.ok(picture.interlaced(v), `interlaced (field order ${v.fieldOrder})`);
  assert.equal(v.sar, '32:27');
  assert.ok(picture.anamorphic(v));
  assert.ok(Math.abs(picture.darOf(v) - 16 / 9) < 0.01, 'shown at 16:9');
  assert.equal(picture.interlaced({ fieldOrder: 'progressive' }), false);
});

test('converting a DVD deinterlaces it and gives it square pixels at 16:9', async () => {
  const v = (await media.probe(DVD)).video;
  const before = convert({ ...v, fieldOrder: 'progressive', sar: '1:1' }, path.join(ROOT, 'plain.mp4')); // as Marquee did before
  const after = convert(v, path.join(ROOT, 'fixed.mp4'));
  const was = idet(path.join(ROOT, 'plain.mp4')), now = idet(path.join(ROOT, 'fixed.mp4'));
  assert.ok(was.interlaced > was.progressive, `before: combed (${JSON.stringify(was)})`);
  assert.ok(now.progressive > now.interlaced, `now: progressive (${JSON.stringify(now)})`);
  assert.deepEqual([after.width, after.height], [854, 480], '16:9 with square pixels');
  assert.ok(!after.sample_aspect_ratio || after.sample_aspect_ratio === '1:1');
  assert.deepEqual([before.width, before.height], [854, 480], '(the shape comes from the video itself, even before a file is re-checked)');
});

test('every path deinterlaces: graphics cards, drawn-in subtitles, and no copying the picture', () => {
  const v = { codec: 'mpeg2video', pixFmt: 'yuv420p', width: 720, height: 480, fieldOrder: 'tt', sar: '32:27' };
  useGpuCodecs(['h264', 'mpeg2video']);
  try {
    const nv = videoArgs('nvdec', { video: v });
    assert.match(nv.output[nv.output.indexOf('-vf') + 1], /^bwdif_cuda=.*deint=interlaced,scale_cuda=/, 'on the card, before resizing');
  } finally { useGpuCodecs(['h264']); }
  assert.match(videoArgs('nvenc', { video: v }).output.join(' '), /bwdif=mode=send_frame.*scale=.*setsar=1/);
  const burn = videoArgs('software', { video: v, burn: 2 });
  assert.match(burn.output[burn.output.indexOf('-filter_complex') + 1], /^\[0:v:0\]bwdif=[^,]*\[dv\];\[dv\]\[0:s:2\]overlay/, 'deinterlaced before the subtitles go on');
  assert.equal(media.canCopyVideo({ codec: 'h264', pixFmt: 'yuv420p', fieldOrder: 'tt' }), false, 'interlaced H.264 is converted, not copied');
  assert.equal(media.canCopyVideo({ codec: 'h264', pixFmt: 'yuv420p', fieldOrder: 'progressive' }), true);
  assert.doesNotMatch(videoArgs('software', { video: { ...v, fieldOrder: 'progressive' } }).output.join(' '), /bwdif/);
  assert.match(picture.deinterlace({ ...v, pixFmt: 'yuv422p' }), /^format=yuv420p,bwdif=.*deint=all/, 'broadcast 4:2:2: colour first, every frame');
  assert.match(picture.deinterlace(v), /deint=interlaced/, 'DVDs: only frames marked interlaced (film DVDs pass through)');
});
