import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseMusic, beatGrid, planFit, likeness, fft } from '../app/renderer/lib/musicfit.js';
import { retimePreset, mapAt, slopeAt, cutRetime, movePoint, addPoint, setPoint, invertAt, meanSpeed, validRetime } from '../app/renderer/lib/retime.js';

// a synthetic song: a kick every 0.5 s (120 a minute) and a four-chord phrase of 8 s that repeats
const RATE = 11025;
function song(seconds) {
  const x = new Float32Array(Math.round(seconds * RATE));
  const chords = [[220, 277, 330], [196, 247, 294], [175, 220, 262], [196, 247, 311]];
  for (let i = 0; i < x.length; i++) {
    const t = i / RATE, ch = chords[Math.floor(t / 2) % 4], beat = t % 0.5;
    let v = ch.reduce((s, f) => s + Math.sin(2 * Math.PI * f * t), 0) * 0.08;
    v += Math.sin(2 * Math.PI * 60 * beat) * Math.exp(-beat * 30) * 0.6; // kick
    x[i] = v;
  }
  return x;
}

test('the FFT finds a tone', () => {
  const n = 64, re = new Float32Array(n), im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 5 * i) / n);
  fft(re, im);
  const mag = Array.from(re, (v, i) => Math.hypot(v, im[i]));
  assert.equal(mag.indexOf(Math.max(...mag.slice(0, n / 2))), 5);
});

test('the beat grid finds 120 a minute', () => {
  const an = analyseMusic(song(24), RATE);
  const g = beatGrid(an);
  assert.ok(Math.abs(g.period - 0.5) < 0.06, `period ${g.period}`);
});

test('the same moment of the phrase sounds alike; a different chord less so', () => {
  const an = analyseMusic(song(32), RATE);
  assert.ok(likeness(an, 4.0, 12.0) > likeness(an, 4.0, 6.0) + 0.1);
});

test('shortening skips a whole number of phrases and keeps the ending', () => {
  const an = analyseMusic(song(48), RATE), g = beatGrid(an);
  const p = planFit(an, g, 48, 32);
  assert.equal(p.segments.length, 2);
  assert.equal(p.segments[0].a, 0);
  assert.equal(p.segments[1].b, 48);
  assert.ok(Math.abs(p.length - 32) < 1, `length ${p.length}`);
  assert.ok(p.seams[0].likeness > 0.55);
});

test('lengthening loops a section and lands on the target', () => {
  const an = analyseMusic(song(32), RATE), g = beatGrid(an);
  const p = planFit(an, g, 32, 60);
  assert.ok(p.segments.length >= 3);
  assert.ok(Math.abs(p.length * (1 / p.speed) - 60) < 1.2, `length ${p.length} speed ${p.speed}`);
  assert.equal(p.segments.at(-1).b, 32);
  // every seam joins alike-sounding moments
  for (const s of p.seams) assert.ok(s.likeness > 0.55);
});

test('a near fit is left alone', () => {
  const an = analyseMusic(song(12), RATE), g = beatGrid(an);
  assert.deepEqual(planFit(an, g, 12, 12.02).segments, [{ a: 0, b: 12 }]);
});

test('time maps: elastic markers, cuts and curves', () => {
  let p = [{ t: 0, s: 0 }, { t: 10, s: 10 }];
  p = addPoint(p, 4);
  assert.equal(p.length, 3);
  p = movePoint(p, 1, 5); // the moment at 4 s now plays at 5 s: slower before, faster after
  assert.ok(Math.abs(slopeAt(p, 2) - 0.8) < 1e-9 && Math.abs(slopeAt(p, 7) - 1.2) < 1e-9);
  assert.ok(Math.abs(mapAt(p, 5) - 4) < 1e-9 && Math.abs(invertAt(p, 4) - 5) < 1e-9);
  // a marker can't be pushed past its neighbour or past the speed limits
  const q = movePoint(p, 1, 9.99);
  assert.ok(q[1].t < 10 && slopeAt(q, 9.995) <= 8 + 1e-9);
  const { pts, s0 } = cutRetime(p, 5, 10);
  assert.ok(Math.abs(s0 - 4) < 1e-9 && validRetime(pts) && Math.abs(pts.at(-1).s - 6) < 1e-9);
  const r = retimePreset('ramp', 8, 8);
  assert.ok(validRetime(r) && slopeAt(r, 4) > 1.5 && slopeAt(r, 0.2) < 1);
  assert.ok(Math.abs(meanSpeed(r) - 1) < 0.05);
  const s = setPoint(p, 2, 10, 14); // more source in the same time: the end speeds up
  assert.ok(s[2].s === 14 && s[2].t === 10);
});
