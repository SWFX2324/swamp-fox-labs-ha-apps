'use strict';
// A MeshCore companion radio over Wi-Fi (TCP, port 5000 by default).
//
// Frames: from us '<' (0x3C), from the radio '>' (0x3E), each followed by the
// payload length (little-endian u16) and the payload. The first payload byte
// is a command code (to the radio) or a response/push code (from it). Every
// multi-byte number is little-endian.
//
// The radio answers one command at a time and doesn't tag its replies, so
// commands go through a queue: one in flight, finished by the reply code it
// expects (or ERR). Codes 0x80 and up are pushes that can arrive any time.
//
// On connect: DEVICE_QUERY (asking for protocol 3, so received messages carry
// their SNR), APP_START, set the radio's clock, then the contacts, channels,
// battery and any queued messages. Battery and contacts are refreshed every
// few minutes; that also tells us the link is alive.

const crypto = require('crypto');
const { TcpLink } = require('./link');

const TO_RADIO = 0x3c, FROM_RADIO = 0x3e;
const MAX_FRAME = 1024;
const COMMAND_TIMEOUT_MS = 10_000;
const BATTERY_EVERY_MS = 5 * 60_000;
const CONTACTS_EVERY_MS = 15 * 60_000;
const MAX_CHANNELS = 16;
const MAX_TEXT_BYTES = 140;
const APP_NAME = 'Mesh Hub';

const CMD = {
  APP_START: 0x01, SEND_TXT_MSG: 0x02, SEND_CHANNEL_TXT_MSG: 0x03, GET_CONTACTS: 0x04, SET_DEVICE_TIME: 0x06,
  SYNC_NEXT_MESSAGE: 0x0a, GET_BATT_AND_STORAGE: 0x14, DEVICE_QUERY: 0x16, GET_CHANNEL: 0x1f,
};
const RESP = {
  OK: 0x00, ERR: 0x01, CONTACTS_START: 0x02, CONTACT: 0x03, END_OF_CONTACTS: 0x04, SELF_INFO: 0x05, SENT: 0x06,
  CONTACT_MSG_RECV: 0x07, CHANNEL_MSG_RECV: 0x08, CURR_TIME: 0x09, NO_MORE_MESSAGES: 0x0a, BATT_AND_STORAGE: 0x0c,
  DEVICE_INFO: 0x0d, CONTACT_MSG_RECV_V3: 0x10, CHANNEL_MSG_RECV_V3: 0x11, CHANNEL_INFO: 0x12,
};
const PUSH = {
  ADVERT: 0x80, PATH_UPDATED: 0x81, SEND_CONFIRMED: 0x82, MSG_WAITING: 0x83, LOG_RX_DATA: 0x88, NEW_ADVERT: 0x8a,
  CONTACT_DELETED: 0x8f,
};
const TYPES = { 1: 'Companion', 2: 'Repeater', 3: 'Room server', 4: 'Sensor' };
const ERRORS = { 1: 'The radio doesn’t support that.', 2: 'Not found on the radio.', 3: 'The radio’s table is full.', 4: 'The radio is busy.', 5: 'The radio had a storage error.', 6: 'The radio refused it.' };

const MESSAGE_CODES = new Set([RESP.CONTACT_MSG_RECV, RESP.CHANNEL_MSG_RECV, RESP.CONTACT_MSG_RECV_V3, RESP.CHANNEL_MSG_RECV_V3, RESP.NO_MORE_MESSAGES]);

function frame(payload) {
  const head = Buffer.alloc(3);
  head[0] = TO_RADIO;
  head.writeUInt16LE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

const cstr = buf => { const z = buf.indexOf(0); return (z < 0 ? buf : buf.subarray(0, z)).toString('utf8'); };
const u32 = seconds => { const b = Buffer.alloc(4); b.writeUInt32LE(seconds >>> 0); return b; };
// Out-path byte: 0xFF means no known path (the message floods); otherwise the
// low 6 bits are the hop count.
const hopsFrom = b => (b === 0xff ? null : b & 0x3f);

// A rough Li-ion state of charge from the cell voltage, for the battery icon.
function batteryPercent(mv) {
  if (!mv) return null;
  const curve = [[3300, 0], [3500, 5], [3600, 12], [3700, 30], [3750, 42], [3800, 52], [3850, 62], [3900, 70], [4000, 82], [4100, 92], [4200, 100]];
  if (mv <= curve[0][0]) return 0;
  for (let i = 1; i < curve.length; i++) {
    if (mv <= curve[i][0]) {
      const [v0, p0] = curve[i - 1], [v1, p1] = curve[i];
      return Math.round(p0 + ((mv - v0) / (v1 - v0)) * (p1 - p0));
    }
  }
  return 100;
}

function parseContact(f) {
  if (f.length < 148) return null;
  const lat = f.readInt32LE(136), lon = f.readInt32LE(140);
  return {
    key: f.subarray(1, 33).toString('hex'),
    type: f[33],
    flags: f[34],
    hops: hopsFrom(f[35]),
    name: cstr(f.subarray(100, 132)),
    lastAdvert: f.readUInt32LE(132),
    lat: lat || lon ? lat / 1e6 : null,
    lon: lat || lon ? lon / 1e6 : null,
  };
}

class MeshCoreClient extends TcpLink {
  constructor({ host, port = 5000, log, now = Date.now } = {}) {
    super({ network: 'meshcore', host, port, log });
    this.now = now;
    this.reset();
  }

  reset() {
    this.contacts = new Map();   // public key hex -> contact
    this.channels = new Map();
    this.self = null;
    this.device = null;
    this.battery = null;
    this.rxStats = null;
    this.queue = [];
    this.current = null;
    this.acks = new Map();       // expected ack hex -> { msgId, timer }
    this.draining = false;
  }

  onOpen() {
    this.reset();
    this.setState('syncing');
    this.sync().catch(e => {
      this.log.error('[meshcore] setup failed:', e.message);
      this.socket?.destroy(new Error(`setup failed: ${e.message}`));
    });
  }

  onClosed() {
    clearInterval(this.batteryTimer);
    clearInterval(this.contactsTimer);
    if (this.current) { clearTimeout(this.current.timer); this.current.reject(new Error('disconnected')); }
    for (const c of this.queue) c.reject(new Error('disconnected'));
    this.queue = [];
    this.current = null;
    for (const a of this.acks.values()) clearTimeout(a.timer);
    this.acks.clear();
  }

  async sync() {
    const [info] = await this.command(Buffer.from([CMD.DEVICE_QUERY, 3]), [RESP.DEVICE_INFO]);
    this.device = {
      firmwareCode: info[1],
      maxContacts: info[2] * 2,
      maxChannels: info[3] || 8,
      build: cstr(info.subarray(8, 20)) || null,
      manufacturer: cstr(info.subarray(20, 60)) || null,
      firmware: cstr(info.subarray(60, 80)) || null,
    };
    const start = Buffer.concat([Buffer.from([CMD.APP_START, 3]), Buffer.from('      '), Buffer.from(APP_NAME)]);
    const [self] = await this.command(start, [RESP.SELF_INFO]);
    this.selfInfo(self);
    // Set the radio's clock so its timestamps are right. It refuses to go
    // backwards, which is fine.
    await this.command(Buffer.concat([Buffer.from([CMD.SET_DEVICE_TIME]), u32(this.now() / 1000)]), [RESP.OK], { allowErr: true });
    await this.loadContacts();
    await this.loadChannels();
    await this.loadBattery();
    this.log.log(`[meshcore] synced: ${this.contacts.size} contacts, ${this.channels.size} channels`);
    this.setState('connected');
    await this.drain();
    this.batteryTimer = setInterval(() => this.loadBattery().catch(() => {}), BATTERY_EVERY_MS);
    this.contactsTimer = setInterval(() => this.loadContacts().then(() => this.emit('change')).catch(() => {}), CONTACTS_EVERY_MS);
    this.batteryTimer.unref?.();
    this.contactsTimer.unref?.();
  }

  selfInfo(f) {
    const lat = f.readInt32LE(36), lon = f.readInt32LE(40);
    this.self = {
      type: f[1],
      txPower: f.readInt8(2),
      key: f.subarray(4, 36).toString('hex'),
      lat: lat || lon ? lat / 1e6 : null,
      lon: lat || lon ? lon / 1e6 : null,
      freq: f.readUInt32LE(48) / 1000,
      bw: f.readUInt32LE(52) / 1000,
      sf: f[56],
      cr: f[57],
      name: f.subarray(58).toString('utf8').replace(/\0+$/, ''),
    };
  }

  async loadContacts() {
    const frames = await this.command(Buffer.from([CMD.GET_CONTACTS]), [RESP.END_OF_CONTACTS]);
    const seen = new Set();
    for (const f of frames) {
      if (f[0] !== RESP.CONTACT) continue;
      const c = parseContact(f);
      if (c) { this.upsertContact(c); seen.add(c.key); }
    }
    for (const key of this.contacts.keys()) if (!seen.has(key)) this.contacts.delete(key);
  }

  upsertContact(c) {
    const old = this.contacts.get(c.key) || {};
    const advertMs = c.lastAdvert * 1000;
    // A node with an unset clock sends silly timestamps; ignore those.
    const plausible = advertMs > Date.UTC(2023, 0, 1) && advertMs < this.now() + 86_400_000;
    this.contacts.set(c.key, { ...old, ...c, lastHeard: Math.max(old.lastHeard || 0, plausible ? advertMs : 0) || null });
  }

  async loadChannels() {
    this.channels.clear();
    const max = Math.min(MAX_CHANNELS, this.device?.maxChannels || 8);
    for (let i = 0; i < max; i++) {
      const [f] = await this.command(Buffer.from([CMD.GET_CHANNEL, i]), [RESP.CHANNEL_INFO], { allowErr: true });
      if (!f || f[0] !== RESP.CHANNEL_INFO) break;
      const name = cstr(f.subarray(2, 34));
      const secret = f.subarray(34, 50);
      if (!name && secret.every(b => b === 0)) continue;   // an empty slot
      this.channels.set(f[1], { index: f[1], name: name || `Channel ${f[1]}` });
    }
  }

  async loadBattery() {
    const [f] = await this.command(Buffer.from([CMD.GET_BATT_AND_STORAGE]), [RESP.BATT_AND_STORAGE]);
    const mv = f.readUInt16LE(1);
    this.battery = { mv, percent: batteryPercent(mv) };
    this.emit('change');
  }

  // Pull queued messages off the radio until it has none left.
  async drain() {
    if (this.draining) { this.drainAgain = true; return; }
    this.draining = true;
    try {
      do {
        this.drainAgain = false;
        for (let i = 0; i < 200; i++) {
          const [f] = await this.command(Buffer.from([CMD.SYNC_NEXT_MESSAGE]), [...MESSAGE_CODES]);
          if (f[0] === RESP.NO_MORE_MESSAGES) break;
          this.incoming(f);
        }
      } while (this.drainAgain);
    } finally {
      this.draining = false;
    }
  }

  incoming(f) {
    const code = f[0];
    let snr = null, chat, from = null, fromName, text, ts, hops;
    if (code === RESP.CONTACT_MSG_RECV_V3 || code === RESP.CONTACT_MSG_RECV) {
      const o = code === RESP.CONTACT_MSG_RECV_V3 ? 4 : 1;
      if (code === RESP.CONTACT_MSG_RECV_V3) snr = f.readInt8(1) / 4;
      const prefix = f.subarray(o, o + 6).toString('hex');
      hops = hopsFrom(f[o + 6]);
      const txtType = f[o + 7];
      ts = f.readUInt32LE(o + 8);
      text = f.subarray(o + 12 + (txtType === 2 ? 4 : 0)).toString('utf8');
      if (txtType === 1 || txtType === 3) return;   // CLI replies, not chat
      const contact = [...this.contacts.values()].find(c => c.key.startsWith(prefix));
      from = contact?.key || prefix;
      fromName = contact?.name || prefix;
      chat = `dm:${from}`;
    } else if (code === RESP.CHANNEL_MSG_RECV_V3 || code === RESP.CHANNEL_MSG_RECV) {
      const o = code === RESP.CHANNEL_MSG_RECV_V3 ? 4 : 1;
      if (code === RESP.CHANNEL_MSG_RECV_V3) snr = f.readInt8(1) / 4;
      chat = `ch:${f[o]}`;
      hops = hopsFrom(f[o + 1]);
      ts = f.readUInt32LE(o + 3);
      text = f.subarray(o + 7).toString('utf8');
      // Channel messages carry the sender's name in the text: "Name: hello".
      const m = /^([^:\n]{1,32}): ([\s\S]*)$/.exec(text);
      if (m) { fromName = m[1]; text = m[2]; } else fromName = 'Unknown';
    } else return;
    const sentMs = ts * 1000;
    const time = Math.abs(sentMs - this.now()) < 2 * 86_400_000 ? sentMs : this.now();
    const digest = crypto.createHash('sha1').update(`${chat}|${fromName}|${ts}|${text}`).digest('hex').slice(0, 12);
    this.emit('message', {
      id: `mc-${digest}`, network: 'meshcore', chat, from, fromName, text, time,
      snr, rssi: null, hops: hops ?? null, outgoing: false,
    });
  }

  // ---- frames -------------------------------------------------------------------

  onData() {
    let buf = this.rx;
    for (;;) {
      const start = buf.indexOf(FROM_RADIO);
      if (start < 0) { buf = Buffer.alloc(0); break; }
      if (start > 0) buf = buf.subarray(start);
      if (buf.length < 3) break;
      const len = buf.readUInt16LE(1);
      if (len === 0 || len > MAX_FRAME) { buf = buf.subarray(1); continue; }
      if (buf.length < 3 + len) break;
      const payload = Buffer.from(buf.subarray(3, 3 + len));
      buf = buf.subarray(3 + len);
      this.handleFrame(payload);
    }
    this.rx = Buffer.from(buf);
  }

  handleFrame(f) {
    const code = f[0];
    if (code >= 0x80) return this.push(code, f);
    const c = this.current;
    if (!c) return;
    c.frames.push(f);
    if (code === RESP.ERR) {
      if (c.allowErr) return this.complete(c.frames);
      return this.complete(null, new Error(ERRORS[f[1]] || `The radio refused it (${f[1]}).`));
    }
    if (c.done.has(code)) this.complete(c.frames);
  }

  push(code, f) {
    switch (code) {
      case PUSH.ADVERT: {
        const c = this.contacts.get(f.subarray(1, 33).toString('hex'));
        if (c) { c.lastHeard = this.now(); this.emit('change'); }
        break;
      }
      case PUSH.NEW_ADVERT: {
        const c = parseContact(f);
        if (c) { this.upsertContact(c); this.contacts.get(c.key).lastHeard = this.now(); this.emit('change'); }
        break;
      }
      case PUSH.CONTACT_DELETED:
        this.contacts.delete(f.subarray(1, 33).toString('hex'));
        this.emit('change');
        break;
      case PUSH.PATH_UPDATED:
        clearTimeout(this.pathTimer);
        this.pathTimer = setTimeout(() => this.loadContacts().then(() => this.emit('change')).catch(() => {}), 2000);
        this.pathTimer.unref?.();
        break;
      case PUSH.SEND_CONFIRMED: {
        const key = f.subarray(1, 5).toString('hex');
        const a = this.acks.get(key);
        if (a) {
          clearTimeout(a.timer);
          this.acks.delete(key);
          this.emit('message-update', a.msgId, { status: 'delivered', tripMs: f.length >= 9 ? f.readUInt32LE(5) : null });
        }
        break;
      }
      case PUSH.MSG_WAITING:
        if (this.state === 'connected') this.drain().catch(e => this.log.warn('[meshcore] reading messages:', e.message));
        break;
      case PUSH.LOG_RX_DATA:
        if (f.length >= 3) { this.rxStats = { snr: f.readInt8(1) / 4, rssi: f.readInt8(2), time: this.now() }; this.emit('change'); }
        break;
      default:
        break;
    }
  }

  // ---- the command queue ------------------------------------------------------------

  command(payload, doneCodes, { allowErr = false } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ payload, done: new Set(doneCodes), allowErr, resolve, reject, frames: [] });
      this.next();
    });
  }

  next() {
    if (this.current || !this.queue.length) return;
    const c = this.queue.shift();
    this.current = c;
    c.timer = setTimeout(() => this.complete(null, new Error('The radio didn’t answer.')), COMMAND_TIMEOUT_MS);
    if (!this.write(frame(c.payload))) this.complete(null, new Error('The MeshCore radio isn’t connected.'));
  }

  complete(frames, err) {
    const c = this.current;
    if (!c) return;
    clearTimeout(c.timer);
    this.current = null;
    if (err) c.reject(err); else c.resolve(frames);
    this.next();
  }

  // ---- sending --------------------------------------------------------------------

  // chat is "ch:<index>" or "dm:<contact public key>". Returns the stored
  // message right away; its status follows by 'message-update'.
  sendText(chat, text) {
    if (this.state !== 'connected') throw new Error('The MeshCore radio isn’t connected.');
    const bytes = Buffer.from(text, 'utf8');
    if (!bytes.length) throw new Error('Type a message first.');
    if (bytes.length > MAX_TEXT_BYTES) throw new Error(`MeshCore messages can be ${MAX_TEXT_BYTES} bytes at most.`);
    const now = this.now();
    const ts = u32(now / 1000);
    let payload, isChannel;
    const m = /^ch:(\d{1,2})$/.exec(chat);
    if (m) {
      const idx = Number(m[1]);
      if (!this.channels.has(idx)) throw new Error('That channel isn’t set up on the radio.');
      payload = Buffer.concat([Buffer.from([CMD.SEND_CHANNEL_TXT_MSG, 0, idx]), ts, bytes]);
      isChannel = true;
    } else if (/^dm:[0-9a-f]{64}$/.test(chat)) {
      const key = chat.slice(3);
      if (!this.contacts.has(key)) throw new Error('That contact isn’t on the radio.');
      payload = Buffer.concat([Buffer.from([CMD.SEND_TXT_MSG, 0, 0]), ts, Buffer.from(key.slice(0, 12), 'hex'), bytes]);
    } else throw new Error('Unknown chat.');

    const msg = {
      id: `mc-out-${crypto.randomBytes(6).toString('hex')}`, network: 'meshcore', chat, from: this.self?.key || null,
      fromName: this.self?.name || 'This radio', text, time: now, outgoing: true, status: 'queued',
    };
    this.command(payload, isChannel ? [RESP.OK] : [RESP.SENT]).then(([f]) => {
      if (isChannel) return this.emit('message-update', msg.id, { status: 'sent' });
      const ack = f.subarray(2, 6).toString('hex');
      const timeout = Math.min(120_000, Math.max(10_000, f.readUInt32LE(6) * 2));
      const timer = setTimeout(() => this.acks.delete(ack), timeout);
      timer.unref?.();
      this.acks.set(ack, { msgId: msg.id, timer });
      this.emit('message-update', msg.id, { status: 'sent', flood: f[1] === 1 });
    }, e => this.emit('message-update', msg.id, { status: 'failed', error: e.message }));
    return msg;
  }

  // ---- what the page sees -----------------------------------------------------------

  snapshot() {
    const nodes = [...this.contacts.values()].map(c => ({
      id: c.key, network: 'meshcore', name: c.name || c.key.slice(0, 8), short: c.key.slice(0, 4).toUpperCase(),
      kind: TYPES[c.type] || 'Node', hw: null, lat: c.lat, lon: c.lon, alt: null,
      lastHeard: c.lastHeard || null, snr: null, rssi: null, hops: c.hops, battery: null, voltage: null,
      favorite: !!(c.flags & 1), isSelf: false, source: 'radio',
    }));
    if (this.self) {
      nodes.unshift({
        id: this.self.key, network: 'meshcore', name: this.self.name, short: this.self.key.slice(0, 4).toUpperCase(),
        kind: TYPES[this.self.type] || 'Companion', hw: this.device?.manufacturer || null, lat: this.self.lat, lon: this.self.lon,
        alt: null, lastHeard: this.lastRx, snr: null, rssi: null, hops: 0, battery: this.battery?.percent ?? null,
        voltage: this.battery ? this.battery.mv / 1000 : null, favorite: false, isSelf: true, source: 'radio',
      });
    }
    const chats = [...this.channels.values()].sort((a, b) => a.index - b.index)
      .map(c => ({ key: `ch:${c.index}`, network: 'meshcore', kind: 'channel', name: c.name }));
    return {
      ...this.linkStatus(),
      self: this.self ? {
        id: this.self.key, name: this.self.name, hw: this.device?.manufacturer || null, firmware: this.device?.firmware || null,
        battery: this.battery?.percent ?? null, voltage: this.battery ? this.battery.mv / 1000 : null, lat: this.self.lat, lon: this.self.lon,
      } : null,
      radio: this.self ? { freq: this.self.freq, bw: this.self.bw, sf: this.self.sf, cr: this.self.cr, txPower: this.self.txPower, lastRx: this.rxStats } : {},
      nodes,
      chats,
      maxTextBytes: MAX_TEXT_BYTES,
    };
  }
}

module.exports = { MeshCoreClient, frame, parseContact, batteryPercent, CMD, RESP, PUSH, MAX_TEXT_BYTES };
