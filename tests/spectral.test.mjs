// Spectral editing maths: perfect reconstruction outside edits, and each edit doing what it says.
import test from 'node:test';
import assert from 'node:assert';
import { fft, applyEdit, rasterize, declick, fToY, yToF } from '../app/renderer/spectral-dsp.js';

const rate = 16000;
const tone = (f, dur, amp = 0.5) => { const x = new Float32Array(Math.round(dur * rate)); for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / rate); return x; };
const add = (a, b) => a.map((v, i) => v + (b[i] || 0));
const rms = (x, a = 0, z = x.length) => { let s = 0; for (let i = a; i < z; i++) s += x[i] * x[i]; return Math.sqrt(s / (z - a)); };
/** Level of frequency f in x[a..a+N): a single-bin DFT. */
const level = (x, f, a, n = 2048) => { let re = 0, im = 0; for (let i = 0; i < n; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); re += x[a + i] * w * Math.cos((2 * Math.PI * f * i) / rate); im += x[a + i] * w * Math.sin((2 * Math.PI * f * i) / rate); } return Math.hypot(re, im) / (n / 4); };

test('FFT round trip', () => {
  const re = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i) + i / 10), im = new Float64Array(64), r0 = re.slice();
  fft(re, im); fft(re, im, true);
  for (let i = 0; i < 64; i++) assert.ok(Math.abs(re[i] - r0[i]) < 1e-9);
});

test('a 0 dB gain over everything gives the input back (perfect reconstruction, ends included)', () => {
  const x = add(tone(440, 2), tone(3000, 2, 0.2)), y = x.slice();
  applyEdit([y], rate, { op: 'gain', db: 0.0001, sel: { shapes: [{ kind: 'time', t0: 0, t1: 2 }] } });
  let worst = 0; for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(x[i] - y[i]));
  assert.ok(worst < 1e-3, `worst ${worst}`);
});

test('remove a box: that tone goes, the other stays, outside the box untouched', () => {
  const x = add(tone(500, 3), tone(4000, 3, 0.3)), y = x.slice();
  applyEdit([y], rate, { op: 'remove', sel: { shapes: [{ kind: 'rect', t0: 1, t1: 2, f0: 3000, f1: 5000 }] } });
  const mid = Math.round(1.4 * rate);
  assert.ok(level(y, 4000, mid) < 0.01 * level(x, 4000, mid), 'the 4 kHz tone is gone inside');
  assert.ok(Math.abs(level(y, 500, mid) / level(x, 500, mid) - 1) < 0.02, 'the 500 Hz tone is kept');
  const early = Math.round(0.2 * rate);
  for (let i = 0; i < early; i++) assert.strictEqual(y[i], x[i], 'bit-exact before the edit');
});

test('heal fills a gap from both sides; attenuate pulls a spike down to its surroundings', () => {
  const x = tone(1000, 3, 0.4);
  for (let i = Math.round(1.4 * rate); i < Math.round(1.6 * rate); i++) x[i] *= 0.05; // a dropout
  const y = x.slice();
  applyEdit([y], rate, { op: 'heal', sel: { shapes: [{ kind: 'rect', t0: 1.38, t1: 1.62, f0: 700, f1: 1400 }] } });
  const at = Math.round(1.45 * rate);
  assert.ok(level(y, 1000, at) > 5 * level(x, 1000, at), 'the dropout is filled back in');
  const s = tone(1000, 3, 0.1);
  for (let i = Math.round(1.4 * rate); i < Math.round(1.6 * rate); i++) s[i] *= 8; // a loud burst
  const z = s.slice();
  applyEdit([z], rate, { op: 'attenuate', sel: { shapes: [{ kind: 'rect', t0: 1.38, t1: 1.62, f0: 700, f1: 1400 }] } });
  assert.ok(level(z, 1000, at) < 0.35 * level(s, 1000, at), 'the burst is pulled down');
});

test('isolate keeps only the selection; harmonics repeat a box at 2f, 3f', () => {
  const x = add(add(tone(300, 2), tone(600, 2, 0.3)), tone(5000, 2, 0.3)), y = x.slice();
  applyEdit([y], rate, { op: 'isolate', sel: { shapes: [{ kind: 'rect', t0: 0, t1: 2, f0: 250, f1: 350 }], harmonics: 2, invert: false } });
  const at = Math.round(0.8 * rate);
  assert.ok(level(y, 300, at) > 0.9 * level(x, 300, at) && level(y, 600, at) > 0.9 * level(x, 600, at), 'fundamental and 2nd harmonic kept');
  assert.ok(level(y, 5000, at) < 0.01 * level(x, 5000, at), 'everything else removed');
});

test('lasso and brush selections cover what they enclose, with feathered edges', () => {
  const frames = 200, opts = { rate, N: 2048, H: 512, frames };
  const m = rasterize({ shapes: [{ kind: 'poly', pts: [[1, 500], [3, 500], [3, 2000], [1, 2000]] }], featherT: 0.1, featherOct: 0.25 }, opts);
  const i = Math.round((2 * rate) / 512), bIn = Math.round((1000 * 2048) / rate), bOut = Math.round((4000 * 2048) / rate);
  assert.ok(m.get(i, bIn) > 0.99 && m.get(i, bOut) === 0);
  const edge = m.get(Math.round((1 * rate) / 512), bIn); assert.ok(edge > 0 && edge < 1, 'soft at the edge');
  const br = rasterize({ shapes: [{ kind: 'brush', pts: [[2, 1000]], rt: 0.1, ro: 0.2 }] }, opts);
  assert.strictEqual(br.get(i, bIn), 1); assert.strictEqual(br.get(i, bOut), 0);
});

test('de-hum takes out 60 Hz and harmonics, keeps the voice band', () => {
  const x = add(add(tone(60, 3, 0.3), tone(180, 3, 0.15)), tone(700, 3, 0.2)), y = x.slice();
  applyEdit([y], rate, { op: 'dehum', hum: 0, harmonics: 6 });
  const at = Math.round(1.5 * rate);
  assert.ok(level(y, 60, at, 8192) < 0.15 * level(x, 60, at, 8192), '60 Hz down');
  assert.ok(level(y, 180, at, 8192) < 0.15 * level(x, 180, at, 8192), '180 Hz down');
  assert.ok(Math.abs(level(y, 700, at, 8192) / level(x, 700, at, 8192) - 1) < 0.05, '700 Hz kept');
});

test('de-click repairs short spikes and leaves clean audio alone', () => {
  const x = tone(220, 1, 0.3), clean = x.slice();
  for (const c of [0.3, 0.55, 0.8]) { const i = Math.round(c * rate); x[i] += 0.9; x[i + 1] -= 0.7; }
  const r = declick([x], rate, { sensitivity: 0.5 });
  assert.ok(r.fixed >= 3);
  assert.ok(rms(x.map((v, i) => v - clean[i])) < 0.01, 'close to the clean tone');
  const c2 = clean.slice(); declick([c2], rate, { sensitivity: 0.5 });
  assert.ok(rms(c2.map((v, i) => v - clean[i])) < 1e-6, 'nothing done to a clean tone');
});

test('log display mapping round trip', () => {
  for (const f of [40, 440, 9000]) assert.ok(Math.abs(yToF(fToY(f, 20, 24000, true), 20, 24000, true) - f) < 1e-6);
});

test('de-hum leaves a note right next to a hum harmonic alone', () => {
  const x = add(add(tone(60, 4, 0.2), tone(240, 4, 0.1)), tone(220, 4, 0.25)), y = x.slice();
  applyEdit([y], rate, { op: 'dehum', hum: 60, harmonics: 8 });
  const at = Math.round(2 * rate);
  assert.ok(level(y, 240, at, 8192) < 0.2 * level(x, 240, at, 8192), '240 Hz hum harmonic down');
  assert.ok(Math.abs(level(y, 220, at, 8192) / level(x, 220, at, 8192) - 1) < 0.1, '220 Hz note kept');
});

test('de-noise learns a hiss and takes most of it out, keeping the tone', async () => {
  const { learnProfile } = await import('../app/renderer/spectral-dsp.js');
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const hiss = new Float32Array(rate * 3).map(() => rnd() * 0.05), x = hiss.slice();
  const t = tone(800, 2, 0.4); for (let i = 0; i < t.length; i++) x[rate + i] += t[i];
  const prof = learnProfile([x], rate, 0.1, 0.9);
  const y = x.slice();
  applyEdit([y], rate, { op: 'denoise', profile: prof, reduction: 24, threshold: 3, smoothing: 0.5 });
  const quiet = [Math.round(0.3 * rate), Math.round(0.8 * rate)];
  assert.ok(rms(y, ...quiet) < 0.3 * rms(x, ...quiet), `hiss down ${rms(y, ...quiet)} vs ${rms(x, ...quiet)}`);
  const at = Math.round(2 * rate);
  assert.ok(level(y, 800, at) > 0.85 * level(x, 800, at), 'tone kept');
});

test('vertical attenuate pulls a whistle down to the band around it', () => {
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const x = new Float32Array(rate * 2).map(() => rnd() * 0.05), w = tone(3000, 2, 0.3); for (let i = 0; i < x.length; i++) x[i] += w[i];
  const y = x.slice();
  applyEdit([y], rate, { op: 'attenuate', direction: 'v', sel: { shapes: [{ kind: 'rect', t0: 0.5, t1: 1.5, f0: 2850, f1: 3150 }] } });
  const at = Math.round(rate);
  assert.ok(level(y, 3000, at) < 0.2 * level(x, 3000, at), 'whistle down');
});
