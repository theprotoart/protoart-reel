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
      // a turned phone video (1.14): the Mac's decoder gives its frames as they're stored, as the editor's does, and
      // the plan turns them (checked against the editor's drawing: the same to the pixel)
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
  // second pass at those sizes: the frames, and each clip's run of its video. A long edit is cut into parts (1.15):
  // each part's clips are read by their own decoders (no more than maxSources at once), and a new part starts where
  // the next frame would need more, or where a clip plays backwards or repeats (a decoder reads forwards only). The
  // core runs the parts one after another into the same encoder, so it's still one export.
  let bg = null, ink = false, blur = false, fx14 = false, fx15 = false, fx16 = false;
  const parts = [];
  let part = null;
  const u32to = (pt, v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); pt.chunks.push(b); pt.total += 4; };
  const f64to = (pt, v) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, +v, true); pt.chunks.push(b); pt.total += 8; };
  const newPart = fi => { part = { first: fi, frames: 0, sources: [], srcOf: new Map(), chunks: [], total: 0, overlays: [], sent: new Map() }; parts.push(part); };
  // what frame-sample i needs: new sources, and whether one goes backwards (in the current part)
  const needs = (pt, p) => {
    let add = 0, back = false;
    for (const l of p.layers) {
      if (l.fill || l.ink || l.slot != null) continue;
      for (const key of l.grade?.matte ? [l.clip, l.clip + '#matte'] : [l.clip]) {
        const s0 = pt.srcOf.get(key);
        if (s0 == null) add++; else if (l.st < pt.sources[s0].to - 1e-6) back = true;
      }
    }
    return { add, back };
  };
  const editorFrame = (pt, fi) => { u32to(pt, 0); u32to(pt, 0); pt.chunks.push(Uint8Array.of(1)); pt.total += 1; pt.overlays.push(fi); }; // no layers: the editor's picture is all of it
  for (let f = 0; f < frames; f++) {
    // the plans of this frame's moments (one, or the motion blur's samples)
    const at = [];
    for (let k = 0; k < samples; k++) {
      const fi = f * samples + k;
      if (whole.has(fi)) { at.push({ fi, p: null }); continue; }
      const p = framePlan(doc, plans[fi], W, H, size, cursor, { luts });
      if (p.why) { whole.set(fi, p.why); at.push({ fi, p: null }); continue; }
      at.push({ fi, p });
    }
    // does it fit the part as it is? If not, a new part starts with this frame
    if (!part) newPart(f * samples);
    {
      let add = 0, back = false;
      for (const { p } of at) if (p) { const n = needs(part, p); add += n.add; back ||= n.back; }
      if ((back || part.sources.length + add > maxSources) && part.frames > 0) { newPart(f * samples); if (back) part.byBack = true; }
      // still too many for a part of its own (more clips at once than any decoder count): the editor draws it
      let add2 = 0;
      for (const { p } of at) if (p) add2 += needs(part, p).add;
      if (part.sources.length + add2 > maxSources) for (const x of at) if (x.p) { whole.set(x.fi, 'too many clips at once'); x.p = null; }
    }
    part.frames++;
    for (const { fi, p } of at) {
      if (!p) { editorFrame(part, fi); continue; }
      bg ||= p.bg;
      ink ||= p.layers.some(l => l.ink);
      blur ||= !!p.needs13;
      fx14 ||= !!p.needs14;
      fx15 ||= !!p.needs15;
      fx16 ||= !!p.needs16;
      const uses = new Map();
      const src = (key, file, st, w, h) => {
        let s = part.srcOf.get(key);
        if (s == null) { s = part.sources.length; part.sources.push({ clip: key, file, from: st, to: st, w, h }); part.srcOf.set(key, s); }
        part.sources[s].to = Math.max(part.sources[s].to, st);
        uses.set(s, st);
        return s;
      };
      for (const l of p.layers) {
        if (l.fill || l.ink || l.slot != null) continue;
        const m = mediaById(doc, l.media), z = size(m);
        src(l.clip, m.file, l.st, z.w, z.h);
        // background removal (1.13): its matte video, read alongside at the size the picture's graded at
        if (l.grade?.matte) src(l.clip + '#matte', l.grade.matte.file, l.st, even(l.grade.gw), even(l.grade.gh));
      }
      u32to(part, uses.size);
      for (const [s, st] of uses) { u32to(part, s); f64to(part, st); }
      encodeLayers(p.layers, l => part.srcOf.get(l.clip), b => { part.chunks.push(b); part.total += b.length; }, { luts, sent: part.sent, matteOf: l => part.srcOf.get(l.clip + '#matte') });
      // the editor's drawing over this frame (1.12): titles and the rest, sent on as the export runs
      part.chunks.push(Uint8Array.of(p.overlay ? 1 : 0)); part.total += 1;
      if (p.overlay) part.overlays.push(fi);
    }
  }
  // cut up too finely (a clip played backwards needs a new part every frame): the usual export is quicker
  if (parts.length > Math.max(4, frames / (fps * 2))) return { why: parts.some(pt => pt.byBack) ? 'a clip that plays backwards or repeats' : 'too many clips', at: start };
  // mostly the editor's (a long turned phone video, say): the usual export is as quick, so it goes that way
  if (whole.size && whole.size > plans.length * 0.5) { const [i, why] = whole.entries().next().value; return { why, at: plans[i] }; }
  bg ||= hexBg(doc);
  // each part's job: the canvas, its sources (descriptor 3 + index), how many frames; then its frames written above
  for (const pt of parts) {
    const head = [];
    let hsize = 0;
    const h32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); head.push(b); hsize += 4; };
    h32(W); h32(H); head.push(Uint8Array.from(bg || [0, 0, 0])); hsize += 3;
    h32(pt.sources.length);
    pt.sources.forEach((s, i) => { h32(3 + i); h32(s.w); h32(s.h); });
    h32(pt.overlays.length ? 3 + pt.sources.length : 0);
    // with motion blur: the frame count's top bit set, then the moments per frame (1.13)
    if (samples > 1) { h32((pt.frames | 0x80000000) >>> 0); h32(samples); } else h32(pt.frames);
    const out = new Uint8Array(hsize + pt.total);
    let o = 0;
    for (const c of head) { out.set(c, o); o += c.length; }
    for (const c of pt.chunks) { out.set(c, o); o += c.length; }
    pt.body = out;
    delete pt.chunks; delete pt.srcOf; delete pt.sent;
  }
  const sources = parts[0].sources, out = parts[0].body, overlays = parts.flatMap(pt => pt.overlays);
  // core: the oldest core that can draw it (a blurring call-out or a transition's shape: 1.13)
  const editor = [...whole.keys()].sort((a, b) => a - b);
  return { frames, sources, body: out, parts: parts.map(pt => ({ frames: pt.frames, sources: pt.sources, body: pt.body, overlays: pt.overlays })), ink, overlays, times: plans, from: start, fps, luts, core: fx16 ? 16 : fx15 ? 15 : fx14 ? 14 : blur || samples > 1 ? 13 : 12,
    whole: editor, wholeWhy: editor.length ? [...new Set(whole.values())] : [] };
}
