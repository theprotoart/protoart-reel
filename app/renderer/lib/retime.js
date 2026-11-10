// A clip's time map (Elastic Wave and the Retime curve): which moment of the source plays at each moment of the
// clip. Points [{ t, s }]: t is seconds into the clip, s seconds into the source after the clip's In point. Between
// points it's a straight line (constant speed); past either end the nearest segment's speed carries on (for
// crossfade handles). The first point is { t: 0, s: 0 }; the last is at the clip's end. Speed = ds / dt.

const EPS = 1e-6;
export const MIN_GAP = 0.04;          // seconds between two points on the clip
export const SPEED_RANGE = [0.1, 8];  // slowest and fastest a segment may play

/** Is this a usable map (two or more points, rising in both t and s, starting at 0, 0)? */
export function validRetime(pts) {
  if (!Array.isArray(pts) || pts.length < 2) return false;
  if (Math.abs(pts[0].t) > EPS || Math.abs(pts[0].s) > EPS) return false;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (!(Number.isFinite(b.t) && Number.isFinite(b.s)) || b.t - a.t < MIN_GAP / 4 || b.s - a.s <= EPS) return false;
  }
  return true;
}

/** Index of the segment holding clip time t (0 … n-2). */
function seg(pts, t) {
  let i = 0;
  while (i < pts.length - 2 && t > pts[i + 1].t) i++;
  return i;
}

/** Source offset (seconds after In) at clip time t. */
export function mapAt(pts, t) {
  const i = seg(pts, t), a = pts[i], b = pts[i + 1];
  return a.s + (t - a.t) * (b.s - a.s) / (b.t - a.t);
}

/** Playing speed at clip time t (the slope of the segment there). */
export function slopeAt(pts, t) {
  const i = seg(pts, t), a = pts[i], b = pts[i + 1];
  return (b.s - a.s) / (b.t - a.t);
}

/** Clip time at which source offset s plays. */
export function invertAt(pts, s) {
  let i = 0;
  while (i < pts.length - 2 && s > pts[i + 1].s) i++;
  const a = pts[i], b = pts[i + 1];
  return a.t + (s - a.s) * (b.t - a.t) / (b.s - a.s);
}

/** Average speed of the whole map. */
export const meanSpeed = pts => (pts[pts.length - 1].s - pts[0].s) / Math.max(EPS, pts[pts.length - 1].t - pts[0].t);

/** A straight map: dur seconds of clip playing src seconds of source. */
export const linearRetime = (dur, src) => [{ t: 0, s: 0 }, { t: dur, s: src }];

/**
 * The part of a map from clip time a to b, starting again at 0, 0. Returns { pts, s0 }: s0 is the source offset
 * at a (add it to the clip's In). Points inside are kept; the ends are cut (or extended) on their segment.
 */
export function cutRetime(pts, a, b) {
  const s0 = mapAt(pts, a);
  const out = [{ t: 0, s: 0 }];
  for (const p of pts) if (p.t > a + MIN_GAP / 2 && p.t < b - MIN_GAP / 2) out.push({ t: p.t - a, s: p.s - s0 });
  out.push({ t: b - a, s: mapAt(pts, b) - s0 });
  return { pts: out, s0 };
}

/** The map squeezed or stretched to a new clip length (every point keeps its share of the time). */
export const scaleRetime = (pts, dur) => { const k = dur / Math.max(EPS, pts[pts.length - 1].t); return pts.map(p => ({ t: p.t * k, s: p.s })); };

/** Adds a point (an Elastic Wave marker) at clip time t, on the line, so nothing changes until it's moved. */
export function addPoint(pts, t) {
  if (t <= MIN_GAP || t >= pts[pts.length - 1].t - MIN_GAP || pts.some(p => Math.abs(p.t - t) < MIN_GAP)) return pts;
  return [...pts, { t, s: mapAt(pts, t) }].sort((x, y) => x.t - y.t);
}

/** Removes point i (never the first or last). */
export const removePoint = (pts, i) => (i <= 0 || i >= pts.length - 1 ? pts : pts.filter((_, k) => k !== i));

/**
 * Elastic Wave: moves point i to clip time t (the source moment it holds stays the same), so the sound before
 * it and after it stretches or squeezes to meet it. Kept between its neighbours and within the speed range.
 */
export function movePoint(pts, i, t) {
  if (i <= 0 || i >= pts.length - 1) return pts;
  const a = pts[i - 1], b = pts[i + 1], p = pts[i];
  const [lo, hi] = SPEED_RANGE;
  // slope before: (p.s - a.s) / (t - a.t) within [lo, hi]; after: (b.s - p.s) / (b.t - t) within [lo, hi]
  const min = Math.max(a.t + MIN_GAP, a.t + (p.s - a.s) / hi, b.t - (b.s - p.s) / lo);
  const max = Math.min(b.t - MIN_GAP, a.t + (p.s - a.s) / lo, b.t - (b.s - p.s) / hi);
  if (!(max >= min)) return pts;
  const out = pts.slice();
  out[i] = { t: Math.min(max, Math.max(min, t)), s: p.s };
  return out;
}

/**
 * Retime curve: moves point i to (t, s). The ends stay put in time (the first at 0, the last at the clip's end) but
 * the last one's source time may move (more or less of the source in the same clip). Kept rising and in range.
 */
export function setPoint(pts, i, t, s) {
  const out = pts.slice(), n = pts.length, [lo, hi] = SPEED_RANGE;
  if (i === 0) return pts;
  const a = pts[i - 1], b = pts[i + 1];
  const tt = i === n - 1 ? pts[i].t : Math.min(b.t - MIN_GAP, Math.max(a.t + MIN_GAP, t));
  let smin = a.s + lo * (tt - a.t), smax = a.s + hi * (tt - a.t);
  if (b) { smin = Math.max(smin, b.s - hi * (b.t - tt)); smax = Math.min(smax, b.s - lo * (b.t - tt)); }
  if (!(smax >= smin)) return pts;
  out[i] = { t: tt, s: Math.min(smax, Math.max(smin, s)) };
  return out;
}

/**
 * Ready-made curves over a clip of `dur` seconds playing `src` seconds of source (the same total, so the clip keeps
 * its length): ease in (starts slow, speeds up), ease out, speed ramp (fast middle), slow-motion middle.
 */
export function retimePreset(kind, dur, src, steps = 16) {
  const f = {
    easeIn: u => u * u,
    easeOut: u => 1 - (1 - u) * (1 - u),
    ramp: u => { // slow → fast → slow: the source rushes through the middle
      const k = u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u); return k; },
    slowMiddle: u => { // fast → slow → fast: the middle lingers
      const x = 2 * u - 1, k = (x * x * x + x) / 2; return (k + 1) / 2; },
    linear: u => u,
  }[kind] || (u => u);
  const pts = [];
  for (let i = 0; i <= steps; i++) { const u = i / steps; pts.push({ t: u * dur, s: f(u) * src }); }
  // keep every segment within the speed range (very steep ends are softened)
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], p = pts[i], dt = p.t - a.t;
    p.s = Math.max(p.s, a.s + SPEED_RANGE[0] * dt);
  }
  pts[pts.length - 1].s = Math.max(pts[pts.length - 1].s, src * 0.999);
  return pts.map(p => ({ t: +p.t.toFixed(4), s: +p.s.toFixed(4) }));
}
