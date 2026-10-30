// Timed words → captions, filler and pause cuts.
import test from 'node:test';
import assert from 'node:assert';
import { wordsOnTimeline, buildCaptions, fillerRanges, pauseRanges, mergeRanges, mergeWords } from '../app/renderer/lib/words.js';

const W = (list) => { let t = 0; return list.map(x => { if (typeof x === 'number') { t += x; return null; } const w = { t, end: t + 0.3, text: x, conf: 0.9 }; t += 0.35; return w; }).filter(Boolean); };

test('words follow the clip: start, in-point, speed', () => {
  const r = wordsOnTimeline([[10, 0.5, 'hello', 1], [12, 0.5, 'world', 1], [30, 1, 'outside', 1]], { id: 'c', start: 5, in: 10, duration: 2, speed: 2 });
  assert.equal(r.length, 2);
  assert.ok(Math.abs(r[0].t - 5) < 1e-9 && Math.abs(r[1].t - 6) < 1e-9);
});
test('captions break at sentence ends, pauses and length, and never overlap', () => {
  const w = W(['Hello', 'there.', 'This', 'is', 'a', 'test', 1.2, 'after', 'a', 'pause', 'that', 'goes', 'on', 'and', 'on', 'and', 'on', 'for', 'a', 'very', 'long', 'time', 'indeed']);
  const c = buildCaptions(w, { maxChars: 40 });
  assert.equal(c[0].text, 'Hello there.');
  assert.ok(c[1].text.replace('\n', ' ').startsWith('This is a test'));
  for (let i = 0; i + 1 < c.length; i++) assert.ok(c[i].end <= c[i + 1].t + 1e-9);
  for (const x of c) for (const line of x.text.split('\n')) assert.ok(line.length <= 40);
});
test('filler words become cuts; "like" only when it stands alone', () => {
  const w = W(['So', 'um', 'I', 'think', 0.4, 'like', 0.4, 'we', 'should', 'like', 'this', 'you', 'know']);
  const r = fillerRanges(w);
  const cutText = w.filter(x => r.some(q => x.t >= q.t - 1e-6 && x.end <= q.end + 1e-6)).map(x => x.text);
  assert.deepStrictEqual(cutText, ['um', 'like', 'you', 'know']);
});
test('long pauses are shortened, short ones kept', () => {
  const w = W(['one', 0.2, 'two', 2, 'three']);
  const r = pauseRanges(w, { longer: 0.8, keep: 0.3 });
  assert.equal(r.length, 1);
  assert.ok(Math.abs((r[0].end - r[0].t) - (2.05 - 0.3)) < 1e-6);
});
test('ranges merge; duplicate words from two clips are kept once', () => {
  assert.deepStrictEqual(mergeRanges([{ t: 2, end: 3 }, { t: 0, end: 1 }, { t: 0.99, end: 1.5 }]), [{ t: 0, end: 1.5 }, { t: 2, end: 3 }]);
  const a = [{ t: 1, end: 1.3, text: 'Hi', conf: 0.5 }], b = [{ t: 1.05, end: 1.3, text: 'hi', conf: 0.9 }];
  const m = mergeWords([a, b]); assert.equal(m.length, 1); assert.equal(m[0].conf, 0.9);
});
