// The tool bar's grouped menus (EFFECTS ▾, AUDIO ▾, TEXT ▾, PARTS ▾, ⚙ ▾): each holds the same buttons as
// before, kept in the page but out of sight, so their shortcuts and behaviour don't change. Clicking a group
// lists them as a menu; a group lights up while one of its tools is on (✚ CLIPS, a proxy being made…).
import { popMenu } from './ui.js';

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
