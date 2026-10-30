// Speed: time stretching keeps pitch; setSpeed keeps the source, scales keys and actions and never overlaps.
import test from 'node:test';
import assert from 'node:assert';
import { stretch } from '../app/renderer/lib/stretch.js';
import { setSpeed } from '../app/renderer/model.js';

const rate = 16000;
const crossings = x => { let n = 0; for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) n++; return n; };

for (const speed of [2, 0.5, 1.5]) test(`stretch ×${speed}: length changes, pitch doesn’t`, () => {
  const x = Float32Array.from({ length: rate * 2 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate));
  const [y] = stretch([x], speed, rate);
  assert.ok(Math.abs(y.length - x.length / speed) <= 1);
  const f = crossings(y.subarray(1000, y.length - 1000)) / ((y.length - 2000) / rate);
  assert.ok(Math.abs(f - 440) < 6, `pitch ${f.toFixed(1)} Hz`);
  let peak = 0; for (let i = 1000; i < y.length - 1000; i++) peak = Math.max(peak, Math.abs(y[i]));
  assert.ok(peak > 0.45 && peak < 0.56, `level ${peak}`);
});

test('setSpeed: same source, scaled keys and actions, stops at the next clip', () => {
  const c = { id: 'a', track: 't', start: 0, duration: 10, speed: 1, keys: { x: [{ t: 5, v: 1 }] }, actions: [{ t: 2, dur: 4 }], audio: { fadeIn: 1, fadeOut: 0 } };
  const next = { id: 'b', track: 't', start: 12, duration: 3 };
  const doc = { clips: [c, next] };
  setSpeed(doc, c, 2);
  assert.equal(c.duration, 5); assert.equal(c.keys.x[0].t, 2.5); assert.deepEqual(c.actions[0], { t: 1, dur: 2 }); assert.equal(c.audio.fadeIn, 0.5);
  setSpeed(doc, c, 0.5); // wants 20 s, only 12 fit
  assert.ok(Math.abs(c.duration - 12) < 1e-9); assert.ok(Math.abs(c.speed - 10 / 12) < 1e-9);
  setSpeed(doc, c, 1, 'end'); // anchored at the end: 10 s ending at 12
  assert.ok(Math.abs(c.start - 2) < 1e-9 && Math.abs(c.duration - 10) < 1e-9 && c.speed === 1);
});
