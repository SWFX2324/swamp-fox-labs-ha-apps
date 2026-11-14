'use strict';
// Local preview: the app against the fake Home Assistant and public services
// (fixtures/fake-world.js), behind the ingress stand-in. Open the printed URL.
//
//   node weather_observatory/tests/dev.js
//   FAKE_WORLD=alerts FAKE_RADAR=real node weather_observatory/tests/dev.js

const path = require('path');
const { spawn } = require('child_process');
const proxy = require('./ingress-proxy');

const APP_PORT = Number(process.env.APP_PORT) || 8097;
const child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/fake-world.js'), path.join(__dirname, '../app/server.js')], {
  env: { ...process.env, PORT: String(APP_PORT) },
  stdio: 'inherit',
});
proxy.start({ port: Number(process.env.PROXY_PORT) || 8096, appPort: APP_PORT });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(sig); process.exit(0); });
