import test from 'node:test';
import assert from 'node:assert/strict';
import { split, withGroups } from '../app/renderer/model.js';

const clip = (id, track, group) => ({ id, type: 'media', track, start: 0, duration: 10, in: 0, speed: 1, props: { crop: [0, 0, 0, 0] }, actions: [], group });

test('splitting a grouped recording keeps each side grouped on its own', () => {
  const doc = { clips: [clip('s', 't1', 'g1'), clip('m', 't2', 'g1')], markers: [] };
  split(doc, 4, withGroups(doc, ['s']));
  const left = doc.clips.filter(c => c.start === 0), right = doc.clips.filter(c => c.start === 4);
  assert.equal(right.length, 2);
  assert.ok(left.every(c => c.group === 'g1'));
  assert.ok(right[0].group && right[0].group === right[1].group && right[0].group !== 'g1');
  // selecting one right half picks up only the other right half
  assert.deepEqual(withGroups(doc, [right[0].id]).sort(), right.map(c => c.id).sort());
});
