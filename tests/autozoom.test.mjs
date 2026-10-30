// Smart Zoom planner: synthetic grids stand in for decoded frames.
import test from 'node:test';
import assert from 'node:assert';
import { measure, plan, findCuts, frameFraction } from '../app/renderer/autozoom.js';

const GW = 48, GH = 27;
function frame(t, { blob = null, scene = 0 } = {}) {
  const g = new Float32Array(GW * GH);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) g[y * GW + x] = scene ? 200 - x * 2 : 40 + ((x * 7 + y * 13) % 9); // two different "shots"
  if (blob) { // a moving bright square
    const bx = Math.round(blob.x * GW), by = Math.round(blob.y * GH);
    for (let y = by - 2; y <= by + 2; y++) for (let x = bx - 2; x <= bx + 2; x++) if (x >= 0 && y >= 0 && x < GW && y < GH) g[y * GW + x] = 255 * ((Math.floor(t * 5) % 2) ? 1 : 0.3);
  }
  return g;
}
function samples(n, fn) {
  const out = []; let prev = null;
  for (let i = 0; i < n; i++) { const t = i * 0.2, g = fn(t); out.push({ t, ...measure(g, prev, GW, GH) }); prev = g; }
  return out;
}

test('measure finds where things move', () => {
  const a = frame(0, { blob: { x: 0.8, y: 0.25 } }), b = frame(0.2, { blob: { x: 0.8, y: 0.25 } });
  const m = measure(b, a, GW, GH);
  assert.ok(Math.abs(m.cx - 0.8) < 0.06 && Math.abs(m.cy - 0.25) < 0.08, JSON.stringify(m));
  assert.ok(m.box < 0.2 && m.motion > 0);
});

test('follow: zooms in on the action, inside the frame, then out at the cut', () => {
  // 0–6 s: something moves top right; 6 s: cut to a still shot until 10 s
  const s = samples(50, t => (t < 6 ? frame(t, { blob: { x: 0.85, y: 0.2 } }) : frame(t, { scene: 1 })));
  assert.deepStrictEqual(findCuts(s).map(x => +x.toFixed(1)), [6]);
  const acts = plan(s, 10, { style: 'follow' });
  const zin = acts.find(a => a.props.scale > 1.1);
  assert.ok(zin && zin.t < 3, 'zooms in early');
  // zooming right/up moves the picture left/down, and the frame still covers the canvas
  assert.ok(zin.props.x < 0.5 && zin.props.y > 0.5);
  const half = zin.props.scale / 2;
  assert.ok(zin.props.x + half >= 1 - 1e-6 && zin.props.x - half <= 1e-6, 'covers horizontally');
  assert.ok(acts.some(a => Math.abs(a.t - 6) < 0.05 && a.props.scale === 1), 'snaps home on the cut');
  for (let i = 1; i < acts.length; i++) assert.ok(acts[i].t >= acts[i - 1].t + acts[i - 1].dur - 1e-6, 'no overlapping actions');
  assert.ok(acts.every(a => a.t + a.dur <= 10 + 1e-6));
});

test('cinematic: still shots get a slow push; punchy: jump zoom on cuts', () => {
  const still = samples(40, t => frame(t, { scene: t >= 4 ? 1 : 0 }));
  const cine = plan(still, 8, { style: 'cinematic' });
  assert.ok(cine.length >= 2 && cine.filter(a => a.dur > 2 && a.props.scale > 1.05).length >= 2, JSON.stringify(cine));
  const punchy = plan(still, 8, { style: 'punchy' });
  assert.ok(punchy.some(a => Math.abs(a.t - 4) < 0.05 && a.props.scale > 1.1 && a.dur < 0.1), JSON.stringify(punchy));
  const weak = plan(still, 8, { style: 'cinematic', strength: 0.5 });
  assert.ok(Math.max(...weak.map(a => a.props.scale)) < Math.max(...cine.map(a => a.props.scale)));
});

test('picture-in-picture clips zoom within their own box', () => {
  const s = samples(30, t => frame(t, { blob: { x: 0.3, y: 0.6 } }));
  const base = { x: 0.75, y: 0.75, scale: 0.4, crop: [0, 0, 0, 0], ...frameFraction({ width: 1920, height: 1080 }, { width: 1920, height: 1080 }) };
  const acts = plan(s, 6, { style: 'follow', base });
  const z = acts.find(a => a.props.scale > 0.45);
  assert.ok(z && Math.abs(z.props.x - 0.75) < 0.2 && Math.abs(z.props.y - 0.75) < 0.2, JSON.stringify(acts));
  assert.ok(acts.filter(a => a.props.scale <= 0.4 + 1e-6).every(a => a.props.x === 0.75 && a.props.y === 0.75), 'home is the PiP spot');
});
