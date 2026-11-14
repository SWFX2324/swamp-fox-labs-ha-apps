'use strict';
// Preloaded into the server (node --require) for the end-to-end tests, the
// container smoke test and local previews. Stands in for Home Assistant's
// Core API and every public service, so nothing real is touched. Any other
// outside request is refused and logged as UNMOCKED.
//
// The home is a made-up spot near Raleigh, NC (35.7796, -78.6382).
//
// FAKE_WORLD can hold several comma-separated switches:
//   ha_down        Home Assistant refuses every request (HTTP 502)
//   no_weather     Home Assistant has no weather entity
//   nws_down       api.weather.gov answers HTTP 503
//   air_down       Open-Meteo answers HTTP 500
//   radar_down     RainViewer answers HTTP 500
//   alerts         two active NWS alerts (a Severe and a Minor one)
//   no_history     Recorder returns nothing
//   outside_us     NWS points answers 404 (as for a home outside the US)
// FAKE_RADAR=real  pass RainViewer's manifest through to the real service, so
//                  a local preview shows real radar tiles.
// FAKE_WORLD_LOG=1 logs each request.

const realFetch = globalThis.fetch;
const switches = new Set(String(process.env.FAKE_WORLD || '').split(',').map(s => s.trim()).filter(Boolean));
const HOME = { lat: 35.7796, lon: -78.6382 };
const HOUR = 3600_000;
let calls = 0;

process.env.HA_API_URL = process.env.HA_API_URL || 'http://supervisor/core/api';
process.env.SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN || 'fake-token';

const reply = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const hourStart = t => Math.floor(t / HOUR) * HOUR;
const iso = t => new Date(t).toISOString();

function tempAt(t) {
  const h = new Date(t).getUTCHours() - 5; // local-ish hour
  return Math.round((62 + 10 * Math.sin(((h - 9) / 24) * 2 * Math.PI)) * 10) / 10;
}

function hourly() {
  const start = hourStart(Date.now());
  return Array.from({ length: 48 }, (_, i) => {
    const t = start + i * HOUR;
    const rainy = i >= 14 && i <= 20;
    return {
      datetime: iso(t), condition: rainy ? 'rainy' : i >= 10 && i < 24 ? 'cloudy' : 'partlycloudy',
      temperature: tempAt(t), templow: undefined, precipitation: rainy ? [0.02, 0.08, 0.15, 0.11, 0.05, 0.02, 0][i - 14] : 0,
      precipitation_probability: rainy ? [40, 65, 80, 75, 55, 35, 20][i - 14] : i > 8 && i < 26 ? 10 : 0,
      wind_speed: Math.round((7 + 6 * Math.sin(i / 5)) * 10) / 10, wind_bearing: 200 + i * 2, humidity: rainy ? 92 : 64, cloud_coverage: rainy ? 100 : 40,
    };
  });
}

function daily() {
  const start = hourStart(Date.now()) - new Date().getUTCHours() * HOUR + 5 * HOUR;
  const days = [['partlycloudy', 71, 54, 20], ['rainy', 64, 52, 80], ['cloudy', 66, 49, 30], ['sunny', 73, 50, 0], ['sunny', 77, 55, 0], ['partlycloudy', 75, 58, 10], ['lightning-rainy', 70, 60, 60]];
  return days.map(([condition, hi, lo, pop], i) => ({ datetime: iso(start + i * 24 * HOUR), condition, temperature: hi, templow: lo, precipitation_probability: pop, precipitation: pop / 200 }));
}

function history() {
  const now = Date.now();
  if (switches.has('no_history')) return [[]];
  return [Array.from({ length: 145 }, (_, i) => {
    const t = now - (144 - i) * 10 * 60_000;
    return { entity_id: 'weather.forecast_home', state: 'partlycloudy', attributes: { temperature: tempAt(t), pressure: Math.round((30.12 - i * 0.0012) * 100) / 100, temperature_unit: '°F' }, last_changed: iso(t), last_updated: iso(t) };
  })];
}

function weatherState() {
  return {
    entity_id: 'weather.forecast_home', state: 'partlycloudy', last_changed: iso(Date.now() - 40 * 60_000), last_updated: iso(Date.now() - 6 * 60_000),
    attributes: {
      temperature: tempAt(Date.now()), dew_point: 49.6, temperature_unit: '°F', humidity: 64, cloud_coverage: 40, uv_index: 3.2,
      pressure: 29.95, pressure_unit: 'inHg', wind_bearing: 214, wind_speed: 8.1, wind_speed_unit: 'mph', visibility_unit: 'mi',
      precipitation_unit: 'in', attribution: 'Weather forecast from met.no, delivered by the Norwegian Meteorological Institute.', friendly_name: 'Forecast Home',
      supported_features: 3,
    },
  };
}

function sunState() {
  const now = Date.now();
  return { entity_id: 'sun.sun', state: 'above_horizon', attributes: { elevation: 31.4, azimuth: 205.2, next_rising: iso(now + 15 * HOUR), next_setting: iso(now + 3.2 * HOUR), friendly_name: 'Sun' }, last_updated: iso(now) };
}

function ha(url, init) {
  if (switches.has('ha_down')) return reply(502, { message: 'Bad gateway' });
  if (init?.headers?.Authorization !== `Bearer ${process.env.SUPERVISOR_TOKEN}`) return reply(401, { message: 'Unauthorized' });
  const p = url.pathname.replace(/^\/core\/api/, '');
  if (p === '/config') return reply(200, { latitude: HOME.lat, longitude: HOME.lon, time_zone: 'America/New_York', location_name: 'Home', unit_system: { temperature: '°F', length: 'mi' } });
  if (p === '/states') return reply(200, switches.has('no_weather') ? [sunState()] : [sunState(), { entity_id: 'weather.backyard', state: 'unavailable', attributes: {} }, weatherState()]);
  if (p === '/states/weather.forecast_home') return switches.has('no_weather') ? reply(404, { message: 'Entity not found.' }) : reply(200, weatherState());
  if (p === '/states/sun.sun') return reply(200, sunState());
  if (p.startsWith('/states/')) return reply(404, { message: 'Entity not found.' });
  if (p === '/services/weather/get_forecasts' && url.search === '?return_response' && init?.method === 'POST') {
    const body = JSON.parse(init.body || '{}');
    if (body.entity_id !== 'weather.forecast_home') return reply(400, { message: 'Entity not found' });
    return reply(200, { changed_states: [], service_response: { [body.entity_id]: { forecast: body.type === 'hourly' ? hourly() : daily() } } });
  }
  if (p.startsWith('/history/period/')) {
    if (url.searchParams.get('filter_entity_id') !== 'weather.forecast_home' || url.searchParams.get('significant_changes_only') !== '0') return reply(400, { message: 'bad history query' });
    return reply(200, history());
  }
  return reply(404, { message: 'Not found' });
}

function alertsBody() {
  const now = Date.now();
  if (!switches.has('alerts')) return { type: 'FeatureCollection', features: [] };
  return {
    type: 'FeatureCollection', features: [
      { id: 'urn:oid:minor', properties: { id: 'urn:oid:minor', event: 'Special Weather Statement', severity: 'Minor', urgency: 'Expected', headline: 'Patchy dense fog this morning', description: 'Visibility of a quarter mile or less in spots until 10 AM.', senderName: 'NWS Raleigh NC', ends: iso(now + 2 * HOUR) } },
      { id: 'urn:oid:severe', properties: { id: 'urn:oid:severe', event: 'Severe Thunderstorm Warning', severity: 'Severe', urgency: 'Immediate', headline: 'Severe Thunderstorm Warning until 6:45 PM EDT', description: 'At 5:52 PM, a severe thunderstorm was located near Cary, moving east at 25 mph.\n\nHAZARD...60 mph wind gusts and quarter size hail.', instruction: 'For your protection move to an interior room on the lowest floor of a building.', senderName: 'NWS Raleigh NC', ends: iso(now + HOUR) } },
    ],
  };
}

function nws(url) {
  if (switches.has('nws_down')) return reply(503, { title: 'Service Unavailable' });
  const p = url.pathname;
  if (p.startsWith('/points/')) {
    if (switches.has('outside_us')) return reply(404, { title: 'Data Unavailable For Requested Point' });
    return reply(200, { properties: { observationStations: 'https://api.weather.gov/gridpoints/RAH/73,57/stations', relativeLocation: { properties: { city: 'Raleigh', state: 'NC' } } } });
  }
  if (p === '/alerts/active') return reply(200, alertsBody());
  if (p === '/gridpoints/RAH/73,57/stations') {
    return reply(200, { features: [
      { geometry: { coordinates: [-78.787, 35.871] }, properties: { stationIdentifier: 'KRDU', name: 'Raleigh-Durham International Airport' } },
      { geometry: { coordinates: [-78.7, 35.8] }, properties: { stationIdentifier: 'KSTALE', name: 'Old Station' } },
      { geometry: { coordinates: [-79.0, 36.0] }, properties: { stationIdentifier: 'KTTA', name: 'Sanford' } },
      { geometry: { coordinates: [-80.0, 36.1] }, properties: { stationIdentifier: 'KGSO', name: 'Greensboro' } },
    ] });
  }
  const m = p.match(/^\/stations\/([A-Z0-9]+)\/observations\/latest$/);
  if (m) {
    const id = m[1];
    const ts = id === 'KSTALE' ? Date.now() - 9 * HOUR : Date.now() - 38 * 60_000;
    return reply(200, { properties: {
      timestamp: iso(ts), textDescription: 'Mostly Cloudy',
      temperature: { unitCode: 'wmoUnit:degC', value: id === 'KRDU' ? 16.7 : 15 }, dewpoint: { unitCode: 'wmoUnit:degC', value: 9.4 },
      relativeHumidity: { unitCode: 'wmoUnit:percent', value: 62.3 }, windSpeed: { unitCode: 'wmoUnit:km_h-1', value: 14.8 },
      windGust: { unitCode: 'wmoUnit:km_h-1', value: null }, windDirection: { unitCode: 'wmoUnit:degree_(angle)', value: 210 },
      seaLevelPressure: { unitCode: 'wmoUnit:Pa', value: 101420 }, barometricPressure: { unitCode: 'wmoUnit:Pa', value: 100550 },
      visibility: { unitCode: 'wmoUnit:m', value: 16090 },
    } });
  }
  return reply(404, { title: 'Not Found' });
}

function air(url) {
  if (switches.has('air_down')) return reply(500, { error: true, reason: 'down' });
  if (url.searchParams.get('latitude') !== '35.8' || url.searchParams.get('longitude') !== '-78.6') return reply(400, { error: true, reason: 'exact coordinates must never be sent' });
  const start = Math.floor(hourStart(Date.now() - 24 * HOUR) / 1000);
  const time = Array.from({ length: 72 }, (_, i) => start + i * 3600);
  return reply(200, { hourly: { time, us_aqi: time.map((_, i) => 38 + (i % 9)), pm2_5: time.map(() => 6.4), pm10: time.map(() => 11.2) } });
}

function radar() {
  if (switches.has('radar_down')) return reply(500, 'down');
  const now = Math.floor(Date.now() / 600_000) * 600;
  return reply(200, { version: '2.0', generated: now, host: 'https://tilecache.rainviewer.com', radar: { past: Array.from({ length: 13 }, (_, i) => ({ time: now - (12 - i) * 600, path: `/v2/radar/fake${i.toString(16).padStart(8, '0')}` })).concat([{ time: now, path: 'https://evil.example/x' }]) } });
}

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  calls++;
  if (process.env.FAKE_WORLD_LOG) console.log(`[fake-world] ${init?.method || 'GET'} ${url.href}`);
  const ua = init?.headers?.['User-Agent'] || '';
  if (url.hostname !== 'supervisor' && !/^HomeAssistant-WeatherObservatory\//.test(ua)) return reply(403, { title: 'A User-Agent identifying the app is required' });
  if (url.hostname === 'supervisor') return ha(url, init);
  if (url.hostname === 'api.weather.gov') return nws(url);
  if (url.hostname === 'air-quality-api.open-meteo.com') return air(url);
  if (url.hostname === 'api.rainviewer.com') return process.env.FAKE_RADAR === 'real' ? realFetch(input, init) : radar();
  console.error(`[fake-world] UNMOCKED ${url.href}`);
  return reply(599, 'unmocked');
};

module.exports = { HOME, calls: () => calls };
