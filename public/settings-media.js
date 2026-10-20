'use strict';
/* Marquee web client — settings panels about the media: metadata, playback (converting, casting,
   skip intro) and the problem finder. Helpers from app.js are used only when called. */

// ---------- Settings → Metadata ----------
const LANGUAGES = [['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['es-ES', 'Español'], ['es-MX', 'Español (México)'],
  ['fr-FR', 'Français'], ['de-DE', 'Deutsch'], ['it-IT', 'Italiano'], ['pt-BR', 'Português (Brasil)'], ['pt-PT', 'Português'],
  ['nl-NL', 'Nederlands'], ['sv-SE', 'Svenska'], ['da-DK', 'Dansk'], ['nb-NO', 'Norsk'], ['fi-FI', 'Suomi'], ['pl-PL', 'Polski'],
  ['ru-RU', 'Русский'], ['tr-TR', 'Türkçe'], ['ja-JP', '日本語'], ['ko-KR', '한국어'], ['zh-CN', '中文'], ['hi-IN', 'हिन्दी'], ['ar-SA', 'العربية']];

// A short "What's this?" that opens to the longer explanation (so pages stay calm).
const helpText = (body, summary = 'What’s this?') => html`<details class="help"><summary>${summary}</summary><div>${body}</div></details>`;

function metadataSection(st, { heading = true } = {}) {
  const keyStatus = st.tmdbKeySet ? html`Saved (${st.tmdbKeyHint})` : st.tmdbKeyFromEnv ? 'Set by the server configuration' : html`<span style="color:var(--danger)">Not set</span> — movies can't be looked up online`;
  const tmdbDone = st.tmdbKeySet || st.tmdbKeyFromEnv;
  return html`
    ${heading ? html`<h2 style="margin:28px 0 12px">Metadata</h2>` : ''}
    <div class="panel form" id="meta-settings" style="max-width:none">
      <div class="meta-sources">
        ${st.providers.map((p) => html`<div class="source ${p.enabled ? 'on' : ''}"><b>${p.name}</b>
          <span class="muted">${p.kinds.includes('movie') ? 'Movies & TV' : 'TV shows'} · ${p.enabled ? 'Active' : p.id === 'tmdb' ? 'Needs API key' : 'Off'}</span></div>`)}
      </div>
      ${tmdbDone ? html`<div class="row setup-done"><span>✓ TMDB connected <span class="muted">${st.tmdbKeyHint || '(set by the server configuration)'}</span></span>
        <button type="button" class="btn small" data-reveal="tmdb-edit">Change</button></div>` : ''}
      <label id="tmdb-edit" ${tmdbDone ? raw('hidden') : ''}>TMDB API key <span class="muted" style="font-weight:400">— ${keyStatus}</span>
        <div class="row">
          <input class="input" id="tmdb-key" type="password" autocomplete="off" placeholder="${st.tmdbKeySet ? 'Paste a new key to replace it' : 'Paste your TMDB API key (v3)'}" style="flex:1;min-width:220px">
          <button class="btn small" id="tmdb-save">Save key</button>
          ${st.tmdbKeySet ? html`<button class="btn small danger" id="tmdb-remove">Remove</button>` : ''}
        </div>
        ${helpText(html`Free: create an account at <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">themoviedb.org → Settings → API</a> and copy the “API Key”. TMDB gives posters, summaries, cast and ratings for films and shows.`, 'Where do I get one?')}
      </label>
      <div class="row" style="align-items:flex-end">
        <label style="min-width:220px">Language for titles and summaries
          <select id="meta-lang">${LANGUAGES.map(([c, n]) => html`<option value="${c}" ${st.language === c ? 'selected' : ''}>${n}</option>`)}
            ${LANGUAGES.some(([c]) => c === st.language) ? '' : html`<option value="${st.language}" selected>${st.language}</option>`}</select></label>
        <label class="check" style="margin-bottom:8px"><input type="checkbox" id="meta-auto" ${st.autoMatch ? 'checked' : ''}> Match new items automatically when scanning</label>
      </div>
      <div class="row"><button class="btn small" id="meta-refresh-all">↻ Refresh metadata for all libraries</button>
        <span class="muted" style="font-size:13px">Your own edits are always kept.</span></div>
      <h3 style="margin:12px 0 0">Subtitles from OpenSubtitles.com</h3>
      ${helpText(html`Lets everyone search for missing subtitles from the player (Subtitles → Search online…).
        Get a free API key at <a href="https://www.opensubtitles.com/en/consumers" target="_blank" rel="noopener">opensubtitles.com → API consumers</a>.
        Without an OpenSubtitles account only a few downloads a day are allowed; signing in raises the limit.`)}
      ${st.opensubtitles.keySet ? html`<div class="row setup-done"><span>✓ OpenSubtitles connected <span class="muted">${st.opensubtitles.keyHint}${st.opensubtitles.username ? ` · signed in as ${st.opensubtitles.username}` : ''}</span></span>
        <button type="button" class="btn small" data-reveal="os-edit">Change</button>
        <button type="button" class="btn small danger" id="os-remove">Remove</button></div>` : ''}
      <div id="os-edit" ${st.opensubtitles.keySet ? raw('hidden') : ''}>
      <div class="row">
        <label style="flex:1;min-width:200px">API key ${st.opensubtitles.keySet ? html`<span class="muted" style="font-weight:400">— saved (${st.opensubtitles.keyHint})</span>` : ''}
          <input class="input" id="os-key" type="password" autocomplete="off" placeholder="${st.opensubtitles.keySet ? 'Paste a new key to replace it' : 'API key'}"></label>
        <label style="min-width:150px">Account (optional)<input class="input" id="os-user" autocomplete="off" value="${st.opensubtitles.username}" placeholder="Username"></label>
        <label style="min-width:150px">Password<input class="input" id="os-pass" type="password" autocomplete="new-password" placeholder="${st.opensubtitles.username ? 'Unchanged' : ''}"></label>
      </div>
      <div class="row"><button class="btn small" id="os-save">Save</button></div>
      </div>
    </div>`;
}

function bindMetadataSection() {
  const patch = async (body, msg) => {
    try { await api('/api/settings', { method: 'PATCH', body }); toast(msg); router(); } catch (err) { toast(err.message, true); }
  };
  $('#os-save').onclick = (e) => {
    const o = { username: $('#os-user').value.trim() };
    if ($('#os-key').value.trim()) o.apiKey = $('#os-key').value.trim();
    if ($('#os-pass').value) o.password = $('#os-pass').value;
    e.target.disabled = true;
    patch({ opensubtitles: o }, 'OpenSubtitles settings saved');
  };
  if ($('#os-remove')) $('#os-remove').onclick = () => patch({ opensubtitles: { apiKey: '' } }, 'Removed');
  $('#tmdb-save').onclick = async (e) => {
    const key = $('#tmdb-key').value.trim();
    if (!key) return toast('Paste a key first', true);
    e.target.disabled = true; e.target.textContent = 'Checking…';
    await patch({ tmdbKey: key }, 'TMDB key saved — use “Refresh metadata” to look up your movies');
    e.target.disabled = false; e.target.textContent = 'Save key';
  };
  if ($('#tmdb-remove')) $('#tmdb-remove').onclick = () => confirm('Remove the TMDB key?') && patch({ tmdbKey: '' }, 'Key removed');
  $('#meta-lang').onchange = (e) => patch({ language: e.target.value }, 'Language saved — refresh metadata to apply it');
  $('#meta-auto').onchange = (e) => patch({ autoMatch: e.target.checked }, e.target.checked ? 'Automatic matching on' : 'Automatic matching off');
  $('#meta-refresh-all').onclick = async () => {
    for (const l of state.libraries) await api(`/api/libraries/${l.id}/scan`, { method: 'POST', body: { refreshMetadata: true } });
    toast('Refreshing metadata…');
    pollStatus();
  };
}

// ---------- settings: transcoding, casting and skip intro ----------
function transcodingSection(t, intro, settings) {
  const why = t.results.filter((r) => !r.ok);
  return html`
    <h2 style="margin:28px 0 12px" id="transcoding">Transcoding &amp; streaming</h2>
    <div class="panel form" style="max-width:none" id="tc-panel">
      <div class="upd-state ${t.active !== 'software' ? 'ok' : ''}">${t.checking ? 'Checking graphics cards…' : html`Converting video with: <b>${t.activeName}</b>`}</div>
      ${t.active === 'nvdec' ? html`<div class="muted" style="font-size:13px">The graphics card also decodes and resizes
        ${(t.results.find((r) => r.kind === 'nvdec')?.codecs || []).map((c) => ({ h264: 'H.264', hevc: 'HEVC', vp9: 'VP9', av1: 'AV1', mpeg2video: 'MPEG-2', vc1: 'VC-1' })[c] || c).join(', ')} video,
        so the CPU is left almost free (HDR colours are still mapped on the CPU, after resizing).</div>` : ''}
      <label>Video converter
        <select id="tc-hw">${t.options.map((o) => html`<option value="${o.id}" ${o.id === t.setting ? 'selected' : ''}>${o.name}</option>`)}</select></label>
      ${why.length ? html`<details class="muted" style="font-size:13px"><summary>Why isn't a graphics card being used?</summary>
        <ul>${why.map((r) => html`<li><b>${r.name}:</b> ${r.error}</li>`)}</ul>
        <div>A graphics card has to be passed through to Docker first: set <code>GPU=nvidia</code> (or <code>intel</code> / <code>amd</code> on Linux hosts) in the <code>.env</code> file and run <b>start-marquee.bat</b> again. See the README.</div></details>` : ''}
      <div class="row"><button class="btn small" id="tc-test">Test again</button>
        <span class="muted" style="font-size:13px">Videos your browser can already play are never converted.</span></div>
      <div class="muted" style="font-size:13px">${t.toneMapping
        ? '✓ HDR films and shows (HDR10, HLG) are converted to normal colours when they need converting, so they don’t look washed out.'
        : 'This server’s ffmpeg can’t convert HDR colours (it has no zscale filter): HDR films look washed out when converted. The Docker version can.'}</div>
      <label>Maximum quality away from home
        <select id="tc-remote">${[['', 'No limit'], ['1080p', '1080p (about 8 Mbps)'], ['720p', '720p (about 4 Mbps)'], ['480p', '480p (about 1.5 Mbps)'], ['360p', '360p (under 1 Mbps)']]
          .map(([v, l]) => html`<option value="${v}" ${t.remoteMaxQuality === v ? 'selected' : ''}>${l}</option>`)}</select></label>
      ${helpText('For people watching through Tailscale, Cloudflare or from outside your network, so one viewer can’t use up your home internet’s upload. Videos are converted down to this quality; at home nothing changes.')}
      <label>Address for cast devices <span class="muted" style="font-weight:400">(optional)</span>
        <input class="input" id="tc-cast" placeholder="${t.castUrlFromEnv || 'e.g. http://192.168.1.20:32500'}" value="${t.castUrl}"></label>
      ${helpText(html`Chromecasts and TVs fetch the video from Marquee themselves, so they need an address that works on your network:
        this PC's IP address and port. Only needed when you open Marquee as “localhost”. Casting works from Chrome or Edge on pages opened as <code>localhost</code> or over HTTPS.`)}
      <div class="row"><button class="btn small primary" id="tc-save-cast">Save address</button></div>
    </div>
    <h2 style="margin:28px 0 12px" id="intro">Skip intro</h2>
    <div class="panel form" style="max-width:none">
      <label class="check"><input type="checkbox" id="intro-on" ${settings.introDetection ? 'checked' : ''}> Find TV show intros, recaps and credits automatically after scans</label>
      <div class="muted" style="font-size:14px">${intro.running && intro.current
        ? `Looking at ${intro.current.show}, season ${intro.current.season} (${intro.current.done}/${intro.current.total})${intro.queued ? ` · ${intro.queued} more season(s) waiting` : ''}…`
        : `${intro.found} of ${intro.episodes} episodes have a detected intro${intro.recapsFound ? `, ${intro.recapsFound} a recap` : ''} (${intro.checked} checked).`}</div>
      ${helpText('Episodes in the same season are compared to find the theme song they share, and recaps (“previously on…”) made of clips from the episodes before.', 'How does it work?')}
      <div class="row"><button class="btn small" id="intro-run">Find intros now</button><button class="btn small" id="intro-redo">Redo all</button></div>
    </div>`;
}

function bindTranscodingSection() {
  const save = async (body, msg) => {
    try { await api('/api/transcoding', { method: 'PATCH', body }); toast(msg); } catch (err) { toast(err.message, true); }
    router();
  };
  $('#tc-hw').onchange = (e) => { e.target.disabled = true; toast('Testing…'); save({ hwaccel: e.target.value }, 'Saved'); };
  $('#tc-test').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Testing…';
    try { const r = await api('/api/transcoding/test', { method: 'POST' }); toast(`Using: ${r.activeName}`); } catch (err) { toast(err.message, true); }
    router();
  };
  $('#tc-save-cast').onclick = () => save({ castUrl: $('#tc-cast').value }, 'Saved');
  $('#tc-remote').onchange = (e) => save({ remoteMaxQuality: e.target.value }, 'Saved');
  $('#intro-on').onchange = async (e) => {
    try { await api('/api/settings', { method: 'PATCH', body: { introDetection: e.target.checked } }); toast('Saved'); } catch (err) { toast(err.message, true); }
  };
  const run = (force) => async () => {
    if (force && !confirm('Look for intros in every episode again? This can take a while for big libraries.')) return;
    try { await api('/api/intro/detect', { method: 'POST', body: { force } }); toast('Looking for intros…'); } catch (err) { toast(err.message, true); }
    setTimeout(router, 1500);
  };
  $('#intro-run').onclick = run(false);
  $('#intro-redo').onclick = run(true);
}

// ---------- settings: problem finder ----------
function problemsSection(p) {
  const link = (x) => html`<a href="#/${x.type === 'show' ? 'show' : 'item'}/${x.id}">${x.title}</a>`;
  const where = (x) => (x.file ? html` <span class="muted path-inner">${x.file}</span>` : '');
  const yr = (y) => (y ? ` (${y})` : '');
  const groups = [
    { key: 'offline', title: 'Folders that are offline or missing', items: p.offline,
      row: (x) => html`<li><b>${x.library}</b>: <code>${x.path}</code></li>`,
      help: 'A drive is unplugged or a folder was moved. Its titles and watch history are kept until it comes back.' },
    { key: 'unreadable', title: 'Files that can’t be read', items: p.unreadable,
      row: (x) => html`<li>${link(x)}${where(x)}</li>`, help: 'ffprobe couldn’t open these. They may be damaged or still copying.' },
    { key: 'review', title: 'Matches that need a check', items: p.review || [], open: true,
      row: (x) => html`<li class="review-row">
        <div><b>${x.name}${yr(x.year)}</b> <span class="muted">· ${x.library}${x.duration >= 60 ? ` · ${Math.round(x.duration / 60)} min` : ''}</span>${where(x)}</div>
        <div class="review-now">${x.current
          ? html`Now: ${link(x)}${yr(x.current.year)} <span class="muted">(${x.current.score != null ? `${x.current.score}% sure` : 'not sure'})</span>
              <button class="btn small" data-review-ok="${x.id}">✓ It's right</button>`
          : html`<span class="muted">Not matched — no result was close enough.</span>`}</div>
        ${x.candidates.length ? html`<div class="review-cands">${x.candidates.map((c) => html`
          <button class="review-cand" data-review-pick="${x.id}" data-provider="${c.provider}" data-pid="${c.id}" title="Use ${c.title}${yr(c.year)}">
            ${c.thumb ? html`<img src="${c.thumb}" alt="" loading="lazy">` : html`<span class="review-noimg">?</span>`}
            <span>${c.title}${yr(c.year)}<br><span class="muted">${c.score}% · ${c.provider === 'tvmaze' ? 'TVmaze' : 'TMDB'}</span></span></button>`)}</div>` : ''}
        <div class="review-more"><button class="link-btn" data-fix-match="${x.id}">Search…</button> · <button class="link-btn" data-review-none="${x.id}">Don't match it</button></div>
      </li>`,
      help: 'Marquee wasn’t sure about these. Pick the right one, confirm the current match, or search. Titles renamed with an id, like “Heat (1995) {tmdb-949}”, always match exactly.' },
    { key: 'unmatched', title: 'No online match', items: p.unmatched,
      row: (x) => html`<li>${link(x)} <button class="link-btn" data-fix-match="${x.id}">Find a match…</button></li>`,
      help: 'No poster or details were found. Renaming the file as “Title (Year)”, or Find a match, usually fixes it.' },
    { key: 'duplicates', title: 'Duplicates', items: p.duplicates,
      row: (g) => html`<li><b>${g.title}</b> — ${g.copies.length} copies<ul>${g.copies.map((x) => html`<li>${link(x)} <span class="muted">(${x.library})</span>${where(x)}</li>`)}</ul></li>`,
      help: 'The same episode more than once. (Several copies of a film are fine: they show as one title with a choice of versions.)' },
    { key: 'missing', title: 'Missing episodes', items: p.missingEpisodes,
      row: (s) => html`<li><a href="#/show/${s.showId}?season=${s.season}">${s.show}</a>, season ${s.season}: episode${s.missing.length === 1 ? '' : 's'} ${s.missing.join(', ')}</li>`,
      help: 'Gaps in episode numbers, up to the last episode you have.' },
  ];
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const r = p.recheck, last = p.lastRecheck;
  return html`
    <h2 style="margin:28px 0 12px" id="problems">Library problems</h2>
    <div class="panel problems">
      <div class="upd-state ${total ? '' : 'ok'}">${total ? `${total} thing${total === 1 ? '' : 's'} to look at` : '✓ No problems found'}</div>
      <div class="row recheck-row"><span class="muted">Re-check matches:</span>
        ${state.libraries.map((l) => html`<button class="btn small" data-recheck="${l.id}" ${r ? 'disabled' : ''} title="Look up every automatic match in ${l.name} again with the current rules (matches you picked or confirmed are kept)">${l.name}</button>`)}
        <span class="muted" style="font-size:13px">${r ? `Checking ${r.library}: ${r.done} of ${r.total}…`
          : last ? `Last check (${last.library}): ${last.total} title${last.total === 1 ? '' : 's'}, ${last.changed} changed, ${last.review} to look at.` : ''}</span></div>
      ${groups.filter((g) => g.items.length).map((g) => html`<details ${g.open ? 'open' : ''}>
        <summary><b>${g.title}</b> <span class="muted">(${g.items.length})</span></summary>
        <p class="muted" style="font-size:13px;margin:6px 0">${g.help}</p>
        <ul>${g.items.slice(0, 200).map(g.row)}</ul>${g.items.length > 200 ? html`<p class="muted">…and ${g.items.length - 200} more.</p>` : ''}
      </details>`)}
    </div>`;
}

// Redraw the problems panel (after fixing something there, and while a re-check runs).
let problemsTimer = null;
async function refreshProblems() {
  clearTimeout(problemsTimer);
  const wrap = $('#problems-wrap');
  if (!wrap) return;
  const p = await api('/api/problems');
  const open = new Set($$('details[open] summary b', wrap).map((b) => b.textContent));
  wrap.innerHTML = problemsSection(p).s;
  for (const d of $$('details', wrap)) if (open.has($('summary b', d).textContent)) d.open = true;
  if (p.recheck) problemsTimer = setTimeout(refreshProblems, 2000);
}
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-review-ok], [data-review-pick], [data-review-none], [data-recheck]');
  if (!t) return;
  const inPanel = !!t.closest('#problems-wrap');
  const after = (msg) => { toast(msg); if (inPanel) refreshProblems(); else router(); };
  try {
    if (t.dataset.reviewOk) { await api(`/api/meta/${t.dataset.reviewOk}/confirm`, { method: 'POST' }); after('Match confirmed'); }
    if (t.dataset.reviewPick) {
      t.disabled = true;
      await api(`/api/meta/${t.dataset.reviewPick}/match`, { method: 'POST', body: { provider: t.dataset.provider, id: t.dataset.pid } });
      after('Match changed');
    }
    if (t.dataset.reviewNone) { await api(`/api/meta/${t.dataset.reviewNone}/unmatch`, { method: 'POST' }); after('Left unmatched (it uses the file name)'); }
    if (t.dataset.recheck) {
      const lib = state.libraries.find((l) => l.id === t.dataset.recheck);
      if (!confirm(`Look up every automatic match in ${lib?.name} again? Matches you picked or confirmed are kept; anything doubtful is listed under “Matches that need a check”.`)) return;
      await api(`/api/libraries/${t.dataset.recheck}/recheck-matches`, { method: 'POST' });
      refreshProblems();
    }
  } catch (err) { t.disabled = false; toast(err.message, true); }
});
