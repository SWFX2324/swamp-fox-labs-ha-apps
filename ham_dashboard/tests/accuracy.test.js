'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../app/accuracy');
const H = require('../app/static/hamcore');
const { HamReference: R } = require('../app/static/reference');

const QTH = H.gridToLatLon('DM14xd');
const INPUTS = { ssn: 100, kp: 2, stations: [] };
const rep = (tx, txGrid, rx, rxGrid, mhz) => ({ tx, txGrid, rx, rxGrid, freq: mhz * 1e6, mode: 'FT8' });

test('a check rates real long paths and counts nearby monitors', () => {
  const now = Date.parse('2026-10-26T20:00:00Z');
  const r = A.check([
    rep('DL1AA', 'JO31', 'K6RX', 'DM13', 14.074), // 9000 km, counted
    rep('DL2BB', 'JO31', 'K6RX', 'DM13', 14.075), // same far-end grid: one path
    rep('JA1AA', 'PM95', 'W6RX', 'DM04', 14.074),
    rep('W6LOC', 'DM03', 'K6RX', 'DM13', 14.074), // local: a monitor, not a path
    rep('VK2AA', 'QF56', 'VE3RX', 'FN03', 14.074), // receiver far from the QTH: ignored
    rep('W6LOC', 'DM03', 'K6RX', 'DM13', 7.074),
  ], QTH, INPUTS, R.BEACONS, now);
  assert.equal(r.t, '2026-10-26T20:00:00.000Z');
  assert.equal(r.bands['20m'].monitors, 2);
  assert.equal(r.bands['20m'].paths, 2);
  const h = r.bands['20m'].heard;
  assert.equal(h.good + h.fair + h.poor + h.closed, 2);
  const b = r.bands['20m'].beacons;
  assert.equal(b.good + b.fair + b.poor + b.closed, 18);
  assert.equal(r.bands['40m'].paths, 0);
  assert.equal(r.bands['15m'], undefined, 'no monitors, no entry');
  assert.doesNotMatch(JSON.stringify(r), /DL1AA|K6RX|W6LOC/, 'no callsigns stored');
  assert.deepEqual(r.bands['20m'].sample, ['DM13JO31', 'DM04PM95'], 'grids at both ends, for replay');
  assert.equal(r.model, A.MODEL);
  assert.ok(A.isCurrent(r));
  assert.ok(!A.isCurrent({ t: r.t, bands: {} }), 'records from before 1.7.0 are the old model');
});

test('summary: share of real paths the model rated fair or good', () => {
  const day = 86400000, now = Date.parse('2026-10-26T00:00:00Z');
  const rec = (t, good, fair, poor, closed) => ({ t: new Date(t).toISOString(), bands: { '20m': { heard: { good, fair, poor, closed } } } });
  const s = A.summarize([rec(now - 10 * day, 0, 0, 5, 5), rec(now - day, 6, 2, 1, 1), rec(now, 3, 1, 0, 0)], now - 7 * day);
  assert.equal(s.checks, 2);
  assert.equal(s.sampled, 14);
  assert.equal(s.agreed, 12);
  assert.equal(s.share, +(12 / 14).toFixed(3));
  assert.equal(s.bands['20m'].sampled, 14);
});

test('the log trims its older half when it gets too big', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hamacc-')), 'a.jsonl');
  const log = new A.AccuracyLog(file, 2000);
  for (let i = 0; i < 60; i++) log.append({ t: new Date(i * 1000).toISOString(), i, bands: {} });
  const recs = log.read();
  assert.ok(fs.statSync(file).size <= 2000 + 100);
  assert.equal(recs[recs.length - 1].i, 59, 'newest kept');
  assert.ok(recs[0].i > 0, 'oldest dropped');
});
