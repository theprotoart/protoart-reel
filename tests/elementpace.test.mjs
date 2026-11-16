// Dragging an element longer makes its animation take that much longer (loops and visualizers stay real-time).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ELEMENTS, drawElement, elementPace, ELEMENT_LENGTH } from '../app/renderer/lib/elements.js';

// a canvas that writes down everything drawn
function rec() {
  const log = [];
  const ctx = new Proxy({ log }, {
    get(o, k) {
      if (k in o) return o[k];
      if (k === 'measureText') return s => ({ width: String(s).length * 20 });
      if (/^create/.test(k)) return () => ({ addColorStop() {} });
      return (...a) => { log.push(k + '(' + a.map(v => (typeof v === 'number' ? v.toFixed(2) : typeof v === 'string' ? v : '')).join(',') + ')'); };
    },
    set(o, k, v) { if (k !== 'log') log.push(k + '=' + (typeof v === 'number' ? v.toFixed(3) : String(v))); return true; },
  });
  return ctx;
}
const draw = (kind, t, d) => { const c = rec(); drawElement(c, { kind }, { x: 0.5, y: 0.5 }, t, d, 1920, 1080); return c.log.join(';'); };

test('every element: twice as long = the same picture at twice the time', () => {
  for (const kind of Object.keys(ELEMENTS)) {
    if (elementPace(kind, 8) === 1 || ELEMENTS[kind].group === 'Lower thirds') continue; // (lower thirds: checked below)
    const s = elementPace(kind, 8);
    for (const u of [0.15, 0.4, 0.75]) assert.equal(draw(kind, 8 * u, 8), draw(kind, 8 * u / s, 8 / s), `${kind} at ${u}`);
  }
});

test('longer really is slower: a check mark, a typed comment, the like/subscribe clicks', () => {
  for (const kind of ['check', 'commentPrompt', 'likeSubscribe', 'confetti', 'noteCard', 'chart', 'routeMap']) {
    assert.notEqual(draw(kind, 1, 4), draw(kind, 1, 12), kind);
    assert.equal(elementPace(kind, 12), 3);
  }
});

test('4 s or shorter plays as made; loops, clocks and visualizers stay real-time; lower thirds slow gently', () => {
  assert.equal(elementPace('check', ELEMENT_LENGTH), 1);
  assert.equal(elementPace('check', 1.5), 1);
  for (const k of ['bgHorizon', 'bgWaveGrid', 'vizBars', 'sparkle', 'bubbles', 'vhs', 'scoreBug', 'newsTicker']) assert.equal(elementPace(k, 16), 1, k);
  assert.equal(elementPace('ltBar', 16), 2);
});
