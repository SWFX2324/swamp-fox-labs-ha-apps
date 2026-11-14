'use strict';
// Local preview: the app with the synthetic feed (fixtures/fake-adsbfi.js),
// behind the ingress stand-in. Open the printed URL.
//
//   node adsb_tracker/tests/dev.js
//   FAKE_TRIP_MINUTES=5 node adsb_tracker/tests/dev.js

const path = require('path');
const { spawn } = require('child_process');
const proxy = require('./ingress-proxy');

const APP_PORT = Number(process.env.APP_PORT) || 8099;
const child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/fake-adsbfi.js'), path.join(__dirname, '../app/server.js')], {
  env: { ...process.env, PORT: String(APP_PORT), FAKE_ADSB_LOG: '1' },
  stdio: 'inherit',
});
proxy.start({ appPort: APP_PORT });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(sig); process.exit(0); });
