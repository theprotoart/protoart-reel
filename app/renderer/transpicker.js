// Transitions and fades, the easy way (like CapCut): a ⧓ button sits on every cut between two clips; click it (or
// TRANSITIONS on the tool bar) and pick from animated previews. A duration slider, "apply to every cut", and the
// fades (in from black, out to black, the whole video) are in the same panel.
import { el, toast } from './ui.js';
import { applyCut, cutsOn, clipEnd, mediaById } from './model.js';
import { tile } from './fxlibrary.js';
import { pref } from './prefs.js';

/** The transitions offered at a cut, most useful first (all play on both sides of the cut). */
export const CUT_CHOICES = [
  ['fade', 'Dissolve'], ['dip-black', 'Dip to black'], ['dip-white', 'Dip to white'], ['zoom-through', 'Zoom through'],
  ['whip-through', 'Whip'], ['slide-left', 'Slide'], ['push-left', 'Push'], ['blur-through', 'Blur'], ['spin-through', 'Spin'],
  ['flash-cut', 'Flash'], ['glitch-cut', 'Glitch'], ['shake-cut', 'Shake'], ['light-leak', 'Light leak'], ['film-burn', 'Film burn'],
  ['wipe-left', 'Wipe'], ['iris', 'Circle'], ['clock', 'Clock'], ['barn', 'Barn doors'], ['blinds', 'Blinds'], ['zoom', 'Zoom in'], ['pop', 'Pop'],
];
const NAME = Object.fromEntries(CUT_CHOICES);

const visual = (doc, c) => c.type !== 'media' || (!c.audioOnly && mediaById(doc, c.media)?.kind !== 'audio');
/** Every cut in the edit where two pictures meet: [[a, b], …]. */
export function allCuts(doc) { return doc.tracks.flatMap(t => cutsOn(doc, t.id)).filter(([a, b]) => visual(doc, a) && visual(doc, b)); }
/** The cut nearest the selected clip (its end, else its start), or null. */
function cutForSelection(app) {
  const doc = app.doc, sel = doc.clips.find(c => app.selection.clips.includes(c.id));
  if (!sel) return null;
  const cuts = cutsOn(doc, sel.track);
  const t = app.player.time;
  const mine = cuts.filter(([a, b]) => a.id === sel.id || b.id === sel.id);
  if (!mine.length) return null;
  return mine.sort((p, q) => Math.abs(clipEnd(p[0]) - t) - Math.abs(clipEnd(q[0]) - t))[0];
}

export function openTransitions(app, cut = null) {
  const doc = app.doc; if (!doc) return;
  document.querySelector('.tp-panel')?.remove();
  cut ||= cutForSelection(app);
  let ids = cut ? [cut[0].id, cut[1].id] : null;
  const get = () => (ids ? ids.map(id => app.doc.clips.find(c => c.id === id)) : null);
  const cur = () => { const p = get(); return p && p[0] && p[1] ? p[1].transIn?.type || 'none' : null; };
  let dur = (() => { const p = get(); const d = p?.[1]?.transIn?.dur; return d && p[1].transIn.type !== 'none' ? d * 2 : pref('transDur') || 0.5; })();

  const where = el('p', { class: 'tp-where' });
  const durVal = el('span', { class: 'val' });
  const durIn = el('input', { type: 'range', min: 0.2, max: 2, step: 0.05, value: dur });
  durIn.addEventListener('input', () => { dur = Number(durIn.value); durVal.textContent = dur.toFixed(2) + ' s'; });
  durIn.addEventListener('change', () => { const c = cur(); if (c && c !== 'none') apply(c); });
  const grid = el('div', { class: 'tp-grid' });
  const none = el('div', { class: 'pl-tile tp-none', title: 'No transition: a straight cut' }, el('div', { class: 'tp-none-in', text: 'NONE' }), el('div', { class: 'pl-name', text: 'Cut' }));
  none.addEventListener('click', () => apply('none'));
  grid.append(none, ...CUT_CHOICES.map(([id, name]) => { const t = tile('cut', id, name, () => apply(id)); t.dataset.id = id; return t; }));

  const drawWhere = () => {
    const p = get();
    if (p && p[0] && p[1]) where.textContent = `Between “${p[0].name || mediaById(app.doc, p[0].media)?.name || 'clip'}” and “${p[1].name || mediaById(app.doc, p[1].media)?.name || 'clip'}” at ${fmt(clipEnd(p[0]))}. Click a transition to put it there; hover to preview it.`;
    else where.textContent = allCuts(app.doc).length ? 'No cut picked: click a transition to put it on every cut (or click a ⧓ on the timeline to pick one cut).' : 'Transitions go between two clips. Split a clip where you want one (put the playhead there and press SPLICE / S), then click the ⧓ that appears on the cut.';
    const c = cur();
    for (const t of grid.children) t.classList.toggle('on', (t.dataset.id || 'none') === c || (t === none && c === 'none'));
    durVal.textContent = dur.toFixed(2) + ' s';
  };
  const apply = type => {
    const p = get();
    if (p && p[0] && p[1]) {
      app.commit(d => {
        const a = d.clips.find(c => c.id === ids[0]), b = d.clips.find(c => c.id === ids[1]);
        if (type === 'none') { a.transOut = { type: 'none', dur: a.transOut?.dur || 0.5 }; b.transIn = { type: 'none', dur: b.transIn?.dur || 0.5 }; }
        else applyCut(a, b, type, dur);
      });
      toast(type === 'none' ? 'Transition removed: a straight cut.' : `${NAME[type] || type} on that cut.`, 2000);
    } else applyAll(type);
    drawWhere();
  };
  const applyAll = type => {
    const n = allCuts(app.doc).length;
    if (!n) { toast('There are no cuts yet: split a clip (S) or put two clips next to each other.', 4000); return; }
    app.commit(d => { for (const [a, b] of allCuts(d)) { if (type === 'none') { a.transOut = { type: 'none', dur: 0.5 }; b.transIn = { type: 'none', dur: 0.5 }; } else applyCut(a, b, type, dur); } });
    toast(type === 'none' ? `Removed the transitions from all ${n} cuts.` : `${NAME[type] || type} on all ${n} cuts.`, 2500);
  };

  // fades: the selected clip, or the whole video
  const fadeSel = (side, on) => {
    const list = app.doc.clips.filter(c => app.selection.clips.includes(c.id));
    if (!list.length) { toast('Select a clip first (click it on the timeline).'); return; }
    app.commit(() => {
      for (const c of list) {
        const m = c.type === 'media' ? mediaById(app.doc, c.media) : null, d = Math.min(0.7, c.duration / 3);
        if (c.audio && (m?.hasAudio || m?.kind === 'audio')) c.audio[side === 'in' ? 'fadeIn' : 'fadeOut'] = on ? d : 0;
        if (visual(app.doc, c)) c[side === 'in' ? 'transIn' : 'transOut'] = on ? { type: 'fade', dur: d } : { type: 'none', dur: 0.5 };
      }
    });
    toast(on ? `Fade ${side} on the selected clip${list.length > 1 ? 's' : ''}.` : 'Fade removed.', 2000);
  };
  const fadeWhole = () => {
    const vis = app.doc.clips.filter(c => visual(app.doc, c));
    if (!vis.length) return;
    const first = vis.reduce((a, b) => (b.start < a.start ? b : a)), last = vis.reduce((a, b) => (clipEnd(b) > clipEnd(a) ? b : a));
    app.commit(d => {
      const f = d.clips.find(c => c.id === first.id), l = d.clips.find(c => c.id === last.id);
      f.transIn = { type: 'fade', dur: Math.min(1, f.duration / 3) }; l.transOut = { type: 'fade', dur: Math.min(1.5, l.duration / 3) };
      for (const c of d.clips) { if (c.audio && Math.abs(c.start - f.start) < 0.05) c.audio.fadeIn = Math.max(c.audio.fadeIn || 0, 0.5); if (c.audio && Math.abs(clipEnd(c) - clipEnd(l)) < 0.05) c.audio.fadeOut = Math.max(c.audio.fadeOut || 0, 1); }
    });
    toast('The video now fades in from black at the start and out to black at the end.', 3000);
  };
  const b = (text, title, fn, cls = 'hw') => el('button', { class: cls, text, title, onclick: fn });
  const fades = el('div', { class: 'tp-fades' },
    b('FADE IN', 'The selected clip fades in from black (and its sound fades up)', () => fadeSel('in', true)),
    b('FADE OUT', 'The selected clip fades out to black (and its sound fades down)', () => fadeSel('out', true)),
    b('NO FADES', 'Remove the fades from the selected clip', () => { fadeSel('in', false); fadeSel('out', false); }),
    b('FADE THE WHOLE VIDEO', 'Fade in from black at the very start and out to black at the very end', fadeWhole, 'hw role-add'));

  const head = el('div', { class: 'fx-ed-head' }, el('b', { text: 'TRANSITIONS & FADES' }), el('button', { class: 'mini', text: '×', title: 'Close', onclick: () => box.remove() }));
  const box = el('div', { class: 'fx-editor tp-panel' }, head,
    el('div', { class: 'fx-ed-body' },
      where,
      el('div', { class: 'row tp-durrow' }, el('label', { text: 'Length' }), durIn, durVal,
        b('APPLY TO EVERY CUT', 'Put the highlighted transition on every cut in the edit', () => { const c = cur(); applyAll(c && c !== 'none' ? c : CUT_CHOICES[0][0]); drawWhere(); }, 'hw role-auto')),
      grid,
      el('div', { class: 'engr', text: 'Fades' }), fades));
  document.body.append(box);
  // centred over the lower half of the window, always fully on screen (placed in pixels, so dragging it
  // from the title bar moves it smoothly instead of jumping)
  const place = () => {
    const r = box.getBoundingClientRect();
    box.style.left = Math.max(8, (innerWidth - r.width) / 2) + 'px';
    box.style.top = Math.max(60, Math.min(innerHeight - r.height - 12, innerHeight * 0.42)) + 'px';
  };
  place();
  head.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const r = box.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const mv = ev => { box.style.left = Math.max(0, ev.clientX - dx) + 'px'; box.style.top = Math.max(0, ev.clientY - dy) + 'px'; box.style.right = 'auto'; box.style.bottom = 'auto'; };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  });
  // follows the cut you click on the timeline while it's open
  box._setCut = c => { ids = c ? [c[0].id, c[1].id] : null; drawWhere(); };
  drawWhere();
  return box;
}
const fmt = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}.${Math.floor((t % 1) * 10)}`;
