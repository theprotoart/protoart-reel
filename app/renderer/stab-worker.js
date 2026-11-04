// Stabilize, analysis (module Web Worker): decodes the clip's part of the video at a low frame rate, shrinks each
// frame to 192 pixels wide in grey, and measures how the picture moved from one to the next (lib/stabilize.js).
import { openVideo, forgetVideos } from './lib/sources.js';
import { toGrey, estimateMotion } from './lib/stabilize.js';

let cancelled = false;
self.onmessage = async e => {
  const m = e.data;
  if (m.type === 'cancel') { cancelled = true; return; }
  if (m.type !== 'start') return;
  cancelled = false;
  try {
    const src = await openVideo(m.url);
    if (!src) throw new Error('No picture in this clip');
    const W = 192;
    let canvas = null, ctx = null, H = 108, prev = null;
    const moves = [];
    const n = Math.max(2, Math.floor((m.t1 - m.t0) * m.rate) + 1);
    for (let i = 0; i < n; i++) {
      if (cancelled) throw new Error('Cancelled');
      const t = m.t0 + i / m.rate;
      const f = await src.frameAt(t);
      if (!f) { moves.push({ dx: 0, dy: 0, rot: 0 }); continue; }
      if (!canvas) { H = Math.max(32, Math.round(W * f.displayHeight / f.displayWidth)); canvas = new OffscreenCanvas(W, H); ctx = canvas.getContext('2d', { willReadFrequently: true }); }
      ctx.drawImage(f, 0, 0, W, H);
      const g = toGrey(ctx.getImageData(0, 0, W, H).data, W, H);
      if (prev) moves.push(estimateMotion(prev, g, W, H));
      prev = g;
      if (i % 10 === 0) self.postMessage({ type: 'progress', f: i / n });
    }
    try { src.close?.(); } catch { /* fine */ }
    forgetVideos();
    self.postMessage({ type: 'done', moves });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message || err) });
  }
};
