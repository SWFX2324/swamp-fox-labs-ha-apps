'use strict';
// Local preview: the app against two simulated radios (fixtures/fake-radios.js)
// that chat every few seconds and the made-up public maps
// (fixtures/fake-web.js), behind the ingress stand-in. Open the printed URL.
//
//   node mesh_hub/tests/dev.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const proxy = require('./ingress-proxy');
const { startMeshtastic, startMeshCore, HOME } = require('./fixtures/fake-radios');

const APP_PORT = Number(process.env.APP_PORT) || 8099;

(async () => {
  const mt = await startMeshtastic({ chatter: true });
  const mc = await startMeshCore({ chatter: true });
  const dataDir = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-hub-dev-'));
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/fake-web.js'), path.join(__dirname, '../app/server.js')], {
    env: {
      ...process.env, PORT: String(APP_PORT), DATA_DIR: dataDir, FAKE_WEB_LOG: '1',
      MESHTASTIC_HOST: '127.0.0.1', MESHTASTIC_PORT: String(mt.port), MESHCORE_HOST: '127.0.0.1', MESHCORE_PORT: String(mc.port),
      HOME_LAT: String(HOME.lat), HOME_LON: String(HOME.lon),
    },
    stdio: 'inherit',
  });
  proxy.start({ appPort: APP_PORT });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(sig); process.exit(0); });
})();
