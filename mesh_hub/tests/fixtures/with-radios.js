'use strict';
// Preloaded into the server (node --require) for the container smoke test: the
// made-up public maps (fake-web.js) plus both simulated radios listening on
// 127.0.0.1, ports 14403 (Meshtastic) and 15000 (MeshCore), in the same
// process. Point the app at them with MESHTASTIC_HOST=127.0.0.1
// MESHTASTIC_PORT=14403 MESHCORE_HOST=127.0.0.1 MESHCORE_PORT=15000.

require('./fake-web');
const { startMeshtastic, startMeshCore } = require('./fake-radios');

startMeshtastic({ port: 14403 }).then(() => console.log('[fake-radios] Meshtastic on :14403'));
startMeshCore({ port: 15000 }).then(() => console.log('[fake-radios] MeshCore on :15000'));
