'use strict';
// Talks to Home Assistant with the token the Supervisor gives the app
// (homeassistant_api in config.yaml):
//
//   - Core WebSocket API: states, the entity and device registries and Recorder
//     history (reads), plus exactly two kinds of service call, both checked
//     here: button.press on a printer's Pause, Resume or Stop button,
//     light.turn_on and light.turn_off on its chamber light, and
//     bambu_lab.print_project_file. Nothing else can be sent.
//   - Core REST API: a camera snapshot of a printer's own camera.
//
// The token never reaches the browser. Outside Home Assistant, HA_WS_URL and
// HA_REST_URL point at stand-ins (the tests use tests/fixtures/fake-printer.js).

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

// WebSocket message types the app sends. call_service is further limited by
// SERVICES below; anything else is refused before it leaves the app.
const ALLOWED = new Set([
  'get_states', 'get_config', 'config/entity_registry/list', 'config/device_registry/list',
  'history/history_during_period', 'call_service',
]);
const SERVICES = new Set(['button.press', 'light.turn_on', 'light.turn_off', 'bambu_lab.print_project_file']);
const ENTITY_ID = /^[a-z_]+\.[a-z0-9_]+$/;

class HomeAssistant {
  constructor({
    wsUrl = process.env.HA_WS_URL || 'ws://supervisor/core/websocket',
    restUrl = process.env.HA_REST_URL || 'http://supervisor/core/api',
    token = supervisorToken(),
    WebSocketImpl = globalThis.WebSocket,
    timeoutMs = 20_000,
  } = {}) {
    Object.assign(this, { wsUrl, restUrl: restUrl.replace(/\/+$/, ''), token, WebSocketImpl, timeoutMs });
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
    if (!ALLOWED.has(type)) throw new HaError(`Refused to send "${type}".`);
    if (type === 'call_service') {
      const name = `${payload.domain}.${payload.service}`;
      if (!SERVICES.has(name)) throw new HaError(`Refused to call ${name}.`);
      if (name === 'button.press' && !(typeof payload.target?.entity_id === 'string' && ENTITY_ID.test(payload.target.entity_id) && payload.target.entity_id.startsWith('button.'))) {
        throw new HaError('Refused: button.press needs one button entity.');
      }
      if (payload.domain === 'light' && !(typeof payload.target?.entity_id === 'string' && ENTITY_ID.test(payload.target.entity_id) && payload.target.entity_id.startsWith('light.'))) {
        throw new HaError(`Refused: ${name} needs one light entity.`);
      }
      if (payload.domain === 'light' && payload.service_data !== undefined) throw new HaError(`Refused: ${name} takes no options here.`);
    }
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

  // Recorder history. Returns { entity_id: [{ s, lu }, …] } ({ s, a, lu } with
  // attributes; a row may carry only the attributes that changed).
  history(entityIds, start, end, { attributes = false } = {}) {
    if (!entityIds.length) return Promise.resolve({});
    return this.call('history/history_during_period', {
      start_time: start.toISOString(), end_time: end.toISOString(), entity_ids: entityIds,
      minimal_response: !attributes, no_attributes: !attributes, significant_changes_only: false,
    });
  }

  pressButton(entityId) {
    return this.call('call_service', { domain: 'button', service: 'press', target: { entity_id: entityId } });
  }

  setLight(entityId, on) {
    return this.call('call_service', { domain: 'light', service: on ? 'turn_on' : 'turn_off', target: { entity_id: entityId } });
  }

  printProjectFile(deviceId, data) {
    return this.call('call_service', { domain: 'bambu_lab', service: 'print_project_file', service_data: { device_id: deviceId, ...data } });
  }

  // A JPEG from a camera entity. Returns a Buffer, or throws.
  async cameraSnapshot(entityId) {
    if (!this.available) throw new HaError('Not running inside Home Assistant.');
    if (!ENTITY_ID.test(entityId) || !entityId.startsWith('camera.')) throw new HaError('Refused: not a camera.');
    let r;
    try {
      r = await fetch(`${this.restUrl}/camera_proxy/${entityId}`, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new HaError(e.name === 'TimeoutError' ? 'The camera did not answer in time.' : "Can't reach Home Assistant.");
    }
    if (!r.ok) throw new HaError(`The camera answered HTTP ${r.status}.`, r.status);
    return Buffer.from(await r.arrayBuffer());
  }

  close() { this.drop(new HaError('closed')); }
}

module.exports = { HomeAssistant, HaError, supervisorToken, containerEnv, ALLOWED, SERVICES };
