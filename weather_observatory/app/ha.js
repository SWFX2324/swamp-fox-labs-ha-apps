'use strict';
// Reads Home Assistant through the Core API the Supervisor provides to apps
// (homeassistant_api: true). Read only: states, the location from the core
// config, weather forecasts (weather.get_forecasts, which changes nothing) and
// Recorder history. The token never reaches the browser.
//
// Outside Home Assistant, HA_API_URL points at a stand-in (the tests use a
// fake one in tests/fixtures/fake-world.js).

const fs = require('fs');

// s6-overlay starts the app with a cleaned environment, so the token the
// Supervisor gives the container may only be in s6's saved copy.
function supervisorToken() {
  if (process.env.SUPERVISOR_TOKEN) return process.env.SUPERVISOR_TOKEN;
  for (const dir of ['/run/s6/container_environment', '/var/run/s6/container_environment']) {
    for (const name of ['SUPERVISOR_TOKEN', 'HASSIO_TOKEN']) {
      try {
        const token = fs.readFileSync(`${dir}/${name}`, 'utf8').trim();
        if (token) return token;
      } catch { /* not there */ }
    }
  }
  return process.env.HASSIO_TOKEN || '';
}

class HaError extends Error {
  constructor(message, status) { super(message); this.name = 'HaError'; this.status = status; }
}

class HomeAssistant {
  constructor({ base = process.env.HA_API_URL || 'http://supervisor/core/api', token = supervisorToken(), timeoutMs = 15_000 } = {}) {
    this.base = base.replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.available = Boolean(token || process.env.HA_API_URL);
  }

  async request(method, path, body) {
    if (!this.available) throw new HaError('Not running inside Home Assistant, so there is no Home Assistant to read.', 0);
    let r;
    try {
      r = await fetch(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new HaError(e.name === 'TimeoutError' ? 'Home Assistant did not answer in time.' : `Can't reach Home Assistant (${e.message}).`, 0);
    }
    if (r.status === 401 || r.status === 403) throw new HaError('Home Assistant refused the app. Restart the app so the Supervisor issues a fresh token.', r.status);
    if (r.status === 404) throw new HaError('Not found in Home Assistant.', 404);
    if (!r.ok) throw new HaError(`Home Assistant answered HTTP ${r.status}.`, r.status);
    return r.json();
  }

  // latitude, longitude, time_zone, unit_system, location_name
  config() { return this.request('GET', '/config'); }

  states() { return this.request('GET', '/states'); }

  state(entityId) { return this.request('GET', `/states/${encodeURIComponent(entityId)}`); }

  // type: 'hourly' | 'daily' | 'twice_daily'. Returns the list, or throws when
  // the entity doesn't offer that forecast type.
  async forecast(entityId, type) {
    const j = await this.request('POST', '/services/weather/get_forecasts?return_response', { entity_id: entityId, type });
    const list = j?.service_response?.[entityId]?.forecast;
    if (!Array.isArray(list)) throw new HaError(`${entityId} returned no ${type} forecast.`, 0);
    return list;
  }

  // Full states (with attributes) for one entity between two times.
  async history(entityId, start, end) {
    const q = new URLSearchParams({ filter_entity_id: entityId, end_time: end.toISOString(), significant_changes_only: '0' });
    const j = await this.request('GET', `/history/period/${encodeURIComponent(start.toISOString())}?${q}`);
    return Array.isArray(j?.[0]) ? j[0] : [];
  }
}

module.exports = { HomeAssistant, HaError, supervisorToken };
