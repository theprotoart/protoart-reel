import test from 'node:test';
import assert from 'node:assert/strict';
import { planGraphics, phraseScore } from '../app/renderer/lib/kinetic.js';

// a fake transcript: one word every 0.3 s, sentences as given
const say = (...sents) => { const out = []; let t = 0; for (const s of sents) { for (const w of s.split(' ')) { out.push({ text: w, t, end: t + 0.28 }); t += 0.3; } t += 1; } return out; };

test('punchy phrases score higher than plain ones', () => {
  assert.ok(phraseScore('Are you kidding me?').v > phraseScore('then we open the folder').v);
  assert.equal(phraseScore('Sales went up 312%').kind, 'percent');
  assert.equal(phraseScore('Did I really do that?').kind, 'question');
});

test('a plan picks the punchy lines, spaced out, with an accent word', () => {
  const w = say('So today we open the project folder.', 'And before you ask?', 'We click the button over here and wait.', 'This edit used to take me three hours.', 'Then we export it as usual like always.', 'Sales went up 312% in a week!', 'Okay that is all for the settings now.');
  const total = w[w.length - 1].end + 1;
  const plan = planGraphics(w, total, { amount: 'lots', look: 'bold' });
  assert.ok(plan.length >= 2);
  for (const g of plan) assert.match(g.text, /\*[^*]+\*/);
  for (let i = 1; i < plan.length; i++) assert.ok(plan[i].t - plan[i - 1].t >= 4);
  const q = plan.find(g => g.kind === 'question');
  assert.ok(q && q.anim === 'slam' && q.element === 'starburst');
  const pc = plan.find(g => g.kind === 'percent');
  assert.ok(pc && pc.element === 'chart' && pc.elementText === '312%');
});

test('off, or nothing said, plans nothing', () => {
  assert.deepEqual(planGraphics(say('Are you kidding me?'), 30, { amount: 'off' }), []);
  assert.deepEqual(planGraphics([], 30, { amount: 'lots' }), []);
});

test('the clean look keeps lower case and uses pill / serif / box accents', () => {
  const w = say('This is the best trick ever!', 'Then nothing happens here at all for a while okay.', 'You will never guess this one!');
  const plan = planGraphics(w, w[w.length - 1].end + 30, { amount: 'lots', look: 'clean' });
  assert.ok(plan.length);
  for (const g of plan) { assert.ok(['pill', 'serif', 'box'].includes(g.accent)); assert.notEqual(g.text, g.text.toUpperCase()); }
});

test('the mixed look varies the animation, the accent and the graphics', () => {
  const lines = ['This is the best trick ever!', 'Nothing beats this one.', 'You will never guess it!', 'Sales went up 40% overnight!', 'Is that even real?', 'Stop doing it the slow way!', 'This changes everything!', 'Only one click needed!'];
  const w = say(...lines.flatMap(l => [l, 'and then we carry on with the rest of the steps here.']));
  const plan = planGraphics(w, w[w.length - 1].end + 5, { amount: 'lots', look: 'mix' });
  assert.ok(plan.length >= 5);
  assert.ok(new Set(plan.map(g => g.anim)).size >= 4);
  assert.ok(new Set(plan.map(g => g.accent)).size >= 2);
  assert.ok(plan.some(g => g.element));
});
