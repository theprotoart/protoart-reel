// Spectral editing maths (no DOM): FFT, STFT with perfect reconstruction, selections rasterised into a
// time × frequency mask with feathered edges, and the edits Reel's spectral editor offers: gain, remove,
// attenuate to the surroundings, heal (replace from both sides), isolate, de-hum and de-click.
// Shapes are in seconds and hertz, so they don't depend on zoom; harmonics repeat a shape at 2f, 3f…

export const N_DEFAULT = 2048;

/** In-place radix-2 FFT (inverse when inv). Length must be a power of two. */
export function fft(re, im, inv = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inv ? 1 : -1), wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

const windows = new Map();
export function hann(n) {
  let w = windows.get(n);
  if (!w) { w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); windows.set(n, w); }
  return w;
}

// ------------------------------------------------------------------ selections → mask
/** Expands harmonic copies of shapes (rect, poly, brush) at 2f … (count)f, below Nyquist. */
function withHarmonics(shapes, count, nyq) {
  if (!(count > 1)) return shapes;
  const out = [];
  for (const s of shapes) {
    out.push(s);
    if (s.kind === 'time' || s.kind === 'freq') continue;
    for (let k = 2; k <= count; k++) {
      const m = f => f * k;
      if (s.kind === 'rect') { if (s.f0 * k < nyq) out.push({ ...s, f0: m(s.f0), f1: Math.min(nyq, m(s.f1)) }); }
      else if (s.kind === 'poly') out.push({ ...s, pts: s.pts.map(([t, f]) => [t, m(f)]) });
      else if (s.kind === 'brush') out.push({ ...s, pts: s.pts.map(([t, f]) => [t, m(f)]) });
    }
  }
  return out;
}

/** Bounding box of shapes in seconds / hertz. */
export function shapeBounds(shapes, dur, nyq) {
  let t0 = Infinity, t1 = -Infinity, f0 = Infinity, f1 = -Infinity;
  for (const s of shapes) {
    if (s.kind === 'rect') { t0 = Math.min(t0, s.t0); t1 = Math.max(t1, s.t1); f0 = Math.min(f0, s.f0); f1 = Math.max(f1, s.f1); }
    else if (s.kind === 'time') { t0 = Math.min(t0, s.t0); t1 = Math.max(t1, s.t1); f0 = 0; f1 = nyq; }
    else if (s.kind === 'freq') { t0 = 0; t1 = dur; f0 = Math.min(f0, s.f0); f1 = Math.max(f1, s.f1); }
    else if (s.kind === 'poly') for (const [t, f] of s.pts) { t0 = Math.min(t0, t); t1 = Math.max(t1, t); f0 = Math.min(f0, f); f1 = Math.max(f1, f); }
    else if (s.kind === 'brush') for (const [t, f] of s.pts) { t0 = Math.min(t0, t - s.rt); t1 = Math.max(t1, t + s.rt); f0 = Math.min(f0, f / 2 ** s.ro); f1 = Math.max(f1, f * 2 ** s.ro); }
  }
  return { t0: Math.max(0, t0), t1: Math.min(dur, t1), f0: Math.max(0, f0), f1: Math.min(nyq, f1) };
}

/**
 * Rasterises a selection into a mask over STFT frames × bins.
 * sel: { shapes, harmonics, featherT (s), featherOct, invert }. Returns { i0, i1, b0, b1, w, data, get(i,b) }
 * where frames i0..i1-1 and bins b0..b1-1 are covered (outside → 0, or 1 when inverted).
 */
export function rasterize(sel, { rate, N = N_DEFAULT, H = N / 4, frames }) {
  const nyq = rate / 2, bins = N / 2 + 1, binHz = rate / N, dur = (frames * H) / rate;
  const shapes = withHarmonics(sel.shapes || [], sel.harmonics || 1, nyq);
  const fT = Math.max(0, sel.featherT || 0), fO = Math.max(0, sel.featherOct || 0);
  const bb = shapeBounds(shapes, dur, nyq);
  if (!(bb.t1 > bb.t0) || !(bb.f1 > bb.f0)) return empty(sel.invert, frames, bins);
  const padI = Math.ceil((fT * rate) / H) + 1;
  let i0 = Math.max(0, Math.floor((bb.t0 * rate) / H) - padI), i1 = Math.min(frames, Math.ceil((bb.t1 * rate) / H) + 1 + padI);
  let b0 = Math.max(0, Math.floor((bb.f0 / 2 ** fO) / binHz) - 1), b1 = Math.min(bins, Math.ceil((bb.f1 * 2 ** fO) / binHz) + 2);
  if (sel.invert) { i0 = 0; i1 = frames; b0 = 0; b1 = bins; }
  const w = b1 - b0, h = i1 - i0, data = new Float32Array(w * h);
  const lf = b => Math.log2(Math.max(1, b * binHz));
  for (let i = i0; i < i1; i++) {
    const t = (i * H) / rate, row = (i - i0) * w;
    const fill = (fa, fb) => { const ba = Math.max(b0, Math.ceil(fa / binHz)), bz = Math.min(b1 - 1, Math.floor(fb / binHz)); for (let b = ba; b <= bz; b++) data[row + b - b0] = 1; };
    for (const s of shapes) {
      if (s.kind === 'rect') { if (t >= s.t0 && t <= s.t1) fill(s.f0, s.f1); }
      else if (s.kind === 'time') { if (t >= s.t0 && t <= s.t1) fill(0, nyq); }
      else if (s.kind === 'freq') fill(s.f0, s.f1);
      else if (s.kind === 'poly') {
        // scanline: where the vertical line at t crosses the outline (in log-frequency, as drawn)
        const xs = [], p = s.pts;
        for (let k = 0, j = p.length - 1; k < p.length; j = k++) {
          const [ta, fa] = p[j], [tb, fb] = p[k];
          if ((ta <= t && tb > t) || (tb <= t && ta > t)) { const u = (t - ta) / (tb - ta); xs.push(2 ** (Math.log2(Math.max(1, fa)) + u * (Math.log2(Math.max(1, fb)) - Math.log2(Math.max(1, fa))))); }
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) fill(xs[k], xs[k + 1]);
      } else if (s.kind === 'brush') {
        for (const [pt, pf] of s.pts) {
          const dt = Math.abs(t - pt);
          if (dt > s.rt) continue;
          const hh = s.ro * Math.sqrt(1 - (dt / s.rt) ** 2), c = Math.log2(Math.max(1, pf));
          fill(2 ** (c - hh), 2 ** (c + hh));
        }
      }
    }
  }
  // feather: soften the edges along time (frames) and frequency (octaves → bins at each height)
  const rI = Math.round((fT * rate) / H);
  if (rI > 0) blurTime(data, w, h, rI);
  if (fO > 0) blurFreq(data, w, h, b => Math.max(1, Math.round(((b0 + b) * binHz * (2 ** fO - 1)) / binHz / 2)));
  void lf;
  if (sel.invert) for (let k = 0; k < data.length; k++) data[k] = 1 - data[k];
  return mk(i0, i1, b0, b1, w, data, !!sel.invert);
}
function empty(invert, frames, bins) { return invert ? mk(0, frames, 0, bins, bins, new Float32Array(frames * bins).fill(1), true) : mk(0, 0, 0, 0, 0, new Float32Array(0), false); }
function mk(i0, i1, b0, b1, w, data, inverted) {
  const outside = inverted ? 1 : 0;
  return { i0, i1, b0, b1, w, data, get: (i, b) => (i < i0 || i >= i1 || b < b0 || b >= b1 ? outside : data[(i - i0) * w + (b - b0)]) };
}
function blurTime(d, w, h, r) {
  const col = new Float32Array(h), pre = new Float64Array(h + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) col[y] = d[y * w + x];
    pre[0] = 0; for (let y = 0; y < h; y++) pre[y + 1] = pre[y] + col[y];
    for (let y = 0; y < h; y++) { const a = Math.max(0, y - r), b = Math.min(h, y + r + 1); d[y * w + x] = (pre[b] - pre[a]) / (2 * r + 1); }
  }
}
function blurFreq(d, w, h, radius) {
  const pre = new Float64Array(w + 1);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    pre[0] = 0; for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + d[o + x];
    for (let x = 0; x < w; x++) { const r = radius(x), a = Math.max(0, x - r), b = Math.min(w, x + r + 1); d[o + x] = (pre[b] - pre[a]) / (2 * r + 1); }
  }
}

// ------------------------------------------------------------------ STFT processing
/**
 * Applies one edit to the channels (Float32Arrays, changed in place). edit: { op, sel, db, strength,
 * hum, sensitivity }. Only the frames the selection touches are re-synthesised; everything else is
 * left bit for bit as it was.
 */
export function applyEdit(chans, rate, edit, { N = N_DEFAULT } = {}) {
  if (edit.op === 'declick') return declick(chans, rate, edit);
  // hum sits at exact low frequencies: a long window gives ~3 Hz bins, so the notches miss the notes next to them
  if (edit.op === 'dehum') N = 2 ** Math.round(Math.log2(rate / 3));
  const H = N / 4, len = chans[0].length, frames = Math.ceil(len / H) + 1, bins = N / 2 + 1;
  if (edit.op === 'denoise') N = N_DEFAULT; // the learned profile is for this size
  const whole_t = { shapes: [{ kind: 'time', t0: 0, t1: chans[0].length / rate }] };
  const sel = edit.op === 'denoise' ? (edit.sel && edit.sel.shapes && edit.sel.shapes.length ? edit.sel : whole_t) : edit.op === 'dehum' ? { shapes: [{ kind: 'time', t0: edit.sel?.shapes?.[0]?.kind === 'time' ? edit.sel.shapes[0].t0 : 0, t1: edit.sel?.shapes?.[0]?.kind === 'time' ? edit.sel.shapes[0].t1 : len / rate }] } : edit.sel;
  const mask = rasterize(sel, { rate, N, H, frames });
  if (mask.i1 <= mask.i0 && edit.op !== 'isolate') return { t0: 0, t1: 0 };
  // surround: how much audio either side the repair learns from (RX's Surround length)
  const refF = ['attenuate', 'heal'].includes(edit.op) ? Math.max(4, Math.round(((edit.surround ?? 0.25) * rate) / H)) : 0;
  // the span reaches 4 frames (one window) past everything touched, also past the ends of the audio,
  // so every sample that can change is rebuilt from a full set of overlapping frames
  const whole = edit.op === 'isolate' || mask.inverted; // touches everything outside the selection too
  const spanI0 = whole ? -4 : mask.i0 - refF - 4, spanI1 = whole ? frames + 4 : mask.i1 + refF + 4;
  const win = hann(N), norm = 1.5; // Hann² at 75% overlap sums to 1.5
  const g = edit.op === 'remove' ? 10 ** (-80 / 20) : 10 ** ((edit.db || 0) / 20);
  const strength = edit.strength ?? 1;
  const hum = edit.op === 'dehum' ? humBins(chans, rate, N, edit) : null;
  const stored = edit.op === 'attenuate' || edit.op === 'heal'; // these look at neighbouring frames
  for (const x of chans) {
    const nF = spanI1 - spanI0;
    const re = new Float64Array(N), im = new Float64Array(N);
    const load = k => { const c = (spanI0 + k) * H - N / 2; for (let n = 0; n < N; n++) { const q = c + n; re[n] = (q >= 0 && q < len ? x[q] : 0) * win[n]; im[n] = 0; } fft(re, im); };
    const sc = (b, v) => { re[b] *= v; im[b] *= v; if (b > 0 && b < N / 2) { re[N - b] *= v; im[N - b] *= v; } };
    const s0 = spanI0 * H - N / 2, out = new Float32Array(nF * H + N);
    const emit = k => { fft(re, im, true); const o = k * H; for (let n = 0; n < N; n++) out[o + n] += (re[n] * win[n]) / norm; };
    if (stored) {
      // half spectra of the span (the selection plus a quarter second either side)
      const RE = new Float32Array(nF * bins), IM = new Float32Array(nF * bins);
      for (let k = 0; k < nF; k++) { load(k); for (let q = 0; q < bins; q++) { RE[k * bins + q] = re[q]; IM[k * bins + q] = im[q]; } }
      const mag = (k, q) => Math.hypot(RE[k * bins + q], IM[k * bins + q]);
      const gain = new Float32Array(nF * bins).fill(1);
      const dir = edit.direction || 'h', tilt = Math.max(-1, Math.min(1, edit.tilt || 0));
      const wB = 1 - tilt, wA = 1 + tilt; // tilt < 0 leans on what comes before, > 0 on what comes after
      const refH = dir === 'v' ? null : new Float32Array(nF * bins).fill(NaN), refV = dir === 'h' ? null : new Float32Array(nF * bins).fill(NaN);
      // horizontal: per frequency, the level just before and just after the selection, faded across it
      // (each separate run of the selection along time is bridged from its own surroundings)
      if (refH) for (let q = mask.b0; q < mask.b1; q++) {
        const avg = (lo, hi) => { let t = 0, n = 0; for (let i = Math.max(spanI0, lo, 0); i < Math.min(spanI1, hi, frames - 1); i++) { if (mask.get(i, q) > 0.01) continue; t += mag(i - spanI0, q); n++; } return n ? t / n : null; };
        for (let i = mask.i0; i < mask.i1; i++) {
          if (mask.get(i, q) <= 0.01) continue;
          const first = i; let last = i; while (last + 1 < mask.i1 && mask.get(last + 1, q) > 0.01) last++;
          i = last;
          let before = avg(first - refF, first), after = avg(last + 1, last + 1 + refF);
          if (before === null) before = after; if (after === null) after = before;
          if (before === null) continue;
          for (let j = first; j <= last; j++) {
            const u = last > first ? (j - first) / (last - first) : 0.5, wb = (1 - u) * wB, wa = u * wA;
            refH[(j - spanI0) * bins + q] = (before * wb + after * wa) / Math.max(1e-9, wb + wa);
          }
        }
      }
      // vertical: per moment, the level just below and just above the selected band (whistles, tones)
      if (refV) for (let i = mask.i0; i < mask.i1; i++) {
        let qa = -1, qb = -1;
        for (let q = mask.b0; q < mask.b1; q++) if (mask.get(i, q) > 0.01) { if (qa < 0) qa = q; qb = q; }
        if (qa < 0) continue;
        const k = i - spanI0, R = Math.max(3, Math.round((qb - qa + 1) * 0.5));
        const avg = (lo, hi) => { let t = 0, n = 0; for (let q = Math.max(1, lo); q < Math.min(bins - 1, hi); q++) { t += mag(k, q); n++; } return n ? t / n : null; };
        let below = avg(qa - R, qa), above = avg(qb + 1, qb + 1 + R);
        if (below === null) below = above; if (above === null) above = below;
        if (below === null) continue;
        for (let q = qa; q <= qb; q++) { const u = qb > qa ? (q - qa) / (qb - qa) : 0.5; refV[k * bins + q] = below * (1 - u) + above * u; }
      }
      for (let i = mask.i0; i < mask.i1; i++) {
        const k = i - spanI0;
        for (let q = mask.b0; q < mask.b1; q++) {
          const m = mask.get(i, q) * strength; if (m <= 0) continue;
          const h = refH ? refH[k * bins + q] : NaN, v = refV ? refV[k * bins + q] : NaN;
          const ref = dir === 'both' ? (Number.isNaN(h) ? v : Number.isNaN(v) ? h : (h + v) / 2) : dir === 'v' ? v : h;
          if (Number.isNaN(ref)) continue;
          const cur = mag(k, q); if (cur < 1e-12) continue;
          const target = edit.op === 'heal' ? ref : Math.min(cur, ref);
          gain[k * bins + q] = 1 + m * (target / cur - 1);
        }
      }
      for (let k = 0; k < nF; k++) {
        for (let q = 0; q < bins; q++) { re[q] = RE[k * bins + q]; im[q] = IM[k * bins + q]; if (q > 0 && q < N / 2) { re[N - q] = re[q]; im[N - q] = -im[q]; } }
        for (let q = mask.b0; q < mask.b1; q++) { const v = gain[k * bins + q]; if (v !== 1) sc(q, v); }
        emit(k);
      }
    } else {
      // frame by frame: nothing but the output is kept, so whole-clip edits stay light
      const raw = new Float32Array(bins), prev = new Float32Array(bins).fill(-1);
      for (let k = 0; k < nF; k++) {
        load(k);
        const i = spanI0 + k;
        if (edit.op === 'denoise') {
          if (i >= mask.i0 && i < mask.i1) {
            // spectral subtraction against the learned noise, smoothed over time and across neighbours
            const prof = edit.profile, thr = 10 ** ((edit.threshold ?? 0) / 20), floor = 10 ** (-(edit.reduction ?? 12) / 20), sm = Math.max(0, Math.min(0.95, edit.smoothing ?? 0.5));
            for (let q = 0; q < bins; q++) {
              const cur = Math.hypot(re[q], im[q]), nz = (prof[q] || 0) * thr;
              raw[q] = cur > 1e-12 ? Math.max(floor, Math.sqrt(Math.max(0, 1 - (nz * nz) / (cur * cur)))) : floor;
            }
            for (let q = 0; q < bins; q++) {
              const g3 = (raw[Math.max(0, q - 1)] + raw[q] + raw[Math.min(bins - 1, q + 1)]) / 3;
              prev[q] = prev[q] < 0 ? g3 : prev[q] * sm + g3 * (1 - sm);
              const m = mask.get(i, q) * strength;
              if (m > 0) sc(q, 1 + m * (prev[q] - 1));
            }
          }
        } else if (edit.op === 'dehum') {
          if (i >= mask.i0 && i < mask.i1) {
            const mg = q => Math.hypot(re[q], im[q]);
            for (const [lo, hi] of hum) {
              // fill the notch from the median level of its neighbours
              const nb = []; for (let q = Math.max(1, lo - 8); q < lo - 1; q++) nb.push(mg(q)); for (let q = hi + 2; q < Math.min(bins - 1, hi + 9); q++) nb.push(mg(q));
              nb.sort((u, v) => u - v); const floor = nb.length ? nb[nb.length >> 1] : 0;
              for (let q = lo; q <= hi; q++) { const cur = mg(q); if (cur > floor && cur > 1e-12) sc(q, 1 + mask.get(i, q) * strength * (floor / cur - 1)); }
            }
          }
        } else {
          for (let q = (whole ? 0 : mask.b0); q < (whole ? bins : mask.b1); q++) {
            const m = mask.get(i, q);
            const v = edit.op === 'isolate' ? m + (1 - m) * 10 ** (-80 / 20) : 1 + m * strength * (g - 1);
            if (v !== 1) sc(q, v);
          }
        }
        emit(k);
      }
    }
    // written back only where every overlapping frame was in the span
    const safe0 = Math.max(0, s0 + N - H), safe1 = Math.min(len, s0 + nF * H);
    for (let q = safe0; q < safe1; q++) x[q] = out[q - s0];
  }
  return { t0: (mask.i0 * H) / rate, t1: (mask.i1 * H) / rate };
}

/** Noise profile (average level per frequency, N = 2048) of t0..t1: what De-noise learns. */
export function learnProfile(chans, rate, t0, t1, N = N_DEFAULT) {
  const H = N / 4, win = hann(N), bins = N / 2 + 1, prof = new Float64Array(bins), re = new Float64Array(N), im = new Float64Array(N), len = chans[0].length;
  let n = 0;
  for (let c = Math.max(0, Math.floor(t0 * rate) - N / 2); c + N <= Math.min(len, Math.ceil(t1 * rate) + N / 2); c += H) {
    for (let k = 0; k < N; k++) { let v = 0; for (const x of chans) v += x[c + k]; re[k] = (v / chans.length) * win[k]; im[k] = 0; }
    fft(re, im);
    for (let q = 0; q < bins; q++) prof[q] += Math.hypot(re[q], im[q]);
    n++;
  }
  return n ? Float32Array.from(prof, v => v / n) : null;
}

/** Bin ranges of mains hum (50 or 60 Hz, picked by which is louder) and its harmonics. */
function humBins(chans, rate, N, edit) {
  let f0 = edit.hum === 50 || edit.hum === 60 ? edit.hum : 0;
  if (!f0) {
    // compare the energy at 50/100/150 and 60/120/180 Hz over a few frames
    const x = chans[0], re = new Float64Array(N), im = new Float64Array(N), w = hann(N), sc = { 50: 0, 60: 0 };
    for (let s = 0; s + N < x.length && s < rate * 30; s += Math.max(N, Math.floor(x.length / 24))) {
      for (let n = 0; n < N; n++) { re[n] = x[s + n] * w[n]; im[n] = 0; }
      fft(re, im);
      for (const f of [50, 60]) for (let k = 1; k <= 3; k++) { const b = Math.round((f * k * N) / rate); sc[f] += Math.hypot(re[b], im[b]); }
    }
    f0 = sc[60] > sc[50] ? 60 : 50;
  }
  const out = [], nh = edit.harmonics || 8;
  const w = Math.max(1, Math.round((1.5 * N) / rate)); // ±1.5 Hz either side of each harmonic
  for (let k = 1; k <= nh; k++) { const c = (f0 * k * N) / rate; if (c > N / 2 - 4) break; out.push([Math.max(1, Math.floor(c - w)), Math.ceil(c + w)]); }
  return out;
}

/** Clicks: short spikes far above the local slope level, rebuilt with cubic interpolation. */
export function declick(chans, rate, edit) {
  const t0 = edit.sel?.shapes?.[0]?.kind === 'time' ? edit.sel.shapes[0].t0 : 0;
  const t1 = edit.sel?.shapes?.[0]?.kind === 'time' ? edit.sel.shapes[0].t1 : chans[0].length / rate;
  const thr = 14 - (edit.sensitivity ?? 0.5) * 9; // sensitivity 0..1 → 14x .. 5x the local level
  const win = Math.round(rate * 0.01), maxLen = Math.round(rate * 0.003), pad = Math.max(2, Math.round(rate * 0.0004));
  let fixed = 0;
  for (const x of chans) {
    const a = Math.max(2, Math.floor(t0 * rate)), z = Math.min(x.length - 2, Math.ceil(t1 * rate));
    const d = new Float32Array(x.length); for (let i = 1; i < x.length; i++) d[i] = x[i] - x[i - 1];
    // running RMS of the slope over 10 ms
    const sq = new Float64Array(x.length + 1); for (let i = 0; i < x.length; i++) sq[i + 1] = sq[i] + d[i] * d[i];
    const rms = i => Math.sqrt((sq[Math.min(x.length, i + win)] - sq[Math.max(0, i - win)]) / (2 * win) + 1e-12);
    for (let i = a; i < z; i++) {
      if (Math.abs(d[i]) <= thr * rms(i)) continue;
      let j = i; while (j < z && j - i < maxLen && Math.abs(d[j]) > thr * 0.4 * rms(i)) j++;
      if (j - i >= maxLen) { i = j; continue; } // too long to be a click
      const p = Math.max(1, i - pad), q = Math.min(x.length - 2, j + pad);
      const y0 = x[p], y1 = x[q], m0 = x[p] - x[p - 1], m1 = x[q + 1] - x[q], n = q - p;
      for (let k = 1; k < n; k++) {
        const u = k / n, u2 = u * u, u3 = u2 * u;
        x[p + k] = (2 * u3 - 3 * u2 + 1) * y0 + (u3 - 2 * u2 + u) * m0 * n + (-2 * u3 + 3 * u2) * y1 + (u3 - u2) * m1 * n;
      }
      fixed++; i = q;
    }
  }
  return { t0, t1, fixed };
}

// ------------------------------------------------------------------ display
export const PALETTES = {
  reel: [[0, 0, 0, 0], [0.18, 30, 8, 40], [0.38, 120, 20, 40], [0.58, 220, 90, 20], [0.8, 255, 180, 40], [1, 255, 248, 210]],
  magma: [[0, 0, 0, 4], [0.25, 60, 15, 110], [0.5, 180, 55, 120], [0.75, 250, 135, 95], [1, 252, 253, 191]],
  mono: [[0, 0, 0, 0], [1, 255, 255, 255]],
};
export function paletteLUT(name) {
  const stops = PALETTES[name] || PALETTES.reel, lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const v = i / 255; let k = 1; while (k < stops.length - 1 && stops[k][0] < v) k++;
    const [pa, ...ca] = stops[k - 1], [pb, ...cb] = stops[k], u = (v - pa) / Math.max(1e-6, pb - pa);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = ca[c] + (cb[c] - ca[c]) * Math.max(0, Math.min(1, u));
  }
  return lut;
}
/** Frequency ↔ 0..1 height (0 bottom) for log or linear display. */
export const fToY = (f, f0, f1, log) => (log ? (Math.log2(Math.max(f, 1)) - Math.log2(Math.max(f0, 1))) / (Math.log2(f1) - Math.log2(Math.max(f0, 1))) : (f - f0) / (f1 - f0));
export const yToF = (y, f0, f1, log) => (log ? 2 ** (Math.log2(Math.max(f0, 1)) + y * (Math.log2(f1) - Math.log2(Math.max(f0, 1)))) : f0 + y * (f1 - f0));
