'use strict';
// Pure functions: Home Assistant's registries, states and Recorder history in,
// printers, spools, jobs and statistics out. No I/O, so the tests can feed them
// made-up data.

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const GAP = new Set(['offline', 'unavailable', 'unknown', '']);
const ACTIVE = new Set(['prepare', 'running', 'pause', 'slicing', 'init']);
const ENDED = { finish: 'finished', failed: 'failed' };
const IDLE_LIKE = new Set(['idle', 'finish', 'failed']);

const num = v => { const n = Number(v); return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n; };
const good = s => s !== undefined && s !== null && !GAP.has(String(s));
const titleCase = s => String(s || '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

// ---- printers and their entities ------------------------------------------------

const NOT_PRINTERS = /^(AMS|External Spool|Creator profile)/i;

function printers({ entities = [], devices = [], states = [] }) {
  const stateOf = new Map(states.map(s => [s.entity_id, s]));
  const byDevice = new Map();
  for (const e of entities) {
    if (e.platform !== 'bambu_lab' || !e.device_id || e.disabled_by) continue;
    if (!byDevice.has(e.device_id)) byDevice.set(e.device_id, []);
    byDevice.get(e.device_id).push(e);
  }
  const ident = d => (d.identifiers || []).find(i => i[0] === 'bambu_lab')?.[1] || null;
  const out = [];
  for (const d of devices) {
    const serial = ident(d);
    if (!serial || d.via_device_id || NOT_PRINTERS.test(d.model || '')) continue;
    const ents = byDevice.get(d.id) || [];
    const tk = {};
    for (const e of ents) {
      const key = e.translation_key || e.unique_id?.split('_').slice(1).join('_');
      if (!key) continue;
      const domain = e.entity_id.split('.')[0];
      // camera.* and switch.* share the "camera" key; keep them apart.
      const k = domain === 'camera' ? 'camera_entity' : domain === 'button' ? `button_${key}` : key;
      if (domain === 'switch' && key === 'camera') continue;
      if (!tk[k]) tk[k] = e.entity_id;
    }
    if (!tk.print_status) continue;
    const name = stateOf.get(tk.printer_name)?.state;
    const units = [];
    for (const child of devices.filter(c => c.via_device_id === d.id)) {
      const cEnts = byDevice.get(child.id) || [];
      const nm = child.name_by_user || child.name || '';
      const ams = nm.match(/_AMS_(\d+)$/);
      const ext = nm.match(/_ExternalSpool(\d*)$/);
      if (ams) {
        const n = Number(ams[1]);
        const id = n >= 128 ? n : n - 1;
        const ck = {};
        for (const e of cEnts) if (e.translation_key && e.translation_key !== 'tray') ck[e.translation_key] = e.entity_id;
        const trays = cEnts.filter(e => e.translation_key === 'tray').map(e => ({ entity: e.entity_id, slot: Number(e.unique_id?.match(/_tray_(\d+)$/)?.[1]) || 1 })).sort((a, b) => a.slot - b.slot);
        units.push({ kind: id >= 128 ? 'ht' : 'ams', id, model: child.model || 'AMS', ent: ck, trays });
      } else if (ext) {
        const e = cEnts.find(x => x.translation_key === 'external_spool');
        if (e) units.push({ kind: 'ext', id: ext[1] ? 255 : 254, model: 'External spool', ent: {}, trays: [{ entity: e.entity_id, slot: 1 }], extIndex: ext[1] ? Number(ext[1]) : 1 });
      }
    }
    units.sort((a, b) => (a.kind === 'ext') - (b.kind === 'ext') || a.id - b.id);
    const htCount = units.filter(u => u.kind === 'ht').length;
    for (const u of units) {
      if (u.kind === 'ams') u.label = `AMS ${u.id + 1}`;
      else if (u.kind === 'ht') u.label = htCount > 1 ? `AMS HT ${u.id - 127}` : 'AMS HT';
      else u.label = u.extIndex > 1 ? 'External spool 2' : 'External spool';
      for (const t of u.trays) {
        if (u.kind === 'ams') { t.label = `${'ABCDEFGH'[u.id] || u.id + 1}${t.slot}`; t.trayId = u.id * 4 + (t.slot - 1); }
        else if (u.kind === 'ht') { t.label = htCount > 1 ? `HT${u.id - 127}` : 'HT'; t.trayId = u.id; }
        else { t.label = u.extIndex > 1 ? 'Ext 2' : 'Ext'; t.trayId = u.id; }
        t.unit = u.label;
      }
    }
    out.push({ deviceId: d.id, serial, name: good(name) ? name : (d.name_by_user || d.name || serial), model: d.model || 'Bambu Lab printer', firmware: d.sw_version || null, ent: tk, units });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const trayEntities = p => p.units.flatMap(u => u.trays.map(t => ({ ...t, kind: u.kind })));

// ---- spools ---------------------------------------------------------------------

function spoolFromAttrs(a = {}, tray) {
  const color = String(a.color || '').match(/^#?([0-9a-f]{6})/i);
  const remain = a.remain_enabled !== false && num(a.remain) !== null && num(a.remain) >= 0 ? num(a.remain) : null;
  const trayWeight = num(a.tray_weight) || 1000;
  const empty = a.empty === true || !a.type;
  const tag = a.tag_uid && !/^0+$/.test(a.tag_uid) ? String(a.tag_uid) : null;
  return {
    label: tray.label, unit: tray.unit, trayId: tray.trayId, entity: tray.entity,
    name: empty ? null : String(a.name || a.type || 'Filament').slice(0, 60),
    type: empty ? null : String(a.type || '').slice(0, 24) || null,
    color: color ? '#' + color[1].toUpperCase() : null,
    remain, trayWeight, grams: remain === null ? null : Math.round(remain / 100 * trayWeight),
    empty, active: a.active === true, key: tag || `${tray.label}`,
    dryTemp: num(a.dry_temp), dryHours: num(a.dry_time),
  };
}

function units(p, stateOf) {
  return p.units.map(u => {
    const s = k => stateOf.get(u.ent[k]);
    const drying = s('drying')?.state === 'on';
    return {
      label: u.label, kind: u.kind, model: u.model,
      humidity: num(s('humidity')?.state), humidityIndex: num(s('humidity_index')?.state),
      temperature: num(s('ams_temp')?.state), drying,
      dryingLeftMin: drying ? Math.round((num(s('remaining_drying_time')?.state) || 0) * (s('remaining_drying_time')?.attributes?.unit_of_measurement === 'min' ? 1 : 60)) : null,
      spools: u.trays.map(t => spoolFromAttrs(stateOf.get(t.entity)?.attributes, t)),
    };
  });
}

// ---- jobs from Recorder history ---------------------------------------------------

// History rows -> [{ t, s, a }] in time order; attributes carried forward,
// since a row may only hold what changed.
function rows(list = []) {
  let prev = {};
  return list.map(r => {
    const a = r.a ? { ...prev, ...r.a } : prev;
    prev = a;
    return { t: Math.round((r.lu ?? r.lc ?? 0) * 1000), s: r.s, a };
  }).sort((x, y) => x.t - y.t);
}

// Last good value at or before t.
function at(list, t) {
  let v = null;
  for (const r of list) { if (r.t > t) break; if (good(r.s)) v = r; }
  return v;
}
// Values inside [a, b].
const within = (list, a, b) => list.filter(r => r.t >= a && r.t <= b && good(r.s));
const lastIn = (list, a, b) => { const w = within(list, a, b); return w.length ? w[w.length - 1].s : null; };
const maxIn = (list, a, b) => within(list, a, b).reduce((m, r) => Math.max(m, num(r.s) ?? -Infinity), -Infinity);

function plateOf(gcode) {
  const m = String(gcode || '').match(/plate_(\d+)\.gcode/);
  return m ? Number(m[1]) : null;
}

const prettyName = n => String(n || '').replace(/\.gcode(\.3mf)?$|\.3mf$/i, '').replace(/_plate_\d+$/i, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

// Finds the jobs in a printer's history. `h` maps entity ids to raw history
// rows. Returns { jobs, current } where current is a job still running at the
// end of the history, or null.
function jobsFromHistory(p, h) {
  const R = {};
  for (const [k, id] of Object.entries(p.ent)) if (h[id]) R[k] = rows(h[id]);
  const status = R.print_status || [];
  const trays = trayEntities(p).map(t => ({ ...t, rows: rows(h[t.entity] || []) }));
  const jobs = [];
  let open = null;
  const close = (end, result) => {
    jobs.push(describe(p, R, trays, open.start, end, result));
    open = null;
  };
  for (const r of status) {
    const s = String(r.s);
    if (GAP.has(s)) continue;
    if (ACTIVE.has(s)) { if (!open) open = { start: r.t }; continue; }
    if (!open) continue;
    if (ENDED[s]) close(r.t, ENDED[s]);
    else if (s === 'idle') close(r.t, 'stopped');
  }
  const current = open ? describe(p, R, trays, open.start, null, 'running') : null;
  return { jobs, current };
}

function describe(p, R, trays, start, end, result) {
  const until = end ?? Date.now();
  const g = k => R[k] || [];
  const startSensor = Date.parse(lastIn(g('start_time'), start - 2 * MIN, start + 10 * MIN) || '');
  const realStart = Number.isFinite(startSensor) && Math.abs(startSensor - start) < 15 * MIN ? Math.min(startSensor, start) : start;
  // The value set during the job, else the one it started with (printing the
  // same file again doesn't record the name again).
  const val = (k, from) => lastIn(g(k), from, until) ?? at(g(k), start)?.s ?? null;
  const name = val('subtask_name', start - 2 * MIN);
  const gcode = val('gcode_file', start - 2 * MIN);
  const planned = num(val('print_weight', start - MIN));
  const meters = num(val('print_length', start - MIN));
  const layers = num(val('total_layers', start - MIN));
  const layerReached = maxIn(g('current_layer'), start, until);
  const progress = maxIn(g('print_progress'), start, until);
  const finished = result === 'finished';
  const pct = finished ? 100 : progress > -Infinity ? progress : layers && layerReached > 0 ? Math.round(layerReached / layers * 100) : null;
  const grams = planned === null ? null : finished ? planned : pct === null ? null : Math.round(planned * pct) / 100;

  // Why it stopped: the last stage before the end, if it says (paused_…).
  let reason = null;
  if (result === 'failed' || result === 'stopped') {
    const stages = within(g('stage'), start, until).map(r => String(r.s));
    const telling = stages.reverse().find(s => s.startsWith('paused_') || s === 'm400_pause');
    if (telling) reason = titleCase(telling.replace(/^paused_/, '')).replace(/\bAms\b/, 'AMS');
  }

  // Filament per slot: how long each tray was the one feeding, else each
  // spool's drop in "remain" (the AMS's level estimate jumps around, so it's
  // only the fallback); scaled so the slots add up to the job.
  const slots = [];
  for (const t of trays) {
    const a0 = at(t.rows, start)?.a, a1 = at(t.rows, until)?.a || a0;
    if (!a0 && !a1) continue;
    const info = spoolFromAttrs(a1 || a0, t);
    const r0 = num(a0?.remain), r1 = num(a1?.remain);
    const drop = r0 !== null && r1 !== null && r0 >= 0 && r1 >= 0 && r0 > r1 ? (r0 - r1) / 100 * info.trayWeight : 0;
    let activeMs = 0;
    const span = [{ t: start, a: at(t.rows, start)?.a || {} }, ...t.rows.filter(r => r.t > start && r.t < until), { t: until, a: null }];
    for (let i = 0; i < span.length - 1; i++) if (span[i].a?.active === true) activeMs += span[i + 1].t - span[i].t;
    if (drop > 0 || activeMs > 0) slots.push({ label: t.label, color: info.color, type: info.type, name: info.name, key: info.key, drop, activeMs });
  }
  const dropSum = slots.reduce((a, s) => a + s.drop, 0), activeSum = slots.reduce((a, s) => a + s.activeMs, 0);
  const used = slots.map(s => {
    const share = activeSum > 0 ? s.activeMs / activeSum : dropSum > 0 ? s.drop / dropSum : 0;
    return { label: s.label, color: s.color, type: s.type, name: s.name, key: s.key, grams: grams === null ? Math.round(s.drop * 10) / 10 : Math.round(grams * share * 10) / 10 };
  }).filter(s => s.grams > 0 || (grams === null && s.drop > 0)).sort((a, b) => b.grams - a.grams);

  return {
    id: `${p.serial}:${Math.round(realStart / 1000)}`,
    printer: p.serial,
    name: prettyName(name) || prettyName(gcode) || 'Print',
    task: name ? String(name).slice(0, 200) : null,
    plate: plateOf(gcode) || plateOf(name && name + '.gcode'),
    start: realStart, end, seconds: end ? Math.round((end - realStart) / 1000) : null,
    result, progress: pct, layers, layerReached: layerReached > 0 ? layerReached : null,
    grams, plannedGrams: planned, meters,
    bed: lastIn(g('print_bed_type'), start - MIN, until),
    speed: lastIn(g('speed_profile'), start, until),
    reason, slots: used,
  };
}

// Merges freshly found jobs into the stored ones (same id, or same printer
// and a start within two minutes, is the same job).
function mergeJobs(stored, found) {
  const out = stored.slice();
  for (const j of found) {
    const i = out.findIndex(o => o.id === j.id || (o.printer === j.printer && Math.abs(o.start - j.start) < 2 * MIN));
    if (i >= 0) out[i] = { ...out[i], ...j, id: out[i].id };
    else out.push(j);
  }
  return out.sort((a, b) => b.start - a.start);
}

// ---- money and statistics ---------------------------------------------------------

function priceFor(type, options) {
  const t = String(type || '').toUpperCase();
  const list = Array.isArray(options.filament_prices) ? options.filament_prices : [];
  const exact = list.find(x => String(x.material || '').toUpperCase() === t);
  const loose = exact || list.find(x => t && t.startsWith(String(x.material || '').toUpperCase()));
  const v = num(loose?.price_per_kg);
  return v ?? (num(options.default_price_per_kg) ?? 20);
}

function costOf(job, options) {
  if (job.grams === null || job.grams === undefined) return null;
  if (job.slots?.length) {
    const sum = job.slots.reduce((a, s) => a + s.grams, 0);
    let c = job.slots.reduce((a, s) => a + s.grams * priceFor(s.type, options) / 1000, 0);
    if (job.grams > sum) c += (job.grams - sum) * priceFor(null, options) / 1000;
    return Math.round(c * 100) / 100;
  }
  return Math.round(job.grams * priceFor(null, options) / 10) / 100;
}

// Local calendar parts in Home Assistant's time zone.
function localParts(t, timeZone) {
  // formatToParts, not a formatted string: Node's ICU data in the container may
  // not have the locale, and a fallback locale orders the date differently.
  let y, m, d;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(t));
    const get = type => Number(parts.find(p => p.type === type)?.value);
    [y, m, d] = [get('year'), get('month'), get('day')];
  } catch { /* unknown time zone */ }
  if (![y, m, d].every(Number.isFinite)) { const dt = new Date(t); [y, m, d] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()]; }
  const key = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { y, m, d, key, monthKey: key.slice(0, 7) };
}

function stats(jobs, { now = Date.now(), timeZone = 'UTC', options = {} } = {}) {
  const thisMonth = localParts(now, timeZone).monthKey;
  const pm = localParts(now, timeZone);
  const lastMonth = `${pm.m === 1 ? pm.y - 1 : pm.y}-${String(pm.m === 1 ? 12 : pm.m - 1).padStart(2, '0')}`;
  const sum = list => {
    const done = list.filter(j => j.result === 'finished').length;
    const failed = list.filter(j => j.result !== 'finished').length;
    const grams = list.reduce((a, j) => a + (j.grams || 0), 0);
    const wasted = list.filter(j => j.result !== 'finished').reduce((a, j) => a + (j.grams || 0), 0);
    const seconds = list.reduce((a, j) => a + (j.seconds || 0), 0);
    const cost = list.reduce((a, j) => a + (costOf(j, options) || 0), 0);
    const meters = list.reduce((a, j) => a + (j.result === 'finished' ? j.meters || 0 : (j.meters || 0) * (j.progress ?? 0) / 100), 0);
    return { prints: list.length, finished: done, failed, successRate: list.length ? Math.round(done / list.length * 100) : null, grams: Math.round(grams), wasted: Math.round(wasted), hours: Math.round(seconds / 360) / 10, cost: Math.round(cost * 100) / 100, meters: Math.round(meters) };
  };
  const ended = jobs.filter(j => j.end);
  const month = ended.filter(j => localParts(j.start, timeZone).monthKey === thisMonth);
  const prev = ended.filter(j => localParts(j.start, timeZone).monthKey === lastMonth);

  // Grams per day for the last 30 days, and per material.
  const days = [];
  for (let i = 29; i >= 0; i--) days.push({ key: localParts(now - i * DAY, timeZone).key, ok: 0, failed: 0 });
  const dayIndex = new Map(days.map((d, i) => [d.key, i]));
  const materials = new Map();
  for (const j of ended) {
    if (j.start < now - 31 * DAY) continue;
    const i = dayIndex.get(localParts(j.start, timeZone).key);
    if (i === undefined) continue;
    days[i][j.result === 'finished' ? 'ok' : 'failed'] += j.grams || 0;
    const slotSum = (j.slots || []).reduce((a, s) => a + s.grams, 0);
    for (const s of j.slots || []) materials.set(s.type || 'Other', (materials.get(s.type || 'Other') || 0) + s.grams);
    if ((j.grams || 0) > slotSum + 0.5) materials.set('Other', (materials.get('Other') || 0) + (j.grams - slotSum));
  }
  for (const d of days) { d.ok = Math.round(d.ok); d.failed = Math.round(d.failed); }
  const mats = [...materials].map(([type, grams]) => ({ type, grams: Math.round(grams) })).filter(m => m.grams > 0).sort((a, b) => b.grams - a.grams);

  const all = sum(ended);
  const longest = ended.reduce((m, j) => Math.max(m, j.seconds || 0), 0);
  const counts = new Map();
  for (const j of ended) counts.set(j.name, (counts.get(j.name) || 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  return {
    month: { key: thisMonth, ...sum(month) }, lastMonth: { key: lastMonth, ...sum(prev) },
    days, materials: mats,
    lifetime: { ...all, longestSeconds: longest, mostPrinted: top && top[1] > 1 ? { name: top[0], count: top[1] } : null, since: ended.length ? ended[ended.length - 1].start : null },
  };
}

// When each loaded spool will run out at the last 30 days' pace.
function runOut(spools, jobs, { now = Date.now(), lowGrams = 150 } = {}) {
  const used = new Map();
  for (const j of jobs) {
    if (!j.end || j.start < now - 30 * DAY) continue;
    for (const s of j.slots || []) used.set(s.key, (used.get(s.key) || 0) + s.grams);
  }
  const prints = new Map();
  for (const j of jobs) if (j.end && j.start >= now - 30 * DAY) for (const s of j.slots || []) prints.set(s.key, (prints.get(s.key) || 0) + 1);
  return spools.map(s => {
    const month = Math.round(used.get(s.key) || 0);
    const perDay = month / 30;
    const daysLeft = s.grams !== null && perDay > 0 ? s.grams / perDay : null;
    const perPrint = prints.get(s.key) ? month / prints.get(s.key) : null;
    const low = !s.empty && s.grams !== null && (s.grams < lowGrams || (daysLeft !== null && daysLeft < 14));
    return { ...s, usedMonth: month, perPrint: perPrint ? Math.round(perPrint) : null, daysLeft: daysLeft === null ? null : Math.round(daysLeft), runsOut: daysLeft === null ? null : now + daysLeft * DAY, printsLeft: perPrint && s.grams !== null ? Math.floor(s.grams / perPrint) : null, low };
  });
}

// ---- what's happening now ---------------------------------------------------------

function live(p, stateOf, current) {
  const s = k => stateOf.get(p.ent[k]);
  const v = k => { const st = s(k); return st && good(st.state) ? st.state : null; };
  const n = k => num(v(k));
  const status = v('print_status') || (s('print_status') ? String(s('print_status').state) : 'unknown');
  const online = s('online') ? s('online').state === 'on' : status !== 'offline';
  const active = trayEntities(p).map(t => ({ t, a: stateOf.get(t.entity)?.attributes })).find(x => x.a?.active === true);
  const remainingH = n('remaining_time');
  const btn = k => { const id = p.ent[`button_${k}`]; return id ? { entity: id, available: stateOf.get(id) ? stateOf.get(id).state !== 'unavailable' : false } : null; };
  const temp = (k, tk) => ({ now: n(k), target: n(tk) });
  const dual = Boolean(p.ent.left_nozzle_temp);
  return {
    status, online, printing: ACTIVE.has(status), idle: IDLE_LIKE.has(status),
    stage: v('stage') && v('stage') !== 'idle' ? titleCase(v('stage')).replace(/\bAms\b/, 'AMS') : null,
    name: current?.name || prettyName(v('subtask_name')) || null,
    plate: current?.plate || plateOf(v('gcode_file')),
    progress: n('print_progress'), layer: n('current_layer'), layers: n('total_layers'),
    remainingMin: remainingH === null ? null : Math.round(remainingH * (s('remaining_time')?.attributes?.unit_of_measurement === 'min' ? 1 : 60)),
    endsAt: Date.parse(v('end_time') || '') || null,
    startedAt: current?.start || Date.parse(v('start_time') || '') || null,
    grams: n('print_weight'),
    nozzles: dual
      ? [{ label: 'Left nozzle', ...temp('left_nozzle_temp', 'left_target_nozzle_temp') }, { label: 'Right nozzle', ...temp('right_nozzle_temp', 'right_target_nozzle_temp') }]
      : [{ label: 'Nozzle', ...temp('nozzle_temp', 'target_nozzle_temp') }],
    activeNozzle: v('active_nozzle'),
    bed: temp('bed_temp', 'target_bed_temp'),
    chamber: temp('chamber_temp', 'target_chamber_temp'),
    door: s('door_open') ? (s('door_open').state === 'on' ? 'open' : 'closed') : null,
    nozzle: { size: n('left_nozzle_diameter') ?? n('nozzle_diameter'), type: v('left_nozzle_type') || v('nozzle_type'), rightSize: n('right_nozzle_diameter'), rightType: v('right_nozzle_type') },
    plateType: v('print_bed_type'),
    feeding: active ? spoolFromAttrs(active.a, active.t) : null,
    error: s('print_error')?.state === 'on' || s('hms_errors')?.state === 'on',
    hmsCount: num(s('hms_errors')?.attributes?.Count) || 0,
    camera: p.ent.camera_entity ? stateOf.get(p.ent.camera_entity)?.state !== 'unavailable' : false,
    lanMode: s('developer_lan_mode') ? s('developer_lan_mode').state === 'on' : null,
    controlBlocked: s('hybrid_mode_blocks_control')?.state === 'on',
    buttons: { pause: btn('pause'), resume: btn('resume'), stop: btn('stop') },
    ip: v('ip_address'),
  };
}

// Why a control can't be used, or null when it can.
function controlProblem(p, lv, action, { allowControls }) {
  if (!allowControls) return 'Printer controls are off in the app\'s Configuration tab.';
  if (!lv.online) return 'The printer is offline.';
  const b = lv.buttons[action];
  if (!b) {
    return lv.lanMode === false
      ? 'Turn on Developer LAN mode on the printer so it accepts commands from Home Assistant.'
      : 'The printer doesn\'t accept commands from Home Assistant yet (its firmware asks for signed commands). Turn on Developer LAN mode on the printer.';
  }
  if (!b.available) return { pause: 'Only while printing.', resume: 'Only while paused.', stop: 'Only while printing or paused.' }[action];
  return null;
}

function startProblem(p, lv, { allowControls, filesReady }) {
  if (!allowControls) return 'Printer controls are off in the app\'s Configuration tab.';
  if (!filesReady) return 'Add the printer\'s access code on the app\'s Configuration tab.';
  if (!lv.online) return 'The printer is offline.';
  if (!lv.idle) return 'Start unlocks when the printer is idle.';
  if (!p.ent.button_stop && lv.lanMode === false) return 'Turn on Developer LAN mode on the printer so it accepts commands from Home Assistant.';
  return null;
}

// Best tray for each project filament: same type and nearest colour.
function suggestMapping(filaments, spools) {
  const rgb = c => { const m = String(c || '').match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i); return m ? m.slice(1).map(x => parseInt(x, 16)) : null; };
  const dist = (a, b) => { const x = rgb(a), y = rgb(b); return x && y ? Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) : 500; };
  const loaded = spools.filter(s => !s.empty && s.trayId !== undefined);
  const used = new Set();
  return filaments.map(f => {
    const same = loaded.filter(s => String(s.type || '').toUpperCase() === String(f.type || '').toUpperCase());
    const pool = (same.length ? same : loaded).slice().sort((a, b) => (used.has(a.trayId) - used.has(b.trayId)) || dist(a.color, f.color) - dist(b.color, f.color));
    const pick = pool[0] || null;
    if (pick) used.add(pick.trayId);
    return { filament: f.id, trayId: pick ? pick.trayId : null, sameType: Boolean(same.length) };
  });
}

// The ams_mapping string the printer wants: one tray id per project filament
// (by index, 1-based ids), -1 for filaments the plate doesn't use.
function amsMapping(pairs) {
  const maxId = pairs.reduce((m, x) => Math.max(m, x.filament), 0);
  const arr = Array.from({ length: maxId }, () => -1);
  for (const x of pairs) arr[x.filament - 1] = x.trayId;
  return arr.join(',');
}

module.exports = {
  printers, units, spoolFromAttrs, jobsFromHistory, mergeJobs, rows, stats, runOut, live, costOf, priceFor,
  controlProblem, startProblem, suggestMapping, amsMapping, prettyName, trayEntities, localParts, DAY, HOUR, MIN,
};
