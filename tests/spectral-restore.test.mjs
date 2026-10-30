// The restoration modules (Revert, Gain in/out, Patch, De-clip, Decrackle, Auto Dehiss, De-buzz, Dethump), each
// checked on a sound built to have exactly that problem.
import test from 'node:test';
import assert from 'node:assert';
import { applyEdit } from '../app/renderer/spectral-dsp.js';
import { runEdit } from '../app/renderer/spectral-rx.js';
import '../app/renderer/spectral-restore.js';

const rate = 16000, S = s => Math.round(s * rate);
const run = (x, ed, orig) => { const ch = [x]; const r = runEdit(ch, rate, ed, applyEdit, { orig: orig && [orig] }); return { y: ch[0], r }; };
let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
const noise = (n, a) => Float32Array.from({ length: n }, () => a * rnd());
const tone = (f, n, a) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / rate));
const addAt = (x, y, at) => { for (let i = 0; i < y.length && at + i < x.length; i++) x[at + i] += y[i]; return x; };
const rms = (x, a, z) => { let s = 0; for (let i = a; i < z; i++) s += x[i] * x[i]; return Math.sqrt(s / (z - a)); };
const diff = (x, y, a, z) => rms(x.map((v, i) => v - y[i]), a, z);
const dB = v => 20 * Math.log10(v + 1e-12);
const level = (x, f, a, n = 1024) => { let re = 0, im = 0; for (let i = 0; i < n; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); re += x[a + i] * w * Math.cos((2 * Math.PI * f * i) / rate); im += x[a + i] * w * Math.sin((2 * Math.PI * f * i) / rate); } return Math.hypot(re, im) / (n / 4); };

test('Revert puts the selection back to the original and keeps the edit elsewhere', () => {
  const orig = tone(500, S(3), 0.4), x = orig.map(v => v * 0.1); // an edit that turned everything down 20 dB
  const { y } = run(x.slice(), { op: 'revert', sel: { shapes: [{ kind: 'time', t0: 1, t1: 2 }] } }, orig);
  assert.ok(Math.abs(dB(level(y, 500, S(1.3))) - dB(0.4)) < 0.5, 'inside is back to the original');
  assert.ok(Math.abs(dB(level(y, 500, S(0.3))) - dB(0.04)) < 0.5, 'outside keeps the edit');
});

test('Gain sets one level inside and another outside', () => {
  const x = tone(500, S(3), 0.4);
  const { y } = run(x.slice(), { op: 'volume', inside: 0, outside: -20, sel: { shapes: [{ kind: 'time', t0: 1, t1: 2 }] } });
  assert.ok(Math.abs(dB(level(y, 500, S(1.3))) - dB(0.4)) < 0.5, 'inside unchanged');
  assert.ok(Math.abs(dB(level(y, 500, S(0.3))) - dB(0.04)) < 0.7, 'outside 20 dB down');
});

test('Patch copies from the chosen source, and can retune it', () => {
  const x = tone(600, S(4), 0.4); for (let i = S(2); i < S(2.4); i++) x[i] = 0;
  const sel = { shapes: [{ kind: 'time', t0: 1.95, t1: 2.45 }] };
  const { y } = run(x.slice(), { op: 'patch', sel, sourceOffset: -1 });
  assert.ok(level(y, 600, S(2.1)) > 0.3, 'hole filled from 1 s earlier');
  const { y: up } = run(x.slice(), { op: 'patch', sel, sourceOffset: -1, semitones: 12 });
  assert.ok(level(up, 1200, S(2.1)) > 0.2 && level(up, 1200, S(2.1)) > 3 * level(up, 600, S(2.1)), 'an octave up');
});

test('De-clip redraws clipped peaks closer to the real waveform', () => {
  const clean = tone(220, S(1), 0.9), x = clean.map(v => Math.max(-0.6, Math.min(0.6, v)));
  const { y, r } = run(x.slice(), { op: 'declip', sensitivity: 0.5 });
  assert.ok(r.fixed > 100, `runs fixed ${r.fixed}`);
  assert.ok(dB(diff(y, clean, S(0.1), S(0.9))) < dB(diff(x, clean, S(0.1), S(0.9))) - 10, 'error at least 10 dB smaller');
});

test('De-clip leaves an unclipped sound alone', () => {
  const x = tone(220, S(1), 0.5);
  const { y } = run(x.slice(), { op: 'declip', sensitivity: 0.5 });
  assert.ok(diff(y, x, 0, x.length) < 1e-3);
});

test('Decrackle takes out low-level crackle', () => {
  const clean = tone(300, S(2), 0.3), x = clean.slice();
  for (let k = 0; k < 600; k++) x[Math.floor(((rnd() + 1) / 2) * (x.length - 10)) + 5] += 0.04 * (rnd() > 0 ? 1 : -1);
  const { y, r } = run(x.slice(), { op: 'decrackle', sensitivity: 0.5 });
  assert.ok(r.fixed > 300, `fixed ${r.fixed}`);
  assert.ok(dB(diff(y, clean, S(0.1), S(1.9))) < dB(diff(x, clean, S(0.1), S(1.9))) - 8, 'crackle 8 dB down or more');
});

test('Auto Dehiss lowers hiss with no learning and keeps the tone', () => {
  const x = noise(S(4), 0.05); addAt(x, tone(400, S(1.5), 0.3), S(1.5));
  const { y } = run(x.slice(), { op: 'dehiss', attenuation: 15, bias: 0 });
  assert.ok(dB(rms(y, S(0.4), S(1.2))) < dB(rms(x, S(0.4), S(1.2))) - 8, 'hiss down 8 dB or more');
  assert.ok(Math.abs(dB(level(y, 400, S(2))) - dB(level(x, 400, S(2)))) < 1, 'tone kept');
});

test('De-buzz follows a buzz that wanders in pitch and keeps a note', () => {
  const n = S(3), buzz = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { const f = 58 + (4 * i) / n; ph += (2 * Math.PI * f) / rate; for (let h = 1; h <= 15; h++) buzz[i] += (0.15 / h) * Math.sin(h * ph); }
  const note = tone(448, n, 0.2), x = buzz.map((v, i) => v + note[i]);
  const { y, r } = run(x.slice(), { op: 'debuzz', fundamental: 0, bandwidth: 0.06, threshold: 6, attenuation: 40 });
  assert.equal(Math.round(r.fundamental / 10) * 10, 60);
  assert.ok(dB(diff(y, note, S(0.5), S(2.5))) < dB(rms(buzz, S(0.5), S(2.5))) - 15, 'buzz at least 15 dB down');
  assert.ok(Math.abs(dB(level(y, 448, S(1.5))) - dB(0.2)) < 1.5, 'the note kept');
});

test('Dethump removes a thump and keeps the bass under it', () => {
  const bass = tone(100, S(4), 0.2), x = bass.slice();
  addAt(x, tone(35, S(0.15), 0.9).map((v, i, a) => v * Math.sin((Math.PI * i) / a.length)), S(2));
  const { y, r } = run(x.slice(), { op: 'dethump', sensitivity: 0.5, limit: 70 });
  assert.ok(r.fixed >= 1, 'found the thump');
  assert.ok(level(y, 35, S(2), 2048) < level(x, 35, S(2), 2048) * 0.3, 'thump 10 dB down or more');
  assert.ok(Math.abs(dB(level(y, 100, S(2), 2048)) - dB(0.2)) < 2, 'bass kept through the thump');
});

test('De-bark finds barks over a voice, pulls them down and keeps the voice', () => {
  const n = S(6), voice = new Float32Array(n);
  for (let i = 0; i < n; i++) { const on = (i / rate) % 1.5 < 1.2 ? 1 : 0; for (let h = 1; h <= 6; h++) voice[i] += on * (0.12 / h) * Math.sin((2 * Math.PI * 170 * h * i) / rate); }
  const bark = len => Float32Array.from({ length: len }, (_, i) => { const env = Math.exp(-i / (len / 3)) * Math.min(1, i / 40); let v = 0; for (let h = 1; h <= 5; h++) v += (0.25 / h) * Math.sin((2 * Math.PI * 600 * h * i) / rate); return v * env; });
  const x = voice.slice(), at = [1.0, 2.6, 4.1];
  for (const t of at) addAt(x, bark(S(0.2)), S(t));
  const { y, r } = run(x.slice(), { op: 'debark', sensitivity: 0.5 });
  assert.ok(r.fixed >= 3, `barks found ${r.fixed}`);
  for (const t of at) assert.ok(level(y, 600, S(t + 0.02)) < level(x, 600, S(t + 0.02)) * 0.3, `bark at ${t} s 10 dB down`);
  assert.ok(Math.abs(dB(level(y, 170, S(1.02))) - dB(level(voice, 170, S(1.02)))) < 2, 'voice kept through the bark');
});

test('De-bark example mode: one selected bark finds the others', () => {
  const x = noise(S(5), 0.005), at = [0.8, 2.2, 3.7];
  const bark = Float32Array.from({ length: S(0.2) }, (_, i) => Math.exp(-i / 1000) * [1, 2, 3].reduce((v, h) => v + (0.3 / h) * Math.sin((2 * Math.PI * 700 * h * i) / rate), 0));
  for (const t of at) addAt(x, bark, S(t));
  const { y, r } = run(x.slice(), { op: 'debark', mode: 'example', similarity: 0.75, sel: { shapes: [{ kind: 'time', t0: 0.78, t1: 1.02 }] } });
  assert.equal(r.fixed, 3);
  for (const t of at) assert.ok(level(y, 700, S(t + 0.02)) < level(x, 700, S(t + 0.02)) * 0.3);
});

test('Dethump leaves a deep voice starting after a pause alone', () => {
  const x = new Float32Array(S(4));
  for (let i = S(2); i < x.length; i++) for (let h = 1; h <= 8; h++) x[i] += (0.1 / h) * Math.sin((2 * Math.PI * 95 * h * i) / rate) * Math.min(1, (i - S(2)) / 80);
  const { r } = run(x.slice(), { op: 'dethump', sensitivity: 0.5 });
  assert.equal(r.fixed, 0);
});
