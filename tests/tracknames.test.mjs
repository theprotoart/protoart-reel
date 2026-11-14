import test from 'node:test';
import assert from 'node:assert/strict';
import { autoNameTracks, deleteEmptyTracks, emptyTracks, normalize, addTrack } from '../app/renderer/model.js';

const doc = () => ({ media: [{ id: 'v', kind: 'video' }, { id: 'a', kind: 'audio' }], markers: [], captions: [],
  tracks: [{ id: 't1', name: 'Track 1' }, { id: 't2', name: 'Track 2' }, { id: 't3', name: 'Track 3' }, { id: 't4', name: 'Track 4' }, { id: 't5', name: 'Interview' }],
  clips: [{ id: 'c1', type: 'media', media: 'v', track: 't1' }, { id: 'c2', type: 'media', media: 'a', track: 't2' },
    { id: 'c3', type: 'text', track: 't3' }, { id: 'c4', type: 'media', media: 'a', track: 't5' }] });

test('tracks are named by what is on them, numbered top to bottom; your own names stay', () => {
  const d = doc();
  autoNameTracks(d);
  assert.deepEqual(d.tracks.map(t => t.name), ['Video 1', 'Audio 1', 'Video 2', 'Track 4', 'Interview']);
  // a picture moves onto the empty track: it becomes a video track, and the numbers follow the order
  d.clips.push({ id: 'c5', type: 'media', media: 'v', track: 't4' });
  autoNameTracks(d);
  assert.deepEqual(d.tracks.map(t => t.name), ['Video 1', 'Audio 1', 'Video 2', 'Video 3', 'Interview']);
  // a renamed track keeps its name even when it matches the pattern
  d.tracks[1].name = 'Audio 7'; d.tracks[1].named = true;
  autoNameTracks(d);
  assert.equal(d.tracks[1].name, 'Audio 7');
});

test('a brand new project starts with Video 1, and new tracks take their kind when something lands on them', () => {
  const d = { clips: [], media: [{ id: 'a', kind: 'audio' }] };
  normalize(d);
  assert.equal(d.tracks[0].name, 'Video 1');
  const t = addTrack(d);
  d.clips.push({ id: 'x', type: 'media', media: 'a', track: t.id, props: {}, actions: [] });
  autoNameTracks(d);
  assert.equal(t.name, 'Audio 1');
});

test('delete empty tracks: only the empty ones, and never the last track', () => {
  const d = doc();
  assert.deepEqual(emptyTracks(d).map(t => t.id), ['t4']);
  assert.equal(deleteEmptyTracks(d), 1);
  assert.deepEqual(d.tracks.map(t => t.id), ['t1', 't2', 't3', 't5']);
  const e = { tracks: [{ id: 'a' }, { id: 'b' }], clips: [] };
  assert.equal(deleteEmptyTracks(e), 1);
  assert.equal(e.tracks.length, 1);
});
