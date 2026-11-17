// Inspector: properties of the selected clip (or the project when nothing is selected).
// When a zoom & pan action is selected, position/scale/crop edits change that action's target.
import { el, section, slider, selectRow, colorRow, checkRow, toast, promptText } from './ui.js';
import { newCalloutClip, DEFAULT_PROPS, CALLOUT_DEFAULTS, TEXT_DEFAULTS, CURSOR_DEFAULTS } from './model.js';
import { retimeSection } from './retimeui.js';
import { applyCut, OVERLAP_CUTS, clipEnd, mediaById, fmtTime, ANIMATABLE, propsAt, paramAt, setParam, putKey, removeKey, keysOf, hasKeys, anyKeys, clamp, KEY_EASES, LABELS, setSpeed, SPEED_MIN, SPEED_MAX } from './model.js';
import { effectsSection, addPluginToClip } from './fx.js';
import { TEXT_ANIMS, TEXT_ACCENTS } from './compositor.js';
import { styleRow } from './titles.js';
import { roleButton } from './automix.js';
import { canFit, musicSection } from './musicfit.js';
import { canSeparate } from './ghost.js';
import { captionPanel, captionStylePanel, annotationPanel } from './textops.js';
import { filtersSection, matteSection, stabilizeSection } from './filters.js';
import { MOTION_PRESETS, applyMotion, clearMotion } from './motion.js';
import { hasDynZoom, getDynZoom, setDynZoomEase, swapDynZoom, removeDynZoom, DZ_EASES, setDynZoomTimes, addZoomBackOut, hasZoomBackOut, zoomMoves, shotOf } from './lib/dynzoom.js';
import { ELEMENTS } from './lib/elements.js';
import { pref } from './prefs.js';
import { lookOf, lookName, isFav, toggleFav, saveMyLook, revealPreset } from './fxlibrary.js';
import { addPush, pushOf, pushAt, setPush, removePush, pushPrefs, savePush } from './lib/push.js';
import { cursorAt } from './cursor.js';
import { frameFraction } from './autozoom.js';
import { textKeys, withKeys } from './texttools.js';

export const TRANSITIONS = [['none', 'None'], ['fade', 'Fade'], ['dip-black', 'Dip to black'], ['dip-white', 'Dip to white'], ['flash', 'Flash'],
  ['slide-left', 'Slide left'], ['slide-right', 'Slide right'], ['slide-up', 'Slide up'], ['slide-down', 'Slide down'], ['push-left', 'Push left'], ['push-right', 'Push right'],
  ['whip-left', 'Whip pan left'], ['whip-right', 'Whip pan right'], ['rise', 'Rise'], ['drop', 'Drop'],
  ['zoom', 'Zoom in'], ['zoom-out', 'Zoom out'], ['pop', 'Pop'], ['elastic', 'Elastic'], ['spin', 'Spin'], ['blur', 'Blur'], ['glitch', 'Glitch'],
  ['wipe-left', 'Wipe left'], ['wipe-right', 'Wipe right'], ['wipe-up', 'Wipe up'], ['wipe-down', 'Wipe down'], ['iris', 'Iris (circle)'], ['clock', 'Clock wipe'],
  ['barn', 'Barn doors'], ['blinds', 'Blinds'], ['diagonal', 'Diagonal wipe'],
  ['zoom-through', 'Zoom through (cut)'], ['spin-through', 'Spin through (cut)'], ['whip-through', 'Whip through (cut)'], ['blur-through', 'Blur through (cut)'],
  ['light-leak', 'Light leak'], ['film-burn', 'Film burn'], ['flash-cut', 'Flash (cut)'], ['glitch-cut', 'Glitch (cut)'], ['shake-cut', 'Shake (cut)'],
  ['cine-fade', 'Cinematic fade'], ['dip-film', 'Dip to film'], ['dreamy', 'Dreamy glow'], ['letterbox', 'Letterbox'],
  ['lens-defocus', 'Lens defocus (cut)'], ['exposure-burn', 'Exposure burn (cut)'], ['flare-sweep', 'Lens flare sweep (cut)'], ['punch-zoom', 'Punch zoom (cut)'], ['chroma-split', 'Chromatic split (cut)'], ['shutter', 'Radial shutter (cut)'],
  ['fast-wipe', 'Fast wipe (cut)'], ['glitch-blocks', 'Glitch blocks (cut)'], ['warp-zoom', 'Warp zoom (cut)'], ['slide-shake', 'Slide + shake (cut)'], ['film-burn-vintage', 'Vintage film burn (cut)'],
  ['match-move', 'Movement match cut'], ['match-graphic', 'Graphic match cut'], ['vertigo', 'Vertigo ramp (cut)'], ['text-reveal', 'Text reveal (cut)']];
const FONTS = ['Avenir Next', 'Avenir Next Condensed', 'Futura', 'Helvetica Neue', 'SF Pro Display', 'Impact', 'Arial Black', 'Gill Sans', 'Didot', 'Georgia', 'American Typewriter', 'Marker Felt', 'Menlo', 'Rockwell', 'Poppins'];
const CANVAS = [['1920x1080', '1920 × 1080 (HD)'], ['2560x1440', '2560 × 1440 (QHD)'], ['3840x2160', '3840 × 2160 (4K)'], ['1280x720', '1280 × 720'], ['1080x1920', '1080 × 1920 (vertical)'], ['1080x1350', '1080 × 1350 (4:5 portrait)'], ['1080x1080', '1080 × 1080 (square)'], ['1440x900', '1440 × 900 (Mac 16:10)'], ['2880x1800', '2880 × 1800 (Retina 16:10)']];

/** The inspector tab that suits these clips: 'audio' for sound only, 'video' for video and pictures, else ALL. */
const curveName = v => (Math.abs(v) < 0.03 ? 'Straight' : v > 0 ? `Fast ${Math.round(v * 100)}%` : `Slow ${Math.round(-v * 100)}%`);

export function defaultTab(doc, ids) {
  const kinds = new Set();
  for (const id of ids) {
    const c = doc.clips.find(x => x.id === id);
    if (!c) continue;
    const m = c.type === 'media' ? mediaById(doc, c.media) : null;
    // a title opens on TEXT, a call-out, element, shape or drawing on CALLOUT: the settings you came to change
    if (c.type !== 'media') { kinds.add(c.type === 'text' ? 'text' : ['element', 'callout', 'draw', 'arrow', 'shape'].includes(c.type) ? 'callout' : 'other'); continue; }
    kinds.add(!m ? 'other' : m.kind === 'audio' || c.audioOnly ? 'audio' : m.kind === 'video' || m.kind === 'image' ? 'video' : 'other');
  }
  return kinds.size === 1 && !kinds.has('other') ? [...kinds][0] : null;
}

// the tabs' icons: thin line drawings, like ScreenFlow's
const svg = d => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const TAB_ICONS = {
  video: svg('<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 9h18M3 15h18M7 5v4M7 15v4M17 5v4M17 15v4"/><path d="M10.5 10.5v3l2.6-1.5z" fill="currentColor"/>'),
  audio: svg('<path d="M4 9.5h3l4-3.5v12l-4-3.5H4z"/><path d="M15 9a4 4 0 0 1 0 6M17.5 6.5a7.5 7.5 0 0 1 0 11"/>'),
  music: svg('<path d="M9 17V6l10-2v11"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="15" r="2"/>'),
  speed: svg('<path d="M5 17a8 8 0 1 1 14 0"/><path d="M12 13l4-4"/><circle cx="12" cy="13" r="1" fill="currentColor"/>'),
  motion: svg('<path d="M12 4a8 8 0 1 1-7.4 5" stroke-dasharray="2.2 2.2"/><path d="M12 12h4M12 12V8"/><path d="M3 5l1.6 4L8.5 8"/>'),
  screen: svg('<circle cx="12" cy="12" r="8.5"/><path d="M9.5 7.5l6.5 4-3 .8-1.4 2.8z" fill="currentColor"/>'),
  callout: svg('<circle cx="9.5" cy="10.5" r="5.5"/><circle cx="14.5" cy="13.5" r="5.5"/>'),
  text: svg('<path d="M5 6h14M12 6v13"/>'),
  fx: svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18"/>'),
};
const TAB_TITLES = { video: 'Video', audio: 'Audio', music: 'Music', speed: 'Speed & timing', motion: 'Video motion', screen: 'Screen recording', callout: 'Callout', text: 'Text', fx: 'Filters & effects' };
const FOLD_KEY = 'reel.inspFold';
const foldedSet = () => { try { return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) || '[]')); } catch { return new Set(); } };
const setFolded = (key, on) => { const s = foldedSet(); if (on) s.add(key); else s.delete(key); try { localStorage.setItem(FOLD_KEY, JSON.stringify([...s].slice(-200))); } catch { /* not remembered */ } };

// what a double-click on a slider goes back to: a setting's default (by its path, or its name for plain sliders)
const pathDefault = path => {
  const [g, k] = path.split('.');
  const v = g === 'props' ? DEFAULT_PROPS[k] : g === 'callout' ? { buildIn: 0.3, buildOut: 0.3, ...CALLOUT_DEFAULTS }[k] : g === 'audio' ? { volume: 1, pan: 0 }[k] : g === 'text' ? TEXT_DEFAULTS[k] : g === 'cursor' ? CURSOR_DEFAULTS[k] : undefined;
  return typeof v === 'number' ? v : undefined;
};
const LABEL_DEFAULTS = {
  X: 0.5, Y: 0.5, Scale: 1, Rotation: 0, Opacity: 1, Left: 0, Top: 0, Right: 0, Bottom: 0,
  Corners: 0, Shadow: 0, Border: 0, 'Fade in': 0, 'Fade out': 0, 'Fade in curve': 0, 'Fade out curve': 0, 'Duck under voice': 0,
  'Build in': 0.3, 'Build out': 0.3, 'In length': 0.5, 'Out length': 0.5,
  Zoom: 1.5, 'In speed': 0.3, Hold: 2, 'Out speed': 0.3, 'Pointer size': 1,
};
export class Inspector {
  constructor(app) { this.app = app; this.root = document.getElementById('inspector'); }
  get doc() { return this.app.doc; }

  render() {
    const app = this.app, doc = this.doc;
    if (!doc) return;
    this.keyed = [];
    const ids = app.selection.clips;
    const scroll = this.root.scrollTop;
    // a new selection opens on the tab for what it is: AUDIO for a sound clip, VIDEO for a video or picture
    // (a tab picked by hand stays while the same clips are selected)
    const selKey = ids.join(',');
    this._kind = defaultTab(doc, ids);
    if (selKey + '|' + this.focus !== this._tabSel) { this._tabSel = selKey + '|' + this.focus; this.tab = null; }
    this.root.replaceChildren();
    if (app.selection.caption) {
      const cap = (doc.captions || []).find(x => x.id === app.selection.caption);
      if (cap) { captionPanel(app, this, cap); this.root.scrollTop = scroll; return; }
    }
    if (!ids.length) this.project();
    else if (ids.length > 1 && (() => { // a picture selected with its own sound (a recording's screen and mic, a PIP and its audio): the picture's settings
      const cs = ids.map(id => doc.clips.find(x => x.id === id)).filter(Boolean);
      const snd = x => x.type === 'media' && (x.audioOnly || mediaById(doc, x.media)?.kind === 'audio');
      const pics = cs.filter(x => !snd(x));
      if (pics.length !== 1 || cs.length !== ids.length) return false;
      // the one you clicked: its sound shows sound settings, its picture picture settings
      const f = cs.find(x => x.id === this.focus), show = f && snd(f) ? f : pics[0];
      this.root.append(el('p', { class: 'note sel-with-sound', text: show === pics[0] ? 'The picture’s settings. Click its sound clip on the timeline for the sound’s. Drag either to move both.' : 'The sound’s settings. Click its picture on the timeline for the picture’s. Drag either to move both.' }));
      this._kind = defaultTab(doc, [show.id]);
      this.clip(show);
      return true;
    })()) { /* shown */ }
    else if (ids.length > 1) {
      const b = (text, cmd) => el('button', { class: 'tool', text, onclick: () => app.cmd(cmd) });
      this.root.append(section(`${ids.length} clips selected`,
        el('p', { class: 'note', text: 'Drag any of them, or ⌥← ⌥→, to move them all together.' }),
        el('div', { class: 'btn-row' }, b('Group', 'group'), b('Ungroup', 'ungroup'), b('Lock / unlock', 'lock'), b('Paste style', 'paste-style'), b('Paste properties', 'paste-properties'), b('Delete', 'delete'))));
    }
    else {
      const c = doc.clips.find(x => x.id === ids[0]);
      if (!c) { this.project(); return; }
      this.clip(c);
    }
    this.tabBar();
    this.root.scrollTop = scroll;
  }

  /**
   * ScreenFlow-style switcher at the top of the inspector: one engraved key per kind of setting the
   * selection has (Video, Audio, Motion, Screen, Callout, Text, Effects). ALL shows everything.
   */
  tabBar() {
    const CATS = [
      ['all', 'ALL', 'Everything'],
      ['video', 'VIDEO', 'Position, size, crop, style, transitions'],
      ['audio', 'AUDIO', 'Volume, pan, fades, voice'],
      ['music', 'MUSIC', 'Extend or shorten music to fit the video, with no audible seam'],
      ['speed', 'SPEED', 'Duration, speed, reverse, lock'],
      ['motion', 'MOTION', 'Zoom & pan actions and keyframes'],
      ['screen', 'SCREEN', 'Pointer, clicks and keystrokes'],
      ['callout', 'CALLOUT', 'Callout and shape settings'],
      ['text', 'TEXT', 'Text, titles and captions'],
      ['fx', 'FX', 'Filters, background removal and sound effects'],
    ];
    const catOf = title => {
      const t = title.toLowerCase();
      if (/^speed|^retime/i.test(t)) return 'speed';
      if (/^music/.test(t)) return 'music';
      if (/^position|^crop|^style|^transitions|^video levels|^picture in picture|^stabili[sz]e|^colou?r|^match colou?r|^green screen|^remove background/.test(t)) return 'video';
      if (/^audio/.test(t)) return 'audio';
      if (/^actions|^keyframes|^motion presets|^dynamic zoom|^quick push|^🎯 zoom moves/.test(t)) return 'motion';
      if (/^pointer|^keystrokes/.test(t)) return 'screen';
      if (/^callout|^shape|^annotation|^element/.test(t)) return 'callout';
      if (/^text|^caption/.test(t)) return 'text';
      if (/^effects|^filters|^background/.test(t)) return 'fx';
      return 'other';
    };
    const secs = [...this.root.querySelectorAll(':scope > .insp-section')];
    secs.forEach(sec => { sec.dataset.cat = catOf(sec.querySelector('.engr')?.textContent || ''); });
    const present = new Set(secs.map(x => x.dataset.cat));
    // only what fits what you clicked: a sound clip never shows picture settings, a picture never shows sound ones
    // (a video with its own sound keeps an AUDIO tab for it). No ALL: one tab at a time, the first one to start.
    const kind = this._kind;
    const fits = k => k !== 'all' && present.has(k) && !(kind === 'audio' && ['video', 'motion', 'screen', 'callout', 'text'].includes(k));
    const tabs = CATS.filter(([k]) => fits(k));
    if (kind === 'audio') for (const sec of secs) if (['video', 'motion', 'screen', 'callout', 'text'].includes(sec.dataset.cat)) sec.remove();
    if (!tabs.length) return;
    let cur = this.tab && fits(this.tab) ? this.tab : kind && fits(kind) ? kind : tabs[0][0];
    const app = this.app, doc = this.doc;
    const c = app.selection.clips.length >= 1 ? doc.clips.find(x => x.id === (this.focus && app.selection.clips.includes(this.focus) ? this.focus : app.selection.clips[0])) : null;
    const act = c && app.selection.action ? (c.actions || []).find(x => x.id === app.selection.action) : null;
    const visual = c && (c.type !== 'media' || ['video', 'image'].includes(mediaById(doc, c.media)?.kind)) && !c.audioOnly;
    // ScreenFlow's way: a row of icon tabs, then a header with the tab's name and + Action
    const bar = el('div', { class: 'insp-tabs icons', role: 'tablist' });
    const title = el('span', { class: 'ih-title' });
    const foldAll = el('button', { class: 'ih-fold', type: 'button', title: 'Fold or unfold every section on this tab' });
    const addAct = visual ? el('button', { class: 'ih-act', type: 'button', text: '+ Action', title: 'An action at the playhead: then change any setting on this tab (position, size, opacity, crop…) and it animates there (⌘K)', onclick: () => app.cmd('insert-action') }) : null;
    const head = el('div', { class: 'insp-head' }, title, el('span', { class: 'spacer' }), foldAll, addAct);
    // an action being edited: what it is, its length and easing, and Done, right under the header
    const actBar = act ? el('div', { class: 'insp-actbar' },
      el('span', { class: 'ia-what', text: `${act.push ? (act.pushPart === 'in' ? 'Push in' : 'Push out') : 'Action'} at ${fmtTime(c.start + act.t).replace(/(\.\d)\d*$/, '$1')}` }),
      (() => { const i = el('input', { type: 'number', min: 0.05, max: Math.max(0.05, c.duration - act.t), step: 0.05, value: act.dur.toFixed(2), title: 'How long it takes (s)' }); i.addEventListener('change', () => this.edit(() => { act.dur = clamp(+i.value || act.dur, 0.05, Math.max(0.05, c.duration - act.t)); })); return el('label', { class: 'ia-len' }, i, el('span', { text: 's' })); })(),
      selectRow('', act.ease || 'ease', [['ease', 'Smooth'], ['linear', 'Steady'], ['in', 'Ease in'], ['out', 'Ease out']], v => this.edit(() => { act.ease = v; })),
      el('button', { class: 'ia-done', type: 'button', text: 'Done', title: 'Stop editing this action: settings change the clip itself again', onclick: () => app.select([c.id], null) })) : null;
    const folded = foldedSet();
    const secsOf = k => secs.filter(sec => sec.dataset.cat === k);
    const apply = () => {
      for (const sec of secs) sec.classList.toggle('tab-hidden', sec.dataset.cat !== cur && sec.dataset.cat !== 'other');
      for (const b of bar.children) b.classList.toggle('lit', b.dataset.k === cur);
      const t = CATS.find(x => x[0] === cur);
      title.textContent = cur === 'callout' && c?.type === 'element' ? 'Graphic' : TAB_TITLES[cur] || (t ? t[1] : '');
      const mine = secsOf(cur).filter(sec => sec.classList.contains('foldable'));
      foldAll.hidden = mine.length < 2;
      foldAll.textContent = mine.some(sec => !sec.classList.contains('folded')) ? '▸ Fold all' : '▾ Unfold all';
      if (addAct) addAct.hidden = !['video', 'motion', 'callout', 'text', 'screen'].includes(cur);
    };
    // every section folds from its title (remembered), and Fold all does a whole tab at once
    // the Motion tab in order of use: quick push, zoom moves, actions, then the rest
    const RANK = [/punch in & out/, /^🎯 zoom moves/, /^actions/, /^dynamic zoom/, /^keyframes/, /^motion presets/];
    const rank = sec => { const t = (sec.querySelector(':scope > .engr')?.textContent || '').toLowerCase(); const i = RANK.findIndex(r => r.test(t)); return i < 0 ? RANK.length : i; };
    const motion = secs.filter(sec => sec.dataset.cat === 'motion').sort((x, y) => rank(x) - rank(y));
    if (motion.length > 1) { const after = motion[0].previousSibling; const frag = document.createDocumentFragment(); motion.forEach(x => frag.append(x)); this.root.insertBefore(frag, after ? after.nextSibling : this.root.firstChild); }
    for (const sec of secs) {
      const h = sec.querySelector(':scope > .engr');
      if (!h || sec.dataset.cat === 'other') continue;
      h.classList.add('sec-title');
      const key = h.textContent.trim().toLowerCase();
      sec.classList.add('foldable');
      if (folded.has(key)) sec.classList.add('folded');
      h.addEventListener('click', () => { sec.classList.toggle('folded'); setFolded(key, sec.classList.contains('folded')); apply(); });
    }
    foldAll.addEventListener('click', () => {
      const mine = secsOf(cur).filter(sec => sec.classList.contains('foldable')), fold = mine.some(sec => !sec.classList.contains('folded'));
      for (const sec of mine) { sec.classList.toggle('folded', fold); setFolded(sec.querySelector('.sec-title').textContent.trim().toLowerCase(), fold); }
      apply();
    });
    for (const [k, label, tip] of tabs) {
      const b = el('button', { class: 'insp-tab', 'data-k': k, type: 'button', role: 'tab', title: `${label[0] + label.slice(1).toLowerCase()}: ${tip}`, 'aria-label': label, onclick: () => { cur = k; this.tab = k; apply(); this.root.scrollTop = 0; } });
      b.innerHTML = TAB_ICONS[k] || '';
      bar.append(b);
    }
    const top = el('div', { class: 'insp-top' }, tabs.length > 1 ? bar : null, head, actBar);
    this.root.prepend(top);
    apply();
  }

  /** Slider bound to an edit: history entry once per drag, live preview while dragging. */
  sl(label, get, set, opts) {
    const app = this.app;
    return slider(label, get(), {
      def: LABEL_DEFAULTS[label],
      ...opts,
      onStart: () => app.beginChange(),
      onInput: v => { set(v); app.changed({ light: true, keepInspector: true }); },
      onCommit: () => app.endChange({ keepInspector: true }),
    });
  }
  edit(fn) { this.app.commit(fn); }

  /** The playhead moved: keyed sliders show the value at the new time. */
  onTime() { for (const f of this.keyed || []) f(); }

  /**
   * Keyable slider. ◆ adds a keyframe at the playhead (or removes the one there); once a parameter has
   * keyframes, moving the slider writes a keyframe at the playhead. ◀ ▶ jump to the previous / next one.
   */
  ksl(c, path, label, opts) {
    const app = this.app;
    const fps = this.doc.canvas.fps || 30, tol = 0.5 / fps;
    const local = () => clamp(app.player.time - c.start, 0, c.duration);
    const row = slider(label, paramAt(c, path, local()), {
      def: pathDefault(path),
      ...opts,
      onStart: () => app.beginChange(),
      onInput: v => { setParam(c, path, local(), v, tol); app.changed({ light: true, keepInspector: true }); refresh(); },
      onCommit: () => app.endChange({ keepInspector: true }),
    });
    const input = row.querySelector('input'), val = row.querySelector('.val'), fmt = opts.fmt || (v => v.toFixed(2));
    const jump = dir => {
      const list = keysOf(c, path); if (!list) return;
      const t = local(), k = dir < 0 ? [...list].reverse().find(x => x.t < t - tol) : list.find(x => x.t > t + tol);
      if (k) app.seek(c.start + k.t);
    };
    const prev = el('button', { class: 'kjump', text: '‹', title: 'Previous keyframe', onclick: () => jump(-1) });
    const next = el('button', { class: 'kjump', text: '›', title: 'Next keyframe', onclick: () => jump(1) });
    const diamond = el('button', { class: 'kbtn', title: 'Keyframe at the playhead (click to add or remove)' });
    diamond.addEventListener('click', () => {
      const t = local(), list = keysOf(c, path), here = list && list.find(k => Math.abs(k.t - t) <= tol);
      app.commit(() => { if (here) removeKey(c, path, here.t, tol); else putKey(c, path, t, paramAt(c, path, t), tol); });
    });
    const refresh = () => {
      const list = keysOf(c, path), t = local();
      diamond.classList.toggle('on', !!(list && list.some(k => Math.abs(k.t - t) <= tol)));
      row.classList.toggle('animated', hasKeys(c, path));
      prev.disabled = !(list && list.some(k => k.t < t - tol)); next.disabled = !(list && list.some(k => k.t > t + tol));
      if (document.activeElement !== input) { const v = paramAt(c, path, t); input.value = v; val.textContent = fmt(v); }
    };
    row.append(el('span', { class: 'kctl' }, prev, diamond, next));
    refresh();
    this.keyed.push(refresh);
    return row;
  }

  /** Every keyframe moment on a clip, with its easing; delete one or all. */
  keyframesPanel(c) {
    if (!anyKeys(c)) return;
    const app = this.app;
    const moments = new Map();
    for (const [path, list] of Object.entries(c.keys)) for (const k of list) {
      const t = Math.round(k.t * 1000) / 1000;
      if (!moments.has(t)) moments.set(t, []);
      moments.get(t).push({ path, k });
    }
    const rows = [...moments.entries()].sort((a, b) => a[0] - b[0]).map(([t, ks]) => {
      const ease = el('select', { title: 'How it moves from this keyframe to the next' }, ...KEY_EASES.map(([v, label]) => el('option', { value: v, text: label, selected: (ks[0].k.ease || 'linear') === v })));
      ease.addEventListener('change', () => this.edit(() => { for (const { k } of ks) k.ease = ease.value; }));
      return el('div', { class: 'kf-row' },
        el('button', { class: 'mini', text: fmtTime(c.start + t), title: 'Go there', onclick: () => app.seek(c.start + t) }),
        el('span', { class: 'kf-params', text: ks.map(x => x.path.split('.')[1]).join(', ') }), ease,
        el('button', { class: 'mini', text: '×', title: 'Delete these keyframes', onclick: () => this.edit(() => { for (const { path } of ks) removeKey(c, path, t, 1e-3); }) }));
    });
    this.root.append(section('Keyframes', el('p', { class: 'note', text: 'Diamonds on the clip in the timeline: click to jump, drag to retime, ⌥-click to delete.' }), ...rows,
      el('div', { class: 'btn-row' }, el('button', { class: 'tool', text: 'Remove all keyframes', onclick: () => this.edit(() => { delete c.keys; }) }))));
  }

  project() {
    const app = this.app, doc = this.doc;
    const size = `${doc.canvas.width}x${doc.canvas.height}`;
    this.root.append(
      section('Project',
        el('p', { class: 'note', text: 'Select a clip to change it. Drag media from the left onto the timeline.' }),
        selectRow('Canvas', CANVAS.some(([v]) => v === size) ? size : '1920x1080', CANVAS, v => {
          const [w, h] = v.split('x').map(Number);
          this.edit(() => { doc.canvas.width = w; doc.canvas.height = h; });
          app.player.resize();
        }),
        selectRow('Frame rate', doc.canvas.fps, [[24, '24 fps'], [25, '25 fps'], [30, '30 fps'], [50, '50 fps'], [60, '60 fps']], v => this.edit(() => { doc.canvas.fps = Number(v); })),
        colorRow('Background', doc.canvas.background, v => this.edit(() => { doc.canvas.background = v; })),
      ),
      (doc.captions || []).length ? captionStylePanel(app, this) : section('Captions', el('p', { class: 'note', text: 'Add captions at the playhead (⌃⌘C) or import an SRT / VTT file.' }), el('div', { class: 'btn-row' }, el('button', { class: 'tool', text: '+ Caption', onclick: () => app.cmd('add-caption') }), el('button', { class: 'tool', text: 'Import SRT / VTT', onclick: () => app.cmd('captions-import') }))),
      section('Markers', ...(doc.markers.length ? [el('div', { class: 'btn-row' },
          el('button', { class: 'tool del-all', text: `🗑 DELETE ALL ${doc.markers.length}`, title: 'Delete every marker (asks first; ⌘Z brings them back)', onclick: () => app.deleteMarkers('all') }),
          doc.markers.some(m => m.claps || m.mark) ? el('button', { class: 'tool', text: `Delete clap / mark markers (${doc.markers.filter(m => m.claps || m.mark).length})`, title: 'Only the ✂ Clap and ◆ Mark markers (your takes go with them)', onclick: () => app.deleteMarkers('takes') }) : null)] : []),
        ...(doc.markers.length ? doc.markers.map(m => el('div', { class: 'row marker-row' },
        el('button', { class: 'mini', text: fmtTime(m.t), onclick: () => app.seek(m.t) }),
        (() => { const i = el('input', { type: 'text', value: m.label || '' }); i.addEventListener('change', () => this.edit(() => { m.label = i.value.slice(0, 80); })); return i; })(),
        el('button', { class: 'mini marker-x', text: '×', title: 'Delete this marker (⌘Z brings it back)', onclick: () => this.edit(() => { doc.markers = doc.markers.filter(x => x !== m); }) }))) : [el('p', { class: 'note', text: 'Press M to add a marker at the playhead. Markers become YouTube chapters in the export notes.' })])),
    );
  }

  clip(c) {
    const app = this.app, doc = this.doc;
    const m = c.type === 'media' ? mediaById(doc, c.media) : null;
    const act = app.selection.action ? (c.actions || []).find(a => a.id === app.selection.action) : null;
    // what the sliders show: the action's target state, or the clip's base state
    const local = Math.max(0, Math.min(c.duration, app.player.time - c.start));
    const shown = act ? { ...propsAt({ ...c, actions: c.actions.filter(a => a.t <= act.t), transIn: null, transOut: null }, act.t + act.dur) } : c.props;
    const getP = k => (act && act.props && k in act.props ? act.props[k] : shown[k] ?? c.props[k]);
    const setP = (k, v) => { if (act && ANIMATABLE.includes(k)) { act.props = { ...act.props, [k]: v }; } else c.props[k] = v; };
    const visual = c.type !== 'media' || (m && m.kind !== 'audio');

    const head = section(c.type === 'media' ? (m ? m.name : 'Missing media') : c.type === 'text' ? 'Text' : c.type === 'callout' ? 'Callout' : c.type === 'draw' ? 'Annotation' : c.type === 'element' ? 'Element' : 'Arrow / shape',
      el('p', { class: 'note', text: `${fmtTime(c.start)} → ${fmtTime(c.start + c.duration)} · ${c.duration.toFixed(2)} s` + (m && m.width ? ` · ${m.width}×${m.height}` : '') + (m && m.role && m.role !== 'import' ? ` · ${m.role}` : '') }),
    );
    // speed & timing get a tab of their own (they used to sit in the header, so every tab repeated them)
    const speedSec = c.type === 'media' && m && m.kind !== 'image' ? section('Speed & duration', this.speedPanel(c, m)) : null;
    if (c.type === 'media' && m && m.kind === 'image') {
      head.append(this.sl('Duration', () => c.duration, v => { c.duration = v; }, { min: 0.5, max: 60, step: 0.1, fmt: v => v.toFixed(1) + 's' }));
    }
    this.root.append(head);
    if (speedSec) this.root.append(speedSec);
    if (c.type === 'media' && m && m.kind !== 'image' && !c.reversed && !act) this.root.append(retimeSection(app, this, c, m));

    if (c.type === 'text') this.textPanel(c);
    if (c.type === 'callout') this.calloutPanel(c);
    if (c.type === 'shape') this.shapePanel(c);
    if (c.type === 'draw') annotationPanel(app, this, c);
    if (c.type === 'element') this.root.append(elementPanel(this, c));

    if (visual) {
      if (c.type === 'media') this.root.append(pushSection(app, this, c, m));
      if (c.type === 'media' && !act) this.root.append(calloutStarts(app, c, m));
      if (!act) this.root.append(dynZoomSection(app, this, c));
      this.root.append(motionSection(this, c));
      const pos = section(act ? 'Position (action target)' : 'Position & size');

      const P = (k, label, o) => (act ? this.sl(label, () => getP(k), v => setP(k, v), o) : this.ksl(c, 'props.' + k, label, o));
      pos.append(
        P('x', 'X', { min: -0.5, max: 1.5, step: 0.001, fmt: v => (v * 100).toFixed(0) + '%' }),
        P('y', 'Y', { min: -0.5, max: 1.5, step: 0.001, fmt: v => (v * 100).toFixed(0) + '%' }),
        P('scale', 'Scale', { min: 0.05, max: 5, step: 0.01, fmt: v => (v * 100).toFixed(0) + '%' }),
        P('rotation', 'Rotation', { min: -180, max: 180, step: 0.5, fmt: v => v.toFixed(0) + '°' }),
        P('opacity', 'Opacity', { min: 0, max: 1, step: 0.01, fmt: v => (v * 100).toFixed(0) + '%' }),
      );
      if (c.type === 'media') {
        pos.append(el('div', { class: 'btn-row' }, ...[
          ['Full', { x: 0.5, y: 0.5, scale: 1 }], ['PiP ↘', { x: 0.85, y: 0.8, scale: 0.26 }], ['PiP ↙', { x: 0.15, y: 0.8, scale: 0.26 }],
          ['PiP ↗', { x: 0.85, y: 0.2, scale: 0.26 }], ['Left ½', { x: 0.25, y: 0.5, scale: 0.5 }], ['Right ½', { x: 0.75, y: 0.5, scale: 0.5 }], ['Inset 85%', { x: 0.5, y: 0.5, scale: 0.85 }],
        ].map(([label, p]) => el('button', { class: 'tool', text: label, onclick: () => this.edit(() => { for (const [k, v] of Object.entries(p)) setP(k, v); if (label.startsWith('PiP') && !act) { c.props.radius = Math.max(c.props.radius || 0, 24); c.props.shadow = Math.max(c.props.shadow || 0, 30); } }) }))));
        // device frames: the picture inside a browser, a Mac window, a phone or a laptop
        {
          const fr = c.frame || { type: 'none' };
          pos.append(selectRow('Frame', fr.type || 'none', [['none', 'None'], ['browser', 'Browser window'], ['window', 'Mac window'], ['phone', 'Phone'], ['laptop', 'Laptop']],
            v => this.edit(() => { if (v === 'none') delete c.frame; else { c.frame = { ...(c.frame || {}), type: v }; if ((c.props.scale ?? 1) > 0.9) c.props.scale = 0.8; } })));
          if (c.frame && c.frame.type) {
            pos.append(selectRow('Frame colour', c.frame.color || 'dark', [['dark', 'Dark'], ['light', 'Light']], v => this.edit(() => { c.frame.color = v; })));
            if (c.frame.type === 'browser' || c.frame.type === 'window') {
              const t = el('input', { type: 'text', value: (c.frame.type === 'browser' ? c.frame.url : c.frame.title) || '', placeholder: c.frame.type === 'browser' ? 'example.com' : 'Window title' });
              t.addEventListener('change', () => this.edit(() => { c.frame[c.frame.type === 'browser' ? 'url' : 'title'] = t.value.slice(0, 80); }));
              pos.append(el('div', { class: 'row' }, el('label', { text: c.frame.type === 'browser' ? 'Address' : 'Title' }), t));
            }
          }
        }
        const crop = section('Crop');
        ['Left', 'Top', 'Right', 'Bottom'].forEach((name, i) => crop.append(this.sl(name, () => getP('crop')[i], v => { const cr = [...getP('crop')]; cr[i] = v; setP('crop', cr); }, { min: 0, max: 0.45, step: 0.001, fmt: v => (v * 100).toFixed(0) + '%' })));
        this.root.append(pos, crop, levelsSection(this, c), filtersSection(app, this, c), ...(m && m.kind === 'video' ? [stabilizeSection(app, this, c, m), matteSection(app, this, c, m)] : []),
          section('Style',
            this.sl('Corners', () => c.props.radius || 0, v => { c.props.radius = v; }, { min: 0, max: 300, step: 1, fmt: v => v.toFixed(0) }),
            this.sl('Shadow', () => c.props.shadow || 0, v => { c.props.shadow = v; }, { min: 0, max: 120, step: 1, fmt: v => v.toFixed(0) }),
            this.sl('Border', () => c.props.border || 0, v => { c.props.border = v; }, { min: 0, max: 30, step: 0.5, fmt: v => v.toFixed(1) }),
            colorRow('Border color', c.props.borderColor, v => this.edit(() => { c.props.borderColor = v; })),
          ));
      } else this.root.append(pos);
      this.keyframesPanel(c);
      this.actionsPanel(c, local);
      this.root.append(section('Transitions',
        el('div', { class: 'btn-row' }, el('button', { class: 'tool tp-insp', text: '⧓ PICK WITH PREVIEWS & FADES…', title: 'The transitions and fades panel: animated previews, fade in / out, apply to every cut', onclick: () => this.app.cmd('transitions') })),
        selectRow('In', c.transIn.type, TRANSITIONS, v => this.edit(() => {
          // the text reveal needs the clip before it to go on playing underneath: it's set up on the cut
          const prev = app.doc.clips.find(o => o !== c && o.track === c.track && Math.abs(clipEnd(o) - c.start) < 0.05);
          if (OVERLAP_CUTS.has(v) && prev) { applyCut(prev, c, v, 0.8); return; }
          if (OVERLAP_CUTS.has(c.transIn.type) && prev) { delete prev.xfadeOut; delete c.xfadeIn; if (prev.transOut?.type === c.transIn.type) prev.transOut.type = 'none'; }
          if (c.transIn.type === 'none') c.transIn.dur = Math.min(c.duration / 2, Number(pref('transDur')) || 0.5); c.transIn.type = v;
        })),
        c.transIn.type === 'text-reveal' ? (() => {
          const i = el('input', { type: 'text', value: c.transIn.text || 'NEXT', maxlength: 40, placeholder: 'NEXT' });
          i.addEventListener('change', () => this.edit(() => { c.transIn.text = i.value.trim().slice(0, 40) || 'NEXT'; }));
          return el('div', { class: 'row', title: 'The words this clip shows through. Short and bold works best: one word, or two.' }, el('label', { text: 'Reveal text' }), i, textKeys(i));
        })() : null,
        this.sl('In length', () => c.transIn.dur, v => { c.transIn.dur = v; }, { min: 0.1, max: Math.max(0.2, Math.min(5, c.duration / 2)), step: 0.05, fmt: v => v.toFixed(2) + 's' }),
        selectRow('Out', c.transOut.type, TRANSITIONS, v => this.edit(() => { if (c.transOut.type === 'none') c.transOut.dur = Math.min(c.duration / 2, Number(pref('transDur')) || 0.5); c.transOut.type = v; })),
        this.sl('Out length', () => c.transOut.dur, v => { c.transOut.dur = v; }, { min: 0.1, max: Math.max(0.2, Math.min(5, c.duration / 2)), step: 0.05, fmt: v => v.toFixed(2) + 's' }),
      ));
    }
    if (c.type === 'media' && m && (m.hasAudio || m.kind === 'audio')) this.audioPanel(c, m);
    if (canFit(this.doc, c)) this.root.append(musicSection(app, c, section));
    if (canSeparate(this.doc, c)) this.root.append(section('Audio: isolate a sound',
      el('p', { class: 'note', text: c.separated ? `Separated from its clip: ${c.separated.which === 'target' ? 'only' : 'without'} “${c.separated.prompt}”.` : 'Type what you hear (dog barking, keyboard typing, music…) and pull just that sound out of this clip, or take it out and keep the rest.' }),
      el('button', { class: 'hw amber', text: '👻 ISOLATE OR REMOVE A SOUND…', onclick: () => app.cmd('ghost') })));
    if (!visual) this.keyframesPanel(c);
    if (c.type === 'media' && m && m.cursor) this.cursorPanel(c);
    const isVideo = c.type === 'media' && m && m.kind === 'video' && !c.audioOnly;
    const b = (text, cmd, title, on) => el('button', { class: 'tool' + (on ? ' on-amber' : ''), text, title, onclick: () => app.cmd(cmd) });
    this.root.append(section('Clip',
      c.locked ? el('p', { class: 'note', text: 'Locked: it can’t be moved, trimmed or deleted until you unlock it (⌘L).' }) : null,
      el('div', { class: 'btn-row' },
        b('Splice', 'split', 'Splice: cut at the playhead (S)'),
        b('Trim front', 'trim-front', 'Trim the start to the playhead ([)'),
        b('Trim end', 'trim-end', 'Trim the end to the playhead (])'),
        b('Duplicate', 'duplicate'),
        b('Delete', 'delete')),
      el('div', { class: 'btn-row' },
        isVideo ? b('Freeze frame', 'freeze', 'Hold the frame at the playhead for 2 s (⌥F)') : null,
        c.type === 'media' && m && m.kind !== 'image' ? b(c.reversed ? '◀◀ Reversed' : 'Reverse', 'reverse', 'Play this clip backwards (⌥⌘R)', !!c.reversed) : null,
        isVideo && m.hasAudio && !c.detached ? b('Detach audio', 'detach-audio', 'Put the sound on its own clip (⌃⇧S)') : null,
        b(c.locked ? 'Unlock' : 'Lock', 'lock', 'Lock / unlock (⌘L)', !!c.locked),
        b(c.group ? 'Ungroup' : 'Group', c.group ? 'ungroup' : 'group', 'Group selected clips (⌥⌘G)', !!c.group)),
      el('div', { class: 'btn-row' },
        b('Copy style', 'copy-style', '⌥⌘C'), b('Paste style', 'paste-style', '⌥⌘V'), b('Paste properties', 'paste-properties', '⇧⌘V')),
      el('div', { class: 'row label-row' }, el('label', { text: 'Label' }),
        ...LABELS.map(([k, t]) => el('button', { class: `swatch lb-${k || 'none'}${(c.label || '') === k ? ' on' : ''}`, title: `${t} label`, 'aria-label': `${t} label`, onclick: () => app.cmd('label-' + (k || 'none')) }))),
      el('div', { class: 'btn-row' }, b('+ Clip marker', 'clip-marker', 'A marker that moves with this clip (⇧M)'), b('Rename', 'rename-clip', 'Give this clip its own name on the timeline'))));
  }

  actionsPanel(c) {
    const app = this.app;
    // 🎯 zoom moves first: where each push-in goes, one click from seeing and changing it on the picture
    if (c.type === 'media') {
      const moves = zoomMoves(c);
      const dir = mv => {
        // where the middle of the screen goes on the picture (a push-in to the top right: ↗)
        const a = shotOf(mv.from), b = shotOf(mv.to), ds = (mv.to.scale ?? 1) - (mv.from.scale ?? 1), dx = b.fx - a.fx, dy = b.fy - a.fy;
        const arrow = Math.hypot(dx, dy) < 0.02 ? '' : ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'][Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360 / 45) % 8];
        return `${ds > 0.02 ? 'zoom in' : ds < -0.02 ? 'zoom out' : 'pan'} ${arrow} ${Math.round((mv.to.scale ?? 1) * 100)}%`;
      };
      this.root.append(section('🎯 Zoom moves',
        el('p', { class: 'note', text: moves.length ? `${moves.length} zoom move${moves.length === 1 ? '' : 's'} (Auto Edit’s push-ins, or yours). See where each one goes on the whole picture, and drag it where you want it.` : 'No zoom moves yet. Add one at the playhead and drag it where you want the picture to go.' }),
        el('button', { class: 'tool hw amber zm-open', text: moves.length ? '🎯 SHOW AND EDIT ON THE PICTURE' : '🎯 ADD A ZOOM MOVE', onclick: () => app.zoomMovesEdit(c.id) }),
        moves.length ? el('div', { class: 'action-list zm-list' }, ...moves.map((mv, i) => el('div', { class: 'act-item', title: 'Show it on the picture', onclick: () => app.zoomMovesEdit(c.id, mv.a.id) },
          el('span', { text: `${i + 1}  ${fmtTime(c.start + mv.a.t).replace(/(\.\d)\d*$/, '$1')}  ${dir(mv)}` })))) : null));
    }
    const list = el('div', { class: 'action-list' });
    for (const a of [...(c.actions || [])].sort((x, y) => x.t - y.t)) {
      const keys = Object.keys(a.props || {}).filter(k => ANIMATABLE.includes(k));
      list.append(el('div', { class: 'act-item' + (app.selection.action === a.id ? ' selected' : ''), onclick: () => { app.select([c.id], a.id); app.seek(c.start + a.t + a.dur); } },
        el('span', { text: `${fmtTime(c.start + a.t)}  ${a.dur.toFixed(1)}s  ${keys.join(', ') || '—'}` }),
        el('button', { class: 'mini', text: '×', title: 'Remove action', onclick: ev => { ev.stopPropagation(); this.edit(() => { c.actions = c.actions.filter(x => x !== a); }); if (app.selection.action === a.id) app.select([c.id], null); } })));
    }
    const sec = section('Actions (zoom & pan)',
      el('p', { class: 'note', text: 'An action animates position, scale, crop or opacity from what came before to new values. Add one, then move or resize the clip in the preview.' }),
      list,
      el('div', { class: 'btn-row' }, el('button', { class: 'tool', text: '+ Action at playhead', onclick: () => app.cmd('insert-action') }), el('button', { class: 'tool', text: '+ Snapback', title: 'Return to how it was before the last action (⇧⌘K)', onclick: () => app.cmd('snapback') })));
    const act = app.selection.action ? c.actions.find(a => a.id === app.selection.action) : null;
    void act; // its length and feel are in the bar under the header
    this.root.append(sec);
  }

  audioPanel(c, m) {
    const a = c.audio;
    this.root.append(section('Audio',
      this.ksl(c, 'audio.volume', 'Volume', { min: 0, max: 2, step: 0.01, fmt: v => (v <= 0 ? '-∞' : (20 * Math.log10(v)).toFixed(1)) + ' dB' }),
      this.ksl(c, 'audio.pan', 'Pan', { min: -1, max: 1, step: 0.01, fmt: v => (Math.abs(v) < 0.01 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100)) }),
      this.sl('Fade in', () => a.fadeIn, v => { a.fadeIn = v; }, { min: 0, max: Math.min(10, c.duration / 2), step: 0.05, fmt: v => v.toFixed(2) + 's' }),
      this.sl('Fade out', () => a.fadeOut, v => { a.fadeOut = v; }, { min: 0, max: Math.min(10, c.duration / 2), step: 0.05, fmt: v => v.toFixed(2) + 's' }),
      ...(a.fadeIn > 0 || a.fadeOut > 0 ? [
        this.sl('Fade in curve', () => a.fadeInCurve || 0, v => { a.fadeInCurve = v; }, { min: -1, max: 1, step: 0.05, fmt: curveName }),
        this.sl('Fade out curve', () => a.fadeOutCurve || 0, v => { a.fadeOutCurve = v; }, { min: -1, max: 1, step: 0.05, fmt: curveName })] : []),
      checkRow('Mute', a.mute, v => this.edit(() => { a.mute = v; })),
      checkRow('Voice', a.voice, v => this.edit(() => { a.voice = v; })),
      this.sl('Duck under voice', () => a.duck || 0, v => { a.duck = v; }, { min: 0, max: 0.95, step: 0.01, fmt: v => (v * 100).toFixed(0) + '%' }),
      (() => { const tr = this.doc.tracks.find(t => t.id === c.track); return checkRow(`Auto Level (on track “${tr?.name || 'track'}”)`, this.app.autoLevelOn(tr), v => this.app.toggleAutoLevel(tr, v)); })(),
      (() => { const tr = this.doc.tracks.find(t => t.id === c.track); return el('div', { class: 'row' }, el('label', { text: 'Track is' }), roleButton(this.app, tr), el('button', { class: 'tool', text: '⚖ AUTO MIX…', title: 'Set dialogue, music and sound effects against each other', onclick: () => this.app.cmd('auto-mix') })); })(),
      el('p', { class: 'note', text: 'Mark narration as Voice; music with "Duck under voice" gets quieter while someone talks.' }),
      el('div', { class: 'btn-row' }, el('button', { class: 'tool plug-btn', text: '+ PLUG-IN', title: 'Run one of your installed plug-ins on this clip (Waves, iZotope, FabFilter, CEDAR… their Audio Unit versions). It opens in its own window; the FX tab lists the clip’s effects.', onclick: async () => { const it = await addPluginToClip(this.app, c); if (it) { this.tab = 'fx'; this.render(); } } }), el('button', { class: 'tool', text: c.spectral ? `SPECTRAL… (${c.spectral.edits?.length || 0})` : 'SPECTRAL…', title: 'Spectral editor (⌥⌘S): see the sound as a spectrogram and paint out coughs, clicks, hum and noises', onclick: () => this.app.cmd('spectral') })),
    ));
    this.root.append(effectsSection(this.app, c, this));
    void m;
  }

  cursorPanel(c) {
    const app = this.app, m = mediaById(this.doc, c.media);
    const cur = c.cursor;
    const hasClicks = !!m?.cursorClicks, hasKeys = !!m?.cursorKeys;
    const sec = section('Pointer & clicks');
    sec.append(pointerFinder(app, m, !!cur));
    if (!cur) {
      sec.append(el('p', { class: 'note', text: m.cursorFound === 'video' ? (m.cursorClicks ? 'Reel found the pointer in this video and kept the clicks you recorded. ' : 'Reel found the pointer in this video. ') + 'Highlight it, or zoom in automatically where it settles.' : 'This recording has a pointer track. Highlight it, add click effects and click sounds, or zoom in automatically where it settles.' }),
        el('div', { class: 'btn-row' }, el('button', { class: 'tool', text: 'Pointer effects', onclick: () => this.edit(() => { c.cursor = { show: true, highlight: true, highlightColor: '#ffd60a', highlightSize: 70, clickStyle: 'rings', smooth: 0.2 }; }) })));
    } else {
      if (m.pointerSeparate) sec.append(
        selectRow('Pointer', cur.pointer || 'arrow', [['arrow', 'Arrow'], ['dot', 'Dot'], ['hidden', 'Hidden']], v => this.edit(() => { cur.pointer = v; })),
        this.sl('Pointer size', () => cur.scale || 1, v => { cur.scale = v; }, { min: 0.5, max: 4, step: 0.05, fmt: v => Math.round(v * 100) + '%' }));
      sec.append(
        checkRow('Highlight', cur.highlight, v => this.edit(() => { cur.highlight = v; })),
        colorRow('Color', cur.highlightColor, v => this.edit(() => { cur.highlightColor = v; })),
        this.sl('Size', () => cur.highlightSize || 60, v => { cur.highlightSize = v; }, { min: 20, max: 200, step: 1, fmt: v => v.toFixed(0) }),
        this.sl('Smoothing', () => cur.smooth || 0, v => { cur.smooth = v; }, { min: 0, max: 0.8, step: 0.01, fmt: v => v.toFixed(2) + 's' }));
      // spotlight and magnifier follow the pointer (no recorded clicks needed)
      sec.append(...[
        selectRow('Spotlight', cur.spotlight ? 'on' : 'off', [['off', 'Off'], ['on', 'Dim around the pointer']], v => this.edit(() => { cur.spotlight = v === 'on'; })),
        cur.spotlight ? this.sl('Spotlight size', () => cur.spotSize || 220, v => { cur.spotSize = v; }, { min: 80, max: 600, step: 5, fmt: v => v.toFixed(0) }) : null,
        cur.spotlight ? this.sl('Dim', () => cur.spotDim ?? 0.6, v => { cur.spotDim = v; }, { min: 0.1, max: 0.9, step: 0.01, fmt: v => Math.round(v * 100) + '%' }) : null,
        selectRow('Magnifier', cur.magnify ? 'on' : 'off', [['off', 'Off'], ['on', 'Lens follows the pointer']], v => this.edit(() => { cur.magnify = v === 'on'; })),
        cur.magnify ? this.sl('Lens size', () => cur.lensSize || 130, v => { cur.lensSize = v; }, { min: 50, max: 400, step: 5, fmt: v => v.toFixed(0) }) : null,
        cur.magnify ? this.sl('Lens zoom', () => cur.lensZoom || 2, v => { cur.lensZoom = v; }, { min: 1.3, max: 4, step: 0.1, fmt: v => v.toFixed(1) + '×' }) : null,
      ].filter(Boolean));
      if (hasClicks) sec.append(
        selectRow('Click effect', cur.clickStyle || (cur.clickRings === false ? 'none' : 'rings'), [['none', 'None'], ['rings', 'Ring'], ['ripple', 'Ripple'], ['dot', 'Dot']], v => this.edit(() => { cur.clickStyle = v; })),
        colorRow('Click color', cur.clickColor || cur.highlightColor || '#ffd60a', v => this.edit(() => { cur.clickColor = v; })),
        this.sl('Click sound', () => cur.clickSound || 0, v => { cur.clickSound = v; }, { min: 0, max: 1.5, step: 0.01, fmt: v => (v <= 0 ? 'Off' : Math.round(v * 100) + '%') }));
      else sec.append(el('p', { class: 'note', text: 'Click effects and click sounds need “Record clicks” turned on when you record.' }));
      sec.append(el('div', { class: 'btn-row' }, el('button', { class: 'tool', text: 'Remove effects', onclick: () => this.edit(() => { c.cursor = m.pointerSeparate ? { show: true, pointer: 'arrow', scale: 1, clickStyle: 'none' } : null; }) })));
    }
    sec.append(el('div', { class: 'btn-row' }, el('button', { class: 'tool', text: 'Auto zoom this clip', onclick: () => app.cmd('auto-zoom') })));
    this.root.append(sec);
    if (hasKeys) this.keystrokePanel(c);
  }

  keystrokePanel(c) {
    const k = c.keystrokes || { show: false };
    const set = fn => this.edit(() => { c.keystrokes = { ...k }; fn(c.keystrokes); });
    const sec = section('Keystrokes', checkRow('Show keystrokes', k.show, v => set(x => { x.show = v; })));
    if (k.show) {
      c.keystrokes = k;
      sec.append(
        checkRow('Only shortcuts', k.modsOnly, v => set(x => { x.modsOnly = v; })),
        selectRow('Position', k.pos || 'bottom', [['bottom', 'Bottom'], ['top', 'Top']], v => set(x => { x.pos = v; })),
        this.sl('Text size', () => k.size || 46, v => { k.size = v; }, { min: 20, max: 120, step: 1, fmt: v => v.toFixed(0) }),
        this.sl('Visible for', () => k.hold || 1.5, v => { k.hold = v; }, { min: 0.5, max: 5, step: 0.1, fmt: v => v.toFixed(1) + 's' }),
        colorRow('Text color', k.color || '#ffffff', v => set(x => { x.color = v; })),
        colorRow('Background', k.bg || '#000000', v => set(x => { x.bg = v; })),
        this.sl('Background opacity', () => k.bgOpacity ?? 0.72, v => { k.bgOpacity = v; }, { min: 0, max: 1, step: 0.01, fmt: v => Math.round(v * 100) + '%' }),
        this.sl('Corner round', () => k.radius ?? 0.3, v => { k.radius = v; }, { min: 0, max: 0.5, step: 0.01, fmt: v => Math.round(v * 200) + '%' }),
        this.sl('Outline', () => k.outline || 0, v => { k.outline = v; }, { min: 0, max: 8, step: 0.5, fmt: v => v.toFixed(1) }),
        colorRow('Outline color', k.outlineColor || '#ffffff', v => set(x => { x.outlineColor = v; })));
    }
    this.root.append(sec);
  }

  /**
   * The clip panel, laid out like ScreenFlow's Clip Inspector: Duration, Speed (a slider and a typed %, with
   * presets), Keep pitch, Source Duration, Play in reverse and Locked. Changing speed plays the same source
   * faster or slower; ⌘-drag a clip's edge on the timeline does the same by eye.
   */
  speedPanel(c, m) {
    const sp = c.speed || 1, srcDur = c.duration * sp;
    // the slider is logarithmic: fine control around 100 %, still reaching 5 % and 2000 %
    const toPos = v => Math.round((Math.log(v / SPEED_MIN) / Math.log(SPEED_MAX / SPEED_MIN)) * 1000);
    const fromPos = p => SPEED_MIN * (SPEED_MAX / SPEED_MIN) ** (p / 1000);
    const set = v => this.edit(() => { setSpeed(this.app.doc, c, v); });
    const dur = el('input', { type: 'text', class: 'speed-dur', value: c.duration.toFixed(2), title: 'Length on the timeline: type a length and the speed changes to fit it' });
    dur.addEventListener('change', () => { const v = parseFloat(dur.value); if (v > 0) set(srcDur / v); else dur.value = c.duration.toFixed(2); });
    const pct = el('input', { type: 'number', class: 'speed-pct', min: SPEED_MIN * 100, max: SPEED_MAX * 100, step: 'any', value: +(sp * 100).toFixed(2), title: 'Speed in % (100 = normal)' });
    pct.addEventListener('change', () => { const v = Number(pct.value); if (v > 0) set(v / 100); });
    const slide = el('input', { type: 'range', class: 'speed-slider', min: 0, max: 1000, step: 1, value: toPos(sp), title: 'Speed (double-click: normal)' });
    slide.addEventListener('input', () => { const v = fromPos(Number(slide.value)); pct.value = (v * 100).toFixed(2); dur.value = (srcDur / v).toFixed(2); });
    slide.addEventListener('change', () => set(fromPos(Number(slide.value))));
    slide.addEventListener('dblclick', () => set(1));
    const chips = el('div', { class: 'speed-chips' }, ...[0.25, 0.5, 1, 1.5, 2, 4, 8].map(v => {
      const b = el('button', { class: 'mini' + (Math.abs(sp - v) < 1e-3 ? ' lit' : ''), text: v === 1 ? '1×' : `${v}×`, title: v === 1 ? 'Normal speed' : `${v * 100}%` });
      b.addEventListener('click', () => set(v)); return b;
    }));
    const kids = [
      el('div', { class: 'row speed-row' }, el('label', { text: 'Duration' }), dur, el('span', { class: 'unit', text: 'secs' })),
      el('div', { class: 'row speed-row' }, el('label', { text: 'Speed' }), slide, pct, el('span', { class: 'unit', text: '%' })),
      chips,
    ];
    if (m.kind === 'audio' || m.hasAudio) kids.push(checkRow('Keep pitch when sped up or slowed', c.audio?.keepPitch !== false, v => this.edit(() => { c.audio.keepPitch = v; })));
    kids.push(el('p', { class: 'note', text: `Source duration: ${srcDur.toFixed(2)} s` }));
    kids.push(checkRow('Play clip in reverse', !!c.reversed, () => this.app.cmd('reverse')));
    kids.push(checkRow('Locked', !!c.locked, () => this.app.cmd('lock')));
    return el('div', { class: 'speed-panel' }, ...kids);
  }

  textPanel(c) {
    const tx = c.text;
    const area = el('textarea', { class: 'big', value: tx.content, spellcheck: true });
    let started = false;
    area.addEventListener('input', () => { if (!started) { started = true; this.app.beginChange(); } tx.content = area.value; this.app.changed({ light: true, keepInspector: true }); });
    area.addEventListener('change', () => { started = false; this.app.endChange({ keepInspector: true }); });
    this.textArea = area;
    this.root.append(section('Text', lookRow(this.app, tx), withKeys(area),
      selectRow('Font', tx.font, FONTS.map(f => [f, f]), v => this.edit(() => { tx.font = v; })),
      selectRow('Weight', tx.weight, [[300, 'Light'], [400, 'Regular'], [600, 'Semibold'], [700, 'Bold'], [800, 'Heavy'], [900, 'Black']], v => this.edit(() => { tx.weight = Number(v); })),
      checkRow('Italic', tx.italic, v => this.edit(() => { tx.italic = v; })),
      this.ksl(c, 'text.size', 'Size', { min: 12, max: 400, step: 1, fmt: v => v.toFixed(0) }),
      colorRow('Color', tx.color, v => this.edit(() => { tx.color = v; })),
      el('p', { class: 'note', text: 'Accent a word: put it between stars, like *this*. It takes the accent look below.' }),
      selectRow('Accent look', tx.accent || 'color', TEXT_ACCENTS, v => this.edit(() => { tx.accent = v; })),
      colorRow('Accent color', tx.accentColor || '#ff2d3c', v => this.edit(() => { tx.accentColor = v; })),
      ['karaoke', 'oneWord'].includes(tx.anim) ? colorRow('Word being said', tx.hiColor || tx.accentColor || '#ff2d3c', v => this.edit(() => { tx.hiColor = v; })) : null,
      selectRow('Align', tx.align, [['left', 'Left'], ['center', 'Center'], ['right', 'Right']], v => this.edit(() => { tx.align = v; })),
      this.sl('Wrap width', () => tx.width, v => { tx.width = v; }, { min: 0.1, max: 1, step: 0.01, fmt: v => (v * 100).toFixed(0) + '%' }),
      colorRow('Box', tx.bg, v => this.edit(() => { tx.bg = v; })),
      this.ksl(c, 'text.bgOpacity', 'Box opacity', { min: 0, max: 1, step: 0.01, fmt: v => (v * 100).toFixed(0) + '%' }),
      this.sl('Outline', () => tx.stroke, v => { tx.stroke = v; }, { min: 0, max: 20, step: 0.5, fmt: v => v.toFixed(1) }),
      colorRow('Outline color', tx.strokeColor, v => this.edit(() => { tx.strokeColor = v; })),
      this.sl('Shadow', () => tx.shadow, v => { tx.shadow = v; }, { min: 0, max: 60, step: 1, fmt: v => v.toFixed(0) }),
      selectRow('Animation', tx.anim, TEXT_ANIMS, v => this.edit(() => { tx.anim = v; })),
      this.sl('Animation length', () => tx.animDur ?? 0.4, v => { tx.animDur = v; }, { min: 0.1, max: 2, step: 0.05, fmt: v => v.toFixed(2) + 's' }),
      styleRow(this.app, c),
    ));
  }

  calloutPanel(c) {
    const co = c.callout;
    this.root.append(section('Callout',
      el('p', { class: 'note', text: 'Darkens, blurs or magnifies everything on the tracks below except the focus area. Drag the box in the preview. ◆ sets a keyframe at the playhead: add two at different times and the callout moves between them.' }),
      selectRow('Shape', co.shape, [['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['freehand', 'Freehand']], v => { this.edit(() => { co.shape = v; }); if (v === 'freehand' && !(co.path && co.path.length > 2)) this.app.overlay.drawFreehand(c); }),
      co.shape === 'freehand' ? el('div', { class: 'btn-row' }, el('button', { class: 'tool', text: co.path?.length > 2 ? 'Redraw shape' : 'Draw shape', title: 'Draw around what matters, right on the preview', onclick: () => this.app.overlay.drawFreehand(c) })) : null,
      co.shape === 'freehand' ? checkRow('Sharp corners', !!co.sharp, v => this.edit(() => { co.sharp = v; })) : null,
      el('p', { class: 'note', text: co.shape === 'freehand' ? 'Drag any point of the shape on the picture. Double-click a point to take it out, the outline to add one.' : 'Drag a corner or side on the picture to size it (⇧ from the centre), or inside it to move it. For a shape of your own, choose Freehand.' }),
      checkRow('Follow pointer', co.follow, v => this.edit(() => { co.follow = v; })),
      this.sl('Build in', () => co.buildIn ?? 0.3, v => { co.buildIn = v; }, { min: 0, max: 3, step: 0.05, fmt: v => v.toFixed(2) + 's' }),
      this.sl('Build out', () => co.buildOut ?? 0.3, v => { co.buildOut = v; }, { min: 0, max: 3, step: 0.05, fmt: v => v.toFixed(2) + 's' }),
      this.ksl(c, 'callout.x', 'Center X', { min: 0, max: 1, step: 0.001, fmt: v => (v * 100).toFixed(0) + '%' }),
      this.ksl(c, 'callout.y', 'Center Y', { min: 0, max: 1, step: 0.001, fmt: v => (v * 100).toFixed(0) + '%' }),
      this.ksl(c, 'callout.w', 'Width', { min: 0.02, max: 1, step: 0.001, fmt: v => (v * 100).toFixed(0) + '%' }),
      this.ksl(c, 'callout.h', 'Height', { min: 0.02, max: 1, step: 0.001, fmt: v => (v * 100).toFixed(0) + '%' }),
      this.ksl(c, 'callout.radius', 'Corners', { min: 0, max: 0.2, step: 0.001, fmt: v => (v * 100).toFixed(1) }),
      this.ksl(c, 'callout.feather', 'Feather', { min: 0, max: 0.2, step: 0.001, fmt: v => (v * 100).toFixed(1) }),
      this.ksl(c, 'callout.dim', 'Dim outside', { min: 0, max: 0.95, step: 0.01, fmt: v => (v * 100).toFixed(0) + '%' }),
      this.ksl(c, 'callout.blur', 'Blur outside', { min: 0, max: 40, step: 0.5, fmt: v => v.toFixed(1) }),
      this.ksl(c, 'callout.zoom', 'Magnify', { min: 1, max: 10, step: 0.05, fmt: v => v.toFixed(2) + '×' }),
      this.ksl(c, 'callout.outline', 'Outline', { min: 0, max: 16, step: 0.5, fmt: v => v.toFixed(1) }),
      colorRow('Outline color', co.outlineColor, v => this.edit(() => { co.outlineColor = v; })),
    ));
  }

  shapePanel(c) {
    const s = c.shape;
    const fill = s.fillColor || (s.fill ? s.color : '');
    const boxy = !['arrow', 'line'].includes(s.shape);
    this.root.append(section('Shape',
      selectRow('Type', s.shape, [['arrow', 'Arrow'], ['line', 'Line'], ['rect', 'Rectangle'], ['roundrect', 'Rounded rectangle'], ['ellipse', 'Oval'], ['star', 'Star'], ['polygon', 'Polygon'], ['speech', 'Speech bubble'], ['thought', 'Thought bubble']], v => this.edit(() => { s.shape = v; })),
      s.shape === 'star' ? this.sl('Points', () => s.points || 5, v => { s.points = Math.round(v); }, { min: 3, max: 12, step: 1, fmt: v => v.toFixed(0), def: 5 }) : null,
      s.shape === 'polygon' ? this.sl('Sides', () => s.sides || 5, v => { s.sides = Math.round(v); }, { min: 3, max: 12, step: 1, fmt: v => v.toFixed(0), def: 5 }) : null,
      colorRow('Outline', s.color, v => this.edit(() => { s.color = v; })),
      this.ksl(c, 'shape.width', 'Thickness', { min: 2, max: 60, step: 1, fmt: v => v.toFixed(0) }),
      selectRow('Line', s.dash || 'solid', [['solid', 'Solid'], ['dash', 'Dashed'], ['dot', 'Dotted']], v => this.edit(() => { s.dash = v; })),
      boxy ? checkRow('Filled', !!fill, v => this.edit(() => { if (v) { s.fillColor = s.fillColor || s.color; s.fillOpacity = s.fillOpacity ?? 1; } else { s.fillColor = ''; s.fill = false; } })) : null,
      boxy && fill ? colorRow('Fill', fill, v => this.edit(() => { s.fillColor = v; s.fill = false; })) : null,
      boxy && fill ? this.sl('Fill opacity', () => s.fillOpacity ?? (s.fillColor ? 1 : 0.35), v => { s.fillOpacity = v; }, { min: 0.05, max: 1, step: 0.01, fmt: v => Math.round(v * 100) + '%' }) : null,
      el('p', { class: 'note', text: 'Drag it on the picture to move it, the round handles to reshape it. ✎ Markup (top right of the picture) sketches shapes and sets their line and colours, like Preview.' }),
    ));
  }
}

/** Video levels: the everyday picture controls, always at hand (the filter stack holds the rest). */
function levelsSection(insp, c) {
  const L = () => c.levels || {};
  const set = (k, v, def) => { c.levels = { ...(c.levels || {}), [k]: v }; if (Math.abs(v - def) < 1e-4) delete c.levels[k]; if (!Object.keys(c.levels).length) delete c.levels; };
  const pctS = v => (v > 0 ? '+' : '') + Math.round(v * 100);
  const sec = section('Video levels',
    insp.sl('Brightness', () => L().brightness ?? 0, v => set('brightness', v, 0), { min: -0.5, max: 0.5, step: 0.005, fmt: pctS }),
    insp.sl('Contrast', () => L().contrast ?? 0, v => set('contrast', v, 0), { min: -1, max: 1, step: 0.01, fmt: pctS }),
    insp.sl('Saturation', () => L().saturation ?? 0, v => set('saturation', v, 0), { min: -1, max: 1, step: 0.01, fmt: pctS }),
    insp.sl('Black level', () => L().black ?? 0, v => set('black', v, 0), { min: 0, max: 0.5, step: 0.002, fmt: v => Math.round(v * 255) }),
    insp.sl('Midtones (gamma)', () => L().gamma ?? 1, v => set('gamma', v, 1), { min: 0.3, max: 3, step: 0.01, fmt: v => v.toFixed(2) }),
    insp.sl('White level', () => L().white ?? 1, v => set('white', v, 1), { min: 0.5, max: 1, step: 0.002, fmt: v => Math.round(v * 255) }),
    insp.sl('Output black', () => L().outBlack ?? 0, v => set('outBlack', v, 0), { min: 0, max: 0.5, step: 0.002, fmt: v => Math.round(v * 255) }),
    insp.sl('Output white', () => L().outWhite ?? 1, v => set('outWhite', v, 1), { min: 0.5, max: 1, step: 0.002, fmt: v => Math.round(v * 255) }),
    el('div', { class: 'btn-row' },
      el('button', { class: 'tool', text: 'Auto levels', title: 'Stretch the picture so its darkest part is black and its brightest white', onclick: () => autoLevels(insp, c) }),
      el('button', { class: 'tool', text: 'Brighter', onclick: () => insp.edit(() => { c.levels = { ...(c.levels || {}), gamma: 1.25, brightness: 0.03 }; }) }),
      el('button', { class: 'tool', text: 'Reset', onclick: () => insp.edit(() => { delete c.levels; }) })));
  return sec;
}
/** Measures the frame under the playhead and sets black / white points from it. */
async function autoLevels(insp, c) {
  const app = insp.app;
  try {
    const cv = await app.player.still(Math.max(c.start, Math.min(c.start + c.duration - 0.01, app.player.time)), 320, 180);
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data, h = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) h[Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])]++;
    const n = d.length / 4, at = q => { let s = 0; for (let i = 0; i < 256; i++) { s += h[i]; if (s >= n * q) return i; } return 255; };
    const lo = at(0.005) / 255, hi = Math.max(lo + 0.2, at(0.995) / 255);
    insp.edit(() => { c.levels = { ...(c.levels || {}), black: Math.min(0.4, lo), white: Math.max(0.6, hi) }; });
  } catch (e) { app.toast?.(e.message); }
}

/** Dynamic zoom, like Resolve's: START and END frames dragged in the preview, and the ease between them. */
function dynZoomSection(app, insp, c) {
  const sec = section('Dynamic zoom');
  const framing = app.dzEdit === c.id;
  if (!hasDynZoom(c)) {
    sec.append(el('p', { class: 'note', text: 'Zoom and pan across the clip: drag a START and an END frame over the picture and it moves from one to the other.' }),
      el('div', { class: 'btn-row' }, el('button', { class: 'tool dz-btn', text: '🔍 DYNAMIC ZOOM', title: 'Add a START and END frame to drag in the preview', onclick: () => app.cmd('dynamic-zoom') })));
    return sec;
  }
  const dz = getDynZoom(c);
  const ease = el('select', { title: 'How it moves from START to END' }, ...DZ_EASES.map(([v, t]) => el('option', { value: v, text: t, selected: dz.ease === v })));
  ease.addEventListener('change', () => insp.edit(() => setDynZoomEase(c, ease.value)));
  const pct = f => Math.round(100 / f.s) + '%';
  const at = () => clamp(app.player.time - c.start, 0, c.duration);
  const back = hasZoomBackOut(c);
  sec.append(
    el('p', { class: 'note', text: `${pct(dz.start)} → ${pct(dz.end)}, from ${fmtTime(c.start + dz.t0)} to ${fmtTime(c.start + dz.t1)} (${(dz.t1 - dz.t0).toFixed(1)} s)${back ? ', then back out' : ''}. ${framing ? 'Drag the green START and red END frames in the preview (a corner resizes, ⇧ from the centre).' : 'Move the playhead and set where it starts and ends, or drag its points on the Zoom lane under the track.'}` }),
    el('div', { class: 'btn-row dz-when' },
      el('button', { class: 'tool', text: '⇤ START AT PLAYHEAD', title: 'The zoom starts where the playhead is', onclick: () => insp.edit(() => setDynZoomTimes(c, at(), Math.max(dz.t1, at() + 0.1))) }),
      el('button', { class: 'tool', text: 'END AT PLAYHEAD ⇥', title: 'The zoom ends where the playhead is', onclick: () => insp.edit(() => setDynZoomTimes(c, Math.min(dz.t0, at() - 0.1), at())) }),
      el('button', { class: 'tool', text: 'WHOLE CLIP', title: 'Zoom over the whole clip', onclick: () => insp.edit(() => setDynZoomTimes(c, 0, c.duration)) }),
      el('button', { class: 'tool' + (back ? ' lit' : ''), text: back ? '↩ ZOOMS BACK OUT' : '↩ ZOOM BACK OUT', title: back ? 'It returns to the START framing after a second. Click to stay zoomed in instead' : 'After the zoom, hold a second, then go back to the START framing', onclick: () => insp.edit(() => { if (back) { for (const p of ['props.x', 'props.y', 'props.scale']) if (c.keys?.[p]) c.keys[p] = c.keys[p].slice(0, 2); } else if (!addZoomBackOut(c)) toast('No room after the zoom for it to go back out: end it earlier first.'); }) })),
    el('div', { class: 'row' }, el('label', { text: 'Ease' }), ease),
    el('div', { class: 'btn-row' },
      el('button', { class: 'tool dz-btn' + (framing ? ' lit' : ''), text: framing ? '✓ DONE' : '🔍 EDIT FRAMES', title: framing ? 'Finish framing (Esc)' : 'Show the START and END frames in the preview', onclick: () => app.cmd(framing ? 'dynamic-zoom-done' : 'dynamic-zoom') }),
      el('button', { class: 'tool', text: '⇄ SWAP', title: 'Zoom out instead of in: START becomes END', onclick: () => insp.edit(() => swapDynZoom(c)) }),
      el('button', { class: 'tool', text: 'REMOVE', title: 'Take the dynamic zoom off (the clip keeps its START framing)', onclick: () => { app.dzEdit = null; insp.edit(() => removeDynZoom(c)); app.player.queueDraw(); } })));
  return sec;
}

/** One-click moves for the clip, grouped; each makes ordinary keyframes you can adjust. */
function motionSection(insp, c) {
  const groups = {};
  for (const [id, p] of Object.entries(MOTION_PRESETS)) (groups[p.group] ||= []).push([id, p]);
  const sec = section('Motion presets');
  for (const [g, list] of Object.entries(groups)) {
    sec.append(el('div', { class: 'mp-group engr', text: g }),
      el('div', { class: 'btn-row mp-row' }, ...list.map(([id, p]) => el('button', { class: 'tool', text: p.name, title: `${p.name}: adds keyframes to this clip (replacing its position / scale / rotation / opacity keyframes)`, onclick: () => insp.edit(() => applyMotion(c, id)) }))));
  }
  sec.append(el('div', { class: 'btn-row' }, el('button', { class: 'tool', text: 'Remove motion', onclick: () => insp.edit(() => clearMotion(c)) })));
  return sec;
}

/** An element's look: which element, its words and colours, and how long it stays. */
function elementPanel(insp, c) {
  const e = c.element, def = ELEMENTS[e.kind] || { defaults: {} }, d = { ...def.defaults, ...e };
  const groups = {};
  for (const [k, x] of Object.entries(ELEMENTS)) (groups[x.group] ||= []).push([k, x.name]);
  const kind = el('select', {}, ...Object.entries(groups).map(([g, list]) => el('optgroup', { label: g }, ...list.map(([k, n]) => el('option', { value: k, text: n, selected: k === e.kind })))));
  kind.addEventListener('change', () => insp.edit(() => { c.element = { kind: kind.value }; c.name = ELEMENTS[kind.value].name; }));
  const txt = (key, label) => {
    const multi = key === 'text' && def.multiline; // a list: one item per line
    const i = multi ? el('textarea', { class: 'big', rows: 5, value: d[key] ?? '', title: 'One item per line' }) : el('input', { type: 'text', value: d[key] ?? '', ...(key === 'text' && e.kind === 'counter' ? { placeholder: 'e.g. 2.84K, 1.2M, $1,500, 98%', title: 'Type the number as you want it to end: 2.84K, 1.2M, $1,500, 98%, +312… It counts up to it.' } : {}) });
    // live: the picture follows each key you type (one undo step for the whole edit)
    let typing = false;
    i.addEventListener('input', () => {
      if (!typing) { typing = true; insp.app.beginChange(); }
      c.element = { ...c.element, [key]: i.value };
      insp.app.changed({ light: true, keepInspector: true });
    });
    i.addEventListener('change', () => { if (typing) { typing = false; insp.app.endChange({ keepInspector: true }); } });
    const words = !(key === 'text' && e.kind === 'counter'); // a number needs no caps or spelling
    return el('div', { class: 'row' + (words ? ' has-keys' : '') }, el('label', { text: label }), i, words ? textKeys(i) : null);
  };
  const usesText = 'text' in def.defaults && def.defaults.text !== '', usesSub = 'sub' in def.defaults && def.defaults.sub !== '';
  // picture slots (an end screen's boxes): your own thumbnail in each, with its own caption
  const app = insp.app;
  const setSlot = (key, id) => insp.edit(() => { c.element = { ...c.element, [key]: id || '' }; });
  const slotRow = sl => {
    const m = e[sl.key] && mediaById(app.doc, e[sl.key]);
    const thumb = el('div', { class: 'slot-thumb' + (m ? ' has' : ''), title: 'Drag a picture here from MEDIA, or click CHOOSE' }, m ? null : el('span', { text: 'drop a picture' }));
    if (m) thumb.style.backgroundImage = `url("app://reel/m/${app.token}/${encodeURIComponent(m.file)}")`;
    thumb.addEventListener('dragover', ev => { if ([...ev.dataTransfer.types].includes('application/x-reel-media')) { ev.preventDefault(); thumb.classList.add('drop'); } });
    thumb.addEventListener('dragleave', () => thumb.classList.remove('drop'));
    thumb.addEventListener('drop', ev => {
      ev.preventDefault(); thumb.classList.remove('drop');
      const mm = mediaById(app.doc, ev.dataTransfer.getData('application/x-reel-media'));
      if (mm?.kind === 'image') setSlot(sl.key, mm.id);
      else import('./ui.js').then(({ toast }) => toast('That isn’t a picture. For a video, put the playhead on a good frame and use File › Save Frame…, then drop that picture here.', 6000));
    });
    const choose = el('button', { class: 'tool', text: 'CHOOSE…', onclick: async ev => {
      const r = ev.currentTarget.getBoundingClientRect(); // before the await: the event's target is gone after it
      const { popMenu, toast } = await import('./ui.js');
      const pics = app.doc.media.filter(x => x.kind === 'image' && !x.hidden).reverse();
      popMenu(r.left, r.bottom + 4, [
        ...pics.slice(0, 30).map(x => [x.name, () => setSlot(sl.key, x.id)]),
        pics.length ? null : ['(no pictures in this project yet)', null],
        null,
        ['Add a picture from this Mac…', async () => {
          const had = new Set(app.doc.media.map(x => x.id));
          await app.cmd('import');
          const nw = app.doc.media.find(x => !had.has(x.id) && x.kind === 'image');
          if (nw) setSlot(sl.key, nw.id); else toast('Pick a picture (PNG, JPEG…) to put in the box.', 4000);
        }],
        ['Use a frame of the video: File › Save Frame…, then choose it here', null],
      ]);
    } });
    const clear = m ? el('button', { class: 'tool', text: 'CLEAR', onclick: () => setSlot(sl.key, '') }) : null;
    return el('div', { class: 'slot-row' },
      el('label', { text: sl.label }),
      el('div', { class: 'slot-body' }, thumb, el('div', { class: 'btn-row' }, choose, clear)),
      txt(sl.cap, 'Caption'));
  };
  return section('Element',
    el('div', { class: 'row' }, el('label', { text: 'Element' }), kind),
    usesText ? txt('text', e.kind === 'counter' ? 'Count to' : 'Text') : null,
    usesSub ? txt('sub', def.slots ? 'Box text (no picture)' : 'Second line') : null,
    ...(def.slots || []).map(slotRow),
    colorRow('Colour', d.color, v => insp.edit(() => { c.element = { ...c.element, color: v }; })),
    colorRow('Accent', d.accent, v => insp.edit(() => { c.element = { ...c.element, accent: v }; })),
    insp.sl('Length', () => c.duration, v => { c.duration = v; }, { min: 0.5, max: 20, step: 0.1, fmt: v => v.toFixed(1) + ' s' }));
}

// ---------------------------------------------------------------- quick push in / push out

/**
 * Quick push: a zoom in at the playhead, a hold and a zoom back out, in one click, toward the pointer when the
 * recording has one (else the middle). The one under the playhead (or selected) shows its zoom, how fast it goes
 * in, how long it holds and how fast it comes out, each changed for both halves at once. New ones use the last
 * settings.
 */
function pushSection(app, ins, c, m) {
  const local = clamp(app.player.time - c.start, 0, c.duration);
  const sel = app.selection.action ? pushOf(c, app.selection.action) : null;
  const p = sel || pushAt(c, local);
  const add = kind => {
    const v = pushPrefs(), local = clamp(app.player.time - c.start, 0, c.duration); // where the playhead is now
    // toward the pointer at the playhead, when there's one to follow
    let aim = null;
    const data = m?.cursor && app.player.cursors?.get?.(m.id);
    if (data && kind !== 'out') { const q = cursorAt(data, m.cursorOffset || 0, (c.in || 0) + local * (c.speed || 1), 0.3); if (q && q.x >= 0 && q.x <= 1 && q.y >= 0 && q.y <= 1) aim = { fx: q.x, fy: q.y }; }
    const ff = m ? frameFraction(app.doc.canvas, m, c.props.crop || [0, 0, 0, 0]) : { fw: 1, fh: 1 };
    let id = null;
    app.commit(() => { id = addPush(c, local, { kind, aim, ...ff, ...v }); });
    if (!id) { toast('Not enough of the clip left after the playhead for a push.'); return; }
    const first = c.actions.find(a => a.push === id);
    app.select([c.id], first.id);
  };
  const sec = section('🎯 Punch in & out',
    el('p', { class: 'note', text: p ? 'This punch in: how far in, how fast it goes in, how long it stays and how fast it comes back. Both halves change together; drag their bars on the timeline too.' : `Point the viewer at part of the screen: put the playhead where it should happen, then drag a box around what to show. It pushes in, holds and comes back out. Or punch in with one click${m?.cursor ? ', toward the pointer' : ', on the middle'}.` }),
    el('button', { class: 'tool hw amber punch-btn', text: '🎯 PUNCH IN ON AN AREA…', title: 'Drag a box on the preview around what to show: it pushes in on it at the playhead, holds and comes back out', onclick: () => app.cmd('punch-zoom') }),
    el('div', { class: 'btn-row push-row' },
      el('button', { class: 'tool', text: '⤢ Punch in & out', title: `Zoom in at the playhead${m?.cursor ? ' toward the pointer' : ''}, hold, and zoom back out`, onclick: () => add('inout') }),
      el('button', { class: 'tool', text: 'In', title: 'Zoom in at the playhead and stay in', onclick: () => add('in') }),
      el('button', { class: 'tool', text: 'Out', title: 'Zoom back out at the playhead (to how it was before the last push in)', onclick: () => add('out') })));
  if (p) {
    const id = (p.in || p.out).id;
    const set = (k, v) => { setPush(c, id, { [k]: v }); savePush({ ...pushOf(c, id) }); };
    if (p.in) sec.append(ins.sl('Zoom', () => p.zoom, v => set('zoom', v), { min: 1.1, max: 5, step: 0.05, fmt: v => Math.round(v * 100) + '%' }));
    if (p.in) sec.append(ins.sl('In speed', () => p.inDur, v => set('inDur', v), { min: 0.1, max: 3, step: 0.05, fmt: v => `${v.toFixed(2)} s` }));
    if (p.in && p.out) sec.append(ins.sl('Hold', () => p.hold, v => set('hold', v), { min: 0, max: Math.max(0.5, Math.min(30, c.duration - p.in.t - p.in.dur - 0.1)), step: 0.1, fmt: v => v.toFixed(1) + ' s' }));
    if (p.out) sec.append(ins.sl('Out speed', () => p.outDur, v => set('outDur', v), { min: 0.1, max: 3, step: 0.05, fmt: v => `${v.toFixed(2)} s` }));
    sec.append(selectRow('Feel', p.ease, [['ease', 'Smooth'], ['linear', 'Steady'], ['in', 'Slow start'], ['out', 'Slow finish']], v => app.commit(() => set('ease', v))),
      el('div', { class: 'btn-row' },
        p.in ? el('button', { class: 'tool', text: '🎯 Aim it', title: 'Show where it pushes in on the picture, and drag it there', onclick: () => app.zoomMovesEdit(c.id, p.in.id) }) : null,
        el('button', { class: 'tool', text: 'Remove', title: 'Take this push out (both halves)', onclick: () => { app.commit(() => removePush(c, id)); app.select([c.id], null); } })));
  }
  return sec;
}

/**
 * Which look a title has (a ready-made one, or one of yours), with ☆ to keep it in ★ FAVS and FIND to show it in
 * Presets; and SAVE AS MY LOOK to keep this title's exact style (colours, font, size…) to use again.
 */
function lookRow(app, tx) {
  const id = lookOf(tx), name = id ? lookName(id) : null;
  const row = el('div', { class: 'look-row' });
  const draw = () => {
    const on = id && isFav('title', id);
    row.replaceChildren(
      el('span', { class: 'lr-label', text: 'Look' }),
      el('span', { class: 'lr-name', text: name || 'Its own style', title: name ? `This title uses “${name}” (Presets › TITLES)` : 'Not one of the ready-made looks: save it as yours to use it again' }),
      id ? el('button', { class: 'lr-star' + (on ? ' on' : ''), type: 'button', text: on ? '★' : '☆', title: on ? `Take “${name}” out of your favorites` : `Keep “${name}” in your favorites (★ FAVS)`, onclick: () => { const now = toggleFav('title', id); toast(now ? `★ “${name}” is in your favorites (★ FAVS).` : `“${name}” taken out of your favorites.`, 2400); draw(); } }) : null,
      id ? el('button', { class: 'tool', type: 'button', text: 'Find it', title: 'Show it in Presets › TITLES', onclick: () => revealPreset(app, 'title', id) }) : null,
      el('button', { class: 'tool', type: 'button', text: 'Save as my look', title: 'Keep this title’s exact style (font, colours, size, animation) as your own look, in ★ FAVS and first on TITLES', onclick: async () => {
        const n = await promptText('Save as my look', 'A name for this look (its style is kept, not its words):', name ? `${name} (mine)` : 'My look', 'Save');
        if (n == null) return;
        const mine = saveMyLook(n.trim() || 'My look', tx);
        app.commit(() => { tx.look = mine; });
        toast(`★ “${n.trim() || 'My look'}” saved: in ★ FAVS, and first on TITLES.`, 3500);
      } }));
  };
  draw();
  return row;
}

/**
 * A recording whose pointer file can't place the pointer on the picture (a window recorded before Reel noted where
 * the window was): says so, and finds the pointer in the picture instead (by itself once pointer effects are on).
 * The work carries on while the inspector changes; whichever notice is showing follows it.
 */
function pointerFinder(app, m, effectsOn) {
  const box = el('div', { class: 'ptr-blind hidden', 'data-m': m.id });
  const jobs = (app._ptrJobs ||= new Map());
  const say = (text, busy) => { for (const b of document.querySelectorAll(`.ptr-blind[data-m="${m.id}"]`)) { b.classList.remove('hidden'); b.querySelector('.pb-text').textContent = text; b.querySelector('.pb-go').hidden = !!busy; } };
  const run = async () => {
    if (jobs.get(m.id)?.busy) return;
    jobs.set(m.id, { busy: true });
    say('Finding the pointer in the picture… 0%', true);
    const found = await app.findPointerFor(m, { onProgress: v => say(`Finding the pointer in the picture… ${Math.round(v * 100)}%`, true) }).catch(() => null);
    jobs.set(m.id, { busy: false, done: true, ok: !!found });
    if (found) { say('Found the pointer: the effects follow it now.', true); toast(`Found the pointer in “${m.name}”: the pointer effects follow it now.`, 4500); setTimeout(() => app.inspector?.render?.(), 400); }
    else say('Couldn’t find the Mac’s arrow pointer in this video (it may be hidden, or a different pointer). Pointer effects need to know where it is.', false);
  };
  box.append(el('span', { class: 'pb-text', text: 'This recording doesn’t know where its window was on the screen, so the pointer can’t be placed on the picture and pointer effects don’t show. Reel can find the pointer in the picture instead.' }),
    el('button', { class: 'tool hw amber pb-go', type: 'button', text: '🔎 Find the pointer in the picture', onclick: run }));
  (async () => {
    const data = m.cursor ? await app.api.readJson(app.token, m.cursor).catch(() => null) : null;
    if (!app.pointerBlind(m, data)) return;
    box.classList.remove('hidden');
    const j = jobs.get(m.id);
    if (j?.busy) say('Finding the pointer in the picture…', true);
    else if (effectsOn && !j?.done) run(); // effects are on: find it now, they're waiting for it
  })();
  return box;
}

// ---------------------------------------------------------------- callouts, ScreenFlow's way
const CALLOUT_STARTS = [
  ['cursor', '🖱', 'Mouse cursor', 'A spotlight that follows the pointer: everything else dims', { shape: 'ellipse', follow: true, w: 0.2, h: 0.3, dim: 0.6, feather: 0.05 }],
  ['area', '▭', 'Area', 'A box you drag and size on the picture: everything else dims', { shape: 'rect', w: 0.36, h: 0.3, dim: 0.6, radius: 0.015, feather: 0.01 }],
  ['freehand', '✎', 'Freehand', 'Draw around what matters, right on the picture', { shape: 'freehand', dim: 0.6, feather: 0.02 }],
  ['magnify', '🔍', 'Magnify', 'A box that magnifies what’s under it, with an outline: drag it where it’s needed', { shape: 'rect', w: 0.28, h: 0.24, dim: 0.35, zoom: 1.8, outline: 3, radius: 0.02 }],
];
/**
 * The Callout tab of a video or picture: one click puts a callout over it at the playhead (a spotlight on the
 * pointer, an area, one drawn by hand, or a magnifier), the way ScreenFlow's Callout tab does; the callouts already
 * over it are listed to pick.
 */
function calloutStarts(app, c, m) {
  const doc = app.doc;
  const over = doc.clips.filter(x => x.type === 'callout' && x.start < c.start + c.duration && x.start + x.duration > c.start);
  const add = ([kind, , name, , opts]) => {
    const t = clamp(app.player.time, c.start, c.start + c.duration);
    const k = newCalloutClip(null, t);
    k.duration = 4; // over whatever's below, past this clip's end too
    k.callout = { ...k.callout, ...opts };
    k.name = `Callout · ${name}`;
    app._insert(k);
    if (kind === 'freehand') app.overlay.drawFreehand(k);
    else {
      app.seek(t + (k.callout.buildIn ?? 0.3) + 0.05); // past its build-in: it shows at once
      toast(kind === 'cursor' ? 'Spotlight on the pointer. Its look is in the Callout tab; drag the clip’s ends on the timeline to set when.' : 'Drag the box on the picture to place it, its corners to size it. Its look is in the Callout tab.', 4500);
    }
    if (kind === 'cursor' && m && app.pointerBlind(m, app.player.cursors?.get?.(m.id))) toast('This recording can’t place its pointer yet: the Screen recording tab finds it in the picture.', 6000);
  };
  return section('Callout',
    el('p', { class: 'note', text: 'Draw attention to part of the picture: everything else dims (or blurs), and what you pick can be magnified. One click adds it at the playhead, over this clip.' }),
    el('div', { class: 'co-starts' }, ...CALLOUT_STARTS.map(st => el('button', { class: 'co-start', type: 'button', title: st[3], onclick: () => add(st) }, el('b', { text: st[1] }), el('span', { text: st[2] })))),
    over.length ? el('div', { class: 'action-list' }, ...over.map(x => el('div', { class: 'act-item', title: 'Select it', onclick: () => { app.select([x.id], null); app.seek(Math.max(x.start, Math.min(app.player.time, x.start + x.duration - 0.01))); } },
      el('span', { text: `${fmtTime(x.start).replace(/(\.\d)\d*$/, '$1')}  ${x.name || 'Callout'} · ${x.duration.toFixed(1)} s` })))) : null);
}
