// Quick push in / push out: a zoom in toward a point, a hold, and a zoom back out, made of two ordinary actions on
// the clip that know they belong together (push: the pair's id, pushPart: 'in' or 'out'), so their speed, hold and
// zoom are set in one place (the Motion tab) and each still shows, drags and trims on the timeline like any action.
// No DOM here, so it's tested in Node.
import { propsAt, uid } from '../model.js';
import { propsOfShot } from './dynzoom.js';

export const PUSH_DEFAULTS = { zoom: 1.5, inDur: 0.3, hold: 2, outDur: 0.3, ease: 'ease' };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** The clip's position and size just before local time t (what a push comes back out to). */
const before = (c, t) => {
  const p = propsAt({ ...c, actions: (c.actions || []).filter(a => a.t + a.dur <= t + 1e-6), transIn: null, transOut: null }, t);
  return { x: p.x, y: p.y, scale: p.scale };
};

/**
 * Adds a push at local time t: kind 'inout' (in, hold, out), 'in' (in and stay) or 'out' (back out to how it was
 * before the last push in). aim: { fx, fy } the point of the picture to push toward (0..1 of it; the middle when left
 * out); fw, fh: how much of the canvas the picture fills. Returns the pair's id, or null when there's no room.
 */
export function addPush(c, t, { kind = 'inout', aim = null, fw = 1, fh = 1, ...o } = {}) {
  const v = { ...PUSH_DEFAULTS, ...o };
  c.actions ||= [];
  t = clamp(t, 0, Math.max(0, c.duration - 0.1));
  if (c.duration - t < 0.15) return null;
  const id = uid('p');
  if (kind === 'out') {
    // back out to how it was before the push in it ends (or to the whole picture)
    const lastIn = [...c.actions].filter(a => a.t < t && a.pushPart === 'in').sort((a, b) => b.t - a.t)[0];
    const to = lastIn ? before(c, lastIn.t) : { x: 0.5, y: 0.5, scale: 1 };
    c.actions.push({ id: uid('a'), t, dur: Math.min(v.outDur, c.duration - t), ease: v.ease, props: to, push: id, pushPart: 'out' });
  } else {
    const base = before(c, t);
    const p = propsOfShot({ fx: aim?.fx ?? 0.5, fy: aim?.fy ?? 0.5, s: 1 / (v.zoom * base.scale) }, fw, fh);
    const inDur = Math.min(v.inDur, c.duration - t);
    c.actions.push({ id: uid('a'), t, dur: inDur, ease: v.ease, props: { x: p.x, y: p.y, scale: p.scale }, push: id, pushPart: 'in', pushZoom: v.zoom });
    if (kind === 'inout') {
      const ot = Math.min(t + inDur + v.hold, c.duration - 0.1);
      if (ot > t + inDur) c.actions.push({ id: uid('a'), t: ot, dur: Math.min(v.outDur, c.duration - ot), ease: v.ease, props: base, push: id, pushPart: 'out' });
    }
  }
  c.actions.sort((a, b) => a.t - b.t);
  return id;
}

/** The push an action belongs to: { id, in, out, zoom, inDur, hold, outDur, ease } (in or out may be missing), or null. */
export function pushOf(c, actionId) {
  const a = (c.actions || []).find(x => x.id === actionId);
  if (!a || !a.push) return null;
  const pin = c.actions.find(x => x.push === a.push && x.pushPart === 'in') || null, pout = c.actions.find(x => x.push === a.push && x.pushPart === 'out') || null;
  return {
    id: a.push, in: pin, out: pout,
    zoom: pin?.pushZoom ?? (pin ? pin.props.scale / Math.max(0.01, before(c, pin.t).scale) : 1),
    inDur: pin?.dur ?? 0, hold: pin && pout ? Math.max(0, pout.t - (pin.t + pin.dur)) : 0, outDur: pout?.dur ?? 0, ease: (pin || pout).ease || 'ease',
  };
}

/** The push at local time t (the one whose in starts before t and whose out ends after it), or null. */
export function pushAt(c, t) {
  for (const a of c.actions || []) {
    if (a.pushPart !== 'in' && a.pushPart !== 'out') continue;
    const p = pushOf(c, a.id), s = (p.in || p.out).t, e = p.out ? p.out.t + p.out.dur : p.in.t + p.in.dur;
    if (t >= s - 1e-6 && t <= e + 1e-6) return p;
  }
  return null;
}

/**
 * Changes a push (inside a commit): zoom (how far in, 1.5 = 150%), inDur and outDur (how fast it goes in and comes
 * out, s), hold (how long it stays in, s), ease. The point it pushes toward stays the same.
 */
export function setPush(c, actionId, changes) {
  const p = pushOf(c, actionId);
  if (!p) return false;
  const v = { zoom: p.zoom, inDur: p.inDur, hold: p.hold, outDur: p.outDur, ease: p.ease, ...changes };
  if (p.in) {
    if ('zoom' in changes && Math.abs(v.zoom - p.zoom) > 1e-9) {
      // the same point of the picture in the middle, nearer or further
      const base = before(c, p.in.t), from = p.in.props;
      const cx = 0.5 - (0.5 - from.x) / from.scale, cy = 0.5 - (0.5 - from.y) / from.scale; // centre of the shot, canvas fractions at scale 1
      const s = clamp(v.zoom * base.scale, 0.2, 8);
      p.in.props = { ...from, scale: s, x: 0.5 - (0.5 - cx) * s, y: 0.5 - (0.5 - cy) * s };
      p.in.pushZoom = v.zoom;
    }
    p.in.dur = clamp(v.inDur, 0.05, Math.max(0.05, c.duration - p.in.t));
    p.in.ease = v.ease;
  }
  if (p.out) {
    if (p.in) p.out.t = clamp(p.in.t + p.in.dur + Math.max(0, v.hold), 0, Math.max(0, c.duration - 0.05));
    p.out.dur = clamp(v.outDur, 0.05, Math.max(0.05, c.duration - p.out.t));
    p.out.ease = v.ease;
  }
  c.actions.sort((a, b) => a.t - b.t);
  return true;
}

/** Takes a push out (both its actions). */
export function removePush(c, actionId) {
  const p = pushOf(c, actionId);
  if (!p) return false;
  c.actions = c.actions.filter(a => a.push !== p.id);
  return true;
}
