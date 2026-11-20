'use strict';
// The small part of Protocol Buffers that Meshtastic's API needs, so the app has
// no dependencies. decode() keeps every field it sees, by number, and the
// accessors read them as the type the .proto declares. Unknown fields are kept
// and ignored, so newer firmware with extra fields still decodes.

class ProtoError extends Error {}

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new ProtoError('truncated varint');
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [result, pos];
    shift += 7n;
  }
  throw new ProtoError('varint too long');
}

class Msg {
  constructor(fields = new Map()) { this.fields = fields; }

  has(n) { return this.fields.has(n); }
  all(n) { return this.fields.get(n) || []; }
  last(n) { const a = this.fields.get(n); return a ? a[a.length - 1] : undefined; }

  // Varint types.
  u32(n, d = undefined) { const v = this.last(n); return v?.wt === 0 ? Number(BigInt.asUintN(32, v.v)) : d; }
  i32(n, d = undefined) { const v = this.last(n); return v?.wt === 0 ? Number(BigInt.asIntN(32, v.v)) : d; }
  s32(n, d = undefined) { const v = this.u32(n); return v === undefined ? d : (v >>> 1) ^ -(v & 1); }
  bool(n, d = undefined) { const v = this.last(n); return v?.wt === 0 ? v.v !== 0n : d; }
  // Fixed 32-bit types.
  fixed32(n, d = undefined) { const v = this.last(n); return v?.wt === 5 ? v.v.readUInt32LE(0) : d; }
  sfixed32(n, d = undefined) { const v = this.last(n); return v?.wt === 5 ? v.v.readInt32LE(0) : d; }
  float(n, d = undefined) { const v = this.last(n); return v?.wt === 5 ? v.v.readFloatLE(0) : d; }
  // Length-delimited types.
  bytes(n, d = undefined) { const v = this.last(n); return v?.wt === 2 ? v.v : d; }
  str(n, d = undefined) { const v = this.bytes(n); return v ? v.toString('utf8') : d; }
  msg(n) { const v = this.bytes(n); return v ? decode(v) : undefined; }
  msgs(n) { return this.all(n).filter(v => v.wt === 2).map(v => decode(v.v)); }
}

function decode(buf) {
  const fields = new Map();
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const n = Number(key >> 3n);
    const wt = Number(key & 7n);
    if (n === 0) throw new ProtoError('field 0');
    let v;
    if (wt === 0) [v, pos] = readVarint(buf, pos);
    else if (wt === 1) { if (pos + 8 > buf.length) throw new ProtoError('truncated'); v = buf.subarray(pos, pos + 8); pos += 8; }
    else if (wt === 5) { if (pos + 4 > buf.length) throw new ProtoError('truncated'); v = buf.subarray(pos, pos + 4); pos += 4; }
    else if (wt === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      len = Number(len);
      if (pos + len > buf.length) throw new ProtoError('truncated bytes');
      v = buf.subarray(pos, pos + len);
      pos += len;
    } else throw new ProtoError(`wire type ${wt}`);
    if (!fields.has(n)) fields.set(n, []);
    fields.get(n).push({ wt, v });
  }
  return new Msg(fields);
}

// ---- encoding -----------------------------------------------------------------

function varintBytes(value) {
  let v = BigInt.asUintN(64, BigInt(value));
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

const key = (n, wt) => varintBytes((n << 3) | wt);

// Each helper returns the bytes of one field; encode() joins them, skipping
// nulls, so optional fields can be written inline.
const field = {
  varint: (n, v) => (v === undefined || v === null ? null : Buffer.concat([key(n, 0), varintBytes(typeof v === 'boolean' ? (v ? 1 : 0) : v)])),
  fixed32: (n, v) => { if (v === undefined || v === null) return null; const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return Buffer.concat([key(n, 5), b]); },
  sfixed32: (n, v) => { if (v === undefined || v === null) return null; const b = Buffer.alloc(4); b.writeInt32LE(v | 0); return Buffer.concat([key(n, 5), b]); },
  float: (n, v) => { if (v === undefined || v === null) return null; const b = Buffer.alloc(4); b.writeFloatLE(v); return Buffer.concat([key(n, 5), b]); },
  bytes: (n, v) => { if (v === undefined || v === null) return null; const b = Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8'); return Buffer.concat([key(n, 2), varintBytes(b.length), b]); },
};
field.string = field.bytes;
field.msg = (n, parts) => field.bytes(n, encode(parts));

const encode = parts => Buffer.concat(parts.filter(Boolean));

module.exports = { decode, encode, field, Msg, ProtoError };
