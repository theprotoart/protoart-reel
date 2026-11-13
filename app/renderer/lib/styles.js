// Style packs: one click gives the whole edit a style — the transitions on the cuts (and how wild they get), a
// colour look, camera moves, titles and graphics, sound effects, and (optionally) cuts snapped to the music's beat.
// Every name here is Reel's own; the looks are made from Reel's filters, elements and text animations.
// Pure functions on the project (run inside app.commit); the sound effects come back as a list to place.
import { CUT_TRANSITIONS, cutsOn, applyCut, clipEnd, mediaById, uid, addTrack, isFree, advanceStart, setEnd,
  newTextClip, newShapeClip, newElementClip, TEXT_DEFAULTS, OVERLAP_CUTS } from '../model.js';
import { SFX_FOR } from './sfx.js';
import { applyMotion } from '../motion.js';
import { elementHome } from './elements.js';
import { tailRoom, headRoom } from './filmcuts.js';

// ------------------------------------------------------------------ randomize
/** How hard each cut transition hits: the Randomize slider swaps in others of the same kind first. */
export const ENERGY = {
  soft: ['fade', 'dip-black', 'dip-white', 'blur-through', 'light-leak', 'lens-defocus', 'flare-sweep', 'match-graphic', 'film-burn', 'film-burn-vintage'],
  medium: ['zoom-through', 'whip-through', 'spin-through', 'match-move', 'fast-wipe', 'warp-zoom', 'shutter', 'chroma-split', 'vertigo', 'exposure-burn', 'slide-left', 'push-left'],
  hard: ['flash-cut', 'glitch-cut', 'glitch-blocks', 'shake-cut', 'punch-zoom', 'slide-shake'],
};
const ALL = [...new Set([...ENERGY.soft, ...ENERGY.medium, ...ENERGY.hard, ...CUT_TRANSITIONS.map(c => c[0]).filter(t => t !== 'text-reveal')])];
export const energyOf = t => Object.keys(ENERGY).find(k => ENERGY[k].includes(t)) || 'medium';

/** A small seeded random generator (the same seed gives the same mix). */
export function seeded(seed = Date.now()) {
  let a = seed >>> 0 || 1;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/**
 * The transition for cut i of a pack's list. amount 0 follows the list in order; up to ½ swaps some for others of the
 * same kind (soft, medium, hard); above ½ some can be anything at all; 1 is a surprise mix.
 */
export function pickTransition(list, i, amount = 0, rng = Math.random) {
  const base = list[i % list.length];
  if (!(amount > 0) || rng() >= amount) return base;
  const wide = rng() < Math.max(0, amount - 0.5) * 2;
  const pool = wide ? ALL : [...new Set([...list, ...ENERGY[energyOf(base)]])];
  return pool[Math.floor(rng() * pool.length)] || base;
}
/** A transition's length, varied by up to ±30 % at full Randomize. */
export const jitter = (dur, amount = 0, rng = Math.random) => Math.max(0.15, dur * (1 + (rng() * 2 - 1) * 0.3 * (amount || 0)));

// ------------------------------------------------------------------ beat-snapped cuts
/**
 * Moves each cut on the track to the nearest beat (timeline seconds) within maxShift, as a roll edit: the clip
 * before gets longer by what the one after loses, so nothing else moves. Sounds detached from those clips move
 * with them. Returns how many cuts moved.
 */
export function snapCutsToBeats(doc, trackId, beats, maxShift = 0.35) {
  if (!beats?.length) return 0;
  let n = 0;
  for (const [a, b] of cutsOn(doc, trackId)) {
    if (a.retime || b.retime || a.locked || b.locked) continue;
    const cut = b.start;
    let best = null; for (const t of beats) if (Math.abs(t - cut) <= maxShift && (best == null || Math.abs(t - cut) < Math.abs(best - cut))) best = t;
    if (best == null) continue;
    let d = best - cut;
    if (Math.abs(d) < 0.01) continue;
    if (d > 0 && (tailRoom(doc, a) < d || b.duration - d < 0.4)) continue;
    if (d < 0 && (headRoom(b) < -d || a.duration + d < 0.4)) continue;
    const sa = a.detached && doc.clips.find(x => x.id === a.detached), sb = b.detached && doc.clips.find(x => x.id === b.detached);
    const pair = sa && sb && Math.abs(clipEnd(sa) - cut) < 0.02 && Math.abs(sb.start - cut) < 0.02;
    delete a.xfadeOut; delete b.xfadeIn; delete a.xfAuto; delete b.xfAuto;
    for (const [x, y] of pair ? [[a, b], [sa, sb]] : [[a, b]]) { setEnd(x, x.duration + d); advanceStart(y, d); y.start += d; y.duration -= d; }
    n++;
  }
  return n;
}

// ------------------------------------------------------------------ the styles
const look = (name, amount = 1) => ({ type: 'look', look: name, amount });
const T = (content, text, props = {}) => ({ content, text, props });

/**
 * Each style: list (cut transitions, in order), dur (their length), ramp (trailers: soft list first, hard list
 * later), cutSfx (a sound for every cut instead of each transition's own; null: none), filters (on every video
 * and picture), motion (keyframed camera moves, taking turns), beats (snap cuts to the music by default),
 * overlays: [{ when, len, element | title | card, … }] — when: 'start' | 'second' | 'third' | 'end' | 'whole' | 0..1 (of the edit).
 */
export const STYLES = {
  documentary: {
    name: 'Nature Documentary', hint: 'Slow Ken Burns moves, soft dissolves and dips, gold serif lower thirds, a typed location stamp, light grain',
    colors: ['#1d2a1f', '#f2ead8', '#d4a64a'], list: ['fade', 'lens-defocus', 'dip-black', 'blur-through', 'match-graphic'], dur: 1.1, cutSfx: null,
    filters: [look('warm', 0.5), { type: 'vignette', amount: 0.25 }, { type: 'grain', amount: 0.15 }, { type: 'letterbox', ratio: 2 }],
    motion: ['kenIn', 'kenOut'],
    overlays: [
      { when: 'start', len: 4.2, card: false, title: T('THE WILD COAST', { font: 'Georgia', size: 120, weight: 400, anim: 'tracking', animDur: 1.4, shadow: 18, color: '#f2ead8' }, { y: 0.48 }), sfx: 'boom' },
      { when: 'second', len: 5.5, element: 'docLower' },
      { when: 'third', len: 4.5, element: 'locStamp' },
    ] },
  fizz: {
    name: 'Fizz Commercial', hint: 'Fast cuts on the beat, slide + shake, punch zooms and flashes, slammed bold words, rising bubbles, popping colour',
    colors: ['#0a3fd6', '#ffffff', '#ff2d55'], list: ['slide-shake', 'punch-zoom', 'flash-cut', 'whip-through', 'glitch-blocks', 'fast-wipe'], dur: 0.35, beats: true,
    filters: [look('punchy', 1), { type: 'color', saturation: 0.12, vibrance: 0.25, contrast: 0.1 }],
    motion: ['punchIn', 'zoomHit'],
    overlays: [
      { when: 'whole', element: 'bubbles', opacity: 0.75 },
      { when: 'start', len: 2.4, title: T('TASTE THE RUSH', { font: 'Impact', size: 180, weight: 900, anim: 'stampWords', animDur: 0.5, stroke: 7, strokeColor: '#0a3fd6', shadow: 22, color: '#ffffff' }, { y: 0.5 }), sfx: 'hit' },
      { when: 'end', len: 2.6, title: T('ICE COLD.', { font: 'Impact', size: 200, weight: 900, anim: 'gravity', animDur: 0.8, stroke: 8, strokeColor: '#ff2d55', shadow: 24, color: '#ffffff' }, { y: 0.5 }), sfx: 'pop' },
    ] },
  trailer: {
    name: 'Movie Trailer', hint: 'Black title cards with deep booms, scope letterbox, teal & orange; gentle at first, then harder and faster cuts',
    colors: ['#05070a', '#e8e2d4', '#ff8a3d'], ramp: [['fade', 'dip-black', 'lens-defocus', 'blur-through'], ['flash-cut', 'punch-zoom', 'vertigo', 'whip-through', 'flash-cut']], dur: 0.6,
    cutSfx: (i, n) => (i >= n / 2 ? 'hit' : null),
    filters: [look('tealOrange', 0.85), { type: 'letterbox', ratio: 2.39 }, { type: 'grain', amount: 0.2 }, { type: 'vignette', amount: 0.35 }],
    motion: ['kenIn'],
    overlays: [
      { when: 'start', len: 2.6, card: true, title: T('THIS SUMMER', { font: 'Didot', size: 110, weight: 400, anim: 'tracking', animDur: 1.6, shadow: 0, color: '#e8e2d4' }, { y: 0.5 }), sfx: 'boom' },
      { when: 0.55, len: 2, card: true, title: T('EVERYTHING CHANGES', { font: 'Didot', size: 100, weight: 400, anim: 'blurIn', animDur: 0.9, shadow: 0, color: '#e8e2d4' }, { y: 0.5 }), sfx: 'boom' },
      { when: 'end', len: 3.2, card: true, title: T('YOUR TITLE', { font: 'Didot', size: 170, weight: 700, anim: 'tracking', animDur: 1.2, shadow: 0, color: '#ffffff' }, { y: 0.46 }), sfx: 'boom',
        sub: T('COMING SOON', { font: 'Avenir Next', size: 40, weight: 600, anim: 'fade', animDur: 1, shadow: 0, color: '#ff8a3d' }, { y: 0.62 }) },
    ] },
  vhs: {
    name: 'Retro VHS', hint: 'Tracking lines, PLAY ▶ and a date stamp, colour bleed, glitch blocks, and a tape-stop at the end',
    colors: ['#16121f', '#f4f1e8', '#00e5ff'], list: ['glitch-cut', 'glitch-blocks', 'chroma-split', 'shake-cut'], dur: 0.35,
    filters: [look('vintage', 1), { type: 'aberration', amount: 0.45 }, { type: 'grain', amount: 0.45 }, { type: 'color', saturation: -0.15, contrast: -0.05 }],
    overlays: [{ when: 'whole', element: 'vhs' }, { when: 'end', len: 0, sfxOnly: 'tapestop' }] },
  sports: {
    name: 'Sports Highlight', hint: 'Whips, punch zooms and flashes on the beat, a score bug, and an instant replay at half speed to finish',
    colors: ['#0a2a66', '#ffffff', '#ffcc00'], list: ['whip-through', 'punch-zoom', 'flash-cut', 'slide-shake', 'zoom-through'], dur: 0.35, beats: true,
    filters: [look('crisp', 1), look('punchy', 0.5)],
    motion: ['punchIn'],
    replay: true,
    overlays: [{ when: 'whole', element: 'scoreBug' }] },
  travel: {
    name: 'Travel Vlog', hint: 'Whip pans and movement match cuts, an animated route map, handwritten captions, warm colour',
    colors: ['#0d4a5a', '#fff6e8', '#ff7a45'], list: ['whip-through', 'match-move', 'warp-zoom', 'slide-left', 'zoom-through'], dur: 0.5,
    filters: [look('warm', 0.6), { type: 'color', vibrance: 0.2 }],
    motion: ['panLR', 'panRL', 'kenIn'],
    overlays: [
      { when: 'start', len: 4.5, element: 'routeMap' },
      { when: 'third', len: 3.5, title: T('Day 1 — first stop', { font: 'Marker Felt', size: 92, weight: 400, anim: 'fadeChars', animDur: 0.6, shadow: 14, color: '#ffffff' }, { y: 0.82 }) },
    ] },
  news: {
    name: 'Breaking News', hint: 'A scrolling ticker, red and white bars, fast wipes and whooshes between stories',
    colors: ['#0d1424', '#ffffff', '#d71920'], list: ['fast-wipe', 'whip-through', 'push-left'], dur: 0.45,
    filters: [look('crisp', 0.8)],
    overlays: [{ when: 'whole', element: 'newsTicker', sfx: 'whoosh' }] },
};

// ------------------------------------------------------------------ applying
const isPicture = (doc, c) => c.type === 'media' && !c.audioOnly && ['video', 'image'].includes(mediaById(doc, c.media)?.kind);
/** The track with the most video or pictures on it: the one whose cuts set the pace. */
export function mainTrack(doc) {
  const by = new Map();
  for (const c of doc.clips) if (isPicture(doc, c)) by.set(c.track, (by.get(c.track) || 0) + c.duration);
  let best = null, n = 0; for (const [t, d] of by) if (d > n) { n = d; best = t; }
  return best;
}

/** Takes off what a style put on (its clips, tracks, filters and camera moves). Transitions stay (⌘Z for those). */
export function removeStyle(doc) {
  doc.clips = doc.clips.filter(c => !c.style);
  for (const c of doc.clips) {
    if (c.filters) c.filters = c.filters.filter(f => !f.style);
    if (c.styleMotion) { if (c.keys) for (const k of Object.keys(c.keys)) if (k.startsWith('props.')) delete c.keys[k]; if (c.keys && !Object.keys(c.keys).length) delete c.keys; delete c.styleMotion; }
  }
  doc.tracks = doc.tracks.filter(t => !t.style || doc.clips.some(c => c.track === t.id));
  delete doc.styleId;
}

/** A track for an overlay, at the top: a style track that's free then, else a new one. */
function topTrack(doc, start, dur) {
  for (const t of doc.tracks) if (t.style && isFree(doc, t.id, start, dur)) return t.id;
  const t = addTrack(doc, 0); t.name = 'Style'; t.style = true; return t.id;
}
function textClip(spec, start, len, style) {
  const c = newTextClip(null, start, spec.content);
  c.text = { ...TEXT_DEFAULTS, ...spec.text, content: spec.content };
  Object.assign(c.props, spec.props);
  c.duration = len; c.name = spec.content.slice(0, 24); c.style = style;
  c.transIn = { type: 'none', dur: 0.3 }; c.transOut = { type: 'fade', dur: 0.3 };
  return c;
}

/**
 * Applies style `id` to the edit. opts: { randomize 0..1, beats [timeline s] (to snap the cuts to, or null),
 * seed, titles (false: no words or cards), cardsOver (false: no black cards) }.
 * Returns { cuts, snapped, sfx: [{ id, at }], added: [clip ids] }.
 */
export function applyStyle(doc, id, opts = {}) {
  const st = STYLES[id]; if (!st) return { error: 'Unknown style' };
  const rng = seeded(opts.seed ?? Date.now()), amount = opts.randomize || 0;
  removeStyle(doc);
  doc.styleId = id;
  const pics = doc.clips.filter(c => isPicture(doc, c));
  if (!pics.length) return { error: 'Add some video or pictures first: a style works on the cuts between them.' };
  const t0 = Math.min(...pics.map(c => c.start)), t1 = Math.max(...pics.map(c => clipEnd(c)));
  const main = mainTrack(doc), sfx = [], added = [];

  // 1. the pace: cuts on the beat
  const snapped = opts.beats?.length ? snapCutsToBeats(doc, main, opts.beats) : 0;

  // 2. an instant replay to finish (sports)
  if (st.replay) {
    const last = doc.clips.filter(c => c.track === main && isPicture(doc, c) && mediaById(doc, c.media)?.kind === 'video').sort((p, q) => clipEnd(q) - clipEnd(p))[0];
    if (last && last.duration >= 1.2 && !last.retime && isFree(doc, main, clipEnd(last), 5)) {
      const r = structuredClone(last); r.id = uid('c'); delete r.group; delete r.detached; delete r.keys; r.actions = [];
      const len = Math.min(2, last.duration);
      advanceStart(r, last.duration - len); r.duration = len;
      r.start = clipEnd(last); r.speed = (last.speed || 1) * 0.5; r.duration = len * 2;
      r.audio = { ...(r.audio || {}), mute: true }; r.style = id; r.name = 'Instant replay';
      r.transIn = { type: 'none', dur: 0.3 }; r.transOut = { type: 'none', dur: 0.3 }; delete r.xfadeIn; delete r.xfadeOut;
      doc.clips.push(r); added.push(r.id);
      const bug = newElementClip(null, r.start, 'replayBug', elementHome('replayBug'), r.duration); bug.style = id; bug.name = 'Replay badge';
      bug.track = topTrack(doc, bug.start, bug.duration); doc.clips.push(bug); added.push(bug.id);
      sfx.push({ id: 'whoosh', at: r.start });
    }
  }

  // 3. transitions on every cut between pictures (all tracks), and their sounds
  const pairs = doc.tracks.flatMap(t => cutsOn(doc, t.id)).filter(([a, b]) => isPicture(doc, a) && isPicture(doc, b));
  pairs.sort((p, q) => p[1].start - q[1].start);
  pairs.forEach(([a, b], i) => {
    if (b.name === 'Instant replay' && b.style) { applyCut(a, b, 'flash-cut', 0.3); sfx.push({ id: 'hit', at: b.start }); return; }
    const list = st.ramp ? st.ramp[i / Math.max(1, pairs.length) < 0.5 ? 0 : 1] : st.list;
    let type = pickTransition(list, i, amount, rng);
    let dur = jitter(st.dur, amount, rng);
    if (st.ramp) dur *= 1 - 0.5 * (i / Math.max(1, pairs.length)); // trailers speed up
    if (OVERLAP_CUTS.has(type) && (a.duration < 0.6 || b.duration < 0.6)) type = 'flash-cut';
    applyCut(a, b, type, dur);
    const s = st.cutSfx === undefined ? SFX_FOR[type] : typeof st.cutSfx === 'function' ? st.cutSfx(i, pairs.length, type) : st.cutSfx;
    if (s) sfx.push({ id: s, at: b.start });
  });

  // 4. the look and the camera moves, on every video and picture
  let turn = 0;
  for (const c of doc.clips.filter(x => isPicture(doc, x)).sort((p, q) => p.start - q.start)) {
    c.filters ||= [];
    for (const f of st.filters || []) c.filters.push({ id: uid('f'), ...f, style: id });
    const hasMoves = c.keys && Object.keys(c.keys).some(k => k.startsWith('props.'));
    if (st.motion?.length && !hasMoves && c.duration >= 1 && c.name !== 'Instant replay') {
      if (applyMotion(c, st.motion[turn++ % st.motion.length])) c.styleMotion = true;
    }
  }

  // 5. titles, cards and graphics
  const shots = doc.clips.filter(c => c.track === main && isPicture(doc, c)).sort((p, q) => p.start - q.start);
  const whenAt = (w, len) => w === 'start' ? t0 + 0.2 : w === 'second' ? (shots[1]?.start ?? t0 + 4.5) + 0.3 : w === 'third' ? (shots[2]?.start ?? t0 + 10) + 0.3
    : w === 'end' ? Math.max(t0, t1 - len) : w === 'whole' ? t0 : t0 + (t1 - t0) * w;
  for (const o of st.overlays || []) {
    if (o.sfxOnly) { sfx.push({ id: o.sfxOnly, at: Math.max(t0, t1 - 1) }); continue; }
    if (o.title && opts.titles === false) continue;
    const len = o.when === 'whole' ? t1 - t0 : Math.min(o.len, t1 - t0);
    let at = whenAt(o.when, len);
    if (at + len > t1 + 0.01) at = Math.max(t0, t1 - len);
    if (len < 0.5) continue;
    const put = c => { c.track = topTrack(doc, c.start, c.duration); doc.clips.push(c); added.push(c.id); };
    const words = [];
    if (o.title) { const c = textClip(o.title, at + (o.card ? 0.2 : 0), len - (o.card ? 0.2 : 0), id); put(c); words.push(c); }
    if (o.sub) { const c = textClip(o.sub, at + 0.8, len - 0.8, id); put(c); words.push(c); }
    if (o.card && opts.cardsOver !== false) { // the black card goes under its words
      const k = newShapeClip(null, at); k.duration = len; k.style = id; k.name = 'Title card';
      k.shape = { ...k.shape, shape: 'rect', x1: -0.02, y1: -0.02, x2: 1.02, y2: 1.02, color: '#000000', width: 0, fill: true, fillOpacity: 1 };
      k.transIn = { type: 'fade', dur: 0.25 }; k.transOut = { type: 'fade', dur: 0.3 };
      const below = Math.max(-1, ...words.map(w => doc.tracks.findIndex(t => t.id === w.track)));
      let tr = doc.tracks.find((t, i) => i > below && t.style && isFree(doc, t.id, k.start, k.duration));
      if (!tr) { tr = addTrack(doc, below + 1); tr.name = 'Style'; tr.style = true; }
      k.track = tr.id; doc.clips.push(k); added.push(k.id);
    }
    if (o.element) {
      const e = newElementClip(null, at, o.element, elementHome(o.element), len); e.style = id; e.name = o.element;
      if (o.opacity != null) e.props.opacity = o.opacity;
      put(e);
    }
    if (o.sfx) sfx.push({ id: o.sfx, at: at + 0.1 });
  }
  return { cuts: pairs.length, snapped, sfx, added };
}
