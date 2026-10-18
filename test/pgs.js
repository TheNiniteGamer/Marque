'use strict';
// Writes a minimal Blu-ray (PGS / .sup) subtitle file for tests: each cue shows a solid white
// box of w×h at (x, y). Real subtitle text would just be a more detailed bitmap.

function segment(type, ptsSec, payload) {
  const h = Buffer.alloc(13);
  h.write('PG', 0, 'ascii');
  h.writeUInt32BE(Math.round(ptsSec * 90000), 2); // PTS (90 kHz)
  h.writeUInt32BE(0, 6);                            // DTS
  h.writeUInt8(type, 10);
  h.writeUInt16BE(payload.length, 11);
  return Buffer.concat([h, payload]);
}
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };

function display(t, { width, height, x, y, w, h }, n) {
  const pcs = Buffer.concat([u16(width), u16(height), Buffer.from([0x10]), u16(n), Buffer.from([0x80, 0, 0, 1]), u16(0), Buffer.from([0, 0]), u16(x), u16(y)]);
  const wds = Buffer.concat([Buffer.from([1, 0]), u16(x), u16(y), u16(w), u16(h)]);
  const pds = Buffer.from([0, 0, 1, 235, 128, 128, 255]); // palette entry 1 = opaque white
  // Run-length encoded rows: "w pixels of colour 1", end of line.
  const row = Buffer.from([0x00, 0xc0 | (w >> 8), w & 0xff, 0x01, 0x00, 0x00]);
  const rle = Buffer.concat(Array.from({ length: h }, () => row));
  const len = Buffer.alloc(3); len.writeUIntBE(rle.length + 4, 0, 3);
  const ods = Buffer.concat([u16(0), Buffer.from([0, 0xc0]), len, u16(w), u16(h), rle]);
  return Buffer.concat([segment(0x16, t, pcs), segment(0x17, t, wds), segment(0x14, t, pds), segment(0x15, t, ods), segment(0x80, t, Buffer.alloc(0))]);
}

function clear(t, { width, height, x, y, w, h }, n) {
  const pcs = Buffer.concat([u16(width), u16(height), Buffer.from([0x10]), u16(n), Buffer.from([0x00, 0, 0, 0])]);
  const wds = Buffer.concat([Buffer.from([1, 0]), u16(x), u16(y), u16(w), u16(h)]);
  return Buffer.concat([segment(0x16, t, pcs), segment(0x17, t, wds), segment(0x80, t, Buffer.alloc(0))]);
}

/** cues: [{ start, end }] in seconds; box: { width, height (video), x, y, w, h }. */
function makeSup(cues, box) {
  // Starts with an empty screen at 0 s: ffmpeg counts a file's times from its first entry.
  return Buffer.concat([clear(0, box, 0), ...cues.flatMap((c, i) => [display(c.start, box, i * 2 + 1), clear(c.end, box, i * 2 + 2)])]);
}

module.exports = { makeSup };
