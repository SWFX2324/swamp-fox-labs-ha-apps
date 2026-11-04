'use strict';
// Shared math for the Ham Radio Dashboard: grid squares, distances, the sun,
// and the local band-condition estimate. Loaded by the page (window.HamCore)
// and by the server (require), so Home Assistant sensors and the dashboard
// always agree.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HamCore = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const RAD = Math.PI / 180;

  function gridToLatLon(grid) {
    const m = String(grid || '').trim().toUpperCase().match(/^([A-R])([A-R])(\d)(\d)([A-X])?([A-X])?/);
    if (!m) return null;
    let lon = (m[1].charCodeAt(0) - 65) * 20 - 180 + +m[3] * 2;
    let lat = (m[2].charCodeAt(0) - 65) * 10 - 90 + +m[4];
    if (m[5] && m[6]) {
      lon += (m[5].charCodeAt(0) - 65) / 12 + 1 / 24;
      lat += (m[6].charCodeAt(0) - 65) / 24 + 1 / 48;
    } else { lon += 1; lat += 0.5; }
    return { lat, lon };
  }

  function latLonToGrid(lat, lon) {
    const L = lon + 180, A = lat + 90;
    const c = n => String.fromCharCode(65 + n);
    return c(Math.floor(L / 20)) + c(Math.floor(A / 10)) +
      Math.floor((L % 20) / 2) + Math.floor(A % 10) +
      c(Math.floor((L % 2) * 12)).toLowerCase() + c(Math.floor((A % 1) * 24)).toLowerCase();
  }

  function distanceKm(a, b) {
    const dLat = (b.lat - a.lat) * RAD, dLon = (b.lon - a.lon) * RAD;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bearingDeg(a, b) {
    const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD);
    const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }

  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const compass = deg => COMPASS[Math.round(deg / 22.5) % 16];

  // Subsolar point (low-precision almanac, good to ~0.1°).
  function sunPosition(date) {
    const d = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
    const g = (357.529 + 0.98560028 * d) * RAD;
    const q = 280.459 + 0.98564736 * d;
    const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
    const e = (23.439 - 0.00000036 * d) * RAD;
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / RAD;
    const dec = Math.asin(Math.sin(e) * Math.sin(L)) / RAD;
    const gmst = (280.46061837 + 360.98564736629 * d) % 360;
    return { lat: dec, lon: ((ra - gmst + 540) % 360) - 180 };
  }

  function sunAltitude(sun, lat, lon) {
    const s = Math.sin(lat * RAD) * Math.sin(sun.lat * RAD) +
      Math.cos(lat * RAD) * Math.cos(sun.lat * RAD) * Math.cos((lon - sun.lon) * RAD);
    return Math.asin(Math.max(-1, Math.min(1, s))) / RAD;
  }

  // Scan the local day for horizon crossings (sunrise/set and civil twilight).
  function sunTimes(pos, day = new Date()) {
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const out = {};
    let prev = null;
    for (let m = 0; m <= 1440; m++) {
      const t = new Date(start.getTime() + m * 60000);
      const alt = sunAltitude(sunPosition(t), pos.lat, pos.lon);
      if (prev !== null) {
        if (prev < -0.833 && alt >= -0.833) out.sunrise = t;
        if (prev >= -0.833 && alt < -0.833) out.sunset = t;
        if (prev < -6 && alt >= -6) out.dawn = t;
        if (prev >= -6 && alt < -6) out.dusk = t;
      }
      prev = alt;
    }
    return out;
  }

  // ---------------------------------------------------------------- bands

  // HF only: 160 m to 10 m. [band, representative MHz, HamQSL group (none for 160 m)]
  const HF_BANDS = [
    ['160m', 1.9, null], ['80m', 3.6, '80m-40m'], ['60m', 5.36, '80m-40m'], ['40m', 7.1, '80m-40m'],
    ['30m', 10.12, '30m-20m'], ['20m', 14.1, '30m-20m'], ['17m', 18.1, '17m-15m'],
    ['15m', 21.2, '17m-15m'], ['12m', 24.94, '12m-10m'], ['10m', 28.4, '12m-10m'],
  ];
  const RATING = ['closed', 'poor', 'fair', 'good'];

  function nearestIonosonde(pos, stations) {
    if (!pos || !stations?.length) return null;
    let best = null;
    for (const s of stations) {
      const d = distanceKm(pos, s);
      if (!best || d < best.dist) best = { ...s, dist: d };
    }
    return best && best.dist <= 3000 ? best : null;
  }

  // Score (3 good … 0 closed) from frequency / MUF. The MUF is the median
  // (basic) MUF, and real signals get through above it: ITU-R P.1240's
  // operational MUF runs 10–35% higher, and the app's own accuracy log found
  // paths decoded near the QTH at about 15% above the model's MUF. So a band is
  // good up to the MUF, fair to 10% above it and poor to 20% above.
  const mufScore = r => (r <= 1 ? 3 : r <= 1.1 ? 2 : r <= 1.2 ? 1 : 0);

  // Heuristic DX rating for one band at the QTH: compares the band to the
  // nearest ionosonde's MUF(3000), then applies daytime D-layer absorption on
  // the low bands and a geomagnetic penalty.
  function rateBand(mhz, muf, sunAlt, kp) {
    if (!muf) return null;
    let score = mufScore(mhz / muf);
    if (score > 0 && sunAlt > 10) {
      if (mhz < 4) score = Math.min(score, 1);
      else if (mhz < 6) score = Math.min(score, 2);
      else if (mhz < 8 && sunAlt > 40) score = Math.min(score, 2);
    }
    if (score > 0 && kp >= 7) score = Math.max(1, score - 2);
    else if (score > 0 && kp >= 5) score = Math.max(1, score - 1);
    return RATING[score];
  }

  return {
    RAD, gridToLatLon, latLonToGrid, distanceKm, bearingDeg, compass,
    sunPosition, sunAltitude, sunTimes, HF_BANDS, RATING, nearestIonosonde, mufScore, rateBand,
  };
});
