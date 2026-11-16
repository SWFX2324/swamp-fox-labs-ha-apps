'use strict';
// Keeps the picture current: Home Assistant's registries and states, the job
// log (rebuilt from Recorder history and kept in /data/jobs.json, so it
// outlives Recorder's retention), the printer's file list, and the two kinds of
// action the page can ask for: a printer button (Pause, Resume, Stop) and
// starting a file. Every action re-checks the printer's state first.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const M = require('./model');
const { PrinterFiles, FtpError, SAFE_PATH } = require('./ftps');
const threemf = require('./threemf');

const MIN = 60_000, DAY = 86400_000;
const SCAN_EVERY = 2 * MIN;
const ENERGY_EVERY = 30_000;
const FIRST_SCAN_DAYS = 30;
const MAX_JOBS = 5000;
const MAX_FILE = 512 * 1024 * 1024;   // largest .3mf sent to or read from the printer
const MAX_PARSE = 100 * 1024 * 1024;  // largest .3mf read into memory to show its plates
const FILE_NAME = /^[^\\/\x00-\x1f\x7f:*?"<>|]{1,140}\.3mf$/i;

class UserError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

class PrintLog {
  constructor({ ha, options = {}, dataDir = null, filesFactory = o => new PrinterFiles(o), now = () => Date.now() }) {
    Object.assign(this, { ha, options, dataDir, filesFactory, now });
    this.allowControls = options.allow_controls !== false;
    this.lowGrams = Number.isFinite(Number(options.low_spool_grams)) ? Number(options.low_spool_grams) : 150;
    this.cache = {};
    this.errors = {};
    this.jobs = [];
    this.scanFrom = {};
    this.stops = [];
    this.current = {};
    this.lastScan = 0;
    this.scanning = null;
    this.fileLists = new Map();
    this.plans = new Map();
    this.filesClients = new Map();
    this.camera = new Map();
    this.powerSensor = /^sensor.[a-z0-9_]+$/.test(String(options.power_sensor || '').trim()) ? String(options.power_sensor).trim() : '';
    const rate = Number(options.electricity_price_per_kwh);
    this.pricePerKwh = Number.isFinite(rate) && rate >= 0 ? rate : 0.3;
    this.energy = { days: {}, jobs: {}, series: {}, last: {}, since: null };
    this.load();
    this.loadEnergy();
  }

  // ---- storage ---------------------------------------------------------------------

  file(name) { return this.dataDir ? path.join(this.dataDir, name) : null; }

  load() {
    const f = this.file('jobs.json');
    if (!f) return;
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Array.isArray(j.jobs)) this.jobs = j.jobs.filter(x => x && typeof x.id === 'string' && Number.isFinite(x.start));
      if (j.scanFrom && typeof j.scanFrom === 'object') this.scanFrom = j.scanFrom;
      if (Array.isArray(j.stops)) this.stops = j.stops.filter(x => x && typeof x.serial === 'string' && Number.isFinite(x.t)).slice(-50);
    } catch { /* first run */ }
  }

  save() {
    const f = this.file('jobs.json');
    if (!f) return;
    try {
      fs.writeFileSync(f + '.tmp', JSON.stringify({ version: 1, jobs: this.jobs, scanFrom: this.scanFrom, stops: this.stops }));
      fs.renameSync(f + '.tmp', f);
    } catch (e) { console.warn('[print-log] could not save the job log:', e.message); }
  }

  // ---- Home Assistant data ---------------------------------------------------------------

  async source(key, maxAge, fn) {
    const c = this.cache[key];
    if (c && this.now() - c.at < maxAge) return c.value;
    if (c?.pending) return c.pending;
    const pending = fn().then(value => {
      this.cache[key] = { at: this.now(), value };
      delete this.errors[key];
      return value;
    }, err => {
      this.errors[key] = err.message;
      if (this.cache[key]) this.cache[key].pending = null;
      if (c?.value !== undefined) return c.value;
      throw err;
    });
    this.cache[key] = { ...(c || { at: 0 }), pending };
    return pending;
  }

  registry() {
    return this.source('registry', 10 * MIN, async () => {
      const [entities, devices, config] = await Promise.all([this.ha.entities(), this.ha.devices(), this.ha.config()]);
      return { entities, devices, config };
    });
  }

  states(maxAge = 5000) { return this.source('states', maxAge, () => this.ha.states()); }

  async world(maxAge) {
    const [reg, states] = await Promise.all([this.registry(), this.states(maxAge)]);
    const list = M.printers({ ...reg, states });
    return { reg, states, stateOf: new Map(states.map(s => [s.entity_id, s])), printers: list, timeZone: reg.config?.time_zone || 'UTC' };
  }

  printer(w, serial) {
    const p = w.printers.find(x => x.serial === serial) || (!serial && w.printers.length === 1 ? w.printers[0] : null);
    if (!p) throw new UserError('That printer isn\'t in Home Assistant.', 404);
    return p;
  }

  // ---- job log ---------------------------------------------------------------------------

  scan({ force = false } = {}) {
    if (this.scanning) return this.scanning;
    if (!force && this.now() - this.lastScan < SCAN_EVERY) return Promise.resolve();
    this.scanning = this.doScan().catch(e => { this.errors.history = e.message; console.warn('[print-log] history:', e.message); })
      .finally(() => { this.scanning = null; this.lastScan = this.now(); });
    return this.scanning;
  }

  async doScan() {
    const w = await this.world(30_000);
    const end = this.now();
    let changed = false;
    for (const p of w.printers) {
      const from = Math.max(end - FIRST_SCAN_DAYS * DAY, Number(this.scanFrom[p.serial]) || 0);
      const keys = ['print_status', 'subtask_name', 'gcode_file', 'print_weight', 'print_length', 'total_layers', 'current_layer', 'print_progress', 'stage', 'start_time', 'print_bed_type', 'speed_profile'];
      const ids = keys.map(k => p.ent[k]).filter(Boolean);
      const trayIds = M.trayEntities(p).map(t => t.entity);
      const [plain, withAttrs] = await Promise.all([
        this.ha.history(ids, new Date(from), new Date(end)),
        this.ha.history(trayIds, new Date(from), new Date(end), { attributes: true }),
      ]);
      const { jobs, current } = M.jobsFromHistory(p, { ...plain, ...withAttrs });
      // The printer reports a print stopped with Stop as failed; one this app
      // stopped is logged as stopped.
      for (const j of jobs) {
        if (j.result === 'failed' && this.stops.some(x => x.serial === p.serial && j.end >= x.t - 5000 && j.end <= x.t + 3 * MIN)) { j.result = 'stopped'; j.reason = null; }
      }
      if (jobs.length) { this.jobs = M.mergeJobs(this.jobs, jobs).slice(0, MAX_JOBS); changed = true; }
      this.current[p.serial] = current;
      // Next time, start from just before a job that's still going, else from now.
      const next = current ? current.start - 10 * MIN : end - 10 * MIN;
      if (next !== this.scanFrom[p.serial]) { this.scanFrom[p.serial] = next; changed = true; }
    }
    delete this.errors.history;
    if (changed) this.save();
  }

  start() {
    this.scan({ force: true });
    this.timer = setInterval(() => this.scan(), SCAN_EVERY);
    this.timer.unref?.();
    this.sampleEnergy();
    this.energyTimer = setInterval(() => this.sampleEnergy(), ENERGY_EVERY);
    this.energyTimer.unref?.();
  }

  stop() { clearInterval(this.timer); clearInterval(this.energyTimer); this.saveEnergy(); }

  // ---- energy ----------------------------------------------------------------------------

  loadEnergy() {
    const f = this.file('energy.json');
    if (!f) return;
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const k of ['days', 'jobs', 'series', 'last']) if (j[k] && typeof j[k] === 'object') this.energy[k] = j[k];
      if (Number.isFinite(j.since)) this.energy.since = j.since;
    } catch { /* first run */ }
  }

  saveEnergy() {
    const f = this.file('energy.json');
    if (!f) return;
    try { fs.writeFileSync(f + '.tmp', JSON.stringify(this.energy)); fs.renameSync(f + '.tmp', f); } catch (e) { console.warn('[print-log] could not save energy:', e.message); }
  }

  // Every 30 s: the printer's power, added up (trapezoids) into today and the
  // job in progress. A gap of more than two minutes (app restarted, Home
  // Assistant away) isn't filled in.
  async sampleEnergy() {
    let w;
    try { w = await this.world(25_000); } catch { return; }
    const now = this.now();
    const E = this.energy;
    if (!E.since) E.since = now;
    for (const p of w.printers) {
      const pw = M.power(p, w.stateOf, { sensor: this.powerSensor });
      if (pw.watts === null) continue;
      const last = E.last[p.serial];
      if (last && now - last.t <= 2 * MIN && now > last.t) {
        const wh = (last.w + pw.watts) / 2 * (now - last.t) / 3600_000;
        const day = M.localParts(now, w.timeZone).key;
        E.days[p.serial] = E.days[p.serial] || {};
        E.days[p.serial][day] = (E.days[p.serial][day] || 0) + wh;
        const lv = M.live(p, w.stateOf, this.current[p.serial]);
        const job = this.current[p.serial];
        if (job && lv.printing) E.jobs[job.id] = (E.jobs[job.id] || 0) + wh;
      }
      E.last[p.serial] = { t: now, w: pw.watts };
      const series = (E.series[p.serial] = E.series[p.serial] || []);
      series.push([now, pw.watts]);
      while (series.length && series[0][0] < now - 3 * 3600_000) series.shift();
    }
    // Keep 400 days and the 2000 newest jobs.
    for (const days of Object.values(E.days)) for (const k of Object.keys(days).sort().slice(0, -400)) delete days[k];
    const jobIds = Object.keys(E.jobs);
    if (jobIds.length > 2000) for (const k of jobIds.sort((a, b) => Number(a.split(':')[1]) - Number(b.split(':')[1])).slice(0, jobIds.length - 2000)) delete E.jobs[k];
    if (!this.lastEnergySave || now - this.lastEnergySave > 5 * MIN) { this.saveEnergy(); this.lastEnergySave = now; }
  }

  energyFor(p, w, now) {
    const pw = M.power(p, w.stateOf, { sensor: this.powerSensor });
    const price = this.pricePerKwh;
    const cost = wh => Math.round(wh / 1000 * price * 100) / 100;
    const days = this.energy.days[p.serial] || {};
    const today = M.localParts(now, w.timeZone);
    const month = Object.entries(days).filter(([k]) => k.startsWith(today.monthKey)).reduce((a, [, v]) => a + v, 0);
    const pm = today.m === 1 ? `${today.y - 1}-12` : `${today.y}-${String(today.m - 1).padStart(2, '0')}`;
    const lastMonth = Object.entries(days).filter(([k]) => k.startsWith(pm)).reduce((a, [, v]) => a + v, 0);
    const todayWh = days[today.key] || 0;
    const job = this.current[p.serial];
    const jobWh = job ? this.energy.jobs[job.id] || 0 : null;
    const ended = this.jobs.filter(j => j.printer === p.serial && j.end && this.energy.jobs[j.id]);
    const lastJob = ended[0] || null;
    const monthJobs = ended.filter(j => M.localParts(j.start, w.timeZone).monthKey === today.monthKey);
    const avg = monthJobs.length ? monthJobs.reduce((a, j) => a + this.energy.jobs[j.id], 0) / monthJobs.length : null;
    const series = (this.energy.series[p.serial] || []).filter(([t]) => t >= now - 2 * 3600_000);
    const r1 = x => Math.round(x * 10) / 10;
    return {
      ...pw, pricePerKwh: price, since: this.energy.since,
      costPerHour: pw.watts === null ? null : Math.round(pw.watts / 1000 * price * 1000) / 1000,
      today: { wh: r1(todayWh), cost: cost(todayWh) },
      month: { wh: r1(month), cost: cost(month) },
      lastMonth: { wh: r1(lastMonth), cost: cost(lastMonth) },
      job: job && jobWh !== null ? { name: job.name, wh: r1(jobWh), cost: cost(jobWh) } : null,
      lastJob: lastJob ? { name: lastJob.name, plate: lastJob.plate, end: lastJob.end, wh: r1(this.energy.jobs[lastJob.id]), cost: cost(this.energy.jobs[lastJob.id]) } : null,
      perPrint: avg === null ? null : { wh: r1(avg), cost: cost(avg) },
      series,
    };
  }

  // ---- snapshot for the page ------------------------------------------------------------

  async snapshot() {
    let w;
    try { w = await this.world(); } catch (e) {
      return { ready: false, error: e.message, version: process.env.APP_VERSION || 'dev' };
    }
    this.scan(); // in the background when due
    // A job that just ended shows up within a few seconds, not two minutes.
    let ended = null;
    for (const p of w.printers) {
      const st = w.stateOf.get(p.ent.print_status)?.state;
      if (this.current[p.serial] && st && !['prepare', 'running', 'pause', 'slicing', 'init', 'offline', 'unavailable', 'unknown'].includes(st)) ended = this.scan({ force: true });
      if (!this.current[p.serial] && ['prepare', 'running', 'pause'].includes(st) && this.now() - this.lastScan > 15_000) this.scan({ force: true });
    }
    if (ended) await Promise.race([ended, new Promise(r => setTimeout(r, 3000))]);
    const now = this.now();
    const jobs = this.jobs.map(j => {
      const wh = this.energy.jobs[j.id];
      return { ...j, cost: M.costOf(j, this.options), energyWh: wh ? Math.round(wh * 10) / 10 : null, energyCost: wh ? Math.round(wh / 1000 * this.pricePerKwh * 100) / 100 : null };
    });
    const printers = w.printers.map(p => {
      const current = this.current[p.serial] || null;
      const lv = M.live(p, w.stateOf, current);
      const units = M.units(p, w.stateOf).map(u => ({ ...u, spools: M.runOut(u.spools, this.jobs.filter(j => j.printer === p.serial), { now, lowGrams: this.lowGrams }) }));
      const filesReady = this.filesFor(p, lv)?.configured || false;
      return {
        serial: p.serial, name: p.name, model: p.model, firmware: p.firmware, live: lv, units,
        currentJob: current && lv.printing ? { ...current, cost: null } : null,
        controls: {
          pause: M.controlProblem(p, lv, 'pause', this), resume: M.controlProblem(p, lv, 'resume', this), stop: M.controlProblem(p, lv, 'stop', this),
          light: M.lightProblem(p, lv, this),
          start: M.startProblem(p, lv, { allowControls: this.allowControls, filesReady }),
        },
        files: filesReady,
        energy: this.energyFor(p, w, now),
      };
    });
    return {
      ready: true, version: process.env.APP_VERSION || 'dev', now, timeZone: w.timeZone,
      printers, jobs: jobs.slice(0, 300), jobCount: jobs.length,
      stats: M.stats(this.jobs, { now, timeZone: w.timeZone, options: this.options }),
      settings: { pricePerKwh: this.pricePerKwh, powerSensor: this.powerSensor || null, allowControls: this.allowControls, lowGrams: this.lowGrams, currencyPrices: (this.options.filament_prices || []).map(x => ({ material: String(x.material), perKg: Number(x.price_per_kg) })), defaultPerKg: M.priceFor(null, this.options) },
      thumbs: this.thumbIndex(),
      errors: this.errors,
    };
  }

  // ---- controls -----------------------------------------------------------------------

  async control(serial, action) {
    if (!['pause', 'resume', 'stop'].includes(action)) throw new UserError('Unknown action.');
    const w = await this.world(0);
    const p = this.printer(w, serial);
    const lv = M.live(p, w.stateOf, this.current[p.serial]);
    const problem = M.controlProblem(p, lv, action, this);
    if (problem) throw new UserError(problem, 409);
    console.log(`[print-log] ${action} on ${p.name}`);
    await this.ha.pressButton(lv.buttons[action].entity);
    if (action === 'stop') { this.stops = [...this.stops, { serial: p.serial, t: this.now() }].slice(-50); this.save(); }
    delete this.cache.states;
    return { ok: true };
  }

  async light(serial, on) {
    if (typeof on !== 'boolean') throw new UserError('Say whether to turn the light on or off.');
    const w = await this.world(0);
    const p = this.printer(w, serial);
    const lv = M.live(p, w.stateOf, this.current[p.serial]);
    const problem = M.lightProblem(p, lv, this);
    if (problem) throw new UserError(problem, 409);
    console.log(`[print-log] chamber light ${on ? 'on' : 'off'} on ${p.name}`);
    await this.ha.setLight(lv.light.entity, on);
    delete this.cache.states;
    this.camera.delete(p.serial);
    return { ok: true };
  }

  // ---- the printer's files -----------------------------------------------------------------

  filesFor(p, lv) {
    const code = String(this.options.printer_access_code || '').trim();
    const want = String(this.options.printer_serial || '').trim();
    if (!code) return null;
    if (want ? want.toUpperCase() !== p.serial.toUpperCase() : false) return null;
    const host = lv?.ip;
    if (!host || !/^[0-9a-fA-F:.]{3,45}$/.test(host)) return null;
    const key = `${p.serial}|${host}`;
    if (!this.filesClients.has(key)) this.filesClients.set(key, this.filesFactory({ host, accessCode: code, serial: p.serial }));
    return this.filesClients.get(key);
  }

  async filesContext(serial) {
    const w = await this.world();
    const p = this.printer(w, serial);
    const lv = M.live(p, w.stateOf, this.current[p.serial]);
    const client = this.filesFor(p, lv);
    if (!client) throw new UserError(this.options.printer_access_code ? 'The app doesn\'t know this printer\'s address, or the access code is for another printer.' : 'Add the printer\'s access code on the app\'s Configuration tab to use its files.', 409);
    if (!lv.online) throw new UserError('The printer is offline.', 409);
    return { w, p, lv, client };
  }

  async listFiles(serial, { force = false } = {}) {
    const { p, client } = await this.filesContext(serial);
    const hit = this.fileLists.get(p.serial);
    if (!force && hit && this.now() - hit.at < 60_000) return hit.files;
    const root = await client.list('/');
    let all = root.filter(f => !f.dir);
    if (root.some(f => f.dir && f.name === 'cache')) {
      try { all = all.concat((await client.list('/cache')).filter(f => !f.dir)); } catch { /* not readable */ }
    }
    const files = all.filter(f => /\.3mf$/i.test(f.name)).sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, 100)
      .map(f => ({ ...f, thumb: this.thumbFor(p.serial, f) }));
    this.fileLists.set(p.serial, { at: this.now(), files });
    return files;
  }

  async findFile(serial, filePath) {
    if (typeof filePath !== 'string' || !SAFE_PATH.test(filePath)) throw new UserError('That isn\'t a file on the printer.');
    let files = await this.listFiles(serial);
    let f = files.find(x => x.path === filePath);
    if (!f) { files = await this.listFiles(serial, { force: true }); f = files.find(x => x.path === filePath); }
    if (!f) throw new UserError('That file isn\'t on the printer any more.', 404);
    return f;
  }

  async download(serial, filePath, onStream) {
    const f = await this.findFile(serial, filePath);
    if (f.size > MAX_FILE) throw new UserError('That file is too big to download through Home Assistant.', 413);
    const { client } = await this.filesContext(serial);
    await client.download(f.path, (stream, size) => onStream(stream, size ?? f.size, f.name));
  }

  async upload(serial, name, req, length) {
    if (!FILE_NAME.test(String(name || '')) || name.startsWith('.')) throw new UserError('Send a sliced .3mf file (the name can\'t have / \\ : * ? " < > | in it).');
    if (!Number.isFinite(length) || length <= 0) throw new UserError('Empty upload.', 411);
    if (length > MAX_FILE) throw new UserError('That file is bigger than 512 MB.', 413);
    const { p, client } = await this.filesContext(serial);
    const target = '/' + name;
    // Check it's a zip (.3mf) from its first bytes before connecting to the printer.
    const first = await new Promise((resolve, reject) => {
      const onData = c => { cleanup(); req.pause(); resolve(c); };
      const onEnd = () => { cleanup(); resolve(Buffer.alloc(0)); };
      const onErr = e => { cleanup(); reject(e); };
      const cleanup = () => { req.off('data', onData); req.off('end', onEnd); req.off('error', onErr); };
      req.on('data', onData); req.once('end', onEnd); req.once('error', onErr);
    });
    if (first.length < 4 || first.readUInt32LE(0) !== 0x04034b50) { req.resume(); throw new UserError("That isn't a .3mf file."); }
    req.unshift(first);
    let seen = 0;
    const keep = length <= MAX_PARSE ? [] : null;
    const guard = new Transform({
      transform(chunk, _enc, cb) {
        seen += chunk.length;
        if (seen > length || seen > MAX_FILE) return cb(new UserError('The upload was bigger than it said.', 413));
        if (keep) keep.push(chunk);
        cb(null, chunk);
      },
    });
    let guardError = null;
    guard.on('error', e => { guardError = e; });
    req.on('aborted', () => guard.destroy(new UserError('The upload was cancelled.')));
    req.pipe(guard);
    console.log(`[print-log] sending ${name} (${Math.round(length / 1024)} KB) to ${p.name}`);
    await client.upload(target, guard);
    if (guardError) throw guardError;
    if (seen !== length) throw new UserError('The upload was cut short.');
    this.fileLists.delete(p.serial);
    let plan = null;
    if (keep) {
      try { plan = this.rememberPlan(p, { path: target, name, size: length, mtime: null }, threemf.parse(Buffer.concat(keep))); } catch { /* listed anyway */ }
    }
    return { ok: true, path: target, plan };
  }

  // What's in a file: its plates, and a suggested AMS slot for each filament.
  async plan(serial, filePath) {
    const f = await this.findFile(serial, filePath);
    const { w, p, client } = await this.filesContext(serial);
    const key = `${p.serial}|${f.path}|${f.size}`;
    let parsed = this.plans.get(key)?.parsed;
    if (!parsed) {
      if (f.size > MAX_PARSE) throw new UserError('That file is too big to read here. Start it from Bambu Studio or the printer.', 413);
      const buf = await client.downloadBuffer(f.path, MAX_PARSE);
      try { parsed = threemf.parse(buf); } catch (e) { throw new UserError(e.message); }
    }
    const plan = this.rememberPlan(p, f, parsed);
    const spools = M.units(p, w.stateOf).flatMap(u => u.spools);
    return { ...plan, spools: spools.map(s => ({ trayId: s.trayId, label: s.label, unit: s.unit, name: s.name, type: s.type, color: s.color, empty: s.empty, grams: s.grams })), plates: plan.plates.map(pl => ({ ...pl, mapping: M.suggestMapping(pl.filaments, spools) })) };
  }

  rememberPlan(p, f, parsed) {
    const key = `${p.serial}|${f.path}|${f.size}`;
    this.plans.set(key, { at: this.now(), parsed });
    while (this.plans.size > 8) this.plans.delete(this.plans.keys().next().value);
    const thumbs = {};
    for (const [plate, png] of Object.entries(parsed.thumbnails || {})) thumbs[plate] = this.saveThumb(p.serial, f, Number(plate), png);
    return { path: f.path, name: f.name, size: f.size, plates: parsed.plates.map(pl => ({ ...pl, thumb: thumbs[pl.index] || null })) };
  }

  // ---- start a print -------------------------------------------------------------------------

  async startPrint(serial, body) {
    const w = await this.world(0);
    const p = this.printer(w, serial);
    const lv = M.live(p, w.stateOf, this.current[p.serial]);
    const problem = M.startProblem(p, lv, { allowControls: this.allowControls, filesReady: Boolean(this.filesFor(p, lv)?.configured) });
    if (problem) throw new UserError(problem, 409);
    const plan = await this.plan(serial, body?.path);
    const plate = plan.plates.find(x => x.index === Number(body?.plate));
    if (!plate) throw new UserError('Pick a plate that\'s in the file.');
    const spools = M.units(p, w.stateOf).flatMap(u => u.spools);
    const valid = new Map(spools.filter(s => !s.empty).map(s => [s.trayId, s]));
    const given = Array.isArray(body?.mapping) ? body.mapping : [];
    const pairs = plate.filaments.map(f => {
      const m = given.find(x => Number(x?.filament) === f.id);
      const trayId = Number(m?.trayId);
      if (!valid.has(trayId)) throw new UserError(`Pick a loaded slot for filament ${f.id} (${f.type || 'filament'}).`);
      return { filament: f.id, trayId };
    });
    const useAms = pairs.some(x => x.trayId < 254);
    const data = {
      filepath: plan.path.replace(/^\/+/, ''), plate: plate.index,
      timelapse: body.timelapse === true, bed_leveling: body.bedLeveling !== false, flow_cali: body.flowCali === true,
      vibration_cali: false, layer_inspect: true, use_ams: useAms, ams_mapping: M.amsMapping(pairs),
    };
    console.log(`[print-log] starting ${plan.name} plate ${plate.index} on ${p.name} (slots ${data.ams_mapping})`);
    await this.ha.printProjectFile(p.deviceId, data);
    delete this.cache.states;
    setTimeout(() => this.scan({ force: true }), 20_000).unref?.();
    return { ok: true };
  }

  // ---- thumbnails and camera ---------------------------------------------------------------------

  thumbId(serial, f, plate) { return crypto.createHash('sha256').update(`${serial}|${f.path}|${f.size}|${plate}`).digest('hex').slice(0, 24); }

  saveThumb(serial, f, plate, png) {
    const id = this.thumbId(serial, f, plate);
    const dir = this.file('thumbs');
    if (!dir) { this.memThumbs = this.memThumbs || new Map(); this.memThumbs.set(id, png); }
    else {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, id + '.png');
        if (!fs.existsSync(file)) fs.writeFileSync(file, png);
        this.pruneThumbs(dir);
      } catch { return null; }
    }
    this.thumbNames = this.thumbNames || new Map();
    this.thumbNames.set(id, { serial, name: f.name, plate });
    this.saveThumbIndex();
    return id;
  }

  pruneThumbs(dir) {
    const files = fs.readdirSync(dir).filter(n => n.endsWith('.png')).map(n => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const f of files.slice(400)) fs.rmSync(path.join(dir, f.n), { force: true });
  }

  thumbFor(serial, f) {
    const id = this.thumbId(serial, f, 1);
    if (this.memThumbs?.has(id)) return id;
    const dir = this.file('thumbs');
    return dir && fs.existsSync(path.join(dir, id + '.png')) ? id : null;
  }

  saveThumbIndex() {
    const f = this.file('thumbs.json');
    if (!f) return;
    try { fs.writeFileSync(f, JSON.stringify([...this.thumbNames])); } catch { /* best effort */ }
  }

  // name (without .3mf) + plate -> thumbnail id, so the history can show pictures.
  thumbIndex() {
    if (!this.thumbNames) {
      this.thumbNames = new Map();
      const f = this.file('thumbs.json');
      if (f) { try { this.thumbNames = new Map(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch { /* none yet */ } }
    }
    const out = {};
    for (const [id, v] of this.thumbNames) out[`${v.serial}|${String(v.name).replace(/\.gcode\.3mf$|\.3mf$/i, '').toLowerCase()}|${v.plate}`] = id;
    return out;
  }

  thumb(id) {
    if (!/^[0-9a-f]{24}$/.test(id)) return null;
    if (this.memThumbs?.has(id)) return this.memThumbs.get(id);
    const dir = this.file('thumbs');
    try { return dir ? fs.readFileSync(path.join(dir, id + '.png')) : null; } catch { return null; }
  }

  async cameraImage(serial) {
    const w = await this.world();
    const p = this.printer(w, serial);
    if (!p.ent.camera_entity) throw new UserError('This printer has no camera in Home Assistant.', 404);
    const hit = this.camera.get(p.serial);
    if (hit && this.now() - hit.at < 3000) return hit.img;
    const img = await this.ha.cameraSnapshot(p.ent.camera_entity);
    this.camera.set(p.serial, { at: this.now(), img });
    return img;
  }

  status() {
    return { lastScan: this.lastScan ? new Date(this.lastScan).toISOString() : null, jobs: this.jobs.length, errors: this.errors };
  }
}

module.exports = { PrintLog, UserError, FtpError };
