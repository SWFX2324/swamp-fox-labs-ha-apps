'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../app/prop');
const H = require('../app/static/hamcore');

const near = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b} ±${tol}, got ${a}`);
const QTH = H.gridToLatLon('DM14xd');
const BANDS = [['80m', 3.6], ['40m', 7.1], ['20m', 14.1], ['10m', 28.4]];

test('sunspot number from solar flux', () => {
  near(P.ssnFromSfi(63.7), 0, 0.01);
  near(P.ssnFromSfi(150), 105, 2);
  assert.equal(P.ssnFromSfi(0), null);
});

test('destination walks the great circle', () => {
  const to = H.gridToLatLon('JO31');
  const p = P.destination(QTH, H.bearingDeg(QTH, to), H.distanceKm(QTH, to));
  near(p.lat, to.lat, 0.01, 'lat');
  near(p.lon, to.lon, 0.01, 'lon');
});

test('short and long path geometry', () => {
  const to = H.gridToLatLon('PM95');
  const s = P.pathGeometry(QTH, to), l = P.pathGeometry(QTH, to, true);
  near(s.km + l.km, 2 * Math.PI * 6371, 1);
  near((s.bearing + 180) % 360, l.bearing, 0.01);
  assert.equal(s.hops, Math.ceil(s.km / 4000));
  assert.ok(s.hopKm <= 4000);
});

test('control points follow P.533 by distance', () => {
  const geo = km => ({ km, hops: Math.max(1, Math.ceil(km / 4000)), hopKm: km / Math.max(1, Math.ceil(km / 4000)) });
  assert.deepEqual(P.controlPoints(geo(1500)).map(c => c.s), [750]);
  assert.deepEqual(P.controlPoints(geo(3000)).map(c => c.s), [1000, 2000]);
  assert.equal(P.controlPoints(geo(6000)).length, 2);
  assert.deepEqual(P.controlPoints(geo(12000)).map(c => c.s), [2000, 10000]);
  assert.ok(P.controlPoints(geo(12000)).every(c => c.hopKm === 4000));
});

test('M-factor grows with hop length and matches M(3000)', () => {
  near(P.mFactor(3000, 3.2), 3.2, 1e-9);
  assert.ok(P.mFactor(500) < P.mFactor(3000));
  assert.ok(P.mFactor(3000) < P.mFactor(4000));
  near(P.mFactor(100), 1.05, 0.1, 'near-vertical');
});

test('geomagnetic latitude', () => {
  near(P.geomagLat({ lat: 80.7, lon: -72.7 }), 90, 0.01);
  assert.ok(P.geomagLat({ lat: 34, lon: -116 }) > 38 && P.geomagLat({ lat: 34, lon: -116 }) < 44);
});

test('foF2 model: day above night, more sunspots means higher', () => {
  const noon = Date.parse('2026-10-26T20:00:00Z'), night = Date.parse('2026-10-26T10:00:00Z');
  assert.ok(P.modelFoF2(QTH, noon, 100) > P.modelFoF2(QTH, night, 100) * 1.8);
  assert.ok(P.modelFoF2(QTH, noon, 150) > P.modelFoF2(QTH, noon, 50));
  near(P.modelFoF2(QTH, noon, 100), 10.5, 1.5, 'midlatitude noon at SSN 100');
});

test('foF2 model matches late-2026 ionosondes at low sunspot numbers', () => {
  // Measured at SSN 48 on 2026-11-04: Idaho 8.19 MHz at 18:30 UTC (local
  // morning), Rome 4.25 MHz at 18:30 UTC (evening). The model used to run
  // about 25% low at both.
  near(P.modelFoF2({ lat: 43.81, lon: -112.68 }, Date.parse('2026-11-04T18:30:00Z'), 48), 8.19, 0.8, 'Idaho');
  near(P.modelFoF2({ lat: 41.8, lon: 12.5 }, Date.parse('2026-11-04T18:30:00Z'), 48), 4.25, 0.5, 'Rome');
});

test('live ionosonde readings scale the model nearby', () => {
  const t = Date.parse('2026-10-26T20:00:00Z');
  const st = { name: 'Near', lat: 34.6, lon: -117, fof2: 1.5 * P.modelFoF2({ lat: 34.6, lon: -117 }, t, 100), md: '3.4' };
  const cal = P.calibration([st], t, 100);
  near(cal.points[0].ratio, 1.5, 1e-6);
  const a = P.anchorAt(cal, { lat: 34.6, lon: -117 });
  near(a.ratio, 1.5, 0.01);
  assert.equal(a.md, 3.4);
  // Far from any station, the global median applies.
  assert.equal(P.anchorAt(cal, { lat: -40, lon: 170 }).station, null);
});

test('local MUF from the model when no ionosonde is near', () => {
  const t = Date.parse('2026-10-26T20:00:00Z'); // midday at DM14
  const bare = P.localMuf(QTH, { now: t, ssn: 100 });
  assert.equal(bare.anchors, 0);
  near(bare.muf, bare.fof2 * 3.2, 0.2, 'MUF(3000) = foF2 x M(3000)');
  assert.ok(bare.muf > P.localMuf(QTH, { now: t + 12 * 3600_000, ssn: 100 }).muf, 'day above night');
  // Distant stations reading 20% above the model raise it everywhere.
  const far = [{ lat: 50, lon: 10 }, { lat: -30, lon: 25 }].map(s => ({ ...s, name: 'Far', fof2: 1.2 * P.modelFoF2(s, t, 100) }));
  const anchored = P.localMuf(QTH, { now: t, ssn: 100, stations: far });
  assert.equal(anchored.anchors, 2);
  near(anchored.fof2, bare.fof2 * 1.2, 0.15);
});

test('80 m over a long daylight path is absorbed, 20 m is fine', () => {
  const geo = P.pathGeometry(QTH, H.gridToLatLon('FN42'));
  const r = P.evaluate(geo, Date.parse('2026-10-26T19:00:00Z'), { bands: BANDS, ssn: 100, kp: 1 });
  assert.equal(r.bands['80m'].rating, 'closed');
  assert.equal(r.bands['80m'].limit, 'absorption');
  assert.equal(r.bands['20m'].rating, 'good');
});

test('10 m at night is above the MUF, 40 m opens', () => {
  const geo = P.pathGeometry(QTH, H.gridToLatLon('FN42'));
  const r = P.evaluate(geo, Date.parse('2026-10-26T08:00:00Z'), { bands: BANDS, ssn: 100, kp: 1 });
  assert.equal(r.bands['10m'].rating, 'closed');
  assert.equal(r.bands['10m'].limit, 'muf');
  assert.equal(r.bands['40m'].rating, 'good');
});

test('a storm hurts the polar path to Europe more than the path to Japan', () => {
  const t = Date.parse('2026-10-26T04:00:00Z');
  const score = (grid, kp) => {
    const r = P.evaluate(P.pathGeometry(QTH, H.gridToLatLon(grid)), t, { bands: BANDS, ssn: 100, kp });
    return { auroral: r.auroral, sum: Object.values(r.bands).reduce((a, b) => a + H.RATING.indexOf(b.rating), 0) };
  };
  const eu = score('JO31', 7), euQuiet = score('JO31', 1);
  assert.equal(eu.auroral, true);
  assert.ok(eu.sum < euQuiet.sum);
});

test('analysis has 24 hours for both paths, and a summary', () => {
  const now = Date.parse('2026-10-26T19:30:00Z');
  const a = P.analyzePath(QTH, H.gridToLatLon('JO31'), { now, ssn: 100, kp: 2, bands: BANDS });
  assert.equal(a.short.hours.length, 24);
  assert.equal(a.long.hours.length, 24);
  assert.equal(a.short.hours[0].t, '2026-10-26T20:00:00.000Z');
  const s = P.summarize(a.short, BANDS);
  assert.ok(s.best === null || BANDS.some(b => b[0] === s.best.band));
  for (const runs of Object.values(s.windows)) for (const w of runs) assert.ok(w.start <= w.end);
});

test('measured reports are sorted into each direction by band', () => {
  const to = H.gridToLatLon('JO31');
  const rep = (tx, txGrid, rx, rxGrid, mhz, snr) => ({ tx, txGrid, rx, rxGrid, freq: mhz * 1e6, snr, mode: 'FT8', time: 1_800_000_000 });
  const m = P.measured([
    rep('DL1AA', 'JO31', 'K6RX', 'DM13', 14.074, -15), // heard near you
    rep('DL2BB', 'JO40', 'K6RX', 'DM13', 14.075, -8),
    rep('W6TX', 'DM04', 'DL9RX', 'JO31', 14.074, -20), // you heard near the target
    rep('JA1AA', 'PM95', 'K6RX', 'DM13', 14.074, -3), // other path
    rep('DL1AA', 'JO31', 'K6RX', 'DM13', 10.136, -12),
  ], QTH, to);
  assert.equal(m['20m'].toYou, 2);
  assert.equal(m['20m'].fromYou, 1);
  assert.equal(m['20m'].bestSnr, -8);
  assert.equal(m['30m'].toYou, 1);
  assert.equal(m['40m'], undefined);
});

test('saved-path tracker: no event on first sight, one per opening, cooldown', () => {
  const events = [];
  const t = new P.PathTracker((id, band) => events.push(`${id}:${band}`), 60 * 60_000);
  const min = 60_000;
  t.update('ja', { '20m': 'good', '15m': 'poor' }, 0); // already open at start: nothing
  t.update('ja', { '20m': 'good', '15m': 'good' }, 5 * min);
  assert.deepEqual(events, ['ja:15m']);
  t.update('ja', { '15m': 'fair' }, 10 * min);
  t.update('ja', { '15m': 'good' }, 15 * min); // within the cooldown
  assert.deepEqual(events, ['ja:15m']);
  t.update('ja', { '15m': 'poor' }, 70 * min);
  t.update('ja', { '15m': 'good' }, 75 * min);
  assert.deepEqual(events, ['ja:15m', 'ja:15m']);
  t.update('eu', { '20m': 'good' }, 80 * min); // a newly saved path starts quiet
  assert.equal(events.length, 2);
});
