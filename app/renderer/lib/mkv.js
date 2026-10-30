// WebM / Matroska (MKV, MKA) reader: tracks with their codecs and codec setup, then every frame in file
// order with its presentation time. Handles unknown-size segments and clusters (live recordings such as
// browser and OBS files), SimpleBlock and BlockGroup, and Xiph, EBML and fixed-size lacing.
// reader: { size, read(offset, length) → Uint8Array } (HttpReader or BufferReader).

const ID = {
  EBML: 0x1a45dfa3, Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63a2,
  DefaultDuration: 0x23e383, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba, Audio: 0xe1, SamplingFrequency: 0xb5,
  Channels: 0x9f, BitDepth: 0x6264, CodecDelay: 0x56aa,
  Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, BlockDuration: 0x9b,
};
const TOP_LEVEL = new Set([0x114d9b74, ID.Info, ID.Tracks, ID.Cluster, 0x1c53bb6b, 0x1254c367, 0x1043a770, 0x1941a469, 0xec]);

/** Variable-length integer at b[p]. keepMarker: element IDs keep the length bits. */
function vint(b, p, keepMarker) {
  const first = b[p];
  if (first === undefined) return null;
  let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8 || p + len > b.length) return null;
  let v = keepMarker ? first : first & (mask - 1), allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) { v = v * 256 + b[p + i]; if (b[p + i] !== 0xff) allOnes = false; }
  return { value: v, len, unknown: !keepMarker && allOnes };
}
const uint = (b, p, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[p + i]; return v; };
const float = (b, p, n) => { const dv = new DataView(b.buffer, b.byteOffset + p, n); return n === 4 ? dv.getFloat32(0) : dv.getFloat64(0); };
const str = (b, p, n) => new TextDecoder().decode(b.subarray(p, p + n)).replace(/\0+$/, '');

/** Reads element headers from the file. */
class Cursor {
  constructor(reader) { this.r = reader; this.cache = null; this.cacheAt = 0; }
  async bytes(at, n) {
    if (this.cache && at >= this.cacheAt && at + n <= this.cacheAt + this.cache.length) return this.cache.subarray(at - this.cacheAt, at - this.cacheAt + n);
    const want = Math.max(n, 1 << 20), len = Math.min(want, this.r.size - at);
    this.cache = await this.r.read(at, len); this.cacheAt = at;
    return this.cache.subarray(0, Math.min(n, this.cache.length));
  }
  async header(at) {
    if (at >= this.r.size) return null;
    const h = await this.bytes(at, 12);
    const id = vint(h, 0, true); if (!id) return null;
    const sz = vint(h, id.len, false); if (!sz) return null;
    return { id: id.value, start: at, data: at + id.len + sz.len, size: sz.unknown ? null : sz.value, end: sz.unknown ? null : at + id.len + sz.len + sz.value };
  }
}

/**
 * Opens a Matroska/WebM file. Returns { duration, tracks: [{ number, type: 'video'|'audio', codecId, codecPrivate,
 * width, height, sampleRate, channels, bitDepth, defaultDuration, codecDelay }], frames() } where frames() is an async
 * generator of { track, time (s), duration (s|null), key, data }.
 */
export async function openMatroska(reader) {
  const c = new Cursor(reader);
  const ebml = await c.header(0);
  if (!ebml || ebml.id !== ID.EBML) throw new Error('Not a WebM / Matroska file');
  let at = ebml.end, seg = null;
  while (at < reader.size) { const h = await c.header(at); if (!h) break; if (h.id === ID.Segment) { seg = h; break; } if (h.end === null) break; at = h.end; }
  if (!seg) throw new Error('No Matroska segment');
  const segEnd = seg.end ?? reader.size;
  let scale = 1e6, duration = 0, firstCluster = null;
  const tracks = [];
  at = seg.data;
  while (at < segEnd) {
    const h = await c.header(at); if (!h) break;
    if (h.id === ID.Cluster) { firstCluster = at; break; }
    if (h.end === null) { at = h.data; continue; }
    if (h.id === ID.Info) {
      const b = await reader.read(h.data, h.end - h.data);
      for (const e of children(b)) {
        if (e.id === ID.TimecodeScale) scale = uint(b, e.p, e.n);
        if (e.id === ID.Duration) duration = float(b, e.p, e.n);
      }
    } else if (h.id === ID.Tracks) {
      const b = await reader.read(h.data, h.end - h.data);
      for (const te of children(b)) if (te.id === ID.TrackEntry) tracks.push(parseTrack(b.subarray(te.p, te.p + te.n)));
    }
    at = h.end;
  }
  if (!tracks.length) throw new Error('No tracks in this file');
  const byNum = new Map(tracks.map(t => [t.number, t]));
  async function* frames() {
    let p = firstCluster;
    while (p !== null && p < segEnd) {
      const h = await c.header(p); if (!h) return;
      if (h.id !== ID.Cluster) { if (h.end === null) return; p = h.end; continue; }
      // the cluster's children, read until its end (or, unknown size, until the next top-level element)
      let q = h.data, base = 0;
      const stop = h.end ?? segEnd;
      while (q < stop) {
        const e = await c.header(q); if (!e) return;
        if (h.end === null && (e.id === ID.Cluster || TOP_LEVEL.has(e.id))) break;
        if (e.end === null) return;
        if (e.id === ID.Timecode) base = uint(await c.bytes(e.data, e.end - e.data), 0, e.end - e.data);
        else if (e.id === ID.SimpleBlock || e.id === ID.BlockGroup) {
          const b = await reader.read(e.data, e.end - e.data);
          let blk = b, dur = null, key = null;
          if (e.id === ID.BlockGroup) {
            blk = null; key = true;
            for (const g of children(b)) {
              if (g.id === ID.Block) blk = b.subarray(g.p, g.p + g.n);
              else if (g.id === ID.BlockDuration) dur = uint(b, g.p, g.n);
              else if (g.id === 0xfb) key = false; // ReferenceBlock: not a keyframe
            }
            if (!blk) { q = e.end; continue; }
          }
          for (const f of parseBlock(blk, e.id === ID.SimpleBlock)) {
            const t = byNum.get(f.track); if (!t) continue;
            const ticks = base + f.rel;
            const n = f.datas.length, laceDur = t.defaultDuration ? t.defaultDuration / 1e9 : null;
            for (let k = 0; k < n; k++) {
              yield { track: t, time: (ticks * scale) / 1e9 + (laceDur && k ? k * laceDur : 0), duration: dur !== null ? (dur * scale) / 1e9 / n : laceDur,
                key: key ?? f.key, data: f.datas[k] };
            }
          }
        }
        q = e.end;
      }
      p = h.end ?? q;
    }
  }
  return { duration: (duration * scale) / 1e9, tracks, frames };
}

function children(b) {
  const out = [];
  for (let p = 0; p < b.length;) {
    const id = vint(b, p, true); if (!id) break;
    const sz = vint(b, p + id.len, false); if (!sz) break;
    const d = p + id.len + sz.len, n = sz.unknown ? b.length - d : Math.min(sz.value, b.length - d);
    out.push({ id: id.value, p: d, n });
    p = d + n;
  }
  return out;
}

function parseTrack(b) {
  const t = { number: 0, type: null, codecId: '', codecPrivate: null, width: 0, height: 0, sampleRate: 8000, channels: 1, bitDepth: 0, defaultDuration: 0, codecDelay: 0 };
  for (const e of children(b)) {
    if (e.id === ID.TrackNumber) t.number = uint(b, e.p, e.n);
    else if (e.id === ID.TrackType) { const v = uint(b, e.p, e.n); t.type = v === 1 ? 'video' : v === 2 ? 'audio' : 'other'; }
    else if (e.id === ID.CodecID) t.codecId = str(b, e.p, e.n);
    else if (e.id === ID.CodecPrivate) t.codecPrivate = b.slice(e.p, e.p + e.n);
    else if (e.id === ID.DefaultDuration) t.defaultDuration = uint(b, e.p, e.n);
    else if (e.id === ID.CodecDelay) t.codecDelay = uint(b, e.p, e.n);
    else if (e.id === ID.Video) for (const v of children(b.subarray(e.p, e.p + e.n))) { const vb = b.subarray(e.p, e.p + e.n); if (v.id === ID.PixelWidth) t.width = uint(vb, v.p, v.n); if (v.id === ID.PixelHeight) t.height = uint(vb, v.p, v.n); }
    else if (e.id === ID.Audio) for (const a of children(b.subarray(e.p, e.p + e.n))) {
      const ab = b.subarray(e.p, e.p + e.n);
      if (a.id === ID.SamplingFrequency) t.sampleRate = float(ab, a.p, a.n);
      if (a.id === ID.Channels) t.channels = uint(ab, a.p, a.n);
      if (a.id === ID.BitDepth) t.bitDepth = uint(ab, a.p, a.n);
    }
  }
  return t;
}

/** A (Simple)Block: track, relative time, keyframe flag and its frame(s), unpacking lacing. */
export function parseBlock(b, simple) {
  const tn = vint(b, 0, false); if (!tn) return [];
  let p = tn.len;
  const rel = (b[p] << 24 >> 16) | b[p + 1]; p += 2; // signed 16-bit
  const flags = b[p++], key = simple ? !!(flags & 0x80) : true, lacing = (flags >> 1) & 3;
  if (!lacing) return [{ track: tn.value, rel, key, datas: [b.subarray(p)] }];
  const count = b[p++] + 1, sizes = [];
  if (lacing === 1) { // Xiph
    for (let i = 0; i < count - 1; i++) { let s = 0, v; do { v = b[p++]; s += v; } while (v === 255); sizes.push(s); }
  } else if (lacing === 3) { // EBML
    const f = vint(b, p, false); p += f.len; sizes.push(f.value);
    for (let i = 1; i < count - 1; i++) {
      const d = vint(b, p, false); p += d.len;
      const bias = 2 ** (7 * d.len - 1) - 1; // signed difference from the previous size
      sizes.push(sizes[i - 1] + d.value - bias);
    }
  }
  const rest = b.length - p;
  if (lacing === 2) { const each = Math.floor(rest / count); for (let i = 0; i < count - 1; i++) sizes.push(each); }
  sizes.push(rest - sizes.reduce((a, x) => a + x, 0));
  const datas = []; for (const s of sizes) { datas.push(b.subarray(p, p + s)); p += s; }
  return [{ track: tn.value, rel, key, datas }];
}
