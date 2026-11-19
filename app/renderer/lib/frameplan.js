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
import { isBackgroundElement } from './elements.js';
import { effectShapes, shutterGeom } from './fxshapes.js';

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
export function framePlan(doc, t, W, H, size = m => ({ w: m.width || 0, h: m.height || 0 }), cursor = null, { luts = null } = {}) {
  const bg = hexRGB(doc.canvas.background || '#000');
  if (!bg) return { why: 'a background colour that isn’t a plain colour' };
  const cs = doc.captionStyle || {};
  // titles, call-outs, graphics, shapes, drawings and burned captions (1.12): the editor draws them, over everything
  // the core draws (as drawFrame puts them over the pictures), and they come to the core as pictures
  let overlay = !!(cs.burn && (doc.captions || []).some(c => t >= c.t && t < c.end)), blur = false;
  const layers = [];
  let slots = 0, needs15 = false;
  const overFx = []; // titles and graphics with transition effects, in order
  const keys = []; // slot number → the key the editor draws it under (the slots that aren't layers: a text reveal's cut)
  for (const k of activeClips(doc, t)) {
    if (k.type !== 'media') {
      const q = propsAt(animated(k, t - k.start), t - k.start);
      // a background graphic (1.13): the editor draws it, into its place in the stack (a slot the core leaves for it)
      // its transition effects (1.15), as ink the core paints after it (the editor leaves them out of its drawing)
      const fq = effectShapes(animated(k, t - k.start), q, t, W, H).shapes;
      const fqInk = fq.length ? { ink: { m: [1, 0, 0, 1, 0, 0], clip: null, cut: null, shapes: fq }, alpha: 1 } : null;
      // a dip at the same time (1.15): after the effects, as the editor (which leaves it out of its drawing then)
      const qDip = fqInk && q.dip && q.dip.amount > 0 ? { fill: hexRGB(q.dip.color) || [0, 0, 0], alpha: clamp(q.dip.amount, 0, 1) } : null;
      if (k.type === 'element' && isBackgroundElement(k.element)) {
        if (slots >= 63) return { why: 'too many background graphics' };
        layers.push({ slot: slots++, key: k.id }); overlay = true; blur = true; // (needs the 1.13 core)
        if (fqInk) layers.push(fqInk);
        if (qDip) layers.push(qDip);
        continue;
      }
      // a title or graphic with them: it and those under it go into a slot, the effects over that (after the pictures)
      if (fqInk) { overFx.push({ id: k.id, ink: fqInk, dip: qDip }); overlay = true; }
      // a blurring call-out (1.13): the core blurs round it (overlay.rs), where the editor's drawing says
      if (k.type === 'callout' && (k.callout?.blur || 0) > 0) blur = true;
      if (q.opacity > 0.001 || q.dip) overlay = true;
      continue;
    }
    const local = t - k.start;
    const c = animated(k, local), p = propsAt(c, local);
    // the transitions that paint over the frame after this clip (1.14): drawn by the core as ink (lib/fxshapes.js);
    // the few that read the picture (a text reveal, vertigo, glitch blocks) still the editor's
    const fx = effectShapes(c, p, t, W, H);
    if (fx.why) return { why: fx.why };
    const shut = p.shutter != null && p.shutter < 1;
    if (shut && p.mask && p.mask.k < 1) return { why: 'a radial shutter with a wipe' };
    // a text reveal (1.15): the clip seen through words the editor draws (white, into a slot of their own that the
    // core reads as the cut), over their soft shadow (into a slot under the clip)
    const tm = p.textMask;
    if (tm && shut) return { why: 'a text reveal with a radial shutter' }; // (with a wipe: the editor cuts the words to it)
    if (tm && slots >= 62) return { why: 'too many text reveals' };
    const fxInk = fx.shapes.length ? { ink: { m: [1, 0, 0, 1, 0, 0], clip: null, cut: null, shapes: fx.shapes }, alpha: 1 } : null;
    // a dip to black or white: a colour over everything drawn so far (after this clip, as drawFrame does)
    const dip = p.dip && p.dip.amount > 0 ? { fill: hexRGB(p.dip.color) || [0, 0, 0], alpha: clamp(p.dip.amount, 0, 1) } : null;
    if (p.opacity <= 0.001) { if (dip) layers.push(dip); continue; }
    const m = mediaById(doc, c.media);
    if (!m || m.kind === 'audio') { if (fxInk) layers.push(fxInk); if (dip) layers.push(dip); continue; }
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
      // a LUT file (1.13): its table, read before the export (luts: file → parseCube's), goes to the core with it
      else if (u.lut && !luts?.get(u.lut)) return { why: 'a LUT file that couldn’t be read' };
    }
    // blur, exposure and colour moves (1.6): drawn as the canvas filter; with a rounded or shadowed box the filter
    // softens those too, which isn't done here yet
    const filtered = !!(p.blur || fblur) || (p.bright != null && Math.abs(p.bright - 1) > 0.005) || (p.sat != null && Math.abs(p.sat - 1) > 0.005);
    if (filtered && (p.radius || p.shadow > 0 || p.border > 0 || (c.stab && m.kind === 'video'))) return { why: 'blur and exposure moves on a rounded, bordered or stabilized picture' };
    // a device frame (a phone, laptop, browser or window round the picture, 1.13): the editor draws it, into a slot just
    // under the picture; with a shadow or a blur on the clip too it's still the editor's whole
    const framed = !!(c.frame && c.frame.type && c.frame.type !== 'none');
    if (framed && (p.shadow > 0 || filtered)) return { why: 'device frames on a shadowed or blurred clip' };
    // the keys pressed (1.12): words the editor draws over the frame, from the recording's pointer file
    if (c.keystrokes && c.keystrokes.show) { if (!cursor) return { why: 'keystroke display' }; overlay = true; }
    // pointer effects (1.11): drawn by the core as ink layers, from the recorded pointer (cursor(c, st), as the
    // editor's sources.cursor); not yet on a turned, stabilized, bordered or blurred picture
    const fxOn = !!((c.cursor && c.cursor.show !== false) || m.pointerSeparate);
    if (fxOn) {
      if (!cursor) return { why: 'pointer effects' };
      if ((((m.rotation || 0) % 360) + 360) % 360 || (c.stab && m.kind === 'video') || filtered) return { why: 'pointer effects on a turned, stabilized or blurred picture' };
      if (c.cursor?.magnify && (p.radius > 0 || p.border > 0 || u)) return { why: 'the pointer magnifier on a rounded, bordered or filtered picture' };
    }
    const { w: srcW0, h: srcH0 } = size(m);
    if (!(srcW0 > 0 && srcH0 > 0)) return { why: 'a picture whose size isn’t known' };
    // filtered: graded at the size it's shown (as the editor), and laid out from that picture's size
    let srcW = srcW0, srcH = srcH0, grade = null, gk = 1;
    if (u) {
      const show = Math.min(1, ((W * Math.max(0.05, p.scale)) / Math.max(1, srcW0)) * 1.25);
      const gw = Math.max(1, Math.round(srcW0 * show)), gh = Math.max(1, Math.round(srcH0 * show));
      grade = { ...u, gw, gh };
      if (u.lut) { grade.lutFile = u.lut; grade.lutAmount = clamp(u.lutAmount ?? 1, 0, 1); blur = true; }
      // background removal (1.13): the matte's video, read alongside, cuts the picture out
      if (matteOn) { grade.matte = { file: c.matte.file, feather: clamp(c.matte.feather ?? 0.08, 0, 0.5) }; blur = true; }
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
      if (gk !== 1) { M = mul(M, scale(1 / gk, 1 / gk)); rect = rect.map(v => v * gk); } // (graded: as below)
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
    const st = sourceTime(c, t);
    // a wipe, iris, clock, barn doors, blinds… (1.13): the clip seen through the transition's shape
    // a radial shutter (1.14): the clip seen through the iris's opening, the blades over it (fxInk)
    let mask = shut ? [{ poly: shutterGeom(p.shutter, W, H).v }] : p.mask && p.mask.k < 1 ? maskShapes(p.mask, W, H) : null;
    if (tm) {
      layers.push({ slot: slots++, key: 'reveal-shadow:' + c.id });
      keys[slots] = 'reveal-mask:' + c.id; mask = [{ slot: slots++ }];
      overlay = true; blur = true; needs15 = true;
    }
    const n0 = layers.length;
    if (framed) {
      if (slots >= 63) return { why: 'too many device frames' };
      layers.push({ slot: slots++, key: 'frame:' + c.id }); overlay = true; blur = true;
    }
    // pointer effects on a bordered picture (1.15): the editor draws the border last, over them, so the picture's layer
    // goes without it, the effects (cut to the box) next, then the border on its own
    const cur = fxOn ? cursor(c, st) : null;
    const borderAfter = cur && look && look.border > 0 ? { ...look, shadow: 0, dy: 0, cut: false, onlyBorder: true } : null;
    layers.push({ media: m.id, clip: c.id, st, alpha: clamp(p.opacity, 0, 1), m: M, rect, look: borderAfter ? { ...look, border: 0, cut: true } : look, filter, grade });
    if (cur) {
      layers.push(...pointerInk(c, m, cur, { r, rot: p.rotation || 0, box, radius: look && (look.radius > 0 || look.border > 0) ? look : null, crop: [p.crop[0], p.crop[1], 1 - p.crop[0] - p.crop[2], 1 - p.crop[1] - p.crop[3]], disp: [dispW, dispH], sx, alpha: clamp(p.opacity, 0, 1), st }));
      if (borderAfter) { layers.push({ media: m.id, clip: c.id, st, alpha: clamp(p.opacity, 0, 1), m: M, rect, look: borderAfter, filter: null, grade: null }); needs15 = true; }
    }
    if (mask) for (let i = n0; i < layers.length; i++) layers[i].mask = mask;
    if (fxInk) layers.push(fxInk);
    if (dip) layers.push(dip);
  }
  // needs13: drawn with what the 1.13 core added (a blurring call-out, a transition's shape)
  const needs14 = layers.some(l => l.ink && l.ink.shapes.some(sh => !['grad', 'disc', 'ring', 'poly'].includes(sh.kind)));
  for (const o of overFx) {
    if (slots >= 63) return { why: 'too many titles with transition effects' };
    layers.push({ slot: slots++, key: 'over:' + o.id }, o.ink); blur = true;
    if (o.dip) layers.push(o.dip);
  }
  for (const l of layers) if (l.slot != null) keys[l.slot] = l.key;
  return { bg, layers, overlay, slotKeys: keys, ...(blur || layers.some(l => l.mask) ? { needs13: true } : {}), ...(needs14 ? { needs14: true } : {}), ...(needs15 ? { needs15: true } : {}) };
}

/**
 * A transition's shape (compositor.js maskPath) as outlines and circles in canvas px, for the core (1.13): { poly:
 * [[x, y]…] } or { circle: [x, y, r] }. Inside any of them, the clip shows.
 */
export function maskShapes(m, W, H) {
  const k = clamp(m.k, 0, 1), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
  const rect = (x, y, w, h) => ({ poly: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] });
  switch (m.type) {
    case 'wipe-left': return [rect(W * (1 - e), 0, W * e, H)];
    case 'wipe-right': return [rect(0, 0, W * e, H)];
    case 'wipe-up': return [rect(0, H * (1 - e), W, H * e)];
    case 'wipe-down': return [rect(0, 0, W, H * e)];
    case 'iris': return [{ circle: [W / 2, H / 2, Math.hypot(W, H) / 2 * e] }];
    case 'clock': {
      // the centre, then round the arc (far beyond the frame) from 12 o'clock, clockwise
      const R = Math.hypot(W, H), a0 = -Math.PI / 2, sweep = Math.PI * 2 * e, n = Math.max(2, Math.ceil(sweep / (Math.PI / 90)));
      if (sweep <= 0) return [{ poly: [[W / 2, H / 2], [W / 2, H / 2], [W / 2, H / 2]] }];
      const pts = [[W / 2, H / 2]];
      for (let i = 0; i <= n; i++) { const a = a0 + (sweep * i) / n; pts.push([W / 2 + Math.cos(a) * R, H / 2 + Math.sin(a) * R]); }
      return [{ poly: pts }];
    }
    case 'fast-wipe': { const sl = W * 0.08, x = (W + sl) * k; return [{ poly: [[0, 0], [x, 0], [x - sl, H], [0, H]] }]; }
    case 'barn': return [rect(W / 2 * (1 - e), 0, W * e, H)];
    case 'blinds': { const n = 8, h = H / n; return Array.from({ length: n }, (_, i) => rect(0, i * h, W, h * e)); }
    case 'diagonal': {
      const f = (x, y) => x / W + y / H - 2 * e, cs = [[0, 0], [W, 0], [W, H], [0, H]], out = [];
      for (let i = 0; i < 4; i++) {
        const a = cs[i], b = cs[(i + 1) % 4], fa = f(...a), fb = f(...b);
        if (fa <= 0) out.push(a);
        if ((fa <= 0) !== (fb <= 0)) { const u = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]); }
      }
      return [{ poly: out.length >= 3 ? out : [[0, 0], [0, 0], [0, 0]] }];
    }
    default: return [rect(0, 0, W, H)];
  }
}

const rgba = (hex, a) => { const c = hexRGB(hex) || [0, 0, 0]; return [c[0], c[1], c[2], clamp(a, 0, 1)]; };
// the macOS-style arrow (compositor.js drawPointer), in pointer points: its white body, and the black inside
const ARROW = [[0, 0], [0, 17], [4.2, 13], [7.2, 19.6], [9.8, 18.4], [6.9, 12], [12.3, 12]];
const ARROW_IN = [[1.4, 3.2], [1.4, 13.8], [4.6, 10.8], [7.7, 17.6], [8.6, 17.2], [5.6, 10.6], [9.6, 10.6]];
/**
 * The pointer effects over a clip's picture (compositor.js drawCursorFx), as layers: an ink layer for the spotlight,
 * the magnifier (a round box of the same video, larger), then an ink layer for the highlight, the click and the
 * pointer itself. Their shapes are in the clip's own space (px from the middle of its box, before it's turned).
 */
export function pointerInk(c, m, cur, { r, rot, box, radius, crop, disp, sx, alpha, st }) {
  const fx = c.cursor || {};
  const [cl, ct, cw, ch] = crop;
  const x = -r.w / 2 + ((cur.x - cl) / cw) * r.w, y = -r.h / 2 + ((cur.y - ct) / ch) * r.h;
  let M = translate(r.cx, r.cy);
  if (rot) M = mul(M, rotate(rot));
  const cut = radius ? { b: box, w: r.w, h: r.h, radius: radius.radius } : null;
  const out = [];
  if (fx.spotlight) {
    const rad = (fx.spotSize || 220) * sx;
    out.push({ ink: { m: M, clip: [-r.w / 2, -r.h / 2, r.w / 2, r.h / 2], cut, shapes: [{ kind: 'grad', x, y, r0: rad * 0.75, r1: rad * 1.15, c0: [0, 0, 0, 0], c1: [0, 0, 0, clamp(fx.spotDim ?? 0.6, 0, 1)] }] }, alpha });
  }
  if (fx.magnify) {
    const rad = (fx.lensSize || 130) * sx, z = fx.lensZoom || 2;
    const [dw, dh] = disp, ux = cur.x * dw, uy = cur.y * dh, half = (rad / r.w) * cw * dw / z;
    if (half > 0 && rad > 0) {
      const lm = mul(mul(mul(M, translate(x - rad, y - rad)), scale(rad / half, rad / half)), translate(-(ux - half), -(uy - half)));
      out.push({ media: m.id, clip: c.id, st, alpha, m: lm, rect: [ux - half, uy - half, ux + half, uy + half],
        look: { b: mul(mul(M, translate(x, y)), scale(rad * 2, rad * 2)), w: rad * 2, h: rad * 2, radius: rad, border: 3 * sx, borderColor: [255, 255, 255], shadow: 18 * sx, dy: 0, cut: false }, filter: null, grade: null });
    }
  }
  const shapes = [];
  if (fx.highlight) {
    const rad = (fx.highlightSize || 60) * sx * 0.5;
    shapes.push({ kind: 'grad', x, y, r0: 0, r1: rad, c0: rgba(fx.highlightColor || '#ffd60a', 0.45), c1: rgba(fx.highlightColor || '#ffd60a', 0) });
  }
  const style = fx.clickStyle || (fx.clickRings === false ? 'none' : 'rings');
  if (cur.click != null && c.cursor && style !== 'none') {
    const k = clamp(cur.click / 0.45, 0, 1), col = cur.button === 1 ? (fx.rightClickColor || '#4aa8ff') : (fx.clickColor || fx.highlightColor || '#ffd60a');
    if (style === 'ripple') {
      for (const d of [0, 0.18]) { if (cur.click < d) continue; const kk = clamp((cur.click - d) / 0.45, 0, 1); shapes.push({ kind: 'ring', x, y, r: (8 + 44 * kk) * sx, w: 3 * sx, c: rgba(col, (1 - kk) * 0.9) }); }
    } else if (style === 'dot') shapes.push({ kind: 'disc', x, y, r: (16 + 6 * k) * sx, c: rgba(col, 0.55 * (1 - k)) });
    else shapes.push({ kind: 'ring', x, y, r: (12 + 36 * k) * sx, w: 4 * sx, c: rgba(col, 1 - k) });
  }
  // the pointer itself, for a recording made with it kept separate: ~20 units tall = one macOS pointer in points
  if (m.pointerSeparate && (fx.pointer || 'arrow') !== 'hidden') {
    const s = (fx.scale || 1) * (r.w / (cw * (cur.pt || 1440))) * (cur.click != null && cur.click < 0.15 ? 0.9 : 1);
    if ((fx.pointer || 'arrow') === 'dot') {
      shapes.push({ kind: 'disc', x, y, r: 9 * s, c: [255, 255, 255, 0.95] }, { kind: 'ring', x, y, r: 9 * s, w: 2 * s, c: [0, 0, 0, 0.8] });
    } else {
      const at = list => list.map(([u, v]) => [x + u * s, y + v * s]);
      shapes.push({ kind: 'poly', pts: at(ARROW), fill: [255, 255, 255, 1], stroke: [1.4 * s, [255, 255, 255, 1]], shadow: [4, 1.5, [0, 0, 0, 0.35]] },
        { kind: 'poly', pts: at(ARROW_IN), fill: [0, 0, 0, 1] });
    }
  }
  if (shapes.length) out.push({ ink: { m: M, clip: null, cut, shapes }, alpha });
  return out;
}

/**
 * The Rust core's `frame` job for a plan (its body after "RCORE1\nframe\n"): the canvas size and background, the
 * pictures (each { w, h, rgba }, in the order `ids` gives the plan's media ids), every layer, and where to write the
 * frame. One place for the format (native/reel-core/src/main.rs frame_job reads it).
 */
export function encodeFrame(plan, W, H, ids, pictures, out, overlay = null) {
  const chunks = [];
  let size = 0;
  const push = b => { chunks.push(b); size += b.length; };
  const u32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); push(b); };
  u32(W); u32(H); push(Uint8Array.from(plan.bg));
  u32(pictures.length);
  for (const p of pictures) { u32(p.w); u32(p.h); push(p.rgba instanceof Uint8Array ? p.rgba : new Uint8Array(p.rgba)); }
  encodeLayers(plan.layers, l => ids.indexOf(l.media), push, { luts: plan.luts, matteOf: l => ids.indexOf(l.grade.matte.file) });
  const ob = new TextEncoder().encode(out);
  u32(ob.length); push(ob);
  if (overlay) push(overlay); // the editor's drawing over it (1.12; overlay.rs)
  const all = new Uint8Array(size);
  let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  return all;
}

/**
 * A plan's layers as the frame job writes them (main.rs read_layer; vexport's frames share it): how many, then each.
 * srcOf(layer) is the index of the picture a layer shows; push takes the bytes.
 */
/**
 * opts (1.13): luts (file → parseCube's table) and sent (file → its number, the ones the core has already: a Map kept
 * across the frames of one job, so each table goes once), matteOf(layer) the source its matte is read from.
 */
export function encodeLayers(layers, srcOf, push, { luts = null, sent = new Map(), matteOf = null } = {}) {
  const u8 = v => push(Uint8Array.of(v));
  const u32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); push(b); };
  const f64 = v => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, +v, true); push(b); };
  const rgb01 = h => { const x = hexRGB(h) || [0, 0, 0]; return x.map(v => v / 255); };
  u32(layers.length);
  for (const l of layers) {
    // 1.13: a LUT's table the first time it's used (main.rs read_layer, src 0xfffffffb), then the layer
    const lf = l.grade?.lutFile;
    if (lf && !sent.has(lf)) {
      const t = luts?.get(lf);
      if (!t) throw new Error('a LUT file that couldn’t be read');
      u32(0xfffffffb); f64(1); u32(t.size); push(t.data2d);
      sent.set(lf, sent.size);
    }
    // 1.13: seen through a transition's shape (main.rs read_layer, src 0xfffffffd), then the layer itself
    if (l.mask) {
      u32(0xfffffffd); f64(1); u32(l.mask.length);
      for (const s of l.mask) {
        if (s.circle) { u8(1); s.circle.forEach(f64); }
        else if (s.slot != null) { u8(2); u32(s.slot); } // 1.15: a slot's brightness is the cut
        else { u8(0); u32(s.poly.length); for (const [x, y] of s.poly) { f64(x); f64(y); } }
      }
    }
    if (l.slot != null) { u32(0xfffffffc); f64(1); u32(l.slot); continue; }
    if (l.fill) { u32(0xffffffff); f64(l.alpha); push(Uint8Array.from(l.fill)); continue; }
    if (l.ink) {
      // pointer effects (main.rs read_ink)
      const k = l.ink, col = c => c.forEach(f64), pts = list => { u32(list.length); for (const [px, py] of list) { f64(px); f64(py); } };
      u32(0xfffffffe); f64(l.alpha); k.m.forEach(f64);
      if (k.clip) { u8(1); k.clip.forEach(f64); } else u8(0);
      if (k.cut) { u8(1); k.cut.b.forEach(f64); [k.cut.w, k.cut.h, k.cut.radius].forEach(f64); } else u8(0);
      u32(k.shapes.length);
      for (const s of k.shapes) {
        if (s.kind === 'grad') { u8(0); [s.x, s.y, s.r0, s.r1].forEach(f64); col(s.c0); col(s.c1); }
        else if (s.kind === 'disc') { u8(1); [s.x, s.y, s.r].forEach(f64); col(s.c); }
        else if (s.kind === 'ring') { u8(2); [s.x, s.y, s.r, s.w].forEach(f64); col(s.c); }
        // 1.14 (ink.rs): a blend mode, a gradient with stops, "only outside this", film grain, a soft rim
        else if (s.kind === 'mode') { u8(4); u8(s.m); }
        else if (s.kind === 'stops') { u8(s.lin ? 6 : 5); s.a.forEach(f64); u32(s.stops.length); for (const [st, c] of s.stops) { f64(clamp(st, 0, 1)); col(c); } pts(s.area); }
        else if (s.kind === 'except') { u8(7); if (s.pts) { u8(1); pts(s.pts); } else u8(0); }
        else if (s.kind === 'grain') { u8(8); [s.ox, s.oy, s.a].forEach(f64); }
        else if (s.kind === 'rim') { u8(9); pts(s.pts); f64(s.w); f64(s.sigma); col(s.c); }
        else if (s.kind === 'shift') { u8(10); [s.x, s.y, s.w, s.h, s.dx].forEach(f64); }
        else if (s.kind === 'vertigo') { u8(11); [s.cx, s.cy, s.r, s.s, s.a].forEach(f64); }
        else {
          u8(3); u32(s.pts.length); for (const [px, py] of s.pts) { f64(px); f64(py); } col(s.fill);
          if (s.stroke) { u8(1); f64(s.stroke[0]); col(s.stroke[1]); } else u8(0);
          if (s.shadow) { u8(1); f64(s.shadow[0]); f64(s.shadow[1]); col(s.shadow[2]); } else u8(0);
        }
      }
      continue;
    }
    u32(srcOf(l)); f64(l.alpha); l.m.forEach(f64); l.rect.forEach(f64);
    const k = l.look;
    if (!k) u8(0); else { u8(1); k.b.forEach(f64); [k.w, k.h, k.radius, k.border].forEach(f64); push(Uint8Array.from(k.borderColor)); [k.shadow, k.dy].forEach(f64); u8(k.onlyBorder ? 2 : k.cut ? 1 : 0); } // (2, 1.15: only the border)
    const f = l.filter;
    if (!f) u8(0); else { u8(1); [f.blur, f.bright, f.sat].forEach(f64); }
    const g = l.grade;
    if (!g) u8(0);
    else {
      u8(1); u32(g.gw); u32(g.gh);
      for (const n of ['exposure', 'contrast', 'saturation', 'vibrance', 'temperature', 'tint', 'highlights', 'shadows']) f64(g[n] || 0);
      [g.inBlack ?? 0, g.inWhite ?? 1, g.gammaV ?? 1, g.outBlack ?? 0, g.outWhite ?? 1, g.brightness || 0].forEach(f64);
      for (const n of ['sharpen', 'vignette', 'bw', 'aberr']) f64(g[n] || 0);
      // the key byte: 1 a key; 1.13: + 2 a LUT, + 4 a matte (their numbers after the wheels)
      u8((g.key ? 1 : 0) | (g.lutFile ? 2 : 0) | (g.matte ? 4 : 0));
      if (g.key) [...rgb01(g.key.color), g.key.tol, g.key.soft, g.key.spill].forEach(f64);
      [...(g.mMul || [1, 1, 1]), ...(g.mAdd || [0, 0, 0]), ...(g.lift || [0, 0, 0]), ...(g.gam || [1, 1, 1]), ...(g.gain || [1, 1, 1])].forEach(f64);
      if (g.lutFile) { u32(sent.get(g.lutFile)); f64(g.lutAmount); }
      if (g.matte) { u32(matteOf(l)); f64(g.matte.feather); }
    }
  }
}
