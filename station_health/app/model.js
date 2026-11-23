'use strict';
// Turns what Home Assistant and the UniFi console report into what the page
// shows. Pure functions, no I/O, so tests/model.test.js can feed them
// recorded-shape data.
//
// A missing value stays null (the page shows a dash), never 0.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---- small helpers -----------------------------------------------------------

const NO_DATA = new Set(['unavailable', 'unknown', 'none', '']);
const has = s => Boolean(s) && !NO_DATA.has(String(s.state).toLowerCase());
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}
const numState = s => (has(s) ? num(s.state) : null);
const round = (v, d = 1) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);
const clampPct = v => (v === null ? null : Math.max(0, Math.min(100, v)));
function ts(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v > 1e14 ? Math.round(v / 1000) : v > 1e11 ? v : Math.round(v * 1000);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
const tsState = s => (has(s) ? ts(s.state) : null);
const cToUnit = (c, unit) => (c === null ? null : unit === '°F' ? round(c * 9 / 5 + 32) : round(c));

// Registry lookups shared by every builder.
function indexHa({ states = [], entities = [], devices = [], entries = [] } = {}) {
  const stateBy = new Map(states.map(s => [s.entity_id, s]));
  const deviceBy = new Map(devices.map(d => [d.id, d]));
  const entryBy = new Map(entries.map(e => [e.entry_id, e]));
  const byDevice = new Map();
  const byPlatform = new Map();
  const platformOf = new Map();
  for (const e of entities) {
    if (e.disabled_by) continue;
    platformOf.set(e.entity_id, e.platform);
    if (e.device_id) { if (!byDevice.has(e.device_id)) byDevice.set(e.device_id, []); byDevice.get(e.device_id).push(e); }
    if (!byPlatform.has(e.platform)) byPlatform.set(e.platform, []);
    byPlatform.get(e.platform).push(e);
  }
  const deviceName = d => (d ? d.name_by_user || d.name || '' : '');
  // The state of the device's entity whose id matches re (first match).
  const pick = (deviceId, re) => {
    for (const e of byDevice.get(deviceId) || []) if (re.test(e.entity_id)) return stateBy.get(e.entity_id) || null;
    return null;
  };
  const entityOf = (deviceId, re) => (byDevice.get(deviceId) || []).find(e => re.test(e.entity_id))?.entity_id || null;
  const devicesOf = platform => [...new Set((byPlatform.get(platform) || []).map(e => e.device_id).filter(Boolean))].map(id => deviceBy.get(id)).filter(Boolean);
  return { stateBy, deviceBy, entryBy, byDevice, byPlatform, platformOf, deviceName, pick, entityOf, devicesOf, states, entries };
}

// ---- containers (Portainer) -----------------------------------------------------

const CONTAINER_OK = new Set(['running']);
const CONTAINER_BAD = new Set(['exited', 'dead', 'removing']);

function containers(ix) {
  const list = [];
  for (const d of ix.devicesOf('portainer')) {
    if (d.model !== 'Container') continue;
    const name = ix.deviceName(d);
    const state = ix.pick(d.id, /^sensor\..*_state$/);
    const ev = ix.pick(d.id, /^event\..*_docker_event$/);
    const upd = ix.pick(d.id, /^update\..*_image_update_available$/);
    const mem = numState(ix.pick(d.id, /_memory_usage$/));
    const limit = numState(ix.pick(d.id, /_memory_limit$/));
    const s = has(state) ? String(state.state) : null;
    list.push({
      name, stack: null, short: name,
      state: s,
      level: s === null ? 'unknown' : CONTAINER_OK.has(s) ? 'ok' : CONTAINER_BAD.has(s) ? 'bad' : 'warn',
      cpu: round(numState(ix.pick(d.id, /_cpu_usage_total$/)), 1),
      memMB: round(mem, 0),
      memPct: clampPct(round(numState(ix.pick(d.id, /_memory_usage_percentage$/)) ?? (mem !== null && limit ? (mem / limit) * 100 : null), 1)),
      started: tsState(ix.pick(d.id, /_started$/)),
      restarts: numState(ix.pick(d.id, /_restart_count$/)),
      lastEvent: has(ev) ? { at: ts(ev.state), type: ev.attributes?.event_type || null } : null,
      update: has(upd) ? upd.state === 'on' : null,
      stateEntity: state?.entity_id || ix.entityOf(d.id, /^sensor\..*_state$/),
      eventEntity: ix.entityOf(d.id, /^event\..*_docker_event$/),
    });
  }
  // Compose stacks: names sharing a prefix (nextcloud_app, nextcloud_db;
  // paperless-web-1, paperless-broker-1) are grouped under it.
  const base = c => c.name.replace(/[-_]\d+$/, '');
  const prefix = c => base(c).split(/[-_]/)[0];
  const counts = new Map();
  for (const c of list) counts.set(prefix(c), (counts.get(prefix(c)) || 0) + 1);
  for (const c of list) {
    const p = prefix(c);
    if (counts.get(p) > 1 && base(c) !== p) { c.stack = p; c.short = base(c).slice(p.length + 1).replace(/[-_]/g, ' '); }
  }
  const rank = { bad: 0, warn: 1, unknown: 2, ok: 3 };
  list.sort((a, b) => rank[a.level] - rank[b.level] || (a.stack || a.name).localeCompare(b.stack || b.name) || a.name.localeCompare(b.name));
  return {
    total: list.length,
    running: list.filter(c => c.state === 'running').length,
    list,
  };
}

// ---- hosts ------------------------------------------------------------------------

function boardName(machine = '') {
  const m = String(machine);
  const pi = m.match(/raspberrypi(\d)/);
  if (pi) return `Raspberry Pi ${pi[1]}`;
  if (/^(generic-x86-64|qemux86-64|intel-nuc)/.test(m)) return 'x86-64 PC';
  if (/^odroid/.test(m)) return 'ODROID';
  if (/^green/.test(m)) return 'Home Assistant Green';
  if (/^yellow/.test(m)) return 'Home Assistant Yellow';
  return m || null;
}

function metric(label, value, unit, pct = unit === '%' ? value : null) {
  return { label, value, unit, pct: clampPct(pct) };
}

function haHost(sup) {
  if (!sup) return null;
  const host = sup.host || {}, info = sup.info || {}, core = sup.core || {}, os = sup.os || {};
  const total = num(host.disk_total), used = num(host.disk_used);
  const diskPct = total && used !== null ? round((used / total) * 100, 0) : null;
  const boot = ts(host.boot_timestamp);
  return {
    id: 'home-assistant', name: 'Home Assistant', kind: 'ha',
    sub: [boardName(info.machine || core.machine || os.board), os.version ? `OS ${os.version}` : null, core.version ? `Core ${core.version}` : null].filter(Boolean).join(' · '),
    state: 'up', since: boot, level: diskPct !== null && diskPct >= 90 ? 'warn' : 'ok',
    metrics: [metric('Disk', diskPct, '%'), metric('Free', total && used !== null ? round(total - used, 0) : null, 'GB', null)],
    note: diskPct !== null && diskPct >= 90 ? `Disk is ${diskPct}% full.` : null,
  };
}

function synologyHosts(ix, entryState) {
  const out = [];
  for (const d of ix.devicesOf('synology_dsm')) {
    const cpuS = ix.pick(d.id, /_cpu_utilization_total$/);
    if (!cpuS && !ix.entityOf(d.id, /_cpu_utilization_total$/)) continue; // drives, volumes: not the NAS itself
    const name = ix.deviceName(d);
    const temp = ix.pick(d.id, /^sensor\.[a-z0-9_]+_temperature$/);
    // Volume and drive devices hang off the NAS (via_device_id).
    const children = [...ix.deviceBy.values()].filter(c => c.via_device_id === d.id);
    const statuses = [];
    let volUsed = null;
    for (const c of children) {
      const st = ix.pick(c.id, /_status$/);
      if (has(st)) statuses.push({ name: ix.deviceName(c).replace(name, '').replace(/[()]/g, '').trim() || ix.deviceName(c), state: String(st.state) });
      const vu = numState(ix.pick(c.id, /_volume_used$/));
      if (vu !== null && volUsed === null) volUsed = round(vu, 0);
    }
    const badDisks = statuses.filter(s => !['normal', 'background_scrubbing'].includes(s.state.toLowerCase()));
    const up = has(cpuS);
    const entry = entryState(d);
    out.push({
      id: d.id, name, kind: 'nas', sub: ['Synology', d.model].filter(Boolean).join(' '),
      state: up ? 'up' : 'down', since: up ? null : ts(cpuS?.last_changed),
      level: !up ? 'bad' : badDisks.length ? 'bad' : volUsed !== null && volUsed >= 90 ? 'warn' : 'ok',
      metrics: [
        metric('CPU', round(numState(cpuS), 0), '%'),
        metric('Mem', round(numState(ix.pick(d.id, /_memory_usage_real$/)), 0), '%'),
        metric('Volume', volUsed, '%'),
        metric('Temp', round(numState(temp), 1), temp?.attributes?.unit_of_measurement || '°', null),
      ],
      disks: statuses,
      note: !up ? (entry && entry !== 'loaded' ? `Home Assistant can't reach it (integration: ${entry.replace(/_/g, ' ')}).` : 'Not reporting.')
        : badDisks.length ? `${badDisks.map(s => `${s.name}: ${s.state.replace(/_/g, ' ')}`).join(', ')}.`
          : volUsed !== null && volUsed >= 90 ? `Volume is ${volUsed}% full.` : null,
      trackEntity: cpuS?.entity_id || ix.entityOf(d.id, /_cpu_utilization_total$/),
    });
  }
  return out;
}

function pcHosts(ix, entryState) {
  const out = [];
  for (const d of ix.devicesOf('system_bridge')) {
    const memE = ix.entityOf(d.id, /_memory_usage$/);
    if (!memE) continue;
    const mem = ix.stateBy.get(memE);
    const load = ix.pick(d.id, /^sensor\.[a-z0-9_]+_load$/);
    const disk = ix.pick(d.id, /^sensor\.[a-z0-9_]+_c_space_used$/);
    const boot = tsState(ix.pick(d.id, /_boot_time$/));
    const up = has(mem);
    const entry = entryState(d);
    out.push({
      id: d.id, name: ix.deviceName(d), kind: 'pc', sub: 'System Bridge',
      state: up ? 'up' : 'offline', since: up ? boot : ts(mem?.last_changed),
      level: up ? 'ok' : 'warn',
      metrics: [metric('CPU', round(numState(load), 0), '%'), metric('Mem', round(numState(mem), 0), '%'), metric('Disk C:', round(numState(disk), 0), '%')],
      note: up ? null : `Stopped reporting${entry && entry !== 'loaded' ? ` (integration: ${entry.replace(/_/g, ' ')})` : ''}. The PC may be asleep or off, or System Bridge isn't running on it.`,
      trackEntity: memE,
    });
  }
  return out;
}

function hosts(ix, sup) {
  const entryState = d => {
    for (const id of d.config_entries || []) { const e = ix.entryBy.get(id); if (e) return e.state; }
    return null;
  };
  return [haHost(sup), ...synologyHosts(ix, entryState), ...pcHosts(ix, entryState)].filter(Boolean);
}

// ---- UniFi ----------------------------------------------------------------------------

const UNIFI_STATE = { 0: 'disconnected', 1: 'connected', 2: 'pending', 4: 'upgrading', 5: 'provisioning', 6: 'heartbeat_missed', 7: 'adopting', 9: 'adoption_failed', 10: 'isolated', 11: 'isolated' };
const unifiLevel = (state, kind) => (state === 'connected' ? 'ok' : state === 'upgrading' || state === 'provisioning' ? 'warn' : state === null ? 'unknown' : kind === 'gateway' ? 'bad' : 'warn');
const kindOf = (type, model = '') => {
  if (['udm', 'ugw', 'uxg', 'gateway'].includes(type)) return 'gateway';
  if (type === 'usw' || /^US/.test(model)) return 'switch';
  return 'ap';
};

// From Home Assistant's UniFi integration: device state, CPU, memory, uptime,
// firmware, and clients per Wi-Fi network.
function unifiFromHa(ix, unit) {
  const devices = [], wlans = [];
  for (const d of ix.devicesOf('unifi')) {
    const name = ix.deviceName(d);
    if (d.model === 'UniFi WLAN') {
      const c = ix.pick(d.id, /_clients$/);
      wlans.push({ name, clients: numState(c) });
      continue;
    }
    const stateE = ix.entityOf(d.id, /^sensor\..*_state$/);
    if (!stateE) continue; // a client, not network gear
    const st = ix.stateBy.get(stateE);
    const fw = ix.pick(d.id, /^update\..*_firmware$/);
    const kind = ix.entityOf(d.id, /_uplink_mac$/) ? (/^US/.test(d.model || '') ? 'switch' : 'ap') : 'gateway';
    const state = has(st) ? String(st.state) : null;
    const temp = ix.pick(d.id, /_temperature$/);
    devices.push({
      name, kind, model: d.model || null, state, level: unifiLevel(state, kind),
      clients: null, rateBps: null,
      cpu: round(numState(ix.pick(d.id, /_cpu_utilization$/)), 0),
      mem: round(numState(ix.pick(d.id, /_memory_utilization$/)), 0),
      temp: round(numState(temp), 0), tempUnit: temp?.attributes?.unit_of_measurement || unit,
      since: state === 'connected' ? tsState(ix.pick(d.id, /_uptime$/)) : ts(st?.last_changed),
      firmware: has(fw) ? { installed: fw.attributes?.installed_version || null, latest: fw.attributes?.latest_version || null, update: fw.state === 'on' } : null,
      poe: null,
      trackEntity: stateE,
    });
  }
  const order = { gateway: 0, switch: 1, ap: 2 };
  devices.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
  wlans.sort((a, b) => (b.clients ?? -1) - (a.clients ?? -1));
  return { devices, wlans };
}

// "192.168.10.1/24" (the gateway form UniFi stores) -> "192.168.10.0/24".
function networkAddress(cidr) {
  const m = String(cidr || '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
  if (!m) return cidr || null;
  const bits = Number(m[5]);
  const ip = ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4];
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const n = (ip & mask) >>> 0;
  return `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}/${bits}`;
}

const clientName = c => c.name || c.hostname || (c.oui ? `${c.oui} device` : null) || c.mac || 'Unknown device';
const rateOf = o => {
  const tx = num(o['tx_bytes-r']), rx = num(o['rx_bytes-r']);
  if (tx === null && rx === null) { const b = num(o['bytes-r']); return b === null ? null : b * 8; }
  return ((tx || 0) + (rx || 0)) * 8;
};

// From the UniFi console: networks (VLANs) with their clients and traffic,
// the WAN, and every device with traffic, temperature and PoE.
function unifiFromApi(api, unit, now = Date.now()) {
  const health = api.health || [];
  const wanH = health.find(h => h.subsystem === 'wan') || null;
  const gwMac = wanH?.gw_mac || null;
  const www = health.find(h => h.subsystem === 'www') || null;

  const wan = wanH || www ? {
    up: (wanH?.status || www?.status) === 'ok',
    status: wanH?.status || www?.status || null,
    isp: wanH?.isp_name || wanH?.isp_organization || null,
    downBps: wanH ? num(wanH['rx_bytes-r']) * 8 : null,
    upBps: wanH ? num(wanH['tx_bytes-r']) * 8 : null,
    latencyMs: num(www?.latency) ?? num(wanH?.latency),
    drops: num(www?.drops),
    uptimeSince: num(www?.uptime) !== null ? now - num(www.uptime) * 1000 : null,
    speedtest: num(www?.xput_down) !== null ? { downMbps: round(num(www.xput_down), 0), upMbps: round(num(www.xput_up), 0), pingMs: num(www.speedtest_ping), at: ts(www.speedtest_lastrun) } : null,
  } : null;

  const nets = (api.networks || []).filter(n => n.enabled !== false && !['wan', 'remote-user-vpn', 'site-vpn', 'vpn-client', 'wireguard'].includes(n.purpose));
  const vlans = nets.map(n => ({
    id: n._id, name: n.name || 'Network', purpose: n.purpose || null,
    vlan: n.vlan_enabled && num(n.vlan) ? num(n.vlan) : n.purpose === 'corporate' && !num(n.vlan) ? 1 : num(n.vlan),
    subnet: networkAddress(n.ip_subnet),
    clients: 0, wired: 0, wifi: 0, rateBps: 0, top: [], newToday: [],
  }));
  const byId = new Map(vlans.map(v => [v.id, v]));
  const byName = new Map(vlans.map(v => [v.name, v]));
  const other = { id: 'other', name: 'Other', purpose: null, vlan: null, subnet: null, clients: 0, wired: 0, wifi: 0, rateBps: 0, top: [], newToday: [] };
  const newDevices = [];
  const perNet = new Map();
  for (const c of api.clients || []) {
    const v = byId.get(c.network_id) || byName.get(c.network) || other;
    v.clients++;
    if (c.is_wired) v.wired++; else v.wifi++;
    const r = rateOf(c);
    v.rateBps += r || 0;
    if (!perNet.has(v)) perNet.set(v, []);
    perNet.get(v).push({ name: clientName(c), rateBps: r, wired: Boolean(c.is_wired) });
    const first = ts(num(c.first_seen));
    if (first && now - first < DAY) {
      const item = { name: clientName(c), ip: c.ip || null, at: first, network: v.name, ap: c.ap_mac || null, wired: Boolean(c.is_wired) };
      v.newToday.push(item);
      newDevices.push(item);
    }
  }
  for (const [v, list] of perNet) v.top = list.sort((a, b) => (b.rateBps || 0) - (a.rateBps || 0)).slice(0, 3);
  if (other.clients) vlans.push(other);
  vlans.sort((a, b) => (a.vlan ?? 1e9) - (b.vlan ?? 1e9) || a.name.localeCompare(b.name));

  const apName = new Map((api.devices || []).map(d => [d.mac, d.name || d.model]));
  for (const n of newDevices) n.ap = n.ap ? apName.get(n.ap) || null : null;

  const devices = (api.devices || []).map(d => {
    // A UniFi Express reports itself as a gateway (type udm) even when it's
    // meshed in as an access point, so when the console names the WAN gateway,
    // only that device is the gateway.
    const typed = kindOf(d.type, d.model);
    const kind = gwMac ? (d.mac === gwMac ? 'gateway' : typed === 'gateway' ? 'ap' : typed) : typed;
    const state = UNIFI_STATE[d.state] || (d.state === undefined ? null : 'unknown');
    const temps = (d.temperatures || []).map(t => num(t.value)).filter(v => v !== null);
    const tempC = num(d.general_temperature) ?? (temps.length ? Math.max(...temps) : null);
    return {
      name: d.name || d.model || d.mac, kind, model: d.model || null, state, level: unifiLevel(state, kind),
      clients: num(d.num_sta) ?? num(d['user-num_sta']),
      rateBps: rateOf(d),
      cpu: round(num(d['system-stats']?.cpu), 0),
      mem: round(num(d['system-stats']?.mem), 0),
      temp: cToUnit(tempC, unit), tempUnit: unit,
      since: state === 'connected' && num(d.uptime) ? now - num(d.uptime) * 1000 : ts(num(d.last_seen)),
      firmware: { installed: d.version || null, latest: d.upgradable ? d.upgrade_to_firmware || 'newer' : d.version || null, update: Boolean(d.upgradable) },
      poe: num(d.total_max_power) ? { usedW: round(num(d.total_used_power) ?? 0, 0), maxW: round(num(d.total_max_power), 0) } : null,
      trackEntity: null,
    };
  });
  const order = { gateway: 0, switch: 1, ap: 2 };
  devices.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
  return { wan, vlans, devices, newDevices: newDevices.sort((a, b) => b.at - a.at), clients: (api.clients || []).length };
}

// The network section: console data when it's set up, with Home Assistant's
// entities filling in (device uptime history, Wi-Fi network clients).
function network(ix, api, unit, now) {
  const fromHa = unifiFromHa(ix, unit);
  if (!api) return { source: fromHa.devices.length ? 'ha' : null, wan: null, vlans: null, newDevices: [], clients: null, ...fromHa };
  const fromApi = unifiFromApi(api, unit, now);
  // Keep Home Assistant's entity for each device, for uptime history.
  const haBy = new Map(fromHa.devices.map(d => [d.name.toLowerCase(), d]));
  for (const d of fromApi.devices) d.trackEntity = haBy.get(d.name.toLowerCase())?.trackEntity || null;
  return { source: 'api', ...fromApi, wlans: fromHa.wlans };
}

// ---- updates, backups, integrations --------------------------------------------------------

const UPDATE_GROUP = {
  hassio: e => (/^update\.home_assistant_(core|supervisor|operating_system)_update$/.test(e) ? 'Home Assistant' : 'Apps'),
  hacs: () => 'HACS', marketplace: () => 'HACS', portainer: () => 'Container images', unifi: () => 'UniFi', synology_dsm: () => 'NAS', system_bridge: () => 'PC',
  raspberry_pi: () => 'Raspberry Pi',
};
// Groups shown together under a heading, in this order; anything else is a device of its own.
const UPDATE_SECTION = { 'Home Assistant': 'Home Assistant', Apps: 'Home Assistant', HACS: 'Home Assistant', UniFi: 'Network & storage', NAS: 'Network & storage', 'Container images': 'Containers' };
const SECTION_ORDER = ['Home Assistant', 'Devices', 'Network & storage', 'Containers'];
const GROUP_ORDER = ['Home Assistant', 'Apps', 'HACS', 'UniFi', 'NAS'];
const groupRank = n => (GROUP_ORDER.includes(n) ? GROUP_ORDER.indexOf(n) : GROUP_ORDER.length);

function updates(ix) {
  const items = [];
  for (const s of ix.states) {
    if (!s.entity_id.startsWith('update.')) continue;
    const platform = ix.platformOf.get(s.entity_id) ?? null;
    if (platform === null && ix.platformOf.size) continue; // disabled, or not in the registry
    const group = UPDATE_GROUP[platform]?.(s.entity_id) || (s.attributes?.friendly_name || platform || 'Other');
    items.push({
      entity: s.entity_id, title: (s.attributes?.title || s.attributes?.friendly_name || s.entity_id).replace(/\s+(update|firmware|image update available)$/i, ''),
      group, state: has(s) ? s.state : null,
      installed: s.attributes?.installed_version || null, latest: s.attributes?.latest_version || null,
    });
  }
  const groups = new Map();
  for (const u of items) {
    if (!groups.has(u.group)) groups.set(u.group, { name: u.group, section: UPDATE_SECTION[u.group] || 'Devices', total: 0, pending: 0, unknown: 0 });
    const g = groups.get(u.group);
    g.total++;
    if (u.state === 'on') g.pending++;
    if (u.state === null) g.unknown++;
  }
  return {
    total: items.length,
    pending: items.filter(u => u.state === 'on').map(({ entity, title, group, installed, latest }) => ({ entity, title, group, installed, latest })),
    groups: [...groups.values()].sort((a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section) || groupRank(a.name) - groupRank(b.name) || a.name.localeCompare(b.name)),
  };
}

function backups(ix, now) {
  const g = id => ix.stateBy.get(`sensor.backup_${id}`);
  const lastOk = tsState(g('last_successful_automatic_backup'));
  const lastTry = tsState(g('last_attempted_automatic_backup'));
  const next = tsState(g('next_scheduled_automatic_backup'));
  if (lastOk === null && lastTry === null && next === null) return null;
  const failed = lastTry !== null && (lastOk === null || lastTry - lastOk > 10 * MIN);
  const stale = lastOk !== null && now - lastOk > 2 * DAY;
  return {
    lastOk, lastTry, next, failed, stale,
    sizeMB: round(numState(g('last_successful_automatic_backup_size')), 0),
    state: has(g('backup_manager_state')) ? g('backup_manager_state').state : null,
    level: failed || stale || lastOk === null ? 'warn' : 'ok',
  };
}

const ENTRY_PROBLEM = new Set(['setup_error', 'setup_retry', 'migration_error', 'failed_unload']);
function integrations(ix) {
  return ix.entries
    .filter(e => !e.disabled_by && ENTRY_PROBLEM.has(e.state))
    .map(e => ({ domain: e.domain, title: e.title, state: e.state, reason: e.reason || null }));
}

// ---- uptime and incidents (from Recorder history) --------------------------------------

// Each tracked thing reads one entity; up() says whether a state is up (true),
// down (false) or tells nothing (null).
function trackers(snap) {
  const t = [];
  for (const h of snap.hosts) {
    if (h.trackEntity) t.push({ key: `host:${h.id}`, name: h.name, entity: h.trackEntity, kind: h.kind === 'pc' ? 'pc' : 'host', up: s => (NO_DATA.has(s) ? (h.kind === 'pc' ? null : false) : true) });
  }
  for (const d of snap.network.devices) {
    if (d.trackEntity) t.push({ key: `unifi:${d.name}`, name: d.name, entity: d.trackEntity, kind: 'unifi', up: s => (s === 'connected' ? true : NO_DATA.has(s) ? null : false) });
  }
  // One row per container, or per compose stack (down when any part is).
  const stacks = new Map();
  for (const c of snap.containers.list) {
    if (!c.stateEntity) continue;
    const k = c.stack || c.name;
    if (!stacks.has(k)) stacks.set(k, []);
    stacks.get(k).push(c.stateEntity);
  }
  for (const [name, entities] of stacks) {
    t.push({ key: `container:${name}`, name: name.charAt(0).toUpperCase() + name.slice(1), entities, kind: 'container', up: s => (s === 'running' ? true : NO_DATA.has(s) ? null : s === 'restarting' ? false : false) });
  }
  return t;
}

// History rows -> [{ t, s }] sorted, from the compressed or full form.
function timeline(rows = []) {
  return rows.map(r => ({ t: ts(r.lu ?? r.lc ?? r.last_updated ?? r.last_changed), s: String(r.s ?? r.state), a: r.a ?? r.attributes ?? null }))
    .filter(r => r.t !== null).sort((a, b) => a.t - b.t);
}

// Several entities (a compose stack) -> one up/down timeline: down whenever
// any part is down.
function combined(tracker, hist) {
  const lines = (tracker.entities || [tracker.entity]).map(e => timeline(hist[e]));
  if (lines.length === 1) return lines[0].map(r => ({ t: r.t, up: tracker.up(r.s) }));
  const times = [...new Set(lines.flatMap(l => l.map(r => r.t)))].sort((a, b) => a - b);
  const idx = lines.map(() => -1);
  return times.map(t => {
    const ups = lines.map((l, i) => { while (idx[i] + 1 < l.length && l[idx[i] + 1].t <= t) idx[i]++; return idx[i] < 0 ? null : tracker.up(l[idx[i]].s); });
    return { t, up: ups.includes(false) ? false : ups.every(u => u === null) ? null : true };
  });
}

function uptime(trackerList, hist, now, { hours = 24, blockMin = 30 } = {}) {
  const start = now - hours * HOUR;
  const blockMs = blockMin * MIN;
  const n = Math.round((hours * 60) / blockMin);
  const rows = trackerList.map(tr => {
    const line = combined(tr, hist);
    const down = new Array(n).fill(0), none = new Array(n).fill(0);
    let upMs = 0, downMs = 0;
    for (let i = 0; i < line.length; i++) {
      const from = Math.max(line[i].t, start), to = Math.min(i + 1 < line.length ? line[i + 1].t : now, now);
      if (to <= from) continue;
      const u = line[i].up;
      if (u === true) upMs += to - from; else if (u === false) downMs += to - from;
      if (u === true) continue;
      for (let b = Math.floor((from - start) / blockMs); b < n && start + b * blockMs < to; b++) {
        const bs = start + b * blockMs, overlap = Math.min(to, bs + blockMs) - Math.max(from, bs);
        if (overlap > 0) (u === false ? down : none)[b] += overlap;
      }
    }
    // Time before the first recorded state tells nothing.
    const first = line.length ? Math.max(line[0].t, start) : now;
    for (let b = 0; b < n; b++) {
      const bs = start + b * blockMs, before = Math.min(first, bs + blockMs) - bs;
      if (before > 0) none[b] += before;
    }
    const blocks = down.map((d, b) => (none[b] >= blockMs / 2 ? 'x' : d === 0 ? 'u' : d < blockMs / 2 ? 'w' : 'd'));
    return { key: tr.key, name: tr.name, kind: tr.kind, blocks, pct: upMs + downMs > 0 ? round((upMs / (upMs + downMs)) * 100, 1) : null };
  });
  return { start, blockMin, rows };
}

// Changes worth showing next to an outage: updates installed and container
// lifecycle events (from Recorder history with attributes).
function changes(hist, names = {}) {
  const out = [];
  for (const [entity, rows] of Object.entries(hist || {})) {
    const line = timeline(rows);
    if (entity.startsWith('update.')) {
      let prev = null;
      for (const r of line) {
        const v = r.a?.installed_version;
        if (v && prev && v !== prev) out.push({ t: r.t, kind: 'update', text: `${names[entity] || r.a?.friendly_name?.replace(/\s+(update|firmware)$/i, '') || entity} updated ${prev} → ${v}` });
        if (v) prev = v;
      }
    } else if (entity.startsWith('event.')) {
      for (const r of line) {
        const type = r.a?.event_type;
        if (!['die', 'kill', 'oom', 'restart', 'stop', 'start', 'health_status_unhealthy'].includes(type)) continue;
        const who = names[entity] || r.a?.friendly_name?.replace(/\s+Docker event$/i, '') || entity;
        out.push({ t: ts(r.s) ?? r.t, kind: type === 'oom' ? 'oom' : 'container', text: `${who}: ${type === 'oom' ? 'ran out of memory' : type.replace(/_/g, ' ')}` });
      }
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

function incidents(trackerList, hist, changeList, newDevices, now, { days = 7, mergeMs = 2 * MIN, minMs = MIN, limit = 30 } = {}) {
  const start = now - days * DAY;
  const out = [];
  for (const tr of trackerList) {
    const line = combined(tr, hist);
    let cur = null;
    const close = end => {
      if (!cur) return;
      cur.end = end;
      if ((end ?? now) - cur.start >= minMs) out.push(cur);
      cur = null;
    };
    let lastUp = null;
    for (let i = 0; i < line.length; i++) {
      const { t, up } = line[i];
      const down = up === false || (tr.kind === 'pc' && up === null && lastUp === true);
      if (down && !cur) {
        if (out.length && out[out.length - 1].key === tr.key && out[out.length - 1].end && t - out[out.length - 1].end < mergeMs) { cur = out.pop(); cur.end = null; }
        else cur = { key: tr.key, subject: tr.name, kind: tr.kind === 'pc' ? 'offline' : 'down', start: t, end: null };
      } else if (!down && cur && up === true) close(t);
      if (up !== null) lastUp = up;
      else if (tr.kind !== 'pc') lastUp = null;
    }
    if (cur) out.push(cur); // still going
  }
  // A PC that sleeps every night isn't news: only a PC offline right now is
  // listed (the uptime chart shows the rest).
  for (let i = out.length - 1; i >= 0; i--) if (out[i].kind === 'offline' && out[i].end !== null) out.splice(i, 1);
  for (const inc of out) {
    inc.ongoing = inc.end === null;
    inc.severity = inc.kind === 'offline' ? 'warn' : inc.ongoing ? 'bad' : 'serious';
    inc.before = changeList.filter(c => c.t <= inc.start && inc.start - c.t <= 15 * MIN && !c.text.startsWith(`${inc.subject}:`)).map(c => c.text).slice(-3);
  }
  for (const c of changeList) if (c.kind === 'update' || c.kind === 'oom') out.push({ key: `change:${c.t}`, subject: c.text, kind: c.kind, start: c.t, end: c.t, ongoing: false, severity: c.kind === 'oom' ? 'serious' : 'change', before: [] });
  for (const d of newDevices) out.push({ key: `new:${d.name}:${d.at}`, subject: `New device on ${d.network}: ${d.name}`, kind: 'new_device', start: d.at, end: d.at, ongoing: false, severity: 'info', before: [], detail: [d.ip, d.wired ? 'wired' : d.ap ? `via ${d.ap}` : null].filter(Boolean).join(' · ') });
  return out.filter(i => (i.end ?? now) >= start).sort((a, b) => (b.ongoing - a.ongoing) || b.start - a.start).slice(0, limit);
}

// ---- summary -------------------------------------------------------------------------------

const ago = ms => {
  const m = Math.round(ms / MIN);
  if (m < 60) return `${Math.max(m, 1)} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
};

// "System Bridge (192.168.1.20)" rather than an entry titled only by its address.
const DOMAIN_NAMES = { system_bridge: 'System Bridge', synology_dsm: 'Synology DSM', portainer: 'Portainer', unifi: 'UniFi Network', hassio: 'Supervisor' };
function integrationName(e) {
  const name = DOMAIN_NAMES[e.domain] || String(e.domain || 'Integration').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return e.title && e.title !== name ? `${name} (${e.title})` : name;
}

function summary(s, now) {
  const needs = [];
  for (const h of s.hosts) {
    if (h.level === 'ok') continue;
    if (h.kind === 'pc' && h.state === 'offline') needs.push({ level: 'warn', text: `${h.name} stopped reporting${h.since ? ` ${ago(now - h.since)} ago` : ''}.` });
    else if (h.note) needs.push({ level: h.level, text: `${h.name}: ${h.note}` });
  }
  const badC = s.containers.list.filter(c => c.level === 'bad' || c.level === 'warn');
  if (badC.length) needs.push({ level: badC.some(c => c.level === 'bad') ? 'bad' : 'warn', text: `${badC.length === 1 ? `Container ${badC[0].name} is` : `${badC.length} containers are`} ${badC.length === 1 ? badC[0].state : 'not running'}.` });
  if (s.network.wan && !s.network.wan.up) needs.push({ level: 'bad', text: `The internet connection is down (${s.network.wan.status || 'no status'}).` });
  for (const d of s.network.devices) if (!d.stored && d.level !== 'ok' && d.level !== 'unknown') needs.push({ level: d.level, text: `${d.name} is ${String(d.state).replace(/_/g, ' ')}${d.since ? ` (${ago(now - d.since)})` : ''}.` });
  if (s.backups?.failed) needs.push({ level: 'warn', text: 'The last automatic backup failed.' });
  else if (s.backups?.stale) needs.push({ level: 'warn', text: `The last good backup is ${ago(now - s.backups.lastOk)} old.` });
  const pcOffline = s.hosts.some(h => h.kind === 'pc' && h.state === 'offline');
  for (const e of s.integrations) {
    if (e.domain === 'system_bridge' && pcOffline) continue; // same problem, already listed
    needs.push({ level: 'warn', text: `${integrationName(e)} isn't working (${e.state.replace(/_/g, ' ')}).` });
  }
  if (s.unifiError) needs.push({ level: 'warn', text: `Can't read the UniFi console: ${s.unifiError}` });
  const level = needs.some(n => n.level === 'bad') ? 'bad' : needs.length ? 'warn' : 'ok';
  const headline = needs.length === 0 ? 'Everything is normal' : `${needs.length} Alert${needs.length === 1 ? '' : 's'}`;
  const detail = needs.length === 0 ? 'Everything Home Assistant reports on is working.' : needs.length === 1 ? `${needs[0].text} Everything else is normal.` : null;
  return { level, headline, detail, needs };
}

module.exports = {
  indexHa, containers, hosts, network, unifiFromHa, unifiFromApi, updates, backups, integrations,
  trackers, uptime, changes, incidents, summary, networkAddress, boardName, ts, num, timeline, NO_DATA,
};
