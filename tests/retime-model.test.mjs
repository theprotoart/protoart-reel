import { test } from 'node:test';
import assert from 'node:assert/strict';
import { split, trim, roll, sourceTime, setSpeed, normalize } from '../app/renderer/model.js';
import { movePoint, addPoint } from '../app/renderer/lib/retime.js';

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
const doc = () => {
  let r = addPoint([{ t: 0, s: 0 }, { t: 10, s: 10 }], 4);
  r = movePoint(r, 1, 6); // slow first part, fast second part
  return { canvas: { width: 1920, height: 1080, fps: 30 }, tracks: [{ id: 't1' }], markers: [], captions: [],
    media: [{ id: 'm', kind: 'audio', duration: 60, file: 'a.wav', hasAudio: true }],
    clips: [{ id: 'c', type: 'media', media: 'm', track: 't1', start: 5, duration: 10, in: 20, speed: 1, retime: r, props: {}, actions: [] }] };
};

test('the source follows the time map, and a split keeps every moment where it was', () => {
  const d = doc(), c = d.clips[0];
  near(sourceTime(c, 5 + 6), 24); // the marker: 4 s into the source plays at 6 s
  const before = [5.5, 8, 11, 13, 14.5].map(t => sourceTime(c, t));
  split(d, 12, ['c']);
  const [a, b] = d.clips.sort((x, y) => x.start - y.start);
  const at = t => sourceTime(t < 12 ? a : b, t);
  [5.5, 8, 11, 13, 14.5].forEach((t, i) => near(at(t), before[i]));
  assert.equal(a.retime.at(-1).t, a.duration); assert.equal(b.retime.at(-1).t, b.duration);
});

test('trimming the start or end keeps the rest of the timing', () => {
  const d = doc(), c = d.clips[0], m = d.media[0];
  const keep = sourceTime(c, 13);
  trim(d, c, 'start', 7, m); near(sourceTime(c, 13), keep); near(c.retime.at(-1).t, c.duration);
  trim(d, c, 'end', 14, m); near(sourceTime(c, 13), keep); near(c.retime.at(-1).t, c.duration);
});

test('a rolling edit and a speed change keep the map in step', () => {
  const d = doc(); const c = d.clips[0];
  split(d, 10, ['c']);
  const [a, b] = d.clips.sort((x, y) => x.start - y.start);
  const keep = sourceTime(b, 13);
  roll(d, a, b, 11); near(sourceTime(b, 13), keep); near(a.retime.at(-1).t, a.duration);
  setSpeed(d, b, 2); near(b.retime.at(-1).t, b.duration);
  void c;
});

test('a map that no longer fits the clip is cut to it when the project opens', () => {
  const d = doc(); d.clips[0].duration = 8;
  normalize(d);
  near(d.clips[0].retime.at(-1).t, 8);
  const bad = doc(); bad.clips[0].retime = [{ t: 0, s: 0 }, { t: 5, s: -1 }];
  normalize(bad);
  assert.equal(bad.clips[0].retime, undefined);
});
