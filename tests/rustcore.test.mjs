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
// The core under test must be this source's: the version in Cargo.toml. A copy that won't run here (built for
// another system) or is older is skipped, except in the build's own check (REEL_CORE_STRICT), which must not skip.
const want = fs.readFileSync(path.join(root, 'native/reel-core/Cargo.toml'), 'utf8').match(/^version = "([^"]+)"/m)[1];
const bin = [process.env.REEL_CORE, path.join(root, 'native/reel-core/target/release/reel-core')].find(p => p && fs.existsSync(p));
if (bin) core.useBinary(bin);
const have = bin ? await core.version() : null;
const skip = have === want ? false
  : process.env.REEL_CORE_STRICT ? false
  : bin ? `the reel-core here is ${have ? 'version ' + have : 'one this computer can’t run'}, not ${want}: rebuild it with cargo` : 'no reel-core binary here (build it with cargo)';
test('the build\'s reel-core is this source\'s', { skip: !process.env.REEL_CORE_STRICT && 'only in the build\'s own check' }, () => assert.equal(have, want));

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
  assert.equal(await core.version(), want);
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

// ---------------------------------------------------------------- step 3: the core mixes a sound-only export
import { exportMixJob, sourceRange, mixClip, softClip, pcm24 } from '../app/renderer/lib/mixplan.js';
import { FxChain } from '../app/renderer/lib/trackfx.js';

function mixDoc() {
  return {
    canvas: { width: 1920, height: 1080, fps: 30 }, mixGain: 2.5,
    mixFx: [{ id: 'lim', type: 'limiter', params: { ceiling: -3, release: 60 } }],
    media: [{ id: 'm1', kind: 'audio', hasAudio: true, file: 'voice.wav' }, { id: 'm2', kind: 'audio', hasAudio: true, file: 'music.wav' }],
    tracks: [{ id: 't1', auto: { volume: [{ t: 0, v: 1 }, { t: 3, v: 0.6 }, { t: 5, v: 1.1 }] } }, { id: 't2', auto: { pan: [{ t: 0, v: -0.5 }, { t: 6, v: 0.5 }] } }],
    clips: [
      { id: 'a', type: 'media', media: 'm1', track: 't1', start: 0.2, in: 0.5, duration: 4, speed: 1, xfadeOut: 0.5, audio: { volume: 1.6, pan: 0.2, fadeIn: 0.3, fadeOut: 0.6 } },
      { id: 'b', type: 'media', media: 'm1', track: 't1', start: 4.2, in: 2, duration: 2.5, speed: 1.25, xfadeIn: 0.5, audio: { keepPitch: false, fadeOut: 0.4 } },
      { id: 'c', type: 'media', media: 'm2', track: 't2', start: 0, in: 0, duration: 7, speed: 1, audio: { volume: 0.9 } },
      { id: 'd', type: 'media', media: 'm2', track: 't2', start: 1, in: 1, duration: 1, audio: { mute: true } },
    ],
  };
}

test('reel-core mixes a sound-only export the same as the JavaScript export, to the 24-bit sample', { skip }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-mix-'));
  try {
    let s2 = 3; const r = () => ((s2 = (s2 * 16807) % 2147483647) / 2147483647);
    writeWav(path.join(dir, 'voice.wav'), { rate: 48000, channels: 2, bits: 16, frames: 48000 * 8, sample: (i, c) => 0.45 * Math.sin(i * (c ? 0.031 : 0.027)) + 0.2 * (r() - 0.5) });
    writeWav(path.join(dir, 'music.wav'), { rate: 44100, channels: 1, bits: 24, frames: 44100 * 9, sample: i => 0.5 * Math.sin(i * 0.011) * Math.sin(i * 0.0002) });
    const doc = mixDoc();
    const { job, why } = exportMixJob(doc, 0.3, 6.9, { codec: 'wav', bitrate: 192000 });
    assert.ok(job, why);
    assert.equal(job.plans.length, 3, 'the muted clip is left out');
    // the JavaScript export's steps (export-worker.js mixBlock → mix gain → mix bus → softClip → 24-bit), block by block
    const RATE = 48000, BLOCK = 1024, chain = new FxChain(RATE).setup(doc.mixFx);
    const srcs = await Promise.all(job.sources.map(f => jsAudio(path.join(dir, f))));
    const want = Buffer.alloc(job.total * 6);
    for (let pos = 0, o = 0; pos < job.total; pos += BLOCK) {
      const n = Math.min(BLOCK, job.total - pos), L = new Float32Array(n), R = new Float32Array(n);
      for (const p of job.plans) {
        const src = srcs[p.src], range = sourceRange(p, pos, n, RATE, src.rate);
        if (range) mixClip(L, R, pos, n, p, await src.read(range[0], range[1] - range[0]), range[0], RATE, src.rate);
      }
      for (let i = 0; i < n; i++) { L[i] *= job.mixGain; R[i] *= job.mixGain; }
      for (let q = 0; q < n; q += 512) chain.process(L.subarray(q, Math.min(n, q + 512)), R.subarray(q, Math.min(n, q + 512)));
      softClip(L, R);
      for (let i = 0; i < n; i++) for (const v of [L[i], R[i]]) want.writeIntLE(pcm24(v), (o++) * 3, 3);
    }
    srcs.forEach(a => a.close());
    const out = path.join(dir, 'out.wav');
    let ticks = 0;
    await core.mix({ ...job, sources: job.sources.map(f => path.join(dir, f)) }, out, () => { ticks++; });
    const got = fs.readFileSync(out);
    assert.equal(got.length, 44 + want.length);
    assert.equal(got.toString('latin1', 0, 4) + got.toString('latin1', 8, 12), 'RIFFWAVE');
    assert.equal(got.readUInt16LE(34), 24); assert.equal(got.readUInt32LE(24), 48000); assert.equal(got.readUInt32LE(40), want.length);
    let diff = 0, worst = 0, loud = 0;
    for (let i = 0; i < job.total * 2; i++) {
      const a = got.readIntLE(44 + i * 3, 3), b = want.readIntLE(i * 3, 3);
      if (Math.abs(b) > 0.3 * 8388607) loud++;
      if (a !== b) { diff++; worst = Math.max(worst, Math.abs(a - b)); }
    }
    assert.ok(loud > 1000, 'loud enough to test the limiter and soft limit');
    // tanh may differ in its last bit between JavaScript and Rust: at most a 24-bit step, very rarely
    assert.ok(worst <= 1 && diff < job.total * 2 * 1e-4, `${diff} samples differ, by up to ${worst}`);
    t.diagnostic(`${job.total * 2} samples, ${loud} of them loud; ${diff} differ (by up to ${worst} in 8388607)`);
    assert.ok(ticks >= 1, 'progress was reported');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reel-core adds click sounds the same as the JavaScript export, to the 24-bit sample', { skip }, async t => {
  const { clicksBetween } = await import('../app/renderer/cursor.js');
  const { clickSample } = await import('../app/renderer/lib/click.js');
  const { sourceTime } = await import('../app/renderer/model.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-clicks-'));
  try {
    writeWav(path.join(dir, 'voice.wav'), { rate: 48000, channels: 2, bits: 16, frames: 48000 * 8, sample: (i, c) => 0.2 * Math.sin(i * (c ? 0.031 : 0.027)) });
    writeWav(path.join(dir, 'music.wav'), { rate: 44100, channels: 1, bits: 24, frames: 44100 * 9, sample: i => 0.2 * Math.sin(i * 0.011) });
    const doc = mixDoc();
    // a screen clip (no sound of its own) with recorded clicks, cut, sped up a little and quieter
    doc.media.push({ id: 'scr', kind: 'video', file: 'screen.mov', cursor: 'cur.json', cursorOffset: 0.37 });
    doc.clips.push({ id: 's1', type: 'media', media: 'scr', track: 't3', start: 0.1, in: 1.2, duration: 3.1, speed: 1, cursor: { clickSound: 0.8 } },
      { id: 's2', type: 'media', media: 'scr', track: 't3', start: 3.2, in: 6, duration: 3.5, speed: 1.5, cursor: { clickSound: 0.5 } });
    const clicks = []; for (let ms = 300; ms < 13000; ms += 137 + (ms % 7) * 31) { clicks.push([ms, 'd']); clicks.push([ms + 60, 'u']); }
    const cursors = new Map([['scr', { clicks }]]);
    const from = 0.3, to = 6.9;
    const { job, why } = exportMixJob(doc, from, to, { codec: 'wav', bitrate: 192000, cursors });
    assert.ok(job && job.clicks && job.clicks.clips.length === 2, why);
    // export-worker.js: per 1024-frame block, mixBlock → gain → mix bus → click sounds → softClip → 24-bit
    const RATE = 48000, BLOCK = 1024, chain = new FxChain(RATE).setup(doc.mixFx), CLICK = clickSample(RATE);
    const srcs = await Promise.all(job.sources.map(f => jsAudio(path.join(dir, f))));
    const want = Buffer.alloc(job.total * 6);
    const clickClips = doc.clips.filter(c => c.cursor?.clickSound > 0);
    let heard = 0;
    for (let pos = 0, o = 0; pos < job.total; pos += BLOCK) {
      const n = BLOCK, L = new Float32Array(n), R = new Float32Array(n), t0 = from + pos / RATE, t1 = t0 + n / RATE;
      for (const p of job.plans) { const src = srcs[p.src], range = sourceRange(p, pos, n, RATE, src.rate); if (range) mixClip(L, R, pos, n, p, await src.read(range[0], range[1] - range[0]), range[0], RATE, src.rate); }
      for (let i = 0; i < n; i++) { L[i] *= job.mixGain; R[i] *= job.mixGain; }
      for (let q = 0; q < n; q += 512) chain.process(L.subarray(q, Math.min(n, q + 512)), R.subarray(q, Math.min(n, q + 512)));
      for (const c of clickClips) {
        if (c.start + c.duration <= t0 || c.start >= t1) continue;
        const s0 = sourceTime(c, Math.max(t0 - 0.05, c.start)), s1 = sourceTime(c, Math.min(t1, c.start + c.duration));
        for (const st of clicksBetween(cursors.get(c.media), 0.37, s0, s1)) {
          const at = Math.round((c.start + (st - (c.in || 0)) / (c.speed || 1) - t0) * RATE), g = c.cursor.clickSound;
          heard++;
          for (let i = Math.max(0, -at); i < CLICK.length && at + i < n; i++) { L[at + i] += CLICK[i] * g; R[at + i] += CLICK[i] * g; }
        }
      }
      softClip(L, R);
      const k = Math.min(n, job.total - pos);
      for (let i = 0; i < k; i++) for (const v of [L[i], R[i]]) want.writeIntLE(pcm24(v), (o++) * 3, 3);
    }
    srcs.forEach(a => a.close());
    assert.ok(heard > 20, `enough clicks to test (${heard})`);
    const out = path.join(dir, 'out.wav');
    await core.mix({ ...job, sources: job.sources.map(f => path.join(dir, f)) }, out, () => {});
    const got = fs.readFileSync(out);
    assert.equal(got.length, 44 + want.length);
    let diff = 0, worst = 0;
    for (let i = 0; i < job.total * 2; i++) { const a = got.readIntLE(44 + i * 3, 3), b = want.readIntLE(i * 3, 3); if (a !== b) { diff++; worst = Math.max(worst, Math.abs(a - b)); } }
    assert.ok(worst <= 1 && diff < job.total * 2 * 1e-4, `${diff} samples differ, by up to ${worst}`);
    t.diagnostic(`${heard} clicks; ${diff} of ${job.total * 2} samples differ (by up to ${worst})`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reel-core exports to a loudness target the same as the JavaScript master path, to the 24-bit sample', { skip }, async t => {
  const { LoudnessMeter, TruePeakLimiter } = await import('../app/renderer/lib/master.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-loud-'));
  try {
    let s2 = 5; const r = () => ((s2 = (s2 * 16807) % 2147483647) / 2147483647);
    writeWav(path.join(dir, 'voice.wav'), { rate: 48000, channels: 2, bits: 16, frames: 48000 * 8, sample: (i, c) => 0.3 * Math.sin(i * (c ? 0.031 : 0.027)) * (0.5 + 0.5 * Math.sin(i * 0.00007)) + 0.15 * (r() - 0.5) });
    writeWav(path.join(dir, 'music.wav'), { rate: 44100, channels: 1, bits: 24, frames: 44100 * 9, sample: i => 0.4 * Math.sin(i * 0.011) * Math.sin(i * 0.0002) });
    const doc = mixDoc(), from = 0.3, to = 6.9;
    const { job, why } = exportMixJob(doc, from, to, { codec: 'wav', bitrate: 192000, loudness: -14, ceiling: -1 });
    assert.ok(job && job.loud && job.soft === false, why);
    // the JavaScript steps: the mix pass (export-worker.js mode 'mix': mixBlock, no soft limit), measured by
    // LoudnessMeter, turned by the gain, then TruePeakLimiter and 24-bit (export-worker.js master path)
    const RATE = 48000, BLOCK = 1024;
    const srcs = await Promise.all(job.sources.map(f => jsAudio(path.join(dir, f))));
    const mixAll = async frames => {
      const chain = new FxChain(RATE).setup(doc.mixFx), L = new Float32Array(frames), R = new Float32Array(frames);
      for (let pos = 0; pos < frames; pos += BLOCK) {
        const n = Math.min(BLOCK, frames - pos), l = L.subarray(pos, pos + n), rr = R.subarray(pos, pos + n);
        for (const p of job.plans) { const src = srcs[p.src], range = sourceRange(p, pos, n, RATE, src.rate); if (range) mixClip(l, rr, pos, n, p, await src.read(range[0], range[1] - range[0]), range[0], RATE, src.rate); }
        for (let i = 0; i < n; i++) { l[i] *= job.mixGain; rr[i] *= job.mixGain; }
        for (let q = 0; q < n; q += 512) chain.process(l.subarray(q, Math.min(n, q + 512)), rr.subarray(q, Math.min(n, q + 512)));
      }
      return [L, R];
    };
    const [mL, mR] = await mixAll(job.loud.measure);
    const meter = new LoudnessMeter(RATE);
    for (let p = 0; p < mL.length; p += RATE * 10) meter.push(mL.subarray(p, p + RATE * 10), mR.subarray(p, p + RATE * 10));
    const lufs = meter.integrated(), gain = Math.pow(10, Math.min(20, -14 - lufs) / 20);
    const lim = new TruePeakLimiter(-1, RATE), want = Buffer.alloc(job.total * 6);
    for (let pos = 0, o = 0; pos < job.total; pos += BLOCK) {
      const n = Math.min(BLOCK, job.total - pos), L = Float32Array.from(mL.subarray(pos, pos + n)), R = Float32Array.from(mR.subarray(pos, pos + n));
      for (let i = 0; i < n; i++) { L[i] *= gain; R[i] *= gain; }
      lim.process(L, R);
      for (let i = 0; i < n; i++) for (const v of [L[i], R[i]]) want.writeIntLE(pcm24(v), (o++) * 3, 3);
    }
    srcs.forEach(a => a.close());
    const out = path.join(dir, 'out.wav');
    const res = await core.mix({ ...job, sources: job.sources.map(f => path.join(dir, f)) }, out, () => {});
    assert.ok(Math.abs(res.loudness - lufs) < 1e-9, `measured ${res.loudness} vs ${lufs}`);
    const got = fs.readFileSync(out);
    assert.equal(got.length, 44 + want.length);
    let diff = 0, worst = 0;
    for (let i = 0; i < job.total * 2; i++) { const a = got.readIntLE(44 + i * 3, 3), b = want.readIntLE(i * 3, 3); if (a !== b) { diff++; worst = Math.max(worst, Math.abs(a - b)); } }
    assert.ok(worst <= 1 && diff < job.total * 2 * 1e-4, `${diff} samples differ, by up to ${worst}`);
    t.diagnostic(`loudness ${lufs.toFixed(2)} LUFS → -14 (gain ${(20 * Math.log10(gain)).toFixed(2)} dB); ${diff} of ${job.total * 2} samples differ (by up to ${worst})`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('what the core can\'t mix yet goes to the JavaScript export, with the reason', () => {
  const doc = mixDoc();
  assert.ok(exportMixJob(doc, 0, 5, { codec: 'wav' }).job);
  assert.equal(exportMixJob({ ...doc, mixFx: [...doc.mixFx, { type: 'reverb' }] }, 0, 5, { codec: 'wav' }).why, 'mix bus effects');
  assert.equal(exportMixJob({ ...doc, tracks: [{ ...doc.tracks[0], fx: [{ type: 'eq' }] }, doc.tracks[1]] }, 0, 5, { codec: 'wav' }).why, 'track effects');
  const pitched = mixDoc(); pitched.clips[1].audio.keepPitch = true;
  assert.equal(exportMixJob(pitched, 0, 7, { codec: 'wav' }).why, 'speed changes that keep pitch');
  const clicks = mixDoc(); clicks.clips[0].cursor = { clickSound: 0.5 };
  assert.equal(exportMixJob(clicks, 0, 5, { codec: 'wav' }).why, 'click sounds');
  // a bypassed limiter is simply not there
  const off = mixDoc(); off.mixFx[0].off = true;
  assert.deepEqual(exportMixJob(off, 0, 5, { codec: 'wav' }).job.limiters, []);
});

test('reel-core finds the same soft sounds you taught (breaths) as the JavaScript', { skip }, async () => {
  const breath = sec => { const n = Math.round(sec * RATE), o = new Float32Array(n); let y1 = 0; for (let i = 0; i < n; i++) { y1 = 0.6 * y1 + (rnd() * 2 - 1); o[i] = y1 * 0.012 * Math.sin(Math.PI * i / n); } return o; };
  const { addTake } = await import('../app/renderer/lib/umvoice.js');
  let m = train({ takes: [0.7, 0.45, 0.3].map(d => ({ word: 'umm', samples: cat([quiet(0.2), voice(d, UMM), quiet(0.2)]) })), speech: sentence(5) });
  for (const d of [0.5, 0.4, 0.6]) m = addTake(m, 'breath', cat([quiet(0.15), breath(d), quiet(0.15)]), null);
  m = unpackModel(packModel(m));
  const parts = [quiet(0.3)];
  for (let k = 0; k < 8; k++) parts.push(sentence(1.6), quiet(0.25), k % 2 ? breath(0.35 + k * 0.03) : voice(0.4, UMM, { f0: 106 + k }), quiet(0.3));
  const x = cat(parts);
  const js = findInSamples(m, x), rs = await core.umFind(JSON.parse(packModel(m)), x);
  assert.ok(js.some(h => h.word === 'breath'), 'breaths found');
  assert.deepEqual(rs.map(h => [h.t, h.end, h.word, h.sure]), js.map(h => [h.t, h.end, h.word, h.sure]));
});
