// Clap markers: finds "clap, clap, clap" in a recording's sound, the signal some people make while
// recording to say "cut here" (like a film slate). A clap is a very short, sharp burst: it jumps up
// within a few milliseconds and dies away within about a tenth of a second, which speech, music and
// typing rarely do three times in a row at an even pace.
//
// Works as a stream (push blocks of mono samples, then finish()), so an hour of sound needs only a
// little memory, not the whole file.

const HOP_S = 0.005;      // 5 ms analysis steps
const LOOK = 16;          // steps after an onset to judge its decay (80 ms)

export const CLAP_DEFAULTS = {
  count: 3,               // claps in a signal
  minGap: 0.1,            // seconds between claps
  maxGap: 0.75,
  evenness: 2.0,          // the longest gap may be at most this many times the shortest
  rise: 5,                // an onset is this many times louder than the 30 ms before it
  decay: 0.3,             // 50–80 ms later it has fallen to this fraction of its peak
  floor: 0.01,            // ignore anything quieter than this (RMS of the sharpened signal)
  relative: 0.12,         // and anything quieter than this fraction of the loudest onset found
};

export class ClapDetector {
  constructor(sampleRate, opts = {}) {
    this.rate = sampleRate;
    this.o = { ...CLAP_DEFAULTS, ...opts };
    this.hop = Math.max(16, Math.round(sampleRate * HOP_S));
    this.acc = 0; this.n = 0; this.prev = 0; this.hopIndex = 0;
    this.env = [];          // hop RMS values still needed (env[0] is hop number `base`)
    this.base = 0;
    this.pending = [];      // candidate onsets waiting to see how they decay
    this.onsets = [];       // { t, s } accepted sharp transients
  }

  /** Feed mono samples (any length). */
  push(x) {
    const hop = this.hop;
    for (let i = 0; i < x.length; i++) {
      const v = x[i], d = v - this.prev; // first difference: sharpens transients, drops rumble and hum
      this.prev = v;
      this.acc += d * d;
      if (++this.n === hop) { this._hop(Math.sqrt(this.acc / hop)); this.acc = 0; this.n = 0; }
    }
  }

  _hop(r) {
    const i = this.hopIndex++;
    this.env.push(r);
    const at = k => this.env[k - this.base] || 0;
    // a candidate: much louder than the 30 ms before it
    if (i >= 8) {
      let before = 0;
      for (let k = 2; k <= 6; k++) before = Math.max(before, at(i - k));
      if (r > this.o.floor && r > before * this.o.rise) {
        const last = this.pending[this.pending.length - 1];
        if (!last || i - last.i > 4) this.pending.push({ i, peak: r });
      }
    }
    // a clap can take a step or two to top out: keep the peak of its first 15 ms
    for (const p of this.pending) if (i - p.i <= 3 && r > p.peak) p.peak = r;
    // judge candidates whose look-ahead is complete: a clap has died away 50–80 ms later
    while (this.pending.length && i - this.pending[0].i >= LOOK) {
      const p = this.pending.shift();
      let tail = 0;
      for (let k = 10; k <= LOOK; k++) tail = Math.max(tail, at(p.i + k));
      if (tail <= p.peak * this.o.decay) this.onsets.push({ t: (p.i * this.hop) / this.rate, s: p.peak });
    }
    // drop history nobody needs any more
    const need = (this.pending.length ? this.pending[0].i : i) - 8;
    if (need - this.base > 4096) { this.env.splice(0, need - this.base); this.base = need; }
  }

  /** All clap signals: [{ t0, t1, claps: [times] }] in seconds from the start of what was pushed. */
  finish() {
    const o = this.o;
    const loud = this.onsets.reduce((m, x) => Math.max(m, x.s), 0);
    const on = this.onsets.filter(x => x.s >= loud * o.relative);
    const out = [];
    for (let i = 0; i + o.count <= on.length; i++) {
      const run = on.slice(i, i + o.count);
      const gaps = run.slice(1).map((x, k) => x.t - run[k].t);
      if (gaps.some(g => g < o.minGap || g > o.maxGap)) continue;
      if (Math.max(...gaps) > Math.min(...gaps) * o.evenness) continue;
      // nothing else sharp right before or after: a burst of typing or a drum fill isn't a signal
      const prev = on[i - 1], next = on[i + o.count], gap = Math.max(...gaps);
      if (prev && run[0].t - prev.t < gap * 1.6) continue;
      if (next && next.t - run[o.count - 1].t < gap * 1.6) continue;
      // the claps sound alike (within 3×)
      const s = run.map(x => x.s);
      if (Math.max(...s) > Math.min(...s) * 3) continue;
      out.push({ t0: run[0].t, t1: run[o.count - 1].t + 0.15, claps: run.map(x => x.t) });
      i += o.count - 1;
    }
    return out;
  }
}

/** One-shot helper for a whole buffer already in memory. */
export function findClaps(samples, rate, opts) {
  const d = new ClapDetector(rate, opts);
  d.push(samples);
  return d.finish();
}
