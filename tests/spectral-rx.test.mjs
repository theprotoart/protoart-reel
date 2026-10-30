// The RX-style repair modules: each one checked on a synthetic sound built to have exactly that problem.
import test from 'node:test';
import assert from 'node:assert';
import { applyEdit, learnProfile } from '../app/renderer/spectral-dsp.js';
import { runEdit, findSimilar } from '../app/renderer/spectral-rx.js';

const rate = 16000, S = s => Math.round(s * rate);
const run = (x, ed) => { const ch = [x]; const r = runEdit(ch, rate, ed, applyEdit); return { y: ch[0], r }; };
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
const noise = (n, a) => Float32Array.from({ length: n }, () => a * rnd());
const tone = (f, n, a, ph = 0) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / rate + ph));
const lowpass = (x, fc) => { const k = 1 - Math.exp((-2 * Math.PI * fc) / rate), y = new Float32Array(x.length); let a = 0, b = 0; for (let i = 0; i < x.length; i++) { a += k * (x[i] - a); b += k * (a - b); y[i] = b; } return y; };
const highpass = (x, fc) => { const l = lowpass(x, fc); return x.map((v, i) => v - l[i]); };
const addAt = (x, y, at) => { for (let i = 0; i < y.length && at + i < x.length; i++) x[at + i] += y[i]; return x; };
const rms = (x, a, z) => { let s = 0; for (let i = a; i < z; i++) s += x[i] * x[i]; return Math.sqrt(s / (z - a)); };
const dB = v => 20 * Math.log10(v + 1e-12);
/** Level of frequency f around sample a (Hann-windowed single-bin DFT). */
const level = (x, f, a, n = 1024) => { let re = 0, im = 0; for (let i = 0; i < n; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); re += x[a + i] * w * Math.cos((2 * Math.PI * f * i) / rate); im += x[a + i] * w * Math.sin((2 * Math.PI * f * i) / rate); } return Math.hypot(re, im) / (n / 4); };

test('De-plosive pulls a low thump down and leaves the voice band alone', () => {
  const x = tone(1000, S(3), 0.2);
  addAt(x, tone(70, S(0.06), 0.8).map((v, i, a) => v * Math.sin((Math.PI * i) / a.length)), S(1.5));
  const before = rms(lowpass(x, 150), S(1.5), S(1.56));
  const { y, r } = run(x.slice(), { op: 'deplosive', sensitivity: 0.6, strength: 1, limit: 200 });
  assert.ok(r.fixed >= 1, 'found the plosive');
  assert.ok(dB(rms(lowpass(y, 150), S(1.5), S(1.56))) < dB(before) - 6, 'thump at least 6 dB down');
  assert.ok(Math.abs(dB(level(y, 1000, S(0.5))) - dB(level(x, 1000, S(0.5)))) < 0.5, 'the 1 kHz tone is untouched');
});

test('De-plosive leaves a sound with no plosives as it was', () => {
  const x = tone(1000, S(2), 0.2).map((v, i) => v + 0.1 * Math.sin((2 * Math.PI * 120 * i) / rate));
  const { y } = run(x.slice(), { op: 'deplosive', sensitivity: 0.5 });
  let d = 0; for (let i = S(0.2); i < S(1.8); i++) d = Math.max(d, Math.abs(y[i] - x[i]));
  assert.ok(d < 1e-3, `max change ${d}`);
});

test('De-wind flattens low gusts and keeps the tone above the cutoff', () => {
  const n = S(4), wind = lowpass(noise(n, 1), 120).map((v, i) => v * (Math.sin((2 * Math.PI * 0.7 * i) / rate) > 0.6 ? 6 : 0.5));
  const x = tone(1500, n, 0.2).map((v, i) => v + wind[i]);
  const { y } = run(x.slice(), { op: 'dewind', cutoff: 300, strength: 1, smoothing: 0.3 });
  const gust = [S(0.25), S(0.45)]; // sin(2π·0.7·t) > 0.6 around t ≈ 0.36 s
  assert.ok(dB(rms(lowpass(y, 200), ...gust)) < dB(rms(lowpass(x, 200), ...gust)) - 4, 'gust turned down');
  assert.ok(Math.abs(dB(level(y, 1500, S(2))) - dB(level(x, 1500, S(2)))) < 1, '1.5 kHz kept');
});

test('Mouth De-click repairs short ticks', () => {
  const x = tone(220, S(2), 0.3);
  const at = [0.4, 0.9, 1.3].map(S);
  for (const a of at) addAt(x, Float32Array.from({ length: 12 }, (_, i) => (i % 2 ? -0.5 : 0.5) * (1 - i / 12)), a);
  const hf = y => at.reduce((s, a) => s + rms(highpass(y, 3000), a - 20, a + 40), 0);
  const { y, r } = run(x.slice(), { op: 'mouthdeclick', sensitivity: 0.6, skew: 0, widen: 1 });
  assert.ok(r.fixed >= 3, `found ${r.fixed}`);
  assert.ok(dB(hf(y)) < dB(hf(x)) - 10, 'clicks at least 10 dB down');
});

test('De-ess turns sibilance down only where it happens', () => {
  const x = tone(200, S(3), 0.3);
  addAt(x, highpass(noise(S(0.15), 0.5), 4500), S(1.2));
  const { y, r } = run(x.slice(), { op: 'deess', cutoff: 4000, threshold: -40, algorithm: 'classic' });
  assert.ok(r.fixed >= 1);
  assert.ok(dB(rms(highpass(y, 4000), S(1.23), S(1.32))) < dB(rms(highpass(x, 4000), S(1.23), S(1.32))) - 6, 'ess down 6 dB or more');
  assert.ok(Math.abs(dB(level(y, 200, S(2.2))) - dB(level(x, 200, S(2.2)))) < 0.5, 'the rest untouched');
});

test('Breath Control lowers breaths between voiced phrases', () => {
  const voice = n => Float32Array.from({ length: n }, (_, i) => [1, 2, 3, 4].reduce((s, k) => s + (0.3 / k) * Math.sin((2 * Math.PI * 180 * k * i) / rate), 0));
  const x = new Float32Array(S(4));
  addAt(x, voice(S(1.2)), 0); addAt(x, highpass(noise(S(0.4), 0.06), 900), S(1.4)); addAt(x, voice(S(1.6)), S(2));
  const { y, r } = run(x.slice(), { op: 'debreath', sensitivity: 0.5, mode: 'gain', gain: -15 });
  assert.ok(r.fixed >= 1, 'found the breath');
  assert.ok(dB(rms(y, S(1.5), S(1.7))) < dB(rms(x, S(1.5), S(1.7))) - 10, 'breath ~15 dB down');
  assert.ok(Math.abs(dB(rms(y, S(0.3), S(1))) - dB(rms(x, S(0.3), S(1)))) < 0.5, 'voice untouched');
});

test('Dialogue Isolate turns steady background down and keeps the voice', () => {
  const n = S(4), x = noise(n, 0.05);
  addAt(x, tone(300, S(1), 0.3), S(1.5));
  const { y } = run(x.slice(), { op: 'dialogue', background: -20, dialogue: 0, sensitivity: 0.5 });
  assert.ok(dB(rms(y, S(0.3), S(1.2))) < dB(rms(x, S(0.3), S(1.2))) - 8, 'background at least 8 dB down');
  assert.ok(Math.abs(dB(level(y, 300, S(2))) - dB(level(x, 300, S(2)))) < 2, 'voice kept within 2 dB');
});

test('Spectral Recovery finds the cutoff and rebuilds the top end', () => {
  // a low-bitrate / phone-style file: everything above 3 kHz cut off
  const ch = [lowpass(noise(S(3), 0.5), 2500)];
  applyEdit(ch, rate, { op: 'remove', sel: { shapes: [{ kind: 'freq', f0: 3000, f1: 8000 }] } });
  const x = ch[0], { y, r } = run(x.slice(), { op: 'recovery', amount: 0.8 });
  assert.ok(r.cutoff > 1500 && r.cutoff < 6000, `cutoff ${r.cutoff}`);
  const highs = z => [5000, 5600, 6200, 6800].reduce((s, f) => s + level(z, f, S(1)) + level(z, f, S(1.6)), 0);
  assert.ok(dB(highs(y)) > dB(highs(x)) + 20, `highs ${dB(highs(x)).toFixed(0)} → ${dB(highs(y)).toFixed(0)} dB`);
});

test('Ambience Match fills a dead gap with matching room tone', () => {
  const x = lowpass(noise(S(4), 0.1), 2000);
  for (let i = S(2); i < S(2.5); i++) x[i] = 0;
  const profile = Array.from(learnProfile([x], rate, 0.2, 1.5));
  const { y } = run(x.slice(), { op: 'ambience', profile, mode: 'gaps', level: 0 });
  const room = rms(x, S(0.5), S(1.5)), filled = rms(y, S(2.1), S(2.4));
  assert.ok(Math.abs(dB(filled) - dB(room)) < 3, `filled ${dB(filled).toFixed(1)} vs room ${dB(room).toFixed(1)} dB`);
  assert.ok(Math.abs(dB(rms(y, S(0.5), S(1.5))) - dB(room)) < 1, 'the rest stays the same level');
});

test('Pattern repair fills a hole from the matching part of a repeating sound', () => {
  const beat = S(0.5), x = new Float32Array(S(6));
  for (let k = 0; k < 12; k++) addAt(x, tone(600, S(0.1), 0.5), k * beat);
  for (let i = S(3); i < S(3.1); i++) x[i] = 0; // a beat is lost
  const { y } = run(x.slice(), { op: 'pattern', searchRange: 2.5, surround: 0.3, sel: { shapes: [{ kind: 'time', t0: 2.98, t1: 3.12 }] } });
  assert.ok(level(y, 600, S(3) + 200, 1024) > 0.5 * level(x, 600, S(2.5) + 200, 1024), 'the missing beat is back');
});

test('Partials + Noise carries a tone across a gap', () => {
  const x = tone(440, S(2), 0.4);
  for (let i = S(1); i < S(1.15); i++) x[i] = 0;
  const { y } = run(x.slice(), { op: 'partials', harmonicThreshold: 12, sel: { shapes: [{ kind: 'time', t0: 0.99, t1: 1.16 }] } });
  assert.ok(level(y, 440, S(1.02), 1024) > 0.5 * 0.4, `tone level in the gap ${level(y, 440, S(1.02), 1024).toFixed(2)}`);
});

test('Find Similar Event finds the other copies of a sound', () => {
  const x = noise(S(6), 0.01), at = [0.5, 1.7, 2.9, 4.4];
  for (const t of at) addAt(x, tone(2000, S(0.08), 0.5).map((v, i) => v * Math.sin((Math.PI * i) / S(0.08))), S(t));
  addAt(x, tone(400, S(0.3), 0.5), S(3.5)); // a different sound: not a match
  const hits = findSimilar([x], rate, { shapes: [{ kind: 'time', t0: 0.48, t1: 0.6 }] }, { similarity: 0.8 });
  const times = hits.map(h => 0.48 + h.offset);
  for (const t of at.slice(1)) assert.ok(times.some(u => Math.abs(u - (t - 0.02)) < 0.05), `found ${t}: ${times.map(v => v.toFixed(2))}`);
  assert.ok(!times.some(u => u > 3.3 && u < 3.9), 'the different sound is not a match');
});
