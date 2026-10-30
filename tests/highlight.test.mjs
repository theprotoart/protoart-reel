import test from 'node:test';
import assert from 'node:assert/strict';
import { sentences, pickHighlights, chapters } from '../app/renderer/lib/highlight.js';

// a talk: dull filler for a while, a strong stretch, then dull again
function talk() {
  const words = [];
  let t = 0;
  const say = (text, rate = 2.6, gapAfter = 0.3) => {
    for (const w of text.split(' ')) { words.push({ t, end: t + 0.9 / rate, text: w }); t += 1 / rate; }
    t += gapAfter;
  };
  for (let i = 0; i < 30; i++) say('so um yeah we uh kind of went there and um looked around.', 1.2, 1.2);
  const strongStart = t;
  for (let i = 0; i < 8; i++) say('Here is the secret nobody tells you about editing videos fast!', 2.8, 0.25);
  for (let i = 0; i < 4; i++) say('Why does this one trick save 3 hours every week?', 2.8, 0.25);
  const strongEnd = t;
  for (let i = 0; i < 30; i++) say('and um then uh we kind of went home and um that was it.', 1.2, 1.2);
  return { words, duration: t + 1, strongStart, strongEnd };
}

test('sentences split on punctuation and pauses', () => {
  const ss = sentences([{ t: 0, end: 0.3, text: 'Hello' }, { t: 0.4, end: 0.7, text: 'there.' }, { t: 0.8, end: 1, text: 'Next' }, { t: 3, end: 3.3, text: 'after' }]);
  assert.equal(ss.length, 3);
  assert.equal(ss[0].text, 'Hello there.');
});

test('the highlight lands on the strong stretch, on sentence boundaries, near the length asked for', () => {
  const { words, duration, strongStart, strongEnd } = talk();
  const [h] = pickHighlights({ words, duration, length: { min: 15, ideal: 30, max: 60 } });
  assert.ok(h.t0 >= strongStart - 1 && h.t1 <= strongEnd + 1, `picked ${h.t0.toFixed(1)}–${h.t1.toFixed(1)}, strong ${strongStart.toFixed(1)}–${strongEnd.toFixed(1)}`);
  assert.ok(h.t1 - h.t0 >= 15 && h.t1 - h.t0 <= 60.5);
  const starts = new Set(sentences(words).map(s => Math.round((s.t - 0.12) * 100)));
  assert.ok(starts.has(Math.round(h.t0 * 100)) || h.t0 === 0, 'starts at a sentence');
});

test('several shorts don’t overlap; short videos are kept whole; no speech uses movement', () => {
  const { words, duration } = talk();
  const hs = pickHighlights({ words, duration, length: { min: 10, ideal: 20, max: 30 }, count: 3 });
  assert.equal(hs.length, 3);
  for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) assert.ok(hs[i].t1 <= hs[j].t0 || hs[j].t1 <= hs[i].t0);
  assert.deepEqual(pickHighlights({ words, duration: 40, length: { min: 10, ideal: 30, max: 60 } }), [{ t0: 0, t1: 40, score: 1, text: '' }]);
  const motion = Array.from({ length: 600 }, (_, i) => ({ t: i * 0.5, motion: i > 300 && i < 360 ? 0.2 : 0.01 }));
  const [m] = pickHighlights({ words: [], motion, duration: 300, length: { min: 15, ideal: 30, max: 45 } });
  assert.ok(m.t0 >= 140 && m.t1 <= 190, `${m.t0}–${m.t1}`);
});

test('chapters start at 0:00, are spaced out and named', () => {
  const { words, duration } = talk();
  const ch = chapters(words, duration, { every: 60, gap: 30 });
  assert.ok(ch.length >= 3);
  assert.equal(ch[0].t, 0);
  for (let i = 1; i < ch.length; i++) { assert.ok(ch[i].t - ch[i - 1].t >= 29.9); assert.ok(ch[i].label.length > 0); }
});
