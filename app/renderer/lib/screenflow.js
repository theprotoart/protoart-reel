// ScreenFlow projects (.screenflow packages) read into a plan Reel can rebuild: sources, tracks, clips with
// their transforms, sound, text, transitions, callouts, zoom / pan actions, markers and captions. Written for
// Reel from an analysis of the file format (interoperability); no ScreenFlow code is used.
//
// ScreenFlowDocument.dat is an Apple Core Data binary store: 'CoreData' + offsets (big-endian u64) to a keyed
// archive of every object (entity name, attribute values in the model's stored order, related object ids) and
// to a metadata archive (which model version saved it). Times are in DocumentProperties.timeScale units.
import { parseBplist, unarchive, nsColor } from './bplist.js';
import { SCREENFLOW_MODELS } from './screenflow-models.js';

const be64 = (b, p) => Number(new DataView(b.buffer, b.byteOffset + p, 8).getBigUint64(0));
const size = s => { const m = /\{\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\}/.exec(String(s || '')); return m ? { w: +m[1], h: +m[2] } : null; };
const rect = s => { const m = /\{\{\s*(-?[\d.e-]+)\s*,\s*(-?[\d.e-]+)\s*\}\s*,\s*\{\s*(-?[\d.e-]+)\s*,\s*(-?[\d.e-]+)\s*\}\}/.exec(String(s || '')); return m ? { x: +m[1], y: +m[2], w: +m[3], h: +m[4] } : null; };

/** Reads ScreenFlowDocument.dat. Returns { model, timeScale, canvas, objects: Map<id, { id, entity, a, rel }> }. */
export function readScreenflowDocument(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (new TextDecoder().decode(b.subarray(0, 8)) !== 'CoreData') throw new Error('This isn’t a ScreenFlow project (or it was saved in a format Reel can’t read).');
  const mOff = be64(b, 16), mLen = be64(b, 24), dOff = be64(b, 32), dLen = be64(b, 40);
  let version = '';
  try {
    const meta = unarchive(parseBplist(b.subarray(mOff, mOff + mLen))).metadata || {};
    version = (meta.NSStoreModelVersionIdentifiers || [])[0] || '';
  } catch { /* the store can still be read */ }
  const top = unarchive(parseBplist(b.subarray(dOff, dOff + dLen)));
  const nodes = Object.values(top.mapData || top.root || {}).filter(n => n && n.NSEntityName);
  // the model: those matching the saved version first, newest first; the first whose key fields read right
  const order = [...SCREENFLOW_MODELS.filter(m => m.version === version), ...SCREENFLOW_MODELS.filter(m => m.version !== version)];
  for (const model of order) {
    const objects = decode(nodes, model);
    if (objects && sane(objects)) {
      const dp = [...objects.values()].find(o => o.entity === 'DocumentProperties');
      const cs = size(dp?.a.canvasSize) || { w: 1920, h: 1080 };
      return { model: model.model, version, timeScale: dp?.a.timeScale || 600, canvas: cs, objects };
    }
  }
  throw new Error('This ScreenFlow project was saved by a version Reel can’t read yet.');
}

function decode(nodes, model) {
  const out = new Map();
  for (const n of nodes) {
    const names = model.entities[n.NSEntityName]?.split(' ').filter(Boolean);
    const vals = n.NSAttributeValues || [];
    if (!names || vals.length < names.length) return null;
    const a = {}; names.forEach((k, i) => { a[k] = vals[i]; });
    const rel = {}; for (const [k, v] of Object.entries(n.NSRelatedNodes || {})) rel[k] = Array.isArray(v) ? v : v == null ? [] : [v];
    out.set(n.NSPrimaryKey64, { id: n.NSPrimaryKey64, entity: n.NSEntityName, a, rel });
  }
  return out;
}
function sane(objects) {
  for (const o of objects.values()) {
    const a = o.a;
    if (o.entity === 'DocumentProperties' && !size(a.canvasSize)) return false;
    if (o.entity === 'Track' && typeof a.zorder !== 'number') return false;
    if (/Clip$/.test(o.entity) && 'duration' in a && (typeof a.duration !== 'number' || (a.scaleX != null && typeof a.scaleX !== 'number'))) return false;
    if (o.entity === 'MediaSource' && a.filePath != null && typeof a.filePath !== 'string') return false;
  }
  return true;
}

const CLIP_ENTITIES = new Set(['MediaClip', 'ScreenMediaClip', 'TextClip', 'SizeableClip', 'TitleClip', 'NestedMediaClip', 'AnnotationsClip', 'TemplatePlaceholderClip', 'SpeechClip']);
const TRANSITIONS = [[/black|color/i, 'dip-black'], [/white/i, 'dip-white'], [/push|slide|move/i, 'slide-left'], [/zoom|scale/i, 'zoom'], [/blur/i, 'blur'], [/pop|bounce/i, 'pop'], [/./, 'fade']];
const ALIGN = { 0: 'left', 1: 'right', 2: 'center', 3: 'center', 4: 'center' };
const BUILDS = { fade: 'fade', move: 'slide', zoom: 'pop', scale: 'pop', typewriter: 'typewriter', type: 'typewriter', bounce: 'bounce', flip: 'flip', drop: 'gravity' };

/** A font's PostScript name ('GillSans-Bold') → { family: 'Gill Sans', weight: 700, italic }. */
export function fontFromPostScript(name) {
  const [fam, style = ''] = String(name || 'Helvetica').split('-');
  const family = fam.replace(/MT$|PS$|Std$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').trim();
  const weight = /black|heavy/i.test(style) ? 900 : /extrabold|ultrabold/i.test(style) ? 800 : /bold/i.test(style) ? 700 : /semibold|demi/i.test(style) ? 600 : /medium/i.test(style) ? 500 : /light/i.test(style) ? 300 : /thin|ultralight/i.test(style) ? 200 : 400;
  return { family, weight, italic: /italic|oblique/i.test(style) };
}

/**
 * The project as a plan: { canvas, duration, sources, tracks, clips, markers }. Times in seconds; positions as
 * fractions of the canvas; clip.track is an index into tracks (0 = top), lanes split overlapping clips.
 */
export function planScreenflow(doc) {
  const { objects, timeScale: ts, canvas } = doc;
  const all = [...objects.values()], get = id => objects.get(id), sec = v => (Number(v) || 0) / ts;
  // sources
  const sources = all.filter(o => o.entity === 'MediaSource').map(o => {
    const a = o.a;
    return { id: o.id, type: a.type || 'video', name: a.prettyName || (a.filePath || '').split('/').pop() || 'Media', filePath: a.filePath || null,
      inPackage: !!a.livesInPackage || /\.screenflow\/Media\//.test(a.filePath || ''), scc: /\.scc$/i.test(a.filePath || ''),
      videoStream: a.clutchVideoStreamID ?? -1, audioStream: a.clutchAudioStreamID ?? -1, hasVideo: !!a.hasVideo, hasAudio: !!a.hasAudio,
      width: a.videoWidth || 0, height: a.videoHeight || 0, duration: a.durationAsSeconds || (a.durationValue && a.durationTimescale ? a.durationValue / a.durationTimescale : 0),
      channels: a.audioChannelCount || 0, contentUUID: a.contentUUID || '' };
  });
  const srcOf = c => get((c.rel.source || [])[0]);
  // clips (only those placed on the timeline: they have a track z-order and a duration)
  const clips = all.filter(o => CLIP_ENTITIES.has(o.entity) && typeof o.a.duration === 'number' && o.a.duration > 0 && o.a.enabled !== 0).map(o => {
    const a = o.a, src = srcOf(o), sa = src?.a || {};
    // ScreenFlow's duration is the length of source used; on the timeline a sped-up clip is that ÷ speed
    // (taking it as timeline length made sped clips 3–30× too long, so they piled up on extra tracks)
    const speed = a.speed > 0 ? a.speed : 1, start = sec(a.startTime), dur = sec(a.duration) / speed, inP = sec(a.inPoint);
    const srcW = sa.videoWidth || 0, srcH = sa.videoHeight || 0;
    // picture: ScreenFlow places media at its pixel size × scale (centre = canvas centre + position);
    // Reel fits media into the canvas and scales from there
    const crop = cropOf(a.contentsRectData);
    const fit = srcW && srcH ? Math.min(canvas.w / srcW, canvas.h / srcH) : 1;
    const props = {
      x: 0.5 + (a.positionX || 0), y: 0.5 - (a.positionY || 0),
      scale: srcW ? Math.max(0.01, (a.scaleX ?? 1) / fit) : (a.scaleX ?? 1), rotation: -(a.rotationZ || 0),
      opacity: a.alpha ?? 1, crop, shadow: a.dropShadow ? Math.round((a.shadowOffset || 20) * 0.6) : 0,
      radius: a.roundedCornerAmount ? Math.min(0.5, a.roundedCornerAmount / 100) : 0,
    };
    const out = { id: o.id, entity: o.entity, source: src?.id ?? null, sourceType: sa.type || null, z: a.zorder | 0, start, duration: dur, in: inP, speed, props,
      audio: { volume: a.volume ?? 1, mute: !!a.muteVolume, duck: a.audioDucking ? a.audioDuckingPercent ?? 0.2 : 0, autoLevel: !!a.audioAutoLevel, denoise: a.audioRemoveBackgroundNoise ? a.audioRemoveBackgroundNoiseSuppressionAmount ?? 0.5 : 0 },
      showCursor: o.entity === 'ScreenMediaClip' ? a.showMouseCursor !== 0 : null, cursorScale: a.mouseScale || 1, clickEffect: a.clickEffect && a.clickEffect !== 'none' ? a.clickEffect : null,
      showKeys: o.entity === 'ScreenMediaClip' ? !!a.showHotkeys || !!a.showTyping : false,
      name: a.prettyName || sa.prettyName || o.entity.replace(/Clip$/, ''), actions: [], transIn: null, transOut: null };
    // the per-channel mix of a recording's sound (e.g. a two-input interface with the mic on input 1)
    const mix = get((o.rel.audioMix || [])[0]);
    if (mix) out.audio.channels = (mix.rel.channels || []).map(get).filter(Boolean).map(ch => ({ gain: ch.a.gain ?? 1, pan: ((ch.a.pan ?? 0.5) - 0.5) * 2, on: !ch.a.hidden && ch.a.enabled !== 0, solo: !!ch.a.solo }));
    if (o.entity === 'TextClip') out.text = textOf(a, canvas);
    // actions attached to the clip (times relative to the clip's start)
    for (const act of (o.rel.actions || []).map(get).filter(Boolean)) {
      const t0 = sec(act.a.startTime), d = sec(act.a.duration);
      if (act.entity === 'CalloutAction') {
        const ops = act.a.drawStream?.operations || [];
        // each operation stamps a shape (what 1: square / rectangle, otherwise circle / oval); additive false erases
        const rects = ops.map(op => { const r = rect(op.where); return r && { ...r, square: op.what === 1, additive: op.additive !== false }; }).filter(Boolean);
        out.actions.push({ kind: 'callout', start: t0, duration: d, highlight: act.a.highlightType || 'freehand', rects, srcW, srcH,
          dim: act.a.alpha ?? 0.75, blur: act.a.blur || 0, blurBackground: !!act.a.blurBackground, zoom: act.a.zoomUp || 1, radius: act.a.cornerRound || 0,
          outline: act.a.outlineWidth || 0, outlineColor: nsColor(act.a.outlineColor)?.hex || '#ffb02a', feather: act.a.foregroundBlur || 0,
          buildIn: act.a.buildInDuration || 0, buildOut: act.a.buildOutDuration || 0 });
      } else if (act.entity === 'VideoAction') {
        const b = act.a, p = {
          x: 0.5 + (b.positionX || 0), y: 0.5 - (b.positionY || 0), scale: srcW ? (b.scaleX ?? 1) / fit : b.scaleX ?? 1,
          rotation: -(b.rotationZ || 0), opacity: b.alpha ?? 1, crop: cropOf(b.contentsRectData),
        };
        out.actions.push({ kind: 'video', start: t0, duration: d, ease: b.interpolation, to: p });
      } else if (act.entity === 'AudioAction') {
        out.actions.push({ kind: 'audio', start: t0, duration: d, volume: act.a.volume ?? 1, mute: !!act.a.muteVolume });
      }
    }
    return out;
  });
  // transitions: between two clips (they overlap by the transition's length) or at one clip's edge
  for (const tr of all.filter(o => o.entity === 'Transition')) {
    const name = tr.a.provider?.SCTransitionProviderInternalName || tr.a.provider?.$class || '';
    const type = TRANSITIONS.find(([re]) => re.test(name))[1];
    const cs = (tr.rel.clips || []).map(id => clips.find(c => c.id === id)).filter(Boolean).sort((p, q) => p.start - q.start);
    if (cs.length === 2) {
      const ov = cs[0].start + cs[0].duration - cs[1].start, d = ov > 0.01 ? ov : sec(tr.a.duration) || 1;
      cs[1].transIn = { type, dur: Math.max(0.05, d) };
      if (ov <= 0.01) cs[0].transOut = { type, dur: Math.max(0.05, d) };
    } else if (cs.length === 1) {
      const d = sec(tr.a.duration) || 1;
      if (tr.a.timeEdge === 1) cs[0].transOut = { type, dur: d }; else cs[0].transIn = { type, dur: d };
    }
  }
  // tracks: ScreenFlow's higher z-order draws on top (Reel: index 0 on top); overlapping clips on one track
  // (ScreenFlow's cross-transitions) get a lane of their own just above it
  const zs = [...new Set(clips.map(c => c.z))].sort((p, q) => q - p);
  const tracks = [];
  for (const z of zs) {
    const lanes = [];
    for (const c of clips.filter(x => x.z === z).sort((p, q) => p.start - q.start)) {
      let l = lanes.findIndex(end => end <= c.start + 1e-4);
      if (l < 0) { l = lanes.length; lanes.push(0); }
      lanes[l] = c.start + c.duration; c.lane = l;
    }
    const kind = clips.filter(x => x.z === z).every(x => x.sourceType === 'camera' && !x.props.scale) ? 'audio' : 'mixed';
    for (let l = lanes.length - 1; l >= 0; l--) {
      const sample = clips.find(x => x.z === z && x.lane === l);
      tracks.push({ z, lane: l, name: sample?.entity === 'TextClip' ? 'Titles' : sample?.sourceType === 'screen' ? 'Screen' : sample?.sourceType === 'camera' && !sources.find(s => s.id === sample.source)?.hasVideo ? 'Audio' : 'Media', kind });
      for (const c of clips) if (c.z === z && c.lane === l) c.track = tracks.length - 1;
    }
  }
  const markers = all.filter(o => o.entity === 'Marker').map(o => ({ t: sec(o.a.startTime), name: o.a.name || 'Marker' }));
  const captions = all.filter(o => o.entity === 'Caption').map(o => ({ text: String(o.a.text || ''), duration: sec(o.a.duration), language: o.a.languageCode || '' }));
  const duration = clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  return { canvas, duration, sources, tracks, clips, markers, captions };
}

function cropOf(s) {
  const v = String(s || '').replace(/[[\]]/g, '').trim().split(/\s+/).map(Number);
  if (v.length !== 4 || v.some(Number.isNaN)) return [0, 0, 0, 0];
  const [x0, y0, x1, y1] = v, c = n => Math.max(0, Math.min(0.95, n));
  return [c((x0 + 1) / 2), c((1 - y1) / 2), c((1 - x1) / 2), c((y0 + 1) / 2)];
}

function textOf(a, canvas) {
  const as = a.textString || {}, attrs = as.NSAttributes || {};
  const content = typeof as === 'string' ? as : as.NSString ?? '';
  const font = fontFromPostScript(attrs.NSFont?.NSName), color = nsColor(attrs.NSColor), bg = a.useBackground ? nsColor(a.backgroundColor) : null;
  const box = size(a.contentSizeAsString);
  const inName = String(a.buildInAnimationName || ''), inProps = a.buildInAnimationProperties || {};
  let anim = a.buildInAnimationEnabled === 0 || !inName ? 'none' : BUILDS[inName] || 'fade';
  if (anim === 'slide' && /byLine|byWord/i.test(inProps.buildMode || '')) anim = 'build';
  return {
    content, font: font.family, weight: font.weight, italic: font.italic, size: attrs.NSFont?.NSSize || 48,
    color: color?.hex || '#ffffff', align: ALIGN[attrs.NSParagraphStyle?.NSAlignment] || 'center',
    bg: bg?.hex || '#000000', bgOpacity: bg ? bg.alpha : 0, padding: a.margin || 0, width: box ? Math.min(1, (box.w * 1.08) / canvas.w) : 0.8,
    anim, animDur: a.buildInAnimationDurationSeconds || 0.4,
    animOut: a.buildOutAnimationEnabled === 0 ? 'none' : BUILDS[String(a.buildOutAnimationName || '')] || 'fade', animOutDur: a.buildOutAnimationDurationSeconds || 0.4,
  };
}
