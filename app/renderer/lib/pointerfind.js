// Finding the mouse pointer in a video that has no pointer file (an older tutorial, a recording from another app), so
// Smart Zoom and Auto Edit can follow it as they follow a Reel recording's. It looks for the Mac's arrow: a dark
// arrow with a light rim, whatever the background. Frames come in as greyscale (0..255), a few a second.
//
//   arrowShape(h): the arrow drawn h pixels tall, as the pixels that must be dark (inside) and light (its rim).
//   PointerTracker: fed frame after frame, says where the arrow's tip is in each (or that it can't be seen); looks
//   where the picture changed in a small spot (the pointer moving), around where it was last, and, when it has lost
//   it, over the whole picture now and then.
//   track(): the pointer file Reel writes for a recording: { display: { bounds }, points: [[ms, x, y]] } in the
//   video's own pixels, so everything that follows a recorded pointer follows this one.
// No DOM here, so it's tested in Node.

// The Mac's arrow (its black part, in points, tip at 0, 0), about 18 points tall, with a rim about 1.2 points wide
const ARROW = [[0, 0], [0, 15.5], [3.6, 12.2], [6.3, 18.3], [8.4, 17.4], [5.8, 11.4], [10.8, 11.4]];
const ARROW_H = 18.3, RIM = 1.2;
// the sizes looked for, in pixels tall on the frame searched (a 1440-point-wide screen in a 960 frame: about 12)
export const SIZES = [9, 12, 16, 21, 28, 37];

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  const k = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - ax - k * dx, py - ay - k * dy);
}
function insidePoly(px, py, poly) {
  let inn = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inn = !inn;
  }
  return inn;
}

const shapes = new Map();
/**
 * The arrow h pixels tall: { px: [[dx, dy, v]] the pixels on and around it with how light each should be (0 its dark
 * body, 1 its light rim, between on their edges), key: three of its darkest pixels, w, h } (offsets from its tip).
 */
export function arrowShape(h, ox = 0, oy = 0) {
  const id = `${h} ${ox} ${oy}`;
  if (shapes.has(id)) return shapes.get(id);
  // the tip at (ox, oy) inside its pixel: a pointer rarely sits exactly on the pixel grid
  const k = h / ARROW_H, poly = ARROW.map(([x, y]) => [ox + x * k, oy + y * k]), rimW = Math.max(0.9, RIM * k);
  const px = [];
  const w = Math.ceil(11 * k + rimW + 1), hh = Math.ceil(h + rimW + 1), m = Math.ceil(rimW) + 1;
  for (let dy = -m; dy <= hh; dy++) for (let dx = -m; dx <= w; dx++) {
    // 4 × 4 samples: how much of the pixel is body, how much rim
    let body = 0, rim = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const cx = dx + (sx + 0.5) / 4, cy = dy + (sy + 0.5) / 4;
      if (insidePoly(cx, cy, poly)) { body++; continue; }
      let d = Infinity;
      for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; d = Math.min(d, segDist(cx, cy, a[0], a[1], b[0], b[1])); }
      if (d <= rimW) rim++;
    }
    // only pixels that are all arrow (body or rim): the background shows through the others
    if (body + rim === 16) px.push([dx, dy, rim / 16]);
  }
  const key = px.filter(q => q[2] <= 0.1).sort((a, b) => a[0] + a[1] - (b[0] + b[1])).slice(0, 3);
  // three rim pixels spread round it (left of the tip, along the long edge, by the tail): they must be light
  const rims = px.filter(q => q[2] >= 0.75), pick = f => rims.reduce((a, b) => (f(b) < f(a) ? b : a));
  const lightKey = rims.length ? [pick(q => q[1] - q[0] * 0.2), pick(q => q[0] + Math.abs(q[1] - hh * 0.5)), pick(q => -q[1] - q[0])] : [];
  const s = { px, key, lightKey, w, h: hh, m, ox, oy };
  shapes.set(id, s);
  return s;
}

/**
 * How closely the frame matches the arrow h pixels tall with its tip at (x, y): the correlation of its pixels with
 * the arrow's (1 a perfect arrow, about 0 for none), or -1 where it plainly isn't (too faint, the body not dark).
 */
export function arrowScore(g, W, H, x, y, s) {
  if (x < s.m || y < s.m || x + s.w >= W || y + s.h >= H) return -1;
  let kd = 0;
  for (const [dx, dy] of s.key) { const v = g[(y + dy) * W + x + dx]; if (v > 110) return -1; kd = Math.max(kd, v); }
  for (const [dx, dy] of s.lightKey) if (g[(y + dy) * W + x + dx] < kd + (s.h < 14 ? 35 : 70)) return -1;
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, dark = 0, light = 0, nd = 0, nl = 0;
  for (const [dx, dy, v] of s.px) {
    const a = g[(y + dy) * W + x + dx];
    n++; sa += a; sb += v; saa += a * a; sbb += v * v; sab += a * v;
    if (v <= 0.25) { dark += a; nd++; } else if (v >= 0.75) { light += a; nl++; }
  }
  if (!nd || !nl || light / nl - dark / nd < 90) return -1;
  const cov = sab - (sa * sb) / n, va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : -1;
}

const PHASES = [[0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5]];
// small arrows: quarter pixels
const FINE = [0, 0.25, 0.5, 0.75].flatMap(y => [0, 0.25, 0.5, 0.75].map(x => [x, y]));
/** The best arrow in the box x0..x1, y0..y1 (tip positions) at the given sizes: { x, y, size, score } or null. */
export function searchBox(g, W, H, x0, y0, x1, y1, sizes = SIZES, step = 1, floor = 0, rough = false) {
  let best = null;
  x0 = Math.max(1, Math.floor(x0)); y0 = Math.max(1, Math.floor(y0)); x1 = Math.min(W - 2, Math.ceil(x1)); y1 = Math.min(H - 2, Math.ceil(y1));
  for (const h of sizes) for (const [ox, oy] of rough || step > 1 ? [[0.25, 0.25]] : h < 14 ? FINE : PHASES) {
    const s = arrowShape(h, ox, oy);
    for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) {
      const sc = arrowScore(g, W, H, x, y, s);
      if (sc > (best ? best.score : floor)) best = { x: x + ox, y: y + oy, size: h, score: sc };
    }
  }
  return best;
}

/** a size and the ones either side of it */
const near = h => SIZES.filter((x, i) => Math.abs(i - SIZES.indexOf(h)) <= 1);

export const MIN_SCORE = 0.88;

export class PointerTracker {
  /** W × H: the greyscale frames' size; fullW × fullH: the video's own (the points are given in its pixels). */
  constructor(W, H, fullW = W, fullH = H) {
    Object.assign(this, { W, H, fullW, fullH });
    this.prev = null; this.last = null; this.size = null; this.lostFor = Infinity; this.found = []; this.frames = 0; this.sinceFull = Infinity;
  }
  /** Small spots where the picture changed since the last frame (the pointer moving): [{ x0, y0, x1, y1 }]. */
  _moved(g) {
    const { W, H, prev } = this;
    if (!prev) return [];
    const C = 8, cw = Math.ceil(W / C), ch = Math.ceil(H / C), cells = new Uint8Array(cw * ch);
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (Math.abs(g[y * W + x] - prev[y * W + x]) > 28) cells[((y / C) | 0) * cw + ((x / C) | 0)] = 1;
    const out = [], seen = new Uint8Array(cw * ch), maxCells = 7;
    for (let i = 0; i < cells.length; i++) {
      if (!cells[i] || seen[i]) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, n = 0;
      const st = [i]; seen[i] = 1;
      while (st.length) {
        const j = st.pop(), cx = j % cw, cy = (j / cw) | 0;
        n++; x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
        for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + ax, ny = cy + ay, k = ny * cw + nx;
          if (nx >= 0 && ny >= 0 && nx < cw && ny < ch && cells[k] && !seen[k]) { seen[k] = 1; st.push(k); }
        }
        if (n > 400) break;
      }
      if (x1 - x0 < maxCells && y1 - y0 < maxCells) out.push({ x0: x0 * C, y0: y0 * C, x1: (x1 + 1) * C, y1: (y1 + 1) * C });
    }
    return out.slice(0, 24);
  }
  /** Coarse then exact: the best arrow with its tip in the box, or null. */
  _find(g, x0, y0, x1, y1, sizes) {
    const { W, H } = this;
    const rough = searchBox(g, W, H, x0, y0, x1, y1, sizes, 1, 0.5, true);
    return rough && searchBox(g, W, H, rough.x - 3, rough.y - 3, rough.x + 2, rough.y + 2, near(rough.size), 1, 0);
  }
  /** One frame (Float32Array or Uint8Array, W × H) at media time t (s). Returns { x, y } (0..1) or null. */
  push(t, g) {
    const { W, H } = this;
    const sizes = this.size ? near(this.size) : SIZES;
    const moved = this._moved(g);
    let best = null;
    const take = b => { if (b && b.score >= MIN_SCORE && (!best || b.score > best.score)) best = b; };
    const L = this.last, r = L ? 6 + L.size * 1.2 : 0;
    // nothing changed near where it was: it's still there (one look at that spot)
    if (L && this.prev && !moved.some(b => b.x1 > L.x - r && b.x0 < L.x + r && b.y1 > L.y - r && b.y0 < L.y + r)) {
      const sh = arrowShape(L.size, L.x % 1, L.y % 1), sc = arrowScore(g, W, H, Math.floor(L.x), Math.floor(L.y), sh);
      if (sc >= MIN_SCORE) best = { ...L, score: sc };
    }
    if (!best) {
      // around where it was, and where the picture changed in a small spot
      if (L) take(this._find(g, L.x - r, L.y - r, L.x + r, L.y + r, sizes));
      for (const b of moved) { const m = (this.size || 37) + 2; take(this._find(g, b.x0 - m, b.y0 - m, b.x1, b.y1, sizes)); }
    }
    // lost for a while: the whole picture, every few frames
    if (!best && this.lostFor >= 3 && this.sinceFull >= 4) { this.sinceFull = 0; take(this._find(g, 1, 1, W - 2, H - 2, SIZES)); }
    else this.sinceFull++;
    this.prev = g; this.frames++;
    if (!best) { this.lostFor++; if (this.lostFor > 15) this.size = null; return null; }
    // a size seen twice running is kept (faster, and fewer look-alikes)
    if (L && L.size === best.size) this.size = best.size;
    this.last = best; this.lostFor = 0;
    this.found.push([t, best.x, best.y]);
    return { x: best.x / W, y: best.y / H };
  }
  /** How much of the video it saw the pointer in (0..1). */
  get coverage() { return this.frames ? this.found.length / this.frames : 0; }
  /**
   * The pointer file: points in the video's own pixels, a jump that comes straight back (a look-alike for a
   * frame) left out, and gaps of up to 2 s held where it was (it hides while you type).
   */
  track() {
    const kx = this.fullW / this.W, ky = this.fullH / this.H, f = this.found, pts = [];
    for (let i = 0; i < f.length; i++) {
      const [t, x, y] = f[i], a = f[i - 1], b = f[i + 1];
      if (a && b && Math.hypot(x - a[1], y - a[2]) > 80 && Math.hypot(x - b[1], y - b[2]) > 80 && Math.hypot(a[1] - b[1], a[2] - b[2]) < 30) continue;
      const p = pts[pts.length - 1];
      if (p && t * 1000 - p[0] > 400 && t * 1000 - p[0] < 2000) pts.push([Math.round(t * 1000 - 200), p[1], p[2]]); // held, then moves on
      pts.push([Math.round(t * 1000), Math.round(x * kx * 10) / 10, Math.round(y * ky * 10) / 10]);
    }
    return { version: 2, found: 'video', display: { bounds: { x: 0, y: 0, width: this.fullW, height: this.fullH } }, rate: 5, points: pts, clicks: [], keys: [] };
  }
}
