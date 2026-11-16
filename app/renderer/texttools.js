// Two keys beside every box you type words into (titles, elements, callouts, captions):
//  TT — makes the words ALL CAPS in one click; click again (now Tt) to get back what you typed.
//  ABC✓ — checks the spelling with the Mac's own dictionary (nothing leaves your Mac) and lists each word it doesn't
//         know with the likely right spellings to click, one after the other, so nobody has to spot the mistakes
//         themselves (dyslexia, or just fast typing). Words are underlined in red as you type too, and a right-click
//         on one shows the same fixes.
import { el, popMenu, toast } from './ui.js';

const typed = new WeakMap(); // box → the words as typed, before TT

const WORD = /[\p{L}][\p{L}'’]*/gu;
const hasLower = s => s !== s.toUpperCase();
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Puts new words in the box as if typed (so the picture follows and ⌘Z undoes it in one step). */
function setValue(box, v) {
  box.value = v;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.dispatchEvent(new Event('change', { bubbles: true }));
}

/** ALL CAPS, or back to how it was typed. */
export function toggleCaps(box) {
  const v = box.value;
  if (hasLower(v)) { typed.set(box, v); setValue(box, v.toUpperCase()); return 'upper'; }
  const was = typed.get(box);
  // back to what you typed (if the words are still the same), else Title Case
  setValue(box, was && was.toUpperCase() === v ? was : v.toLowerCase().replace(/(^|[\s\n*"“(-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()));
  return 'typed';
}

/** Whether the Mac's dictionary is answering: one that finds nothing wrong with these isn't loaded. (Several, in case
 *  someone has kept one of them as "right".) */
export async function dictionaryWorks(sp) {
  for (const w of ['recieve', 'definately', 'seperately', 'qzxvbwk']) if (await sp.check(w)) return true;
  return false;
}

/** The words of a text worth checking (letters, 2 or more, apostrophes inside kept). */
export const wordsOf = text => (String(text).match(WORD) || []).map(w => w.replace(/['’]+$/, '')).filter(w => w.length >= 2);

/** The words the Mac's dictionary doesn't know: [{ word, fixes }]. null when the dictionary can't be reached. */
export async function misspelt(text) {
  const sp = globalThis.window?.reel?.spell;
  if (!sp) return null;
  try {
    if (!(await dictionaryWorks(sp))) return null;
    const seen = new Set(), out = [];
    for (const word of wordsOf(text)) {
      if (seen.has(word.toLowerCase())) continue;
      seen.add(word.toLowerCase());
      if (await sp.check(word)) out.push({ word, fixes: ((await sp.suggest(word)) || []).slice(0, 5) });
    }
    return out;
  } catch { return null; }
}

/** Keeps the case of the word it replaces (ALL CAPS stays caps, a capital stays a capital). */
const matchCase = (fix, word) => (word.length > 1 && word === word.toUpperCase() ? fix.toUpperCase() : /^\p{Lu}/u.test(word) ? fix[0].toUpperCase() + fix.slice(1) : fix);

/** Every `word` in the text swapped for `fix` (whole words only, keeping each one's capitals). */
export function replaceWordIn(text, word, fix) {
  const re = new RegExp(`(^|[^\\p{L}'’])(${esc(word)})(?![\\p{L}])`, 'giu');
  return String(text).replace(re, (m, a, w) => a + matchCase(fix, w));
}
/** Swaps every `word` in the box for `fix`. */
export function replaceWord(box, word, fix) { setValue(box, replaceWordIn(box.value, word, fix)); }

export async function spellCheck(box, anchor) {
  const list = await misspelt(box.value);
  if (list === null) { toast('The Mac’s spelling dictionary isn’t available here. Words it doesn’t know are still underlined in red: right-click one for the right spelling.', 6000); return; }
  if (!list.length) { toast('✓ No spelling mistakes found.', 2500); return; }
  const r = anchor.getBoundingClientRect();
  const items = [[`${list.length} word${list.length === 1 ? '' : 's'} to check — click the right spelling:`, null]];
  for (const { word, fixes } of list) {
    items.push(null, [`“${word}”`, null]);
    for (const f of fixes) items.push([`   → ${matchCase(f, word)}`, () => { replaceWord(box, word, f); setTimeout(() => spellCheck(box, anchor), 50); }]);
    if (!fixes.length) items.push(['   (no suggestions — try sounding it out differently)', null]);
    items.push([`   ✓ “${word}” is right: keep it`, async () => { try { await window.reel.spell.add(word); } catch { /* */ } setTimeout(() => spellCheck(box, anchor), 50); }]);
  }
  popMenu(r.left, r.bottom + 4, items).classList.add('spell-menu');
}

/** The TT and ABC✓ keys for a box. */
export function textKeys(box) {
  box.spellcheck = true;
  const caps = el('button', { class: 'tool tt-key', type: 'button', title: 'ALL CAPS: click again to get back what you typed' });
  const label = () => { caps.textContent = hasLower(box.value) || !/\p{L}/u.test(box.value) ? 'TT' : 'Tt'; caps.title = caps.textContent === 'TT' ? 'Make it ALL CAPS' : 'Back to how you typed it'; };
  caps.addEventListener('click', () => { toggleCaps(box); label(); box.focus(); });
  box.addEventListener('input', label); label();
  const spell = el('button', { class: 'tool spell-key', type: 'button', text: 'ABC✓', title: 'Check the spelling (the Mac’s own dictionary; nothing leaves your Mac)' });
  spell.addEventListener('click', () => spellCheck(box, spell));
  return el('div', { class: 'text-keys' }, caps, spell);
}

/** A box with its TT and ABC✓ keys under it. */
export const withKeys = box => el('div', { class: 'text-with-keys' }, box, textKeys(box));
