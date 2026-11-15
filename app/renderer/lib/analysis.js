// A sound source's waveform peaks and loudness profile: the arithmetic peaks-worker.js and levels-worker.js
// use, in one place, so the Rust core (native/reel-core/src/analyze.rs) can be checked against it.
// A source is { rate, channels, frames, read(start, count) → [Float32Array per channel] } (lib/sources.js).
import { Biquad } from './master.js';

export const PEAK_RATE = 100;

/** Waveform peaks: 100 a second, 0..1, square-rooted so quiet speech still shows. */
export async function peaksOf(a) {
  const per = Math.max(1, Math.round(a.rate / PEAK_RATE));
  const total = a.frames ?? Math.ceil((a.track ? a.track.duration : 0) * a.rate);
  const n = Math.ceil(total / per);
  const data = new Float32Array(n);
  const CH = per * 2000;
  for (let start = 0, k = 0; start < total; start += CH) {
    const pcm = await a.read(start, Math.min(CH, total - start));
    const len = pcm[0].length;
    for (let i = 0; i < len; i += per, k++) {
      let v = 0;
      for (const ch of pcm) for (let j = i; j < Math.min(len, i + per); j++) { const x = Math.abs(ch[j]); if (x > v) v = x; }
      if (k < n) data[k] = Math.min(1, Math.sqrt(v));
    }
  }
  return { rate: PEAK_RATE, data };
}

/** Loudness profile for AUTO MIX: the K-weighted mean square of every 100 ms (ITU-R BS.1770 weighting). */
export async function levelsOf(a) {
  const rate = a.rate, step = Math.round(rate * 0.1);
  const total = a.frames ?? Math.ceil((a.track ? a.track.duration : 0) * rate);
  const ch = Math.min(2, a.channels || 1);
  const filters = [];
  for (let k = 0; k < ch; k++) {
    const pre = new Biquad(), rlb = new Biquad();
    pre.set('highshelf', 1681.97, 0.7072, 3.9998, rate); rlb.set('highpass', 38.135, 0.5003, 0, rate);
    filters.push([pre, rlb]);
  }
  const steps = new Float32Array(Math.ceil(total / step));
  let acc = 0, count = 0, k = 0;
  const CH = step * 300;
  for (let start = 0; start < total; start += CH) {
    const pcm = await a.read(start, Math.min(CH, total - start));
    const len = pcm[0].length;
    const w = [];
    for (let c = 0; c < ch; c++) { const x = Float32Array.from(pcm[c] || pcm[0]); filters[c][0].run(x, 0); filters[c][1].run(x, 0); w.push(x); }
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < ch; c++) s += w[c][i] * w[c][i];
      acc += s;
      if (++count === step) { if (k < steps.length) steps[k++] = acc / step; acc = 0; count = 0; }
    }
  }
  if (count && k < steps.length) steps[k++] = acc / count;
  return { step: 0.1, steps };
}
