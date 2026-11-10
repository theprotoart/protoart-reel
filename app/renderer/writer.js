// ✍ The writer: Qwen (a small language model on this Mac) writes title ideas, a description and chapter names from
// what's said in the video. Three sizes; one too big for this Mac is shown greyed out with the reason. Without a
// model the chapters still come from the pauses in the speech, named from their first words.
import { el, modal, toast } from './ui.js';
import { fmtTime, duration as docDuration, uid } from './model.js';
import { timelineWords } from './transcript.js';
import { chapters as findChapters, sentences } from './lib/highlight.js';

const SYSTEM = 'You help creators publish their videos. Write in the same language as the transcript. Be specific to what is actually said; never invent facts, names or numbers. No hashtags, no emoji.';
const tc = t => fmtTime(Math.max(0, t)).replace(/\.\d$/, '');

/** The transcript as timed lines, trimmed evenly to about `max` characters (a long video is sampled, not cut off). */
export function transcriptText(words, max = 9000) {
  const ss = sentences(words, { pause: 0.8 });
  const lines = ss.map(s => `[${tc(s.t)}] ${s.text}`);
  const all = lines.join('\n');
  if (all.length <= max) return all;
  const keep = [], step = all.length / max;
  for (let i = 0; i < lines.length; i += Math.max(1, Math.round(step))) keep.push(lines[i]);
  return keep.join('\n').slice(0, max);
}

/** The request for titles, a description and a name for each chapter (times stay ours). */
export function writerPrompt(words, total, marks) {
  const parts = marks.map((c, i) => {
    const next = marks[i + 1]?.t ?? total;
    const said = words.filter(w => w.t >= c.t && w.t < next).slice(0, 40).map(w => w.w || w.text || '').join(' ');
    return `${i + 1}. ${tc(c.t)}: "${said.slice(0, 220)}"`;
  });
  return `Video length: ${tc(total)}.\nTranscript:\n${transcriptText(words)}\n\n` +
    'Write exactly these three sections.\n' +
    'TITLES:\n5 title ideas, one per line, each under 70 characters, no quotes.\n' +
    'DESCRIPTION:\n2 short paragraphs for the video description.\n' +
    (parts.length ? `CHAPTERS:\nA short name (2 to 5 words) for each part, in order, as "1. name":\n${parts.join('\n')}\n` : '');
}

/** Pulls the sections out of the model's answer. Missing parts come back empty (the caller keeps its own). */
export function parseWriter(text, nChapters) {
  const sec = name => { const m = new RegExp(`${name}\\s*:?\\s*\\n([\\s\\S]*?)(?=\\n\\s*(TITLES|DESCRIPTION|CHAPTERS)\\s*:|$)`, 'i').exec(text); return m ? m[1].trim() : ''; };
  const strip = l => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, '').replace(/^["“]|["”]$/g, '').trim();
  const titles = sec('TITLES').split('\n').map(strip).filter(l => l && l.length <= 100).slice(0, 5);
  const description = sec('DESCRIPTION').replace(/\n{3,}/g, '\n\n');
  const names = [];
  for (const l of sec('CHAPTERS').split('\n')) {
    const m = /^\s*(\d+)[.)]\s*(?:\d{1,2}:\d{2}(?::\d{2})?\s*[:–—-]?\s*)?(.+)$/.exec(l);
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= nChapters) names[Number(m[1]) - 1] = strip(m[2]).replace(/["“”]/g, '').slice(0, 60);
  }
  return { titles, description, names };
}

/** Which writer models there are, and whether one is ready. */
async function status(app) { const none = { python: false, reason: 'The writer isn’t available.', models: {} }; try { return (await app.api.aiWriterStatus()) || none; } catch { return none; } }
export async function writerReady(app) { const st = await status(app); return st.python && Object.values(st.models || {}).some(m => m.ready && m.allowed); }

/** Names chapters (keeping their times) with the writer; returns the chapters unchanged if it can't. */
export async function nameChapters(app, words, marks) {
  if (!marks.length || !(await writerReady(app))) return marks;
  try {
    const total = docDuration(app.doc);
    const r = await app.api.aiWrite({ system: SYSTEM, prompt: writerPrompt(words, total, marks), maxTokens: 500, temperature: 0.4 });
    const { names } = parseWriter(r.text || '', marks.length);
    return marks.map((c, i) => (names[i] ? { ...c, label: names[i] } : c));
  } catch { return marks; }
}

export async function openWriter(app) {
  const doc = app.doc; if (!doc) return;
  const total = docDuration(doc);
  const models = el('div', { class: 'wr-models' }), out = el('div', { class: 'wr-out' }), note = el('p', { class: 'note' });
  const bar = el('div', { class: 'progress hidden' }, el('i'));
  let size = null, st = await status(app);
  const drawModels = () => {
    if (!st.python) { models.replaceChildren(el('p', { class: 'note', text: st.reason })); return; }
    models.replaceChildren(...Object.entries(st.models).map(([k, m]) => {
      const card = el('div', { class: 'wr-model' + (m.allowed ? '' : ' off') + (size === k ? ' lit' : ''), title: m.reason || '' },
        el('b', { text: m.label }), el('small', { text: m.allowed ? (m.ready ? 'Ready' : `${m.gb} GB download`) : m.reason }));
      if (m.allowed && m.ready) card.addEventListener('click', () => { size = k; drawModels(); });
      if (m.allowed && !m.ready) card.append(el('button', { class: 'tool', text: 'GET', onclick: async ev => {
        ev.stopPropagation(); bar.classList.remove('hidden'); note.textContent = `Downloading ${m.label}…`;
        try { await app.api.aiWriterSetup(k); st = await status(app); size = k; note.textContent = `${m.label} is ready.`; }
        catch (e) { note.textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''); }
        bar.classList.add('hidden'); drawModels();
      } }));
      return card;
    }));
  };
  app._writerListen ||= (app.api.onAi?.(ev => { if (ev?.type === 'writerSetup') { const b = document.querySelector('.wr .progress i'); if (b) b.style.width = Math.round(ev.f * 100) + '%'; const n = document.querySelector('.wr > .note'); if (n && ev.msg) n.textContent = ev.msg; } }), true);
  drawModels();

  const run = async btn => {
    btn.disabled = true; note.textContent = 'Listening to the video…';
    let words = [];
    try { words = await timelineWords(app, { locale: undefined, track: '' }, t => { note.textContent = t; }); }
    catch (e) { note.textContent = e.message; btn.disabled = false; return; }
    const marks = (doc.markers || []).filter(m => !m.claps && !m.autoJoin).length >= 2
      ? doc.markers.filter(m => !m.claps && !m.autoJoin).map(m => ({ t: m.t, label: m.label || 'Chapter' })).sort((a, b) => a.t - b.t)
      : findChapters(words, total);
    let titles = [], description = '', named = marks;
    if (await writerReady(app)) {
      note.textContent = 'Writing… (Qwen, on this Mac)';
      try {
        const r = await app.api.aiWrite({ system: SYSTEM, prompt: writerPrompt(words, total, marks), maxTokens: 900, temperature: 0.6, size });
        const p = parseWriter(r.text || '', marks.length);
        titles = p.titles; description = p.description; named = marks.map((c, i) => (p.names[i] ? { ...c, label: p.names[i] } : c));
        note.textContent = `Written by ${r.model}. Edit anything before you use it.`;
      } catch (e) { note.textContent = `The writer couldn’t write (${String(e.message || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')}). Chapters below come from the pauses in the speech.`; }
    } else note.textContent = 'No writer model yet (GET one above): chapters below come from the pauses in the speech.';
    const chText = el('textarea', { class: 'big', value: named.map(c => `${tc(c.t)} ${c.label}`).join('\n') });
    const desc = el('textarea', { class: 'big', value: description });
    out.replaceChildren(
      titles.length ? el('div', { class: 'engr', text: 'Title ideas' }) : null,
      ...titles.map(t => el('div', { class: 'wr-title' }, el('span', { text: t }),
        el('button', { class: 'mini', text: 'Copy', onclick: () => { navigator.clipboard?.writeText(t); toast('Copied.'); } }),
        el('button', { class: 'mini', text: 'Name the project', onclick: () => { app.commit(d => { d.name = t.slice(0, 80); }); const n = document.querySelector('#doc-name'); if (n) n.textContent = t.slice(0, 80); toast('Project renamed.'); } }))),
      description ? el('div', { class: 'engr', text: 'Description' }) : null, description ? desc : null,
      description ? el('button', { class: 'mini', text: 'Copy description', onclick: () => { navigator.clipboard?.writeText(desc.value); toast('Copied.'); } }) : null,
      el('div', { class: 'engr', text: 'Chapters (paste into the description)' }), chText,
      el('div', { class: 'btn-row' },
        el('button', { class: 'mini', text: 'Copy chapters', onclick: () => { navigator.clipboard?.writeText(chText.value); toast('Copied.'); } }),
        el('button', { class: 'tool', text: 'Put them on the timeline as markers', onclick: () => {
          const list = chText.value.split('\n').map(l => /^(\d+):(\d{2})(?::(\d{2}))?\s+(.+)$/.exec(l.trim())).filter(Boolean)
            .map(m => ({ t: m[3] != null ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]), label: m[4] }));
          app.commit(d => { d.markers = [...(d.markers || []).filter(k => !k.autoChapter), ...list.map(c => ({ id: uid('k'), t: c.t, label: c.label, autoChapter: true }))].sort((a, b) => a.t - b.t); });
          toast(`${list.length} chapter markers on the timeline. Export lists them as YouTube chapters.`);
        } })));
    btn.disabled = false;
  };
  const go = el('button', { class: 'hw amber', text: '✍ WRITE', onclick: e => run(e.currentTarget) });
  modal('✍ Title, description & chapters', el('div', { class: 'wr' },
    el('p', { class: 'note', text: 'Qwen, a small language model on this Mac, writes title ideas, a description and chapter names from what’s said in your video. Nothing is uploaded. A bigger model writes better and needs more memory.' }),
    models, bar, el('div', { class: 'btn-row' }, go), note, out), [], { wide: true });
}
