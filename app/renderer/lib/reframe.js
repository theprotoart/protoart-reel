// Make Vertical (or square, or 4:5): a wide video re-framed for a tall canvas. The picture is scaled to fill
// the new frame and then follows where the action is (the pointer on a screen recording, otherwise where
// things move), like a camera operator: it holds still inside a dead zone, then glides, never showing past
// the picture's edges. Pure, so it can be tested.
import { mediaById, uid, addTrack, putKey } from '../model.js';


export const FORMATS = {
  vertical: { w: 1080, h: 1920, label: '9:16 vertical — Shorts, Reels, TikTok' },
  portrait: { w: 1080, h: 1350, label: '4:5 portrait — Instagram feed' },
  square: { w: 1080, h: 1080, label: '1:1 square' },
};

/** Scale (Reel's clip scale, 1 = fit inside) that makes media of srcW×srcH fill a W×H canvas. */
export function coverScale(srcW, srcH, W, H) {
  const fit = Math.min(W / srcW, H / srcH), fw = srcW * fit, fh = srcH * fit;
  return Math.max(W / fw, H / fh);
}

/**
 * Where to put the clip over time. focus: [{ t, x, y, w }] in the media's 0..1 space (w = how much it counts).
 * Returns keys [{ t, x, y }] for the clip's position (canvas fractions), smooth and inside the edges.
 */
export function reframeKeys(focus, { srcW, srcH, W, H, scale, duration, dead = 0.12, step = 0.5, follow = 0.6 }) {
  const fit = Math.min(W / srcW, H / srcH), mw = srcW * fit * scale, mh = srcH * fit * scale;
  const maxX = Math.max(0, (mw - W) / (2 * W)), maxY = Math.max(0, (mh - H) / (2 * H));
  const toX = u => 0.5 + Math.max(-maxX, Math.min(maxX, (0.5 - u) * mw / W));
  const toY = v => 0.5 + Math.max(-maxY, Math.min(maxY, (0.5 - v) * mh / H));
  // a steady target: the weighted focus over a short window around each step
  const pts = [...focus].sort((a, b) => a.t - b.t);
  const targetAt = t => {
    let sx = 0, sy = 0, sw = 0;
    for (const p of pts) { const k = Math.exp(-(((p.t - t) / 0.6) ** 2)) * (p.w ?? 1); if (k < 1e-3) continue; sx += p.x * k; sy += p.y * k; sw += k; }
    return sw ? { x: sx / sw, y: sy / sw } : null;
  };
  const keys = [];
  let cam = targetAt(0) || { x: 0.5, y: 0.5 };
  // the visible part of the picture, in media units: the camera only moves when the focus leaves its middle
  const viewW = Math.min(1, W / mw), viewH = Math.min(1, H / mh);
  keys.push({ t: 0, x: toX(cam.x), y: toY(cam.y) });
  for (let t = step; t <= duration + 1e-6; t += step) {
    const tg = targetAt(t);
    if (!tg) continue;
    const dx = tg.x - cam.x, dy = tg.y - cam.y;
    const nx = Math.abs(dx) > viewW * dead ? cam.x + dx * follow : cam.x;
    const ny = Math.abs(dy) > viewH * dead ? cam.y + dy * follow : cam.y;
    if (Math.abs(toX(nx) - toX(cam.x)) > 0.002 || Math.abs(toY(ny) - toY(cam.y)) > 0.002) {
      // a held position up to here, then the move (so the picture doesn't drift the whole time)
      const last = keys[keys.length - 1];
      if (t - step - last.t > 1e-6) keys.push({ t: t - step, x: last.x, y: last.y });
      cam = { x: nx, y: ny };
      keys.push({ t: Math.min(duration, t), x: toX(cam.x), y: toY(cam.y) });
    }
  }
  return keys;
}

/** A clip Make Vertical moves: a picture shown whole, in the middle, at its own size. */
export function reframeable(doc, c) {
  return c.type === 'media' && !c.audioOnly && !c.disabled && ['video', 'image'].includes(mediaById(doc, c.media)?.kind) && Math.abs((c.props?.scale ?? 1) - 1) < 0.05 && Math.abs((c.props?.x ?? 0.5) - 0.5) < 0.05 && Math.abs((c.props?.y ?? 0.5) - 0.5) < 0.05;
}
/**
 * Makes doc d the shape F ({ w, h }): each clip in ids fills the new frame (mode: 'follow' the action, with plans from
 * reframeFocus; 'blur' or 'zoom' over a copy of itself; 'bars' whole, with black above and below), and titles are
 * resized to suit. Changes d (a project being committed, or a copy for an export).
 */
export function reframeDoc(d, F, mode, ids, plans = new Map()) {
  const W = F.w, H = F.h, k = W / d.canvas.width;
  d.canvas = { ...d.canvas, width: W, height: H };
  const set = new Set(ids);
  for (const c of [...d.clips]) {
    if (c.type === 'text' && c.text) c.text = { ...c.text, size: Math.max(18, Math.round((c.text.size || 96) * Math.max(k, 0.5))) };
    if (!set.has(c.id)) continue;
    const m = mediaById(d, c.media), sw = m.width || 1920, sh = m.height || 1080;
    const crop = c.props?.crop || [0, 0, 0, 0], cw = sw * (1 - crop[0] - crop[2]), ch = sh * (1 - crop[1] - crop[3]);
    const s = coverScale(cw, ch, W, H);
    // zoom / pan actions were made for the old frame
    c.actions = (c.actions || []).filter(a => Object.keys(a.props || {}).some(key => !['x', 'y', 'scale'].includes(key)));
    if (c.keys) { for (const p of ['props.x', 'props.y', 'props.scale']) delete c.keys[p]; if (!Object.keys(c.keys).length) delete c.keys; }
    if (mode === 'bars') continue; // the whole picture, black above and below
    if (mode === 'blur' || mode === 'zoom') {
      // the whole picture in the middle, over a copy of itself that fills the frame: blurred, or just zoomed in
      const bg = structuredClone(c); bg.id = uid('c'); bg.props = { ...bg.props, scale: s, x: 0.5, y: 0.5 };
      bg.filters = mode === 'blur'
        ? [...(bg.filters || []), { id: uid('f'), type: 'blur', amount: 40 }, { id: uid('f'), type: 'color', exposure: -0.35, saturation: 0.1 }]
        : [...(bg.filters || []), { id: uid('f'), type: 'color', exposure: -0.12 }];
      bg.audio = { ...(bg.audio || {}), mute: true };
      const i = d.tracks.findIndex(t => t.id === c.track);
      // its own Background track under the video (never one of the user's tracks)
      let tr = d.tracks.slice(i + 1).find(t => /^background$/i.test(t.name || '') && !d.clips.some(o => o.track === t.id && o.start < bg.start + bg.duration && o.start + o.duration > bg.start));
      if (!tr) { tr = addTrack(d, i + 1); tr.name = 'Background'; }
      bg.track = tr.id; d.clips.push(bg);
      continue;
    }
    c.props = { ...c.props, scale: s, x: 0.5, y: 0.5 };
    const focus = plans.get(c.id);
    if (mode === 'follow' && focus && focus.length) {
      const ks = reframeKeys(focus, { srcW: cw, srcH: ch, W, H, scale: s, duration: c.duration });
      for (const q of ks) { putKey(c, 'props.x', q.t, q.x, 1 / 60, 'ease'); putKey(c, 'props.y', q.t, q.y, 1 / 60, 'ease'); }
      c.props.x = ks[0]?.x ?? 0.5; c.props.y = ks[0]?.y ?? 0.5;
    }
  }
  return d;
}

