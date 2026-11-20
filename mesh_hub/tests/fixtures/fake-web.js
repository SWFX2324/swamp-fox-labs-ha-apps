'use strict';
// Preloaded into the server (node --require) for the end-to-end tests, the
// container smoke test and local previews. Answers the two public map
// requests with made-up nodes around Columbia, SC (plus a few far away that
// the app must leave out). Any other outside request is refused and logged
// as UNMOCKED.
//
// FAKE_WEB=500   both maps fail

const realFetch = globalThis.fetch;
const HOME = { lat: 34.0007, lon: -81.0348 };
const now = () => Math.floor(Date.now() / 1000);

function meshmap() {
  const out = {};
  const near = [
    ['Sumter Hilltop', 'SUMT', 'HELTEC_V3', 'ROUTER', 0.1, 0.62], ['Lexington Porch', 'LEX1', 'RAK4631', 'CLIENT_BASE', -0.02, -0.21],
    ['Orangeburg Rpt', 'OBG', 'STATION_G2', 'ROUTER_LATE', -0.5, 0.17], ['Newberry Car', 'NEWB', 'TRACKER_T1000_E', 'TRACKER', 0.27, -0.58],
    ['Camden Base', 'CAMD', 'T_ECHO', 'CLIENT', 0.25, 0.43], ['Blythewood Tower', 'BLY', 'HELTEC_V4', 'ROUTER', 0.17, 0.06],
    ['Chapin Kayak', 'CHAP', 'HELTEC_WIRELESS_TRACKER', 'CLIENT', 0.11, -0.34], ['Swansea Farm', 'SWAN', 'RAK4631', 'CLIENT_MUTE', -0.22, 0.02],
    // Also heard by the local radio, so the page should show it once.
    ['Congaree Ridge Router', 'CRR', 'HELTEC_V3', 'ROUTER', 0.11, -0.07, 0x3f2a9b10],
  ];
  near.forEach(([longName, shortName, hwModel, role, dlat, dlon, num], i) => {
    out[String(num ?? 900000000 + i * 7919)] = {
      longName, shortName, hwModel, role, latitude: Math.round((HOME.lat + dlat) * 1e7), longitude: Math.round((HOME.lon + dlon) * 1e7),
      altitude: 100 + i * 10, batteryLevel: 50 + i * 5, voltage: 3.9, region: 'US', modemPreset: 'LONG_FAST', fwVersion: '2.7.15',
      seenBy: { 'msh/US/2/e/LongFast/!aabbccdd': now() - i * 600 },
    };
  });
  out['123456789'] = { longName: 'Berlin Node', shortName: 'BER', latitude: 525200000, longitude: 134050000, seenBy: { x: now() } };
  out['223456789'] = { longName: 'Stale Columbia', shortName: 'OLD', latitude: Math.round(HOME.lat * 1e7), longitude: Math.round(HOME.lon * 1e7), seenBy: { x: now() - 3 * 86400 } };
  out['323456789'] = { longName: 'No position' };
  return out;
}

function meshcoreMap() {
  const iso = s => new Date((now() - s) * 1000).toISOString();
  const key = s => s.repeat(64 / s.length);
  const near = [
    ['Sumter MC RPT', 2, 0.08, 0.6], ['Lexington Room', 3, -0.03, -0.25], ['Aiken Ridge RPT', 2, -0.43, -0.7], ['Columbia Mobile', 1, 0.01, 0.02],
    ['Fort Jackson RPT', 2, 0.02, 0.15], ['Winnsboro Sensor', 4, 0.37, 0.08],
  ];
  const nodes = near.map(([name, type, dlat, dlon], i) => ({
    public_key: key(['a1', 'b2', 'c3', 'd4', 'e5', 'f6'][i]), type, adv_name: name, last_advert: iso(i * 3600),
    adv_lat: +(HOME.lat + dlat).toFixed(4), adv_lon: +(HOME.lon + dlon).toFixed(4), inserted_date: iso(86400 * 30), updated_date: iso(i * 3600),
    params: { freq: 910.525, bw: 62.5, sf: 7, cr: 5 }, link: 'meshcore://x', source: 'uploader',
  }));
  // A name with braces and an escaped quote, to keep the stream splitter honest.
  nodes.push({ public_key: key('0f'), type: 1, adv_name: 'Brace {"} Test', last_advert: iso(60), adv_lat: HOME.lat + 0.05, adv_lon: HOME.lon - 0.05, updated_date: iso(60), params: {} });
  nodes.push({ public_key: key('99'), type: 2, adv_name: 'Munich RPT', last_advert: iso(60), adv_lat: 48.1, adv_lon: 11.5, updated_date: iso(60), params: {} });
  return nodes;
}

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(u)) return realFetch(url, opts);
  const known = u === 'https://meshmap.net/nodes.json' || u === 'https://map.meshcore.io/api/v1/nodes';
  if (!known) {
    console.error('UNMOCKED', u);
    throw new Error('UNMOCKED ' + u);
  }
  if (process.env.FAKE_WEB_LOG) console.log('[fake-web]', u);
  if (process.env.FAKE_WEB === '500') return new Response('down', { status: 500 });
  const body = JSON.stringify(u.includes('meshmap') ? meshmap() : meshcoreMap());
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
};
