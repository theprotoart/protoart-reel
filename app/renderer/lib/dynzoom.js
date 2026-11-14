// Dynamic zoom, like DaVinci Resolve's: a START frame and an END frame drawn over the picture, and the clip
// zooms and pans from one to the other with the ease you pick. Built on ordinary keyframes (props.x, props.y,
// props.scale), so the diamonds on the clip, the Zoom lane and ⌘Z all work on it.
//
// A frame is the part of the picture that fills the screen: { fx, fy } its centre and s its width, as fractions
// of the frame (s = 1 is the whole picture, 0.5 is a 2× zoom). The clip's props for a frame:
//   scale = 1 / s,  x = 0.5 + (0.5 − fx) / s,  y = 0.5 + (0.5 − fy) / s
import { putKey, removeKey, paramAt, hasKeys, keysOf, clamp } from '../model.js';

const DZ = ['props.x', 'props.y', 'props.scale'];
export const DZ_EASES = [['linear', 'Linear'], ['in', 'Ease in'], ['out', 'Ease out'], ['ease', 'Ease in & out']];
export const MIN_S = 0.05, MAX_S = 2; // up to a 20× zoom in, and down to 50% (the picture smaller than the screen)

export const propsOfFrame = ({ fx, fy, s }) => ({ scale: 1 / s, x: 0.5 + (0.5 - fx) / s, y: 0.5 + (0.5 - fy) / s });
export const frameOfProps = ({ x = 0.5, y = 0.5, scale = 1 }) => ({ s: 1 / scale, fx: 0.5 - (x - 0.5) / scale, fy: 0.5 - (y - 0.5) / scale });

/** The frame showing at clip-local time t. */
export function frameAt(c, t) {
  return frameOfProps({ x: paramAt(c, 'props.x', t) ?? 0.5, y: paramAt(c, 'props.y', t) ?? 0.5, scale: paramAt(c, 'props.scale', t) ?? 1 });
}

/** On when the clip's scale has two or more keyframes. */
export const hasDynZoom = c => (keysOf(c, 'props.scale') || []).length >= 2;

/** The start and end times (clip-local): the first two scale keyframes (a zoom back out adds more), or the whole clip. */
export function dzTimes(c) {
  const k = keysOf(c, 'props.scale');
  return k && k.length >= 2 ? [k[0].t, k[1].t] : [0, c.duration];
}

/** { start, end, ease, t0, t1 } for the inspector and the boxes in the preview. */
export function getDynZoom(c) {
  const [t0, t1] = dzTimes(c);
  return { t0, t1, start: frameAt(c, t0), end: frameAt(c, t1), ease: (keysOf(c, 'props.scale') || [])[0]?.ease || 'ease' };
}

const writeFrame = (c, t, frame, ease) => {
  const p = propsOfFrame(frame);
  for (const k of ['x', 'y', 'scale']) putKey(c, 'props.' + k, t, p[k], 1e-4, ease);
};

/**
 * Turns dynamic zoom on (or replaces it) for a section of the clip, t0 to t1 (clip-local; the whole clip by default).
 * Before t0 the clip shows the START frame, after t1 the END frame. Other keyframes stay.
 */
export function applyDynZoom(c, { start = { fx: 0.5, fy: 0.5, s: 1 }, end = { fx: 0.5, fy: 0.5, s: 0.75 }, ease = 'ease', t0 = 0, t1 = c.duration } = {}) {
  for (const p of DZ) if (c.keys) delete c.keys[p];
  if (c.keys && !Object.keys(c.keys).length) delete c.keys;
  [t0, t1] = sectionIn(c, t0, t1);
  writeFrame(c, t0, clampFrame(start), ease);
  writeFrame(c, t1, clampFrame(end), 'linear');
}

/** A section inside the clip, at least 0.1 s long. */
export function sectionIn(c, t0, t1) {
  const d = c.duration;
  t0 = clamp(t0, 0, Math.max(0, d - 0.1));
  t1 = clamp(t1, t0 + 0.1, d);
  return [t0, Math.max(t1, Math.min(d, t0 + 0.1))];
}

/** Moves the zoom to start at t0 and end at t1 (clip-local), keeping its frames, ease, and any zoom back out after it. */
export function setDynZoomTimes(c, t0, t1) {
  const [a, b] = dzTimes(c);
  const k = keysOf(c, 'props.scale') || [];
  const next = k[2]?.t ?? Infinity;
  t1 = Math.min(t1, next - 0.05);
  [t0, t1] = sectionIn(c, t0, t1);
  if (t1 <= t0) return;
  // move the end first when moving later, the start first when moving earlier, so the two never cross
  if (t0 >= b) { moveZoomKey(c, b, t1); moveZoomKey(c, a, t0); } else { moveZoomKey(c, a, t0); moveZoomKey(c, b, t1); }
}

/**
 * Zoom back out: after the END frame, hold it for `hold` seconds, then go back to the START frame over as long as the
 * zoom in took (both shortened to fit the clip). Replaces any earlier zoom back out.
 */
export function addZoomBackOut(c, hold = 1) {
  const { t0, t1, start, end, ease } = getDynZoom(c);
  for (const p of DZ) { const l = keysOf(c, p); if (l) c.keys[p] = l.filter(k => k.t <= t1 + 1e-4); }
  const room = c.duration - t1;
  if (room < 0.2) return false;
  const back = Math.min(t1 - t0, room * 0.6), wait = Math.min(hold, room - back);
  writeFrame(c, t1 + wait, end, ease);
  writeFrame(c, Math.min(c.duration, t1 + wait + back), start, 'linear');
  return true;
}
export const hasZoomBackOut = c => (keysOf(c, 'props.scale') || []).length > 2;

/** Moves or resizes the START or END frame (which = 'start' | 'end'). */
export function setDynZoomFrame(c, which, frame) {
  const { t0, t1, ease } = getDynZoom(c);
  writeFrame(c, which === 'start' ? t0 : t1, clampFrame(frame), which === 'start' ? ease : undefined);
}

/** The ease of the move from START to END (on the keys at the start). */
export function setDynZoomEase(c, ease) {
  const [t0] = dzTimes(c);
  for (const p of DZ) for (const k of keysOf(c, p) || []) if (Math.abs(k.t - t0) < 1e-4) k.ease = ease;
}

/** START becomes END and END becomes START. */
export function swapDynZoom(c) {
  const { start, end } = getDynZoom(c);
  setDynZoomFrame(c, 'start', end);
  setDynZoomFrame(c, 'end', start);
}

/** Off: removes the zoom keyframes and leaves the clip showing its START frame. */
export function removeDynZoom(c) {
  const { start } = getDynZoom(c);
  for (const p of DZ) if (c.keys) delete c.keys[p];
  if (c.keys && !Object.keys(c.keys).length) delete c.keys;
  c.props = { ...(c.props || {}), ...propsOfFrame(start) };
}

/** The clip without its zoom: what the preview shows while you place the frames (the whole picture). */
export function unzoomed(c) {
  if (!c.keys || !DZ.some(p => c.keys[p])) return { ...c, props: { ...c.props, x: 0.5, y: 0.5, scale: 1 } };
  const keys = { ...c.keys };
  for (const p of DZ) delete keys[p];
  return { ...c, keys: Object.keys(keys).length ? keys : undefined, props: { ...c.props, x: 0.5, y: 0.5, scale: 1 } };
}

/**
 * The Zoom lane: sets the zoom at clip-local time t to `scale` (a keyframe), keeping the same spot of the
 * picture in the middle of the screen, so the zoom goes in and out without drifting sideways.
 */
export function setZoomAt(c, t, scale, ease) {
  const f = frameAt(c, t);
  const next = { ...f, s: clamp(1 / scale, MIN_S, 4) };
  const p = propsOfFrame(next);
  putKey(c, 'props.scale', t, p.scale, 1e-4, ease);
  if (hasKeys(c, 'props.x') || Math.abs(p.x - (c.props?.x ?? 0.5)) > 1e-6) putKey(c, 'props.x', t, p.x, 1e-4, ease);
  if (hasKeys(c, 'props.y') || Math.abs(p.y - (c.props?.y ?? 0.5)) > 1e-6) putKey(c, 'props.y', t, p.y, 1e-4, ease);
}

/** Moves every zoom keyframe at time `from` to time `to` (the Zoom lane's points carry x and y with them). */
export function moveZoomKey(c, from, to) {
  for (const p of DZ) {
    const list = keysOf(c, p);
    if (!list) continue;
    for (const k of list) if (Math.abs(k.t - from) < 1e-4) k.t = to;
    list.sort((a, b) => a.t - b.t);
  }
}

/** Deletes the zoom keyframes at time t. */
export function removeZoomKey(c, t) { for (const p of DZ) removeKey(c, p, t, 1e-4); }

/** A frame keeps the shape of the picture: no smaller than a 20× zoom, no bigger than twice the picture. */
export function clampFrame({ fx, fy, s }) { return { fx, fy, s: clamp(s, MIN_S, MAX_S) }; }
