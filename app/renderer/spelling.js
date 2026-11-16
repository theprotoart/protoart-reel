// ABC✓ Check spelling: one look at every word the video shows (titles, elements and callouts, captions, reveal
// words, chapter markers) with the Mac's own dictionary (nothing leaves your Mac). Each word it doesn't know is
// listed once, with where it is; clicking the right spelling fixes it everywhere it's used, as one ⌘Z.
import { el, modal, toast } from './ui.js';
import { ELEMENTS } from './lib/elements.js';
import { fmtTime } from './model.js';
import { wordsOf, replaceWordIn, dictionaryWorks } from './texttools.js';

const short = (s, n = 34) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/** Every piece of words in the project: [{ kind, id, t, label, get(doc), set(doc, v) }]. */
export function projectTexts(doc) {
  const out = [];
  const clip = (d, id) => d.clips.find(c => c.id === id);
  for (const c of doc.clips || []) {
    if (c.type === 'text' && c.text) out.push({ kind: 'clip', id: c.id, t: c.start, label: 'Title', get: d => clip(d, c.id)?.text?.content ?? '', set: (d, v) => { const x = clip(d, c.id); if (x) x.text.content = v; } });
    if (c.type === 'element' && c.element) {
      const def = ELEMENTS[c.element.kind]; if (!def) continue;
      const keys = ['text', 'sub', ...(def.slots || []).map(s => s.cap)].filter(k => k in def.defaults && !(k === 'text' && c.element.kind === 'counter'));
      for (const k of keys) out.push({ kind: 'clip', id: c.id, t: c.start, label: def.name, get: d => { const x = clip(d, c.id); return x ? (x.element[k] ?? def.defaults[k] ?? '') : ''; }, set: (d, v) => { const x = clip(d, c.id); if (x) x.element = { ...x.element, [k]: v }; } });
    }
    if (c.transIn?.type === 'text-reveal') out.push({ kind: 'clip', id: c.id, t: c.start, label: 'Reveal text', get: d => clip(d, c.id)?.transIn?.text || 'NEXT', set: (d, v) => { const x = clip(d, c.id); if (x) x.transIn.text = v.slice(0, 40); } });
  }
  for (const cp of doc.captions || []) out.push({ kind: 'caption', id: cp.id, t: cp.t, label: 'Caption', get: d => d.captions?.find(x => x.id === cp.id)?.text ?? '', set: (d, v) => { const x = d.captions?.find(y => y.id === cp.id); if (x) x.text = v.slice(0, 500); } });
  for (const m of doc.markers || []) if (m.label && !m.mark && !m.claps) out.push({ kind: 'marker', id: m.id, t: m.t, label: 'Chapter marker', get: d => d.markers?.find(x => x.id === m.id)?.label ?? '', set: (d, v) => { const x = d.markers?.find(y => y.id === m.id); if (x) x.label = v.slice(0, 80); } });
  return out;
}

/**
 * The words the dictionary doesn't know, each once: [{ word, fixes, places: [place] }], in the order they're seen.
 * null when the dictionary can't be reached. onProgress(done, total) for a long list of captions.
 */
export async function scanSpelling(doc, onProgress) {
  const sp = globalThis.window?.reel?.spell;
  if (!sp) return null;
  try { if (!(await dictionaryWorks(sp))) return null; } catch { return null; }
  const places = projectTexts(doc).sort((a, b) => a.t - b.t);
  const known = new Map(), found = new Map();
  for (let i = 0; i < places.length; i++) {
    const p = places[i];
    for (const w of new Set(wordsOf(p.get(doc)))) {
      const key = w.toLowerCase();
      if (!known.has(key)) known.set(key, !!(await sp.check(w)));
      if (!known.get(key)) continue;
      if (!found.has(key)) found.set(key, { word: w, fixes: ((await sp.suggest(w)) || []).slice(0, 5), places: [] });
      const f = found.get(key); if (!f.places.includes(p)) f.places.push(p);
    }
    if (onProgress && i % 25 === 0) { onProgress(i, places.length); await new Promise(r => setTimeout(r)); }
  }
  return [...found.values()];
}

/** Puts `fix` in place of `word` everywhere in the project. How many places changed. */
export function fixEverywhere(doc, word, fix) {
  let n = 0;
  for (const p of projectTexts(doc)) {
    const v = p.get(doc), nv = replaceWordIn(v, word, fix);
    if (nv !== v) { p.set(doc, nv); n++; }
  }
  return n;
}

export async function openSpelling(app) {
  if (!app.doc) return;
  const body = el('div', { class: 'rp sp' }, el('p', { class: 'note', text: 'Reading every word in the video…' }));
  let dlg = null, kept = new Set();
  const go = p => {
    if (p.kind === 'clip') { app.select([p.id]); app.seek(p.t + 0.05); setTimeout(() => app.editClip?.(app.doc.clips.find(c => c.id === p.id)), 80); }
    else app.seek(p.t + 0.05);
  };
  const draw = async () => {
    const list = await scanSpelling(app.doc, (i, n) => { body.firstChild && (body.firstChild.textContent = `Reading every word in the video… ${Math.round(i / n * 100)}%`); });
    if (list === null) { body.replaceChildren(el('p', { class: 'note', text: 'The Mac’s spelling dictionary isn’t available here. Words it doesn’t know are still underlined in red in each text box: right-click one for the right spelling.' })); return; }
    const todo = list.filter(f => !kept.has(f.word.toLowerCase()));
    const total = projectTexts(app.doc).length;
    const head = el('div', { class: 'rp-sum' }, el('div', { class: 'rp-row ' + (todo.length ? 'bad' : 'ok') }, el('b', { text: todo.length ? '!' : '✓' }),
      el('div', {}, el('div', { text: todo.length ? `${todo.length} word${todo.length === 1 ? '' : 's'} to check` : total ? 'No spelling mistakes found' : 'There are no words in this video yet' },
        el('small', { text: todo.length ? 'Click the right spelling: it’s fixed everywhere that word is used (⌘Z undoes it). Click a place to go to it.' : `Checked ${total} piece${total === 1 ? '' : 's'} of text: titles, elements and callouts, captions, reveal words and chapter markers.` })))));
    const rows = todo.map(f => el('div', { class: 'sp-word' },
      el('div', { class: 'sp-top' },
        el('span', { class: 'sp-bad', text: f.word }), el('span', { class: 'sp-arrow', text: '→' }),
        el('div', { class: 'sp-fixes' },
          ...f.fixes.map(fx => el('button', { class: 'tool sp-fix', type: 'button', text: fx, title: `Use “${fx}” everywhere`, onclick: async () => {
            let n = 0; app.commit(d => { n = fixEverywhere(d, f.word, fx); });
            toast(`“${f.word}” → “${fx}” in ${n} place${n === 1 ? '' : 's'}. ⌘Z undoes it.`, 3000);
            await draw();
          } })),
          f.fixes.length ? null : el('span', { class: 'note', text: 'no suggestions: try sounding it out differently in its box' }),
          el('button', { class: 'tool sp-keep', type: 'button', text: '✓ It’s right', title: `Keep “${f.word}” and add it to the Mac’s dictionary`, onclick: async () => {
            kept.add(f.word.toLowerCase()); try { await app.api.spell?.add(f.word); } catch { /* still hidden for now */ }
            await draw();
          } }))),
      el('div', { class: 'sp-places' }, ...f.places.slice(0, 6).map(p => el('button', { class: 'sp-place', type: 'button', title: 'Go to it', onclick: () => go(p) },
        `${p.label} · ${fmtTime(p.t).replace(/\.\d+$/, '')} · “${short(p.get(app.doc))}”`)),
        f.places.length > 6 ? el('span', { class: 'note', text: `and ${f.places.length - 6} more` }) : null)));
    body.replaceChildren(head, todo.length ? el('div', { class: 'sp-list' }, ...rows) : null);
  };
  dlg = modal('ABC✓ Check spelling', body, [
    { label: 'CHECK AGAIN', onClick: () => { kept = new Set(); draw(); } },
    { label: 'CLOSE', cls: 'hw amber', onClick: close => close() },
  ], { wide: true });
  await draw();
  return dlg;
}
