// Motion presets: one click gives a clip a ready-made move (Ken Burns, pans, punch-ins, shakes, pops, floats…),
// built from ordinary keyframes on position, scale, rotation and opacity, so every one can be fine-tuned on
// the timeline afterwards. Original presets written for Reel.
import { putKey } from './model.js';

const P = ['props.x', 'props.y', 'props.scale', 'props.rotation', 'props.opacity'];
const rnd = (i, s) => { const x = Math.sin(i * 127.1 + s * 311.7) * 43758.5453; return x - Math.floor(x); };

/** Each preset: (base props, clip length) → { path: [[t, v, ease], …] }. */
export const MOTION_PRESETS = {
  kenIn: { name: 'Ken Burns in', group: 'Camera', make: (b, d) => ({ scale: [[0, b.scale, 'linear'], [d, b.scale * 1.15]] }) },
  kenOut: { name: 'Ken Burns out', group: 'Camera', make: (b, d) => ({ scale: [[0, b.scale * 1.15, 'linear'], [d, b.scale]] }) },
  panLR: { name: 'Pan left → right', group: 'Camera', make: (b, d) => ({ scale: [[0, b.scale * 1.2, 'linear']], x: [[0, b.x + 0.07, 'linear'], [d, b.x - 0.07]] }) },
  panRL: { name: 'Pan right → left', group: 'Camera', make: (b, d) => ({ scale: [[0, b.scale * 1.2, 'linear']], x: [[0, b.x - 0.07, 'linear'], [d, b.x + 0.07]] }) },
  tiltUp: { name: 'Tilt up', group: 'Camera', make: (b, d) => ({ scale: [[0, b.scale * 1.2, 'linear']], y: [[0, b.y - 0.07, 'linear'], [d, b.y + 0.07]] }) },
  handheld: { name: 'Handheld', group: 'Camera', make: (b, d) => {
    const x = [], y = [], r = []; let i = 0;
    for (let t = 0; t <= d + 1e-6; t += 0.8, i++) { x.push([t, b.x + (rnd(i, 1) - 0.5) * 0.012, 'ease']); y.push([t, b.y + (rnd(i, 2) - 0.5) * 0.012, 'ease']); r.push([t, (b.rotation || 0) + (rnd(i, 3) - 0.5) * 0.8, 'ease']); }
    return { scale: [[0, b.scale * 1.04, 'linear']], x, y, rotation: r };
  } },
  punchIn: { name: 'Punch in', group: 'Hits', make: b => ({ scale: [[0, b.scale * 1.3, 'ease'], [0.35, b.scale]] }) },
  punchOut: { name: 'Punch out (end)', group: 'Hits', make: (b, d) => ({ scale: [[Math.max(0, d - 0.35), b.scale, 'ease'], [d, b.scale * 1.3]] }) },
  zoomHit: { name: 'Zoom hit (middle)', group: 'Hits', make: (b, d) => ({ scale: [[d / 2 - 0.15, b.scale, 'ease'], [d / 2, b.scale * 1.25, 'ease'], [d / 2 + 0.6, b.scale]] }) },
  shake: { name: 'Shake', group: 'Hits', make: b => {
    const x = [], y = [];
    for (let i = 0; i <= 10; i++) { const t = i * 0.05, a = (1 - i / 10) * 0.02; x.push([t, b.x + (i % 2 ? a : -a), 'linear']); y.push([t, b.y + (rnd(i, 7) - 0.5) * a, 'linear']); }
    return { x, y };
  } },
  pulse: { name: 'Pulse (beat)', group: 'Loops', make: (b, d) => { const s = []; for (let t = 0; t <= d + 1e-6; t += 0.5) { s.push([t, b.scale * 1.06, 'ease']); s.push([Math.min(d, t + 0.18), b.scale, 'ease']); } return { scale: s }; } },
  float: { name: 'Float', group: 'Loops', make: (b, d) => { const y = []; let i = 0; for (let t = 0; t <= d + 1e-6; t += 1.2, i++) y.push([t, b.y + (i % 2 ? 0.015 : -0.015), 'ease']); return { y }; } },
  swing: { name: 'Swing', group: 'Loops', make: (b, d) => { const r = []; let i = 0; for (let t = 0; t <= d + 1e-6; t += 0.9, i++) r.push([t, (b.rotation || 0) + (i % 2 ? 4 : -4), 'ease']); return { rotation: r }; } },
  popIn: { name: 'Pop in', group: 'In & out', make: b => ({ scale: [[0, b.scale * 0.01, 'ease'], [0.22, b.scale * 1.12, 'ease'], [0.38, b.scale]], opacity: [[0, 0, 'linear'], [0.12, b.opacity ?? 1]] }) },
  spinIn: { name: 'Spin in', group: 'In & out', make: b => ({ rotation: [[0, (b.rotation || 0) - 120, 'ease'], [0.6, b.rotation || 0]], scale: [[0, b.scale * 0.4, 'ease'], [0.6, b.scale]], opacity: [[0, 0, 'linear'], [0.25, b.opacity ?? 1]] }) },
  slideInL: { name: 'Slide in from left', group: 'In & out', make: b => ({ x: [[0, b.x - 1, 'ease'], [0.5, b.x]] }) },
  slideInR: { name: 'Slide in from right', group: 'In & out', make: b => ({ x: [[0, b.x + 1, 'ease'], [0.5, b.x]] }) },
  dropIn: { name: 'Drop in', group: 'In & out', make: b => ({ y: [[0, b.y - 1, 'ease'], [0.45, b.y + 0.02, 'ease'], [0.6, b.y]] }) },
  riseOut: { name: 'Rise and fade out', group: 'In & out', make: (b, d) => ({ y: [[Math.max(0, d - 0.5), b.y, 'ease'], [d, b.y - 0.08]], opacity: [[Math.max(0, d - 0.5), b.opacity ?? 1, 'linear'], [d, 0]] }) },
  popOut: { name: 'Pop out', group: 'In & out', make: (b, d) => ({ scale: [[Math.max(0, d - 0.35), b.scale, 'ease'], [Math.max(0, d - 0.2), b.scale * 1.12, 'ease'], [d, b.scale * 0.01]] }) },
};

/** Applies a preset to a clip: replaces its keyframes on the properties the preset moves. */
export function applyMotion(c, id) {
  const pr = MOTION_PRESETS[id]; if (!pr) return false;
  const b = { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, ...(c.props || {}) };
  const out = pr.make(b, c.duration);
  c.keys ||= {};
  for (const [k, list] of Object.entries(out)) {
    const path = `props.${k}`;
    if (!P.includes(path)) continue;
    delete c.keys[path];
    for (const [t, v, ease] of list) putKey(c, path, Math.max(0, Math.min(c.duration, t)), v, 1 / 120, ease || 'ease');
  }
  if (!Object.keys(c.keys).length) delete c.keys;
  return true;
}
/** Removes the keyframes a motion preset would have made (position, scale, rotation, opacity). */
export function clearMotion(c) { if (!c.keys) return; for (const p of P) delete c.keys[p]; if (!Object.keys(c.keys).length) delete c.keys; }
