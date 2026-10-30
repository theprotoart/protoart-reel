import test from 'node:test';
import assert from 'node:assert/strict';
import { findClaps } from '../app/renderer/lib/claps.js';

const RATE = 48000;
// deterministic noise
let seed = 1; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
const buf = s => new Float32Array(Math.round(s * RATE));
const clap = (x, t, a = 0.8) => { const i0 = Math.round(t * RATE); for (let i = 0; i < RATE * 0.06; i++) if (x[i0 + i] !== undefined) x[i0 + i] += a * rnd() * Math.exp(-i / (RATE * 0.008)); };
const hum = (x, a = 0.02) => { for (let i = 0; i < x.length; i++) x[i] += a * Math.sin(i * 2 * Math.PI * 220 / RATE) + 0.002 * rnd(); };
const speech = (x, t0, t1, a = 0.15) => { for (let i = Math.round(t0 * RATE); i < t1 * RATE; i++) { const env = 0.5 + 0.5 * Math.sin(i * 2 * Math.PI * 4 / RATE); x[i] += a * env * (Math.sin(i * 2 * Math.PI * 180 / RATE) + 0.4 * Math.sin(i * 2 * Math.PI * 540 / RATE)); } };

test('three even claps are found, with their time', () => {
  const x = buf(10); hum(x); speech(x, 0.5, 3.5);
  clap(x, 5.0); clap(x, 5.35); clap(x, 5.7);
  speech(x, 6.5, 9.5);
  const r = findClaps(x, RATE);
  assert.equal(r.length, 1);
  assert.ok(Math.abs(r[0].t0 - 5.0) < 0.02, `t0 ${r[0].t0}`);
  assert.ok(Math.abs(r[0].claps[2] - 5.7) < 0.02);
});

test('two signals in one recording', () => {
  const x = buf(20); hum(x);
  for (const t of [3, 3.4, 3.8, 14, 14.3, 14.6]) clap(x, t);
  const r = findClaps(x, RATE);
  assert.deepEqual(r.map(s => Math.round(s.t0)), [3, 14]);
});

test('one or two claps, uneven claps, and speech alone are ignored', () => {
  const x = buf(16); hum(x); speech(x, 0, 16);
  clap(x, 2); clap(x, 6); clap(x, 6.4); clap(x, 10); clap(x, 10.15); clap(x, 10.9);
  assert.equal(findClaps(x, RATE).length, 0);
});

test('a long run of claps (applause, typing) is not a signal', () => {
  const x = buf(8); hum(x);
  for (let t = 2; t < 5; t += 0.3) clap(x, t);
  assert.equal(findClaps(x, RATE).length, 0);
});
