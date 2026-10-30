// Computes waveform peaks (100 per second, 0..1) for a media file's audio, off the main thread.
import { openAudio } from './lib/sources.js';

const RATE = 100;
self.onmessage = async e => {
  const { id, url, file } = e.data;
  try {
    const a = await openAudio(url, file);
    if (!a) return self.postMessage({ id, peaks: null });
    const per = Math.max(1, Math.round(a.rate / RATE));
    const total = a.frames ?? Math.ceil((a.track ? a.track.duration : 0) * a.rate);
    const n = Math.ceil(total / per);
    const data = new Float32Array(n);
    const CH = per * 2000;
    for (let start = 0, k = 0; start < total; start += CH) {
      const pcm = await a.read(start, Math.min(CH, total - start));
      const len = pcm[0].length;
      for (let i = 0; i < len; i += per, k++) {
        let v = 0;
        for (const ch of pcm) for (let j = i; j < Math.min(len, i + per); j++) { const x = Math.abs(ch[j]); if (x > v) v = x; }
        if (k < n) data[k] = Math.min(1, Math.sqrt(v)); // sqrt: quiet speech still shows
      }
    }
    a.close();
    self.postMessage({ id, peaks: { rate: RATE, data } }, [data.buffer]);
  } catch {
    self.postMessage({ id, peaks: null });
  }
};
