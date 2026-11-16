import test from 'node:test';
import assert from 'node:assert/strict';
import { remove } from '../app/renderer/model.js';

const mk = (id, track, start, duration, media = null, group = null) => ({ id, type: media ? 'media' : 'text', media, track, start, duration, in: 0, group, actions: [] });
const doc = clips => ({ tracks: [{ id: 'v' }, { id: 'a' }, { id: 'm' }], media: [{ id: 'scr', kind: 'video', recording: 'r1' }, { id: 'mic', kind: 'audio', recording: 'r1' }, { id: 'song', kind: 'audio' }], clips, markers: [] });

test('ripple-deleting a picture and its slightly longer sound moves every track by the same amount', () => {
  const d = doc([mk('v1', 'v', 0, 10, 'scr', 'g1'), mk('a1', 'a', 0, 10, 'mic', 'g1'), mk('v2', 'v', 10, 5, 'scr', 'g2'), mk('a2', 'a', 10, 5.2, 'mic', 'g2'), mk('v3', 'v', 15, 10, 'scr', 'g3'), mk('a3', 'a', 15.2, 10, 'mic', 'g3')]);
  remove(d, ['v2', 'a2'], true);
  const at = id => d.clips.find(c => c.id === id).start;
  // both tracks close by 5 s (all the room the picture track has), so the next picture and sound keep their 0.2 s relation
  assert.ok(Math.abs(at('v3') - 10) < 1e-9 && Math.abs(at('a3') - 10.2) < 1e-9);
});

test('deleting only the picture leaves the gap open while its own sound still plays there', () => {
  const d = doc([mk('v1', 'v', 0, 10, 'scr'), mk('a1', 'a', 0, 20, 'mic'), mk('v2', 'v', 10, 10, 'scr')]);
  const r = remove(d, ['v1'], true);
  assert.deepEqual(r, { closed: 0, kept: 1 });
  assert.equal(d.clips.find(c => c.id === 'v2').start, 10);
});

test('music under the deleted part keeps its place; everything else closes up together', () => {
  const d = doc([mk('v1', 'v', 0, 10, 'scr'), mk('a1', 'a', 0, 10, 'mic'), mk('v2', 'v', 10, 10, 'scr'), mk('a2', 'a', 10, 10, 'mic'), mk('s', 'm', 0, 30, 'song')]);
  const r = remove(d, ['v1', 'a1'], true);
  assert.equal(r.closed, 1);
  assert.equal(d.clips.find(c => c.id === 'v2').start, 0);
  assert.equal(d.clips.find(c => c.id === 'a2').start, 0);
  assert.equal(d.clips.find(c => c.id === 's').start, 0);
});

test('plain delete never moves anything', () => {
  const d = doc([mk('v1', 'v', 0, 10, 'scr'), mk('v2', 'v', 10, 10, 'scr')]);
  remove(d, ['v1'], false);
  assert.equal(d.clips.find(c => c.id === 'v2').start, 10);
});
