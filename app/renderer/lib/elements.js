// Animated graphic elements (Reel's own designs): lower thirds, call-out labels, bursts, rings, hand-drawn
// circles and arrows, underlines, check / cross marks, sparkles, confetti, a subscribe button, counters, a
// progress bar, speech bubbles and emoji pops. Each animates itself in and out; colours and text are
// editable. Drawn around the clip's position, sized by its scale (1 = designed for a 1080-high frame).

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeOut = k => 1 - (1 - k) ** 3;
const easeInOut = k => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
const back = k => { const c = 1.7; return 1 + (c + 1) * (k - 1) ** 3 + c * (k - 1) ** 2; };
const elastic = k => (k <= 0 ? 0 : k >= 1 ? 1 : 2 ** (-10 * k) * Math.sin((k * 10 - 0.75) * (2 * Math.PI) / 3) + 1);
/** #rrggbb with an alpha, as rgba(). */
const hexAlpha = (h, a) => { const n = parseInt(String(h || '#000').replace('#', '').slice(0, 6), 16) || 0; return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
/** A visualizer's loudness (0..1) at element time t, from its sound envelope (25 per second), smoothed. */
const VIZ_RATE = 25;
function vizLevel(e, t) {
  const env = e.env || [];
  if (!env.length) return 0.35 + 0.25 * Math.sin(t * 6) * Math.sin(t * 2.3); // no sound measured yet: a gentle idle
  const f = Math.max(0, t) * VIZ_RATE, i = Math.floor(f), u = f - i;
  const a = env[Math.min(env.length - 1, i)] || 0, b = env[Math.min(env.length - 1, i + 1)] || 0;
  return Math.min(1, a + (b - a) * u);
}
export { VIZ_RATE };
/** Motion backgrounds draw with the pictures (under the video), not on top like the other elements. */
export const isBackgroundElement = el => ELEMENTS[el?.kind]?.group === 'Backgrounds';
const rnd = (i, s) => { const x = Math.sin(i * 127.1 + s * 311.7) * 43758.5453; return x - Math.floor(x); };
/** in-progress (0..1 over `len` s from the start) and out-progress (1..0 over the last `out` s). */
const io = (t, d, len = 0.6, out = 0.4) => [clamp(t / len, 0, 1), clamp((d - t) / out, 0, 1)];
const font = (w, size, fam = 'Avenir Next, Helvetica Neue, sans-serif') => `${w} ${size}px ${fam}`;

function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }

/** The arrow pointer that comes in and clicks (tip at px, py). */
function pointer(ctx, px, py, down = false) {
  ctx.save(); ctx.translate(px, py); if (down) ctx.scale(0.9, 0.9);
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 60); ctx.lineTo(16, 46); ctx.lineTo(28, 72); ctx.lineTo(38, 66); ctx.lineTo(26, 42); ctx.lineTo(46, 42); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore();
}
const EMOJI = size => `${size}px Apple Color Emoji, Segoe UI Emoji, sans-serif`;
/** A rounded pill with a label (optionally an emoji in front), centred at x, y. */
function pill(ctx, x, y, w, h, fill, ink, text, emoji = '', size = 44) {
  ctx.fillStyle = fill; roundRect(ctx, x - w / 2, y - h / 2, w, h, h / 2); ctx.fill();
  ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  if (emoji) {
    ctx.font = font(800, size); const tw = ctx.measureText(text).width, ew = size * 1.15, gap = text ? 12 : 0;
    const x0 = x - (tw + ew + gap) / 2;
    ctx.font = EMOJI(size); ctx.textAlign = 'left'; ctx.fillText(emoji, x0, y + 2);
    ctx.fillStyle = ink; ctx.font = font(800, size); ctx.fillText(text, x0 + ew + gap, y + 2);
  } else { ctx.fillStyle = ink; ctx.font = font(800, size); ctx.fillText(text, x, y + 2); }
}

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
  // A card with a title and a list (ingredients, steps, a tip), one item at a time. One item per line of text.
  noteCard: { name: 'Note card (list)', group: 'Call-outs', box: [760, 460], multiline: true,
    defaults: { text: 'Two eggs\nOne cup of flour\nA pinch of salt', sub: 'INGREDIENTS', color: '#ffffff', accent: '#ffb02a' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 0.5, 0.45), k = easeOut(ki), o = easeInOut(ko);
      const W = 760, pad = 40, lh = 58, maxW = W - pad * 2 - 44;
      ctx.font = font(650, 42);
      const lines = []; // { txt, item (its number), first (first line of that item) }
      String(e.text || '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, 10).forEach((itemText, n) => {
        let cur = '', first = true;
        for (const w of itemText.split(/\s+/)) {
          const tryLine = cur ? `${cur} ${w}` : w;
          if (cur && ctx.measureText(tryLine).width > maxW) { lines.push({ txt: cur, item: n, first }); first = false; cur = w; } else cur = tryLine;
        }
        if (cur) lines.push({ txt: cur, item: n, first });
      });
      const head = e.sub ? 62 : 0, H = pad * 2 + head + Math.max(1, lines.length) * lh - 10;
      ctx.globalAlpha *= k * o;
      ctx.translate((1 - k) * 70, 0);
      ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 30; ctx.shadowOffsetY = 10;
      ctx.fillStyle = 'rgba(18,18,20,.86)'; roundRect(ctx, -W / 2, -H / 2, W, H, 22); ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = e.accent; roundRect(ctx, -W / 2, -H / 2, 10, H, [22, 0, 0, 22]); ctx.fill();
      let y = -H / 2 + pad;
      ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      if (e.sub) {
        ctx.fillStyle = e.accent; ctx.font = font(800, 30);
        if ('letterSpacing' in ctx) ctx.letterSpacing = '4px';
        ctx.fillText(String(e.sub).toUpperCase(), -W / 2 + pad + 8, y);
        if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
        y += head;
      }
      // items come in one after another
      for (const { txt, item, first } of lines) {
        const a = easeOut(clamp((t - 0.35 - item * 0.22) / 0.35, 0, 1));
        ctx.save(); ctx.globalAlpha *= a; ctx.translate((1 - a) * 24, 0);
        if (first) { ctx.fillStyle = e.accent; ctx.beginPath(); ctx.arc(-W / 2 + pad + 18, y + 22, 8, 0, Math.PI * 2); ctx.fill(); }
        ctx.fillStyle = e.color; ctx.font = font(650, 42); ctx.fillText(txt, -W / 2 + pad + 44, y);
        ctx.restore();
        y += lh;
      }
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
  // ---------------------------------------------------------------- motion backgrounds (full frame, looping)
  bgFlow: { name: 'Gradient flow', group: 'Backgrounds', box: [1920, 1080], defaults: { text: '', sub: '', color: '#2a1a6e', accent: '#ff6a3d' },
    draw(ctx, e, t) {
      ctx.fillStyle = e.color; ctx.fillRect(-960, -540, 1920, 1080);
      const cols = [e.accent, e.color, '#ffffff'];
      for (let i = 0; i < 4; i++) {
        const x = Math.sin(t * 0.21 + i * 1.7) * 700, y = Math.cos(t * 0.17 + i * 2.3) * 380, r = 520 + 160 * Math.sin(t * 0.3 + i);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, hexAlpha(cols[i % 3], i === 2 ? 0.18 : 0.75)); g.addColorStop(1, hexAlpha(cols[i % 3], 0));
        ctx.fillStyle = g; ctx.fillRect(-960, -540, 1920, 1080);
      }
    } },
  bgBokeh: { name: 'Bokeh lights', group: 'Backgrounds', box: [1920, 1080], defaults: { text: '', sub: '', color: '#0b1020', accent: '#ffb347' },
    draw(ctx, e, t) {
      ctx.fillStyle = e.color; ctx.fillRect(-960, -540, 1920, 1080);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 36; i++) {
        const sp = 0.02 + rnd(i, 5) * 0.05, x = ((rnd(i, 1) + t * sp) % 1) * 2200 - 1100, y = (rnd(i, 2) - 0.5) * 1080 + Math.sin(t * 0.4 + i) * 30;
        const r = 30 + rnd(i, 3) * 110, a = 0.08 + 0.18 * (0.5 + 0.5 * Math.sin(t * (0.6 + rnd(i, 4)) + i));
        const g = ctx.createRadialGradient(x, y, r * 0.6, x, y, r);
        g.addColorStop(0, hexAlpha(i % 3 ? e.accent : '#ffffff', a)); g.addColorStop(1, hexAlpha(e.accent, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    } },
  bgGrid: { name: 'Tech grid', group: 'Backgrounds', box: [1920, 1080], defaults: { text: '', sub: '', color: '#06121f', accent: '#2ad1ff' },
    draw(ctx, e, t) {
      ctx.fillStyle = e.color; ctx.fillRect(-960, -540, 1920, 1080);
      const step = 80, off = (t * 30) % step;
      ctx.strokeStyle = hexAlpha(e.accent, 0.18); ctx.lineWidth = 1.5;
      for (let x = -960 - off; x < 960; x += step) { ctx.beginPath(); ctx.moveTo(x, -540); ctx.lineTo(x, 540); ctx.stroke(); }
      for (let y = -540 + off; y < 540; y += step) { ctx.beginPath(); ctx.moveTo(-960, y); ctx.lineTo(960, y); ctx.stroke(); }
      for (let i = 0; i < 14; i++) { // pulses running along the lines
        const k = (t * 0.25 + rnd(i, 1)) % 1, row = Math.floor(rnd(i, 2) * 13) - 6;
        const x = -960 + k * 1920, y = row * step + off;
        const g = ctx.createRadialGradient(x, y, 0, x, y, 40); g.addColorStop(0, hexAlpha(e.accent, 0.9)); g.addColorStop(1, hexAlpha(e.accent, 0));
        ctx.fillStyle = g; ctx.fillRect(x - 40, y - 40, 80, 80);
      }
      const v = ctx.createRadialGradient(0, 0, 300, 0, 0, 1100); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.65)');
      ctx.fillStyle = v; ctx.fillRect(-960, -540, 1920, 1080);
    } },
  bgWaves: { name: 'Soft waves', group: 'Backgrounds', box: [1920, 1080], defaults: { text: '', sub: '', color: '#101828', accent: '#7c5cff' },
    draw(ctx, e, t) {
      ctx.fillStyle = e.color; ctx.fillRect(-960, -540, 1920, 1080);
      for (let k = 0; k < 5; k++) {
        ctx.beginPath(); ctx.moveTo(-960, 540);
        for (let x = -960; x <= 960; x += 24) ctx.lineTo(x, 120 + k * 70 + Math.sin(x * 0.004 + t * (0.5 + k * 0.12) + k) * (60 - k * 6));
        ctx.lineTo(960, 540); ctx.closePath();
        ctx.fillStyle = hexAlpha(e.accent, 0.1 + k * 0.05); ctx.fill();
      }
    } },
  // ---------------------------------------------------------------- audio visualizers (they follow the sound under them)
  vizBars: { name: 'Audio bars', group: 'Audio visualizers', box: [1200, 360], defaults: { text: '', sub: '', color: '#ffb02a', accent: '#ff3b30', env: [] },
    draw(ctx, e, t) { const lv = vizLevel(e, t); const n = 40, w = 1200 / n;
      for (let i = 0; i < n; i++) {
        const shape = 0.35 + 0.65 * Math.sin(Math.PI * (i + 0.5) / n), wob = 0.55 + 0.45 * Math.abs(Math.sin(t * (3 + rnd(i, 1) * 5) + i));
        const h = Math.max(6, lv * shape * wob * 340);
        const g = ctx.createLinearGradient(0, 180, 0, 180 - h); g.addColorStop(0, e.color); g.addColorStop(1, e.accent);
        ctx.fillStyle = g; ctx.fillRect(-600 + i * w + 3, 180 - h, w - 6, h);
      }
    } },
  vizWave: { name: 'Audio wave', group: 'Audio visualizers', box: [1200, 300], defaults: { text: '', sub: '', color: '#ffffff', accent: '#2ad1ff', env: [] },
    draw(ctx, e, t) {
      ctx.lineWidth = 6; ctx.lineCap = 'round';
      for (const [col, ph, a] of [[e.accent, 0.7, 0.5], [e.color, 0, 1]]) {
        ctx.strokeStyle = col; ctx.globalAlpha = a; ctx.beginPath();
        for (let x = -600; x <= 600; x += 8) {
          const lv = vizLevel(e, t - (x + 600) / 1200 * 0.5), env = Math.sin(Math.PI * (x + 600) / 1200);
          ctx.lineTo(x, Math.sin(x * 0.045 + t * 9 + ph) * lv * env * 130);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } },
  vizCircle: { name: 'Audio ring', group: 'Audio visualizers', box: [600, 600], defaults: { text: '', sub: '', color: '#ffb02a', accent: '#ffffff', env: [] },
    draw(ctx, e, t) { const lv = vizLevel(e, t), n = 64;
      ctx.strokeStyle = e.color; ctx.lineWidth = 8; ctx.lineCap = 'round';
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2, wob = 0.4 + 0.6 * Math.abs(Math.sin(t * (2 + rnd(i, 1) * 4) + i * 0.7));
        const r0 = 170, r1 = r0 + 20 + lv * wob * 110;
        ctx.beginPath(); ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); ctx.stroke();
      }
      ctx.fillStyle = hexAlpha(e.accent, 0.12 + lv * 0.25); ctx.beginPath(); ctx.arc(0, 0, 150 + lv * 12, 0, Math.PI * 2); ctx.fill();
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
  likeButton: { name: 'Like button', group: 'Social', box: [420, 200], defaults: { text: 'LIKE', sub: '', color: '#272727', accent: '#ffffff' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 0.5), k = Math.min(back(ki), easeInOut(ko));
      const clicked = t > 1.3, press = t > 1.1 && t < 1.35 ? 0.92 : 1, pop = clicked ? 1 + 0.12 * Math.max(0, 1 - (t - 1.3) * 3) : 1;
      ctx.save(); ctx.scale(k * press * pop, k * press * pop);
      pill(ctx, 0, 0, 330, 110, clicked ? '#3ea6ff' : e.color, e.accent, clicked ? 'LIKED' : e.text, '👍', 46);
      ctx.restore();
      if (clicked && t < 2.4) { ctx.globalAlpha = clamp(1 - (t - 1.3) / 1.1, 0, 1) * ko; ctx.fillStyle = '#3ea6ff'; ctx.font = font(900, 40); ctx.textAlign = 'center'; ctx.fillText('+1', 120, -70 - (t - 1.3) * 60); ctx.globalAlpha = 1; }
      const pk = clamp((t - 0.5) / 0.6, 0, 1);
      if (t > 0.5 && ko > 0.5) pointer(ctx, 260 - 200 * easeInOut(pk), 150 - 140 * easeInOut(pk), t > 1.1 && t < 1.35);
    } },
  bell: { name: 'Notification bell', group: 'Social', box: [760, 200], defaults: { text: 'Turn on notifications', sub: '', color: '#272727', accent: '#ffffff' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 0.5), k = Math.min(back(ki), easeInOut(ko));
      const on = t > 1.4, ring = on ? Math.sin((t - 1.4) * 22) * 0.35 * Math.max(0, 1 - (t - 1.4) * 1.2) : Math.sin(t * 6) * 0.08;
      ctx.save(); ctx.scale(k, k);
      ctx.fillStyle = e.color; roundRect(ctx, -340, -60, 680, 120, 60); ctx.fill();
      ctx.save(); ctx.translate(-270, 0); ctx.rotate(ring); ctx.font = EMOJI(64); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(on ? '🔔' : '🔕', 0, 4); ctx.restore();
      ctx.fillStyle = e.accent; ctx.font = font(800, 40); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(on ? 'Notifications on ✓' : e.text, -205, 3);
      ctx.restore();
      const pk = clamp((t - 0.6) / 0.6, 0, 1);
      if (t > 0.6 && ko > 0.5) pointer(ctx, -120 - 150 * easeInOut(pk), 150 - 140 * easeInOut(pk), t > 1.2 && t < 1.45);
    } },
  likeSubscribe: { name: 'Like · Subscribe · Bell', group: 'Social', box: [1240, 220], defaults: { text: 'SUBSCRIBE', sub: 'LIKE', color: '#ff0000', accent: '#ffffff' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 0.5), k = Math.min(back(ki), easeInOut(ko));
      const liked = t > 1.1, subbed = t > 1.9, rung = t > 2.7;
      const tap = (at) => (t > at - 0.15 && t < at + 0.05 ? 0.92 : 1);
      ctx.save(); ctx.scale(k, k);
      ctx.save(); ctx.translate(-400, 0); ctx.scale(tap(1.1), tap(1.1)); pill(ctx, 0, 0, 300, 110, liked ? '#3ea6ff' : '#272727', '#fff', liked ? 'LIKED' : (e.sub || 'LIKE'), '👍', 42); ctx.restore();
      ctx.save(); ctx.translate(40, 0); ctx.scale(tap(1.9), tap(1.9)); pill(ctx, 0, 0, 480, 110, subbed ? '#606060' : e.color, e.accent, subbed ? 'SUBSCRIBED ✓' : e.text, '', 46); ctx.restore();
      ctx.save(); ctx.translate(420, 0); ctx.scale(tap(2.7), tap(2.7)); ctx.fillStyle = rung ? '#3ea6ff' : '#272727'; ctx.beginPath(); ctx.arc(0, 0, 55, 0, Math.PI * 2); ctx.fill();
      ctx.rotate(rung ? Math.sin((t - 2.7) * 22) * 0.35 * Math.max(0, 1 - (t - 2.7) * 1.2) : 0); ctx.font = EMOJI(54); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('🔔', 0, 4); ctx.restore();
      ctx.restore();
      // the pointer visits each in turn
      const stops = [[-400, 20, 1.1], [40, 20, 1.9], [420, 20, 2.7]];
      if (t > 0.5 && ko > 0.5) {
        let px = -300, py = 170;
        let prev = [-300, 170, 0.5];
        for (const s of stops) {
          if (t <= s[2]) { const q = easeInOut(clamp((t - prev[2]) / (s[2] - prev[2] - 0.1), 0, 1)); px = prev[0] + (s[0] - prev[0]) * q; py = prev[1] + (s[1] - prev[1]) * q; break; }
          prev = s; px = s[0]; py = s[1];
        }
        pointer(ctx, px, py, stops.some(s => t > s[2] - 0.15 && t < s[2] + 0.05));
      }
    } },
  follow: { name: 'Follow button', group: 'Social', box: [480, 180], defaults: { text: 'FOLLOW', sub: '', color: '#fe2c55', accent: '#ffffff' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 0.45), k = Math.min(back(ki), easeInOut(ko));
      const done = t > 1.2, press = t > 1.0 && t < 1.25 ? 0.92 : 1;
      ctx.save(); ctx.scale(k * press, k * press);
      pill(ctx, 0, 0, 400, 104, done ? '#3a3a3a' : e.color, e.accent, done ? '✓ FOLLOWING' : '+ ' + e.text, '', 44);
      ctx.restore();
      const pk = clamp((t - 0.4) / 0.55, 0, 1);
      if (t > 0.4 && ko > 0.5) pointer(ctx, 230 - 170 * easeInOut(pk), 140 - 125 * easeInOut(pk), t > 1.0 && t < 1.25);
    } },
  commentPrompt: { name: 'Comment prompt', group: 'Social', box: [900, 220], defaults: { text: 'Tell me in the comments!', sub: '', color: '#ffffff', accent: '#111111' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 0.5), k = Math.min(back(ki), easeInOut(ko));
      ctx.save(); ctx.scale(k, k);
      ctx.fillStyle = e.color; roundRect(ctx, -420, -80, 840, 140, 40); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-300, 58); ctx.lineTo(-340, 110); ctx.lineTo(-250, 58); ctx.closePath(); ctx.fill();
      ctx.font = EMOJI(60); ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.fillText('💬', -340, -8);
      ctx.fillStyle = e.accent; ctx.textAlign = 'left';
      if (t < 1.05) { for (let i = 0; i < 3; i++) { ctx.globalAlpha = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 9 - i)); ctx.beginPath(); ctx.arc(-240 + i * 40, -8, 12, 0, Math.PI * 2); ctx.fill(); } ctx.globalAlpha = 1; }
      else { const n = Math.max(1, Math.ceil(clamp((t - 1.0) / 1.0, 0, 1) * e.text.length)); ctx.font = font(800, 46); ctx.fillText(e.text.slice(0, n), -270, -6); }
      ctx.restore();
    } },
  endCard: { name: 'End screen (watch next)', group: 'Social', box: [1700, 900], defaults: { text: 'THANKS FOR WATCHING', sub: 'WATCH NEXT', color: '#ff0000', accent: '#ffffff', img1: '', img2: '', cap1: '', cap2: '' },
    // each box can show a picture of your own (a thumbnail of the video to watch next) with its own caption
    slots: [{ key: 'img1', cap: 'cap1', label: 'Left box' }, { key: 'img2', cap: 'cap2', label: 'Right box' }],
    draw(ctx, e, t, d, img) {
      const [ki, ko] = io(t, d, 0.8, 0.6), k = Math.min(easeOut(ki), easeInOut(ko));
      ctx.save(); ctx.globalAlpha *= k;
      ctx.fillStyle = e.accent; ctx.font = font(900, 70); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(e.text, 0, -360 + (1 - k) * -40);
      // two "watch next" boxes and a subscribe circle, where YouTube's end-screen elements go
      const box = (x, i) => {
        const kk = easeOut(clamp((t - 0.4 - i * 0.2) / 0.6, 0, 1));
        ctx.save(); ctx.translate(x, 20); ctx.scale(kk, kk);
        const pic = img && img(i === 0 ? e.img1 : e.img2), cap = (i === 0 ? e.cap1 : e.cap2) || '';
        ctx.fillStyle = 'rgba(0,0,0,0.55)'; roundRect(ctx, -330, -186, 660, 372, 22); ctx.fill();
        if (pic) {
          // the picture fills the box (cropped to fit), with the caption on a shade along the bottom
          ctx.save(); roundRect(ctx, -330, -186, 660, 372, 22); ctx.clip();
          const iw = pic.width || pic.naturalWidth, ih = pic.height || pic.naturalHeight, sc = Math.max(660 / iw, 372 / ih);
          ctx.drawImage(pic, -iw * sc / 2, -ih * sc / 2, iw * sc, ih * sc);
          if (cap) {
            const g = ctx.createLinearGradient(0, 70, 0, 186); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.8)');
            ctx.fillStyle = g; ctx.fillRect(-330, 70, 660, 116);
            ctx.fillStyle = '#fff'; ctx.font = font(800, 36); ctx.fillText(cap, 0, 140, 600);
          }
          ctx.restore();
        } else {
          ctx.fillStyle = e.accent; ctx.font = font(800, 40); ctx.fillText(cap || e.sub, 0, 0); ctx.font = EMOJI(54); ctx.fillText('▶️', 0, -80);
        }
        ctx.strokeStyle = e.accent; ctx.lineWidth = 6; roundRect(ctx, -330, -186, 660, 372, 22); ctx.stroke();
        ctx.restore();
      };
      box(-380, 0); box(380, 1);
      const kc = back(clamp((t - 0.9) / 0.6, 0, 1));
      ctx.save(); ctx.translate(0, 330); ctx.scale(kc, kc); pill(ctx, 0, 0, 440, 100, e.color, '#fff', 'SUBSCRIBE', '', 42); ctx.restore();
      ctx.restore();
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
  // ---------------------------------------------------------------- style packs (1.7.0)
  docLower: { name: 'Lower third — documentary', group: 'Lower thirds', box: [900, 170], defaults: { text: 'Serengeti, Tanzania', sub: 'THE GREAT MIGRATION', color: '#ffffff', accent: '#d4a64a' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 1.4, 0.6), out = easeInOut(ko);
      const line = easeInOut(clamp(ki * 1.5, 0, 1)), txt = easeOut(clamp((ki - 0.3) / 0.7, 0, 1));
      ctx.globalAlpha *= out;
      ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 14;
      ctx.fillStyle = e.accent; ctx.fillRect(-430, -2, 640 * line, 3);
      ctx.save(); ctx.globalAlpha *= txt;
      ctx.fillStyle = e.color; ctx.font = `italic 400 64px Georgia, 'Times New Roman', serif`; ctx.textBaseline = 'alphabetic'; ctx.fillText(e.text, -430, -22 + (1 - txt) * 14);
      ctx.fillStyle = e.accent; ctx.font = font(600, 26); ctx.textBaseline = 'top';
      let x = -430; for (const ch of String(e.sub)) { ctx.fillText(ch, x, 20 - (1 - txt) * 10); x += ctx.measureText(ch).width + 5; } // spaced small caps
      ctx.restore();
    } },
  locStamp: { name: 'Location stamp (typed)', group: 'Info', box: [820, 150], defaults: { text: 'NAIROBI, KENYA', sub: '14 MARCH 2026', color: '#ffffff', accent: '#d4a64a' },
    draw(ctx, e, t, d) {
      const [, ko] = io(t, d, 0.5, 0.5); ctx.globalAlpha *= easeInOut(ko);
      const a = String(e.text), b = String(e.sub), n = Math.floor(t * 20), na = Math.min(a.length, n), nb = clamp(n - a.length - 4, 0, b.length);
      ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 10;
      ctx.fillStyle = e.accent; ctx.fillRect(-400, -46, 8, na ? 96 : 0);
      ctx.font = `600 46px Menlo, 'Courier New', monospace`; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = e.color;
      ctx.fillText(a.slice(0, na), -372, -4);
      ctx.font = `500 30px Menlo, 'Courier New', monospace`; ctx.fillStyle = e.accent; ctx.fillText(b.slice(0, nb), -372, 42);
      const blink = Math.floor(t * 2.5) % 2 === 0, typingA = na < a.length;
      if (blink || n < a.length + b.length + 4) {
        ctx.font = `600 ${typingA ? 46 : 30}px Menlo, monospace`;
        const x = -372 + ctx.measureText(typingA ? a.slice(0, na) : b.slice(0, nb)).width + 4;
        ctx.fillStyle = e.color; ctx.fillRect(x, typingA ? -40 : 14, typingA ? 24 : 16, typingA ? 42 : 30);
      }
    } },
  mapPin: { name: 'Map pin', group: 'Call-outs', box: [520, 420], defaults: { text: 'Base camp', sub: '', color: '#ff3b30', accent: '#ffffff' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 0.7), k = back(clamp(ki, 0, 1)), out = easeInOut(ko);
      ctx.globalAlpha *= out;
      const ring = (t * 0.9) % 1; // pulse on the ground
      ctx.strokeStyle = hexAlpha(e.color, 0.8 * (1 - ring)); ctx.lineWidth = 5;
      ctx.beginPath(); ctx.ellipse(0, 110, 20 + ring * 90, (20 + ring * 90) * 0.35, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.save(); ctx.translate(0, -260 * (1 - k));
      ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 6;
      ctx.fillStyle = e.color; ctx.beginPath(); ctx.arc(0, -10, 52, Math.PI * 0.82, Math.PI * 2.18); ctx.lineTo(0, 108); ctx.closePath(); ctx.fill();
      ctx.shadowColor = 'transparent'; ctx.fillStyle = e.accent; ctx.beginPath(); ctx.arc(0, -10, 20, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      if (e.text) {
        const lk = clamp((ki - 0.5) / 0.5, 0, 1); ctx.globalAlpha *= lk;
        ctx.font = font(800, 40); const w = ctx.measureText(e.text).width + 44;
        ctx.fillStyle = 'rgba(15,15,18,0.82)'; roundRect(ctx, 76, -80, w, 64, 32); ctx.fill();
        ctx.fillStyle = e.accent; ctx.textBaseline = 'middle'; ctx.fillText(e.text, 98, -47);
      }
    } },
  routeMap: { name: 'Travel route map', group: 'Info', box: [1240, 720], defaults: { text: 'Lisbon', sub: 'Marrakesh', color: '#f1e5c8', accent: '#e5484d' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 0.6, 0.5), out = easeInOut(ko), s = 0.92 + 0.08 * easeOut(ki);
      ctx.globalAlpha *= Math.min(easeOut(ki), out); ctx.scale(s, s);
      ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 30; ctx.shadowOffsetY = 10;
      ctx.fillStyle = e.color; roundRect(ctx, -600, -340, 1200, 680, 28); ctx.fill(); ctx.shadowColor = 'transparent';
      ctx.save(); roundRect(ctx, -600, -340, 1200, 680, 28); ctx.clip();
      ctx.fillStyle = '#b9d7e0'; ctx.fillRect(-600, -340, 1200, 680); // sea
      ctx.fillStyle = e.color; // land: a few soft blobs, the same every time
      for (let i = 0; i < 7; i++) { const x = -560 + rnd(i, 21) * 1120, y = -300 + rnd(i, 22) * 600, r = 120 + rnd(i, 23) * 170; ctx.beginPath(); ctx.ellipse(x, y, r, r * (0.55 + rnd(i, 24) * 0.4), rnd(i, 25) * 3, 0, Math.PI * 2); ctx.fill(); }
      ctx.strokeStyle = 'rgba(80,70,50,0.12)'; ctx.lineWidth = 2;
      for (let x = -600; x <= 600; x += 100) { ctx.beginPath(); ctx.moveTo(x, -340); ctx.lineTo(x, 340); ctx.stroke(); }
      for (let y = -340; y <= 340; y += 100) { ctx.beginPath(); ctx.moveTo(-600, y); ctx.lineTo(600, y); ctx.stroke(); }
      ctx.restore();
      const A = [-380, 120], B = [390, -110], C = [0, -300], k = easeInOut(clamp((t - 0.5) / Math.max(0.6, Math.min(2.4, d - 1.2)), 0, 1));
      const at = u => [(1 - u) ** 2 * A[0] + 2 * (1 - u) * u * C[0] + u * u * B[0], (1 - u) ** 2 * A[1] + 2 * (1 - u) * u * C[1] + u * u * B[1]];
      ctx.strokeStyle = e.accent; ctx.lineWidth = 7; ctx.setLineDash([18, 14]); ctx.lineCap = 'round';
      ctx.beginPath(); for (let i = 0; i <= 60; i++) { const u = (i / 60) * k, [x, y] = at(u); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke(); ctx.setLineDash([]);
      const dot = (p, label, on) => {
        ctx.globalAlpha *= on; ctx.fillStyle = e.accent; ctx.beginPath(); ctx.arc(p[0], p[1], 16, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(p[0], p[1], 6, 0, Math.PI * 2); ctx.fill();
        ctx.font = font(800, 38); ctx.fillStyle = '#2a2318'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(label, p[0], p[1] + 26); ctx.textAlign = 'left';
        ctx.globalAlpha /= on || 1;
      };
      dot(A, e.text, 1); dot(B, e.sub, clamp(k * 4 - 3, 0.001, 1));
      if (k > 0 && k < 1) { const [x, y] = at(k), [x2, y2] = at(Math.min(1, k + 0.01)); ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(y2 - y, x2 - x));
        ctx.fillStyle = '#2a2318'; ctx.beginPath(); ctx.moveTo(26, 0); ctx.lineTo(-18, -16); ctx.lineTo(-10, 0); ctx.lineTo(-18, 16); ctx.closePath(); ctx.fill(); ctx.restore(); }
    } },
  bubbles: { name: 'Fizz bubbles', group: 'Particles', box: [1920, 1080], defaults: { text: '', sub: '', color: '#ffffff', accent: '#bfe9ff' },
    draw(ctx, e, t, d, _img, FW = 1920, FH = 1080) {
      const [ki, ko] = io(t, d, 0.3, 0.4); ctx.globalAlpha *= Math.min(ki, ko);
      for (let i = 0; i < 70; i++) {
        const r = 4 + rnd(i, 31) ** 2 * 26, sp = 140 + rnd(i, 32) * 320, y = FH / 2 + 40 - ((t * sp + rnd(i, 33) * (FH + 80)) % (FH + 80));
        const x = (rnd(i, 34) - 0.5) * FW + Math.sin(t * (2 + rnd(i, 35) * 3) + i) * 12;
        ctx.strokeStyle = hexAlpha(e.color, 0.75); ctx.lineWidth = Math.max(1.5, r * 0.12);
        ctx.fillStyle = hexAlpha(e.accent, 0.12); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = hexAlpha(e.color, 0.85); ctx.beginPath(); ctx.arc(x - r * 0.35, y - r * 0.35, r * 0.22, 0, Math.PI * 2); ctx.fill();
      }
    } },
  vhs: { name: 'VHS tape look', group: 'Overlays', box: [1920, 1080], defaults: { text: 'PLAY ▶', sub: 'AM 10:24  NOV 13 1996', color: '#ffffff', accent: '#000000' },
    draw(ctx, e, t, d, _img, FW = 1920, FH = 1080) {
      const L = -FW / 2, T = -FH / 2;
      ctx.fillStyle = 'rgba(0,0,0,0.13)'; for (let y = T; y < -T; y += 4) ctx.fillRect(L, y, FW, 2); // scan lines
      const band = ((t * 0.23) % 1.3 - 0.15) * FH + T; // the tracking band rolls down
      for (let i = 0; i < 26; i++) { const y = band + rnd(i, Math.floor(t * 30)) * 70, w = FW * (0.2 + rnd(i, 41) * 0.8);
        ctx.fillStyle = `rgba(255,255,255,${0.05 + rnd(i, 42 + Math.floor(t * 30)) * 0.22})`; ctx.fillRect(L + rnd(i, 43) * (FW - w), y, w, 2); }
      ctx.font = `700 64px 'VCR OSD Mono', Menlo, monospace`; ctx.textBaseline = 'top'; ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 4; ctx.shadowOffsetY = 4;
      ctx.fillStyle = e.color;
      if (t < 3 || Math.floor(t * 1.5) % 2 === 0) ctx.fillText(e.text, L + 80, T + 64);
      ctx.font = `700 48px 'VCR OSD Mono', Menlo, monospace`; ctx.textBaseline = 'bottom'; ctx.fillText(e.sub, L + 80, -T - 64);
      const s = Math.floor(t), clock = `SP ${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      ctx.textAlign = 'right'; ctx.fillText(clock, -L - 80, -T - 64); ctx.textAlign = 'left';
    } },
  scoreBug: { name: 'Score bug', group: 'Info', box: [820, 96], defaults: { text: 'HOME 2', sub: 'AWAY 1', color: '#0a2a66', accent: '#ffcc00' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 0.5, 0.4), k = Math.min(easeOut(ki), easeInOut(ko));
      const team = s => { const m = /^(.*?)\s*(\d+)$/.exec(String(s).trim()); return m ? [m[1] || '—', m[2]] : [String(s), '0']; };
      const [n1, s1] = team(e.text), [n2, s2] = team(e.sub);
      ctx.save(); ctx.beginPath(); ctx.rect(-410, -48, 820 * k, 96); ctx.clip();
      ctx.fillStyle = e.color; ctx.fillRect(-410, -40, 820, 80);
      ctx.font = font(800, 38); ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff'; ctx.fillText(n1.slice(0, 10), -390, 0); ctx.fillText(n2.slice(0, 10), -60, 0);
      ctx.fillStyle = e.accent; ctx.fillRect(-150, -40, 74, 80); ctx.fillRect(180, -40, 74, 80);
      ctx.fillStyle = '#111'; ctx.textAlign = 'center'; ctx.font = font(900, 46); ctx.fillText(s1, -113, 2); ctx.fillText(s2, 217, 2);
      const s = 12 * 60 - Math.floor(t); ctx.fillStyle = '#000'; ctx.fillRect(254, -40, 156, 80);
      ctx.fillStyle = '#fff'; ctx.font = font(700, 36); ctx.fillText(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, 332, 2);
      ctx.restore();
    } },
  replayBug: { name: 'Replay badge', group: 'Overlays', box: [440, 150], defaults: { text: 'REPLAY', sub: '', color: '#ffffff', accent: '#e5484d' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 0.35, 0.3), k = Math.min(easeOut(ki), easeInOut(ko));
      ctx.globalAlpha *= k; ctx.translate((1 - k) * 200, 0); ctx.transform(1, 0, -0.22, 1, 0, 0);
      ctx.fillStyle = e.accent; ctx.fillRect(-200, -50, 400, 100);
      ctx.save(); ctx.beginPath(); ctx.rect(-200, -50, 400, 100); ctx.clip(); ctx.fillStyle = 'rgba(255,255,255,0.18)';
      for (let i = -6; i < 8; i++) { const x = i * 60 + ((t * 160) % 60); ctx.fillRect(x, -50, 24, 100); } ctx.restore();
      ctx.fillStyle = e.color; ctx.font = font(900, 62); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(e.text, 0, 3);
      if (Math.floor(t * 2) % 2 === 0) { ctx.fillStyle = e.color; ctx.beginPath(); ctx.arc(-168, 0, 9, 0, Math.PI * 2); ctx.fill(); }
    } },
  newsTicker: { name: 'News ticker', group: 'Lower thirds', box: [1920, 190], defaults: { text: 'BREAKING NEWS', sub: 'Your headline goes here  •  More details scroll along the bottom  •  Stay with us for updates', color: '#d71920', accent: '#ffffff' },
    draw(ctx, e, t, d, _img, FW = 1920) {
      const [ki, ko] = io(t, d, 0.6, 0.4), k = Math.min(easeOut(ki), easeInOut(ko)), L = -FW / 2;
      ctx.save(); ctx.beginPath(); ctx.rect(L, -100, FW * k, 200); ctx.clip();
      ctx.font = font(900, 52); const lw = ctx.measureText(e.text).width + 70;
      ctx.fillStyle = e.color; ctx.fillRect(L + 60, -82, lw, 82);
      ctx.fillStyle = e.accent; ctx.fillRect(L + 60 + lw, -82, Math.min(FW - 120 - lw, 900), 82);
      ctx.fillStyle = e.accent; ctx.textBaseline = 'middle'; ctx.fillText(e.text, L + 95, -40);
      ctx.fillStyle = e.color; ctx.font = font(800, 38); ctx.fillText('LIVE', L + 90 + lw, -40);
      ctx.fillStyle = '#0d1424'; ctx.fillRect(L, 6, FW, 64);
      ctx.fillStyle = e.accent; ctx.font = font(600, 36);
      const msg = `${e.sub}     •     `, mw = Math.max(200, ctx.measureText(msg).width), off = (t * 170) % mw;
      for (let x = L + FW * 0.3 - off; x < -L; x += mw) ctx.fillText(msg, x, 39);
      ctx.restore();
    } },
  emojiPop: { name: 'Emoji pop', group: 'Social', box: [300, 300], defaults: { text: '🔥', sub: '', color: '#ffffff', accent: '#ffffff' },
    draw(ctx, e, t, d) {
      const [ki, ko] = io(t, d, 0.5), k = Math.min(elastic(ki), easeInOut(ko));
      ctx.rotate(Math.sin(t * 6) * 0.08); ctx.scale(Math.max(0.01, k), Math.max(0.01, k));
      ctx.font = font(400, 220, 'Apple Color Emoji, Segoe UI Emoji, sans-serif'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(e.text, 0, 10);
    } },
};

/** Draws an element clip into a W×H frame. p: position props (x, y, scale, rotation, opacity). */
/** img(mediaId) → a loaded picture or null: for elements with picture slots (an end screen's boxes). */
export function drawElement(ctx, el, p, t, d, W, H, img = null) {
  const def = ELEMENTS[el.kind]; if (!def) return;
  const e = { ...def.defaults, ...el };
  const u = (Math.min(W, H) / 1080) * (p.scale ?? 1);
  ctx.save();
  ctx.globalAlpha = clamp(p.opacity ?? 1, 0, 1);
  ctx.translate((p.x ?? 0.5) * W, (p.y ?? 0.5) * H);
  if (p.rotation) ctx.rotate((p.rotation * Math.PI) / 180);
  ctx.scale(u, u);
  ctx.textAlign = 'left';
  try { def.draw(ctx, e, t, d, img, W / u, H / u); } finally { ctx.restore(); } // the last two: the frame, in element units
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
  const at = { bubbles: { x: 0.5, y: 0.5, scale: 1 }, vhs: { x: 0.5, y: 0.5, scale: 1 }, scoreBug: { x: 0.27, y: 0.09, scale: 0.8 }, replayBug: { x: 0.84, y: 0.12, scale: 0.8 },
    newsTicker: { x: 0.5, y: 0.86, scale: 1 }, locStamp: { x: 0.28, y: 0.12, scale: 0.8 }, routeMap: { x: 0.5, y: 0.5, scale: 0.85 }, docLower: { x: 0.31, y: 0.82 } }[kind];
  if (at) return { ...at };
  return kind === 'noteCard' ? { x: 0.76, y: 0.42, scale: 0.85 } : g === 'Lower thirds' ? { x: 0.3, y: 0.82 } : ['subscribe', 'likeButton', 'bell', 'likeSubscribe', 'follow', 'commentPrompt'].includes(kind) ? { x: 0.5, y: 0.8 } : kind === 'progressBar' ? { x: 0.5, y: 0.88 } : { x: 0.5, y: 0.5 };
}
