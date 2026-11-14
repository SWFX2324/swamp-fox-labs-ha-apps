'use strict';
// The only way out to the aircraft feed. Every browser tab and every Home
// Assistant user shares one Provider, so they share one request budget:
//
// - Only fixed adsb.fi paths built from validated values. No caller ever
//   supplies a URL.
// - Answers are cached for a few seconds, and identical requests that arrive
//   while one is already on its way wait for that one instead of sending
//   another. A second person watching the same flight costs nothing extra.
// - Requests to adsb.fi are spaced at least MIN_GAP_MS apart. A request that
//   arrives inside the gap waits its turn; it is never refused as "rate limited".
// - A 429 from adsb.fi starts a cooldown for everyone, as long as its
//   Retry-After says (seconds or an HTTP date), saved to disk so a restart
//   doesn't forget it. Feed failures back off for a short while instead of
//   looping.
// - Errors carry retry_after_seconds, so the browser schedules from a number
//   rather than parsing a message.

const fs = require('fs');

const BASE = 'https://opendata.adsb.fi/api/';
const KINDS = ['area', 'callsign', 'registration', 'hex'];
const CACHE_MS = 12_000;
const MIN_GAP_MS = 1_100;
const TIMEOUT_MS = 15_000;
const FAILURE_BACKOFF_S = 30;
const DEFAULT_RETRY_S = 60;
const MAX_RETRY_S = 6 * 3600;   // sanity bound for a nonsensical header, well above any real limit
const MAX_QUEUE = 24;           // distinct lookups waiting for a slot

class ProviderError extends Error {
  constructor(code, message, status, retryAfter) {
    super(message);
    this.code = code;
    this.status = status;
    if (retryAfter != null) this.retryAfter = Math.max(1, Math.ceil(retryAfter));
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.retryAfter != null && { retry_after_seconds: this.retryAfter }) } };
  }
}

const num = (v, fallback) => (v === undefined || v === null || v === '' ? fallback : Number(v));

// Returns the adsb.fi path for a request, or throws invalid_search.
function buildPath(params) {
  const p = params && typeof params === 'object' ? params : {};
  const kind = p.kind === undefined ? 'area' : p.kind;
  if (!KINDS.includes(kind)) throw new ProviderError('invalid_search', 'Unknown search type.', 400);
  if (kind === 'area') {
    const lat = num(p.latitude, 34.0), lon = num(p.longitude, -117.0), radius = num(p.radius, 100);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new ProviderError('invalid_search', 'That map position is out of range.', 400);
    }
    if (!Number.isFinite(radius) || radius < 5 || radius > 250) {
      throw new ProviderError('invalid_search', 'Choose a radius from 5 to 250 NM.', 400);
    }
    return `v3/lat/${lat.toFixed(2)}/lon/${lon.toFixed(2)}/dist/${Math.round(radius)}`;
  }
  const value = String(p.value ?? '').trim().toUpperCase();
  const ok = kind === 'hex' ? /^[0-9A-F]{6}$/.test(value) : /^[A-Z0-9-]{2,12}$/.test(value);
  if (!ok) throw new ProviderError('invalid_search', 'Enter an exact callsign, registration, or six-digit ICAO hex.', 400);
  return `v2/${kind}/${value}`;
}

// Retry-After is either delay-seconds or an HTTP date. Returns seconds, or null.
function parseRetryAfter(header, nowMs) {
  if (header == null) return null;
  const text = String(header).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Math.min(MAX_RETRY_S, Math.max(1, Number(text)));
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  return Math.min(MAX_RETRY_S, Math.max(1, Math.ceil((at - nowMs) / 1000)));
}

class Provider {
  constructor({ fetch = globalThis.fetch, now = Date.now, sleep, stateFile = null, userAgent = 'HomeAssistant-ADSBTracker (personal use)', log = console } = {}) {
    this.fetch = fetch;
    this.now = now;
    this.sleep = sleep || (ms => new Promise(r => setTimeout(r, ms)));
    this.stateFile = stateFile;
    this.userAgent = userAgent;
    this.log = log;
    this.cache = new Map();      // path -> { at, result }
    this.inflight = new Map();   // path -> Promise
    this.nextSlot = 0;           // earliest time the next upstream request may leave
    this.cooldownUntil = 0;      // epoch ms; a 429 from adsb.fi
    this.cooldownReason = '';
    this.backoffUntil = 0;       // epoch ms; after a failure, shorter, not persisted
    this.waiting = 0;
    this.stats = { upstream: 0, cacheHits: 0, coalesced: 0, rateLimited: 0, failures: 0 };
    this.loadState();
  }

  loadState() {
    if (!this.stateFile) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      const until = Date.parse(saved.cooldown_until);
      if (Number.isFinite(until) && until > this.now()) {
        this.cooldownUntil = until;
        this.cooldownReason = 'rate_limited';
        this.log.log?.(`[feed] adsb.fi cooldown restored: ${Math.ceil((until - this.now()) / 1000)} s left`);
      }
    } catch { /* first start, or nothing saved */ }
  }

  saveState() {
    if (!this.stateFile) return;
    try {
      const body = this.cooldownUntil > this.now() ? { cooldown_until: new Date(this.cooldownUntil).toISOString() } : {};
      fs.writeFileSync(this.stateFile, JSON.stringify(body));
    } catch (e) { this.log.warn?.('[feed] could not save cooldown:', e.message); }
  }

  // Seconds until any request may go upstream, and why. 0 when free.
  blocked() {
    const now = this.now();
    if (this.cooldownUntil > now) return { seconds: Math.ceil((this.cooldownUntil - now) / 1000), code: 'rate_limited' };
    if (this.backoffUntil > now) return { seconds: Math.ceil((this.backoffUntil - now) / 1000), code: 'feed_unavailable' };
    return { seconds: 0, code: null };
  }

  status() {
    const b = this.blocked();
    return { cooldown_seconds: b.code === 'rate_limited' ? b.seconds : 0, backoff_seconds: b.code === 'feed_unavailable' ? b.seconds : 0, cached: this.cache.size, waiting: this.waiting, ...this.stats };
  }

  async query(params) {
    const path = buildPath(params);
    const now = this.now();
    const hit = this.cache.get(path);
    if (hit && now - hit.at < CACHE_MS) { this.stats.cacheHits++; return hit.result; }
    const pending = this.inflight.get(path);
    if (pending) { this.stats.coalesced++; return pending; }
    this.throwIfBlocked();
    if (this.waiting >= MAX_QUEUE) throw new ProviderError('busy', 'Too many lookups at once. Try again in a few seconds.', 503, 5);
    const job = this.fetchPath(path).finally(() => this.inflight.delete(path));
    this.inflight.set(path, job);
    return job;
  }

  throwIfBlocked() {
    const b = this.blocked();
    if (b.code === 'rate_limited') throw new ProviderError('rate_limited', 'adsb.fi asked us to slow down. Updates resume automatically.', 429, b.seconds);
    if (b.code === 'feed_unavailable') throw new ProviderError('feed_unavailable', 'The public feed is not answering. Retrying shortly.', 503, b.seconds);
  }

  async fetchPath(path) {
    // Take the next upstream slot, then wait for it.
    this.waiting++;
    try {
      const slot = Math.max(this.now(), this.nextSlot);
      this.nextSlot = slot + MIN_GAP_MS;
      const wait = slot - this.now();
      if (wait > 0) await this.sleep(wait);
    } finally { this.waiting--; }
    // A cooldown may have started while this request waited.
    this.throwIfBlocked();

    this.stats.upstream++;
    let response;
    try {
      response = await this.fetch(BASE + path, { headers: { 'User-Agent': this.userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      return this.fail(`network: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
    }
    if (response.status === 429) {
      const retry = parseRetryAfter(response.headers.get('retry-after'), this.now()) ?? DEFAULT_RETRY_S;
      this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + retry * 1000);
      this.stats.rateLimited++;
      this.saveState();
      this.log.warn?.(`[feed] adsb.fi rate limit: cooling down ${retry} s`);
      throw new ProviderError('rate_limited', 'adsb.fi asked us to slow down. Updates resume automatically.', 429, Math.ceil((this.cooldownUntil - this.now()) / 1000));
    }
    if (!response.ok) return this.fail(`HTTP ${response.status}`);
    let data;
    try { data = await response.json(); } catch { return this.fail('response was not JSON'); }
    const aircraft = data && typeof data === 'object' ? (data.ac ?? data.aircraft ?? []) : null;
    if (!Array.isArray(aircraft)) return this.fail('response had no aircraft list');
    const at = this.now();
    const result = { aircraft: aircraft.filter(a => a && typeof a === 'object'), fetched_at: at / 1000, source: 'adsb.fi' };
    for (const [key, v] of this.cache) if (at - v.at > 120_000) this.cache.delete(key);
    this.cache.set(path, { at, result });
    return result;
  }

  fail(why) {
    this.stats.failures++;
    this.backoffUntil = Math.max(this.backoffUntil, this.now() + FAILURE_BACKOFF_S * 1000);
    this.log.warn?.(`[feed] adsb.fi unavailable (${why}); backing off ${FAILURE_BACKOFF_S} s`);
    throw new ProviderError('feed_unavailable', 'The public feed is not answering. Last received positions are kept; retrying shortly.', 502, FAILURE_BACKOFF_S);
  }
}

module.exports = { Provider, ProviderError, buildPath, parseRetryAfter, BASE, CACHE_MS, MIN_GAP_MS };
