'use strict';
// Point-to-point HF propagation estimate. A simplified model in the spirit of
// ITU-R P.533, not a VOACAP replacement:
//
// - The great-circle path (short or long) is split into F2 hops of at most
//   4000 km. Each hop reflects at its midpoint (a control point).
// - foF2 at each control point comes from a small model driven by the sunspot
//   number and the sun's height there, then anchored to live ionosonde
//   readings (KC2G): the model is scaled by the measured/model ratio of the
//   nearest station, or the global median ratio when none is close. The anchor
//   fades over the next hours of the outlook.
// - Hop MUF = foF2 x M-factor for that hop length (secant law, scaled to the
//   measured M(3000) where available). The path MUF is the lowest hop MUF.
// - D-layer absorption follows George and Bradley: the sun's zenith angle where
//   each hop passes the D layer, the sunspot number and the frequency.
// - Paths through the auroral zone lose out when Kp is high.
//
// Ratings use the same scale as the band table: good, fair, poor, closed.

const HamCore = require('./static/hamcore');

const { RAD } = HamCore;
const R_EARTH = 6371;
const CIRCUMFERENCE = 2 * Math.PI * R_EARTH;
const MAX_HOP_KM = 4000;
const F2_HEIGHT = 300;
const D_HEIGHT = 90;
const RATING = HamCore.RATING; // ['closed', 'poor', 'fair', 'good']
const MAG_POLE = { lat: 80.7, lon: -72.7 };
const HOUR = 3600_000;

// Sunspot number from the 10.7 cm flux (inverse of SFI = 63.7 + 0.728R + 0.00089R²).
function ssnFromSfi(sfi) {
  if (!(sfi > 0)) return null;
  const a = 0.00089, b = 0.728, c = 63.7 - sfi;
  return Math.max(0, (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a));
}

// ---------------------------------------------------------------- geometry

function destination(p, bearing, km) {
  const d = km / R_EARTH, b = bearing * RAD, la = p.lat * RAD, lo = p.lon * RAD;
  const lat = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lon = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(lat));
  return { lat: lat / RAD, lon: ((lon / RAD + 540) % 360) - 180 };
}

// Short path: the great circle the short way. Long path: the same circle the
// other way round, starting in the opposite direction.
function pathGeometry(a, b, long = false) {
  const short = HamCore.distanceKm(a, b);
  const bearing = HamCore.bearingDeg(a, b);
  const km = long ? CIRCUMFERENCE - short : short;
  const heading = long ? (bearing + 180) % 360 : bearing;
  const hops = Math.max(1, Math.ceil(km / MAX_HOP_KM));
  const hopKm = km / hops;
  const at = s => destination(a, heading, s);
  return { km, bearing: heading, hops, hopKm, at };
}

// Secant of the incidence angle where a ray leaving the ground at elev
// degrees crosses height h.
function secAt(elev, h) {
  const sinI = (R_EARTH * Math.cos(elev * RAD)) / (R_EARTH + h);
  return 1 / Math.sqrt(1 - Math.min(sinI * sinI, 0.995));
}

// Elevation angle for one F2 hop of ground length hopKm (curved Earth, mirror
// reflection at h), and the secant at that height.
function hopAngles(hopKm, h) {
  const theta = hopKm / (2 * R_EARTH);
  const elev = Math.atan((Math.cos(theta) - R_EARTH / (R_EARTH + h)) / Math.sin(theta)) / RAD;
  return { elev, sec: secAt(Math.max(elev, 0), h) };
}

// M-factor for a hop, scaled so a 3000 km hop matches the measured M(3000).
function mFactor(hopKm, m3000 = 3.2) {
  return (m3000 * hopAngles(Math.max(hopKm, 50), F2_HEIGHT).sec) / hopAngles(3000, F2_HEIGHT).sec;
}

function geomagLat(p) {
  const s = Math.sin(p.lat * RAD) * Math.sin(MAG_POLE.lat * RAD) +
    Math.cos(p.lat * RAD) * Math.cos(MAG_POLE.lat * RAD) * Math.cos((p.lon - MAG_POLE.lon) * RAD);
  return Math.asin(Math.max(-1, Math.min(1, s))) / RAD;
}

// ---------------------------------------------------------------- ionosphere

const sunAltAt = (p, t) => HamCore.sunAltitude(HamCore.sunPosition(new Date(t)), p.lat, p.lon);

// foF2 (MHz). Noon values flatten out at high sunspot numbers (about 11 MHz at
// SSN 100, 14 at 200). The F2 layer lags the sun by about an hour and is lit
// from below the horizon, so the sun's height is taken an hour earlier and
// raised by 10°. High geomagnetic latitudes run lower.
//
// At low sunspot numbers the formula ran about 25% below live ionosondes
// (late 2026, SSN 33–48, day and night alike), so it's lifted there. From SSN
// 100 up it's unchanged until there's data to check it against.
const lowSsnLift = s => 1 + 0.25 * Math.min(1, Math.max(0, (100 - s) / 50));

function modelFoF2(p, t, ssn) {
  const s = Math.min(Math.max(ssn, 0), 250);
  const day = 5 + 0.07 * s - 0.00012 * s * s;
  const sunNow = sunAltAt(p, t - HOUR);
  // At night foF2 keeps falling until dawn, by about 20% once the sun is far down.
  const night = (2.4 + 0.024 * s) * (1 - 0.2 * Math.min(1, Math.max(0, (-sunNow - 18) / 40)));
  const alt = sunNow + 10;
  const x = Math.max(0, Math.sin(Math.min(alt, 90) * RAD));
  let fo = (night + (day - night) * Math.pow(x, 0.6)) * lowSsnLift(s);
  const ml = Math.abs(geomagLat(p));
  if (ml > 60) fo *= 0.8;
  else if (ml > 50) fo *= 0.9;
  return fo;
}

// Live anchor: measured/model foF2 ratio per fresh ionosonde, and the median.
function calibration(stations, t, ssn) {
  const fresh = (stations || []).filter(s => s.fof2 > 0 && Number.isFinite(s.lat) && Number.isFinite(s.lon));
  const points = fresh.map(s => ({
    lat: s.lat, lon: s.lon, name: s.name,
    ratio: Math.min(2, Math.max(0.5, s.fof2 / modelFoF2(s, t, ssn))),
    md: Number(s.md) > 1 ? Number(s.md) : null,
  }));
  const sorted = points.map(p => p.ratio).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 1;
  return { t, points, median };
}

// Ratio and M(3000) to use at a control point: the nearest station within
// 1500 km blended with the global median by distance.
function anchorAt(cal, p) {
  let best = null;
  for (const s of cal.points) {
    const d = HamCore.distanceKm(p, s);
    if (d <= 1500 && (!best || d < best.d)) best = { ...s, d };
  }
  if (!best) return { ratio: cal.median, md: null, station: null };
  const w = 1 - best.d / 1500;
  return { ratio: w * best.ratio + (1 - w) * cal.median, md: best.md, station: best.name, km: Math.round(best.d) };
}

// MUF(3000) at a point, anchored the same way as a path: by the nearest fresh
// ionosonde within 1500 km, or else the global median ratio. The band table
// falls back to this when no ionosonde nearby has reported recently.
function localMuf(p, { now = Date.now(), ssn = 100, stations = [] } = {}) {
  const cal = calibration(stations, now, ssn);
  const a = anchorAt(cal, p);
  const fof2 = modelFoF2(p, now, ssn) * a.ratio;
  return { muf: +(fof2 * mFactor(3000, a.md || 3.2)).toFixed(1), fof2: +fof2.toFixed(1), anchors: cal.points.length };
}

// George-Bradley absorption index for one pass through the D layer.
function absorptionIndex(p, t, ssn) {
  const chi = 90 - sunAltAt(p, t);
  if (chi >= 102) return 0.02;
  const c = Math.cos(Math.min(chi, 100) * 0.881 * RAD);
  return (1 + 0.0037 * ssn) * Math.pow(Math.max(c, 0), 1.3) + 0.02;
}

// ---------------------------------------------------------------- path at one time

const scoreOfLoss = dB => (dB < 30 ? 3 : dB < 55 ? 2 : dB < 85 ? 1 : 0);

// Where the path MUF is set, following ITU-R P.533: the midpoint up to
// 2000 km; points 1000 km from each end up to 4000 km; each hop's midpoint up
// to 7000 km; beyond that, 4000 km hops at points 2000 km from each end (the
// ionosphere near the ends decides long-haul paths).
function controlPoints(geo) {
  const { km } = geo;
  if (km <= 2000) return [{ s: km / 2, hopKm: km }];
  if (km <= 4000) return [{ s: 1000, hopKm: km }, { s: km - 1000, hopKm: km }];
  if (km <= 7000) return Array.from({ length: geo.hops }, (_, i) => ({ s: (i + 0.5) * geo.hopKm, hopKm: geo.hopKm }));
  return [{ s: 2000, hopKm: MAX_HOP_KM }, { s: km - 2000, hopKm: MAX_HOP_KM }];
}

// opts: { bands: [[name, MHz]], ssn, kp, cal, anchorWeight (1 now, fading later) }
function evaluate(geo, t, opts) {
  const { ssn, kp = 0, cal, anchorWeight = 1 } = opts;
  const reflections = [];
  for (const { s, hopKm } of controlPoints(geo)) {
    const p = geo.at(s);
    const a = cal ? anchorAt(cal, p) : { ratio: 1, md: null, station: null };
    const ratio = 1 + (a.ratio - 1) * anchorWeight;
    const fo = modelFoF2(p, t, ssn) * ratio;
    const muf = fo * mFactor(hopKm, a.md || 3.2);
    reflections.push({ lat: p.lat, lon: p.lon, fof2: fo, muf, station: a.station, stationKm: a.km ?? null, sunAlt: sunAltAt(p, t) });
  }
  const muf = Math.min(...reflections.map(r => r.muf));

  // Each hop goes through the D layer twice, a little way from its ends.
  const dKm = Math.min(geo.hopKm / 2, 250);
  let absorb = 0;
  for (let i = 0; i < geo.hops; i++) {
    absorb += absorptionIndex(geo.at(i * geo.hopKm + dKm), t, ssn);
    absorb += absorptionIndex(geo.at((i + 1) * geo.hopKm - dKm), t, ssn);
  }
  // The F2 ray's angle where it crosses the D layer, at least 3° above the
  // horizon (real antennas and terrain don't launch lower).
  const secD = secAt(Math.max(hopAngles(geo.hopKm, F2_HEIGHT).elev, 3), D_HEIGHT);

  // Auroral zone: its equatorward edge moves south as Kp rises.
  const edge = 67 - 2 * kp;
  let auroral = false;
  for (let s = 0; s <= geo.km; s += 400) if (Math.abs(geomagLat(geo.at(s))) >= edge) { auroral = true; break; }
  const penalty = kp >= 4 && auroral ? (kp >= 6 ? 2 : 1) : kp >= 7 ? 1 : 0;

  const bands = {};
  for (const [name, mhz] of opts.bands) {
    const loss = (677.2 * secD * absorb) / (Math.pow(mhz + 1.2, 1.98) + 10.2);
    const mufScore = HamCore.mufScore(mhz / muf);
    const lossScore = scoreOfLoss(loss);
    const score = Math.max(0, Math.min(mufScore, lossScore) - (Math.min(mufScore, lossScore) > 0 ? penalty : 0));
    bands[name] = {
      rating: RATING[score], loss: Math.round(loss),
      limit: score === 3 ? null : mufScore <= lossScore ? 'muf' : 'absorption',
    };
    if (penalty && score < Math.min(mufScore, lossScore)) bands[name].limit = 'aurora';
  }
  return { t: new Date(t).toISOString(), muf: +muf.toFixed(1), fot: +(muf * 0.85).toFixed(1), reflections, auroral, bands };
}

// ---------------------------------------------------------------- full analysis

// Ratings for now and each of the next 24 hours, for the short and long path.
function analyzePath(from, to, { now = Date.now(), ssn = 100, kp = 0, stations = [], bands = HamCore.HF_BANDS } = {}) {
  const cal = calibration(stations, now, ssn);
  const bandList = bands.map(([name, mhz]) => [name, mhz]);
  const one = long => {
    const geo = pathGeometry(from, to, long);
    const current = evaluate(geo, now, { bands: bandList, ssn, kp, cal });
    const start = Math.ceil(now / HOUR) * HOUR;
    const hours = [];
    for (let h = 0; h < 24; h++) {
      const t = start + h * HOUR;
      // The live anchor fades over about six hours, and Kp is held as now.
      hours.push(evaluate(geo, t, { bands: bandList, ssn, kp, cal, anchorWeight: Math.exp(-(t - now) / (6 * HOUR)) }));
    }
    return {
      km: Math.round(geo.km), bearing: +geo.bearing.toFixed(1), hops: geo.hops, hopKm: Math.round(geo.hopKm),
      elevation: +hopAngles(geo.hopKm, F2_HEIGHT).elev.toFixed(1),
      now: current, hours,
    };
  };
  return {
    from, to, ssn: Math.round(ssn), kp,
    stations: cal.points.length, medianRatio: +cal.median.toFixed(2),
    short: one(false), long: one(true),
  };
}

// The best band right now (highest frequency rated good, then fair) and, for
// each band, the next hour in the outlook when it's good or fair.
function summarize(path, bands = HamCore.HF_BANDS) {
  const names = bands.map(b => b[0]);
  const pick = cur => {
    for (const want of ['good', 'fair']) {
      const b = [...names].reverse().find(n => cur.bands[n]?.rating === want);
      if (b) return { band: b, rating: want };
    }
    return null;
  };
  const best = pick(path.now);
  const next = {};
  for (const n of names) {
    const h = path.hours.find(x => x.bands[n] && ['good', 'fair'].includes(x.bands[n].rating));
    next[n] = h ? h.t : null;
  }
  // Windows: runs of consecutive hours where each band is good.
  const windows = {};
  for (const n of names) {
    const runs = [];
    let run = null;
    for (const h of path.hours) {
      if (h.bands[n]?.rating === 'good') {
        if (!run) runs.push(run = { start: h.t, end: h.t });
        else run.end = h.t;
      } else run = null;
    }
    windows[n] = runs;
  }
  return { best, next, windows };
}

// ---------------------------------------------------------------- saved-path openings

// One callback per band per path when its rating turns good, at most once per
// cooldown. A band seen for the first time (after a start, or a newly saved
// path) only records its rating, so nothing fires for what's already open.
class PathTracker {
  constructor(onOpen, cooldownMs = 2 * HOUR) {
    this.onOpen = onOpen;
    this.cooldownMs = cooldownMs;
    this.state = new Map();
  }

  update(id, ratings, now = Date.now()) {
    for (const [band, rating] of Object.entries(ratings)) {
      const key = `${id}|${band}`;
      const st = this.state.get(key) || { rating: null, lastEvent: -Infinity };
      if (rating === 'good' && st.rating && st.rating !== 'good' && now - st.lastEvent >= this.cooldownMs) {
        st.lastEvent = now;
        this.onOpen?.(id, band);
      }
      st.rating = rating;
      this.state.set(key, st);
    }
  }
}

// ---------------------------------------------------------------- measured (PSKReporter)

// Reports between stations near each end, in either direction. reports:
// [{ rx, rxGrid, tx, txGrid, freq (Hz), snr, time (s) }]
function measured(reports, from, to, { nearKm = 1000, farNearKm = 1000 } = {}) {
  const byBand = {};
  for (const r of reports) {
    const khz = r.freq / 1000;
    const band = HF_EDGES.find(([, lo, hi]) => khz >= lo && khz <= hi)?.[0];
    if (!band) continue;
    const rx = HamCore.gridToLatLon(r.rxGrid), tx = HamCore.gridToLatLon(r.txGrid);
    if (!rx || !tx) continue;
    const toYou = HamCore.distanceKm(rx, from) <= nearKm && HamCore.distanceKm(tx, to) <= farNearKm;
    const fromYou = HamCore.distanceKm(tx, from) <= nearKm && HamCore.distanceKm(rx, to) <= farNearKm;
    if (!toYou && !fromYou) continue;
    const b = byBand[band] || (byBand[band] = { toYou: new Set(), fromYou: new Set(), bestSnr: null, last: 0, examples: [] });
    const key = `${r.tx}>${r.rx}`;
    const set = toYou ? b.toYou : b.fromYou;
    if (!set.has(key) && b.examples.length < 5) b.examples.push({ tx: r.tx, txGrid: r.txGrid, rx: r.rx, rxGrid: r.rxGrid, snr: r.snr ?? null, mode: r.mode || '' });
    set.add(key);
    if (r.snr != null && (b.bestSnr == null || r.snr > b.bestSnr)) b.bestSnr = r.snr;
    if (r.time > b.last) b.last = r.time;
  }
  const out = {};
  for (const [band, b] of Object.entries(byBand)) {
    out[band] = {
      toYou: b.toYou.size, fromYou: b.fromYou.size, bestSnr: b.bestSnr,
      last: b.last ? new Date(b.last * 1000).toISOString() : null, examples: b.examples,
    };
  }
  return out;
}

const HF_EDGES = [
  ['160m', 1800, 2000], ['80m', 3500, 4000], ['60m', 5330, 5410], ['40m', 7000, 7300], ['30m', 10100, 10150],
  ['20m', 14000, 14350], ['17m', 18068, 18168], ['15m', 21000, 21450], ['12m', 24890, 24990], ['10m', 28000, 29700],
];

module.exports = {
  ssnFromSfi, destination, pathGeometry, hopAngles, mFactor, geomagLat,
  PathTracker, secAt, controlPoints, modelFoF2, calibration, anchorAt, localMuf, absorptionIndex, evaluate, analyzePath, summarize, measured,
};
