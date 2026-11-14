/* ADS-B Tracker: what to fetch, when, and what it means. No DOM or map code
 * lives here (app.js draws), so the tests run it in Node with a fake
 * transport and clock.
 *
 * Request budget (the reason this file exists):
 *   US map / presets ............ no aircraft requests at all
 *   Tracking, map zoomed in ..... every 15 s
 *   Tracking, zoom 5 or less .... every 60 s (also while on the ground)
 *   Flight not found yet ........ every 60 s
 *   Scanned area ................ every 60 s, or 180 s at zoom 5 or less
 *   Paused or hidden ............ none
 * Plus a 5 s minimum gap between requests from this page, and the feed's
 * cooldown, which nothing (new search, refresh, reload) can skip.
 */
(function (root) {
  'use strict';

  const WATCH_KEY = 'adsb-watched-flight-v2';
  const OLD_WATCH_KEY = 'adsb-watched-flight-v1';
  const COOLDOWN_KEY = 'adsb-feed-cooldown-v1';
  const MAX_TRAIL = 2400;
  const POSITION_MAX_AGE_S = 120;
  const MIN_GAP_MS = 5000;
  const RESTORE_MAX_AGE_MS = 12 * 3600e3;   // a saved flight older than this isn't resumed
  const LANDED_AFTER_MS = 15 * 60e3;        // on the ground this long after flying = landed
  const LOST_AFTER_MS = 2 * 3600e3;         // no position this long = give up

  // Ticket prefixes (IATA) to the callsign prefixes (ICAO) aircraft broadcast.
  const AIRLINES = {
    AA: 'AAL', UA: 'UAL', DL: 'DAL', WN: 'SWA', AS: 'ASA', B6: 'JBU', F9: 'FFT', NK: 'NKS', G4: 'AAY',
    HA: 'HAL', SY: 'SCX', MX: 'MXY', XP: 'VXP', AC: 'ACA', WS: 'WJA', AM: 'AMX', BA: 'BAW', LH: 'DLH',
    AF: 'AFR', KL: 'KLM', QF: 'QFA', NH: 'ANA', JL: 'JAL', EK: 'UAE', QR: 'QTR', VS: 'VIR', EI: 'EIN',
    OO: 'SKW', YX: 'RPA', MQ: 'ENY', OH: 'JIA', '9E': 'EDV', YV: 'ASH', QX: 'QXE', PT: 'PDT', ZW: 'AWI', C5: 'UCA',
  };
  const KIND_NAMES = { flight: 'flight number', callsign: 'callsign', registration: 'registration', hex: 'ICAO hex' };

  const hasPosition = a => !!a && Number.isFinite(a.lat) && Number.isFinite(a.lon) && Math.abs(a.lat) <= 90 && Math.abs(a.lon) <= 180;
  const callsignOf = a => String(a?.flight || '').trim().toUpperCase();
  const ident = a => callsignOf(a) || a?.r || String(a?.hex || '').toUpperCase();
  const onGround = a => a?.alt_baro === 'ground';
  const validHex = h => /^[0-9a-f]{6}$/i.test(String(h || ''));

  // Turns what was typed into a feed lookup, or an error message.
  function normalizeSearch(kind, raw) {
    let value = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
    let resolved = kind;
    let note = '';
    if (kind === 'flight') {
      resolved = 'callsign';
      const m = value.match(/^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/);
      if (m && AIRLINES[m[1]]) {
        const callsign = AIRLINES[m[1]] + m[2].replace(/^0+(?=\d)/, '');
        if (callsign !== value) note = `${value} broadcasts as ${callsign}`;
        value = callsign;
      }
    }
    if (kind === 'registration') value = value.replace(/^(N)-/, '$1');
    const ok = resolved === 'hex' ? /^[0-9A-F]{6}$/.test(value) : /^[A-Z0-9-]{2,12}$/.test(value);
    if (!ok) return { error: resolved === 'hex' ? 'An ICAO hex code is six characters, 0–9 and A–F.' : 'Enter a flight number like AA1920, a callsign, a registration like N195UW, or a six-character ICAO hex.' };
    return { kind: resolved, value, note };
  }

  function haversineMi(a, b) {
    const R = 3958.8, rad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  class TrackerCore {
    constructor({ transport, storage = null, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), zoom = () => 4, hidden = () => false, onChange = () => {} } = {}) {
      this.transport = transport;
      this.sleep = sleep;
      this.storage = storage;
      this.now = now;
      this.zoom = zoom;
      this.hidden = hidden;
      this.onChange = onChange;
      this.mode = 'idle';            // idle | lookup | tracking | area | ended
      this.lookup = null;            // { kind, value } sent to the feed
      this.label = '';               // what the user typed, for messages
      this.area = { latitude: 34, longitude: -117, radius: 100 };
      this.aircraft = [];
      this.last = 0;                 // ms: when the feed fetched the current data
      this.selected = null;          // aircraft object + .received
      this.trails = new Map();       // hex -> [[lat, lon], ...] actually observed
      this.tracked = null;           // { hex, flightLock, firstSeenAt, lastSeenAt, airborne, groundSince }
      this.ended = null;             // { reason, callsign, newCallsign, at }
      this.notice = '';              // one-off message (restored, expired, invalid input)
      this.paused = false;
      this.isolated = false;
      this.follow = false;
      this.failure = null;           // { code, message }
      this.retryAt = 0;
      this.busy = false;
      this.generation = 0;
      this.lastAttemptAt = 0;
      this.nextRequestAt = 0;
      this.restore();
    }

    // ---- storage ----------------------------------------------------------
    read(key) { try { return this.storage?.getItem(key) ?? null; } catch { return null; } }
    write(key, v) { try { this.storage?.setItem(key, v); } catch { /* storage is optional */ } }
    remove(key) { try { this.storage?.removeItem(key); } catch { /* optional */ } }

    restore() {
      this.remove(OLD_WATCH_KEY);   // 1.1.x saved flights have no timestamps to judge their age by
      let saved = null;
      try { saved = JSON.parse(this.read(WATCH_KEY) || 'null'); } catch { saved = null; }
      if (!saved || !validHex(saved.hex)) return;
      const age = this.now() - (Number(saved.savedAt) || 0);
      if (age > RESTORE_MAX_AGE_MS) {
        this.remove(WATCH_KEY);
        this.notice = `Your saved flight ${saved.label || saved.hex.toUpperCase()} was more than 12 hours old, so it wasn’t resumed. Search again to track a new flight.`;
        return;
      }
      this.mode = 'tracking';
      this.lookup = { kind: 'hex', value: saved.hex.toLowerCase() };
      this.label = saved.label || saved.hex.toUpperCase();
      this.selected = saved.aircraft ? { ...saved.aircraft } : null;
      this.tracked = { hex: saved.hex.toLowerCase(), flightLock: saved.flightLock || null, firstSeenAt: saved.firstSeenAt || saved.savedAt, lastSeenAt: saved.lastSeenAt || 0, airborne: !!saved.airborne, groundSince: saved.groundSince || 0 };
      this.isolated = true;
      this.follow = true;
      if (Array.isArray(saved.trail)) this.trails.set(this.tracked.hex, saved.trail.slice(-MAX_TRAIL));
      this.notice = `Resumed tracking ${this.label}.`;
    }

    save() {
      if (this.mode !== 'tracking' || !this.tracked) return;
      this.write(WATCH_KEY, JSON.stringify({
        hex: this.tracked.hex, label: this.label, flightLock: this.tracked.flightLock, savedAt: this.now(),
        firstSeenAt: this.tracked.firstSeenAt, lastSeenAt: this.tracked.lastSeenAt, airborne: this.tracked.airborne, groundSince: this.tracked.groundSince,
        aircraft: this.selected, trail: this.trails.get(this.tracked.hex) || [],
      }));
    }

    // ---- actions ------------------------------------------------------------
    reset(mode) {
      this.remove(WATCH_KEY);
      this.mode = mode;
      this.lookup = null;
      this.selected = null;
      this.tracked = null;
      this.ended = null;
      this.isolated = false;
      this.follow = false;
      this.aircraft = [];
      this.last = 0;
      this.failure = null;
      this.notice = '';
      this.searchNote = '';
      this.trails.clear();
      this.generation++;
      this.lastAttemptAt = 0;
    }

    search(kind, raw) {
      const s = normalizeSearch(kind, raw);
      if (s.error) { this.notice = s.error; this.changed(); return s; }
      this.reset('lookup');
      this.lookup = { kind: s.kind, value: s.value };
      this.searchKind = kind;
      this.label = s.value;
      this.searchNote = s.note ? `${s.note}. ` : '';
      this.changed();
      this.refresh(true);
      return s;
    }

    scanArea(area) {
      this.reset('area');
      this.area = {
        latitude: Math.max(-85, Math.min(85, area.latitude)),
        longitude: ((area.longitude + 180) % 360 + 360) % 360 - 180,
        radius: Math.max(5, Math.min(250, Math.round(area.radius))),
      };
      this.changed();
      this.refresh(true);
    }

    // The US map and its presets. A tracked flight keeps being tracked (it is
    // one small request); a scan or an unmatched search is dropped.
    overview() {
      if (this.mode === 'tracking') { this.follow = false; this.changed(); return; }
      this.reset('idle');
      this.changed();
    }

    stop() { this.reset('idle'); this.changed(); }

    // Locks onto one aircraft by its ICAO address, worldwide.
    track(a, { flightLock } = {}) {
      if (!validHex(a?.hex)) { this.notice = 'This aircraft has no ICAO address, so it can’t be tracked worldwide. Search its callsign or registration instead.'; this.changed(); return false; }
      const hex = a.hex.toLowerCase();
      const lock = flightLock !== undefined ? flightLock : (callsignOf(a) || null);
      const trail = this.trails.get(hex) || (hasPosition(a) ? [[a.lat, a.lon]] : []);
      this.remove(WATCH_KEY);
      this.trails.clear();
      this.trails.set(hex, trail);
      this.mode = 'tracking';
      this.lookup = { kind: 'hex', value: hex };
      this.label = callsignOf(a) || a.r || hex.toUpperCase();
      this.selected = { ...a, received: a._received || this.last || this.now() };
      this.aircraft = [this.selected];
      const t = this.now();
      this.tracked = { hex, flightLock: lock, firstSeenAt: t, lastSeenAt: hasPosition(a) ? t : 0, airborne: hasPosition(a) && !onGround(a), groundSince: onGround(a) ? t : 0 };
      this.ended = null;
      this.isolated = true;
      this.follow = true;
      this.failure = null;
      this.notice = '';
      this.generation++;
      this.save();
      this.changed();
      // Data from the lookup that found it is already current: the next
      // update waits the normal interval instead of asking again at once.
      const received = a._received || a.received || 0;
      if (received && t - received < 15000) this.lastAttemptAt = t;
      else this.refresh(true);
      return true;
    }

    // After a flight ended: keep following the same airframe on its next leg.
    keepFollowing() {
      if (!this.selected) return;
      this.track(this.selected, { flightLock: null });
    }

    select(a) {
      this.selected = a ? { ...a, received: a._received || this.last } : null;
      this.changed();
    }

    setPaused(p) { this.paused = !!p; this.changed(); if (!this.paused) this.refresh(); }

    // ---- schedule -------------------------------------------------------------
    pollIntervalMs() {
      const wide = (this.zoom() ?? 4) <= 5;
      if (this.mode === 'tracking') return wide || (this.selected && onGround(this.selected)) ? 60000 : 15000;
      if (this.mode === 'lookup') return 60000;
      if (this.mode === 'area') return wide ? 180000 : 60000;
      return 0;
    }

    polling() { return ['tracking', 'lookup', 'area'].includes(this.mode); }

    cooldownUntil() { return Math.max(this.retryAt, Number(this.read(COOLDOWN_KEY)) || 0); }

    backoff(err) {
      const given = Number(err?.retry_after_seconds);
      const seconds = Number.isFinite(given) && given > 0 ? given : err?.code === 'rate_limited' ? 60 : 30;
      this.retryAt = Math.max(this.cooldownUntil(), this.now() + seconds * 1000);
      if (err?.code === 'rate_limited') this.write(COOLDOWN_KEY, String(this.retryAt));
    }

    nextUpdateIn() {
      if (!this.polling() || this.paused) return null;
      const due = Math.max(this.lastAttemptAt + this.pollIntervalMs(), this.cooldownUntil(), this.nextRequestAt);
      return Math.max(0, Math.ceil((due - this.now()) / 1000));
    }

    async request(params, generation) {
      const wait = this.nextRequestAt - this.now();
      if (wait > 0) await this.sleep(wait);
      if (generation !== this.generation || this.paused || this.hidden()) throw { code: 'cancelled' };
      if (this.now() < this.cooldownUntil()) throw { code: 'cancelled' };
      try { return await this.transport(params); } finally { this.nextRequestAt = this.now() + MIN_GAP_MS; }
    }

    async refresh(force = false) {
      if (this.paused || this.hidden() || this.busy || !this.polling()) return;
      if (this.now() < this.cooldownUntil()) { this.changed(); return; }
      if (!force && this.lastAttemptAt && this.now() - this.lastAttemptAt < this.pollIntervalMs()) return;
      this.lastAttemptAt = this.now();
      const generation = this.generation;
      this.busy = true;
      try {
        const params = this.mode === 'area' ? { kind: 'area', ...this.area } : { ...this.lookup };
        const data = await this.request(params, generation);
        if (generation !== this.generation) return;
        this.accept(data);
      } catch (e) {
        if (e?.code === 'cancelled') return;
        this.backoff(e);
        if (generation !== this.generation) return;
        this.failure = { code: e?.code || 'feed_unavailable', message: e?.message || 'The public feed is not answering.' };
      } finally {
        this.busy = false;
        // A newer search or a lock-on happened meanwhile: let it run now if
        // it's due (a new search always is).
        if (generation !== this.generation) this.refresh();
        this.changed();
      }
    }

    accept(data) {
      const fetched = Number(data?.fetched_at) * 1000 || this.now();
      this.aircraft = (Array.isArray(data?.aircraft) ? data.aircraft : [])
        .filter(a => a && typeof a.hex === 'string')
        .map(a => ({ ...a, hex: a.hex.toLowerCase(), _received: fetched }));
      this.last = fetched;
      this.notice = '';
      this.failure = null;
      this.retryAt = 0;
      const watched = this.tracked?.hex;
      for (const a of this.aircraft) {
        if (!hasPosition(a)) continue;
        const trail = this.trails.get(a.hex) || [];
        const prev = trail[trail.length - 1];
        if (!prev || prev[0] !== a.lat || prev[1] !== a.lon) trail.push([a.lat, a.lon]);
        this.trails.set(a.hex, trail.slice(a.hex === watched ? -MAX_TRAIL : -120));
      }
      const present = new Set(this.aircraft.map(a => a.hex));
      for (const key of this.trails.keys()) if (!present.has(key) && key !== watched && key !== this.selected?.hex) this.trails.delete(key);
      if (this.selected) {
        const a = this.aircraft.find(v => v.hex === this.selected.hex);
        if (a) this.selected = { ...a, received: fetched };
      }

      if (this.mode === 'lookup') {
        if (this.aircraft.length === 1 && validHex(this.aircraft[0].hex)) {
          // A flight-number or callsign search locks to that flight; a
          // registration or hex search follows the airframe.
          const byFlight = this.lookup.kind === 'callsign';
          this.track(this.aircraft[0], { flightLock: byFlight ? (callsignOf(this.aircraft[0]) || this.lookup.value) : null });
        }
        return;
      }
      if (this.mode === 'tracking') this.checkTracked();
      this.save();
    }

    // Decides whether the tracked flight is still the flight the user wanted.
    checkTracked() {
      const t = this.tracked;
      if (!t) return;
      const now = this.now();
      const a = this.aircraft.find(v => v.hex === t.hex);
      if (a && hasPosition(a)) {
        t.lastSeenAt = now;
        const callsign = callsignOf(a);
        if (t.flightLock && callsign && callsign !== t.flightLock) {
          return this.end('callsign', { newCallsign: callsign });
        }
        if (onGround(a)) {
          t.groundSince = t.groundSince || now;
          if (t.airborne && now - t.groundSince >= LANDED_AFTER_MS) return this.end('landed');
        } else {
          t.airborne = true;
          t.groundSince = 0;
        }
      } else if (t.lastSeenAt && now - t.lastSeenAt >= LOST_AFTER_MS) {
        return this.end('lost');
      }
    }

    end(reason, extra = {}) {
      this.ended = { reason, callsign: this.tracked?.flightLock || this.label, at: this.now(), ...extra };
      this.mode = 'ended';
      this.remove(WATCH_KEY);
      this.follow = false;
      this.generation++;
    }

    // ---- read-outs for the page ------------------------------------------------
    age(a, received = a?._received || a?.received || this.last) {
      const seen = Number(a?.seen_pos ?? a?.seen ?? 0);
      return Math.max(0, (Number.isFinite(seen) ? seen : 0) + (this.now() - received) / 1000);
    }

    isLive(a) { return !!a && hasPosition(a) && this.age(a) <= POSITION_MAX_AGE_S && this.aircraft.some(v => v.hex === a.hex); }

    // Aircraft for the list and map: the text filter, then Isolate.
    visible(filter = '') {
      const q = String(filter).trim().toUpperCase();
      const list = this.aircraft
        .filter(a => !q || [a.flight, a.r, a.t, a.hex, a.desc].some(v => String(v || '').toUpperCase().includes(q)))
        .filter(a => !this.isolated || a.hex === this.selected?.hex);
      return { list, mapped: list.filter(a => hasPosition(a) && this.age(a) <= POSITION_MAX_AGE_S) };
    }

    trailStats(hex = this.tracked?.hex) {
      const trail = this.trails.get(hex) || [];
      let miles = 0;
      for (let i = 1; i < trail.length; i++) miles += haversineMi(trail[i - 1], trail[i]);
      return { points: trail.length, miles, since: this.tracked?.firstSeenAt || 0 };
    }

    // The tracked flight's phase, for the status chip.
    phase() {
      const s = this.selected;
      if (this.mode === 'ended') return { key: 'ended', text: this.ended?.reason === 'landed' ? 'Landed' : 'Tracking ended' };
      if (this.mode !== 'tracking' || !s) return null;
      if (!this.isLive(s)) return { key: 'lost', text: 'Signal lost' };
      if (onGround(s)) return { key: 'ground', text: this.tracked?.airborne ? 'Landed' : 'On the ground' };
      const vs = Number(s.baro_rate ?? s.geom_rate);
      if (Number.isFinite(vs) && vs > 500) return { key: 'climb', text: 'Climbing' };
      if (Number.isFinite(vs) && vs < -500) return { key: 'descend', text: 'Descending' };
      return { key: 'cruise', text: 'In flight' };
    }

    // The badge at the top right.
    feed() {
      const cooling = Math.max(0, Math.ceil((this.cooldownUntil() - this.now()) / 1000));
      if (this.paused) return { state: 'paused', text: 'Paused' };
      if (!this.polling()) return { state: 'off', text: this.mode === 'ended' ? 'Not polling' : 'Map only' };
      if (cooling) return { state: 'warn', text: `Feed cooldown · ${fmtDuration(cooling)}` };
      if (this.failure) return { state: 'warn', text: 'Feed unavailable' };
      if (!this.last) return { state: 'wait', text: 'Connecting…' };
      const age = (this.now() - this.last) / 1000;
      if (age > Math.max(45, this.pollIntervalMs() / 500)) return { state: 'warn', text: 'Data stale' };
      return { state: 'live', text: 'Live' };
    }

    // The one status line under the search bar.
    status() {
      const cooling = Math.max(0, Math.ceil((this.cooldownUntil() - this.now()) / 1000));
      const keep = this.mode === 'tracking' ? ` Still locked on ${this.label}; updates resume by themselves.` : ' Updates resume by themselves.';
      if (cooling && this.polling()) return { tone: 'warn', text: `The public feed asked us to slow down. Next try in ${fmtDuration(cooling)}.${keep}` };
      if (this.failure && this.polling()) return { tone: 'warn', text: `${this.failure.message}${this.mode === 'tracking' ? ' The last position is kept on the map.' : ''}` };
      if (this.notice) return { tone: 'info', text: this.notice };
      switch (this.mode) {
        case 'idle':
          return { tone: 'info', text: 'Search a flight number above to track it anywhere in the world. The map alone requests no aircraft data.' };
        case 'lookup':
          if (!this.last) return { tone: 'info', text: `${this.searchNote || ''}Searching worldwide for ${this.label}…` };
          if (this.aircraft.length > 1) return { tone: 'info', text: `${this.aircraft.length} aircraft match ${this.label}. Pick the right one in the list, then press Track this flight.` };
          return { tone: 'warn', text: `${this.searchNote || ''}${this.label} isn’t in the air yet, uses a different callsign, or is out of coverage. Checking again every minute. Codeshares: use the operating airline’s number.` };
        case 'tracking': {
          if (this.selected && !this.isLive(this.selected)) return { tone: 'warn', text: `No recent position for ${this.label}. It’s still locked and retrying; the last known position isn’t live.` };
          if (this.selected && onGround(this.selected) && !this.tracked?.airborne) return { tone: 'info', text: `${this.label} is on the ground. Checking every minute until it departs.` };
          return { tone: 'ok', text: `Tracking ${this.label} worldwide. Only this aircraft is requested.` };
        }
        case 'area':
          if (!this.last) return { tone: 'info', text: 'Scanning this area…' };
          return this.aircraft.length
            ? { tone: 'info', text: `${this.aircraft.length} aircraft within ${this.area.radius} NM. Select one and press Track this flight to follow it anywhere.` }
            : { tone: 'info', text: 'No aircraft reported in this area. Try a wider radius or another spot.' };
        case 'ended': {
          const e = this.ended || {};
          if (e.reason === 'callsign') return { tone: 'warn', text: `This aircraft is now flying ${e.newCallsign}, so ${e.callsign} has most likely landed. Tracking stopped.` };
          if (e.reason === 'landed') return { tone: 'ok', text: `${e.callsign} landed. Tracking stopped.` };
          return { tone: 'warn', text: `No position for ${e.callsign} in over 2 hours, so tracking stopped. It may have landed outside public coverage.` };
        }
      }
      return { tone: 'info', text: '' };
    }

    changed() { try { this.onChange(); } catch (e) { console.error(e); } }
  }

  function fmtDuration(s) {
    s = Math.max(0, Math.round(s));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  }

  const api = { TrackerCore, normalizeSearch, hasPosition, ident, callsignOf, onGround, fmtDuration, haversineMi, AIRLINES, KIND_NAMES, WATCH_KEY, COOLDOWN_KEY };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Adsb = api;
})(typeof window !== 'undefined' ? window : globalThis);
