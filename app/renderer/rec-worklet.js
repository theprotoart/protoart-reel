// Audio capture for recordings: collects raw float samples (interleaved) and hands them to the
// page in ~100 ms blocks. Nothing is resampled or processed.
class RecCapture extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.channels = opts.processorOptions.channels || 1;
    this.block = Math.round(sampleRate / 10);
    this.buf = new Float32Array(this.block * this.channels);
    this.n = 0;
    this.on = false;
    this.level = 0;
    this.port.onmessage = e => {
      if (e.data === 'start') { this.on = true; this.n = 0; this.port.postMessage({ started: currentTime }); }
      if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ stopped: true }); }
    };
  }
  flush() {
    if (!this.n) return;
    const out = this.buf.slice(0, this.n * this.channels);
    this.port.postMessage({ data: out }, [out.buffer]);
    this.n = 0;
  }
  process(inputs) {
    const input = inputs[0];
    const frames = input && input[0] ? input[0].length : 128;
    let peak = 0;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < this.channels; c++) {
        const ch = input && (input[c] || input[0]);
        const v = ch ? ch[i] : 0;
        if (Math.abs(v) > peak) peak = Math.abs(v);
        if (this.on) this.buf[this.n * this.channels + c] = v;
      }
      if (this.on && ++this.n === this.block) this.flush();
    }
    this.level = Math.max(peak, this.level * 0.9);
    if ((currentFrame / 128) % 8 === 0) this.port.postMessage({ level: this.level });
    return true;
  }
}
registerProcessor('rec-capture', RecCapture);
