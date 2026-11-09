// Captions, speech from text and annotation clips: the Stage C commands.
import { el, modal, toast, slider, ask } from './ui.js';
import { kittenPanel } from './kitten.js';
import { uid, captionAt, parseCaptions, toSRT, toVTT, newDrawClip, newMediaClip, isFree, addTrack, CAPTION_STYLE } from './model.js';

// ------------------------------------------------------------------ captions
export function addCaption(app) {
  const doc = app.doc, t = app.player.time;
  doc.captions ||= [];
  const next = doc.captions.filter(c => c.t > t).sort((a, b) => a.t - b.t)[0];
  const cur = captionAt(doc, t);
  const start = cur ? cur.end : t;
  const end = Math.min(start + 2.5, next ? next.t : Infinity);
  if (!(end > start + 0.2)) { toast('There’s no room for a caption here.'); return; }
  const cap = { id: uid('cap'), t: start, end, text: 'Caption' };
  app.commit(d => { d.captions ||= []; d.captions.push(cap); d.captions.sort((a, b) => a.t - b.t); });
  app.selectCaption(cap.id);
  setTimeout(() => app.focusInspector(), 30);
}
export async function importCaptions(app) {
  try {
    const text = await app.api.captionsOpen();
    if (text == null) return;
    const caps = parseCaptions(text);
    if (!caps.length) { toast('No captions found in that file.'); return; }
    app.commit(d => { d.captions = [...(d.captions || []), ...caps].sort((a, b) => a.t - b.t); });
    app.timeline.render();
    toast(`Imported ${caps.length} caption${caps.length > 1 ? 's' : ''}.`);
  } catch (e) { toast(e.message); }
}
export async function exportCaptions(app, kind = 'srt') {
  const caps = app.doc.captions || [];
  if (!caps.length) { toast('There are no captions yet. Add one at the playhead with ⌃⌘C, or import an SRT.'); return; }
  try { if (await app.api.captionsSave(kind === 'vtt' ? toVTT(caps) : toSRT(caps), app.doc.name, kind)) toast('Captions saved.'); } catch (e) { toast(e.message); }
}

/** Inspector panel for the selected caption, and the caption look for the whole project. */
export function captionPanel(app, insp, cap) {
  const doc = app.doc, root = insp.root;
  const sec = (title, ...kids) => el('div', { class: 'insp-section' }, el('span', { class: 'engr', text: title }), ...kids);
  const area = el('textarea', { class: 'big', value: cap.text, spellcheck: true });
  let started = false;
  area.addEventListener('input', () => { if (!started) { started = true; app.beginChange(); } cap.text = area.value.slice(0, 500); app.changed({ light: true, keepInspector: true }); });
  area.addEventListener('change', () => { started = false; app.endChange({ keepInspector: true }); });
  insp.textArea = area;
  const fmt = t => t.toFixed(2) + 's';
  root.append(sec('Caption', area,
    insp.sl('Starts', () => cap.t, v => { cap.t = Math.min(v, cap.end - 0.1); }, { min: 0, max: Math.max(1, cap.end), step: 0.01, fmt }),
    insp.sl('Ends', () => cap.end, v => { cap.end = Math.max(v, cap.t + 0.1); }, { min: cap.t + 0.1, max: cap.t + 20, step: 0.01, fmt }),
    el('p', { class: 'note', text: 'Drag captions in the caption lane; drag their edges to retime. Enter a new one at the playhead with ⌃⌘C.' }),
    el('div', { class: 'btn-row' },
      el('button', { class: 'tool', text: '+ Next caption', onclick: () => { app.seek(cap.end); addCaption(app); } }),
      el('button', { class: 'tool', text: 'Delete', onclick: () => app.cmd('delete') }))));
  root.append(captionStylePanel(app, insp));
  void doc;
}
export function captionStylePanel(app, insp) {
  const doc = app.doc;
  const cs = () => ({ ...CAPTION_STYLE, ...(doc.captionStyle || {}) });
  const set = fn => app.commit(d => { d.captionStyle = { ...cs() }; fn(d.captionStyle); });
  const s = cs();
  const check = (label, key) => { const c = el('input', { type: 'checkbox', checked: !!s[key] }); c.addEventListener('change', () => set(x => { x[key] = c.checked; })); return el('div', { class: 'row' }, el('label', { text: label }), c); };
  const color = (label, key) => { const c = el('input', { type: 'color', value: s[key] }); c.addEventListener('change', () => set(x => { x[key] = c.value; })); return el('div', { class: 'row' }, el('label', { text: label }), c); };
  const pos = el('select', {}, ...[['bottom', 'Bottom'], ['top', 'Top']].map(([v, t]) => el('option', { value: v, text: t, selected: s.pos === v })));
  pos.addEventListener('change', () => set(x => { x.pos = pos.value; }));
  const n = (doc.captions || []).length;
  return el('div', { class: 'insp-section' }, el('span', { class: 'engr', text: 'Captions' }),
    el('div', { class: 'cap-all' },
      el('span', { text: `${n} caption${n === 1 ? '' : 's'} in this video` }),
      el('button', { class: 'tool cap-del-all', text: '🗑 DELETE ALL CAPTIONS', title: 'Remove every caption (⌘Z brings them back)', onclick: () => deleteAllCaptions(app) })),
    el('span', { class: 'engr', text: 'Caption look' }),
    check('Burn into video', 'burn'),
    el('p', { class: 'note', text: 'Burned captions are part of the picture. Either way, Export can save an .srt beside the movie for YouTube.' }),
    slider('Size', s.size, { min: 20, max: 120, step: 1, fmt: v => v.toFixed(0), onCommit: v => set(x => { x.size = v; }) }),
    color('Text', 'color'), color('Background', 'bg'),
    slider('Background', s.bgOpacity, { min: 0, max: 1, step: 0.01, fmt: v => Math.round(v * 100) + '%', onCommit: v => set(x => { x.bgOpacity = v; }) }),
    el('div', { class: 'row' }, el('label', { text: 'Position' }), pos),
    el('div', { class: 'btn-row' },
      el('button', { class: 'tool', text: 'Import SRT / VTT', onclick: () => importCaptions(app) }),
      el('button', { class: 'tool', text: 'Export SRT', onclick: () => exportCaptions(app, 'srt') })));
}

/** Removes every caption, after asking (⌘Z brings them back). */
export async function deleteAllCaptions(app) {
  const n = (app.doc?.captions || []).length;
  if (!n) { toast('There are no captions to delete.'); return; }
  if (!(await ask('Delete all captions?', `All ${n} caption${n === 1 ? ' is' : 's are'} removed. ⌘Z brings them back.`, 'Delete all'))) return;
  app.selection.caption = null;
  app.commit(d => { d.captions = []; });
  toast(`Deleted ${n} caption${n === 1 ? '' : 's'}. ⌘Z brings them back.`, 3000);
}

// ------------------------------------------------------------------ annotations
export function addAnnotation(app) {
  const c = newDrawClip(null, app.player.time);
  app.commit(d => { c.track = isFree(d, d.tracks[0].id, c.start, c.duration) ? d.tracks[0].id : addTrack(d, 0).id; d.clips.push(c); });
  app.select([c.id], null);
  app.overlay.drawAnnotation(c);
}
export function annotationPanel(app, insp, c) {
  const d = c.draw;
  const color = el('input', { type: 'color', value: d.color });
  color.addEventListener('change', () => insp.edit(() => { d.color = color.value; }));
  insp.root.append(el('div', { class: 'insp-section' }, el('span', { class: 'engr', text: 'Annotation' }),
    el('p', { class: 'note', text: `${d.strokes.length} stroke${d.strokes.length === 1 ? '' : 's'}. New strokes use the colour and width below.` }),
    el('div', { class: 'row' }, el('label', { text: 'Pen colour' }), color),
    insp.sl('Pen width', () => d.width, v => { d.width = v; }, { min: 2, max: 40, step: 1, fmt: v => v.toFixed(0) }),
    insp.sl('Draw on', () => d.drawOn, v => { d.drawOn = v; }, { min: 0, max: 4, step: 0.05, fmt: v => (v <= 0 ? 'Instant' : v.toFixed(2) + 's') }),
    insp.sl('Glow', () => d.glow || 0, v => { d.glow = v; }, { min: 0, max: 30, step: 1, fmt: v => v.toFixed(0) }),
    el('div', { class: 'btn-row' },
      el('button', { class: 'tool on-amber', text: 'Draw', onclick: () => app.overlay.drawAnnotation(c) }),
      el('button', { class: 'tool', text: 'Undo stroke', onclick: () => insp.edit(() => { d.strokes.pop(); }) }),
      el('button', { class: 'tool', text: 'Recolour all', onclick: () => insp.edit(() => { for (const s of d.strokes) { s.color = d.color; s.width = d.width; } }) }),
      el('button', { class: 'tool', text: 'Clear', onclick: () => insp.edit(() => { d.strokes = []; }) }))));
}

// ------------------------------------------------------------------ speech from text
// Two engines: the Mac's own voices (instant, nothing to install), or Kitten voices (natural, emotion, cloning).
export async function openSpeech(app) {
  const voices = await app.api.ttsVoices().catch(() => []);
  const area = el('textarea', { class: 'big', placeholder: 'Type what the voice should say…', style: { minHeight: '120px' } });
  const pick = el('select', {}, el('option', { value: '', text: 'System voice' }), ...voices.filter(v => /^en/.test(v.lang)).concat(voices.filter(v => !/^en/.test(v.lang)))
    .map(v => el('option', { value: v.name, text: `${v.name} · ${v.lang}` })));
  try { pick.value = localStorage.getItem('reel.ttsVoice') || ''; } catch { /* default */ }
  let rate = 180;
  const rateRow = slider('Speed', rate, { min: 90, max: 320, step: 5, fmt: v => v.toFixed(0) + ' wpm', onInput: v => { rate = v; } });
  const note = el('p', { class: 'note', text: voices.length ? 'Uses the voices built into macOS, offline. Download more (including Premium and Enhanced voices) in System Settings › Accessibility › Spoken Content.' : 'macOS voices aren’t available here.' });
  const macPanel = el('div', {}, el('div', { class: 'row' }, el('label', { text: 'Voice' }), pick), rateRow, note);
  const kit = kittenPanel(app);
  let engine = 'mac'; try { engine = localStorage.getItem('reel.ttsEngine') === 'kitten' ? 'kitten' : 'mac'; } catch { /* default */ }
  const seg = el('div', { class: 'seg tts-engine' });
  const setEngine = v => {
    engine = v; try { localStorage.setItem('reel.ttsEngine', v); } catch { /* fine */ }
    for (const b of seg.children) b.classList.toggle('on', b.dataset.v === v);
    macPanel.style.display = v === 'mac' ? '' : 'none'; kit.root.style.display = v === 'kitten' ? '' : 'none';
  };
  for (const [v, t] of [['mac', 'Mac voices'], ['kitten', 'Kitten voices (natural)']]) seg.append(el('button', { 'data-v': v, text: t, onclick: () => setEngine(v) }));
  setEngine(engine);
  modal('Speech from text', el('div', {}, seg, area, macPanel, kit.root), [
    { label: 'Cancel', onClick: c => c() },
    { label: 'Add at playhead', cls: 'hw amber', onClick: async (close, btn) => {
      if (!area.value.trim()) { toast('Type something to say.'); return; }
      if (engine === 'kitten' && !kit.ready()) { toast('Set up the Kitten voices first (GET KITTEN VOICES), or pick Mac voices.'); return; }
      btn.disabled = true; btn.textContent = 'SPEAKING…';
      try {
        let r;
        if (engine === 'kitten') r = await kit.make(area.value);
        else {
          try { localStorage.setItem('reel.ttsVoice', pick.value); } catch { /* fine */ }
          r = await app.api.ttsMake(app.token, area.value, pick.value, rate);
        }
        if (!r) { btn.disabled = false; btn.textContent = 'ADD AT PLAYHEAD'; return; }
        let id;
        app.commit(d => {
          const m = { id: uid('m'), ...r };
          d.media.push(m);
          const c = newMediaClip(d, m, null, app.player.time);
          c.audio.voice = true;
          c.track = [...d.tracks].reverse().find(tr => isFree(d, tr.id, c.start, c.duration))?.id || addTrack(d).id;
          d.clips.push(c); id = c.id;
        });
        app.select([id], null);
        app.timeline?.reveal?.([id]);
        close();
        toast('Speech added. It’s marked as voice, so music marked “duck under voice” dips under it.');
      } catch (e) { toast(String(e.message || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''), 8000); btn.disabled = false; btn.textContent = 'ADD AT PLAYHEAD'; }
    } },
  ], { wide: true });
  setTimeout(() => area.focus(), 50);
}
