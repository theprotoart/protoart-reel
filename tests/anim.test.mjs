// Animated GIF / APNG encoders: decode what they write and compare pixels.
import test from 'node:test';
import assert from 'node:assert';
import zlib from 'node:zlib';
import { GifEncoder, ApngEncoder, lzw, filterRows, changedBox } from '../app/renderer/lib/anim.js';

function unlzw(blocks, minCode) {
  const data = []; let o = 0;
  for (;;) { const n = blocks[o++]; if (!n) break; for (let i = 0; i < n; i++) data.push(blocks[o++]); }
  const clear = 1 << minCode, eoi = clear + 1, out = [];
  let size = minCode + 1, dict = [], prev = null, bits = 0, acc = 0, p = 0;
  const reset = () => { dict = []; for (let i = 0; i < clear; i++) dict[i] = [i]; dict[clear] = []; dict[eoi] = []; size = minCode + 1; prev = null; };
  reset();
  for (;;) {
    while (bits < size) { acc |= (data[p++] ?? 0) << bits; bits += 8; }
    const code = acc & ((1 << size) - 1); acc >>>= size; bits -= size;
    if (code === clear) { reset(); continue; }
    if (code === eoi) break;
    let entry;
    if (code < dict.length) entry = dict[code]; else entry = [...prev, prev[0]];
    out.push(...entry);
    if (prev) { dict.push([...prev, entry[0]]); }
    if (dict.length === (1 << size) && size < 12) size++;
    prev = entry;
  }
  return out;
}

function gifFrames(bytes) {
  // minimal GIF reader for our own output
  let o = 13; const W = bytes[6] | bytes[7] << 8, H = bytes[8] | bytes[9] << 8;
  const screen = new Uint8Array(W * H * 3); const frames = [];
  let trans = false, delay = 0;
  while (o < bytes.length) {
    const b = bytes[o++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = bytes[o++];
      if (label === 0xf9) { trans = !!(bytes[o + 1] & 1); delay = bytes[o + 2] | bytes[o + 3] << 8; }
      while (bytes[o]) o += bytes[o] + 1; o++;
      continue;
    }
    if (b === 0x2c) {
      const x = bytes[o] | bytes[o + 1] << 8, y = bytes[o + 2] | bytes[o + 3] << 8, w = bytes[o + 4] | bytes[o + 5] << 8, h = bytes[o + 6] | bytes[o + 7] << 8, flags = bytes[o + 8]; o += 9;
      const tsize = 3 << ((flags & 7) + 1), table = bytes.subarray(o, o + tsize); o += tsize;
      const min = bytes[o++]; const start = o;
      while (bytes[o]) o += bytes[o] + 1; o++;
      const idx = unlzw(bytes.subarray(start, o), min);
      for (let j = 0; j < w * h; j++) { const k = idx[j]; if (trans && k === 255) continue; const s = ((y + Math.floor(j / w)) * W + x + (j % w)) * 3; screen[s] = table[k * 3]; screen[s + 1] = table[k * 3 + 1]; screen[s + 2] = table[k * 3 + 2]; }
      frames.push({ rgb: screen.slice(), delay });
    }
  }
  return { W, H, frames };
}

const frame = (w, h, fn) => { const a = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = fn(x, y); const p = (y * w + x) * 4; a[p] = r; a[p + 1] = g; a[p + 2] = b; a[p + 3] = 255; } return a; };

test('LZW round trip, including a dictionary reset past 4096 codes', () => {
  const idx = Array.from({ length: 60000 }, (_, i) => (i * 7919 + (i >> 5)) % 256);
  assert.deepStrictEqual(unlzw(lzw(idx, 8), 8), idx);
  const flat = new Array(5000).fill(3);
  assert.deepStrictEqual(unlzw(lzw(flat, 8), 8), flat);
});

test('GIF: frames decode to the right picture; still frames merge; only changes are stored', () => {
  const W = 40, H = 24, parts = [];
  const enc = new GifEncoder(W, H, b => parts.push(b), { dither: false, tolerance: 0 });
  const f1 = frame(W, H, (x, y) => [x < 20 ? 255 : 0, y < 12 ? 128 : 0, 64]);
  const f2 = frame(W, H, (x, y) => (x >= 30 && y >= 10 && y < 14 ? [0, 255, 0] : [x < 20 ? 255 : 0, y < 12 ? 128 : 0, 64]));
  enc.addFrame(f1, 0.1); enc.addFrame(f1, 0.1); enc.addFrame(f2, 0.1);
  enc.finish();
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { bytes.set(p, o); o += p.length; }
  assert.strictEqual(String.fromCharCode(...bytes.subarray(0, 6)), 'GIF89a');
  const g = gifFrames(bytes);
  assert.strictEqual(g.frames.length, 2, 'the repeated frame became a longer first frame');
  assert.strictEqual(g.frames[0].delay, 20);
  const at = (rgb, x, y) => [...rgb.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)];
  assert.deepStrictEqual(at(g.frames[0].rgb, 5, 5), [255, 128, 64]);
  assert.deepStrictEqual(at(g.frames[1].rgb, 35, 11), [0, 255, 0]);
  assert.deepStrictEqual(at(g.frames[1].rgb, 5, 20), [255, 0, 64]);
  assert.deepStrictEqual(changedBox(f2, f1, W, H), { x: 30, y: 10, w: 10, h: 4 });
});

test('APNG: valid chunks, frame count, pixels survive filtering and deflate', async () => {
  const W = 33, H = 17, parts = [];
  const enc = new ApngEncoder(W, H, b => parts.push(b));
  const f1 = frame(W, H, (x, y) => [x * 7, y * 13, (x * y) & 255]);
  const f2 = frame(W, H, (x, y) => (x === 4 && y === 4 ? [1, 2, 3] : [x * 7, y * 13, (x * y) & 255]));
  await enc.addFrame(f1, 0.5); await enc.addFrame(f2, 0.25); await enc.addFrame(f2, 0.25);
  const head = enc.finish();
  const all = Buffer.concat([head, ...parts]);
  assert.deepStrictEqual([...all.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = []; let o = 8;
  while (o < all.length) { const n = all.readUInt32BE(o), t = all.toString('latin1', o + 4, o + 8); chunks.push({ t, d: all.subarray(o + 8, o + 8 + n) }); o += 12 + n; }
  assert.deepStrictEqual(chunks.map(c => c.t), ['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'IEND']);
  assert.strictEqual(chunks[1].d.readUInt32BE(0), 2);
  assert.strictEqual(chunks[4].d.readUInt16BE(20), 500, 'second frame lasts 0.25 + 0.25 s');
  // unfilter the first frame and compare
  const raw = zlib.inflateSync(chunks[3].d), stride = W * 4, px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const v = raw[y * (stride + 1) + 1 + i], a = i >= 4 ? px[y * stride + i - 4] : 0, b = y ? px[(y - 1) * stride + i] : 0, c = y && i >= 4 ? px[(y - 1) * stride + i - 4] : 0;
      let p = 0; if (f === 1) p = a; else if (f === 2) p = b; else if (f === 3) p = (a + b) >> 1; else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + i] = (v + p) & 255;
    }
  }
  assert.deepStrictEqual([...px], [...f1].map(v => v));
  // second frame is just the one changed pixel
  assert.deepStrictEqual([chunks[4].d.readUInt32BE(4), chunks[4].d.readUInt32BE(8), chunks[4].d.readUInt32BE(12), chunks[4].d.readUInt32BE(16)], [1, 1, 4, 4]);
  void filterRows;
});
