import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ColorStats, matchParams, applyMatch, clipSampleTimes } from '../app/renderer/lib/colormatch.js';
import { filterParams, wheelRgb, needsGl } from '../app/renderer/lib/glfx.js';

const px = list => new Uint8ClampedArray(list.flatMap(([r, g, b]) => [r, g, b, 255]));

test('statistics leave out crushed black and blown-out white', () => {
  const s = new ColorStats().add(px([[0, 0, 0], [255, 255, 255], [100, 50, 25], [200, 150, 125]])).result;
  assert.equal(s.n, 2);
  assert.ok(Math.abs(s.mean[0] - 150 / 255) < 1e-9);
});

test('a match makes a shot sit like the reference', () => {
  // a cool, flat shot and a warm, contrasty reference
  const cool = new ColorStats().add(px([[80, 100, 140], [100, 120, 160], [120, 140, 180]])).result;
  const warm = new ColorStats().add(px([[150, 100, 60], [175, 120, 80], [200, 140, 100]])).result;
  const m = matchParams(cool, warm);
  const mid = applyMatch([100 / 255, 120 / 255, 160 / 255], m);
  assert.ok(Math.abs(mid[0] - 175 / 255) < 0.02 && Math.abs(mid[2] - 80 / 255) < 0.02, String(mid));
  assert.ok(m.mul.every(v => v >= 0.6 && v <= 1.7));
  // half the amount lands half way
  const half = applyMatch([100 / 255, 120 / 255, 160 / 255], m, 0.5);
  assert.ok(half[0] > 100 / 255 && half[0] < mid[0]);
});

test('the match and the colour wheels reach the GPU filter', () => {
  const u = filterParams([{ type: 'match', mul: [1.2, 1, 0.8], add: [0.05, 0, -0.05], amount: 1 }, { type: 'grade', gain: { x: 1, y: 0, l: 0 } }]);
  assert.deepEqual(u.mMul.map(v => +v.toFixed(3)), [1.2, 1, 0.8]);
  assert.ok(u.gain[0] > 1 && u.gain[1] < 1 && u.gain[2] < 1); // gain pushed toward red
  assert.ok(needsGl(u));
  assert.ok(!needsGl(filterParams([{ type: 'grade' }])));
  const w = wheelRgb({ x: 0.5, y: 0.5 });
  assert.ok(Math.abs(w[0] + w[1] + w[2]) < 1e-9); // colour, not brightness
});

test('sample times sit inside the clip', () => {
  const t = clipSampleTimes({ in: 10, duration: 4, speed: 2 }, 4);
  assert.equal(t.length, 4);
  assert.ok(t[0] > 10 && t[3] < 18);
});
