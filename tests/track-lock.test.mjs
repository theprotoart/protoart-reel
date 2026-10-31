import test from 'node:test';
import assert from 'node:assert/strict';
import { removeRange, insertTime, isFree, applyTrackLocks, split } from '../app/renderer/model.js';

const clip = (id, track, start, duration) => ({ id, type: 'media', media: 'm', track, start, duration, in: 0, speed: 1, props: { crop: [0, 0, 0, 0] }, actions: [] });
const doc = () => ({ tracks: [{ id: 'v' }, { id: 'music', locked: true }], media: [], markers: [], captions: [],
  clips: [clip('a', 'v', 0, 10), clip('b', 'v', 10, 10), clip('song', 'music', 0, 30)] });

test('a locked track locks its clips, and unlocking gives back only those', () => {
  const d = doc(); d.clips[0].locked = true; // a clip locked on its own
  applyTrackLocks(d);
  assert.equal(d.clips[2].locked, true);
  d.tracks[1].locked = false; applyTrackLocks(d);
  assert.equal(d.clips[2].locked, undefined);
  assert.equal(d.clips[0].locked, true); // still locked: the track didn't lock it
});

test('ripple edits leave a locked track exactly as it is', () => {
  const d = doc(); applyTrackLocks(d);
  removeRange(d, 5, 12);
  const song = d.clips.find(c => c.id === 'song');
  assert.deepEqual([song.start, song.duration], [0, 30]);
  assert.equal(d.clips.filter(c => c.track === 'v').reduce((n, c) => n + c.duration, 0), 13);
  insertTime(d, 2, 4);
  assert.deepEqual([song.start, song.duration], [0, 30]);
  split(d, 15, null);
  assert.equal(d.clips.filter(c => c.track === 'music').length, 1);
});

test('nothing new can be put on a locked track', () => {
  const d = doc();
  assert.equal(isFree(d, 'music', 40, 5), false);
  assert.equal(isFree(d, 'v', 40, 5), true);
});
