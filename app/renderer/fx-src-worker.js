// Decodes a media file's sound to 48 kHz float (mono or stereo), streaming interleaved chunks
// back to the page, which forwards them to the main process. Used as the starting point for
// clip effects (voice tools, plug-ins).
import { openAudio } from './lib/sources.js';

const RATE = 48000;
self.onmessage = async e => {
  const { url, file } = e.data;
  try {
    const a = await openAudio(url, file);
    if (!a) throw new Error('This file has no sound');
    const ch = Math.min(2, a.channels || 1);
    const total = a.frames ?? Math.ceil((a.track ? a.track.duration : 0) * a.rate);
    self.postMessage({ type: 'begin', channels: ch, seconds: total / a.rate });
    const ratio = a.rate / RATE;
    const outTotal = Math.floor(total / ratio);
    const BLOCK = RATE * 2; // 2 s of output per chunk
    for (let o = 0; o < outTotal; o += BLOCK) {
      const n = Math.min(BLOCK, outTotal - o);
      const s0 = Math.floor(o * ratio) - 2, need = Math.ceil(n * ratio) + 6;
      const pcm = await a.read(s0, need);
      const out = new Float32Array(n * ch);
      for (let i = 0; i < n; i++) {
        const pos = (o + i) * ratio - s0, k = Math.floor(pos), f = pos - k;
        for (let c = 0; c < ch; c++) {
          const x = pcm[Math.min(c, pcm.length - 1)];
          const p0 = x[k - 1] ?? x[k] ?? 0, p1 = x[k] ?? 0, p2 = x[k + 1] ?? p1, p3 = x[k + 2] ?? p2;
          out[i * ch + c] = ratio === 1 ? p1 : p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
        }
      }
      self.postMessage({ type: 'chunk', data: new Uint8Array(out.buffer), progress: (o + n) / outTotal }, [out.buffer]);
    }
    a.close();
    self.postMessage({ type: 'end' });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
