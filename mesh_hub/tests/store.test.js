'use strict';
// The public map reader and the message store.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebMaps, ArraySplitter, distanceKm } = require('../app/webmaps');
const { MessageStore, KEEP_PER_NETWORK } = require('../app/messages');

const quiet = { log() {}, warn() {}, error() {} };
const HOME = { lat: 34.0007, lon: -81.0348 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-hub-test-'));

// ---- web maps ---------------------------------------------------------------------

// The fixture's fetch, without preloading it into this process.
function fixtureFetch() {
  const saved = globalThis.fetch;
  delete require.cache[require.resolve('./fixtures/fake-web')];
  require('./fixtures/fake-web');
  const f = globalThis.fetch;
  globalThis.fetch = saved;
  return f;
}

test('distance', () => {
  assert.ok(Math.abs(distanceKm(34, -81, 35, -81) - 111.2) < 0.2);
  assert.equal(distanceKm(34, -81, 34, -81), 0);
});

test('the splitter finds each object, even with braces and quotes in strings and any chunking', () => {
  const objs = [{ a: 1, n: { b: '}' } }, { s: 'say "{hi}"\\' }, { t: [1, { u: 2 }] }];
  const text = JSON.stringify(objs);
  for (const size of [1, 3, 7, 1000]) {
    const got = [];
    const sp = new ArraySplitter(s => got.push(JSON.parse(s)));
    for (let i = 0; i < text.length; i += size) sp.push(text.slice(i, i + size));
    assert.deepEqual(got, objs, `chunk size ${size}`);
  }
});

test('public nodes: only those within the radius and recently heard, nearest first', async () => {
  const w = new WebMaps({ radiusKm: 100, fetchImpl: fixtureFetch(), log: quiet });
  w.center = HOME;
  await w.refresh('meshtastic');
  await w.refresh('meshcore');
  w.stop();
  const s = w.snapshot();
  const mt = s.meshtastic.nodes.map(n => n.name);
  assert.ok(mt.includes('Lexington Porch'));
  assert.ok(!mt.includes('Berlin Node'), 'far away');
  assert.ok(!mt.includes('Stale Columbia'), 'not heard for days');
  assert.ok(!mt.includes('No position'));
  const d = s.meshtastic.nodes.map(n => n.distanceKm);
  assert.deepEqual(d, [...d].sort((a, b) => a - b));
  const lex = s.meshtastic.nodes.find(n => n.name === 'Lexington Porch');
  assert.equal(lex.id, '!' + (900000000 + 7919).toString(16));
  assert.equal(lex.kind, 'CLIENT_BASE');
  assert.equal(lex.source, 'web');
  assert.ok(Math.abs(lex.lat - 33.9807) < 1e-6);

  const mc = s.meshcore.nodes.map(n => n.name);
  assert.ok(mc.includes('Brace {"} Test'));
  assert.ok(mc.includes('Fort Jackson RPT'));
  assert.ok(!mc.includes('Munich RPT'));
  const fj = s.meshcore.nodes.find(n => n.name === 'Fort Jackson RPT');
  assert.equal(fj.kind, 'Repeater');
  assert.deepEqual(fj.radio, { freq: 910.525, bw: 62.5, sf: 7, cr: 5 });
});

test('public nodes: a failed download keeps the last list, says why, and is saved and reloaded', async () => {
  const dir = tmp();
  const file = path.join(dir, 'public.json');
  const w = new WebMaps({ radiusKm: 100, stateFile: file, fetchImpl: fixtureFetch(), log: quiet });
  w.center = HOME;
  await w.refresh('meshtastic');
  w.stop();
  const count = w.snapshot().meshtastic.nodes.length;
  assert.ok(count > 0);
  w.fetch = async () => new Response('no', { status: 503 });
  await w.refresh('meshtastic');
  w.stop();
  assert.equal(w.snapshot().meshtastic.nodes.length, count);
  assert.match(w.snapshot().meshtastic.error, /HTTP 503/);

  const again = new WebMaps({ radiusKm: 100, stateFile: file, log: quiet });
  assert.equal(again.snapshot().meshtastic.nodes.length, count);
  // A different radius doesn't reuse a list cut to the old one.
  const other = new WebMaps({ radiusKm: 50, stateFile: file, log: quiet });
  assert.equal(other.snapshot().meshtastic.nodes.length, 0);
});

test('public nodes: nothing is fetched when turned off or before the centre is known', async () => {
  let calls = 0;
  const w = new WebMaps({ enabled: false, fetchImpl: async () => { calls++; return new Response('{}'); }, log: quiet });
  w.setCenter(HOME);
  const w2 = new WebMaps({ fetchImpl: async () => { calls++; return new Response('{}'); }, log: quiet });
  w2.start();
  await new Promise(r => setTimeout(r, 30));
  w.stop(); w2.stop();
  assert.equal(calls, 0);
});

// ---- messages ---------------------------------------------------------------------

const msg = (id, extra = {}) => ({ id, network: 'meshtastic', chat: 'ch:0', fromName: 'X', text: id, time: Date.now(), outgoing: false, ...extra });

test('messages: duplicates are ignored, updates bump the revision, since() returns changes', () => {
  const s = new MessageStore({ log: quiet });
  s.add(msg('a'));
  s.add(msg('a', { text: 'again' }));
  assert.equal(s.since(0).messages.length, 1);
  assert.equal(s.since(0).messages[0].text, 'a');
  const r = s.rev;
  s.add(msg('b', { outgoing: true, status: 'queued' }));
  s.update('b', { status: 'delivered' });
  s.update('b', { status: 'sent' });
  const ch = s.since(r);
  assert.equal(ch.full, false);
  assert.deepEqual(ch.messages.map(m => [m.id, m.status]), [['b', 'delivered']]);
  assert.equal(s.since(s.rev).messages.length, 0);
  assert.equal(s.since(s.rev + 5).full, true, 'a page from before a restart gets everything');
  assert.ok(!('rev' in ch.messages[0]));
});

test('messages: only the newest are kept per network, and pages are told to reload', () => {
  const s = new MessageStore({ log: quiet });
  const t0 = Date.now();
  for (let i = 0; i < KEEP_PER_NETWORK + 5; i++) s.add(msg(`m${i}`, { time: t0 + i }));
  s.add(msg('other', { network: 'meshcore' }));
  const all = s.since(0).messages;
  assert.equal(all.filter(m => m.network === 'meshtastic').length, KEEP_PER_NETWORK);
  assert.ok(!all.find(m => m.id === 'm0'));
  assert.ok(all.find(m => m.id === 'other'));
  assert.equal(s.since(3).full, true);
});

test('messages: saved to disk; anything still sending when stopped comes back as unknown', () => {
  const file = path.join(tmp(), 'messages.json');
  const s = new MessageStore({ file, log: quiet });
  s.add(msg('a'));
  s.add(msg('b', { outgoing: true, status: 'queued' }));
  s.save();
  const back = new MessageStore({ file, log: quiet }).since(0).messages;
  assert.deepEqual(back.map(m => [m.id, m.status]), [['a', undefined], ['b', 'unknown']]);
});

test('messages: direct chats are listed with the other side’s name', () => {
  const s = new MessageStore({ log: quiet });
  s.add(msg('1', { chat: 'dm:!0badf00d', fromName: 'Lake Murray Base', time: 10 }));
  s.add(msg('2', { chat: 'dm:!0badf00d', outgoing: true, fromName: 'Me', time: 20 }));
  s.add(msg('3', { chat: 'ch:1' }));
  assert.deepEqual(s.directChats('meshtastic'), [{ key: 'dm:!0badf00d', network: 'meshtastic', kind: 'dm', peer: '!0badf00d', last: 20, fallbackName: 'Lake Murray Base' }]);
  assert.deepEqual(s.directChats('meshcore'), []);
});
