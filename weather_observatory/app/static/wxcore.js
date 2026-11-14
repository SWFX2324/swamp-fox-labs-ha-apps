'use strict';
// Shared weather helpers for Weather Observatory. Loaded by the page
// (window.WxCore) and by the server (require), so both read values the same
// way. The rule throughout: a missing reading stays missing. Nothing here
// turns "not supplied" into 0.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WxCore = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  // A finite number, or null for anything that isn't a real reading
  // (null, '', booleans, 'unavailable', NaN, Infinity). 0 and '0' are readings.
  function number(value) {
    if (value === null || value === undefined || typeof value === 'boolean') return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ESC[c]);

  function format(value, digits = 0) {
    const n = number(value);
    if (n === null) return '—';
    return n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
  }

  // RainViewer frame paths are opaque IDs (older ones were numeric). Anything
  // else could point a tile URL somewhere unexpected.
  const validRadarFrame = frame => number(frame?.time) !== null && typeof frame?.path === 'string' && /^\/v2\/radar\/[A-Za-z0-9_-]{1,128}$/.test(frame.path);

  // Public services only ever see the home location rounded to 0.1° (about
  // 11 km), never the exact coordinates from Home Assistant.
  function regionalPoint(latitude, longitude) {
    const lat = number(latitude), lon = number(longitude);
    if (lat === null || lon === null || Math.abs(lat) > 85 || Math.abs(lon) > 180) return null;
    return { lat: Math.round(lat * 10) / 10, lon: Math.round(lon * 10) / 10 };
  }

  const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  function compass(value) {
    const n = number(value);
    return n === null ? '—' : POINTS[Math.round(((n % 360 + 360) % 360) / 22.5) % 16];
  }

  function age(value, now = Date.now()) {
    const t = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(t)) return 'time unavailable';
    const m = Math.floor((now - t) / 60000);
    if (m < -2) return 'future timestamp';
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    if (m < 1440) return `${Math.floor(m / 60)} hr ${m % 60} min ago`;
    return `${Math.floor(m / 1440)} days ago`;
  }

  // US AQI bands. The colour is a CSS variable name so the page can pick a
  // shade that reads in light and dark themes.
  function aqiCategory(value) {
    const n = number(value);
    if (n === null || n < 0) return { label: 'Unavailable', key: 'none' };
    if (n <= 50) return { label: 'Good', key: 'good' };
    if (n <= 100) return { label: 'Moderate', key: 'moderate' };
    if (n <= 150) return { label: 'Unhealthy for sensitive groups', key: 'usg' };
    if (n <= 200) return { label: 'Unhealthy', key: 'unhealthy' };
    if (n <= 300) return { label: 'Very unhealthy', key: 'very' };
    return { label: 'Hazardous', key: 'hazardous' };
  }

  function uvCategory(value) {
    const n = number(value);
    if (n === null) return 'Not provided';
    return n < 3 ? 'Low' : n < 6 ? 'Moderate' : n < 8 ? 'High' : n < 11 ? 'Very high' : 'Extreme';
  }

  // Recorder states, in Home Assistant's compact ({lu, a}) or full
  // ({last_updated, attributes}) shape, to sorted {time, value} points.
  function historyPoints(states, attribute) {
    return (states || []).map(s => {
      const compact = number(s.lu ?? s.lc);
      return {
        time: compact !== null ? compact * 1000 : Date.parse(s.last_updated),
        value: number((s.a ?? s.attributes)?.[attribute]),
      };
    }).filter(p => Number.isFinite(p.time) && p.value !== null).sort((a, b) => a.time - b.time);
  }

  // Change over about three hours. Needs a recent reading and a baseline
  // within 90 minutes of three hours earlier; otherwise there's no trend.
  function pressureTrend(points, now = Date.now(), unit = 'inHg') {
    if (!points?.length) return null;
    const latest = points.at(-1), target = latest.time - 3 * 3600000;
    const baseline = points.filter(p => p.time <= target).at(-1);
    if (!baseline || target - baseline.time > 90 * 60000 || now - latest.time > 3 * 3600000) return null;
    const delta = latest.value - baseline.value;
    const threshold = unit === 'inHg' ? 0.015 : unit === 'mmHg' ? 0.4 : 0.5;
    return { delta, label: delta > threshold ? 'Rising' : delta < -threshold ? 'Falling' : 'Steady', hours: (latest.time - baseline.time) / 3600000 };
  }

  function chartPaths(points, width = 920, height = 190, pad = 26, nonnegative = false, padLeft = pad) {
    const p = points.filter(x => Number.isFinite(x.time) && number(x.value) !== null);
    if (p.length < 2) return null;
    const xmin = p[0].time, xmax = p.at(-1).time;
    if (xmin === xmax) return null;
    let min = Math.min(...p.map(x => x.value)), max = Math.max(...p.map(x => x.value));
    const margin = Math.max((max - min) * 0.16, nonnegative && max === 0 ? 0.1 : 1);
    min = nonnegative ? Math.max(0, min - margin) : min - margin;
    max += margin;
    const coords = p.map(q => ({ ...q, x: padLeft + (q.time - xmin) / (xmax - xmin) * (width - padLeft - pad), y: height - pad - (q.value - min) / (max - min) * (height - pad * 2) }));
    return {
      line: coords.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(2)},${q.y.toFixed(2)}`).join(' '),
      area: `M${coords[0].x.toFixed(2)},${height - pad} ` + coords.map(q => `L${q.x.toFixed(2)},${q.y.toFixed(2)}`).join(' ') + ` L${coords.at(-1).x.toFixed(2)},${height - pad} Z`,
      coords, min, max,
    };
  }

  // Index of the point nearest a time, so a selected hour stays the same hour
  // when the chart switches between metrics with different missing values.
  function nearestIndex(points, time) {
    if (!points.length || !Number.isFinite(time)) return 0;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i].time - time) < Math.abs(points[best].time - time)) best = i;
    return best;
  }

  // ---- unit conversion (NWS observations are metric) -------------------------
  const fromC = (value, unit) => { const n = number(value); return n === null ? null : unit === '°F' ? n * 9 / 5 + 32 : unit === 'K' ? n + 273.15 : n; };
  const fromKmh = (value, unit) => {
    const n = number(value);
    if (n === null) return null;
    return unit === 'mph' ? n / 1.609344 : unit === 'm/s' ? n / 3.6 : unit === 'kn' ? n / 1.852 : unit === 'ft/s' ? n / 1.09728 : n;
  };
  const fromPa = (value, unit) => {
    const n = number(value);
    if (n === null) return null;
    return unit === 'inHg' ? n / 3386.389 : unit === 'mmHg' ? n / 133.322 : unit === 'kPa' ? n / 1000 : unit === 'Pa' ? n : n / 100; // hPa / mbar
  };
  // Imperial when the weather entity reports Fahrenheit, otherwise metric.
  const imperial = units => units?.temp === '°F';
  const fromKm = (km, units) => { const n = number(km); return n === null ? null : imperial(units) ? n / 1.609344 : n; };
  const distanceUnit = units => imperial(units) ? 'mi' : 'km';

  function distanceKm(a, b) {
    const r = x => x * Math.PI / 180;
    const x = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }

  const CONDITIONS = {
    'clear-night': 'Clear night', cloudy: 'Cloudy', exceptional: 'Exceptional', fog: 'Fog', hail: 'Hail',
    lightning: 'Lightning', 'lightning-rainy': 'Thunderstorms', partlycloudy: 'Partly cloudy', pouring: 'Pouring rain',
    rainy: 'Rain', snowy: 'Snow', 'snowy-rainy': 'Rain and snow', sunny: 'Sunny', windy: 'Windy', 'windy-variant': 'Windy and cloudy',
  };
  const conditionText = s => CONDITIONS[s] || (s ? String(s).replaceAll('-', ' ').replace(/^./, c => c.toUpperCase()) : 'Unavailable');

  // Only https links to weather.gov leave the page from alert text.
  function safeLink(url, fallback = 'https://www.weather.gov/') {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && /(^|\.)weather\.gov$/.test(u.hostname) ? u.href : fallback;
    } catch { return fallback; }
  }

  // NWS severity to a banner tone.
  const alertTone = severity => ({ Extreme: 'critical', Severe: 'critical', Moderate: 'warn', Minor: 'info' }[severity] || 'info');

  // What the alert banner may claim. A retained result is stale after a
  // failed check or 20 minutes, and a stale "no alerts" must never read as a
  // fresh all-clear.
  function alertStatus(src, now = Date.now()) {
    if (!src || src.disabled) return { kind: 'off' };
    if (!Array.isArray(src.data)) return { kind: src.loading || (!src.error && !src.fetchedAt) ? 'checking' : 'unavailable', tone: 'stale' };
    const stale = Boolean(src.error) || !Number.isFinite(src.fetchedAt) || now - src.fetchedAt > 20 * 60000;
    if (!src.data.length) return { kind: stale ? 'last-clear' : 'clear', tone: stale ? 'stale' : 'clear', stale };
    return { kind: 'active', tone: alertTone(src.data[0].severity), stale, count: src.data.length };
  }

  return {
    number, escapeHTML, format, validRadarFrame, regionalPoint, compass, age, aqiCategory, uvCategory,
    historyPoints, pressureTrend, chartPaths, nearestIndex, fromC, fromKmh, fromPa, fromKm, distanceUnit,
    imperial, distanceKm, conditionText, safeLink, alertTone, alertStatus,
  };
});
