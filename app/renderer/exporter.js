// Export dialog: built-in and saved presets, format (MP4 H.264 / HEVC, sound only, animated GIF or
// PNG), size, frame rate, quality, range; an estimate of size and time; a batch list that exports
// several versions in one go to one folder. Runs the export worker and streams the file to disk.
import { renderPending } from './trackplugins.js';
import { can } from './capability.js';
import { pref } from './prefs.js';
import { el, modal, toast, selectRow, promptText, ask } from './ui.js';
import { duration, fmtTime, clipEnd, toSRT, mediaById } from './model.js';
import { framePlan } from './lib/frameplan.js';
import { parseCube } from './lib/glfx.js';
import { masterOf, openMaster, LOUDNESS, mixToFile, addMasterPlugin } from './master-ui.js';
import { LOUDNESS_TARGETS } from './lib/master.js';
import { builtInPresets, GROUPS, QUALITY, SIZE_LIMITS, presetFps, videoBitrate, fromHandBrake } from './lib/exportpresets.js';
import { exportMixJob } from './lib/mixplan.js';
import { videoJob } from './lib/videoplan.js';
import { cursorAt } from './cursor.js';
import { drawFrame } from './compositor.js';
import { FORMATS as VFORMATS, reframeDoc, reframeable } from './lib/reframe.js';

const SOUND = new Set(['aac', 'wav']); // sound-only formats
const FORMATS = [['avc', 'MP4 · H.264 (plays everywhere)'], ['hevc', 'MP4 · HEVC (smaller, newer devices)'], ['aac', 'Sound only · AAC (.m4a)'], ['wav', 'Sound only · WAV (uncompressed, 24-bit)'], ['gif', 'Animated GIF'], ['apng', 'Animated PNG']];
const ANIM = new Set(['gif', 'apng']);
const BUILT_IN = builtInPresets();
const SIZES = [[0, 'Project size'], [2160, '2160p (4K)'], [1440, '1440p'], [1080, '1080p'], [720, '720p'], [576, '576p'], [540, '540p'], [480, '480p'], [360, '360p']];
const WIDTHS = [[0, 'Project width'], [1280, '1280 wide'], [960, '960 wide'], [800, '800 wide'], [640, '640 wide'], [480, '480 wide'], [320, '320 wide']];

const KEY = 'reel.exportPresets';
const loadCustom = () => { try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const saveCustom = list => { try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 120))); } catch { /* fine */ } };
const allPresets = () => [...BUILT_IN, ...loadCustom()];
const even = v => Math.max(2, Math.round(v / 2) * 2);

/** Output size for settings s on this canvas. */
export function sizeFor(s, canvas) {
  const cw = canvas.width, ch = canvas.height;
  if (ANIM.has(s.codec)) { const w = s.width && s.width < cw ? s.width : cw; return { w: even(w), h: even(ch * w / cw) }; }
  if (!s.height) return { w: even(cw), h: even(ch) };
  const k = s.height / Math.min(cw, ch);
  return { w: even(cw * k), h: even(ch * k) };
}

/** Rough size and time, from the bitrate (or measured GIF/APNG averages) and the M1's encoder speed. */
export function estimate(s, canvas, secs) {
  const { w, h } = sizeFor(s, canvas), fps = s.fps || 30;
  let mb;
  if (s.codec === 'aac') mb = (192e3 * secs) / 8 / 1e6;
  if (s.codec === 'wav') mb = (48000 * 6 * secs) / 1e6;
  else if (s.codec === 'gif') mb = (w * h * fps * secs * 0.045) / 1e6; // screen content with frame differencing
  else if (s.codec === 'apng') mb = (w * h * fps * secs * 0.09) / 1e6;
  else mb = s.targetMB > 0 ? Math.min(s.targetMB, ((videoBitrate(s, w, h, fps, secs) + (s.abr || 192) * 1000) * secs) / 8 / 1e6) : ((videoBitrate(s, w, h, fps, secs) + (s.abr || 192) * 1000) * secs) / 8 / 1e6;
  // frames per second the export manages on an 8 GB M1 (hardware encoder; drawing dominates)
  const px = w * h, rate = SOUND.has(s.codec) ? 0 : ANIM.has(s.codec) ? 4e7 / px : Math.min(120, 1.3e8 / px);
  const time = SOUND.has(s.codec) ? secs / 40 : (secs * fps) / Math.max(1, rate) * (s.motionBlur ? 4 : 1);
  return { w, h, mb, time };
}

/**
 * The editor's part of an export the Rust core draws (1.12): what goes over the pictures (titles, call-outs,
 * graphics, shapes, drawings, burned captions) drawn as in the preview, for each frame job.overlays lists, and sent
 * to the core as it goes (overlay.rs): the parts of the drawing that show, each a picture, and where a magnifying
 * call-out's lens goes; the same again as one short note when nothing changed.
 */
export async function sendOverlays(app, doc, job, W, H, cursor, send) {
  const canvas = new OffscreenCanvas(W, H), ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  // the pictures graphics show (an end screen's thumbnails…)
  const images = new Map();
  for (const c of doc.clips.filter(x => x.type === 'element')) {
    for (const [k, v] of Object.entries(c.element || {})) {
      if (!/^img\d$/.test(k) || !v || images.has(v)) continue;
      const m = mediaById(doc, v);
      if (m && m.kind === 'image') { try { images.set(m.id, await createImageBitmap(await (await fetch(`app://reel/m/${app.token}/${encodeURIComponent(m.file)}`)).blob())); } catch { /* drawn without it */ } }
    }
  }
  await document.fonts?.ready;
  const sources = { frame: () => null, image: id => images.get(id) || null, cursor, input: cursor?.input || (() => null), fx: () => null, lut: () => null, matte: () => null };
  let prev = null;
  // frames the core can't draw yet (1.14): the usual export's worker draws them whole, one at a time, in order
  const whole = new Set(job.whole || []);
  let next = null, worker = null;
  if (whole.size) {
    worker = new Worker('export-worker.js', { type: 'module' });
    const queue = [], waiting = [];
    let failed = null;
    worker.onmessage = e => {
      const msg = e.data;
      if (msg.type === 'frame') { const w = waiting.shift(); if (w) w.ok(msg.data); else queue.push(msg.data); }
      else if (msg.type === 'error') { failed = new Error(msg.message); for (const w of waiting.splice(0)) w.no(failed); }
      else if (msg.type === 'warn') toast(msg.message, 5000);
    };
    const times = [...whole].sort((a, b) => a - b).map(fi => (job.times ? job.times[fi] : job.from + fi / job.fps));
    worker.postMessage({ type: 'start', doc, token: app.token, opts: { mode: 'frames', kind: 'mp4', times, width: W, height: H, fps: job.fps, from: Math.min(...times), to: Math.max(...times) + 1 / job.fps } });
    next = () => {
      if (failed) return Promise.reject(failed);
      const p = queue.length ? Promise.resolve(queue.shift()) : new Promise((ok, no) => waiting.push({ ok, no }));
      return p.then(px => { worker.postMessage({ type: 'more' }); return px; });
    };
  }
  // a long edit in parts (1.15): each part's core takes its own frames' drawing, ended before the next part's
  const groups = job.parts ? job.parts.map(pt => pt.overlays).filter(g => g.length) : [job.overlays];
  try {
  for (const [gi, group] of groups.entries()) {
  if (gi > 0) { await send(null); prev = null; } // the next part's core: nothing drawn before it
  for (const fi of group) {
    const t = job.times ? job.times[fi] : job.from + fi / job.fps;
    if (whole.has(fi)) {
      // the whole frame, as one picture over nothing (overlay.rs: a picture step)
      const px = await next();
      const out = new Uint8Array(4 + 1 + 16 + px.length), dv = new DataView(out.buffer);
      dv.setUint32(0, 1, true); out[4] = 0; [0, 0, W, H].forEach((v, i) => dv.setUint32(5 + i * 4, v, true)); out.set(px, 21);
      await send(out); prev = out;
      continue;
    }
    const parts = [];
    let size = 4;
    // what's on the canvas so far, as the smallest picture that holds it, then a clear canvas
    const flush = () => {
      const d = ctx.getImageData(0, 0, W, H).data, u = new Uint32Array(d.buffer);
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let y = 0; y < H; y++) {
        const row = y * W;
        let a = -1, b = -1;
        for (let x = 0; x < W; x++) if (u[row + x] >>> 24) { a = x; break; }
        if (a < 0) continue;
        for (let x = W - 1; x >= a; x--) if (u[row + x] >>> 24) { b = x; break; }
        if (a < x0) x0 = a; if (b > x1) x1 = b; if (y < y0) y0 = y; y1 = y;
      }
      ctx.clearRect(0, 0, W, H);
      if (x1 < 0) return;
      const w = x1 - x0 + 1, h = y1 - y0 + 1, px = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) px.set(d.subarray(((y0 + y) * W + x0) * 4, ((y0 + y) * W + x1 + 1) * 4), y * w * 4);
      parts.push({ x: x0, y: y0, w, h, px }); size += 17 + px.length;
    };
    // background graphics (1.13): each into its slot, numbered as lib/frameplan.js numbers them
    // (and device frames: 'frame:' + the clip's id) — numbered as the frame's plan numbers its slots
    const keys = framePlan(doc, t, W, H, undefined, cursor, { luts: job.luts }).slotKeys || [];
    const slot = id => { flush(); const k = id == null ? -1 : keys.indexOf(id); parts.push({ mark: id == null ? 0xffffffff : k < 0 ? 63 : k }); size += 5; }; // (63: a slot no frame has, so drawing the plan doesn't expect is never shown)
    drawFrame(ctx, doc, t, sources, { overlayOnly: true, slot, lens: L => { flush(); if (L.blurOut) { parts.push({ blur: L }); size += 1 + 16 + 4 + L.pts.length * 16; } else { parts.push({ lens: L }); size += 1 + 40 + 4 + L.pts.length * 16; } } });
    flush();
    // overlay.rs's format
    const out = new Uint8Array(size), dv = new DataView(out.buffer);
    let o = 0;
    const u32 = v => { dv.setUint32(o, v, true); o += 4; }, f64 = v => { dv.setFloat64(o, v, true); o += 8; };
    u32(parts.length);
    for (const p of parts) {
      if (p.mark != null) { out[o++] = 3; u32(p.mark); }
      else if (p.blur) { out[o++] = 2; f64(p.blur.sigma); f64(p.blur.alpha); u32(p.blur.pts.length); for (const [x, y] of p.blur.pts) { f64(x); f64(y); } }
      else if (p.lens) { out[o++] = 1; [p.lens.cx, p.lens.cy, p.lens.zoom, p.lens.blur, p.lens.alpha].forEach(f64); u32(p.lens.pts.length); for (const [x, y] of p.lens.pts) { f64(x); f64(y); } }
      else { out[o++] = 0; [p.x, p.y, p.w, p.h].forEach(u32); out.set(p.px, o); o += p.px.length; }
    }
    // nothing changed since the frame before: just say so
    const same = prev && prev.length === out.length && (() => { const a = new Uint32Array(prev.buffer, 0, prev.length >> 2), b = new Uint32Array(out.buffer, 0, out.length >> 2); for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; for (let i = a.length * 4; i < out.length; i++) if (prev[i] !== out[i]) return false; return true; })();
    await send(same ? Uint8Array.of(255, 255, 255, 255) : out);
    if (!same) prev = out;
  }
  }
  } finally { if (worker) { worker.postMessage({ type: 'cancel' }); setTimeout(() => worker.terminate(), 1000); } }
  await send(null);
}

export function openExport(app) {
  const doc = app.doc;
  if (!doc || !duration(doc)) { toast('Nothing on the timeline yet.'); return; }
  let last = null; try { last = JSON.parse(localStorage.getItem('reel.exportLast') || 'null'); } catch { /* fine */ }
  const st = { codec: 'avc', height: 1080, mbps: 12, fps: doc.canvas.fps || 30, width: 640, dither: true, loop: true, ...(last || {}), presetId: last?.presetId || 'web' };
  st.vauto = last?.vauto ?? true; st.vfit = last?.vfit || 'follow';
  const wide = doc.canvas.width > doc.canvas.height;
  const VFITS = [['follow', 'Follow the action'], ['blur', 'Over a blurred copy'], ['zoom', 'Over a zoomed copy'], ['bars', 'Whole, with black bars']];
  st.range = doc.range && doc.range.out > doc.range.in ? 'inout' : 'all';
  const sel = app.selection.clips.map(id => doc.clips.find(c => c.id === id)).filter(Boolean);
  const ranges = [['all', `Whole timeline (${fmtTime(duration(doc))})`]];
  if (sel.length) ranges.push(['sel', `Selected clips (${fmtTime(Math.min(...sel.map(c => c.start)))} – ${fmtTime(Math.max(...sel.map(clipEnd)))})`]);
  if ((doc.markers || []).length >= 2) ranges.push(['markers', 'Between the first two markers']);
  if (doc.range && doc.range.out > doc.range.in) ranges.unshift(['inout', `In to Out (${fmtTime(doc.range.in)} – ${fmtTime(doc.range.out)})`]);
  const rangeOf = r => {
    let from = 0, to = duration(doc);
    if (r === 'sel' && sel.length) { from = Math.min(...sel.map(c2 => c2.start)); to = Math.max(...sel.map(clipEnd)); }
    if (r === 'inout' && doc.range) { from = doc.range.in; to = doc.range.out; }
    if (r === 'markers') { const ms = doc.markers.slice().sort((a, b) => a.t - b.t); from = ms[0].t; to = ms[1].t; }
    return { from, to };
  };
  const remember = () => { try { localStorage.setItem('reel.exportLast', JSON.stringify({ codec: st.codec, height: st.height, mbps: st.mbps, q: st.q, targetMB: st.targetMB, abr: st.abr, hw: st.hw, fps: st.fps, width: st.width, dither: st.dither, loop: st.loop, presetId: st.presetId, vauto: st.vauto, vfit: st.vfit })); } catch { /* fine */ } };

  // ---------------------------------------------------------------- the form
  const info = el('p', { class: 'note export-est' });
  const settingsBox = el('div');
  const presetRow = el('div');
  const drawPresets = () => {
    const list = allPresets();
    const groupOf = p => p.custom ? (p.group || 'My presets') : p.group || 'Reel';
    const groups = [...GROUPS, 'Imported from HandBrake', 'My presets'].filter(g => list.some(p => groupOf(p) === g));
    const s = el('select', {}, ...groups.map(g => el('optgroup', { label: g === 'Recommended' ? '★ Recommended' : g === 'Reel' ? 'Reel' : g === 'General' || g === 'Web' || g === 'Devices' || g === 'Hardware' || g === 'Production' ? `HandBrake · ${g}` : g },
      ...list.filter(p => groupOf(p) === g).map(p => el('option', { value: p.id, text: p.name + (p.custom && g === 'My presets' ? '  ★' : ''), selected: p.id === st.presetId })))),
      el('option', { value: '', text: 'Custom (as set below)', selected: !list.some(p => p.id === st.presetId) }));
    s.addEventListener('change', () => {
      const p = list.find(x => x.id === s.value); st.presetId = s.value;
      if (p) { const { fpsMax, ...rest } = p; void fpsMax; Object.assign(st, { height: 0, mbps: 0, q: 1, targetMB: 0, abr: 0, hw: undefined, ...rest, fps: presetFps(p, doc.canvas.fps || 30) }); }
      remember(); drawSettings(); drawPresets();
    });
    const cur = list.find(p => p.id === st.presetId);
    const picker = el('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
    picker.addEventListener('change', async () => {
      const f = picker.files?.[0]; picker.value = '';
      if (!f) return;
      try {
        const { presets, notes } = fromHandBrake(await f.text());
        if (!presets.length) { toast('No presets found in that file. In HandBrake: Presets › choose one › Export…', 6000); return; }
        saveCustom([...loadCustom().filter(p => !presets.some(n => n.name === p.name && p.group === n.group)), ...presets]);
        st.presetId = presets[0].id; Object.assign(st, { height: 0, mbps: 0, q: 1, targetMB: 0, abr: 0, hw: undefined, ...presets[0], fps: presetFps(presets[0], doc.canvas.fps || 30) });
        remember(); drawSettings(); drawPresets();
        toast(`Imported ${presets.length} HandBrake preset${presets.length === 1 ? '' : 's'}.${notes.length ? ` Changed to what Reel can make: ${notes.slice(0, 3).join('; ')}${notes.length > 3 ? '…' : ''}.` : ''}`, 8000);
      } catch (e) { toast(`That isn’t a HandBrake preset file (${e.message}).`, 6000); }
    });
    presetRow.replaceChildren(el('div', { class: 'row' }, el('label', { text: 'Preset' }), s,
      el('button', { class: 'tool', text: 'Save as preset…', title: 'Keep these settings as a preset of your own', onclick: async () => {
        const name = await promptText('Save export preset', 'Name this preset:', describeShort(), 'Save');
        if (!name) return;
        const p = { id: 'u' + Date.now().toString(36), name: name.slice(0, 60), custom: true, codec: st.codec, height: st.height, width: st.width, mbps: st.mbps, q: st.q, targetMB: st.targetMB, abr: st.abr, hw: st.hw, fps: st.fps, dither: st.dither, loop: st.loop };
        saveCustom([...loadCustom(), p]); st.presetId = p.id; remember(); drawPresets(); toast('Preset saved.');
      } }),
      el('button', { class: 'tool', text: 'Import HandBrake…', title: 'Bring in presets from HandBrake: in HandBrake’s Presets window, choose a preset (or a folder) › Export…, then pick that .json file here', onclick: () => picker.click() }), picker,
      cur?.custom ? el('button', { class: 'mini', text: '×', title: 'Delete this preset', onclick: () => { saveCustom(loadCustom().filter(p => p.id !== cur.id)); st.presetId = ''; drawPresets(); } }) : null),
      cur?.hint ? el('p', { class: 'note', text: cur.hint }) : null,
      cur?.why ? el('p', { class: 'note', text: `★ ${cur.why}.` }) : null,
      // a vertical preset on a wide project: the export keeps the project's shape, so offer the vertical copy
      cur?.vertical && wide ? (() => {
        // a vertical export of a wide project: made vertical just for the export (the project stays wide), so a wide
        // and a vertical version can go in one batch and be left running
        const box = el('input', { type: 'checkbox', checked: st.vauto });
        const fit = el('select', { title: 'How the wide picture fills the tall frame', disabled: !st.vauto }, ...VFITS.map(([v, t]) => el('option', { value: v, text: t, selected: v === st.vfit })));
        box.addEventListener('change', () => { st.vauto = box.checked; fit.disabled = !box.checked; remember(); describe(); });
        fit.addEventListener('change', () => { st.vfit = fit.value; remember(); });
        return el('div', { class: 'note warn vert-auto' },
          el('label', {}, box, ' Make it vertical (1080 × 1920) for this export: the project stays wide '), fit,
          el('span', { text: ' · or make the project itself vertical: ' }), el('button', { class: 'mini', text: 'Make Vertical…', onclick: () => { app.cmd('make-vertical'); } }));
      })() : null);
  };
  const custom = () => { st.presetId = ''; remember(); drawPresets(); describe(); };
  /** The canvas an export with settings s is drawn on: the project's, or the vertical one it's made into. */
  const canvasOf = s => (s.vertical ? { ...doc.canvas, width: VFORMATS.vertical.w, height: VFORMATS.vertical.h } : doc.canvas);
  const verticalNow = () => { const cur = allPresets().find(p => p.id === st.presetId); return cur?.vertical && wide && st.vauto ? st.vfit : null; };
  const describeShort = () => { const { w, h } = sizeFor({ ...st, vertical: verticalNow() }, canvasOf({ vertical: verticalNow() })); return SOUND.has(st.codec) ? (st.codec === 'wav' ? 'Sound only · WAV' : 'Sound only') : `${FORMATS.find(f => f[0] === st.codec)[1].split(' (')[0]} ${w}×${h} ${st.fps} fps`; };
  const drawSettings = () => {
    const anim = ANIM.has(st.codec), audioOnly = SOUND.has(st.codec);
    settingsBox.replaceChildren(...[
      selectRow('Format', st.codec, FORMATS, v => { st.codec = v; if (ANIM.has(v) && st.fps > 24) st.fps = v === 'gif' ? 12 : 15; custom(); drawSettings(); }),
      audioOnly ? null : anim
        ? selectRow('Width', st.width || 0, WIDTHS, v => { st.width = Number(v); custom(); })
        : selectRow('Size', st.height || 0, SIZES, v => { st.height = Number(v); custom(); }),
      audioOnly ? null : selectRow('Frame rate', st.fps, (anim ? [8, 10, 12, 15, 20, 24, 30] : [15, 24, 25, 30, 50, 60]).map(v => [v, String(v)]), v => { st.fps = Number(v); custom(); }),
      audioOnly || anim ? null : selectRow('Quality', st.mbps ? `m${st.mbps}` : `q${st.q || 1}`, [...QUALITY.map(([q, t]) => [`q${q}`, t]), [`m2`, 'Fixed · 2 Mbps'], ['m4', 'Fixed · 4 Mbps'], ['m8', 'Fixed · 8 Mbps'], ['m12', 'Fixed · 12 Mbps'], ['m20', 'Fixed · 20 Mbps'], ['m40', 'Fixed · 40 Mbps']],
        v => { if (v[0] === 'm') { st.mbps = Number(v.slice(1)); } else { st.mbps = 0; st.q = Number(v.slice(1)); } custom(); }),
      audioOnly || anim ? null : selectRow('File size limit', st.targetMB || 0, SIZE_LIMITS.some(([v]) => v === (st.targetMB || 0)) ? SIZE_LIMITS : [...SIZE_LIMITS, [st.targetMB, `${st.targetMB} MB`]], v => { st.targetMB = Number(v); custom(); }),
      st.codec === 'gif' ? checkbox('Dither', st.dither, v => { st.dither = v; custom(); }, 'smoother gradients, slightly larger') : null,
      anim ? checkbox('Loop', st.loop, v => { st.loop = v; custom(); }, 'play forever') : null,
      anim ? el('p', { class: 'note', text: 'Animated pictures have no sound. Pick a short range: In to Out (I / O) works well. Only the parts that change are stored, so screen recordings stay small.' }) : null].filter(Boolean));
    describe();
  };
  const checkbox = (label, value, on, note) => {
    const c = el('input', { type: 'checkbox', checked: !!value });
    c.addEventListener('change', () => on(c.checked));
    return el('div', { class: 'row' }, el('label', { text: label }), c, note ? el('span', { class: 'note', text: note }) : null);
  };
  const describe = () => {
    const { from, to } = rangeOf(st.range);
    const e = estimate(st, canvasOf({ vertical: verticalNow() }), to - from);
    const mb = e.mb < 1 ? `${Math.max(0.1, e.mb).toFixed(1)} MB` : e.mb < 1000 ? `${Math.round(e.mb)} MB` : `${(e.mb / 1000).toFixed(1)} GB`;
    const tm = e.time < 60 ? `${Math.max(1, Math.round(e.time))} s` : `${Math.round(e.time / 60)} min`;
    info.textContent = st.codec === 'wav' ? `WAV 24-bit stereo, 48 kHz (uncompressed, for editing or mastering elsewhere) · about ${mb} · about ${tm} to export.` : st.codec === 'aac' ? `AAC 192 kbps stereo, 48 kHz · about ${mb} · about ${tm} to export.`
      : ANIM.has(st.codec) ? `${e.w} × ${e.h}, ${st.fps} fps · about ${mb} · about ${tm} to export on an M1.`
      : (() => {
        const vb = videoBitrate(st, e.w, e.h, st.fps, to - from), bpp = vb / (e.w * e.h * st.fps);
        const fit = st.targetMB > 0 ? ` · fits in ${st.targetMB} MB` : '';
        // a size limit on a long export can leave too few bits for the picture: say so, and what helps
        const thin = st.targetMB > 0 && bpp < 0.02 ? ` ⚠ That’s very little for ${e.h}p over ${fmtTime(to - from).replace(/\.\d$/, '')}: pick a smaller size, a shorter range or a bigger limit.` : '';
        return `${e.w} × ${e.h}, ${st.fps} fps, ${st.codec === 'hevc' ? 'HEVC' : 'H.264'} ${(vb / 1e6).toFixed(1)} Mbps + AAC ${st.abr || Math.round((Number(pref('audioBitrate')) || 192000) / 1000)} kbps${st.hw ? ' · Apple hardware encoder' : ''}${fit} · about ${mb} · about ${tm} to export on an M1.${thin}`;
      })();
  };

  const progress = el('div', { class: 'progress hidden' }, el('i'));
  const status = el('p', { class: 'note' });
  const chapterMarks = (doc.markers || []).filter(m => !m.ums);
  const chapters = chapterMarks.length ? el('div', {},
    el('div', { class: 'row' }, el('p', { class: 'note', style: { flex: 1 }, text: 'YouTube chapters from your markers (paste into the description):' }),
      el('button', { class: 'mini', text: '✍ Titles & description…', title: 'Qwen writes title ideas, a description and chapter names from what’s said', onclick: () => app.cmd('writer') })),
    el('textarea', { class: 'big', readOnly: true, value: ['00:00 Intro', ...chapterMarks.slice().sort((a, b) => a.t - b.t).filter(m => m.t > 0).map(m => `${fmtTime(m.t).replace(/\.\d$/, '')} ${m.label || 'Chapter'}`)].join('\n') })) : null;

  // ---------------------------------------------------------------- batch
  const batch = [];
  const batchBox = el('div', { class: 'batch' });
  // one click for the usual pair: the wide version for YouTube and a vertical one for Shorts, Reels and TikTok
  const addPair = () => {
    const { from, to } = rangeOf(st.range), rl = ranges.find(r => r[0] === st.range)[1].replace(/ \(.*/, '');
    for (const id of ['rec-youtube', 'rec-vertical']) {
      const p = allPresets().find(x => x.id === id);
      if (!p) continue;
      const { fpsMax, why, hint, name, group, id: pid, vertical, ...rest } = p; void fpsMax; void why; void hint; void group; void pid;
      const s = { codec: 'avc', height: 0, mbps: 0, q: 1, targetMB: 0, abr: 0, hw: undefined, dither: true, loop: true, ...rest, fps: presetFps(p, doc.canvas.fps || 30), vertical: vertical && wide ? (st.vfit || 'follow') : null };
      const { w, h } = sizeFor(s, canvasOf(s));
      batch.push({ s, from, to, label: `${name.replace(/^★\s*/, '')} · ${w}×${h}`, rangeLabel: rl, suffix: vertical ? 'vertical' : 'wide' });
    }
    drawBatch();
  };
  const drawBatch = () => {
    const pair = el('button', { class: 'mini', text: '＋ Wide + vertical pair', title: 'Add two versions to the batch: ★ YouTube 1080p (wide) and ★ TikTok · Reels · Shorts (vertical, made from the wide project). Then EXPORT BATCH and leave it running', onclick: addPair });
    batchBox.replaceChildren(...(batch.length ? [el('div', { class: 'row' }, el('div', { class: 'engr', style: { flex: 1 }, text: `Batch · ${batch.length}` }), wide ? pair : null),
      ...batch.map((b, i) => el('div', { class: 'row batch-item' + (b.state ? ' ' + b.state : '') },
        el('span', { class: 'bname', text: `${b.label} · ${b.rangeLabel}` }),
        el('span', { class: 'note', text: b.state === 'done' ? 'done' : b.state === 'running' ? 'exporting…' : b.state === 'failed' ? 'failed' : '' }),
        b.state ? null : el('button', { class: 'mini', text: '×', title: 'Remove from the batch', onclick: () => { batch.splice(i, 1); drawBatch(); } })))] : wide ? [el('div', { class: 'row' }, el('span', { class: 'note', style: { flex: 1 }, text: 'Need it for several platforms? Add versions to a batch and leave it running.' }), pair)] : []));
  };

  drawPresets(); drawSettings(); drawBatch();
  const masterBox = el('span', { style: { flex: 1 } }, masterSummary());
  const body = el('div', { class: 'export' },
    presetRow, settingsBox,
    selectRow('Range', st.range, ranges, v => { st.range = v; describe(); }),
    checkbox('Motion blur', st.motionBlur, v => { st.motionBlur = v; describe(); }, 'smoother zooms · ~4× slower'),
    (doc.captions || []).length ? checkbox('Captions file', st.srt = true, v => { st.srt = v; }, 'Save an .srt next to the movie') : null,
    el('div', { class: 'row' }, el('label', { text: 'Master' }), masterBox,
      el('button', { class: 'tool', text: '+ PLUG-IN', title: 'Put one of your own plug-ins (CEDAR, Waves, iZotope, FabFilter…) on the whole mix for this export', onclick: async () => { if (await addMasterPlugin(app)) masterBox.replaceChildren(masterSummary()); } }),
      el('button', { class: 'tool', text: 'MASTER…', onclick: () => openMaster(app) })),
    selectRow('Loudness', masterOf(doc).loudness, LOUDNESS, v => app.commit(d => { masterOf(d).loudness = v; }, { quiet: true })),
    info, batchBox, progress, status, chapters);
  function masterSummary() {
    const m = masterOf(doc);
    const plugs = m.plugins.filter(p => !p.bypass).map(p => p.name);
    return el('span', { class: 'note', text: [m.on ? 'Built-in master on' : 'Built-in master off', ...(plugs.length ? [`plug-ins: ${plugs.join(' → ')}`] : ['no plug-ins'])].join(' · ') });
  }

  let worker = null, handle = null, running = false, stopBatch = false;

  /** Runs one export into an open file handle. Resolves to the saved name, or throws. */
  const project = doc;
  let vctl = null;
  const runOne = (s, from, to, h) => new Promise(async (resolve, reject) => {
    handle = h;
    const started = performance.now();
    progress.classList.remove('hidden'); progress.firstChild.style.width = '0%';
    status.textContent = 'Starting…';
    // a vertical version of a wide project: a vertical copy made for this export (where the action is, found in the
    // part being exported), the project left as it is
    let doc = project;
    if (s.vertical) {
      vctl = new AbortController();
      try {
        const copy = structuredClone(project);
        const { clips, plans } = s.vertical === 'follow'
          ? await app.reframeFocus(copy, { range: { in: from, out: to }, signal: vctl.signal, onStatus: t => { status.textContent = `Vertical version · ${t}`; }, onProgress: v => { progress.firstChild.style.width = (v * 100).toFixed(1) + '%'; } })
          : { clips: copy.clips.filter(c => reframeable(copy, c)), plans: new Map() };
        doc = reframeDoc(copy, VFORMATS.vertical, s.vertical, clips.map(c => c.id), plans);
      } catch (err) {
        app.api.exportCancel(h.id);
        reject(new Error(vctl.signal.aborted || err.message === 'Cancelled' ? 'Export cancelled.' : `Couldn’t make the vertical version: ${err.message}`)); return;
      } finally { vctl = null; }
      progress.firstChild.style.width = '0%';
    }
    const { w, h: hh } = sizeFor(s, doc.canvas);
    // your plug-ins on tracks are rendered now, at the very end (unless they already are)
    try { await renderPending(app, { onStatus: (t, v) => { status.textContent = t; progress.firstChild.style.width = Math.round(v * 100) + '%'; } }); }
    catch (e) { toast(`A plug-in couldn’t render: ${e.message}`, 7000); }
    const m = masterOf(doc);
    const anim = ANIM.has(s.codec);
    const loud = anim ? null : LOUDNESS_TARGETS[m.loudness] ?? null;
    const plugChain = anim ? [] : m.plugins.filter(p => !p.bypass).map(p => ({ kind: 'au', plugin: p.plugin, state: p.state || '' }));
    let masterFile = null; const temps = [];
    const cleanup = () => { for (const t of temps) app.api.fxRemoveTemp(app.token, t); };
    // the recorded clicks of clips that play click sounds, for the core to add them (read from the cursor files)
    const cursors = new Map();
    // an MP4 the Rust core draws, with a loudness target (1.12): the core mixes and masters its sound too
    const vidCore = !SOUND.has(s.codec) && !anim && pref('rustVideo') && !!app.api.coreVideoExport && !!app.api.coreMixToMedia && loud != null && !plugChain.length;
    if ((SOUND.has(s.codec) || vidCore) && app.api.coreMixExport) {
      for (const c of doc.clips.filter(x => x.cursor?.clickSound > 0 && !x.audio?.mute)) {
        const cm = mediaById(doc, c.media);
        if (!cm?.cursor || cursors.has(cm.id)) continue;
        try { cursors.set(cm.id, await (await fetch(`app://reel/m/${app.token}/${encodeURIComponent(cm.cursor)}`)).json()); } catch { /* the JavaScript export then */ }
      }
    }
    // sound only, mastered (the built-in master and/or a loudness target, no master plug-ins): the Rust core does it all
    const rustLoud = SOUND.has(s.codec) && (loud != null || m.on) && !plugChain.length && !!app.api.coreMixExport
      && !!exportMixJob(doc, from, to, { codec: 'wav', loudness: loud, ceiling: m.ceiling, cursors, stretchMax: can('stretchLong').ok ? 1200 : 600, master: m }).job;
    const vidMix = vidCore ? exportMixJob(doc, from, to, { codec: 'wav', loudness: loud, ceiling: m.ceiling, cursors, stretchMax: can('stretchLong').ok ? 1200 : 600, master: m }).job : null;
    if (!anim && !rustLoud && !vidMix && (m.on || plugChain.length || loud != null)) {
      try {
        status.textContent = 'Mixing and mastering the sound…';
        const mix = await mixToFile(app, { from, to, master: m, onProgress: f => { progress.firstChild.style.width = (f * 30).toFixed(1) + '%'; } });
        temps.push(mix); masterFile = mix;
        if (plugChain.length) {
          status.textContent = `Running ${plugChain.length} plug-in${plugChain.length > 1 ? 's' : ''} on the master…`;
          const listener = p => { if (p.tag === 'master') progress.firstChild.style.width = (30 + p.f * 10).toFixed(1) + '%'; };
          app.fxListeners.add(listener);
          try { masterFile = await app.api.fxRenderFile(app.token, mix, plugChain); temps.push(masterFile); } finally { app.fxListeners.delete(listener); }
        }
      } catch (err) { cleanup(); app.api.exportCancel(h.id); reject(new Error(`Mastering failed: ${err.message}`)); return; }
    }
    // sound only, unmastered: the Rust core mixes and writes it (WAV, or AAC by Apple's encoder) when this build
    // has it and the project uses nothing it can't do yet; otherwise the JavaScript export below, as before
    let usual = null; // why the Rust core isn't mixing this one (shown when it's done)
    if (SOUND.has(s.codec) && masterFile) usual = plugChain.length ? 'master plug-ins' : 'what this project uses';
    if (SOUND.has(s.codec) && !masterFile && !app.api.coreMixExport) usual = 'this build has no Rust core';
    if (SOUND.has(s.codec) && !masterFile && app.api.coreMixExport) {
      const plan = exportMixJob(doc, from, to, { codec: s.codec === 'wav' ? 'wav' : 'aac', bitrate: s.abr ? s.abr * 1000 : Number(pref('audioBitrate')) || 192000, loudness: rustLoud ? loud : null, ceiling: m.ceiling, cursors, stretchMax: can('stretchLong').ok ? 1200 : 600, master: rustLoud ? m : null });
      if (!plan.job) usual = plan.why;
      if (plan.job) {
        status.textContent = 'Mixing the sound…';
        const off = app.api.onCoreProgress?.((id, f) => { if (id === h.id) { progress.firstChild.style.width = (f * 100).toFixed(1) + '%'; status.textContent = `Mixing the sound… ${Math.round(f * 100)}%`; } });
        let r = null, failed = null;
        try { r = await app.api.coreMixExport(h.id, app.token, plan.job); } catch (err) { failed = err; } finally { off?.(); }
        if (r) {
          progress.firstChild.style.width = '100%'; cleanup();
          if (rustLoud && Number.isFinite(r.loudness)) toast(`Loudness ${r.loudness.toFixed(1)} LUFS → ${loud} LUFS`, 4000);
          resolve({ name: r.name, secs: (performance.now() - started) / 1000, how: rustLoud ? (m.on ? 'mixed and mastered by the Rust core' : 'mixed and loudness-matched by the Rust core') : 'mixed by the Rust core' }); return;
        }
        if (!r && !failed) usual = 'this build has no Rust core';
        if (failed) usual = 'the Rust core failed';
        if (failed) {
          if (/Cancelled/.test(failed.message)) { cleanup(); reject(new Error('Export cancelled.')); return; }
          toast(`The fast sound mixer couldn’t do this one (${failed.message}); mixing it the usual way.`, 5000);
        }
      }
    }
    // the core was to do the loudness target but didn't: master it the JavaScript way, so the target is never lost
    if (rustLoud && !masterFile) {
      try {
        status.textContent = 'Mixing and mastering the sound…';
        masterFile = await mixToFile(app, { from, to, master: m, onProgress: f => { progress.firstChild.style.width = (f * 30).toFixed(1) + '%'; } });
        temps.push(masterFile);
      } catch (err) { cleanup(); app.api.exportCancel(h.id); reject(new Error(`Mastering failed: ${err.message}`)); return; }
    }
    // an MP4 the Rust core can draw (Settings › Processing, on by default since 1.15): the Mac's decoder, the core and the
    // Mac's encoder make it, with the sound mixed here first; anything it can't do exports the usual way below
    const fps0 = s.fps || 30;
    if (!SOUND.has(s.codec) && !anim && pref('rustVideo') && app.api.coreVideoExport && (loud == null || vidMix)) {
      // the recorded pointer of clips with pointer effects (the core draws those too), read as the editor's export does
      const tracks = new Map();
      for (const c of doc.clips.filter(x => x.type === 'media' && x.start < to && x.start + x.duration > from && ((x.cursor ? x.cursor.show !== false : mediaById(doc, x.media)?.pointerSeparate) || x.keystrokes?.show))) {
        const cm = mediaById(doc, c.media);
        if (!cm?.cursor || tracks.has(cm.id)) continue;
        try { tracks.set(cm.id, await (await fetch(`app://reel/m/${app.token}/${encodeURIComponent(cm.cursor)}`)).json()); } catch { /* none: no effects drawn, as the editor */ }
      }
      const cursor = (c, st) => { const cm = mediaById(doc, c.media), data = cm && tracks.get(cm.id); return data ? cursorAt(data, cm.cursorOffset || 0, st, c.cursor?.smooth || 0) : null; };
      cursor.input = c => { const cm = mediaById(doc, c.media); return (cm && tracks.get(cm.id)) || null; };
      // LUT files the clips use (1.13): read now, their tables go to the core with the job
      const luts = new Map();
      for (const f of new Set(doc.clips.flatMap(c => (c.filters || []).filter(x => x.type === 'lut' && x.file && !x.off).map(x => x.file)))) {
        try { luts.set(f, parseCube(await (await fetch(`app://reel/m/${app.token}/${encodeURIComponent(f)}`)).text())); } catch { /* that clip goes the usual way */ }
      }
      // SVG and GIF pictures (1.14): as PNGs of what the editor draws (its first frame, its own size), for the core
      let coreDoc = doc;
      const stills = doc.media.filter(m => m.kind === 'image' && /\.(svg|gif)$/i.test(m.file || '') && doc.clips.some(c => c.media === m.id && c.start < to && c.start + c.duration > from));
      if (stills.length && app.api.stillPng) {
        coreDoc = structuredClone(doc);
        for (const m of stills) {
          try {
            const bmp = await createImageBitmap(await (await fetch(`app://reel/m/${app.token}/${encodeURIComponent(m.file)}`)).blob());
            const cv = new OffscreenCanvas(bmp.width, bmp.height); cv.getContext('2d').drawImage(bmp, 0, 0);
            const png = new Uint8Array(await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer());
            const file = await app.api.stillPng(app.token, m.file, png);
            const cm = coreDoc.media.find(x => x.id === m.id);
            Object.assign(cm, { file, width: bmp.width, height: bmp.height });
            temps.push(file);
          } catch { /* that one's frames stay the editor's */ }
        }
      }
      const job = videoJob(coreDoc, from, to, w, hh, fps0, { cursor, samples: st.motionBlur ? 4 : 1, luts });
      if (job.why) usual = `drawn the usual way: ${job.why}`;
      else {
        let sound = masterFile;
        try {
          if (!sound && vidMix) {
            // mixed, mastered and brought to the loudness target by the core, into a WAV beside the media
            status.textContent = 'Mixing and mastering the sound (Rust core)…';
            sound = await app.api.coreMixToMedia(app.token, vidMix);
            if (!sound) throw new Error('this build’s core can’t master the sound');
            temps.push(sound);
          }
          if (!sound) {
            status.textContent = 'Mixing the sound…';
            sound = await mixToFile(app, { from, to, master: null, onProgress: f => { progress.firstChild.style.width = (f * 15).toFixed(1) + '%'; } });
            temps.push(sound);
          }
          status.textContent = 'Drawing the frames (Rust core)…';
          const t0 = performance.now();
          const off = app.api.onCoreProgress?.((id, f) => {
            if (id !== h.id) return;
            const k = 0.15 + f * 0.85, left = ((performance.now() - t0) / 1000) * (1 - f) / Math.max(f, 0.001);
            progress.firstChild.style.width = (k * 100).toFixed(1) + '%';
            status.textContent = `Frame ${Math.round(f * job.frames)} of ${job.frames} · Rust core · about ${fmtTime(left).replace(/\.\d$/, '')} left`;
          });
          let r = null;
          try {
            const running = app.api.coreVideoExport(h.id, app.token, { w, h: hh, fps: fps0, codec: s.codec === 'hevc' ? 'hevc' : 'h264', vbr: Math.round(videoBitrate(s, w, hh, fps0, to - from)),
              abr: s.abr ? s.abr * 1000 : Number(pref('audioBitrate')) || 192000, sound, sources: job.sources.map(x => ({ file: x.file, from: x.from, to: x.to, w: x.w, h: x.h })), body: job.body, ink: job.ink, overlay: job.overlays.length > 0, core: job.core,
              // a long edit in parts (1.15)
              ...(job.parts.length > 1 ? { parts: job.parts.map(pt => ({ frames: pt.frames, body: pt.body, overlay: pt.overlays.length > 0, sources: pt.sources.map(x => ({ file: x.file, from: x.from, to: x.to, w: x.w, h: x.h })) })) } : {}) });
            // titles, call-outs, graphics…: drawn here as the core goes, and handed to it frame by frame
            const drawing = job.overlays.length ? sendOverlays(app, doc, job, w, hh, cursor, data => app.api.coreOverlay(h.id, data)).catch(e => e) : null;
            r = await running;
            const derr = drawing && await drawing;
            if (derr instanceof Error && !r) throw derr;
          } finally { off?.(); }
          if (r) {
            progress.firstChild.style.width = '100%'; cleanup();
            const nw = job.whole?.length || 0;
            resolve({ name: r.name, secs: (performance.now() - started) / 1000, how: nw ? `drawn by the Rust core (${nw} frame${nw === 1 ? '' : 's'} with ${job.wholeWhy.join(', ')} drawn by the editor)` : 'drawn by the Rust core' }); return;
          }
          usual = 'drawn the usual way: this build hasn’t the Rust export helpers';
        } catch (err) {
          if (/Cancelled/.test(err.message)) { cleanup(); reject(new Error('Export cancelled.')); return; }
          toast(`The Rust core couldn’t draw this one (${err.message}); exporting it the usual way.`, 6000);
          usual = 'drawn the usual way: the Rust core failed';
        }
      }
    }
    // the core was to master the sound with the picture but the picture went the usual way: the built-in master the
    // JavaScript way (the export below brings it to the loudness target)
    if (vidMix && !masterFile && m.on) {
      try {
        status.textContent = 'Mixing and mastering the sound…';
        masterFile = await mixToFile(app, { from, to, master: m, onProgress: f => { progress.firstChild.style.width = (f * 30).toFixed(1) + '%'; } });
        temps.push(masterFile);
      } catch (err) { cleanup(); app.api.exportCancel(h.id); reject(new Error(`Mastering failed: ${err.message}`)); return; }
    }
    worker = new Worker('export-worker.js', { type: 'module' });
    worker.onmessage = async e => {
      const msg = e.data;
      if (msg.type === 'chunk') app.api.exportChunk(h.id, msg.data);
      else if (msg.type === 'progress') {
        const k = msg.done / msg.total;
        progress.firstChild.style.width = (k * 100).toFixed(1) + '%';
        const left = ((performance.now() - started) / 1000) * (1 - k) / Math.max(k, 0.001);
        status.textContent = msg.sound
          ? `Sound ${fmtTime(msg.secs).replace(/\.\d$/, '')} of ${fmtTime(msg.totalSecs).replace(/\.\d$/, '')} · ${msg.fps.toFixed(0)}× real time · about ${fmtTime(left).replace(/\.\d$/, '')} left`
          : `Frame ${msg.done} of ${msg.total} · ${msg.fps.toFixed(0)} fps · about ${fmtTime(left).replace(/\.\d$/, '')} left`;
      } else if (msg.type === 'warn') toast(msg.message, 5000);
      else if (msg.type === 'status') status.textContent = msg.message;
      else if (msg.type === 'loudness') toast(`Loudness ${msg.measured.toFixed(1)} LUFS → ${msg.target} LUFS`, 4000);
      else if (msg.type === 'done') {
        status.textContent = 'Writing the file…';
        worker.terminate(); worker = null;
        try {
          const r = await app.api.exportFinish(h.id, msg.head);
          progress.firstChild.style.width = '100%';
          if (st.srt && (doc.captions || []).length && !anim && !SOUND.has(s.codec)) {
            const caps = doc.captions.filter(c => c.end > from && c.t < to).map(c => ({ ...c, t: Math.max(0, c.t - from), end: Math.min(to, c.end) - from }));
            if (caps.length) await app.api.captionsBeside(r.name, toSRT(caps)).catch(() => {});
          }
          cleanup();
          resolve({ name: r.name, secs: (performance.now() - started) / 1000, how: usual ? (usual.startsWith('drawn') ? usual : `mixed the usual way: ${usual}`) : '' });
        } catch (err) { cleanup(); reject(new Error(`Couldn’t save: ${err.message}`)); }
      } else if (msg.type === 'error') {
        cleanup();
        app.api.exportCancel(h.id);
        worker.terminate(); worker = null;
        reject(new Error(msg.message === 'Cancelled' ? 'Export cancelled.' : `Export failed: ${msg.message}`));
      }
    };
    const fps = s.fps || 30;
    worker.postMessage({ type: 'start', doc: JSON.parse(JSON.stringify(doc)), token: app.token, opts: { stretchMax: can('stretchLong').ok ? 1200 : 600,
      width: w, height: hh, fps, codec: s.codec, motionBlur: st.motionBlur && !SOUND.has(s.codec) ? 4 : 0, kind: s.codec === 'aac' ? 'm4a' : s.codec === 'wav' ? 'wav' : anim ? s.codec : 'mp4', from, to,
      bitrate: videoBitrate(s, w, hh, fps, to - from), audioBitrate: s.abr ? s.abr * 1000 : Number(pref('audioBitrate')) || 192000, hardware: s.hw ? true : pref('encoder') !== 'software',
      masterFile, loudness: loud, ceiling: m.ceiling, dither: s.dither !== false, loop: s.loop !== false,
    } });
  });
  const kindOf = s => (s.codec === 'aac' ? 'm4a' : s.codec === 'wav' ? 'wav' : ANIM.has(s.codec) ? s.codec : 'mp4');
  const snapshot = () => ({ vertical: verticalNow(), codec: st.codec, height: st.height, width: st.width, mbps: st.mbps, q: st.q, targetMB: st.targetMB, abr: st.abr, hw: st.hw, fps: st.fps, dither: st.dither, loop: st.loop });

  const exportBtn = { label: 'Export…', cls: 'hw amber', onClick: async (c, btn) => {
    if (running) return;
    const s = snapshot(), { from, to } = rangeOf(st.range);
    const h = await app.api.exportBegin(app.token, doc.name, kindOf(s));
    if (!h) return;
    // the drive it's saved to has room for it? (a full one used to fail at the very end, after the whole export)
    const need = estimate(s, canvasOf(s), to - from).mb * 1e6 * 1.1 + 300e6;
    if (h.free != null && Number.isFinite(h.free) && h.free < need) {
      const gb = b => (b / 1e9).toFixed(1);
      const go = await ask('Not much space on that drive', `This export needs about ${gb(need)} GB, and the drive you’re saving to has ${gb(h.free)} GB free. Free some space (or export to another drive) first, or it may stop before it’s done.`, 'Export anyway', 'Cancel');
      if (!go) { app.api.exportCancel(h.id); return; }
    }
    running = true; btn.disabled = true;
    app.api.keepAwake?.(true);
    try { const r = await runOne(s, from, to, h); status.replaceChildren(`Saved “${r.name}” in ${fmtTime(r.secs)}${r.how ? ` (${r.how})` : ''}. `, el('button', { class: 'mini', text: 'Show in Finder', onclick: () => app.api.exportReveal(r.name) })); }
    catch (err) { status.textContent = err.message; }
    app.api.keepAwake?.(false);
    running = false; btn.disabled = false; void c;
  } };
  const addBtn = { label: 'Add to batch', cls: 'hw', onClick: () => {
    const s = snapshot(), { from, to } = rangeOf(st.range);
    batch.push({ s, from, to, label: describeShort(), rangeLabel: ranges.find(r => r[0] === st.range)[1].replace(/ \(.*/, ''), suffix: st.presetId ? (allPresets().find(p => p.id === st.presetId)?.name || '') : describeShort() });
    drawBatch();
  } };
  const batchBtn = { label: 'Export batch…', cls: 'hw', onClick: async (c, btn) => {
    if (running) return;
    if (!batch.length) { toast('Add a few versions with “Add to batch” first: say a 1080p MP4, a 720p MP4 and a GIF of the intro.'); return; }
    const folder = await app.api.exportPickFolder();
    if (!folder) return;
    running = true; stopBatch = false; btn.disabled = true;
    app.api.keepAwake?.(true); // left running: the Mac stays awake until the batch is done
    let ok = 0;
    for (const b of batch) {
      if (stopBatch) break;
      if (b.state === 'done') continue;
      b.state = 'running'; drawBatch();
      try {
        const h = await app.api.exportBeginIn(app.token, folder.id, `${doc.name} - ${b.suffix}`.replace(/[·]/g, '-').replace(/★\s*/g, '').replace(/\s+/g, ' ').trim(), kindOf(b.s));
        await runOne(b.s, b.from, b.to, h);
        b.state = 'done'; ok++;
      } catch (err) { b.state = 'failed'; toast(err.message, 5000); }
      drawBatch();
    }
    app.api.keepAwake?.(false);
    status.textContent = `Batch finished: ${ok} of ${batch.length} saved in “${folder.name}”.`;
    // you may be away: a notice from the Mac when it's done
    try { new Notification('ProtoArt Reel', { body: `${ok} of ${batch.length} export${batch.length === 1 ? '' : 's'} saved in “${folder.name}”.`, silent: false }); } catch { /* no notices */ }
    running = false; btn.disabled = false; void c;
  } };

  const dlg = modal('Export', body, [
    { label: 'Close', onClick: c => { if (running) cancel(); c(); } },
    addBtn, batchBtn, exportBtn,
  ], { onClose: () => { if (running) cancel(); } });
  const cancel = () => {
    stopBatch = true;
    vctl?.abort();
    if (worker) { worker.postMessage({ type: 'cancel' }); setTimeout(() => { if (worker) { worker.terminate(); worker = null; } }, 1500); }
    if (handle) app.api.exportCancel(handle.id);
    running = false;
  };
  void dlg;
}
