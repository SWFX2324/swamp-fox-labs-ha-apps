'use strict';
// Public nodes near home from the community maps, to show beside what your own
// radios hear:
//
//   Meshtastic  meshmap.net/nodes.json: every node the public MQTT server has
//               seen with a position (about 1 MB gzipped, refreshed each minute
//               by the site). Fetched every 10 minutes.
//   MeshCore    map.meshcore.io/api/v1/nodes: every node uploaded to the
//               MeshCore map (tens of MB). Fetched every 6 hours and read as a
//               stream, keeping only the nodes within the radius, so the whole
//               list is never held in memory.
//
// Only nodes within the radius of the centre (Home Assistant's home location)
// are kept. The last result is saved to /data so a restart doesn't download
// again before it's due.

const fs = require('fs');

const SOURCES = {
  meshtastic: { url: 'https://meshmap.net/nodes.json', everyMs: 10 * 60_000, maxAgeMs: 24 * 3600_000 },
  meshcore: { url: 'https://map.meshcore.io/api/v1/nodes', everyMs: 6 * 3600_000, maxAgeMs: 10 * 86_400_000 },
};
const RETRY_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 5 * 60_000;
const MAX_NODES = 1500;

function distanceKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function meshtasticNode(key, n, now) {
  if (!n || typeof n !== 'object') return null;
  const lat = num(n.latitude), lon = num(n.longitude);
  if (lat === null || lon === null) return null;
  const seen = n.seenBy && typeof n.seenBy === 'object' ? Math.max(0, ...Object.values(n.seenBy).filter(v => typeof v === 'number')) : 0;
  const id = /^\d+$/.test(key) ? '!' + (Number(key) >>> 0).toString(16).padStart(8, '0') : String(key).slice(0, 16);
  return {
    id, network: 'meshtastic', name: String(n.longName || id).slice(0, 40), short: n.shortName ? String(n.shortName).slice(0, 8) : null,
    kind: n.role ? String(n.role) : null, hw: n.hwModel ? String(n.hwModel) : null,
    lat: lat / 1e7, lon: lon / 1e7, alt: num(n.altitude),
    lastHeard: seen ? Math.min(seen * 1000, now) : null,
    battery: num(n.batteryLevel), voltage: num(n.voltage), chUtil: num(n.chUtil), airUtil: num(n.airUtilTx),
    preset: n.modemPreset ? String(n.modemPreset) : null, region: n.region ? String(n.region) : null,
    firmware: n.fwVersion ? String(n.fwVersion) : null, source: 'web',
  };
}

const MC_TYPES = { 1: 'Companion', 2: 'Repeater', 3: 'Room server', 4: 'Sensor' };

function meshcoreNode(n, now) {
  if (!n || typeof n !== 'object') return null;
  const lat = num(n.adv_lat), lon = num(n.adv_lon);
  if (lat === null || lon === null || (lat === 0 && lon === 0)) return null;
  const heard = Date.parse(n.last_advert || n.updated_date || '');
  const p = n.params && typeof n.params === 'object' ? n.params : {};
  const key = typeof n.public_key === 'string' ? n.public_key.toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(key)) return null;
  return {
    id: key, network: 'meshcore', name: String(n.adv_name || key.slice(0, 8)).slice(0, 40), short: key.slice(0, 4).toUpperCase(),
    kind: MC_TYPES[n.type] || 'Node', hw: null, lat, lon, alt: null,
    lastHeard: Number.isFinite(heard) ? Math.min(heard, now) : null,
    radio: num(p.freq) ? { freq: num(p.freq), bw: num(p.bw), sf: num(p.sf), cr: num(p.cr) } : null,
    source: 'web',
  };
}

// Splits a JSON array of objects arriving in chunks into one object's text at a
// time, by tracking brace depth outside strings.
class ArraySplitter {
  constructor(onObject) { this.onObject = onObject; this.depth = 0; this.inStr = false; this.esc = false; this.buf = ''; this.start = -1; }
  push(text) {
    let s = this.buf + text;
    let i = this.buf.length;
    let start = this.start;
    for (; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (c === 92) this.esc = true;          // backslash
        else if (c === 34) this.inStr = false;       // quote
      } else if (c === 34) this.inStr = true;
      else if (c === 123) { if (this.depth++ === 0) start = i; }   // {
      else if (c === 125) {                                        // }
        if (--this.depth === 0 && start >= 0) { this.onObject(s.slice(start, i + 1)); start = -1; }
      }
    }
    if (start >= 0) { this.buf = s.slice(start); this.start = 0; } else { this.buf = ''; this.start = -1; }
    s = null;
  }
}

class WebMaps {
  constructor({ radiusKm = 100, enabled = true, stateFile = null, userAgent = 'HomeAssistant-MeshHub', log = console, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    this.radiusKm = radiusKm;
    this.enabled = enabled;
    this.stateFile = stateFile;
    this.userAgent = userAgent;
    this.log = log;
    this.fetch = fetchImpl;
    this.now = now;
    this.center = null;
    this.data = {
      meshtastic: { nodes: [], fetchedAt: null, error: null, center: null },
      meshcore: { nodes: [], fetchedAt: null, error: null, center: null },
    };
    this.timers = {};
    this.busy = {};
    this.load();
  }

  load() {
    if (!this.stateFile) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      for (const k of Object.keys(this.data)) {
        if (saved[k] && Array.isArray(saved[k].nodes) && saved[k].radiusKm === this.radiusKm) {
          this.data[k] = { nodes: saved[k].nodes, fetchedAt: saved[k].fetchedAt, error: null, center: saved[k].center || null };
        }
      }
    } catch { /* first start */ }
  }

  save() {
    if (!this.stateFile) return;
    const out = {};
    for (const [k, d] of Object.entries(this.data)) out[k] = { nodes: d.nodes, fetchedAt: d.fetchedAt, center: d.center, radiusKm: this.radiusKm };
    try { fs.writeFileSync(this.stateFile + '.tmp', JSON.stringify(out)); fs.renameSync(this.stateFile + '.tmp', this.stateFile); } catch (e) { this.log.warn('[web] saving:', e.message); }
  }

  setCenter(center) {
    if (!center) return;
    const moved = !this.center || distanceKm(this.center.lat, this.center.lon, center.lat, center.lon) > 1;
    this.center = center;
    if (moved && this.enabled) this.start();
  }

  start() {
    if (!this.enabled || !this.center) return;
    for (const k of Object.keys(SOURCES)) {
      clearTimeout(this.timers[k]);
      const d = this.data[k];
      const sameCenter = d.center && distanceKm(d.center.lat, d.center.lon, this.center.lat, this.center.lon) < 1;
      const due = !sameCenter || !d.fetchedAt ? 0 : Math.max(0, d.fetchedAt + SOURCES[k].everyMs - this.now());
      this.schedule(k, due);
    }
  }

  stop() { for (const t of Object.values(this.timers)) clearTimeout(t); }

  schedule(k, ms) {
    clearTimeout(this.timers[k]);
    this.timers[k] = setTimeout(() => this.refresh(k), ms);
    this.timers[k].unref?.();
  }

  async refresh(k) {
    if (this.busy[k] || !this.center) return;
    this.busy[k] = true;
    const src = SOURCES[k];
    const ctl = new AbortController();
    const abort = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetch(src.url, { headers: { 'User-Agent': this.userAgent, Accept: 'application/json' }, signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const nodes = k === 'meshtastic' ? await this.readMeshtastic(res) : await this.readMeshCore(res);
      nodes.sort((a, b) => a.distanceKm - b.distanceKm);
      this.data[k] = { nodes: nodes.slice(0, MAX_NODES), fetchedAt: this.now(), error: null, center: { ...this.center } };
      this.log.log(`[web] ${k}: ${nodes.length} public nodes within ${this.radiusKm} km`);
      this.save();
      this.schedule(k, src.everyMs);
    } catch (e) {
      const why = e.name === 'AbortError' ? 'timed out' : e.message;
      this.log.warn(`[web] ${k} map: ${why}; trying again in ${RETRY_MS / 60_000} min`);
      this.data[k].error = `Couldn’t load the public map (${why}).`;
      this.schedule(k, RETRY_MS);
    } finally {
      clearTimeout(abort);
      this.busy[k] = false;
    }
  }

  keep(node, maxAgeMs) {
    if (!node) return null;
    if (node.lastHeard && this.now() - node.lastHeard > maxAgeMs) return null;
    const d = distanceKm(this.center.lat, this.center.lon, node.lat, node.lon);
    if (d > this.radiusKm) return null;
    node.distanceKm = Math.round(d * 10) / 10;
    return node;
  }

  async readMeshtastic(res) {
    const all = await res.json();
    if (!all || typeof all !== 'object' || Array.isArray(all)) throw new Error('unexpected format');
    const out = [];
    const now = this.now();
    for (const [key, n] of Object.entries(all)) {
      const node = this.keep(meshtasticNode(key, n, now), SOURCES.meshtastic.maxAgeMs);
      if (node) out.push(node);
    }
    return out;
  }

  async readMeshCore(res) {
    const out = [];
    const now = this.now();
    let bad = 0;
    const splitter = new ArraySplitter(text => {
      // A cheap look at the position first, so most of the world is skipped
      // without parsing it.
      const la = /"adv_lat":(-?[\d.]+)/.exec(text), lo = /"adv_lon":(-?[\d.]+)/.exec(text);
      if (!la || !lo) return;
      if (distanceKm(this.center.lat, this.center.lon, Number(la[1]), Number(lo[1])) > this.radiusKm) return;
      try {
        const node = this.keep(meshcoreNode(JSON.parse(text), now), SOURCES.meshcore.maxAgeMs);
        if (node) out.push(node);
      } catch { bad++; }
    });
    const decoder = new TextDecoder();
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        splitter.push(decoder.decode(value, { stream: true }));
      }
      splitter.push(decoder.decode());
    } else {
      splitter.push(await res.text());
    }
    if (bad) this.log.warn(`[web] meshcore: skipped ${bad} unreadable entries`);
    return out;
  }

  snapshot() {
    const out = { enabled: this.enabled, radiusKm: this.radiusKm, center: this.center };
    for (const [k, d] of Object.entries(this.data)) out[k] = { nodes: d.nodes, fetchedAt: d.fetchedAt, error: d.error, loading: !!this.busy[k] };
    return out;
  }
}

module.exports = { WebMaps, ArraySplitter, meshtasticNode, meshcoreNode, distanceKm, SOURCES };
