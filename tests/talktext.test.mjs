// Talking text: the spoken words as short lines timed to the voice, and the key words as big pops.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spokenLines, keyWordPops, planTalkingText, emojiFor } from '../app/renderer/lib/talktext.js';

// "So um today I'll show you the one setting that saves hours. Why does nobody use it? It is 10x faster." at a steady pace
const say = (text, t0 = 1, per = 0.32, gaps = {}) => {
  let t = t0;
  return text.split(' ').map((w, i) => { t += gaps[i] || 0; const o = { text: w, t, end: t + per * 0.85 }; t += per; return o; });
};
const words = say('So um today I’ll show you the one setting that saves hours. Why does nobody use it? It is 10x faster. Never skip this step.', 1, 0.32, { 12: 0.8, 19: 5, 23: 5 });

test('spoken lines: a few words each, ums left out, breaks at sentence ends and pauses', () => {
  const lines = spokenLines(words, 40);
  assert.ok(lines.length >= 5);
  for (const l of lines) {
    assert.ok(l.text.split(' ').length <= 5 && l.text.length <= 36, l.text);
    assert.equal(l.wordTimes.length, l.text.split(' ').length);
    assert.ok(l.wordTimes.every((x, i, a) => x >= 0 && (i === 0 || x > a[i - 1])), 'each word later than the last');
  }
  assert.ok(!lines.some(l => /\bum\b/i.test(l.text)));
  assert.ok(lines.some(l => /hours\.$/.test(l.text)), 'a sentence ends a line');
  // lines never overlap, and the words are timed to the voice: the first word right at the line's start
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i - 1].t + lines[i - 1].dur <= lines[i].t + 1e-6);
  const first = lines[0]; assert.ok(first.wordTimes[0] <= 0.06);
});

test('tall videos get shorter lines', () => {
  assert.ok(spokenLines(words, 40, { tall: true }).every(l => l.text.split(' ').length <= 3));
});

test('key words: a question gets the big question, a number the big number, and they vary', () => {
  const pops = keyWordPops(words, 40, { amount: 'lots' });
  assert.ok(pops.length >= 2, JSON.stringify(pops));
  const q = pops.find(p => p.kind === 'question'); assert.ok(q && q.look === 'lookQuestion' && q.text === q.text.toUpperCase(), JSON.stringify(q));
  const n = pops.find(p => p.kind === 'number' || p.kind === 'percent'); assert.ok(n && n.look === 'lookNumber', JSON.stringify(pops));
  for (const p of pops) if (p.look === 'lookMarker' || p.look === 'lookUnderline') assert.match(p.text, /\*[^*]+\*/);
});

test('emoji that fit', () => {
  assert.equal(emojiFor('saves hours'), '⏱️'); assert.equal(emojiFor('WHY DOES NOBODY USE IT?'), '🤔'); assert.equal(emojiFor('never skip this'), '❌'); assert.equal(emojiFor('hello there'), null);
});

test('modes', () => {
  assert.deepEqual(planTalkingText(words, 40, { mode: 'off' }), { lines: [], pops: [] });
  const s = planTalkingText(words, 40, { mode: 'spoken' }); assert.ok(s.lines.length && !s.pops.length);
  const k = planTalkingText(words, 40, { mode: 'keywords' }); assert.ok(!k.lines.length && k.pops.length);
  // both: no line says the same thing under a key word
  const b = planTalkingText(words, 40, { mode: 'both', amount: 'lots' });
  for (const p of b.pops) assert.ok(!b.lines.some(l => l.t < p.t + p.dur - 0.1 && l.t + l.dur > p.t + 0.1 && l.dur * 0.5 < Math.min(l.t + l.dur, p.t + p.dur) - Math.max(l.t, p.t)));
  assert.ok(b.lines.length < s.lines.length);
});
