'use strict';
// A fake Radarr or Sonarr for the tests: the parts of their v3 API Marquee uses, with the shapes
// Radarr 5 and Sonarr 4 send. Everything Marquee changes is kept in `sent`; tests set `items`,
// `queue`, `freeSpace` and `down` to play out what happens next.

const http = require('node:http');

// Quality profiles as they send them: qualities, some in groups, each allowed or not.
const PROFILES = [
  { id: 1, name: 'Any', items: [{ quality: { id: 4, name: 'HDTV-1080p', resolution: 1080 }, allowed: true }, { quality: { id: 19, name: 'Bluray-2160p', resolution: 2160 }, allowed: true }] },
  { id: 4, name: 'HD-1080p', items: [
    { quality: { id: 19, name: 'Bluray-2160p', resolution: 2160 }, allowed: false },
    { name: 'WEB 1080p', allowed: true, items: [{ quality: { id: 3, name: 'WEBDL-1080p', resolution: 1080 }, allowed: true }, { quality: { id: 15, name: 'WEBRip-1080p', resolution: 1080 }, allowed: true }] },
    { quality: { id: 7, name: 'Bluray-1080p', resolution: 1080 }, allowed: true },
  ] },
];

// Breaking Bad as Sonarr's lookup has it: five seasons.
const BREAKING_BAD = { title: 'Breaking Bad', tvdbId: 81189, year: 2008, seasons: [1, 2, 3, 4, 5].map((n) => ({ seasonNumber: n, monitored: false })) };

function fakeArr(app, { key, rootFolder }) {
  const st = { sent: [], items: {}, queue: [], calendar: [], down: false, freeSpace: 500e9, nextId: app === 'radarr' ? 11 : 21 };
  st.server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/^\/api\/v3/, '');
    let body = '';
    for await (const c of req) body += c;
    const send = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (st.down) return send(503, { message: 'Database is locked' });
    if (req.headers['x-api-key'] !== key) return send(401, { error: 'Unauthorized' });
    const json = JSON.parse(body || 'null');
    if (req.method !== 'GET') st.sent.push({ method: req.method, path: p, body: json });
    if (p === '/system/status') return send(200, { appName: app === 'radarr' ? 'Radarr' : 'Sonarr', version: app === 'radarr' ? '5.14.0.9383' : '4.0.20.3014' });
    if (p === '/qualityprofile') return send(200, PROFILES);
    if (p === '/rootfolder') return send(200, [{ id: 1, path: rootFolder, freeSpace: st.freeSpace, accessible: true }, { id: 2, path: 'E:\\Elsewhere', freeSpace: 1e12, accessible: true }]);
    if (p === '/queue') return send(200, { page: 1, totalRecords: st.queue.length, records: st.queue });
    if (p === '/command') return send(201, { id: 1, name: json.name, status: 'queued' });
    if (p === '/calendar') { st.calendarQuery = Object.fromEntries(url.searchParams); return send(200, st.calendar); }
    // Radarr
    if (p === '/movie' && req.method === 'GET') return send(200, Object.values(st.items).filter((m) => m.tmdbId === Number(url.searchParams.get('tmdbId'))));
    if (p === '/movie/lookup/tmdb') {
      const id = Number(url.searchParams.get('tmdbId'));
      const have = Object.values(st.items).find((m) => m.tmdbId === id);
      return send(200, have || { title: id === 603 ? 'The Matrix' : 'Something', tmdbId: id, year: 1999, images: [] });
    }
    if (p === '/movie' && req.method === 'POST') { const m = { ...json, id: st.nextId++, hasFile: false, isAvailable: true }; st.items[m.id] = m; return send(201, m); }
    // Sonarr
    if (p === '/series' && req.method === 'GET') return send(200, Object.values(st.items).filter((s) => s.tvdbId === Number(url.searchParams.get('tvdbId'))));
    if (p === '/series/lookup') {
      if (url.searchParams.get('term') !== 'tvdb:81189') return send(200, []);
      const have = Object.values(st.items).find((s) => s.tvdbId === 81189);
      return send(200, [have || BREAKING_BAD]);
    }
    if (p === '/series' && req.method === 'POST') {
      // (Sonarr works out which seasons to watch from addOptions.monitor.)
      const first = json.addOptions?.monitor === 'firstSeason';
      const seasons = (json.seasons || BREAKING_BAD.seasons).map((x) => ({ ...x, monitored: json.addOptions?.monitor === 'all' || (first && x.seasonNumber === 1) || (json.addOptions?.monitor !== 'none' && !!x.monitored),
        statistics: { episodeFileCount: 0, episodeCount: 7 } }));
      const s = { ...json, seasons, id: st.nextId++, status: 'ended', statistics: { episodeFileCount: 0, episodeCount: seasons.filter((x) => x.monitored).length * 7, percentOfEpisodes: 0 } };
      st.items[s.id] = s;
      return send(201, s);
    }
    const one = /^\/(movie|series)\/(\d+)$/.exec(p);
    if (one && req.method === 'PUT') { st.items[one[2]] = { ...st.items[one[2]], ...json }; return send(202, st.items[one[2]]); }
    if (one) return st.items[one[2]] ? send(200, st.items[one[2]]) : send(404, { message: 'NotFound' });
    send(404, { message: 'NotFound' });
  });
  return st;
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', r));
const urlOf = (server) => `http://127.0.0.1:${server.address().port}`;

module.exports = { fakeArr, PROFILES, listen, urlOf };
