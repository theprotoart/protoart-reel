// Waveform peaks and poster frames for the timeline and library (computed once per file).
const peakCache = new Map(), posterCache = new Map();
let worker = null, seq = 1;
const waiting = new Map();

function peaksWorker() {
  if (!worker) {
    worker = new Worker('peaks-worker.js', { type: 'module' });
    worker.onmessage = e => { const w = waiting.get(e.data.id); waiting.delete(e.data.id); if (w) w(e.data.peaks || null); };
  }
  return worker;
}

export function peaksFor(app, m) {
  const key = app.token + '/' + m.file;
  if (!peakCache.has(key)) {
    peakCache.set(key, new Promise(resolve => {
      const id = seq++;
      waiting.set(id, resolve);
      peaksWorker().postMessage({ id, url: `app://reel/m/${app.token}/${encodeURIComponent(m.file)}`, file: m.file });
    }));
  }
  return peakCache.get(key);
}

export function posterFor(app, m, w = 160, h = 90) {
  const key = app.token + '/' + m.file;
  if (!posterCache.has(key)) {
    posterCache.set(key, new Promise(resolve => {
      const url = `app://reel/m/${app.token}/${encodeURIComponent(m.file)}`;
      const draw = (src, sw, sh) => {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d');
        g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
        const s = Math.min(w / sw, h / sh);
        g.drawImage(src, (w - sw * s) / 2, (h - sh * s) / 2, sw * s, sh * s);
        return c.toDataURL('image/jpeg', 0.7);
      };
      if (m.kind === 'image') {
        const img = new Image();
        img.onload = () => resolve(draw(img, img.naturalWidth, img.naturalHeight));
        img.onerror = () => resolve(null);
        img.src = url;
        return;
      }
      if (m.kind !== 'video') return resolve(null);
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto'; v.src = url;
      const done = url2 => { v.removeAttribute('src'); v.load(); resolve(url2); };
      v.addEventListener('loadedmetadata', () => { v.currentTime = Math.min(1, (v.duration || 2) / 3); }, { once: true });
      v.addEventListener('seeked', () => done(draw(v, v.videoWidth, v.videoHeight)), { once: true });
      v.addEventListener('error', () => done(null), { once: true });
      setTimeout(() => done(null), 8000);
    }));
  }
  return posterCache.get(key);
}

export function forget(app, m) { const key = app.token + '/' + m.file; peakCache.delete(key); posterCache.delete(key); }
