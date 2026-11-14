'use strict';
// The shared helpers (app/static/wxcore.js). Carries over the checks from the
// Lovelace card this app replaces, plus the ones for the app's own additions.

const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../app/static/wxcore');

test('RainViewer accepts opaque and numeric frame IDs and rejects URL injection', () => {
  assert.equal(W.validRadarFrame({ time: 1794516000, path: '/v2/radar/729ec7f4a807' }), true);
  assert.equal(W.validRadarFrame({ time: 1794516000, path: '/v2/radar/1794516000' }), true);
  for (const path of ['https://other.example/tile', '/v2/radar/../../secret', '/v2/radar/id?x=1', '/v2/radar/a" onerror=bad', '/v2/radar/']) {
    assert.equal(W.validRadarFrame({ time: 1794516000, path }), false, path);
  }
  assert.equal(W.validRadarFrame({ time: null, path: '/v2/radar/729ec7f4a807' }), false);
});

test('missing readings stay missing; zero is a reading', () => {
  for (const value of [null, undefined, '', '  ', true, false, 'unavailable', 'unknown', Infinity, NaN]) assert.equal(W.number(value), null);
  assert.equal(W.number(0), 0);
  assert.equal(W.number('0'), 0);
  assert.equal(W.number(-12.3), -12.3);
  assert.equal(W.format(null), '—');
  assert.equal(W.format(0), '0');
});

test('public coordinates are regional, and invalid ones are refused', () => {
  assert.deepEqual(W.regionalPoint(34.234567, -116.123456), { lat: 34.2, lon: -116.1 });
  assert.equal(W.regionalPoint(null, 0), null);
  assert.equal(W.regionalPoint(91, 0), null);
  assert.equal(W.regionalPoint(0, 181), null);
});

test('source text cannot inject markup', () => {
  assert.equal(W.escapeHTML('<img src=x onerror="bad"> &'), '&lt;img src=x onerror=&quot;bad&quot;&gt; &amp;');
  assert.equal(W.escapeHTML("it's"), 'it&#39;s');
});

test('only https weather.gov links survive', () => {
  assert.equal(W.safeLink('javascript:alert(1)'), 'https://www.weather.gov/');
  assert.equal(W.safeLink('http://forecast.weather.gov/x'), 'https://www.weather.gov/');
  assert.equal(W.safeLink('https://weather.gov.evil.example/'), 'https://www.weather.gov/');
  assert.equal(W.safeLink('https://api.weather.gov/gridpoints/RAH/1,2/stations'), 'https://api.weather.gov/gridpoints/RAH/1,2/stations');
});

test('bearings wrap across north and keep a calm zero bearing', () => {
  assert.equal(W.compass(0), 'N');
  assert.equal(W.compass(360), 'N');
  assert.equal(W.compass(-90), 'W');
  assert.equal(W.compass(null), '—');
});

test('timestamps reveal stale, future and invalid values', () => {
  const now = Date.UTC(2026, 10, 12);
  assert.equal(W.age(now - 65 * 60000, now), '1 hr 5 min ago');
  assert.equal(W.age(now + 10 * 60000, now), 'future timestamp');
  assert.equal(W.age(undefined, now), 'time unavailable');
});

test('AQI categories include their boundaries and never call missing data good', () => {
  assert.equal(W.aqiCategory(null).label, 'Unavailable');
  assert.equal(W.aqiCategory(0).label, 'Good');
  assert.equal(W.aqiCategory(50).label, 'Good');
  assert.equal(W.aqiCategory(51).label, 'Moderate');
  assert.equal(W.aqiCategory(301).label, 'Hazardous');
  assert.equal(W.uvCategory(null), 'Not provided');
  assert.equal(W.uvCategory(0), 'Low');
});

test('recorder parsing accepts compact and full states without inventing values', () => {
  const result = W.historyPoints([{ lu: 100, a: { temperature: 0 } }, { last_updated: new Date(200000).toISOString(), attributes: { temperature: 12 } }, { lu: 300, a: { temperature: null } }], 'temperature');
  assert.deepEqual(result, [{ time: 100000, value: 0 }, { time: 200000, value: 12 }]);
});

test('pressure trend needs a recent reading and a baseline about 3 h earlier', () => {
  const now = Date.now();
  const readings = [{ time: now - 3 * 3600000, value: 30 }, { time: now, value: 30.1 }];
  assert.equal(W.pressureTrend(readings, now).label, 'Rising');
  assert.equal(W.pressureTrend(readings, now + 4 * 3600000), null);
  assert.equal(W.pressureTrend(readings.slice(1), now), null);
  assert.equal(W.pressureTrend([{ time: now - 3 * 3600000, value: 1013 }, { time: now, value: 1013.2 }], now, 'hPa').label, 'Steady');
});

test('charts handle absent and constant data without invalid SVG coordinates', () => {
  assert.equal(W.chartPaths([]), null);
  assert.equal(W.chartPaths([{ time: 1, value: 2 }]), null);
  const flat = W.chartPaths([{ time: 1, value: 0 }, { time: 2, value: 0 }], 920, 190, 26, true);
  assert.equal(flat.min, 0);
  assert.ok(!/NaN|Infinity/.test(flat.line + flat.area));
  const cold = W.chartPaths([{ time: 1, value: -10 }, { time: 2, value: -8 }]);
  assert.ok(cold.min < 0);
  const padded = W.chartPaths([{ time: 1, value: 1 }, { time: 2, value: 2 }], 400, 200, 20, false, 50);
  assert.equal(padded.coords[0].x, 50);
  assert.equal(padded.coords[1].x, 380);
});

test('a chart selection is kept by time, so it is the same hour on every tab', () => {
  const temps = [0, 1, 2, 3].map(i => ({ time: i * 3600000 }));
  const rain = [{ time: 0 }, { time: 2 * 3600000 }, { time: 3 * 3600000 }]; // hour 1 had no value
  assert.equal(W.nearestIndex(temps, 2 * 3600000), 2);
  assert.equal(W.nearestIndex(rain, 2 * 3600000), 1);
  assert.equal(W.nearestIndex([], 5), 0);
  assert.equal(W.nearestIndex(temps, NaN), 0);
});

test('station conversions follow the weather entity units and keep missing values', () => {
  assert.equal(W.fromC(0, '°F'), 32);
  assert.equal(W.fromC(20, '°C'), 20);
  assert.equal(W.fromC(null, '°F'), null);
  assert.ok(Math.abs(W.fromKmh(16.09344, 'mph') - 10) < 1e-9);
  assert.equal(W.fromKmh(36, 'm/s'), 10);
  assert.ok(Math.abs(W.fromPa(101325, 'inHg') - 29.92) < 0.01);
  assert.equal(W.fromPa(101325, 'hPa'), 1013.25);
  assert.equal(W.fromPa(101325, 'mbar'), 1013.25);
  assert.equal(W.fromPa(null, 'inHg'), null);
  assert.equal(W.distanceUnit({ temp: '°F' }), 'mi');
  assert.equal(W.distanceUnit({ temp: '°C' }), 'km');
  assert.ok(Math.abs(W.fromKm(16.09344, { temp: '°F' }) - 10) < 1e-9);
});

test('conditions read as words, with unknown ones made readable', () => {
  assert.equal(W.conditionText('partlycloudy'), 'Partly cloudy');
  assert.equal(W.conditionText('lightning-rainy'), 'Thunderstorms');
  assert.equal(W.conditionText('some-new-state'), 'Some new state');
  assert.equal(W.conditionText(undefined), 'Unavailable');
});

test('a retained all-clear is never presented as a fresh check', () => {
  const now = Date.now();
  assert.equal(W.alertStatus({ data: [], fetchedAt: now - 60000 }, now).kind, 'clear');
  assert.equal(W.alertStatus({ data: [], fetchedAt: now - 3600000 }, now).kind, 'last-clear');
  assert.equal(W.alertStatus({ data: [], fetchedAt: now - 60000, error: 'NWS down' }, now).kind, 'last-clear');
  assert.equal(W.alertStatus({ data: null, error: 'NWS down' }, now).kind, 'unavailable');
  assert.equal(W.alertStatus({ data: null, loading: true }, now).kind, 'checking');
  assert.equal(W.alertStatus({ disabled: true }, now).kind, 'off');
  const active = W.alertStatus({ data: [{ severity: 'Severe' }, { severity: 'Minor' }], fetchedAt: now - 3600000 }, now);
  assert.deepEqual([active.kind, active.tone, active.stale, active.count], ['active', 'critical', true, 2]);
});
