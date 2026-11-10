import test from 'node:test';
import assert from 'node:assert/strict';
import { fadeShape, gainAt } from '../app/renderer/model.js';

test('a straight fade unless curved; ends are always silent and full', () => {
  for (const k of [-1, -0.5, 0, 0.5, 1]) { assert.equal(fadeShape(0, k), 0); assert.equal(fadeShape(1, k), 1); }
  assert.equal(fadeShape(0.5, 0), 0.5);
  assert.ok(fadeShape(0.5, 1) > 0.8, 'fast start rises early');
  assert.ok(fadeShape(0.5, -1) < 0.1, 'slow start rises late');
  for (let x = 0.1; x < 1; x += 0.1) assert.ok(fadeShape(x, 0.6) >= fadeShape(x, 0) && fadeShape(x, 0) >= fadeShape(x, -0.6));
});

test('the clip gain follows the fade curves (in and out), as playback and export hear it', () => {
  const doc = { tracks: [{ id: 't' }], clips: [] };
  const clip = curveIn => ({ id: 'c', track: 't', start: 0, duration: 10, audio: { volume: 1, fadeIn: 2, fadeOut: 2, fadeInCurve: curveIn, fadeOutCurve: -1 } });
  assert.ok(Math.abs(gainAt(doc, clip(0), 1) - 0.5) < 1e-9);
  assert.ok(gainAt(doc, clip(1), 1) > 0.8);
  assert.ok(gainAt(doc, clip(0), 9) < 0.1, 'slow start on the way out: quiet near the end');
  assert.ok(Math.abs(gainAt(doc, clip(0), 5) - 1) < 1e-9);
});
