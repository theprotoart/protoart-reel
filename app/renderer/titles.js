// Titles: ready-made title templates (big title, lower third, subscribe, chapter card, quote, end card…)
// shown as live previews drawn by the same compositor as the editor, and text styles you save once and
// reuse in any project.
import { el, modal, toast, selectRow } from './ui.js';
import { newTextClip, newShapeClip, isFree, addTrack, uid, TEXT_DEFAULTS } from './model.js';
import { drawFrame } from './compositor.js';

const T = (content, text, props = {}) => ({ kind: 'text', content, text, props });
const R = (shape, props = {}) => ({ kind: 'shape', shape, props });

/** Templates in canvas fractions; every clip lasts `dur` seconds. */
export const TEMPLATES = [
  { id: 'big', name: 'Big title', dur: 4, items: [
    T('YOUR BIG TITLE', { size: 150, weight: 900, font: 'Avenir Next Condensed', anim: 'build', animDur: 0.5, shadow: 24 }, { y: 0.5 })] },
  { id: 'lower', name: 'Lower third', dur: 5, items: [
    R({ shape: 'rect', x1: 0.05, y1: 0.76, x2: 0.48, y2: 0.9, color: '#ffb02a', width: 4, fill: true, fillOpacity: 1 }),
    T('Your Name', { size: 64, weight: 800, align: 'left', color: '#1b1204', anim: 'moveIntoPlace', animDur: 0.6, shadow: 0, width: 0.4 }, { x: 0.265, y: 0.8 }),
    T('What you do · @handle', { size: 34, weight: 600, align: 'left', color: '#2a1a06', anim: 'fadeChars', animDur: 0.5, shadow: 0, width: 0.4 }, { x: 0.265, y: 0.865 })] },
  { id: 'subscribe', name: 'Subscribe button', dur: 4, items: [
    R({ shape: 'rect', x1: 0.39, y1: 0.8, x2: 0.61, y2: 0.9, color: '#e8261c', width: 4, fill: true, fillOpacity: 1 }),
    T('SUBSCRIBE', { size: 58, weight: 900, color: '#ffffff', anim: 'bounce', animDur: 0.7, shadow: 0 }, { y: 0.85 })] },
  { id: 'chapter', name: 'Chapter card', dur: 4, items: [
    T('01', { size: 220, weight: 900, color: '#ffb02a', anim: 'flip', animDur: 0.5, shadow: 18 }, { y: 0.4 }),
    T('Getting started', { size: 90, weight: 700, anim: 'build', animDur: 0.5, shadow: 18 }, { y: 0.62 })] },
  { id: 'quote', name: 'Quote', dur: 6, items: [
    T('“A great quote goes here, set in a calm serif.”', { size: 72, weight: 400, italic: true, font: 'Georgia', bg: '#000000', bgOpacity: 0.55, anim: 'fadeChars', animDur: 0.6, width: 0.7, shadow: 0 }, { y: 0.48 }),
    T('— Who said it', { size: 40, weight: 600, color: '#ffd9a0', anim: 'fade', shadow: 0 }, { y: 0.7 })] },
  { id: 'kinetic', name: 'Kinetic drop', dur: 4, items: [
    T('DROP IN', { size: 170, weight: 900, font: 'Impact', anim: 'gravity', animDur: 0.9, stroke: 6, strokeColor: '#000000', shadow: 20 }, { y: 0.5 })] },
  { id: 'code', name: 'Terminal label', dur: 5, items: [
    T('$ npm run build', { size: 56, weight: 600, font: 'Menlo', color: '#7dff9a', bg: '#0b0f0b', bgOpacity: 0.9, anim: 'typewriter', align: 'left', width: 0.5, shadow: 0 }, { x: 0.3, y: 0.15 })] },
  { id: 'smash', name: 'Break apart', dur: 4, items: [
    T('BOOM', { size: 200, weight: 900, color: '#ff5ca8', anim: 'breakApart', animDur: 0.8, stroke: 5, strokeColor: '#1a0f2e', shadow: 24 }, { y: 0.5 })] },
  { id: 'end', name: 'End card', dur: 8, items: [
    T('Thanks for watching!', { size: 96, weight: 800, anim: 'build', animDur: 0.5, shadow: 18 }, { y: 0.2 }),
    R({ shape: 'rect', x1: 0.08, y1: 0.36, x2: 0.46, y2: 0.78, color: '#ffffff', width: 6, fill: false }),
    R({ shape: 'rect', x1: 0.54, y1: 0.36, x2: 0.92, y2: 0.78, color: '#ffffff', width: 6, fill: false }),
    T('Watch next', { size: 40, weight: 700, anim: 'fade', shadow: 8 }, { x: 0.27, y: 0.84 }),
    T('Subscribe', { size: 40, weight: 700, anim: 'fade', shadow: 8 }, { x: 0.73, y: 0.84 })] },
];

function clipsFor(tpl, start) {
  return tpl.items.map(it => {
    const c = it.kind === 'text' ? newTextClip(null, start, it.content) : newShapeClip(null, start);
    c.duration = tpl.dur;
    if (it.kind === 'text') { c.text = { ...TEXT_DEFAULTS, ...it.text, content: it.content }; c.name = it.content.slice(0, 24); }
    else { c.shape = { ...c.shape, ...it.shape }; c.name = 'Box'; }
    Object.assign(c.props, it.props);
    return c;
  });
}

function preview(tpl, w = 288) {
  const h = Math.round(w * 9 / 16);
  const cv = el('canvas', { width: w, height: h });
  const clips = clipsFor(tpl, 0);
  // later pieces sit on higher tracks (drawn on top), as in the timeline
  const tracks = clips.map((_, i) => ({ id: 't' + i })).reverse();
  clips.forEach((c, i) => { c.track = 't' + i; });
  const doc = { canvas: { width: 1920, height: 1080, background: '#1d1f24' }, tracks, clips, media: [] };
  const ctx = cv.getContext('2d');
  // a moment after everything has animated in
  drawFrame(ctx, doc, Math.min(tpl.dur * 0.6, 2.2), { frame: () => null });
  return cv;
}

/** Title picker: click a template to drop it at the playhead, each piece on its own track. */
export function openTitles(app) {
  const doc = app.doc;
  if (!doc) return;
  const grid = el('div', { class: 'title-grid' });
  const dlg = modal('Titles', el('div', {}, el('p', { class: 'note', text: 'Pick a title to add at the playhead. Every piece is a normal text or box clip you can restyle.' }), grid), [{ label: 'Close', onClick: c => c() }], { wide: true });
  for (const tpl of TEMPLATES) {
    const card = el('button', { class: 'title-card', title: `Add “${tpl.name}”` }, preview(tpl), el('span', { class: 'engr', text: tpl.name }));
    card.addEventListener('click', () => {
      const t = app.player.time, ids = [];
      app.commit(d => {
        // top tracks first; add tracks above when they're busy
        // later pieces go on higher tracks so text sits on top of its box
        const made = clipsFor(tpl, t);
        let above = d.tracks.length;
        [...made].forEach((c, i) => {
          let tr = null;
          for (let ti = above - 1; ti >= 0; ti--) if (isFree(d, d.tracks[ti].id, c.start, c.duration)) { tr = d.tracks[ti]; above = ti; break; }
          if (!tr) { tr = addTrack(d, 0); above = 0; }
          void i;
          c.track = tr.id; c.group = made.length > 1 ? 'g' + tpl.id + t.toFixed(2) : undefined;
          d.clips.push(c); ids.push(c.id);
        });
      });
      app.select(ids, null);
      dlg.close();
      toast(`${tpl.name} added. The pieces are grouped; click one to select them all.`);
    });
    grid.append(card);
  }
}

// ------------------------------------------------------------------ saved text styles
const KEY = 'reel.textStyles';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
const store = list => { try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 100))); } catch { /* fine */ } };

/** Row in the text inspector: apply a saved style, save this one, delete. */
export function styleRow(app, c) {
  const list = load();
  const sel = el('select', {}, el('option', { value: '', text: list.length ? 'Apply a saved style…' : 'No saved styles yet' }), ...list.map((s, i) => el('option', { value: i, text: s.name })));
  sel.addEventListener('change', () => {
    const s = list[Number(sel.value)]; sel.value = '';
    if (!s) return;
    app.commit(() => { c.text = { ...c.text, ...s.text, content: c.text.content }; });
  });
  const save = el('button', { class: 'tool', text: 'Save style', title: 'Keep this look to use on other text, in any project', onclick: () => {
    const input = el('input', { type: 'text', value: `${c.text.font} ${c.text.size}` });
    const d = modal('Save text style', el('div', {}, el('p', { class: 'note', text: 'Name this style:' }), input), [
      { label: 'Cancel', onClick: x => x() },
      { label: 'Save', cls: 'hw amber', onClick: x => {
        const { content, ...text } = c.text; void content;
        const all = load().filter(s => s.name !== input.value.trim());
        all.unshift({ id: uid('s'), name: input.value.trim().slice(0, 40) || 'Style', text });
        store(all); x(); app.inspector.render(); toast('Style saved.');
      } }]);
    setTimeout(() => input.select(), 50); void d;
  } });
  const del = el('button', { class: 'tool', text: 'Manage', title: 'Delete saved styles', onclick: () => {
    const rows = el('div');
    const draw = () => rows.replaceChildren(...load().map(s => el('div', { class: 'row' }, el('span', { text: s.name, style: { flex: 1 } }),
      el('button', { class: 'mini', text: '×', onclick: () => { store(load().filter(x => x.id !== s.id)); draw(); } }))));
    draw();
    modal('Saved text styles', rows, [{ label: 'Done', cls: 'hw amber', onClick: x => { x(); app.inspector.render(); } }]);
  } });
  return el('div', {}, el('div', { class: 'row' }, el('label', { text: 'Style' }), sel), el('div', { class: 'btn-row' }, save, del));
}
void selectRow;
