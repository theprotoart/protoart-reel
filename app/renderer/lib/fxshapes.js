// The transitions that paint over the picture, as shapes for the Rust core to draw (1.14): light leak, film burn
// (holes and flicker), glitch bars, the lens flare sweep, a fast wipe's streak, letterbox bars, the radial shutter's
// blades and film grain. Each is compositor.js's own drawing written down instead of drawn: the same numbers, the same
// random-looking choices (hash2), the same colours and blend modes; ink.rs draws them. Shared with compositor.js, so
// the two can't drift apart. No DOM here, so it's tested in Node.

/** A repeatable random-looking number 0..1 for two inputs (the glitches' and film holes' choices). */
export const hash2 = (a, b) => { const r = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return r - Math.floor(r); };

/**
 * Radial shutter (a camera's iris): seven blades turning around the middle. k is how open it is (0 shut, 1 gone).
 * The opening's corners v, its size r, the middle, how far the blades reach, and how far they've turned.
 */
export const SHUTTER_N = 7;
export function shutterGeom(k, W, H) {
  const e = Math.max(0, Math.min(1, k)), s = e * e * (3 - 2 * e);
  const cx = W / 2, cy = H / 2, full = Math.hypot(W, H) / 2 / Math.cos(Math.PI / SHUTTER_N) * 1.04;
  const r = full * s, rot = -Math.PI / 2 + (1 - s) * (2 * Math.PI / SHUTTER_N) * 1.6; // the blades turn as they open
  const v = [];
  for (let i = 0; i < SHUTTER_N; i++) { const a = rot + i * 2 * Math.PI / SHUTTER_N; v.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return { v, r, cx, cy, far: Math.hypot(W, H) * 1.5, rot };
}
/** Each blade's straight edge: along one side of the opening and on past its corner, out of the frame. */
export function bladeEdge(g, i) {
  const { v, far, rot } = g, n = SHUTTER_N;
  const a = v[i], b = v[(i + 1) % n];
  let dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
  if (l < 1e-3) { const ang = rot + (i + 0.5) * 2 * Math.PI / n + Math.PI / 2; dx = Math.cos(ang); dy = Math.sin(ang); l = 1; } // shut: the edges fan out like a pinwheel
  return [b, [b[0] + dx / l * far, b[1] + dy / l * far]];
}
export const shutterLine = (W, H) => Math.max(1, Math.min(W, H) / 360);

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const fill = (pts, c) => ({ kind: 'poly', pts, fill: c });
const radial = (x, y, r0, r1, stops, area) => ({ kind: 'stops', lin: false, a: [x, y, r0, r1], stops, area });
const linear = (x0, y0, x1, y1, stops, area) => ({ kind: 'stops', lin: true, a: [x0, y0, x1, y1], stops, area });
const mode = m => ({ kind: 'mode', m }); // 0 over, 1 screen, 2 lighter, 3 overlay
/** A straight stroke from a to b, w wide with flat ends (the canvas's default butt caps), as an outline. */
const segment = (a, b, w) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1, nx = -dy / l * w / 2, ny = dx / l * w / 2;
  return [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]];
};

/** compositor.js shutterBlades: the metal blades outside the opening, their seams, and a soft shadow inside the rim. */
export function shutterShapes(k, W, H) {
  const g = shutterGeom(k, W, H), n = SHUTTER_N, lw = shutterLine(W, H);
  const out = [mode(0), { kind: 'except', pts: g.v },
    radial(g.cx, g.cy, g.r * 0.9, Math.hypot(W, H) / 2, [[0, [58, 58, 62, 1]], [0.45, [31, 31, 34, 1]], [1, [11, 11, 13, 1]]], rect(0, 0, W, H))];
  for (let i = 0; i < n; i++) {
    const [p0, f0] = bladeEdge(g, i), [, f1] = bladeEdge(g, (i + 1) % n), p1 = g.v[(i + 2) % n];
    const t = (i % 2 ? 0.06 : 0) + (i % 3) * 0.025;
    out.push(linear(p0[0], p0[1], f0[0], f0[1], [[0, [255, 255, 255, 0.1 + t]], [1, [255, 255, 255, 0.01]]], [p0, f0, f1, p1]));
  }
  for (let i = 0; i < n; i++) {
    const [a, b] = bladeEdge(g, i);
    out.push(fill(segment(a, b, lw * 2.2), [0, 0, 0, 0.75]), fill(segment(a, b, lw * 0.8), [255, 255, 255, 0.22]));
  }
  out.push({ kind: 'except', pts: null });
  if (g.r > 2) out.push({ kind: 'rim', pts: g.v, w: lw * 10, sigma: lw * 4, c: [0, 0, 0, 0.55] });
  return out;
}

/** compositor.js wipeStreak: the bright, soft edge that leads a Fast wipe. */
export function streakShapes(s, W, H) {
  const sl = W * 0.08, x = (W + sl) * s.x - sl / 2, bw = W * 0.06;
  return [mode(1), linear(x - bw, 0, x + bw, 0, [[0, [255, 255, 255, 0]], [0.5, [255, 255, 255, 0.7 * s.amt]], [1, [255, 255, 255, 0]]],
    [[x - bw + sl / 2, 0], [x + bw + sl / 2, 0], [x + bw - sl / 2, H], [x - bw - sl / 2, H]])];
}

/** compositor.js filmHoles: old film burning in the gate, and the projector's flicker. */
export function holeShapes(amt, W, H, t) {
  const R = Math.max(W, H), out = [mode(0)];
  for (let i = 0; i < 3; i++) {
    const grow = Math.max(0, amt * 1.25 - i * 0.18); if (grow <= 0) continue;
    const x = (0.2 + 0.6 * hash2(i, 4.1)) * W, y = (0.15 + 0.7 * hash2(5.3, i)) * H, r = R * grow * (0.35 + 0.25 * hash2(i, 9)) * (1 + Math.sin(t * 23 + i) * 0.04);
    out.push(radial(x, y, 0, r, [[0, [255, 250, 235, 1]], [0.45, [255, 214, 140, 0.98]], [0.7, [255, 120, 30, 0.85]], [0.86, [110, 30, 5, 0.6]], [1, [40, 10, 0, 0]]], rect(0, 0, W, H)));
  }
  if (hash2(Math.floor(t * 24), 1) > 0.7) out.push(fill(rect(0, 0, W, H), [255, 255, 255, 0.12 * amt]));
  return out;
}

/** compositor.js glitchBars: digital-glitch bars over the frame (the Glitch transition). */
export function glitchShapes(amt, W, H, t) {
  const out = [mode(1)], n = 3 + Math.floor(amt * 6), cols = [[255, 42, 109], [5, 217, 232], [255, 255, 255]];
  for (let i = 0; i < n; i++) {
    const r = Math.sin((t * 31.7 + i) * 12.9898) * 43758.5453, f = r - Math.floor(r);
    const y = f * H, h = (0.01 + f * 0.05) * H;
    out.push(fill(rect((f - 0.5) * W * 0.1 * amt, y, W, h), [...cols[i % 3], 0.25 + amt * 0.5]));
  }
  return out;
}

/** compositor.js lightLeak: warm light washing over the frame (Light leak, Film burn). */
export function leakShapes(amt, W, H, t, burn) {
  const out = [mode(burn ? 1 : 2)];
  const blobs = burn ? [[[255, 120, 20], 0.2, 0.6], [[255, 40, 0], 0.75, 0.3], [[255, 220, 120], 0.5, 0.5]] : [[[255, 170, 60], 0.15, 0.3], [[255, 90, 40], 0.85, 0.7], [[255, 230, 170], 0.55, 0.2]];
  blobs.forEach(([rgb, bx, by], i) => {
    const x = (bx + Math.sin(t * 1.7 + i * 2) * 0.12) * W, y = (by + Math.cos(t * 1.3 + i) * 0.1) * H, r = Math.max(W, H) * (0.45 + 0.35 * amt);
    out.push(radial(x, y, 0, r, [[0, [...rgb, 0.95 * amt]], [0.5, [...rgb, 0.35 * amt]], [1, [...rgb, 0]]], rect(0, 0, W, H)));
  });
  if (burn && amt > 0.6) out.push(mode(0), fill(rect(0, 0, W, H), [255, 244, 224, (amt - 0.6) * 2]));
  return out;
}

/** compositor.js filmGrain's offset and strength for a moment. */
export function grainShape(amt, t) {
  return { kind: 'grain', ox: Math.floor((Math.sin(t * 91.7) * 0.5 + 0.5) * 256), oy: Math.floor((Math.cos(t * 73.1) * 0.5 + 0.5) * 256), a: Math.min(0.5, 0.12 + amt * 0.3) };
}

/** compositor.js lensFlare: a horizontal lens-flare streak sweeping across. */
export function flareShapes(f, W, H) {
  const x = f.k * W * 1.4 - W * 0.2, y = H * 0.42, a = Math.min(1, f.amt * 1.6);
  return [mode(1),
    radial(x, y, 0, H * 0.5, [[0, [255, 245, 225, 0.9 * a]], [0.15, [255, 190, 120, 0.45 * a]], [1, [255, 140, 60, 0]]], rect(0, 0, W, H)),
    linear(0, y, W, y, [[0, [120, 180, 255, 0]], [Math.max(0, Math.min(1, x / W)), [200, 225, 255, 0.7 * a]], [1, [120, 180, 255, 0]]], rect(0, y - H * 0.012, W, H * 0.024))];
}

/** compositor.js letterbox: bars for a ratio (on), closing to black (close 0…1). */
export function barShapes(W, H, ratio, on, close) {
  const base = on ? Math.max(0, (H - W / ratio) / 2) : 0;
  const h = base + (H / 2 - base) * Math.min(1, close);
  if (h <= 0.5) return [];
  return [mode(0), fill(rect(0, 0, W, h), [0, 0, 0, 1]), fill(rect(0, H - h, W, h), [0, 0, 0, 1])];
}

/**
 * Everything compositor.js drawFrame paints over the frame after drawing clip c (its props p at time t), in its
 * order, as one list of shapes; or { why } for what still reads the picture (the text reveal, vertigo, glitch blocks).
 */
export function effectShapes(c, p, t, W, H) {
  if (p.textMask) return { why: 'a text reveal' };
  if (p.vertigo && p.vertigo.amt > 0.01) return { why: 'a vertigo ramp' };
  if (p.blocks > 0.03) return { why: 'glitch blocks' };
  const out = [];
  if (p.shutter != null && p.shutter < 1) out.push(...shutterShapes(p.shutter, W, H));
  if (p.streak && p.streak.amt > 0.02) out.push(...streakShapes(p.streak, W, H));
  if (p.holes > 0.02) out.push(...holeShapes(p.holes, W, H, t));
  if (p.glitch > 0.05) out.push(...glitchShapes(p.glitch, W, H, t));
  if (p.leak > 0.01) out.push(...leakShapes(p.leak, W, H, t, p.burn));
  const fl = (c.filters || []).filter(f => !f.off);
  const grain = Math.max(p.grain || 0, ...fl.filter(f => f.type === 'grain').map(f => f.amount ?? 0.35));
  if (grain > 0.02 && c.type === 'media') out.push(grainShape(grain, t));
  if (p.flare && p.flare.amt > 0.02) out.push(...flareShapes(p.flare, W, H));
  const lb = fl.find(f => f.type === 'letterbox');
  if ((p.bars || 0) > 0.001 || lb) out.push(...barShapes(W, H, lb?.ratio || 2.39, lb ? 1 : 0, p.bars || 0));
  return { shapes: out };
}
