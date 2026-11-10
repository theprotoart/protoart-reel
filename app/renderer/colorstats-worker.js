// Colour match, measuring (module Web Worker): decodes a few frames of a video (or the picture), shrinks them to
// 160 pixels wide and adds up their colours (lib/colormatch.js). Never touches the project.
import { openVideo, forgetVideos } from './lib/sources.js';
import { ColorStats } from './lib/colormatch.js';

self.onmessage = async e => {
  const m = e.data;
  if (m.type !== 'start') return;
  try {
    const st = new ColorStats();
    let canvas = null, ctx = null;
    const add = img => {
      const w0 = img.displayWidth || img.width, h0 = img.displayHeight || img.height;
      const W = 160, H = Math.max(16, Math.round(W * h0 / Math.max(1, w0)));
      if (!canvas || canvas.height !== H) { canvas = new OffscreenCanvas(W, H); ctx = canvas.getContext('2d', { willReadFrequently: true }); }
      ctx.drawImage(img, 0, 0, W, H);
      st.add(ctx.getImageData(0, 0, W, H).data);
    };
    if (m.kind === 'image') {
      const bmp = await createImageBitmap(await (await fetch(m.url)).blob());
      add(bmp); bmp.close?.();
    } else {
      const src = await openVideo(m.url);
      if (!src) throw new Error('No picture in this clip');
      for (const t of m.times) { const f = await src.frameAt(t); if (f) add(f); }
      try { src.close?.(); } catch { /* fine */ }
      forgetVideos();
    }
    const r = st.result;
    if (!r.n) throw new Error('The clip is too dark or too bright to measure');
    self.postMessage({ type: 'done', stats: r });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message || err) });
  }
};
