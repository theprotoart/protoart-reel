import test from 'node:test';
import assert from 'node:assert/strict';
import { planBounce, bounceDoc, applyBounce, revertBounce } from '../app/renderer/lib/bounce.js';

let n = 0; const id = p => p + (n++);
const project = () => ({
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [{ id: 'mv', file: 'rec-mic.wav', name: 'Microphone', kind: 'audio', duration: 600, hasAudio: true }, { id: 'sv', file: 'rec-screen.mp4', kind: 'video', hasAudio: true, duration: 600 }],
  tracks: [{ id: 'v', name: 'Video' }, { id: 'd', name: 'VO1', volume: 0.8, pan: -0.2, role: 'dialogue', fx: [{ id: 'f1', type: 'declick', params: {} }, { id: 'f2', type: 'au', plugin: 'x', name: 'Pro-Q 4' }, { id: 'f3', type: 'level', off: true }], auto: { volume: [{ t: 0, v: 1 }] } }],
  clips: [
    { id: 'a', type: 'media', media: 'mv', track: 'd', start: 10, duration: 5, in: 20, speed: 1, audio: { volume: 5, fadeIn: 0.5, duck: 0.3 }, xfadeOut: 0.4, cursor: { clickSound: 1 } },
    { id: 'b', type: 'media', media: 'mv', track: 'd', start: 15, duration: 8, in: 40, speed: 2, audio: { volume: 1 }, xfadeIn: 0.4 },
    { id: 'v1', type: 'media', media: 'sv', track: 'v', start: 0, duration: 30, in: 0, audio: { volume: 1 } },
    { id: 't', type: 'text', track: 'v', start: 0, duration: 3 },
  ],
});

test('plan: sound clips per track, with their crossfade handles', () => {
  const doc = project();
  const g = planBounce(doc, ['a', 'b', 't']);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].clips.map(c => c.id), ['a', 'b'], 'the text clip has no sound');
  assert.equal(g[0].from, 10);
  assert.ok(Math.abs(g[0].to - 23) < 1e-9);
});

test('the render: only those clips, track neutral (fader and pan stay live), plug-ins already in the clips, no click sounds', () => {
  const doc = project();
  const [g] = planBounce(doc, ['a', 'b']);
  const m = bounceDoc(doc, g);
  assert.deepEqual(m.clips.map(c => c.id), ['a', 'b']);
  assert.deepEqual(m.tracks[0].fx.map(f => f.type), ['declick'], 'built-in effects that are on; plug-ins and bypassed ones left out');
  assert.equal(m.tracks[0].volume, undefined); assert.equal(m.tracks[0].auto, undefined);
  assert.equal(m.clips[0].cursor, undefined);
  assert.equal(m.clips[0].audio.volume, 5, 'clip volume is rendered in');
  assert.equal(m.clips[0].audio.duck, undefined, 'ducking stays live');
  assert.equal(m.media.length, 1);
});

test('apply: a new track right under the original, clips at the same times reading the right part of the file; originals muted', () => {
  const doc = project();
  const [g] = planBounce(doc, ['a', 'b']);
  const r = applyBounce(doc, g, { file: 'VO1 rendered.wav', name: 'VO1 rendered', seconds: 13 }, id);
  const nt = doc.tracks[doc.tracks.findIndex(t => t.id === 'd') + 1];
  assert.equal(nt.id, r.trackId);
  assert.equal(nt.name, 'VO1 · rendered');
  assert.equal(nt.volume, 0.8); assert.equal(nt.pan, -0.2); assert.equal(nt.role, 'dialogue');
  assert.ok(!nt.fx, 'the effects are in the file');
  const [na, nb] = r.clipIds.map(i => doc.clips.find(c => c.id === i));
  assert.equal(na.start, 10); assert.equal(na.duration, 5); assert.equal(na.in, 0);
  assert.equal(nb.start, 15); assert.equal(nb.duration, 8); assert.equal(nb.in, 5); assert.equal(nb.speed, 1, 'speed is rendered in');
  assert.equal(na.audio.volume, 1); assert.equal(na.audio.fadeIn, undefined); assert.equal(na.audio.duck, 0.3);
  assert.ok(doc.clips.find(c => c.id === 'a').audio.mute && doc.clips.find(c => c.id === 'b').audio.mute, 'originals muted');
  assert.equal(doc.media.at(-1).kind, 'audio');
});

test('back to the original sound: rendered copies, empty rendered track and media go; originals play again', () => {
  const doc = project();
  doc.clips.find(c => c.id === 'b').audio.mute = false;
  const [g] = planBounce(doc, ['a', 'b']);
  const r = applyBounce(doc, g, { file: 'x.wav', name: 'x', seconds: 13 }, id);
  assert.equal(revertBounce(doc, [r.clipIds[0], 'b']), 2);
  assert.ok(!doc.clips.some(c => c.bounceOf));
  assert.ok(!doc.tracks.some(t => t.bounceOf));
  assert.ok(!doc.media.some(m => m.bounceOf));
  for (const c of doc.clips.filter(c => ['a', 'b'].includes(c.id))) { assert.ok(!c.audio.mute); assert.equal(c.bounced, undefined); }
  assert.equal(planBounce(doc, ['a']).length, 1, 'can be bounced again');
});
