'use strict';
// Reads what a sliced Bambu .3mf says about itself: its plates, how long each
// takes, the filaments each uses (type, colour, grams) and the plate pictures.
// A .3mf is a zip file; this reads its central directory and inflates only the
// entries it needs, with Node's own zlib. Nothing in the file is run.

const zlib = require('zlib');

class ThreeMfError extends Error {}

const MAX_ENTRY = 64 * 1024 * 1024;

function entries(buf) {
  // End of central directory: the last 22..65557 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ThreeMfError("That isn't a .3mf file (no zip directory).");
  let count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  // Zip64: the real values are in the zip64 end record.
  if (offset === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
      const rec = Number(buf.readBigUInt64LE(loc + 8));
      if (buf.readUInt32LE(rec) === 0x06064b50) {
        count = Number(buf.readBigUInt64LE(rec + 32));
        offset = Number(buf.readBigUInt64LE(rec + 48));
      }
    }
  }
  const out = new Map();
  let p = offset;
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    let local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // Zip64 extra field: sizes and offset that didn't fit.
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = buf.readUInt16LE(e), len = buf.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (compSize === 0xffffffff) { compSize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (local === 0xffffffff) { local = Number(buf.readBigUInt64LE(q)); }
      }
      e += 4 + len;
    }
    out.set(name, { method, compSize, size, local });
    p = eEnd + commentLen;
  }
  return out;
}

function read(buf, list, name) {
  const ent = list.get(name);
  if (!ent) return null;
  if (ent.size > MAX_ENTRY) throw new ThreeMfError(`${name} is too big to read.`);
  const h = ent.local;
  if (buf.readUInt32LE(h) !== 0x04034b50) throw new ThreeMfError('The .3mf file is damaged.');
  const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
  const data = buf.subarray(start, start + ent.compSize);
  if (ent.method === 0) return Buffer.from(data);
  if (ent.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY });
  throw new ThreeMfError('The .3mf file uses a compression this app can\'t read.');
}

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? decodeXml(m[1]) : null;
};
const decodeXml = s => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Metadata/slice_info.config: one <plate> per sliced plate, with
// <metadata key="index|prediction|weight" value=…/> and <filament id type color used_g/>.
function parseSliceInfo(xml) {
  const plates = [];
  for (const m of xml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    const body = m[1];
    const meta = {};
    for (const t of body.matchAll(/<metadata\b[^>]*>/g)) {
      const k = attr(t[0], 'key');
      if (k) meta[k] = attr(t[0], 'value');
    }
    const filaments = [];
    for (const t of body.matchAll(/<filament\b[^>]*>/g)) {
      const id = Number(attr(t[0], 'id'));
      if (!Number.isInteger(id) || id < 1 || id > 64) continue;
      filaments.push({
        id,
        type: (attr(t[0], 'type') || '').slice(0, 24),
        color: normColor(attr(t[0], 'color')),
        grams: Number(attr(t[0], 'used_g')) || 0,
        meters: Number(attr(t[0], 'used_m')) || 0,
      });
    }
    const index = Number(meta.index);
    if (!Number.isInteger(index) || index < 1 || index > 100) continue;
    plates.push({
      index,
      seconds: Number(meta.prediction) || null,
      grams: Number(meta.weight) || filaments.reduce((a, f) => a + f.grams, 0),
      nozzle: Number(meta.nozzle_diameters) || null,
      filaments,
    });
  }
  return plates.sort((a, b) => a.index - b.index);
}

function normColor(c) {
  const m = String(c || '').match(/^#?([0-9a-f]{6})/i);
  return m ? '#' + m[1].toUpperCase() : null;
}

// Returns { plates: [...], thumbnails: { [plate]: Buffer } }.
function parse(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw new ThreeMfError("That isn't a .3mf file.");
  const list = entries(buf);
  const info = read(buf, list, 'Metadata/slice_info.config');
  if (!info) throw new ThreeMfError('That .3mf isn\'t sliced yet. Slice it in Bambu Studio and export the plate (File > Export > Export plate sliced file).');
  const plates = parseSliceInfo(info.toString('utf8'));
  const gcodePlates = new Set([...list.keys()].map(k => k.match(/^Metadata\/plate_(\d+)\.gcode$/)?.[1]).filter(Boolean).map(Number));
  const sliced = plates.filter(p => gcodePlates.has(p.index));
  if (!sliced.length) throw new ThreeMfError('That .3mf has no sliced plates in it.');
  const thumbnails = {};
  for (const p of sliced) {
    const img = read(buf, list, `Metadata/plate_${p.index}.png`) || read(buf, list, `Metadata/plate_${p.index}_small.png`);
    if (img && img.length < 2 * 1024 * 1024 && img.readUInt32BE(0) === 0x89504e47) thumbnails[p.index] = img;
  }
  return { plates: sliced, thumbnails };
}

module.exports = { parse, parseSliceInfo, ThreeMfError };
