// The PRESETS library: every transition, cut transition, title animation, motion preset, graphic element and
// sound effect in one browser, each tile playing a live preview when you point at it (drawn by the same
// compositor as the edit). Click to apply to the selection (or add at the playhead). The AUTO page puts
// transitions (and matching sounds) on every cut, optionally finding the shot changes inside clips first.
import { el, toast, popMenu, modal } from './ui.js';
import { pref, setPref } from './prefs.js';
import { drawFrame } from './compositor.js';
import { TEXT_ANIMS } from './compositor.js';
import { TRANSITIONS } from './inspector.js';
import { CUT_TRANSITIONS, cutAt, cutsOn, applyCut, newTextClip, newElementClip, newMediaClip, mediaById, clipEnd, isFree, addTrack, split, uid, DEFAULT_PROPS, duration as docDuration } from './model.js';
import { peaksFor } from './peaks.js';
import { MOTION_PRESETS, applyMotion } from './motion.js';
import { ELEMENTS, elementHome, VIZ_RATE } from './lib/elements.js';
import { SFX, makeSfx, SFX_FOR } from './lib/sfx.js';
import { wavHeader } from './voiceover.js';
import { analyse as zoomAnalyse } from './autozoom.js';
import { STYLES, applyStyle, removeStyle, pickTransition, jitter, seeded, mainTrack } from './lib/styles.js';
import { FILM_CUTS, splitEdit, smashCut, jumpCut, cutOnAction, cutaway, crossCut, autoSplitEdits } from './lib/filmcuts.js';
import { analyse as musicAnalyse, musicLike } from './musicfit.js';

// ------------------------------------------------------------------ auto packs
export const PACKS = {
  clean: { name: 'Clean', hint: 'Soft blurs and dips — tutorials, talks', list: ['blur-through', 'dip-black'], dur: 0.5 },
  smooth: { name: 'Smooth', hint: 'Zoom-throughs and light leaks — vlogs, travel', list: ['zoom-through', 'light-leak', 'blur-through'], dur: 0.6 },
  punchy: { name: 'Punchy', hint: 'Whips, flashes and shakes — YouTube, Shorts', list: ['whip-through', 'flash-cut', 'zoom-through', 'shake-cut'], dur: 0.4 },
  glitchy: { name: 'Glitchy', hint: 'Digital glitches — tech, gaming', list: ['glitch-cut', 'flash-cut', 'glitch-cut', 'whip-through'], dur: 0.35 },
  cinematic: { name: 'Cinematic', hint: 'Light leaks, film burns, lens defocus and flares — trailers, stories', list: ['light-leak', 'lens-defocus', 'film-burn', 'flare-sweep', 'blur-through'], dur: 0.8 },
  filmic: { name: 'Filmic', hint: 'Lens defocus, exposure burns and soft flares — short films, music videos', list: ['lens-defocus', 'exposure-burn', 'flare-sweep', 'lens-defocus'], dur: 0.9 },
  capcut: { name: 'Trending', hint: 'Slide + shake, fast wipes, warp zooms and glitch blocks — CapCut-style edits', list: ['slide-shake', 'fast-wipe', 'warp-zoom', 'glitch-blocks', 'slide-shake'], dur: 0.45 },
  vintage: { name: 'Vintage', hint: 'Old-film burns, vertigo ramps and graphic match cuts — retro, documentary', list: ['film-burn-vintage', 'match-graphic', 'vertigo', 'film-burn-vintage'], dur: 0.8 },
  social: { name: 'Social (fast)', hint: 'Punch zooms, chromatic splits and flashes — TikTok, Reels, Shorts', list: ['punch-zoom', 'chroma-split', 'flash-cut', 'punch-zoom', 'whip-through'], dur: 0.3 },
};

// ------------------------------------------------------------------ sound effects in the project
/** Makes (once per project) a sound effect as a WAV in the project's media, and returns its media entry. */
export async function sfxMedia(app, id) {
  const have = app.doc.media.find(m => m.sfx === id);
  if (have) return have;
  const RATE = 48000, [L, R] = makeSfx(id, RATE), n = L.length, buf = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { buf[i * 2] = L[i]; buf[i * 2 + 1] = R[i]; }
  const { id: rid } = await app.api.renderBegin(app.token, `SFX ${SFX[id].name}`, 'wav');
  app.api.renderChunk(rid, new Uint8Array(buf.buffer));
  const info = await app.api.renderFinish(rid, wavHeader(n, 2, RATE));
  const m = { id: uid('m'), ...info, name: `SFX · ${SFX[id].name}`, sfx: id, kind: 'audio', hasAudio: true };
  app.doc.media.push(m);
  return m;
}
/** The "Sound FX" track (made at the bottom if there's none, or if it's busy at that time). */
function sfxTrack(doc, start, dur) {
  let tr = doc.tracks.find(t => /sound ?fx|sfx/i.test(t.name || '') && isFree(doc, t.id, start, dur));
  if (!tr) { tr = addTrack(doc, doc.tracks.length); tr.name = doc.tracks.some(t => /sound fx/i.test(t.name || '')) ? `Sound FX ${doc.tracks.length}` : 'Sound FX'; }
  return tr;
}
/** Places sound effects: [{ id, at (timeline s; the sound's peak lands there) }]. Run inside a commit. */
function placeSfx(doc, list, medias, tag = null) {
  for (const { id, at } of list) {
    const m = medias.get(id); if (!m) continue;
    const lead = id === 'whoosh' || id === 'swish' ? SFX[id].len * 0.55 : id === 'riser' ? SFX[id].len : 0;
    const start = Math.max(0, at - lead), tr = sfxTrack(doc, start, m.duration || SFX[id].len);
    const c = newMediaClip(doc, m, tr.id, start);
    c.audio = { ...(c.audio || {}), volume: 0.6 };
    if (tag) c.style = tag; // a style pack's sound: goes when the style comes off
    doc.clips.push(c);
  }
}
export async function addSound(app, id, at = app.player.time) {
  try {
    const m = await sfxMedia(app, id);
    app.commit(d => { placeSfx(d, [{ id, at }], new Map([[id, m]])); });
    toast(`${SFX[id].name} added on the Sound FX track.`);
  } catch (e) { toast(e.message, 5000); }
}

// ------------------------------------------------------------------ applying
const selected = app => app.selection.clips.map(id => app.doc.clips.find(c => c.id === id)).filter(Boolean);
const visual = (doc, c) => c && c.type !== 'caption' && !(c.type === 'media' && (c.audioOnly || mediaById(doc, c.media)?.kind === 'audio'));

function applyTransition(app, type, side, withSound) {
  const list = selected(app).filter(c => visual(app.doc, c));
  if (!list.length) { toast('Select one or more clips first.'); return; }
  app.commit(() => { for (const c of list) { const d0 = Number(pref('transDur')) || 0.5; if (side !== 'out') c.transIn = { type, dur: c.transIn?.type !== 'none' && c.transIn?.dur ? c.transIn.dur : d0 }; if (side !== 'in') c.transOut = { type, dur: c.transOut?.type !== 'none' && c.transOut?.dur ? c.transOut.dur : d0 }; } });
  if (withSound && SFX_FOR[type]) for (const c of list) addSound(app, SFX_FOR[type], side === 'out' ? clipEnd(c) - 0.25 : c.start + 0.15);
  toast(`${TRANSITIONS.find(t => t[0] === type)?.[1] || type} on ${list.length} clip${list.length === 1 ? '' : 's'}.`);
}
function applyCutTransition(app, type, withSound, every = false) {
  const doc = app.doc, t = app.player.time, sel = selected(app).filter(c => visual(doc, c));
  const tracks = sel.length ? [...new Set(sel.map(c => c.track))] : doc.tracks.map(tr => tr.id);
  let pairs = [];
  if (every) pairs = tracks.flatMap(id => cutsOn(doc, id)).filter(([a, b]) => visual(doc, a) && visual(doc, b));
  else {
    let best = null, bd = Infinity;
    for (const id of tracks) { const p = cutAt(doc, id, t, 3); if (p && visual(doc, p[0]) && Math.abs(clipEnd(p[0]) - t) < bd) { bd = Math.abs(clipEnd(p[0]) - t); best = p; } }
    if (best) pairs = [best];
  }
  if (!pairs.length) { toast(every ? 'There are no cuts (clips touching end to start) to put it on.' : 'Put the playhead near a cut, where one clip ends and the next begins on the same track.'); return; }
  app.commit(() => { for (const [a, b] of pairs) applyCut(a, b, type, Math.max(0.3, Number(pref('transDur')) || 0.5) * 1.2); });
  if (withSound && SFX_FOR[type]) addSounds(app, pairs.map(([a]) => ({ id: SFX_FOR[type], at: clipEnd(a) })));
  toast(`${CUT_TRANSITIONS.find(x => x[0] === type)?.[1] || type} on ${pairs.length} cut${pairs.length === 1 ? '' : 's'}.`);
}
export async function addSounds(app, list, tag = null) {
  const medias = new Map();
  try { for (const id of new Set(list.map(x => x.id))) medias.set(id, await sfxMedia(app, id)); }
  catch (e) { toast(e.message, 5000); return; }
  app.commit(d => placeSfx(d, list, medias, tag));
}
function applyTitle(app, anim) {
  const list = selected(app).filter(c => c.type === 'text');
  if (list.length) { app.commit(() => { for (const c of list) c.text = { ...c.text, anim }; }); return; }
  const c = newTextClip(null, app.player.time, 'Your title');
  c.text = { ...c.text, anim };
  app._insert(c);
}
function applyMotionPreset(app, id) {
  const list = selected(app).filter(c => visual(app.doc, c));
  if (!list.length) { toast('Select a clip (video, picture, title or element) first.'); return; }
  app.commit(() => { for (const c of list) applyMotion(c, id); });
}
function addElement(app, kind) {
  const group = ELEMENTS[kind].group;
  if (group === 'Backgrounds') return addBackground(app, kind);
  if (group === 'Audio visualizers') return addVisualizer(app, kind);
  const c = newElementClip(null, app.player.time, kind, elementHome(kind), kind === 'burst' || kind === 'ringPop' ? 1.5 : 4);
  c.name = ELEMENTS[kind].name;
  app._insert(c);
}
/** A motion background: on its own track at the bottom, under everything, as long as the edit from the playhead. */
function addBackground(app, kind) {
  const t = app.player.time, len = Math.max(10, docDuration(app.doc) - t);
  let id = null;
  app.commit(d => {
    const tr = addTrack(d, d.tracks.length); tr.name = 'Background';
    const c = newElementClip(tr.id, t, kind, { x: 0.5, y: 0.5 }, len); c.name = ELEMENTS[kind].name; c.props.scale = 1;
    d.clips.push(c); id = c.id;
  });
  app.select([id], null);
  toast(`${ELEMENTS[kind].name}: on a Background track under everything. Pick its colours on the right; scale your video down (or use Picture in picture) to see it around it.`, 6000);
}
/** An audio visualizer that follows the sound under it: its loudness is measured now from the waveforms. */
async function addVisualizer(app, kind) {
  const doc = app.doc, t0 = app.player.time;
  const sound = doc.clips.filter(c => c.type === 'media' && !c.disabled && !c.audio?.mute && (mediaById(doc, c.media)?.kind === 'audio' || mediaById(doc, c.media)?.hasAudio));
  const under = sound.filter(c => c.start <= t0 + 0.05 && c.start + c.duration > t0);
  const end = under.length ? Math.max(...under.map(c => c.start + c.duration)) : t0 + 10;
  const len = Math.max(2, Math.min(600, end - t0));
  const n = Math.ceil(len * VIZ_RATE), env = new Array(n).fill(0);
  for (const c of sound) {
    if (c.start >= t0 + len || c.start + c.duration <= t0) continue;
    const m = mediaById(doc, c.media);
    let pk = null; try { pk = await peaksFor(app, m); } catch { /* no waveform */ }
    if (!pk) continue;
    for (let i = 0; i < n; i++) {
      const T = t0 + i / VIZ_RATE; if (T < c.start || T >= c.start + c.duration) continue;
      const st = (c.in || 0) + (T - c.start) * (c.speed || 1), k = Math.floor(st * pk.rate);
      env[i] = Math.max(env[i], (pk.data[k] || 0) * (c.audio?.volume ?? 1));
    }
  }
  // peaks are square-rooted for display: bring them to a loudness-like 0..1, gently smoothed
  const top = Math.max(0.05, ...env);
  let prev = 0;
  for (let i = 0; i < n; i++) { const v = Math.min(1, (env[i] / top) ** 1.6); prev = v > prev ? v : prev * 0.82 + v * 0.18; env[i] = Math.round(prev * 100) / 100; }
  const c = newElementClip(null, t0, kind, elementHome(kind), len);
  c.name = ELEMENTS[kind].name; c.element.env = env;
  app._insert(c);
  toast(sound.length ? `${ELEMENTS[kind].name}: follows the sound for ${len.toFixed(1)} s from the playhead.` : 'No sound under the playhead yet: the visualizer idles. Add sound, then add it again.', 5000);
}

/**
 * Transitions on every cut in the edit (or on the given clips), in a style pack, with matching sounds.
 * shots: { clipId: [clip-local times of shot changes] } to cut those clips there first (from a scan).
 */
export async function autoTransitions(app, packId, { sounds = true, clipIds = null, shots = null, filter = null, randomize = Number(pref('transRandom')) || 0 } = {}) {
  const pack = PACKS[packId]; if (!pack) return 0;
  const doc = app.doc;
  let pairs = [];
  app.commit(d => {
    if (shots) for (const [id, times] of Object.entries(shots)) {
      const c = d.clips.find(x => x.id === id); if (!c) continue;
      // last first, so the original clip (which keeps its id) is always the part still to cut
      const start = c.start, len = c.duration;
      for (const tt of [...times].sort((p, q) => q - p)) if (tt > 0.4 && tt < len - 0.4) split(d, start + tt, [id]);
    }
    const tracks = clipIds ? [...new Set(d.clips.filter(c => clipIds.includes(c.id)).map(c => c.track))] : d.tracks.map(t => t.id);
    pairs = tracks.flatMap(id => cutsOn(d, id)).filter(([a, b]) => visual(d, a) && visual(d, b) && (!filter || filter(a, b)));
    const rng = seeded(Date.now());
    pairs.forEach(([a, b], i) => applyCut(a, b, pickTransition(pack.list, i, randomize, rng), jitter(pack.dur, randomize, rng)));
  });
  if (sounds && pairs.length) {
    const list = pairs.map(([a, b]) => ({ id: SFX_FOR[b.transIn.type], at: clipEnd(a) })).filter(x => x.id);
    if (list.length) await addSounds(app, list);
  }
  void doc;
  return pairs.length;
}

// ------------------------------------------------------------------ previews
function scene(w, h, hue, label) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, w, h);
  gr.addColorStop(0, `hsl(${hue},70%,45%)`); gr.addColorStop(1, `hsl(${hue + 40},70%,22%)`);
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(255,255,255,.25)'; for (let i = 0; i < 5; i++) { g.beginPath(); g.arc(w * (0.15 + i * 0.18), h * (0.7 - (i % 2) * 0.25), h * 0.12, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = '#fff'; g.font = `800 ${h * 0.32}px Avenir Next, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, w / 2, h / 2);
  return c;
}
let A = null, B = null;
function miniDoc(kind, id) {
  const W = 320, H = 180;
  A ||= scene(W, H, 205, 'A'); B ||= scene(W, H, 25, 'B');
  const props = { ...DEFAULT_PROPS, crop: [0, 0, 0, 0] };
  const media = [{ id: 'A', kind: 'image', width: W, height: H, file: 'a' }, { id: 'B', kind: 'image', width: W, height: H, file: 'b' }];
  const clip = (mid, track, start, duration, extra = {}) => ({ id: mid + start, type: 'media', media: mid, track, start, duration, in: 0, props: { ...props }, actions: [], transIn: { type: 'none', dur: 0.5 }, transOut: { type: 'none', dur: 0.5 }, ...extra });
  const doc = { canvas: { width: W, height: H, fps: 30, background: '#111' }, media, tracks: [{ id: 't1' }, { id: 't2' }], clips: [], captions: [] };
  let len = 2.4;
  if (kind === 'cut') { const a = clip('A', 't2', 0, 1.2), b = clip('B', 't2', 1.2, 1.2); applyCut(a, b, id, 0.8); doc.clips.push(a, b); }
  else if (kind === 'trans') { doc.clips.push(clip('B', 't2', 0, 2.4), clip('A', 't1', 0.2, 2, { transIn: { type: id, dur: 0.7 }, transOut: { type: id, dur: 0.7 } })); }
  else if (kind === 'title') { const c = newTextClip('t1', 0, 'Your title'); c.text = { ...c.text, anim: id, size: 46, animDur: 0.6 }; c.duration = 2.4; doc.clips.push(clip('A', 't2', 0, 2.4), c); }
  else if (kind === 'motion') { const c = clip('A', 't1', 0, 2.4); applyMotion(c, id); doc.clips.push(c); }
  else if (kind === 'element') { const L = ELEMENTS[id]?.group === 'Social' ? 3.6 : 2.6; const c = newElementClip('t1', 0, id, elementHome(id), L); c.props.scale = 1; doc.clips.push(clip('B', 't2', 0, L), c); len = L; } // social ones click through a sequence: a little longer
  else if (kind === 'style') {
    doc.canvas = { ...doc.canvas, width: 1920, height: 1080 };
    for (let i = 0; i < 4; i++) doc.clips.push(clip(i % 2 ? 'B' : 'A', 't2', i * 1.6, 1.6));
    applyStyle(doc, id, { seed: 3 });
    for (const c of doc.clips) if (c.type === 'element' && c.duration > 6) c.duration = 6.4; // the whole-edit ones
    len = Math.max(...doc.clips.map(c => c.start + c.duration));
  }
  const sources = { frame: c => ({ img: c.media === 'A' ? A : B, w: W, h: H }), cursor: () => null, input: () => null, fx: () => null, lut: () => null, matte: () => null };
  return { doc, sources, len };
}
export function tile(kind, id, name, onApply, extra) {
  const cv = el('canvas', { width: 320, height: 180, class: 'pl-cv' });
  const ctx = cv.getContext('2d');
  let raf = 0, t0 = 0, mini = null;
  const frame = t => { mini ||= miniDoc(kind, id); try { drawFrame(ctx, mini.doc, t % mini.len, mini.sources); } catch { /* preview only */ } };
  const still = () => frame(kind === 'cut' ? 1.15 : kind === 'trans' ? 0.45 : kind === 'element' ? 1.2 : kind === 'style' ? 1.5 : 1.0);
  const t = el('div', { class: 'pl-tile', role: 'button', tabindex: 0, 'aria-label': name, title: `${name} — click to apply${extra ? '' : ''}` }, cv, el('div', { class: 'pl-name', text: name }), extra || null);
  t.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === t) { e.preventDefault(); onApply(e); } }); // the keyboard (and VoiceOver) can pick one too
  t.addEventListener('focus', () => t.dispatchEvent(new Event('pointerenter')));
  t.addEventListener('blur', () => t.dispatchEvent(new Event('pointerleave')));
  t.addEventListener('pointerenter', () => { cancelAnimationFrame(raf); t0 = performance.now(); const loop = n => { frame((n - t0) / 1000); raf = requestAnimationFrame(loop); }; raf = requestAnimationFrame(loop); });
  t.addEventListener('pointerleave', () => { cancelAnimationFrame(raf); still(); });
  t.addEventListener('click', e => { if (!e.target.closest('.pl-side')) onApply(e); });
  requestAnimationFrame(still);
  return t;
}

// ------------------------------------------------------------------ the browser
let panel = null;
export function openPresetBrowser(app, page = 'cut') {
  if (!app.doc) return;
  if (panel) { panel.remove(); panel = null; }
  let sound = (() => { try { return localStorage.getItem('reel.presetSound') !== '0'; } catch { return true; } })();
  const soundCb = el('input', { type: 'checkbox', checked: sound });
  soundCb.addEventListener('change', () => { sound = soundCb.checked; try { localStorage.setItem('reel.presetSound', sound ? '1' : '0'); } catch { /* fine */ } });
  const search = el('input', { type: 'search', placeholder: 'Search presets…' });
  const grid = el('div', { class: 'pl-grid' }), note = el('p', { class: 'note pl-note' });
  const PAGES = [['style', 'STYLE PACKS'], ['cut', 'CUT TRANSITIONS'], ['film', 'FILM CUTS'], ['trans', 'TRANSITIONS'], ['title', 'TITLES'], ['motion', 'MOTION'], ['element', 'ELEMENTS'], ['sound', 'SOUNDS'], ['auto', 'AUTO']];
  const tabs = el('div', { class: 'pl-tabs' }, ...PAGES.map(([k, l]) => el('button', { class: 'cs-tab', 'data-k': k, text: l, onclick: () => show(k) })));
  const show = k => {
    page = k;
    for (const b of tabs.children) b.classList.toggle('on', b.dataset.k === k);
    const q = search.value.trim().toLowerCase(), match = n => !q || n.toLowerCase().includes(q);
    grid.replaceChildren(); grid.className = 'pl-grid' + (k === 'sound' ? ' sounds' : '') + (k === 'auto' || k === 'film' ? ' auto' : '');
    if (k === 'style') {
      note.textContent = 'A whole look in one click: transitions on every cut, colour, camera moves, titles and graphics, sound effects, and (if you like) cuts snapped to the music’s beat. Point at one to preview it. Applying another style replaces it; ⌘Z undoes.';
      for (const [id, p] of Object.entries(STYLES)) if (match(p.name) || match(p.hint)) grid.append(tile('style', id, p.name, () => openStyle(app, id)));
    } else if (k === 'film') {
      note.textContent = 'The classic edits from film. For the ones at a cut, put the playhead near the cut (on the selected clip’s track); Jump cut goes where the playhead is; Cutaway and Cross-cut use the clips you select.';
      for (const [id, n, hint] of FILM_CUTS) if (match(n) || match(hint)) grid.append(el('button', { class: 'starter pl-pack pl-film', type: 'button', onclick: () => doFilmCut(app, id, sound) }, filmIcon(id), el('b', { text: n }), el('small', { text: hint })));
      grid.append(el('button', { class: 'starter pl-pack pl-film', type: 'button', onclick: () => {
        const tracks = selected(app).length ? [...new Set(selected(app).map(c => c.track))] : app.doc.tracks.map(t => t.id);
        let n = 0; const rng = seeded(Date.now());
        app.commit(d => { for (const t of tracks) n += autoSplitEdits(d, t, Number(pref('filmLead')) || 1, Number(pref('transRandom')) || 0, rng); });
        toast(n ? `${n} L- and J-cut${n === 1 ? '' : 's'}, taking turns, on the cuts between clips with sound. ⌘Z undoes.` : 'No cuts between video clips with sound (with spare sound either side) to do.', 6000);
      } }, filmIcon('l-cut'), el('b', { text: '⚡ Auto L & J cuts' }), el('small', { text: 'On every cut between clips with sound (or the selected track): J- and L-cuts take turns, the way dialogue scenes are cut. Randomize varies their lengths.' })));
      grid.append(el('div', { class: 'pl-scan' }, leadRow(), randomRow()));
    } else if (k === 'cut') {
      note.textContent = 'Plays across a cut: the end of one clip hands over to the next. Click to put it on the cut nearest the playhead (on the selected clip’s track). ⌥-click puts it on every cut.';
      for (const [id, n] of CUT_TRANSITIONS) if (match(n)) grid.append(tile('cut', id, n, e => applyCutTransition(app, id, sound, e.altKey)));
    } else if (k === 'trans') {
      note.textContent = 'In and out of a clip. Click for both ends of the selected clips; IN or OUT for one end.';
      for (const [id, n] of TRANSITIONS) if (id !== 'none' && !CUT_TRANSITIONS.some(c => c[0] === id) && match(n)) {
        const side = el('div', { class: 'pl-side' }, el('button', { class: 'mini', text: 'IN', onclick: () => applyTransition(app, id, 'in', sound) }), el('button', { class: 'mini', text: 'OUT', onclick: () => applyTransition(app, id, 'out', sound) }));
        grid.append(tile('trans', id, n, () => applyTransition(app, id, 'both', sound), side));
      }
    } else if (k === 'title') {
      note.textContent = 'Text animations. Click to use it on the selected titles, or to add a new title at the playhead.';
      for (const [id, n] of TEXT_ANIMS) if (id !== 'none' && match(n)) grid.append(tile('title', id, n, () => applyTitle(app, id)));
    } else if (k === 'motion') {
      note.textContent = 'Moves made of keyframes you can adjust afterwards. Click to put it on the selected clips.';
      for (const [id, p] of Object.entries(MOTION_PRESETS)) if (match(p.name) || match(p.group)) grid.append(tile('motion', id, p.name, () => applyMotionPreset(app, id)));
    } else if (k === 'element') {
      note.textContent = 'Animated graphics. Click to add one at the playhead; change its words and colours in the inspector.';
      // social call-outs (like, subscribe, follow, end screen) first: the ones people look for
      const order = g => (g === 'Social' ? 0 : g === 'Call-outs' ? 1 : g === 'Lower thirds' ? 2 : 3);
      for (const [id, p] of Object.entries(ELEMENTS).sort((a, b) => order(a[1].group) - order(b[1].group))) if (match(p.name) || match(p.group)) grid.append(tile('element', id, p.name, () => addElement(app, id)));
    } else if (k === 'sound') {
      note.textContent = 'Sound effects made by Reel (free to use anywhere). ▶ to listen, click the name to add it at the playhead on the Sound FX track.';
      for (const [id, s] of Object.entries(SFX)) if (match(s.name) || match(s.hint)) {
        const play = el('button', { class: 'mini', text: '▶', title: 'Listen', onclick: e => { e.stopPropagation(); preview(id); } });
        grid.append(el('div', { class: 'pl-sound', onclick: () => addSound(app, id) }, play, el('div', {}, el('b', { text: s.name }), el('small', { text: s.hint }))));
      }
    } else if (k === 'auto') {
      note.textContent = 'Put transitions on every cut in one go, in a style. “Find shot changes” first cuts long clips where the picture changes (a new scene, a new window), so those get transitions too. Smart Zoom and Time-lapse can do this as they scan.';
      const scan = el('input', { type: 'checkbox' });
      for (const [id, p] of Object.entries(PACKS)) {
        grid.append(el('button', { class: 'starter pl-pack', type: 'button', onclick: async () => {
          let shots = null;
          if (scan.checked) shots = await findShots(app, selected(app).length ? selected(app) : app.doc.clips);
          const n = await autoTransitions(app, id, { sounds: sound, clipIds: selected(app).length ? selected(app).map(c => c.id) : null, shots });
          toast(n ? `${p.name}: transitions on ${n} cut${n === 1 ? '' : 's'}${sound ? ' with sounds' : ''}. ⌘Z undoes it.` : 'No cuts found (clips that touch end to start). Try “Find shot changes”.', 6000);
        } }, el('b', { text: p.name }), el('small', { text: p.hint })));
      }
      grid.append(el('label', { class: 'row pl-scan' }, scan, el('span', { text: 'Find shot changes inside clips first (scans the video)' })));
      grid.append(el('div', { class: 'pl-scan' }, randomRow()));
    }
  };
  search.addEventListener('input', () => show(page));
  const head = el('div', { class: 'fx-ed-head' }, el('b', { text: 'Presets' }), el('button', { class: 'mini', text: '×', title: 'Close', onclick: () => { panel.remove(); panel = null; } }));
  panel = el('div', { class: 'fx-editor pl-panel' }, head, tabs,
    el('div', { class: 'row pl-tools' }, search, el('label', { class: 'chk', title: 'Add matching sound effects with transitions and film cuts' }, soundCb, el('span', { text: 'Sound effects' }))),
    note, grid);
  document.body.append(panel);
  head.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const r = panel.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const mv = ev => { panel.style.left = Math.max(0, ev.clientX - dx) + 'px'; panel.style.top = Math.max(0, ev.clientY - dy) + 'px'; panel.style.right = 'auto'; };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  });
  show(page);
}

let previewCtx = null;
function preview(id) {
  try {
    if (!previewCtx) { // through the same output as playback
      let sink = ''; try { sink = JSON.parse(localStorage.getItem('reel.monitor') || '{}')?.sink || ''; } catch { /* default */ }
      try { previewCtx = new AudioContext(sink ? { sinkId: sink } : {}); } catch { previewCtx = new AudioContext(); }
    }
    const [L, R] = makeSfx(id, previewCtx.sampleRate), b = previewCtx.createBuffer(2, L.length, previewCtx.sampleRate);
    b.copyToChannel(L, 0); b.copyToChannel(R, 1);
    const s = previewCtx.createBufferSource(); s.buffer = b; s.connect(previewCtx.destination); s.start();
  } catch { /* no sound */ }
}

/** Scans video clips for shot changes (clip-local times), with a progress toast. */
export async function findShots(app, clips) {
  const out = {};
  const vids = clips.filter(c => c.type === 'media' && mediaById(app.doc, c.media)?.kind === 'video' && !c.audioOnly);
  for (const [i, c] of vids.entries()) {
    toast(`Finding shot changes… ${i + 1} of ${vids.length}`, 1500);
    try { const res = await zoomAnalyse(app, c, mediaById(app.doc, c.media), {}); if (res.cuts?.length) out[c.id] = res.cuts; } catch { /* skip */ }
  }
  return out;
}
export { popMenu };

/** For time-lapses: only where the speed jumps a lot (a quiet stretch racing into the action and back). */
export const speedJump = (a, b) => { const p = a.speed || 1, q = b.speed || 1; return Math.max(p, q) / Math.min(p, q) >= 3; };


// ------------------------------------------------------------------ randomize, style packs, film cuts
/** The Randomize slider: 0 follows a pack's own order; higher mixes in others of the same kind, then anything. */
export function randomRow() {
  const v = Number(pref('transRandom')) || 0;
  const out = el('span', { class: 'pl-rand-v', text: randLabel(v) });
  const r = el('input', { type: 'range', min: 0, max: 1, step: 0.25, value: v, title: 'How much to mix up the transitions: 0 follows the pack, more swaps in others of the same feel, all the way up is a surprise mix (lengths vary too)' });
  r.addEventListener('input', () => { setPref('transRandom', Number(r.value)); out.textContent = randLabel(Number(r.value)); });
  return el('div', { class: 'row pl-rand' }, el('label', { text: '🎲 Randomize' }), r, out);
}
const randLabel = v => (v <= 0 ? 'Off: in order' : v < 0.5 ? 'A little: same feel' : v < 0.95 ? 'Lots: some surprises' : 'Surprise me');
function leadRow() {
  const v = Number(pref('filmLead')) || 1;
  const out = el('span', { class: 'pl-rand-v', text: v.toFixed(1) + ' s' });
  const r = el('input', { type: 'range', min: 0.5, max: 3, step: 0.5, value: v, title: 'L-cut and J-cut: how long the sound leads or trails the picture' });
  r.addEventListener('input', () => { setPref('filmLead', Number(r.value)); out.textContent = Number(r.value).toFixed(1) + ' s'; });
  return el('div', { class: 'row pl-rand' }, el('label', { text: 'L / J sound overlap' }), r, out);
}

/** A little drawing of what each film cut does to the timeline (picture on top, sound under it). */
function filmIcon(id) {
  const cv = el('canvas', { width: 220, height: 64, class: 'pl-film-ic' }), g = cv.getContext('2d');
  const A = '#3f86d8', B = '#e0823a', row = (y, parts, h = 18) => { let x = 8; for (const [w, c] of parts) { g.fillStyle = c; g.fillRect(x, y, w - 2, h); x += w; } };
  g.fillStyle = '#9a917f'; g.font = '600 9px -apple-system, sans-serif';
  switch (id) {
    case 'l-cut': row(8, [[100, A], [104, B]]); row(34, [[140, A], [64, B]], 14); break;
    case 'j-cut': row(8, [[100, A], [104, B]]); row(34, [[62, A], [142, B]], 14); break;
    case 'smash': row(8, [[100, A], [104, '#e5484d']]); g.fillStyle = '#ffd60a'; g.beginPath(); g.moveTo(112, 4); g.lineTo(100, 34); g.lineTo(110, 34); g.lineTo(98, 60); g.lineTo(122, 26); g.lineTo(111, 26); g.lineTo(120, 4); g.fill(); break;
    case 'jump': row(14, [[100, A], [104, A]], 22); g.fillStyle = '#fff'; g.fillRect(106, 8, 3, 34); g.strokeStyle = '#fff'; g.strokeRect(150, 18, 30, 14); g.strokeRect(144, 15, 42, 20); break;
    case 'action': row(14, [[100, A], [104, B]], 22); g.fillStyle = 'rgba(255,255,255,.5)'; g.fillRect(96, 14, 14, 22); break;
    case 'cutaway': row(34, [[204, A]], 18); row(8, [[60, 'rgba(0,0,0,0)'], [70, B]], 18); break;
    case 'cross': row(14, [[58, A], [52, B], [40, A], [30, B], [24, '#3f86d8']], 26); break;
    default: break;
  }
  return cv;
}

/** Runs an edit on a copy first, so one that can't be done changes nothing; then for real, as one undo step. */
async function tryEdit(app, fn, withSound = false) {
  const test = fn(structuredClone(app.doc));
  if (!test || test.error) { toast(test?.error || 'Couldn’t do that here.', 6000); return null; }
  // its sound effects are made first, so the edit and its sounds are one ⌘Z
  const medias = new Map();
  if (withSound && test.sfx?.length) { try { for (const id of new Set(test.sfx.map(x => x.id))) medias.set(id, await sfxMedia(app, id)); } catch { /* the edit without its sound */ } }
  let r = null; app.commit(d => { r = fn(d); if (medias.size && r?.sfx?.length) placeSfx(d, r.sfx, medias); });
  return r;
}
function nearestCut(app) {
  const doc = app.doc, t = app.player.time, sel = selected(app).filter(c => visual(doc, c));
  const tracks = sel.length ? [...new Set(sel.map(c => c.track))] : doc.tracks.map(tr => tr.id);
  let best = null, bd = Infinity;
  for (const id of tracks) { const p = cutAt(doc, id, t, 3); if (p && visual(doc, p[0]) && visual(doc, p[1]) && Math.abs(clipEnd(p[0]) - t) < bd) { bd = Math.abs(clipEnd(p[0]) - t); best = p; } }
  return best;
}
export async function doFilmCut(app, id, withSound = true, pair = null) {
  const doc = app.doc, name = FILM_CUTS.find(f => f[0] === id)?.[1] || id;
  const done = (r, msg) => { if (r) toast(msg, 6000); };
  if (['l-cut', 'j-cut', 'smash', 'action'].includes(id)) {
    const p = pair || nearestCut(app);
    if (!p) { toast('Put the playhead near a cut: where one clip ends and the next begins on the same track.', 6000); return; }
    const [ai, bi] = [p[0].id, p[1].id], get = (d, x) => d.clips.find(c => c.id === x);
    const lead = Number(pref('filmLead')) || 1;
    const fn = { 'l-cut': d => splitEdit(d, get(d, ai), get(d, bi), 'l-cut', lead), 'j-cut': d => splitEdit(d, get(d, ai), get(d, bi), 'j-cut', lead),
      smash: d => smashCut(d, get(d, ai), get(d, bi)), action: d => cutOnAction(d, get(d, ai), get(d, bi)) }[id];
    const r = await tryEdit(app, fn, withSound);
    const room = r?.tight ? (id === 'l-cut' ? ` (there was no spare sound after the first clip, so its picture now ends ${r.lead.toFixed(1)} s sooner and what follows on that track moved up)` : ` (there was no spare sound before the next clip, so its picture now skips its first ${r.lead.toFixed(1)} s and what follows on that track moved up)`) : '';
    const where = r?.own ? 'Both sounds are on clips of their own now; drag where they meet to change it.' : 'Drag where the sound clips meet to change it.';
    done(r, id === 'l-cut' ? `L-cut: the first shot’s sound carries on ${r?.lead?.toFixed(1)} s under the next picture${room}. ${where}`
      : id === 'j-cut' ? `J-cut: the next shot’s sound starts ${r?.lead?.toFixed(1)} s before its picture${room}. ${where}`
      : `${name} at ${fmtT(clipEnd(p[0]))}.`);
    return;
  }
  if (id === 'jump') {
    const t = app.player.time, sel = selected(app).filter(c => visual(doc, c) && c.start < t && clipEnd(c) > t);
    const c = sel[0] || doc.clips.filter(c => visual(doc, c) && c.start < t && clipEnd(c) > t).sort((p, q) => doc.tracks.findIndex(x => x.id === p.track) - doc.tracks.findIndex(x => x.id === q.track))[0];
    if (!c) { toast('Put the playhead inside a video clip, where it should jump.'); return; }
    const r = await tryEdit(app, d => jumpCut(d, d.clips.find(x => x.id === c.id), t), withSound);
    done(r, `Jump cut: ${r?.skipped?.toFixed(1)} s cut out, with a punch-in (what follows on that track moved up). Do it again further on to punch back out.`);
    return;
  }
  if (id === 'cutaway') {
    const shot = selected(app).find(c => visual(doc, c));
    if (!shot) { toast('Select the shot to cut away to, then put the playhead over the main shot where it should appear.', 6000); return; }
    const t = app.player.time, main = doc.clips.find(c => c !== shot && visual(doc, c) && c.start <= t && clipEnd(c) > t);
    const r = await tryEdit(app, d => cutaway(d, main && d.clips.find(x => x.id === main.id), d.clips.find(x => x.id === shot.id), t), withSound);
    if (r) { app.select(r.ids, null); done(r, 'Cutaway: the shot plays over the main one for 2.5 s, muted, so the main sound carries on. The original clip is still where it was; delete it if you don’t need it.'); }
    return;
  }
  if (id === 'cross') {
    const two = selected(app).filter(c => visual(doc, c)).sort((p, q) => p.start - q.start);
    if (two.length !== 2) { toast('Select two clips that follow each other on one track (scene A, then scene B).', 6000); return; }
    const r = await tryEdit(app, d => crossCut(d, d.clips.find(x => x.id === two[0].id), d.clips.find(x => x.id === two[1].id), 2.5, 0.15), withSound);
    done(r, `Cross-cut: ${r?.pieces} pieces, turn about, each a little shorter. ⌘Z undoes.`);
  }
}
const fmtT = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/** Beat times (timeline s) from the music in the edit, or [] if there's none. */
async function editBeats(app, onStatus) {
  const doc = app.doc, out = [];
  const songs = doc.clips.filter(c => c.type === 'media' && !c.disabled && !c.audio?.mute && musicLike(doc, c));
  for (const c of songs.slice(0, 3)) {
    const m = mediaById(doc, c.media), sp = c.speed || 1;
    try { const r = await musicAnalyse(app, m, c.in || 0, c.duration * sp, onStatus); for (const t of r.grid.times) out.push(c.start + t / sp); }
    catch { /* not analysable: skip */ }
  }
  return out.sort((a, b) => a - b);
}

/** The style pack dialog: options, then apply (with the sounds), as one ⌘Z. */
export function openStyle(app, id) {
  const st = STYLES[id], doc = app.doc; if (!st || !doc) return;
  const hasMusic = doc.clips.some(c => c.type === 'media' && musicLike(doc, c));
  const beats = el('input', { type: 'checkbox', checked: !!st.beats && hasMusic, disabled: !hasMusic });
  const titles = el('input', { type: 'checkbox', checked: true });
  const sounds = el('input', { type: 'checkbox', checked: (() => { try { return localStorage.getItem('reel.presetSound') !== '0'; } catch { return true; } })() });
  const note = el('p', { class: 'note' });
  const prev = el('div', { class: 'sty-prev' }, tile('style', id, st.name, () => {}));
  modal(`🎬 ${st.name}`, el('div', { class: 'sty' }, prev,
    el('p', { text: st.hint + '.' }),
    el('label', { class: 'row kit-langs' }, beats, el('span', { text: hasMusic ? 'Snap the cuts to the music’s beat (moves each cut up to a third of a second)' : 'Snap the cuts to the beat (add music to the edit first)' })),
    el('label', { class: 'row kit-langs' }, titles, el('span', { text: 'Titles and title cards (you can change their words after)' })),
    el('label', { class: 'row kit-langs' }, sounds, el('span', { text: 'Sound effects' })),
    randomRow(), note,
    el('p', { class: 'note', text: 'Everything it adds is ordinary: change any transition, title or graphic afterwards. The graphics go on a Style track at the top. ⌘Z takes the whole style off again.' })), [
    ...(doc.styleId ? [{ label: 'Remove style', onClick: close => { app.commit(d => removeStyle(d)); close(); toast('Style taken off (its titles, graphics, look, moves and sounds). The transitions stay; ⌘Z for those.', 6000); } }] : []),
    { label: 'Cancel', onClick: close => close() },
    { label: 'Apply style', cls: 'hw amber', onClick: async (close, btn) => {
      btn.disabled = true;
      let bt = null;
      if (beats.checked) { note.textContent = 'Listening for the beat…'; bt = await editBeats(app, t => { note.textContent = t; }); }
      const o = { randomize: Number(pref('transRandom')) || 0, beats: bt, titles: titles.checked, seed: Date.now() };
      const test = applyStyle(structuredClone(app.doc), id, o); // a dry run: errors change nothing, and which sounds it needs
      if (test?.error) { note.textContent = test.error; btn.disabled = false; return; }
      const medias = new Map();
      if (sounds.checked) { try { for (const s of new Set(test.sfx.map(x => x.id))) medias.set(s, await sfxMedia(app, s)); } catch (e) { note.textContent = e.message; } }
      let r = null;
      app.commit(d => { r = applyStyle(d, id, o); if (sounds.checked) placeSfx(d, r.sfx, medias, id); }); // one ⌘Z for all of it
      close();
      if (panel) { panel.remove(); panel = null; } // out of the way, so the result shows in the preview
      app.player.seek?.(0);
      toast(`${st.name}: ${r.cuts} cut${r.cuts === 1 ? '' : 's'}${r.snapped ? ` (${r.snapped} moved onto the beat)` : ''}, the look, titles and graphics (${r.added.length} on the Style track)${sounds.checked ? ', sounds' : ''}. ⌘Z undoes it.`, 7000);
    } },
  ]);
  void mainTrack;
}
