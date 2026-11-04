import test from 'node:test';
import assert from 'node:assert/strict';
import { nextRole, guessRole, clipLoudness, gatedLufs, planMix, applyMix, planTidy, applyTidy, duckWeight, STYLES } from '../app/renderer/lib/automix.js';

// a steps array (K-weighted mean square per 100 ms) for a steady sound at `lufs`
const steady = (lufs, seconds) => new Float32Array(Math.round(seconds * 10)).fill(10 ** ((lufs + 0.691) / 10));
const media = [
  { id: 'mv', file: 'rec-1-mic.wav', kind: 'audio', role: 'mic', duration: 600, hasAudio: true },
  { id: 'mm', file: 'Lofi beat.mp3', kind: 'audio', duration: 180, hasAudio: true },
  { id: 'ms', file: 'whoosh.wav', kind: 'audio', duration: 1, hasAudio: true },
];
const clip = (id, track, m, start, duration, extra = {}) => ({ id, type: 'media', media: m, track, start, duration, in: 0, audio: { volume: 1 }, ...extra });

test('the role button goes round: none → dialogue → music → sound FX → none', () => {
  assert.equal(nextRole(undefined), 'dialogue');
  assert.equal(nextRole('dialogue'), 'music');
  assert.equal(nextRole('music'), 'effects');
  assert.equal(nextRole('effects'), null);
});

test('guesses: mic recordings are dialogue, songs are music, short hits are sound FX', () => {
  const doc = { media, tracks: [{ id: 'a', name: 'Track 1' }, { id: 'b', name: 'Track 2' }, { id: 'c', name: 'Track 3' }],
    clips: [clip('1', 'a', 'mv', 0, 30), clip('2', 'b', 'mm', 0, 60), clip('3', 'c', 'ms', 5, 0.8), clip('4', 'c', 'ms', 9, 0.8)] };
  assert.equal(guessRole(doc, doc.tracks[0]).role, 'dialogue');
  assert.equal(guessRole(doc, doc.tracks[1]).role, 'music');
  assert.equal(guessRole(doc, doc.tracks[2]).role, 'effects');
});

test('loudness of a clip comes from its own part of the file, and silence is ignored', () => {
  const steps = new Float32Array(200);
  steps.set(steady(-20, 10), 0); // first 10 s at −20 LUFS, the rest silent
  assert.ok(Math.abs(clipLoudness({ step: 0.1, steps }, { in: 2, duration: 5 }) - -20) < 0.2);
  assert.equal(clipLoudness({ step: 0.1, steps }, { in: 12, duration: 5 }), null);
  // a pause inside speech doesn't drag the number down (gating)
  const talk = new Float32Array(100); talk.set(steady(-18, 4), 0); talk.set(steady(-18, 4), 60);
  assert.ok(Math.abs(gatedLufs(talk) - -18) < 0.3);
});

test('AUTO MIX puts each role at its level: music under the voices by the style’s gap, and dips while they talk', () => {
  const doc = { media, tracks: [{ id: 'd', name: 'Voice' }, { id: 'm1', name: 'Music A' }, { id: 'm2', name: 'Music B', volume: 0.5 }, { id: 'e', name: 'FX' }],
    clips: [clip('v', 'd', 'mv', 0, 30), clip('ma', 'm1', 'mm', 0, 30), clip('mb', 'm2', 'mm', 30, 30), clip('s', 'e', 'ms', 3, 0.8)] };
  const measured = { v: -24, ma: -12, mb: -12, s: -10 };
  const roles = { d: 'dialogue', m1: 'music', m2: 'music', e: 'effects' };
  const S = STYLES.youtube;
  const plan = planMix(doc, roles, c => measured[c.id], { style: 'youtube' });
  const byId = Object.fromEntries(plan.clips.map(p => [p.id, p]));
  assert.ok(Math.abs(byId.v.toDb - (S.dialogue - -24)) < 1e-6);          // voice up 8 dB
  assert.ok(Math.abs(byId.ma.toDb - (S.music - -12)) < 1e-6);           // music down 14 dB
  // the second music track is already at half volume (−6 dB): the clip makes up the rest, so both sound the same
  assert.ok(Math.abs(byId.mb.toDb - (S.music - -12 - 20 * Math.log10(0.5))) < 1e-6);
  assert.ok(Math.abs(byId.s.toDb - (S.effects - -10)) < 1e-6);
  applyMix(doc, plan, roles, () => ({ id: 'lv', type: 'level', params: {} }));
  assert.equal(doc.tracks[0].role, 'dialogue');
  assert.ok(doc.tracks[0].fx.some(f => f.type === 'level'), 'Auto Level on the dialogue track');
  assert.equal(doc.tracks[1].duck, S.duck, 'music dips under dialogue');
  assert.ok(!doc.tracks[3].duck, 'sound FX don’t dip');
  // "more music" moves only the music
  const louder = planMix(doc, roles, c => measured[c.id], { style: 'youtube', music: 4 });
  assert.ok(Math.abs(louder.clips.find(p => p.id === 'ma').toDb - (S.music + 4 - -12)) < 1e-6);
});

test('the music dip fades in before the voice and out after it (no jumps)', () => {
  const doc = { tracks: [{ id: 'd', role: 'dialogue' }, { id: 'm', role: 'music', duck: 0.5 }], clips: [] };
  const voice = { id: 'v', track: 'd', start: 10, duration: 5, audio: {} }, music = { id: 'm1', track: 'm', start: 0, duration: 30, audio: {} };
  doc.clips.push(voice, music);
  assert.equal(duckWeight(doc, music, 5), 0);
  assert.equal(duckWeight(doc, music, 12), 1);
  const before = duckWeight(doc, music, 9.9), after = duckWeight(doc, music, 15.4);
  assert.ok(before > 0 && before < 1, 'already easing down just before the voice');
  assert.ok(after > 0 && after < 1, 'easing back up just after');
  assert.equal(duckWeight(doc, music, 16.5), 0);
});

test('Tidy tracks: same-colour plain tracks share one track, times kept; overlaps and tracks with settings stay', () => {
  const doc = { media, tracks: [{ id: 'm1', name: 'Music A' }, { id: 'm2', name: 'Music B' }, { id: 'm3', name: 'Music C', fx: [{ type: 'eq' }] }, { id: 'e1', name: 'FX 1' }, { id: 'e2', name: 'FX 2' }],
    clips: [clip('a', 'm1', 'mm', 0, 60), clip('b', 'm2', 'mm', 70, 20), clip('c', 'm3', 'mm', 100, 10),
      clip('x', 'e1', 'ms', 1, 1), clip('y', 'e2', 'ms', 1.5, 1), clip('z', 'e2', 'ms', 9, 1)] };
  const roles = { m1: 'music', m2: 'music', m3: 'music', e1: 'effects', e2: 'effects' };
  const t = planTidy(doc, roles);
  applyTidy(doc, t);
  assert.equal(doc.clips.find(c => c.id === 'b').track, 'm1', 'music B joins music A (no overlap)');
  assert.equal(doc.clips.find(c => c.id === 'b').start, 70, 'at the same time');
  assert.equal(doc.clips.find(c => c.id === 'c').track, 'm3', 'a track with its own effects stays');
  assert.ok(!doc.tracks.some(t => t.id === 'm2'), 'the emptied track goes');
  // FX: FX 2 has the most sound, so it's home; x overlaps y there, so x stays on its own track
  assert.equal(doc.clips.find(c => c.id === 'z').track, doc.clips.find(c => c.id === 'y').track);
  assert.equal(doc.clips.find(c => c.id === 'x').track, 'e1');
  assert.equal(doc.tracks.length, 4);
});

test('Remove Auto Mix puts every clip back at its own level and on its own track, even after running it twice', async () => {
  const { removeMix } = await import('../app/renderer/lib/automix.js');
  const doc = { media, tracks: [{ id: 'd', name: 'Track 1' }, { id: 'm1', name: 'Track 2' }, { id: 'm2', name: 'Music B', duck: 0.2 }],
    clips: [clip('v', 'd', 'mv', 0, 30, { audio: { volume: 0.8 } }), clip('a', 'm1', 'mm', 0, 20), clip('b', 'm2', 'mm', 40, 20, { audio: { volume: 0.5, duck: 0.3 } })] };
  const orig = JSON.parse(JSON.stringify(doc));
  const roles = { d: 'dialogue', m1: 'music', m2: 'music' };
  const measured = { v: -24, a: -12, b: -12 };
  for (const style of ['youtube', 'podcast']) { // twice: the memory of the first one is kept
    const plan = planMix(doc, roles, c => measured[c.id], { style });
    applyMix(doc, plan, roles, () => ({ id: 'lv', type: 'level', params: {} }));
    applyTidy(doc, planTidy(doc, roles));
  }
  assert.equal(doc.tracks.length, 2, 'the music tracks were tidied together');
  assert.equal(doc.tracks[0].name, 'Dialogue');
  removeMix(doc);
  assert.equal(doc.autoMix, undefined);
  assert.deepEqual(doc.tracks.map(t => t.id), ['d', 'm1', 'm2'], 'the tidied-away track is back in its place');
  for (const c of orig.clips) {
    const now = doc.clips.find(x => x.id === c.id);
    assert.equal(now.track, c.track, `${c.id} back on its track`);
    assert.equal(now.audio.volume, c.audio.volume, `${c.id} back at its level`);
    assert.equal(now.audio.duck || 0, c.audio.duck || 0);
  }
  assert.equal(doc.tracks[0].name, 'Track 1');
  assert.ok(!(doc.tracks[0].fx || []).some(f => f.type === 'level'), 'the Auto Level it added is gone');
  assert.equal(doc.tracks[2].duck, 0.2, 'the track’s own dip setting is back');
  assert.equal(doc.tracks[0].role, 'dialogue', 'your colour labels stay');
});

test('AUTO MIX can clean the dialogue (de-click first), and Remove Auto Mix takes that off again', async () => {
  const { removeMix } = await import('../app/renderer/lib/automix.js');
  const doc = { media, tracks: [{ id: 'd', name: 'Track 1' }, { id: 'm', name: 'Track 2' }], clips: [clip('v', 'd', 'mv', 0, 30), clip('a', 'm', 'mm', 0, 30)] };
  const roles = { d: 'dialogue', m: 'music' };
  let n = 0;
  const plan = planMix(doc, roles, () => -20, { style: 'youtube', clean: ['declick', 'gate'] });
  applyMix(doc, plan, roles, () => ({ id: 'fx' + n++, type: 'level', params: {} }));
  const types = doc.tracks[0].fx.map(f => f.type);
  assert.deepEqual(types.slice(0, 2), ['declick', 'gate'], 'clean-up goes before the levelling');
  assert.ok(types.includes('level'));
  assert.ok(!(doc.tracks[1].fx || []).some(f => f.type === 'declick'), 'music is left alone');
  removeMix(doc);
  assert.deepEqual(doc.tracks[0].fx || [], []);
});

test('the Music and Sound FX sliders go a long way down (−30 dB)', () => {
  const doc = { media, tracks: [{ id: 'm', name: 'Music' }], clips: [clip('a', 'm', 'mm', 0, 30)] };
  const p = planMix(doc, { m: 'music' }, () => -12, { style: 'youtube', music: -30 });
  assert.ok(Math.abs(p.clips[0].toDb - (STYLES.youtube.music - 30 - -12)) < 1e-6);
});
