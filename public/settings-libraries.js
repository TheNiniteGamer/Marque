'use strict';
/* Marquee web client — the add / edit library form and the folder picker (also used for backups and
   converted copies). Helpers from app.js are used only when called. */

function showLibraryForm(lib = null) {
  const slot = $('#lib-form-slot');
  const paths = lib ? [...lib.paths] : [''];
  const draw = () => {
    slot.innerHTML = html`
      <form class="panel form" id="lib-form" style="max-width:none">
        <h2>${lib ? `Edit ${lib.name}` : 'Add library'}</h2>
        <div class="row" style="align-items:flex-end">
          <label style="flex:1;min-width:200px">Type
            <select name="type" ${lib ? 'disabled' : ''}>
              <option value="movie" ${lib?.type === 'movie' ? 'selected' : ''}>Movies</option>
              <option value="show" ${lib?.type === 'show' ? 'selected' : ''}>TV Shows</option>
            </select>
          </label>
          <label style="flex:2;min-width:200px">Name
            <input class="input" name="name" required value="${lib?.name || ''}" placeholder="Movies">
          </label>
        </div>
        <label>Folders
          ${paths.map((p, i) => html`<div class="path-row">
            <input class="input" data-path="${i}" value="${p}" placeholder="/path/to/media">
            <button type="button" class="btn small" data-browse="${i}">Browse…</button>
            ${paths.length > 1 ? html`<button type="button" class="btn small danger" data-rm="${i}" aria-label="Remove folder">✕</button>` : ''}
          </div>`)}
        </label>
        <div class="row"><button type="button" class="btn small" id="add-path">＋ Add another folder</button>
          <span class="muted" style="font-size:13px">A library can combine folders from several drives — they show up as one collection. Folders inside the ones you pick are searched too.</span></div>
        <p class="muted" style="margin:0;font-size:13px">Movies: <code>Movie Name (Year).mkv</code> or <code>Movie Name (Year)/file.mkv</code>.
          TV: <code>Show Name/Season 01/Show Name - S01E01.mkv</code> — shows can also sit in folders of their own, like <code>Kids/Bluey/Season 1/…</code>.</p>
        <div class="form-error" id="form-error"></div>
        <div class="row"><button class="btn primary" type="submit">${lib ? 'Save' : 'Add library'}</button><button class="btn" type="button" id="cancel-form">Cancel</button></div>
      </form>`.s;
    const form = $('#lib-form');
    const sync = () => $$('[data-path]', form).forEach((inp) => { paths[Number(inp.dataset.path)] = inp.value; });
    const typeSel = form.elements.type, nameInp = form.elements.name;
    typeSel.onchange = () => { if (!nameInp.dataset.touched) nameInp.value = typeSel.value === 'show' ? 'TV Shows' : 'Movies'; };
    nameInp.oninput = () => { nameInp.dataset.touched = '1'; };
    if (!lib && !nameInp.value) nameInp.value = 'Movies';
    $('#add-path').onclick = () => { sync(); paths.push(''); draw(); };
    $('#cancel-form').onclick = () => { slot.innerHTML = ''; };
    form.onclick = async (e) => {
      const rm = e.target.closest('[data-rm]');
      if (rm) { sync(); paths.splice(Number(rm.dataset.rm), 1); draw(); return; }
      const br = e.target.closest('[data-browse]');
      if (br) {
        sync();
        const i = Number(br.dataset.browse);
        const picked = await pickFolder(paths[i] || undefined);
        if (picked) { paths[i] = picked; const keepName = nameInp.value, keepType = typeSel.value; draw(); $('#lib-form').elements.name.value = keepName; $('#lib-form').elements.type.value = keepType; }
      }
    };
    form.onsubmit = async (e) => {
      e.preventDefault(); sync();
      const body = { name: nameInp.value, paths: paths.filter((p) => p.trim()) };
      if (!lib) body.type = typeSel.value;
      try {
        if (lib) await api(`/api/libraries/${lib.id}`, { method: 'PATCH', body });
        else await api('/api/libraries', { method: 'POST', body });
        toast(lib ? 'Library updated' : 'Library added — scanning now');
        await refreshLibraries(); pollStatus();
        history.replaceState(null, '', '#/settings/libraries'); router();
      } catch (err) { $('#form-error').textContent = err.message; }
    };
    nameInp.focus();
  };
  draw();
  slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Folder picker: drives and shared folders on the left, the folder's subfolders on the right, and a
// count of the videos a library would find in it (subfolders included).
function pickFolder(start) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    let cur = null, previewFor = null;
    const close = (val) => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); resolve(val); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    const showPreview = async (p) => {
      previewFor = p;
      const el = $('#pick-preview');
      el.textContent = 'Looking for videos in this folder and the folders inside it…';
      try {
        const r = await api(`/api/fs/preview?path=${encodeURIComponent(p)}`);
        if (previewFor !== p || !$('#pick-preview')) return;
        const inside = r.folders ? ` and the ${r.folders} folder${r.folders === 1 ? '' : 's'} inside it` : '';
        el.innerHTML = r.videos
          ? html`<b>${r.partial ? 'At least ' : ''}${r.videos} video${r.videos === 1 ? '' : 's'}</b> in this folder${inside} — a library made from it gets all of them.
              <span class="muted" title="${r.sample.join('\n')}">e.g. ${r.sample.slice(0, 2).join(', ')}</span>`.s
          : html`No videos here${r.folders ? ` or in the ${r.folders} folder${r.folders === 1 ? '' : 's'} inside it` : ''}${r.partial ? ' (stopped looking — this folder is very large)' : ''}.`.s;
      } catch { if (previewFor === p && $('#pick-preview')) el.textContent = ''; }
    };
    const load = async (p) => {
      try { cur = await api(`/api/fs${p ? `?path=${encodeURIComponent(p)}` : ''}`); }
      catch (err) { toast(err.message, true); if (!cur) cur = await api('/api/fs'); else return; }
      const inPlace = (pl) => cur.path === pl.path || cur.path.startsWith(pl.path.replace(/[\\/]$/, '') + (pl.path.includes('\\') ? '\\' : '/'));
      // Only the closest one is highlighted (a drive can sit inside the media folder).
      const here = (cur.places || []).filter(inPlace).sort((a, b) => b.path.length - a.path.length)[0];
      root.innerHTML = html`
        <div class="modal-backdrop" id="mb">
          <div class="modal wide" role="dialog" aria-label="Choose a folder">
            <header><h2>Choose a folder</h2>
              <form id="pick-go" class="row" style="margin-top:8px"><input class="input" id="pick-path" style="flex:1" value="${cur.label || cur.path}" aria-label="Folder path" spellcheck="false"><button class="btn small">Go</button></form>
              ${cur.label ? html`<div class="cwd muted">${cur.path}</div>` : ''}</header>
            <div class="modal-body picker">
              <nav class="places" aria-label="Drives and folders">
                <div class="muted places-head">Drives & folders</div>
                ${(cur.places || []).map((pl) => html`<button data-dir="${pl.path}" class="${pl === here ? 'on' : ''}" title="${pl.path}">${/drive$/.test(pl.label) ? '💽' : pl.label === 'Home folder' ? '🏠' : '📁'} ${pl.label}</button>`)}
              </nav>
              <div class="dir-list">
                ${cur.parent ? html`<button data-dir="${cur.parent}">⬆ ..</button>` : ''}
                ${cur.dirs.map((d) => html`<button data-dir="${cur.path.replace(/[\\/]$/, '')}${cur.path.includes('\\') ? '\\' : '/'}${d}">📁 ${d}${cur.labels?.[d] ? html` <span class="muted">— ${cur.labels[d]}</span>` : ''}</button>`)}
                ${cur.dirs.length ? '' : html`<div class="muted" style="padding:12px">No folders inside this one</div>`}
              </div>
            </div>
            <div class="pick-preview" id="pick-preview" aria-live="polite"></div>
            <footer><span class="muted pick-hint">Missing a drive? See “Other drives” in the README.</span>
              <button class="btn" id="pick-cancel">Cancel</button><button class="btn primary" id="pick-ok">Select this folder</button></footer>
          </div>
        </div>`.s;
      $('#mb').onclick = (e) => {
        if (e.target.id === 'mb' || e.target.id === 'pick-cancel') return close(null);
        if (e.target.id === 'pick-ok') return close(cur.path);
        const d = e.target.closest('[data-dir]'); if (d) load(d.dataset.dir);
      };
      $('#pick-go').onsubmit = (e) => { e.preventDefault(); load($('#pick-path').value.trim()); };
      showPreview(cur.path);
    };
    load(start);
  });
}
