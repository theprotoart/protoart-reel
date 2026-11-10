// Small DOM helpers: element builder, modal dialogs, toast messages, form rows.
import { screwCorners } from './gear.js';
export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'text') e.textContent = v;
    else if (k in e && k !== 'list' && k !== 'type') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
export const $ = (sel, root = document) => root.querySelector(sel);

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/** Opens a modal; returns { close, body, root }. buttons: [{ label, cls, onClick(close) }]. */
export function modal(title, body, buttons = [], { wide = false, onClose } = {}) {
  const foot = el('div', { class: 'modal-foot' });
  const box = el('div', { class: 'modal' + (wide ? ' wide' : '') },
    el('div', { class: 'modal-head' }, el('h2', { text: title }), el('div', { class: 'spacer' }), el('button', { class: 'mini', text: '×', title: 'Close', onclick: () => close() })),
    el('div', { class: 'modal-body' }, body), foot);
  screwCorners(box, 11, 8);
  const back = el('div', { class: 'backdrop' }, box);
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); if (onClose) onClose(); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  for (const b of buttons) {
    const btn = el('button', { class: b.cls || 'hw', text: b.label, onclick: () => b.onClick(close, btn) });
    if (b.id) btn.id = b.id;
    foot.append(btn);
  }
  if (!buttons.length) foot.remove();
  $('#modal-root').append(back);
  return { close, body, root: box, foot };
}

export function ask(title, text, okLabel = 'OK') {
  return new Promise(resolve => {
    modal(title, el('p', { text }), [
      // answer first: closing the window also reports "cancelled" through onClose
      { label: 'Cancel', onClick: c => { resolve(false); c(); } },
      { label: okLabel, cls: 'hw amber', onClick: c => { resolve(true); c(); } },
    ], { onClose: () => resolve(false) });
  });
}

/** A labelled slider row. onInput(value) while dragging; onCommit(value) on release. */
export function slider(label, value, { min = 0, max = 1, step = 0.01, fmt = v => v.toFixed(2), onInput, onCommit, onStart } = {}) {
  const val = el('span', { class: 'val', text: fmt(value) });
  const input = el('input', { type: 'range', min, max, step, value });
  let started = false;
  input.addEventListener('input', () => { if (!started) { started = true; onStart && onStart(); } const v = Number(input.value); val.textContent = fmt(v); onInput && onInput(v); });
  input.addEventListener('change', () => { started = false; onCommit && onCommit(Number(input.value)); });
  input.addEventListener('dblclick', () => { /* handled by caller via reset */ });
  return el('div', { class: 'row' }, el('label', { text: label }), input, val);
}

export function numberRow(label, value, { step = 1, min, max, onCommit } = {}) {
  const input = el('input', { type: 'number', value: Math.round(value * 1000) / 1000, step, min, max });
  input.addEventListener('change', () => { const v = Number(input.value); if (Number.isFinite(v)) onCommit(v); });
  return el('div', { class: 'row' }, el('label', { text: label }), input);
}

export function selectRow(label, value, options, onChange) {
  const s = el('select', {}, ...options.map(([v, t]) => el('option', { value: v, text: t, selected: String(v) === String(value) })));
  s.addEventListener('change', () => onChange(s.value));
  return el('div', { class: 'row' }, el('label', { text: label }), s);
}

export function colorRow(label, value, onChange, extra) {
  const c = el('input', { type: 'color', value: value || '#ffffff' });
  c.addEventListener('change', () => onChange(c.value));
  return el('div', { class: 'row' }, el('label', { text: label }), c, extra || el('span'));
}

export function checkRow(label, value, onChange, cls = '') {
  const c = el('input', { type: 'checkbox', checked: !!value, class: cls });
  c.addEventListener('change', () => onChange(c.checked));
  return el('div', { class: 'row' }, el('label', { text: label }), c);
}

export function section(title, ...kids) {
  return el('div', { class: 'insp-section' }, el('span', { class: 'engr', text: title }), ...kids);
}

/** A small gear-style menu at x, y. items: [label, fn, key?] or null for a divider. */
export function popMenu(x, y, items) {
  document.querySelector('.pop-menu')?.remove();
  const menu = el('div', { class: 'pop-menu', style: { left: x + 'px', top: y + 'px' } },
    // a null is a divider: no two in a row, none at the top or bottom (sections with nothing for this clip vanish)
    ...items.filter(it => it !== undefined && it !== false).filter((it, i, all) => it || (i > 0 && all[i - 1] && all.slice(i + 1).some(Boolean))).map(it => (it ? el('button', { disabled: !it[1], onclick: () => { menu.remove(); it[1]?.(); } }, el('span', { text: it[0] }), el('kbd', { text: it[2] || '' })) : el('hr'))));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  if (r.bottom > innerHeight - 8) menu.style.top = Math.max(8, innerHeight - r.height - 8) + 'px';
  if (r.right > innerWidth - 8) menu.style.left = Math.max(8, innerWidth - r.width - 8) + 'px';
  const close = () => { menu.remove(); window.removeEventListener('pointerdown', off, true); window.removeEventListener('keydown', esc, true); };
  const off = ev => { if (!menu.contains(ev.target)) close(); };
  const esc = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
  setTimeout(() => { window.addEventListener('pointerdown', off, true); window.addEventListener('keydown', esc, true); });
  return menu;
}

/** Ask for a line of text. Resolves to the text, or null when cancelled. */
export function promptText(title, text, value = '', okLabel = 'OK') {
  return new Promise(res => {
    const input = el('input', { type: 'text', value });
    let done = false;
    const finish = v => { if (!done) { done = true; res(v); } };
    const d = modal(title, el('div', {}, text ? el('p', { class: 'note', text }) : null, input), [
      { label: 'Cancel', onClick: c => { finish(null); c(); } },
      { label: okLabel, cls: 'hw amber', onClick: c => { finish(input.value.trim()); c(); } }], { onClose: () => finish(null) });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); finish(input.value.trim()); d.close(); } });
    setTimeout(() => input.select(), 50);
  });
}
