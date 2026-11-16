'use strict';
// Local preview: the app against the fake Home Assistant and printer
// (fixtures/fake-printer.js), behind the ingress stand-in. Open the printed URL.
//
//   node print_log/tests/dev.js
//   FAKE_WORLD=idle node print_log/tests/dev.js
//
// Its job log and thumbnails go to a temporary folder that's removed on exit.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const proxy = require('./ingress-proxy');

const APP_PORT = Number(process.env.APP_PORT) || 8187;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-log-dev-'));
// Two hours of made-up power readings and 30 days of energy, so the energy
// card isn't empty (the real app collects its own).
const now = Date.now();
const series = [];
for (let t = now - 2 * 3600_000; t < now; t += 30_000) series.push([t, Math.round(150 + 25 * Math.sin(t / 4e5) + (t > now - 80 * 60_000 ? 0 : -120))]);
const days = {};
for (let i = 0; i < 30; i++) days[new Date(now - i * 864e5).toISOString().slice(0, 10)] = 120 + (i * 37) % 400;
fs.writeFileSync(path.join(dataDir, 'energy.json'), JSON.stringify({ days: { '09400A000000001': days }, jobs: {}, series: { '09400A000000001': series }, last: {}, since: now - 30 * 864e5 }));

const child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/fake-printer.js'), path.join(__dirname, '../app/server.js')], {
  env: { ...process.env, PORT: String(APP_PORT), DATA_DIR: dataDir },
  stdio: 'inherit',
});
proxy.start({ port: Number(process.env.PROXY_PORT) || 8186, appPort: APP_PORT });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(sig); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0); });
