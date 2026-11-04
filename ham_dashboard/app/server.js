'use strict';
// Ham Radio Dashboard - Home Assistant add-on backend.
// Zero dependencies: Node 20+ (global fetch). Serves the UI over ingress and
// fetches/caches public space-weather, propagation and spot data.

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const net = require('net');
const { AprsIs } = require('./aprs');
const HamCore = require('./static/hamcore');
const { HomeAssistant } = require('./ha');
const { Users } = require('./users');
const SATS = require('./sats');
const VHF = require('./vhf');
const { createCache } = require('./cache');
const Prop = require('./prop');
const Prefixes = require('./prefixes');
const Accuracy = require('./accuracy');
const { HamReference: Reference } = require('./static/reference');
const { SourceStatus } = require('./status');

const PORT = +(process.env.PORT || 8099);
const STARTED = new Date().toISOString();
const DATA_DIR = fs.existsSync('/data') ? '/data' : require('os').tmpdir();
const STATIC_DIR = path.join(__dirname, 'static');
const SWPC = 'https://services.swpc.noaa.gov';
const UA = 'SwampFoxLabs-HamRadioDashboard/0.6 (Home Assistant app; github.com/SWFX2324/swamp-fox-labs-ha-apps)';

// ---------------------------------------------------------------- options

// OPTIONS_FILE lets local tests point at a scratch copy instead of /data.
const OPTIONS_FILE = process.env.OPTIONS_FILE || '/data/options.json';
const STATION_TYPES = ['amateur', 'gmrs', 'listener'];

function readOptionsFile() {
  try { return JSON.parse(fs.readFileSync(OPTIONS_FILE, 'utf8')); } catch { return {}; }
}

function loadOptions() {
  const o = readOptionsFile();
  const env = process.env;
  const stationType = String(env.STATION_TYPE ?? o.station_type ?? 'amateur');
  return {
    station_type: STATION_TYPES.includes(stationType) ? stationType : 'amateur',
    callsign: String(env.CALLSIGN ?? o.callsign ?? '').trim().toUpperCase(),
    grid: String(env.GRID ?? o.grid ?? '').trim(),
    distance_units: env.UNITS ?? o.distance_units ?? 'mi',
    dx_cluster_enabled: String(env.DX_CLUSTER ?? o.dx_cluster_enabled ?? true) !== 'false',
    dx_cluster_host: env.DX_HOST ?? o.dx_cluster_host ?? 'w3lpl.net',
    dx_cluster_port: +(env.DX_PORT ?? o.dx_cluster_port ?? 7373),
    qrz_username: String(env.QRZ_USER ?? o.qrz_username ?? '').trim(),
    qrz_password: String(env.QRZ_PASS ?? o.qrz_password ?? ''),
    aprs_enabled: String(env.APRS ?? o.aprs_enabled ?? true) !== 'false',
    aprs_radius: +(env.APRS_RADIUS ?? o.aprs_radius ?? 100),
    ha_sensors: String(env.HA_SENSORS ?? o.ha_sensors ?? true) !== 'false',
    ha_mqtt: String(env.HA_MQTT ?? o.ha_mqtt ?? true) !== 'false',
    spot_watch: (env.SPOT_WATCH !== undefined ? env.SPOT_WATCH.split(',') : o.spot_watch || [])
      .map(s => String(s).trim().toUpperCase()).filter(Boolean),
    pota_alert_radius: +(env.POTA_RADIUS ?? o.pota_alert_radius ?? 100),
    nws_alerts: String(env.NWS_ALERTS ?? o.nws_alerts ?? true) !== 'false',
    lightning_entity: String(env.LIGHTNING_ENTITY ?? o.lightning_entity ?? '').trim(),
    lightning_alert_distance: +(env.LIGHTNING_DISTANCE ?? o.lightning_alert_distance ?? 15),
  };
}
const options = loadOptions();

// ---------------------------------------------------------------- cache / fetch

// Outside data is cached in memory (bounded), with PSKReporter results and
// their rate-limit back-off also kept in /data, so restarting the app doesn't
// refetch them straight away and run into PSKReporter's limit. See cache.js.
const dataCache = createCache({
  persist: /^psk-/,
  persistFile: path.join(DATA_DIR, 'cache.json'),
  onResult: (key, err) => noteSource(key, err),
});
const cached = dataCache.cached;
const restoredEntries = dataCache.load();
setInterval(() => dataCache.sweep(), 10 * 60_000).unref();

// Home Assistant stops the app with SIGTERM: save the cache first.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    dataCache.save();
    process.exit(0);
  });
}

const sourceStatus = new SourceStatus();
const noteSource = (key, err) => sourceStatus.note(key, err);

async function get(url, type = 'json') {
  const where = url.split('?')[0];
  // Errors name the source, so a log line says which one failed.
  const named = e => Object.assign(new Error(`${where}: ${e.message}`), { status: e.status });
  let r, body;
  try {
    r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
    if (r.ok) body = await r.text();
  } catch (e) { throw named(e); }
  if (!r.ok) {
    const err = new Error(`${where} -> HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  if (type !== 'json') return body;
  try { return JSON.parse(body); } catch (e) { throw named(e); }
}

const MIN = 60_000;
const num = s => { const n = parseFloat(s); return Number.isFinite(n) ? n : null; };

// NOAA products are either arrays of objects or [header, ...rows] arrays.
function rows(data) {
  if (Array.isArray(data) && Array.isArray(data[0])) {
    const [h, ...r] = data;
    return r.map(a => Object.fromEntries(h.map((k, i) => [k, a[i]])));
  }
  return Array.isArray(data) ? data : [];
}

// ---------------------------------------------------------------- data sources

function xmlTag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : null;
}

function hamqsl() {
  return cached('hamqsl', 30 * MIN, async () => {
    const xml = await get('https://www.hamqsl.com/solarxml.php', 'text');
    const bands = {};
    for (const m of xml.matchAll(/<band name="([^"]+)" time="(day|night)">([^<]*)<\/band>/g)) {
      (bands[m[1]] ||= { name: m[1] })[m[2]] = m[3].trim();
    }
    const vhf = [...xml.matchAll(/<phenomenon name="([^"]+)" location="([^"]+)">([^<]*)<\/phenomenon>/g)]
      .map(m => ({ name: m[1], location: m[2], status: m[3].trim() }));
    return {
      updated: xmlTag(xml, 'updated'),
      sfi: num(xmlTag(xml, 'solarflux')),
      ssn: num(xmlTag(xml, 'sunspots')),
      a: num(xmlTag(xml, 'aindex')),
      k: num(xmlTag(xml, 'kindex')),
      xray: xmlTag(xml, 'xray'),
      protonflux: num(xmlTag(xml, 'protonflux')),
      electronflux: num(xmlTag(xml, 'electonflux')),
      aurora: num(xmlTag(xml, 'aurora')),
      solarwind: num(xmlTag(xml, 'solarwind')),
      bz: num(xmlTag(xml, 'magneticfield')),
      geomagfield: xmlTag(xml, 'geomagfield'),
      signalnoise: xmlTag(xml, 'signalnoise'),
      bands: Object.values(bands),
      vhf,
    };
  });
}

function noaaScales() {
  return cached('scales', 10 * MIN, async () => {
    const d = await get(`${SWPC}/products/noaa-scales.json`);
    const day = k => d[k] && {
      date: d[k].DateStamp,
      R: { scale: num(d[k].R?.Scale), text: d[k].R?.Text, minorProb: num(d[k].R?.MinorProb), majorProb: num(d[k].R?.MajorProb) },
      S: { scale: num(d[k].S?.Scale), text: d[k].S?.Text, prob: num(d[k].S?.Prob) },
      G: { scale: num(d[k].G?.Scale), text: d[k].G?.Text },
    };
    return { yesterday: day('-1'), current: day('0'), forecast: ['1', '2', '3'].map(day).filter(Boolean) };
  });
}

function kp() {
  return cached('kp', 15 * MIN, async () => {
    const r = rows(await get(`${SWPC}/products/noaa-planetary-k-index-forecast.json`));
    return r.map(x => ({
      time: String(x.time_tag).replace(' ', 'T') + (String(x.time_tag).endsWith('Z') ? '' : 'Z'),
      kp: num(x.kp ?? x.Kp),
      kind: x.observed ?? 'observed',
    })).filter(x => x.kp !== null);
  });
}

function solarWind() {
  return cached('wind', 5 * MIN, async () => {
    const [speed, mag, flux] = await Promise.all([
      get(`${SWPC}/products/summary/solar-wind-speed.json`),
      get(`${SWPC}/products/summary/solar-wind-mag-field.json`),
      get(`${SWPC}/products/summary/10cm-flux.json`),
    ]);
    const s = rows(speed)[0] || {}, m = rows(mag)[0] || {}, f = rows(flux)[0] || {};
    return { speed: num(s.proton_speed), bt: num(m.bt), bz: num(m.bz_gsm), time: s.time_tag, f107: num(f.flux) };
  });
}

function xrayClass(flux) {
  if (!(flux > 0)) return null;
  const classes = [['X', 1e-4], ['M', 1e-5], ['C', 1e-6], ['B', 1e-7], ['A', 1e-8]];
  for (const [c, base] of classes) if (flux >= base) return c + (flux / base).toFixed(1);
  return 'A0.0';
}

function xray() {
  return cached('xray', 5 * MIN, async () => {
    const d = rows(await get(`${SWPC}/json/goes/primary/xrays-6-hour.json`))
      .filter(x => x.energy === '0.1-0.8nm' && x.flux > 0);
    if (!d.length) return null;
    const last = d[d.length - 1];
    const max = d.reduce((a, b) => (b.flux > a.flux ? b : a));
    return { current: xrayClass(last.flux), flux: last.flux, time: last.time_tag, max6h: xrayClass(max.flux), max6hTime: max.time_tag };
  });
}

function alerts() {
  return cached('alerts', 10 * MIN, async () => {
    const cutoff = Date.now() - 72 * 3600_000;
    return rows(await get(`${SWPC}/products/alerts.json`))
      .map(a => {
        const msg = String(a.message || '').replace(/\r/g, '');
        const title = (msg.match(/^(?:ALERT|WARNING|WATCH|SUMMARY|CONTINUED ALERT|EXTENDED WARNING|CANCEL[^:]*):.*$/m) || [])[0]
          || msg.split('\n').find(l => l.trim() && !/^(Space Weather Message Code|Serial Number|Issue Time)/.test(l)) || a.product_id;
        return { id: a.product_id, time: String(a.issue_datetime).replace(' ', 'T') + 'Z', title: title.trim(), message: msg };
      })
      .filter(a => Date.parse(a.time) > cutoff)
      // ISO times sort as plain strings; no locale-aware (ICU) compare needed.
      .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0))
      .slice(0, 20);
  });
}

function forecast3day() {
  return cached('3day', 60 * MIN, () => get(`${SWPC}/text/3-day-forecast.txt`, 'text'));
}

function solarCycle() {
  return cached('cycle', 12 * 60 * MIN, async () => {
    const [obs, pred] = await Promise.all([
      get(`${SWPC}/json/solar-cycle/observed-solar-cycle-indices.json`),
      get(`${SWPC}/json/solar-cycle/predicted-solar-cycle.json`),
    ]);
    const pos = v => (v >= 0 ? v : null);
    return {
      observed: obs.filter(x => x['time-tag'] >= '2008-01')
        .map(x => ({ t: x['time-tag'], ssn: pos(x.ssn), smoothed: pos(x.smoothed_ssn) })),
      predicted: pred.map(x => ({ t: x['time-tag'], ssn: pos(x.predicted_ssn), high: pos(x.high_ssn), low: pos(x.low_ssn) })),
    };
  });
}

// Every KC2G station with its latest reading, however old. Many have been
// silent for years.
function ionosondeStations() {
  return cached('iono', 10 * MIN, async () =>
    (await get('https://prop.kc2g.com/api/stations.json'))
      .map(s => {
        let lon = num(s.station?.longitude);
        if (lon > 180) lon -= 360;
        return {
          code: s.station?.code, name: s.station?.name,
          lat: num(s.station?.latitude), lon,
          time: s.time + 'Z', cs: s.cs, mufd: num(s.mufd), fof2: num(s.fof2), md: num(s.md),
        };
      })
      .filter(s => s.mufd && s.lat !== null && s.cs > 0));
}

// The stations that reported in the last 3 hours.
async function ionosondes() {
  const cutoff = Date.now() - 3 * 3600_000;
  return (await ionosondeStations()).filter(s => Date.parse(s.time) > cutoff);
}

// The estimate behind "At your QTH" and the band sensors: the nearest ionosonde
// within 3000 km that reported in the last 3 hours, or else the model, anchored
// to the ionosondes that are reporting. The model answer names the nearest
// station heard from in the last week, so it's clear why there's no reading.
async function localEstimate(pos) {
  const [all, inputs] = await Promise.all([settle(ionosondeStations()), pathInputs()]);
  const station = HamCore.nearestIonosonde(pos, inputs.stations);
  if (station) {
    return {
      source: 'ionosonde', muf: +station.mufd.toFixed(1), fof2: station.fof2, kp: inputs.kp,
      station: { name: station.name, km: Math.round(station.dist), time: station.time },
    };
  }
  const week = Date.now() - 7 * 24 * 3600_000;
  const recent = HamCore.nearestIonosonde(pos, (all || []).filter(s => Date.parse(s.time) > week));
  return {
    source: 'model', ...Prop.localMuf(pos, inputs), kp: inputs.kp,
    nearest: recent ? { name: recent.name, km: Math.round(recent.dist), time: recent.time } : null,
  };
}

function propMap(kind) {
  return cached(`map-${kind}`, 10 * MIN, () => get(`https://prop.kc2g.com/renders/current/${kind}-normal-now.svg`, 'text'));
}

function pskReports(call, minutes) {
  return cached(`psk-${call}-${minutes}`, 5 * MIN, async () => {
    const url = `https://retrieve.pskreporter.info/query?senderCallsign=${encodeURIComponent(call)}&flowStartSeconds=-${minutes * 60}&rronly=1`;
    const xml = await get(url, 'text');
    const reports = [];
    for (const m of xml.matchAll(/<receptionReport\s([^>]*?)\/>/g)) {
      const a = {};
      for (const x of m[1].matchAll(/(\w+)="([^"]*)"/g)) a[x[1]] = x[2];
      reports.push({
        rx: a.receiverCallsign, rxGrid: a.receiverLocator, rxCountry: a.receiverDXCC,
        txGrid: a.senderLocator, freq: num(a.frequency), mode: a.mode,
        snr: num(a.sNR), time: num(a.flowStartSeconds),
      });
    }
    return { call, minutes, reports: reports.sort((a, b) => b.time - a.time) };
  });
}

// ---------------------------------------------------------------- DX cluster

const BANDS = [
  ['160m', 1800, 2000], ['80m', 3500, 4000], ['60m', 5330, 5410], ['40m', 7000, 7300],
  ['30m', 10100, 10150], ['20m', 14000, 14350], ['17m', 18068, 18168], ['15m', 21000, 21450],
  ['12m', 24890, 24990], ['10m', 28000, 29700], ['6m', 50000, 54000], ['2m', 144000, 148000],
];
const bandOf = khz => (BANDS.find(([, lo, hi]) => khz >= lo && khz <= hi) || [null])[0];

// Upper edge of the CW segment per band (kHz); above it we assume phone/digital.
const CW_TOP = { '160m': 1840, '80m': 3570, '40m': 7040, '30m': 10150, '20m': 14070, '17m': 18095, '15m': 21070, '12m': 24915, '10m': 28070, '6m': 50100, '2m': 144100 };
const FT8 = [1840, 3573, 5357, 7074, 10136, 14074, 18100, 21074, 24915, 28074, 50313, 50323, 144174];
const FT4 = [3575, 7047.5, 10140, 14080, 18104, 21140, 24919, 28180, 50318];

function guessMode(khz, comment, band) {
  const c = comment.toUpperCase();
  const m = c.match(/\b(FT8|FT4|RTTY|PSK31|PSK63|JT65|JS8|SSTV|CW|SSB|USB|LSB|AM|FM|MSK144|Q65)\b/);
  if (m) return ['USB', 'LSB'].includes(m[1]) ? 'SSB' : m[1];
  if (FT8.some(f => khz >= f && khz <= f + 3)) return 'FT8';
  if (FT4.some(f => khz >= f && khz <= f + 3)) return 'FT4';
  if (band === '60m') return 'SSB';
  return khz <= (CW_TOP[band] ?? 0) ? 'CW' : 'SSB';
}

// Minimal prefix -> continent table (longest prefix wins). Good enough to filter
// spots by where the spotter is; not a substitute for a full cty.dat.
const CONT_PREFIXES = {
  NA: 'K W N AA AB AC AD AE AF AG AI AJ AK AL KL7 KP2 KP4 VE VA VO VY CY XE XF TI HP YN HR TG YS HI CO CM 6Y J3 J6 J7 J8 V2 V3 V4 VP2 VP5 VP9 ZF 8P FG FM FS PJ C6 HH OX',
  SA: 'PP PQ PR PS PT PU PV PW PX PY ZV ZW ZX ZY ZZ LU LO LP LQ LR LS LT LV LW CE CA CB CC CD XQ XR CX ZP OA OB OC HC HK HJ 5J 5K YV YW YX YY 9Y PZ FY 8R CP VP8',
  EU: 'G M 2E 2M F TM DL DA DB DC DD DE DF DG DH DI DJ DK DM DN DO DP DQ DR I EA EB EC ED EE EF EG EH PA PB PC PD PE PF PG PH PI ON OO OP OQ OR OS OT OE HB OK OL OM SP SQ SN SO SR 3Z HA HG YO YP YQ YR LZ SV SX SY SZ 9A S5 E7 YU YT Z3 OH OG OF OI SM SA SB SC SD SE SF SG SH SI SJ SK SL 7S 8S LA LB LC LD LE LF LG LH LI LJ LN OZ OU OV 5P 5Q TF EI EJ GI MI GM MM GW MW GD MD GJ MJ GU MU ES YL LY UR US UT UU UV UW UX UY UZ EM EN EO EU EV EW ER CT CS CU 4O Z6 T7 1A HV 3A LX OY IS R U',
  AS: 'JA JE JF JG JH JI JJ JK JL JM JN JO JP JQ JR JS 7J 7K 7L 7M 7N 8J BV BU BW BX BY BA BD BG BH BI BJ BL BM BN BO BP BQ BR BS BT HL DS DT 6K 6L 6M 6N VU AT HS E2 9M 9V YB YC YD YE YF YG YH DU DV DW DX DY DZ 4X 4Z A4 A6 A7 A9 HZ 7Z EP AP 4S S2 XV 3W XU XW 9N UN UP UQ EX EY EZ UK 4L EK 4J TA YM JT VR2 9K YI OD JY',
  OC: 'VK AX ZL KH6 KH7 KH2 KH0 KH8 YJ FK 3D2 5W A3 P2 T2 T3 V7 V6 FO E5',
  AF: 'ZS ZR ZT ZU 5H 5Z 5N CN 7X SU ET 9J Z2 V5 A2 9G TU 6W D2 3V 5R 3B8 FR EA8 EA9 CT3 ST TT TJ TR TN 9Q 9X 5X C9 7Q 5T 5U 5V TZ XT 9L EL D4 J5 3C 3X S7 S9 TL 7P 3DA 6O T5 E3 J2 5A',
};
const PREFIX_MAP = new Map();
for (const [cont, list] of Object.entries(CONT_PREFIXES)) for (const p of list.split(' ')) PREFIX_MAP.set(p, cont);

function baseCall(call) {
  const parts = call.toUpperCase().replace(/-.*$/, '').split('/')
    .filter(p => p && !/^(P|M|MM|AM|QRP|A|\d+)$/.test(p));
  if (!parts.length) return call.toUpperCase();
  return parts.reduce((a, b) => (b.length < a.length ? b : a));
}

function continentOf(call) {
  const c = baseCall(call);
  if (/^(R|U[A-I])[A-Z]?[089]/.test(c)) return 'AS'; // Asiatic Russia
  for (let n = Math.min(4, c.length); n > 0; n--) {
    const cont = PREFIX_MAP.get(c.slice(0, n));
    if (cont) return cont;
  }
  return null;
}

// Public cluster nodes, tried in turn while one of them is configured: a node
// that stops answering is replaced by the next. A cluster the user picked
// themselves is never swapped for another.
const CLUSTER_NODES = [['w3lpl.net', 7373], ['dxc.ve7cc.net', 23], ['dxc.nc7j.com', 7373]];
const LOGIN_TIMEOUT_MS = 2 * MIN;

class Cluster {
  constructor() {
    this.spots = [];
    this.status = 'disabled';
    this.error = null;
    this.retryMs = 5000;
    this.host = null;
  }

  start(opts) {
    if (!opts.dx_cluster_enabled) { this.status = 'disabled'; return; }
    // Cluster nodes are ham-run and expect an amateur callsign at login.
    if (opts.station_type !== 'amateur') { this.status = 'no-license'; return; }
    if (!opts.callsign) { this.status = 'no-callsign'; return; }
    this.opts = opts;
    const host = String(opts.dx_cluster_host).toLowerCase();
    const at = CLUSTER_NODES.findIndex(([h, p]) => h === host && p === opts.dx_cluster_port);
    // The configured node first, then the others in order of preference.
    this.nodes = at < 0 ? [[opts.dx_cluster_host, opts.dx_cluster_port]] : [CLUSTER_NODES[at], ...CLUSTER_NODES.filter((_, i) => i !== at)];
    this.node = 0;
    this.connect();
  }

  connect() {
    const [host, port] = this.nodes[this.node];
    const { callsign } = this.opts;
    this.host = `${host}:${port}`;
    this.status = 'connecting';
    this.error = null;
    let buf = '';
    let prompts = 0;
    let answered = false; // the cluster replied to the login
    const sock = net.connect(port, host);
    sock.setEncoding('latin1');
    sock.setKeepAlive(true, 60_000);
    // Some nodes accept the connection but never get past the login.
    const loginTimer = setTimeout(() => sock.destroy(new Error('no answer to the login')), LOGIN_TIMEOUT_MS);
    sock.setTimeout(10 * MIN, () => sock.destroy(new Error('no data for 10 minutes')));
    // Not an echo of what we typed, and not a refusal.
    const greets = text => text.toUpperCase().includes(callsign.toUpperCase()) && text.trim().toUpperCase() !== callsign.toUpperCase() && !/not a valid|invalid/i.test(text);
    const loggedIn = () => {
      if (answered) return;
      answered = true;
      clearTimeout(loginTimer);
      this.status = 'connected';
      this.retryMs = 5000;
      console.log(`[cluster] logged in to ${host}:${port} as ${callsign}`);
    };
    sock.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const text = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        // The node greets the callsign (or sends a spot) once the login worked.
        if (prompts && !answered && (greets(text) || /^DX de /i.test(text))) loggedIn();
        this.line(text);
      }
      // Answer every login prompt: a node may ask again if it missed the first.
      if (!answered && /(login|call)[^\n]*:\s*$/i.test(buf)) {
        buf = '';
        if (++prompts > 3) return sock.destroy(new Error('login refused'));
        sock.write(callsign + '\r\n');
      }
      if (buf.length > 8192) buf = buf.slice(-1024);
    });
    sock.on('error', err => { this.error = err.message; });
    sock.on('close', () => {
      clearTimeout(loginTimer);
      this.status = 'reconnecting';
      // A node that never let us in, or went quiet, gives way to the next one.
      const next = this.nodes.length > 1 && (!answered || /no data/.test(this.error || ''));
      if (next) this.node = (this.node + 1) % this.nodes.length;
      const [nh, np] = this.nodes[this.node];
      console.warn(`[cluster] disconnected from ${host}:${port} (${this.error || 'closed'}), retry ${next ? `with ${nh}:${np} ` : ''}in ${this.retryMs / 1000}s`);
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 5 * MIN);
    });
  }

  line(text) {
    const m = text.match(/^DX de ([A-Z0-9/#-]+):?\s+(\d+(?:\.\d+)?)\s+([A-Z0-9/]+)\s+(.*?)\s*(\d{4})Z/i);
    if (!m) return;
    const [, spotter, f, dx, comment, hhmm] = m;
    const khz = parseFloat(f);
    const band = bandOf(khz);
    const now = new Date();
    const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), +hhmm.slice(0, 2), +hhmm.slice(2)));
    if (t - now > 5 * MIN) t.setUTCDate(t.getUTCDate() - 1);
    const spotterCall = spotter.replace(/-#$/, '').replace(/-\d+$/, '');

    // Collapse repeat spots of the same station on the same frequency.
    const dup = this.spots.find(s => s.dx === dx && Math.abs(s.freq - khz) < 1 && t - Date.parse(s.time) < 30 * MIN);
    if (dup) {
      dup.count++;
      dup.time = t.toISOString();
      if (!dup.spotterConts.includes(continentOf(spotterCall))) dup.spotterConts.push(continentOf(spotterCall));
      if (comment && !dup.comment) dup.comment = comment;
      return;
    }
    const spot = {
      time: t.toISOString(), freq: khz, band, dx, spotter: spotterCall,
      comment, mode: guessMode(khz, comment, band), skimmer: spotter.endsWith('-#'),
      dxCont: continentOf(dx), spotterConts: [continentOf(spotterCall)], count: 1,
    };
    this.spots.unshift(spot);
    if (this.spots.length > 400) this.spots.length = 400;
    this.onSpot?.(spot);
  }
}

const cluster = new Cluster();
const aprs = new AprsIs({ userAgent: 'SwampFoxLabsHamDash 0.6' });
const ha = new HomeAssistant();

// A spot matches the watch list if the DX call equals an entry or starts with
// it (so "VP8" catches every VP8 station).
const watchMatch = call => options.spot_watch.find(w => call === w || call.startsWith(w)) || null;
const recentAlerts = new Map();

// Fire an alert at most once per key every 30 minutes.
function alertOnce(key) {
  const last = recentAlerts.get(key);
  if (last && Date.now() - last < 30 * MIN) return false;
  recentAlerts.set(key, Date.now());
  if (recentAlerts.size > 2000) for (const [k, t] of recentAlerts) if (Date.now() - t > 2 * 60 * MIN) recentAlerts.delete(k);
  return true;
}

cluster.onSpot = spot => {
  const match = watchMatch(spot.dx);
  if (!match || !alertOnce(`dx|${spot.dx}|${spot.band}`)) return;
  ha.fireEvent('ham_dashboard_dx_spot', {
    dx: spot.dx, frequency_khz: spot.freq, band: spot.band, mode: spot.mode,
    spotter: spot.spotter, comment: spot.comment, time: spot.time, watch: match,
  });
};

// ---------------------------------------------------------------- POTA

function potaSpots() {
  return cached('pota', MIN, async () => (await get('https://api.pota.app/spot/activator'))
    .filter(s => !s.invalid && s.activator && s.reference)
    .map(s => ({
      id: s.spotId,
      activator: String(s.activator).toUpperCase(),
      freq: num(s.frequency), band: bandOf(num(s.frequency)), mode: String(s.mode || '').toUpperCase(),
      reference: s.reference,
      park: String(s.name || s.parkName || '').replace(/\s+/g, ' ').trim(),
      location: s.locationDesc || '',
      grid: s.grid6 || s.grid4 || '',
      lat: num(s.latitude), lon: num(s.longitude),
      time: /Z$/.test(s.spotTime) ? s.spotTime : `${s.spotTime}Z`,
      spotter: s.spotter || '', comments: String(s.comments || '').trim(), source: s.source || '', count: s.count || 1,
    })));
}

const potaRadiusKm = () => options.pota_alert_radius * (options.distance_units === 'mi' ? 1.609344 : 1);
let potaSeeded = false;

// Fire an event for each new POTA activation within the alert radius. The
// first poll only records what's already on the air, so a restart doesn't
// flood Home Assistant with alerts.
async function checkPotaAlerts() {
  const pos = gridToLatLon(options.grid);
  if (!ha.enabled || !pos || options.pota_alert_radius <= 0) return;
  let spots;
  try { spots = await potaSpots(); } catch (e) { console.warn('[pota]', e.message); return; }
  for (const s of spots) {
    if (s.lat === null || s.lon === null) continue;
    const dist = distanceKm(pos, s);
    if (dist > potaRadiusKm()) continue;
    const fresh = alertOnce(`pota|${s.activator}|${s.reference}|${s.band}`);
    if (!fresh || !potaSeeded) continue;
    ha.fireEvent('ham_dashboard_pota_spot', {
      activator: s.activator, reference: s.reference, park: s.park, location: s.location,
      frequency_khz: s.freq, band: s.band, mode: s.mode, comments: s.comments,
      distance_km: Math.round(dist), bearing: HamCore.compass(bearingDeg(pos, s)), time: s.time,
    });
  }
  potaSeeded = true;
}

// ---------------------------------------------------------------- satellites

function satelliteTles() {
  // CelesTrak asks clients not to re-download unchanged data; elements only
  // update a few times a day.
  return cached('tles', 12 * 60 * MIN, async () => {
    const tles = SATS.parseTles(await get('https://celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=tle', 'text'));
    if (!tles.size) throw new Error('CelesTrak returned no elements');
    return tles;
  });
}

function satellitePasses(pos) {
  return cached(`sats-${pos.lat.toFixed(2)},${pos.lon.toFixed(2)}`, 10 * MIN, async () =>
    ({ computed: new Date().toISOString(), sats: SATS.predict(await satelliteTles(), pos, 24) }));
}

// ---------------------------------------------------------------- band activity (PSKReporter)

// Measured propagation: what PSKReporter monitors near the QTH actually heard
// in the last 15 minutes, per band. One area query per Maidenhead field every
// 5 minutes, which is PSKReporter's requested maximum rate.
const ACTIVITY_WINDOW_MIN = 15;
const ACTIVITY_RADIUS_KM = 800;
const DX_KM = 2500;

function pskArea(field) {
  return cached(`psk-area-${field}`, 5 * MIN, async () => {
    const xml = await get(`https://retrieve.pskreporter.info/query?receiverCallsign=${field}&modify=grid&flowStartSeconds=-${ACTIVITY_WINDOW_MIN * 60}&rronly=1`, 'text');
    const reports = [];
    for (const m of xml.matchAll(/<receptionReport\s([^>]*?)\/>/g)) {
      const a = {};
      for (const x of m[1].matchAll(/(\w+)="([^"]*)"/g)) a[x[1]] = x[2];
      reports.push({ rx: a.receiverCallsign, rxGrid: a.receiverLocator, tx: a.senderCallsign, txGrid: a.senderLocator, txCountry: a.senderDXCC, freq: num(a.frequency), mode: a.mode, snr: num(a.sNR), time: num(a.flowStartSeconds) });
    }
    return { fetched: Date.now(), reports };
  });
}

async function bandActivity(pos) {
  const field = HamCore.latLonToGrid(pos.lat, pos.lon).slice(0, 2);
  const { fetched, reports } = await pskArea(field);
  const acc = Object.fromEntries(HamCore.HF_BANDS.map(([b]) => [b, { stations: new Set(), receivers: new Set(), dx: new Set(), reports: 0, farthest: null, modes: {} }]));
  for (const r of reports) {
    const b = acc[bandOf(r.freq / 1000)];
    const rx = gridToLatLon(r.rxGrid);
    if (!b || !rx || distanceKm(pos, rx) > ACTIVITY_RADIUS_KM) continue;
    b.reports++;
    b.stations.add(r.tx);
    b.receivers.add(r.rx);
    b.modes[r.mode] = (b.modes[r.mode] || 0) + 1;
    const tx = gridToLatLon(r.txGrid);
    if (!tx) continue;
    const km = distanceKm(pos, tx);
    if (km >= DX_KM) b.dx.add(r.tx);
    if (!b.farthest || km > b.farthest.km) b.farthest = { call: r.tx, km: Math.round(km), grid: r.txGrid, country: r.txCountry || '' };
  }
  const bands = {};
  for (const [k, b] of Object.entries(acc)) {
    bands[k] = { stations: b.stations.size, receivers: b.receivers.size, dx: b.dx.size, reports: b.reports, farthest: b.farthest, modes: b.modes };
  }
  return { field, windowMin: ACTIVITY_WINDOW_MIN, radiusKm: ACTIVITY_RADIUS_KM, dxKm: DX_KM, fetched: new Date(fetched).toISOString(), bands };
}

// ---------------------------------------------------------------- VHF openings (same PSKReporter query)

const vhfTracker = new VHF.OpeningTracker((band, b) => {
  if (!ha.enabled) return;
  ha.fireEvent('ham_dashboard_vhf_opening', {
    band, stations: b.stations, receivers: b.receivers, toward: b.toward, likely: b.likely,
    farthest_call: b.farthest?.call ?? null, farthest_grid: b.farthest?.grid ?? null, farthest_km: b.farthest?.km ?? null,
    regions: b.regions.map(r => r.field), time: new Date().toISOString(),
  });
});

// Openings are tracked over time only for the configured QTH; another grid
// (a browser override) just gets the current snapshot.
async function vhfOpenings(pos) {
  const field = HamCore.latLonToGrid(pos.lat, pos.lon).slice(0, 2);
  const { fetched, reports } = await pskArea(field);
  const result = { field, windowMin: ACTIVITY_WINDOW_MIN, fetched: new Date(fetched).toISOString(), ...VHF.analyze(reports, pos) };
  const qth = gridToLatLon(options.grid);
  return qth && distanceKm(qth, pos) < 10 ? vhfTracker.update(fetched, result) : result;
}

// ---------------------------------------------------------------- point-to-point paths

// Conditions shared by every path: sunspot number (from the solar flux), Kp and
// the live ionosondes that anchor the model.
async function pathInputs() {
  const [hq, kpData, iono] = await Promise.all([hamqsl(), kp(), ionosondes()].map(settle));
  const now = Date.now();
  const past = (kpData || []).filter(k => k.kind !== 'predicted' && Date.parse(k.time) <= now);
  const kpNow = past.length ? past[past.length - 1].kp : hq?.k ?? null;
  return {
    ssn: Prop.ssnFromSfi(hq?.sfi) ?? hq?.ssn ?? 100, sfi: hq?.sfi ?? null,
    kp: kpNow ?? 2, stations: iono || [],
  };
}

const GRID_RE = /^[A-R]{2}\d{2}([A-X]{2})?$/i;

// A target from a map click (tlat/tlon), a grid square, a callsign (QRZ/FCC
// location when there is one) or a prefix. Returns null if it can't be placed.
async function resolveTarget(q) {
  const tlat = num(q.get('tlat')), tlon = num(q.get('tlon'));
  if (tlat !== null && tlon !== null && Math.abs(tlat) <= 90 && Math.abs(tlon) <= 180) {
    const grid = HamCore.latLonToGrid(tlat, tlon);
    // A point may carry a name (a beacon's call) and place for display.
    const label = String(q.get('tlabel') || '').toUpperCase().replace(/[^A-Z0-9/]/g, '').slice(0, 15);
    const place = String(q.get('tplace') || '').replace(/[^\p{L}\p{N} ,.'()-]/gu, '').slice(0, 60);
    return { kind: 'point', label: label || grid, lat: tlat, lon: tlon, grid, ...(place && { place }) };
  }
  const t = String(q.get('target') || '').trim().toUpperCase();
  if (GRID_RE.test(t)) {
    const grid = t.slice(0, 4) + t.slice(4).toLowerCase();
    return { kind: 'grid', label: grid, ...gridToLatLon(t), grid };
  }
  if (!/^[A-Z0-9/]{1,15}$/.test(t)) {
    const err = new Error('Enter a callsign, grid square or prefix');
    err.status = 400;
    throw err;
  }
  if (/^[A-Z0-9/]{3,15}$/.test(t) && /\d[A-Z]+$/.test(t)) {
    const r = await lookupCall(t).catch(() => null);
    if (r && !r.notFound && Number.isFinite(r.lat) && Number.isFinite(r.lon)) {
      return { kind: 'call', label: t, lat: r.lat, lon: r.lon, grid: r.grid || HamCore.latLonToGrid(r.lat, r.lon), name: r.name || '', place: [r.city, r.state, r.country].filter(Boolean).join(', '), source: (r.sources || []).join(', ') };
    }
  }
  const p = Prefixes.locate(t);
  if (!p) return null;
  return { kind: 'prefix', label: t, lat: p.lat, lon: p.lon, grid: HamCore.latLonToGrid(p.lat, p.lon).slice(0, 4), place: p.area ? `${p.area}, ${p.name}` : p.name, approximate: true };
}

// PSKReporter evidence for a path. The home field's query is shared with band
// activity. The target's field needs its own query, so those are limited to one
// new field every 5 minutes, as PSKReporter asks; until then only the "heard
// near you" direction is available.
const TARGET_QUERY_GAP = 5 * MIN;
let lastTargetQuery = 0;


async function pathEvidence(from, to, { extraQuery = true, approximate = false } = {}) {
  const homeField = HamCore.latLonToGrid(from.lat, from.lon).slice(0, 2);
  const farField = HamCore.latLonToGrid(to.lat, to.lon).slice(0, 2);
  const home = await pskArea(homeField).catch(() => null);
  let far = farField === homeField ? home : dataCache.fresh(`psk-area-${farField}`, 5 * MIN);
  let waitUntil = null;
  if (!far && extraQuery) {
    if (Date.now() - lastTargetQuery >= TARGET_QUERY_GAP) {
      lastTargetQuery = Date.now();
      far = await pskArea(farField).catch(() => null);
    } else waitUntil = new Date(lastTargetQuery + TARGET_QUERY_GAP).toISOString();
  }
  const reports = [...(home?.reports || []), ...(far && far !== home ? far.reports : [])];
  return {
    windowMin: ACTIVITY_WINDOW_MIN,
    directions: { toYou: !!home, fromYou: !!far },
    waitUntil,
    bands: Prop.measured(reports, from, to, { nearKm: 800, farNearKm: approximate ? 1500 : 800 }),
  };
}

// The full analysis for one path, trimmed for the browser: per-hour detail
// keeps only the ratings and MUF.
function pathReport(from, to, inputs) {
  const a = Prop.analyzePath(from, to, { ...inputs, now: Date.now() });
  const side = s => ({
    ...s, summary: Prop.summarize(s),
    hours: s.hours.map(h => ({ t: h.t, muf: h.muf, bands: Object.fromEntries(Object.entries(h.bands).map(([b, x]) => [b, x.rating])) })),
  });
  return { short: side(a.short), long: side(a.long), medianRatio: a.medianRatio, anchorStations: a.stations };
}

// ---------------------------------------------------------------- NCDXF/IARU beacons

// Short-path ratings right now from the QTH to each beacon on its five bands.
// The schedule itself is computed in the browser from the clock.
function beaconRatings(pos) {
  return cached(`beacons-${pos.lat.toFixed(2)},${pos.lon.toFixed(2)}`, 5 * MIN, async () => {
    const inputs = await pathInputs();
    const now = Date.now();
    const cal = Prop.calibration(inputs.stations, now, inputs.ssn);
    const bands = Reference.BEACON_BANDS;
    return {
      computed: new Date(now).toISOString(),
      beacons: Reference.BEACONS.map(b => {
        const geo = Prop.pathGeometry(pos, b);
        const r = Prop.evaluate(geo, now, { bands, ssn: inputs.ssn, kp: inputs.kp, cal });
        return {
          call: b.call, km: Math.round(geo.km), bearing: Math.round(geo.bearing), muf: r.muf,
          bands: Object.fromEntries(bands.map(([band]) => [band, r.bands[band].rating])),
        };
      }),
    };
  });
}

// ---------------------------------------------------------------- WWV / WWVH time signals

// Path ratings from the QTH to WWV and WWVH on each of their frequencies, now
// and for each of the next 24 hours, from the same model as path analysis.
function timeSignals(pos) {
  return cached(`timesignals-${pos.lat.toFixed(2)},${pos.lon.toFixed(2)}`, 10 * MIN, async () => {
    const inputs = await pathInputs();
    const now = Date.now();
    return {
      computed: new Date(now).toISOString(),
      stations: Reference.TIME_STATIONS.map(st => {
        const bands = st.freqs.map(([mhz]) => [String(mhz), mhz]);
        const p = Prop.analyzePath(pos, st, { ...inputs, now, bands }).short;
        return {
          call: st.call, km: Math.round(p.km), bearing: Math.round(p.bearing), hops: p.hops,
          freqs: st.freqs.map(([mhz, kw]) => {
            const key = String(mhz);
            const x = p.now.bands[key];
            return { mhz, kw, now: x.rating, limit: x.limit, hours: p.hours.map(h => h.bands[key].rating) };
          }),
          hourStart: p.hours[0]?.t ?? null,
        };
      }),
    };
  });
}

// ---------------------------------------------------------------- model accuracy log

// Every 15 minutes, compare the model with the long-distance paths PSKReporter
// shows near the QTH (see accuracy.js). Only uses data the app already fetched,
// so it adds no PSKReporter traffic, and logs each fetch once.
const accuracyLog = new Accuracy.AccuracyLog(path.join(DATA_DIR, 'accuracy.jsonl'));
let lastAccuracyFetch = 0;

async function runAccuracyCheck() {
  const pos = gridToLatLon(options.grid);
  if (!pos) return;
  const area = dataCache.fresh(`psk-area-${HamCore.latLonToGrid(pos.lat, pos.lon).slice(0, 2)}`, 10 * MIN);
  if (!area || area.fetched === lastAccuracyFetch) return;
  lastAccuracyFetch = area.fetched;
  try {
    const record = Accuracy.check(area.reports, pos, await pathInputs(), Reference.BEACONS);
    if (Object.keys(record.bands).length) accuracyLog.append(record);
  } catch (e) { console.warn('[accuracy]', e.message); }
}

// ---------------------------------------------------------------- saved paths

const pathsFile = () => path.join(DATA_DIR, 'paths.json');
const MAX_SAVED_PATHS = 10;

function readPaths() {
  try {
    const list = JSON.parse(fs.readFileSync(pathsFile(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

async function handlePaths(req, res, url) {
  let list = readPaths();
  if (req.method === 'DELETE') {
    list = list.filter(p => p.id !== url.searchParams.get('id'));
  } else {
    let input;
    try { input = JSON.parse(await readBody(req) || '{}'); } catch { return send(res, 400, { error: 'Invalid request' }); }
    const label = String(input.label || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    const t = input.target || {};
    if (!label) return send(res, 400, { error: 'Give the path a name.' });
    if (!Number.isFinite(t.lat) || !Number.isFinite(t.lon) || Math.abs(t.lat) > 90 || Math.abs(t.lon) > 180) return send(res, 400, { error: 'The path has no location.' });
    if (list.length >= MAX_SAVED_PATHS) return send(res, 400, { error: `You can save up to ${MAX_SAVED_PATHS} paths. Remove one first.` });
    // The ID becomes the sensor name, so it never changes once saved.
    let id = slug(label) || 'path';
    for (let n = 2; list.some(p => p.id === id); n++) id = `${slug(label) || 'path'}_${n}`;
    list.push({
      id, label, lat: +t.lat.toFixed(4), lon: +t.lon.toFixed(4),
      grid: String(t.grid || HamCore.latLonToGrid(t.lat, t.lon)).slice(0, 6), target: String(t.label || '').slice(0, 15),
      place: String(t.place || '').slice(0, 80), approximate: !!t.approximate, added: new Date().toISOString(),
    });
  }
  try { fs.writeFileSync(pathsFile(), JSON.stringify(list, null, 1)); } catch (e) { return send(res, 500, { error: `Couldn't save: ${e.message}` }); }
  if (ha.enabled) setTimeout(publishHa, 1000);
  return send(res, 200, { paths: list });
}

// One event per band per saved path when it turns good, at most every 2 hours.
const pathEventContext = new Map();
const pathTracker = new Prop.PathTracker((id, band) => {
  const c = pathEventContext.get(id);
  if (!c || !ha.enabled) return;
  ha.fireEvent('ham_dashboard_path_open', {
    path: id, label: c.sp.label, band, muf_mhz: c.s.now.muf, target_grid: c.sp.grid,
    heard: c.ev.bands[band]?.toYou ?? 0, distance_km: c.s.km, bearing: c.s.bearing,
  });
});

async function pathEntities(pos) {
  const saved = readPaths();
  if (!saved.length) return [];
  const inputs = await pathInputs();
  const out = [];
  for (const sp of saved) {
    const r = pathReport(pos, sp, inputs);
    // Sensors use only the shared home query, never extra PSKReporter traffic.
    const ev = await pathEvidence(pos, sp, { extraQuery: false, approximate: sp.approximate });
    const s = r.short;
    const bands = Object.fromEntries(Object.entries(s.now.bands).map(([b, x]) => [b, x.rating]));
    pathEventContext.set(sp.id, { sp, s, ev });
    pathTracker.update(sp.id, bands);
    const nextGood = Object.fromEntries(Object.entries(s.summary.windows).map(([b, w]) => [b, w[0]?.start ?? null]));
    out.push([`sensor.ham_path_${sp.id}`, s.summary.best ? s.summary.best.band : 'None', {
      friendly_name: `${sp.label} best band`, icon: 'mdi:map-marker-path',
      best_rating: s.summary.best?.rating ?? null, target: sp.target || sp.grid, grid: sp.grid,
      distance_km: s.km, bearing: s.bearing, muf_mhz: s.now.muf,
      bands, next_good: nextGood,
      long_path_best: r.long.summary.best?.band ?? null,
      heard_nearby: Object.fromEntries(Object.entries(ev.bands).map(([b, x]) => [b, x.toYou])),
    }]);
  }
  return out;
}

// ---------------------------------------------------------------- storm safety (NWS + local lightning sensor)

// NWS events that mean "lightning is here or imminent" vs "be ready".
const STORM_DANGER = /^(Severe Thunderstorm Warning|Tornado Warning|Tornado Emergency|Extreme Wind Warning)$/i;
const STORM_CAUTION = /^(Severe Thunderstorm Watch|Tornado Watch|Severe Weather Statement)$/i;

function nwsAlerts(pos) {
  return cached(`nws-alerts-${pos.lat.toFixed(3)},${pos.lon.toFixed(3)}`, 2 * MIN, async () => {
    const d = await get(`https://api.weather.gov/alerts/active?point=${pos.lat.toFixed(4)},${pos.lon.toFixed(4)}`);
    return (d.features || []).map(({ properties: p }) => {
      const text = `${p.headline || ''} ${p.description || ''}`;
      const storm = STORM_DANGER.test(p.event) ? 'danger'
        : STORM_CAUTION.test(p.event) || (/Special Weather Statement/i.test(p.event) && /thunderstorm|lightning/i.test(text)) ? 'caution' : null;
      return {
        id: p.id, event: p.event, severity: p.severity, headline: p.headline || p.event,
        onset: p.onset || p.effective, ends: p.ends || p.expires, area: p.areaDesc,
        description: String(p.description || '').slice(0, 1500), instruction: String(p.instruction || '').slice(0, 800),
        sender: p.senderName, storm,
      };
    });
  });
}

function nwsHourly(pos) {
  return cached(`nws-hourly-${pos.lat.toFixed(3)},${pos.lon.toFixed(3)}`, 30 * MIN, async () => {
    const point = await cached(`nws-point-${pos.lat.toFixed(3)},${pos.lon.toFixed(3)}`, DAY,
      () => get(`https://api.weather.gov/points/${pos.lat.toFixed(4)},${pos.lon.toFixed(4)}`));
    const url = point?.properties?.forecastHourly;
    if (!url) return [];
    const d = await get(url);
    return (d.properties?.periods || []).slice(0, 12).map(p => ({
      start: p.startTime, forecast: p.shortForecast, pop: p.probabilityOfPrecipitation?.value ?? null,
    }));
  });
}

// A lightning sensor entity in Home Assistant (Ecowitt, Ambient, ESPHome
// AS3935, ...). Its state is the distance to the last strike, and it changes
// when a new strike is detected.
async function lightningSensor() {
  if (!options.lightning_entity) return null;
  if (!ha.available) return { entity: options.lightning_entity, error: 'Home Assistant API not available' };
  try {
    const s = await ha.getState(options.lightning_entity);
    if (!s) return { entity: options.lightning_entity, error: 'Entity not found' };
    const raw = num(s.state);
    const unit = String(s.attributes?.unit_of_measurement || 'km').toLowerCase();
    const km = raw === null ? null : unit === 'mi' ? raw * 1.609344 : unit === 'm' ? raw / 1000 : raw;
    return { entity: options.lightning_entity, name: s.attributes?.friendly_name || options.lightning_entity, km, lastStrike: s.last_changed };
  } catch (e) {
    return { entity: options.lightning_entity, error: e.message };
  }
}

const unitKm = () => (options.distance_units === 'mi' ? 1.609344 : 1);

async function stormSafety() {
  const pos = gridToLatLon(options.grid);
  const useNws = options.nws_alerts && pos;
  const [alerts, hourly, sensor] = await Promise.all([
    useNws ? nwsAlerts(pos) : null, useNws ? nwsHourly(pos) : null, lightningSensor(),
  ].map(settle));
  const alertKm = options.lightning_alert_distance * unitKm();
  const strikeAge = sensor?.lastStrike ? Date.now() - Date.parse(sensor.lastStrike) : Infinity;
  const recent = sensor?.km != null && strikeAge < 30 * MIN;
  const danger = (alerts || []).filter(a => a.storm === 'danger');
  const caution = (alerts || []).filter(a => a.storm === 'caution');
  const thunder = (hourly || []).filter(h => /thunder/i.test(h.forecast));
  const thunderSoon = thunder.some(h => Date.parse(h.start) - Date.now() < 3 * 3600_000);

  const reasons = [];
  if (recent && sensor.km <= alertKm) reasons.push(`Lightning ${Math.round(sensor.km / unitKm())} ${options.distance_units} away`);
  for (const a of danger) reasons.push(a.event);
  let level = reasons.length ? 'danger' : 'safe';
  if (level === 'safe') {
    if (recent && sensor.km <= alertKm * 2) reasons.push(`Lightning ${Math.round(sensor.km / unitKm())} ${options.distance_units} away`);
    for (const a of caution) reasons.push(a.event);
    if (thunderSoon) reasons.push('Thunderstorms forecast within 3 hours');
    if (reasons.length) level = 'caution';
  }
  return {
    level, reasons, updated: new Date().toISOString(),
    alertDistance: options.lightning_alert_distance, units: options.distance_units,
    nws: useNws ? { available: alerts !== null, alerts: alerts || [], hourly: hourly || [] } : null,
    sensor: sensor && { ...sensor, recent, distance: sensor.km != null ? +(sensor.km / unitKm()).toFixed(1) : null },
  };
}

let lastStormLevel = null;

// Runs every minute: storm safety needs to be quicker than the 5-minute sensors.
async function publishStorm() {
  if (!ha.enabled) return;
  let s;
  try { s = await stormSafety(); } catch (e) { console.warn('[storm]', e.message); return; }
  const label = s.level[0].toUpperCase() + s.level.slice(1);
  const entities = [
    ['binary_sensor.ham_lightning_danger', s.level === 'danger' ? 'on' : 'off', {
      friendly_name: 'Lightning danger', device_class: 'safety', icon: 'mdi:weather-lightning',
      level: label, reasons: s.reasons,
    }],
    ['sensor.ham_storm_status', label, { friendly_name: 'Station storm status', icon: 'mdi:weather-lightning-rainy', reasons: s.reasons }],
  ];
  if (s.nws) {
    entities.push(['sensor.ham_nws_alerts', s.nws.available ? s.nws.alerts.length : null, {
      friendly_name: 'NWS alerts', icon: 'mdi:alert', state_class: 'measurement',
      alerts: s.nws.alerts.map(a => ({ event: a.event, headline: a.headline, ends: a.ends })),
    }]);
  }
  if (s.sensor && !s.sensor.error) {
    entities.push(['sensor.ham_lightning_distance', s.sensor.distance, {
      friendly_name: 'Last lightning strike distance', unit_of_measurement: options.distance_units, icon: 'mdi:flash',
      last_strike: s.sensor.lastStrike, source: s.sensor.entity,
    }]);
  }
  await ha.publish(entities);
  if (s.level === 'danger' && lastStormLevel !== 'danger') {
    ha.fireEvent('ham_dashboard_storm_danger', { reasons: s.reasons, time: s.updated });
  }
  lastStormLevel = s.level;
}

// ---------------------------------------------------------------- Home Assistant entities

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const fmtMHzRange = f => (Array.isArray(f) ? `${f[0].toFixed(3)}-${f[1].toFixed(3)}` : f?.toFixed(3));

async function haEntities() {
  const pos = gridToLatLon(options.grid);
  const now = Date.now();
  const [hq, scales, kpData, wind, xr, local] = await Promise.all([hamqsl(), noaaScales(), kp(), solarWind(), xray(), pos && localEstimate(pos)].map(settle));
  const past = (kpData || []).filter(k => k.kind !== 'predicted' && Date.parse(k.time) <= now);
  const kpNow = past.length ? past[past.length - 1].kp : hq?.k ?? null;
  const out = [];
  const sensor = (id, state, attrs) => out.push([`sensor.ham_${id}`, state, attrs]);

  sensor('solar_flux', hq?.sfi ?? wind?.f107, { friendly_name: 'Solar flux index', unit_of_measurement: 'sfu', state_class: 'measurement', icon: 'mdi:white-balance-sunny' });
  sensor('sunspot_number', hq?.ssn, { friendly_name: 'Sunspot number', state_class: 'measurement', icon: 'mdi:weather-sunny-alert' });
  sensor('a_index', hq?.a, { friendly_name: 'A-index', state_class: 'measurement', icon: 'mdi:magnet' });
  sensor('k_index', kpNow, { friendly_name: 'K-index', state_class: 'measurement', icon: 'mdi:magnet-on', geomagnetic_field: hq?.geomagfield ?? null });
  sensor('xray_flux', xr?.current ?? hq?.xray, { friendly_name: 'X-ray flux', icon: 'mdi:flash-alert', flux_w_m2: xr?.flux ?? null, peak_6h: xr?.max6h ?? null });
  sensor('solar_wind_speed', wind?.speed ?? hq?.solarwind, { friendly_name: 'Solar wind speed', unit_of_measurement: 'km/s', state_class: 'measurement', icon: 'mdi:weather-windy' });
  sensor('bz', wind?.bz ?? hq?.bz, { friendly_name: 'Interplanetary Bz', unit_of_measurement: 'nT', state_class: 'measurement', icon: 'mdi:compass-outline' });
  sensor('noise_floor', hq?.signalnoise, { friendly_name: 'Estimated noise floor', icon: 'mdi:waveform' });

  const cur = scales?.current;
  for (const [k, name, icon] of [['R', 'radio blackout', 'mdi:signal-off'], ['S', 'solar radiation storm', 'mdi:radioactive'], ['G', 'geomagnetic storm', 'mdi:earth']]) {
    sensor(`noaa_${k.toLowerCase()}_scale`, cur ? cur[k]?.scale ?? 0 : null, {
      friendly_name: `NOAA ${name} scale`, state_class: 'measurement', icon,
      level: cur ? `${k}${cur[k]?.scale ?? 0}` : null, description: cur?.[k]?.text ?? null,
    });
  }
  out.push(['binary_sensor.ham_radio_blackout', (cur?.R?.scale ?? 0) >= 1 ? 'on' : 'off', { friendly_name: 'HF radio blackout', icon: 'mdi:signal-off', level: `R${cur?.R?.scale ?? 0}` }]);
  out.push(['binary_sensor.ham_geomagnetic_storm', (cur?.G?.scale ?? 0) >= 1 || kpNow >= 5 ? 'on' : 'off', { friendly_name: 'Geomagnetic storm', icon: 'mdi:earth', level: `G${cur?.G?.scale ?? 0}`, k_index: kpNow }]);

  // Local band estimate, the same math the dashboard uses.
  const station = local?.station;
  const sunAlt = pos ? HamCore.sunAltitude(HamCore.sunPosition(new Date()), pos.lat, pos.lon) : 0;
  sensor('local_muf', local?.muf ?? null, {
    friendly_name: 'Local MUF (3000 km)', unit_of_measurement: 'MHz', state_class: 'measurement', icon: 'mdi:sine-wave',
    source: local?.source ?? null,
    ionosonde: station?.name ?? null, distance_km: station?.km ?? null, measured: station?.time ?? null, fof2_mhz: local?.fof2 ?? null,
  });
  const groups = Object.fromEntries((hq?.bands || []).map(b => [b.name, b]));
  for (const [band, mhz, group] of HamCore.HF_BANDS) {
    const r = local ? HamCore.rateBand(mhz, local.muf, sunAlt, kpNow ?? 0) : null;
    sensor(`band_${band}`, r ? r[0].toUpperCase() + r.slice(1) : null, {
      friendly_name: `${band} conditions`, icon: 'mdi:radio-tower', frequency_mhz: mhz,
      hamqsl_day: groups[group]?.day ?? null, hamqsl_night: groups[group]?.night ?? null,
      sun: sunAlt > -0.833 ? 'day' : 'night',
    });
  }

  if (pos) {
    try {
      const { sats } = await satellitePasses(pos);
      const upcoming = [];
      for (const s of sats) {
        const passes = s.passes.filter(p => Date.parse(p.los) > now);
        upcoming.push(...passes.map(p => ({ s, p })));
        const p = passes.find(x => x.maxEl >= 10);
        sensor(`next_pass_${slug(s.name)}`, p ? p.aos : null, {
          friendly_name: `${s.name} next pass`, device_class: 'timestamp', icon: 'mdi:satellite-variant',
          max_elevation: p?.maxEl ?? null, aos_azimuth: p ? Math.round(p.aosAz) : null, los_azimuth: p ? Math.round(p.losAz) : null,
          los: p?.los ?? null, duration_min: p?.durationMin ?? null, in_progress: p ? Date.parse(p.aos) <= now : false,
          mode: s.mode, uplink_mhz: fmtMHzRange(s.uplink) ?? null, downlink_mhz: fmtMHzRange(s.downlink) ?? null, tone: s.tone ?? null,
        });
      }
      const best = upcoming.filter(x => x.p.maxEl >= 30).sort((a, b) => Date.parse(a.p.aos) - Date.parse(b.p.aos))[0];
      sensor('next_good_pass', best ? best.p.aos : null, {
        friendly_name: 'Next good satellite pass', device_class: 'timestamp', icon: 'mdi:satellite-uplink',
        satellite: best?.s.name ?? null, max_elevation: best?.p.maxEl ?? null, duration_min: best?.p.durationMin ?? null,
        aos_azimuth: best ? Math.round(best.p.aosAz) : null, mode: best?.s.mode ?? null,
      });
    } catch (e) { console.warn('[ha] satellites:', e.message); }

    try {
      const radius = potaRadiusKm() || 400;
      const near = (await potaSpots())
        .filter(s => s.lat !== null && s.lon !== null)
        .map(s => ({ s, d: distanceKm(pos, s) }))
        .filter(x => x.d <= radius)
        .sort((a, b) => a.d - b.d);
      sensor('pota_nearby', near.length, {
        friendly_name: 'POTA activations nearby', icon: 'mdi:pine-tree', state_class: 'measurement',
        radius_km: Math.round(radius),
        spots: near.slice(0, 10).map(({ s, d }) => ({ activator: s.activator, reference: s.reference, park: s.park, frequency_khz: s.freq, mode: s.mode, distance_km: Math.round(d) })),
      });
    } catch (e) { console.warn('[ha] pota:', e.message); }

    try {
      const act = await bandActivity(pos);
      for (const [band, a] of Object.entries(act.bands)) {
        sensor(`activity_${band}`, a.stations, {
          friendly_name: `${band} stations heard nearby`, icon: 'mdi:access-point', state_class: 'measurement',
          dx_stations: a.dx, receivers: a.receivers, reports: a.reports,
          farthest_call: a.farthest?.call ?? null, farthest_km: a.farthest?.km ?? null,
          window_min: act.windowMin, radius_km: act.radiusKm,
        });
      }
    } catch (e) { console.warn('[ha] activity:', e.message); }

    try {
      const vhf = await vhfOpenings(pos);
      for (const [band, b] of Object.entries(vhf.bands)) {
        out.push([`binary_sensor.ham_${band}_open`, b.active ? 'on' : 'off', {
          friendly_name: `${band} opening`, icon: 'mdi:antenna',
          status: b.status[0].toUpperCase() + b.status.slice(1), stations: b.stations, receivers: b.receivers,
          toward: b.toward || null, likely: b.likely || null, open_since: b.openSince,
          farthest_call: b.farthest?.call ?? null, farthest_km: b.farthest?.km ?? null,
          regions: b.regions.map(r => r.field), window_min: vhf.windowMin,
        }]);
      }
    } catch (e) { console.warn('[ha] vhf:', e.message); }

    try { out.push(...await pathEntities(pos)); } catch (e) { console.warn('[ha] paths:', e.message); }
  }
  return out;
}

async function publishHa() {
  if (!ha.enabled) return;
  try { await ha.publish(await haEntities()); } catch (e) { console.warn('[ha]', e.message); }
}

// ---------------------------------------------------------------- geo

const { gridToLatLon, distanceKm, bearingDeg } = HamCore;
const DAY = 24 * 60 * MIN;

// ---------------------------------------------------------------- repeaters (HearHam)

// HearHam publishes its whole directory as one free download (~10 MB). We fetch
// it at most once a day, keep a copy in /data so restarts don't refetch, and
// filter by distance locally.
const HEARHAM_FILE = path.join(DATA_DIR, 'hearham-repeaters.json');

function normalizeMode(mode) {
  const parts = String(mode || '').toUpperCase().replace(/\s+/g, '').split(/[/,+]/).filter(Boolean).map(p =>
    /^D-?STAR$/.test(p) ? 'D-STAR'
      : /^(YSF|C4FM|FUSION)$/.test(p) ? 'Fusion'
        : /^(FM|NFM|WFM|ANALOG)$/.test(p) ? 'FM'
          : /^AX\.?25$/.test(p) ? 'Packet' : p);
  return [...new Set(parts)].join('/') || 'FM';
}

// CTCSS tones are >= 67 Hz; small numbers on digital repeaters are DMR color codes.
const toneOf = v => { const n = parseFloat(v); return n >= 60 ? n.toFixed(1) : n > 0 ? String(Math.round(n)) : ''; };

function slimRepeaters(list) {
  return list
    .filter(r => Number.isFinite(+r.latitude) && Number.isFinite(+r.longitude) && +r.frequency > 0)
    .map(r => ({
      id: r.id,
      call: String(r.callsign || '').trim().toUpperCase(),
      lat: +r.latitude, lon: +r.longitude,
      city: String(r.city || '').trim(),
      group: String(r.group || '').trim(),
      node: String(r.internet_node || '').trim(),
      mode: normalizeMode(r.mode),
      freq: +r.frequency, offset: +r.offset || 0,
      encode: toneOf(r.encode), decode: toneOf(r.decode),
      description: String(r.description || '').trim(),
      power: r.power && r.power !== 'unknown' ? r.power : '',
      operational: +r.operational === 1,
      restriction: String(r.restriction || '').trim(),
    }));
}

function repeaterDb() {
  return cached('hearham', 6 * 60 * MIN, async () => {
    let disk = null;
    try { disk = JSON.parse(fs.readFileSync(HEARHAM_FILE, 'utf8')); } catch { /* first run */ }
    if (disk && Date.now() - disk.fetched < DAY) return disk;
    try {
      const db = { fetched: Date.now(), list: slimRepeaters(await get('https://hearham.com/api/repeaters/v1')) };
      fs.writeFile(HEARHAM_FILE, JSON.stringify(db), err => err && console.warn('[repeaters] cache write failed:', err.message));
      console.log(`[repeaters] downloaded ${db.list.length} repeaters from HearHam`);
      return db;
    } catch (err) {
      if (disk) { console.warn(`[repeaters] ${err.message} (using copy from ${new Date(disk.fetched).toISOString()})`); return disk; }
      throw err;
    }
  });
}

async function nearbyRepeaters(pos, radiusKm) {
  const db = await repeaterDb();
  const out = [];
  for (const r of db.list) {
    if (Math.abs(r.lat - pos.lat) > radiusKm / 100 + 0.5) continue; // cheap prefilter
    const dist = distanceKm(pos, r);
    if (dist <= radiusKm) out.push({ ...r, dist, bearing: bearingDeg(pos, r) });
  }
  out.sort((a, b) => a.dist - b.dist);
  return { source: 'HearHam', fetched: new Date(db.fetched).toISOString(), total: out.length, repeaters: out.slice(0, 500) };
}

// ---------------------------------------------------------------- callsign lookup

const QRZ_AGENT = 'SwampFoxLabsHamDash-0.3';
let qrzSession = null;
const qrzConfigured = () => Boolean(options.qrz_username && options.qrz_password);

const unescapeXml = s => s && s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// The request URL carries the user's QRZ password, so it must never appear in
// an error message or log line.
async function qrzRequest(params) {
  const r = await fetch(`https://xmldata.qrz.com/xml/current/?${new URLSearchParams(params)}`, {
    headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`QRZ returned HTTP ${r.status}`);
  return r.text();
}

async function qrzLogin() {
  const xml = await qrzRequest({ username: options.qrz_username, password: options.qrz_password, agent: QRZ_AGENT });
  const key = xmlTag(xml, 'Key');
  if (!key) throw new Error(`QRZ login failed: ${xmlTag(xml, 'Error') || 'no session key returned'}`);
  qrzSession = { key, sub: xmlTag(xml, 'SubExp') || '' };
  return qrzSession;
}

function parseQrz(block, sub) {
  const f = name => unescapeXml(xmlTag(block, name)) || '';
  const call = f('call');
  return {
    source: 'qrz', subscriber: !/non-subscriber/i.test(sub),
    call, aliases: f('aliases'),
    name: f('name_fmt') || [f('fname'), f('name')].filter(Boolean).join(' '),
    nickname: f('nickname'),
    addr1: f('addr1'), addr2: f('addr2'), state: f('state'), zip: f('zip'),
    county: f('county'), country: f('country'),
    lat: num(f('lat')), lon: num(f('lon')), grid: f('grid'),
    class: f('class'), effective: f('efdate'), expires: f('expdate'),
    qslmgr: f('qslmgr'), eqsl: f('eqsl') === '1', lotw: f('lotw') === '1', mqsl: f('mqsl') === '1',
    dxcc: f('dxcc'), cqzone: f('cqzone'), ituzone: f('ituzone'), timezone: f('TimeZone'),
    image: f('image'),
    url: `https://www.qrz.com/db/${encodeURIComponent(call)}`,
  };
}

async function qrzLookup(call) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = qrzSession || await qrzLogin();
    const xml = await qrzRequest({ s: session.key, callsign: call });
    const sess = xmlTag(xml, 'Session') || '';
    const error = xmlTag(sess, 'Error');
    const block = xmlTag(xml, 'Callsign');
    if (block) return parseQrz(block, session.sub);
    if (error && /not found/i.test(error)) return null;
    if (attempt === 0 && (!xmlTag(sess, 'Key') || /session|timeout|invalid/i.test(error || ''))) { qrzSession = null; continue; }
    throw new Error(`QRZ: ${error || 'unexpected response'}`);
  }
  return null;
}

async function callookLookup(call) {
  const d = await get(`https://callook.info/${encodeURIComponent(call)}/json`);
  if (d.status !== 'VALID') return null;
  return {
    source: 'callook',
    call: d.current?.callsign || call,
    name: d.name || '',
    type: d.type || '',
    class: d.current?.operClass || (d.type === 'CLUB' ? 'Club' : ''),
    addr1: d.address?.line1 || '', addr2: d.address?.line2 || '',
    country: 'United States',
    lat: num(d.location?.latitude), lon: num(d.location?.longitude), grid: d.location?.gridsquare || '',
    effective: d.otherInfo?.grantDate || '', expires: d.otherInfo?.expiryDate || '',
    trustee: d.trustee?.callsign || '', previous: d.previous?.callsign || '',
    uls: d.otherInfo?.ulsUrl || '',
    url: `https://www.qrz.com/db/${encodeURIComponent(call)}`,
  };
}

const US_CALL = /^(A[A-L]|K|N|W)[A-Z]?\d[A-Z]{1,3}$/;
const stripEmpty = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null));

function lookupCall(call) {
  return cached(`lookup-${call}`, DAY, async () => {
    let qrz = null, warning = null;
    if (qrzConfigured()) {
      try { qrz = await qrzLookup(call); } catch (e) { warning = e.message; qrzSession = null; }
    }
    // Fill gaps from FCC data for US calls when QRZ is missing or limited.
    let fcc = null;
    if (US_CALL.test(call) && (!qrz || !qrz.subscriber)) {
      try { fcc = await callookLookup(call); } catch (e) { console.warn('[lookup] callook:', e.message); }
    }
    if (!qrz && !fcc) return { call, notFound: true, qrz: qrzConfigured(), warning };
    const merged = { ...(fcc || {}), ...(qrz ? stripEmpty(qrz) : {}) };
    merged.sources = [qrz && (qrz.subscriber ? 'QRZ' : 'QRZ (basic)'), fcc && 'FCC via callook.info'].filter(Boolean);
    return { ...merged, warning };
  });
}

// ---------------------------------------------------------------- station type & setup

// A stable, unique receive-only login for people without an amateur callsign
// (APRS-IS requires a unique login). Letters followed by five digits can't be
// a real amateur callsign, so it never impersonates anyone.
function listenerId() {
  const file = path.join(DATA_DIR, 'listener_id.txt');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (/^SWL\d{5}$/.test(saved)) return saved;
  } catch { /* first run */ }
  const id = `SWL${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`;
  try { fs.writeFileSync(file, id); } catch (e) { console.warn('[setup] listener ID not saved:', e.message); }
  return id;
}

const SETUP_FILE = path.join(DATA_DIR, 'setup.json');
const setupDone = () => fs.existsSync(SETUP_FILE);
// New installs without a grid get the setup screen; existing installs don't.
const needsSetup = () => !setupDone() && !options.grid;
const canSaveSetup = () => ha.available || Boolean(process.env.SUPERVISOR_URL);

function readBody(req, limit = 16_384) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > limit) { reject(new Error('request too large')); req.destroy(); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// The setup screen saves into the app's own options through Supervisor (apps
// may always call /addons/self/*), so the Configuration tab stays the single
// source of truth, then restarts the app so new logins take effect.
async function handleSetup(req, res) {
  let input;
  try { input = JSON.parse(await readBody(req) || '{}'); } catch { return send(res, 400, { error: 'Invalid request' }); }
  const writeDone = extra => fs.writeFileSync(SETUP_FILE, JSON.stringify({ done: true, at: new Date().toISOString(), ...extra }));

  if (input.skip) {
    writeDone({ skipped: true });
    return send(res, 200, { ok: true, restarting: false });
  }

  const stationType = STATION_TYPES.includes(input.station_type) ? input.station_type : null;
  const callsign = String(input.callsign || '').trim().toUpperCase();
  const grid = String(input.grid || '').trim();
  const errors = [];
  if (!stationType) errors.push('Pick how you use the dashboard.');
  if (stationType === 'amateur' && !/^[A-Z0-9/]{3,15}$/.test(callsign)) errors.push('Enter your amateur callsign.');
  if (callsign && !/^[A-Z0-9/]{3,15}$/.test(callsign)) errors.push('That callsign has characters it shouldn’t.');
  if (!/^[A-R]{2}\d{2}([A-X]{2})?$/i.test(grid)) errors.push('Enter a 4 or 6 character grid square, like DM14 or DM14xd.');
  if (!['mi', 'km'].includes(input.distance_units)) errors.push('Pick miles or kilometers.');
  if (errors.length) return send(res, 400, { error: errors.join(' ') });
  if (!canSaveSetup()) return send(res, 501, { error: 'Setup can only save when the dashboard runs inside Home Assistant.' });

  const g = grid.length === 6 ? grid.slice(0, 4).toUpperCase() + grid.slice(4).toLowerCase() : grid.toUpperCase();
  const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
  const current = readOptionsFile();
  const merged = {
    ...current,
    station_type: stationType,
    callsign: stationType === 'listener' ? '' : callsign,
    grid: g,
    distance_units: input.distance_units,
    aprs_enabled: bool(input.aprs_enabled, current.aprs_enabled ?? true),
    dx_cluster_enabled: stationType === 'amateur' ? bool(input.dx_cluster_enabled, current.dx_cluster_enabled ?? true) : (current.dx_cluster_enabled ?? true),
    nws_alerts: bool(input.nws_alerts, current.nws_alerts ?? true),
    ha_sensors: bool(input.ha_sensors, current.ha_sensors ?? true),
  };
  try {
    const supervisorUrl = process.env.SUPERVISOR_URL || 'http://supervisor';
    const r = await fetch(`${supervisorUrl}/addons/self/options`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ha.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ options: merged }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.result === 'error') throw new Error(j.message || `Supervisor returned HTTP ${r.status}`);
  } catch (e) {
    console.warn('[setup] saving options failed:', e.message);
    return send(res, 502, { error: `Couldn't save settings: ${e.message}` });
  }
  writeDone({ station_type: stationType });
  console.log(`[setup] saved (${stationType}${callsign ? ` ${callsign}` : ''}, ${g}); restarting`);
  send(res, 200, { ok: true, restarting: true });
  setTimeout(() => {
    const supervisorUrl = process.env.SUPERVISOR_URL || 'http://supervisor';
    fetch(`${supervisorUrl}/addons/self/restart`, { method: 'POST', headers: { Authorization: `Bearer ${ha.token}` } })
      .catch(e => console.warn('[setup] restart request failed:', e.message));
  }, 800);
}

// ---------------------------------------------------------------- HTTP

// Sent with every response. Inline style attributes are needed (Leaflet and
// the charts use them); scripts only come from the app itself; images may be
// map tiles and QRZ photos over https.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: https:",
    "connect-src 'self'", "font-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'",
  ].join('; '),
};

// Gzip text responses for browsers that accept it. Over a slow remote
// connection this cuts the first load from about 480 KB to about 130 KB.
const acceptsGzip = req => /\bgzip\b/.test(req?.headers['accept-encoding'] || '');
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg)/;

function send(res, status, body, type = 'application/json') {
  let data = type === 'application/json' ? JSON.stringify(body) : body;
  const headers = { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  if (COMPRESSIBLE.test(type) && Buffer.byteLength(data) > 1400 && acceptsGzip(res.req)) {
    data = zlib.gzipSync(data, { level: 5 });
    headers['Content-Encoding'] = 'gzip';
  }
  res.writeHead(status, headers);
  res.end(data);
}

const settle = async p => { try { return await p; } catch (e) { console.warn('[fetch]', e.message); return null; } };

async function api(route, q, res, req) {
  switch (route) {
    case '/api/config':
      return send(res, 200, {
        version: process.env.APP_VERSION || 'dev',
        station_type: options.station_type,
        callsign: options.callsign, grid: options.grid, distance_units: options.distance_units,
        setup: { needed: needsSetup(), done: setupDone(), canSave: canSaveSetup() },
        viewer: await users.viewer(req),
        features: { aprs: options.aprs_enabled, dx_cluster: options.dx_cluster_enabled, nws: options.nws_alerts, ha_sensors: options.ha_sensors },
        cluster: { status: cluster.status, host: cluster.host || options.dx_cluster_host, error: cluster.error },
        qrz: qrzConfigured(),
        ha: ha.status(),
        spot_watch: options.spot_watch,
      });
    case '/api/activity': {
      const lat = num(q.get('lat')), lon = num(q.get('lon'));
      if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return send(res, 400, { error: 'Set a valid grid square' });
      return send(res, 200, await bandActivity({ lat, lon }));
    }
    case '/api/local': {
      const lat = num(q.get('lat')), lon = num(q.get('lon'));
      if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return send(res, 400, { error: 'Set a valid grid square' });
      return send(res, 200, await localEstimate({ lat, lon }));
    }
    case '/api/vhf': {
      const lat = num(q.get('lat')), lon = num(q.get('lon'));
      if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return send(res, 400, { error: 'Set a valid grid square' });
      return send(res, 200, await vhfOpenings({ lat, lon }));
    }
    case '/api/path': {
      const lat = num(q.get('lat')), lon = num(q.get('lon'));
      if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return send(res, 400, { error: 'Set a valid grid square' });
      const from = { lat, lon };
      let target;
      try { target = await resolveTarget(q); } catch (e) { return send(res, e.status || 502, { error: e.message }); }
      if (!target) return send(res, 404, { error: `Couldn’t find a location for ${String(q.get('target') || '').toUpperCase()}. Try a grid square.` });
      if (distanceKm(from, target) < 30) return send(res, 400, { error: 'That’s right next to you. Pick a target farther away.' });
      const inputs = await pathInputs();
      return send(res, 200, {
        from, target,
        inputs: { ssn: Math.round(inputs.ssn), sfi: inputs.sfi, kp: inputs.kp, ionosondes: inputs.stations.length },
        ...pathReport(from, target, inputs),
        measured: await pathEvidence(from, target, { approximate: target.approximate }),
      });
    }
    case '/api/paths':
      return send(res, 200, { paths: readPaths(), max: MAX_SAVED_PATHS });
    case '/api/accuracy': {
      // The note covers the current model only; previous is the last model's
      // record, kept for comparison.
      const records = accuracyLog.read();
      const current = records.filter(Accuracy.isCurrent);
      return send(res, 200, {
        week: Accuracy.summarize(current, Date.now() - 7 * DAY), all: Accuracy.summarize(current, 0),
        previous: Accuracy.summarize(records.filter(r => !Accuracy.isCurrent(r)), 0), dxKm: Accuracy.DX_KM,
      });
    }
    case '/api/accuracy.jsonl': {
      let body = '';
      try { body = fs.readFileSync(accuracyLog.file); } catch { /* no checks yet */ }
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/x-ndjson', 'Content-Disposition': 'attachment; filename="ham-dashboard-accuracy.jsonl"', 'Cache-Control': 'no-store' });
      return res.end(body);
    }
    case '/api/timesignals': {
      const lat = num(q.get('lat')), lon = num(q.get('lon'));
      if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return send(res, 400, { error: 'Set a valid grid square' });
      return send(res, 200, await timeSignals({ lat, lon }));
    }
    case '/api/beacons': {
      const lat = num(q.get('lat')), lon = num(q.get('lon'));
      if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return send(res, 400, { error: 'Set a valid grid square' });
      return send(res, 200, await beaconRatings({ lat, lon }));
    }
    case '/api/status': {
      // The AppArmor profile this process runs under, for example
      // "d0e1ec98_ham_dashboard//node (enforce)". Null where there's no AppArmor.
      let apparmor = null;
      for (const f of ['/proc/self/attr/apparmor/current', '/proc/self/attr/current']) {
        try { apparmor = fs.readFileSync(f, 'utf8').replace(/\0/g, '').trim() || null; break; } catch { /* not on this system */ }
      }
      const a = aprs.snapshot();
      return send(res, 200, {
        version: process.env.APP_VERSION || 'dev',
        started: STARTED, now: new Date().toISOString(),
        station_type: options.station_type, grid: options.grid,
        sources: sourceStatus.report(),
        live: {
          cluster: { status: cluster.status, host: cluster.host || options.dx_cluster_host, error: cluster.error ?? null, spots: cluster.spots.length },
          aprs: { status: a.status, server: a.server ?? null, error: a.error ?? null, stations: a.stations.length, packets: a.packets },
          ha: ha.status(),
          users: { error: users.lastError },
          apparmor,
        },
      });
    }
    case '/api/storm':
      return send(res, 200, await stormSafety());
    case '/api/pota':
      return send(res, 200, { spots: await potaSpots() });
    case '/api/satellites': {
      const lat = num(q.get('lat')), lon = num(q.get('lon'));
      if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return send(res, 400, { error: 'Set a valid grid square' });
      const pos = { lat, lon };
      const passes = await satellitePasses(pos);
      return send(res, 200, { ...passes, now: SATS.positionsNow(await satelliteTles(), pos) });
    }
    case '/api/repeaters': {
      const lat = num(q.get('lat')), lon = num(q.get('lon'));
      const radius = Math.min(Math.max(num(q.get('radius')) || 80, 5), 400);
      if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return send(res, 400, { error: 'Set a valid grid square' });
      return send(res, 200, await nearbyRepeaters({ lat, lon }, radius));
    }
    case '/api/aprs':
      return send(res, 200, aprs.snapshot());
    case '/api/lookup': {
      const call = String(q.get('call') || '').trim().toUpperCase();
      if (!/^[A-Z0-9/]{3,15}$/.test(call)) return send(res, 400, { error: 'Enter a valid callsign' });
      return send(res, 200, await lookupCall(call));
    }
    case '/api/solar': {
      const [hq, scales, kpData, wind, xr, al, fc] = await Promise.all(
        [hamqsl(), noaaScales(), kp(), solarWind(), xray(), alerts(), forecast3day()].map(settle));
      return send(res, 200, { hamqsl: hq, scales, kp: kpData, wind, xray: xr, alerts: al, forecast: fc, fetched: new Date().toISOString() });
    }
    case '/api/cycle':
      return send(res, 200, await solarCycle());
    case '/api/ionosondes':
      return send(res, 200, await ionosondes());
    case '/api/spots':
      return send(res, 200, { status: cluster.status, host: cluster.host || options.dx_cluster_host, error: cluster.error, spots: cluster.spots });
    case '/api/psk': {
      const call = String(q.get('call') || options.callsign).toUpperCase();
      const minutes = [60, 360, 1440].includes(+q.get('minutes')) ? +q.get('minutes') : 60;
      if (!/^[A-Z0-9/]{3,15}$/.test(call)) return send(res, 400, { error: 'Set a valid callsign' });
      return send(res, 200, await pskReports(call, minutes));
    }
    case '/api/map/mufd.svg':
    case '/api/map/fof2.svg':
      return send(res, 200, await propMap(route.includes('mufd') ? 'mufd' : 'fof2'), 'image/svg+xml');
    default:
      return send(res, 404, { error: 'not found' });
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

// Asset links in index.html carry the app version, so a browser never mixes
// an old app.js with a new page after an update. Outside Home Assistant the
// start time stands in for the version.
const RELEASED = !!process.env.APP_VERSION && process.env.APP_VERSION !== 'dev';
const ASSET_VERSION = RELEASED ? process.env.APP_VERSION : String(Date.parse(STARTED));
const VERSIONED = /((?:src|href)=")(lib\/leaflet\/leaflet\.(?:css|js)|style\.css|hamcore\.js|reference\.js|app\.js)"/g;

function serveStatic(url, res) {
  let rel;
  try { rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, ''); } catch { return send(res, 400, { error: 'bad path' }); }
  const file = path.resolve(STATIC_DIR, rel);
  if (!file.startsWith(STATIC_DIR + path.sep)) return send(res, 403, { error: 'forbidden' });
  staticFile(file, rel === 'index.html', (err, f) => {
    if (err) return send(res, 404, { error: 'not found' });
    // Versioned assets never change at the same URL; everything else revalidates.
    // In development files change without a new version, so they always revalidate.
    const cache = f.isPage ? 'no-store' : RELEASED && url.searchParams.get('v') === ASSET_VERSION ? 'public, max-age=31536000, immutable' : 'no-cache';
    const gzip = f.gzip && acceptsGzip(res.req);
    res.writeHead(200, {
      ...SECURITY_HEADERS, 'Content-Type': f.type, 'Cache-Control': cache, Vary: 'Accept-Encoding',
      ...(gzip && { 'Content-Encoding': 'gzip' }),
    });
    res.end(gzip ? f.gzip : f.data);
  });
}

// Static files are read and compressed once, then served from memory. A file
// is only read again if its modification time changes (an update, or editing
// during development).
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

// Inside Home Assistant, only the ingress proxy may connect: other apps on the
// internal network can't reach the dashboard or its setup endpoint directly.
// Outside Home Assistant (development) anything may connect, unless
// INGRESS_ONLY=true (for testing this check).
const INGRESS_PROXY = '172.30.32.2';
const IN_HOME_ASSISTANT = fs.existsSync('/data') || process.env.INGRESS_ONLY === 'true';

function clientAllowed(req) {
  if (!IN_HOME_ASSISTANT) return true;
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === INGRESS_PROXY || ip === '127.0.0.1' || ip === '::1';
}

// Requests that change something must be same-origin JSON. A page on another
// site can't send a JSON request without a CORS preflight, which this server
// never approves, and browsers mark cross-site requests in Sec-Fetch-Site.
function writeAllowed(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return false;
  return /^application\/json\b/i.test(req.headers['content-type'] || '');
}

// Setup and saved paths are shared by the whole household: admins only.
const users = new Users({
  enforce: IN_HOME_ASSISTANT,
  token: ha.token,
  wsUrl: process.env.HA_WS_URL || `${(process.env.SUPERVISOR_URL || 'http://supervisor').replace(/^http/, 'ws')}/core/websocket`,
});
const ADMIN_ONLY = {
  unknown: 'Only Home Assistant admins can change this. Open the dashboard from the Home Assistant sidebar.',
  user: 'Only Home Assistant admins can change this.',
  unavailable: 'Couldn’t confirm you’re a Home Assistant admin, so this wasn’t saved. Try again in a minute.',
};

async function adminOnly(req, res) {
  const v = await users.viewer(req);
  if (v.admin) return false;
  console.warn(`[http] refused ${req.method} ${req.url.split('?')[0]} from a non-admin (${v.reason})`);
  send(res, 403, { error: ADMIN_ONLY[v.reason] || ADMIN_ONLY.user, admin_only: true });
  return true;
}

http.createServer(async (req, res) => {
  try {
    if (!clientAllowed(req)) {
      console.warn(`[http] refused ${req.socket.remoteAddress}: only Home Assistant ingress may connect`);
      return send(res, 403, { error: 'Open the dashboard from the Home Assistant sidebar.' });
    }
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !writeAllowed(req)) return send(res, 403, { error: 'Request refused' });
    if (url.pathname === '/api/setup' && req.method === 'POST') return await adminOnly(req, res) || await handleSetup(req, res);
    if (url.pathname === '/api/paths' && (req.method === 'POST' || req.method === 'DELETE')) return await adminOnly(req, res) || await handlePaths(req, res, url);
    if (url.pathname.startsWith('/api/')) return await api(url.pathname, url.searchParams, res, req);
    return serveStatic(url, res);
  } catch (e) {
    console.error('[http]', e.message);
    send(res, 502, { error: e.message });
  }
}).listen(PORT, () => {
  console.log(`[ham-dashboard] listening on :${PORT} (call=${options.callsign || '-'} grid=${options.grid || '-'})`);
  if (restoredEntries) console.log(`[cache] restored ${restoredEntries} recent PSKReporter result(s) from before the restart`);
  cluster.start(options);
  aprs.start({
    enabled: options.aprs_enabled,
    // Non-amateurs log in receive-only with a generated listener ID.
    callsign: options.station_type === 'amateur' && options.callsign ? options.callsign : listenerId(),
    center: gridToLatLon(options.grid),
    radiusKm: Math.min(Math.max(options.aprs_radius, 10), 300) * (options.distance_units === 'mi' ? 1.609344 : 1),
  });
  ha.start({ enabled: options.ha_sensors, mqtt: options.ha_mqtt }).then(() => {
    if (!ha.enabled) return;
    console.log('[ha] publishing sensors to Home Assistant');
    setTimeout(publishHa, 20_000);
    setInterval(publishHa, 5 * MIN);
    setTimeout(checkPotaAlerts, 25_000);
    setInterval(checkPotaAlerts, 2 * MIN);
    setTimeout(publishStorm, 15_000);
    setInterval(publishStorm, MIN);
  });
  setTimeout(runAccuracyCheck, 2 * MIN).unref();
  setInterval(runAccuracyCheck, 15 * MIN).unref();
});
