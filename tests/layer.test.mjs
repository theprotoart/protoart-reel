import test from 'node:test';
import assert from 'node:assert/strict';
import { layerTrack } from '../app/renderer/model.js';
import { layerPlan } from '../app/renderer/timeline.js';

const doc = () => ({ tracks: [{ id: 't1', name: 'Track 1' }, { id: 't2', name: 'Track 2' }, { id: 't3', name: 'Track 3' }],
  clips: [{ id: 'v', track: 't1', start: 0, duration: 20 }, { id: 'a', track: 't2', start: 0, duration: 20 }] });

test('a picture dropped on a busy track goes on a new track just above it', () => {
  const d = doc();
  const id = layerTrack(d, 5, 3, 't1');
  assert.equal(d.tracks[0].id, id, 'new track at the top, above Track 1');
  assert.equal(d.tracks.length, 4);
  assert.equal(layerTrack(d, 5, 3, 't3'), 't3', 'a free track is used as is');
});

test('a dragged group (screen + its sound) laid over others gets new tracks above, in the same order', () => {
  const d = doc(); d.clips.push({ id: 's', track: 't1', start: 25, duration: 4 }, { id: 'm', track: 't2', start: 25, duration: 4 });
  const made = [];
  const plan = layerPlan(d, [{ id: 's', track: 't1', start: 9, dur: 4 }, { id: 'm', track: 't2', start: 9, dur: 4 }], ['s', 'm'], made);
  assert.equal(made.length, 2);
  assert.deepEqual(plan.map(p => p.track), made);
  assert.deepEqual(d.tracks.slice(0, 2).map(t => t.id), made, 'both above the clips they cover');
  assert.equal(plan[0].start, 9, 'at the time it was dropped');
});
