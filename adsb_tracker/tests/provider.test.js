'use strict';
// The shared feed client: validation, caching, coalescing, pacing, Retry-After
// and cooldown. A fake adsb.fi and a fake clock; nothing touches the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Provider, buildPath, parseRetryAfter, MIN_GAP_MS, CACHE_MS } = require('../app/provider');

const quiet = { log() {}, warn() {} };

// A clock that only moves when told to, or when the provider sleeps. Sleeps
// run like real timers: concurrently, waking in order of their end time, with
// everything that was waiting on the previous one done first.
function clock(start = Date.parse('2026-11-14T12:00:00Z')) {
  const timers = [];
  let pumping = false;
  const pump = () => {
    if (pumping) return;
    pumping = true;
    setImmediate(function next() {
      if (!timers.length) { pumping = false; return; }
      timers.sort((a, b) => a.target - b.target);
      const t = timers.shift();
      c.t = Math.max(c.t, t.target);
      t.resolve();
      setImmediate(next);
    });
  };
  const c = {
    t: start,
    now: () => c.t,
    sleep: ms => new Promise(resolve => { timers.push({ target: c.t + ms, resolve }); pump(); }),
    advance: ms => { c.t += ms; },
  };
  return c;
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function fakeFeed(handler) {
  const calls = [];
  const fetch = async (url, opts) => { calls.push({ url, at: fetch.clock?.t, opts }); return handler(url, calls.length); };
  return { fetch, calls };
}

const ok = () => json(200, { ac: [{ hex: 'a12345', flight: 'AAL123 ', lat: 35.8, lon: -78.8, seen_pos: 1 }] });

test('builds only fixed, validated adsb.fi paths', () => {
  assert.equal(buildPath({ kind: 'callsign', value: ' aal123 ' }), 'v2/callsign/AAL123');
  assert.equal(buildPath({ kind: 'registration', value: 'n195uw' }), 'v2/registration/N195UW');
  assert.equal(buildPath({ kind: 'hex', value: 'a17c95' }), 'v2/hex/A17C95');
  assert.equal(buildPath({ kind: 'area', latitude: 35.123, longitude: -78.987, radius: 100 }), 'v3/lat/35.12/lon/-78.99/dist/100');
  assert.equal(buildPath({}), 'v3/lat/34.00/lon/-117.00/dist/100', 'defaults match the original contract');
  for (const bad of [
    { kind: 'hex', value: 'XYZ123' }, { kind: 'hex', value: 'a1234' }, { kind: 'callsign', value: 'A' },
    { kind: 'callsign', value: '../../etc' }, { kind: 'callsign', value: 'AAL123?x=1' }, { kind: 'registration', value: 'N1/2' },
    { kind: 'url', value: 'https://evil' }, { kind: 'area', latitude: 91 }, { kind: 'area', longitude: -181 },
    { kind: 'area', radius: 4 }, { kind: 'area', radius: 251 }, { kind: 'area', latitude: 'abc' },
  ]) {
    assert.throws(() => buildPath(bad), e => e.code === 'invalid_search' && e.status === 400, JSON.stringify(bad));
  }
});

test('parses Retry-After as seconds or an HTTP date, without inventing a minimum', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  assert.equal(parseRetryAfter('120', now), 120);
  assert.equal(parseRetryAfter('5', now), 5, 'a short provider limit is not stretched to 30 s');
  assert.equal(parseRetryAfter('Sat, 14 Nov 2026 12:01:30 GMT', now), 90);
  assert.equal(parseRetryAfter('Sat, 14 Nov 2026 11:59:00 GMT', now), 1, 'a past date still waits a moment');
  assert.equal(parseRetryAfter('7200', now), 7200, 'longer cooldowns are honoured, not capped at an hour');
  assert.equal(parseRetryAfter('soon', now), null);
  assert.equal(parseRetryAfter(null, now), null);
});

test('returns aircraft with the fetch time, and keeps that time on cache hits', async () => {
  const c = clock();
  const feed = fakeFeed(ok);
  const p = new Provider({ fetch: feed.fetch, now: c.now, sleep: c.sleep, log: quiet });
  const first = await p.query({ kind: 'hex', value: 'a12345' });
  assert.equal(first.source, 'adsb.fi');
  assert.equal(first.aircraft[0].flight, 'AAL123 ', 'telemetry is passed through untouched');
  assert.equal(first.fetched_at, c.t / 1000);
  c.advance(CACHE_MS - 1000);
  const again = await p.query({ kind: 'hex', value: 'A12345' });
  assert.equal(feed.calls.length, 1, 'served from cache');
  assert.equal(again.fetched_at, first.fetched_at, 'cached data must not look newly received');
  c.advance(2000);
  await p.query({ kind: 'hex', value: 'a12345' });
  assert.equal(feed.calls.length, 2, 'cache expires');
  assert.match(feed.calls[0].url, /^https:\/\/opendata\.adsb\.fi\/api\/v2\/hex\/A12345$/);
  assert.match(feed.calls[0].opts.headers['User-Agent'], /ADSBTracker/);
});

test('accepts the older "aircraft" field and rejects malformed responses', async () => {
  const c = clock();
  const bodies = [{ aircraft: [{ hex: 'a1' }] }, { ac: 'nope' }];
  let i = 0;
  const p = new Provider({ fetch: async () => json(200, bodies[i++]), now: c.now, sleep: c.sleep, log: quiet });
  assert.equal((await p.query({ kind: 'callsign', value: 'ABC1' })).aircraft.length, 1);
  await assert.rejects(p.query({ kind: 'callsign', value: 'ABC2' }), e => e.code === 'feed_unavailable' && e.retryAfter === 30);
  const p2 = new Provider({ fetch: async () => new Response('<html>', { status: 200 }), now: c.now, sleep: c.sleep, log: quiet });
  await assert.rejects(p2.query({ kind: 'callsign', value: 'ABC3' }), e => e.code === 'feed_unavailable');
});

test('identical requests in flight share one upstream fetch', async () => {
  const c = clock();
  let release;
  const gate = new Promise(r => { release = r; });
  let calls = 0;
  const p = new Provider({ fetch: async () => { calls++; await gate; return ok(); }, now: c.now, sleep: c.sleep, log: quiet });
  const viewers = Array.from({ length: 10 }, () => p.query({ kind: 'callsign', value: 'AAL123' }));
  await new Promise(r => setImmediate(r));
  release();
  const results = await Promise.all(viewers);
  assert.equal(calls, 1, 'ten viewers, one request');
  assert.ok(results.every(r => r === results[0]));
  assert.equal(p.stats.coalesced, 9);
});

test('different lookups are paced 1.1 s apart instead of being refused', async () => {
  const c = clock();
  const feed = fakeFeed(ok);
  feed.fetch.clock = c;
  const p = new Provider({ fetch: feed.fetch, now: c.now, sleep: c.sleep, log: quiet });
  const start = c.t;
  const results = await Promise.all(['AAL1', 'AAL2', 'AAL3', 'AAL4'].map(v => p.query({ kind: 'callsign', value: v })));
  assert.equal(results.length, 4, 'nobody was told "rate limited"');
  assert.equal(feed.calls.length, 4);
  const gaps = feed.calls.map(x => x.at - start);
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] - gaps[i - 1] >= MIN_GAP_MS, `gap ${i}: ${gaps[i] - gaps[i - 1]} ms`);
});

test('concurrent clients stay within one request per second over time', async () => {
  const c = clock();
  const feed = fakeFeed(ok);
  feed.fetch.clock = c;
  const p = new Provider({ fetch: feed.fetch, now: c.now, sleep: c.sleep, log: quiet });
  // Five browsers each polling their own flight every 15 s, plus three watching the same one, for 5 minutes.
  for (let t = 0; t < 300; t += 15) {
    const batch = [];
    for (let b = 0; b < 5; b++) batch.push(p.query({ kind: 'hex', value: `a0000${b}` }));
    for (let b = 0; b < 3; b++) batch.push(p.query({ kind: 'hex', value: 'a12345' }));
    await Promise.all(batch);
    c.advance(15_000);
  }
  const span = (feed.calls.at(-1).at - feed.calls[0].at) / 1000;
  assert.equal(feed.calls.length, 20 * 6, 'six distinct lookups per round');
  assert.ok(feed.calls.length / span <= 1, `${feed.calls.length} requests in ${span} s`);
});

test('a 429 starts a shared cooldown for exactly as long as adsb.fi asks', async () => {
  const c = clock();
  let limited = true;
  const feed = fakeFeed(() => (limited ? json(429, {}, { 'Retry-After': '120' }) : ok()));
  const p = new Provider({ fetch: feed.fetch, now: c.now, sleep: c.sleep, log: quiet });
  await assert.rejects(p.query({ kind: 'callsign', value: 'AAL1' }), e => e.code === 'rate_limited' && e.status === 429 && e.retryAfter === 120);
  limited = false;
  c.advance(30_000);
  // Another viewer, another flight: still cooling down, with the time left.
  await assert.rejects(p.query({ kind: 'hex', value: 'abcdef' }), e => e.code === 'rate_limited' && e.retryAfter === 90);
  assert.equal(feed.calls.length, 1, 'nothing went upstream during the cooldown');
  assert.equal(p.status().cooldown_seconds, 90);
  c.advance(90_000);
  await p.query({ kind: 'hex', value: 'abcdef' });
  assert.equal(feed.calls.length, 2, 'resumes after the cooldown');
});

test('an HTTP-date Retry-After works the same way', async () => {
  const c = clock();
  const until = new Date(c.t + 45_000).toUTCString();
  const p = new Provider({ fetch: async () => json(429, {}, { 'Retry-After': until }), now: c.now, sleep: c.sleep, log: quiet });
  await assert.rejects(p.query({ kind: 'callsign', value: 'AAL1' }), e => e.retryAfter === 45);
});

test('a 429 without Retry-After cools down 60 s', async () => {
  const c = clock();
  const p = new Provider({ fetch: async () => json(429, {}), now: c.now, sleep: c.sleep, log: quiet });
  await assert.rejects(p.query({ kind: 'callsign', value: 'AAL1' }), e => e.retryAfter === 60);
});

test('requests already waiting for a slot do not go out once a cooldown starts', async () => {
  const c = clock();
  const feed = fakeFeed((url, n) => (n === 1 ? json(429, {}, { 'Retry-After': '300' }) : ok()));
  const p = new Provider({ fetch: feed.fetch, now: c.now, sleep: c.sleep, log: quiet });
  const all = await Promise.allSettled(['AAL1', 'AAL2', 'AAL3'].map(v => p.query({ kind: 'callsign', value: v })));
  assert.equal(feed.calls.length, 1);
  assert.ok(all.every(r => r.status === 'rejected' && r.reason.code === 'rate_limited'));
});

test('the cooldown survives a restart, and an expired one is ignored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adsb-prov-'));
  const stateFile = path.join(dir, 'feed-state.json');
  const c = clock();
  const p = new Provider({ fetch: async () => json(429, {}, { 'Retry-After': '600' }), now: c.now, sleep: c.sleep, stateFile, log: quiet });
  await assert.rejects(p.query({ kind: 'callsign', value: 'AAL1' }));
  assert.ok(fs.existsSync(stateFile));
  c.advance(100_000);
  let calls = 0;
  const restarted = new Provider({ fetch: async () => { calls++; return ok(); }, now: c.now, sleep: c.sleep, stateFile, log: quiet });
  await assert.rejects(restarted.query({ kind: 'callsign', value: 'AAL1' }), e => e.code === 'rate_limited' && e.retryAfter === 500);
  assert.equal(calls, 0);
  c.advance(600_000);
  const later = new Provider({ fetch: async () => { calls++; return ok(); }, now: c.now, sleep: c.sleep, stateFile, log: quiet });
  await later.query({ kind: 'callsign', value: 'AAL1' });
  assert.equal(calls, 1);
});

test('timeouts, network errors and server errors back off 30 s instead of looping', async () => {
  for (const failure of [
    async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); },
    async () => { throw new TypeError('fetch failed'); },
    async () => new Response('bad gateway', { status: 502 }),
  ]) {
    const c = clock();
    let calls = 0;
    const p = new Provider({ fetch: async (...a) => { calls++; return failure(...a); }, now: c.now, sleep: c.sleep, log: quiet });
    await assert.rejects(p.query({ kind: 'hex', value: 'a12345' }), e => e.code === 'feed_unavailable' && e.retryAfter === 30);
    c.advance(10_000);
    await assert.rejects(p.query({ kind: 'hex', value: 'a12345' }), e => e.code === 'feed_unavailable' && e.retryAfter === 20);
    assert.equal(calls, 1, 'no retry during the back-off');
    c.advance(20_000);
    await assert.rejects(p.query({ kind: 'hex', value: 'a12345' }));
    assert.equal(calls, 2);
  }
});

test('invalid searches never reach adsb.fi', async () => {
  let calls = 0;
  const p = new Provider({ fetch: async () => { calls++; return ok(); }, log: quiet });
  for (let i = 0; i < 5; i++) await assert.rejects(p.query({ kind: 'hex', value: 'nothex' }), e => e.code === 'invalid_search');
  assert.equal(calls, 0);
});

test('error bodies carry a structured retry time', async () => {
  const c = clock();
  const p = new Provider({ fetch: async () => json(429, {}, { 'Retry-After': '75' }), now: c.now, sleep: c.sleep, log: quiet });
  const err = await p.query({ kind: 'callsign', value: 'AAL1' }).catch(e => e);
  assert.deepEqual(err.toJSON(), { error: { code: 'rate_limited', message: err.message, retry_after_seconds: 75 } });
});
