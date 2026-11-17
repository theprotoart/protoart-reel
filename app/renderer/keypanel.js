// The tool deck: while a project is open, the studio's main keys (record, takes, add media, auto edit, auto mix,
// mixer, spectral, AI image, thumbnail, export) sit in a tidy panel at the top of the right-hand column instead of
// crowding the top bar. On the Projects screen they go back to the top bar. The keys are the same buttons, moved,
// so they behave exactly as before. In SIMPLE mode the studio extras fold into a MORE ▾ key.
import { el, popMenu } from './ui.js';

// REC and EXPORT are the two big master keys (the first and last thing you do) and always show. Between them the
// tools sit in modules you can fold away, drag into another order, or hide (⚙). The layout is remembered.
export const MODULES = [
  { id: 'edit', label: 'Edit', ids: ['btn-takes', 'btn-ums', 'btn-import', 'btn-autoedit'] },
  { id: 'voice', label: 'Voice', ids: ['btn-voices', 'btn-clonevoice', 'btn-teachums'] },
  { id: 'style', label: 'Style', ids: ['btn-styles', 'btn-filmcuts'] },
  { id: 'sound', label: 'Sound', ids: ['btn-automix', 'btn-sound', 'btn-spectral'] },
  { id: 'picture', label: 'Picture', ids: ['btn-aiimage', 'btn-thumb'] },
];
const ROWS = [['', ['btn-record', 'btn-export']], ...MODULES.map(m => [m.id, m.ids])];
// the slim strip (the right-hand column's default, so the inspector gets the room): each tool as a small key
export const STRIP = {
  'btn-takes': ['✂', 'Takes'], 'btn-ums': ['💬', 'Fillers'], 'btn-import': ['＋', 'Media'], 'btn-autoedit': ['⚡', 'Auto'],
  'btn-voices': ['🗣', 'Voices'], 'btn-clonevoice': ['🎙', 'Clone'], 'btn-teachums': ['〰', 'Ums'],
  'btn-styles': ['🎬', 'Styles'], 'btn-filmcuts': ['🎞', 'Cuts'],
  'btn-automix': ['⚖', 'Mix'], 'btn-sound': ['🎚', 'Mixer'], 'btn-spectral': ['🌈', 'Spectral'],
  'btn-aiimage': ['🖼', 'AI'], 'btn-thumb': ['▣', 'Thumb'],
};
const IDS = ROWS.flatMap(r => r[1]);

// the layout: { order: [module ids], folded: [module ids], hidden: [module ids], tools: false when all folded }
const LAYOUT_KEY = 'reel.deck';
export function loadLayout() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); } catch { s = null; }
  return normalizeLayout(s);
}
/** A stored layout made safe: known modules only, every module once, in some order. */
export function normalizeLayout(s) {
  const known = MODULES.map(m => m.id), list = v => (Array.isArray(v) ? v.filter(x => known.includes(x)) : []);
  const order = [...new Set([...list(s?.order), ...known])];
  return { order, folded: [...new Set(list(s?.folded))], hidden: [...new Set(list(s?.hidden))], tools: s?.tools !== false, strip: s?.strip !== false };
}
const saveLayout = l => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(l)); } catch { /* private window: not remembered */ } };

export function initKeyPanel(app) {
  const deck = document.getElementById('keypanel'), bar = document.getElementById('title-actions'), editor = document.getElementById('editor');
  if (!deck || !bar || !editor) return;
  // where each key sits in the top bar, so it can go back exactly there
  const home = new Map(IDS.filter(id => id !== 'btn-automix' && id !== 'btn-clonevoice' && id !== 'btn-teachums').map(id => { const b = document.getElementById(id); return [id, b ? { parent: b.parentNode, next: b.nextSibling } : null]; }));
  // AUTO MIX gets a key of its own (same as the mixer's and ⌥⌘M)
  if (!document.getElementById('btn-automix')) {
    const b = el('button', { id: 'btn-automix', class: 'hw role-mix', text: '⚖ AUTO MIX', title: 'AUTO MIX (⌥⌘M): sets dialogue, music and sound effects against each other. Colour your sound tracks first: blue dialogue, orange music, green sound FX', onclick: () => app.cmd('auto-mix') });
    deck.append(b);
  }
  // CLONE MY VOICE: a key of its own beside VOICES (Kitten voices: your voice from the selected clip)
  if (!document.getElementById('btn-teachums')) {
    deck.append(el('button', { id: 'btn-teachums', class: 'hw role-voice', text: '🎙 TEACH MY UMS', title: 'TEACH MY UMS: record your um and uh a few times (slow, normal, quick) and read a sentence. Reel learns them in your voice and finds them in 💬 UMS and AUTO EDIT, even the ones speech recognition leaves out.', onclick: () => app.cmd('teach-ums') }));
  }
  if (!document.getElementById('btn-clonevoice')) {
    deck.append(el('button', { id: 'btn-clonevoice', class: 'hw role-voice', text: '🎙 CLONE MY VOICE', title: 'CLONE MY VOICE: read a short passage into your microphone (or first select a clip of you talking, to use that). Reel saves your voice so 🗣 VOICES can say any text in it: fix a line without re-recording.', onclick: () => app.cmd('clone-voice') }));
  }
  // UMS: beside TAKES (find the ums and uhs in the speech, cut them one by one or all at once)
  if (!document.getElementById('btn-ums')) {
    const b = el('button', { id: 'btn-ums', class: 'hw takes-btn', title: 'FILLER WORDS: Reel listens to the speech and lists every um, uh, filler word and sound you taught it (breaths…). Play each one, keep or cut it, or remove them all at once.', onclick: () => app.cmd('ums') }, '💬 FILLER WORDS', el('span', { class: 'n' }));
    deck.append(b);
  }
  // STYLE PACKS and FILM CUTS: keys of their own
  if (!document.getElementById('btn-styles')) deck.append(el('button', { id: 'btn-styles', class: 'hw role-style', text: '🎬 STYLE PACKS', title: 'STYLE PACKS: give the whole edit a look in one click: Nature Documentary, Fizz Commercial, Movie Trailer, Retro VHS, Sports Highlight, Travel Vlog, Breaking News', onclick: () => app.cmd('styles') }));
  if (!document.getElementById('btn-filmcuts')) deck.append(el('button', { id: 'btn-filmcuts', class: 'hw role-style', text: '🎞 FILM CUTS', title: 'FILM CUTS: L-cut, J-cut, smash cut, jump cut, cut on action, cutaway and cross-cut, at the playhead', onclick: () => app.cmd('film-cuts') }));
  const more = el('button', { class: 'hw keys-more', text: 'MORE ▾', title: 'The studio tools SIMPLE keeps out of the way (or switch to FULL)' });
  more.addEventListener('click', () => {
    const r = more.getBoundingClientRect();
    const hidden = IDS.map(id => document.getElementById(id)).filter(b => b && deck.contains(b) && b.classList.contains('adv'));
    popMenu(r.left, r.bottom + 4, hidden.map(b => [b.textContent.replace(/\s+/g, ' ').trim(), () => b.click()]));
  });
  // REC on top, EXPORT at the bottom, the tool modules between them
  // REC and EXPORT side by side at the top: the first and last thing you do, always in reach
  const recRow = el('div', { class: 'keys-row two masters' }), exportRow = el('div', { class: 'keys-row wide more-row' }, more);
  let layout = loadLayout();
  const mods = new Map(MODULES.map(m => {
    const chev = el('span', { class: 'kmod-chev' }), count = el('span', { class: 'kmod-count' });
    const head = el('button', { class: 'kmod-head', draggable: 'true', title: 'Click to fold or unfold · drag to move this group' }, chev, el('span', { class: 'kmod-name', text: m.label }), count, el('span', { class: 'kmod-grip', text: '⋮⋮' }));
    const body = el('div', { class: 'kmod-body' });
    const box = el('div', { class: 'kmod', 'data-mod': m.id }, head, body);
    head.addEventListener('click', () => {
      layout.folded = layout.folded.includes(m.id) ? layout.folded.filter(x => x !== m.id) : [...layout.folded, m.id];
      saveLayout(layout); draw();
    });
    // drag a group's title onto another to move it there
    head.addEventListener('dragstart', e => { e.dataTransfer.setData('text/x-reel-module', m.id); e.dataTransfer.effectAllowed = 'move'; box.classList.add('dragging'); });
    head.addEventListener('dragend', () => { box.classList.remove('dragging'); for (const x of modsEl.children) x.classList.remove('drop-before', 'drop-after'); });
    box.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes('text/x-reel-module')) return;
      e.preventDefault();
      const r = box.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
      box.classList.toggle('drop-after', after); box.classList.toggle('drop-before', !after);
    });
    box.addEventListener('dragleave', () => box.classList.remove('drop-before', 'drop-after'));
    box.addEventListener('drop', e => {
      const from = e.dataTransfer.getData('text/x-reel-module');
      box.classList.remove('drop-before', 'drop-after');
      if (!from || from === m.id) return;
      e.preventDefault();
      const r = box.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
      const order = layout.order.filter(x => x !== from);
      order.splice(order.indexOf(m.id) + (after ? 1 : 0), 0, from);
      layout.order = order; saveLayout(layout); draw();
    });
    return [m.id, { m, box, body, chev, count }];
  }));
  const modsEl = el('div', { class: 'kmods' });
  const toolsChev = el('span', { class: 'kmod-chev' });
  const toolsBtn = el('button', { class: 'tools-fold', title: 'Fold all the tools away (REC and EXPORT stay)' }, toolsChev, el('span', { text: 'TOOLS' }));
  toolsBtn.addEventListener('click', () => { layout.tools = !layout.tools; saveLayout(layout); draw(); });
  const gear = el('button', { class: 'tools-gear', text: '⚙', title: 'Choose which tool groups show, fold or unfold them all, or reset the layout' });
  gear.addEventListener('click', () => {
    const r = gear.getBoundingClientRect();
    const set = fn => { fn(); saveLayout(layout); draw(); };
    popMenu(r.left, r.bottom + 4, [
      [layout.strip ? 'Big tool keys (more room for them, less for the inspector)' : 'Slim tool strip (more room for the inspector)', () => set(() => { layout.strip = !layout.strip; })],
      null,
      ...MODULES.map(m => [`${layout.hidden.includes(m.id) ? '   ' : '✓ '}${m.label}`, () => set(() => { layout.hidden = layout.hidden.includes(m.id) ? layout.hidden.filter(x => x !== m.id) : [...layout.hidden, m.id]; })]),
      null,
      ['Unfold every group', () => set(() => { layout.folded = []; layout.tools = true; })],
      ['Fold every group', () => set(() => { layout.folded = MODULES.map(m => m.id); })],
      ['Reset the tool panel', () => set(() => { layout = normalizeLayout(null); })],
    ]);
  });
  // one click to fold or unfold every group (instead of one at a time)
  const allBtn = el('button', { class: 'tools-all', title: 'Fold or unfold every group at once' });
  allBtn.addEventListener('click', () => { const anyOpen = MODULES.some(m => !layout.folded.includes(m.id) && !layout.hidden.includes(m.id)); layout.folded = anyOpen ? MODULES.map(m => m.id) : []; layout.tools = true; saveLayout(layout); draw(); });
  const toolsHead = el('div', { class: 'tools-head' }, toolsBtn, el('span', { class: 'spacer' }), allBtn, gear);
  // the slim strip: a small key for each tool, which presses the real one (kept, out of sight, in its group)
  const stripEl = el('div', { class: 'kstrip-row' });
  const stripGear = el('button', { class: 'kstrip kstrip-gear', title: 'Tools: big keys or the slim strip, which groups show', onclick: () => gear.click() }, el('b', { text: '⚙' }));
  const drawStrip = () => {
    const keys = [];
    for (const id of layout.order) {
      if (layout.hidden.includes(id)) continue;
      for (const k of mods.get(id).m.ids) {
        const b = document.getElementById(k), [icon, label] = STRIP[k] || ['•', k];
        if (!b) continue;
        const n = b.querySelector('.n')?.textContent || '';
        const key = el('button', { class: 'kstrip' + (b.classList.contains('adv') ? ' adv' : '') + (k === 'btn-autoedit' ? ' auto' : ''), type: 'button', title: b.title || label, 'data-for': k, onclick: () => b.click() },
          el('b', { text: icon }), el('small', { text: label }), n ? el('i', { class: 'kn', text: n }) : null);
        keys.push(key);
      }
    }
    stripEl.replaceChildren(...keys, stripGear);
  };
  // the counts on TAKES and FILLER WORDS show on their small keys too
  new MutationObserver(() => { if (layout.strip) drawStrip(); }).observe(modsEl, { subtree: true, characterData: true, childList: true });
  const draw = () => {
    modsEl.replaceChildren(...layout.order.map(id => mods.get(id).box));
    for (const [id, x] of mods) {
      const folded = layout.folded.includes(id);
      x.box.classList.toggle('folded', folded);
      x.box.classList.toggle('hidden', layout.hidden.includes(id));
      x.chev.textContent = folded ? '▸' : '▾';
      const keys = x.m.ids.map(k => document.getElementById(k)).filter(b => b && !(document.body.classList.contains('simple') && b.classList.contains('adv')));
      x.count.textContent = folded ? keys.map(b => b.textContent.replace(/[^\p{L}\s]/gu, '').trim().split(/\s+/)[0]).filter(Boolean).join(' · ') : '';
    }
    modsEl.classList.toggle('hidden', !layout.tools || layout.strip);
    toolsHead.classList.toggle('hidden', layout.strip);
    stripEl.classList.toggle('hidden', !layout.strip);
    deck.classList.toggle('strip', layout.strip);
    toolsChev.textContent = layout.tools ? '▾' : '▸';
    allBtn.textContent = MODULES.some(m => !layout.folded.includes(m.id) && !layout.hidden.includes(m.id)) ? '▸ FOLD ALL' : '▾ UNFOLD ALL';
    if (layout.strip) drawStrip();
  };
  deck.append(recRow, toolsHead, modsEl, stripEl, exportRow);
  const rows = [{ ids: ['btn-record', 'btn-export'], row: recRow }, ...MODULES.map(m => ({ ids: m.ids, row: mods.get(m.id).body }))];
  draw();
  new MutationObserver(draw).observe(document.body, { attributes: true, attributeFilter: ['class'] }); // SIMPLE / FULL

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
