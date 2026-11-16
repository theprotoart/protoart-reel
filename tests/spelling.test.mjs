import { test } from 'node:test';
import assert from 'node:assert/strict';

const BAD = { teh: ['the', 'ten'], recieve: ['receive'], tbas: ['tabs'], subscibers: ['subscribers'] };
globalThis.window = { reel: { spell: { check: w => !!BAD[w.toLowerCase()], suggest: w => BAD[w.toLowerCase()] || [] } } };
const { projectTexts, scanSpelling, fixEverywhere } = await import('../app/renderer/spelling.js');
const { replaceWordIn, toggleCaps } = await import('../app/renderer/texttools.js');

const doc = () => ({
  clips: [
    { id: 'a', type: 'text', start: 1, text: { content: 'Teh best way' } },
    { id: 'b', type: 'element', start: 5, element: { kind: 'counter', text: '1000', sub: '1000 subscibers' } },
    { id: 'c', type: 'element', start: 8, element: { kind: 'cardScatter' } }, // its words are the defaults
    { id: 'd', type: 'media', start: 0, transIn: { type: 'text-reveal', text: 'TEH END' } },
  ],
  captions: [{ id: 'k1', t: 2, end: 3, text: 'teh caption, I recieve it' }],
  markers: [{ id: 'm1', t: 4, label: 'Teh chapter' }, { id: 'm2', t: 6, label: '✂ Clap', claps: true }],
});

test('every piece of words on screen is found, not the counter’s number or clap marks', () => {
  const p = projectTexts(doc());
  assert.deepEqual(p.map(x => x.label + ':' + x.get(doc())), ['Title:Teh best way', 'Number counter:1000 subscibers', 'Scattered cards:14 TABS', 'Scattered cards:open.', 'Reveal text:TEH END', 'Caption:teh caption, I recieve it', 'Chapter marker:Teh chapter']);
});

test('each misspelt word once, with every place it is', async () => {
  const list = await scanSpelling(doc());
  assert.deepEqual(list.map(f => [f.word, f.fixes[0], f.places.length]), [['TEH', 'the', 4], ['recieve', 'receive', 1], ['subscibers', 'subscribers', 1]]);
});

test('a fix goes everywhere, keeping capitals, whole words only', () => {
  const d = doc();
  assert.equal(fixEverywhere(d, 'teh', 'the'), 4);
  assert.equal(d.clips[0].text.content, 'The best way');
  assert.equal(d.clips[3].transIn.text, 'THE END');
  assert.equal(d.captions[0].text, 'the caption, I recieve it');
  assert.equal(d.markers[0].label, 'The chapter');
  assert.equal(replaceWordIn('tehran teh', 'teh', 'the'), 'tehran the');
  fixEverywhere(d, 'subscibers', 'subscribers');
  assert.equal(d.clips[1].element.sub, '1000 subscribers');
});

test('no dictionary: says so (null) rather than “all fine”', async () => {
  const keep = globalThis.window; globalThis.window = { reel: { spell: { check: () => false, suggest: () => [] } } };
  assert.equal(await scanSpelling(doc()), null);
  globalThis.window = keep;
});

test('TT: all caps, then back to what was typed', () => {
  const box = { value: 'Hello there', dispatchEvent() {} };
  toggleCaps(box); assert.equal(box.value, 'HELLO THERE');
  toggleCaps(box); assert.equal(box.value, 'Hello there');
});
