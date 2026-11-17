// Seamless music extension (like DaVinci Resolve's music remixing): makes a song longer or shorter without an
// audible join, keeping its real start and ending.
//
//   1. The song is measured every ~23 ms: its tone colour (24 bands), its harmony (12 pitch classes), how loud it is
//      and how hard each moment hits.
//   2. Its beat is followed through the song (dynamic programming, so a live drummer's drift is kept), and the bars
//      are found (the beat in each four where the kick and the chord changes land).
//   3. Every pair of bar starts whose surroundings sound alike, in tone, harmony and loudness, two bars either side,
//      is a place the song can jump: back, to play a stretch again, or forward, to skip one.
//   4. A search picks the set of jumps that lands on the target length with the best-matching joins, the fewest
//      of them, and variety: different stretches played again, not one loop over and over.
//   5. Each join is lined up to the sample (the waveforms either side matched) and crossfaded briefly, so a drum
//      hit at the join lands once, not twice.
//
// The plan is a list of source ranges played one after another, with the crossfade for each join.

export const HOP = 0.0232; // seconds between measurements (~512 samples at 22 kHz)
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

const cos = (u, v) => { let d = 0, a = 0, b = 0; for (let i = 0; i < u.length; i++) { d += u[i] * v[i]; a += u[i] * u[i]; b += v[i] * v[i]; } return d / Math.sqrt(1e-12 + a * b); };

/**
 * Measures a song (mono samples at `rate`): { hop, n, feat (tone colour per frame, 24 bands, centred on the song's own
 * average), chroma (12 pitch classes per frame), loud (log energy per frame), onset, low (the kick's onset), duration,
 * mono, rate }.
 */
export function analyseMusic(mono, rate) {
  const N = 2048, hopN = Math.max(1, Math.round(HOP * rate)), hop = hopN / rate;
  const n = Math.max(1, Math.floor((mono.length - N) / hopN) + 1);
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  // band edges on a log scale from 60 Hz to 11 kHz (or the Nyquist)
  const top = Math.min(11000, rate / 2 - 1);
  const edges = Array.from({ length: BANDS + 1 }, (_, b) => Math.min(N / 2, Math.max(1, Math.round((60 * (top / 60) ** (b / BANDS)) * N / rate))));
  const lowBands = edges.findIndex(e => (e * rate) / N > 200);
  // each bin from 80 Hz to 5 kHz to its pitch class
  const pc = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) { const f = (k * rate) / N; if (f >= 80 && f <= 5000) pc[k] = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12; }
  const feat = [], chroma = [], loud = new Float32Array(n), onset = new Float32Array(n), low = new Float32Array(n), prev = new Float32Array(BANDS);
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let f = 0; f < n; f++) {
    const o = f * hopN;
    for (let i = 0; i < N; i++) { re[i] = (mono[o + i] || 0) * win[i]; im[i] = 0; }
    fft(re, im);
    const v = new Float32Array(BANDS), c = new Float32Array(12);
    let flux = 0, lflux = 0, all = 0;
    for (let k = 1; k < N / 2; k++) { const p = re[k] * re[k] + im[k] * im[k]; all += p; if (pc[k] >= 0) c[pc[k]] += p; }
    for (let b = 0; b < BANDS; b++) {
      let e = 0; for (let k = edges[b]; k < Math.max(edges[b] + 1, edges[b + 1]); k++) e += re[k] * re[k] + im[k] * im[k];
      v[b] = Math.log10(1e-9 + e);
      const d = Math.max(0, v[b] - prev[b]);
      flux += d; if (b < lowBands) lflux += d;
      prev[b] = v[b];
    }
    let cn = 0; for (let i = 0; i < 12; i++) { c[i] = Math.sqrt(c[i]); cn += c[i] * c[i]; }
    cn = Math.sqrt(cn) || 1; for (let i = 0; i < 12; i++) c[i] /= cn;
    onset[f] = f ? flux : 0; low[f] = f ? lflux : 0;
    loud[f] = Math.log10(1e-9 + all);
    feat.push(v); chroma.push(c);
  }
  const mean = new Float32Array(BANDS);
  for (const v of feat) for (let b = 0; b < BANDS; b++) mean[b] += v[b] / n;
  for (const v of feat) for (let b = 0; b < BANDS; b++) v[b] -= mean[b];
  // a frame's moment: near the end of its window (a hit shows as an onset as soon as it comes into the window)
  return { hop, n, feat, chroma, loud, onset, low, duration: mono.length / rate, mono, rate, t0: (0.92 * N) / rate };
}

/**
 * The beat, followed through the song: { period (s, the typical beat), phase (s), times: [s] (every beat), bars: [i]
 * (the index in times of each bar's first beat), beatsPerBar }. 60–190 beats a minute.
 */
export function beatGrid(an) {
  const h = an.hop, n = an.onset.length;
  // the onsets, each measured against the second around it, so loud and quiet passages count alike
  const o = new Float32Array(n), w = Math.max(1, Math.round(0.5 / h));
  let pre = 0; const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { pre += an.onset[i]; cum[i + 1] = pre; }
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - w), b = Math.min(n, i + w + 1); o[i] = Math.max(0, an.onset[i] - (cum[b] - cum[a]) / (b - a)); }
  let sd = 0; for (const v of o) sd += v * v; sd = Math.sqrt(sd / n) || 1;
  for (let i = 0; i < n; i++) o[i] /= sd;
  // the tempo: the strongest repeat of the onsets, with a gentle preference for ~120 a minute
  const lo = Math.round(60 / 190 / h), hi = Math.round(60 / 60 / h);
  const ac = new Float64Array(hi + 2);
  for (let lag = lo - 1; lag <= hi + 1; lag++) { let s = 0; for (let i = lag; i < n; i++) s += o[i] * o[i - lag]; ac[lag] = s / (n - lag || 1); }
  let P = Math.round(0.5 / h), best = -Infinity;
  for (let lag = lo; lag <= hi; lag++) {
    const bpm = 60 / (lag * h), s = ac[lag] * Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    if (s > best) { best = s; P = lag; }
  }
  // its fraction of a frame (where the peak really is)
  const a0 = ac[P - 1], a1 = ac[P], a2 = ac[P + 1], den = a0 - 2 * a1 + a2;
  const Pf = P + (den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a0 - a2)) / den)) : 0);
  // dynamic programming (Ellis 2007): each beat is the best-placed one about a beat after the one before
  const score = new Float64Array(n), from = new Int32Array(n).fill(-1), alpha = 400;
  for (let t = 0; t < n; t++) {
    let bs = 0, bf = -1;
    for (let tau = Math.max(0, Math.floor(t - 2 * Pf)); tau <= t - Math.round(Pf / 2); tau++) {
      const s = score[tau] - alpha * Math.log((t - tau) / Pf) ** 2;
      if (bf < 0 || s > bs) { bs = s; bf = tau; }
    }
    score[t] = o[t] + (bf >= 0 ? Math.max(0, bs) : 0);
    from[t] = bf >= 0 && bs > 0 ? bf : -1;
  }
  let end = n - 1;
  for (let t = Math.max(0, n - Math.round(Pf)); t < n; t++) if (score[t] > score[end]) end = t;
  const frames = [];
  for (let t = end; t >= 0; t = from[t]) { frames.push(t); if (from[t] < 0) break; }
  frames.reverse();
  // and on, a beat at a time, to the song's very start (the DP stops where the onsets do)
  while (frames.length && frames[0] - Pf >= 0) frames.unshift(Math.round(frames[0] - Pf));
  const off = an.t0 || 0;
  const times = frames.map(f => f * h + off);
  const period = times.length > 1 ? (times[times.length - 1] - times[0]) / (times.length - 1) : Pf * h;
  // the bars: of the four ways to group the beats in fours, the one whose first beats have the kick and the chord changes
  const beatsPerBar = 4;
  const chromaAt = (a, b) => { const c = new Float32Array(12); for (let f = a; f < Math.max(a + 1, b) && f < n; f++) for (let i = 0; i < 12; i++) c[i] += an.chroma[f][i]; return c; };
  const change = frames.map((f, k) => (k ? 1 - cos(chromaAt(frames[k - 1], f), chromaAt(f, frames[k + 1] ?? f + Math.round(Pf))) : 0));
  const kick = frames.map(f => { let s = 0; for (let d = -1; d <= 1; d++) s += an.low[f + d] || 0; return s; });
  let kmax = 0; for (const v of kick) kmax = Math.max(kmax, v); kmax ||= 1;
  let phase = 0, ps = -Infinity;
  for (let ph = 0; ph < beatsPerBar; ph++) {
    let s = 0, m = 0;
    for (let k = ph; k < frames.length; k += beatsPerBar) { s += kick[k] / kmax + 2 * change[k]; m++; }
    s /= m || 1;
    if (s > ps) { ps = s; phase = ph; }
  }
  const bars = []; for (let k = phase; k < frames.length; k += beatsPerBar) bars.push(k);
  return { period, phase: times[0] || 0, times, bars, beatsPerBar };
}

/** How alike the music sounds around times a and b (seconds): tone colour and harmony over `w` seconds each side, −1 … 1. */
export function likeness(an, a, b, w = 1.5) {
  const at = t => Math.round((t - (an.t0 || 0)) / an.hop);
  const fa = at(a), fb = at(b), k = Math.round(w / an.hop);
  let s = 0, m = 0;
  for (let d = -k; d <= k; d += 2) {
    const u = an.feat[fa + d], v = an.feat[fb + d];
    if (!u || !v) continue;
    s += 0.45 * cos(u, v) + 0.55 * cos(an.chroma[fa + d], an.chroma[fb + d]); m++;
  }
  return m ? s / m : -1;
}

/** Per beat: its tone colour, harmony and loudness, averaged over the beat (what the joins are judged on). */
export function beatFeatures(an, grid) {
  const T = grid.times, out = [];
  for (let k = 0; k < T.length; k++) {
    const at = t => Math.max(0, Math.round((t - (an.t0 || 0)) / an.hop));
    const a = at(T[k]), b = Math.max(a + 1, at(T[k + 1] ?? T[k] + grid.period));
    const t = new Float32Array(BANDS), c = new Float32Array(12);
    let l = 0, m = 0;
    for (let f = a; f < b && f < an.n; f++) { for (let i = 0; i < BANDS; i++) t[i] += an.feat[f][i]; for (let i = 0; i < 12; i++) c[i] += an.chroma[f][i]; l += an.loud[f]; m++; }
    out.push({ t, c, l: m ? l / m : -9 });
  }
  return out;
}

/** What a join is matched on (Premiere's Remix "Variations" focus): the lead (tone colour) or the chords (harmony). */
export const FOCUS = { both: [0.4, 0.6], melody: [0.7, 0.3], harmony: [0.2, 0.8] };

/** How well beat j continues where beat i would have: the two bars before and after each, −1 … 1. */
export function joinLikeness(bf, i, j, W = 8, [wt, wc] = FOCUS.both) {
  let s = 0, m = 0, ld = 0;
  for (let d = -W; d < W; d++) {
    const u = bf[i + d], v = bf[j + d];
    if (!u || !v) continue;
    s += wt * cos(u.t, v.t) + wc * cos(u.c, v.c);
    ld += Math.abs(u.l - v.l); m++;
  }
  if (m < W) return -1; // too near the start or the end to judge
  return s / m - 0.5 * (ld / m); // a loud passage doesn't follow on from a quiet one
}

/**
 * Lines a join up to the sample: the moment near `q` whose waveform best continues what plays at `p` (±25 ms).
 * { q, match (0 … 1) }.
 */
export function alignJoin(an, p, q, reach = 0.025) {
  const x = an.mono, R = an.rate;
  if (!x) return { q, match: 0 };
  const L = Math.round(0.03 * R), ip = Math.round(p * R), iq = Math.round(q * R), K = Math.round(reach * R);
  if (ip - L < 0 || ip + L >= x.length) return { q, match: 0 };
  let ea = 0; for (let i = -L; i < L; i++) ea += x[ip + i] * x[ip + i];
  let best = -2, bd = 0;
  for (let d = -K; d <= K; d++) {
    const j = iq + d;
    if (j - L < 0 || j + L >= x.length) continue;
    let s = 0, eb = 0;
    for (let i = -L; i < L; i += 2) { const v = x[j + i]; s += x[ip + i] * v; eb += v * v; }
    const c = s / Math.sqrt(1e-12 + (ea / 2) * eb);
    if (c > best) { best = c; bd = d; }
  }
  return { q: (iq + bd) / R, match: Math.max(0, best) };
}

/**
 * The plan for playing [0, length] of the song in `target` seconds: { segments: [{ a, b }] (source ranges in order),
 * length (what they add up to), speed (a pitch-kept nudge, 0.97–1.03, so it lands exactly), seams: [{ at, from, to,
 * likeness, xf }] (where each join is in the source, its match, and its crossfade, s) }. The song's first and last few
 * seconds always play (its intro and real ending).
 */
export function planFit(an, grid, length, target, { keepIntro = 2, keepOutro = 4, minLikeness = 0.55, segments = 3, variation = 0, focus = 'both' } = {}) {
  // Segments (1 few joins … 5 many, as Premiere's Remix): what each join costs, and how much plays between joins
  const sg = Math.max(1, Math.min(5, Math.round(segments)));
  const JUMP = [0.45, 0.2, 0.06, -0.1, -0.22][sg - 1], runBars = [8, 4, 2, 2, 1][sg - 1], minJumpBars = [8, 4, 2, 1, 1][sg - 1];
  const delta = target - length;
  const per = grid.period || 0.5;
  const done = (segments, seams = []) => {
    const len = segments.reduce((s, g) => s + g.b - g.a, 0);
    const k = len / target;
    return { segments, length: len, speed: Math.abs(k - 1) <= 0.03 && Math.abs(k - 1) > 0.002 ? k : 1, seams };
  };
  if (Math.abs(delta) < 0.05) return done([{ a: 0, b: length }]);

  // the places it can jump: between bar starts (or beats, in a song too short for whole bars) that sound alike
  const T = grid.times, bf = beatFeatures(an, grid);
  const starts = (grid.bars && grid.bars.length >= 6 ? grid.bars : T.map((_, k) => k)).filter(k => T[k] >= keepIntro && T[k] <= length - keepOutro);
  const lengthen = delta > 0;
  const minRun = Math.max(2, per * 4 * runBars); // at least this many bars play between joins
  let edges = [];
  for (const x of starts) for (const y of starts) {
    if (x === y) continue;
    const p = T[x], q = T[y], jump = p - q; // what it adds (back) or takes away (forward)
    if (lengthen ? jump < Math.max(per * 4 * minJumpBars, 2) : -jump < per * 3) continue;
    if (!lengthen && -jump > -delta + per * 2) continue; // never skip more than is needed
    if (length - q < minRun) continue;
    const like = joinLikeness(bf, x, y, 8, FOCUS[focus] || FOCUS.both);
    if (like >= minLikeness) edges.push({ p, q, like, id: `${x}>${y}` });
  }
  edges.sort((a, b) => b.like - a.like);
  edges = edges.slice(0, 400);

  // the search: a few hundred partial plans at a time, each a list of jumps in playing order
  const want = delta;
  const big = edges.reduce((m, e) => Math.max(m, Math.abs(e.p - e.q)), 1);
  const ERR = 0.5;
  const finish = s => { const err = want - s.added; return s.score - ERR * (Math.abs(err) / per) ** 1.5; };
  let beam = [{ pos: 0, added: 0, score: 0, jumps: [] }];
  let bestDone = { ...beam[0], final: finish(beam[0]) };
  // the best that's a little long (played to the target and faded out there), for when none lands exactly
  const overScore = s => s.score - 0.03 * ((s.added - want) / per);
  let bestOver = beam[0].added >= want ? { ...beam[0], final: overScore(beam[0]) } : null;
  // other good arrangements that land on the target (Variations): the best few, each with its own set of joins
  const tol = Math.max(per * 2, Math.abs(want) * 0.03);
  const exacts = [];
  const maxJumps = Math.min(40, Math.ceil(Math.abs(want) / Math.max(per * 4, big * 0.5)) + 4);
  for (let level = 0; level < maxJumps && beam.length; level++) {
    const next = [];
    for (const s of beam) {
      for (const e of edges) {
        if (e.p < s.pos + (s.jumps.length ? minRun : keepIntro)) continue;
        const added = s.added + (e.p - e.q);
        // never skip more than is needed; play at most four bars more than needed (faded out on the target)
        if (lengthen ? added > want + per * 16 : added < want - per * 2) continue;
        let reuse = 0; for (const j of s.jumps) if (j.id === e.id) reuse++;
        const last = s.jumps[s.jumps.length - 1];
        // variety: playing the very stretch just repeated again, or the same join again, counts against it
        const again = last && Math.abs(last.q - e.q) < per && Math.abs(last.p - e.p) < per ? 0.35 : 0;
        const score = s.score + e.like - 1 - JUMP - 0.15 * reuse - again;
        next.push({ pos: e.q, added, score, jumps: [...s.jumps, e] });
      }
    }
    // keep the most promising: by score, less what the jumps still needed would cost
    const rank = s => s.score - JUMP * Math.ceil(Math.abs(want - s.added) / big) - 0.05 * (Math.abs(want - s.added) / per);
    next.sort((a, b) => rank(b) - rank(a));
    const seen = new Set();
    beam = [];
    for (const s of next) {
      const key = `${Math.round(s.pos / per)}|${Math.round(s.added / per)}`;
      if (seen.has(key)) continue;
      seen.add(key); beam.push(s);
      if (beam.length >= 160) break;
    }
    for (const s of beam) {
      const f = finish(s); if (f > bestDone.final) bestDone = { ...s, final: f };
      if (s.jumps.length && Math.abs(want - s.added) < tol) exacts.push({ ...s, final: f });
      if (s.added >= want) { const o = overScore(s); if (!bestOver || o > bestOver.final) bestOver = { ...s, final: o }; }
    }
  }

  // the variations: the best exact plans, each differing from those before it in at least one join
  exacts.sort((a, b) => b.final - a.final);
  const kinds = [];
  for (const e of exacts) {
    const sig = e.jumps.map(j => j.id).join(',');
    if (kinds.some(k => k.sig === sig)) continue;
    const ids = new Set(e.jumps.map(j => j.id));
    if (kinds.some(k => k.ids.size === ids.size && [...ids].every(x => k.ids.has(x)))) continue;
    kinds.push({ sig, ids, s: e });
    if (kinds.length >= 6) break;
  }
  const v = kinds.length ? ((Math.round(variation) % kinds.length) + kinds.length) % kinds.length : 0;
  const exact = kinds.length > 0;
  const pick = exact ? kinds[v].s : bestOver && (bestOver.jumps.length || !lengthen) ? bestOver : null;
  if (pick) {
    // each join lined up to the sample, crossfaded as briefly as it allows
    const segments = [], seams = [];
    let a = 0;
    for (const e of pick.jumps) {
      const j = alignJoin(an, e.p, e.q);
      segments.push({ a, b: e.p });
      const xf = j.match > 0.75 ? 0.04 : j.match > 0.5 ? 0.08 : 0.15;
      seams.push({ at: e.p, from: e.p, to: j.q, likeness: e.like, match: j.match, xf });
      a = j.q;
    }
    segments.push({ a, b: length });
    if (exact) return { ...done(segments, seams), variations: kinds.length, variation: v };
    // a little long: played to the target and faded out over its last bar or two
    const over = segments.reduce((t, g) => t + g.b - g.a, 0) - target;
    const last = segments[segments.length - 1];
    if (last.b - over > last.a + 1) {
      last.b -= over;
      return { ...done(segments, seams), fadeOut: Math.min(4, Math.max(1.5, per * 4)), trimmed: over };
    }
  }

  // nothing joins cleanly: the old way, with a longer crossfade (and the toast says to check the join)
  if (delta < 0) {
    const cut = Math.max(keepIntro, (length + delta) * 0.5);
    return done([{ a: 0, b: cut }, { a: cut - delta, b: length }], [{ at: cut, from: cut, to: cut - delta, likeness: 0, xf: 0.3 }]);
  }
  const s0 = Math.min(length - keepOutro - 1, keepIntro + 1), s1 = Math.max(s0 + 1, length - keepOutro);
  const loop = s1 - s0, k = Math.max(1, Math.ceil(delta / loop)), segs = [{ a: 0, b: s1 }], seams = [];
  for (let r = 1; r < k; r++) { segs.push({ a: s0, b: s1 }); seams.push({ at: s1, from: s1, to: s0, likeness: 0, xf: 0.3 }); }
  segs.push({ a: s0, b: length }); seams.push({ at: s1, from: s1, to: s0, likeness: 0, xf: 0.3 });
  return done(segs, seams);
}
