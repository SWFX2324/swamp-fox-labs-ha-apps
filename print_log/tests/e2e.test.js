'use strict';
// End to end: the real server, with Home Assistant and the printer replaced by
// tests/fixtures/fake-printer.js, reached through the ingress stand-in. Each
// scenario starts its own server.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const proxy = require('./ingress-proxy');

const SERVER = path.join(__dirname, '../app/server.js');
const FAKE = path.join(__dirname, 'fixtures/fake-printer.js');
const SERIAL = '09400A000000001';

const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function start(world = '', env = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-log-test-'));
  const child = spawn(process.execPath, ['--require', FAKE, SERVER], { env: { ...process.env, PORT: String(port), FAKE_WORLD: world, APP_VERSION: 'test', DATA_DIR: dataDir, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 100 && !/listening/.test(log); i++) await sleep(50);
  const px = await proxy.start({ port: 0, appPort: port, log: false });
  const base = `http://127.0.0.1:${px.port}${px.prefix}`;
  const get = (p, init) => fetch(base + p, init);
  const json = async (p, init) => { const r = await get(p, init); return { status: r.status, body: await r.json() }; };
  const post = (p, body, type = 'application/json') => json(p, { method: 'POST', headers: { 'Content-Type': type }, body: type === 'application/json' ? JSON.stringify(body) : body });
  const state = async (until = s => s.ready && s.jobCount > 0) => {
    let s;
    for (let i = 0; i < 60; i++) { s = (await json('api/state')).body; if (until(s)) return s; await sleep(150); }
    return s;
  };
  return {
    base, get, json, post, state, dataDir, log: () => log,
    stop: () => { child.kill(); px.server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

test('the page and its assets load through the ingress prefix', async t => {
  const app = await start('');
  t.after(app.stop);
  const page = await app.get('');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /src="app\.js\?v=test"/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  for (const p of ['style.css?v=test', 'app.js', 'favicon.svg', 'assets/topo-dark.svg']) assert.equal((await app.get(p)).status, 200, p);
  assert.equal((await app.get('../../etc/passwd')).status, 404);
});

test('a print in progress: live card, spools, jobs from history, stats', async t => {
  const app = await start('');
  t.after(app.stop);
  const s = await app.state();
  assert.equal(s.printers.length, 1, 'MakerWorld is not a printer');
  const p = s.printers[0];
  assert.equal(p.name, 'Workshop H2D');
  assert.equal(p.live.status, 'running');
  assert.equal(p.live.progress, 40);
  assert.equal(p.live.feeding.label, 'A2');
  assert.equal(p.currentJob.name, 'Workbench pegboard hooks');
  assert.deepEqual(p.controls, { pause: null, resume: 'Only while paused.', stop: null, start: 'Start unlocks when the printer is idle.' });
  assert.deepEqual(p.units.map(u => u.label), ['AMS 1', 'AMS HT', 'External spool']);
  const spools = p.units.flatMap(u => u.spools);
  assert.deepEqual(spools.map(x => x.label), ['A1', 'A2', 'A3', 'A4', 'HT', 'Ext']);
  assert.equal(spools.find(x => x.label === 'A2').low, true, 'A2 runs out soon at this pace');
  assert.equal(spools.find(x => x.label === 'A4').grams, null, 'no RFID: amount unknown');
  assert.equal(p.units[1].drying, true);
  assert.equal(s.jobCount, 19);
  const names = s.jobs.map(j => j.name);
  assert.ok(names.includes('Garden hose guide'), 'a job with a Wi-Fi drop mid-print is one job');
  assert.equal(s.jobs.filter(j => j.name === 'Garden hose guide').length, 1);
  assert.equal(s.jobs.find(j => j.name === 'Shelf bracket' && j.result === 'failed').reason, 'Nozzle clog');
  assert.equal(s.jobs.find(j => j.name === 'Earbud case').result, 'stopped');
  assert.ok(s.jobs.every(j => j.cost === null || j.cost > 0));
  assert.ok(s.jobs.find(j => j.name === 'Spice rack labels').slots.length >= 2);
  assert.equal(s.stats.days.length, 30);
  assert.ok(s.stats.materials.some(m => m.type === 'PETG'));
  assert.ok(fs.existsSync(path.join(app.dataDir, 'jobs.json')), 'the log is kept in /data');
  const img = await app.get(`api/camera?printer=${SERIAL}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
});

test('pause, resume and stop go to the printer\'s own buttons, and a stop is logged as stopped', async t => {
  const app = await start('');
  t.after(app.stop);
  await app.state();
  let r = await app.post('api/control', { printer: SERIAL, action: 'resume' });
  assert.equal(r.status, 409, 'resume only while paused');
  r = await app.post('api/control', { printer: SERIAL, action: 'pause' });
  assert.equal(r.status, 200);
  let s = await app.state(x => x.printers?.[0].live.status === 'pause');
  assert.equal(s.printers[0].live.status, 'pause');
  assert.equal(s.printers[0].controls.resume, null);
  assert.equal((await app.post('api/control', { printer: SERIAL, action: 'resume' })).status, 200);
  assert.equal((await app.post('api/control', { printer: SERIAL, action: 'stop' })).status, 200);
  s = await app.state(x => x.jobs?.[0]?.name === 'Workbench pegboard hooks');
  assert.equal(s.jobs[0].name, 'Workbench pegboard hooks');
  assert.equal(s.jobs[0].result, 'stopped', 'the printer says failed; the app knows it sent Stop');
  assert.equal((await app.post('api/control', { printer: SERIAL, action: 'stop' })).status, 409, 'nothing to stop now');
  assert.equal((await app.post('api/control', { printer: SERIAL, action: 'reboot' })).status, 400);
  assert.match(app.log(), /\[print-log\] stop on Workshop H2D/);
});

test('files: list, plan, start, send a file, download', async t => {
  const app = await start('idle');
  t.after(app.stop);
  const s = await app.state();
  assert.equal(s.printers[0].controls.start, null);
  const { body: { files } } = await app.json(`api/files?printer=${SERIAL}`);
  assert.deepEqual(files.map(f => f.path), ['/Planter_drip_tray_plate_1.gcode.3mf', '/cache/Earbud_case_plate_1.gcode.3mf', '/Gridfinity_2x3_bins.3mf', '/Workbench_pegboard_hooks_plate_1.gcode.3mf'].sort((a, b) => files.findIndex(f => f.path === a) - files.findIndex(f => f.path === b)));
  assert.ok(!files.some(f => f.name.endsWith('.txt')), 'only .3mf files');
  assert.equal(files.length, 4);

  const plan = (await app.json(`api/plan?printer=${SERIAL}&path=${encodeURIComponent('/Gridfinity_2x3_bins.3mf')}`)).body;
  assert.deepEqual(plan.plates.map(p => p.index), [1, 2]);
  assert.deepEqual(plan.plates[0].mapping.map(m => m.trayId), [0, 1], 'white to A1, black to A2');
  assert.ok(plan.plates[0].thumb);
  assert.equal((await app.get(`api/thumb/${plan.plates[0].thumb}.png`)).headers.get('content-type'), 'image/png');

  let r = await app.post('api/start', { printer: SERIAL, path: '/Gridfinity_2x3_bins.3mf', plate: 1, mapping: [{ filament: 1, trayId: 0 }, { filament: 2, trayId: 254 }] });
  assert.equal(r.status, 400, 'the external spool is empty');
  r = await app.post('api/start', { printer: SERIAL, path: '/Gridfinity_2x3_bins.3mf', plate: 9, mapping: [] });
  assert.equal(r.status, 400);
  r = await app.post('api/start', { printer: SERIAL, path: '/Gridfinity_2x3_bins.3mf', plate: 1, mapping: [{ filament: 1, trayId: 0 }, { filament: 2, trayId: 1 }], timelapse: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(app.log(), /starting Gridfinity_2x3_bins\.3mf plate 1 on Workshop H2D \(slots 0,1\)/);
  const busy = await app.state(x => x.printers?.[0].live.status === 'prepare');
  assert.match(busy.printers[0].controls.start, /idle/);
  r = await app.post('api/start', { printer: SERIAL, path: '/Gridfinity_2x3_bins.3mf', plate: 1, mapping: [{ filament: 1, trayId: 0 }, { filament: 2, trayId: 1 }] });
  assert.equal(r.status, 409, 'not while it is busy');

  const dl = await app.get(`api/download?printer=${SERIAL}&path=${encodeURIComponent('/cache/Earbud_case_plate_1.gcode.3mf')}`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /attachment; filename="Earbud_case_plate_1\.gcode\.3mf"/);
  const bytes = Buffer.from(await dl.arrayBuffer());
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);

  r = await app.post(`api/upload?printer=${SERIAL}&name=${encodeURIComponent('New part (v2).3mf')}`, bytes, 'application/octet-stream');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.path, '/New part (v2).3mf');
  assert.equal(r.body.plan.plates.length, 1, 'read on the way through');
  const after = (await app.json(`api/files?printer=${SERIAL}`)).body.files;
  assert.ok(after.some(f => f.name === 'New part (v2).3mf' && f.thumb));
});

test('refusals: bad files, paths, names and cross-site requests', async t => {
  const app = await start('idle');
  t.after(app.stop);
  await app.state();
  const q = `printer=${SERIAL}`;
  let r = await app.post(`api/upload?${q}&name=evil.3mf`, Buffer.from('not a zip file at all'), 'application/octet-stream');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /isn't a .3mf/);
  r = await app.post(`api/upload?${q}&name=${encodeURIComponent('../../etc/x.3mf')}`, Buffer.from('PK\x03\x04xxxx'), 'application/octet-stream');
  assert.equal(r.status, 400);
  r = await app.post(`api/upload?${q}&name=run.sh`, Buffer.from('PK\x03\x04xxxx'), 'application/octet-stream');
  assert.equal(r.status, 400);
  assert.equal((await app.json('api/health')).status, 200, 'still running after bad uploads');
  r = await app.json(`api/download?${q}&path=${encodeURIComponent('/etc/passwd')}`);
  assert.equal(r.status, 404);
  r = await app.json(`api/download?${q}&path=${encodeURIComponent('/notes.txt')}`);
  assert.equal(r.status, 404, 'only .3mf files are offered');
  r = await app.json(`api/plan?${q}&path=${encodeURIComponent('/x\r\nDELE /a.3mf')}`);
  assert.equal(r.status, 400);
  r = await app.post('api/control', { printer: SERIAL, action: 'stop' }, 'text/plain');
  assert.equal(r.status, 403, 'a form post from another site is refused');
  r = await app.json('api/control', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, body: JSON.stringify({ printer: SERIAL, action: 'stop' }) });
  assert.equal(r.status, 403);
  r = await app.json('api/control', { method: 'GET' });
  assert.equal(r.status, 405);
  r = await app.post('api/control', { printer: 'NOPE', action: 'pause' });
  assert.equal(r.status, 404);
  assert.equal((await app.get('api/thumb/../../options.json')).status, 404);
  const s = (await app.json('api/state')).body;
  assert.ok(!JSON.stringify(s).includes('fake-access-code'), 'the access code never reaches the page');
  assert.ok(!JSON.stringify(s).includes('fake-token'), 'nor does the token');
  assert.doesNotMatch(app.log(), /fake-access-code/);
});

test('Developer LAN mode off: the page says so and nothing is sent', async t => {
  const app = await start('no_lan');
  t.after(app.stop);
  const s = await app.state();
  const c = s.printers[0].controls;
  assert.match(c.pause, /Developer LAN mode/);
  assert.match(c.stop, /Developer LAN mode/);
  assert.equal((await app.post('api/control', { printer: SERIAL, action: 'stop' })).status, 409);
});

test('controls off in the options: view only', async t => {
  const app = await start('idle', { OPTIONS_JSON: JSON.stringify({ allow_controls: false, printer_access_code: 'fake-access-code' }) });
  t.after(app.stop);
  const s = await app.state();
  assert.equal(s.settings.allowControls, false);
  assert.match(s.printers[0].controls.start, /off/);
  const r = await app.post('api/start', { printer: SERIAL, path: '/Gridfinity_2x3_bins.3mf', plate: 1, mapping: [{ filament: 1, trayId: 0 }, { filament: 2, trayId: 1 }] });
  assert.equal(r.status, 409);
  assert.doesNotMatch(app.log(), /starting/);
});

test('no access code: no file features, the rest works', async t => {
  const app = await start('no_code,idle');
  t.after(app.stop);
  const s = await app.state();
  assert.equal(s.printers[0].files, false);
  assert.match(s.printers[0].controls.start, /access code/);
  const r = await app.json(`api/files?printer=${SERIAL}`);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /access code/);
});

test('wrong access code: a clear message', async t => {
  const app = await start('idle', { OPTIONS_JSON: JSON.stringify({ allow_controls: true, printer_access_code: 'wrong' }) });
  t.after(app.stop);
  await app.state();
  const r = await app.json(`api/files?printer=${SERIAL}`);
  assert.equal(r.status, 502);
  assert.match(r.body.error, /refused the access code/);
});

test('a fresh install with no history, and no AMS', async t => {
  const app = await start('empty,no_ams,idle');
  t.after(app.stop);
  const s = await app.state(x => x.ready && x.printers?.length);
  assert.equal(s.jobCount, 0);
  assert.deepEqual(s.printers[0].units.map(u => u.label), ['External spool']);
});

test('Home Assistant unreachable: the page says so', async t => {
  const app = await start('ha_down');
  t.after(app.stop);
  const s = (await app.json('api/state')).body;
  assert.equal(s.ready, false);
  assert.match(s.error, /reach Home Assistant/);
});
