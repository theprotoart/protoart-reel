import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spokenNote, toNote, planNotes, shiftWords, shiftTimes } from '../app/renderer/lib/clapnotes.js';

// words said at a steady pace from t, 0.35 s each
const say = (t, text) => text.split(' ').map((w, i) => ({ t: t + i * 0.4, end: t + i * 0.4 + 0.35, text: w }));

test('a list with a title becomes a title and items', () => {
  assert.deepEqual(toNote('Ingredients: two eggs, a cup of flour and a pinch of salt.'), { title: 'INGREDIENTS', items: ['Two eggs', 'A cup of flour', 'A pinch of salt'] });
  assert.deepEqual(toNote('Note, you will need eggs and flour and sugar'), { title: 'YOU WILL NEED', items: ['Eggs', 'Flour', 'Sugar'] });
  assert.deepEqual(toNote('Step 2. Whisk until smooth.'), { title: 'STEP 2', items: ['Whisk until smooth'] });
  assert.deepEqual(toNote('Preheat the oven to 200 degrees'), { title: '', items: ['Preheat the oven to 200 degrees'] });
  assert.deepEqual(toNote('Oven 180 C, fan 160 C'), { title: 'OVEN', items: ['180 C', 'Fan 160 C'] });
});

test('the note is what is said after the clap, up to the first long pause', () => {
  const words = [...say(1, 'hello there'), ...say(10.2, 'ingredients: two eggs, flour'), ...say(14, 'now we whisk')];
  const n = spokenNote(words, 10);
  assert.equal(n.text, 'ingredients: two eggs, flour');
  assert.ok(Math.abs(n.t0 - 10.2) < 1e-9 && n.t1 < 14);
  assert.equal(spokenNote(words, 30), null); // nothing said after
});

test('every clap gets a card, with a placeholder when nothing was said', () => {
  const words = [...say(5.3, 'ingredients: eggs, flour, salt'), ...say(30, 'and stir')];
  const plan = planNotes(words, [5, 20]);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].title, 'INGREDIENTS');
  assert.deepEqual(plan[0].items, ['Eggs', 'Flour', 'Salt']);
  assert.ok(plan[0].dur >= 4 && plan[0].dur < 15);
  assert.ok(plan[0].said);
  assert.equal(plan[1].placeholder, true);
  assert.deepEqual(plan[1].items, ['Type your note here']);
});

test('a card never runs into the next one', () => {
  const words = [...say(1.2, 'tip: use cold butter'), ...say(4.2, 'step two: fold')];
  const plan = planNotes(words, [1, 4]);
  assert.ok(plan[0].t + plan[0].dur <= 4);
});

test('cutting the spoken notes moves the later words and cards up', () => {
  const words = [...say(0, 'a b'), ...say(5, 'c d'), ...say(20, 'e')];
  const out = shiftWords(words, [[4.9, 6.0]]);
  assert.deepEqual(out.map(w => w.text), ['a', 'b', 'e']);
  assert.ok(Math.abs(out[2].t - (20 - 1.1)) < 1e-9);
  assert.deepEqual(shiftTimes([3, 10], [[4.9, 6.0]]).map(x => +x.toFixed(2)), [3, 8.9]);
});
