'use strict';
// Every data source behind the page, each with its own cache, refresh time
// and error, so one failing never blanks another: a radar outage leaves the
// Home Assistant weather alone, and a failed alert check keeps the last good
// result but says the check failed rather than passing it off as fresh.
//
// Sources are refreshed only when someone has the page open (the page asks
// for /api/state), and all open pages share one cache, so public services see
// one app, not every browser tab.

const W = require('./static/wxcore');

const VERSION = process.env.APP_VERSION || 'dev';
const USER_AGENT = `HomeAssistant-WeatherObservatory/${VERSION} (+https://github.com/SWFX2324/swamp-fox-labs-ha-apps)`;
const MIN = 60_000;

class SourceError extends Error {}

// One cached value with its own lifetime. After a failure it waits retryMs
// before trying again, keeping the last good value meanwhile.
class Source {
  constructor(name, { ttl, retryMs = Math.min(ttl, 2 * MIN), load, now = Date.now }) {
    Object.assign(this, { name, ttl, retryMs, load, now });
    this.data = null;
    this.fetchedAt = null;
    this.error = null;
    this.errorAt = null;
    this.inflight = null;
  }

  due() {
    const t = this.now();
    if (this.errorAt && (!this.fetchedAt || this.errorAt > this.fetchedAt)) return t - this.errorAt >= this.retryMs;
    return !this.fetchedAt || t - this.fetchedAt >= this.ttl;
  }

  refresh(force = false) {
    if (this.inflight) return this.inflight;
    if (!force && !this.due()) return Promise.resolve();
    this.inflight = (async () => {
      try {
        this.data = await this.load();
        this.fetchedAt = this.now();
        this.error = null;
        this.errorAt = null;
      } catch (e) {
        this.error = e instanceof SourceError || e.name === 'HaError' ? e.message : friendly(e);
        this.errorAt = this.now();
        if (!(e instanceof SourceError) && e.name !== 'HaError') console.warn(`[${this.name}] ${e.message}`);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  toJSON() {
    return { data: this.data, fetchedAt: this.fetchedAt, error: this.error, errorAt: this.errorAt, loading: Boolean(this.inflight) };
  }
}

function friendly(e) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'The source did not answer in time.';
  return e?.message || 'The source could not be reached.';
}

async function publicJSON(url, { timeoutMs = 15_000, accept = 'application/json' } = {}) {
  let r;
  try {
    r = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: accept }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new SourceError(e.name === 'TimeoutError' ? `${new URL(url).hostname} did not answer in time.` : `Can't reach ${new URL(url).hostname}.`);
  }
  if (!r.ok) {
    const err = new SourceError(`${new URL(url).hostname} answered HTTP ${r.status}.`);
    err.status = r.status;
    throw err;
  }
  try { return await r.json(); } catch { throw new SourceError(`${new URL(url).hostname} sent something that isn't JSON.`); }
}

// ---- shaping (keep only the fields the page uses) ---------------------------

const WEATHER_ATTRS = ['temperature', 'apparent_temperature', 'dew_point', 'humidity', 'pressure', 'cloud_coverage', 'uv_index',
  'visibility', 'wind_speed', 'wind_gust_speed', 'wind_bearing', 'ozone', 'temperature_unit', 'pressure_unit', 'wind_speed_unit',
  'visibility_unit', 'precipitation_unit', 'friendly_name', 'attribution'];
const FORECAST_KEYS = ['datetime', 'condition', 'temperature', 'templow', 'apparent_temperature', 'precipitation',
  'precipitation_probability', 'wind_speed', 'wind_gust_speed', 'wind_bearing', 'humidity', 'cloud_coverage', 'uv_index', 'is_daytime'];

const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj?.[k] !== undefined).map(k => [k, obj[k]]));
const text = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '');

function shapeForecast(list) {
  return list.map(f => pick(f, FORECAST_KEYS)).filter(f => Number.isFinite(Date.parse(f.datetime)));
}

function shapeHistory(states) {
  return states.map(s => ({
    t: Date.parse(s.last_updated || s.last_changed),
    temperature: W.number(s.attributes?.temperature),
    pressure: W.number(s.attributes?.pressure),
  })).filter(p => Number.isFinite(p.t) && (p.temperature !== null || p.pressure !== null));
}

const SEVERITY_ORDER = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };
function shapeAlerts(features) {
  return features.map(f => {
    const p = f.properties || {};
    return {
      id: text(p.id || f.id, 300), event: text(p.event, 200) || 'Weather alert', severity: text(p.severity, 20) || 'Unknown',
      urgency: text(p.urgency, 20), headline: text(p.headline, 500), description: text(p.description), instruction: text(p.instruction),
      area: text(p.areaDesc, 500), sender: text(p.senderName, 200), onset: text(p.onset || p.effective, 40), ends: text(p.ends || p.expires, 40),
    };
  }).sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4));
}

// NWS observation values to SI, checking each unit code rather than assuming.
function siValue(field, kind) {
  const v = W.number(field?.value);
  if (v === null) return null;
  const unit = String(field?.unitCode || '');
  if (kind === 'temp') return /degF/.test(unit) ? (v - 32) * 5 / 9 : /K$/.test(unit) && !/degC/.test(unit) ? v - 273.15 : v;
  if (kind === 'speed') return /m_s-1/.test(unit) ? v * 3.6 : /kn|knot/.test(unit) ? v * 1.852 : v; // km/h
  if (kind === 'pressure') return /hPa|mbar/.test(unit) ? v * 100 : v; // Pa
  if (kind === 'length') return /km$/.test(unit) ? v * 1000 : v; // m
  return v;
}

function shapeObservation(station, o, distanceKm) {
  const sea = siValue(o.seaLevelPressure, 'pressure');
  return {
    id: station.stationIdentifier, name: text(station.name, 200), distanceKm,
    timestamp: o.timestamp, text: text(o.textDescription, 200),
    tempC: siValue(o.temperature, 'temp'), dewC: siValue(o.dewpoint, 'temp'), rh: siValue(o.relativeHumidity),
    windKmh: siValue(o.windSpeed, 'speed'), gustKmh: siValue(o.windGust, 'speed'), dirDeg: siValue(o.windDirection),
    pressurePa: sea ?? siValue(o.barometricPressure, 'pressure'), pressureKind: sea !== null ? 'sea' : 'station',
    visibilityM: siValue(o.visibility, 'length'),
  };
}

// ---- the observatory ---------------------------------------------------------

class Observatory {
  constructor({ ha, options = {}, now = Date.now }) {
    this.ha = ha;
    this.now = now;
    this.options = { weather_entity: '', location_label: '', nws: true, air_quality: true, ...options };
    this.lastForced = 0;
    const src = (name, ttl, load, retryMs) => new Source(name, { ttl, load, now, retryMs });

    this.config = src('ha-config', 60 * MIN, async () => {
      const c = await this.ha.config();
      return { point: W.regionalPoint(c.latitude, c.longitude), timeZone: c.time_zone || null, name: text(c.location_name, 100), units: c.unit_system || {} };
    }, 30_000);
    this.entity = src('entity', 10 * MIN, () => this.pickEntity(), 30_000);
    this.weather = src('weather', 30_000, async () => {
      const s = await this.ha.state(await this.entityId());
      return { entity_id: s.entity_id, state: s.state, attributes: pick(s.attributes, WEATHER_ATTRS), last_updated: s.last_updated, last_changed: s.last_changed };
    }, 15_000);
    this.hourly = src('hourly', 5 * MIN, async () => shapeForecast(await this.ha.forecast(await this.entityId(), 'hourly')));
    this.daily = src('daily', 15 * MIN, async () => shapeForecast(await this.ha.forecast(await this.entityId(), 'daily')));
    this.history = src('history', 30 * MIN, async () => {
      const end = new Date(this.now()), start = new Date(end - 24 * 3600_000);
      return shapeHistory(await this.ha.history(await this.entityId(), start, end));
    });
    this.sun = src('sun', MIN, async () => {
      try {
        const s = await this.ha.state('sun.sun');
        return { state: s.state, ...pick(s.attributes, ['elevation', 'azimuth', 'next_rising', 'next_setting', 'next_dawn', 'next_dusk']) };
      } catch (e) {
        if (e.status === 404) throw new SourceError('sun.sun isn’t in Home Assistant (the Sun integration is off).');
        throw e;
      }
    });

    this.points = src('nws-points', 24 * 60 * MIN, async () => {
      const p = await this.point();
      try {
        const d = await publicJSON(`https://api.weather.gov/points/${p.lat},${p.lon}`, { accept: 'application/geo+json' });
        const rel = d.properties?.relativeLocation?.properties || {};
        return { place: [rel.city, rel.state].filter(Boolean).join(', '), stations: W.safeLink(d.properties?.observationStations, '') };
      } catch (e) {
        if (e.status === 404) throw new SourceError('The National Weather Service covers only the United States and its territories.');
        throw e;
      }
    }, 10 * MIN);
    this.alerts = src('nws-alerts', 5 * MIN, async () => {
      const p = await this.point();
      const d = await publicJSON(`https://api.weather.gov/alerts/active?point=${p.lat},${p.lon}`, { accept: 'application/geo+json' });
      if (!Array.isArray(d.features)) throw new SourceError('NWS sent an alert list in an unexpected shape.');
      return shapeAlerts(d.features);
    }, MIN);
    this.station = src('nws-station', 10 * MIN, () => this.loadStation());
    this.air = src('air-quality', 30 * MIN, async () => {
      const p = await this.point();
      const d = await publicJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${p.lat}&longitude=${p.lon}&hourly=us_aqi,pm2_5,pm10&forecast_days=2&timeformat=unixtime`);
      const h = d.hourly;
      if (!h?.time?.length) throw new SourceError('Open-Meteo returned no air quality data.');
      let i = h.time.findLastIndex(t => Number(t) * 1000 <= this.now());
      if (i < 0) i = 0;
      return { time: Number(h.time[i]) * 1000, aqi: W.number(h.us_aqi?.[i]), pm25: W.number(h.pm2_5?.[i]), pm10: W.number(h.pm10?.[i]) };
    });
    this.radar = src('radar', 5 * MIN, async () => {
      const d = await publicJSON('https://api.rainviewer.com/public/weather-maps.json');
      let host;
      try { host = new URL(d.host); } catch { throw new SourceError('RainViewer sent an unexpected tile host.'); }
      if (host.protocol !== 'https:' || host.hostname !== 'tilecache.rainviewer.com') throw new SourceError('RainViewer sent an unexpected tile host.');
      const frames = (d.radar?.past || []).filter(W.validRadarFrame).map(f => ({ time: Number(f.time), path: f.path }));
      if (!frames.length) throw new SourceError('RainViewer returned no radar frames.');
      return { host: host.origin, frames };
    });

    this.ha_sources = ['config', 'entity', 'weather', 'hourly', 'daily', 'history', 'sun'];
  }

  async point() {
    await this.config.refresh();
    const p = this.config.data?.point;
    if (!p) throw new SourceError(this.config.error || 'Home Assistant has no home location set (Settings → System → General).');
    return p;
  }

  async entityId() {
    await this.entity.refresh();
    if (!this.entity.data) throw new SourceError(this.entity.error || 'No weather entity found.');
    return this.entity.data;
  }

  async pickEntity() {
    const chosen = String(this.options.weather_entity || '').trim();
    if (chosen) return chosen;
    const states = await this.ha.states();
    const weather = states.filter(s => /^weather\.[a-z0-9_]+$/.test(s.entity_id));
    if (!weather.length) throw new SourceError('Home Assistant has no weather entity. Add a weather integration (for example Met.no), or pick one in the app’s settings.');
    const live = weather.filter(s => !['unavailable', 'unknown'].includes(s.state));
    const pool = live.length ? live : weather;
    return (pool.find(s => s.entity_id === 'weather.forecast_home') || pool.sort((a, b) => a.entity_id.localeCompare(b.entity_id))[0]).entity_id;
  }

  async loadStation() {
    const p = await this.point();
    await this.points.refresh();
    if (!this.points.data?.stations) throw new SourceError(this.points.error || 'NWS gave no station list for this area.');
    const list = await publicJSON(this.points.data.stations, { accept: 'application/geo+json' });
    const nearest = (list.features || []).map(s => {
      const [lon, lat] = s.geometry?.coordinates || [];
      return { props: s.properties || {}, distanceKm: W.distanceKm(p, { lat: W.number(lat), lon: W.number(lon) }) };
    }).filter(s => Number.isFinite(s.distanceKm) && /^[A-Z0-9]{3,8}$/.test(s.props.stationIdentifier || '')).sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 3);
    const results = await Promise.allSettled(nearest.map(async s => {
      const d = await publicJSON(`https://api.weather.gov/stations/${s.props.stationIdentifier}/observations/latest?require_qc=true`, { accept: 'application/geo+json' });
      return shapeObservation(s.props, d.properties || {}, s.distanceKm);
    }));
    const fresh = o => this.now() - Date.parse(o.timestamp) < 3 * 3600_000;
    const usable = results.filter(r => r.status === 'fulfilled').map(r => r.value)
      .filter(o => Number.isFinite(Date.parse(o.timestamp)) && o.tempC !== null)
      .sort((a, b) => fresh(a) === fresh(b) ? a.distanceKm - b.distanceKm : fresh(a) ? -1 : 1);
    if (!usable.length) throw new SourceError('None of the three nearest NWS stations has a usable recent observation.');
    return usable[0];
  }

  publicSources() {
    return [
      ...(this.options.nws ? ['points', 'alerts', 'station'] : []),
      ...(this.options.air_quality ? ['air'] : []),
      'radar',
    ];
  }

  // Refresh whatever is due (everything when forced), waiting at most waitMs
  // so the page gets an answer quickly; slow sources show as loading and the
  // page asks again shortly.
  async snapshot({ force = false, waitMs = 4000 } = {}) {
    if (force) {
      if (this.now() - this.lastForced < 30_000) force = false; // refresh at most twice a minute
      else this.lastForced = this.now();
    }
    const names = [...this.ha_sources, ...this.publicSources()];
    const work = Promise.allSettled(names.map(n => this[n].refresh(force && n !== 'points' && n !== 'config' && n !== 'entity')));
    await Promise.race([work, new Promise(r => setTimeout(r, waitMs).unref?.())]);
    return this.state();
  }

  state() {
    const cfg = this.config.data;
    const disabled = { data: null, fetchedAt: null, error: null, errorAt: null, loading: false, disabled: true };
    return {
      version: VERSION,
      now: this.now(),
      location: {
        label: String(this.options.location_label || '').trim() || this.points.data?.place || cfg?.name || 'Home area',
        point: cfg?.point || null,
        timeZone: cfg?.timeZone || null,
      },
      ha: { available: this.ha.available, config: this.config.toJSON(), entity: this.entity.toJSON() },
      weather: this.weather.toJSON(),
      hourly: this.hourly.toJSON(),
      daily: this.daily.toJSON(),
      history: this.history.toJSON(),
      sun: this.sun.toJSON(),
      alerts: this.options.nws ? this.alerts.toJSON() : disabled,
      station: this.options.nws ? this.station.toJSON() : disabled,
      air: this.options.air_quality ? this.air.toJSON() : disabled,
      radar: this.radar.toJSON(),
    };
  }

  status() {
    return Object.fromEntries([...this.ha_sources, 'points', 'alerts', 'station', 'air', 'radar'].map(n => [n, {
      ok: Boolean(this[n].fetchedAt) && !this[n].error, fetchedAt: this[n].fetchedAt, error: this[n].error,
    }]));
  }
}

module.exports = { Observatory, Source, SourceError, shapeAlerts, shapeObservation, shapeForecast, shapeHistory, siValue, USER_AGENT };
