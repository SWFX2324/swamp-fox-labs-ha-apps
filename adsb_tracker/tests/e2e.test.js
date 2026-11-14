'use strict';
// End to end: the real server with the synthetic feed (fixtures/fake-adsbfi.js),
// reached through a stand-in for Home Assistant's ingress proxy under a nested
// prefix. Checks every asset loads relative to the prefix, the API contract,
// the security rules, shared caching and coalescing, and that a cooldown
// survives a restart.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const ingress = require('./ingress-proxy');

const SERVER = path.join(__dirname, '../app/server.js');
const FAKE = path.join(__dirname, 'fixtures/fake-adsbfi.js');
const VERSION = '9.9.9-test';

const freePort = () => new Promise(resolve => {
  const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function start(env = {}, dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adsb-e2e-'))) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--require', FAKE, SERVER], {
    env: { ...process.env, PORT: String(port), APP_VERSION: VERSION, DATA_DIR: dataDir, FAKE_ADSB_LOG: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 50));
  }
  return { child, base, port, dataDir, log: () => log, upstream: () => (log.match(/\[fake-adsbfi\]/g) || []).length };
}

const stop = s => new Promise(resolve => { if (s.child.exitCode !== null) return resolve(); s.child.once('exit', resolve); s.child.kill('SIGTERM'); });
const post = (base, body, headers = {}) => fetch(`${base}/api/query`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

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
  // Images and the topo background referenced from the stylesheets.
  for (const css of ['style.css', 'lib/leaflet/leaflet.css']) {
    const text = await (await fetch(new URL(css, root))).text();
    for (const [, u] of text.matchAll(/url\("?([^")]+)"?\)/g)) {
      // Leaflet's default marker images aren't shipped: the app draws its own plane icons.
      if (u.startsWith('data:') || /marker-(icon|shadow)/.test(u)) continue;
      assert.ok(!u.startsWith('/'), `${css}: ${u}`);
      assert.equal((await fetch(new URL(u, new URL(css, root)))).status, 200, `${css}: ${u}`);
    }
  }

  // The data endpoint through the prefix, as app.js calls it.
  const q = await fetch(new URL('api/query', root), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'callsign', value: 'AAL1920' }) });
  assert.equal(q.status, 200);
  const body = await q.json();
  assert.equal(body.aircraft[0].hex, 'a17c95');
  assert.equal(body.source, 'adsb.fi');

  assert.deepEqual(proxy.seen.filter(u => !u.startsWith(proxy.prefix)), [], 'nothing requested outside the prefix');
  assert.ok(!/UNMOCKED/.test(s.log()), s.log());
});

test('API contract, validation and security rules', async t => {
  const s = await start();
  t.after(() => stop(s));

  const ok = await post(s.base, { kind: 'hex', value: 'a17c95' });
  assert.equal(ok.status, 200);
  const first = await ok.json();
  assert.equal(typeof first.fetched_at, 'number');
  const again = await (await post(s.base, { kind: 'hex', value: 'A17C95' })).json();
  assert.equal(again.fetched_at, first.fetched_at, 'cache hit keeps the original fetch time');

  const area = await (await post(s.base, { kind: 'area', latitude: 35.8, longitude: -78.8, radius: 100 })).json();
  assert.ok(area.aircraft.length >= 7);
  assert.ok(area.aircraft.some(a => a.flight === ''), 'blank callsigns are passed through for the page to label');

  const bad = await post(s.base, { kind: 'hex', value: 'zzz' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'invalid_search');
  assert.equal((await post(s.base, { kind: 'url', value: 'https://example.com' })).status, 400);
  assert.equal((await post(s.base, { kind: 'area', latitude: 95 })).status, 400);

  const notJson = await fetch(`${s.base}/api/query`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(notJson.status, 403, 'form posts from other sites are refused');
  assert.equal((await post(s.base, { kind: 'hex', value: 'a17c95' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await fetch(`${s.base}/api/query`)).status, 405);
  const big = await fetch(`${s.base}/api/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'hex', value: 'a'.repeat(5000) }) });
  assert.equal(big.status, 413);
  assert.equal((await fetch(`${s.base}/..%2fserver.js`)).status, 403);
  assert.equal((await fetch(`${s.base}/api/nothing`)).status, 404);

  const health = await (await fetch(`${s.base}/api/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.version, VERSION);
  assert.equal(health.feed.cooldown_seconds, 0);
  assert.ok(!/UNMOCKED/.test(s.log()));
});

test('twenty viewers of one flight cost one upstream request', async t => {
  const s = await start({ FAKE_ADSB: 'slow' });
  t.after(() => stop(s));
  const results = await Promise.all(Array.from({ length: 20 }, () => post(s.base, { kind: 'callsign', value: 'AAL1920' })));
  assert.ok(results.every(r => r.status === 200));
  assert.equal(s.upstream(), 1);
  // Different lookups at once are queued and paced, not refused.
  const mixed = await Promise.all(['N195UW', 'N1', 'N2'].map(v => post(s.base, { kind: 'registration', value: v })));
  assert.deepEqual(mixed.map(r => r.status), [200, 200, 200]);
});

test('a rate limit returns a structured retry time and survives a restart', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adsb-e2e-'));
  const s = await start({ FAKE_ADSB: '429' }, dataDir);
  const r = await post(s.base, { kind: 'callsign', value: 'AAL1920' });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '120');
  assert.deepEqual(await r.json(), { error: { code: 'rate_limited', message: 'adsb.fi asked us to slow down. Updates resume automatically.', retry_after_seconds: 120 } });
  // Another flight during the cooldown: refused without asking adsb.fi.
  const r2 = await post(s.base, { kind: 'hex', value: 'abcdef' });
  assert.equal(r2.status, 429);
  assert.ok((await r2.json()).error.retry_after_seconds <= 120);
  assert.equal(s.upstream(), 1);
  await stop(s);
  assert.ok(fs.readFileSync(path.join(dataDir, 'feed-state.json'), 'utf8').includes('cooldown_until'));

  const restarted = await start({}, dataDir);
  t.after(() => stop(restarted));
  const r3 = await post(restarted.base, { kind: 'callsign', value: 'AAL1920' });
  assert.equal(r3.status, 429, 'the cooldown outlives a restart');
  assert.equal(restarted.upstream(), 0);
  assert.match(restarted.log(), /cooldown restored/);
});

test('an HTTP-date Retry-After and feed failures', async t => {
  const s = await start({ FAKE_ADSB: '429date' });
  t.after(() => stop(s));
  const r = await post(s.base, { kind: 'callsign', value: 'AAL1920' });
  const secs = (await r.json()).error.retry_after_seconds;
  assert.ok(secs >= 85 && secs <= 91, String(secs));

  const f = await start({ FAKE_ADSB: '500' });
  t.after(() => stop(f));
  const e = await post(f.base, { kind: 'callsign', value: 'AAL1920' });
  assert.equal(e.status, 502);
  const err = (await e.json()).error;
  assert.equal(err.code, 'feed_unavailable');
  assert.equal(err.retry_after_seconds, 30);
  assert.equal((await post(f.base, { kind: 'callsign', value: 'AAL1920' })).status, 503, 'backing off, not retrying');
  assert.equal(f.upstream(), 1);
});

test('inside Home Assistant only the ingress proxy (and the app itself) may connect', async t => {
  const s = await start({ INGRESS_ONLY: 'true' });
  t.after(() => stop(s));
  // The test connects from 127.0.0.1, which is allowed; the rule is in server.js clientAllowed().
  assert.equal((await fetch(`${s.base}/api/health`)).status, 200);
  assert.match(s.log(), /ingress only/);
});
