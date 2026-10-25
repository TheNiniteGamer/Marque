'use strict';
// Playing videos: direct streams, conversion, adaptive streaming, seek previews, watch together and subtitles.
// Registered by server.js, which passes the shared helpers and services in `app`.

const { playerPrefs } = require('../lib/auth');
const { saveDownloaded } = require('../lib/autosubs');
const screenTime = require('../lib/screentime');

module.exports = function register(app) {
  const {
    fs, crypto, path, pipeline, media, subs, lib, hlsLib,
    SUB_DOWNLOADS, store, hwaccel, hls, keyframes, offline, offlineLib, previews, tokens, opensubs, parties, trickplay,
    transcodes, HttpError, json, readBody, sendFile, getItem, getShow, resolveArt,
    subtitleVtt, castAddresses, remoteLimit, route, clientIp,
  } = app;

  // --- playback ---
  // ?burn=<n>: draw picture-based subtitle stream n into the video (it must be one).
  function burnParam(item, url) {
    if (!url.searchParams.has('burn')) return null;
    const n = Number(url.searchParams.get('burn'));
    const sub = item.media?.subtitles?.find((s) => s.index === n);
    if (!sub || !media.IMAGE_SUB_CODECS.has(sub.codec)) throw new HttpError(400, 'Not a picture subtitle track');
    return n;
  }

  // Kids' bedtime and daily limit (screentime.js): nothing plays outside them, whatever the device.
  function checkScreenTime(user) {
    const b = screenTime.blocked(store, user);
    if (b) throw new HttpError(403, b.message);
  }

  function checkOriginalAllowed(req, item) {
    const limit = remoteLimit(req, item);
    if (limit && !limit.originalAllowed) throw new HttpError(403, `Away from home, videos play at up to ${limit.quality} (set by the server's admin)`);
  }

  // --- preview clips (hovering over a title, the home page's banner): see lib/previews.js ---
  // 404 until the clip is made (asking starts that), so the page just shows the picture meanwhile.
  route('GET', '/api/previews/:id', async (req, res, { id }, url, user) => {
    const isShow = Object.hasOwn(store.data.shows, id);
    if (isShow) getShow(id, user); else getItem(id, user);
    const file = previews.get(id);
    if (!file) throw new HttpError(404, 'No preview yet');
    sendFile(req, res, file, { type: 'video/mp4', headers: { 'Cache-Control': 'private, max-age=86400' } });
  }, 'media');

  // --- downloads for watching offline (the phone app) ---
  // What can be downloaded: the original file (when allowed), and the sizes a copy can be made at.
  // ?quality=&audio= also says how that copy is coming along.
  function offlineChoice(req, item, url, body = null) {
    if (!item.media?.video) throw new HttpError(400, 'This file cannot be downloaded');
    const quality = String(body?.quality ?? url.searchParams.get('quality') ?? '');
    const audio = Number(body?.audio ?? url.searchParams.get('audio') ?? 0);
    const limit = remoteLimit(req, item);
    if (limit && Object.hasOwn(offlineLib.SIZES, quality) && offlineLib.SIZES[quality].height > limit.maxHeight) throw new HttpError(403, `Away from home, downloads are up to ${limit.quality} (set by the server's admin)`);
    return { quality, audio };
  }
  route('GET', '/api/items/:id/offline', async (req, res, { id }, url, user) => {
    const item = getItem(id, user);
    if (!item.media?.video) throw new HttpError(400, 'This file cannot be downloaded');
    const limit = remoteLimit(req, item);
    const out = {
      original: { allowed: !limit || limit.originalAllowed, size: item.size || null },
      sizes: offlineLib.sizesFor(item).filter((s) => !limit || s.height <= limit.maxHeight),
    };
    if (url.searchParams.has('quality')) out.copy = offline.status(item, offlineChoice(req, item, url));
    json(res, 200, out);
  });
  route('POST', '/api/items/:id/offline', async (req, res, { id }, url, user) => {
    const item = getItem(id, user);
    json(res, 200, offline.request(item, { ...offlineChoice(req, item, url, await readBody(req)), userId: user.role === 'admin' ? null : user.id }));
  });
  route('GET', '/api/items/:id/offline/file', async (req, res, { id }, url, user) => {
    const item = getItem(id, user);
    const choice = offlineChoice(req, item, url);
    const name = `${path.basename(item.file, path.extname(item.file))} (${choice.quality}).mp4`;
    sendFile(req, res, offline.path(item, choice), { type: 'video/mp4', headers: { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` } });
  });

  route('GET', '/api/items/:id/stream', async (req, res, { id }, url, user) => {
    const item = getItem(id, user);
    checkScreenTime(user);
    checkOriginalAllowed(req, item);
    const headers = url.searchParams.has('download')
      ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(item.file))}` } : {};
    sendFile(req, res, item.file, { type: url.searchParams.has('download') ? 'application/octet-stream' : media.mimeFor(item.file), headers });
  }, 'media');

  route('GET', '/api/items/:id/seekpoint', async (req, res, { id }, url, user) => {
    const item = getItem(id, user);
    const t = Math.max(0, Number(url.searchParams.get('t')) || 0);
    // Request the transcode with `t`; the stream's first frame will be at `start` (<= t).
    // (With subtitles drawn in, the video is re-encoded and starts exactly at t.)
    json(res, 200, { t, start: burnParam(item, url) != null ? t : await media.seekPoint(item, t, { hevc: url.searchParams.get('hevc') === '1' }) });
  }, 'media');

  route('GET', '/api/items/:id/transcode', async (req, res, { id }, url, user) => {
    const item = getItem(id, user);
    checkScreenTime(user);
    if (!fs.existsSync(item.file)) throw new HttpError(404, 'File not found on disk');
    checkOriginalAllowed(req, item);
    const start = Math.max(0, Number(url.searchParams.get('start')) || 0);
    const audioIndex = Math.max(0, Number(url.searchParams.get('audio')) || 0);
    const burn = burnParam(item, url);
    // One conversion per player: a seek or a new audio track replaces that player's earlier one (its
    // playback session, or for apps that don't send one, this person and title from this device),
    // stopped now so it isn't counted; other devices keep theirs. Then the places shared with HLS.
    const sid = /^[A-Za-z0-9_-]{6,64}$/.test(url.searchParams.get('sid') || '') ? url.searchParams.get('sid') : null;
    const player = sid ? `sid:${sid}` : `${user.id}|${item.id}|${clientIp(req)}`;
    for (const p of transcodes) if (p.meta?.player === player) { transcodes.delete(p); p.kill('SIGKILL'); }
    if (hls.full()) hls.makeRoom();
    let finished = false;
    const run = (asked) => {
      const hevc = url.searchParams.get('hevc') === '1';
      const proc = media.transcode(item, { start, audioIndex, encoder: asked, burn, night: url.searchParams.get('night') === '1', hevc });
      // (What's really used: an NVIDIA card can't decode every video, and copied pictures use none.)
      const encoder = proc.encoder || 'software';
      proc.meta = { itemId: item.id, userId: user.id, encoder: proc.encoder, player };
      transcodes.add(proc);
      let stderr = '';
      let sent = false;
      proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
      const stop = () => { if (proc.exitCode === null) proc.kill('SIGKILL'); };
      const onClose = () => { finished = true; stop(); };
      res.once('close', onClose);
      // Headers go out with the first bytes, so a graphics-card encoder that can't start can be
      // swapped for the CPU before the player sees anything.
      proc.stdout.once('data', (first) => {
        sent = true;
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'X-Transcode-Start': String(start), 'X-Encoder': encoder });
        res.write(first);
        pipeline(proc.stdout, res, () => stop());
      });
      proc.on('close', (code, signal) => {
        transcodes.delete(proc);
        res.off('close', onClose);
        if (finished) return;
        if (!sent && code && encoder !== 'software') {
          hwaccel.reportFailure(encoder, stderr.trim().split('\n').pop());
          return run(hwaccel.fallback(encoder));
        }
        if (code && !signal) console.warn(`[transcode] ${path.basename(item.file)} exited ${code}: ${stderr.trim()}`);
        if (!sent && !res.headersSent) json(res, 500, { error: 'The server could not convert this video' });
      });
    };
    run(hwaccel.active);
  }, 'media');

  // Everything a player needs to stream an item without the login cookie: a signed link token, a
  // fresh adaptive-streaming session id, the qualities on offer, and where cast devices can reach us.
  route('GET', '/api/items/:id/playback', async (req, res, { id }, url, user) => {
    const item = getItem(id, user);
    checkScreenTime(user);
    const limit = remoteLimit(req, item);
    // The original picture without converting it ("source", see lib/hls.js), for an MKV's H.264 say.
    // Its keyframes are found once first: a first play waits a few seconds for that, and plays
    // converted if it takes longer (the next play has them). The next episode's are found meanwhile.
    let remux = false;
    if (media.canRemux(item) && (!limit || limit.originalAllowed) && fs.existsSync(item.file)) {
      remux = !!(await Promise.race([keyframes.ensure(item), new Promise((r) => setTimeout(r, 4000, null))]));
      if (item.type === 'episode' && item.showId) {
        const eps = lib.episodesOf(store, item.showId);
        const next = eps[eps.findIndex((e) => e.id === item.id) + 1];
        if (next && media.canRemux(next)) keyframes.ensure(next).catch(() => {});
      }
    }
    json(res, 200, {
      remux,
      token: tokens.create(item.id, user.id),
      sid: crypto.randomBytes(12).toString('base64url'),
      directPlay: media.canDirectPlay(item),
      originalAllowed: !limit || limit.originalAllowed,
      limit: limit ? limit.quality : null,
      qualities: item.media?.video ? hlsLib.qualitiesFor(item, limit?.maxHeight).map(({ id: q, label, height, bitrate }) => ({ id: q, label, height, bitrate })) : [],
      intro: item.intro?.end ? { start: item.intro.start, end: item.intro.end } : null,
      recap: item.recap?.end ? { start: item.recap.start, end: item.recap.end } : null,
      credits: item.credits?.start ? { start: item.credits.start } : null,
      cast: castAddresses(),
      prefs: playerPrefs(user),
    });
  });

  // --- adaptive streaming (HLS) ---
  // ?sid=<session>&audio=<track>&q=<quality, to offer just one>&mt=<token> (or at=<device token>, Roku)
  const hlsQuery = (url) => {
    const q = new URLSearchParams();
    for (const k of ['sid', 'audio', 'burn', 'night', 'mt', 'at']) if (url.searchParams.get(k)) q.set(k, url.searchParams.get(k));
    return `?${q}`;
  };
  const hlsItem = (id, user) => {
    const item = getItem(id, user);
    checkScreenTime(user);
    if (!item.media?.video || !item.media.duration) throw new HttpError(400, 'This file cannot be streamed');
    if (!fs.existsSync(item.file)) throw new HttpError(404, 'File not found on disk');
    return item;
  };
  const M3U8 = { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' };
  // "source" (the original picture): only once its keyframes are known, and only where the
  // original is allowed (the admin may limit the quality away from home).
  const sourceKeyframes = (req, item, quality) => {
    if (quality !== 'source') return null;
    checkOriginalAllowed(req, item);
    const k = media.canCopyVideo(item.media?.video) ? keyframes.get(item) : null;
    if (!k) throw new HttpError(404, 'This video can’t be streamed without converting it yet');
    return k;
  };
  route('GET', '/api/items/:id/hls/master.m3u8', async (req, res, { id }, url, user) => {
    const item = hlsItem(id, user);
    sourceKeyframes(req, item, url.searchParams.get('q'));
    const body = hlsLib.masterPlaylist(item, { only: url.searchParams.get('q') || null, query: hlsQuery(url), maxHeight: remoteLimit(req, item)?.maxHeight });
    res.writeHead(200, M3U8); res.end(body);
  }, 'media');
  route('GET', '/api/items/:id/hls/:quality/index.m3u8', async (req, res, { id, quality }, url, user) => {
    const item = hlsItem(id, user);
    const body = hlsLib.mediaPlaylist(item, quality, { query: hlsQuery(url), maxHeight: remoteLimit(req, item)?.maxHeight, keyframes: sourceKeyframes(req, item, quality) });
    res.writeHead(200, M3U8); res.end(body);
  }, 'media');
  route('GET', '/api/items/:id/hls/:quality/:segment', async (req, res, { id, quality, segment }, url, user) => {
    const m = /^seg-(\d+)\.ts$/.exec(segment);
    if (!m) throw new HttpError(404, 'Not found');
    const item = hlsItem(id, user);
    const file = await hls.segment(item, {
      quality, sid: url.searchParams.get('sid'), audio: Math.max(0, Number(url.searchParams.get('audio')) || 0),
      burn: burnParam(item, url), night: url.searchParams.get('night') === '1', maxHeight: remoteLimit(req, item)?.maxHeight, userId: user.id,
      keyframes: sourceKeyframes(req, item, quality),
    }, Number(m[1]));
    sendFile(req, res, file, { type: 'video/mp2t', headers: { 'Cache-Control': 'no-cache' } });
  }, 'media');
  // The player closed: stop converting right away instead of waiting for the idle timeout.
  route('DELETE', '/api/hls/:sid', async (req, res, { sid }) => { hls.end(sid); json(res, 200, { ok: true }); });

  // --- seek preview thumbnails ---
  route('GET', '/api/items/:id/trickplay', async (req, res, { id }, url, user) => json(res, 200, trickplay.info(getItem(id, user, { real: true }))), 'media');
  route('GET', '/api/items/:id/trickplay/:n', async (req, res, { id, n }, url, user) => {
    const file = trickplay.sheet(getItem(id, user, { real: true }), String(n).replace(/\.jpg$/, ''));
    if (!file) throw new HttpError(404, 'Not ready');
    sendFile(req, res, file, { type: 'image/jpeg', headers: { 'Cache-Control': 'private, max-age=86400' } });
  }, 'media');

  // --- watch together ---
  // Everyone in a party must be able to see the video being played (normal library permissions).
  const partyFor = (id, user) => {
    const p = parties.get(id);
    getItem(p.itemId, user);
    return p;
  };
  route('POST', '/api/parties', async (req, res, p, url, user) => {
    const body = await readBody(req);
    const item = getItem(String(body.itemId || ''), user);
    json(res, 201, parties.view(parties.create(user, item.id, { position: Math.max(0, Number(body.position) || 0), playing: !!body.playing })));
  });
  route('GET', '/api/parties/:id', async (req, res, { id }, url, user) => json(res, 200, parties.view(partyFor(id, user))));
  route('GET', '/api/parties/:id/events', async (req, res, { id }, url, user) => parties.join(partyFor(id, user), user, url.searchParams.get('client'), res));
  route('POST', '/api/parties/:id/state', async (req, res, { id }, url, user) => {
    const p = partyFor(id, user);
    const body = await readBody(req);
    if (body.itemId) getItem(String(body.itemId), user);
    parties.update(p, body);
    json(res, 200, parties.view(p));
  });

  // --- subtitles from OpenSubtitles.com ---
  route('GET', '/api/items/:id/subtitle-search', async (req, res, { id }, url, user) => {
    const item = getItem(id, user, { real: true });
    if (!['movie', 'episode'].includes(item.type)) throw new HttpError(400, 'Subtitles can be searched for movies and episodes');
    const languages = (url.searchParams.get('lang') || 'en').split(',').map((l) => l.trim().toLowerCase()).filter((l) => /^[a-z]{2}(-[a-z]{2})?$/.test(l)).join(',');
    if (!languages) throw new HttpError(400, 'Choose a language');
    json(res, 200, { results: await opensubs.search(item, store.data.shows[item.showId], languages) });
  });
  // OpenSubtitles downloads use the server's daily allowance (and change the title for everyone), so
  // each person (admins aside) gets 20 a day.
  const subDownloads = new Map(); // userId -> [times]
  route('POST', '/api/items/:id/subtitle-download', async (req, res, { id }, url, user) => {
    const item = getItem(id, user, { real: true });
    if (user.role !== 'admin') {
      const today = (subDownloads.get(user.id) || []).filter((t) => t > Date.now() - 86400_000);
      if (today.length >= 20) throw new HttpError(429, 'That’s 20 subtitle downloads today; try again tomorrow');
      subDownloads.set(user.id, [...today, Date.now()]);
    }
    const body = await readBody(req);
    if (!/^\d+$/.test(String(body.fileId || ''))) throw new HttpError(400, 'Pick a subtitle from the search results');
    const { text, remaining } = await opensubs.download(body.fileId);
    const lang = /^[a-z]{2}(-[a-z]{2})?$/i.test(body.language || '') ? body.language.toLowerCase() : null;
    const at = saveDownloaded(store, SUB_DOWNLOADS, item, { fileId: body.fileId, text, lang, release: body.release });
    const detail = lib.itemDetail(store, user, item);
    json(res, 200, { ...detail, added: `dl${at}`, remaining });
  });
  route('DELETE', '/api/items/:id/subtitles/:sub', async (req, res, { id, sub }, url, user) => {
    const item = getItem(id, user, { real: true });
    const m = /^dl(\d+)$/.exec(sub);
    const s = m && item.downloadedSubs?.[Number(m[1])];
    if (!s) throw new HttpError(404, 'Only downloaded subtitles can be removed');
    fs.rmSync(path.join(SUB_DOWNLOADS, s.file), { force: true });
    item.downloadedSubs.splice(Number(m[1]), 1);
    store.save();
    json(res, 200, lib.itemDetail(store, user, item));
  }, 'admin');

  route('GET', '/api/items/:id/subtitles/:sub', async (req, res, { id, sub }, url, user) => {
    const item = getItem(id, user);
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    // "ext0.vtt" works too (players that tell formats apart by the file name, like Roku).
    const vtt = subs.shiftVtt(await subtitleVtt(item, sub.replace(/\.vtt$/i, '')), offset);
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(vtt);
  }, 'media');

  route('GET', '/api/art/:kind/:id', async (req, res, { kind, id }, url, user) => {
    if (!['poster', 'backdrop', 'thumb'].includes(kind)) throw new HttpError(404, 'Unknown art kind');
    const file = await resolveArt(kind, id, user);
    if (!file) throw new HttpError(404, 'No artwork');
    // Image addresses carry ?v=<version>, which changes whenever the artwork does: keep them for good.
    sendFile(req, res, file, { headers: { 'Cache-Control': url.searchParams.has('v') ? 'private, max-age=31536000, immutable' : 'private, max-age=3600' } });
  }, 'media');
};
