// Text reveal transition: the incoming clip shows through big bold words over the outgoing one; the words grow,
// zooming into a point deep inside one letter, until that letter covers the whole frame and the incoming clip
// simply plays. The point is found once per text (the spot furthest from any edge of the letters), so the zoom
// never flies into a gap between letters.

const FAMILY = '"Avenir Next Condensed", "Avenir Next", Impact, "Helvetica Neue", Arial, sans-serif';
export const revealFont = (size, fam) => `900 ${size}px ${fam ? `"${fam}", ` : ''}${FAMILY}`;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const k = clamp((x - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };
const canvas = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));

/**
 * The deepest point inside a 0/1 picture (w × h, alpha array): the filled pixel whose nearest edge, looking
 * left, right, up and down, is furthest away (ties go to the one nearest the middle). Returns { x, y, r }.
 */
export function deepestPoint(on, w, h) {
  const Lr = new Uint16Array(w * h), Rr = new Uint16Array(w * h), Uc = new Uint16Array(w * h), Dc = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    let run = 0; for (let x = 0; x < w; x++) { const i = y * w + x; run = on[i] ? run + 1 : 0; Lr[i] = run; }
    run = 0; for (let x = w - 1; x >= 0; x--) { const i = y * w + x; run = on[i] ? run + 1 : 0; Rr[i] = run; }
  }
  for (let x = 0; x < w; x++) {
    let run = 0; for (let y = 0; y < h; y++) { const i = y * w + x; run = on[i] ? run + 1 : 0; Uc[i] = run; }
    run = 0; for (let y = h - 1; y >= 0; y--) { const i = y * w + x; run = on[i] ? run + 1 : 0; Dc[i] = run; }
  }
  let best = { x: w / 2, y: h / 2, r: 0 }, bestScore = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!on[i]) continue;
    const r = Math.min(Lr[i], Rr[i], Uc[i], Dc[i]);
    const score = r - Math.hypot(x - w / 2, y - h / 2) * 0.004;
    if (score > bestScore) { bestScore = score; best = { x, y, r }; }
  }
  return best;
}

const cache = new Map();
/** The words at a base size: their box and the deepest point (offset from the box centre), measured once. */
function layout(text, fam) {
  const key = `${text}|${fam || ''}`;
  if (cache.has(key)) return cache.get(key);
  const S = 160;
  let c = canvas(8, 8), x = c.getContext('2d');
  x.font = revealFont(S, fam);
  const w = Math.ceil(x.measureText(text).width) + 16, h = Math.ceil(S * 1.15) + 16;
  c = canvas(w, h); x = c.getContext('2d', { willReadFrequently: true });
  x.font = revealFont(S, fam); x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillStyle = '#fff';
  x.fillText(text, w / 2, h / 2);
  const px = x.getImageData(0, 0, w, h).data, on = new Uint8Array(w * h);
  for (let i = 0; i < on.length; i++) on[i] = px[i * 4 + 3] > 140 ? 1 : 0;
  const d = deepestPoint(on, w, h);
  const out = { S, w, h, ax: d.x - w / 2, ay: d.y - h / 2, r: Math.max(2, d.r) };
  cache.set(key, out);
  if (cache.size > 24) cache.delete(cache.keys().next().value);
  return out;
}

/**
 * Where the words are at progress k (0..1) on a W × H frame: the transform for drawing them at the base size
 * centred on (0, 0), their opacity, and how much of the full picture is let through at the end (0..1).
 */
export function revealState(text, fam, k, W, H) {
  const L = layout(text, fam);
  const s0 = Math.min((W * 0.8) / L.w, (H * 0.5) / L.h); // the words' resting size: 80% of the width at most
  const grow = clamp((k - 0.28) / 0.72, 0, 1), e = grow ** 2.4; // a beat to read them, then an accelerating zoom
  const cover = (Math.hypot(W, H) / 2 / (L.r * s0)) * 1.2; // how much bigger before that letter covers the frame
  const pop = k < 0.28 ? 0.92 + 0.08 * (1 - (1 - k / 0.28) ** 3) : 1;
  const f = s0 * pop * cover ** e;
  return { L, f, tx: W / 2 - L.ax * e * f, ty: H / 2 - L.ay * e * f, alpha: clamp(k / 0.1, 0, 1), full: smooth(0.8, 1, k) };
}

let layer = null, mask = null;
const sized = (c, W, H) => { if (!c || c.width !== W || c.height !== H) c = canvas(W, H); return c; };

/** A clean W × H layer to draw the incoming clip on. */
export function revealLayer(W, H) {
  layer = sized(layer, W, H);
  const x = layer.getContext('2d');
  x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; x.filter = 'none';
  x.clearRect(0, 0, W, H);
  return x;
}

/** Cuts the layer to the words and puts it on the frame (with a soft shadow under the words). */
export function finishReveal(ctx, lctx, tm, W, H) {
  const text = (String(tm.text || '').trim() || 'NEXT').toUpperCase().slice(0, 40);
  const st = revealState(text, tm.font, tm.k, W, H);
  mask = sized(mask, W, H);
  const m = mask.getContext('2d');
  m.setTransform(1, 0, 0, 1, 0, 0); m.globalAlpha = 1; m.globalCompositeOperation = 'source-over'; m.clearRect(0, 0, W, H);
  const words = (c, style) => {
    c.save(); c.setTransform(st.f, 0, 0, st.f, st.tx, st.ty);
    c.font = revealFont(st.L.S, tm.font); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = style;
    c.fillText(text, 0, 0); c.restore();
  };
  m.globalAlpha = st.alpha; words(m, '#fff');
  if (st.full > 0) { m.globalAlpha = st.full; m.fillStyle = '#fff'; m.fillRect(0, 0, W, H); }
  // a shadow under the words, so they stand off the outgoing picture
  if (st.full < 1) {
    ctx.save(); ctx.globalAlpha = 0.45 * st.alpha * (1 - st.full);
    ctx.shadowColor = 'rgba(0,0,0,1)'; ctx.shadowBlur = 28; ctx.shadowOffsetY = 6;
    words(ctx, 'rgba(0,0,0,0.6)'); ctx.restore();
  }
  lctx.save(); lctx.setTransform(1, 0, 0, 1, 0, 0); lctx.globalCompositeOperation = 'destination-in'; lctx.drawImage(mask, 0, 0); lctx.restore();
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.drawImage(lctx.canvas, 0, 0); ctx.restore();
}
