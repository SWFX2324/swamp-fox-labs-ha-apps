'use strict';
// Mesh Hub: one page for a Meshtastic node and a MeshCore companion radio on
// your network (both over TCP), plus public nodes near home from the community
// maps. Serves the page through Home Assistant ingress and three endpoints:
//
//   GET  api/state?rev=&web=   both radios, their nodes and chats, messages
//                              changed since `rev`, and the public map nodes
//                              when they changed since `web`
//   POST api/send              { network, chat, text } (when sending is on)
//   GET  api/health
//
// No dependencies beyond Node itself.
//
// Development: node mesh_hub/tests/dev.js runs it against simulated radios.
// Outside Home Assistant set MESHTASTIC_HOST / MESHCORE_HOST (and _PORT),
// HOME_LAT / HOME_LON, and any client may connect unless INGRESS_ONLY=true.

const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const { MeshtasticClient } = require('./meshtastic');
const { MeshCoreClient } = require('./meshcore');
const { WebMaps } = require('./webmaps');
const { MessageStore } = require('./messages');

const PORT = Number(process.env.PORT) || 8099;
const STATIC_DIR = path.join(__dirname, 'static');
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : null);
const STARTED = new Date().toISOString();

// s6-overlay starts the app with a cleaned environment, so a variable the
// container has (the Supervisor's token, the image's APP_VERSION) may only be
// in s6's saved copy.
function containerEnv(name) {
  if (process.env[name]) return process.env[name];
  for (const dir of ['/run/s6/container_environment', '/var/run/s6/container_environment']) {
    try {
      const value = fs.readFileSync(`${dir}/${name}`, 'utf8').trim();
      if (value) return value;
    } catch { /* not there */ }
  }
  return '';
}
const VERSION = containerEnv('APP_VERSION') || 'dev';

// ---- settings -----------------------------------------------------------------

function readOptions() {
  if (!DATA_DIR) return {};
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'options.json'), 'utf8')); } catch { return {}; }
}
const opts = readOptions();
const HOST = /^[A-Za-z0-9.-]{1,253}$|^\[?[0-9A-Fa-f:]{2,39}\]?$/;
const host = v => { const s = String(v || '').trim(); return HOST.test(s) ? s.replace(/^\[|\]$/g, '') : ''; };
const port = (v, d) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 65536 ? n : d; };
const settings = {
  meshtasticHost: host(process.env.MESHTASTIC_HOST ?? opts.meshtastic_host),
  meshtasticPort: port(process.env.MESHTASTIC_PORT ?? opts.meshtastic_port, 4403),
  meshcoreHost: host(process.env.MESHCORE_HOST ?? opts.meshcore_host),
  meshcorePort: port(process.env.MESHCORE_PORT ?? opts.meshcore_port, 5000),
  allowSending: (process.env.ALLOW_SENDING ?? opts.allow_sending) !== false && (process.env.ALLOW_SENDING ?? opts.allow_sending) !== 'false',
  publicMaps: (process.env.PUBLIC_MAPS ?? opts.public_maps) !== false && (process.env.PUBLIC_MAPS ?? opts.public_maps) !== 'false',
  radiusKm: Math.min(500, Math.max(10, Number(process.env.MAP_RADIUS_KM ?? opts.map_radius_km) || 100)),
};

// ---- the radios, the maps and the messages --------------------------------------

const store = new MessageStore({ file: DATA_DIR ? path.join(DATA_DIR, 'messages.json') : null });
const clients = {
  meshtastic: new MeshtasticClient({ host: settings.meshtasticHost, port: settings.meshtasticPort }),
  meshcore: new MeshCoreClient({ host: settings.meshcoreHost, port: settings.meshcorePort }),
};
for (const c of Object.values(clients)) {
  c.on('message', m => store.add(m));
  c.on('message-update', (id, patch) => store.update(id, patch));
  c.on('change', () => maybeCenterFromRadio());
  c.start();
}

const web = new WebMaps({
  enabled: settings.publicMaps,
  radiusKm: settings.radiusKm,
  stateFile: DATA_DIR ? path.join(DATA_DIR, 'public-nodes.json') : null,
  userAgent: `HomeAssistant-MeshHub/${VERSION} (personal use)`,
});

// Home: Home Assistant's home location. Until that's known (or outside Home
// Assistant without HOME_LAT/HOME_LON), a radio's own position stands in.
let home = null;
let homeSource = null;
function setHome(center, source) {
  if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lon) || (center.lat === 0 && center.lon === 0)) return;
  home = { lat: center.lat, lon: center.lon };
  homeSource = source;
  web.setCenter(home);
}
function maybeCenterFromRadio() {
  if (homeSource === 'home_assistant' || homeSource === 'env') return;
  for (const c of Object.values(clients)) {
    const s = c.snapshot().self;
    if (s && s.lat != null && s.lon != null) { if (!home) setHome({ lat: s.lat, lon: s.lon }, 'radio'); return; }
  }
}
async function loadHome() {
  if (process.env.HOME_LAT && process.env.HOME_LON) return setHome({ lat: Number(process.env.HOME_LAT), lon: Number(process.env.HOME_LON) }, 'env');
  const token = containerEnv('SUPERVISOR_TOKEN');
  if (!token) return;
  try {
    const res = await fetch(process.env.HA_REST_URL ? `${process.env.HA_REST_URL}/config` : 'http://supervisor/core/api/config', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cfg = await res.json();
    setHome({ lat: Number(cfg.latitude), lon: Number(cfg.longitude) }, 'home_assistant');
  } catch (e) {
    console.warn(`[home] couldn’t read Home Assistant’s home location (${e.message}); trying again in 10 minutes`);
    setTimeout(loadHome, 10 * 60_000).unref();
  }
}
loadHome();

function webRev() {
  const s = web.snapshot();
  return [s.meshtastic.fetchedAt, s.meshtastic.error, s.meshtastic.loading, s.meshcore.fetchedAt, s.meshcore.error, s.meshcore.loading, home?.lat, home?.lon].join('|');
}

function state(params) {
  const networks = {};
  for (const [k, c] of Object.entries(clients)) {
    const snap = c.snapshot();
    const names = new Map(snap.nodes.map(n => [n.id, n.name]));
    const dms = store.directChats(k).map(d => ({ key: d.key, network: k, kind: 'dm', peer: d.peer, name: names.get(d.peer) || d.fallbackName || d.peer.slice(0, 9), last: d.last }));
    networks[k] = { ...snap, chats: [...snap.chats, ...dms.sort((a, b) => b.last - a.last)] };
  }
  const wr = webRev();
  return {
    version: VERSION,
    now: Date.now(),
    sending: settings.allowSending,
    home, homeSource,
    networks,
    messages: store.since(Number(params.get('rev')) || 0),
    webRev: wr,
    web: params.get('web') === wr ? null : web.snapshot(),
  };
}

// ---- HTTP -----------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

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

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

// Asset links in index.html carry the version, so a browser never mixes an
// old app.js with a new page after an update.
const RELEASED = VERSION !== 'dev';
const ASSET_VERSION = RELEASED ? VERSION : String(Date.parse(STARTED));
const VERSIONED = /((?:src|href)=")(lib\/leaflet\/leaflet\.(?:css|js)|style\.css|app\.js|icon\.png|favicon\.svg)"/g;
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

// Inside Home Assistant only the ingress proxy may connect, so nothing else on
// the network can send messages through your radios.
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

function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { if (!tooBig) reject(new HttpError(413, 'too_large', 'Request too large.')); tooBig = true; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new HttpError(400, 'bad_json', 'Request was not JSON.')); }
    });
    req.on('error', reject);
  });
}

function sendMessage(body) {
  if (!settings.allowSending) throw new HttpError(403, 'sending_off', 'Sending is turned off in the app’s settings.');
  const client = clients[body?.network];
  if (!client || !Object.hasOwn(clients, body.network)) throw new HttpError(400, 'bad_network', 'Unknown network.');
  if (typeof body.chat !== 'string' || body.chat.length > 80) throw new HttpError(400, 'bad_chat', 'Unknown chat.');
  // Control characters other than line breaks have no place in a chat message.
  const text = typeof body.text === 'string' ? body.text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim() : '';
  try {
    return store.add(client.sendText(body.chat, text));
  } catch (e) {
    throw new HttpError(409, 'not_sent', e.message);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!clientAllowed(req)) {
      console.warn(`[http] refused ${req.socket.remoteAddress}: only Home Assistant ingress may connect`);
      return send(res, 403, { error: { code: 'forbidden', message: 'Open Mesh Hub from the Home Assistant sidebar.' } });
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/state') {
      if (req.method !== 'GET') return send(res, 405, { error: { code: 'method', message: 'Use GET' } }, { Allow: 'GET' });
      return send(res, 200, state(url.searchParams));
    }
    if (url.pathname === '/api/send') {
      if (req.method !== 'POST') return send(res, 405, { error: { code: 'method', message: 'Use POST' } }, { Allow: 'POST' });
      if (!postAllowed(req)) return send(res, 403, { error: { code: 'forbidden', message: 'Request refused' } });
      const { rev, ...msg } = sendMessage(await readJson(req));
      return send(res, 200, { message: msg });
    }
    if (url.pathname === '/api/health') {
      const links = Object.fromEntries(Object.entries(clients).map(([k, c]) => [k, c.state]));
      return send(res, 200, { ok: true, version: VERSION, started: STARTED, links });
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: { code: 'not_found', message: 'Not found' } });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: { code: 'method', message: 'Method not allowed' } });
    return serveStatic(url, req, res);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: { code: e.code, message: e.message } });
    console.error('[http]', e);
    send(res, 500, { error: { code: 'server_error', message: 'Something went wrong in the app.' } });
  }
});

server.listen(PORT, () => {
  const which = [settings.meshtasticHost && `Meshtastic ${settings.meshtasticHost}:${settings.meshtasticPort}`, settings.meshcoreHost && `MeshCore ${settings.meshcoreHost}:${settings.meshcorePort}`].filter(Boolean).join(', ') || 'no radios set';
  console.log(`[mesh-hub] ${VERSION} listening on :${PORT}${IN_HOME_ASSISTANT ? ' (ingress only)' : ''}; ${which}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    store.save();
    for (const c of Object.values(clients)) c.stop();
    web.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
