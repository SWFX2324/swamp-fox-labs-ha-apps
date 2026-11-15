'use strict';
// Preloaded into the server (node --require) for the end-to-end tests, the
// container smoke test and local previews. Stands in for Home Assistant's
// WebSocket and Supervisor APIs and for a UniFi console, so nothing real is
// touched. Any other outside request is refused and logged as UNMOCKED.
//
// The made-up home has a mini PC running Home Assistant, a Synology NAS
// running Docker (Portainer), a desktop PC with System Bridge, and a UniFi
// gateway, two switches, two access points and three networks.
//
// FAKE_WORLD can hold several comma-separated switches:
//   ha_down        Home Assistant refuses the WebSocket connection
//   pc_off         the PC's System Bridge sensors are unavailable (40 min)
//   container_down the "syncthing" container has exited
//   ap_down        the "Garage AP" is disconnected
//   wan_down       the UniFi console reports the WAN down
//   unifi_down     the UniFi console doesn't answer
//   unifi_badauth  the UniFi console refuses the sign-in
//   backup_failed  the last automatic backup attempt failed
//   bare           a plain Home Assistant: no UniFi, NAS, PC or Portainer
// FAKE_WORLD_LOG=1 logs each request.

// In the container, s6-overlay starts the app with a cleaned environment, so
// FAKE_WORLD may only be in s6's saved copy (as the Supervisor token is).
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

process.env.SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN || 'fake-token';
process.env.HA_WS_URL = 'ws://fake-supervisor/core/websocket';
process.env.SUPERVISOR_URL = 'http://fake-supervisor';
if (!process.env.OPTIONS_JSON && !process.env.NO_FAKE_UNIFI) {
  process.env.OPTIONS_JSON = JSON.stringify({ unifi_host: '192.168.1.1', unifi_username: 'viewer', unifi_password: 'fake-unifi-password', unifi_site: 'default', unifi_verify_ssl: false });
}

// ---- Home Assistant registries and states ----------------------------------------

const devices = [], entities = [], states = [];
let n = 0;
function device(name, model, platform, extra = {}) {
  const d = { id: `dev${++n}`, name, name_by_user: null, model, manufacturer: platform, via_device_id: null, config_entries: [`entry_${platform}`], ...extra };
  devices.push(d);
  return d;
}
function entity(d, entity_id, state, attributes = {}, { platform = d?.manufacturer, changedAgo = 3 * HOUR } = {}) {
  entities.push({ entity_id, platform, device_id: d?.id || null, config_entry_id: d ? `entry_${platform}` : null, disabled_by: null });
  states.push({ entity_id, state: String(state), attributes, last_changed: iso(T0 - changedAgo), last_updated: iso(T0 - changedAgo) });
}

// Portainer: an endpoint and its containers.
const endpoint = device('local', 'Endpoint', 'portainer');
// Made-up containers: two compose stacks (underscore and hyphen naming) and
// some single ones.
const containerList = [
  ['nextcloud_app', 610, 1.2], ['nextcloud_db', 240, 0.6], ['nextcloud_redis', 18, 0.3],
  ['paperless-web-1', 380, 0.9], ['paperless-broker-1', 22, 0.1],
  ['pihole', 95, 0.4], ['uptime-kuma', 120, 0.7], ['grafana', 160, 0.5], ['syncthing', 75, 0.2],
  ['homebox', 30, 0.0], ['portainer', 55, 0.1],
];
const LIMIT = 7860.5, SMALL_LIMIT = 512;
for (const [name, mem, cpu] of containerList) {
  const d = device(name, 'Container', 'portainer', { via_device_id: endpoint.id });
  const id = name.replace(/-/g, '_');
  const down = name === 'syncthing' && switches.has('container_down');
  const limit = name.startsWith('paperless') ? SMALL_LIMIT : LIMIT;
  entity(d, `sensor.nas_${id}_state`, down ? 'exited' : 'running', { device_class: 'enum' }, { changedAgo: down ? 25 * MIN : 2 * DAY });
  entity(d, `sensor.nas_${id}_cpu_usage_total`, down ? 0 : cpu);
  entity(d, `sensor.nas_${id}_memory_usage`, down ? 0 : mem, { unit_of_measurement: 'MB' });
  entity(d, `sensor.nas_${id}_memory_limit`, limit, { unit_of_measurement: 'MB' });
  entity(d, `sensor.nas_${id}_memory_usage_percentage`, down ? 0 : Math.round((mem / limit) * 1000) / 10, { unit_of_measurement: '%' });
  entity(d, `sensor.nas_${id}_started`, iso(T0 - 2 * DAY - 3 * HOUR));
  entity(d, `sensor.nas_${id}_restart_count`, 0);
  entity(d, `event.nas_${id}_docker_event`, iso(T0 - (name.startsWith('nextcloud') ? 2 * DAY : 4 * DAY)), { event_type: name.startsWith('nextcloud') ? 'restart' : 'start', friendly_name: `${name} Docker event` });
  entity(d, `update.nas_${id}_image_update_available`, name === 'grafana' ? 'on' : 'off', { installed_version: 'a1b2c3', latest_version: name === 'grafana' ? 'd4e5f6' : 'a1b2c3', friendly_name: `${name} Image update available` });
}

// Synology NAS with a volume and two drives.
const nas = device('NAS', 'DS923+', 'synology_dsm');
entity(nas, 'sensor.nas_cpu_utilization_total', 14, { unit_of_measurement: '%' });
entity(nas, 'sensor.nas_memory_usage_real', 38, { unit_of_measurement: '%' });
entity(nas, 'sensor.nas_temperature', 104, { unit_of_measurement: '°F' });
entity(nas, 'update.nas_dsm_update', 'off', { installed_version: '7.3.1', latest_version: '7.3.1', friendly_name: 'NAS DSM update' });
const vol = device('NAS (Volume 1)', 'DS923+', 'synology_dsm', { via_device_id: nas.id });
entity(vol, 'sensor.nas_volume_1_status', 'normal');
entity(vol, 'sensor.nas_volume_1_volume_used', 58.2, { unit_of_measurement: '%' });
for (const i of [1, 2]) {
  const dr = device(`NAS (Drive ${i})`, 'WD80EFPX', 'synology_dsm', { via_device_id: nas.id });
  entity(dr, `sensor.nas_drive_${i}_status`, 'normal');
}

// A desktop PC with System Bridge.
const pc = device('Desk PC', 'Windows', 'system_bridge');
const pcOff = switches.has('pc_off');
const pcVal = v => (pcOff ? 'unavailable' : v);
entity(pc, 'sensor.desk_pc_load', pcVal(12), { unit_of_measurement: '%' }, { changedAgo: pcOff ? 40 * MIN : 10 * MIN });
entity(pc, 'sensor.desk_pc_memory_usage', pcVal(48), { unit_of_measurement: '%' }, { changedAgo: pcOff ? 40 * MIN : 10 * MIN });
entity(pc, 'sensor.desk_pc_c_space_used', pcVal(61), { unit_of_measurement: '%' }, { changedAgo: pcOff ? 40 * MIN : 10 * MIN });
entity(pc, 'sensor.desk_pc_boot_time', pcVal(iso(T0 - 26 * HOUR)));
entity(pc, 'update.desk_pc', pcVal('off'), { installed_version: '5.2.0', latest_version: '5.2.0' });

// UniFi (Home Assistant's integration): gateway, switches, APs, Wi-Fi networks.
const unifiGear = [
  ['Router', 'UDMPRO', null], ['Core Switch', 'USL16LP', '02:00:00:00:00:01'], ['Small Switch', 'US8P60', '02:00:00:00:00:02'],
  ['Upstairs AP', 'U6LR', '02:00:00:00:00:02'], ['Garage AP', 'U6PRO', '02:00:00:00:00:02'],
];
for (const [name, model, uplink] of unifiGear) {
  const d = device(name, model, 'unifi');
  const id = name.toLowerCase().replace(/\s+/g, '_');
  const down = name === 'Garage AP' && switches.has('ap_down');
  entity(d, `sensor.${id}_state`, down ? 'disconnected' : 'connected', { device_class: 'enum' }, { changedAgo: down ? 90 * MIN : 3 * DAY });
  entity(d, `sensor.${id}_uptime`, down ? 'unknown' : iso(T0 - 3 * DAY));
  if (uplink) entity(d, `sensor.${id}_uplink_mac`, uplink);
  if (!down) {
    entity(d, `sensor.${id}_cpu_utilization`, model === 'UDMPRO' ? 22 : 7, { unit_of_measurement: '%' });
    entity(d, `sensor.${id}_memory_utilization`, model === 'UDMPRO' ? 58 : 45, { unit_of_measurement: '%' });
  }
  entity(d, `update.${id}_firmware`, name === 'Upstairs AP' ? 'on' : 'off', { installed_version: '6.7.31', latest_version: name === 'Upstairs AP' ? '6.7.41' : '6.7.31', friendly_name: `${name} Firmware` });
}
for (const [ssid, c] of [['Home', 14], ['Things', 19], ['Guests', 0]]) {
  const d = device(ssid, 'UniFi WLAN', 'unifi');
  entity(d, `sensor.${ssid.toLowerCase()}_clients`, c, { state_class: 'measurement' });
}

// Home Assistant's own updates and backups.
for (const [id, name, inst, latest] of [['home_assistant_core_update', 'Home Assistant Core', '2026.11.1', '2026.11.1'], ['home_assistant_operating_system_update', 'Home Assistant Operating System', '17.0', '17.0'], ['home_assistant_supervisor_update', 'Home Assistant Supervisor', '2026.11.0', '2026.11.0'], ['station_health_update', 'Station Health', '1.0.0', '1.0.0'], ['samba_share_update', 'Samba share', '12.5.4', '12.5.4']]) {
  entity(null, `update.${id}`, inst === latest ? 'off' : 'on', { installed_version: inst, latest_version: latest, friendly_name: `${name} Update`, title: name }, { platform: 'hassio' });
}
const lastOk = T0 - (switches.has('backup_failed') ? 26 * HOUR : 3 * HOUR);
entity(null, 'sensor.backup_last_successful_automatic_backup', iso(lastOk), {}, { platform: 'backup' });
entity(null, 'sensor.backup_last_attempted_automatic_backup', iso(switches.has('backup_failed') ? T0 - 2 * HOUR : lastOk - 3 * MIN), {}, { platform: 'backup' });
entity(null, 'sensor.backup_next_scheduled_automatic_backup', iso(T0 + 21 * HOUR), {}, { platform: 'backup' });
entity(null, 'sensor.backup_last_successful_automatic_backup_size', 1210.5, { unit_of_measurement: 'MB' }, { platform: 'backup' });
entity(null, 'sensor.backup_backup_manager_state', 'idle', {}, { platform: 'backup' });
// A disabled entity, which must not show up anywhere.
entities.push({ entity_id: 'update.disabled_thing', platform: 'hassio', device_id: null, disabled_by: 'user' });
states.push({ entity_id: 'update.disabled_thing', state: 'on', attributes: { friendly_name: 'Disabled thing' }, last_changed: iso(T0), last_updated: iso(T0) });

const entries = ['portainer', 'synology_dsm', 'system_bridge', 'unifi', 'hassio', 'backup'].map(domain => ({
  entry_id: `entry_${domain}`, domain, title: domain === 'unifi' ? 'Default' : domain, state: domain === 'system_bridge' && pcOff ? 'setup_retry' : 'loaded', disabled_by: null, reason: null,
}));
for (const d of devices) d.config_entries = [`entry_${d.manufacturer}`];

// A plain Home Assistant: drop every integration the app can show beyond its own.
if (switches.has('bare')) {
  const gone = new Set(['portainer', 'synology_dsm', 'system_bridge', 'unifi']);
  const keep = e => !gone.has(e.platform);
  const ids = new Set(entities.filter(keep).map(e => e.entity_id));
  for (const list of [entities, states]) for (let i = list.length - 1; i >= 0; i--) if (!ids.has(list[i].entity_id)) list.splice(i, 1);
  for (let i = devices.length - 1; i >= 0; i--) if (gone.has(devices[i].manufacturer)) devices.splice(i, 1);
  for (let i = entries.length - 1; i >= 0; i--) if (gone.has(entries[i].domain)) entries.splice(i, 1);
}

// ---- Recorder history -------------------------------------------------------------

// Compressed form ({ s, lu }) as minimal_response returns it; with attributes
// ({ s, a, lu }) otherwise. Seven days: a few outages so the chart and the log
// have something to show.
function historyFor(ids, start, end, withAttributes) {
  const out = {};
  const sec = t => t / 1000;
  for (const id of ids) {
    const st = states.find(s => s.entity_id === id);
    if (!st) continue;
    const rows = [];
    const push = (t, s, a) => rows.push(withAttributes ? { s, a: a || st.attributes, lu: sec(t) } : { s, lu: sec(t) });
    if (id === 'sensor.desk_pc_memory_usage') {
      // Asleep every night 01:00-07:00 (local-ish), plus the current state.
      push(start, '45');
      for (let d = 6; d >= 1; d--) { push(T0 - d * DAY - 8 * HOUR, 'unavailable'); push(T0 - d * DAY - 2 * HOUR, '41'); }
      if (pcOff) push(T0 - 40 * MIN, 'unavailable');
    } else if (id === 'sensor.garage_ap_state') {
      push(start, 'connected');
      push(T0 - 3 * DAY - 5 * HOUR, 'disconnected'); push(T0 - 3 * DAY - 5 * HOUR + 4 * MIN, 'connected');
      if (switches.has('ap_down')) push(T0 - 90 * MIN, 'disconnected');
    } else if (id === 'sensor.nas_nextcloud_app_state') {
      push(start, 'running');
      push(T0 - 2 * DAY - 10 * MIN, 'exited'); push(T0 - 2 * DAY - 7 * MIN, 'running');
    } else if (id === 'sensor.nas_syncthing_state' && switches.has('container_down')) {
      push(start, 'running'); push(T0 - 25 * MIN, 'exited');
    } else if (id === 'update.home_assistant_core_update') {
      push(start, 'off', { ...st.attributes, installed_version: '2026.11.0', latest_version: '2026.11.0' });
      push(T0 - 2 * DAY - 14 * MIN, 'on', { ...st.attributes, installed_version: '2026.11.0' });
      push(T0 - 2 * DAY - 12 * MIN, 'off', st.attributes);
    } else {
      push(start, st.state);
    }
    out[id] = rows.filter(r => r.lu * 1000 <= end);
  }
  return out;
}

// ---- WebSocket stand-in -------------------------------------------------------------

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
    log('ws', msg.type);
    if (msg.type === 'auth') return this.recv(msg.access_token === process.env.SUPERVISOR_TOKEN ? { type: 'auth_ok' } : { type: 'auth_invalid' });
    const ok = result => this.recv({ id: msg.id, type: 'result', success: true, result });
    switch (msg.type) {
      case 'get_states': return ok(states);
      case 'get_config': return ok({ unit_system: { temperature: '°F' }, time_zone: 'America/New_York', location_name: 'Home' });
      case 'config/entity_registry/list': return ok(entities);
      case 'config/device_registry/list': return ok(devices);
      case 'config_entries/get': return ok(entries);
      case 'history/history_during_period': return ok(historyFor(msg.entity_ids, Date.parse(msg.start_time), Date.parse(msg.end_time), !msg.no_attributes));
      default:
        console.error('UNMOCKED websocket message', msg.type);
        return this.recv({ id: msg.id, type: 'result', success: false, error: { message: 'unknown command' } });
    }
  }
  close() { this.onclose?.({}); }
}
globalThis.WebSocket = FakeWebSocket;

// ---- Supervisor REST ------------------------------------------------------------------

const realFetch = globalThis.fetch;
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, init) => {
  const url = String(input?.url || input);
  log('fetch', url);
  if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return realFetch(input, init);
  if (url.startsWith('http://fake-supervisor/')) {
    const p = new URL(url).pathname;
    const data = {
      '/info': { machine: 'generic-x86-64', homeassistant: '2026.11.1', hassos: '17.0', supervisor: '2026.11.0' },
      '/host/info': { hostname: 'homeassistant', disk_total: 236.4, disk_used: 61.8, disk_free: 174.6, boot_timestamp: (T0 - 52 * HOUR) * 1000 },
      '/os/info': { version: '17.0', board: 'generic-x86-64' },
      '/core/info': { version: '2026.11.1', machine: 'generic-x86-64' },
    }[p];
    return data ? reply(200, { result: 'ok', data }) : reply(404, { result: 'error' });
  }
  console.error('UNMOCKED fetch', url);
  return reply(599, { error: 'unmocked' });
};

// ---- UniFi console ------------------------------------------------------------------------

// The same module the server loads: unifi.js beside the server script (app/ in
// the repository, /app in the container).
const unifiModule = require(require('path').join(require('path').dirname(require('path').resolve(process.argv[1])), 'unifi.js'));
const SESSION = 'TOKEN=fake-session';
const bytesR = mbps => Math.round((mbps * 1e6) / 8);
function unifiData(endpoint) {
  const now = Date.now() / 1000;
  switch (endpoint) {
    case 'stat/health': return [
      { subsystem: 'wan', status: switches.has('wan_down') ? 'error' : 'ok', isp_name: 'Example Fiber', 'rx_bytes-r': bytesR(184), 'tx_bytes-r': bytesR(22), gw_name: 'Router' },
      { subsystem: 'www', status: switches.has('wan_down') ? 'error' : 'ok', latency: 18, drops: 0, uptime: 18 * 86400 + 6 * 3600, xput_down: 912.4, xput_up: 38.1, speedtest_ping: 11, speedtest_lastrun: Math.round(now - 8 * 3600) },
      { subsystem: 'wlan', status: 'ok', num_user: 33 },
    ];
    case 'rest/networkconf': return [
      { _id: 'n1', name: 'Default', purpose: 'corporate', ip_subnet: '192.168.1.1/24', enabled: true },
      { _id: 'n2', name: 'Servers', purpose: 'corporate', vlan_enabled: true, vlan: '20', ip_subnet: '192.168.20.1/24', enabled: true },
      { _id: 'n3', name: 'IoT', purpose: 'corporate', vlan_enabled: true, vlan: '30', ip_subnet: '192.168.30.1/24', enabled: true },
      { _id: 'n4', name: 'Internet', purpose: 'wan' },
    ];
    case 'stat/sta': {
      const c = (name, net, wired, mbps, extra = {}) => ({ name, network_id: net, is_wired: wired, 'tx_bytes-r': bytesR(mbps * 0.8), 'rx_bytes-r': bytesR(mbps * 0.2), first_seen: Math.round(now - 90 * 86400), ap_mac: wired ? undefined : '02:00:00:00:00:10', ...extra });
      const list = [
        c('Living room TV', 'n1', false, 61), c('Phone', 'n1', false, 12), c('Laptop', 'n1', false, 4), c('Desk PC', 'n1', true, 9),
        c('NAS', 'n2', true, 64), c('homeassistant', 'n2', true, 3), c('Backup box', 'n2', true, 1),
        c('Doorbell', 'n3', false, 9), c('Porch camera', 'n3', false, 6), c('Thermostat', 'n3', false, 0.01),
        { hostname: 'ESP-3A1F', mac: 'aa:bb:cc:00:3a:1f', network: 'IoT', is_wired: false, 'tx_bytes-r': 100, 'rx_bytes-r': 50, first_seen: Math.round(now - 5 * 3600), ip: '192.168.30.87', ap_mac: '02:00:00:00:00:10' },
      ];
      for (let i = 0; i < 10; i++) list.push(c(`Bulb ${i + 1}`, 'n3', false, 0));
      for (let i = 0; i < 6; i++) list.push(c(`Tablet ${i + 1}`, 'n1', false, 0.2));
      return list;
    }
    case 'stat/device': return [
      { mac: '02:00:00:00:00:01', name: 'Router', model: 'UDMPRO', type: 'udm', state: 1, uptime: 18 * 86400, 'system-stats': { cpu: '31.0', mem: '64.2' }, general_temperature: 47, num_sta: 41, 'tx_bytes-r': bytesR(22), 'rx_bytes-r': bytesR(184), version: '5.0.12', upgradable: false },
      { mac: '02:00:00:00:00:02', name: 'Core Switch', model: 'USL16LP', type: 'usw', state: 1, uptime: 3 * 86400, 'system-stats': { cpu: '10', mem: '83' }, general_temperature: 40, num_sta: 6, 'bytes-r': bytesR(170), version: '7.2.1', upgradable: false, total_used_power: 9.4, total_max_power: 46 },
      { mac: '02:00:00:00:00:03', name: 'Small Switch', model: 'US8P60', type: 'usw', state: 1, uptime: 3 * 86400, 'system-stats': { cpu: '3', mem: '80' }, num_sta: 2, 'bytes-r': bytesR(12), version: '2.1.6', upgradable: false },
      { mac: '02:00:00:00:00:10', name: 'Upstairs AP', model: 'U6LR', type: 'uap', state: 1, uptime: 3 * 86400, 'system-stats': { cpu: '55', mem: '40' }, num_sta: 19, 'tx_bytes-r': bytesR(70), 'rx_bytes-r': bytesR(18), version: '6.7.31', upgradable: true, upgrade_to_firmware: '6.7.41' },
      { mac: '02:00:00:00:00:11', name: 'Garage AP', model: 'U6PRO', type: 'uap', state: switches.has('ap_down') ? 0 : 1, uptime: switches.has('ap_down') ? 0 : 3 * 86400, last_seen: Math.round(now - 5400), 'system-stats': {}, num_sta: switches.has('ap_down') ? 0 : 14, version: '6.7.31', upgradable: false },
    ];
    default: return null;
  }
}
unifiModule.transport.request = async ({ host, method, path, headers, body }) => {
  log('unifi', method, path);
  if (host !== '192.168.1.1') { console.error('UNMOCKED unifi host', host); throw Object.assign(new Error('unmocked'), { code: 'ECONNREFUSED' }); }
  if (switches.has('unifi_down')) throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const res = (status, data, h = {}) => ({ status, headers: h, body: JSON.stringify(data) });
  if (method === 'POST' && path === '/api/auth/login') {
    const c = JSON.parse(body || '{}');
    if (switches.has('unifi_badauth') || c.username !== 'viewer' || c.password !== 'fake-unifi-password') return res(401, { error: 'bad credentials' });
    return res(200, { username: c.username }, { 'set-cookie': [`${SESSION}; path=/; httponly`], 'x-csrf-token': 'fake-csrf' });
  }
  if (method !== 'GET') { console.error('UNMOCKED unifi write', method, path); return res(405, {}); }
  if (headers.Cookie !== SESSION) return res(401, { meta: { rc: 'error', msg: 'api.err.LoginRequired' } });
  const m = path.match(/^\/proxy\/network\/api\/s\/default\/(.+)$/);
  const data = m && unifiData(m[1]);
  if (!data) { console.error('UNMOCKED unifi path', path); return res(404, {}); }
  return res(200, { meta: { rc: 'ok' }, data });
};

module.exports = { switches, states, entities, devices, entries };
