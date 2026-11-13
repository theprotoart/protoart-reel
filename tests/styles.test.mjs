import test from 'node:test';
import assert from 'node:assert/strict';
import { STYLES, applyStyle, removeStyle, pickTransition, seeded, snapCutsToBeats, ENERGY, energyOf } from '../app/renderer/lib/styles.js';
import { clipEnd } from '../app/renderer/model.js';

const doc = (n = 5) => ({
  canvas: { width: 1920, height: 1080 }, tracks: [{ id: 'v' }],
  media: [{ id: 'm', kind: 'video', hasAudio: true, duration: 60 }],
  clips: Array.from({ length: n }, (_, i) => ({ id: 'c' + i, type: 'media', media: 'm', track: 'v', start: i * 3, duration: 3, in: 5 + i * 3, speed: 1, props: { x: 0.5, y: 0.5, scale: 1 }, audio: { volume: 1 },
    transIn: { type: 'none', dur: 0.5 }, transOut: { type: 'none', dur: 0.5 }, name: 'shot' + i })),
});

test('randomize: 0 follows the pack, a little keeps the same kind, full can be anything', () => {
  const list = ['flash-cut', 'punch-zoom'];
  assert.deepEqual([0, 1, 2].map(i => pickTransition(list, i, 0)), ['flash-cut', 'punch-zoom', 'flash-cut']);
  const rng = seeded(7), mild = Array.from({ length: 200 }, (_, i) => pickTransition(list, i, 0.4, rng));
  assert.ok(mild.every(t => list.includes(t) || ENERGY.hard.includes(t)));
  assert.ok(mild.some(t => !list.includes(t)));
  const wild = Array.from({ length: 300 }, (_, i) => pickTransition(list, i, 1, seeded(i)));
  assert.ok(new Set(wild.map(energyOf)).size === 3);
});

test('every style applies: transitions on the cuts, the look, graphics, sounds; and comes off again', () => {
  for (const id of Object.keys(STYLES)) {
    const d = doc();
    const r = applyStyle(d, id, { seed: 1 });
    assert.ok(!r.error, id + ': ' + r.error);
    assert.ok(r.cuts >= 4, id);
    const shots = d.clips.filter(c => c.type === 'media' && !c.style);
    assert.ok(shots.every(c => c.filters?.some(f => f.style)), id + ' look');
    assert.ok(shots.slice(1).every(c => c.transIn.type !== 'none'), id + ' transitions');
    assert.ok(d.clips.some(c => c.style), id + ' graphics');
    assert.ok(r.sfx.length > 0, id + ' sounds');
    for (const c of d.clips.filter(x => x.style)) assert.ok(c.start >= 0 && clipEnd(c) <= 15 + 4.01, `${id} ${c.name} inside the edit`);
    removeStyle(d);
    assert.ok(!d.clips.some(c => c.style) && !d.tracks.some(t => t.style), id + ' removed');
    assert.ok(d.clips.every(c => !(c.filters || []).some(f => f.style)));
  }
});

test('trailer: the words sit above their black cards', () => {
  const d = doc(8); applyStyle(d, 'trailer', { seed: 4 });
  const idx = c => d.tracks.findIndex(t => t.id === c.track);
  for (const k of d.clips.filter(c => c.name === 'Title card')) {
    const words = d.clips.filter(c => c.type === 'text' && c.start < k.start + k.duration && c.start + c.duration > k.start);
    assert.ok(words.length && words.every(w => idx(w) < idx(k)), 'text above the card');
  }
});

test('sports adds an instant replay at half speed', () => {
  const d = doc(); applyStyle(d, 'sports', { seed: 2 });
  const r = d.clips.find(c => c.name === 'Instant replay');
  assert.ok(r); assert.equal(r.start, 15); assert.equal(r.speed, 0.5); assert.equal(r.duration, 4);
});

test('cuts snap to the beat with a roll edit (the edit keeps its length)', () => {
  const d = doc();
  const n = snapCutsToBeats(d, 'v', [3.2, 5.9, 9.3, 20]);
  assert.equal(n, 3);
  const v = d.clips.sort((p, q) => p.start - q.start);
  assert.deepEqual(v.map(c => +c.start.toFixed(2)), [0, 3.2, 5.9, 9.3, 12]);
  for (let i = 1; i < v.length; i++) assert.ok(Math.abs(v[i].start - clipEnd(v[i - 1])) < 1e-9);
  assert.ok(Math.abs(v[1].in - (5 + 3 + 0.2)) < 1e-9, 'source moves with the cut');
});
