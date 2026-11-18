// Your ums, learned from your own voice. You record a few "umm"s and "uh"s (slow, normal, quick) and read one
// sentence; Reel turns each into a sound fingerprint (how its spectrum moves over time) and later compares short
// bursts of sound in your recordings against them. The sentence is your ordinary speech: it sets how close a burst
// has to be before it counts, so normal words aren't taken for ums. Pure functions; nothing leaves the Mac.
//
// Fingerprint: 16 kHz mono, 25 ms frames every 10 ms, 24 mel bands, 12 cepstral coefficients (MFCC without the
// loudness one, so a quiet um matches a loud one). Bursts are compared with
// dynamic time warping, so a slow um matches a quick one.

export const RATE = 16000;
const FRAME = 400, HOP = 160, NFFT = 512, BANDS = 24, COEFS = 12;

/** Mono samples at any rate, to 16 kHz (linear interpolation after a short box filter: fine for speech features). */
export function to16k(samples, rate) {
  if (rate === RATE) return samples;
  const k = rate / RATE, n = Math.floor(samples.length / k), out = new Float32Array(n), w = Math.max(1, Math.round(k));
  for (let i = 0; i < n; i++) {
    const c = i * k; let s = 0, m = 0;
    for (let j = Math.floor(c - w / 2); j <= Math.floor(c + w / 2); j++) if (j >= 0 && j < samples.length) { s += samples[j]; m++; }
    out[i] = m ? s / m : 0;
  }
  return out;
}

// ---------------------------------------------------------------- features
let melBank = null, hann = null, dct = null;
const mel = f => 2595 * Math.log10(1 + f / 700), imel = m => 700 * (10 ** (m / 2595) - 1);
function setup() {
  if (melBank) return;
  hann = new Float32Array(FRAME); for (let i = 0; i < FRAME; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));
  const lo = mel(60), hi = mel(7600), pts = Array.from({ length: BANDS + 2 }, (_, i) => imel(lo + ((hi - lo) * i) / (BANDS + 1)));
  const bin = f => Math.floor(((NFFT + 1) * f) / RATE);
  melBank = pts.slice(1, -1).map((_, b) => {
    const a = bin(pts[b]), c = bin(pts[b + 1]), d = bin(pts[b + 2]), w = new Float32Array(NFFT / 2 + 1);
    for (let i = a; i < c; i++) w[i] = (i - a) / Math.max(1, c - a);
    for (let i = c; i <= d; i++) w[i] = (d - i) / Math.max(1, d - c);
    return w;
  });
  dct = Array.from({ length: COEFS + 1 }, (_, k) => Float32Array.from({ length: BANDS }, (_, n) => Math.cos((Math.PI * k * (n + 0.5)) / BANDS)));
}
function fft(re, im) { // in place, radix 2
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j], ui = im[i + j], vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ur + vr; im[i + j] = ui + vi; re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/** The fingerprint of 16 kHz samples: an array of frames, each COEFS numbers, normalised over the burst. */
export function fingerprint(x) {
  setup();
  const frames = [];
  const re = new Float32Array(NFFT), im = new Float32Array(NFFT);
  for (let s = 0; s + FRAME <= x.length; s += HOP) {
    re.fill(0); im.fill(0);
    for (let i = 0; i < FRAME; i++) re[i] = (x[s + i] - (i ? 0.97 * x[s + i - 1] : 0)) * hann[i];
    fft(re, im);
    const pow = new Float32Array(NFFT / 2 + 1);
    for (let i = 0; i <= NFFT / 2; i++) pow[i] = re[i] * re[i] + im[i] * im[i];
    const logm = melBank.map(w => { let e = 0; for (let i = 0; i < w.length; i++) if (w[i]) e += w[i] * pow[i]; return Math.log(e + 1e-9); });
    const c = new Float32Array(COEFS);
    for (let k = 1; k <= COEFS; k++) { let v = 0; for (let n = 0; n < BANDS; n++) v += logm[n] * dct[k][n]; c[k - 1] = v; }
    frames.push(c);
  }
  // no per-burst normalisation: for a steady sound like "umm" it would remove the very shape that makes it an umm.
  // Loudness is already out (the first coefficient, overall level, isn't kept).
  return frames;
}

/** Dynamic time warping distance between two fingerprints, per step (so long and short bursts compare fairly). */
export function dtw(a, b) {
  const n = a.length, m = b.length;
  if (!n || !m) return Infinity;
  // a band keeps it quick and stops absurd stretches (one um can't be four times as long as another)
  const band = Math.max(Math.abs(n - m), Math.ceil(Math.max(n, m) * 0.5));
  let prev = new Float64Array(m + 1).fill(Infinity), cur = new Float64Array(m + 1);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    cur.fill(Infinity);
    const lo = Math.max(1, Math.floor((i * m) / n) - band), hi = Math.min(m, Math.ceil((i * m) / n) + band);
    for (let j = lo; j <= hi; j++) {
      let d = 0; const x = a[i - 1], y = b[j - 1];
      for (let k = 0; k < x.length; k++) d += (x[k] - y[k]) ** 2;
      cur[j] = Math.sqrt(d) + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m] / (n + m);
}

// ---------------------------------------------------------------- bursts
/**
 * Bursts of sound: stretches louder than the room, 0.12 to 1.6 seconds long, with a pause either side (so a burst
 * is something said on its own, like an um, not the middle of a sentence). Returns [{ a, b }] in samples.
 */
export function bursts(x, { rate = RATE, min = 0.12, max = 1.6, gap = 0.12, soft = false } = {}) {
  const win = Math.round(rate * 0.01), n = Math.floor(x.length / win), env = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = i * win; k < (i + 1) * win; k++) s += x[k] * x[k]; env[i] = Math.sqrt(s / win); }
  const sorted = Float32Array.from(env).sort();
  const floor = sorted[Math.floor(n * 0.1)] || 0, loud = sorted[Math.floor(n * 0.9)] || 0;
  // soft: a much lower bar, for soft sounds you taught (breaths) that never reach the bar for words
  const word = Math.max(floor * 3, floor + (loud - floor) * 0.12, 1e-4);
  const on = soft ? Math.max(floor * 1.6, floor + (loud - floor) * 0.03, 3e-5) : word;
  const runs = [];
  let s = -1, quiet = 0;
  const hold = Math.round((gap * rate) / win); // a run ends after this much quiet
  for (let i = 0; i <= n; i++) {
    const v = i < n ? env[i] : 0;
    // soft: where speech starts, a soft sound ends (a breath usually runs straight into the next word)
    if (soft && v >= word) { if (s >= 0) runs.push([s, i - quiet]); s = -1; quiet = 0; continue; }
    if (v >= on) { if (s < 0) s = i; quiet = 0; } else if (s >= 0 && ++quiet >= hold) { runs.push([s, i - quiet + 1]); s = -1; quiet = 0; }
  }
  if (s >= 0) runs.push([s, n - Math.max(0, quiet - 1)]); // a burst running to the very end (a short piece cut from a recording)
  return runs.filter(([a, b]) => (b - a) * win >= min * rate && (b - a) * win <= max * rate).map(([a, b]) => ({ a: a * win, b: b * win }));
}

// ---------------------------------------------------------------- training and matching
/**
 * Learns from your takes: { takes: [{ word, samples (16 kHz) }], speech: 16 kHz samples of you reading a sentence }.
 * Returns { version, words: [{ word, prints: [fingerprint] }], threshold } or throws with a plain reason.
 */
export function train({ takes, speech }) {
  const by = new Map();
  for (const t of takes) {
    const b = bursts(t.samples, { max: 2.5, gap: 0.2 }).sort((p, q) => (q.b - q.a) - (p.b - p.a))[0];
    const seg = b ? t.samples.subarray(b.a, b.b) : t.samples;
    const fp = fingerprint(seg);
    if (fp.length < 8) continue;
    if (!by.has(t.word)) by.set(t.word, []);
    by.get(t.word).push(fp);
  }
  const words = [...by].map(([word, prints]) => ({ word, prints }));
  if (!words.length || words.every(w => w.prints.length < 2)) throw new Error('Not enough was heard. Record each one again, a little louder and closer to the microphone.');
  return retune({ version: 1, words, nots: [], near: speech ? nearOf(words, speech) : null });
}

/** How close ordinary speech comes to the ums: every um-length stretch of it, a fifth of a second apart (5th percentile). */
function nearOf(words, speech) {
  const near = [], step = Math.round(RATE * 0.2), len = Math.round(RATE * 0.45);
  for (let a = 0; a + len <= speech.length; a += step) {
    const fp = fingerprint(speech.subarray(a, a + len));
    if (fp.length >= 8) near.push(score({ words }, fp).d);
  }
  near.sort((a, b) => a - b);
  return near.length ? near[Math.floor(near.length * 0.05)] : null;
}

/** The threshold from how far your ums are from each other (they should match) and how close ordinary speech comes. */
export function retune(m) {
  const same = [];
  for (const w of m.words) for (let i = 0; i < w.prints.length; i++) for (let j = i + 1; j < w.prints.length; j++) same.push(dtw(w.prints[i], w.prints[j]));
  same.sort((a, b) => a - b);
  const sameHi = same.length ? same[Math.min(same.length - 1, Math.floor(same.length * 0.9))] : null;
  const nearLo = m.near ?? (sameHi ? sameHi * 1.6 : 1.2);
  const s = sameHi ?? nearLo * 0.6; // one take of each: a margin under ordinary speech
  // between the two: closer to your ums than nearly all ordinary speech
  m.threshold = nearLo > s ? s + (nearLo - s) * 0.45 : Math.min(s, nearLo) * 0.95;
  // never stricter than your own takes are with each other: if the ums you taught can't find each other, the ones in
  // your recordings won't be found either (the old way of keeping "ordinary speech" could squeeze it under that)
  if (sameHi != null) m.threshold = Math.max(m.threshold, sameHi);
  m.same = s;
  return m;
}

/** The burst inside a short piece of sound (an um cut from a recording, with a little air either side). */
function burstOf(x) {
  const b = bursts(x, { max: 2.5, gap: 0.2 }).sort((p, q) => (q.b - q.a) - (p.b - p.a))[0];
  return b ? x.subarray(b.a, b.b) : x;
}

/**
 * One more um to learn from (from the microphone, or cut from a recording, e.g. a guest's): word ('umm' / 'uh' …),
 * 16 kHz samples, and optionally some of the same person's ordinary speech around it (sets how strict to be when
 * there's no sentence yet). Starts a model if there isn't one. Returns the model.
 */
/**
 * What a sound looks like on the waveform: its loudness from start to end, in n steps, the loudest 1 (so a long
 * steady "ummm" is a plateau, an "uh" a quick hump, a breath a soft swell, speech a row of peaks).
 */
export function waveShape(x, n = 24) {
  if (!x || x.length < n * 4) return null;
  const out = [], step = x.length / n;
  for (let i = 0; i < n; i++) { let s = 0; const a = Math.floor(i * step), b = Math.floor((i + 1) * step); for (let k = a; k < b; k++) s += x[k] * x[k]; out.push(Math.sqrt(s / Math.max(1, b - a))); }
  const top = Math.max(...out) || 1;
  return out.map(v => +(v / top).toFixed(3));
}
/** How unlike two waveform shapes are (0 the same … 1 nothing alike): the mean gap between them. */
export function shapeDist(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}
/** Whether a piece's waveform looks like one of the takes of a sound (when any were taken with their shape). */
export function shapeFits(word, x) {
  const shapes = (word?.shapes || []).filter(Boolean);
  if (!shapes.length) return true;
  const me = waveShape(trimQuiet(x));
  if (!me) return true;
  // how far apart your own takes are, with room; at least 0.16
  let spread = 0;
  for (let i = 0; i < shapes.length; i++) for (let j = i + 1; j < shapes.length; j++) spread = Math.max(spread, shapeDist(shapes[i], shapes[j]));
  const bar = Math.max(0.16, spread * 1.25 + 0.04);
  return shapes.some(s => shapeDist(s, me) <= bar);
}

export function addTake(model, word, samples, context, { exact = false } = {}) {
  // exact: the piece is just the sound (marked by hand on the timeline): only its quiet ends come off. Looking for a
  // "burst" in it would take a piece of the word next to it when there's no pause between them
  const piece = exact ? trimQuiet(samples) : burstOf(samples);
  const fp = fingerprint(piece);
  if (fp.length < 8) throw new Error('Too short to learn from: pick the whole um, with a little silence either side.');
  const m = model || { version: 1, words: [], nots: [], near: null };
  let w = m.words.find(x => x.word === word);
  if (!w) m.words.push(w = { word, prints: [] });
  w.prints.push(fp);
  // and how it looks on the waveform (kept beside its sound: the same take, the same place in the list)
  w.shapes = [...(w.shapes || Array(w.prints.length - 1).fill(null)), waveShape(piece)];
  // how close ordinary speech comes: the middle of what each teaching's surroundings said (it used to keep the
  // lowest ever, so every um taught made Reel stricter and it found fewer, not more)
  if (context?.length) {
    const n = nearOf(m.words, context);
    if (n != null) {
      m.nears = [...(m.nears || (m.near != null ? [m.near] : [])), n].slice(-40);
      const s = [...m.nears].sort((a, b) => a - b);
      m.near = s[Math.floor(s.length / 2)];
    }
  }
  return retune(m);
}

/** The sound with its quiet ends taken off (below a tenth of its loudest 10 ms). */
export function trimQuiet(x) {
  const win = Math.round(RATE * 0.01), n = Math.floor(x.length / win);
  if (n < 3) return x;
  const env = Array.from({ length: n }, (_, i) => { let s = 0; for (let k = i * win; k < (i + 1) * win; k++) s += x[k] * x[k]; return Math.sqrt(s / win); });
  const top = Math.max(...env), bar = top * 0.1;
  let a = 0, b = n;
  while (a < n - 1 && env[a] < bar) a++;
  while (b > a + 1 && env[b - 1] < bar) b--;
  return x.subarray(Math.max(0, a - 2) * win, Math.min(n, b + 2) * win);
}

/**
 * Takes back what was learned: the last `n` takes of one sound (Infinity: all of it, so the sound is forgotten), or
 * with word 'not' the last `n` "not an um" sounds. Returns the model (retuned), or null when nothing is left.
 */
export function dropTakes(model, word, n = 1) {
  if (!model) return null;
  const m = { ...model, words: model.words.map(w => ({ ...w, prints: w.prints.slice() })), nots: (model.nots || []).slice() };
  if (word === 'not') m.nots.splice(Math.max(0, m.nots.length - n));
  else {
    const w = m.words.find(x => x.word === word);
    if (w) { w.prints.splice(Math.max(0, w.prints.length - n)); if (w.shapes) w.shapes = w.shapes.slice(0, w.prints.length); if (!w.prints.length) m.words = m.words.filter(x => x !== w); }
  }
  if (!m.words.length) return null;
  return retune(m);
}

/** Something it took for an um that isn't one: it won't be matched again (nor anything closer to it than to an um). */
export function addNot(model, samples) {
  const fp = fingerprint(burstOf(samples));
  if (fp.length >= 8) (model.nots ||= []).push(fp);
  return model;
}

/** How close a fingerprint is to your ums: { word, d } (the nearest take). */
export function score(model, fp) {
  // d: the nearest take of any sound (how sure it is an um at all). word: the sound whose nearest few takes are
  // nearest on average, so one stray take of "uh" doesn't call an "umm" an "uh"
  let d = Infinity, word = null, wbest = Infinity;
  for (const w of model.words) {
    const ds = w.prints.map(p => dtw(fp, p)).sort((a, b) => a - b);
    if (!ds.length) continue;
    d = Math.min(d, ds[0]);
    const k = ds.slice(0, 3), avg = k.reduce((s, v) => s + v, 0) / k.length;
    if (avg < wbest) { wbest = avg; word = w.word; }
  }
  return { word, d };
}

/**
 * Your ums in 16 kHz samples: bursts that match the model. Returns [{ t, end, word, d, sure }] in seconds from the
 * start of the samples; sure when well inside the threshold.
 */
export function findInSamples(model, x) {
  const out = [];
  for (const { a, b } of bursts(x)) {
    const fp = fingerprint(x.subarray(a, b));
    if (fp.length < 8) continue;
    const s = score(model, fp);
    // nearer something you said isn't an um than to any um: not one
    const no = (model.nots || []).reduce((d, p) => Math.min(d, dtw(fp, p)), Infinity);
    if (s.d <= model.threshold && !(no < s.d)) out.push({ t: a / RATE, end: b / RATE, word: s.word, d: s.d, sure: s.d <= model.threshold * 0.85 });
  }
  // your own sounds (breath, sneeze…) can be far quieter than words: listen again with a lower bar, for those only
  // (so a soft syllable is never taken for an um), where nothing was found already
  const own = model.words.filter(w => w.word !== 'umm' && w.word !== 'uh');
  if (own.length) {
    const sub = { ...model, words: own };
    for (const { a, b } of bursts(x, { soft: true })) {
      if (out.some(h => h.t < b / RATE && h.end > a / RATE)) continue;
      const fp = fingerprint(x.subarray(a, b));
      if (fp.length < 8) continue;
      const s = score(sub, fp);
      const no = (model.nots || []).reduce((d, p) => Math.min(d, dtw(fp, p)), Infinity);
      if (s.d <= model.threshold && !(no < s.d)) out.push({ t: a / RATE, end: b / RATE, word: s.word, d: s.d, sure: s.d <= model.threshold * 0.85 });
    }
    out.sort((p, q) => p.t - q.t);
  }
  return out;
}

/**
 * Your sounds said straight into the next word (no pause either side, so never a "burst"): every one of your takes
 * is slid along the recording's fingerprint (dynamic time warping with a free start and end), and where one fits as
 * closely as your ums fit each other it's a hit. Returns [{ t, end, word, d, sure }] in seconds, not overlapping.
 */
export function findInSequence(model, x, { strict = 0.9 } = {}) {
  const F = fingerprint(x), n = F.length;
  if (n < 8 || !model?.words?.length) return [];
  // where there's sound at all (the quiet between sentences isn't searched)
  const loud = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = i * HOP; k < i * HOP + FRAME && k < x.length; k++) s += x[k] * x[k]; loud[i] = Math.sqrt(s / FRAME); }
  const sorted = Float32Array.from(loud).sort(), floor = sorted[Math.floor(n * 0.1)] || 0, top = sorted[Math.floor(n * 0.95)] || 0;
  const on = Math.max(floor * 2.5, floor + (top - floor) * 0.1, 1e-4);
  const thr = model.threshold * strict, cands = [];
  for (const w of model.words) {
    // the most recent takes (up to 12) of each sound
    for (const P of w.prints.slice(-12)) {
      const m = P.length;
      if (m < 8) continue;
      // each of the take's frames matched to one frame of the recording, in order, the recording moving on one or two
      // frames a step or (never twice running) staying put: every path adds up the same number of frames, so their
      // costs compare fairly and a short stretch isn't favoured. Row by row: the cost arriving by a step on (N) or by
      // staying put (V), and where the path started
      const INF = Infinity;
      let pN = new Float64Array(n), pV = new Float64Array(n), pS = new Int32Array(n), pSV = new Int32Array(n);
      let cN = new Float64Array(n), cV = new Float64Array(n), cS = new Int32Array(n), cSV = new Int32Array(n);
      const dist = (i, j) => { const p = P[i], f = F[j]; let dd = 0; for (let k = 0; k < p.length; k++) { const v = p[k] - f[k]; dd += v * v; } return Math.sqrt(dd); };
      for (let jj = 0; jj < n; jj++) { pN[jj] = dist(0, jj); pS[jj] = jj; pV[jj] = INF; pSV[jj] = jj; }
      for (let i = 1; i < m; i++) {
        for (let jj = 0; jj < n; jj++) {
          const dij = dist(i, jj);
          let c = INF, st = jj;
          for (const q of [jj - 1, jj - 2]) {
            if (q < 0) continue;
            if (pN[q] < c) { c = pN[q]; st = pS[q]; }
            if (pV[q] < c) { c = pV[q]; st = pSV[q]; }
          }
          cN[jj] = dij + c; cS[jj] = st;
          cV[jj] = dij + pN[jj]; cSV[jj] = pS[jj];
        }
        [pN, cN] = [cN, pN]; [pV, cV] = [cV, pV]; [pS, cS] = [cS, pS]; [pSV, cSV] = [cSV, pSV];
      }
      const norm = new Float64Array(n).fill(INF), from = new Int32Array(n);
      for (let jj = 0; jj < n; jj++) { const useV = pV[jj] < pN[jj]; norm[jj] = (useV ? pV[jj] : pN[jj]) / m; from[jj] = useV ? pSV[jj] : pS[jj]; }
      // where it fits best (the lowest points), checked with the same measure your takes were compared with
      for (let jj = 0; jj < n; jj++) {
        if (!isFinite(norm[jj])) continue;
        let isMin = true;
        for (let k = Math.max(0, jj - 5); k <= Math.min(n - 1, jj + 5) && isMin; k++) if (norm[k] < norm[jj]) isMin = false;
        if (!isMin) continue;
        const a = from[jj], b = jj + 1;
        if (b - a < 8) continue;
        // mostly sound, not the quiet around it
        let lit = 0; for (let k = a; k < b; k++) if (loud[k] >= on) lit++;
        if (lit < (b - a) * 0.6) continue;
        const d = dtw(F.slice(a, b), P);
        if (d <= thr) cands.push({ a, b, d, word: w.word });
      }
    }
  }
  // the best first; one per stretch of sound
  cands.sort((p, q) => p.d - q.d);
  const out = [];
  for (const c of cands) {
    if (out.some(o => o.a < c.b && o.b > c.a)) continue;
    const t = (c.a * HOP) / RATE, end = (c.b * HOP + FRAME) / RATE;
    if (end - t < 0.12 || end - t > 1.6) continue;
    // nearer something you said isn't an um than to any um: not one
    const fp = F.slice(c.a, c.b);
    const no = (model.nots || []).reduce((dmin, q) => Math.min(dmin, dtw(fp, q)), Infinity);
    if (no < c.d) continue;
    const s = score(model, fp);
    out.push({ a: c.a, b: c.b, t, end, word: s.word || c.word, d: c.d, sure: c.d <= model.threshold * 0.7 });
  }
  return out.sort((p, q) => p.t - q.t).map(({ t, end, word, d, sure }) => ({ t, end, word, d, sure, joined: true }));
}

/** A model made safe to store as JSON (fingerprints as plain arrays) and back. */
const packPrint = p => p.map(f => Array.from(f, v => Math.round(v * 1000) / 1000));
const readPrint = p => p.filter(Array.isArray).map(f => Float32Array.from(f.slice(0, COEFS).map(Number)));
export const packModel = m => JSON.stringify({ ...m, nears: m.nears || undefined, words: m.words.map(w => ({ word: w.word, prints: w.prints.map(packPrint), ...(w.shapes?.some(Boolean) ? { shapes: w.shapes } : {}) })), nots: (m.nots || []).map(packPrint) });
export function unpackModel(s) {
  try {
    const m = typeof s === 'string' ? JSON.parse(s) : s;
    if (!m || m.version !== 1 || !Array.isArray(m.words) || !(m.threshold > 0)) return null;
    m.words = m.words.filter(w => typeof w.word === 'string' && Array.isArray(w.prints)).map(w => {
      const prints = w.prints.filter(Array.isArray).map(readPrint);
      const shapes = Array.isArray(w.shapes) ? w.shapes.slice(0, prints.length).map(s => (Array.isArray(s) && s.every(Number.isFinite) ? s : null)) : null;
      return { word: w.word.slice(0, 20), prints, ...(shapes?.some(Boolean) ? { shapes } : {}) };
    });
    m.nots = Array.isArray(m.nots) ? m.nots.filter(Array.isArray).map(readPrint) : [];
    return m.words.length ? m : null;
  } catch { return null; }
}
