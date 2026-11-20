'use strict';
// End to end: the real server against the simulated radios and the made-up
// public maps (fixtures/fake-web.js), reached through a stand-in for Home
// Assistant's ingress proxy under a nested prefix. Checks that every asset
// loads relative to the prefix, the state and send contract, the security
// rules, the Home Assistant home location, and that messages survive a restart.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const ingress = require('./ingress-proxy');
const { startMeshtastic, startMeshCore, HOME } = require('./fixtures/fake-radios');

const SERVER = path.join(__dirname, '../app/server.js');
const FAKE_WEB = path.join(__dirname, 'fixtures/fake-web.js');
const VERSION = '9.9.9-test';

const freePort = () => new Promise(resolve => {
  const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('timed out waiting');
};

async function radios(t) {
  const mt = await startMeshtastic();
  const mc = await startMeshCore();
  t.after(() => { for (const r of [mt, mc]) { r.server.close(); for (const s of r.sockets) s.destroy(); } });
  return { mt, mc };
}

async function start(env = {}, dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-hub-e2e-'))) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--require', FAKE_WEB, SERVER], {
    env: { ...process.env, PORT: String(port), APP_VERSION: VERSION, DATA_DIR: dataDir, HOME_LAT: String(HOME.lat), HOME_LON: String(HOME.lon), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  await until(async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } });
  return { child, base, port, dataDir, log: () => log };
}
const stop = s => new Promise(resolve => { if (s.child.exitCode !== null) return resolve(); s.child.once('exit', resolve); s.child.kill('SIGTERM'); });
const radioEnv = ({ mt, mc }) => ({ MESHTASTIC_HOST: '127.0.0.1', MESHTASTIC_PORT: String(mt.port), MESHCORE_HOST: '127.0.0.1', MESHCORE_PORT: String(mc.port) });
const getState = async (base, q = '') => (await fetch(`${base}/api/state${q}`)).json();
const send = (base, body, headers = {}) => fetch(`${base}/api/send`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const connected = base => until(async () => { const s = await getState(base); return s.networks.meshtastic.state === 'connected' && s.networks.meshcore.state === 'connected' && s; });

test('the page and every asset load under a nested ingress prefix', async t => {
  const s = await start();
  const proxy = await ingress.start({ port: 0, appPort: s.port, log: false });
  t.after(async () => { proxy.server.close(); await stop(s); });
  const root = `http://127.0.0.1:${proxy.port}${proxy.prefix}`;

  const page = await fetch(root);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(page.headers.get('content-security-policy'), /img-src 'self' data: https:\/\/server\.arcgisonline\.com/);
  assert.equal(page.headers.get('cache-control'), 'no-store');

  const assets = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map(m => m[1]).filter(u => !/^https?:/.test(u));
  assert.ok(assets.length >= 5, assets.join());
  for (const a of assets) {
    assert.ok(!a.startsWith('/'), `${a} is root-relative and would miss the ingress prefix`);
    const r = await fetch(new URL(a, root));
    assert.equal(r.status, 200, a);
    if (/\?v=/.test(a)) {
      assert.ok(a.endsWith(`?v=${VERSION}`), a);
      assert.match(r.headers.get('cache-control'), /immutable/);
    }
  }
  for (const css of ['style.css', 'lib/leaflet/leaflet.css']) {
    const text = await (await fetch(new URL(css, root))).text();
    for (const [, u] of text.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
      // Leaflet's default marker images aren't shipped: the app draws circle markers.
      if (u.startsWith('data:') || /marker-(icon|shadow)/.test(u)) continue;
      assert.ok(!u.startsWith('/'), `${css}: ${u}`);
      assert.equal((await fetch(new URL(u, new URL(css, root)))).status, 200, `${css} -> ${u}`);
    }
  }
  // The page's script asks only for relative API paths.
  const js = await (await fetch(new URL('app.js', root))).text();
  assert.ok(!/fetch\(['"`]\//.test(js), 'a root-relative fetch in app.js');
  // Through the proxy the API answers too.
  assert.equal((await fetch(new URL('api/state', root))).status, 200);
  assert.deepEqual(proxy.seen.filter(u => !u.startsWith(proxy.prefix)), [], 'nothing requested outside the prefix');
});

test('state: both radios, their nodes and chats, messages and the public nodes', async t => {
  const r = await radios(t);
  const s = await start(radioEnv(r));
  t.after(() => stop(s));
  const st = await connected(s.base);
  assert.equal(st.version, VERSION);
  assert.equal(st.sending, true);
  assert.deepEqual(st.home, HOME);
  assert.equal(st.networks.meshtastic.self.name, 'Swamp Fox Base');
  assert.equal(st.networks.meshcore.self.name, 'Swamp Fox MC');
  assert.deepEqual(st.networks.meshcore.chats.map(c => c.name), ['Public', '#sc']);
  assert.ok(st.networks.meshtastic.nodes.length >= 6);

  r.mt.packet({ from: 0x0badf00d, to: r.mt.me, port: 1, payload: Buffer.from('dm to you') });
  const withDm = await until(async () => { const x = await getState(s.base); return x.networks.meshtastic.chats.find(c => c.kind === 'dm') && x; });
  const dm = withDm.networks.meshtastic.chats.find(c => c.kind === 'dm');
  assert.deepEqual({ key: dm.key, name: dm.name }, { key: 'dm:!0badf00d', name: 'Lake Murray Base' });
  assert.equal(withDm.messages.messages.at(-1).text, 'dm to you');

  // Asking again with the revision returns no messages; with the web revision, no public list.
  const again = await getState(s.base, `?rev=${withDm.messages.rev}&web=${encodeURIComponent(withDm.webRev)}`);
  assert.equal(again.messages.messages.length, 0);
  assert.equal(again.messages.full, false);
  const pub = await until(async () => { const x = await getState(s.base); return x.web.meshtastic.fetchedAt && x.web.meshcore.fetchedAt && x; });
  assert.ok(pub.web.meshtastic.nodes.some(n => n.name === 'Sumter Hilltop'));
  assert.ok(pub.web.meshcore.nodes.some(n => n.name === 'Fort Jackson RPT'));
  assert.equal(pub.web.radiusKm, 100);
  const quiet = await getState(s.base, `?web=${encodeURIComponent(pub.webRev)}`);
  assert.equal(quiet.web, null);
  assert.ok(!/UNMOCKED/.test(s.log()), s.log());
});

test('send: a message goes out through the right radio and its status follows', async t => {
  const r = await radios(t);
  const s = await start(radioEnv(r));
  t.after(() => stop(s));
  await connected(s.base);
  const res = await send(s.base, { network: 'meshcore', chat: `dm:${r.mc.contacts[1].key.toString('hex')}`, text: '  hello\u0007 there \r\n second line ' });
  assert.equal(res.status, 200);
  const { message } = await res.json();
  assert.equal(message.text, 'hello there \n second line', 'trimmed, control characters dropped, line breaks kept');
  assert.equal(message.status, 'queued');
  assert.ok(r.mc.received.some(f => f[0] === 0x02 && f.subarray(13).toString() === 'hello there \n second line'));
  await until(async () => (await getState(s.base)).messages.messages.find(m => m.id === message.id && m.status === 'delivered'));

  const mt = await send(s.base, { network: 'meshtastic', chat: 'ch:1', text: 'hi SC-Mesh' });
  assert.equal(mt.status, 200);
  assert.ok(await until(() => r.mt.received.find(m => m.has(1) && m.msg(1).msg(4).str(2) === 'hi SC-Mesh')));
});

test('send: refused for bad input, cross-site requests, a radio that isn’t there, or when sending is off', async t => {
  const s = await start();   // no radios
  t.after(() => stop(s));
  const cases = [
    [{ network: 'meshtastic', chat: 'ch:0', text: 'x' }, {}, 409, /isn’t connected/],
    [{ network: 'toString', chat: 'ch:0', text: 'x' }, {}, 400, /Unknown network/],
    [{ network: 'meshcore', chat: 'x'.repeat(100), text: 'x' }, {}, 400, /Unknown chat/],
    [{ network: 'meshcore', chat: 'ch:0', text: 'x' }, { 'Sec-Fetch-Site': 'cross-site' }, 403, /refused/],
  ];
  for (const [body, headers, status, msg] of cases) {
    const res = await send(s.base, body, headers);
    assert.equal(res.status, status, JSON.stringify(body));
    assert.match((await res.json()).error.message, msg);
  }
  const form = await fetch(`${s.base}/api/send`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 403);
  assert.equal((await fetch(`${s.base}/api/send`)).status, 405);
  const big = await send(s.base, { network: 'meshcore', chat: 'ch:0', text: 'x'.repeat(5000) });
  assert.equal(big.status, 413);

  const off = await start({ ALLOW_SENDING: 'false' });
  t.after(() => stop(off));
  assert.equal((await getState(off.base)).sending, false);
  const r = await send(off.base, { network: 'meshcore', chat: 'ch:0', text: 'x' });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error.message, /turned off/);
});

test('with no radios set up the app still runs and says so', async t => {
  const s = await start();
  t.after(() => stop(s));
  const st = await getState(s.base);
  for (const k of ['meshtastic', 'meshcore']) {
    assert.equal(st.networks[k].configured, false);
    assert.equal(st.networks[k].state, 'off');
  }
  assert.match(s.log(), /no radios set/);
  const h = await (await fetch(`${s.base}/api/health`)).json();
  assert.deepEqual(h.links, { meshtastic: 'off', meshcore: 'off' });
});

test('only the ingress proxy may connect inside Home Assistant', async t => {
  const s = await start({ INGRESS_ONLY: 'true' });
  t.after(() => stop(s));
  // The tests connect from 127.0.0.1, which is allowed (the health check).
  assert.equal((await fetch(`${s.base}/api/health`)).status, 200);
  assert.match(s.log(), /ingress only/);
  // From another address on this machine it's refused.
  const other = os.networkInterfaces();
  const addr = Object.values(other).flat().find(a => a && a.family === 'IPv4' && !a.internal)?.address;
  if (!addr) return t.skip('no non-loopback address to test from');
  const status = await new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: s.port, path: '/api/state', localAddress: addr }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve('error'));
  });
  assert.ok(status === 403 || status === 'error', String(status));
});

test('the home location comes from Home Assistant when the Supervisor token is there', async t => {
  let auth = null;
  const ha = http.createServer((req, res) => {
    auth = req.headers.authorization;
    if (req.url !== '/api/config') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ latitude: 33.5, longitude: -80.9, location_name: 'Home' }));
  });
  await new Promise(r => ha.listen(0, '127.0.0.1', r));
  t.after(() => ha.close());
  const s = await start({ HOME_LAT: '', HOME_LON: '', SUPERVISOR_TOKEN: 'test-token', HA_REST_URL: `http://127.0.0.1:${ha.address().port}/api` });
  t.after(() => stop(s));
  const st = await until(async () => { const x = await getState(s.base); return x.home && x; });
  assert.deepEqual(st.home, { lat: 33.5, lon: -80.9 });
  assert.equal(st.homeSource, 'home_assistant');
  assert.equal(auth, 'Bearer test-token');
});

test('messages are kept across a restart', async t => {
  const r = await radios(t);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-hub-e2e-'));
  const s = await start(radioEnv(r), dataDir);
  await connected(s.base);
  r.mt.packet({ from: 0x51c0ffee, port: 1, payload: Buffer.from('remember me') });
  await until(async () => (await getState(s.base)).messages.messages.some(m => m.text === 'remember me'));
  // Saved within a couple of seconds, so a hard stop loses at most that.
  await until(() => fs.existsSync(path.join(dataDir, 'messages.json')), 6000);
  await stop(s);
  const s2 = await start({}, dataDir);
  t.after(() => stop(s2));
  const st = await getState(s2.base);
  assert.ok(st.messages.messages.some(m => m.text === 'remember me' && m.chat === 'ch:0'));
});
