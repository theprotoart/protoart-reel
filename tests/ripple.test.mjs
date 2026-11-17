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

test('trimming a clip out past the next one pushes the clips after along, with their sound, instead of cutting them off', async () => {
  const { trim, pushAlong } = await import('../app/renderer/model.js');
  const mk = (id, track, start, duration, group) => ({ id, type: 'media', media: 'm', track, start, duration, in: 0, speed: 1, group, props: {} });
  const doc = { media: [{ id: 'm', kind: 'video', duration: 100, hasAudio: true }], tracks: [{ id: 'v' }, { id: 'a' }, { id: 'm2' }],
    clips: [mk('v1', 'v', 0, 5, 'g1'), mk('a1', 'a', 0, 5, 'g1'), mk('v2', 'v', 5, 5, 'g2'), mk('a2', 'a', 5, 5, 'g2'), mk('t', 'm2', 7, 2)], groups: {} };
  const before = { v1: { start: 0, end: 5 }, a1: { start: 0, end: 5 } };
  for (const id of ['v1', 'a1']) trim(doc, doc.clips.find(c => c.id === id), 'end', 6.5, doc.media[0], { push: true });
  const shift = pushAlong(doc, ['v1', 'a1'], before, 'end');
  const at = id => doc.clips.find(c => c.id === id);
  assert.equal(shift, 1.5);
  assert.deepEqual([at('v1').duration, at('v2').start, at('a2').start, at('v2').duration], [6.5, 6.5, 6.5, 5], 'the next picture and its sound moved along, whole');
  assert.equal(at('t').start, 7, 'other tracks stay put');
  // the start, out past the clip before: the trimmed clip (and what follows) moves right instead
  const d2 = { media: doc.media, tracks: [{ id: 'v' }], clips: [mk('p', 'v', 0, 5), { ...mk('q', 'v', 5, 5), in: 3 }, mk('r', 'v', 10, 2)], groups: {} };
  trim(d2, d2.clips[1], 'start', 4, d2.media[0], { push: true });
  pushAlong(d2, ['q'], { q: { start: 5, end: 10 } }, 'start');
  assert.deepEqual(d2.clips.map(c => [c.start, c.duration, c.in]), [[0, 5, 0], [5, 6, 2], [11, 2, 0]]);
});
