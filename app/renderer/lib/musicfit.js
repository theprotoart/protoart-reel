// Music length: makes a song longer or shorter without an audible seam, ending on the song's own ending.
// Written for Reel. The idea is the one behind "remix to length" tools: find moments where the music repeats almost
// exactly (a bar of the chorus and the same bar of the next chorus), then jump between them, back to repeat a part
// (longer) or forward to skip one (shorter), with each join lined up to the sample and crossfaded.
//
//   analyse(mono, rate)            -> { hop, n, cands: [{ a, b, score }] }   (seconds; b > a, music at a ≈ music at b)
//   planFit(cands, D, T)           -> { segments: [{ from, to }], length, jumps } (play the segments in order)
//   refineJoin(x, rate, p, q)      -> q' : where to land so the join is phase-aligned
//   render(channels, rate, plan)   -> new channels (Float32Array per channel), crossfaded joins
import { fft } from '../spectral-dsp.js';

const BANDS = 24, FMIN = 60, FMAX = 5500;

/** Per-frame spectral shape: log energy in 24 log-spaced bands, centred and normalised (so loudness doesn't count). */
export function features(mono, rate, { hop = 0.085, size = 2048 } = {}) {
  // analyse at ~12 kHz (enough for rhythm and harmony, 4× less work)
  const k = Math.max(1, Math.round(rate / 12000)), sr = rate / k;
  const len = Math.floor(mono.length / k), x = new Float32Array(len);
  for (let i = 0; i < len; i++) { let s = 0; for (let j = 0; j < k; j++) s += mono[i * k + j]; x[i] = s / k; }
  const h = Math.max(256, Math.round(hop * sr)), n = Math.max(0, Math.floor((len - size) / h) + 1);
  const edges = [];
  for (let b = 0; b <= BANDS; b++) edges.push(Math.max(1, Math.round(FMIN * Math.pow(FMAX / FMIN, b / BANDS) / sr * size)));
  const win = new Float32Array(size); for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size);
  const re = new Float32Array(size), im = new Float32Array(size);
  const out = new Float32Array(n * BANDS), energy = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    const o = f * h; let e = 0;
    for (let i = 0; i < size; i++) { const v = x[o + i]; re[i] = v * win[i]; im[i] = 0; e += v * v; }
    energy[f] = Math.sqrt(e / size);
    fft(re, im);
    let mean = 0;
    for (let b = 0; b < BANDS; b++) {
      let s = 0; for (let i = edges[b]; i < Math.max(edges[b] + 1, edges[b + 1]); i++) s += re[i] * re[i] + im[i] * im[i];
      const v = Math.log(1e-9 + s); out[f * BANDS + b] = v; mean += v;
    }
    mean /= BANDS; let norm = 0;
    for (let b = 0; b < BANDS; b++) { const v = out[f * BANDS + b] - mean; out[f * BANDS + b] = v; norm += v * v; }
    norm = Math.sqrt(norm) || 1;
    for (let b = 0; b < BANDS; b++) out[f * BANDS + b] /= norm;
  }
  return { feat: out, energy, n, hop: h / sr };
}

/**
 * Finds pairs of moments that sound the same over ~2.5 s around them. Only pairs at least `minGap` seconds apart,
 * away from the very start and end. Returns the best few dozen, spread out (not all the same spot). Async-friendly:
 * pass `yieldEvery` lags to await `tick()` between batches so the page stays responsive.
 */
export async function analyse(mono, rate, { minGap = 4, edge = 3, context = 2.5, max = 60, tick = null } = {}) {
  const F = features(mono, rate);
  const { feat, energy, n, hop } = F;
  const W = Math.max(4, Math.round(context / hop)), half = W >> 1;
  const g0 = Math.max(1, Math.round(minGap / hop)), e0 = Math.round(edge / hop);
  let loud = 0; for (let i = 0; i < n; i++) loud = Math.max(loud, energy[i]);
  const quiet = loud * 0.06;
  const best = []; // [score, a, lag]
  const sim = new Float32Array(n);
  for (let lag = g0; lag < n - 2 * e0; lag++) {
    // similarity of frame t and frame t+lag, then a moving average over the context window
    for (let t = 0; t + lag < n; t++) {
      let s = 0; const p = t * BANDS, q = (t + lag) * BANDS;
      for (let b = 0; b < BANDS; b++) s += feat[p + b] * feat[q + b];
      sim[t] = s;
    }
    let run = 0;
    for (let t = 0; t < W && t + lag < n; t++) run += sim[t];
    let localBest = -1, localA = -1;
    for (let t = half; t + lag + half < n; t++) {
      if (t > half) run += sim[t + half - 1] - sim[t - half - 1];
      if (t < e0 || t + lag > n - e0) continue;
      if (energy[t] < quiet || energy[t + lag] < quiet) continue;
      const s = run / W;
      if (s > localBest) { localBest = s; localA = t; }
    }
    if (localA >= 0) best.push([localBest, localA, lag]);
    if (tick && lag % 40 === 0) await tick(lag / n);
  }
  best.sort((x, y) => y[0] - x[0]);
  // spread them out: drop a pair too close to one already kept (same jump, nudged)
  const kept = [];
  for (const [s, a, lag] of best) {
    if (s < 0.6) break;
    if (kept.some(k => Math.abs(k.a - a * hop) < 1.5 && Math.abs(k.b - k.a - lag * hop) < 1.5)) continue;
    kept.push({ a: a * hop, b: (a + lag) * hop, score: s });
    if (kept.length >= max) break;
  }
  return { hop, n, duration: mono.length / rate, cands: kept };
}

/**
 * The segments to play for a song of length D to last about T. Longer: one or two loops (jump back from b to a),
 * repeated as often as needed. Shorter: one or two skips (jump forward from a to b). Picks the plan closest to T,
 * then the one with fewer, better joins. Always starts at 0 and ends at D (the song's own intro and ending).
 */
export function planFit(cands, D, T, { tolerance = 1.5 } = {}) {
  const plain = { segments: [{ from: 0, to: D }], length: D, jumps: 0, score: 1 };
  if (!(T > 0) || Math.abs(T - D) <= tolerance / 3 || !cands.length) return plain;
  const plans = [];
  const cost = p => Math.abs(p.length - T) * 3 + p.jumps * 0.6 + (1 - p.score) * 20;
  if (T > D) {
    // jump back: play 0→b, then a→b (n−1 more times), then a→D
    for (const c of cands) {
      const L = c.b - c.a; if (L < 2) continue;
      const reps = Math.max(1, Math.round((T - D) / L));
      for (const r of [reps - 1, reps, reps + 1]) {
        if (r < 1 || r > 40) continue;
        const segs = [{ from: 0, to: c.b }];
        for (let i = 1; i < r; i++) segs.push({ from: c.a, to: c.b });
        segs.push({ from: c.a, to: D });
        plans.push({ segments: segs, length: D + r * L, jumps: r, score: c.score });
      }
    }
    // two different loops (fills the length more exactly): 0→b1, a1→b2 (b2 > a1), a2→D, with repeats of the first
    const top = cands.slice(0, 25);
    for (const c1 of top) for (const c2 of top) {
      if (c1 === c2 || !(c2.b > c1.a + 2) || !(c2.a < c2.b)) continue;
      const L1 = c1.b - c1.a, L2 = c2.b - c2.a;
      for (let r1 = 1; r1 <= 20; r1++) {
        const extra = T - D - r1 * L1 - L2; // the second loop once
        if (extra < -L1) break;
        if (Math.abs(extra) > tolerance * 2) continue;
        const segs = [{ from: 0, to: c1.b }];
        for (let i = 1; i < r1; i++) segs.push({ from: c1.a, to: c1.b });
        segs.push({ from: c1.a, to: c2.b }, { from: c2.a, to: D });
        // only valid if the music between c1.a and c2.b runs forwards
        if (c2.b <= c1.a) continue;
        plans.push({ segments: segs, length: D + r1 * L1 + L2, jumps: r1 + 1, score: Math.min(c1.score, c2.score) });
      }
    }
  } else {
    // jump forward: play 0→a, then b→D (skips b−a)
    for (const c of cands) {
      const L = c.b - c.a;
      plans.push({ segments: [{ from: 0, to: c.a }, { from: c.b, to: D }], length: D - L, jumps: 1, score: c.score });
    }
    const top = cands.slice(0, 30);
    for (const c1 of top) for (const c2 of top) {
      if (!(c2.a > c1.b + 2)) continue; // second skip after the first lands
      const len = D - (c1.b - c1.a) - (c2.b - c2.a);
      if (len < 4) continue;
      plans.push({ segments: [{ from: 0, to: c1.a }, { from: c1.b, to: c2.a }, { from: c2.b, to: D }], length: len, jumps: 2, score: Math.min(c1.score, c2.score) });
    }
  }
  if (!plans.length) return plain;
  plans.sort((p, q) => cost(p) - cost(q));
  return plans[0];
}

/** Where to land after jumping from p to q (seconds): q nudged by up to ±40 ms so the waveforms line up. */
export function refineJoin(x, rate, p, q, { search = 0.04, win = 0.06 } = {}) {
  const P = Math.round(p * rate), Q = Math.round(q * rate), S = Math.round(search * rate), N = Math.round(win * rate);
  let best = -Infinity, bestD = 0;
  const step = Math.max(1, Math.round(rate / 24000)); // ~every other sample at 48 kHz
  for (let d = -S; d <= S; d += step) {
    let dot = 0, e1 = 0, e2 = 0;
    for (let i = 0; i < N; i += 2) {
      const u = x[P + i] || 0, v = x[Q + d + i] || 0;
      dot += u * v; e1 += u * u; e2 += v * v;
    }
    const c = dot / (Math.sqrt(e1 * e2) || 1);
    if (c > best) { best = c; bestD = d; }
  }
  return (Q + bestD) / rate;
}

/**
 * Plays the plan into new audio: each segment in turn, with an equal-power crossfade (`fade` seconds) at every
 * join, starting the fade where the previous segment ends. `mono` (for lining up the joins) defaults to channel 0.
 */
export function render(channels, rate, plan, { fade = 0.05, mono = null } = {}) {
  const x = mono || channels[0];
  const segs = plan.segments.map(s => ({ ...s }));
  for (let i = 1; i < segs.length; i++) segs[i].from = refineJoin(x, rate, segs[i - 1].to, segs[i].from);
  const F = Math.max(1, Math.round(fade * rate));
  const lens = segs.map(s => Math.max(0, Math.round((s.to - s.from) * rate)));
  const total = lens.reduce((a, b) => a + b, 0);
  const out = channels.map(() => new Float32Array(total));
  let w = 0;
  for (let k = 0; k < segs.length; k++) {
    const s0 = Math.round(segs[k].from * rate), n = lens[k];
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c], dst = out[c];
      for (let i = 0; i < n; i++) dst[w + i] = src[s0 + i] || 0;
      // crossfade into this segment: the previous segment carries on for F samples past its end, fading out
      if (k > 0) {
        const pe = Math.round(segs[k - 1].to * rate);
        for (let i = 0; i < F && i < n; i++) {
          const t = (i + 0.5) / F, gIn = Math.sin(t * Math.PI / 2), gOut = Math.cos(t * Math.PI / 2);
          dst[w + i] = dst[w + i] * gIn + (src[pe + i] || 0) * gOut;
        }
      }
    }
    w += n;
  }
  return { channels: out, seconds: total / rate, joins: segs.slice(1).map(s => s.from) };
}

/** m:ss for messages. */
export const mmss = s => { const r = Math.max(0, Math.round(s)); return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`; };
