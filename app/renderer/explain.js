// EXPLAIN mode: a latching button in the header. While it's lit, resting the pointer on any control
// shows a masking-tape card saying what it does (and its shortcut). Works for everything in the app:
// controls listed below get a fuller description; anything else uses its own tooltip text.
import { el } from './ui.js';

/** Fuller descriptions for the main controls: [name, what it does]. Keyed by CSS selector. */
const HELP = {
  '#btn-record': ['Record', 'Start a new recording: your screen or one window, your camera, your microphone, and the sound of your Mac or of single apps. With a project open, the new recording is added to it.'],
  '#btn-sound': ['Mixer', 'A channel strip for every timeline track (level, pan, mute, solo, EQ and effects), your microphone input, Reel’s monitor output, and a page for each Mac app’s sound.'],
  '#btn-spectral': ['Spectral', 'Opens the spectral editor on the selected clip’s sound: paint out noises, de-noise, de-click, de-ess, de-bark and repair.'],
  '#btn-proxy': ['Proxy editing', 'Big videos (4K, HEVC, ProRes) get a half-size copy in the background so playback and scrubbing stay smooth. The green lamp means proxies are on; amber means one is being made. Export and thumbnails always use the full-quality originals.'],
  '#home-new': ['New Document', 'Pick a size and frame rate (1080 vertical, 1080p, 4K, square…) or start from a TikTok, YouTube or Instagram template.'],
  '#btn-import': ['Add media', 'Bring in video, audio and pictures from your Mac. You can also drag files onto the media list or the timeline.'],
  '#btn-voices': ['Voices', 'Speech from text in natural voices (Kitten, on this Mac): 115 voices, emotion, laughs and sighs, and your own voice cloned from a clip to fix a line. The first time, press GET KITTEN VOICES.'],
  '#btn-aiimage': ['AI Image', 'Make a picture with ERNIE on this Mac (backgrounds, B-roll stills, title cards) and drop it into the edit.'],
  '#btn-thumb': ['Thumbnail', 'Thumbnail Studio: build a YouTube or social thumbnail from a frame of the video or an ERNIE picture, with title text and badges.'],
  '#btn-export': ['Export', 'Make the finished movie (H.264 or HEVC), or just the sound. Choose size, quality, the in/out range, captions and motion blur.'],
  '#btn-help': ['Help', 'A guided tour of how Reel works and its keyboard shortcuts.'],
  '#btn-explain': ['Explain', 'While this is lit, rest the pointer on anything to see what it does. Press it again (or ⌘/) to turn it off.'],
  '#header-lamps': ['Status lamps', 'POWER: the app is ready. REC: recording. ERNIE: making a picture. SAVED: the project is saved.'],
  '#doc-name': ['Project name', 'Click to rename the project. It saves on its own every minute and when you close it.'],
  '#lib-add': ['Add media', 'Bring in video, audio and pictures.'],
  '#library': ['Media', 'Everything in this project. Drag an item onto the timeline to use it; right-click for more.'],
  '#stage': ['Canvas', 'The picture as it will export. Click a clip to select it; drag to move it, drag the corners to resize.'],
  '#t-start': ['Go to start', 'Jump the playhead to the beginning (Home).'],
  '#t-back': ['Back one frame', 'Step back one frame (←). ⇧← steps back a second.'],
  '#t-play': ['Play / pause', 'Play from the playhead (Space). J and L jump 5 seconds, K stops.'],
  '#t-fwd': ['Forward one frame', 'Step forward one frame (→). ⇧→ steps a second.'],
  '#t-end': ['Go to end', 'Jump the playhead to the end (End).'],
  '#timecode': ['Playhead time', 'Where the playhead is. Switch to SMPTE frames in View › SMPTE Timecode.'],
  '#duration': ['Length', 'How long the whole project is.'],
  '.deck-reel-well': ['Tape reels', 'The supply reel (left) empties and the take-up reel (right) fills as the playhead moves through the project. They turn while it plays or you scrub.'],
  '.deck-meters': ['VU meters', 'Left and right levels of what you hear in the preview. The needle reaching the red zone means loud; keep speech around 0 VU.'],
  '.deck-speed': ['Tape speed', 'Preview speed like a tape deck: 3¾ = half speed, 7½ = normal, 15 = double. The export is always normal speed.'],
  '#preview-zoom': ['Preview size', 'Fit the canvas to the window, or view it at 50% / 100% to check detail.'],
  '#inspector': ['Inspector', 'Settings for whatever is selected: position, scale, filters, sound, text, callouts, keyframes. With nothing selected, project settings.'],
  '[data-cmd=split]': ['Splice', 'Cut the selected clips (or all clips) in two at the playhead, like a razor blade on tape (S).'],
  '[data-cmd=delete]': ['Delete', 'Remove the selected clips and leave a gap (⌫).'],
  '[data-cmd=ripple-delete]': ['Ripple delete', 'Remove the selected clips and slide everything after them left to close the gap (⇧⌫).'],
  '#btn-insert': ['Insert', 'Add text, titles, callouts, arrows and boxes, drawings, captions, speech from text, zoom & pan actions, snapbacks or markers at the playhead.'],
  '[data-cmd=zoom-max]': ['Max zoom in', 'Zooms the timeline all the way in around the playhead, so you can trim single frames. Click again to go back to where you were. FIT ALL is the opposite.'],
  '[data-cmd=voice-over]': ['Voice over', 'Record narration while the edit plays from the playhead; the take lands on a Voice-over track right where you said it. PUNCH IN re-records only between In (I) and Out (O), with a pre-roll so you can match your delivery, and crossfades the new piece in. Every take stays in the media list; ⌘Z brings the old one back.'],
  '[data-cmd=auto-zoom]': ['Smart Zoom', 'Spruces up any video: watches the picture and adds zoom-ins and pans where things move, jump zooms on cuts (Punchy) or slow Ken Burns pushes (Cinematic). Each zoom is an action you can adjust. It can also run by itself on every video you drop in.'],
  '#snap': ['Snap', 'Clips snap to other clips’ edges, markers and the playhead while you drag.'],
  '#scrub': ['Scrub audio', 'Hear short slices of sound while you drag the playhead.'],
  '[data-cmd=select-all]': ['Select all', 'Select every clip (⌘A). Drag one to move them all, or ⌥← ⌥→ to nudge.'],
  '[data-cmd=select-after]': ['Select from playhead', 'Select everything from the playhead on (⇧⌘A), to shift the rest of the edit.'],
  '[data-cmd=zoom-out]': ['Zoom out', 'Show more of the timeline (⌘−).'],
  '[data-cmd=zoom-in]': ['Zoom in', 'Show more detail on the timeline (⌘=).'],
  '#tl-zoom': ['Timeline zoom', 'Slide to zoom the timeline in and out.'],
  '[data-cmd=zoom-fit]': ['Fit all', 'Zoom all the way out so the whole project fits (⌘0).'],
  '#tl-ruler': ['Ruler', 'Click or drag to move the playhead. In and out points show as shading.'],
  '#playhead': ['Tape head', 'The playhead. Drag it to scrub; during playback, dragging keeps playing when you let go. Its lamp lights while the tape rolls.'],
  '.deck-index': ['Tape counter', 'A mechanical index counter: it rolls with the tape, one count per second. Press ZERO to set it to 0000 at the playhead, so you can measure from any point.'],
  '.dial': ['Knob', 'Drag up or down to turn (⇧ for fine), scroll, or double-click to reset.'],
  '.kf': ['Keyframe', 'A point where a setting changes. Drag to move it in time; right-click to delete or change easing.'],
  '.pbtn': null, // lit buttons use their own label/tooltip
};

const KEY_RE = /\s*\((⌃?⌥?⇧?⌘?[⌃⌥⇧⌘][^()]{1,4}|[⌃⌥⇧⌘]?[⌫←→]|Space|Home|End|[A-Z[\]])\)\s*$/;
const keyOf = text => { const m = KEY_RE.exec(text || ''); return m ? m[1] : ''; };
const strip = text => (text || '').replace(KEY_RE, '');

export class Explain {
  constructor(app) {
    this.app = app;
    this.on = false;
    this.card = el('div', { id: 'explain-card', class: 'hidden', role: 'tooltip' });
    document.body.append(this.card);
    this.btn = document.getElementById('btn-explain');
    this.btn?.addEventListener('click', () => this.toggle());
    this._over = e => this._show(e.target);
    this._out = e => { if (!e.relatedTarget || !this.card.contains(e.relatedTarget)) this._hideSoon(); };
    let saved = false; try { saved = localStorage.getItem('reel.explain') === '1'; } catch { /* fine */ }
    if (saved) this.toggle(true);
  }

  toggle(force) {
    this.on = typeof force === 'boolean' ? force : !this.on;
    document.body.classList.toggle('explaining', this.on);
    this.btn?.classList.toggle('lit', this.on);
    this.btn?.setAttribute('aria-pressed', String(this.on));
    try { localStorage.setItem('reel.explain', this.on ? '1' : '0'); } catch { /* fine */ }
    if (this.on) {
      document.addEventListener('mouseover', this._over, true);
      document.addEventListener('mouseout', this._out, true);
    } else {
      document.removeEventListener('mouseover', this._over, true);
      document.removeEventListener('mouseout', this._out, true);
      this.card.classList.add('hidden');
      // give native tooltips back
      for (const n of document.querySelectorAll('[data-tip-moved]')) { n.title = n.dataset.tip; delete n.dataset.tipMoved; }
    }
  }

  /** What to say about this element: [name, text, key] or null. */
  describe(node) {
    for (let n = node; n && n !== document.body; n = n.parentElement) {
      if (n === this.card) return null;
      for (const [sel, v] of Object.entries(HELP)) {
        if (v && n.matches?.(sel)) return [v[0], strip(v[1]), keyOf(v[1]) || keyOf(n.dataset.tip || n.title)];
      }
      // a label wrapping a checkbox explains the checkbox
      const inner = n.tagName === 'LABEL' && n.querySelector('input');
      if (inner && inner.id && HELP['#' + inner.id]) { const v = HELP['#' + inner.id]; return [v[0], v[1], '']; }
      if (n.title) { n.dataset.tip = n.title; n.dataset.tipMoved = '1'; n.removeAttribute('title'); }
      if (n.dataset?.tip || n.dataset?.help) {
        const t = n.dataset.help || n.dataset.tip;
        const name = (n.getAttribute('aria-label') || n.querySelector?.('.cap-text')?.textContent || (n.tagName === 'BUTTON' ? n.textContent : '') || '').trim().slice(0, 40);
        return [name, strip(t), keyOf(t)];
      }
      // a lit button with no tooltip: say which group it belongs to
      if (n.classList?.contains('pbtn')) {
        const g = n.closest('.bgroup')?.querySelector('.bg-title')?.textContent || n.closest('.module')?.querySelector('.mname')?.textContent || '';
        const name = n.querySelector('.cap-text')?.textContent || '';
        return [name, g ? `Choose ${name} for ${g.toLowerCase()}.` : 'Click to choose this setting.', ''];
      }
    }
    return null;
  }

  _show(target) {
    const d = this.describe(target);
    if (!d) { this._hideSoon(); return; }
    clearTimeout(this._hideT);
    const [name, text, key] = d;
    this.card.replaceChildren(
      el('div', { class: 'ex-head' }, el('span', { class: 'ex-name', text: name || 'Control' }), key ? el('span', { class: 'ex-key', text: key }) : null),
      el('div', { class: 'ex-text', text }));
    this.card.classList.remove('hidden');
    // place beside the control, kept on screen
    const host = target.closest('button, label, input, select, textarea, .dial, .kf, [data-tip], [data-help], section, aside, #stage') || target;
    const r = host.getBoundingClientRect(), c = this.card.getBoundingClientRect();
    let x = r.left + r.width / 2 - c.width / 2, y = r.bottom + 10;
    if (y + c.height > innerHeight - 8) y = r.top - c.height - 10;
    if (y < 8) y = Math.min(innerHeight - c.height - 8, r.top + 8);
    x = Math.max(8, Math.min(innerWidth - c.width - 8, x));
    this.card.style.left = x + 'px'; this.card.style.top = y + 'px';
  }
  _hideSoon() { clearTimeout(this._hideT); this._hideT = setTimeout(() => this.card.classList.add('hidden'), 120); }
}
