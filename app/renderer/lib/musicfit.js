// Seamless music extension (like DaVinci Resolve's music remixing): makes a song longer or shorter without an
// audible join, keeping its real start and ending. The song is measured (tone colour in 24 bands every 50 ms, and
// how hard each moment hits), its beat grid is found, and pairs of beats whose surroundings sound alike are seams
// where the music can jump: forward to skip a stretch, or back to play a section again. The plan is a list of
// source ranges played one after another with short crossfades at the seams.

export const HOP = 0.05;   // seconds between measurements
const BANDS = 24;

/** In-place radix-2 FFT (re, im of length a power of two). */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const p = i + k, q = p + len / 2, tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
        re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/**
 * Measures a song (mono samples at `rate`): { hop, n, feat: Float32Array[] (24 bands, centred on the song's own
 * average so what's special about each moment counts), onset: Float32Array (how sharply each moment hits), duration }.
 */
export function analyseMusic(mono, rate) {
  const N = 2048, hop = Math.round(HOP * rate), n = Math.max(1, Math.floor((mono.length - N) / hop) + 1);
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  // band edges on a log scale from 60 Hz to 11 kHz
  const edges = Array.from({ length: BANDS + 1 }, (_, b) => Math.min(N / 2, Math.max(1, Math.round((60 * (11000 / 60) ** (b / BANDS)) * N / rate))));
  const feat = [], onset = new Float32Array(n), prev = new Float32Array(BANDS);
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let f = 0; f < n; f++) {
    const o = f * hop;
    for (let i = 0; i < N; i++) { re[i] = (mono[o + i] || 0) * win[i]; im[i] = 0; }
    fft(re, im);
    const v = new Float32Array(BANDS);
    let flux = 0;
    for (let b = 0; b < BANDS; b++) {
      let e = 0; for (let k = edges[b]; k < Math.max(edges[b] + 1, edges[b + 1]); k++) e += re[k] * re[k] + im[k] * im[k];
      v[b] = Math.log10(1e-9 + e);
      flux += Math.max(0, v[b] - prev[b]);
      prev[b] = v[b];
    }
    onset[f] = f ? flux : 0;
    feat.push(v);
  }
  const mean = new Float32Array(BANDS);
  for (const v of feat) for (let b = 0; b < BANDS; b++) mean[b] += v[b] / n;
  for (const v of feat) for (let b = 0; b < BANDS; b++) v[b] -= mean[b];
  return { hop: HOP, n, feat, onset, duration: mono.length / rate };
}

/** The beat: { period (s), phase (s), times: [s] } from the onsets (60–190 beats a minute). */
export function beatGrid(an) {
  const o = an.onset, n = o.length, h = an.hop;
  let mean = 0; for (const v of o) mean += v / n;
  const x = Array.from(o, v => Math.max(0, v - mean));
  let best = 0, lagBest = Math.round(0.5 / h);
  for (let lag = Math.round(60 / 190 / h); lag <= Math.round(60 / 60 / h); lag++) {
    let s = 0; for (let i = lag; i < n; i++) s += x[i] * x[i - lag];
    s *= 1 + 0.15 * Math.exp(-(((lag * h - 0.5) / 0.25) ** 2)); // a slight preference for ~120 a minute
    if (s > best) { best = s; lagBest = lag; }
  }
  // the phase: where beats line up with the strongest onsets
  let phBest = 0, ps = -1;
  for (let ph = 0; ph < lagBest; ph++) { let s = 0; for (let i = ph; i < n; i += lagBest) s += x[i]; if (s > ps) { ps = s; phBest = ph; } }
  const times = []; for (let i = phBest; i < n; i += lagBest) times.push(i * h);
  return { period: lagBest * h, phase: phBest * h, times };
}

/** How alike the music sounds around times a and b (seconds): the mean match of `w` seconds on each side, −1 … 1. */
export function likeness(an, a, b, w = 1.5) {
  const fa = Math.round(a / an.hop), fb = Math.round(b / an.hop), k = Math.round(w / an.hop);
  let s = 0, m = 0;
  for (let d = -k; d <= k; d += 2) {
    const u = an.feat[fa + d], v = an.feat[fb + d];
    if (!u || !v) continue;
    let dot = 0, nu = 0, nv = 0;
    for (let i = 0; i < u.length; i++) { dot += u[i] * v[i]; nu += u[i] * u[i]; nv += v[i] * v[i]; }
    s += dot / Math.sqrt(1e-9 + nu * nv); m++;
  }
  return m ? s / m : -1;
}

/**
 * The plan for playing [0, length] of the song in `target` seconds: { segments: [{ a, b }] (source ranges in order),
 * length (what they add up to), speed (a pitch-kept nudge, 0.97–1.03, for the last fraction of a second), seams:
 * [{ at, likeness }] }. The song's first and last few seconds are always kept (its intro and real ending).
 */
export function planFit(an, grid, length, target, { keepIntro = 2, keepOutro = 4, minLikeness = 0.55 } = {}) {
  const delta = target - length;
  const done = (segments, seams = []) => {
    const len = segments.reduce((s, g) => s + g.b - g.a, 0);
    const k = len / target;
    return { segments, length: len, speed: Math.abs(k - 1) <= 0.03 && Math.abs(k - 1) > 0.002 ? k : 1, seams };
  };
  if (Math.abs(delta) < 0.05) return done([{ a: 0, b: length }]);
  const beats = grid.times.filter(t => t >= keepIntro && t <= length - keepOutro);
  const per = grid.period || 0.5;
  let best = null;
  const consider = (i, j, k, err) => {
    const like = likeness(an, i, j);
    if (like < minLikeness) return;
    const score = like - Math.abs(err) / per * 0.35 - (k - 1) * 0.03;
    if (!best || score > best.score) best = { i, j, k, err, like, score };
  };
  if (delta < 0) {
    // shorten: jump forward from beat i to beat j, skipping j − i ≈ −delta
    const want = -delta;
    for (let x = 0; x < beats.length; x++) for (let y = x + 1; y < beats.length; y++) {
      const gap = beats[y] - beats[x], err = gap - want;
      if (err > per * 1.5) break;
      if (err < -per * 1.5) continue;
      consider(beats[x], beats[y], 1, err);
    }
    if (best) return done([{ a: 0, b: best.i }, { a: best.j, b: length }], [{ at: best.i, likeness: best.like }]);
    // no seamless jump: keep the start and the ending, joined with a crossfade
    const cut = Math.max(keepIntro, (length - want) * 0.5);
    return done([{ a: 0, b: cut }, { a: cut + want, b: length }], [{ at: cut, likeness: 0 }]);
  }
  // lengthen: at beat j jump back to beat i, playing the section i–j again (k times in all)
  for (let x = 0; x < beats.length; x++) for (let y = x + 1; y < beats.length; y++) {
    const loop = beats[y] - beats[x];
    if (loop < Math.max(2, per * 4)) continue;
    const k = Math.max(1, Math.round(delta / loop));
    if (k > 12) continue;
    consider(beats[x], beats[y], k, k * loop - delta);
  }
  if (best) {
    const segs = [{ a: 0, b: best.j }];
    for (let r = 1; r < best.k; r++) segs.push({ a: best.i, b: best.j });
    segs.push({ a: best.i, b: length });
    return done(segs, Array.from({ length: best.k }, (_, r) => ({ at: best.j + r * (best.j - best.i), likeness: best.like })));
  }
  // nothing loops cleanly: play the middle again from its start
  const a = Math.min(length - keepOutro - 1, keepIntro + 1), b = Math.max(a + 1, length - keepOutro);
  const loop = b - a, k = Math.max(1, Math.ceil(delta / loop)), segs = [{ a: 0, b }];
  for (let r = 1; r < k; r++) segs.push({ a, b });
  segs.push({ a, b: length });
  return done(segs, [{ at: b, likeness: 0 }]);
}
