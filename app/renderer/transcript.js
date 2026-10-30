// Speech in the edit, as text: Auto Captions (timed captions from what's said) and Edit by Text (a transcript
// of the timeline; delete words to cut them, remove filler words, tighten long pauses), in the spirit of
// transcript-based editors. Speech recognition is macOS's own (reel-speech), on the Mac when the language
// allows; each media file is transcribed once and kept in the project.
import { el, modal, toast } from './ui.js';
import { deleteAllCaptions } from './textops.js';
import { mediaById, removeRange, uid } from './model.js';
import { wordsOnTimeline, mergeWords, buildCaptions, fillerRanges, pauseRanges, cutRanges } from './lib/words.js';

export const LANGS = [['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-AU', 'English (Australia)'], ['es-ES', 'Spanish (Spain)'], ['es-MX', 'Spanish (Mexico)'],
  ['fr-FR', 'French'], ['de-DE', 'German'], ['it-IT', 'Italian'], ['pt-BR', 'Portuguese (Brazil)'], ['nl-NL', 'Dutch'], ['ja-JP', 'Japanese'], ['ko-KR', 'Korean'],
  ['zh-CN', 'Chinese (Mandarin)'], ['ru-RU', 'Russian'], ['ar-SA', 'Arabic'], ['hi-IN', 'Hindi']];
const PREF = 'reel.speech';
const prefs = () => { try { return { locale: 'en-US', maxChars: 64, replace: true, track: '', ...(JSON.parse(localStorage.getItem(PREF) || '{}') || {}) }; } catch { return { locale: 'en-US', maxChars: 64, replace: true, track: '' }; } };
const savePrefs = p => { try { localStorage.setItem(PREF, JSON.stringify(p)); } catch { /* fine */ } };

const soundOf = (doc, c) => { const m = c.type === 'media' && mediaById(doc, c.media); return m && (m.kind === 'audio' || m.hasAudio) ? m : null; };

let progressHooked = false; const listeners = new Map();
/** Words of one media file (source seconds), transcribing it the first time. */
async function mediaWords(app, m, locale, onProgress) {
  if (m.transcript && m.transcript.locale === locale) {
    try { return (await app.api.readJson(app.token, m.transcript.file)).words || []; } catch { /* make it again */ }
  }
  if (!progressHooked && app.api.onSpeechProgress) { progressHooked = true; app.api.onSpeechProgress((id, msg) => listeners.get(id)?.(msg)); }
  const job = uid('sp');
  listeners.set(job, msg => { if (msg.value != null) onProgress?.(msg.value); });
  try {
    const r = await app.api.speechTranscribe(app.token, m.file, 0, 0, locale, job);
    if (!r || !Array.isArray(r.words)) throw new Error('Speech recognition isn’t available on this Mac right now.');
    const file = await app.api.writeJson(app.token, `${String(m.file).replace(/\.[^.]+$/, '')}-words`, { locale, words: r.words, onDevice: r.onDevice });
    const live = app.doc?.media.find(x => x.id === m.id);
    if (live) { live.transcript = { file, locale, onDevice: r.onDevice }; app.setDirty(true); }
    return r.words;
  } finally { listeners.delete(job); }
}

/** The timeline's speech: words of every audible clip on the chosen track (or all tracks). */
export async function timelineWords(app, { locale, track = '' }, onStatus) {
  const doc = app.doc;
  const clips = doc.clips.filter(c => !c.disabled && !c.audio?.mute && soundOf(doc, c) && (!track || c.track === track) && !doc.tracks.find(t => t.id === c.track)?.muted);
  if (!clips.length) throw new Error('There’s no clip with sound to listen to.');
  const media = [...new Map(clips.map(c => [c.media, soundOf(doc, c)])).values()];
  const byMedia = new Map();
  for (const [i, m] of media.entries()) {
    onStatus?.(`Listening to “${m.name}” (${i + 1} of ${media.length})…`, i / media.length);
    byMedia.set(m.id, await mediaWords(app, m, locale, v => onStatus?.(`Listening to “${m.name}” (${i + 1} of ${media.length})… ${Math.round(v * 100)}%`, (i + v) / media.length)));
  }
  return mergeWords(clips.map(c => wordsOnTimeline(byMedia.get(c.media) || [], c)));
}

function trackSelect(doc, value) {
  const audible = doc.tracks.filter(t => doc.clips.some(c => c.track === t.id && soundOf(doc, c)));
  const s = el('select', {}, el('option', { value: '', text: 'All tracks with sound' }), ...audible.map(t => el('option', { value: t.id, text: t.name || 'Track', selected: t.id === value })));
  if (!value) { const voice = audible.find(t => /voice|mic|dialog|vo\b/i.test(t.name || '')); if (voice) s.value = voice.id; }
  return s;
}

// ------------------------------------------------------------------ Auto Captions
export async function autoCaptions(app) {
  const doc = app.doc; if (!doc) return;
  const p = prefs();
  const lang = el('select', {}, ...LANGS.map(([v, t]) => el('option', { value: v, text: t, selected: v === p.locale })));
  const track = trackSelect(doc, p.track);
  const len = el('select', {}, ...[[32, 'Short (one line, fast)'], [64, 'Standard (two lines)'], [84, 'Long (two long lines)']].map(([v, t]) => el('option', { value: v, text: t, selected: Number(p.maxChars) === v })));
  const replace = el('input', { type: 'checkbox', checked: p.replace !== false });
  const burn = el('input', { type: 'checkbox', checked: !!doc.captionStyle?.burn });
  const bar = el('div', { class: 'progress' }, el('i')), status = el('p', { class: 'note', text: '' });
  let busy = false;
  const dlg = modal('Auto Captions', el('div', { class: 'newdoc' },
    el('p', { class: 'note', text: 'Reel listens to the speech in your edit and writes timed captions. It runs on this Mac when the language allows (macOS speech recognition); the first time, macOS asks for permission.' }),
    el('div', { class: 'row' }, el('label', { text: 'Language' }), lang),
    el('div', { class: 'row' }, el('label', { text: 'Listen to' }), track),
    el('div', { class: 'row' }, el('label', { text: 'Caption length' }), len),
    el('label', { class: 'row' }, replace, el('span', { text: 'Replace the captions already there' })),
    el('label', { class: 'row' }, burn, el('span', { text: 'Burn them into the video (otherwise they export as a captions file / track)' })),
    ...((doc.captions || []).length ? [el('div', { class: 'cap-all' },
      el('span', { text: `This video has ${doc.captions.length} caption${doc.captions.length === 1 ? '' : 's'} already.` }),
      el('button', { class: 'tool cap-del-all', text: '🗑 DELETE ALL CAPTIONS', title: 'Remove every caption (⌘Z brings them back)', onclick: async () => { dlg.close?.(); await deleteAllCaptions(app); } }))] : []),
    bar, status),
  [{ label: 'Cancel', onClick: c => c() }, { label: 'Make captions', cls: 'hw amber', onClick: async (close, btn) => {
    if (busy) return; busy = true; btn.disabled = true;
    const o = { locale: lang.value, track: track.value, maxChars: Number(len.value), replace: replace.checked };
    savePrefs(o);
    try {
      const words = await timelineWords(app, o, (t, v) => { status.textContent = t; bar.firstChild.style.width = Math.round(v * 100) + '%'; });
      if (!words.length) throw new Error('No speech was found.');
      const caps = buildCaptions(words, { maxChars: o.maxChars, lines: o.maxChars > 40 ? 2 : 1 }).map(c => ({ id: uid('cap'), ...c }));
      app.commit(d => {
        d.captions = o.replace ? caps : [...(d.captions || []), ...caps].sort((a, b) => a.t - b.t);
        if (burn.checked !== !!d.captionStyle?.burn) d.captionStyle = { ...(d.captionStyle || {}), burn: burn.checked };
      });
      app.showCaptionLane = true; app.timeline.render();
      close();
      toast(`${caps.length} captions made from ${words.length} words. Click one on the caption lane to fix a word.`, 6000);
    } catch (e) { status.textContent = e.message; } finally { busy = false; btn.disabled = false; }
  } }]);
  void dlg;
}

// ------------------------------------------------------------------ Edit by Text
let panel = null;
export async function textEditor(app) {
  const doc = app.doc; if (!doc) return;
  if (panel) { panel.remove(); panel = null; }
  const p = prefs();
  const lang = el('select', { title: 'Language spoken' }, ...LANGS.map(([v, t]) => el('option', { value: v, text: t, selected: v === p.locale })));
  const track = trackSelect(doc, p.track);
  const textBox = el('div', { class: 'tx-words', tabindex: 0 });
  const status = el('div', { class: 'tx-status', text: '' });
  const find = el('input', { type: 'search', placeholder: 'Find words…' });
  let words = [];
  const head = el('div', { class: 'fx-ed-head' }, el('b', { text: 'Edit by text' }), el('button', { class: 'mini', text: '×', title: 'Close', onclick: () => { panel.remove(); panel = null; } }));
  const btn = (label, title, fn) => el('button', { class: 'tool', text: label, title, onclick: fn });
  const cut = (ranges, what) => {
    if (!ranges.length) { toast(`No ${what} to cut.`); return; }
    let total = 0;
    app.commit(d => { total = cutRanges(d, ranges, removeRange); });
    toast(`Cut ${ranges.length} ${what} (${total.toFixed(1)} s). ⌘Z puts them back.`, 5000);
    refresh();
  };
  const selectedRanges = () => {
    const sel = [...textBox.querySelectorAll('.w.sel')].map(e => words[Number(e.dataset.i)]);
    return sel.map(w => ({ t: w.t, end: w.end + 0.03 }));
  };
  const panelEl = el('div', { class: 'fx-editor tx-panel' }, head,
    el('div', { class: 'row tx-row' }, lang, track, btn('LISTEN', 'Transcribe (again) with this language', () => load(true))),
    el('div', { class: 'row tx-row' }, find, btn('CUT MATCHES', 'Cut every place these words are said', () => {
      const q = find.value.trim().toLowerCase().split(/\s+/).filter(Boolean); if (!q.length) return;
      const r = [];
      for (let i = 0; i + q.length <= words.length; i++) if (q.every((x, k) => words[i + k].text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '') === x.replace(/[^\p{L}\p{N}']/gu, ''))) r.push({ t: words[i].t, end: words[i + q.length - 1].end + 0.03 });
      cut(r, `"${find.value.trim()}"`);
    })),
    textBox,
    el('div', { class: 'row tx-row' },
      btn('CUT SELECTED', 'Cut the words you selected (or press Delete)', () => cut(selectedRanges(), 'selected words')),
      btn('REMOVE FILLERS', 'Cut um, uh, you know, standalone like…', () => cut(fillerRanges(words), 'filler words')),
      btn('TIGHTEN PAUSES', 'Shorten every pause over 0.8 s to 0.3 s', () => cut(pauseRanges(words, { longer: 0.8, keep: 0.3 }), 'long pauses'))),
    status,
    el('p', { class: 'note', text: 'Click a word to jump there; drag or ⇧-click to select several, then Delete cuts them from every track (ripple). Captions and markers move with the edit.' }));
  panel = panelEl;
  document.body.append(panelEl);
  head.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const r = panelEl.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const mv = ev => { panelEl.style.left = Math.max(0, ev.clientX - dx) + 'px'; panelEl.style.top = Math.max(0, ev.clientY - dy) + 'px'; panelEl.style.right = 'auto'; };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  });
  // selection by click / shift-click / drag across words
  let anchor = -1, dragging = false;
  const mark = (a, b) => { const lo = Math.min(a, b), hi = Math.max(a, b); textBox.querySelectorAll('.w').forEach(e => { const i = Number(e.dataset.i); e.classList.toggle('sel', i >= lo && i <= hi); }); };
  textBox.addEventListener('pointerdown', e => {
    const w = e.target.closest('.w'); if (!w) return;
    const i = Number(w.dataset.i);
    if (e.shiftKey && anchor >= 0) mark(anchor, i); else { anchor = i; mark(i, i); app.seek(words[i].t); }
    dragging = true;
  });
  textBox.addEventListener('pointerover', e => { if (!dragging) return; const w = e.target.closest('.w'); if (w) mark(anchor, Number(w.dataset.i)); });
  window.addEventListener('pointerup', () => { dragging = false; });
  textBox.addEventListener('keydown', e => { if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); e.stopPropagation(); cut(selectedRanges(), 'selected words'); } });
  const render = () => {
    const nodes = [];
    words.forEach((w, i) => {
      if (i > 0 && w.t - words[i - 1].end > 0.8) nodes.push(el('span', { class: 'gap', text: ` ⏸${(w.t - words[i - 1].end).toFixed(1)}s ` }));
      nodes.push(el('span', { class: 'w' + (w.conf < 0.4 ? ' low' : ''), 'data-i': i, text: w.text, title: `${w.t.toFixed(2)} s` }), ' ');
    });
    textBox.replaceChildren(...nodes);
  };
  // the transcript follows the playhead
  const follow = () => {
    if (!panel || !app.player.playing) return;
    const t = app.player.time; let k = -1;
    for (let i = 0; i < words.length; i++) if (words[i].t <= t) k = i; else break;
    textBox.querySelectorAll('.w.now').forEach(e => e.classList.remove('now'));
    const e = textBox.querySelector(`.w[data-i="${k}"]`); if (e) { e.classList.add('now'); }
  };
  app.player.onTime(follow);
  const refresh = async () => { try { words = await timelineWords(app, { locale: lang.value, track: track.value }); render(); status.textContent = `${words.length} words`; } catch (e) { status.textContent = e.message; } };
  async function load(force) {
    savePrefs({ ...prefs(), locale: lang.value, track: track.value });
    if (force) for (const m of app.doc.media) delete m.transcript;
    status.textContent = 'Listening…';
    try {
      words = await timelineWords(app, { locale: lang.value, track: track.value }, t => { status.textContent = t; });
      render(); status.textContent = `${words.length} words · ${words.filter(w => w.conf < 0.4).length} unsure (underlined)`;
    } catch (e) { status.textContent = e.message; }
  }
  track.addEventListener('change', () => load(false));
  load(false);
}
