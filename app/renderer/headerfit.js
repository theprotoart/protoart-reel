// Keeps the top bar on one line at any window width: when the buttons don't fit, the right-most ones fold
// into a MORE ▾ key (a menu of the same buttons) instead of running off the edge of the window.
import { el, popMenu } from './ui.js';

export function fitHeader() {
  const bar = document.getElementById('titlebar'), box = document.getElementById('title-actions');
  if (!bar || !box) return;
  const more = el('button', { class: 'hw more-key hidden', text: 'MORE ▾', title: 'The buttons that don’t fit at this window size' });
  box.append(more);
  // fold order: least-used first; REC, EXPORT and MORE always stay
  const order = ['btn-help', 'btn-explain', 'btn-aiimage', 'btn-thumb', 'btn-spectral', 'btn-sound', 'btn-import'];
  const label = b => b.textContent.replace(/\s+/g, ' ').trim();
  more.addEventListener('click', () => {
    const r = more.getBoundingClientRect();
    // folded for room, plus (in SIMPLE) the studio tools kept out of the way
    const simple = document.body.classList.contains('simple');
    const hidden = [...box.querySelectorAll('button')].filter(b => b !== more && !b.classList.contains('hidden') && (b.classList.contains('folded') || (simple && b.classList.contains('adv'))));
    popMenu(r.left, r.bottom + 4, hidden.map(b => [label(b), () => b.click()]));
  });
  const overflowing = () => bar.scrollWidth > bar.clientWidth + 1 || box.getBoundingClientRect().right > bar.getBoundingClientRect().right - 4;
  let busy = false;
  const fit = () => {
    if (busy) return; busy = true;
    for (const id of order) document.getElementById(id)?.classList.remove('folded');
    more.classList.toggle('hidden', !(document.body.classList.contains('simple') && box.querySelector('.adv')));
    // first tighten (smaller keys, then lamps without their labels), and only then fold keys away
    bar.classList.remove('tight1', 'tight2');
    if (overflowing()) bar.classList.add('tight1');
    if (overflowing()) bar.classList.add('tight2');
    for (const id of order) {
      if (!overflowing()) break;
      const b = document.getElementById(id);
      if (!b || b.classList.contains('hidden') || !box.contains(b)) continue; // keys in the side panel don't fold
      b.classList.add('folded'); more.classList.remove('hidden');
    }
    busy = false;
  };
  new ResizeObserver(fit).observe(bar);
  // the project name and CLOSE come and go as projects open
  const mo = new MutationObserver(() => requestAnimationFrame(fit));
  mo.observe(bar, { subtree: true, childList: true, characterData: true });
  const close = document.getElementById('btn-close-project');
  if (close) mo.observe(close, { attributes: true, attributeFilter: ['class'] });
  const saveBtn = document.getElementById('btn-save-project');
  if (saveBtn) mo.observe(saveBtn, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', fit);
  fit();
}
