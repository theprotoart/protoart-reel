// How each clip plays into the export's sound, worked out once for the whole export: where it starts and ends
// (in output samples, crossfade handles included), where its source starts, its speed, and its gain and pan as
// an envelope sampled every 256 output samples (volume, fades, keyframes, track automation, mute and solo, all
// from model.js). The export worker mixes from it, and so does the Rust core (native/reel-core/src/mix.rs), so
// the two give the same sound. Pure functions.
import { sourceTime, gainAt, panAt, panGains, spanStart, spanEnd, mediaById, duration as docDuration } from '../model.js';
import { FX_TYPES } from './trackfx.js';

export const SEG = 256;

/**
 * The plan for clip c in an export from `start` seconds lasting `total` output samples at `rate`.
 * null if it isn't heard in that range. For clips played at a plain speed (no time map, no kept pitch).
 */
export function clipPlan(doc, c, start, total, rate) {
  const first = Math.max(0, Math.ceil((spanStart(c) - start) * rate));
  const last = Math.min(total, Math.floor((spanEnd(c) - start) * rate));
  if (!(last > first)) return null;
  const segs = Math.ceil((last - first) / SEG);
  const env = new Float32Array((segs + 2) * 2); // [L gain, R gain] per point (one spare so u = 1 reads a point)
  for (let m = 0; m <= segs + 1; m++) {
    const lt = start + Math.min(last, first + m * SEG) / rate - c.start;
    const g = gainAt(doc, c, lt), [pl, pr] = panGains(panAt(doc, c, lt));
    env[m * 2] = g * pl; env[m * 2 + 1] = g * pr;
  }
  return { first, last, s0: sourceTime(c, start + first / rate), speed: c.speed || 1, env };
}

/** The source position (in source samples, fractional) heard at output sample j. */
export const sourcePos = (p, j, rate, srcRate) => (p.s0 + (j - p.first) * (p.speed / rate)) * srcRate;

/** The source samples output samples j0 … j0 + n − 1 need: [from, to). */
export function sourceRange(p, j0, n, rate, srcRate) {
  const a = Math.max(j0, p.first), b = Math.min(j0 + n, p.last);
  if (b <= a) return null;
  return [Math.floor(sourcePos(p, a, rate, srcRate)) - 1, Math.floor(sourcePos(p, b - 1, rate, srcRate)) + 3];
}

/**
 * Adds the clip's sound for output samples j0 … j0 + n − 1 into L and R (Float32Arrays of n). `pcm` holds source
 * channels from source sample `from` on (one or two used: mono plays on both sides); outside it counts as silence.
 * Catmull-Rom interpolation between source samples; the gain envelope interpolated between its points.
 */
export function mixClip(L, R, j0, n, p, pcm, from, rate, srcRate) {
  const a0 = Math.max(j0, p.first), b0 = Math.min(j0 + n, p.last);
  const A = pcm[0], B = pcm.length > 1 ? pcm[1] : pcm[0], stereo = pcm.length > 1, len = A.length;
  const at = (x, k) => { const i = k - from; return i >= 0 && i < len ? x[i] : 0; };
  const env = p.env;
  for (let j = a0; j < b0; j++) {
    const pos = sourcePos(p, j, rate, srcRate), k = Math.floor(pos), f = pos - k;
    const q = (j - p.first) / SEG, m = Math.floor(q), u = q - m;
    const gl = env[m * 2] + (env[m * 2 + 2] - env[m * 2]) * u, gr = env[m * 2 + 1] + (env[m * 2 + 3] - env[m * 2 + 1]) * u;
    const p0 = at(A, k - 1), p1 = at(A, k), p2 = at(A, k + 1), p3 = at(A, k + 2);
    const l = p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
    let r = l;
    if (stereo) { const q0 = at(B, k - 1), q1 = at(B, k), q2 = at(B, k + 1), q3 = at(B, k + 2); r = q1 + 0.5 * f * (q2 - q0 + f * (2 * q0 - 5 * q1 + 4 * q2 - q3 + f * (3 * (q1 - q2) + q3 - q0))); }
    L[j - j0] += l * gl; R[j - j0] += r * gr;
  }
}

/** The export's gentle limit above 0.9 (sound-only and unmastered exports). */
export function softClip(L, R) {
  for (let i = 0; i < L.length; i++) {
    const l = L[i], r = R[i];
    L[i] = Math.abs(l) > 0.9 ? Math.sign(l) * (0.9 + 0.1 * Math.tanh((Math.abs(l) - 0.9) / 0.1)) : l;
    R[i] = Math.abs(r) > 0.9 ? Math.sign(r) * (0.9 + 0.1 * Math.tanh((Math.abs(r) - 0.9) / 0.1)) : r;
  }
}

/** A 24-bit sample, as the WAV export writes it. */
export const pcm24 = v => Math.max(-8388608, Math.min(8388607, Math.round(Math.max(-1, Math.min(1, v)) * 8388607)));

/**
 * A sound-only export for the Rust core: { job } with { rate, total, mixGain, soft, codec, bitrate, sources (media
 * file names), plans }, or { why } when the project uses something only the JavaScript export does so far (track
 * or mix-bus effects other than the limiter, sped-up clips that keep their pitch, time maps, click sounds).
 */
export function exportMixJob(doc, from, to, { codec, bitrate, rate = 48000, loudness = null, ceiling = -1 }) {
  const start = Math.max(0, from || 0), end = Math.min(docDuration(doc), to || Infinity);
  if (!(end > start)) return { why: 'nothing to export' };
  const used = doc.clips.filter(c => c.type === 'media' && !c.disabled && spanStart(c) < end && spanEnd(c) > start);
  const heard = used.filter(c => { const m = mediaById(doc, c.media); return m && (m.hasAudio || m.kind === 'audio') && !(c.audio && c.audio.mute); });
  if (doc.tracks.some(t => (t.fx || []).some(f => !f.off) && heard.some(c => c.track === t.id))) return { why: 'track effects' };
  // the mix bus: its limiter (every project has one) the core does too; anything else, not yet
  const bus = (doc.mixFx || []).filter(f => f && !f.off);
  if (bus.some(f => f.type !== 'limiter')) return { why: 'mix bus effects' };
  // the limiter's numbers worked out here exactly as trackfx.js does, so both sides use the very same values
  const limiters = bus.map(f => { const p = { ...FX_TYPES.limiter.defaults, ...(f.params || {}) }; return { ceil: 10 ** (p.ceiling / 20), rel: Math.exp(-1 / Math.max(1, (p.release / 1000) * rate)) }; });
  if (heard.some(c => c.retime || ((c.speed || 1) !== 1 && c.audio?.keepPitch !== false))) return { why: 'speed changes that keep pitch' };
  if (used.some(c => c.cursor?.clickSound > 0 && !c.audio?.mute)) return { why: 'click sounds' };
  const total = Math.floor((end - start) * rate), sources = [], index = new Map(), plans = [];
  for (const c of heard) {
    const m = mediaById(doc, c.media), file = c.fx && c.fx.file && !c.fx.bypass ? c.fx.file : m.file;
    const p = clipPlan(doc, c, start, total, rate);
    if (!p) continue;
    if (!index.has(file)) { index.set(file, sources.length); sources.push(file); }
    plans.push({ src: index.get(file), ...p });
  }
  // a loudness target: the core measures the mix and turns it to the target, then the true-peak limiter (instead of
  // the soft limit), with the very numbers the JavaScript master path uses (lib/master.js, export-worker.js)
  const loud = loudness == null ? null : { target: loudness, ceil: Math.pow(10, (ceiling ?? -1) / 20), rel: Math.exp(-1 / (0.08 * rate)), look: Math.round(rate * 0.0015), measure: Math.round((end - start) * rate) };
  return { job: { rate, total, mixGain: doc.mixGain ? 10 ** (doc.mixGain / 20) : 1, limiters, soft: !loud, codec, bitrate, sources, plans, ...(loud ? { loud } : {}) } };
}
