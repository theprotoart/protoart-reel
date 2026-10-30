// Time stretching that keeps pitch (WSOLA): short overlapping windows are taken from the source at the new rate
// and each is nudged (within ±tolerance) to where it lines up best with what was just written, so a sped-up voice
// keeps its pitch instead of rising like tape.

/**
 * chans: Float32Array per channel (same length), speed > 0. Returns the stretched channels, length ≈ len / speed.
 * rate: sample rate (sets the 40 ms window and 8 ms search).
 */
export function stretch(chans, speed, rate) {
  const len = chans[0].length, outLen = Math.max(1, Math.round(len / speed));
  if (Math.abs(speed - 1) < 1e-4) return chans.map(c => c.slice());
  return warp(chans, o => o * speed, outLen, rate);
}

/**
 * Time-varying version: output sample o takes its sound from around source sample map(o) (increasing), the
 * pitch kept. Used for alignment (a take warped onto a guide's timing) as well as plain speed changes.
 */
export function warp(chans, map, outLen, rate) {
  const len = chans[0].length;
  const N = Math.max(64, 2 * Math.round((0.04 * rate) / 2)), Hs = N / 2, tol = Math.round(0.008 * rate);
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const mono = chans.length === 1 ? chans[0] : (() => { const m = new Float32Array(len); for (const c of chans) for (let i = 0; i < len; i++) m[i] += c[i] / chans.length; return m; })();
  const out = chans.map(() => new Float32Array(outLen + N)), norm = new Float32Array(outLen + N);
  let prev = 0; // where the last window came from
  const at = (x, i) => (i >= 0 && i < len ? x[i] : 0);
  const score = (p, q, step) => { let s = 0; for (let i = 0; i < N; i += step) s += at(mono, p + i) * at(mono, q + i); return s; };
  for (let k = 0, o = 0; o < outLen; k++, o += Hs) {
    const ideal = Math.round(map(o));
    let best = ideal;
    if (k > 0) {
      // the natural continuation of the previous window is what this one should resemble
      const want = prev + Hs, lo = Math.max(0, ideal - tol), hi = Math.min(len - 1, ideal + tol);
      let bs = -Infinity;
      for (let p = lo; p <= hi; p += 4) { const sc = score(p, want, 8); if (sc > bs) { bs = sc; best = p; } }
      for (let p = Math.max(lo, best - 3); p <= Math.min(hi, best + 3); p++) { const sc = score(p, want, 2); if (sc > bs) { bs = sc; best = p; } }
    }
    for (let c = 0; c < chans.length; c++) { const x = chans[c], y = out[c]; for (let i = 0; i < N; i++) y[o + i] += at(x, best + i) * win[i]; }
    for (let i = 0; i < N; i++) norm[o + i] += win[i];
    prev = best;
  }
  return out.map(y => { const r = new Float32Array(outLen); for (let i = 0; i < outLen; i++) r[i] = norm[i] > 1e-3 ? y[i] / norm[i] : y[i]; return r; });
}
