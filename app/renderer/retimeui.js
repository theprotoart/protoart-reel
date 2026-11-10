// Inspector › Retime curve (like DaVinci Resolve's): the clip's time map drawn as a curve, clip time across and
// source time up. Steeper = faster; flatter = slower; the dashed line is normal speed. Drag a point to change the
// timing, double-click the curve to add one, double-click a point to remove it. Pitch is kept (Speed › Keep pitch).
import { el, section } from './ui.js';
import { linearRetime, setPoint, addPoint, removePoint, retimePreset, slopeAt, meanSpeed, mapAt } from './lib/retime.js';

export function retimeSection(app, insp, c, m) {
  const W = 268, H = 150, P = 14;
  const cv = el('canvas', { class: 'rt-curve', width: W * 2, height: H * 2, title: 'Drag a point, or anywhere on the line, to retime · double-click the curve to add a point · double-click a point to remove it' });
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  const g = cv.getContext('2d'); g.scale(2, 2);
  const read = el('div', { class: 'rt-read note' });
  const pts = () => c.retime || linearRetime(c.duration, c.duration * (c.speed || 1));
  // the vertical scale: room to slow down or speed up, but not past the end of the source
  const srcLeft = () => Math.max(0.1, (m.duration || 1e9) - (c.in || 0));
  const top = () => Math.min(srcLeft(), Math.max(pts()[pts().length - 1].s * 1.5, c.duration * 1.5));
  const X = t => P + (t / c.duration) * (W - 2 * P), Y = s => H - P - (s / top()) * (H - 2 * P);
  const T = x => ((x - P) / (W - 2 * P)) * c.duration, S = y => ((H - P - y) / (H - 2 * P)) * top();
  const draw = (hover = -1) => {
    const p = pts();
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(P, P, W - 2 * P, H - 2 * P);
    g.strokeStyle = 'rgba(255,255,255,.22)'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(X(0), Y(0)); g.lineTo(X(c.duration), Y(c.duration)); g.stroke(); g.setLineDash([]);
    // the curve, coloured by speed: amber faster than normal, blue slower
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1], b = p[i], sp = (b.s - a.s) / (b.t - a.t);
      g.strokeStyle = Math.abs(sp - 1) < 0.01 ? '#e9e5da' : sp > 1 ? '#ffb02a' : '#7fd0ff'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(X(a.t), Y(a.s)); g.lineTo(X(b.t), Y(b.s)); g.stroke();
    }
    p.forEach((q, i) => { g.fillStyle = i === hover ? '#ffb02a' : '#f4f4f4'; g.strokeStyle = '#000'; g.lineWidth = 1; g.beginPath(); g.arc(X(q.t), Y(q.s), i === 0 ? 3 : 5, 0, Math.PI * 2); g.fill(); g.stroke(); });
    // playhead
    const lt = app.player.time - c.start;
    if (lt >= 0 && lt <= c.duration) { g.strokeStyle = 'rgba(255,80,60,.8)'; g.beginPath(); g.moveTo(X(lt), P); g.lineTo(X(lt), H - P); g.stroke(); }
    const avg = meanSpeed(p);
    read.textContent = `${p.length - 2} point${p.length === 3 ? '' : 's'} · average ${Math.round(avg * 100)}% · uses ${p[p.length - 1].s.toFixed(1)} s of the source`;
  };
  const hit = (x, y) => pts().findIndex((q, i) => i > 0 && Math.hypot(X(q.t) - x, Y(q.s) - y) < 8);
  const pos = ev => { const r = cv.getBoundingClientRect(); return [(ev.clientX - r.left) * (W / r.width), (ev.clientY - r.top) * (H / r.height)]; };
  let lastDown = { i: -2, t: 0 };
  cv.addEventListener('pointermove', ev => { if (!cv.hasPointerCapture(ev.pointerId)) { const [x, y] = pos(ev); const i = hit(x, y); draw(i); const t = Math.max(0, Math.min(c.duration, T(x))); read.textContent = `At ${t.toFixed(2)} s: ${Math.round(slopeAt(pts(), t) * 100)}% speed`; } });
  cv.addEventListener('pointerleave', () => draw());
  cv.addEventListener('pointerdown', ev => {
    const [x, y] = pos(ev), now = performance.now();
    let i = hit(x, y);
    const dbl = now - lastDown.t < 350 && lastDown.i === i; lastDown = { i, t: now };
    if (dbl) { // double-click: remove the point, or add one on the curve
      insp.edit(() => {
        const p = pts();
        if (i > 0 && i < p.length - 1) c.retime = removePoint(p, i);
        else if (i < 0) c.retime = addPoint(p, Math.max(0.05, Math.min(c.duration - 0.05, T(x))));
        else return;
        c.speed = meanSpeed(c.retime);
      });
      return;
    }
    // press on the line itself (not a point) and drag: a new point there, dragged straight away
    const onLine = i < 0 && x >= P && x <= W - P && Math.abs(Y(mapAt(pts(), Math.max(0, Math.min(c.duration, T(x))))) - y) < 10;
    if (i === 0 || (i < 0 && !onLine)) return;
    cv.setPointerCapture(ev.pointerId);
    let began = false;
    const move = mv => {
      const [mx, my] = pos(mv);
      if (!began) {
        began = true; app.beginChange(); c.retime ||= pts();
        if (i < 0) { const t = Math.max(0.05, Math.min(c.duration - 0.05, T(x))); c.retime = addPoint(c.retime, t); i = c.retime.findIndex(p => Math.abs(p.t - t) < 1e-6); if (i <= 0) { i = -1; return; } }
      }
      if (i <= 0) return;
      c.retime = setPoint(c.retime, i, T(mx), Math.max(0, Math.min(srcLeft(), S(my))));
      c.speed = meanSpeed(c.retime);
      draw(i); app.changed({ light: true, keepInspector: true });
    };
    const up = () => { cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up); if (began) app.endChange({ keepInspector: true }); };
    cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up);
  });
  // ready-made curves (the clip keeps its length and plays the same part of the source)
  const preset = (label, kind, title) => el('button', { class: 'mini', text: label, title, onclick: () => insp.edit(() => {
    const src = pts()[pts().length - 1].s;
    c.retime = kind === 'linear' ? null : retimePreset(kind, c.duration, Math.min(src, srcLeft()));
    if (!c.retime) { delete c.retime; c.speed = src / c.duration; } else c.speed = meanSpeed(c.retime);
  }) });
  draw();
  return section('Retime curve',
    el('p', { class: 'note', text: 'Clip time across, source time up: steeper plays faster, flatter slower; the dashed line is normal speed. Drag a point, or press anywhere on the line and drag; double-click a point to remove it. Pitch is kept.' }),
    cv, read,
    el('div', { class: 'btn-row rt-presets' },
      preset('Ease in', 'easeIn', 'Starts slow and speeds up'), preset('Ease out', 'easeOut', 'Starts fast and slows down'),
      preset('Speed ramp', 'ramp', 'Slow, fast through the middle, slow again'), preset('Slow-mo middle', 'slowMiddle', 'Normal, slow through the middle, normal again'),
      preset('Straight', 'linear', 'Back to an even speed')),
    c.elastic ? null : el('p', { class: 'note', text: 'For sound, right-click the clip › Elastic Wave to drag markers right on the waveform.' }));
}
