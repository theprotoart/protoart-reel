// ADR alignment: a take with different timing is warped back onto the guide's.
import test from 'node:test';
import assert from 'node:assert';
import { align } from '../app/renderer/lib/align.js';
import { warp } from '../app/renderer/lib/stretch.js';

const rate = 16000;
// a voice-like line: "syllables" (harmonic tones at different pitches, with a formant-ish envelope) and gaps
function line(sylls) {
  const end = sylls.at(-1).t + sylls.at(-1).d + 0.5, x = new Float32Array(Math.round(end * rate));
  let seed = 3; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  for (const s of sylls) for (let i = 0; i < s.d * rate; i++) {
    const t = i / rate, env = Math.sin((Math.PI * t) / s.d) ** 0.5, k = Math.round(s.t * rate) + i;
    let v = 0; for (let h = 1; h <= 8; h++) v += (Math.sin(2 * Math.PI * s.f * h * t) / h) * (h * s.f > s.form && h * s.f < s.form * 2 ? 2 : 0.4);
    x[k] += 0.15 * env * v + 0.01 * rnd();
  }
  return x;
}
const words = [{ f: 140, form: 700 }, { f: 170, form: 1200 }, { f: 120, form: 500 }, { f: 160, form: 2000 }, { f: 150, form: 900 }, { f: 135, form: 1500 }];
const guideS = words.map((w, i) => ({ ...w, t: 0.4 + i * 0.45, d: 0.3 }));
// the take: late by 0.18 s, some words slower, some faster, a longer pause in the middle
const takeS = words.map((w, i) => ({ ...w, t: 0.58 + i * 0.5 + (i >= 3 ? 0.25 : 0), d: i % 2 ? 0.36 : 0.26 }));

test('alignment maps each take syllable onto its guide syllable', () => {
  const g = line(guideS), d = line(takeS);
  const r = align(g, rate, d, rate, { tightness: 0.7, maxStretch: 0.8 });
  for (let i = 0; i < words.length; i++) {
    const gm = guideS[i].t + guideS[i].d / 2, tm = takeS[i].t + takeS[i].d / 2;
    assert.ok(Math.abs(r.at(gm) - tm) < 0.06, `word ${i}: guide ${gm.toFixed(2)} → take ${r.at(gm).toFixed(3)} (should be ${tm.toFixed(3)})`);
  }
});

test('the warped take lines up with the guide (envelopes match far better than before)', () => {
  const g = line(guideS), d = line(takeS);
  const r = align(g, rate, d, rate, { tightness: 0.7, maxStretch: 0.8 });
  const [y] = warp([d], o => r.at(o / rate) * rate, g.length, rate);
  const env = x => { const e = []; for (let i = 0; i + 320 <= x.length; i += 160) { let s = 0; for (let k = 0; k < 320; k++) s += x[i + k] * x[i + k]; e.push(Math.sqrt(s / 320)); } return e; };
  const corr = (a, b) => { const n = Math.min(a.length, b.length); let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n; let s = 0, sa = 0, sb = 0; for (let i = 0; i < n; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; } return s / Math.sqrt(sa * sb); };
  const before = corr(env(g), env(d)), after = corr(env(g), env(y));
  assert.ok(after > 0.85 && after > before + 0.3, `before ${before.toFixed(2)}, after ${after.toFixed(2)}`);
});

test('a take read with extra sound around it (margins) and at another rate still lands on the guide', () => {
  const g = line(guideS), d0 = line(takeS);
  // 44.1 kHz take with 1.5 s of room tone either side
  const r44 = 44100, up = new Float32Array(Math.round((d0.length / rate) * r44));
  for (let i = 0; i < up.length; i++) { const p = (i * rate) / r44, j = Math.floor(p), f = p - j; up[i] = (d0[j] || 0) * (1 - f) + (d0[j + 1] || 0) * f; }
  const pad = Math.round(1.5 * r44), d = new Float32Array(up.length + 2 * pad); d.set(up, pad);
  for (let i = 0; i < d.length; i++) d[i] += 0.002 * Math.sin(i * 0.37);
  const r = align(g, rate, d, r44, { tightness: 0.7, maxStretch: 0.8 });
  for (let i = 0; i < words.length; i++) {
    const gm = guideS[i].t + guideS[i].d / 2, tm = takeS[i].t + takeS[i].d / 2 + 1.5;
    assert.ok(Math.abs(r.at(gm) - tm) < 0.06, `word ${i}: ${r.at(gm).toFixed(3)} vs ${tm.toFixed(3)}`);
  }
});
