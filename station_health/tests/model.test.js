'use strict';
// Unit tests for model.js: Home Assistant and UniFi data shaped like the real
// thing, turned into what the page shows.

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../app/model');

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 14, 18, 0, 0);
const iso = t => new Date(t).toISOString();

function world({ states = [], entities = [], devices = [], entries = [] }) { return M.indexHa({ states, entities, devices, entries }); }
const st = (entity_id, state, attributes = {}, changed = NOW - HOUR) => ({ entity_id, state: String(state), attributes, last_changed: iso(changed), last_updated: iso(changed) });
const ent = (entity_id, platform, device_id) => ({ entity_id, platform, device_id, disabled_by: null });

test('networkAddress turns the gateway form UniFi stores into the network', () => {
  assert.equal(M.networkAddress('192.168.10.1/24'), '192.168.10.0/24');
  assert.equal(M.networkAddress('192.168.4.129/25'), '192.168.4.128/25');
  assert.equal(M.networkAddress('172.16.5.1/16'), '172.16.0.0/16');
  assert.equal(M.networkAddress(undefined), null);
});

test('timestamps in seconds, milliseconds, microseconds and ISO all read the same', () => {
  const t = Date.UTC(2026, 0, 2, 3, 4, 5);
  assert.equal(M.ts(t / 1000), t);
  assert.equal(M.ts(t), t);
  assert.equal(M.ts(t * 1000), t);
  assert.equal(M.ts(iso(t)), t);
  assert.equal(M.ts('unknown'), null);
});

test('containers: Portainer devices, compose stacks grouped, problems first, missing values stay null', () => {
  const devices = [
    { id: 'ep', name: 'local', model: 'Endpoint' },
    { id: 'a', name: 'nextcloud_app', model: 'Container' },
    { id: 'b', name: 'nextcloud_redis', model: 'Container' },
    { id: 'c', name: 'paperless-web-1', model: 'Container' },
    { id: 'd', name: 'paperless-broker-1', model: 'Container' },
    { id: 'e', name: 'grafana', model: 'Container' },
    { id: 'v', name: 'fts_data', model: 'Volume' },
  ];
  const entities = [], states = [];
  for (const d of devices.filter(x => x.model === 'Container')) {
    const id = d.name.replace(/-/g, '_');
    for (const [suffix, value] of [['state', d.id === 'e' ? 'exited' : 'running'], ['memory_usage', 100], ['memory_limit', 1000]]) {
      entities.push(ent(`sensor.x_${id}_${suffix}`, 'portainer', d.id));
      states.push(st(`sensor.x_${id}_${suffix}`, value));
    }
  }
  entities.push(ent('sensor.x_nextcloud_app_cpu_usage_total', 'portainer', 'a'));
  states.push(st('sensor.x_nextcloud_app_cpu_usage_total', 'unavailable'));
  const c = M.containers(world({ states, entities, devices }));
  assert.equal(c.total, 5);
  assert.equal(c.running, 4);
  assert.equal(c.list[0].name, 'grafana', 'the exited one first');
  assert.equal(c.list[0].level, 'bad');
  const server = c.list.find(x => x.name === 'nextcloud_app');
  assert.equal(server.stack, 'nextcloud');
  assert.equal(server.short, 'app');
  assert.equal(server.cpu, null, 'unavailable stays null, not 0');
  assert.equal(server.memPct, 10, 'memory against the limit when there is no percentage sensor');
  assert.equal(c.list.find(x => x.name === 'paperless-broker-1').short, 'broker');
  assert.equal(c.list.find(x => x.name === 'grafana').stack, null);
});

test('hosts: a PC that stops reporting is offline (a warning), not down', () => {
  const devices = [{ id: 'pc', name: 'Desk PC', model: 'Windows', config_entries: ['sb'] }];
  const entities = [ent('sensor.pc_memory_usage', 'system_bridge', 'pc'), ent('sensor.pc_load', 'system_bridge', 'pc')];
  const states = [st('sensor.pc_memory_usage', 'unavailable', {}, NOW - 40 * MIN), st('sensor.pc_load', 'unavailable')];
  const entries = [{ entry_id: 'sb', domain: 'system_bridge', title: 'Desk PC', state: 'setup_retry' }];
  const h = M.hosts(world({ states, entities, devices, entries }), null);
  assert.equal(h.length, 1);
  assert.equal(h[0].state, 'offline');
  assert.equal(h[0].level, 'warn');
  assert.equal(h[0].since, NOW - 40 * MIN);
  assert.match(h[0].note, /setup retry/);
});

test('hosts: the Home Assistant machine from the Supervisor, with disk and uptime', () => {
  const h = M.hosts(world({}), { info: { machine: 'raspberrypi4-64' }, host: { disk_total: 100, disk_used: 93, boot_timestamp: (NOW - DAY) * 1000 }, os: { version: '17.0' }, core: { version: '2026.11.1' } });
  assert.equal(h[0].name, 'Home Assistant');
  assert.match(h[0].sub, /Raspberry Pi 4 · OS 17\.0 · Core 2026\.11\.1/);
  assert.equal(h[0].since, NOW - DAY);
  assert.equal(h[0].level, 'warn', 'a disk 93% full is worth a look');
});

test('UniFi console: networks with their clients, traffic, busiest clients and new devices', () => {
  const api = {
    health: [{ subsystem: 'wan', status: 'ok', 'rx_bytes-r': 23_000_000, 'tx_bytes-r': 2_750_000, isp_name: 'ISP' }, { subsystem: 'www', status: 'ok', latency: 18, uptime: 3600, xput_down: 900.4, xput_up: 40, speedtest_lastrun: NOW / 1000 - 3600 }],
    networks: [
      { _id: 'n1', name: 'Default', purpose: 'corporate', ip_subnet: '10.0.1.1/24' },
      { _id: 'n2', name: 'IoT', purpose: 'corporate', vlan_enabled: true, vlan: '30', ip_subnet: '10.0.30.1/24' },
      { _id: 'w', name: 'Internet', purpose: 'wan' },
    ],
    clients: [
      { name: 'TV', network_id: 'n1', is_wired: false, 'tx_bytes-r': 1_000_000, 'rx_bytes-r': 0, first_seen: NOW / 1000 - 90 * 86400 },
      { hostname: 'nas', network_id: 'n1', is_wired: true, 'tx_bytes-r': 5_000_000, 'rx_bytes-r': 0, first_seen: NOW / 1000 - 90 * 86400 },
      { mac: 'aa:bb', network: 'IoT', is_wired: false, first_seen: NOW / 1000 - 3600, ip: '10.0.30.9', ap_mac: 'ap1' },
      { name: '<img src=x onerror=alert(1)>', network_id: 'gone', is_wired: false },
    ],
    devices: [
      { mac: 'ap1', name: 'Hall AP', type: 'uap', state: 1, uptime: 7200, 'system-stats': { cpu: '12.5', mem: '40' }, num_sta: 2, upgradable: true, upgrade_to_firmware: '4.1', version: '4.0' },
      { mac: 'gw', name: 'Router', type: 'udm', state: 0, last_seen: NOW / 1000 - 600, general_temperature: 50, total_used_power: 9.5, total_max_power: 46 },
    ],
  };
  const n = M.unifiFromApi(api, '°F', NOW);
  assert.equal(n.wan.up, true);
  assert.equal(n.wan.downBps, 184_000_000);
  assert.equal(n.wan.speedtest.downMbps, 900);
  assert.deepEqual(n.vlans.map(v => [v.name, v.vlan, v.subnet, v.clients]), [['Default', 1, '10.0.1.0/24', 2], ['IoT', 30, '10.0.30.0/24', 1], ['Other', null, null, 1]]);
  assert.equal(n.vlans[0].top[0].name, 'nas', 'busiest first');
  assert.equal(n.vlans[0].wired, 1);
  assert.equal(n.newDevices.length, 1);
  assert.equal(n.newDevices[0].ap, 'Hall AP');
  assert.equal(n.devices[0].name, 'Router', 'gateway first');
  assert.equal(n.devices[0].level, 'bad', 'a gateway offline is bad');
  assert.equal(n.devices[0].temp, 122, '°C converted to the home\'s unit');
  assert.deepEqual(n.devices[0].poe, { usedW: 10, maxW: 46 });
  assert.equal(n.devices[1].firmware.update, true);
  assert.equal(n.devices[1].cpu, 13);
  assert.ok(!JSON.stringify(n).includes('wan_ip'), 'no WAN address');
});

test('uptime blocks: up, partly down, down and no data', () => {
  const tr = [{ key: 'k', name: 'AP', entity: 'sensor.ap_state', kind: 'unifi', up: s => (s === 'connected' ? true : M.NO_DATA.has(s) ? null : false) }];
  const s = t => t / 1000;
  const hist = { 'sensor.ap_state': [
    { s: 'connected', lu: s(NOW - 30 * HOUR) },
    { s: 'disconnected', lu: s(NOW - 3 * HOUR - 5 * MIN) }, { s: 'connected', lu: s(NOW - 3 * HOUR) },
    { s: 'disconnected', lu: s(NOW - 90 * MIN) }, { s: 'connected', lu: s(NOW - 30 * MIN) },
    { s: 'unavailable', lu: s(NOW - 25 * MIN) },
  ] };
  const u = M.uptime(tr, hist, NOW);
  const b = u.rows[0].blocks;
  assert.equal(b.length, 48);
  assert.equal(b[0], 'u');
  assert.equal(b[41], 'w', 'five minutes down in a block');
  assert.deepEqual(b.slice(45, 47), ['d', 'd']);
  assert.equal(b[47], 'x', 'unavailable is no data');
  assert.ok(u.rows[0].pct > 90 && u.rows[0].pct < 100);
});

test('incidents: an outage lists the update installed just before it; a sleeping PC is only listed while offline', () => {
  const s = t => t / 1000;
  const trackers = [
    { key: 'c', name: 'Nextcloud', entities: ['sensor.nextcloud_app_state'], kind: 'container', up: v => (v === 'running' ? true : M.NO_DATA.has(v) ? null : false) },
    { key: 'pc', name: 'Desk PC', entity: 'sensor.pc_mem', kind: 'pc', up: v => (M.NO_DATA.has(v) ? null : true) },
  ];
  const hist = {
    'sensor.nextcloud_app_state': [{ s: 'running', lu: s(NOW - 3 * DAY) }, { s: 'exited', lu: s(NOW - DAY) }, { s: 'running', lu: s(NOW - DAY + 3 * MIN) }],
    'sensor.pc_mem': [{ s: '40', lu: s(NOW - 3 * DAY) }, { s: 'unavailable', lu: s(NOW - 2 * DAY) }, { s: '41', lu: s(NOW - 2 * DAY + 6 * HOUR) }, { s: 'unavailable', lu: s(NOW - 20 * MIN) }],
  };
  const changes = M.changes({
    'update.home_assistant_core_update': [
      { s: 'on', a: { installed_version: '2026.11.0' }, lu: s(NOW - DAY - 20 * MIN) },
      { s: 'off', a: { installed_version: '2026.11.1', friendly_name: 'Home Assistant Core Update' }, lu: s(NOW - DAY - 10 * MIN) },
    ],
  });
  assert.equal(changes.length, 1);
  const list = M.incidents(trackers, hist, changes, [], NOW);
  const cloud = list.find(i => i.subject === 'Nextcloud');
  assert.equal(cloud.end - cloud.start, 3 * MIN);
  assert.deepEqual(cloud.before, ['Home Assistant Core updated 2026.11.0 → 2026.11.1']);
  const pc = list.filter(i => i.subject === 'Desk PC');
  assert.equal(pc.length, 1, 'last night\'s sleep is not listed');
  assert.equal(pc[0].ongoing, true);
  assert.ok(list.some(i => i.kind === 'update'));
});

test('summary: nothing wrong, then one thing, then several', () => {
  const base = { hosts: [], containers: { list: [] }, network: { devices: [], wan: null }, backups: { level: 'ok' }, integrations: [], unifiError: null };
  assert.equal(M.summary(base, NOW).headline, 'Everything is normal');
  const one = M.summary({ ...base, network: { devices: [{ name: 'Garage AP', level: 'warn', state: 'disconnected', since: NOW - 2 * HOUR }], wan: null } }, NOW);
  assert.equal(one.headline, '1 thing needs a look');
  assert.match(one.detail, /Garage AP is disconnected \(2 h\)\. Everything else is normal\./);
  const many = M.summary({ ...base, network: { devices: [], wan: { up: false, status: 'error' } }, backups: { failed: true }, hosts: [{ name: 'PC', kind: 'pc', state: 'offline', level: 'warn', since: NOW - HOUR }], integrations: [{ domain: 'system_bridge', title: 'PC', state: 'setup_retry' }, { domain: 'hue', title: 'Hue', state: 'setup_error' }] }, NOW);
  assert.equal(many.level, 'bad');
  assert.equal(many.needs.length, 4, 'System Bridge failing is the same problem as the PC offline');
});

test('updates: grouped by where they come from; disabled entities left out', () => {
  const entities = [ent('update.home_assistant_core_update', 'hassio'), ent('update.x_grafana_image_update_available', 'portainer'), { entity_id: 'update.off', platform: 'hassio', disabled_by: 'user' }];
  const states = [
    st('update.home_assistant_core_update', 'off', { installed_version: '1', latest_version: '1', title: 'Home Assistant Core' }),
    st('update.x_grafana_image_update_available', 'on', { installed_version: 'a', latest_version: 'b', friendly_name: 'grafana Image update available' }),
    st('update.off', 'on'),
  ];
  const u = M.updates(world({ states, entities }));
  assert.equal(u.total, 2);
  assert.deepEqual(u.pending.map(p => [p.title, p.group]), [['grafana', 'Container images']]);
});
