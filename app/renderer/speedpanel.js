// The clip speed panel (click a clip's speed badge), like ScreenFlow's clip inspector: a duration field, a speed
// slider with a % field, preset speeds, and switches that stay lit for keep pitch, reverse and locked. It floats
// over the editor and changes play live; it follows the clip through undo and closes if the clip goes.
import { el } from './ui.js';
import { setSpeed, mediaById } from './model.js';

const MIN = 0.1, MAX = 100;
const toPos = v => Math.log(v / MIN) / Math.log(MAX / MIN);
const fromPos = p => MIN * (MAX / MIN) ** p;
const PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4, 8, 16, 32, 64];

export function openSpeedPanel(app, clipId, x, y) {
  document.querySelector('.speed-pop')?.remove();
  const get = () => app.doc?.clips.find(c => c.id === clipId) || null;
  let c = get(); if (!c) return;
  const m = mediaById(app.doc, c.media);
  const srcDur = () => { const k = get(); return k ? k.duration * (k.speed || 1) : 0; };

  const dur = el('input', { type: 'text', class: 'sp-dur', title: 'Type a length in seconds: the speed follows' });
  const slider = el('input', { type: 'range', min: 0, max: 1, step: 0.001 });
  const pct = el('input', { type: 'number', min: 10, max: 10000, step: 1, class: 'sp-pct', title: 'Speed in % (100 = normal)' });
  const chips = el('div', { class: 'sp-chips' }, ...PRESETS.map(v => el('button', { type: 'button', 'data-v': v, text: v === 1 ? '1×' : `${v}×`, title: `${Math.round(v * 100)}%` })));
  const sw = (label, title) => { const b = el('button', { type: 'button', class: 'sp-switch', title }, el('i'), el('span', { text: label })); return b; };
  const pitch = sw('KEEP PITCH WHEN SPED UP OR SLOWED', 'On: voices keep their pitch at any speed. Off: pitch follows speed, like tape');
  const rev = sw('PLAY CLIP IN REVERSE', 'Plays the clip backwards');
  const lock = sw('LOCKED', 'A locked clip can’t be moved, trimmed or deleted by accident');
  const src = el('div', { class: 'sp-src' });

  const show = () => {
    c = get(); if (!c) { box.remove(); return; }
    const s = c.speed || 1;
    if (document.activeElement !== dur) dur.value = c.duration.toFixed(2);
    if (document.activeElement !== pct) pct.value = Math.round(s * 100);
    slider.value = toPos(Math.min(MAX, Math.max(MIN, s)));
    for (const b of chips.children) b.classList.toggle('on', Math.abs(Number(b.dataset.v) - s) < 1e-3);
    pitch.classList.toggle('on', c.audio?.keepPitch !== false);
    rev.classList.toggle('on', !!c.reversed);
    lock.classList.toggle('on', !!c.locked);
    src.textContent = `Source duration: ${srcDur().toFixed(2)} s`;
  };
  const apply = (v, live) => {
    const k = get(); if (!k || k.locked) return;
    v = Math.min(MAX, Math.max(MIN, v));
    if (live) { setSpeed(app.doc, k, v, 'start'); app.changed({ light: true, keepInspector: true }); }
    else app.commit(d => { const kk = d.clips.find(q => q.id === clipId); if (kk) setSpeed(d, kk, v, 'start'); }, { keepInspector: true });
    show();
  };
  let dragging = false;
  slider.addEventListener('input', () => { if (!dragging) { dragging = true; app.beginChange(); } apply(fromPos(Number(slider.value)), true); });
  slider.addEventListener('change', () => { if (dragging) { dragging = false; app.endChange({ keepInspector: true }); } });
  slider.addEventListener('dblclick', () => apply(1, false));
  pct.addEventListener('change', () => { const v = Number(pct.value) / 100; if (v > 0) apply(v, false); });
  dur.addEventListener('change', () => { const t = parseFloat(dur.value); if (t > 0.05) apply(srcDur() / t, false); else show(); });
  for (const b of chips.children) b.addEventListener('click', () => apply(Number(b.dataset.v), false));
  pitch.addEventListener('click', () => { app.commit(d => { const k = d.clips.find(q => q.id === clipId); if (k) k.audio = { ...(k.audio || {}), keepPitch: k.audio?.keepPitch === false }; }, { keepInspector: true }); show(); });
  rev.addEventListener('click', () => { app.select([clipId], null); app.cmd('reverse'); setTimeout(show, 50); });
  lock.addEventListener('click', () => { app.commit(d => { const k = d.clips.find(q => q.id === clipId); if (k) k.locked = !k.locked; }, { keepInspector: true }); show(); });

  const close = el('button', { class: 'mini', text: '×', title: 'Close', onclick: () => box.remove() });
  const head = el('div', { class: 'fx-ed-head' }, el('b', { text: `CLIP SPEED — ${c.name || m?.name || 'clip'}` }), close);
  const row = (label, ...kids) => el('div', { class: 'row' }, el('label', { text: label }), ...kids);
  const box = el('div', { class: 'fx-editor speed-pop' }, head,
    el('div', { class: 'fx-ed-body' },
      row('Duration', dur, el('span', { class: 'note', text: 'secs' })),
      row('Speed', slider, pct, el('span', { class: 'note', text: '%' })),
      chips, src, pitch, rev, lock),
    el('p', { class: 'note', text: 'Drag the slider or type a speed or a length. Double-click the slider for 100%.' }));
  document.body.append(box);
  // near the badge, kept on screen
  const r = box.getBoundingClientRect();
  box.style.left = Math.max(8, Math.min(innerWidth - r.width - 8, x - 20)) + 'px';
  box.style.top = Math.max(60, Math.min(innerHeight - r.height - 8, y - r.height - 14)) + 'px';
  box.style.right = 'auto';
  head.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const rr = box.getBoundingClientRect(), dx = e.clientX - rr.left, dy = e.clientY - rr.top;
    const mv = ev => { box.style.left = Math.max(0, ev.clientX - dx) + 'px'; box.style.top = Math.max(0, ev.clientY - dy) + 'px'; };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  });
  // follow undo / edits elsewhere
  const timer = setInterval(() => { if (!document.body.contains(box)) { clearInterval(timer); return; } if (!get()) { box.remove(); return; } if (!dragging && document.activeElement !== pct && document.activeElement !== dur) show(); }, 400);
  show();
}
