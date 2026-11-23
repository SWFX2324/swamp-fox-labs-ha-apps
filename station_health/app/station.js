'use strict';
// Gathers everything behind the page and builds one snapshot (model.js).
// Each source keeps its own cache, refresh time and error, so one failing
// never blanks another: a UniFi outage leaves the containers alone.
//
// Home Assistant and the UniFi console are read when someone has the page
// open, except for one small background sample of the WAN every 5 minutes
// (kept for 24 hours in /data) so the internet graph and uptime row have a
// history. Home Assistant's Recorder provides the history for everything else.

const fs = require('fs');
const path = require('path');
const M = require('./model');

const MIN = 60_000;
const HOUR = 60 * MIN;

class Source {
  constructor(name, { ttl, retryMs = Math.min(ttl, 2 * MIN), load, now = Date.now }) {
    Object.assign(this, { name, ttl, retryMs, load, now });
    this.data = null;
    this.fetchedAt = null;
    this.error = null;
    this.errorAt = null;
    this.inflight = null;
  }

  due() {
    const t = this.now();
    if (this.errorAt && (!this.fetchedAt || this.errorAt > this.fetchedAt)) return t - this.errorAt >= this.retryMs;
    return !this.fetchedAt || t - this.fetchedAt >= this.ttl;
  }

  refresh(force = false) {
    if (this.inflight) return this.inflight;
    if (!force && !this.due()) return Promise.resolve();
    this.inflight = (async () => {
      try {
        this.data = await this.load();
        this.fetchedAt = this.now();
        this.error = null;
        this.errorAt = null;
      } catch (e) {
        this.error = e?.message || 'Could not be read.';
        this.errorAt = this.now();
        if (!['HaError', 'UnifiError'].includes(e?.name)) console.warn(`[${this.name}] ${e?.stack || e}`);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  status() { return { fetchedAt: this.fetchedAt, error: this.error, errorAt: this.errorAt }; }
}

class Station {
  constructor({ ha, unifi = null, dataDir = null, now = Date.now, sampleMs = 5 * MIN }) {
    Object.assign(this, { ha, unifi, dataDir, now, sampleMs });
    this.samplesFile = dataDir ? path.join(dataDir, 'wan-samples.json') : null;
    this.samples = this.loadSamples();
    // UniFi devices marked "stored" (packed away on purpose): name -> when marked.
    this.storedFile = dataDir ? path.join(dataDir, 'stored.json') : null;
    this.stored = this.loadStored();

    this.states = new Source('states', { ttl: 20_000, now, load: () => ha.states() });
    this.registry = new Source('registry', {
      ttl: 10 * MIN, now,
      load: async () => {
        const [entities, devices, config] = await Promise.all([ha.entities(), ha.devices(), ha.config()]);
        return { entities, devices, config };
      },
    });
    // Integration states change on their own (a reload, a retry), so they're
    // read as often as states, not with the registries.
    this.entries = new Source('entries', { ttl: 20_000, now, load: () => ha.configEntries() });
    this.supervisor = new Source('supervisor', {
      ttl: 5 * MIN, now,
      load: async () => {
        const get = p => ha.supervisor(p).catch(() => null);
        const [info, host, os, core] = await Promise.all([get('/info'), get('/host/info'), get('/os/info'), get('/core/info')]);
        if (!info && !host && !core) throw new Error("The Supervisor didn't answer.");
        return { info, host, os, core };
      },
    });
    this.unifiSource = unifi?.configured ? new Source('unifi', { ttl: 30_000, retryMs: 3 * MIN, now, load: () => unifi.snapshot() }) : null;
    this.history = new Source('history', { ttl: 5 * MIN, now, load: () => this.loadHistory() });
    this.timer = null;
  }

  // ---- WAN samples -------------------------------------------------------------

  loadSamples() {
    if (!this.samplesFile) return [];
    try {
      const j = JSON.parse(fs.readFileSync(this.samplesFile, 'utf8'));
      return Array.isArray(j) ? j.filter(s => this.now() - s.t < 24 * HOUR) : [];
    } catch { return []; }
  }

  saveSamples() {
    if (!this.samplesFile) return;
    try { fs.writeFileSync(this.samplesFile, JSON.stringify(this.samples)); } catch (e) { console.warn(`[samples] ${e.message}`); }
  }

  // ---- stored devices --------------------------------------------------------------
  // A stored device isn't an alert. The mark clears itself once the device is
  // connected again, so nothing can stay hidden by mistake.

  loadStored() {
    if (!this.storedFile) return new Map();
    try {
      const j = JSON.parse(fs.readFileSync(this.storedFile, 'utf8'));
      return new Map((Array.isArray(j) ? j : []).filter(x => x && typeof x.name === 'string' && x.name.length <= 100)
        .map(x => [x.name, Number.isFinite(x.since) ? x.since : this.now()]));
    } catch { return new Map(); }
  }

  saveStored() {
    if (!this.storedFile) return;
    try { fs.writeFileSync(this.storedFile, JSON.stringify([...this.stored].map(([name, since]) => ({ name, since })))); } catch (e) { console.warn(`[stored] ${e.message}`); }
  }

  // Only a device that exists and isn't connected can be marked stored.
  setStored(name, on) {
    if (typeof name !== 'string' || !name || name.length > 100) return false;
    if (!on) {
      if (this.stored.delete(name)) this.saveStored();
      return true;
    }
    const d = this.build(false).network.devices.find(x => x.name === name);
    if (!d || d.state === 'connected') return false;
    if (!this.stored.has(name)) { this.stored.set(name, this.now()); this.saveStored(); }
    return true;
  }

  applyStored(s) {
    let changed = false;
    for (const d of s.network.devices) {
      if (!this.stored.has(d.name)) continue;
      if (d.state === 'connected') { this.stored.delete(d.name); changed = true; continue; }
      d.stored = true;
      d.storedSince = this.stored.get(d.name);
    }
    if (changed) this.saveStored();
  }

  async sample() {
    if (!this.unifiSource) return;
    await this.unifiSource.refresh();
    const t = this.now();
    const api = this.unifiSource.data;
    const fresh = api && !this.unifiSource.error && t - api.at < 2 * MIN;
    let s = { t, up: null };
    if (fresh) {
      const net = M.unifiFromApi(api, '°C', t);
      if (net.wan) s = { t, up: net.wan.up, down: net.wan.downBps, upl: net.wan.upBps, ms: net.wan.latencyMs };
    }
    this.samples = [...this.samples.filter(x => t - x.t < 24 * HOUR), s];
    this.saveSamples();
  }

  start() {
    if (!this.unifiSource || this.timer) return;
    this.sample().catch(() => {});
    this.timer = setInterval(() => this.sample().catch(() => {}), this.sampleMs);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  // ---- history -------------------------------------------------------------------

  async loadHistory() {
    await Promise.all([this.states.refresh(), this.registry.refresh(), this.entries.refresh()]);
    if (!this.states.data || !this.registry.data) throw new Error('Waiting for Home Assistant.');
    const base = this.build(false);
    const trackerList = M.trackers(base);
    const entities = [...new Set(trackerList.flatMap(t => t.entities || [t.entity]))];
    const end = new Date(this.now()), start = new Date(this.now() - 7 * 24 * HOUR);
    const changeEntities = this.states.data.map(s => s.entity_id).filter(e => /^update\./.test(e) || /^event\..*_docker_event$/.test(e));
    const [states, changes] = await Promise.all([
      this.ha.history(entities, start, end),
      this.ha.history(changeEntities, start, end, { attributes: true }).catch(() => ({})),
    ]);
    return { states, changes, trackers: trackerList.map(t => t.key) };
  }

  // ---- snapshot ----------------------------------------------------------------------

  build(withHistory = true) {
    const now = this.now();
    const reg = this.registry.data || {};
    const unit = reg.config?.unit_system?.temperature || '°C';
    const ix = M.indexHa({ states: this.states.data || [], entities: reg.entities || [], devices: reg.devices || [], entries: this.entries.data || [] });
    const api = this.unifiSource?.data || null;
    const s = {
      hosts: M.hosts(ix, this.supervisor.data),
      containers: M.containers(ix),
      network: M.network(ix, api, unit, now),
      updates: M.updates(ix),
      backups: M.backups(ix, now),
      integrations: M.integrations(ix),
      unifiError: this.unifiSource?.error || null,
    };
    this.applyStored(s);
    if (!withHistory) return s;

    const hist = this.history.data;
    const trackerList = M.trackers(s);
    s.uptime = hist ? M.uptime(trackerList, hist.states, now) : null;
    if (s.uptime && this.unifiSource) s.uptime.rows.unshift(this.wanRow(s.uptime.start, s.uptime.blockMin, now));
    const changeList = hist ? M.changes(hist.changes) : [];
    s.incidents = hist ? M.incidents(trackerList, hist.states, changeList, s.network.newDevices || [], now) : null;
    const storedKeys = new Set(s.network.devices.filter(d => d.stored).map(d => `unifi:${d.name}`));
    for (const r of s.uptime?.rows || []) if (storedKeys.has(r.key)) r.stored = true;
    for (const i of s.incidents || []) if (i.ongoing && storedKeys.has(i.key)) { i.stored = true; i.severity = 'stored'; }
    s.wanHistory = this.unifiSource ? this.samples.map(x => ({ t: x.t, down: x.down ?? null, up: x.upl ?? null })) : null;
    s.summary = M.summary(s, now);
    return s;
  }

  // The internet row of the uptime chart, from the app's own WAN samples.
  wanRow(start, blockMin, now) {
    const n = Math.round((now - start) / (blockMin * MIN));
    const blocks = new Array(n).fill('x');
    let up = 0, total = 0;
    const byBlock = new Map();
    for (const x of this.samples) {
      if (x.up === null || x.t < start) continue;
      const b = Math.min(n - 1, Math.floor((x.t - start) / (blockMin * MIN)));
      if (!byBlock.has(b)) byBlock.set(b, []);
      byBlock.get(b).push(x.up);
      total++;
      if (x.up) up++;
    }
    for (const [b, list] of byBlock) {
      const downs = list.filter(u => !u).length;
      blocks[b] = downs === 0 ? 'u' : downs < list.length / 2 ? 'w' : 'd';
    }
    return { key: 'wan', name: 'Internet (WAN)', kind: 'wan', blocks, pct: total ? Math.round((up / total) * 1000) / 10 : null };
  }

  async snapshot({ force = false, waitMs = 6000 } = {}) {
    const work = Promise.all([
      this.states.refresh(force), this.registry.refresh(force), this.entries.refresh(force), this.supervisor.refresh(force),
      this.unifiSource?.refresh(force), this.history.refresh(force),
    ]);
    // Answer within waitMs with whatever is ready; slow sources show as loading.
    await Promise.race([work, new Promise(r => setTimeout(r, waitMs))]);
    const s = this.build();
    return {
      version: process.env.APP_VERSION || 'dev',
      generatedAt: this.now(),
      ready: Boolean(this.states.data && this.registry.data),
      unifiConfigured: Boolean(this.unifiSource),
      timeZone: this.registry.data?.config?.time_zone || null,
      sources: this.status(),
      ...s,
    };
  }

  status() {
    const out = { states: this.states.status(), registry: this.registry.status(), entries: this.entries.status(), supervisor: this.supervisor.status(), history: this.history.status() };
    if (this.unifiSource) out.unifi = this.unifiSource.status();
    return out;
  }
}

module.exports = { Station, Source };
