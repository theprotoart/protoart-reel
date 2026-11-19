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

test('reel-core plays sped-up clips that keep their pitch the same as the JavaScript export, to the 24-bit sample', { skip }, async t => {
  const { stretch } = await import('../app/renderer/lib/stretch.js');
  const { gainAt, panAt, panGains, spanStart, spanEnd } = await import('../app/renderer/model.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-stretch-'));
  try {
    let s2 = 9; const r = () => ((s2 = (s2 * 16807) % 2147483647) / 2147483647);
    writeWav(path.join(dir, 'voice.wav'), { rate: 48000, channels: 2, bits: 16, frames: 48000 * 8, sample: (i, c) => 0.35 * Math.sin(i * (c ? 0.031 : 0.027)) * (0.6 + 0.4 * Math.sin(i * 0.0003)) + 0.1 * (r() - 0.5) });
    writeWav(path.join(dir, 'music.wav'), { rate: 44100, channels: 1, bits: 24, frames: 44100 * 9, sample: i => 0.4 * Math.sin(i * 0.011) * Math.sin(i * 0.0002) });
    const doc = mixDoc();
    doc.clips[1].audio.keepPitch = true; // b: 1.25×, keeps its pitch (in order between two plain clips)
    doc.clips.push({ id: 'e', type: 'media', media: 'm2', track: 't3', start: 1.5, in: 2, duration: 3, speed: 0.8, audio: { volume: 0.7, pan: -0.3, fadeIn: 0.2 } }); // slowed, mono source at 44.1 kHz
    const from = 0.3, to = 6.9;
    const { job, why } = exportMixJob(doc, from, to, { codec: 'wav', bitrate: 192000 });
    assert.ok(job && job.stretch && job.stretch.clips.length === 2, why);
    const RATE = 48000, BLOCK = 1024, chain = new FxChain(RATE).setup(doc.mixFx);
    const srcs = await Promise.all(job.sources.map(f => jsAudio(path.join(dir, f))));
    // export-worker.js stretchedOf: read, resample linearly to 48 kHz, WSOLA
    const st = new Map();
    for (const c of doc.clips.filter(c => c.id === 'b' || c.id === 'e')) {
      const src = srcs[job.sources.indexOf(doc.media.find(m => m.id === c.media).file)], speed = c.speed, srcLen = c.duration * speed;
      const a0 = Math.floor((c.in || 0) * src.rate), n = Math.ceil(srcLen * src.rate) + 4, pcm = await src.read(a0, n), outN = Math.ceil(srcLen * RATE), ratio = src.rate / RATE;
      const res = pcm.slice(0, 2).map(ch => { const o = new Float32Array(outN); for (let i = 0; i < outN; i++) { const p = i * ratio, k = Math.floor(p), f = p - k; o[i] = (ch[k] ?? 0) * (1 - f) + (ch[k + 1] ?? ch[k] ?? 0) * f; } return o; });
      const out = stretch(res, speed, RATE);
      st.set(c.id, { L: out[0], R: out[1] || out[0] });
    }
    const want = Buffer.alloc(job.total * 6);
    // the clips in the project's order: plain ones by their plan, the stretched ones by their sound
    const heardIds = ['a', 'b', 'c', 'e'], stretchedIds = ['b', 'e'], plainIds = ['a', 'c'];
    assert.deepEqual(job.stretch.order, heardIds.map(id => (stretchedIds.includes(id) ? job.plans.length + stretchedIds.indexOf(id) : plainIds.indexOf(id))));
    const order = heardIds.map(id => doc.clips.find(c => c.id === id));
    for (let pos = 0, o = 0; pos < job.total; pos += BLOCK) {
      const n = BLOCK, L = new Float32Array(n), R = new Float32Array(n), t0 = from + pos / RATE, t1 = t0 + n / RATE;
      for (const c of order) {
        if (spanEnd(c) <= t0 || spanStart(c) >= t1) continue;
        if (st.has(c.id)) {
          const v = st.get(c.id), cs = spanStart(c), ce = spanEnd(c);
          const firstOut = Math.max(0, Math.ceil((cs - t0) * RATE)), lastOut = Math.min(n, Math.floor((ce - t0) * RATE));
          let g = 0, pg = [1, 1];
          for (let i = firstOut; i < lastOut; i++) {
            const lt = t0 + i / RATE - c.start, idx = Math.round(lt * RATE);
            if ((i - firstOut) % 256 === 0) { g = gainAt(doc, c, lt); pg = panGains(panAt(doc, c, lt)); }
            L[i] += (v.L[idx] ?? 0) * g * pg[0]; R[i] += (v.R[idx] ?? 0) * g * pg[1];
          }
          continue;
        }
        const p = job.plans[plainIds.indexOf(c.id)];
        const src = srcs[p.src], range = sourceRange(p, pos, n, RATE, src.rate);
        if (range) mixClip(L, R, pos, n, p, await src.read(range[0], range[1] - range[0]), range[0], RATE, src.rate);
      }
      for (let i = 0; i < n; i++) { L[i] *= job.mixGain; R[i] *= job.mixGain; }
      for (let q = 0; q < n; q += 512) chain.process(L.subarray(q, Math.min(n, q + 512)), R.subarray(q, Math.min(n, q + 512)));
      softClip(L, R);
      const k = Math.min(n, job.total - pos);
      for (let i = 0; i < k; i++) for (const v of [L[i], R[i]]) want.writeIntLE(pcm24(v), (o++) * 3, 3);
    }
    srcs.forEach(a => a.close());
    const out = path.join(dir, 'out.wav');
    await core.mix({ ...job, sources: job.sources.map(f => path.join(dir, f)) }, out, () => {});
    const got = fs.readFileSync(out);
    assert.equal(got.length, 44 + want.length);
    let diff = 0, worst = 0;
    for (let i = 0; i < job.total * 2; i++) { const a = got.readIntLE(44 + i * 3, 3), b = want.readIntLE(i * 3, 3); if (a !== b) { diff++; worst = Math.max(worst, Math.abs(a - b)); } }
    assert.ok(worst <= 1 && diff < job.total * 2 * 1e-4, `${diff} samples differ, by up to ${worst}`);
    t.diagnostic(`2 stretched clips (1.25× and 0.8×); ${diff} of ${job.total * 2} samples differ (by up to ${worst})`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reel-core plays clips with a time map (pitch kept, and like tape) the same as the JavaScript export, to the 24-bit sample', { skip }, async t => {
  const { warp } = await import('../app/renderer/lib/stretch.js');
  const { mapAt } = await import('../app/renderer/lib/retime.js');
  const { gainAt, panAt, panGains, spanStart, spanEnd } = await import('../app/renderer/model.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-retime-'));
  try {
    let s2 = 5; const r = () => ((s2 = (s2 * 16807) % 2147483647) / 2147483647);
    writeWav(path.join(dir, 'voice.wav'), { rate: 48000, channels: 2, bits: 16, frames: 48000 * 9, sample: (i, c) => 0.35 * Math.sin(i * (c ? 0.031 : 0.027)) * (0.6 + 0.4 * Math.sin(i * 0.0003)) + 0.1 * (r() - 0.5) });
    writeWav(path.join(dir, 'music.wav'), { rate: 44100, channels: 1, bits: 24, frames: 44100 * 10, sample: i => 0.4 * Math.sin(i * 0.011) * Math.sin(i * 0.0002) });
    const doc = mixDoc();
    // b: Elastic Wave-style map, slow then fast then normal, its pitch kept
    doc.clips[1].audio.keepPitch = true; doc.clips[1].retime = [{ t: 0, s: 0 }, { t: 0.9, s: 0.6 }, { t: 1.7, s: 2.2 }, { t: 2.5, s: 3.0 }];
    // e: a retime curve on a mono 44.1 kHz source, played like tape (faster parts higher)
    doc.clips.push({ id: 'e', type: 'media', media: 'm2', track: 't3', start: 1.5, in: 2, duration: 3, speed: 1, retime: [{ t: 0, s: 0 }, { t: 1.2, s: 2.1 }, { t: 3, s: 3.3 }], audio: { volume: 0.7, pan: -0.3, fadeIn: 0.2, keepPitch: false } });
    const from = 0.3, to = 6.9;
    const { job, why } = exportMixJob(doc, from, to, { codec: 'wav', bitrate: 192000 });
    assert.ok(job && job.maps && job.maps.filter(Boolean).length === 2, why);
    const RATE = 48000, BLOCK = 1024, chain = new FxChain(RATE).setup(doc.mixFx);
    const srcs = await Promise.all(job.sources.map(f => jsAudio(path.join(dir, f))));
    // export-worker.js stretchedOf, the time-map way
    const st = new Map();
    for (const c of doc.clips.filter(c => c.retime)) {
      const src = srcs[job.sources.indexOf(doc.media.find(m => m.id === c.media).file)], srcLen = c.retime[c.retime.length - 1].s;
      const a0 = Math.floor((c.in || 0) * src.rate), n = Math.ceil(srcLen * src.rate) + 4, pcm = await src.read(a0, n), outN = Math.ceil(srcLen * RATE), ratio = src.rate / RATE;
      const res = pcm.slice(0, 2).map(ch => { const o = new Float32Array(outN); for (let i = 0; i < outN; i++) { const p = i * ratio, k = Math.floor(p), f = p - k; o[i] = (ch[k] ?? 0) * (1 - f) + (ch[k + 1] ?? ch[k] ?? 0) * f; } return o; });
      const outLen = Math.ceil(c.duration * RATE), map = o => mapAt(c.retime, o / RATE) * RATE;
      const out = c.audio?.keepPitch === false
        ? res.map(ch => { const o = new Float32Array(outLen); for (let i = 0; i < outLen; i++) { const p = map(i), k = Math.floor(p), f = p - k; o[i] = (ch[k] ?? 0) * (1 - f) + (ch[k + 1] ?? ch[k] ?? 0) * f; } return o; })
        : warp(res, map, outLen, RATE);
      st.set(c.id, { L: out[0], R: out[1] || out[0] });
    }
    const want = Buffer.alloc(job.total * 6);
    const heardIds = ['a', 'b', 'c', 'e'], stretchedIds = ['b', 'e'], plainIds = ['a', 'c'];
    assert.deepEqual(job.stretch.order, heardIds.map(id => (stretchedIds.includes(id) ? job.plans.length + stretchedIds.indexOf(id) : plainIds.indexOf(id))));
    const order = heardIds.map(id => doc.clips.find(c => c.id === id));
    for (let pos = 0, o = 0; pos < job.total; pos += BLOCK) {
      const n = BLOCK, L = new Float32Array(n), R = new Float32Array(n), t0 = from + pos / RATE, t1 = t0 + n / RATE;
      for (const c of order) {
        if (spanEnd(c) <= t0 || spanStart(c) >= t1) continue;
        if (st.has(c.id)) {
          const v = st.get(c.id), cs = spanStart(c), ce = spanEnd(c);
          const firstOut = Math.max(0, Math.ceil((cs - t0) * RATE)), lastOut = Math.min(n, Math.floor((ce - t0) * RATE));
          let g = 0, pg = [1, 1];
          for (let i = firstOut; i < lastOut; i++) {
            const lt = t0 + i / RATE - c.start, idx = Math.round(lt * RATE);
            if ((i - firstOut) % 256 === 0) { g = gainAt(doc, c, lt); pg = panGains(panAt(doc, c, lt)); }
            L[i] += (v.L[idx] ?? 0) * g * pg[0]; R[i] += (v.R[idx] ?? 0) * g * pg[1];
          }
          continue;
        }
        const p = job.plans[plainIds.indexOf(c.id)];
        const src = srcs[p.src], range = sourceRange(p, pos, n, RATE, src.rate);
        if (range) mixClip(L, R, pos, n, p, await src.read(range[0], range[1] - range[0]), range[0], RATE, src.rate);
      }
      for (let i = 0; i < n; i++) { L[i] *= job.mixGain; R[i] *= job.mixGain; }
      for (let q = 0; q < n; q += 512) chain.process(L.subarray(q, Math.min(n, q + 512)), R.subarray(q, Math.min(n, q + 512)));
      softClip(L, R);
      const k = Math.min(n, job.total - pos);
      for (let i = 0; i < k; i++) for (const v of [L[i], R[i]]) want.writeIntLE(pcm24(v), (o++) * 3, 3);
    }
    srcs.forEach(a => a.close());
    const out = path.join(dir, 'out.wav');
    await core.mix({ ...job, sources: job.sources.map(f => path.join(dir, f)) }, out, () => {});
    const got = fs.readFileSync(out);
    assert.equal(got.length, 44 + want.length);
    let diff = 0, worst = 0, loud = 0;
    for (let i = 0; i < job.total * 2; i++) { const a = got.readIntLE(44 + i * 3, 3), b = want.readIntLE(i * 3, 3); if (Math.abs(b) > 1000) loud++; if (a !== b) { diff++; worst = Math.max(worst, Math.abs(a - b)); } }
    assert.ok(loud > job.total / 2, 'the mix has sound in it');
    assert.ok(worst <= 1 && diff < job.total * 2 * 1e-4, `${diff} samples differ, by up to ${worst}`);
    t.diagnostic(`2 time-mapped clips (pitch kept, and tape); ${diff} of ${job.total * 2} samples differ (by up to ${worst})`);
    // a damaged map is refused, not followed: going backwards, not from (0, 0), or not ending where the clip's sound does
    const bad = m => core.mix({ ...job, sources: job.sources.map(f => path.join(dir, f)), maps: job.maps.map((x, i) => (i === 0 ? { ...x, pts: m } : x)) }, path.join(dir, 'bad.wav'), () => {});
    await assert.rejects(bad([[0, 0], [1, 2], [0.5, 2.5], [2.5, 3]]), /bad time map/);
    await assert.rejects(bad([[0.2, 0], [2.5, 3]]), /bad time map/);
    await assert.rejects(bad([[0, 0], [2.5, 2]]), /bad time map/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reel-core runs track and mix-bus effects the same as the JavaScript export, to the 24-bit sample', { skip }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-fx-'));
  try {
    let s2 = 13; const r = () => ((s2 = (s2 * 16807) % 2147483647) / 2147483647);
    // speech-like bursts with clicks in them (for the gate, de-esser, de-click and Auto Level to do something)
    writeWav(path.join(dir, 'voice.wav'), { rate: 48000, channels: 2, bits: 16, frames: 48000 * 8, sample: (i, c) => {
      const on = Math.sin(i * 0.00021) > -0.2 ? 1 : 0.02, click = i % 9001 < 3 ? 0.6 : 0;
      return on * (0.3 * Math.sin(i * (c ? 0.031 : 0.027)) + 0.12 * Math.sin(i * 0.8) + 0.08 * (r() - 0.5)) + click; } });
    writeWav(path.join(dir, 'music.wav'), { rate: 44100, channels: 1, bits: 24, frames: 44100 * 9, sample: i => 0.35 * Math.sin(i * 0.011) * Math.sin(i * 0.0002) });
    const doc = mixDoc();
    doc.clips[1].audio.keepPitch = true; // a stretched clip on a track with effects too
    doc.tracks[0].fx = [{ id: 'f1', type: 'declick', params: { sensitivity: 7 } }, { id: 'f2', type: 'eq', params: { hpf: 90, lf: -2, lmf: -3, lmfF: 300, hmf: 2, hf: 3 } },
      { id: 'f3', type: 'gate', params: { threshold: -40 } }, { id: 'f4', type: 'comp', params: { threshold: -24, ratio: 4, attack: 5, release: 100, makeup: 6 } },
      { id: 'f5', type: 'deess', params: { threshold: -30 } }, { id: 'f6', type: 'level', params: {} }, { id: 'off', type: 'reverb', off: true }];
    doc.tracks[1].fx = [{ id: 'g1', type: 'reverb', params: { size: 0.7, mix: 0.3 } }, { id: 'g2', type: 'delay', params: { time: 120, feedback: 0.3, mix: 0.2 } }, { id: 'g3', type: 'gain', params: { db: -2, mono: true } }, { id: 'g4', type: 'limiter', params: { ceiling: -2 } }];
    doc.mixFx = [{ id: 'b1', type: 'eq', params: { lf: 2, hf: -1 } }, { id: 'b2', type: 'comp', params: { threshold: -16, ratio: 2 } }, { id: 'lim', type: 'limiter', params: { ceiling: -1, release: 60 } }];
    const from = 0.3, to = 6.9;
    const { job, why } = exportMixJob(doc, from, to, { codec: 'wav', bitrate: 192000 });
    assert.ok(job && job.fx && job.fx.chains.length === 2 && job.fx.bus && job.limiters.length === 0, why);
    // export-worker.js: clips on a track with effects go to that track's buffer; each chain runs (512 at a time) and
    // is added in track order; then the mix gain, the bus chain, the soft limit
    const { stretch } = await import('../app/renderer/lib/stretch.js');
    const { gainAt, panAt, panGains, spanStart, spanEnd } = await import('../app/renderer/model.js');
    const RATE = 48000, BLOCK = 1024;
    const chains = new Map(doc.tracks.filter(tr => (tr.fx || []).some(f => !f.off)).map(tr => [tr.id, new FxChain(RATE).setup(tr.fx)]));
    const bus = new FxChain(RATE).setup(doc.mixFx);
    const srcs = await Promise.all(job.sources.map(f => jsAudio(path.join(dir, f))));
    const b = doc.clips[1], bsrc = srcs[0], bLen = b.duration * b.speed, a0 = Math.floor(b.in * bsrc.rate), pcm = await bsrc.read(a0, Math.ceil(bLen * bsrc.rate) + 4), outN = Math.ceil(bLen * RATE);
    const res = pcm.slice(0, 2).map(ch => { const o = new Float32Array(outN); for (let i = 0; i < outN; i++) { const p = i, k = Math.floor(p), f = p - k; o[i] = (ch[k] ?? 0) * (1 - f) + (ch[k + 1] ?? ch[k] ?? 0) * f; } return o; });
    const st = stretch(res, b.speed, RATE), bv = { L: st[0], R: st[1] || st[0] };
    const heard = ['a', 'b', 'c'].map(id => doc.clips.find(c => c.id === id));
    const plainIdx = { a: 0, c: 1 };
    const want = Buffer.alloc(job.total * 6);
    for (let pos = 0, o = 0; pos < job.total; pos += BLOCK) {
      const n = BLOCK, L = new Float32Array(n), R = new Float32Array(n), t0 = from + pos / RATE, t1 = t0 + n / RATE, tb = new Map();
      const bufFor = c => { if (!chains.has(c.track)) return [L, R]; let x = tb.get(c.track); if (!x) { x = [new Float32Array(n), new Float32Array(n)]; tb.set(c.track, x); } return x; };
      for (const c of heard) {
        if (spanEnd(c) <= t0 || spanStart(c) >= t1) continue;
        const [TL, TR] = bufFor(c);
        if (c === b) {
          const cs = spanStart(c), ce = spanEnd(c), firstOut = Math.max(0, Math.ceil((cs - t0) * RATE)), lastOut = Math.min(n, Math.floor((ce - t0) * RATE));
          let g = 0, pg = [1, 1];
          for (let i = firstOut; i < lastOut; i++) { const lt = t0 + i / RATE - c.start, idx = Math.round(lt * RATE); if ((i - firstOut) % 256 === 0) { g = gainAt(doc, c, lt); pg = panGains(panAt(doc, c, lt)); } TL[i] += (bv.L[idx] ?? 0) * g * pg[0]; TR[i] += (bv.R[idx] ?? 0) * g * pg[1]; }
          continue;
        }
        const p = job.plans[plainIdx[c.id]], src = srcs[p.src], range = sourceRange(p, pos, n, RATE, src.rate);
        if (range) mixClip(TL, TR, pos, n, p, await src.read(range[0], range[1] - range[0]), range[0], RATE, src.rate);
      }
      for (const [id, ch] of chains) { const [x, y] = tb.get(id) || [new Float32Array(n), new Float32Array(n)]; for (let q = 0; q < n; q += 512) ch.process(x.subarray(q, Math.min(n, q + 512)), y.subarray(q, Math.min(n, q + 512))); for (let i = 0; i < n; i++) { L[i] += x[i]; R[i] += y[i]; } }
      for (let i = 0; i < n; i++) { L[i] *= job.mixGain; R[i] *= job.mixGain; }
      for (let q = 0; q < n; q += 512) bus.process(L.subarray(q, Math.min(n, q + 512)), R.subarray(q, Math.min(n, q + 512)));
      softClip(L, R);
      const k = Math.min(n, job.total - pos);
      for (let i = 0; i < k; i++) for (const v of [L[i], R[i]]) want.writeIntLE(pcm24(v), (o++) * 3, 3);
    }
    srcs.forEach(a => a.close());
    const out = path.join(dir, 'out.wav');
    await core.mix({ ...job, sources: job.sources.map(f => path.join(dir, f)) }, out, () => {});
    const got = fs.readFileSync(out);
    assert.equal(got.length, 44 + want.length);
    let diff = 0, worst = 0;
    for (let i = 0; i < job.total * 2; i++) { const x = got.readIntLE(44 + i * 3, 3), y = want.readIntLE(i * 3, 3); if (x !== y) { diff++; worst = Math.max(worst, Math.abs(x - y)); } }
    // log10 and pow may differ in their last bit between JavaScript and Rust: at most a 24-bit step, rarely
    assert.ok(worst <= 1 && diff < job.total * 2 * 1e-3, `${diff} samples differ, by up to ${worst}`);
    t.diagnostic(`10 effect types on 2 tracks and the bus; ${diff} of ${job.total * 2} samples differ (by up to ${worst})`);
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

for (const target of [-14, null]) test(`reel-core masters a sound-only export (built-in master${target == null ? ', no loudness target' : ', to -14 LUFS'}) the same as the JavaScript, to the 24-bit sample`, { skip }, async t => {
  const { LoudnessMeter, TruePeakLimiter, MasterChain, defaultMaster } = await import('../app/renderer/lib/master.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-master-'));
  try {
    let s2 = 21; const r = () => ((s2 = (s2 * 16807) % 2147483647) / 2147483647);
    writeWav(path.join(dir, 'voice.wav'), { rate: 48000, channels: 2, bits: 16, frames: 48000 * 8, sample: (i, c) => 0.3 * Math.sin(i * (c ? 0.031 : 0.027)) * (0.5 + 0.5 * Math.sin(i * 0.00007)) + 0.1 * (r() - 0.5) + (i % 19997 < 2 ? 0.7 : 0) }); // (with pops for the de-click, 1.15)
    writeWav(path.join(dir, 'music.wav'), { rate: 44100, channels: 1, bits: 24, frames: 44100 * 9, sample: i => 0.35 * Math.sin(i * 0.011) * Math.sin(i * 0.0002) });
    const doc = mixDoc();
    const m = defaultMaster();
    assert.ok(m.declick.on, 'the de-click is on in a new master');
    m.on = true; m.input.gain = 1.5; m.input.balance = 0.6; m.input.tape = 'nab-iec-15';
    m.tone.on = true; m.tone.bands[0].gain = 1.5; m.tone.bands[1] = { on: true, f: 1, shape: 'blunt', gain: -1.5 }; m.tone.bands[3] = { on: true, f: 2, shape: 'high', gain: 2 };
    m.filter.on = true; m.filter.hp = 2; m.filter.lp = 2; m.filter.presenceF = 4; m.filter.presence = 2;
    m.comp.on = true; m.comp.type = 'original'; m.comp.ratio = 40; m.comp.mix = 0.5; m.comp.scHp = 120; m.output.spread = 1.5; m.output.gain = -0.5;
    const from = 0.3, to = 6.9;
    const { job, why } = exportMixJob(doc, from, to, { codec: 'wav', bitrate: 192000, loudness: target, ceiling: -1, master: m });
    assert.ok(job && job.loud && job.loud.master, why);
    // the JavaScript: mix pass in 8192-frame blocks with the master chain on each, measured if there's a target,
    // turned by the gain, then the true-peak limiter and 24-bit
    const RATE = 48000, BLOCK = 8192, chain = new FxChain(RATE).setup(doc.mixFx), mc = new MasterChain(m, RATE);
    const srcs = await Promise.all(job.sources.map(f => jsAudio(path.join(dir, f))));
    const frames = job.loud.measure, mL = new Float32Array(frames), mR = new Float32Array(frames);
    for (let pos = 0; pos < frames; pos += BLOCK) {
      const n = Math.min(BLOCK, frames - pos), L = mL.subarray(pos, pos + n), R = mR.subarray(pos, pos + n);
      for (const p of job.plans) { const src = srcs[p.src], range = sourceRange(p, pos, n, RATE, src.rate); if (range) mixClip(L, R, pos, n, p, await src.read(range[0], range[1] - range[0]), range[0], RATE, src.rate); }
      for (let i = 0; i < n; i++) { L[i] *= job.mixGain; R[i] *= job.mixGain; }
      for (let q = 0; q < n; q += 512) chain.process(L.subarray(q, Math.min(n, q + 512)), R.subarray(q, Math.min(n, q + 512)));
      mc.process(L, R);
    }
    srcs.forEach(a => a.close());
    let gain = 1, lufs = null;
    if (target != null) { const meter = new LoudnessMeter(RATE); for (let p = 0; p < frames; p += RATE * 10) meter.push(mL.subarray(p, p + RATE * 10), mR.subarray(p, p + RATE * 10)); lufs = meter.integrated(); gain = Math.pow(10, Math.min(20, target - lufs) / 20); }
    const lim = new TruePeakLimiter(-1, RATE), want = Buffer.alloc(job.total * 6);
    for (let pos = 0, o = 0; pos < job.total; pos += 1024) {
      const n = Math.min(1024, job.total - pos), L = Float32Array.from(mL.subarray(pos, pos + n)), R = Float32Array.from(mR.subarray(pos, pos + n));
      for (let i = 0; i < n; i++) { L[i] *= gain; R[i] *= gain; }
      lim.process(L, R);
      for (let i = 0; i < n; i++) for (const v of [L[i], R[i]]) want.writeIntLE(pcm24(v), (o++) * 3, 3);
    }
    const out = path.join(dir, 'out.wav');
    const res = await core.mix({ ...job, sources: job.sources.map(f => path.join(dir, f)) }, out, () => {});
    if (target != null) assert.ok(Math.abs(res.loudness - lufs) < 1e-6, `measured ${res.loudness} vs ${lufs}`);
    const got = fs.readFileSync(out);
    assert.equal(got.length, 44 + want.length);
    let diff = 0, worst = 0;
    for (let i = 0; i < job.total * 2; i++) { const a = got.readIntLE(44 + i * 3, 3), b = want.readIntLE(i * 3, 3); if (a !== b) { diff++; worst = Math.max(worst, Math.abs(a - b)); } }
    assert.ok(worst <= 1 && diff < job.total * 2 * 1e-3, `${diff} samples differ, by up to ${worst}`);
    t.diagnostic(`built-in master${target == null ? '' : `, ${lufs.toFixed(2)} → ${target} LUFS`}; ${diff} of ${job.total * 2} samples differ (by up to ${worst})`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('what the core can\'t mix yet goes to the JavaScript export, with the reason', () => {
  const doc = mixDoc();
  assert.ok(exportMixJob(doc, 0, 5, { codec: 'wav' }).job);
  assert.ok(exportMixJob({ ...doc, mixFx: [...doc.mixFx, { type: 'reverb' }] }, 0, 5, { codec: 'wav' }).job.fx.bus, 'mix bus effects go to the core now');
  assert.equal(exportMixJob({ ...doc, tracks: [{ ...doc.tracks[0], fx: [{ type: 'eq' }] }, doc.tracks[1]] }, 0, 5, { codec: 'wav' }).job.fx.chains.length, 1, 'track effects go to the core now');
  const pitched = mixDoc(); pitched.clips[1].retime = [{ t: 0, s: 0 }, { t: 2.5, s: 3 }];
  const mj = exportMixJob(pitched, 0, 7, { codec: 'wav' }).job;
  assert.ok(mj.maps && mj.maps[0].pts.length === 2 && mj.maps[0].tape === true && mj.fx, 'time maps go to the core now (1.1), with an empty effects section before them');
  const mapClick = mixDoc(); mapClick.clips[1].retime = [{ t: 0, s: 0 }, { t: 2.5, s: 3 }]; mapClick.clips[1].cursor = { clickSound: 0.5 };
  // (1.15) a time-mapped clip's clicks go to the core too, each where the map plays it: 1.5 s into the source plays
  // 0.75 s into the clip here (the map's first second runs at double speed), not at its average speed
  mapClick.clips[1].retime = [{ t: 0, s: 0 }, { t: 1, s: 2 }, { t: 2.5, s: 3 }];
  const mc = exportMixJob(mapClick, 0, 7, { codec: 'wav', cursors: new Map([['m1', { clicks: [[3500, 'd'], [3560, 'u']] }]]) });
  assert.ok(mc.job, mc.why);
  const cc = mc.job.clicks.clips[0];
  assert.equal(cc.ms.length, 1);
  assert.ok(Math.abs(cc.start + (cc.ms[0] / 1000 - cc.offset - cc.in) / cc.speed - 4.95) < 1e-9, 'sounds at 4.95 s');
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

// ---------------------------------------------------------------- step 5 begins: the core reads video files itself
import { execFileSync } from 'node:child_process';
const ffmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('reel-core reads MP4 and MOV files (H.264, HEVC, fragmented, rotated, edit lists, PCM) the same as the JavaScript, sample for sample', { skip: skip || (!ffmpeg && 'needs ffmpeg to make the test videos') }, async t => {
  const { demux, BufferReader } = await import('../app/renderer/lib/mp4.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-mp4-'));
  const src = ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3'];
  const files = {
    'h264 aac, B-frames and an edit list.mp4': [...src, '-c:v', 'libx264', '-bf', '2', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'],
    'hevc hvc1.mp4': [...src, '-c:v', 'libx265', '-x265-params', 'log-level=none:keyint=20', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'],
    'phone, turned 90 degrees, pcm.mov': ['-display_rotation', '90', ...src, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-shortest'],
    'fragmented.mp4': [...src, '-c:v', 'libx264', '-g', '10', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', 'frag_keyframe+empty_moov+default_base_moof'],
    'started late, 48k mono.mp4': ['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=2', '-c:v', 'libx264', '-bf', '3', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '1', '-output_ts_offset', '0.5', '-shortest'],
  };
  try {
    let samples = 0;
    for (const [name, args] of Object.entries(files)) {
      const file = path.join(dir, name);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args, file], { stdio: 'ignore' });
      if (/turned 90/.test(name)) {
        // the turn as a phone writes it: the video track's matrix (a = 0, b = 1, c = −1, d = 0)
        const buf = fs.readFileSync(file), at = buf.indexOf('tkhd'), m = at + 4 + (buf[at + 4] === 1 ? 52 : 40);
        buf.writeInt32BE(0, m); buf.writeInt32BE(65536, m + 4); buf.writeInt32BE(-65536, m + 12); buf.writeInt32BE(0, m + 16);
        fs.writeFileSync(file, buf);
      }
      const js = await demux(new BufferReader(fs.readFileSync(file)));
      const rs = await core.mp4Info(file);
      const norm = tr => ({ id: tr.id, kind: tr.kind, timescale: tr.timescale, codec: tr.codec ?? null, description: tr.description == null ? null : typeof tr.description === 'string' ? tr.description : Buffer.from(tr.description).toString('hex'), supported: !!tr.supported,
        rotation: tr.rotation, fourcc: tr.fourcc ?? '', width: tr.width ?? 0, height: tr.height ?? 0, pixelAspect: tr.pixelAspect ?? null, channels: tr.channels ?? 0, sampleSize: tr.sampleSize ?? 0,
        sampleRate: tr.sampleRate ?? 0, pcmBits: tr.pcm?.bits ?? tr.pcmBits ?? null, mediaTime: tr.mediaTime ?? 0, emptyLead: tr.emptyLead ?? 0, startTime: tr.startTime, duration: tr.duration, origin: tr.origin ?? 0,
        samples: tr.samples.map(s => (Array.isArray(s) ? [s[0], s[1], s[2], s[3], s[4], !!s[5]] : [s.offset, s.size, s.dts, s.pts, s.duration, !!s.sync])) });
      assert.equal(rs.tracks.length, js.tracks.length, name);
      for (let i = 0; i < js.tracks.length; i++) { const a = norm(js.tracks[i]), b = norm(rs.tracks[i]); assert.deepEqual(b, a, `${name}, track ${i + 1}`); samples += a.samples.length; }
      if (/turned 90/.test(name)) assert.equal(rs.tracks[0].rotation, 90, 'the turn is read');
      if (/fragmented/.test(name)) assert.ok(rs.tracks[0].samples.filter(x => x[5]).length > 3, 'the fragments are read');
      if (/edit list/.test(name)) assert.ok(rs.tracks[0].mediaTime > 0 && rs.tracks[0].samples.some(x => x[3] !== x[2]), 'the edit list and B-frame timing are read');
      assert.equal(rs.duration, js.duration, name);
    }
    t.diagnostic(`${Object.keys(files).length} files, ${samples} samples: the same`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reel-core writes an MP4 head (ftyp, moov, mdat) byte for byte as the JavaScript muxer', { skip }, async t => {
  const { Muxer } = await import('../app/renderer/lib/mp4.js');
  const avcC = Uint8Array.from([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80]);
  const hvcC = Uint8Array.from({ length: 40 }, (_, i) => (i * 37 + 5) & 255);
  const asc = Uint8Array.from([0x11, 0x90]);
  let sd = 3; const r = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  const cases = {
    'H.264 and AAC, interleaved, one keyframe in 30': { video: { codec: 'avc1.640028', width: 1920, height: 1080, description: avcC }, audio: { codec: 'mp4a.40.2', sampleRate: 48000, channels: 2, description: asc, bitrate: 256000 },
      frames: () => { const f = []; for (let i = 0; i < 300; i++) { f.push(['v', 3000 + Math.floor(r() * 9000), (i * 1e6) / 30, 1e6 / 30, i % 30 === 0]); if (i % 2) f.push(['a', 300 + Math.floor(r() * 200), (i / 2) * (1024e6 / 48000), 1024e6 / 48000, true]); } return f; } },
    'HEVC with B-frames out of order, no durations, starting late': { video: { codec: 'hvc1.1.6.L153.B0', width: 3840, height: 2160, description: hvcC, timescale: 600 },
      frames: () => { const order = [0, 3, 1, 2, 6, 4, 5, 9, 7, 8, 12, 10, 11]; return order.map((k, i) => ['v', 500 + i * 11, 2e6 + (k * 1e6) / 24, 0, k % 6 === 0]); } },
    'sound only, mono 44.1 kHz': { audio: { codec: 'mp4a.40.2', sampleRate: 44100, channels: 1, description: asc },
      frames: () => Array.from({ length: 200 }, (_, i) => ['a', 200 + (i % 17), (i * 1024e6) / 44100, (1024e6) / 44100, true]) },
  };
  for (const [name, c] of Object.entries(cases)) {
    const frames = c.frames();
    const js = new Muxer({ video: c.video, audio: c.audio });
    for (const [k, size, ts, dur, key] of frames) (k === 'v' ? js.addVideo : js.addAudio).call(js, new Uint8Array(size), { timestamp: ts, duration: dur, key });
    const want = Buffer.from(js.finish()).toString('hex');
    const parts = [Buffer.from('RCORE1\nmp4head\n')];
    const u8 = v => parts.push(Buffer.from([v])), u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); parts.push(b); }, f64 = v => { const b = Buffer.alloc(8); b.writeDoubleLE(v); parts.push(b); };
    const str = v => { const b = Buffer.from(v); u32(b.length); parts.push(b); };
    if (c.video) { u8(1); str(c.video.codec); u32(c.video.width); u32(c.video.height); u32(c.video.timescale || 0); str(c.video.description); } else u8(0);
    if (c.audio) { u8(1); str(c.audio.codec); u32(c.audio.sampleRate); u32(c.audio.channels); u32(c.audio.bitrate || 0); str(c.audio.description); } else u8(0);
    u32(frames.length);
    for (const [k, size, ts, dur, key] of frames) { u8(k === 'v' ? 1 : 0); u32(size); f64(ts); f64(dur); u8(key ? 1 : 0); }
    const got = (await core.run(Buffer.concat(parts))).head;
    assert.equal(got.length, want.length, `${name}: the head's length`);
    assert.equal(got, want, name);
  }
  t.diagnostic(`${Object.keys(cases).length} files' heads: byte for byte`);
});

// ------------------------------------------------------------------ drawing a frame (1.3)
import { framePlan, encodeFrame } from '../app/renderer/lib/frameplan.js';

const frameDoc = (clips, media) => ({ canvas: { width: 64, height: 36, background: '#102030' }, media, tracks: clips.map((_, i) => ({ id: 't' + i })).reverse(),
  clips: clips.map((c, i) => ({ id: 'c' + i, type: 'media', media: c.media, track: 't' + i, start: 0, in: 0, duration: 5, props: { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, crop: [0, 0, 0, 0], ...c.props } })) });
/** A picture in four solid quarters (red, green, blue, white), so where each part lands can be told apart. */
function quarters(w, h) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const q = (y < h / 2 ? 0 : 2) + (x < w / 2 ? 0 : 1), c = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]][q];
    px.set([...c, 255], (y * w + x) * 4);
  }
  return px;
}
async function drawFrame(doc, pics, W = doc.canvas.width, H = doc.canvas.height) {
  const plan = framePlan(doc, 1, W, H);
  assert.ok(!plan.why, plan.why);
  const ids = Object.keys(pics);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reel-frame-')), 'f.rgba');
  const body = encodeFrame(plan, W, H, ids, ids.map(id => { const m = doc.media.find(x => x.id === id); return { w: m.width, h: m.height, rgba: pics[id] }; }), out);
  const parts = [Buffer.from('RCORE1\nframe\n'), Buffer.from(body)];
  await core.run(Buffer.concat(parts));
  const px = fs.readFileSync(out); fs.rmSync(path.dirname(out), { recursive: true });
  return (x, y) => [...px.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)];
}
const near = (a, b, tol = 2) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

test('reel-core draws a frame: pictures placed, scaled, cropped, faded and turned where the editor draws them', { skip }, async t => {
  const media = [{ id: 'scr', kind: 'video', width: 128, height: 72 }, { id: 'ph', kind: 'video', width: 36, height: 64, rotation: 90 }];
  const pics = { scr: quarters(128, 72), ph: quarters(36, 64) };
  await t.test('fitted: the picture fills the canvas, each quarter in its place', async () => {
    const at = await drawFrame(frameDoc([{ media: 'scr' }], media), pics);
    assert.deepEqual(at(5, 5), [255, 0, 0]); assert.deepEqual(at(58, 5), [0, 255, 0]); assert.deepEqual(at(5, 30), [0, 0, 255]); assert.deepEqual(at(58, 30), [255, 255, 255]);
  });
  await t.test('half size, moved to the top left, half faded: background around it, colours half mixed', async () => {
    const at = await drawFrame(frameDoc([{ media: 'scr', props: { scale: 0.5, x: 0.25, y: 0.25, opacity: 0.5 } }], media), pics);
    // the picture now covers x 0..32, y 0..18
    assert.ok(near(at(4, 4), [136, 16, 24]), String(at(4, 4)));
    assert.deepEqual(at(40, 25), [16, 32, 48]);
    assert.deepEqual(at(33, 4), [16, 32, 48], 'hard edge: just past it is background');
  });
  await t.test('cropped to its right half: only green and white show, stretched to fit', async () => {
    const at = await drawFrame(frameDoc([{ media: 'scr', props: { crop: [0.5, 0, 0, 0] } }], media), pics);
    // the right half is 64 × 72, fitted to the 36 high canvas: 32 wide, in the middle (x 16..48)
    assert.deepEqual(at(20, 5), [0, 255, 0]); assert.deepEqual(at(44, 30), [255, 255, 255]); assert.deepEqual(at(8, 18), [16, 32, 48]);
  });
  await t.test('a phone video turned 90° stands the way it was filmed', async () => {
    const at = await drawFrame(frameDoc([{ media: 'ph' }], media), pics);
    // turned clockwise, its top left (red) lands top right; it fills the canvas (64 × 36 once turned)
    assert.deepEqual(at(58, 5), [255, 0, 0]); assert.deepEqual(at(5, 5), [0, 0, 255]); assert.deepEqual(at(58, 30), [0, 255, 0]); assert.deepEqual(at(5, 30), [255, 255, 255]);
  });
});

test('reel-core draws rounded corners, a border and a shadow where the editor draws them', { skip }, async () => {
  const media = [{ id: 'scr', kind: 'video', width: 128, height: 72 }];
  const pics = { scr: quarters(128, 72) };
  // a 1920 × 1080 project drawn at 64 × 36 (its sizes 1/30): the picture at half size in the middle (x 16..48,
  // y 9..27), corners 6 px, a 2 px yellow border, a shadow 4 px soft, 1 px down, over a light grey background
  const d = frameDoc([{ media: 'scr', props: { scale: 0.5, radius: 180, border: 60, borderColor: '#ffff00', shadow: 120 } }], media);
  d.canvas = { width: 1920, height: 1080, background: '#c8c8c8' };
  const k = framePlan(d, 1, 64, 36).layers[0].look;
  assert.ok(Math.abs(k.radius - 6) < 1e-9 && Math.abs(k.border - 2) < 1e-9 && Math.abs(k.shadow - 4) < 1e-9 && Math.abs(k.dy - 1) < 1e-9, JSON.stringify(k));
  const at = await drawFrame(d, pics, 64, 36);
  assert.ok(near(at(24, 15), [255, 0, 0], 3), 'red quarter inside: ' + at(24, 15));
  assert.ok(near(at(32, 9), [255, 255, 0], 40), 'the border along the top edge: ' + at(32, 9));
  const corner = at(16, 9);
  assert.ok(corner[2] < 200 && corner[0] < 230 && !near(corner, [255, 0, 0], 40), 'the corner is cut (shadowed background): ' + corner);
  assert.ok(at(32, 29)[0] < at(32, 6)[0], `darker below (shadow) than above: ${at(32, 29)} vs ${at(32, 6)}`);
  assert.deepEqual(at(2, 2), [200, 200, 200], 'far away: the background');
});

test('reel-core draws a dip to black and a stabilized picture cut to its box', { skip }, async () => {
  const media = [{ id: 'scr', kind: 'video', width: 128, height: 72 }];
  const pics = { scr: quarters(128, 72) };
  // halfway through a 1 s dip to black at the end of a 1.5 s clip (drawn at 1 s): darker than the picture
  const d = frameDoc([{ media: 'scr' }], media); Object.assign(d.clips[0], { duration: 1.5, transOut: { type: 'dip-black', dur: 1 } });
  assert.ok(framePlan(d, 1, 64, 36).layers.some(l => l.fill), 'a colour layer for the dip');
  const dark = await drawFrame(d, pics);
  assert.ok(dark(5, 5)[0] > 20 && dark(5, 5)[0] < 200, 'the red quarter, part dipped: ' + dark(5, 5));
  // stabilized: moved and zoomed inside its own box, which cuts it
  const s = frameDoc([{ media: 'scr', props: { scale: 0.5 } }], media);
  s.clips[0].stab = { rate: 30, t0: 0, x: Array.from({ length: 90 }, (_, i) => Math.sin(i) * 0.02), y: Array(90).fill(0), r: Array(90).fill(0), smooth: 0.5, zoom: 1.2, strength: 1 };
  const sp = framePlan(s, 1, 64, 36);
  assert.equal(sp.layers[0].look?.cut, true, 'cut to its box');
  const px = await drawFrame(s, pics);
  assert.deepEqual(px(10, 4), [16, 32, 48], 'outside the half-size box: background (zoomed picture cut off)');
  assert.ok(near(px(20, 12), [255, 0, 0], 6), 'inside: the picture ' + px(20, 12));
});

test('reel-core draws blur, exposure and colour moves as the canvas filter does', { skip }, async () => {
  const media = [{ id: 'scr', kind: 'video', width: 128, height: 72 }];
  const d = frameDoc([{ media: 'scr', props: { blur: 30, bright: 2, sat: 0 } }], media);
  d.canvas = { width: 1920, height: 1080, background: '#000000' };
  const f = framePlan(d, 1, 64, 36).layers[0].filter;
  assert.deepEqual(f, { blur: 1, bright: 2, sat: 0 }, 'blur scaled to the frame: 30 px of a 1920 canvas at 64 wide is 1 px');
  const at = await drawFrame(d, { scr: quarters(128, 72) }, 64, 36);
  // the red quarter, twice as bright (255 stays 255) then grey: 0.213 × 255 = 54
  const q = at(8, 6);
  assert.ok(q.every(v => Math.abs(v - 54) <= 3), 'red, brightened and greyed: ' + q);
  const r = framePlan({ ...d, clips: [{ ...d.clips[0], props: { ...d.clips[0].props, radius: 20 } }] }, 1, 64, 36);
  assert.match(r.why, /rounded/, 'a filter on a rounded picture is left to the JavaScript');
});

test('a transition through a shape (barn doors, iris…) is drawn by the core (1.13)', async () => {
  const { maskShapes } = await import('../app/renderer/lib/frameplan.js');
  const media = [{ id: 'scr', kind: 'video', width: 128, height: 72 }];
  const d = frameDoc([{ media: 'scr' }], media); d.clips[0].start = 0.8; d.clips[0].transIn = { type: 'barn', dur: 0.5 };
  const p = framePlan(d, 1, 64, 36);
  assert.ok(!p.why && p.needs13 && p.layers[0].mask, 'seen through the doors');
  const [door] = p.layers[0].mask, xs = door.poly.map(q => q[0]);
  assert.ok(Math.min(...xs) > 0 && Math.max(...xs) < 64, 'the doors part from the middle');
  assert.ok(maskShapes({ type: 'iris', k: 0.5 }, 64, 36)[0].circle, 'the iris is a circle');
  assert.equal(maskShapes({ type: 'blinds', k: 0.5 }, 64, 36).length, 8);
});

test('a background graphic gets its own place in the core\u2019s stack, for the editor to draw into (1.13)', () => {
  const media = [{ id: 'scr', kind: 'video', width: 128, height: 72 }];
  const d = frameDoc([{ media: 'scr' }], media);
  d.tracks.push({ id: 'tb' });
  d.clips.unshift({ id: 'bg', type: 'element', track: 'tb', start: 0, duration: 5, props: {}, element: { kind: 'bgFlow' } });
  const p = framePlan(d, 1, 64, 36);
  assert.ok(!p.why && p.overlay && p.needs13, p.why);
  assert.equal(p.layers.filter(l => l.slot === 0).length, 1, 'one slot, numbered 0');
});

test('a frame that needs more than pictures says why, for the JavaScript to draw', () => {
  const media = [{ id: 'scr', kind: 'video', width: 128, height: 72 }];
  const fr = frameDoc([{ media: 'scr' }], media); fr.clips[0].frame = { type: 'phone' };
  const fp = framePlan(fr, 1, 64, 36);
  assert.ok(!fp.why && fp.overlay && fp.layers[0].slot === 0 && fp.layers[0].key === 'frame:' + fr.clips[0].id, 'a device frame: a slot under the picture (1.13)');
  fr.clips[0].props.shadow = 20;
  assert.match(framePlan(fr, 1, 64, 36).why, /device frames/);
  const d = frameDoc([{ media: 'scr' }], media); d.clips[0].filters = [{ type: 'lut', file: 'look.cube' }];
  assert.match(framePlan(d, 1, 64, 36).why, /LUT/);
  const lp = framePlan(d, 1, 64, 36, undefined, null, { luts: new Map([['look.cube', { size: 2, data2d: new Uint8Array(24) }]]) });
  assert.ok(!lp.why && lp.needs13 && lp.layers[0].grade.lutFile === 'look.cube', 'with its table read: the core’s (1.13)');
  d.clips[0].filters = []; d.clips.push({ id: 't', type: 'text', track: 't0', start: 0, duration: 5, props: {} });
  const p = framePlan(d, 1, 64, 36);
  assert.ok(!p.why && p.overlay, 'a title: the editor draws it over the frame (1.12)');
  d.clips.push({ id: 'k', type: 'callout', track: 't0', start: 0, duration: 5, props: {}, callout: { blur: 8 } });
  const b = framePlan(d, 1, 64, 36);
  assert.ok(!b.why && b.overlay && b.needs13, 'a blurring call-out: the core blurs round it (1.13)');
});

test('reel-core watches a video (motion, cuts and the pointer) the same as the JavaScript, frame for frame', { skip }, async () => {
  const { measure } = await import('../app/renderer/autozoom.js');
  const { PointerTracker, arrowShape } = await import('../app/renderer/lib/pointerfind.js');
  const { Readable } = await import('node:stream');
  const GW = 48, GH = 27, PW = 320, PH = 180;
  let sd = 5; const r = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  // a busy desktop (blocks of colour and text-like specks), a pointer moving over it, hidden for a while, a cut
  const desk = k => { const g = new Uint8Array(PW * PH); for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) g[y * PW + x] = (((x >> 5) + (y >> 4) + k) % 3) * 60 + 50 + ((x * 7 + y * 13 + k) % 11 === 0 ? 90 : 0); return g; };
  const arrow = (g, tx, ty, h) => { for (const [dx, dy, v] of arrowShape(h, 0, 0).px) { const x = tx + dx, y = ty + dy; if (x >= 0 && y >= 0 && x < PW && y < PH) g[y * PW + x] = 15 + v * 230; } };
  const small = g => { const o = new Uint8Array(GW * GH); for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) { let s = 0; for (let j = 0; j < 6; j++) for (let i = 0; i < 6; i++) s += g[Math.min(PH - 1, Math.floor(y * PH / GH) + j) * PW + Math.floor(x * PW / GW) + i]; o[y * GW + x] = Math.round(s / 36); } return o; };
  const parts = [], js = [], tr = new PointerTracker(PW, PH, 1920, 1080);
  let next = 0, prev = null, jump = null, prevSample = null;
  for (let i = 0; i < 300; i++) {
    const t = i / 30, sample = t >= next - 1e-3;
    const g = desk(i < 200 ? 0 : 1);
    if (i < 90 || i > 130) arrow(g, Math.round(30 + i * 0.8 + r() * 2), Math.round(40 + Math.sin(i / 20) * 30), 16);
    const s = small(g);
    if (jump == null && prevSample) { let d = 0; for (let k = 0; k < s.length; k++) d += Math.abs(s[k] - prevSample[k]); if (d / s.length > 20) jump = t; }
    const f = Buffer.alloc(9); f.writeDoubleLE(t, 0); f[8] = sample ? 1 : 0; parts.push(f, Buffer.from(s));
    if (!sample) continue;
    next = t + 0.2; parts.push(Buffer.from(g));
    js.push({ t, ...measure(s, prev, GW, GH), jump }); jump = null; prev = s; prevSample = s;
    tr.push(t, g);
  }
  const res = await core.watch({ gw: GW, gh: GH, pw: PW, ph: PH }, Readable.from([Buffer.concat(parts)]));
  assert.equal(res.frames, 300);
  assert.equal(res.samples.length, js.length);
  const close = (a, b, what) => assert.ok(Math.abs(a - b) < 2e-5, `${what}: ${a} vs ${b}`);
  res.samples.forEach((s, i) => {
    const j = js[i];
    for (const k of ['t', 'diff', 'motion', 'cx', 'cy', 'box']) close(s[k], j[k], `${k} at ${i}`);
    close(s.detail.x, j.detail.x, 'detail x'); close(s.detail.y, j.detail.y, 'detail y');
    assert.equal(s.jump == null, j.jump == null, `cut at ${i}`); if (j.jump != null) close(s.jump, j.jump, 'cut');
  });
  assert.ok(res.samples.some(s => s.jump != null), 'the cut is found');
  assert.ok(tr.found.length > 20, 'the JavaScript follows the pointer');
  assert.deepEqual(res.pointer.found, tr.found.map(([t, x, y]) => [+t.toFixed(5), x, y]));
  assert.equal(res.pointer.frames, tr.frames);
  // nothing that looks like a pointer for a minute: it stops looking and says so
  await assert.rejects(core.watch({ gw: 2, gh: GH }, Readable.from([Buffer.alloc(0)])), /Bad watch job/);
  const none = await core.watch({ gw: GW, gh: GH, pw: PW, ph: PH, giveUp: 0.5 }, Readable.from([Buffer.concat(Array.from({ length: 10 }, (_, i) => { const f = Buffer.alloc(9); f.writeDoubleLE(i * 0.2, 0); f[8] = 1; return Buffer.concat([f, Buffer.alloc(GW * GH, 90), Buffer.from(desk(0))]); }))]));
  assert.equal(none.pointer, null);
});
