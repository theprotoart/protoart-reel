// ✎ Markup: Preview's Markup bar, over the picture. Sketch draws a shape roughly and it comes out clean (a box, an
// oval, an arrow, a star…, or your drawing as it was if it isn't one: “Keep my drawing” undoes the tidy-up); Shapes
// adds one of Preview's shapes at the playhead, the loupe and the highlight among them; the line, outline colour
// and fill colour change the selected shapes, and are what new ones get. Each shape is an ordinary clip on the
// timeline (move it, trim it, give it an action), drawn into the export like any other.
import { el, toast } from './ui.js';
import { newShapeClip, newDrawClip, newCalloutClip, isFree, addTrack, clamp } from './model.js';
import { recognize } from './lib/sketch.js';

const PREF = 'reel.markup';
const DEF = { color: '#ff3b30', fillColor: '', width: 8, dash: 'solid' };
const prefs = () => { try { return { ...DEF, ...(JSON.parse(localStorage.getItem(PREF) || '{}') || {}) }; } catch { return { ...DEF }; } };
const savePrefs = p => { try { localStorage.setItem(PREF, JSON.stringify(p)); } catch { /* fine */ } };

// Preview's colour well, more or less
const COLOURS = ['#000000', '#ffffff', '#8e8e93', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#007aff', '#5856d6', '#af52de', '#ff2d55', '#a2845e'];
const WIDTHS = [2, 4, 6, 8, 12, 16, 24];
export const SHAPES = [
  ['line', 'Line', '╱'], ['arrow', 'Arrow', '↗'], null,
  ['rect', 'Rectangle', '▭'], ['roundrect', 'Rounded rectangle', '▢'], ['ellipse', 'Oval', '◯'], ['star', 'Star', '☆'], ['polygon', 'Polygon', '⬠'], null,
  ['speech', 'Speech bubble', '💬'], ['thought', 'Thought bubble', '💭'], null,
  ['loupe', 'Loupe (magnifier)', '🔍'], ['highlight', 'Highlight (dim the rest)', '◐'],
];
const NAMES = Object.fromEntries(SHAPES.filter(Boolean).map(([k, n]) => [k, n]));
const BOXY = new Set(['rect', 'roundrect', 'ellipse', 'star', 'polygon', 'speech', 'thought']);

export class Markup {
  constructor(app) {
    this.app = app;
    this.on = false;
    this.tool = 'select';
    this.stage = document.getElementById('stage');
    this.btn = el('button', { class: 'mk-toggle', type: 'button', title: 'Markup: sketch shapes, add arrows, boxes, bubbles, a loupe…, and set their line and colours, like Preview', onclick: () => this.toggle() },
      el('span', { text: '✎' }));
    this.bar = el('div', { class: 'mk-bar hidden' });
    // 🎯 punch in on an area, right under it: drag a box on the picture and it pushes in there and back out
    this.punch = el('button', { class: 'mk-toggle mk-punch', type: 'button', title: 'Punch in on an area: drag a box around what to show, and the picture pushes in on it at the playhead, holds and comes back out', onclick: () => this.app.cmd('punch-zoom') },
      el('span', { text: '🎯' }));
    this.stage.parentElement.append(this.btn, this.punch, this.bar);
    this.pop = null;
    this.draw();
  }

  /** The shape clips (and drawings) selected: what the style controls change. */
  selected() {
    const doc = this.app.doc;
    if (!doc) return [];
    return this.app.selection.clips.map(id => doc.clips.find(c => c.id === id)).filter(c => c && (c.type === 'shape' || c.type === 'draw'));
  }
  /** The style shown: the first selected shape's, else what new shapes get. */
  style() {
    const p = prefs(), c = this.selected()[0];
    if (c?.type === 'shape') return { color: c.shape.color, fillColor: c.shape.fillColor || (c.shape.fill ? c.shape.color : ''), width: c.shape.width, dash: c.shape.dash || 'solid' };
    if (c?.type === 'draw') return { ...p, color: c.draw.color, width: c.draw.width };
    return p;
  }

  toggle(on = !this.on) {
    this.on = on;
    if (!on) this.setTool('select');
    this.btn.classList.toggle('lit', on);
    this.bar.classList.toggle('hidden', !on);
    this.closePop();
    this.draw();
  }

  setTool(t) {
    this.tool = t;
    if (t === 'sketch') this.startSketch(); else this.stopSketch();
    this.draw();
  }

  draw() {
    if (!this.on) return;
    const s = this.style(), sel = this.selected();
    const key = (cls, label, title, onclick, lit = false) => el('button', { class: 'mk-key ' + cls + (lit ? ' lit' : ''), type: 'button', title, onclick }, ...(Array.isArray(label) ? label : [el('span', { text: label })]));
    const sw = (c, none) => el('i', { class: 'mk-sw' + (c ? '' : ' none'), style: c ? { background: c } : {} }, none && !c ? el('b', { text: '⁄' }) : null);
    this.bar.replaceChildren(
      key('mk-tool', '⬚', 'Select: pick and move shapes on the picture', () => this.setTool('select'), this.tool === 'select'),
      key('mk-tool', '✎', 'Sketch: draw a shape roughly and it comes out clean (a box, an oval, an arrow, a star…). Esc to stop', () => this.setTool(this.tool === 'sketch' ? 'select' : 'sketch'), this.tool === 'sketch'),
      key('mk-menu', [el('span', { text: '◯' }), el('em', { text: '▾' })], 'Shapes: add one at the playhead', e => this.shapesMenu(e.currentTarget)),
      el('i', { class: 'mk-sep' }),
      key('mk-menu', [el('span', { class: 'mk-lines', style: { '--w': Math.min(6, Math.max(1, s.width / 3)) + 'px' } }, el('i'), el('i'), el('i')), el('em', { text: '▾' })], 'Line: thickness and dashes', e => this.linePop(e.currentTarget)),
      key('mk-menu', [el('i', { class: 'mk-sw outline', style: { borderColor: s.color } }), el('em', { text: '▾' })], 'Outline colour', e => this.colourPop(e.currentTarget, 'color')),
      key('mk-menu', [sw(s.fillColor, true), el('em', { text: '▾' })], 'Fill colour', e => this.colourPop(e.currentTarget, 'fillColor')),
      el('span', { class: 'mk-note', text: this.tool === 'sketch' ? 'Draw on the picture…' : sel.length ? `${sel.length} selected` : '' }),
      key('mk-done', 'Done', 'Close the markup bar', () => this.toggle(false)));
  }

  closePop() { this.pop?.remove(); this.pop = null; }
  popAt(anchor, ...kids) {
    this.closePop();
    const r = anchor.getBoundingClientRect();
    const pop = this.pop = el('div', { class: 'mk-pop', style: { left: r.left + 'px', top: r.bottom + 6 + 'px' } }, ...kids);
    document.body.append(pop);
    const pr = pop.getBoundingClientRect();
    if (pr.right > innerWidth - 8) pop.style.left = Math.max(8, innerWidth - pr.width - 8) + 'px';
    const off = ev => { if (!pop.contains(ev.target) && !anchor.contains(ev.target)) { this.closePop(); window.removeEventListener('pointerdown', off, true); } };
    setTimeout(() => window.addEventListener('pointerdown', off, true));
    return pop;
  }

  /** Changes the selected shapes (or, with none selected, what new ones get). */
  setStyle(patch) {
    const sel = this.selected();
    savePrefs({ ...prefs(), ...patch });
    if (sel.length) {
      this.app.commit(() => {
        for (const c of sel) {
          if (c.type === 'shape') {
            Object.assign(c.shape, patch);
            if ('fillColor' in patch) { c.shape.fill = false; c.shape.fillOpacity = null; }
          } else if (c.type === 'draw') {
            if (patch.color) { c.draw.color = patch.color; for (const st of c.draw.strokes) st.color = patch.color; }
            if (patch.width) { c.draw.width = patch.width; for (const st of c.draw.strokes) st.width = patch.width; }
          }
        }
      });
    }
    this.draw();
  }

  linePop(anchor) {
    const s = this.style();
    this.popAt(anchor,
      ...WIDTHS.map(w => el('button', { class: 'mk-width' + (w === s.width ? ' on' : ''), type: 'button', title: `${w} px`, onclick: () => { this.setStyle({ width: w }); this.closePop(); } },
        el('i', { style: { height: Math.max(1, w / 2) + 'px' } }))),
      el('hr'),
      ...[['solid', 'Solid'], ['dash', 'Dashed'], ['dot', 'Dotted']].map(([d, n]) => el('button', { class: 'mk-dash ' + d + (d === s.dash ? ' on' : ''), type: 'button', title: n, onclick: () => { this.setStyle({ dash: d }); this.closePop(); } }, el('i'))));
  }

  colourPop(anchor, which) {
    const cur = this.style()[which];
    const pick = c => { this.setStyle({ [which]: c }); this.closePop(); };
    const more = el('input', { type: 'color', value: cur || '#ff3b30', title: 'Any colour', oninput: e => this.setStyle({ [which]: e.target.value }) });
    this.popAt(anchor,
      el('div', { class: 'mk-swatches' },
        which === 'fillColor' ? el('button', { class: 'mk-swatch none' + (!cur ? ' on' : ''), type: 'button', title: 'No fill', onclick: () => pick('') }, el('b', { text: '⁄' })) : null,
        ...COLOURS.map(c => el('button', { class: 'mk-swatch' + (c === cur ? ' on' : ''), type: 'button', title: c, style: { background: c }, onclick: () => pick(c) }))),
      el('label', { class: 'mk-more' }, el('span', { text: 'Other…' }), more));
  }

  shapesMenu(anchor) {
    this.popAt(anchor, ...SHAPES.map(it => (it ? el('button', { class: 'mk-shape', type: 'button', onclick: () => { this.closePop(); this.addShape(it[0]); } }, el('b', { text: it[2] }), el('span', { text: it[1] })) : el('hr'))));
  }

  /** Puts a clip on the top track at the playhead (a new track above if that's busy) and selects it. */
  place(c) {
    this.app.commit(d => {
      c.track = isFree(d, d.tracks[0].id, c.start, c.duration) ? d.tracks[0].id : addTrack(d, 0).id;
      d.clips.push(c);
    });
    this.app.select([c.id], null);
  }

  /** One of Preview's shapes at the playhead, in the middle of the picture, in the current style. */
  addShape(kind, geom = null) {
    const app = this.app, t = app.player.time;
    if (kind === 'loupe' || kind === 'highlight') {
      const k = newCalloutClip(null, t);
      k.duration = 4;
      k.callout = { ...k.callout, ...(kind === 'loupe' ? { shape: 'ellipse', w: 0.2, h: 0.2 * (app.doc.canvas.width / app.doc.canvas.height), dim: 0, zoom: 2, outline: 3, feather: 0 } : { shape: 'rect', w: 0.36, h: 0.3, dim: 0.6, radius: 0.015, feather: 0.01 }) };
      k.name = kind === 'loupe' ? 'Loupe' : 'Highlight';
      this.place(k);
      app.seek(t + (k.callout.buildIn ?? 0.3) + 0.05);
      toast('Drag it on the picture to place it, its corners to size it. More in its Callout tab.', 4000);
      return k;
    }
    const st = prefs(), c = newShapeClip(null, t);
    c.duration = 4;
    const line = kind === 'line' || kind === 'arrow';
    const a = app.doc.canvas.width / app.doc.canvas.height, half = 0.13;
    const box = line ? { x1: 0.36, y1: 0.62, x2: 0.62, y2: 0.4 } : { x1: 0.5 - half, y1: 0.5 - half * a * (kind === 'speech' || kind === 'thought' ? 0.8 : 1), x2: 0.5 + half, y2: 0.5 + half * a * (kind === 'speech' || kind === 'thought' ? 0.8 : 1) };
    c.shape = { ...c.shape, shape: kind, ...box, color: st.color, width: st.width, dash: st.dash, fill: false, fillColor: BOXY.has(kind) ? st.fillColor : '', ...(geom || {}) };
    c.name = NAMES[kind] || 'Shape';
    this.place(c);
    if (!(app.player.time >= c.start && app.player.time < c.start + c.duration)) app.seek(c.start + 0.35);
    return c;
  }

  // ---------------------------------------------------------------- sketch
  /** The pad over the picture: each stroke is read as a shape (or kept as drawn). */
  startSketch() {
    if (this.pad) return;
    const app = this.app;
    if (!app.doc) { toast('Open a project first.'); this.tool = 'select'; return; }
    const canvas = document.getElementById('preview');
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    const pad = this.pad = el('div', { class: 'mk-pad', title: 'Sketch: draw a shape · Esc to stop' }, svg);
    const fit = () => { const cr = canvas.getBoundingClientRect(), sr = this.stage.getBoundingClientRect(); Object.assign(pad.style, { left: cr.left - sr.left + 'px', top: cr.top - sr.top + 'px', width: cr.width + 'px', height: cr.height + 'px' }); };
    fit();
    this.stage.append(pad);
    this.padFit = new ResizeObserver(fit); this.padFit.observe(this.stage);
    this.esc = e => { if (e.key === 'Escape' && this.pad) { e.stopPropagation(); this.setTool('select'); } };
    window.addEventListener('keydown', this.esc, true);
    pad.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('.mk-chip')) return;
      e.preventDefault(); pad.setPointerCapture(e.pointerId);
      fit();
      const r = pad.getBoundingClientRect();
      const at = ev => [(ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height];
      const pts = [at(e)];
      const st = this.style();
      const line = document.createElementNS(NS, 'polyline');
      line.setAttribute('style', `fill:none;stroke:${st.color};stroke-width:${Math.max(2, (st.width * r.width) / app.doc.canvas.width)}px;stroke-linecap:round;stroke-linejoin:round`);
      svg.append(line);
      const move = ev => { const q = at(ev), l = pts[pts.length - 1]; if (Math.hypot((q[0] - l[0]) * r.width, (q[1] - l[1]) * r.height) < 2) return; pts.push(q); line.setAttribute('points', pts.map(([x, y]) => `${x * r.width},${y * r.height}`).join(' ')); };
      const up = () => {
        pad.removeEventListener('pointermove', move); pad.removeEventListener('pointerup', up);
        line.remove();
        if (pts.length > 2) this.sketched(pts.map(([x, y]) => [+clamp(x, -0.2, 1.2).toFixed(4), +clamp(y, -0.2, 1.2).toFixed(4)]), r);
      };
      pad.addEventListener('pointermove', move); pad.addEventListener('pointerup', up);
    });
    toast('Sketch: draw a box, an oval, an arrow, a star… roughly. Esc to stop.', 3500);
  }
  stopSketch() {
    if (!this.pad) return;
    this.pad.remove(); this.pad = null;
    this.padFit?.disconnect();
    window.removeEventListener('keydown', this.esc, true);
  }

  /** A stroke drawn: the clean shape it is, or the drawing itself; and a chip to keep the drawing instead. */
  sketched(pts, r) {
    const app = this.app, aspect = app.doc.canvas.width / app.doc.canvas.height;
    const shape = recognize(pts, aspect);
    const st = prefs();
    const asDrawing = () => {
      const d = newDrawClip(null, app.player.time);
      d.draw = { ...d.draw, color: st.color, width: st.width, drawOn: 0.5, strokes: [{ color: st.color, width: st.width, pts }] };
      d.name = 'Drawing';
      this.place(d);
      return d;
    };
    if (!shape) { asDrawing(); this.reselectPad(); return; }
    const { shape: kind, ...geom } = shape;
    const c = this.addShape(kind, geom);
    this.reselectPad();
    // “Keep my drawing”: undo the tidy-up for this one
    const [cx, cy] = [(geom.x2 + geom.x1) / 2, Math.max(geom.y1, geom.y2)];
    const chip = el('button', { class: 'mk-chip', type: 'button', style: { left: clamp(cx, 0.05, 0.85) * r.width + 'px', top: clamp(cy + 0.03, 0.03, 0.92) * r.height + 'px' } },
      el('b', { text: NAMES[kind] || 'Shape' }), el('span', { text: ' · Keep my drawing' }));
    chip.addEventListener('pointerdown', e => e.stopPropagation());
    chip.addEventListener('click', () => {
      chip.remove();
      app.commit(d => { d.clips = d.clips.filter(x => x.id !== c.id); });
      asDrawing(); this.reselectPad();
    });
    this.pad?.append(chip);
    setTimeout(() => chip.remove(), 5000);
  }
  /** The pad stays on top while sketching (selecting a new shape redraws the overlay under it). */
  reselectPad() { if (this.pad) this.stage.append(this.pad); }
}
