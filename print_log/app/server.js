'use strict';
// Print Log: serves the page through Home Assistant ingress.
//
//   GET  api/state                    everything the page shows
//   POST api/control   {printer, action: pause|resume|stop}
//   POST api/light     {printer, on: true|false}   the chamber light
//   GET  api/files?printer=           .3mf files on the printer
//   GET  api/plan?printer=&path=      a file's plates and suggested AMS slots
//   POST api/start     {printer, path, plate, mapping, …}
//   POST api/upload?printer=&name=    the .3mf itself as the body
//   GET  api/download?printer=&path=  a file from the printer, to open in Bambu Studio
//   GET  api/camera?printer=          a camera snapshot
//   GET  api/thumb/<id>.png           a plate picture from a .3mf
//
// No dependencies beyond Node. Development: node print_log/tests/dev.js runs it
// against a fake Home Assistant and a fake printer, behind an ingress stand-in.

const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const { HomeAssistant, containerEnv } = require('./ha');
const { PrintLog, UserError, FtpError } = require('./printlog');

const PORT = Number(process.env.PORT) || 8099;
const STATIC_DIR = path.join(__dirname, 'static');
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : null);
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
const log = new PrintLog({ ha, options, dataDir: DATA_DIR, ...(global.__printLogFiles && { filesFactory: global.__printLogFiles }) });

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
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

// Inside Home Assistant only the ingress proxy may connect. Home Assistant
// checks the user is signed in (and, with panel_admin, an administrator)
// before it forwards anything.
const INGRESS_PROXY = '172.30.32.2';
const IN_HOME_ASSISTANT = fs.existsSync('/data') || process.env.INGRESS_ONLY === 'true';

function clientAllowed(req) {
  if (!IN_HOME_ASSISTANT) return true;
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === INGRESS_PROXY || ip === '127.0.0.1' || ip === '::1';
}

// Actions are POSTs from this page only. Another site can't send a JSON or
// octet-stream POST without a CORS preflight (never approved here), and
// browsers mark cross-site requests.
function postAllowed(req, type = 'application/json') {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return false;
  return new RegExp(`^${type.replace('/', '\\/')}\\b`, 'i').test(req.headers['content-type'] || '');
}

function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(new UserError('Request too big.', 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new UserError('Bad request.')); } });
    req.on('error', reject);
  });
}

const contentDisposition = name => {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

function fail(res, e) {
  if (e instanceof UserError) return send(res, e.status, { error: e.message });
  if (e instanceof FtpError) return send(res, 502, { error: e.message });
  if (e?.name === 'HaError') return send(res, 502, { error: e.message });
  if (e?.name === 'ThreeMfError') return send(res, 400, { error: e.message });
  console.error('[http]', e);
  return send(res, 500, { error: 'Something went wrong in the app.' });
}

// ---- server -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    if (!clientAllowed(req)) {
      console.warn(`[http] refused ${req.socket.remoteAddress}: only Home Assistant ingress may connect`);
      return send(res, 403, { error: 'Open Print Log from the Home Assistant sidebar.' });
    }
    const url = new URL(req.url, 'http://localhost');
    const q = k => url.searchParams.get(k) || '';
    const route = url.pathname;
    const method = (m, ...types) => {
      if (req.method !== m) { send(res, 405, { error: `Use ${m}` }, { Allow: m }); return false; }
      if (m === 'POST' && !types.some(t => postAllowed(req, t))) { req.resume(); send(res, 403, { error: 'Request refused' }); return false; }
      return true;
    };

    if (route === '/api/state') { if (!method('GET')) return; return send(res, 200, await log.snapshot()); }
    if (route === '/api/health') return send(res, 200, { ok: true, version: VERSION, started: STARTED, homeAssistant: ha.available, ...log.status() });

    if (route === '/api/control') {
      if (!method('POST', 'application/json')) return;
      const b = await readJson(req);
      return send(res, 200, await log.control(String(b.printer || ''), String(b.action || '')));
    }
    if (route === '/api/light') {
      if (!method('POST', 'application/json')) return;
      const b = await readJson(req);
      return send(res, 200, await log.light(String(b.printer || ''), b.on));
    }
    if (route === '/api/start') {
      if (!method('POST', 'application/json')) return;
      const b = await readJson(req);
      return send(res, 200, await log.startPrint(String(b.printer || ''), b));
    }
    if (route === '/api/files') {
      if (!method('GET')) return;
      return send(res, 200, { files: await log.listFiles(q('printer'), { force: q('fresh') === '1' }) });
    }
    if (route === '/api/plan') {
      if (!method('GET')) return;
      return send(res, 200, await log.plan(q('printer'), q('path')));
    }
    if (route === '/api/upload') {
      if (!method('POST', 'application/octet-stream')) return;
      return send(res, 200, await log.upload(q('printer'), q('name'), req, Number(req.headers['content-length'])));
    }
    if (route === '/api/download') {
      if (!method('GET')) return;
      let started = false;
      try {
        await log.download(q('printer'), q('path'), (stream, size, name) => new Promise((resolve, reject) => {
          started = true;
          res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml', 'Content-Disposition': contentDisposition(name), 'Cache-Control': 'no-store', ...(size && { 'Content-Length': size }) });
          stream.pipe(res);
          stream.on('end', resolve);
          stream.on('error', reject);
          res.on('close', () => { stream.destroy(); resolve(); });
        }));
      } catch (e) {
        if (started) { res.destroy(); return; }
        throw e;
      }
      return;
    }
    if (route === '/api/camera') {
      if (!method('GET')) return;
      const img = await log.cameraImage(q('printer'));
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
      return res.end(img);
    }
    const thumb = route.match(/^\/api\/thumb\/([0-9a-f]{24})\.png$/);
    if (thumb) {
      const img = log.thumb(thumb[1]);
      if (!img) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=86400' });
      return res.end(img);
    }
    if (route.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    return serveStatic(url, req, res);
  } catch (e) {
    if (res.headersSent) { res.destroy(); return; }
    fail(res, e);
  }
});

// Uploads can take a while on Wi-Fi.
server.requestTimeout = 30 * 60_000;

server.listen(PORT, () => {
  const code = String(options.printer_access_code || '').trim();
  console.log(`[print-log] ${VERSION} listening on :${PORT}${IN_HOME_ASSISTANT ? ' (ingress only)' : ''}; controls ${options.allow_controls === false ? 'off' : 'on'}; printer files ${code ? 'on' : 'off (no access code)'}`);
  if (!ha.available) console.warn('[print-log] no Supervisor token: Home Assistant data will show as unavailable');
  log.start();
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log.stop();
    ha.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
