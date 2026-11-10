// Good thumbnail frames: scores small frames for how sharp, colourful and well exposed they are, then picks the
// best few spread through the video (so the choice isn't eight near-copies of one moment).

/** A frame's score from its RGBA pixels (w × h). Higher is better; a black, washed-out or blurry frame scores low. */
export function frameScore(rgba, w, h) {
  const n = w * h, g = new Float32Array(n);
  let sum = 0, rg = 0, yb = 0, rg2 = 0, yb2 = 0;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = rgba[j], gg = rgba[j + 1], b = rgba[j + 2];
    const y = r * 0.299 + gg * 0.587 + b * 0.114; g[i] = y; sum += y;
    const a = r - gg, c = 0.5 * (r + gg) - b; rg += a; yb += c; rg2 += a * a; yb2 += c * c;
  }
  const mean = sum / n;
  // colourfulness (Hasler & Süsstrunk): spread and strength of the colour
  const mrg = rg / n, myb = yb / n;
  const colour = Math.sqrt(Math.max(0, rg2 / n - mrg * mrg) + Math.max(0, yb2 / n - myb * myb)) + 0.3 * Math.hypot(mrg, myb);
  // sharpness: mean size of the Laplacian (edges and detail)
  let lap = 0, m = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    lap += Math.abs(4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]); m++;
  }
  const sharp = m ? lap / m : 0;
  // contrast: spread of brightness
  let v = 0; for (let i = 0; i < n; i++) v += (g[i] - mean) ** 2;
  const contrast = Math.sqrt(v / n);
  const exposure = mean < 35 ? (mean / 35) ** 2 : mean > 225 ? ((255 - mean) / 30) ** 2 : 1;
  return (sharp * 2 + colour * 0.35 + contrast * 0.25) * exposure;
}

/**
 * The best `count` of the scored frames ([{ t, score }]), at least `gap` seconds apart, in time order.
 */
export function pickFrames(list, count = 8, gap = 0) {
  const out = [];
  for (const f of [...list].sort((a, b) => b.score - a.score)) {
    if (out.length >= count) break;
    if (out.some(o => Math.abs(o.t - f.t) < gap)) continue;
    out.push(f);
  }
  return out.sort((a, b) => a.t - b.t);
}

/** The times to look at: `n` evenly through [0, total], skipping the very start and end (fades, black). */
export function sampleTimes(total, n = 24) {
  if (!(total > 0)) return [0];
  const a = Math.min(total * 0.03, 2), b = total - Math.min(total * 0.03, 2);
  if (n <= 1 || b <= a) return [total / 2];
  return Array.from({ length: n }, (_, i) => a + (b - a) * (i / (n - 1)));
}

/** A CSS filter that gives a frame thumbnail punch: amount 0 (as shot) … 1 (strong). */
export const popFilter = k => (k > 0.01 ? `contrast(${(1 + 0.28 * k).toFixed(3)}) saturate(${(1 + 0.5 * k).toFixed(3)}) brightness(${(1 + 0.06 * k).toFixed(3)})` : 'none');
