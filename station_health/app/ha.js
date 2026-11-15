'use strict';
// Reads Home Assistant, read only, with the token the Supervisor gives the app
// (homeassistant_api and hassio_api in config.yaml):
//
//   - Core WebSocket API: states, the entity, device and config entry
//     registries, and Recorder history. Every message sent is a read; the app
//     never calls a service.
//   - Supervisor REST API: the /info endpoints (host uptime and disk, versions),
//     which the default Supervisor role allows.
//
// The token never reaches the browser. Outside Home Assistant, HA_WS_URL and
// SUPERVISOR_URL point at stand-ins (the tests use tests/fixtures/fake-world.js).

const fs = require('fs');

// s6-overlay starts the app with a cleaned environment, so a variable the
// container has (the Supervisor's token, the image's APP_VERSION) may only be
// in s6's saved copy.
function containerEnv(name) {
  if (process.env[name]) return process.env[name];
  for (const dir of ['/run/s6/container_environment', '/var/run/s6/container_environment']) {
    try {
      const value = fs.readFileSync(`${dir}/${name}`, 'utf8').trim();
      if (value) return value;
    } catch { /* not there */ }
  }
  return '';
}

const supervisorToken = () => containerEnv('SUPERVISOR_TOKEN') || containerEnv('HASSIO_TOKEN');

class HaError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'HaError'; this.status = status; }
}

// The only WebSocket message types the app sends. Anything else is refused
// here, so a mistake can't turn into a service call.
const READ_ONLY = new Set([
  'get_states', 'get_config', 'config/entity_registry/list', 'config/device_registry/list',
  'config_entries/get', 'history/history_during_period',
]);

class HomeAssistant {
  constructor({
    wsUrl = process.env.HA_WS_URL || 'ws://supervisor/core/websocket',
    supervisorUrl = process.env.SUPERVISOR_URL || 'http://supervisor',
    token = supervisorToken(),
    WebSocketImpl = globalThis.WebSocket,
    timeoutMs = 20_000,
  } = {}) {
    Object.assign(this, { wsUrl, supervisorUrl: supervisorUrl.replace(/\/+$/, ''), token, WebSocketImpl, timeoutMs });
    this.available = Boolean(token);
    this.ws = null;
    this.ready = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  connect() {
    if (this.ready) return this.ready;
    if (!this.available) return Promise.reject(new HaError('Not running inside Home Assistant, so there is no Home Assistant to read.'));
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      const fail = err => {
        if (!settled) { settled = true; reject(err); }
        this.drop(err);
      };
      let ws;
      try { ws = new this.WebSocketImpl(this.wsUrl); } catch (e) { return fail(new HaError(`Can't reach Home Assistant (${e.message}).`)); }
      this.ws = ws;
      const timer = setTimeout(() => { fail(new HaError('Home Assistant did not answer in time.')); try { ws.close(); } catch { /* closing anyway */ } }, this.timeoutMs);
      ws.onmessage = ev => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
        if (msg.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: this.token }));
        else if (msg.type === 'auth_ok') { clearTimeout(timer); settled = true; resolve(); }
        else if (msg.type === 'auth_invalid') { clearTimeout(timer); fail(new HaError('Home Assistant refused the app. Restart the app so the Supervisor issues a fresh token.', 401)); }
        else if (msg.type === 'result' && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.success) p.resolve(msg.result);
          else p.reject(new HaError(`Home Assistant: ${msg.error?.message || 'request failed'}`));
        }
      };
      ws.onerror = () => { clearTimeout(timer); fail(new HaError("Can't reach Home Assistant.")); };
      ws.onclose = () => { clearTimeout(timer); fail(new HaError('The connection to Home Assistant closed.')); };
    });
    return this.ready;
  }

  drop(err) {
    this.ready = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onclose = ws.onerror = ws.onmessage = null; try { ws.close(); } catch { /* already closed */ } }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  async call(type, payload = {}) {
    if (!READ_ONLY.has(type)) throw new HaError(`Refused to send "${type}": the app only reads.`);
    await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HaError('Home Assistant did not answer in time.'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, type, ...payload })); } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new HaError(`Can't reach Home Assistant (${e.message}).`));
      }
    });
  }

  states() { return this.call('get_states'); }
  config() { return this.call('get_config'); }
  entities() { return this.call('config/entity_registry/list'); }
  devices() { return this.call('config/device_registry/list'); }
  configEntries() { return this.call('config_entries/get'); }

  // Recorder history. Returns { entity_id: [{ s, lu }, …] } (compressed form).
  history(entityIds, start, end, { attributes = false } = {}) {
    if (!entityIds.length) return Promise.resolve({});
    return this.call('history/history_during_period', {
      start_time: start.toISOString(), end_time: end.toISOString(), entity_ids: entityIds,
      minimal_response: !attributes, no_attributes: !attributes, significant_changes_only: false,
    });
  }

  // Supervisor /info endpoints. Returns the data object, or throws.
  async supervisor(path) {
    if (!this.available) throw new HaError('Not running inside Home Assistant.');
    if (!/^\/(host|os|core|supervisor)?\/?info$/.test(path)) throw new HaError(`Refused to read ${path}.`);
    let r;
    try {
      r = await fetch(`${this.supervisorUrl}${path}`, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new HaError(e.name === 'TimeoutError' ? 'The Supervisor did not answer in time.' : "Can't reach the Supervisor.");
    }
    if (!r.ok) throw new HaError(`The Supervisor answered HTTP ${r.status}.`, r.status);
    const j = await r.json();
    return j?.data ?? j;
  }

  close() { this.drop(new HaError('closed')); }
}

module.exports = { HomeAssistant, HaError, supervisorToken, containerEnv, READ_ONLY };
