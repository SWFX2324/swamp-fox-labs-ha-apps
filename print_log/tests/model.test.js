'use strict';
// The pure parts: finding printers and spools, rebuilding jobs from Recorder
// history, money, statistics, slot mapping, the printer's file list, the .3mf
// reader and the Home Assistant allow-list. No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../app/model');
const { parseList } = require('../app/ftps');
const threemf = require('../app/threemf');
const { HomeAssistant } = require('../app/ha');

const S = 'SERIAL1';
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

function registry({ buttons = true } = {}) {
  const devices = [
    { id: 'p', name: `X_${S}`, model: 'X1C', sw_version: '1.0', via_device_id: null, identifiers: [['bambu_lab', S]] },
    { id: 'a', name: `X_${S}_AMS_1`, model: 'AMS', via_device_id: 'p', identifiers: [['bambu_lab', 'A1']] },
    { id: 'a2', name: `X_${S}_AMS_2`, model: 'AMS', via_device_id: 'p', identifiers: [['bambu_lab', 'A2']] },
    { id: 'h', name: `X_${S}_AMS_128`, model: 'AMS HT', via_device_id: 'p', identifiers: [['bambu_lab', 'H1']] },
    { id: 'e', name: `X_${S}_ExternalSpool`, model: 'External Spool', via_device_id: 'p', identifiers: [['bambu_lab', `${S}_ExternalSpool`]] },
    { id: 'mw', name: 'MakerWorld (x)', model: 'Creator profile', via_device_id: null, identifiers: [['bambu_lab', 'makerworld_u_1']] },
    { id: 'other', name: 'Lamp', model: 'Bulb', via_device_id: null, identifiers: [['hue', '1']] },
  ];
  const e = (device_id, entity_id, translation_key, unique_id = `${S}_${translation_key}`) => ({ platform: 'bambu_lab', device_id, entity_id, translation_key, unique_id, disabled_by: null });
  const entities = [
    e('p', 'sensor.x_print_status', 'print_status'), e('p', 'sensor.x_task_name', 'subtask_name'), e('p', 'sensor.x_gcode', 'gcode_file'),
    e('p', 'sensor.x_weight', 'print_weight'), e('p', 'sensor.x_progress', 'print_progress'), e('p', 'sensor.x_stage', 'stage'),
    e('p', 'sensor.x_layers', 'total_layers'), e('p', 'sensor.x_layer', 'current_layer'), e('p', 'sensor.x_start', 'start_time'),
    e('p', 'sensor.x_name', 'printer_name'), e('p', 'binary_sensor.x_lan', 'developer_lan_mode'), e('p', 'binary_sensor.x_online', 'online'),
    e('p', 'camera.x_camera', 'camera'), e('p', 'switch.x_camera', 'camera'), e('p', 'sensor.x_ip', 'ip_address'),
    e('a', 'sensor.x_ams_1_tray_1', 'tray', `X_${S}_AMS_A1_tray_1`), e('a', 'sensor.x_ams_1_tray_2', 'tray', `X_${S}_AMS_A1_tray_2`),
    e('a2', 'sensor.x_ams_2_tray_3', 'tray', `X_${S}_AMS_A2_tray_3`),
    e('a', 'sensor.x_ams_1_humidity_index', 'humidity_index', `X_${S}_AMS_A1_humidity_index`),
    e('h', 'sensor.x_ams_128_tray_1', 'tray', `X_${S}_AMS_H1_tray_1`),
    e('e', 'sensor.x_ext', 'external_spool', `X_${S}_ExternalSpool_external_spool`),
    e('mw', 'sensor.mw_likes', 'makerworld_likes'),
    { ...e('p', 'sensor.x_disabled', 'cover_image'), disabled_by: 'user' },
  ];
  if (buttons) entities.push(e('p', 'button.x_pause', 'pause'), e('p', 'button.x_resume', 'resume'), e('p', 'button.x_stop', 'stop'));
  return { devices, entities };
}

const tray = (color, remain, extra = {}) => ({ name: 'Bambu PLA Basic', type: 'PLA', color, remain, remain_enabled: true, tray_weight: '1000', tag_uid: `T${color}`, empty: false, active: false, ...extra });

test('finds the printer, its AMS units, trays and buttons; skips everything else', () => {
  const states = [{ entity_id: 'sensor.x_name', state: 'Garage X1' }];
  const [p, ...rest] = M.printers({ ...registry(), states });
  assert.equal(rest.length, 0, 'MakerWorld and non-Bambu devices are not printers');
  assert.equal(p.name, 'Garage X1');
  assert.equal(p.serial, S);
  assert.equal(p.ent.camera_entity, 'camera.x_camera');
  assert.equal(p.ent.button_stop, 'button.x_stop');
  assert.equal(p.ent.cover_image, undefined, 'disabled entities are ignored');
  const labels = M.trayEntities(p).map(t => `${t.unit}:${t.label}:${t.trayId}`);
  assert.deepEqual(labels, ['AMS 1:A1:0', 'AMS 1:A2:1', 'AMS 2:B3:6', 'AMS HT:HT:128', 'External spool:Ext:254']);
});

// A history like a real one: a print, a Wi-Fi drop mid-print, another print,
// and one that's still running.
function history() {
  const t0 = Date.parse('2026-10-21T14:10:00Z');
  const s = (t, v) => ({ s: String(v), lu: t / 1000 });
  const a = (t, attrs) => ({ s: 'Bambu PLA Basic', a: attrs, lu: t / 1000 });
  return {
    t0,
    h: {
      'sensor.x_print_status': [s(t0 - HOUR, 'finish'), s(t0, 'prepare'), s(t0 + MIN, 'running'), s(t0 + 76 * MIN, 'finish'),
        s(t0 + 81 * MIN, 'prepare'), s(t0 + 82 * MIN, 'running'), s(t0 + 150 * MIN, 'offline'), s(t0 + 153 * MIN, 'running'), s(t0 + 153 * MIN + 5000, 'finish'),
        s(t0 + 200 * MIN, 'unavailable'), s(t0 + 300 * MIN, 'idle'),
        s(t0 + 400 * MIN, 'prepare'), s(t0 + 405 * MIN, 'running'), s(t0 + 430 * MIN, 'failed'),
        s(t0 + 500 * MIN, 'running'), s(t0 + 530 * MIN, 'idle'),
        s(t0 + 600 * MIN, 'prepare'), s(t0 + 610 * MIN, 'running')],
      'sensor.x_task_name': [s(t0 - HOUR, 'Old thing'), s(t0, 'Coaster_set_plate_2'), s(t0 + 400 * MIN, 'Bracket_plate_1'), s(t0 + 500 * MIN, 'Clip'), s(t0 + 600 * MIN, 'Live_one')],
      'sensor.x_gcode': [s(t0, '/data/Metadata/plate_2.gcode'), s(t0 + 400 * MIN, '/data/Metadata/plate_1.gcode')],
      'sensor.x_weight': [s(t0, 23.4), s(t0 + 82 * MIN, 22.9), s(t0 + 400 * MIN, 50), s(t0 + 500 * MIN, 10), s(t0 + 600 * MIN, 80)],
      'sensor.x_progress': [s(t0 + 425 * MIN, 30), s(t0 + 620 * MIN, 12)],
      'sensor.x_stage': [s(t0 + 405 * MIN, 'printing'), s(t0 + 428 * MIN, 'paused_nozzle_clog'), s(t0 + 430 * MIN, 'idle')],
      'sensor.x_layers': [s(t0, 15), s(t0 + 400 * MIN, 100)],
      'sensor.x_ams_1_tray_1': [a(t0 - DAY, tray('#7A3CF0FF', 80)), a(t0 + MIN, { active: true }), a(t0 + 76 * MIN, { active: false, remain: 79 }),
        a(t0 + 405 * MIN, { active: true }), a(t0 + 430 * MIN, { active: false })],
      'sensor.x_ams_1_tray_2': [a(t0 - DAY, tray('#F0A03CFF', 50)), a(t0 + 82 * MIN, { active: true }), a(t0 + 153 * MIN, { active: false })],
    },
  };
}

test('rebuilds jobs from history: Wi-Fi drops, stops, failures and the running job', () => {
  const p = M.printers({ ...registry(), states: [] })[0];
  const { t0, h } = history();
  const { jobs, current } = M.jobsFromHistory(p, h);
  assert.deepEqual(jobs.map(j => [j.name, j.result]), [['Coaster set', 'finished'], ['Coaster set', 'finished'], ['Bracket', 'failed'], ['Clip', 'stopped']]);
  const [a, b, c, d] = jobs;
  assert.equal(a.plate, 2);
  assert.equal(a.grams, 23.4);
  assert.equal(a.seconds, 76 * 60);
  assert.deepEqual(a.slots.map(s => [s.label, s.grams]), [['A1', 23.4]], 'A1 was the one feeding');
  assert.equal(b.grams, 22.9, 'the Wi-Fi drop did not split the job');
  assert.equal(b.seconds, Math.round((153 * MIN + 5000 - 81 * MIN) / 1000));
  assert.deepEqual(b.slots.map(s => s.label), ['A2']);
  assert.equal(c.reason, 'Nozzle clog');
  assert.equal(c.progress, 30);
  assert.equal(c.grams, 15, 'a failed job counts the share it printed');
  assert.equal(d.result, 'stopped');
  assert.equal(current.name, 'Live one');
  assert.equal(current.progress, 12);
  assert.equal(current.start, t0 + 600 * MIN);
});

test('feeding time beats the AMS level estimate, which jumps around', () => {
  const p = M.printers({ ...registry(), states: [] })[0];
  const t0 = Date.parse('2026-10-23T18:05:00Z');
  const s = (t, v) => ({ s: String(v), lu: t / 1000 });
  const a = (t, attrs) => ({ s: 'PETG', a: attrs, lu: t / 1000 });
  const { jobs } = M.jobsFromHistory(p, {
    'sensor.x_print_status': [s(t0, 'prepare'), s(t0 + 75 * MIN, 'finish')],
    'sensor.x_weight': [s(t0, 30)],
    // A1 feeds for 54 minutes and its level doesn't move; A2 feeds for 19 and its level drops 9% (90 g).
    'sensor.x_ams_1_tray_1': [a(t0 - DAY, tray('#3C8CF0FF', 100)), a(t0 + MIN, { active: true }), a(t0 + 55 * MIN, { active: false })],
    'sensor.x_ams_1_tray_2': [a(t0 - DAY, tray('#E0E03CFF', 94)), a(t0 + 55 * MIN, { active: true }), a(t0 + 74 * MIN, { active: false, remain: 85 })],
  });
  assert.deepEqual(jobs[0].slots.map(x => [x.label, x.grams]), [['A1', 22.2], ['A2', 7.8]]);
});

test('merging keeps one copy of a job found again', () => {
  const p = M.printers({ ...registry(), states: [] })[0];
  const { jobs } = M.jobsFromHistory(p, history().h);
  const merged = M.mergeJobs(M.mergeJobs([], jobs), jobs.map(j => ({ ...j, id: j.id + 'x', start: j.start + 30_000 })));
  assert.equal(merged.length, jobs.length);
  assert.ok(merged[0].start > merged[1].start, 'newest first');
});

test('costs, statistics and run-out', () => {
  const options = { default_price_per_kg: 20, filament_prices: [{ material: 'PLA', price_per_kg: 25 }, { material: 'PETG', price_per_kg: 30 }] };
  assert.equal(M.priceFor('PLA', options), 25);
  assert.equal(M.priceFor('PETG-HF', options), 30, 'a variant falls back to its base material');
  assert.equal(M.priceFor('TPU', options), 20);
  const now = Date.parse('2026-11-15T12:00:00Z');
  const job = (daysAgo, grams, result = 'finished', slots = [{ key: 'red', label: 'A1', type: 'PLA', grams }]) => ({ start: now - daysAgo * DAY, end: now - daysAgo * DAY + HOUR, seconds: 3600, grams, result, slots, meters: grams / 3, progress: result === 'finished' ? 100 : 50, name: 'x' });
  const jobs = [job(1, 100), job(3, 40, 'failed'), job(20, 60), job(40, 500)];
  assert.equal(M.costOf(jobs[0], options), 2.5);
  const s = M.stats(jobs, { now, timeZone: 'UTC', options });
  assert.equal(s.month.prints, 2, 'November so far');
  assert.equal(s.month.failed, 1);
  assert.equal(s.month.successRate, 50);
  assert.equal(s.month.grams, 140);
  assert.equal(s.month.wasted, 40);
  assert.equal(s.lastMonth.prints, 2, 'October');
  assert.equal(s.lifetime.prints, 4);
  assert.equal(s.days.length, 30);
  assert.equal(s.days[29].key, '2026-11-15');
  assert.deepEqual(s.materials, [{ type: 'PLA', grams: 200 }]);
  const [spool] = M.runOut([{ key: 'red', grams: 100, empty: false }], jobs, { now, lowGrams: 150 });
  assert.equal(spool.usedMonth, 200);
  assert.equal(spool.daysLeft, 15);
  assert.equal(spool.low, true);
  assert.equal(spool.printsLeft, 1);
});

test('controls say why they are off', () => {
  const states = [{ entity_id: 'sensor.x_print_status', state: 'running' }, { entity_id: 'binary_sensor.x_online', state: 'on' }, { entity_id: 'binary_sensor.x_lan', state: 'off' },
    { entity_id: 'button.x_pause', state: 'unknown' }, { entity_id: 'button.x_resume', state: 'unavailable' }, { entity_id: 'button.x_stop', state: 'unknown' }];
  const stateOf = new Map(states.map(s => [s.entity_id, s]));
  const p = M.printers({ ...registry(), states })[0];
  const lv = M.live(p, stateOf, null);
  assert.equal(M.controlProblem(p, lv, 'pause', { allowControls: true }), null);
  assert.equal(M.controlProblem(p, lv, 'resume', { allowControls: true }), 'Only while paused.');
  assert.match(M.controlProblem(p, lv, 'stop', { allowControls: false }), /off in the app's Configuration/);
  const bare = M.printers({ ...registry({ buttons: false }), states })[0];
  assert.match(M.controlProblem(bare, M.live(bare, stateOf, null), 'stop', { allowControls: true }), /Developer LAN mode/);
  assert.match(M.startProblem(p, lv, { allowControls: true, filesReady: true }), /idle/);
  assert.match(M.startProblem(p, lv, { allowControls: true, filesReady: false }), /access code/);
});

test('slot mapping: same type and nearest colour, and the string the printer wants', () => {
  const spools = [
    { trayId: 0, type: 'PLA', color: '#FFFFFF', empty: false }, { trayId: 1, type: 'PLA', color: '#101010', empty: false },
    { trayId: 2, type: 'PLA', color: '#00AE42', empty: true }, { trayId: 128, type: 'PETG', color: '#808080', empty: false },
  ];
  const m = M.suggestMapping([{ id: 2, type: 'PLA', color: '#000000' }, { id: 5, type: 'PETG', color: '#999999' }, { id: 3, type: 'PLA', color: '#00FF00' }], spools);
  assert.deepEqual(m.map(x => x.trayId), [1, 128, 0], 'empty slots are never picked; a used slot is a last resort');
  assert.equal(M.amsMapping([{ filament: 2, trayId: 1 }, { filament: 5, trayId: 128 }]), '-1,1,-1,-1,128');
});

test('reads the printer\'s file list', () => {
  const now = new Date('2026-11-15T12:00:00Z');
  const list = parseList([
    'drwxrwxrwx 1 root root 0 Oct 01 10:00 cache',
    '-rw-rw-rw- 1 root root 52428800 Oct 21 14:10 Coaster set (2).gcode.3mf',
    '-rw-rw-rw- 1 root root 100 Dec 30 2025 old.3mf',
    '-rw-rw-rw- 1 root root 5 Dec 30 23:00 last-year.3mf',
    'total 3',
  ].join('\r\n'), '/', now);
  assert.deepEqual(list.map(f => [f.name, f.dir, f.size]), [['cache', true, 0], ['Coaster set (2).gcode.3mf', false, 52428800], ['old.3mf', false, 100], ['last-year.3mf', false, 5]]);
  assert.equal(list[1].path, '/Coaster set (2).gcode.3mf');
  assert.equal(new Date(list[1].mtime).toISOString(), '2026-10-21T14:10:00.000Z');
  assert.equal(new Date(list[3].mtime).getUTCFullYear(), 2025, 'a date in the future belongs to last year');
});

test('reads a sliced .3mf and refuses what isn\'t one', () => {
  process.env.FAKE_WORLD = 'idle';
  const { threeMf } = require('./fixtures/fake-printer');
  const buf = threeMf([{ index: 1, minutes: 90, filaments: [{ id: 1, type: 'PLA', color: '#FF0000', grams: 30.5 }] }, { index: 3, minutes: 10, filaments: [{ id: 2, type: 'PETG', color: '#00ff00', grams: 4 }] }]);
  const r = threemf.parse(buf);
  assert.deepEqual(r.plates.map(p => [p.index, p.seconds, p.grams, p.filaments.map(f => `${f.id}:${f.type}:${f.color}`).join()]), [[1, 5400, 30.5, '1:PLA:#FF0000'], [3, 600, 4, '2:PETG:#00FF00']]);
  assert.ok(r.thumbnails[1].readUInt32BE(0) === 0x89504e47);
  assert.throws(() => threemf.parse(Buffer.from('hello')), /isn't a .3mf/);
  assert.throws(() => threemf.parse(Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(40)])), /zip directory|isn't/);
});

test('Home Assistant client: only the allowed calls leave the app', async () => {
  const ha = new HomeAssistant({ token: 'x', WebSocketImpl: class { constructor() { throw new Error('no network in this test'); } } });
  await assert.rejects(ha.call('call_service', { domain: 'homeassistant', service: 'restart' }), /Refused to call homeassistant.restart/);
  await assert.rejects(ha.call('call_service', { domain: 'bambu_lab', service: 'send_command' }), /Refused to call bambu_lab.send_command/);
  await assert.rejects(ha.call('call_service', { domain: 'button', service: 'press', target: { entity_id: 'lock.front_door' } }), /needs one button/);
  await assert.rejects(ha.call('call_service', { domain: 'button', service: 'press', target: { entity_id: ['button.a', 'button.b'] } }), /needs one button/);
  await assert.rejects(ha.call('call_service', { domain: 'light', service: 'turn_on', target: { entity_id: 'lock.front_door' } }), /needs one light/);
  await assert.rejects(ha.call('call_service', { domain: 'light', service: 'turn_on', target: { entity_id: ['light.a', 'light.b'] } }), /needs one light/);
  await assert.rejects(ha.call('call_service', { domain: 'light', service: 'toggle', target: { entity_id: 'light.a' } }), /Refused to call light.toggle/);
  await assert.rejects(ha.call('call_service', { domain: 'light', service: 'turn_on', target: { entity_id: 'light.a' }, service_data: { flash: 'long' } }), /takes no options/);
  await assert.rejects(ha.call('config_entries/delete'), /Refused to send/);
  await assert.rejects(ha.cameraSnapshot('lock.front_door'), /not a camera/);
  await assert.rejects(ha.call('get_states'), /Can't reach Home Assistant/, 'an allowed read goes through to the connection');
});

test('power: estimated from heaters, or read from a plug', () => {
  const st = (id, s, a = {}) => [id, { entity_id: id, state: String(s), attributes: a }];
  const reg = registry();
  reg.entities.push(
    { platform: 'bambu_lab', device_id: 'p', entity_id: 'sensor.x_bed', translation_key: 'bed_temp' },
    { platform: 'bambu_lab', device_id: 'p', entity_id: 'sensor.x_bed_t', translation_key: 'target_bed_temp' },
    { platform: 'bambu_lab', device_id: 'p', entity_id: 'sensor.x_noz', translation_key: 'nozzle_temp' },
    { platform: 'bambu_lab', device_id: 'p', entity_id: 'sensor.x_noz_t', translation_key: 'target_nozzle_temp' },
  );
  const p = M.printers({ ...reg, states: [] })[0];
  const heating = new Map([st('sensor.x_print_status', 'prepare'), st('binary_sensor.x_online', 'on'), st('sensor.x_bed', 30), st('sensor.x_bed_t', 65), st('sensor.x_noz', 215), st('sensor.x_noz_t', 220)]);
  const a = M.power(p, heating);
  assert.equal(a.source, 'estimate');
  assert.deepEqual(a.parts, { electronics: M.POWER.busy, bed: M.POWER.bed, nozzles: M.heaterWatts(215, 220, M.POWER.nozzle), chamber: 0 });
  const holding = new Map([...heating, st('sensor.x_bed', 65)]);
  assert.ok(M.power(p, holding).watts < a.watts / 3, 'holding temperature uses far less than heating up');
  const idle = new Map([st('sensor.x_print_status', 'idle'), st('binary_sensor.x_online', 'on')]);
  assert.equal(M.power(p, idle).watts, M.POWER.idle);
  assert.equal(M.power(p, new Map([st('binary_sensor.x_online', 'off')])).watts, 0, 'offline: off');
  const plug = new Map([st('sensor.plug', 0.152, { unit_of_measurement: 'kW' })]);
  assert.deepEqual(M.power(p, plug, { sensor: 'sensor.plug' }), { watts: 152, source: 'sensor', sensor: 'sensor.plug', parts: null });
  assert.match(M.power(p, new Map(), { sensor: 'sensor.gone' }).problem, /isn't in Home Assistant/);
});

test('energy adds up between samples, into today and the running job, and skips long gaps', async () => {
  const { PrintLog } = require('../app/printlog');
  const reg = registry();
  const states = [{ entity_id: 'sensor.x_print_status', state: 'running', attributes: {} }, { entity_id: 'binary_sensor.x_online', state: 'on', attributes: {} }, { entity_id: 'sensor.plug', state: '100', attributes: { unit_of_measurement: 'W' } }];
  const ha = { entities: async () => reg.entities, devices: async () => reg.devices, config: async () => ({ time_zone: 'UTC' }), states: async () => states };
  let now = Date.parse('2026-11-15T12:00:00Z');
  const log = new PrintLog({ ha, options: { power_sensor: 'sensor.plug', electricity_price_per_kwh: 0.3 }, now: () => now });
  log.current[S] = { id: `${S}:1`, name: 'Bracket' };
  await log.sampleEnergy();
  for (let i = 0; i < 120; i++) { now += 30_000; await log.sampleEnergy(); } // one hour at 100 W
  now += 10 * 60_000; await log.sampleEnergy();                                // a 10-minute gap: not counted
  const w = await log.world(0);
  const en = log.energyFor(w.printers[0], w, now);
  assert.equal(en.today.wh, 100);
  assert.equal(en.today.cost, 0.03);
  assert.deepEqual(en.job, { name: 'Bracket', wh: 100, cost: 0.03 });
  assert.equal(en.costPerHour, 0.03);
  assert.equal(en.series.length, 122);
});
