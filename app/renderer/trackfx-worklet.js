// Plays a timeline track's effect chain live (the same DSP the export uses), and reports its level.
import { FxChain } from './lib/trackfx.js';

class TrackFx extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chain = new FxChain(sampleRate);
    this.L = new Float32Array(128); this.R = new Float32Array(128);
    this.peak = [0, 0]; this.n = 0;
    this.port.onmessage = e => { if (e.data && e.data.fx) this.chain.setup(e.data.fx); };
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    const n = out[0].length;
    if (this.L.length < n) { this.L = new Float32Array(n); this.R = new Float32Array(n); }
    const L = this.L.subarray(0, n), R = this.R.subarray(0, n);
    if (inp && inp.length) { L.set(inp[0]); R.set(inp[1] || inp[0]); } else { L.fill(0); R.fill(0); }
    this.chain.process(L, R);
    out[0].set(L); if (out[1]) out[1].set(R);
    for (let i = 0; i < n; i++) { const a = Math.abs(L[i]), b = Math.abs(R[i]); if (a > this.peak[0]) this.peak[0] = a; if (b > this.peak[1]) this.peak[1] = b; }
    if ((this.n += n) >= sampleRate / 20) { this.port.postMessage({ peak: this.peak }); this.peak = [0, 0]; this.n = 0; }
    return true;
  }
}
registerProcessor('track-fx', TrackFx);
