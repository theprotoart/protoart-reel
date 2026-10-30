// Reel's repair modules in the RX tradition, on top of its own STFT (spectral-dsp.js): De-plosive, De-wind,
// Mouth De-click, De-ess, Breath Control, Dialogue Isolate, Spectral Recovery, Ambience Match, the Pattern and
// Partials + Noise repair modes, and Find Similar Event. Written for Reel; nothing here is taken from iZotope.
// Each process works on Float32Array channels in place, over the edit's time range (or the whole clip).
import { fft, hann, rasterize, N_DEFAULT } from './spectral-dsp.js';

export const db2 = d => 10 ** (d / 20);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Time range of an edit's selection in seconds (whole clip when there's none). */
export function editRange(edit, len, rate) {
  const s = edit.sel?.shapes || [];
  if (!s.length) return [0, len / rate];
  let a = Infinity, z = -Infinity;
  for (const x of s) {
    if (x.kind === 'freq') return [0, len / rate];
    const t0 = x.t0 ?? Math.min(...x.pts.map(p => p[0] - (x.rt || 0))), t1 = x.t1 ?? Math.max(...x.pts.map(p => p[0] + (x.rt || 0)));
    a = Math.min(a, t0); z = Math.max(z, t1);
  }
  return [Math.max(0, a), Math.min(len / rate, z)];
}

/** Magnitude analysis of every frame in [i0, i1): calls fn(i, mags) (mags reused between calls). */
export function analyse(x, N, H, i0, i1, fn) {
  const win = hann(N), re = new Float64Array(N), im = new Float64Array(N), bins = N / 2 + 1, mags = new Float32Array(bins), len = x.length;
  for (let i = i0; i < i1; i++) {
    const c = i * H - N / 2;
    for (let n = 0; n < N; n++) { const q = c + n; re[n] = (q >= 0 && q < len ? x[q] : 0) * win[n]; im[n] = 0; }
    fft(re, im);
    for (let b = 0; b < bins; b++) mags[b] = Math.hypot(re[b], im[b]);
    fn(i, mags);
  }
}

/**
 * Rebuilds frames i0..i1 of x after fn(i, re, im) has changed each spectrum (full complex arrays, length N).
 * Like applyEdit: everything outside is untouched, everything inside is rebuilt from a full set of frames.
 */
export function resynth(x, N, H, i0, i1, fn) {
  const win = hann(N), re = new Float64Array(N), im = new Float64Array(N), len = x.length;
  // a window's worth of extra frames either side; Hann² overlap-adds to 3N/8 per hop
  const ov = Math.ceil(N / H), norm = (3 * N) / 8 / H;
  const a = i0 - ov, z = i1 + ov, nF = z - a, s0 = a * H - N / 2, out = new Float32Array(nF * H + N);
  for (let k = 0; k < nF; k++) {
    const i = a + k, c = i * H - N / 2;
    for (let n = 0; n < N; n++) { const q = c + n; re[n] = (q >= 0 && q < len ? x[q] : 0) * win[n]; im[n] = 0; }
    fft(re, im);
    if (i >= i0 && i < i1) fn(i, re, im);
    fft(re, im, true);
    for (let n = 0; n < N; n++) out[k * H + n] += (re[n] * win[n]) / norm;
  }
  const safe0 = Math.max(0, s0 + N - H), safe1 = Math.min(len, s0 + nF * H);
  for (let q = safe0; q < safe1; q++) x[q] = out[q - s0];
}
export const scaleBin = (re, im, N, b, v) => { re[b] *= v; im[b] *= v; if (b > 0 && b < N / 2) { re[N - b] *= v; im[N - b] *= v; } };
export const mix = chans => { if (chans.length === 1) return chans[0]; const m = new Float32Array(chans[0].length); for (const c of chans) for (let i = 0; i < m.length; i++) m[i] += c[i] / chans.length; return m; };
/** Smooth a per-frame gain curve: fast attack, slower release (in frames). */
export function smoothGains(g, att, rel) { let s = 1; for (let i = 0; i < g.length; i++) { const k = g[i] < s ? att : rel; s = s + (g[i] - s) / Math.max(1, k); g[i] = s; } for (let i = g.length - 2; i >= 0; i--) g[i] = Math.min(g[i], g[i + 1] + (1 - g[i + 1]) / Math.max(1, att)); return g; }

// ------------------------------------------------------------------ De-plosive
/** Short low-frequency bursts ("p", "b", pops, mic thumps): their low end is pulled down to its surroundings. */
export function deplosive(chans, rate, ed) {
  const N = 2048, H = 256, bins = N / 2 + 1, limit = ed.limit ?? 200, sens = ed.sensitivity ?? 0.5, strength = ed.strength ?? 1;
  const [t0, t1] = editRange(ed, chans[0].length, rate), i0 = Math.floor((t0 * rate) / H), i1 = Math.ceil((t1 * rate) / H) + 1;
  const bLim = Math.ceil((limit * N) / rate), x = mix(chans), lf = new Float32Array(i1 - i0), hf = new Float32Array(i1 - i0);
  analyse(x, N, H, i0, i1, (i, m) => { let a = 0, b = 0; for (let q = 1; q <= bLim; q++) a += m[q] * m[q]; for (let q = bLim + 1; q < bins; q++) b += m[q] * m[q]; lf[i - i0] = a; hf[i - i0] = b; });
  // a plosive: low end jumps far above its own running median (and well above the rest of the spectrum)
  const W = Math.round((0.4 * rate) / H), ratio = 30 - sens * 26, gainLF = new Float32Array(lf.length).fill(1);
  for (let k = 0; k < lf.length; k++) {
    const win = []; for (let j = Math.max(0, k - W); j < Math.min(lf.length, k + W); j++) win.push(lf[j]);
    win.sort((p, q) => p - q); const med = win[win.length >> 1] + 1e-12;
    if (lf[k] > med * ratio && lf[k] > hf[k] * (0.6 - sens * 0.5)) gainLF[k] = clamp(Math.sqrt((med * ratio * 0.5) / lf[k]), 0, 1);
  }
  smoothGains(gainLF, 2, Math.round((0.06 * rate) / H));
  let hits = 0; for (let k = 1; k < gainLF.length; k++) if (gainLF[k] < 0.7 && gainLF[k - 1] >= 0.7) hits++;
  for (const c of chans) resynth(c, N, H, i0, i1, (i, re, im) => {
    const g0 = gainLF[i - i0]; if (g0 > 0.999) return;
    const g = 1 - strength * (1 - g0);
    for (let q = 0; q <= bLim * 1.6; q++) { const u = q <= bLim ? 1 : 1 - (q - bLim) / (bLim * 0.6); scaleBin(re, im, N, q, 1 - u * (1 - g)); }
  });
  return { fixed: hits };
}

// ------------------------------------------------------------------ De-wind
/** Gusty low-frequency noise: each low bin is held near its own steady level, so bursts are flattened. */
export function dewind(chans, rate, ed) {
  const N = 2048, H = 512, cutoff = ed.cutoff ?? 300, strength = ed.strength ?? 0.8, smooth = ed.smoothing ?? 0.5;
  const [t0, t1] = editRange(ed, chans[0].length, rate), i0 = Math.floor((t0 * rate) / H), i1 = Math.ceil((t1 * rate) / H) + 1;
  const bc = Math.ceil((cutoff * 1.4 * N) / rate), nF = i1 - i0;
  for (const c of chans) {
    const M = new Float32Array(nF * bc);
    analyse(c, N, H, i0, i1, (i, m) => { for (let q = 0; q < bc; q++) M[(i - i0) * bc + q] = m[q]; });
    // steady level per bin: a low percentile over ~1 s around each frame (wind sits above it in gusts)
    const W = Math.round((0.6 * rate) / H), ref = new Float32Array(nF * bc), tmp = [];
    for (let q = 0; q < bc; q++) for (let k = 0; k < nF; k++) {
      tmp.length = 0; for (let j = Math.max(0, k - W); j < Math.min(nF, k + W); j += 2) tmp.push(M[j * bc + q]);
      tmp.sort((a, b) => a - b); ref[k * bc + q] = tmp[Math.floor(tmp.length * 0.3)] || 0;
    }
    const prev = new Float32Array(bc).fill(1);
    resynth(c, N, H, i0, i1, (i, re, im) => {
      const k = i - i0;
      for (let q = 1; q < bc; q++) {
        const f = (q * rate) / N, cur = M[k * bc + q] + 1e-12, target = ref[k * bc + q] * 1.4;
        let g = cur > target ? target / cur : 1;
        const tilt = f <= cutoff ? 1 : 1 - (f - cutoff) / (cutoff * 0.4); // fade out above the cutoff
        g = 1 - strength * tilt * (1 - g);
        g = prev[q] = prev[q] * smooth + g * (1 - smooth);
        scaleBin(re, im, N, q, g);
      }
    });
  }
  return {};
}

// ------------------------------------------------------------------ Mouth De-click
/** Small, sharp high-frequency ticks (lip smacks, tongue clicks): found, widened and rebuilt from around them. */
export function mouthDeclick(chans, rate, ed, heal) {
  const sens = ed.sensitivity ?? 0.5, skew = ed.skew ?? 0, widen = (ed.widen ?? 1) / 1000;
  const [t0, t1] = editRange(ed, chans[0].length, rate), x = mix(chans);
  // a high-passed copy (2-pole, ~1.5–4 kHz depending on skew) shows the ticks
  const fc = 2500 * 2 ** skew, w = (2 * Math.PI * fc) / rate, al = Math.sin(w) / (2 * 0.707), a0 = 1 + al;
  const b0 = (1 + Math.cos(w)) / 2 / a0, b1 = -(1 + Math.cos(w)) / a0, a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - al) / a0;
  const a = Math.max(2, Math.floor(t0 * rate)), z = Math.min(x.length - 2, Math.ceil(t1 * rate));
  const hp = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = a; i < z; i++) { const y = b0 * x[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = y; hp[i] = y; }
  const win = Math.round(rate * 0.02), sq = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) sq[i + 1] = sq[i] + hp[i] * hp[i];
  const rms = i => Math.sqrt((sq[Math.min(x.length, i + win)] - sq[Math.max(0, i - win)]) / (2 * win) + 1e-14);
  const thr = 9 - sens * 5.5, maxLen = Math.round(rate * 0.006), spans = [];
  for (let i = a; i < z; i++) {
    if (Math.abs(hp[i]) <= thr * rms(i)) continue;
    let j = i; while (j < z && j - i < maxLen && Math.abs(hp[j]) > thr * 0.35 * rms(i)) j++;
    if (j - i < maxLen) spans.push([i / rate - widen, j / rate + widen]);
    i = j + Math.round(rate * 0.003);
  }
  if (!spans.length) return { fixed: 0 };
  // rebuild each tick (above ~800 Hz, where the voice's body isn't) from the sound around it
  // a click spreads over every analysis window that contains it, so each repair covers half a window either side
  const N = rate > 32000 ? 512 : 256, half = (0.5 * N) / rate;
  const shapes = spans.map(([s, e]) => ({ kind: 'rect', t0: Math.max(0, s - half), t1: e + half, f0: 800 * 2 ** skew, f1: rate / 2 }));
  heal(chans, rate, { op: 'heal', surround: 0.03, strength: 1, sel: { shapes, featherT: 0, featherOct: 0.2 } }, { N });
  return { fixed: spans.length };
}

// ------------------------------------------------------------------ De-ess
/** Level of a half spectrum's energy, in dB relative to full scale (Hann window, size N). */
export const energyDb = (e, N) => 10 * Math.log10(e / ((3 * N * N) / 16) + 1e-14);
/**
 * Sibilance above the cutoff. Classic: the whole ess band is turned down by how far it rises over the threshold.
 * Spectral: only the bins standing above the band's average are pulled down to it (flattens the ess, keeps air).
 */
export function deess(chans, rate, ed) {
  const N = 1024, H = 256, bins = N / 2 + 1, cutoff = ed.cutoff ?? 5000, thr = ed.threshold ?? -30, spectral = ed.algorithm === 'spectral';
  const speed = ed.speed === 'slow' ? 4 : 1;
  const [t0, t1] = editRange(ed, chans[0].length, rate), i0 = Math.floor((t0 * rate) / H), i1 = Math.ceil((t1 * rate) / H) + 1;
  const bc = Math.floor((cutoff * N) / rate), x = mix(chans), nF = i1 - i0, band = new Float32Array(nF), body = new Float32Array(nF);
  analyse(x, N, H, i0, i1, (i, m) => { let a = 0, b = 0; for (let q = bc; q < bins; q++) a += m[q] * m[q]; for (let q = 3; q < bc; q++) b += m[q] * m[q]; band[i - i0] = a; body[i - i0] = b; });
  // an ess: the band is over the threshold (and isn't a negligible part of the frame)
  const g = new Float32Array(nF);
  for (let k = 0; k < nF; k++) {
    const over = energyDb(band[k], N) - thr, share = band[k] / (band[k] + body[k] + 1e-14);
    g[k] = over > 0 && share > 0.03 ? db2(-Math.min(30, over)) : 1;
  }
  smoothGains(g, speed, speed * 5);
  let n = 0; for (let k = 1; k < nF; k++) if (g[k] < 0.8 && g[k - 1] >= 0.8) n++;
  for (const c of chans) resynth(c, N, H, i0, i1, (i, re, im) => {
    const gk = g[i - i0]; if (gk > 0.999) return;
    let mean = 0; if (spectral) { for (let q = bc; q < bins; q++) mean += Math.hypot(re[q], im[q]); mean /= bins - bc; }
    for (let q = Math.max(1, bc - 4); q < bins; q++) {
      const ramp = q < bc ? (q - (bc - 4)) / 4 : 1;
      let v = 1 - ramp * (1 - gk);
      if (spectral) { const mg = Math.hypot(re[q], im[q]) + 1e-12; v = mg > mean ? 1 - ramp * (1 - Math.max(gk, mean / mg)) : 1; }
      scaleBin(re, im, N, q, v);
    }
  });
  return { fixed: n };
}

// ------------------------------------------------------------------ Breath Control
/** Breaths: noisy, unpitched sounds well under the speech level, turned down by a gain or to a target level. */
export function debreath(chans, rate, ed) {
  const N = 2048, H = 512, sens = ed.sensitivity ?? 0.5, mode = ed.mode || 'gain', gainDb = ed.gain ?? -12, target = ed.target ?? -45;
  const [t0, t1] = editRange(ed, chans[0].length, rate), i0 = Math.floor((t0 * rate) / H), i1 = Math.ceil((t1 * rate) / H) + 1, nF = i1 - i0;
  const x = mix(chans), lvl = new Float32Array(nF), flat = new Float32Array(nF), hiShare = new Float32Array(nF);
  const b1 = Math.floor((1000 * N) / rate), b6 = Math.min(N / 2, Math.floor((7000 * N) / rate)), b0 = Math.max(1, Math.floor((100 * N) / rate));
  analyse(x, N, H, i0, i1, (i, m) => {
    let e = 0, lg = 0, hi = 0, cnt = 0;
    for (let q = b0; q < b6; q++) { const v = m[q] * m[q] + 1e-14; e += v; lg += Math.log(v); cnt++; if (q >= b1) hi += v; }
    lvl[i - i0] = energyDb(e, N); flat[i - i0] = Math.exp(lg / cnt) / (e / cnt); hiShare[i - i0] = hi / e;
  });
  // speech level: a high percentile; breaths sit 10–45 dB under it, noise-like (flat) and mostly above 1 kHz
  const sorted = Array.from(lvl).sort((a, b) => a - b), speech = sorted[Math.floor(sorted.length * 0.9)] ?? -20;
  const isBreath = new Uint8Array(nF), flatMin = 0.3 - sens * 0.2;
  for (let k = 0; k < nF; k++) isBreath[k] = lvl[k] < speech - 10 && lvl[k] > speech - 45 && flat[k] > flatMin && hiShare[k] > 0.55 - sens * 0.2 ? 1 : 0;
  // breaths last 150 ms or more: shorter blips are left alone
  const minF = Math.round((0.15 * rate) / H), g = new Float32Array(nF).fill(1);
  let n = 0;
  for (let k = 0; k < nF;) {
    if (!isBreath[k]) { k++; continue; }
    let j = k; while (j < nF && isBreath[j]) j++;
    if (j - k >= minF) { n++; for (let q = k; q < j; q++) g[q] = mode === 'target' ? Math.min(1, db2(target - lvl[q])) : db2(gainDb); }
    k = j;
  }
  smoothGains(g, 3, 3);
  for (const c of chans) resynth(c, N, H, i0, i1, (i, re, im) => {
    const v = g[i - i0]; if (v > 0.999) return;
    for (let q = 0; q < N; q++) { re[q] *= v; im[q] *= v; }
  });
  return { fixed: n };
}

/**
 * Noise floor per bin and frame (power), tracked without a LEARN step: the minimum of a smoothed spectrum over
 * ±1.5 s (minimum statistics), so it follows changing noise even while someone is talking.
 */
export function noiseFloor(c, N, H, i0, i1, rate, span = 1.5) {
  const bins = N / 2 + 1, nF = i1 - i0, P = new Float32Array(nF * bins), sm = new Float32Array(bins);
  analyse(c, N, H, i0, i1, (i, m) => { const k = i - i0; for (let q = 0; q < bins; q++) { sm[q] = k ? sm[q] * 0.7 + m[q] * m[q] * 0.3 : m[q] * m[q]; P[k * bins + q] = sm[q]; } });
  const W = Math.round((span * rate) / H), floor = new Float32Array(nF * bins), dq = new Int32Array(nF + 2 * W + 2);
  for (let q = 0; q < bins; q++) {
    // running minimum over ±W frames (monotonic queue: linear time however long the clip)
    let h = 0, t = 0;
    for (let j = 0; j < nF + W; j++) {
      if (j < nF) { const v = P[j * bins + q]; while (t > h && P[dq[t - 1] * bins + q] >= v) t--; dq[t++] = j; }
      const k = j - W; if (k < 0) continue;
      while (dq[h] < k - W) h++;
      floor[k * bins + q] = P[dq[h] * bins + q] * 3; // the minimum of a noisy level sits well under its mean
    }
  }
  return floor;
}

// ------------------------------------------------------------------ Dialogue Isolate
/** Voice kept, background turned down: a per-bin speech-presence mask over a running noise estimate. */
export function dialogueIsolate(chans, rate, ed) {
  const N = 2048, H = 512, bins = N / 2 + 1, bg = db2(ed.background ?? -18), dlg = db2(ed.dialogue ?? 0), sens = ed.sensitivity ?? 0.5;
  const [t0, t1] = editRange(ed, chans[0].length, rate), i0 = Math.floor((t0 * rate) / H), i1 = Math.ceil((t1 * rate) / H) + 1;
  for (const c of chans) {
    const floor = noiseFloor(c, N, H, i0, i1, rate);
    const lo = Math.floor((70 * N) / rate), hi = Math.ceil((9000 * N) / rate), prev = new Float32Array(bins).fill(1), over = 1 + (1 - sens) * 3;
    // six band trims on the background level (DNS-style faders): <150, 150–400, 400–1k, 1–2.5k, 2.5–6k, >6k Hz
    const edges = [150, 400, 1000, 2500, 6000], bgq = new Float32Array(bins);
    for (let q = 0; q < bins; q++) { const f = (q * rate) / N, b = edges.findIndex(e => f < e); bgq[q] = bg * db2(ed[`band${(b < 0 ? 5 : b) + 1}`] || 0); }
    resynth(c, N, H, i0, i1, (i, re, im) => {
      const k = i - i0;
      for (let q = 0; q < bins; q++) {
        const pw = re[q] * re[q] + im[q] * im[q] + 1e-18, snr = Math.max(0, pw / (floor[k * bins + q] * over + 1e-18) - 1);
        let gq = q < lo || q > hi ? bgq[q] : Math.max(bgq[q], snr / (1 + snr)); // Wiener-style gain, voice band only
        gq = prev[q] = prev[q] * 0.5 + gq * 0.5;
        scaleBin(re, im, N, q, gq * dlg);
      }
    });
  }
  return {};
}

// ------------------------------------------------------------------ Spectral Recovery
/** Missing top end (phone, Zoom, low-bitrate files): the cutoff is found and the highs are rebuilt from the band below. */
export function spectralRecovery(chans, rate, ed) {
  const N = 2048, H = 512, bins = N / 2 + 1, amount = ed.amount ?? 0.6, nyq = rate / 2;
  const [t0, t1] = editRange(ed, chans[0].length, rate), i0 = Math.floor((t0 * rate) / H), i1 = Math.ceil((t1 * rate) / H) + 1;
  const x = mix(chans), avg = new Float64Array(bins); let n = 0;
  analyse(x, N, H, i0, i1, (i, m) => { if ((i - i0) % 3) return; for (let q = 0; q < bins; q++) avg[q] += m[q]; n++; });
  for (let q = 0; q < bins; q++) avg[q] = 20 * Math.log10(avg[q] / Math.max(1, n) + 1e-12);
  // cutoff: the highest frequency still within 30 dB of the median level of 300 Hz – 3 kHz
  const ref = Array.from(avg.slice(Math.floor((300 * N) / rate), Math.floor((3000 * N) / rate))).sort((a, b) => a - b), med = ref[ref.length >> 1];
  let bc = bins - 1; while (bc > 10 && avg[bc] < med - 30) bc--;
  const fc = (bc * rate) / N;
  if (fc > nyq * 0.9 || fc < 1500) return { cutoff: Math.round(fc), fixed: 0 };
  const targetB = Math.min(bins - 1, Math.round(((ed.bandwidth ?? 20000) * N) / rate)), span = Math.max(4, Math.floor(bc / 2));
  for (const c of chans) resynth(c, N, H, i0, i1, (i, re, im) => {
    // copy the octave below the cutoff upward, falling off 6 dB per octave, with the band's own envelope
    for (let q = bc + 1; q <= targetB; q++) {
      const src = bc - span + ((q - bc - 1) % span), oct = Math.log2(q / bc), g = amount * db2(-6 * oct - 3);
      const ph = Math.atan2(im[src], re[src]) + q * 0.37, mg = Math.hypot(re[src], im[src]) * g;
      re[q] = mg * Math.cos(ph); im[q] = mg * Math.sin(ph);
      if (q < N / 2) { re[N - q] = re[q]; im[N - q] = -im[q]; }
    }
  });
  return { cutoff: Math.round(fc), fixed: 1 };
}

// ------------------------------------------------------------------ Ambience Match
/** Learned room tone: generated with the same spectrum, either filling the selection or the quiet gaps of the clip. */
export function ambience(chans, rate, ed) {
  const N = 2048, H = 512, bins = N / 2 + 1, prof = ed.profile, level = db2(ed.level ?? 0), mode = ed.mode || 'fill';
  if (!prof) throw new Error('Learn the ambience first');
  const [t0, t1] = editRange(ed, chans[0].length, rate), i0 = Math.floor((t0 * rate) / H), i1 = Math.ceil((t1 * rate) / H) + 1;
  let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 * Math.PI;
  const mask = mode === 'fill' && ed.sel ? rasterize(ed.sel, { rate, N, H, frames: Math.ceil(chans[0].length / H) + 1 }) : null;
  // the profile holds average magnitudes (√(π/4) of the RMS for noise), and frames with random phases only add up in
  // power, so overlap-add keeps H/N of it: both are made up here so the generated tone matches the learned room
  const fix = Math.sqrt(N / H) * Math.sqrt(4 / Math.PI), rms = Math.sqrt(4 / Math.PI);
  let pe = 0; for (let q = 1; q < bins; q++) pe += (prof[q] * rms) ** 2;
  let n = 0;
  for (const c of chans) resynth(c, N, H, i0, i1, (i, re, im) => {
    let e = 0; for (let q = 1; q < bins; q++) e += re[q] * re[q] + im[q] * im[q];
    // fill: replace the selection with ambience; gaps: add ambience only where the clip falls below the room tone
    const quiet = mode === 'gaps' ? clamp(1 - Math.sqrt(e / (pe * level * level + 1e-18)), 0, 1) : 1;
    if (quiet <= 0.001) return;
    if (c === chans[0]) n++;
    for (let q = 1; q < bins; q++) {
      const m = mask ? mask.get(i, q) : 1, w = (mode === 'fill' ? m : quiet) * (ed.strength ?? 1);
      if (w <= 0) continue;
      const ph = rnd(), a = prof[q] * fix * level * w;
      if (mode === 'fill') { re[q] *= 1 - w; im[q] *= 1 - w; }
      re[q] += a * Math.cos(ph); im[q] += a * Math.sin(ph);
      if (q < N / 2) { re[N - q] = re[q]; im[N - q] = -im[q]; }
    }
  });
  return { fixed: n };
}

// ------------------------------------------------------------------ Pattern / Partials + Noise (Spectral Repair modes)
/**
 * Pattern: the selection is replaced by the stretch (within the search range) whose surroundings look most like
 * the selection's surroundings: good for repeating sounds, music and rhythmic noise.
 */
export function pattern(chans, rate, ed) {
  const N = 2048, H = 512, bins = N / 2 + 1, frames = Math.ceil(chans[0].length / H) + 1;
  const mask = rasterize(ed.sel, { rate, N, H, frames });
  if (mask.i1 <= mask.i0) return {};
  const ctx = Math.max(4, Math.round(((ed.surround ?? 0.25) * rate) / H)), range = Math.round(((ed.searchRange ?? 4) * rate) / H), L = mask.i1 - mask.i0;
  const x = mix(chans), lo = Math.max(0, mask.i0 - range - ctx), hi = Math.min(frames, mask.i1 + range + ctx);
  const M = new Float32Array((hi - lo) * 32), bandOf = q => Math.min(31, Math.floor(Math.log2(1 + (q * 31) / bins) * 6.3));
  analyse(x, N, H, lo, hi, (i, m) => { for (let q = 1; q < bins; q++) M[(i - lo) * 32 + bandOf(q)] += Math.log(1 + m[q]); });
  const dist = (a, b, n) => { let s = 0; for (let k = 0; k < n; k++) for (let j = 0; j < 32; j++) { const d = M[(a + k - lo) * 32 + j] - M[(b + k - lo) * 32 + j]; s += d * d; } return s; };
  let best = null, bestD = Infinity;
  for (let s = lo + ctx; s + L + ctx <= hi; s++) {
    if (s + L + ctx > mask.i0 - ctx && s - ctx < mask.i1 + ctx) continue; // must not overlap the hole or its edges
    const d = dist(mask.i0 - ctx, s - ctx, ctx) + dist(mask.i1, s + L, ctx);
    if (d < bestD) { bestD = d; best = s; }
  }
  if (best === null) return {};
  const off = best - mask.i0;
  // copy the matching stretch's spectra into the hole (blended by the feathered mask)
  for (const c of chans) {
    const donor = new Map();
    analyseComplex(c, N, H, mask.i0 + off, mask.i1 + off, (i, re, im) => donor.set(i - off, [Float32Array.from(re.subarray(0, bins)), Float32Array.from(im.subarray(0, bins))]));
    resynth(c, N, H, mask.i0, mask.i1, (i, re, im) => {
      const d = donor.get(i); if (!d) return;
      for (let q = mask.b0; q < mask.b1; q++) {
        const w = mask.get(i, q) * (ed.strength ?? 1); if (w <= 0) continue;
        re[q] = re[q] * (1 - w) + d[0][q] * w; im[q] = im[q] * (1 - w) + d[1][q] * w;
        if (q > 0 && q < N / 2) { re[N - q] = re[q]; im[N - q] = -im[q]; }
      }
    });
  }
  return { fixed: 1, from: (best * H) / rate };
}
export function analyseComplex(x, N, H, i0, i1, fn) {
  const win = hann(N), re = new Float64Array(N), im = new Float64Array(N), len = x.length;
  for (let i = i0; i < i1; i++) { const c = i * H - N / 2; for (let n = 0; n < N; n++) { const q = c + n; re[n] = (q >= 0 && q < len ? x[q] : 0) * win[n]; im[n] = 0; } fft(re, im); fn(i, re, im); }
}

/**
 * Partials + Noise: the noise underneath is healed from both sides, then every tone (partial) found before the hole
 * is fitted exactly (frequency, level and phase, on both sides) and synthesised straight across it: frequency and
 * level glide from one side to the other and the phase lands on the far side's, so it joins without a seam.
 */
export function partials(chans, rate, ed, heal) {
  const N = 4096, H = 1024, bins = N / 2 + 1, len = chans[0].length, frames = Math.ceil(len / H) + 1;
  const mask = rasterize(ed.sel, { rate, N, H, frames });
  if (mask.i1 <= mask.i0) return {};
  const [t0, t1] = editRange(ed, len, rate), g0 = Math.round(t0 * rate), g1 = Math.round(t1 * rate), fitN = Math.round(rate * 0.04);
  const thr = db2(ed.harmonicThreshold ?? 12), fLo = (mask.b0 * rate) / N, fHi = (mask.b1 * rate) / N;
  heal(chans, rate, { ...ed, op: 'heal' }, { N: 2048 });
  /** Least-squares fit of a sinusoid at f to x[a..a+n): amplitude and phase at sample a. */
  const fit = (x, f, a, n) => {
    let cc = 0, ss = 0, cs = 0, xc = 0, xs = 0; const w = (2 * Math.PI * f) / rate;
    for (let k = 0; k < n; k++) { const q = a + k; if (q < 0 || q >= len) continue; const c = Math.cos(w * k), s = Math.sin(w * k); cc += c * c; ss += s * s; cs += c * s; xc += x[q] * c; xs += x[q] * s; }
    const det = cc * ss - cs * cs || 1, A = (xc * ss - xs * cs) / det, B = (xs * cc - xc * cs) / det; // x ≈ A cos + B sin
    return { amp: Math.hypot(A, B), ph: Math.atan2(-B, A) };
  };
  let found = 0;
  for (const x of chans) {
    // tones before the hole: spectral peaks (parabolic interpolation for the exact frequency)
    let mags = null; analyse(x, N, H, mask.i0 - 2, mask.i0 - 1, (i, m) => { mags = Float32Array.from(m); });
    const tones = [];
    for (let q = 3; q < bins - 3; q++) {
      const v = mags[q]; if (!(v > mags[q - 1] && v >= mags[q + 1])) continue;
      let s2 = 0, n = 0; for (let j = q - 24; j <= q + 24; j += 2) if (j > 0 && j < bins && Math.abs(j - q) > 3) { s2 += mags[j]; n++; }
      if (v < (s2 / n) * thr || v < 1e-5 * N) continue;
      const la = Math.log(mags[q - 1] + 1e-12), lb = Math.log(v), lc = Math.log(mags[q + 1] + 1e-12), d = (0.5 * (la - lc)) / (la - 2 * lb + lc || 1e-9);
      const f = ((q + d) * rate) / N; if (f >= fLo && f <= fHi) tones.push(f);
    }
    if (!tones.length) continue;
    found += tones.length;
    // each tone: fitted just before and just after the hole, then drawn across it into a separate buffer
    const a0 = Math.max(0, g0 - N), a1 = Math.min(len, g1 + N), syn = new Float32Array(len);
    for (const f of tones) {
      const pre = fit(x, f, g0 - fitN, fitN), post = fit(x, f, g1, fitN);
      const ph0 = pre.ph + (2 * Math.PI * f * fitN) / rate; // phase at g0
      // the frequency is nudged (by under a cycle over the hole) so the phase arrives where the far side has it
      const gap = g1 - g0, natural = ph0 + (2 * Math.PI * f * gap) / rate;
      let dph = post.ph - natural; dph -= 2 * Math.PI * Math.round(dph / (2 * Math.PI));
      const f2 = f + (dph * rate) / (2 * Math.PI * Math.max(1, gap)) * (post.amp > pre.amp * 0.1 ? 1 : 0);
      for (let q = a0; q < a1; q++) {
        const u = clamp((q - g0) / Math.max(1, gap), 0, 1), amp = pre.amp + (post.amp - pre.amp) * u;
        const ph = q < g0 ? ph0 + (2 * Math.PI * f * (q - g0)) / rate : q <= g1 ? ph0 + (2 * Math.PI * f2 * (q - g0)) / rate : ph0 + (2 * Math.PI * f2 * gap) / rate + (2 * Math.PI * f * (q - g1)) / rate;
        syn[q] += amp * Math.cos(ph);
      }
    }
    // the synthesised tones replace those frequencies inside the selection (the healed noise stays everywhere else)
    const win = hann(N), sr = new Float64Array(N), si = new Float64Array(N), near = new Uint8Array(bins);
    for (const f of tones) { const q = Math.round((f * N) / rate); for (let j = q - 4; j <= q + 4; j++) if (j > 0 && j < bins) near[j] = 1; }
    resynth(x, N, H, mask.i0, mask.i1, (i, re, im) => {
      const c = i * H - N / 2; for (let n = 0; n < N; n++) { const q = c + n; sr[n] = (q >= 0 && q < len ? syn[q] : 0) * win[n]; si[n] = 0; }
      fft(sr, si);
      for (let q = 1; q < bins; q++) {
        if (!near[q]) continue;
        const w = mask.get(i, q) * (ed.strength ?? 1); if (w <= 0) continue;
        re[q] = re[q] * (1 - w) + sr[q] * w; im[q] = im[q] * (1 - w) + si[q] * w;
        if (q < N / 2) { re[N - q] = re[q]; im[N - q] = -im[q]; }
      }
    });
  }
  return { fixed: found ? 1 : 0, partials: found };
}

// ------------------------------------------------------------------ Find Similar Event
/**
 * Finds other sounds like the selected one: a fingerprint of the selection (24 log bands over its frames, in its
 * frequency range) is slid along the clip; every place above the similarity (0..1) is returned as a time range.
 */
export function findSimilar(chans, rate, sel, { similarity = 0.8, range = Infinity } = {}) {
  const N = 1024, H = 256, bins = N / 2 + 1, len = chans[0].length, frames = Math.ceil(len / H) + 1;
  const mask = rasterize(sel, { rate, N, H, frames });
  const L = mask.i1 - mask.i0; if (L < 2) return [];
  const B = 24, b0 = Math.max(1, mask.b0), b1 = Math.max(b0 + 2, mask.b1), x = mix(chans);
  const bandOf = q => Math.min(B - 1, Math.floor(((q - b0) / (b1 - b0)) * B));
  const lo = Number.isFinite(range) ? Math.max(0, mask.i0 - Math.round((range * rate) / H)) : 0, hi = Number.isFinite(range) ? Math.min(frames, mask.i1 + Math.round((range * rate) / H)) : frames;
  const F = new Float32Array((hi - lo) * B);
  analyse(x, N, H, lo, hi, (i, m) => { const o = (i - lo) * B; for (let q = b0; q < b1; q++) F[o + bandOf(q)] += m[q]; for (let j = 0; j < B; j++) F[o + j] = Math.log(1 + F[o + j]); });
  const vec = s => { const v = new Float32Array(L * B); for (let k = 0; k < L; k++) for (let j = 0; j < B; j++) v[k * B + j] = F[(s + k - lo) * B + j]; let mu = 0; for (const a of v) mu += a; mu /= v.length; let n = 0; for (let k = 0; k < v.length; k++) { v[k] -= mu; n += v[k] * v[k]; } n = Math.sqrt(n) || 1; for (let k = 0; k < v.length; k++) v[k] /= n; return v; };
  const ref = vec(mask.i0), hits = [];
  for (let s = lo; s + L <= hi; s++) {
    if (s > mask.i0 - L && s < mask.i1) continue;
    const v = vec(s); let r = 0; for (let k = 0; k < v.length; k++) r += v[k] * ref[k];
    if (r >= similarity) hits.push({ s, r });
  }
  // keep the best of each cluster of overlapping matches
  hits.sort((a, b) => b.r - a.r);
  const keep = [];
  for (const h of hits) if (!keep.some(k => Math.abs(k.s - h.s) < L)) keep.push(h);
  return keep.sort((a, b) => a.s - b.s).map(h => ({ offset: ((h.s - mask.i0) * H) / rate, score: h.r }));
}

// ------------------------------------------------------------------ dispatch
export const RX_OPS = { deplosive, dewind, mouthdeclick: mouthDeclick, deess, debreath, dialogue: dialogueIsolate, recovery: spectralRecovery, ambience, pattern, partials };
const EXTRA = {}; // the restoration modules register here (spectral-restore.js imports this file, not the other way round)
export const registerOps = ops => Object.assign(EXTRA, ops);
/**
 * Runs any edit: these modules, the restoration ones, or the core ones in spectral-dsp.js (passed in to keep the
 * imports one-way). ctx.orig is the untouched sound, for Revert.
 */
export function runEdit(chans, rate, ed, applyEdit, ctx = {}) {
  const f = RX_OPS[ed.op] || EXTRA[ed.op];
  if (!f) return applyEdit(chans, rate, ed);
  const heal = (c, r, e, o) => applyEdit(c, r, e, o);
  return (EXTRA[ed.op] && ed.op === 'revert' ? f(chans, rate, ed, ctx) : f(chans, rate, ed, heal)) || {};
}
