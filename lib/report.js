'use strict';
// The library report (Settings → Formats & space): what the library's space goes on, and which
// films and episodes have to be converted for which kind of player, and why, so an admin knows
// which files are worth replacing (a 1080p H.264 copy with AAC sound plays as it is everywhere).
//
// For each kind of player a title is "direct" (plays as it is), "light" (the picture is kept, only
// the sound or the file type is converted: cheap) or "convert" (the picture is converted: the
// work that keeps a server busy). A film with several versions counts its best one.

const path = require('node:path');
const media = require('./media');
const { pick, versionsOf, isOtherVersion, resolveItem } = require('./library');
const { interlaced } = require('./picture');

const PLAYERS = [
  { id: 'browser', label: 'Web browsers' },
  { id: 'roku', label: 'Roku (4K models)' },
  { id: 'android', label: 'Android TV / Shield' },
  { id: 'hd', label: '1080p TVs and sticks' },
];

const heightOf = (v) => Math.max(v?.height || 0, Math.round(((v?.width || 0) * 9) / 16));
const resLabel = (v) => { const h = heightOf(v); return h >= 2000 ? '4K' : h >= 1400 ? '1440p' : h >= 1000 ? '1080p' : h >= 700 ? '720p' : h ? 'SD' : '?'; };
const tenBit = (v) => /10/.test(v?.profile || '') || /10/.test(v?.pixFmt || '');
const hdrOf = (v) => (v?.colorTransfer === 'smpte2084' ? 'HDR10' : v?.colorTransfer === 'arib-std-b67' ? 'HLG' : null);
const CODEC = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', vp8: 'VP8', mpeg2video: 'MPEG-2', mpeg4: 'MPEG-4 (DivX/XviD)', vc1: 'VC-1', msmpeg4v3: 'MPEG-4 v3', wmv3: 'WMV' };
const AUDIO = { aac: 'AAC', ac3: 'Dolby Digital', eac3: 'Dolby Digital Plus', truehd: 'Dolby TrueHD', dts: 'DTS', mp3: 'MP3', flac: 'FLAC', opus: 'Opus', vorbis: 'Vorbis', pcm_s16le: 'PCM', pcm_s24le: 'PCM' };
const ext = (it) => path.extname(it.file).slice(1).toLowerCase();
// "H.264 10-bit video", "HEVC 10-bit video", "H.264 4:4:4 video"…
function videoName(v) {
  const px = v?.pixFmt || '';
  const chroma = /444/.test(px) ? ' 4:4:4' : /422/.test(px) ? ' 4:2:2' : '';
  return `${CODEC[v?.codec] || v?.codec || '?'}${tenBit(v) ? ' 10-bit' : ''}${chroma} video`;
}

/** How one file fares on each kind of player: { [player]: { how, why } }. */
function fare(it) {
  const v = it.media?.video;
  const a = it.media?.audio?.[0]?.codec || null;
  const e = ext(it);
  const h264ok = v?.codec === 'h264' && !tenBit(v) && (!v.pixFmt || ['yuv420p', 'yuvj420p'].includes(v.pixFmt));
  const keepPicture = media.canCopyVideo(v); // what the server can stream without converting the picture
  const res = (how, ...why) => ({ how, why: why.filter(Boolean) });
  const out = {};

  // Browsers: MP4 / WebM with H.264 (or VP9 / AV1) and AAC / MP3 / Opus / FLAC.
  if (media.canDirectPlay(it)) out.browser = res('direct');
  else if (keepPicture) out.browser = res('light', !['mp4', 'm4v', 'mov', 'webm'].includes(e) && `${e.toUpperCase()} file`, a && !['aac', 'mp3', 'opus', 'vorbis', 'flac'].includes(a) && `${AUDIO[a] || a} sound`);
  else out.browser = res('convert', v?.codec === 'hevc' ? 'HEVC (only some browsers)' : videoName(v), hdrOf(v));

  // A 4K Roku: MP4 or MKV, H.264 or HEVC (10-bit too), AAC / Dolby Digital (Plus) / MP3 / FLAC.
  const rokuVideo = h264ok || v?.codec === 'hevc';
  const rokuAudio = !a || ['aac', 'ac3', 'eac3', 'mp3', 'flac'].includes(a);
  const rokuFile = ['mp4', 'm4v', 'mov', 'mkv'].includes(e);
  if (rokuVideo && rokuAudio && rokuFile) out.roku = res('direct');
  else if (keepPicture) out.roku = res('light', !rokuAudio && `${AUDIO[a] || a} sound`, !rokuFile && `${e.toUpperCase()} file`);
  else out.roku = res('convert', !rokuVideo ? videoName(v) : null, !rokuAudio && `${AUDIO[a] || a} sound`, !rokuFile && `${e.toUpperCase()} file`);

  // Android TV boxes like the Shield: most files, but not DTS or TrueHD sound in an app.
  const andVideo = h264ok || ['hevc', 'vp9', 'mpeg2video'].includes(v?.codec);
  const andAudio = !a || ['aac', 'ac3', 'eac3', 'mp3', 'flac', 'opus', 'vorbis'].includes(a);
  const andFile = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'ts', 'm2ts', 'mts'].includes(e);
  if (andVideo && andAudio && andFile) out.android = res('direct');
  else if (keepPicture) out.android = res('light', !andAudio && `${AUDIO[a] || a} sound`, !andFile && `${e.toUpperCase()} file`);
  else out.android = res('convert', !andVideo ? videoName(v) : null, !andAudio && `${AUDIO[a] || a} sound`);

  // 1080p TVs and sticks: H.264 up to 1080p only.
  const big = heightOf(v) > 1100;
  const hdAudio = !a || ['aac', 'ac3', 'eac3', 'mp3'].includes(a);
  if (h264ok && !big && hdAudio && rokuFile) out.hd = res('direct');
  else if (keepPicture && !big) out.hd = res('light', !hdAudio && `${AUDIO[a] || a} sound`, !rokuFile && `${e.toUpperCase()} file`);
  else out.hd = res('convert', big && `${resLabel(v)} picture`, !h264ok && videoName(v), hdrOf(v));
  return out;
}

const RANK = { direct: 0, light: 1, convert: 2 };

function libraryReport(store) {
  const { items, shows, libraries } = store.data;
  const libName = Object.fromEntries((libraries || []).map((l) => [l.id, l.name]));
  const byRes = {}, byCodec = {};
  let hdr = 0, hdrBytes = 0, total = 0, files = 0;
  const titles = [];
  for (const it of Object.values(items)) {
    if (!it.media?.video || (it.type !== 'movie' && it.type !== 'episode')) continue;
    const v = it.media.video;
    files++;
    total += it.size || 0;
    const r = resLabel(v);
    (byRes[r] ||= { count: 0, bytes: 0 }).count++;
    byRes[r].bytes += it.size || 0;
    const c = CODEC[v.codec] || v.codec || '?';
    (byCodec[c] ||= { count: 0, bytes: 0 }).count++;
    byCodec[c].bytes += it.size || 0;
    if (hdrOf(v)) { hdr++; hdrBytes += it.size || 0; }
    if (isOtherVersion(store, it)) continue; // (counted with its film below)

    // A film with several versions: on each kind of player, the best of them.
    const copies = (versionsOf(store, it) || [{ id: it.id }]).map((x) => resolveItem(store, x.id)).filter(Boolean); // (versions and converted copies)
    const players = {};
    for (const p of PLAYERS) {
      players[p.id] = copies.map((x) => fare(x)[p.id]).sort((a, b) => RANK[a.how] - RANK[b.how])[0];
    }
    if (Object.values(players).every((x) => x.how === 'direct')) continue;
    const show = it.showId ? shows[it.showId] : null;
    titles.push({
      id: it.id, type: it.type, library: libName[it.libraryId] || '',
      title: it.type === 'episode'
        ? `${(show && (pick(show, 'title') || show.title)) || it.showTitle} · S${String(it.season ?? 0).padStart(2, '0')}E${String(it.episode ?? 0).padStart(2, '0')}`
        : `${pick(it, 'title') || it.title}${(pick(it, 'year') || it.year) ? ` (${pick(it, 'year') || it.year})` : ''}`,
      size: copies.reduce((n, x) => n + (x.size || 0), 0), versions: copies.length,
      res: resLabel(v), hdr: hdrOf(v), codec: CODEC[v.codec] || v.codec, audio: AUDIO[it.media.audio?.[0]?.codec] || it.media.audio?.[0]?.codec || null,
      container: ext(it).toUpperCase(), interlaced: interlaced(v), players,
    });
  }
  titles.sort((a, b) => b.size - a.size);
  const counts = Object.fromEntries(PLAYERS.map((p) => [p.id, { light: 0, convert: 0 }]));
  for (const t of titles) for (const p of PLAYERS) if (t.players[p.id].how !== 'direct') counts[p.id][t.players[p.id].how]++;
  return { players: PLAYERS, files, total, byRes, byCodec, hdr: { count: hdr, bytes: hdrBytes }, counts, titles };
}

module.exports = { libraryReport, fare, PLAYERS };
