// The tool deck: while a project is open, the studio's main keys (record, takes, add media, auto edit, auto mix,
// mixer, spectral, AI image, thumbnail, export) sit in a tidy panel at the top of the right-hand column instead of
// crowding the top bar. On the Projects screen they go back to the top bar. The keys are the same buttons, moved,
// so they behave exactly as before. In SIMPLE mode the studio extras fold into a MORE ▾ key.
import { el, popMenu } from './ui.js';

// rows of the deck: [group label, [button ids]]
// REC and EXPORT are the two big master keys: the first and last thing you do
const ROWS = [
  ['', ['btn-record']],
  ['', ['btn-takes', 'btn-import', 'btn-autoedit']],
  ['', ['btn-voices', 'btn-clonevoice']],
  ['', ['btn-styles', 'btn-filmcuts']],
  ['', ['btn-automix', 'btn-sound', 'btn-spectral']],
  ['', ['btn-aiimage', 'btn-thumb']],
  ['', ['btn-export']],
];
const IDS = ROWS.flatMap(r => r[1]);

export function initKeyPanel(app) {
  const deck = document.getElementById('keypanel'), bar = document.getElementById('title-actions'), editor = document.getElementById('editor');
  if (!deck || !bar || !editor) return;
  // where each key sits in the top bar, so it can go back exactly there
  const home = new Map(IDS.filter(id => id !== 'btn-automix' && id !== 'btn-clonevoice').map(id => { const b = document.getElementById(id); return [id, b ? { parent: b.parentNode, next: b.nextSibling } : null]; }));
  // AUTO MIX gets a key of its own (same as the mixer's and ⌥⌘M)
  if (!document.getElementById('btn-automix')) {
    const b = el('button', { id: 'btn-automix', class: 'hw role-mix', text: '⚖ AUTO MIX', title: 'AUTO MIX (⌥⌘M): sets dialogue, music and sound effects against each other. Colour your sound tracks first: blue dialogue, orange music, green sound FX', onclick: () => app.cmd('auto-mix') });
    deck.append(b);
  }
  // CLONE MY VOICE: a key of its own beside VOICES (Kitten voices: your voice from the selected clip)
  if (!document.getElementById('btn-clonevoice')) {
    deck.append(el('button', { id: 'btn-clonevoice', class: 'hw role-voice', text: '🎙 CLONE MY VOICE', title: 'CLONE MY VOICE: read a short passage into your microphone (or first select a clip of you talking, to use that). Reel saves your voice so 🗣 VOICES can say any text in it: fix a line without re-recording.', onclick: () => app.cmd('clone-voice') }));
  }
  // STYLE PACKS and FILM CUTS: keys of their own
  if (!document.getElementById('btn-styles')) deck.append(el('button', { id: 'btn-styles', class: 'hw role-style', text: '🎬 STYLE PACKS', title: 'STYLE PACKS: give the whole edit a look in one click: Nature Documentary, Fizz Commercial, Movie Trailer, Retro VHS, Sports Highlight, Travel Vlog, Breaking News', onclick: () => app.cmd('styles') }));
  if (!document.getElementById('btn-filmcuts')) deck.append(el('button', { id: 'btn-filmcuts', class: 'hw role-style', text: '✂ FILM CUTS', title: 'FILM CUTS: L-cut, J-cut, smash cut, jump cut, cut on action, cutaway and cross-cut, at the playhead', onclick: () => app.cmd('film-cuts') }));
  const more = el('button', { class: 'hw keys-more', text: 'MORE ▾', title: 'The studio tools SIMPLE keeps out of the way (or switch to FULL)' });
  more.addEventListener('click', () => {
    const r = more.getBoundingClientRect();
    const hidden = IDS.map(id => document.getElementById(id)).filter(b => b && deck.contains(b) && b.classList.contains('adv'));
    popMenu(r.left, r.bottom + 4, hidden.map(b => [b.textContent.replace(/\s+/g, ' ').trim(), () => b.click()]));
  });
  const rows = ROWS.map(([label, ids]) => ({ ids, row: el('div', { class: 'keys-row' + (ids.length === 1 ? ' wide' : ids.length === 2 ? ' two' : '') }, label ? el('span', { class: 'keys-label', text: label }) : null) }));
  deck.append(...rows.map(r => r.row));
  rows[rows.length - 1].row.append(more);

  let inDeck = null;
  const place = () => {
    const want = !editor.classList.contains('hidden');
    if (want === inDeck) return;
    inDeck = want;
    if (want) {
      for (const { ids, row } of rows) for (const id of ids) { const b = document.getElementById(id); if (b) row.insertBefore(b, row.querySelector('.keys-more')); }
    } else {
      // back to the top bar, in their old order (AUTO MIX only lives in the deck)
      for (const id of [...IDS].reverse()) {
        const b = document.getElementById(id), h = home.get(id);
        if (!b || !h) continue; // AUTO MIX stays in the (hidden) panel
        if (h.next && h.next.parentNode === h.parent) h.parent.insertBefore(b, h.next); else h.parent.append(b);
      }
    }
    deck.classList.toggle('hidden', !want);
    window.dispatchEvent(new Event('resize')); // the top bar refits
  };
  new MutationObserver(place).observe(editor, { attributes: true, attributeFilter: ['class'] });
  place();
}
