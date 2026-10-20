'use strict';
// Getting a converted picture right for DVD-style video (MPEG-2 and some TV recordings):
//  - Interlaced video (each frame two half-pictures taken a moment apart) shows thin "comb"
//    lines on anything moving unless it's deinterlaced when converted. bwdif only touches frames
//    marked interlaced, so film-based DVDs with progressive frames pass through as they are.
//  - DVD pixels aren't square (720×480 shown as 16:9 or 4:3). Converted pictures are made with
//    square pixels at the right shape, which every player shows correctly.
// Players that get the file as it is (the Shield, say) do both themselves.

const INTERLACED = new Set(['tt', 'bb', 'tb', 'bt']);
/** Whether a probed video stream ({ fieldOrder }) is interlaced. */
const interlaced = (v) => INTERLACED.has(v?.fieldOrder);

/** The shape a probed video stream ({ width, height, sar: "32:27" }) is shown at (width / height). */
function darOf(v) {
  const [n, d] = String(v?.sar || '1:1').split(':').map(Number);
  const sar = n > 0 && d > 0 ? n / d : 1;
  return v?.width && v?.height ? (v.width * sar) / v.height : 16 / 9;
}
/** Whether its pixels aren't square (DVDs). */
const anamorphic = (v) => { const [n, d] = String(v?.sar || '1:1').split(':').map(Number); return n > 0 && d > 0 && n !== d; };

/**
 * Filter that deinterlaces an interlaced picture ('' otherwise); on CUDA frames with `cuda`.
 * 4:2:0 video (DVDs) only has the frames marked interlaced deinterlaced, so film DVDs made of
 * whole frames pass through. 4:2:2 / 4:4:4 video (broadcast recordings) is brought to 4:2:0
 * first: converting its colour afterwards mixes the colour of the two half-pictures again, and
 * it's always truly interlaced, so every frame is done.
 */
function deinterlace(v, { cuda = false } = {}) {
  if (!interlaced(v)) return '';
  if (!cuda && /42[24]|444/.test(v.pixFmt || '')) return 'format=yuv420p,bwdif=mode=send_frame:parity=auto:deint=all';
  return `${cuda ? 'bwdif_cuda' : 'bwdif'}=mode=send_frame:parity=auto:deint=interlaced`;
}

/**
 * Scaling to at most `maxHeight` lines, with square pixels at the picture's real shape
 * (`dar` is the display aspect ratio, so a 16:9 DVD becomes 854×480).
 */
function scaleTo(maxHeight, { cuda = false } = {}) {
  const h = `min(${maxHeight},ih)`;
  return `${cuda ? 'scale_cuda' : 'scale'}=w='round(${h}*dar/2)*2':h='${h}'`;
}
// (setsar=1 after it: the pixels are square now, whatever the source said.)

/** A width-first version (thumbnails, seek previews): `width` wide, as tall as its shape needs. */
const scaleWidth = (width) => `scale=${width}:'round(ow/dar/2)*2'`;

/** Filters joined, leaving out empty ones. */
const chain = (...f) => f.filter(Boolean).join(',');

module.exports = { interlaced, anamorphic, darOf, deinterlace, scaleTo, scaleWidth, chain };
