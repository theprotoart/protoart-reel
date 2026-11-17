// Sketch, the way Preview's Markup does it: draw a shape roughly and it comes out clean. A stroke (points in canvas
// fractions) is read as a line, an arrow, a box, an oval, a triangle or other polygon, or a star; anything it can't
// read is kept as it was drawn. No DOM here, so it's tested in Node.
//
//   recognize(pts, aspect): { shape, x1, y1, x2, y2, sides?, points? } in the canvas fractions shape clips use (the
//   box a closed shape fills, or a line's two ends), or null. aspect: the canvas's width / height, so a circle drawn
//   on a wide canvas is still read as round.

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const pathLen = p => p.reduce((s, q, i) => (i ? s + dist(p[i - 1], q) : 0), 0);

/** The stroke as n points evenly spaced along it. */
export function resample(p, n) {
  const L = pathLen(p);
  if (p.length < 2 || L === 0) return p.slice();
  const step = L / (n - 1), out = [p[0]];
  let acc = 0;
  for (let i = 1; i < p.length; i++) {
    let a = p[i - 1];
    const b = p[i];
    let d = dist(a, b);
    while (acc + d >= step && out.length < n) {
      const k = (step - acc) / d, q = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
      out.push(q); a = q; d = dist(a, b); acc = 0;
    }
    acc += d;
  }
  while (out.length < n) out.push(p[p.length - 1]);
  return out;
}

/** How far the path turns at each point (radians, 0 straight), over a window of w points either side. */
function turns(p, w, closed) {
  const n = p.length, out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const ia = closed ? (i - w + n) % n : i - w, ib = closed ? (i + w) % n : i + w;
    if (ia < 0 || ib >= n) continue;
    const a = p[ia], b = p[i], c = p[ib];
    const a1 = Math.atan2(b[1] - a[1], b[0] - a[0]), a2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
    let d = Math.abs(a2 - a1);
    if (d > Math.PI) d = 2 * Math.PI - d;
    out[i] = d;
  }
  return out;
}

/** The sharp corners: the sharpest point of each run that turns more than `min` (indices, in order). */
function corners(p, closed, min = 0.85, w = 3) {
  const t = turns(p, w, closed), n = p.length, out = [];
  let i = 0;
  // on a closed path, start where it's straight so a corner isn't split in two
  let start = 0;
  if (closed) { while (start < n && t[start] > min) start++; if (start === n) return []; }
  while (i < n) {
    const k = (start + i) % n;
    if (t[k] > min) {
      let best = k, j = i;
      while (j < n && t[(start + j) % n] > min) { const q = (start + j) % n; if (t[q] > t[best]) best = q; j++; }
      out.push(best); i = j;
    } else i++;
  }
  return closed ? out.sort((a, b) => a - b) : out;
}

/**
 * Reads one stroke. pts: [[x, y]] canvas fractions (0..1). Returns the clean shape or null (keep the drawing).
 */
export function recognize(pts, aspect = 16 / 9) {
  if (!pts || pts.length < 4) return null;
  // work in a square space so circles are round
  const sq = pts.map(([x, y]) => [x * aspect, y]);
  const L = pathLen(sq);
  const xs = sq.map(q => q[0]), ys = sq.map(q => q[1]);
  const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
  const diag = Math.hypot(bx1 - bx0, by1 - by0);
  if (diag < 0.015 || L < 0.02) return null; // a dot or a tiny scribble
  const back = (x, y) => [x / aspect, y];
  const box = shape => { const [x1, y1] = back(bx0, by0), [x2, y2] = back(bx1, by1); return { shape, x1: r4(x1), y1: r4(y1), x2: r4(x2), y2: r4(y2) }; };
  const gap = dist(sq[0], sq[sq.length - 1]);
  const closed = gap < Math.max(0.2 * diag, 0.06 * L);

  if (!closed) {
    const p = resample(sq, 48);
    const cs = corners(p, false, 1.6, 2); // a sharp turn back: the head of an arrow
    // straight from the start to the first sharp turn back, with only a short tail after it: an arrow
    if (cs.length) {
      const c = cs[0], shaft = pathLen(p.slice(0, c + 1)), tail = pathLen(p.slice(c));
      const straight = dist(p[0], p[c]) / Math.max(1e-9, shaft);
      if (straight > 0.9 && tail < shaft * 0.6 && shaft > 0.03) {
        const [x1, y1] = back(...p[0]), [x2, y2] = back(...p[c]);
        return { shape: 'arrow', x1: r4(x1), y1: r4(y1), x2: r4(x2), y2: r4(y2) };
      }
    }
    if (gap / L > 0.92) {
      const [x1, y1] = back(...sq[0]), [x2, y2] = back(...sq[sq.length - 1]);
      return { shape: 'line', x1: r4(x1), y1: r4(y1), x2: r4(x2), y2: r4(y2) };
    }
    return null;
  }

  // closed: an oval, or a polygon by its corners, or a star by its corners going in and out
  const p = resample(sq, 72);
  const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2, rx = Math.max(1e-6, (bx1 - bx0) / 2), ry = Math.max(1e-6, (by1 - by0) / 2);
  const ovalErr = p.reduce((s, [x, y]) => s + Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1), 0) / p.length;
  const cs = corners(p, true);
  if (cs.length >= 6) {
    // a star: corners alternately far from and near the middle
    const mx = cs.reduce((s, i) => s + p[i][0], 0) / cs.length, my = cs.reduce((s, i) => s + p[i][1], 0) / cs.length;
    const rad = cs.map(i => Math.hypot(p[i][0] - mx, p[i][1] - my));
    const outer = rad.filter((_, k) => k % 2 === 0), inner = rad.filter((_, k) => k % 2 === 1);
    const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
    const [hi, lo] = avg(outer) > avg(inner) ? [outer, inner] : [inner, outer];
    if (cs.length % 2 === 0 && Math.max(...lo) < Math.min(...hi) && avg(lo) / avg(hi) < 0.75) return { ...box('star'), points: cs.length / 2 };
  }
  if (cs.length <= 2 && ovalErr < 0.2) return box('ellipse');
  if (cs.length === 3) return { ...box('polygon'), sides: 3 };
  if (cs.length === 4) return box('rect');
  if (cs.length === 5 || cs.length === 6) return { ...box('polygon'), sides: cs.length };
  // seven or eight corners: a rough oval more often than a heptagon
  if (cs.length <= 8) return ovalErr < 0.15 ? box('ellipse') : { ...box('polygon'), sides: cs.length };
  if (ovalErr < 0.25) return box('ellipse');
  return null;
}

const r4 = v => Math.round(v * 10000) / 10000;

/** The points of a star or regular polygon in its box (fractions of the box, 0..1), for drawing it. */
export function polyPoints(kind, n) {
  const out = [];
  if (kind === 'star') {
    const k = Math.max(3, n | 0);
    for (let i = 0; i < k * 2; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / k, r = i % 2 ? 0.2 : 0.5;
      out.push([0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r * 1.0]);
    }
  } else {
    const k = Math.max(3, n | 0);
    for (let i = 0; i < k; i++) { const a = -Math.PI / 2 + (i * 2 * Math.PI) / k; out.push([0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5]); }
  }
  // stretched to fill the box top to bottom (a triangle's base sits on the box's bottom)
  const ys = out.map(q => q[1]), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return out.map(([x, y]) => [x, (y - y0) / Math.max(1e-6, y1 - y0)]);
}
