'use strict';
// The page's tracking logic (app/static/tracker.js) with a fake transport,
// storage and clock. Carries forward the original 1.1.1 behaviour tests and
// adds the flight-ended rules and structured cooldowns.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { TrackerCore, normalizeSearch, WATCH_KEY, COOLDOWN_KEY } = require('../app/static/tracker.js');

function memoryStorage() {
  const m = new Map();
  return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}

// One browser: a clock, storage, zoom level and a fake feed.
function browser({ storage = memoryStorage(), clock = { t: Date.parse('2026-11-14T15:00:00Z') }, zoom = 8 } = {}) {
  const env = { storage, clock, zoom, calls: [], next: [], hidden: false };
  env.feed = async q => {
    env.calls.push(q);
    const r = env.next.length > 1 ? env.next.shift() : env.next[0];
    if (r instanceof Error || r?.code) throw r;
    return { aircraft: r ?? [], fetched_at: env.clock.t / 1000, source: 'adsb.fi' };
  };
  env.make = () => new TrackerCore({ transport: env.feed, storage, now: () => clock.t, sleep: async ms => { clock.t += ms; }, zoom: () => env.zoom, hidden: () => env.hidden });
  env.tick = s => { clock.t += s * 1000; };
  return env;
}

const plane = (lat, lon, extra = {}) => ({ hex: 'a12345', flight: 'AAL123  ', r: 'N123AA', t: 'A321', lat, lon, seen_pos: 0, alt_baro: 35000, gs: 450, track: 270, ...extra });
const settle = () => new Promise(r => setImmediate(r));

test('flight numbers become broadcast callsigns; bad input never reaches the feed', () => {
  assert.deepEqual(normalizeSearch('flight', 'aa 0123'), { kind: 'callsign', value: 'AAL123', note: 'AA0123 broadcasts as AAL123' });
  assert.equal(normalizeSearch('flight', 'UA456').value, 'UAL456');
  assert.equal(normalizeSearch('flight', 'OO5123').value, 'SKW5123');
  assert.equal(normalizeSearch('flight', '9E3301').value, 'EDV3301');
  assert.equal(normalizeSearch('flight', 'AAL123').value, 'AAL123', 'a callsign typed as a flight number is kept');
  assert.equal(normalizeSearch('registration', 'n-195uw').value, 'N195UW');
  assert.ok(normalizeSearch('hex', 'XYZ123').error);
  assert.ok(normalizeSearch('callsign', 'A').error);
  const b = browser();
  const t = b.make();
  t.search('hex', 'nothex');
  assert.equal(b.calls.length, 0);
  assert.match(t.status().text, /six characters/);
});

test('one match locks on, isolates, follows, and never falls back to an area scan', async () => {
  const b = browser();
  const t = b.make();
  b.next = [[plane(35.8, -78.8)]];
  t.search('flight', 'AA123');
  await settle();
  assert.deepEqual(b.calls[0], { kind: 'callsign', value: 'AAL123' });
  assert.equal(t.mode, 'tracking');
  assert.ok(t.isolated && t.follow);
  assert.equal(t.tracked.flightLock, 'AAL123');
  // Cross-country: the aircraft leaves any original area; only its hex is asked for.
  for (const [lat, lon] of [[36.1, -86.7], [35.0, -101.8], [34.0, -118.0]]) {
    b.tick(16); b.next = [[plane(lat, lon)]];
    await t.refresh();
  }
  assert.equal(t.selected.lon, -118.0);
  assert.ok(b.calls.slice(1).every(q => q.kind === 'hex' && q.value === 'a12345'), JSON.stringify(b.calls));
  assert.equal(t.trails.get('a12345').length, 4);
  assert.match(t.status().text, /Tracking AAL123 worldwide/);
});

test('signal loss keeps the target, and the same aircraft resumes', async () => {
  const b = browser();
  const t = b.make();
  b.next = [[plane(35.8, -78.8)]];
  t.search('callsign', 'AAL123');
  await settle();
  b.tick(16); b.next = [[]];
  await t.refresh();
  assert.equal(t.mode, 'tracking');
  assert.equal(t.selected.hex, 'a12345', 'signal loss must retain the target');
  b.tick(130);
  assert.equal(t.isLive(t.selected), false, 'an old position is not shown as live');
  assert.equal(t.phase().key, 'lost');
  assert.match(t.status().text, /isn’t live/);
  b.next = [[plane(34.5, -112)]];
  await t.refresh();
  assert.equal(t.selected.lon, -112, 'tracking recovers the same aircraft');
  assert.equal(t.phase().key, 'cruise');
});

test('the tracked flight and its trail survive reopening; Stop clears them', async () => {
  const b = browser();
  const t = b.make();
  b.next = [[plane(35.8, -78.8)]];
  t.search('flight', 'AA123');
  await settle();
  b.tick(16); b.next = [[plane(35.2, -90)]];
  await t.refresh();
  b.tick(60);
  const reopened = b.make();
  assert.equal(reopened.mode, 'tracking');
  assert.equal(reopened.lookup.value, 'a12345');
  assert.ok(reopened.isolated && reopened.follow);
  assert.equal(reopened.selected.lon, -90);
  assert.equal(reopened.trails.get('a12345').length, 2);
  assert.equal(reopened.tracked.flightLock, 'AAL123');
  assert.match(reopened.status().text, /Resumed tracking/);
  reopened.stop();
  assert.equal(b.storage.getItem(WATCH_KEY), null);
  assert.equal(b.make().mode, 'idle');
});

test('a saved flight older than 12 hours is not resumed; 1.1.x saves are dropped', () => {
  const b = browser();
  b.storage.setItem(WATCH_KEY, JSON.stringify({ hex: 'a12345', label: 'AAL123', savedAt: b.clock.t - 13 * 3600e3 }));
  b.storage.setItem('adsb-watched-flight-v1', JSON.stringify({ hex: 'a12345', label: 'AAL123' }));
  const t = b.make();
  assert.equal(t.mode, 'idle');
  assert.match(t.status().text, /more than 12 hours old/);
  assert.equal(b.storage.getItem(WATCH_KEY), null);
  assert.equal(b.storage.getItem('adsb-watched-flight-v1'), null);
});

test('a new flight number on the same aircraft ends tracking instead of following the next trip', async () => {
  const b = browser();
  const t = b.make();
  b.next = [[plane(35.8, -78.8)]];
  t.search('flight', 'AA123');
  await settle();
  b.tick(16); b.next = [[plane(33.9, -118.4, { flight: 'AAL2001 ' })]];
  await t.refresh();
  assert.equal(t.mode, 'ended');
  assert.equal(t.ended.reason, 'callsign');
  assert.equal(t.ended.newCallsign, 'AAL2001');
  assert.match(t.status().text, /now flying AAL2001, so AAL123 has most likely landed/);
  assert.equal(b.storage.getItem(WATCH_KEY), null);
  const count = b.calls.length;
  b.tick(120);
  await t.refresh(true);
  assert.equal(b.calls.length, count, 'no polling after the flight ended');
  // The user can choose to follow the airframe on its next leg.
  t.keepFollowing();
  await settle();
  assert.equal(t.mode, 'tracking');
  assert.equal(t.tracked.flightLock, null);
});

test('an empty callsign (transponder glitch) does not end tracking', async () => {
  const b = browser();
  const t = b.make();
  b.next = [[plane(35.8, -78.8)]];
  t.search('flight', 'AA123');
  await settle();
  b.tick(16); b.next = [[plane(35.7, -80, { flight: '' })]];
  await t.refresh();
  assert.equal(t.mode, 'tracking');
});

test('tracking by registration follows the airframe across flight numbers', async () => {
  const b = browser();
  const t = b.make();
  b.next = [[plane(35.8, -78.8)]];
  t.search('registration', 'N123AA');
  await settle();
  assert.equal(t.tracked.flightLock, null);
  b.tick(16); b.next = [[plane(35.7, -80, { flight: 'AAL999' })]];
  await t.refresh();
  assert.equal(t.mode, 'tracking');
});

test('landing ends tracking after 15 minutes on the ground; waiting at the gate does not', async () => {
  const b = browser();
  const t = b.make();
  b.next = [[plane(35.877, -78.787, { alt_baro: 'ground', gs: 0 })]];
  t.search('flight', 'AA123');
  await settle();
  assert.equal(t.phase().key, 'ground');
  assert.match(t.status().text, /on the ground. Checking every minute until it departs/);
  assert.equal(t.pollIntervalMs(), 60000, 'slow polling at the gate');
  b.tick(40 * 60); await t.refresh();
  assert.equal(t.mode, 'tracking', 'an hour at the gate before departure is fine');
  b.tick(61); b.next = [[plane(36, -80)]]; await t.refresh();
  assert.ok(t.tracked.airborne);
  b.tick(61); b.next = [[plane(33.94, -118.4, { alt_baro: 'ground', gs: 20 })]]; await t.refresh();
  assert.equal(t.phase().text, 'Landed');
  b.tick(14 * 60); await t.refresh();
  assert.equal(t.mode, 'tracking');
  b.tick(61); await t.refresh();
  assert.equal(t.mode, 'ended');
  assert.equal(t.ended.reason, 'landed');
  assert.match(t.status().text, /AAL123 landed/);
});

test('two hours without a position ends tracking', async () => {
  const b = browser();
  const t = b.make();
  b.next = [[plane(35.8, -78.8)]];
  t.search('flight', 'AA123');
  await settle();
  b.next = [[]];
  for (let i = 0; i < 125; i++) { b.tick(61); await t.refresh(); }
  assert.equal(t.mode, 'ended');
  assert.equal(t.ended.reason, 'lost');
});

test('several matches are listed for the user to choose; none matched keeps checking each minute', async () => {
  const b = browser();
  const t = b.make();
  b.next = [[plane(35, -80), { ...plane(40, -100), hex: 'b22222' }]];
  t.search('callsign', 'AAL123');
  await settle();
  assert.equal(t.mode, 'lookup');
  assert.match(t.status().text, /2 aircraft match AAL123/);
  t.select(t.aircraft[1]);
  t.track(t.selected);
  await settle();
  assert.equal(t.tracked.hex, 'b22222');

  const b2 = browser();
  const u = b2.make();
  b2.next = [[]];
  u.search('flight', 'DL789');
  await settle();
  assert.match(u.status().text, /DL789 broadcasts as DAL789\. DAL789 isn’t in the air yet/);
  b2.tick(30); await u.refresh();
  assert.equal(b2.calls.length, 1, 'not before a minute');
  b2.tick(31); await u.refresh();
  assert.equal(b2.calls.length, 2);
});

test('the US map and its presets make zero aircraft requests, even when forced', async () => {
  const b = browser();
  const t = b.make();
  for (let i = 0; i < 20; i++) { b.tick(10); await t.refresh(true); }
  t.overview();
  await t.refresh(true);
  assert.equal(b.calls.length, 0);
  assert.equal(t.feed().state, 'off');
});

test('presets move the map without stopping a tracked flight', async () => {
  const b = browser();
  const t = b.make();
  b.next = [[plane(35.8, -78.8)]];
  t.search('flight', 'AA123');
  await settle();
  t.overview();
  assert.equal(t.mode, 'tracking');
  assert.equal(t.follow, false, 'the map moved away, so it stops following');
  assert.ok(b.storage.getItem(WATCH_KEY));
});

test('polling: 15 s focused, 60 s zoomed out, none while paused or hidden', async () => {
  const b = browser({ zoom: 4 });
  const t = b.make();
  b.next = [[plane(35.8, -78.8)]];
  t.search('flight', 'AA123');
  await settle();
  const n = b.calls.length;
  b.tick(30); await t.refresh();
  assert.equal(b.calls.length, n, 'zoomed out waits 60 s');
  b.tick(31); await t.refresh();
  assert.equal(b.calls.length, n + 1);
  b.zoom = 8;
  b.tick(16); await t.refresh();
  assert.equal(b.calls.length, n + 2, 'focused refreshes after 15 s');
  t.setPaused(true);
  b.tick(100); await t.refresh(true);
  assert.equal(b.calls.length, n + 2, 'pause stops requests');
  t.setPaused(false); await settle();
  assert.equal(b.calls.length, n + 3, 'resume asks once');
  b.hidden = true;
  b.tick(100); await t.refresh(true);
  assert.equal(b.calls.length, n + 3, 'a hidden page asks nothing');
});

test('area scans: 60 s focused, 180 s zoomed out', async () => {
  const b = browser({ zoom: 8 });
  const t = b.make();
  b.next = [[plane(35, -80), { ...plane(35.1, -80.1), hex: 'b22222' }]];
  t.scanArea({ latitude: 35, longitude: -80, radius: 100 });
  await settle();
  assert.equal(b.calls[0].kind, 'area');
  assert.equal(t.mode, 'area', 'an area scan never auto-tracks');
  b.tick(61); await t.refresh();
  assert.equal(b.calls.length, 2);
  b.zoom = 5;
  b.tick(120); await t.refresh();
  assert.equal(b.calls.length, 2);
  b.tick(61); await t.refresh();
  assert.equal(b.calls.length, 3);
});

test('a structured cooldown holds across forced refreshes, new searches, Stop and reopening', async () => {
  const b = browser();
  const t = b.make();
  b.next = [[plane(35.8, -78.8)]];
  t.search('flight', 'AA123');
  await settle();
  b.tick(16); b.next = [{ code: 'rate_limited', message: 'adsb.fi asked us to slow down.', retry_after_seconds: 120 }];
  await t.refresh();
  assert.equal(t.mode, 'tracking', 'the flight stays locked while throttled');
  const left = t.cooldownUntil() - b.clock.t;
  assert.equal(left, 120000, 'scheduled from retry_after_seconds, not from message text');
  assert.match(t.feed().text, /cooldown · 2m 00s/);
  assert.match(t.status().text, /Still locked on AAL123/);
  const n = b.calls.length;
  b.next = [[plane(35.8, -78.8)]];
  await t.refresh(true);
  t.setPaused(true); t.setPaused(false);
  t.search('flight', 'UA456');
  await settle();
  t.stop();
  assert.ok(b.storage.getItem(COOLDOWN_KEY), 'stop cannot clear the cooldown');
  const reopened = b.make();
  reopened.search('callsign', 'DAL1');
  await settle();
  assert.equal(b.calls.length, n, 'nothing during the cooldown');
  b.tick(121);
  await reopened.refresh(true);
  assert.equal(b.calls.length, n + 1, 'resumes after it');
});

test('feed failures back off for the time the app gives', async () => {
  const b = browser();
  const t = b.make();
  b.next = [{ code: 'feed_unavailable', message: 'The public feed is not answering.', retry_after_seconds: 30 }];
  t.search('flight', 'AA123');
  await settle();
  assert.equal(t.cooldownUntil() - b.clock.t, 30000);
  assert.equal(b.storage.getItem(COOLDOWN_KEY), null, 'only real rate limits are shared across tabs');
  assert.equal(t.feed().state, 'warn');
});

test('a newer search replaces one in flight; stale answers are dropped', async () => {
  const b = browser();
  const t = b.make();
  let release;
  const slow = new Promise(r => { release = r; });
  const calls = [];
  t.transport = async q => { calls.push(q); if (calls.length === 1) { await slow; return { aircraft: [plane(1, 1)], fetched_at: b.clock.t / 1000 }; } return { aircraft: [], fetched_at: b.clock.t / 1000 }; };
  t.search('flight', 'AA123');
  await settle();
  b.tick(6);
  t.search('flight', 'UA456');
  release();
  await settle(); await settle();
  assert.equal(t.lookup.value, 'UAL456');
  assert.equal(t.mode, 'lookup', 'the old answer did not lock onto AAL123');
  assert.deepEqual(calls.map(q => q.value), ['AAL123', 'UAL456']);
});

test('trail statistics measure distance along observed positions', async () => {
  const b = browser();
  const t = b.make();
  b.next = [[plane(35.877, -78.787)]];
  t.search('flight', 'AA123');
  await settle();
  b.tick(16); b.next = [[plane(33.942, -118.408)]];
  await t.refresh();
  const s = t.trailStats();
  assert.ok(Math.abs(s.miles - 2230) < 30, `RDU to LAX is about 2,230 mi, got ${s.miles}`);
});

test('the frontend has no Home Assistant dependencies and only relative URLs', () => {
  const dir = path.join(__dirname, '../app/static');
  for (const f of ['tracker.js', 'app.js', 'index.html']) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/hass\.|callWS|hass-toggle-menu|home-assistant-main/.test(src), `${f} reaches into Home Assistant`);
    assert.ok(!/unpkg\.com|jsdelivr|cdnjs/.test(src), `${f} loads from a CDN`);
    assert.ok(!/(?:src|href)="\/|fetch\('\//.test(src), `${f} has a root-relative URL that breaks under ingress`);
    assert.ok(!/nationalScan|nationalPoints/.test(src), 'the retired nationwide sweep must not return');
  }
});

test('the backend has no Home Assistant Core imports', () => {
  for (const f of ['server.js', 'provider.js']) {
    const src = fs.readFileSync(path.join(__dirname, '../app', f), 'utf8');
    assert.ok(!/homeassistant|websocket_api|panel_custom|SUPERVISOR_TOKEN/.test(src), f);
    const requires = [...src.matchAll(/require\('([^']+)'\)/g)].map(m => m[1]);
    assert.deepEqual(requires.filter(r => !r.startsWith('./') && !['fs', 'http', 'path', 'zlib'].includes(r)), [], 'Node built-ins only');
  }
});
