// ScreenFlow recordings (.scc), read for importing ScreenFlow projects into Reel. Written for Reel from an analysis
// of the file format (interoperability); no ScreenFlow code is used.
//
// File:  'bccs' header (u32 version, u32 offset of the index, u32 unix time) … stream data … SQLite index.
// Index: streamDesc (one row per stream: screen, camera / microphone, cursor, markers), blob (every frame or
//        packet: hostTime µs, stream, offset, size, changed rectangle), desktopState (cursor position, shape,
//        buttons and the foreground window per moment), frontmostProcess, pauseResume.
// Video: a frame is three zlib chunks ('-ff-' + size), the Y, U and V planes, then a 16-byte trailer
//        (three chunk sizes + 'tail'). Y starts with the changed rectangle and three block maps ('+yy+',
//        '+uu+', '+vv+': PackBits-style runs, four 2-bit codes per byte, one per 8×8 luma block in raster
//        order: 0 unchanged, 1/2 transform-coded at two qualities, 3 one flat value). Each plane then has one
//        section per method ('3yy3', '3uu3', '3vv3'). Transform blocks hold 8-bit coefficients packed by a
//        presence mask and are rebuilt by a 4×4 integer transform (four per 8×8 luma block, one per 4×4
//        chroma block). Unchanged blocks keep the previous frame.
// Audio: 'H' + u32 byte count + u32 frames, then a canonical Huffman code over the bytes of 16-bit PCM
//        (256 five-bit code lengths, a five-bit tail count, then LSB-first codes).
import { openSqlite } from './sqlite-lite.js';

const u32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const tag = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

/** Reads the index of a recording. reader: { size, read(offset, length) → Promise<Uint8Array> }. */
export async function openScc(reader) {
  const head = await reader.read(0, 16);
  if (tag(head, 0) !== 'bccs') throw new Error('Not a ScreenFlow recording');
  const at = u32(head, 8);
  const db = openSqlite(await reader.read(at, reader.size - at)).tables;
  const streams = db.streamDesc.objects().map(s => ({
    id: s.streamID, name: s.name, guid: s.guid, kind: s.dataType === 1 ? 'video' : s.dataType === 4 ? 'audio' : s.dataType === 9 ? 'cursor' : s.dataType === 10 ? 'markers' : 'other',
    width: s.r_right - s.r_left + 1, height: s.r_bottom - s.r_top + 1, codec: s.codecType, pixelFormat: s.arbusPixelFormat,
    codecFormat: s.arbusCodecFormat, sampleRate: s.audioSampleRate, flipped: !!s.flipped, dpi: s.recordedAtDPI || 72,
  }));
  const blobs = db.blob.objects().filter(b => b.nbytes > 0);
  const byStream = id => blobs.filter(b => b.streamID === id).sort((a, b) => a.hostTime - b.hostTime || a.offset - b.offset);
  return {
    streams, reader, byStream,
    desktop: db.desktopState ? db.desktopState.objects().sort((a, b) => a.hostTime - b.hostTime) : [],
    pauses: db.pauseResume ? db.pauseResume.objects() : [],
    apps: db.processInfo ? db.processInfo.objects() : [],
    frontmost: db.frontmostProcess ? db.frontmostProcess.objects() : [],
    cursorShapes: db.blob.objects().filter(b => b.streamID === 0 && b.nbytes > 0),
  };
}

// ------------------------------------------------------------------ video
const s16 = v => ((v << 16) >> 16);
const mulhrs = (a, b) => s16((((a * b) >> 14) + 1) >> 1);
const X3 = [32767, 13107, 32767, 13107, 32767, 13107, 32767, 13107], X2 = [1, 1, -1, -1, 1, 1, -1, -1], X4 = [1, -1, 1, -1, 1, -1, 1, -1];
const SH8 = [0, 2, 3, 1, 4, 6, 7, 5, 8, 10, 11, 9, 12, 14, 15, 13], SH4 = [0, 4, 8, 12, 2, 6, 10, 14, 3, 7, 11, 15, 1, 5, 9, 13];
const QT_LUMA = [4, 4, 4, 6, 6, 6, 8, 8, 8, 8, 10, 10, 10, 10, 12, 12], QT_CHROMA = [4, 6, 8, 8, 10, 12, 10, 12, 14, 16, 14, 16, 18, 20, 18, 20];
const QROW = (() => { const t1 = 0.5, t2 = 0.6532814824381883, A = Math.trunc(t1 * t1 * 32768), B = Math.trunc(t2 * t2 * 32768), C = Math.trunc(t1 * t2 * 32768); return [A, C, A, C, C, B, C, B]; })();

// one butterfly stage over 8 lanes (two groups of four), on Int32Array scratch
function stage(v, o) {
  const t0 = s16(mulhrs(v[2], 32767) + v[0]), t1 = s16(mulhrs(v[3], 13107) + v[1]), t2 = s16(mulhrs(v[0], 32767) - v[2]), t3 = s16(mulhrs(v[1], 13107) - v[3]);
  const t4 = s16(mulhrs(v[6], 32767) + v[4]), t5 = s16(mulhrs(v[7], 13107) + v[5]), t6 = s16(mulhrs(v[4], 32767) - v[6]), t7 = s16(mulhrs(v[5], 13107) - v[7]);
  o[0] = s16(t0 + t1); o[1] = s16(t0 - t1); o[2] = s16(t2 + t3); o[3] = s16(t2 - t3);
  o[4] = s16(t4 + t5); o[5] = s16(t4 - t5); o[6] = s16(t6 + t7); o[7] = s16(t6 - t7);
}
const lo = new Int32Array(8), hi = new Int32Array(8), A = new Int32Array(8), Bv = new Int32Array(8), E = new Int32Array(8), F = new Int32Array(8), A2 = new Int32Array(8), B2 = new Int32Array(8), pk = new Uint8Array(16);
const clip8 = x => { x = mulhrs(x, QS) + 128; return x < 0 ? 0 : x > 255 ? 255 : x; };
let QS = 0;
/** 16 coefficient bytes → 16 pixels (one 4×4 block), with quality qs and output byte order sh. */
function idct16(c, p, qs, sh, out, op) {
  for (let i = 0; i < 8; i++) { lo[i] = mulhrs(((c[p + i] << 24) >> 24) * 64, QROW[i]); hi[i] = mulhrs(((c[p + 8 + i] << 24) >> 24) * 64, QROW[i]); }
  stage(lo, A); stage(hi, Bv);
  // interleave words, dwords 0,2,3,1, interleave again (done as one gather)
  E[0] = A[0]; E[1] = A[4]; E[2] = Bv[0]; E[3] = Bv[4]; E[4] = A[2]; E[5] = A[6]; E[6] = Bv[2]; E[7] = Bv[6];
  F[0] = A[3]; F[1] = A[7]; F[2] = Bv[3]; F[3] = Bv[7]; F[4] = A[1]; F[5] = A[5]; F[6] = Bv[1]; F[7] = Bv[5];
  stage(E, A2); stage(F, B2);
  QS = qs;
  for (let i = 0; i < 8; i++) { pk[i] = clip8(A2[i]); pk[8 + i] = clip8(B2[i]); }
  for (let i = 0; i < 16; i++) out[op + i] = pk[sh[i]];
}
// the byte interleaves that turn four 4×4 results into one 8×8 tile, as a lookup (tile byte → result byte)
const TILE8 = (() => {
  const ilv = (a, b) => { const r = []; for (let i = 0; i < 8; i++) r.push(a[i], b[i]); return r; };
  const ilvH = (a, b) => { const r = []; for (let i = 0; i < 8; i++) r.push(a[8 + i], b[8 + i]); return r; };
  const P = [0, 1, 2, 3].map(k => Array.from({ length: 16 }, (_, i) => k * 16 + i)), out = [];
  for (const [a, b] of [[P[0], P[1]], [P[2], P[3]]]) {
    const s1 = ilv(a, b), s2 = ilvH(a, b), c1 = ilv(s1, s2), c2 = ilvH(s1, s2);
    out.push(...ilv(c1, c2), ...ilvH(c1, c2));
  }
  return Int32Array.from(out);
})();

function unrle(b, p, out) {
  const len = u32(b, p), end = p + len; let q = p + 8, o = 0, rep = false, last = 0;
  while (q < end) {
    const n = b[q++];
    if (!rep) {
      if (n === 0) { last = out[o - 1]; rep = true; }
      else if (n === 0xff) { out.set(b.subarray(q, q + 255), o); o += 255; q += 255; }
      else { out.set(b.subarray(q, q + n), o); o += n; q += n; last = out[o - 1]; rep = true; }
    } else { rep = n === 0xff; out.fill(last, o, o + n); o += n; }
  }
  return end;
}

/** Decodes ScreenFlow screen frames into persistent I420 planes (y, u, v), applying only what changed. */
export class VvDecoder {
  constructor(width, height, codecFormat) {
    this.W = width; this.H = height; this.cw = width >> 1; this.ch = height >> 1;
    // one I420 buffer, the three planes views into it (handed to the encoder as is: no copy per frame)
    const ys = width * height, cs = this.cw * this.ch;
    this.buf = new Uint8Array(ys + cs * 2); this.buf.fill(128, ys);
    this.y = this.buf.subarray(0, ys); this.u = this.buf.subarray(ys, ys + cs); this.v = this.buf.subarray(ys + cs);
    const fine = (codecFormat >> 8) & 15, coarse = (codecFormat >> 12) & 15;
    this.quality = [fine ? fine - 1 : null, Math.max(0, coarse - 1)]; // methods for codes 1 and 2 (null: lossless)
    const blocks = (width >> 3) * (height >> 3);
    this.maps = [new Uint8Array(blocks), new Uint8Array(blocks), new Uint8Array(blocks)];
    this.tmp = new Uint8Array(64); this.coef = new Uint8Array(64); this.quad = new Uint8Array(64);
  }
  async frame(blob, inflate) {
    const n = blob.length, ys = u32(blob, n - 16), us = u32(blob, n - 12), vs = u32(blob, n - 8), t = tag(blob, n - 4);
    if (t !== 'liat' && t !== 'tail') throw new Error('Bad ScreenFlow frame');
    const planes = []; let p = 0;
    for (const sz of [ys, us, vs]) { if (tag(blob, p) !== '-ff-') throw new Error('Bad ScreenFlow frame chunk'); planes.push(await inflate(blob.subarray(p + 8, p + sz), u32(blob, p + 4))); p += sz; }
    const [Y, U, V] = planes;
    const x = u32(Y, 0), y = u32(Y, 4), w = u32(Y, 8), h = u32(Y, 12);
    let q = 16;
    if (tag(Y, q) === '+mm+') throw new Error('This ScreenFlow recording uses a format Reel can’t read yet (moved regions)');
    for (let i = 0; i < 3; i++) { if (tag(Y, q) !== ['+yy+', '+uu+', '+vv+'][i]) throw new Error('Bad ScreenFlow block map'); q = unrle(Y, q + 4, this.maps[i]); }
    const bpr = this.W >> 3, lists = [[[], [], []], [[], [], []], [[], [], []]];
    for (let by = y >> 3; by < (y + h + 7) >> 3; by++) for (let bx = x >> 3; bx < (x + w + 7) >> 3; bx++) {
      const i = by * bpr + bx, sh = (i * 2) & 6;
      for (let pi = 0; pi < 3; pi++) { const c = (this.maps[pi][i >> 2] >> sh) & 3; if (c) lists[pi][c - 1].push(i); }
    }
    this._plane(Y, q, '3yy3', lists[0], true);
    this._plane(U, 0, '3uu3', lists[1], false, this.u);
    this._plane(V, 0, '3vv3', lists[2], false, this.v);
    return { x, y, w, h };
  }
  _plane(buf, pos, want, lists, luma, chroma) {
    const bpr = this.W >> 3, tmp = this.tmp;
    for (let mi = 0; mi < 3; mi++) {
      if (tag(buf, pos) !== want) throw new Error('Bad ScreenFlow plane section');
      pos += 4;
      const blocks = lists[mi];
      if (mi === 2) { // one flat value per block
        const cnt = u32(buf, pos); pos += 4;
        for (let k = 0; k < Math.min(cnt, blocks.length); k++) this._put(blocks[k], luma, chroma, null, buf[pos + k], bpr);
        pos += cnt; continue;
      }
      const len = u32(buf, pos), end = pos + len; let q = pos + 8;
      if (blocks.length) {
        const qi = this.quality[mi];
        if (qi === null) throw new Error('This ScreenFlow recording uses lossless blocks, which Reel can’t read yet');
        const qs = s16(Math.trunc((luma ? QT_LUMA : QT_CHROMA)[qi]) << 9), coef = this.coef, quad = this.quad;
        for (const i of blocks) {
          q = readCoefs(buf, q, coef, luma ? 4 : 1);
          if (luma) {
            for (let k = 0; k < 4; k++) idct16(coef, k * 16, qs, SH8, quad, k * 16);
            for (let k = 0; k < 64; k++) tmp[k] = quad[TILE8[k]];
          } else idct16(coef, 0, qs, SH4, tmp, 0);
          this._put(i, luma, chroma, tmp, 0, bpr);
        }
      }
      pos = end;
    }
  }
  /** Writes one block (8×8 luma tile or 4×4 chroma tile, row by row) into the raster planes. */
  _put(i, luma, plane, px, flat, bpr) {
    const bx = i % bpr, by = (i / bpr) | 0;
    if (luma) {
      const W = this.W, y = this.y; let o = by * 8 * W + bx * 8;
      if (px) { for (let r = 0, k = 0; r < 8; r++, o += W) for (let c = 0; c < 8; c++) y[o + c] = px[k++]; }
      else for (let r = 0; r < 8; r++, o += W) y.fill(flat, o, o + 8);
    } else {
      const W = this.cw; let o = by * 4 * W + bx * 4;
      if (px) { for (let r = 0, k = 0; r < 4; r++, o += W) for (let c = 0; c < 4; c++) plane[o + c] = px[k++]; }
      else for (let r = 0; r < 4; r++, o += W) plane.fill(flat, o, o + 4);
    }
  }
  /** The current picture as one I420 buffer. */
  i420() { return this.buf; }
}

function readCoefs(b, p, out, groups) {
  const hdr = b[p++];
  for (let k = 0; k < groups; k++) {
    const f = groups === 4 ? (hdr >> (6 - 2 * k)) & 3 : hdr === 0 ? 0 : hdr === 1 ? 1 : 2, o = k * 16;
    if (f === 0) out.fill(0, o, o + 16);
    else if (f === 1) { out.fill(0, o, o + 16); out[o] = b[p++]; }
    else {
      const m = b[p++];
      for (let i = 0; i < 8; i++) { if (m & (0x80 >> i)) { out[o + 2 * i] = b[p]; out[o + 2 * i + 1] = b[p + 1]; p += 2; } else { out[o + 2 * i] = 0; out[o + 2 * i + 1] = 0; } }
    }
  }
  return p;
}

// ------------------------------------------------------------------ audio
const rev5 = v => ((v & 1) << 4) | ((v & 2) << 2) | (v & 4) | ((v & 8) >> 2) | ((v & 16) >> 4);
/** One audio packet → Int16Array of interleaved PCM. */
export function decodeAudioPacket(b) {
  if (b[0] !== 0x48) throw new Error('Bad ScreenFlow audio packet');
  const raw = u32(b, 1), d = b.subarray(9);
  let bit = 0;
  const get = n => { let v = 0; for (let i = 0; i < n; i++, bit++) v |= ((d[bit >> 3] >> (bit & 7)) & 1) << i; return v; };
  const lens = new Uint8Array(256);
  for (let s = 0; s < 256; s++) lens[s] = rev5(get(5));
  get(5); // bits used in the last byte
  // canonical codes → a 16-bit lookup (code read MSB-first from an LSB-first stream)
  let maxL = 0; for (const l of lens) maxL = Math.max(maxL, l);
  const sym = new Int16Array(1 << maxL).fill(-1), len = new Uint8Array(1 << maxL);
  let code = 0;
  for (let L = 1; L <= maxL; L++) {
    for (let s = 0; s < 256; s++) if (lens[s] === L) {
      const span = 1 << (maxL - L), base = code << (maxL - L);
      for (let k = 0; k < span; k++) { sym[base + k] = s; len[base + k] = L; }
      code++;
    }
    code <<= 1;
  }
  const out = new Uint8Array(raw), total = d.length * 8;
  let o = 0;
  while (o < raw && bit < total) {
    let peek = 0;
    for (let i = 0; i < maxL; i++) { const p = bit + i; peek = (peek << 1) | (p < total ? (d[p >> 3] >> (p & 7)) & 1 : 0); }
    const s = sym[peek]; if (s < 0) throw new Error('Bad ScreenFlow audio code');
    out[o++] = s; bit += len[peek];
  }
  return new Int16Array(out.buffer, 0, o >> 1);
}

// ------------------------------------------------------------------ cursor
/**
 * The pointer track in Reel's own cursor format (positions in points, clicks with button and position), plus
 * the foreground window frame whenever it changes. t0: µs host time of the picture's first frame.
 */
export function cursorTrack(scc, video, t0) {
  const scale = Math.max(1, (video.dpi || 72) / 72), W = video.width / scale, H = video.height / scale;
  const points = [], clicks = [], windows = [];
  let prevB = 0, prevW = '';
  for (const s of scc.desktop) {
    const ms = Math.round((s.hostTime - t0) / 1000), x = s.cursorX / scale, y = s.cursorY / scale;
    points.push([ms, +x.toFixed(1), +y.toFixed(1)]);
    const b = s.cursorButtons | 0;
    if (b && !prevB) clicks.push([ms, b & 2 ? 'r' : 'l', +x.toFixed(1), +y.toFixed(1)]);
    else if (!b && prevB) clicks.push([ms, 'u', +x.toFixed(1), +y.toFixed(1)]);
    prevB = b;
    const wk = [s.fw_left, s.fw_top, s.fw_right, s.fw_bottom].join();
    if (wk !== prevW && s.fw_right > s.fw_left) { windows.push([ms, ...[s.fw_left, s.fw_top, s.fw_right, s.fw_bottom].map(v => +(v / scale).toFixed(1))]); prevW = wk; }
  }
  return { version: 2, display: { bounds: { x: 0, y: 0, width: W, height: H }, scale }, rate: 60, points, clicks, keys: [], windows, from: 'screenflow' };
}

/** One 8×8 luma tile (64 coefficient bytes → 64 pixels, row by row) or one 4×4 chroma tile, for tests. */
export function decodeTile(coef, quality, luma) {
  const qs = s16(Math.trunc((luma ? QT_LUMA : QT_CHROMA)[quality]) << 9), out = new Uint8Array(luma ? 64 : 16);
  if (!luma) { idct16(coef, 0, qs, SH4, out, 0); return out; }
  const quad = new Uint8Array(64);
  for (let k = 0; k < 4; k++) idct16(coef, k * 16, qs, SH8, quad, k * 16);
  for (let k = 0; k < 64; k++) out[k] = quad[TILE8[k]];
  return out;
}
