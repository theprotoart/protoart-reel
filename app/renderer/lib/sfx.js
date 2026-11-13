// Sound effects made by Reel itself (synthesised, so there's nothing to license): whooshes, swishes, risers,
// hits, booms, pops, clicks, dings, glitches, a camera shutter, typing, a sparkle, a record scratch.
// Each returns stereo Float32 PCM at the rate asked for. Deterministic: the same sound every time.

export const SFX = {
  whoosh: { name: 'Whoosh', len: 0.9, hint: 'For moves and whip pans' },
  swish: { name: 'Swish (short)', len: 0.35, hint: 'Quick slide or pop-up' },
  riser: { name: 'Riser', len: 2.2, hint: 'Build-up before a reveal' },
  hit: { name: 'Hit', len: 0.9, hint: 'A punchy cinematic impact' },
  boom: { name: 'Boom', len: 2.0, hint: 'Deep sub drop' },
  pop: { name: 'Pop', len: 0.25, hint: 'Elements popping in' },
  click: { name: 'Click', len: 0.12, hint: 'Mouse / button click' },
  ding: { name: 'Ding', len: 1.4, hint: 'Correct! / notification' },
  glitch: { name: 'Glitch', len: 0.6, hint: 'Digital glitch' },
  shutter: { name: 'Camera shutter', len: 0.35, hint: 'Freeze frames, screenshots' },
  typing: { name: 'Typing', len: 1.6, hint: 'Keyboard, for typewriter text' },
  sparkle: { name: 'Sparkle', len: 1.2, hint: 'Magic, reveals' },
  scratch: { name: 'Record scratch', len: 0.7, hint: 'Wait, what?' },
};

function noise(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967295) * 2 - 1; }; }
/** One-pole low-pass / high-pass with a time-varying cutoff (Hz). */
function filt(x, rate, cutoffAt, high = false) {
  let y = 0, prev = 0;
  for (let i = 0; i < x.length; i++) {
    const a = 1 - Math.exp((-2 * Math.PI * Math.max(20, cutoffAt(i / rate))) / rate);
    y += a * (x[i] - y);
    const v = high ? x[i] - y : y; prev = v; x[i] = v;
  }
  void prev; return x;
}
const env = (t, a, d) => (t < a ? t / a : Math.exp(-(t - a) / d));

export function makeSfx(id, rate = 48000) {
  const def = SFX[id]; if (!def) throw new Error('Unknown sound');
  const n = Math.round(def.len * rate), L = new Float32Array(n), R = new Float32Array(n), rn = noise(id.length * 7919 + id.charCodeAt(0));
  const T = i => i / rate;
  switch (id) {
    case 'whoosh': case 'swish': {
      const len = def.len, peak = len * 0.55;
      for (let i = 0; i < n; i++) L[i] = rn();
      filt(L, rate, t => 300 + 5000 * Math.exp(-(((t - peak) / (len * 0.25)) ** 2)));
      for (let i = 0; i < n; i++) { const t = T(i), e = Math.exp(-(((t - peak) / (len * 0.28)) ** 2)) * 1.6; const pan = (t / len) * 2 - 1; L[i] *= e * (1 - pan * 0.6); R[i] = L[i] / Math.max(0.4, 1 - pan * 0.6) * (1 + pan * 0.6); }
      break;
    }
    case 'riser': {
      for (let i = 0; i < n; i++) { const t = T(i), k = t / def.len; L[i] = rn() * 0.5 * k * k + Math.sin(2 * Math.PI * (200 * t + 300 * t * t)) * 0.25 * k; }
      filt(L, rate, t => 400 + 6000 * (t / def.len) ** 2);
      for (let i = 0; i < n; i++) { const fade = Math.min(1, (n - i) / (rate * 0.03)); L[i] *= fade; R[i] = L[i]; }
      break;
    }
    case 'hit': case 'boom': {
      const deep = id === 'boom';
      for (let i = 0; i < n; i++) {
        const t = T(i), f = deep ? 38 + 60 * Math.exp(-t * 10) : 55 + 140 * Math.exp(-t * 25);
        const body = Math.sin(2 * Math.PI * f * t) * env(t, 0.003, deep ? 0.7 : 0.25);
        const crack = rn() * env(t, 0.001, deep ? 0.05 : 0.08) * (deep ? 0.3 : 0.8);
        L[i] = Math.tanh((body + crack) * 2.2) * 0.9; R[i] = L[i];
      }
      break;
    }
    case 'pop': for (let i = 0; i < n; i++) { const t = T(i), f = 900 * Math.exp(-t * 18) + 300; L[i] = R[i] = Math.sin(2 * Math.PI * f * t) * env(t, 0.002, 0.04) * 0.8; } break;
    case 'click': for (let i = 0; i < n; i++) { const t = T(i); L[i] = R[i] = (rn() * 0.6 + Math.sin(2 * Math.PI * 3200 * t) * 0.4) * env(t, 0.0005, 0.008) * 0.9; } break;
    case 'ding': for (let i = 0; i < n; i++) { const t = T(i); L[i] = R[i] = (Math.sin(2 * Math.PI * 1318.5 * t) + 0.5 * Math.sin(2 * Math.PI * 2637 * t) + 0.25 * Math.sin(2 * Math.PI * 3955.5 * t)) * env(t, 0.003, 0.35) * 0.35; } break;
    case 'glitch': {
      let hold = 0, v = 0;
      for (let i = 0; i < n; i++) { if (--hold <= 0) { hold = Math.floor(rate * (0.005 + Math.abs(rn()) * 0.04)); v = rn(); } const t = T(i); const bit = Math.round(Math.sin(2 * Math.PI * (200 + Math.abs(v) * 2000) * t) * 3) / 3; L[i] = bit * 0.5 * (Math.abs(v) > 0.3 ? 1 : 0.2) * env(t, 0.002, 0.25); R[i] = hold % 2 ? L[i] : -L[i] * 0.7; }
      break;
    }
    case 'shutter': for (let i = 0; i < n; i++) { const t = T(i); const a = rn() * env(t, 0.001, 0.012), b = t > 0.11 ? rn() * env(t - 0.11, 0.001, 0.02) * 0.8 : 0; L[i] = R[i] = (a + b) * 0.9; } filt(L, rate, () => 1500, true); R.set(L); break;
    case 'typing': {
      for (let k = 0; k < 11; k++) { const at = Math.floor((0.05 + k * 0.135 + Math.abs(rn()) * 0.05) * rate); for (let i = 0; i < rate * 0.03 && at + i < n; i++) { const t = i / rate; const v = rn() * env(t, 0.0005, 0.006) * 0.7; L[at + i] += v; R[at + i] += v * 0.8; } }
      break;
    }
    case 'sparkle': for (let i = 0; i < n; i++) { const t = T(i); let v = 0; for (let k = 0; k < 6; k++) { const st = k * 0.09; if (t > st) v += Math.sin(2 * Math.PI * (1800 + k * 420) * (t - st)) * env(t - st, 0.002, 0.25) * 0.15; } L[i] = v; R[i] = v * (0.6 + 0.4 * Math.sin(t * 20)); } break;
    case 'scratch': for (let i = 0; i < n; i++) { const t = T(i), f = 300 + 900 * Math.abs(Math.sin(t * 9)); L[i] = R[i] = (rn() * 0.4 + Math.sin(2 * Math.PI * f * t) * 0.4) * env(t, 0.01, 0.25) * 0.8; } break;
    default: break;
  }
  // gentle limit and fade-out so nothing clicks
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
  const g = pk > 0.89 ? 0.89 / pk : 1, fo = Math.round(rate * 0.01);
  for (let i = 0; i < n; i++) { const f = i > n - fo ? (n - i) / fo : 1; L[i] *= g * f; R[i] *= g * f; }
  return [L, R];
}

/** Sound that suits a transition (the auto pass and the preset browser add it at the cut). */
export const SFX_FOR = {
  'whip-left': 'whoosh', 'whip-right': 'whoosh', 'whip-through': 'whoosh', 'push-left': 'swish', 'push-right': 'swish', 'slide-left': 'swish', 'slide-right': 'swish',
  'zoom-through': 'whoosh', 'spin-through': 'whoosh', 'spin': 'swish', 'flash': 'hit', 'flash-cut': 'hit', 'glitch': 'glitch', 'glitch-cut': 'glitch',
  'light-leak': 'sparkle', 'film-burn': 'riser', 'drop': 'hit', 'pop': 'pop', 'elastic': 'pop', 'shake-cut': 'boom', 'iris': 'swish', 'clock': 'swish', 'shutter': 'shutter',
  'fast-wipe': 'swish', 'glitch-blocks': 'glitch', 'warp-zoom': 'whoosh', 'slide-shake': 'whoosh', 'film-burn-vintage': 'riser', 'match-move': 'whoosh', 'match-graphic': 'swish', 'vertigo': 'riser',
  // softer ones too, so every pack can have sound when it's switched on
  'blur-through': 'swish', 'blur': 'swish', 'dip-black': 'swish', 'dip-white': 'sparkle', 'zoom': 'whoosh', 'zoom-out': 'whoosh', 'rise': 'swish',
  'wipe-left': 'swish', 'wipe-right': 'swish', 'wipe-up': 'swish', 'wipe-down': 'swish', 'barn': 'swish', 'blinds': 'swish', 'diagonal': 'swish',
};
