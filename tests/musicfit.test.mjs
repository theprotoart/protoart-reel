import test from 'node:test';
import assert from 'node:assert/strict';
import { analyse, planFit, render, refineJoin, mmss } from '../app/renderer/lib/musicfit.js';

// a made-up 60 s song at 8 kHz: an 8 s intro (a rising tone), a 4 s phrase of notes repeated 10 times, an 12 s outro
const RATE = 8000;
function song() {
  const n = 60 * RATE, x = new Float32Array(n);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const notes = [220, 277, 330, 440, 392, 330, 294, 262];
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    if (t < 8) x[i] = 0.4 * Math.sin(2 * Math.PI * (150 + t * t * 40) * t) + 0.02 * rnd();
    else if (t < 48) { const u = (t - 8) % 4, f = notes[Math.floor(u * 2)], env = Math.exp(-((u * 2) % 1) * 3); x[i] = 0.5 * env * Math.sin(2 * Math.PI * f * t) + 0.15 * Math.sin(2 * Math.PI * 55 * t); }
    else x[i] = 0.4 * Math.sin(2 * Math.PI * (330 - (t - 48) * 10) * t) * (1 - (t - 48) / 12);
  }
  return x;
}

test('finds the repeats: jumps that are whole phrases (multiples of 4 s) inside the repeating part', async () => {
  const { cands } = await analyse(song(), RATE, { minGap: 3.5 });
  assert.ok(cands.length >= 3, `found ${cands.length}`);
  for (const c of cands.slice(0, 5)) {
    const L = c.b - c.a;
    assert.ok(Math.abs(L / 4 - Math.round(L / 4)) * 4 < 0.25, `jump of ${L.toFixed(2)} s is not a whole phrase`);
    assert.ok(c.a > 7 && c.b < 49, `jump ${c.a.toFixed(1)}→${c.b.toFixed(1)} is outside the repeating part`);
  }
});

test('longer and shorter plans keep the start and the ending and land near the length asked for', async () => {
  const { cands } = await analyse(song(), RATE, { minGap: 3.5 });
  for (const T of [95, 150, 41, 30]) {
    const p = planFit(cands, 60, T);
    assert.equal(p.segments[0].from, 0);
    assert.equal(p.segments.at(-1).to, 60);
    const len = p.segments.reduce((s, x) => s + x.to - x.from, 0);
    assert.ok(Math.abs(len - p.length) < 1e-6);
    assert.ok(Math.abs(len - T) <= 2.1, `asked ${T}, got ${len.toFixed(1)}`);
    for (const s of p.segments) assert.ok(s.to > s.from);
  }
  assert.equal(planFit(cands, 60, 60.2).jumps, 0); // already the right length: unchanged
});

test('render: the right length, joins lined up, no clicks at the joins', async () => {
  const x = song();
  const { cands } = await analyse(x, RATE, { minGap: 3.5 });
  const plan = planFit(cands, 60, 100);
  const r = render([x, x], RATE, plan);
  assert.equal(r.channels.length, 2);
  assert.ok(Math.abs(r.seconds - plan.length) < 0.1);
  // the biggest sample-to-sample step anywhere stays like the original's (a seam would jump)
  const maxStep = a => { let m = 0; for (let i = 1; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - a[i - 1])); return m; };
  assert.ok(maxStep(r.channels[0]) <= maxStep(x) * 1.25 + 1e-3, 'a click at a join');
  // refineJoin moves a slightly-off landing back onto the phrase
  const q = refineJoin(x, RATE, 20, 16.013);
  assert.ok(Math.abs(q - 16) < 0.004, `landed at ${q}`);
});

test('mm:ss', () => { assert.equal(mmss(59.6), '1:00'); assert.equal(mmss(200), '3:20'); });
