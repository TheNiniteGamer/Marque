'use strict';
// Library health check for admins: offline folders, files ffprobe can't read, matches that need a
// check, titles with no online match, duplicate copies, and gaps in a season's episode numbers.

const fs = require('node:fs');
const path = require('node:path');
const { pick } = require('./library');

const pad = (n) => String(n).padStart(2, '0');

function findProblems(store, { providersFor }) {
  const { libraries, items, shows } = store.data;
  const libName = Object.fromEntries(libraries.map((l) => [l.id, l.name]));
  const all = Object.values(items);
  const ref = (it) => ({
    id: it.id, type: it.type, library: libName[it.libraryId] || '?', file: it.file,
    title: it.type === 'episode'
      ? `${pick(shows[it.showId] || {}, 'title') || it.showTitle} · S${pad(it.season ?? 0)}E${pad(it.episode ?? 0)}`
      : pick(it, 'title') || it.title || path.basename(it.file),
  });

  const offline = [];
  for (const l of libraries) for (const p of l.paths) if (!fs.existsSync(p)) offline.push({ library: l.name, path: p });

  const unreadable = all.filter((it) => !it.media).map(ref);

  const showRef = (s) => ({ id: s.id, type: 'show', library: libName[s.libraryId] || '?', title: pick(s, 'title') || s.title, file: s.dir });
  const targets = [
    ...(providersFor('movie').length ? all.filter((it) => it.type === 'movie').map((it) => [it, ref(it)]) : []),
    ...(providersFor('show').length ? Object.values(shows).map((s) => [s, showRef(s)]) : []),
  ];
  // Matches Marquee wasn't sure about, and titles with no good match but some guesses: the admin
  // picks one, confirms, or searches. (Titles an admin unmatched on purpose are left alone.)
  const review = targets.filter(([t]) => t.meta?.uncertain || (t.meta?.notFound && t.meta.candidates?.length)).map(([t, r]) => ({
    ...r, name: t.title, year: t.year || null, duration: t.media?.duration || null,
    current: t.meta.provider ? { title: t.meta.title, year: t.meta.year || null, score: t.meta.score ?? null, provider: t.meta.provider, id: t.meta.providerId } : null,
    candidates: (t.meta.candidates || []).filter((c) => !(c.provider === t.meta.provider && c.id === t.meta.providerId)),
  }));
  const unmatched = targets.filter(([t]) => t.meta?.notFound && !t.meta.candidates?.length).map(([, r]) => r);

  // The same episode twice. (The same film twice is one title with several versions: see
  // library.versionsOf.)
  const groups = new Map();
  for (const it of all) {
    let key = null;
    if (it.type === 'episode' && it.episode != null) key = `e|${it.showId}|${it.season}|${it.episode}`;
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const duplicates = [...groups.values()].filter((g) => g.length > 1).map((g) => ({ title: ref(g[0]).title, copies: g.map(ref) }));

  // Episode numbers missing between 1 and the highest one present (specials aside).
  const missingEpisodes = [];
  const seasons = new Map();
  for (const it of all) {
    if (it.type !== 'episode' || it.episode == null || !(it.season > 0)) continue;
    const key = `${it.showId}|${it.season}`;
    if (!seasons.has(key)) seasons.set(key, { showId: it.showId, season: it.season, have: new Set() });
    for (let n = it.episode; n <= (it.episodeEnd || it.episode); n++) seasons.get(key).have.add(n);
  }
  for (const s of seasons.values()) {
    const max = Math.max(...s.have);
    const missing = [];
    for (let n = 1; n < max; n++) if (!s.have.has(n)) missing.push(n);
    if (!missing.length) continue;
    const show = shows[s.showId];
    missingEpisodes.push({ showId: s.showId, show: show ? pick(show, 'title') || show.title : '?', season: s.season, missing });
  }
  missingEpisodes.sort((a, b) => a.show.localeCompare(b.show) || a.season - b.season);

  return { offline, unreadable, review, unmatched, duplicates, missingEpisodes };
}

module.exports = { findProblems };
