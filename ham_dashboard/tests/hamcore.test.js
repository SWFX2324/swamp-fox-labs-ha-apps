'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../app/static/hamcore');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ±${tol}, got ${a}`);

test('grid squares convert both ways', () => {
  const p = H.gridToLatLon('DM14xd');
  near(p.lat, 34.15, 0.03, 'lat');
  near(p.lon, -116.04, 0.05, 'lon');
  assert.equal(H.latLonToGrid(p.lat, p.lon), 'DM14xd');
  // Four-character grids land in the middle of the square.
  assert.deepEqual(H.gridToLatLon('fn31'), { lat: 41.5, lon: -73 });
  assert.equal(H.gridToLatLon('ZZ99'), null);
  assert.equal(H.gridToLatLon(''), null);
});

test('distance and bearing', () => {
  const qth = { lat: 34.15, lon: -116.04 };
  const nyc = { lat: 40.71, lon: -74.01 };
  near(H.distanceKm(qth, nyc), 3745, 20, 'km');
  near(H.bearingDeg(qth, nyc), 65, 2, 'bearing');
  assert.equal(H.compass(0), 'N');
  assert.equal(H.compass(359), 'N');
  assert.equal(H.compass(225), 'SW');
});

test('sun is overhead near the subsolar point', () => {
  const t = new Date('2026-06-21T19:44:00Z');
  const sun = H.sunPosition(t);
  near(sun.lat, 23.44, 0.1, 'declination at solstice');
  near(H.sunAltitude(sun, sun.lat, sun.lon), 90, 0.01);
});

test('HF bands run 160 m to 10 m', () => {
  assert.deepEqual(H.HF_BANDS.map(b => b[0]), ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m']);
});

test('ratings are measured against the operational MUF, up to 20% above the MUF', () => {
  assert.equal(H.mufScore(1), 3);
  assert.equal(H.mufScore(1.08), 2);
  assert.equal(H.mufScore(1.15), 1);
  assert.equal(H.mufScore(1.25), 0);
});

test('band rating follows the MUF, absorption and Kp', () => {
  assert.equal(H.rateBand(14.1, 25, -20, 2), 'good');
  assert.equal(H.rateBand(28.4, 25, -20, 2), 'poor', '14% above the MUF');
  assert.equal(H.rateBand(28.4, 22, -20, 2), 'closed');
  assert.equal(H.rateBand(14.1, 0, -20, 2), null);
  // 160 m in daylight is limited by D-layer absorption.
  assert.equal(H.rateBand(1.9, 10, 45, 1), 'poor');
  // A severe storm knocks a good band down two steps (but not below poor).
  assert.equal(H.rateBand(14.1, 25, -20, 7), 'poor');
});

test('nearest ionosonde must be within 3000 km', () => {
  const pos = { lat: 34, lon: -116 };
  const stations = [{ name: 'Far', lat: 60, lon: 10 }, { name: 'Pt Arguello', lat: 34.6, lon: -120.6 }];
  assert.equal(H.nearestIonosonde(pos, stations).name, 'Pt Arguello');
  assert.equal(H.nearestIonosonde(pos, [stations[0]]), null);
});
