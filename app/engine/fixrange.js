// Exact colour fix for videos Reel converted from ScreenFlow before 1.4: ScreenFlow stores full-range
// colour (black 0, white 255) but those MP4s were labelled "video range", so every player stretched them and
// they looked too dark and contrasty. The picture data is right; only one bit in the H.264 header (the
// sequence parameter set's video_full_range_flag) is wrong. This flips that bit in place: no re-encoding,
// instant, and the colours come back exactly as they were in ScreenFlow.
'use strict';
const fs = require('fs');

/** Reads exp-Golomb / fixed bits from an RBSP (emulation-prevention bytes already removed). */
class Bits {
  constructor(b) { this.b = b; this.p = 0; }
  u(n) { let v = 0; for (let i = 0; i < n; i++) { const byte = this.b[this.p >> 3]; if (byte === undefined) throw new Error('SPS ended early'); v = (v << 1) | ((byte >> (7 - (this.p & 7))) & 1); this.p++; } return v >>> 0; }
  ue() { let z = 0; while (this.u(1) === 0) { if (++z > 31) throw new Error('Bad SPS'); } return (1 << z) - 1 + (z ? this.u(z) : 0); }
  se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -k / 2; }
}
function skipScalingList(bits, size) { let last = 8, next = 8; for (let j = 0; j < size; j++) { if (next !== 0) next = (last + bits.se() + 256) % 256; last = next === 0 ? last : next; } }

/**
 * Finds the video_full_range_flag in an SPS NAL unit (header byte included).
 * Returns { byte, mask, value } positions in the NAL itself, or null when the SPS carries no signal type.
 */
function findRangeFlag(nal) {
  // RBSP without emulation-prevention bytes, and where each RBSP byte sits in the NAL
  const rbsp = [], at = [];
  for (let i = 1, zeros = 0; i < nal.length; i++) {
    if (zeros >= 2 && nal[i] === 3) { zeros = 0; continue; }
    rbsp.push(nal[i]); at.push(i);
    zeros = nal[i] === 0 ? zeros + 1 : 0;
  }
  const b = new Bits(Uint8Array.from(rbsp));
  const profile = b.u(8); b.u(8); b.u(8); b.ue();
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    const chroma = b.ue(); if (chroma === 3) b.u(1);
    b.ue(); b.ue(); b.u(1);
    if (b.u(1)) for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) if (b.u(1)) skipScalingList(b, i < 6 ? 16 : 64);
  }
  b.ue();
  const poc = b.ue();
  if (poc === 0) b.ue(); else if (poc === 1) { b.u(1); b.se(); b.se(); const n = b.ue(); for (let i = 0; i < n; i++) b.se(); }
  b.ue(); b.u(1); b.ue(); b.ue();
  if (!b.u(1)) b.u(1);
  b.u(1);
  if (b.u(1)) { b.ue(); b.ue(); b.ue(); b.ue(); }
  if (!b.u(1)) return null;            // no VUI
  if (b.u(1)) { if (b.u(8) === 255) { b.u(16); b.u(16); } }
  if (b.u(1)) b.u(1);
  if (!b.u(1)) return null;            // no video signal type: nothing to flip
  b.u(3);
  const pos = b.p, value = b.u(1);
  return { byte: at[pos >> 3], mask: 0x80 >> (pos & 7), value };
}

/** Top-level boxes of an MP4 file: [{ type, start, size }]. */
function boxes(fd, fileSize) {
  const out = [], head = Buffer.alloc(16);
  for (let p = 0; p + 8 <= fileSize;) {
    fs.readSync(fd, head, 0, 16, p);
    let size = head.readUInt32BE(0); const type = head.toString('latin1', 4, 8);
    if (size === 1) size = Number(head.readBigUInt64BE(8)); else if (size === 0) size = fileSize - p;
    if (size < 8) break;
    out.push({ type, start: p, size }); p += size;
  }
  return out;
}

/**
 * Labels an MP4's H.264 video as full range. Returns 'fixed', 'already' (nothing to do) or throws with why
 * it can't (then the editor keeps correcting it on playback instead).
 */
function markFullRange(file) {
  const fd = fs.openSync(file, 'r+');
  try {
    const size = fs.fstatSync(fd).size;
    const moov = boxes(fd, size).find(b => b.type === 'moov');
    if (!moov || moov.size > 256 << 20) throw new Error('No movie header');
    const buf = Buffer.alloc(moov.size); fs.readSync(fd, buf, 0, moov.size, moov.start);
    const i = buf.indexOf('avcC', 0, 'latin1');
    if (i < 4) throw new Error('Not H.264');
    const c = i + 4;                     // avcC payload: version, profile, compat, level, nal length size, #SPS
    const nSps = buf[c + 5] & 0x1f;
    let p = c + 6, changed = 0;
    for (let k = 0; k < nSps; k++) {
      const len = buf.readUInt16BE(p), nal = buf.subarray(p + 2, p + 2 + len);
      const f = findRangeFlag(nal);
      if (!f) throw new Error('This video has no colour-range field to correct');
      if (!f.value) {
        const nb = nal[f.byte] | f.mask;
        // never create a 00 00 0x (x ≤ 3) pattern: it would be misread as an escape
        if (nb <= 3 && f.byte >= 2 && nal[f.byte - 1] === 0 && nal[f.byte - 2] === 0) throw new Error('Can’t change this header safely');
        nal[f.byte] = nb; changed++;
        const one = Buffer.from([nb]);
        fs.writeSync(fd, one, 0, 1, moov.start + (p + 2 + f.byte));
      }
      p += 2 + len;
    }
    // the MP4's own colour label ('colr' nclx), which some players read before the H.264 header
    const ci = buf.indexOf('colrnclx', 0, 'latin1');
    if (ci >= 0) {
      const flag = ci + 8 + 6; // primaries, transfer, matrix (2 bytes each), then full_range_flag in the top bit
      if (!(buf[flag] & 0x80)) { const v = buf[flag] | 0x80; fs.writeSync(fd, Buffer.from([v]), 0, 1, moov.start + flag); changed++; }
    }
    return changed ? 'fixed' : 'already';
  } finally { fs.closeSync(fd); }
}

module.exports = { markFullRange, findRangeFlag };
