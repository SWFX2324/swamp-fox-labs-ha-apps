'use strict';
// Print Log page. Everything shown comes from api/state; every piece of text
// from Home Assistant or the printer goes through esc() before it reaches the
// page. Actions (Pause, Resume, Stop, Start, sending a file) are POSTs the
// app re-checks before it does anything.
(() => {
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const dash = '—';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* optional */ } },
  };

  // ---- theme ----------------------------------------------------------------------
  const THEMES = ['auto', 'light', 'dark'];
  const THEME_ICONS = {
    auto: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 18V4a8 8 0 0 1 0 16',
    light: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10M2 13h2a1 1 0 0 0 0-2H2a1 1 0 0 0 0 2m18 0h2a1 1 0 0 0 0-2h-2a1 1 0 0 0 0 2M11 2v2a1 1 0 0 0 2 0V2a1 1 0 0 0-2 0m0 18v2a1 1 0 0 0 2 0v-2a1 1 0 0 0-2 0M5.99 4.58a1 1 0 0 0-1.41 1.41l1.06 1.06a1 1 0 0 0 1.41-1.41zm12.37 12.37a1 1 0 0 0-1.41 1.41l1.06 1.06a1 1 0 0 0 1.41-1.41zm1.06-10.96a1 1 0 0 0-1.41-1.41l-1.06 1.06a1 1 0 0 0 1.41 1.41zM7.05 18.36a1 1 0 0 0-1.41-1.41l-1.06 1.06a1 1 0 0 0 1.41 1.41z',
    dark: 'M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1',
  };
  let theme = THEMES.includes(store.get('pl-theme')) ? store.get('pl-theme') : 'auto';
  function applyTheme() {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = theme;
    const label = `Appearance: ${theme === 'auto' ? 'automatic' : theme}`;
    $('theme').title = label;
    $('theme').setAttribute('aria-label', label);
    $('theme').querySelector('path').setAttribute('d', THEME_ICONS[theme]);
  }
  $('theme').onclick = () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]; store.set('pl-theme', theme); applyTheme(); };
  applyTheme();

  // ---- formatting ---------------------------------------------------------------------
  let snap = null, sel = store.get('pl-printer'), filter = store.get('pl-filter') || 'all', showN = 25;
  let files = { serial: null, list: null, error: null, at: 0, loading: false };
  const tz = () => snap?.timeZone || undefined;
  const fmt = (t, o) => { try { return new Intl.DateTimeFormat(undefined, { timeZone: tz(), ...o }).format(new Date(t)); } catch { return new Date(t).toLocaleString(); } };
  const dayKey = t => fmt(t, { year: 'numeric', month: '2-digit', day: '2-digit' });
  function when(t) {
    if (!t) return dash;
    const today = dayKey(Date.now()), yest = dayKey(Date.now() - 864e5), d = dayKey(t);
    const time = fmt(t, { hour: 'numeric', minute: '2-digit' });
    if (d === today) return `Today ${time}`;
    if (d === yest) return `Yesterday ${time}`;
    return `${fmt(t, { month: 'short', day: 'numeric' })}, ${time}`;
  }
  const clock = t => fmt(t, { hour: 'numeric', minute: '2-digit' });
  function dur(sec) {
    if (!isNum(sec)) return dash;
    const m = Math.round(sec / 60);
    if (m < 60) return `${m} m`;
    return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`;
  }
  const grams = g => !isNum(g) ? dash : g >= 1000 ? `${(g / 1000).toFixed(2)} kg` : `${g >= 100 ? Math.round(g) : (Math.round(g * 10) / 10)} g`;
  const size = b => !isNum(b) ? dash : b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(b > 10485760 ? 0 : 1)} MB`;
  const money = v => !isNum(v) ? dash : `$${v.toFixed(2)}`;
  const color = c => /^#[0-9A-F]{6}$/i.test(String(c || '')) ? c : null;
  const sw = c => color(c) ? `--sc:${color(c)}` : '';
  const stem = n => String(n || '').replace(/\.gcode\.3mf$|\.3mf$/i, '').toLowerCase();
  const nice = s => String(s || '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
  const empty = (text, problem = false) => `<div class="empty${problem ? ' problem' : ''}">${esc(text)}</div>`;
  const ICON = {
    pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
    resume: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L8.5 4.64A1 1 0 0 0 7 5.5z"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
    cube: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 15V4M7 9l5-5 5 5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17.65 6.35A8 8 0 1 0 19.73 14h-2.08A6 6 0 1 1 12 6a5.9 5.9 0 0 1 4.22 1.78L13 11h7V4z"/></svg>',
  };
  const thumbImg = id => /^[0-9a-f]{24}$/.test(id || '') ? `<img src="api/thumb/${id}.png" alt="" loading="lazy">` : ICON.cube;
  const RESULT = { finished: ['good', 'Finished'], failed: ['bad', 'Failed'], stopped: ['warn', 'Stopped'], running: ['run', 'Printing'] };

  const printer = () => snap?.printers?.find(p => p.serial === sel) || snap?.printers?.[0] || null;
  const q = p => `printer=${encodeURIComponent(p.serial)}`;

  // ---- toast and dialogs ------------------------------------------------------------------
  let toastTimer;
  function toast(text, bad = false) {
    const t = $('toast');
    t.textContent = text;
    t.className = 'toast' + (bad ? ' bad' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 7000 : 3500);
  }
  let modalClose = null;
  function openModal(html, { wide = false, onClose = null } = {}) {
    $('modal-box').className = 'modal' + (wide ? ' wide' : '');
    $('modal-box').innerHTML = html;
    $('modal').hidden = false;
    modalClose = onClose;
    const f = $('modal-box').querySelector('[data-autofocus]') || $('modal-box').querySelector('button');
    f?.focus();
  }
  function closeModal() { $('modal').hidden = true; $('modal-box').innerHTML = ''; modalClose?.(); modalClose = null; }
  $('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('modal').hidden) closeModal(); });

  async function post(url, body, { type = 'application/json' } = {}) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': type }, body: type === 'application/json' ? JSON.stringify(body) : body });
    let j = {};
    try { j = await r.json(); } catch { /* not JSON */ }
    if (!r.ok) throw new Error(j.error || `The app answered HTTP ${r.status}.`);
    return j;
  }
  async function getJson(url) {
    const r = await fetch(url, { cache: 'no-store' });
    let j = {};
    try { j = await r.json(); } catch { /* not JSON */ }
    if (!r.ok) throw new Error(j.error || `The app answered HTTP ${r.status}.`);
    return j;
  }

  // ---- header ---------------------------------------------------------------------------
  function renderTop(p) {
    const list = snap.printers || [];
    $('printer-pick').hidden = list.length < 2;
    if (list.length > 1) {
      $('printer-select').innerHTML = list.map(x => `<option value="${esc(x.serial)}"${x.serial === p?.serial ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
    }
    const ctl = $('ctl');
    if (!snap.settings.allowControls) { ctl.textContent = 'View only · controls off'; ctl.style.setProperty('--c', 'var(--closed)'); }
    else if (p && p.live.buttons.stop) { ctl.textContent = 'Printer controls on'; ctl.style.setProperty('--c', 'var(--good)'); }
    else { ctl.textContent = 'Controls need LAN mode'; ctl.style.setProperty('--c', 'var(--warning)'); ctl.title = 'Turn on Developer LAN mode on the printer so it accepts Pause, Stop and Start from Home Assistant.'; }
  }
  $('printer-select').onchange = e => { sel = e.target.value; store.set('pl-printer', sel); files = { serial: null }; render(); loadFiles(); };

  // ---- live / idle ------------------------------------------------------------------------
  function controlButtons(p) {
    const c = p.controls, lv = p.live;
    if (!snap.settings.allowControls) return '';
    const b = (act, label, cls = '') => {
      const why = c[act];
      return `<button type="button" class="${cls}" data-act="${act}" ${why ? `disabled title="${esc(why)}"` : ''}>${ICON[act]}${label}</button>`;
    };
    const showResume = lv.status === 'pause';
    return (showResume ? b('resume', 'Resume', 'primary') : b('pause', 'Pause')) + b('stop', 'Stop', 'danger');
  }

  function renderLive(p) {
    const el = $('live');
    if (!p) {
      el.innerHTML = empty('No Bambu Lab printer found in Home Assistant. Add the Bambu Lab integration (from HACS) and this page fills in.');
      return;
    }
    const lv = p.live;
    const nozzleText = [lv.nozzle.size && `${lv.nozzle.size}${lv.nozzle.rightSize ? ` / ${lv.nozzle.rightSize}` : ''}`, lv.nozzle.type && nice(lv.nozzle.type).toLowerCase()].filter(Boolean).join(' ');
    const temps = [...lv.nozzles, { label: 'Bed', ...lv.bed }, { label: 'Chamber', ...lv.chamber, extra: lv.door ? `door ${lv.door}` : null }]
      .filter(t => isNum(t.now)).slice(0, 4)
      .map(t => `<div><span>${esc(t.label)}</span><b>${Math.round(t.now)}°</b> <small>${t.target ? `/ ${Math.round(t.target)}°` : esc(t.extra || 'idle')}</small></div>`).join('');
    const firstControlProblem = [p.controls.pause, p.controls.stop].find(x => x && !/^Only while/.test(x));

    const oldCam = $('cam-img');
    if (lv.printing) {
      const job = p.currentJob;
      const pct = isNum(lv.progress) ? lv.progress : 0;
      const paused = lv.status === 'pause';
      const sub = [p.name, lv.plate && `plate ${lv.plate}`, nozzleText, lv.plateType && nice(lv.plateType)].filter(Boolean).map(esc).join(' · ');
      const feed = lv.feeding ? `<span class="feeding" style="${sw(lv.feeding.color)}"><i></i>Feeding ${esc(lv.feeding.label)} · ${esc(lv.feeding.type || '')}${job?.grams ? ` · ${grams(job.grams)} of ${grams(lv.grams)}` : lv.grams ? ` · ${grams(lv.grams)} planned` : ''}</span>` : '';
      el.innerHTML = `<div class="live${lv.camera ? '' : ' no-cam'}">
        ${lv.camera ? `<div class="cam"><img id="cam-img" alt="Printer camera"><span class="tag">Camera</span></div>` : ''}
        <div>
          <div class="top">
            <div><div class="job-nm">${esc(lv.name || 'Printing')}</div><div class="job-sub">${sub}</div></div>
            <span class="pill ${paused ? 'warn' : lv.error ? 'bad' : 'run'}">${paused ? 'Paused' : lv.error ? 'Needs a look' : lv.status === 'prepare' ? 'Preparing' : 'Printing'}</span>
          </div>
          <div class="prog${paused ? ' paused' : ''}" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>
          <div class="prog-l">
            <span><b>${pct}%</b>${isNum(lv.layer) && lv.layers ? ` · layer <b>${lv.layer}</b> of ${lv.layers}` : ''}${lv.stage && lv.stage !== 'Printing' ? ` · ${esc(lv.stage)}` : ''}</span>
            <span>${isNum(lv.remainingMin) ? `<b>${dur(lv.remainingMin * 60)}</b> left` : ''}${lv.endsAt ? ` · done <b>${clock(lv.endsAt)}</b>` : ''}</span>
          </div>
          <div class="facts4">${temps}</div>
          <div class="actions">${controlButtons(p)}<span class="spacer"></span>${feed}</div>
          ${firstControlProblem && snap.settings.allowControls ? `<div class="why">${esc(firstControlProblem)}</div>` : ''}
          ${lv.hmsCount ? `<div class="why">The printer reports ${lv.hmsCount} message${lv.hmsCount > 1 ? 's' : ''} (HMS). Check its screen or the Bambu Handy app.</div>` : ''}
        </div>
      </div>`;
      const newCam = $('cam-img');
      if (oldCam && newCam && oldCam.src) newCam.replaceWith(oldCam);
      if (!camRunning) camLoop();
      return;
    }
    const last = (snap.jobs || []).find(j => j.printer === p.serial);
    const statusPill = !lv.online ? ['off', 'Offline'] : lv.error ? ['bad', 'Needs a look'] : ['off', lv.status === 'finish' ? 'Finished' : lv.status === 'failed' ? (last?.result === 'stopped' ? 'Stopped' : 'Failed') : 'Idle'];
    const facts = [
      nozzleText && `<span>Nozzles <b>${esc(nozzleText)}</b></span>`,
      lv.plateType && `<span>Plate <b>${esc(nice(lv.plateType))}</b></span>`,
      last && `<span>Last job <b>${esc(last.name)}${last.plate ? ` · plate ${last.plate}` : ''}</b> ${esc(RESULT[last.result]?.[1].toLowerCase() || '')} ${esc(when(last.end))}</span>`,
    ].filter(Boolean).join('');
    const pill = `<span class="pill ${statusPill[0]}">${statusPill[1]}</span>`;
    if (lv.camera && lv.online) {
      el.innerHTML = `<div class="live">
        <div class="cam"><img id="cam-img" alt="Printer camera"><span class="tag">Camera</span></div>
        <div>
          <div class="top"><div><div class="job-nm">${esc(p.name)}</div><div class="job-sub">${esc([p.model, p.firmware && `firmware ${p.firmware}`].filter(Boolean).join(' · '))}</div></div>${pill}</div>
          <div class="facts4">${temps}</div>
          <div class="idle-facts">${facts}</div>
        </div>
      </div>`;
      const newCam = $('cam-img');
      if (oldCam && newCam && oldCam.src) newCam.replaceWith(oldCam);
      if (!camRunning) camLoop();
      return;
    }
    el.innerHTML = `<div class="idle-row">${pill}<div class="big">${esc(p.name)}</div><div class="facts">${facts}</div></div>`;
  }

  // Camera: a fresh snapshot every 10 s while printing (30 s otherwise),
  // swapped in once loaded.
  let camTimer = null, camRunning = false;
  function camLoop() {
    clearTimeout(camTimer);
    const img = $('cam-img'), p = printer();
    if (!img || !p || document.hidden) { camRunning = false; return; }
    camRunning = true;
    const url = `api/camera?${q(p)}&t=${Date.now()}`;
    const pre = new Image();
    const next = () => { camTimer = setTimeout(camLoop, p.live.printing ? 10_000 : 30_000); };
    pre.onload = () => { const cur = $('cam-img'); if (cur) { cur.src = url; cur.parentElement.querySelector('.none')?.remove(); } next(); };
    pre.onerror = () => { const cam = $('cam-img')?.parentElement; if (cam && !cam.querySelector('.none')) cam.insertAdjacentHTML('beforeend', '<div class="none">No camera picture</div>'); next(); };
    pre.src = url;
  }

  // ---- start a print ---------------------------------------------------------------------------
  function renderStart(p) {
    const el = $('start');
    const show = p && snap.settings.allowControls;
    el.hidden = !show;
    document.querySelector('.grid').classList.toggle('no-start', !show);
    if (!show) return;
    const why = p.controls.start;
    const uploadOk = p.files && p.live.online;
    let list;
    if (!p.files) list = `<p class="note">Add the printer's access code on the app's Configuration tab to send files to the printer, start them here and download them for Bambu Studio.</p>`;
    else if (files.serial !== p.serial || (!files.list && !files.error)) list = empty('Loading the printer\'s files…');
    else if (files.error) list = empty(files.error, true);
    else if (!files.list.length) list = empty('No .3mf files on the printer yet.');
    else {
      list = `<ul class="files" tabindex="0" aria-label="Files on the printer, newest first">${files.list.map(f => `<li>
        <div class="thumb">${thumbImg(f.thumb)}</div>
        <div style="min-width:0"><div class="nm" title="${esc(f.name)}">${esc(f.name.replace(/\.gcode\.3mf$|\.3mf$/i, ''))}</div><div class="sm">${esc(f.path.startsWith('/cache/') ? 'cache · ' : '')}${f.mtime ? esc(when(f.mtime)) : ''} · ${size(f.size)}</div></div>
        <div class="acts">
          <a class="btn icon sm" href="api/download?${q(p)}&path=${encodeURIComponent(f.path)}" download title="Download for Bambu Studio" aria-label="Download ${esc(f.name)} for Bambu Studio">${ICON.open}</a>
          <button type="button" class="sm primary" data-act="plan" data-path="${esc(f.path)}" ${why ? `disabled title="${esc(why)}"` : ''}>Start</button>
        </div></li>`).join('')}</ul>`;
    }
    const scrolled = el.querySelector('.files')?.scrollTop || 0;
    el.innerHTML = `<div class="card-head"><h2>Start a print</h2><span class="meta">${esc(why && p.files ? why : 'Sliced .3mf files on the printer')}</span></div>
      <div class="drop" id="drop">${ICON.upload}
        Drop a sliced <b>.3mf</b> here to send it to the printer
        <div class="row"><button type="button" class="sm primary" data-act="choose" ${uploadOk ? '' : `disabled title="${esc(p.files ? 'The printer is offline.' : 'Add the printer\'s access code first.')}"`}>Choose file</button></div>
        <div class="upbar" id="upbar" hidden><i style="width:0"></i></div>
      </div>
      <div class="sub-h"><span>On the printer${files.list?.length && files.serial === p.serial ? ` · ${files.list.length}` : ''}</span>${p.files ? `<button type="button" class="ghost icon sm" data-act="files-refresh" title="Refresh the list" aria-label="Refresh the list">${ICON.refresh}</button>` : ''}</div>
      ${list}`;
    if (scrolled) { const ul = el.querySelector('.files'); if (ul) ul.scrollTop = scrolled; }
  }

  async function loadFiles(force = false) {
    const p = printer();
    if (!p || !p.files || !snap.settings.allowControls || files.loading) return;
    if (!force && files.serial === p.serial && Date.now() - files.at < 60_000) return;
    files.loading = true;
    try {
      const j = await getJson(`api/files?${q(p)}${force ? '&fresh=1' : ''}`);
      files = { serial: p.serial, list: j.files, error: null, at: Date.now(), loading: false };
    } catch (e) {
      files = { serial: p.serial, list: null, error: e.message, at: Date.now(), loading: false };
    }
    renderStart(printer());
    renderHistory(printer());
  }

  function uploadFile(file) {
    const p = printer();
    if (!p || !file) return;
    if (!/\.3mf$/i.test(file.name)) return toast('Send a sliced .3mf file (File > Export > Export plate sliced file in Bambu Studio).', true);
    const bar = $('upbar');
    bar.hidden = false;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `api/upload?${q(p)}&name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = e => { if (e.lengthComputable) bar.firstElementChild.style.width = `${Math.round(e.loaded / e.total * 100)}%`; };
    xhr.onload = () => {
      bar.hidden = true;
      let j = {};
      try { j = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status !== 200) return toast(j.error || `Upload failed (HTTP ${xhr.status}).`, true);
      toast(`${file.name} is on the printer.`);
      files.at = 0;
      loadFiles(true);
      if (!p.controls.start) openPlan(j.path);
    };
    xhr.onerror = () => { bar.hidden = true; toast('The upload didn\'t get through.', true); };
    xhr.send(file);
  }
  $('file-input').onchange = e => { uploadFile(e.target.files[0]); e.target.value = ''; };
  document.addEventListener('dragover', e => { const d = e.target.closest?.('#drop'); if (d) { e.preventDefault(); d.classList.add('over'); } });
  document.addEventListener('dragleave', e => { e.target.closest?.('#drop')?.classList.remove('over'); });
  document.addEventListener('drop', e => {
    const d = e.target.closest?.('#drop');
    if (!d) return;
    e.preventDefault();
    d.classList.remove('over');
    const p = printer();
    if (!p?.files || !p.live.online) return toast(p?.files ? 'The printer is offline.' : 'Add the printer\'s access code first.', true);
    uploadFile(e.dataTransfer.files[0]);
  });

  // The start dialog: plate, AMS slot per filament, options.
  async function openPlan(path) {
    const p = printer();
    openModal(`<h3 id="modal-title">Start a print</h3><p>Reading the file from the printer…</p><div class="row"><button type="button" data-act="close">Cancel</button></div>`);
    let plan;
    try { plan = await getJson(`api/plan?${q(p)}&path=${encodeURIComponent(path)}`); } catch (e) {
      openModal(`<h3 id="modal-title">Can't start that file</h3><p>${esc(e.message)}</p><div class="row"><button type="button" data-act="close" data-autofocus>Close</button></div>`);
      return;
    }
    let plateIdx = plan.plates[0].index;
    const choice = {};
    const draw = () => {
      const plate = plan.plates.find(x => x.index === plateIdx);
      for (const m of plate.mapping) if (choice[`${plateIdx}:${m.filament}`] === undefined) choice[`${plateIdx}:${m.filament}`] = m.trayId;
      const loaded = plan.spools.filter(s => !s.empty);
      const spoolName = s => { const n = String(s.name || '').replace(/^Bambu /, ''); return s.type && !n.toUpperCase().includes(String(s.type).toUpperCase()) ? `${s.type} ${n}`.trim() : n || s.type || 'Filament'; };
      const opt = (s, cur) => `<option value="${s.trayId}"${s.trayId === cur ? ' selected' : ''}>${esc(s.label)} · ${esc(spoolName(s))}${isNum(s.grams) ? ` · ${s.grams} g left` : ''}</option>`;
      const rows = plate.filaments.map(f => {
        const cur = choice[`${plateIdx}:${f.id}`];
        const spool = plan.spools.find(s => s.trayId === cur);
        const warn = !spool ? 'Pick a slot.' : spool.type && f.type && spool.type.toUpperCase() !== f.type.toUpperCase() ? `The file wants ${f.type}; this slot has ${spool.type}.` : isNum(spool.grams) && spool.grams < f.grams ? `Only about ${spool.grams} g left; the plate needs ${Math.round(f.grams)} g.` : '';
        return `<div class="maprow">
          <div class="from"><span class="sw" style="${sw(f.color)}"></span><span>Filament ${f.id} · ${esc(f.type || '?')} · ${grams(f.grams)}</span></div>
          <div class="to"><span class="sw" style="${sw(spool?.color)}"></span><select data-map="${f.id}" aria-label="AMS slot for filament ${f.id}">${cur === null || cur === undefined ? '<option value="">Pick a slot</option>' : ''}${loaded.map(s => opt(s, cur)).join('')}</select></div>
          ${warn ? `<div class="warn-t">${esc(warn)}</div>` : ''}
        </div>`;
      }).join('');
      const cost = plate.filaments.reduce((a, f) => a + f.grams * priceFor(plan.spools.find(s => s.trayId === choice[`${plateIdx}:${f.id}`])?.type || f.type) / 1000, 0);
      const ready = plate.filaments.every(f => isNum(choice[`${plateIdx}:${f.id}`]));
      openModal(`<h3 id="modal-title">Start ${esc(plan.name.replace(/\.gcode\.3mf$|\.3mf$/i, ''))}</h3>
        <div class="sumline"><span>Time <b>${dur(plate.seconds)}</b></span><span>Filament <b>${grams(plate.grams)}</b></span><span>Cost <b>${money(cost)}</b></span><span>on <b>${esc(p.name)}</b></span></div>
        ${plan.plates.length > 1 ? `<div class="plates" role="group" aria-label="Plate">${plan.plates.map(pl => `<button type="button" data-plate="${pl.index}" class="${pl.index === plateIdx ? 'on' : ''}" aria-pressed="${pl.index === plateIdx}">${pl.thumb ? `<img src="api/thumb/${esc(pl.thumb)}.png" alt="">` : '<span class="ph"></span>'}Plate ${pl.index}</button>`).join('')}</div>` : plate.thumb ? `<div class="plates"><img src="api/thumb/${esc(plate.thumb)}.png" alt="Plate ${plate.index}"></div>` : ''}
        <div class="maprows">${rows}</div>
        <div class="opts">
          <label><input type="checkbox" id="o-level" ${store.get('pl-level') === '0' ? '' : 'checked'}> Bed leveling</label>
          <label><input type="checkbox" id="o-flow" ${store.get('pl-flow') === '1' ? 'checked' : ''}> Flow calibration</label>
          <label><input type="checkbox" id="o-lapse" ${store.get('pl-lapse') === '1' ? 'checked' : ''}> Timelapse</label>
        </div>
        <p class="note">Make sure the build plate is clear and matches the file before you start.</p>
        <div class="err" id="plan-err" hidden></div>
        <div class="row"><button type="button" data-act="close">Cancel</button><button type="button" class="primary" data-act="start-go" ${ready ? '' : 'disabled'} data-autofocus>Start print</button></div>`, { wide: true });
      $('modal-box').querySelectorAll('[data-plate]').forEach(b => { b.onclick = () => { plateIdx = Number(b.dataset.plate); draw(); }; });
      $('modal-box').querySelectorAll('[data-map]').forEach(s => { s.onchange = () => { choice[`${plateIdx}:${s.dataset.map}`] = s.value === '' ? null : Number(s.value); draw(); }; });
      $('modal-box').querySelector('[data-act="start-go"]').onclick = async e => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Starting…';
        const body = {
          printer: p.serial, path: plan.path, plate: plateIdx,
          mapping: plate.filaments.map(f => ({ filament: f.id, trayId: choice[`${plateIdx}:${f.id}`] })),
          bedLeveling: $('o-level').checked, flowCali: $('o-flow').checked, timelapse: $('o-lapse').checked,
        };
        store.set('pl-level', body.bedLeveling ? '1' : '0'); store.set('pl-flow', body.flowCali ? '1' : '0'); store.set('pl-lapse', body.timelapse ? '1' : '0');
        try {
          await post('api/start', body);
          closeModal();
          toast('Sent to the printer. It starts in a moment.');
          setTimeout(load, 2500);
        } catch (err) {
          const box = $('plan-err');
          if (box) { box.hidden = false; box.textContent = err.message; }
          btn.disabled = false;
          btn.textContent = 'Start print';
        }
      };
    };
    draw();
  }

  function priceFor(type) {
    const t = String(type || '').toUpperCase();
    const list = snap.settings.currencyPrices || [];
    const hit = list.find(x => x.material.toUpperCase() === t) || list.find(x => t && t.startsWith(x.material.toUpperCase()));
    return hit ? hit.perKg : snap.settings.defaultPerKg;
  }

  // ---- spools --------------------------------------------------------------------------------
  function renderSpools(p) {
    const el = $('spools');
    const units = (p?.units || []).filter(u => u.kind !== 'ext' || u.spools.some(s => !s.empty));
    el.hidden = !units.length;
    if (!units.length) return;
    const low = snap.settings.lowGrams;
    const humidity = u => {
      if (!isNum(u.humidityIndex) && !isNum(u.humidity)) return '';
      const idx = u.humidityIndex;
      const cls = isNum(idx) ? (idx <= 2 ? 'dry' : idx >= 4 ? 'damp' : '') : '';
      const word = isNum(idx) ? (idx <= 2 ? 'Dry' : idx >= 4 ? 'Damp' : 'OK') : '';
      return `<span class="badge">${isNum(u.humidity) ? `${Math.round(u.humidity)}%` : ''}${isNum(u.temperature) ? ` · ${Math.round(u.temperature)}°` : ''}</span>${word ? `<span class="badge ${cls}" title="AMS humidity level ${idx} of 5 (1 is driest)">${word}<span class="hum">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= idx ? 'on' : ''}"></i>`).join('')}</span></span>` : ''}`;
    };
    const card = s => {
      if (s.empty) return `<div class="spool is-empty"><span class="slot">${esc(s.label)}</span><div class="reel none"></div><div class="nm">Empty</div><div class="fc">No spool loaded</div></div>`;
      const pct = isNum(s.remain) ? s.remain : null;
      const fc = s.low && isNum(s.printsLeft) ? `≈ ${s.printsLeft} print${s.printsLeft === 1 ? '' : 's'} left at your pace`
        : s.low && isNum(s.grams) && s.grams < low ? `Under ${low} g`
        : s.low && isNum(s.daysLeft) ? `Runs out in ≈ ${s.daysLeft} days`
        : s.usedMonth ? `Used ${grams(s.usedMonth)} in 30 days`
        : pct === null ? 'Amount unknown (no RFID tag)' : 'Not used in 30 days';
      return `<div class="spool${s.low ? ' low' : ''}${s.active ? ' feeding-now' : ''}" style="${sw(s.color)}">
        <span class="slot">${esc(s.label)}</span><div class="reel${color(s.color) ? '' : ' none'}"></div>
        <div class="nm" title="${esc(s.name)}">${esc((s.name || s.type || 'Filament').replace(/^Bambu /, ''))}</div>
        <div class="gauge"><i style="width:${pct ?? 0}%"></i></div>
        <div class="left"><span class="mono">${isNum(s.grams) ? `≈ ${s.grams} g` : dash}</span><span>${pct === null ? '' : `${pct}%`}</span></div>
        <div class="fc">${esc(fc)}</div></div>`;
    };
    const all = units.flatMap(u => u.spools);
    const reorder = all.filter(s => !s.empty && (s.low || isNum(s.daysLeft))).sort((a, b) => (a.daysLeft ?? (a.low ? -1 : 9999)) - (b.daysLeft ?? (b.low ? -1 : 9999))).slice(0, 4);
    const reorderHtml = reorder.length ? `<div class="spool reo"><div class="nm">Reorder</div><ul class="reorder">${reorder.map(s => `<li><span class="sw" style="${sw(s.color)}"></span><div>${esc((s.name || s.type || '').replace(/^Bambu /, ''))} <span class="w">${esc(s.label)}${isNum(s.grams) ? ` · ≈ ${s.grams} g` : ''}${s.perPrint ? ` · ${s.perPrint} g a print` : ''}</span></div><span class="d${s.low ? ' soon' : ''}">${s.runsOut ? `${s.low ? 'runs out ' : ''}≈ ${esc(fmt(s.runsOut, { month: 'short', day: 'numeric' }))}` : s.low ? 'low now' : ''}</span></li>`).join('')}</ul></div>` : '';
    let reoPlaced = false;
    const body = units.map(u => {
      const cards = u.spools.map(card);
      const room = (4 - (u.spools.length % 4)) % 4;
      if (!reoPlaced && reorderHtml && room >= 2) { reoPlaced = true; cards.push(reorderHtml.replace('spool reo"', `spool reo" style="grid-column: span ${room}"`)); }
      const drying = u.drying ? `<span class="badge drying">Drying${isNum(u.dryingLeftMin) && u.dryingLeftMin > 0 ? ` · ${dur(u.dryingLeftMin * 60)} left` : ''}</span>` : u.kind !== 'ext' ? '<span class="badge">Not drying</span>' : '';
      return `<div class="ams"><div class="ams-head"><b>${esc(u.label)}</b><span class="st">${humidity(u)}${drying}</span></div><div class="spools">${cards.join('')}</div></div>`;
    }).join('');
    el.innerHTML = `<div class="card-head"><h2>Spools</h2><span class="meta">Low below ${low} g, or out within two weeks at your recent pace</span></div>${body}${reorderHtml && !reoPlaced ? `<div class="spools" style="margin-top:10px">${reorderHtml.replace('spool reo"', 'spool reo" style="grid-column:1/-1"')}</div>` : ''}`;
  }

  // ---- this month, chart, failures --------------------------------------------------------------
  function renderMonth() {
    const s = snap.stats, m = s.month, lm = s.lastMonth;
    $('month').hidden = !(snap.jobCount > 0);
    if (!snap.jobCount) return;
    const monthName = k => { const [y, mo] = k.split('-').map(Number); return new Date(Date.UTC(y, mo - 1, 15)).toLocaleString(undefined, { month: 'long', timeZone: 'UTC' }); };
    const tile = (label, value, unit, sub) => `<div class="tile"><span class="label">${label}</span><span class="value">${value}${unit ? `<span class="unit">${unit}</span>` : ''}</span><span class="sub">${sub}</span></div>`;
    $('month').innerHTML = `<div class="card-head"><h2>This month</h2><span class="meta">${esc(monthName(m.key))} so far, compared with ${esc(monthName(lm.key))}</span></div>
      <div class="tiles">
        ${tile('Prints', m.prints, '', `${esc(monthName(lm.key))}: ${lm.prints}`)}
        ${tile('Success rate', m.successRate ?? dash, m.successRate === null ? '' : '%', `${m.finished} finished · ${m.failed} failed or stopped`)}
        ${tile('Print time', m.hours, 'h', m.prints ? `avg ${dur(m.hours * 3600 / m.prints)} a job` : dash)}
        ${tile('Filament used', m.grams >= 1000 ? (m.grams / 1000).toFixed(2) : m.grams, m.grams >= 1000 ? 'kg' : 'g', `${m.meters} m · ${m.wasted} g wasted`)}
        ${tile('Filament cost', money(m.cost), '', `${m.prints ? money(m.cost / m.prints) + ' a print · ' : ''}${esc(monthName(lm.key).slice(0, 3))} ${money(lm.cost)}`)}
      </div>`;
  }

  function renderChart() {
    const s = snap.stats;
    $('chart').hidden = !(snap.jobCount > 0);
    if (!snap.jobCount) return;
    const max = Math.max(50, ...s.days.map(d => d.ok + d.failed));
    const total = s.materials.reduce((a, m) => a + m.grams, 0) || 1;
    const lbl = d => { const [y, m, dd] = d.key.split(/\D/).map(Number); return isNum(y) && isNum(m) ? new Date(Date.UTC(y, m - 1, dd, 12)).toLocaleString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }) : ''; };
    $('chart').innerHTML = `<div class="card-head"><h2>Filament per day</h2><div class="legend"><span style="--c:var(--accent)">Finished</span><span style="--c:var(--critical)">Failed</span></div></div>
      <div class="chart" role="img" aria-label="Grams of filament used each day for the last 30 days">${s.days.map(d => `<div class="col" title="${esc(lbl(d))}: ${d.ok + d.failed} g">${d.ok + d.failed === 0 ? '<i class="z"></i>' : ''}${d.ok ? `<i style="height:${d.ok / max * 100}%"></i>` : ''}${d.failed ? `<i class="f" style="height:${d.failed / max * 100}%"></i>` : ''}</div>`).join('')}</div>
      <div class="chart-axis"><span>${esc(lbl(s.days[0]))}</span><span>${esc(lbl(s.days[15]))}</span><span>Today</span></div>
      <div class="mat">${s.materials.slice(0, 5).map(m => `<div class="row"><span>${esc(m.type)}</span><div class="t"><i style="width:${m.grams / total * 100}%"></i></div><span>${grams(m.grams)}</span></div>`).join('')}</div>`;
  }

  // Energy: live power (a smart plug's sensor, or estimated), and what it cost.
  function renderEnergy(p) {
    const el = $('energy');
    const en = p?.energy;
    el.hidden = !en;
    if (!en) return;
    const kwh = wh => !isNum(wh) ? dash : wh >= 1000 ? `${(wh / 1000).toFixed(2)} kWh` : `${Math.round(wh)} Wh`;
    const est = en.source === 'estimate';
    const series = en.series || [];
    let spark = '';
    if (series.length > 2) {
      const t0 = series[0][0], t1 = series[series.length - 1][0], max = Math.max(50, ...series.map(x => x[1]));
      const pts = series.map(([t, w]) => `${((t - t0) / Math.max(1, t1 - t0) * 300).toFixed(1)},${(60 - w / max * 56).toFixed(1)}`).join(' ');
      spark = `<svg class="spark" viewBox="0 0 300 60" preserveAspectRatio="none" role="img" aria-label="Power over the last ${Math.max(1, Math.round((t1 - t0) / 60000))} minutes, up to ${max} W"><polyline points="0,60 ${pts} 300,60" class="area"/><polyline points="${pts}" class="line"/></svg>
        <div class="chart-axis"><span>${esc(clock(t0))}</span><span>peak ${Math.round(Math.max(...series.map(x => x[1])))} W</span><span>now</span></div>`;
    }
    const parts = est && en.parts && !en.offline ? `<div class="chips power-parts">${[['Bed', en.parts.bed], ['Nozzles', en.parts.nozzles], ['Chamber', en.parts.chamber], ['Electronics', en.parts.electronics]].map(([l, w]) => `<span class="chip">${l} ${Math.round(w)} W</span>`).join('')}</div>` : '';
    const tile = (label, wh, cost, sub) => `<div class="tile"><span class="label">${label}</span><span class="value">${money(cost)}</span><span class="sub">${kwh(wh)}${sub ? ` · ${sub}` : ''}</span></div>`;
    const jobTile = en.job ? tile('This print so far', en.job.wh, en.job.cost, esc(en.job.name))
      : en.lastJob ? tile('Last print', en.lastJob.wh, en.lastJob.cost, esc(en.lastJob.name))
      : `<div class="tile"><span class="label">Last print</span><span class="value">${dash}</span><span class="sub">After the next print</span></div>`;
    el.innerHTML = `<div class="card-head"><h2>Energy</h2><span class="meta">${est ? '<span class="badge damp">Estimated</span> ' : `From ${esc(en.sensor)} · `}${money(en.pricePerKwh)} per kWh</span></div>
      <div class="power-now">
        <div><span class="watts mono">${isNum(en.watts) ? Math.round(en.watts) : dash}<span class="unit">W</span></span>
          <span class="meta">${en.offline ? 'Printer offline' : isNum(en.costPerHour) ? `≈ ${money(en.costPerHour)} an hour at this rate` : esc(en.problem || '')}</span></div>
        ${parts}
      </div>
      ${spark}
      <div class="tiles energy-tiles">
        ${jobTile}
        ${tile('Today', en.today.wh, en.today.cost)}
        ${tile('This month', en.month.wh, en.month.cost, `last month ${money(en.lastMonth.cost)}`)}
        ${tile('Per print', en.perPrint?.wh, en.perPrint?.cost, en.perPrint ? 'average this month' : 'after a print')}
      </div>
      <p class="note">${est ? 'Estimated from the printer’s heaters, temperatures and whether it’s printing. Add a smart plug’s power sensor on the Configuration tab for real readings. ' : ''}Counted since ${esc(fmt(en.since || Date.now(), { month: 'short', day: 'numeric' }))}; failed and stopped prints are under Print history.</p>`;
  }

  // ---- history --------------------------------------------------------------------------------------
  function fileFor(j) {
    if (!files.list || files.serial !== j.printer || !j.task) return null;
    const t = j.task.toLowerCase();
    const base = t.replace(/_plate_d+$/, '');
    return files.list.find(f => stem(f.name) === t) || files.list.find(f => stem(f.name) === base || stem(f.name).replace(/_plate_d+$/, '') === base) || null;
  }
  function renderHistory(p) {
    const el = $('history');
    const all = snap.jobs || [];
    el.hidden = !all.length && !snap.printers?.length;
    if (el.hidden) return;
    const many = (snap.printers || []).length > 1;
    const list = all.filter(j => filter === 'all' || (filter === 'finished' ? j.result === 'finished' : j.result !== 'finished'));
    const lt = snap.stats.lifetime;
    const rows = list.slice(0, showN).map(j => {
      const thumb = snap.thumbs?.[`${j.printer}|${(j.task || '').toLowerCase()}|${j.plate || 1}`];
      const f = fileFor(j);
      const pn = many ? snap.printers.find(x => x.serial === j.printer)?.name : null;
      const [cls, label] = RESULT[j.result] || ['off', j.result];
      return `<tr>
        <td class="j"><div class="job"><div class="thumb">${thumbImg(thumb)}</div><div style="min-width:0"><div class="nm" title="${esc(j.task || j.name)}">${esc(j.name)}</div><div class="sm">${[pn, j.plate && `plate ${j.plate}`, j.speed && nice(j.speed)].filter(Boolean).map(esc).join(' · ') || '&nbsp;'}</div></div></div></td>
        <td data-label="Started">${esc(when(j.start))}</td>
        <td data-label="Time" class="mono">${dur(j.seconds)}</td>
        <td class="c" data-label="Filament by slot"><div class="chips">${j.slots?.length ? j.slots.map(s => `<span class="chip" style="${sw(s.color)}" title="${esc(s.name || s.type || '')}">${esc(s.label)} ${grams(s.grams)}</span>`).join('') : `<span class="meta">${dash}</span>`}</div></td>
        <td class="r mono" data-label="Used">${grams(j.grams)}</td>
        <td class="r mono" data-label="Cost" title="${esc(`Filament ${money(j.cost)}${isNum(j.energyCost) ? ` · electricity ${money(j.energyCost)} (${Math.round(j.energyWh)} Wh)` : ''}`)}">${money(isNum(j.energyCost) && isNum(j.cost) ? j.cost + j.energyCost : j.cost)}</td>
        <td class="r s"><span class="pill ${cls}">${esc(label)}</span></td>
        <td class="r o">${f ? `<a class="btn icon sm" href="api/download?printer=${encodeURIComponent(j.printer)}&path=${encodeURIComponent(f.path)}" download title="Download ${esc(f.name)} for Bambu Studio" aria-label="Download for Bambu Studio">${ICON.open}</a>` : ''}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<div class="card-head"><h2>Print history</h2>
        <span class="meta">${snap.jobCount} print${snap.jobCount === 1 ? '' : 's'}${lt.since ? ` since ${esc(fmt(lt.since, { month: 'short', day: 'numeric', year: 'numeric' }))}` : ''} · ${lt.hours} h · ${grams(lt.grams)} · ${money(lt.cost)}</span>
        <div class="filters" role="group" aria-label="Show">${[['all', 'All'], ['finished', 'Finished'], ['failed', 'Failed or stopped']].map(([k, l]) => `<button type="button" data-filter="${k}" class="${filter === k ? 'on' : ''}" aria-pressed="${filter === k}">${l}</button>`).join('')}</div>
      </div>
      ${list.length ? `<table class="hist"><thead><tr><th>Job</th><th>Started</th><th>Time</th><th>Filament by slot</th><th class="r">Used</th><th class="r">Cost</th><th class="r">Result</th><th><span class="sr">Download</span></th></tr></thead><tbody>${rows}</tbody></table>
        ${list.length > showN ? `<div class="more"><button type="button" data-act="more">Show more (${list.length - showN} older)</button></div>` : ''}`
        : empty(all.length ? 'Nothing matches.' : 'No prints yet. Each print shows up here when it ends (the last 30 days of Home Assistant\'s history are read when the app starts).')}
      <p class="note">Grams per slot are worked out from each spool's level and which slot was feeding, so they're close but not exact. Costs use the prices on the app's Configuration tab.</p>`;
  }

  // ---- actions -----------------------------------------------------------------------------------
  document.addEventListener('click', async e => {
    const f = e.target.closest('[data-filter]');
    if (f) { filter = f.dataset.filter; store.set('pl-filter', filter); showN = 25; renderHistory(printer()); return; }
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act, p = printer();
    if (act === 'close') return closeModal();
    if (act === 'more') { showN += 50; return renderHistory(p); }
    if (act === 'choose') return $('file-input').click();
    if (act === 'files-refresh') { files.at = 0; files.list = null; renderStart(p); return loadFiles(true); }
    if (act === 'plan') return openPlan(b.dataset.path);
    if (act === 'stop') {
      const lv = p.live;
      openModal(`<h3 id="modal-title">Stop this print?</h3><p>${esc(lv.name || 'The print')} is ${isNum(lv.progress) ? `${lv.progress}% done` : 'in progress'}. Stopping can't be undone; the job is logged as stopped.</p>
        <div class="err" id="stop-err" hidden></div>
        <div class="row"><button type="button" data-act="close" data-autofocus>Keep printing</button><button type="button" class="danger" data-act="stop-go">${ICON.stop}Stop print</button></div>`);
      return;
    }
    if (act === 'pause' || act === 'resume' || act === 'stop-go') {
      const action = act === 'stop-go' ? 'stop' : act;
      b.disabled = true;
      try {
        await post('api/control', { printer: p.serial, action });
        if (act === 'stop-go') closeModal();
        toast({ pause: 'Pausing…', resume: 'Resuming…', stop: 'Stopping the print…' }[action]);
        setTimeout(load, 1500);
      } catch (err) {
        b.disabled = false;
        if (act === 'stop-go') { const box = $('stop-err'); box.hidden = false; box.textContent = err.message; } else toast(err.message, true);
      }
    }
  });

  // ---- load and poll --------------------------------------------------------------------------------
  function render() {
    if (!snap.ready) {
      $('live').innerHTML = empty(snap.error ? `Can't read Home Assistant: ${snap.error}` : 'Loading…', Boolean(snap.error));
      return;
    }
    if (sel && !snap.printers.some(p => p.serial === sel)) sel = null;
    const p = printer();
    for (const [name, fn] of [['top', renderTop], ['live', renderLive], ['start', renderStart], ['spools', renderSpools], ['month', renderMonth], ['chart', renderChart], ['energy', renderEnergy], ['history', renderHistory]]) {
      try { fn(p); } catch (e) { console.error(name, e); if ($(name)) { $(name).hidden = false; $(name).innerHTML = empty(`This panel couldn't be drawn (${e.message}).`, true); } }
    }
    $('foot').textContent = `Print Log ${snap.version} · ${snap.settings.allowControls ? 'Pause, Stop and Start go through Home Assistant\'s Bambu Lab integration' : 'view only: printer controls are off'}`;
  }

  let pollTimer = null;
  async function load() {
    clearTimeout(pollTimer);
    try {
      const r = await fetch('api/state', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      snap = await r.json();
      $('offline').hidden = true;
      // Don't redraw under an open dialog or a running upload.
      if ($('modal').hidden && $('upbar')?.hidden !== false) render();
      if (snap.ready) loadFiles();
    } catch (e) {
      console.warn('load', e);
      $('offline').hidden = false;
    } finally {
      const busy = snap?.printers?.some(p => p.live.printing);
      if (!document.hidden) pollTimer = setTimeout(load, !snap?.ready ? 3000 : busy ? 5000 : 30_000);
    }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); else { clearTimeout(pollTimer); clearTimeout(camTimer); camRunning = false; } });
  load();
})();
