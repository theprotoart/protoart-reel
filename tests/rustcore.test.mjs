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

// ---------------------------------------------------------------- step 2: the core reads a file and analyses it
import os from 'node:os';
import { WavAudio } from '../app/renderer/lib/sources.js';
import { peaksOf, levelsOf } from '../app/renderer/lib/analysis.js';

/** A WAV file: rate, channels, bits (16, 24, or 32 float), frames, and sample(i, c) in −1..1. */
function writeWav(file, { rate, channels, bits, frames, sample }) {
  const bps = bits / 8, fmt = bits === 32 ? 3 : 1, data = Buffer.alloc(frames * channels * bps);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
    const v = Math.max(-1, Math.min(1, sample(i, c))), o = (i * channels + c) * bps;
    if (bits === 32) data.writeFloatLE(v, o);
    else if (bits === 16) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), o);
    else data.writeIntLE(Math.max(-8388608, Math.min(8388607, Math.round(v * 8388607))), o, 3);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(fmt, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * bps, 28);
  h.writeUInt16LE(channels * bps, 32); h.writeUInt16LE(bits, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}
/** The editor's own WAV reader, over a file on disk instead of app:// */
async function jsAudio(file) {
  const fd = fs.openSync(file, 'r'), size = fs.fstatSync(fd).size;
  const reader = { size, async read(off, len) { const b = Buffer.alloc(Math.max(0, Math.min(len, size - off))); fs.readSync(fd, b, 0, b.length, off); return new Uint8Array(b.buffer, b.byteOffset, b.length); } };
  const a = await new WavAudio(reader).open();
  a.close = () => fs.closeSync(fd);
  return a;
}

for (const [name, spec] of [
  ['16-bit stereo, 48 kHz', { rate: 48000, channels: 2, bits: 16 }],
  ['24-bit mono, 44.1 kHz', { rate: 44100, channels: 1, bits: 24 }],
  ['32-bit float, 4 channels, 48 kHz', { rate: 48000, channels: 4, bits: 32 }],
]) {
  test(`reel-core reads a ${name} WAV itself and gives the same waveform and loudness as the JavaScript`, { skip }, async () => {
    const file = path.join(os.tmpdir(), `reel-core-${process.pid}-${spec.bits}-${spec.channels}.wav`);
    let s = 5; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    // speech-like bursts of noise and tone, pauses, a quiet stretch, and a length that isn't a whole step
    const frames = Math.round(spec.rate * 7.37);
    writeWav(file, { ...spec, frames, sample: (i, c) => { const t = i / spec.rate, on = Math.sin(t * 2.1) > -0.2 ? 1 : 0.01;
      return on * (0.4 * Math.sin(2 * Math.PI * (180 + 40 * c) * t) + 0.25 * (r() * 2 - 1)) * (t > 5 && t < 6 ? 0.001 : 1); } });
    try {
      const a = await jsAudio(file);
      const jp = await peaksOf(a), jl = await levelsOf(a);
      a.close();
      const rs = await core.analyze(file);
      assert.equal(rs.rate, spec.rate);
      assert.equal(rs.peaks.length, jp.data.length);
      assert.equal(rs.steps.length, jl.steps.length);
      assert.deepEqual(Array.from(rs.peaks), Array.from(jp.data), 'peaks match to the bit');
      rs.steps.forEach((v, i) => assert.ok(Math.abs(v - jl.steps[i]) <= 1e-6 * Math.max(jl.steps[i], 1e-9) + 1e-12, `step ${i}: ${v} vs ${jl.steps[i]}`));
    } finally { fs.rmSync(file, { force: true }); }
  });
}

test('reel-core refuses what isn\'t sound, and paths it shouldn\'t take', { skip }, async () => {
  const file = path.join(os.tmpdir(), `reel-core-${process.pid}-bad.wav`);
  fs.writeFileSync(file, 'not a sound file at all');
  try { await assert.rejects(core.analyze(file), /WAV/); } finally { fs.rmSync(file, { force: true }); }
  await assert.rejects(core.analyze('relative/path.wav'), /Bad file/);
  await assert.rejects(core.analyze(path.join(os.tmpdir(), 'reel-core-missing.wav')), /can't open/);
});
