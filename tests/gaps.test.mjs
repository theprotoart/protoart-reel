import test from 'node:test';
import assert from 'node:assert/strict';
import { findGaps, closeGaps } from '../app/renderer/model.js';

const C = (id, track, start, duration, extra = {}) => ({ id, type: 'media', media: 'm', track, start, duration, in: 0, actions: [], ...extra });
const doc = () => ({ tracks: [{ id: 'v' }, { id: 'a' }], markers: [{ t: 30 }], captions: [],
  clips: [C('v1', 'v', 2, 10), C('a1', 'a', 5, 10), C('v2', 'v', 20, 5), C('a2', 'a', 21, 3), C('v3', 'v', 28, 4)] });

test('gaps are where nothing plays on any track (including the start)', () => {
  assert.deepEqual(findGaps(doc()), [[0, 2], [15, 20], [25, 28]]);
});

test('closing the gaps slides everything up and keeps the tracks in sync', () => {
  const d = doc();
  const r = closeGaps(d);
  assert.equal(r.closed, 3);
  assert.ok(Math.abs(r.seconds - 10) < 1e-9);
  const at = id => d.clips.find(c => c.id === id).start;
  assert.equal(at('v1'), 0); assert.equal(at('a1'), 3);   // a1 still starts 3 s after v1
  assert.equal(at('v2'), 13); assert.equal(at('a2'), 14); // a2 still 1 s after v2
  assert.equal(at('v3'), 18);
  assert.equal(d.markers[0].t, 20, 'markers move with the edit');
  assert.deepEqual(findGaps(d), []);
});

test('a gap with a locked track after it is left alone', () => {
  const d = doc(); d.tracks[1].locked = true;
  const r = closeGaps(d);
  assert.ok(r.skipped >= 1);
  assert.equal(d.clips.find(c => c.id === 'a2').start, 21, 'the locked track didn’t move');
});

test('crossfade handles count as sound, not a gap', () => {
  const d = { tracks: [{ id: 'a' }], markers: [], captions: [], clips: [C('x', 'a', 0, 10, { xfadeOut: 1 }), C('y', 'a', 10, 5, { xfadeIn: 1 })] };
  assert.deepEqual(findGaps(d), []);
});

test('Auto Edit leaves sped-up clips whole: dead-air cuts are trimmed to stop at their edges', async () => {
  const { withoutSpans } = await import('../app/renderer/lib/words.js');
  const ranges = [{ t: 1, end: 3 }, { t: 10, end: 20 }, { t: 30, end: 31 }];
  const out = withoutSpans(ranges, [[12, 18], [29, 40]]);
  assert.deepEqual(out.map(r => [r.t, r.end]), [[1, 3], [10, 12], [18, 20]]);
});
