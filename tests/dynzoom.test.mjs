import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDynZoom, getDynZoom, setDynZoomFrame, swapDynZoom, removeDynZoom, setDynZoomEase, unzoomed, setZoomAt, moveZoomKey, removeZoomKey, propsOfFrame, frameOfProps, hasDynZoom } from '../app/renderer/lib/dynzoom.js';
import { animated, keyAt } from '../app/renderer/model.js';

const clip = () => ({ id: 'c', type: 'media', start: 5, duration: 4, props: { x: 0.5, y: 0.5, scale: 1, opacity: 1, rotation: 0 } });
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} ≈ ${b}`);

test('a frame and the clip props it needs go back and forth', () => {
  const f = { fx: 0.3, fy: 0.7, s: 0.5 };
  const p = propsOfFrame(f);
  near(p.scale, 2);
  // the frame's centre lands in the middle of the screen
  near(p.x + (f.fx - 0.5) * p.scale, 0.5); near(p.y + (f.fy - 0.5) * p.scale, 0.5);
  const back = frameOfProps(p); near(back.fx, 0.3); near(back.fy, 0.7); near(back.s, 0.5);
});

test('dynamic zoom: START whole picture to END 75%, easing between them', () => {
  const c = clip();
  applyDynZoom(c);
  assert.ok(hasDynZoom(c));
  near(animated(c, 0).props.scale, 1);
  near(animated(c, 4).props.scale, 1 / 0.75);
  const linearMid = 1 + (1 / 0.75 - 1) / 2;
  near(animated(c, 2).props.scale, linearMid); // ease in & out is half way at the middle
  setDynZoomEase(c, 'in');
  assert.ok(animated(c, 1).props.scale < 1 + (1 / 0.75 - 1) * 0.25, 'ease in starts slowly');
  setDynZoomEase(c, 'out');
  assert.ok(animated(c, 1).props.scale > 1 + (1 / 0.75 - 1) * 0.25, 'ease out starts quickly');
});

test('moving and resizing the END frame, swapping, and removing', () => {
  const c = clip();
  applyDynZoom(c);
  setDynZoomFrame(c, 'end', { fx: 0.8, fy: 0.25, s: 0.4 });
  const dz = getDynZoom(c);
  near(dz.end.fx, 0.8); near(dz.end.fy, 0.25); near(dz.end.s, 0.4);
  near(dz.start.s, 1);
  swapDynZoom(c);
  near(getDynZoom(c).start.s, 0.4); near(getDynZoom(c).end.s, 1);
  setDynZoomFrame(c, 'start', { fx: 0.5, fy: 0.5, s: 0.001 }); // no smaller than a 20× zoom
  near(getDynZoom(c).start.s, 0.05);
  removeDynZoom(c);
  assert.equal(c.keys, undefined);
  near(c.props.scale, 20); // keeps the START framing
});

test('other keyframes stay when the zoom is added or removed', () => {
  const c = clip();
  c.keys = { 'props.opacity': [{ t: 0, v: 0 }, { t: 1, v: 1 }] };
  applyDynZoom(c); removeDynZoom(c);
  assert.equal(c.keys['props.opacity'].length, 2);
});

test('while framing, the preview shows the whole picture', () => {
  const c = clip();
  applyDynZoom(c, { start: { fx: 0.2, fy: 0.2, s: 0.5 } });
  const u = unzoomed(c);
  assert.equal(u.keys, undefined);
  assert.deepEqual([u.props.x, u.props.y, u.props.scale], [0.5, 0.5, 1]);
  assert.ok(c.keys['props.scale'], 'the clip itself is untouched');
});

test('the Zoom lane: a key changes the zoom without moving the middle of the screen', () => {
  const c = clip();
  applyDynZoom(c, { start: { fx: 0.3, fy: 0.6, s: 1 }, end: { fx: 0.3, fy: 0.6, s: 0.5 } });
  setZoomAt(c, 2, 3);
  const f = frameOfProps(animated(c, 2).props);
  near(f.fx, 0.3, 1e-6); near(f.fy, 0.6, 1e-6); near(1 / f.s, 3, 1e-6);
  moveZoomKey(c, 2, 1);
  assert.ok(['props.scale', 'props.x', 'props.y'].every(p => c.keys[p].some(k => Math.abs(k.t - 1) < 1e-9)), 'x and y move with it');
  removeZoomKey(c, 1);
  assert.equal(c.keys['props.scale'].length, 2);
});

test('ease in and ease out keyframes work on any keyed value', () => {
  const list = [{ t: 0, v: 0, ease: 'in' }, { t: 1, v: 1 }];
  near(keyAt(list, 0.5, 0), 0.25);
  list[0].ease = 'out'; near(keyAt(list, 0.5, 0), 0.75);
  list[0].ease = 'hold'; near(keyAt(list, 0.5, 0), 0);
});
