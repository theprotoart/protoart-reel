import test from 'node:test';
import assert from 'node:assert/strict';
import { RATE, to16k, fingerprint, dtw, bursts, train, findInSamples, packModel, unpackModel, addTake, addNot } from '../app/renderer/lib/umvoice.js';

// A tiny voice: a glottal pulse train through formant resonators (source-filter), so vowels sound like vowels.
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
function voice(sec, formants, { f0 = 115, drift = 0, noise = 0, amp = 0.3 } = {}) {
  const n = Math.round(sec * RATE), src = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const f = f0 * (1 + drift * (i / n - 0.5));
    ph += f / RATE; if (ph >= 1) { ph -= 1; src[i] = 1; }
    if (noise) src[i] += (rnd() * 2 - 1) * noise;
  }
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
const UMM = [[250, 80], [1100, 150], [2300, 200]];      // a closed, nasal "mm"
const UH = [[650, 90], [1200, 110], [2550, 160]];       // the open "uh"
const OTHER = [[[300, 70], [2300, 120], [3000, 200]], [[700, 100], [1700, 130], [2600, 160]], [[450, 80], [800, 100], [2800, 170]], [[350, 70], [1900, 130], [2700, 180]]];
const hiss = sec => { const n = Math.round(sec * RATE); return Float32Array.from({ length: n }, () => (rnd() * 2 - 1) * 0.08); };
const quiet = sec => new Float32Array(Math.round(sec * RATE)).map(() => (rnd() * 2 - 1) * 0.002);
const cat = parts => { const n = parts.reduce((s, p) => s + p.length, 0), o = new Float32Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
// a sentence: vowels of other words and hissy consonants run together, no pauses between syllables
const sentence = (sec, f0 = 120) => { const parts = []; let t = 0, i = 0; while (t < sec) { const d = 0.08 + rnd() * 0.14; parts.push(i % 3 === 2 ? hiss(0.06) : voice(d, OTHER[i % OTHER.length], { f0: f0 * (0.9 + rnd() * 0.2) })); t += d; i++; } return cat(parts); };

test('a fingerprint ignores loudness, and dynamic time warping matches a slow um to a quick one', () => {
  const slow = fingerprint(voice(0.9, UMM)), quick = fingerprint(voice(0.35, UMM)), loud = fingerprint(voice(0.6, UMM, { amp: 0.9 })), uh = fingerprint(voice(0.5, UH));
  assert.ok(dtw(slow, quick) < dtw(slow, uh), 'a quick umm is closer to a slow umm than an uh is');
  assert.ok(dtw(loud, quick) < dtw(loud, uh));
});

test('bursts: something said on its own, between pauses; the middle of a sentence is not', () => {
  const x = cat([quiet(0.5), voice(0.4, UMM), quiet(0.4), sentence(2.5), quiet(0.5)]);
  const b = bursts(x);
  assert.ok(b.some(r => Math.abs(r.a / RATE - 0.5) < 0.08 && Math.abs(r.b / RATE - 0.9) < 0.15), JSON.stringify(b.map(r => [r.a / RATE, r.b / RATE])));
  assert.ok(!b.some(r => r.a / RATE > 1.4 && r.b / RATE < 3.6 && (r.b - r.a) / RATE < 1), 'no short burst inside the sentence');
});

test('trained on your takes, it finds your ums (slow or quick, higher or lower) and leaves ordinary speech alone', () => {
  const takes = [
    { word: 'umm', samples: cat([quiet(0.3), voice(0.9, UMM, { f0: 105, drift: -0.1 }), quiet(0.3)]) },
    { word: 'umm', samples: cat([quiet(0.3), voice(0.55, UMM, { f0: 118 }), quiet(0.3)]) },
    { word: 'umm', samples: cat([quiet(0.3), voice(0.32, UMM, { f0: 125, drift: 0.1 }), quiet(0.3)]) },
    { word: 'uh', samples: cat([quiet(0.3), voice(0.7, UH, { f0: 110 }), quiet(0.3)]) },
    { word: 'uh', samples: cat([quiet(0.3), voice(0.45, UH, { f0: 120 }), quiet(0.3)]) },
    { word: 'uh', samples: cat([quiet(0.3), voice(0.25, UH, { f0: 128 }), quiet(0.3)]) },
  ];
  const model = train({ takes, speech: sentence(6) });
  assert.ok(model.threshold > 0 && model.words.length === 2);
  // a recording: speech, an umm, speech, an uh, speech, a short word on its own (not an um), speech
  const parts = [quiet(0.4), sentence(2), quiet(0.3), voice(0.6, UMM, { f0: 112 }), quiet(0.3), sentence(2.2), quiet(0.35),
    voice(0.4, UH, { f0: 116 }), quiet(0.3), sentence(1.8), quiet(0.4), voice(0.3, OTHER[0], { f0: 120 }), quiet(0.4), sentence(1.5), quiet(0.4)];
  const startOf = i => parts.slice(0, i).reduce((s, p) => s + p.length, 0) / RATE;
  const x = cat(parts);
  const found = findInSamples(model, x);
  const at = t => found.find(f => f.t <= t + 0.1 && f.end >= t + 0.2);
  const umAt = startOf(3), uhAt = startOf(7), otherAt = startOf(11);
  assert.equal(at(umAt)?.word, 'umm', JSON.stringify(found));
  assert.equal(at(uhAt)?.word, 'uh', JSON.stringify(found));
  assert.equal(at(otherAt), undefined, 'a different word said on its own is not an um');
  assert.ok(found.length <= 3, `only the ums (and at most one near miss): ${found.length}`);
});

test('a model survives being stored and read back; damaged ones are refused', () => {
  const takes = [0.5, 0.4, 0.3].map(d => ({ word: 'umm', samples: cat([quiet(0.2), voice(d, UMM), quiet(0.2)]) }));
  const m = train({ takes, speech: sentence(3) });
  const back = unpackModel(packModel(m));
  assert.equal(back.words[0].prints.length, 3);
  assert.ok(Math.abs(back.threshold - m.threshold) < 1e-9);
  assert.equal(unpackModel('{"version":2}'), null);
  assert.equal(unpackModel('not json'), null);
});

test('to16k keeps the length right', () => {
  assert.equal(to16k(new Float32Array(48000), 48000).length, 16000);
  assert.equal(to16k(new Float32Array(44100), 44100).length, 16000);
});

test('a guest who reads nothing: their ums picked from the recording teach it, with the speech around them', () => {
  const G_UM = [[300, 90], [1250, 160], [2500, 210]]; // a different, lower voice
  let m = null;
  const piece = (d, f0) => cat([quiet(0.15), voice(d, G_UM, { f0 }), quiet(0.15)]);
  m = addTake(m, 'umm', piece(0.5, 92), sentence(3, 95));
  m = addTake(m, 'umm', piece(0.35, 98), sentence(3, 95));
  m = addTake(m, 'umm', piece(0.7, 88), null);
  assert.equal(m.words[0].prints.length, 3);
  const parts = [quiet(0.4), sentence(2, 95), quiet(0.3), voice(0.55, G_UM, { f0: 94 }), quiet(0.3), sentence(2, 95), quiet(0.4)];
  const um = parts.slice(0, 3).reduce((s, p) => s + p.length, 0) / RATE;
  const found = findInSamples(m, cat(parts));
  assert.ok(found.some(f => f.t <= um + 0.1 && f.end >= um + 0.3), JSON.stringify(found));
});

test('"not an um": something it matched by mistake is never matched again', () => {
  const takes = [0.6, 0.45, 0.3].map(d => ({ word: 'umm', samples: cat([quiet(0.2), voice(d, UMM), quiet(0.2)]) }));
  const m = train({ takes, speech: sentence(5) });
  // a hum close to an umm (a slightly different nasal sound) that it might take for one
  const HUM = [[270, 85], [1150, 150], [2350, 200]];
  const x = cat([quiet(0.4), voice(0.5, HUM, { f0: 110 }), quiet(0.4)]);
  const before = findInSamples(m, x).length;
  addNot(m, x);
  assert.equal(findInSamples(m, x).length, 0, `matched ${before} before, none after`);
  // and a real umm still is
  assert.equal(findInSamples(m, cat([quiet(0.4), voice(0.5, UMM, { f0: 118 }), quiet(0.4)])).length, 1);
  assert.equal(unpackModel(packModel(m)).nots.length, 1);
});

test('a breath you taught is found even though it is far quieter than speech; ums are not looked for in the quiet', () => {
  // a breath: soft, airy noise through a broad resonance, about a tenth as loud as the speech
  const breath = sec => { const n = Math.round(sec * RATE), o = new Float32Array(n); let y1 = 0; for (let i = 0; i < n; i++) { y1 = 0.6 * y1 + (rnd() * 2 - 1); o[i] = y1 * 0.012 * Math.sin(Math.PI * i / n); } return o; };
  const takes = [0.6, 0.45, 0.3].map(d => ({ word: 'umm', samples: cat([quiet(0.2), voice(d, UMM), quiet(0.2)]) }));
  let m = train({ takes, speech: sentence(5) });
  for (const d of [0.5, 0.4, 0.6]) m = addTake(m, 'breath', cat([quiet(0.15), breath(d), quiet(0.15)]), null);
  const parts = [quiet(0.4), sentence(2), quiet(0.3), breath(0.45), quiet(0.3), sentence(2), quiet(0.4)];
  const at = parts.slice(0, 3).reduce((s, p) => s + p.length, 0) / RATE;
  const found = findInSamples(m, cat(parts));
  assert.ok(found.some(f => f.word === 'breath' && f.t <= at + 0.1 && f.end >= at + 0.25), JSON.stringify(found));
  assert.ok(!found.some(f => f.word === 'umm'), 'no ums in a recording without any');
});

test('a taught breath that runs straight into the next word (no pause between) is still found', () => {
  const breath = sec => { const n = Math.round(sec * RATE), o = new Float32Array(n); let y1 = 0; for (let i = 0; i < n; i++) { y1 = 0.6 * y1 + (rnd() * 2 - 1); o[i] = y1 * 0.012 * Math.min(1, i / (0.08 * RATE)); } return o; };
  let m = train({ takes: [0.6, 0.45, 0.3].map(d => ({ word: 'umm', samples: cat([quiet(0.2), voice(d, UMM), quiet(0.2)]) })), speech: sentence(5) });
  for (const d of [0.5, 0.4, 0.6]) m = addTake(m, 'breath', cat([quiet(0.15), breath(d), quiet(0.15)]), null);
  const parts = [quiet(0.4), sentence(2), quiet(0.4), breath(0.45), sentence(2), quiet(0.4)]; // the breath, then speech at once
  const at = parts.slice(0, 3).reduce((s, p) => s + p.length, 0) / RATE;
  const found = findInSamples(m, cat(parts));
  assert.ok(found.some(f => f.word === 'breath' && f.t <= at + 0.15 && f.end >= at + 0.3), JSON.stringify(found));
});

test('a sound taught from the timeline keeps the name you gave it (yawning stays yawning, not um)', async () => {
  const { _wordOf } = await import('../app/renderer/umvoice.js');
  assert.deepEqual(['um', 'Ummm', 'uh', 'uhhh', 'er', 'yawning', 'Breath', 'lip smack'].map(_wordOf), ['umm', 'umm', 'uh', 'uh', 'er', 'yawning', 'breath', 'lip smack']);
});
