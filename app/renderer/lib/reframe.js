// Make Vertical (or square, or 4:5): a wide video re-framed for a tall canvas. The picture is scaled to fill
// the new frame and then follows where the action is (the pointer on a screen recording, otherwise where
// things move), like a camera operator: it holds still inside a dead zone, then glides, never showing past
// the picture's edges. Pure, so it can be tested.

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
