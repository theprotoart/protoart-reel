// Draws one frame of a project onto a 2D canvas. Used for the live preview (sources are <video>
// and <img> elements) and for export (sources are WebCodecs VideoFrames and ImageBitmaps), so
// what you see is what you export.
import { activeClips, propsAt, sourceTime, mediaById, clamp, TEXT_DEFAULTS, animated, captionAt, CAPTION_STYLE } from './model.js';
import { keysAt } from './cursor.js';
import { filterParams, needsGl } from './lib/glfx.js';
import { stabilizeAt } from './lib/stabilize.js';
import { drawElement, isBackgroundElement } from './lib/elements.js';

/**
 * ctx: CanvasRenderingContext2D or OffscreenCanvasRenderingContext2D sized to the output.
 * sources.frame(clip, sourceTime) -> { img, w, h, rot, scaled? } | null  (scaled: img is that fraction of the original's size)
 * sources.cursor(clip, sourceTime) -> { x, y } (0..1 of the media frame) | null
 */
let framePointer = null; // where the recorded pointer is on the canvas this frame (0..1), if any

export function drawFrame(ctx, doc, t, sources, opts = {}) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  framePointer = null;
  const sx = W / doc.canvas.width; // everything is authored at canvas size; scale for previews
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.fillStyle = doc.canvas.background || '#000';
  ctx.fillRect(0, 0, W, H);
  // pictures first (bottom track to top), then everything drawn on top of them: titles, call-outs, elements, shapes
  // and drawings stay visible even on a track below a full-frame video (they used to vanish under it)
  const overlay = k => k.type !== 'media' && !(k.type === 'element' && isBackgroundElement(k.element));
  const here = activeClips(doc, t);
  for (const k of [...here.filter(k => !overlay(k)), ...here.filter(overlay)]) {
    const local = t - k.start;
    const c = animated(k, local); // keyframed values at this moment
    const p = propsAt(c, local);
    if (p.opacity <= 0.001 && !p.dip) continue;
    const masked = p.mask && p.mask.k < 1;
    if (masked) { ctx.save(); maskPath(ctx, p.mask, W, H); ctx.clip(); }
    try {
      if (c.type === 'media') drawMedia(ctx, doc, c, p, local, sources, W, H, sx);
      else if (c.type === 'text') drawText(ctx, c, p, local, W, H, sx);
      else if (c.type === 'callout') drawCallout(ctx, c, p, W, H, local);
      else if (c.type === 'shape') drawShape(ctx, c, p, local, W, H, sx);
      else if (c.type === 'draw') drawAnnotation(ctx, c, p, local, W, H, sx);
      else if (c.type === 'element') drawElement(ctx, c.element, p, local, c.duration, W, H, sources.image ? id => (id ? sources.image(id) : null) : null);
    } catch (e) { if (opts.onError) opts.onError(c, e); }
    if (masked) ctx.restore();
    if (p.glitch > 0.05) glitchBars(ctx, p.glitch, W, H, t);
    if (p.leak > 0.01) lightLeak(ctx, p.leak, W, H, t, p.burn);
    // cinematic overlays: film grain, a lens flare streak, letterbox bars (from transitions or the clip's filters)
    {
      const fl = (c.filters || []).filter(f => !f.off);
      const grain = Math.max(p.grain || 0, ...fl.filter(f => f.type === 'grain').map(f => f.amount ?? 0.35));
      if (grain > 0.02 && c.type === 'media') filmGrain(ctx, grain, W, H, t);
      if (p.flare && p.flare.amt > 0.02) lensFlare(ctx, p.flare, W, H);
      const lb = fl.find(f => f.type === 'letterbox');
      if ((p.bars || 0) > 0.001 || lb) letterbox(ctx, W, H, lb?.ratio || 2.39, lb ? 1 : 0, p.bars || 0);
    }
    if (p.dip && p.dip.amount > 0) {
      ctx.save(); ctx.globalAlpha = clamp(p.dip.amount, 0, 1); ctx.fillStyle = p.dip.color; ctx.fillRect(0, 0, W, H); ctx.restore();
    }
  }
  // captions: burned into the export when asked; shown in the preview when the caption view is on
  const cs = { ...CAPTION_STYLE, ...(doc.captionStyle || {}) };
  if (cs.burn || opts.showCaptions) { const cap = captionAt(doc, t); if (cap) drawCaption(ctx, cap, cs, W, H, sx); }
  ctx.restore();
}

function drawCaption(ctx, cap, cs, W, H, sx) {
  const size = cs.size * sx;
  ctx.save();
  ctx.font = `${cs.weight || 700} ${size}px "${cs.font}", "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const lines = wrap(ctx, String(cap.text), W * 0.84);
  const lh = size * 1.25, pad = size * 0.45;
  const widths = lines.map(l => ctx.measureText(l).width), bw = Math.max(...widths) + pad * 2, bh = lh * lines.length + pad * 0.8;
  const y = cs.pos === 'top' ? H * 0.06 : H * 0.94 - bh;
  if (cs.bgOpacity > 0) {
    ctx.fillStyle = hexA(cs.bg || '#000000', cs.bgOpacity);
    roundRectPath(ctx, W / 2 - bw / 2, y, bw, bh, size * 0.25);
    ctx.fill();
  } else { ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = size * 0.25; }
  ctx.fillStyle = cs.color || '#fff';
  lines.forEach((l, i) => ctx.fillText(l, W / 2, y + pad * 0.4 + lh * (i + 0.5)));
  ctx.restore();
}

/** Where a media clip lands on the canvas: { cx, cy, w, h, rot } in output pixels. */
export function mediaRect(doc, m, p, W, H, srcW, srcH) {
  const cw = srcW * (1 - p.crop[0] - p.crop[2]), ch = srcH * (1 - p.crop[1] - p.crop[3]);
  const fit = Math.min(W / Math.max(1, cw), H / Math.max(1, ch));
  return { cx: p.x * W, cy: p.y * H, w: cw * fit * p.scale, h: ch * fit * p.scale };
}

/** The shape a mask transition reveals the picture through, at progress k (0 hidden … 1 whole). */
function maskPath(ctx, m, W, H) {
  const k = Math.max(0, Math.min(1, m.k)), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
  ctx.beginPath();
  switch (m.type) {
    case 'wipe-left': ctx.rect(W * (1 - e), 0, W * e, H); break;
    case 'wipe-right': ctx.rect(0, 0, W * e, H); break;
    case 'wipe-up': ctx.rect(0, H * (1 - e), W, H * e); break;
    case 'wipe-down': ctx.rect(0, 0, W, H * e); break;
    case 'iris': ctx.arc(W / 2, H / 2, Math.hypot(W, H) / 2 * e, 0, Math.PI * 2); break;
    case 'clock': ctx.moveTo(W / 2, H / 2); ctx.arc(W / 2, H / 2, Math.hypot(W, H), -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * e); ctx.closePath(); break;
    case 'barn': ctx.rect(W / 2 * (1 - e), 0, W * e, H); break;
    case 'blinds': { const n = 8, h = H / n; for (let i = 0; i < n; i++) ctx.rect(0, i * h, W, h * e); break; }
    case 'diagonal': { // the frame cut by a moving diagonal line: keep where x/W + y/H ≤ 2e
      const f = (x, y) => x / W + y / H - 2 * e, rect = [[0, 0], [W, 0], [W, H], [0, H]], out = [];
      for (let i = 0; i < 4; i++) {
        const a = rect[i], b = rect[(i + 1) % 4], fa = f(...a), fb = f(...b);
        if (fa <= 0) out.push(a);
        if ((fa <= 0) !== (fb <= 0)) { const u = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]); }
      }
      out.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); if (out.length) ctx.closePath();
      break;
    }
    default: ctx.rect(0, 0, W, H);
  }
}
/** Warm light washing over the frame (Light leak, Film burn). */
function lightLeak(ctx, amt, W, H, t, burn) {
  ctx.save();
  ctx.globalCompositeOperation = burn ? 'screen' : 'lighter';
  const blobs = burn ? [['255,120,20', 0.2, 0.6], ['255,40,0', 0.75, 0.3], ['255,220,120', 0.5, 0.5]] : [['255,170,60', 0.15, 0.3], ['255,90,40', 0.85, 0.7], ['255,230,170', 0.55, 0.2]];
  blobs.forEach(([rgb, bx, by], i) => {
    const x = (bx + Math.sin(t * 1.7 + i * 2) * 0.12) * W, y = (by + Math.cos(t * 1.3 + i) * 0.1) * H, r = Math.max(W, H) * (0.45 + 0.35 * amt);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb},${0.95 * amt})`); g.addColorStop(0.5, `rgba(${rgb},${0.35 * amt})`); g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  });
  if (burn && amt > 0.6) { ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = (amt - 0.6) * 2; ctx.fillStyle = '#fff4e0'; ctx.fillRect(0, 0, W, H); }
  ctx.restore();
}
/**
 * A device or window around a picture of w × h (centred on the origin): a browser, a Mac window, a phone or a
 * laptop. Drawn before the picture, so the picture sits in its screen. Our own simple drawings, not product art.
 */
function drawDeviceFrame(ctx, f, w, h, sx) {
  const dark = f.color !== 'light';
  const body = dark ? '#1d1e21' : '#e9e9ec', edge = dark ? '#3a3b40' : '#c4c4ca';
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 40 * sx; ctx.shadowOffsetY = 14 * sx;
  if (f.type === 'browser' || f.type === 'window') {
    const bar = Math.max(18 * sx, h * 0.06), rad = Math.min(14 * sx, bar * 0.5);
    ctx.fillStyle = body; roundRectPath(ctx, -w / 2, -h / 2 - bar, w, h + bar, rad); ctx.fill();
    ctx.shadowColor = 'transparent';
    const dot = bar * 0.22, cy = -h / 2 - bar / 2;
    ['#ff5f57', '#febc2e', '#28c840'].forEach((col, i) => { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(-w / 2 + bar * 0.6 + i * dot * 3, cy, dot, 0, Math.PI * 2); ctx.fill(); });
    if (f.type === 'browser') {
      ctx.fillStyle = dark ? '#2c2d31' : '#ffffff';
      roundRectPath(ctx, -w * 0.28, cy - bar * 0.3, w * 0.56, bar * 0.6, bar * 0.3); ctx.fill();
      if (f.url) { ctx.fillStyle = dark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)'; ctx.font = `${Math.round(bar * 0.34)}px -apple-system, "Helvetica Neue", Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(f.url).slice(0, 80), 0, cy); }
    } else if (f.title) {
      ctx.fillStyle = dark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.65)'; ctx.font = `600 ${Math.round(bar * 0.36)}px -apple-system, "Helvetica Neue", Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(f.title).slice(0, 80), 0, cy);
    }
  } else if (f.type === 'phone') {
    const b = Math.min(w, h) * 0.045, rad = Math.min(w, h) * 0.16;
    ctx.fillStyle = body; roundRectPath(ctx, -w / 2 - b, -h / 2 - b, w + b * 2, h + b * 2, rad + b); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = edge; ctx.lineWidth = 2 * sx; roundRectPath(ctx, -w / 2 - b, -h / 2 - b, w + b * 2, h + b * 2, rad + b); ctx.stroke();
  } else if (f.type === 'laptop') {
    const b = Math.min(w, h) * 0.035, base = h * 0.06;
    ctx.fillStyle = body; roundRectPath(ctx, -w / 2 - b, -h / 2 - b, w + b * 2, h + b * 2.4, b * 1.2); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = dark ? '#8f9096' : '#cfd0d4';
    ctx.beginPath(); ctx.moveTo(-w * 0.62, h / 2 + b * 1.4); ctx.lineTo(w * 0.62, h / 2 + b * 1.4); ctx.lineTo(w * 0.58, h / 2 + b * 1.4 + base); ctx.lineTo(-w * 0.58, h / 2 + b * 1.4 + base); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(-w * 0.08, h / 2 + b * 1.4, w * 0.16, base * 0.25);
  }
  ctx.restore();
}
/** Film grain: a cached noise tile, shifted every frame. */
let grainTile = null;
function filmGrain(ctx, amt, W, H, t) {
  if (!grainTile) {
    grainTile = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(256, 256) : Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
    const g = grainTile.getContext('2d'), img = g.createImageData(256, 256);
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < img.data.length; i += 4) { const v = 128 + (rnd() - 0.5) * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
    g.putImageData(img, 0, 0);
  }
  ctx.save();
  ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = Math.min(0.5, 0.12 + amt * 0.3);
  const ox = Math.floor((Math.sin(t * 91.7) * 0.5 + 0.5) * 256), oy = Math.floor((Math.cos(t * 73.1) * 0.5 + 0.5) * 256);
  const pat = ctx.createPattern(grainTile, 'repeat');
  ctx.translate(-ox, -oy); ctx.fillStyle = pat; ctx.fillRect(ox, oy, W, H);
  ctx.restore();
}
/** A horizontal lens-flare streak sweeping across (the Lens flare sweep transition). */
function lensFlare(ctx, f, W, H) {
  const x = f.k * W * 1.4 - W * 0.2, y = H * 0.42, a = Math.min(1, f.amt * 1.6);
  ctx.save(); ctx.globalCompositeOperation = 'screen';
  const g = ctx.createRadialGradient(x, y, 0, x, y, H * 0.5);
  g.addColorStop(0, `rgba(255,245,225,${0.9 * a})`); g.addColorStop(0.15, `rgba(255,190,120,${0.45 * a})`); g.addColorStop(1, 'rgba(255,140,60,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const s = ctx.createLinearGradient(0, y, W, y);
  s.addColorStop(0, 'rgba(120,180,255,0)'); s.addColorStop(Math.max(0, Math.min(1, x / W)), `rgba(200,225,255,${0.7 * a})`); s.addColorStop(1, 'rgba(120,180,255,0)');
  ctx.fillStyle = s; ctx.fillRect(0, y - H * 0.012, W, H * 0.024);
  ctx.restore();
}
/** Cinematic bars: `on` = the clip's Letterbox filter (bars for `ratio`); `close` 0…1 = bars closing to black (transition). */
function letterbox(ctx, W, H, ratio, on, close) {
  const base = on ? Math.max(0, (H - W / ratio) / 2) : 0;
  const h = base + (H / 2 - base) * Math.min(1, close);
  if (h <= 0.5) return;
  ctx.save(); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, h); ctx.fillRect(0, H - h, W, h); ctx.restore();
}
/** Digital-glitch bars over the frame (the Glitch transition). */
function glitchBars(ctx, amt, W, H, t) {
  ctx.save();
  const n = 3 + Math.floor(amt * 6);
  for (let i = 0; i < n; i++) {
    const r = Math.sin((t * 31.7 + i) * 12.9898) * 43758.5453, f = r - Math.floor(r);
    const y = f * H, h = (0.01 + f * 0.05) * H;
    ctx.globalAlpha = 0.25 + amt * 0.5;
    ctx.fillStyle = i % 3 === 0 ? '#ff2a6d' : i % 3 === 1 ? '#05d9e8' : '#ffffff';
    ctx.globalCompositeOperation = 'screen';
    ctx.fillRect((f - 0.5) * W * 0.1 * amt, y, W, h);
  }
  ctx.restore();
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function drawMedia(ctx, doc, c, p, local, sources, W, H, sx) {
  const m = mediaById(doc, c.media);
  if (!m || m.kind === 'audio') return;
  const st = sourceTime(c, c.start + local);
  let src = sources.frame(c, st);
  if (!src || !src.img) return;
  // filters and background removal run on the GPU, at no more than the size it's shown
  let fblur = 0;
  const matteOn = !!(c.matte && c.matte.file && !c.matte.off);
  // video levels (the clip's own, plus a fix for early ScreenFlow imports whose range came out stretched)
  const legacy = m.convertedFrom === 'screenflow' && m.kind === 'video' && !m.rangeOk;
  const lv = c.levels || legacy ? { ...(legacy ? { outBlack: 16 / 255, outWhite: 235 / 255 } : {}), ...(c.levels || {}) } : null;
  if ((c.filters && c.filters.length) || matteOn || lv || p.split > 0.02) {
    const u = filterParams(c.filters, lv);
    if (p.split > 0.02) u.aberr += p.split * 1.6; // the Chromatic split transition
    fblur = u.blur;
    const gl = needsGl(u, matteOn) && sources.fx ? sources.fx() : null;
    if (gl) {
      const show = Math.min(1, (W * Math.max(0.05, p.scale)) / Math.max(1, src.w) * 1.25);
      const mask = matteOn && sources.matte ? sources.matte(c, st) : null;
      const lut = u.lut && sources.lut ? sources.lut(u.lut) : null;
      try {
        const out = gl.process(src.img, src.w * show, src.h * show, u, mask && mask.img, lut, c.matte?.feather ?? 0.08);
        src = { img: out, w: out.width, h: out.height, rot: src.rot, scaled: show * (src.scaled || 1) };
      } catch { /* draw unfiltered rather than not at all */ }
    }
  }
  let { w: srcW, h: srcH } = src;
  if (src.scaled) { srcW /= src.scaled; srcH /= src.scaled; } // layout uses the full source size
  const rot = ((src.rot || 0) % 360 + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const dispW = swap ? srcH : srcW, dispH = swap ? srcW : srcH;
  const r = mediaRect(doc, m, p, W, H, dispW, dispH);
  if (m.cursor && sources.cursor) {
    const cur = sources.cursor(c, st);
    if (cur) {
      const fx = (cur.x - p.crop[0]) / Math.max(1e-6, 1 - p.crop[0] - p.crop[2]), fy = (cur.y - p.crop[1]) / Math.max(1e-6, 1 - p.crop[1] - p.crop[3]);
      framePointer = { x: (r.cx + (fx - 0.5) * r.w) / W, y: (r.cy + (fy - 0.5) * r.h) / H };
    }
  }
  ctx.save();
  ctx.globalAlpha = clamp(p.opacity, 0, 1);
  {
    // blur, plus the cinematic transitions' exposure and colour (brightness, saturation)
    const f = [];
    if (p.blur || fblur) f.push(`blur(${((p.blur || 0) + fblur) * sx}px)`);
    if (p.bright != null && Math.abs(p.bright - 1) > 0.005) f.push(`brightness(${p.bright.toFixed(3)})`);
    if (p.sat != null && Math.abs(p.sat - 1) > 0.005) f.push(`saturate(${Math.max(0, p.sat).toFixed(3)})`);
    if (f.length) ctx.filter = f.join(' ');
  }
  ctx.translate(r.cx, r.cy);
  if (p.rotation) ctx.rotate((p.rotation * Math.PI) / 180);
  const radius = (p.radius || 0) * sx;
  if (p.shadow > 0) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = p.shadow * sx; ctx.shadowOffsetY = p.shadow * sx * 0.25;
    ctx.fillStyle = '#000';
    roundRectPath(ctx, -r.w / 2, -r.h / 2, r.w, r.h, radius);
    ctx.fill();
    ctx.restore();
  }
  if (c.frame && c.frame.type && c.frame.type !== 'none') drawDeviceFrame(ctx, c.frame, r.w, r.h, sx);
  // stabilization: the picture moves against the camera's shake, zoomed in so its edges stay inside the frame
  const stab = c.stab && m.kind === 'video' ? stabilizeAt(c.stab, st) : null;
  const clipped = radius > 0 || p.border > 0 || !!stab;
  if (clipped) { roundRectPath(ctx, -r.w / 2, -r.h / 2, r.w, r.h, radius); ctx.save(); ctx.clip(); }
  if (stab) { ctx.save(); ctx.scale(stab.zoom, stab.zoom); ctx.translate(stab.x * r.w, stab.y * r.h); ctx.rotate(stab.rot); }
  // crop in display orientation, then map back into the (possibly rotated) source
  const cl = p.crop[0] * dispW, ct = p.crop[1] * dispH, cw = dispW * (1 - p.crop[0] - p.crop[2]), chh = dispH * (1 - p.crop[1] - p.crop[3]);
  if (rot) {
    ctx.save();
    ctx.scale(r.w / cw, r.h / chh);
    ctx.translate(-cl - cw / 2, -ct - chh / 2);
    ctx.translate(dispW / 2, dispH / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(src.img, -srcW / 2, -srcH / 2, srcW, srcH);
    ctx.restore();
  } else {
    const k = src.scaled || 1;
    ctx.drawImage(src.img, cl * k, ct * k, cw * k, chh * k, -r.w / 2, -r.h / 2, r.w, r.h);
  }
  // cinematic filters on the picture itself: halation (a warm glow round the highlights) and colour fringing
  // halation: a warm glow round the highlights (colour fringing is in the GPU filter pass)
  const glow = Math.max(0, ...(c.filters || []).filter(f => !f.off && f.type === 'halation').map(f => f.amount ?? 0.4));
  if (!rot && glow > 0.02) {
    const k = src.scaled || 1;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    // only the bright parts glow: a high-contrast, darkened, blurred copy keeps the shadows untouched
    ctx.filter = `blur(${(10 + glow * 30) * sx}px) contrast(2.2) brightness(${0.45 + glow * 0.25}) sepia(0.5) saturate(1.8)`;
    ctx.globalAlpha = 0.35 + glow * 0.4;
    ctx.drawImage(src.img, cl * k, ct * k, cw * k, chh * k, -r.w / 2, -r.h / 2, r.w, r.h);
    ctx.restore();
  }
  if (sources.cursor && ((c.cursor && c.cursor.show !== false) || m.pointerSeparate)) drawCursorFx(ctx, c, m, sources.cursor(c, st), r, cl / dispW, ct / dispH, cw / dispW, chh / dispH, sx, rot ? null : { img: src.img, k: src.scaled || 1, w: dispW, h: dispH });
  if (stab) ctx.restore();
  if (clipped) ctx.restore();
  if (p.border > 0) {
    ctx.lineWidth = p.border * sx; ctx.strokeStyle = p.borderColor || '#fff';
    roundRectPath(ctx, -r.w / 2, -r.h / 2, r.w, r.h, radius);
    ctx.stroke();
  }
  ctx.restore();
  if (c.keystrokes && c.keystrokes.show && sources.input) drawKeystrokes(ctx, c, m, sources.input(c), st, W, H, sx);
}

/** Keystroke display: the keys pressed, in a rounded bar over the picture (ScreenFlow-style). */
function drawKeystrokes(ctx, c, m, data, st, W, H, sx) {
  const k = c.keystrokes;
  const shown = keysAt(data, m.cursorOffset || 0, st, { hold: k.hold || 1.5, modsOnly: !!k.modsOnly });
  if (!shown) return;
  const fade = 0.25, hold = k.hold || 1.5;
  const a = clamp(Math.min(shown.age / 0.08, (hold - shown.age) / fade, 1), 0, 1);
  const size = (k.size || 46) * sx;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.font = `600 ${size}px ${k.font ? `"${k.font}", ` : ''}"SF Pro Display", "Helvetica Neue", sans-serif`;
  const tw = ctx.measureText(shown.text).width, padX = size * 0.6, bh = size * 1.6, bw = tw + padX * 2;
  const x = W / 2 - bw / 2, y = k.pos === 'top' ? H * 0.06 : H * 0.94 - bh;
  ctx.fillStyle = hexA(k.bg || '#000000', k.bgOpacity ?? 0.72);
  roundRectPath(ctx, x, y, bw, bh, (k.radius ?? 0.3) * bh);
  ctx.fill();
  if (k.outline > 0) { ctx.lineWidth = k.outline * sx; ctx.strokeStyle = k.outlineColor || '#ffffff'; ctx.stroke(); }
  ctx.fillStyle = k.color || '#ffffff';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(shown.text, W / 2, y + bh / 2 + size * 0.04);
  ctx.restore();
}

/** A pointer drawn from the recorded track (for recordings made with the pointer kept separate). */
function drawPointer(ctx, x, y, style, scale, sx, pressed) {
  if (style === 'hidden') return;
  const s = scale * sx * (pressed ? 0.9 : 1);
  ctx.save();
  ctx.translate(x, y);
  if (style === 'dot') {
    ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 2 * s;
    ctx.beginPath(); ctx.arc(0, 0, 9 * s, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  } else {
    // macOS-like arrow: black with a white rim and a soft shadow
    ctx.scale(s, s);
    ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(0, 17); ctx.lineTo(4.2, 13); ctx.lineTo(7.2, 19.6); ctx.lineTo(9.8, 18.4); ctx.lineTo(6.9, 12); ctx.lineTo(12.3, 12); ctx.closePath();
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineJoin = 'round'; ctx.lineWidth = 1.4; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(1.4, 3.2); ctx.lineTo(1.4, 13.8); ctx.lineTo(4.6, 10.8); ctx.lineTo(7.7, 17.6); ctx.lineTo(8.6, 17.2); ctx.lineTo(5.6, 10.6); ctx.lineTo(9.6, 10.6); ctx.closePath();
    ctx.fillStyle = '#000'; ctx.fill();
  }
  ctx.restore();
}

/** Cursor highlight and click rings drawn over a screen recording, from the recorded cursor track. */
function drawCursorFx(ctx, c, m, cur, r, cl, ct, cw, ch, sx, pic = null) {
  if (!cur) return;
  const fx = c.cursor || {};
  const x = -r.w / 2 + ((cur.x - cl) / cw) * r.w, y = -r.h / 2 + ((cur.y - ct) / ch) * r.h;
  // spotlight: everything but a soft circle round the pointer is dimmed
  if (fx.spotlight) {
    const rad = (fx.spotSize || 220) * sx;
    ctx.save();
    const g = ctx.createRadialGradient(x, y, rad * 0.75, x, y, rad * 1.15);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${fx.spotDim ?? 0.6})`);
    ctx.fillStyle = g; ctx.fillRect(-r.w / 2, -r.h / 2, r.w, r.h);
    ctx.restore();
  }
  // magnifier: a round lens following the pointer, showing what's under it larger
  if (fx.magnify && pic) {
    const rad = (fx.lensSize || 130) * sx, z = fx.lensZoom || 2;
    const ux = cur.x * pic.w, uy = cur.y * pic.h, half = (rad / r.w) * cw * pic.w / z;
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.closePath();
    ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 18 * sx; ctx.fillStyle = '#000'; ctx.fill(); ctx.shadowColor = 'transparent';
    ctx.clip();
    ctx.drawImage(pic.img, (ux - half) * pic.k, (uy - half) * pic.k, half * 2 * pic.k, half * 2 * pic.k, x - rad, y - rad, rad * 2, rad * 2);
    ctx.restore();
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 3 * sx; ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  }
  if (fx.highlight) {
    ctx.save();
    const rad = (fx.highlightSize || 60) * sx * 0.5;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, hexA(fx.highlightColor || '#ffd60a', 0.45));
    g.addColorStop(1, hexA(fx.highlightColor || '#ffd60a', 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  const style = fx.clickStyle || (fx.clickRings === false ? 'none' : 'rings');
  if (cur.click != null && c.cursor && style !== 'none') {
    const k = clamp(cur.click / 0.45, 0, 1), col = cur.button === 1 ? (fx.rightClickColor || '#4aa8ff') : (fx.clickColor || fx.highlightColor || '#ffd60a');
    ctx.save();
    if (style === 'ripple') {
      for (const d of [0, 0.18]) { const kk = clamp((cur.click - d) / 0.45, 0, 1); if (cur.click < d) continue; ctx.strokeStyle = hexA(col, (1 - kk) * 0.9); ctx.lineWidth = 3 * sx; ctx.beginPath(); ctx.arc(x, y, (8 + 44 * kk) * sx, 0, Math.PI * 2); ctx.stroke(); }
    } else if (style === 'dot') {
      ctx.fillStyle = hexA(col, 0.55 * (1 - k)); ctx.beginPath(); ctx.arc(x, y, (16 + 6 * k) * sx, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.strokeStyle = hexA(col, 1 - k); ctx.lineWidth = 4 * sx;
      ctx.beginPath(); ctx.arc(x, y, (12 + 36 * k) * sx, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }
  // the arrow path is ~20 units tall = one macOS pointer in points; map points → output pixels
  if (m && m.pointerSeparate) drawPointer(ctx, x, y, fx.pointer || 'arrow', (fx.scale || 1) * (r.w / (cw * (cur.pt || 1440))) / sx, sx, cur.click != null && cur.click < 0.15);
}

export function hexA(hex, a) {
  const h = String(hex || '#000').replace('#', '');
  const full = h.length === 3 ? h.split('').map(x => x + x).join('') : h.padEnd(6, '0');
  const n = parseInt(full.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${clamp(a, 0, 1)})`;
}

// ------------------------------------------------------------------ text

const lineCache = new Map();
function wrap(ctx, text, maxW) {
  const key = ctx.font + '|' + maxW + '|' + text;
  if (lineCache.has(key)) return lineCache.get(key);
  const lines = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const test = line + w;
      if (line && ctx.measureText(test).width > maxW && w.trim()) { lines.push(line.trimEnd()); line = w.trimStart(); }
      else line = test;
    }
    lines.push(line);
  }
  if (lineCache.size > 500) lineCache.clear();
  lineCache.set(key, lines);
  return lines;
}

export function textFont(tx, sx = 1) {
  return `${tx.italic ? 'italic ' : ''}${tx.weight || 700} ${Math.max(1, (tx.size || 72) * sx)}px "${tx.font || 'Avenir Next'}", "Helvetica Neue", Arial, sans-serif`;
}

function drawText(ctx, c, p, local, W, H, sx) {
  const tx = { ...TEXT_DEFAULTS, ...c.text };
  let content = String(tx.content || '');
  let alpha = clamp(p.opacity, 0, 1), dy = 0, scale = p.scale;
  const ad = Math.max(0.05, tx.animDur || 0.4);
  const kin = clamp(local / ad, 0, 1), kout = clamp((c.duration - local) / ad, 0, 1);
  switch (tx.anim) {
    case 'fade': alpha *= Math.min(kin, kout); break;
    case 'slide': alpha *= Math.min(kin, kout); dy = (1 - Math.min(kin, kout)) * 40 * sx; break;
    case 'pop': { const k = Math.min(kin, kout); scale *= k < 1 ? 0.6 + 0.4 * (1 - (1 - k) ** 3) + Math.sin(k * Math.PI) * 0.08 : 1; alpha *= Math.min(1, k * 2); break; }
    case 'typewriter': { const n = Math.floor(clamp(local / Math.max(0.3, Math.min(c.duration * 0.6, content.length * 0.05)), 0, 1) * content.length); content = content.slice(0, n); alpha *= kout; break; }
    default: break;
  }
  if (alpha <= 0.001) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(p.x * W, p.y * H + dy);
  if (p.rotation) ctx.rotate((p.rotation * Math.PI) / 180);
  ctx.scale(scale, scale);
  ctx.font = textFont(tx, sx);
  ctx.textBaseline = 'middle';
  const maxW = Math.max(40, (tx.width || 0.8) * W);
  const lines = wrap(ctx, content, maxW);
  const lh = (tx.size || 72) * sx * (tx.lineHeight || 1.15);
  const widths = lines.map(l => ctx.measureText(l).width);
  const boxW = Math.max(...widths, 1), boxH = lh * lines.length;
  const align = tx.align || 'center';
  const ax = align === 'left' ? -boxW / 2 : align === 'right' ? boxW / 2 : 0;
  ctx.textAlign = align;
  if (tx.bgOpacity > 0) {
    const pad = (tx.padding ?? 24) * sx;
    ctx.save();
    ctx.globalAlpha = alpha * tx.bgOpacity;
    ctx.fillStyle = tx.bg || '#000';
    roundRectPath(ctx, -boxW / 2 - pad, -boxH / 2 - pad * 0.6, boxW + pad * 2, boxH + pad * 1.2, pad * 0.6);
    ctx.fill();
    ctx.restore();
  }
  const paint = (str, x, y) => {
    if (tx.shadow > 0) { ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = tx.shadow * sx; ctx.shadowOffsetY = tx.shadow * sx * 0.25; }
    if (tx.stroke > 0) {
      ctx.lineJoin = 'round'; ctx.lineWidth = tx.stroke * sx * 2; ctx.strokeStyle = tx.strokeColor || '#000';
      ctx.strokeText(str, x, y);
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = tx.color || '#fff';
    ctx.fillText(str, x, y);
    ctx.shadowColor = 'transparent';
  };
  if (CHAR_ANIMS[tx.anim]) {
    drawCharAnim(ctx, tx, lines, widths, boxW, boxH, lh, align, local, c.duration, ad, alpha, sx, paint);
  } else {
    lines.forEach((l, i) => paint(l, ax, -boxH / 2 + lh * (i + 0.5)));
  }
  ctx.restore();
}

// ------------------------------------------------------------------ per-character text animations
// Each letter (or word, for Build) animates on its own, staggered; the same motion plays backwards
// as the text leaves. Random-looking motions are seeded by the letter's position, so preview and
// export match exactly.
const easeOut = k => 1 - (1 - k) ** 3;
const easeBounce = k => { const n = 7.5625, d = 2.75; if (k < 1 / d) return n * k * k; if (k < 2 / d) return n * (k -= 1.5 / d) * k + 0.75; if (k < 2.5 / d) return n * (k -= 2.25 / d) * k + 0.9375; return n * (k -= 2.625 / d) * k + 0.984375; };
const easeElastic = k => (k <= 0 ? 0 : k >= 1 ? 1 : 2 ** (-10 * k) * Math.sin((k * 10 - 0.75) * (2 * Math.PI) / 3) + 1);
const rnd = (i, s) => { const x = Math.sin(i * 127.1 + s * 311.7) * 43758.5453; return x - Math.floor(x); };
const CHAR_ANIMS = {
  build: { words: true }, buildScale: {}, breakApart: {}, flip: {}, gravity: {}, moveIntoPlace: {}, bounce: {}, fadeChars: {},
  wave: {}, blurIn: {}, scramble: {}, tracking: {}, swing: {}, rollUp: { words: true }, stampWords: { words: true },
};
export const TEXT_ANIMS = [['none', 'None'], ['fade', 'Fade'], ['slide', 'Slide up'], ['pop', 'Pop'], ['typewriter', 'Typewriter'],
  ['build', 'Build (word by word)'], ['buildScale', 'Build scale'], ['fadeChars', 'Fade letters'], ['flip', 'Character flip'],
  ['gravity', 'Gravity'], ['moveIntoPlace', 'Move into place'], ['breakApart', 'Break apart'], ['bounce', 'Bounce'],
  ['wave', 'Wave'], ['blurIn', 'Blur in (letters)'], ['scramble', 'Scramble / decode'], ['tracking', 'Tracking in'], ['swing', 'Swing'], ['rollUp', 'Roll up (words)'], ['stampWords', 'Stamp (words)']];

function drawCharAnim(ctx, tx, lines, widths, boxW, boxH, lh, align, local, dur, ad, alpha, sx, paint) {
  const anim = tx.anim, words = CHAR_ANIMS[anim].words;
  // units: letters (or words) with their x position
  const units = [];
  lines.forEach((l, li) => {
    const lw = widths[li], x0 = align === 'left' ? -boxW / 2 : align === 'right' ? boxW / 2 - lw : -lw / 2;
    const y = -boxH / 2 + lh * (li + 0.5);
    const parts = words ? l.split(/(\s+)/) : [...l];
    let pre = '';
    for (const part of parts) {
      if (part && !/^\s+$/.test(part)) units.push({ str: part, x: x0 + ctx.measureText(pre).width, w: ctx.measureText(part).width, y });
      pre += part;
    }
  });
  const n = units.length;
  if (!n) return;
  const size = (tx.size || 72) * sx;
  // whole entrance takes ~animDur + stagger, but never more than 40% of the clip
  const stagger = Math.min(words ? 0.12 : 0.035, (dur * 0.4) / Math.max(1, n));
  ctx.textAlign = 'left';
  units.forEach((u, i) => {
    const kin = clamp((local - i * stagger) / ad, 0, 1), kout = clamp((dur - local - (n - 1 - i) * stagger) / ad, 0, 1);
    const k = Math.min(kin, kout);
    if (k <= 0) return;
    let a = alpha, dx = 0, dy = 0, sc = 1, scY = 1, rot = 0, blur = 0, str = u.str;
    switch (anim) {
      case 'build': a *= k; dy = (1 - easeOut(k)) * size * 0.5; break;
      case 'buildScale': a *= Math.min(1, k * 2); sc = easeOut(k); break;
      case 'fadeChars': a *= k; break;
      case 'flip': scY = Math.max(0.02, Math.sin(easeOut(k) * Math.PI / 2)); a *= Math.min(1, k * 3); break;
      case 'gravity': dy = -(1 - easeBounce(k)) * size * 6; a *= Math.min(1, k * 4); break;
      case 'moveIntoPlace': { const e = easeOut(k); dx = (rnd(i, 1) - 0.5) * size * 8 * (1 - e); dy = (rnd(i, 2) - 0.5) * size * 5 * (1 - e); a *= Math.min(1, k * 2); break; }
      case 'breakApart': { const e = easeOut(k); dx = (rnd(i, 3) - 0.5) * size * 10 * (1 - e); dy = (rnd(i, 4) - 0.2) * size * 7 * (1 - e); rot = (rnd(i, 5) - 0.5) * Math.PI * 2 * (1 - e); a *= k; break; }
      case 'bounce': sc = easeElastic(k); a *= Math.min(1, k * 3); break;
      case 'wave': dy = Math.sin(local * 6 - i * 0.55) * size * 0.12 * (1 - Math.min(1, local / Math.max(0.6, dur * 0.6))) - (1 - easeOut(k)) * size * 0.4; a *= Math.min(1, k * 2); break;
      case 'blurIn': a *= k; blur = (1 - k) * size * 0.25; sc = 1 + (1 - k) * 0.3; break;
      case 'scramble': a *= Math.min(1, k * 3); if (k < 1) { const pool = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*'; str = /\s/.test(u.str) ? u.str : pool[Math.floor(rnd(i, Math.floor(local * 24)) * pool.length)]; } break;
      case 'tracking': dx = (u.x + u.w / 2) * (1 - easeOut(k)) * 0.8; a *= k; break;
      case 'swing': rot = (1 - easeElastic(k)) * 0.9; a *= Math.min(1, k * 3); break;
      case 'rollUp': scY = Math.max(0.02, easeOut(k)); dy = (1 - easeOut(k)) * size * 0.6; a *= k; break;
      case 'stampWords': sc = 1 + (1 - easeOut(k)) * 1.6; a *= Math.min(1, k * 2.5); break;
      default: break;
    }
    if (a <= 0.001) return;
    ctx.save();
    ctx.globalAlpha = a;
    const cx = u.x + u.w / 2;
    ctx.translate(cx + dx, u.y + dy);
    if (rot) ctx.rotate(rot);
    ctx.scale(sc, sc * scY);
    if (blur > 0.3) ctx.filter = `blur(${blur.toFixed(1)}px)`;
    paint(str, -u.w / 2, 0);
    ctx.restore();
  });
}

// ------------------------------------------------------------------ callouts (spotlight / magnify)

/** Freehand outline: points in −0.5…0.5 of the callout box, smoothed through midpoints. */
function freehandPath(ctx, co, W, H) {
  const pts = co.path || [];
  if (pts.length < 3) { ctx.rect((co.x - co.w / 2) * W, (co.y - co.h / 2) * H, co.w * W, co.h * H); return; }
  const P = i => { const q = pts[(i + pts.length) % pts.length]; return [(co.x + q[0] * co.w) * W, (co.y + q[1] * co.h) * H]; };
  const m0 = P(0), m1 = P(1);
  ctx.moveTo((m0[0] + m1[0]) / 2, (m0[1] + m1[1]) / 2);
  for (let i = 1; i <= pts.length; i++) { const a = P(i), b = P(i + 1); ctx.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2); }
  ctx.closePath();
}

function calloutPath(ctx, co, W, H, grow = 0) {
  const x = (co.x - co.w / 2) * W - grow, y = (co.y - co.h / 2) * H - grow, w = co.w * W + grow * 2, h = co.h * H + grow * 2;
  ctx.beginPath();
  if (co.shape === 'freehand') { freehandPath(ctx, co, W, H); return { x, y, w, h }; }
  if (co.shape === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else if (ctx.roundRect) ctx.roundRect(x, y, w, h, (co.radius || 0) * Math.min(W, H));
  else ctx.rect(x, y, w, h);
  return { x, y, w, h };
}

function drawCallout(ctx, c, p, W, H, local = 0) {
  const co = { ...c.callout };
  // follow the recorded pointer of the screen recording underneath
  if (co.follow && framePointer) { co.x = framePointer.x; co.y = framePointer.y; }
  // actions on a callout move its focus area
  co.x = co.x + (p.x - 0.5); co.y = co.y + (p.y - 0.5);
  co.w *= p.scale; co.h *= p.scale;
  // build in / out: the effect grows in and fades away
  const bi = co.buildIn ?? 0.3, bo = co.buildOut ?? 0.3;
  const k = clamp(Math.min(bi > 0 ? local / bi : 1, bo > 0 ? (c.duration - local) / bo : 1, 1), 0, 1);
  const kk = k * k * (3 - 2 * k);
  co.dim = (co.dim || 0) * kk; co.blur = (co.blur || 0) * kk; co.zoom = 1 + ((co.zoom || 1) - 1) * kk;
  const a = clamp(p.opacity, 0, 1) * (co.outline > 0 ? 1 : 1);
  const outlineA = kk;
  const zoom = co.zoom || 1;
  let copy = null;
  if (zoom > 1.001 || co.blur > 0) {
    // snapshot of everything drawn so far
    copy = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
    copy.getContext('2d').drawImage(ctx.canvas, 0, 0);
  }
  ctx.save();
  if (co.blur > 0 && copy) {
    ctx.save();
    ctx.globalAlpha = a;
    ctx.filter = `blur(${co.blur * W / 1920}px)`;
    ctx.drawImage(copy, 0, 0);
    ctx.restore();
    // put the focus area back sharp
    ctx.save(); calloutPath(ctx, co, W, H); ctx.clip(); ctx.drawImage(copy, 0, 0); ctx.restore();
  }
  if (co.dim > 0) {
    ctx.save();
    ctx.globalAlpha = a * co.dim;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    calloutPathInto(ctx, co, W, H);
    ctx.fill('evenodd');
    ctx.restore();
  }
  if (zoom > 1.001 && copy) {
    const cx = co.x * W, cy = co.y * H, w = co.w * W, h = co.h * H;
    ctx.save();
    ctx.globalAlpha = a;
    const zw = w * zoom, zh = h * zoom;
    calloutPath(ctx, { ...co, w: co.w * zoom, h: co.h * zoom, radius: (co.radius || 0) * zoom }, W, H);
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 30 * W / 1920;
    ctx.fillStyle = '#000'; ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.clip();
    ctx.drawImage(copy, cx - w / 2, cy - h / 2, w, h, cx - zw / 2, cy - zh / 2, zw, zh);
    ctx.restore();
  }
  if (co.outline > 0) {
    ctx.save();
    ctx.globalAlpha = a * outlineA;
    ctx.lineWidth = co.outline * W / 1920; ctx.strokeStyle = co.outlineColor || '#ffb02a';
    if (zoom > 1.001) { const s = { ...co, w: co.w * zoom, h: co.h * zoom, radius: (co.radius || 0) * zoom }; calloutPath(ctx, s, W, H); }
    else calloutPath(ctx, co, W, H);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function calloutPathInto(ctx, co, W, H) {
  const x = (co.x - co.w / 2) * W, y = (co.y - co.h / 2) * H, w = co.w * W, h = co.h * H;
  if (co.shape === 'freehand') { freehandPath(ctx, co, W, H); return; }
  if (co.shape === 'ellipse') { ctx.moveTo(x + w, y + h / 2); ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); }
  else if (ctx.roundRect) ctx.roundRect(x, y, w, h, (co.radius || 0) * Math.min(W, H));
  else ctx.rect(x, y, w, h);
}

// ------------------------------------------------------------------ annotations (pen strokes)

/** Strokes reveal one after another over `drawOn` seconds, like they're being drawn. */
function drawAnnotation(ctx, c, p, local, W, H, sx) {
  const d = c.draw || {}, strokes = d.strokes || [];
  if (!strokes.length) return;
  const total = strokes.reduce((n, s) => n + s.pts.length, 0);
  const k = d.drawOn > 0 ? clamp(local / d.drawOn, 0, 1) : 1;
  let budget = Math.ceil(total * k);
  ctx.save();
  ctx.globalAlpha = clamp(p.opacity, 0, 1);
  // position / scale move the drawing around the canvas centre
  ctx.translate(p.x * W, p.y * H); ctx.scale(p.scale, p.scale); ctx.translate(-W / 2, -H / 2);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const s of strokes) {
    if (budget <= 1) break;
    const n = Math.min(s.pts.length, budget);
    budget -= s.pts.length;
    ctx.strokeStyle = s.color || d.color || '#ff3b30';
    ctx.lineWidth = (s.width || d.width || 8) * sx;
    if (d.glow > 0) { ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = d.glow * sx; } else { ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 3 * sx; ctx.shadowOffsetY = 1.5 * sx; }
    ctx.beginPath();
    ctx.moveTo(s.pts[0][0] * W, s.pts[0][1] * H);
    for (let i = 1; i < n - 1; i++) {
      const a = s.pts[i], b = s.pts[i + 1];
      ctx.quadraticCurveTo(a[0] * W, a[1] * H, (a[0] + b[0]) / 2 * W, (a[1] + b[1]) / 2 * H);
    }
    if (n > 1) ctx.lineTo(s.pts[n - 1][0] * W, s.pts[n - 1][1] * H);
    ctx.stroke();
  }
  ctx.restore();
}

// ------------------------------------------------------------------ shapes (arrows, boxes)

function drawShape(ctx, c, p, local, W, H, sx) {
  const s = c.shape;
  const ox = (p.x - 0.5) * W, oy = (p.y - 0.5) * H;
  let x1 = s.x1 * W + ox, y1 = s.y1 * H + oy, x2 = s.x2 * W + ox, y2 = s.y2 * H + oy;
  // arrows draw themselves in over the first 0.3 s
  const k = s.shape === 'arrow' || s.shape === 'line' ? clamp(local / 0.3, 0, 1) : 1;
  x2 = x1 + (x2 - x1) * k; y2 = y1 + (y2 - y1) * k;
  ctx.save();
  ctx.globalAlpha = clamp(p.opacity, 0, 1);
  ctx.strokeStyle = s.color; ctx.fillStyle = s.color;
  ctx.lineWidth = (s.width || 10) * sx; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 8 * sx; ctx.shadowOffsetY = 3 * sx;
  if (s.shape === 'arrow' || s.shape === 'line') {
    const ang = Math.atan2(y2 - y1, x2 - x1), head = Math.max(18, (s.width || 10) * 3) * sx;
    const len = Math.hypot(x2 - x1, y2 - y1);
    ctx.beginPath(); ctx.moveTo(x1, y1);
    ctx.lineTo(s.shape === 'arrow' && len > head ? x2 - Math.cos(ang) * head * 0.6 : x2, s.shape === 'arrow' && len > head ? y2 - Math.sin(ang) * head * 0.6 : y2);
    ctx.stroke();
    if (s.shape === 'arrow' && len > 2) {
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - Math.cos(ang - 0.45) * head, y2 - Math.sin(ang - 0.45) * head);
      ctx.lineTo(x2 - Math.cos(ang + 0.45) * head, y2 - Math.sin(ang + 0.45) * head);
      ctx.closePath(); ctx.fill();
    }
  } else {
    const x = Math.min(x1, x2), y = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    ctx.beginPath();
    if (s.shape === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    else if (ctx.roundRect) ctx.roundRect(x, y, w, h, 12 * sx); else ctx.rect(x, y, w, h);
    if (s.fill) { const fo = s.fillOpacity ?? 0.35; ctx.globalAlpha *= fo; ctx.fill(); ctx.globalAlpha /= fo; }
    ctx.stroke();
  }
  ctx.restore();
}
