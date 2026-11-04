// Inspector: the picture filter stack (colour, looks, LUTs, sharpen, blur, vignette, black & white,
// green screen) and background removal for a video or image clip.
import { el, toast, modal, slider } from './ui.js';
import { uid } from './model.js';
import { LOOKS } from './lib/glfx.js';
import { gate } from './capability.js';

const KINDS = [
  ['color', 'Colour'], ['look', 'Look'], ['lut', 'LUT (.cube)…'], ['sharpen', 'Sharpen'], ['blur', 'Blur'],
  ['vignette', 'Vignette'], ['bw', 'Black & white'], ['chroma', 'Green screen'],
  ['grain', 'Film grain (cinematic)'], ['letterbox', 'Letterbox bars (cinematic)'], ['halation', 'Halation glow (cinematic)'], ['aberration', 'Chromatic aberration (cinematic)'],
];
const LOOK_NAMES = { warm: 'Warm', cool: 'Cool', tealOrange: 'Teal & orange', faded: 'Faded', punchy: 'Punchy', moody: 'Moody', vintage: 'Vintage', crisp: 'Crisp' };
const pct = v => Math.round(v * 100) + '%';
const signed = v => (v > 0 ? '+' : '') + Math.round(v * 100);

export function filtersSection(app, insp, c) {
  c.filters ||= [];
  const sec = el('div', { class: 'insp-section' }, el('span', { class: 'engr', text: 'Filters' }));
  const sl = (f, key, label, opts) => insp.sl(label, () => f[key] ?? opts.def ?? 0, v => { f[key] = v; }, opts);

  c.filters.forEach((f, i) => {
    const name = f.type === 'look' ? `Look: ${LOOK_NAMES[f.look] || f.look}` : f.type === 'lut' ? `LUT: ${f.name || 'file'}` : (KINDS.find(k => k[0] === f.type) || [, f.type])[1];
    const box = el('div', { class: 'fx-item' + (f.off ? ' off' : '') });
    box.append(el('div', { class: 'row', style: { margin: 0 } },
      el('span', { class: 'fx-name', text: name }),
      el('button', { class: 'mini' + (f.off ? '' : ' on'), text: f.off ? 'OFF' : 'ON', title: 'Bypass', onclick: () => insp.edit(() => { f.off = !f.off; }) }),
      i > 0 ? el('button', { class: 'mini', text: '↑', title: 'Earlier in the stack', onclick: () => insp.edit(() => { c.filters.splice(i - 1, 0, c.filters.splice(i, 1)[0]); }) }) : null,
      el('button', { class: 'mini', text: '×', title: 'Remove', onclick: () => insp.edit(() => { c.filters.splice(i, 1); }) })));
    const body = el('div', { class: 'fx-voice' });
    switch (f.type) {
      case 'color':
        body.append(
          sl(f, 'exposure', 'Exposure', { min: -2, max: 2, step: 0.01, fmt: v => (v > 0 ? '+' : '') + v.toFixed(2) }),
          sl(f, 'contrast', 'Contrast', { min: -1, max: 1, step: 0.01, fmt: signed }),
          sl(f, 'highlights', 'Highlights', { min: -1, max: 1, step: 0.01, fmt: signed }),
          sl(f, 'shadows', 'Shadows', { min: -1, max: 1, step: 0.01, fmt: signed }),
          sl(f, 'saturation', 'Saturation', { min: -1, max: 1, step: 0.01, fmt: signed }),
          sl(f, 'vibrance', 'Vibrance', { min: -1, max: 1, step: 0.01, fmt: signed }),
          sl(f, 'temperature', 'Temperature', { min: -1, max: 1, step: 0.01, fmt: signed }),
          sl(f, 'tint', 'Tint', { min: -1, max: 1, step: 0.01, fmt: signed }));
        break;
      case 'look': {
        const s = el('select', {}, ...Object.entries(LOOK_NAMES).map(([k, t]) => el('option', { value: k, text: t, selected: f.look === k })));
        s.addEventListener('change', () => insp.edit(() => { f.look = s.value; }));
        body.append(el('div', { class: 'row' }, el('label', { text: 'Look' }), s), sl(f, 'amount', 'Amount', { def: 1, min: 0, max: 1.5, step: 0.01, fmt: pct }));
        break;
      }
      case 'lut': body.append(sl(f, 'amount', 'Amount', { def: 1, min: 0, max: 1, step: 0.01, fmt: pct })); break;
      case 'sharpen': body.append(sl(f, 'amount', 'Amount', { def: 0.5, min: 0, max: 2, step: 0.01, fmt: pct })); break;
      case 'blur': body.append(sl(f, 'amount', 'Radius', { def: 8, min: 0, max: 60, step: 0.5, fmt: v => v.toFixed(1) })); break;
      case 'vignette': body.append(sl(f, 'amount', 'Amount', { def: 0.4, min: 0, max: 1, step: 0.01, fmt: pct })); break;
      case 'bw': body.append(sl(f, 'amount', 'Amount', { def: 1, min: 0, max: 1, step: 0.01, fmt: pct })); break;
      case 'grain': body.append(sl(f, 'amount', 'Grain', { def: 0.35, min: 0, max: 1, step: 0.01, fmt: pct })); break;
      case 'halation': body.append(sl(f, 'amount', 'Glow', { def: 0.4, min: 0, max: 1, step: 0.01, fmt: pct })); break;
      case 'aberration': body.append(sl(f, 'amount', 'Fringing', { def: 0.35, min: 0, max: 1, step: 0.01, fmt: pct })); break;
      case 'letterbox': {
        const r = el('select', {}, ...[[2.39, '2.39 : 1 (scope)'], [2, '2 : 1'], [1.85, '1.85 : 1'], [2.76, '2.76 : 1 (ultra)']].map(([v, t]) => el('option', { value: v, text: t, selected: Math.abs((f.ratio || 2.39) - v) < 0.01 })));
        r.addEventListener('change', () => insp.edit(() => { f.ratio = Number(r.value); }));
        body.append(el('div', { class: 'row' }, el('label', { text: 'Shape' }), r));
        break;
      }
      case 'chroma': {
        const col = el('input', { type: 'color', value: f.color || '#00d000' });
        col.addEventListener('change', () => insp.edit(() => { f.color = col.value; }));
        const pick = typeof window.EyeDropper === 'function'
          ? el('button', { class: 'mini', text: 'Pick', title: 'Pick the background colour from the screen', onclick: async () => { try { const r = await new window.EyeDropper().open(); insp.edit(() => { f.color = r.sRGBHex; }); } catch { /* cancelled */ } } })
          : null;
        body.append(el('div', { class: 'row' }, el('label', { text: 'Key colour' }), col, pick),
          sl(f, 'tolerance', 'Tolerance', { def: 0.12, min: 0.01, max: 0.5, step: 0.005, fmt: v => v.toFixed(3) }),
          sl(f, 'softness', 'Edge softness', { def: 0.08, min: 0, max: 0.4, step: 0.005, fmt: v => v.toFixed(3) }),
          sl(f, 'spill', 'Spill removal', { def: 0.6, min: 0, max: 1, step: 0.01, fmt: pct }));
        break;
      }
      default: break;
    }
    box.append(body);
    sec.append(box);
  });

  const add = el('select', {}, el('option', { value: '', text: '+ Add a filter…' }), ...KINDS.map(([v, t]) => el('option', { value: v, text: t })));
  add.addEventListener('change', async () => {
    const type = add.value; add.value = '';
    if (!type) return;
    if (type === 'lut') {
      try {
        const r = await app.api.lutImport(app.token);
        if (!r) return;
        insp.edit(() => { c.filters.push({ id: uid('f'), type: 'lut', file: r.file, name: r.name, amount: 1 }); });
      } catch (e) { toast(e.message); }
      return;
    }
    const base = { id: uid('f'), type };
    if (type === 'look') base.look = 'warm';
    if (type === 'chroma') Object.assign(base, { color: '#00d000', tolerance: 0.12, softness: 0.08, spill: 0.6 });
    if (type === 'grain') base.amount = 0.35;
    if (type === 'letterbox') base.ratio = 2.39;
    if (type === 'halation') base.amount = 0.4;
    if (type === 'aberration') base.amount = 0.35;
    insp.edit(() => { c.filters.push(base); });
  });
  sec.append(el('div', { class: 'row' }, el('label', { text: 'Add' }), add));
  if (!c.filters.length) sec.append(el('p', { class: 'note', text: 'Filters run on the graphics chip, in the preview and the export. Stack as many as you like; their order matters for LUTs.' }));
  return sec;
}

/** Background removal (people): a mask made on this Mac with Apple's Vision, used as transparency. */
export function matteSection(app, insp, c, m) {
  const sec = el('div', { class: 'insp-section' }, el('span', { class: 'engr', text: 'Background removal' }));
  if (!c.matte || !c.matte.file) {
    const q = el('select', {}, el('option', { value: 'fast', text: 'Fast' }), el('option', { value: 'balanced', text: 'Balanced', selected: true }), gate(el('option', { value: 'accurate', text: 'Accurate (slow)' }), 'matteAccurate'));
    sec.append(el('p', { class: 'note', text: 'Cuts a person out of their background (great for a camera clip over a screen recording). Done once on this Mac; nothing is uploaded.' }),
      el('div', { class: 'row' }, el('label', { text: 'Quality' }), q),
      el('div', { class: 'btn-row' }, el('button', { class: 'tool on-amber', text: 'Remove background', onclick: () => runMatte(app, c, m, q.value) })));
  } else {
    const on = el('input', { type: 'checkbox', checked: !c.matte.off });
    on.addEventListener('change', () => insp.edit(() => { c.matte.off = !on.checked; }));
    sec.append(el('div', { class: 'row' }, el('label', { text: 'Removed' }), on),
      insp.sl('Edge', () => c.matte.feather ?? 0.08, v => { c.matte.feather = v; }, { min: 0.01, max: 0.4, step: 0.005, fmt: v => v.toFixed(3) }),
      el('div', { class: 'btn-row' }, el('button', { class: 'tool', text: 'Redo (accurate)', onclick: () => runMatte(app, c, m, 'accurate') }),
        el('button', { class: 'tool', text: 'Remove', onclick: () => insp.edit(() => { delete c.matte; }) })));
  }
  return sec;
}

async function runMatte(app, c, m, quality) {
  const bar = el('div', { class: 'progress' }, el('i'));
  const note = el('p', { class: 'note', text: `Finding the person in every frame of “${m.name}”… This runs on the Neural Engine and can take a while for long clips.` });
  const dlg = modal('Remove background', el('div', {}, note, bar), [{ label: 'Hide', onClick: x => x() }]);
  const off = app.api.onMatteProgress ? (app._matteListener ||= (app.api.onMatteProgress(v => { const b = document.querySelector('#modal-root .progress i'); if (b) b.style.width = Math.round(v * 100) + '%'; }), true)) : null;
  void off;
  try {
    const r = await app.api.matteMake(app.token, m.file, quality);
    app.commit(() => { c.matte = { file: r.file, feather: 0.08 }; });
    dlg.close();
    toast('Background removed. Put a screen recording or a picture on the track below.');
  } catch (e) { dlg.close(); toast(e.message, 7000); }
  void slider;
}

// ------------------------------------------------------------------ stabilize
/** Stabilize: measure the camera shake once (on small frames, on this Mac), then smooth it out as it plays. */
export function stabilizeSection(app, insp, c, m) {
  const sec = el('div', { class: 'insp-section' }, el('span', { class: 'engr', text: 'Stabilize' }));
  if (!c.stab) {
    sec.append(el('p', { class: 'note', text: 'Smooths out a shaky camera: Reel follows the shake, keeps slow intended moves, and zooms in a little so the edges stay hidden. Measured once on this Mac; the original isn’t changed.' }),
      el('div', { class: 'btn-row' }, el('button', { class: 'tool on-amber', text: '🎥 Stabilize', onclick: () => runStabilize(app, c, m) })));
    return sec;
  }
  const st = c.stab;
  const on = el('input', { type: 'checkbox', checked: !st.off });
  on.addEventListener('change', () => insp.edit(() => { st.off = !on.checked; }));
  sec.append(el('div', { class: 'row' }, el('label', { text: 'Stabilized' }), on),
    insp.sl('Smoothness', () => st.smooth ?? 1.5, v => { st.smooth = v; }, { min: 0.3, max: 5, step: 0.1, fmt: v => v.toFixed(1) + ' s' }),
    insp.sl('Strength', () => st.strength ?? 1, v => { st.strength = v; }, { min: 0, max: 1, step: 0.01, fmt: v => Math.round(v * 100) + '%' }),
    insp.sl('Zoom', () => st.zoom || 0, v => { st.zoom = v < 1.005 ? 0 : v; }, { min: 1, max: 1.4, step: 0.005, fmt: v => (v < 1.005 ? 'Automatic' : Math.round(v * 100) + '%') }),
    el('p', { class: 'note', text: 'Smoothness: how long a move must last to be kept (higher is steadier, like a tripod). Zoom hides the moving edges; set it by hand if you’d rather crop less and allow a little edge.' }),
    el('div', { class: 'btn-row' },
      el('button', { class: 'tool', text: 'Measure again', onclick: () => runStabilize(app, c, m) }),
      el('button', { class: 'tool', text: 'Remove', onclick: () => insp.edit(() => { delete c.stab; }) })));
  return sec;
}

export async function runStabilize(app, c, m) {
  const t0 = Math.max(0, c.in || 0), t1 = t0 + c.duration * (c.speed || 1);
  const rate = t1 - t0 > 180 ? 10 : 15; // a long clip is measured a little more sparsely
  const file = m.proxy?.file || m.file; // the proxy is smaller to decode; the motion is the same
  const bar = el('div', { class: 'progress' }, el('i'));
  const w = new Worker('stab-worker.js', { type: 'module' });
  let stopped = false;
  const dlg = modal('Stabilize', el('div', {}, el('p', { class: 'note', text: `Following the camera through “${m.name || 'the clip'}” (${Math.round(t1 - t0)} s)…` }), bar),
    [{ label: 'Stop', onClick: x => { stopped = true; w.postMessage({ type: 'cancel' }); setTimeout(() => w.terminate(), 500); x(); } }]);
  try {
    const moves = await new Promise((resolve, reject) => {
      w.onmessage = e => {
        const msg = e.data;
        if (msg.type === 'progress') bar.firstChild.style.width = Math.round(msg.f * 100) + '%';
        else if (msg.type === 'done') resolve(msg.moves);
        else if (msg.type === 'error') reject(new Error(msg.message));
      };
      w.postMessage({ type: 'start', url: `app://reel/m/${app.token}/${encodeURIComponent(file)}`, t0, t1, rate });
    });
    w.terminate();
    if (stopped) return;
    const { cumulative } = await import('./lib/stabilize.js');
    const p = cumulative(moves);
    const r5 = a => a.map(v => Math.round(v * 1e5) / 1e5);
    app.commit(() => { c.stab = { rate, t0, x: r5(p.x), y: r5(p.y), r: r5(p.r), smooth: c.stab?.smooth ?? 1.5, strength: c.stab?.strength ?? 1, zoom: c.stab?.zoom || 0 }; });
    dlg.close();
    toast('Stabilized. Adjust Smoothness and Zoom on the right; play it to see.', 5000);
  } catch (e) {
    w.terminate(); dlg.close();
    if (!stopped) toast(`Couldn’t stabilize: ${e.message}`, 6000);
  }
}
