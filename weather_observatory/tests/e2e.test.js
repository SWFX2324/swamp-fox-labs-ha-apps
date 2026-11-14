'use strict';
// End to end: the real server, with Home Assistant and every public service
// replaced by tests/fixtures/fake-world.js, reached through the ingress
// stand-in. Each scenario starts its own server.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const proxy = require('./ingress-proxy');

const SERVER = path.join(__dirname, '../app/server.js');
const FAKE = path.join(__dirname, 'fixtures/fake-world.js');

const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function start(world = '', env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--require', FAKE, SERVER], { env: { ...process.env, PORT: String(port), FAKE_WORLD: world, APP_VERSION: 'test', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 100 && !/listening/.test(log); i++) await new Promise(r => setTimeout(r, 50));
  const px = await proxy.start({ port: 0, appPort: port, log: false });
  const base = `http://127.0.0.1:${px.port}${px.prefix}`;
  return {
    base, log: () => log,
    get: (p, init) => fetch(base + p, init),
    state: async () => (await fetch(base + 'api/state')).json(),
    stop: () => { child.kill(); px.server.close(); },
  };
}

test('everything loads through the ingress prefix with real-shaped data', async t => {
  const app = await start('alerts');
  t.after(app.stop);
  const page = await app.get('');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /src="app\.js\?v=test"/);
  assert.match(html, /src="wxcore\.js\?v=test"/);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  for (const p of ['style.css?v=test', 'app.js', 'wxcore.js', 'lib/leaflet/leaflet.js', 'assets/topo-dark.svg', 'favicon.svg']) {
    assert.equal((await app.get(p)).status, 200, p);
  }

  const s = await app.state();
  assert.equal(s.version, 'test');
  assert.equal(s.location.label, 'Raleigh, NC');
  assert.deepEqual(s.location.point, { lat: 35.8, lon: -78.6 });
  assert.equal(s.location.timeZone, 'America/New_York');
  assert.equal(s.ha.entity.data, 'weather.forecast_home', 'skips the unavailable weather.backyard');
  assert.equal(s.weather.data.state, 'partlycloudy');
  assert.ok(!('supported_features' in s.weather.data.attributes), 'only known attributes are passed on');
  assert.equal(s.hourly.data.length, 48);
  assert.equal(s.daily.data.length, 7);
  assert.ok(s.history.data.length > 100);
  assert.equal(s.sun.data.state, 'above_horizon');
  assert.equal(s.alerts.data.length, 2);
  assert.equal(s.alerts.data[0].severity, 'Severe', 'worst alert first');
  assert.equal(s.station.data.id, 'KRDU', 'the nearest fresh station, not the closer stale one');
  assert.equal(s.air.data.aqi !== null, true, 'Open-Meteo got the rounded location (the fake refuses exact ones)');
  assert.equal(s.radar.data.host, 'https://tilecache.rainviewer.com');
  assert.equal(s.radar.data.frames.length, 13, 'the frame pointing at another host is dropped');
  for (const k of ['weather', 'hourly', 'daily', 'history', 'sun', 'alerts', 'station', 'air', 'radar']) assert.equal(s[k].error, null, k);
  assert.doesNotMatch(JSON.stringify(s), /35\.7796|-78\.6382|fake-token/, 'exact location and token never reach the page');
  assert.doesNotMatch(app.log(), /UNMOCKED/);
});

test('a public outage leaves Home Assistant data alone', async t => {
  const app = await start('nws_down,radar_down,air_down');
  t.after(app.stop);
  const s = await app.state();
  assert.equal(s.weather.error, null);
  assert.equal(s.hourly.data.length, 48);
  assert.match(s.alerts.error, /HTTP 503/);
  assert.equal(s.alerts.data, null);
  assert.match(s.station.error, /HTTP 503/);
  assert.match(s.radar.error, /HTTP 500/);
  assert.match(s.air.error, /HTTP 500/);
});

test('a Home Assistant outage leaves the public sources alone', async t => {
  const app = await start('ha_down');
  t.after(app.stop);
  const s = await app.state();
  assert.match(s.weather.error, /HTTP 502/);
  assert.equal(s.weather.data, null);
  assert.equal(s.radar.error, null);
  assert.equal(s.radar.data.frames.length, 13);
});

test('no weather entity and no history are explained, not faked', async t => {
  const app = await start('no_weather');
  t.after(app.stop);
  const s = await app.state();
  assert.match(s.weather.error, /no weather entity/i);
  assert.equal(s.hourly.data, null);
  const app2 = await start('no_history');
  t.after(app2.stop);
  const s2 = await app2.state();
  assert.deepEqual(s2.history.data, []);
  assert.equal(s2.history.error, null);
});

test('outside the US the NWS panels say why', async t => {
  const app = await start('outside_us');
  t.after(app.stop);
  const s = await app.state();
  assert.match(s.station.error, /only the United States/);
  assert.equal(s.weather.error, null);
});

test('options turn NWS and air quality off, and pick the entity', async t => {
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-'));
  fs.writeFileSync(path.join(dir, 'options.json'), JSON.stringify({ weather_entity: 'weather.forecast_home', location_label: 'The farm', nws: false, air_quality: false }));
  const app = await start('', { DATA_DIR: dir });
  t.after(() => { app.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const s = await app.state();
  assert.equal(s.location.label, 'The farm');
  assert.equal(s.alerts.disabled, true);
  assert.equal(s.station.disabled, true);
  assert.equal(s.air.disabled, true);
  assert.equal(s.weather.data.entity_id, 'weather.forecast_home');
  assert.doesNotMatch(app.log(), /api\.weather\.gov|open-meteo/);
});

test('refresh needs a same-origin JSON POST', async t => {
  const app = await start();
  t.after(app.stop);
  assert.equal((await app.get('api/refresh')).status, 405);
  assert.equal((await app.get('api/refresh', { method: 'POST', body: 'x' })).status, 403);
  assert.equal((await app.get('api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, body: '{}' })).status, 403);
  const ok = await app.get('api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: '{}' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).weather.error, null);
  assert.equal((await app.get('api/nope')).status, 404);
  assert.equal((await app.get('..%2fserver.js')).status, 403);
});

test('only the ingress proxy may connect inside Home Assistant', async t => {
  const port = await freePort();
  const child = spawn(process.execPath, ['--require', FAKE, SERVER], { env: { ...process.env, PORT: String(port), INGRESS_ONLY: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let log = '';
  child.stdout.on('data', d => { log += d; });
  for (let i = 0; i < 100 && !/listening/.test(log); i++) await new Promise(r => setTimeout(r, 50));
  assert.match(log, /\(ingress only\)/);
  // Loopback stays allowed (the Docker health check uses it).
  const r = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(r.status, 200);
  const h = await r.json();
  assert.equal(h.ok, true);
  assert.equal(h.homeAssistant, true);
  // A non-loopback address is refused. Reach the server through this
  // machine's own LAN address, when it has one.
  const lan = Object.values(require('os').networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal);
  if (lan) assert.equal((await fetch(`http://${lan.address}:${port}/api/state`)).status, 403);
});
