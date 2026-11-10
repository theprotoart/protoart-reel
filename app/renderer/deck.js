// The transport as a reel-to-reel tape deck: a supply reel and a take-up reel whose tape packs
// grow and shrink with the playhead, turning while it plays or scrubs; a bank of piano-key
// transport buttons; two needle VU meters reading the preview mix; and a tape-speed switch
// (3¾ · 7½ · 15 ips = ½× · 1× · 2× preview speed). Everything is drawn in SVG, and the animation
// only runs while something moves, so it costs nothing on an 8 GB M1 when the deck is still.
import { el } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.append(n);
  return n;
};
let uid = 0;

/** An aluminium NAB-style reel with three windows, a hub, and a tape pack whose size we set. */
export function makeReel(size) {
  const id = 'rl' + (++uid), c = size / 2;
  const svg = svgEl('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, class: 'deck-reel' });
  const defs = svgEl('defs', {}, svg);
  defs.innerHTML = `
    <radialGradient id="${id}a" cx="40%" cy="35%" r="75%"><stop offset="0" stop-color="#e9e6df"/><stop offset=".55" stop-color="#a9a49b"/><stop offset="1" stop-color="#6c675f"/></radialGradient>
    <radialGradient id="${id}t" cx="45%" cy="40%" r="60%"><stop offset="0" stop-color="#4a3122"/><stop offset=".7" stop-color="#2c1c11"/><stop offset="1" stop-color="#170e08"/></radialGradient>
    <radialGradient id="${id}b" cx="55%" cy="60%" r="70%"><stop offset="0" stop-color="#d8d4cc"/><stop offset=".7" stop-color="#b3aea5"/><stop offset="1" stop-color="#858077"/></radialGradient>
    <radialGradient id="${id}h" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#f4f1ea"/><stop offset="1" stop-color="#8e887e"/></radialGradient>`;
  // the back flange: light metal, so an empty reel shows silver through the windows and a full one shows tape
  svgEl('circle', { cx: c, cy: c, r: c - 1.5, fill: `url(#${id}b)` }, svg);
  // tape pack (behind the front flange; seen through the windows): dark brown, wound rings, a shiny outer edge
  const pack = svgEl('circle', { cx: c, cy: c, r: c * 0.6, fill: `url(#${id}t)` }, svg);
  const rings = [0.92, 0.8, 0.66, 0.5].map(k => [k, svgEl('circle', { cx: c, cy: c, r: c * 0.5, fill: 'none', stroke: 'rgba(255,214,170,.09)', 'stroke-width': 0.6 }, svg)]);
  const edge = svgEl('circle', { cx: c, cy: c, r: c * 0.6, fill: 'none', stroke: 'rgba(255,205,160,.32)', 'stroke-width': 0.9 }, svg);
  // the spinning flange
  const rot = svgEl('g', { class: 'deck-rot' }, svg);
  const R = c - 1, hole = c * 0.2;
  // flange with three windows cut out (even-odd path)
  let d = `M${c - R} ${c}a${R} ${R} 0 1 0 ${2 * R} 0a${R} ${R} 0 1 0 ${-2 * R} 0Z`;
  for (let k = 0; k < 3; k++) {
    const a0 = (k * 120 + 18) * Math.PI / 180, a1 = (k * 120 + 102) * Math.PI / 180;
    const ro = c * 0.82, ri = c * 0.3;
    const p = (r, a) => `${(c + r * Math.cos(a)).toFixed(2)} ${(c + r * Math.sin(a)).toFixed(2)}`;
    d += `M${p(ri, a0)}L${p(ro, a0)}A${ro} ${ro} 0 0 1 ${p(ro, a1)}L${p(ri, a1)}A${ri} ${ri} 0 0 0 ${p(ri, a0)}Z`;
  }
  svgEl('path', { d, fill: `url(#${id}a)`, 'fill-rule': 'evenodd', stroke: 'rgba(0,0,0,.55)', 'stroke-width': 0.8 }, rot);
  // machined rings and spoke screws
  svgEl('circle', { cx: c, cy: c, r: R - 2.5, fill: 'none', stroke: 'rgba(255,255,255,.35)', 'stroke-width': 0.5 }, rot);
  for (let k = 0; k < 3; k++) {
    const a = (k * 120 + 60) * Math.PI / 180;
    svgEl('circle', { cx: c + c * 0.62 * Math.cos(a), cy: c + c * 0.62 * Math.sin(a), r: 1.3, fill: '#5d584f' }, rot);
  }
  // hub with three drive notches
  svgEl('circle', { cx: c, cy: c, r: c * 0.27, fill: `url(#${id}h)`, stroke: 'rgba(0,0,0,.6)', 'stroke-width': 0.8 }, rot);
  svgEl('circle', { cx: c, cy: c, r: hole, fill: '#141210' }, rot);
  for (let k = 0; k < 3; k++) {
    const a = k * 120 * Math.PI / 180;
    svgEl('rect', { x: c - 1.4, y: c - hole - 2.2, width: 2.8, height: 3.4, fill: '#141210', transform: `rotate(${k * 120} ${c} ${c})` }, rot);
    void a;
  }
  return {
    svg, angle: 0,
    /** fill 0..1: how much tape is on this reel */
    setFill(f) {
      // tape is wound by area: the pack's radius grows with the square root of how much tape is on the reel
      const rh = 0.29, rm = 0.86, k = Math.max(0, Math.min(1, f));
      const r = c * Math.sqrt(rh * rh + k * (rm * rm - rh * rh));
      pack.setAttribute('r', r.toFixed(2)); edge.setAttribute('r', Math.max(0, r - 0.45).toFixed(2));
      for (const [q, ring] of rings) { const rr = c * rh + (r - c * rh) * q; ring.setAttribute('r', rr.toFixed(2)); ring.style.display = r - c * rh > 3 ? '' : 'none'; }
      edge.style.display = k > 0.01 ? '' : 'none';
      this.r = r / c;
    },
    turn(deg) { this.angle = (this.angle + deg) % 360; rot.setAttribute('transform', `rotate(${this.angle.toFixed(2)} ${c} ${c})`); },
  };
}

/** A cream-faced VU meter with a needle; set(db) moves it (VU scale −20…+3). */
function makeVu(label) {
  const W = 62, H = 40;
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'deck-vu' });
  const cx = W / 2, cy = H + 10, R = 40;
  const ang = db => (-48 + (Math.max(-20, Math.min(3, db)) + 20) / 23 * 96) * Math.PI / 180;
  const pt = (db, r) => [cx + r * Math.sin(ang(db)), cy - r * Math.cos(ang(db))];
  // red zone above 0 VU
  const [x0, y0] = pt(0, R), [x1, y1] = pt(3, R);
  svgEl('path', { d: `M${x0} ${y0}A${R} ${R} 0 0 1 ${x1} ${y1}`, stroke: '#c8301f', 'stroke-width': 3, fill: 'none' }, svg);
  const [a0, b0] = pt(-20, R), [a1, b1] = pt(0, R);
  svgEl('path', { d: `M${a0} ${b0}A${R} ${R} 0 0 1 ${a1} ${b1}`, stroke: '#2a2620', 'stroke-width': 1, fill: 'none' }, svg);
  for (const db of [-20, -10, -7, -5, -3, -2, -1, 0, 1, 2, 3]) {
    const [p, q] = pt(db, R), [u, v] = pt(db, R - (db % 5 === 0 || db === -7 || db === -3 ? 5 : 3));
    svgEl('line', { x1: p, y1: q, x2: u, y2: v, stroke: db > 0 ? '#c8301f' : '#2a2620', 'stroke-width': 0.8 }, svg);
  }
  const t = svgEl('text', { x: cx, y: H - 6, 'text-anchor': 'middle', class: 'vu-label' }, svg); t.textContent = 'VU';
  const s = svgEl('text', { x: 5, y: 9, class: 'vu-side' }, svg); s.textContent = label;
  const needle = svgEl('line', { x1: cx, y1: cy, x2: cx, y2: cy - R - 2, stroke: '#1a1612', 'stroke-width': 1, 'stroke-linecap': 'round' }, svg);
  const set = db => needle.setAttribute('transform', `rotate(${(ang(db) * 180 / Math.PI).toFixed(2)} ${cx} ${cy})`);
  set(-20);
  return { svg, set };
}

/**
 * A four-drum mechanical index counter (0000–9999, one count per second of tape). The units drum
 * turns smoothly; each higher drum rolls over only while the one below goes from 9 to 0, as on a
 * real odometer.
 */
function makeCounter() {
  const drums = [];
  const box = el('div', { class: 'deck-drums' });
  for (let i = 0; i < 4; i++) {
    const strip = el('div', { class: 'drum-strip' }, ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map(n => el('span', { text: String(n) })));
    const drum = el('div', { class: 'drum' + (i === 0 ? ' units' : '') }, strip);
    box.prepend(drum);
    drums.push(strip);
  }
  let last = '';
  return {
    el: box,
    set(v) {
      v = ((v % 10000) + 10000) % 10000;
      const whole = Math.floor(v), frac = v - whole;
      const pos = drums.map((_, i) => {
        const p = 10 ** i;
        const digit = Math.floor(whole / p) % 10;
        if (i === 0) return digit + frac;
        return digit + (whole % p === p - 1 ? frac : 0); // carry while the lower drums roll 9 → 0
      });
      const key = pos.map(x => x.toFixed(3)).join('|');
      if (key === last) return;
      last = key;
      pos.forEach((x, i) => { drums[i].style.transform = `translateY(${(-x * 19).toFixed(2)}px)`; }); // 19px = one digit (.drum-strip span)
    },
  };
}

export class Deck {
  /** host: #transport. The existing buttons and counters are moved into the deck layout. */
  constructor(app, host) {
    this.app = app;
    this.supply = makeReel(64); this.takeup = makeReel(64);
    this.vuL = makeVu('L'); this.vuR = makeVu('R');
    this.lvl = [-20, -20];
    this.last = null;
    const keys = host.querySelectorAll('.tbtn');
    const keyBank = el('div', { class: 'deck-keys' }); keys.forEach(k => keyBank.append(k));
    const counters = el('div', { class: 'deck-counter' }, ...['#timecode', '#duration'].map(s => host.querySelector(s)));
    // mechanical tape counter with a ZERO button
    this.counter = makeCounter();
    this.zero = 0;
    const index = el('div', { class: 'deck-index', title: 'Tape counter: one count per second. ZERO sets it to 0000 at the playhead.' },
      el('div', { class: 'drum-window' }, this.counter.el),
      el('button', { class: 'deck-zero', type: 'button', text: 'ZERO', onclick: () => { this.zero = this.app.player.time ?? this.last ?? 0; this.counter.set(0); } }));
    const zoom = host.querySelector('#preview-zoom');
    // tape-speed switch
    const speeds = [[0.5, '3¾'], [1, '7½'], [2, '15']];
    const sw = el('div', { class: 'deck-speed', title: 'Tape speed for the preview: ½×, normal, 2× (export is always normal speed)' },
      ...speeds.map(([r, t]) => el('button', { class: 'deck-spd' + (r === 1 ? ' on' : ''), 'data-r': r, text: t, onclick: () => this.setRate(r) })),
      el('span', { class: 'engr deck-ips', text: 'IPS' }));
    this.sw = sw;
    const meters = el('div', { class: 'deck-meters' }, el('div', { class: 'vu-glass' }, this.vuL.svg), el('div', { class: 'vu-glass' }, this.vuR.svg));
    const spacer = el('div', { class: 'spacer' });
    const tape = el('div', { class: 'deck-tape' }); // tape running along the bottom between the reels, past the head
    void spacer;
    // left: tape speed, picture size, meters · centre: the transport keys · right: the time and the tape counter
    host.replaceChildren(
      el('div', { class: 'deck-reel-well' }, this.supply.svg),
      el('div', { class: 'deck-side deck-left' }, sw, zoom, meters),
      keyBank,
      el('div', { class: 'deck-side deck-right' }, counters, index),
      el('div', { class: 'deck-reel-well' }, this.takeup.svg), tape);
    host.classList.add('deck', 'deck-centred');
    this.rate = 1;
    this.setFill(0);
    // grab either reel and turn it to scrub picture and sound, like rocking the reels across the head
    for (const reel of [this.supply, this.takeup]) this._jog(reel.svg);
    app.player.onTime(t => this.onTime(t));
  }

  setRate(r) {
    this.rate = r;
    this.app.player.setRate(r * (this.app.shuttle > 0 ? this.app.shuttle : 1));
    for (const b of this.sw.querySelectorAll('.deck-spd')) b.classList.toggle('on', Number(b.dataset.r) === r);
  }

  _jog(svg) {
    const well = svg.parentElement || svg;
    svg.style.cursor = 'grab';
    svg.setAttribute('title', 'Turn the reel to scrub: clockwise moves forward, counter-clockwise back');
    svg.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !this.app.doc) return;
      e.preventDefault();
      this.app.stopShuttle?.();
      svg.setPointerCapture(e.pointerId);
      svg.style.cursor = 'grabbing';
      const p = this.app.player;
      p.beginScrub();
      const r = svg.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let last = Math.atan2(e.clientY - cy, e.clientX - cx), t = p.time;
      // one full turn = 2 s of tape; a tiny drag stays frame-accurate
      const SECONDS_PER_TURN = 2;
      const move = ev => {
        const a = Math.atan2(ev.clientY - cy, ev.clientX - cx);
        let d = a - last; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
        last = a;
        t = Math.max(0, t + d / (2 * Math.PI) * SECONDS_PER_TURN);
        p.scrubTo(t, this.app.timeline?.scrubAudio !== false);
      };
      const up = () => {
        svg.removeEventListener('pointermove', move); svg.removeEventListener('pointerup', up); svg.removeEventListener('pointercancel', up);
        svg.style.cursor = 'grab'; p.endScrub();
      };
      svg.addEventListener('pointermove', move); svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
    });
    void well;
  }

  setFill(k) { this.supply.setFill(1 - k); this.takeup.setFill(k); }

  onTime(t) {
    const doc = this.app.doc;
    const dur = doc ? Math.max(1, ...doc.clips.map(c => c.start + c.duration)) : 1;
    const k = Math.min(1, t / dur);
    this.setFill(k);
    // tape moves at constant speed: the reel with less tape on it turns faster
    if (this.last !== null) {
      let dt = t - this.last;
      if (Math.abs(dt) > 2) dt = Math.sign(dt) * 0.4; // a jump (seek): just a short whirr
      const deg = dt * 140;
      this.supply.turn(deg / Math.max(0.3, this.supply.r));
      this.takeup.turn(deg / Math.max(0.3, this.takeup.r));
    }
    this.last = t;
    this.counter.set(t - this.zero);
    this.app.$playKey?.classList.toggle('latched', this.app.player.playing);
    if (this.app.shuttle > 0 && !this.app.player.playing) this.app.setShuttle(0);
    this.app.timeline?.playheadEl?.classList.toggle('rolling', this.app.player.playing);
    this._meters();
  }

  /** VU ballistics (~300 ms): rise and fall smoothly; the loop stops once the needles rest. */
  _meters() {
    if (this._raf) return;
    let prev = performance.now();
    const step = now => {
      this._raf = 0;
      const dt = Math.min(0.1, (now - prev) / 1000); prev = now;
      const [l, r] = this.app.player.levels();
      const toDb = v => (v > 1e-5 ? 20 * Math.log10(v) + 18 : -40); // ~ −18 dBFS RMS reads 0 VU
      const a = 1 - Math.exp(-dt / 0.3);
      this.lvl = [this.lvl[0] + (toDb(l) - this.lvl[0]) * a, this.lvl[1] + (toDb(r) - this.lvl[1]) * a];
      this.vuL.set(this.lvl[0]); this.vuR.set(this.lvl[1]);
      if (this.app.player.playing || this.app.player.scrubbing || this.lvl.some(v => v > -19.5)) this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }
}
