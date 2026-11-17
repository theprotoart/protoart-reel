// A sound marked dialogue, music or sound effects lands on a track of its kind, never one marked for another.
import test from 'node:test';
import assert from 'node:assert/strict';
import { soundRoleOf, trackForRole } from '../app/renderer/lib/soundrole.js';

const doc = () => ({ canvas: { width: 1920, height: 1080 }, media: [], markers: [],
  tracks: [{ id: 'v', name: 'Video 1' }, { id: 'd', name: 'Voice', role: 'dialogue' }, { id: 'e', name: 'Empty' }],
  clips: [{ id: 'c1', type: 'media', track: 'd', start: 0, duration: 10 }] });

test('a sound’s kind: set by hand, else guessed from what it is, and none means none', () => {
  assert.equal(soundRoleOf({ kind: 'audio', soundRole: 'music' }), 'music');
  assert.equal(soundRoleOf({ kind: 'audio', role: 'mic' }), 'dialogue');
  assert.equal(soundRoleOf({ kind: 'audio', sfx: 'whoosh' }), 'effects');
  assert.equal(soundRoleOf({ kind: 'audio', role: 'mic', soundRole: '' }), null);
  assert.equal(soundRoleOf({ kind: 'audio' }), null);
  assert.equal(soundRoleOf({ kind: 'video', soundRole: 'music' }), null, 'only sounds');
});

test('music dropped on the dialogue track goes on a music track instead (made when there is none)', () => {
  const d = doc();
  const r = trackForRole(d, 'music', 20, 5, 'd');
  const t = d.tracks.find(x => x.id === r.track);
  assert.equal(r.moved, true);
  assert.equal(t.role, 'music'); assert.equal(t.name, 'Music');
  // the next one finds that track
  const r2 = trackForRole(d, 'music', 40, 5, null);
  assert.equal(r2.track, r.track);
});

test('dialogue dropped on its own kind of track, or an unmarked one, stays there', () => {
  const d = doc();
  assert.deepEqual(trackForRole(d, 'dialogue', 20, 5, 'd'), { track: 'd', moved: false });
  assert.deepEqual(trackForRole(d, 'dialogue', 20, 5, 'e'), { track: 'e', moved: false });
  // busy where it was dropped: the free one of its kind
  d.clips.push({ id: 'c2', type: 'media', track: 'e', start: 18, duration: 10 });
  const r = trackForRole(d, 'dialogue', 20, 5, 'e');
  assert.equal(r.track, 'd'); assert.equal(r.moved, true);
});
