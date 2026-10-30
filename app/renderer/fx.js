// Clip audio effects in the editor: the built-in Voice Clean / DeReverb tools and the user's own
// Audio Unit plug-ins (CEDAR, Waves Clarity, iZotope…), rendered to a new file per clip.
import { el, modal, toast } from './ui.js';
import { mediaById, uid } from './model.js';

export const VOICE_PRESETS = {
  'Voice Clean': { clean: 1, process: 1, reflections: 0.3, gateMix: 0, dereverb: 0 },
  'Gentle clean': { clean: 0.6, process: 0.8, reflections: 0.5, gateMix: 0, dereverb: 0 },
  'Noisy room': { clean: 1, process: 1, reflections: 0.2, gateMix: 0.6, gateThreshold: 0.3, dereverb: 0.3, strength: 1.2, room: 0.6 },
  'DeReverb': { clean: 0, dereverb: 0.8, strength: 1.5, room: 0.8, tail: 0.2, presence: 0.4 },
  'Echoey room': { clean: 0.5, process: 1, dereverb: 1, strength: 2, room: 1.2, tail: 0.1, presence: 0.6 },
  'Phone / Zoom call': { clean: 1, process: 1, reflections: 0.2, gateMix: 0.4, dereverb: 0.4, strength: 1.2, room: 0.5, presence: 0.3 },
};
const BAND_NAMES = ['100', '250', '600', '1.5k', '4k', '10k'];
// plug-ins worth showing first in the picker
const FAVOURITE = /CEDAR|Clarity|Dns One|VoicEX|ScreenVox|StageVox|Dialogue|De-noise|De-?reverb|TG Mastering|Ozone|Pro-Q|Pro-L|Soothe|Supertone/i;

let available = null;
export async function fxAvailable(app) { return (available ||= await app.api.fxAvailable().catch(() => ({ plugins: false, voice: false }))); }

/** Decodes the clip's media sound to the 48 kHz float file effects start from (once per file). */
export async function ensureSource(app, m, onProgress) {
  const have = await app.api.fxSource(app.token, m.file);
  if (have) return have;
  return new Promise((resolve, reject) => {
    const w = new Worker('fx-src-worker.js', { type: 'module' });
    let id = null, chain = Promise.resolve();
    w.onmessage = e => {
      const msg = e.data;
      if (msg.type === 'begin') chain = chain.then(async () => { id = await app.api.fxUpBegin(app.token, 'source', m.file, msg.channels); });
      else if (msg.type === 'chunk') { chain = chain.then(() => app.api.fxChunk(id, msg.data)); onProgress && onProgress(msg.progress * 0.3); }
      else if (msg.type === 'end') { chain.then(() => app.api.fxUpEnd(id)).then(resolve, reject); w.terminate(); }
      else if (msg.type === 'error') { w.terminate(); reject(new Error(msg.message)); }
    };
    w.postMessage({ url: `app://reel/m/${app.token}/${encodeURIComponent(m.file)}`, file: m.file });
  });
}

/** Renders a clip's chain; the clip then plays and exports the new file. */
export async function renderClip(app, c, onProgress) {
  const m = mediaById(app.doc, c.media);
  if (!m) throw new Error('Media is missing');
  const source = await ensureSource(app, m, onProgress);
  const tag = `${c.id}-${Date.now().toString(36)}`;
  const listener = p => { if (p.tag === tag && onProgress) onProgress(0.3 + p.f * 0.7); };
  app.fxListeners.add(listener);
  try {
    const chain = c.fx.chain.map(it => (it.kind === 'reel' ? { kind: 'reel', params: it.params, bypass: !!it.bypass } : { kind: 'au', plugin: it.plugin, state: it.state || '', bypass: !!it.bypass }));
    const r = await app.api.fxRender(app.token, { source, chain, tag });
    app.commit(() => { c.fx.file = r.file; c.fx.dirty = false; });
    return r;
  } finally { app.fxListeners.delete(listener); }
}

export function pickPlugin(app) {
  return new Promise(async resolve => {
    let list = [];
    try { list = await app.api.fxPlugins(); } catch (e) { toast(e.message, 5000); return resolve(null); }
    const search = el('input', { type: 'text', placeholder: `Search ${list.length} plug-ins…`, style: { width: '100%' } });
    const box = el('div', { class: 'plug-list' });
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const hits = list.filter(p => !q || `${p.maker} ${p.name}`.toLowerCase().includes(q));
      hits.sort((a, b) => (FAVOURITE.test(b.name + b.maker) - FAVOURITE.test(a.name + a.maker)) || a.maker.localeCompare(b.maker));
      box.replaceChildren(...hits.slice(0, 300).map(p => el('div', { class: 'plug-item', onclick: () => { resolve(p); dlg.close(); } }, // pick first: closing counts as cancel
        el('b', { text: p.name }), el('span', { text: `${p.maker}${p.version ? ' · ' + p.version : ''}` }))));
    };
    search.addEventListener('input', draw);
    // VST3 plug-ins with no Audio Unit version (Reel runs Audio Units; most makers install both)
    const vstNote = el('p', { class: 'note plug-vst' });
    (async () => {
      try {
        const vst = await app.api.fxVst3?.() || [];
        const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
        const au = new Set(list.map(p => norm(p.name)));
        const only = vst.filter(v => ![...au].some(a => a.includes(norm(v)) || norm(v).includes(a)));
        if (only.length) vstNote.textContent = `Installed only as VST3 (Reel can’t load these yet; if the maker offers an Audio Unit version, install that): ${only.slice(0, 30).join(', ')}${only.length > 30 ? ` and ${only.length - 30} more` : ''}.`;
      } catch { /* fine */ }
    })();
    const dlg = modal('Add a plug-in', el('div', {}, el('p', { class: 'note', text: `Your installed Audio Unit effects (${list.length}): Waves, iZotope, FabFilter, CEDAR and the rest. Your VST3 plug-ins are here too when the maker installed the Audio Unit version alongside, as most do. Voice tools are listed first. Some need their licence app (iLok License Manager, Waves Central) running.` }), search, box, vstNote), [], { onClose: () => resolve(null) });
    draw();
    setTimeout(() => search.focus(), 50);
  });
}

/** Picks an installed plug-in, adds it to the clip's effects and opens its window. */
export async function addPluginToClip(app, c) {
  const p = await pickPlugin(app);
  if (!p) return null;
  const item = { id: uid('f'), kind: 'au', plugin: p.id, name: p.name, maker: p.maker, state: '' };
  app.commit(() => { c.fx ||= { chain: [], file: null, dirty: true, bypass: false }; c.fx.chain.push(item); c.fx.dirty = true; });
  editPlugin(app, c, item);
  return item;
}

/** Opens a plug-in's own window; when it closes, its settings are saved into the clip. */
export async function editPlugin(app, c, item) {
  const slot = `s${item.id}`;
  app.fxEditing.set(slot, { clip: c.id, item: item.id });
  try { await app.api.fxEdit(slot, item.plugin, item.state || '', `${item.name} — ${c.name || 'clip'}`); }
  catch (e) { app.fxEditing.delete(slot); toast(e.message, 6000); }
}

/** Called by the app when a plug-in window closes. */
export function pluginEdited(app, { slot, state }) {
  const e = app.fxEditing.get(slot);
  if (!e) return;
  app.fxEditing.delete(slot);
  if (e.master) {
    const it = (app.doc.master && app.doc.master.plugins || []).find(x => x.id === e.item);
    if (it && it.state !== state) { app.commit(() => { it.state = state; }, { quiet: true }); toast(`${it.name} settings saved for the master.`); }
    return;
  }
  if (e.track) {
    const tr = app.doc.tracks.find(t => t.id === e.track), f = tr && (tr.fx || []).find(x => x.id === e.item);
    if (f && f.state !== state) { app.commit(() => { f.state = state; }, { keepInspector: true }); toast(`${f.name} settings saved: re-rendering the track’s clips.`); }
    return;
  }
  const c = app.doc.clips.find(x => x.id === e.clip);
  const it = c && c.fx && c.fx.chain.find(x => x.id === e.item);
  if (!it || it.state === state) return;
  app.commit(() => { it.state = state; c.fx.dirty = true; });
  toast(`${it.name} settings saved. Press RENDER to apply.`);
}

export function newVoiceItem(preset = 'Voice Clean') {
  return { id: uid('f'), kind: 'reel', name: preset, params: { width: 1, gain: 0, bands: [1, 1, 1, 1, 1, 1], ...VOICE_PRESETS[preset] } };
}

/** The Effects section of the inspector for an audio clip. */
export function effectsSection(app, c, insp) {
  const m = mediaById(app.doc, c.media);
  c.fx ||= null;
  const sec = el('div', { class: 'insp-section' }, el('span', { class: 'engr', text: 'Effects' }));
  const fx = c.fx;
  if (!fx || !fx.chain.length) sec.append(el('p', { class: 'note', text: 'Clean up voices with Reel’s built-in tools, or run your own plug-ins (CEDAR, Waves Clarity…) on this clip.' }));
  if (fx) {
    for (const it of fx.chain) {
      const row = el('div', { class: 'fx-item' + (it.bypass ? ' off' : '') },
        el('button', { class: 'mini', text: it.bypass ? '○' : '●', title: it.bypass ? 'Turn on' : 'Bypass', onclick: () => app.commit(() => { it.bypass = !it.bypass; fx.dirty = true; }) }),
        el('span', { class: 'fx-name', text: it.name }),
        it.kind === 'au' ? el('button', { class: 'tool', text: 'EDIT', onclick: () => editPlugin(app, c, it) }) : null,
        el('button', { class: 'mini', text: '×', title: 'Remove', onclick: () => app.commit(() => { fx.chain = fx.chain.filter(x => x !== it); fx.dirty = true; }) }));
      sec.append(row);
      if (it.kind === 'reel') sec.append(voiceControls(app, c, it, insp));
    }
  }
  const addVoice = el('select', {}, el('option', { text: '+ Built-in…', value: '' }), ...Object.keys(VOICE_PRESETS).map(k => el('option', { value: k, text: k })));
  addVoice.addEventListener('change', () => {
    if (!addVoice.value) return;
    const item = newVoiceItem(addVoice.value);
    app.commit(() => { c.fx ||= { chain: [], file: null, dirty: true, bypass: false }; c.fx.chain.push(item); c.fx.dirty = true; });
  });
  const addPlug = el('button', { class: 'tool', text: '+ PLUG-IN', onclick: async () => {
    const p = await pickPlugin(app);
    if (!p) return;
    const item = { id: uid('f'), kind: 'au', plugin: p.id, name: p.name, maker: p.maker, state: '' };
    app.commit(() => { c.fx ||= { chain: [], file: null, dirty: true, bypass: false }; c.fx.chain.push(item); c.fx.dirty = true; });
    editPlugin(app, c, item);
  } });
  sec.append(el('div', { class: 'btn-row' }, addVoice, addPlug));
  if (fx && fx.chain.length) {
    const prog = el('div', { class: 'progress hidden' }, el('i'));
    const render = el('button', { class: 'hw' + (fx.dirty || !fx.file ? ' amber' : ''), text: fx.dirty || !fx.file ? 'RENDER EFFECTS' : 'RENDERED ✓', onclick: async () => {
      render.disabled = true; prog.classList.remove('hidden');
      try { await renderClip(app, c, f => { prog.firstChild.style.width = Math.round(f * 100) + '%'; }); toast('Effects rendered.'); }
      catch (e) { toast(`Couldn’t render: ${e.message}`, 7000); }
      render.disabled = false; prog.classList.add('hidden'); insp.render();
    } });
    const listenBtn = el('button', { class: 'tool', text: 'LISTEN', title: 'Hear 12 s from the playhead with these effects', onclick: () => listen(app, c, m) });
    const ab = el('button', { class: 'tool' + (fx.bypass ? '' : ' on-amber'), text: fx.bypass ? 'A: ORIGINAL' : 'B: EFFECTS', title: 'Switch the clip between its original and processed sound', onclick: () => app.commit(() => { fx.bypass = !fx.bypass; }) });
    sec.append(el('div', { class: 'btn-row' }, render, listenBtn, fx.file ? ab : null), prog);
  }
  return sec;
}

function voiceControls(app, c, it, insp) {
  const p = it.params;
  const box = el('div', { class: 'fx-voice' });
  const sl = (label, key, opts) => insp.sl(label, () => p[key] ?? opts.dflt ?? 0, v => { p[key] = v; c.fx.dirty = true; }, opts);
  box.append(
    sl('Voice clean', 'clean', { min: 0, max: 1, step: 0.01, fmt: v => Math.round(v * 100) + '%' }),
    sl('Reflections', 'reflections', { min: 0, max: 1, step: 0.01, fmt: v => Math.round(v * 100) + '%' }),
    sl('Ambience gate', 'gateMix', { min: 0, max: 1, step: 0.01, fmt: v => Math.round(v * 100) + '%' }),
    sl('DeReverb', 'dereverb', { min: 0, max: 1, step: 0.01, fmt: v => Math.round(v * 100) + '%' }),
    sl('Strength', 'strength', { min: 0.5, max: 3, step: 0.05, dflt: 1.5, fmt: v => v.toFixed(2) + '×' }),
    sl('Room size', 'room', { min: 0.2, max: 2.5, step: 0.05, dflt: 0.8, fmt: v => v.toFixed(2) + 's' }),
    sl('Tail', 'tail', { min: 0, max: 1, step: 0.01, dflt: 0.3, fmt: v => Math.round(v * 100) + '%' }),
    sl('Presence', 'presence', { min: 0, max: 1, step: 0.01, fmt: v => Math.round(v * 100) + '%' }),
    sl('Output', 'gain', { min: -12, max: 12, step: 0.1, fmt: v => v.toFixed(1) + ' dB' }),
  );
  const bands = el('div', { class: 'fx-bands', title: 'How much processing each frequency range gets' });
  p.bands ||= [1, 1, 1, 1, 1, 1];
  p.bands.forEach((v, i) => {
    const s = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: v, class: 'vslider' });
    s.addEventListener('change', () => app.commit(() => { p.bands[i] = Number(s.value); c.fx.dirty = true; }, { quiet: true }));
    bands.append(el('div', { class: 'band' }, s, el('span', { text: BAND_NAMES[i] })));
  });
  box.append(el('div', { class: 'row' }, el('label', { text: 'Per band' }), bands));
  return box;
}

/** Plays 12 s from the playhead through the effects (built-in: rendered preview; plug-ins: live). */
async function listen(app, c, m) {
  const st = Math.max(0, (c.in || 0) + (app.player.time - c.start) * (c.speed || 1));
  try {
    toast('Preparing a preview…');
    const source = await ensureSource(app, m);
    const reel = c.fx.chain.filter(x => x.kind === 'reel' && !x.bypass);
    const plugs = c.fx.chain.filter(x => x.kind === 'au' && !x.bypass);
    if (plugs.length && !reel.length) {
      // live through the open plug-in windows (open them first so their settings apply)
      for (const it of plugs) if (![...app.fxEditing.values()].some(e => e.item === it.id)) await editPlugin(app, c, it);
      await app.api.fxPreviewPlugins(app.token, source, plugs.map(it => `s${it.id}`), st);
      toast('Playing through your plug-ins. Tweak them while it plays.', 5000);
      return;
    }
    const name = await app.api.fxPreviewVoice(app.token, source, reel[0] ? reel[0].params : {}, st, 12);
    const a = new Audio(`app://reel/m/${app.token}/${encodeURIComponent(name)}`);
    app.player.pause();
    a.play();
    toast('Playing 12 s with Voice tools. Plug-ins aren’t included in this preview; press Render to hear everything.', 5000);
  } catch (e) { toast(`Preview failed: ${e.message}`, 6000); }
}
