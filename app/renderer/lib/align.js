// Dialogue alignment for ADR: a replacement take is warped onto the timing of the original (guide) line, so it
// matches the lips. Written for Reel (the technique is dynamic time warping over speech features; no other
// product's code): features → global lag → banded DTW with a stretch penalty → smoothed, slope-limited map.
import { fft } from '../spectral-dsp.js';

const RATE = 16000, N = 512, HOP = 160, BANDS = 26; // analysis at 16 kHz, 10 ms frames

function resample(x, from) {
  if (from === RATE) return x;
  const n = Math.floor((x.length * RATE) / from), out = new Float32Array(n), r = from / RATE;
  // a short box filter before decimating keeps the bands clean
  const k = Math.max(1, Math.round(r)), pre = k > 1 ? (() => { const y = new Float32Array(x.length); let s = 0; for (let i = 0; i < x.length; i++) { s += x[i]; if (i >= k) s -= x[i - k]; y[i] = s / k; } return y; })() : x;
  for (let i = 0; i < n; i++) { const p = i * r, j = Math.floor(p), f = p - j; out[i] = (pre[j] || 0) * (1 - f) + (pre[j + 1] || 0) * f; }
  return out;
}
const mel = f => 2595 * Math.log10(1 + f / 700);

/** Speech features: log mel band energies per 10 ms (mean-normalised), plus a loudness track. */
export function features(x, rate) {
  const y = resample(x, rate), frames = Math.max(1, Math.floor((y.length - N) / HOP) + 1), bins = N / 2 + 1;
  const edges = Array.from({ length: BANDS + 2 }, (_, i) => { const m = mel(80) + ((mel(7600) - mel(80)) * i) / (BANDS + 1); return (700 * (10 ** (m / 2595) - 1) * N) / RATE; });
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const F = new Float32Array(frames * BANDS), E = new Float32Array(frames), re = new Float64Array(N), im = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) { re[i] = (y[f * HOP + i] || 0) * win[i]; im[i] = 0; }
    fft(re, im);
    let e = 0;
    for (let b = 0; b < BANDS; b++) {
      const lo = edges[b], mid = edges[b + 1], hi = edges[b + 2];
      let s = 0;
      for (let q = Math.max(1, Math.floor(lo)); q <= Math.min(bins - 1, Math.ceil(hi)); q++) {
        const w = q < mid ? (q - lo) / (mid - lo) : (hi - q) / (hi - mid);
        if (w > 0) s += w * (re[q] * re[q] + im[q] * im[q]);
      }
      F[f * BANDS + b] = Math.log(1e-6 + s); e += s;
    }
    E[f] = Math.log(1e-6 + e);
  }
  for (let b = 0; b < BANDS; b++) { let m = 0; for (let f = 0; f < frames; f++) m += F[f * BANDS + b]; m /= frames; for (let f = 0; f < frames; f++) F[f * BANDS + b] -= m; }
  return { F, E, frames };
}

const dist = (A, i, B, j) => { let s = 0; for (let b = 0; b < BANDS; b++) { const d = A[i * BANDS + b] - B[j * BANDS + b]; s += d * d; } return Math.sqrt(s); };

/** Rough lag (frames, take minus guide) from the loudness tracks. */
function globalLag(g, d, maxLag) {
  const norm = e => { let m = 0; for (const v of e) m += v; m /= e.length; return Float32Array.from(e, v => Math.max(0, v - m)); };
  const a = norm(g.E), b = norm(d.E);
  let best = 0, bs = -Infinity;
  for (let L = -maxLag; L <= maxLag; L++) { let s = 0; for (let i = 0; i < a.length; i++) { const j = i + L; if (j >= 0 && j < b.length) s += a[i] * b[j]; } if (s > bs) { bs = s; best = L; } }
  return best;
}

/**
 * Aligns take (d) to guide (g). Returns a map over guide frames → take frame (fractional), and stats.
 * opts: tightness 0 (loose) … 1 (tight), maxStretch (e.g. 0.5 = a spot may run 50 % faster or slower),
 * band (frames of freedom around the lag).
 */
export function alignFeatures(g, d, { tightness = 0.5, maxStretch = 0.5, band = 150 } = {}) {
  const n = g.frames, m = d.frames, lag = globalLag(g, d, Math.min(300, Math.max(n, m)));
  const W = band;
  // banded DTW: cell (i, j) only where |j - (i·m/n + lag)| ≤ W; stretching (one side standing still) costs extra
  const pen = 0.4 + (1 - tightness) * 1.6;
  const centre = i => Math.round(i + lag); // the take runs at about the guide's pace; the band absorbs drift
  const width = 2 * W + 1, D = new Float32Array(n * width).fill(Infinity), P = new Uint8Array(n * width);
  const idx = (i, j) => { const k = j - centre(i) + W; return k >= 0 && k < width ? i * width + k : -1; };
  for (let i = 0; i < n; i++) {
    const c = centre(i);
    for (let j = Math.max(0, c - W); j <= Math.min(m - 1, c + W); j++) {
      const here = idx(i, j), cost = dist(g.F, i, d.F, j);
      if (i === 0) { D[here] = cost; continue; } // the take may hold extra sound before the line (margin)
      let best = Infinity, from = 0;
      const t1 = i > 0 ? idx(i - 1, j - 1) : -1, t2 = i > 0 ? idx(i - 1, j) : -1, t3 = idx(i, j - 1);
      if (t1 >= 0 && D[t1] < best) { best = D[t1]; from = 1; }
      if (t2 >= 0 && D[t2] + pen < best) { best = D[t2] + pen; from = 2; }
      if (t3 >= 0 && D[t3] + pen < best) { best = D[t3] + pen; from = 3; }
      if (best < Infinity) { D[here] = best + cost; P[here] = from; }
    }
  }
  // end anywhere near the band's last row, then walk back
  let j = -1, bestEnd = Infinity;
  for (let jj = Math.max(0, centre(n - 1) - W); jj <= Math.min(m - 1, centre(n - 1) + W); jj++) { const k = idx(n - 1, jj); if (k >= 0 && D[k] < bestEnd) { bestEnd = D[k]; j = jj; } }
  const raw = new Float32Array(n).fill(NaN);
  let i = n - 1;
  if (j < 0) { for (let x = 0; x < n; x++) raw[x] = Math.min(m - 1, Math.max(0, centre(x))); }
  else {
    while (i >= 0 && j >= 0) {
      raw[i] = Number.isNaN(raw[i]) ? j : Math.min(raw[i], j);
      const k = idx(i, j); const p = k >= 0 ? P[k] : 0;
      if (p === 1) { i--; j--; } else if (p === 2) i--; else if (p === 3) j--; else break;
    }
    for (let x = n - 2; x >= 0; x--) if (Number.isNaN(raw[x])) raw[x] = raw[x + 1];
    for (let x = 1; x < n; x++) if (Number.isNaN(raw[x])) raw[x] = raw[x - 1];
  }
  // smooth (looser = longer), then keep the slope within the stretch limit and increasing
  // smoothing never crosses a speech/pause boundary, so a longer pause is taken up inside the pause
  let gm = -Infinity; for (const v of g.E) gm = Math.max(gm, v);
  const voiced = x => g.E[x] > gm - 4.5; // within ~20 dB of the loudest frame
  const half = Math.round(2 + (1 - tightness) * 10), map = new Float32Array(n);
  for (let x = 0; x < n; x++) { const vx = voiced(x); let s = 0, c = 0; for (let y = Math.max(0, x - half); y <= Math.min(n - 1, x + half); y++) if (voiced(y) === vx) { s += raw[y]; c++; } map[x] = s / c; }
  // the stretch limit protects speech; pauses may grow or shrink freely (that is where takes differ most)
  const lo = 1 / (1 + maxStretch), hi = 1 + maxStretch;
  for (let x = 1; x < n; x++) {
    const v = voiced(x) && voiced(x - 1);
    map[x] = v ? Math.min(map[x - 1] + hi, Math.max(map[x - 1] + lo, map[x])) : Math.max(map[x - 1] + 0.05, map[x]);
  }
  let off = 0, maxOff = 0;
  for (let x = 0; x < n; x++) { const o = Math.abs(map[x] - x - lag); off += o; maxOff = Math.max(maxOff, o); }
  return { map, lag, meanShift: (off / n) * (HOP / RATE), maxShift: maxOff * (HOP / RATE), frameSec: HOP / RATE };
}

/**
 * Full alignment: guide and take as Float32Array mono (any rates). Returns a function turning an output time
 * (seconds, guide timing) into take time (seconds), plus stats.
 */
export function align(guide, guideRate, take, takeRate, opts) {
  const g = features(guide, guideRate), d = features(take, takeRate);
  const r = alignFeatures(g, d, opts), fs = r.frameSec, centreOff = N / 2 / RATE;
  const at = t => {
    const f = (t - centreOff) / fs;
    if (f <= 0) return Math.max(0, r.map[0] * fs + centreOff + f * fs);
    if (f >= r.map.length - 1) return r.map[r.map.length - 1] * fs + centreOff + (f - (r.map.length - 1)) * fs;
    const k = Math.floor(f), u = f - k;
    return (r.map[k] * (1 - u) + r.map[k + 1] * u) * fs + centreOff;
  };
  return { at, lag: r.lag * fs, meanShift: r.meanShift, maxShift: r.maxShift };
}
