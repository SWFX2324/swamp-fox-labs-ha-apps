'use strict';
// Preloaded into the server (node --require) for the end-to-end tests, the
// container smoke test and local previews. Stands in for Home Assistant's
// WebSocket and REST APIs (with the Bambu Lab integration) and for the
// printer's FTPS file storage, so nothing real is touched. Any other outside
// request is refused and logged as UNMOCKED.
//
// The made-up workshop has one dual-nozzle printer with an AMS (four PLA
// spools) and an AMS HT (one PETG spool), and 30 days of jobs.
//
// FAKE_WORLD can hold several comma-separated switches:
//   idle        nothing printing (the default is a print 40% done)
//   paused      the current print is paused
//   offline     the printer is offline
//   no_lan      Developer LAN mode off: no Pause/Resume/Stop buttons
//   no_code     no access code configured (no file features)
//   no_ams      no AMS units, external spool only
//   empty       no history at all
//   many_files  a dozen more files on the printer (to scroll the list)
//   ha_down     Home Assistant refuses the WebSocket connection
// FAKE_WORLD_LOG=1 logs each request.

const net = require('net');
const zlib = require('zlib');

function fakeWorldSetting() {
  if (process.env.FAKE_WORLD !== undefined) return process.env.FAKE_WORLD;
  for (const dir of ['/run/s6/container_environment', '/var/run/s6/container_environment']) {
    try { return require('fs').readFileSync(`${dir}/FAKE_WORLD`, 'utf8').trim(); } catch { /* not there */ }
  }
  return '';
}
const switches = new Set(String(fakeWorldSetting()).split(',').map(s => s.trim()).filter(Boolean));
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const log = (...a) => { if (process.env.FAKE_WORLD_LOG) console.log('[fake]', ...a); };
const iso = t => new Date(t).toISOString();
const T0 = Date.now();
const ACCESS_CODE = 'fake-access-code';

process.env.SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN || 'fake-token';
process.env.HA_WS_URL = 'ws://fake-supervisor/core/websocket';
process.env.HA_REST_URL = 'http://fake-supervisor/core/api';
if (!process.env.OPTIONS_JSON) {
  process.env.OPTIONS_JSON = JSON.stringify({
    allow_controls: true, printer_access_code: switches.has('no_code') ? '' : ACCESS_CODE, printer_serial: '', low_spool_grams: 150, default_price_per_kg: 20,
    filament_prices: [{ material: 'PLA', price_per_kg: 19.99 }, { material: 'PETG', price_per_kg: 21.99 }],
  });
}

// ---- registries and states ------------------------------------------------------------

const SERIAL = '09400A000000001';
const P = 'workshop_h2d';
const devices = [], entities = [], states = [];
const calls = [];

const printer = { id: 'dev_printer', name: `H2D_${SERIAL}`, name_by_user: null, model: 'H2D', manufacturer: 'Bambu Lab', sw_version: '01.03.00.00', via_device_id: null, identifiers: [['bambu_lab', SERIAL]] };
devices.push(printer);
const amsDev = { id: 'dev_ams1', name: `H2D_${SERIAL}_AMS_1`, model: 'AMS 2 Pro', manufacturer: 'Bambu Lab', via_device_id: printer.id, identifiers: [['bambu_lab', 'AMSFAKE0001']] };
const htDev = { id: 'dev_ams128', name: `H2D_${SERIAL}_AMS_128`, model: 'AMS HT', manufacturer: 'Bambu Lab', via_device_id: printer.id, identifiers: [['bambu_lab', 'AMSFAKE0128']] };
const extDev = { id: 'dev_ext', name: `H2D_${SERIAL}_ExternalSpool`, model: 'External Spool', manufacturer: 'Bambu Lab', via_device_id: printer.id, identifiers: [['bambu_lab', `${SERIAL}_ExternalSpool`]] };
if (!switches.has('no_ams')) devices.push(amsDev, htDev);
devices.push(extDev);
// Another bambu_lab device that isn't a printer.
devices.push({ id: 'dev_mw', name: 'MakerWorld (someone)', model: 'Creator profile', manufacturer: 'MakerWorld', via_device_id: null, identifiers: [['bambu_lab', 'makerworld_u_1']] });

function entity(dev, entity_id, tk, state, attributes = {}, { unique = tk, changedAgo = 3 * HOUR } = {}) {
  entities.push({ entity_id, platform: 'bambu_lab', device_id: dev.id, translation_key: tk, unique_id: `${SERIAL}_${unique}`, disabled_by: null });
  states.push({ entity_id, state: String(state), attributes, last_changed: iso(T0 - changedAgo), last_updated: iso(T0 - changedAgo) });
}
const st = id => states.find(s => s.entity_id === id);
// Recorder: state changes made by service calls are added to the history too.
const setState = (id, state, attrs) => { const s = st(id); if (!s) return; s.state = String(state); if (attrs) s.attributes = { ...s.attributes, ...attrs }; s.last_updated = iso(Date.now()); if (hist[id]) hist[id].push(hist[id][0]?.a ? { s: String(state), a: s.attributes, lu: Date.now() / 1000 } : { s: String(state), lu: Date.now() / 1000 }); };

const printing = !switches.has('idle') && !switches.has('offline');
const status = switches.has('offline') ? 'offline' : switches.has('paused') ? 'pause' : printing ? 'running' : 'idle';

// Spools (made up). remain is a percentage of a 1000 g spool.
const SPOOLS = [
  { dev: amsDev, slot: 1, name: 'Bambu PLA Basic', type: 'PLA', color: '#FFFFFFFF', tag: 'AA00000000000001', remain: 64 },
  { dev: amsDev, slot: 2, name: 'Bambu PLA Basic', type: 'PLA', color: '#161616FF', tag: 'AA00000000000002', remain: 23 },
  { dev: amsDev, slot: 3, name: 'Bambu PLA Matte', type: 'PLA', color: '#00AE42FF', tag: 'AA00000000000003', remain: 91 },
  { dev: amsDev, slot: 4, name: 'Generic PLA', type: 'PLA', color: '#F4EE2AFF', tag: '0000000000000000', remain: -1 },
  { dev: htDev, slot: 1, name: 'Bambu PETG HF', type: 'PETG', color: '#8E9089FF', tag: 'AA00000000000005', remain: 78 },
];
const trayId = sp => sp.dev === htDev ? `sensor.${P}_ams_128_tray_1` : `sensor.${P}_ams_1_tray_${sp.slot}`;
const trayAttrs = (sp, extra = {}) => ({
  slot: sp.slot, color: sp.color, name: sp.name, type: sp.type, remain: sp.remain, remain_enabled: sp.remain >= 0, tray_weight: '1000',
  tag_uid: sp.tag, empty: false, active: false, dry_temp: sp.type === 'PETG' ? '65' : '55', dry_time: '8', friendly_name: 'Tray', ...extra,
});

// ---- 30 days of made-up jobs ----------------------------------------------------------------

const JOBS = [
  // [days ago, start hour, minutes, grams, name, plate, result, spool slots (index into SPOOLS), stage before failure]
  [29, 9, 95, 48, 'Desk cable clips', 1, 'finish', [1]],
  [28, 19, 210, 132, 'Gridfinity 2x3 bins', 1, 'finish', [0, 1]],
  [26, 8, 44, 21, 'Phone stand', 1, 'finish', [2]],
  [25, 20, 380, 240, 'Plant pot with saucer', 1, 'finish', [2, 0]],
  [23, 13, 18, 6, 'Calibration cube', 1, 'failed', [1], 'paused_first_layer_error'],
  [23, 14, 25, 8, 'Calibration cube', 1, 'finish', [1]],
  [21, 10, 160, 96, 'Headphone hook', 1, 'finish', [1]],
  [19, 18, 520, 310, 'Garden hose guide', 1, 'finish', [4]],
  [17, 9, 75, 38, 'Light switch cover', 1, 'finish', [0]],
  [16, 21, 140, 64, 'Spice rack labels', 2, 'finish', [0, 1, 2]],
  [14, 7, 260, 155, 'Drawer organiser', 1, 'finish', [1, 3]],
  [12, 16, 95, 52, 'Shelf bracket', 1, 'failed', [4], 'paused_nozzle_clog'],
  [12, 19, 105, 57, 'Shelf bracket', 1, 'finish', [4]],
  [10, 11, 35, 15, 'Keychain tags', 3, 'finish', [0, 2, 3]],
  [8, 15, 300, 188, 'Monitor riser feet', 1, 'finish', [1]],
  [6, 20, 70, 33, 'Cable clips', 1, 'finish', [1]],
  [4, 10, 210, 120, 'Gridfinity 2x3 bins', 1, 'finish', [0, 1]],
  [2, 18, 55, 24, 'Earbud case', 1, 'stopped', [2]],
  [1, 9, 130, 71, 'Planter drip tray', 1, 'finish', [2, 0]],
];
const CURRENT = { name: 'Workbench pegboard hooks', plate: 1, minutes: 190, grams: 142, slots: [1, 4], startedAgo: 75 * MIN };

const hist = {};
const add = (id, t, s, a) => { (hist[id] = hist[id] || []).push(a ? { s: String(s), a, lu: t / 1000 } : { s: String(s), lu: t / 1000 }); };
const ENTITY_FOR = { subtask_name: 'task_name', gcode_file: 'gcode_filename', total_layers: 'total_layer_count', stage: 'current_stage' };
const E = k => `sensor.${P}_${ENTITY_FOR[k] || k}`;
const remain = SPOOLS.map(s => (s.remain >= 0 ? s.remain : null));
// Work backwards from today's levels: earlier jobs had more filament.
const used = SPOOLS.map(() => 0);
const jobs = switches.has('empty') ? [] : JOBS;
for (const j of jobs) j[7].forEach((si, k) => { used[si] += j[3] * (k === 0 ? 0.7 : 0.3 / Math.max(1, j[7].length - 1)); });
if (printing) CURRENT.slots.forEach((si, k) => { used[si] += CURRENT.grams * 0.4 * (k === 0 ? 0.7 : 0.3); });
const level = SPOOLS.map((s, i) => (remain[i] === null ? null : remain[i] + used[i] / 10));
const trayRows = SPOOLS.map(() => []);
const t30 = T0 - 30 * DAY;
SPOOLS.forEach((sp, i) => trayRows[i].push({ t: t30, a: trayAttrs(sp, { remain: level[i] === null ? -1 : Math.round(level[i]) }) }));
add(E('print_status'), t30, 'idle');
add(E('stage'), t30, 'idle');

function dayStart(daysAgo, hour) { const d = new Date(T0 - daysAgo * DAY); d.setHours(hour, 0, 0, 0); return d.getTime(); }
function emitJob(start, minutes, grams, name, plate, result, slots, failStage, ongoing = false) {
  const end = start + minutes * MIN;
  const frac = result === 'finish' ? 1 : result === 'stopped' ? 0.35 : 0.2;
  const until = ongoing ? T0 : end;
  const task = name.replace(/ /g, '_') + `_plate_${plate}`;
  add(E('print_status'), start, 'prepare');
  add(E('start_time'), start + 20_000, iso(start));
  add(E('subtask_name'), start, task);
  add(E('gcode_file'), start, `/data/Metadata/plate_${plate}.gcode`);
  add(E('print_weight'), start, grams);
  add(E('print_length'), start, (grams / 3).toFixed(2));
  const layers = Math.round(minutes * 1.4);
  add(E('total_layers'), start, layers);
  add(E('stage'), start + MIN, 'auto_bed_leveling');
  add(E('print_status'), start + 5 * MIN, 'running');
  add(E('stage'), start + 5 * MIN, 'printing');
  // Mid-print the printer drops off Wi-Fi for a moment now and then.
  if (minutes > 200 && !ongoing) { add(E('print_status'), start + 60 * MIN, 'offline'); add(E('print_status'), start + 63 * MIN, 'running'); }
  if (ongoing) {
    add(E('print_progress'), T0 - 2 * MIN, 40);
    add(E('current_layer'), T0 - 2 * MIN, Math.round(layers * 0.4));
  } else {
    if (failStage) add(E('stage'), end - 2 * MIN, failStage);
    add(E('print_progress'), end - MIN, Math.round(frac * 100));
    add(E('current_layer'), end - MIN, Math.round(layers * frac));
    add(E('print_status'), end, result === 'stopped' ? 'idle' : result);
    add(E('stage'), end + 30_000, 'idle');
    if (result !== 'stopped') add(E('print_status'), end + 10 * MIN, 'idle');
  }
  // Trays: the first slot is active while printing; levels drop at the end.
  const share = slots.map((si, k) => (k === 0 ? 0.7 : 0.3 / Math.max(1, slots.length - 1)));
  // The first slot feeds most of the job; each other slot takes a turn.
  const turn = Math.max(1, Math.round(minutes * 0.3 / Math.max(1, slots.length - 1)));
  slots.forEach((si, k) => {
    const prev = trayRows[si][trayRows[si].length - 1].a;
    const on = k === 0 ? start + 5 * MIN : start + 5 * MIN + (k - 1) * turn * MIN;
    trayRows[si].push({ t: on, a: { ...prev, active: true } });
    if (k > 0) trayRows[si].push({ t: on + turn * MIN, a: { ...prev, active: false } });
  });
  if (!ongoing) {
    slots.forEach((si, k) => {
      if (level[si] === null) return;
      level[si] -= grams * frac * share[k] / 10;
      const prev = trayRows[si][trayRows[si].length - 1].a;
      trayRows[si].push({ t: until - 30_000, a: { ...prev, active: false, remain: Math.round(level[si]) } });
    });
  }
}
for (const [d, h, minutes, grams, name, plate, result, slots, failStage] of jobs) emitJob(dayStart(d, h), minutes, grams, name, plate, result, slots, failStage);
const curStart = T0 - CURRENT.startedAgo;
if (printing) emitJob(curStart, CURRENT.minutes, CURRENT.grams, CURRENT.name, CURRENT.plate, 'running', CURRENT.slots, null, true);
if (switches.has('paused')) { add(E('print_status'), T0 - 4 * MIN, 'pause'); add(E('stage'), T0 - 4 * MIN, 'paused_user'); }
if (switches.has('offline')) add(E('print_status'), T0 - 20 * MIN, 'offline');
SPOOLS.forEach((sp, i) => { hist[trayId(sp)] = trayRows[i].sort((a, b) => a.t - b.t).map(r => ({ s: sp.name, a: r.a, lu: r.t / 1000 })); });

// Current states (consistent with the end of the history).
const lan = !switches.has('no_lan');
const cur = printing;
entity(printer, `sensor.${P}_print_status`, 'print_status', status);
entity(printer, `sensor.${P}_current_stage`, 'stage', switches.has('paused') ? 'paused_user' : cur ? 'printing' : 'idle', {}, { unique: 'stage' });
entity(printer, `sensor.${P}_printer_name`, 'printer_name', 'Workshop H2D', {}, { unique: 'name' });
entity(printer, `sensor.${P}_task_name`, 'subtask_name', cur ? CURRENT.name.replace(/ /g, '_') + '_plate_1' : 'unknown', {}, { unique: 'subtask_name' });
entity(printer, `sensor.${P}_gcode_filename`, 'gcode_file', cur ? '/data/Metadata/plate_1.gcode' : 'unknown', {}, { unique: 'gcode_file' });
entity(printer, `sensor.${P}_print_progress`, 'print_progress', cur ? 40 : 0);
entity(printer, `sensor.${P}_current_layer`, 'current_layer', cur ? Math.round(CURRENT.minutes * 1.4 * 0.4) : 0);
entity(printer, `sensor.${P}_total_layer_count`, 'total_layers', cur ? Math.round(CURRENT.minutes * 1.4) : 0, {}, { unique: 'total_layers' });
entity(printer, `sensor.${P}_remaining_time`, 'remaining_time', cur ? ((CURRENT.minutes * 0.6) / 60).toFixed(2) : 0, { unit_of_measurement: 'h' });
entity(printer, `sensor.${P}_end_time`, 'end_time', cur ? iso(T0 + CURRENT.minutes * 0.6 * MIN) : 'unknown');
entity(printer, `sensor.${P}_start_time`, 'start_time', cur ? iso(curStart) : 'unknown');
entity(printer, `sensor.${P}_print_weight`, 'print_weight', cur ? CURRENT.grams : 24, { unit_of_measurement: 'g' });
entity(printer, `sensor.${P}_print_length`, 'print_length', cur ? (CURRENT.grams / 3).toFixed(2) : 8, { unit_of_measurement: 'm' });
entity(printer, `sensor.${P}_print_bed_type`, 'print_bed_type', 'textured_plate');
entity(printer, `sensor.${P}_speed_profile`, 'speed_profile', 'standard');
entity(printer, `sensor.${P}_left_nozzle_temperature`, 'left_nozzle_temp', cur ? 220 : 31);
entity(printer, `sensor.${P}_left_nozzle_target_temperature`, 'left_target_nozzle_temp', cur ? 220 : 0);
entity(printer, `sensor.${P}_right_nozzle_temperature`, 'right_nozzle_temp', cur ? 38 : 30);
entity(printer, `sensor.${P}_right_nozzle_target_temperature`, 'right_target_nozzle_temp', 0);
entity(printer, `sensor.${P}_bed_temperature`, 'bed_temp', cur ? 55 : 27);
entity(printer, `sensor.${P}_bed_target_temperature`, 'target_bed_temp', cur ? 55 : 0);
entity(printer, `sensor.${P}_chamber_temperature`, 'chamber_temp', cur ? 33 : 25);
entity(printer, `sensor.${P}_chamber_target_temperature`, 'target_chamber_temp', 0);
entity(printer, `sensor.${P}_left_nozzle_size`, 'left_nozzle_diameter', '0.4');
entity(printer, `sensor.${P}_left_nozzle_type`, 'left_nozzle_type', 'hardened_steel');
entity(printer, `sensor.${P}_right_nozzle_size`, 'right_nozzle_diameter', '0.4');
entity(printer, `sensor.${P}_right_nozzle_type`, 'right_nozzle_type', 'hardened_steel');
entity(printer, `sensor.${P}_active_nozzle`, 'active_nozzle', 'left');
entity(printer, `sensor.${P}_ip_address`, 'ip_address', '192.168.1.50');
entity(printer, `binary_sensor.${P}_online`, 'online', switches.has('offline') ? 'off' : 'on');
entity(printer, `binary_sensor.${P}_door`, 'door_open', 'off');
entity(printer, `binary_sensor.${P}_hms_errors`, 'hms_errors', 'off', { Count: 0 }, { unique: 'hms' });
entity(printer, `binary_sensor.${P}_print_error`, 'print_error', 'off');
entity(printer, `binary_sensor.${P}_developer_lan_mode`, 'developer_lan_mode', lan ? 'on' : 'off');
entity(printer, `camera.${P}_camera`, 'camera', 'streaming');
entity(printer, `switch.${P}_camera`, 'camera', 'on');
entity(printer, `light.${P}_chamber_light`, 'chamber_light', switches.has('offline') ? 'unavailable' : 'off', { supported_color_modes: ['onoff'] });
if (lan) {
  entity(printer, `button.${P}_pause_printing`, 'pause', status === 'running' ? 'unknown' : 'unavailable');
  entity(printer, `button.${P}_resume_printing`, 'resume', status === 'pause' ? 'unknown' : 'unavailable');
  entity(printer, `button.${P}_stop_printing`, 'stop', status === 'running' || status === 'pause' ? 'unknown' : 'unavailable');
}
if (!switches.has('no_ams')) {
  for (const [dev, n, hum, idx, temp, drying] of [[amsDev, 1, 21, 1, 27, false], [htDev, 128, 34, 3, 61, true]]) {
    const u = (k, tk, s, a = {}) => {
      entities.push({ entity_id: `${k}.${P}_ams_${n}_${tk}`, platform: 'bambu_lab', device_id: dev.id, translation_key: tk === 'temperature' ? 'ams_temp' : tk, unique_id: `H2D_${SERIAL}_AMS_${dev.identifiers[0][1]}_${tk}`, disabled_by: null });
      states.push({ entity_id: `${k}.${P}_ams_${n}_${tk}`, state: String(s), attributes: a, last_changed: iso(T0), last_updated: iso(T0) });
    };
    u('sensor', 'humidity', hum); u('sensor', 'humidity_index', idx); u('sensor', 'temperature', temp);
    u('binary_sensor', 'drying', drying ? 'on' : 'off'); u('sensor', 'remaining_drying_time', drying ? 2.5 : 0, { unit_of_measurement: 'h' });
  }
  SPOOLS.forEach((sp, i) => {
    const id = trayId(sp);
    entities.push({ entity_id: id, platform: 'bambu_lab', device_id: sp.dev.id, translation_key: 'tray', unique_id: `H2D_${SERIAL}_AMS_${sp.dev.identifiers[0][1]}_tray_${sp.slot}`, disabled_by: null });
    const last = trayRows[i][trayRows[i].length - 1].a;
    const activeNow = cur && i === CURRENT.slots[0];
    states.push({ entity_id: id, state: sp.name, attributes: { ...last, active: activeNow, remain: sp.remain }, last_changed: iso(T0), last_updated: iso(T0) });
  });
}
entities.push({ entity_id: `sensor.${P}_externalspool_external_spool`, platform: 'bambu_lab', device_id: extDev.id, translation_key: 'external_spool', unique_id: `H2D_${SERIAL}_ExternalSpool_external_spool`, disabled_by: null });
states.push({ entity_id: `sensor.${P}_externalspool_external_spool`, state: 'Empty', attributes: { empty: true, type: '', name: '', color: '#00000000', remain: -1 }, last_changed: iso(T0), last_updated: iso(T0) });

// A smart plug's power sensor (not Bambu), for the power_sensor option.
states.push({ entity_id: 'sensor.workbench_plug_power', state: printing ? '152.4' : '9.1', attributes: { unit_of_measurement: 'W', device_class: 'power' }, last_changed: iso(T0), last_updated: iso(T0) });

// ---- Recorder history -------------------------------------------------------------------

function historyFor(ids, start, end, withAttributes) {
  const out = {};
  for (const id of ids) {
    let rows = (hist[id] || []).filter(r => r.lu * 1000 >= start && r.lu * 1000 <= end);
    // Recorder gives the state at the start of the window as the first row.
    const before = (hist[id] || []).filter(r => r.lu * 1000 < start).pop();
    if (before) rows = [{ ...before, lu: start / 1000 }, ...rows];
    if (!rows.length) { const s = st(id); if (s) rows = [{ s: s.state, ...(withAttributes && { a: s.attributes }), lu: start / 1000 }]; }
    out[id] = rows.map(r => (withAttributes ? r : { s: r.s, lu: r.lu }));
  }
  return out;
}

// ---- WebSocket stand-in -------------------------------------------------------------

function callService(msg) {
  calls.push({ domain: msg.domain, service: msg.service, target: msg.target, data: msg.service_data, at: Date.now() });
  const name = `${msg.domain}.${msg.service}`;
  const s = st(`sensor.${P}_print_status`).state;
  const buttons = state => {
    setState(`button.${P}_pause_printing`, state === 'running' ? 'unknown' : 'unavailable');
    setState(`button.${P}_resume_printing`, state === 'pause' ? 'unknown' : 'unavailable');
    setState(`button.${P}_stop_printing`, state === 'running' || state === 'pause' ? 'unknown' : 'unavailable');
  };
  if (name === 'button.press') {
    const id = msg.target?.entity_id;
    if (st(id)?.state === 'unavailable') return 'Entity is unavailable';
    const next = id.endsWith('_pause_printing') ? 'pause' : id.endsWith('_resume_printing') ? 'running' : id.endsWith('_stop_printing') ? 'failed' : null;
    if (!next) return 'unknown button';
    setState(`sensor.${P}_print_status`, next);
    buttons(next);
    return null;
  }
  if (name === 'light.turn_on' || name === 'light.turn_off') {
    const id = msg.target?.entity_id;
    if (id !== `light.${P}_chamber_light`) return 'unknown light';
    if (st(id)?.state === 'unavailable') return 'Entity is unavailable';
    setState(id, msg.service === 'turn_on' ? 'on' : 'off');
    return null;
  }
  if (name === 'bambu_lab.print_project_file') {
    if (!['idle', 'finish', 'failed'].includes(s)) return 'Printer is busy';
    setState(`sensor.${P}_print_status`, 'prepare');
    setState(`sensor.${P}_task_name`, String(msg.service_data.filepath).replace(/\.gcode\.3mf$|\.3mf$/, ''));
    buttons('prepare');
    return null;
  }
  return `UNMOCKED service ${name}`;
}

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    log('ws open', url);
    setTimeout(() => {
      if (switches.has('ha_down')) { this.onerror?.({}); return; }
      this.recv({ type: 'auth_required' });
    }, 5);
  }
  recv(msg) { setTimeout(() => this.onmessage?.({ data: JSON.stringify(msg) }), 2); }
  send(raw) {
    const msg = JSON.parse(raw);
    log('ws', msg.type, msg.domain || '', msg.service || '');
    if (msg.type === 'auth') return this.recv(msg.access_token === process.env.SUPERVISOR_TOKEN ? { type: 'auth_ok' } : { type: 'auth_invalid' });
    const ok = result => this.recv({ id: msg.id, type: 'result', success: true, result });
    const bad = message => this.recv({ id: msg.id, type: 'result', success: false, error: { message } });
    switch (msg.type) {
      case 'get_states': return ok(states);
      case 'get_config': return ok({ unit_system: { temperature: '°C' }, time_zone: 'Europe/London', location_name: 'Workshop' });
      case 'config/entity_registry/list': return ok(entities);
      case 'config/device_registry/list': return ok(devices);
      case 'history/history_during_period': return ok(historyFor(msg.entity_ids, Date.parse(msg.start_time), Date.parse(msg.end_time), !msg.no_attributes));
      case 'call_service': { const err = callService(msg); return err ? bad(err) : ok({ context: {} }); }
      default:
        console.error('UNMOCKED websocket message', msg.type);
        return bad('unknown command');
    }
  }
  close() { this.onclose?.({}); }
}
globalThis.WebSocket = FakeWebSocket;

// ---- tiny PNG and .3mf builders ---------------------------------------------------------

const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

// A 128×128 picture of a block on a plate, in the given colour.
function png(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const W = 128, raw = Buffer.alloc((W * 3 + 1) * W);
  for (let y = 0; y < W; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const o = y * (W * 3 + 1) + 1 + x * 3;
      const inPart = x > 38 && x < 90 && y > 30 && y < 92;
      const plate = y >= 92 && y < 104 && x > 12 && x < 116;
      const c = inPart ? [r, g, b] : plate ? [60, 60, 56] : [30, 30, 28];
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2];
    }
  }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const comp = zlib.deflateRawSync(data);
    const nm = Buffer.from(name);
    const crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    locals.push(lh, nm, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nm);
    offset += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// plates: [{ index, minutes, filaments: [{ id, type, color, grams }] }]
function threeMf(plates) {
  const info = `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header><header_item key="X-BBL-Client-Type" value="slicer"/></header>\n${plates.map(p => `  <plate>\n    <metadata key="index" value="${p.index}"/>\n    <metadata key="prediction" value="${p.minutes * 60}"/>\n    <metadata key="weight" value="${p.filaments.reduce((a, f) => a + f.grams, 0).toFixed(2)}"/>\n${p.filaments.map(f => `    <filament id="${f.id}" tray_info_idx="GFA00" type="${f.type}" color="${f.color}" used_m="${(f.grams / 3).toFixed(2)}" used_g="${f.grams.toFixed(2)}" />`).join('\n')}\n  </plate>`).join('\n')}\n</config>\n`;
  const files = [['[Content_Types].xml', '<Types/>'], ['3D/3dmodel.model', '<model/>'], ['Metadata/slice_info.config', info]];
  for (const p of plates) { files.push([`Metadata/plate_${p.index}.gcode`, '; fake gcode\n']); files.push([`Metadata/plate_${p.index}.png`, png(p.filaments[0].color)]); }
  return zip(files);
}

// ---- FTPS stand-in (plain TCP; the test transport skips TLS) ---------------------------------

const DAYS = d => T0 - d * DAY;
const printerFiles = new Map([
  ['/Workbench_pegboard_hooks_plate_1.gcode.3mf', { data: threeMf([{ index: 1, minutes: 190, filaments: [{ id: 2, type: 'PLA', color: '#161616', grams: 99 }, { id: 5, type: 'PETG', color: '#8E9089', grams: 43 }] }]), mtime: curStart - 2 * MIN }],
  ['/Gridfinity_2x3_bins.3mf', { data: threeMf([{ index: 1, minutes: 210, filaments: [{ id: 1, type: 'PLA', color: '#FFFFFF', grams: 84 }, { id: 2, type: 'PLA', color: '#000000', grams: 36 }] }, { index: 2, minutes: 95, filaments: [{ id: 1, type: 'PLA', color: '#FFFFFF', grams: 51 }] }]), mtime: DAYS(4) }],
  ['/Planter_drip_tray_plate_1.gcode.3mf', { data: threeMf([{ index: 1, minutes: 130, filaments: [{ id: 3, type: 'PLA', color: '#00AE42', grams: 50 }, { id: 1, type: 'PLA', color: '#FFFFFF', grams: 21 }] }]), mtime: DAYS(1) }],
  ['/cache/Earbud_case_plate_1.gcode.3mf', { data: threeMf([{ index: 1, minutes: 55, filaments: [{ id: 1, type: 'PLA', color: '#00AE42', grams: 24 }] }]), mtime: DAYS(2) }],
  ['/notes.txt', { data: Buffer.from('not a print'), mtime: DAYS(9) }],
]);
if (switches.has('many_files')) {
  ['Cable_tidy_clips', 'Hex_bit_holder', 'Spool_holder_arm', 'Plant_label_stakes', 'Desk_grommet', 'Phone_dock', 'Hook_rail', 'Lid_knob', 'Tool_tray', 'Bin_dividers', 'Wall_bracket', 'Coaster']
    .forEach((n, i) => printerFiles.set(`/${n}.gcode.3mf`, { data: threeMf([{ index: 1, minutes: 30 + i * 7, filaments: [{ id: 1, type: 'PLA', color: '#FFFFFF', grams: 10 + i }] }]), mtime: DAYS(3 + i) }));
}
const ftpLog = [];

function listing(dir) {
  const base = dir.endsWith('/') ? dir : dir + '/';
  const lines = [];
  const fmt = (name, size, t, isDir) => { const d = new Date(t); const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }); return `${isDir ? 'd' : '-'}rw-rw-rw- 1 root root ${size} ${mon} ${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} ${name}`; };
  if (base === '/') { lines.push(fmt('cache', 0, DAYS(30), true)); lines.push(fmt('timelapse', 0, DAYS(30), true)); }
  for (const [p, f] of printerFiles) {
    if (p.startsWith(base) && !p.slice(base.length).includes('/')) lines.push(fmt(p.slice(base.length), f.data.length, f.mtime, false));
  }
  return lines.join('\r\n') + '\r\n';
}

const ftpServer = net.createServer(sock => {
  let authed = false, user = false, pasv = null, buf = '';
  const reply = line => sock.write(line + '\r\n');
  reply('220 Bambu FTP ready');
  const withData = cb => {
    if (!pasv) return reply('425 Use PASV first');
    const srv = pasv; pasv = null;
    srv.conn.then(d => { reply('150 Opening data connection'); cb(d, () => { reply('226 Transfer complete'); srv.close(); }); });
  };
  sock.on('data', chunk => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      const [cmd, ...rest] = line.split(' ');
      const arg = rest.join(' ');
      ftpLog.push(cmd === 'PASS' ? 'PASS ***' : line);
      log('ftp', cmd === 'PASS' ? 'PASS ***' : line);
      if (cmd === 'USER') { user = arg === 'bblp'; reply('331 Password required'); continue; }
      if (cmd === 'PASS') { authed = user && arg === ACCESS_CODE; reply(authed ? '230 Logged in' : '530 Login incorrect'); continue; }
      if (cmd === 'QUIT') { reply('221 Bye'); sock.end(); continue; }
      if (!authed) { reply('530 Please login'); continue; }
      if (cmd === 'PBSZ' || cmd === 'PROT' || cmd === 'TYPE') { reply('200 OK'); continue; }
      if (cmd === 'PASV') {
        const srv = net.createServer();
        srv.conn = new Promise(resolve => srv.once('connection', resolve));
        srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; pasv = srv; reply(`227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255})`); });
        continue;
      }
      if (cmd === 'SIZE') { const f = printerFiles.get(arg); reply(f ? `213 ${f.data.length}` : '550 No such file'); continue; }
      if (cmd === 'LIST') { withData((d, done) => { d.end(listing(arg || '/'), done); }); continue; }
      if (cmd === 'RETR') {
        const f = printerFiles.get(arg);
        if (!f) { reply('550 No such file'); if (pasv) { pasv.close(); pasv = null; } continue; }
        withData((d, done) => d.end(f.data, done));
        continue;
      }
      if (cmd === 'STOR') {
        withData((d, done) => { const parts = []; d.on('data', c => parts.push(c)); d.on('end', () => { printerFiles.set(arg, { data: Buffer.concat(parts), mtime: Date.now() }); done(); }); });
        continue;
      }
      reply('502 Not implemented');
    }
  });
  sock.on('error', () => {});
});
ftpServer.listen(0, '127.0.0.1');
ftpServer.unref();

// The app's file client, pointed at the stand-in over plain TCP. Its data
// connections go to "the printer's address", which here is 127.0.0.1.
// The same module the server loads: ftps.js beside the server script (app/ in
// the repository, /app in the container), else the repository's copy.
const pathMod = require('path');
const besideServer = pathMod.join(pathMod.dirname(pathMod.resolve(process.argv[1] || '.')), 'ftps.js');
const { PrinterFiles } = require(require('fs').existsSync(besideServer) ? besideServer : pathMod.join(__dirname, '../../app/ftps.js'));
const plain = { control: (host, port) => net.connect({ host, port }), wrapData: null };
global.__printLogFiles = o => {
  if (o.host !== '192.168.1.50') console.error('UNMOCKED printer address', o.host);
  return new PrinterFiles({ ...o, host: '127.0.0.1', port: ftpServer.address().port, transport: plain, timeoutMs: 5000 });
};

// ---- REST: camera ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input?.url || input);
  log('fetch', url);
  if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return realFetch(input, init);
  if (url === `http://fake-supervisor/core/api/camera_proxy/camera.${P}_camera`) {
    if (init?.headers?.Authorization !== `Bearer ${process.env.SUPERVISOR_TOKEN}`) return new Response('unauthorized', { status: 401 });
    return new Response(png('#2F6FD0'), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
  }
  console.error('UNMOCKED fetch', url);
  return new Response('{}', { status: 599 });
};

module.exports = { switches, states, entities, devices, calls, ftpLog, printerFiles, threeMf, SERIAL, ACCESS_CODE };
