'use strict';
// Local preview: the app against the fake Home Assistant and UniFi console
// (fixtures/fake-world.js), behind the ingress stand-in. Open the printed URL.
//
//   node station_health/tests/dev.js
//   FAKE_WORLD=pc_off,ap_down node station_health/tests/dev.js
//
// The preview starts with 24 hours of made-up internet samples, so the graph
// and the uptime row aren't empty (the real app collects its own).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const proxy = require('./ingress-proxy');

const APP_PORT = Number(process.env.APP_PORT) || 8091;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-health-dev-'));
const now = Date.now(), step = 5 * 60_000;
const samples = [];
for (let t = now - 24 * 3600_000 + step; t < now; t += step) {
  const h = new Date(t).getHours() + new Date(t).getMinutes() / 60;
  const evening = Math.exp(-((h - 20.5) ** 2) / 6); // busiest in the evening
  const wobble = Math.abs(Math.sin(t / 3.7e6)) * 0.35;
  samples.push({ t, up: true, down: Math.round((25 + 330 * evening + 120 * wobble) * 1e6), upl: Math.round((4 + 18 * evening + 9 * wobble) * 1e6), ms: 17 });
}
fs.writeFileSync(path.join(dataDir, 'wan-samples.json'), JSON.stringify(samples));

const child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/fake-world.js'), path.join(__dirname, '../app/server.js')], {
  env: { ...process.env, PORT: String(APP_PORT), DATA_DIR: dataDir },
  stdio: 'inherit',
});
proxy.start({ port: Number(process.env.PROXY_PORT) || 8090, appPort: APP_PORT });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(sig); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0); });
