'use strict';
// Station Health: serves the page through Home Assistant ingress and answers
// GET api/state with one snapshot (station.js). View only: nothing here can
// start, stop, restart or change anything. No dependencies beyond Node.
//
// Development: node station_health/tests/dev.js runs it against a fake Home
// Assistant and a fake UniFi console, behind an ingress stand-in.

const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const { HomeAssistant, containerEnv } = require('./ha');
const { UniFi } = require('./unifi');
const { Station } = require('./station');

const PORT = Number(process.env.PORT) || 8099;
const STATIC_DIR = path.join(__dirname, 'static');
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : null);
// The image sets APP_VERSION; s6 may have kept it only in its saved copy.
process.env.APP_VERSION = containerEnv('APP_VERSION') || 'dev';
const VERSION = process.env.APP_VERSION;
const STARTED = new Date().toISOString();

function readOptions() {
  if (process.env.OPTIONS_JSON) { try { return JSON.parse(process.env.OPTIONS_JSON); } catch { return {}; } }
  if (!DATA_DIR) return {};
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'options.json'), 'utf8')); } catch { return {}; }
}

const options = readOptions();
const ha = new HomeAssistant();
const unifi = new UniFi({
  host: options.unifi_host, username: options.unifi_username, password: options.unifi_password,
  site: options.unifi_site, verifySsl: options.unifi_verify_ssl === true,
});
const station = new Station({ ha, unifi, dataDir: DATA_DIR });

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
    "connect-src 'self'", "font-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'",
  ].join('; '),
};

const acceptsGzip = req => /\bgzip\b/.test(req?.headers['accept-encoding'] || '');
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg)/;

function send(res, status, body, extra = {}) {
  let data = JSON.stringify(body);
  const headers = { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding', ...extra };
  if (Buffer.byteLength(data) > 1400 && acceptsGzip(res.req)) {
    data = zlib.gzipSync(data, { level: 5 });
    headers['Content-Encoding'] = 'gzip';
  }
  res.writeHead(status, headers);
  res.end(data);
}

// ---- static files ---------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

// Asset links in index.html carry the version, so a browser never mixes an
// old app.js with a new page after an update.
const RELEASED = VERSION !== 'dev';
const ASSET_VERSION = RELEASED ? VERSION : String(Date.parse(STARTED));
const VERSIONED = /((?:src|href)=")(style\.css|app\.js)"/g;
const staticCache = new Map();

function staticFile(file, isPage, cb) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return cb(err || new Error('not a file'));
    const hit = staticCache.get(file);
    if (hit && hit.mtime === st.mtimeMs) return cb(null, hit);
    fs.readFile(file, (err2, raw) => {
      if (err2) return cb(err2);
      const data = isPage ? Buffer.from(raw.toString('utf8').replace(VERSIONED, (_, attr, f) => `${attr}${f}?v=${encodeURIComponent(ASSET_VERSION)}"`)) : raw;
      const type = MIME[path.extname(file)] || 'application/octet-stream';
      const entry = { mtime: st.mtimeMs, isPage, type, data, gzip: COMPRESSIBLE.test(type) && data.length > 1400 ? zlib.gzipSync(data, { level: 9 }) : null };
      staticCache.set(file, entry);
      cb(null, entry);
    });
  });
}

function serveStatic(url, req, res) {
  let rel;
  try { rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, ''); } catch { return send(res, 400, { error: 'Bad path' }); }
  const file = path.resolve(STATIC_DIR, rel);
  if (!file.startsWith(STATIC_DIR + path.sep)) return send(res, 403, { error: 'Forbidden' });
  staticFile(file, rel === 'index.html', (err, f) => {
    if (err) return send(res, 404, { error: 'Not found' });
    const cache = f.isPage ? 'no-store' : RELEASED && url.searchParams.get('v') === ASSET_VERSION ? 'public, max-age=31536000, immutable' : 'no-cache';
    const gzip = f.gzip && acceptsGzip(req);
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': f.type, 'Cache-Control': cache, Vary: 'Accept-Encoding', ...(gzip && { 'Content-Encoding': 'gzip' }) });
    res.end(req.method === 'HEAD' ? undefined : gzip ? f.gzip : f.data);
  });
}

// ---- access rules -----------------------------------------------------------

// Inside Home Assistant only the ingress proxy may connect, so nothing else on
// the internal network can read the home's network details through this app.
const INGRESS_PROXY = '172.30.32.2';
const IN_HOME_ASSISTANT = fs.existsSync('/data') || process.env.INGRESS_ONLY === 'true';

function clientAllowed(req) {
  if (!IN_HOME_ASSISTANT) return true;
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === INGRESS_PROXY || ip === '127.0.0.1' || ip === '::1';
}

// A forced refresh is a POST. Another site can't send one without a CORS
// preflight (never approved here), and browsers mark cross-site requests.
function postAllowed(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return false;
  return /^application\/json\b/i.test(req.headers['content-type'] || '');
}

// ---- server -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    if (!clientAllowed(req)) {
      console.warn(`[http] refused ${req.socket.remoteAddress}: only Home Assistant ingress may connect`);
      return send(res, 403, { error: 'Open Station Health from the Home Assistant sidebar.' });
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/state') {
      if (req.method !== 'GET') return send(res, 405, { error: 'Use GET' }, { Allow: 'GET' });
      return send(res, 200, await station.snapshot());
    }
    if (url.pathname === '/api/refresh') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' }, { Allow: 'POST' });
      if (!postAllowed(req)) return send(res, 403, { error: 'Request refused' });
      req.resume();
      return send(res, 200, await station.snapshot({ force: true, waitMs: 10_000 }));
    }
    if (url.pathname === '/api/health') {
      return send(res, 200, { ok: true, version: VERSION, started: STARTED, homeAssistant: ha.available, unifi: unifi.configured, sources: station.status() });
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    return serveStatic(url, req, res);
  } catch (e) {
    console.error('[http]', e);
    send(res, 500, { error: 'Something went wrong in the app.' });
  }
});

server.listen(PORT, () => {
  console.log(`[station-health] ${VERSION} listening on :${PORT}${IN_HOME_ASSISTANT ? ' (ingress only)' : ''}; UniFi console: ${unifi.configured ? `${unifi.host}, site ${unifi.site}` : 'not set up'}`);
  if (!ha.available) console.warn('[station-health] no Supervisor token: Home Assistant data will show as unavailable');
  station.start();
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    station.stop();
    ha.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
