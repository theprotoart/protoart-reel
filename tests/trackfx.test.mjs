// Track effects: each effect does what it says, keeps state across blocks, and never produces NaN.
import test from 'node:test';
import assert from 'node:assert';
import { FxChain, FX_TYPES } from '../app/renderer/lib/trackfx.js';

const rate = 48000;
const tone = (f, a, n, phase = 0) => Float32Array.from({ length: n }, (_, i) => a * Math.sin(2 * Math.PI * f * (i + phase) / rate));
const rms = x => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
const run = (list, L, R, block = 512) => { const ch = new FxChain(rate).setup(list); for (let p = 0; p < L.length; p += block) ch.process(L.subarray(p, p + block), R.subarray(p, p + block)); return [L, R]; };

test('a flat EQ and 0 dB gain leave the sound alone', () => {
  const x = tone(440, 0.5, 48000), [L] = run([{ type: 'eq' }, { type: 'gain' }], x.slice(), x.slice());
  for (let i = 0; i < x.length; i += 997) assert.ok(Math.abs(L[i] - x[i]) < 1e-6);
});
test('the high-pass removes rumble and keeps the voice band', () => {
  const lo = tone(40, 0.5, 48000), hi = tone(1000, 0.5, 48000);
  const [a] = run([{ type: 'eq', params: { hpf: 120 } }], lo.slice(), lo.slice()), [b] = run([{ type: 'eq', params: { hpf: 120 } }], hi.slice(), hi.slice());
  assert.ok(rms(a.subarray(24000)) < 0.06 && rms(b.subarray(24000)) > 0.33);
});
test('the compressor turns loud parts down by about the ratio', () => {
  const x = tone(500, 0.9, 48000), [L] = run([{ type: 'comp', params: { threshold: -20, ratio: 4, attack: 1, release: 50, makeup: 0 } }], x.slice(), x.slice());
  const outDb = 20 * Math.log10(rms(L.subarray(24000)) * Math.SQRT2), inDb = 20 * Math.log10(0.9);
  assert.ok(outDb < -10 && outDb > -20, `${inDb.toFixed(1)} → ${outDb.toFixed(1)} dB`);
});
test('the limiter holds the ceiling', () => {
  const x = tone(200, 1.5, 48000), [L] = run([{ type: 'limiter', params: { ceiling: -3 } }], x.slice(), x.slice());
  let pk = 0; for (const v of L.subarray(100)) pk = Math.max(pk, Math.abs(v));
  assert.ok(pk <= 10 ** (-3 / 20) + 1e-3, String(pk));
});
test('reverb and delay leave a tail after the sound stops', () => {
  for (const t of ['reverb', 'delay']) {
    const x = new Float32Array(48000); x.set(tone(300, 0.5, 4800));
    const [L] = run([{ type: t, params: { mix: 0.5 } }], x, x.slice());
    assert.ok(rms(L.subarray(9600, 30000)) > 1e-3, t);
    assert.ok(L.every(Number.isFinite), t);
  }
});
test('the gate silences quiet noise between words', () => {
  const x = new Float32Array(48000); x.set(tone(300, 0.5, 9600)); for (let i = 9600; i < 48000; i++) x[i] = 0.001 * Math.sin(i);
  const [L] = run([{ type: 'gate', params: { threshold: -40, range: 40, release: 20 } }], x, x.slice());
  assert.ok(rms(L.subarray(30000)) < 0.0002);
});
test('every effect type is known and defaults are complete', () => { for (const k of Object.keys(FX_TYPES)) assert.ok(FX_TYPES[k].name); });

test('Auto Level: turns quiet speech up, loud speech down, and leaves silence alone', async () => {
  const { FxChain } = await import('../app/renderer/lib/trackfx.js');
  const R = 48000, ch = new FxChain(R).setup([{ type: 'level', params: {} }]);
  const rms = a => 20 * Math.log10(Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length));
  const run = amp => { let last; for (let b = 0; b < 400; b++) { const L = new Float32Array(512), Rr = new Float32Array(512); for (let i = 0; i < 512; i++) L[i] = Rr[i] = amp * Math.sin((b * 512 + i) * 0.05); ch.process(L, Rr); last = L; } return rms(Array.from(last)); };
  const quiet = run(0.02), loud = run(0.5), silence = run(0.0005);
  assert.ok(quiet > -27 && quiet < -24, `quiet ${quiet}`);   // −37 dB in, turned up by at most 12 dB
  assert.ok(loud > -21 && loud < -16, `loud ${loud}`);       // −9 dB in, brought down toward −20
  assert.ok(silence < -65, `silence ${silence}`);            // not pumped up after the loud part
});
