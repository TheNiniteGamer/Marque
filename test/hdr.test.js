'use strict';
// HDR videos: noticed when scanned (and for titles scanned before), and converted to ordinary
// colours whenever the server converts the picture. Needs ffmpeg with zscale (zimg) or Jellyfin's
// tonemapx, and x265.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hdr = require('../lib/hdr');
const media = require('../lib/media');
const { videoArgs } = require('../lib/hwaccel');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-hdr-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
const HDR = path.join(ROOT, 'hdr.mkv');
const SDR = path.join(ROOT, 'sdr.mp4');

test.before(async () => {
  await hdr.check();
  // A colour test pattern mastered as HDR10 (PQ, BT.2020, 10-bit HEVC), and the same in SDR.
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:d=1', '-vf',
    'zscale=tin=bt709:t=smpte2084:pin=bt709:p=bt2020:min=bt709:m=bt2020nc:npl=400,format=yuv420p10le',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc', HDR]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', SDR]);
});

// Average colour saturation of the first frame after converting `file` with these encoder settings.
function saturation(file, video) {
  const e = videoArgs('software', { maxHeight: 360, video });
  const out = path.join(ROOT, `out-${Math.random().toString(36).slice(2)}.mp4`);
  ff(['-i', file, ...e.map, ...e.output, '-frames:v', '1', out]);
  const log = execFileSync('ffmpeg', ['-hide_banner', '-i', out, '-vf', 'signalstats,metadata=print:file=-', '-frames:v', '1', '-f', 'null', '-'],
    { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  return Number(/SATAVG=([\d.]+)/.exec(log)[1]);
}

test('HDR10 and HLG are told apart from ordinary video', () => {
  assert.equal(hdr.hdrKind({ colorTransfer: 'smpte2084' }), 'hdr10');
  assert.equal(hdr.hdrKind({ colorTransfer: 'arib-std-b67' }), 'hlg');
  assert.equal(hdr.hdrKind({ colorTransfer: 'bt709' }), null);
  assert.equal(hdr.hdrKind(null), null);
  assert.equal(hdr.hdrKind({ dvProfile: 5 }), 'dovi', 'Dolby Vision without an HDR10 picture underneath');
  assert.equal(hdr.hdrKind({ dvProfile: 8, colorTransfer: 'smpte2084' }), 'hdr10', 'Dolby Vision with one is mapped as HDR10');
});

test('Dolby Vision profile 5 is only converted by filters that read its colour instructions', (t) => {
  if (!hdr.toneMapping()) return t.skip('no tone mapping in this ffmpeg');
  const dovi = hdr.toneMap({ dvProfile: 5 });
  if (/tonemapx/.test(hdr.toneMap({ colorTransfer: 'smpte2084' }))) {
    assert.match(dovi, /^tonemapx=/, 'its colours come from the file, not stated');
    assert.match(hdr.toneMap({ colorTransfer: 'arib-std-b67' }), /color_trc=arib-std-b67/);
  } else assert.equal(dovi, '', 'zscale would only make it worse');
});

test('scanning notes a video\'s colours', async () => {
  assert.equal((await media.probe(HDR)).video.colorTransfer, 'smpte2084');
  assert.notEqual((await media.probe(SDR)).video.colorTransfer, 'smpte2084');
});

test('converting an HDR video maps it to ordinary colours, not washed-out ones', (t) => {
  if (!hdr.toneMapping()) return t.skip('no zscale in this ffmpeg');
  const v = { colorTransfer: 'smpte2084' };
  assert.match(videoArgs('software', { video: v }).output.join(' '), /tonemap/);
  assert.match(videoArgs('vaapi', { video: v }).output.join(' '), /tonemap.*hwupload/, 'graphics cards get the CPU-mapped picture');
  assert.doesNotMatch(videoArgs('software', { video: { colorTransfer: 'bt709' } }).output.join(' '), /tonemap/, 'ordinary video untouched');

  const reference = saturation(SDR, null);
  const naive = saturation(HDR, null);
  const mapped = saturation(HDR, v);
  assert.ok(naive < reference * 0.4, `without tone mapping it's washed out (${naive} vs ${reference})`);
  assert.ok(mapped > reference * 0.75, `with it the colours come back (${mapped} vs ${reference})`);
});

test('titles scanned before get their colours checked, once', async () => {
  const items = {
    a: { id: 'a', file: HDR, media: { video: { codec: 'hevc' } } },
    b: { id: 'b', file: SDR, media: { video: { codec: 'h264' } } },
    c: { id: 'c', file: SDR, media: { video: { codec: 'h264', colorTransfer: null } } }, // colours checked, not interlacing yet
    d: { id: 'd', file: SDR, media: { video: { codec: 'h264', colorTransfer: null, fieldOrder: 'progressive' } } }, // all checked
  };
  let saves = 0;
  const store = { data: { items }, save() { saves++; } };
  const found = [];
  const r = await hdr.backfill(store, (it) => found.push(it.id));
  assert.deepEqual(r, { checked: 3, hdr: 1 });
  assert.equal(items.c.media.video.fieldOrder, 'progressive');
  assert.deepEqual(found, ['a'], 'pictures made from the HDR one are made again');
  assert.equal(items.a.media.video.colorTransfer, 'smpte2084');
  assert.ok(saves >= 1);
  assert.deepEqual(await hdr.backfill(store), { checked: 0, hdr: 0 }, 'nothing left to do');
});
