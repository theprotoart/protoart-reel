// Importing ScreenFlow projects: the document is read (lib/screenflow.js), its recordings are converted in a
// worker (picture → MP4 with the pointer as a separate track, sound → WAV with the project's channel mix), and
// the timeline is rebuilt in Reel: tracks, clips, positions and scale, crops, volume, text, transitions,
// zoom / pan actions as keyframes, callouts and markers.
import { readScreenflowDocument, planScreenflow } from './lib/screenflow.js';
import { uid, DEFAULT_PROPS, CALLOUT_DEFAULTS, newMediaClip, newTextClip, newCalloutClip, putKey, duration, mergeOverlapTracks } from './model.js';

const base = p => String(p || '').split('/').pop();

/** Converts what a dropped ScreenFlow project needs. Returns { plan, media: Map, cursors: Map, notes: [] }. */
export async function convertScreenflow(app, entry, onProgress) {
  const api = app.api, token = app.token;
  const plan = planScreenflow(readScreenflowDocument(entry.doc));
  const used = new Set(plan.clips.map(c => c.source));
  const sources = plan.sources.filter(s => used.has(s.id) && s.type !== 'text');
  const media = new Map(), cursors = new Map(), notes = [];
  const jobs = [], copies = new Map(); // package path → the URL it's read from (no copy is made)
  for (const s of sources) {
    if (s.scc) {
      const inPkg = entry.media.find(m => m.scc && m.base === base(s.filePath)) || (entry.media.filter(m => m.scc).length === 1 ? entry.media.find(m => m.scc) : null);
      if (!inPkg) { notes.push(`${s.name}: its recording is missing from the project package.`); continue; }
      if (s.hasVideo && s.videoStream >= 0) jobs.push({ s, src: inPkg.path, kind: 'video' });
      if (s.hasAudio && s.audioStream >= 0) {
        const mixFrom = plan.clips.find(c => c.source === s.id && c.audio.channels);
        jobs.push({ s, src: inPkg.path, kind: 'audio', mix: mixFrom ? mixFrom.audio.channels : null });
      }
    } else if (s.filePath) jobs.push({ s, kind: 'file' });
  }
  const step = (i, label, v) => onProgress?.(label, Math.min(0.999, (i + v) / Math.max(1, jobs.length)));
  for (const [i, j] of jobs.entries()) {
    const s = j.s;
    if (j.kind === 'file') {
      // media the ScreenFlow project imported: the copy inside the package, or the original where it was
      step(i, s.name, 0);
      const inPkg = entry.media.find(m => !m.scc && m.base === base(s.filePath));
      const [r] = (await api.importPaths(token, [inPkg ? inPkg.path : s.filePath]).catch(() => [])) || [];
      if (r && !r.error) media.set(s.id, { ...(media.get(s.id) || {}), picture: r.kind === 'audio' ? null : r, sound: r.kind === 'audio' ? r : null });
      else notes.push(`${s.name}: ${r?.error || 'the file it uses wasn’t found (' + s.filePath + ')'}`);
      continue;
    }
    const label = j.kind === 'video' ? `${s.name} · picture` : `${s.name} · sound`;
    try {
      if (!copies.has(j.src)) { step(i, `${s.name} · opening the recording`, 0); copies.set(j.src, await api.copyIn(token, j.src)); }
      const out = await runWorker(api, token, copies.get(j.src), j.kind === 'video' ? { type: 'video', stream: s.videoStream, fps: Math.min(60, Math.max(24, app.doc?.canvas?.fps || 30)) } : { type: 'audio', stream: s.audioStream, mix: j.mix },
        s.name, (v, detail) => step(i, detail ? `${label} · ${detail}` : label, v));
      const slot = media.get(s.id) || { picture: null, sound: null };
      if (j.kind === 'video') {
        slot.picture = { ...out.result, name: s.name, role: 'screen', convertedFrom: 'screenflow', rangeOk: true };
        if (out.cursor) {
          const file = await api.writeJson(token, `${out.result.file.replace(/\.[^.]+$/, '')}-cursor`, out.cursor);
          Object.assign(slot.picture, { cursor: file, cursorOffset: 0, pointerSeparate: true, cursorClicks: out.cursor.clicks.length });
          cursors.set(s.id, out.cursor);
        }
      } else slot.sound = { ...out.result, name: s.hasVideo ? `${s.name} sound` : s.name, role: s.type === 'camera' && !s.hasVideo ? 'mic' : 'import', convertedFrom: 'screenflow' };
      media.set(s.id, slot);
    } catch (e) { notes.push(`${label}: ${e.message}`); }
  }
  return { plan, media, cursors, notes, name: entry.name };
}

async function runWorker(api, token, url, msg, stem, onProgress) {
  const worker = new Worker(new URL('./scc-worker.js', import.meta.url), { type: 'module' });
  let rid = null;
  try {
    return await new Promise((resolve, reject) => {
      let queue = [], opening = null;
      worker.onmessage = async e => {
        const m = e.data;
        if (m.type === 'format') { opening = api.renderBegin(token, stem, m.ext).then(r => { rid = r.id; for (const d of queue) api.renderChunk(rid, d); queue = []; }); }
        else if (m.type === 'chunk') { if (rid) api.renderChunk(rid, m.data); else queue.push(m.data); }
        else if (m.type === 'progress') onProgress?.(m.value, m.detail);
        else if (m.type === 'done') {
          try { await opening; const result = await api.renderFinish(rid, m.head); rid = null; resolve({ result, cursor: m.cursor || null }); } catch (err) { reject(err); }
        } else if (m.type === 'error') reject(new Error(m.message));
      };
      worker.onerror = e => reject(new Error(e.message || 'Conversion failed'));
      worker.postMessage({ ...msg, url });
    });
  } finally {
    worker.terminate();
    if (rid) api.renderCancel(rid);
  }
}

/** Rebuilds the converted project in doc (inside a commit). Returns a summary for the toast. */
export function placeScreenflow(doc, built, where) {
  const { plan, media, cursors } = built;
  const empty = doc.clips.length === 0;
  if (empty && plan.canvas.w > 0 && plan.canvas.h > 0) { doc.canvas.width = Math.round(plan.canvas.w); doc.canvas.height = Math.round(plan.canvas.h); }
  const k = doc.canvas.width / plan.canvas.w; // text sizes are authored at canvas size
  const t0 = where?.at ?? (empty ? 0 : duration(doc));
  // media entries
  const mediaIds = new Map();
  for (const [sid, slot] of media) {
    const ids = {};
    for (const part of ['picture', 'sound']) if (slot[part]) { const m = { id: uid('m'), ...slot[part] }; doc.media.push(m); ids[part] = m; }
    mediaIds.set(sid, ids);
  }
  // tracks, in ScreenFlow's stacking order, above whatever is already there
  const trackIds = plan.tracks.map(t => ({ id: uid('t'), name: `${t.name}${t.lane ? ' (overlap)' : ''}` }));
  const extra = [];
  let placed = 0, skipped = 0;
  const callouts = [];
  for (const c of plan.clips) {
    const start = t0 + c.start, track = trackIds[c.track].id;
    if (c.entity === 'TextClip' && c.text) {
      const x = newTextClip(track, start, c.text.content);
      Object.assign(x.text, {
        content: c.text.content, font: c.text.font, weight: c.text.weight, italic: c.text.italic, size: Math.round(c.text.size * k),
        color: c.text.color, align: c.text.align, bg: c.text.bg, bgOpacity: c.text.bgOpacity, padding: Math.round(c.text.padding * k),
        width: c.text.width || x.text.width, anim: c.text.anim, animDur: c.text.animDur,
      });
      x.duration = c.duration; x.props = { ...x.props, x: c.props.x, y: c.props.y, opacity: c.props.opacity, rotation: c.props.rotation };
      x.name = c.text.content.slice(0, 40) || 'Text';
      trans(x, c); doc.clips.push(x); placed++;
      continue;
    }
    const ids = mediaIds.get(c.source);
    const pic = ids?.picture, snd = ids?.sound;
    if (!pic && !snd) { skipped++; continue; }
    const m = pic || snd;
    const x = newMediaClip(doc, m, track, start);
    x.in = c.in; x.duration = c.duration; x.speed = c.speed;
    x.props = { ...DEFAULT_PROPS, ...c.props, crop: c.props.crop.slice() };
    x.audio.volume = c.audio.volume; x.audio.mute = c.audio.mute; if (c.audio.duck) x.audio.duck = c.audio.duck;
    x.name = c.name;
    if (pic && pic.cursor) x.cursor = { show: c.showCursor !== false, pointer: 'arrow', scale: c.cursorScale || 1, clickStyle: c.clickEffect ? 'rings' : 'none' };
    if (c.showKeys) x.keystrokes = { show: true, hold: 1.5 };
    trans(x, c);
    keyActions(x, c);
    doc.clips.push(x); placed++;
    // a source with both picture and sound: the sound goes on its own track, in step
    if (pic && snd) {
      let at = extra.find(e => e.after === c.track);
      if (!at) { at = { after: c.track, id: uid('t'), name: `${c.name} sound` }; extra.push(at); }
      const a = newMediaClip(doc, snd, at.id, start);
      a.in = c.in; a.duration = c.duration; a.speed = c.speed; a.audio.volume = c.audio.volume; a.audio.mute = c.audio.mute; a.name = `${c.name} sound`;
      doc.clips.push(a);
    }
    for (const act of c.actions.filter(a => a.kind === 'callout')) callouts.push({ act, clip: c, start: start + act.start, source: c.source });
  }
  // callouts become callout clips on a track of their own, on top
  let calloutTrack = null;
  for (const { act, clip, start, source } of callouts) {
    if (!calloutTrack) calloutTrack = { id: uid('t'), name: 'Callouts' };
    const x = newCalloutClip(calloutTrack.id, start);
    x.duration = Math.max(0.1, act.duration);
    x.callout = { ...CALLOUT_DEFAULTS, ...calloutArea(act, clip, plan.canvas, cursors.get(source), start - t0 - clip.start + clip.in),
      dim: act.dim, blur: act.blurBackground ? Math.max(6, act.blur * 40) : 0, zoom: Math.max(1, act.zoom), radius: Math.min(0.2, act.radius / 400),
      outline: act.outline ? Math.max(1, Math.round(act.outline * k)) : 0, outlineColor: act.outlineColor };
    x.transIn = act.buildIn ? { type: 'fade', dur: act.buildIn } : { type: 'fade', dur: 0.2 };
    x.transOut = act.buildOut ? { type: 'fade', dur: act.buildOut } : { type: 'fade', dur: 0.2 };
    x.name = act.highlight === 'freehand' ? 'Callout' : act.highlight === 'foregroundWindow' ? 'Window callout' : 'Pointer callout';
    doc.clips.push(x);
  }
  const newTracks = [...(calloutTrack ? [calloutTrack] : [])];
  trackIds.forEach((t, i) => { newTracks.push(t); for (const e of extra.filter(x => x.after === i)) newTracks.push({ id: e.id, name: e.name }); });
  doc.tracks.unshift(...newTracks);
  // ScreenFlow's cross-transitions overlap two clips: they become crossfades on one track, not extra layers
  mergeOverlapTracks(doc);
  // markers
  doc.markers = doc.markers || [];
  for (const mk of plan.markers) doc.markers.push({ id: uid('k'), t: t0 + mk.t, label: mk.name });
  return { placed, skipped, callouts: callouts.length, canvasSet: empty };
}

function trans(x, c) {
  if (c.transIn) x.transIn = { type: c.transIn.type, dur: c.transIn.dur };
  if (c.transOut) x.transOut = { type: c.transOut.type, dur: c.transOut.dur };
}

/** ScreenFlow video actions (move / zoom / fade over a stretch) → keyframes on the clip. */
function keyActions(x, c) {
  const acts = c.actions.filter(a => a.kind === 'video').sort((a, b) => a.start - b.start);
  if (!acts.length) return;
  let cur = { x: c.props.x, y: c.props.y, scale: c.props.scale, rotation: c.props.rotation, opacity: c.props.opacity };
  for (const a of acts) {
    const t1 = Math.max(0, a.start), t2 = Math.min(c.duration, a.start + Math.max(1 / 30, a.duration));
    for (const p of ['x', 'y', 'scale', 'rotation', 'opacity']) {
      if (Math.abs((a.to[p] ?? cur[p]) - cur[p]) < 1e-4) continue;
      putKey(x, p, t1, cur[p], 1 / 60, 'ease');
      putKey(x, p, t2, a.to[p], 1 / 60, 'ease');
    }
    cur = { ...cur, ...a.to };
  }
}

/**
 * Where a callout sits on the canvas (x, y centre; w, h; shape). Freehand: the drawn area (in the recording's
 * pixels, origin bottom left), through the clip's placement. Pointer: around the pointer. Window: the window
 * in front at that moment (both from the recording's pointer track).
 */
function calloutArea(act, clip, canvas, cur, srcT) {
  const srcW = act.srcW || canvas.w, srcH = act.srcH || canvas.h, p = clip.props;
  const fit = Math.min(canvas.w / srcW, canvas.h / srcH), fw = (srcW * fit * p.scale) / canvas.w, fh = (srcH * fit * p.scale) / canvas.h;
  const place = (u, v, uw, vh) => ({ x: p.x + (u + uw / 2 - 0.5) * fw, y: p.y + (v + vh / 2 - 0.5) * fh, w: uw * fw, h: vh * fh });
  const drawn = (act.rects || []).filter(r => r.additive !== false);
  if (act.highlight === 'freehand' && drawn.length) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of drawn) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
    // one callout area: drawn with squares → a rectangle, with circles → an oval (several shapes: the area around them)
    const square = drawn.length > 1 ? drawn.some(r => r.square) : drawn[0].square;
    return { shape: square ? 'rect' : 'ellipse', ...place(x0 / srcW, 1 - y1 / srcH, (x1 - x0) / srcW, (y1 - y0) / srcH) };
  }
  if (cur && cur.points?.length) {
    const ms = srcT * 1000, b = cur.display.bounds;
    if (act.highlight === 'foregroundWindow' && cur.windows?.length) {
      let w = cur.windows[0]; for (const x of cur.windows) if (x[0] <= ms) w = x;
      return { shape: 'rect', ...place(w[1] / b.width, w[2] / b.height, (w[3] - w[1]) / b.width, (w[4] - w[2]) / b.height) };
    }
    let pt = cur.points[0]; for (const x of cur.points) if (x[0] <= ms) pt = x;
    return { shape: 'ellipse', ...place(pt[1] / b.width - 0.06, pt[2] / b.height - 0.08, 0.12, 0.16) };
  }
  return { shape: 'ellipse', x: 0.5, y: 0.5, w: 0.3, h: 0.3 };
}
