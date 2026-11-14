'use strict';
// Source caching and the shaping of outside data (app/sources.js), with a
// fake clock and no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Source, SourceError, Observatory, shapeAlerts, shapeObservation, shapeForecast, siValue } = require('../app/sources');

function clock(t = 1_000_000) { const c = () => t; c.add = ms => { t += ms; }; return c; }

test('a source caches for its lifetime, then refreshes', async () => {
  const now = clock();
  let n = 0;
  const s = new Source('t', { ttl: 60_000, load: async () => ++n, now });
  await s.refresh();
  await s.refresh();
  assert.equal(s.data, 1);
  now.add(60_000);
  await s.refresh();
  assert.equal(s.data, 2);
});

test('a failed refresh keeps the last good value, records the error and backs off', async () => {
  const now = clock();
  let fail = false, n = 0;
  const s = new Source('t', { ttl: 60_000, retryMs: 30_000, load: async () => { n++; if (fail) throw new SourceError('down'); return 'good'; }, now });
  await s.refresh();
  fail = true;
  now.add(60_000);
  await s.refresh();
  assert.deepEqual([s.data, s.error], ['good', 'down']);
  const calls = n;
  now.add(10_000);
  await s.refresh();
  assert.equal(n, calls, 'waits retryMs before trying again');
  now.add(20_000);
  fail = false;
  await s.refresh();
  assert.deepEqual([s.data, s.error], ['good', null]);
});

test('simultaneous refreshes share one request', async () => {
  let n = 0;
  const s = new Source('t', { ttl: 60_000, load: () => new Promise(r => setTimeout(() => r(++n), 20)) });
  await Promise.all([s.refresh(), s.refresh(true), s.refresh()]);
  assert.equal(n, 1);
});

test('alerts keep text fields only, bounded, worst first', () => {
  const list = shapeAlerts([
    { properties: { event: 'Fog', severity: 'Minor', description: 'x'.repeat(10000), web: 'javascript:alert(1)' } },
    { properties: { event: '<b>Tornado</b>', severity: 'Extreme', instruction: 42 } },
  ]);
  assert.equal(list[0].event, '<b>Tornado</b>'); // escaped by the page, kept as text here
  assert.equal(list[0].instruction, '');
  assert.equal(list[1].description.length, 4000);
  assert.ok(!('web' in list[1]));
});

test('NWS observations are converted by their unit codes', () => {
  assert.equal(siValue({ value: 68, unitCode: 'wmoUnit:degF' }, 'temp'), 20);
  assert.equal(siValue({ value: 10, unitCode: 'wmoUnit:m_s-1' }, 'speed'), 36);
  assert.equal(siValue({ value: 1013, unitCode: 'wmoUnit:hPa' }, 'pressure'), 101300);
  assert.equal(siValue({ value: null, unitCode: 'wmoUnit:degC' }, 'temp'), null);
  const o = shapeObservation({ stationIdentifier: 'KRDU', name: 'Raleigh' }, {
    timestamp: '2026-11-14T12:00:00Z', temperature: { value: 15, unitCode: 'wmoUnit:degC' },
    seaLevelPressure: { value: null }, barometricPressure: { value: 100500, unitCode: 'wmoUnit:Pa' },
  }, 12);
  assert.equal(o.pressureKind, 'station');
  assert.equal(o.pressurePa, 100500);
  assert.equal(o.gustKmh, null);
});

test('forecasts keep known fields and drop entries without a valid time', () => {
  const f = shapeForecast([{ datetime: '2026-11-14T12:00:00Z', temperature: 60, secret: 'x' }, { datetime: 'nope', temperature: 1 }]);
  assert.deepEqual(f, [{ datetime: '2026-11-14T12:00:00Z', temperature: 60 }]);
});

function fakeHa(states) {
  return { available: true, states: async () => states, config: async () => ({ latitude: 35.7796, longitude: -78.6382 }) };
}

test('the weather entity is auto-picked, preferring a working forecast_home', async () => {
  const o = new Observatory({ ha: fakeHa([{ entity_id: 'weather.a', state: 'sunny' }, { entity_id: 'weather.forecast_home', state: 'cloudy' }]) });
  assert.equal(await o.pickEntity(), 'weather.forecast_home');
  const o2 = new Observatory({ ha: fakeHa([{ entity_id: 'weather.forecast_home', state: 'unavailable' }, { entity_id: 'weather.z', state: 'sunny' }]) });
  assert.equal(await o2.pickEntity(), 'weather.z');
  const o3 = new Observatory({ ha: fakeHa([]), options: { weather_entity: 'weather.mine' } });
  assert.equal(await o3.pickEntity(), 'weather.mine');
  const o4 = new Observatory({ ha: fakeHa([{ entity_id: 'sun.sun', state: 'above_horizon' }]) });
  await assert.rejects(o4.pickEntity(), /no weather entity/);
});

test('public services get the rounded location only', async () => {
  const o = new Observatory({ ha: fakeHa([]) });
  assert.deepEqual(await o.point(), { lat: 35.8, lon: -78.6 });
});
