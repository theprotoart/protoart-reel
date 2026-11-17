// Timeline: tracks with a Pro Tools–style header (solo, mute, hide, volume, pan, automation lane),
// clips with their keyframes, automation lanes, markers and the playhead. Move, trim, snap, drop,
// marquee-select, scrub (also while playing) and zoom from a single frame out to the whole project.
import { el, $, popMenu, toast, ask } from './ui.js';
import { clipEnd, isFree, addTrack, snap, trim, setSpeed, SPEED_STEPS, mediaById, duration, fmtTime, keyAt, withGroups, TRACK_LANES, gainToPos, posToGain, fmtDb, fmtPan, clamp, neighbour, roll, KEY_EASES, split, tidyCrossfades, cutsOn, crossfadeOverlaps, fadeShape, putKey, emptyTracks, OVERLAP_CUTS, applyCut } from './model.js';
import { peaksFor, posterFor } from './peaks.js';
import { mapAt, addPoint, movePoint, removePoint, linearRetime } from './lib/retime.js';
import { musicLike, fitSource, refitTo, canFit } from './musicfit.js';
import { renderingNow } from './fx.js';
import { openSpeedPanel } from './speedpanel.js';
import { copyEffects, copyAction } from './clipops.js';
import { openTransitions, transName } from './transpicker.js';
import { TRANSITIONS } from './inspector.js';
import { pref } from './prefs.js';
import { outOfSync } from './lib/sync.js';
import { dropPreset } from './fxlibrary.js';
import { dial } from './gear.js';
import { fxRack, fxRackH } from './fxrack.js';
import { roleButton, tint } from './automix.js';
import { setZoomAt, moveZoomKey, removeZoomKey, removeDynZoom, dropZoomMoves, countZoomMoves } from './lib/dynzoom.js';
import { soundTracks, ROLES } from './lib/automix.js';
import { addFiller, playRange, fillerMenu, removeFiller } from './fillers.js';

const LANE_H = 52;
const CAP_H = 30;
const MAX_PPS = 400;
const LANE = {
  volume: { label: 'Volume', def: 1, toPos: gainToPos, fromPos: posToGain, fmt: fmtDb, unit: 'dB' },
  pan: { label: 'Pan', def: 0, toPos: v => (1 - v) / 2, fromPos: p => 1 - p * 2, fmt: fmtPan, unit: '' }, // top = left
  // each clip's zoom (its scale keyframes): 50% at the bottom, 100% a third of the way up, 400% at the top
  zoom: { label: 'Zoom', def: 1, toPos: v => clamp((Math.log2(Math.max(1e-3, v)) + 1) / 3, 0, 1), fromPos: p => 2 ** (p * 3 - 1), fmt: v => Math.round(v * 100) + '%', unit: '' },
};
// a picture on the timeline (not sound): what the Zoom lane shows
const isPicture = (doc, c) => !(c.type === 'media' && (c.audioOnly || mediaById(doc, c.media)?.kind === 'audio'));

/** What an action's bar says: a zoom move's zoom and how long it takes ("↗ 200% · 1.2 s"), or just how long. */
function actLabel(a) {
  const p = a.props || {}, len = `${a.dur < 10 ? a.dur.toFixed(1) : Math.round(a.dur)} s`;
  if ('scale' in p) return `${p.scale > 1.01 ? '🔍' : '↩'} ${Math.round(p.scale * 100)}% · ${len}`;
  if ('x' in p || 'y' in p) return `↔ ${len}`;
  return len;
}

/** A short track's own classes: its knobs fold away (compact), then all but its name (tiny). */
const rowClass = h => (h < 34 ? ' rh-compact rh-tiny' : h < 50 ? ' rh-compact' : '');

export class Timeline {
  constructor(app) {
    this.app = app;
    this.scroll = $('#tl-scroll');
    this.tracksEl = $('#tl-tracks');
    this.heads = $('#tl-heads');
    this.ruler = $('#ruler');
    this.playheadEl = $('#playhead');
    this.pps = 40;
    this.zoomInput = $('#tl-zoom');
    this.zoomInput.addEventListener('input', () => this.setZoomFromSlider());
    this.scroll.addEventListener('scroll', () => { this.heads.scrollTop = this.scroll.scrollTop; this.drawRuler(); });
    // over the track names: scroll moves up and down; ⌘-scroll (or a pinch) makes every track taller or shorter
    this.heads.addEventListener('wheel', e => {
      if (e.metaKey || e.ctrlKey) { e.preventDefault(); this.setTrackHeight(this.trackH() * Math.exp(-e.deltaY * 0.01)); return; }
      this.scroll.scrollTop += e.deltaY;
    }, { passive: false });
    this.vzoomInput = $('#tl-vzoom');
    this.vzoomInput?.addEventListener('input', () => this.setTrackHeight(+this.vzoomInput.value));
    // zoom like a DAW: trackpad pinch, ⌘-scroll, or rolling a mouse wheel zooms around the pointer; a trackpad's
    // two-finger scroll still scrolls (⇧-wheel scrolls sideways, ⌥-wheel up and down)
    this.scroll.addEventListener('wheel', e => {
      const mouseWheel = e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 40 && Number.isInteger(e.deltaY));
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); this.zoomAt(Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey ? 0.012 : 0.004)), e.clientX); return; }
      if (e.shiftKey && mouseWheel) { e.preventDefault(); this.scroll.scrollLeft += e.deltaY; return; }
      if (mouseWheel && !e.altKey) { e.preventDefault(); this.zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX); }
    }, { passive: false });
    // middle button (press the wheel) and drag: the hand tool, moving the view around
    this.scroll.addEventListener('pointerdown', e => {
      if (e.button !== 1) return;
      e.preventDefault(); e.stopPropagation();
      this.scroll.setPointerCapture(e.pointerId); this.scroll.classList.add('hand');
      const x0 = e.clientX, y0 = e.clientY, sl = this.scroll.scrollLeft, st = this.scroll.scrollTop;
      const mv = ev => { this.scroll.scrollLeft = sl - (ev.clientX - x0); this.scroll.scrollTop = st - (ev.clientY - y0); };
      const up = () => { this.scroll.classList.remove('hand'); this.scroll.removeEventListener('pointermove', mv); this.scroll.removeEventListener('pointerup', up); };
      this.scroll.addEventListener('pointermove', mv); this.scroll.addEventListener('pointerup', up);
    }, true);
    this.scroll.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
    new ResizeObserver(() => { this.syncSlider(); this.drawRuler(); }).observe(this.scroll);
    this._rulerEvents();
    this._dropEvents();
    this.tool = 'select';
    this._bladeLine = el('div', { class: 'blade-line hidden' });
    this.scroll.append(this._bladeLine);
    this.scroll.addEventListener('pointermove', e => this._bladeHover(e));
    this.scroll.addEventListener('pointerleave', () => this._bladeLine.classList.add('hidden'));
    this.tracksEl.addEventListener('contextmenu', e => this._emptyMenu(e));
    // the empty space under the track headers: delete empty tracks, add one
    this.heads.addEventListener('contextmenu', e => { if (e.target.closest('.tl-head, .tl-lanehead, .tl-fxhead, button, select, input')) return; e.preventDefault(); this.app.tracksMenu(e.clientX, e.clientY); });
  }

  /** A (select) or T (blade, like ScreenFlow's split tool): click a clip with the blade to cut it there. */
  /** ✚ CLIPS (keep a part): while on, dragging across the timeline marks a part to keep for Auto Edit. */
  setMarking(on) {
    if (on && this.filling) this.setFilling(false);
    this.marking = !!on;
    document.getElementById('timeline')?.classList.toggle('marking', this.marking);
    for (const b of document.querySelectorAll('.keep-part-btn')) b.classList.toggle('lit', this.marking);
  }
  /** 〰 FILLER: while on, dragging across a voice track marks an um (or any filler sound) to teach Reel. */
  setFilling(on) {
    if (on && this.marking) this.setMarking(false);
    this.filling = !!on;
    document.getElementById('timeline')?.classList.toggle('filling', this.filling);
    for (const b of document.querySelectorAll('.filler-btn')) b.classList.toggle('lit', this.filling);
  }
  /** The track row under a point on the tracks (a layout row), or null. */
  _fillRowAt(clientY) {
    const y = clientY - this.tracksEl.getBoundingClientRect().top;
    return this.layout().find(r => y >= r.top && y < r.top + r.h) || null;
  }
  /** Fillers: a red band with a black zig-zag on their track. Click to hear one; drag its edges; right-click to teach. */
  _drawFillers() {
    const rows = new Map(this.layout().map(r => [r.tr.id, r]));
    for (const f of this.doc.fillers || []) {
      const r = rows.get(f.track); if (!r) continue;
      const tag = el('span', { class: 'filler-tag' },
        el('button', { text: '▶', title: 'Play this filler', onclick: e => { e.stopPropagation(); playRange(this.app, f.t0, f.t1); } }),
        el('b', { text: (f.taught ? '✓ ' : '') + (f.word === 'umm' || !f.word ? 'UM' : f.word === 'not' ? 'NOT' : f.word.toUpperCase().slice(0, 10)) }),
        el('button', { text: '×', title: 'Remove this filler', onclick: e => { e.stopPropagation(); removeFiller(this.app, f.id); } }));
      const hl = el('div', { class: 'filler-h l', title: 'Drag to change where it starts' }), hr = el('div', { class: 'filler-h r', title: 'Drag to change where it ends' });
      const box = el('div', { class: 'filler' + (f.taught ? ' taught' : ''), 'data-filler': f.id,
        title: `Filler ${fmtTime(f.t0)} – ${fmtTime(f.t1)} · click ▶ to hear it · drag the edges · right-click to teach it`,
        style: { left: this.x(f.t0) + 'px', top: (r.top + 2) + 'px', width: Math.max(6, this.x(f.t1 - f.t0)) + 'px', height: (r.h - 4) + 'px' } }, tag, hl, hr);
      hl.addEventListener('pointerdown', e => this._fillerDrag(e, f.id, 't0'));
      hr.addEventListener('pointerdown', e => this._fillerDrag(e, f.id, 't1'));
      box.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); fillerMenu(this.app, f, e.clientX, e.clientY); });
      this.tracksEl.append(box);
    }
  }
  _fillerDrag(e, id, edge) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const app = this.app, f0 = (this.doc.fillers || []).find(f => f.id === id); if (!f0) return;
    const orig = f0[edge], x0 = e.clientX, box = this.tracksEl.querySelector(`[data-filler="${id}"]`);
    let v = orig, started = false;
    const move = ev => {
      if (!started) { if (Math.abs(ev.clientX - x0) < 2) return; started = true; }
      v = Math.max(0, orig + this.t(ev.clientX - x0));
      if (edge === 't0') v = Math.min(v, f0.t1 - 0.05); else v = Math.max(v, f0.t0 + 0.05);
      const a = edge === 't0' ? v : f0.t0, b = edge === 't1' ? v : f0.t1;
      if (box) { box.style.left = this.x(a) + 'px'; box.style.width = Math.max(6, this.x(b - a)) + 'px'; }
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (!started) return;
      app.commit(d => { const f = (d.fillers || []).find(x => x.id === id); if (f) { f[edge] = v; delete f.taught; } });
      const f = this.doc.fillers.find(x => x.id === id); if (f) playRange(app, f.t0, f.t1);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  /** Drag a kept part's edge (start / end) or the whole part (move); it never runs into its neighbours. */
  /** Snap for parts: clip edges, markers, the playhead and the edges of the other parts (so parts meet exactly). */
  _partSnap(t, skipId = null) {
    if (!this.snapOn) return t;
    const edges = (this.doc.sections || []).filter(p => p.id !== skipId).flatMap(p => [p.t0, p.t1]);
    return this._snap(this.doc, t, this._tol(), [], [this.app.player.time, ...edges]);
  }
  _partDrag(e, id, what) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const app = this.app, doc0 = this.doc, p0 = (doc0.sections || []).find(p => p.id === id);
    if (!p0) return;
    const orig = { t0: p0.t0, t1: p0.t1 }, x0 = e.clientX;
    let started = false;
    document.body.classList.add('part-dragging');
    const move = ev => {
      const dt = this.t(ev.clientX - x0);
      if (!started) { if (Math.abs(ev.clientX - x0) < 3) return; started = true; app.beginChange(); }
      const secs = (this.doc.sections || []).slice().sort((a, b) => a.t0 - b.t0), p = secs.find(q => q.id === id);
      if (!p) return;
      // parts may touch their neighbours exactly (no gap), never overlap them
      const i = secs.indexOf(p), lo = i > 0 ? secs[i - 1].t1 : 0, hi = i < secs.length - 1 ? secs[i + 1].t0 : Math.max(duration(this.doc), orig.t1);
      const snapT = t => this._partSnap(t, id);
      if (what === 'start') p.t0 = Math.max(lo, Math.min(orig.t1 - 0.3, snapT(orig.t0 + dt)));
      else if (what === 'end') p.t1 = Math.min(hi, Math.max(orig.t0 + 0.3, snapT(orig.t1 + dt)));
      else {
        // moving a whole part: whichever edge is nearer something to snap to, snaps
        const len = orig.t1 - orig.t0, a0 = orig.t0 + dt;
        const sa = snapT(a0), sb = snapT(a0 + len) - len;
        const a = Math.max(lo, Math.min(hi - len, Math.abs(sa - a0) <= Math.abs(sb - a0) ? sa : sb));
        p.t0 = a; p.t1 = a + len;
      }
      app.changed({ light: true, keepInspector: true });
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      document.body.classList.remove('part-dragging');
      if (started) app.endChange({ keepInspector: true });
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  setTool(tool) {
    this.tool = tool === 'blade' ? 'blade' : tool === 'forward' ? 'forward' : 'select';
    document.getElementById('timeline')?.classList.toggle('tool-blade', this.tool === 'blade');
    document.getElementById('timeline')?.classList.toggle('tool-forward', this.tool === 'forward');
    // the SELECT key shows which select tool is on: ▲ one at a time, ⇉ everything to the right
    for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('lit', b.dataset.tool === this.tool || (b.dataset.tool === 'select' && this.tool === 'forward'));
    const sb = document.querySelector('[data-tool=select]');
    if (sb) { const lab = sb.querySelector('.sel-label') || sb.insertBefore(Object.assign(document.createElement('span'), { className: 'sel-label' }), sb.firstChild); for (const n of [...sb.childNodes]) if (n.nodeType === 3) n.remove(); lab.textContent = this.tool === 'forward' ? '⇉ FORWARD ' : '▲ SELECT '; }
    if (this.tool !== 'blade') this._bladeLine.classList.add('hidden');
  }
  /** Select forward: everything that starts at or after t, on every track (locked tracks left out). */
  selectForward(t) {
    const doc = this.doc;
    const locked = id => doc.tracks.find(x => x.id === id)?.locked;
    const ids = doc.clips.filter(c => c.start >= t - 1e-3 && !locked(c.track)).map(c => c.id);
    this.app.select(ids, null);
    return ids;
  }
  /** Where the blade would cut: snaps to the playhead and clip edges when SNAP is on. */
  _bladeTime(clientX) {
    let t = Math.max(0, this._timeAt(clientX));
    if (this.snapOn) t = this._snap(this.doc, t, this._tol(), [], [this.app.player.time]);
    return t;
  }
  _bladeHover(e) {
    if (this.tool !== 'blade' || !this.doc) return;
    const t = this._bladeTime(e.clientX);
    Object.assign(this._bladeLine.style, { left: this.x(t) + 'px', height: (28 + this.totalH()) + 'px' });
    this._bladeLine.classList.remove('hidden');
  }

  /** Right-click on empty timeline. */
  _emptyMenu(e) {
    if (!(e.target === this.tracksEl || e.target.classList.contains('tl-row'))) return;
    e.preventDefault();
    const app = this.app, t = Math.max(0, this._timeAt(e.clientX));
    popMenu(e.clientX, e.clientY, [
      ['Move playhead here', () => app.seek(t)],
      ['Add marker here', () => { app.seek(t); app.cmd('marker'); }, 'M'],
      null,
      ['Splice all clips here', () => { app.seek(t); app.cmd('split'); }],
      ['Insert gap here…', () => { app.seek(t); app.cmd('insert-gap'); }],
      ['Close gap', () => { app.seek(t); app.cmd('close-gap'); }],
      ['Close every gap on all tracks', () => app.cmd('close-all-gaps')],
      null,
      emptyTracks(app.doc).length && app.doc.tracks.length > 1 ? [`Delete empty tracks (${emptyTracks(app.doc).length})`, () => app.deleteEmptyTracks()] : null,
      null,
      ['Select everything from here', () => { app.seek(t); app.cmd('select-after'); }, '⇧⌘A'],
      ['Select all', () => app.cmd('select-all'), '⌘A'],
      null,
      ['Insert text', () => { app.seek(t); app.cmd('insert-text'); }],
      ['Insert callout', () => { app.seek(t); app.cmd('insert-callout'); }],
      [this.tool === 'blade' ? 'Use the select tool' : 'Use the blade (split) tool', () => this.setTool(this.tool === 'blade' ? 'select' : 'blade'), this.tool === 'blade' ? 'A' : 'T'],
    ]);
  }

  /** Right-click on a clip. */
  _clipMenu(e, c) {
    e.preventDefault(); e.stopPropagation();
    const app = this.app;
    if (!app.selection.clips.includes(c.id)) app.select(withGroups(this.doc, [c.id]), null);
    const t = clamp(this._timeAt(e.clientX), c.start, clipEnd(c));
    const m = c.type === 'media' ? mediaById(this.doc, c.media) : null;
    const hasKeys = c.keys && Object.keys(c.keys).length, nActions = (c.actions || []).length;
    const audioish = c.type === 'media' && (c.audioOnly || m?.kind === 'audio' || m?.hasAudio);
    const fade = (side, dur) => app.commit(() => {
      if (audioish) c.audio[side === 'in' ? 'fadeIn' : 'fadeOut'] = dur;
      if (!c.audioOnly && m?.kind !== 'audio') c[side === 'in' ? 'transIn' : 'transOut'] = dur ? { type: 'fade', dur } : { type: 'none', dur: 0.5 };
    });
    popMenu(e.clientX, e.clientY, [
      ['Splice here', () => app.commit(d => { split(d, t, withGroups(d, [c.id])); })],
      ['Splice at playhead', () => app.cmd('split'), 'S'],
      null,
      ['Duplicate', () => app.cmd('duplicate'), '⌘D'],
      ['Delete', () => app.cmd('delete'), '⌫'],
      ['Ripple delete', () => app.cmd('ripple-delete'), '⇧⌫'],
      ...(this._unsynced?.has(c.id) || [...(this._unsynced?.values() || [])].some(x => x.pic.id === c.id) ? [['⇆ Put back in sync', () => app.cmd('resync', [c.id])]] : []),
      this._unsynced?.size ? [`⇆ Put every clip back in sync (${this._unsynced.size})`, () => app.cmd('resync')] : null,
      null,
      ['Fade in (½ s)', () => fade('in', Math.min(0.5, c.duration / 2))],
      ['Fade out (½ s)', () => fade('out', Math.min(0.5, c.duration / 2))],
      ['Remove fades', () => { fade('in', 0); fade('out', 0); }],
      ...(c.audioOnly || m?.kind === 'audio' ? [] : [null, ['🔍 Dynamic zoom (start & end frames)…', () => { app.select([c.id]); app.cmd('dynamic-zoom'); }]]),
      // bounce in place: render the effects into new audio on a track below; originals muted and greyed out
      c.bounced || c.bounceOf ? ['↩ Back to the original sound (remove the rendered copy)', () => app.cmd('bounce-revert')]
        : audioish && !c.audio?.mute ? ['⤓ Bounce to new track (render effects in place)', () => app.cmd('bounce')] : null,
      audioish ? (() => { const tr = this.doc.tracks.find(t => t.id === c.track), on = app.autoLevelOn(tr); return [on ? `✓ Auto Level (on “${tr?.name || 'track'}”)` : `Auto Level (even out the volume)`, () => app.toggleAutoLevel(tr)]; })() : null,
      (() => { // transitions and crossfades on every selected clip (after ⌘A: the whole edit)
        const sel = this.doc.clips.filter(x => app.selection.clips.includes(x.id));
        const has = x => (x.transIn && x.transIn.type !== 'none') || (x.transOut && x.transOut.type !== 'none') || x.xfadeIn || x.xfadeOut;
        const n = sel.filter(has).length;
        return n ? [`Remove transitions${sel.length > 1 ? ` (${n} clips)` : ''}`, () => app.commit(d => {
          const ids = new Set(sel.map(x => x.id));
          for (const x of d.clips) {
            if (!ids.has(x.id)) continue;
            x.transIn = { type: 'none', dur: x.transIn?.dur || 0.5 }; x.transOut = { type: 'none', dur: x.transOut?.dur || 0.5 };
            // a crossfade goes with both of its clips
            if (x.xfadeIn) { delete x.xfadeIn; const o = d.clips.find(y => y.track === x.track && Math.abs(clipEnd(y) - x.start) < 1e-3); if (o) delete o.xfadeOut; }
            if (x.xfadeOut) { delete x.xfadeOut; const o = d.clips.find(y => y.track === x.track && Math.abs(y.start - clipEnd(x)) < 1e-3); if (o) delete o.xfadeIn; }
          }
        })] : null;
      })(),
      (c.filters || []).length ? [`Remove all filters (${c.filters.length})`, () => app.commit(() => { c.filters = []; })] : null,
      null,
      hasKeys ? [`Remove all keyframes (${Object.values(c.keys).flat().length})`, () => app.commit(() => { delete c.keys; })] : ['No keyframes', null],
      nActions ? [`Remove all actions (${nActions})`, () => app.commit(() => { c.actions = []; }, { keepInspector: false })] : ['No actions', null],
      ...this._everyClipActions(),
      null,
      c.type === 'media' && m?.kind !== 'image' ? [`Speed up (now ${Math.round((c.speed || 1) * 100)}%)`, () => app.cmd('speed-up'), '⌥⌘.'] : null,
      c.type === 'media' && m?.kind !== 'image' ? ['Slow down', () => app.cmd('speed-down'), '⌥⌘,'] : null,
      c.type === 'media' && m?.kind !== 'image' ? ['Speed…', () => app.cmd('speed-custom')] : null,
      c.type === 'media' && (c.speed || 1) !== 1 ? ['Normal speed', () => app.cmd('speed-normal')] : null,
      c.type === 'media' ? [c.reversed ? 'Play forwards' : 'Play in reverse', () => app.cmd('reverse')] : null,
      // Elastic Wave and the retime curve: stretch parts of a clip, pitch kept
      audioish && !c.reversed ? [c.elastic ? '✓ Elastic Wave (double-click the clip to add a marker)' : '〰 Elastic Wave: stretch parts without changing pitch', () => app.commit(() => { if (c.elastic) delete c.elastic; else c.elastic = true; })] : null,
      c.type === 'media' && m?.kind !== 'image' && !c.reversed ? ['⤳ Retime curve…', () => { app.select([c.id], null); app.revealSection('Retime curve'); }] : null,
      c.retime ? ['Remove Elastic Wave / retime (back to an even speed)', () => app.commit(() => { delete c.retime; c.speed = Math.abs((c.speed || 1) - 1) < 1e-3 ? 1 : c.speed; })] : null,
      audioish ? ['👻 Isolate or remove a sound (describe it)…', () => { app.select([c.id], null); app.cmd('ghost'); }] : null,
      audioish ? ['🎵 Fit the music to a length (extend or shorten)…', () => { app.select([c.id], null); app.cmd('music-fit'); }] : null,
      audioish && (c.adrOriginal || app.selection.clips.length === 2) ? [c.adrOriginal ? 'Restore original take' : 'Align to guide (ADR)…', () => app.cmd('adr-align'), '⌥⌘A'] : null,
      audioish ? [c.spectral ? `Spectral edit… (${c.spectral.edits?.length || 0} edits)` : 'Spectral edit…', () => { app.select([c.id], null); app.cmd('spectral'); }, '⌥⌘S'] : null,
      m?.kind === 'video' && m.hasAudio && !c.audioOnly ? ['Detach audio', () => app.cmd('detach-audio')] : null,
      c.type === 'media' && (m?.kind === 'video' || audioish) ? [c.group ? '⚡ Auto Edit this clip (with its group)…' : '⚡ Auto Edit this clip…', () => { app.select([c.id], null); app.cmd('autoedit-clip'); }] : null,
      [c.disabled ? 'Enable clip' : 'Disable clip', () => app.cmd('disable'), 'V'],
      [c.locked ? 'Unlock' : 'Lock', () => app.cmd('lock')],
      [c.group ? 'Ungroup' : 'Group', () => app.cmd(c.group ? 'ungroup' : 'group')],
      ['Rename…', () => app.cmd('rename-clip')],
      null,
      m && ['video', 'image'].includes(m.kind) && !c.audioOnly ? ['▣ Picture in picture (corner; again: next corner)', () => app.cmd('pip')] : null,
      m && ['video', 'image'].includes(m.kind) && !c.audioOnly ? ['🟩 Green screen (key out a colour)', () => app.cmd('green-screen')] : null,
      m?.kind === 'video' && !c.audioOnly ? ['✂ Remove background (no green screen)', () => app.cmd('remove-background')] : null,
      m?.kind === 'video' && !c.audioOnly ? [c.stab ? '🎥 Stabilize settings…' : '🎥 Stabilize (smooth a shaky camera)', () => app.cmd('stabilize')] : null,
      null,
      ['Copy effects (zooms, filters, sound effects)', () => app.cmd('copy-effects')],
      app.effectsClip ? [app.effectsClip.single ? 'Paste action at playhead' : 'Paste effects', () => app.cmd('paste-effects')] : ['Paste effects', null],
      ['Copy style', () => app.cmd('copy-style')],
      ['Paste style', () => app.cmd('paste-style')],
      m ? ['Show media in Finder', () => app.api.revealMedia?.(app.token, m.file)] : null,
    ]);
  }

  /** Right-click on a keyframe diamond. */
  _keyMenu(e, c, kt) {
    e.preventDefault(); e.stopPropagation();
    const app = this.app;
    const near = k => Math.abs(k.t - kt) < 1e-3;
    const here = Object.entries(c.keys || {}).filter(([, l]) => l.some(near));
    const del = paths => app.commit(() => {
      for (const p of paths) { c.keys[p] = c.keys[p].filter(k => !near(k)); if (!c.keys[p].length) delete c.keys[p]; }
      if (c.keys && !Object.keys(c.keys).length) delete c.keys;
    }, { keepInspector: true });
    popMenu(e.clientX, e.clientY, [
      ['Jump to this keyframe', () => app.seek(c.start + kt)],
      ['Delete keyframe', () => del(here.map(([p]) => p)), '⌥-click'],
      ...(here.length > 1 ? here.map(([p]) => [`Delete only ${p.split('.')[1]}`, () => del([p])]) : []),
      null,
      ...KEY_EASES.map(([v, label]) => [`Curve: ${label}`, () => app.commit(() => { for (const [, l] of here) for (const k of l) if (near(k)) k.ease = v; }, { keepInspector: true })]),
      null,
      ['Delete every keyframe on this clip', () => app.commit(() => { delete c.keys; })],
    ]);
  }

  /** Right-click on a zoom & pan action. */
  _actionMenu(e, c, a) {
    e.preventDefault(); e.stopPropagation();
    const app = this.app;
    popMenu(e.clientX, e.clientY, [
      ['Edit this action', () => { app.select([c.id], a.id); app.seek(c.start + a.t + a.dur); }],
      ['Jump to its start', () => app.seek(c.start + a.t)],
      null,
      ['Copy this action', () => copyAction(app, a)],
      ['Copy all this clip’s effects', () => copyEffects(app, c)],
      app.effectsClip ? ['Paste effects onto this clip', () => { app.select([c.id], null); app.cmd('paste-effects'); }] : null,
      null,
      ['Delete action', () => app.commit(() => { c.actions = c.actions.filter(x => x !== a); app.selection.action = null; })],
      ['Duplicate at playhead', () => app.commit(() => {
        const t = clamp(app.player.time - c.start, 0, Math.max(0, c.duration - a.dur));
        c.actions.push({ ...structuredClone(a), id: 'a' + Math.random().toString(36).slice(2, 9), t });
        c.actions.sort((x, y) => x.t - y.t);
      })],
      null,
      ['Delete every action on this clip', () => app.commit(() => { c.actions = []; app.selection.action = null; })],
      ...this._everyClipActions(),
    ]);
  }
  /** Menu rows that clear actions from every clip in the project (asks first, says how many; ⌘Z brings them back). */
  _everyClipActions() {
    const app = this.app, clips = this.doc.clips;
    const nAll = clips.reduce((n, k) => n + (k.actions || []).length, 0), withAny = clips.filter(k => (k.actions || []).length).length;
    const nZoom = clips.reduce((n, k) => n + countZoomMoves(k), 0), withZoom = clips.filter(k => countZoomMoves(k)).length;
    const s = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    return [
      nZoom ? [`Delete every zoom move on every clip (${nZoom})…`, async () => {
        if (!(await ask('Delete every zoom move?', `This takes out ${s(nZoom, 'zoom move')} on ${s(withZoom, 'clip')} (the push-ins and pans, like Auto Edit’s). Fades and other actions stay. ⌘Z brings them back.`, 'Delete zoom moves'))) return;
        app.commit(() => { for (const k of this.doc.clips) dropZoomMoves(k); app.selection.action = null; }, { keepInspector: false });
        toast(`Deleted ${s(nZoom, 'zoom move')}`);
      }] : null,
      nAll ? [`Delete every action on every clip (${nAll})…`, async () => {
        if (!(await ask('Delete every action on every clip?', `This takes out all ${s(nAll, 'action')} on ${s(withAny, 'clip')}: zoom moves, fades and everything else. ⌘Z brings them back.`, 'Delete all actions'))) return;
        app.commit(() => { for (const k of this.doc.clips) if ((k.actions || []).length) k.actions = []; app.selection.action = null; }, { keepInspector: false });
        toast(`Deleted ${s(nAll, 'action')}`);
      }] : null,
    ];
  }
  get doc() { return this.app.doc; }
  get snapOn() { return $('#snap').checked; }
  /** REMIX switch (by SNAP): the end of a music clip re-fits the song seamlessly instead of trimming. */
  get remixOn() { const r = $('#remix'); return !!(r && r.checked); }
  /** Does this clip's end re-fit the song (REMIX on, a sound clip, the last section of a fitted song)? */
  remixable(c) { return this.remixOn && (c.musicFit ? musicLike(this.doc, c) : canFit(this.doc, c)); }
  get scrubAudio() { return $('#scrub')?.checked; }
  x(t) { return t * this.pps; }
  t(x) { return x / this.pps; }

  // ---------------------------------------------------------------- zoom
  /** Pixels per second that show the whole project (plus a little room). */
  fitPps() { return clamp((this.scroll.clientWidth - 40) / Math.max(5, duration(this.doc || { clips: [] }) * 1.05), 0.0005, MAX_PPS); }
  /** Fewest pixels per second the slider allows: never less zoomed-out than the whole project. */
  minPps() { return Math.min(2, this.fitPps()); }
  _toSlider(pps) { const lo = this.minPps(); return Math.log(pps / lo) / Math.log(MAX_PPS / lo); }
  _fromSlider(v) { const lo = this.minPps(); return lo * Math.pow(MAX_PPS / lo, v); }
  syncSlider() { if (this.doc) { this.pps = clamp(this.pps, this.minPps(), MAX_PPS); this.zoomInput.value = this._toSlider(this.pps); } }
  /** The zoom slider, − and +: zoom around the playhead (it stays put on screen; centred if it was off screen). */
  setZoomFromSlider() {
    const want = this._fromSlider(Number(this.zoomInput.value));
    this.zoomAtTime(want / this.pps, this.app.player.time);
  }
  zoomAt(f, clientX) {
    const rect = this.scroll.getBoundingClientRect();
    const at = this.t(this.scroll.scrollLeft + clientX - rect.left);
    this.pps = clamp(this.pps * f, this.minPps(), MAX_PPS);
    this.zoomInput.value = this._toSlider(this.pps);
    this.render();
    this.scroll.scrollLeft = Math.max(0, this.x(at) - (clientX - rect.left));
  }
  /** Zoom all the way out: the whole project in view. */
  /** Scrolls the timeline so these clips are in view (up/down to their tracks, sideways to their start). */
  reveal(ids) {
    const els = ids.map(id => this.tracksEl.querySelector(`.clip[data-id="${id}"]`)).filter(Boolean);
    if (!els.length) return;
    const sr = this.scroll.getBoundingClientRect();
    const top = Math.min(...els.map(e => e.getBoundingClientRect().top)), bottom = Math.max(...els.map(e => e.getBoundingClientRect().bottom));
    const left = Math.min(...els.map(e => e.getBoundingClientRect().left));
    if (top < sr.top + 30) this.scroll.scrollTop += top - sr.top - 30;
    else if (bottom > sr.bottom - 10) this.scroll.scrollTop += Math.min(bottom - sr.bottom + 10, top - sr.top - 30);
    if (left < sr.left || left > sr.right - 80) this.scroll.scrollLeft += left - sr.left - 60;
    for (const e of els) { e.classList.add('just-added'); setTimeout(() => e.classList.remove('just-added'), 1600); }
  }
  fit() {
    this.pps = this.fitPps();
    this.zoomInput.value = this._toSlider(this.pps);
    this.render();
    this.scroll.scrollLeft = 0;
  }
  zoom(f) { this.zoomAtTime(f, this.app.player.time); }
  /** Zoom all the way in (single frames), keeping the playhead where it is on screen; again goes back. */
  zoomMax() {
    if (this.pps >= MAX_PPS * 0.98 && this._beforeMax) { const back = this._beforeMax; this._beforeMax = null; this.zoomAtTime(back / this.pps, this.app.player.time); return; }
    this._beforeMax = this.pps;
    this.zoomAtTime(MAX_PPS / this.pps, this.app.player.time);
  }
  zoomAtTime(f, t) {
    const rect = this.scroll.getBoundingClientRect();
    let sx = this.x(t) - this.scroll.scrollLeft;
    if (sx < 0 || sx > this.scroll.clientWidth) sx = this.scroll.clientWidth / 2; // playhead off screen: centre it
    this.zoomAt(f, rect.left + sx);
  }

  // ---------------------------------------------------------------- track height (the vertical zoom)
  /** Every track this tall (22–160 px), remembered for next time. */
  setTrackHeight(px) {
    this._fitBack = null;
    this.applyTrackHeight(px, true);
  }
  applyTrackHeight(px, remember) {
    const h = Math.round(Math.min(160, Math.max(22, +px || 58)));
    document.documentElement.style.setProperty('--track-h', h + 'px');
    const tl = document.getElementById('timeline');
    tl?.classList.toggle('th-compact', h < 50); // the track's knobs fold away: name and keys only
    tl?.classList.toggle('th-tiny', h < 34);    // just the name
    if (this.vzoomInput) this.vzoomInput.value = h;
    if (remember) { try { localStorage.setItem('reel.trackPx', JSON.stringify(h)); } catch { /* fine */ } }
    if (this.doc) { const mid = this.scroll.scrollTop; this.render(); this.scroll.scrollTop = mid; }
  }
  /** Every track in view at once; again, back to the height before. */
  fitTracks() {
    if (!this.doc) return;
    if (this._fitBack) { const b = this._fitBack; this._fitBack = null; this.applyTrackHeight(b, true); return; }
    const n = this.doc.tracks.reduce((a, t) => a + (t.hk > 0 ? t.hk : 1), 0) || 1, extra = this.layout().reduce((a, r) => a + (r.end - r.top - r.h), 0); // lanes and racks under tracks
    const room = this.scroll.clientHeight - 30 - this.capH() - extra;
    const was = this.trackH();
    this.applyTrackHeight(Math.floor(room / n), true);
    this._fitBack = was;
    this.scroll.scrollTop = 0;
  }

  // ---------------------------------------------------------------- layout
  trackH() { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--track-h')) || 58; }
  /** One track's own height: the tracks' height times its own factor (⌃ ⌄ on its header, or drag its lower edge). */
  rowH(tr) { return Math.round(Math.min(320, Math.max(22, this.trackH() * (tr.hk > 0 ? tr.hk : 1)))); }
  /** Makes one track taller or shorter (factor on the tracks' height), as one ⌘Z. */
  setRowH(tr, hk) {
    const k = Math.round(Math.min(6, Math.max(0.25, hk)) * 100) / 100;
    this.app.commit(() => { if (Math.abs(k - 1) < 0.03) delete tr.hk; else tr.hk = k; });
  }
  /** Rows top to bottom: { tr, top, h (clip row), lane, laneTop }. */
  /** Height of the caption lane above the tracks (shown when there are captions or you open it). */
  capH() { return this.doc && ((this.doc.captions || []).length || this.app.showCaptionLane) ? CAP_H : 0; }
  layout() {
    let y = this.capH();
    return this.doc.tracks.map(tr => {
      const lane = LANE[tr.lane] ? tr.lane : null;
      const fxH = tr.fxOpen ? fxRackH(tr) : 0;
      const h = this.rowH(tr);
      const r = { tr, top: y, h, lane, laneTop: y + h, fxTop: y + h + (lane ? LANE_H : 0), fxH, end: y + h + (lane ? LANE_H : 0) + fxH };
      y = r.end;
      return r;
    });
  }
  totalH() { const l = this.layout(); const r = l[l.length - 1]; return r ? r.end : this.capH(); }
  contentWidth() { return Math.max(this.scroll.clientWidth, this.x(duration(this.doc) + 30)); }

  // ---------------------------------------------------------------- render
  render() {
    if (!this.doc) return;
    tidyCrossfades(this.doc);
    this._soundIds = null; // which tracks have sound (for the role tags), worked out again each draw
    try { this._unsynced = new Map(outOfSync(this.doc).map(x => [x.clip.id, x])); } catch (err) { console.warn('sync check', err); this._unsynced = new Map(); }
    const doc = this.doc, sel = new Set(this.app.selection.clips);
    const W = this.contentWidth();
    this.tracksEl.style.width = W + 'px';
    this.tracksEl.replaceChildren();
    this.heads.replaceChildren();
    const anySolo = doc.tracks.some(t => t.solo);
    if (this.capH()) { this.tracksEl.append(this._captionLane(W)); this.heads.append(this._captionHead()); }
    for (const [i, row] of this.layout().entries()) {
      const tr = row.tr;
      const r = el('div', { class: 'tl-row' + (tr.locked ? ' locked-track' : '') + (tr.hidden ? ' hidden-track' : '') + (anySolo && !tr.solo ? ' unsoloed' : '') + rowClass(row.h), 'data-track': tr.id, style: { height: row.h + 'px' } });
      r.style.setProperty('--track-h', row.h + 'px'); // its clips are sized from it
      for (const c of doc.clips.filter(c => c.track === tr.id)) r.append(this._clipEl(c, sel.has(c.id)));
      // a ⧓ on every cut where two pictures meet: click to pick a transition (CapCut-style)
      for (const [a, b] of cutsOn(doc, tr.id)) {
        const ma = a.type === 'media' ? mediaById(doc, a.media) : null, mb = b.type === 'media' ? mediaById(doc, b.media) : null;
        if (a.audioOnly || b.audioOnly || ma?.kind === 'audio' || mb?.kind === 'audio') continue;
        const has = b.transIn && b.transIn.type !== 'none';
        const btn = el('button', { class: 'cut-btn' + (has ? ' on' : ''), title: has ? 'Transition here: click to change it' : 'Add a transition here', style: { left: this.x(clipEnd(a)) + 'px' }, text: '⧓' });
        btn.addEventListener('pointerdown', e => e.stopPropagation());
        btn.addEventListener('click', e => { e.stopPropagation(); const open = document.querySelector('.tp-panel'); if (open?._setCut) open._setCut([a, b]); else openTransitions(this.app, [a, b]); });
        r.append(btn);
      }
      this.tracksEl.append(r);
      this.heads.append(this._head(tr, i));
      if (row.lane) {
        this.tracksEl.append(this._lane(tr, row.lane, W));
        this.heads.append(this._laneHead(tr, row.lane));
      }
      if (row.fxH) {
        this.tracksEl.append(el('div', { class: 'tl-fxrow', style: { height: row.fxH + 'px' } }));
        this.heads.append(fxRack(this.app, tr, row.fxH));
      }
    }
    this.heads.append(el('div', { class: 'tl-add' }, el('button', { class: 'mini', text: '+ Track', onclick: () => this.app.addTrack() })));
    for (const m of doc.markers || []) {
      const line = el('div', { class: 'marker', style: { left: this.x(m.t) + 'px' } });
      // a flag to grab: click jumps there, right-click to rename or delete, ⌥-click deletes
      const flag = el('div', { class: 'marker-flag', title: `${m.label || 'Marker'} (${fmtTime(m.t)}) · click to jump · right-click to rename or delete · ⌥-click deletes` });
      flag.addEventListener('pointerdown', ev => {
        ev.stopPropagation(); ev.preventDefault();
        if (ev.button !== 0) return;
        if (ev.altKey) { this.app.commit(d => { d.markers = d.markers.filter(x => !(Math.abs(x.t - m.t) < 1e-6 && x.label === m.label)); }); toast('Marker deleted (⌘Z brings it back).', 2500); return; }
        this.app.seek(m.t);
      });
      flag.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); this._markerMenu(m, ev.clientX, ev.clientY); });
      line.append(flag);
      this.tracksEl.append(line);
    }
    // parts kept for Auto Edit: green outlines; everything else is greyed out
    const parts = (doc.sections || []).slice().sort((a, b) => a.t0 - b.t0);
    if (parts.length) {
      const H = this.totalH(), end = Math.max(duration(doc), parts.at(-1).t1);
      let at = 0;
      for (const p of [...parts, { t0: end + 1e6, t1: 0 }]) {
        if (p.t0 > at + 0.01) this.tracksEl.append(el('div', { class: 'part-dim', style: { left: this.x(at) + 'px', width: this.x(Math.min(p.t0, end) - at) + 'px', height: H + 'px' } }));
        at = Math.max(at, p.t1);
      }
      parts.forEach((p, i) => {
        const tag = el('span', { class: 'part-tag', title: 'Drag to move this part · × to drop it' }, `PART ${i + 1}`, el('button', { text: '×', title: 'Don’t keep this part', onclick: e => { e.stopPropagation(); this.app.cmd('remove-section:' + p.id); } }));
        const hl = el('div', { class: 'part-h l', title: 'Drag to change where this part starts' }), hr = el('div', { class: 'part-h r', title: 'Drag to change where this part ends' });
        hl.addEventListener('pointerdown', e => this._partDrag(e, p.id, 'start'));
        hr.addEventListener('pointerdown', e => this._partDrag(e, p.id, 'end'));
        tag.addEventListener('pointerdown', e => { if (!e.target.closest('button')) this._partDrag(e, p.id, 'move'); });
        this.tracksEl.append(el('div', { class: 'part-keep', 'data-part': p.id, style: { left: this.x(p.t0) + 'px', width: Math.max(4, this.x(p.t1 - p.t0)) + 'px', height: H + 'px' } }, tag, hl, hr));
      });
    }
    this._drawFillers();
    this.tracksEl.style.height = this.totalH() + 'px';
    this.drawRuler();
    this.updatePlayhead(this.app.player.time);
  }

  // ---------------------------------------------------------------- captions lane
  _captionHead() {
    const app = this.app;
    return el('div', { class: 'tl-caphead', style: { height: CAP_H + 'px' } },
      el('span', { class: 'engr', text: 'Captions' }),
      (this.doc.captions || []).length ? el('button', { class: 'cap-trash', text: '🗑 DELETE ALL', title: `Delete all ${(this.doc.captions || []).length} captions (it asks first; ⌘Z brings them back)`, onclick: () => app.cmd('captions-clear') }) : null,
      el('button', { class: 'th-btn', text: '+', title: 'Add a caption at the playhead (⌃⌘C)', onclick: () => app.cmd('add-caption') }),

      el('button', { class: 'th-btn' + (app.showCaptions !== false ? ' on' : ''), text: 'CC', title: 'Show captions in the preview', onclick: () => { app.showCaptions = app.showCaptions === false; app.player.queueDraw(); this.render(); } }));
  }
  _captionLane(W) {
    const app = this.app, doc = this.doc;
    const lane = el('div', { class: 'tl-caplane', style: { height: CAP_H + 'px', width: W + 'px' } });
    for (const cap of doc.captions || []) {
      const sel = app.selection.caption === cap.id;
      const b = el('div', { class: 'cap' + (sel ? ' selected' : ''), title: cap.text, style: { left: this.x(cap.t) + 'px', width: Math.max(6, this.x(cap.end - cap.t)) + 'px' } },
        el('span', { text: cap.text.replace(/\n/g, ' ') }), el('i', { class: 'edge l' }), el('i', { class: 'edge r' }));
      b.addEventListener('pointerdown', e => this._capDrag(e, cap));
      b.addEventListener('dblclick', () => app.focusInspector());
      b.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); this._capMenu(e, cap); });
      lane.append(b);
    }
    lane.addEventListener('pointerdown', e => { if (e.target === lane) { app.selectCaption(null); app.seek(Math.max(0, this._timeAt(e.clientX))); } });
    lane.addEventListener('contextmenu', e => { e.preventDefault(); this._capMenu(e, null); });
    return lane;
  }
  /** Right-click in the caption lane: this caption, or all of them. */
  _capMenu(e, cap) {
    const app = this.app;
    const items = [];
    if (cap) items.push(['Edit this caption', () => { app.selectCaption(cap.id); app.focusInspector(); }], ['Delete this caption', () => { app.selection.caption = null; app.commit(d => { d.captions = d.captions.filter(c => c.id !== cap.id); }); }], null);
    items.push(['Add a caption at the playhead', () => app.cmd('add-caption')], ['Import SRT / VTT…', () => app.cmd('captions-import')], null,
      [`Delete all captions (${(this.doc.captions || []).length})…`, () => app.cmd('captions-clear')]);
    popMenu(e.clientX, e.clientY, items);
  }
  _capDrag(e, cap) {
    e.stopPropagation();
    if (e.button !== 0) return;
    const app = this.app;
    if (app.selection.caption !== cap.id) app.selectCaption(cap.id, { noTimeline: true });
    const edge = e.target.classList.contains('edge') ? (e.target.classList.contains('l') ? 'l' : 'r') : null;
    const x0 = e.clientX, t0 = cap.t, e0 = cap.end;
    let moved = false;
    const move = ev => {
      const dt = this.t(ev.clientX - x0);
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      if (!moved) { moved = true; app.beginChange(); }
      const sn = v => (this.snapOn ? this._snap(this.doc, v, this._tol(), [], [app.player.time]) : v);
      if (edge === 'l') cap.t = clamp(sn(t0 + dt), 0, e0 - 0.1);
      else if (edge === 'r') cap.end = Math.max(cap.t + 0.1, sn(e0 + dt));
      else { const nt = Math.max(0, sn(t0 + dt)); cap.t = nt; cap.end = nt + (e0 - t0); }
      app.changed({ light: true, keepInspector: true });
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (moved) { this.doc.captions.sort((a, b) => a.t - b.t); app.endChange(); } else { app.selectCaption(cap.id); app.seek(cap.t); }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  /** Track header: name · Solo Mute Hide · move · remove / lane picker · volume · pan. */
  /**
   * Drag a track by its grip (☰) or name to a new place in the stack, like ScreenFlow: a line shows where it
   * will land, and its clips, effects and settings go with it. Esc cancels.
   */
  _dragTrack(e, tr, viaName = false) {
    if (e.button !== 0) return;
    e.preventDefault();
    const app = this.app, heads = [...this.heads.querySelectorAll('.tl-head[data-track]')];
    const from = this.doc.tracks.indexOf(tr), x0 = e.clientX, y0 = e.clientY;
    const src = heads.find(h => h.dataset.track === tr.id);
    let started = !viaName, to = from;
    const box = this.heads.getBoundingClientRect();
    const line = el('div', { class: 'track-drop-line', style: { left: box.left + 'px', width: (this.scroll.getBoundingClientRect().right - box.left) + 'px' } });
    const begin = () => { started = true; document.body.append(line); src?.classList.add('dragging'); document.body.classList.add('dragging-track'); };
    if (started) begin();
    const move = ev => {
      if (!started) { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return; begin(); }
      // the slot: before the first head whose middle is below the pointer
      let k = heads.length;
      for (let j = 0; j < heads.length; j++) { const r = heads[j].getBoundingClientRect(); if (ev.clientY < r.top + r.height / 2) { k = j; break; } }
      to = k > from ? k - 1 : k;
      const ref = heads[k] ? heads[k].getBoundingClientRect().top : heads[heads.length - 1].getBoundingClientRect().bottom;
      line.style.top = (ref - 1) + 'px';
      line.classList.toggle('same', to === from);
    };
    const end = (commit) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('keydown', key, true);
      line.remove(); src?.classList.remove('dragging'); document.body.classList.remove('dragging-track');
      if (commit && started && to !== from) app.commit(d => { const i = d.tracks.findIndex(t => t.id === tr.id); d.tracks.splice(to, 0, d.tracks.splice(i, 1)[0]); });
    };
    const up = () => end(true);
    const key = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); end(false); } };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('keydown', key, true);
  }

  _head(tr, i) {
    const app = this.app, doc = this.doc;
    const btn = (label, on, title, fn, cls = '') => el('button', { class: `th-btn ${cls}${on ? ' on' : ''}`, text: label, title, onclick: fn });
    // ◆ KEYS: opens the keyframe and automation lane under the track, like Audition's envelopes (zoom for a picture
    // track, volume for sound; the lane's own menu switches it)
    const isSound = (this._soundIds ||= new Set(soundTracks(doc).map(t => t.id))).has(tr.id) || !!tr.role;
    const keyed = tr.auto && Object.values(tr.auto).some(l => l?.length) || doc.clips.some(c => c.track === tr.id && c.keys && Object.keys(c.keys).length);
    const laneSel = el('button', { class: 'th-keys' + (tr.lane ? ' on' : '') + (keyed ? ' has' : ''), text: `${tr.lane ? '▾' : '▸'} ◆ KEYS`,
      title: tr.lane ? 'Hide the keyframe lane' : 'Show this track’s keyframes and automation in a lane under it: zoom for pictures, volume and pan for sound',
      onclick: () => app.commit(() => { tr.lane = tr.lane ? undefined : (tr.lastLane || (isSound ? 'volume' : 'zoom')); }) });
    const knob = (lane) => {
      const L = LANE[lane];
      const hasAuto = !!(tr.auto && tr.auto[lane] && tr.auto[lane].length) && tr.autoMode !== 'off';
      const now = hasAuto ? keyAt(tr.auto[lane], app.player.time, L.def) : (tr[lane] ?? L.def);
      let touching = false;
      // knobs turn clockwise to the right; the lane draws left at the top like Pro Tools
      const kPos = lane === 'pan' ? v => (v + 1) / 2 : L.toPos, kVal = lane === 'pan' ? p => p * 2 - 1 : L.fromPos;
      const d = dial(null, {
        value: now, def: L.def, toPos: kPos, fromPos: kVal, fmt: L.fmt, size: 20,
        title: `${L.label}${hasAuto ? ' (automated: turning it while playing in Touch mode records new points)' : ''} · drag, scroll, double-click to reset`,
        onStart: () => { app.beginChange(); touching = true; },
        onInput: v => {
          if (hasAuto) {
            // Touch mode records while playing; when stopped, the point at the playhead moves (or is added)
            if (!app.player.playing) writeAuto(tr, lane, app.player.time, v, 1 / 60);
            else if (tr.autoMode === 'touch') writeAuto(tr, lane, app.player.time, v, 0.04);
          } else tr[lane] = v;
          app.changed({ light: true, keepInspector: true, noTimeline: true }); // keep the knob under the pointer

        },
        onCommit: () => { if (touching) { touching = false; app.endChange({ keepInspector: true }); } },
      });
      d.el.classList.add(lane);
      if (hasAuto) d.el.classList.add('auto');
      return d.el;
    };
    const grip = el('span', { class: 'th-grip', text: '☰', title: 'Drag to move this track up or down' });
    grip.addEventListener('pointerdown', e => this._dragTrack(e, tr));
    const sound = isSound;
    const rh = this.rowH(tr);
    // ScreenFlow's ⌃ ⌄: this track taller or shorter on its own (⌥-click: back to the others' height); or drag its lower edge
    const sizeKeys = el('span', { class: 'th-size' },
      el('button', { type: 'button', text: '⌃', title: 'Make this track taller (⌥-click: the same height as the others)', onclick: e => { e.stopPropagation(); this.setRowH(tr, e.altKey ? 1 : (tr.hk || 1) * 1.3); } }),
      el('button', { type: 'button', text: '⌄', title: 'Make this track shorter (⌥-click: the same height as the others)', onclick: e => { e.stopPropagation(); this.setRowH(tr, e.altKey ? 1 : (tr.hk || 1) / 1.3); } }));
    const edge = el('div', { class: 'th-resize', title: 'Drag to make this track taller or shorter · double-click: the same height as the others', ondblclick: () => this.setRowH(tr, 1) });
    edge.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const y0 = e.clientY, h0 = rh, base = this.trackH();
      let moved = false;
      const move = ev => {
        if (!moved && Math.abs(ev.clientY - y0) < 2) return;
        if (!moved) { moved = true; this.app.beginChange(); }
        tr.hk = Math.min(6, Math.max(0.25, (h0 + ev.clientY - y0) / base));
        const mid = this.scroll.scrollTop; this.render(); this.scroll.scrollTop = mid;
      };
      // on the window: the timeline is drawn again as it goes, which replaces this edge
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); if (moved) { if (Math.abs(tr.hk - 1) < 0.03) delete tr.hk; this.app.endChange(); } };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
    const head = el('div', { class: 'tl-head' + (tr.solo ? ' soloed' : '') + rowClass(rh), 'data-track': tr.id, style: { height: rh + 'px' }, oncontextmenu: e => { if (e.target.closest('select, input')) return; e.preventDefault(); app.trackMenu(tr, e.clientX, e.clientY); } },
      el('div', { class: 'th-top' }, grip,
        el('span', { class: 'tname', text: tr.name, title: 'Drag to move the track · double-click to rename', ondblclick: () => app.renameTrack(tr), onpointerdown: e => this._dragTrack(e, tr, true) }),
        sound ? roleButton(app, tr, { dot: true }) : null,
        btn('S', tr.solo, 'Solo: hear only soloed tracks', () => app.commit(() => { tr.solo = !tr.solo; }), 'solo'),
        btn('M', tr.muted, 'Mute this track', () => app.commit(() => { tr.muted = !tr.muted; }), 'mute'),
        btn('H', tr.hidden, 'Hide this track’s picture', () => app.commit(() => { tr.hidden = !tr.hidden; })),
        btn(tr.locked ? '🔒' : '🔓', !!tr.locked, tr.locked ? 'Locked: nothing on this track can be changed. Click to unlock' : 'Lock this track so nothing on it can be changed (moved, trimmed, cut, deleted) and edits elsewhere leave it alone', () => app.toggleTrackLock(tr), 'lockbtn'),
        btn('fx', !!tr.fxOpen || (tr.fx || []).some(f => !f.off), `Effects on this track${(tr.fx || []).length ? ` (${tr.fx.length})` : ''}: EQ, compressor, de-esser, reverb… Click to open the rack`, () => app.commit(() => { tr.fxOpen = !tr.fxOpen; }), 'fxbtn'),
        btn('↑', false, 'Move track up (⌥-click: down). Right-click the header for more', e => app.commit(() => { const d = e?.altKey ? 1 : -1; if (i + d >= 0 && i + d < doc.tracks.length) doc.tracks.splice(i + d, 0, doc.tracks.splice(i, 1)[0]); })),
        btn('×', false, 'Delete this track (asks first when it has clips)', () => app.removeTrack(tr))),
      el('div', { class: 'th-bottom' }, laneSel,
        el('span', { class: 'th-k' }, el('i', { text: 'VOL' }), knob('volume')),
        el('span', { class: 'th-k' }, el('i', { text: 'PAN' }), knob('pan'))));
    head.append(sizeKeys, edge);
    head.style.setProperty('--track-h', rh + 'px');
    tint(head, tr);
    return head;
  }

  /** The lane's "Show:" menu: which keyframes or automation it shows (and × to close it). */
  _laneShow(tr, lane) {
    const app = this.app;
    const sel = el('select', { class: 'th-lane', title: 'What this lane shows' }, ...TRACK_LANES.map(([v, t]) => el('option', { value: v, text: t, selected: lane === v })));
    sel.addEventListener('change', () => app.commit(() => { tr.lane = sel.value; tr.lastLane = sel.value; }));
    return el('span', { class: 'lane-show' }, el('i', { class: 'engr lane-name', text: 'Show' }), sel,
      el('button', { class: 'th-btn lane-x', text: '×', title: 'Hide this lane (◆ KEYS on the track shows it again)', onclick: () => app.commit(() => { tr.lane = undefined; }) }));
  }

  _laneHead(tr, lane) {
    const app = this.app;
    if (lane === 'zoom') {
      const n = this.doc.clips.filter(c => c.track === tr.id && (c.keys?.['props.scale'] || []).length).length;
      return el('div', { class: 'tl-lanehead', style: { height: LANE_H + 'px' } },
        el('div', { class: 'th-top' }, this._laneShow(tr, lane)),
        el('div', { class: 'th-top' }, el('span', { class: 'note', text: n ? `${n} clip${n > 1 ? 's' : ''} zoomed` : 'Click a clip’s line to add a key', title: 'Each clip’s zoom as a line: click to add a key · drag a key (sideways for when, up and down for how far) · ⌥-click or double-click to delete · right-click for the curve' })));
    }
    const mode = el('select', { class: 'th-lane', title: 'Read plays the automation · Touch records knob moves while playing · Off ignores it' },
      ...[['read', 'Read'], ['touch', 'Touch'], ['off', 'Off']].map(([v, t]) => el('option', { value: v, text: t, selected: (tr.autoMode || 'read') === v })));
    mode.addEventListener('change', () => app.commit(() => { tr.autoMode = mode.value === 'read' ? undefined : mode.value; }));
    const n = tr.auto?.[lane]?.length || 0;
    return el('div', { class: 'tl-lanehead', style: { height: LANE_H + 'px' } },
      el('div', { class: 'th-top' }, this._laneShow(tr, lane), mode),
      el('div', { class: 'th-top' }, el('span', { class: 'note', text: n ? `${n} point${n > 1 ? 's' : ''}`: 'Click the lane to add points', title: 'Click the line to add a point · drag to move · double-click a point (or select it and press ⌫) to delete · right-click for curves' }),
        n ? el('button', { class: 'th-btn', text: 'Clear', title: 'Remove this lane’s automation', onclick: () => app.commit(() => { delete tr.auto[lane]; }) }) : null));
  }

  /**
   * Zoom lane: each picture clip's zoom as a line, like Resolve's keyframe curves. Click a clip's line to add a key,
   * drag a key sideways (when) and up or down (how far in), ⌥-click or double-click to delete, right-click for the
   * curve. The spot in the middle of the screen stays put as the zoom changes.
   */
  _zoomLane(tr, W) {
    const app = this.app, L = LANE.zoom;
    const box = el('div', { class: 'tl-lane zoom-lane', style: { height: LANE_H + 'px' } });
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', W); svg.setAttribute('height', LANE_H);
    box.append(svg);
    const pad = 6, hh = LANE_H - pad * 2;
    const yOf = v => pad + (1 - L.toPos(v)) * hh;
    const vOf = y => L.fromPos(clamp(1 - (y - pad) / hh, 0, 1));
    const clips = () => this.doc.clips.filter(c => c.track === tr.id && isPicture(this.doc, c));
    const draw = () => {
      svg.replaceChildren();
      const mk = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); svg.append(n); return n; };
      mk('line', { x1: 0, x2: W, y1: yOf(1), y2: yOf(1), class: 'lane-ref' });
      for (const c of clips()) {
        const x0 = this.x(c.start), x1 = this.x(c.start + c.duration);
        const list = c.keys?.['props.scale'] || [];
        mk('rect', { x: x0, y: 1, width: Math.max(1, x1 - x0), height: LANE_H - 2, class: 'zoom-span', 'data-clip': c.id });
        if (!list.length) { const y = yOf(c.props?.scale ?? 1); mk('line', { x1: x0, x2: x1, y1: y, y2: y, class: 'lane-line flat', 'data-clip': c.id }); continue; }
        // the curve, sampled so eases show their shape
        let d = '';
        const steps = Math.max(8, Math.round((x1 - x0) / 4));
        for (let i = 0; i <= steps; i++) { const t = (c.duration * i) / steps; d += `${i ? 'L' : 'M'}${this.x(c.start + t)} ${yOf(keyAt(list, t, 1))}`; }
        mk('path', { d, class: 'lane-line', 'data-clip': c.id });
        list.forEach((k, i) => {
          const sel = this.selPoint && this.selPoint.zoom === c.id && this.selPoint.k === k;
          const pt = mk('circle', { cx: this.x(c.start + k.t), cy: yOf(k.v), r: sel ? 5.5 : 4.5, class: 'lane-pt' + (sel ? ' sel' : ''), 'data-clip': c.id, 'data-i': i });
          const ti = document.createElementNS(NS, 'title'); ti.textContent = `${fmtTime(c.start + k.t)} · zoom ${L.fmt(k.v)}\nDrag to move · ⌥-click or double-click to delete · right-click for the curve`; pt.append(ti);
        });
      }
    };
    draw();
    const at = e => {
      const id = e.target.dataset?.clip;
      const c = id ? this.doc.clips.find(x => x.id === id) : null;
      const i = e.target.dataset?.i !== undefined ? Number(e.target.dataset.i) : -1;
      return { c, i, k: c && i >= 0 ? c.keys?.['props.scale']?.[i] : null };
    };
    box.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const { c, k: hit } = at(e);
      if (!c) return;
      e.stopPropagation();
      const r = box.getBoundingClientRect();
      const local = ev => clamp(this.t(ev.clientX - r.left) - c.start, 0, c.duration);
      const now = performance.now(), prev = this._lastZoomPt;
      this._lastZoomPt = hit ? { k: hit, at: now } : null;
      if (hit && (e.altKey || (prev && prev.k === hit && now - prev.at < 450))) {
        this._lastZoomPt = null; this.selPoint = null;
        app.commit(() => removeZoomKey(c, hit.t)); this.render(); return;
      }
      app.beginChange();
      let k = hit;
      if (!k) { setZoomAt(c, local(e), vOf(e.clientY - r.top)); k = c.keys['props.scale'].find(x => Math.abs(x.t - local(e)) < 1e-4); }
      this.selPoint = { zoom: c.id, k };
      draw();
      app.changed({ light: true, keepInspector: true, noTimeline: true });
      box.setPointerCapture(e.pointerId);
      const move = ev => {
        const list = c.keys['props.scale'], i = list.indexOf(k);
        const lo = i > 0 ? list[i - 1].t + 1e-3 : 0, hi = i < list.length - 1 ? list[i + 1].t - 1e-3 : c.duration;
        let t = local(ev);
        if (this.snapOn) t = this._snap(this.doc, c.start + t, this._tol(), [], [app.player.time]) - c.start;
        t = clamp(t, lo, hi);
        if (Math.abs(t - k.t) > 1e-6) moveZoomKey(c, k.t, t);
        setZoomAt(c, k.t, vOf(ev.clientY - r.top));
        draw();
        app.changed({ light: true, keepInspector: true, noTimeline: true });
      };
      const up = () => { box.removeEventListener('pointermove', move); box.removeEventListener('pointerup', up); app.endChange({ keepInspector: true }); };
      box.addEventListener('pointermove', move); box.addEventListener('pointerup', up);
    });
    box.addEventListener('contextmenu', e => {
      e.preventDefault(); e.stopPropagation();
      const { c, k } = at(e);
      if (!c) return;
      const edit = fn => { app.commit(() => fn()); this.render(); };
      popMenu(e.clientX, e.clientY, [
        k ? ['Delete key', () => edit(() => removeZoomKey(c, k.t))] : null,
        ...(k ? KEY_EASES.map(([v, t]) => [`${(k.ease || 'linear') === v ? '● ' : ''}Curve: ${t}`, () => edit(() => { for (const p of ['props.scale', 'props.x', 'props.y']) for (const q of c.keys?.[p] || []) if (Math.abs(q.t - k.t) < 1e-4) q.ease = v; })]) : []),
        k ? null : undefined,
        ['🔍 Dynamic zoom (start & end frames)…', () => { app.select([c.id]); app.cmd('dynamic-zoom'); }],
        (c.keys?.['props.scale'] || []).length ? ['Remove this clip’s zoom', () => edit(() => removeDynZoom(c))] : null,
      ]);
    });
    return box;
  }

  /** Automation lane: the curve over the whole timeline; click to add, drag to move, ⌥-click to delete. */
  _lane(tr, lane, W) {
    if (lane === 'zoom') return this._zoomLane(tr, W);
    const app = this.app, L = LANE[lane];
    const box = el('div', { class: 'tl-lane' + (tr.autoMode === 'off' ? ' off' : ''), style: { height: LANE_H + 'px' } });
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', W); svg.setAttribute('height', LANE_H);
    box.append(svg);
    const pad = 6, hh = LANE_H - pad * 2;
    const yOf = v => pad + (1 - L.toPos(v)) * hh;
    const vOf = y => L.fromPos(clamp(1 - (y - pad) / hh, 0, 1));
    const pts = tr.auto?.[lane] || [];
    const draw = () => {
      svg.replaceChildren();
      const mk = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); svg.append(n); return n; };
      mk('line', { x1: 0, x2: W, y1: yOf(L.def), y2: yOf(L.def), class: 'lane-ref' });
      const list = tr.auto?.[lane] || [];
      if (!list.length) { mk('line', { x1: 0, x2: W, y1: yOf(tr[lane] ?? L.def), y2: yOf(tr[lane] ?? L.def), class: 'lane-line flat' }); return; }
      let d = `M0 ${yOf(list[0].v)}`;
      list.forEach((p, i) => {
        const x = this.x(p.t);
        if (i > 0 && list[i - 1].ease === 'hold') d += ` L${x} ${yOf(list[i - 1].v)}`;
        d += ` L${x} ${yOf(p.v)}`;
      });
      d += ` L${W} ${yOf(list[list.length - 1].v)}`;
      mk('path', { d, class: 'lane-line' });
      list.forEach((p, i) => {
        const sel = this.selPoint && this.selPoint.tr === tr && this.selPoint.lane === lane && this.selPoint.k === p;
        const c = mk('circle', { cx: this.x(p.t), cy: yOf(p.v), r: sel ? 5.5 : 4.5, class: 'lane-pt' + (sel ? ' sel' : ''), 'data-i': i });
        const t = document.createElementNS(NS, 'title'); t.textContent = `${fmtTime(p.t)} · ${L.fmt(p.v)} ${L.unit}\nDrag to move · double-click or ⌫ to delete · right-click for more`; c.append(t);
      });
    };
    draw();
    box.addEventListener('pointerdown', e => {
      if (e.button !== 0 || tr.autoMode === 'off') return;
      e.stopPropagation();
      const r = box.getBoundingClientRect();
      const tAt = ev => Math.max(0, this.t(ev.clientX - r.left));
      app.beginChange();
      tr.auto ||= {};
      tr.auto[lane] ||= [];
      const list = tr.auto[lane];
      let i = e.target.dataset && e.target.dataset.i !== undefined ? Number(e.target.dataset.i) : -1;
      // ⌥-click or double-click a point deletes it
      // double-click on a point (the lane redraws between clicks, so it's timed here, not with dblclick)
      const now = performance.now(), prev = this._lastPt;
      this._lastPt = i >= 0 ? { k: list[i], at: now } : null;
      if (i >= 0 && prev && prev.k === list[i] && now - prev.at < 450) { this._lastPt = null; list.splice(i, 1); if (!list.length) delete tr.auto[lane]; this.selPoint = null; app.endChange(); this.render(); return; }
      if (i >= 0 && e.altKey) { list.splice(i, 1); if (!list.length) delete tr.auto[lane]; this.selPoint = null; app.endChange(); this.render(); return; }
      if (i < 0) {
        // the first point keeps the current flat value so nothing jumps
        if (!list.length && (tr[lane] ?? L.def) !== L.def) list.push({ t: 0, v: tr[lane], ease: 'linear' });
        const k = { t: tAt(e), v: vOf(e.clientY - r.top), ease: 'linear' };
        list.push(k); list.sort((a, b) => a.t - b.t); i = list.indexOf(k);
      }
      const k = list[i];
      this.selPoint = { tr, lane, k };
      draw();
      box.setPointerCapture(e.pointerId);
      const move = ev => {
        const lo = i > 0 ? list[i - 1].t + 1e-3 : 0, hi = i < list.length - 1 ? list[i + 1].t - 1e-3 : Infinity;
        let t = tAt(ev);
        if (this.snapOn) t = this._snap(this.doc, t, this._tol(), [], [app.player.time]);
        k.t = clamp(t, lo, hi); k.v = vOf(ev.clientY - r.top);
        draw();
        app.changed({ light: true, keepInspector: true, noTimeline: true });
      };
      const up = () => { box.removeEventListener('pointermove', move); box.removeEventListener('pointerup', up); app.endChange(); };
      box.addEventListener('pointermove', move); box.addEventListener('pointerup', up);
    });
    // right-click a point: delete it, change its curve, or clear the lane
    box.addEventListener('contextmenu', e => {
      e.preventDefault(); e.stopPropagation();
      const list = tr.auto?.[lane] || [];
      const i = e.target.dataset && e.target.dataset.i !== undefined ? Number(e.target.dataset.i) : -1;
      const k = list[i];
      const edit = fn => { app.commit(() => fn()); this.render(); };
      popMenu(e.clientX, e.clientY, [
        k ? ['Delete point', () => edit(() => { list.splice(list.indexOf(k), 1); if (!list.length) delete tr.auto[lane]; this.selPoint = null; }), '⌫'] : null,
        ...(k ? KEY_EASES.map(([v, t]) => [`${(k.ease || 'linear') === v ? '● ' : ''}Curve: ${t}`, () => edit(() => { k.ease = v; })]) : []),
        k ? null : undefined,
        list.length ? [`Delete all ${list.length} points`, () => edit(() => { delete tr.auto[lane]; this.selPoint = null; })] : ['No points yet: click the line to add one', null],
      ]);
    });
    void pts;
    return box;
  }

  /** ⌫ / Delete with an automation point selected removes it (instead of the selected clips). */
  deleteSelectedPoint() {
    const sp = this.selPoint;
    if (!sp) return false;
    if (sp.zoom) { // a Zoom lane key
      const c = this.doc.clips.find(x => x.id === sp.zoom);
      this.selPoint = null;
      if (!c || !(c.keys?.['props.scale'] || []).includes(sp.k)) return false;
      this.app.commit(() => removeZoomKey(c, sp.k.t)); this.render();
      return true;
    }
    const list = sp.tr.auto?.[sp.lane];
    const i = list ? list.indexOf(sp.k) : -1;
    this.selPoint = null;
    if (i < 0) return false;
    this.app.commit(() => { list.splice(i, 1); if (!list.length) delete sp.tr.auto[sp.lane]; });
    this.render();
    return true;
  }

  _clipEl(c, selected) {
    const m = c.type === 'media' ? mediaById(this.doc, c.media) : null;
    const kind = c.audioOnly ? 'audio' : c.type === 'media' ? (m ? m.kind : 'video') : c.type;
    const name = c.type === 'text' ? (c.text?.content || 'Text').split('\n')[0] : c.name || (m && m.name) || c.type;
    const tags = (c.reversed ? ' ◀◀' : '') + (c.speed && Math.round(c.speed * 100) !== 100 ? `  ${Math.round(c.speed * 100)}%` : '') + (c.audio?.mute && c.detached ? '  (sound detached)' : '');
    const e = el('div', { class: `clip ${kind}${selected ? ' selected' : ''}${c.locked ? ' locked' : ''}${c.group ? ' grouped' : ''}${c.bounced ? ' bounced-src' : ''}${c.bounceOf ? ' bounced' : ''}`, 'data-id': c.id, style: { left: this.x(c.start) + 'px', width: Math.max(4, this.x(c.duration)) + 'px' } },
      el('div', { class: 'cname', text: (c.locked ? '🔒 ' : '') + name + tags }));
    // out of sync with its picture (same recording): a red badge with how far; click it to put it back
    const off = this._unsynced?.get(c.id);
    if (off) {
      const late = -off.shift, ms = Math.round(late * 1000), txt = Math.abs(ms) < 1000 ? `${ms > 0 ? '+' : '−'}${Math.abs(ms)} ms` : `${late > 0 ? '+' : '−'}${Math.abs(late).toFixed(2)} s`; // + late, − early
      e.classList.add('unsynced');
      const sb = el('button', { class: 'sync-badge', text: `⇆ ${txt}`, title: `Out of sync: the sound is ${Math.abs(off.shift).toFixed(3)} s ${late > 0 ? 'late' : 'early'} for its picture. Click to put it back in sync (it moves to match the picture).` });
      sb.addEventListener('pointerdown', ev => ev.stopPropagation());
      sb.addEventListener('click', ev => { ev.stopPropagation(); this.app.cmd('resync', [c.id]); });
      e.append(sb);
    }
    // sound clips on a labelled track take its colour: blue dialogue, orange music, green sound FX
    const role = kind === 'audio' && this.doc.tracks.find(t => t.id === c.track)?.role;
    if (role && ROLES[role]) { e.classList.add('role-' + role); e.style.setProperty('--role', ROLES[role].color); }
    // crossfade marks: the half of the blend on each side of the cut
    if (c.xfadeIn) e.appendChild(el('div', { class: 'xfade in', title: `Crossfade ${c.xfadeIn.toFixed(2)} s`, style: { width: Math.max(3, this.x(c.xfadeIn / 2)) + 'px' } }));
    if (c.xfadeOut) e.appendChild(el('div', { class: 'xfade out', title: `Crossfade ${c.xfadeOut.toFixed(2)} s`, style: { width: Math.max(3, this.x(c.xfadeOut / 2)) + 'px' } }));
    if (m && !c.audioOnly && (m.kind === 'video' || m.kind === 'image')) {
      const strip = el('div', { class: 'strip' });
      posterFor(this.app, m).then(url => { if (url) strip.style.backgroundImage = `url(${url})`; });
      e.append(strip);
    }
    // the waveform of what the clip actually plays: the processed file once its effects are rendered (AudioSuite-style)
    const applied = c.fx && c.fx.file && !c.fx.dirty && !c.fx.bypass;
    if (m && (m.hasAudio || m.kind === 'audio')) this._waveTiles(e, c, applied ? { ...m, file: c.fx.file } : m);
    if (c.bounced) e.append(el('div', { class: 'bounce-tag src', text: 'RENDERED ↓', title: 'This sound was bounced to the track below (with its effects). It’s muted here and kept as the original. Right-click › Back to the original sound to use it again.' }));
    else if (c.bounceOf) e.append(el('div', { class: 'bounce-tag', text: 'BOUNCED', title: 'Rendered audio: the original clip’s sound with all its effects. Right-click › Back to the original sound to undo.' }));
    if (m && c.fx && c.fx.chain?.length && !c.bounced) {
      const on = c.fx.chain.filter(x => !x.bypass);
      const names = on.map(x => x.name).join(' → ');
      const st = renderingNow.has(c.id) ? 'busy' : c.fx.bypass ? 'off' : applied ? 'done' : 'todo';
      const b = el('div', { class: `fxbadge ${st}`, title: {
        busy: `Rendering ${names}…`, off: `Effects bypassed (playing the original). ${names}`,
        done: `Rendered: this clip plays the processed sound (${names})`, todo: `Effects not rendered yet (${names}). Select the clip and press RENDER EFFECTS` }[st] },
      el('span', { class: 'fxb-t', text: { busy: 'FX …', off: 'FX ○', done: 'FX ✓', todo: 'FX !' }[st] }), el('i', { class: 'fxb-bar' }));
      e.append(b);
      if (st === 'busy') this._fxBar(b, renderingNow.get(c.id));
    }
    for (const side of ['in', 'out']) { const tr = side === 'in' ? c.transIn : c.transOut; if (tr && !['none', 'fade'].includes(tr.type)) e.append(this._transBlock(c, side)); }
    for (const a of c.actions || []) {
      const zoom = a.props && ['x', 'y', 'scale'].some(k => k in a.props), wpx = Math.max(6, this.x(a.dur));
      const ae = el('div', { class: 'act' + (zoom ? ' zm' : '') + (this.app.selection.action === a.id && selected ? ' selected' : ''), title: `${zoom ? 'Zoom move' : 'Action'} at ${fmtTime(c.start + a.t)}, ${a.dur.toFixed(1)} s\nDrag the middle to move it · drag an end to make it quicker or slower`, style: { left: this.x(a.t) + 'px', width: wpx + 'px' } },
        // its ends: drag to change how long it takes (the left end moves its start, the right its end)
        ...(wpx >= 14 ? [el('i', { class: 'ah l', 'data-edge': 'l' }), el('i', { class: 'ah r', 'data-edge': 'r' })] : []),
        wpx >= 54 ? el('span', { class: 'al', text: actLabel(a) }) : null);
      ae.addEventListener('pointerdown', ev => this._actionDrag(ev, c, a));
      ae.addEventListener('contextmenu', ev => this._actionMenu(ev, c, a));
      e.append(ae);
    }
    // keyframes: one diamond per moment (all parameters keyed at that time move together)
    if (c.keys) {
      const times = [...new Set(Object.values(c.keys).flat().map(k => Math.round(k.t * 1000) / 1000))].sort((a, b) => a - b);
      for (const kt of times) {
        const params = Object.entries(c.keys).filter(([, l]) => l.some(k => Math.abs(k.t - kt) < 1e-3)).map(([p]) => p.split('.')[1]);
        const d = el('div', { class: 'kf', title: `Keyframe ${fmtTime(c.start + kt)} · ${params.join(', ')}\nClick to jump · drag to move · ⌥-click to delete`, style: { left: this.x(kt) + 'px' } });
        d.addEventListener('pointerdown', ev => this._keyDrag(ev, c, kt));
        d.addEventListener('contextmenu', ev => this._keyMenu(ev, c, kt));
        e.append(d);
      }
    }
    if (c.label) e.append(el('div', { class: `label-band lb-${c.label}` }));
    for (const mt of c.marks || []) {
      const mk = el('div', { class: 'cmark', title: `Clip marker ${fmtTime(c.start + mt)}\nClick to jump · ⌥-click to remove`, style: { left: this.x(mt) + 'px' } });
      mk.addEventListener('pointerdown', ev => {
        ev.stopPropagation();
        if (ev.altKey) this.app.commit(() => { c.marks = c.marks.filter(x => x !== mt); });
        else this.app.seek(c.start + mt);
      });
      mk.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); popMenu(ev.clientX, ev.clientY, [['Jump here', () => this.app.seek(c.start + mt)], ['Remove clip marker', () => this.app.commit(() => { c.marks = c.marks.filter(x => x !== mt); })]]); });
      e.append(mk);
    }
    if (c.elastic || c.retime) this._elasticMarks(e, c);
    const remix = this.remixable(c);
    if (remix) this._musicHandle(e, c);
    if (selected) {
      // ⚙ on the selected clip: the clip menu without hunting for a right-click (ScreenFlow's gear)
      const gear = el('button', { class: 'clip-gear', title: 'Clip menu (or right-click the clip)', text: '⚙' });
      gear.addEventListener('pointerdown', ev => ev.stopPropagation());
      gear.addEventListener('click', ev => { ev.stopPropagation(); const r = gear.getBoundingClientRect(); this._clipMenu({ clientX: r.left, clientY: r.bottom + 2, preventDefault() {}, stopPropagation() {} }, c); });
      e.append(gear);
    }
    // with REMIX on, a music clip's right end is the ♪ (re-fits the song) instead of a trim edge
    e.append(el('div', { class: 'edge l', title: 'Drag to trim · ⌘-drag to change speed · ⌥-drag where two clips touch for a rolling edit' }),
      ...(remix ? [] : [el('div', { class: 'edge r', title: 'Drag to trim · ⌘-drag to change speed · ⌥-drag where two clips touch for a rolling edit' })]));
    // fade handles at the top corners (as in Audition): drag inward to fade in / out
    const fIn = this._fadeLen(c, 'in'), fOut = this._fadeLen(c, 'out');
    if (fIn > 0) e.append(this._fadeShade(c, 'in', fIn));
    if (fOut > 0) e.append(this._fadeShade(c, 'out', fOut));
    if (!c.locked && c.type !== 'caption') {
      for (const side of ['in', 'out']) {
        const len = side === 'in' ? fIn : fOut;
        const fh = el('div', { class: `fade-h ${side}`, title: `Fade ${side} (${len.toFixed(2)} s): drag sideways for its length, up or down to curve it (sound); double-click for a straight fade`, style: side === 'in' ? { left: Math.max(0, this.x(len) - 5) + 'px' } : { right: Math.max(0, this.x(len) - 5) + 'px' } });
        fh.addEventListener('pointerdown', ev => this._fadeDrag(ev, c, side));
        e.append(fh);
      }
    }
    // the clip's volume as a yellow line over its sound, like Audition: drag it up or down, click to add a point
    if (c.type === 'media' && m && (c.audioOnly || m.kind === 'audio') && !c.locked) e.append(this._volLine(c));
    // bottom-left badges like a DAW's clip: the clip's gain (drag up / down, double-click resets) and its
    // speed (click for choices). Bottom-right: the stretch handle (drag to speed up or slow down).
    if (c.type === 'media' && m && m.kind !== 'image') {
      const vol = c.audio?.volume ?? 1, db = vol <= 0.0001 ? -Infinity : 20 * Math.log10(vol);
      const badges = el('div', { class: 'cbadges' });
      if (m.hasAudio || m.kind === 'audio') {
        const gb = el('button', { class: 'cbadge gain', title: 'Clip gain: drag up or down (⇧ fine), double-click for 0 dB', innerHTML: `<i class="ico-gain"></i><span>${db === -Infinity ? '−∞' : (db > 0 ? '+' : db < -0.05 ? '−' : '') + Math.abs(db).toFixed(1)} dB</span>` });
        gb.addEventListener('pointerdown', ev => this._gainDrag(ev, c, gb));
        gb.addEventListener('dblclick', ev => { ev.stopPropagation(); this.app.commit(() => { c.audio = { ...(c.audio || {}), volume: 1 }; }); });
        badges.append(gb);
      }
      const sp = c.speed || 1;
      const sb = el('button', { class: 'cbadge speed' + (sp !== 1 ? ' changed' : ''), title: 'Clip speed (stretch): click for choices; or drag the ◢ handle at the clip’s end', innerHTML: `<i class="ico-speed"></i><span>${Math.round(sp * 100)}%</span>` });
      sb.addEventListener('pointerdown', ev => ev.stopPropagation());
      sb.addEventListener('click', ev => { ev.stopPropagation(); this.app.select([c.id], null); openSpeedPanel(this.app, c.id, ev.clientX, ev.clientY); });
      badges.append(sb);
      e.append(badges);
      if (!c.locked) {
        const st = el('div', { class: 'stretch-h', title: 'Stretch: drag to change the clip’s speed (its length follows). Fades are the white squares at the top corners.' });
        st.addEventListener('pointerdown', ev => this._retimeDrag(ev, c, 'end'));
        e.append(st);
      }
    }
    if (c.disabled) e.classList.add('disabled');
    e.addEventListener('pointerdown', ev => this._clipPointer(ev, c));
    e.addEventListener('contextmenu', ev => this._clipMenu(ev, c));
    e.addEventListener('dblclick', () => (this.app.editClip ? this.app.editClip(c) : this.app.focusInspector()));
    return e;
  }

  /**
   * Elastic Wave markers (DaVinci Fairlight style): each holds a moment of the sound. Drag one and the sound on each
   * side stretches or squeezes to meet it, its pitch kept; the clip's ends stay where they are. Double-click a
   * marker to remove it. The speed of each part shows between markers when it isn't 100%.
   */
  /**
   * ♪ on the end of a music clip: drag it to where the music should end and let go. The song is re-fitted to that
   * length (sections repeated or skipped where it repeats on the beat, its real ending kept), not just cut off.
   * Snaps to the end of the video, markers and other clips' edges.
   */
  _musicHandle(e, c) {
    const h = el('div', { class: 'mf-handle mf-edge', title: 'REMIX: drag to make the music longer or shorter; it re-fits seamlessly, keeping its real ending. (Turn 🎵 REMIX off, next to SNAP, to trim normally.)' }, el('span', { text: '♪' }));
    h.addEventListener('pointerdown', ev => {
      if (ev.button !== 0) return;
      ev.stopPropagation(); ev.preventDefault();
      const app = this.app, f = fitSource(this.doc, c), w0 = e.getBoundingClientRect().width, x0 = ev.clientX;
      const end0 = clipEnd(c);
      let end = end0;
      const tip = el('span', { class: 'mf-len' }); h.append(tip);
      e.classList.add('mf-dragging');
      document.body.style.cursor = 'ew-resize';
      const move = mv => {
        let t = end0 + this.t(mv.clientX - x0);
        t = this._snap(this.doc, t, this.t(8), f.members.map(x => x.id));
        end = Math.max(f.first.start + 3, t);
        e.style.width = Math.max(12, w0 + this.x(end - end0)) + 'px';
        tip.textContent = `${fmtTime(end - f.first.start).replace(/\.\d$/, '')}`;
      };
      const up = async () => {
        removeEventListener('pointermove', move); removeEventListener('pointerup', up);
        document.body.style.cursor = ''; e.classList.remove('mf-dragging'); tip.remove();
        if (Math.abs(end - end0) < 0.2) { e.style.width = w0 + 'px'; return; }
        e.classList.add('mf-working');
        try {
          const plan = await refitTo(app, c, end - f.first.start);
          const n = plan.segments.length - 1;
          toast(`Music re-fitted to ${fmtTime(plan.length / plan.speed).replace(/\.\d$/, '')}${n ? ` (${n} seamless join${n === 1 ? '' : 's'})` : ''}. ⌘Z undoes it.`, 4000);
        } catch (err) { toast(`Couldn’t fit the music: ${err.message}`, 5000); this.render(); }
      };
      addEventListener('pointermove', move); addEventListener('pointerup', up);
    });
    e.append(h);
  }

  /** Elastic Wave by dragging the waveform itself: grabs the moment under the pointer (or the marker right there). */
  _elasticGrab(e, c, host) {
    const app = this.app, left = host.getBoundingClientRect().left, x0 = e.clientX, t0 = this.t(x0 - left);
    let i = -1;
    document.body.style.cursor = 'ew-resize';
    const move = ev => {
      if (i < 0) {
        if (Math.abs(ev.clientX - x0) < 3) return;
        app.beginChange();
        c.retime ||= linearRetime(c.duration, c.duration * (c.speed || 1));
        i = c.retime.findIndex((p, k) => k > 0 && k < c.retime.length - 1 && Math.abs(this.x(p.t) - (x0 - left)) < 6);
        if (i < 0) { c.retime = addPoint(c.retime, t0); i = c.retime.findIndex(p => Math.abs(p.t - t0) < 1e-6); }
        if (i <= 0 || i >= c.retime.length - 1) { i = -2; return; } // too near an end: nothing to stretch
      }
      if (i === -2) return;
      c.retime = movePoint(c.retime, i, t0 + this.t(ev.clientX - x0));
      app.changed({ light: true, keepInspector: true });
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      if (i !== -1) app.endChange();
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  }

  _elasticMarks(e, c) {
    e.classList.add('elastic');
    const pts = c.retime || [];
    for (let i = 1; i < pts.length; i++) { // the speed of each part
      const a = pts[i - 1], b = pts[i], sp = (b.s - a.s) / (b.t - a.t);
      if (Math.abs(sp - 1) > 0.005 && this.x(b.t - a.t) > 34) e.append(el('span', { class: 'ew-speed' + (sp > 1 ? ' fast' : ' slow'), text: `${Math.round(sp * 100)}%`, style: { left: this.x(a.t) + 'px', width: this.x(b.t - a.t) + 'px' } }));
    }
    if (!c.elastic) return;
    pts.forEach((p, i) => {
      if (i === 0 || i === pts.length - 1) return;
      const mk = el('div', { class: 'ew-mark', title: 'Drag to stretch the sound on each side (pitch kept) · double-click to remove · or drag anywhere on the waveform', style: { left: this.x(p.t) + 'px' } });
      mk.addEventListener('pointerdown', ev => {
        if (ev.button !== 0) return;
        ev.stopPropagation(); ev.preventDefault();
        mk.setPointerCapture(ev.pointerId);
        const x0 = ev.clientX, t0 = p.t, app = this.app;
        let began = false;
        const move = mv => {
          if (!began) { if (Math.abs(mv.clientX - x0) < 2) return; began = true; app.beginChange(); }
          c.retime = movePoint(c.retime, i, t0 + this.t(mv.clientX - x0));
          mk.style.left = this.x(c.retime[i].t) + 'px';
          app.changed({ light: true, keepInspector: true, noTimeline: true });
        };
        const up = () => { mk.removeEventListener('pointermove', move); mk.removeEventListener('pointerup', up); if (began) app.endChange(); };
        mk.addEventListener('pointermove', move); mk.addEventListener('pointerup', up);
      });
      mk.addEventListener('dblclick', ev => { ev.stopPropagation(); this.app.commit(() => { c.retime = removePoint(c.retime, i); }); });
      e.append(mk);
    });
  }

  /**
   * A clip's waveform, in tiles of at most 2048 pixels, each drawn only when it scrolls into view. (One canvas for
   * a long clip had to be capped in size and then showed the sound squeezed into its first part, so speech
   * appeared where there was silence.) Each tile maps its own pixels to the source time, so it lines up at any zoom.
   */
  _waveTiles(e, c, m) {
    const TILE = 2048, w = Math.max(1, Math.round(this.x(c.duration)));
    const host = el('div', { class: 'wave-host' });
    e.append(host);
    this._waveIO ||= new IntersectionObserver(entries => {
      for (const en of entries) if (en.isIntersecting && en.target._draw) { const f = en.target._draw; en.target._draw = null; this._waveIO.unobserve(en.target); f(); }
    }, { root: this.scroll, rootMargin: '0px 1500px' });
    peaksFor(this.app, m).then(peaks => {
      if (!peaks || !host.isConnected) return;
      const n = Math.min(3000, Math.ceil(w / TILE)), tw = Math.ceil(w / n);
      const snap = { in: c.in || 0, dur: c.duration, speed: c.speed || 1, retime: c.retime || null };
      for (let i = 0; i < n; i++) {
        const x0 = i * tw, width = Math.min(tw, w - x0);
        if (width <= 0) break;
        const tile = el('div', { class: 'wave-tile', style: { left: x0 + 'px', width: width + 'px' } });
        tile._draw = () => this._drawWaveTile(tile, snap, peaks, x0, width, w);
        host.append(tile);
        this._waveIO.observe(tile);
      }
    });
  }
  _fxBar(b, f) {
    const v = Math.round((f || 0) * 100);
    b.querySelector('.fxb-t').textContent = `RENDERING ${v}%`;
    b.querySelector('.fxb-bar').style.width = v + '%';
  }
  /** Live progress of a clip's effect render (called by fx.js); null = finished. */
  renderProgress(id, f) {
    const e = this.el?.querySelector?.(`.clip[data-id="${CSS.escape(id)}"]`) || document.querySelector(`.clip[data-id="${CSS.escape(id)}"]`);
    if (f == null) { this.render(); return; }
    let b = e && e.querySelector('.fxbadge');
    if (e && !b) { b = el('div', { class: 'fxbadge busy' }, el('span', { class: 'fxb-t' }), el('i', { class: 'fxb-bar' })); e.append(b); }
    if (b) { b.className = 'fxbadge busy'; this._fxBar(b, f); }
  }
  _drawWaveTile(tile, c, peaks, x0, width, w) {
    const h = 40, cv = el('canvas', { class: 'wave' });
    cv.width = width; cv.height = h;
    tile.append(cv);
    const g = cv.getContext('2d');
    g.fillStyle = 'rgba(190,255,215,0.55)';
    const rate = peaks.rate, span = c.dur * c.speed;
    for (let x = 0; x < width; x++) {
      // with a time map (Elastic Wave, retime curve) the waveform follows it: stretched parts look stretched
      const at = px => c.in + (c.retime ? mapAt(c.retime, (px / w) * c.dur) : (px / w) * span);
      const t0 = at(x0 + x), t1 = at(x0 + x + 1);
      let v = 0;
      for (let i = Math.floor(t0 * rate); i <= Math.floor(t1 * rate) && i < peaks.data.length; i++) v = Math.max(v, peaks.data[i] || 0);
      const vh = Math.max(1, v * (h - 4));
      g.fillRect(x, (h - vh) / 2, 1, vh);
    }
  }

  drawRuler() {
    if (!this.doc) return;
    const cv = this.ruler, dpr = devicePixelRatio || 1;
    const W = this.scroll.clientWidth;
    cv.style.width = W + 'px';
    cv.width = Math.round(W * dpr); cv.height = Math.round(28 * dpr);
    cv.parentElement.style.width = this.contentWidth() + 'px';
    cv.style.transform = `translateX(${this.scroll.scrollLeft}px)`;
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, W, 28);
    const off = this.scroll.scrollLeft;
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400];
    const major = steps.find(s => s * this.pps >= 80) || 14400;
    const minor = major / (major >= 60 ? 6 : major >= 10 ? 5 : major >= 1 ? 4 : 5);
    const cs = getComputedStyle(document.documentElement);
    g.strokeStyle = cs.getPropertyValue('--ruler-tick').trim() || 'rgba(255,255,255,0.25)'; g.fillStyle = cs.getPropertyValue('--ruler-ink').trim() || 'rgba(233,229,218,0.7)'; g.font = '10px Menlo, monospace';
    const t0 = this.t(off), t1 = this.t(off + W);
    for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
      const x = Math.round(this.x(t) - off) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      g.beginPath(); g.moveTo(x, isMajor ? 12 : 20); g.lineTo(x, 28); g.stroke();
      if (isMajor) g.fillText(major < 1 ? fmtTime(t) : fmtTime(t).replace(/\.\d$/, ''), x + 3, 10);
    }
    const rg = this.doc.range;
    if (rg && (rg.in != null || rg.out != null)) {
      const a = this.x(rg.in || 0) - off, b = rg.out != null ? this.x(rg.out) - off : W;
      g.fillStyle = 'rgba(127,208,255,0.18)'; g.fillRect(a, 0, b - a, 28);
      g.fillStyle = '#7fd0ff';
      if (rg.in != null) { g.fillRect(a, 0, 2, 28); g.fillText('IN', a + 4, 24); }
      if (rg.out != null) { g.fillRect(b - 2, 0, 2, 28); g.fillText('OUT', b - 24, 24); }
    }
    // Auto Edit sections: numbered amber bands
    (this.doc.sections || []).forEach((s, i) => {
      const a = this.x(s.t0) - off, b = this.x(s.t1) - off;
      if (b < 0 || a > W) return;
      g.fillStyle = 'rgba(95,211,90,0.25)'; g.fillRect(a, 0, b - a, 28);
      g.fillStyle = '#4cc447'; g.fillRect(a, 25, b - a, 3); g.fillRect(a, 0, 2, 28); g.fillRect(b - 2, 0, 2, 28);
      g.font = 'bold 10px Menlo, monospace'; g.fillText(`PART ${i + 1}`, Math.max(a, 0) + 5, 22); g.font = '10px Menlo, monospace';
    });
    for (const m of this.doc.markers || []) {
      const x = this.x(m.t) - off;
      g.fillStyle = '#ffd60a'; g.beginPath(); g.moveTo(x - 5, 0); g.lineTo(x + 5, 0); g.lineTo(x, 7); g.fill();
    }
  }

  /**
   * The clip's volume envelope, drawn on the clip like Audition's yellow line (its 'audio.volume' keyframes, or one
   * level for the whole clip). Drag the line up or down to change the level (all its points together); click it to
   * add a point; drag a point anywhere; ⌥-click or double-click a point to delete it; right-click for its curve.
   * While dragging only the line redraws, so it follows the mouse smoothly.
   */
  _volLine(c) {
    const app = this.app, L = LANE.volume, NS = 'http://www.w3.org/2000/svg';
    const W = Math.max(4, this.x(c.duration)), pad = 8; // pad: % of the height kept clear at the top and bottom
    const wrap = el('div', { class: 'vol-env' });
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} 100`); svg.setAttribute('preserveAspectRatio', 'none');
    const line = document.createElementNS(NS, 'path'), hit = document.createElementNS(NS, 'path');
    line.setAttribute('class', 'vol-line'); hit.setAttribute('class', 'vol-hit');
    svg.append(line, hit);
    wrap.append(svg);
    const yOf = v => pad + (1 - L.toPos(v)) * (100 - pad * 2);          // in % of the clip's height
    const keys = () => c.keys?.['audio.volume'] || null;
    const base = () => c.audio?.volume ?? 1;
    const tip = el('div', { class: 'fade-tip' });
    const dots = [];
    const draw = () => {
      const k = keys();
      let d = '';
      if (!k?.length) d = `M0 ${yOf(base())} L${W} ${yOf(base())}`;
      else { const n = Math.max(8, Math.round(W / 3)); for (let i = 0; i <= n; i++) { const t = c.duration * i / n; d += `${i ? 'L' : 'M'}${this.x(t).toFixed(1)} ${yOf(keyAt(k, t, base())).toFixed(2)}`; } }
      line.setAttribute('d', d); hit.setAttribute('d', d);
      for (const x of dots) x.remove();
      dots.length = 0;
      for (const p of k || []) {
        const dot = el('i', { class: 'vol-pt', style: { left: this.x(p.t) + 'px', top: yOf(p.v) + '%' }, title: `${fmtTime(c.start + p.t)} · ${L.fmt(p.v)}\nDrag to move · ⌥-click or double-click to delete · right-click for the curve` });
        dot._k = p;
        dots.push(dot); wrap.append(dot);
      }
    };
    draw();
    const hRect = () => wrap.getBoundingClientRect();
    const tAt = x => clamp(this.t(x - hRect().left), 0, c.duration);
    const showTip = (ev, text) => { if (!tip.isConnected) document.body.append(tip); tip.textContent = text; Object.assign(tip.style, { left: ev.clientX + 14 + 'px', top: ev.clientY - 30 + 'px' }); };
    wrap.addEventListener('pointerdown', ev => {
      if (ev.button !== 0) return;
      const onDot = ev.target.classList.contains('vol-pt'), onLine = ev.target === hit;
      if (!onDot && !onLine) return;
      ev.stopPropagation(); ev.preventDefault();
      let k = onDot ? ev.target._k : null;
      const now = performance.now(), prev = this._lastVolPt;
      this._lastVolPt = k ? { k, at: now } : null;
      if (k && (ev.altKey || (prev && prev.k === k && now - prev.at < 450))) {
        this._lastVolPt = null;
        app.commit(() => { const l = keys(); l.splice(l.indexOf(k), 1); if (!l.length) { c.audio = { ...(c.audio || {}), volume: k.v }; delete c.keys['audio.volume']; if (!Object.keys(c.keys).length) delete c.keys; } }, { keepInspector: true });
        return;
      }
      const x0 = ev.clientX, y0 = ev.clientY;
      const before = k ? k.v : (keys() ? keys().map(p => p.v) : base());
      // up and down in dB, like Audition: a quarter of a dB a pixel (⇧ for fine, a twentieth), from -60 dB to +6 dB
      const db = v => (v <= 1e-4 ? -60 : 20 * Math.log10(v)), gain = d => (d <= -59.9 ? 0 : 10 ** (Math.min(6.02, d) / 20));
      const dbStep = e2 => -(e2.clientY - y0) * (e2.shiftKey ? 0.05 : 0.25);
      let moved = false;
      const move = e2 => {
        if (!moved && Math.abs(e2.clientX - x0) + Math.abs(e2.clientY - y0) < 3) return;
        if (!moved) { moved = true; app.beginChange(); }
        if (k) {
          // a point: anywhere between its neighbours
          const l = keys(), i = l.indexOf(k);
          k.t = clamp(tAt(e2.clientX), i > 0 ? l[i - 1].t + 0.01 : 0, i < l.length - 1 ? l[i + 1].t - 0.01 : c.duration);
          k.v = Math.round(clamp(gain(db(before) + dbStep(e2)), 0, 2) * 1000) / 1000;
          showTip(e2, `${fmtTime(c.start + k.t)} · ${L.fmt(k.v)}`);
        } else {
          // the line: the whole envelope up or down by the same number of dB
          const delta = dbStep(e2);
          if (Array.isArray(before)) keys().forEach((p, i) => { p.v = Math.round(clamp(gain(db(before[i]) + delta), 0, 2) * 1000) / 1000; });
          else c.audio = { ...(c.audio || {}), volume: Math.round(clamp(gain(db(before) + delta), 0, 2) * 1000) / 1000 };
          showTip(e2, `Clip volume ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} dB${Array.isArray(before) ? ' (all points)' : ` · ${L.fmt(base())}`}`);
        }
        draw();
        app.changed({ light: true, keepInspector: true, noTimeline: true });
      };
      const up = e2 => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); tip.remove();
        if (moved) { app.endChange({ keepInspector: true }); return; }
        if (!k) { // a click on the line: a point there, at the level the line has
          const t = tAt(e2.clientX), v = keys() ? keyAt(keys(), t, base()) : base();
          app.commit(() => { if (!keys()) putKey(c, 'audio.volume', 0, base()); putKey(c, 'audio.volume', t, Math.round(v * 1000) / 1000); }, { keepInspector: true });
        }
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
    wrap.addEventListener('contextmenu', ev => {
      const k = ev.target.classList.contains('vol-pt') ? ev.target._k : null;
      if (!k && ev.target !== hit) return;
      ev.preventDefault(); ev.stopPropagation();
      const edit = fn => app.commit(fn, { keepInspector: true });
      popMenu(ev.clientX, ev.clientY, [
        k ? ['Delete point', () => edit(() => { const l = keys(); l.splice(l.indexOf(k), 1); if (!l.length) { delete c.keys['audio.volume']; if (!Object.keys(c.keys).length) delete c.keys; } })] : null,
        ...(k ? KEY_EASES.map(([v, t]) => [`${(k.ease || 'linear') === v ? '● ' : ''}Curve: ${t}`, () => edit(() => { k.ease = v; })]) : []),
        keys() ? null : undefined,
        keys() ? [`Remove all ${keys().length} points (keep one level)`, () => edit(() => { c.audio = { ...(c.audio || {}), volume: keyAt(keys(), 0, base()) }; delete c.keys['audio.volume']; if (!Object.keys(c.keys).length) delete c.keys; })] : null,
        ['Reset to 0 dB', () => edit(() => { c.audio = { ...(c.audio || {}), volume: 1 }; if (c.keys) { delete c.keys['audio.volume']; if (!Object.keys(c.keys).length) delete c.keys; } })],
      ]);
    });
    return wrap;
  }

  /** A clip's fade length: its sound fade, or its picture fade transition. */
  _fadeLen(c, side) {
    const a = c.audio ? (side === 'in' ? c.audio.fadeIn : c.audio.fadeOut) || 0 : 0;
    const tr = side === 'in' ? c.transIn : c.transOut;
    const v = tr && tr.type === 'fade' ? tr.dur : 0;
    return Math.max(a, v);
  }
  _fadeShade(c, side, len) {
    const w = Math.max(2, this.x(len));
    const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', `fade-shade ${side}`); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('viewBox', '0 0 100 100');
    svg.style.width = w + 'px';
    // the fade's real shape (its curve), shaded above the line
    const k = (side === 'in' ? c.audio?.fadeInCurve : c.audio?.fadeOutCurve) || 0, pts = [];
    for (let i = 0; i <= 24; i++) {
      const x = i / 24 * 100, through = side === 'in' ? i / 24 : 1 - i / 24;
      pts.push(`${x.toFixed(1)} ${(100 - fadeShape(through, k) * 100).toFixed(1)}`);
    }
    svg.innerHTML = `<path d="M0 0 L100 0 L${pts.reverse().join(' L')} Z"/><polyline points="${pts.reverse().join(' ')}"/>`;
    return svg;
  }
  _fadeDrag(e, c, side) {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    // double-click the handle: a straight fade again
    if (e.detail === 2) {
      if (c.audio && (c.audio[side === 'in' ? 'fadeInCurve' : 'fadeOutCurve'])) this.app.commit(() => { c.audio[side === 'in' ? 'fadeInCurve' : 'fadeOutCurve'] = 0; }, { keepInspector: true });
      return;
    }
    const app = this.app, m = c.type === 'media' ? mediaById(this.doc, c.media) : null;
    const audioish = c.type === 'media' && (c.audioOnly || m?.kind === 'audio' || m?.hasAudio);
    const visual = !(c.audioOnly || m?.kind === 'audio');
    const x0 = e.clientX, y0 = e.clientY, len0 = this._fadeLen(c, side);
    const ck = side === 'in' ? 'fadeInCurve' : 'fadeOutCurve', k0 = (audioish && c.audio?.[ck]) || 0;
    const tip = el('div', { class: 'fade-tip' }); let moved = false;
    const handle = e.target.closest('.fade-h'), clipEl = handle?.closest('.clip');
    const move = ev => {
      const dx = (ev.clientX - x0) * (side === 'in' ? 1 : -1), dy = ev.clientY - y0;
      if (!moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      if (!moved) { moved = true; app.beginChange(); document.body.append(tip); }
      // sideways: how long the fade is; up or down (sound clips): its curve, like Audition's fade handles
      const len = clamp(len0 + this.t(dx), 0, c.duration / 2);
      const v = len < 0.03 ? 0 : Math.round(len * 100) / 100;
      if (audioish && c.audio) c.audio[ck] = Math.round(clamp(k0 - dy / 70, -1, 1) * 100) / 100;
      const k = audioish ? c.audio?.[ck] || 0 : 0;
      tip.textContent = `Fade ${side} ${v.toFixed(2)} s${audioish ? ` · ${Math.abs(k) < 0.02 ? 'straight' : k > 0 ? `fast start ${Math.round(k * 100)}%` : `slow start ${Math.round(-k * 100)}%`}` : ''}`;
      Object.assign(tip.style, { left: ev.clientX + 14 + 'px', top: ev.clientY - 30 + 'px' });
      if (audioish) c.audio[side === 'in' ? 'fadeIn' : 'fadeOut'] = v;
      if (visual) c[side === 'in' ? 'transIn' : 'transOut'] = v ? { ...(c[side === 'in' ? 'transIn' : 'transOut'] || {}), type: 'fade', dur: v } : { type: 'none', dur: 0.5 };
      // only this clip's fade redraws while dragging (the whole timeline once at the end), so it follows smoothly
      if (clipEl) {
        clipEl.querySelector(`.fade-shade.${side}`)?.remove();
        if (v > 0) clipEl.insertBefore(this._fadeShade(c, side, v), handle);
        if (handle) handle.style[side === 'in' ? 'left' : 'right'] = Math.max(0, this.x(v) - 5) + 'px';
      }
      app.changed({ light: true, keepInspector: true, noTimeline: !!clipEl });
    };
    const up = () => { tip.remove(); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); if (moved) app.endChange({ keepInspector: true }); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  /**
   * A transition on the timeline, ScreenFlow style: a labelled block at the clip's start (in) or end (out). Drag its
   * inner edge (or the block) sideways to make it longer or shorter; double-click or right-click to change or remove it.
   */
  _transBlock(c, side) {
    const key = side === 'in' ? 'transIn' : 'transOut', tr = c[key];
    const name = transName(tr.type);
    const b = el('div', { class: `tr ${side === 'out' ? 'out' : ''} tr-live`, title: `${name} ${side === 'in' ? 'in' : 'out'} (${tr.dur.toFixed(2)} s): drag the edge to make it longer or shorter · double-click to change it`,
      style: side === 'in' ? { left: 0, width: this.x(tr.dur) + 'px' } : { right: 0, width: this.x(tr.dur) + 'px' } },
      el('span', { class: 'tr-name', text: name }), el('i', { class: 'tr-h' }));
    b.addEventListener('pointerdown', ev => { if (ev.button === 0) this._transDrag(ev, c, side, b); });
    b.addEventListener('dblclick', ev => { ev.stopPropagation(); this._transMenu(ev, c, side); });
    b.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); this._transMenu(ev, c, side); });
    return b;
  }
  /** Longest a transition can be on this side (it can't run into the other side's). */
  _transMax(c, side) {
    const other = side === 'in' ? c.transOut : c.transIn, used = other && other.type !== 'none' && other.type !== 'fade' ? other.dur : 0;
    return Math.max(0.1, Math.min(5, c.duration - used - 0.05));
  }
  _transDrag(e, c, side, b) {
    e.stopPropagation(); e.preventDefault();
    const app = this.app, key = side === 'in' ? 'transIn' : 'transOut';
    if (OVERLAP_CUTS.has(c[key].type)) { toast('This one plays across the cut: set its length in ⧓ TRANSITIONS.'); return; }
    const x0 = e.clientX, len0 = c[key].dur, max = this._transMax(c, side);
    const tip = el('div', { class: 'fade-tip' }); let moved = false;
    const move = ev => {
      const dx = (ev.clientX - x0) * (side === 'in' ? 1 : -1);
      if (!moved && Math.abs(dx) < 2) return;
      if (!moved) { moved = true; app.beginChange(); document.body.append(tip); }
      const v = Math.round(clamp(len0 + this.t(dx), 0.1, max) * 100) / 100;
      c[key] = { ...c[key], dur: v };
      b.style.width = this.x(v) + 'px';
      tip.textContent = `${transName(c[key].type)} ${side} ${v.toFixed(2)} s`;
      Object.assign(tip.style, { left: ev.clientX + 14 + 'px', top: ev.clientY - 30 + 'px' });
      app.changed({ light: true, keepInspector: true, noTimeline: true });
    };
    const up = () => {
      tip.remove(); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (moved) app.endChange({ keepInspector: true });
      else { app.select([c.id], null); app.seek(side === 'in' ? c.start : Math.max(c.start, clipEnd(c) - c[key].dur)); }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  _transMenu(e, c, side) {
    const key = side === 'in' ? 'transIn' : 'transOut', app = this.app;
    const set = type => app.commit(() => { c[key] = type === 'none' ? { type: 'none', dur: 0.5 } : { ...c[key], type }; });
    popMenu(e.clientX, e.clientY, [
      ...TRANSITIONS.filter(([k]) => k !== 'none' && !OVERLAP_CUTS.has(k)).map(([k, l]) => [`${c[key].type === k ? '✓ ' : '   '}${l}`, () => set(k)]),
      null,
      ['⧓ All transitions, with previews…', () => openTransitions(app)],
      [`Remove this transition`, () => set('none')],
    ]);
  }
  /** A transition dragged from ⧓ TRANSITIONS onto a clip: the half it lands on picks its start or its end. */
  dropTransition(type, clipId, clientX, at = null) {
    const app = this.app, c = this.doc.clips.find(x => x.id === clipId), m = c?.type === 'media' ? mediaById(this.doc, c.media) : null;
    if (!c || c.audioOnly || m?.kind === 'audio') { toast('Drop a transition on a picture clip (video, image, text…).'); return; }
    const side = (at ?? this._timeAt(clientX)) < c.start + c.duration / 2 ? 'in' : 'out', key = side === 'in' ? 'transIn' : 'transOut';
    const nb = this.doc.clips.find(o => o !== c && o.track === c.track && Math.abs(side === 'in' ? clipEnd(o) - c.start : o.start - clipEnd(c)) < 0.05);
    const want = Number(pref('transDur')) || 0.5;
    app.commit(() => {
      if (OVERLAP_CUTS.has(type)) { if (nb) applyCut(side === 'in' ? nb : c, side === 'in' ? c : nb, type, 0.8); return; }
      c[key] = { type, dur: Math.round(Math.min(want, this._transMax(c, side)) * 100) / 100 };
    });
    app.select([c.id], null);
    toast(`${transName(type)} on the ${side === 'in' ? 'start' : 'end'} of the clip: drag its edge on the timeline to make it longer or shorter.`, 4500);
  }

  /**
   * snap() that shows it: while an edge is caught (by another clip's edge, a marker, the playhead…) a bright line runs
   * down the timeline where they meet, so you can see things line up. The line goes when you let go.
   */
  _snap(doc, t, tol, ids = [], extra = []) {
    const at = snap(doc, t, tol, ids, extra);
    const host = this.playheadEl.parentElement;
    if (host) {
      let g = this._snapGuide;
      if (!g || !g.isConnected) {
        g = this._snapGuide = el('div', { class: 'snap-guide' }); host.append(g);
        if (!this._snapGuideOff) { this._snapGuideOff = () => this._snapGuide?.classList.remove('on'); window.addEventListener('pointerup', this._snapGuideOff, true); }
      }
      const caught = Math.abs(at - t) > 1e-9 || doc.clips.some(c => !ids.includes(c.id) && (Math.abs(c.start - at) < 1e-6 || Math.abs(clipEnd(c) - at) < 1e-6));
      g.classList.toggle('on', caught);
      if (caught) { g.style.left = this.x(at) + 'px'; g.style.height = (28 + this.totalH()) + 'px'; }
    }
    return at;
  }

  /** A strip of white splicing tape at a fresh cut, for a moment. */
  spliceMark(t) {
    const host = this.playheadEl.parentElement;
    if (!host) return;
    const m = el('div', { class: 'splice-mark', style: { left: this.x(t) + 'px', height: (28 + this.totalH()) + 'px' } });
    host.append(m);
    setTimeout(() => m.remove(), 1400);
  }

  updatePlayhead(t) {
    this.playheadEl.style.left = this.x(t) + 'px';
    this.playheadEl.style.height = (28 + this.totalH()) + 'px';
    // follow the playhead while playing (not while you're dragging it)
    if (this.app.player.playing && !this.app.player.scrubbing) {
      const x = this.x(t), sl = this.scroll.scrollLeft, w = this.scroll.clientWidth;
      if (x > sl + w - 40 || x < sl) this.scroll.scrollLeft = x - 60;
    }
  }

  // ---------------------------------------------------------------- interactions
  _timeAt(clientX) { const r = this.scroll.getBoundingClientRect(); return this.t(clientX - r.left + this.scroll.scrollLeft); }
  /** Track index under a screen y (a track's automation lane counts as that track). */
  _rowAt(clientY) {
    const y = clientY - this.tracksEl.getBoundingClientRect().top;
    const l = this.layout();
    if (y < 0) return 0;
    if (y < this.capH()) return 0;
    for (let i = 0; i < l.length; i++) if (y < l[i].end) return i;
    return l.length - 1;
  }
  _tol() { return 18 / this.pps; } // snap distance: 18 pixels at any zoom

  /** Drag the playhead (ruler or its red head). While playing, playback continues from where you let go. */
  _scrub(e) {
    const p = this.app.player;
    e.preventDefault();
    p.beginScrub();
    const go = ev => p.scrubTo(Math.max(0, this._timeAt(ev.clientX)), this.scrubAudio);
    go(e);
    // keep the playhead in view when dragging past the edges
    let edgeTimer = null;
    const edge = ev => {
      clearInterval(edgeTimer);
      const r = this.scroll.getBoundingClientRect();
      const dir = ev.clientX < r.left + 20 ? -1 : ev.clientX > r.right - 20 ? 1 : 0;
      if (dir) edgeTimer = setInterval(() => { this.scroll.scrollLeft += dir * 24; go(ev); }, 30);
    };
    const move = ev => { go(ev); edge(ev); };
    const up = () => { clearInterval(edgeTimer); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); p.endScrub(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  /** Right-click a marker: rename it, delete it, or delete them all. */
  _markerMenu(m, x, y) {
    const app = this.app, same = a => Math.abs(a.t - m.t) < 1e-6 && a.label === m.label;
    const n = (this.doc.markers || []).length;
    popMenu(x, y, [
      ['Jump here', () => app.seek(m.t)],
      ['Rename marker…', async () => { const { promptText } = await import('./ui.js'); const v = await promptText('Rename marker', 'Name', m.label || ''); if (v != null) app.commit(d => { const k = d.markers.find(same); if (k) k.label = String(v).slice(0, 80); }); }],
      null,
      [`Delete this marker${m.label ? ` (“${m.label}”)` : ''}`, () => { app.commit(d => { d.markers = d.markers.filter(k => !same(k)); }); toast('Marker deleted (⌘Z brings it back).', 2500); }],
      n > 1 ? [`Delete all ${n} markers…`, () => app.deleteMarkers('all')] : null,
    ]);
  }
  _rulerEvents() {
    $('#tl-ruler').addEventListener('pointerdown', e => this._scrub(e));
    $('#tl-ruler').addEventListener('contextmenu', e => {
      e.preventDefault();
      const t = this._timeAt(e.clientX), secs = this.doc?.sections || [], i = secs.findIndex(s => t >= s.t0 && t <= s.t1);
      // a marker within a few pixels: its own menu
      const near = (this.doc?.markers || []).filter(m => Math.abs(this.x(m.t) - this.x(t)) < 8).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
      if (near) { this._markerMenu(near, e.clientX, e.clientY); return; }
      const nm = (this.doc?.markers || []).length;
      popMenu(e.clientX, e.clientY, [
        nm ? [`Delete all ${nm} markers…`, () => this.app.deleteMarkers('all')] : null,
        i >= 0 ? [`Remove section ${i + 1}`, () => this.app.cmd('remove-section:' + secs[i].id)] : null,
        ['Add In–Out as a section  (X)', () => this.app.cmd('add-section')],
        secs.length ? [`Clear all ${secs.length} sections`, () => this.app.cmd('clear-sections')] : null,
        null,
        ['⚡ Auto Edit…', () => this.app.cmd('auto-edit')],
      ]);
    });
    this.playheadEl.querySelector('.ph-head')?.addEventListener('pointerdown', e => { e.stopPropagation(); this._scrub(e); });
    // 〰 FILLER: drag across an um on a track to mark it; click inside one to hear it
    this.scroll.addEventListener('pointerdown', e => {
      if (!this.filling || e.button !== 0 || e.target.closest('.filler-tag, .filler-h, #tl-ruler')) return;
      const row = this._fillRowAt(e.clientY); if (!row) return;
      e.preventDefault(); e.stopPropagation();
      const t0 = Math.max(0, this._timeAt(e.clientX));
      const inside = (this.doc.fillers || []).find(f => f.track === row.tr.id && t0 >= f.t0 && t0 <= f.t1);
      if (inside) { playRange(this.app, inside.t0, inside.t1); return; }
      const band = el('div', { class: 'filler new', style: { left: this.x(t0) + 'px', top: (row.top + 2) + 'px', width: '2px', height: (row.h - 4) + 'px' } });
      this.tracksEl.append(band);
      let t1 = t0;
      const move = ev => { t1 = Math.max(0, this._timeAt(ev.clientX)); const a = Math.min(t0, t1), b = Math.max(t0, t1); band.style.left = this.x(a) + 'px'; band.style.width = Math.max(2, this.x(b - a)) + 'px'; };
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); band.remove();
        addFiller(this.app, t0, t1, row.tr.id);
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    }, true);
    // ✚ CLIPS: drag anywhere over the ruler or the tracks to mark a part (before clips get the click)
    this.scroll.addEventListener('pointerdown', e => {
      if (!this.marking || e.button !== 0 || e.target.closest('.part-tag, .part-h')) return;
      e.preventDefault(); e.stopPropagation();
      const r = this.tracksEl.getBoundingClientRect();
      const t0 = this._partSnap(Math.max(0, this._timeAt(e.clientX)));
      // starting inside a part that's already kept moves it (instead of making another)
      const inside = (this.doc.sections || []).find(p => t0 >= p.t0 && t0 <= p.t1);
      if (inside) { this._partDrag(e, inside.id, 'move'); return; }
      const band = el('div', { class: 'part-new', style: { left: this.x(t0) + 'px', width: '2px', height: this.totalH() + 'px' } });
      this.tracksEl.append(band);
      let t1 = t0;
      const move = ev => { t1 = this._partSnap(Math.max(0, this._timeAt(ev.clientX))); const a = Math.min(t0, t1), b = Math.max(t0, t1); band.style.left = this.x(a) + 'px'; band.style.width = Math.max(2, this.x(b - a)) + 'px'; };
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); band.remove();
        if (Math.abs(t1 - t0) > 0.3) this.app.keepPart(Math.min(t0, t1), Math.max(t0, t1));
        else toast('Drag across the part you want to keep.');
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      void r;
    }, true);
    // empty track area: click to put the playhead there, drag to select clips with a box
    this.tracksEl.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !(e.target === this.tracksEl || e.target.classList.contains('tl-row'))) return;
      if (this.tool === 'forward') { // ⇉: everything to the right of where you click
        const t = Math.max(0, this._timeAt(e.clientX)), ids = this.selectForward(t);
        toast(ids.length ? `${ids.length} clip${ids.length === 1 ? '' : 's'} from ${fmtTime(t)} on selected, on every track. Drag one to move them all.` : 'Nothing starts to the right of there.', 3500);
        return;
      }
      const r0 = this.tracksEl.getBoundingClientRect();
      const x0 = e.clientX - r0.left, y0 = e.clientY - r0.top;
      const keep = e.shiftKey || e.metaKey ? this.app.selection.clips.slice() : [];
      let box = null;
      const move = ev => {
        const r = this.tracksEl.getBoundingClientRect();
        const x1 = ev.clientX - r.left, y1 = ev.clientY - r.top;
        if (!box && Math.abs(x1 - x0) + Math.abs(y1 - y0) < 5) return;
        if (!box) { box = el('div', { class: 'marquee' }); this.tracksEl.append(box); }
        const L = Math.min(x0, x1), T = Math.min(y0, y1), Wd = Math.abs(x1 - x0), Hd = Math.abs(y1 - y0);
        Object.assign(box.style, { left: L + 'px', top: T + 'px', width: Wd + 'px', height: Hd + 'px' });
        const t0 = this.t(L), t1 = this.t(L + Wd);
        const rows = this.layout().filter(row => row.top < T + Hd && row.top + row.h > T).map(row => row.tr.id);
        const hit = this.doc.clips.filter(c => rows.includes(c.track) && c.start < t1 && clipEnd(c) > t0).map(c => c.id);
        this.app.select(withGroups(this.doc, [...new Set([...keep, ...hit])]), null, { noTimeline: true });
        for (const ce of this.tracksEl.querySelectorAll('.clip')) ce.classList.toggle('selected', this.app.selection.clips.includes(ce.dataset.id));
      };
      const up = ev => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        if (box) { box.remove(); this.app.select(this.app.selection.clips, null); return; }
        this.app.select(keep, null);
        this.app.seek(Math.max(0, this._timeAt(ev.clientX)));
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
  }

  _clipPointer(e, c) {
    if (e.button !== 0) return;
    e.stopPropagation();
    // double-click to edit: the timeline redraws between the two clicks (the first one selects), so the browser's
    // own dblclick never reaches the clip; it's timed here instead
    const now = performance.now();
    if (this._lastClick && this._lastClick.id === c.id && now - this._lastClick.at < 420 && Math.abs(e.clientX - this._lastClick.x) < 6) {
      this._lastClick = null;
      // Elastic Wave: a double-click puts a marker there (a moment of the sound to drag to another time)
      if (c.elastic && !e.target.closest('.ew-mark')) {
        const host = e.target.closest('.clip'), t = this.t(e.clientX - host.getBoundingClientRect().left);
        this.app.commit(() => { c.retime ||= linearRetime(c.duration, c.duration * (c.speed || 1)); c.retime = addPoint(c.retime, t); });
        return;
      }
      this.app.select([c.id], null);
      this.app.editClip?.(c) ?? this.app.focusInspector();
      return;
    }
    this._lastClick = { id: c.id, at: now, x: e.clientX };
    if (this.tool === 'blade' && !e.target.classList.contains('fade-h')) {
      if (c.locked) return;
      const t = this._bladeTime(e.clientX);
      let made = [];
      this.app.commit(d => { made = split(d, t, e.altKey ? [c.id] : withGroups(d, [c.id])); });
      if (made.length) this.spliceMark(t);
      return;
    }
    // ⇉ select forward: this clip and everything after it, on every track; then drag moves them all
    if (this.tool === 'forward' && !e.target.classList.contains('edge')) this.selectForward(c.start);
    const target = e.target;
    const sel = this.app.selection.clips;
    const mine = withGroups(this.doc, [c.id]);
    // ⌘ on a media clip's edge: retime (change its speed) rather than add to the selection
    const retime = e.metaKey && target.classList.contains('edge') && c.type === 'media' && !c.locked && mediaById(this.doc, c.media)?.kind !== 'image';
    if ((e.shiftKey || e.metaKey) && !retime) {
      this.app.select(sel.includes(c.id) ? sel.filter(x => !mine.includes(x)) : [...new Set([...sel, ...mine])], null);
      return;
    }
    if (retime) return this._retimeDrag(e, c, target.classList.contains('l') ? 'start' : 'end');
    // the clip you clicked is the one the inspector shows (a recording's sound, clicked, shows sound settings)
    const was = this.app.inspector.focus; this.app.inspector.focus = c.id;
    if (!sel.includes(c.id)) this.app.select(mine, null);
    else if (was !== c.id) this.app.inspector.render();
    if (this.app.selection.clips.some(id => this.doc.clips.find(k => k.id === id)?.locked)) return; // locked clips stay put
    // Elastic Wave: press on the waveform and drag to stretch the sound from that moment (the name strip still moves the clip)
    if (c.elastic && !target.classList.contains('edge') && !target.closest('.cbadges, .clip-gear, .fade-h, .ew-mark, .fxbadge')) {
      const host = target.closest('.clip');
      if (host && e.clientY - host.getBoundingClientRect().top > 16) return this._elasticGrab(e, c, host);
    }
    const edge = target.classList.contains('edge') ? (target.classList.contains('l') ? 'start' : 'end') : null;
    const startX = e.clientX, startRow = this._rowAt(e.clientY);
    const doc = this.doc;
    // trimming one clip of a group trims the others that share that edge (screen and its sound together),
    // like ScreenFlow and Resolve; ⌥ (a rolling edit) and ungrouped clips still trim alone
    const edgeAt = k => (edge === 'start' ? k.start : k.start + k.duration);
    const partners = edge && !e.altKey && c.group
      ? withGroups(doc, [c.id]).filter(id => id !== c.id).map(id => doc.clips.find(k => k.id === id)).filter(k => k && !k.locked && Math.abs(edgeAt(k) - edgeAt(c)) < 0.05).map(k => k.id)
      : [];
    const ids = edge ? [c.id, ...partners] : this.app.selection.clips.slice();
    // ⌥ on an edge where two clips touch: rolling edit (move the cut, both clips change)
    const rollWith = edge && e.altKey ? neighbour(doc, c, edge) : null;
    if (rollWith && rollWith.locked) return;
    if (rollWith) ids.push(rollWith.id);
    const orig = new Map(ids.map(id => { const x = doc.clips.find(k => k.id === id); return [id, { start: x.start, track: x.track, duration: x.duration, in: x.in, actions: structuredClone(x.actions || []), keys: x.keys ? structuredClone(x.keys) : undefined }]; }));
    let moved = false;
    // window listeners: the timeline redraws while dragging, which replaces the clip elements
    document.body.style.cursor = edge ? 'ew-resize' : 'grabbing';
    const move = ev => {
      const dx = ev.clientX - startX;
      const rowDelta = this._rowAt(ev.clientY) - startRow;
      if (!moved && Math.abs(dx) < 3 && rowDelta === 0) return;
      if (!moved) { moved = true; this.app.beginChange(); }
      if (rollWith) {
        for (const id of ids) { const k = doc.clips.find(x => x.id === id), o = orig.get(id); Object.assign(k, { start: o.start, duration: o.duration, in: o.in, actions: structuredClone(o.actions) }); if (o.keys) k.keys = structuredClone(o.keys); else delete k.keys; }
        const [left, right] = edge === 'end' ? [c, rollWith] : [rollWith, c];
        let t = (edge === 'start' ? orig.get(c.id).start : orig.get(c.id).start + orig.get(c.id).duration) + this.t(dx);
        if (this.snapOn) t = this._snap(doc, t, this._tol(), ids, [this.app.player.time]);
        roll(doc, left, right, t);
      } else if (edge) {
        const o = orig.get(c.id);
        for (const id of ids) {
          const k = doc.clips.find(x => x.id === id), ok = orig.get(id);
          Object.assign(k, { start: ok.start, duration: ok.duration, in: ok.in, actions: structuredClone(ok.actions) });
          if (ok.keys) k.keys = structuredClone(ok.keys); else delete k.keys;
        }
        let t = (edge === 'start' ? o.start : o.start + o.duration) + this.t(dx);
        if (this.snapOn) t = this._snap(doc, t, this._tol(), ids, [this.app.player.time]);
        // the group's clips can only go as far as the shortest of them allows, so they stay lined up
        const d = t - (edge === 'start' ? o.start : o.start + o.duration);
        for (const id of ids) {
          const k = doc.clips.find(x => x.id === id), ok = orig.get(id);
          trim(doc, k, edge, (edge === 'start' ? ok.start : ok.start + ok.duration) + d, k.type === 'media' ? mediaById(doc, k.media) : null);
        }
        if (ids.length > 1) {
          const edges = ids.map(id => edgeAt(doc.clips.find(x => x.id === id)));
          const lim = edge === 'start' ? Math.max(...edges) : Math.min(...edges); // the one that hit its limit first
          if (Math.max(...edges) - Math.min(...edges) > 1e-6) for (const id of ids) {
            const k = doc.clips.find(x => x.id === id), ok = orig.get(id);
            Object.assign(k, { start: ok.start, duration: ok.duration, in: ok.in, actions: structuredClone(ok.actions) });
            if (ok.keys) k.keys = structuredClone(ok.keys); else delete k.keys;
            trim(doc, k, edge, lim, k.type === 'media' ? mediaById(doc, k.media) : null);
          }
        }
      } else {
        // the earliest selected clip leads (so a whole selection can be pushed to 0 and snapped)
        const lead = [...orig.values()].reduce((a, b) => (b.start < a.start ? b : a));
        let ns = lead.start + this.t(dx);
        if (this.snapOn) {
          const s1 = this._snap(doc, ns, this._tol(), ids, [this.app.player.time]);
          const s2 = this._snap(doc, ns + lead.duration, this._tol(), ids, [this.app.player.time]) - lead.duration;
          ns = Math.abs(s1 - ns) <= Math.abs(s2 - ns) ? s1 : s2;
        }
        const dt = Math.max(ns - lead.start, -Math.min(...[...orig.values()].map(o => o.start)));
        // tracks this drag made for layering come off again first (its clips go back while it works out the move)
        if (made.length) {
          for (const id of ids) { const k = doc.clips.find(x => x.id === id); if (made.includes(k.track)) k.track = orig.get(id).track; }
          doc.tracks = doc.tracks.filter(t => !made.includes(t.id) || doc.clips.some(k => k.track === t.id));
          made = [];
        }
        const tracks = doc.tracks;
        const plan = ids.map(id => {
          const o = orig.get(id);
          const ti = Math.min(tracks.length - 1, Math.max(0, tracks.findIndex(t => t.id === o.track) + rowDelta));
          return { id, start: Math.max(0, o.start + dt), track: tracks[ti].id, dur: o.duration };
        });
        // a clip dragged partly over the next (or previous) clip on its track: allowed, it becomes a crossfade on
        // release. That works for a linked pair too (a recording's picture and its microphone, one clip per track):
        // each crossfades with its neighbour, so picture and sound blend together.
        const oneEach = new Set(plan.map(p => p.track)).size === plan.length;
        const fits = p => isFree(doc, p.track, p.start, p.dur, ids) || (oneEach && xfadeFits(doc, p, ids));
        let to = null;
        if (plan.every(fits)) to = plan;
        else {
          // just short of another clip: slide right up against it, so one drag closes the gap (like ScreenFlow and Resolve)
          const butt = buttUp(doc, plan, ids, orig, dt);
          if (butt && Math.abs(butt[0].start - plan[0].start) <= this.t(24)) to = butt;
          // dropped over other clips: it goes on top of them, at the time you dropped it, on a free track above
          // or on new track(s) made just above (a picture never ends up hidden underneath)
          else to = layerPlan(doc, plan, ids, made);
        }
        if (to) for (const p of to) { const k = doc.clips.find(x => x.id === p.id); k.start = p.start; k.track = p.track; }
        xf = oneEach ? Math.max(0, ...ids.map(id => xfadeOverlap(doc, doc.clips.find(x => x.id === id)))) : 0;
        if (xf > 0) {
          tip ||= document.body.appendChild(el('div', { class: 'retime-tip xf-tip' }));
          tip.textContent = `⤫ CROSSFADE ${xf.toFixed(2)} s — let go to blend`;
          tip.style.left = ev.clientX + 14 + 'px'; tip.style.top = ev.clientY - 34 + 'px';
        } else if (tip) { tip.remove(); tip = null; }
      }
      this.app.changed({ light: true });
    };
    let xf = 0, tip = null, made = [];
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      tip?.remove();
      if (moved && xf > 0) {
        const tracks = new Set(ids.map(id => doc.clips.find(x => x.id === id)?.track).filter(Boolean));
        let n = 0;
        for (const t of tracks) n += crossfadeOverlaps(doc.clips.filter(x => x.track === t && x.type === 'media'));
        if (n) toast(`Crossfade added (${xf.toFixed(2)} s): the two clips blend, sound and picture. Drag them apart to remove it.`, 4000);
      }
      if (moved && made.length) toast(`On ${made.length === 1 ? 'a new track' : 'new tracks'} above, so it plays on top.`, 3500);
      if (moved) this.app.endChange();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  /** ⌘-drag a clip's edge: the clip plays faster (shorter) or slower (longer), the same source either way. */
  /** Clip gain badge: drag up for louder, down for quieter (⇧ for fine steps). */
  _gainDrag(e, c, badge) {
    e.preventDefault(); e.stopPropagation();
    const y0 = e.clientY, v0 = c.audio?.volume ?? 1, db0 = v0 <= 0.0001 ? -60 : 20 * Math.log10(v0);
    let moved = false;
    const label = badge.querySelector('span');
    const move = ev => {
      const dy = y0 - ev.clientY;
      if (!moved && Math.abs(dy) < 2) return;
      if (!moved) { moved = true; this.app.beginChange(); }
      const db = Math.max(-60, Math.min(12, db0 + dy * (ev.shiftKey ? 0.05 : 0.25)));
      c.audio = { ...(c.audio || {}), volume: db <= -59.9 ? 0 : 10 ** (db / 20) };
      label.textContent = (db <= -59.9 ? '−∞' : (db > 0.05 ? '+' : db < -0.05 ? '−' : '') + Math.abs(db).toFixed(1)) + ' dB';
      this.app.changed({ light: true, noTimeline: true, keepInspector: true });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.style.cursor = ''; if (moved) this.app.endChange(); };
    document.body.style.cursor = 'ns-resize';
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  _retimeDrag(e, c, edge) {
    e.preventDefault(); e.stopPropagation();
    this.app.select([c.id], null);
    const doc = this.doc, startX = e.clientX;
    const o = { start: c.start, duration: c.duration, speed: c.speed || 1, keys: c.keys ? structuredClone(c.keys) : undefined, actions: structuredClone(c.actions || []), audio: c.audio ? { ...c.audio } : undefined };
    const tip = el('div', { class: 'retime-tip' }); document.body.append(tip);
    const show = ev => { tip.style.left = ev.clientX + 14 + 'px'; tip.style.top = ev.clientY - 30 + 'px'; tip.textContent = `${Math.round((c.speed || 1) * 100)}%  ·  ${(c.speed || 1).toFixed(2)}×  ·  ${c.duration.toFixed(2)} s`; };
    show(e);
    let moved = false;
    document.body.style.cursor = 'ew-resize';
    const move = ev => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 3) return;
      if (!moved) { moved = true; this.app.beginChange(); }
      Object.assign(c, { start: o.start, duration: o.duration, speed: o.speed, actions: structuredClone(o.actions) });
      if (o.keys) c.keys = structuredClone(o.keys); else delete c.keys;
      if (o.audio) c.audio = { ...o.audio };
      let len = edge === 'end' ? o.duration + this.t(dx) : o.duration - this.t(dx);
      if (this.snapOn) {
        const at = edge === 'end' ? this._snap(doc, o.start + len, this._tol(), [c.id], [this.app.player.time]) - o.start : o.start + o.duration - this._snap(doc, o.start + o.duration - len, this._tol(), [c.id], [this.app.player.time]);
        len = at;
      }
      len = Math.max(0.05, len);
      setSpeed(doc, c, (o.duration * o.speed) / len, edge === 'end' ? 'start' : 'end');
      show(ev);
      this.app.changed({ light: true });
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      document.body.style.cursor = ''; tip.remove();
      if (moved) this.app.endChange();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  /** A keyframe diamond: click jumps there, drag moves every key at that moment, ⌥-click deletes them. */
  _keyDrag(e, c, kt) {
    e.stopPropagation();
    if (e.button !== 0) return;
    const app = this.app;
    const at = list => list.filter(k => Math.abs(k.t - kt) < 1e-3);
    if (e.altKey) {
      app.commit(() => {
        for (const p of Object.keys(c.keys)) { c.keys[p] = c.keys[p].filter(k => Math.abs(k.t - kt) >= 1e-3); if (!c.keys[p].length) delete c.keys[p]; }
        if (!Object.keys(c.keys).length) delete c.keys;
      });
      return;
    }
    if (!app.selection.clips.includes(c.id)) app.select([c.id], null);
    const keys = Object.values(c.keys).flatMap(at);
    const startX = e.clientX;
    let moved = false;
    const move = ev => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 3) return;
      if (!moved) { moved = true; app.beginChange(); }
      let t = kt + this.t(dx);
      if (this.snapOn) t = this._snap(this.doc, c.start + t, this._tol(), [], [app.player.time]) - c.start;
      t = clamp(t, 0, c.duration);
      for (const k of keys) k.t = t;
      for (const l of Object.values(c.keys)) l.sort((a, b) => a.t - b.t);
      app.changed({ light: true, keepInspector: true });
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (moved) app.endChange({ keepInspector: true }); else app.seek(c.start + kt);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  _actionDrag(e, c, a) {
    e.stopPropagation();
    this.app.select([c.id], a.id);
    const startX = e.clientX, t0 = a.t, d0 = a.dur, edge = e.target?.dataset?.edge || null, bar = e.currentTarget;
    const MIN = 0.1;
    let moved = false;
    const move = ev => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 3) return;
      if (!moved) { moved = true; this.app.beginChange(); }
      const snap = t => (this.snapOn ? this._snap(this.doc, c.start + t, this._tol(), [], [this.app.player.time]) - c.start : t);
      if (edge === 'r') {
        // the end: quicker (shorter) or slower (longer), the start stays
        const end = clamp(snap(t0 + d0 + this.t(dx)), t0 + MIN, c.duration);
        a.dur = end - t0;
      } else if (edge === 'l') {
        // the start: the end stays
        const st = clamp(snap(t0 + this.t(dx)), 0, t0 + d0 - MIN);
        a.t = st; a.dur = t0 + d0 - st;
      } else a.t = Math.max(0, Math.min(c.duration - a.dur, snap(t0 + this.t(dx))));
      // the bar follows at once (the timeline redraws when you let go)
      if (bar?.isConnected) { bar.style.left = this.x(a.t) + 'px'; bar.style.width = Math.max(6, this.x(a.dur)) + 'px'; const lb = bar.querySelector('.al'); if (lb) lb.textContent = actLabel(a); }
      this.app.changed({ light: true });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); if (moved) this.app.endChange(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  _dropEvents() {
    const rowOf = e => this.doc && this.doc.tracks[this._rowAt(e.clientY)];
    this.scroll.addEventListener('dragover', e => {
      if (!this.doc) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      for (const r of this.tracksEl.children) r.classList.remove('drop');
      const tr = rowOf(e);
      const row = tr && this.tracksEl.querySelector(`[data-track="${tr.id}"]`);
      if (row) row.classList.add('drop');
    });
    this.scroll.addEventListener('dragleave', () => { for (const r of this.tracksEl.children) r.classList.remove('drop'); });
    this.scroll.addEventListener('drop', e => {
      e.preventDefault();
      for (const r of this.tracksEl.children) r.classList.remove('drop');
      const preset = e.dataTransfer.getData('text/x-reel-preset');
      if (preset) {
        let p = null; try { p = JSON.parse(preset); } catch { return; }
        const ce = e.target.closest?.('.clip'), tr = rowOf(e), raw = Math.max(0, this._timeAt(e.clientX));
        const at = this.snapOn ? this._snap(this.doc, raw, this._tol(), [], [this.app.player.time]) : raw;
        dropPreset(this.app, p, { at, track: tr?.id || null, clip: ce?.dataset.id || null });
        return;
      }
      const trans = e.dataTransfer.getData('text/x-reel-trans');
      if (trans) { const ce = e.target.closest?.('.clip'); if (ce) this.dropTransition(trans, ce.dataset.id, e.clientX); else toast('Drop it on a clip: near its start to open with it, near its end to close with it.'); return; }
      const t = Math.max(0, this._timeAt(e.clientX));
      const tr = rowOf(e);
      const rec = e.dataTransfer.getData('application/x-reel-recording');
      if (rec) { this.app.addRecordingClips(rec, this.snapOn ? this._snap(this.doc, t, this._tol(), [], [this.app.player.time]) : t); return; }
      const id = e.dataTransfer.getData('application/x-reel-media');
      if (id) this.app.addMediaClip(id, tr && tr.id, this.snapOn ? this._snap(this.doc, t, this._tol(), [], [this.app.player.time]) : t);
      else if (e.dataTransfer.files.length || e.dataTransfer.types.includes('Files')) this.app.importDropped(this.app.dropPaths(e), { track: tr && tr.id, at: t });
    });
  }
}

/** Writes an automation point (Touch mode while playing adds a point every few hundredths of a second). */
function writeAuto(tr, lane, t, v, tol) {
  tr.auto ||= {};
  const list = (tr.auto[lane] ||= []);
  const ex = list.find(k => Math.abs(k.t - t) <= tol);
  if (ex) ex.v = v;
  else { list.push({ t, v, ease: 'linear' }); list.sort((a, b) => a.t - b.t); }
}

// ---------------------------------------------------------------- auto crossfade on overlap
/** The clips on the moving clip's track that it overlaps (not counting itself). */
function overlapping(doc, trackId, start, end, ignore) {
  return doc.clips.filter(o => o.track === trackId && !ignore.includes(o.id) && o.start < end - 1e-3 && clipEnd(o) > start + 1e-3);
}
/** Can a single media clip sit at plan p partly over its neighbours, to make crossfades? Each clip it touches must
 *  stick out past it on one side (no clip fully covering another), at most one on each side, and not locked. */
function xfadeFits(doc, p, ids) {
  const k = doc.clips.find(x => x.id === p.id);
  if (!k || k.type !== 'media' || p.start < 0) return false;
  const s = p.start, e = p.start + p.dur;
  const hits = overlapping(doc, p.track, s, e, ids);
  if (!hits.length || hits.length > 2) return !hits.length;
  const left = hits.filter(o => o.start < s - 0.05 && clipEnd(o) < e - 0.05);
  const right = hits.filter(o => o.start > s + 0.05 && clipEnd(o) > e + 0.05);
  if (left.length + right.length !== hits.length || left.length > 1 || right.length > 1) return false;
  if (hits.some(o => o.type !== 'media' || o.locked)) return false;
  if (left[0] && right[0] && clipEnd(left[0]) > right[0].start) return false;
  return true;
}
/** How long the crossfade(s) would be with clip c where it is now (the longest overlap), or 0. */
function xfadeOverlap(doc, c) {
  if (!c || c.type !== 'media') return 0;
  let best = 0;
  for (const o of overlapping(doc, c.track, c.start, clipEnd(c), [c.id])) best = Math.max(best, Math.min(clipEnd(o), clipEnd(c)) - Math.max(o.start, c.start));
  return best > 0.01 ? best : 0;
}

/**
 * Clips moved onto other clips are layered on top: the whole selection goes up to the nearest rows above where it
 * all fits at that time; if none, new tracks are made just above the topmost of them (their ids pushed to made).
 */
export function layerPlan(doc, plan, ids, made = []) {
  const idx = p => doc.tracks.findIndex(t => t.id === p.track);
  const top = Math.min(...plan.map(idx));
  for (let k = 1; k <= top; k++) {
    const up = plan.map(p => ({ ...p, track: doc.tracks[idx(p) - k].id }));
    if (up.every(p => isFree(doc, p.track, p.start, p.dur, ids))) return up;
  }
  const rows = [...new Set(plan.map(p => p.track))].sort((a, b) => doc.tracks.findIndex(t => t.id === a) - doc.tracks.findIndex(t => t.id === b));
  const map = new Map(rows.map((id, j) => { const t = addTrack(doc, top + j); made.push(t.id); return [id, t.id]; }));
  return plan.map(p => ({ ...p, track: map.get(p.track) }));
}

/** A move that would overlap another clip, turned into the nearest move that just touches it: every edge
 *  a moved clip could butt against is tried, and the one closest to where you dragged wins. */
export function buttUp(doc, plan, ids, orig, dt) {
  const cands = new Set();
  for (const p of plan) {
    const o = orig.get(p.id);
    for (const k of doc.clips) {
      if (ids.includes(k.id) || k.track !== p.track) continue;
      cands.add(k.start - (o.start + o.duration)); // its end against k's start
      cands.add(k.start + k.duration - o.start);   // its start against k's end
    }
  }
  const minStart = Math.min(...plan.map(p => orig.get(p.id).start));
  const sorted = [...cands].filter(c => minStart + c >= -1e-9).sort((a, b) => Math.abs(a - dt) - Math.abs(b - dt));
  for (const c of sorted) {
    const tryPlan = plan.map(p => ({ ...p, start: Math.max(0, orig.get(p.id).start + c) }));
    if (tryPlan.every(p => isFree(doc, p.track, p.start, p.dur, ids))) return tryPlan;
  }
  return null;
}
