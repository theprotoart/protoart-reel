// Restoration modules in the CEDAR tradition, written for Reel from what those tools are documented to do (nothing
// taken from CEDAR): Revert, Gain inside/outside, Patch (with pitch), De-clip, Decrackle, Auto Dehiss, De-buzz
// (pitch-tracking) and Dethump (restores the low end instead of only cutting it).
import { fft, hann, rasterize } from './spectral-dsp.js';
import { editRange, analyse, analyseComplex, resynth, scaleBin, mix, db2, noiseFloor, registerOps, findSimilar } from './spectral-rx.js';

const framesOf = (len, H) => Math.ceil(len / H) + 1;
const clampI = (i, len) => (i < 0 ? 0 : i >= len ? len - 1 : i);

// ------------------------------------------------------------------ Revert
/** Paints the selection back to the original sound, keeping every edit made outside it (Retouch-style Revert). */
export function revert(chans, rate, ed, ctx) {
  const orig = ctx?.orig; if (!orig) throw new Error('Nothing to revert to');
  const N = 2048, H = 512, bins = N / 2 + 1, len = chans[0].length, mask = rasterize(ed.sel, { rate, N, H, frames: framesOf(len, H) });
  if (mask.i1 <= mask.i0) return {};
  const win = hann(N), ore = new Float64Array(N), oim = new Float64Array(N);
  chans.forEach((x, k) => {
    const o = orig[Math.min(k, orig.length - 1)];
    resynth(x, N, H, mask.i0, mask.i1, (i, re, im) => {
      const c = i * H - N / 2; for (let n = 0; n < N; n++) { const q = c + n; ore[n] = (q >= 0 && q < len ? o[q] : 0) * win[n]; oim[n] = 0; }
      fft(ore, oim);
      for (let q = 0; q < bins; q++) {
        const m = mask.get(i, q); if (m <= 0) continue;
        re[q] = re[q] * (1 - m) + ore[q] * m; im[q] = im[q] * (1 - m) + oim[q] * m;
        if (q > 0 && q < N / 2) { re[N - q] = re[q]; im[N - q] = -im[q]; }
      }
    });
  });
  return { fixed: 1 };
}

// ------------------------------------------------------------------ Gain inside / outside
/** One level inside the selection and another outside it (outside at -∞ keeps only the selection). */
export function volume(chans, rate, ed) {
  const N = 2048, H = 512, bins = N / 2 + 1, len = chans[0].length, frames = framesOf(len, H);
  const mask = rasterize(ed.sel, { rate, N, H, frames }), gin = db2(ed.inside ?? -12), gout = (ed.outside ?? 0) <= -60 ? 0 : db2(ed.outside ?? 0);
  const whole = gout !== 1, i0 = whole ? 0 : mask.i0, i1 = whole ? frames : mask.i1;
  if (i1 <= i0) return {};
  for (const x of chans) resynth(x, N, H, i0, i1, (i, re, im) => {
    for (let q = 0; q < bins; q++) { const m = mask.get(i, q); if (!whole && m <= 0) continue; const v = m * gin + (1 - m) * gout; if (v !== 1) scaleBin(re, im, N, q, v); }
  });
  return { fixed: 1 };
}

// ------------------------------------------------------------------ Patch
/**
 * The selection is replaced by audio copied from a source you choose (sourceOffset seconds away), optionally
 * shifted by ± semitones so a borrowed note can be put back in tune.
 */
export function patch(chans, rate, ed) {
  const N = 2048, H = 512, bins = N / 2 + 1, len = chans[0].length, frames = framesOf(len, H);
  const mask = rasterize(ed.sel, { rate, N, H, frames });
  if (mask.i1 <= mask.i0 || !Number.isFinite(ed.sourceOffset)) return {};
  const ratio = 2 ** ((ed.semitones || 0) / 12), strength = ed.strength ?? 1;
  const offS = ed.sourceOffset * rate, g0 = mask.i0 * H - N, g1 = mask.i1 * H + N;
  for (const x of chans) {
    // the source, read ratio× as fast from its start (cubic interpolation): same length, pitch × ratio
    const len = x.length, src = new Float32Array(len), at = t => { const i = Math.floor(t), u = t - i, p = k => x[clampI(i + k, len)];
      const y0 = p(-1), y1 = p(0), y2 = p(1), y3 = p(2); return y1 + 0.5 * u * (y2 - y0 + u * (2 * y0 - 5 * y1 + 4 * y2 - y3 + u * (3 * (y1 - y2) + y3 - y0))); };
    const base = mask.i0 * H + offS;
    for (let t = Math.max(0, g0); t < Math.min(len, g1); t++) src[t] = at(base + (t - mask.i0 * H) * ratio);
    const donor = new Map();
    analyseComplex(src, N, H, mask.i0, mask.i1, (i, re, im) => donor.set(i, [Float32Array.from(re.subarray(0, bins)), Float32Array.from(im.subarray(0, bins))]));
    resynth(x, N, H, mask.i0, mask.i1, (i, re, im) => {
      const d = donor.get(i); if (!d) return;
      for (let q = mask.b0; q < mask.b1; q++) {
        const w = mask.get(i, q) * strength; if (w <= 0) continue;
        re[q] = re[q] * (1 - w) + d[0][q] * w; im[q] = im[q] * (1 - w) + d[1][q] * w;
        if (q > 0 && q < N / 2) { re[N - q] = re[q]; im[N - q] = -im[q]; }
      }
    });
  }
  return { fixed: 1 };
}

// ------------------------------------------------------------------ De-clip
/** Least-squares cubic through points (t, y): returns the polynomial. */
function cubicFit(ts, ys) {
  const A = Array.from({ length: 4 }, () => new Float64Array(5));
  for (let k = 0; k < ts.length; k++) { const p = [1, ts[k], ts[k] ** 2, ts[k] ** 3]; for (let r = 0; r < 4; r++) { for (let c = 0; c < 4; c++) A[r][c] += p[r] * p[c]; A[r][4] += p[r] * ys[k]; } }
  for (let c = 0; c < 4; c++) { // Gauss–Jordan
    let piv = c; for (let r = c + 1; r < 4; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; const d = A[c][c] || 1e-12;
    for (let k = c; k < 5; k++) A[c][k] /= d;
    for (let r = 0; r < 4; r++) if (r !== c) { const f = A[r][c]; for (let k = c; k < 5; k++) A[r][k] -= f * A[c][k]; }
  }
  const co = A.map(r => r[4]); return t => co[0] + co[1] * t + co[2] * t * t + co[3] * t * t * t;
}
/**
 * Clipped peaks: runs of samples stuck at (nearly) the same level at the top of the local waveform, whether hard
 * digital clipping or clipping that was compressed afterwards (the level is found locally, not assumed to be 0 dB).
 * Each run is redrawn by a curve through the good samples either side; makeup gain restores the headroom.
 */
export function declip(chans, rate, ed) {
  const sens = ed.sensitivity ?? 0.5, tol = 0.0005 + sens * 0.004, K = 6, maxRun = Math.round(rate * 0.004);
  const [t0, t1] = editRange(ed, chans[0].length, rate);
  let fixed = 0;
  for (const x of chans) {
    const a = Math.max(K + 1, Math.floor(t0 * rate)), z = Math.min(x.length - K - 2, Math.ceil(t1 * rate));
    // local peak level (±25 ms)
    const B = Math.max(64, Math.round(rate * 0.025)), nb = Math.ceil(x.length / B), bmax = new Float32Array(nb);
    for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); if (v > bmax[(i / B) | 0]) bmax[(i / B) | 0] = v; }
    const peak = i => { const b = (i / B) | 0; return Math.max(bmax[b], bmax[Math.max(0, b - 1)], bmax[Math.min(nb - 1, b + 1)]); };
    for (let i = a; i < z; i++) {
      const v = x[i], pk = peak(i);
      if (Math.abs(v) < 0.92 * pk || Math.abs(v) < 0.02) continue;
      let j = i + 1; while (j < z && j - i <= maxRun && Math.sign(x[j]) === Math.sign(v) && Math.abs(x[j] - v) <= tol * Math.max(1e-3, Math.abs(v))) j++;
      if (j - i < 3 || j - i > maxRun) { i = j - 1; continue; }
      // redraw the run from K good samples either side
      const ts = [], ys = [];
      for (let k = 1; k <= K; k++) { ts.push(-k); ys.push(x[i - k]); ts.push(j - 1 - i + k); ys.push(x[j - 1 + k]); }
      const f = cubicFit(ts, ys), lvl = Math.abs(v);
      let ok = true; const out = [];
      for (let q = i; q < j; q++) { const y = f(q - i); if (Math.sign(y) !== Math.sign(v)) { ok = false; break; } out.push(Math.sign(v) * Math.max(lvl, Math.abs(y))); }
      if (ok) { for (let q = i; q < j; q++) x[q] = out[q - i]; fixed++; }
      i = j;
    }
    const g = db2(ed.gain ?? 0);
    if (g !== 1) for (let i = Math.floor(t0 * rate); i < Math.min(x.length, Math.ceil(t1 * rate)); i++) x[i] *= g;
  }
  return { fixed };
}

// ------------------------------------------------------------------ Decrackle
/**
 * Low-level crackle: many tiny impulses under the level De-click looks for. Found against a prediction from the
 * samples before (what's left over is mostly crackle) and each one bridged from its neighbours.
 */
export function decrackle(chans, rate, ed) {
  const sens = ed.sensitivity ?? 0.5, k = 7 - sens * 4, W = Math.round(rate * 0.005);
  const [t0, t1] = editRange(ed, chans[0].length, rate);
  let fixed = 0;
  for (const x of chans) {
    const a = Math.max(4, Math.floor(t0 * rate)), z = Math.min(x.length - 4, Math.ceil(t1 * rate)), e = new Float32Array(x.length);
    for (let i = a; i < z; i++) e[i] = x[i] - (2 * x[i - 1] - x[i - 2]); // second-order prediction error
    const cs = new Float64Array(x.length + 1); for (let i = 0; i < x.length; i++) cs[i + 1] = cs[i] + Math.abs(e[i]);
    const lvl = i => (cs[Math.min(x.length, i + W)] - cs[Math.max(0, i - W)]) / (2 * W) + 1e-9;
    for (let i = a; i < z; i++) {
      if (Math.abs(e[i]) <= k * lvl(i)) continue;
      // bridge two samples with a cubic through three good ones either side
      const s = Math.max(a, i - 1), t = Math.min(z, i + 2), ts = [], ys = []; // an impulse can show a sample late
      for (let q = 1; q <= 3; q++) { ts.push(-q); ys.push(x[s - q]); ts.push(t - s - 1 + q); ys.push(x[t - 1 + q]); }
      const f = cubicFit(ts, ys); for (let q = s; q < t; q++) x[q] = f(q - s);
      for (let q = s; q < t + 2 && q < z; q++) e[q] = 0;
      fixed++; i = t;
    }
  }
  return { fixed };
}

// ------------------------------------------------------------------ Auto Dehiss
/**
 * Broadband hiss taken down with no LEARN step: the noise floor is tracked continuously, and each bin is turned
 * down by how close it sits to it (decision-directed, so no "twittering"). Attenuation caps the reduction; Bias
 * leans harder or softer, LF bias does the same below 500 Hz.
 */
export function dehiss(chans, rate, ed) {
  const N = 2048, H = 512, bins = N / 2 + 1, floorG = db2(-(ed.attenuation ?? 12));
  const bias = 10 ** ((ed.bias ?? 0) / 10), lfBias = 10 ** ((ed.lfBias ?? 0) / 10), lfB = Math.round((500 * N) / rate);
  const [t0, t1] = editRange(ed, chans[0].length, rate), i0 = Math.floor((t0 * rate) / H), i1 = Math.ceil((t1 * rate) / H) + 1;
  for (const c of chans) {
    const floor = noiseFloor(c, N, H, i0, i1, rate), prevG = new Float32Array(bins).fill(1), prevS = new Float32Array(bins);
    resynth(c, N, H, i0, i1, (i, re, im) => {
      const k = i - i0;
      for (let q = 0; q < bins; q++) {
        const nz = floor[k * bins + q] * bias * (q < lfB ? lfBias : 1) + 1e-18;
        const post = (re[q] * re[q] + im[q] * im[q]) / nz;
        const xi = 0.96 * prevG[q] * prevG[q] * prevS[q] + 0.04 * Math.max(post - 1, 0);
        const g = Math.max(floorG, xi / (1 + xi));
        prevG[q] = g; prevS[q] = post;
        scaleBin(re, im, N, q, g);
      }
    });
  }
  return {};
}

// ------------------------------------------------------------------ De-buzz
/**
 * Hum and buzz with a fundamental up to 500 Hz that wanders in pitch: the fundamental is found frame by frame
 * (within ± bandwidth of the set or auto-detected one) and every harmonic is notched where it stands above its
 * neighbours by more than the threshold, by at most the attenuation.
 */
export function debuzz(chans, rate, ed) {
  const N = 2 ** Math.round(Math.log2(rate / 4)), H = N / 4, bins = N / 2 + 1, nyq = rate / 2;
  const bw = ed.bandwidth ?? 0.04, thr = db2(ed.threshold ?? 6), att = db2(-(ed.attenuation ?? 40)), upTo = Math.min(nyq * 0.95, ed.upTo ?? 8000);
  const [t0, t1] = editRange(ed, chans[0].length, rate), i0 = Math.floor((t0 * rate) / H), i1 = Math.ceil((t1 * rate) / H) + 1, nF = i1 - i0;
  const x = mix(chans), M = new Float32Array(nF * bins);
  analyse(x, N, H, i0, i1, (i, m) => M.set(m, (i - i0) * bins));
  const at = (k, f) => { const b = (f * N) / rate, a = Math.floor(b), u = b - a; return a + 1 < bins ? (1 - u) * M[k * bins + a] + u * M[k * bins + a + 1] : 0; };
  const score = (k, f) => { let s = 0; for (let h = 1; h * f < upTo && h <= 24; h++) s += at(k, h * f); return s; };
  let base = ed.fundamental || 0;
  if (!base) { let s50 = 0, s60 = 0; for (let k = 0; k < nF; k += 4) { s50 += score(k, 50); s60 += score(k, 60); } base = s60 >= s50 ? 60 : 50; }
  // per-frame fundamental (0.05 Hz steps across the tracking range), then a median over 5 frames
  const raw = new Float32Array(nF), step = Math.max(0.02, base * 0.001);
  for (let k = 0; k < nF; k++) { let best = base, bs = -1; for (let f = base * (1 - bw); f <= base * (1 + bw); f += step) { const s = score(k, f); if (s > bs) { bs = s; best = f; } } raw[k] = best; }
  const f0 = raw.map((_, k) => { const w = []; for (let j = Math.max(0, k - 2); j <= Math.min(nF - 1, k + 2); j++) w.push(raw[j]); return w.sort((a, b) => a - b)[w.length >> 1]; });
  for (const c of chans) resynth(c, N, H, i0, i1, (i, re, im) => {
    const f = f0[i - i0], mg = q => Math.hypot(re[q], im[q]);
    for (let h = 1; h * f < upTo; h++) {
      const cb = (h * f * N) / rate, lo = Math.floor(cb) - 2, hi = Math.ceil(cb) + 2;
      if (lo < 1 || hi >= bins - 1) continue;
      const nb = []; for (let q = lo - 6; q < lo; q++) if (q > 0) nb.push(mg(q)); for (let q = hi + 1; q <= hi + 6 && q < bins; q++) nb.push(mg(q));
      nb.sort((a, b) => a - b); const floor = nb[nb.length >> 1] || 0;
      for (let q = lo; q <= hi; q++) { const cur = mg(q); if (cur > floor * thr && cur > 1e-12) scaleBin(re, im, N, q, Math.max(att, floor / cur)); }
    }
  });
  return { fundamental: Math.round(base * 10) / 10 };
}

// ------------------------------------------------------------------ Dethump
/**
 * Low-frequency thumps (handling noise, bumps, a door): found as low-end bursts far above their surroundings,
 * then the low band under each is rebuilt from the sound either side, so the bass that belongs there stays.
 */
export function dethump(chans, rate, ed, heal) {
  const N = 2048, H = 256, limit = ed.limit ?? 150, sens = ed.sensitivity ?? 0.5;
  const [t0, t1] = editRange(ed, chans[0].length, rate), i0 = Math.floor((t0 * rate) / H), i1 = Math.ceil((t1 * rate) / H) + 1;
  const bLim = Math.ceil((limit * N) / rate), x = mix(chans), lf = new Float32Array(i1 - i0), mid = new Float32Array(i1 - i0);
  const m0 = Math.round((300 * N) / rate), m1 = Math.min(N / 2, Math.round((3000 * N) / rate));
  analyse(x, N, H, i0, i1, (i, m) => { let a = 0, b = 0; for (let q = 1; q <= bLim; q++) a += m[q] * m[q]; for (let q = m0; q < m1; q++) b += m[q] * m[q]; lf[i - i0] = a; mid[i - i0] = b; });
  const W = Math.round((1 * rate) / H), ratio = 12 - sens * 9, hot = new Uint8Array(lf.length);
  const median = (arr, k) => { const w = []; for (let j = Math.max(0, k - W); j < Math.min(arr.length, k + W); j += 2) w.push(arr[j]); w.sort((p, q) => p - q); return w[w.length >> 1] + 1e-12; };
  for (let k = 0; k < lf.length; k++) {
    // a thump is low end jumping on its own: when the mids jump with it, it's a voice or an instrument starting
    const ml = median(lf, k), dl = lf[k] - ml, dm = Math.max(0, mid[k] - median(mid, k));
    if (lf[k] > ml * ratio && dl > 10 * dm) hot[k] = 1;
  }
  const spans = [], pad = 0.03;
  for (let k = 0; k < hot.length;) {
    if (!hot[k]) { k++; continue; }
    let j = k; while (j < hot.length && hot[j]) j++;
    const s = ((i0 + k) * H) / rate - pad, e = ((i0 + j) * H) / rate + pad;
    // every frame overlapping a real thump sees it, so it stays hot for most of a window; a sound merely starting
    // splatters into the low end for only the first frame or two
    if (j - k >= Math.ceil((0.75 * N) / H) && e - s < 0.8 && s > N / rate / 2 && e < chans[0].length / rate - N / rate / 2) spans.push({ kind: 'rect', t0: Math.max(0, s), t1: e, f0: 0, f1: limit * 1.5 });
    k = j;
  }
  if (!spans.length) return { fixed: 0 };
  heal(chans, rate, { op: 'heal', surround: 0.2, strength: ed.strength ?? 1, sel: { shapes: spans, featherT: 0.01, featherOct: 0.3 } }, { N: 4096 });
  return { fixed: spans.length };
}

// ------------------------------------------------------------------ De-bark
/**
 * Dog barks in the background. A bark is a short burst (40–700 ms of peak) that jumps well above the sound around it and
 * adds sound pitched above a voice's (lowest strong peak over ~330 Hz) with its energy in the 0.5–4 kHz range.
 * Each one has its frequencies above ~250 Hz pulled down to the level just before and after it, so a voice
 * carrying on through the bark is kept. Example mode: select one bark and every similar one is treated instead.
 */
export function debark(chans, rate, ed, heal) {
  const len = chans[0].length, [t0, t1] = editRange(ed, len, rate), sens = ed.sensitivity ?? 0.5;
  let spans = [];
  if (ed.mode === 'example' && ed.sel?.shapes?.length) {
    const b = editRange(ed, len, rate);
    spans.push([b[0], b[1]]);
    for (const h of findSimilar(chans, rate, ed.sel, { similarity: ed.similarity ?? 0.75 })) spans.push([b[0] + h.offset, b[1] + h.offset]);
  } else {
    const N = 2 ** Math.round(Math.log2(rate * 0.04)), H = N / 4, bins = N / 2 + 1, x = mix(chans);
    const i0 = Math.floor((t0 * rate) / H), i1 = Math.ceil((t1 * rate) / H) + 1, nF = i1 - i0;
    const band = new Float32Array(nF), bLo = Math.round((400 * N) / rate), bHi = Math.min(bins - 1, Math.round((5000 * N) / rate));
    analyse(x, N, H, i0, i1, (i, m) => { let e = 0; for (let q = bLo; q <= bHi; q++) e += m[q] * m[q]; band[i - i0] = e; });
    // bursts: the 0.4–5 kHz band jumps above its running median (±1.5 s) by a sensitivity-set margin
    const R = Math.round((1.5 * rate) / H), jump = db2(2 * (12 - sens * 8)), hot = new Uint8Array(nF), tmp = [];
    for (let k = 0; k < nF; k++) { tmp.length = 0; for (let j = Math.max(0, k - R); j < Math.min(nF, k + R); j += 3) tmp.push(band[j]); tmp.sort((a, b) => a - b); if (band[k] > (tmp[tmp.length >> 1] + 1e-12) * jump) hot[k] = 1; }
    const fr = n => (n * H) / rate;
    for (let k = 0; k < nF;) {
      if (!hot[k]) { k++; continue; }
      let j = k; while (j < nF && hot[j]) j++;
      const d = fr(j - k);
      if (d >= 0.04 && d <= 0.7) {
        // what the burst adds: its spectrum minus the typical spectrum around it (so a voice under it drops out)
        const burst = new Float64Array(bins), ctx = [], ex = new Float64Array(bins);
        analyse(x, N, H, i0 + k, i0 + j, (i, m) => { for (let q = 0; q < bins; q++) burst[q] += (m[q] * m[q]) / (j - k); });
        for (let c = Math.max(i0, i0 + k - R); c < Math.min(i1, i0 + j + R); c += 3) if (c < i0 + k - 2 || c > i0 + j + 2) ctx.push(c);
        const med = new Float64Array(bins), col = Array.from({ length: bins }, () => []);
        for (const c of ctx) analyse(x, N, H, c, c + 1, (i, m) => { for (let q = 0; q < bins; q++) col[q].push(m[q] * m[q]); });
        for (let q = 0; q < bins; q++) { const v = col[q].sort((u, w) => u - w); med[q] = v.length ? v[v.length >> 1] : 0; }
        let mx = 0, ce = 0, et = 0;
        for (let q = 1; q < bins; q++) { ex[q] = Math.max(0, burst[q] - med[q] * 2); if (ex[q] > mx) mx = ex[q]; ce += ex[q] * q; et += ex[q]; }
        // its lowest strong peak (a bark's fundamental sits above a voice's) and where its energy is centred
        let fLow = 0;
        for (let q = Math.max(2, Math.round((80 * N) / rate)); q < bins - 1; q++) if (ex[q] >= 0.25 * mx && ex[q] >= ex[q - 1] && ex[q] >= ex[q + 1]) { fLow = (q * rate) / N; break; }
        const centre = et > 0 ? ((ce / et) * rate) / N : 0;
        if (fLow >= 330 && centre > 500 && centre < 4000) spans.push([fr(i0 + k) - 0.03, fr(i0 + j) + 0.05]);
      }
      k = j;
    }
  }
  spans = spans.filter(([a, b]) => b > a).map(([a, b]) => [Math.max(0, a), Math.min(len / rate, b)]);
  if (!spans.length) return { fixed: 0 };
  // pull just the bark down to its surroundings (a voice going on through it is in the surroundings, so it stays)
  const shapes = spans.map(([a, b]) => ({ kind: 'rect', t0: a, t1: b, f0: ed.lowCut ?? 250, f1: rate / 2 }));
  heal(chans, rate, { op: 'attenuate', direction: 'h', surround: 0.3, strength: ed.strength ?? 1, sel: { shapes, featherT: 0.015, featherOct: 0.2 } });
  return { fixed: spans.length };
}

registerOps({ revert, volume, patch, declip, decrackle, dehiss, debuzz, dethump, debark });
