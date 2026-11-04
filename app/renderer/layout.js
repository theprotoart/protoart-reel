// Resizable editor: drag the dividers between the media list, the viewer, the inspector and the timeline.
// Sizes are remembered on this Mac; double-click a divider to put it back.
const KEY = 'reel.layout';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } };
const save = v => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* fine */ } };

export function makeResizable(onResize) {
  const lib = document.getElementById('library'), insp = document.getElementById('right-col') || document.getElementById('inspector'), upper = document.getElementById('upper'), stage = document.getElementById('stage-wrap');
  if (!lib || !insp || !upper || !stage || document.querySelector('.split-v')) return;
  const sizes = load();
  const apply = () => {
    if (sizes.lib) lib.style.width = sizes.lib + 'px'; else lib.style.width = '';
    if (sizes.insp) insp.style.width = sizes.insp + 'px'; else insp.style.width = '';
    if (sizes.upper) { upper.style.flex = `0 0 ${sizes.upper}px`; } else upper.style.flex = '';
    onResize?.();
  };
  const bar = (cls, title) => { const b = document.createElement('div'); b.className = cls; b.title = title; return b; };
  const v1 = bar('split-v', 'Drag to resize the media list · double-click to reset');
  const v2 = bar('split-v', 'Drag to resize the inspector · double-click to reset');
  const h = bar('split-h', 'Drag to give the viewer or the timeline more room · double-click to reset');
  lib.after(v1); insp.before(v2); upper.after(h);
  const drag = (b, fn) => b.addEventListener('pointerdown', e => {
    e.preventDefault(); b.setPointerCapture(e.pointerId); b.classList.add('on');
    const x0 = e.clientX, y0 = e.clientY, start = { lib: lib.offsetWidth, insp: insp.offsetWidth, upper: upper.offsetHeight };
    const mv = ev => { fn(ev.clientX - x0, ev.clientY - y0, start); apply(); };
    const up = () => { b.classList.remove('on'); b.removeEventListener('pointermove', mv); b.removeEventListener('pointerup', up); save(sizes); };
    b.addEventListener('pointermove', mv); b.addEventListener('pointerup', up);
  });
  drag(v1, (dx, _, s) => { sizes.lib = Math.max(140, Math.min(560, s.lib + dx)); });
  drag(v2, (dx, _, s) => { sizes.insp = Math.max(240, Math.min(760, s.insp - dx)); });
  drag(h, (_, dy, s) => { sizes.upper = Math.max(220, Math.min(innerHeight - 220, s.upper + dy)); });
  v1.addEventListener('dblclick', () => { delete sizes.lib; save(sizes); apply(); });
  v2.addEventListener('dblclick', () => { delete sizes.insp; save(sizes); apply(); });
  h.addEventListener('dblclick', () => { delete sizes.upper; save(sizes); apply(); });
  apply();
}
