// Video stabilization. Analysis follows the camera from frame to frame on small grey frames (side to side, up and
// down, and a little rotation, found by matching the four quarters of the picture); the result is kept on the clip as
// the camera's path in source time. When drawing, the path is smoothed (slow, intended moves stay; jitter goes) and
// the picture is moved by the difference, zoomed in just enough that its moving edges stay out of sight. Nothing is
// re-encoded: the same correction runs in the preview and the export, and can be turned off or adjusted at any time.

/** Grey levels (0..255) of an RGBA frame, at w × h. */
export function toGrey(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = rgba[j] * 0.299 + rgba[j + 1] * 0.587 + rgba[j + 2] * 0.114;
  return g;
}

/** Halves an image (box filter). */
function half(g, w, h) {
  const W = w >> 1, H = h >> 1, o = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = 2 * y * w + 2 * x;
    o[y * W + x] = (g[i] + g[i + 1] + g[i + w] + g[i + w + 1]) * 0.25;
  }
  return { g: o, w: W, h: H };
}

/** Mean absolute difference of region (x0,y0,rw,rh) of a against b shifted by (dx,dy). Lower is better. */
function sad(a, b, w, h, x0, y0, rw, rh, dx, dy) {
  let s = 0, n = 0;
  for (let y = y0; y < y0 + rh; y += 1) {
    const yb = y + dy; if (yb < 0 || yb >= h) continue;
    for (let x = x0; x < x0 + rw; x += 1) {
      const xb = x + dx; if (xb < 0 || xb >= w) continue;
      s += Math.abs(a[y * w + x] - b[yb * w + xb]); n++;
    }
  }
  return n ? s / n : Infinity;
}

/** Best whole-pixel shift of a region of a in b within ±r of (cx,cy), then a sub-pixel refinement. */
function match(a, b, w, h, x0, y0, rw, rh, cx, cy, r) {
  let best = Infinity, bx = cx, by = cy;
  for (let dy = cy - r; dy <= cy + r; dy++) for (let dx = cx - r; dx <= cx + r; dx++) {
    const v = sad(a, b, w, h, x0, y0, rw, rh, dx, dy);
    if (v < best) { best = v; bx = dx; by = dy; }
  }
  // parabola through the neighbours for a fraction of a pixel
  const fx = (l, c, rr) => { const d = l - 2 * c + rr; return d > 1e-6 ? 0.5 * (l - rr) / d : 0; };
  const sx = fx(sad(a, b, w, h, x0, y0, rw, rh, bx - 1, by), best, sad(a, b, w, h, x0, y0, rw, rh, bx + 1, by));
  const sy = fx(sad(a, b, w, h, x0, y0, rw, rh, bx, by - 1), best, sad(a, b, w, h, x0, y0, rw, rh, bx, by + 1));
  return { dx: bx + Math.max(-0.5, Math.min(0.5, sx)), dy: by + Math.max(-0.5, Math.min(0.5, sy)), err: best };
}

/**
 * How the picture moved from frame a to frame b (grey, w × h): { dx, dy } in fractions of the width / height and
 * rot in radians. Coarse to fine (a quarter-size search first), on the four quarters of the frame, so a turn of the
 * camera shows up as the quarters moving in opposite directions.
 */
export function estimateMotion(a, b, w, h) {
  const a1 = half(a, w, h), b1 = half(b, w, h), a2 = half(a1.g, a1.w, a1.h), b2 = half(b1.g, b1.w, b1.h);
  // whole frame, coarse then fine
  const m = 0.15;
  const coarse = match(a2.g, b2.g, a2.w, a2.h, Math.round(a2.w * m), Math.round(a2.h * m), Math.round(a2.w * (1 - 2 * m)), Math.round(a2.h * (1 - 2 * m)), 0, 0, Math.max(3, Math.round(a2.w * 0.06)));
  const cx = Math.round(coarse.dx * 4), cy = Math.round(coarse.dy * 4);
  const qs = [[0.08, 0.08], [0.55, 0.08], [0.08, 0.55], [0.55, 0.55]].map(([qx, qy]) =>
    ({ qx, qy, ...match(a, b, w, h, Math.round(w * qx), Math.round(h * qy), Math.round(w * 0.37), Math.round(h * 0.37), cx, cy, 3) }));
  const dx = qs.reduce((s, q) => s + q.dx, 0) / 4, dy = qs.reduce((s, q) => s + q.dy, 0) / 4;
  // rotation (small angles): right quarters move down and left ones up for a clockwise turn, and so on
  const ccx = w / 2, ccy = h / 2;
  let num = 0, den = 0;
  for (const q of qs) {
    const px = w * (q.qx + 0.185) - ccx, py = h * (q.qy + 0.185) - ccy;
    const rx = q.dx - dx, ry = q.dy - dy;
    num += px * ry - py * rx; den += px * px + py * py;
  }
  return { dx: dx / w, dy: dy / h, rot: den ? num / den : 0 };
}

/** Running sums of the frame-to-frame moves: the camera's path. */
export function cumulative(moves) {
  const x = [0], y = [0], r = [0];
  for (let i = 0; i < moves.length; i++) { x.push(x[i] + moves[i].dx); y.push(y[i] + moves[i].dy); r.push(r[i] + moves[i].rot); }
  return { x, y, r };
}

/** A path smoothed with a Gaussian of `sigma` samples (edges held). */
export function smoothPath(p, sigma) {
  if (sigma < 0.5) return p.slice();
  const k = Math.ceil(sigma * 3), wts = [];
  for (let i = -k; i <= k; i++) wts.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const out = new Array(p.length);
  for (let i = 0; i < p.length; i++) {
    let s = 0, n = 0;
    for (let j = -k; j <= k; j++) { const v = p[Math.max(0, Math.min(p.length - 1, i + j))]; s += v * wts[j + k]; n += wts[j + k]; }
    out[i] = s / n;
  }
  return out;
}

/**
 * The correction for a clip's stabilization data at its smoothness: per sample, how far to move the picture back
 * (x, y fractions; rot radians), and the zoom that hides the moving edges (from the 98th percentile of the moves).
 */
export function corrections(stab, smooth = stab.smooth ?? 1.5) {
  const sig = Math.max(0.5, smooth * stab.rate);
  const sx = smoothPath(stab.x, sig), sy = smoothPath(stab.y, sig), sr = smoothPath(stab.r, sig);
  const cx = stab.x.map((v, i) => sx[i] - v), cy = stab.y.map((v, i) => sy[i] - v), cr = stab.r.map((v, i) => sr[i] - v);
  const p98 = a => { const s = a.map(Math.abs).sort((m, n) => m - n); return s[Math.floor(s.length * 0.98)] || 0; };
  const need = Math.max(p98(cx), p98(cy)) * 2 + p98(cr) * 0.9;
  const zoom = stab.zoom > 0 ? stab.zoom : Math.min(1.35, 1 + need * 1.05);
  return { x: cx, y: cy, r: cr, zoom };
}

const cache = new WeakMap();
/** The correction at source time st (seconds), interpolated; null if there's none. */
export function stabilizeAt(stab, st) {
  if (!stab || stab.off || !stab.x?.length) return null;
  let c = cache.get(stab);
  const key = `${stab.smooth}|${stab.zoom}|${stab.strength}`;
  if (!c || c.key !== key) { c = { key, ...corrections(stab) }; cache.set(stab, c); }
  const f = Math.max(0, (st - (stab.t0 || 0)) * stab.rate), i = Math.min(c.x.length - 1, Math.floor(f)), j = Math.min(c.x.length - 1, i + 1), u = f - i;
  const k = stab.strength ?? 1; // 0..1: how much of the shake to take out
  return { x: (c.x[i] + (c.x[j] - c.x[i]) * u) * k, y: (c.y[i] + (c.y[j] - c.y[i]) * u) * k, rot: (c.r[i] + (c.r[j] - c.r[i]) * u) * k, zoom: 1 + (c.zoom - 1) * k };
}
