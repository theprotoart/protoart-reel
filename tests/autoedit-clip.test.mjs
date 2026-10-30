import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { removeRange, insertTime, duration } from '../app/renderer/model.js';
// isolate / splice live in autoedit.js (which needs a browser): load just those two functions
const src = readFileSync(new URL('../app/renderer/autoedit.js', import.meta.url), 'utf8');
const from = src.indexOf('export function isolate'), to = src.indexOf('/** Right-click › Auto Edit This Clip');
const { isolate, splice } = new Function('removeRange', 'insertTime', 'docDuration', src.slice(from, to).replaceAll('export function', 'function') + '\nreturn { isolate, splice };')(removeRange, insertTime, duration);

const clip = (id, start, duration, track) => ({ id, type: 'media', media: 'm', track, start, duration, in: 0, speed: 1, props: { crop: [0, 0, 0, 0] }, actions: [] });
const doc = () => ({ tracks: [{ id: 't1' }, { id: 't2' }], media: [{ id: 'm', file: 'a.mp4', kind: 'video', duration: 999 }], clips: [
  clip('a', 0, 10, 't1'), clip('b', 10, 20, 't1'), clip('bm', 10, 20, 't2'), clip('c', 30, 15, 't1') ], markers: [{ id: 'k', t: 40 }], captions: [] });

test('isolate keeps only the clip and its group, starting at 0', () => {
  const sub = isolate(doc(), 10, 30);
  assert.deepEqual(sub.clips.map(c => [c.id, c.start, c.duration]).sort(), [['b', 0, 20], ['bm', 0, 20]]);
});

test('splice puts the shortened clip back and moves what follows', () => {
  const full = doc(), sub = isolate(full, 10, 30);
  for (const c of sub.clips) c.duration = 12; // Auto Edit made it 8 s shorter
  const out = splice(full, sub, 10, 30);
  const at = id => out.clips.find(c => c.id === id);
  assert.equal(at('a').start, 0); assert.equal(at('a').duration, 10);
  assert.equal(at('b').start, 10); assert.equal(at('b').duration, 12);
  assert.equal(at('c').start, 22); // was 30, moved 8 s earlier
  assert.equal(out.markers[0].t, 32);
  assert.equal(out.clips.length, 4);
});
