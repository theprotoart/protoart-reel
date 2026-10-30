// Animated GIF and animated PNG (APNG) encoders, written for Reel (no outside code).
// Both take full RGBA frames one at a time and stream their bytes out through `emit`:
//  · only the rectangle that changed since the last frame is stored (the rest shows through),
//  · frames that don't change just make the previous one last longer,
//  · GIF: a palette per frame by median cut (+ optional ordered dither), LZW-packed;
//  · APNG: full-colour, per-row PNG filters chosen by the usual minimum-sum heuristic, deflated
//    with the platform's CompressionStream.

// ------------------------------------------------------------------ shared: what changed
/** Bounding box of pixels that differ by more than `tol` (0..255 per channel), or null. */
export function changedBox(a, b, w, h, tol = 0) {
  if (!b) return { x: 0, y: 0, w, h };
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    let row = y * w * 4;
    for (let x = 0; x < w; x++, row += 4) {
      if (Math.abs(a[row] - b[row]) > tol || Math.abs(a[row + 1] - b[row + 1]) > tol || Math.abs(a[row + 2] - b[row + 2]) > tol || a[row + 3] !== b[row + 3]) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ------------------------------------------------------------------ GIF
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v / 16 - 0.5) * 10);

/**
 * Median-cut palette over 15-bit colour bins. Returns { palette: Uint8Array(n*3), map: Uint8Array(32768) }
 * where map[bin] is the palette index for that bin. `counts` is a Uint32Array(32768) histogram.
 */
export function medianCut(counts, maxColors, sums = null) {
  const bins = [];
  for (let i = 0; i < 32768; i++) if (counts[i]) bins.push(i);
  const r = i => (i >> 10) & 31, g = i => (i >> 5) & 31, b = i => i & 31;
  const boxOf = list => {
    let rl = 31, rh = 0, gl = 31, gh = 0, bl = 31, bh = 0, n = 0;
    for (const i of list) { const R = r(i), G = g(i), B = b(i); if (R < rl) rl = R; if (R > rh) rh = R; if (G < gl) gl = G; if (G > gh) gh = G; if (B < bl) bl = B; if (B > bh) bh = B; n += counts[i]; }
    return { list, n, span: Math.max((rh - rl) * 1.0, (gh - gl) * 1.2, (bh - bl) * 0.8), axis: (rh - rl) >= (gh - gl) * 1.2 && (rh - rl) >= (bh - bl) * 0.8 ? r : (gh - gl) * 1.2 >= (bh - bl) * 0.8 ? g : b };
  };
  const boxes = bins.length ? [boxOf(bins)] : [];
  while (boxes.length < maxColors) {
    // split the box with the most pixels × spread
    let best = -1, score = 0;
    for (let k = 0; k < boxes.length; k++) { const s = boxes[k].span * Math.sqrt(boxes[k].n); if (boxes[k].list.length > 1 && s > score) { score = s; best = k; } }
    if (best < 0) break;
    const bx = boxes[best], ax = bx.axis;
    bx.list.sort((p, q) => ax(p) - ax(q));
    let acc = 0, cut = 0;
    for (; cut < bx.list.length - 1; cut++) { acc += counts[bx.list[cut]]; if (acc * 2 >= bx.n) break; }
    boxes.splice(best, 1, boxOf(bx.list.slice(0, cut + 1)), boxOf(bx.list.slice(cut + 1)));
  }
  const palette = new Uint8Array(Math.max(1, boxes.length) * 3), map = new Uint8Array(32768);
  boxes.forEach((bx, k) => {
    let R = 0, G = 0, B = 0;
    if (sums) {
      // average of the real 8-bit colours that fell in the box (exact for flat colours)
      for (const i of bx.list) { R += sums[i * 3]; G += sums[i * 3 + 1]; B += sums[i * 3 + 2]; map[i] = k; }
      palette[k * 3] = Math.round(R / bx.n); palette[k * 3 + 1] = Math.round(G / bx.n); palette[k * 3 + 2] = Math.round(B / bx.n);
    } else {
      for (const i of bx.list) { const c = counts[i]; R += r(i) * c; G += g(i) * c; B += b(i) * c; map[i] = k; }
      palette[k * 3] = Math.round((R / bx.n) * 255 / 31); palette[k * 3 + 1] = Math.round((G / bx.n) * 255 / 31); palette[k * 3 + 2] = Math.round((B / bx.n) * 255 / 31);
    }
  });
  return { palette, map, size: boxes.length };
}

/** GIF LZW for `minCode`-bit indices. Returns the packed bytes in 255-byte sub-blocks (with terminator). */
export function lzw(indices, minCode) {
  const clear = 1 << minCode, eoi = clear + 1;
  const out = [];
  let bits = 0, acc = 0, size = minCode + 1, next = eoi + 1;
  const put = code => { acc |= code << bits; bits += size; while (bits >= 8) { out.push(acc & 255); acc >>>= 8; bits -= 8; } };
  let dict = new Map();
  put(clear);
  let prefix = indices.length ? indices[0] : -1;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i], key = prefix * 4096 + k;
    const found = dict.get(key);
    if (found !== undefined) { prefix = found; continue; }
    put(prefix);
    if (next < 4096) { dict.set(key, next++); if (next > (1 << size) && size < 12) size++; }
    else { put(clear); dict = new Map(); size = minCode + 1; next = eoi + 1; }
    prefix = k;
  }
  if (prefix >= 0) put(prefix);
  put(eoi);
  if (bits > 0) out.push(acc & 255);
  // sub-blocks
  const blocks = new Uint8Array(out.length + Math.ceil(out.length / 255) + 1);
  let o = 0;
  for (let i = 0; i < out.length; i += 255) { const n = Math.min(255, out.length - i); blocks[o++] = n; for (let j = 0; j < n; j++) blocks[o++] = out[i + j]; }
  blocks[o++] = 0;
  return blocks.subarray(0, o);
}

export class GifEncoder {
  /** emit(Uint8Array) receives the file bytes in order. */
  constructor(w, h, emit, { dither = true, loop = true, tolerance = 2 } = {}) {
    Object.assign(this, { w, h, emit, dither, tolerance });
    this.prev = null; this.pending = null;
    const head = [];
    const s = str => { for (const ch of str) head.push(ch.charCodeAt(0)); };
    const u16 = v => head.push(v & 255, (v >> 8) & 255);
    s('GIF89a'); u16(w); u16(h); head.push(0x70, 0, 0); // no global table, 8-bit colour resolution
    if (loop) { head.push(0x21, 0xff, 11); s('NETSCAPE2.0'); head.push(3, 1, 0, 0, 0); }
    emit(new Uint8Array(head));
  }
  /** rgba: the whole frame (w×h×4). seconds: how long it shows. */
  addFrame(rgba, seconds) {
    const box = changedBox(rgba, this.prev, this.w, this.h, this.tolerance);
    if (!box && this.pending) { this.pending.dur += seconds; return; }
    this._flush();
    const b = box || { x: 0, y: 0, w: 1, h: 1 };
    const first = !this.prev;
    // histogram of the changed pixels (dithered)
    const counts = new Uint32Array(32768), sums = new Float64Array(32768 * 3), bins = new Uint16Array(b.w * b.h), skip = new Uint8Array(b.w * b.h);
    for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
      const p = ((b.y + y) * this.w + b.x + x) * 4, k = y * b.w + x;
      if (!first && this.prev && Math.abs(rgba[p] - this.prev[p]) <= this.tolerance && Math.abs(rgba[p + 1] - this.prev[p + 1]) <= this.tolerance && Math.abs(rgba[p + 2] - this.prev[p + 2]) <= this.tolerance) { skip[k] = 1; continue; }
      const d = this.dither ? BAYER[(y & 3) * 4 + (x & 3)] : 0;
      const R = Math.max(0, Math.min(255, rgba[p] + d)) >> 3, G = Math.max(0, Math.min(255, rgba[p + 1] + d)) >> 3, B = Math.max(0, Math.min(255, rgba[p + 2] + d)) >> 3;
      const bin = (R << 10) | (G << 5) | B;
      bins[k] = bin; counts[bin]++; sums[bin * 3] += rgba[p]; sums[bin * 3 + 1] += rgba[p + 1]; sums[bin * 3 + 2] += rgba[p + 2];
    }
    const transparent = !first; // index 255 shows the frame below
    const { palette, map } = medianCut(counts, transparent ? 255 : 256, sums);
    const idx = new Uint8Array(b.w * b.h);
    for (let k = 0; k < idx.length; k++) idx[k] = skip[k] ? 255 : map[bins[k]];
    const table = new Uint8Array(256 * 3); table.set(palette);
    this.pending = { box: b, table, data: lzw(idx, 8), transparent, dur: seconds };
    // what's on screen now
    if (!this.prev) this.prev = new Uint8ClampedArray(rgba);
    else for (let y = 0; y < b.h; y++) { const o = ((b.y + y) * this.w + b.x) * 4; this.prev.set(rgba.subarray(o, o + b.w * 4), o); }
  }
  _flush() {
    const f = this.pending;
    if (!f) return;
    this.pending = null;
    const cs = Math.max(2, Math.round(f.dur * 100));
    const { box: b } = f;
    const head = new Uint8Array([
      0x21, 0xf9, 4, (1 << 2) | (f.transparent ? 1 : 0), cs & 255, (cs >> 8) & 255, 255, 0, // GCE: keep the frame, transparent index 255
      0x2c, b.x & 255, b.x >> 8, b.y & 255, b.y >> 8, b.w & 255, b.w >> 8, b.h & 255, b.h >> 8, 0x87]); // local table, 256 entries
    this.emit(head); this.emit(f.table); this.emit(new Uint8Array([8])); this.emit(f.data);
  }
  finish() { this._flush(); this.emit(new Uint8Array([0x3b])); return new Uint8Array(0); }
}

// ------------------------------------------------------------------ APNG
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(parts) { let c = 0xffffffff; for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC[(c ^ p[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const t = new Uint8Array([...type].map(ch => ch.charCodeAt(0)));
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length); out.set(t, 4); out.set(data, 8); dv.setUint32(8 + data.length, crc32([t, data]));
  return out;
}
const be32 = (dv, o, v) => dv.setUint32(o, v >>> 0);

async function deflate(bytes) {
  const cs = new CompressionStream('deflate');
  const w = cs.writable.getWriter(); w.write(bytes); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

/** Filtered scanlines for an RGBA region (each row: filter byte + bytes), minimum-sum heuristic. */
export function filterRows(px, w, h) {
  const stride = w * 4, out = new Uint8Array((stride + 1) * h), cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  for (let y = 0; y < h; y++) {
    const row = px.subarray(y * stride, (y + 1) * stride), up = y ? px.subarray((y - 1) * stride, y * stride) : null;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = cand[f]; let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? row[i - 4] : 0, b = up ? up[i] : 0, cc = up && i >= 4 ? up[i - 4] : 0;
        let p;
        if (f === 0) p = 0; else if (f === 1) p = a; else if (f === 2) p = b; else if (f === 3) p = (a + b) >> 1;
        else { const pa = Math.abs(b - cc), pb = Math.abs(a - cc), pc = Math.abs(a + b - 2 * cc); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc; }
        const v = (row[i] - p) & 255; c[i] = v; sum += v < 128 ? v : 256 - v;
        if (sum >= bestSum) break;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    // recompute the winner fully (the loop above may have stopped early for it on a tie)
    const c = cand[best];
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? row[i - 4] : 0, b = up ? up[i] : 0, cc = up && i >= 4 ? up[i - 4] : 0;
      let p;
      if (best === 0) p = 0; else if (best === 1) p = a; else if (best === 2) p = b; else if (best === 3) p = (a + b) >> 1;
      else { const pa = Math.abs(b - cc), pb = Math.abs(a - cc), pc = Math.abs(a + b - 2 * cc); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc; }
      c[i] = (row[i] - p) & 255;
    }
    out[y * (stride + 1)] = best; out.set(c, y * (stride + 1) + 1);
  }
  return out;
}

export class ApngEncoder {
  constructor(w, h, emit, { loop = true, tolerance = 0 } = {}) {
    Object.assign(this, { w, h, emit, loop, tolerance });
    this.prev = null; this.pending = null; this.frames = 0; this.seq = 0;
  }
  async addFrame(rgba, seconds) {
    const box = changedBox(rgba, this.prev, this.w, this.h, this.tolerance);
    if (!box && this.pending) { this.pending.dur += seconds; return; }
    this._flush();
    const first = !this.prev;
    const b = first ? { x: 0, y: 0, w: this.w, h: this.h } : (box || { x: 0, y: 0, w: 1, h: 1 });
    const px = new Uint8Array(b.w * b.h * 4);
    for (let y = 0; y < b.h; y++) {
      const o = ((b.y + y) * this.w + b.x) * 4;
      for (let x = 0; x < b.w * 4; x += 4) {
        const s = o + x, d = y * b.w * 4 + x;
        // unchanged pixels become clear so the frame below shows (and they compress to nothing)
        if (!first && this.prev && Math.abs(rgba[s] - this.prev[s]) <= this.tolerance && Math.abs(rgba[s + 1] - this.prev[s + 1]) <= this.tolerance && Math.abs(rgba[s + 2] - this.prev[s + 2]) <= this.tolerance) continue;
        px[d] = rgba[s]; px[d + 1] = rgba[s + 1]; px[d + 2] = rgba[s + 2]; px[d + 3] = 255;
      }
    }
    this.pending = { box: b, first, data: await deflate(filterRows(px, b.w, b.h)), dur: seconds };
    if (!this.prev) this.prev = new Uint8ClampedArray(rgba);
    else for (let y = 0; y < b.h; y++) { const o = ((b.y + y) * this.w + b.x) * 4; this.prev.set(rgba.subarray(o, o + b.w * 4), o); }
  }
  _flush() {
    const f = this.pending;
    if (!f) return;
    this.pending = null;
    const fc = new Uint8Array(26), dv = new DataView(fc.buffer);
    const ms = Math.max(10, Math.round(f.dur * 1000));
    be32(dv, 0, this.seq++); be32(dv, 4, f.box.w); be32(dv, 8, f.box.h); be32(dv, 12, f.box.x); be32(dv, 16, f.box.y);
    dv.setUint16(20, ms); dv.setUint16(22, 1000); fc[24] = 0; fc[25] = f.first ? 0 : 1; // dispose none; blend over
    this.emit(chunk('fcTL', fc));
    if (f.first) this.emit(chunk('IDAT', f.data));
    else { const fd = new Uint8Array(4 + f.data.length); be32(new DataView(fd.buffer), 0, this.seq++); fd.set(f.data, 4); this.emit(chunk('fdAT', fd)); }
    this.frames++;
  }
  /** Writes the end; returns the header bytes that go before everything emitted (it needs the frame count). */
  finish() {
    this._flush();
    this.emit(chunk('IEND', new Uint8Array(0)));
    const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
    be32(dv, 0, this.w); be32(dv, 4, this.h); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
    const actl = new Uint8Array(8), da = new DataView(actl.buffer);
    be32(da, 0, this.frames); be32(da, 4, this.loop ? 0 : 1);
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('acTL', actl)];
    const head = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of parts) { head.set(p, o); o += p.length; }
    return head;
  }
}
