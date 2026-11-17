// Small DOM helpers: element builder, modal dialogs, toast messages, form rows.
import { screwCorners } from './gear.js';
// replaceChildren / append / prepend skip null, undefined and false, the way el() does: the browser's own turn
// them into the text "null" (it showed as "null" under the export Preset when a preset had no hint).
for (const name of ['replaceChildren', 'append', 'prepend']) {
  // (only in the page: tests load this file without a document)
  for (const proto of typeof Element === 'undefined' ? [] : [Element.prototype, DocumentFragment.prototype]) {
    const orig = proto[name];
    if (typeof orig !== 'function' || orig.__reel) continue;
    const f = function (...kids) { return orig.apply(this, kids.filter(k => k !== null && k !== undefined && k !== false)); };
    f.__reel = true;
    proto[name] = f;
  }
}

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
  if (!t._clickAway) { t._clickAway = true; t.addEventListener('click', e => { if (!e.target.closest('button')) t.classList.remove('show'); }); } // click it to close it
}

/**
 * A how-to note that shows the first few times only (`times`), with a DON'T SHOW AGAIN button. key: which note.
 * Settings › Show tips again brings them all back (resetHints).
 */
export function hint(key, msg, ms = 7000, times = 3) {
  let seen = 0;
  try { if (localStorage.getItem(`reel.hint.${key}`) === 'off') return; seen = Number(localStorage.getItem(`reel.hint.${key}`)) || 0; } catch { /* show it */ }
  if (seen >= times) return;
  try { localStorage.setItem(`reel.hint.${key}`, String(seen + 1)); } catch { /* fine */ }
  toast(msg, ms);
  const t = $('#toast');
  t.append(el('button', { class: 'toast-off', type: 'button', text: 'DON’T SHOW AGAIN', onclick: () => { try { localStorage.setItem(`reel.hint.${key}`, 'off'); } catch { /* fine */ } t.classList.remove('show'); } }));
}
/** Brings every how-to note back. */
export function resetHints() {
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('reel.hint.') || k === 'reel.swapNoAsk') localStorage.removeItem(k); } catch { /* fine */ } // (and the “swap it?” question)
}

/** Opens a modal; returns { close, body, root }. buttons: [{ label, cls, onClick(close) }]. */
/** Move box by dragging handle (its title bar). Double-click the title bar to put it back. */
export function dragBy(box, handle) {
  handle.classList.add('drag-handle');
  handle.title ||= 'Drag to move · double-click to put it back';
  const skip = e => e.target.closest('button, input, select, textarea, a, label');
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0 || skip(e)) return;
    e.preventDefault();
    const [tx = 0, ty = 0] = (box.style.translate || '').split(' ').map(v => parseFloat(v) || 0);
    const r = box.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
    const mv = ev => {
      // keep the title bar on screen
      const dx = Math.max(80 - r.right, Math.min(innerWidth - 80 - r.left, ev.clientX - x0));
      const dy = Math.max(-r.top, Math.min(innerHeight - 40 - r.top, ev.clientY - y0));
      box.style.translate = `${tx + dx}px ${ty + dy}px`;
    };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); document.body.classList.remove('dragging-window'); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
    document.body.classList.add('dragging-window');
  });
  handle.addEventListener('dblclick', e => { if (!skip(e)) box.style.translate = ''; });
}

export function modal(title, body, buttons = [], { wide = false, onClose } = {}) {
  const foot = el('div', { class: 'modal-foot' });
  const box = el('div', { class: 'modal' + (wide ? ' wide' : '') },
    el('div', { class: 'modal-head' }, el('h2', { text: title }), el('div', { class: 'spacer' }), el('button', { class: 'mini', text: '×', title: 'Close', onclick: () => close() })),
    el('div', { class: 'modal-body' }, body), foot);
  screwCorners(box, 11, 8);
  dragBy(box, box.querySelector('.modal-head'));
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

/**
 * Like modal(), but folds open in the page under `after` (an element) instead of floating over it: the rest of the
 * window stays usable. Same { close, body, root, foot } back, plus inline: true. Esc or × folds it away.
 */
export function drawer(after, title, body, buttons = [], { onClose, cls = '' } = {}) {
  const foot = el('div', { class: 'drawer-foot' });
  const box = el('div', { class: 'drawer' + (cls ? ' ' + cls : '') },
    el('div', { class: 'drawer-head' }, el('h3', { text: title }), el('div', { class: 'spacer' }), el('button', { class: 'mini', text: '×', title: 'Fold this away', onclick: () => close() })),
    el('div', { class: 'drawer-body' }, body), foot);
  let closed = false;
  const close = () => { if (closed) return; closed = true; box.remove(); document.removeEventListener('keydown', onKey, true); if (onClose) onClose(); };
  const onKey = e => { if (e.key === 'Escape' && !document.querySelector('.backdrop') && box.contains(document.activeElement)) { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  for (const b of buttons) {
    const btn = el('button', { class: b.cls || 'hw', text: b.label, onclick: () => b.onClick(close, btn) });
    if (b.id) btn.id = b.id;
    foot.append(btn);
  }
  if (!buttons.length) foot.remove();
  after.after(box);
  box.scrollIntoView?.({ block: 'nearest' });
  return { close, body, root: box, foot, inline: true };
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
export function slider(label, value, opts = {}) {
  const { min = 0, max = 1, step = 0.01, fmt = v => v.toFixed(2), onInput, onCommit, onStart } = opts;
  const val = el('span', { class: 'val', text: fmt(value) });
  const input = el('input', { type: 'range', min, max, step, value });
  let started = false;
  input.addEventListener('input', () => { if (!started) { started = true; onStart && onStart(); } const v = Number(input.value); val.textContent = fmt(v); onInput && onInput(v); });
  input.addEventListener('change', () => { started = false; onCommit && onCommit(Number(input.value)); });
  if (opts?.def != null && Number.isFinite(+opts.def)) input.dataset.def = String(opts.def); // double-click: back to it
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

// ---------------------------------------------------------------- time left on every progress bar
/** "about 2 min 10 s left", from how far along it is and how long that took. */
export function etaText(elapsed, frac) {
  if (!(frac > 0.02) || elapsed < 2.5 || frac >= 0.999) return '';
  return leftText((elapsed / frac) * (1 - frac));
}
/** Seconds left as words ('' when there's no sensible answer). */
export function leftText(left) {
  if (!isFinite(left) || left < 0 || left > 6 * 3600) return '';
  if (left < 10) return 'a few seconds left';
  const s = Math.round(left / 5) * 5, h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return `about ${h ? `${h} h ${m} min` : m ? `${m} min${m < 10 && r ? ` ${r} s` : ''}` : `${r} s`} left`;
}
/**
 * Every progress bar in Reel (a .progress with an <i> whose width grows) gets a line under it: how far along it is and
 * about how long is left, worked out from how fast it has moved since it started. A bar that jumps back starts again.
 */
function watchProgress() {
  const seen = new WeakMap();
  const tick = i => {
    const bar = i.parentElement;
    if (!bar?.classList.contains('progress')) return;
    const frac = Math.min(1, (parseFloat(i.style.width) || 0) / 100), now = performance.now();
    let s = seen.get(bar);
    if (!s || frac < s.last - 0.05) { s = { t0: now, f0: frac, last: frac, smooth: null }; seen.set(bar, s); }
    s.last = frac;
    // the rate since this bar started moving (a stage that jumped ahead counts from where it was)
    const moved = frac - s.f0, el = (now - s.t0) / 1000;
    let text = '';
    if (moved > 0.02 && el > 2.5) {
      const left = (el / moved) * (1 - frac);
      s.smooth = s.smooth == null ? left : s.smooth * 0.7 + left * 0.3;
      text = leftText(s.smooth);
    }
    let lab = bar.nextElementSibling?.classList.contains('progress-eta') ? bar.nextElementSibling : null;
    if (!lab) { lab = document.createElement('div'); lab.className = 'progress-eta'; bar.after(lab); }
    lab.textContent = frac >= 0.999 ? '' : `${Math.round(frac * 100)}%${text ? ` · ${text}` : ''}`;
  };
  new MutationObserver(list => { for (const m of list) if (m.target.tagName === 'I') tick(m.target); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['style'], subtree: true });
}
if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchProgress); else watchProgress();
}

// ------------------------------------------------------------------ double-click resets a slider (everywhere)
// Its default when it has one (data-def), else where it was before you first touched it. The change goes through the
// slider's own input and change events, so it lands like a drag: shown at once, one ⌘Z.
if (typeof document !== 'undefined') {
  const isRange = t => t instanceof HTMLInputElement && t.type === 'range' && !t.disabled;
  document.addEventListener('pointerdown', e => { const t = e.target; if (isRange(t) && !('v0' in t.dataset)) t.dataset.v0 = t.value; }, true);
  document.addEventListener('dblclick', e => {
    const t = e.target;
    if (!isRange(t)) return;
    const v = t.dataset.def ?? t.dataset.v0;
    if (v == null || v === '') return;
    e.preventDefault();
    t.value = v;
    t.dispatchEvent(new Event('input', { bubbles: true }));
    t.dispatchEvent(new Event('change', { bubbles: true }));
  }, true);
}
