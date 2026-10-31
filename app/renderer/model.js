// Project model for ProtoArt Reel: clips on tracks, timing math, editing operations and undo.
// Pure functions over a plain JSON document, shared by the editor and the export worker.

import { pref } from './prefs.js';
export const EPS = 1e-6;
export const uid = (p = 'c') => p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const DEFAULT_PROPS = Object.freeze({ x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, crop: [0, 0, 0, 0], radius: 0, shadow: 0, border: 0, borderColor: '#ffffff' });
export const ANIMATABLE = ['x', 'y', 'scale', 'rotation', 'opacity', 'crop', 'radius', 'shadow'];

export const TEXT_DEFAULTS = Object.freeze({
  content: 'Your title', font: 'Avenir Next', weight: 800, size: 96, color: '#ffffff', align: 'center',
  bg: '#000000', bgOpacity: 0, padding: 24, stroke: 0, strokeColor: '#000000', shadow: 12, lineHeight: 1.15,
  anim: 'fade', animDur: 0.4, italic: false, width: 0.8,
});

export const CALLOUT_DEFAULTS = Object.freeze({ shape: 'rect', x: 0.5, y: 0.5, w: 0.3, h: 0.2, dim: 0.6, blur: 0, zoom: 1, feather: 0.02, radius: 0.02, outline: 0, outlineColor: '#ffb02a' });
export const SHAPE_DEFAULTS = Object.freeze({ shape: 'arrow', x1: 0.35, y1: 0.35, x2: 0.6, y2: 0.55, color: '#ff3b30', width: 12, fill: false });
export const CURSOR_DEFAULTS = Object.freeze({ show: true, scale: 1.5, highlight: false, highlightColor: '#ffd60a', highlightSize: 60, clickRings: true, smooth: 0.2, hideIdle: false });

export const EASES = {
  linear: t => t,
  ease: t => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  in: t => t * t,
  out: t => 1 - (1 - t) * (1 - t),
};

// ------------------------------------------------------------------ queries

export function mediaById(doc, id) { return doc.media.find(m => m.id === id) || null; }
export function trackIndex(doc, trackId) { return doc.tracks.findIndex(t => t.id === trackId); }
export const clipEnd = c => c.start + c.duration;
/**
 * Crossfades on one track: where two clips meet, each can play on past the cut for half the crossfade
 * (from its own source, its "handle"), so the incoming picture and sound blend over the outgoing ones without
 * a second layer. xfadeIn / xfadeOut are the crossfade's full length, centred on the cut.
 */
export const spanStart = c => c.start - (c.xfadeIn || 0) / 2;
export const spanEnd = c => c.start + c.duration + (c.xfadeOut || 0) / 2;
export function duration(doc) { let d = 0; for (const c of doc.clips) d = Math.max(d, clipEnd(c)); return d; }
export function clipsOnTrack(doc, trackId) { return doc.clips.filter(c => c.track === trackId).sort((a, b) => a.start - b.start); }

/** Clips showing at time t, bottom track first (draw order). */
export function activeClips(doc, t) {
  const out = [];
  for (let i = doc.tracks.length - 1; i >= 0; i--) {
    const tr = doc.tracks[i];
    if (tr.hidden) continue;
    // detached audio clips are heard, not drawn
    const here = [];
    for (const c of doc.clips) if (c.track === tr.id && !c.audioOnly && !c.disabled && t >= spanStart(c) - EPS && t < spanEnd(c) - EPS) here.push(c);
    // in a crossfade the incoming clip is drawn over the outgoing one
    if (here.length > 1) here.sort((a, b) => a.start - b.start);
    out.push(...here);
  }
  return out;
}

/** Source time (seconds into the media) shown at timeline time t. */
export const sourceTime = (c, t) => (c.in || 0) + (t - c.start) * (c.speed || 1);

function lerp(a, b, k) {
  if (Array.isArray(a)) return a.map((v, i) => v + ((b?.[i] ?? v) - v) * k);
  return a + (b - a) * k;
}

/** Visual properties of a clip at local time (seconds from its start), with actions applied. */
export function propsAt(c, local) {
  let p = { ...DEFAULT_PROPS, ...(c.props || {}) };
  if (c.actions && c.actions.length) {
    for (const a of [...c.actions].sort((x, y) => x.t - y.t)) {
      if (local < a.t) break;
      const target = { ...p, ...a.props };
      const k = a.dur > 0 ? clamp((local - a.t) / a.dur, 0, 1) : 1;
      const e = (EASES[a.ease] || EASES.ease)(k);
      const next = { ...p };
      for (const key of ANIMATABLE) if (a.props && key in a.props) next[key] = lerp(p[key], target[key], e);
      p = next;
    }
  }
  // transitions in/out shape opacity / position / scale
  const d = c.duration;
  const tin = c.transIn && c.transIn.type !== 'none' ? c.transIn : null;
  const tout = c.transOut && c.transOut.type !== 'none' ? c.transOut : null;
  p.dip = null; p.mask = null; p.glitch = 0; p.leak = 0; p.burn = 0;
  if (tin && local < tin.dur) applyTransition(p, tin, EASES.ease(clamp(local / tin.dur, 0, 1)), 'in');
  if (tout && local > d - tout.dur) applyTransition(p, tout, EASES.ease(clamp((d - local) / tout.dur, 0, 1)), 'out');
  // crossfade in: the incoming picture fades up over the outgoing one (which stays solid underneath)
  const xi = c.xfadeIn || 0;
  if (xi > 0 && local < xi / 2) p.opacity *= clamp((local + xi / 2) / xi, 0, 1);
  return p;
}

function applyTransition(p, tr, k, dir) {
  switch (tr.type) {
    case 'fade': p.opacity *= k; break;
    case 'dip-black': case 'dip-white': p.opacity *= k; p.dip = { color: tr.type === 'dip-black' ? '#000' : '#fff', amount: 1 - k }; break;
    case 'slide-left': p.x += (dir === 'in' ? 1 : -1) * (1 - k); break;
    case 'slide-right': p.x -= (dir === 'in' ? 1 : -1) * (1 - k); break;
    case 'slide-up': p.y += (dir === 'in' ? 1 : -1) * (1 - k); break;
    case 'zoom': p.scale *= 0.6 + 0.4 * k; p.opacity *= k; break;
    case 'pop': p.scale *= k < 1 ? 0.5 + 0.6 * k - 0.1 * k * k : 1; p.opacity *= Math.min(1, k * 2); break;
    case 'blur': p.blur = (1 - k) * 30; p.opacity *= k; break;
    // the transition pack: moves
    case 'slide-down': p.y -= (dir === 'in' ? 1 : -1) * (1 - k); break;
    case 'push-left': p.x += (dir === 'in' ? 1 : -1) * (1 - k); p.scale *= 0.92 + 0.08 * k; break;
    case 'push-right': p.x -= (dir === 'in' ? 1 : -1) * (1 - k); p.scale *= 0.92 + 0.08 * k; break;
    case 'whip-left': { const e = k * k; p.x += (dir === 'in' ? 1 : -1) * (1 - e) * 1.2; p.blur = (1 - k) * 60; break; }
    case 'whip-right': { const e = k * k; p.x -= (dir === 'in' ? 1 : -1) * (1 - e) * 1.2; p.blur = (1 - k) * 60; break; }
    case 'rise': p.y += (1 - k) * 0.08 * (dir === 'in' ? 1 : -1); p.opacity *= k; break;
    case 'drop': { const b = 1 - k; p.y -= b * b * 1.1 * (dir === 'in' ? 1 : -1); p.opacity *= Math.min(1, k * 3); break; }
    case 'spin': p.rotation = (p.rotation || 0) + (dir === 'in' ? -1 : 1) * 180 * (1 - k); p.scale *= 0.3 + 0.7 * k; p.opacity *= Math.min(1, k * 2); break;
    case 'zoom-out': p.scale *= 1 + 0.6 * (1 - k); p.opacity *= k; break;
    case 'elastic': { const e = k <= 0 ? 0 : k >= 1 ? 1 : 2 ** (-9 * k) * Math.sin((k * 9 - 0.75) * (2 * Math.PI) / 3) + 1; p.scale *= Math.max(0.01, e); p.opacity *= Math.min(1, k * 4); break; }
    case 'glitch': {
      const j = Math.sin(k * 97.13) * 43758.5453, r = j - Math.floor(j);
      p.x += (1 - k) * (r - 0.5) * 0.12; p.opacity *= k < 0.85 ? (r > 0.35 ? 1 : 0.2) : 1; p.glitch = 1 - k; break;
    }
    case 'flash': p.opacity *= Math.min(1, k * 1.5); p.dip = { color: '#fff', amount: Math.max(0, 1 - k * 1.6) }; break;
    // cut transitions: the same type on both sides of a cut, so the outgoing shot hands over to the incoming one
    case 'zoom-through': { const e = 1 - k; p.scale *= dir === 'out' ? 1 + e * e * 2.2 : 1 + e * e * 1.4; p.blur = e * e * 40; break; }
    case 'spin-through': { const e = 1 - k; p.rotation = (p.rotation || 0) + (dir === 'out' ? 1 : -1) * e * e * 90; p.scale *= 1 + e * 0.5; p.blur = e * e * 30; break; }
    case 'whip-through': { const e = 1 - k; p.x += (dir === 'out' ? -1 : 1) * e * e * 0.9; p.blur = e * 70; break; }
    case 'blur-through': p.blur = (1 - k) * 45; p.scale *= 1 + (1 - k) * 0.08; break;
    case 'light-leak': p.leak = Math.max(p.leak || 0, (1 - k) ** 1.5); break;
    case 'film-burn': p.leak = Math.max(p.leak || 0, (1 - k) ** 1.2); p.burn = 1; break;
    case 'flash-cut': p.dip = { color: '#fff', amount: (1 - k) ** 2 }; break;
    case 'glitch-cut': { const j = Math.sin(k * 151.7) * 43758.5453, r = j - Math.floor(j); p.x += (1 - k) * (r - 0.5) * 0.08; p.glitch = Math.max(p.glitch || 0, (1 - k)); break; }
    case 'shake-cut': { const e = 1 - k; p.x += Math.sin(k * 60) * 0.02 * e; p.y += Math.cos(k * 47) * 0.02 * e; p.scale *= 1 + e * 0.06; break; }
    // the transition pack: masks (the picture is revealed through a moving shape)
    case 'wipe-left': case 'wipe-right': case 'wipe-up': case 'wipe-down': case 'iris': case 'clock': case 'barn': case 'blinds': case 'diagonal':
      p.mask = { type: tr.type, k, dir }; break;
    default: break;
  }
}

/** Audio gain of a clip at local time (volume, fades, mute). */
export function gainAt(doc, c, local) {
  const a = (c.keys ? animated(c, local) : c).audio || {};
  const tr = doc.tracks.find(t => t.id === c.track);
  if (c.disabled || a.mute || (tr && tr.muted)) return 0;
  if (tr && !tr.solo && doc.tracks.some(t => t.solo)) return 0;
  let g = (a.volume ?? 1) * (tr ? trackGainAt(tr, c.start + local) : 1);
  const lc = clamp(local, 0, c.duration); // fades work on the clip itself, not its crossfade handles
  if (a.fadeIn > 0 && lc < a.fadeIn) g *= lc / a.fadeIn;
  if (a.fadeOut > 0 && lc > c.duration - a.fadeOut) g *= Math.max(0, (c.duration - lc) / a.fadeOut);
  // crossfades: equal-power, so the sound doesn't dip in the middle
  const xi = c.xfadeIn || 0, xo = c.xfadeOut || 0;
  if (xi > 0 && local < xi / 2) g *= Math.sin(clamp((local + xi / 2) / xi, 0, 1) * Math.PI / 2);
  if (xo > 0 && local > c.duration - xo / 2) g *= Math.cos(clamp((local - (c.duration - xo / 2)) / xo, 0, 1) * Math.PI / 2);
  // ducking: lower this clip while a clip marked as voice is sounding
  if (a.duck > 0 && doc.clips.some(o => o !== c && o.audio?.voice && o.start <= c.start + local && clipEnd(o) > c.start + local)) g *= 1 - a.duck;
  return g;
}

/** Pan of a clip at local time, -1 (left) … +1 (right): the clip's own pan plus its track's. */
export function panAt(doc, c, local) {
  const a = (c.keys ? animated(c, local) : c).audio || {};
  const tr = doc.tracks.find(t => t.id === c.track);
  return clamp((a.pan || 0) + (tr ? trackPanAt(tr, c.start + local) : 0), -1, 1);
}
/** Balance law: centre is unity on both sides; panning turns the other side down. */
export function panGains(p) { return [p > 0 ? 1 - p : 1, p < 0 ? 1 + p : 1]; }

// ------------------------------------------------------------------ keyframes & automation
// Clip keyframes live in c.keys = { 'group.param': [{ t (seconds from the clip start), v, ease }] },
// e.g. 'callout.x', 'props.scale', 'audio.volume'. Track automation lives in tr.auto = { volume, pan }
// with times on the timeline. Ease belongs to the segment leaving a key: linear | ease | hold.

export const KEY_EASES = [['linear', 'Linear'], ['ease', 'Smooth'], ['hold', 'Hold']];

/** Value of a sorted key list at time t (flat before the first key and after the last). */
export function keyAt(list, t, fallback) {
  if (!list || !list.length) return fallback;
  if (t <= list[0].t) return list[0].v;
  const last = list[list.length - 1];
  if (t >= last.t) return last.v;
  let lo = 0, hi = list.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (list[mid].t <= t) lo = mid; else hi = mid; }
  const a = list[lo], b = list[hi];
  if (a.ease === 'hold') return a.v;
  const k = (t - a.t) / Math.max(1e-9, b.t - a.t);
  return a.v + (b.v - a.v) * (a.ease === 'ease' ? EASES.ease(k) : k);
}
const splitPath = path => { const i = path.indexOf('.'); return [path.slice(0, i), path.slice(i + 1)]; };
export const keysOf = (c, path) => (c.keys && c.keys[path]) || null;
export const hasKeys = (c, path) => !!(c.keys && c.keys[path] && c.keys[path].length);
export const anyKeys = c => !!c.keys && Object.values(c.keys).some(l => l && l.length);

/** A copy of the clip with every keyframed parameter set to its value at local time. */
export function animated(c, local) {
  if (!c.keys) return c;
  let out = null;
  for (const path in c.keys) {
    const list = c.keys[path];
    if (!list || !list.length) continue;
    const [g, k] = splitPath(path);
    out ||= { ...c };
    if (out[g] === c[g]) out[g] = { ...(c[g] || {}) };
    out[g][k] = keyAt(list, local, out[g][k]);
  }
  return out || c;
}

/** Adds or moves a key at time t (an existing key within `tol` is updated instead). */
export function putKey(owner, path, t, v, tol = 1 / 60, ease) {
  owner.keys ||= {};
  const list = (owner.keys[path] ||= []);
  const ex = list.find(x => Math.abs(x.t - t) <= tol);
  if (ex) { ex.v = v; if (ease) ex.ease = ease; return ex; }
  const prev = [...list].reverse().find(x => x.t < t);
  const k = { t: Math.max(0, t), v, ease: ease || prev?.ease || 'linear' };
  list.push(k); list.sort((a, b) => a.t - b.t);
  return k;
}
export function removeKey(owner, path, t, tol = 1 / 60) {
  const list = owner.keys && owner.keys[path];
  if (!list) return;
  owner.keys[path] = list.filter(x => Math.abs(x.t - t) > tol);
  if (!owner.keys[path].length) delete owner.keys[path];
  if (!Object.keys(owner.keys).length) delete owner.keys;
}
/** Sets a keyable value at clip-local time: a keyframe once the parameter is animated, else the base value. */
export function setParam(c, path, local, v, tol) {
  if (hasKeys(c, path)) { putKey(c, path, local, v, tol); return; }
  const [g, k] = splitPath(path);
  c[g] ||= {};
  c[g][k] = v;
}
/** Value shown for a parameter at clip-local time. */
export function paramAt(c, path, local) {
  const [g, k] = splitPath(path);
  return hasKeys(c, path) ? keyAt(c.keys[path], local, c[g]?.[k]) : c[g]?.[k];
}
/** Shifts a clip's keys when its start moves by d seconds (trim, split); keys before 0 collapse onto 0. */
function shiftKeys(c, d, end) {
  if (!c.keys) return;
  for (const path of Object.keys(c.keys)) {
    const list = c.keys[path];
    const v0 = keyAt(list, d, null), v1 = end != null ? keyAt(list, d + end, null) : null;
    let moved = list.map(k => ({ ...k, t: k.t - d })).filter(k => k.t >= -1e-9 && (end == null || k.t <= end + 1e-9));
    // keep the value at the new edges so the motion doesn't jump
    if (v0 !== null && !moved.some(k => Math.abs(k.t) < 1e-6)) moved.unshift({ t: 0, v: v0, ease: 'linear' });
    if (v1 !== null && end != null && !moved.some(k => Math.abs(k.t - end) < 1e-6)) moved.push({ t: end, v: v1, ease: 'linear' });
    c.keys[path] = moved.sort((a, b) => a.t - b.t);
  }
}

export const TRACK_LANES = [['volume', 'Volume'], ['pan', 'Pan']];
/** Automation is read unless the track's mode is 'off' (then the knobs' fixed values apply). */
const autoList = (tr, lane) => (tr.autoMode !== 'off' && tr.auto && tr.auto[lane] && tr.auto[lane].length ? tr.auto[lane] : null);
export function trackGainAt(tr, t) { const l = autoList(tr, 'volume'); return l ? keyAt(l, t, 1) : (tr.volume ?? 1); }
export function trackPanAt(tr, t) { const l = autoList(tr, 'pan'); return l ? keyAt(l, t, 0) : (tr.pan ?? 0); }

/** Volume ↔ fader position (0…1): −∞ at the bottom, 0 dB at 80%, +6 dB at the top. */
export const gainToPos = g => (g <= 0.001 ? 0 : clamp((20 * Math.log10(g) + 54) / 60, 0, 1));
export const posToGain = p => (p <= 0.002 ? 0 : 10 ** ((p * 60 - 54) / 20));
export const fmtDb = g => (g <= 0.001 ? '−∞' : (g >= 1 ? '+' : '') + (20 * Math.log10(g)).toFixed(1));
export const fmtPan = p => (Math.abs(p) < 0.01 ? 'C' : (p < 0 ? 'L' : 'R') + Math.round(Math.abs(p) * 100));

// ------------------------------------------------------------------ building clips

export function newMediaClip(doc, media, trackId, start) {
  const dur = media.kind === 'image' ? Number(pref('imageDur')) || 5 : Math.max(0.1, media.duration || 5);
  return {
    id: uid('c'), type: 'media', media: media.id, track: trackId, start: Math.max(0, start), in: 0, duration: dur, speed: 1,
    props: { ...DEFAULT_PROPS, crop: [0, 0, 0, 0] }, actions: [],
    audio: { volume: 1, pan: 0, fadeIn: 0, fadeOut: 0, mute: false, voice: media.role === 'mic', duck: 0 },
    transIn: { type: 'none', dur: 0.5 }, transOut: { type: 'none', dur: 0.5 },
    name: media.name,
  };
}

export function newTextClip(trackId, start, content) {
  return {
    id: uid('c'), type: 'text', track: trackId, start, duration: Number(pref('textDur')) || 4, props: { ...DEFAULT_PROPS, crop: [0, 0, 0, 0], y: 0.82 }, actions: [],
    text: { ...TEXT_DEFAULTS, content: content || TEXT_DEFAULTS.content }, transIn: { type: 'none', dur: 0.4 }, transOut: { type: 'none', dur: 0.4 }, name: 'Text',
  };
}

export function newCalloutClip(trackId, start) {
  return { id: uid('c'), type: 'callout', track: trackId, start, duration: 4, props: { ...DEFAULT_PROPS, crop: [0, 0, 0, 0] }, actions: [],
    callout: { ...CALLOUT_DEFAULTS }, transIn: { type: 'fade', dur: 0.3 }, transOut: { type: 'fade', dur: 0.3 }, name: 'Callout' };
}

export function newShapeClip(trackId, start) {
  return { id: uid('c'), type: 'shape', track: trackId, start, duration: 3, props: { ...DEFAULT_PROPS, crop: [0, 0, 0, 0] }, actions: [],
    shape: { ...SHAPE_DEFAULTS }, transIn: { type: 'fade', dur: 0.2 }, transOut: { type: 'fade', dur: 0.2 }, name: 'Arrow' };
}

/** Annotation: pen strokes drawn on the preview that draw themselves on (ScreenFlow's annotations). */
/** An animated graphic element (lower third, burst, subscribe button…; see lib/elements.js). */
export function newElementClip(trackId, start, kind, at = { x: 0.5, y: 0.5 }, duration = 4) {
  return { id: uid('c'), type: 'element', track: trackId, start, duration, props: { ...DEFAULT_PROPS, crop: [0, 0, 0, 0], ...at }, actions: [],
    element: { kind }, transIn: { type: 'none', dur: 0.3 }, transOut: { type: 'none', dur: 0.3 }, name: 'Element' };
}
export function newDrawClip(trackId, start) {
  return { id: uid('c'), type: 'draw', track: trackId, start, duration: 5, props: { ...DEFAULT_PROPS, crop: [0, 0, 0, 0] }, actions: [],
    draw: { strokes: [], color: '#ff3b30', width: 8, drawOn: 0.8, glow: 0 }, transIn: { type: 'none', dur: 0.2 }, transOut: { type: 'fade', dur: 0.3 }, name: 'Annotation' };
}

// ------------------------------------------------------------------ editing

/** Is [start, start+dur) free on a track (ignoring the given clip ids)? */
/** A locked track takes nothing new, and nothing on it is affected (see applyTrackLocks). */
export const trackLocked = (doc, trackId) => !!doc.tracks?.find(t => t.id === trackId)?.locked;
/**
 * Track lock: every clip on a locked track is locked (marked lockedByTrack, so unlocking the track gives back
 * exactly the clips it locked). Called after every edit.
 */
export function applyTrackLocks(doc) {
  if (!doc?.tracks) return;
  const locked = new Set(doc.tracks.filter(t => t.locked).map(t => t.id));
  for (const c of doc.clips) {
    if (locked.has(c.track)) { if (!c.locked) { c.locked = true; c.lockedByTrack = true; } }
    else if (c.lockedByTrack) { delete c.locked; delete c.lockedByTrack; }
  }
}

export function isFree(doc, trackId, start, dur, ignore = []) {
  if (start < -EPS) return false;
  if (trackLocked(doc, trackId)) return false;
  for (const c of doc.clips) {
    if (c.track !== trackId || ignore.includes(c.id)) continue;
    if (start < clipEnd(c) - EPS && start + dur > c.start + EPS) return false;
  }
  return true;
}

/** First track (from the top) where the span is free; adds a track when none is. */
export function freeTrack(doc, start, dur, preferId) {
  if (preferId && isFree(doc, preferId, start, dur)) return preferId;
  for (const t of doc.tracks) if (isFree(doc, t.id, start, dur)) return t.id;
  return addTrack(doc).id;
}

export function addTrack(doc, at = doc.tracks.length) {
  let n = doc.tracks.length + 1;
  while (doc.tracks.some(t => t.name === `Track ${n}`)) n++;
  const t = { id: uid('t'), name: `Track ${n}` };
  doc.tracks.splice(at, 0, t);
  return t;
}

/** Splits clips (selected ones, or all under the playhead) at time t. Returns new clip ids. */
export function split(doc, t, ids) {
  const out = [];
  const regroup = new Map(); // the right halves of a group form a group of their own, so each piece moves on its own
  const newGroup = g => { if (!regroup.has(g)) regroup.set(g, uid('g')); return regroup.get(g); };
  for (const c of [...doc.clips]) {
    if (ids && ids.length && !ids.includes(c.id)) continue;
    if (c.locked) continue;
    if (t <= c.start + 0.02 || t >= clipEnd(c) - 0.02) continue;
    const local = t - c.start;
    const right = structuredClone(c);
    right.id = uid('c');
    if (c.group) right.group = newGroup(c.group);
    right.start = t;
    right.duration = c.duration - local;
    if (c.type === 'media') right.in = (c.in || 0) + local * (c.speed || 1);
    // actions after the cut move to the right half; the right half starts from the state at the cut
    const state = propsAt({ ...c, transIn: null, transOut: null }, local);
    right.props = { ...c.props };
    for (const k of ANIMATABLE) right.props[k] = state[k];
    right.actions = (c.actions || []).filter(a => a.t >= local).map(a => ({ ...a, t: a.t - local }));
    if (c.keys) { shiftKeys(right, local, null); shiftKeys(c, 0, local); }
    if (c.marks) { right.marks = c.marks.filter(m => m >= local).map(m => m - local); c.marks = c.marks.filter(m => m < local); }
    c.actions = (c.actions || []).filter(a => a.t < local);
    c.duration = local;
    c.transOut = { type: 'none', dur: c.transOut?.dur || 0.5 };
    right.transIn = { type: 'none', dur: right.transIn?.dur || 0.5 };
    delete c.xfadeOut; delete right.xfadeIn; // the crossfades stay at the outer edges
    doc.clips.push(right);
    out.push(right.id);
  }
  return out;
}

export function remove(doc, ids, ripple = false) {
  ids = ids.filter(id => !doc.clips.find(c => c.id === id)?.locked); // locked clips stay
  const gone = doc.clips.filter(c => ids.includes(c.id));
  doc.clips = doc.clips.filter(c => !ids.includes(c.id));
  if (ripple) {
    for (const g of gone.sort((a, b) => b.start - a.start)) {
      // close the gap on that track only
      for (const c of doc.clips) if (c.track === g.track && c.start >= clipEnd(g) - EPS) c.start -= g.duration;
    }
  }
}

/**
 * Opens a gap of d seconds at time t on every track: clips after t move right, clips across t are
 * split and their second half moves too (used by freeze frames, so sound stays in sync). Locked clips
 * are moved like any other here, since nothing about them changes but their place.
 */
export function insertTime(doc, t, d) {
  for (const c of [...doc.clips]) {
    if (trackLocked(doc, c.track)) continue; // a locked track isn't moved or cut by ripple edits
    if (c.start < t - EPS && clipEnd(c) > t + 0.02) {
      const locked = c.locked; c.locked = false;
      split(doc, t, [c.id]);
      c.locked = locked;
    }
  }
  for (const c of doc.clips) if (c.start >= t - EPS && !trackLocked(doc, c.track)) c.start += d;
  shiftAfter(doc, t, d);
}

/** Moves markers and captions at or after t by d seconds (captions spanning t stretch). */
function shiftAfter(doc, t, d) {
  for (const m of doc.markers || []) if (m.t >= t - EPS) m.t += d;
  for (const cp of doc.captions || []) { if (cp.t >= t - EPS) { cp.t += d; cp.end += d; } else if (cp.end > t) cp.end = Math.max(cp.t + 0.1, cp.end + d); }
}

/**
 * The empty stretch around time t: on one track (trackId) or on every track at once (null).
 * Returns { a, b } or null when something is playing at t.
 */
export function gapAt(doc, t, trackId = null) {
  const cs = doc.clips.filter(c => !trackId || c.track === trackId);
  if (cs.some(c => c.start < t - EPS && clipEnd(c) > t + EPS)) return null;
  let a = 0, b = Infinity;
  for (const c of cs) { if (clipEnd(c) <= t + EPS) a = Math.max(a, clipEnd(c)); if (c.start >= t - EPS) b = Math.min(b, c.start); }
  return b === Infinity || b - a < 1e-3 ? null : { a, b };
}

/** Closes the gap at t: everything after it slides left. Locked clips move with the rest. */
export function closeGap(doc, t, trackId = null) {
  const g = gapAt(doc, t, trackId);
  if (!g) return 0;
  const d = g.b - g.a;
  for (const c of doc.clips) if ((!trackId || c.track === trackId) && c.start >= g.b - EPS && !trackLocked(doc, c.track)) c.start -= d;
  if (!trackId) shiftAfter(doc, g.b, -d);
  return d;
}

/** Closes every gap on one track (or between all clips when trackId is null), from the left. */
export function closeAllGaps(doc, trackId = null) {
  let total = 0;
  for (let guard = 0; guard < 10000; guard++) {
    const cs = doc.clips.filter(c => !trackId || c.track === trackId).sort((x, y) => x.start - y.start);
    let end = 0, found = null;
    for (const c of cs) { if (c.start > end + 1e-3) { found = (end + c.start) / 2; break; } end = Math.max(end, clipEnd(c)); }
    if (found === null) break;
    const d = closeGap(doc, found, trackId);
    if (!d) break;
    total += d;
  }
  return total;
}

/** Removes the stretch t0..t1 from every track and closes it up (in/out, between markers). */
export function removeRange(doc, t0, t1) {
  if (!(t1 > t0 + 1e-3)) return 0;
  const keep = c => trackLocked(doc, c.track); // a locked track is left exactly as it is
  for (const t of [t0, t1]) for (const c of [...doc.clips]) {
    if (keep(c)) continue;
    if (c.start < t - EPS && clipEnd(c) > t + 0.02) { const l = c.locked; c.locked = false; split(doc, t, [c.id]); c.locked = l; }
  }
  doc.clips = doc.clips.filter(c => keep(c) || !(c.start >= t0 - EPS && clipEnd(c) <= t1 + EPS));
  const d = t1 - t0;
  for (const c of doc.clips) if (c.start >= t1 - EPS && !keep(c)) c.start -= d;
  doc.markers = (doc.markers || []).filter(m => m.t < t0 - EPS || m.t >= t1 - EPS);
  doc.captions = (doc.captions || []).filter(cp => !(cp.t >= t0 - EPS && cp.end <= t1 + EPS));
  for (const cp of doc.captions) { if (cp.t >= t1 - EPS) { cp.t -= d; cp.end -= d; } else if (cp.end > t0) cp.end = Math.max(cp.t + 0.1, cp.end - Math.min(d, cp.end - t0)); }
  for (const m of doc.markers) if (m.t >= t1 - EPS) m.t -= d;
  // Auto Edit sections follow the edit like markers do: gone if cut out, shortened if cut into, moved if after
  if (doc.sections?.length) {
    const sh = t => (t >= t1 ? t - d : t > t0 ? t0 : t);
    doc.sections = doc.sections.map(s => ({ ...s, t0: sh(s.t0), t1: sh(s.t1) })).filter(s => s.t1 - s.t0 > 0.5);
  }
  return d;
}

/** The clip that ends exactly where c starts (side 'start') or starts where c ends ('end'). */
export function neighbour(doc, c, side) {
  return doc.clips.find(o => o !== c && o.track === c.track && (side === 'start' ? Math.abs(clipEnd(o) - c.start) < 1e-3 : Math.abs(o.start - clipEnd(c)) < 1e-3)) || null;
}

/**
 * Rolling edit: moves the cut between `left` and `right` (touching, same track) to time t. The left
 * clip gets longer as the right one gets shorter, so nothing else on the timeline moves.
 */
export function roll(doc, left, right, t) {
  const lm = left.type === 'media' ? mediaById(doc, left.media) : null;
  const rs = right.speed || 1, ls = left.speed || 1;
  let lo = left.start + 0.05, hi = clipEnd(right) - 0.05;
  if (lm && lm.kind !== 'image' && lm.duration) hi = Math.min(hi, left.start + (lm.duration - (left.in || 0)) / ls);
  if (right.type === 'media' && mediaById(doc, right.media)?.kind !== 'image') lo = Math.max(lo, right.start - (right.in || 0) / rs);
  t = clamp(t, lo, hi);
  const d = t - right.start;
  left.duration = t - left.start;
  if (right.type === 'media') right.in = (right.in || 0) + d * rs;
  right.actions = (right.actions || []).map(a => ({ ...a, t: a.t - d })).filter(a => a.t + a.dur > 0);
  if (Math.abs(d) > 1e-9) shiftKeys(right, d, null);
  right.start = t; right.duration -= d;
  return t;
}

/** Colour labels for clips (as in the Clip › Label menu). */
export const LABELS = [['', 'None'], ['red', 'Red'], ['orange', 'Orange'], ['yellow', 'Yellow'], ['green', 'Green'], ['blue', 'Blue'], ['purple', 'Purple'], ['gray', 'Gray']];

// ------------------------------------------------------------------ captions
// doc.captions = [{ id, t, end, text }] on the timeline; doc.captionStyle decides how they look and
// whether they're burned into the picture.
export const CAPTION_STYLE = Object.freeze({ burn: false, font: 'Avenir Next', size: 46, weight: 700, color: '#ffffff', bg: '#000000', bgOpacity: 0.72, pos: 'bottom' });
export function captionAt(doc, t) {
  for (const c of doc.captions || []) if (t >= c.t && t < c.end) return c;
  return null;
}
const pad2 = (n, w = 2) => String(n).padStart(w, '0');
function stamp(t, sep) {
  t = Math.max(0, t);
  const ms = Math.round(t * 1000);
  return `${pad2(Math.floor(ms / 3600000))}:${pad2(Math.floor(ms / 60000) % 60)}:${pad2(Math.floor(ms / 1000) % 60)}${sep}${pad2(ms % 1000, 3)}`;
}
export function toSRT(caps) {
  return [...caps].sort((a, b) => a.t - b.t).map((c, i) => `${i + 1}\n${stamp(c.t, ',')} --> ${stamp(c.end, ',')}\n${String(c.text).trim()}\n`).join('\n');
}
export function toVTT(caps) {
  return 'WEBVTT\n\n' + [...caps].sort((a, b) => a.t - b.t).map(c => `${stamp(c.t, '.')} --> ${stamp(c.end, '.')}\n${String(c.text).trim()}\n`).join('\n');
}
/** Reads SRT or WebVTT text into captions (tags like <i> are dropped). */
export function parseCaptions(text) {
  const out = [];
  const time = s => { const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(s); return m ? (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0') / 1000 : null; };
  for (const block of String(text).replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n').filter(l => l.trim() !== '');
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const t = time(a), end = time(b);
    const body = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (t == null || end == null || !(end > t) || !body) continue;
    out.push({ id: uid('cap'), t, end, text: body.slice(0, 500) });
    if (out.length >= 20000) break;
  }
  return out.sort((x, y) => x.t - y.t);
}

/** Clip ids in the same group as any of `ids` (groups move and select together). */
export function withGroups(doc, ids) {
  const groups = new Set(doc.clips.filter(c => ids.includes(c.id) && c.group).map(c => c.group));
  if (!groups.size) return ids;
  return [...new Set([...ids, ...doc.clips.filter(c => groups.has(c.group)).map(c => c.id)])];
}

/** Trims a clip edge. edge 'start' moves the in point; 'end' changes the duration. */
export function trim(doc, c, edge, t, media) {
  const speed = c.speed || 1;
  if (edge === 'start') {
    const minStart = media && media.kind !== 'image' ? c.start - (c.in || 0) / speed : -Infinity;
    let s = Math.max(t, minStart, 0);
    s = Math.min(s, clipEnd(c) - 0.05);
    // don't overlap the neighbour on the left
    for (const o of doc.clips) if (o !== c && o.track === c.track && clipEnd(o) <= c.start + EPS) s = Math.max(s, clipEnd(o));
    const d = s - c.start;
    if (c.type === 'media') c.in = (c.in || 0) + d * speed;
    c.actions = (c.actions || []).map(a => ({ ...a, t: a.t - d })).filter(a => a.t + a.dur > 0);
    if (Math.abs(d) > 1e-9) shiftKeys(c, d, null);
    if (c.marks) c.marks = c.marks.map(m => m - d).filter(m => m >= 0);
    c.start = s; c.duration -= d;
  } else {
    let e = Math.max(t, c.start + 0.05);
    if (media && media.kind !== 'image' && media.duration) e = Math.min(e, c.start + (media.duration - (c.in || 0)) / speed);
    for (const o of doc.clips) if (o !== c && o.track === c.track && o.start >= clipEnd(c) - EPS) e = Math.min(e, o.start);
    c.duration = e - c.start;
  }
}

/** Snap a time to nearby edges (clip edges, playhead, markers) within `tol` seconds. */
export function snap(doc, t, tol, ignoreIds = [], extra = []) {
  let best = t, bestD = tol;
  const consider = v => { const d = Math.abs(v - t); if (d < bestD) { bestD = d; best = v; } };
  consider(0);
  for (const c of doc.clips) { if (ignoreIds.includes(c.id)) continue; consider(c.start); consider(clipEnd(c)); }
  for (const m of doc.markers || []) consider(m.t);
  for (const v of extra) consider(v);
  return best;
}

// ------------------------------------------------------------------ undo

export class History {
  constructor(limit = 200) { this.undoStack = []; this.redoStack = []; this.limit = limit; }
  push(doc) {
    this.undoStack.push(JSON.stringify(doc));
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }
  undo(doc) { if (!this.undoStack.length) return null; this.redoStack.push(JSON.stringify(doc)); return JSON.parse(this.undoStack.pop()); }
  redo(doc) { if (!this.redoStack.length) return null; this.undoStack.push(JSON.stringify(doc)); return JSON.parse(this.redoStack.pop()); }
}

/** Fills in anything older documents or hand edits left out. */
/** Drops crossfades whose two clips no longer meet (one was moved, trimmed or deleted). */
export function tidyCrossfades(doc) {
  const by = new Map();
  for (const c of doc.clips) if (c.xfadeIn || c.xfadeOut) by.set(c.track, true);
  if (!by.size) return;
  for (const c of doc.clips) {
    if (c.xfadeIn && !doc.clips.some(o => o !== c && o.track === c.track && Math.abs(clipEnd(o) - c.start) < 1e-3 && o.xfadeOut)) delete c.xfadeIn;
    if (c.xfadeOut && !doc.clips.some(o => o !== c && o.track === c.track && Math.abs(o.start - clipEnd(c)) < 1e-3 && o.xfadeIn)) delete c.xfadeOut;
  }
}

export function normalize(doc) {
  doc.canvas ||= { width: 1920, height: 1080, fps: 30, background: '#000000' };
  doc.media ||= []; doc.clips ||= []; doc.markers ||= []; doc.captions ||= [];
  if (!doc.tracks || !doc.tracks.length) doc.tracks = [{ id: 't1', name: 'Track 1' }];
  for (const c of doc.clips) {
    c.props = { ...DEFAULT_PROPS, ...(c.props || {}) };
    if (!Array.isArray(c.props.crop) || c.props.crop.length !== 4) c.props.crop = [0, 0, 0, 0];
    c.actions ||= [];
    c.transIn ||= { type: 'none', dur: 0.5 };
    c.transOut ||= { type: 'none', dur: 0.5 };
    if (c.type === 'media') {
      c.audio = { volume: 1, pan: 0, fadeIn: 0, fadeOut: 0, mute: false, duck: 0, ...(c.audio || {}) };
      if (!Number.isFinite(c.audio.pan)) c.audio.pan = 0; // older projects had no pan (showed as RNaN)
    }
    if (c.type === 'text') c.text = { ...TEXT_DEFAULTS, ...(c.text || {}) };
    if (c.type === 'callout') c.callout = { ...CALLOUT_DEFAULTS, ...(c.callout || {}) };
    if (c.type === 'shape') c.shape = { ...SHAPE_DEFAULTS, ...(c.shape || {}) };
    if (c.type === 'element') c.element = { kind: 'burst', ...(c.element || {}) };
    if (c.type === 'draw') c.draw = { strokes: [], color: '#ff3b30', width: 8, drawOn: 0.8, glow: 0, ...(c.draw || {}) };
    if (c.type === 'media' && c.cursor) c.cursor = { ...CURSOR_DEFAULTS, ...c.cursor };
    if (!doc.tracks.some(t => t.id === c.track)) c.track = doc.tracks[0].id;
  }
  // the mix bus has a limiter by default, so the whole mix never clips (remove or change it in the mixer)
  if (!Array.isArray(doc.mixFx)) doc.mixFx = [{ id: uid('fx'), type: 'limiter', params: {} }];
  tidyCrossfades(doc);
  return doc;
}

/** Display preference: SMPTE timecode (HH:MM:SS:FF) everywhere instead of tenths of a second. */
export const timeFormat = { smpte: false, fps: 30 };
export function fmtTime(t, fps, frames = false) {
  t = Math.max(0, t);
  if (timeFormat.smpte && !frames) { frames = true; fps = timeFormat.fps; }
  fps ||= 30;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const pad = n => String(n).padStart(2, '0');
  const tail = frames ? ':' + pad(Math.floor((t % 1) * fps)) : '.' + String(Math.floor((t % 1) * 10));
  return (h ? h + ':' : '') + pad(m) + ':' + pad(s) + tail;
}

// ------------------------------------------------------------------ speed
export const SPEED_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8, 16];
export const SPEED_MIN = 0.05, SPEED_MAX = 20;
/**
 * Plays the same stretch of source at a new speed: the clip gets longer or shorter (anchored at its start, or
 * its end), and its keyframes and actions stretch with it. It never runs into the next clip on its track: when
 * there isn't room, the speed is raised just enough to fit. Returns the speed set.
 */
export function setSpeed(doc, c, sp, anchor = 'start') {
  const old = c.speed || 1, src = c.duration * old;
  sp = clamp(sp, SPEED_MIN, SPEED_MAX);
  let dur = src / sp;
  const others = doc.clips.filter(k => k !== c && k.track === c.track && !(c.audioOnly ^ !!k.audioOnly));
  if (anchor === 'start') {
    const next = others.filter(k => k.start >= c.start + EPS).reduce((m, k) => Math.min(m, k.start), Infinity);
    if (c.start + dur > next + EPS) dur = Math.max(0.05, next - c.start);
  } else {
    const end = c.start + c.duration;
    const prev = others.filter(k => clipEnd(k) <= end - EPS).reduce((m, k) => Math.max(m, clipEnd(k)), 0);
    if (end - dur < prev - EPS) dur = Math.max(0.05, end - prev);
  }
  sp = src / dur;
  const k = dur / c.duration;
  if (c.keys) for (const list of Object.values(c.keys)) for (const key of list) key.t *= k;
  c.actions = (c.actions || []).map(a => ({ ...a, t: a.t * k, dur: a.dur * k }));
  if (c.audio) { c.audio.fadeIn = (c.audio.fadeIn || 0) * k; c.audio.fadeOut = (c.audio.fadeOut || 0) * k; }
  if (anchor === 'end') c.start = c.start + c.duration - dur;
  c.duration = dur;
  c.speed = Math.abs(sp - 1) < 1e-4 ? 1 : sp;
  return c.speed;
}

/** The cut transitions: one look applied to both sides of a cut. */
export const CUT_TRANSITIONS = [['zoom-through', 'Zoom through'], ['spin-through', 'Spin through'], ['whip-through', 'Whip through'], ['blur-through', 'Blur through'],
  ['light-leak', 'Light leak'], ['film-burn', 'Film burn'], ['flash-cut', 'Flash'], ['glitch-cut', 'Glitch'], ['shake-cut', 'Shake']];
/** Clips meeting at a cut on one track: [outgoing, incoming] for the cut nearest time t (within `near` s). */
export function cutAt(doc, trackId, t, near = 1.5) {
  const list = clipsOnTrack(doc, trackId).filter(c => c.type !== 'caption');
  let best = null, bd = near;
  for (let i = 0; i + 1 < list.length; i++) {
    const a = list[i], b = list[i + 1], cut = clipEnd(a);
    if (Math.abs(b.start - cut) > 0.05) continue;
    const dd = Math.abs(cut - t); if (dd < bd) { bd = dd; best = [a, b]; }
  }
  return best;
}
/** Every cut on a track (outgoing, incoming pairs). */
export function cutsOn(doc, trackId) {
  const list = clipsOnTrack(doc, trackId).filter(c => c.type !== 'caption'), out = [];
  for (let i = 0; i + 1 < list.length; i++) if (Math.abs(list[i + 1].start - clipEnd(list[i])) <= 0.05) out.push([list[i], list[i + 1]]);
  return out;
}
/** Puts a transition on both sides of a cut (half its length on each). */
export function applyCut(a, b, type, dur = 0.5) {
  const half = Math.max(0.08, Math.min(dur / 2, a.duration / 2, b.duration / 2));
  a.transOut = { type, dur: half }; b.transIn = { type, dur: half };
}

/**
 * Turns overlapping clips on one track into a crossfade at the middle of the overlap: the first ends there,
 * the second starts there (trimmed from the front), and both keep the overlap as handles. Returns how many
 * it joined. clips: one track's clips (Reel clips: start, duration, in, speed, actions, keys).
 */
export function crossfadeOverlaps(clips) {
  const list = [...clips].sort((a, b) => a.start - b.start);
  let n = 0;
  for (let i = 0; i + 1 < list.length; i++) {
    const a = list[i], b = list[i + 1], ov = clipEnd(a) - b.start;
    if (!(ov > 0.01) || b.start <= a.start + 0.05 || clipEnd(b) <= clipEnd(a) + 0.05) continue;
    const mid = b.start + ov / 2, dt = mid - b.start;
    // a moving transition (push, slide, zoom…) becomes the same transition at the cut, half on each side
    const kind = b.transIn?.type && !['none', 'fade', 'dissolve', 'crossfade'].includes(b.transIn.type) ? b.transIn.type : null;
    a.duration = mid - a.start;
    b.in = (b.in || 0) + dt * (b.speed || 1); b.start = mid; b.duration -= dt;
    b.actions = (b.actions || []).map(x => ({ ...x, t: x.t - dt })).filter(x => x.t + (x.dur || 0) > 0).map(x => (x.t < 0 ? { ...x, dur: (x.dur || 0) + x.t, t: 0 } : x));
    if (b.keys) shiftKeys(b, dt, null);
    // the outgoing clip keeps its keyframes past the cut: its handle still uses them
    if (kind) { a.transOut = { type: kind, dur: ov / 2 }; b.transIn = { type: kind, dur: ov / 2 }; n++; continue; }
    a.xfadeOut = ov; b.xfadeIn = ov;
    if (['fade', 'dissolve', 'crossfade'].includes(a.transOut?.type)) a.transOut = null;
    if (['fade', 'dissolve', 'crossfade'].includes(b.transIn?.type)) b.transIn = null;
    n++;
  }
  return n;
}

/**
 * Projects imported before crossfades existed put ScreenFlow's cross-transitions on extra "(overlap)" tracks.
 * Moves those clips back onto the track below as crossfades and removes the emptied tracks.
 */
export function mergeOverlapTracks(doc) {
  let moved = 0;
  for (let i = 0; i < doc.tracks.length; i++) {
    const t = doc.tracks[i];
    if (!/\(overlap\)\s*$/.test(t.name || '')) continue;
    const base = doc.tracks.slice(i + 1).find(x => !/\(overlap\)/.test(x.name || ''));
    if (!base) continue;
    for (const c of doc.clips.filter(x => x.track === t.id)) {
      const others = doc.clips.filter(x => x.track === base.id);
      // it may overlap at most the clip it fades from and the one it hands over to
      const hits = others.filter(o => o.start < clipEnd(c) - 0.01 && clipEnd(o) > c.start + 0.01);
      if (hits.some(o => o.start >= c.start - 0.01 && clipEnd(o) <= clipEnd(c) + 0.01)) continue; // fully covered: leave it
      c.track = base.id;
      crossfadeOverlaps(doc.clips.filter(x => x.track === base.id));
      moved++;
    }
  }
  const used = new Set(doc.clips.map(c => c.track));
  doc.tracks = doc.tracks.filter(t => !/\(overlap\)\s*$/.test(t.name || '') || used.has(t.id));
  return moved;
}
