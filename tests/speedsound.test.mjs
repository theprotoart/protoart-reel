import test from 'node:test';
import assert from 'node:assert/strict';
import { setSpeed, SOUND_MAX_SPEED } from '../app/renderer/model.js';

const doc = () => ({ tracks: [{ id: 'v' }, { id: 'a' }],
  media: [{ id: 'scr', kind: 'video', hasAudio: false, duration: 60 }, { id: 'mic', kind: 'audio', duration: 60 }],
  clips: [
    { id: 's', type: 'media', media: 'scr', track: 'v', start: 0, duration: 8, in: 0, speed: 1, group: 'g', props: {} },
    { id: 'm', type: 'media', media: 'mic', track: 'a', start: 0, duration: 8, in: 0, speed: 1, group: 'g', props: {}, audio: { volume: 1 } },
  ] });

test('speeding up a recording takes its microphone with it, and mutes it past 3×', () => {
  const d = doc(), s = d.clips[0], m = d.clips[1];
  setSpeed(d, s, 2);
  assert.equal(m.speed, 2); assert.equal(m.duration, 4); assert.ok(!m.audio.mute, 'still heard at 2×');
  setSpeed(d, s, 8);
  assert.equal(m.speed, 8); assert.equal(m.duration, 1); assert.ok(m.audio.mute && m.audio.speedMuted, 'muted at 8×');
  setSpeed(d, s, 1);
  assert.equal(m.duration, 8); assert.ok(!m.audio.mute, 'heard again at normal speed');
  assert.ok(SOUND_MAX_SPEED >= 2 && SOUND_MAX_SPEED <= 4);
});

test('a sound muted by hand stays muted when the speed comes back down', () => {
  const d = doc(), s = d.clips[0], m = d.clips[1];
  m.audio.mute = true;
  setSpeed(d, s, 8); setSpeed(d, s, 1);
  assert.ok(m.audio.mute);
});
