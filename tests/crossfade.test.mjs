import assert from 'node:assert/strict';
import { crossfadeOverlaps, mergeOverlapTracks, activeClips, propsAt, gainAt, spanStart, spanEnd, clipEnd, split, normalize, tidyCrossfades } from '../app/renderer/model.js';

const clip = (id, track, start, duration, extra = {}) => ({ id, type: 'media', media: 'm', track, start, duration, in: 10, speed: 1, props: {}, actions: [], transIn: { type: 'none', dur: 0.5 }, transOut: { type: 'none', dur: 0.5 }, audio: { volume: 1 }, ...extra });
const doc = () => normalize({ canvas: { width: 1920, height: 1080, fps: 30 }, media: [{ id: 'm', kind: 'video', hasAudio: true }], tracks: [{ id: 'ov', name: 'Screen (overlap)' }, { id: 'base', name: 'Screen' }], clips: [] });

// a ScreenFlow cross-dissolve on its own layer folds back into one track
{
  const d = doc();
  d.clips.push(clip('a', 'base', 0, 10), clip('c', 'base', 14, 6));
  d.clips.push(clip('b', 'ov', 9, 5, { transIn: { type: 'fade', dur: 1 } })); // overlaps a by 1 s, meets c at 14
  const n = mergeOverlapTracks(d);
  assert.equal(n, 1);
  assert.deepEqual(d.tracks.map(t => t.id), ['base'], 'the overlap layer is gone');
  const [a, b] = ['a', 'b'].map(id => d.clips.find(c => c.id === id));
  assert.equal(b.track, 'base');
  assert.ok(Math.abs(clipEnd(a) - 9.5) < 1e-9 && Math.abs(b.start - 9.5) < 1e-9, 'they meet at the middle of the overlap');
  assert.ok(Math.abs(b.in - 10.5) < 1e-9, 'the incoming clip is trimmed from the front, so its picture lines up as before');
  assert.equal(a.xfadeOut, 1); assert.equal(b.xfadeIn, 1);
  assert.equal(b.transIn, null, 'the fade became the crossfade');
  assert.equal(spanEnd(a), 10); assert.equal(spanStart(b), 9);
  // mid-crossfade both clips are drawn, incoming on top, half-way in; sound equal-power
  const on = activeClips(d, 9.5).map(c => c.id);
  assert.deepEqual(on, ['a', 'b']);
  assert.ok(Math.abs(propsAt(b, 0).opacity - 0.5) < 1e-6);
  const ga = gainAt(d, a, 9.5 - a.start), gb = gainAt(d, b, 0);
  assert.ok(Math.abs(ga * ga + gb * gb - 1) < 1e-6, 'equal power');
  assert.deepEqual(activeClips(d, 8.9).map(c => c.id), ['a']);
  assert.deepEqual(activeClips(d, 10.1).map(c => c.id), ['b']);
}

// a moving transition becomes the same transition at the cut, no layer
{
  const list = [clip('a', 't', 0, 10), clip('b', 't', 9, 5, { transIn: { type: 'push', dur: 1 } })];
  crossfadeOverlaps(list);
  assert.equal(list[0].transOut.type, 'push'); assert.equal(list[1].transIn.type, 'push');
  assert.ok(!list[1].xfadeIn);
}

// splitting a clip doesn't make a crossfade inside it; moving one side away removes the crossfade
{
  const d = doc();
  d.clips.push(clip('a', 'base', 0, 10), clip('b', 'base', 9, 5, { transIn: { type: 'fade', dur: 1 } }));
  crossfadeOverlaps(d.clips);
  const [r] = split(d, 12, ['b']);
  const right = d.clips.find(c => c.id === r), b = d.clips.find(c => c.id === 'b');
  assert.ok(!right.xfadeIn && !b.xfadeOut && b.xfadeIn === 1);
  b.start += 3; tidyCrossfades(d);
  assert.ok(!b.xfadeIn && !d.clips.find(c => c.id === 'a').xfadeOut);
}
console.log('crossfade ok');
