// 🎨 Match colour: makes the selected clips (or every clip) look like a reference shot. Each clip's colours are
// measured once, on a few frames, off the main thread; the match is a filter at the top of the clip's stack
// (adjustable Amount, removable, and re-runnable after a trim). Colour wheels are in lib/glfx.js (grade filter).
import { el, modal, toast } from './ui.js';
import { mediaById, uid, fmtTime } from './model.js';
import { matchParams, clipSampleTimes } from './lib/colormatch.js';

const visual = (doc, c) => { const m = c.type === 'media' && !c.audioOnly && !c.disabled && mediaById(doc, c.media); return !!m && (m.kind === 'video' || m.kind === 'image'); };
export const pictureClips = doc => doc.clips.filter(c => visual(doc, c)).sort((a, b) => a.start - b.start);
const label = (doc, c) => `${c.name || mediaById(doc, c.media)?.name || 'Clip'} · ${fmtTime(c.start).replace(/\.\d+$/, '')}`;

const cache = new Map();
/** A clip's colour statistics (measured once per media, range and speed). */
export function clipStats(app, c) {
  const m = mediaById(app.doc, c.media);
  const key = `${m.file}|${(c.in || 0).toFixed(2)}|${c.duration.toFixed(2)}|${c.speed || 1}`;
  if (cache.has(key)) return cache.get(key);
  const p = new Promise((resolve, reject) => {
    const w = new Worker('colorstats-worker.js', { type: 'module' });
    const done = () => setTimeout(() => w.terminate(), 50);
    const timer = setTimeout(() => { done(); reject(new Error('Measuring the colours took too long')); }, 60000);
    w.onmessage = e => { clearTimeout(timer); done(); if (e.data.type === 'done') resolve(e.data.stats); else reject(new Error(e.data.message)); };
    w.onerror = e => { clearTimeout(timer); done(); reject(new Error(e.message || 'The colour measurer stopped')); };
    w.postMessage({ type: 'start', url: `app://reel/m/${app.token}/${encodeURIComponent(m.file)}`, kind: m.kind, times: clipSampleTimes(c, 5) });
  });
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  return p;
}

/** Puts the match filter on the clips (replacing an earlier one). targets / ref: clips in app.doc. */
async function runMatch(app, targets, ref, amount, onStatus) {
  onStatus?.('Measuring the reference…');
  const r = await clipStats(app, ref);
  const out = [];
  for (const [i, c] of targets.entries()) {
    onStatus?.(`Measuring ${i + 1} of ${targets.length}…`);
    try { out.push([c.id, matchParams(await clipStats(app, c), r)]); }
    catch (e) { toast(`${label(app.doc, c)}: ${e.message}`, 5000); }
  }
  app.commit(d => {
    for (const [id, mp] of out) {
      const c = d.clips.find(x => x.id === id); if (!c) continue;
      c.filters = (c.filters || []).filter(f => f.type !== 'match');
      c.filters.unshift({ id: uid('f'), type: 'match', ref: ref.id, refName: label(d, ref), amount, ...mp });
    }
  });
  return out.length;
}

/** EFFECTS ▾ › Match colour…, or Filters › Match colour… on one clip. */
export function openMatchColour(app, only = null) {
  const doc = app.doc; if (!doc) return;
  const all = pictureClips(doc);
  if (all.length < 2) { toast('Colour match needs at least two video or picture clips: one to match, one to look like.', 5000); return; }
  const sel = only ? [only] : all.filter(c => app.selection.clips.includes(c.id));
  // the reference: a clip that isn't being matched, the one before the first selected by default
  const first = sel[0];
  const refDefault = all.filter(c => !sel.includes(c) && (!first || c.start < first.start)).pop() || all.find(c => !sel.includes(c)) || all[0];
  const refSel = el('select', {}, ...all.map(c => el('option', { value: c.id, text: label(doc, c), selected: c === refDefault })));
  const scope = el('select', {},
    el('option', { value: 'sel', text: sel.length ? (sel.length === 1 ? `This clip (${label(doc, sel[0])})` : `The ${sel.length} selected clips`) : 'The selected clips (none selected)', selected: !!sel.length, disabled: !sel.length }),
    el('option', { value: 'all', text: 'Every other video and picture clip', selected: !sel.length }));
  const amount = el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: 1 }), amtVal = el('span', { class: 'val', text: '100%' });
  amount.addEventListener('input', () => { amtVal.textContent = Math.round(amount.value * 100) + '%'; });
  const note = el('p', { class: 'note', text: 'Reel measures the colours of each shot (a few frames, on this Mac) and shifts them to sit like the reference: the same warmth, brightness and contrast. Fine-tune with Amount, or the Colour wheels in Filters.' });
  modal('🎨 Match colour', el('div', { class: 'cm' },
    el('div', { class: 'row' }, el('label', { text: 'Match' }), scope),
    el('div', { class: 'row' }, el('label', { text: 'To look like' }), refSel),
    el('div', { class: 'row' }, el('label', { text: 'Amount' }), amount, amtVal), note), [
    { label: 'Cancel', onClick: c => c() },
    { label: 'Match', cls: 'hw amber', onClick: async close => {
      const ref = app.doc.clips.find(c => c.id === refSel.value);
      const targets = (scope.value === 'all' ? pictureClips(app.doc) : sel.map(c => app.doc.clips.find(x => x.id === c.id)).filter(Boolean)).filter(c => c.id !== ref.id);
      if (!targets.length) { note.textContent = 'Pick clips other than the reference to match.'; return; }
      note.textContent = 'Measuring…';
      try {
        const n = await runMatch(app, targets, ref, Number(amount.value), t => { note.textContent = t; });
        close(); toast(`${n} clip${n === 1 ? '' : 's'} matched to ${label(app.doc, ref)}. Filters › Match colour has the Amount; × takes it off.`, 6000);
      } catch (e) { note.textContent = `Couldn’t measure the colours: ${e.message}`; }
    } },
  ]);
}

/** Filters panel controls for a match filter: what it matches, Amount, Match again. */
export function matchControls(app, insp, c, f, sl) {
  const ref = app.doc.clips.find(x => x.id === f.ref);
  return [
    el('p', { class: 'note', text: ref ? `Looks like ${label(app.doc, ref)}.` : `Matched to ${f.refName || 'a clip that’s gone'}.` }),
    sl(f, 'amount', 'Amount', { def: 1, min: 0, max: 1, step: 0.01, fmt: v => Math.round(v * 100) + '%' }),
    el('div', { class: 'btn-row' },
      ref ? el('button', { class: 'tool', text: 'Match again', title: 'Measure again (after a trim, say) and update the match', onclick: async () => { try { await runMatch(app, [c], ref, f.amount ?? 1); toast('Matched again.'); } catch (e) { toast(e.message, 5000); } } }) : null,
      el('button', { class: 'tool', text: 'Another reference…', onclick: () => openMatchColour(app, c) })),
  ];
}

// ------------------------------------------------------------------ colour wheels
/** One colour wheel (a hue ring with a dot to drag, and a brightness slider). value: { x, y, l }. */
export function colourWheel(title, value, onChange) {
  const S = 92, cv = el('canvas', { width: S * 2, height: S * 2, class: 'cw-wheel', title: 'Drag the dot toward a colour; double-click to reset' });
  cv.style.width = cv.style.height = S + 'px';
  let v = { x: 0, y: 0, l: 0, ...(value || {}) };
  const g = cv.getContext('2d');
  const draw = () => {
    const R = S - 6, cx = S, cy = S;
    g.clearRect(0, 0, S * 2, S * 2);
    for (let a = 0; a < 360; a += 2) { // hue ring, matching the colour each direction pushes toward
      const rad = (a * Math.PI) / 180;
      g.strokeStyle = `hsl(${a}, 85%, 55%)`; g.lineWidth = 10;
      g.beginPath(); g.arc(cx, cy, R, -rad - 0.04, -rad + 0.04); g.stroke();
    }
    const gr = g.createRadialGradient(cx, cy, 0, cx, cy, R - 6); gr.addColorStop(0, '#3a3a3c'); gr.addColorStop(1, '#1d1d1f');
    g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, R - 6, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.18)'; g.lineWidth = 1; g.beginPath(); g.moveTo(cx - R + 6, cy); g.lineTo(cx + R - 6, cy); g.moveTo(cx, cy - R + 6); g.lineTo(cx, cy + R - 6); g.stroke();
    const dx = cx + v.x * (R - 10), dy = cy - v.y * (R - 10);
    g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 2; g.beginPath(); g.arc(dx, dy, 7, 0, Math.PI * 2); g.fill(); g.stroke();
  };
  const at = e => {
    const r = cv.getBoundingClientRect(), R = (S - 16) * (r.width / S);
    let x = (e.clientX - r.left - r.width / 2) / R, y = -(e.clientY - r.top - r.height / 2) / R;
    const d = Math.hypot(x, y); if (d > 1) { x /= d; y /= d; }
    // a little sticky at the centre, so "no change" is easy to hit
    if (Math.hypot(x, y) < 0.04) { x = 0; y = 0; }
    v = { ...v, x: +x.toFixed(3), y: +y.toFixed(3) }; draw(); onChange(v, false);
  };
  cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); at(e); const mv = ev => at(ev); const up = () => { cv.removeEventListener('pointermove', mv); cv.removeEventListener('pointerup', up); onChange(v, true); }; cv.addEventListener('pointermove', mv); cv.addEventListener('pointerup', up); });
  cv.addEventListener('dblclick', () => { v = { x: 0, y: 0, l: 0 }; lum.value = 0; draw(); onChange(v, true); });
  const lum = el('input', { type: 'range', min: -1, max: 1, step: 0.01, value: v.l, title: `${title}: darker or brighter` });
  lum.addEventListener('input', () => { v = { ...v, l: Number(lum.value) }; onChange(v, false); });
  lum.addEventListener('change', () => onChange(v, true));
  draw();
  return el('div', { class: 'cw' }, el('span', { class: 'engr', text: title }), cv, lum);
}
