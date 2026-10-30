// The colour-range fix for early ScreenFlow conversions, on the headers of real files (4K and its proxy).
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const { findRangeFlag } = createRequire(import.meta.url)('../app/engine/fixrange.js');

test('finds and flips the full-range flag in real H.264 headers', () => {
  for (const hex of ['27640034ac56803c0043e9a808080810', '27640028ac1314501e0089f966a0202020f0804258']) {
    const nal = Buffer.from(hex, 'hex'), f = findRangeFlag(nal);
    assert.ok(f && f.value === 0, hex);
    nal[f.byte] |= f.mask;
    assert.equal(findRangeFlag(nal).value, 1);
  }
});
