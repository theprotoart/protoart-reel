// Spectral editor worker. Long files (an hour-long podcast) are edited the way RX and Audition do it: the
// sound stays on disk and is read in blocks as needed. Edits are a list; a block is made by reading the
// original (with some room either side) and applying the edits that reach it. Recently used blocks are kept
// in a cache of fixed size, and a low-resolution overview of the whole file draws the zoomed-out view, so
// memory stays about the same for a 3-minute clip and a 3-hour one.
import { demux } from './lib/mp4.js';
import { HttpReader, WavAudio, Mp4Audio } from './lib/sources.js';
import { fft, hann, applyEdit as coreEdit, paletteLUT, yToF, learnProfile, shapeBounds } from './spectral-dsp.js';
import { runEdit, findSimilar } from './spectral-rx.js';
import './spectral-restore.js';

const MAX_SECONDS = 4 * 3600;                 // what the editor accepts at all
const BLOCK = 10;                              // seconds per cached block
const OV_RATE = 20, OV_N = 1024, OV_BINS = OV_N / 2 + 1;   // overview: 20 columns a second, 513 bins
let src = null, start = 0, len = 0, rate = 48000, chs = 1, luts = new Map();
let edits = [], cache = new Map(), cacheLimit = 384 << 20, cacheBytes = 0;
let ov = null, ovWave = null, ovCols = 0;      // overview spectrogram (dB, Uint8) and waveform (min/max)

self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.type === 'open') return reply(m, await open(m));
    if (!src) throw new Error('Nothing is open');
    if (m.type === 'view') return reply(m, await view(m), 'view');
    if (m.type === 'apply') { edits.push(m.edit); const r = await afterEdit([m.edit]); return reply(m, r); }
    if (m.type === 'rebuild') { const old = edits; edits = m.edits.slice(); const r = await afterEdit(spanAll(old, edits)); return reply(m, r); }
    if (m.type === 'audio') {
      const chsOut = await renderRange(m.t0, m.t1, m.src === 'orig');
      return self.postMessage({ type: 'audio', id: m.id, rate, chs: chsOut }, chsOut.map(c => c.buffer));
    }
    if (m.type === 'render') return render(m);
    if (m.type === 'learn') { const part = await renderRange(m.t0, m.t1); const p = learnProfile(part, rate, 0, m.t1 - m.t0); if (!p) throw new Error('Select at least a quarter second of just the noise'); return reply(m, { profile: p }); }
    if (m.type === 'preview') return preview(m);
    if (m.type === 'similar') return similar(m);
  } catch (err) { self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) }); }
};
const reply = (m, data, type = 'done') => {
  const transfer = data && data.img ? [data.img.buffer, data.wave.buffer] : [];
  self.postMessage({ type, ...data, id: m.id }, transfer);
};
const progress = v => self.postMessage({ type: 'progress', value: v });
const dur = () => len / rate;

// ------------------------------------------------------------------ reading
async function open({ url, file, from, to, maxSeconds = MAX_SECONDS, cacheMB }) {
  const reader = await new HttpReader(url).open();
  if (/\.wav$/i.test(file)) src = await new WavAudio(reader).open();
  else {
    const d = await demux(reader);
    const a = d.tracks.find(t => t.kind === 'audio' && t.codec);
    if (!a) throw new Error('This clip has no sound Reel can read here');
    src = await new Mp4Audio(reader, a).open();
  }
  rate = src.rate;
  len = Math.max(0, Math.round((to - from) * rate));
  if (len > Math.min(maxSeconds, MAX_SECONDS) * rate) throw new Error(`Spectral editing works on up to ${Math.round(Math.min(maxSeconds, MAX_SECONDS) / 60)} minutes at a time. Splice the clip into shorter parts first.`);
  start = Math.round(from * rate); chs = Math.min(2, src.channels || 1);
  if (cacheMB) cacheLimit = cacheMB << 20;
  edits = []; cache.clear(); cacheBytes = 0;
  // the overview, read once from start to end
  ovCols = Math.max(1, Math.ceil(dur() * OV_RATE));
  ov = new Uint8Array(ovCols * OV_BINS); ovWave = new Float32Array(ovCols * 2);
  await buildOverview(0, dur(), p => progress(p));
  return { rate, channels: chs, duration: dur() };
}

/** Raw original samples [a, z) in seconds (clamped), per channel. */
async function readOrig(a, z) {
  const s0 = Math.max(0, Math.round(a * rate)), s1 = Math.min(len, Math.round(z * rate)), n = Math.max(0, s1 - s0);
  const out = Array.from({ length: chs }, () => new Float32Array(n));
  for (let p = 0; p < n; p += rate * 20) {
    const k = Math.min(rate * 20, n - p), got = await src.read(start + s0 + p, k);
    for (let c = 0; c < chs; c++) out[c].set(got[Math.min(c, got.length - 1)].subarray(0, k), p);
  }
  return out;
}

// ------------------------------------------------------------------ edits on blocks
/** Seconds of the clip an edit can change ([t0, t1]), or null when it works on all of it. */
function editSpan(ed) {
  const sel = ed.sel;
  if (!sel || !sel.shapes || !sel.shapes.length || sel.invert || sel.shapes.some(s => s.kind === 'freq')) return null;
  const b = shapeBounds(sel.shapes, dur(), rate / 2);
  if (!(b.t1 > b.t0)) return null;
  const f = sel.featherT || 0;
  return [b.t0 - f, b.t1 + f];
}
/** Room an edit needs around what it changes (what it learns from, or copies from). */
const padOf = ed => 2.5 + (ed.surround || 0) + (ed.op === 'pattern' ? ed.searchRange || 4 : ed.op === 'patch' ? Math.abs(ed.sourceOffset || 0) + 1 : 0);
const overlaps = (ed, a, z) => { const s = editSpan(ed); return !s || (s[1] + padOf(ed) > a && s[0] - padOf(ed) < z); };

function shiftSel(sel, dt) {
  if (!sel) return sel;
  const mv = t => t + dt;
  return { ...sel, shapes: (sel.shapes || []).map(s => s.kind === 'freq' ? s : s.kind === 'time' || s.kind === 'rect' ? { ...s, t0: mv(s.t0), t1: mv(s.t1) } : { ...s, pts: s.pts.map(([t, f]) => [mv(t), f]) }) };
}
/** Applies `list` to a stretch that starts at `a` seconds (part and its untouched original, in place). */
function applyList(part, origPart, a, list) {
  let fixed = 0;
  for (const ed of list) {
    const r = runEdit(part, rate, { ...ed, sel: ed.sel ? shiftSel(ed.sel, -a) : ed.sel }, coreEdit, { orig: origPart });
    fixed += (r && r.fixed) || 0;
  }
  return fixed;
}
/** The edited sound of one block (cached; a block already being made is waited for, not made twice). */
const making = new Map();
let editGen = 0;
function block(i) {
  const hit = cache.get(i);
  if (hit) { cache.delete(i); cache.set(i, hit); return Promise.resolve(hit); } // most recently used last
  const key = `${editGen}:${i}`;
  if (!making.has(key)) making.set(key, makeBlock(i).finally(() => making.delete(key)));
  return making.get(key);
}
async function makeBlock(i) {
  const gen = editGen;
  const a = i * BLOCK, z = Math.min(dur(), a + BLOCK);
  const list = edits.filter(ed => overlaps(ed, a, z));
  let chans;
  if (!list.length) chans = await readOrig(a, z);
  else {
    const pad = Math.min(40, Math.max(3, ...list.map(padOf)));
    const pa = Math.max(0, a - pad), pz = Math.min(dur(), z + pad);
    const origPart = await readOrig(pa, pz), part = origPart.map(c => c.slice());
    applyList(part, origPart, pa, list);
    const o0 = Math.round((a - pa) * rate), o1 = o0 + Math.round((z - a) * rate);
    chans = part.map(c => c.slice(o0, o1));
  }
  if (gen !== editGen) return chans; // the edits changed meanwhile: use it, don't keep it
  const bytes = chans.length * chans[0].length * 4;
  cache.set(i, chans); cacheBytes += bytes;
  for (const [k, v] of cache) { if (cacheBytes <= cacheLimit || k === i) break; cacheBytes -= v.length * v[0].length * 4; cache.delete(k); }
  return chans;
}
/** Edited (or original) sound for [t0, t1) seconds. */
async function renderRange(t0, t1, original = false) {
  t0 = Math.max(0, t0); t1 = Math.min(dur(), t1);
  const n = Math.max(0, Math.round((t1 - t0) * rate)), out = Array.from({ length: chs }, () => new Float32Array(n));
  if (!n) return out;
  if (original) return readOrig(t0, t1);
  const s0 = Math.round(t0 * rate);
  for (let i = Math.floor(t0 / BLOCK); i * BLOCK < t1; i++) {
    const b = await block(i), bs = Math.round(i * BLOCK * rate);
    const from = Math.max(s0, bs), to = Math.min(s0 + n, bs + b[0].length);
    for (let c = 0; c < chs; c++) out[c].set(b[c].subarray(from - bs, to - bs), from - s0);
  }
  return out;
}
/** Every edit in either list (a rebuild redraws what any of them touched). */
const spanAll = (a, b) => [...a, ...b];
/** After edits change: forget the blocks they reach and redraw their part of the overview. */
async function afterEdit(changed) {
  let lo = Infinity, hi = -Infinity, global = false;
  for (const ed of changed) { const s = editSpan(ed); if (!s) { global = true; break; } lo = Math.min(lo, s[0] - padOf(ed)); hi = Math.max(hi, s[1] + padOf(ed)); }
  if (!changed.length) return { fixed: 0 };
  if (global) { lo = 0; hi = dur(); }
  lo = Math.max(0, lo); hi = Math.min(dur(), hi);
  editGen++;
  for (const k of [...cache.keys()]) if (k * BLOCK < hi && (k + 1) * BLOCK > lo) { const v = cache.get(k); cacheBytes -= v.length * v[0].length * 4; cache.delete(k); }
  // a short stretch is redrawn now; a long one (a whole-file fix on an hour) in the background, block by
  // block, so the editor stays usable and the picture fills in as it goes (like RX)
  if (hi - lo <= 90) await buildOverview(lo, hi);
  else { dirty.push([lo, hi]); refreshOverview(); }
  // count what the last edit fixed (clicks…) on its own stretch, for the history list
  let fixed = 0;
  const last = changed[changed.length - 1], s = last && editSpan(last);
  if (last && s && s[1] - s[0] < 120) {
    const pad = padOf(last), pa = Math.max(0, s[0] - pad), pz = Math.min(dur(), s[1] + pad);
    const before = edits.slice(0, edits.indexOf(last));
    const part = await renderPartWith(before, pa, pz);
    fixed = applyList(part, await readOrig(pa, pz), pa, [last]);
  }
  return { fixed };
}
async function renderPartWith(list, a, z) {
  const origPart = await readOrig(a, z), part = origPart.map(c => c.slice());
  applyList(part, origPart, a, list.filter(ed => overlaps(ed, a, z)));
  return part;
}

// ------------------------------------------------------------------ overview
let dirty = [], refreshing = 0;
async function refreshOverview() {
  const gen = ++refreshing;
  await new Promise(r => setTimeout(r, 0));
  while (dirty.length && gen === refreshing) {
    // merge what's waiting into one range and work from its start
    let lo = Infinity, hi = -Infinity; for (const [a, z] of dirty) { lo = Math.min(lo, a); hi = Math.max(hi, z); }
    const z = Math.min(hi, (Math.floor(lo / BLOCK) + 1) * BLOCK);
    dirty = z >= hi ? [] : [[z, hi]];
    await buildOverview(lo, z);
    self.postMessage({ type: 'overview', t0: lo, t1: z, left: Math.max(0, hi - z), total: dur() });
    await new Promise(r => setTimeout(r, 0)); // let requests (views, playback) in between blocks
  }
}
// ------------------------------------------------------------------ overview
async function buildOverview(t0, t1, onProgress) {
  const c0 = Math.max(0, Math.floor(t0 * OV_RATE) - 1), c1 = Math.min(ovCols, Math.ceil(t1 * OV_RATE) + 1);
  const win = hann(OV_N), re = new Float64Array(OV_N), im = new Float64Array(OV_N), hop = rate / OV_RATE;
  for (let i = Math.floor((c0 / OV_RATE) / BLOCK); i * BLOCK < c1 / OV_RATE; i++) {
    const a = i * BLOCK, b = await block(i), bs = Math.round(a * rate), n = b[0].length;
    const next = (i + 1) * BLOCK < dur() ? await block(i + 1) : null; // the last window of a block reaches into the next
    const at = (c, s) => (s < n ? b[c][s] : next && s - n < next[c].length ? next[c][s - n] : 0);
    const k0 = Math.max(c0, Math.ceil(a * OV_RATE)), k1 = Math.min(c1, Math.ceil((a + BLOCK) * OV_RATE));
    for (let k = k0; k < k1; k++) {
      const s = Math.round(k * hop) - bs;
      for (let j = 0; j < OV_N; j++) { let v = 0; for (let c = 0; c < chs; c++) v += at(c, s - OV_N / 2 + j) || 0; re[j] = (v / chs) * win[j]; im[j] = 0; }
      fft(re, im);
      const o = k * OV_BINS;
      for (let q = 0; q < OV_BINS; q++) { const db = 20 * Math.log10(Math.hypot(re[q], im[q]) / (OV_N / 4) + 1e-9); ov[o + q] = Math.max(0, Math.min(255, Math.round((db + 140) * (255 / 140)))); }
      let lo = 0, hi = 0; for (let j = Math.max(0, s); j < Math.min(n, s + Math.round(hop)); j++) { const v = b[0][j]; if (v < lo) lo = v; if (v > hi) hi = v; }
      ovWave[k * 2] = lo; ovWave[k * 2 + 1] = hi;
    }
    onProgress?.(Math.min(1, ((i + 1) * BLOCK - t0) / Math.max(1, t1 - t0)));
  }
}

// ------------------------------------------------------------------ pictures
/** One spectrogram picture plus the waveform envelope for the same columns. */
async function view(m) {
  const { width: W, height: H, t0, t1, f0, f1, log, N = 2048, floor = -96, palette = 'reel', src: which } = m;
  const nyq = rate / 2, span = (t1 - t0) / W;
  let lut = luts.get(palette); if (!lut) { lut = paletteLUT(palette); luts.set(palette, lut); }
  const img = new Uint8ClampedArray(W * H * 4), wave = new Float32Array(W * 2);
  const paint = (x, y, v) => { const k = Math.max(0, Math.min(255, Math.round(((v - floor) / -floor) * 255))), o = (y * W + x) * 4; img[o] = lut[k * 3]; img[o + 1] = lut[k * 3 + 1]; img[o + 2] = lut[k * 3 + 2]; img[o + 3] = 255; };
  // zoomed out (or the original, which the overview isn't): the overview, columns merged by their loudest
  if (which !== 'orig' && span >= 1.4 / OV_RATE) {
    const rowLo = new Int32Array(H), rowHi = new Int32Array(H);
    for (let y = 0; y < H; y++) {
      const fa = yToF(1 - (y + 1) / H, f0, Math.min(f1, nyq), log), fb = yToF(1 - y / H, f0, Math.min(f1, nyq), log);
      rowLo[y] = Math.max(0, Math.floor((fa * OV_N) / rate)); rowHi[y] = Math.min(OV_BINS - 1, Math.max(rowLo[y], Math.round((fb * OV_N) / rate)));
    }
    for (let x = 0; x < W; x++) {
      const k0 = Math.max(0, Math.floor((t0 + x * span) * OV_RATE)), k1 = Math.min(ovCols, Math.max(k0 + 1, Math.ceil((t0 + (x + 1) * span) * OV_RATE)));
      let lo = 0, hi = 0;
      for (let k = k0; k < k1; k++) { lo = Math.min(lo, ovWave[k * 2]); hi = Math.max(hi, ovWave[k * 2 + 1]); }
      wave[x * 2] = lo; wave[x * 2 + 1] = hi;
      for (let y = 0; y < H; y++) {
        let v = 0;
        for (let k = k0; k < k1; k++) { const o = k * OV_BINS; for (let q = rowLo[y]; q <= rowHi[y]; q++) if (ov[o + q] > v) v = ov[o + q]; }
        paint(x, y, (v * 140) / 255 - 140);
      }
    }
    return { width: W, height: H, img, wave };
  }
  // zoomed in: exact, from the edited (or original) sound of just this stretch
  const pad = N / rate;
  const a = Math.max(0, t0 - pad), part = await renderRange(a, Math.min(dur(), t1 + pad), which === 'orig'), plen = part[0].length;
  const win = hann(N), re = new Float64Array(N), im = new Float64Array(N), bins = N / 2 + 1, db = new Float32Array(bins);
  const rowLo = new Int32Array(H), rowHi = new Int32Array(H);
  for (let y = 0; y < H; y++) {
    const fa = yToF(1 - (y + 1) / H, f0, Math.min(f1, nyq), log), fb = yToF(1 - y / H, f0, Math.min(f1, nyq), log);
    rowLo[y] = Math.max(0, Math.floor((fa * N) / rate)); rowHi[y] = Math.min(bins - 1, Math.max(rowLo[y], Math.round((fb * N) / rate)));
  }
  const nc = part.length, off = Math.round(a * rate);
  for (let x = 0; x < W; x++) {
    const t = t0 + (x + 0.5) * span, c = Math.round(t * rate) - N / 2 - off;
    for (let n = 0; n < N; n++) { const s = c + n; let v = 0; if (s >= 0 && s < plen) for (let k = 0; k < nc; k++) v += part[k][s]; re[n] = (v / nc) * win[n]; im[n] = 0; }
    fft(re, im);
    for (let b = 0; b < bins; b++) db[b] = 20 * Math.log10(Math.hypot(re[b], im[b]) / (N / 4) + 1e-9);
    for (let y = 0; y < H; y++) { let v = -200; for (let b = rowLo[y]; b <= rowHi[y]; b++) if (db[b] > v) v = db[b]; paint(x, y, v); }
    const s0 = Math.max(0, Math.floor((t0 + x * span) * rate) - off), s1 = Math.min(plen, Math.ceil((t0 + (x + 1) * span) * rate) - off);
    let lo = 0, hi = 0; for (let s = s0; s < s1; s++) { const v = part[0][s]; if (v < lo) lo = v; if (v > hi) hi = v; }
    wave[x * 2] = lo; wave[x * 2 + 1] = hi;
  }
  return { width: W, height: H, img, wave };
}

// ------------------------------------------------------------------ listening, finding, writing
/**
 * Preview: the fix applied to a copy of t0..t1 (plus room either side for what it learns from), and the
 * same stretch as it is now, so the page can play them in step and BYPASS can flip between them.
 */
async function preview(m) {
  const pad = padOf(m.edit), a = Math.max(0, m.t0 - pad), z = Math.min(dur(), m.t1 + pad);
  const now = await renderRange(a, z), part = now.map(c => c.slice());
  const r = runEdit(part, rate, { ...m.edit, sel: m.edit.sel ? shiftSel(m.edit.sel, -a) : m.edit.sel }, coreEdit, { orig: await readOrig(a, z) });
  const o0 = Math.round((m.t0 - a) * rate), o1 = Math.round((m.t1 - a) * rate);
  const fixed = part.map(c => c.slice(o0, o1)), before = now.map(c => c.slice(o0, o1));
  // LISTEN TO REMOVED: the difference, i.e. only what the fix takes out
  if (m.removed) fixed.forEach((c, k) => { for (let i = 0; i < c.length; i++) c[i] = before[k][i] - c[i]; });
  self.postMessage({ type: 'done', id: m.id, rate, fixed, orig: before, fixedClicks: (r && r.fixed) || 0 }, [...fixed, ...before].map(c => c.buffer));
}
/** Find Similar: searched within a few minutes either side of the example (an hour at once would be slow). */
async function similar(m) {
  const b = shapeBounds(m.sel.shapes || [], dur(), rate / 2), R = Math.min(m.range ?? 240, 600);
  const a = Math.max(0, b.t0 - R), z = Math.min(dur(), b.t1 + R);
  const part = await renderRange(a, z);
  // hits are offsets from the example, so they don't depend on where the searched stretch starts
  const hits = findSimilar(part, rate, shiftSel(m.sel, -a), { similarity: m.similarity });
  reply(m, { hits });
}
/** The edited sound as a 32-bit float WAV, in chunks; the header comes last (the size is known then). */
async function render(m) {
  const ch = chs, total = len;
  for (let i = 0; i * BLOCK < dur(); i++) {
    const b = await block(i), n = b[0].length, out = new Float32Array(n * ch);
    for (let s = 0; s < n; s++) for (let c = 0; c < ch; c++) out[s * ch + c] = b[c][s];
    self.postMessage({ type: 'chunk', id: m.id, data: new Uint8Array(out.buffer) }, [out.buffer]);
    progress(Math.min(1, ((i + 1) * BLOCK) / dur()));
  }
  const dataBytes = total * ch * 4, h = new DataView(new ArrayBuffer(44));
  const str = (o, t) => { for (let i = 0; i < t.length; i++) h.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); h.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE'); str(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 3, true);
  h.setUint16(22, ch, true); h.setUint32(24, rate, true); h.setUint32(28, rate * ch * 4, true); h.setUint16(32, ch * 4, true); h.setUint16(34, 32, true);
  str(36, 'data'); h.setUint32(40, dataBytes, true);
  const head = new Uint8Array(h.buffer);
  self.postMessage({ type: 'done', id: m.id, head }, [head.buffer]);
}
