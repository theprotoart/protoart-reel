// Colour matching: measures the colours of a shot (the average and spread of red, green and blue over a few
// frames, leaving out clipped black and white) and finds, per channel, the scale and shift that make one shot's
// colours sit like a reference shot's. The result is a "match" filter: c × mul + add, run on the graphics chip.

/** Running colour statistics: add frames' RGBA pixels, then read { mean, std, n } (0…1 per channel). */
export class ColorStats {
  constructor() { this.s = [0, 0, 0]; this.q = [0, 0, 0]; this.n = 0; }
  add(rgba) {
    for (let j = 0; j < rgba.length; j += 4) {
      const r = rgba[j] / 255, g = rgba[j + 1] / 255, b = rgba[j + 2] / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx < 0.02 || mn > 0.98) continue; // crushed black and blown-out white say nothing about the colour
      this.s[0] += r; this.s[1] += g; this.s[2] += b;
      this.q[0] += r * r; this.q[1] += g * g; this.q[2] += b * b;
      this.n++;
    }
    return this;
  }
  get result() {
    const n = Math.max(1, this.n);
    const mean = this.s.map(v => v / n);
    const std = this.q.map((v, i) => Math.sqrt(Math.max(0, v / n - mean[i] * mean[i])));
    return { mean, std, n: this.n };
  }
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * The match from a shot's statistics to the reference's: { mul: [r, g, b], add: [r, g, b] }, so that
 * colour × mul + add has the reference's average and spread. Kept within sensible limits, so a very different
 * shot (night against day) is pulled toward the reference without being wrecked.
 */
export function matchParams(src, ref) {
  const mul = [0, 1, 2].map(i => clamp((ref.std[i] + 1e-3) / (src.std[i] + 1e-3), 0.6, 1.7));
  const add = [0, 1, 2].map(i => clamp(ref.mean[i] - mul[i] * src.mean[i], -0.35, 0.35));
  return { mul: mul.map(v => +v.toFixed(4)), add: add.map(v => +v.toFixed(4)) };
}

/** Applies a match to one colour (for checks and previews). */
export const applyMatch = (rgb, m, k = 1) => rgb.map((v, i) => v * (1 + (m.mul[i] - 1) * k) + m.add[i] * k);

/** Source times to measure in a clip: `n` spread through it, away from its very ends. */
export function clipSampleTimes(c, n = 5) {
  const sp = c.speed || 1, a = (c.in || 0), len = c.duration * sp;
  return Array.from({ length: n }, (_, i) => a + len * ((i + 0.5) / n));
}
