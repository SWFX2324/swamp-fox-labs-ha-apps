'use strict';
// Preloaded into the server (node --require) for the end-to-end tests, the
// container smoke test and local previews. Answers adsb.fi requests with
// synthetic aircraft, so nothing touches the real feed. Any other outside
// request is refused and logged as UNMOCKED.
//
// One synthetic flight, AAL1920 / N195UW / A17C95, flies Raleigh to Los
// Angeles in FAKE_TRIP_MINUTES (default 30). Area scans return a handful of
// aircraft around the scan centre.
//
// FAKE_ADSB=429      every request is rate limited (Retry-After: 120)
// FAKE_ADSB=429date  rate limited with an HTTP-date Retry-After
// FAKE_ADSB=500      every request fails
// FAKE_ADSB=slow     answers after 300 ms (to test coalescing)

const realFetch = globalThis.fetch;
const mode = process.env.FAKE_ADSB || '';
const tripMs = (Number(process.env.FAKE_TRIP_MINUTES) || 30) * 60_000;
const started = Date.now();
let calls = 0;

const RDU = [35.877, -78.787], LAX = [33.942, -118.408];

function flight() {
  const f = Math.min(1, (Date.now() - started) / tripMs);
  const lat = RDU[0] + (LAX[0] - RDU[0]) * f + Math.sin(f * Math.PI) * 2.2;
  const lon = RDU[1] + (LAX[1] - RDU[1]) * f;
  const climbing = f < 0.08, descending = f > 0.9;
  return {
    hex: 'a17c95', type: 'adsb_icao', flight: 'AAL1920 ', r: 'N195UW', t: 'A321', desc: 'AIRBUS A-321',
    lat: +lat.toFixed(5), lon: +lon.toFixed(5),
    alt_baro: f >= 1 ? 'ground' : climbing ? Math.round(2000 + f * 380000) : descending ? Math.round(35000 - (f - 0.9) * 330000) : 35000,
    gs: f >= 1 ? 12 : 468, track: 268, baro_rate: climbing ? 2200 : descending ? -1800 : 0, squawk: '2060', seen_pos: 0.4, seen: 0.2,
  };
}

function around(lat, lon) {
  const out = [];
  const names = [['SWA2231', 'N8710M', 'B38M'], ['DAL1604', 'N3765', 'B739'], ['N172SP', 'N172SP', 'C172'], ['UAL889', 'N2135U', 'B77W'], ['JBU1023', 'N964JB', 'A320'], ['SKW5123', 'N606SK', 'CRJ9'], ['', 'N44TX', 'PC12']];
  names.forEach(([cs, r, t], i) => {
    const ang = (i / names.length) * Math.PI * 2 + (Date.now() - started) / 600_000;
    const d = 0.25 + (i % 3) * 0.3;
    out.push({ hex: `ac${String(i).padStart(4, '0')}`, flight: cs ? cs + ' ' : '', r, t, lat: +(lat + Math.sin(ang) * d).toFixed(4), lon: +(lon + Math.cos(ang) * d).toFixed(4), alt_baro: [37000, 24000, 4500, 39000, 11000, 31000, 'ground'][i], gs: [452, 390, 110, 498, 300, 430, 0][i], track: (i * 53) % 360, seen_pos: i % 4, squawk: i === 3 ? '7700' : '1200' });
  });
  return out;
}

function reply(status, body, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (!u.startsWith('https://opendata.adsb.fi/api/')) {
    if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(u)) return realFetch(url, opts);
    console.error('UNMOCKED', u);
    throw new Error('UNMOCKED ' + u);
  }
  calls++;
  if (process.env.FAKE_ADSB_LOG) console.log('[fake-adsbfi]', calls, u.slice(29));
  if (mode === '429') return reply(429, { msg: 'slow down' }, { 'Retry-After': '120' });
  if (mode === '429date') return reply(429, { msg: 'slow down' }, { 'Retry-After': new Date(Date.now() + 90_000).toUTCString() });
  if (mode === '500') return reply(500, 'oops');
  if (mode === 'slow') await new Promise(r => setTimeout(r, 300));
  const path = u.slice('https://opendata.adsb.fi/api/'.length);
  let m;
  if ((m = path.match(/^v3\/lat\/(-?[\d.]+)\/lon\/(-?[\d.]+)\/dist\/(\d+)$/))) {
    const lat = +m[1], lon = +m[2];
    const ac = around(lat, lon);
    const f = flight();
    if (Math.abs(f.lat - lat) < 1.5 && Math.abs(f.lon - lon) < 1.8) ac.push(f);
    return reply(200, { ac, now: Date.now(), total: ac.length });
  }
  if ((m = path.match(/^v2\/(callsign|registration|hex)\/([A-Z0-9-]+)$/))) {
    const [, kind, value] = m;
    const f = flight();
    const match = (kind === 'callsign' && value === 'AAL1920') || (kind === 'registration' && value === 'N195UW') || (kind === 'hex' && value === 'A17C95');
    if (kind === 'callsign' && value === 'TWIN1') return reply(200, { ac: [{ ...f, hex: 'a00001', flight: 'TWIN1' }, { ...f, hex: 'a00002', flight: 'TWIN1', lat: 40, lon: -100 }] });
    return reply(200, { ac: match ? [f] : [], now: Date.now() });
  }
  return reply(400, { msg: 'bad path' });
};

globalThis.__fakeAdsbCalls = () => calls;
