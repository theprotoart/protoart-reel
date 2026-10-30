import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isFree } from '../app/renderer/model.js';
// buttUp lives in timeline.js (which needs a browser): load just that function
const src = readFileSync(new URL('../app/renderer/timeline.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('export function buttUp')).replace('export function', 'return function');
const buttUp = new Function('isFree', body)(isFree);

const clip = (id, start, duration, track = 't1') => ({ id, start, duration, track });
const orig = list => new Map(list.map(c => [c.id, { start: c.start, duration: c.duration, track: c.track }]));

test('a clip dragged into its neighbour lands flush against it', () => {
  const a = clip('a', 0, 10), b = clip('b', 30, 10);
  const doc = { clips: [a, b] };
  const plan = [{ id: 'b', start: 5, track: 't1', dur: 10 }]; // dragged to 5..15, over a
  const to = buttUp(doc, plan, ['b'], orig([b]), -25);
  assert.equal(to[0].start, 10); // b starts where a ends
});

test('a group of clips on two tracks butts up together', () => {
  const s1 = clip('s1', 0, 10, 't1'), m1 = clip('m1', 0, 10, 't2'), s2 = clip('s2', 20, 8, 't1'), m2 = clip('m2', 20, 8, 't2');
  const doc = { clips: [s1, m1, s2, m2] };
  const ids = ['s2', 'm2'];
  const plan = [{ id: 's2', start: 6, track: 't1', dur: 8 }, { id: 'm2', start: 6, track: 't2', dur: 8 }];
  const to = buttUp(doc, plan, ids, orig([s2, m2]), -14);
  assert.deepEqual(to.map(p => p.start), [10, 10]);
});
