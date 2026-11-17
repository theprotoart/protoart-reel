// Finding the Mac's pointer in a video with no pointer file: made-up screens (text rows, a dark panel, icons and
// look-alikes: play buttons, triangles, an I-beam) with an arrow drawn smooth at sub-pixel places.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PointerTracker, arrowShape } from '../app/renderer/lib/pointerfind.js';

const ARROW = [[0, 0], [0, 15.5], [3.6, 12.2], [6.3, 18.3], [8.4, 17.4], [5.8, 11.4], [10.8, 11.4]];
const inside = (px, py, poly) => { let inn = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inn = !inn; } return inn; };
const segDist = (px, py, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy, k = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0; return Math.hypot(px - ax - k * dx, py - ay - k * dy); };
let seed = 5; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
function screen(W, H, dark) {
  const g = new Float32Array(W * H).fill(dark ? 40 : 238), ink = dark ? 215 : 30, put = (x, y, v) => { if (x >= 0 && y >= 0 && x < W && y < H) g[y * W + x] = v; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W * 0.2; x++) g[y * W + x] = dark ? 220 : 52;
  for (let row = 24; row < H - 16; row += 14) for (let x = Math.round(W * 0.24); x < W - 30; x += 7) if (rnd() < 0.8) { const ww = 3 + Math.floor(rnd() * 4); for (let y = row; y < row + 8; y++) for (let k = 0; k < ww; k++) if (rnd() < 0.55) put(x + k, y, ink); }
  for (let k = 0; k < 6; k++) { for (let y = 0; y < 14; y++) for (let x = 0; x <= 7 - Math.abs(y - 7); x++) put(150 + k * 50 + x, H - 30 + y, ink); for (let y = 0; y < 12; y++) for (let x = 0; x <= y * 0.7; x++) put(140 + k * 55 + x, 8 + y, ink); }
  for (let y = 0; y < 18; y++) put(W - 60, 100 + y, ink);
  return g;
}
function drawArrow(g, W, H, tx, ty, h) {
  const k = h / 18.3, poly = ARROW.map(([x, y]) => [tx + x * k, ty + y * k]), rim = 1.2 * k;
  for (let y = Math.floor(ty - rim - 1); y < ty + h + rim + 2; y++) for (let x = Math.floor(tx - rim - 1); x < tx + 11 * k + rim + 2; x++) {
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    let blk = 0, wht = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const px = x + (sx + 0.5) / 4, py = y + (sy + 0.5) / 4;
      if (inside(px, py, poly)) blk++; else { let d = Infinity; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; d = Math.min(d, segDist(px, py, a[0], a[1], b[0], b[1])); } if (d <= rim) wht++; }
    }
    g[y * W + x] = (wht * 255 + (16 - blk - wht) * g[y * W + x]) / 16;
  }
}
const W = 640, H = 360;
function run(dark, h) {
  const base = screen(W, H, dark), tr = new PointerTracker(W, H, 1920, 1080), truth = [];
  let x = 400, y = 200, found = 0, worst = 0;
  for (let i = 0; i < 80; i++) {
    if (i % 20 >= 8) { x += Math.sin(i * 0.7) * 30 - 5; y += Math.cos(i * 0.4) * 20; }
    x = Math.max(5, Math.min(W - 40, x)); y = Math.max(5, Math.min(H - 50, y));
    const px = x + 0.3 * (i % 3), g = base.slice(); drawArrow(g, W, H, px, y, h);
    const r = tr.push(i * 0.2, g); truth.push([i * 0.2, px, y]);
    if (r) { found++; worst = Math.max(worst, Math.hypot(r.x * W - px, r.y * H - y)); }
  }
  const empty = new PointerTracker(W, H); let falseFinds = 0;
  for (let i = 0; i < 12; i++) if (empty.push(i * 0.2, base)) falseFinds++;
  return { found: found / 80, worst, falseFinds, track: tr.track(), truth };
}

test('the arrow shape: dark body, light rim, at any size', () => {
  for (const h of [9, 12, 21, 37]) {
    const s = arrowShape(h);
    assert.ok(s.px.some(q => q[2] === 0) && s.px.some(q => q[2] >= 0.75), `size ${h}`);
    assert.equal(s.key.length, 3);
  }
});

for (const [name, dark, h] of [['a light screen, a 12 px pointer', false, 12], ['a dark screen, a 12 px pointer', true, 12], ['a light screen, a big (21 px) pointer', false, 21]]) {
  test(`finds the pointer on ${name}, to within a pixel, and nothing where there's none`, () => {
    const r = run(dark, h);
    assert.ok(r.found >= 0.9, `found in ${Math.round(r.found * 100)}% of frames`);
    assert.ok(r.worst < 1, `off by up to ${r.worst.toFixed(2)} px`);
    assert.equal(r.falseFinds, 0, 'look-alikes taken for the pointer');
  });
}

test('the pointer file it makes is in the video’s own pixels, like a recording’s', () => {
  const r = run(false, 12), f = r.track;
  assert.deepEqual(f.display.bounds, { x: 0, y: 0, width: 1920, height: 1080 });
  const [ms, x, y] = f.points[f.points.length - 1], tr = r.truth.find(q => Math.abs(q[0] * 1000 - ms) < 1);
  assert.ok(Math.abs(x - tr[1] * 3) < 3 && Math.abs(y - tr[2] * 3) < 3, `${x},${y} vs ${tr[1] * 3},${tr[2] * 3}`);
});
