import test from 'node:test';
import assert from 'node:assert/strict';
import { propsAt, applyCut, CUT_TRANSITIONS, OVERLAP_CUTS } from '../app/renderer/model.js';
import { SFX_FOR } from '../app/renderer/lib/sfx.js';

const clip = (start, duration) => ({ id: 'x' + start, type: 'media', start, duration, in: 0, speed: 1, props: {} });
const NEW = ['fast-wipe', 'glitch-blocks', 'warp-zoom', 'slide-shake', 'film-burn-vintage', 'match-move', 'match-graphic', 'vertigo'];

test('1.6.3 transitions are offered at cuts and have a sound', () => {
  for (const t of NEW) { assert.ok(CUT_TRANSITIONS.some(([x]) => x === t), t); assert.ok(SFX_FOR[t], t); }
});

test('both-shots-at-once cuts ride on a crossfade; the others are half on each side', () => {
  for (const t of NEW) {
    const a = clip(0, 10), b = clip(10, 10);
    applyCut(a, b, t, 0.8);
    assert.equal(a.transOut.type, t); assert.equal(b.transIn.type, t);
    if (OVERLAP_CUTS.has(t)) { assert.equal(a.xfadeOut, 0.8); assert.equal(b.xfadeIn, 0.8); } else assert.ok(!a.xfadeOut && !b.xfadeIn, t);
    // away from the cut nothing changes
    const p = propsAt(a, 5); assert.equal(p.x, 0.5); assert.equal(p.scale, 1);
  }
});

test('slide + shake: the new shot pushes the old one off, then shakes as it lands', () => {
  const a = clip(0, 10), b = clip(10, 10);
  applyCut(a, b, 'slide-shake', 0.8);
  assert.ok(propsAt(b, -0.39).x > 1.3, 'starts off to the right');
  assert.ok(propsAt(a, 10.39).x < -0.3, 'old shot pushed off to the left');
  const shake = [0.45, 0.5, 0.55].map(t => propsAt(b, t).x);
  assert.ok(shake.some(x => Math.abs(x - 0.5) > 0.002), 'shakes after landing');
  assert.equal(propsAt(b, 1.5).x, 0.5);
});

test('changing to an ordinary transition drops the crossfade', () => {
  const a = clip(0, 10), b = clip(10, 10);
  applyCut(a, b, 'match-move', 0.8); applyCut(a, b, 'warp-zoom', 0.8);
  assert.ok(!a.xfadeOut && !b.xfadeIn);
});

test('warp zoom and vertigo ramp zoom in towards the cut', () => {
  for (const t of ['warp-zoom', 'vertigo']) {
    const a = clip(0, 10), b = clip(10, 10); applyCut(a, b, t, 0.8);
    assert.ok(propsAt(a, 9.95).scale > propsAt(a, 9.7).scale && propsAt(a, 9.7).scale >= 1, t);
    assert.ok(propsAt(b, 0.05).scale > propsAt(b, 0.3).scale, t);
  }
  const a = clip(0, 10), b = clip(10, 10); applyCut(a, b, 'vertigo', 0.8);
  assert.ok(propsAt(a, 9.95).vertigo.s > 1.3);
});
