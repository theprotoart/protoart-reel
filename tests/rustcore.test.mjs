// reel-core (Rust) against the JavaScript it replaces: the same sound and the same learned ums must give the same
// ums. Runs where a reel-core binary is found (built by cargo, or REEL_CORE=/path); skipped elsewhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { RATE, train, findInSamples, packModel, unpackModel } from '../app/renderer/lib/umvoice.js';

const require = createRequire(import.meta.url);
const core = require('../app/engine/core.js');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = [process.env.REEL_CORE, path.join(root, 'native/reel-core/target/release/reel-core')].find(p => p && fs.existsSync(p));
const skip = bin ? false : 'no reel-core binary here (build it with cargo)';
if (bin) core.useBinary(bin);

let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
function voice(sec, formants, { f0 = 115, amp = 0.3 } = {}) {
  const n = Math.round(sec * RATE), src = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) { ph += f0 / RATE; if (ph >= 1) { ph -= 1; src[i] = 1; } }
  let out = src;
  for (const [fc, bw] of formants) {
    const r = Math.exp((-Math.PI * bw) / RATE), th = (2 * Math.PI * fc) / RATE, a1 = 2 * r * Math.cos(th), a2 = -r * r;
    const y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = out[i] + a1 * (y[i - 1] || 0) + a2 * (y[i - 2] || 0);
    out = y;
  }
  let pk = 0; for (const v of out) pk = Math.max(pk, Math.abs(v));
  const env = i => Math.min(1, i / (0.03 * RATE), (n - i) / (0.05 * RATE));
  return out.map((v, i) => (v / pk) * amp * env(i));
}
const UMM = [[250, 80], [1100, 150], [2300, 200]], UH = [[650, 90], [1200, 110], [2550, 160]];
const OTHER = [[[300, 70], [2300, 120], [3000, 200]], [[700, 100], [1700, 130], [2600, 160]], [[450, 80], [800, 100], [2800, 170]]];
const quiet = sec => new Float32Array(Math.round(sec * RATE)).map(() => (rnd() * 2 - 1) * 0.002);
const cat = parts => { const o = new Float32Array(parts.reduce((s, p) => s + p.length, 0)); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
const sentence = sec => { const p = []; let t = 0, i = 0; while (t < sec) { const d = 0.08 + rnd() * 0.14; p.push(voice(d, OTHER[i % 3], { f0: 110 + rnd() * 25 })); t += d; i++; } return cat(p); };

test('reel-core finds the same ums as the JavaScript, to the sample', { skip }, async () => {
  const takes = [0.8, 0.5, 0.3].map((d, i) => ({ word: 'umm', samples: cat([quiet(0.3), voice(d, UMM, { f0: 105 + i * 10 }), quiet(0.3)]) }))
    .concat([0.6, 0.4, 0.25].map((d, i) => ({ word: 'uh', samples: cat([quiet(0.3), voice(d, UH, { f0: 108 + i * 10 }), quiet(0.3)]) })));
  // stored and read back, as Reel does: the prints the helper gets are the rounded ones
  const model = unpackModel(packModel(train({ takes, speech: sentence(6) })));
  const parts = [quiet(0.4)];
  for (let k = 0; k < 12; k++) parts.push(sentence(1.5), quiet(0.3), voice(0.3 + (k % 4) * 0.12, k % 2 ? UH : UMM, { f0: 104 + k * 2 }), quiet(0.35));
  const x = cat(parts);
  const js = findInSamples(model, x);
  const rs = await core.umFind(JSON.parse(packModel(model)), x);
  assert.ok(js.length >= 8, `the JavaScript found ${js.length}`);
  assert.equal(rs.length, js.length, JSON.stringify({ js: js.map(h => h.t), rs: rs.map(h => h.t) }));
  rs.forEach((h, i) => {
    assert.equal(h.t, js[i].t); assert.equal(h.end, js[i].end); assert.equal(h.word, js[i].word); assert.equal(h.sure, js[i].sure);
    assert.ok(Math.abs(h.d - js[i].d) < 1e-6 * Math.max(1, js[i].d), `${h.d} vs ${js[i].d}`);
  });
});

test('reel-core refuses a damaged job instead of trusting it', { skip }, async () => {
  const good = core.encodeUmFind({ threshold: 1, words: [{ word: 'umm', prints: [[new Array(12).fill(0)]] }], nots: [] }, new Float32Array(1600));
  await assert.rejects(core.run(good.subarray(0, good.length - 100)), /ended early|larger than the job/);
  const lie = Buffer.from(good); lie.writeUInt32LE(0xffffffff, 'RCORE1\numfind\n'.length + 8); // claims 4 billion words
  await assert.rejects(core.run(lie), /larger than the job/);
  await assert.rejects(core.run(Buffer.from('hello')), /not a reel-core job|ended early/);
  assert.equal(await core.version(), '0.1.0');
});
