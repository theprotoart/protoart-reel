// SIMPLE and FULL. SIMPLE (the default for someone new) shows only what a beginner needs: bigger keys, colour-
// coded by job (red records, blue adds, amber AUTO EDIT, green exports), a 1 → 2 → 3 guide across the top of the
// editor, and a big "drop your video here" on an empty timeline. Every other tool is one click away under MORE.
// FULL shows everything. Switch with the SIMPLE / FULL lever in the top bar (or Settings › General).
import { el, popMenu } from './ui.js';

const KEY = 'reel.mode';
export function uiMode() {
  try { const v = localStorage.getItem(KEY); if (v === 'simple' || v === 'full') return v; } catch { /* default */ }
  return 'simple';
}
export function setUiMode(v) {
  try { localStorage.setItem(KEY, v); } catch { /* fine */ }
  applyMode();
}
export function applyMode() {
  const m = uiMode();
  document.body.classList.toggle('simple', m === 'simple');
  for (const b of document.querySelectorAll('#mode-switch button')) b.classList.toggle('on', b.dataset.mode === m);
  window.dispatchEvent(new Event('resize')); // the top bar refits
}

const label = n => (n.textContent || '').replace(/[▾▸]/g, '').replace(/\s+/g, ' ').trim();

export function initSimple(app) {
  for (const b of document.querySelectorAll('#mode-switch button')) b.addEventListener('click', () => setUiMode(b.dataset.mode));
  applyMode();

  // MORE TOOLS: everything the simple tool bar leaves out, as a menu (the same buttons, so they behave the same)
  document.getElementById('btn-more-tools')?.addEventListener('click', e => {
    const items = [...document.querySelectorAll('#toolstrip .adv')].map(n => {
      const input = n.querySelector('input[type=checkbox]');
      return input ? [`${input.checked ? '✓ ' : ''}${label(n)}`, () => input.click()] : [label(n), () => n.click()];
    });
    items.push(null, ['Show every tool (FULL)', () => setUiMode('full')]);
    const r = e.currentTarget.getBoundingClientRect();
    popMenu(r.left, r.bottom + 4, items);
  });
  document.getElementById('btn-autoedit')?.addEventListener('click', () => app.cmd('auto-edit'));
  document.getElementById('home-edit')?.addEventListener('click', () => app.editAVideo());

  // the 1 → 2 → 3 guide
  const guide = document.getElementById('guide');
  const steps = [
    { n: 1, t: 'ADD A VIDEO', go: () => app.cmd('import') },
    { n: 2, t: 'PICK PARTS', go: () => { if (!app.timeline.marking) app.cmd('keep-part'); } },
    { n: 3, t: '⚡ AUTO EDIT', go: () => { app.timeline.setMarking(false); app.cmd('auto-edit'); } },
    { n: 4, t: 'EXPORT', go: () => app.cmd('export') },
  ];
  const btns = steps.map(s => el('button', { class: 'g-step', onclick: s.go }, el('i', { text: String(s.n) }), el('b', { text: s.t })));
  const hint = el('span', { class: 'g-hint' });
  const close = el('button', { class: 'g-x', text: 'FULL ▸', title: 'Show every tool and hide this guide (switch back with SIMPLE in the top bar)', onclick: () => setUiMode('full') });
  guide.append(...btns.flatMap((b, i) => (i ? [el('span', { class: 'g-arrow', text: '→' }), b] : [b])), hint, close);
  let last = '';
  const update = () => {
    const d = app.doc;
    if (!d) return;
    const hasMedia = d.media.length > 0, onTimeline = d.clips.some(c => c.type === 'media');
    const parts = (d.sections || []).length, marking = !!app.timeline.marking, reviewing = !!document.querySelector('.ae-review');
    const at = !hasMedia || !onTimeline ? 1 : reviewing ? 4 : marking || !parts ? 2 : 3;
    const text = !hasMedia ? 'Click ADD A VIDEO, or drag a video file into this window.'
      : !onTimeline ? 'Drag your video from the left onto the timeline below.'
      : reviewing ? 'Watch the result. Keep it, change anything, or try another, then EXPORT.'
      : marking ? `Drag across the timeline over each part you want to keep (green). Drag a green edge to make a part longer or shorter, or drag inside it to move it. Grey parts are left out.${parts ? ` ${parts} part${parts === 1 ? '' : 's'} so far: click ⚡ AUTO EDIT when you’re done.` : ''}`
      : parts ? `${parts} part${parts === 1 ? '' : 's'} kept (green). Click ⚡ AUTO EDIT to blend ${parts === 1 ? 'it' : 'them'} into a finished video, or PICK PARTS to add more.`
      : 'Optional: click PICK PARTS and drag over the parts of the video you want to use. Or skip it: ⚡ AUTO EDIT uses the whole video. You can also cut by hand (click a clip, S splits, Delete removes).';
    const key = at + text;
    if (key === last) return;
    last = key;
    btns.forEach((b, i) => { b.classList.toggle('now', i + 1 === at); b.classList.toggle('done', i + 1 < at); });
    btns[1].classList.toggle('optional', !parts && !marking);
    btns[1].classList.toggle('lit', marking);
    hint.textContent = text;
  };
  setInterval(update, 600);

  // a big drop target on an empty timeline
  const timeline = document.getElementById('timeline');
  if (timeline) {
    const empty = el('div', { id: 'tl-empty', class: 'hidden' },
      el('div', { class: 'tl-empty-in' },
        el('b', { text: 'Drag a video here to start' }),
        el('div', { class: 'tl-empty-btns' },
          el('button', { class: 'hw role-add', text: 'ADD A VIDEO…', onclick: () => app.cmd('import') }),
          el('button', { class: 'rec-btn', onclick: () => app.cmd('record') }, el('span', { class: 'dot' }), 'RECORD MY SCREEN')),
        el('small', { text: 'Already in MEDIA on the left? Drag it down here.' })));
    timeline.append(empty);
    setInterval(() => { const d = app.doc; empty.classList.toggle('hidden', !d || d.clips.length > 0); }, 500);
  }
}
