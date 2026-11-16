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
const child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/fake-printer.js'), path.join(__dirname, '../app/server.js')], {
  env: { ...process.env, PORT: String(APP_PORT), DATA_DIR: dataDir },
  stdio: 'inherit',
});
proxy.start({ port: Number(process.env.PROXY_PORT) || 8186, appPort: APP_PORT });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(sig); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0); });
