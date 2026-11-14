/* ADS-B Tracker page: the map, the cards and the controls. What to fetch and
 * when lives in tracker.js; this file only draws it and passes clicks on. */
(function () {
  'use strict';
  const { TrackerCore, hasPosition, ident, onGround, fmtDuration } = window.Adsb;
  const $ = id => document.getElementById(id);

  // ---- appearance -------------------------------------------------------------
  const THEMES = ['auto', 'light', 'dark'];
  const THEME_ICONS = {
    auto: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 18V4a8 8 0 0 1 0 16',
    light: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10M11 1h2v3h-2zm0 19h2v3h-2zM3.5 4.9l1.4-1.4L7 5.6 5.6 7zm12.9 12.9 1.4-1.4 2.1 2.1-1.4 1.4zM1 11h3v2H1zm19 0h3v2h-3zM3.5 19.1 5.6 17 7 18.4l-2.1 2.1zM16.4 5.6l2.1-2.1 1.4 1.4L17.8 7z',
    dark: 'M12.3 2a9.5 9.5 0 1 0 9.7 12.2A8 8 0 0 1 12.3 2',
  };
  let theme = 'auto';
  try { theme = THEMES.includes(localStorage.getItem('adsb-theme')) ? localStorage.getItem('adsb-theme') : 'auto'; } catch { /* optional */ }
  function applyTheme() {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = theme;
    const label = `Appearance: ${theme === 'auto' ? 'automatic' : theme}`;
    $('theme').title = label;
    $('theme').setAttribute('aria-label', label);
    $('theme').querySelector('path').setAttribute('d', THEME_ICONS[theme]);
  }
  applyTheme();
  $('theme').onclick = () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    try { localStorage.setItem('adsb-theme', theme); } catch { /* optional */ }
    applyTheme();
  };

  // ---- transport: relative URL, so it works under any ingress prefix -------------
  async function transport(params) {
    let res;
    try {
      res = await fetch('api/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), credentials: 'same-origin' });
    } catch {
      $('offline').hidden = false;
      throw { code: 'app_unreachable', message: 'Can’t reach the ADS-B Tracker app. It may be restarting.', retry_after_seconds: 10 };
    }
    $('offline').hidden = true;
    const body = await res.json().catch(() => null);
    if (res.ok && body && Array.isArray(body.aircraft)) return body;
    const err = body?.error || {};
    const header = Number(res.headers.get('Retry-After'));
    throw {
      code: err.code || 'feed_unavailable',
      message: err.message || `The app answered ${res.status}.`,
      retry_after_seconds: Number.isFinite(err.retry_after_seconds) ? err.retry_after_seconds : Number.isFinite(header) && header > 0 ? header : undefined,
    };
  }

  // ---- map --------------------------------------------------------------------
  const PRESETS = { conus: [[24, -126], [50, -66]], alaska: [[51, 172], [72, 230]], hawaii: [[18.5, -161], [22.6, -154.5]] };
  const PRESET_NAMES = { conus: 'Lower 48', alaska: 'Alaska', hawaii: 'Hawaii' };
  let preset = 'conus';
  let map = null, coverage = null, trailLine = null;
  const markers = new Map();
  let lastPanned = null;
  let lastLocked = null;
  let programmaticMove = false;

  const core = new TrackerCore({
    transport,
    storage: (() => { try { return window.localStorage; } catch { return null; } })(),
    zoom: () => (map ? map.getZoom() : 4),
    hidden: () => document.hidden,
    onChange: () => schedule(),
  });
  if (core.mode === 'tracking') lastLocked = core.tracked?.hex;   // a restored flight is centred below

  function moveMap(fn) { programmaticMove = true; try { fn(); } finally { setTimeout(() => { programmaticMove = false; }, 0); } }

  try {
    map = L.map('map', { worldCopyJump: true, preferCanvas: false, zoomSnap: 0.5, attributionControl: true });
    map.attributionControl.setPrefix('<a href="https://leafletjs.com/" target="_blank" rel="noopener noreferrer">Leaflet</a>');
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles © <a href="https://www.esri.com/" target="_blank" rel="noopener noreferrer">Esri</a> — Sources: Esri, HERE, Garmin, USGS, Intermap, INCREMENT P, NRCAN, METI, TomTom and the GIS User Community',
      maxZoom: 18,
    }).addTo(map);
    coverage = L.circle([core.area.latitude, core.area.longitude], { radius: 1, color: '#2db7dc', weight: 1.5, fillOpacity: 0.04, dashArray: '5 6', interactive: false });
    trailLine = L.polyline([], { color: getComputedStyle(document.documentElement).getPropertyValue('--tracked').trim() || '#59e3a2', weight: 3, opacity: 0.9, interactive: false }).addTo(map);
    const s = core.selected;
    if (core.mode === 'tracking' && s && hasPosition(s)) map.setView([s.lat, s.lon], 7);
    else map.fitBounds(PRESETS.conus);
    // Dragging the map means "let me look around": stop following.
    map.on('dragstart', () => { if (core.follow) { core.follow = false; schedule(); } });
    map.on('zoomend', () => { schedule(); core.refresh(); });
    new ResizeObserver(() => map.invalidateSize()).observe($('map'));
  } catch (e) {
    console.error(e);
    map = null;
    core.notice = 'The map couldn’t load. Search and the aircraft list still work; reload to try the map again.';
  }

  // ---- controls ---------------------------------------------------------------
  const PLACEHOLDERS = { flight: 'e.g. AA1920 or DL789', callsign: 'e.g. AAL1920 or SKW5123', registration: 'e.g. N195UW', hex: 'e.g. A17C95' };
  $('kind').onchange = () => { $('query').placeholder = PLACEHOLDERS[$('kind').value]; $('query').focus(); };
  $('search').onsubmit = e => {
    e.preventDefault();
    const r = core.search($('kind').value, $('query').value);
    if (!r.error) { $('filter').value = ''; lastPanned = null; }
  };
  $('pause').onclick = () => core.setPaused(!core.paused);
  $('follow').onclick = () => { core.follow = !core.follow; lastPanned = null; schedule(); };
  $('isolate').onclick = () => { core.isolated = !core.isolated; schedule(); };
  $('recenter').onclick = () => { core.follow = true; lastPanned = null; schedule(); };
  $('track').onclick = () => { if (core.selected) { $('filter').value = ''; core.track(core.selected); lastPanned = null; } };
  $('stop').onclick = () => { core.stop(); $('query').value = ''; goPreset(preset); };
  $('filter').oninput = () => schedule();
  $('scan').onclick = () => {
    if (!map) return;
    const c = map.getCenter();
    $('filter').value = '';
    core.scanArea({ latitude: c.lat, longitude: c.lng, radius: Number($('radius').value) });
    moveMap(() => map.fitBounds(L.latLng(core.area.latitude, core.area.longitude).toBounds(core.area.radius * 1852 * 2), { maxZoom: 9 }));
  };
  for (const b of document.querySelectorAll('[data-preset]')) b.onclick = () => goPreset(b.dataset.preset);
  function goPreset(name) {
    preset = name;
    core.overview();
    if (map) moveMap(() => map.fitBounds(PRESETS[name]));
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) core.refresh(); });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); $('query').focus(); }
  });

  // ---- drawing ------------------------------------------------------------------
  function el(tag, props = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k.startsWith('on')) n[k] = v;
      else n.setAttribute(k, v);
    }
    for (const c of children) if (c != null && c !== false) n.append(c);
    return n;
  }
  const num = (v, suffix = '') => (Number.isFinite(v) ? Math.round(v).toLocaleString() + suffix : '—');
  const altText = a => (onGround(a) ? 'Ground' : num(a.alt_baro ?? a.alt_geom));
  const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const CARDINAL = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const EMERGENCY = { 7500: 'Hijack', 7600: 'Radio failure', 7700: 'Emergency' };

  function colorFor(a, selected) {
    if (selected) return cssVar('--tracked');
    const alt = Number(a.alt_baro);
    return alt > 30000 ? cssVar('--alt-high') : alt > 10000 ? cssVar('--alt-mid') : cssVar('--alt-low');
  }

  function planeIcon(a, selected) {
    const size = selected ? 34 : 24;
    const heading = Number.isFinite(a.track) ? a.track : Number.isFinite(a.true_heading) ? a.true_heading : 0;
    return L.divIcon({
      className: 'plane', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
      html: `<svg viewBox="0 0 24 24" style="transform:rotate(${heading}deg)" fill="${colorFor(a, selected)}" stroke="${cssVar('--plane-edge')}" stroke-width=".8"><path d="M12 1 14 9 22 14 22 16 14 14 14 20 17 22 17 23 12 21 7 23 7 22 10 20 10 14 2 16 2 14 10 9Z"/></svg>`,
    });
  }

  function drawMap(mapped) {
    if (!map) return;
    const selHex = core.selected?.hex;
    const keep = new Set(mapped.map(a => a.hex));
    for (const [hex, m] of markers) if (!keep.has(hex)) { m.remove(); markers.delete(hex); }
    for (const a of mapped) {
      const selected = a.hex === selHex;
      const key = `${Math.round(a.track || 0)}|${selected}|${Number(a.alt_baro) > 30000 ? 2 : Number(a.alt_baro) > 10000 ? 1 : 0}|${theme}`;
      let m = markers.get(a.hex);
      if (!m) {
        m = L.marker([a.lat, a.lon], { icon: planeIcon(a, selected), keyboard: true, title: ident(a), zIndexOffset: selected ? 1000 : 0 }).addTo(map);
        m.on('click', () => { const latest = core.aircraft.find(v => v.hex === a.hex); if (latest) core.select(latest); });
        m.bindTooltip(document.createTextNode(''), { direction: 'top', offset: [0, -12] });
        markers.set(a.hex, m);
      } else {
        m.setLatLng([a.lat, a.lon]);
      }
      if (m._key !== key) { m.setIcon(planeIcon(a, selected)); m.setZIndexOffset(selected ? 1000 : 0); m._key = key; }
      m.setTooltipContent(`${ident(a)}${a.r && a.r !== ident(a) ? ' · ' + a.r : ''}${a.t ? ' · ' + a.t : ''}`);
    }
    trailLine.setStyle({ color: cssVar('--tracked') });
    trailLine.setLatLngs(selHex ? core.trails.get(selHex) || [] : []);

    if (core.mode === 'area') {
      coverage.setLatLng([core.area.latitude, core.area.longitude]).setRadius(core.area.radius * 1852).setStyle({ color: cssVar('--accent') });
      if (!map.hasLayer(coverage)) coverage.addTo(map);
    } else if (map.hasLayer(coverage)) coverage.remove();

    // A newly locked flight: zoom in on it once (15 s updates need zoom > 5).
    const s = core.selected;
    const lockedHex = core.mode === 'tracking' ? core.tracked?.hex : null;
    if (lockedHex && lockedHex !== lastLocked && s && hasPosition(s)) {
      lastPanned = `${s.lat},${s.lon}`;
      moveMap(() => map.setView([s.lat, s.lon], Math.max(map.getZoom(), 7)));
    }
    lastLocked = lockedHex;

    // Follow: pan only when the aircraft actually moved, so the map isn't
    // yanked back every second.
    if (core.follow && s && hasPosition(s) && core.isLive(s)) {
      const pos = `${s.lat},${s.lon}`;
      if (pos !== lastPanned) {
        lastPanned = pos;
        moveMap(() => map.panTo([s.lat, s.lon], { animate: true, duration: 0.6 }));
      }
    }
  }

  // Brings `target` in line with `fresh` while keeping nodes that didn't change
  // shape, so a button under the pointer isn't swapped out mid-click by the
  // once-a-second redraw.
  function morph(target, fresh) {
    const a = target.childNodes, b = fresh.childNodes;
    const same = a.length === b.length && [...a].every((n, i) => n.nodeName === b[i].nodeName);
    if (!same) { target.replaceChildren(...b); return; }
    for (let i = 0; i < b.length; i++) {
      const o = a[i], n = b[i];
      if (o.nodeType === 3) { if (o.data !== n.data) o.data = n.data; continue; }
      if (o.nodeType !== 1) continue;
      for (const { name } of [...o.attributes]) if (!n.hasAttribute(name)) o.removeAttribute(name);
      for (const { name, value } of [...n.attributes]) if (o.getAttribute(name) !== value) o.setAttribute(name, value);
      if (n.onclick) o.onclick = n.onclick;
      morph(o, n);
    }
  }

  function drawDetails() {
    const target = $('details');
    const d = document.createElement('div');
    const s = core.selected;
    const tracking = core.mode === 'tracking' && s && core.tracked?.hex === s.hex;
    const ended = core.mode === 'ended';
    $('flightTitle').textContent = tracking ? 'Tracking' : ended ? 'Flight ended' : 'Selected flight';

    if (!s) {
      const ex = (kind, v) => el('button', { type: 'button', onclick: () => { $('kind').value = kind; $('kind').onchange(); $('query').value = v; $('query').focus(); } }, v);
      d.append(el('div', { class: 'empty-state' },
        el('p', {}, core.aircraft.length > 1
          ? (core.mode === 'lookup' ? 'Several aircraft match. Pick one in the list below.' : 'Pick an aircraft on the map or in the list to see its details and track it.')
          : 'Enter a flight number above and press Find & track. A single match is followed automatically, wherever it flies.'),
        el('div', { class: 'examples' }, ex('flight', 'AA1920'), ex('flight', 'DL789'), ex('registration', 'N195UW'))));
    } else {
      const phase = core.phase();
      const squawk = String(s.squawk || '');
      const row = el('div', { class: 'callsign-row' }, el('span', { class: 'callsign' }, ident(s)));
      if (EMERGENCY[squawk]) row.append(el('span', { class: 'chip', dataset: { key: 'emergency' } }, `Squawk ${squawk} · ${EMERGENCY[squawk]}`));
      else if (phase) row.append(el('span', { class: 'chip', dataset: { key: phase.key } }, phase.text));
      d.append(row, el('div', { class: 'sub' }, [s.r, s.t, s.desc].filter(Boolean).join(' · ') || 'Aircraft details not broadcast'));
      if (tracking || ended) {
        const st = core.trailStats(s.hex);
        const bits = [];
        if (st.since) bits.push(`Watching since ${new Date(st.since).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
        if (st.miles >= 1) bits.push(`${Math.round(st.miles).toLocaleString()} mi observed`);
        if (bits.length) d.append(el('div', { class: 'since' }, bits.join(' · ')));
      }

      const vs = Number(s.baro_rate ?? s.geom_rate);
      const heading = Number(s.track);
      const age = hasPosition(s) ? core.age(s) : null;
      const next = core.nextUpdateIn();
      const items = [
        ['Altitude', onGround(s) ? 'On ground' : num(s.alt_baro ?? s.alt_geom, ' ft')],
        ['Ground speed', Number.isFinite(s.gs) ? el('span', {}, num(s.gs, ' kt'), ' ', el('small', {}, `${Math.round(s.gs * 1.15078)} mph`)) : '—'],
        ['Heading', Number.isFinite(heading) ? `${Math.round(heading)}° ${CARDINAL[Math.round(heading / 45) % 8]}` : '—'],
        ['Vertical speed', Number.isFinite(vs) ? `${vs > 100 ? '↑ ' : vs < -100 ? '↓ ' : ''}${num(Math.abs(vs), ' ft/min')}` : '—'],
        ['Squawk', squawk || '—', EMERGENCY[squawk] ? 'alert' : ''],
        ['ICAO', String(s.hex).toUpperCase()],
        ['Position age', age == null ? 'No position' : fmtDuration(age)],
        ['Next update', next == null ? (core.paused ? 'Paused' : '—') : next === 0 ? 'Now' : `in ${fmtDuration(next)}`],
      ];
      const dl = el('dl');
      for (const [k, v, cls] of items) dl.append(el('div', {}, el('dt', {}, k), el('dd', cls ? { class: cls } : {}, v)));
      d.append(dl);

      if (ended) {
        const e = core.ended || {};
        d.append(el('div', { class: 'note' },
          e.reason === 'callsign' ? `This aircraft is now flying ${e.newCallsign}. Your flight ${e.callsign} has most likely landed.`
            : e.reason === 'landed' ? `${e.callsign} landed, so tracking stopped.`
              : `No signal for ${e.callsign} in over 2 hours, so tracking stopped.`,
          el('div', { class: 'actions' },
            el('button', { type: 'button', onclick: () => { core.keepFollowing(); lastPanned = null; } }, e.reason === 'callsign' ? `Follow ${e.newCallsign}` : 'Keep watching'),
            el('button', { type: 'button', onclick: () => $('stop').onclick() }, 'Done'))));
      } else if (tracking && !core.isLive(s)) {
        d.append(el('div', { class: 'note' }, 'No recent position. The aircraft stays locked and the app keeps trying; the last position isn’t a live location.'));
      }
    }

    morph(target, d);
    const has = !!s;
    document.querySelector('.toggles').hidden = !has || ended;
    $('follow').setAttribute('aria-pressed', String(core.follow && has));
    $('isolate').setAttribute('aria-pressed', String(core.isolated && has));
    $('track').hidden = !has || tracking || ended;
    $('stop').hidden = !tracking;
  }

  const rowCache = new Map();
  function drawList(list, mapped) {
    const rows = $('rows');
    const selHex = core.selected?.hex;
    const sorted = list.slice().sort((a, b) => ident(a).localeCompare(ident(b))).slice(0, 200);
    // One row per aircraft, kept between redraws and updated in place.
    const seen = new Set();
    const trs = sorted.map(a => {
      seen.add(a.hex);
      let tr = rowCache.get(a.hex);
      if (!tr) {
        const pick = () => {
          const latest = core.aircraft.find(v => v.hex === a.hex) || a;
          core.select(latest);
          if (map && hasPosition(latest)) moveMap(() => map.setView([latest.lat, latest.lon], Math.max(map.getZoom(), 7)));
        };
        tr = el('tr', { onclick: pick },
          el('td', {}, el('button', { type: 'button', onclick: e => { e.stopPropagation(); pick(); } }), el('span', { class: 'reg' })),
          el('td'), el('td', { class: 'num' }), el('td', { class: 'num' }), el('td', { class: 'num' }));
        rowCache.set(a.hex, tr);
      }
      const [c0, c1, c2, c3, c4] = tr.children;
      const set = (n, t) => { if (n.textContent !== t) n.textContent = t; };
      set(c0.firstChild, ident(a));
      set(c0.lastChild, a.r && a.r !== ident(a) ? a.r : '');
      set(c1, a.t || '—');
      set(c2, altText(a));
      set(c3, num(a.gs));
      set(c4, hasPosition(a) ? fmtDuration(core.age(a)) : '—');
      tr.className = a.hex === selHex ? 'selected' : '';
      return tr;
    });
    for (const hex of rowCache.keys()) if (!seen.has(hex)) rowCache.delete(hex);
    if (trs.length !== rows.children.length || trs.some((tr, i) => rows.children[i] !== tr)) rows.replaceChildren(...trs);
    $('counts').textContent = core.aircraft.length ? `${list.length} listed · ${mapped.length} on map${list.length > 200 ? ' · first 200' : ''}` : '';
    $('filter').disabled = core.aircraft.length < 2;
    rows.closest('table').hidden = !list.length;
    const empty = $('empty');
    empty.textContent = list.length ? '' : core.mode === 'idle' ? 'No aircraft loaded. Search a flight, or zoom in and use Scan map here.'
      : core.aircraft.length ? 'Nothing matches the filter.' : core.mode === 'ended' ? 'Not polling.' : core.last ? 'No aircraft right now.' : 'Waiting for data…';
  }

  function drawChrome() {
    const f = core.feed();
    $('feed').dataset.state = f.state;
    $('feed').textContent = f.text;
    $('pause').textContent = core.paused ? 'Resume' : 'Pause';
    $('pause').disabled = !core.polling() && !core.paused;
    const st = core.status();
    $('status').dataset.tone = st.tone;
    if ($('status').textContent !== st.text) $('status').textContent = st.text;
    const every = core.pollIntervalMs() / 1000;
    $('region').textContent =
      core.mode === 'tracking' ? `Tracking ${core.label} · worldwide · every ${every}s`
        : core.mode === 'lookup' ? `Searching for ${core.label} · every ${every}s`
          : core.mode === 'area' ? `Scan · ${core.area.radius} NM around ${core.area.latitude.toFixed(2)}, ${core.area.longitude.toFixed(2)} · every ${every}s`
            : core.mode === 'ended' ? `${core.ended?.callsign || 'Flight'} · tracking ended`
              : `${PRESET_NAMES[preset]} · map only, no aircraft requests`;
    $('scan').disabled = core.mode === 'tracking' || !map;
    $('scan').title = core.mode === 'tracking' ? 'Stop tracking first to scan an area' : 'Load the aircraft around the map’s centre';
    $('recenter').hidden = !(core.mode === 'tracking' && !core.follow && core.selected && hasPosition(core.selected));
    document.title = core.mode === 'tracking' ? `${core.label} · ADS-B Tracker` : 'ADS-B Tracker';
  }

  function render() {
    const { list, mapped } = core.visible($('filter').value);
    drawChrome();
    drawMap(mapped);
    drawDetails();
    drawList(list, mapped);
  }

  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; render(); });
  }

  // Ages and countdowns tick every second; refresh() only asks the feed when due.
  setInterval(() => { core.refresh(); schedule(); }, 1000);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', schedule);
  render();
  core.refresh();
})();
