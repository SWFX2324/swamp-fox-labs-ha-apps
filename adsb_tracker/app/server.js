'use strict';
// ADS-B Tracker: serves the page through Home Assistant ingress and answers
// one data endpoint, POST api/query, from the shared Provider (provider.js).
// No dependencies beyond Node itself.
//
// Development: PORT=8099 node adsb_tracker/app/server.js, then open
// http://localhost:8099. Outside Home Assistant any client may connect; set
// INGRESS_ONLY=true to test the "ingress proxy only" rule.

const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const { Provider, ProviderError } = require('./provider');

const PORT = Number(process.env.PORT) || 8099;
const STATIC_DIR = path.join(__dirname, 'static');
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : null);
const VERSION = process.env.APP_VERSION || 'dev';
const STARTED = new Date().toISOString();

const provider = new Provider({
  stateFile: DATA_DIR ? path.join(DATA_DIR, 'feed-state.json') : null,
  userAgent: `HomeAssistant-ADSBTracker/${VERSION} (personal use)`,
});

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    // Map tiles come from Esri; everything else is served by this app.
    "img-src 'self' data: https://server.arcgisonline.com",
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

const sendError = (res, err) => {
  const e = err instanceof ProviderError ? err : new ProviderError('server_error', 'Something went wrong in the app.', 500);
  if (!(err instanceof ProviderError)) console.error('[http]', err);
  send(res, e.status || 500, e.toJSON(), e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : {});
};

// ---- static files ---------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

// Asset links in index.html carry the version, so a browser never mixes an
// old app.js with a new page after an update. In development the start time
// stands in for the version.
const RELEASED = VERSION !== 'dev';
const ASSET_VERSION = RELEASED ? VERSION : String(Date.parse(STARTED));
const VERSIONED = /((?:src|href)=")(lib\/leaflet\/leaflet\.(?:css|js)|style\.css|tracker\.js|app\.js)"/g;
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
  try { rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, ''); } catch { return send(res, 400, { error: { code: 'bad_path', message: 'Bad path' } }); }
  const file = path.resolve(STATIC_DIR, rel);
  if (!file.startsWith(STATIC_DIR + path.sep)) return send(res, 403, { error: { code: 'forbidden', message: 'Forbidden' } });
  staticFile(file, rel === 'index.html', (err, f) => {
    if (err) return send(res, 404, { error: { code: 'not_found', message: 'Not found' } });
    const cache = f.isPage ? 'no-store' : RELEASED && url.searchParams.get('v') === ASSET_VERSION ? 'public, max-age=31536000, immutable' : 'no-cache';
    const gzip = f.gzip && acceptsGzip(req);
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': f.type, 'Cache-Control': cache, Vary: 'Accept-Encoding', ...(gzip && { 'Content-Encoding': 'gzip' }) });
    res.end(req.method === 'HEAD' ? undefined : gzip ? f.gzip : f.data);
  });
}

// ---- access rules -----------------------------------------------------------

// Inside Home Assistant only the ingress proxy may connect, so nothing else on
// the internal network can use this app as a way out to the feed.
const INGRESS_PROXY = '172.30.32.2';
const IN_HOME_ASSISTANT = fs.existsSync('/data') || process.env.INGRESS_ONLY === 'true';

function clientAllowed(req) {
  if (!IN_HOME_ASSISTANT) return true;
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === INGRESS_PROXY || ip === '127.0.0.1' || ip === '::1';
}

// A page on another site can't send a JSON POST without a CORS preflight,
// which this server never approves, and browsers mark cross-site requests.
function postAllowed(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return false;
  return /^application\/json\b/i.test(req.headers['content-type'] || '');
}

function readJson(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      // Keep draining (so the 413 reaches the client) but stop storing.
      if (size > limit) { if (!tooBig) reject(new ProviderError('invalid_search', 'Request too large.', 413)); tooBig = true; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new ProviderError('invalid_search', 'Request was not JSON.', 400)); }
    });
    req.on('error', reject);
  });
}

// ---- server -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    if (!clientAllowed(req)) {
      console.warn(`[http] refused ${req.socket.remoteAddress}: only Home Assistant ingress may connect`);
      return send(res, 403, { error: { code: 'forbidden', message: 'Open ADS-B Tracker from the Home Assistant sidebar.' } });
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/query') {
      if (req.method !== 'POST') return send(res, 405, { error: { code: 'method', message: 'Use POST' } }, { Allow: 'POST' });
      if (!postAllowed(req)) return send(res, 403, { error: { code: 'forbidden', message: 'Request refused' } });
      const params = await readJson(req);
      return send(res, 200, await provider.query(params));
    }
    if (url.pathname === '/api/health') {
      return send(res, 200, { ok: true, version: VERSION, started: STARTED, feed: provider.status() });
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: { code: 'not_found', message: 'Not found' } });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: { code: 'method', message: 'Method not allowed' } });
    return serveStatic(url, req, res);
  } catch (e) {
    sendError(res, e);
  }
});

server.listen(PORT, () => {
  console.log(`[adsb-tracker] ${VERSION} listening on :${PORT}${IN_HOME_ASSISTANT ? ' (ingress only)' : ''}`);
});

// Home Assistant stops the app with SIGTERM. The cooldown is already saved
// when it starts; close cleanly.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    provider.saveState();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
