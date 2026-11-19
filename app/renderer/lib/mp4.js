// MP4 / MOV reading and writing for ProtoArt Reel (no dependencies).
//
// Demuxer: reads the sample tables of regular and fragmented MP4/MOV files through an async
// reader, so large files are never loaded whole. It reports each track's codec in WebCodecs
// form (avc1.*, hvc1.*, mp4a.40.*) with its decoder description, plus every sample's position,
// timing and keyframe flag.
//
// Muxer: builds a standard (non-fragmented) MP4 from WebCodecs output. Sample data is streamed
// out as it arrives; the moov box is built at the end with 64-bit chunk offsets so the file can
// be laid out moov-first ("fast start") without rewriting it.

// ------------------------------------------------------------------ readers

/** Reader over an in-memory buffer (tests, small files). */
export class BufferReader {
  constructor(buf) { this.buf = buf instanceof Uint8Array ? buf : new Uint8Array(buf); this.size = this.buf.length; }
  async read(offset, length) { return this.buf.subarray(offset, Math.min(this.size, offset + length)); }
}

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
const i32 = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
const type4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const hex2 = n => n.toString(16).padStart(2, '0');

/** Iterates child boxes inside [start, end) of an in-memory buffer. */
function* boxes(b, start = 0, end = b.length) {
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p);
    const type = type4(b, p + 4);
    let header = 8;
    if (size === 1) { size = u64(b, p + 8); header = 16; } else if (size === 0) size = end - p;
    if (size < header || p + size > end) return;
    yield { type, start: p, body: p + header, end: p + size };
    p += size;
  }
}
const child = (b, box, type) => { for (const c of boxes(b, box.body, box.end)) if (c.type === type) return c; return null; };
const children = (b, box, type) => [...boxes(b, box.body, box.end)].filter(c => c.type === type);

// ------------------------------------------------------------------ codec strings

function avcCodec(avcC) {
  return `avc1.${hex2(avcC[1])}${hex2(avcC[2])}${hex2(avcC[3])}`;
}

function hevcCodec(h, fourcc) {
  const profileSpace = h[1] >> 6, tier = (h[1] >> 5) & 1, profile = h[1] & 31;
  let compat = u32(h, 2), rev = 0;
  for (let i = 0; i < 32; i++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
  const cons = Array.from(h.subarray(6, 12));
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  const level = h[12];
  return [fourcc, ['', 'A', 'B', 'C'][profileSpace] + profile, (rev >>> 0).toString(16), (tier ? 'H' : 'L') + level,
    ...cons.map(c => c.toString(16).toUpperCase())].join('.');
}

/** Reads an MPEG-4 descriptor length (1–4 bytes of 7 bits). */
function descLen(b, p) {
  let len = 0, n = 0;
  for (;;) { const c = b[p + n]; len = (len << 7) | (c & 0x7f); n++; if (!(c & 0x80) || n === 4) break; }
  return { len, n };
}

/** AudioSpecificConfig out of an esds box body (after version/flags). */
function esdsConfig(b, p, end) {
  // ES_Descriptor (3) > DecoderConfigDescriptor (4) > DecoderSpecificInfo (5)
  while (p < end) {
    const tag = b[p];
    const { len, n } = descLen(b, p + 1);
    let q = p + 1 + n;
    if (tag === 3) { const flags = b[q + 2]; q += 3; if (flags & 0x80) q += 2; if (flags & 0x40) q += 1 + b[q]; if (flags & 0x20) q += 2; p = q; continue; }
    if (tag === 4) { const oti = b[q]; p = q + 13; if (oti !== 0x40 && oti !== 0x66 && oti !== 0x67) return { oti, asc: null }; continue; }
    if (tag === 5) return { oti: 0x40, asc: b.slice(q, q + len) };
    p = q + len;
  }
  return { oti: 0, asc: null };
}

function aacCodec(asc) {
  let aot = asc[0] >> 3;
  if (aot === 31) aot = 32 + (((asc[0] & 7) << 3) | (asc[1] >> 5));
  return `mp4a.40.${aot}`;
}

// ------------------------------------------------------------------ demuxer

/**
 * Opens an MP4/MOV. Returns { duration, tracks: [{ id, kind: 'video'|'audio', codec, description,
 * width, height, sampleRate, channels, timescale, samples: [{ offset, size, dts, pts, duration, sync }],
 * startTime, supported }] }. Times in samples are in the track's timescale; `startTime` (seconds)
 * is where the first presented sample sits after the edit list.
 */
export async function demux(reader) {
  // Walk top-level boxes reading only headers, then load moov (and moofs for fragmented files).
  let p = 0, moov = null;
  const moofs = [];
  while (p + 8 <= reader.size) {
    const h = await reader.read(p, 16);
    let size = u32(h, 0);
    const type = type4(h, 4);
    if (size === 1) size = u64(h, 8); else if (size === 0) size = reader.size - p;
    if (size < 8) break;
    if (type === 'moov') moov = await reader.read(p, size);
    else if (type === 'moof') moofs.push({ start: p, bytes: await reader.read(p, size) });
    p += size;
  }
  if (!moov) throw new Error('Not a playable MP4/MOV file (no moov)');
  const root = { body: 8, end: moov.length };
  const mvhd = child(moov, root, 'mvhd');
  const mvTimescale = mvhd ? (moov[mvhd.body] === 1 ? u32(moov, mvhd.body + 20) : u32(moov, mvhd.body + 12)) : 1000;
  const trex = new Map();
  const mvex = child(moov, root, 'mvex');
  if (mvex) for (const t of children(moov, mvex, 'trex')) {
    const q = t.body + 4;
    trex.set(u32(moov, q), { dur: u32(moov, q + 8), size: u32(moov, q + 12), flags: u32(moov, q + 16) });
  }

  const tracks = [];
  for (const trak of children(moov, root, 'trak')) {
    const t = readTrak(moov, trak, mvTimescale);
    if (t) tracks.push(t);
  }
  if (moofs.length) addFragments(moofs, tracks, trex);
  for (const t of tracks) finishTrack(t);
  const duration = Math.max(0, ...tracks.map(t => t.duration));
  return { duration, tracks };
}

function readTrak(b, trak, mvTimescale) {
  const tkhd = child(b, trak, 'tkhd');
  const mdia = child(b, trak, 'mdia');
  if (!tkhd || !mdia) return null;
  const v = b[tkhd.body];
  const id = u32(b, tkhd.body + (v === 1 ? 20 : 12));
  const mdhd = child(b, mdia, 'mdhd');
  const hdlr = child(b, mdia, 'hdlr');
  const handler = hdlr ? type4(b, hdlr.body + 8) : '';
  const kind = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : null;
  if (!kind || !mdhd) return null;
  const mv = b[mdhd.body];
  const timescale = mv === 1 ? u32(b, mdhd.body + 20) : u32(b, mdhd.body + 12);
  // tkhd matrix → rotation (phone videos)
  const m = tkhd.body + (v === 1 ? 52 : 40);
  const a = i32(b, m) / 65536, bb = i32(b, m + 4) / 65536;
  const rotation = Math.round((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  const track = { id, kind, timescale, codec: null, description: null, supported: false, rotation, samples: [], mediaTime: 0 };

  // Edit list: the first non-empty edit's media time is where presentation starts.
  const edts = child(b, trak, 'edts');
  const elst = edts && child(b, edts, 'elst');
  if (elst) {
    const ev = b[elst.body], n = u32(b, elst.body + 4);
    let q = elst.body + 8, emptyLead = 0;
    for (let i = 0; i < n; i++) {
      const segDur = ev === 1 ? u64(b, q) : u32(b, q);
      const mt = ev === 1 ? Number(BigInt.asIntN(64, (BigInt(u32(b, q + 8)) << 32n) | BigInt(u32(b, q + 12)))) : i32(b, q + 4);
      q += ev === 1 ? 20 : 12;
      if (mt === -1) { emptyLead += segDur / mvTimescale; continue; }
      track.mediaTime = mt; break;
    }
    track.emptyLead = emptyLead;
  }

  const minf = child(b, mdia, 'minf');
  const stbl = minf && child(b, minf, 'stbl');
  if (!stbl) return null;
  readStsd(b, child(b, stbl, 'stsd'), track);
  readSampleTables(b, stbl, track);
  return track;
}

function readStsd(b, stsd, track) {
  if (!stsd) return;
  const entry = boxes(b, stsd.body + 8, stsd.end).next().value;
  if (!entry) return;
  track.fourcc = entry.type;
  if (track.kind === 'video') {
    track.width = u16(b, entry.body + 24);
    track.height = u16(b, entry.body + 26);
    const inner = entry.body + 78;
    for (const c of boxes(b, inner, entry.end)) {
      if (c.type === 'avcC') { track.description = b.slice(c.body, c.end); track.codec = avcCodec(track.description); }
      if (c.type === 'hvcC') { track.description = b.slice(c.body, c.end); track.codec = hevcCodec(track.description, entry.type === 'hev1' ? 'hev1' : 'hvc1'); }
      if (c.type === 'pasp') track.pixelAspect = u32(b, c.body) / (u32(b, c.body + 4) || 1);
    }
    track.supported = !!track.codec;
  } else {
    const version = u16(b, entry.body + 8);
    track.channels = u16(b, entry.body + 16);
    track.sampleSize = u16(b, entry.body + 18);
    track.sampleRate = u32(b, entry.body + 24) >>> 16;
    let inner = entry.body + 28;
    if (version === 1) inner += 16; else if (version === 2) {
      inner += 36;
      const view = new DataView(b.buffer, b.byteOffset + entry.body + 32, 8);
      track.sampleRate = view.getFloat64(0);
      track.channels = u32(b, entry.body + 40);
    }
    if (entry.type === 'mp4a') {
      for (const c of boxes(b, inner, entry.end)) {
        let esds = c.type === 'esds' ? c : null;
        if (c.type === 'wave') esds = child(b, c, 'esds');
        if (esds) {
          const { asc } = esdsConfig(b, esds.body + 4, esds.end);
          if (asc && asc.length) { track.description = asc; track.codec = aacCodec(asc); }
        }
      }
    } else if (entry.type === 'Opus') {
      track.codec = 'opus';
    } else if (['sowt', 'twos', 'lpcm', 'ipcm', 'fpcm', 'in24', 'in32', 'fl32', 'raw '].includes(entry.type)) {
      track.codec = 'pcm';
      track.pcm = { fourcc: entry.type, bits: entry.type === 'in24' ? 24 : entry.type === 'in32' || entry.type === 'fl32' ? 32 : track.sampleSize || 16 };
    }
    track.supported = !!track.codec;
  }
}

function readSampleTables(b, stbl, track) {
  const stsz = child(b, stbl, 'stsz'), stz2 = child(b, stbl, 'stz2');
  const sizes = [];
  if (stsz) {
    const fixed = u32(b, stsz.body + 4), n = u32(b, stsz.body + 8);
    for (let i = 0; i < n; i++) sizes.push(fixed || u32(b, stsz.body + 12 + i * 4));
  } else if (stz2) {
    const bits = b[stz2.body + 7], n = u32(b, stz2.body + 8);
    for (let i = 0; i < n; i++) {
      const q = stz2.body + 12;
      sizes.push(bits === 16 ? u16(b, q + i * 2) : bits === 8 ? b[q + i] : (b[q + (i >> 1)] >> (i & 1 ? 0 : 4)) & 15);
    }
  }
  const n = sizes.length;
  if (!n) return;
  // chunk offsets
  const stco = child(b, stbl, 'stco'), co64 = child(b, stbl, 'co64');
  const chunks = [];
  if (stco) for (let i = 0, c = u32(b, stco.body + 4); i < c; i++) chunks.push(u32(b, stco.body + 8 + i * 4));
  if (co64) for (let i = 0, c = u32(b, co64.body + 4); i < c; i++) chunks.push(u64(b, co64.body + 8 + i * 8));
  // samples per chunk
  const stsc = child(b, stbl, 'stsc');
  const runs = [];
  if (stsc) for (let i = 0, c = u32(b, stsc.body + 4); i < c; i++) {
    const q = stsc.body + 8 + i * 12;
    runs.push({ first: u32(b, q), per: u32(b, q + 4) });
  }
  const offsets = new Array(n);
  let s = 0;
  for (let r = 0; r < runs.length && s < n; r++) {
    const last = r + 1 < runs.length ? runs[r + 1].first - 1 : chunks.length;
    for (let c = runs[r].first; c <= last && s < n; c++) {
      let off = chunks[c - 1];
      for (let k = 0; k < runs[r].per && s < n; k++) { offsets[s] = off; off += sizes[s]; s++; }
    }
  }
  // decode times
  const stts = child(b, stbl, 'stts');
  const durs = [];
  if (stts) for (let i = 0, c = u32(b, stts.body + 4); i < c; i++) {
    const cnt = u32(b, stts.body + 8 + i * 8), d = u32(b, stts.body + 12 + i * 8);
    for (let k = 0; k < cnt && durs.length < n; k++) durs.push(d);
  }
  while (durs.length < n) durs.push(durs[durs.length - 1] || 1);
  const ctts = child(b, stbl, 'ctts');
  const offs = new Array(n).fill(0);
  if (ctts) {
    const cv = b[ctts.body];
    let k = 0;
    for (let i = 0, c = u32(b, ctts.body + 4); i < c; i++) {
      const cnt = u32(b, ctts.body + 8 + i * 8);
      // Signed in practice even in version 0 (Apple and others write negative offsets there).
      const o = i32(b, ctts.body + 12 + i * 8);
      for (let j = 0; j < cnt && k < n; j++) offs[k++] = o;
    }
  }
  const stss = child(b, stbl, 'stss');
  let sync = null;
  if (stss) { sync = new Set(); for (let i = 0, c = u32(b, stss.body + 4); i < c; i++) sync.add(u32(b, stss.body + 8 + i * 4) - 1); }
  let dts = 0;
  for (let i = 0; i < n; i++) {
    if (offsets[i] === undefined) break;
    track.samples.push({ offset: offsets[i], size: sizes[i], dts, pts: dts + offs[i], duration: durs[i], sync: sync ? sync.has(i) : true });
    dts += durs[i];
  }
}

function addFragments(moofs, tracks, trex) {
  const byId = new Map(tracks.map(t => [t.id, t]));
  const nextDts = new Map(tracks.map(t => [t.id, t.samples.length ? t.samples[t.samples.length - 1].dts + t.samples[t.samples.length - 1].duration : 0]));
  for (const { start, bytes: b } of moofs) {
    const root = { body: 8, end: b.length };
    for (const traf of children(b, root, 'traf')) {
      const tfhd = child(b, traf, 'tfhd');
      if (!tfhd) continue;
      const fl = u32(b, tfhd.body) & 0xffffff;
      const id = u32(b, tfhd.body + 4);
      const t = byId.get(id);
      if (!t) continue;
      const dflt = trex.get(id) || { dur: 0, size: 0, flags: 0 };
      let q = tfhd.body + 8, base = start;
      if (fl & 1) { base = u64(b, q); q += 8; }
      if (fl & 2) q += 4;
      let dDur = dflt.dur, dSize = dflt.size, dFlags = dflt.flags;
      if (fl & 8) { dDur = u32(b, q); q += 4; }
      if (fl & 0x10) { dSize = u32(b, q); q += 4; }
      if (fl & 0x20) { dFlags = u32(b, q); q += 4; }
      const tfdt = child(b, traf, 'tfdt');
      let dts = tfdt ? (b[tfdt.body] === 1 ? u64(b, tfdt.body + 4) : u32(b, tfdt.body + 4)) : nextDts.get(id);
      for (const trun of children(b, traf, 'trun')) {
        const tv = b[trun.body], tf = u32(b, trun.body) & 0xffffff, cnt = u32(b, trun.body + 4);
        let r = trun.body + 8, off = base;
        if (tf & 1) { off = base + i32(b, r); r += 4; }
        let firstFlags = null;
        if (tf & 4) { firstFlags = u32(b, r); r += 4; }
        for (let i = 0; i < cnt; i++) {
          let dur = dDur, size = dSize, flags = i === 0 && firstFlags !== null ? firstFlags : dFlags, cto = 0;
          if (tf & 0x100) { dur = u32(b, r); r += 4; }
          if (tf & 0x200) { size = u32(b, r); r += 4; }
          if (tf & 0x400) { flags = u32(b, r); r += 4; }
          if (tf & 0x800) { cto = i32(b, r); r += 4; } // signed, whatever the box version says
          t.samples.push({ offset: off, size, dts, pts: dts + cto, duration: dur, sync: !((flags >> 16) & 1) });
          off += size; dts += dur;
        }
      }
      nextDts.set(id, dts);
    }
  }
}

function finishTrack(t) {
  const s = t.samples;
  if (!s.length) { t.duration = 0; t.startTime = 0; return; }
  let end = 0, first = Infinity;
  for (const x of s) { end = Math.max(end, x.pts + x.duration); first = Math.min(first, x.pts); }
  const origin = t.mediaTime || 0;
  t.startTime = (t.emptyLead || 0) + (first - origin) / t.timescale;
  t.duration = (t.emptyLead || 0) + (end - origin) / t.timescale;
  t.origin = origin;
}

/** Presentation time (seconds, file timeline) of a sample. */
export const sampleTime = (track, s) => (track.emptyLead || 0) + (s.pts - (track.origin || 0)) / track.timescale;

/** Index of the last keyframe at or before `seconds` (decode starts there). */
export function keyframeBefore(track, seconds) {
  const target = (seconds - (track.emptyLead || 0)) * track.timescale + (track.origin || 0);
  let best = 0;
  for (let i = 0; i < track.samples.length; i++) {
    const s = track.samples[i];
    if (s.sync && s.pts <= target) best = i;
    if (s.dts > target) break;
  }
  return best;
}

// ------------------------------------------------------------------ muxer

const enc = new TextEncoder();
function box(type, ...parts) {
  let size = 8;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, size);
  out.set(enc.encode(type), 4);
  let o = 8;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const fullbox = (type, version, flags, ...parts) => box(type, new Uint8Array([version, flags >> 16, (flags >> 8) & 255, flags & 255]), ...parts);
function bytes(...vals) { // [bits, value] pairs → big-endian bytes
  const out = [];
  for (const [bits, v] of vals) {
    if (bits === 64) { const hi = Math.floor(v / 4294967296), lo = v >>> 0; for (const x of [hi, lo]) out.push((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255); continue; }
    for (let s = bits - 8; s >= 0; s -= 8) out.push((v >>> s) & 255);
  }
  return new Uint8Array(out);
}
const MATRIX = bytes([32, 0x00010000], [32, 0], [32, 0], [32, 0], [32, 0x00010000], [32, 0], [32, 0], [32, 0], [32, 0x40000000]);
function descriptor(tag, body) {
  const len = body.length;
  return new Uint8Array([tag, 0x80 | ((len >> 21) & 127), 0x80 | ((len >> 14) & 127), 0x80 | ((len >> 7) & 127), len & 127, ...body]);
}

// ------------------------------------------------------------------ chapters and captions inside the movie (1.15)
// A chapter track (QuickTime text, as Apple's players and ffmpeg read it, pointed to by a 'chap' reference from the
// other tracks) plus Nero 'chpl' chapters in udta (VLC, mpv and others), and a subtitle track (3GPP timed text,
// 'tx3g' in an 'sbtl' track, off until chosen). Laid out as ffmpeg writes them, checked with ffprobe. Times in ms.
const hex = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const TEXT_ENTRY = hex('00000000000000010000000100000000000000000000000000000000000000010000000000000000000d667461620001000100');
const TX3G_ENTRY = hex('00000000000000010000000001ff000000ff00000000000000000000000000010010ffffffff00000012667461620001000105417269616c');
const GMHD = hex('00000018676d696e000000000040800080008000000000000000002c74657874000100000000000000000000000000000001000000000000000000000000000040000000');
const ENCD = hex('0000000c656e636400000100'); // (UTF-8: a chapter sample's encoding)
const textBytes = (str, extra) => { const t = enc.encode(String(str).slice(0, 2000)); const o = new Uint8Array(2 + t.length + (extra ? extra.length : 0)); o[0] = t.length >> 8; o[1] = t.length & 255; o.set(t, 2); if (extra) o.set(extra, 2 + t.length); return o; };

/**
 * The samples of a movie's chapters and captions. text: { chapters: [{ t, title }] (seconds), captions: [{ t, end,
 * text }], dur (seconds) }. Returns { data (the samples, in order: chapters then captions), chap, subs } with each
 * track's samples ({ off, size, dur } in ms) and duration, or null where there's none.
 */
export function textSamples(text) {
  const durMs = Math.max(1, Math.round((text.dur || 0) * 1000));
  const parts = [];
  let off = 0;
  const add = (bytes, dur, list) => { list.push({ off, size: bytes.length, dur }); parts.push(bytes); off += bytes.length; };
  let chap = null, subs = null;
  // chapters: from 0 (the first called Intro if no marker starts there), each until the next, the last until the end
  const ch = (text.chapters || []).filter(c => c.t >= 0 && c.t * 1000 < durMs - 1).map(c => ({ ms: Math.round(c.t * 1000), title: String(c.title || 'Chapter') })).sort((a, b) => a.ms - b.ms)
    .filter((c, i, a) => !i || c.ms > a[i - 1].ms);
  if (ch.length) {
    if (ch[0].ms > 0) ch.unshift({ ms: 0, title: 'Intro' });
    chap = { samples: [], dur: durMs, list: ch };
    ch.forEach((c, i) => add(textBytes(c.title, ENCD), (i + 1 < ch.length ? ch[i + 1].ms : durMs) - c.ms, chap.samples));
  }
  // captions: each from its start until its end (or the next one's start), the gaps as empty samples
  const cs = (text.captions || []).map(c => ({ a: Math.max(0, Math.round(c.t * 1000)), b: Math.min(durMs, Math.round(c.end * 1000)), text: String(c.text || '').trim() }))
    .filter(c => c.b > c.a && c.text).sort((x, y) => x.a - y.a);
  if (cs.length) {
    subs = { samples: [], dur: 0 };
    let at = 0;
    cs.forEach((c, i) => {
      const a = Math.max(c.a, at), b = Math.min(c.b, i + 1 < cs.length ? Math.max(cs[i + 1].a, a + 1) : c.b);
      if (b <= a) return;
      if (a > at) add(textBytes(''), a - at, subs.samples);
      add(textBytes(c.text), b - a, subs.samples);
      at = b;
    });
    add(textBytes(''), 0, subs.samples); // (ends the last one)
    subs.dur = at;
  }
  const data = new Uint8Array(off);
  let o = 0; for (const p of parts) { data.set(p, o); o += p.length; }
  return { data, chap, subs };
}

/** A text track's trak, its samples at file offset base + their own; movieTs: the movie's timescale. */
function textTrak(kind, id, tr, base, movieTs) {
  const chapters = kind === 'chap', movieDur = Math.round(tr.dur * movieTs / 1000);
  const tkhd = fullbox('tkhd', 0, chapters ? 2 : 3, bytes([32, 0], [32, 0], [32, id], [32, 0], [32, movieDur], [32, 0], [32, 0], [16, 0], [16, chapters ? 0 : 2], [16, 0], [16, 0]), MATRIX, bytes([32, 0], [32, 0]));
  const elst = fullbox('elst', 0, 0, bytes([32, 1], [32, movieDur], [32, 0], [16, 1], [16, 0]));
  const mdhd = fullbox('mdhd', 0, 0, bytes([32, 0], [32, 0], [32, 1000], [32, tr.dur], [16, chapters ? 0 : 0x55c4], [16, 0]));
  const hdlr = fullbox('hdlr', 0, 0, bytes([32, 0]), enc.encode(chapters ? 'text' : 'sbtl'), new Uint8Array(12), enc.encode(chapters ? 'ChapterHandler\0' : 'SubtitleHandler\0'));
  const xmhd = chapters ? box('gmhd', GMHD) : fullbox('nmhd', 0, 0);
  const dinf = box('dinf', fullbox('dref', 0, 0, bytes([32, 1]), fullbox('url ', 0, 1)));
  const s = tr.samples;
  const stsd = fullbox('stsd', 0, 0, bytes([32, 1]), box(chapters ? 'text' : 'tx3g', chapters ? TEXT_ENTRY : TX3G_ENTRY));
  const runs = []; for (const x of s) { const l = runs[runs.length - 1]; if (l && l[1] === x.dur) l[0]++; else runs.push([1, x.dur]); }
  const stts = fullbox('stts', 0, 0, bytes([32, runs.length], ...runs.flatMap(r => [[32, r[0]], [32, r[1]]])));
  const stsc = fullbox('stsc', 0, 0, bytes([32, 1], [32, 1], [32, s.length], [32, 1])); // all in one chunk
  const stsz = fullbox('stsz', 0, 0, bytes([32, 0], [32, s.length], ...s.map(x => [32, x.size])));
  const co64 = fullbox('co64', 0, 0, bytes([32, 1], [64, base + s[0].off]));
  return box('trak', tkhd, box('edts', elst), box('mdia', mdhd, hdlr, box('minf', xmhd, dinf, box('stbl', stsd, stts, stsc, stsz, co64))));
}

/** Nero chapters (udta 'chpl'): start in 100 ns units and title. */
function chplBox(list) {
  const parts = [hex('01000000'), bytes([32, 0], [8, Math.min(255, list.length)])];
  for (const c of list.slice(0, 255)) { const t = enc.encode(c.title).slice(0, 255); parts.push(bytes([64, c.ms * 10000], [8, t.length]), t); }
  return box('chpl', ...parts);
}
const trefChap = id => box('tref', box('chap', bytes([32, id])));

/**
 * Adds text tracks to a finished movie's moov (a Buffer/Uint8Array of the whole moov box), their samples written at
 * file offset `base` (an mdat's body). Returns the new moov. (export: the core's MP4s, written by the Mac's encoder)
 */
export function moovWithText(moov, ts, base) {
  const kids = [...boxes(moov, 8, moov.length)];
  const mvhd = kids.find(k => k.type === 'mvhd');
  if (!mvhd) throw new Error('No movie header');
  const v1 = moov[mvhd.body] === 1;
  const movieTs = u32(moov, mvhd.body + (v1 ? 20 : 12));
  const mv = moov.slice(mvhd.start, mvhd.end);
  const nextAt = mvhd.end - mvhd.start - 4;
  let next = u32(mv, nextAt);
  const ids = {};
  if (ts.chap) ids.chap = next++;
  if (ts.subs) ids.subs = next++;
  new DataView(mv.buffer, mv.byteOffset).setUint32(nextAt, next);
  const out = [mv];
  let udta = null;
  for (const k of kids) {
    if (k.type === 'mvhd') continue;
    if (k.type === 'trak' && ids.chap) {
      // a 'chap' reference to the chapter track, before its media
      const tk = [...boxes(moov, k.body, k.end)];
      const parts = [];
      for (const c of tk) { if (c.type === 'mdia' && !tk.some(x => x.type === 'tref')) parts.push(trefChap(ids.chap)); parts.push(moov.slice(c.start, c.end)); }
      out.push(box('trak', ...parts));
    } else if (k.type === 'udta') udta = moov.slice(k.body, k.end);
    else out.push(moov.slice(k.start, k.end));
  }
  // (the samples' offsets are within ts.data, which starts at base)
  if (ts.chap) out.push(textTrak('chap', ids.chap, ts.chap, base, movieTs));
  if (ts.subs) { const tr = textTrak('subs', ids.subs, ts.subs, base, movieTs); out.push(ids.chap ? withTref(tr, ids.chap) : tr); }
  if (ts.chap || udta) out.push(box('udta', ...(udta ? [udta] : []), ...(ts.chap ? [chplBox(ts.chap.list)] : [])));
  return box('moov', ...out);
}
/** (the subtitle track points at the chapters too, as ffmpeg's does) */
function withTref(trak, chapId) {
  const kids = [...boxes(trak, 8, trak.length)], parts = [];
  for (const c of kids) { if (c.type === 'mdia') parts.push(trefChap(chapId)); parts.push(trak.slice(c.start, c.end)); }
  return box('trak', ...parts);
}

/**
 * Muxer for WebCodecs output. Usage:
 *   const m = new Muxer({ video: { codec, width, height, description, timescale }, audio: { codec, sampleRate, channels, description } });
 *   m.addVideo(chunkBytes, { timestamp(µs), duration(µs), key }) → bytes to append to the mdat body
 *   m.addAudio(...)
 *   const { head, mdatHeaderSize } = m.finish(mdatBodySize) → write head, then the mdat body
 * The final file is head (ftyp + moov + mdat header) followed by all appended bytes in order.
 */
export class Muxer {
  constructor({ video, audio }) {
    this.tracks = [];
    if (video) this.tracks.push({ kind: 'video', id: 1, timescale: video.timescale || 90000, cfg: video, samples: [] });
    if (audio) this.tracks.push({ kind: 'audio', id: video ? 2 : 1, timescale: audio.sampleRate, cfg: audio, samples: [] });
    this.offset = 0; // within mdat body
  }
  _add(kind, data, { timestamp, duration, key }) {
    const t = this.tracks.find(x => x.kind === kind);
    if (!t) throw new Error(`No ${kind} track`);
    const ts = Math.round((timestamp * t.timescale) / 1e6);
    const dur = duration ? Math.round((duration * t.timescale) / 1e6) : 0;
    t.samples.push({ offset: this.offset, size: data.length, pts: ts, dur, key: !!key });
    this.offset += data.length;
    return data;
  }
  addVideo(data, meta) { return this._add('video', data, meta); }
  /** (1.15) Chapters and captions (textSamples' text): their samples, to append to the mdat body after the rest. */
  addText(text) {
    const ts = textSamples(text);
    if (!ts.chap && !ts.subs) return new Uint8Array(0);
    this.text = { ts, at: this.offset };
    this.offset += ts.data.length;
    return ts.data;
  }
  addAudio(data, meta) { return this._add('audio', data, meta); }

  finish() {
    const ftyp = box('ftyp', enc.encode('isom'), bytes([32, 0x200]), enc.encode('isomiso2avc1mp41'));
    const mdatHeader = new Uint8Array(16); // 64-bit size: works past 4 GB
    const dv = new DataView(mdatHeader.buffer);
    dv.setUint32(0, 1);
    mdatHeader.set(enc.encode('mdat'), 4);
    const total = 16 + this.offset;
    dv.setUint32(8, Math.floor(total / 4294967296));
    dv.setUint32(12, total >>> 0);
    // moov size doesn't depend on the offsets (co64), so build once to measure, then for real.
    const probe = this._moov(0);
    const base = ftyp.length + probe.length + 16;
    const moov = this._moov(base);
    const head = new Uint8Array(ftyp.length + moov.length + 16);
    head.set(ftyp, 0); head.set(moov, ftyp.length); head.set(mdatHeader, ftyp.length + moov.length);
    return head;
  }

  _timing(t) {
    const s = t.samples;
    // decode times: presentation times in order (no reordering from WebCodecs on macOS, but stay safe)
    const sortedPts = s.map(x => x.pts).sort((a, b) => a - b);
    let shift = 0;
    for (let i = 0; i < s.length; i++) shift = Math.max(shift, sortedPts[i] - s[i].pts);
    const dts = sortedPts.map(p => p - shift);
    for (let i = 0; i < s.length; i++) {
      s[i].dts = dts[i];
      s[i].cto = s[i].pts - dts[i];
      if (!s[i].dur) s[i].dur = i + 1 < s.length ? Math.max(1, sortedPts[i + 1] - sortedPts[i]) : (i ? s[i - 1].dur : 1);
    }
    // Media timeline starts at the first decode time; presentation starts at the first pts.
    let minPts = Infinity, maxEnd = 0;
    for (const x of s) { minPts = Math.min(minPts, x.pts); maxEnd = Math.max(maxEnd, x.pts + x.dur); }
    const d0 = s.length ? dts[0] : 0;
    return { mediaDur: s.length ? maxEnd - d0 : 0, presDur: s.length ? maxEnd - minPts : 0, start: s.length ? minPts - d0 : 0, shift };
  }

  _moov(base) {
    const MOVIE_TS = 1000;
    const traks = [];
    let movieDur = 0;
    for (const t of this.tracks) {
      const { mediaDur, presDur, start } = this._timing(t);
      const dur = Math.round((presDur * MOVIE_TS) / t.timescale);
      movieDur = Math.max(movieDur, dur);
      traks.push(this._trak(t, base, mediaDur, dur, start));
    }
    const mvhd = fullbox('mvhd', 0, 0, bytes([32, 0], [32, 0], [32, MOVIE_TS], [32, movieDur], [32, 0x00010000], [16, 0x0100], [16, 0], [32, 0], [32, 0]),
      MATRIX, new Uint8Array(24), bytes([32, this.tracks.length + 1]));
    const moov = box('moov', mvhd, ...traks);
    return this.text ? moovWithText(moov, this.text.ts, base + this.text.at) : moov;
  }

  _trak(t, base, mediaDur, movieDur, start) {
    const video = t.kind === 'video';
    const tkhd = fullbox('tkhd', 0, 3, bytes([32, 0], [32, 0], [32, t.id], [32, 0], [32, movieDur], [32, 0], [32, 0], [16, 0], [16, 0],
      [16, video ? 0 : 0x0100], [16, 0]), MATRIX, bytes([32, video ? t.cfg.width * 65536 : 0], [32, video ? t.cfg.height * 65536 : 0]));
    // Edit list: present from the first sample's time (handles a non-zero first timestamp).
    const elst = fullbox('elst', 0, 0, bytes([32, 1], [32, movieDur], [32, start], [16, 1], [16, 0]));
    const mdhd = fullbox('mdhd', 0, 0, bytes([32, 0], [32, 0], [32, t.timescale], [32, mediaDur], [16, 0x55c4], [16, 0]));
    const hdlr = fullbox('hdlr', 0, 0, bytes([32, 0]), enc.encode(video ? 'vide' : 'soun'), new Uint8Array(12), enc.encode(video ? 'VideoHandler\0' : 'SoundHandler\0'));
    const xmhd = video ? fullbox('vmhd', 0, 1, new Uint8Array(8)) : fullbox('smhd', 0, 0, new Uint8Array(4));
    const dinf = box('dinf', fullbox('dref', 0, 0, bytes([32, 1]), fullbox('url ', 0, 1)));
    const stbl = box('stbl', this._stsd(t), ...this._tables(t, base));
    return box('trak', tkhd, box('edts', elst), box('mdia', mdhd, hdlr, box('minf', xmhd, dinf, stbl)));
  }

  _stsd(t) {
    const c = t.cfg;
    let entry;
    if (t.kind === 'video') {
      const hevc = /^(hvc1|hev1)/.test(c.codec);
      const fields = bytes([32, 0], [16, 0], [16, 1], // reserved, data ref index
        [16, 0], [16, 0], [32, 0], [32, 0], [32, 0], [16, c.width], [16, c.height],
        [32, 0x00480000], [32, 0x00480000], [32, 0], [16, 1]);
      const name = new Uint8Array(32);
      // Keep a 1:1 pixel aspect and BT.709 colour tag so players don't guess.
      entry = box(hevc ? 'hvc1' : 'avc1', fields, name, bytes([16, 0x18], [16, 0xffff]),
        box(hevc ? 'hvcC' : 'avcC', new Uint8Array(c.description)),
        box('colr', enc.encode('nclx'), bytes([16, 1], [16, 1], [16, 1], [8, 0])),
        box('pasp', bytes([32, 1], [32, 1])));
    } else {
      const asc = new Uint8Array(c.description);
      const dsi = descriptor(5, asc);
      const dcd = descriptor(4, new Uint8Array([0x40, 0x15, 0, 0, 0, ...bytes([32, c.bitrate || 192000], [32, c.bitrate || 192000]), ...dsi]));
      const esd = descriptor(3, new Uint8Array([0, 1, 0, ...dcd, ...descriptor(6, new Uint8Array([2]))]));
      entry = box('mp4a', bytes([32, 0], [16, 0], [16, 1], [32, 0], [32, 0], [16, c.channels], [16, 16], [16, 0], [16, 0], [32, (c.sampleRate << 16) >>> 0]),
        fullbox('esds', 0, 0, esd));
    }
    return fullbox('stsd', 0, 0, bytes([32, 1]), entry);
  }

  _tables(t, base) {
    const s = t.samples;
    // Tables can hold hundreds of thousands of entries, so they're packed straight into typed arrays.
    const pack = (rows, width, fill) => {
      const out = new Uint8Array(4 + rows * width * 4);
      const dv = new DataView(out.buffer);
      dv.setUint32(0, rows);
      for (let i = 0; i < rows; i++) fill(dv, 4 + i * width * 4, i);
      return out;
    };
    const runs = (get) => {
      const r = [];
      for (const x of s) { const v = get(x); const last = r[r.length - 1]; if (last && last[1] === v) last[0]++; else r.push([1, v]); }
      return r;
    };
    const stts = runs(x => x.dur);
    const out = [fullbox('stts', 0, 0, pack(stts.length, 2, (dv, o, i) => { dv.setUint32(o, stts[i][0]); dv.setUint32(o + 4, stts[i][1]); }))];
    if (s.some(x => x.cto)) {
      const ct = runs(x => x.cto);
      out.push(fullbox('ctts', 1, 0, pack(ct.length, 2, (dv, o, i) => { dv.setUint32(o, ct[i][0]); dv.setInt32(o + 4, ct[i][1]); })));
    }
    if (t.kind === 'video' && s.some(x => !x.key)) {
      const keys = [];
      s.forEach((x, i) => { if (x.key) keys.push(i + 1); });
      out.push(fullbox('stss', 0, 0, pack(keys.length, 1, (dv, o, i) => dv.setUint32(o, keys[i]))));
    }
    // one chunk per run of consecutive samples (interleaving splits runs)
    const chunks = [];
    for (let i = 0; i < s.length; i++) {
      const last = chunks[chunks.length - 1];
      if (last && last.end === s[i].offset) { last.n++; last.end += s[i].size; } else chunks.push({ off: s[i].offset, n: 1, end: s[i].offset + s[i].size });
    }
    const stsc = [];
    chunks.forEach((c, i) => { const last = stsc[stsc.length - 1]; if (!last || last[1] !== c.n) stsc.push([i + 1, c.n]); });
    out.push(fullbox('stsc', 0, 0, pack(stsc.length, 3, (dv, o, i) => { dv.setUint32(o, stsc[i][0]); dv.setUint32(o + 4, stsc[i][1]); dv.setUint32(o + 8, 1); })));
    const stsz = pack(s.length, 1, (dv, o, i) => dv.setUint32(o, s[i].size));
    out.push(fullbox('stsz', 0, 0, bytes([32, 0]), stsz));
    out.push(fullbox('co64', 0, 0, pack(chunks.length, 2, (dv, o, i) => { const v = base + chunks[i].off; dv.setUint32(o, Math.floor(v / 4294967296)); dv.setUint32(o + 4, v >>> 0); })));
    return out;
  }
}
