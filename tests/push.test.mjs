// Quick push in / push out: two actions that belong together, set from one place.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addPush, pushOf, pushAt, setPush, removePush } from '../app/renderer/lib/push.js';
import { propsAt } from '../app/renderer/model.js';
import { shotOf } from '../app/renderer/lib/dynzoom.js';

const clip = () => ({ id: 'c', type: 'media', start: 0, duration: 10, props: { x: 0.5, y: 0.5, scale: 1, opacity: 1, rotation: 0, crop: [0, 0, 0, 0] }, actions: [] });
const at = (c, t) => propsAt({ ...c, transIn: null, transOut: null }, t);

test('a push in and out: quick in, a hold, quick out, back to the whole picture', () => {
  const c = clip();
  addPush(c, 2, { aim: { fx: 0.7, fy: 0.3 }, zoom: 2, inDur: 0.3, hold: 1.5, outDur: 0.4 });
  assert.equal(c.actions.length, 2);
  const p = pushOf(c, c.actions[0].id);
  assert.deepEqual([p.zoom, p.inDur, p.hold, p.outDur].map(v => +v.toFixed(3)), [2, 0.3, 1.5, 0.4]);
  assert.equal(at(c, 1.9).scale, 1);
  const mid = at(c, 3);
  assert.ok(Math.abs(mid.scale - 2) < 1e-9);
  const f = shotOf(mid);
  assert.ok(Math.abs(f.fx - 0.7) < 1e-9 && Math.abs(f.fy - 0.3) < 1e-9, 'the aimed point in the middle');
  assert.ok(Math.abs(at(c, 5).scale - 1) < 1e-9 && Math.abs(at(c, 5).x - 0.5) < 1e-9, 'back out');
  assert.equal(pushAt(c, 3).id, p.id);
  assert.equal(pushAt(c, 8), null);
});

test('changing its speed, hold and zoom moves both halves together, aimed at the same point', () => {
  const c = clip();
  addPush(c, 2, { aim: { fx: 0.6, fy: 0.6 }, zoom: 1.5 });
  const id = c.actions[1].id; // either half works
  setPush(c, id, { inDur: 1, hold: 3, outDur: 0.8, zoom: 2.5 });
  const p = pushOf(c, id);
  assert.ok(Math.abs(p.in.dur - 1) < 1e-9 && Math.abs(p.out.t - 6) < 1e-9 && Math.abs(p.out.dur - 0.8) < 1e-9);
  const f = shotOf(at(c, 4));
  assert.ok(Math.abs(at(c, 4).scale - 2.5) < 1e-9);
  assert.ok(Math.abs(f.fx - 0.6) < 1e-9 && Math.abs(f.fy - 0.6) < 1e-9);
  removePush(c, id);
  assert.equal(c.actions.length, 0);
});

test('push in only, then push out later: it comes back to how it was before', () => {
  const c = clip(); c.props.scale = 1.2; c.props.x = 0.45;
  addPush(c, 1, { kind: 'in', zoom: 2 });
  addPush(c, 6, { kind: 'out' });
  assert.ok(Math.abs(at(c, 3).scale - 2.4) < 1e-9);
  assert.ok(Math.abs(at(c, 8).scale - 1.2) < 1e-9 && Math.abs(at(c, 8).x - 0.45) < 1e-9);
});
