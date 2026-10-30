// Clip operations from ScreenFlow's Edit / Insert menus, adapted to Reel: freeze frame, play in reverse,
// detach audio, lock, group, trim to the playhead, in/out points, copy and paste style or properties,
// save frame, delete unused media.
import { el, modal, toast, ask, promptText } from './ui.js';
import {
  uid, mediaById, clipEnd, sourceTime, propsAt, animated, ANIMATABLE, newMediaClip, insertTime, trim,
  freeTrack, isFree, withGroups, addTrack, closeGap, closeAllGaps, removeRange,
} from './model.js';

const FREEZE_SECONDS = 2;

/** The clip a command acts on: the selected one under the playhead, or the top visible clip there. */
function clipAtPlayhead(app, filter = () => true) {
  const doc = app.doc, t = app.player.time;
  const inside = c => t >= c.start && t < clipEnd(c) && filter(c);
  const sel = app.selection.clips.map(id => doc.clips.find(c => c.id === id)).filter(Boolean).find(inside);
  if (sel) return sel;
  for (const tr of doc.tracks) { const c = doc.clips.find(x => x.track === tr.id && inside(x)); if (c) return c; }
  return null;
}
const selected = app => app.selection.clips.map(id => app.doc.clips.find(c => c.id === id)).filter(Boolean);

/** The clip's own source picture at timeline time t, full resolution, as PNG bytes. */
async function sourceStill(app, c, t) {
  const m = mediaById(app.doc, c.media);
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.src = app.player.urlFor(m);
  await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('Couldn’t read the video')); setTimeout(res, 4000); });
  v.currentTime = Math.min(sourceTime(c, t), Math.max(0, (v.duration || 1e9) - 0.001));
  await new Promise(res => { v.onseeked = res; setTimeout(res, 3000); });
  const cv = el('canvas', { width: v.videoWidth || m.width || 1920, height: v.videoHeight || m.height || 1080 });
  cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
  v.removeAttribute('src'); v.load();
  return new Uint8Array(await (await new Promise(r => cv.toBlob(r, 'image/png'))).arrayBuffer());
}

// ------------------------------------------------------------------ freeze frame
export async function freezeFrame(app) {
  const doc = app.doc, t = app.player.time;
  const c = clipAtPlayhead(app, x => x.type === 'media' && mediaById(doc, x.media)?.kind === 'video' && !x.audioOnly);
  if (!c) { toast('Put the playhead over a video clip.'); return; }
  const m = mediaById(doc, c.media);
  try {
    const png = await sourceStill(app, c, t);
    const r = await app.api.saveStill(app.token, png, `${m.name} freeze`);
    let id;
    app.commit(d => {
      const still = { id: uid('m'), ...r };
      d.media.push(still);
      const local = t - c.start;
      const state = propsAt({ ...animated(c, local), transIn: null, transOut: null }, local);
      // open a gap on every track so sound stays in sync, then put the still in it
      insertTime(d, t, FREEZE_SECONDS);
      const f = newMediaClip(d, still, c.track, t);
      f.duration = FREEZE_SECONDS;
      f.props = { ...c.props, crop: [...(c.props.crop || [0, 0, 0, 0])] };
      for (const k of ANIMATABLE) if (k !== 'crop') f.props[k] = state[k];
      f.name = `Freeze ${m.name}`;
      if (!isFree(d, f.track, f.start, f.duration)) f.track = freeTrack(d, f.start, f.duration, c.track);
      d.clips.push(f);
      id = f.id;
    });
    app.select([id], null);
    toast(`Freeze frame added (${FREEZE_SECONDS} s). Trim its right edge to change how long it holds.`);
  } catch (e) { toast(e.message); }
}

// ------------------------------------------------------------------ play in reverse
export async function toggleReverse(app, c) {
  const doc = app.doc;
  c ||= selected(app).find(x => x.type === 'media') || clipAtPlayhead(app, x => x.type === 'media');
  if (!c || c.type !== 'media') { toast('Select a video or audio clip.'); return; }
  if (c.locked) { toast('Unlock the clip first.'); return; }
  if (c.reversed) { // back to forwards
    app.commit(() => { c.media = c.reversed.media; c.in = c.reversed.in; delete c.reversed; });
    toast('Playing forwards again.');
    return;
  }
  const m = mediaById(doc, c.media);
  if (!m || m.kind === 'image') { toast('A still picture looks the same backwards.'); return; }
  const from = c.in || 0, to = from + c.duration * (c.speed || 1);
  const done = rm => app.commit(() => {
    c.reversed = { media: c.media, in: c.in || 0 };
    c.media = rm.id; c.in = 0;
  });
  const cached = doc.media.find(x => x.reverseOf && x.reverseOf.media === m.id && Math.abs(x.reverseOf.from - from) < 1e-3 && Math.abs(x.reverseOf.to - to) < 1e-3);
  if (cached) { done(cached); toast('Playing in reverse.'); return; }

  const bar = el('div', { class: 'progress' }, el('i'));
  const note = el('p', { class: 'note', text: `Making a reversed copy of ${(to - from).toFixed(1)} s of “${m.name}”. The original stays untouched; switch back any time.` });
  const worker = new Worker(new URL('./reverse-worker.js', import.meta.url), { type: 'module' });
  let rid = null, finished = false;
  const dlg = modal('Play in Reverse', el('div', {}, note, bar), [{ label: 'Cancel', onClick: close => close() }], {
    onClose: () => { if (!finished) { worker.postMessage({ type: 'cancel' }); worker.terminate(); if (rid) app.api.renderCancel(rid); } },
  });
  try {
    const begin = await app.api.renderBegin(app.token, `${m.name} reversed`, m.kind === 'audio' ? 'wav' : 'mp4');
    rid = begin.id;
    const res = await new Promise((resolve, reject) => {
      worker.onmessage = e => {
        const msg = e.data;
        if (msg.type === 'chunk') app.api.renderChunk(rid, msg.data);
        else if (msg.type === 'progress') bar.firstChild.style.width = Math.round(msg.value * 100) + '%';
        else if (msg.type === 'done') resolve(msg);
        else if (msg.type === 'error') reject(new Error(msg.message));
      };
      worker.onerror = e => reject(new Error(e.message || 'Reverse failed'));
      worker.postMessage({ type: 'start', url: app.player.urlFor(m), file: m.file, from, to });
    });
    const info = await app.api.renderFinish(rid, res.head);
    finished = true;
    worker.terminate();
    dlg.close();
    const rm = { id: uid('m'), ...info, name: `${m.name} (reversed)`, reverseOf: { media: m.id, from, to }, hidden: true };
    app.commit(d => { d.media.push(rm); });
    done(rm);
    toast('Playing in reverse.');
  } catch (e) {
    worker.terminate();
    if (!finished) { if (rid) app.api.renderCancel(rid); dlg.close(); }
    if (!/Cancelled/.test(e.message)) toast(e.message, 6000);
  }
}

// ------------------------------------------------------------------ detach audio
export function detachAudio(app) {
  const doc = app.doc;
  const list = selected(app).filter(c => c.type === 'media' && !c.audioOnly && mediaById(doc, c.media)?.kind === 'video' && mediaById(doc, c.media)?.hasAudio);
  if (!list.length) { toast('Select a video clip that has sound.'); return; }
  const made = [];
  app.commit(d => {
    for (const c of list) {
      const a = structuredClone(c);
      a.id = uid('c'); a.audioOnly = true; a.actions = []; a.name = `${c.name || mediaById(d, c.media).name} (audio)`;
      a.transIn = { type: 'none', dur: 0.5 }; a.transOut = { type: 'none', dur: 0.5 };
      if (a.keys) for (const p of Object.keys(a.keys)) if (!p.startsWith('audio.')) delete a.keys[p];
      if (c.keys) for (const p of Object.keys(c.keys)) if (p.startsWith('audio.')) delete c.keys[p];
      // lowest free track, like other sound
      a.track = [...d.tracks].reverse().find(tr => isFree(d, tr.id, a.start, a.duration))?.id || addTrack(d).id;
      c.audio = { ...c.audio, mute: true };
      c.detached = a.id;
      d.clips.push(a); made.push(a.id);
    }
  });
  app.select(made, null);
  toast('Sound detached onto its own clip.');
}

// ------------------------------------------------------------------ lock, group
export function toggleLock(app) {
  const list = selected(app);
  if (!list.length) { toast('Select clips to lock or unlock.'); return; }
  const lock = !list.every(c => c.locked);
  app.commit(() => { for (const c of list) c.locked = lock || undefined; });
  toast(lock ? 'Locked: they can’t be moved, trimmed or deleted.' : 'Unlocked.');
}
export function group(app) {
  const list = selected(app);
  if (list.length < 2) { toast('Select two or more clips to group.'); return; }
  const g = uid('g');
  app.commit(() => { for (const c of list) c.group = g; });
  toast('Grouped: clicking one selects them all.');
}
export function ungroup(app) {
  const ids = withGroups(app.doc, app.selection.clips);
  const list = app.doc.clips.filter(c => ids.includes(c.id) && c.group);
  if (!list.length) return;
  app.commit(() => { for (const c of list) delete c.group; });
  toast('Ungrouped.');
}

// ------------------------------------------------------------------ trim to playhead, in/out
export function trimToPlayhead(app, edge) {
  const doc = app.doc, t = app.player.time;
  let list = selected(app).filter(c => t > c.start && t < clipEnd(c) && !c.locked);
  if (!list.length) { const c = clipAtPlayhead(app, x => !x.locked); list = c ? [c] : []; }
  if (!list.length) { toast('Put the playhead inside a clip.'); return; }
  app.commit(d => { for (const c of list) trim(d, c, edge, t, c.type === 'media' ? mediaById(d, c.media) : null); });
}
export function markIn(app) { app.commit(d => { const out = d.range?.out; d.range = { in: app.player.time, out: out > app.player.time ? out : undefined }; }); toast('In point set (I). Export can use In to Out.'); }
export function markOut(app) { app.commit(d => { const i = d.range?.in; d.range = { in: i != null && i < app.player.time ? i : undefined, out: app.player.time }; }); toast(d0In(app) ? 'Out point set (O).' : 'Out point set (O). Set In (I) at the start of the part too.'); }
const d0In = app => app.doc?.range?.in != null;
export function clearInOut(app) { app.commit(d => { delete d.range; }); }

// ------------------------------------------------------------------ Auto Edit sections
/**
 * Sections: several In–Out ranges kept for Auto Edit (the first 10 minutes, a part at 30:00…). Auto Edit works on
 * just those and blends them into one edit. X adds the current In–Out as a section and clears In / Out for the next.
 */
export function addSection(app) {
  const d0 = app.doc, a = d0.range?.in ?? null, b = d0.range?.out ?? null;
  if (a == null || b == null || !(b > a + 1)) { toast('Set In (I) and Out (O) around the part you want, then press X to add it as a part. Or use ✚ KEEP A PART and drag across the timeline.', 6000); return; }
  addPart(app, a, b, true);
}
/** Keeps t0..t1 as a part for Auto Edit (overlapping parts join). quiet: no message. */
export function addPart(app, a, b, clearRange = false) {
  if (b < a) [a, b] = [b, a];
  if (!(b > a + 0.3)) return;
  let n = 0;
  app.commit(d => {
    const list = [...(d.sections || []), { id: uid('sec'), t0: Math.max(0, a), t1: b }].sort((p, q) => p.t0 - q.t0);
    // overlapping sections become one
    const out = [];
    for (const s of list) { const last = out[out.length - 1]; if (last && s.t0 <= last.t1 + 0.05) last.t1 = Math.max(last.t1, s.t1); else out.push({ ...s }); }
    d.sections = out; if (clearRange) delete d.range; n = out.length;
  });
  const f = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  toast(`Part kept (${f(a)} – ${f(b)}): ${n} part${n === 1 ? '' : 's'} so far. Drag over the next one, or press ⚡ AUTO EDIT.`, 5000);
}
export function removeSection(app, id) { app.commit(d => { d.sections = (d.sections || []).filter(s => s.id !== id); if (!d.sections.length) delete d.sections; }); }
export function clearSections(app) { app.commit(d => { delete d.sections; }); toast('Sections cleared.'); }

// ------------------------------------------------------------------ copy / paste style and properties
const STYLE_PROPS = ['radius', 'shadow', 'border', 'borderColor', 'opacity'];
export function copyStyle(app) {
  const c = selected(app)[0];
  if (!c) { toast('Select the clip to copy from.'); return; }
  app.styleClip = structuredClone(c);
  toast('Copied. Paste Style (⌥⌘V) copies the look; Paste Properties (⇧⌘V) also copies position, size, transitions and keyframes.');
}
export function pasteStyle(app, all) {
  const src = app.styleClip, list = selected(app).filter(c => !c.locked);
  if (!src) { toast('Copy a clip’s style first (⌥⌘C).'); return; }
  if (!list.length) { toast('Select clips to paste onto.'); return; }
  app.commit(() => {
    for (const c of list) {
      if (all) {
        c.props = structuredClone(src.props);
        c.transIn = { ...src.transIn }; c.transOut = { ...src.transOut };
        if (src.keys) {
          c.keys = {};
          for (const [p, l] of Object.entries(src.keys)) { const k = l.filter(x => x.t <= c.duration); if (k.length) c.keys[p] = structuredClone(k); }
          if (!Object.keys(c.keys).length) delete c.keys;
        }
        if (c.type === 'media' && src.type === 'media' && src.audio) c.audio = { ...c.audio, volume: src.audio.volume, pan: src.audio.pan, fadeIn: src.audio.fadeIn, fadeOut: src.audio.fadeOut, duck: src.audio.duck };
        if (src.cursor && c.type === 'media') c.cursor = structuredClone(src.cursor);
      } else {
        for (const k of STYLE_PROPS) if (k in src.props) c.props[k] = src.props[k];
      }
      if (c.type === src.type) {
        if (c.type === 'text') { const content = c.text.content; c.text = { ...structuredClone(src.text), content }; }
        if (c.type === 'callout') { const { x, y, w, h } = c.callout; c.callout = { ...structuredClone(src.callout), ...(all ? {} : { x, y, w, h }) }; }
        if (c.type === 'shape') { const { x1, y1, x2, y2 } = c.shape; c.shape = { ...structuredClone(src.shape), ...(all ? {} : { x1, y1, x2, y2 }) }; }
      }
    }
  });
}

// ------------------------------------------------------------------ save frame, unused media
export async function saveFrame(app) {
  const doc = app.doc;
  try {
    const cv = await app.player.still(app.player.time, doc.canvas.width, doc.canvas.height);
    const png = new Uint8Array(await (await new Promise(r => cv.toBlob(r, 'image/png'))).arrayBuffer());
    if (await app.api.saveFrame(app.token, png, `${doc.name} frame`)) toast('Frame saved.');
  } catch (e) { toast(e.message); }
}
export async function deleteUnusedMedia(app) {
  const doc = app.doc;
  const used = new Set();
  for (const c of doc.clips) { used.add(c.media); if (c.reversed) used.add(c.reversed.media); }
  const unused = doc.media.filter(m => !used.has(m.id));
  if (!unused.length) { toast('Every file in the project is on the timeline.'); return; }
  const names = unused.slice(0, 12).map(m => m.name).join(', ') + (unused.length > 12 ? `, and ${unused.length - 12} more` : '');
  if (!(await ask('Delete unused media?', `${unused.length} file${unused.length > 1 ? 's aren’t' : ' isn’t'} used on the timeline: ${names}. Move ${unused.length > 1 ? 'them' : 'it'} to the Trash?`, 'Move to Trash'))) return;
  const gone = [];
  for (const m of unused) { try { await app.api.deleteMedia(app.token, m.file); gone.push(m.id); } catch (e) { toast(`${m.name}: ${e.message}`); } }
  app.commit(d => { d.media = d.media.filter(m => !gone.includes(m.id)); });
  await app.save();
  toast(`Moved ${gone.length} file${gone.length === 1 ? '' : 's'} to the Trash.`);
}

// ------------------------------------------------------------------ gaps, ranges, labels
/** Close the gap under the playhead: on the selected clip's track, or on every track. */
export function closeGapAt(app, allTracks) {
  const t = app.player.time, sel = app.selection.clips;
  const track = allTracks ? null : (app.doc.clips.find(c => c.id === sel[0])?.track || null);
  let d = 0;
  app.commit(doc => { d = closeGap(doc, t, track); });
  toast(d ? `Closed a ${d.toFixed(2)} s gap${track ? ' on that track' : ' on every track'}.` : (track ? 'Put the playhead in an empty stretch of that track.' : 'Put the playhead where no track has a clip.'));
}
export function closeAllGapsOn(app) {
  const sel = app.selection.clips;
  const track = app.doc.clips.find(c => c.id === sel[0])?.track;
  if (!track) { toast('Select a clip on the track whose gaps you want closed.'); return; }
  let d = 0;
  app.commit(doc => { d = closeAllGaps(doc, track); });
  toast(d ? `Closed ${d.toFixed(2)} s of gaps on that track.` : 'That track has no gaps.');
}
/** Open a gap of `secs` at the playhead on every track. */
export function insertGap(app, secs = 1) {
  app.commit(doc => insertTime(doc, app.player.time, secs));
  toast(`Opened a ${secs} s gap on every track. Edit › Close Gap on All Tracks (⌃⌥⇧G) closes it again.`);
}
/** Ripple-delete In→Out, or between the two markers around the playhead. */
export function deleteRange(app, between) {
  const doc = app.doc, t = app.player.time;
  let a, b;
  if (between === 'markers') {
    const ms = (doc.markers || []).map(m => m.t).sort((x, y) => x - y);
    a = Math.max(0, ...ms.filter(x => x <= t + 1e-6)); b = Math.min(...ms.filter(x => x > t + 1e-6));
    if (!ms.length || !Number.isFinite(b)) { toast('Put the playhead between two markers.'); return; }
  } else {
    if (!doc.range || !(doc.range.out > doc.range.in)) { toast('Set an In (I) and Out (O) point first.'); return; }
    a = doc.range.in; b = doc.range.out;
  }
  app.commit(d => { removeRange(d, a, b); if (between !== 'markers') delete d.range; });
  app.seek(a);
  toast(`Removed ${(b - a).toFixed(2)} s from every track and closed it up.`);
}
export function setLabel(app, color) {
  const sel = app.selection.clips;
  if (!sel.length) { toast('Select clips to label.'); return; }
  app.commit(d => { for (const c of d.clips) if (sel.includes(c.id)) { if (color) c.label = color; else delete c.label; } });
}
/** Clip markers live on the clip and move with it. */
export function addClipMarker(app) {
  const t = app.player.time;
  const c = app.doc.clips.find(x => app.selection.clips.includes(x.id) && t >= x.start && t < clipEnd(x))
    || app.doc.clips.find(x => t >= x.start && t < clipEnd(x) && !x.locked);
  if (!c) { toast('Put the playhead over a clip.'); return; }
  app.commit(() => { (c.marks ||= []).push(t - c.start); c.marks.sort((p, q) => p - q); });
  toast('Clip marker added. It moves with the clip; ⌥-click it to remove.');
}

/** Give a clip its own name (shown on the timeline). Empty goes back to the media's name. */
export async function renameClip(app) {
  const c = app.doc.clips.find(x => x.id === app.selection.clips[0]);
  if (!c) { toast('Select a clip to rename.'); return; }
  const m = c.type === 'media' ? mediaById(app.doc, c.media) : null;
  const v = await promptText('Rename clip', 'Leave it empty to use the media’s name again.', c.customName ? c.name : '', 'Rename');
  if (v === null) return;
  app.commit(() => { if (v) { c.name = v.slice(0, 80); c.customName = true; } else { c.name = m ? m.name : c.type; delete c.customName; } });
}

// ------------------------------------------------------------------ ADR: align a new take to the guide
const ADR_PREFS = 'reel.adr';
const hasSound = (doc, c) => { const m = c.type === 'media' && mediaById(doc, c.media); return !!m && (m.kind === 'audio' || (m.kind === 'video' && m.hasAudio)); };
const srcAt = (c, t) => (c.in || 0) + (t - c.start) * (c.speed || 1);

/**
 * Select the re-recorded line and the original (guide). The new take is re-timed, syllable by syllable, to the
 * guide's timing with its pitch kept; it replaces the take clip and the original take stays one click away.
 */
export async function alignToGuide(app, preset = null) {
  const doc = app.doc, sel = preset ? [preset.guide, preset.take] : selected(app).filter(c => hasSound(doc, c));
  const undo = !preset && sel.length === 1 && sel[0].adrOriginal;
  if (undo) {
    app.commit(() => { const c = sel[0], o = c.adrOriginal; Object.assign(c, { media: o.media, in: o.in, start: o.start, duration: o.duration, speed: o.speed }); delete c.adrOriginal; });
    toast('Original take restored.'); return;
  }
  if (sel.length !== 2) { toast('Select two clips with sound: the original line (guide) and the new take.', 5000); return; }
  // guess: the guide is the one with picture, or the one on the higher track, or the earlier one
  const score = c => (mediaById(doc, c.media).kind === 'video' ? 4 : 0) + (doc.tracks.findIndex(t => t.id === c.track) < doc.tracks.findIndex(t => t.id === sel.find(x => x !== c).track) ? 2 : 0) + (c.start < sel.find(x => x !== c).start ? 1 : 0);
  let [guide, take] = preset ? sel : score(sel[0]) >= score(sel[1]) ? sel : [sel[1], sel[0]];
  let prefs = {}; try { prefs = JSON.parse(localStorage.getItem(ADR_PREFS) || '{}') || {}; } catch { /* defaults */ }
  const name = c => c.name || mediaById(doc, c.media).name;
  const which = el('select', {}, el('option', { value: '0', text: `“${name(guide)}” is the guide` }), el('option', { value: '1', text: `“${name(take)}” is the guide` }));
  const tight = el('select', {}, ...[['0.2', 'Loose — keeps the take’s own rhythm'], ['0.5', 'Normal'], ['0.85', 'Tight — follows every syllable']].map(([v, t]) => el('option', { value: v, text: t })));
  tight.value = prefs.tightness || '0.5';
  const maxS = el('select', {}, ...[['0.25', '25 %'], ['0.5', '50 %'], ['1', '100 %'], ['2', '200 %']].map(([v, t]) => el('option', { value: v, text: t })));
  maxS.value = prefs.maxStretch || '0.5';
  const mute = el('input', { type: 'checkbox', checked: prefs.mute !== false });
  const bar = el('div', { class: 'progress' }, el('i')), status = el('p', { class: 'note', text: '' });
  const body = el('div', {},
    el('p', { class: 'note', text: 'The new take is matched to the guide syllable by syllable and re-timed to it, keeping its pitch. Pauses can grow or shrink freely; the limit below applies to speech.' }),
    el('div', { class: 'row' }, el('label', { text: 'Guide' }), which),
    el('div', { class: 'row' }, el('label', { text: 'Tightness' }), tight),
    el('div', { class: 'row' }, el('label', { text: 'Max stretch' }), maxS),
    el('label', { class: 'row' }, mute, el('span', { text: 'Mute the guide clip afterwards' })),
    bar, status);
  let worker = null, rid = null, done = false;
  const dlg = modal('Align to Guide (ADR)', body, [
    { label: 'Cancel', onClick: close => close() },
    { label: 'Align', cls: 'hw amber', onClick: (close, btn) => { btn.disabled = true; go().finally(() => { btn.disabled = false; }); } },
  ], { onClose: () => { if (!done) { worker?.terminate(); if (rid) app.api.renderCancel(rid); } } });

  async function go() {
    if (which.value === '1') [guide, take] = [take, guide], which.value = '0';
    prefs = { tightness: tight.value, maxStretch: maxS.value, mute: mute.checked };
    try { localStorage.setItem(ADR_PREFS, JSON.stringify(prefs)); } catch { /* fine */ }
    const gm = mediaById(doc, guide.media), tm = mediaById(doc, take.media);
    const g0 = guide.start, g1 = clipEnd(guide);
    const msg = {
      type: 'start',
      guide: { url: app.player.urlFor(gm), file: gm.file, from: srcAt(guide, g0), to: srcAt(guide, g1) },
      // the take as the user placed it under the guide is the starting point
      take: { url: app.player.urlFor(tm), file: tm.file, from: Math.max(0, srcAt(take, g0)), to: srcAt(take, g1) },
      opts: { tightness: +tight.value, maxStretch: +maxS.value },
    };
    worker = new Worker(new URL('./adr-worker.js', import.meta.url), { type: 'module' });
    try {
      rid = (await app.api.renderBegin(app.token, `${name(take)} aligned`, 'wav')).id;
      const res = await new Promise((resolve, reject) => {
        worker.onmessage = e => {
          const m = e.data;
          if (m.type === 'chunk') app.api.renderChunk(rid, m.data);
          else if (m.type === 'progress') { bar.firstChild.style.width = Math.round(m.value * 100) + '%'; if (m.label) status.textContent = m.label; }
          else if (m.type === 'done') resolve(m);
          else if (m.type === 'error') reject(new Error(m.message));
        };
        worker.onerror = e => reject(new Error(e.message || 'Alignment failed'));
        worker.postMessage(msg);
      });
      const info = await app.api.renderFinish(rid, res.head); rid = null;
      done = true; worker.terminate(); dlg.close();
      const am = { id: uid('m'), ...info, name: `${name(take)} (aligned)`, alignedFrom: { media: tm.id, guide: gm.id } };
      app.commit(d => {
        d.media.push(am);
        const c = take;
        c.adrOriginal = { media: c.media, in: c.in || 0, start: c.start, duration: c.duration, speed: c.speed || 1 };
        c.media = am.id; c.in = 0; c.speed = 1; c.start = g0; c.duration = g1 - g0;
        if (!isFree(d, c.track, c.start, c.duration, [c.id])) c.track = (d.tracks.find(t => isFree(d, t.id, c.start, c.duration, [c.id])) || addTrack(d)).id;
        if (prefs.mute) { guide.audio = { ...(guide.audio || {}), mute: true }; }
      });
      const s = res.stats || {};
      toast(`Aligned. The take moved ${Math.abs(s.lag || 0) < 0.02 ? 'very little overall' : `${Math.abs(s.lag).toFixed(2)} s ${s.lag > 0 ? 'earlier' : 'later'} overall`}, and single words by up to ${(s.maxShift || 0).toFixed(2)} s more. Run it again on the clip to restore the original take.`, 7000);
    } catch (e) {
      worker.terminate();
      if (rid) { app.api.renderCancel(rid); rid = null; }
      status.textContent = e.message;
    }
  }
}

/** The original line under a new take (ADR): the clip with sound on another track that overlaps it most. */
export function guideUnder(doc, take) {
  let best = null, most = 0.2;
  for (const c of doc.clips) {
    if (c === take || c.track === take.track || c.disabled || !hasSound(doc, c)) continue;
    const ov = Math.min(clipEnd(c), clipEnd(take)) - Math.max(c.start, take.start);
    if (ov > most) { most = ov; best = c; }
  }
  return best;
}
