import test from 'node:test';
import assert from 'node:assert/strict';
import { fillerHits, soundHits, findUms, levelOnTimeline } from '../app/renderer/lib/ums.js';
import { removeRange, insertTime } from '../app/renderer/model.js';

const W = (t, end, text) => ({ t, end, text });

test('um and uh are found and marked CUT; "you know" and a standalone "like" are found and kept', () => {
  const words = [W(0, 0.4, 'So'), W(0.5, 0.8, 'um,'), W(1.2, 1.5, 'today'), W(1.6, 1.8, 'uhh'), W(2.4, 2.6, 'you'), W(2.6, 2.8, 'know'),
    W(3.5, 3.8, 'like'), W(4.0, 4.3, 'I'), W(4.35, 4.6, 'like'), W(4.65, 5, 'it')];
  const h = fillerHits(words);
  assert.deepEqual(h.map(x => [x.text, x.cut]), [['um', true], ['uhh', true], ['you know', false], ['like', false]]);
  assert.ok(h[0].end > 0.8 && h[0].end <= 1.0, 'reaches a little into the pause after');
});

test('a loud short sound in a gap between words is listed as a sound; a quiet breath is not', () => {
  const words = [W(0, 1, 'hello'), W(2, 3, 'there'), W(4, 5, 'friend')];
  const level = t => (t >= 0 && t < 1) || (t >= 2 && t < 3) || (t >= 4 && t < 5) ? 0.6 // speech
    : t >= 1.3 && t < 1.7 ? 0.5   // an unheard um
    : t >= 3.3 && t < 3.6 ? 0.12  // a breath
    : 0.02;
  const s = soundHits(words, level);
  assert.equal(s.length, 1);
  assert.ok(s[0].t > 1.2 && s[0].t < 1.35 && s[0].end > 1.65 && s[0].end < 1.8, `${s[0].t}–${s[0].end}`);
  assert.equal(s[0].cut, false);
});

test('a sound that overlaps a heard um is listed once', () => {
  const words = [W(0, 1, 'hello'), W(1.3, 1.6, 'um'), W(2, 3, 'there')];
  const level = t => (t < 1 || (t >= 1.3 && t < 1.6) || (t >= 2 && t < 3)) ? 0.6 : 0.02;
  assert.deepEqual(findUms(words, level).map(u => u.kind), ['word']);
});

test('the level follows a clip moved, trimmed and sped up on the timeline', () => {
  const data = new Float32Array(1000); data[250] = 0.9; // source 2.5 s
  const lv = levelOnTimeline([{ clip: { start: 10, in: 1.5, duration: 5, speed: 2 }, peaks: { rate: 100, data } }]);
  assert.ok(Math.abs(lv(10.5) - 0.9) < 1e-6); // 1.5 + 0.5 × 2 = 2.5
  assert.equal(lv(9), 0);
});

test('found ums follow cuts and inserted time', () => {
  const doc = { tracks: [{ id: 't' }], clips: [{ id: 'a', track: 't', start: 0, duration: 20 }], markers: [], captions: [],
    ums: [{ id: 'u1', t: 2, end: 2.4 }, { id: 'u2', t: 5, end: 5.3 }, { id: 'u3', t: 9, end: 9.5 }] };
  removeRange(doc, 4.9, 5.4);
  assert.deepEqual(doc.ums.map(u => [u.id, +u.t.toFixed(2)]), [['u1', 2], ['u3', 8.5]]);
  insertTime(doc, 3, 1);
  assert.deepEqual(doc.ums.map(u => +u.t.toFixed(2)), [2, 9.5]);
});
