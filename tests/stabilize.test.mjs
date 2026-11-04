import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateMotion, cumulative, corrections, stabilizeAt } from '../app/renderer/lib/stabilize.js';

const W = 192, H = 108;
// a textured scene (smooth blobs), sampled with a camera offset (ox, oy pixels) and turn (rad)
let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const blobs = Array.from({ length: 70 }, () => ({ x: rnd() * W * 1.6 - W * 0.3, y: rnd() * H * 1.6 - H * 0.3, r: 4 + rnd() * 14, v: rnd() * 255 }));
function frame(ox, oy, rot = 0) {
  const g = new Float32Array(W * H), c = Math.cos(rot), s = Math.sin(rot);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const px = x - W / 2, py = y - H / 2, X = c * px - s * py + W / 2 + ox, Y = s * px + c * py + H / 2 + oy;
    let v = 40;
    for (const b of blobs) { const d = (X - b.x) ** 2 + (Y - b.y) ** 2; if (d < b.r * b.r * 4) v += b.v * Math.exp(-d / (b.r * b.r)); }
    g[y * W + x] = Math.min(255, v);
  }
  return g;
}

test('finds how far the picture moved, to a fraction of a pixel', () => {
  const a = frame(0, 0), b = frame(3.4, -2.2);
  const m = estimateMotion(a, b, W, H);
  // the content moves opposite to the camera
  assert.ok(Math.abs(m.dx * W - -3.4) < 0.5, `dx ${(m.dx * W).toFixed(2)}`);
  assert.ok(Math.abs(m.dy * H - 2.2) < 0.5, `dy ${(m.dy * H).toFixed(2)}`);
  assert.ok(Math.abs(m.rot) < 0.01);
});

test('sees a small turn of the camera', () => {
  const m = estimateMotion(frame(0, 0), frame(0, 0, 0.03), W, H);
  assert.ok(Math.abs(Math.abs(m.rot) - 0.03) < 0.012, `rot ${m.rot.toFixed(4)}`);
});

test('smoothing keeps a slow pan and takes out the jitter', () => {
  const rate = 15, n = 150; // 10 s
  let s2 = 9; const r2 = () => ((s2 = (s2 * 16807) % 2147483647) / 2147483647 - 0.5);
  const moves = Array.from({ length: n }, () => ({ dx: 0.002 + r2() * 0.02, dy: r2() * 0.02, rot: 0 }));
  const path = cumulative(moves);
  const stab = { rate, t0: 0, x: path.x, y: path.y, r: path.r, smooth: 1.5 };
  const c = corrections(stab);
  // corrected path = path + correction: much less jitter than the raw one, but still panning
  const jit = a => { let s = 0; for (let i = 1; i < a.length - 1; i++) s += Math.abs(a[i + 1] - 2 * a[i] + a[i - 1]); return s / (a.length - 2); };
  const fixedX = path.x.map((v, i) => v + c.x[i]);
  assert.ok(jit(fixedX) < jit(path.x) * 0.15, `jitter ${jit(fixedX).toFixed(4)} vs ${jit(path.x).toFixed(4)}`);
  assert.ok(fixedX[n] - fixedX[0] > 0.2, 'the pan is kept');
  assert.ok(c.zoom > 1 && c.zoom < 1.35, `zoom ${c.zoom}`);
  const at = stabilizeAt(stab, 5.03);
  assert.ok(at && Number.isFinite(at.x) && at.zoom > 1);
  assert.equal(stabilizeAt({ ...stab, off: true }, 1), null);
});
