// A video export for the Rust core to draw (reel-core 1.10 vexport): every frame's plan (lib/frameplan.js), the clips
// whose video it shows (each read by the Mac's decoder, reel-frames --rgba, at the size it needs), and the job those
// make. When any frame needs more than the core draws (titles, pointer effects…), it answers { why } and the export
// is drawn by the editor as before. No DOM here, so it's tested in Node.
import { framePlan, encodeLayers } from './frameplan.js';
import { mediaById, duration as docDuration } from '../model.js';

const even = v => Math.max(2, Math.round(v / 2) * 2);

/**
 * The job for frames from..to at fps on a W × H canvas: { frames, sources: [{ clip, file, from, to, w, h }], body, ink,
 * overlays: the frames (0 = from) the editor draws titles and the rest over, in order }
 * (body: the vexport job after its first line, for reel-core, with each source's descriptor numbered 3, 4…), or
 * { why, at } (the first frame it can't do and why).
 */
export function videoJob(doc, from, to, W, H, fps, { maxSources = 48, cursor = null } = {}) {
  const start = Math.max(0, from || 0), end = Math.min(docDuration(doc), to ?? Infinity);
  const frames = Math.max(1, Math.round((end - start) * fps));
  if (W % 2 || H % 2) return { why: 'an odd frame size', at: start };
  // first pass at each video's own size: what's shown, and how big (so each is decoded no bigger than it's needed)
  const plans = [], big = new Map();
  for (let i = 0; i < frames; i++) {
    const t = start + i / fps;
    const p = framePlan(doc, t, W, H, undefined, cursor);
    if (p.why) return { why: p.why, at: t };
    for (const l of p.layers) {
      if (l.fill || l.ink) continue;
      const m = mediaById(doc, l.media);
      if (!m || (m.kind !== 'video' && m.kind !== 'image')) return { why: 'a clip that’s neither a video nor a picture', at: t };
      if (m.kind === 'image' && /\.(svg|gif)$/i.test(m.file || '')) return { why: 'an SVG or GIF picture', at: t };
      if ((((m.rotation || 0) % 360) + 360) % 360) return { why: 'a turned phone video', at: t };
      const k = Math.hypot(l.m[0], l.m[1]) * (l.grade ? l.grade.gw / Math.max(1, m.width) : 1); // canvas px per video px
      big.set(m.id, Math.max(big.get(m.id) || 0, k));
    }
    plans.push(t);
  }
  // each video decoded at the size it's shown biggest (never bigger than it is), so a 5K screen recording on a 1080p
  // export isn't pushed through at 5K
  const sizes = new Map();
  for (const [id, k] of big) {
    const m = mediaById(doc, id), s = Math.min(1, k * 1.05);
    sizes.set(id, { w: Math.min(m.width, even(m.width * s)), h: Math.min(m.height, even(m.height * s)) });
  }
  const size = m => sizes.get(m.id) || { w: m.width || 0, h: m.height || 0 };
  // second pass at those sizes: the frames, and each clip's run of its video
  const sources = [], srcOf = new Map(), chunks = [];
  let total = 0;
  const push = b => { chunks.push(b); total += b.length; };
  const u32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); push(b); };
  const f64 = v => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, +v, true); push(b); };
  let bg = null, ink = false, blur = false;
  const overlays = [];
  for (const [fi, t] of plans.entries()) {
    const p = framePlan(doc, t, W, H, size, cursor);
    if (p.why) return { why: p.why, at: t };
    bg ||= p.bg;
    ink ||= p.layers.some(l => l.ink);
    blur ||= !!p.needs13;
    const uses = new Map();
    for (const l of p.layers) {
      if (l.fill || l.ink) continue;
      let s = srcOf.get(l.clip);
      if (s == null) {
        const m = mediaById(doc, l.media), z = size(m);
        s = sources.length;
        if (s >= maxSources) return { why: 'too many clips', at: t };
        sources.push({ clip: l.clip, file: m.file, from: l.st, to: l.st, w: z.w, h: z.h });
        srcOf.set(l.clip, s);
      }
      const src = sources[s];
      // each clip's video is read once, start to end: one played backwards or looping goes the editor's way
      if (l.st < src.to - 1e-6) return { why: 'a clip that plays backwards or repeats', at: t };
      src.to = l.st;
      uses.set(s, l.st);
    }
    u32(uses.size);
    for (const [s, st] of uses) { u32(s); f64(st); }
    encodeLayers(p.layers, l => srcOf.get(l.clip), push);
    // the editor's drawing over this frame (1.12): titles and the rest, sent on as the export runs
    push(Uint8Array.of(p.overlay ? 1 : 0));
    if (p.overlay) overlays.push(fi);
  }
  // the head: the canvas, the sources (descriptor 3 + index), how many frames; then the frames written above
  const head = [];
  let hsize = 0;
  const hpush = b => { head.push(b); hsize += b.length; };
  const h32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); hpush(b); };
  h32(W); h32(H); hpush(Uint8Array.from(bg || [0, 0, 0]));
  h32(sources.length);
  sources.forEach((s, i) => { h32(3 + i); h32(s.w); h32(s.h); });
  h32(overlays.length ? 3 + sources.length : 0);
  h32(frames);
  const out = new Uint8Array(hsize + total);
  let o = 0;
  for (const c of head) { out.set(c, o); o += c.length; }
  for (const c of chunks) { out.set(c, o); o += c.length; }
  // core: the oldest core that can draw it (a blurring call-out or a transition's shape: 1.13)
  return { frames, sources, body: out, ink, overlays, from: start, fps, core: blur ? 13 : 12 };
}
