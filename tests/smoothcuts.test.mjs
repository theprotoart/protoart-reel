import test from 'node:test';
import assert from 'node:assert/strict';
import { smoothCuts } from '../app/renderer/model.js';

const media = [{ id: 'v', kind: 'video', hasAudio: true, duration: 600 }, { id: 'm', kind: 'audio', hasAudio: true, duration: 600 }];
const C = (id, start, duration, inPt, extra = {}) => ({ id, type: 'media', media: 'v', track: 't', start, duration, in: inPt, audio: { volume: 1 }, ...extra });
const doc = clips => ({ media, tracks: [{ id: 't' }], clips });

test('a jump cut (footage removed between two clips) gets a short crossfade', () => {
  const d = doc([C('a', 0, 10, 0), C('b', 10, 10, 30)]); // 10–30 s of the recording was cut out
  assert.equal(smoothCuts(d, 0.1), 1);
  assert.equal(d.clips[0].xfadeOut, 0.1); assert.equal(d.clips[1].xfadeIn, 0.1);
});

test('a plain split of continuous footage is left alone', () => {
  const d = doc([C('a', 0, 10, 0), C('b', 10, 10, 10)]);
  assert.equal(smoothCuts(d, 0.1), 0);
  assert.ok(!d.clips[0].xfadeOut);
});

test('no footage to blend with: the sound gets tiny fades instead', () => {
  const d = doc([C('a', 0, 10, 590), C('b', 10, 10, 0)]); // a ends at the very end of its file, b starts at 0
  smoothCuts(d, 0.1);
  assert.ok(!d.clips[0].xfadeOut);
  assert.ok(d.clips[0].audio.fadeOut > 0 && d.clips[1].audio.fadeIn > 0);
});

test('next to a gap the sound fades, and the fades go again when the gap closes', () => {
  const d = doc([C('a', 0, 10, 0), C('b', 15, 10, 40)]);
  smoothCuts(d, 0.1);
  assert.ok(d.clips[0].audio.fadeOut > 0 && d.clips[1].audio.fadeIn > 0);
  d.clips[1].start = 10; // gap closed: a crossfade instead, and the auto fades are taken back
  smoothCuts(d, 0.1);
  assert.equal(d.clips[0].audio.fadeOut, 0); assert.equal(d.clips[1].audio.fadeIn, 0);
  assert.equal(d.clips[1].xfadeIn, 0.1);
});

test('a cut you set to a straight Cut (NONE) stays hard; your own fades are kept; locked tracks are left', () => {
  const d = doc([C('a', 0, 10, 0), C('b', 10, 10, 30, { hardCut: true })]);
  assert.equal(smoothCuts(d, 0.1), 0);
  const e = doc([C('a', 0, 10, 0, { audio: { volume: 1, fadeOut: 1 } }), C('b', 15, 10, 40)]);
  smoothCuts(e, 0.1);
  assert.equal(e.clips[0].audio.fadeOut, 1, 'your own longer fade stays');
  const f = doc([C('a', 0, 10, 0), C('b', 10, 10, 30)]); f.tracks[0].locked = true;
  assert.equal(smoothCuts(f, 0.1), 0);
});

test('speed up to 64× is allowed', async () => {
  const { setSpeed } = await import('../app/renderer/model.js');
  const d = { tracks: [{ id: 't' }], clips: [{ id: 'a', type: 'media', track: 't', start: 0, duration: 64, in: 0, actions: [] }], markers: [], captions: [] };
  setSpeed(d, d.clips[0], 64, 'start');
  assert.equal(d.clips[0].speed, 64);
  assert.ok(Math.abs(d.clips[0].duration - 1) < 1e-9);
});
