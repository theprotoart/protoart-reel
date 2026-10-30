// Studio hardware for Reel, matching ProtoArt Press and Wake: black anodized faceplate, screws,
// bakelite knobs, lit push buttons, lamps, seven-segment readouts and masking-tape notes.
const SVGNS = 'http://www.w3.org/2000/svg';
let uid = 0;
const nextId = p => `${p}${++uid}`;

function h(tag, attrs = {}, parent) {
  const e = tag.startsWith('svg:') ? document.createElementNS(SVGNS, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  if (parent) parent.appendChild(e);
  return e;
}
function svg(w, ht, inner) {
  const s = h('svg:svg', { width: w, height: ht, viewBox: `0 0 ${w} ${ht}` });
  s.innerHTML = inner;
  return s;
}

export function seededRandom(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + (hi - lo) * next();
  next.chance = p => next() < p;
  return next;
}

// ------------------------------------------------------------------ faceplate

/** Black anodized, brushed faceplate (same recipe as Press), drawn on a canvas. */
export function faceplateCanvas(width = 1600, height = 1000, seed = 0x5245454c, light = false) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const W = width, H = height, ctx = canvas.getContext('2d');
  const rng = seededRandom(seed);
  const sheen = ctx.createLinearGradient(0, 0, W, 0);
  // dark: black anodized; light: brushed aluminium, the same grain and wear
  const lift = light ? 0.66 : 0;
  [[0, .115], [.18, .155], [.37, .13], [.55, .175], [.72, .14], [.86, .16], [1, .12]]
    .forEach(([o, v]) => sheen.addColorStop(o, `rgb(${(v + lift) * 255},${(v + lift) * 255},${(v + lift) * 255 + (light ? -2 : 3)})`));
  ctx.fillStyle = sheen; ctx.fillRect(0, 0, W, H);
  const vert = ctx.createLinearGradient(0, 0, 0, H);
  vert.addColorStop(0, 'rgba(255,255,255,0.08)'); vert.addColorStop(0.35, 'rgba(255,255,255,0)'); vert.addColorStop(1, 'rgba(0,0,0,0.1)');
  ctx.fillStyle = vert; ctx.fillRect(0, 0, W, H);
  const img = ctx.getImageData(0, 0, W, H), px = img.data;
  for (let y = 0; y < H; y++) {
    const smear = rng.range(0.006, 0.025), rowShift = rng.range(-2, 2);
    let streak = 0, i = y * W * 4;
    for (let x = 0; x < W; x++, i += 4) {
      streak += (rng.range(-30, 30) - streak) * smear;
      const d = (streak * 2.2 + rowShift + rng.range(-3.5, 3.5)) * 0.42;
      px[i] += d; px[i + 1] += d; px[i + 2] += d;
    }
  }
  ctx.putImageData(img, 0, 0);
  const blob = (x, y, r, rgb, a) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb},${a})`); g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  for (let k = 0; k < 40; k++) {
    const dark = rng.chance(0.7);
    blob(rng() * W, rng() * H, rng.range(40, 200), dark ? '0,0,0' : '190,190,200', (dark ? rng.range(0.08, 0.18) : rng.range(0.02, 0.05)) * (light ? 0.35 : 1));
  }
  ctx.lineCap = 'round';
  for (let k = 0; k < 700; k++) {
    const x = rng() * W, y = rng() * H, a = rng.range(0, Math.PI * 2), len = rng.range(2, 14);
    const bright = rng.chance(0.85);
    ctx.strokeStyle = bright ? `rgba(255,255,255,${rng.range(0.07, 0.16) * (light ? 2 : 1)})` : `rgba(0,0,0,${rng.range(0.12, 0.3) * (light ? 0.4 : 1)})`;
    ctx.lineWidth = rng.range(0.3, 0.7);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); ctx.stroke();
  }
  const scratch = (x, y, a, len, bend, depth) => {
    const ex = x + Math.cos(a) * len, ey = y + Math.sin(a) * len;
    const mx = (x + ex) / 2 - Math.sin(a) * bend, my = (y + ey) / 2 + Math.cos(a) * bend;
    const w = Math.max(0.45, depth * 3.2);
    const path = (dx, dy) => { ctx.beginPath(); ctx.moveTo(x + dx, y + dy); ctx.quadraticCurveTo(mx + dx, my + dy, ex + dx, ey + dy); };
    ctx.strokeStyle = `rgba(0,0,0,${Math.min(0.6, depth * 1.8) * (light ? 0.35 : 1)})`; ctx.lineWidth = w; path(0.8, 0.8); ctx.stroke();
    ctx.strokeStyle = `rgba(196,198,204,${Math.min(0.5, depth * 1.4)})`; ctx.lineWidth = w * 0.75; path(0, 0); ctx.stroke();
  };
  for (let k = 0; k < 60; k++) {
    const base = rng.chance(0.7) ? rng.range(-0.6, 0.6) : rng.range(0.8, 2.3);
    scratch(rng() * W, rng() * H, rng.chance(0.5) ? base : base + Math.PI, rng.range(18, 260), rng.range(-14, 14), rng.range(0.08, 0.25));
  }
  for (let k = 0; k < 14; k++) {
    const x = rng() * W, y = rng() * H, r = rng.range(1.5, 4.5);
    blob(x, y, r * 1.8, '150,150,155', 0.2);
    ctx.strokeStyle = 'rgba(220,220,225,0.5)'; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.arc(x + r * 0.25, y + r * 0.25, r, Math.PI * 0.05, Math.PI * 0.85); ctx.stroke();
  }
  return canvas;
}

/** Paints the faceplate behind the whole app (once per launch), as a small JPEG blob URL. */
const plates = {};
export function installFaceplate(light = document.documentElement.dataset.theme === 'light') {
  const key = light ? 'light' : 'dark';
  if (plates[key]) { document.documentElement.style.setProperty('--plate', plates[key]); return; }
  try {
    faceplateCanvas(1600, 1000, 0x5245454c, light).toBlob(b => { if (b) { plates[key] = `url("${URL.createObjectURL(b)}")`; if ((document.documentElement.dataset.theme === 'light') === light) document.documentElement.style.setProperty('--plate', plates[key]); } }, 'image/jpeg', 0.9);
  } catch { /* plain colour fallback */ }
}

// ------------------------------------------------------------------ small parts

export function screw(size = 13, angle = Math.random() * 90) {
  const id = nextId('scr'), r = size / 2, arm = size * 0.31, t = size * 0.075;
  const cross = `<rect x="${r - arm}" y="${r - t}" width="${arm * 2}" height="${t * 2}" rx="${t}"/><rect x="${r - t}" y="${r - arm}" width="${t * 2}" height="${arm * 2}" rx="${t}"/>`;
  const wrap = h('span', { class: 'screw' });
  wrap.appendChild(svg(size + 2, size + 2, `
    <defs><radialGradient id="${id}" cx="32%" cy="28%" r="80%"><stop offset="0" stop-color="#f6f6f6"/><stop offset=".55" stop-color="#a6a6a8"/><stop offset="1" stop-color="#5c5c5e"/></radialGradient></defs>
    <circle cx="${r + 1.2}" cy="${r + 1.7}" r="${r}" fill="rgba(0,0,0,.5)"/>
    <circle cx="${r}" cy="${r}" r="${r - 0.3}" fill="url(#${id})" stroke="rgba(0,0,0,.4)" stroke-width=".7"/>
    <g transform="rotate(${angle} ${r} ${r})"><g fill="rgba(255,255,255,.5)" transform="translate(.5 .8)">${cross}</g><g fill="#373738">${cross}</g></g>`));
  return wrap;
}

/** Screws in the four corners of a plate (the host must be position: relative). */
export function screwCorners(host, size = 11, inset = 6) {
  for (const [x, y] of [['left', 'top'], ['right', 'top'], ['left', 'bottom'], ['right', 'bottom']]) {
    const s = screw(size);
    s.classList.add('corner');
    s.style[x] = inset + 'px'; s.style[y] = inset + 'px';
    host.appendChild(s);
  }
  return host;
}

/** A panel lamp. color: green | amber | red | blue. */
export function lamp(color = 'green', on = false, label) {
  const l = h('span', { class: `lamp ${color}${on ? ' on' : ''}` });
  if (!label) return l;
  const row = h('span', { class: 'lamp-row' });
  row.append(l, h('span', { class: 'engr', text: label }));
  row.lamp = l;
  return row;
}

// ------------------------------------------------------------------ seven-segment readout

const SEGMENTS = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '-': 'g', ' ': '',
  A: 'abcefg', b: 'cdefg', C: 'adef', d: 'bcdeg', E: 'adefg', F: 'aefg', H: 'bcefg', L: 'def', o: 'cdeg', P: 'abefg', r: 'eg', S: 'afgcd', U: 'bcdef', n: 'ceg', t: 'defg', x: 'bcefg' };
function segPolygons(ox, ht) {
  const w = ht * 0.52, t = ht * 0.12, g = t * 0.18, slant = 0.1;
  const P = (x, y) => `${(ox + x + (ht - y) * slant - ht * slant * 0.5).toFixed(2)},${y.toFixed(2)}`;
  const L = t / 2, R = w - t / 2, T = t / 2, M = ht / 2, B = ht - t / 2;
  const horiz = y => [P(L + g, y), P(L + g + t / 2, y - t / 2), P(R - g - t / 2, y - t / 2), P(R - g, y), P(R - g - t / 2, y + t / 2), P(L + g + t / 2, y + t / 2)].join(' ');
  const vert = (x, y0, y1) => [P(x, y0 + g), P(x + t / 2, y0 + g + t / 2), P(x + t / 2, y1 - g - t / 2), P(x, y1 - g), P(x - t / 2, y1 - g - t / 2), P(x - t / 2, y0 + g + t / 2)].join(' ');
  return { a: horiz(T), g: horiz(M), d: horiz(B), f: vert(L, T, M), b: vert(R, T, M), e: vert(L, M, B), c: vert(R, M, B), w };
}
export function sevenSegment(text, ht = 22, color = '#ffb02a') {
  let x = 0, body = '';
  const gap = ht * 0.16;
  for (const ch of String(text)) {
    if (ch === ':' || ch === '.') {
      const r = ht * 0.066, cx = x + r + 1;
      body += ch === ':' ? `<circle cx="${cx}" cy="${ht * 0.32}" r="${r}" fill="${color}"/><circle cx="${cx}" cy="${ht * 0.7}" r="${r}" fill="${color}"/>` : `<circle cx="${cx}" cy="${ht - r}" r="${r}" fill="${color}"/>`;
      x += r * 2 + 2 + gap;
      continue;
    }
    const segs = segPolygons(x, ht), lit = SEGMENTS[ch] ?? SEGMENTS[String(ch).toUpperCase()] ?? '';
    for (const s of 'abcdefg') body += `<polygon points="${segs[s]}" fill="${color}" opacity="${lit.includes(s) ? 1 : 0.085}"/>`;
    x += segs.w + gap;
  }
  return svg(Math.ceil(x - gap + 3), ht, body);
}
/** A glass window showing seven-segment digits; .set(text) redraws only when the text changes. */
export function segDisplay(text = '', { height = 22, color = '#ffb02a', cls = '' } = {}) {
  const win = h('span', { class: `seg-window ${cls}` });
  let last = null;
  win.set = t => { t = String(t); if (t === last) return; last = t; win.replaceChildren(sevenSegment(t, height, color)); };
  win.set(text);
  return win;
}

// ------------------------------------------------------------------ masking tape

export function tape(text, { size = 14, angle = -1.5, seed = 1, cls = '' } = {}) {
  const rng = seededRandom(seed * 7919 + 17);
  const t = h('span', { class: `tape ${cls}` });
  t.style.fontSize = size + 'px';
  t.style.transform = `rotate(${angle}deg)`;
  const paper = h('span', { class: 'paper' }, t);
  const pts = [`${rng() * 3}px 0`, `calc(100% - ${rng() * 3}px) 0`];
  for (let y = 0; y <= 100; y += 9) pts.push(`calc(100% - ${rng() * 5}px) ${y}%`);
  pts.push(`calc(100% - ${rng() * 3}px) 100%`, `${rng() * 3}px 100%`);
  for (let y = 100; y >= 0; y -= 9) pts.push(`${rng() * 5}px ${y}%`);
  paper.style.clipPath = `polygon(${pts.join(',')})`;
  h('span', { class: 'ink', text }, t);
  return t;
}

// ------------------------------------------------------------------ bakelite knob (stepped)

/** A stepped bakelite knob with labels around it. Drag, scroll, or click a label. */
export function knob(host, { title, labels, index = 0, onChange, onReset, sweep = 270, size = 44, radius = 38, labelSize }) {
  const box = h('div', { class: 'cknob' }, host);
  const W = 2 * (radius + 30), H = 2 * (radius + 12);
  box.style.width = W + 'px'; box.style.height = (H + (title ? 14 : 0)) + 'px';
  const cx = W / 2, cy = radius + 12;
  const angleOf = i => (labels.length > 1 ? -sweep / 2 + (sweep * i) / (labels.length - 1) : 0);
  const labs = labels.map((text, i) => {
    const a = angleOf(i), rad = (a * Math.PI) / 180;
    h('div', { class: 'tick', style: `left:${cx - 1}px; top:${cy}px; transform: rotate(${a + 180}deg) translateY(${size / 2 + 3}px)` }, box);
    const lab = h('div', { class: 'engr lab', text, style: `left:${cx + Math.sin(rad) * radius}px; top:${cy - Math.cos(rad) * radius}px${labelSize ? `; font-size:${labelSize}px` : ''}` }, box);
    lab.addEventListener('click', () => set(i));
    return lab;
  });
  const body = h('div', { class: 'cknob-body', style: `left:${cx - size / 2}px; top:${cy - size / 2}px; width:${size}px; height:${size}px` }, box);
  h('div', { class: 'shadow' }, body);
  const rotor = h('div', { class: 'rotor' }, body);
  const g1 = nextId('kb'), g2 = nextId('kc'), c = size / 2;
  let knurl = '';
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    knurl += `M${c + Math.cos(a) * (c - 4)} ${c + Math.sin(a) * (c - 4)}L${c + Math.cos(a) * (c - 0.5)} ${c + Math.sin(a) * (c - 0.5)}`;
  }
  rotor.appendChild(svg(size, size, `
    <defs>
      <radialGradient id="${g1}" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#46302a"/><stop offset=".5" stop-color="#221712"/><stop offset="1" stop-color="#0d0907"/></radialGradient>
      <radialGradient id="${g2}" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#4a332b"/><stop offset="1" stop-color="#1a110d"/></radialGradient>
    </defs>
    <circle cx="${c}" cy="${c}" r="${c - 0.5}" fill="url(#${g1})"/>
    <path d="${knurl}" stroke="rgba(0,0,0,.6)" stroke-width="1.4"/>
    <circle cx="${c}" cy="${c + 1}" r="${c * 0.72}" fill="rgba(0,0,0,.45)"/>
    <circle cx="${c}" cy="${c}" r="${c * 0.72}" fill="url(#${g2})" stroke="rgba(0,0,0,.6)"/>
    <rect x="${c - 1.25}" y="${c * 0.22}" width="2.5" height="${c * 0.55}" rx="1.25" fill="#eee6d2" opacity=".93"/>`));
  h('div', { class: 'spec' }, body);
  if (title) h('div', { class: 'engr cknob-title', text: title, style: `top:${H - 2}px` }, box);

  let current = Math.max(0, Math.min(labels.length - 1, index));
  const render = () => { rotor.style.transform = `rotate(${angleOf(current)}deg)`; labs.forEach((l, i) => l.classList.toggle('sel', i === current)); };
  function set(i) {
    i = Math.max(0, Math.min(labels.length - 1, i));
    if (i === current) return;
    current = i; render(); onChange && onChange(i);
  }
  const step = labels.length > 6 ? 12 : labels.length > 4 ? 16 : 22;
  body.addEventListener('pointerdown', e => {
    body.setPointerCapture(e.pointerId);
    const sx = e.clientX, sy = e.clientY, start = current;
    const move = ev => set(start + Math.round(((ev.clientX - sx) - (ev.clientY - sy)) / step));
    const up = () => { body.removeEventListener('pointermove', move); body.removeEventListener('pointerup', up); };
    body.addEventListener('pointermove', move); body.addEventListener('pointerup', up);
  });
  body.addEventListener('wheel', e => { e.preventDefault(); set(current + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
  if (onReset) body.addEventListener('dblclick', onReset);
  render();
  return { el: box, set: i => { current = i; render(); }, change: set, get: () => current };
}

// ------------------------------------------------------------------ lit push buttons

/** Interlocking lit buttons, one lit at a time (index -1: none lit). cols: wrap into a grid. */
export function buttonGroup(host, { title, labels, subs, index = 0, lamp = 'amber', cols, width, onChange, caption, cls = '' }) {
  const box = h('div', { class: `bgroup ${cls}` }, host);
  if (title) h('div', { class: 'engr bg-title', text: title }, box);
  const row = h('div', { class: 'bg-row' + (cols ? ' grid' : '') }, box);
  if (cols) row.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  let current = index;
  const btns = labels.map((text, i) => {
    const b = h('button', { class: `pbtn lamp-${lamp}`, type: 'button' }, row);
    if (width) b.style.width = width + 'px';
    h('span', { class: 'cap-face' }, b);
    h('span', { class: 'cap-text', text }, b);
    if (subs && subs[i]) h('span', { class: 'cap-sub', text: subs[i] }, b);
    b.addEventListener('click', () => set(i));
    return b;
  });
  if (caption) h('div', { class: 'engr bg-caption', text: caption }, box);
  const render = () => btns.forEach((b, i) => b.classList.toggle('lit', i === current));
  function set(i) { if (i === current) return; current = i; render(); onChange && onChange(i); }
  render();
  return { el: box, buttons: btns, set: i => { current = i; render(); }, change: set, get: () => current };
}

/** A single latching lit button (on/off). */
export function latch(host, { label, on = false, lamp = 'amber', title, onChange, round = false }) {
  const box = h('div', { class: 'bgroup latch' }, host);
  const b = h('button', { class: `pbtn lamp-${lamp}${round ? ' round' : ''}`, type: 'button' }, box);
  h('span', { class: 'cap-face' }, b);
  h('span', { class: 'cap-text', text: label }, b);
  if (title) h('div', { class: 'engr bg-title', text: title }, box);
  let state = !!on;
  const render = () => b.classList.toggle('lit', state);
  b.addEventListener('click', () => { state = !state; render(); onChange && onChange(state); });
  render();
  return { el: box, button: b, set: v => { state = !!v; render(); }, get: () => state };
}

/** A momentary lit button (lights while working). */
export function pushButton({ label, lamp = 'amber', cls = '', onClick, title }) {
  const b = h('button', { class: `pbtn big lamp-${lamp} ${cls}`, type: 'button', title });
  h('span', { class: 'cap-face' }, b);
  h('span', { class: 'cap-text', text: label }, b);
  if (onClick) b.addEventListener('click', onClick);
  b.setLabel = t => { b.querySelector('.cap-text').textContent = t; };
  b.light = on => b.classList.toggle('lit', !!on);
  return b;
}

/** A rack module: a finished metal plate with screws top and bottom, a name and an optional lamp. */
export function module(name, { finish = 'graphite', sub, lampColor, cls = '' } = {}, ...kids) {
  const m = h('section', { class: `module f-${finish} ${cls}` });
  const head = h('div', { class: 'mhead' }, m);
  h('div', { class: 'mname', text: name }, head);
  if (sub) h('div', { class: 'engr mfmt', text: sub }, head);
  if (lampColor) { m.lamp = lamp(lampColor); m.lamp.classList.add('mlamp'); head.appendChild(m.lamp); }
  screwCorners(m, 10, 5);
  const body = h('div', { class: 'mbody' }, m);
  for (const k of kids.flat()) if (k) body.appendChild(k);
  m.body = body;
  return m;
}

// ------------------------------------------------------------------ smooth mini knob (track volume / pan)

/**
 * A small continuous bakelite knob. Drag up/down (⇧ for fine), scroll, or double-click to reset.
 * onStart() once per gesture, onInput(v) while turning, onCommit(v) at the end.
 */
export function dial(host, { value = 0, min = 0, max = 1, def = value, size = 22, title = '', fmt = v => v.toFixed(2), toPos, fromPos, onStart, onInput, onCommit }) {
  const pos = toPos || (v => (v - min) / (max - min));
  const val = fromPos || (p => min + p * (max - min));
  const box = h('span', { class: 'dial', title });
  const body = h('span', { class: 'dial-body', style: `width:${size}px;height:${size}px` }, box);
  const g1 = nextId('dk'), c = size / 2;
  const rotor = h('span', { class: 'rotor' }, body);
  rotor.appendChild(svg(size, size, `
    <defs><radialGradient id="${g1}" cx="38%" cy="32%" r="75%"><stop offset="0" stop-color="#5a3e35"/><stop offset=".55" stop-color="#241812"/><stop offset="1" stop-color="#0d0907"/></radialGradient></defs>
    <circle cx="${c}" cy="${c}" r="${c - 0.5}" fill="url(#${g1})" stroke="rgba(0,0,0,.7)"/>
    <rect x="${c - 1}" y="${size * 0.1}" width="2" height="${size * 0.36}" rx="1" fill="#eee6d2"/>`));
  const readout = h('span', { class: 'dial-val' }, box);
  let v = value;
  const render = () => { rotor.style.transform = `rotate(${-135 + 270 * Math.max(0, Math.min(1, pos(v)))}deg)`; readout.textContent = fmt(v); };
  const setPos = p => { v = val(Math.max(0, Math.min(1, p))); render(); onInput && onInput(v); };
  body.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    body.setPointerCapture(e.pointerId);
    const y0 = e.clientY, p0 = pos(v);
    let started = false;
    const move = ev => {
      if (!started) { started = true; onStart && onStart(); }
      setPos(p0 + (y0 - ev.clientY) / (ev.shiftKey ? 600 : 120));
    };
    const up = () => { body.removeEventListener('pointermove', move); body.removeEventListener('pointerup', up); if (started) onCommit && onCommit(v); };
    body.addEventListener('pointermove', move); body.addEventListener('pointerup', up);
  });
  body.addEventListener('dblclick', e => { e.stopPropagation(); onStart && onStart(); v = def; render(); onInput && onInput(v); onCommit && onCommit(v); });
  body.addEventListener('wheel', e => { e.preventDefault(); onStart && onStart(); setPos(pos(v) + (e.deltaY < 0 ? 0.02 : -0.02)); onCommit && onCommit(v); }, { passive: false });
  render();
  return { el: box, set: nv => { v = nv; render(); }, get: () => v };
}
