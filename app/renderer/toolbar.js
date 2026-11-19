// The tool bar's grouped menus (EFFECTS ▾, AUDIO ▾, TEXT ▾, PARTS ▾, ⚙ ▾): each holds the same buttons as
// before, kept in the page but out of sight, so their shortcuts and behaviour don't change. Clicking a group
// lists them as a menu; a group lights up while one of its tools is on (✚ CLIPS, a proxy being made…).
import { popMenu, el, modal } from './ui.js';

const label = n => (n.textContent || '').replace(/[▾]/g, '').replace(/\s+/g, ' ').trim();

export function initToolbarGroups(app) {
  for (const g of document.querySelectorAll('#toolstrip .tgroup')) {
    const btn = g.querySelector('.tgroup-btn'), box = g.querySelector('.tgroup-items');
    if (!btn || !box) continue;
    btn.addEventListener('click', () => {
      const r = btn.getBoundingClientRect();
      const items = [...box.children].map(n => {
        if (n.tagName === 'HR') return null; // a divider between kinds of tools
        const input = n.querySelector('input[type=checkbox]');
        if (input) return [`${input.checked ? '✓ ' : ''}${label(n)}`, () => input.click()];
        if (n.id === 'btn-proxy') return [`Proxy editing: ${label(n).replace(/^PROXY\s*/, '').toLowerCase()} ▸`, () => app.proxyMenu(btn)];
        return [`${n.classList.contains('lit') ? '✓ ' : ''}${label(n)}`, () => n.click(), (n.title.match(/\(([^()]*[⌘⇧⌥A-Z][^()]*)\)/) || [])[1] || ''];
      });
      popMenu(r.left, r.bottom + 4, items);
    });
    const lit = () => btn.classList.toggle('lit', [...box.children].some(n => n.classList.contains('lit') && n.id !== 'btn-proxy'));
    new MutationObserver(lit).observe(box, { subtree: true, attributes: true, attributeFilter: ['class'] });
    lit();
  }
}

// Your own tools on the bar (1.15, ScreenFlow's customizable toolbar): any tool inside a group (EFFECTS ▾, AUDIO ▾…)
// can also sit on the bar itself, as a button that does just what the menu item does. Right-click the tool bar ›
// Customize Tool Bar…, or ⚙ ▾. Kept on this Mac.
const PINS = 'reel.toolbarPins';
const readPins = () => { try { const v = JSON.parse(localStorage.getItem(PINS) || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; } catch { return []; } };
const writePins = v => { try { localStorage.setItem(PINS, JSON.stringify(v)); } catch { /* fine */ } };
const keyOf = n => n.dataset?.cmd ? 'cmd:' + n.dataset.cmd : n.id ? 'id:' + n.id : n.querySelector?.('input[id]') ? 'in:' + n.querySelector('input[id]').id : null;

/** Every tool inside a group: [{ group, items: [{ key, label, node }] }]. */
export function groupedTools() {
  return [...document.querySelectorAll('#toolstrip .tgroup')].map(g => ({
    group: label(g.querySelector('.tgroup-btn') || g),
    items: [...(g.querySelector('.tgroup-items')?.children || [])].filter(n => n.tagName !== 'HR' && keyOf(n)).map(n => ({ key: keyOf(n), label: label(n), node: n })),
  })).filter(g => g.items.length);
}

let observers = [];
/** The pinned tools, as buttons at the end of the bar (before the zoom). */
export function renderPins() {
  for (const o of observers) o.disconnect();
  observers = [];
  document.querySelector('#tool-pins')?.remove();
  const pins = readPins();
  if (!pins.length) return;
  const all = new Map(groupedTools().flatMap(g => g.items).map(i => [i.key, i]));
  const box = el('span', { id: 'tool-pins', class: 'tool-pins' });
  for (const k of pins) {
    const it = all.get(k);
    if (!it) continue;
    const input = it.node.querySelector('input[type=checkbox]');
    const b = el('button', { class: 'tool pinned', type: 'button', title: it.node.title || it.label, text: it.label });
    b.addEventListener('click', () => (input || it.node).click());
    const sync = () => b.classList.toggle('lit', input ? input.checked : it.node.classList.contains('lit'));
    if (input) input.addEventListener('change', sync);
    const o = new MutationObserver(sync); o.observe(it.node, { attributes: true, attributeFilter: ['class'] }); observers.push(o);
    sync();
    box.append(b);
  }
  const strip = document.querySelector('#toolstrip'), zoom = strip?.querySelector('.zoom-group');
  if (!strip || !box.children.length) return;
  strip.insertBefore(el('span', { class: 'sep', id: 'tool-pins-sep' }), zoom || null);
  strip.insertBefore(box, zoom || null);
}

export function customizeToolbar() {
  const pins = new Set(readPins());
  const save = () => { writePins([...pins]); document.querySelector('#tool-pins-sep')?.remove(); renderPins(); };
  const body = el('div', { class: 'customize-tools' },
    el('p', { class: 'note', text: 'Tick a tool to put it on the tool bar itself, as well as in its menu. Untick it to take it off again.' }),
    ...groupedTools().map(g => el('div', { class: 'ct-group' }, el('div', { class: 'engr small', text: g.group }),
      ...g.items.map(it => el('label', { class: 'ct-item', title: it.node.title || '' },
        el('input', { type: 'checkbox', checked: pins.has(it.key), onchange: e => { if (e.target.checked) pins.add(it.key); else pins.delete(it.key); save(); } }),
        el('span', { text: it.label }))))));
  modal('Customize Tool Bar', body, [
    { label: 'TAKE ALL OFF', onClick: close => { pins.clear(); save(); close(); } },
    { label: 'DONE', cls: 'hw primary', onClick: close => close() },
  ], { wide: true });
}

/** Right-click on the tool bar (not on a tool with its own menu) offers Customize Tool Bar… */
export function initToolbarCustomize() {
  renderPins();
  document.querySelector('#toolstrip')?.addEventListener('contextmenu', e => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    popMenu(e.clientX, e.clientY, [['Customize Tool Bar…', customizeToolbar]]);
  });
}
