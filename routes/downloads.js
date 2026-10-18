'use strict';
// The YouTube downloader.
// Registered by server.js, which passes the shared helpers and services in `app`.

module.exports = function register(app) {
  const {
    canSeeLibrary, store, downloader, HttpError, json, readBody, route,
  } = app;

  // --- downloads (yt-dlp) ---
  const jobView = (j) => ({ ...j, dest: undefined });
  const ownJobs = (user) => downloader.jobs.filter((j) => user.role === 'admin' || j.userId === user.id);
  function getJob(id, user) {
    const job = ownJobs(user).find((j) => j.id === id);
    if (!job) throw new HttpError(404, 'Download not found');
    return job;
  }

  route('GET', '/api/downloads', async (req, res, p, url, user) => json(res, 200, {
    ...downloader.status(),
    targets: store.data.libraries.filter((l) => l.type === 'movie' && canSeeLibrary(user, l.id)).map((l) => ({ id: l.id, name: l.name })),
    jobs: ownJobs(user).map(jobView),
  }), 'download');

  route('POST', '/api/downloads', async (req, res, p, url, user) => {
    const body = await readBody(req);
    if (!canSeeLibrary(user, body.libraryId)) throw new HttpError(400, 'Choose a library to save into');
    json(res, 201, jobView(downloader.add(body, user)));
  }, 'download');

  route('POST', '/api/downloads/:id/cancel', async (req, res, { id }, url, user) => { getJob(id, user); json(res, 200, jobView(downloader.cancel(id))); }, 'download');
  route('POST', '/api/downloads/:id/retry', async (req, res, { id }, url, user) => { getJob(id, user); json(res, 200, jobView(downloader.retry(id))); }, 'download');
  route('DELETE', '/api/downloads/:id', async (req, res, { id }, url, user) => { getJob(id, user); downloader.remove(id); json(res, 200, { ok: true }); }, 'download');
  route('POST', '/api/downloads/update-tool', async (req, res) => json(res, 200, await downloader.selfUpdate()), 'admin');
};
