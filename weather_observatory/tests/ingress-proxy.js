'use strict';
// Stands in for Home Assistant's ingress proxy during development: serves the
// app under a nested prefix, /api/hassio_ingress/<token>/, stripping it before
// forwarding, as Home Assistant does. Anything outside the prefix is a 404, so
// a root-relative URL in the page (/app.js, /api/query) fails loudly.
//
//   node adsb_tracker/tests/ingress-proxy.js            (proxy :8098 -> app :8099)
//   PROXY_PORT=8098 APP_PORT=8099 node adsb_tracker/tests/ingress-proxy.js

const http = require('http');

const PREFIX = process.env.INGRESS_PREFIX || '/api/hassio_ingress/Zx9_test-token/';

function start({ port = Number(process.env.PROXY_PORT) || 8098, appPort = Number(process.env.APP_PORT) || 8099, log = true } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url === PREFIX.slice(0, -1)) { res.writeHead(302, { Location: PREFIX }); return res.end(); }
    if (!req.url.startsWith(PREFIX)) {
      if (log) console.warn('[ingress] outside the prefix:', req.url);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Outside the ingress prefix');
    }
    const upstream = http.request({ host: '127.0.0.1', port: appPort, method: req.method, path: '/' + req.url.slice(PREFIX.length), headers: { ...req.headers, 'X-Ingress-Path': PREFIX.slice(0, -1) } }, up => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on('error', e => { res.writeHead(502); res.end(e.message); });
    req.pipe(upstream);
  });
  return new Promise(resolve => server.listen(port, () => {
    if (log) console.log(`[ingress] http://localhost:${server.address().port}${PREFIX} -> :${appPort}`);
    resolve({ server, port: server.address().port, seen, prefix: PREFIX });
  }));
}

if (require.main === module) start();
module.exports = { start, PREFIX };
