// Animated graphic elements (Reel's own designs): lower thirds, call-out labels, bursts, rings, hand-drawn
// circles and arrows, underlines, check / cross marks, sparkles, confetti, a subscribe button, counters, a
// progress bar, speech bubbles and emoji pops. Each animates itself in and out; colours and text are
// editable. Drawn around the clip's position, sized by its scale (1 = designed for a 1080-high frame).

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeOut = k => 1 - (1 - k) ** 3;
const easeInOut = k => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
const back = k => { const c = 1.7; return 1 + (c + 1) * (k - 1) ** 3 + c * (k - 1) ** 2; };
const elastic = k => (k <= 0 ? 0 : k >= 1 ? 1 : 2 ** (-10 * k) * Math.sin((k * 10 - 0.75) * (2 * Math.PI) / 3) + 1);
const rnd = (i, s) => { const x = Math.sin(i * 127.1 + s * 311.7) * 43758.5453; return x - Math.floor(x); };
/** in-progress (0..1 over `len` s from the start) and out-progress (1..0 over the last `out` s). */
const io = (t, d, len = 0.6, out = 0.4) => [clamp(t / len, 0, 1), clamp((d - t) / out, 0, 1)];
const font = (w, size, fam = 'Avenir Next, Helvetica Neue, sans-serif') => `${w} ${size}px ${fam}`;

function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }

export const ELEMENTS = {
  // ---------------------------------------------------------------- lower thirds
  ltBar: { name: 'Lower third — bar', group: 'Lower thirds', box: [760, 150], defaults: { text: 'Your Name', sub: 'Title or role', color: '#ffb02a', accent: '#111111' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 0.8), k = Math.min(easeOut(ki), easeInOut(ko));
      ctx.font = font(800, 58); const tw = Math.max(380, ctx.measureText(e.text).width + 80);
      ctx.fillStyle = e.color; ctx.fillRect(-380, -60, 14, 120 * k);
      ctx.save(); ctx.beginPath(); ctx.rect(-366, -75, (tw + 40) * k, 150); ctx.clip();
      ctx.fillStyle = e.accent; ctx.globalAlpha *= 0.85; ctx.fillRect(-366, -60, tw, 74); ctx.globalAlpha /= 0.85;
      ctx.fillStyle = '#ffffff'; ctx.textBaseline = 'middle'; ctx.fillText(e.text, -336, -22);
      ctx.fillStyle = e.color; ctx.fillRect(-366, 14, tw * 0.7, 46);
      ctx.fillStyle = e.accent; ctx.font = font(700, 30); ctx.fillText(e.sub, -336, 38);
      ctx.restore();
    } },
  ltLine: { name: 'Lower third — line', group: 'Lower thirds', box: [760, 150], defaults: { text: 'Your Name', sub: 'Title or role', color: '#ffffff', accent: '#ffb02a' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 1), out = easeInOut(ko);
      const line = easeInOut(clamp(ki * 1.6, 0, 1)) * out, txt = clamp((ki - 0.35) / 0.65, 0, 1) * out;
      ctx.strokeStyle = e.accent; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(-370, 0); ctx.lineTo(-370 + 740 * line, 0); ctx.stroke();
      ctx.textBaseline = 'alphabetic'; ctx.globalAlpha *= txt;
      ctx.fillStyle = e.color; ctx.font = font(700, 56); ctx.fillText(e.text, -370, -18 + (1 - txt) * 30);
      ctx.fillStyle = e.accent; ctx.font = font(500, 30); ctx.textBaseline = 'top'; ctx.fillText(e.sub, -370, 18 - (1 - txt) * 20);
    } },
  ltPill: { name: 'Lower third — pill', group: 'Lower thirds', box: [700, 130], defaults: { text: 'Your Name', sub: '@handle', color: '#ffffff', accent: '#ff3b30' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 0.7), k = Math.min(back(ki), easeInOut(ko));
      ctx.font = font(800, 46); const w = Math.max(360, ctx.measureText(e.text).width + 230);
      ctx.save(); ctx.translate(-w / 2, 0); ctx.scale(Math.max(0.01, k), 1);
      ctx.fillStyle = e.color; roundRect(ctx, 0, -50, w, 100, 50); ctx.fill();
      ctx.fillStyle = e.accent; ctx.beginPath(); ctx.arc(50, 0, 36, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.globalAlpha *= clamp((ki - 0.4) / 0.6, 0, 1) * easeInOut(ko);
      ctx.fillStyle = '#111'; ctx.textBaseline = 'middle'; ctx.fillText(e.text, -w / 2 + 108, -12);
      ctx.font = font(600, 26); ctx.fillStyle = e.accent; ctx.fillText(e.sub, -w / 2 + 108, 26);
    } },
  ltStack: { name: 'Lower third — stacked boxes', group: 'Lower thirds', box: [700, 160], defaults: { text: 'YOUR NAME', sub: 'Title or role', color: '#ffffff', accent: '#2a7cff' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 0.9), o = easeInOut(ko);
      const a = easeOut(clamp(ki * 1.5, 0, 1)) * o, b = easeOut(clamp(ki * 1.5 - 0.35, 0, 1)) * o;
      ctx.font = font(900, 54); const w1 = ctx.measureText(e.text).width + 50;
      ctx.font = font(600, 30); const w2 = ctx.measureText(e.sub).width + 40;
      ctx.textBaseline = 'middle';
      ctx.save(); ctx.beginPath(); ctx.rect(-350, -70, w1 * a, 76); ctx.clip(); ctx.fillStyle = e.color; ctx.fillRect(-350, -70, w1, 76); ctx.fillStyle = '#111'; ctx.font = font(900, 54); ctx.fillText(e.text, -325, -32); ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.rect(-350, 12, w2 * b, 52); ctx.clip(); ctx.fillStyle = e.accent; ctx.fillRect(-350, 12, w2, 52); ctx.fillStyle = '#fff'; ctx.font = font(600, 30); ctx.fillText(e.sub, -330, 38); ctx.restore();
    } },
  // ---------------------------------------------------------------- call-outs
  calloutLabel: { name: 'Call-out label', group: 'Call-outs', box: [620, 260], defaults: { text: 'Look here', sub: '', color: '#ffffff', accent: '#ffb02a' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 0.9), o = easeInOut(ko);
      const dot = back(clamp(ki * 3, 0, 1)) * o, line = easeInOut(clamp(ki * 2 - 0.3, 0, 1)) * o, lab = easeOut(clamp(ki * 2 - 1, 0, 1)) * o;
      ctx.fillStyle = e.accent; ctx.beginPath(); ctx.arc(-260, 100, 16 * dot, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = e.accent; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(-260, 100, 30 * dot, 0, Math.PI * 2); ctx.globalAlpha *= 0.5; ctx.stroke(); ctx.globalAlpha /= 0.5;
      ctx.beginPath(); ctx.moveTo(-260, 100);
      const p1 = [-120, -40], p2 = [260, -40];
      const seg = line * 2;
      if (seg <= 1) ctx.lineTo(-260 + (p1[0] + 260) * seg, 100 + (p1[1] - 100) * seg); else { ctx.lineTo(...p1); ctx.lineTo(p1[0] + (p2[0] - p1[0]) * (seg - 1), p1[1]); }
      ctx.stroke();
      ctx.globalAlpha *= lab; ctx.fillStyle = e.color; ctx.font = font(800, 46); ctx.textBaseline = 'bottom'; ctx.fillText(e.text, -110, -52 + (1 - lab) * 20);
    } },
  speechBubble: { name: 'Speech bubble', group: 'Call-outs', box: [560, 300], defaults: { text: 'Hello!', sub: '', color: '#ffffff', accent: '#111111' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 0.5), k = Math.min(elastic(ki), easeInOut(ko));
      ctx.scale(Math.max(0.01, k), Math.max(0.01, k));
      ctx.fillStyle = e.color; ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 20; ctx.shadowOffsetY = 6;
      roundRect(ctx, -260, -130, 520, 220, 60); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-120, 80); ctx.lineTo(-170, 150); ctx.lineTo(-40, 88); ctx.fill();
      ctx.shadowColor = 'transparent'; ctx.fillStyle = e.accent; ctx.font = font(800, 64); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(e.text, 0, -20);
    } },
  // ---------------------------------------------------------------- shapes
  burst: { name: 'Burst', group: 'Shapes', box: [500, 500], defaults: { text: '', sub: '', color: '#ffd60a', accent: '#ffffff' },
    draw(ctx, e, t) {
      const k = clamp(t / 0.7, 0, 1), n = 14;
      ctx.strokeStyle = e.color; ctx.lineCap = 'round';
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2, r0 = 60 + 180 * easeOut(k), r1 = 60 + 230 * easeOut(clamp(k * 1.4, 0, 1));
        ctx.lineWidth = 14 * (1 - k) + 1; ctx.beginPath(); ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); ctx.stroke();
      }
      ctx.globalAlpha *= 1 - k; ctx.fillStyle = e.accent; ctx.beginPath(); ctx.arc(0, 0, 70 * back(clamp(k * 3, 0, 1)), 0, Math.PI * 2); ctx.fill();
    } },
  ringPop: { name: 'Ring pop', group: 'Shapes', box: [460, 460], defaults: { text: '', sub: '', color: '#ffb02a', accent: '#ffffff' },
    draw(ctx, e, t, d) {
      const k = clamp(t / 0.8, 0, 1), [, ko] = io(t, d);
      ctx.globalAlpha *= easeInOut(ko);
      ctx.strokeStyle = e.color; ctx.lineWidth = 22 * (1 - k * 0.8); ctx.beginPath(); ctx.arc(0, 0, 40 + 170 * easeOut(k), 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = e.accent; ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(0, 0, 30 + 120 * easeOut(clamp(k * 1.3 - 0.2, 0, 1)), 0, Math.PI * 2); ctx.stroke();
    } },
  circleDraw: { name: 'Hand-drawn circle', group: 'Shapes', box: [560, 340], defaults: { text: '', sub: '', color: '#ff3b30', accent: '#ffffff' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 0.7); ctx.globalAlpha *= easeInOut(ko);
      ctx.strokeStyle = e.color; ctx.lineWidth = 12; ctx.lineCap = 'round'; ctx.beginPath();
      const end = Math.PI * 2.15 * easeInOut(ki);
      for (let a = 0; a <= end; a += 0.04) { const r = 1 + 0.05 * Math.sin(a * 3 + 1); const x = Math.cos(a - 2) * 260 * r, y = Math.sin(a - 2) * 150 * r * (1 + a * 0.01); a ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke();
    } },
  arrowDraw: { name: 'Hand-drawn arrow', group: 'Shapes', box: [500, 300], defaults: { text: '', sub: '', color: '#ff3b30', accent: '#ffffff' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 0.6); ctx.globalAlpha *= easeInOut(ko);
      const k = easeInOut(ki);
      ctx.strokeStyle = e.color; ctx.lineWidth = 12; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); const pts = [];
      for (let i = 0; i <= 40; i++) { const u = i / 40; pts.push([-220 + 400 * u, 90 - 160 * u + Math.sin(u * Math.PI) * -60]); }
      const n = Math.max(1, Math.floor(pts.length * k));
      pts.slice(0, n).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
      if (k > 0.95) { const [x, y] = pts[pts.length - 1]; ctx.beginPath(); ctx.moveTo(x - 60, y - 6); ctx.lineTo(x, y); ctx.lineTo(x - 26, y + 52); ctx.stroke(); }
    } },
  underline: { name: 'Underline swipe', group: 'Shapes', box: [700, 80], defaults: { text: '', sub: '', color: '#ffd60a', accent: '#ffffff' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 0.5, 0.4), a = easeInOut(ki), b = 1 - easeInOut(ko);
      ctx.fillStyle = e.color; roundRect(ctx, -340 + 680 * b, -14, 680 * (a - b), 28, 14); ctx.fill();
    } },
  highlightBox: { name: 'Highlight box', group: 'Shapes', box: [620, 360], defaults: { text: '', sub: '', color: '#ffb02a', accent: '#ffffff' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 0.6); const k = easeInOut(ki); ctx.globalAlpha *= easeInOut(ko);
      ctx.strokeStyle = e.color; ctx.lineWidth = 10; ctx.lineJoin = 'round';
      const per = 2 * (600 + 340), L = per * k; ctx.beginPath(); ctx.moveTo(-300, -170);
      const seg = [[600, 0], [0, 340], [-600, 0], [0, -340]]; let x = -300, y = -170, left = L;
      for (const [dx, dy] of seg) { const len = Math.abs(dx + dy); const f = Math.min(1, left / len); x += dx * f; y += dy * f; ctx.lineTo(x, y); left -= len; if (left <= 0) break; }
      ctx.stroke();
    } },
  check: { name: 'Check mark', group: 'Shapes', box: [300, 300], defaults: { text: '', sub: '', color: '#34c759', accent: '#ffffff' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 0.6); ctx.globalAlpha *= easeInOut(ko);
      const c = back(clamp(ki * 2, 0, 1)), k = easeInOut(clamp(ki * 2 - 0.6, 0, 1));
      ctx.fillStyle = e.color; ctx.beginPath(); ctx.arc(0, 0, 130 * c, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = e.accent; ctx.lineWidth = 24; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath(); ctx.moveTo(-60, 0);
      if (k < 0.4) ctx.lineTo(-60 + 45 * (k / 0.4), 45 * (k / 0.4)); else { ctx.lineTo(-15, 45); ctx.lineTo(-15 + 85 * ((k - 0.4) / 0.6), 45 - 100 * ((k - 0.4) / 0.6)); }
      if (k > 0) ctx.stroke();
    } },
  cross: { name: 'Cross mark', group: 'Shapes', box: [300, 300], defaults: { text: '', sub: '', color: '#ff3b30', accent: '#ffffff' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 0.6); ctx.globalAlpha *= easeInOut(ko);
      const c = back(clamp(ki * 2, 0, 1)), k = easeInOut(clamp(ki * 2 - 0.6, 0, 1));
      ctx.fillStyle = e.color; ctx.beginPath(); ctx.arc(0, 0, 130 * c, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = e.accent; ctx.lineWidth = 24; ctx.lineCap = 'round';
      const a = clamp(k * 2, 0, 1), b = clamp(k * 2 - 1, 0, 1);
      ctx.beginPath(); ctx.moveTo(-50, -50); ctx.lineTo(-50 + 100 * a, -50 + 100 * a); if (a) ctx.stroke();
      ctx.beginPath(); ctx.moveTo(50, -50); ctx.lineTo(50 - 100 * b, -50 + 100 * b); if (b) ctx.stroke();
    } },
  sparkle: { name: 'Sparkles', group: 'Particles', box: [500, 500], defaults: { text: '', sub: '', color: '#fff3a0', accent: '#ffffff' },
    draw(ctx, e, t) {
      ctx.fillStyle = e.color;
      for (let i = 0; i < 9; i++) {
        const ph = (t * 1.3 + rnd(i, 1)) % 1, s = Math.sin(ph * Math.PI) * (30 + rnd(i, 2) * 40);
        const x = (rnd(i, 3) - 0.5) * 440, y = (rnd(i, 4) - 0.5) * 440;
        ctx.beginPath(); for (let k = 0; k < 8; k++) { const r = k % 2 ? s * 0.22 : s, a = (k / 8) * Math.PI * 2; ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); } ctx.fill();
      }
    } },
  confetti: { name: 'Confetti', group: 'Particles', box: [900, 700], defaults: { text: '', sub: '', color: '#ff3b30', accent: '#2a7cff' },
    draw(ctx, e, t) {
      const cols = [e.color, e.accent, '#ffd60a', '#34c759', '#ffffff'];
      for (let i = 0; i < 70; i++) {
        const vx = (rnd(i, 1) - 0.5) * 900, vy = -500 - rnd(i, 2) * 700, g = 1300;
        const x = vx * t, y = vy * t + 0.5 * g * t * t;
        if (y > 700) continue;
        ctx.save(); ctx.translate(x, y + 200); ctx.rotate(t * (4 + rnd(i, 3) * 8));
        ctx.fillStyle = cols[i % cols.length]; ctx.fillRect(-8, -4, 16, 8 + rnd(i, 4) * 10); ctx.restore();
      }
    } },
  // ---------------------------------------------------------------- social & info
  subscribe: { name: 'Subscribe button', group: 'Social', box: [620, 200], defaults: { text: 'SUBSCRIBE', sub: '', color: '#ff0000', accent: '#ffffff' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 0.5), k = Math.min(back(ki), easeInOut(ko));
      const clicked = t > 1.4, press = t > 1.2 && t < 1.45 ? 0.94 : 1;
      ctx.save(); ctx.scale(k * press, k * press);
      ctx.fillStyle = clicked ? '#606060' : e.color; roundRect(ctx, -250, -60, 500, 120, 60); ctx.fill();
      ctx.fillStyle = e.accent; ctx.font = font(800, 50); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(clicked ? 'SUBSCRIBED ✓' : e.text, 0, 2);
      ctx.restore();
      // the pointer comes in and clicks
      const pk = clamp((t - 0.6) / 0.6, 0, 1), px = 300 - 220 * easeInOut(pk), py = 160 - 140 * easeInOut(pk);
      if (t > 0.6 && ko > 0.5) {
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py + 60); ctx.lineTo(px + 16, py + 46); ctx.lineTo(px + 28, py + 72); ctx.lineTo(px + 38, py + 66); ctx.lineTo(px + 26, py + 42); ctx.lineTo(px + 46, py + 42); ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    } },
  counter: { name: 'Number counter', group: 'Info', box: [600, 220], defaults: { text: '1000', sub: 'subscribers', color: '#ffffff', accent: '#ffb02a' },
    draw(ctx, e, t, d) {
      const [, ko] = io(t, d); ctx.globalAlpha *= easeInOut(ko);
      const target = parseFloat(String(e.text).replace(/[^0-9.-]/g, '')) || 0, k = easeOut(clamp(t / Math.min(2, d * 0.6), 0, 1));
      const v = target * k, dec = /\./.test(e.text) ? 1 : 0;
      ctx.textAlign = 'center'; ctx.fillStyle = e.color; ctx.font = font(900, 120); ctx.textBaseline = 'middle';
      ctx.fillText(v.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec }), 0, -20);
      ctx.fillStyle = e.accent; ctx.font = font(700, 40); ctx.fillText(e.sub, 0, 70);
    } },
  progressBar: { name: 'Progress bar', group: 'Info', box: [900, 120], defaults: { text: 'Loading', sub: '', color: '#ffb02a', accent: '#222222' },
    draw(ctx, e, t, d) {
      const k = easeInOut(clamp(t / Math.max(0.5, d - 0.4), 0, 1));
      ctx.fillStyle = e.accent; roundRect(ctx, -420, -18, 840, 36, 18); ctx.fill();
      ctx.fillStyle = e.color; roundRect(ctx, -420, -18, Math.max(36, 840 * k), 36, 18); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = font(700, 34); ctx.textBaseline = 'bottom'; ctx.fillText(`${e.text} ${Math.round(k * 100)}%`, -420, -30);
    } },
  emojiPop: { name: 'Emoji pop', group: 'Social', box: [300, 300], defaults: { text: '🔥', sub: '', color: '#ffffff', accent: '#ffffff' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 0.5), k = Math.min(elastic(ki), easeInOut(ko));
      ctx.rotate(Math.sin(t * 6) * 0.08); ctx.scale(Math.max(0.01, k), Math.max(0.01, k));
      ctx.font = font(400, 220, 'Apple Color Emoji, Segoe UI Emoji, sans-serif'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(e.text, 0, 10);
    } },
};

/** Draws an element clip into a W×H frame. p: position props (x, y, scale, rotation, opacity). */
export function drawElement(ctx, el, p, t, d, W, H) {
  const def = ELEMENTS[el.kind]; if (!def) return;
  const e = { ...def.defaults, ...el };
  const u = (Math.min(W, H) / 1080) * (p.scale ?? 1);
  ctx.save();
  ctx.globalAlpha = clamp(p.opacity ?? 1, 0, 1);
  ctx.translate((p.x ?? 0.5) * W, (p.y ?? 0.5) * H);
  if (p.rotation) ctx.rotate((p.rotation * Math.PI) / 180);
  ctx.scale(u, u);
  ctx.textAlign = 'left';
  try { def.draw(ctx, e, t, d); } finally { ctx.restore(); }
}
/** Size of an element's box on a W×H frame (for the selection box). */
export function elementBox(el, p, W, H) {
  const def = ELEMENTS[el.kind]; const [bw, bh] = def ? def.box : [400, 200];
  const u = (Math.min(W, H) / 1080) * (p.scale ?? 1);
  return { w: bw * u, h: bh * u };
}
/** Where an element sits by default (lower thirds low on the left; the rest in the middle). */
export function elementHome(kind) {
  const g = ELEMENTS[kind]?.group;
  return g === 'Lower thirds' ? { x: 0.3, y: 0.82 } : kind === 'subscribe' ? { x: 0.5, y: 0.8 } : kind === 'progressBar' ? { x: 0.5, y: 0.88 } : { x: 0.5, y: 0.5 };
}
