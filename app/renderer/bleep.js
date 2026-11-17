// 🤬 Bleep swearing: for a podcast or interview where someone swears. Reel listens (on this Mac), finds the swear
// words and either bleeps them (the voice muted under a 1 kHz tone on a Bleeps track) or mutes them (the voice just
// drops out for the word). Captions show them starred (f***). Run it again with other settings to redo it; Remove
// takes them all out; ⌘Z undoes either. Auto Edit does the same as one of its parts.
import { el, modal, toast } from './ui.js';
import { newMediaClip, addTrack, uid } from './model.js';
import { swearRanges, applyBleeps, unbleep, bleepTone, swearTest, starred } from './lib/profanity.js';
import { timelineWords, trackSelect, LANGS, speechPrefs } from './transcript.js';
import { wavHeader } from './voiceover.js';

const PREF = 'reel.bleep';
const DEF = { mode: 'bleep', level: 'strong', extra: '', allow: '' };
export const bleepPrefs = () => { try { return { ...DEF, ...(JSON.parse(localStorage.getItem(PREF) || '{}') || {}) }; } catch { return { ...DEF }; } };
const save = p => { try { localStorage.setItem(PREF, JSON.stringify(p)); } catch { /* fine */ } };
const listOf = s => String(s || '').split(/[\s,;]+/).map(x => x.trim()).filter(Boolean).slice(0, 200);

/** The words settings as the finder takes them. */
export const swearOpts = p => ({ level: p.level, extra: listOf(p.extra), allow: listOf(p.allow) });

/** The tone's media (made once per project, 3 s of 1 kHz, kept in its media folder). */
async function toneMedia(app) {
  const have = app.doc.media.find(m => m.bleepTone);
  if (have) return have;
  const RATE = 48000, mono = bleepTone(3, RATE), n = mono.length, buf = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { buf[i * 2] = mono[i]; buf[i * 2 + 1] = mono[i]; }
  const { id: rid } = await app.api.renderBegin(app.token, 'Bleep tone', 'wav');
  app.api.renderChunk(rid, new Uint8Array(buf.buffer));
  const info = await app.api.renderFinish(rid, wavHeader(n, 2, RATE));
  const m = { id: uid('m'), ...info, name: 'Bleep tone (1 kHz)', bleepTone: true, kind: 'audio', hasAudio: true, duration: 3 };
  app.doc.media.push(m); // saved with the bleeps' own change
  return m;
}

/**
 * Bleeps or mutes the swear words in words (timed words on the timeline), and stars them in the captions. Returns
 * { n, words: the swear words found }. Replaces what an earlier run did.
 */
export async function bleepWords(app, words, p = bleepPrefs()) {
  const opts = swearOpts(p), ranges = swearRanges(words, opts);
  const tone = p.mode === 'bleep' && ranges.length ? await toneMedia(app) : null;
  const is = swearTest(opts);
  let n = 0;
  app.commit(d => {
    n = applyBleeps(d, ranges, { mode: p.mode, tone, newClip: newMediaClip, addTrack });
    // the captions there are: the words starred
    if (n && d.captions?.length) d.captions = d.captions.map(c => ({ ...c, text: String(c.text).replace(/[\p{L}\p{N}'’*]+/gu, w => (is(w) ? starred(w) : w)) }));
    // an empty Bleeps track from before goes
    d.tracks = d.tracks.filter(t => !t.bleeps || d.clips.some(c => c.track === t.id));
  });
  return { n, words: ranges.map(r => r.text) };
}

export async function openBleep(app) {
  if (!app.doc) return;
  const p = bleepPrefs(), sp = speechPrefs();
  const seg = (key, levels) => {
    const box = el('div', { class: 'seg ae-seg' });
    const draw = () => box.replaceChildren(...levels.map(([k, label, title]) => el('button', { class: p[key] === k ? 'on' : '', type: 'button', text: label, title, onclick: () => { p[key] = k; draw(); } })));
    draw(); return box;
  };
  const lang = el('select', {}, ...LANGS.map(([v, t]) => el('option', { value: v, text: t, selected: v === sp.locale })));
  const track = trackSelect(app.doc, sp.track);
  const extra = el('input', { type: 'text', value: p.extra, placeholder: 'more words to bleep, with * for any ending (frick*, a name…)', spellcheck: false });
  const allow = el('input', { type: 'text', value: p.allow, placeholder: 'words to leave in (hell, damn…)', spellcheck: false });
  const status = el('p', { class: 'note', text: '' }), bar = el('div', { class: 'progress hidden' }, el('i'));
  const row = (label, ...kids) => el('div', { class: 'row' }, el('label', { text: label }), ...kids);
  let busy = false;
  return modal('🤬 Bleep swearing', el('div', { class: 'newdoc' },
    el('p', { class: 'note', text: 'For a podcast or interview where someone swears. Reel listens (on this Mac), finds the swear words and bleeps them, or just mutes them. The word is muted on every clip of that recording (the mic and the camera’s own sound); music and sound effects carry on. Captions show them starred (f***).' }),
    row('Do', seg('mode', [['bleep', '📢 Bleep', 'Mute the word and play a bleep over it (on a Bleeps track)'], ['mute', '🔇 Mute', 'Just drop the voice out for the word']])),
    row('Words', seg('level', [['strong', 'Swearing & slurs', 'f-word, s-word and the like, and slurs'], ['all', '+ mild ones', 'also damn, hell, crap, ass, piss…']])),
    row('Also bleep', extra), row('Leave in', allow),
    row('Language', lang), row('Listen to', track),
    el('p', { class: 'note', text: 'Run it again with other settings to redo it. The bleeps are ordinary clips on the Bleeps track (move, shorten or delete one), and the mutes are points on the clip’s volume line.' }),
    bar, status), [
    { label: 'Cancel', onClick: c => { if (!busy) c(); } },
    { label: 'Remove bleeps', onClick: c => { if (busy) return; let n = 0; app.commit(d => { n = d.clips.filter(x => x.style === 'auto-bleep').length; unbleep(d); d.tracks = d.tracks.filter(t => !t.bleeps || d.clips.some(x => x.track === t.id)); }); c(); toast(n ? 'Took the bleeps and mutes out (captions keep their stars). ⌘Z puts them back.' : 'Took out the mutes. ⌘Z puts them back.', 4000); } },
    { label: 'Bleep them', cls: 'hw amber', onClick: async (c, btn) => {
      if (busy) return; busy = true; btn.disabled = true; bar.classList.remove('hidden');
      Object.assign(p, { extra: extra.value, allow: allow.value }); save(p);
      try {
        const words = await timelineWords(app, { locale: lang.value, track: track.value }, (msg, v) => { status.textContent = msg; bar.firstChild.style.width = Math.round((v || 0) * 100) + '%'; });
        if (!words.length) throw new Error('No speech found to listen to.');
        const r = await bleepWords(app, words, p);
        c(); app.renderAll?.();
        toast(r.n ? `${p.mode === 'bleep' ? 'Bleeped' : 'Muted'} ${r.n} swear word${r.n === 1 ? '' : 's'}${r.n <= 6 ? ` (${r.words.map(starred).join(', ')})` : ''}. ⌘Z undoes it.` : 'No swearing found. (Add words under “Also bleep” if one was missed.)', 7000);
      } catch (e) { status.textContent = e.message; busy = false; btn.disabled = false; }
    } },
  ]);
}
