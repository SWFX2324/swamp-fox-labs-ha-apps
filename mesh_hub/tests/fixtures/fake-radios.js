'use strict';
// Simulated radios for the tests and local previews: a Meshtastic node and a
// MeshCore companion radio, each a TCP server speaking the real framing and
// messages. Made-up nodes around Columbia, SC.
//
//   startMeshtastic({ port, chatter })  chatter: send a text and telemetry
//                                       every few seconds
//   startMeshCore({ port, chatter })
//
// Each returns { server, port, received, sockets, push(...) } so tests can see
// what the app sent and inject traffic.

const net = require('net');
const { encode, field, decode } = require('../../app/protobuf');

const HOME = { lat: 34.0007, lon: -81.0348 };

// ---- Meshtastic -------------------------------------------------------------------

const MT_ME = 0xa1b2c3d4;
const MT_NODES = [
  { num: 0x3f2a9b10, long: 'Congaree Ridge Router', short: 'CRR', hw: 43, role: 2, dlat: 0.11, dlon: -0.07, battery: 101, hops: 1, snr: 6.25 },
  { num: 0x51c0ffee, long: 'KR4XYZ Mobile', short: 'XYZ', hw: 71, role: 5, dlat: -0.03, dlon: 0.05, battery: 76, hops: 0, snr: 9.5 },
  { num: 0x0badf00d, long: 'Lake Murray Base', short: 'LMB', hw: 9, role: 12, dlat: 0.05, dlon: -0.2, battery: 92, hops: 2, snr: -4.75 },
  { num: 0x7e57ab1e, long: 'Irmo Solar Relay', short: 'ISR', hw: 31, role: 11, dlat: 0.09, dlon: -0.15, battery: 100, hops: 1, snr: 2.0 },
  { num: 0x12345678, long: 'Cayce Hiker', short: 'CAY', hw: 7, role: 0, dlat: -0.06, dlon: -0.02, battery: 34, hops: 3, snr: -11.5 },
  { num: 0x2468ace0, long: 'No GPS Node', short: 'NGP', hw: 48, role: 0, battery: 58, hops: 2, snr: -7 },
];

const mtFrame = payload => Buffer.concat([Buffer.from([0x94, 0xc3, payload.length >> 8, payload.length & 0xff]), payload]);
const fromRadio = parts => mtFrame(encode(parts));

function mtUser(n) {
  return [field.string(1, '!' + n.num.toString(16).padStart(8, '0')), field.string(2, n.long), field.string(3, n.short), field.varint(5, n.hw), n.role ? field.varint(7, n.role) : null];
}
function mtPosition(lat, lon, alt = 90) {
  return [field.sfixed32(1, Math.round(lat * 1e7)), field.sfixed32(2, Math.round(lon * 1e7)), field.varint(3, alt), field.fixed32(4, Math.floor(Date.now() / 1000))];
}
function mtNodeInfo(n, now) {
  return field.msg(4, [
    field.varint(1, n.num),
    field.msg(2, mtUser(n)),
    n.dlat !== undefined ? field.msg(3, mtPosition(HOME.lat + n.dlat, HOME.lon + n.dlon)) : null,
    n.snr !== undefined ? field.float(4, n.snr) : null,
    field.fixed32(5, Math.floor(now / 1000) - (n.ago ?? 300)),
    field.msg(6, [field.varint(1, n.battery), field.float(2, 3.7 + n.battery / 300), field.float(3, 12.4), field.float(4, 1.8), field.varint(5, 86400)]),
    n.hops !== undefined ? field.varint(9, n.hops) : null,
  ]);
}
function mtPacket({ from, to = 0xffffffff, channel = 0, port, payload, id = Math.floor(Math.random() * 0xffffffff), snr = 5.5, rssi = -97, hopStart = 3, hopLimit = 2, requestId }) {
  return field.msg(2, [
    field.fixed32(1, from), field.fixed32(2, to), channel ? field.varint(3, channel) : null,
    field.msg(4, [field.varint(1, port), field.bytes(2, payload), requestId ? field.fixed32(6, requestId) : null]),
    field.fixed32(6, id), field.fixed32(7, Math.floor(Date.now() / 1000)), field.float(8, snr),
    field.varint(9, hopLimit), field.varint(12, rssi), field.varint(15, hopStart),
  ]);
}

const MT_CHATTER = [
  [0x51c0ffee, 'Anyone on this morning? Heading up I-26.'],
  [0x3f2a9b10, 'Router check-in, all good on the ridge.'],
  [0x0badf00d, 'Copy, hearing you 2 hops out at the lake.'],
  [0x12345678, 'Trail at Congaree is flooded past the boardwalk FYI'],
];

function startMeshtastic({ port = 0, chatter = false, nodes = MT_NODES } = {}) {
  const received = [];
  const sockets = new Set();
  const server = net.createServer(sock => {
    sockets.add(sock);
    let buf = Buffer.alloc(0);
    let timer = null;
    sock.on('close', () => { sockets.delete(sock); clearInterval(timer); });
    sock.on('error', () => {});
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        if (buf[0] !== 0x94 || buf[1] !== 0xc3) { buf = buf.subarray(1); continue; }
        const len = buf.readUInt16BE(2);
        if (buf.length < 4 + len) break;
        const msg = decode(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
        received.push(msg);
        if (msg.has(3)) {
          const now = Date.now();
          const out = [
            fromRadio([field.msg(3, [field.varint(1, MT_ME), field.varint(15, nodes.length + 1)])]),
            fromRadio([field.msg(13, [field.string(1, '2.7.15.567b8ea'), field.varint(9, 43)])]),
            fromRadio([mtNodeInfo({ num: MT_ME, long: 'Swamp Fox Base', short: 'SFB', hw: 43, role: 12, dlat: 0.002, dlon: 0.001, battery: 101, ago: 0 }, now)]),
            ...nodes.map(n => fromRadio([mtNodeInfo(n, now)])),
            fromRadio([field.msg(5, [field.msg(6, [field.varint(1, true), field.varint(2, 0), field.varint(7, 1), field.varint(8, 3)])])]),
            fromRadio([field.msg(10, [field.varint(1, 0), field.msg(2, [field.string(3, '')]), field.varint(3, 1)])]),
            fromRadio([field.msg(10, [field.varint(1, 1), field.msg(2, [field.string(3, 'SC-Mesh')]), field.varint(3, 2)])]),
            fromRadio([field.msg(10, [field.varint(1, 2), field.msg(2, [field.string(3, '')]), field.varint(3, 0)])]),
            fromRadio([field.varint(7, msg.u32(3))]),
          ];
          for (const f of out) sock.write(f);
          if (chatter) {
            let i = 0;
            timer = setInterval(() => {
              const [from, text] = MT_CHATTER[i++ % MT_CHATTER.length];
              sock.write(fromRadio([mtPacket({ from, channel: i % 3 === 0 ? 1 : 0, port: 1, payload: Buffer.from(text) })]));
              const n = nodes[i % nodes.length];
              sock.write(fromRadio([mtPacket({ from: n.num, port: 67, payload: encode([field.fixed32(1, Math.floor(Date.now() / 1000)), field.msg(2, [field.varint(1, Math.max(5, n.battery - (i % 7))), field.float(2, 3.9), field.float(3, 10 + i % 9)])]) })]));
            }, 6000);
          }
        } else if (msg.has(1)) {
          // A packet from the app: ack it the way the mesh would.
          const p = msg.msg(1);
          const id = p.fixed32(6), to = p.fixed32(2);
          setTimeout(() => {
            if (sock.destroyed) return;
            const from = to === 0xffffffff ? MT_ME : to;
            sock.write(fromRadio([mtPacket({ from, to: MT_ME, port: 5, payload: encode([field.varint(3, 0)]), requestId: id })]));
            if (to !== 0xffffffff && chatter) {
              setTimeout(() => !sock.destroyed && sock.write(fromRadio([mtPacket({ from: to, to: MT_ME, port: 1, payload: Buffer.from('Got it, thanks! 73') })])), 2500);
            }
          }, 400);
        }
      }
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({
    server, port: server.address().port, received, sockets, me: MT_ME,
    push: parts => { for (const s of sockets) s.write(fromRadio(parts)); },
    packet: opts => { for (const s of sockets) s.write(fromRadio([mtPacket(opts)])); },
  })));
}

// ---- MeshCore ----------------------------------------------------------------------

const MC_SELF_KEY = Buffer.from('5f0c'.padEnd(64, 'a1'), 'hex');
const mcKey = seed => Buffer.from(seed.padEnd(64, seed), 'hex').subarray(0, 32);
const MC_CONTACTS = [
  { key: mcKey('7c45'), type: 2, name: 'Gilbert Ridge RPT', dlat: -0.04, dlon: -0.32, hops: 0 },
  { key: mcKey('9a01'), type: 2, name: 'Downtown Columbia RPT', dlat: 0.0, dlon: 0.01, hops: 0 },
  { key: mcKey('c3d2'), type: 1, name: 'Ethan T-Deck', dlat: 0.02, dlon: 0.03, hops: 1 },
  { key: mcKey('e5f6'), type: 1, name: 'W4SC Heltec', dlat: -0.08, dlon: 0.09, hops: 2 },
  { key: mcKey('b7b7'), type: 3, name: 'Midlands Room', dlat: 0.06, dlon: -0.05, hops: 1 },
  { key: mcKey('d00d'), type: 4, name: 'River Gauge Sensor', dlat: -0.01, dlon: -0.06, hops: 1 },
];

function mcFrame(payload) {
  const h = Buffer.alloc(3);
  h[0] = 0x3e;
  h.writeUInt16LE(payload.length, 1);
  return Buffer.concat([h, payload]);
}
const i32 = v => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const u16 = v => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const fixed = (s, n) => { const b = Buffer.alloc(n); Buffer.from(s).copy(b, 0, 0, n - 1); return b; };

function mcContact(code, c) {
  const path = Buffer.alloc(64);
  return Buffer.concat([
    Buffer.from([code]), c.key, Buffer.from([c.type, c.fav ? 1 : 0, c.hops === null ? 0xff : c.hops]), path, fixed(c.name, 32),
    u32(Math.floor(Date.now() / 1000) - (c.ago ?? 900)), i32(Math.round((HOME.lat + c.dlat) * 1e6)), i32(Math.round((HOME.lon + c.dlon) * 1e6)), u32(Math.floor(Date.now() / 1000)),
  ]);
}

const MC_CHATTER = [
  { channel: 0, text: 'Gilbert Ridge RPT: Repeater up, 12.9V solar' },
  { dm: 2, text: 'Are you coming to the hamfest Saturday?' },
  { channel: 1, text: 'W4SC Heltec: Net tonight at 8, #sc channel' },
  { channel: 0, text: 'Ethan T-Deck: testing from the car' },
];

function startMeshCore({ port = 0, chatter = false, contacts = MC_CONTACTS } = {}) {
  const received = [];
  const sockets = new Set();
  const server = net.createServer(sock => {
    sockets.add(sock);
    let buf = Buffer.alloc(0);
    const queue = [];
    sock.mcQueue = queue;
    let timer = null;
    let ack = 1000;
    let protocol = 0;
    sock.on('close', () => { sockets.delete(sock); clearInterval(timer); });
    sock.on('error', () => {});
    const out = p => !sock.destroyed && sock.write(mcFrame(p));
    const queueMessage = m => {
      const ts = u32(Math.floor(Date.now() / 1000));
      if (m.channel !== undefined) {
        const text = Buffer.from(m.text);
        queue.push(protocol >= 3 ? Buffer.concat([Buffer.from([0x11, 26, 0, 0, m.channel, m.hops ?? 1, 0]), ts, text]) : Buffer.concat([Buffer.from([0x08, m.channel, 1, 0]), ts, text]));
      } else {
        const c = contacts[m.dm];
        queue.push(Buffer.concat([Buffer.from([0x10, 38, 0, 0]), c.key.subarray(0, 6), Buffer.from([c.hops, 0]), ts, Buffer.from(m.text)]));
      }
      out(Buffer.from([0x83]));
    };
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 3) {
        if (buf[0] !== 0x3c) { buf = buf.subarray(1); continue; }
        const len = buf.readUInt16LE(1);
        if (buf.length < 3 + len) break;
        const f = Buffer.from(buf.subarray(3, 3 + len));
        buf = buf.subarray(3 + len);
        received.push(f);
        switch (f[0]) {
          case 0x16: protocol = f[1]; out(Buffer.concat([Buffer.from([0x0d, 8, 175, 8]), u32(123456), fixed('19 Nov 2026', 12), fixed('Heltec V3', 40), fixed('v1.10.0', 20), Buffer.from([0, 0])])); break;
          case 0x01: out(Buffer.concat([Buffer.from([0x05, 1, 22, 22]), MC_SELF_KEY, i32(Math.round((HOME.lat - 0.001) * 1e6)), i32(Math.round((HOME.lon + 0.002) * 1e6)), Buffer.from([0, 0, 0, 0]), u32(910525), u32(62500), Buffer.from([7, 5]), Buffer.from('Swamp Fox MC')])); break;
          case 0x06: out(Buffer.from([0x00])); break;
          case 0x04:
            out(Buffer.concat([Buffer.from([0x02]), u32(contacts.length)]));
            for (const c of contacts) out(mcContact(0x03, c));
            out(Buffer.concat([Buffer.from([0x04]), u32(Math.floor(Date.now() / 1000))]));
            break;
          case 0x1f: {
            const names = ['Public', '#sc'];
            if (f[1] >= 4) out(Buffer.from([0x01, 2]));
            else out(Buffer.concat([Buffer.from([0x12, f[1]]), fixed(names[f[1]] || '', 32), Buffer.alloc(16, names[f[1]] ? 7 : 0)]));
            break;
          }
          case 0x14: out(Buffer.concat([Buffer.from([0x0c]), u16(3950), u32(120), u32(1024)])); break;
          case 0x0a: out(queue.length ? queue.shift() : Buffer.from([0x0a])); break;
          case 0x03: out(Buffer.from([0x00])); break;
          case 0x02: {
            const a = ack++;
            out(Buffer.concat([Buffer.from([0x06, 0]), u32(a), u32(4000)]));
            setTimeout(() => out(Buffer.concat([Buffer.from([0x82]), u32(a), u32(1830)])), 600);
            if (chatter) setTimeout(() => queueMessage({ dm: contacts.findIndex(c => c.key.subarray(0, 6).equals(f.subarray(7, 13))), text: 'Roger that 👍' }), 3000);
            break;
          }
          default: out(Buffer.from([0x01, 1]));
        }
      }
    });
    if (chatter) {
      let i = 0;
      timer = setInterval(() => {
        queueMessage(MC_CHATTER[i++ % MC_CHATTER.length]);
        out(Buffer.concat([Buffer.from([0x80]), contacts[i % contacts.length].key]));
        out(Buffer.from([0x88, 40, 0xa6, 1, 2, 3]));
      }, 7000);
    }
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({
    server, port: server.address().port, received, sockets, contacts,
    push: payload => { for (const s of sockets) s.write(mcFrame(payload)); },
    // Queue raw message frames on the radio and tell the app (MSG_WAITING).
    queue: (...frames) => { for (const s of sockets) { s.mcQueue.push(...frames); s.write(mcFrame(Buffer.from([0x83]))); } },
  })));
}

module.exports = { startMeshtastic, startMeshCore, HOME, MT_ME, MT_NODES, MC_CONTACTS };
