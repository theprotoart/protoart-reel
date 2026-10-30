// Make Vertical: fill the tall frame and follow the action without showing past the picture's edges.
import test from 'node:test';
import assert from 'node:assert';
import { coverScale, reframeKeys } from '../app/renderer/lib/reframe.js';

test('a 16:9 picture fills a 9:16 canvas at about 3.16×', () => {
  assert.ok(Math.abs(coverScale(1920, 1080, 1080, 1920) - 1920 / 607.5) < 1e-9);
  assert.equal(coverScale(1080, 1920, 1080, 1920), 1);
});
test('the frame follows the action left then right, holds while it is still, and never shows an edge', () => {
  const s = coverScale(1920, 1080, 1080, 1920);
  const focus = [];
  for (let t = 0; t <= 10; t += 0.1) focus.push({ t, x: t < 5 ? 0.15 : 0.85, y: 0.5 });
  const k = reframeKeys(focus, { srcW: 1920, srcH: 1080, W: 1080, H: 1920, scale: s, duration: 10 });
  const at = t => { let a = k[0]; for (const x of k) if (x.t <= t) a = x; return a; };
  const maxOff = (1920 / 607.5 * 1080 * (1080 / 1920) * 0 + (s * 1080 - 1080) / 2160); // half the overhang
  for (const x of k) assert.ok(Math.abs(x.x - 0.5) <= maxOff + 1e-9);
  assert.ok(at(4).x > 0.6, `left action shown (x ${at(4).x})`);  // picture moved right to show its left part
  assert.ok(at(9.5).x < 0.4, `right action shown (x ${at(9.5).x})`);
  // still action: no new keys between 2 s and 4.5 s
  assert.ok(k.filter(x => x.t > 2 && x.t < 4.5).length <= 1);
});
