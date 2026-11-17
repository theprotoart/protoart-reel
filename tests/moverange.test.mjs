import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveRange } from '../app/renderer/model.js';

const mk = (id, track, start, duration, extra = {}) => ({ id, type: 'media', media: 'm', track, start, duration, in: start, speed: 1, props: {}, transIn: { type: 'none', dur: 0.5 }, transOut: { type: 'none', dur: 0.5 }, ...extra });
const doc = () => ({ media: [{ id: 'm', kind: 'video', duration: 100 }], tracks: [{ id: 'v' }, { id: 'a' }, { id: 'mu', locked: true }],
  clips: [mk('v1', 'v', 0, 10), mk('v2', 'v', 10, 10, { transIn: { type: 'dissolve', dur: 0.5 } }), mk('v3', 'v', 20, 10), mk('a1', 'a', 0, 30), mk('mu', 'mu', 0, 30)],
  markers: [{ t: 12, label: 'here' }], labels: [{ id: 'l', t0: 11, t1: 13, text: 'Bit' }], captions: [], groups: {} });

test('a stretch moved earlier: it goes in there with its cuts and fades, the rest makes room and closes up', () => {
  const d = doc();
  const at = moveRange(d, 10, 20, 0);
  assert.equal(at, 0);
  const on = tr => d.clips.filter(c => c.track === tr).sort((p, q) => p.start - q.start).map(c => [c.start, c.duration, c.in]);
  assert.deepEqual(on('v'), [[0, 10, 10], [10, 10, 0], [20, 10, 20]], 'the 10–20 picture now first');
  assert.equal(d.clips.find(c => c.id === 'v2').transIn.type, 'dissolve', 'its fade kept');
  assert.deepEqual(on('a'), [[0, 10, 10], [10, 10, 0], [20, 10, 20]], 'its sound with it');
  assert.deepEqual(on('mu'), [[0, 30, 0]], 'a locked track stays put');
  assert.equal(d.markers[0].t, 2); assert.deepEqual([d.labels[0].t0, d.labels[0].t1], [1, 3], 'markers and labels go with it');
});

test('moved later: its new start is the time chosen on the edit as it was', () => {
  const d = doc();
  const at = moveRange(d, 0, 10, 30);
  assert.equal(at, 20);
  assert.deepEqual(d.clips.filter(c => c.track === 'v').sort((p, q) => p.start - q.start).map(c => [c.start, c.in]), [[0, 10], [10, 20], [20, 0]]);
  assert.equal(moveRange(d, 0, 10, 5), null, 'not into itself');
});
