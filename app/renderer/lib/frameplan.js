// A frame for the Rust core to draw (picture export, step 5): what compositor.js drawFrame would draw at time t,
// written down as layers instead of drawn. Each layer is one picture: which media, the part of it shown (the
// crop, in source pixels), how its pixels land on the canvas (an affine matrix, source pixels → canvas pixels:
// position, size, turn, and a phone video's own rotation), how see-through it is, and its box's look (rounded corners,
// border, shadow). Anything more (titles, elements, filters, device frames, transition effects, pointer effects…)
// answers { why } and the frame is drawn by the JavaScript as before.
// No DOM here, so it's tested in Node.

import { activeClips, animated, propsAt, mediaById, sourceTime } from '../model.js';
import { stabilizeAt } from './stabilize.js';
import { filterParams, needsGl } from './glfx.js';

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
    if (p.mask || p.textMask || (p.shutter != null && p.shutter < 1) || p.vertigo || p.blocks > 0.03 || p.streak || p.holes > 0.02 || p.glitch > 0.05 || p.leak > 0.01 || p.grain > 0.02 || p.flare || (p.bars || 0) > 0.001)
      return { why: 'transition effects' };
    // a dip to black or white: a colour over everything drawn so far (after this clip, as drawFrame does)
    const dip = p.dip && p.dip.amount > 0 ? { fill: hexRGB(p.dip.color) || [0, 0, 0], alpha: clamp(p.dip.amount, 0, 1) } : null;
    if (p.opacity <= 0.001) { if (dip) layers.push(dip); continue; }
    const m = mediaById(doc, c.media);
    if (!m || m.kind === 'audio') continue;
    // the clip's filters (1.7): the GPU pass's colour work, as compositor.js drawMedia sets it up (a LUT file or a
    // background-removal matte stays with the JavaScript)
    const matteOn = !!(c.matte && c.matte.file && !c.matte.off);
    const legacy = m.convertedFrom === 'screenflow' && m.kind === 'video' && !m.rangeOk;
    const lv = c.levels || legacy ? { ...(legacy ? { outBlack: 16 / 255, outWhite: 235 / 255 } : {}), ...(c.levels || {}) } : null;
    let fblur = 0, u = null;
    if ((c.filters && c.filters.length) || matteOn || lv || p.split > 0.02) {
      u = filterParams(c.filters, lv);
      if (p.split > 0.02) u.aberr += p.split * 1.6;
      fblur = u.blur;
      if (!needsGl(u, matteOn)) u = null;
      else if (matteOn || u.lut) return { why: 'background removal and LUT filters' };
    }
    // blur, exposure and colour moves (1.6): drawn as the canvas filter; with a rounded or shadowed box the filter
    // softens those too, which isn't done here yet
    const filtered = !!(p.blur || fblur) || (p.bright != null && Math.abs(p.bright - 1) > 0.005) || (p.sat != null && Math.abs(p.sat - 1) > 0.005);
    if (filtered && (p.radius || p.shadow > 0 || p.border > 0 || (c.stab && m.kind === 'video'))) return { why: 'blur and exposure moves on a rounded, bordered or stabilized picture' };
    if (c.frame && c.frame.type && c.frame.type !== 'none') return { why: 'device frames' };
    if ((c.cursor && c.cursor.show !== false) || m.pointerSeparate || (c.keystrokes && c.keystrokes.show)) return { why: 'pointer and keystroke effects' };
    const { w: srcW0, h: srcH0 } = size(m);
    if (!(srcW0 > 0 && srcH0 > 0)) return { why: 'a picture whose size isn’t known' };
    // filtered: graded at the size it's shown (as the editor), and laid out from that picture's size
    let srcW = srcW0, srcH = srcH0, grade = null, gk = 1;
    if (u) {
      if ((((m.rotation || 0) % 360) + 360) % 360) return { why: 'filters on a turned phone video' };
      const show = Math.min(1, ((W * Math.max(0.05, p.scale)) / Math.max(1, srcW0)) * 1.25);
      const gw = Math.max(1, Math.round(srcW0 * show)), gh = Math.max(1, Math.round(srcH0 * show));
      grade = { ...u, gw, gh };
      gk = show; srcW = gw / show; srcH = gh / show;
    }
    // compositor.js drawMedia, as matrices
    const rot = (((m.rotation || 0) % 360) + 360) % 360;
    const swap = rot === 90 || rot === 270, dispW = swap ? srcH : srcW, dispH = swap ? srcW : srcH;
    const cw0 = dispW * (1 - p.crop[0] - p.crop[2]), ch0 = dispH * (1 - p.crop[1] - p.crop[3]);
    const fit = Math.min(W / Math.max(1, cw0), H / Math.max(1, ch0));
    const r = { cx: p.x * W, cy: p.y * H, w: cw0 * fit * p.scale, h: ch0 * fit * p.scale };
    let M = translate(r.cx, r.cy);
    if (p.rotation) M = mul(M, rotate(p.rotation));
    const box = mul(M, scale(r.w, r.h)); // the clip's box: -0.5..0.5 of it onto the canvas
    // stabilized: the picture moves against the camera's shake inside its box, zoomed so its edges stay out of sight
    const stab = c.stab && m.kind === 'video' ? stabilizeAt(c.stab, sourceTime(c, t)) : null;
    if (stab) { M = mul(M, scale(stab.zoom, stab.zoom)); M = mul(M, translate(stab.x * r.w, stab.y * r.h)); if (stab.rot) M = mul(M, rotate((stab.rot * 180) / Math.PI)); }
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
      if (gk !== 1) { M = mul(M, scale(1 / gk, 1 / gk)); rect = rect.map(v => v * gk); } // the graded picture: gk of its px per source px
    }
    if (!M.every(Number.isFinite) || !(Math.abs(M[0] * M[3] - M[1] * M[2]) > 1e-12)) continue; // squashed to nothing: nothing to draw
    // rounded corners, a border, a shadow (1.4): the clip's box as drawMedia draws it (corners and widths are set at
    // the canvas's size: scaled to this frame's)
    const sx = W / (doc.canvas.width || W);
    let look = null;
    if (p.radius > 0 || p.border > 0 || p.shadow > 0 || stab) {
      look = { b: box, w: r.w, h: r.h, radius: Math.max(0, (p.radius || 0) * sx), border: Math.max(0, (p.border || 0) * sx), borderColor: hexRGB(p.borderColor || '#fff') || [255, 255, 255], shadow: Math.max(0, (p.shadow || 0) * sx), dy: Math.max(0, (p.shadow || 0) * sx * 0.25), cut: !!stab };
    }
    const filter = filtered ? { blur: Math.max(0, ((p.blur || 0) + fblur) * sx), bright: p.bright != null && Math.abs(p.bright - 1) > 0.005 ? +p.bright.toFixed(3) : 1, sat: p.sat != null && Math.abs(p.sat - 1) > 0.005 ? +Math.max(0, p.sat).toFixed(3) : 1 } : null;
    layers.push({ media: m.id, clip: c.id, st: sourceTime(c, t), alpha: clamp(p.opacity, 0, 1), m: M, rect, look, filter, grade });
    if (dip) layers.push(dip);
  }
  return { bg, layers };
}

/**
 * The Rust core's `frame` job for a plan (its body after "RCORE1\nframe\n"): the canvas size and background, the
 * pictures (each { w, h, rgba }, in the order `ids` gives the plan's media ids), every layer, and where to write the
 * frame. One place for the format (native/reel-core/src/main.rs frame_job reads it).
 */
export function encodeFrame(plan, W, H, ids, pictures, out) {
  const chunks = [];
  let size = 0;
  const push = b => { chunks.push(b); size += b.length; };
  const u8 = v => push(Uint8Array.of(v));
  const u32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); push(b); };
  const f64 = v => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, +v, true); push(b); };
  const rgb01 = h => { const x = hexRGB(h) || [0, 0, 0]; return x.map(v => v / 255); };
  u32(W); u32(H); push(Uint8Array.from(plan.bg));
  u32(pictures.length);
  for (const p of pictures) { u32(p.w); u32(p.h); push(p.rgba instanceof Uint8Array ? p.rgba : new Uint8Array(p.rgba)); }
  u32(plan.layers.length);
  for (const l of plan.layers) {
    if (l.fill) { u32(0xffffffff); f64(l.alpha); push(Uint8Array.from(l.fill)); continue; }
    u32(ids.indexOf(l.media)); f64(l.alpha); l.m.forEach(f64); l.rect.forEach(f64);
    const k = l.look;
    if (!k) u8(0); else { u8(1); k.b.forEach(f64); [k.w, k.h, k.radius, k.border].forEach(f64); push(Uint8Array.from(k.borderColor)); [k.shadow, k.dy].forEach(f64); u8(k.cut ? 1 : 0); }
    const f = l.filter;
    if (!f) u8(0); else { u8(1); [f.blur, f.bright, f.sat].forEach(f64); }
    const g = l.grade;
    if (!g) u8(0);
    else {
      u8(1); u32(g.gw); u32(g.gh);
      for (const n of ['exposure', 'contrast', 'saturation', 'vibrance', 'temperature', 'tint', 'highlights', 'shadows']) f64(g[n] || 0);
      [g.inBlack ?? 0, g.inWhite ?? 1, g.gammaV ?? 1, g.outBlack ?? 0, g.outWhite ?? 1, g.brightness || 0].forEach(f64);
      for (const n of ['sharpen', 'vignette', 'bw', 'aberr']) f64(g[n] || 0);
      if (g.key) { u8(1); [...rgb01(g.key.color), g.key.tol, g.key.soft, g.key.spill].forEach(f64); } else u8(0);
      [...(g.mMul || [1, 1, 1]), ...(g.mAdd || [0, 0, 0]), ...(g.lift || [0, 0, 0]), ...(g.gam || [1, 1, 1]), ...(g.gain || [1, 1, 1])].forEach(f64);
    }
  }
  const ob = new TextEncoder().encode(out);
  u32(ob.length); push(ob);
  const all = new Uint8Array(size);
  let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  return all;
}
