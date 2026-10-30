// Time-lapse: a clip sped up to a target length, not evenly but where nothing much is happening. Activity comes
// from the same picture analysis Smart Zoom uses (how much of the frame changes), plus the clicks and typing a
// Reel recording logged. plan() is pure: activity in, speed segments out (with short ramps between speeds);
// apply() rebuilds the clip as those segments on the timeline.
import { uid, clamp, EPS, clipEnd, withGroups } from './model.js';

export const LAPSE_PRESETS = [
  { id: 'yt60', label: 'YouTube time-lapse · 60 s', hint: 'Whole build, art piece or session in one minute. Quiet parts fly by, the action stays watchable.', target: 60, mode: 'smart', sound: 'mute' },
  { id: 'yt180', label: 'YouTube time-lapse · 3 min', hint: 'A longer process video with room to see each stage.', target: 180, mode: 'smart', sound: 'mute' },
  { id: 'short30', label: 'Shorts · Reels · TikTok · 30 s', hint: 'Punchy and quick: fits a vertical short.', target: 30, mode: 'smart', sound: 'mute' },
  { id: 'art10', label: 'Speed art · about 10×', hint: 'Ten times faster on average, slower on the details, faster on the waiting.', factor: 10, mode: 'smart', sound: 'mute' },
  { id: 'skip', label: 'Skip the waiting (tutorials)', hint: 'Talking and clicking stay at normal speed; loading bars, renders and pauses race past (up to 8×). Voice keeps its pitch.', mode: 'skip', sound: 'keep' },
  { id: 'fit', label: 'Fit to a length…', hint: 'Choose the length; Reel spreads the speed by what’s happening.', mode: 'smart', sound: 'mute', ask: true },
  { id: 'even', label: 'Even speed to a length…', hint: 'Classic time-lapse: one steady speed for the whole clip.', mode: 'even', sound: 'mute', ask: true },
];

const SMOOTH = 1.5; // seconds of source the activity is averaged over

/**
 * activity: [{ t (source seconds from the clip's in point), a (≥ 0) }], srcLen: source seconds used.
 * opts: { mode: 'smart' | 'skip' | 'even', target (s) | factor, minSpeed, maxSpeed, ramp (s) }.
 * Returns segments [{ s0, s1, speed }] covering 0..srcLen in source seconds.
 */
export function plan(activity, srcLen, { mode = 'smart', target, factor, minSpeed = 1, maxSpeed = 64, ramp = 0.35, minPiece = 0.6 } = {}) {
  if (!(srcLen > 0)) return [];
  const T = target || (factor ? srcLen / factor : srcLen / 4);
  if (mode === 'even') return [{ s0: 0, s1: srcLen, speed: clamp(srcLen / T, 0.05, 1000) }];
  // activity on a regular grid (0.25 s), smoothed and normalised to its busy level
  const dt = 0.25, n = Math.max(1, Math.ceil(srcLen / dt)), raw = new Float64Array(n);
  for (const s of activity) { const i = Math.min(n - 1, Math.max(0, Math.floor(s.t / dt))); raw[i] = Math.max(raw[i], s.a); }
  // gaps between samples take the nearer sample's value
  let last = 0; for (let i = 0; i < n; i++) { if (raw[i] > 0) last = raw[i]; else raw[i] = last * 0.98; }
  const half = Math.max(1, Math.round(SMOOTH / dt / 2)), a = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) { s += raw[j]; c++; } a[i] = s / c; }
  const sorted = Array.from(a).sort((p, q) => p - q), busy = sorted[Math.floor(n * 0.9)] || 1;
  for (let i = 0; i < n; i++) a[i] = busy > 0 ? Math.min(1.5, a[i] / busy) : 0;
  let sp = new Float64Array(n);
  if (mode === 'skip') {
    // quiet: well under the usual level → up to 8×; anything happening → normal speed
    const quietMax = maxSpeed === 64 ? 8 : maxSpeed;
    for (let i = 0; i < n; i++) sp[i] = a[i] < 0.12 ? quietMax : a[i] < 0.3 ? 1 + (quietMax - 1) * ((0.3 - a[i]) / 0.18) : 1;
  } else {
    // speed ∝ 1 / interest, scaled (k) so the whole lands on the target length
    const fit = k => { let out = 0; for (let i = 0; i < n; i++) out += Math.min(dt, srcLen - i * dt) / clamp(k / (0.12 + a[i]), minSpeed, maxSpeed); return out; };
    let lo = 1e-4, hi = 1e5;
    for (let it = 0; it < 80; it++) { const mid = Math.sqrt(lo * hi); if (fit(mid) > T) lo = mid; else hi = mid; }
    for (let i = 0; i < n; i++) sp[i] = clamp(hi / (0.12 + a[i]), minSpeed, maxSpeed);
  }
  // round to eighth-octave steps and merge runs into pieces
  const q = v => 2 ** (Math.round(Math.log2(v) * 8) / 8);
  let segs = [];
  for (let i = 0; i < n; i++) {
    const s0 = i * dt, s1 = Math.min(srcLen, (i + 1) * dt), v = q(sp[i]);
    const prev = segs[segs.length - 1];
    if (prev && Math.abs(Math.log2(prev.speed / v)) < 0.3) { const w0 = prev.s1 - prev.s0, w1 = s1 - s0; prev.speed = 2 ** ((Math.log2(prev.speed) * w0 + Math.log2(v) * w1) / (w0 + w1)); prev.s1 = s1; }
    else segs.push({ s0, s1, speed: v });
  }
  // pieces shorter than minPiece on screen join the neighbour nearest in speed
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (let i = 0; i < segs.length && segs.length > 1; i++) {
      const s = segs[i];
      if ((s.s1 - s.s0) / s.speed >= minPiece) continue;
      const L = segs[i - 1], R = segs[i + 1];
      const into = !L ? R : !R ? L : Math.abs(Math.log2(L.speed / s.speed)) <= Math.abs(Math.log2(R.speed / s.speed)) ? L : R;
      const w0 = into.s1 - into.s0, w1 = s.s1 - s.s0;
      into.speed = (w0 + w1) / (w0 / into.speed + w1 / s.speed); // keeps the combined screen time
      into.s0 = Math.min(into.s0, s.s0); into.s1 = Math.max(into.s1, s.s1);
      segs.splice(i, 1); i--; changed = true;
    }
    if (!changed) break;
  }
  for (const s of segs) s.speed = q(s.speed);
  // ramps: a big change of speed eases through two in-between steps instead of jumping
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const s = { ...segs[i] }, next = segs[i + 1];
    out.push(s);
    if (!next || Math.abs(Math.log2(next.speed / s.speed)) < 1) continue;
    const len = Math.min(ramp * Math.sqrt(s.speed * next.speed) * 2, (s.s1 - s.s0) * 0.4, (next.s1 - next.s0) * 0.4);
    if (len <= 0.01) continue;
    const r = (next.speed / s.speed) ** (1 / 3), at = s.s1;
    s.s1 = at - len / 2; next.s0 = at + len / 2;
    out.push({ s0: at - len / 2, s1: at, speed: s.speed * r }, { s0: at, s1: at + len / 2, speed: s.speed * r * r });
  }
  // a last nudge so the total lands on the target (smart mode)
  if (mode === 'smart') {
    for (let it = 0; it < 4; it++) {
      const now = out.reduce((m, s) => m + (s.s1 - s.s0) / s.speed, 0), f = now / T;
      if (Math.abs(f - 1) < 0.005) break;
      for (const s of out) s.speed = clamp(s.speed * f, Math.min(minSpeed, 1), maxSpeed * 2);
    }
  }
  return out.filter(s => s.s1 - s.s0 > 1e-6);
}

/** Activity from Smart Zoom's samples ({ t (timeline s at the clip's speed), diff, motion }) and a pointer track. */
export function activityOf(samples, speed, cursor, cursorOffset, srcIn) {
  const out = samples.map(s => ({ t: s.t * speed, a: (s.motion || 0) + (s.diff || 0) / 40 }));
  if (cursor) {
    // clicks and keys: something is being done (worth seeing) for a second either side
    const evs = [...(cursor.clicks || []).filter(c => c[1] !== 'u').map(c => c[0]), ...(cursor.keys || []).map(k => k[0])];
    for (const ms of evs) {
      const t = ms / 1000 - (cursorOffset || 0) - srcIn;
      for (let d = -1; d <= 1; d += 0.25) out.push({ t: t + d, a: 0.6 });
    }
  }
  return out.filter(s => s.t >= 0);
}

/**
 * Rebuilds clip c (and clips grouped with it that line up with it) as the planned segments. Keyframes and
 * actions follow their source moments; clips after it on any track move up (or back) by the change in length.
 * Returns { before, after } lengths.
 */
export function apply(doc, c, segs, { sound = 'mute' } = {}) {
  const ids = withGroups(doc, [c.id]);
  const lined = doc.clips.filter(k => ids.includes(k.id) && Math.abs(k.start - c.start) < 1e-3 && Math.abs(k.duration - c.duration) < 1e-3 && Math.abs((k.speed || 1) - (c.speed || 1)) < 1e-6);
  const oldEnd = clipEnd(c), oldSpeed = c.speed || 1;
  // old timeline-local time → new timeline-local time (through source time)
  const starts = []; let acc = 0;
  for (const s of segs) { starts.push(acc); acc += (s.s1 - s.s0) / s.speed; }
  const newLen = acc;
  const remap = lt => {
    const st = lt * oldSpeed;
    let i = segs.findIndex(s => st < s.s1 - 1e-9); if (i < 0) i = segs.length - 1;
    const s = segs[i]; return starts[i] + (Math.min(Math.max(st, s.s0), s.s1) - s.s0) / s.speed;
  };
  const made = [];
  for (const k of lined) {
    const pieces = segs.map((s, i) => {
      const n = structuredClone(k);
      n.id = i === 0 ? k.id : uid('c');
      n.in = (k.in || 0) + s.s0; n.speed = Math.abs(s.speed - 1) < 1e-4 ? 1 : s.speed;
      n.start = k.start + starts[i]; n.duration = (s.s1 - s.s0) / s.speed;
      if (i > 0) n.transIn = { type: 'none', dur: k.transIn?.dur || 0.5 };
      if (i < segs.length - 1) n.transOut = { type: 'none', dur: k.transOut?.dur || 0.5 };
      // keyframes and actions land in the piece holding their moment, at their new time
      if (k.keys) {
        n.keys = {};
        for (const [p, list] of Object.entries(k.keys)) {
          const keep = list.map(key => ({ ...key, t: remap(key.t) - starts[i] })).filter(key => key.t >= -1e-6 && key.t <= n.duration + 1e-6);
          if (keep.length) n.keys[p] = keep;
        }
        if (!Object.keys(n.keys).length) delete n.keys;
      }
      n.actions = (k.actions || []).map(a => { const t0 = remap(a.t), t1 = remap(a.t + a.dur); return { ...a, t: t0 - starts[i], dur: Math.max(0.05, t1 - t0) }; })
        .filter(a => a.t >= -1e-6 && a.t < n.duration);
      if (n.audio) {
        if (sound === 'mute') n.audio.mute = true; else n.audio.keepPitch = true;
        if (i > 0) n.audio.fadeIn = Math.min(n.audio.fadeIn || 0, 0.02);
        if (i < segs.length - 1) n.audio.fadeOut = Math.min(n.audio.fadeOut || 0, 0.02);
      }
      n.lapse = { from: k.lapse?.from || k.id };
      return n;
    });
    doc.clips.splice(doc.clips.indexOf(k), 1, ...pieces);
    made.push(...pieces.map(p => p.id));
  }
  // everything after the clip moves by the change in length
  const d = newLen - c.duration;
  if (Math.abs(d) > EPS) {
    for (const k of doc.clips) if (!made.includes(k.id) && k.start >= oldEnd - 1e-3) k.start = Math.max(0, k.start + d);
    for (const mk of doc.markers || []) if (mk.t >= oldEnd - 1e-3) mk.t += d;
  }
  return { before: c.duration, after: newLen, pieces: made };
}
