// A frame for the Rust core to draw (picture export, step 5): what compositor.js drawFrame would draw at time t,
// written down as layers instead of drawn. Each layer is one picture: which media, the part of it shown (the
// crop, in source pixels), how its pixels land on the canvas (an affine matrix, source pixels → canvas pixels:
// position, size, turn, and a phone video's own rotation), how see-through it is, and its box's look (rounded corners,
// border, shadow). Anything more (titles, elements, filters, device frames, transition effects, pointer effects…)
// answers { why } and the frame is drawn by the JavaScript as before.
// No DOM here, so it's tested in Node.

import { activeClips, animated, propsAt, mediaById, sourceTime } from '../model.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** a·b for canvas matrices [a, b, c, d, e, f] (x' = a x + c y + e, y' = b x + d y + f), b applied first */
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const translate = (x, y) => [1, 0, 0, 1, x, y];
const scale = (x, y) => [x, 0, 0, y, 0, 0];
const rotate = deg => { const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); return [c, s, -s, c, 0, 0]; };

/** '#rgb' or '#rrggbb' → [r, g, b], else null */
export function hexRGB(s) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(s || '').trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, x => x + x) : m[1];
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}

/**
 * The frame at time t on a W × H canvas: { bg: [r, g, b], layers: [{ media, st, alpha, m: [6], rect: [x0, y0, x1,
 * y1] }] } (bottom first), or { why } when it needs more than pictures. size(m) gives a media's picture size as
 * decoded ({ w, h }; its rotation is the media's own), st is the moment of the source shown.
 */
export function framePlan(doc, t, W, H, size = m => ({ w: m.width || 0, h: m.height || 0 })) {
  const bg = hexRGB(doc.canvas.background || '#000');
  if (!bg) return { why: 'a background colour that isn’t a plain colour' };
  const cs = doc.captionStyle || {};
  if (cs.burn && (doc.captions || []).some(c => t >= c.t && t < c.end)) return { why: 'burned-in captions' };
  const layers = [];
  for (const k of activeClips(doc, t)) {
    if (k.type !== 'media') return { why: k.type === 'element' ? 'elements' : k.type === 'text' ? 'titles' : 'call-outs and drawings' };
    const local = t - k.start;
    const c = animated(k, local), p = propsAt(c, local);
    if (p.dip || p.mask || p.textMask || (p.shutter != null && p.shutter < 1) || p.vertigo || p.blocks > 0.03 || p.streak || p.holes > 0.02 || p.glitch > 0.05 || p.leak > 0.01 || p.grain > 0.02 || p.flare || (p.bars || 0) > 0.001)
      return { why: 'transition effects' };
    if (p.opacity <= 0.001) continue;
    const m = mediaById(doc, c.media);
    if (!m || m.kind === 'audio') continue;
    if ((c.filters || []).some(f => !f.off) || (c.matte && c.matte.file && !c.matte.off) || c.levels || (m.convertedFrom === 'screenflow' && m.kind === 'video' && !m.rangeOk) || p.split > 0.02) return { why: 'filters' };
    if (p.blur || (p.bright != null && Math.abs(p.bright - 1) > 0.005) || (p.sat != null && Math.abs(p.sat - 1) > 0.005)) return { why: 'blur and exposure moves' };
    if ((c.frame && c.frame.type && c.frame.type !== 'none') || (c.stab && m.kind === 'video')) return { why: 'device frames and stabilizing' };
    if ((c.cursor && c.cursor.show !== false) || m.pointerSeparate || (c.keystrokes && c.keystrokes.show)) return { why: 'pointer and keystroke effects' };
    const { w: srcW, h: srcH } = size(m);
    if (!(srcW > 0 && srcH > 0)) return { why: 'a picture whose size isn’t known' };
    // compositor.js drawMedia, as matrices
    const rot = (((m.rotation || 0) % 360) + 360) % 360;
    const swap = rot === 90 || rot === 270, dispW = swap ? srcH : srcW, dispH = swap ? srcW : srcH;
    const cw0 = dispW * (1 - p.crop[0] - p.crop[2]), ch0 = dispH * (1 - p.crop[1] - p.crop[3]);
    const fit = Math.min(W / Math.max(1, cw0), H / Math.max(1, ch0));
    const r = { cx: p.x * W, cy: p.y * H, w: cw0 * fit * p.scale, h: ch0 * fit * p.scale };
    let M = translate(r.cx, r.cy);
    if (p.rotation) M = mul(M, rotate(p.rotation));
    const cl = p.crop[0] * dispW, ct = p.crop[1] * dispH, cw = cw0, chh = ch0;
    let rect;
    if (rot) {
      // the whole source drawn turned (as the JavaScript: its crop moves it, nothing clips it)
      M = mul(M, scale(r.w / cw, r.h / chh)); M = mul(M, translate(-cl - cw / 2, -ct - chh / 2)); M = mul(M, translate(dispW / 2, dispH / 2)); M = mul(M, rotate(rot)); M = mul(M, translate(-srcW / 2, -srcH / 2));
      rect = [0, 0, srcW, srcH];
    } else {
      // drawImage(img, cl, ct, cw, chh, −w/2, −h/2, w, h): the source rectangle onto the clip's rectangle
      M = mul(M, translate(-r.w / 2, -r.h / 2)); M = mul(M, scale(r.w / cw, r.h / chh)); M = mul(M, translate(-cl, -ct));
      rect = [cl, ct, cl + cw, ct + chh];
    }
    if (!M.every(Number.isFinite) || !(Math.abs(M[0] * M[3] - M[1] * M[2]) > 1e-12)) continue; // squashed to nothing: nothing to draw
    // rounded corners, a border, a shadow (1.4): the clip's box as drawMedia draws it (corners and widths are set at
    // the canvas's size: scaled to this frame's)
    const sx = W / (doc.canvas.width || W);
    let look = null;
    if (p.radius > 0 || p.border > 0 || p.shadow > 0) {
      let B = translate(r.cx, r.cy);
      if (p.rotation) B = mul(B, rotate(p.rotation));
      B = mul(B, scale(r.w, r.h));
      look = { b: B, w: r.w, h: r.h, radius: Math.max(0, (p.radius || 0) * sx), border: Math.max(0, (p.border || 0) * sx), borderColor: hexRGB(p.borderColor || '#fff') || [255, 255, 255], shadow: Math.max(0, (p.shadow || 0) * sx), dy: Math.max(0, (p.shadow || 0) * sx * 0.25) };
    }
    layers.push({ media: m.id, clip: c.id, st: sourceTime(c, t), alpha: clamp(p.opacity, 0, 1), m: M, rect, look });
  }
  return { bg, layers };
}
