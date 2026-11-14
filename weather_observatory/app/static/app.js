'use strict';
// Weather Observatory page. Asks the app for one snapshot (api/state) every
// minute while visible and renders it. Every source carries its own fetch
// time and error, and each panel shows its own: a failing source never blanks
// another, and a retained value is labelled as retained.
//
// All URLs are relative, so the page works under Home Assistant's ingress
// prefix.

(() => {
  const W = window.WxCore;
  const { escapeHTML: esc, format, number } = W;
  const $ = id => document.getElementById(id);
  const POLL_MS = 60_000;

  let snap = null;            // last snapshot from the app
  let metric = 'temperature'; // chart tab
  let selectedTime = null;    // chart selection, by time (not index), so it survives tab changes
  let pollTimer = null;

  // ---- theme ----------------------------------------------------------------
  const THEMES = ['auto', 'light', 'dark'];
  const THEME_ICONS = {
    auto: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 18V4a8 8 0 0 1 0 16',
    light: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10M2 13h2a1 1 0 0 0 0-2H2a1 1 0 0 0 0 2m18 0h2a1 1 0 0 0 0-2h-2a1 1 0 0 0 0 2M11 2v2a1 1 0 0 0 2 0V2a1 1 0 0 0-2 0m0 18v2a1 1 0 0 0 2 0v-2a1 1 0 0 0-2 0M5.99 4.58a1 1 0 0 0-1.41 1.41l1.06 1.06a1 1 0 0 0 1.41-1.41zm12.37 12.37a1 1 0 0 0-1.41 1.41l1.06 1.06a1 1 0 0 0 1.41-1.41zm1.06-10.96a1 1 0 0 0-1.41-1.41l-1.06 1.06a1 1 0 0 0 1.41 1.41zM7.05 18.36a1 1 0 0 0-1.41-1.41l-1.06 1.06a1 1 0 0 0 1.41 1.41z',
    dark: 'M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1',
  };
  let theme = 'auto';
  try { theme = THEMES.includes(localStorage.getItem('wx-theme')) ? localStorage.getItem('wx-theme') : 'auto'; } catch { /* optional */ }
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const isDark = () => theme === 'dark' || (theme === 'auto' && darkQuery.matches);
  function applyTheme() {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = theme;
    const label = `Appearance: ${theme === 'auto' ? 'automatic' : theme}`;
    $('theme').title = label;
    $('theme').setAttribute('aria-label', label);
    $('theme').querySelector('path').setAttribute('d', THEME_ICONS[theme]);
    radar.setTheme(isDark());
  }
  $('theme').onclick = () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    try { localStorage.setItem('wx-theme', theme); } catch { /* optional */ }
    applyTheme();
  };
  darkQuery.addEventListener?.('change', () => applyTheme());

  // ---- helpers ----------------------------------------------------------------
  const zone = () => snap?.location?.timeZone || undefined;
  function timeLabel(date, options = {}) {
    const t = new Date(date);
    if (Number.isNaN(t.valueOf())) return '—';
    try { return t.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: zone(), ...options }); } catch { return t.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit', ...options }); }
  }
  const dayKey = d => timeLabel(d, { year: 'numeric', month: '2-digit', day: '2-digit', hour: undefined, minute: undefined });
  const validState = s => s && !['unavailable', 'unknown', 'none', ''].includes(s.state);
  function units() {
    const a = snap?.weather?.data?.attributes || {};
    return { temp: a.temperature_unit || '°F', wind: a.wind_speed_unit || 'mph', pressure: a.pressure_unit || 'inHg', rain: a.precipitation_unit || 'in', visibility: a.visibility_unit || 'mi' };
  }
  const empty = (msg, problem = false) => `<div class="empty${problem ? ' problem' : ''}">${esc(msg)}</div>`;
  const retainedNote = src => src?.error && src?.data ? ` · <span class="warn-text">last refresh failed (${esc(src.error)}); showing the last good data</span>` : '';
  const unitSpan = (value, unit) => number(value) === null || !unit ? '' : `<span class="unit">${esc(unit)}</span>`;

  function weatherGlyph(condition = 'sunny', large = false) {
    const c = String(condition || '');
    const rain = /rain|pouring|hail|lightning/.test(c), snow = /snow/.test(c), cloud = /cloud|rain|snow|fog|hail|lightning|exceptional/.test(c), night = c === 'clear-night';
    const fog = c === 'fog', wind = /windy/.test(c);
    let body = '';
    if (night) body += '<path d="M78 12A35 35 0 1 0 95 67 31 31 0 0 1 78 12" fill="url(#wx-gold)"/><circle cx="93" cy="21" r="2" fill="#d7e8f7"/><circle cx="105" cy="41" r="1.8" fill="#d7e8f7"/>';
    else if (!wind || cloud) body += `<circle cx="50" cy="39" r="${cloud ? 22 : 27}" fill="url(#wx-gold)"/>${cloud ? '' : '<g stroke="#d6a95b" stroke-width="3" stroke-linecap="round"><path d="M50 4v-1M50 77v6M13 39H7M87 39h6M24 13l-4-4M76 65l4 4M24 65l-4 4M76 13l4-4"/></g>'}`;
    if (cloud) body += '<path d="M34 73a18 18 0 0 1 0-36 25 25 0 0 1 48-1 18 18 0 1 1 5 37Z" fill="url(#wx-cloud)"/>';
    if (wind) body += '<g fill="none" stroke="#8aa6bc" stroke-width="4" stroke-linecap="round"><path d="M14 52h58a10 10 0 1 0-10-10M20 66h66a9 9 0 1 1-9 9M10 80h36"/></g>';
    if (fog) body += '<g stroke="#a9bccb" stroke-width="4" stroke-linecap="round"><path d="M24 84h62M32 94h50"/></g>';
    if (rain) body += '<g stroke="#4fb6e0" stroke-width="4" stroke-linecap="round"><path d="m42 84-4 9m23-9-4 9m23-9-4 9"/></g>';
    if (snow) body += '<g fill="#9fd3ef"><circle cx="42" cy="88" r="3"/><circle cx="62" cy="92" r="3"/><circle cx="82" cy="87" r="3"/></g>';
    if (/lightning/.test(c)) body += '<path d="m61 67-12 20h10l-5 13 22-26H63l7-7" fill="#f5ca6d"/>';
    return `<svg class="weather-glyph${large ? ' large' : ''}" viewBox="0 0 120 100" aria-hidden="true">${body}</svg>`;
  }

  // ---- data -------------------------------------------------------------------
  async function load(force = false) {
    clearTimeout(pollTimer);
    try {
      const r = await fetch(force ? 'api/refresh' : 'api/state', force
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
        : { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      snap = await r.json();
      $('offline').hidden = true;
      render();
    } catch {
      $('offline').hidden = false;
      $('connection').dataset.state = 'down';
      $('connection').textContent = 'App unreachable';
    }
    // Ask again soon while a slow source is still loading.
    const loading = snap && ['weather', 'hourly', 'daily', 'history', 'sun', 'alerts', 'station', 'air', 'radar'].some(k => snap[k]?.loading);
    if (!document.hidden) pollTimer = setTimeout(() => load(), loading ? 3000 : POLL_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(pollTimer); radar.play(false); } else load();
  });

  $('refresh').onclick = async () => {
    const b = $('refresh');
    if (b.disabled) return;
    b.disabled = true;
    b.classList.add('spinning');
    try { await load(true); } finally {
      b.classList.remove('spinning');
      setTimeout(() => { b.disabled = false; }, 2000);
    }
  };

  // ---- render -----------------------------------------------------------------
  function render() {
    if (!snap) return;
    renderHeader();
    renderAlerts();
    renderCurrent();
    renderChart();
    renderDaily();
    renderAir();
    renderSolar();
    renderStation();
    radar.update(snap.location?.point, snap.radar);
    renderFooter();
  }

  function renderHeader() {
    const date = timeLabel(snap.now, { weekday: 'long', month: 'short', day: 'numeric', hour: undefined, minute: undefined });
    $('location').textContent = `${snap.location?.label || 'Home area'} · ${date}`;
    const w = snap.weather;
    const c = $('connection');
    if (!snap.ha?.available) { c.dataset.state = 'down'; c.textContent = 'Not in Home Assistant'; }
    else if (w.data && validState(w.data) && !w.error) { c.dataset.state = 'live'; c.textContent = 'Live'; }
    else if (w.data && validState(w.data)) { c.dataset.state = 'warn'; c.textContent = 'Retrying'; }
    else { c.dataset.state = 'down'; c.textContent = 'Weather unavailable'; }
    $('version').textContent = snap.version && snap.version !== 'dev' ? `v${snap.version}` : '';
  }

  function renderAlerts() {
    const a = snap.alerts;
    const el = $('alerts');
    const st = W.alertStatus(a, snap.now);
    if (st.kind === 'off') { el.innerHTML = ''; return; }
    const point = snap.location?.point;
    const official = point ? `https://forecast.weather.gov/MapClick.php?lat=${point.lat}&lon=${point.lon}` : 'https://www.weather.gov/';
    const link = `<a href="${esc(official)}" target="_blank" rel="noopener noreferrer">NWS forecast ↗</a>`;
    if (st.kind === 'checking' || st.kind === 'unavailable') {
      el.innerHTML = `<div class="alert-line" data-tone="stale"><span>${st.kind === 'checking' ? 'Checking NWS alerts for your area…' : `NWS alerts unavailable: ${esc(a.error || 'not checked yet')}`}</span><span class="when">${link}</span></div>`;
      return;
    }
    const list = a.data;
    const checked = `Checked ${esc(W.age(a.fetchedAt, snap.now))}${a.error ? ' · latest check failed' : ''}`;
    if (st.kind !== 'active') {
      el.innerHTML = `<div class="alert-line" data-tone="${st.tone}"><span>${st.kind === 'last-clear' ? 'The <strong>last successful check</strong> found no active NWS alerts' : 'No active NWS alerts for your area'}</span><span class="when">${checked} · ${link}</span></div>`;
      return;
    }
    el.innerHTML = `<div class="alert-line" data-tone="${st.tone}"><span><strong>${list.length} active NWS ${list.length === 1 ? 'alert' : 'alerts'}</strong>${st.stale ? ' (from the last successful check)' : ''}</span><span class="when">${checked} · ${link}</span></div>
      <div class="alert-list">${list.map(x => {
        const tone = W.alertTone(x.severity);
        const until = x.ends ? `until ${esc(timeLabel(x.ends, { weekday: 'short' }))}` : '';
        return `<details class="alert" data-tone="${tone}"><summary><span class="event">${esc(x.event)}</span><span class="chip" data-tone="${tone}">${esc(x.severity)}</span><span class="until">${until}</span></summary>
          <div class="alert-body">${x.headline ? `<p class="headline">${esc(x.headline)}</p>` : ''}<p>${esc(x.description || 'Details unavailable.')}</p>${x.instruction ? `<p><strong>What to do:</strong> ${esc(x.instruction)}</p>` : ''}<p class="muted small">${esc(x.sender || 'National Weather Service')}</p></div></details>`;
      }).join('')}</div>`;
  }

  function renderCurrent() {
    const src = snap.weather, w = src.data, u = units();
    if (!w) {
      $('current').innerHTML = empty(src.error ? `Home Assistant weather unavailable: ${src.error}` : 'Loading current conditions…', !!src.error);
      return;
    }
    const ok = validState(w), a = ok ? w.attributes : {};
    const daily = snap.daily.data || [];
    const today = daily.find(d => dayKey(d.datetime) === dayKey(snap.now));
    const next = today || daily[0];
    const history = (snap.history.data || []).map(p => ({ time: p.t, value: p.pressure })).filter(p => p.value !== null);
    const trend = W.pressureTrend(history, snap.now, u.pressure);
    const pDigits = u.pressure === 'inHg' ? 2 : 0;
    const metric = (label, value, unit, digits, hint) => `<div class="metric"><div class="label">${label}</div><div class="value">${format(value, digits)}${unitSpan(value, unit)}</div>${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`;
    const sixth = number(a.wind_gust_speed) !== null || number(a.visibility) === null
      ? metric('Gust', a.wind_gust_speed, u.wind, 0, number(a.wind_gust_speed) === null ? 'Not provided by source' : '')
      : metric('Visibility', a.visibility, u.visibility, 1, '');
    const bearing = number(a.wind_bearing);
    $('current').innerHTML = `
      <div class="hero-top"><h2>Current conditions</h2><span class="small muted">${esc(a.attribution ? 'Model estimate' : w.entity_id)}</span></div>
      <div class="hero-main">
        <div><div class="temperature">${format(a.temperature)}<sup>${esc(u.temp)}</sup></div>
        <div class="condition">${ok ? esc(W.conditionText(w.state)) : 'Weather unavailable'}</div></div>
        ${ok ? weatherGlyph(w.state, true) : ''}
      </div>
      <div class="hi-low"><span>${today ? 'Today' : 'Next'} high <strong>${format(next?.temperature)}°</strong></span><span>Low <strong>${format(next?.templow)}°</strong></span><span>Feels like <strong>${format(a.apparent_temperature)}°</strong></span></div>
      <div class="metrics">
        ${metric('Humidity', a.humidity, '%', 0)}
        ${metric('Dew point', a.dew_point, u.temp, 0)}
        ${metric('Pressure', a.pressure, u.pressure, pDigits, trend ? `${trend.label} ${format(Math.abs(trend.delta), pDigits)} in ${format(trend.hours, 1)} h` : 'Trend needs 3 h of history')}
        ${metric('Cloud cover', a.cloud_coverage, '%', 0)}
        ${metric('UV index', a.uv_index, '', 0, W.uvCategory(a.uv_index))}
        ${sixth}
      </div>
      <div class="wind-mini">
        <svg viewBox="0 0 80 80" aria-hidden="true"><circle class="ring" cx="40" cy="40" r="30"/><circle class="ring" cx="40" cy="40" r="20" opacity=".5"/>
          <text class="tick" x="40" y="8" text-anchor="middle">N</text><text class="tick" x="40" y="78" text-anchor="middle">S</text><text class="tick" x="76" y="43" text-anchor="middle">E</text><text class="tick" x="4" y="43" text-anchor="middle">W</text>
          ${bearing !== null ? `<g transform="rotate(${bearing + 180} 40 40)"><path class="needle" d="M40 14 33 37 40 33 47 37Z"/><path d="M40 33v27" stroke="var(--accent)" stroke-width="1.5"/></g>` : ''}</svg>
        <div><div class="label">Wind${bearing !== null ? ` from the ${esc(W.compass(bearing))}` : ''}</div><div class="wind-value">${format(a.wind_speed, 1)}${unitSpan(a.wind_speed, u.wind)}</div><div class="small muted">${bearing !== null ? `${format(bearing)}° · arrow points where it’s blowing` : 'Direction not provided'}</div></div>
      </div>
      <div class="source-line">${esc(w.entity_id)} · updated ${esc(W.age(w.last_updated, snap.now))}${retainedNote(src)}</div>`;
  }

  // ---- chart ------------------------------------------------------------------
  function chartPoints() {
    if (metric === 'history') return (snap.history.data || []).map(p => ({ time: p.t, value: p.temperature })).filter(p => p.value !== null);
    const hourly = (snap.hourly.data || []).filter(f => Date.parse(f.datetime) >= snap.now - 30 * 60_000).slice(0, 24);
    return hourly.map(f => ({ time: Date.parse(f.datetime), value: number(f[metric]), forecast: f })).filter(p => p.value !== null);
  }

  function renderChart() {
    const history = metric === 'history', u = units();
    const src = history ? snap.history : snap.hourly;
    $('chart-title').textContent = history ? 'The past 24 hours' : 'The next 24 hours';
    $('chart-source').innerHTML = history
      ? `Recorded by Home Assistant · ${src.fetchedAt ? `loaded ${esc(W.age(src.fetchedAt, snap.now))}` : 'waiting'}${retainedNote(src)}`
      : `Model forecast · ${src.fetchedAt ? `received ${esc(W.age(src.fetchedAt, snap.now))} (not the model run time)` : 'waiting for the forecast'}${retainedNote(src)}`;
    const points = chartPoints();
    const box = $('chart');
    // Drawn at the box's real width so labels stay 11px on every screen.
    const width = Math.max(280, Math.round(box.clientWidth || 920));
    const narrow = width < 520;
    const height = narrow ? 200 : 230, pad = 28, padLeft = narrow ? 38 : 44, bottom = height - pad;
    const chart = W.chartPaths(points, width, height, pad, !history && metric !== 'temperature', padLeft);
    if (!chart) {
      const msg = history
        ? (src.error ? `Recorder history unavailable: ${src.error}` : src.fetchedAt ? 'No recorded weather history in the last 24 hours. Check the entity is recorded by Recorder.' : 'Loading recorded history…')
        : (src.error ? `Hourly forecast unavailable: ${src.error}` : src.fetchedAt ? `The forecast has no ${metric === 'precipitation' ? 'rain amounts' : metric === 'wind_speed' ? 'wind speeds' : 'temperatures'} for the next 24 hours.` : 'Waiting for the hourly forecast…');
      box.innerHTML = empty(msg, !!src.error);
      return;
    }
    const sel = W.nearestIndex(chart.coords, selectedTime ?? chart.coords[0].time);
    const p = chart.coords[sel];
    const key = history ? 'temperature' : metric;
    const unit = key === 'temperature' ? u.temp : key === 'precipitation' ? u.rain : u.wind;
    const digits = key === 'precipitation' ? 2 : 0;
    let grid = '';
    for (let i = 0; i < 4; i++) {
      const y = pad + i * (height - pad * 2) / 3;
      grid += `<line class="grid" x1="${padLeft}" x2="${width - pad}" y1="${y}" y2="${y}"/><text x="${padLeft - 6}" y="${y + 4}" text-anchor="end">${format(chart.max - i * (chart.max - chart.min) / 3, digits)}</text>`;
    }
    const ticks = narrow ? 4 : 6;
    for (let i = 0; i < ticks; i++) {
      const q = chart.coords[Math.round(i * (chart.coords.length - 1) / (ticks - 1))];
      grid += `<text x="${q.x.toFixed(1)}" y="${height - 6}" text-anchor="${i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle'}">${esc(timeLabel(q.time, { minute: undefined }))}</text>`;
    }
    let bars = '';
    if (!history && key === 'temperature') {
      const bw = Math.max(3, Math.min(10, (width - padLeft - pad) / chart.coords.length * 0.5));
      for (const q of chart.coords) {
        const prob = number(q.forecast.precipitation_probability);
        if (prob !== null && prob > 0) bars += `<rect class="bar" x="${(q.x - bw / 2).toFixed(1)}" y="${(bottom - prob / 100 * (height - pad * 2) * 0.5).toFixed(1)}" width="${bw.toFixed(1)}" height="${(prob / 100 * (height - pad * 2) * 0.5).toFixed(1)}" rx="2"/>`;
      }
    }
    const f = p.forecast || {};
    const cells = history
      ? `<div><div class="label">Temperature</div><div class="value">${format(p.value, 1)}${unitSpan(p.value, u.temp)}</div></div><div><div class="label">Pressure</div><div class="value">${format(nearestPressure(p.time), u.pressure === 'inHg' ? 2 : 0)}${unitSpan(nearestPressure(p.time), u.pressure)}</div></div>`
      : [['Temperature', f.temperature, u.temp, 0], ['Rain chance', f.precipitation_probability, '%', 0], ['Rain amount', f.precipitation, u.rain, 2], ['Wind', f.wind_speed, u.wind, 0]]
        .map(([label, value, un, d]) => `<div><div class="label">${label}</div><div class="value">${format(value, d)}${unitSpan(value, un)}</div></div>`).join('');
    const legend = !history && key === 'temperature' && bars ? ' · bars: chance of rain (0–100%)' : !history && key === 'temperature' ? ' · the forecast gives no chance of rain' : '';
    box.innerHTML = `
      <div class="chart-unit">${esc(unit)}${legend}</div>
      <svg class="chart" id="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${history ? 'Recorded temperature' : `Hourly ${key.replace('_', ' ')}`} chart. Tap or drag on it, or use the slider, to read exact values below.">
        ${grid}<path class="area" d="${chart.area}"/>${bars}<path class="curve" d="${chart.line}"/>
        <line class="cursor" x1="${p.x.toFixed(1)}" x2="${p.x.toFixed(1)}" y1="${pad}" y2="${bottom}"/><circle class="point" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5"/>
      </svg>
      <label class="hour-control">${history ? 'Recorded time' : 'Forecast hour'}<input id="hour-slider" type="range" min="0" max="${chart.coords.length - 1}" value="${sel}" aria-valuetext="${esc(timeLabel(p.time, { weekday: 'short' }))}"></label>
      <div class="selection" aria-live="polite"><div><div class="selected-date">${esc(timeLabel(p.time, { weekday: 'short' }))}</div><div class="small muted">${history ? 'Recorded by Home Assistant' : esc(W.conditionText(f.condition))}</div></div>${cells}</div>`;

    const slider = $('hour-slider');
    slider.oninput = () => { selectedTime = chart.coords[Number(slider.value)].time; renderChart(); $('hour-slider').focus({ preventScroll: true }); };
    const svg = $('chart-svg');
    const pick = e => {
      const r = svg.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width * width;
      let best = 0;
      chart.coords.forEach((q, i) => { if (Math.abs(q.x - x) < Math.abs(chart.coords[best].x - x)) best = i; });
      if (chart.coords[best].time !== selectedTime || selectedTime === null) { selectedTime = chart.coords[best].time; renderChart(); }
    };
    svg.onpointerdown = e => { pick(e); svg.setPointerCapture?.(e.pointerId); svg.onpointermove = pick; };
    svg.onpointerup = svg.onpointercancel = () => { svg.onpointermove = e => { if (e.pointerType === 'mouse') pick(e); }; };
    svg.onpointermove = e => { if (e.pointerType === 'mouse') pick(e); };
  }

  function nearestPressure(time) {
    const pts = (snap.history.data || []).filter(p => p.pressure !== null);
    if (!pts.length) return null;
    return pts.reduce((a, b) => Math.abs(b.t - time) < Math.abs(a.t - time) ? b : a).pressure;
  }

  for (const b of document.querySelectorAll('[data-metric]')) {
    b.onclick = () => {
      metric = b.dataset.metric;
      for (const o of document.querySelectorAll('[data-metric]')) o.setAttribute('aria-pressed', String(o === b));
      if (metric === 'history' || (selectedTime !== null && selectedTime < snap.now - 3600_000)) selectedTime = null;
      renderChart();
    };
  }
  let chartWidth = 0;
  new ResizeObserver(entries => {
    const w = Math.round(entries[0]?.contentRect.width || 0);
    if (snap && w && w !== chartWidth) { chartWidth = w; renderChart(); }
  }).observe($('chart'));

  // ---- daily, air, sun, station -------------------------------------------------
  function renderDaily() {
    const src = snap.daily, u = units();
    const days = (src.data || []).slice(0, 7);
    if (!days.length) {
      $('daily').innerHTML = empty(src.error ? `Daily forecast unavailable: ${src.error}` : src.fetchedAt ? 'The forecast has no daily periods.' : 'Waiting for the daily forecast…', !!src.error);
      return;
    }
    const bounds = days.flatMap(d => [number(d.templow), number(d.temperature)]).filter(n => n !== null);
    const min = bounds.length ? Math.min(...bounds) : 0, span = bounds.length ? Math.max(1, Math.max(...bounds) - min) : 1;
    const todayKey = dayKey(snap.now);
    $('daily').innerHTML = `<div class="col-note"><span>Low / high ${esc(u.temp)}</span><span>Rain</span></div><div class="days">${days.map(d => {
      const low = number(d.templow), high = number(d.temperature), prob = number(d.precipitation_probability);
      const name = dayKey(d.datetime) === todayKey ? 'Today' : timeLabel(d.datetime, { weekday: 'short', hour: undefined, minute: undefined });
      const bar = low !== null && high !== null ? `<i class="range-bar" style="left:${((low - min) / span * 100).toFixed(1)}%;width:${Math.max(3, (high - low) / span * 100).toFixed(1)}%"></i>` : '';
      return `<div class="day" title="${esc(W.conditionText(d.condition))}"><span class="name">${esc(name)}</span>${weatherGlyph(d.condition)}<span class="low">${format(low)}°</span><div class="range-track">${bar}</div><span class="high">${format(high)}°</span><span class="rain-chance">${prob === null ? '—' : `${format(prob)}%`}</span></div>`;
    }).join('')}</div><div class="source-line">Received ${esc(W.age(src.fetchedAt, snap.now))}. A dash means the forecast doesn’t include that value.${retainedNote(src)}</div>`;
  }

  function renderAir() {
    const src = snap.air, a = src.data;
    const head = '<div class="card-head"><h2>Air quality</h2><span class="card-tag">US AQI · model</span></div>';
    if (src.disabled) { $('air').innerHTML = head + empty('Turned off in the app’s settings.'); return; }
    if (!a) { $('air').innerHTML = head + empty(src.error ? `Air quality unavailable: ${src.error}` : 'Loading regional air quality…', !!src.error); return; }
    const cat = W.aqiCategory(a.aqi);
    $('air').innerHTML = `${head}
      <div class="aq-value" style="color:var(--aqi-${cat.key})">${format(a.aqi)}</div>
      <div class="aq-status" style="color:var(--aqi-${cat.key})">${esc(cat.label)}</div>
      <div class="aq-bar" role="img" aria-label="AQI scale">${a.aqi !== null ? `<i style="left:${Math.max(0, Math.min(99, a.aqi / 500 * 100)).toFixed(1)}%"></i>` : ''}</div>
      <div class="aq-pollutants"><span>PM₂.₅ <strong>${format(a.pm25, 1)}</strong></span><span>PM₁₀ <strong>${format(a.pm10, 1)}</strong></span><span class="muted">µg/m³</span></div>
      <div class="source-line">CAMS via Open-Meteo · valid ${esc(timeLabel(a.time))} · fetched ${esc(W.age(src.fetchedAt, snap.now))}${retainedNote(src)}</div>`;
  }

  function renderSolar() {
    const src = snap.sun, s = src.data;
    const head = '<div class="card-head"><h2>Sun &amp; daylight</h2><span class="card-tag">Home Assistant</span></div>';
    if (!s) { $('solar').innerHTML = head + empty(src.error ? `Sun data unavailable: ${src.error}` : 'Loading sun position…', !!src.error); return; }
    const el = number(s.elevation), az = number(s.azimuth);
    // Sky seen from the home: east on the left, west on the right; height is
    // the sun's elevation.
    let sun = '';
    if (el !== null && az !== null) {
      const x = 20 + Math.max(0, Math.min(1, (az - 45) / 270)) * 240;
      const y = 78 - Math.max(-12, Math.min(90, el)) / 90 * 62;
      sun = `<circle class="${el > 0 ? 'sun-up' : 'sun-down'}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7"/>`;
    }
    const up = s.state === 'above_horizon';
    const nextEvent = up ? s.next_setting : s.next_rising;
    const mins = Math.round((Date.parse(nextEvent) - snap.now) / 60000);
    const until = Number.isFinite(mins) && mins >= 0 ? `${up ? 'Sunset' : 'Sunrise'} in ${mins >= 60 ? `${Math.floor(mins / 60)} h ` : ''}${mins % 60} min` : '';
    $('solar').innerHTML = `${head}
      <svg class="sky" viewBox="0 0 280 96" role="img" aria-label="Sun ${el !== null ? `${format(el, 1)} degrees ${el >= 0 ? 'above' : 'below'} the horizon` : 'position unavailable'}">
        <path class="dome" d="M20 78A120 62 0 0 1 260 78Z"/><line class="horizon" x1="10" x2="270" y1="78" y2="78"/>
        <text x="20" y="92">E</text><text x="140" y="92" text-anchor="middle">S</text><text x="260" y="92" text-anchor="end">W</text>${sun}</svg>
      <div class="solar-labels"><div>Next sunrise<strong>${esc(timeLabel(s.next_rising))}</strong></div><div>Next sunset<strong>${esc(timeLabel(s.next_setting))}</strong></div></div>
      <div class="daylight">${until ? esc(until) + ' · ' : ''}elevation ${format(el, 1)}°, azimuth ${format(az)}°</div>
      <div class="source-line">sun.sun · ${up ? 'above' : s.state === 'below_horizon' ? 'below' : 'unknown position relative to'} the horizon${retainedNote(src)}</div>`;
  }

  function renderStation() {
    const src = snap.station, s = src.data, u = units();
    if (src.disabled) { $('station').innerHTML = empty('NWS is turned off in the app’s settings.'); return; }
    if (!s) { $('station').innerHTML = empty(src.error ? `Station observation unavailable: ${src.error}` : 'Loading the nearest NWS observation…', !!src.error); return; }
    const stale = snap.now - Date.parse(s.timestamp) > 3 * 3600_000;
    const imperial = W.imperial(u);
    const vis = s.visibilityM === null ? null : imperial ? s.visibilityM / 1609.344 : s.visibilityM / 1000;
    const values = [
      ['Temperature', W.fromC(s.tempC, u.temp), u.temp, 1],
      ['Dew point', W.fromC(s.dewC, u.temp), u.temp, 1],
      ['Humidity', s.rh, '%', 0],
      ['Wind', W.fromKmh(s.windKmh, u.wind), u.wind, 0],
      ['Gust', W.fromKmh(s.gustKmh, u.wind), u.wind, 0],
      ['Wind from', s.dirDeg, s.dirDeg === null ? '' : `° ${W.compass(s.dirDeg)}`, 0],
      [s.pressureKind === 'sea' ? 'Sea-level pressure' : 'Station pressure', W.fromPa(s.pressurePa, u.pressure), u.pressure, u.pressure === 'inHg' ? 2 : 0],
      ['Visibility', vis, imperial ? 'mi' : 'km', 1],
    ];
    $('station').innerHTML = `<div class="station-head"><strong>${esc(s.name || s.id)}</strong> (${esc(s.id)}) · ${format(W.fromKm(s.distanceKm, u), 0)} ${W.distanceUnit(u)} from your area<br>${esc(s.text || 'Observation')} · observed ${esc(W.age(s.timestamp, snap.now))}${stale ? ' · <span class="stale-tag">STALE</span>' : ''}${retainedNote(src)}</div>
      <div class="station-grid">${values.map(([label, value, unit, d]) => `<div><div class="label">${esc(label)}</div><span class="value">${format(value, d)}${unitSpan(value, unit)}</span></div>`).join('')}</div>`;
  }

  function renderFooter() {
    const part = (name, src) => {
      if (src.disabled) return `${name}: off`;
      if (src.error && !src.data) return `${name}: unavailable`;
      if (src.error) return `${name}: retrying`;
      if (src.fetchedAt) return `${name}: ${W.age(src.fetchedAt, snap.now)}`;
      return `${name}: loading`;
    };
    $('source-status').textContent = [part('Home Assistant', snap.weather), part('Forecast', snap.hourly), part('Radar', snap.radar), part('NWS', snap.alerts), part('Air', snap.air)].join(' · ');
  }

  // ---- radar --------------------------------------------------------------------
  // Each radar frame is its own tile layer, created once and kept, so playing
  // the animation only changes which layer is visible (no re-downloading or
  // flicker). The base map stays put.
  const radar = (() => {
    const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
    const ESRI_ATTR = 'Tiles © <a href="https://www.esri.com/" target="_blank" rel="noopener noreferrer">Esri</a> — Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS user community';
    const RV_ATTR = 'Radar © <a href="https://www.rainviewer.com/" target="_blank" rel="noopener noreferrer">RainViewer</a>';
    let map = null, base = null, labels = null, marker = null, home = null, dark = null;
    let frames = [], host = '', index = 0, playing = false, timer = null, userMoved = false;
    const layers = new Map(); // frame path -> tile layer
    let tileErrors = 0;

    function init() {
      if (map || !window.L) return;
      try {
        map = L.map('map', { zoomSnap: 1, minZoom: 3, maxZoom: 10, worldCopyJump: true, attributionControl: true });
        map.attributionControl.setPrefix('<a href="https://leafletjs.com/" target="_blank" rel="noopener noreferrer">Leaflet</a>');
        map.createPane('labels').classList.add('labels-pane');
        map.getPane('labels').style.zIndex = 450;
        const Home = L.Control.extend({
          options: { position: 'topleft' },
          onAdd() {
            const div = L.DomUtil.create('div', 'leaflet-bar');
            div.innerHTML = '<button type="button" class="home" aria-label="Back to your area" title="Back to your area"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8m8.94 3A9 9 0 0 0 13 3.06V1h-2v2.06A9 9 0 0 0 3.06 11H1v2h2.06A9 9 0 0 0 11 20.94V23h2v-2.06A9 9 0 0 0 20.94 13H23v-2zM12 19a7 7 0 1 1 0-14 7 7 0 0 1 0 14"/></svg></button>';
            L.DomEvent.disableClickPropagation(div);
            div.querySelector('button').onclick = () => { userMoved = false; if (home) map.setView([home.lat, home.lon], 7); };
            return div;
          },
        });
        new Home().addTo(map);
        map.on('dragstart', () => { userMoved = true; });
        new ResizeObserver(() => map.invalidateSize()).observe($('map'));
        setTheme(isDark());
      } catch (e) {
        console.error(e);
        map = null;
        note('The map couldn’t load. Everything else still works; reload to try again.');
      }
    }

    function setTheme(isDarkNow) {
      if (!map || dark === isDarkNow) return;
      dark = isDarkNow;
      base?.remove();
      labels?.remove();
      const style = dark ? 'Dark' : 'Light';
      base = L.tileLayer(`${ESRI}/World_${style}_Gray_Base/MapServer/tile/{z}/{y}/{x}`, { attribution: ESRI_ATTR, maxNativeZoom: 16, maxZoom: 10 }).addTo(map);
      labels = L.tileLayer(`${ESRI}/World_${style}_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { pane: 'labels', maxNativeZoom: 16, maxZoom: 10 }).addTo(map);
    }

    function note(msg) {
      $('radar-error').hidden = !msg;
      $('radar-error').textContent = msg || '';
    }

    function layerFor(frame) {
      let layer = layers.get(frame.path);
      if (!layer) {
        // RainViewer serves radar to zoom 7; closer zooms enlarge those tiles.
        layer = L.tileLayer(`${host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, { opacity: 0, maxNativeZoom: 7, maxZoom: 10, zIndex: 10, attribution: RV_ATTR, crossOrigin: false });
        layer.on('tileerror', () => { tileErrors++; if (tileErrors > 3) note('Some radar tiles didn’t load. The frame may be incomplete.'); });
        layer.on('load', () => { if (tileErrors && layer.options.opacity > 0) { tileErrors = 0; note(radarError()); } });
        layers.set(frame.path, layer);
        layer.addTo(map);
      }
      return layer;
    }

    let lastSrc = null;
    const radarError = () => lastSrc?.error ? (lastSrc.data ? `Radar refresh failed (${lastSrc.error}); showing the last frames.` : `Radar unavailable: ${lastSrc.error}`) : '';

    function show(i) {
      if (!frames.length || !map) return;
      index = (i + frames.length) % frames.length;
      const frame = frames[index];
      layerFor(frame).setOpacity(0.75);
      for (const [path, layer] of layers) if (path !== frame.path) layer.setOpacity(0);
      if (playing) layerFor(frames[(index + 1) % frames.length]); // fetch the next frame's tiles ahead of time
      $('scrub').value = String(index);
      $('frame-time').textContent = timeLabel(frame.time * 1000);
      const old = Date.now() - frame.time * 1000 > 25 * 60_000;
      $('frame-age').innerHTML = `Frame ${index + 1} of ${frames.length} · ${esc(W.age(frame.time * 1000))}${old && index === frames.length - 1 ? ' · <span class="warn-text">latest frame is stale</span>' : ''}`;
      $('scrub').setAttribute('aria-valuetext', `${timeLabel(frame.time * 1000)}, ${W.age(frame.time * 1000)}`);
    }

    function play(on) {
      clearInterval(timer);
      playing = on && frames.length > 1;
      $('play').setAttribute('aria-label', playing ? 'Pause radar animation' : 'Play radar animation');
      $('play').querySelector('path').setAttribute('d', playing ? 'M6 5h4v14H6zm8 0h4v14h-4z' : 'M8 5v14l11-7z');
      if (playing) {
        if (index === frames.length - 1) show(0);
        timer = setInterval(() => {
          // Hold a moment on the latest frame before looping.
          show(index + 1);
        }, 700);
      }
    }

    function update(point, src) {
      init();
      lastSrc = src;
      if (!map) return;
      if (point && (!home || home.lat !== point.lat || home.lon !== point.lon)) {
        home = point;
        marker?.remove();
        marker = L.circleMarker([point.lat, point.lon], { radius: 7, color: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3987e5', weight: 2, fillOpacity: 0.15, interactive: false }).addTo(map);
        if (!userMoved) map.setView([point.lat, point.lon], 7);
      } else if (!home) {
        map.setView([39.5, -98.35], 4);
      }
      const data = src?.data;
      if (!data?.frames?.length) {
        $('frame-age').textContent = src?.loading || (!src?.error && !src?.fetchedAt) ? 'Waiting for the radar feed' : 'No radar frames';
        note(radarError());
        return;
      }
      const changed = host !== data.host || frames.length !== data.frames.length || frames.some((f, i) => f.path !== data.frames[i].path);
      if (changed) {
        const wanted = new Set(data.frames.map(f => f.path));
        for (const [path, layer] of layers) if (!wanted.has(path) || host !== data.host) { layer.remove(); layers.delete(path); }
        const atLatest = !frames.length || index === frames.length - 1;
        host = data.host;
        frames = data.frames;
        $('scrub').max = String(frames.length - 1);
        $('scrub').disabled = false;
        $('play').disabled = frames.length < 2;
        show(atLatest || !playing ? frames.length - 1 : Math.min(index, frames.length - 1));
      }
      note(radarError());
    }

    $('play').onclick = () => play(!playing);
    $('scrub').oninput = e => { play(false); show(Number(e.target.value)); };
    document.addEventListener('keydown', e => {
      if (e.target.closest?.('input, textarea')) return;
      if (e.key === ' ' && e.target === $('map')) { e.preventDefault(); play(!playing); }
    });

    return { update, setTheme, play };
  })();

  applyTheme();
  load();
})();
