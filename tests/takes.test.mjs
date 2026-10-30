import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mediaById, clipEnd, duration, removeRange } from '../app/renderer/model.js';
// takesOf lives in takes.js (which needs a browser): load just that function
const src = readFileSync(new URL('../app/renderer/takes.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('const isTakeMark'), src.indexOf('export const takeCount')).replace('export function', 'function');
const takesOf = new Function('mediaById', 'clipEnd', 'duration', body + '\nreturn takesOf;')(mediaById, clipEnd, duration);

const doc = () => ({
  tracks: [{ id: 't1' }, { id: 't2' }],
  media: [{ id: 'ms', recording: 'r1', name: 'Screen 10:56 AM', kind: 'video' }, { id: 'mm', recording: 'r1', name: 'Microphone 10:56 AM', kind: 'audio' }],
  clips: [{ id: 's', type: 'media', media: 'ms', track: 't1', start: 0, duration: 60 }, { id: 'm', type: 'media', media: 'mm', track: 't2', start: 0, duration: 60 }],
  markers: [{ id: 'k1', t: 20, end: 21, claps: true }, { id: 'k2', t: 40, end: 41, claps: true }, { id: 'ch', t: 50, label: 'Chapter 1' }],
  captions: [],
});

test('claps split a recording into takes; the ones before a clap are dropped, the last is kept', () => {
  const [g] = takesOf(doc());
  assert.equal(g.name, 'Recording 10:56 AM');
  assert.deepEqual(g.takes.map(t => [t.t0, t.t1, t.keep]), [[0, 20, false], [21, 40, false], [41, 60, true]]);
});

test('a take you keep stays; removing the dropped ones cuts them and their claps', () => {
  const d = doc();
  d.markers[0].keepTake = true;
  const cuts = takesOf(d).flatMap(g => g.takes.filter(t => !t.keep)).map(t => [t.t0, t.cutTo]).sort((a, b) => b[0] - a[0]);
  assert.deepEqual(cuts, [[21, 41]]);
  for (const [a, b] of cuts) removeRange(d, a, b);
  assert.equal(duration(d), 40); // 60 s minus the 19 s take and its 1 s of claps
  assert.ok(!d.markers.some(k => k.id === 'k2'));
});

test('no clap markers: no takes (ordinary markers don\'t count)', () => {
  const d = doc(); d.markers = [{ id: 'x', t: 10, label: 'Chapter' }];
  assert.equal(takesOf(d).length, 0);
});
