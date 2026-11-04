import test from 'node:test';
import assert from 'node:assert/strict';
import { FxChain, FX_TYPES } from '../app/renderer/lib/trackfx.js';

const RATE = 48000, D = 64;
function run(L, R, params = {}) {
  const ch = new FxChain(RATE).setup([{ id: 'd', type: 'declick', params }]);
  for (let s = 0; s < L.length; s += 128) ch.process(L.subarray(s, s + 128), R.subarray(s, s + 128));
}

test('De-click is a track effect you can pick', () => { assert.equal(FX_TYPES.declick.name, 'De-click'); });

test('De-click removes clicks and leaves the voice alone (about 1.3 ms late)', () => {
  const n = RATE; // 1 s: a 220 Hz tone with a little noise, plus 6 sharp clicks
  const clean = new Float32Array(n);
  let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let i = 0; i < n; i++) clean[i] = 0.3 * Math.sin(2 * Math.PI * 220 * i / RATE) + 0.002 * rnd();
  const dirty = Float32Array.from(clean);
  const at = [5000, 12000, 20011, 30000, 41000, 47000];
  for (const k of at) { dirty[k] += 0.6; dirty[k + 1] -= 0.4; }
  const L = Float32Array.from(dirty), R = Float32Array.from(dirty);
  run(L, R);
  for (const k of at) {
    let worst = 0; for (let i = k - 5; i < k + 10; i++) worst = Math.max(worst, Math.abs(L[i + D] - clean[i]));
    assert.ok(worst < 0.05, `click at ${k} repaired (error ${worst.toFixed(3)})`);
  }
  // away from the clicks the sound comes through untouched, just delayed
  let diff = 0, cnt = 0;
  for (let i = 1000; i < n - D; i++) if (!at.some(k => Math.abs(i - k) < 60)) { diff = Math.max(diff, Math.abs(L[i + D] - dirty[i])); cnt++; }
  assert.ok(diff < 1e-6, `untouched elsewhere (max change ${diff})`);
  assert.ok(cnt > 40000);
});
