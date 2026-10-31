// A track's effect rack: numbered slots under the track header (like a DAW's track inserts). Each slot has a
// power switch, the effect's name (click to open its controls) and a menu (presets, move, remove). An empty
// slot adds an effect. The same chain plays live and is used by the export (lib/trackfx.js).
import { el, popMenu, toast } from './ui.js';
import { FX_TYPES, FX_PARAMS, FX_PRESETS } from './lib/trackfx.js';
import { uid } from './model.js';
import { addTrackPlugin, editTrackPlugin, renderPending, bakeTrack } from './trackplugins.js';

const SLOT_H = 24, MAX_SLOTS = 8;
/** An insert's display name: a built-in effect's, or your plug-in's own (with ★). */
export const fxName = f => (f.type === 'au' ? `★ ${f.name || 'Plug-in'}` : FX_TYPES[f.type]?.name || f.type);
export const fxRackH = tr => 30 + SLOT_H * Math.min(MAX_SLOTS, Math.max(3, (tr.fx || []).length + 1));

const fmt = (v, unit) => unit === 'Hz' ? (v >= 1000 ? (v / 1000).toFixed(1) + ' kHz' : Math.round(v) + ' Hz') : unit === 'dB' ? (v > 0 ? '+' : '') + v.toFixed(1) + ' dB' : unit === 'ms' ? Math.round(v) + ' ms' : unit === ':1' ? v.toFixed(1) + ':1' : Math.round(v * 100) + '%';

export function addFxMenu(app, tr, x, y, at) {
  const items = Object.entries(FX_TYPES).map(([type, d]) => [d.name, () => app.commit(() => {
    tr.fx ||= [];
    const f = { id: uid('fx'), type, params: {} };
    if (at == null || at >= tr.fx.length) tr.fx.push(f); else tr.fx.splice(at, 0, f);
    tr.fxOpen = true;
  }, { keepInspector: true })]);
  // your installed plug-ins (Audio Units: Waves, iZotope, FabFilter…) run on the clips of this track
  if (tr.id && app.doc?.tracks.includes(tr)) {
    items.push(null, ['★ Your plug-ins (Waves, iZotope, FabFilter…)…', () => addTrackPlugin(app, tr, at)]);
  }
  popMenu(x, y, items);
}

/** Removes an effect from its track (undoable) and closes its controls if they're open. */
export function removeFx(app, tr, f, after) {
  app.commit(() => { tr.fx = (tr.fx || []).filter(x => x !== f); }, { keepInspector: true });
  const ed = document.querySelector('.fx-editor');
  if (ed && ed._fx === f) ed.remove();
  toast(`Removed ${fxName(f)} from ${tr.name || 'the track'}. ⌘Z brings it back.`, 3000);
  after?.();
}

/** Everything you can do to one insert: the same menu in the timeline rack and on the mixer strip. */
export function fxSlotMenu(app, tr, f, x, y, after) {
  const list = tr.fx || [], i = list.indexOf(f);
  if (i < 0) return;
  const presets = Object.keys(FX_PRESETS[f.type] || {});
  const done = fn => () => { fn(); after?.(); };
  popMenu(x, y, [
    f.type === 'au' ? ['Open its window…', () => openFxEditor(app, tr, f)] : ['Open controls…', () => openFxEditor(app, tr, f)],
    f.type === 'au' && tr.id ? ['Render into the track for good (apply it, take it off the strip)…', () => bakeTrack(app, tr.id)] : null,
    f.type === 'au' && tr.id ? ['Render this track now (to hear it without its window open)', async () => { const n = await renderPending(app, { trackId: tr.id }); toast(n ? `Rendered ${n} clip${n === 1 ? '' : 's'}: press Space to hear the plug-in.` : 'Already rendered: press Space to hear it.', 4000); }] : null,
    [f.off ? 'Turn on' : 'Bypass (turn off)', done(() => app.commit(() => { f.off = !f.off; }, { keepInspector: true }))],
    null,
    ...presets.map(p => [`Preset: ${p}`, done(() => app.commit(() => { f.params = { ...FX_PRESETS[f.type][p] }; f.preset = p; }, { keepInspector: true }))]),
    presets.length ? null : ['No presets', null],
    ['Reset to default', done(() => app.commit(() => { f.params = {}; delete f.preset; }, { keepInspector: true }))],
    ['Duplicate', done(() => app.commit(() => { list.splice(i + 1, 0, { ...f, id: uid('fx'), params: { ...(f.params || {}) } }); }, { keepInspector: true }))],
    ['Replace with…', () => popMenu(x, y, Object.entries(FX_TYPES).filter(([t]) => t !== f.type).map(([type, d]) => [d.name, done(() => app.commit(() => { list[i] = { id: uid('fx'), type, params: {} }; }, { keepInspector: true }))]))],
    null,
    i > 0 ? ['Move up', done(() => app.commit(() => { list.splice(i - 1, 0, list.splice(i, 1)[0]); }, { keepInspector: true }))] : null,
    i < list.length - 1 ? ['Move down', done(() => app.commit(() => { list.splice(i + 1, 0, list.splice(i, 1)[0]); }, { keepInspector: true }))] : null,
    null,
    ['Remove', () => removeFx(app, tr, f, after)],
  ]);
}

export function fxRack(app, tr, h) {
  const list = tr.fx || [];
  const rows = [];
  for (let i = 0; i < Math.min(MAX_SLOTS, Math.max(3, list.length + 1)); i++) {
    const f = list[i];
    if (!f) {
      rows.push(el('div', { class: 'fx-slot empty', onclick: e => addFxMenu(app, tr, e.clientX, e.clientY, i) },
        el('span', { class: 'fx-n', text: i + 1 }), el('span', { class: 'fx-power' }), el('span', { class: 'fx-label', text: i === list.length ? '+ add effect' : '' }), el('span', { class: 'fx-more', text: '▸' })));
      continue;
    }
    const power = el('button', { class: 'fx-power' + (f.off ? '' : ' on'), title: f.off ? 'Off (bypassed): click to turn on' : 'On: click to bypass', onclick: e => { e.stopPropagation(); app.commit(() => { f.off = !f.off; }, { keepInspector: true }); } });
    const more = el('span', { class: 'fx-more', text: '▸', title: 'Presets, move, remove' });
    const row = el('div', { class: 'fx-slot' + (f.off ? ' off' : ''), title: 'Click to open its controls', onclick: () => openFxEditor(app, tr, f) },
      el('span', { class: 'fx-n', text: i + 1 }), power, el('span', { class: 'fx-label', text: f.preset ? `${fxName(f)} · ${f.preset}` : fxName(f) }), more);
    more.addEventListener('click', e => { e.stopPropagation(); fxSlotMenu(app, tr, f, e.clientX, e.clientY); });
    row.addEventListener('contextmenu', e => { e.preventDefault(); fxSlotMenu(app, tr, f, e.clientX, e.clientY); });
    rows.push(row);
  }
  const allOff = list.length && list.every(f => f.off);
  return el('div', { class: 'tl-fxhead', style: { height: h + 'px' } },
    el('div', { class: 'fx-top' },
      el('span', { class: 'engr', text: 'ƒx  EFFECTS' }),
      list.length ? el('button', { class: 'th-btn' + (allOff ? '' : ' on'), text: allOff ? 'ALL OFF' : 'ALL ON', title: 'Bypass or restore the whole rack', onclick: () => app.commit(() => { for (const f of list) f.off = !allOff; }) }) : null,
      el('button', { class: 'th-btn', text: '▴', title: 'Close the rack', onclick: () => app.commit(() => { tr.fxOpen = false; }) })),
    ...rows);
}

/** A floating window with the effect's controls; it stays open while you play, so you hear each change. */
export function openFxEditor(app, tr, f) {
  if (f.type === 'au') { editTrackPlugin(app, tr, f); return; } // your own plug-in: its own window
  document.querySelector('.fx-editor')?.remove();
  const params = FX_PARAMS[f.type] || [], def = FX_TYPES[f.type].defaults;
  const body = el('div', { class: 'fx-ed-body' });
  for (const [key, label, min, max, unit, log] of params) {
    const cur = () => (f.params && f.params[key] != null ? f.params[key] : def[key]);
    const toPos = v => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min));
    const fromPos = p => (log ? min * (max / min) ** p : min + p * (max - min));
    const val = el('span', { class: 'val', text: fmt(cur(), unit) });
    const input = el('input', { type: 'range', min: 0, max: 1, step: 0.001, value: toPos(cur()) });
    let started = false;
    input.addEventListener('input', () => {
      if (!started) { started = true; app.beginChange(); }
      const v = fromPos(Number(input.value));
      f.params ||= {}; f.params[key] = Math.round(v * 1000) / 1000; delete f.preset;
      val.textContent = fmt(v, unit);
      app.changed({ light: true, keepInspector: true, noTimeline: true });
    });
    input.addEventListener('change', () => { if (started) { started = false; app.endChange({ keepInspector: true }); } });
    input.addEventListener('dblclick', () => { app.commit(() => { if (f.params) delete f.params[key]; }, { keepInspector: true }); input.value = toPos(def[key]); val.textContent = fmt(def[key], unit); });
    body.append(el('div', { class: 'row' }, el('label', { text: label }), input, val));
  }
  if (f.type === 'gain') {
    for (const [key, label] of [['invert', 'Invert polarity'], ['mono', 'Sum to mono']]) {
      const cb = el('input', { type: 'checkbox', checked: !!f.params?.[key] });
      cb.addEventListener('change', () => app.commit(() => { f.params ||= {}; f.params[key] = cb.checked; }, { keepInspector: true }));
      body.append(el('label', { class: 'row' }, cb, el('span', { text: label })));
    }
  }
  const head = el('div', { class: 'fx-ed-head' },
    el('b', { text: `${FX_TYPES[f.type].name} — ${tr.name || 'Track'}` }),
    el('button', { class: 'mini', text: f.off ? 'OFF' : 'ON', onclick: e => { app.commit(() => { f.off = !f.off; }, { keepInspector: true }); e.target.textContent = f.off ? 'OFF' : 'ON'; } }),
    el('button', { class: 'mini', text: 'REMOVE', title: 'Take this effect off the track (⌘Z undoes)', onclick: () => removeFx(app, tr, f) }),
    el('button', { class: 'mini', text: '×', title: 'Close', onclick: () => box.remove() }));
  const box = el('div', { class: 'fx-editor' }, head, body, el('p', { class: 'note', text: 'Changes play live. Double-click a slider to reset it. Space plays and pauses.' }));
  box._fx = f;
  document.body.append(box);
  // drag by the title
  head.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const r = box.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const mv = ev => { box.style.left = Math.max(0, ev.clientX - dx) + 'px'; box.style.top = Math.max(0, ev.clientY - dy) + 'px'; box.style.right = 'auto'; };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  });
  if (!app.player.playing) toast('Press Space to play and hear the effect.', 2500);
}
