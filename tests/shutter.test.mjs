import test from 'node:test';
import assert from 'node:assert/strict';
import { propsAt, applyCut, CUT_TRANSITIONS } from '../app/renderer/model.js';

const clip = (start, duration) => ({ id: 'x' + start, type: 'media', start, duration, in: 0, speed: 1, props: {} });

test('radial shutter: closes over the clip going out, opens on the next (both sides of the cut)', () => {
  assert.ok(CUT_TRANSITIONS.some(([t]) => t === 'shutter'));
  const a = clip(0, 10), b = clip(10, 10);
  applyCut(a, b, 'shutter', 1);
  assert.equal(a.transOut.type, 'shutter'); assert.equal(b.transIn.type, 'shutter');
  const out = [9.6, 9.75, 9.99].map(t => propsAt(a, t - a.start).shutter);
  const inn = [0.01, 0.25, 0.49].map(t => propsAt(b, t).shutter);
  assert.ok(out[0] > out[1] && out[1] > out[2], `closing: ${out}`);
  assert.ok(inn[0] < inn[1] && inn[1] < inn[2], `opening: ${inn}`);
  assert.ok(out[2] < 0.05 && inn[0] < 0.05, 'shut at the cut');
  const mid = propsAt(a, 5).shutter;
  assert.ok(mid == null || mid >= 1, 'no shutter away from the cut');
});
