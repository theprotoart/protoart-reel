import test from 'node:test';
import assert from 'node:assert/strict';
import { describeChange, menuCase } from '../app/renderer/lib/changes.js';

const base = () => ({ tracks: [{ id: 't1', name: 'Track 1' }, { id: 't2', name: 'Voice' }],
  clips: [{ id: 'a', type: 'media', media: 'm', track: 't1', start: 0, duration: 10, in: 0, audio: { volume: 1 } },
    { id: 'b', type: 'media', media: 'm', track: 't1', start: 12, duration: 5, in: 20, audio: { volume: 1 } }], captions: [] });
const edit = fn => { const a = base(), b = structuredClone(a); fn(b); return describeChange(a, b); };

test('undo and redo say what the step did', () => {
  assert.equal(edit(d => { d.clips[0].start = 3; d.clips[1].start = 20; }), 'move 2 clips');
  assert.equal(edit(d => { d.clips[0].duration = 8; }), 'trim 1 clip');
  assert.equal(edit(d => { d.clips[0].audio.volume = 0.5; }), 'change the volume of 1 clip');
  assert.equal(edit(d => { d.clips.splice(1, 1); }), 'delete 1 clip');
  assert.equal(edit(d => { d.clips[0].duration = 4; d.clips.push({ id: 'c', type: 'media', media: 'm', track: 't1', start: 4, duration: 6, in: 4, audio: { volume: 1 } }); }), 'split a clip');
  assert.equal(edit(d => { d.tracks[1].muted = true; }), 'mute “Voice”');
  assert.equal(edit(d => { d.tracks[1].role = 'dialogue'; }), 'label “Voice” Dialogue');
  assert.equal(edit(d => { d.captions = []; d.clips[0].transIn = { type: 'fade', dur: 0.5 }; }), 'change the transition on 1 clip');
  assert.equal(edit(d => { d.autoMix = { clips: {} }; d.clips[0].audio.volume = 3; }), 'Auto Mix');
  assert.equal(edit(d => { d.tracks.push({ id: 't3', name: 'New' }); }), 'add 1 track');
  assert.equal(edit(() => {}), 'change');
});

test('the Edit menu gets title case', () => {
  assert.equal(menuCase('move 2 clips'), 'Move 2 Clips');
  assert.equal(menuCase('change the volume of 1 clip'), 'Change the Volume of 1 Clip');
});
