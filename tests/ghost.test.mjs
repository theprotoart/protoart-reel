import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as model from '../app/renderer/model.js';
// placeSeparated and canSeparate, without the window (ghost.js needs a browser for the rest)
const src = readFileSync(new URL('../app/renderer/ghost.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('/** A clip with sound to separate'), src.indexOf('let listen = null;')).replaceAll('export function', 'function');
const { canSeparate, placeSeparated } = new Function('mediaById', 'uid', 'addTrack', body + '\nreturn { canSeparate, placeSeparated };')(model.mediaById, model.uid, model.addTrack);

const doc = () => ({
  tracks: [{ id: 't1', name: 'Track 1' }, { id: 't2', name: 'Track 2' }],
  media: [{ id: 'v', kind: 'video', hasAudio: true, file: 'v.mp4' }, { id: 'p', kind: 'image', file: 'p.png' }],
  clips: [{ id: 'c', type: 'media', media: 'v', track: 't1', start: 5, duration: 20, in: 3, speed: 1, audio: { volume: 1, pan: 0.2, fadeIn: 1 } },
          { id: 'i', type: 'media', media: 'p', track: 't2', start: 0, duration: 5 }],
});
const r = { target: { file: 'dog-only.wav', name: 'dog (only)', duration: 20 }, residual: { file: 'without-dog.wav', name: 'Without dog', duration: 20 } };

test('only clips with sound can be separated', () => {
  const d = doc();
  assert.equal(canSeparate(d, d.clips[0]), true);
  assert.equal(canSeparate(d, d.clips[1]), false);
  assert.equal(canSeparate(d, { ...d.clips[0], reversed: true }), false);
});

test('keep only: the sound on a new track under the clip, in step, grouped, the clip muted', () => {
  const d = doc();
  const ids = placeSeparated(d, 'c', r, { keep: true, both: false, prompt: 'dog barking' });
  assert.equal(ids.length, 1);
  const n = d.clips.find(x => x.id === ids[0]), c = d.clips.find(x => x.id === 'c');
  assert.equal(d.media.find(m => m.id === n.media).file, 'dog-only.wav');
  assert.equal(d.tracks.findIndex(t => t.id === n.track), 1); // straight under Track 1
  assert.equal(d.tracks[1].name, 'Only: dog barking');
  assert.deepEqual([n.start, n.duration, n.in, n.speed], [5, 20, 0, 1]);
  assert.equal(n.group, c.group); assert.ok(c.group);
  assert.equal(c.audio.mute, true); assert.equal(n.audio.mute, false);
  assert.equal(n.audio.pan, 0.2); assert.equal(n.audio.fadeIn, 1);
});

test('remove, with the other part too: two tracks, the "without" one first', () => {
  const d = doc();
  const ids = placeSeparated(d, 'c', r, { keep: false, both: true, prompt: 'keyboard typing' });
  assert.equal(ids.length, 2);
  assert.deepEqual(d.tracks.slice(1, 3).map(t => t.name), ['Without: keyboard typing', 'Only: keyboard typing']);
  assert.equal(d.media.find(m => m.id === d.clips.find(x => x.id === ids[0]).media).file, 'without-dog.wav');
});
