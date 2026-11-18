// A video export for the Rust core to draw (reel-core 1.10 vexport): every frame's plan (lib/frameplan.js), the clips
// whose video it shows (each read by the Mac's decoder, reel-frames --rgba, at the size it needs), and the job those
// make. When any frame needs more than the core draws (titles, pointer effects…), it answers { why } and the export
// is drawn by the editor as before. No DOM here, so it's tested in Node.
import { framePlan, encodeLayers, hexRGB } from './frameplan.js';
const hexBg = doc => hexRGB(doc.canvas.background || '#000') || [0, 0, 0];
import { mediaById, duration as docDuration } from '../model.js';

const even = v => Math.max(2, Math.round(v / 2) * 2);

/**
 * The job for frames from..to at fps on a W × H canvas: { frames, sources: [{ clip, file, from, to, w, h }], body, ink,
 * overlays: the frames (0 = from) the editor draws titles and the rest over, in order }
 * (body: the vexport job after its first line, for reel-core, with each source's descriptor numbered 3, 4…), or
 * { why, at } (the first frame it can't do and why).
 */
export function videoJob(doc, from, to, W, H, fps, { maxSources = 48, cursor = null, samples = 1, luts = null } = {}) {
  samples = Math.max(1, Math.min(8, samples | 0));
  const start = Math.max(0, from || 0), end = Math.min(docDuration(doc), to ?? Infinity);
  const frames = Math.max(1, Math.round((end - start) * fps));
  if (W % 2 || H % 2) return { why: 'an odd frame size', at: start };
  // first pass at each video's own size: what's shown, and how big (so each is decoded no bigger than it's needed)
  const plans = [], big = new Map();
  // motion blur (1.13): each frame the average of `samples` moments across half a frame, as the editor's export
  // (export-worker.js) takes them
  const times = [];
  for (let i = 0; i < frames; i++) for (let s = 0; s < samples; s++) times.push(samples === 1 ? start + i / fps : Math.max(start, start + i / fps + ((s / samples) - 0.5) * 0.5 / fps));
  // a frame the core can't draw yet (a text reveal, a glitch, a turned phone video…) is drawn whole by the editor and
  // handed to the core (1.14): the rest of the export stays the core's. whyOf(i): why frame i is the editor's
  const whole = new Map();
  const layerWhy = p => {
    for (const l of p.layers) {
      if (l.fill || l.ink || l.slot != null) continue;
      const m = mediaById(doc, l.media);
      if (!m || (m.kind !== 'video' && m.kind !== 'image')) return 'a clip that’s neither a video nor a picture';
      if (m.kind === 'image' && /\.(svg|gif)$/i.test(m.file || '')) return 'an SVG or GIF picture';
      if ((((m.rotation || 0) % 360) + 360) % 360) return 'a turned phone video';
    }
    return null;
  };
  for (const [i, t] of times.entries()) {
    const p = framePlan(doc, t, W, H, undefined, cursor, { luts });
    const why = p.why || layerWhy(p);
    plans.push(t);
    if (why) { whole.set(i, why); continue; }
    for (const l of p.layers) {
      if (l.fill || l.ink || l.slot != null) continue;
      const m = mediaById(doc, l.media);
      const k = Math.hypot(l.m[0], l.m[1]) * (l.grade ? l.grade.gw / Math.max(1, m.width) : 1); // canvas px per video px
      big.set(m.id, Math.max(big.get(m.id) || 0, k));
    }
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
  let bg = null, ink = false, blur = false, fx14 = false;
  const overlays = [], sent = new Map();
  const editorFrame = fi => { u32(0); u32(0); push(Uint8Array.of(1)); overlays.push(fi); }; // no layers: the editor's picture is all of it
  for (const [fi, t] of plans.entries()) {
    if (whole.has(fi)) { editorFrame(fi); continue; }
    const p = framePlan(doc, t, W, H, size, cursor, { luts });
    if (p.why) { whole.set(fi, p.why); editorFrame(fi); continue; }
    // a clip played backwards or repeating, or more clips than the core reads at once: this frame's the editor's
    {
      let why = null, add = 0;
      for (const l of p.layers) {
        if (l.fill || l.ink || l.slot != null) continue;
        const s0 = srcOf.get(l.clip);
        if (s0 == null) add++;
        else if (l.st < sources[s0].to - 1e-6) why = 'a clip that plays backwards or repeats';
        if (l.grade?.matte) { const ms = srcOf.get(l.clip + '#matte'); if (ms == null) add++; else if (l.st < sources[ms].to - 1e-6) why = 'a clip that plays backwards or repeats'; }
      }
      if (!why && sources.length + add > maxSources) why = 'too many clips';
      if (why) { whole.set(fi, why); editorFrame(fi); continue; }
    }
    bg ||= p.bg;
    ink ||= p.layers.some(l => l.ink);
    blur ||= !!p.needs13;
    fx14 ||= !!p.needs14;
    const uses = new Map();
    for (const l of p.layers) {
      if (l.fill || l.ink || l.slot != null) continue;
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
      // background removal (1.13): its matte video, read alongside at the size the picture's graded at
      if (l.grade?.matte) {
        const key = l.clip + '#matte';
        let ms = srcOf.get(key);
        if (ms == null) {
          ms = sources.length;
          if (ms >= maxSources) return { why: 'too many clips', at: t };
          sources.push({ clip: key, file: l.grade.matte.file, from: l.st, to: l.st, w: even(l.grade.gw), h: even(l.grade.gh) });
          srcOf.set(key, ms);
        }
        if (l.st < sources[ms].to - 1e-6) return { why: 'a clip that plays backwards or repeats', at: t };
        sources[ms].to = l.st;
        uses.set(ms, l.st);
      }
    }
    u32(uses.size);
    for (const [s, st] of uses) { u32(s); f64(st); }
    encodeLayers(p.layers, l => srcOf.get(l.clip), push, { luts, sent, matteOf: l => srcOf.get(l.clip + '#matte') });
    // the editor's drawing over this frame (1.12): titles and the rest, sent on as the export runs
    push(Uint8Array.of(p.overlay ? 1 : 0));
    if (p.overlay) overlays.push(fi);
  }
  // mostly the editor's (a long turned phone video, say): the usual export is as quick, so it goes that way
  if (whole.size && whole.size > plans.length * 0.5) { const [i, why] = whole.entries().next().value; return { why, at: plans[i] }; }
  bg ||= hexBg(doc);
  // the head: the canvas, the sources (descriptor 3 + index), how many frames; then the frames written above
  const head = [];
  let hsize = 0;
  const hpush = b => { head.push(b); hsize += b.length; };
  const h32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); hpush(b); };
  h32(W); h32(H); hpush(Uint8Array.from(bg || [0, 0, 0]));
  h32(sources.length);
  sources.forEach((s, i) => { h32(3 + i); h32(s.w); h32(s.h); });
  h32(overlays.length ? 3 + sources.length : 0);
  // with motion blur: the frame count's top bit set, then the moments per frame (1.13)
  if (samples > 1) { h32((frames | 0x80000000) >>> 0); h32(samples); } else h32(frames);
  const out = new Uint8Array(hsize + total);
  let o = 0;
  for (const c of head) { out.set(c, o); o += c.length; }
  for (const c of chunks) { out.set(c, o); o += c.length; }
  // core: the oldest core that can draw it (a blurring call-out or a transition's shape: 1.13)
  const editor = [...whole.keys()].sort((a, b) => a - b);
  return { frames, sources, body: out, ink, overlays, times: plans, from: start, fps, luts, core: fx14 ? 14 : blur || samples > 1 ? 13 : 12,
    whole: editor, wholeWhy: editor.length ? [...new Set(whole.values())] : [] };
}
