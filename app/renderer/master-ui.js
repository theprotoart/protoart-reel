// Master settings: Reel's built-in console-style mastering chain, the user's own plug-ins on the
// master (e.g. Abbey Road TG Mastering Chain, Ozone), and a loudness target for the export.
import { el, modal, toast, selectRow, checkRow } from './ui.js';
import { defaultMaster, MASTER_PRESETS, TONE_FREQS, PRESENCE_FREQS, HP_FREQS, LP_FREQS } from './lib/master.js';
import { pickPlugin } from './fx.js';
import { uid, fmtTime, duration } from './model.js';

export const LOUDNESS = [['off', 'Off (no loudness change)'], ['youtube', 'YouTube · −14 LUFS'], ['spotify', 'Spotify / TikTok · −14 LUFS'], ['apple', 'Apple Music · −16 LUFS'], ['podcast', 'Podcast · −16 LUFS'], ['broadcast', 'Broadcast (EBU R128) · −23 LUFS']];

export function masterOf(doc) {
  if (!doc.master) doc.master = defaultMaster();
  const d = defaultMaster();
  for (const k of Object.keys(d)) if (doc.master[k] === undefined) doc.master[k] = d[k];
  doc.master.plugins ||= [];
  return doc.master;
}

const fmtHz = f => (f >= 1000 ? (f / 1000).toFixed(f % 1000 ? 2 : 0).replace(/\.?0+$/, '') + 'k' : String(f));

export function openMaster(app) {
  const doc = app.doc;
  const m = masterOf(doc);
  const body = el('div', { class: 'master' });
  const change = (fn) => { app.commit(() => fn(m), { quiet: true }); };
  const num = (label, get, set, { min, max, step, fmt }) => {
    const v = el('span', { class: 'val', text: fmt(get()) });
    const r = el('input', { type: 'range', min, max, step, value: get() });
    r.addEventListener('input', () => { v.textContent = fmt(Number(r.value)); });
    r.addEventListener('change', () => change(() => set(Number(r.value))));
    r.addEventListener('dblclick', () => { r.value = 0; v.textContent = fmt(0); change(() => set(0)); });
    return el('div', { class: 'row' }, el('label', { text: label }), r, v);
  };
  const db = v => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
  const draw = () => {
    body.replaceChildren(
      el('div', { class: 'master-top' },
        checkRow('Master on', m.on, v => { change(() => { m.on = v; }); draw(); }),
        selectRow('Preset', '', [['', 'Choose…'], ...Object.keys(MASTER_PRESETS).map(k => [k, k])], v => { if (!v) return; change(() => { const fresh = defaultMaster(); Object.assign(m, fresh, { plugins: m.plugins, on: true }); MASTER_PRESETS[v](m); }); draw(); }),
        selectRow('Loudness', m.loudness, LOUDNESS, v => change(() => { m.loudness = v; })),
        num('Ceiling', () => m.ceiling, v => { m.ceiling = v; }, { min: -3, max: -0.1, step: 0.1, fmt: v => v.toFixed(1) + ' dBTP' })),
      el('div', { class: 'modules' },
        module('Input', null, [
          num('Gain', () => m.input.gain, v => { m.input.gain = v; }, { min: -24, max: 24, step: 0.1, fmt: db }),
          selectRow('Tape EQ', m.input.tape, [['flat', 'Flat'], ['nab-iec-75', 'NAB→IEC 7.5'], ['nab-iec-15', 'NAB→IEC 15'], ['iec-nab-15', 'IEC→NAB 15'], ['iec-nab-75', 'IEC→NAB 7.5']], v => change(() => { m.input.tape = v; })),
          num('Balance', () => m.input.balance, v => { m.input.balance = v; }, { min: -5, max: 5, step: 0.05, fmt: db }),
          checkRow('Flip L', m.input.polarityL, v => change(() => { m.input.polarityL = v; })),
          checkRow('Flip R', m.input.polarityR, v => change(() => { m.input.polarityR = v; })),
          checkRow('Swap L/R', m.input.swap, v => change(() => { m.input.swap = v; })),
        ]),
        module('Tone', m.tone, m.tone.bands.flatMap((b, i) => [
          el('div', { class: 'band-head' }, `Band ${i + 1}`, el('input', { type: 'checkbox', checked: b.on, onchange: e => change(() => { b.on = e.target.checked; }) })),
          selectRow('Frequency', b.f, TONE_FREQS[i].map((f, j) => [j, fmtHz(f) + ' Hz']), v => change(() => { b.f = Number(v); })),
          selectRow('Shape', b.shape, [['low', 'Low shelf'], ['blunt', 'Blunt (wide)'], ['medium', 'Medium'], ['sharp', 'Sharp'], ['high', 'High shelf']], v => change(() => { b.shape = v; })),
          num('Gain', () => b.gain, v => { b.gain = v; }, { min: -10, max: 10, step: 0.05, fmt: db }),
        ])),
        module('Compressor', m.comp, [
          selectRow('Type', m.comp.type, [['modern', 'Modern (clean, loud)'], ['original', 'Original (Zener, colourful)'], ['limit', 'Limit (hard knee)']], v => change(() => { m.comp.type = v; })),
          selectRow('Recovery', m.comp.recovery, [1, 2, 3, 4, 5, 6].map(n => [n, String(n)]), v => change(() => { m.comp.recovery = Number(v); })),
          num('Ratio', () => m.comp.ratio, v => { m.comp.ratio = v; }, { min: 1, max: 100, step: 1, fmt: v => v.toFixed(0) }),
          num('Make-up', () => m.comp.makeup, v => { m.comp.makeup = v; }, { min: -12, max: 12, step: 0.1, fmt: db }),
          num('Mix', () => m.comp.mix, v => { m.comp.mix = v; }, { min: 0, max: 1, step: 0.01, fmt: v => Math.round(v * 100) + '%' }),
          selectRow('Sidechain HP', m.comp.scHp, [[0, 'Off'], [60, '60 Hz'], [100, '100 Hz'], [150, '150 Hz'], [200, '200 Hz']], v => change(() => { m.comp.scHp = Number(v); })),
        ]),
        module('Filters', m.filter, [
          selectRow('High-pass', m.filter.hp, HP_FREQS.map((f, i) => [i, f ? f + ' Hz' : 'Off']), v => change(() => { m.filter.hp = Number(v); })),
          selectRow('Presence', m.filter.presenceF, PRESENCE_FREQS.map((f, i) => [i, fmtHz(f) + ' Hz']), v => change(() => { m.filter.presenceF = Number(v); })),
          num('Presence gain', () => m.filter.presence, v => { m.filter.presence = v; }, { min: -10, max: 10, step: 0.1, fmt: db }),
          selectRow('Low-pass', m.filter.lp, LP_FREQS.map((f, i) => [i, f ? fmtHz(f) + ' Hz' : 'Off']), v => change(() => { m.filter.lp = Number(v); })),
        ]),
        module('Output', null, [
          num('Spread', () => m.output.spread, v => { m.output.spread = v; }, { min: -5, max: 5, step: 0.1, fmt: db }),
          num('Output', () => m.output.gain, v => { m.output.gain = v; }, { min: -24, max: 12, step: 0.1, fmt: db }),
          selectRow('Order', m.order.join(','), [['tone,comp,filter', 'Tone → Comp → Filters'], ['comp,tone,filter', 'Comp → Tone → Filters'], ['filter,tone,comp', 'Filters → Tone → Comp'], ['tone,filter,comp', 'Tone → Filters → Comp']], v => change(() => { m.order = v.split(','); })),
        ]),
      ),
      pluginsBox(app, m, draw),
      el('p', { class: 'note', text: 'The master runs on the whole mix when you export. Loudness is measured after it (ITU-R BS.1770) and matched to the target, with a true-peak limiter at the ceiling.' }),
    );
  };
  draw();
  modal('Master', body, [
    { label: 'Listen 15 s', onClick: (c, btn) => previewMaster(app, btn) },
    { label: 'Done', cls: 'hw amber', onClick: c => c() },
  ], { wide: true });
}

function module(name, state, rows) {
  const head = el('div', { class: 'mod-head' }, el('span', { class: 'engr', text: name }));
  if (state) {
    const on = el('input', { type: 'checkbox', checked: state.on, title: 'On / off' });
    on.addEventListener('change', () => { state.on = on.checked; });
    head.append(on);
  }
  return el('div', { class: 'mod' }, head, ...rows);
}

function pluginsBox(app, m, redraw) {
  const box = el('div', { class: 'mod wide' }, el('div', { class: 'mod-head' }, el('span', { class: 'engr', text: 'Your plug-ins on the master' })));
  for (const it of m.plugins) {
    box.append(el('div', { class: 'fx-item' + (it.bypass ? ' off' : '') },
      el('button', { class: 'mini', text: it.bypass ? '○' : '●', onclick: () => { app.commit(() => { it.bypass = !it.bypass; }, { quiet: true }); redraw(); } }),
      el('span', { class: 'fx-name', text: `${it.name}${it.maker ? ' · ' + it.maker : ''}` }),
      el('button', { class: 'tool', text: 'EDIT', onclick: () => editMasterPlugin(app, it) }),
      el('button', { class: 'mini', text: '×', onclick: () => { app.commit(() => { m.plugins = m.plugins.filter(x => x !== it); }, { quiet: true }); redraw(); } })));
  }
  box.append(el('div', { class: 'btn-row' }, el('button', { class: 'tool', text: '+ PLUG-IN (e.g. Abbey Road TG Mastering)', onclick: async () => {
    const p = await pickPlugin(app);
    if (!p) return;
    const it = { id: uid('f'), kind: 'au', plugin: p.id, name: p.name, maker: p.maker, state: '' };
    app.commit(() => { m.plugins.push(it); }, { quiet: true });
    redraw();
    editMasterPlugin(app, it);
  } })));
  return box;
}

async function editMasterPlugin(app, it) {
  const slot = `m${it.id}`;
  app.fxEditing.set(slot, { master: true, item: it.id });
  try { await app.api.fxEdit(slot, it.plugin, it.state || '', `${it.name} — Master`); }
  catch (e) { app.fxEditing.delete(slot); toast(e.message, 6000); }
}

/** Mixes 15 s from the playhead through the master (built-in + plug-ins) and plays it. */
async function previewMaster(app, btn) {
  const doc = app.doc, m = masterOf(doc);
  const from = Math.min(app.player.time, Math.max(0, duration(doc) - 1)), to = Math.min(duration(doc), from + 15);
  btn.disabled = true;
  try {
    toast(`Mixing ${fmtTime(from)}–${fmtTime(to)} through the master…`);
    const mix = await mixToFile(app, { from, to, master: m });
    let file = mix;
    const chain = m.plugins.filter(p => !p.bypass).map(p => ({ kind: 'au', plugin: p.plugin, state: p.state || '' }));
    if (chain.length) file = await app.api.fxRenderFile(app.token, mix, chain);
    const a = new Audio(`app://reel/m/${app.token}/${encodeURIComponent(file)}`);
    app.player.pause();
    a.play();
    a.onended = () => { app.api.fxRemoveTemp(app.token, mix); if (file !== mix) app.api.fxRemoveTemp(app.token, file); };
  } catch (e) { toast(`Preview failed: ${e.message}`, 6000); }
  btn.disabled = false;
}

/** Runs the export worker's mix-only pass and uploads the result as a temporary WAV. */
export function mixToFile(app, { from, to, master, onProgress }) {
  return new Promise(async (resolve, reject) => {
    const up = await app.api.fxUpBegin(app.token, 'master', null, 2);
    const w = new Worker('export-worker.js', { type: 'module' });
    let chain = Promise.resolve();
    w.onmessage = e => {
      const msg = e.data;
      if (msg.type === 'mix') { chain = chain.then(() => app.api.fxChunk(up, msg.data)); onProgress && onProgress(msg.progress); }
      else if (msg.type === 'done') { w.terminate(); chain.then(() => app.api.fxUpEnd(up)).then(resolve, reject); }
      else if (msg.type === 'error') { w.terminate(); reject(new Error(msg.message)); }
    };
    w.postMessage({ type: 'start', doc: JSON.parse(JSON.stringify(app.doc)), token: app.token, opts: { mode: 'mix', kind: 'm4a', from, to, fps: 30, width: 2, height: 2, master } });
    w.cancelMix = () => w.postMessage({ type: 'cancel' });
    app._mixWorker = w;
  });
}
