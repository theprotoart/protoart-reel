import { invertAt } from './retime.js';
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

/**
 * The presses of a clip's recording (data: its cursor file, offset: the media's cursorOffset), as milliseconds on the
 * scale its clicks are placed by: start + (ms / 1000 − offset − in) / speed is where each sounds on the timeline.
 * Plain or sped-up clips: the file's own times. A clip with a time map (Elastic Wave, a retime curve; 1.15): each
 * press moved to where the map plays it, so it sounds with its picture (it used to be placed as if the clip played
 * at its average speed). In order, so the export's and the core's search can stop early.
 */
export function clickTimes(c, data, offset = 0) {
  const ms = (data?.clicks || []).filter(k => k[1] !== 'u').map(k => k[0]);
  if (!c.retime) return ms;
  const inn = c.in || 0, sp = c.speed || 1;
  return ms.map(v => (inn + invertAt(c.retime, v / 1000 - offset - inn) * sp + offset) * 1000);
}
