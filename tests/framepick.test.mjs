import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameScore, pickFrames, sampleTimes, popFilter } from '../app/renderer/lib/framepick.js';

const W = 64, H = 36;
const img = fn => { const a = new Uint8ClampedArray(W * H * 4); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [r, g, b] = fn(x, y), i = (y * W + x) * 4; a[i] = r; a[i + 1] = g; a[i + 2] = b; a[i + 3] = 255; } return a; };

test('a sharp, colourful frame beats a black, a flat and a blurry one', () => {
  const sharp = frameScore(img((x, y) => ((x >> 2) + (y >> 2)) % 2 ? [230, 60, 40] : [30, 120, 220]), W, H);
  const black = frameScore(img(() => [4, 4, 4]), W, H);
  const flat = frameScore(img(() => [128, 128, 128]), W, H);
  const blurry = frameScore(img(x => [100 + x, 100 + x, 120 + x]), W, H);
  assert.ok(sharp > blurry && blurry > flat - 1e-9 && sharp > black);
  assert.ok(black < 1 && flat < 1);
});

test('the picks are the best ones, spread out, in time order', () => {
  const list = [{ t: 1, score: 9 }, { t: 1.5, score: 8.9 }, { t: 5, score: 5 }, { t: 9, score: 7 }, { t: 12, score: 1 }];
  assert.deepEqual(pickFrames(list, 3, 2).map(f => f.t), [1, 5, 9]);
});

test('sample times skip the very start and end', () => {
  const t = sampleTimes(100, 5);
  assert.equal(t.length, 5);
  assert.ok(t[0] > 0 && t[4] < 100 && t[0] < t[1]);
  assert.equal(popFilter(0), 'none');
  assert.match(popFilter(1), /contrast\(1\.28/);
});
