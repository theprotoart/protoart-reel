// Bounce in place in the editor: renders the chosen clips (or a whole track) through their effects into a new WAV,
// puts it on a new track under the original at the same times, and mutes and greys out the originals.
// The model side (what is rendered, where it goes, how to undo it) is in lib/bounce.js.
import { el, modal, toast } from './ui.js';
import { uid, mediaById } from './model.js';
import { planBounce, bounceDoc, applyBounce, revertBounce } from './lib/bounce.js';
import { renderClip, captureOpenPlugins } from './fx.js';
import { renderPending } from './trackplugins.js';

const fmt = s => (s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);

/** Mixes one track's clips (the little project from bounceDoc) into a WAV in the project. Resolves to { file, seconds }. */
function renderGroup(app, g, name, onProgress, cancelBox) {
  return new Promise(async (resolve, reject) => {
    let up;
    try { up = await app.api.fxUpBegin(app.token, 'bounce', name, 2); } catch (e) { reject(e); return; }
    const w = new Worker('export-worker.js', { type: 'module' });
    cancelBox.cancel = () => { w.postMessage({ type: 'cancel' }); setTimeout(() => w.terminate(), 1500); reject(new Error('Cancelled')); };
    let chain = Promise.resolve(), frames = 0;
    w.onmessage = e => {
      const msg = e.data;
      if (msg.type === 'mix') { frames += msg.data.byteLength / 8; chain = chain.then(() => app.api.fxChunk(up, msg.data)); onProgress(msg.progress); }
      else if (msg.type === 'done') { w.terminate(); chain.then(() => app.api.fxUpEnd(up)).then(file => resolve({ file, seconds: frames / 48000 }), reject); }
      else if (msg.type === 'error') { w.terminate(); reject(new Error(msg.message)); }
    };
    w.postMessage({ type: 'start', doc: bounceDoc(app.doc, g), token: app.token, opts: { mode: 'mix', kind: 'm4a', from: g.from, to: g.to, fps: 30, width: 2, height: 2, master: null, stretchMax: 1200 } });
  });
}

/**
 * Bounce the given clips (default: the selected ones) to a new track. Asks nothing: it's undoable, the originals
 * stay, and "Back to the original sound" reverses it at any time.
 */
export async function bounceClips(app, ids = app.selection.clips) {
  const doc = app.doc; if (!doc) return;
  if (app._bouncing) { toast('A bounce is already running.'); return; }
  let groups = planBounce(doc, ids);
  if (!groups.length) {
    const already = doc.clips.some(c => ids.includes(c.id) && (c.bounced || c.bounceOf));
    toast(already ? 'Those clips are already rendered: their rendered copies are on the “· rendered” track. Right-click › Back to the original sound to undo it.' : 'Select one or more clips with sound first (or right-click a track › Bounce track).', 6000);
    return;
  }
  app._bouncing = true;
  const n = groups.reduce((k, g) => k + g.clips.length, 0);
  const what = el('p', { class: 'note' }), bar = el('div', { class: 'fxr-meter' }, el('div', { class: 'fxr-bar' }, el('i')), el('span', { class: 'fxr-pct', text: '0%' }));
  const set = (text, f) => { what.textContent = text; const v = Math.round(f * 100); bar.querySelector('i').style.width = v + '%'; bar.querySelector('.fxr-pct').textContent = v + '%'; };
  const cancelBox = { cancel: null }; let stopped = false;
  const dlg = modal('Bounce to a new track', el('div', {},
    el('p', { text: `Rendering ${n} clip${n === 1 ? '' : 's'} through ${groups.length === 1 ? 'the track’s' : 'their tracks’'} effects and plug-ins into new audio. The originals stay, muted and greyed out.` }),
    what, bar), [{ label: 'Stop', onClick: c => { stopped = true; cancelBox.cancel?.(); c(); } }]);
  const t0 = performance.now();
  try {
    // 1 · everything the clips need rendered first: settings in open plug-in windows, track plug-ins, clip effects
    set('Getting your plug-ins ready…', 0);
    await captureOpenPlugins(app);
    for (const g of groups) {
      if (stopped) throw new Error('Cancelled');
      await renderPending(app, { trackId: g.track.id, onStatus: (t, v) => set(t, v * 0.3) });
      for (const c of g.clips) {
        const cur = app.doc.clips.find(x => x.id === c.id);
        if (cur?.fx?.chain?.length && (cur.fx.dirty || !cur.fx.file) && !cur.fx.bypass) { set(`Rendering the effects on “${cur.name || mediaById(app.doc, cur.media)?.name || 'clip'}”…`, 0.3); await renderClip(app, cur, f => set(`Rendering clip effects… ${Math.round(f * 100)}%`, 0.3)); }
      }
    }
    groups = planBounce(app.doc, ids); // fresh, after those renders
    // 2 · mix each track's clips into its new WAV, and put it in the project
    const made = [];
    for (const [k, g] of groups.entries()) {
      if (stopped) throw new Error('Cancelled');
      const name = `${g.track.name || 'Track'} rendered`;
      const span = g.to - g.from;
      const r = await renderGroup(app, g, name, f => set(`Bouncing “${g.track.name || 'track'}”: ${fmt(f * span)} of ${fmt(span)}`, 0.35 + 0.65 * (k + f) / groups.length), cancelBox);
      made.push({ g, r, name });
    }
    if (stopped) throw new Error('Cancelled');
    let out = [];
    app.commit(d => { for (const { g, r, name } of made) out.push(applyBounce(d, g, { file: r.file, name, seconds: r.seconds }, p => uid(p))); });
    set('Done', 1);
    dlg.close();
    const newIds = out.flatMap(o => o.clipIds);
    app.select(newIds, null);
    toast(`Bounced ${n} clip${n === 1 ? '' : 's'} to ${out.length === 1 ? 'a new track' : `${out.length} new tracks`} in ${fmt((performance.now() - t0) / 1000)}. The originals are muted and greyed out above. ⌘Z or right-click › Back to the original sound undoes it.`, 7000);
  } catch (e) {
    dlg.close();
    if (!/Cancelled/.test(e.message)) toast(`Couldn’t bounce: ${e.message}`, 7000);
    else toast('Bounce stopped. Nothing was changed.');
  } finally { app._bouncing = false; }
}

/** A whole track: every clip with sound on it. */
export function bounceTrack(app, tr) {
  const ids = app.doc.clips.filter(c => c.track === tr.id).map(c => c.id);
  return bounceClips(app, ids);
}

/** Undo a bounce for these clips (originals or rendered copies), at any time. */
export function revertClips(app, ids = app.selection.clips) {
  let n = 0;
  app.commit(d => { n = revertBounce(d, ids); });
  toast(n ? `${n} clip${n === 1 ? '' : 's'} back to the original sound; the rendered cop${n === 1 ? 'y is' : 'ies are'} gone (the WAV stays in the project folder).` : 'Nothing to put back.', 5000);
}
