// Loudness profile of a media file's sound for AUTO MIX: the K-weighted mean square of every 100 ms
// (ITU-R BS.1770, the same weighting as the export's loudness meter), off the main thread.
import { openAudio } from './lib/sources.js';
import { Biquad } from './lib/master.js';

self.onmessage = async e => {
  const { id, url, file } = e.data;
  try {
    const a = await openAudio(url, file);
    if (!a) return self.postMessage({ id, profile: null });
    const rate = a.rate, step = Math.round(rate * 0.1);
    const total = a.frames ?? Math.ceil((a.track ? a.track.duration : 0) * rate);
    const ch = Math.min(2, a.channels || 1);
    const filters = [];
    for (let k = 0; k < ch; k++) {
      const pre = new Biquad(), rlb = new Biquad();
      pre.set('highshelf', 1681.97, 0.7072, 3.9998, rate); rlb.set('highpass', 38.135, 0.5003, 0, rate);
      filters.push([pre, rlb]);
    }
    const steps = new Float32Array(Math.ceil(total / step));
    let acc = 0, count = 0, k = 0;
    const CH = step * 300;
    for (let start = 0; start < total; start += CH) {
      const pcm = await a.read(start, Math.min(CH, total - start));
      const len = pcm[0].length;
      const w = [];
      for (let c = 0; c < ch; c++) { const x = Float32Array.from(pcm[c] || pcm[0]); filters[c][0].run(x, 0); filters[c][1].run(x, 0); w.push(x); }
      for (let i = 0; i < len; i++) {
        let s = 0;
        for (let c = 0; c < ch; c++) s += w[c][i] * w[c][i];
        acc += s;
        if (++count === step) { if (k < steps.length) steps[k++] = acc / step; acc = 0; count = 0; }
      }
    }
    if (count && k < steps.length) steps[k++] = acc / count;
    a.close();
    self.postMessage({ id, profile: { step: 0.1, steps } }, [steps.buffer]);
  } catch (err) {
    self.postMessage({ id, profile: null, error: String(err?.message || err) });
  }
};
