// ProtoArt Reel editor: project state, commands, keyboard, and wiring between the parts.
import { Explain } from './explain.js';
import { Deck, makeReel } from './deck.js';
import { el, $, toast, modal, ask, promptText, popMenu } from './ui.js';
import { installFaceplate, lamp, sevenSegment, screwCorners } from './gear.js';
import {
  History, timeFormat, withGroups, normalize, uid, duration, split, remove, newMediaClip, newTextClip, newCalloutClip, newShapeClip,
  freeTrack, addTrack, clipEnd, propsAt, ANIMATABLE, mediaById, fmtTime, isFree,
  setSpeed, SPEED_STEPS, SPEED_MIN, SPEED_MAX, putKey,
  mergeOverlapTracks, removeRange, applyTrackLocks, findGaps, closeGaps, smoothCuts, raisePip,
} from './model.js';
import { Player } from './player.js';
import { Timeline } from './timeline.js';
import { Inspector } from './inspector.js';
import { Library } from './library.js';
import { Overlay } from './overlay.js';
import { openRecorder } from './recorder.js';
import { openMusicFit } from './musicfit.js';
import { openGhost } from './ghost.js';
import { openExport } from './exporter.js';
import { openThumbnailStudio } from './thumbs.js';
import { openMatchColour } from './colormatch.js';
import { openImageGenerator } from './imagegen.js';
import * as ops from './clipops.js';
import * as textops from './textops.js';
import { openTitles } from './titles.js';
import { autoZoom, cursorAt } from './cursor.js';
import { FORMATS as VFORMATS, coverScale, reframeKeys } from './lib/reframe.js';
import { STYLES as ZOOM_STYLES, analyse as zoomAnalyse, plan as zoomPlan, frameFraction } from './autozoom.js';
import { LAPSE_PRESETS, plan as lapsePlan, apply as lapseApply, activityOf } from './timelapse.js';
import { showAbout } from './about.js';
import { openMixer } from './mixer.js';
import { bounceClips, bounceTrack, revertClips } from './bounce.js';
import { openWriter } from './writer.js';
import { runStabilize } from './filters.js';
import { openAutoMix, roleMenuItems, labelNudge, removeAutoMix, watchMixKey } from './automix.js';
import { initKeyPanel } from './keypanel.js';
import { describeChange, menuCase } from './lib/changes.js';
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
/** The REC key's face: the lamp, the word, and a small plate under it (shown when it's the big key in the panel). */
const recKey = (word, sub) => `<span class="dot"></span><span class="rk-word">${word}</span><span class="rk-sub">${sub}</span>`;
import { openMaster } from './master-ui.js';
import { openSettings } from './settings.js';
import { makeResizable } from './layout.js';
import { loadMachine } from './capability.js';
import { applyTheme, toggleTheme } from './theme.js';
import { pref, setPref } from './prefs.js';
import { autoCaptions, textEditor } from './transcript.js';
import { openPresetBrowser, autoTransitions, PACKS, speedJump, doFilmCut } from './fxlibrary.js';
import { openVoiceOver } from './voiceover.js';
import { openSpectral } from './spectral.js';
import { convertInEditor, conversionDialog } from './conform.js';
import { convertScreenflow, placeScreenflow } from './screenflow-import.js';
import { pluginEdited, shareDuplicateRenders } from './fx.js';
import { openNewDocument, applyStarter, STARTERS, starterThumb } from './presets.js';
import { ProxyQueue, proxyPrefs, setProxyPrefs, setProxyRam } from './proxies.js';
import { fitHeader } from './headerfit.js';
import { openAutoEdit, openClipAutoEdit } from './autoedit.js';
import { openClapFinder, clapsOnTimeline, addClapMarkers } from './clapscan.js';
import { initToolbarGroups } from './toolbar.js';
import { calloutsMenu, openCalloutPlanner } from './callouts.js';
import { openTakes, initTakesButton } from './takes.js';
import { loadShortcuts, handleShortcutKey } from './shortcuts.js';
import { syncTrackPlugins, watchLive } from './trackplugins.js';
import { openTransitions } from './transpicker.js';
import { initSimple, applyMode } from './simple.js';

const api = window.reel;

class App {
  constructor() {
    this.api = api;
    applyTheme();
    this.applyPrefs();
    screwCorners($('.brand-plate'), 7, 3);
    // home: a pair of reels on the hero plate, turning slowly (CSS animation; pauses when the editor opens)
    { const pair = el('div', { class: 'hero-reels' }); const a1 = makeReel(118), a2 = makeReel(118); a1.setFill(0.75); a2.setFill(0.3);
      // the tape leaves each pack at its outer edge, runs down round two guide rollers and past the
      // head block between them; it's drawn behind the reels so the flanges cover where it winds on
      const r1 = 59 * (0.3 + 0.62 * 0.75), r2 = 59 * (0.3 + 0.62 * 0.3), xL = 59 - r1, xR = 136 + 59 + r2, y = 150;
      const tape = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      tape.setAttribute('class', 'hero-tape'); tape.setAttribute('width', 254); tape.setAttribute('height', 166); tape.setAttribute('viewBox', '0 0 254 166');
      tape.innerHTML = `<path d="M${xL} 59 L${xL} ${y - 6} Q${xL} ${y} ${xL + 6} ${y} L${xR - 6} ${y} Q${xR} ${y} ${xR} ${y - 6} L${xR} 59" fill="none" stroke="#3a2618" stroke-width="2.4"/>
        <circle cx="${xL + 4}" cy="${y - 4}" r="5" class="hero-roller"/><circle cx="${xR - 4}" cy="${y - 4}" r="5" class="hero-roller"/>
        <rect x="111" y="${y - 9}" width="32" height="9" rx="2" class="hero-head"/>`;
      pair.append(tape, a1.svg, a2.svg); $('.hero-plate').append(pair); }
    this.lamps = {};
    for (const [k, c, label, on] of [['power', 'green', 'POWER', true], ['rec', 'red', 'REC', false], ['ernie', 'amber', 'ERNIE', false], ['saved', 'blue', 'SAVED', false]]) {
      const r = lamp(c, on, label);
      this.lamps[k] = r.lamp;
      $('#header-lamps').append(r);
    }
    this.lamps.rec.classList.add('blink');
    const segInto = (host, height, dim) => { let last = null; return t => { if (t === last) return; last = t; host.replaceChildren(sevenSegment(t, height, dim ? 'rgba(255,176,42,0.75)' : '#ffb02a')); }; };
    this.showTime = segInto($('#timecode'), 20);
    this.showDuration = segInto($('#duration'), 14, true);
    this.doc = null; this.token = null;
    this.history = new History();
    this.selection = { clips: [], action: null };
    this.dirty = false;
    this.previewZoom = 'fit';
    this.aiListeners = new Set();
    this.fxListeners = new Set();
    this.fxEditing = new Map(); // plug-in window slot -> { clip, item }
    this.player = new Player($('#preview'), this);
    this.proxies = new ProxyQueue(this);
    this.proxies.onChange(st => this._proxyLabel(st));
    this.timeline = new Timeline(this);
    this.inspector = new Inspector(this);
    this.library = new Library(this);
    this.deck = new Deck(this, $('#transport'));
    this.$playKey = $('#t-play');
    this.overlay = new Overlay(this);
    this.afterDraw = () => this.overlay.update();
    this.player.onTime(t => {
      if (!this.doc) return;
      this.showTime(fmtTime(t, this.doc?.canvas.fps || 30, true));
      $('#t-play .kl').textContent = this.player.playing ? '❚❚' : '▶';
      this.timeline.updatePlayhead(t);
      if (!this.player.playing) { this.overlay.update(); this.inspector.onTime(); }
    });
    api.onMenu(cmd => this.cmd(cmd));
    if (api.onOpenProject) api.onOpenProject(p => this.open(Promise.resolve(p)));
    api.onAi(ev => { for (const l of this.aiListeners) l(ev); });
    if (api.onFxProgress) api.onFxProgress(p => { for (const l of this.fxListeners) l(p); });
    if (api.onFxEdited) api.onFxEdited(m => pluginEdited(this, m));
    this._wire();
    new ResizeObserver(() => this.player.resize()).observe($('#stage'));
    makeResizable(() => this.player.resize());
    // 🎵 REMIX (next to SNAP): a music clip's end re-fits the song seamlessly, or trims as normal when off
    document.getElementById('remix')?.addEventListener('change', e => {
      setPref('remix', e.target.checked);
      this.timeline?.render();
      toast(e.target.checked ? '🎵 REMIX on: drag the ♪ end of a music clip to make the song longer or shorter, seamlessly.' : 'REMIX off: the end of a music clip trims it as normal.', 3500);
    });
    document.getElementById('auto-gaps')?.addEventListener('change', e => {
      setPref('autoCloseGaps', e.target.checked);
      toast(e.target.checked ? 'Auto close gaps on: deleting a clip also closes the space it leaves (like RIPPLE). CLOSE GAPS (⌥⌫) clears the gaps already there.' : 'Auto close gaps off: Delete leaves the space (⇧⌫ still ripples).', 5000);
    });
    initKeyPanel(this); watchMixKey(this); // before the top bar fits: the studio keys move into the side panel while editing
    fitHeader();
    initSimple(this);
    watchLive(this); // track plug-ins heard live while their window is open
    loadMachine(api).then(m => setProxyRam(m?.ram)).catch(() => {});
    this.showHome().then(async () => {
      // Settings › General › At launch: straight back into the last project
      if (pref('reopenLast') === true) { const r = (await api.recent().catch(() => []))[0]; if (r && !this.doc) this.open(api.openRecent(r.key)); }
    });
    // Settings › General › Save automatically
    this._lastSave = Date.now();
    setInterval(() => { const n = Number(pref('autosave')) || 0; if (n && this.doc && this.dirty && Date.now() - this._lastSave > n * 60000 && !this.player.playing) { this._lastSave = Date.now(); this.save(); } }, 15000);
  }

  // ---------------------------------------------------------------- views & projects
  async showHome() {
    this.proxies.cancel();
    document.querySelectorAll('.fx-editor').forEach(n => n.remove()); // floating panels belong to the project
    if (this.doc && this.dirty) await this.save();
    this.player.dispose();
    // closing renames the folder to the project's name (if it was renamed), so wait before listing the projects
    if (this.token) await api.projectClose?.(this.token).catch(() => {});
    this.doc = null; this.token = null;
    this.setLamp('saved', false);
    $('#editor').classList.add('hidden'); $('#home').classList.remove('hidden');
    $('#doc-name').textContent = '';
    $('#doc-name').contentEditable = 'false';
    for (const b of ['#btn-import', '#btn-thumb', '#btn-aiimage', '#btn-export', '#btn-autoedit', '#btn-voices']) $(b).disabled = true;
    $('#btn-close-project').classList.add('hidden');
    $('#btn-save-project').classList.add('hidden');
    const grid = $('#recent');
    grid.replaceChildren();
    const recent = await api.recent().catch(() => []);
    if (!recent.length) {
      const note = el('div', { class: 'empty-note', text: 'Your projects will show up here.' });
      grid.append(note);
      // say where they're really saved (it can be another folder or a drive), with a way to change it
      api.storageGet?.().then(st => {
        if (!st?.root) return;
        note.replaceChildren(`Your projects will show up here. They’re saved in ${st.isDefault ? 'Movies › ProtoArt Reel' : st.root}. `,
          el('button', { class: 'mini', text: 'Change…', onclick: async () => { try { const r = await api.storageChoose(); if (r) { toast(`New projects now go in ${r}.`, 4000); this.showHome?.(); } } catch (e) { toast(String(e?.message || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''), 5000); } } }));
      }).catch(() => {});
    }
    // several at once: ⌘-click toggles one, ⇧-click picks a run; plain click opens
    const picked = this._picked = new Set();
    let lastIdx = -1;
    const cards = [];
    let pickMode = false;
    const syncPicks = () => {
      grid.classList.toggle('pick-mode', pickMode || picked.size > 0);
      $('#proj-pickmode').classList.toggle('on', pickMode);
      $('#proj-pickmode').textContent = pickMode ? 'DONE' : 'SELECT…';
      cards.forEach(({ card, r }) => { card.classList.toggle('picked', picked.has(r.key)); card.querySelector('.pick').checked = picked.has(r.key); });
      $('#proj-selbar').classList.toggle('hidden', !picked.size);
      $('#proj-selcount').textContent = `${picked.size} selected`;
    };
    $('#proj-sel-all').onclick = () => { recent.forEach(r => picked.add(r.key)); syncPicks(); };
    $('#proj-sel-none').onclick = () => { picked.clear(); pickMode = false; syncPicks(); };
    $('#proj-pickmode').onclick = () => { pickMode = !pickMode; if (!pickMode) picked.clear(); syncPicks(); };
    $('#proj-sel-trash').onclick = () => this.trashProjects(recent.filter(r => picked.has(r.key)));
    recent.forEach((r, idx) => {
      const menu = (x, y) => popMenu(x, y, picked.size > 1 && picked.has(r.key) ? [
        [`Move ${picked.size} projects to Trash…`, () => this.trashProjects(recent.filter(q => picked.has(q.key)))],
        ['Clear selection', () => { picked.clear(); syncPicks(); }],
      ] : [
        ['Open', () => this.open(api.openRecent(r.key))],
        ['Rename…', async () => {
          const v = await promptText('Rename project', 'The project’s folder is renamed too. Its media stays inside it.', r.name, 'Rename');
          if (!v || v === r.name) return;
          try { await api.projectRename(r.key, v); this.showHome(); } catch (e) { toast(e.message, 5000); }
        }],
        ['Duplicate', async () => {
          toast(`Copying “${r.name}” and its media…`, 2500);
          try { await api.projectDuplicate(r.key); toast(`Made “${r.name} copy”.`); this.showHome(); } catch (e) { toast(e.message, 5000); }
        }],
        ['Show in Finder', () => api.projectReveal(r.key).catch(e => toast(e.message))],
        r.recent && !r.inLibrary ? ['Remove from this list', async () => { await api.projectForget(r.key).catch(e => toast(e.message)); this.showHome(); }] : null,
        null,
        ['Move to Trash…', () => this.trashProject(r)],
      ]);
      const more = el('button', { class: 'rmore', text: '⋯', title: 'More: show in Finder, move to Trash…' });
      const card = el('div', { class: 'recent', onclick: e => {
        if (performance.now() - (this._marqueeEnd || -1e9) < 250) return;
        if (e.metaKey || e.ctrlKey || pickMode || e.target.classList.contains('pick')) { picked.has(r.key) ? picked.delete(r.key) : picked.add(r.key); lastIdx = idx; syncPicks(); return; }
        if (e.shiftKey) { const a0 = lastIdx < 0 ? idx : lastIdx; for (let i = Math.min(a0, idx); i <= Math.max(a0, idx); i++) picked.add(recent[i].key); lastIdx = idx; syncPicks(); return; }
        if (picked.size) { picked.clear(); syncPicks(); }
        this.open(api.openRecent(r.key));
      } },
        el('div', { class: 'poster', style: r.thumb ? { backgroundImage: `url(${r.thumb})` } : {} }), more,
        el('input', { type: 'checkbox', class: 'pick', title: 'Pick this project (to move several to the Trash at once)' }),
        el('div', { class: 'meta' }, el('b', { text: r.name }), el('span', { text: new Date(r.modified).toLocaleString() })));
      more.addEventListener('click', e => { e.stopPropagation(); const b = more.getBoundingClientRect(); menu(b.left, b.bottom + 4); });
      card.addEventListener('contextmenu', e => { e.preventDefault(); menu(e.clientX, e.clientY); });
      grid.append(card);
      cards.push({ card, r });
    });
    // drag a box across the projects (from a card or the empty space round them) to pick every one it touches;
    // with ⇧ or ⌘ held, the box adds to what's already picked. A click on empty space clears the picks.
    $('#home').onmousedown = e => {
      if (e.button !== 0 || !recent.length || e.target.closest('.home-hero, .projects-head, button, input, a, .pop-menu')) return;
      e.preventDefault(); // no text selection while dragging
      const x0 = e.clientX, y0 = e.clientY, add = e.shiftKey || e.metaKey || e.ctrlKey, before = new Set(picked);
      let box = null;
      const move = ev => {
        if (!box) { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return; box = el('div', { class: 'marquee' }); document.body.append(box); }
        const l = Math.min(x0, ev.clientX), t = Math.min(y0, ev.clientY), w = Math.abs(ev.clientX - x0), h = Math.abs(ev.clientY - y0);
        Object.assign(box.style, { left: `${l}px`, top: `${t}px`, width: `${w}px`, height: `${h}px` });
        picked.clear(); if (add) before.forEach(k => picked.add(k));
        cards.forEach(({ card, r }) => { const b = card.getBoundingClientRect(); if (b.left < l + w && b.right > l && b.top < t + h && b.bottom > t) picked.add(r.key); });
        syncPicks();
      };
      const up = () => {
        removeEventListener('mousemove', move); removeEventListener('mouseup', up);
        if (box) { box.remove(); this._marqueeEnd = performance.now(); } // the click that ends a drag doesn't open a project
        else if (!e.target.closest('.recent') && !add && picked.size) { picked.clear(); pickMode = false; syncPicks(); }
      };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    };
    // on the home screen: ⌫ moves the picked projects to the Trash (it asks first), ⌘A picks all, Esc clears
    this._homeKey = e => {
      if (e.key === 'Backspace' || e.key === 'Delete') { if (picked.size) { e.preventDefault(); this.trashProjects(recent.filter(r => picked.has(r.key))); } }
      else if ((e.key === 'a' || e.key === 'A') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); recent.forEach(r => picked.add(r.key)); syncPicks(); }
      else if (e.key === 'Escape' && (picked.size || pickMode)) { picked.clear(); pickMode = false; syncPicks(); }
    };
    syncPicks();
  }

  async trashProjects(list) {
    if (!list.length) return;
    if (list.length === 1) return this.trashProject(list[0]);
    if (!(await ask(`Move ${list.length} projects to Trash?`, `${list.map(r => `“${r.name}”`).join(', ')} and all their recordings and media go to the Trash. You can put them back from the Trash until you empty it.`, 'Move to Trash'))) return;
    let n = 0;
    for (const r of list) { try { await api.projectTrash(r.key); n++; } catch (e) { toast(`${r.name}: ${e.message}`, 6000); } }
    toast(`${n} project${n === 1 ? '' : 's'} moved to the Trash.`);
    this.showHome();
  }

  /** Delete a project from the home screen: the whole folder, media included, goes to the Trash. */
  async trashProject(r) {
    if (!(await ask('Move to Trash?', `“${r.name}” and all its recordings and media go to the Trash. You can put it back from the Trash until you empty it.`, 'Move to Trash'))) return;
    try { await api.projectTrash(r.key); toast(`“${r.name}” moved to the Trash.`); } catch (e) { toast(e.message, 6000); }
    this.showHome();
  }

  async open(promise) {
    try {
      const p = await promise;
      if (!p) return;
      this.proxies.cancel();
      this.token = p.token;
      this.doc = normalize(p.doc);
      this.doc.name = p.name;
      this.history = new History(Number(pref('undoLevels')) || 200);
      this.selection = { clips: [], action: null };
      this.setDirty(false);
      $('#home').classList.add('hidden'); $('#editor').classList.remove('hidden');
      for (const b of ['#btn-import', '#btn-thumb', '#btn-aiimage', '#btn-export', '#btn-autoedit', '#btn-voices']) $(b).disabled = false;
      $('#btn-close-project').classList.remove('hidden');
      $('#btn-save-project').classList.remove('hidden');
      const name = $('#doc-name');
      name.textContent = this.doc.name;
      name.title = `${this.doc.name} — click to rename`;
      name.contentEditable = 'true';
      this.player.time = 0;
      // older ScreenFlow imports put cross-fades on extra "(overlap)" layers: fold them back as crossfades
      const merged = mergeOverlapTracks(this.doc);
      if (merged) { this.setDirty(true); setTimeout(() => toast(`Moved ${merged} ScreenFlow transition${merged === 1 ? '' : 's'} off the extra overlap layers. They are now crossfades on their own track.`, 7000), 600); }
      this.applyPrefs();
      $('#snap').checked = pref('snap') !== false;
      { const r = $('#remix'); if (r) r.checked = pref('remix') !== false; }
      { const g = $('#auto-gaps'); if (g) g.checked = !!pref('autoCloseGaps'); }
      this.player.resize();
      this.renderAll();
      requestAnimationFrame(() => this.timeline.fit());
      this.player.seek(0);
      this._fixOldScreenflowColour(); // before proxies: it may replace them
      setTimeout(() => this.proxies.kick(), 1500); // after the first frames are up
      setTimeout(() => { if (this.doc) labelNudge(this); }, 5000); // ask once to colour-label the sound tracks
      shareDuplicateRenders(this).then(r => { if (r.files) toast(`Freed disk space: ${r.files} duplicate plug-in render${r.files === 1 ? '' : 's'} moved to the Trash (empty the Trash to get the space back).`, 8000); }).catch(() => {});
      return true;
    } catch (e) { toast(String(e?.message || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''), 5000); return false; }
  }

  /**
   * ScreenFlow conversions made before 1.4 were labelled with the wrong colour range (too dark). The label is
   * corrected in the file itself, exactly and instantly, and their proxies are made again. If a file can't
   * be corrected, the viewer and export keep compensating for it as before.
   */
  async _fixOldScreenflowColour() {
    const token = this.token, list = (this.doc?.media || []).filter(m => m.convertedFrom === 'screenflow' && m.kind === 'video' && !m.rangeOk);
    let fixed = 0;
    for (const m of list) {
      try {
        const r = await api.fixRange(token, m.file);
        if (this.token !== token) return;
        m.rangeOk = true; m.proxy = null; fixed++;
        this.player.reloadMedia?.(m.id);
        void r;
      } catch (e) { console.warn('colour fix', m.file, e.message); }
    }
    if (fixed) { this.setDirty(true); this.save(); this.player.queueDraw(); toast(`Corrected the colours of ${fixed} video${fixed === 1 ? '' : 's'} imported from ScreenFlow (they looked too dark). Their proxies are being made again.`, 8000); this.proxies.kick(); }
  }

  async newProject(record = false) {
    // a recording sizes its own canvas; a blank project asks for size and frame rate first (or a starter)
    const spec = record ? null : await openNewDocument(this);
    if (!record && !spec) return;
    if (this.doc && this.dirty) await this.save();
    const name = spec?.starter ? `${spec.starter.name} ${new Date().toLocaleDateString()}` : 'Untitled ' + new Date().toLocaleDateString();
    const ok = await this.open(this._create(name));
    if (!ok) return;
    if (record) { openRecorder(this); return; }
    this.shapeNewDoc(spec);
  }
  /** Speed of the selected clips: up / down a step, back to normal, or a typed percentage. */
  async changeSpeed(how) {
    const clips = this.doc ? this.doc.clips.filter(c => this.selection.clips.includes(c.id) && c.type === 'media' && !c.locked && mediaById(this.doc, c.media)?.kind !== 'image') : [];
    if (!clips.length) { toast('Select a video or sound clip first.'); return; }
    let typed = null;
    if (how === 'custom') {
      const v = await promptText('Speed', 'Speed in % (100 = normal, 200 = twice as fast, 50 = half speed):', String(Math.round((clips[0].speed || 1) * 100)), 'Set');
      if (v == null) return;
      typed = parseFloat(v) / 100;
      if (!(typed > 0)) { toast('Type a percentage, like 150.'); return; }
    }
    this.commit(doc => {
      for (const c of clips) {
        const cur = c.speed || 1;
        const sp = how === 'normal' ? 1 : how === 'custom' ? typed
          : how === 'up' ? SPEED_STEPS.find(x => x > cur + 1e-3) ?? SPEED_MAX : [...SPEED_STEPS].reverse().find(x => x < cur - 1e-3) ?? SPEED_MIN;
        setSpeed(doc, doc.clips.find(k => k.id === c.id), sp);
      }
    });
    const c = this.doc.clips.find(k => k.id === clips[0].id);
    toast(`Speed ${Math.round((c.speed || 1) * 100)}% · ${c.duration.toFixed(2)} s`, 1600);
  }
  /** Files dropped on the start screen: a new project with them in (named after a ScreenFlow project). */
  keepPart(a, b) { ops.addPart(this, a, b); }
  /** Auto Level on a track: an even volume (quiet parts up, loud parts down). */
  autoLevelOn(tr) { return !!(tr?.fx || []).some(f => f.type === 'level' && !f.off); }
  toggleAutoLevel(tr, on = !this.autoLevelOn(tr)) {
    if (!tr) return;
    this.commit(d => {
      const t = d.tracks.find(x => x.id === tr.id); if (!t) return;
      const lv = (t.fx || []).find(f => f.type === 'level');
      if (!on) { if (lv) t.fx = t.fx.filter(f => f !== lv); }
      else if (lv) lv.off = false;
      else t.fx = [{ id: uid('fx'), type: 'level', params: {} }, ...(t.fx || [])];
    }, { keepInspector: true });
    toast(on ? `Auto Level on for “${tr.name || 'the track'}”: its volume is evened out (quiet parts up, loud parts down).` : `Auto Level off for “${tr.name || 'the track'}”.`, 4000);
  }
  /** The home screen's EDIT A VIDEO: a new project, the file picker, and the video straight onto the timeline. */
  async editAVideo() {
    if (this.doc && this.dirty) await this.save();
    const ok = await this.open(this._create('Untitled ' + new Date().toLocaleDateString()));
    if (!ok) return;
    await this.importMedia();
    // the edit takes the video's shape (a phone video stays vertical)
    const v = this.doc?.media.find(m => m.kind === 'video' && m.width && m.height);
    if (v && this.doc.clips.length && (v.width !== this.doc.canvas.width || v.height !== this.doc.canvas.height)) {
      this.commit(d => { d.canvas.width = Math.round(v.width / 2) * 2; d.canvas.height = Math.round(v.height / 2) * 2; });
      this.player.resize();
    }
    this.renderAll(); requestAnimationFrame(() => this.timeline.fit());
  }
  async newFromDrop(files) {
    const list = Array.isArray(files) ? files : api.pathsOf(files); // locations on disk, read during the drop
    const base = f => String(f).split('/').pop();
    const sf = list.find(f => /\.screenflow\/?$/i.test(f));
    const name = sf ? base(sf.replace(/\/$/, '')).replace(/\.screenflow$/i, '') : 'Untitled ' + new Date().toLocaleDateString();
    const ok = await this.open(this._create(name));
    if (!ok) return;
    await this.importDropped(list, null);
    this.player.resize(); this.renderAll();
    requestAnimationFrame(() => this.timeline.fit());
    this.setDirty(true); await this.save();
  }
  /** Gives a just-made, empty project its size and frame rate, or a starter's tracks and titles. */
  async shapeNewDoc(spec) {
    if (spec.starter) applyStarter(this.doc, spec.starter);
    else Object.assign(this.doc.canvas, { width: spec.width, height: spec.height, fps: spec.fps });
    this.player.resize();
    this.renderAll();
    requestAnimationFrame(() => this.timeline.fit());
    this.player.seek(0);
    this.setDirty(true);
    await this.save();
    if (spec.starter) toast('Template ready: drop your video on “Main video”, replace the titles, add voice, music and sound effects.', 6000);
  }

  async save() {
    if (!this.doc) return;
    this._lastSave = Date.now();
    try {
      let poster = null;
      if (duration(this.doc) > 0) {
        try {
          const c = await this.player.still(Math.min(1, duration(this.doc) / 2), 320, Math.round(320 * this.doc.canvas.height / this.doc.canvas.width));
          poster = new Uint8Array(await (await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8))).arrayBuffer());
        } catch { /* poster is optional */ }
      }
      await api.save(this.token, this.doc, poster);
      this.setDirty(false);
    } catch (e) { toast(`Couldn’t save: ${e.message}`, 6000); }
  }

  setDirty(d) { this.dirty = d; api.setDirty(d); this.setLamp('saved', !d && !!this.doc); }
  setLamp(name, on) { this.lamps[name]?.classList.toggle('on', !!on); }

  // ---------------------------------------------------------------- changes & history
  /** Run an edit as one undo step. */
  commit(fn, { quiet = false } = {}) {
    this.history.push(this.doc);
    fn(this.doc);
    this._smooth();
    applyTrackLocks(this.doc); // clips on a locked track stay locked, whatever the edit
    this.changed({ quiet });
  }
  beginChange() { this.history.push(this.doc); this._inChange = true; }
  endChange(opts = {}) { this._inChange = false; this._smooth(); applyTrackLocks(this.doc); this.changed(opts); }
  /** Every cut gets its short crossfade or fade (Settings › Timeline › Smooth every cut). */
  _smooth() { const xf = Number(pref('smoothCuts') ?? 0.1); if (xf > 0 && this.doc) { try { smoothCuts(this.doc, xf); } catch (e) { console.warn('smooth cuts', e); } } }
  changed({ light = false, keepInspector = false, quiet = false, noTimeline = false } = {}) {
    if (!light) { syncTrackPlugins(this); this._menuLabels(); } // track plug-ins follow the edit (rendered in the background)
    this.setDirty(true);
    clearTimeout(this._proxyKick); this._proxyKick = setTimeout(() => this.proxies.kick(), 1200); // new media → proxy
    if (quiet) return;
    if (!noTimeline) this.timeline.render();
    if (!light || !keepInspector) { if (!keepInspector) this.inspector.render(); }
    if (!light) this.library.render();
    document.querySelector('.tp-panel')?._redraw?.();
    this.player.prune();
    if (this.player.playing) return;
    this.player.syncPaused();
    this.player.queueDraw();
    this.showDuration(fmtTime(duration(this.doc), this.doc.canvas.fps, true));
  }
  renderAll() {
    timeFormat.fps = this.doc.canvas.fps || 30;
    this.timeline.render(); this.inspector.render(); this.library.render();
    this.showDuration(fmtTime(duration(this.doc), this.doc.canvas.fps, true));
    this.player.queueDraw();
  }
  undo() {
    const now = this.doc, d = this.history.undo(now);
    if (!d) { toast('Nothing to undo.'); return; }
    this.doc = d; this._afterHistory();
    toast(`↶ Undo: ${cap(describeChange(d, now))}`, 2500); // what the undone step had done
  }
  redo() {
    const now = this.doc, d = this.history.redo(now);
    if (!d) { toast('Nothing to redo.'); return; }
    this.doc = d; this._afterHistory();
    toast(`↷ Redo: ${cap(describeChange(now, d))}`, 2500);
  }
  /** The Edit menu says what Undo and Redo will do ("Undo Move 2 Clips"); worked out shortly after each edit. */
  _menuLabels() {
    // Off: the menu bar can't be relabelled without rebuilding it, and a rebuild could swallow a menu click.
    // (It also parsed the undo history after every edit.) Undo / Redo say what they did in a toast instead.
    return;
    // eslint-disable-next-line no-unreachable
    clearTimeout(this._labelT);
    this._labelT = setTimeout(() => {
      const h = this.history; if (!h || !this.doc || !api.setUndoLabels) return;
      const top = s => (s.length ? JSON.parse(s[s.length - 1]) : null);
      try {
        const u = top(h.undoStack), r = top(h.redoStack);
        api.setUndoLabels(u ? `Undo ${menuCase(describeChange(u, this.doc))}` : 'Undo', r ? `Redo ${menuCase(describeChange(this.doc, r))}` : 'Redo');
      } catch { /* the plain labels stay */ }
    }, 400);
  }
  _afterHistory() {
    this._menuLabels();
    this.selection.clips = this.selection.clips.filter(id => this.doc.clips.some(c => c.id === id));
    this.selection.action = null;
    this.setDirty(true);
    this.renderAll();
    this.player.prune(); this.player.syncPaused();
  }

  selectCaption(id, { noTimeline = false } = {}) {
    this.selection = { clips: [], action: null, caption: id || null };
    if (!noTimeline) this.timeline.render();
    this.inspector.render();
    this.overlay.update();
  }
  select(ids, action, { noTimeline = false } = {}) {
    this.selection = { clips: ids, action: action || null };
    if (ids.length && this.timeline) this.timeline.selPoint = null;
    if (!noTimeline) this.timeline.render();
    this.inspector.render();
    this.overlay.update();
  }
  seek(t) { this.player.seek(t); }
  focusInspector() { const t = this.inspector.textArea; if (t && document.body.contains(t)) t.focus(); }
  /** Double-click a clip: its settings on the right, the cursor in the first thing you can type (a title's
   *  text, a call-out's words), and that section lit up for a moment so you can see where to look. */
  editClip(c) {
    requestAnimationFrame(() => {
      const root = this.inspector.root;
      if (!root) return;
      root.querySelector('.insp-tab[data-k="all"]')?.click();
      const t = this.inspector.textArea && document.body.contains(this.inspector.textArea) ? this.inspector.textArea
        : root.querySelector('textarea, input[type=text]:not([readonly])');
      const sec = (t && t.closest('.insp-section')) || root.querySelector('.insp-section');
      if (sec) { sec.scrollIntoView({ block: 'start', behavior: 'smooth' }); sec.classList.add('insp-flash'); setTimeout(() => sec.classList.remove('insp-flash'), 1600); }
      if (t) { t.focus(); t.select?.(); }
      else if (c.type !== 'media') toast('Its settings are on the right.', 2500);
    });
  }

  /**
   * Makes a new project. If the folder for projects isn't there (an external drive that's not connected), asks where
   * to put it instead, right here: another folder, or Movies › ProtoArt Reel. Then tries again.
   */
  async _create(name) {
    try { return await api.create(name); }
    catch (e) {
      const m = /STORAGE_MISSING\|(.+)$/.exec(String(e?.message || e));
      if (!m) throw e;
      const where = m[1].trim();
      const drive = /^\/Volumes\/([^/]+)/.exec(where)?.[1];
      const choice = await new Promise(resolve => {
        modal('Where should this project go?', el('div', {},
          el('p', { text: drive ? `New projects are set to go on the drive “${drive}”, but it isn’t connected.` : `New projects are set to go in a folder that isn’t there any more.` }),
          el('p', { class: 'note', text: where }),
          el('p', { class: 'note', text: drive ? 'Connect the drive and try again, or choose somewhere else (the setting changes for the next projects too; you can change it back in Settings › Media & Storage).' : 'Choose somewhere else (the setting changes for the next projects too).' })), [
          { label: 'Cancel', onClick: c => { resolve(null); c(); } },
          { label: 'Use Movies › ProtoArt Reel', onClick: c => { resolve('default'); c(); } },
          { label: 'Choose another folder…', cls: 'hw amber', onClick: c => { resolve('choose'); c(); } },
        ], { onClose: () => resolve(null) });
      });
      if (!choice) throw new Error('No project made.');
      const root = choice === 'default' ? await api.storageReset() : await api.storageChoose();
      if (!root) throw new Error('No project made.');
      toast(`New projects now go in ${root}.`, 4000);
      return api.create(name);
    }
  }

  /** Opens the clip's settings on one section (by its title) and lights it up. */
  revealSection(title) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const root = this.inspector.root; if (!root) return;
      root.querySelector('.insp-tab[data-k="all"]')?.click();
      const sec = [...root.querySelectorAll('.insp-section')].find(x => x.querySelector('.engr')?.textContent.trim().toLowerCase() === title.toLowerCase());
      if (sec) { sec.scrollIntoView({ block: 'start', behavior: 'smooth' }); sec.classList.add('insp-flash'); setTimeout(() => sec.classList.remove('insp-flash'), 1600); }
    }));
  }
  /** The selected clip with a picture (video or image), or a hint to select one. */
  _visualClip(what) {
    const c = this.doc.clips.find(x => this.selection.clips.includes(x.id) && x.type === 'media' && !x.audioOnly && ['video', 'image'].includes(mediaById(this.doc, x.media)?.kind));
    if (!c) toast(`Select a video or picture clip first, then ${what}.`, 4000);
    return c;
  }
  /** Green screen: a colour key on the selected clip (added once), its controls opened. */
  greenScreen() {
    const c = this._visualClip('choose Green screen'); if (!c) return;
    if (!(c.filters || []).some(f => f.type === 'chroma')) this.commit(() => { c.filters ||= []; c.filters.push({ id: uid('f'), type: 'chroma', color: '#00d000', tolerance: 0.12, softness: 0.08, spill: 0.6 }); });
    this.revealSection('Filters');
    toast('Green screen on. Pick the screen’s colour (blue screens too) and adjust Tolerance and Softness on the right. Put the new background on the track below.', 6000);
  }
  /** Background removal (no green screen needed): opens its controls on the selected video clip. */
  removeBackground() {
    const c = this._visualClip('choose Remove background'); if (!c) return;
    if (mediaById(this.doc, c.media)?.kind !== 'video') { toast('Remove background works on video clips. For a still picture, use Green screen.', 5000); return; }
    this.revealSection('Background removal');
  }
  /** Picture in picture: the selected clip small in a corner, rounded with a shadow; again moves it round the corners. */
  pictureInPicture(corner) {
    const c = this._visualClip('choose Picture in picture'); if (!c) return;
    const CORNERS = { br: [0.85, 0.8], bl: [0.15, 0.8], tr: [0.85, 0.2], tl: [0.15, 0.2] };
    const order = ['br', 'bl', 'tl', 'tr'];
    const now = order.find(k => Math.abs((c.props?.x ?? 0.5) - CORNERS[k][0]) < 0.02 && Math.abs((c.props?.y ?? 0.5) - CORNERS[k][1]) < 0.02);
    if (corner === 'off') {
      this.commit(() => { c.props ||= {}; Object.assign(c.props, { x: 0.5, y: 0.5, scale: 1, radius: 0, shadow: 0 }); });
      toast('Back to full frame.'); return;
    }
    const next = corner || (now ? order[(order.indexOf(now) + 1) % 4] : 'br');
    let raised = false;
    this.commit(d => {
      c.props ||= {};
      Object.assign(c.props, { x: CORNERS[next][0], y: CORNERS[next][1], scale: c.props.scale && c.props.scale < 0.5 ? c.props.scale : 0.26 });
      c.props.radius = Math.max(c.props.radius || 0, 24); c.props.shadow = Math.max(c.props.shadow || 0, 30);
      raised = raisePip(d, c);
    });
    toast(`Picture in picture: ${{ br: 'bottom right', bl: 'bottom left', tl: 'top left', tr: 'top right' }[next]}.${raised ? ' Moved it to a track of its own above the main video, so it shows on top.' : ''} Press ▣ PiP again for the next corner, or drag it in the preview.`, 6000);
  }

  // ---------------------------------------------------------------- media & clips
  /**
   * Where the files of a drop are on disk, read during the drop event (its file list is emptied afterwards).
   * Each File is handed over on its own (a whole FileList doesn't always survive the trip to the preload);
   * if that still gives nothing, the file:// links Finder puts in the drop are used.
   */
  dropPaths(e) {
    const dt = e.dataTransfer, out = [];
    for (const f of Array.from(dt?.files || [])) { const p = api.pathOf ? api.pathOf(f) : ''; if (p) out.push(p); }
    if (!out.length && api.pathsOf) out.push(...api.pathsOf(Array.from(dt?.files || [])));
    if (!out.length) {
      const uris = (dt?.getData('text/uri-list') || '').split(/\r?\n/).filter(u => /^file:\/\//i.test(u.trim()));
      for (const u of uris) { try { const p = decodeURIComponent(new URL(u.trim()).pathname); if (p) out.push(p.replace(/\/$/, '')); } catch { /* skip */ } }
    }
    return [...new Set(out)];
  }
  async importDropped(files, where) {
    if (!this.doc) return;
    if (Array.isArray(files) && !files.length) { toast('macOS didn’t say where the dropped files are. Try dropping them again, or use ADD MEDIA.', 6000); return; }
    const res = await this._withConversion(() => api.importDropped(this.token, files));
    this._addImported(res, where);
  }
  async importMedia() {
    const res = await this._withConversion(() => api.importMedia(this.token));
    this._addImported(res, null);
  }
  /** Runs an import, showing progress while formats are converted (by macOS, then any the editor converts). */
  async _withConversion(run) {
    const dlg = conversionDialog();
    const onProg = p => dlg.set(p.name, p.value, p.index, p.count);
    this._importProg = onProg;
    if (!this._importHooked) { this._importHooked = true; api.onImportProgress?.(p => this._importProg?.(p)); }
    try {
      const res = await run();
      // ScreenFlow projects: recordings converted here, then the timeline rebuilt in _addImported
      const sfs = (res || []).filter(r => r.screenflow);
      for (const r of sfs) {
        try {
          const built = await convertScreenflow(this, r.screenflow, (name, v) => dlg.set(name, v, 0, 1));
          Object.keys(r).forEach(k => delete r[k]); r.screenflowBuilt = built;
        } catch (e) { Object.keys(r).forEach(k => delete r[k]); r.error = `ScreenFlow project: ${e.message}`; }
      }
      const todo = (res || []).filter(r => r.browserConvert);
      for (const [i, r] of todo.entries()) {
        const out = await convertInEditor(this, r.browserConvert, v => dlg.set(r.browserConvert.name, v, i, todo.length));
        Object.keys(r).forEach(k => delete r[k]); Object.assign(r, out);
      }
      const conv = (res || []).filter(r => r.convertedFrom).length;
      if (conv) toast(`${conv} file${conv > 1 ? 's were' : ' was'} converted so Reel can edit ${conv > 1 ? 'them' : 'it'} (your originals are untouched).`, 4000);
      return res || [];
    } finally { this._importProg = null; dlg.close(); }
  }
  _addImported(res, where) {
    if (!res || !res.length) { toast('Nothing in that could be imported. Reel takes videos, pictures, sound and ScreenFlow projects.', 5000); return; }
    for (const r of res.filter(x => x.screenflowBuilt)) {
      const b = r.screenflowBuilt;
      let sum = null;
      this.commit(doc => { sum = placeScreenflow(doc, b, where); });
      const parts = [`“${b.name}” imported from ScreenFlow: ${sum.placed} clip${sum.placed === 1 ? '' : 's'}`];
      if (sum.callouts) parts.push(`${sum.callouts} callout${sum.callouts === 1 ? '' : 's'}`);
      if (sum.canvasSet) parts.push(`canvas set to ${this.doc.canvas.width}×${this.doc.canvas.height}`);
      toast(parts.join(', ') + '.' + (b.notes.length ? '\n' + b.notes.join('\n') : ''), b.notes.length ? 9000 : 5000);
    }
    res = res.filter(x => !x.screenflowBuilt);
    if (!res.length) return;
    const errors = res.filter(r => r.error).map(r => r.error);
    if (errors.length) toast(errors.join('\n'), 6000);
    const ok = res.filter(r => !r.error);
    if (!ok.length) return;
    const dropped = [], placedIds = [];
    let placed = 0;
    this.commit(doc => {
      let at = where ? where.at : duration(doc);
      for (const r of ok) {
        const m = { id: uid('m'), ...r };
        doc.media.push(m);
        if (where || doc.clips.length === 0) {
          const c = newMediaClip(doc, m, null, at);
          // the track it was dropped on, when there's room there; sound otherwise goes to a sound track
          c.track = where?.track && isFree(doc, where.track, c.start, c.duration) ? where.track
            : m.kind === 'audio' ? this._audioTrack(doc, c.start, c.duration) : freeTrack(doc, c.start, c.duration, where && where.track);
          doc.clips.push(c);
          at = clipEnd(c); placed++; placedIds.push(c.id);
          if (m.kind === 'video') dropped.push(c.id);
        }
      }
    });
    this._autoZoomDropped(dropped);
    // show where they landed: selected, and scrolled into view (a sound file can go to a track below the fold)
    if (placedIds.length) { this.select(placedIds, null); requestAnimationFrame(() => this.timeline.reveal(placedIds)); }
    toast(placed ? `Added ${ok.length} file${ok.length > 1 ? 's' : ''} to the timeline.` : `Added ${ok.length} file${ok.length > 1 ? 's' : ''} to the Media list: drag ${ok.length > 1 ? 'them' : 'it'} onto the timeline (or drop files straight onto the timeline or the preview next time).`, 5000);
  }
  /** New project from a saved template (layout, titles, intro/outro, music: everything in it). */
  async openTemplates() {
    const rows = el('div', { class: 'global-list' });
    let dlg = null;
    const draw = async () => {
      const list = await api.templateList().catch(() => []);
      rows.replaceChildren(...(list.length ? list.map(t => el('div', { class: 'row' },
        el('span', { class: 'gname', text: t.name }),
        el('button', { class: 'tool on-amber', text: 'New project', onclick: async () => { dlg.close(); if (this.doc) await this.save(); this.open(api.templateUse(t.id)); } }),
        el('button', { class: 'mini', text: '×', title: 'Delete this template', onclick: async () => { if (await ask('Delete template?', `“${t.name}” goes to the Trash.`, 'Delete')) { await api.templateRemove(t.id); draw(); } } })))
        : [el('p', { class: 'note', text: 'None of your own yet. Open a project with the intro, lower thirds, music bed and layout you reuse, then File › Save as Template.' })]));
      const use = async st => {
        dlg.close(); if (this.doc && this.dirty) await this.save();
        if (await this.open(this._create(`${st.name} ${new Date().toLocaleDateString()}`))) this.shapeNewDoc({ starter: st });
      };
      rows.prepend(el('div', { class: 'engr', text: 'Built in' }), el('div', { class: 'tpl-grid' }, ...STARTERS.map(st => el('button', { class: 'tpl-card', type: 'button', title: `New ${st.name} project: Titles, B-roll, Main video, Voice, Music and Sound FX tracks, a title card and an end card that fades out`, onclick: () => use(st) },
        el('span', { class: 'tpl-pic' }, starterThumb(st, 130)), el('b', { text: st.name }), el('small', { text: st.sub })))), el('div', { class: 'engr', text: 'Yours' }));
    };
    await draw();
    dlg = modal('New from template', rows, [{ label: 'Close', onClick: c => c() }]);
  }
  async saveTemplate() {
    const name = await promptText('Save as template', 'New projects made from it start with everything in this one (clips, titles, music, layout, canvas size).', this.doc.name, 'Save');
    if (!name) return;
    try { await this.save(); const r = await api.templateSave(this.token, name); toast(`Template “${r.name}” saved. File › New from Template uses it.`); } catch (e) { toast(e.message); }
  }
  async archive() {
    const only = await ask('Archive project', 'Saves a copy of this project with only the media it uses, ready to move to another Mac or a backup drive. Unused media is left out.', 'Choose where…');
    if (!only) return;
    try { await this.save(); const r = await api.archiveProject(this.token, true); if (r) toast(`Archived as “${r.name}” with ${r.files} media file${r.files === 1 ? '' : 's'}.`); } catch (e) { toast(e.message); }
  }
  /** Media kept for every project (intros, music, logos). Pick one to copy it into this project. */
  async openGlobalLibrary() {
    const rows = el('div', { class: 'global-list' });
    const draw = async () => {
      const list = await api.globalList().catch(() => []);
      rows.replaceChildren(...(list.length ? list.map(g => el('div', { class: 'row' },
        el('span', { class: 'gname', text: g.name }),
        el('button', { class: 'tool', text: 'Add to project', onclick: async () => { try { const r = await api.globalImport(this.token, g.file); this._addImported([r], null); } catch (e) { toast(e.message); } } }),
        el('button', { class: 'mini', text: '×', title: 'Remove from the Global Library', onclick: async () => { if (await ask('Remove from the Global Library?', `“${g.name}” goes to the Trash. Projects that already use it keep their copy.`, 'Remove')) { await api.globalRemove(g.file); draw(); } } })))
        : [el('p', { class: 'note', text: 'Empty. Right-click any media in a project and choose “Add to Global Library” to keep it here for every project: intros, outros, music beds, logos, lower-third backgrounds.' })]));
    };
    await draw();
    modal('Global Library', rows, [{ label: 'Show folder', onClick: () => api.globalReveal() }, { label: 'Done', cls: 'hw amber', onClick: c => c() }]);
  }
  _audioTrack(doc, start, dur) {
    // audio goes on the lowest free track
    for (let i = doc.tracks.length - 1; i >= 0; i--) if (isFree(doc, doc.tracks[i].id, start, dur)) return doc.tracks[i].id;
    return addTrack(doc).id;
  }
  /** Save a generated picture into the project's media; optionally place it at the playhead. */
  async addAiImage(png, label, place) {
    const r = await api.aiSaveImage(this.token, png, label);
    let m;
    this.commit(doc => {
      m = { id: uid('m'), ...r };
      doc.media.push(m);
      if (place) {
        const c = newMediaClip(doc, m, null, this.player.time);
        c.track = freeTrack(doc, c.start, c.duration, null);
        doc.clips.push(c);
        this.selection = { clips: [c.id], action: null };
      }
    });
    return m;
  }
  addMediaClip(mediaId, trackId, at) {
    const m = mediaById(this.doc, mediaId);
    if (!m) return;
    this.commit(doc => {
      const c = newMediaClip(doc, m, null, at);
      c.track = trackId && isFree(doc, trackId, c.start, c.duration) ? trackId : freeTrack(doc, c.start, c.duration, trackId);
      doc.clips.push(c);
      this.selection = { clips: [c.id], action: null };
      if (m.kind === 'video') this._autoZoomDropped([c.id]);
    });
  }
  async removeMedia(m) {
    if (!(await ask('Remove from project?', `“${m.name}” isn’t used on the timeline. Move the file to the Trash?`, 'Move to Trash'))) return;
    try {
      await api.deleteMedia(this.token, m.file);
      this.commit(doc => { doc.media = doc.media.filter(x => x !== m); });
      await this.save();
    } catch (e) { toast(e.message); }
  }

  /** Takes media off the timeline and out of the library (undoable). Its file stays in the project folder. */
  async removeUsedMedia(m) {
    const n = this.doc.clips.filter(c => c.media === m.id).length;
    if (!(await ask(`Remove “${m.name}”?`, `Its ${n} clip${n === 1 ? '' : 's'} come off the timeline and it leaves the media list. ⌘Z brings it all back; the file itself stays in the project folder.`, 'Remove'))) return;
    this.commit(doc => { doc.clips = doc.clips.filter(c => c.media !== m.id); doc.media = doc.media.filter(x => x.id !== m.id); });
  }

  /** Lays out a finished recording: camera on top as picture-in-picture, screen below, sound under. */
  addRecording(res, { cursorOffset, appLead = 0, pointerSeparate = false, keys = false, marks = [] }) {
    if (res.inputError) toast(res.inputError, 8000);
    const failed = res.media.filter(r => r.error);
    if (failed.length) toast(failed.map(f => `${f.role}: ${f.error}`).join('\n'), 8000);
    const ok = res.media.filter(r => !r.error);
    if (!ok.length) return;
    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const recId = uid('r');
    this.commit(doc => {
      const at = duration(doc) ? duration(doc) + 0.5 : 0;
      const names = { screen: 'Screen', camera: 'Camera', mic: 'Microphone', system: 'Computer audio' };
      const ms = {}, appMedia = [];
      for (const r of ok) {
        const m = { id: uid('m'), recording: recId, name: r.role === 'app' ? `${r.appName} ${stamp}` : `${names[r.role]} ${stamp}`, ...r };
        if (r.role === 'screen' && res.cursor) { m.cursor = res.cursor; m.cursorOffset = Math.max(0, cursorOffset || 0); if (pointerSeparate) m.pointerSeparate = true; if (res.cursorClicks) m.cursorClicks = res.cursorClicks; if (res.cursorKeys) m.cursorKeys = res.cursorKeys; }
        doc.media.push(m);
        if (r.role === 'app') appMedia.push(m); else ms[r.role] = m;
      }
      // the screen sets the canvas size of a fresh project
      if (!doc.clips.length && ms.screen && ms.screen.width) {
        const w = ms.screen.width, h = ms.screen.height, k = Math.min(1, 3840 / w, 2160 / h);
        doc.canvas.width = Math.round((w * k) / 2) * 2; doc.canvas.height = Math.round((h * k) / 2) * 2;
      }
      const ordered = ['camera', 'screen', 'mic', 'system'].filter(r => ms[r]).map(r => ms[r]).concat(appMedia);
      while (doc.tracks.length < ordered.length) addTrack(doc);
      const off = res.offsets || {};
      let ti = 0;
      const placed = [];
      for (const m of ordered) {
        const role = m.role;
        const c = newMediaClip(doc, m, null, at + (role === 'app' ? 0 : off[role] || 0));
        // app sound starts as the files open, a moment before the recorders: trim that lead-in
        if (role === 'app' && appLead > 0 && appLead < c.duration) { c.in = appLead; c.duration -= appLead; }
        let track = null;
        for (let i = ti; i < doc.tracks.length; i++) if (isFree(doc, doc.tracks[i].id, c.start, c.duration)) { track = doc.tracks[i].id; ti = i + 1; break; }
        c.track = track || addTrack(doc).id;
        if (role === 'camera') Object.assign(c.props, { x: 0.86, y: 0.8, scale: 0.24, radius: 28, shadow: 36 });
        if (role === 'screen') {
          c.cursor = m.pointerSeparate ? { show: true, pointer: 'arrow', scale: 1, clickStyle: 'none' } : null;
          if (keys) c.keystrokes = { show: true, hold: 1.5 }; // you asked for keystrokes, so show them
        }
        if (role === 'system' || role === 'app') c.audio.duck = 0.4;
        c.name = m.name;
        doc.clips.push(c);
        placed.push(c.id);
      }
      squareUpRecording(doc.clips.filter(c => placed.includes(c.id)), at);
      // markers you dropped while recording (⌥⇧⌘M), at the moment you pressed it
      const recStart = Math.min(...doc.clips.filter(c => placed.includes(c.id)).map(c => c.start));
      for (const ms of marks) doc.markers.push({ id: uid('k'), t: recStart + ms / 1000, label: '◆ Mark', mark: true });
      if (marks.length) doc.markers.sort((a, b) => a.t - b.t);
      // one recording's screen, camera and sound move together, like ScreenFlow (UNGROUP to split them)
      if (placed.length > 1) { const g = uid('g'); for (const c of doc.clips) if (placed.includes(c.id)) c.group = g; }
      this.selection = { clips: placed.slice(), action: null };
    });
    this.save();
    requestAnimationFrame(() => this.timeline.fit());
    toast(marks.length ? `Recording added to the timeline, with ${marks.length} marker${marks.length === 1 ? '' : 's'}.` : 'Recording added to the timeline.');
    this.markClaps(recId).then(n => { if (this.doc && (n || marks.length)) openTakes(this); }); // takes from this recording: show them
  }
  /** After a recording: listen to its microphone for "clap clap clap" and mark (or cut) each one. */
  async markClaps(recId) {
    const mode = pref('recClaps');
    if (mode === 'off') return 0;
    const token = this.token;
    const mics = this.doc.clips.filter(c => { const m = c.type === 'media' && this.doc.media.find(x => x.id === c.media); return m && m.recording === recId && m.role === 'mic'; });
    if (!mics.length) return 0;
    let sigs;
    try { sigs = await clapsOnTimeline(this, mics); } catch { return 0; }
    if (!sigs.length || this.token !== token || !this.doc) return 0;
    const n = sigs.length, s = n === 1 ? '' : 's';
    if (mode === 'cut') {
      this.commit(d => {
        for (const x of [...sigs].reverse()) removeRange(d, x.t0, x.t1);
        let shift = 0;
        for (const x of sigs) { d.markers.push({ id: uid('k'), t: x.t0 - shift, label: '✂ Clap', claps: true }); shift += x.t1 - x.t0; }
        d.markers.sort((a, b) => a.t - b.t);
      });
      toast(`Heard ${n} clap signal${s}: ${n + 1} takes. The claps are cut out; keep or drop the takes in ✂ TAKES.`, 6000);
    } else {
      this.commit(d => { addClapMarkers(d, sigs); });
      toast(`Heard ${n} clap signal${s}: ${n + 1} takes. Keep or drop them in ✂ TAKES.`, 6000);
    }
    return n;
  }

  // ---------------------------------------------------------------- tracks
  addTrack() { this.commit(doc => { addTrack(doc); }); }
  async removeTrack(tr) {
    if (this.doc.tracks.length <= 1) { toast('A project keeps at least one track.'); return; }
    const n = this.doc.clips.filter(c => c.track === tr.id).length;
    if (n && !(await ask(`Delete “${tr.name || 'track'}”?`, `It has ${n} clip${n === 1 ? '' : 's'} on it. They’re deleted with the track (⌘Z brings them back).`, 'Delete track and clips'))) return;
    this.commit(doc => { doc.tracks = doc.tracks.filter(t => t !== tr); doc.clips = doc.clips.filter(c => c.track !== tr.id); });
  }
  /** Everything for one track: the same menu from its timeline header and its mixer strip. */
  trackMenu(tr, x, y) {
    const doc = this.doc, i = doc.tracks.indexOf(tr), fx = tr.fx || [], n = doc.clips.filter(c => c.track === tr.id).length;
    const move = d => this.commit(dd => { const k = dd.tracks.indexOf(tr); dd.tracks.splice(k + d, 0, dd.tracks.splice(k, 1)[0]); });
    popMenu(x, y, [
      ['Rename…', () => this.renameTrack(tr)],
      [tr.locked ? '🔓 Unlock track' : '🔒 Lock track (nothing on it can be changed)', () => this.toggleTrackLock(tr)],
      i > 0 ? ['Move up', () => move(-1)] : null,
      i < doc.tracks.length - 1 ? ['Move down', () => move(1)] : null,
      null,
      ['New track above', () => this.commit(d => { addTrack(d, d.tracks.indexOf(tr)); })],
      ['New track below', () => this.commit(d => { addTrack(d, d.tracks.indexOf(tr) + 1); })],
      ['Duplicate track (with its clips)', () => this.commit(d => {
        const copy = addTrack(d, d.tracks.indexOf(tr) + 1);
        Object.assign(copy, structuredClone({ ...tr, id: copy.id }), { name: `${tr.name || 'Track'} copy` });
        for (const f of copy.fx || []) f.id = uid('fx');
        for (const c of d.clips.filter(c => c.track === tr.id)) d.clips.push({ ...structuredClone(c), id: uid('c'), track: copy.id, group: undefined });
      })],
      null,
      fx.length ? [fx.every(f => f.off) ? 'Turn all effects on' : 'Bypass all effects', () => this.commit(() => { const off = !fx.every(f => f.off); for (const f of fx) f.off = off; })] : null,
      [this.autoLevelOn(tr) ? '✓ Auto Level (on): even out the volume' : 'Auto Level: even out the volume', () => this.toggleAutoLevel(tr)],
      ...roleMenuItems(this, tr),
      ['⚖ Auto Mix…', () => openAutoMix(this)],
      n ? ['⤓ Bounce track to a new track (render all its effects)', () => bounceTrack(this, tr)] : null,
      tr.bounceOf || doc.clips.some(c => c.track === tr.id && c.bounced) ? ['↩ Back to the original sound (remove this track’s rendered copies)', () => revertClips(this, doc.clips.filter(c => c.track === tr.id).map(c => c.id))] : null,
      doc.autoMix ? ['Remove Auto Mix (back to your own levels)', () => removeAutoMix(this)] : null,
      fx.length ? [`Remove all effects (${fx.length})`, () => this.commit(() => { tr.fx = []; tr.fxOpen = false; })] : null,
      tr.auto && Object.keys(tr.auto).length ? ['Remove volume and pan automation', () => this.commit(() => { delete tr.auto; })] : null,
      (tr.volume ?? 1) !== 1 || (tr.pan || 0) !== 0 ? ['Reset volume and pan', () => this.commit(() => { tr.volume = 1; tr.pan = 0; })] : null,
      n ? [`Select its ${n} clip${n === 1 ? '' : 's'}`, () => { this.selection.clips = doc.clips.filter(c => c.track === tr.id).map(c => c.id); this.renderAll(); }] : null,
      null,
      doc.tracks.length > 1 ? [n ? `Delete track and its ${n} clip${n === 1 ? '' : 's'}…` : 'Delete track', () => this.removeTrack(tr)] : null,
    ]);
  }
  /** Delete all markers ('all') or just the clap / mark ones ('takes'). Asks first; ⌘Z brings them back. */
  async deleteMarkers(which = 'all') {
    const doc = this.doc; if (!doc) return;
    const hit = m => which === 'all' || m.claps || m.mark;
    const n = (doc.markers || []).filter(hit).length;
    if (!n) { toast(which === 'all' ? 'There are no markers.' : 'There are no clap or mark markers.'); return; }
    if (!(await ask(which === 'all' ? `Delete all ${n} markers?` : `Delete ${n} clap / mark markers?`, which === 'all' ? 'Every marker on the timeline goes (chapters, claps, marks). ⌘Z brings them back.' : 'The ✂ Clap and ◆ Mark markers go, and with them the takes in ✂ TAKES. Your other markers stay. ⌘Z brings them back.', 'Delete'))) return;
    this.commit(d => { d.markers = (d.markers || []).filter(m => !hit(m)); });
    toast(`Deleted ${n} marker${n === 1 ? '' : 's'}. ⌘Z brings them back.`);
  }
  /** Lock / unlock a whole track: its clips can't be moved, trimmed, cut or deleted, ripple edits leave it alone,
   *  and nothing new lands on it. */
  toggleTrackLock(tr) {
    const on = !tr.locked;
    this.commit(d => { const t = d.tracks.find(x => x.id === tr.id); if (t) t.locked = on || undefined; });
    if (on) this.select(this.selection.clips.filter(id => this.doc.clips.find(c => c.id === id)?.track !== tr.id), null);
    toast(on ? `“${tr.name || 'Track'}” is locked: nothing on it can be moved, trimmed, cut or deleted, and edits elsewhere leave it alone.` : `“${tr.name || 'Track'}” is unlocked.`, 4000);
  }
  renameTrack(tr) {
    const input = el('input', { type: 'text', value: tr.name, style: { width: '100%' } });
    modal('Rename track', input, [{ label: 'Rename', cls: 'hw amber', onClick: c => { this.commit(() => { tr.name = input.value.slice(0, 40) || tr.name; }); c(); } }]);
    setTimeout(() => input.select(), 50);
  }

  setRecordingPaused(p) {
    document.body.classList.toggle('rec-paused', !!p);
    $('#btn-record').innerHTML = recKey(p ? 'STOP' : 'STOP', p ? 'PAUSED · PRESS TO SAVE' : 'RECORDING · PRESS TO STOP');
  }
  setRecording(on) {
    document.body.classList.toggle('recording', on);
    if (!on) document.body.classList.remove('rec-paused');
    this.setLamp('rec', on);
    $('#btn-record').innerHTML = on ? recKey('STOP', 'RECORDING · PRESS TO STOP') : recKey('REC', 'SCREEN · CAMERA · MIC');
  }
  showWindowAfterFailure() { /* the main process shows the window when recording ends */ }

  // ---------------------------------------------------------------- commands
  cmd(name) {
    const doc = this.doc, t = this.player.time, sel = this.selection.clips;
    const needDoc = !['new', 'open', 'templates', 'home', 'about', 'settings', 'stop-recording', 'pause-recording', 'discard-recording', 'record', 'sound', 'toggle-smpte', 'explain', 'track-small', 'track-regular', 'track-large', 'toggle-scrub'].includes(name);
    if (needDoc && !doc) return;
    if (name.startsWith('label-')) return ops.setLabel(this, name.slice(6) === 'none' ? '' : name.slice(6));
    if (name.startsWith('remove-section:')) return ops.removeSection(this, name.slice(15));
    switch (name) {
      case 'new': return this.newProject(false);
      case 'open': return this.open(api.openDialog());
      case 'templates': return this.openTemplates();
      case 'save-template': return this.saveTemplate();
      case 'archive': return this.archive();
      case 'home': return this.showHome();
      case 'save': return this.save().then(() => { if (!this.dirty) toast('Saved.'); });
      case 'save-and-close': return this.save().then(() => api.closeNow());
      case 'reveal': return api.reveal(this.token);
      case 'import': return this.importMedia();
      case 'record': if (this.onStopRecording) return this.onStopRecording(); return doc ? openRecorder(this) : this.newProject(true);
      case 'stop-recording': if (this.onStopRecording) this.onStopRecording(); return;
      case 'pause-recording': if (this.onPauseRecording) this.onPauseRecording(); return;
      case 'discard-recording': if (this.onDiscardRecording) this.onDiscardRecording(); return;
      case 'thumbnail': return openThumbnailStudio(this);
      case 'thumb-from-frame': return openThumbnailStudio(this, { frameT: this.player.time });
      case 'aiimage': return openImageGenerator(this);
      case 'export': return openExport(this);
      case 'about': return showAbout();
      case 'help-search': return showAbout('');
      case 'troubleshoot': return showAbout('', 'fix');
      case 'explain': return this.explain.toggle();
      case 'sound': { const r = openMixer(this); setTimeout(() => labelNudge(this), 600); return r; }
      case 'auto-mix': return openAutoMix(this);
      case 'auto-mix-remove': return removeAutoMix(this);
      case 'undo': return this.undo();
      case 'redo': return this.redo();
      case 'play': return this.player.toggle();
      case 'zoom-in': return this.timeline.zoom(1.4);
      case 'zoom-out': return this.timeline.zoom(1 / 1.4);
      case 'zoom-fit': return this.timeline.fit();
      case 'zoom-max': return this.timeline.zoomMax();
      case 'settings': return openSettings(this);
      case 'settings-storage': return openSettings(this, 'storage');
      case 'voice-over': return openVoiceOver(this);
      case 'bounce': return bounceClips(this);
      case 'bounce-revert': return revertClips(this);
      case 'punch-in': return openVoiceOver(this, { punch: true });
      case 'spectral': return openSpectral(this);
      case 'toggle-scrub': { const s = $('#scrub'); s.checked = !s.checked; s.dispatchEvent(new Event('change')); toast(s.checked ? 'Scrub audio on.' : 'Scrub audio off.'); return; }
      case 'select-all': {
        const a = document.activeElement, tag = (a?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || a?.isContentEditable) { if (a.select) a.select(); else document.execCommand('selectAll'); return; }
        this.select(doc.clips.map(c => c.id), null);
        toast(`${doc.clips.length} clips selected. Drag any of them, or ⌥← ⌥→, to move them all.`);
        return;
      }
      case 'select-after': {
        const ids = doc.clips.filter(c => c.start >= t - 1e-6).map(c => c.id);
        this.select(ids, null);
        toast(ids.length ? `${ids.length} clips from the playhead on are selected. Drag one, or ⌥← ⌥→, to shift them.` : 'Nothing starts after the playhead.');
        return;
      }
      case 'add-caption': return textops.addCaption(this);
      case 'captions-import': return textops.importCaptions(this);
      case 'captions-clear': return textops.deleteAllCaptions(this);
      case 'captions-export': return textops.exportCaptions(this, 'srt');
      case 'captions-export-vtt': return textops.exportCaptions(this, 'vtt');
      case 'toggle-caption-lane': this.showCaptionLane = !this.showCaptionLane; this.timeline.render(); return;
      case 'titles': return openTitles(this);
      case 'annotate': return textops.addAnnotation(this);
      case 'tts': return textops.openSpeech(this);
      case 'voices': return textops.openSpeech(this, { engine: 'kitten' });
      // CLONE MY VOICE: from the selected clip if there is one, otherwise read a passage into the microphone
      case 'clone-voice': {
        const sel = doc && doc.clips.find(c => this.selection.clips.includes(c.id) && c.type === 'media');
        return textops.openSpeech(this, sel ? { engine: 'kitten', clone: true } : { engine: 'kitten', record: true });
      }
      case 'freeze': return ops.freezeFrame(this);
      case 'reverse': return ops.toggleReverse(this);
      case 'adr-align': return ops.alignToGuide(this);
      case 'auto-captions': return autoCaptions(this);
      case 'make-vertical': return this.makeVertical();
      case 'auto-edit': return openAutoEdit(this);
      case 'transitions': return openTransitions(this);
      case 'presets': return openPresetBrowser(this);
      case 'styles': return openPresetBrowser(this, 'style');
      case 'film-cuts': return openPresetBrowser(this, 'film');
      case 'l-cut': case 'j-cut': case 'smash-cut': case 'jump-cut': case 'cut-on-action': case 'cutaway': case 'cross-cut':
        return doFilmCut(this, { 'smash-cut': 'smash', 'jump-cut': 'jump', 'cut-on-action': 'action', 'cross-cut': 'cross' }[name] || name);
      case 'callouts': return calloutsMenu(this);
      case 'callouts-plan': return openCalloutPlanner(this);
      case 'callouts-browser': return openPresetBrowser(this, 'element');
      case 'toggle-theme': return toggleTheme();
      case 'text-edit': return textEditor(this);
      case 'speed-up': case 'speed-down': case 'speed-normal': return this.changeSpeed(name.slice(6));
      case 'speed-custom': return this.changeSpeed('custom');
      case 'detach-audio': return ops.detachAudio(this);
      case 'lock': return ops.toggleLock(this);
      case 'disable': {
        const list = this.selection.clips.map(id => this.doc.clips.find(c => c.id === id)).filter(Boolean);
        if (!list.length) { toast('Select a clip to disable or enable it (V).'); return; }
        const off = !list.every(c => c.disabled);
        this.commit(() => { for (const c of list) { if (off) c.disabled = true; else delete c.disabled; } });
        toast(off ? `${list.length > 1 ? `${list.length} clips` : 'Clip'} disabled: kept on the timeline, not seen or heard. V again to enable.` : 'Enabled.');
        return;
      }
      case 'group': return ops.group(this);
      case 'ungroup': return ops.ungroup(this);
      case 'trim-front': return ops.trimToPlayhead(this, 'start');
      case 'trim-end': return ops.trimToPlayhead(this, 'end');
      case 'mark-in': return ops.markIn(this);
      case 'mark-out': return ops.markOut(this);
      case 'clear-inout': return ops.clearInOut(this);
      case 'add-section': return ops.addSection(this);
      case 'keep-part': {
        const on = !this.timeline.marking;
        this.timeline.setMarking(on);
        if (on) toast('Drag across the timeline over each part you want to keep. Grey parts are left out. Press KEEP A PART again (or Esc) when you’re done.', 7000);
        return;
      }
      case 'clear-sections': return ops.clearSections(this);
      case 'copy-style': return ops.copyStyle(this);
      case 'writer': return openWriter(this);
      case 'stabilize': {
        const c = this._visualClip('choose Stabilize'); if (!c) return;
        const m = mediaById(this.doc, c.media);
        if (m?.kind !== 'video') { toast('Stabilize works on video clips.'); return; }
        this.revealSection('Stabilize');
        if (!c.stab) runStabilize(this, c, m);
        return;
      }
      case 'green-screen': return this.greenScreen();
      case 'remove-background': return this.removeBackground();
      case 'pip': return this.pictureInPicture();
      case 'match-colour': return openMatchColour(this);
      case 'ghost': return openGhost(this);
      case 'music-fit': return openMusicFit(this);
      case 'colour-wheels': { const c = this._visualClip('choose Colour wheels'); if (!c) return; if (!(c.filters || []).some(f => f.type === 'grade')) this.commit(() => { c.filters ||= []; c.filters.push({ id: uid('f'), type: 'grade' }); }); this.revealSection('Filters'); return; }
      case 'copy-effects': return ops.copyEffects(this);
      case 'paste-effects': return ops.pasteEffects(this);
      case 'paste-style': return ops.pasteStyle(this, false);
      case 'paste-properties': return ops.pasteStyle(this, true);
      case 'save-frame': return ops.saveFrame(this);
      case 'delete-unused': return ops.deleteUnusedMedia(this);
      case 'global-library': return this.openGlobalLibrary();
      case 'close-gap': return ops.closeGapAt(this, false);
      case 'close-gap-all': return ops.closeGapAt(this, true);
      case 'close-all-gaps': return ops.closeAllGapsOn(this);
      case 'insert-gap': return ops.insertGap(this, 1);
      case 'delete-inout': return ops.deleteRange(this, 'inout');
      case 'delete-markers': return ops.deleteRange(this, 'markers');
      case 'delete-all-markers': return this.deleteMarkers('all');
      case 'clip-marker': return ops.addClipMarker(this);
      case 'rename-clip': return ops.renameClip(this);
      case 'toggle-smpte': this.setPref('smpte', !timeFormat.smpte); return;
      case 'track-small': case 'track-regular': case 'track-large': this.setPref('trackH', name.slice(6)); return;
      case 'nudge-left': case 'nudge-right': return this.nudge(name === 'nudge-left' ? -1 : 1, false);
      case 'split': {
        const ids = sel.length ? sel : null;
        let made = [];
        this.commit(d => { made = split(d, t, ids); });
        if (!made.length) toast('Put the playhead inside a clip to splice it.');
        else this.timeline.spliceMark?.(t);
        return;
      }
      case 'delete': case 'ripple-delete':
        if (name === 'delete' && this.timeline.deleteSelectedPoint?.()) return;
        if (this.selection.caption) {
          const id = this.selection.caption;
          this.commit(d => { d.captions = (d.captions || []).filter(c => c.id !== id); });
          this.selectCaption(null); return;
        }
        if (this.selection.action && sel.length === 1) {
          const c = doc.clips.find(x => x.id === sel[0]);
          this.commit(() => { c.actions = c.actions.filter(a => a.id !== this.selection.action); });
          this.selection.action = null; this.inspector.render(); return;
        }
        if (!sel.length) return;
        this.commit(d => remove(d, sel, name === 'ripple-delete' || !!pref('autoCloseGaps')));
        this.select([], null);
        return;
      case 'close-gaps': {
        let r = { closed: 0 };
        const gaps = findGaps(doc).length;
        if (!gaps) { toast('No gaps: there’s no empty space in the edit.'); return; }
        this.commit(d => { r = closeGaps(d); });
        toast(r.closed ? `Closed ${r.closed} gap${r.closed === 1 ? '' : 's'}: ${r.seconds.toFixed(1)} s of empty space removed, every track kept in sync.${r.skipped ? ` ${r.skipped} left because a locked track has clips after ${r.skipped === 1 ? 'it' : 'them'}.` : ''}` : 'Those gaps are before clips on a locked track, so they were left (unlock the track to close them).', 5000);
        return;
      }
      case 'duplicate': {
        if (!sel.length) return;
        const ids = [], regroup = new Map(); // copies of a group are grouped together, apart from the originals
        this.commit(d => {
          for (const id of sel) {
            const c = d.clips.find(x => x.id === id);
            const copy = structuredClone(c); copy.id = uid('c');
            if (c.group) { if (!regroup.has(c.group)) regroup.set(c.group, uid('g')); copy.group = regroup.get(c.group); }
            copy.start = clipEnd(c);
            copy.track = freeTrack(d, copy.start, copy.duration, c.track);
            for (const a of copy.actions) a.id = uid('a');
            d.clips.push(copy); ids.push(copy.id);
          }
        });
        this.select(ids, null);
        return;
      }
      case 'find-claps': return openClapFinder(this);
      case 'takes': return openTakes(this);
      case 'master': return openMaster(this);
      case 'autoedit-clip': if (sel.length) return openClipAutoEdit(this, sel[0]); toast('Select a clip first (or right-click it).'); return;
      case 'marker': this.commit(d => { d.markers.push({ id: uid('k'), t, label: `Chapter ${d.markers.length + 1}` }); d.markers.sort((a, b) => a.t - b.t); }); return;
      case 'insert-text': return this._insert(newTextClip(null, t, doc.name));
      case 'insert-callout': return this._insert(newCalloutClip(null, t));
      case 'insert-shape': return this._insert(newShapeClip(null, t));
      case 'insert-action': return this.insertAction();
      case 'snapback': return this.insertSnapback();
      case 'auto-zoom': return this.autoZoom();
      case 'timelapse': return this.timeLapse();
      default: return;
    }
  }

  // ---------------------------------------------------------------- preview zoom
  /** zoom: 'fit' or a size where 1 = 100% (one picture pixel per screen pixel). Keeps the point at `at` still. */
  setPreviewZoom(zoom, at) {
    const pl = this.player, stage = $('#stage');
    const before = pl.displayScale || 1;
    this.previewPan ||= { x: 0, y: 0 };
    if (zoom === 'fit') this.previewPan = { x: 0, y: 0 };
    this.previewZoom = zoom === 'fit' ? 'fit' : String(zoom);
    pl.resize();
    if (zoom !== 'fit' && at) {
      // the picture point under the pointer stays under the pointer
      const r = stage.getBoundingClientRect(), k = pl.displayScale / before;
      const px = at.clientX - (r.left + r.width / 2), py = at.clientY - (r.top + r.height / 2);
      this.previewPan.x = px - (px - this.previewPan.x) * k;
      this.previewPan.y = py - (py - this.previewPan.y) * k;
      pl.resize();
    }
    this._zoomLabel();
  }
  _zoomLabel() {
    const sel = $('#preview-zoom');
    if (this.previewZoom === 'fit') { sel.value = 'fit'; return; }
    const pct = Math.round(Number(this.previewZoom) * 100);
    let opt = sel.querySelector('option[data-custom]');
    const fixed = [...sel.options].find(o => !o.dataset.custom && o.value !== 'fit' && Math.round(Number(o.value) * 100) === pct);
    if (fixed) { opt?.remove(); sel.value = fixed.value; return; }
    if (!opt) { opt = el('option', { 'data-custom': '1' }); sel.append(opt); }
    opt.value = this.previewZoom; opt.textContent = pct + '%';
    sel.value = opt.value;
  }
  /** Mouse wheel or trackpad pinch over the preview zooms it around the pointer; sideways scroll,
   *  ⇧-wheel, middle-drag or dragging the empty stage pans when zoomed in; double-click the stage to fit. */
  _wirePreviewZoom() {
    const stage = $('#stage'), dpr = () => devicePixelRatio || 1;
    stage.addEventListener('wheel', e => {
      if (!this.doc) return;
      e.preventDefault();
      const pl = this.player, pan = this.previewPan ||= { x: 0, y: 0 };
      const zoomed = this.previewZoom !== 'fit' && pl.displayScale > pl.fitScale * 1.001;
      const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.5;
      if (!e.ctrlKey && (sideways || e.shiftKey)) { // pan
        if (!zoomed) return;
        if (sideways) { pan.x -= e.deltaX; pan.y -= e.deltaY; } else pan.x -= e.deltaY; // ⇧-wheel pans sideways
        pl.resize(); return;
      }
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const step = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0022)); // pinch reports small deltas
      const cur = pl.displayScale * dpr();               // current size, 1 = 100%
      const fit = pl.fitScale * dpr();
      let next = Math.max(fit * 0.25, Math.min(8, cur * step));
      if (Math.abs(next / fit - 1) < 0.04) { this.setPreviewZoom('fit'); return; } // snaps to Fit on the way through
      if (Math.abs(next - 1) < 0.03) next = 1;                                   // and to 100%
      this.setPreviewZoom(next, e);
    }, { passive: false });
    let drag = null;
    stage.addEventListener('pointerdown', e => {
      const onPicture = e.target === this.player.canvas || e.target.closest('#overlay .sel-box, #overlay .draw-pad');
      if (!(e.button === 1 || (e.button === 0 && !onPicture && (e.target === stage || e.target.id === 'overlay')))) return;
      if (this.previewZoom === 'fit' && e.button === 1) { // the hand at Fit: zoom in a step so there's somewhere to move to
        e.preventDefault(); this.setPreviewZoom(Math.min(8, this.player.displayScale * (devicePixelRatio || 1) * 1.5), e);
      } else if (this.previewZoom === 'fit') return;
      e.preventDefault();
      const pan = this.previewPan ||= { x: 0, y: 0 };
      drag = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y, id: e.pointerId };
      stage.setPointerCapture(e.pointerId); stage.classList.add('panning');
    });
    stage.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      this.previewPan.x = drag.px + e.clientX - drag.x; this.previewPan.y = drag.py + e.clientY - drag.y;
      this.player.resize();
    });
    const end = e => { if (drag && e.pointerId === drag.id) { drag = null; stage.classList.remove('panning'); } };
    stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
    stage.addEventListener('dblclick', e => { if (e.target === stage || e.target.id === 'overlay') this.setPreviewZoom('fit'); });
  }

  // ---------------------------------------------------------------- proxies
  proxyMenu(btn) {
    const p = proxyPrefs(), r = btn.getBoundingClientRect(), st = this.proxies.status();
    const set = next => {
      const before = proxyPrefs();
      setProxyPrefs(next);
      const after = proxyPrefs();
      if (after.size !== before.size) this.proxies.cancel();
      if (this.doc) { for (const m of this.doc.media) delete m.proxyFailed; for (const m of this.doc.media) this.player.reloadMedia(m.id); }
      if (after.mode === 'off') this.proxies.cancel(); else this.proxies.kick();
      this._proxyLabel(this.proxies.status());
    };
    const tick = on => (on ? '✓ ' : '\u2003 ');
    popMenu(r.left, r.bottom + 4, [
      [tick(p.mode === 'auto') + 'Automatic: 4K, HEVC and ProRes', () => set({ mode: 'auto' })],
      [tick(p.mode === 'always') + 'Every video', () => set({ mode: 'always' })],
      [tick(p.mode === 'off') + 'Off: play the originals', () => set({ mode: 'off' })],
      null,
      [tick(p.size === 'auto') + 'Size: choose automatically', () => set({ size: 'auto' })],
      [tick(p.size === 'half') + 'Half size', () => set({ size: 'half' })],
      [tick(p.size === 'quarter') + 'Quarter size (slower Macs)', () => set({ size: 'quarter' })],
      null,
      st.busy ? ['Stop making proxies', () => this.proxies.cancel()] : ['Make proxies now', this.doc && p.mode !== 'off' ? () => { this.proxies.kick(true); if (!this.proxies.status().busy) toast('Every video here already has its proxy (or doesn’t need one).'); } : null],
      ['Media & cache settings…', () => this.cmd('settings-storage')],
      ['Export and thumbnails always use the originals', null],
    ]);
  }
  _proxyLabel(st) {
    const b = $('#btn-proxy');
    if (!b) return;
    const mode = proxyPrefs().mode;
    b.classList.toggle('lit', mode !== 'off');
    b.classList.toggle('working', st.busy);
    b.querySelector('span').textContent = st.busy ? `PROXY ${Math.min(st.total, st.done + 1)}/${st.total} ${Math.round(st.progress * 100)}%` : mode === 'off' ? 'PROXY OFF' : mode === 'always' ? 'PROXY ALL' : 'PROXY AUTO';
    b.title = st.busy ? `Making an editing proxy of “${st.name}” in the background. You can keep working.` : 'Proxy editing: the preview plays smaller copies of big videos so it stays smooth. Export always uses the full-quality originals.';
  }

  /** View preferences kept per Mac (SMPTE timecode, track height). */
  setPref(k, v) {
    try { localStorage.setItem('reel.' + k, JSON.stringify(v)); } catch { /* fine */ }
    this.applyPrefs();
    if (this.doc) this.renderAll();
  }
  applyPrefs() {
    applyMode();
    let p = {};
    try { p = { smpte: JSON.parse(localStorage.getItem('reel.smpte') || 'false'), trackH: JSON.parse(localStorage.getItem('reel.trackH') || '"regular"') }; } catch { /* defaults */ }
    timeFormat.smpte = !!p.smpte;
    timeFormat.fps = this.doc?.canvas.fps || 30;
    document.documentElement.style.setProperty('--track-h', (({ small: 44, regular: 58, large: 84 })[p.trackH] || 58) + 'px');
  }

  /** Moves the selected clips by one frame (or one second with ⇧), all together, if there's room. */
  nudge(dir, big) {
    const doc = this.doc, ids = this.selection.clips;
    if (!ids.length) return;
    const step = big ? 1 : 1 / (doc.canvas.fps || 30);
    const clips = doc.clips.filter(c => ids.includes(c.id) && !c.locked);
    if (!clips.length) return;
    const d = Math.max(dir * step, -Math.min(...clips.map(c => c.start)));
    if (Math.abs(d) < 1e-9) return;
    if (!clips.every(c => isFree(doc, c.track, c.start + d, c.duration, ids))) { toast('Something is in the way.'); return; }
    this.commit(() => { for (const c of clips) c.start += d; });
  }

  _insert(c) {
    this.commit(doc => {
      // overlays go on the top track (adding one above if it's busy)
      c.track = isFree(doc, doc.tracks[0].id, c.start, c.duration) ? doc.tracks[0].id : addTrack(doc, 0).id;
      doc.clips.push(c);
    });
    this.select([c.id], null);
  }

  insertAction() {
    const t = this.player.time;
    let c = this.selection.clips.length === 1 ? this.doc.clips.find(x => x.id === this.selection.clips[0]) : null;
    if (!c || t < c.start || t >= clipEnd(c)) {
      // the top visible clip under the playhead
      c = this.doc.tracks.map(tr => this.doc.clips.find(x => x.track === tr.id && t >= x.start && t < clipEnd(x) && x.type !== 'callout')).find(Boolean);
    }
    if (!c) { toast('Put the playhead over a clip first.'); return; }
    const local = t - c.start;
    const id = uid('a');
    this.commit(() => {
      const now = propsAt({ ...c, transIn: null, transOut: null }, local);
      const props = {};
      for (const k of ['x', 'y', 'scale']) props[k] = now[k];
      // a first action on a full-frame clip zooms in a little so the change is visible
      if (!(c.actions || []).length && Math.abs(now.scale - 1) < 0.01) props.scale = 1.5;
      c.actions.push({ id, t: Math.max(0, Math.min(local, c.duration - 0.2)), dur: Math.min(1, Math.max(0.1, c.duration - local)), ease: 'ease', props });
    });
    this.select([c.id], id);
    this.seek(c.start + local + 1);
    toast('Action added. Drag or resize the clip in the preview to set where it moves.');
  }

  /** Snapback: an action at the playhead that returns to how things were before the previous action. */
  insertSnapback() {
    const t = this.player.time;
    const c = this.selection.clips.length === 1 ? this.doc.clips.find(x => x.id === this.selection.clips[0]) : null;
    if (!c || t < c.start || t >= clipEnd(c)) { toast('Select a clip and put the playhead inside it.'); return; }
    const local = t - c.start;
    const prior = [...(c.actions || [])].sort((a, b) => b.t - a.t).find(a => a.t + a.dur <= local + 1e-3);
    if (!prior) { toast('A snapback needs an earlier action on this clip to return from.'); return; }
    const before = propsAt({ ...c, actions: c.actions.filter(a => a.t < prior.t), transIn: null, transOut: null }, prior.t);
    const props = {};
    for (const k of Object.keys(prior.props || {})) if (k in before) props[k] = Array.isArray(before[k]) ? [...before[k]] : before[k];
    const id = uid('a');
    this.commit(() => { c.actions.push({ id, t: Math.min(local, c.duration - 0.1), dur: Math.min(prior.dur || 0.6, Math.max(0.1, c.duration - local)), ease: prior.ease || 'ease', props, snapback: true }); });
    this.select([c.id], id);
    toast('Snapback added: it returns to how the clip looked before the last action.');
  }

  /** SELECT's hold menu: the Select tool, select all, or all clips of one kind, then move them together. */
  /** Hold SELECT: pick the select tool. → one item at a time, or ⇉ everything to the right on every track. */
  selectToolPop(btn) {
    document.querySelector('.seltool-pop')?.remove();
    const pick = (tool, icon, name, hint) => {
      const k = el('button', { type: 'button', class: 'seltool' + (this.timeline.tool === tool ? ' on' : ''), title: hint },
        el('span', { class: 'seltool-icon', text: icon }), el('b', { text: name }), el('small', { text: hint }));
      k.addEventListener('click', () => {
        this.timeline.setTool(tool); pop.remove();
        if (tool === 'forward') toast('Select forward: click on the timeline and everything to the right is selected, on every track (video, audio, text). Drag to move it all. Press A for the normal select tool.', 6000);
      });
      return k;
    };
    const pop = el('div', { class: 'seltool-pop' },
      pick('select', '→', 'SELECT', 'One item at a time (⌘-click adds more)'),
      pick('forward', '⇉', 'SELECT FORWARD', 'Everything to the right of where you click, on every track'),
      el('button', { type: 'button', class: 'seltool-more', text: 'MORE SELECTIONS ▸', title: 'Select all, all video, all audio, everything on one track…', onclick: () => { pop.remove(); this.selectMenu(btn); } }));
    document.body.append(pop);
    const r = btn.getBoundingClientRect(), pr = pop.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(innerWidth - pr.width - 8, r.left)) + 'px';
    pop.style.top = (r.bottom + 6 + pr.height < innerHeight ? r.bottom + 6 : r.top - pr.height - 6) + 'px';
    const away = e => { if (!pop.contains(e.target) && e.target !== btn) { pop.remove(); document.removeEventListener('pointerdown', away, true); } };
    setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
  }
  selectMenu(btn) {
    const doc = this.doc;
    if (!doc) return;
    const kind = c => {
      if (c.type !== 'media') return { text: 'text', callout: 'graphic', shape: 'graphic', draw: 'graphic' }[c.type] || 'other';
      const k = mediaById(doc, c.media)?.kind;
      return c.audioOnly || k === 'audio' ? 'audio' : k === 'image' ? 'image' : 'video';
    };
    const t = this.player.time;
    const pick = (label, test) => {
      const ids = doc.clips.filter(test).map(c => c.id);
      return [`${label}  (${ids.length})`, ids.length ? () => {
        this.select(ids, null);
        toast(`${ids.length} clip${ids.length === 1 ? '' : 's'} selected. Drag any one of them, or ⌥← ⌥→, to move them all together. ⌘-click to add or drop one.`, 4500);
      } : null];
    };
    const selTrack = doc.clips.find(c => c.id === this.selection.clips[0])?.track;
    const trName = selTrack && doc.tracks.find(x => x.id === selTrack)?.name;
    const r = btn.getBoundingClientRect();
    popMenu(r.left, r.top - 4, [
      ['▲ Select tool: click clips one at a time (⌘-click adds)', () => { this.timeline.setTool('select'); }, 'A'],
      null,
      pick('Select all', () => true),
      pick('All video', c => kind(c) === 'video'),
      pick('All audio', c => kind(c) === 'audio'),
      pick('All text and titles', c => kind(c) === 'text'),
      pick('All pictures', c => kind(c) === 'image'),
      pick('All callouts, arrows and drawings', c => kind(c) === 'graphic'),
      null,
      selTrack ? pick(`Everything on ${trName || 'this track'}`, c => c.track === selTrack) : ['Everything on a track (select a clip on it first)', null],
      pick('Everything from the playhead on', c => c.start >= t - 1e-6),
      pick('Everything before the playhead', c => c.start + c.duration <= t + 1e-6),
      null,
      ['Select none', this.selection.clips.length ? () => this.select([], null) : null, 'Esc'],
    ]);
    const menu = document.querySelector('.pop-menu');
    if (menu) { const mr = menu.getBoundingClientRect(); menu.style.top = Math.max(8, r.top - mr.height - 6) + 'px'; } // open upward, above the tool strip
  }

  /** Smart Zoom: zoom/pan actions for any video, from its motion and cuts (or a Reel recording's pointer). */
  async autoZoom() {
    const doc = this.doc;
    if (!doc) return;
    const isVid = c => c.type === 'media' && !c.audioOnly && ['video', 'image'].includes(mediaById(doc, c.media)?.kind);
    const sel = doc.clips.filter(c => this.selection.clips.includes(c.id) && isVid(c));
    const all = doc.clips.filter(isVid);
    if (!all.length) { toast('Add a video to the timeline first, then Smart Zoom it.'); return; }
    const prefs = smartZoomPrefs();
    const hasPointer = (sel.length ? sel : all).some(c => mediaById(doc, c.media)?.cursor);
    let style = prefs.style, strength = prefs.strength, usePointer = hasPointer;
    const styleRows = el('div', { class: 'sz-styles' }, ...Object.entries(ZOOM_STYLES).map(([k, st]) => {
      const b = el('button', { class: 'starter' + (k === style ? ' lit' : ''), type: 'button' }, el('b', { text: st.label }), el('small', { text: st.hint }));
      b.addEventListener('click', () => { style = k; for (const x of styleRows.children) x.classList.toggle('lit', x === b); });
      return b;
    }));
    const amt = el('input', { type: 'range', min: 0.4, max: 1.6, step: 0.05, value: strength });
    const amtOut = el('span', { class: 'engr small', text: Math.round(strength * 100) + '%' });
    const INTENSITY = [['Subtle', 0.55, 'Gentle push-ins, barely noticed'], ['Medium', 1, 'Clear zooms on the action'], ['Heavy', 1.5, 'Big, punchy zooms']];
    const intens = el('div', { class: 'seg sz-int' }, ...INTENSITY.map(([t, v, h]) => el('button', { type: 'button', text: t, title: h, onclick: () => { strength = v; amt.value = v; amtOut.textContent = Math.round(v * 100) + '%'; lightInt(); } })));
    const lightInt = () => { for (const [i, b] of [...intens.children].entries()) b.classList.toggle('on', Math.abs(INTENSITY[i][1] - strength) < 0.08); };
    amt.addEventListener('input', () => { strength = Number(amt.value); amtOut.textContent = Math.round(strength * 100) + '%'; lightInt(); });
    lightInt();
    const scope = el('select', {}, el('option', { value: 'sel', text: `The selected clip${sel.length === 1 ? '' : 's'} (${sel.length})`, disabled: !sel.length }), el('option', { value: 'all', text: `Every video clip (${all.length})` }));
    scope.value = sel.length ? 'sel' : 'all';
    const ptr = el('input', { type: 'checkbox', checked: hasPointer, disabled: !hasPointer });
    ptr.addEventListener('change', () => { usePointer = ptr.checked; });
    const onDrop = el('input', { type: 'checkbox', checked: prefs.onDrop });
    const packSel = el('select', { title: 'Transitions at every cut it finds (shot changes inside clips, and where clips meet)' }, el('option', { value: '', text: 'None' }), ...Object.entries(PACKS).map(([k, p]) => el('option', { value: k, text: `${p.name} — ${p.hint}`, selected: prefs.pack === k })));
    const sfxCb = el('input', { type: 'checkbox', checked: prefs.packSounds !== false });
    const body = el('div', { class: 'newdoc' },
      el('p', { class: 'note', text: 'Reel watches the picture, finds where things move, where the shots cut and where the detail is, and adds zoom and pan actions. Each one shows on the clip and can be moved, changed or deleted. Existing zoom/pan actions on these clips are replaced.' }),
      el('div', { class: 'engr', text: 'Style' }), styleRows,
      el('div', { class: 'row' }, el('label', { text: 'Intensity' }), intens),
      el('div', { class: 'row' }, el('label', { text: 'Fine tune' }), amt, amtOut),
      el('div', { class: 'row' }, el('label', { text: 'Apply to' }), scope),
      el('label', { class: 'row' }, ptr, el('span', { text: hasPointer ? 'Follow the recorded pointer on Reel screen recordings' : 'Follow the recorded pointer (only Reel screen recordings have one)' })),
      el('label', { class: 'row' }, onDrop, el('span', { text: 'Do this by itself for every video I drop on the timeline' })),
      el('div', { class: 'engr', text: 'Transitions' }),
      el('div', { class: 'row' }, el('label', { text: 'At the cuts it finds' }), packSel),
      el('label', { class: 'row' }, sfxCb, el('span', { text: 'With matching sound effects (whooshes, hits…)' })));
    modal('Smart Zoom', body, [
      { label: 'Cancel', onClick: c => c() },
      { label: 'Zoom it', cls: 'hw amber', onClick: c => {
        c();
        setSmartZoomPrefs({ style, strength, onDrop: onDrop.checked, pack: packSel.value, packSounds: sfxCb.checked });
        this.smartZoom((scope.value === 'sel' ? sel : all).map(x => x.id), { style, strength, usePointer, pack: packSel.value, packSounds: sfxCb.checked });
      } },
    ]);
  }

  /**
   * Time-lapse: pick a preset (YouTube 60 s, Shorts 30 s, speed art, skip the waiting, a length), and the
   * selected video is sped up to it, faster where little happens and slower on the action, with eased changes
   * of speed; Smart Zoom can run on the result too.
   */
  async timeLapse() {
    const doc = this.doc;
    if (!doc) return;
    const isVid = c => c.type === 'media' && !c.audioOnly && mediaById(doc, c.media)?.kind === 'video';
    const clips = doc.clips.filter(c => this.selection.clips.includes(c.id) && isVid(c)).sort((a, b) => b.start - a.start);
    if (!clips.length) { toast('Select the video clip to time-lapse first.'); return; }
    let prefs = {}; try { prefs = JSON.parse(localStorage.getItem('reel.timelapse') || '{}'); } catch { /* defaults */ }
    let preset = LAPSE_PRESETS.find(p => p.id === prefs.preset) || LAPSE_PRESETS[0];
    const srcTotal = clips.reduce((m, c) => m + c.duration * (c.speed || 1), 0);
    const lenIn = el('input', { type: 'text', value: prefs.length || '1:00', style: { width: '80px' }, title: 'Seconds, or minutes:seconds' });
    const lenRow = el('div', { class: 'row' }, el('label', { text: 'Length' }), lenIn, el('span', { class: 'note', text: `(the clip${clips.length > 1 ? 's' : ''} now: ${fmtTime(clips.reduce((m, c) => m + c.duration, 0))})` }));
    const cards = el('div', { class: 'sz-styles' }, ...LAPSE_PRESETS.map(p => {
      const b = el('button', { class: 'starter' + (p === preset ? ' lit' : ''), type: 'button' }, el('b', { text: p.label }), el('small', { text: p.hint }));
      b.addEventListener('click', () => { preset = p; for (const x of cards.children) x.classList.toggle('lit', x === b); lenRow.style.display = p.ask ? '' : 'none'; sound.value = p.sound; });
      return b;
    }));
    lenRow.style.display = preset.ask ? '' : 'none';
    const sound = el('select', {}, el('option', { value: 'mute', text: 'Mute it (add music instead)' }), el('option', { value: 'keep', text: 'Keep it, at the same pitch' }));
    sound.value = prefs.sound || preset.sound;
    const zoom = el('input', { type: 'checkbox', checked: prefs.zoom !== false });
    const tPack = el('select', { title: 'Transitions where the time-lapse jumps between scenes' }, el('option', { value: '', text: 'No transitions' }), ...Object.entries(PACKS).map(([k, p]) => el('option', { value: k, text: `${p.name} transitions`, selected: prefs.pack === k })));
    const zInt = el('select', { title: 'How strong the zooms are' }, ...[[0.55, 'Subtle'], [1, 'Medium'], [1.5, 'Heavy']].map(([v, t]) => el('option', { value: v, text: t, selected: Number(prefs.zoomStrength || 1) === v })));
    const body = el('div', { class: 'newdoc' },
      el('p', { class: 'note', text: `Reel watches the video${clips.some(c => mediaById(doc, c.media)?.cursor) ? ' (and your clicks and typing)' : ''}, then speeds through the quiet stretches and keeps the action watchable, easing between speeds. The clip becomes a row of pieces at different speeds; ⌘Z undoes it all.` }),
      el('div', { class: 'engr', text: 'Preset' }), cards, lenRow,
      el('div', { class: 'row' }, el('label', { text: 'Sound' }), sound),
      el('label', { class: 'row' }, zoom, el('span', { text: 'Smart Zoom it too (zooms in on the action)' }), zInt),
      el('div', { class: 'row' }, el('label', { text: 'Transitions' }), tPack));
    modal('Time-lapse', body, [
      { label: 'Cancel', onClick: c => c() },
      { label: 'Make time-lapse', cls: 'hw amber', onClick: c => {
        const parts = String(lenIn.value).trim().split(':').map(Number);
        const length = parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0];
        if (preset.ask && !(length > 0.5)) { toast('Type a length, like 45 or 1:30.'); return; }
        c();
        try { localStorage.setItem('reel.timelapse', JSON.stringify({ preset: preset.id, length: lenIn.value, sound: sound.value, zoom: zoom.checked, zoomStrength: Number(zInt.value), pack: tPack.value })); } catch { /* fine */ }
        this._runTimeLapse(clips, preset, preset.ask ? length : null, sound.value, zoom.checked ? Number(zInt.value) : 0, srcTotal, tPack.value);
      } },
    ]);
  }
  async _runTimeLapse(clips, preset, length, sound, zoom, srcTotal, pack = '') {
    const token = this.token, ctl = new AbortController();
    const bar = el('div', { class: 'progress' }, el('i')), what = el('p', { class: 'note', text: 'Watching the video…' });
    const dlg = modal('Time-lapse', el('div', {}, what, bar), [{ label: 'Stop', onClick: c => c() }], { onClose: () => ctl.abort() });
    const made = [];
    try {
      for (const [k, c0] of clips.entries()) {
        const c = this.doc.clips.find(x => x.id === c0.id), m = c && mediaById(this.doc, c.media);
        if (!m) continue;
        what.textContent = `Watching “${c.name || m.name}”${clips.length > 1 ? ` (${k + 1} of ${clips.length})` : ''}…`;
        const res = await zoomAnalyse(this, c, m, { signal: ctl.signal, onProgress: v => { bar.firstChild.style.width = Math.round(((k + v) / clips.length) * 100) + '%'; } });
        if (this.token !== token) return;
        const cursor = m.cursor ? await api.readJson(token, m.cursor).catch(() => null) : null;
        const srcLen = c.duration * (c.speed || 1);
        // the target shared out by each clip's share of the source
        const target = length ? length * (srcLen / srcTotal) : preset.target ? preset.target * (srcLen / srcTotal) : null;
        const segs = lapsePlan(activityOf(res.samples, c.speed || 1, cursor, m.cursorOffset || 0, c.in || 0), srcLen,
          { mode: preset.mode, target, factor: preset.factor, maxSpeed: preset.mode === 'skip' ? 8 : 64 });
        let r = null;
        this.commit(doc => { r = lapseApply(doc, doc.clips.find(x => x.id === c.id), segs, { sound }); });
        made.push(...r.pieces.filter(id => this.doc.clips.find(x => x.id === id && !x.audioOnly && mediaById(this.doc, x.media)?.kind === 'video')));
        what.textContent = `${fmtTime(r.before)} → ${fmtTime(r.after)} in ${r.pieces.length} pieces.`;
      }
    } catch (e) { if (!ctl.signal.aborted) toast(e.message, 5000); return; } finally { dlg.close(); }
    toast(`Time-lapse done${made.length ? `: ${made.length} pieces` : ''}. ⌘Z undoes it.`, 4000);
    if (zoom && made.length) this.smartZoom(made, { style: 'follow', strength: zoom === true ? 1 : zoom, usePointer: true, pack, packFilter: speedJump });
    else if (pack && made.length) { const n = await autoTransitions(this, pack, { clipIds: made, shots: null, filter: speedJump }); if (n) toast(`${PACKS[pack].name} transitions on ${n} cuts.`); }
  }

  /** Smart Zoom on drop, when switched on in the Smart Zoom window. */
  _autoZoomDropped(ids) {
    const p = smartZoomPrefs();
    if (!p.onDrop || !ids.length) return;
    setTimeout(() => this.smartZoom(ids, { style: p.style, strength: p.strength, usePointer: true, quiet: true }), 400);
  }

  /**
   * Make Vertical: a wide edit re-framed for 9:16 (or 4:5, 1:1). Full-frame pictures fill the new frame and
   * follow the action (the recorded pointer, otherwise where things move), or sit over a blurred copy of
   * themselves; titles shrink with the frame. One undo step.
   */
  makeVertical() {
    const doc = this.doc; if (!doc) return;
    const W0 = doc.canvas.width, H0 = doc.canvas.height;
    let fmt = H0 > W0 ? 'portrait' : 'vertical', mode = 'follow';
    // a picture of the result: the current frame, reframed the way each choice would do it
    const frame = this.player.canvas;
    const shot = document.createElement('canvas'); shot.width = 480; shot.height = Math.round(480 * H0 / W0);
    try { shot.getContext('2d').drawImage(frame, 0, 0, shot.width, shot.height); } catch { /* blank */ }
    const PH = 200;
    const draw = (cv, f, how) => {
      const w = Math.round(PH * f.w / f.h); cv.width = w * 2; cv.height = PH * 2; cv.style.width = w + 'px'; cv.style.height = PH + 'px';
      const g = cv.getContext('2d'), CW = cv.width, CH = cv.height, sw = shot.width, sh = shot.height;
      g.fillStyle = '#000'; g.fillRect(0, 0, CW, CH);
      const cover = Math.max(CW / sw, CH / sh), fit = Math.min(CW / sw, CH / sh);
      if (how === 'blur' || how === 'zoom' || how === 'bars') {
        if (how !== 'bars') {
          g.filter = how === 'blur' ? 'blur(10px) brightness(0.7)' : 'brightness(0.9)';
          g.drawImage(shot, (CW - sw * cover) / 2, (CH - sh * cover) / 2, sw * cover, sh * cover); g.filter = 'none';
        }
        g.drawImage(shot, (CW - sw * fit) / 2, (CH - sh * fit) / 2, sw * fit, sh * fit);
        if (how === 'zoom') { g.fillStyle = 'rgba(255,255,255,0.85)'; const y0 = (CH - sh * fit) / 2; g.fillRect(0, y0 - 2, CW, 2); g.fillRect(0, y0 + sh * fit, CW, 2); }
      } else {
        // follow: the window slides toward the action (shown a little off-centre with arrows)
        const off = how === 'follow' ? (sw * cover - CW) * 0.18 : 0;
        g.drawImage(shot, (CW - sw * cover) / 2 - off, (CH - sh * cover) / 2, sw * cover, sh * cover);
        if (how === 'follow') {
          g.fillStyle = 'rgba(255,190,70,0.95)'; g.font = `bold ${Math.round(CW * 0.16)}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText('◀ ▶', CW / 2, CH - CW * 0.16);
        }
      }
      g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 3; g.strokeRect(1.5, 1.5, CW - 3, CH - 3);
    };
    // the source frame with the part that stays outlined
    const src = document.createElement('canvas');
    const drawSrc = () => {
      const f = VFORMATS[fmt], h = 120, w = Math.round(h * W0 / H0);
      src.width = w * 2; src.height = h * 2; src.style.width = w + 'px'; src.style.height = h + 'px';
      const g = src.getContext('2d'); g.drawImage(shot, 0, 0, src.width, src.height);
      if (mode === 'blur' || mode === 'zoom' || mode === 'bars') return;
      const cw = Math.min(src.width, src.height * f.w / f.h), off = mode === 'follow' ? (src.width - cw) * 0.32 : 0, x = (src.width - cw) / 2 - off;
      g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(0, 0, x, src.height); g.fillRect(x + cw, 0, src.width - x - cw, src.height);
      g.strokeStyle = '#ffb02a'; g.lineWidth = 4; g.strokeRect(x + 2, 2, cw - 4, src.height - 4);
    };
    const big = document.createElement('canvas');
    const summary = el('p', { class: 'vt-summary' });
    const HOW = {
      follow: ['Follow the action', 'The frame fills the phone screen and slides to keep the pointer or whatever is moving in view, like a camera operator. Reel watches each video first (a few seconds per minute).'],
      center: ['Centre crop', 'The frame fills the phone screen and always shows the middle of the picture. Quick; good when the action is centred.'],
      blur: ['Whole picture on a blurred copy', 'Nothing is cut off: the full picture sits in the middle, over a blurred, darkened copy that fills the rest of the screen.'],
      zoom: ['Whole picture on a zoomed copy', 'Nothing is cut off: the full picture sits in the middle, and a zoomed-in copy of it fills the top and bottom, so the picture seems to carry on.'],
      bars: ['Whole picture, black bars', 'Nothing is cut off: the full picture in the middle, with black above and below.'],
    };
    const update = () => {
      draw(big, VFORMATS[fmt], mode); drawSrc();
      const f = VFORMATS[fmt];
      summary.textContent = `Your ${W0} × ${H0} edit becomes ${f.w} × ${f.h} (${f.label.split(' — ')[0]}). ${HOW[mode][1]} Titles and picture-in-picture keep their places. ⌘Z undoes it all.`;
      for (const b of cards.children) b.classList.toggle('lit', b.dataset.k === fmt);
      for (const b of modes.children) b.classList.toggle('lit', b.dataset.k === mode);
    };
    const cards = el('div', { class: 'vt-choices' }), modes = el('div', { class: 'vt-choices' });
    for (const [k, f] of Object.entries(VFORMATS)) {
      const [ratio, use] = f.label.split(' — ');
      const shape = el('i', { class: 'vt-shape', style: { width: Math.round(30 * f.w / f.h) + 'px', height: '30px' } });
      const b = el('button', { class: 'vt-card', type: 'button', 'data-k': k }, shape, el('span', {}, el('b', { text: ratio }), el('small', { text: use || `${f.w} × ${f.h}` })));
      b.addEventListener('click', () => { fmt = k; update(); });
      cards.append(b);
    }
    for (const [k, [t]] of Object.entries(HOW)) {
      const b = el('button', { class: 'vt-card', type: 'button', 'data-k': k }, el('span', {}, el('b', { text: t })));
      b.addEventListener('click', () => { mode = k; update(); });
      modes.append(b);
    }
    const body = el('div', { class: 'vt' },
      el('div', { class: 'vt-left' },
        el('div', { class: 'engr', text: '1 · Shape' }), cards,
        el('div', { class: 'engr', text: '2 · How the picture fits' }), modes,
        summary),
      el('div', { class: 'vt-right' },
        el('div', { class: 'engr', text: 'Now' }), src,
        el('div', { class: 'engr', text: 'After' }), el('div', { class: 'vt-phone' }, big)));
    update();
    modal('Make Vertical', body,
      [{ label: 'Cancel', onClick: c => c() }, { label: 'Make it vertical', cls: 'hw amber', onClick: c => { c(); this._reframe(VFORMATS[fmt], mode); } }]);
  }
  async _reframe(F, mode) {
    const doc = this.doc, token = this.token, W = F.w, H = F.h, oldW = doc.canvas.width;
    const full = c => c.type === 'media' && !c.audioOnly && !c.disabled && ['video', 'image'].includes(mediaById(doc, c.media)?.kind) && Math.abs((c.props?.scale ?? 1) - 1) < 0.05 && Math.abs((c.props?.x ?? 0.5) - 0.5) < 0.05 && Math.abs((c.props?.y ?? 0.5) - 0.5) < 0.05;
    const clips = doc.clips.filter(full);
    const plans = new Map();
    if (mode === 'follow' && clips.length) {
      const ctl = new AbortController(), bar = el('div', { class: 'progress' }, el('i')), what = el('p', { class: 'note', text: 'Finding the action…' });
      const dlg = modal('Make Vertical', el('div', {}, what, bar), [{ label: 'Stop', onClick: x => x() }], { onClose: () => ctl.abort() });
      try {
        for (const [k, c] of clips.entries()) {
          const m = mediaById(doc, c.media);
          what.textContent = `Watching “${c.name || m.name}” (${k + 1} of ${clips.length})…`;
          let focus = [];
          if (m.cursor) {
            const data = await api.readJson(token, m.cursor).catch(() => null);
            for (let t = 0; t <= c.duration; t += 0.2) { const p = data && cursorAt(data, m.cursorOffset || 0, (c.in || 0) + t * (c.speed || 1), 0.3); if (p) focus.push({ t, x: p.x, y: p.y, w: p.click != null ? 3 : 1 }); }
          }
          if (!focus.length && m.kind === 'video') {
            const res = await zoomAnalyse(this, c, m, { signal: ctl.signal, onProgress: v => { bar.firstChild.style.width = Math.round(((k + v) / clips.length) * 100) + '%'; } });
            focus = res.samples.map(s => s.motion > 0.01 ? { t: s.t, x: s.cx, y: s.cy, w: 0.3 + s.motion * 4 } : { t: s.t, x: s.detail?.x ?? 0.5, y: s.detail?.y ?? 0.5, w: 0.15 });
          }
          if (this.token !== token) return;
          plans.set(c.id, focus);
          bar.firstChild.style.width = Math.round(((k + 1) / clips.length) * 100) + '%';
        }
      } catch (e) { if (!ctl.signal.aborted) toast(e.message, 5000); return; } finally { dlg.close(); }
    }
    this.commit(d => {
      const k = W / oldW;
      d.canvas = { ...d.canvas, width: W, height: H };
      for (const c of d.clips) {
        if (c.type === 'text' && c.text) c.text = { ...c.text, size: Math.max(18, Math.round((c.text.size || 96) * Math.max(k, 0.5))) };
        if (!clips.some(x => x.id === c.id)) continue;
        const m = mediaById(d, c.media), sw = m.width || 1920, sh = m.height || 1080;
        const crop = c.props?.crop || [0, 0, 0, 0], cw = sw * (1 - crop[0] - crop[2]), ch = sh * (1 - crop[1] - crop[3]);
        const s = coverScale(cw, ch, W, H);
        // zoom / pan actions were made for the old frame
        c.actions = (c.actions || []).filter(a => Object.keys(a.props || {}).some(key => !['x', 'y', 'scale'].includes(key)));
        if (c.keys) { for (const p of ['props.x', 'props.y', 'props.scale']) delete c.keys[p]; if (!Object.keys(c.keys).length) delete c.keys; }
        if (mode === 'bars') continue; // the whole picture, black above and below
        if (mode === 'blur' || mode === 'zoom') {
          // the whole picture in the middle, over a copy of itself that fills the frame: blurred, or just zoomed in
          const bg = structuredClone(c); bg.id = uid('c'); bg.props = { ...bg.props, scale: s, x: 0.5, y: 0.5 };
          bg.filters = mode === 'blur'
            ? [...(bg.filters || []), { id: uid('f'), type: 'blur', amount: 40 }, { id: uid('f'), type: 'color', exposure: -0.35, saturation: 0.1 }]
            : [...(bg.filters || []), { id: uid('f'), type: 'color', exposure: -0.12 }];
          bg.audio = { ...(bg.audio || {}), mute: true };
          const i = d.tracks.findIndex(t => t.id === c.track);
          // its own Background track under the video (never one of the user's tracks)
          let tr = d.tracks.slice(i + 1).find(t => /^background$/i.test(t.name || '') && !d.clips.some(o => o.track === t.id && o.start < bg.start + bg.duration && o.start + o.duration > bg.start));
          if (!tr) { tr = addTrack(d, i + 1); tr.name = 'Background'; }
          bg.track = tr.id; d.clips.push(bg);
          continue;
        }
        c.props = { ...c.props, scale: s, x: 0.5, y: 0.5 };
        const focus = plans.get(c.id);
        if (mode === 'follow' && focus && focus.length) {
          const ks = reframeKeys(focus, { srcW: cw, srcH: ch, W, H, scale: s, duration: c.duration });
          for (const q of ks) { putKey(c, 'props.x', q.t, q.x, 1 / 60, 'ease'); putKey(c, 'props.y', q.t, q.y, 1 / 60, 'ease'); }
          c.props.x = ks[0]?.x ?? 0.5; c.props.y = ks[0]?.y ?? 0.5;
        }
      }
    });
    this.renderAll?.(); this.player.resize();
    toast(`Now ${W} × ${H}. ${clips.length} clip${clips.length === 1 ? '' : 's'} reframed${mode === 'follow' ? ' to follow the action' : ''}. ⌘Z undoes it.`, 6000);
  }

  /** Runs Smart Zoom on clips (ids). quiet: no progress window (used for videos as they're dropped). */
  /** Returns how many zoom and pan moves it made. fallback: a clip with nothing to follow gets gentle push-ins. */
  async smartZoom(ids, { style = 'follow', strength = 1, usePointer = true, quiet = false, pack = '', packSounds = true, packFilter = null, fallback = false } = {}) {
    if (this._zooming) { if (!quiet) toast('Smart Zoom is already working.'); return 0; }
    this._zooming = true;
    const token = this.token, ctl = new AbortController();
    const bar = el('div', { class: 'progress' }, el('i')), what = el('p', { class: 'note', text: 'Watching the video…' });
    const dlg = quiet ? null : modal('Smart Zoom', el('div', {}, what, bar), [{ label: 'Stop', onClick: c => c() }], { onClose: () => ctl.abort() });
    let made = 0, clipsDone = 0;
    const shots = {};
    try {
      for (const [k, id] of ids.entries()) {
        const c = this.doc?.clips.find(x => x.id === id);
        const m = c && mediaById(this.doc, c.media);
        if (!m) continue;
        what.textContent = `Watching “${c.name || m.name}” (${k + 1} of ${ids.length})…`;
        let actions = [];
        if (usePointer && m.cursor) {
          const data = await api.readJson(token, m.cursor).catch(() => null);
          actions = autoZoom(data, m.cursorOffset || 0, c);
        }
        if (!actions.length) {
          const p = { ...c.props, crop: c.props.crop || [0, 0, 0, 0] };
          const base = { x: p.x, y: p.y, scale: p.scale, crop: p.crop, ...frameFraction(this.doc.canvas, m, p.crop) };
          if (m.kind === 'image') {
            actions = zoomPlan([{ t: 0, diff: 0, motion: 0, cx: 0.5, cy: 0.5, box: 1, detail: { x: 0.5, y: 0.45 } }], c.duration, { style: 'cinematic', strength, base });
          } else {
            const res = await zoomAnalyse(this, c, m, { signal: ctl.signal, onProgress: v => { bar.firstChild.style.width = Math.round(((k + v) / ids.length) * 100) + '%'; } });
            if (this.token !== token) return;
            actions = zoomPlan(res.samples, c.duration, { style, strength, base, cuts: res.cuts });
            if (!actions.length && fallback && style !== 'cinematic') actions = zoomPlan(res.samples, c.duration, { style: 'cinematic', strength, base, cuts: res.cuts });
            if (res.cuts?.length) shots[id] = res.cuts;
          }
        }
        if (this.token !== token) return;
        const live = this.doc.clips.find(x => x.id === id);
        if (!live) continue;
        // replace only the zoom/pan actions; keep ones that change opacity, rotation, crop…
        const keep = (live.actions || []).filter(a => Object.keys(a.props || {}).some(key => !['x', 'y', 'scale'].includes(key)));
        this.commit(() => { live.actions = [...keep, ...actions.map(a => ({ ...a, id: uid('a') }))].sort((a, b) => a.t - b.t); }, { quiet: quiet && this.player.playing });
        made += actions.length; clipsDone++;
      }
      dlg?.close();
      let trans = 0;
      if (pack) trans = await autoTransitions(this, pack, { sounds: packSounds, clipIds: ids, shots: packFilter ? null : shots, filter: packFilter });
      if (trans) toast(`${PACKS[pack].name} transitions on ${trans} cut${trans === 1 ? '' : 's'}${packSounds ? ', with sounds' : ''}.`, 5000);
      if (clipsDone === 1 && ids.length === 1 && !quiet) this.select([ids[0]], null);
      if (!quiet) toast(made ? `Smart Zoom: ${made} zoom and pan move${made === 1 ? '' : 's'} on ${clipsDone} clip${clipsDone === 1 ? '' : 's'}. Each is an action you can adjust (right-click to remove).`
        : 'Smart Zoom found nothing to zoom on: the picture barely moves. Try the Cinematic style.', 6000);
      return made;
    } catch (e) {
      dlg?.close();
      if (!/Cancelled/.test(e.message)) toast(`Smart Zoom: ${e.message}`, 6000);
    } finally { this._zooming = false; }
  }

  // ---------------------------------------------------------------- wiring
  _wire() {
    $('#btn-record').addEventListener('click', () => this.cmd('record'));
    $('#home-record').addEventListener('click', () => this.newProject(true));
    $('#home-new').addEventListener('click', () => this.newProject(false));
    $('#home-open').addEventListener('click', () => this.cmd('open'));
    $('#home-template').addEventListener('click', () => this.cmd('templates'));
    $('#btn-import').addEventListener('click', () => this.cmd('import'));
    $('#btn-sound').addEventListener('click', () => this.cmd('sound'));
    $('#btn-spectral').addEventListener('click', () => {
      if (!this.doc) return;
      // the selected clip with sound, or the one under the playhead
      const hasSound = c => { const m = c.type === 'media' && this.doc.media.find(x => x.id === c.media); return m && (m.kind === 'audio' || m.hasAudio); };
      let c = this.selection.clips.map(id => this.doc.clips.find(x => x.id === id)).find(x => x && hasSound(x));
      if (!c) c = this.doc.clips.find(x => hasSound(x) && this.player.time >= x.start && this.player.time < x.start + x.duration);
      if (!c) { toast('Select a clip with sound (or put the playhead over one), then press SPECTRAL.'); return; }
      this.select([c.id], null);
      this.cmd('spectral');
    });
    $('#btn-thumb').addEventListener('click', () => this.cmd('thumbnail'));
    // right-click the picture (not a selected clip's box, which has its own menu): this frame as the thumbnail
    $('#stage').addEventListener('contextmenu', e => {
      if (!this.doc || e.target.closest('.sel-box')) return;
      e.preventDefault();
      popMenu(e.clientX, e.clientY, [
        ['🖼 Use this frame for the thumbnail…', () => this.cmd('thumb-from-frame')],
        ['▣ Picture in picture (selected clip)', () => this.cmd('pip')],
      ]);
    });
    $('#btn-aiimage').addEventListener('click', () => this.cmd('aiimage'));
    $('#btn-voices').addEventListener('click', () => this.cmd('voices'));
    $('#btn-export').addEventListener('click', () => this.cmd('export'));
    $('#btn-help').addEventListener('click', () => this.cmd('about'));
    // the search box next to HELP: start typing and the help opens with what you typed, searching as you go
    const hq = $('#help-q');
    if (hq) {
      let t = 0;
      const go = () => { clearTimeout(t); const v = hq.value; if (!v.trim()) return; hq.value = ''; hq.blur(); showAbout(v); };
      hq.addEventListener('input', () => { clearTimeout(t); t = setTimeout(go, 900); }); // opens when you pause typing
      hq.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); go(); } if (e.key === 'Escape') { hq.value = ''; hq.blur(); } });
    }
    $('#btn-close-project').addEventListener('click', () => this.cmd('home'));
    $('#btn-save-project').addEventListener('click', () => this.cmd('save'));
    this.explain = new Explain(this);
    const scrub = $('#scrub');
    try { scrub.checked = localStorage.getItem('reel.scrubAudio') === '1'; } catch { /* default off */ }
    scrub.addEventListener('change', () => { try { localStorage.setItem('reel.scrubAudio', scrub.checked ? '1' : '0'); } catch { /* fine */ } });
    $('#t-play').addEventListener('click', () => { if (this.shuttle) { this.stopShuttle(); if (!this.player.playing) this.player.play(); } else this.player.toggle(); });
    $('#t-start').addEventListener('click', () => { this.stopShuttle(); this.seek(0); });
    $('#t-end').addEventListener('click', () => { this.stopShuttle(); this.seek(duration(this.doc)); });
    const frame = () => 1 / (this.doc?.canvas.fps || 30);
    // stopped: step a frame. Playing (or shuttling): shuttle like a tape deck, ▶ 2×/4×/8× fast forward,
    // ◀ 2×/4×/8× rewind; PLAY returns to normal speed.
    $('#t-back').addEventListener('click', () => { if (this.player.playing || this.shuttle) this.shuttleStep(-1); else this.seek(this.player.time - frame()); });
    $('#t-fwd').addEventListener('click', () => { if (this.player.playing || this.shuttle) this.shuttleStep(1); else this.seek(this.player.time + frame()); });
    $('#preview-zoom').addEventListener('change', e => { this.setPreviewZoom(e.target.value); });
    this._wirePreviewZoom();
    for (const b of document.querySelectorAll('#toolstrip [data-cmd]')) b.addEventListener('click', () => this.cmd(b.dataset.cmd));
    initToolbarGroups(this);
    initTakesButton(this);
    loadShortcuts(this);
    for (const b of document.querySelectorAll('#toolstrip [data-tool]')) b.addEventListener('click', () => { if (b._held) { b._held = false; return; } this.timeline.setTool(b.dataset.tool); });
    { // press and hold SELECT (or right-click it): select all, or everything of one kind
      const b = $('#toolstrip [data-tool=select]');
      let timer = null;
      const open = () => { b._held = true; this.selectToolPop(b); };
      b.addEventListener('pointerdown', e => { if (e.button !== 0) return; clearTimeout(timer); timer = setTimeout(open, 380); });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => clearTimeout(timer));
      b.addEventListener('contextmenu', e => { e.preventDefault(); clearTimeout(timer); this.timeline.setTool('select'); this.selectMenu(b); });
    }
    $('#btn-proxy').addEventListener('click', e => this.proxyMenu(e.currentTarget));
    this._proxyLabel(this.proxies.status());
    // + INSERT: one menu instead of a crowded strip (fits a 13-inch screen)
    const INSERT = [['insert-text', 'Text', '⇧⌘T'], ['titles', 'Title…', '⌥⌘T'], ['insert-callout', 'Callout', '⇧⌘C'], ['insert-shape', 'Arrow / box', ''],
      ['annotate', 'Drawing', '⌥⌘D'], ['add-caption', 'Caption', '⌃⌘C'], ['tts', 'Speech from text…', ''], null,
      ['insert-action', 'Zoom & pan action', '⌘K'], ['snapback', 'Snapback action', '⇧⌘K'], ['freeze', 'Freeze frame', '⌥F'], ['marker', 'Marker', 'M']];
    $('#btn-insert').addEventListener('click', e => {
      e.stopPropagation();
      document.querySelector('.pop-menu')?.remove();
      const r = e.currentTarget.getBoundingClientRect();
      const menu = el('div', { class: 'pop-menu', style: { left: r.left + 'px', top: r.bottom + 6 + 'px' } },
        ...INSERT.map(it => (it ? el('button', { onclick: () => { menu.remove(); this.cmd(it[0]); } }, el('span', { text: it[1] }), el('kbd', { text: it[2] })) : el('hr'))));
      document.body.append(menu);
      const off = ev => { if (!menu.contains(ev.target)) { menu.remove(); window.removeEventListener('pointerdown', off, true); } };
      setTimeout(() => window.addEventListener('pointerdown', off, true));
    });
    const name = $('#doc-name');
    name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } });
    name.addEventListener('blur', () => {
      const v = name.textContent.trim().slice(0, 80);
      if (this.doc && v && v !== this.doc.name) this.commit(d => { d.name = v; });
      name.scrollLeft = 0; name.title = `${this.doc?.name || ''} — click to rename`;
    });
    window.addEventListener('keydown', e => this._key(e));
    // files dropped anywhere on the editor
    const home = $('#home');
    window.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); if (!this.doc) home.classList.add('dropping'); } });
    window.addEventListener('dragleave', e => { if (!e.relatedTarget) home.classList.remove('dropping'); });
    window.addEventListener('drop', e => {
      home.classList.remove('dropping');
      const handled = e.defaultPrevented; // the timeline handles drops on itself first
      e.preventDefault();
      if (handled) return;
      if (!e.dataTransfer.files.length) { if (e.dataTransfer.types.includes('Files')) toast('Reel couldn’t read that drop. Use File › Import… to pick it instead.', 5000); return; }
      const paths = this.dropPaths(e); // read now: the drop's file list is emptied once this returns
      // dropped on the preview or anywhere but the Media panel: onto the timeline at the playhead
      if (this.doc) this.importDropped(paths, { at: this.player.time });
      else this.newFromDrop(paths);
    });
    setInterval(() => { if (this.doc && this.dirty && !this.player.playing && !this._inChange) this.save(); }, 60000);
  }

  // ---------------------------------------------------------------- shuttle (FRAME ◀ ▶ while playing, J / L)
  /** dir +1 speeds forward through 2×, 4×, 8×; −1 rewinds at 2×, 4×, 8×. Pressing the other way slows down first. */
  shuttleStep(dir) {
    const cur = this.shuttle || (this.player.playing ? 1 : 0);
    const STEPS = [-8, -4, -2, 1, 2, 4, 8];
    let i = STEPS.indexOf(cur);
    if (i < 0) i = STEPS.indexOf(1);
    i = Math.max(0, Math.min(STEPS.length - 1, i + dir));
    this.setShuttle(STEPS[i]);
  }
  setShuttle(v) {
    clearInterval(this._rewindT); this._rewindT = null;
    const base = this.deck?.rate || 1;
    if (v === 1 || !v) { this.shuttle = 0; this.player.setRate(base); this._shuttleLabel(''); return; }
    this.shuttle = v;
    if (v > 0) {
      this.player.setRate(base * v);
      if (!this.player.playing) this.player.play();
      this._shuttleLabel(`▶▶ ${v}×`);
    } else {
      // rewind: the browser can't play video backwards, so wind back in small hops (sound off)
      if (this.player.playing) this.player.pause();
      this.player.setRate(base);
      const speed = -v, step = 0.04;
      this._rewindT = setInterval(() => {
        const t = this.player.time - step * speed * base;
        if (t <= 0) { this.seek(0); this.stopShuttle(); return; }
        this.seek(t);
      }, step * 1000);
      this._shuttleLabel(`◀◀ ${speed}×`);
    }
  }
  stopShuttle() { if (this.shuttle) this.setShuttle(0); }
  _shuttleLabel(t) {
    const kn = $('#t-play .kn');
    if (kn) kn.textContent = t || 'PLAY';
    $('#t-play')?.classList.toggle('shuttling', !!t);
  }

  _key(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    const NOT_TEXT = ['range', 'checkbox', 'radio', 'button', 'color', 'submit'];
    if ((tag === 'input' && !NOT_TEXT.includes(e.target.type)) || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
    if (document.querySelector('#modal-root .backdrop')) return;
    if (!this.doc) { if (!$('#home').classList.contains('hidden')) this._homeKey?.(e); return; }
    if (handleShortcutKey(this, e)) return; // your own shortcuts (Settings › Keyboard Shortcuts) come first
    const fps = this.doc.canvas.fps || 30;
    switch (e.key) {
      case ' ': e.preventDefault(); if (e.repeat) break; if (this.shuttle) { this.stopShuttle(); this.player.pause(); } else this.player.toggle(); break;
      case 'ArrowLeft': e.preventDefault(); if (e.altKey) this.nudge(-1, e.shiftKey); else this.seek(this.player.time - (e.shiftKey ? 1 : 1 / fps)); break;
      case 'ArrowRight': e.preventDefault(); if (e.altKey) this.nudge(1, e.shiftKey); else this.seek(this.player.time + (e.shiftKey ? 1 : 1 / fps)); break;
      case 'a': case 'A': if (e.metaKey) { e.preventDefault(); this.cmd(e.shiftKey ? 'select-after' : 'select-all'); } else if (!e.ctrlKey && !e.altKey) this.timeline.setTool(e.shiftKey ? 'forward' : 'select'); break;
      case 't': case 'T': if (!e.metaKey && !e.ctrlKey && !e.altKey) this.timeline.setTool(this.timeline.tool === 'blade' ? 'select' : 'blade'); break;
      case 'Home': this.seek(0); break;
      case 'End': this.seek(duration(this.doc)); break;
      case 's': case 'S': if (!e.metaKey) this.cmd('split'); break;
      case 'm': case 'M': if (!e.metaKey) this.cmd(e.shiftKey ? 'clip-marker' : 'marker'); break;
      case 'Backspace': case 'Delete': this.cmd(e.altKey ? 'close-gaps' : e.shiftKey ? 'ripple-delete' : 'delete'); break;
      case 'Escape': if (this.timeline.marking) { this.timeline.setMarking(false); break; } this.select([], null); break;
      case 'i': case 'I': if (!e.metaKey) this.cmd('mark-in'); break;
      case 'o': case 'O': if (!e.metaKey) this.cmd('mark-out'); break;
      case 'x': case 'X': if (!e.metaKey && !e.altKey && !e.ctrlKey) this.cmd('add-section'); break;
      default:
        // ⌥ changes the character on a Mac keyboard (⌥X types ≈), so match the physical key
        if (e.altKey && !e.metaKey && e.code === 'KeyX') { e.preventDefault(); this.cmd('clear-inout'); }
        else if (e.altKey && !e.metaKey && e.code === 'KeyF') { e.preventDefault(); this.cmd('freeze'); }
        break;
      case '[': this.cmd('trim-front'); break;
      case ']': this.cmd('trim-end'); break;
      case 'j': if (this.player.playing || this.shuttle) this.shuttleStep(-1); else this.seek(this.player.time - 5); break;
      case 'l': if (this.player.playing || this.shuttle) this.shuttleStep(1); else this.seek(this.player.time + 5); break;
      case 'k': this.stopShuttle(); this.player.pause(); break;
      case 'v': case 'V': if (!e.metaKey && !e.ctrlKey && !e.altKey) this.cmd('disable'); break;
    }
  }
}

// module scripts run once the page is parsed
window.app = new App();
void ANIMATABLE;


const SZ_KEY = 'reel.smartZoom';
function smartZoomPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(SZ_KEY) || '{}') || {}; } catch { /* defaults */ }
  return { style: ZOOM_STYLES[p.style] ? p.style : 'follow', strength: Number.isFinite(p.strength) ? Math.min(1.6, Math.max(0.4, p.strength)) : 1, onDrop: !!p.onDrop, pack: typeof p.pack === 'string' ? p.pack : '', packSounds: p.packSounds !== false };
}
function setSmartZoomPrefs(p) { try { localStorage.setItem(SZ_KEY, JSON.stringify(p)); } catch { /* fine */ } }

/**
 * The recorders (screen, camera, mic, computer sound) start and stop a split second apart, so their clips are
 * placed a little apart to stay in sync, which leaves ragged edges. This trims the slivers where not everything
 * was recording, so the takes start and end together, still in sync, and moves them to start at `at`.
 * Only small differences (under 1.5 s) are trimmed; a clip that started much later is left as it is.
 */
export function squareUpRecording(clips, at) {
  if (clips.length < 2) return;
  const MAX = 1.5;
  const end = c => c.start + c.duration;
  const s0 = Math.min(...clips.map(c => c.start)), e0 = Math.max(...clips.map(end));
  const near = clips.filter(c => c.start - s0 <= MAX && e0 - end(c) <= MAX);
  if (near.length < 2) return;
  const s = Math.max(...near.map(c => c.start)), e = Math.min(...near.map(end));
  if (e - s < 1) return;
  for (const c of near) {
    const front = s - c.start;
    if (front > 0) { c.in = (c.in || 0) + front * (c.speed || 1); c.start = s; c.duration -= front; }
    c.duration = Math.min(c.duration, e - c.start);
  }
  const shift = s - at;
  if (shift > 0) for (const c of clips) c.start = Math.max(0, c.start - shift);
}