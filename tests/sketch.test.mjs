// Sketch (Preview's Markup): rough strokes read as clean shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recognize, polyPoints } from '../app/renderer/lib/sketch.js';

const A = 16 / 9;
let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
// a hand-drawn stroke through points (canvas pixels on a 1600 × 900 canvas), wobbling a little, closing a little short
function stroke(corners, { closed = false, per = 30, wobble = 4 } = {}) {
  const pts = [], cs = closed ? [...corners, corners[0]] : corners;
  for (let i = 1; i < cs.length; i++) for (let k = 0; k < per; k++) {
    const t = k / per, [a, b] = [cs[i - 1], cs[i]];
    pts.push([(a[0] + (b[0] - a[0]) * t + rnd() * wobble) / 1600, (a[1] + (b[1] - a[1]) * t + rnd() * wobble) / 900]);
  }
  if (!closed) pts.push([cs[cs.length - 1][0] / 1600, cs[cs.length - 1][1] / 900]);
  else pts.splice(-6); // stops just short of where it began
  return pts;
}
const oval = (cx, cy, rx, ry, n = 90, wobble = 5) => Array.from({ length: n - 4 }, (_, i) => { const a = (i / n) * Math.PI * 2; return [(cx + Math.cos(a) * rx + rnd() * wobble) / 1600, (cy + Math.sin(a) * ry + rnd() * wobble) / 900]; });

test('a straight stroke is a line, one with a hook at the end an arrow', () => {
  const l = recognize(stroke([[200, 200], [900, 500]]), A);
  assert.equal(l.shape, 'line');
  assert.ok(Math.abs(l.x1 - 200 / 1600) < 0.01 && Math.abs(l.y2 - 500 / 900) < 0.02);
  const a = recognize(stroke([[200, 600], [900, 300], [830, 290], [900, 300], [870, 370]]), A);
  assert.equal(a.shape, 'arrow');
  assert.ok(Math.abs(a.x2 - 900 / 1600) < 0.02 && Math.abs(a.y2 - 300 / 900) < 0.03, JSON.stringify(a));
});

test('a closed four-cornered stroke is a box, a round one an oval', () => {
  const r = recognize(stroke([[300, 200], [1100, 210], [1090, 700], [310, 690]], { closed: true }), A);
  assert.equal(r.shape, 'rect');
  assert.ok(Math.abs(r.x1 - 300 / 1600) < 0.015 && Math.abs(r.y2 - 700 / 900) < 0.02, JSON.stringify(r));
  assert.equal(recognize(oval(800, 450, 300, 200), A).shape, 'ellipse');
  assert.equal(recognize(oval(800, 450, 150, 150), A).shape, 'ellipse', 'a circle');
});

test('a triangle, a pentagon and a star', () => {
  const tri = recognize(stroke([[800, 150], [1150, 700], [450, 700]], { closed: true, per: 40 }), A);
  assert.deepEqual([tri.shape, tri.sides], ['polygon', 3]);
  const pent = [0, 1, 2, 3, 4].map(i => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5; return [800 + Math.cos(a) * 300, 450 + Math.sin(a) * 300]; });
  const p = recognize(stroke(pent, { closed: true, per: 30, wobble: 2 }), A);
  assert.deepEqual([p.shape, p.sides], ['polygon', 5]);
  const star = Array.from({ length: 10 }, (_, i) => { const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 120 : 320; return [800 + Math.cos(a) * r, 450 + Math.sin(a) * r]; });
  const s = recognize(stroke(star, { closed: true, per: 16, wobble: 2 }), A);
  assert.deepEqual([s.shape, s.points], ['star', 5]);
});

test('a scribble stays a drawing; a dot is nothing', () => {
  const scribble = Array.from({ length: 80 }, (_, i) => [(400 + i * 8 + Math.sin(i * 1.3) * 60) / 1600, (450 + Math.cos(i * 0.9) * 120) / 900]);
  assert.equal(recognize(scribble, A), null);
  assert.equal(recognize([[0.5, 0.5], [0.501, 0.5], [0.5, 0.501], [0.5, 0.5]], A), null);
});

test('star and polygon points fill their box', () => {
  const s = polyPoints('star', 5);
  assert.equal(s.length, 10);
  assert.equal(Math.min(...s.map(q => q[1])), 0); assert.equal(Math.max(...s.map(q => q[1])), 1);
  assert.equal(polyPoints('polygon', 3).length, 3);
});
