// A short mouse-click sound, made in code (no sample files): a bright tick with a soft body.
// Shared by the preview and the export so both sound the same.
export function clickSample(rate = 48000, kind = 'click') {
  const n = Math.round(rate * 0.045);
  const out = new Float32Array(n);
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  const f = kind === 'soft' ? 1800 : 3200;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.exp(-t * (kind === 'soft' ? 160 : 260));
    lp += (rnd() - lp) * 0.35; // brown-ish noise for the body
    out[i] = env * (0.55 * Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 400) + 0.45 * lp);
  }
  return out;
}
