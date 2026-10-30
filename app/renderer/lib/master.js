// Built-in mastering for ProtoArt Reel ("Master" stage at export), laid out like a classic
// transfer-console chain: Input → Tone → Compressor/Limiter → Filters → Output, plus loudness
// measurement (ITU-R BS.1770 / EBU R128) and a true-peak limiter for streaming targets.
// Original DSP written for Reel; control ranges follow the console conventions it imitates.
import { pref } from '../prefs.js';

const TAU = Math.PI * 2;
const dbToGain = db => Math.pow(10, db / 20);

// ------------------------------------------------------------------ biquads (RBJ cookbook)
export class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z = [[0, 0], [0, 0]]; }
  set(type, f, q, gainDb, rate) {
    f = Math.min(f, rate * 0.45);
    const A = Math.pow(10, gainDb / 40), w = (TAU * f) / rate, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'peak': b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A; break;
      case 'lowshelf': { const s = 2 * Math.sqrt(A) * al;
        b0 = A * ((A + 1) - (A - 1) * cs + s); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - s);
        a0 = (A + 1) + (A - 1) * cs + s; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - s; break; }
      case 'highshelf': { const s = 2 * Math.sqrt(A) * al;
        b0 = A * ((A + 1) + (A - 1) * cs + s); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - s);
        a0 = (A + 1) - (A - 1) * cs + s; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - s; break; }
      case 'highpass': b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
      case 'lowpass': b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
      default: b0 = 1; b1 = 0; b2 = 0; a0 = 1; a1 = 0; a2 = 0;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  /** Transposed direct form II, in place, channel c. */
  run(x, c) {
    const z = this.z[c], { b0, b1, b2, a1, a2 } = this;
    let z0 = z[0], z1 = z[1];
    for (let i = 0; i < x.length; i++) { const v = x[i], y = b0 * v + z0; z0 = b1 * v - a1 * y + z1; z1 = b2 * v - a2 * y; x[i] = y; }
    z[0] = z0; z[1] = z1;
  }
}

// ------------------------------------------------------------------ settings

export const TONE_FREQS = [[32, 45, 64, 91, 128], [181, 256, 362, 512, 724], [1020, 1450, 2050, 2600, 3250], [4100, 5800, 8100, 11000, 16000]];
export const TONE_SHAPES = ['low', 'blunt', 'medium', 'sharp', 'high'];
export const PRESENCE_FREQS = [500, 800, 1200, 1800, 2800, 4200, 6500, 10000];
export const HP_FREQS = [0, 40, 63, 80, 110];
export const LP_FREQS = [0, 20000, 15000, 12000, 10000, 8000];
export const LOUDNESS_TARGETS = { off: null, youtube: -14, spotify: -14, apple: -16, podcast: -16, broadcast: -23 };

export function defaultMaster() {
  return {
    on: false, order: ['tone', 'comp', 'filter'],
    input: { gain: 0, tape: 'flat', polarityL: false, polarityR: false, swap: false, balance: 0 },
    tone: { on: true, bands: [{ on: true, f: 1, shape: 'low', gain: 0 }, { on: true, f: 2, shape: 'medium', gain: 0 }, { on: true, f: 2, shape: 'medium', gain: 0 }, { on: true, f: 2, shape: 'high', gain: 0 }] },
    comp: { on: true, type: 'modern', recovery: 3, ratio: 35, makeup: 0, mix: 0.45, scHp: 150 },
    filter: { on: true, hp: 0, presenceF: 4, presence: 0, lp: 0 },
    output: { spread: 0, gain: 0 },
    loudness: pref('loudness') || 'youtube', ceiling: -1,
  };
}

export const MASTER_PRESETS = {
  'Gentle polish': m => { m.tone.bands[0].gain = 1; m.tone.bands[3].gain = 1.5; m.comp.ratio = 25; m.comp.mix = 0.35; },
  'Voice & podcast': m => { m.filter.hp = 2; m.tone.bands[1] = { on: true, f: 1, shape: 'blunt', gain: -1.5 }; m.filter.presenceF = 4; m.filter.presence = 2; m.comp.ratio = 45; m.comp.mix = 0.6; m.comp.recovery = 3; m.loudness = 'podcast'; },
  'Loud & punchy': m => { m.tone.bands[0].gain = 2; m.tone.bands[3] = { on: true, f: 2, shape: 'high', gain: 2 }; m.comp.ratio = 60; m.comp.mix = 0.6; m.comp.recovery = 2; m.output.spread = 1; },
  'Vintage warmth': m => { m.comp.type = 'original'; m.comp.ratio = 40; m.comp.mix = 0.5; m.input.tape = 'nab-iec-15'; m.filter.lp = 2; m.tone.bands[0].gain = 1.5; },
  'Music video': m => { m.tone.bands[0].gain = 1.5; m.tone.bands[3].gain = 2; m.comp.ratio = 40; m.comp.mix = 0.45; m.output.spread = 1.5; m.loudness = 'spotify'; },
};

// ------------------------------------------------------------------ chain

const RECOVERY = { // [attack ms, release ms] per recovery step
  original: [[0.5, 60], [1, 120], [2, 250], [4, 500], [8, 900], [15, 1800]],
  modern: [[1, 50], [3, 100], [6, 200], [10, 400], [20, 800], [30, 1500]],
  limit: [[0.2, 40], [0.5, 80], [1, 160], [2, 320], [4, 640], [8, 1200]],
};

export class MasterChain {
  constructor(settings, rate = 48000) { this.rate = rate; this.update(settings); this.env = 0; }
  update(s) {
    this.s = s;
    const r = this.rate;
    // input tape equalisation (NAB <-> IEC playback curve differences, as gentle shelves)
    const tape = { flat: [0, 0], 'nab-iec-75': [3, -2], 'nab-iec-15': [2, -1], 'iec-nab-15': [-2, 1], 'iec-nab-75': [-3, 2] }[s.input.tape] || [0, 0];
    this.tapeLo = new Biquad().set('lowshelf', 100, 0.7, tape[0], r);
    this.tapeHi = new Biquad().set('highshelf', 6000, 0.7, tape[1], r);
    this.toneF = s.tone.bands.map((b, i) => {
      const f = TONE_FREQS[i][Math.max(0, Math.min(4, b.f))];
      const shape = b.shape;
      const type = shape === 'low' ? 'lowshelf' : shape === 'high' ? 'highshelf' : 'peak';
      const q = shape === 'blunt' ? 0.45 : shape === 'medium' ? 0.9 : shape === 'sharp' ? 2.8 : 0.7;
      return { on: b.on && Math.abs(b.gain) > 0.01, f: new Biquad().set(type, f, q, b.gain, r) };
    });
    const hp = HP_FREQS[s.filter.hp] || 0, lp = LP_FREQS[s.filter.lp] || 0;
    this.hp = hp ? [new Biquad().set('highpass', hp, 0.54, 0, r), new Biquad().set('highpass', hp, 1.31, 0, r)] : null; // 24 dB/oct Butterworth
    this.lp = lp ? [new Biquad().set('lowpass', lp, 0.54, 0, r), new Biquad().set('lowpass', lp, 1.31, 0, r)] : null;
    this.pres = Math.abs(s.filter.presence) > 0.01 ? new Biquad().set('peak', PRESENCE_FREQS[s.filter.presenceF] || 2800, 0.9, s.filter.presence, r) : null;
    this.scHp = s.comp.scHp ? [new Biquad().set('highpass', s.comp.scHp, 0.71, 0, r)] : null;
    const [atk, rel] = (RECOVERY[s.comp.type] || RECOVERY.modern)[Math.max(0, Math.min(5, (s.comp.recovery || 3) - 1))];
    this.atk = Math.exp(-1 / (atk * 0.001 * r)); this.rel = Math.exp(-1 / (rel * 0.001 * r));
    this.gr = 0; this.lastGr = 0;
  }

  /** Gain reduction curve in dB for a detector level (dBFS). */
  curve(lv) {
    const c = this.s.comp, k = Math.max(1, Math.min(100, c.ratio)) / 100;
    let gr = 0;
    if (c.type === 'limit') { const T = -14; if (lv > T) gr = (lv - T) * 0.95; }
    else if (c.type === 'original') { const T = -26, knee = 12; // soft, program-dependent "Zener" style
      if (lv > T - knee / 2) { const o = lv - (T - knee / 2); gr = o < knee ? (o * o) / (2 * knee) * 0.66 : (o - knee / 2) * 0.66; } }
    else { const T = -30, knee = 18; // modern: low-level compression for loudness without pumping
      if (lv > T - knee / 2) { const o = lv - (T - knee / 2); gr = o < knee ? (o * o) / (2 * knee) * 0.5 : (o - knee / 2) * 0.5; } }
    return gr * k * 2;
  }

  /** Processes one stereo block in place (Float32Arrays of equal length). */
  process(L, R) {
    const s = this.s, n = L.length;
    // ---- input
    const ig = dbToGain(s.input.gain), bal = s.input.balance;
    const gl = ig * dbToGain(-bal / 2) * (s.input.polarityL ? -1 : 1), gr = ig * dbToGain(bal / 2) * (s.input.polarityR ? -1 : 1);
    if (s.input.swap) for (let i = 0; i < n; i++) { const t = L[i]; L[i] = R[i]; R[i] = t; }
    for (let i = 0; i < n; i++) { L[i] *= gl; R[i] *= gr; }
    if (s.input.tape !== 'flat') { this.tapeLo.run(L, 0); this.tapeLo.run(R, 1); this.tapeHi.run(L, 0); this.tapeHi.run(R, 1); }
    for (const mod of s.order || ['tone', 'comp', 'filter']) {
      if (mod === 'tone' && s.tone.on) for (const b of this.toneF) if (b.on) { b.f.run(L, 0); b.f.run(R, 1); }
      if (mod === 'filter' && s.filter.on) {
        if (this.hp) for (const f of this.hp) { f.run(L, 0); f.run(R, 1); }
        if (this.pres) { this.pres.run(L, 0); this.pres.run(R, 1); }
        if (this.lp) for (const f of this.lp) { f.run(L, 0); f.run(R, 1); }
      }
      if (mod === 'comp' && s.comp.on) this._comp(L, R);
    }
    // ---- output: spreader (mid/side balance) and fader
    const sg = dbToGain(s.output.spread), og = dbToGain(s.output.gain);
    for (let i = 0; i < n; i++) {
      const m = (L[i] + R[i]) * 0.5, d = (L[i] - R[i]) * 0.5 * sg;
      L[i] = (m + d) * og; R[i] = (m - d) * og;
    }
  }

  _comp(L, R) {
    const c = this.s.comp, n = L.length;
    // sidechain: mono sum, optional high-pass so lows don't pump the compressor
    const sc = new Float32Array(n);
    for (let i = 0; i < n; i++) sc[i] = (L[i] + R[i]) * 0.5;
    if (this.scHp) for (const f of this.scHp) f.run(sc, 0);
    const makeAuto = this.curve(-14) * 0.6; // automatic make-up: restore most of what a typical level loses
    const make = dbToGain(makeAuto + (c.makeup || 0));
    const mix = Math.max(0, Math.min(1, c.mix ?? 1));
    const drive = c.type === 'original' ? 1.25 : c.type === 'limit' ? 1.4 : 1;
    let env = this.env, grSum = 0;
    for (let i = 0; i < n; i++) {
      const v = Math.abs(sc[i]);
      env = v > env ? this.atk * env + (1 - this.atk) * v : this.rel * env + (1 - this.rel) * v;
      const lv = 20 * Math.log10(env + 1e-9);
      const g = dbToGain(-this.curve(lv)) * make;
      grSum += this.curve(lv);
      for (const ch of [L, R]) {
        const dry = ch[i];
        let wet = dry * g;
        if (drive > 1) wet = Math.tanh(wet * drive) / drive; // the Zener stages' gentle saturation
        ch[i] = dry * (1 - mix) + wet * mix;
      }
    }
    this.env = env;
    this.lastGr = grSum / n;
  }
}

// ------------------------------------------------------------------ loudness (BS.1770-4)

export class LoudnessMeter {
  constructor(rate = 48000) {
    this.rate = rate;
    // K-weighting: high shelf (+4 dB above ~1.7 kHz) then RLB high-pass (~38 Hz)
    this.pre = [new Biquad(), new Biquad()];
    this.rlb = [new Biquad(), new Biquad()];
    for (const f of this.pre) f.set('highshelf', 1681.97, 0.7072, 3.9998, rate);
    for (const f of this.rlb) f.set('highpass', 38.135, 0.5003, 0, rate);
    if (rate === 48000) { // the exact coefficients published in ITU-R BS.1770
      for (const f of this.pre) Object.assign(f, { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 });
      for (const f of this.rlb) Object.assign(f, { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 });
    }
    this.block = Math.round(rate * 0.1); // 100 ms steps; 400 ms gating blocks = 4 steps
    this.acc = 0; this.count = 0; this.steps = []; this.peak = 0;
  }
  push(L, R) {
    const l = Float32Array.from(L), r = Float32Array.from(R);
    this.pre[0].run(l, 0); this.pre[1].run(r, 1); this.rlb[0].run(l, 0); this.rlb[1].run(r, 1);
    for (let i = 0; i < l.length; i++) {
      this.acc += l[i] * l[i] + r[i] * r[i];
      if (++this.count === this.block) { this.steps.push(this.acc / this.block); this.acc = 0; this.count = 0; }
    }
  }
  /** Integrated loudness in LUFS (gated). */
  integrated() {
    const blocks = [];
    for (let i = 0; i + 4 <= this.steps.length; i++) blocks.push((this.steps[i] + this.steps[i + 1] + this.steps[i + 2] + this.steps[i + 3]) / 4);
    const lufs = z => -0.691 + 10 * Math.log10(z + 1e-12);
    const abs = blocks.filter(z => lufs(z) > -70);
    if (!abs.length) return -Infinity;
    const rel = lufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const g = abs.filter(z => lufs(z) > rel);
    return lufs(g.reduce((a, b) => a + b, 0) / g.length);
  }
}

// ------------------------------------------------------------------ true-peak limiter

/** Look-ahead limiter with 4× oversampled peak detection; holds output under `ceilingDb` dBTP. */
export class TruePeakLimiter {
  constructor(ceilingDb = -1, rate = 48000) {
    this.ceil = dbToGain(ceilingDb);
    this.look = Math.round(rate * 0.0015);
    this.rel = Math.exp(-1 / (0.08 * rate));
    this.bufL = new Float32Array(this.look); this.bufR = new Float32Array(this.look); this.pos = 0;
    this.gain = 1; this.prevL = 0; this.prevR = 0;
    this.hold = new Float32Array(this.look).fill(1); // per-sample gain needs over the look-ahead window
  }
  /** 4× interpolated peak between the previous and current sample (cubic-ish). */
  _tp(prev, cur) {
    let m = Math.abs(cur);
    for (const t of [0.25, 0.5, 0.75]) { const v = prev + (cur - prev) * t; const bulge = Math.abs(v) + Math.abs(cur - prev) * 0.08 * Math.sin(Math.PI * t); if (bulge > m) m = bulge; }
    return m;
  }
  process(L, R) {
    const n = L.length, look = this.look;
    for (let i = 0; i < n; i++) {
      const pk = Math.max(this._tp(this.prevL, L[i]), this._tp(this.prevR, R[i]));
      this.prevL = L[i]; this.prevR = R[i];
      const need = pk > this.ceil ? this.ceil / pk : 1;
      // the gain must already be down when this sample comes out `look` samples later:
      // look at every sample still in the buffer (incl. the one leaving now) and the new one
      let target = need;
      for (let k = 0; k < look; k++) if (this.hold[k] < target) target = this.hold[k];
      this.hold[this.pos] = need;
      this.gain = target < this.gain ? target : this.rel * this.gain + (1 - this.rel) * target;
      const outL = this.bufL[this.pos], outR = this.bufR[this.pos];
      this.bufL[this.pos] = L[i]; this.bufR[this.pos] = R[i];
      this.pos = (this.pos + 1) % look;
      L[i] = outL * this.gain; R[i] = outR * this.gain;
    }
  }
  get latency() { return this.look; }
}
