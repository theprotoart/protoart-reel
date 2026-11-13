import test from 'node:test';
import assert from 'node:assert/strict';
import { splitEdit, smashCut, jumpCut, cutOnAction, cutaway, crossCut, piecesOf } from '../app/renderer/lib/filmcuts.js';
import { clipEnd, sourceTime } from '../app/renderer/model.js';

const doc = () => ({
  canvas: { width: 1920, height: 1080 }, tracks: [{ id: 'v' }, { id: 's' }],
  media: [{ id: 'ma', kind: 'video', hasAudio: true, duration: 30 }, { id: 'mb', kind: 'video', hasAudio: true, duration: 30 }],
  clips: [
    { id: 'a', type: 'media', media: 'ma', track: 'v', start: 0, duration: 6, in: 5, speed: 1, props: { scale: 1 }, audio: { volume: 1 }, transIn: { type: 'none', dur: 0.5 }, transOut: { type: 'none', dur: 0.5 } },
    { id: 'b', type: 'media', media: 'mb', track: 'v', start: 6, duration: 6, in: 5, speed: 1, props: { scale: 1 }, audio: { volume: 1 }, transIn: { type: 'none', dur: 0.5 }, transOut: { type: 'none', dur: 0.5 } },
  ],
});
const get = (d, id) => d.clips.find(c => c.id === id);

test('L-cut: the first shot’s sound carries on under the next picture, in sync', () => {
  const d = doc(), a = get(d, 'a'), b = get(d, 'b');
  const r = splitEdit(d, a, b, 'l-cut', 1);
  assert.ok(!r.error, r.error); assert.equal(r.lead, 1);
  const [sa, sb] = r.sounds.map(id => get(d, id));
  assert.equal(clipEnd(sa), 7); assert.equal(sb.start, 7);
  assert.ok(a.audio.mute && b.audio.mute, 'pictures muted, the sounds play');
  assert.equal(sourceTime(sb, 8), sourceTime(b, 8), 'next sound stays in sync with its picture');
  assert.equal(sourceTime(sa, 6.5), 5 + 6.5, 'first sound keeps playing its own source');
  assert.equal(sa.track, sb.track);
  // and back to a J-cut
  const j = splitEdit(d, a, b, 'j-cut', 1);
  assert.ok(!j.error, j.error); assert.equal(clipEnd(sa), 5); assert.equal(sb.start, 5);
  assert.equal(sourceTime(sb, 5.5), sourceTime(b, 5.5) );
});

test('whole clips (no spare sound): J-cut skips the start of the next picture, L-cut moves the picture cut earlier', () => {
  const d = doc(); const a = get(d, 'a'), b = get(d, 'b'); b.in = 0; d.media[1].duration = 6;
  const j = splitEdit(d, a, b, 'j-cut', 1);
  assert.ok(!j.error && j.tight, j.error);
  const [sa, sb] = j.sounds.map(id => get(d, id));
  assert.equal(b.start, 6); assert.equal(b.in, 1); assert.equal(clipEnd(b), 11);
  assert.equal(sb.start, 5); assert.equal(clipEnd(sa), 5);
  assert.ok(Math.abs(sourceTime(sb, 7) - sourceTime(b, 7)) < 1e-9, 'in step');

  const e = doc(); const a2 = get(e, 'a'), b2 = get(e, 'b'); a2.in = 24; // a's media ends where the clip ends
  e.clips.push({ ...structuredClone(b2), id: 'c', start: 12, in: 0 });
  const l = splitEdit(e, a2, b2, 'l-cut', 1);
  assert.ok(!l.error && l.tight, l.error);
  const [la, lb] = l.sounds.map(id => get(e, id));
  assert.equal(clipEnd(a2), 5); assert.equal(b2.start, 5); assert.equal(clipEnd(la), 6); assert.equal(lb.start, 6);
  assert.ok(Math.abs(sourceTime(lb, 8) - sourceTime(b2, 8)) < 1e-9, 'in step');
  assert.equal(get(e, 'c').start, 11, 'the next clip moved up');
});

test('smash cut, cut on action, jump cut, cutaway', () => {
  const d = doc(), a = get(d, 'a'), b = get(d, 'b');
  a.xfadeOut = 1; b.xfadeIn = 1;
  assert.equal(smashCut(d, a, b).sfx[0].id, 'hit'); assert.ok(!a.xfadeOut && b.hardCut);
  cutOnAction(d, a, b); assert.ok(Math.abs(b.in - 4.92) < 1e-9); assert.equal(b.transIn.type, 'blur-through');
  const j = jumpCut(d, a, 3, 0.4); const r = get(d, j.ids[0]);
  assert.equal(r.start, 3); assert.ok(Math.abs(r.in - 8.4) < 1e-9); assert.ok(r.props.scale > 1.1);
  const before = d.tracks.length, cw = cutaway(d, a, b, 1, 2.5), c = get(d, cw.ids[0]);
  assert.equal(c.duration, 2.5); assert.ok(c.audio.mute); assert.equal(d.tracks.length, before + 1); assert.equal(d.tracks[0].id, c.track);
});

test('cross-cut lays the two scenes out turn about, in the same place, sound with its picture', () => {
  assert.deepEqual(piecesOf(6, 2.5, 0).map(x => +x.toFixed(2)), [2.5, 3.5]);
  const d = doc();
  const r = crossCut(d, get(d, 'a'), get(d, 'b'), 2, 0.15);
  assert.ok(r.pieces >= 4);
  const v = d.clips.filter(c => c.track === 'v').sort((p, q) => p.start - q.start);
  assert.deepEqual(v.map(c => c.media).slice(0, 4), ['ma', 'mb', 'ma', 'mb']);
  for (let i = 1; i < v.length; i++) assert.ok(Math.abs(v[i].start - clipEnd(v[i - 1])) < 1e-9);
  assert.ok(Math.abs(clipEnd(v[v.length - 1]) - 12) < 1e-9);
});

test('auto L & J cuts take turns on every cut with sound', async () => {
  const { autoSplitEdits } = await import('../app/renderer/lib/filmcuts.js');
  const d = doc();
  d.clips.push({ ...structuredClone(d.clips[0]), id: 'c', start: 12, in: 15 });
  const n = autoSplitEdits(d, 'v', 0.8);
  assert.equal(n, 2);
  const kinds = d.clips.filter(c => c.audioOnly).map(c => c.filmCut);
  assert.ok(kinds.includes('j-cut') && kinds.includes('l-cut'));
});
