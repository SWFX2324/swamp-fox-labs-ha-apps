'use strict';
// The protobuf codec and both radio clients, against the simulated radios in
// fixtures/fake-radios.js (real framing over real TCP on localhost).
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { decode, encode, field } = require('../app/protobuf');
const { MeshtasticClient, frame: mtFrame, nodeId, parseNodeId } = require('../app/meshtastic');
const { MeshCoreClient, parseContact, batteryPercent } = require('../app/meshcore');
const { startMeshtastic, startMeshCore, MT_ME, MT_NODES, MC_CONTACTS } = require('./fixtures/fake-radios');

const quiet = { log() {}, warn() {}, error() {} };
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('timed out waiting');
};

// ---- protobuf ---------------------------------------------------------------------

test('protobuf: every field type round-trips, unknown fields are kept and ignored', () => {
  const buf = encode([
    field.varint(1, 300), field.varint(2, -97), field.fixed32(3, 0xffffffff), field.sfixed32(4, -812345678),
    field.float(5, 6.25), field.string(6, 'héllo'), field.msg(7, [field.varint(1, 1), field.bytes(2, Buffer.from([1, 2, 3]))]),
    field.varint(99, true), field.varint(8, 1), field.varint(8, 2),
  ]);
  const m = decode(buf);
  assert.equal(m.u32(1), 300);
  assert.equal(m.i32(2), -97);
  assert.equal(m.fixed32(3), 0xffffffff);
  assert.equal(m.sfixed32(4), -812345678);
  assert.equal(m.float(5), 6.25);
  assert.equal(m.str(6), 'héllo');
  assert.deepEqual([...m.msg(7).bytes(2)], [1, 2, 3]);
  assert.equal(m.bool(99), true);
  assert.equal(m.u32(8), 2, 'the last value of a repeated scalar wins');
  assert.equal(m.u32(42), undefined);
  assert.equal(m.u32(42, 7), 7);
  // A field read as the wrong type gives the default, not garbage.
  assert.equal(m.str(1), undefined);
});

test('protobuf: truncated input throws instead of reading past the end', () => {
  const buf = encode([field.string(1, 'abcdef')]);
  assert.throws(() => decode(buf.subarray(0, 4)));
  assert.throws(() => decode(Buffer.from([0x08, 0xff])));
});

test('node ids', () => {
  assert.equal(nodeId(0x0badf00d), '!0badf00d');
  assert.equal(parseNodeId('!0badf00d'), 0x0badf00d);
  assert.equal(parseNodeId('0badf00d'), null);
  assert.equal(parseNodeId('!xyz'), null);
});

// ---- Meshtastic ------------------------------------------------------------------

async function meshtastic(t, opts) {
  const radio = await startMeshtastic(opts);
  const client = new MeshtasticClient({ host: '127.0.0.1', port: radio.port, log: quiet });
  const messages = [], updates = [];
  client.on('message', m => messages.push(m));
  client.on('message-update', (id, p) => updates.push([id, p]));
  client.start();
  t.after(() => { client.stop(); radio.server.close(); for (const s of radio.sockets) s.destroy(); });
  await until(() => client.state === 'connected');
  return { radio, client, messages, updates };
}

test('meshtastic: syncs its node, channels, radio settings and node list', async t => {
  const { client, radio } = await meshtastic(t);
  const s = client.snapshot();
  assert.equal(s.state, 'connected');
  assert.equal(s.self.id, nodeId(MT_ME));
  assert.equal(s.self.name, 'Swamp Fox Base');
  assert.equal(s.self.firmware, '2.7.15.567b8ea');
  assert.deepEqual(s.radio, { region: 'US', preset: 'LongFast', hopLimit: 3 });
  assert.equal(s.nodes.length, MT_NODES.length + 1);
  const ridge = s.nodes.find(n => n.name === 'Congaree Ridge Router');
  assert.equal(ridge.kind, 'ROUTER');
  assert.equal(ridge.hw, 'HELTEC_V3');
  assert.equal(ridge.hops, 1);
  assert.equal(ridge.battery, 101);
  assert.ok(Math.abs(ridge.lat - 34.1107) < 1e-6 && Math.abs(ridge.lon - -81.1048) < 1e-6);
  assert.equal(s.nodes.find(n => n.name === 'No GPS Node').lat, null);
  // The primary channel has no name, so it's called by its preset; the disabled one is left out.
  assert.deepEqual(s.chats.map(c => [c.key, c.name]), [['ch:0', 'LongFast'], ['ch:1', 'SC-Mesh']]);
  // The first thing sent was want_config_id, echoed back to finish the sync.
  assert.ok(radio.received[0].u32(3) > 0);
});

test('meshtastic: channel and direct texts become messages; other nodes’ DMs and our own echoes don’t', async t => {
  const { radio, messages } = await meshtastic(t);
  radio.packet({ from: 0x51c0ffee, channel: 1, port: 1, payload: Buffer.from('On SC-Mesh'), snr: -3.25, rssi: -110, hopStart: 3, hopLimit: 1 });
  radio.packet({ from: 0x0badf00d, to: MT_ME, port: 1, payload: Buffer.from('Just for you') });
  radio.packet({ from: 0x0badf00d, to: 0x12345678, port: 1, payload: Buffer.from('Not for us') });
  radio.packet({ from: MT_ME, port: 1, payload: Buffer.from('our own') });
  await until(() => messages.length >= 2);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(messages.length, 2);
  assert.deepEqual(
    { chat: messages[0].chat, from: messages[0].from, fromName: messages[0].fromName, text: messages[0].text, snr: messages[0].snr, rssi: messages[0].rssi, hops: messages[0].hops },
    { chat: 'ch:1', from: '!51c0ffee', fromName: 'KR4XYZ Mobile', text: 'On SC-Mesh', snr: -3.25, rssi: -110, hops: 2 },
  );
  assert.equal(messages[1].chat, 'dm:!0badf00d');
});

test('meshtastic: position, user and telemetry packets update the node', async t => {
  const { radio, client } = await meshtastic(t);
  radio.packet({ from: 0x2468ace0, port: 3, payload: encode([field.sfixed32(1, 340500000), field.sfixed32(2, -810500000), field.varint(3, 120)]) });
  radio.packet({ from: 0x2468ace0, port: 4, payload: encode([field.string(2, 'Renamed Node'), field.string(3, 'RN'), field.varint(5, 50), field.varint(7, 5)]) });
  radio.packet({ from: 0x2468ace0, port: 67, payload: encode([field.msg(2, [field.varint(1, 12), field.float(2, 3.41)]), field.msg(3, [field.float(1, 21.5), field.float(2, 64), field.float(3, 1013.2)])]) });
  radio.packet({ from: 0x2468ace0, port: 67, payload: encode([field.msg(3, [field.float(1, 22.5)])]) });
  const n = await until(() => client.snapshot().nodes.find(x => x.name === 'Renamed Node' && x.env?.temperature === 22.5));
  assert.equal(n.lat, 34.05);
  assert.equal(n.lon, -81.05);
  assert.equal(n.alt, 120);
  assert.equal(n.hw, 'T_DECK');
  assert.equal(n.kind, 'TRACKER');
  assert.equal(n.battery, 12);
  assert.equal(n.voltage, 3.41);
});

test('meshtastic: sending writes a proper packet; acks mark it sent, then delivered', async t => {
  const { radio, client, updates } = await meshtastic(t);
  assert.throws(() => client.sendText('ch:5', 'x'), /channel isn’t set up/);
  assert.throws(() => client.sendText('ch:0', 'x'.repeat(201)), /200 bytes/);
  assert.throws(() => client.sendText('ch:0', ''), /Type a message/);

  const msg = client.sendText('dm:!51c0ffee', 'hello there');
  assert.equal(msg.status, 'queued');
  assert.equal(msg.fromName, 'Swamp Fox Base');
  const sent = await until(() => radio.received.find(m => m.has(1)));
  const p = sent.msg(1);
  assert.equal(p.fixed32(2), 0x51c0ffee);
  assert.equal(p.bool(10), true, 'want_ack');
  assert.equal(p.u32(9), 3, 'hop limit from the node’s LoRa config');
  assert.equal(p.msg(4).u32(1), 1);
  assert.equal(p.msg(4).str(2), 'hello there');
  await until(() => updates.some(([id, u]) => id === msg.id && u.status === 'delivered'));

  const bc = client.sendText('ch:1', 'to everyone');
  const p2 = await until(() => radio.received.filter(m => m.has(1))[1]?.msg(1));
  assert.equal(p2.fixed32(2), 0xffffffff);
  assert.equal(p2.u32(3), 1);
  await until(() => updates.some(([id, u]) => id === bc.id && u.status === 'sent'));
});

test('meshtastic: a routing error marks the message failed with the reason', async t => {
  const { radio, client, updates } = await meshtastic(t);
  const msg = client.sendText('dm:!12345678', 'are you there');
  const id = (await until(() => radio.received.find(m => m.has(1)))).msg(1).fixed32(6);
  radio.packet({ from: MT_ME, to: MT_ME, port: 5, payload: encode([field.varint(3, 5)]), requestId: id });
  // (The simulator's own ack follows; a failed message stays failed.)
  await until(() => updates.some(([mid, u]) => mid === msg.id && u.status === 'failed' && /retries/.test(u.error)));
});

test('meshtastic: frames split across reads, debug text and junk between frames are handled', () => {
  const client = new MeshtasticClient({ host: '', log: quiet });
  client.configNonce = 77;
  const frames = Buffer.concat([
    Buffer.from('DEBUG | some log line\n'),
    mtFrame(encode([field.msg(3, [field.varint(1, 0x01020304)])])),
    Buffer.from([0x94, 0x00, 0x13]),          // a false start
    mtFrame(encode([field.msg(10, [field.varint(1, 0), field.msg(2, [field.string(3, 'Main')]), field.varint(3, 1)])])),
    mtFrame(encode([field.varint(7, 77)])),
  ]);
  for (let i = 0; i < frames.length; i += 5) {
    client.rx = client.rx?.length ? Buffer.concat([client.rx, frames.subarray(i, i + 5)]) : frames.subarray(i, i + 5);
    client.onData();
  }
  assert.equal(client.myNum, 0x01020304);
  assert.equal(client.channels.get(0).name, 'Main');
  assert.equal(client.state, 'connected');
});

test('meshtastic: reconnects after the node drops the connection', async t => {
  const { radio, client } = await meshtastic(t);
  client.retryMs = 50;
  for (const s of radio.sockets) s.destroy();
  await until(() => client.state === 'error');
  assert.match(client.error, /closed|reset/i);
  await until(() => client.state === 'connected', 5000);
});

test('meshtastic: an address with nothing listening reports a clear error', async t => {
  const port = await new Promise(r => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
  const client = new MeshtasticClient({ host: '127.0.0.1', port, log: quiet });
  client.start();
  t.after(() => client.stop());
  await until(() => client.state === 'error');
  assert.match(client.error, /refused the connection/);
});

// ---- MeshCore ---------------------------------------------------------------------

async function meshcore(t, opts) {
  const radio = await startMeshCore(opts);
  const client = new MeshCoreClient({ host: '127.0.0.1', port: radio.port, log: quiet });
  const messages = [], updates = [];
  client.on('message', m => messages.push(m));
  client.on('message-update', (id, p) => updates.push([id, p]));
  client.start();
  t.after(() => { client.stop(); radio.server.close(); for (const s of radio.sockets) s.destroy(); });
  await until(() => client.state === 'connected');
  return { radio, client, messages, updates };
}

test('meshcore: asks for protocol 3, then reads itself, contacts, channels and battery', async t => {
  const { radio, client } = await meshcore(t);
  assert.deepEqual([...radio.received[0]], [0x16, 3], 'DEVICE_QUERY first, asking for v3 messages');
  assert.equal(radio.received[1][0], 0x01);
  assert.equal(radio.received[1].subarray(8).toString(), 'Mesh Hub');
  const s = client.snapshot();
  assert.equal(s.self.name, 'Swamp Fox MC');
  assert.equal(s.self.firmware, 'v1.10.0');
  assert.equal(s.self.hw, 'Heltec V3');
  assert.equal(s.self.voltage, 3.95);
  assert.equal(s.self.battery, 76);
  assert.deepEqual({ freq: s.radio.freq, bw: s.radio.bw, sf: s.radio.sf, cr: s.radio.cr, tx: s.radio.txPower }, { freq: 910.525, bw: 62.5, sf: 7, cr: 5, tx: 22 });
  assert.equal(s.nodes.length, MC_CONTACTS.length + 1);
  const rpt = s.nodes.find(n => n.name === 'Gilbert Ridge RPT');
  assert.equal(rpt.kind, 'Repeater');
  assert.equal(rpt.hops, 0);
  assert.ok(Math.abs(rpt.lat - 33.9607) < 1e-6);
  assert.equal(s.nodes.find(n => n.name === 'Midlands Room').kind, 'Room server');
  assert.deepEqual(s.chats.map(c => [c.key, c.name]), [['ch:0', 'Public'], ['ch:1', '#sc']]);
});

test('meshcore: queued messages are drained on MSG_WAITING, with SNR, hops and the sender', async t => {
  const { radio, messages } = await meshcore(t);
  const ts = Buffer.alloc(4); ts.writeUInt32LE(Math.floor(Date.now() / 1000));
  // V3 channel message: SNR byte 26 = 6.5 dB, 2 hops, sender's name in the text.
  const ch = Buffer.concat([Buffer.from([0x11, 26, 0, 0, 1, 2, 0]), ts, Buffer.from('W4SC Heltec: net at 8')]);
  // V3 direct message: SNR -10 (0xF6) = -2.5 dB, routed directly (0xFF).
  const dm = Buffer.concat([Buffer.from([0x10, 0xf6, 0, 0]), MC_CONTACTS[2].key.subarray(0, 6), Buffer.from([0xff, 0]), ts, Buffer.from('direct hi')]);
  // A CLI reply (text type 1) from a repeater: not chat.
  const cli = Buffer.concat([Buffer.from([0x10, 0, 0, 0]), MC_CONTACTS[0].key.subarray(0, 6), Buffer.from([0, 1]), ts, Buffer.from('cli reply')]);
  radio.queue(ch, dm, cli);
  await until(() => messages.length >= 2);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(messages.length, 2, 'the CLI reply is not a chat message');
  assert.deepEqual({ chat: messages[0].chat, fromName: messages[0].fromName, text: messages[0].text, snr: messages[0].snr, hops: messages[0].hops },
    { chat: 'ch:1', fromName: 'W4SC Heltec', text: 'net at 8', snr: 6.5, hops: 2 });
  assert.equal(messages[1].chat, `dm:${MC_CONTACTS[2].key.toString('hex')}`);
  assert.equal(messages[1].fromName, 'Ethan T-Deck');
  assert.equal(messages[1].snr, -2.5);
  assert.equal(messages[1].hops, null);
});

test('meshcore: a direct message is sent, then confirmed delivered by the ack', async t => {
  const { radio, client, updates } = await meshcore(t);
  const key = MC_CONTACTS[3].key.toString('hex');
  assert.throws(() => client.sendText(`dm:${'0'.repeat(64)}`, 'x'), /isn’t on the radio/);
  assert.throws(() => client.sendText('ch:9', 'x'), /channel isn’t set up/);
  assert.throws(() => client.sendText('ch:0', 'x'.repeat(141)), /140 bytes/);
  const msg = client.sendText(`dm:${key}`, 'hello');
  await until(() => updates.some(([id, u]) => id === msg.id && u.status === 'sent'));
  const f = radio.received.find(x => x[0] === 0x02);
  assert.equal(f[1], 0, 'plain text');
  assert.equal(f.subarray(7, 13).toString('hex'), key.slice(0, 12), 'the contact’s key prefix');
  assert.equal(f.subarray(13).toString(), 'hello');
  await until(() => updates.some(([id, u]) => id === msg.id && u.status === 'delivered' && u.tripMs === 1830));

  const chMsg = client.sendText('ch:1', 'on the channel');
  await until(() => updates.some(([id, u]) => id === chMsg.id && u.status === 'sent'));
  const c = radio.received.find(x => x[0] === 0x03);
  assert.deepEqual([c[1], c[2]], [0, 1]);
  assert.equal(c.subarray(7).toString(), 'on the channel');
});

test('meshcore: adverts update a contact; new adverts add one; deletions remove one', async t => {
  const { radio, client } = await meshcore(t);
  const before = client.snapshot().nodes.find(n => n.name === 'W4SC Heltec').lastHeard;
  radio.push(Buffer.concat([Buffer.from([0x80]), MC_CONTACTS[3].key]));
  await until(() => client.snapshot().nodes.find(n => n.name === 'W4SC Heltec').lastHeard > before);
  const record = Buffer.alloc(148);
  record[0] = 0x8a;
  Buffer.alloc(32, 0x42).copy(record, 1);
  record[33] = 2; record[35] = 0xff;
  Buffer.from('New Repeater').copy(record, 100);
  record.writeInt32LE(34100000, 136); record.writeInt32LE(-81200000, 140);
  radio.push(record);
  const added = await until(() => client.snapshot().nodes.find(n => n.name === 'New Repeater'));
  assert.equal(added.hops, null);
  assert.equal(added.lat, 34.1);
  radio.push(Buffer.concat([Buffer.from([0x8f]), MC_CONTACTS[0].key]));
  await until(() => !client.snapshot().nodes.find(n => n.name === 'Gilbert Ridge RPT'));
});

test('meshcore: frames split across reads and junk before a frame are handled', () => {
  const client = new MeshCoreClient({ host: '', log: quiet });
  const got = [];
  client.handleFrame = f => got.push(f);
  const h = (p) => { const b = Buffer.alloc(3); b[0] = 0x3e; b.writeUInt16LE(p.length, 1); return Buffer.concat([b, p]); };
  const data = Buffer.concat([Buffer.from('xx'), h(Buffer.from([0x0a])), h(Buffer.from([0x0c, 1, 2, 3])), Buffer.from([0x3e, 0, 0]), h(Buffer.from([0x83]))]);
  for (let i = 0; i < data.length; i += 2) {
    client.rx = client.rx?.length ? Buffer.concat([client.rx, data.subarray(i, i + 2)]) : data.subarray(i, i + 2);
    client.onData();
  }
  assert.deepEqual(got.map(f => f[0]), [0x0a, 0x0c, 0x83]);
});

test('meshcore: contact records and battery estimates', () => {
  const r = Buffer.alloc(148);
  r[0] = 3; r[33] = 1; r[34] = 1; r[35] = 0x42;
  Buffer.from('Name').copy(r, 100);
  assert.deepEqual({ ...parseContact(r), key: undefined, lastAdvert: undefined }, { key: undefined, type: 1, flags: 1, hops: 2, name: 'Name', lastAdvert: undefined, lat: null, lon: null });
  assert.equal(parseContact(Buffer.alloc(100)), null);
  assert.equal(batteryPercent(4200), 100);
  assert.equal(batteryPercent(4300), 100);
  assert.equal(batteryPercent(3000), 0);
  assert.equal(batteryPercent(3800), 52);
  assert.equal(batteryPercent(0), null);
});

test('meshcore: a command the radio doesn’t answer times out and the queue moves on', async () => {
  const client = new MeshCoreClient({ host: '', log: quiet });
  client.write = () => true;
  const p = client.command(Buffer.from([0x14]), [0x0c]);
  const q = client.command(Buffer.from([0x05]), [0x09]);
  client.handleFrame(Buffer.from([0x01, 6]));
  await assert.rejects(p, /refused/);
  client.handleFrame(Buffer.from([0x09, 0, 0, 0, 0]));
  const [f] = await q;
  assert.equal(f[0], 0x09);
});
