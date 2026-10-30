// Built-in sound effects and graphic elements.
import test from 'node:test';
import assert from 'node:assert';
import { SFX, makeSfx } from '../app/renderer/lib/sfx.js';
import { ELEMENTS, drawElement } from '../app/renderer/lib/elements.js';

test('every sound effect renders, has sound, and stays below full scale', () => {
  for (const id of Object.keys(SFX)) {
    const [L, R] = makeSfx(id, 48000);
    assert.equal(L.length, Math.round(SFX[id].len * 48000), id);
    let pk = 0, e = 0; for (let i = 0; i < L.length; i++) { pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i])); e += L[i] * L[i]; }
    assert.ok(pk > 0.05 && pk <= 0.9 && Number.isFinite(e), `${id}: peak ${pk}`);
  }
});
test('every element draws at every moment without errors', () => {
  const calls = { n: 0 };
  const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : typeof k === 'string' && /^(measureText)$/.test(k) ? () => ({ width: 100 }) : k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => { calls.n++; }), set: (o, k, v) => { o[k] = v; return true; } });
  for (const k of Object.keys(ELEMENTS)) for (const t of [0, 0.1, 0.5, 1, 1.5, 2.9, 3, 4]) drawElement(ctx, { kind: k }, { x: 0.5, y: 0.5, scale: 1, opacity: 1 }, t, 4, 1920, 1080);
  assert.ok(calls.n > 100);
});
