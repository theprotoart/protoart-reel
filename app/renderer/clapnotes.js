// Clap notes in the editor: puts a note card (lib/elements.js noteCard) on a "Notes" track at each clap, holding
// what was said after it (lib/clapnotes.js). Used by Auto Edit (Claps › Show as notes) and by Find Clap Markers.
import { el, modal, toast } from './ui.js';
import { newElementClip, addTrack, removeRange, uid } from './model.js';
import { elementHome } from './lib/elements.js';
import { planNotes, shiftWords, shiftTimes } from './lib/clapnotes.js';
import { timelineWords, LANGS } from './transcript.js';

/**
 * Puts the note cards in the project (one undo step). times: clap points on the timeline (claps already cut).
 * cutSpeech: cut each spoken note out (with its picture), so the note only shows as text.
 * Returns { n, placeholders, cuts, words } — words moved to match any cuts.
 */
export function placeClapNotes(app, words, times, { cutSpeech = false } = {}) {
  const plan = planNotes(words, times, { cutSpeech });
  const cuts = [];
  if (cutSpeech) {
    plan.forEach((p, i) => {
      if (!p.said) return;
      const next = plan[i + 1]?.t ?? Infinity;
      const a = Math.max(p.t, p.said[0] - 0.1), b = Math.min(next - 0.05, p.said[1] + 0.25);
      if (b > a + 0.2) cuts.push([a, b]);
    });
  }
  const at = shiftTimes(plan.map(p => p.t), cuts);
  app.commit(d => {
    for (const [a, b] of [...cuts].reverse()) removeRange(d, a, b);
    let tr = d.tracks.find(t => t.noteTrack);
    if (!tr) { tr = addTrack(d, 0); tr.name = 'Notes'; tr.noteTrack = true; }
    plan.forEach((p, i) => {
      const c = newElementClip(tr.id, at[i], 'noteCard', elementHome('noteCard'), p.dur);
      c.id = uid('c'); c.autoNote = true;
      c.element = { kind: 'noteCard', text: p.items.join('\n'), sub: p.title };
      c.name = `Note: ${p.title ? p.title.toLowerCase().replace(/^\w/, x => x.toUpperCase()) : p.items[0]}`.slice(0, 60);
      d.clips.push(c);
    });
  });
  return { n: plan.length, placeholders: plan.filter(p => p.placeholder).length, cuts, words: cuts.length ? shiftWords(words, cuts) : words };
}

/** Find Clap Markers › Make on-screen notes: cut the claps, listen, and put the notes on screen. */
export async function clapNotesFromSignals(app, sigs) {
  const cut = el('input', { type: 'checkbox' });
  const lang = el('select', {}, ...LANGS.map(([v, t]) => el('option', { value: v, text: t })));
  try { const l = JSON.parse(localStorage.getItem('reel.autoedit') || '{}').locale; if (l) lang.value = l; } catch { /* fine */ }
  const go = await new Promise(res => modal('On-screen notes', el('div', {},
    el('p', { text: `Each of the ${sigs.length} clap signal${sigs.length === 1 ? '' : 's'} becomes a note card with what you said right after it, as a list (“Ingredients: two eggs, flour and salt” → INGREDIENTS · Two eggs · Flour · Salt). The claps are cut out. Edit any card in the inspector afterwards.` }),
    el('label', { class: 'row' }, cut, el('span', { text: ' Cut what I said after each clap too, so the note only shows as text (that bit of the video goes as well)' })),
    el('div', { class: 'row' }, el('label', { text: 'Language' }), lang)), [
    { label: 'Cancel', onClick: c => { c(); res(false); } },
    { label: 'Make the notes', cls: 'hw amber', onClick: c => { c(); res(true); } },
  ]));
  if (!go) return;
  const times = [];
  app.commit(d => {
    for (const x of [...sigs].reverse()) removeRange(d, x.t0, x.t1);
    let shift = 0;
    for (const x of sigs) { times.push(x.t0 - shift); shift += x.t1 - x.t0; }
  });
  toast('Listening to what you said after each clap…', 4000);
  let words = [];
  try { words = await timelineWords(app, { locale: lang.value, track: '' }); }
  catch (e) { toast(`Couldn’t listen to the speech (${e.message}). The cards say “Type your note here”.`, 6000); }
  const r = placeClapNotes(app, words, times, { cutSpeech: cut.checked });
  toast(`${r.n} note card${r.n === 1 ? '' : 's'} on the Notes track. Click one to edit its list in the inspector.`, 6000);
}
