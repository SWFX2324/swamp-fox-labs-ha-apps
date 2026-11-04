'use strict';
// Model accuracy log: how the propagation model compares with what PSKReporter
// actually shows near the QTH. Collected so the model can be tuned with real
// data later. A check records, per HF band:
// - heard: distinct long-distance paths (2000 km or more) decoded by monitors
//   near the QTH, and how the model rated a sample of them at that moment. If the
//   model is right, real paths should mostly be rated fair or good.
// - monitors: how many nearby monitors decoded anything on the band, and how the
//   model rated the paths to the 18 NCDXF beacon sites. A band with busy
//   monitors but nothing long-distance heard, while the model rates it open,
//   points at the model being too optimistic.
// - sample: the 4-character grids at both ends of the rated paths
//   ("DM13JO31"), so a changed model can be replayed against them later.
// No callsigns are stored: only bands, grids, counts and ratings.

const fs = require('fs');
const HamCore = require('./static/hamcore');
const Prop = require('./prop');

const NEAR_KM = 800;
const DX_KM = 2000;
const SAMPLE_PER_BAND = 25;
// Which model rated the record: 1 up to 1.6.x, 2 from 1.7.0 (MUF lifted at low
// sunspot numbers, ratings measured against the operational MUF).
const MODEL = 2;
const HF_EDGES = [
  ['160m', 1800, 2000], ['80m', 3500, 4000], ['60m', 5330, 5410], ['40m', 7000, 7300], ['30m', 10100, 10150],
  ['20m', 14000, 14350], ['17m', 18068, 18168], ['15m', 21000, 21450], ['12m', 24890, 24990], ['10m', 28000, 29700],
];
const MHZ = Object.fromEntries(HamCore.HF_BANDS.map(([b, mhz]) => [b, mhz]));
const emptyRatings = () => ({ good: 0, fair: 0, poor: 0, closed: 0 });

// reports: PSKReporter area reports [{ rx, rxGrid, tx, txGrid, freq (Hz) }]
// inputs: { ssn, kp, stations } as for the path analysis; targets: beacon sites.
function check(reports, pos, inputs, targets, now = Date.now()) {
  const cal = Prop.calibration(inputs.stations, now, inputs.ssn);
  const perBand = {};
  for (const [band] of HF_EDGES) perBand[band] = { monitors: new Set(), paths: new Map() };
  for (const r of reports) {
    const khz = r.freq / 1000;
    const band = HF_EDGES.find(([, lo, hi]) => khz >= lo && khz <= hi)?.[0];
    if (!band) continue;
    const rx = HamCore.gridToLatLon(r.rxGrid);
    if (!rx || HamCore.distanceKm(pos, rx) > NEAR_KM) continue;
    const b = perBand[band];
    b.monitors.add(r.rx);
    const tx = HamCore.gridToLatLon(r.txGrid);
    if (!tx || HamCore.distanceKm(rx, tx) < DX_KM) continue;
    // One path per far-end 4-character grid, so a busy area doesn't dominate.
    const key = String(r.txGrid).slice(0, 4).toUpperCase();
    if (!b.paths.has(key)) b.paths.set(key, { rx, tx, grids: String(r.rxGrid).slice(0, 4).toUpperCase() + key });
  }
  const rate = (from, to, band) => Prop.evaluate(Prop.pathGeometry(from, to), now, { bands: [[band, MHZ[band]]], ssn: inputs.ssn, kp: inputs.kp, cal }).bands[band].rating;
  const bands = {};
  for (const [band, b] of Object.entries(perBand)) {
    if (!b.monitors.size) continue;
    const heard = emptyRatings();
    const sample = [...b.paths.values()].slice(0, SAMPLE_PER_BAND);
    for (const { rx, tx } of sample) heard[rate(rx, tx, band)]++;
    const beacons = emptyRatings();
    for (const t of targets) beacons[rate(pos, t, band)]++;
    bands[band] = { monitors: b.monitors.size, paths: b.paths.size, heard, beacons, sample: sample.map(p => p.grids) };
  }
  return { t: new Date(now).toISOString(), model: MODEL, ssn: Math.round(inputs.ssn), kp: inputs.kp, bands };
}

// Totals over records newer than sinceMs: how often real long-distance paths
// were rated fair or good, overall and per band.
function summarize(records, sinceMs) {
  const recent = records.filter(r => Date.parse(r.t) >= sinceMs);
  const perBand = {};
  let sampled = 0, agreed = 0;
  for (const r of recent) {
    for (const [band, b] of Object.entries(r.bands || {})) {
      const n = b.heard.good + b.heard.fair + b.heard.poor + b.heard.closed;
      const ok = b.heard.good + b.heard.fair;
      const p = perBand[band] || (perBand[band] = { sampled: 0, agreed: 0 });
      p.sampled += n; p.agreed += ok; sampled += n; agreed += ok;
    }
  }
  return {
    checks: recent.length, first: recent[0]?.t ?? null, last: recent[recent.length - 1]?.t ?? null,
    sampled, agreed, share: sampled ? +(agreed / sampled).toFixed(3) : null,
    bands: Object.fromEntries(Object.entries(perBand).map(([b, p]) => [b, { ...p, share: p.sampled ? +(p.agreed / p.sampled).toFixed(3) : null }])),
  };
}

// The log is one JSON record per line, about 3 KB each, so 10 MB holds about a
// month. When it passes maxBytes, the older half is dropped.
class AccuracyLog {
  constructor(file, maxBytes = 10 * 1024 * 1024) {
    this.file = file;
    this.maxBytes = maxBytes;
  }

  append(record) {
    try {
      fs.appendFileSync(this.file, JSON.stringify(record) + '\n');
      if (fs.statSync(this.file).size > this.maxBytes) {
        const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n');
        fs.writeFileSync(this.file, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
      }
    } catch (e) { console.warn('[accuracy]', e.message); }
  }

  read() {
    try {
      return fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }
}

// Records from the model now in use (records from before 1.7.0 have no model).
const isCurrent = r => (r.model || 1) === MODEL;

module.exports = { check, summarize, isCurrent, AccuracyLog, DX_KM, MODEL };
