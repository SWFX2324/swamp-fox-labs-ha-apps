'use strict';
// Ham Radio Dashboard front end. All API paths are relative so the page works
// behind Home Assistant ingress (/api/hassio_ingress/<token>/).

(() => {
  const $ = sel => document.querySelector(sel);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const SVGNS = 'http://www.w3.org/2000/svg';

  const state = {
    defaults: { callsign: '', grid: '', distance_units: 'mi', admin: true },
    settings: loadSettings(),
    solar: null, iono: [], spots: null, psk: null, cycle: null, land: null,
    bandFilter: storeGet('hamdash.band') || '',
  };

  // ------------------------------------------------------------ storage

  function storeGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function storeSet(key, val) { try { val == null ? localStorage.removeItem(key) : localStorage.setItem(key, val); } catch { /* private mode */ } }
  function loadSettings() { try { return JSON.parse(storeGet('hamdash.settings')) || {}; } catch { return {}; } }

  function station() {
    const s = state.settings, d = state.defaults;
    return {
      callsign: (s.callsign || d.callsign || '').toUpperCase(),
      grid: s.grid || d.grid || '',
      units: s.units || d.distance_units || 'mi',
      type: d.station_type || 'amateur',
      time: s.time === 'utc' ? 'utc' : 'local',
    };
  }

  // Fetch JSON from the app. Errors carry the server's own message, or say
  // plainly that the app can't be reached.
  async function api(path, opts) {
    let r;
    try { r = await fetch(path, { cache: 'no-store', ...opts }); } catch {
      $('#offlineBanner').hidden = false;
      throw new Error('Can’t reach the dashboard app. It may be restarting.');
    }
    $('#offlineBanner').hidden = true;
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error(body?.error || `The app answered with an error (HTTP ${r.status}).`);
    return body;
  }

  // ------------------------------------------------------------ geo + sun math

  const {
    RAD, gridToLatLon, latLonToGrid, distanceKm, bearingDeg, compass,
    sunPosition, sunAltitude, sunTimes, HF_BANDS, RATING, rateBand,
  } = HamCore;
  const nearestIonosonde = pos => HamCore.nearestIonosonde(pos, state.iono);

  function fmtDist(km) {
    if (km == null) return '—';
    const mi = station().units === 'mi';
    return `${Math.round(mi ? km * 0.621371 : km).toLocaleString()} ${mi ? 'mi' : 'km'}`;
  }

  // ------------------------------------------------------------ formatting

  const pad = n => String(n).padStart(2, '0');
  const utcHM = d => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  // Times follow the Time setting: this device's local time (12- or 24-hour,
  // as the device prefers), or UTC in 24-hour form marked Z, the way hams log.
  const useUtc = () => station().time === 'utc';
  const clockHM = d => (useUtc() ? `${utcHM(d)}Z` : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const clockHour = t => (useUtc() ? `${pad(new Date(t).getUTCHours())}Z` : new Date(t).toLocaleTimeString([], { hour: 'numeric' }));
  const clockDayHour = t => {
    const d = new Date(t);
    return useUtc() ? `${d.toLocaleDateString([], { weekday: 'short', timeZone: 'UTC' })} ${pad(d.getUTCHours())}Z` : d.toLocaleString([], { weekday: 'short', hour: 'numeric' });
  };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const utcDay = d => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  const ago = t => {
    const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
    if (s < 90) return 'just now';
    if (s < 5400) return `${Math.round(s / 60)} min ago`;
    if (s < 129600) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  };

  // Browsers only share location with https pages, so Home Assistant opened
  // over plain http can't use it.
  const locationUnavailable = () =>
    !window.isSecureContext ? 'Your browser only shares your location with https pages, and Home Assistant is open over http. Enter your grid square instead.'
    : !navigator.geolocation ? 'Location isn’t available in this browser. Enter your grid square instead.'
    : null;
  const locationError = e =>
    e?.code === 1 ? 'Location access was blocked for this page. Allow it in the browser, or enter your grid square instead.'
    : 'Couldn’t get your location. Enter your grid square instead.';

  // ------------------------------------------------------------ tooltip

  const tip = $('#tooltip');
  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let left = x + 14, top = y + 14;
    if (left + r.width > innerWidth - 8) left = x - r.width - 14;
    if (top + r.height > innerHeight - 8) top = y - r.height - 14;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  }
  const hideTip = () => { tip.hidden = true; };
  const tipRow = (k, v) => `<div class="row"><span class="k">${esc(k)}</span><b>${v}</b></div>`;

  // ------------------------------------------------------------ status scales

  const RATING_LABEL = { closed: 'Closed', poor: 'Poor', fair: 'Fair', good: 'Good' };
  const pill = (cls, label, title = '') => `<span class="pill s-${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</span>`;
  const ratingPill = (r, title) => (r ? pill(r, RATING_LABEL[r], title) : pill('none', 'n/a', title));
  const hamqslPill = v => {
    const k = String(v || '').toLowerCase();
    return RATING.includes(k) ? pill(k, RATING_LABEL[k]) : pill('none', v || 'n/a');
  };

  function kpStatus(kp) {
    if (kp == null) return { cls: 'none', label: 'n/a', color: css('--closed') };
    if (kp < 3) return { cls: 'good', label: 'Quiet', color: css('--good') };
    if (kp < 4) return { cls: 'good', label: 'Unsettled', color: css('--good') };
    if (kp < 5) return { cls: 'fair', label: 'Active', color: css('--warning') };
    if (kp < 6) return { cls: 'serious', label: 'G1 minor storm', color: css('--serious') };
    if (kp < 7) return { cls: 'serious', label: 'G2 moderate storm', color: css('--serious') };
    if (kp < 8) return { cls: 'poor', label: 'G3 strong storm', color: css('--critical') };
    if (kp < 9) return { cls: 'poor', label: 'G4 severe storm', color: css('--critical') };
    return { cls: 'poor', label: 'G5 extreme storm', color: css('--critical') };
  }

  function scaleColor(n) {
    if (!n) return css('--good');
    if (n <= 2) return css('--warning');
    if (n === 3) return css('--serious');
    return css('--critical');
  }

  function currentKp() {
    const kp = state.solar?.kp;
    if (kp?.length) {
      const now = Date.now();
      const past = kp.filter(k => k.kind !== 'predicted' && Date.parse(k.time) <= now);
      if (past.length) return past[past.length - 1].kp;
    }
    return state.solar?.hamqsl?.k ?? null;
  }

  // ------------------------------------------------------------ header / clocks

  function tickClocks() {
    const now = new Date();
    $('#clockUtc').textContent = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
    $('#clockLocal').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function renderHeader() {
    const st = station();
    $('#hdrCall').textContent = st.callsign || (st.type === 'listener' ? 'Listener' : st.type === 'gmrs' ? 'GMRS' : 'Set callsign');
    $('#hdrGrid').textContent = st.grid || 'Set grid';
    // Flag when this browser isn't using the app's configuration.
    const o = overrides();
    $('#hdrOverride').hidden = !o.length;
    $('#stationBtn').title = o.length ? `Settings · this browser uses its own ${o.join(' and ')}; Home Assistant sensors use the app’s` : 'Settings';
    $('#pskCall').textContent = st.callsign || 'you';
  }

  // ------------------------------------------------------------ solar tiles

  // termKey makes the label a tappable glossary term.
  function tile(label, value, unit, sub, extra = '', termKey = null) {
    return `<div class="tile"><span class="label">${termKey ? term(termKey, label) : esc(label)}${extra}</span>
      <span class="value">${value == null || value === '' ? '—' : esc(value)}${unit && value != null ? `<span class="unit">${esc(unit)}</span>` : ''}</span>
      <span class="sub" title="${esc(sub)}">${esc(sub || '')}</span></div>`;
  }

  function renderTiles() {
    const s = state.solar;
    if (!s) return;
    const h = s.hamqsl || {}, w = s.wind || {}, x = s.xray || {};
    const kp = currentKp();
    const ks = kpStatus(kp);
    const bz = w.bz ?? h.bz;
    $('#tiles').innerHTML = [
      tile('Solar flux (SFI)', h.sfi ?? w.f107, '', '10.7 cm radio flux', '', 'sfi'),
      tile('Sunspot number', h.ssn, '', 'Daily SSN', '', 'ssn'),
      tile('A-index', h.a, '', h.geomagfield ? `Field ${h.geomagfield.toLowerCase()}` : 'Daily geomagnetic', '', 'aindex'),
      tile('K-index', kp == null ? null : (Math.round(kp * 100) / 100).toString(), '', ks.label, ' ' + pill(ks.cls, ks.cls === 'good' ? 'OK' : ks.cls === 'fair' ? 'Active' : 'Storm'), 'kindex'),
      tile('X-ray flux', x.current || h.xray, '', x.max6h ? `6 h peak ${x.max6h}` : 'GOES 0.1–0.8 nm', '', 'xray'),
      tile('Solar wind', w.speed ?? h.solarwind, 'km/s', w.bt != null ? `Bt ${w.bt} nT` : 'Proton speed', '', 'solarwind'),
      tile('Bz (IMF)', bz, 'nT', bz == null ? '' : bz < 0 ? 'Southward: storms more likely' : 'Northward: quieter', '', 'bz'),
      tile('Noise floor', h.signalnoise, '', 'Estimated band noise', '', 'noise'),
    ].join('');
    $('#solarUpdated').textContent = h.updated ? `HamQSL updated ${h.updated}` : '';
  }

  // ------------------------------------------------------------ NOAA R/S/G

  function renderScales() {
    const sc = state.solar?.scales;
    if (!sc?.current) { $('#rsg').innerHTML = '<div class="empty">NOAA scales unavailable</div>'; return; }
    const names = { R: 'Radio blackouts', S: 'Radiation storms', G: 'Geomagnetic storms' };
    $('#rsg').innerHTML = ['R', 'S', 'G'].map(k => {
      const v = sc.current[k] || {};
      const n = v.scale ?? 0;
      return `<div class="scale" style="--c:${scaleColor(n)}">
        <div class="letter">${term('rsg', names[k])}</div>
        <div class="big">${k}${n}</div>
        <div class="desc">${esc(v.text && v.text !== 'none' ? v.text : 'None')}</div></div>`;
    }).join('');
    const y = sc.yesterday;
    $('#rsgDate').textContent = y ? `Yesterday's max: R${y.R.scale ?? 0} S${y.S.scale ?? 0} G${y.G.scale ?? 0}` : '';
    const pct = v => (v == null ? '—' : `${v}%`);
    $('#rsgForecast').innerHTML = `<thead><tr><th>Forecast</th><th>R1–R2</th><th>R3+</th><th>S1+</th><th>G max</th></tr></thead><tbody>${
      sc.forecast.map(f => `<tr><td>${esc(utcDay(new Date(f.date + 'T12:00:00Z')))}</td><td>${pct(f.R.minorProb)}</td><td>${pct(f.R.majorProb)}</td><td>${pct(f.S.prob)}</td><td>G${f.G.scale ?? 0}</td></tr>`).join('')
    }</tbody>`;
  }

  // ------------------------------------------------------------ bands

  function activityCell(a) {
    if (!a) return '<span class="meta">—</span>';
    if (!a.stations) return '<span class="meta">0</span>';
    const title = a.farthest ? `Farthest: ${a.farthest.call} (${a.farthest.country || a.farthest.grid}), ${fmtDist(a.farthest.km)}` : '';
    return `<span class="mono" title="${esc(title)}">${a.stations}</span><div class="sub">${a.dx ? `${esc(a.dx)} DX` : 'local'}${a.farthest ? ` · ${fmtDist(a.farthest.km)}` : ''}</div>`;
  }

  const posKey = pos => `${pos.lat.toFixed(4)},${pos.lon.toFixed(4)}`;

  // "At your QTH": the server's estimate for this grid (a fresh ionosonde, or
  // the model when none is near), or the nearest fresh ionosonde until it
  // arrives.
  function localEstimate(pos) {
    if (!pos) return null;
    if (state.local?.key === posKey(pos)) return state.local;
    const iono = nearestIonosonde(pos);
    return iono ? { source: 'ionosonde', muf: iono.mufd, station: { name: iono.name, km: iono.dist, time: iono.time } } : null;
  }

  function renderBands() {
    const h = state.solar?.hamqsl;
    const pos = gridToLatLon(station().grid);
    const sunAlt = pos ? sunAltitude(sunPosition(new Date()), pos.lat, pos.lon) : null;
    const isDay = sunAlt == null ? new Date().getUTCHours() >= 12 && new Date().getUTCHours() < 24 : sunAlt > -0.833;
    const est = localEstimate(pos);
    const mufLabel = est && `${est.source === 'model' ? 'model ' : ''}MUF`;
    const kp = currentKp();
    const groups = Object.fromEntries((h?.bands || []).map(b => [b.name, b]));

    const act = state.activity;
    const head = `<thead><tr><th>Band</th><th class="freq">MHz</th>
      <th>At your QTH now<small>${est ? `${est.source === 'model' ? 'model ' : ''}${term('muf', 'MUF')} ${est.muf.toFixed(1)} MHz` : pos ? 'unavailable' : 'set grid'}</small></th>
      <th class="num">${term('psk', 'Heard nearby')}<small>last ${act?.windowMin ?? 15} min</small></th>
      <th class="${isDay ? 'now' : 'hide-sm'}">${term('hamqsl', 'HamQSL day')}${isDay ? '<small>now</small>' : '<small>&nbsp;</small>'}</th>
      <th class="${!isDay ? 'now' : 'hide-sm'}">HamQSL night${!isDay ? '<small>now</small>' : '<small>&nbsp;</small>'}</th></tr></thead>`;
    const body = HF_BANDS.map(([name, mhz, group]) => {
      const g = groups[group];
      const r = est ? rateBand(mhz, est.muf, sunAlt ?? 0, kp ?? 0) : null;
      const why = est ? `${mhz} MHz vs ${mufLabel} ${est.muf.toFixed(1)} MHz${name === '160m' && sunAlt > 0 ? ' (160 m needs darkness for DX)' : ''}` : '';
      return `<tr><td class="band">${name}</td><td class="freq">${mhz}</td>
        <td>${ratingPill(r, why)}</td>
        <td class="num">${activityCell(act?.bands?.[name])}</td>
        <td class="${isDay ? '' : 'dim hide-sm'}">${g ? hamqslPill(g.day) : '<span class="meta">—</span>'}</td>
        <td class="${!isDay ? '' : 'dim hide-sm'}">${g ? hamqslPill(g.night) : '<span class="meta">—</span>'}</td></tr>`;
    }).join('');
    $('#bandsTable').innerHTML = head + `<tbody>${body}</tbody>`;
    $('#bandsMeta').textContent = sunAlt == null ? '' : `Sun ${sunAlt >= 0 ? 'up' : 'down'} at QTH (${sunAlt.toFixed(0)}°)`;

    let note = 'HamQSL ratings are N0NBH’s global estimates for band pairs. ';
    if (est?.source === 'ionosonde') {
      const s = est.station;
      note += `“At your QTH” is an estimate from the ${s.name} ionosonde (${fmtDist(s.km)} away, measured ${ago(s.time)}), with daytime absorption and the current Kp of ${kp ?? '?'} factored in. `;
    } else if (est) {
      const n = est.nearest;
      note += `No ionosonde within ${fmtDist(3000)} has reported in the last 3 hours${n ? ` (the nearest recent one, ${n.name}, ${fmtDist(n.km)} away, last reported ${ago(n.time)})` : ''}, so “At your QTH” comes from the propagation model: the sunspot number and the sun’s height at your QTH, ${est.anchors ? `scaled by how ${est.anchors} live ionosondes elsewhere compare with it` : 'with no live ionosondes to check it against'}. It’s a rougher estimate; “Heard nearby” is the reality check. `;
    } else if (pos) {
      note += 'The local estimate isn’t available right now. ';
    } else {
      note += 'Set your grid square for a local estimate. ';
    }
    if (!act && state.activityError) {
      note += `“Heard nearby” needs PSKReporter, which isn’t available right now: ${sourceReason(state.activityError)}. It fills in once PSKReporter answers.`;
    } else if (act) {
      note += `“Heard nearby” is measured: distinct stations that PSKReporter monitors within ${fmtDist(act.radiusKm)} of you decoded in the last ${act.windowMin} minutes (mostly FT8/FT4), with how many were DX (over ${fmtDist(act.dxKm)} away). Zero can also mean nobody nearby is listening on that band.`;
    }
    $('#bandsNote').textContent = note;
    renderBandsNext(pos);
  }

  const inTime = ms => {
    const m = Math.round(ms / 60000);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  };

  // What the bands usually do at the next sunrise or sunset at the QTH. A
  // rule of thumb from the sun, not a forecast: only the current MUF is measured.
  function renderBandsNext(pos) {
    const el = $('#bandsNext');
    if (!pos) { el.hidden = true; return; }
    const now = Date.now();
    const events = [];
    for (const day of [0, 1]) {
      const t = sunTimes(pos, new Date(now + day * 86400000));
      for (const k of ['dawn', 'sunrise', 'sunset', 'dusk']) if (t[k]) events.push({ k, t: t[k].getTime() });
    }
    events.sort((a, b) => a.t - b.t);
    const next = k => events.find(e => e.k === k && e.t > now);
    const rise = next('sunrise'), set = next('sunset');
    if (!rise && !set) { el.hidden = true; return; }
    const parts = [];
    // Civil twilight (sun between 0° and -6°) is the gray line. It ends at
    // sunrise in the morning and at dusk in the evening.
    const alt = sunAltitude(sunPosition(new Date(now)), pos.lat, pos.lon);
    const morning = rise && (!set || rise.t < set.t);
    const grayEnd = morning ? rise : next('dusk');
    if (alt < -0.833 && alt > -6 && grayEnd) {
      parts.push(`<b>Gray line now</b> until about ${esc(clockHM(new Date(grayEnd.t)))}: a good time for low-band DX along the day/night line.`);
    }
    if (!morning) {
      parts.push(`<b>Sunset ${esc(clockHM(new Date(set.t)))}</b> (in ${inTime(set.t - now)}). After dark the MUF usually falls: 17–10 m tend to close within a couple of hours, and 80 m and 160 m open up for DX.`);
    } else {
      parts.push(`<b>Sunrise ${esc(clockHM(new Date(rise.t)))}</b> (in ${inTime(rise.t - now)}). After sunrise the MUF climbs and 20 m and up open, first toward the east, while daytime absorption fades 160 m and 80 m within an hour or so.`);
    }
    el.innerHTML = parts.join(' ');
    el.hidden = false;
  }

  // ------------------------------------------------------------ VHF openings

  // Rate-limit errors in plain words; anything else as the server said it.
  const sourceReason = msg => (/429|rate limit/i.test(msg || '') ? 'it’s asking the app to slow down' : msg);

  const VHF_INFO = { '6m': { label: '6 m', mhz: '50 MHz', series: '--series-1' }, '2m': { label: '2 m', mhz: '144 MHz', series: '--series-2' } };
  const VHF_STATUS = { open: ['good', 'Open'], possible: ['fair', 'Possible'], closed: ['closed', 'Closed'], quiet: ['none', 'No reports'] };

  function vhfTile(band, b) {
    const info = VHF_INFO[band];
    // A band stays "open" through one quiet poll so a short gap doesn't end the opening.
    const [cls, label] = VHF_STATUS[b.active && b.status !== 'open' ? 'open' : b.status];
    const lines = [];
    if (b.stations) {
      lines.push(`${b.stations} station${b.stations === 1 ? '' : 's'} past ${fmtDist(b.minKm)}${b.toward ? ` · toward ${esc(b.toward)}` : ''}`);
      if (b.farthest) lines.push(`Farthest <span class="mono">${esc(b.farthest.call)}</span> (${esc(b.farthest.grid.slice(0, 4))}), ${fmtDist(b.farthest.km)}`);
      if (b.likely) lines.push(`Likely ${term(/^Tropo/.test(b.likely) ? 'tropo' : 'es', b.likely)}`);
    } else if (b.status === 'closed') {
      lines.push(`${b.monitors} monitor${b.monitors === 1 ? '' : 's'} nearby, only local paths`);
    } else {
      lines.push('Nothing decoded nearby: closed, or nobody close is listening');
    }
    if (b.openSince) lines.push(`Open since ${clockHM(new Date(b.openSince))}`);
    return `<div class="tile" style="--c:var(${info.series})">
      <span class="label"><span class="sw"></span>${esc(info.label)} <span class="meta">${info.mhz}</span></span>
      <span class="value">${pill(cls, label)}</span>
      ${lines.map(l => `<span class="sub">${l}</span>`).join('')}
    </div>`;
  }

  function renderVhf() {
    const v = state.vhf;
    const pos = gridToLatLon(station().grid);
    $('#vhfMeta').textContent = v ? `Updated ${ago(v.fetched)}` : '';
    if (!pos) {
      $('#vhfBands').innerHTML = '<p class="empty">Set your grid square to see VHF openings near you.</p>';
    } else if (!v && state.vhfError) {
      // The card still draws when PSKReporter can't be reached, and says why.
      $('#vhfBands').innerHTML = `<p class="empty">VHF openings need PSKReporter, which isn’t available right now: ${esc(sourceReason(state.vhfError))}. The app retries on its own; this fills in once PSKReporter answers.</p>`;
    } else if (!v) {
      $('#vhfBands').innerHTML = '<p class="empty">Loading…</p>';
    } else {
      $('#vhfBands').innerHTML = Object.entries(v.bands).map(([band, b]) => vhfTile(band, b)).join('');
    }
    const paths = v ? Object.entries(v.bands).flatMap(([band, b]) => b.paths.map(p => ({ band, ...p }))).sort((a, b) => b.km - a.km) : [];
    const seen = new Set();
    const rows = paths.filter(p => !seen.has(p.band + p.tx) && seen.add(p.band + p.tx)).slice(0, 10);
    $('#vhfPaths').innerHTML = rows.length
      ? `<thead><tr><th>Band</th><th>Heard</th><th>By</th><th>Distance</th><th>Mode</th></tr></thead><tbody>${rows.map(p => `<tr>
          <td>${VHF_INFO[p.band].label}</td>
          <td><span class="mono">${esc(p.tx)}</span> <span class="meta">${esc(p.txGrid.slice(0, 4))}</span></td>
          <td class="mono">${esc(p.rx)}</td><td>${fmtDist(p.km)}</td><td>${esc(p.mode)}</td></tr>`).join('')}</tbody>`
      : v ? `<tbody><tr><td class="empty">No long-distance 6 m or 2 m paths heard near you in the last ${v.windowMin} minutes.</td></tr></tbody>` : '';
    $('#vhfNote').textContent = v
      ? `Measured from PSKReporter: stations decoded in the last ${v.windowMin} minutes by monitors within ${fmtDist(v.nearKm)} of you, over paths longer than normal ground wave and tropo reach (${fmtDist(v.bands['6m'].minKm)} on 6 m, ${fmtDist(v.bands['2m'].minKm)} on 2 m). Meteor scatter (MSK144) is left out. “Open” means at least 3 distant stations, or 2 heard by 2 monitors. Most reports are FT8, so an opening often shows here before it’s heard on SSB.`
      : '';
    renderVhfStrip();
    drawVhfMap();
  }

  function drawVhfMap() {
    const el = $('#vhfMap');
    if (!el.offsetWidth) return;
    if (maps.vhf?.hover) { maps.vhf.pending = () => drawVhfMap(); return; }
    const here = gridToLatLon(station().grid);
    const v = state.vhf;
    const ends = [];
    // Frame you and every station heard, so the map isn't half empty. Reads
    // the latest draw's stations, since the home button keeps this function.
    const fit = () => {
      const mv = maps.vhf, pts = mv.ends || [];
      const qth = gridToLatLon(station().grid);
      if (!qth) { mv.map.setView([39, -98], 3); return true; }
      if (!pts.length) return fitRadius(mv, qth, 1500);
      mv.map.invalidateSize();
      if (!mv.map.getSize().y) {
        requestAnimationFrame(() => { if (mv.map.getSize().y) fit(); });
        return false;
      }
      mv.map.fitBounds(L.latLngBounds([ll(qth), ...pts.map(ll)]).pad(0.12), { padding: [12, 12], maxZoom: 7 });
      return true;
    };
    const m = makeMap('vhf', el, { world: true, home: fit });
    m.ends = ends;
    // Leaflet needs a view before lines can be added; the real fit comes after.
    if (!m.fitKey) m.map.setView(here ? ll(here) : [39, -98], 4);
    m.group.clearLayers();
    m.labels = [];
    for (const [band, b] of Object.entries(v?.bands || {})) {
      const color = css(VHF_INFO[band].series);
      const txSeen = new Set();
      for (const p of b.paths) {
        const tx = gridToLatLon(p.txGrid), rx = gridToLatLon(p.rxGrid);
        if (!tx || !rx) continue;
        ends.push(tx);
        L.polyline(greatCircle(rx, tx, 24).map(q => [q.lat, q.lon]), { color, weight: 1.5, opacity: 0.6, interactive: false }).addTo(m.group);
        dot(rx, color, { radius: 3, hollow: true }).bindTooltip(`<b class="mono">${esc(p.rx)}</b> monitor${tipRow('Grid', esc(p.rxGrid))}`, TIP).addTo(m.group);
        if (txSeen.has(p.tx)) continue;
        txSeen.add(p.tx);
        dot(tx, color, { radius: 4.5 })
          .bindTooltip(`<b class="mono">${esc(p.tx)}</b> on ${VHF_INFO[band].label}<br>${esc(p.country)}${tipRow('Grid', esc(p.txGrid))}${tipRow('Heard by', `<span class="mono">${esc(p.rx)}</span>`)}${tipRow('Path', fmtDist(p.km))}${tipRow('Mode', esc(p.mode))}${here ? tipRow('From you', `${fmtDist(distanceKm(here, tx))} ${compass(bearingDeg(here, tx))}`) : ''}`, TIP)
          .addTo(m.group);
      }
    }
    if (here) qthMarker(here, `<b class="mono">${esc(station().callsign || 'Your QTH')}</b>`).addTo(m.group);
    const fitKey = `${station().grid}|${ends.length ? 'paths' : 'none'}`;
    if (m.fitKey !== fitKey && fit() !== false) m.fitKey = fitKey;
    $('#vhfLegend').innerHTML = legendKey(`border:2px solid ${css('--text')};border-radius:50%`, 'Your QTH') +
      legendKey(`background:${css('--series-1')};border-radius:50%`, '6 m station') +
      legendKey(`background:${css('--series-2')};border-radius:50%`, '2 m station') +
      legendKey(`border:2px solid ${css('--muted')};border-radius:50%`, 'Hollow = monitor that heard it');
  }

  // HamQSL's global VHF indicators.
  function renderVhfStrip() {
    const h = state.solar?.hamqsl;
    const VHF_LABEL = {
      'vhf-aurora|northern_hemi': 'Aurora (N. hemisphere)',
      'E-Skip|north_america': '2 m Es · N. America',
      'E-Skip|europe': '2 m Es · Europe',
      'E-Skip|europe_6m': '6 m Es · Europe',
      'E-Skip|europe_4m': '4 m Es · Europe',
    };
    $('#vhf').innerHTML = (h?.vhf || []).map(v => {
      const open = !/closed/i.test(v.status);
      const label = VHF_LABEL[`${v.name}|${v.location}`] || `${v.name} ${v.location}`;
      return `<span class="item">${esc(label)} ${pill(open ? 'good' : 'closed', open ? v.status : 'Closed')}</span>`;
    }).join('');
  }

  // ------------------------------------------------------------ maps (Leaflet)

  function decodeLand(topo) {
    const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate;
    const arcs = topo.arcs.map(arc => {
      let x = 0, y = 0;
      return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * sx + tx, y * sy + ty]; });
    });
    // world-atlas rings may cross the antimeridian. Unwrap longitudes so each
    // ring is continuous, and close rings that wrap all the way around a pole
    // (Antarctica) along that pole.
    const unwrap = pts => {
      const out = [pts[0].slice()];
      for (let i = 1; i < pts.length; i++) {
        let lon = pts[i][0];
        const prev = out[i - 1][0];
        while (lon - prev > 180) lon -= 360;
        while (lon - prev < -180) lon += 360;
        out.push([lon, pts[i][1]]);
      }
      if (Math.abs(out[out.length - 1][0] - out[0][0]) > 180) {
        const pole = out.reduce((s, p) => s + p[1], 0) / out.length < 0 ? -90 : 90;
        out.push([out[out.length - 1][0], pole], [out[0][0], pole]);
      }
      return out;
    };
    const ring = idx => {
      const pts = [];
      for (const i of idx) {
        const a = i < 0 ? arcs[~i].slice().reverse() : arcs[i];
        pts.push(...(pts.length ? a.slice(1) : a));
      }
      return unwrap(pts);
    };
    const polys = [];
    for (const g of topo.objects.land.geometries) {
      for (const p of g.type === 'Polygon' ? [g.arcs] : g.arcs) polys.push(p.map(ring));
    }
    return polys;
  }

  // Size a canvas to its CSS box at device resolution; returns a 2D context.
  function fitCanvas(canvas, w, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  const legendKey = (swatch, label, termKey = null) => `<span><span class="sw" style="${swatch}"></span>${termKey ? term(termKey, label) : esc(label)}</span>`;
  const nightLegend = () => legendKey(`background:rgb(${css('--night').split(',').join(' ')} / .6)`, 'Night') +
    legendKey('background:rgb(214 160 60 / .55)', 'Gray line (civil twilight)', 'grayline') +
    legendKey('background:#fab219;border-radius:50%', 'Sun overhead');

  // Base layers. OpenStreetMap tiles (with a CSS filter for "Dark") and USGS
  // National Map imagery/topo (public domain, high resolution in the US only).
  // "Plain" draws the bundled land outline and needs no tile server.
  const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
  const USGS_ATTR = 'Imagery: <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map" target="_blank" rel="noopener">USGS The National Map</a>';
  const USGS = 'https://basemap.nationalmap.gov/arcgis/rest/services';
  const BASEMAPS = [
    ['dark', 'Dark', 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxNativeZoom: 19, attribution: OSM_ATTR, className: 'tiles-dark' }],
    ['streets', 'Streets', 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxNativeZoom: 19, attribution: OSM_ATTR }],
    ['satellite', 'Satellite (US)', `${USGS}/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}`, { maxNativeZoom: 16, attribution: USGS_ATTR }],
    ['topo', 'Topo (US)', `${USGS}/USGSTopo/MapServer/tile/{z}/{y}/{x}`, { maxNativeZoom: 16, attribution: USGS_ATTR }],
    ['plain', 'Plain (offline)', null, {}],
  ];
  const TIP = { direction: 'top', offset: [0, -6], className: 'map-tip', opacity: 1 };
  const maps = {};

  // Night and gray-line shading, computed per tile from the sun's altitude so
  // it lines up exactly at any zoom. refresh() moves it to "now".
  const NightLayer = L.GridLayer.extend({
    options: { zIndex: 5, updateWhenZooming: false },
    refresh() {
      this.sun = sunPosition(new Date());
      this.rgb = css('--night').split(',').map(Number);
      this.redraw();
    },
    createTile(coords) {
      const S = 64, step = this.getTileSize().x / S;
      const tile = document.createElement('canvas');
      tile.width = tile.height = S;
      const ctx = tile.getContext('2d');
      const img = ctx.createImageData(S, S);
      const sun = this.sun || sunPosition(new Date());
      const [nr, ng, nb] = this.rgb || css('--night').split(',').map(Number);
      const origin = coords.scaleBy(this.getTileSize());
      const smooth = (e0, e1, v) => { const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const ll = this._map.unproject(origin.add([(x + 0.5) * step, (y + 0.5) * step]), coords.z);
          const alt = sunAltitude(sun, ll.lat, ll.lng);
          if (alt > 1) continue;
          const i = (y * S + x) * 4;
          const night = smooth(1, -2, alt) * (0.4 + 0.3 * smooth(-6, -18, alt));
          const gray = Math.max(0, 1 - Math.abs(alt + 3) / 4);
          img.data[i] = nr + (214 - nr) * gray;
          img.data[i + 1] = ng + (160 - ng) * gray;
          img.data[i + 2] = nb + (60 - nb) * gray;
          img.data[i + 3] = Math.round(255 * (night * (1 - gray) + 0.32 * gray));
        }
      }
      ctx.putImageData(img, 0, 0);
      return tile;
    },
  });

  const HomeControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const bar = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
      const a = L.DomUtil.create('a', 'map-home', bar);
      a.href = '#';
      a.title = 'Reset view';
      a.setAttribute('role', 'button');
      a.setAttribute('aria-label', 'Reset view');
      a.textContent = '⌂';
      L.DomEvent.disableClickPropagation(bar);
      L.DomEvent.on(a, 'click', e => { L.DomEvent.preventDefault(e); this.options.onClick(); });
      return bar;
    },
  });

  function landLayer() {
    const layer = L.layerGroup();
    layer.refill = () => {
      layer.clearLayers();
      if (!state.land) return;
      L.geoJSON({
        type: 'FeatureCollection',
        features: state.land.map(rings => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: rings } })),
      }, { interactive: false, style: { color: css('--land-edge'), weight: 0.6, fillColor: css('--land'), fillOpacity: 1 } }).addTo(layer);
    };
    layer.refill();
    return layer;
  }

  // One Leaflet map per key, created the first time its view is visible.
  // opts: { world, night, home() }
  function makeMap(key, el, opts = {}) {
    if (maps[key]) return maps[key];
    // Canvas markers with a 10px tolerance, so a click near a small dot still
    // counts (the old canvas maps picked the nearest dot within 12px).
    const map = L.map(el, {
      preferCanvas: true, renderer: L.canvas({ tolerance: 10 }),
      worldCopyJump: true, zoomSnap: 0.5, minZoom: opts.world ? 0 : 3, scrollWheelZoom: false,
    });
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
    // Wheel zoom only after the map is clicked, so scrolling the page past a
    // map doesn't zoom it by accident.
    map.on('click focus', () => map.scrollWheelZoom.enable());
    map.on('mouseout blur', () => map.scrollWheelZoom.disable());

    const plain = landLayer();
    const bases = {}, idOf = new Map();
    for (const [id, label, url, o] of BASEMAPS) {
      const layer = url ? L.tileLayer(url, { maxZoom: 19, ...o }) : plain;
      bases[label] = layer;
      idOf.set(layer, id);
    }
    const saved = storeGet(`hamdash.layer.${key}`);
    const start = BASEMAPS.some(b => b[0] === saved) ? saved : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'streets';
    bases[BASEMAPS.find(b => b[0] === start)[1]].addTo(map);
    el.classList.toggle('map-plain', start === 'plain');
    if (start === 'plain') ensureLand();

    const m = { key, map, plain, group: L.layerGroup().addTo(map), labels: [], fitKey: null };
    const overlays = {};
    if (opts.night) {
      m.night = new NightLayer();
      m.night.addTo(map);
      overlays['Day / night'] = m.night;
    }
    L.control.layers(bases, overlays, { position: 'topright' }).addTo(map);
    map.on('baselayerchange', e => {
      const id = idOf.get(e.layer);
      storeSet(`hamdash.layer.${key}`, id);
      el.classList.toggle('map-plain', id === 'plain');
      if (id === 'plain') ensureLand();
    });
    if (opts.home) new HomeControl({ onClick: opts.home }).addTo(map);
    map.on('zoomend moveend', () => declutter(m));
    // Timed refreshes wait while the pointer is over the map, so markers don't
    // disappear and come back under the cursor mid-click.
    el.addEventListener('pointerenter', () => { m.hover = true; });
    el.addEventListener('pointerleave', () => {
      m.hover = false;
      const run = m.pending;
      m.pending = null;
      run?.();
    });
    maps[key] = m;
    return m;
  }

  // Leaflet sizes maps when they're created; views that were hidden need a nudge.
  function refreshMapSize(key) { maps[key]?.map.invalidateSize(); }

  const ll = p => L.latLng(p.lat, p.lon);

  function dot(p, color, { radius = 5, hollow = false } = {}) {
    return L.circleMarker(ll(p), {
      radius, weight: 1.5,
      color: hollow ? color : css('--card'), fillColor: hollow ? css('--card') : color, fillOpacity: 1,
    });
  }

  function qthMarker(p, html) {
    return L.layerGroup([
      L.circleMarker(ll(p), { radius: 8, weight: 4, color: css('--card'), fill: false, interactive: false }),
      L.circleMarker(ll(p), { radius: 8, weight: 2, color: css('--text'), fill: false, interactive: false }),
      L.circleMarker(ll(p), { radius: 3, weight: 0, fillColor: css('--text'), fillOpacity: 1 }).bindTooltip(html, TIP),
    ]);
  }

  // A shape that isn't a circle: 'tri' (ionosonde), 'diamond' (object), or an
  // arrow rotated to a course.
  // label names the marker for screen readers (Leaflet makes it a button).
  function shapeMarker(p, shape, color, course, label) {
    const html = shape === 'arrow'
      ? `<span class="map-arrow" style="--c:${color};transform:rotate(${Math.round(course)}deg)"></span>`
      : `<span class="map-${shape}" style="--c:${color}"></span>`;
    // The icon box is larger than the shape so it's as easy to click as a dot.
    const m = L.marker(ll(p), { icon: L.divIcon({ className: 'map-shape', html, iconSize: [26, 26], iconAnchor: [13, 13] }) });
    if (label) m.on('add', () => m.getElement()?.setAttribute('aria-label', label));
    return m;
  }

  function highlightRing(p) {
    return L.circleMarker(ll(p), { radius: 11, weight: 2, color: css('--text'), fill: false, interactive: false });
  }

  // Name labels as separate markers, so the hover tooltip stays free.
  function addLabel(m, p, text) {
    const label = L.marker(ll(p), {
      icon: L.divIcon({ className: 'map-label', html: esc(text), iconSize: null, iconAnchor: [-8, 8] }),
      interactive: false, keyboard: false,
    }).addTo(m.group);
    m.labels.push(label);
  }

  // Hide labels that would overlap ones already shown.
  function declutter(m) {
    const placed = [];
    for (const label of m.labels) {
      const el = label.getElement();
      if (!el) continue;
      el.style.visibility = 'visible';
      const r = el.getBoundingClientRect();
      if (placed.some(b => r.left < b.right && b.left < r.right && r.top < b.bottom && b.top < r.bottom)) el.style.visibility = 'hidden';
      else placed.push(r);
    }
  }

  function rangeRings(m, center, radiusKm, radiusInUnits) {
    const units = station().units;
    for (let i = 1; i <= 4; i++) {
      const km = (radiusKm * i) / 4;
      L.circle(ll(center), { radius: km * 1000, color: css('--muted'), weight: 1, opacity: 0.7, dashArray: '4 4', fill: false, interactive: false }).addTo(m.group);
      L.marker([center.lat + km / 111.2, center.lon], {
        icon: L.divIcon({ className: 'ring-label', html: `${+((radiusInUnits * i) / 4).toFixed(1)} ${units}`, iconSize: null, iconAnchor: [-4, 14] }),
        interactive: false, keyboard: false,
      }).addTo(m.group);
    }
  }

  // Zoom so the circle of radius km around center fills the map. Returns false
  // (and retries next frame) if the map has no size yet, since fitting then
  // would land at the maximum zoom.
  function fitRadius(m, center, km) {
    m.map.invalidateSize();
    if (!(km > 0) || !m.map.getSize().y) {
      requestAnimationFrame(() => { if (m.map.getSize().y) fitRadius(m, center, km); });
      return false;
    }
    m.map.fitBounds(ll(center).toBounds(km * 2000), { padding: [8, 8], maxZoom: 14 });
    return true;
  }

  // ------------------------------------------------------------ gray line map

  function drawGrayline() {
    const el = $('#grayline');
    if (!el.offsetWidth) return;
    const home = () => maps.grayline.map.setView([25, 0], el.offsetWidth < 520 ? 0 : 1);
    const m = makeMap('grayline', el, { world: true, night: true, home });
    if (!m.fitKey) { home(); m.fitKey = 'world'; }
    m.night.refresh();
    m.group.clearLayers();

    const st = station();
    const pos = gridToLatLon(st.grid);
    const reports = state.psk?.reports || [];
    const iono = nearestIonosonde(pos);

    const seen = new Set();
    for (const r of reports) {
      if (seen.has(r.rx)) continue;
      seen.add(r.rx);
      const p = gridToLatLon(r.rxGrid);
      if (!p) continue;
      dot(p, css('--series-2'), { radius: 4 })
        .bindTooltip(`<b class="mono">${esc(r.rx)}</b><br>${esc(r.rxCountry || '')}${tipRow('Band', bandName(r.freq) || '—')}${tipRow('Mode', esc(r.mode))}${tipRow('SNR', `${r.snr ?? '—'} dB`)}${pos ? tipRow('Distance', fmtDist(distanceKm(pos, p))) : ''}`, TIP)
        .addTo(m.group);
    }
    if (iono) {
      shapeMarker(iono, 'tri', css('--series-1'), 0, `${iono.name} ionosonde`)
        .bindTooltip(`<b>${esc(iono.name)}</b> ionosonde${tipRow('MUF(3000)', `${iono.mufd.toFixed(1)} MHz`)}${tipRow('foF2', `${iono.fof2?.toFixed(1) ?? '—'} MHz`)}${tipRow('Measured', ago(iono.time))}`, TIP)
        .addTo(m.group);
    }
    const sun = sunPosition(new Date());
    L.circleMarker(ll(sun), { radius: 7, weight: 1.5, color: '#8a5a00', fillColor: '#fab219', fillOpacity: 1 })
      .bindTooltip(`<b>Sun overhead</b>${tipRow('Lat', sun.lat.toFixed(1) + '°')}${tipRow('Lon', sun.lon.toFixed(1) + '°')}`, TIP)
      .addTo(m.group);
    if (pos) qthMarker(pos, `<b class="mono">${esc(st.callsign || 'Your QTH')}</b>${tipRow('Grid', esc(st.grid))}`).addTo(m.group);

    $('#graylineLegend').innerHTML = nightLegend() +
      (pos ? legendKey(`border:2px solid ${css('--text')};border-radius:50%`, 'Your QTH') : '') +
      (iono ? legendKey(`background:${css('--series-1')};clip-path:polygon(50% 0,100% 100%,0 100%)`, 'Ionosonde used') : '') +
      (reports.length ? legendKey(`background:${css('--series-2')};border-radius:50%`, 'Stations hearing you (PSKReporter)') : '');

    renderSunTimes(pos, sun);
  }

  function renderSunTimes(pos, sun) {
    if (!pos) { $('#sunTimes').innerHTML = '<div class="empty">Set your grid square to see sunrise, sunset and gray line times.</div>'; return; }
    const t = sunTimes(pos);
    const alt = sunAltitude(sun, pos.lat, pos.lon);
    const both = d => (d ? `${clockHM(d)}` : '—');
    const sub = d => (d ? `${utcHM(d)} UTC` : 'n/a today');
    $('#sunTimes').innerHTML = [
      tile('Sun at QTH', sunPhase(alt), '', `Elevation ${alt.toFixed(1)}°`),
      tile('Morning gray line', both(t.dawn), '', t.dawn ? `${utcHM(t.dawn)}–${t.sunrise ? utcHM(t.sunrise) : '?'} UTC` : 'n/a today'),
      tile('Sunrise', both(t.sunrise), '', sub(t.sunrise)),
      tile('Sunset', both(t.sunset), '', sub(t.sunset)),
      tile('Evening gray line', both(t.sunset), '', t.sunset ? `${utcHM(t.sunset)}–${t.dusk ? utcHM(t.dusk) : '?'} UTC` : 'n/a today'),
    ].join('');
  }

  const sunPhase = alt => (alt > 0 ? 'Daytime' : alt > -6 ? 'Gray line now!' : alt > -12 ? 'Nautical twilight' : 'Night');

  // Hover tooltips for the satellite sky plot (still a canvas): the nearest
  // registered dot within 12px.
  const canvasDots = new WeakMap();

  function bindCanvasHover(canvas) {
    canvas.addEventListener('mousemove', e => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      let best = null, bd = 12;
      for (const d of canvasDots.get(canvas) || []) {
        const dd = Math.hypot(d.x - x, d.y - y);
        if (dd < bd) { bd = dd; best = d; }
      }
      if (best) showTip(best.html, e.clientX, e.clientY); else hideTip();
    });
    canvas.addEventListener('mouseleave', hideTip);
  }

  function bindMapTabs() {
    const tabs = [...document.querySelectorAll('#mapTabs [role=tab]')];
    const select = name => {
      for (const t of tabs) {
        const on = t.dataset.map === name;
        t.setAttribute('aria-selected', on);
        const panel = $(`#panel-${t.dataset.map}`);
        panel.hidden = !on;
        const img = panel.querySelector('img[data-src]');
        if (on && img) img.src = `${img.dataset.src}?t=${Math.floor(Date.now() / 600000)}`;
      }
      storeSet('hamdash.map', name);
      if (name === 'grayline') { drawGrayline(); refreshMapSize('grayline'); }
    };
    tabs.forEach(t => t.addEventListener('click', () => select(t.dataset.map)));
    const saved = storeGet('hamdash.map');
    if (saved && tabs.some(t => t.dataset.map === saved)) select(saved);
  }

  // ------------------------------------------------------------ SVG helpers

  function svg(tag, attrs = {}, parent) {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  }

  // Bar with 4px rounded data end, square at the baseline.
  function barPath(x, y, w, h, r = 4) {
    r = Math.max(0, Math.min(r, w / 2, h));
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  // ------------------------------------------------------------ Kp chart

  function renderKp() {
    const box = $('#kpChart');
    const all = state.solar?.kp || [];
    const from = Date.now() - 4 * 86400000;
    const data = all.filter(k => Date.parse(k.time) >= from);
    box.innerHTML = '';
    if (!data.length) { box.innerHTML = '<div class="empty">Kp data unavailable</div>'; return; }

    const W = Math.max(300, box.clientWidth), H = 210;
    const m = { l: 26, r: 8, t: 10, b: 24 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    // Screen readers get the numbers, not just the chart's name.
    const nowMs = Date.now();
    const past = data.filter(k => k.kind !== 'predicted' && Date.parse(k.time) <= nowMs);
    const ahead = data.filter(k => Date.parse(k.time) > nowMs);
    const kpLabel = `Planetary K-index, past 4 days and forecast. Latest ${past.length ? past[past.length - 1].kp.toFixed(1) : 'unknown'}, highest in the past 4 days ${past.length ? Math.max(...past.map(k => k.kp)).toFixed(1) : 'unknown'}${ahead.length ? `, forecast high ${Math.max(...ahead.map(k => k.kp)).toFixed(1)}` : ''}.`;
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': kpLabel }, box);
    const y = v => m.t + ih - (v / 9) * ih;
    const step = iw / data.length;
    const bw = Math.max(1.5, step - 2);

    const ax = svg('g', { class: 'axis' }, s);
    for (const v of [0, 3, 6, 9]) {
      svg('line', { class: 'gridline', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }, s);
      svg('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, ax).textContent = v;
    }
    svg('line', { class: 'threshold', x1: m.l, x2: W - m.r, y1: y(5), y2: y(5) }, s);
    svg('text', { class: 'threshold-label', x: W - m.r, y: y(5) - 4, 'text-anchor': 'end' }, s).textContent = 'G1 storm (Kp 5)';

    let lastDay = null;
    data.forEach((k, i) => {
      const t = new Date(k.time);
      const x = m.l + i * step + (step - bw) / 2;
      const st = kpStatus(k.kp);
      const top = y(Math.max(k.kp, 0.15));
      svg('path', {
        d: barPath(x, top, bw, m.t + ih - top, Math.min(4, bw / 2)),
        fill: st.color, 'fill-opacity': k.kind === 'predicted' ? 0.4 : k.kind === 'estimated' ? 0.7 : 1,
      }, s);
      const day = t.getUTCDate();
      if (day !== lastDay && t.getUTCHours() === 0) {
        svg('text', { x: m.l + i * step, y: H - 6, 'text-anchor': 'start' }, ax).textContent = utcDay(t);
        if (i > 0) svg('line', { class: 'gridline', x1: m.l + i * step, x2: m.l + i * step, y1: m.t, y2: m.t + ih }, s);
      }
      lastDay = day;
      const hit = svg('rect', { x: m.l + i * step, y: m.t, width: step, height: ih, fill: 'transparent' }, s);
      hit.addEventListener('mousemove', e => showTip(
        `<b>${utcDay(t)} ${utcHM(t)}–${utcHM(new Date(t.getTime() + 3 * 3600000))} UTC</b>
         ${tipRow('Kp', k.kp.toFixed(2))}${tipRow('Level', esc(st.label))}${tipRow('Type', esc(k.kind))}`, e.clientX, e.clientY));
      hit.addEventListener('mouseleave', hideTip);
    });

    const nowIdx = data.findIndex(k => Date.parse(k.time) > Date.now());
    if (nowIdx > 0) {
      const nx = m.l + nowIdx * step;
      svg('line', { class: 'now-line', x1: nx, x2: nx, y1: m.t, y2: m.t + ih }, s);
      svg('text', { class: 'threshold-label', x: nx + 4, y: m.t + 10 }, s).textContent = 'now';
    }
    svg('line', { class: 'baseline', x1: m.l, x2: W - m.r, y1: m.t + ih, y2: m.t + ih }, s);

    $('#kpLegend').innerHTML = `
      <span class="key"><span class="sw" style="background:${css('--good')}"></span>Quiet–unsettled (0–3)</span>
      <span class="key"><span class="sw" style="background:${css('--warning')}"></span>Active (4)</span>
      <span class="key"><span class="sw" style="background:${css('--serious')}"></span>G1–G2 storm (5–6)</span>
      <span class="key"><span class="sw" style="background:${css('--critical')}"></span>G3+ storm (7–9)</span>
      <span class="key"><span class="sw" style="background:${css('--text-2')};opacity:.4"></span>Faded = forecast</span>`;
  }

  // ------------------------------------------------------------ solar cycle chart

  function renderCycle() {
    const box = $('#cycleChart');
    const c = state.cycle;
    box.innerHTML = '';
    if (!c) { box.innerHTML = '<div class="empty">Solar cycle data unavailable</div>'; return; }
    const tOf = s => { const [yy, mm] = s.split('-').map(Number); return Date.UTC(yy, mm - 1, 15); };
    const obs = c.observed.map(d => ({ ...d, x: tOf(d.t) }));
    const pred = c.predicted.map(d => ({ ...d, x: tOf(d.t) }));
    const x0 = obs[0].x, x1 = Math.max(obs[obs.length - 1].x, pred.length ? pred[pred.length - 1].x : 0);
    const ymax = Math.ceil(Math.max(...obs.map(d => d.ssn || 0), ...pred.map(d => d.high || 0)) / 50) * 50;

    const W = Math.max(300, box.clientWidth), H = 210;
    const m = { l: 32, r: 10, t: 10, b: 24 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const X = t => m.l + ((t - x0) / (x1 - x0)) * iw;
    const Y = v => m.t + ih - (v / ymax) * ih;
    const lastObs = [...obs].reverse().find(d => d.ssn != null);
    // NOAA's series overlaps the observed months, so only use what's ahead.
    const ahead = pred.filter(d => d.ssn != null && (!lastObs || d.x > lastObs.x));
    const first = ahead[0], last = ahead[ahead.length - 1];
    const cycleLabel = `Monthly sunspot number since 2008 with the NOAA prediction. Latest ${lastObs ? `${Math.round(lastObs.ssn)} (${lastObs.t})` : 'unknown'}${first ? `; NOAA predicts ${Math.round(first.ssn)} for ${first.t}${last !== first ? ` and ${Math.round(last.ssn)} by ${last.t}` : ''}` : ''}.`;
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': cycleLabel }, box);
    const ax = svg('g', { class: 'axis' }, s);
    for (let v = 0; v <= ymax; v += ymax > 200 ? 100 : 50) {
      svg('line', { class: 'gridline', x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }, s);
      svg('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end' }, ax).textContent = v;
    }
    const yStep = W < 520 ? 4 : 2;
    for (let yr = 2008; Date.UTC(yr, 0, 1) <= x1; yr += yStep) {
      svg('text', { x: X(Date.UTC(yr, 0, 1)), y: H - 6, 'text-anchor': 'middle' }, ax).textContent = yr;
    }
    const line = (pts, key) => pts.filter(p => p[key] != null).map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p[key]).toFixed(1)}`).join('');

    const band = pred.filter(p => p.high != null && p.low != null);
    if (band.length) {
      const d = band.map((p, i) => `${i ? 'L' : 'M'}${X(p.x)},${Y(p.high)}`).join('') +
        band.slice().reverse().map(p => `L${X(p.x)},${Y(p.low)}`).join('') + 'Z';
      svg('path', { d, fill: css('--series-2'), 'fill-opacity': 0.15 }, s);
    }
    svg('path', { d: line(obs, 'ssn'), fill: 'none', stroke: css('--muted'), 'stroke-width': 1, 'stroke-opacity': 0.8 }, s);
    svg('path', { d: line(obs, 'smoothed'), fill: 'none', stroke: css('--series-1'), 'stroke-width': 2, 'stroke-linejoin': 'round' }, s);
    svg('path', { d: line(pred, 'ssn'), fill: 'none', stroke: css('--series-2'), 'stroke-width': 2, 'stroke-dasharray': '5 4' }, s);
    svg('line', { class: 'baseline', x1: m.l, x2: W - m.r, y1: m.t + ih, y2: m.t + ih }, s);

    const cross = svg('line', { class: 'crosshair', y1: m.t, y2: m.t + ih, visibility: 'hidden' }, s);
    const dot = svg('circle', { r: 4, fill: css('--series-1'), stroke: css('--card'), 'stroke-width': 2, visibility: 'hidden' }, s);
    const byMonth = new Map();
    for (const p of obs) byMonth.set(p.t, { ...byMonth.get(p.t), obs: p });
    for (const p of pred) byMonth.set(p.t, { ...byMonth.get(p.t), pred: p });
    const months = [...byMonth.keys()].sort();
    const hit = svg('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' }, s);
    hit.addEventListener('mousemove', e => {
      const r = s.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      const t = x0 + ((px - m.l) / iw) * (x1 - x0);
      const d = new Date(t);
      const key = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
      const k = months.includes(key) ? key : months[months.length - 1];
      const v = byMonth.get(k);
      const cx = X(tOf(k));
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
      const yv = v.obs?.smoothed ?? v.pred?.ssn ?? v.obs?.ssn;
      if (yv != null) { dot.setAttribute('cx', cx); dot.setAttribute('cy', Y(yv)); dot.setAttribute('visibility', 'visible'); }
      const [yy, mm] = k.split('-');
      showTip(`<b>${MONTHS[+mm - 1]} ${yy}</b>
        ${v.obs?.ssn != null ? tipRow('Monthly SSN', v.obs.ssn.toFixed(0)) : ''}
        ${v.obs?.smoothed != null ? tipRow('Smoothed', v.obs.smoothed.toFixed(0)) : ''}
        ${v.pred?.ssn != null ? tipRow('Predicted', v.pred.ssn.toFixed(0)) : ''}
        ${v.pred?.low != null ? tipRow('Range', `${v.pred.low.toFixed(0)}–${v.pred.high.toFixed(0)}`) : ''}`, e.clientX, e.clientY);
    });
    hit.addEventListener('mouseleave', () => { hideTip(); cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); });

    $('#cycleLegend').innerHTML = `
      <span class="key"><span class="ln" style="border-color:${css('--muted')};border-top-width:1px"></span>Monthly</span>
      <span class="key"><span class="ln" style="border-color:${css('--series-1')}"></span>13-month smoothed</span>
      <span class="key"><span class="ln dash" style="border-color:${css('--series-2')}"></span>NOAA prediction</span>
      <span class="key"><span class="sw" style="background:${css('--series-2')};opacity:.25"></span>Prediction range</span>`;
  }

  // ------------------------------------------------------------ DX spots

  const SPOT_BANDS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '2m'];
  const DIGI = new Set(['FT8', 'FT4', 'RTTY', 'PSK31', 'PSK63', 'JT65', 'JS8', 'SSTV', 'MSK144', 'Q65']);

  function bandName(hz) {
    const k = hz / 1000;
    const ranges = [['160m', 1800, 2000], ['80m', 3500, 4000], ['60m', 5330, 5410], ['40m', 7000, 7300], ['30m', 10100, 10150], ['20m', 14000, 14350], ['17m', 18068, 18168], ['15m', 21000, 21450], ['12m', 24890, 24990], ['10m', 28000, 29700], ['6m', 50000, 54000], ['2m', 144000, 148000]];
    return (ranges.find(([, lo, hi]) => k >= lo && k <= hi) || [null])[0];
  }

  const watched = call => (state.defaults.spot_watch || []).some(w => call === w || call.startsWith(w));

  function renderSpots() {
    const d = state.spots;
    const status = $('#spotsStatus');
    $('#clusterHost').textContent = d?.host || '';
    if (!d) { status.textContent = ''; return; }
    const STATUS = { connected: `Live · ${d.host}`, connecting: 'Connecting…', reconnecting: 'Reconnecting…', disabled: 'Turned off in the app’s configuration', 'no-callsign': 'Set a callsign in the app’s configuration to connect', 'no-license': 'DX cluster spots need a licensed amateur callsign' };
    status.textContent = STATUS[d.status] || d.status;

    const mode = $('#modeFilter').value, cont = $('#contFilter').value;
    const recent = Date.now() - 30 * 60000;
    const counts = {};
    for (const s of d.spots) if (Date.parse(s.time) >= recent && s.band) counts[s.band] = (counts[s.band] || 0) + 1;
    $('#bandChips').innerHTML = [['', 'All bands'], ...SPOT_BANDS.map(b => [b, b])].map(([v, label]) =>
      `<button type="button" class="chip" data-band="${v}" aria-pressed="${state.bandFilter === v}">${label}${v && counts[v] ? `<span class="n">${counts[v]}</span>` : ''}</button>`).join('');

    const rows = d.spots.filter(s =>
      (!state.bandFilter || s.band === state.bandFilter) &&
      (!mode || (mode === 'DIGI' ? DIGI.has(s.mode) : s.mode === mode)) &&
      (!cont || s.spotterConts.includes(cont))).slice(0, 150);

    if (!rows.length) {
      $('#spotsTable').innerHTML = `<tbody><tr><td class="empty">${d.status === 'connected' ? 'No spots match these filters yet.' : 'No spots yet.'}</td></tr></tbody>`;
      return;
    }
    const fresh = Date.now() - 2 * 60000;
    $('#spotsTable').innerHTML = `<thead><tr><th>UTC</th><th class="num">kHz</th><th>DX</th><th>Mode</th><th>Spotter</th><th>Comment</th></tr></thead><tbody>${
      rows.map(s => `<tr class="${Date.parse(s.time) > fresh ? 'fresh' : ''}${watched(s.dx) ? ' watched' : ''}" title="${watched(s.dx) ? 'On your watch list' : ''}">
        <td class="mono">${utcHM(new Date(s.time))}</td>
        <td class="mono num">${s.freq.toFixed(1)}</td>
        <td class="call" title="${esc(s.dxCont || '')}">${callLink(s.dx)}<button type="button" class="path-link" data-path-target="${esc(s.dx)}" title="Propagation to ${esc(s.dx)}" aria-label="Propagation to ${esc(s.dx)}">↗</button></td>
        <td><span class="tag">${esc(s.mode)}</span></td>
        <td>${callLink(s.spotter)}${s.count > 1 ? `<span class="count">+${s.count - 1}</span>` : ''}</td>
        <td class="comment">${esc(s.comment)}</td></tr>`).join('')
    }</tbody>`;
  }

  // ------------------------------------------------------------ PSKReporter

  function renderPsk(errorMsg) {
    const st = station();
    const sum = $('#pskSummary'), table = $('#pskTable');
    if (st.type !== 'amateur') {
      sum.innerHTML = '';
      table.innerHTML = '<tbody><tr><td class="empty">“Who’s hearing you” shows where your own amateur transmissions are being received, so it needs a licensed amateur callsign. Measured band activity in the band table works for everyone.</td></tr></tbody>';
      return;
    }
    if (!st.callsign) {
      sum.innerHTML = '';
      table.innerHTML = '<tbody><tr><td class="empty">Set your callsign (top right) to see who is hearing you.</td></tr></tbody>';
      return;
    }
    if (errorMsg) { sum.innerHTML = ''; table.innerHTML = `<tbody><tr><td class="empty">PSKReporter unavailable: ${esc(errorMsg)}</td></tr></tbody>`; return; }
    const p = state.psk;
    if (!p) { table.innerHTML = '<tbody><tr><td class="empty">Loading…</td></tr></tbody>'; return; }
    const me = gridToLatLon(st.grid);
    const reports = p.reports.map(r => {
      const rx = gridToLatLon(r.rxGrid), tx = me || gridToLatLon(r.txGrid);
      return { ...r, band: bandName(r.freq), dist: rx && tx ? distanceKm(tx, rx) : null };
    });
    if (!reports.length) {
      sum.innerHTML = '';
      table.innerHTML = `<tbody><tr><td class="empty">No reception reports for ${esc(p.call)} in this window. Call CQ on FT8 and check back in a few minutes.</td></tr></tbody>`;
      return;
    }
    const uniq = new Set(reports.map(r => r.rx)).size;
    const far = reports.reduce((a, b) => ((b.dist ?? -1) > (a.dist ?? -1) ? b : a));
    const best = reports.reduce((a, b) => ((b.snr ?? -99) > (a.snr ?? -99) ? b : a));
    const byBand = {};
    for (const r of reports) if (r.band) byBand[r.band] = (byBand[r.band] || 0) + 1;
    sum.innerHTML = [
      tile('Reports', reports.length, '', `${uniq} stations`),
      tile('Farthest', far.dist != null ? fmtDist(far.dist) : null, '', far.rx),
      tile('Best SNR', best.snr, 'dB', best.rx),
    ].join('') + `<div class="psk-bands">${SPOT_BANDS.filter(b => byBand[b]).map(b => `<span class="tag">${b} · ${byBand[b]}</span>`).join('')}</div>`;
    table.innerHTML = `<thead><tr><th>UTC</th><th>Heard by</th><th>Band</th><th>Mode</th><th class="num">SNR</th><th class="num">Distance</th></tr></thead><tbody>${
      reports.slice(0, 200).map(r => `<tr>
        <td class="mono">${utcHM(new Date(r.time * 1000))}</td>
        <td class="call" title="${esc(r.rxCountry || '')} ${esc(r.rxGrid || '')}">${callLink(r.rx)}</td>
        <td>${esc(r.band || '—')}</td><td><span class="tag">${esc(r.mode)}</span></td>
        <td class="mono num">${r.snr ?? '—'}</td><td class="mono num">${fmtDist(r.dist)}</td></tr>`).join('')
    }</tbody>`;
  }

  // ------------------------------------------------------------ alerts

  function renderAlerts() {
    const al = state.solar?.alerts;
    const box = $('#alerts');
    if (!al) { box.innerHTML = '<div class="empty">Alerts unavailable</div>'; }
    else if (!al.length) { box.innerHTML = '<div class="empty">No alerts in the last 72 hours.</div>'; }
    else {
      box.innerHTML = al.map(a => {
        const kind = (a.title.match(/^(CONTINUED ALERT|EXTENDED WARNING|ALERT|WARNING|WATCH|SUMMARY|CANCEL\w*)/) || ['', 'NOTICE'])[1];
        const cls = /WARNING|ALERT/.test(kind) ? 'fair' : /WATCH/.test(kind) ? 'serious' : 'none';
        const t = new Date(a.time);
        return `<details><summary><span class="t">${utcDay(t)} ${utcHM(t)} UTC</span>${pill(cls, kind)}<span>${esc(a.title.replace(/^[^:]+:\s*/, ''))}</span></summary><pre>${esc(a.message)}</pre></details>`;
      }).join('');
    }
    $('#forecastText').textContent = state.solar?.forecast || 'Unavailable';
  }

  // ------------------------------------------------------------ storm safety

  const STORM_LEVEL = {
    safe: { cls: 'good', label: 'Safe', icon: '✓', text: 'No lightning or storm warnings for your station.' },
    caution: { cls: 'fair', label: 'Caution', icon: '!', text: 'Storms possible. Be ready to disconnect antennas.' },
    danger: { cls: 'poor', label: 'Danger', icon: '⚡', text: 'Disconnect and ground your antennas now.' },
  };

  async function loadStorm() {
    try { state.storm = await api('api/storm'); } catch (e) { console.warn(e); }
    renderStorm();
  }

  function renderStorm() {
    const s = state.storm;
    if (!s) return;
    const lv = STORM_LEVEL[s.level] || STORM_LEVEL.safe;

    const banner = $('#stormBanner');
    banner.hidden = s.level !== 'danger';
    if (s.level === 'danger') banner.innerHTML = `<b>⚡ Lightning danger:</b> ${esc(s.reasons.join(' · '))}. ${esc(lv.text)}`;

    $('#stormMeta').textContent = `Checked ${ago(s.updated)}`;
    $('#stormStatus').innerHTML = `
      <div class="storm-level s-${lv.cls}"><span class="storm-icon" aria-hidden="true">${lv.icon}</span>${esc(lv.label)}</div>
      <p class="storm-text">${esc(s.reasons.length ? s.reasons.join(' · ') : lv.text)}</p>
      ${s.reasons.length ? `<p class="note">${esc(lv.text)}</p>` : ''}`;

    const sen = s.sensor;
    $('#stormSensor').innerHTML = !sen
      ? `<div class="tile"><span class="label">Lightning sensor</span><span class="value small">Not set up</span>
          <span class="sub wrap">Add an Ecowitt WH57, Ambient Weather or ESPHome AS3935 sensor to Home Assistant, then put its entity ID in the app’s <b>Lightning sensor entity</b> option to get strike distances.</span></div>`
      : sen.error
        ? `<div class="tile"><span class="label">Lightning sensor</span><span class="value small">Unavailable</span><span class="sub wrap">${esc(sen.entity)}: ${esc(sen.error)}</span></div>`
        : `<div class="tile"><span class="label">Last strike · ${esc(sen.name)}</span>
            <span class="value">${sen.distance ?? '—'}<span class="unit">${esc(s.units)}</span></span>
            <span class="sub">${sen.lastStrike ? `${ago(sen.lastStrike)}${sen.recent ? '' : ' (older than 30 min)'}` : 'No strikes yet'} · alert inside ${s.alertDistance} ${esc(s.units)}</span></div>`;

    const hours = s.nws?.hourly || [];
    $('#stormForecast').innerHTML = !s.nws
      ? `<div class="tile"><span class="label">NWS forecast</span><span class="value small">Off</span><span class="sub wrap">Turn on NWS weather alerts in the app’s configuration (US only).</span></div>`
      : !hours.length
        ? `<div class="tile"><span class="label">NWS forecast</span><span class="value small">Unavailable</span><span class="sub wrap">The National Weather Service only covers the US.</span></div>`
        : `<div class="tile"><span class="label">Next 12 hours · thunder ${hours.some(h => /thunder/i.test(h.forecast)) ? 'in forecast' : 'not expected'}</span>
            <div class="hour-strip">${hours.map(h => {
              const t = /thunder/i.test(h.forecast);
              return `<span class="hour${t ? ' thunder' : ''}" title="${esc(h.forecast)}${h.pop != null ? ` · ${h.pop}% rain` : ''}">${esc(clockHour(h.start))}${t ? ' ⚡' : ''}</span>`;
            }).join('')}</div></div>`;

    const alerts = s.nws?.alerts || [];
    $('#nwsAlerts').innerHTML = !s.nws ? ''
      : !s.nws.available ? '<p class="note">NWS alerts are unavailable right now.</p>'
        : !alerts.length ? '<p class="note">No active National Weather Service alerts for your location.</p>'
          : alerts.map(a => `<details><summary>${pill(a.storm === 'danger' ? 'poor' : a.storm === 'caution' ? 'fair' : 'none', a.event)}<span>${esc(a.headline)}</span></summary>
              <pre>${esc([a.description, a.instruction].filter(Boolean).join('\n\n'))}</pre></details>`).join('');
  }

  // ------------------------------------------------------------ views

  const VIEWS = ['weather', 'prop', 'repeaters', 'aprs', 'pota', 'sats', 'lookup', 'ref'];
  let currentView = 'weather';

  function showView(name) {
    if (!VIEWS.includes(name) || (state.settings.hiddenTabs || []).includes(name)) name = 'weather';
    currentView = name;
    for (const v of VIEWS) $(`#view-${v}`).hidden = v !== name;
    for (const b of document.querySelectorAll('#viewTabs [data-view]')) {
      if (b.dataset.view === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
    // On phones the tab row scrolls sideways; keep the active tab visible.
    const tab = $(`#viewTabs [data-view="${name}"]`), row = $('#viewTabs');
    if (row.scrollWidth > row.clientWidth) row.scrollLeft = tab.offsetLeft - (row.clientWidth - tab.offsetWidth) / 2;
    storeSet('hamdash.view', name);
    if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
    hideTip();
    redrawVisible();
    if (name === 'repeaters') loadRepeaters();
    if (name === 'lookup') renderLookup();
    if (name === 'prop') openProp();
    if (name === 'ref') openRef();
    // Poll live data only while its tab is open.
    for (const v of [aprs, pota, sats, prop, beacons]) clearInterval(v.timer);
    if (name === 'aprs') { loadAprs(); aprs.timer = setInterval(loadAprs, 15000); }
    if (name === 'pota') { loadPota(); pota.timer = setInterval(loadPota, 60000); }
    if (name === 'sats') { loadSats(); sats.timer = setInterval(loadSats, 30000); }
    // Path ratings change slowly; refresh every 10 minutes while the tab is open.
    if (name === 'prop') {
      prop.timer = setInterval(() => { if (prop.query) analyzePath(prop.query, { quiet: true }); }, 10 * 60000);
      beacons.timer = setInterval(tickBeacons, 1000);
    }
  }

  // Canvases and charts can only be sized while their view is visible.
  function redrawVisible() {
    if (currentView === 'weather') {
      if (!$('#panel-grayline').hidden) { refreshMapSize('grayline'); drawGrayline(); }
      refreshMapSize('vhf'); drawVhfMap();
      renderKp(); renderCycle();
    } else if (currentView === 'prop') {
      refreshMapSize('prop');
      drawPropMap();
    } else if (currentView === 'repeaters') {
      refreshMapSize('repeaters');
      drawRepeaterMap();
    } else if (currentView === 'aprs') {
      refreshMapSize('aprs');
      drawAprsMap();
    } else if (currentView === 'pota') {
      refreshMapSize('pota');
      drawPotaMap();
    } else if (currentView === 'sats') {
      renderSats();
    } else {
      refreshMapSize('lookup');
      drawLookupMap();
    }
  }

  // Links and images from outside data (QRZ, FCC) are used only if they're
  // plain https URLs.
  const httpsUrl = u => (/^https:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : '');
  const callLink = c => `<button type="button" class="call-link mono" data-call="${esc(c)}" title="Look up ${esc(c)}">${esc(c)}</button>`;


  // ------------------------------------------------------------ repeaters

  const RPT_BANDS = [['10m', 28, 29.7], ['6m', 50, 54], ['2m', 144, 148], ['1.25m', 219, 225], ['70cm', 420, 450], ['33cm', 902, 928], ['23cm', 1240, 1300]];
  const rptBand = hz => (RPT_BANDS.find(([, lo, hi]) => hz / 1e6 >= lo && hz / 1e6 <= hi) || ['Other'])[0];
  const RADII = { mi: [10, 25, 50, 75, 100, 150], km: [15, 40, 80, 120, 160, 240] };
  const fmtMHz = hz => (hz / 1e6).toFixed(hz % 1000 ? 4 : 3);

  const rpt = { data: null, pos: null, key: '', band: storeGet('hamdash.rptBand') || '', highlight: null, error: null };

  const rptRadiusKm = () => +$('#rptRadius').value * (station().units === 'mi' ? 1.609344 : 1);

  function fillRadiusOptions() {
    const units = station().units;
    const saved = +storeGet(`hamdash.rptRadius.${units}`) || (units === 'mi' ? 50 : 80);
    $('#rptRadius').replaceChildren(...RADII[units].map(r => new Option(`${r} ${units}`, r, false, r === saved)));
  }

  async function loadRepeaters() {
    const pos = gridToLatLon(station().grid);
    $('#rptGrid').textContent = station().grid || 'you';
    if (!pos) {
      rpt.data = null;
      rpt.error = 'Set your grid square (top right) to find nearby repeaters.';
      renderRepeaters();
      return;
    }
    const radius = rptRadiusKm();
    const key = `${pos.lat.toFixed(3)},${pos.lon.toFixed(3)},${radius}`;
    if (key === rpt.key && rpt.data) { renderRepeaters(); return; }
    rpt.key = key;
    rpt.error = null;
    if (!rpt.data) $('#rptTable').innerHTML = '<tbody><tr><td class="empty">Loading repeaters… The first load downloads the HearHam directory and can take a few seconds.</td></tr></tbody>';
    try {
      const d = await api(`api/repeaters?lat=${pos.lat.toFixed(4)}&lon=${pos.lon.toFixed(4)}&radius=${radius.toFixed(1)}`);
      if (rpt.key !== key) return; // a newer request superseded this one
      rpt.data = d;
      rpt.pos = pos;
    } catch (e) {
      rpt.data = null;
      rpt.key = '';
      rpt.error = `Couldn't load repeaters: ${e.message}`;
    }
    renderRepeaters();
  }

  function filteredRepeaters() {
    if (!rpt.data) return [];
    const mode = $('#rptMode').value, onAir = $('#rptOnAir').checked;
    const q = $('#rptSearch').value.trim().toUpperCase();
    return rpt.data.repeaters.filter(r =>
      (!rpt.band || rptBand(r.freq) === rpt.band) &&
      (!mode || r.mode.split('/').includes(mode)) &&
      (!onAir || r.operational) &&
      (!q || r.call.includes(q) || r.city.toUpperCase().includes(q)));
  }

  function toneText(r) {
    if (r.mode.includes('DMR') && r.encode && +r.encode < 16) return `CC${r.encode}`;
    if (!r.encode && !r.decode) return 'none';
    if (r.decode && r.decode !== r.encode) return `${r.encode || 'none'} / ${r.decode}`;
    return r.encode;
  }

  const offsetText = r => (r.offset === 0 ? 'simplex' : `${r.offset > 0 ? '+' : '−'}${+(Math.abs(r.offset) / 1e6).toFixed(4)}`);

  function renderRepeaters() {
    const d = rpt.data;
    const counts = {};
    for (const r of d?.repeaters || []) { const b = rptBand(r.freq); counts[b] = (counts[b] || 0) + 1; }
    const bands = [...RPT_BANDS.map(b => b[0]), 'Other'].filter(b => counts[b] || b === rpt.band);
    $('#rptBandChips').innerHTML = [['', 'All bands'], ...bands.map(b => [b, b])].map(([v, label]) =>
      `<button type="button" class="chip" data-band="${v}" aria-pressed="${rpt.band === v}">${label}${v && counts[v] ? `<span class="n">${counts[v]}</span>` : ''}</button>`).join('');

    if (rpt.error || !d) {
      $('#rptMeta').textContent = '';
      $('#rptSource').textContent = '';
      if (rpt.error) $('#rptTable').innerHTML = `<tbody><tr><td class="empty">${esc(rpt.error)}</td></tr></tbody>`;
      drawRepeaterMap();
      return;
    }

    const rows = filteredRepeaters();
    const units = station().units;
    $('#rptMeta').textContent = `${rows.length} of ${d.total} within ${$('#rptRadius').value} ${units}` +
      (d.total > d.repeaters.length ? ` (closest ${d.repeaters.length} loaded)` : '');
    $('#rptSource').textContent = `Directory downloaded from HearHam ${ago(d.fetched)}.`;

    $('#rptTable').innerHTML = rows.length ? `<thead><tr><th class="num">Output</th><th>${term('offset', 'Offset')}</th><th>${term('tone', 'Tone')}</th><th>Mode</th><th>Repeater</th><th class="num hide-sm">Distance</th><th class="hide-sm">Status</th><th class="hide-sm">Details</th></tr></thead><tbody>${
      rows.map(r => {
        const status = !r.operational ? pill('closed', 'Off air')
          : r.restriction ? pill('fair', r.restriction.toLowerCase().includes('closed') ? 'Closed access' : r.restriction)
            : pill('good', 'On air');
        const net = r.node ? `${r.group || 'Node'} ${r.node}` : r.group;
        return `<tr data-id="${r.id}" class="${r.operational ? '' : 'off'}">
          <td class="mono num freq-out">${fmtMHz(r.freq)}</td>
          <td class="mono" title="Input ${fmtMHz(r.freq + r.offset)} MHz">${offsetText(r)}</td>
          <td class="mono">${esc(toneText(r))}</td>
          <td><span class="tag">${esc(r.mode)}</span>${net ? `<div class="sub net">${esc(net)}</div>` : ''}</td>
          <td>${callLink(r.call)}<div class="sub" title="${esc(r.description)}"><span class="show-sm">${fmtDist(r.dist)} ${compass(r.bearing)} · </span>${esc(r.city)}</div></td>
          <td class="mono num hide-sm">${fmtDist(r.dist)}<div class="sub">${compass(r.bearing)}</div></td>
          <td class="hide-sm">${status}</td>
          <td class="links hide-sm"><a href="https://hearham.com/repeaters/${encodeURIComponent(r.id)}" target="_blank" rel="noopener">HearHam</a><a href="https://www.repeaterbook.com/repeaters/callResult.php?call=${encodeURIComponent(r.call)}" target="_blank" rel="noopener">RepeaterBook</a></td>
        </tr>`;
      }).join('')
    }</tbody>` : '<tbody><tr><td class="empty">No repeaters match these filters. Try a bigger radius or another band.</td></tr></tbody>';
    drawRepeaterMap();
  }

  // Local map around the QTH with range rings. Repeaters at the same site share
  // one marker whose tooltip lists them all.
  function drawRepeaterMap() {
    const el = $('#rptMap');
    if (!el.offsetWidth) return;
    const pos = rpt.pos || gridToLatLon(station().grid);
    const m = makeMap('repeaters', el, {
      home: () => { const p = rpt.pos || gridToLatLon(station().grid); if (p) fitRadius(maps.repeaters, p, rptRadiusKm()); },
    });
    m.group.clearLayers();
    if (!pos) return;
    const fitKey = `${pos.lat},${pos.lon},${rptRadiusKm()}`;
    if (m.fitKey !== fitKey && fitRadius(m, pos, rptRadiusKm())) m.fitKey = fitKey;
    rangeRings(m, pos, rptRadiusKm(), +$('#rptRadius').value);

    const color = { '2m': css('--series-1'), '70cm': css('--series-2') };
    const other = css('--series-3');
    const sites = new Map();
    for (const r of filteredRepeaters()) {
      const k = `${r.lat.toFixed(4)},${r.lon.toFixed(4)}`;
      if (!sites.has(k)) sites.set(k, []);
      sites.get(k).push(r);
    }
    for (const items of sites.values()) {
      const first = items[0], n = items.length;
      const onAir = items.some(r => r.operational);
      dot(first, color[rptBand(first.freq)] || other, { radius: n > 1 ? 6.5 : 5, hollow: !onAir })
        .bindTooltip(`<b>${esc(first.city || 'Repeater site')}</b><br><span class="k">${fmtDist(first.dist)} ${compass(first.bearing)}${n > 1 ? ` · ${n} repeaters` : ''}</span>` +
          items.slice(0, 8).map(r => tipRow(`${r.call} ${r.mode}`, `${fmtMHz(r.freq)} ${esc(toneText(r))}`)).join('') +
          (n > 8 ? `<div class="k">+${n - 8} more</div>` : ''), TIP)
        .on('click', () => focusRepeaterRow(first.id))
        .addTo(m.group);
      if (items.some(r => r.id === rpt.highlight)) highlightRing(first).addTo(m.group);
    }
    qthMarker(pos, `<b class="mono">${esc(station().callsign || 'Your QTH')}</b>`).addTo(m.group);

    $('#rptLegend').innerHTML =
      legendKey(`background:${color['2m']};border-radius:50%`, '2 m') +
      legendKey(`background:${color['70cm']};border-radius:50%`, '70 cm') +
      legendKey(`background:${other};border-radius:50%`, 'Other bands') +
      legendKey(`border:2px solid ${css('--muted')};border-radius:50%`, 'Hollow = off air') +
      legendKey(`border:2px solid ${css('--text')};border-radius:50%`, 'Your QTH') +
      '<span class="k">Bigger dot = several repeaters at one site</span>';
  }

  function focusRepeaterRow(id) {
    const row = document.querySelector(`#rptTable tr[data-id="${CSS.escape(String(id))}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1500);
  }

  // ------------------------------------------------------------ APRS

  const APRS_SYMBOLS = {
    '/!': 'Police station', '/#': 'Digipeater', '/$': 'Phone', '/%': 'DX cluster', '/&': 'HF gateway',
    "/'": 'Small aircraft', '/+': 'Red Cross', '/-': 'House', '/;': 'Campground', '/<': 'Motorcycle',
    '/=': 'Train', '/>': 'Car', '/?': 'Server', '/A': 'Aid station', '/E': 'Event', '/F': 'Farm vehicle',
    '/H': 'Hotel', '/I': 'TCP/IP', '/K': 'School', '/O': 'Balloon', '/P': 'Police', '/R': 'RV', '/U': 'Bus',
    '/W': 'NWS site', '/X': 'Helicopter', '/Y': 'Yacht', '/[': 'Person', '/^': 'Aircraft', '/_': 'Weather station',
    '/a': 'Ambulance', '/b': 'Bicycle', '/c': 'Command post', '/d': 'Fire department', '/e': 'Horse',
    '/f': 'Fire truck', '/g': 'Glider', '/h': 'Hospital', '/j': 'Jeep', '/k': 'Truck', '/l': 'Laptop',
    '/m': 'Mic-E repeater', '/n': 'Node', '/o': 'EOC', '/p': 'Rover', '/r': 'Repeater', '/s': 'Boat',
    '/u': 'Semi truck', '/v': 'Van', '/w': 'Water station', '/y': 'House with Yagi',
    '\\!': 'Emergency', '\\#': 'Digipeater', '\\&': 'iGate / gateway', '\\-': 'House', '\\>': 'Car',
    '\\K': 'Kenwood radio', '\\O': 'Rocket', '\\R': 'Restaurant', '\\S': 'Satellite', '\\W': 'NWS site',
    '\\_': 'Weather site', '\\a': 'ARES/RACES', '\\j': 'Jeep', '\\k': 'SUV', '\\m': 'Milepost',
    '\\n': 'Triangle', '\\s': 'Boat', '\\u': 'Truck', '\\v': 'Van', '\\y': 'Skywarn', '\\^': 'Aircraft',
    '\\0': 'Circle', '\\9': 'Gas station', '\\D': 'Depot', '\\L': 'Lighthouse',
  };
  const APRS_MOBILE = new Set(['/>', '/<', '/=', '/O', "/'", '/R', '/U', '/X', '/Y', '/[', '/^', '/a', '/b', '/e', '/f', '/g', '/j', '/k', '/p', '/s', '/u', '/v', '/F', '/P', '\\>', '\\j', '\\k', '\\u', '\\v', '\\s', '\\^']);
  const APRS_INFRA = new Set(['/#', '\\#', '/&', '\\&', '/r', '/I', '/n', '/m', '/%']);
  const APRS_CATS = [['mobile', 'Mobile'], ['fixed', 'Fixed'], ['infra', 'Digi / iGate'], ['weather', 'Weather'], ['object', 'Objects']];

  const aprs = { data: null, cat: storeGet('hamdash.aprsCat') || '', highlight: null, timer: null };

  function aprsCategory(st) {
    if (st.kind !== 'station') return 'object';
    if (st.wx || st.symbol === '/_' || st.symbol === '\\_' || st.symbol === '/W') return 'weather';
    if (APRS_MOBILE.has(st.symbol) || st.speed > 8) return 'mobile';
    if (APRS_INFRA.has(st.symbol)) return 'infra';
    return 'fixed';
  }

  function aprsColor(cat) {
    return { mobile: css('--series-1'), infra: css('--series-2'), weather: css('--series-3'), fixed: css('--text-2') }[cat] || css('--muted');
  }

  const symbolName = st => `${APRS_SYMBOLS[st.symbol] || 'Station'}${st.overlay ? ` (${st.overlay})` : ''}`;
  // Callsign without SSID, if it looks like a real callsign (objects often aren't).
  const lookupCallOf = name => { const c = name.replace(/-[A-Z0-9]{1,2}$/, ''); return /^[A-Z0-9]{3,7}$/.test(c) && /\d/.test(c) && /[A-Z]/.test(c) ? c : null; };
  const agoShort = t => {
    const s = Math.max(0, (Date.now() - t) / 1000);
    return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  };
  const metric = () => station().units === 'km';
  const fmtSpeed = kmh => (metric() ? `${Math.round(kmh)} km/h` : `${Math.round(kmh / 1.609344)} mph`);
  const fmtAlt = m => (metric() ? `${Math.round(m).toLocaleString()} m` : `${Math.round(m / 0.3048).toLocaleString()} ft`);
  const fmtTemp = f => (metric() ? `${Math.round((f - 32) / 1.8)}°C` : `${Math.round(f)}°F`);
  const fmtWind = mph => (metric() ? `${Math.round(mph * 1.609344)} km/h` : `${Math.round(mph)} mph`);
  const fmtRain = inch => (metric() ? `${(inch * 25.4).toFixed(1)} mm` : `${inch.toFixed(2)} in`);


  async function loadAprs() {
    try { aprs.data = await api('api/aprs'); } catch (e) { aprs.data = { status: 'error', error: e.message, stations: [] }; }
    renderAprs();
  }

  function aprsVisible() {
    const d = aprs.data;
    if (!d) return [];
    const since = Date.now() - +$('#aprsSince').value * 60000;
    const q = $('#aprsSearch').value.trim().toUpperCase();
    const here = gridToLatLon(station().grid) || d.center;
    return d.stations
      .filter(st => st.lastHeard >= since)
      .map(st => ({ ...st, cat: aprsCategory(st), dist: here ? distanceKm(here, st) : null, bearing: here ? bearingDeg(here, st) : null }))
      .filter(st => !q || st.name.includes(q) || (st.comment || '').toUpperCase().includes(q) || (st.owner || '').includes(q));
  }

  function renderAprs() {
    const d = aprs.data;
    $('#aprsGrid').textContent = station().grid || 'you';
    if (!d) return;
    const STATUS = {
      connected: `Live · ${d.server}`, connecting: 'Connecting…', reconnecting: 'Reconnecting…',
      disabled: 'Turned off in the app’s configuration', 'no-callsign': 'Set a callsign in the app’s configuration',
      'no-grid': 'Set a grid square in the app’s configuration', error: `Unavailable: ${d.error || ''}`,
    };
    $('#aprsStatus').textContent = STATUS[d.status] || d.status;

    const all = aprsVisible();
    const counts = {};
    for (const st of all) counts[st.cat] = (counts[st.cat] || 0) + 1;
    $('#aprsCatChips').innerHTML = [['', 'All', all.length], ...APRS_CATS.map(([k, l]) => [k, l, counts[k] || 0])]
      .filter(([k, , n]) => !k || n || k === aprs.cat)
      .map(([k, l, n]) => `<button type="button" class="chip" data-cat="${k}" aria-pressed="${aprs.cat === k}">${l}<span class="n">${n}</span></button>`).join('');

    const rows = all.filter(st => !aprs.cat || st.cat === aprs.cat).sort((a, b) => b.lastHeard - a.lastHeard);
    $('#aprsMeta').textContent = `${rows.length} station${rows.length === 1 ? '' : 's'}`;

    const here = gridToLatLon(station().grid);
    const far = here && d.center && distanceKm(here, d.center) > (d.radiusKm || 0) / 2;
    $('#aprsNote').textContent = far
      ? `The live feed covers ${fmtDist(d.radiusKm)} around the app’s grid square, not your browser’s. Change the grid in the app’s configuration to move it.`
      : d.status === 'connected' ? `Receiving everything heard within ${fmtDist(d.radiusKm)} of the app’s grid square. Stations drop off after 3 hours of silence.` : '';

    if (!rows.length) {
      $('#aprsTable').innerHTML = `<tbody><tr><td class="empty">${d.status === 'connected'
        ? 'No stations heard in this window yet. APRS stations beacon every few minutes to every half hour, so give it a little time.'
        : esc(STATUS[d.status] || 'Not connected')}</td></tr></tbody>`;
    } else {
      $('#aprsTable').innerHTML = `<thead><tr><th>Station</th><th>Heard</th><th class="num">Distance</th><th>Info</th></tr></thead><tbody>${
        rows.map(st => {
          const call = st.kind === 'station' ? lookupCallOf(st.name) : null;
          const who = call ? `<button type="button" class="call-link mono" data-call="${esc(call)}" title="Look up ${esc(call)}">${esc(st.name)}</button>` : `<span class="mono call-plain">${esc(st.name)}</span>`;
          const kind = st.kind === 'station' ? symbolName(st) : `${st.kind === 'object' ? 'Object' : 'Item'} by ${st.owner || '?'}`;
          const moving = st.speed > 3;
          const info = moving ? `${fmtSpeed(st.speed)} ${st.course !== undefined ? compass(st.course) : ''}`
            : st.wx?.tempF !== undefined && st.wx.tempF !== null ? fmtTemp(st.wx.tempF)
              : st.alt ? fmtAlt(st.alt) : '';
          const note = st.comment || st.status || '';
          return `<tr data-key="${esc(st.kind + ':' + st.name)}">
            <td>${who}<div class="sub">${esc(kind)} · <a href="https://aprs.fi/info/a/${encodeURIComponent(st.name)}" target="_blank" rel="noopener">aprs.fi</a></div></td>
            <td class="mono">${agoShort(st.lastHeard)}</td>
            <td class="mono num">${st.dist !== null ? fmtDist(st.dist) : '—'}<div class="sub">${st.bearing !== null ? compass(st.bearing) : ''}</div></td>
            <td>${esc(info)}<div class="sub" title="${esc(note)}">${esc(note)}</div></td>
          </tr>`;
        }).join('')
      }</tbody>`;
    }
    renderAprsWeather(all);
    drawAprsMap();
  }

  function renderAprsWeather(all) {
    const wx = all.filter(st => st.wx && st.wxTime > Date.now() - 2 * 3600000 && st.wx.tempF != null)
      .sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9)).slice(0, 8);
    $('#aprsWx').innerHTML = wx.length ? wx.map(st => {
      const w = st.wx;
      const call = lookupCallOf(st.name);
      const wind = w.windMph == null ? ''
        : w.windMph === 0 && !w.gustMph ? 'Calm'
          : `${w.windDir != null ? compass(w.windDir) + ' ' : ''}${fmtWind(w.windMph)}${w.gustMph ? `, gust ${fmtWind(w.gustMph)}` : ''}`;
      const rows = [
        ['Wind', wind],
        ['Humidity', w.humidity != null ? `${w.humidity}%` : ''],
        ['Pressure', w.pressureHpa ? `${w.pressureHpa.toFixed(1)} hPa` : ''],
        ['Rain today', w.rainMidnightIn != null ? fmtRain(w.rainMidnightIn) : ''],
      ].filter(([, v]) => v);
      return `<div class="tile wx-card">
        <span class="label">${call ? `<button type="button" class="call-link mono" data-call="${esc(call)}">${esc(st.name)}</button>` : esc(st.name)}</span>
        <span class="value">${fmtTemp(w.tempF)}</span>
        <span class="sub">${st.dist != null ? `${fmtDist(st.dist)} ${compass(st.bearing)} · ` : ''}${agoShort(st.wxTime)} ago</span>
        <dl class="wx-rows">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      </div>`;
    }).join('') : '<div class="empty">No weather stations heard in this window yet.</div>';
  }

  function drawAprsMap() {
    const el = $('#aprsMap');
    if (!el.offsetWidth) return;
    if (maps.aprs?.hover) { maps.aprs.pending = drawAprsMap; return; }
    const d = aprs.data;
    const center = gridToLatLon(station().grid) || d?.center;
    const m = makeMap('aprs', el, {
      home: () => { const c = gridToLatLon(station().grid) || aprs.data?.center; if (c) fitRadius(maps.aprs, c, aprs.data?.radiusKm || 160); },
    });
    m.group.clearLayers();
    m.labels = [];
    if (!center) return;
    const radiusKm = d?.radiusKm || 160;
    const fitKey = `${center.lat},${center.lon},${radiusKm}`;
    if (m.fitKey !== fitKey && fitRadius(m, center, radiusKm)) m.fitKey = fitKey;
    rangeRings(m, center, radiusKm, Math.round(radiusKm / (station().units === 'mi' ? 1.609344 : 1)));

    const list = aprsVisible().filter(st => !aprs.cat || st.cat === aprs.cat);
    if ($('#aprsTracks').checked) {
      for (const st of list) {
        if (st.track.length < 2) continue;
        L.polyline(st.track.map(([lat, lon]) => [lat, lon]), { color: aprsColor(st.cat), weight: 2, opacity: 0.55, interactive: false }).addTo(m.group);
      }
    }
    const labels = $('#aprsLabels').checked;
    for (const st of list) {
      const c = aprsColor(st.cat);
      const key = `${st.kind}:${st.name}`;
      const moving = st.speed > 3 && st.course !== undefined;
      const marker = st.cat === 'object' ? shapeMarker(st, 'diamond', c, 0, `APRS object ${st.name}`)
        : moving ? shapeMarker(st, 'arrow', c, st.course, `APRS station ${st.name}, moving`)
          : dot(st, c);
      const via = st.path?.digis?.length ? `via ${st.path.digis.join(', ')}` : st.path?.internet ? 'via internet' : 'direct to iGate';
      marker.bindTooltip(`<b class="mono">${esc(st.name)}</b> <span class="k">${esc(st.kind === 'station' ? symbolName(st) : st.kind)}</span>` +
          tipRow('Heard', `${agoShort(st.lastHeard)} ago`) +
          tipRow('Distance', `${fmtDist(st.dist)} ${compass(st.bearing)}`) +
          (st.speed > 3 ? tipRow('Moving', `${fmtSpeed(st.speed)} ${st.course !== undefined ? compass(st.course) : ''}`) : '') +
          (st.alt ? tipRow('Altitude', fmtAlt(st.alt)) : '') +
          (st.wx?.tempF != null ? tipRow('Temperature', fmtTemp(st.wx.tempF)) : '') +
          tipRow('Path', esc(`${via}${st.path?.igate ? ` · iGate ${st.path.igate}` : ''}`)) +
          (st.comment ? `<div class="k">${esc(st.comment)}</div>` : ''), TIP)
        .on('click', () => focusAprsRow(key))
        .addTo(m.group);
      if (key === aprs.highlight) highlightRing(st).addTo(m.group);
      if (labels) addLabel(m, st, st.name);
    }
    qthMarker(center, `<b class="mono">${esc(station().callsign || 'Your QTH')}</b>`).addTo(m.group);
    declutter(m);

    $('#aprsLegend').innerHTML = APRS_CATS.map(([k, l]) => legendKey(k === 'object'
      ? `border:2px solid ${aprsColor(k)};transform:rotate(45deg) scale(.8)`
      : `background:${aprsColor(k)};border-radius:50%`, l)).join('') +
      legendKey(`background:${aprsColor('mobile')};clip-path:polygon(50% 0,100% 100%,0 100%)`, 'Moving (points along course)') +
      legendKey(`border:2px solid ${css('--text')};border-radius:50%`, 'You');
  }

  function focusAprsRow(key) {
    const row = document.querySelector(`#aprsTable tr[data-key="${CSS.escape(key)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1500);
  }

  // ------------------------------------------------------------ POTA

  const pota = { data: null, error: null, band: storeGet('hamdash.potaBand') || '', timer: null };
  const POTA_RANGES = { mi: [250, 500, 1000, 2500], km: [400, 800, 1600, 4000] };
  const DIGI_MODES = new Set(['FT8', 'FT4', 'RTTY', 'PSK31', 'JS8', 'DATA', 'DIGI', 'PSK', 'OLIVIA']);
  const potaModeGroup = m => (m === 'CW' ? 'CW' : DIGI_MODES.has(m) ? 'DIGI' : m ? 'SSB' : '');
  const potaColor = g => ({ CW: css('--series-1'), SSB: css('--series-2'), DIGI: css('--series-3') }[g] || css('--muted'));
  const isQrt = s => /\bQRT\b/i.test(s.comments);

  function fillPotaRanges() {
    const units = station().units, sel = $('#potaRange');
    const saved = storeGet(`hamdash.potaRange.${units}`) || '';
    sel.replaceChildren(new Option('Anywhere', ''), ...POTA_RANGES[units].map(r => new Option(`${r.toLocaleString()} ${units}`, r)));
    sel.value = POTA_RANGES[units].includes(+saved) ? saved : '';
  }

  async function loadPota() {
    try { pota.data = await api('api/pota'); pota.error = null; } catch (e) { pota.error = e.message; }
    renderPota();
  }

  function potaVisible() {
    if (!pota.data) return [];
    const here = gridToLatLon(station().grid);
    const mode = $('#potaMode').value, range = +$('#potaRange').value * (station().units === 'mi' ? 1.609344 : 1);
    const q = $('#potaSearch').value.trim().toUpperCase();
    return pota.data.spots
      .map(s => ({
        ...s, group: potaModeGroup(s.mode),
        dist: here && s.lat !== null ? distanceKm(here, s) : null,
        bearing: here && s.lat !== null ? bearingDeg(here, s) : null,
      }))
      .filter(s => (!mode || s.group === mode) && (!range || (s.dist !== null && s.dist <= range)) &&
        (!q || s.activator.includes(q) || s.reference.toUpperCase().includes(q) || s.park.toUpperCase().includes(q) || s.location.toUpperCase().includes(q)));
  }

  function renderPota() {
    $('#potaStatus').textContent = pota.error ? `Unavailable: ${pota.error}` : pota.data ? `${pota.data.spots.length} spots worldwide` : 'Loading…';
    const all = potaVisible();
    const counts = {};
    for (const s of all) if (s.band) counts[s.band] = (counts[s.band] || 0) + 1;
    $('#potaBandChips').innerHTML = [['', 'All bands', all.length], ...SPOT_BANDS.filter(b => counts[b] || b === pota.band).map(b => [b, b, counts[b] || 0])]
      .map(([v, l, n]) => `<button type="button" class="chip" data-band="${v}" aria-pressed="${pota.band === v}">${l}<span class="n">${n}</span></button>`).join('');

    const rows = all.filter(s => !pota.band || s.band === pota.band);
    if ($('#potaSort').value === 'near') rows.sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9));
    else rows.sort((a, b) => b.time.localeCompare(a.time));
    $('#potaMeta').textContent = `${rows.length} shown`;

    $('#potaTable').innerHTML = !pota.data ? '<tbody><tr><td class="empty">Loading spots…</td></tr></tbody>'
      : !rows.length ? '<tbody><tr><td class="empty">No activators match these filters right now.</td></tr></tbody>'
        : `<thead><tr><th>Activator</th><th class="num">kHz</th><th class="num">Distance</th><th class="hide-sm">Age</th></tr></thead><tbody>${
          rows.slice(0, 200).map(s => {
            const call = lookupCallOf(s.activator.replace(/\/.*$/, '')) || null;
            const who = call ? `<button type="button" class="call-link mono" data-call="${esc(call)}" title="Look up ${esc(call)}">${esc(s.activator)}</button>` : `<span class="mono call-plain">${esc(s.activator)}</span>`;
            return `<tr class="${isQrt(s) ? 'off' : ''}" data-ref="${esc(s.reference)}">
              <td>${who}<span class="show-sm count">${agoShort(Date.parse(s.time))}</span>${isQrt(s) ? ' ' + pill('closed', 'QRT') : ''}<div class="sub" title="${esc(s.park)}"><a href="https://pota.app/#/park/${encodeURIComponent(s.reference)}" target="_blank" rel="noopener">${esc(s.reference)}</a> · ${esc(s.park)}</div></td>
              <td class="mono num freq-out">${s.freq ?? '—'}<div class="sub">${esc([s.band, s.mode].filter(Boolean).join(' · '))}</div></td>
              <td class="mono num">${s.dist !== null ? fmtDist(s.dist) : '—'}<div class="sub">${s.bearing !== null ? compass(s.bearing) : esc(s.location)}</div></td>
              <td class="mono hide-sm">${agoShort(Date.parse(s.time))}<div class="sub">${esc(s.location)}</div></td>
            </tr>`;
          }).join('')
        }</tbody>`;
    drawPotaMap(rows);
  }

  function drawPotaMap(rows = potaVisible().filter(s => !pota.band || s.band === pota.band)) {
    const el = $('#potaMap');
    if (!el.offsetWidth) return;
    if (maps.pota?.hover) { maps.pota.pending = () => drawPotaMap(); return; }
    const home = () => maps.pota.map.setView([30, -20], el.offsetWidth < 520 ? 0 : 1);
    const m = makeMap('pota', el, { world: true, night: true, home });
    if (!m.fitKey) { home(); m.fitKey = 'world'; }
    m.night.refresh();
    m.group.clearLayers();
    const here = gridToLatLon(station().grid);
    for (const s of rows) {
      if (s.lat === null || s.lon === null) continue;
      dot(s, potaColor(s.group), { radius: 4.5, hollow: isQrt(s) })
        .bindTooltip(`<b class="mono">${esc(s.activator)}</b> <span class="k">${esc(s.reference)}</span><br>${esc(s.park)}` +
          tipRow('Frequency', `${s.freq ?? '—'} kHz ${esc(s.mode)}`) +
          (s.dist !== null ? tipRow('Distance', `${fmtDist(s.dist)} ${compass(s.bearing)}`) : '') +
          tipRow('Spotted', `${agoShort(Date.parse(s.time))} ago`) +
          (s.comments ? `<div class="k">${esc(s.comments)}</div>` : ''), TIP)
        .on('click', () => focusRow('#potaTable', `tr[data-ref="${CSS.escape(s.reference)}"]`))
        .addTo(m.group);
    }
    if (here) qthMarker(here, `<b class="mono">${esc(station().callsign || 'Your QTH')}</b>`).addTo(m.group);
    $('#potaLegend').innerHTML = nightLegend() +
      legendKey(`background:${potaColor('CW')};border-radius:50%`, 'CW') +
      legendKey(`background:${potaColor('SSB')};border-radius:50%`, 'Phone') +
      legendKey(`background:${potaColor('DIGI')};border-radius:50%`, 'Digital') +
      legendKey(`border:2px solid ${css('--muted')};border-radius:50%`, 'Hollow = QRT') +
      (here ? legendKey(`border:2px solid ${css('--text')};border-radius:50%`, 'You') : '');
  }

  function focusRow(table, selector) {
    const row = document.querySelector(`${table} ${selector}`);
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1500);
  }

  // ------------------------------------------------------------ satellites

  const sats = { data: null, error: null, type: storeGet('hamdash.satType') || '', selected: null, key: '', timer: null };
  const C_KMS = 299792.458;
  const dopplerDown = (mhz, rr) => mhz * (1 - rr / C_KMS);
  const dopplerUp = (mhz, rr) => mhz * (1 + rr / C_KMS);
  const fmtMHz3 = f => f.toFixed(3);
  const passKey = (s, p) => `${s.id}|${p.aos}`;
  const satBand = f => (Array.isArray(f) ? (f[0] + f[1]) / 2 : f);

  async function loadSats() {
    const pos = gridToLatLon(station().grid);
    $('#satGrid').textContent = station().grid || 'you';
    if (!pos) { sats.data = null; sats.error = 'Set your grid square (top right) to predict passes.'; renderSats(); return; }
    try {
      sats.data = await api(`api/satellites?lat=${pos.lat.toFixed(4)}&lon=${pos.lon.toFixed(4)}`);
      sats.error = null;
    } catch (e) { sats.error = `Couldn't load predictions: ${e.message}`; }
    renderSats();
  }

  function upcomingPasses() {
    if (!sats.data) return [];
    const now = Date.now(), minEl = +$('#satMinEl').value;
    return sats.data.sats
      .filter(s => !s.missing && (!sats.type || s.type === sats.type))
      .flatMap(s => s.passes.filter(p => Date.parse(p.los) > now && p.maxEl >= minEl).map(p => ({ s, p })))
      .sort((a, b) => Date.parse(a.p.aos) - Date.parse(b.p.aos));
  }

  const untilText = ms => {
    const m = Math.round(ms / 60000);
    return m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)}h ${m % 60}m`;
  };

  function renderSats() {
    const types = ['', 'FM', 'Linear'];
    $('#satTypeChips').innerHTML = types.map(t => `<button type="button" class="chip" data-type="${t}" aria-pressed="${sats.type === t}">${t || 'All satellites'}</button>`).join('');
    if (sats.error) {
      $('#passTable').innerHTML = `<tbody><tr><td class="empty">${esc(sats.error)}</td></tr></tbody>`;
      $('#passDetail').innerHTML = '';
      drawSkyPlot(null);
      return;
    }
    if (!sats.data) { $('#passTable').innerHTML = '<tbody><tr><td class="empty">Computing passes…</td></tr></tbody>'; return; }

    const list = upcomingPasses();
    const missing = sats.data.sats.filter(s => s.missing).map(s => s.name);
    $('#satMeta').textContent = `Next 24 hours · ${list.length} passes${missing.length ? ` · no data for ${missing.join(', ')}` : ''}`;
    const now = Date.now();
    if (!list.some(x => passKey(x.s, x.p) === sats.selected)) {
      const pick = list.find(x => Date.parse(x.p.aos) <= now) || list.find(x => x.p.maxEl >= 20) || list[0];
      sats.selected = pick ? passKey(pick.s, pick.p) : null;
    }

    $('#passTable').innerHTML = list.length ? `<thead><tr><th>Satellite</th><th>Starts</th><th class="num">Max el</th><th>Path</th></tr></thead><tbody>${
      list.map(({ s, p }) => {
        const aos = new Date(p.aos), up = Date.parse(p.aos) <= now;
        return `<tr class="pass-row${passKey(s, p) === sats.selected ? ' selected' : ''}" data-pass="${esc(passKey(s, p))}" tabindex="0">
          <td><span class="mono call-plain">${esc(s.name)}</span><div class="sub">${esc(s.type)} · ${esc(s.mode)}</div></td>
          <td class="mono">${clockHM(aos)}<div class="sub">${up ? pill('good', 'Up now') : esc(untilText(aos - now))}</div></td>
          <td class="mono num">${Math.round(p.maxEl)}°<div class="el-bar"><span style="width:${Math.min(100, (p.maxEl / 90) * 100)}%"></span></div></td>
          <td class="mono">${compass(p.aosAz)} → ${compass(p.losAz)}<div class="sub">${Math.round(p.durationMin)} min</div></td>
        </tr>`;
      }).join('')
    }</tbody>` : '<tbody><tr><td class="empty">No passes match these filters in the next 24 hours.</td></tr></tbody>';

    const sel = list.find(x => passKey(x.s, x.p) === sats.selected);
    renderPassDetail(sel);
    drawSkyPlot(sel);
  }

  function renderPassDetail(sel) {
    const box = $('#passDetail');
    if (!sel) { box.innerHTML = '<div class="empty">Select a pass to see its sky track and Doppler-corrected frequencies.</div>'; $('#skyMeta').textContent = ''; return; }
    const { s, p } = sel;
    $('#skyMeta').textContent = `${s.name} · ${clockHM(new Date(p.aos))}`;
    const rr = p.rangeRate;
    const freqRow = (label, f, up) => {
      if (f === undefined) return '';
      const fmt = rate => (Array.isArray(f)
        ? `${((up ? dopplerUp : dopplerDown)(satBand(f), rate) - satBand(f)) * 1000 >= 0 ? '+' : ''}${(((up ? dopplerUp : dopplerDown)(satBand(f), rate) - satBand(f)) * 1000).toFixed(1)} kHz`
        : fmtMHz3((up ? dopplerUp : dopplerDown)(f, rate)));
      const nominal = Array.isArray(f) ? `${fmtMHz3(f[0])}–${fmtMHz3(f[1])}` : fmtMHz3(f);
      return `<tr><td>${label}<div class="sub mono">${nominal}${up && s.tone ? ` · PL ${s.tone}` : ''}</div></td><td class="mono">${fmt(rr.aos)}</td><td class="mono">${fmt(rr.tca)}</td><td class="mono">${fmt(rr.los)}</td></tr>`;
    };
    box.innerHTML = `
      <div class="sun-times">
        ${tile('Rise (AOS)', clockHM(new Date(p.aos)), '', `${utcHM(new Date(p.aos))} UTC · ${Math.round(p.aosAz)}° ${compass(p.aosAz)}`, '', 'aos')}
        ${tile('Highest (TCA)', `${Math.round(p.maxEl)}°`, '', `${clockHM(new Date(p.tca))}`)}
        ${tile('Set (LOS)', clockHM(new Date(p.los)), '', `${utcHM(new Date(p.los))} UTC · ${Math.round(p.losAz)}° ${compass(p.losAz)}`)}
      </div>
      <table class="mini-table doppler">
        <thead><tr><th>${term('doppler', 'Doppler')}</th><th>AOS</th><th>TCA</th><th>LOS</th></tr></thead>
        <tbody>${freqRow('Downlink (listen)', s.downlink, false)}${freqRow('Uplink (transmit)', s.uplink, true)}</tbody>
      </table>
      <p class="note">${esc(s.mode)}${s.notes ? ` · ${esc(s.notes)}` : ''}. ${Array.isArray(s.downlink) ? 'Linear passbands show the shift at the centre of the passband.' : 'Frequencies are corrected for Doppler shift; most radios tune in 5 kHz steps.'}</p>`;
  }

  // Polar plot: centre is straight up, the edge is the horizon.
  function drawSkyPlot(sel) {
    const canvas = $('#skyPlot');
    const w = canvas.clientWidth;
    if (!w) return;
    const ctx = fitCanvas(canvas, w, w);
    const cx = w / 2, cy = w / 2, R = w / 2 - 26;
    ctx.fillStyle = css('--card-2');
    ctx.fillRect(0, 0, w, w);
    ctx.strokeStyle = css('--grid-line');
    ctx.fillStyle = css('--muted');
    ctx.lineWidth = 1;
    ctx.font = '11px system-ui, sans-serif';
    for (const el of [0, 30, 60]) {
      const r = (R * (90 - el)) / 90;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke();
      ctx.fillText(`${el}°`, cx + 4, cy - r + 12);
    }
    ctx.beginPath(); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [t, x, y] of [['N', cx, cy - R - 13], ['S', cx, cy + R + 13], ['E', cx + R + 13, cy], ['W', cx - R - 13, cy]]) ctx.fillText(t, x, y);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
    const dots = [];
    canvasDots.set(canvas, dots);
    if (!sel) return;

    const P = (az, el) => { const r = (R * (90 - Math.max(0, el))) / 90; return [cx + r * Math.sin(az * RAD), cy - r * Math.cos(az * RAD)]; };
    const { s, p } = sel;
    ctx.strokeStyle = css('--series-1');
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    p.track.forEach(([az, el], i) => { const [x, y] = P(az, el); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    // Arrowhead showing direction of travel at the end of the track.
    const [x1, y1] = P(...p.track[p.track.length - 2]), [x2, y2] = P(...p.track[p.track.length - 1]);
    const a = Math.atan2(y2 - y1, x2 - x1);
    ctx.fillStyle = css('--series-1');
    ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2 - 9 * Math.cos(a - 0.45), y2 - 9 * Math.sin(a - 0.45)); ctx.lineTo(x2 - 9 * Math.cos(a + 0.45), y2 - 9 * Math.sin(a + 0.45)); ctx.closePath(); ctx.fill();

    const mark = (az, el, label, html) => {
      const [x, y] = P(az, el);
      ctx.fillStyle = css('--card'); ctx.strokeStyle = css('--series-1'); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
      ctx.fillStyle = css('--text-2');
      ctx.fillText(label, x + 7, y - 6);
      dots.push({ x, y, html });
    };
    const tcaPt = p.track.reduce((b, t) => (t[1] > b[1] ? t : b));
    mark(p.track[0][0], p.track[0][1], `AOS ${clockHM(new Date(p.aos))}`, `<b>Rise</b>${tipRow('Time', clockHM(new Date(p.aos)))}${tipRow('Azimuth', `${Math.round(p.aosAz)}°`)}`);
    mark(tcaPt[0], tcaPt[1], `${Math.round(p.maxEl)}°`, `<b>Highest</b>${tipRow('Time', clockHM(new Date(p.tca)))}${tipRow('Elevation', `${Math.round(p.maxEl)}°`)}${tipRow('Azimuth', `${Math.round(tcaPt[0])}°`)}`);
    mark(p.losAz, 0, `LOS ${clockHM(new Date(p.los))}`, `<b>Set</b>${tipRow('Time', clockHM(new Date(p.los)))}${tipRow('Azimuth', `${Math.round(p.losAz)}°`)}`);

    const now = sats.data?.now?.[s.id];
    if (now && now.el > 0 && Date.parse(p.aos) <= Date.now()) {
      const [x, y] = P(now.az, now.el);
      ctx.fillStyle = css('--series-2'); ctx.strokeStyle = css('--card'); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 7, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
      dots.push({ x, y, html: `<b>${esc(s.name)} now</b>${tipRow('Azimuth', `${Math.round(now.az)}° ${compass(now.az)}`)}${tipRow('Elevation', `${Math.round(now.el)}°`)}${tipRow('Range', `${fmtDist(now.range)}`)}` });
    }
  }

  // ------------------------------------------------------------ callsign lookup

  const look = { result: null, loading: null, error: null };
  const recentCalls = () => { try { return JSON.parse(storeGet('hamdash.recent')) || []; } catch { return []; } };
  const titleCase = s => (s && s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()) : s || '');
  const LICENSE_CLASS = { E: 'Amateur Extra', EXTRA: 'Amateur Extra', A: 'Advanced', ADVANCED: 'Advanced', G: 'General', GENERAL: 'General', T: 'Technician', TECHNICIAN: 'Technician', N: 'Novice', NOVICE: 'Novice', P: 'Technician Plus' };

  async function lookup(call) {
    call = String(call || '').trim().toUpperCase();
    $('#lookupInput').value = call;
    if (currentView !== 'lookup') showView('lookup');
    if (!/^[A-Z0-9/]{3,15}$/.test(call)) { look.error = 'Enter a valid callsign.'; look.result = null; renderLookup(); return; }
    look.loading = call;
    look.error = null;
    renderLookup();
    try {
      const r = await api(`api/lookup?call=${encodeURIComponent(call)}`);
      if (look.loading !== call) return;
      look.result = r;
      if (!r.notFound) storeSet('hamdash.recent', JSON.stringify([call, ...recentCalls().filter(c => c !== call)].slice(0, 10)));
    } catch (e) {
      look.result = null;
      look.error = `Lookup failed: ${e.message}`;
    }
    look.loading = null;
    renderLookup();
  }

  const lookupPos = r => (r && r.lat != null && r.lon != null ? { lat: r.lat, lon: r.lon } : gridToLatLon(r?.grid));

  function renderLookup() {
    const recent = recentCalls();
    $('#lookupRecent').innerHTML = recent.length
      ? `<span class="meta">Recent:</span>${recent.map(c => `<button type="button" class="chip mono" data-call="${esc(c)}">${esc(c)}</button>`).join('')}`
      : '';
    $('#lookupNote').innerHTML = state.defaults.qrz
      ? 'Lookups use your QRZ account, with FCC data filling gaps for US calls.'
      : 'US callsigns are looked up free from FCC data. For worldwide lookups, add your QRZ username and password on the app’s Configuration tab. Full QRZ details need a <a href="https://www.qrz.com/page/xml_data.html" target="_blank" rel="noopener">QRZ XML subscription</a>.';

    const out = $('#lookupResult');
    const r = look.result;
    $('#lookupPathCard').hidden = true;
    if (look.loading) { out.innerHTML = `<div class="empty">Looking up ${esc(look.loading)}…</div>`; return; }
    if (look.error) { out.innerHTML = `<p class="error">${esc(look.error)}</p>`; return; }
    if (!r) { out.innerHTML = '<div class="empty">Enter a callsign above, or click any callsign in the spots, PSKReporter or repeater lists.</div>'; return; }
    if (r.notFound) {
      out.innerHTML = `<div class="empty">No record found for <b class="mono">${esc(r.call)}</b>.${
        r.qrz ? '' : ' Without a QRZ account, only US callsigns can be looked up.'}</div>${
        r.warning ? `<p class="error">${esc(r.warning)}</p>` : ''}`;
      return;
    }

    const cls = LICENSE_CLASS[String(r.class || '').toUpperCase()] || titleCase(r.class);
    const qsl = [r.lotw && 'LoTW', r.eqsl && 'eQSL', r.mqsl && 'Direct (mail)'].filter(Boolean).join(', ');
    const facts = [
      ['Address', [r.addr1, r.addr2].filter(Boolean).map(titleCase)
        .map(s => s.replace(/, ([A-Z][a-z]) (\d{5})/, (m, st, zip) => `, ${st.toUpperCase()} ${zip}`)).map(esc).join('<br>')],
      ['County', esc(r.county)],
      ['Country', esc(r.country)],
      ['Grid', r.grid ? `<span class="mono">${esc(r.grid)}</span>` : ''],
      ['License class', esc(cls)],
      ['Granted', esc(r.effective)],
      ['Expires', esc(r.expires)],
      ['Trustee', r.trustee ? callLink(r.trustee) : ''],
      ['Previous call', r.previous ? `<span class="mono">${esc(r.previous)}</span>` : ''],
      ['Aliases', r.aliases ? `<span class="mono">${esc(r.aliases)}</span>` : ''],
      ['QSL', esc(qsl)],
      ['QSL manager', esc(r.qslmgr)],
      ['Zones', [r.dxcc && `DXCC ${r.dxcc}`, r.cqzone && `CQ ${r.cqzone}`, r.ituzone && `ITU ${r.ituzone}`].filter(Boolean).map(esc).join(' · ')],
      ['Time zone', esc(r.timezone)],
    ].filter(([, v]) => v);

    out.innerHTML = `
      <div class="lookup-head">
        ${httpsUrl(r.image) ? `<img class="lookup-photo" src="${esc(httpsUrl(r.image))}" alt="Photo from QRZ for ${esc(r.call)}" referrerpolicy="no-referrer">` : ''}
        <div>
          <div class="lookup-call mono">${esc(r.call)}</div>
          <div class="lookup-name">${esc(titleCase(r.name))}${r.nickname ? ` “${esc(r.nickname)}”` : ''}</div>
          <div class="lookup-tags">${cls ? `<span class="tag">${esc(cls)}</span>` : ''}${(r.sources || []).map(s => `<span class="tag">${esc(s)}</span>`).join('')}</div>
        </div>
      </div>
      <dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>
      <div class="lookup-links">
        ${httpsUrl(r.url) ? `<a href="${esc(httpsUrl(r.url))}" target="_blank" rel="noopener">QRZ.com page</a>` : ''}
        ${httpsUrl(r.uls) ? `<a href="${esc(httpsUrl(r.uls))}" target="_blank" rel="noopener">FCC license record</a>` : ''}
        <button type="button" class="link-btn" data-path-target="${esc(r.call)}">Propagation to ${esc(r.call)}</button>
      </div>
      ${r.warning ? `<p class="error">QRZ lookup failed (${esc(r.warning)}), so this shows FCC data only.</p>` : ''}`;

    const there = lookupPos(r), here = gridToLatLon(station().grid);
    if (there && here) {
      $('#lookupPathCard').hidden = false;
      const d = distanceKm(here, there), b = bearingDeg(here, there);
      const alt = sunAltitude(sunPosition(new Date()), there.lat, there.lon);
      $('#lookupPath').innerHTML = [
        tile('Distance', fmtDist(d), '', 'Short path'),
        tile('Beam heading', `${Math.round(b)}°`, '', `${compass(b)} · short path`),
        tile('Long path', `${Math.round((b + 180) % 360)}°`, '', fmtDist(40075 - d)),
        tile('Sun at station', sunPhase(alt), '', `Elevation ${alt.toFixed(0)}°`),
      ].join('');
      drawLookupMap();
    }
  }

  // Points along the great circle from a to b (spherical interpolation).
  function greatCircle(a, b, n = 160) {
    const v = p => [Math.cos(p.lat * RAD) * Math.cos(p.lon * RAD), Math.cos(p.lat * RAD) * Math.sin(p.lon * RAD), Math.sin(p.lat * RAD)];
    const A = v(a), B = v(b);
    const d = Math.acos(Math.max(-1, Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2])));
    if (d < 1e-6) return [a, b];
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, s1 = Math.sin((1 - t) * d) / Math.sin(d), s2 = Math.sin(t * d) / Math.sin(d);
      const [x, y, z] = [0, 1, 2].map(k => s1 * A[k] + s2 * B[k]);
      pts.push({ lat: Math.atan2(z, Math.hypot(x, y)) / RAD, lon: Math.atan2(y, x) / RAD });
    }
    return pts;
  }

  function drawLookupMap() {
    const r = look.result;
    const there = lookupPos(r), here = gridToLatLon(station().grid);
    const el = $('#lookupMap');
    if ($('#lookupPathCard').hidden || !there || !here || !el.offsetWidth) return;
    // Unwrap the great circle so it's drawn as one line even across the antimeridian.
    const path = [];
    for (const p of greatCircle(here, there)) {
      let lon = p.lon;
      if (path.length) {
        const prev = path[path.length - 1][1];
        while (lon - prev > 180) lon -= 360;
        while (lon - prev < -180) lon += 360;
      }
      path.push([p.lat, lon]);
    }
    const fit = () => maps.lookup.map.fitBounds(L.latLngBounds(path), { padding: [30, 30], maxZoom: 9 });
    const m = makeMap('lookup', el, { world: true, night: true, home: fit });
    m.night.refresh();
    m.group.clearLayers();
    L.polyline(path, { color: css('--series-1'), weight: 2.5, interactive: false }).addTo(m.group);
    const end = path[path.length - 1];
    dot({ lat: end[0], lon: end[1] }, css('--series-2'), { radius: 6 })
      .bindTooltip(`<b class="mono">${esc(r.call)}</b><br>${esc(titleCase(r.name))}`, TIP)
      .addTo(m.group);
    qthMarker(here, `<b class="mono">${esc(station().callsign || 'Your QTH')}</b>`).addTo(m.group);
    const fitKey = `${r.call}|${station().grid}`;
    if (m.fitKey !== fitKey) { fit(); m.fitKey = fitKey; }

    $('#lookupLegend').innerHTML = nightLegend() +
      legendKey(`border:2px solid ${css('--text')};border-radius:50%`, 'Your QTH') +
      legendKey(`background:${css('--series-2')};border-radius:50%`, r.call) +
      legendKey(`height:0;border-top:2px solid ${css('--series-1')};border-radius:0`, 'Short path');
  }

  // ------------------------------------------------------------ tabs

  // ------------------------------------------------------------ propagation (point to point)

  const prop = { data: null, query: null, loading: false, error: null, side: 'short', saved: [], max: 10, timer: null };
  // 10 m at the top, like a frequency axis.
  const PROP_BANDS = HF_BANDS.map(b => b[0]).reverse();
  const LIMIT_TEXT = { muf: 'above the MUF', absorption: 'daytime absorption', aurora: 'auroral zone, high Kp' };

  function analyzePath(q, { quiet = false } = {}) {
    const pos = gridToLatLon(station().grid);
    if (!pos) { prop.error = 'Set your grid square in settings first.'; renderProp(); return; }
    prop.query = q;
    storeSet('hamdash.propTarget', JSON.stringify(q));
    if (!quiet) { prop.loading = true; prop.error = null; renderProp(); }
    const params = new URLSearchParams({ lat: pos.lat.toFixed(4), lon: pos.lon.toFixed(4) });
    if (q.tlat != null) {
      params.set('tlat', q.tlat.toFixed(4)); params.set('tlon', q.tlon.toFixed(4));
      if (q.label) params.set('tlabel', q.label);
      if (q.place) params.set('tplace', q.place);
    } else params.set('target', q.target);
    // Only the latest request may update the page.
    const seq = prop.seq = (prop.seq || 0) + 1;
    return api(`api/path?${params}`)
      .then(d => { if (seq === prop.seq) { prop.data = d; prop.error = null; } })
      .catch(e => { if (seq === prop.seq) { prop.error = e.message; if (!quiet) prop.data = null; } })
      .finally(() => { if (seq === prop.seq) { prop.loading = false; renderProp(); } });
  }

  // From other tabs: a DX spot or a lookup result.
  function analyzeTarget(target) {
    $('#propInput').value = target;
    // Set first, so opening the tab doesn't restore the last target instead.
    prop.query = { target };
    showView('prop');
    analyzePath({ target });
  }

  async function loadSavedPaths() {
    try { const d = await api('api/paths'); prop.saved = d.paths || []; prop.max = d.max || 10; } catch (e) { console.warn(e); }
    if (currentView === 'prop') renderProp();
  }

  const isSaved = t => prop.saved.some(p => Math.abs(p.lat - t.lat) < 0.01 && Math.abs(p.lon - t.lon) < 0.01);

  async function savePath() {
    const t = prop.data?.target;
    if (!t) return;
    const suggestion = (t.place ? t.place.split(',')[0] : t.label).slice(0, 30);
    const label = prompt('Name this path. It also names its Home Assistant sensor.', suggestion);
    if (!label || !label.trim()) return;
    try {
      const d = await api('api/paths', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label, target: t }) });
      prop.saved = d.paths;
    } catch (e) { prop.error = e.message; }
    renderProp();
  }

  async function removePath(id) {
    const p = prop.saved.find(x => x.id === id);
    if (!p || !confirm(`Remove the saved path “${p.label}”? Its Home Assistant sensor goes away too.`)) return;
    try { prop.saved = (await api(`api/paths?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } })).paths; } catch (e) { prop.error = e.message; }
    renderProp();
  }


  function propPill(x) {
    if (!x) return pill('none', 'n/a');
    return pill(x.rating, RATING_LABEL[x.rating], x.limit ? `Limited by ${LIMIT_TEXT[x.limit]}` : '');
  }

  function heardCell(m, dirs) {
    if (!m) return `<span class="meta">${dirs.toYou || dirs.fromYou ? '0' : '—'}</span>`;
    const parts = [];
    if (m.toYou) parts.push(`<span title="${m.toYou} heard near you from near the target">↓${m.toYou}</span>`);
    if (m.fromYou) parts.push(`<span title="${m.fromYou} from near you heard near the target">↑${m.fromYou}</span>`);
    return `<span class="mono">${parts.join(' ')}</span>${m.bestSnr != null ? `<div class="sub">best ${m.bestSnr} dB</div>` : ''}`;
  }

  // Good windows over the next 24 hours, highest bands first.
  function windowsText(summary) {
    const runs = PROP_BANDS.flatMap(b => (summary.windows[b] || []).map(w => ({ b, ...w }))).slice(0, 5);
    if (!runs.length) return 'No band is rated good on this path in the next 24 hours.';
    const span = w => `${clockHour(w.start)}–${clockHour(Date.parse(w.end) + 3600_000)}`;
    return `<b>Good windows:</b> ${runs.map(w => `${esc(w.b)} ${span(w)}`).join(' · ')}`;
  }

  function renderProp() {
    const d = prop.data;
    $('#propError').hidden = !prop.error;
    $('#propError').textContent = prop.error || '';
    $('#propMeta').textContent = d ? `SFI ${d.inputs.sfi ?? '—'} · SSN ${d.inputs.ssn} · Kp ${d.inputs.kp?.toFixed?.(1) ?? d.inputs.kp} · ${d.inputs.ionosondes} ionosondes` : prop.loading ? 'Analyzing…' : '';
    $('#propSaved').innerHTML = prop.saved.length
      ? `<span class="meta">Saved:</span>${prop.saved.map(p => `<span class="chip-pair"><button type="button" class="chip" data-saved="${esc(p.id)}" title="${esc(p.place || p.grid)}">${esc(p.label)}</button>${state.defaults.admin ? `<button type="button" class="chip chip-x" data-unsave="${esc(p.id)}" aria-label="Remove ${esc(p.label)}" title="Remove">×</button>` : ''}</span>`).join('')}`
      : '';
    $('#propHint').hidden = !!d;
    $('#propNowCard').hidden = !d;
    $('#propDayCard').hidden = !d;
    drawPropMap();
    if (!d) return;

    const t = d.target, s = d.short, l = d.long;
    const saved = isSaved(t);
    // Saved paths are shared by the household: only admins add them.
    $('#propSave').hidden = !state.defaults.admin;
    $('#propSave').textContent = saved ? '★ Saved' : '☆ Save path';
    $('#propSave').disabled = saved || prop.saved.length >= prop.max;
    $('#propSave').title = saved ? 'This path is saved' : prop.saved.length >= prop.max ? `You can save up to ${prop.max} paths` : 'Save this path and get a Home Assistant sensor for it';

    $('#propTarget').innerHTML = `
      <div class="prop-target"><span class="lookup-call mono">${esc(t.label)}</span>
        <span>${esc([t.name && titleCase(t.name), t.place].filter(Boolean).join(' · '))}</span></div>
      <div class="sun-times prop-tiles">
        ${tile('Distance', fmtDist(s.km), '', `${s.hops} hop${s.hops === 1 ? '' : 's'} · ${s.elevation > 1 ? `${Math.round(s.elevation)}° takeoff` : 'low takeoff'}`)}
        ${tile('Beam heading', `${Math.round(s.bearing)}°`, '', `${compass(s.bearing)} · long path ${Math.round(l.bearing)}°`)}
        ${tile('Path MUF', s.now.muf.toFixed(1), 'MHz', `Work near ${s.now.fot.toFixed(1)} MHz`, '', 'muf')}
        ${tile('Best now', s.summary.best ? s.summary.best.band : 'None', '', s.summary.best ? RATING_LABEL[s.summary.best.rating] : 'No band rated fair or better')}
      </div>
      ${t.approximate ? `<p class="note">Location from the callsign prefix (${esc(t.place)}), so it’s approximate.</p>` : ''}`;

    const m = d.measured;
    $('#propNow').innerHTML = `<thead><tr><th>Band</th><th>Short path</th><th>Long path</th><th class="num">Heard<small>last ${m.windowMin} min</small></th></tr></thead><tbody>${
      PROP_BANDS.map(b => `<tr><td class="band">${b}</td><td>${propPill(s.now.bands[b])}</td><td>${propPill(l.now.bands[b])}</td><td class="num">${heardCell(m.bands[b], m.directions)}</td></tr>`).join('')
    }</tbody>`;
    const heardAny = Object.keys(m.bands).length;
    $('#propNowNote').textContent = [
      `Ratings are estimates from a simplified model: the sunspot number, the sun along the path, Kp, and ${d.anchorStations ? `${d.anchorStations} live ionosondes` : 'no live ionosondes right now'}.`,
      `“Heard” is measured: PSKReporter decodes (mostly FT8) between stations near you and near the target, ↓ toward you and ↑ from your area.`,
      !m.directions.toYou && !m.directions.fromYou
        ? 'PSKReporter data isn’t available right now (it may be asking the app to slow down; see Data sources in settings), so “Heard” is empty.'
        : m.waitUntil ? `The ↑ direction needs its own PSKReporter query, limited to one new area every 5 minutes; it fills in after ${clockHM(new Date(m.waitUntil))}.` : '',
      heardAny || (!m.directions.toYou && !m.directions.fromYou) ? '' : 'Nothing heard doesn’t mean closed: nobody may be on.',
    ].filter(Boolean).join(' ');

    // 24-hour grid
    const side = prop.side === 'long' ? l : s;
    for (const b of document.querySelectorAll('#propPathTabs [data-path]')) b.setAttribute('aria-selected', b.dataset.path === prop.side);
    $('#propWindows').innerHTML = windowsText(side.summary);
    const hours = side.hours;
    const head = hours.map((h, i) => {
      const dt = new Date(h.t), hr = useUtc() ? dt.getUTCHours() : dt.getHours(), lab = hr % 3 === 0 || i === 0 ? clockHour(h.t) : '';
      return `<th scope="col" title="${esc(clockDayHour(h.t))}">${esc(lab)}</th>`;
    }).join('');
    const rows = PROP_BANDS.map(b => `<tr><th scope="row" class="band">${b}</th>${hours.map(h => {
      const r = h.bands[b];
      return `<td class="r-${r}" title="${esc(`${b} · ${clockDayHour(h.t)}: ${RATING_LABEL[r]} (MUF ${h.muf} MHz)`)}"><span class="sr-only">${RATING_LABEL[r]}</span></td>`;
    }).join('')}</tr>`).join('');
    const muf = `<tr class="muf"><th scope="row">MUF</th>${hours.map((h, i) => `<td>${i % 3 === 0 ? Math.round(h.muf) : ''}</td>`).join('')}</tr>`;
    $('#propGrid').innerHTML = `<thead><tr><th></th>${head}</tr></thead><tbody>${rows}${muf}</tbody>`;
    $('#propGridLegend').innerHTML = ['good', 'fair', 'poor', 'closed'].map(r => legendKey('', RATING_LABEL[r]).replace('<span class="sw" style="">', `<span class="sw r-${r}">`)).join('');
    $('#propDayNote').textContent = `${prop.side === 'long' ? `Long path: ${fmtDist(l.km)} at ${Math.round(l.bearing)}°. ` : ''}${useUtc() ? 'Hours in UTC' : 'Hours in your local time'}. A model outlook: it follows the sun along the path at today’s sunspot level with Kp held at its current value, and leans on the live ionosondes for the first few hours. It can’t foresee flares or storms.`;
  }

  // Points from p along a bearing for km (for the long path, which the
  // short-path interpolation can't draw).
  function walk(p, bearing, km, n = 160) {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const dd = (km * i / n) / 6371, b = bearing * RAD, la = p.lat * RAD, lo = p.lon * RAD;
      const lat = Math.asin(Math.sin(la) * Math.cos(dd) + Math.cos(la) * Math.sin(dd) * Math.cos(b));
      const lon = lo + Math.atan2(Math.sin(b) * Math.sin(dd) * Math.cos(la), Math.cos(dd) - Math.sin(la) * Math.sin(lat));
      out.push({ lat: lat / RAD, lon: lon / RAD });
    }
    return out;
  }

  // Unwrap longitudes so a path is one line across the antimeridian.
  function unwrapPath(points) {
    const out = [];
    for (const p of points) {
      let lon = p.lon;
      if (out.length) {
        const prev = out[out.length - 1][1];
        while (lon - prev > 180) lon -= 360;
        while (lon - prev < -180) lon += 360;
      }
      out.push([p.lat, lon]);
    }
    return out;
  }

  function drawPropMap() {
    const el = $('#propMap');
    if (!el.offsetWidth) return;
    const d = prop.data, here = gridToLatLon(station().grid);
    const shortLine = d && here ? unwrapPath(greatCircle(here, d.target)) : null;
    const fit = () => {
      if (shortLine) maps.prop.map.fitBounds(L.latLngBounds(shortLine), { padding: [30, 30], maxZoom: 6 });
      else maps.prop.map.setView([25, here ? here.lon : 0], el.offsetWidth < 520 ? 0 : 1);
    };
    const m = makeMap('prop', el, { world: true, night: true, home: fit });
    if (!m.clickBound) {
      m.clickBound = true;
      m.map.on('click', e => {
        const lon = ((e.latlng.lng + 540) % 360) - 180;
        $('#propInput').value = '';
        analyzePath({ tlat: e.latlng.lat, tlon: lon });
      });
    }
    if (!m.fitKey) { fit(); m.fitKey = 'world'; }
    m.night.refresh();
    m.group.clearLayers();
    if (d && here) {
      const c = css('--series-1');
      L.polyline(unwrapPath(walk(here, d.long.bearing, d.long.km)), { color: c, weight: 2, opacity: 0.45, dashArray: '6 6', interactive: false }).addTo(m.group);
      L.polyline(shortLine, { color: c, weight: 2.5, interactive: false }).addTo(m.group);
      // Keep markers on the same copy of the world as the line, which may run
      // past ±180°.
      const lons = shortLine.map(p => p[1]);
      const onLine = p => {
        const mid = (Math.min(...lons) + Math.max(...lons)) / 2;
        let lon = p.lon;
        while (lon - mid > 180) lon -= 360;
        while (lon - mid < -180) lon += 360;
        return { ...p, lon };
      };
      for (const r of d.short.now.reflections) {
        shapeMarker(onLine(r), 'diamond', css('--series-3'), 0, `Path control point, MUF ${r.muf.toFixed(1)} MHz`)
          .bindTooltip(`<b>Control point</b>${tipRow('foF2', `${r.fof2.toFixed(1)} MHz`)}${tipRow('Hop MUF', `${r.muf.toFixed(1)} MHz`)}${tipRow('Sun', sunPhase(r.sunAlt))}${r.station ? tipRow('Anchored to', `${esc(r.station)} (${fmtDist(r.stationKm)})`) : tipRow('Anchored to', 'global ionosonde average')}`, TIP)
          .addTo(m.group);
      }
      dot(onLine(d.target), css('--series-2'), { radius: 6 })
        .bindTooltip(`<b class="mono">${esc(d.target.label)}</b><br>${esc(d.target.place || d.target.grid || '')}`, TIP)
        .addTo(m.group);
      const key = `${d.target.lat},${d.target.lon}|${station().grid}`;
      if (m.fitKey !== key) { fit(); m.fitKey = key; }
    }
    if (here) qthMarker(here, `<b class="mono">${esc(station().callsign || 'Your QTH')}</b>`).addTo(m.group);
    $('#propLegend').innerHTML = nightLegend() +
      legendKey(`border:2px solid ${css('--text')};border-radius:50%`, 'Your QTH') +
      legendKey(`background:${css('--series-2')};border-radius:50%`, 'Target') +
      legendKey(`height:0;border-top:2px solid ${css('--series-1')};border-radius:0`, 'Short path') +
      legendKey(`height:0;border-top:2px dashed ${css('--series-1')};border-radius:0;opacity:.6`, 'Long path') +
      legendKey(`background:${css('--series-3')};transform:rotate(45deg);border-radius:1px`, 'Control point', 'controlpoint');
  }

  function bindProp() {
    $('#propForm').addEventListener('submit', e => {
      e.preventDefault();
      const target = $('#propInput').value.trim();
      if (target) analyzePath({ target });
    });
    $('#propSave').addEventListener('click', savePath);
    $('#propSaved').addEventListener('click', e => {
      const un = e.target.closest('[data-unsave]');
      if (un) return removePath(un.dataset.unsave);
      const b = e.target.closest('[data-saved]');
      const p = b && prop.saved.find(x => x.id === b.dataset.saved);
      if (p) { $('#propInput').value = p.target || p.grid; analyzePath({ tlat: p.lat, tlon: p.lon, label: p.target || p.grid, place: p.place }); }
    });
    $('#propPathTabs').addEventListener('click', e => {
      const b = e.target.closest('[data-path]');
      if (b) { prop.side = b.dataset.path; renderProp(); }
    });
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-path-target]');
      if (b) analyzeTarget(b.dataset.pathTarget);
    });
    $('#timeStations').addEventListener('click', e => {
      const b = e.target.closest('[data-timesig]');
      const st = b && REF.TIME_STATIONS.find(x => x.call === b.dataset.timesig);
      if (!st) return;
      $('#propInput').value = st.call;
      analyzePath({ tlat: st.lat, tlon: st.lon, label: st.call, place: st.place });
      $('#h-propnow').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    });
    $('#beaconTable').addEventListener('click', e => {
      const b = e.target.closest('[data-beacon]');
      const bc = b && REF.BEACONS[+b.dataset.beacon];
      if (!bc) return;
      $('#propInput').value = bc.call;
      analyzePath({ tlat: bc.lat, tlon: bc.lon, label: bc.call, place: bc.place });
      $('#h-propnow').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    });
  }

  // ------------------------------------------------------------ NCDXF/IARU beacons

  const beacons = { data: null, error: null, loadedAt: 0, key: '', timer: null };

  async function loadBeacons() {
    const pos = gridToLatLon(station().grid);
    if (!pos) { beacons.data = null; renderBeacons(); return; }
    beacons.key = station().grid;
    beacons.loadedAt = Date.now();
    try { beacons.data = await api(`api/beacons?lat=${pos.lat.toFixed(4)}&lon=${pos.lon.toFixed(4)}`); beacons.error = null; } catch (e) { beacons.error = e.message; }
    renderBeacons();
  }

  const beaconRating = (i, band) => beacons.data?.beacons[i]?.bands[band];

  function renderBeacons() {
    const pos = gridToLatLon(station().grid);
    if (!pos) {
      $('#beaconTable').innerHTML = '<tbody><tr><td class="empty">Set your grid square to rate the paths to the beacons.</td></tr></tbody>';
      $('#beaconNow').innerHTML = '';
      return;
    }
    $('#beaconMeta').textContent = beacons.error ? beacons.error : beacons.data ? `Ratings from ${ago(beacons.data.computed)}` : 'Loading…';
    const bands = REF.BEACON_BANDS;
    $('#beaconTable').innerHTML = `<thead><tr><th>Beacon</th><th class="hide-sm">Location</th><th class="num">Distance</th>${
      bands.map(([band, mhz]) => `<th>${band}<small>${mhz.toFixed(3)}</small></th>`).join('')}</tr></thead><tbody>${
      REF.BEACONS.map((b, i) => {
        const d = beacons.data?.beacons[i];
        return `<tr><td><button type="button" class="call-link mono" data-beacon="${i}" title="Analyze the path to ${esc(b.call)}">${esc(b.call)}</button><div class="sub show-sm">${esc(b.place)}</div></td>
          <td class="hide-sm">${esc(b.place)}</td>
          <td class="num">${d ? `${fmtDist(d.km)}<div class="sub">${d.bearing}° ${compass(d.bearing)}</div>` : '—'}</td>
          ${bands.map(([band]) => `<td data-b="${i}" data-band="${band}">${beaconRating(i, band) ? ratingPill(beaconRating(i, band)) : '<span class="meta">—</span>'}</td>`).join('')}</tr>`;
      }).join('')}</tbody>`;
    tickBeacons(true);
  }

  // Once a second: who's on the air now on each band, and the countdown.
  function tickBeacons(force = false) {
    if (currentView !== 'prop' && !force) return;
    if (Date.now() - timesig.loadedAt > 10 * 60000 || (timesig.key && timesig.key !== station().grid)) loadTimeSignals();
    for (const el of document.querySelectorAll('#timeStations [data-alert]')) {
      const st = REF.TIME_STATIONS.find(x => x.call === el.dataset.alert);
      if (st) el.textContent = alertText(st);
    }
    if (gridToLatLon(station().grid) && (beacons.key !== station().grid || Date.now() - beacons.loadedAt > 5 * 60000)) { loadBeacons(); return; }
    const s = REF.beaconSchedule(Date.now());
    const sig = s.bands.map(b => b.now).join();
    if (force || beacons.sig !== sig) {
      beacons.sig = sig;
      for (const el of document.querySelectorAll('#beaconTable td.on-air')) el.classList.remove('on-air');
      for (const b of s.bands) document.querySelector(`#beaconTable td[data-b="${b.now}"][data-band="${b.band}"]`)?.classList.add('on-air');
      $('#beaconNow').innerHTML = s.bands.map(b => {
        const on = REF.BEACONS[b.now], r = beaconRating(b.now, b.band);
        return `<div class="tile beacon-tile">
          <span class="label">${b.band} <span class="meta">${b.mhz.toFixed(3)} MHz</span></span>
          <span class="value mono">${esc(on.call)}</span>
          <span class="sub">${esc(on.place)}</span>
          <span class="beacon-rating">${r ? ratingPill(r) : ''}</span>
          <span class="sub">Next <span class="mono">${esc(REF.BEACONS[b.next].call)}</span> in <span class="beacon-left">${s.remaining}</span> s</span>
        </div>`;
      }).join('');
    } else {
      for (const el of document.querySelectorAll('#beaconNow .beacon-left')) el.textContent = s.remaining;
    }
  }

  // ------------------------------------------------------------ WWV / WWVH time signals

  const timesig = { data: null, error: null, loadedAt: 0, key: '' };

  async function loadTimeSignals() {
    const pos = gridToLatLon(station().grid);
    if (!pos) { timesig.data = null; renderTimeSignals(); return; }
    timesig.key = station().grid;
    timesig.loadedAt = Date.now();
    try { timesig.data = await api(`api/timesignals?lat=${pos.lat.toFixed(4)}&lon=${pos.lon.toFixed(4)}`); timesig.error = null; } catch (e) { timesig.error = e.message; }
    renderTimeSignals();
  }

  // Highest frequency rated good right now, else fair.
  function bestTimeFreq(s) {
    for (const want of ['good', 'fair']) {
      const f = [...s.freqs].reverse().find(x => x.now === want);
      if (f) return f;
    }
    return null;
  }

  const alertText = st => {
    const m = REF.minutesToAlert(st, Date.now());
    return m === 0 ? 'Space weather report on now' : `Space weather report in ${m} min (:${st.alertMinute})`;
  };

  function renderTimeSignals() {
    const pos = gridToLatLon(station().grid);
    if (!pos) {
      $('#timeStations').innerHTML = '<p class="empty">Set your grid square to rate the paths to WWV and WWVH.</p>';
      $('#timeGrid').innerHTML = '';
      return;
    }
    const d = timesig.data;
    $('#timeMeta').textContent = timesig.error || (d ? `Ratings from ${ago(d.computed)}` : 'Loading…');
    $('#timeStations').innerHTML = REF.TIME_STATIONS.map(st => {
      const s = d?.stations.find(x => x.call === st.call);
      const best = s && bestTimeFreq(s);
      return `<div class="tile time-tile">
        <span class="label"><button type="button" class="call-link mono" data-timesig="${esc(st.call)}" title="Analyze the path to ${esc(st.call)}">${esc(st.call)}</button> <span class="meta">${esc(st.place)}</span></span>
        <span class="value">${best ? `${best.mhz} MHz` : s ? 'None open' : '—'}</span>
        <span class="sub">${best ? `Best now · ${RATING_LABEL[best.now]}` : s ? 'No frequency rated fair or better right now' : ''}</span>
        <span class="sub">${s ? `${fmtDist(s.km)} · ${s.bearing}° ${compass(s.bearing)}` : ''}</span>
        <span class="sub time-alert" data-alert="${esc(st.call)}">${alertText(st)}</span>
      </div>`;
    }).join('');
    if (!d) { $('#timeGrid').innerHTML = ''; return; }
    const start = Date.parse(d.stations[0].hourStart);
    const hours = Array.from({ length: 24 }, (_, i) => start + i * 3600_000);
    const head = hours.map((t, i) => {
      const dt = new Date(t), hr = useUtc() ? dt.getUTCHours() : dt.getHours();
      return `<th scope="col" title="${esc(clockDayHour(t))}">${hr % 3 === 0 || i === 0 ? esc(clockHour(t)) : ''}</th>`;
    }).join('');
    const cell = (r, when) => `<td class="r-${r}" title="${esc(`${when}: ${RATING_LABEL[r]}`)}"><span class="sr-only">${RATING_LABEL[r]}</span></td>`;
    const rows = d.stations.flatMap(s => [...s.freqs].reverse().map(f => {
      // cell() escapes its title, so the name goes in plain.
      const name = `${s.call} ${f.mhz} MHz`;
      const later = f.hours.map((r, i) => cell(r, `${name} · ${clockDayHour(hours[i])}`)).join('');
      return `<tr><th scope="row">${esc(s.call)} <span class="mono">${f.mhz}</span></th>${cell(f.now, `${name} now`)}<td class="gap"></td>${later}</tr>`;
    })).join('');
    $('#timeGrid').innerHTML = `<thead><tr><th></th><th scope="col">Now</th><th class="gap"></th>${head}</tr></thead><tbody>${rows}</tbody>`;
    $('#timeLegend').innerHTML = ['good', 'fair', 'poor', 'closed'].map(r => legendKey('', RATING_LABEL[r]).replace('<span class="sw" style="">', `<span class="sw r-${r}">`)).join('');
  }

  // How often the model agreed with real long-distance paths heard nearby, from
  // the app's own accuracy log. Shown once there's enough to say something.
  let accuracyAt = 0;
  async function loadAccuracy() {
    if (Date.now() - accuracyAt < 30 * 60000) return;
    accuracyAt = Date.now();
    let d;
    try { d = await api('api/accuracy'); } catch { return; }
    const w = d.week;
    const el = $('#propCheck');
    el.hidden = !(w.sampled >= 20);
    if (el.hidden) return;
    const prev = d.previous?.sampled >= 20 ? ` The model before 1.7.0 managed ${Math.round(d.previous.share * 100)}%.` : '';
    el.innerHTML = `<b>Model check</b>, last 7 days: of ${w.sampled.toLocaleString()} real paths over ${fmtDist(d.dxKm)} heard near you, the model rated ${Math.round(w.share * 100)}% fair or good at the time.${prev} <a href="api/accuracy.jsonl" download>Download the log</a> (no callsigns) if you’d like to help tune it.`;
  }

  function openProp() {
    loadAccuracy();
    if (!timesig.data || timesig.key !== station().grid) loadTimeSignals(); else renderTimeSignals();
    if (!beacons.data || beacons.key !== station().grid) loadBeacons(); else renderBeacons();
    if (!prop.query) {
      try {
        const q = JSON.parse(storeGet('hamdash.propTarget'));
        if (q && (q.target || q.tlat != null)) { if (q.target) $('#propInput').value = q.target; analyzePath(q); return; }
      } catch { /* nothing saved */ }
    }
    renderProp();
  }

  // ------------------------------------------------------------ reference (band plan, GMRS/FRS, MURS, CB)

  const REF = window.HamReference;
  const MODE_COLOR = { cw: '--series-1', phone: '--series-2', all: '--series-3', cwonly: '--series-1', channel: '--series-2' };
  const ref = { cls: storeGet('hamdash.licenseClass') || null, rendered: false, guessed: false };

  // The station's license class from its FCC/QRZ record, used until a class is picked.
  async function guessLicenseClass() {
    if (ref.cls || ref.guessed || station().type !== 'amateur' || !station().callsign) return;
    ref.guessed = true;
    try {
      const r = await api(`api/lookup?call=${encodeURIComponent(station().callsign)}`);
      const c = String(r.class || '').toUpperCase();
      const cls = { E: 'E', EXTRA: 'E', A: 'A', ADVANCED: 'A', G: 'G', GENERAL: 'G', T: 'T', TECHNICIAN: 'T', P: 'T' }[c];
      if (cls && !ref.cls) { ref.cls = cls; ref.fromLicense = true; renderRef(); }
    } catch { /* no record: General stays the default */ }
  }

  const mhzText = f => (f >= 100 ? f.toFixed(1) : f < 10 ? f.toFixed(4).replace(/0$/, '') : f.toFixed(3));

  function renderRef() {
    const cls = ref.cls || 'G';
    $('#refClassTabs').innerHTML = REF.LICENSE_CLASSES.map(([k, label]) =>
      `<button type="button" role="tab" data-cls="${k}" aria-selected="${k === cls}">${esc(label)}</button>`).join('');
    $('#refClassNote').textContent = ref.fromLicense && !storeGet('hamdash.licenseClass')
      ? `Showing ${REF.LICENSE_CLASSES.find(c => c[0] === cls)[1]} privileges, from the FCC record for ${station().callsign}. Pick another class above to compare.`
      : 'Pick a license class to see where it can transmit. Bars are to scale within each band.';
    $('#refBands').innerHTML = REF.US_BAND_PLAN.map(e => {
      const priv = REF.privileges(e, cls);
      const span = e.hi - e.lo || 1;
      const bar = e.channels
        ? e.channels.map(f => `<span class="bp-chan${priv.length ? '' : ' off'}" style="left:${((f - e.lo) / span) * 96 + 2}%;--c:var(${MODE_COLOR.channel})" title="${mhzText(f)} MHz"></span>`).join('')
        : priv.map(([lo, hi, mode]) => `<span class="bp-seg" style="left:${((lo - e.lo) / span) * 100}%;width:${((hi - lo) / span) * 100}%;--c:var(${MODE_COLOR[mode]})" title="${mhzText(lo)}–${mhzText(hi)} MHz: ${esc(REF.MODE_LABEL[mode])}"></span>`).join('');
      const text = !priv.length ? '<span class="meta">No privileges</span>'
        : e.channels ? `Channels ${e.channels.map(f => f.toFixed(4)).join(', ')} MHz`
          : priv.map(([lo, hi, mode]) => `<span class="nowrap"><span class="mono">${mhzText(lo)}–${mhzText(hi)}</span> ${esc(REF.MODE_LABEL[mode])}</span>`).join(' · ');
      const note = e.note?.[cls] || e.note?.all || '';
      return `<div class="bp-row${priv.length ? '' : ' none'}">
        <div class="bp-band mono">${e.band}</div>
        <div class="bp-main">
          <div class="bp-bar" role="img" aria-label="${esc(`${e.band}: ${priv.length ? priv.map(([lo, hi, mode]) => mode === 'channel' ? `${mhzText(lo)} MHz` : `${mhzText(lo)} to ${mhzText(hi)} MHz ${REF.MODE_LABEL[mode]}`).join(', ') : 'no privileges'}`)}">${bar}</div>
          <div class="bp-text">${text}${note ? `<div class="sub">${esc(note)}</div>` : ''}</div>
        </div>
      </div>`;
    }).join('');
    $('#refLegend').innerHTML = [['cw', 'CW, RTTY, data'], ['phone', 'Phone, image, CW'], ['all', 'All modes']]
      .map(([m, label]) => legendKey(`background:var(${MODE_COLOR[m]})`, label)).join('');

    $('#refGmrsTable').innerHTML = `<thead><tr><th class="num">Ch</th><th class="num">MHz</th><th>GMRS</th><th>FRS</th><th>Notes</th></tr></thead><tbody>${
      REF.GMRS_FRS.map(c => `<tr><td class="num mono">${c.n}</td><td class="num mono">${c.mhz.toFixed(4)}</td><td>${c.gmrs}</td><td>${c.frs}</td><td class="comment">${esc(c.note)}</td></tr>`).join('')
    }</tbody>`;
    $('#refMursTable').innerHTML = `<thead><tr><th class="num">Ch</th><th class="num">MHz</th><th>Notes</th></tr></thead><tbody>${
      REF.MURS.map(c => `<tr><td class="num mono">${c.n}</td><td class="num mono">${c.mhz.toFixed(3)}</td><td class="comment">${esc(c.note)}</td></tr>`).join('')
    }</tbody>`;
    // CB in two columns (1-20, 21-40) to keep the card short.
    const cbCell = c => c ? `<td class="num mono${c.note ? ' strong' : ''}"${c.note ? ` title="${esc(c.note)}"` : ''}>${c.n}</td><td class="num mono">${c.mhz.toFixed(3)}</td>` : '<td></td><td></td>';
    $('#refCbTable').innerHTML = `<thead><tr><th class="num">Ch</th><th class="num">MHz</th><th class="num">Ch</th><th class="num">MHz</th></tr></thead><tbody>${
      REF.CB.slice(0, 20).map((c, i) => `<tr>${cbCell(c)}${cbCell(REF.CB[i + 20])}</tr>`).join('')
    }</tbody>`;
    // GMRS stations see their channels first.
    const grid = $('#view-ref');
    if (station().type === 'gmrs' && grid.firstElementChild !== $('#refGmrs')) grid.prepend($('#refGmrs'));
    ref.rendered = true;
  }

  function openRef() {
    renderRef();
    guessLicenseClass();
  }

  function bindRef() {
    $('#refClassTabs').addEventListener('click', e => {
      const b = e.target.closest('[data-cls]');
      if (!b) return;
      ref.cls = b.dataset.cls;
      storeSet('hamdash.licenseClass', ref.cls);
      renderRef();
    });
  }

  // ------------------------------------------------------------ glossary

  // A jargon word as a button that explains itself when tapped.
  function term(key, label) {
    const g = window.HamReference.GLOSSARY[key];
    if (!g) return esc(label);
    return `<button type="button" class="term" data-term="${key}" aria-haspopup="dialog" aria-expanded="false">${esc(label ?? g[0])}</button>`;
  }

  const termPop = Object.assign(document.createElement('div'), { id: 'termPop', className: 'term-pop', hidden: true });
  termPop.setAttribute('role', 'dialog');
  let termOpenFor = null;

  function closeTerm() {
    if (termPop.hidden) return;
    termPop.hidden = true;
    termOpenFor?.setAttribute('aria-expanded', 'false');
    termOpenFor = null;
  }

  function openTerm(btn) {
    const key = btn.dataset.term;
    const [title, text] = window.HamReference.GLOSSARY[key] || [];
    if (!title) return;
    if (termOpenFor === btn) { closeTerm(); return; }
    closeTerm();
    termPop.innerHTML = `<div class="term-head"><b id="termTitle">${esc(title)}</b><button type="button" class="term-close" aria-label="Close">×</button></div>
      <p>${esc(text)}</p><button type="button" class="link-btn" data-glossary="${key}">All terms in the glossary</button>`;
    termPop.setAttribute('aria-labelledby', 'termTitle');
    termPop.hidden = false;
    // Below the term if it fits, else above; kept inside the window.
    const r = btn.getBoundingClientRect(), p = termPop.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left), innerWidth - p.width - 8);
    const top = r.bottom + 6 + p.height < innerHeight ? r.bottom + 6 : Math.max(8, r.top - p.height - 6);
    termPop.style.left = `${left + scrollX}px`;
    termPop.style.top = `${top + scrollY}px`;
    btn.setAttribute('aria-expanded', 'true');
    termOpenFor = btn;
  }

  function renderGlossary() {
    const entries = Object.entries(window.HamReference.GLOSSARY).sort((a, b) => a[1][0].localeCompare(b[1][0]));
    $('#refGlossaryList').innerHTML = entries.map(([key, [title, text]]) => `<div class="gl-item" id="gl-${key}"><dt>${esc(title)}</dt><dd>${esc(text)}</dd></div>`).join('');
  }

  function bindGlossary() {
    document.body.append(termPop);
    document.addEventListener('click', e => {
      const t = e.target.closest('.term[data-term]');
      if (t) { e.preventDefault(); e.stopPropagation(); openTerm(t); return; }
      if (e.target.closest('.term-close')) { closeTerm(); return; }
      const g = e.target.closest('[data-glossary]');
      if (g) {
        closeTerm();
        showView('ref');
        const item = document.getElementById(`gl-${g.dataset.glossary}`);
        const card = item?.closest('.card.collapsed');
        if (card) setCollapsed(card, false);
        item?.scrollIntoView({ block: 'center' });
        item?.classList.add('flash');
        setTimeout(() => item?.classList.remove('flash'), 1600);
        return;
      }
      if (!termPop.contains(e.target)) closeTerm();
    }, true);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !termPop.hidden) { const b = termOpenFor; closeTerm(); b?.focus(); } });
    window.addEventListener('resize', closeTerm);
  }

  // ------------------------------------------------------------ what's new and tips

  // Highlights per version, shown once after an update so new features get found.
  const WHATS_NEW = [
    ['1.7.0', ['Propagation ratings are tuned from your accuracy log: fewer missed openings, most of all on 10–17 m. The Model check on the Propagation tab compares old and new.']],
    ['1.6.3', ['“At your QTH now” no longer goes blank without a nearby ionosonde: it uses the propagation model and says so in the header.']],
    ['1.6.1', ['Everyone in your Home Assistant can open the dashboard; only admins can change setup and saved paths.']],
    ['1.6.0', ['Ready-made Home Assistant blueprints for band openings, DX spots, nearby POTA and lightning; the Documentation tab has import links.']],
    ['1.4.0', [
      'Collapse any card with the ▾ button at its top right; the dashboard remembers.',
      'Tap a dotted word (MUF, Kp, foF2…) for a plain-language explanation; the full glossary is on the Reference tab.',
      'Settings now show what this browser uses next to the app’s configuration.',
    ]],
    ['1.3.0', ['WWV and WWVH time signals on the Propagation tab: which frequencies are open toward Colorado and Hawaii.']],
    ['1.2.0', ['Restarts keep recent PSKReporter data, and the Propagation tab shows how often the model matched real paths.']],
    ['1.1.0', ['NCDXF beacons on the Propagation tab, a Reference tab with the band plan and GMRS/FRS/CB charts, and a UTC time option.']],
  ];
  const versionNum = v => String(v || '').split('.').map(n => parseInt(n, 10) || 0).reduce((a, n) => a * 1000 + n, 0);

  function showWhatsNew() {
    const current = state.defaults.version;
    if (!/^\d+\.\d+\.\d+$/.test(current || '')) return;
    const seen = storeGet('hamdash.seenVersion');
    // New users get the tour instead.
    if (!seen || !storeGet('hamdash.tourDone')) { storeSet('hamdash.seenVersion', current); return; }
    const items = WHATS_NEW.filter(([v]) => versionNum(v) > versionNum(seen) && versionNum(v) <= versionNum(current)).slice(0, 3);
    if (!items.length) { storeSet('hamdash.seenVersion', current); return; }
    $('#whatsNewTitle').textContent = `Updated to ${current}. What’s new:`;
    $('#whatsNewList').innerHTML = items.flatMap(([, list]) => list).map(t => `<li>${esc(t)}</li>`).join('');
    $('#whatsNew').hidden = false;
    $('#whatsNewClose').onclick = () => { $('#whatsNew').hidden = true; storeSet('hamdash.seenVersion', current); };
  }

  // A small tip shown once per browser, above el, until dismissed.
  function oneTimeTip(key, el, text) {
    if (!el || storeGet(`hamdash.tip.${key}`) || !storeGet('hamdash.tourDone')) return;
    const tipEl = document.createElement('div');
    tipEl.className = 'tip';
    tipEl.setAttribute('role', 'note');
    tipEl.innerHTML = `<span>💡 ${esc(text)}</span><button type="button" class="link-btn">Got it</button>`;
    tipEl.querySelector('button').addEventListener('click', () => { storeSet(`hamdash.tip.${key}`, '1'); tipEl.remove(); });
    el.before(tipEl);
  }

  function showTips() {
    oneTimeTip('spots', $('#spotsTable')?.closest('.table-wrap'), 'Tap any callsign to look it up, or the ↗ next to it to see how the path to that station is doing.');
    oneTimeTip('propmap', $('#propMap')?.closest('.map-wrap'), 'Click anywhere on this map to analyze the path to that point.');
  }

  // ------------------------------------------------------------ collapsible cards

  // Every titled card gets a collapse button. What's collapsed is remembered
  // per browser, keyed by the card's heading ID.
  const collapsed = new Set((() => { try { return JSON.parse(storeGet('hamdash.collapsed')) || []; } catch { return []; } })());

  function setCollapsed(card, on) {
    const key = card.getAttribute('aria-labelledby');
    card.classList.toggle('collapsed', on);
    const b = card.querySelector(':scope > .card-head > .collapse-btn');
    const title = document.getElementById(key)?.textContent.trim() || 'card';
    b?.setAttribute('aria-expanded', String(!on));
    b?.setAttribute('aria-label', `${on ? 'Expand' : 'Collapse'} ${title}`);
    if (b) b.title = on ? 'Expand' : 'Collapse';
    if (on) collapsed.add(key); else collapsed.delete(key);
    storeSet('hamdash.collapsed', collapsed.size ? JSON.stringify([...collapsed]) : null);
  }

  function setupCollapsibleCards() {
    for (const card of document.querySelectorAll('.card[aria-labelledby]')) {
      const head = card.querySelector(':scope > .card-head');
      if (!head) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'collapse-btn';
      b.innerHTML = '<span aria-hidden="true">▾</span>';
      head.append(b);
      b.addEventListener('click', () => {
        setCollapsed(card, !card.classList.contains('collapsed'));
        // Maps and charts can only size themselves while visible.
        if (!card.classList.contains('collapsed')) redrawVisible();
      });
      setCollapsed(card, collapsed.has(card.getAttribute('aria-labelledby')));
    }
  }

  function expandAllCards() {
    for (const card of document.querySelectorAll('.card.collapsed')) setCollapsed(card, false);
    redrawVisible();
  }

  const TAB_NAMES = [['weather', 'Space weather'], ['prop', 'Propagation'], ['repeaters', 'Repeaters'], ['aprs', 'APRS'], ['pota', 'POTA'], ['sats', 'Satellites'], ['lookup', 'Callsign lookup'], ['ref', 'Reference']];

  // Per-browser: hide tabs someone doesn't use (Space weather always stays).
  function applyTabVisibility() {
    const hidden = new Set(state.settings.hiddenTabs || []);
    for (const b of document.querySelectorAll('#viewTabs [data-view]')) b.hidden = hidden.has(b.dataset.view);
    if (hidden.has(currentView)) showView('weather');
  }

  // ------------------------------------------------------------ first-run setup

  const STATION_TYPES = {
    amateur: { label: 'Licensed amateur', text: 'I have an amateur (ham) radio callsign.' },
    gmrs: { label: 'GMRS', text: 'I have a GMRS license, or I’m on GMRS more than ham.' },
    listener: { label: 'Just listening', text: 'No license. I want propagation, weather, maps and activity.' },
  };
  const setup = { step: 0, data: null, busy: false, rerun: false };

  // rerun: opened from settings, so the first step offers Cancel instead of Skip.
  // fresh: blank answers, exactly what a brand-new install sees.
  function openSetup({ rerun = false, fresh = false } = {}) {
    const d = fresh ? {} : state.defaults;
    setup.step = 0;
    setup.rerun = rerun;
    setup.data = {
      station_type: d.station_type || 'amateur', callsign: d.callsign || '', grid: d.grid || '',
      distance_units: d.distance_units || 'mi',
      aprs_enabled: d.features?.aprs ?? true, dx_cluster_enabled: d.features?.dx_cluster ?? true,
      nws_alerts: d.features?.nws ?? true, ha_sensors: d.features?.ha_sensors ?? true,
    };
    $('#setup').hidden = false;
    document.body.classList.add('modal-open');
    renderSetup();
  }

  function closeSetup() {
    $('#setup').hidden = true;
    document.body.classList.remove('modal-open');
  }

  // Steps depend on the station type: listeners have no callsign step.
  const setupSteps = () => ['who', ...(setup.data.station_type === 'listener' ? [] : ['call']), 'where', 'features', 'review'];

  function setupError(msg) {
    const el = $('#setupError');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function renderSetup() {
    const steps = setupSteps();
    const step = steps[setup.step];
    const v = setup.data;
    setupError('');
    $('#setupProgress').innerHTML = steps.map((_, i) => `<span class="${i <= setup.step ? 'on' : ''}"></span>`).join('');
    const body = $('#setupBody');
    if (step === 'who') {
      body.innerHTML = `
        <h2 id="setupTitle">Welcome to the Ham Radio Dashboard</h2>
        <p class="lead">A few quick questions set the dashboard up for you. You can change any of this later on the app’s <b>Configuration</b> tab.</p>
        <p class="q">How will you use it?</p>
        <div class="choice-grid">${Object.entries(STATION_TYPES).map(([k, t]) => `
          <button type="button" class="choice${v.station_type === k ? ' on' : ''}" data-type="${k}" aria-pressed="${v.station_type === k}">
            <b>${esc(t.label)}</b><span>${esc(t.text)}</span>
          </button>`).join('')}
        </div>
        <p class="note">Everything here is receive-only information. Nothing transmits, so no license is needed to use it.</p>`;
    } else if (step === 'call') {
      const ham = v.station_type === 'amateur';
      body.innerHTML = `
        <h2 id="setupTitle">${ham ? 'Your callsign' : 'Your GMRS callsign'}</h2>
        <p class="lead">${ham
          ? 'Used to log in to the DX cluster for live spots, for APRS (receive-only), and to show who’s hearing your signals on PSKReporter.'
          : 'Optional. It’s only shown on your dashboard. GMRS callsigns aren’t used to log in to amateur networks, so APRS will use a receive-only listener ID instead.'}</p>
        <label class="field">Callsign${ham ? '' : ' (optional)'}
          <input id="setupCall" class="mono" value="${esc(v.callsign)}" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="15" placeholder="${ham ? 'e.g. KR4FCD' : 'e.g. WRAB123'}">
        </label>`;
      setTimeout(() => $('#setupCall')?.focus(), 50);
    } else if (step === 'where') {
      body.innerHTML = `
        <h2 id="setupTitle">Where are you?</h2>
        <p class="lead">Your Maidenhead grid square centers the maps and powers the local band estimate, nearby repeaters, APRS, storm alerts and satellite passes. A 6-character grid (like DM14xd) is accurate to about 3 miles.</p>
        <label class="field">Grid square
          <span class="input-row">
            <input id="setupGrid" class="mono" value="${esc(v.grid)}" autocomplete="off" spellcheck="false" maxlength="6" placeholder="e.g. DM14xd">
          </span>
        </label>
        <div class="setup-helpers">
          <button type="button" class="secondary" id="setupLocate">Use my location</button>
          ${v.station_type === 'amateur' && v.callsign ? `<button type="button" class="secondary" id="setupFromLicense">Find from my license (${esc(v.callsign)})</button>` : ''}
        </div>
        <p class="q">Distances in</p>
        <div class="seg">${[['mi', 'Miles'], ['km', 'Kilometers']].map(([k, l]) => `<button type="button" data-units="${k}" aria-pressed="${v.distance_units === k}">${l}</button>`).join('')}</div>`;
    } else if (step === 'features') {
      const ham = v.station_type === 'amateur';
      const row = (key, label, text, disabled) => `
        <label class="toggle${disabled ? ' disabled' : ''}">
          <input type="checkbox" data-feature="${key}"${v[key] && !disabled ? ' checked' : ''}${disabled ? ' disabled' : ''}>
          <span><b>${label}</b><span>${text}</span></span>
        </label>`;
      body.innerHTML = `
        <h2 id="setupTitle">What should it connect to?</h2>
        <p class="lead">All of these are receive-only. You can turn any of them on or off later.</p>
        ${row('aprs_enabled', 'Live APRS map', 'Stations, mobiles and weather stations heard near you, from APRS-IS.', false)}
        ${row('dx_cluster_enabled', 'DX cluster spots', ham ? 'Live DX spots from a ham-run cluster, logged in with your callsign.' : 'Needs a licensed amateur callsign, so it stays off.', !ham)}
        ${row('nws_alerts', 'Storm safety alerts', 'National Weather Service warnings and forecast for your location (US only).', false)}
        ${row('ha_sensors', 'Home Assistant sensors', 'Band conditions, space weather, storm status and more as entities for your automations.', false)}`;
    } else {
      const t = STATION_TYPES[v.station_type];
      const features = [v.aprs_enabled && 'Live APRS', v.station_type === 'amateur' && v.dx_cluster_enabled && 'DX cluster', v.nws_alerts && 'Storm alerts', v.ha_sensors && 'Home Assistant sensors'].filter(Boolean);
      body.innerHTML = `
        <h2 id="setupTitle">Ready to go</h2>
        <dl class="facts review">
          <dt>Station</dt><dd>${esc(t.label)}${v.callsign && v.station_type !== 'listener' ? ` · <span class="mono">${esc(v.callsign.toUpperCase())}</span>` : ''}</dd>
          <dt>Grid square</dt><dd class="mono">${esc(v.grid)}</dd>
          <dt>Distances</dt><dd>${v.distance_units === 'mi' ? 'Miles' : 'Kilometers'}</dd>
          <dt>Connects to</dt><dd>${esc(features.join(', ') || 'Nothing extra')}</dd>
        </dl>
        ${state.defaults.setup?.canSave
          ? '<p class="note">Saving updates the app’s Configuration tab and restarts the app, which takes about 10 seconds.</p>'
          : state.defaults.admin
            ? '<p class="note">This dashboard isn’t running inside Home Assistant, so these settings are saved in this browser only.</p>'
            : '<p class="note">These settings are saved in this browser only. Only a Home Assistant admin can change the app’s configuration.</p>'}`;
    }

    const last = step === 'review';
    $('#setupActions').innerHTML = `
      ${setup.step > 0 ? '<button type="button" class="secondary" id="setupBack">Back</button>'
        : setup.rerun ? '<button type="button" class="link-btn" id="setupCancel">Cancel</button>'
          : '<button type="button" class="link-btn" id="setupSkip">Skip setup</button>'}
      <span class="spacer"></span>
      <button type="button" id="setupNext"${setup.busy ? ' disabled' : ''}>${last ? (setup.busy ? 'Saving…' : 'Save and start') : 'Next'}</button>`;
  }

  // Validate and store the current step's inputs; false keeps the user there.
  function readSetupStep() {
    const step = setupSteps()[setup.step];
    const v = setup.data;
    if (step === 'call') {
      const call = $('#setupCall').value.trim().toUpperCase();
      if (v.station_type === 'amateur' && !/^[A-Z0-9/]{3,15}$/.test(call)) { setupError('Enter your amateur callsign, like KR4FCD.'); return false; }
      if (call && !/^[A-Z0-9/]{3,15}$/.test(call)) { setupError('That callsign has characters it shouldn’t.'); return false; }
      v.callsign = call;
    } else if (step === 'where') {
      const grid = $('#setupGrid').value.trim();
      if (!/^[A-R]{2}\d{2}([A-X]{2})?$/i.test(grid)) { setupError('Enter a 4 or 6 character grid square, like DM14 or DM14xd, or use one of the buttons.'); return false; }
      v.grid = grid.length === 6 ? grid.slice(0, 4).toUpperCase() + grid.slice(4).toLowerCase() : grid.toUpperCase();
    } else if (step === 'features') {
      for (const box of document.querySelectorAll('#setupBody [data-feature]')) if (!box.disabled) v[box.dataset.feature] = box.checked;
    }
    return true;
  }

  async function saveSetup() {
    const v = setup.data;
    if (!state.defaults.setup?.canSave) {
      // Outside Home Assistant: keep it in this browser.
      state.settings = { ...state.settings, callsign: v.station_type === 'listener' ? '' : v.callsign, grid: v.grid, units: v.distance_units };
      storeSet('hamdash.settings', JSON.stringify(state.settings));
      storeSet('hamdash.setupLocal', '1');
      closeSetup();
      stationChanged();
      startTour();
      return;
    }
    setup.busy = true;
    renderSetup();
    try {
      const r = await fetch('api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      // The browser's own overrides would hide the new defaults; clear them.
      state.settings = { hiddenTabs: state.settings.hiddenTabs };
      storeSet('hamdash.settings', JSON.stringify(state.settings));
      storeSet('hamdash.tourDone', null);
      $('#setupBody').innerHTML = '<h2 id="setupTitle">Saved</h2><p class="lead">Restarting the app with your settings… this page reloads by itself in a few seconds.</p><div class="spinner" aria-hidden="true"></div>';
      $('#setupActions').innerHTML = '';
      await waitForRestart();
      location.reload();
    } catch (e) {
      setup.busy = false;
      renderSetup();
      setupError(e.message);
    }
  }

  // Wait for the app to go down and come back after the restart.
  async function waitForRestart() {
    const start = Date.now();
    await new Promise(r => setTimeout(r, 3000));
    while (Date.now() - start < 90_000) {
      try {
        const r = await fetch('api/config', { cache: 'no-store' });
        if (r.ok && (await r.json()).setup?.done) return;
      } catch { /* still restarting */ }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  function bindSetup() {
    $('#setup').addEventListener('click', async e => {
      const t = e.target.closest('button');
      if (!t) return;
      const v = setup.data;
      if (t.dataset.type) {
        v.station_type = t.dataset.type;
        renderSetup();
      } else if (t.dataset.units) {
        v.distance_units = t.dataset.units;
        const grid = $('#setupGrid').value;
        renderSetup();
        $('#setupGrid').value = grid;
      } else if (t.id === 'setupSkip') {
        if (state.defaults.setup?.canSave) await fetch('api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"skip":true}' }).catch(() => {});
        else storeSet('hamdash.setupLocal', '1');
        closeSetup();
        if (!station().grid) openSettings();
        else if (!storeGet('hamdash.tourDone')) startTour();
      } else if (t.id === 'setupCancel') {
        closeSetup();
      } else if (t.id === 'setupBack') {
        setup.step = Math.max(0, setup.step - 1);
        renderSetup();
      } else if (t.id === 'setupNext') {
        if (!readSetupStep()) return;
        if (setupSteps()[setup.step] === 'review') return saveSetup();
        setup.step++;
        renderSetup();
      } else if (t.id === 'setupLocate') {
        const why = locationUnavailable();
        if (why) return setupError(why);
        t.disabled = true;
        navigator.geolocation.getCurrentPosition(
          p => { $('#setupGrid').value = latLonToGrid(p.coords.latitude, p.coords.longitude); setupError(''); t.disabled = false; },
          err => { setupError(locationError(err)); t.disabled = false; },
          { timeout: 10000 });
      } else if (t.id === 'setupFromLicense') {
        t.disabled = true;
        try {
          const r = await api(`api/lookup?call=${encodeURIComponent(v.callsign)}`);
          const grid = r.grid || (r.lat != null && r.lon != null ? latLonToGrid(r.lat, r.lon) : '');
          if (grid) { $('#setupGrid').value = grid.slice(0, 6); setupError(''); }
          else setupError('Your license record has no location. Use your location or enter your grid instead.');
        } catch { setupError('Couldn’t look up your license. Use your location or enter your grid instead.'); }
        t.disabled = false;
      }
    });
    $('#setup').addEventListener('keydown', e => {
      if (e.key === 'Escape' && setup.rerun && !setup.busy) closeSetup();
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); $('#setupNext')?.click(); }
    });
  }

  // ------------------------------------------------------------ guided tour

  // [view, element to highlight, title, text]. Steps on hidden tabs are skipped.
  const TOUR_STEPS = [
    ['weather', '#viewTabs', 'Eight views', 'Space weather, propagation paths, repeaters, APRS, POTA, satellite passes, callsign lookup and a reference tab. Hide the ones you don’t use in settings (⚙ at the top right).'],
    ['weather', '#tiles', 'Conditions right now', 'Solar flux, sunspots, the K-index and more. Tap any dotted word for a plain-language explanation, and use the ▾ at a card’s top right to collapse cards you don’t need.'],
    ['weather', '#bandsTable', 'Which bands are open', '“At your QTH” is an estimate from the nearest ionosonde, or from the propagation model when none nearby is reporting. “Heard nearby” is measured: stations actually decoded near you in the last 15 minutes.'],
    ['weather', '#stormStatus', 'Storm safety', 'Safe, Caution or Danger for your station, from National Weather Service alerts and an optional lightning sensor. Danger also shows a red banner on every tab.'],
    ['weather', '#panel-grayline', 'Maps', 'Click a map, then scroll to zoom, or pinch on a phone. The layers button switches between Dark, Streets, Satellite and Topo. The golden band is the gray line, where low-band DX is often best.'],
    ['prop', '#propForm', 'Propagation to anywhere', 'Enter a callsign, grid or prefix, or click the map, to see how each band should work to it now and over the next 24 hours, with PSKReporter showing what’s actually getting through. Save paths you care about to get Home Assistant sensors for them.'],
    ['prop', '#beaconCard', 'Beacons', 'Eighteen NCDXF beacons take turns on 20 to 10 m. This shows which one is on the air on each band right now and how your path to it rates, so a quick listen tells you if a band is open.'],
    ['repeaters', '#rptMap', 'Repeaters near you', 'Click a dot to find it in the list, with frequency, offset and tone. Confirm details before you transmit, since listings can be out of date.'],
    ['aprs', '#aprsMap', 'Live APRS', 'Stations heard around you right now: mobiles show as arrows with their tracks, plus digipeaters, iGates and weather stations. This is receive-only.'],
    ['sats', '#passTable', 'Satellite passes', 'Upcoming passes over you. Pick one to see its sky track and Doppler-corrected frequencies.'],
    ['lookup', '#lookupForm', 'Callsign lookup', 'Look up any station. Callsigns anywhere on the dashboard are clickable and open here, with distance and beam heading from you.'],
    ['ref', '#refBandPlan', 'Reference', 'Where your license class can transmit on every band, plus GMRS, FRS, MURS and CB channel charts.'],
    [null, '#stationBtn', 'Your settings', 'Change the callsign and grid for this browser, show times in UTC, hide tabs, run setup again, or replay this tour.'],
  ];
  const tour = { steps: [], i: 0, target: null };

  function startTour() {
    const hidden = new Set(state.settings.hiddenTabs || []);
    tour.steps = TOUR_STEPS.filter(([view]) => !view || !hidden.has(view));
    tour.i = 0;
    $('#tour').hidden = false;
    showTourStep();
  }

  function endTour() {
    $('#tour').hidden = true;
    tour.target = null;
    storeSet('hamdash.tourDone', '1');
  }

  function showTourStep() {
    const [view, selector, title, text] = tour.steps[tour.i];
    if (view && view !== currentView) showView(view);
    if (view === 'weather' && selector === '#panel-grayline') document.querySelector('#mapTabs [data-map="grayline"]')?.click();
    // A step can't point at something inside a collapsed card.
    const holder = document.querySelector(selector)?.closest('.card.collapsed');
    if (holder) { setCollapsed(holder, false); redrawVisible(); }
    const pop = $('#tourPop');
    const last = tour.i === tour.steps.length - 1;
    pop.innerHTML = `
      <div class="tour-count">${tour.i + 1} of ${tour.steps.length}</div>
      <h3 id="tourTitle">${esc(title)}</h3>
      <p>${esc(text)}</p>
      <div class="tour-actions">
        <button type="button" class="link-btn" data-tour="skip">${last ? 'Close' : 'Skip tour'}</button>
        <span class="spacer"></span>
        ${tour.i > 0 ? '<button type="button" class="secondary" data-tour="back">Back</button>' : ''}
        <button type="button" data-tour="next">${last ? 'Done' : 'Next'}</button>
      </div>`;
    // Let the view render before measuring where the element is.
    setTimeout(() => {
      // Highlight the whole card when it fits on screen, otherwise just the element.
      const raw = document.querySelector(selector);
      const el = raw?.closest('.table-wrap') || raw;
      const card = el?.closest('.card, #viewTabs, #stationBtn');
      tour.target = card && card.getBoundingClientRect().height < innerHeight * 0.7 ? card : el;
      // Tall targets go to the top of the screen so the popup can sit below them.
      const tall = tour.target && tour.target.getBoundingClientRect().height + (pop.offsetHeight || 190) + 40 > innerHeight;
      tour.target?.scrollIntoView({ block: tall ? 'start' : 'center', behavior: 'instant' });
      positionTour();
      pop.focus();
    }, 250);
  }

  function positionTour() {
    if ($('#tour').hidden || !tour.target) return;
    const r = tour.target.getBoundingClientRect();
    const pad = 6;
    const box = { l: r.left - pad, t: Math.max(4, r.top - pad), w: r.width + pad * 2, h: r.height + pad * 2 };
    const pop = $('#tourPop');
    const pw = Math.min(360, innerWidth - 24), ph = pop.offsetHeight || 180;
    // Popup below the box if there's room, else above; if neither fits, pin it
    // to the bottom and trim the highlight to the space above it.
    let top;
    if (box.t + box.h + 14 + ph <= innerHeight - 12) top = box.t + box.h + 14;
    else if (box.t - 14 - ph >= 12) top = box.t - ph - 14;
    else { top = innerHeight - ph - 12; box.h = Math.max(40, Math.min(box.h, top - 14 - box.t)); }
    Object.assign($('#tourSpot').style, { left: `${box.l}px`, top: `${box.t}px`, width: `${box.w}px`, height: `${box.h}px` });
    // Four panels dim everything around the highlighted box.
    const px = v => `${Math.max(0, v)}px`;
    const rects = {
      top: [0, 0, innerWidth, box.t],
      bottom: [0, box.t + box.h, innerWidth, innerHeight - box.t - box.h],
      left: [0, box.t, box.l, box.h],
      right: [box.l + box.w, box.t, innerWidth - box.l - box.w, box.h],
    };
    for (const d of document.querySelectorAll('.tour-dim')) {
      const [l, t, w, h] = rects[d.dataset.side];
      Object.assign(d.style, { left: px(l), top: px(t), width: px(w), height: px(h) });
    }
    const left = Math.min(Math.max(12, box.l + box.w / 2 - pw / 2), innerWidth - pw - 12);
    Object.assign(pop.style, { left: `${left}px`, top: `${top}px`, width: `${pw}px` });
  }

  function bindTour() {
    $('#tourPop').addEventListener('click', e => {
      const a = e.target.closest('[data-tour]')?.dataset.tour;
      if (a === 'skip' || (a === 'next' && tour.i === tour.steps.length - 1)) return endTour();
      if (a === 'next') { tour.i++; showTourStep(); }
      if (a === 'back') { tour.i = Math.max(0, tour.i - 1); showTourStep(); }
    });
    document.addEventListener('keydown', e => {
      if ($('#tour').hidden) return;
      if (e.key === 'Escape') endTour();
      else if (e.key === 'ArrowRight') $('#tourPop [data-tour="next"]')?.click();
      else if (e.key === 'ArrowLeft') $('#tourPop [data-tour="back"]')?.click();
    });
    window.addEventListener('resize', positionTour);
    window.addEventListener('scroll', positionTour, { passive: true });
  }

  // First visit: setup if the app has never been set up, otherwise a one-time
  // tour for each new browser.
  function startOnboarding() {
    const s = state.defaults.setup || {};
    const localDone = storeGet('hamdash.setupLocal') === '1';
    if (s.needed && !localDone) return openSetup();
    if (new URLSearchParams(location.search).has('tour') || !storeGet('hamdash.tourDone')) startTour();
  }

  // ------------------------------------------------------------ settings dialog

  // Which of this browser's settings differ from the app's configuration.
  function overrides() {
    const s = state.settings, d = state.defaults;
    const out = [];
    if (s.callsign && s.callsign.toUpperCase() !== String(d.callsign || '').toUpperCase()) out.push('callsign');
    if (s.grid && s.grid.toUpperCase() !== String(d.grid || '').toUpperCase()) out.push('grid');
    return out;
  }

  function renderCompare() {
    const s = state.settings, d = state.defaults, st = station();
    const unitName = u => (u === 'km' ? 'Kilometers' : 'Miles');
    const row = (label, mine, app) => `<tr${mine !== app ? ' class="differs"' : ''}><th scope="row">${label}</th><td class="mono">${esc(mine || '—')}</td><td class="mono">${esc(app || '—')}</td></tr>`;
    $('#setCompare').innerHTML = `<table class="mini-table compare">
        <thead><tr><th></th><th>This browser</th><th>App configuration</th></tr></thead>
        <tbody>${row('Callsign', st.callsign, String(d.callsign || '').toUpperCase())}${row('Grid', st.grid, d.grid)}${row('Units', unitName(st.units), unitName(d.distance_units))}</tbody>
      </table>
      <p class="note">Home Assistant sensors, alerts, saved paths and the model check always use the <b>app configuration</b>. ${d.admin ? 'To change it, use <b>Run setup again</b> below, or the app’s Configuration tab in Home Assistant.' : 'Only a Home Assistant admin can change it.'}${overrides().length ? ' This browser is overriding it, marked with a dot by your callsign at the top.' : ''}</p>`;
  }

  function openSettings() {
    renderCompare();
    const s = state.settings, d = state.defaults;
    $('#setCall').value = s.callsign || '';
    $('#setCall').placeholder = d.callsign ? `App setting: ${d.callsign}` : 'e.g. KR4FCD';
    $('#setGrid').value = s.grid || '';
    $('#setGrid').placeholder = d.grid ? `App setting: ${d.grid}` : 'e.g. DM14xd';
    $('#setUnits').value = s.units || '';
    $('#setTime').value = s.time || '';
    const hidden = new Set(s.hiddenTabs || []);
    $('#setTabs').innerHTML = TAB_NAMES.filter(([v]) => v !== 'weather')
      .map(([v, label]) => `<label class="check"><input type="checkbox" value="${v}"${hidden.has(v) ? '' : ' checked'}> ${label}</label>`).join('');
    $('#rerunSetup').hidden = !d.setup?.canSave;
    $('#startOver').hidden = !d.setup?.canSave;
    $('#settingsError').hidden = true;
    $('#settings').showModal();
    if ($('#statusBox').open) loadStatus();
  }

  // ------------------------------------------------------------ data freshness on cards

  // Each card lists the sources it depends on (data-sources). Its badge stays
  // hidden unless one of them is failing, rate limited or reconnecting.
  function sourceProblem(name, src, conn) {
    if (conn) {
      return conn.status === 'reconnecting' || (conn.status === 'connecting' && conn.error)
        ? { short: `${name} reconnecting`, long: `${name}: ${conn.error || 'connection lost'}. Retrying.` } : null;
    }
    if (!src || src.state === 'ok' || src.state === 'unused') return null;
    const what = src.limited ? 'rate limited' : 'not responding';
    const why = src.limited ? 'is asking the app to slow down' : 'isn’t responding';
    return src.state === 'stale'
      ? { short: `${name} ${what} · last update ${ago(src.ok)}`, long: `${name} ${why} (${src.error}). Showing its last data, from ${ago(src.ok)}. Retrying.` }
      : { short: `${name} ${what}`, long: `${name} ${why} (${src.error}). Retrying.` };
  }

  async function loadFreshness() {
    let s;
    try { s = await api('api/status'); } catch { return; }
    const byName = Object.fromEntries(s.sources.map(x => [x.name, x]));
    const live = { 'DX cluster': s.live.cluster, 'APRS-IS': s.live.aprs };
    for (const el of document.querySelectorAll('.stale[data-sources]')) {
      const problems = el.dataset.sources.split(',').map(n => sourceProblem(n, byName[n], live[n])).filter(Boolean);
      el.hidden = !problems.length;
      el.textContent = problems.length === 1 ? problems[0].short : problems.length ? `${problems.length} sources have problems` : '';
      el.title = problems.map(p => p.long).join(String.fromCharCode(10));
    }
  }

  // ------------------------------------------------------------ data source status

  let lastStatus = null;
  const STATUS_PILL = { ok: ['good', 'OK'], stale: ['fair', 'Using last data'], error: ['poor', 'Failing'], unused: ['none', 'Not used yet'] };
  const LIVE_PILL = {
    connected: ['good', 'Connected'], connecting: ['fair', 'Connecting'], reconnecting: ['fair', 'Reconnecting'],
    disabled: ['none', 'Off'], 'no-callsign': ['none', 'No callsign'], 'no-grid': ['none', 'No grid'], 'no-license': ['none', 'Amateur only'],
  };

  function statusRows(s) {
    const src = s.sources.map(x => {
      const [cls, label] = x.limited && x.state !== 'ok' ? ['fair', 'Rate limited'] : STATUS_PILL[x.state];
      const sub = [x.ok && `Updated ${ago(x.ok)}`, x.state !== 'ok' && x.error && `${x.error} (${ago(x.errorAt)})`].filter(Boolean).join(' · ');
      return { name: x.name, cls, label, sub };
    });
    const { cluster, aprs, ha, apparmor } = s.live;
    const live = [
      { name: 'DX cluster', ...pillOf(LIVE_PILL[cluster.status]), sub: [cluster.host, cluster.status === 'connected' && `${cluster.spots} spots`, cluster.error].filter(Boolean).join(' · ') },
      { name: 'APRS-IS', ...pillOf(LIVE_PILL[aprs.status]), sub: [aprs.server, aprs.status === 'connected' && `${aprs.stations} stations, ${aprs.packets} packets`, aprs.error].filter(Boolean).join(' · ') },
      {
        name: 'Home Assistant',
        ...pillOf(!ha.enabled ? ['none', 'Off'] : ha.error ? ['poor', 'Problem'] : ['good', ha.mode === 'mqtt' ? 'MQTT' : 'REST']),
        sub: [ha.enabled && `${ha.entities ?? 0} entities`, ha.lastPublish && `published ${ago(ha.lastPublish)}`, ha.error].filter(Boolean).join(' · '),
      },
    ];
    // enforce = confined and blocking; complain = confined but only logging.
    const mode = /\((enforce|complain|kill|unconfined)\)/.exec(apparmor || '')?.[1];
    live.push({
      name: 'AppArmor',
      ...pillOf(!apparmor ? ['none', 'Not available'] : mode === 'enforce' ? ['good', 'Enforced'] : mode === 'complain' ? ['fair', 'Logging only'] : ['poor', 'Not confined']),
      sub: apparmor || 'Only inside Home Assistant',
    });
    return [...src, ...live];
  }
  function pillOf(p) { const [cls, label] = p || ['none', '—']; return { cls, label }; }

  async function loadStatus() {
    $('#statusTable').innerHTML = '<tbody><tr><td class="empty">Loading…</td></tr></tbody>';
    try {
      lastStatus = await api('api/status');
      $('#statusTable').innerHTML = `<tbody>${statusRows(lastStatus).map(r =>
        `<tr><td>${esc(r.name)}</td><td>${pill(r.cls, r.label)}${r.sub ? `<div class="sub">${esc(r.sub)}</div>` : ''}</td></tr>`).join('')}</tbody>`;
    } catch (e) {
      $('#statusTable').innerHTML = `<tbody><tr><td class="empty">Couldn’t load status: ${esc(e.message)}</td></tr></tbody>`;
    }
  }

  // Plain text for a GitHub issue. No callsign, and only a 4-character grid,
  // since issues are public.
  function statusText(s) {
    const nl = String.fromCharCode(10);
    return [
      `Ham Radio Dashboard ${s.version} · ${s.station_type} · grid ${(s.grid || 'not set').slice(0, 4)}`,
      `Running since ${s.started} · checked ${s.now}`,
      `Browser: ${navigator.userAgent}`,
      '',
      ...statusRows(s).map(r => `${r.name}: ${r.label}${r.sub ? ` (${r.sub})` : ''}`),
    ].join(nl);
  }

  async function copyStatus() {
    if (!lastStatus) await loadStatus();
    if (!lastStatus) return;
    const text = statusText(lastStatus);
    const box = $('#statusText');
    try {
      // Some frames never answer a clipboard request, so don't wait forever.
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
      ]);
      $('#copyStatusMsg').textContent = 'Copied. Paste it into your GitHub issue.';
      box.hidden = true;
    } catch {
      // Clipboard access can be blocked inside the Home Assistant frame.
      box.value = text;
      box.hidden = false;
      box.select();
      $('#copyStatusMsg').textContent = 'Select the text below and copy it.';
    }
  }

  function bindSettings() {
    $('#stationBtn').addEventListener('click', openSettings);
    $('#statusBox').addEventListener('toggle', () => { if ($('#statusBox').open) loadStatus(); });
    $('#copyStatus').addEventListener('click', copyStatus);
    $('#startTour').addEventListener('click', () => { $('#settings').close(); startTour(); });
    $('#rerunSetup').addEventListener('click', () => { $('#settings').close(); openSetup({ rerun: true }); });
    $('#startOver').addEventListener('click', () => {
      const msg = [
        'Start over as a new user?',
        '',
        'This clears this browser’s dashboard settings (tour, hidden tabs, map layers, callsign and grid overrides) and opens setup with blank answers. Your Home Assistant settings only change if you save at the end.',
      ].join(String.fromCharCode(10));
      if (!confirm(msg)) return;
      for (const k of Object.keys(localStorage)) if (k.startsWith('hamdash.')) storeSet(k, null);
      state.settings = {};
      $('#settings').close();
      applyTabVisibility();
      stationChanged();
      openSetup({ fresh: true });
    });
    $('#cancelSettings').addEventListener('click', () => $('#settings').close());
    $('#resetSettings').addEventListener('click', () => {
      state.settings = { hiddenTabs: state.settings.hiddenTabs };
      storeSet('hamdash.settings', null);
      $('#settings').close();
      stationChanged();
    });
    $('#locateBtn').addEventListener('click', () => {
      const err = $('#settingsError');
      const why = locationUnavailable();
      if (why) { err.textContent = why; err.hidden = false; return; }
      navigator.geolocation.getCurrentPosition(
        p => { $('#setGrid').value = latLonToGrid(p.coords.latitude, p.coords.longitude); err.hidden = true; },
        e => { err.textContent = locationError(e); err.hidden = false; },
        { timeout: 10000 });
    });
    $('#settingsForm').addEventListener('submit', e => {
      const call = $('#setCall').value.trim().toUpperCase();
      const grid = $('#setGrid').value.trim();
      const err = $('#settingsError');
      if (call && !/^[A-Z0-9/]{3,15}$/.test(call)) { e.preventDefault(); err.textContent = 'That callsign doesn’t look right.'; err.hidden = false; return; }
      if (grid && !/^[A-R]{2}\d{2}([A-X]{2})?$/i.test(grid)) { e.preventDefault(); err.textContent = 'Grid must be 4 or 6 characters, like DM14 or DM14xd.'; err.hidden = false; return; }
      const g = grid.length === 6 ? grid.slice(0, 4).toUpperCase() + grid.slice(4).toLowerCase() : grid.toUpperCase();
      const hiddenTabs = [...document.querySelectorAll('#setTabs input')].filter(i => !i.checked).map(i => i.value);
      state.settings = { callsign: call, grid: g, units: $('#setUnits').value, time: $('#setTime').value, hiddenTabs };
      storeSet('hamdash.settings', JSON.stringify(state.settings));
      applyTabVisibility();
      stationChanged();
    });
  }

  function stationChanged() {
    renderHeader();
    renderBands();
    drawGrayline();
    state.psk = null;
    renderPsk();
    loadPsk();
    fillRadiusOptions();
    fillPotaRanges();
    state.activity = null;
    state.vhf = null;
    renderVhf();
    loadActivity();
    loadLocal();
    renderStorm();
    rpt.key = '';
    rpt.pos = null;
    if (currentView === 'repeaters') loadRepeaters();
    if (currentView === 'pota') renderPota();
    if (currentView === 'sats') loadSats();
    if (look.result) renderLookup();
    if (prop.data) renderProp();
    if (timesig.data) renderTimeSignals();
  }

  // ------------------------------------------------------------ loaders

  async function loadSolar() {
    try {
      state.solar = await api('api/solar');
      renderTiles(); renderScales(); renderBands(); renderVhfStrip(); renderKp(); renderAlerts();
    } catch (e) { console.warn(e); }
  }
  async function loadActivity() {
    const pos = gridToLatLon(station().grid);
    if (!pos) return;
    const q = `lat=${pos.lat.toFixed(4)}&lon=${pos.lon.toFixed(4)}`;
    // Both come from the same cached PSKReporter query on the server.
    if (!state.vhf) renderVhf();
    // Failures are kept so the cards can say why they're empty. Data from an
    // earlier load stays on screen.
    await Promise.all([
      api(`api/activity?${q}`).then(a => { state.activity = a; state.activityError = null; }, e => { state.activityError = e.message; }).then(renderBands),
      api(`api/vhf?${q}`).then(v => { state.vhf = v; state.vhfError = null; }, e => { state.vhfError = e.message; }).then(renderVhf),
    ]);
  }
  async function loadIono() {
    try { state.iono = await api('api/ionosondes'); renderBands(); drawGrayline(); } catch (e) { console.warn(e); }
    await loadLocal();
  }
  async function loadLocal() {
    const pos = gridToLatLon(station().grid);
    if (!pos) return;
    try {
      const local = await api(`api/local?lat=${pos.lat.toFixed(4)}&lon=${pos.lon.toFixed(4)}`);
      state.local = { ...local, key: posKey(pos) };
      renderBands();
    } catch (e) { console.warn(e); }
  }
  async function loadSpots() {
    try { state.spots = await api('api/spots'); renderSpots(); } catch (e) { console.warn(e); }
  }
  async function loadPsk() {
    const call = station().callsign;
    if (!call || station().type !== 'amateur') { renderPsk(); return; }
    try {
      state.psk = await api(`api/psk?call=${encodeURIComponent(call)}&minutes=${$('#pskWindow').value}`);
      renderPsk(); drawGrayline();
    } catch (e) { renderPsk(e.message); }
  }
  async function loadCycle() {
    try { state.cycle = await api('api/cycle'); renderCycle(); } catch (e) { console.warn(e); renderCycle(); }
  }
  // The world outline (55 KB) is only needed by the Plain layer, so it's
  // fetched the first time a map shows that layer.
  let landRequest = null;
  function ensureLand() {
    landRequest ||= api('land-110m.json')
      .then(topo => { state.land = decodeLand(topo); for (const m of Object.values(maps)) m.plain.refill(); })
      .catch(e => { console.warn(e); landRequest = null; });
    return landRequest;
  }

  // ------------------------------------------------------------ boot

  async function init() {
    tickClocks();
    setInterval(tickClocks, 1000);
    bindSettings();
    bindProp();
    bindRef();
    bindGlossary();
    renderGlossary();
    setupCollapsibleCards();
    $('#expandAll').addEventListener('click', () => { expandAllCards(); $('#settings').close(); });
    bindSetup();
    bindTour();
    bindMapTabs();
    bindCanvasHover($('#skyPlot'));

    $('#potaBandChips').addEventListener('click', e => {
      const b = e.target.closest('[data-band]');
      if (!b) return;
      pota.band = b.dataset.band;
      storeSet('hamdash.potaBand', pota.band || null);
      renderPota();
    });
    for (const id of ['potaMode', 'potaSort']) {
      const sel = $(`#${id}`);
      sel.value = storeGet(`hamdash.${id}`) || sel.options[0].value;
      sel.addEventListener('change', () => { storeSet(`hamdash.${id}`, sel.value); renderPota(); });
    }
    $('#potaRange').addEventListener('change', () => { storeSet(`hamdash.potaRange.${station().units}`, $('#potaRange').value); renderPota(); });
    $('#potaSearch').addEventListener('input', renderPota);

    $('#satTypeChips').addEventListener('click', e => {
      const b = e.target.closest('[data-type]');
      if (!b) return;
      sats.type = b.dataset.type;
      storeSet('hamdash.satType', sats.type || null);
      renderSats();
    });
    const satMinEl = $('#satMinEl');
    satMinEl.value = storeGet('hamdash.satMinEl') || '10';
    satMinEl.addEventListener('change', () => { storeSet('hamdash.satMinEl', satMinEl.value); renderSats(); });
    const pickPass = e => {
      const row = e.target.closest('tr[data-pass]');
      if (!row || (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      sats.selected = row.dataset.pass;
      renderSats();
    };
    $('#passTable').addEventListener('click', pickPass);
    $('#passTable').addEventListener('keydown', pickPass);

    $('#aprsCatChips').addEventListener('click', e => {
      const b = e.target.closest('[data-cat]');
      if (!b) return;
      aprs.cat = b.dataset.cat;
      storeSet('hamdash.aprsCat', aprs.cat || null);
      renderAprs();
    });
    const aprsSince = $('#aprsSince');
    aprsSince.value = storeGet('hamdash.aprsSince') || '60';
    aprsSince.addEventListener('change', () => { storeSet('hamdash.aprsSince', aprsSince.value); renderAprs(); });
    $('#aprsSearch').addEventListener('input', renderAprs);
    for (const id of ['aprsTracks', 'aprsLabels']) {
      const box = $(`#${id}`);
      box.checked = storeGet(`hamdash.${id}`) !== 'false';
      box.addEventListener('change', () => { storeSet(`hamdash.${id}`, String(box.checked)); drawAprsMap(); });
    }
    $('#aprsTable').addEventListener('mouseover', e => {
      const key = e.target.closest('tr[data-key]')?.dataset.key;
      if (key && key !== aprs.highlight) { aprs.highlight = key; drawAprsMap(); }
    });
    $('#aprsTable').addEventListener('mouseleave', () => { aprs.highlight = null; drawAprsMap(); });

    $('#viewTabs').addEventListener('click', e => {
      const b = e.target.closest('[data-view]');
      if (b) showView(b.dataset.view);
    });
    window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
    // Any element with data-call (callsigns in tables, recent chips) opens a lookup.
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-call]');
      if (b) lookup(b.dataset.call);
    });
    $('#lookupForm').addEventListener('submit', e => { e.preventDefault(); lookup($('#lookupInput').value); });

    $('#rptBandChips').addEventListener('click', e => {
      const b = e.target.closest('[data-band]');
      if (!b) return;
      rpt.band = b.dataset.band;
      storeSet('hamdash.rptBand', rpt.band || null);
      renderRepeaters();
    });
    $('#rptRadius').addEventListener('change', () => { storeSet(`hamdash.rptRadius.${station().units}`, $('#rptRadius').value); loadRepeaters(); });
    const rptMode = $('#rptMode'), rptOnAir = $('#rptOnAir');
    rptMode.value = storeGet('hamdash.rptMode') || '';
    rptOnAir.checked = storeGet('hamdash.rptOnAir') !== 'false';
    rptMode.addEventListener('change', () => { storeSet('hamdash.rptMode', rptMode.value || null); renderRepeaters(); });
    rptOnAir.addEventListener('change', () => { storeSet('hamdash.rptOnAir', String(rptOnAir.checked)); renderRepeaters(); });
    $('#rptSearch').addEventListener('input', renderRepeaters);
    $('#rptTable').addEventListener('mouseover', e => {
      const id = e.target.closest('tr[data-id]')?.dataset.id;
      if (id && +id !== rpt.highlight) { rpt.highlight = +id; drawRepeaterMap(); }
    });
    $('#rptTable').addEventListener('mouseleave', () => { rpt.highlight = null; drawRepeaterMap(); });

    $('#bandChips').addEventListener('click', e => {
      const b = e.target.closest('[data-band]');
      if (!b) return;
      state.bandFilter = b.dataset.band;
      storeSet('hamdash.band', state.bandFilter || null);
      renderSpots();
    });
    for (const id of ['modeFilter', 'contFilter']) {
      const sel = $(`#${id}`);
      sel.value = storeGet(`hamdash.${id}`) || '';
      sel.addEventListener('change', () => { storeSet(`hamdash.${id}`, sel.value || null); renderSpots(); });
    }
    const win = $('#pskWindow');
    win.value = storeGet('hamdash.pskWindow') || '60';
    win.addEventListener('change', () => { storeSet('hamdash.pskWindow', win.value); state.psk = null; renderPsk(); loadPsk(); });

    try {
      const cfg = await api('api/config');
      state.defaults = {
        callsign: cfg.callsign || '', grid: cfg.grid || '', distance_units: cfg.distance_units || 'mi',
        qrz: Boolean(cfg.qrz), spot_watch: cfg.spot_watch || [],
        station_type: cfg.station_type || 'amateur', features: cfg.features || {},
        version: cfg.version || '',
        // Only Home Assistant admins change the app's configuration and saved
        // paths; everyone else's setup is saved in their own browser.
        admin: cfg.viewer?.admin !== false,
        setup: { ...cfg.setup, canSave: Boolean(cfg.setup?.canSave && cfg.viewer?.admin !== false) },
      };
    } catch (e) { console.warn(e); }
    renderHeader();
    renderPsk();
    fillRadiusOptions();
    fillPotaRanges();
    applyTabVisibility();
    showView(location.hash.slice(1) || storeGet('hamdash.view') || 'weather');
    startOnboarding();
    showWhatsNew();
    showTips();

    loadSolar(); loadIono(); loadSpots(); loadPsk(); loadCycle(); loadActivity(); loadStorm(); loadSavedPaths();
    setInterval(loadSolar, 5 * 60000);
    setInterval(loadIono, 10 * 60000);
    setInterval(loadSpots, 30000);
    setInterval(loadPsk, 5 * 60000);
    setInterval(loadCycle, 12 * 3600000);
    setInterval(loadActivity, 5 * 60000);
    setInterval(loadStorm, 60000);
    setTimeout(loadFreshness, 15000);
    setInterval(loadFreshness, 2 * 60000);
    setInterval(() => { if (currentView === 'weather' && !$('#panel-grayline').hidden) drawGrayline(); renderBands(); }, 60000);

    // Redraw canvases and charts only when the width changes, not on every
    // content-height change.
    let rt, lastWidth = innerWidth;
    window.addEventListener('resize', () => {
      if (innerWidth === lastWidth) return;
      lastWidth = innerWidth;
      clearTimeout(rt);
      rt = setTimeout(redrawVisible, 150);
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      redrawVisible(); renderScales(); renderTiles();
    });
  }

  init();
})();
