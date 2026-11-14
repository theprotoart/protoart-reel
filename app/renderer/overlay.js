// Direct manipulation in the preview: drag the selected clip to move it, drag its corner to
// scale it; callout boxes and arrow end points can be dragged too.
import { elementBox } from './lib/elements.js';
import { el, popMenu } from './ui.js';
import { propsAt, mediaById, ANIMATABLE, clipEnd, TEXT_DEFAULTS, animated, paramAt, setParam, clamp } from './model.js';
import { mediaRect, textFont } from './compositor.js';

export class Overlay {
  constructor(app) {
    this.app = app;
    this.root = document.getElementById('overlay');
    this.canvas = document.getElementById('preview');
    this.measure = document.createElement('canvas').getContext('2d');
    this.watchCropKey();
  }
  get doc() { return this.app.doc; }

  /** Clip-local props that edits should change: the selected action's target, or the base props. */
  target(c) {
    const a = this.app.selection.action ? (c.actions || []).find(x => x.id === this.app.selection.action) : null;
    const local = () => clamp(this.app.player.time - c.start, 0, c.duration), tol = 0.5 / (this.doc.canvas.fps || 30);
    return {
      get: k => (a ? (a.props && k in a.props ? a.props[k] : propsAt({ ...c, transIn: null, transOut: null, actions: c.actions.filter(x => x.t <= a.t) }, a.t + a.dur)[k]) : paramAt(c, 'props.' + k, local())),
      // keyframed parameters get a keyframe at the playhead; others change the clip itself
      set: (k, v) => { if (a && ANIMATABLE.includes(k)) a.props = { ...a.props, [k]: v }; else setParam(c, 'props.' + k, local(), v, tol); },
      action: a,
    };
  }

  update() {
    if (this.dragging) return; // the box being dragged follows the pointer itself
    const app = this.app, doc = this.doc;
    this.root.replaceChildren();
    if (!doc || !app.selection.clips.length || app.player.playing) return;
    // one picture in the selection gets the handles: a clip selected with its own sound (a recording's screen and
    // microphone, a PIP and its audio) still shows them, so it can be moved and scaled straight away
    const t = app.player.time;
    const sel = app.selection.clips.map(id => doc.clips.find(x => x.id === id)).filter(Boolean);
    const seen = sel.filter(x => !(x.type === 'media' && (x.audioOnly || mediaById(doc, x.media)?.kind === 'audio')));
    const onNow = seen.filter(x => t >= x.start && t < clipEnd(x));
    if (seen.length !== 1 && onNow.length !== 1) return;
    const c = onNow.length === 1 ? onNow[0] : seen[0];
    if (!c) return;
    if (t < c.start || t >= clipEnd(c)) return;
    const cr = this.canvas.getBoundingClientRect(), sr = this.root.parentElement.getBoundingClientRect();
    Object.assign(this.root.style, { left: cr.left - sr.left + 'px', top: cr.top - sr.top + 'px', width: cr.width + 'px', height: cr.height + 'px' });
    const W = cr.width, H = cr.height;
    const ca = animated(c, t - c.start);
    const p = propsAt({ ...ca, transIn: null, transOut: null }, t - c.start);
    if (c.type === 'media') {
      const m = mediaById(doc, c.media);
      if (!m || m.kind === 'audio') return;
      const r = mediaRect(doc, m, p, W, H, m.width || 1920, m.height || 1080);
      this.box(c, { x: r.cx - r.w / 2, y: r.cy - r.h / 2, w: r.w, h: r.h }, W, H, 'media');
    } else if (c.type === 'text') {
      const tx = { ...TEXT_DEFAULTS, ...ca.text };
      const sx = W / doc.canvas.width;
      this.measure.font = textFont(tx, sx);
      const lines = String(tx.content).split('\n');
      const w = Math.min(tx.width * W, Math.max(...lines.map(l => this.measure.measureText(l).width), 20)) * p.scale;
      const h = (tx.size * sx * tx.lineHeight * Math.max(1, lines.length)) * p.scale;
      this.box(c, { x: p.x * W - w / 2, y: p.y * H - h / 2, w, h }, W, H, 'text');
    } else if (c.type === 'callout') {
      const co = ca.callout;
      const x = (co.x + p.x - 0.5) * W, y = (co.y + p.y - 0.5) * H, w = co.w * p.scale * W, h = co.h * p.scale * H;
      this.box(c, { x: x - w / 2, y: y - h / 2, w, h }, W, H, 'callout');
    } else if (c.type === 'element') {
      const b = elementBox(ca.element, p, W, H);
      this.box(c, { x: p.x * W - b.w / 2, y: p.y * H - b.h / 2, w: b.w, h: b.h }, W, H, 'text');
    } else if (c.type === 'shape') {
      this.shapeHandles(c, p, W, H);
    }
  }

  box(c, r, W, H, kind) {
    const tgt = this.target(c);
    const media = kind === 'media' ? mediaById(this.doc, c.media) : null;
    const canCrop = !!media;
    const HANDLES = kind === 'callout' ? ['br'] : ['tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l'];
    const b = el('div', {
      class: 'sel-box' + (tgt.action ? ' action' : '') + (canCrop ? ' croppable' : ''),
      style: { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' },
      title: tgt.action ? 'Editing the selected action' : canCrop ? 'Drag to move · handles to resize from the opposite corner (⇧ from the centre) · hold ⌥ Option and drag a handle to crop · right-click for Full frame' : 'Drag to move · handles to resize (⇧ from the centre)',
    }, ...HANDLES.map(h => el('div', { class: 'h ' + h, 'data-h': h })));
    // like a colourist's / editor's transform box (DaVinci): it turns with the picture, has a rotation handle on a
    // stem above it and a dot at its centre
    const rot0 = kind === 'callout' ? 0 : Number(tgt.get('rotation')) || 0;
    if (rot0) b.style.transform = `rotate(${rot0}deg)`;
    if (r.y < 50 && !rot0) b.classList.add('rot-in'); // no room above (a full-frame picture): the rotation handle hangs inside
    if (kind !== 'callout') b.append(el('div', { class: 'rot-stem' }), el('div', { class: 'h rot', 'data-h': 'rot', title: 'Drag to rotate (hold ⇧ for steps of 15°) · double-click to straighten' }),
      el('div', { class: 'anchor', 'data-h': 'anchor', title: 'Drag to move · double-click to centre it in the frame' }));
    this.root.append(b);
    b.addEventListener('contextmenu', e => {
      e.preventDefault();
      const app = this.app;
      const set = (fn) => { app.beginChange(); fn(); app.endChange({ keepInspector: true }); };
      const fill = () => { // cover the frame
        const sw = media?.width || 1920, sh = media?.height || 1080, cr = tgt.get('crop') || [0, 0, 0, 0];
        const cw = sw * (1 - cr[0] - cr[2]), ch = sh * (1 - cr[1] - cr[3]);
        return Math.max(W / cw, H / ch) / Math.min(W / cw, H / ch);
      };
      const pip = kind === 'media' && ((Number(tgt.get('scale')) || 1) < 0.999 || Number(tgt.get('radius')) || Number(tgt.get('shadow')));
      popMenu(e.clientX, e.clientY, [
        pip ? ['↩ Full frame (undo picture in picture)', () => app.pictureInPicture('off')] : null,
        pip ? null : undefined,
        ['Centre', () => set(() => { tgt.set('x', 0.5); tgt.set('y', 0.5); })],
        ['Fit the frame', () => set(() => { tgt.set('x', 0.5); tgt.set('y', 0.5); tgt.set('scale', 1); })],
        media ? ['Fill the frame', () => set(() => { tgt.set('x', 0.5); tgt.set('y', 0.5); tgt.set('scale', fill()); })] : null,
        null,
        media ? ['Crop… (hold ⌥ Option and drag a handle)', null] : null,
        media ? ['Remove crop', () => set(() => { tgt.set('crop', [0, 0, 0, 0]); })] : null,
        ['Reset rotation', () => set(() => { tgt.set('rotation', 0); })],
        ['Reset opacity', () => set(() => { tgt.set('opacity', 1); })],
        null,
        ['🖼 Use this frame for the thumbnail…', () => app.cmd('thumb-from-frame')],
        null,
        c.keys && Object.keys(c.keys).length ? ['Remove all keyframes', () => app.commit(() => { delete c.keys; })] : null,
        (c.actions || []).length ? ['Remove all actions', () => app.commit(() => { c.actions = []; app.selection.action = null; })] : null,
        ['Delete clip', () => app.cmd('delete'), '⌫'],
      ]);
    });
    const guides = el('div', { class: 'snap-guides' });
    this.root.append(guides);
    const showGuides = (vx, hy) => {
      guides.replaceChildren(...vx.map(x => el('i', { class: 'gv', style: { left: x + 'px' } })), ...hy.map(y => el('i', { class: 'gh', style: { top: y + 'px' } })));
    };
    b.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      let handle = e.target.dataset?.h || null;
      // double-click the rotation handle: straight; double-click the centre dot: centred in the frame
      const now = performance.now(), dbl = this._lastDown && this._lastDown.h === handle && now - this._lastDown.t < 350;
      this._lastDown = { h: handle, t: now };
      if (dbl && (handle === 'rot' || handle === 'anchor')) {
        this.app.beginChange();
        if (handle === 'rot') tgt.set('rotation', 0); else { tgt.set('x', 0.5); tgt.set('y', 0.5); }
        this.app.endChange({ keepInspector: true }); this._lastDown = null; return;
      }
      if (handle === 'anchor') handle = null; // the centre dot moves the picture
      const cropping = canCrop && handle && handle !== 'rot' && (e.altKey || this.root.classList.contains('crop-mode'));
      const sx0 = e.clientX, sy0 = e.clientY;
      const app = this.app;
      const lt = clamp(app.player.time - c.start, 0, c.duration), tol = 0.5 / (this.doc.canvas.fps || 30);
      const cv = k => paramAt(c, 'callout.' + k, lt), setC = (k, v) => setParam(c, 'callout.' + k, lt, v, tol);
      const start = kind === 'callout' ? { x: cv('x'), y: cv('y'), w: cv('w'), h: cv('h') }
        : { x: tgt.get('x'), y: tgt.get('y'), scale: tgt.get('scale'), crop: [...(tgt.get('crop') || [0, 0, 0, 0])], rot: Number(tgt.get('rotation')) || 0 };
      const bc = b.getBoundingClientRect(), ccx = bc.left + bc.width / 2, ccy = bc.top + bc.height / 2, a0 = Math.atan2(sy0 - ccy, sx0 - ccx);
      // snapping targets in screen pixels: the frame's edges and centre
      const SNAP = 7;
      const snapTo = (v, list) => { for (const s of list) if (Math.abs(v - s) <= SNAP) return s; return null; };
      let moved = false;
      b.setPointerCapture(e.pointerId);
      const move = ev => {
        let dxp = ev.clientX - sx0, dyp = ev.clientY - sy0;
        if (!moved && Math.abs(dxp) + Math.abs(dyp) < 3) return;
        if (!moved) { moved = true; this.dragging = true; app.beginChange(); b.classList.toggle('cropping', !!cropping); }
        const vx = [], hy = [];
        // resizing and cropping a turned picture: the drag measured along its own sides
        if (handle && handle !== 'rot' && start.rot) {
          const th = -start.rot * Math.PI / 180, lx = dxp * Math.cos(th) - dyp * Math.sin(th), ly = dxp * Math.sin(th) + dyp * Math.cos(th);
          dxp = lx; dyp = ly;
        }
        if (handle === 'rot') {
          let deg = start.rot + (Math.atan2(ev.clientY - ccy, ev.clientX - ccx) - a0) * 180 / Math.PI;
          deg = ((deg + 540) % 360) - 180;
          if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
          else { const q = Math.round(deg / 90) * 90; if (Math.abs(deg - q) < 2.5) deg = q; } // straight and square are sticky
          tgt.set('rotation', +deg.toFixed(2));
          b.style.transform = deg ? `rotate(${deg}deg)` : '';
          b.dataset.deg = `${Math.round(deg)}°`;
        } else if (kind === 'callout') {
          const dx = dxp / W, dy = dyp / H;
          if (handle) { setC('w', Math.max(0.02, start.w + dx * 2)); setC('h', Math.max(0.02, start.h + dy * 2)); }
          else { setC('x', start.x + dx); setC('y', start.y + dy); }
          b.style.left = r.x + (handle ? 0 : dxp) + 'px'; b.style.top = r.y + (handle ? 0 : dyp) + 'px';
          if (handle) { b.style.width = Math.max(8, r.w + dxp) + 'px'; b.style.height = Math.max(8, r.h + dyp) + 'px'; }
        } else if (cropping) {
          // crop from the dragged side; what's left of the picture stays exactly where it was
          const sw = media.width || 1920, sh = media.height || 1080;
          const cw0 = sw * (1 - start.crop[0] - start.crop[2]), ch0 = sh * (1 - start.crop[1] - start.crop[3]);
          const k = r.w / Math.max(1, cw0); // screen px per source px
          const cr = [...start.crop];
          const fx = dxp / (sw * k), fy = dyp / (sh * k);
          if (handle.includes('l')) cr[0] = clamp(start.crop[0] + fx, 0, 0.95 - start.crop[2]);
          if (handle.includes('r')) cr[2] = clamp(start.crop[2] - fx, 0, 0.95 - start.crop[0]);
          if (handle.includes('t')) cr[1] = clamp(start.crop[1] + fy, 0, 0.95 - start.crop[3]);
          if (handle.includes('b')) cr[3] = clamp(start.crop[3] - fy, 0, 0.95 - start.crop[1]);
          const cw = sw * (1 - cr[0] - cr[2]), ch = sh * (1 - cr[1] - cr[3]);
          const fit0 = Math.min(W / Math.max(1, cw0), H / Math.max(1, ch0)), fit = Math.min(W / Math.max(1, cw), H / Math.max(1, ch));
          const scale = start.scale * fit0 / fit;
          // centre moves by half of what each side gave up
          const ox = ((cr[0] - start.crop[0]) - (cr[2] - start.crop[2])) * sw * k / 2, oy = ((cr[1] - start.crop[1]) - (cr[3] - start.crop[3])) * sh * k / 2;
          tgt.set('crop', cr); tgt.set('scale', scale); tgt.set('x', start.x + ox / W); tgt.set('y', start.y + oy / H);
          const nw = cw * k, nh = ch * k;
          Object.assign(b.style, { left: r.x + r.w / 2 + ox - nw / 2 + 'px', top: r.y + r.h / 2 + oy - nh / 2 + 'px', width: nw + 'px', height: nh + 'px' });
        } else if (handle && !ev.shiftKey) {
          // resize from the opposite corner or side, which stays put (⇧ resizes from the centre instead);
          // the moving edge snaps to the frame's edges
          const sgnX = handle.includes('l') ? -1 : handle.includes('r') ? 1 : 0, sgnY = handle.includes('t') ? -1 : handle.includes('b') ? 1 : 0;
          let grow = (sgnX && sgnY) ? 1 + (sgnX * dxp + sgnY * dyp) / (r.w + r.h) : sgnX ? 1 + sgnX * dxp / r.w : 1 + sgnY * dyp / r.h;
          grow = Math.max(0.03 / start.scale, grow);
          if (!start.rot) {
            const ax = r.x + r.w / 2 - sgnX * r.w / 2, ay = r.y + r.h / 2 - sgnY * r.h / 2; // the corner that stays
            const gx = sgnX ? [0, W].map(T => (T - ax) / (sgnX * r.w)).find(g => g > 0 && Math.abs(ax + sgnX * r.w * grow - (ax + sgnX * r.w * g)) <= SNAP) : undefined;
            const gy = sgnY ? [0, H].map(T => (T - ay) / (sgnY * r.h)).find(g => g > 0 && Math.abs(ay + sgnY * r.h * grow - (ay + sgnY * r.h * g)) <= SNAP) : undefined;
            if (gx !== undefined) { grow = gx; vx.push(ax + sgnX * r.w * grow); } else if (gy !== undefined) { grow = gy; hy.push(ay + sgnY * r.h * grow); }
          }
          // the centre moves away from the corner that stays, by half the growth (turned with the picture)
          const lx = sgnX * r.w / 2 * (grow - 1), ly = sgnY * r.h / 2 * (grow - 1), th = start.rot * Math.PI / 180;
          const ox = lx * Math.cos(th) - ly * Math.sin(th), oy = lx * Math.sin(th) + ly * Math.cos(th);
          const nw = r.w * grow, nh = r.h * grow, cx = r.x + r.w / 2 + ox, cy = r.y + r.h / 2 + oy;
          tgt.set('scale', Math.max(0.03, start.scale * grow)); tgt.set('x', start.x + ox / W); tgt.set('y', start.y + oy / H);
          Object.assign(b.style, { left: cx - nw / 2 + 'px', top: cy - nh / 2 + 'px', width: nw + 'px', height: nh + 'px' });
        } else if (handle) {
          // ⇧: resize about the centre; snaps when the picture's edges meet the frame's edges
          const sgnX = handle.includes('l') ? -1 : handle.includes('r') ? 1 : 0, sgnY = handle.includes('t') ? -1 : handle.includes('b') ? 1 : 0;
          let grow = (sgnX && sgnY) ? 1 + (sgnX * dxp * 2 + sgnY * dyp * 2) / (r.w + r.h)
            : sgnX ? 1 + sgnX * dxp * 2 / r.w : 1 + sgnY * dyp * 2 / r.h;
          grow = Math.max(0.03 / start.scale, grow);
          let nw = r.w * grow, nh = r.h * grow;
          const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
          // snap: left/right edges to 0 / W, or top/bottom to 0 / H
          const sxEdge = snapTo(cx - nw / 2, [0]) !== null || snapTo(cx + nw / 2, [W]) !== null;
          const syEdge = snapTo(cy - nh / 2, [0]) !== null || snapTo(cy + nh / 2, [H]) !== null;
          if (sxEdge) { const target = Math.abs(cx - nw / 2) < Math.abs(cx + nw / 2 - W) ? cx * 2 : (W - cx) * 2; grow = target / r.w; nw = r.w * grow; nh = r.h * grow; vx.push(cx - nw / 2, cx + nw / 2); }
          else if (syEdge) { const target = Math.abs(cy - nh / 2) < Math.abs(cy + nh / 2 - H) ? cy * 2 : (H - cy) * 2; grow = target / r.h; nw = r.w * grow; nh = r.h * grow; hy.push(cy - nh / 2, cy + nh / 2); }
          tgt.set('scale', Math.max(0.03, start.scale * grow));
          Object.assign(b.style, { left: cx - nw / 2 + 'px', top: cy - nh / 2 + 'px', width: nw + 'px', height: nh + 'px' });
        } else {
          // move: the centre snaps to the frame's centre, the edges to the frame's edges
          let L = r.x + dxp, T = r.y + dyp;
          const sCx = snapTo(L + r.w / 2, [W / 2]), sL = snapTo(L, [0]), sR = snapTo(L + r.w, [W]);
          if (sCx !== null) { L = W / 2 - r.w / 2; vx.push(W / 2); } else if (sL !== null) { L = 0; vx.push(0); } else if (sR !== null) { L = W - r.w; vx.push(W); }
          const sCy = snapTo(T + r.h / 2, [H / 2]), sT = snapTo(T, [0]), sB = snapTo(T + r.h, [H]);
          if (sCy !== null) { T = H / 2 - r.h / 2; hy.push(H / 2); } else if (sT !== null) { T = 0; hy.push(0); } else if (sB !== null) { T = H - r.h; hy.push(H); }
          tgt.set('x', start.x + (L - r.x) / W); tgt.set('y', start.y + (T - r.y) / H);
          b.style.left = L + 'px'; b.style.top = T + 'px';
        }
        showGuides(vx, hy);
        app.changed({ light: true, keepInspector: true });
      };
      const up = () => {
        b.removeEventListener('pointermove', move); b.removeEventListener('pointerup', up);
        this.dragging = false; guides.replaceChildren(); b.classList.remove('cropping'); delete b.dataset.deg;
        if (moved) app.endChange(); else this.update();
      };
      b.addEventListener('pointermove', move); b.addEventListener('pointerup', up);
    });
  }

  /** ⌥ Option held: the selection's handles become crop handles (as in ScreenFlow). */
  watchCropKey() {
    const set = on => this.root.classList.toggle('crop-mode', on);
    window.addEventListener('keydown', e => { if (e.key === 'Alt') set(true); });
    window.addEventListener('keyup', e => { if (e.key === 'Alt') set(false); });
    window.addEventListener('blur', () => set(false));
  }

  /** Annotation drawing: each drag adds a stroke in the clip's colour; Esc or Done finishes. */
  drawAnnotation(c) {
    const app = this.app;
    if (app.player.time < c.start || app.player.time >= c.start + c.duration) app.seek(c.start + Math.min(c.duration - 0.01, (c.draw.drawOn || 0) + 0.05));
    requestAnimationFrame(() => {
      this.update();
      const cr = this.canvas.getBoundingClientRect(), sr = this.root.parentElement.getBoundingClientRect();
      Object.assign(this.root.style, { left: cr.left - sr.left + 'px', top: cr.top - sr.top + 'px', width: cr.width + 'px', height: cr.height + 'px' });
      const pad = el('div', { class: 'draw-pad annot', title: 'Draw · Esc or Done to finish' });
      const svgNS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(svgNS, 'svg');
      const doneBtn = el('button', { class: 'hw amber draw-done', text: 'Done' });
      pad.append(svg, el('div', { class: 'draw-hint', text: 'Draw on the picture · Esc or Done to finish' }), doneBtn);
      this.root.append(pad);
      this.dragging = true;
      const finish = () => { pad.remove(); this.dragging = false; window.removeEventListener('keydown', esc, true); app.renderAll(); this.update(); };
      const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); finish(); } };
      window.addEventListener('keydown', esc, true);
      doneBtn.addEventListener('pointerdown', e => e.stopPropagation());
      doneBtn.addEventListener('click', finish);
      pad.addEventListener('pointerdown', e => {
        if (e.target === doneBtn) return;
        e.preventDefault(); pad.setPointerCapture(e.pointerId);
        const r = pad.getBoundingClientRect();
        const at = ev => [+((ev.clientX - r.left) / r.width).toFixed(4), +((ev.clientY - r.top) / r.height).toFixed(4)];
        const pts = [at(e)];
        const line = document.createElementNS(svgNS, 'polyline');
        line.setAttribute('style', `fill:none;stroke:${c.draw.color};stroke-width:${Math.max(2, c.draw.width * r.width / app.doc.canvas.width)}px;stroke-linecap:round;stroke-linejoin:round`);
        svg.append(line);
        const move = ev => { const q = at(ev), l = pts[pts.length - 1]; if (Math.hypot((q[0] - l[0]) * r.width, (q[1] - l[1]) * r.height) < 2) return; pts.push(q); line.setAttribute('points', pts.map(([x, y]) => `${x * r.width},${y * r.height}`).join(' ')); };
        const up = () => {
          pad.removeEventListener('pointermove', move); pad.removeEventListener('pointerup', up);
          if (pts.length > 1) app.commit(() => { c.draw.strokes.push({ color: c.draw.color, width: c.draw.width, pts }); }, { quiet: true });
          app.player.queueDraw();
        };
        pad.addEventListener('pointermove', move); pad.addEventListener('pointerup', up);
      });
    });
  }

  /** Freehand callout: drag around the area on the preview; the outline becomes the callout's shape. */
  drawFreehand(c) {
    const app = this.app;
    if (app.player.time < c.start || app.player.time >= c.start + c.duration) app.seek(c.start + 0.01);
    requestAnimationFrame(() => {
      this.update();
      const cr = this.canvas.getBoundingClientRect(), sr = this.root.parentElement.getBoundingClientRect();
      Object.assign(this.root.style, { left: cr.left - sr.left + 'px', top: cr.top - sr.top + 'px', width: cr.width + 'px', height: cr.height + 'px' });
      const pad = el('div', { class: 'draw-pad', title: 'Drag around the area to highlight · Esc to cancel' });
      const svgNS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(svgNS, 'svg');
      const line = document.createElementNS(svgNS, 'polyline');
      svg.append(line); pad.append(svg, el('div', { class: 'draw-hint', text: 'Drag around what you want to highlight' }));
      this.root.append(pad);
      this.dragging = true;
      const pts = [];
      const done = commit => {
        pad.remove(); this.dragging = false;
        window.removeEventListener('keydown', esc, true);
        if (commit && pts.length > 5) {
          const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
          const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
          const w = Math.max(0.01, x1 - x0), h = Math.max(0.01, y1 - y0);
          // thin the outline to at most ~80 points
          const step = Math.max(1, Math.floor(pts.length / 80));
          const path = pts.filter((_, i) => i % step === 0).map(([x, y]) => [+((x - x0) / w - 0.5).toFixed(4), +((y - y0) / h - 0.5).toFixed(4)]);
          app.commit(() => { Object.assign(c.callout, { shape: 'freehand', path, x: x0 + w / 2, y: y0 + h / 2, w, h }); });
        } else this.update();
      };
      const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
      window.addEventListener('keydown', esc, true);
      pad.addEventListener('pointerdown', e => {
        e.preventDefault(); pad.setPointerCapture(e.pointerId);
        const at = ev => { const r = pad.getBoundingClientRect(); return [(ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height]; };
        pts.length = 0; pts.push(at(e));
        const move = ev => { pts.push(at(ev)); const r = pad.getBoundingClientRect(); line.setAttribute('points', pts.map(([x, y]) => `${x * r.width},${y * r.height}`).join(' ')); };
        const up = () => { pad.removeEventListener('pointermove', move); pad.removeEventListener('pointerup', up); done(true); };
        pad.addEventListener('pointermove', move); pad.addEventListener('pointerup', up);
      });
    });
  }

  shapeHandles(c, p, W, H) {
    const s = c.shape, ox = (p.x - 0.5) * W, oy = (p.y - 0.5) * H;
    for (const [kx, ky] of [['x1', 'y1'], ['x2', 'y2']]) {
      const h = el('div', { class: 'sel-box', style: { left: s[kx] * W + ox - 8 + 'px', top: s[ky] * H + oy - 8 + 'px', width: '16px', height: '16px', borderRadius: '50%' } });
      this.root.append(h);
      h.addEventListener('pointerdown', e => {
        e.preventDefault();
        const app = this.app, sx0 = e.clientX, sy0 = e.clientY, x0 = s[kx], y0 = s[ky];
        let moved = false;
        h.setPointerCapture(e.pointerId);
        const move = ev => {
          if (!moved) { moved = true; this.dragging = true; app.beginChange(); }
          h.style.left = x0 * W + ox - 8 + (ev.clientX - sx0) + 'px'; h.style.top = y0 * H + oy - 8 + (ev.clientY - sy0) + 'px';
          s[kx] = x0 + (ev.clientX - sx0) / W; s[ky] = y0 + (ev.clientY - sy0) / H;
          app.changed({ light: true, keepInspector: true });
        };
        const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); this.dragging = false; if (moved) app.endChange(); };
        h.addEventListener('pointermove', move); h.addEventListener('pointerup', up);
      });
    }
  }
}
