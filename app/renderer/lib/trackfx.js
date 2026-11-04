// Track effects: the plug-in slots on a timeline track (EQ, compressor, de-esser, gate, reverb, delay,
// limiter, gain). Plain JavaScript DSP so the very same code runs in the preview (an AudioWorklet) and in the
// export, and what you hear is what you get. Each effect keeps its state between blocks.

export const FX_TYPES = {
  eq: { name: 'EQ', defaults: { hpf: 20, lf: 0, lfF: 100, lmf: 0, lmfF: 400, hmf: 0, hmfF: 2500, hf: 0, hfF: 10000 } },
  comp: { name: 'Compressor', defaults: { threshold: -18, ratio: 3, attack: 10, release: 120, makeup: 0 } },
  deess: { name: 'De-esser', defaults: { threshold: -28, freq: 6000, amount: 6 } },
  gate: { name: 'Noise gate', defaults: { threshold: -50, range: 30, attack: 2, release: 120 } },
  reverb: { name: 'Reverb', defaults: { size: 0.6, damp: 0.4, mix: 0.2, width: 1 } },
  delay: { name: 'Delay', defaults: { time: 350, feedback: 0.3, mix: 0.2 } },
  limiter: { name: 'Limiter', defaults: { ceiling: -1, release: 80 } },
  level: { name: 'Auto Level', defaults: { target: -20, boost: 12, cut: 12, speed: 1500, gate: -50 } },
  gain: { name: 'Gain', defaults: { db: 0, invert: false, mono: false } },
  declick: { name: 'De-click', defaults: { sensitivity: 5, length: 0.6 } },
};
export const FX_PARAMS = {
  eq: [['hpf', 'High-pass', 20, 400, 'Hz', true], ['lf', 'Low', -15, 15, 'dB'], ['lmf', 'Low-mid', -15, 15, 'dB'], ['lmfF', 'Low-mid freq', 100, 2000, 'Hz', true],
    ['hmf', 'High-mid', -15, 15, 'dB'], ['hmfF', 'High-mid freq', 600, 8000, 'Hz', true], ['hf', 'High', -15, 15, 'dB']],
  comp: [['threshold', 'Threshold', -60, 0, 'dB'], ['ratio', 'Ratio', 1, 20, ':1'], ['attack', 'Attack', 0.5, 100, 'ms', true], ['release', 'Release', 10, 1000, 'ms', true], ['makeup', 'Make-up', 0, 24, 'dB']],
  deess: [['threshold', 'Threshold', -60, 0, 'dB'], ['freq', 'Frequency', 3000, 10000, 'Hz', true], ['amount', 'Max cut', 0, 18, 'dB']],
  gate: [['threshold', 'Threshold', -80, -10, 'dB'], ['range', 'Range', 0, 80, 'dB'], ['attack', 'Attack', 0.5, 50, 'ms', true], ['release', 'Release', 10, 1000, 'ms', true]],
  reverb: [['size', 'Room size', 0, 1, ''], ['damp', 'Damping', 0, 1, ''], ['mix', 'Mix', 0, 1, ''], ['width', 'Width', 0, 1, '']],
  delay: [['time', 'Time', 20, 1500, 'ms', true], ['feedback', 'Feedback', 0, 0.9, ''], ['mix', 'Mix', 0, 1, '']],
  limiter: [['ceiling', 'Ceiling', -12, 0, 'dB'], ['release', 'Release', 10, 500, 'ms', true]],
  level: [['target', 'Target level', -32, -10, 'dB'], ['boost', 'Most it turns up', 0, 24, 'dB'], ['cut', 'Most it turns down', 0, 24, 'dB'], ['speed', 'Speed (slower = smoother)', 200, 5000, 'ms', true], ['gate', 'Ignore below', -70, -30, 'dB']],
  gain: [['db', 'Gain', -24, 24, 'dB']],
  declick: [['sensitivity', 'Sensitivity', 1, 10, ''], ['length', 'Longest click', 0.2, 0.8, 'ms']],
};
// presets per effect, for the slot menu
export const FX_PRESETS = {
  eq: { 'Voice — clarity': { hpf: 80, lf: -2, lmf: -3, lmfF: 300, hmf: 2, hmfF: 3000, hf: 3 }, 'Voice — warm': { hpf: 70, lf: 2, lmf: -1, hmf: 1, hf: -1 }, 'Remove rumble': { hpf: 100 }, 'Telephone': { hpf: 400, lf: -15, hf: -15, hmf: 6, hmfF: 1500 }, 'Music bed — under voice': { hmf: -4, hmfF: 2500, lmf: -2 } },
  comp: { 'Voice — gentle': { threshold: -20, ratio: 2.5, attack: 12, release: 150, makeup: 3 }, 'Voice — podcast': { threshold: -24, ratio: 4, attack: 5, release: 100, makeup: 6 }, 'Music glue': { threshold: -14, ratio: 2, attack: 30, release: 200, makeup: 2 } },
  reverb: { 'Small room': { size: 0.35, damp: 0.5, mix: 0.12 }, 'Hall': { size: 0.85, damp: 0.3, mix: 0.25 }, 'Plate': { size: 0.6, damp: 0.15, mix: 0.2 } },
  level: { 'Voice — even': { target: -20, boost: 12, cut: 12, speed: 1500 }, 'Podcast — tight': { target: -18, boost: 15, cut: 12, speed: 700 }, 'Music — gentle': { target: -22, boost: 6, cut: 8, speed: 3000 } },
  declick: { 'Mouth clicks (voice)': { sensitivity: 5, length: 0.5 }, 'Pops & crackle': { sensitivity: 7, length: 0.8 }, 'Gentle': { sensitivity: 3, length: 0.4 } },
  delay: { 'Slapback': { time: 110, feedback: 0.1, mix: 0.18 }, 'Echo': { time: 380, feedback: 0.35, mix: 0.22 } },
};

const dbg = d => 10 ** (d / 20);
const coef = (ms, rate) => Math.exp(-1 / Math.max(1, (ms / 1000) * rate));

/** RBJ biquad, one per channel. kind: 'hp', 'ls', 'hs', 'pk', 'bp'. */
class Biquad {
  constructor() { this.set('pk', 1000, 0, 0.7, 48000); this.z = [[0, 0], [0, 0]]; }
  set(kind, f, db, q, rate) {
    const w = 2 * Math.PI * Math.min(f, rate * 0.45) / rate, cw = Math.cos(w), sw = Math.sin(w), A = 10 ** (db / 40), al = sw / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    if (kind === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else if (kind === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else if (kind === 'ls' || kind === 'hs') {
      const s = kind === 'ls' ? 1 : -1, sa = 2 * Math.sqrt(A) * al;
      b0 = A * ((A + 1) - s * (A - 1) * cw + sa); b1 = s * 2 * A * ((A - 1) - s * (A + 1) * cw); b2 = A * ((A + 1) - s * (A - 1) * cw - sa);
      a0 = (A + 1) + s * (A - 1) * cw + sa; a1 = -s * 2 * ((A - 1) + s * (A + 1) * cw); a2 = (A + 1) + s * (A - 1) * cw - sa;
    } else { b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; }
    this.b = [b0 / a0, b1 / a0, b2 / a0]; this.a = [a1 / a0, a2 / a0];
    this.flat = kind !== 'hp' && kind !== 'bp' && Math.abs(db) < 0.01;
  }
  run(x, ch) {
    const z = this.z[ch], [b0, b1, b2] = this.b, [a1, a2] = this.a;
    for (let i = 0; i < x.length; i++) { const v = x[i], y = b0 * v + z[0]; z[0] = b1 * v - a1 * y + z[1]; z[1] = b2 * v - a2 * y; x[i] = y; }
  }
}

class EQ {
  constructor(rate) { this.rate = rate; this.f = [new Biquad(), new Biquad(), new Biquad(), new Biquad(), new Biquad()]; }
  update(p) {
    const r = this.rate, [hp, lf, lm, hm, hf] = this.f;
    this.hpOn = p.hpf > 21; hp.set('hp', p.hpf, 0, 0.707, r);
    lf.set('ls', p.lfF || 100, p.lf || 0, 0.7, r); lm.set('pk', p.lmfF || 400, p.lmf || 0, 1, r);
    hm.set('pk', p.hmfF || 2500, p.hmf || 0, 1, r); hf.set('hs', p.hfF || 10000, p.hf || 0, 0.7, r);
  }
  process(L, R) { for (const [k, f] of this.f.entries()) { if (k === 0 ? !this.hpOn : f.flat) continue; f.run(L, 0); f.run(R, 1); } }
}

/** Feed-forward compressor with a soft knee, linked stereo. */
class Comp {
  constructor(rate) { this.rate = rate; this.env = 0; }
  update(p) { this.p = p; this.at = coef(p.attack, this.rate); this.rel = coef(p.release, this.rate); this.mk = dbg(p.makeup || 0); this.gr = 0; }
  process(L, R) {
    const { threshold: T, ratio: Rt } = this.p, at = this.at, rel = this.rel, knee = 6;
    let env = this.env, gr = 0;
    for (let i = 0; i < L.length; i++) {
      const x = Math.max(Math.abs(L[i]), Math.abs(R[i])), xd = 20 * Math.log10(x + 1e-9);
      const over = xd - T;
      const want = over <= -knee / 2 ? 0 : over >= knee / 2 ? over * (1 - 1 / Rt) : ((over + knee / 2) ** 2 / (2 * knee)) * (1 - 1 / Rt);
      env = want > env ? at * env + (1 - at) * want : rel * env + (1 - rel) * want;
      const g = dbg(-env) * this.mk;
      L[i] *= g; R[i] *= g; if (env > gr) gr = env;
    }
    this.env = env; this.gr = gr;
  }
}

/** Gain riding on a sibilance band: the whole signal dips while "s" sounds are loud. */
class DeEss {
  constructor(rate) { this.rate = rate; this.bp = new Biquad(); this.env = 0; this.tmp = new Float32Array(0); }
  update(p) { this.p = p; this.bp.set('bp', p.freq, 0, 1.4, this.rate); this.at = coef(1, this.rate); this.rel = coef(60, this.rate); }
  process(L, R) {
    if (this.tmp.length < L.length) this.tmp = new Float32Array(L.length);
    const s = this.tmp; for (let i = 0; i < L.length; i++) s[i] = (L[i] + R[i]) / 2;
    this.bp.run(s.subarray(0, L.length), 0);
    let env = this.env; const T = this.p.threshold, max = this.p.amount;
    for (let i = 0; i < L.length; i++) {
      const lv = 20 * Math.log10(Math.abs(s[i]) + 1e-9), want = Math.min(max, Math.max(0, lv - T) * 0.7);
      env = want > env ? this.at * env + (1 - this.at) * want : this.rel * env + (1 - this.rel) * want;
      const g = dbg(-env); L[i] *= g; R[i] *= g;
    }
    this.env = env;
  }
}

class Gate {
  constructor(rate) { this.rate = rate; this.g = 1; this.lv = 0; }
  update(p) { this.p = p; this.at = coef(p.attack, this.rate); this.rel = coef(p.release, this.rate); this.floor = dbg(-p.range); this.lvc = coef(5, this.rate); this.thr = dbg(p.threshold); }
  process(L, R) {
    let g = this.g, lv = this.lv;
    for (let i = 0; i < L.length; i++) {
      const x = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      lv = x > lv ? x : this.lvc * lv + (1 - this.lvc) * x;
      const want = lv >= this.thr ? 1 : this.floor;
      g = want > g ? this.at * g + (1 - this.at) * want : this.rel * g + (1 - this.rel) * want;
      L[i] *= g; R[i] *= g;
    }
    this.g = g; this.lv = lv;
  }
}

/** Freeverb-style: 8 damped combs and 4 all-passes per side. */
class Reverb {
  constructor(rate) {
    const sc = rate / 44100, CB = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], AP = [556, 441, 341, 225], SP = 23;
    const mk = (n, off) => ({ buf: new Float32Array(Math.round((n + off) * sc)), i: 0, store: 0 });
    this.c = [CB.map(n => mk(n, 0)), CB.map(n => mk(n, SP))];
    this.a = [AP.map(n => mk(n, 0)), AP.map(n => mk(n, SP))];
  }
  update(p) { this.p = p; this.fb = 0.7 + 0.28 * p.size; this.damp = p.damp * 0.4; }
  process(L, R) {
    const { mix, width = 1 } = this.p, fb = this.fb, d = this.damp, w1 = (1 + width) / 2, w2 = (1 - width) / 2;
    for (let i = 0; i < L.length; i++) {
      const inp = (L[i] + R[i]) * 0.015, out = [0, 0];
      for (let ch = 0; ch < 2; ch++) {
        let s = 0;
        for (const c of this.c[ch]) { const y = c.buf[c.i]; c.store = y * (1 - d) + c.store * d; c.buf[c.i] = inp + c.store * fb; if (++c.i >= c.buf.length) c.i = 0; s += y; }
        for (const a of this.a[ch]) { const y = a.buf[a.i]; const o = -s + y; a.buf[a.i] = s + y * 0.5; if (++a.i >= a.buf.length) a.i = 0; s = o; }
        out[ch] = s;
      }
      const wl = out[0] * w1 + out[1] * w2, wr = out[1] * w1 + out[0] * w2;
      L[i] = L[i] * (1 - mix * 0.5) + wl * mix * 3; R[i] = R[i] * (1 - mix * 0.5) + wr * mix * 3;
    }
  }
}

class Delay {
  constructor(rate) { this.rate = rate; this.buf = [new Float32Array(Math.ceil(rate * 1.6)), new Float32Array(Math.ceil(rate * 1.6))]; this.i = 0; this.lp = [0, 0]; }
  update(p) { this.p = p; this.n = Math.max(1, Math.min(this.buf[0].length - 1, Math.round((p.time / 1000) * this.rate))); }
  process(L, R) {
    const { feedback: fb, mix } = this.p, N = this.buf[0].length, n = this.n;
    for (let k = 0; k < L.length; k++) {
      const j = (this.i - n + N) % N;
      for (let ch = 0; ch < 2; ch++) {
        const x = ch ? R : L, b = this.buf[ch], y = b[j];
        this.lp[ch] = this.lp[ch] * 0.3 + y * 0.7; // echoes get a little darker each time
        b[this.i] = x[k] + this.lp[ch] * fb;
        x[k] = x[k] + y * mix;
      }
      if (++this.i >= N) this.i = 0;
    }
  }
}

/** Look-ahead-free brick-wall limiter with smooth release. */
class Limiter {
  constructor(rate) { this.rate = rate; this.g = 1; }
  update(p) { this.ceil = dbg(p.ceiling); this.rel = coef(p.release, this.rate); }
  process(L, R) {
    let g = this.g;
    for (let i = 0; i < L.length; i++) {
      const x = Math.max(Math.abs(L[i]), Math.abs(R[i])), want = x * g > this.ceil ? this.ceil / x : 1;
      g = want < g ? want : this.rel * g + (1 - this.rel) * Math.min(1, want);
      L[i] *= g; R[i] *= g;
    }
    this.g = g;
  }
}

/**
 * Auto Level: rides the volume like an engineer on a fader. It measures how loud the sound is over the last
 * ~0.3 s and slowly turns it toward the target (never more than `boost` up or `cut` down). Below `gate` it
 * holds still, so silence and room noise between sentences aren't pumped up.
 */
class Leveler {
  constructor(rate) { this.rate = rate; this.env = 0; this.gdb = 0; this.prev = -120; this.ms = coef(300, rate); }
  update(p) { this.target = p.target; this.boost = p.boost; this.cut = p.cut; this.gate = p.gate; this.k = Math.exp(-64 / Math.max(1, (p.speed / 1000) * this.rate)); }
  process(L, R) {
    const n = L.length, a = this.ms;
    let env = this.env, gdb = this.gdb;
    for (let s = 0; s < n; s += 64) {
      const e = Math.min(n, s + 64);
      for (let i = s; i < e; i++) { const x = (L[i] * L[i] + R[i] * R[i]) * 0.5; env = a * env + (1 - a) * x; }
      const lev = 10 * Math.log10(env + 1e-12), falling = lev < this.prev - 0.004;
      this.prev = lev;
      // a sound dying away isn't quiet speech: hold still while it falls, so the gaps after loud parts stay quiet
      if (lev > this.gate && !falling) {
        const want = Math.max(-this.cut, Math.min(this.boost, this.target - lev));
        gdb = this.k * gdb + (1 - this.k) * want;
      }
      const g = 10 ** (gdb / 20);
      for (let i = s; i < e; i++) { L[i] *= g; R[i] *= g; }
    }
    this.env = env; this.gdb = gdb;
  }
}

class Gain {
  update(p) { this.g = dbg(p.db || 0) * (p.invert ? -1 : 1); this.mono = !!p.mono; }
  process(L, R) { for (let i = 0; i < L.length; i++) { if (this.mono) { const m = (L[i] + R[i]) / 2; L[i] = m; R[i] = m; } L[i] *= this.g; R[i] *= this.g; } }
}

/**
 * De-click: finds clicks and pops (mouth clicks, plug-pops, crackle) as sudden spikes in how sharply the sound bends,
 * far above its recent average, and draws the sound smoothly across them. It listens about 1.3 ms ahead, so the
 * track is that much late: far less than a video frame.
 */
class DeClick {
  constructor(rate) {
    this.rate = rate; this.D = 64; this.N = 4096;
    this.bL = new Float32Array(this.N); this.bR = new Float32Array(this.N);
    this.w = 0; this.env = 1e-4; this.x1 = 0; this.x2 = 0; this.regions = [];
  }
  update(p) {
    const sens = Math.max(1, Math.min(10, p.sensitivity ?? 5));
    this.thr = 4 + (10 - sens) * 1.6;
    this.len = Math.max(4, Math.min(40, Math.round(((p.length ?? 0.6) / 1000) * this.rate)));
  }
  process(L, R) {
    const N = this.N, M = N - 1, D = this.D, bL = this.bL, bR = this.bR;
    for (let i = 0; i < L.length; i++) {
      const w = this.w;
      bL[w & M] = L[i]; bR[w & M] = R[i];
      const x = (L[i] + R[i]) * 0.5, d = Math.abs(x - 2 * this.x1 + this.x2);
      this.x2 = this.x1; this.x1 = x;
      if (d > this.thr * this.env && d > 2e-3) {
        const s = w - 3, e = w + this.len, last = this.regions[this.regions.length - 1];
        if (last && s <= last.e + 2) last.e = Math.min(Math.max(last.e, e), last.s + 50); else this.regions.push({ s, e });
      }
      // the average follows the sound but isn't dragged up by the clicks themselves
      this.env = this.env * 0.998 + Math.min(d, this.thr * this.env + 1e-4) * 0.002;
      this.w = w + 1;
      // out: the sample from D ago, repaired if it's inside a click
      const o = w - D;
      if (o < 0) { L[i] = 0; R[i] = 0; continue; }
      while (this.regions.length && this.regions[0].e < o) this.regions.shift();
      const r = this.regions[0];
      if (r && o >= r.s) {
        const a = r.s - 1, b = Math.min(r.e + 1, w);
        const t = b > a ? (o - a) / (b - a) : 0;
        L[i] = bL[a & M] * (1 - t) + bL[b & M] * t; R[i] = bR[a & M] * (1 - t) + bR[b & M] * t;
        // the repaired value is what comes "before" the next one
        bL[o & M] = L[i]; bR[o & M] = R[i];
      } else { L[i] = bL[o & M]; R[i] = bR[o & M]; }
    }
  }
}

const CLASSES = { eq: EQ, comp: Comp, deess: DeEss, gate: Gate, reverb: Reverb, delay: Delay, limiter: Limiter, gain: Gain, level: Leveler, declick: DeClick };

/** A track's effect chain. setup(list) keeps the state of effects that stay; process(L, R) in place. */
export class FxChain {
  constructor(rate) { this.rate = rate; this.units = []; }
  setup(list = []) {
    const old = this.units;
    this.units = list.filter(f => f && CLASSES[f.type]).map((f, i) => {
      const keep = old.find(u => u.id === (f.id || i) && u.type === f.type);
      const u = keep || { id: f.id || i, type: f.type, fx: new CLASSES[f.type](this.rate) };
      u.off = !!f.off;
      u.fx.update({ ...FX_TYPES[f.type].defaults, ...(f.params || {}) });
      return u;
    });
    return this;
  }
  get active() { return this.units.some(u => !u.off); }
  process(L, R) { for (const u of this.units) if (!u.off) u.fx.process(L, R); }
}
