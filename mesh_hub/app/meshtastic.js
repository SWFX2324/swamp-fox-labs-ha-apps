'use strict';
// A Meshtastic node over its Wi-Fi/Ethernet API (TCP, port 4403 by default).
//
// Frames in both directions: 0x94 0xC3, the payload length (big-endian u16),
// then a protobuf (ToRadio from us, FromRadio from the node). On connect we
// send want_config_id; the node answers with its own info, config, channels
// and every node it knows, then config_complete_id echoing our nonce. After
// that it streams packets as they're heard. A heartbeat every 5 minutes keeps
// the API session open, as the official clients do.

const crypto = require('crypto');
const { TcpLink } = require('./link');
const { decode, encode, field } = require('./protobuf');

const START1 = 0x94, START2 = 0xc3;
const MAX_FRAME = 512;
const BROADCAST = 0xffffffff;
const HEARTBEAT_MS = 5 * 60_000;
// How long an outgoing message waits for the mesh before we stop expecting an
// answer. The firmware itself gives up after a few retransmissions.
const ACK_WAIT_MS = 3 * 60_000;
const MAX_TEXT_BYTES = 200;

const PORT = { TEXT: 1, POSITION: 3, NODEINFO: 4, ROUTING: 5, TELEMETRY: 67, TRACEROUTE: 70 };

const ROLES = ['CLIENT', 'CLIENT_MUTE', 'ROUTER', 'ROUTER_CLIENT', 'REPEATER', 'TRACKER', 'SENSOR', 'TAK', 'CLIENT_HIDDEN', 'LOST_AND_FOUND', 'TAK_TRACKER', 'ROUTER_LATE', 'CLIENT_BASE'];
const PRESETS = ['LongFast', 'LongSlow', 'VeryLongSlow', 'MediumSlow', 'MediumFast', 'ShortSlow', 'ShortFast', 'LongModerate', 'ShortTurbo'];
const REGIONS = ['UNSET', 'US', 'EU_433', 'EU_868', 'CN', 'JP', 'ANZ', 'KR', 'TW', 'RU', 'IN', 'NZ_865', 'TH', 'LORA_24', 'UA_433', 'UA_868', 'MY_433', 'MY_919', 'SG_923', 'PH_433', 'PH_868', 'PH_915', 'ANZ_433', 'KZ_433', 'KZ_863', 'NP_865', 'BR_902'];
const HW = {
  1: 'TLORA_V2', 2: 'TLORA_V1', 3: 'TLORA_V2_1_1P6', 4: 'TBEAM', 5: 'HELTEC_V2_0', 7: 'T_ECHO', 9: 'RAK4631', 10: 'HELTEC_V2_1',
  13: 'RAK11200', 16: 'TLORA_T3_S3', 21: 'WIO_WM1110', 25: 'STATION_G1', 26: 'RAK11310', 31: 'STATION_G2', 33: 'T_ECHO_PLUS',
  37: 'PORTDUINO', 38: 'ANDROID_SIM', 40: 'NRF52840_PCA10059', 43: 'HELTEC_V3', 44: 'HELTEC_WSL_V3', 47: 'RPI_PICO',
  48: 'HELTEC_WIRELESS_TRACKER', 49: 'HELTEC_WIRELESS_PAPER', 50: 'T_DECK', 71: 'TRACKER_T1000_E', 81: 'SEEED_XIAO_S3',
  99: 'SEEED_WIO_TRACKER_L1', 110: 'HELTEC_V4', 255: 'PRIVATE_HW',
};
const ROUTING_ERRORS = { 1: 'No route to that node', 2: 'Refused (NAK)', 3: 'Timed out', 4: 'No interface', 5: 'No answer after retries', 6: 'No such channel', 7: 'Too long', 8: 'No response', 9: 'Duty cycle limit reached', 32: 'Bad request', 33: 'Not authorized', 34: 'Encryption failed', 35: 'Unknown public key' };

const nodeId = num => '!' + (num >>> 0).toString(16).padStart(8, '0');
const parseNodeId = id => (/^![0-9a-f]{8}$/.test(id) ? parseInt(id.slice(1), 16) : null);

function frame(payload) {
  const head = Buffer.from([START1, START2, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
}

class MeshtasticClient extends TcpLink {
  constructor({ host, port = 4403, log, now = Date.now } = {}) {
    // Meshtastic answers nothing on its own, so a quiet mesh is normal: rely
    // on TCP keepalive rather than a silence watchdog.
    super({ network: 'meshtastic', host, port, log, silenceMs: null });
    this.now = now;
    this.reset();
  }

  reset() {
    this.myNum = null;
    this.nodes = new Map();
    this.channels = new Map();
    this.radio = {};
    this.firmware = null;
    this.configNonce = null;
    this.pending = new Map();   // packet id -> { msgId, to, timer }
  }

  onOpen() {
    this.reset();
    this.configNonce = crypto.randomInt(1, 0x7fffffff);
    this.setState('syncing');
    this.send(encode([field.varint(3, this.configNonce)]));
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => this.send(encode([field.msg(7, [])])), HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  onClosed() {
    clearInterval(this.heartbeat);
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  send(toRadio) { return this.write(frame(toRadio)); }

  onData() {
    let buf = this.rx;
    for (;;) {
      const start = buf.indexOf(START1);
      if (start < 0) { buf = Buffer.alloc(0); break; }   // only debug text
      if (start > 0) buf = buf.subarray(start);
      if (buf.length < 4) break;
      if (buf[1] !== START2) { buf = buf.subarray(1); continue; }
      const len = buf.readUInt16BE(2);
      if (len > MAX_FRAME) { buf = buf.subarray(1); continue; }
      if (buf.length < 4 + len) break;
      const payload = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      this.handleFromRadio(decode(payload));
    }
    this.rx = Buffer.from(buf);
  }

  // ---- FromRadio ------------------------------------------------------------------

  handleFromRadio(m) {
    if (m.has(3)) {
      this.myNum = m.msg(3).u32(1);
    } else if (m.has(4)) {
      this.nodeInfo(m.msg(4));
    } else if (m.has(5)) {
      const lora = m.msg(5).msg(6);
      if (lora) {
        this.radio = {
          region: REGIONS[lora.u32(7, 0)] || String(lora.u32(7, 0)),
          preset: lora.bool(1, true) ? PRESETS[lora.u32(2, 0)] || null : 'Custom',
          hopLimit: lora.u32(8) || 3,
        };
      }
    } else if (m.has(10)) {
      const c = m.msg(10);
      const index = c.i32(1, 0);
      const role = c.u32(3, 0);
      if (role === 0) this.channels.delete(index);
      else this.channels.set(index, { index, name: c.msg(2)?.str(3, '') || '', primary: role === 1 });
    } else if (m.has(13)) {
      const md = m.msg(13);
      this.firmware = md.str(1) || null;
    } else if (m.has(7)) {
      if (m.u32(7) === this.configNonce) {
        this.log.log(`[meshtastic] synced: ${this.nodes.size} nodes, ${this.channels.size} channels`);
        this.setState('connected');
      }
    } else if (m.has(8)) {
      // The node rebooted: ask for everything again.
      this.onOpen();
    } else if (m.has(2)) {
      this.packet(m.msg(2));
    }
    this.emit('change');
  }

  node(num) {
    let n = this.nodes.get(num);
    if (!n) { n = { num }; this.nodes.set(num, n); }
    return n;
  }

  nodeInfo(ni) {
    const num = ni.u32(1);
    if (num === undefined) return;
    const n = this.node(num);
    const user = ni.msg(2);
    if (user) this.user(n, user);
    const pos = ni.msg(3);
    if (pos) this.position(n, pos);
    const dm = ni.msg(6);
    if (dm) this.deviceMetrics(n, dm);
    const snr = ni.float(4);
    if (snr !== undefined && snr !== 0) n.snr = snr;
    const heard = ni.fixed32(5);
    if (heard) n.lastHeard = heard * 1000;
    if (ni.has(9)) n.hops = ni.u32(9);
    n.viaMqtt = ni.bool(8, false);
    n.favorite = ni.bool(10, false);
    if (ni.has(7)) n.channel = ni.u32(7);
  }

  user(n, u) {
    n.longName = u.str(2, n.longName);
    n.shortName = u.str(3, n.shortName);
    if (u.has(5)) n.hw = HW[u.u32(5)] || `HW ${u.u32(5)}`;
    if (u.has(7)) n.role = ROLES[u.u32(7)] || String(u.u32(7));
    else if (!n.role) n.role = 'CLIENT';
    n.licensed = u.bool(6, false);
  }

  position(n, p) {
    const lat = p.sfixed32(1), lon = p.sfixed32(2);
    if (lat === undefined || lon === undefined || (lat === 0 && lon === 0)) return;
    n.lat = lat / 1e7;
    n.lon = lon / 1e7;
    const alt = p.i32(3);
    if (alt) n.alt = alt;
    const t = p.fixed32(4) || p.fixed32(7);
    if (t) n.positionTime = t * 1000;
    const bits = p.u32(23);
    if (bits) n.precisionBits = bits;
  }

  deviceMetrics(n, d) {
    if (d.has(1)) n.battery = d.u32(1);
    if (d.has(2)) n.voltage = round(d.float(2), 2);
    if (d.has(3)) n.chUtil = round(d.float(3), 1);
    if (d.has(4)) n.airUtil = round(d.float(4), 1);
    if (d.has(5)) n.uptime = d.u32(5);
  }

  packet(p) {
    const from = p.fixed32(1);
    const to = p.fixed32(2, BROADCAST);
    const channel = p.u32(3, 0);
    const data = p.msg(4);
    const rxTime = p.fixed32(7);
    const snr = p.float(8);
    const rssi = p.i32(12);
    const hopLimit = p.u32(9, 0), hopStart = p.u32(15);
    const hops = hopStart ? Math.max(0, hopStart - hopLimit) : undefined;
    const viaMqtt = p.bool(14, false);
    const when = rxTime ? rxTime * 1000 : this.now();

    if (from !== undefined && from !== this.myNum) {
      const n = this.node(from);
      n.lastHeard = when;
      if (snr) n.snr = round(snr, 2);
      if (rssi) n.rssi = rssi;
      if (hops !== undefined) n.hops = hops;
      n.viaMqtt = viaMqtt;
    }
    if (!data) return;   // encrypted with a key we don't have
    const port = data.u32(1, 0);
    const payload = data.bytes(2, Buffer.alloc(0));

    if (port === PORT.TEXT) {
      if (from === this.myNum) return;
      let chat;
      if (to === BROADCAST) chat = `ch:${channel}`;
      else if (to === this.myNum) chat = `dm:${nodeId(from)}`;
      else return;   // a direct message for someone else
      const n = this.nodes.get(from);
      this.emit('message', {
        id: `mt-${nodeId(from)}-${p.fixed32(6, 0)}`,
        network: 'meshtastic', chat, from: nodeId(from), fromName: n?.longName || n?.shortName || nodeId(from),
        text: payload.toString('utf8'), time: when, snr: snr ? round(snr, 2) : null, rssi: rssi || null, hops: hops ?? null,
        viaMqtt, outgoing: false,
      });
    } else if (port === PORT.POSITION) {
      if (from !== undefined) this.position(this.node(from), decode(payload));
    } else if (port === PORT.NODEINFO) {
      if (from !== undefined) this.user(this.node(from), decode(payload));
    } else if (port === PORT.TELEMETRY) {
      if (from === undefined) return;
      const t = decode(payload);
      const n = this.node(from);
      if (t.has(2)) this.deviceMetrics(n, t.msg(2));
      if (t.has(3)) {
        const e = t.msg(3);
        n.env = {
          temperature: round(e.float(1), 1), humidity: round(e.float(2), 0), pressure: round(e.float(3), 1),
          time: this.now(),
        };
      }
    } else if (port === PORT.ROUTING) {
      const requestId = data.fixed32(6);
      const pend = requestId && this.pending.get(requestId);
      if (!pend) return;
      const err = decode(payload).u32(3, 0);
      if (err) {
        this.finish(requestId, { status: 'failed', error: ROUTING_ERRORS[err] || `Error ${err}` });
      } else if (pend.to !== BROADCAST && from === pend.to) {
        this.finish(requestId, { status: 'delivered' });
      } else {
        // An implicit ack: our node heard another node pass it on. A direct
        // message may still get its own ack from the recipient.
        this.emit('message-update', pend.msgId, { status: 'sent' });
        if (pend.to === BROADCAST) this.finish(requestId, null);
      }
    }
  }

  finish(packetId, patch) {
    const pend = this.pending.get(packetId);
    if (!pend) return;
    clearTimeout(pend.timer);
    this.pending.delete(packetId);
    if (patch) this.emit('message-update', pend.msgId, patch);
  }

  // ---- sending --------------------------------------------------------------------

  // chat is "ch:<index>" or "dm:!<node id>". Returns the stored message.
  sendText(chat, text) {
    if (this.state !== 'connected') throw new Error('The Meshtastic node isn’t connected.');
    const bytes = Buffer.from(text, 'utf8');
    if (!bytes.length) throw new Error('Type a message first.');
    if (bytes.length > MAX_TEXT_BYTES) throw new Error(`Meshtastic messages can be ${MAX_TEXT_BYTES} bytes at most.`);
    let to, channel;
    const m = /^ch:(\d)$/.exec(chat);
    if (m) {
      channel = Number(m[1]);
      if (!this.channels.has(channel)) throw new Error('That channel isn’t set up on the node.');
      to = BROADCAST;
    } else if (chat.startsWith('dm:')) {
      to = parseNodeId(chat.slice(3));
      if (to === null) throw new Error('Unknown node.');
      channel = this.nodes.get(to)?.channel || 0;
    } else throw new Error('Unknown chat.');

    const id = crypto.randomInt(1, 0xffffffff);
    const packet = encode([
      field.fixed32(2, to),
      channel ? field.varint(3, channel) : null,
      field.msg(4, [field.varint(1, PORT.TEXT), field.bytes(2, bytes)]),
      field.fixed32(6, id),
      field.varint(9, this.radio.hopLimit || 3),
      field.varint(10, true),
    ]);
    this.send(encode([field.bytes(1, packet)]));

    const msg = {
      id: `mt-out-${id}`, network: 'meshtastic', chat, from: this.myNum != null ? nodeId(this.myNum) : null,
      fromName: this.selfName(), text, time: this.now(), outgoing: true, status: 'queued',
    };
    const timer = setTimeout(() => this.finish(id, null), ACK_WAIT_MS);
    timer.unref?.();
    this.pending.set(id, { msgId: msg.id, to, timer });
    return msg;
  }

  selfName() {
    const me = this.myNum != null && this.nodes.get(this.myNum);
    return me?.longName || me?.shortName || 'This node';
  }

  // ---- what the page sees -----------------------------------------------------------

  snapshot() {
    const nodes = [];
    for (const n of this.nodes.values()) {
      const isSelf = n.num === this.myNum;
      nodes.push({
        id: nodeId(n.num), network: 'meshtastic', name: n.longName || nodeId(n.num), short: n.shortName || null,
        kind: n.role || null, hw: n.hw || null, lat: n.lat ?? null, lon: n.lon ?? null, alt: n.alt ?? null,
        lastHeard: isSelf ? this.lastRx : n.lastHeard || null, snr: n.snr ?? null, rssi: n.rssi ?? null,
        hops: isSelf ? 0 : n.hops ?? null, battery: n.battery ?? null, voltage: n.voltage ?? null,
        chUtil: n.chUtil ?? null, airUtil: n.airUtil ?? null, uptime: n.uptime ?? null, env: n.env || null,
        viaMqtt: !!n.viaMqtt, favorite: !!n.favorite, licensed: !!n.licensed, isSelf, source: 'radio',
      });
    }
    const presetName = this.radio.preset && this.radio.preset !== 'Custom' ? this.radio.preset : 'Primary';
    const chats = [...this.channels.values()].sort((a, b) => a.index - b.index).map(c => ({
      key: `ch:${c.index}`, network: 'meshtastic', kind: 'channel', name: c.name || (c.primary ? presetName : `Channel ${c.index}`),
    }));
    const me = this.myNum != null ? nodes.find(n => n.isSelf) : null;
    return {
      ...this.linkStatus(),
      self: me ? { id: me.id, name: me.name, short: me.short, hw: me.hw, firmware: this.firmware, battery: me.battery, voltage: me.voltage, lat: me.lat, lon: me.lon } : null,
      radio: this.radio,
      nodes,
      chats,
      maxTextBytes: MAX_TEXT_BYTES,
    };
  }
}

function round(v, d) {
  if (v === undefined || v === null || !Number.isFinite(v)) return undefined;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

module.exports = { MeshtasticClient, frame, nodeId, parseNodeId, BROADCAST, PORT, MAX_TEXT_BYTES };
