// Media library: everything recorded or added to the project; drag onto the timeline. Search and a
// kind filter on top; right-click (or the ⋯ on an item) for rename, replace file, show in Finder,
// select the clips that use it, add to the Global Library, and remove.
import { el, $, toast, popMenu, promptText } from './ui.js';
import { fmtTime } from './model.js';
import { posterFor } from './peaks.js';
import { openPresetBrowser, PRESET_PAGES } from './fxlibrary.js';

const ICON = { video: '▶', audio: '♪', image: '▣' };
const ROLE = { screen: 'SCREEN', camera: 'CAMERA', mic: 'MIC', system: 'COMPUTER', app: 'APP', ai: 'AI', import: '', global: 'GLOBAL' };
const FILTERS = [['all', 'All'], ['video', 'Video'], ['audio', 'Audio'], ['image', 'Images'], ['unused', 'Unused']];

export class Library {
  constructor(app) {
    this.app = app;
    this.list = $('#lib-list');
    $('#lib-add').addEventListener('click', () => app.cmd('import'));
    const lib = $('#library');
    lib.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    lib.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer.files.length || e.dataTransfer.types.includes('Files')) app.importDropped(app.dropPaths(e), null); });
    this.selected = null;
    this.view = (() => { try { return localStorage.getItem('reel.libView') || 'list'; } catch { return 'list'; } })();
    this.query = '';
    this.filter = 'all';
    // search + filter bar under the panel head
    this.search = el('input', { type: 'search', class: 'lib-search', placeholder: 'Search media', title: 'Find media by name' });
    this.search.addEventListener('input', () => { this.query = this.search.value.trim().toLowerCase(); this.render(); });
    this.chips = el('div', { class: 'lib-chips' });
    const head = lib.querySelector('.panel-head');
    this.tools = el('div', { class: 'lib-tools' }, this.search, this.chips);
    head.after(this.tools);
    // CapCut-style: MEDIA and the presets share this panel. Pick a tab; drag anything from it onto the timeline.
    this.presetPage = null;
    this.presetHost = el('div', { class: 'lib-presets hidden' });
    const SHORT = { title: 'TITLES', trans: 'TRANSITIONS', cut: 'CUTS', element: 'ELEMENTS', motion: 'MOTION', sound: 'SOUNDS', style: 'STYLES', film: 'FILM', auto: 'AUTO' };
    this.tabs = el('div', { class: 'lib-tabs', role: 'tablist' },
      el('button', { class: 'lib-tab on', 'data-k': 'media', text: 'MEDIA', title: 'Your recordings, videos, pictures and sound', onclick: () => this.showPresets(null) }),
      ...PRESET_PAGES.map(([k, label]) => el('button', { class: 'lib-tab', 'data-k': k, text: SHORT[k] || label, title: `${label}: click one to use it, or drag it onto the timeline`, onclick: () => this.showPresets(k) })));
    head.after(this.tabs);
    lib.append(this.presetHost);
    // drag the panel's right edge to make it wider or narrower (remembered)
    const grip = el('div', { class: 'lib-grip', title: 'Drag to make the panel wider or narrower' });
    lib.append(grip);
    try { const w = Number(localStorage.getItem('reel.libWidth')); if (w >= 200) lib.style.width = w + 'px'; } catch { /* default */ }
    grip.addEventListener('pointerdown', e => {
      e.preventDefault(); const x0 = e.clientX, w0 = lib.getBoundingClientRect().width;
      lib.classList.add('sizing');
      const mv = ev => { lib.style.width = Math.round(Math.max(200, Math.min(window.innerWidth * 0.5, w0 + ev.clientX - x0))) + 'px'; };
      const up = () => { lib.classList.remove('sizing'); window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); try { localStorage.setItem('reel.libWidth', parseInt(lib.style.width, 10)); } catch { /* fine */ } window.dispatchEvent(new Event('resize')); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    });
  }

  /** Shows a preset page in this panel (null: back to MEDIA). */
  showPresets(page) {
    const lib = $('#library');
    this.presetPage = page;
    for (const b of this.tabs.children) b.classList.toggle('on', b.dataset.k === (page || 'media'));
    lib.classList.toggle('presets', !!page);
    for (const n of [this.tools, this.list, lib.querySelector('.lib-hint')]) n?.classList.toggle('hidden', !!page);
    this.presetHost.classList.toggle('hidden', !page);
    lib.querySelector('.panel-head .engr').textContent = page ? 'PRESETS' : 'MEDIA';
    if (page) openPresetBrowser(this.app, page, this.presetHost);
    else this.presetHost.replaceChildren();
  }

  render() {
    const doc = this.app.doc;
    if (!doc) return;
    // never redraw under a drag in progress: the item being dragged would be replaced and the drop could be lost
    if (this._dragging) { this._renderLater = true; return; }
    this.chips.replaceChildren(...FILTERS.map(([k, t]) => el('button', { class: 'chip' + (this.filter === k ? ' on' : ''), text: t, title: `Show ${t.toLowerCase()} media`, onclick: () => { this.filter = k; this.render(); } })));
    this.list.replaceChildren();
    if (!doc.media.length) {
      this.list.append(el('div', { class: 'note', style: { gridColumn: '1 / -1' }, text: 'No media yet. Press REC to record your screen, ADD MEDIA, or make a picture with AI IMAGE.' }));
      return;
    }
    const usedSet = new Set(doc.clips.map(c => c.media));
    const uses = new Map(); for (const c of doc.clips) if (c.media) uses.set(c.media, (uses.get(c.media) || 0) + 1);
    const visible = m => !m.hidden && !(m.sfx && !usedSet.has(m.id)); // reversed copies live in their clips; Reel's own sound effects show while used
    const shown = doc.media.filter(m => visible(m)
      && (!this.query || m.name.toLowerCase().includes(this.query) || (ROLE[m.role] || '').toLowerCase().includes(this.query))
      && (this.filter === 'all' || (this.filter === 'unused' ? !usedSet.has(m.id) : this.filter === 'missing' ? this.missing?.has(m.file) : m.kind === this.filter)));
    // what's arrived since this list was last drawn gets a NEW badge for a while, and the list goes back to the top
    const known = this._known ||= new Map(), now = Date.now(), first = this._knownDoc !== this.app.token;
    if (first) { known.clear(); this._knownDoc = this.app.token; this.missing = null; }
    let fresh = false;
    for (const m of doc.media) if (!known.has(m.id)) { known.set(m.id, first ? 0 : now); if (!first) fresh = true; }
    if (fresh) requestAnimationFrame(() => { this.list.scrollTop = 0; });
    this.checkMissing();
    // the summary: how much there is, what's not used, what's missing
    const all = doc.media.filter(visible), recs = new Set(all.map(m => m.recording).filter(Boolean));
    const unused = all.filter(m => !usedSet.has(m.id)).length, missing = all.filter(m => this.missing?.has(m.file)).length;
    this.list.classList.toggle('grid', this.view === 'grid');
    this.list.append(el('div', { class: 'lib-summary' },
      el('span', { text: `${all.length} file${all.length === 1 ? '' : 's'}${recs.size ? ` · ${recs.size} recording${recs.size === 1 ? '' : 's'}` : ''}` }),
      unused ? el('button', { class: 'lib-sumchip', text: `${unused} not used`, title: 'Show only the files that aren’t on the timeline', onclick: () => { this.filter = 'unused'; this.render(); } }) : null,
      missing ? el('button', { class: 'lib-sumchip bad', text: `${missing} missing`, title: 'Show the files that aren’t in the project folder any more', onclick: () => { this.filter = 'missing'; this.render(); } }) : null,
      el('span', { class: 'spacer' }),
      el('button', { class: 'lib-view lib-repair', text: '🩺 CHECK & REPAIR', title: 'Check every file and recording: missing files, sound out of sync, picture without its microphone, and fix it', onclick: () => this.app.cmd('repair') }),
      el('button', { class: 'lib-view', text: this.view === 'grid' ? '☰ LIST' : '▦ GRID', title: 'Show the media as a list (names first) or as a grid of pictures', onclick: () => { this.view = this.view === 'grid' ? 'list' : 'grid'; try { localStorage.setItem('reel.libView', this.view); } catch { /* fine */ } this.render(); } })));
    if (!shown.length) { this.list.append(el('div', { class: 'note', text: 'Nothing matches.' })); return; }
    // groups: each recording (its screen, camera, mic… together, newest first), then everything else
    const groups = new Map();
    for (const m of [...shown].reverse()) { const k = m.recording || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
    const ORDER = { screen: 0, camera: 1, app: 2, mic: 3, system: 4 };
    const recNo = new Map([...recs].map((r, i) => [r, i + 1]));
    const folded = this._folded ||= new Set();
    for (const [rec, list] of [...groups].sort((a, b) => (a[0] ? 0 : 1) - (b[0] ? 0 : 1))) {
      list.sort((a, b) => (ORDER[a.role] ?? 9) - (ORDER[b.role] ?? 9));
      const fold = folded.has(rec || '_');
      const stamp = rec ? (list[0].name.match(/\d{1,2}:\d{2}\s*[AP]M/i)?.[0] || '') : '';
      const longest = Math.max(0, ...list.map(m => m.duration || 0));
      const head = el('div', { class: 'lib-group-head' + (rec ? ' rec' : ''), title: rec ? 'One recording: its files belong together. Drag DRAG ALL onto the timeline to lay them all down in sync.' : '' },
        el('button', { class: 'lib-fold', text: fold ? '▸' : '▾', onclick: () => { if (fold) folded.delete(rec || '_'); else folded.add(rec || '_'); this.render(); } }),
        el('b', { text: rec ? `RECORDING ${recNo.get(rec) || ''}${stamp ? ` · ${stamp}` : ''}` : 'OTHER FILES' }),
        el('span', { class: 'lib-group-sub', text: `${list.length} file${list.length === 1 ? '' : 's'}${rec ? ` · ${fmtTime(longest)}` : ''}` }),
        rec && list.length > 1 ? el('span', { class: 'lib-dragall', draggable: true, text: '⠿ DRAG ALL', title: 'Drag onto the timeline: every file of this recording, lined up in sync. Double-click to put them at the playhead.' }) : null);
      const da = head.querySelector('.lib-dragall');
      if (da) {
        da.addEventListener('dragstart', e => { e.dataTransfer.setData('application/x-reel-recording', rec); e.dataTransfer.effectAllowed = 'copy'; this._dragging = true; });
        da.addEventListener('dragend', () => { this._dragging = false; if (this._renderLater) { this._renderLater = false; this.render(); } });
        da.addEventListener('dblclick', () => this.app.addRecordingClips(rec, this.app.player.time));
      }
      this.list.append(head);
      if (fold) continue;
      const box = el('div', { class: 'lib-group' });
      for (const m of list) box.append(this.item(m, uses.get(m.id) || 0, now - (known.get(m.id) || 0) < 10 * 60e3));
      this.list.append(box);
    }
  }

  /** One file: its picture, its name, what it is, how long, and whether it's used (or missing). */
  item(m, n, isNew) {
    const used = n > 0, gone = this.missing?.has(m.file);
    const thumb = el('div', { class: 'lthumb', text: ICON[m.kind] || '?' });
    posterFor(this.app, m).then(url => { if (url) { thumb.style.backgroundImage = `url(${url})`; thumb.textContent = ''; } });
    const more = el('button', { class: 'lmore', text: '⋯', title: 'More: rename, replace file, show in Finder…' });
    const info = [m.kind === 'image' ? 'picture' : m.kind === 'audio' ? 'sound' : 'video', m.width ? `${m.width}×${m.height}` : '', m.kind === 'image' ? '' : fmtTime(m.duration || 0)].filter(Boolean).join(' · ');
    const status = gone ? el('span', { class: 'lstat bad', text: 'MISSING FILE', title: `${m.file} isn’t in the project folder. Right-click › Replace file… to point Reel at it again.` })
      : used ? el('span', { class: 'lstat ok', text: n === 1 ? 'ON TIMELINE' : `ON TIMELINE ×${n}`, title: `Used by ${n} clip${n === 1 ? '' : 's'}. Right-click › Select clips using it.` })
      : el('span', { class: 'lstat', text: 'NOT USED', title: 'Not on the timeline yet' });
    const item = el('div', {
      class: 'lib-item' + (this.selected === m.id ? ' selected' : '') + (used ? '' : ' unused') + (gone ? ' missing' : ''), draggable: true,
      title: `${m.name}\n${info}\nFile: ${m.file}\nDouble-click to add at the playhead. Right-click for more.`,
    }, thumb,
    el('div', { class: 'lmeta' },
      el('div', { class: 'lname', text: m.name }),
      el('div', { class: 'linfo' }, ROLE[m.role] ? el('span', { class: 'lrole', text: ROLE[m.role], 'data-role': m.role }) : null, status, el('span', { class: 'ldur', text: info }))),
    more,
    isNew ? el('span', { class: 'lnew', text: 'NEW', title: 'Just added' }) : null);
    item.addEventListener('dragstart', e => { e.dataTransfer.setData('application/x-reel-media', m.id); e.dataTransfer.effectAllowed = 'copy'; this._dragging = true; });
    item.addEventListener('dragend', () => { this._dragging = false; if (this._renderLater) { this._renderLater = false; this.render(); } });
    item.addEventListener('click', () => { this.selected = m.id; this.render(); });
    item.addEventListener('dblclick', () => this.app.addMediaClip(m.id, null, this.app.player.time));
    const menu = (x, y) => this.menu(m, used, x, y);
    item.addEventListener('contextmenu', e => { e.preventDefault(); menu(e.clientX, e.clientY); });
    more.addEventListener('click', e => { e.stopPropagation(); const r = more.getBoundingClientRect(); menu(r.left, r.bottom + 4); });
    more.addEventListener('dblclick', e => e.stopPropagation());
    return item;
  }

  /** Asks (once per project, and again when files change) which media files aren't in the project folder. */
  checkMissing() {
    const files = this.app.doc.media.filter(m => m.file).map(m => m.file), key = files.join('|');
    if (key === this._missKey || !this.app.api?.missingMedia) return;
    this._missKey = key;
    this.app.api.missingMedia(this.app.token, files).then(list => {
      const before = this.missing?.size || 0; this.missing = new Set(list || []);
      if (this.missing.size || before) this.render();
    }).catch(() => {});
  }

  menu(m, used, x, y) {
    const app = this.app;
    popMenu(x, y, [
      ['Add at playhead', () => app.addMediaClip(m.id, null, app.player.time)],
      ['Rename…', () => this.rename(m)],
      ['Replace file…', () => this.replace(m)],
      ['Show in Finder', () => app.api.revealMedia(app.token, m.file).catch(e => toast(e.message))],
      used ? ['Select clips using it', () => app.select(app.doc.clips.filter(c => c.media === m.id).map(c => c.id), null)] : null,
      null,
      ['Add to Global Library', () => app.api.globalAdd(app.token, m.file, m.name).then(() => toast('Added to the Global Library: every project can use it now.'), e => toast(e.message))],
      ['Open Global Library…', () => app.cmd('global-library')],
      null,
      used ? [`Remove from project with its ${app.doc.clips.filter(c => c.media === m.id).length} clip(s)…`, () => app.removeUsedMedia(m)] : ['Remove from project…', () => app.removeMedia(m)],
    ]);
  }

  async rename(m) {
    const v = await promptText('Rename media', 'The file on disk keeps its name; this is how it shows in Reel.', m.name, 'Rename');
    if (!v || v === m.name) return;
    this.app.commit(() => { m.name = v.slice(0, 120); });
  }

  /** Replace (relink) the file behind this media: every clip that uses it now shows the new file. */
  async replace(m) {
    try {
      const r = await this.app.api.replaceMedia(this.app.token, m.kind);
      if (!r) return;
      if (r.kind !== m.kind) { toast(`Pick a ${m.kind} file to replace a ${m.kind}.`); return; }
      const old = m.file;
      this.app.commit(() => {
        Object.assign(m, { file: r.file, name: r.name, duration: r.duration, width: r.width, height: r.height, hasAudio: r.hasAudio, fps: r.fps });
        delete m.peaks; delete m.poster;
      });
      this.app.player.prune?.();
      toast(`Replaced. Clips that used “${old}” now use “${r.name}”. Trims longer than the new file are kept short.`);
      // clips can't run past the end of the new file
      if (m.kind !== 'image' && m.duration) this.app.commit(d => { for (const c of d.clips) if (c.media === m.id) { const max = (m.duration - (c.in || 0)) / (c.speed || 1); if (c.in >= m.duration) c.in = 0; if (c.duration > max && max > 0.05) c.duration = max; } });
    } catch (e) { toast(e.message); }
  }
}
