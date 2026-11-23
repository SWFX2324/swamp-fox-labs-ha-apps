'use strict';
// End to end: the real server, with Home Assistant and the UniFi console
// replaced by tests/fixtures/fake-world.js, reached through the ingress
// stand-in. Each scenario starts its own server.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const proxy = require('./ingress-proxy');
const { READ_ONLY } = require('../app/ha');

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
  const state = async () => {
    for (let i = 0; i < 40; i++) {
      const s = await (await fetch(base + 'api/state')).json();
      if (s.ready && s.uptime && (!s.unifiConfigured || s.network.vlans || s.sources.unifi?.error)) return s;
      await new Promise(r => setTimeout(r, 150));
    }
    return (await fetch(base + 'api/state')).json();
  };
  return { base, log: () => log, get: (p, init) => fetch(base + p, init), state, stop: () => { child.kill(); px.server.close(); } };
}

test('everything loads through the ingress prefix', async t => {
  const app = await start('');
  t.after(app.stop);
  const page = await app.get('');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /src="app\.js\?v=test"/);
  assert.match(html, /href="style\.css\?v=test"/);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  for (const p of ['style.css?v=test', 'app.js', 'favicon.svg', 'assets/topo-dark.svg', 'assets/topo-light.svg']) assert.equal((await app.get(p)).status, 200, p);

  const s = await app.state();
  assert.equal(s.version, 'test');
  assert.equal(s.summary.level, 'ok', JSON.stringify(s.summary));
  assert.equal(s.summary.headline, 'Everything is normal');
  assert.deepEqual(s.hosts.map(h => h.name), ['Home Assistant', 'NAS', 'Desk PC']);
  assert.equal(s.containers.total, 11);
  assert.equal(s.containers.running, 11);
  assert.equal(s.network.source, 'api');
  assert.deepEqual(s.network.vlans.map(v => [v.name, v.vlan, v.clients]), [['Default', 1, 10], ['Servers', 20, 3], ['IoT', 30, 14]]);
  assert.equal(s.network.newDevices[0].name, 'ESP-3A1F');
  assert.equal(s.network.devices.length, 5);
  assert.ok(s.network.devices.every(d => d.trackEntity), 'each console device is matched to its Home Assistant entity');
  assert.equal(s.network.wlans.length, 3);
  assert.equal(s.updates.pending.length, 2);
  assert.ok(!s.updates.pending.some(p => /Disabled/.test(p.title)));
  assert.equal(s.backups.level, 'ok');
  assert.ok(s.uptime.rows.length > 10);
  assert.ok(s.incidents.some(i => i.subject === 'Nextcloud' && i.before.length), 'the Nextcloud restart lists the Core update before it');
  assert.equal(s.timeZone, 'America/New_York');
  for (const k of ['states', 'registry', 'supervisor', 'history', 'unifi']) assert.equal(s.sources[k].error, null, k);
  assert.doesNotMatch(JSON.stringify(s), /fake-token|fake-unifi-password|fake-session/, 'no secret reaches the page');
  assert.doesNotMatch(app.log(), /UNMOCKED/);
});

test('problems show up in the summary', async t => {
  const app = await start('pc_off,container_down,ap_down,backup_failed');
  t.after(app.stop);
  const s = await app.state();
  assert.equal(s.summary.level, 'bad');
  const text = s.summary.needs.map(n => n.text).join('\n');
  assert.match(text, /Desk PC stopped reporting 40 min ago/);
  assert.match(text, /Container syncthing is exited/);
  assert.match(text, /Garage AP is disconnected/);
  assert.match(text, /last automatic backup failed/);
  assert.doesNotMatch(text, /system_bridge/, 'the failing System Bridge entry is the PC problem, not listed twice');
  assert.ok(s.incidents.some(i => i.subject === 'Syncthing' && i.ongoing));
});

test('a device marked stored is not an alert; the mark is kept and can be undone', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-stored-'));
  const app = await start('ap_down', { DATA_DIR: dir });
  t.after(() => { app.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const post = (body, headers = {}) => app.get('api/stored', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  let s = await app.state();
  assert.match(s.summary.needs.map(n => n.text).join('\n'), /Garage AP is disconnected/);

  // Refused: another site, a malformed body, and a device that's online.
  assert.equal((await post({ name: 'Garage AP', stored: true }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post({ name: 'Garage AP', stored: 'yes' })).status, 400);
  assert.equal((await post({ name: 'x'.repeat(3000), stored: true })).status, 400);
  const online = s.network.devices.find(d => d.state === 'connected').name;
  assert.equal((await post({ name: online, stored: true })).status, 409);
  assert.equal((await post({ name: 'No Such Device', stored: true })).status, 409);
  assert.equal((await app.get('api/stored')).status, 405);

  const r = await post({ name: 'Garage AP', stored: true });
  assert.equal(r.status, 200);
  s = await r.json();
  assert.doesNotMatch(s.summary.needs.map(n => n.text).join('\n'), /Garage AP/);
  const ap = s.network.devices.find(d => d.name === 'Garage AP');
  assert.equal(ap.stored, true);
  assert.ok(Number.isFinite(ap.storedSince));
  assert.ok(s.uptime.rows.find(x => x.key === 'unifi:Garage AP').stored);
  assert.ok(s.incidents.filter(i => i.key === 'unifi:Garage AP' && i.ongoing).every(i => i.stored && i.severity === 'stored'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'stored.json'), 'utf8')).map(x => x.name), ['Garage AP']);

  s = await (await post({ name: 'Garage AP', stored: false })).json();
  assert.match(s.summary.needs.map(n => n.text).join('\n'), /Garage AP is disconnected/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'stored.json'), 'utf8')), []);
});

test('a UniFi outage leaves Home Assistant data alone', async t => {
  const app = await start('unifi_down');
  t.after(app.stop);
  const s = await app.state();
  assert.match(s.sources.unifi.error, /UniFi console/);
  assert.equal(s.network.vlans, null);
  assert.equal(s.network.devices.length, 5, 'devices still come from Home Assistant');
  assert.equal(s.containers.total, 11);
  assert.match(s.summary.needs.map(n => n.text).join(), /Can't read the UniFi console/);
});

test('a wrong UniFi password says so', async t => {
  const app = await start('unifi_badauth');
  t.after(app.stop);
  const s = await app.state();
  assert.match(s.sources.unifi.error, /refused the username or password/);
});

test('without UniFi settings the network comes from Home Assistant only', async t => {
  const app = await start('', { OPTIONS_JSON: '{}' });
  t.after(app.stop);
  const s = await app.state();
  assert.equal(s.unifiConfigured, false);
  assert.equal(s.network.source, 'ha');
  assert.equal(s.network.wan, null);
  assert.equal(s.network.devices.length, 5);
  assert.ok(!('unifi' in s.sources));
  assert.match(app.log(), /UniFi console: not set up/);
});

test('a plain Home Assistant: only what exists is shown, nothing else', async t => {
  const app = await start('bare', { OPTIONS_JSON: '{}' });
  t.after(app.stop);
  const s = await app.state();
  assert.equal(s.ready, true);
  assert.deepEqual(s.hosts.map(h => h.name), ['Home Assistant'], 'no NAS or PC');
  assert.equal(s.containers.total, 0);
  assert.equal(s.network.source, null, 'no UniFi at all');
  assert.equal(s.network.devices.length, 0);
  assert.equal(s.network.wlans.length, 0);
  assert.equal(s.network.vlans, null);
  assert.equal(s.unifiConfigured, false);
  assert.equal(s.summary.level, 'ok');
  assert.ok(s.uptime.rows.every(r => r.kind !== 'unifi' && r.kind !== 'container'));
  assert.ok(s.updates.groups.every(g => !['UniFi', 'Container images', 'NAS', 'PC'].includes(g.name)));
  assert.doesNotMatch(app.log(), /UNMOCKED/);
});

test('Home Assistant down: the page says so instead of failing', async t => {
  const app = await start('ha_down', { OPTIONS_JSON: '{}' });
  t.after(app.stop);
  const s = await (await app.get('api/state')).json();
  assert.equal(s.ready, false);
  assert.match(s.sources.states.error, /reach Home Assistant/);
});

test('only reads: the WebSocket allow-list and the API refuse anything else', async t => {
  assert.ok(![...READ_ONLY].some(t => /call_service|set|update|delete|create|remove/.test(t)), [...READ_ONLY].join());
  const app = await start('', { OPTIONS_JSON: '{}' });
  t.after(app.stop);
  assert.equal((await app.get('api/state', { method: 'POST' })).status, 405);
  assert.equal((await app.get('api/refresh', { method: 'POST', headers: { 'Content-Type': 'text/plain' } })).status, 403);
  assert.equal((await app.get('api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, body: '{}' })).status, 403);
  assert.equal((await app.get('api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
  assert.equal((await app.get('../etc/passwd')).status, 404);
  assert.equal((await app.get('api/nope')).status, 404);
});
