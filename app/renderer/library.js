// Media library: everything recorded or added to the project; drag onto the timeline. Search and a
// kind filter on top; right-click (or the ⋯ on an item) for rename, replace file, show in Finder,
// select the clips that use it, add to the Global Library, and remove.
import { el, $, toast, popMenu, promptText } from './ui.js';
import { fmtTime } from './model.js';
import { posterFor } from './peaks.js';

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
    lib.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files.length) app.importDropped(e.dataTransfer.files, null); });
    this.selected = null;
    this.query = '';
    this.filter = 'all';
    // search + filter bar under the panel head
    this.search = el('input', { type: 'search', class: 'lib-search', placeholder: 'Search media', title: 'Find media by name' });
    this.search.addEventListener('input', () => { this.query = this.search.value.trim().toLowerCase(); this.render(); });
    this.chips = el('div', { class: 'lib-chips' });
    const head = lib.querySelector('.panel-head');
    head.after(el('div', { class: 'lib-tools' }, this.search, this.chips));
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
    const shown = doc.media.filter(m => !m.hidden // reversed copies live inside their clips
      && (!this.query || m.name.toLowerCase().includes(this.query))
      && (this.filter === 'all' || (this.filter === 'unused' ? !usedSet.has(m.id) : m.kind === this.filter)));
    if (!shown.length) this.list.append(el('div', { class: 'note', style: { gridColumn: '1 / -1' }, text: 'Nothing matches.' }));
    for (const m of shown) {
      const thumb = el('div', { class: 'lthumb', text: ICON[m.kind] || '?' });
      posterFor(this.app, m).then(url => { if (url) { thumb.style.backgroundImage = `url(${url})`; thumb.textContent = ''; } });
      const used = usedSet.has(m.id);
      const more = el('button', { class: 'lmore', text: '⋯', title: 'More: rename, replace file, show in Finder…' });
      const item = el('div', {
        class: 'lib-item' + (this.selected === m.id ? ' selected' : '') + (used ? '' : ' unused'), draggable: true,
        title: `${m.name}\n${m.kind}${m.width ? ` ${m.width}×${m.height}` : ''} · ${fmtTime(m.duration || 0)}${used ? '' : '\nNot on the timeline yet'}\nDouble-click to add at the playhead. Right-click for more.`,
      }, thumb, ROLE[m.role] ? el('span', { class: 'lrole', text: ROLE[m.role], 'data-role': m.role }) : null, more,
      el('div', { class: 'lname', text: m.name }), el('div', { class: 'ldur', text: m.kind === 'image' ? 'image' : fmtTime(m.duration || 0) }));
      item.addEventListener('dragstart', e => { e.dataTransfer.setData('application/x-reel-media', m.id); e.dataTransfer.effectAllowed = 'copy'; this._dragging = true; });
      item.addEventListener('dragend', () => { this._dragging = false; if (this._renderLater) { this._renderLater = false; this.render(); } });
      item.addEventListener('click', () => { this.selected = m.id; this.render(); });
      item.addEventListener('dblclick', () => this.app.addMediaClip(m.id, null, this.app.player.time));
      const menu = (x, y) => this.menu(m, used, x, y);
      item.addEventListener('contextmenu', e => { e.preventDefault(); menu(e.clientX, e.clientY); });
      more.addEventListener('click', e => { e.stopPropagation(); const r = more.getBoundingClientRect(); menu(r.left, r.bottom + 4); });
      more.addEventListener('dblclick', e => e.stopPropagation());
      this.list.append(item);
    }
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
