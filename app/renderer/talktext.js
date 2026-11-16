// 💬 Talking text: your words on screen as you say them, for videos where the viewer hears you but doesn't see you.
// Spoken lines along the bottom (each word lights up as it's said), and the key words popping up big in the middle
// in a mix of eye-catching looks, now and then with an emoji. Everything lands on two tracks of its own, made again
// each time (so running it twice doesn't double up), as one ⌘Z.
import { el, modal, toast } from './ui.js';
import { newTextClip, newElementClip, addTrack, duration as docDuration } from './model.js';
import { TALK_MODES, TALK_LOOKS, TALK_AMOUNTS, planTalkingText } from './lib/talktext.js';
import { TITLE_LOOKS } from './fxlibrary.js';
import { timelineWords, trackSelect, LANGS, speechPrefs } from './transcript.js';

const PREF = 'reel.talktext';
const load = () => { try { return { mode: 'both', look: 'green', amount: 'few', ...(JSON.parse(localStorage.getItem(PREF) || '{}') || {}) }; } catch { return { mode: 'both', look: 'green', amount: 'few' }; } };
const save = p => { try { localStorage.setItem(PREF, JSON.stringify(p)); } catch { /* fine */ } };

const LINE_LOOKS = {
  green: () => TITLE_LOOKS.lookSpoken, yellow: () => TITLE_LOOKS.lookSpokenYellow, box: () => TITLE_LOOKS.lookSpokenBox, one: () => TITLE_LOOKS.lookOneWord,
  clean: () => ({ anim: 'karaoke', font: 'Avenir Next', weight: 700, size: 70, stroke: 0, shadow: 0, bg: '#000000', bgOpacity: 0.55, padding: 20, accent: 'color', accentColor: '#ffb02a', hiColor: '#ffb02a', width: 0.8 }),
};

/** Puts the plan on the timeline: { lines, pops } from planTalkingText. Replaces what an earlier run put there. */
export function placeTalkingText(doc, plan, { look = 'green', tall = false } = {}) {
  doc.clips = doc.clips.filter(c => !c.autoTalk);
  doc.tracks = doc.tracks.filter(t => !t.talkTrack || doc.clips.some(c => c.track === t.id));
  const made = { lines: 0, pops: 0, emoji: 0 };
  if (!plan.lines.length && !plan.pops.length) return made;
  const track = (key, name) => { let t = doc.tracks.find(x => x.talkTrack === key); if (!t) { t = addTrack(doc, 0); t.name = name; t.talkTrack = key; } return t; };
  if (plan.lines.length) {
    const tr = track('lines', 'Talking text');
    const { name, content, ...L } = LINE_LOOKS[look]?.() || LINE_LOOKS.green(); void name; void content;
    const one = look === 'one', upper = look !== 'clean';
    for (const l of plan.lines) {
      const c = newTextClip(tr.id, l.t, upper ? l.text.toUpperCase() : l.text);
      c.duration = l.dur; c.autoTalk = true; c.name = l.text;
      c.text = { ...c.text, ...L, wordTimes: l.wordTimes, animDur: 0.3, size: Math.round((L.size || 90) * (one ? (tall ? 0.95 : 0.8) : tall ? 0.86 : 0.78)), width: tall ? 0.88 : 0.82 };
      c.props.y = one ? 0.5 : tall ? 0.7 : 0.83; // under the middle, over the screen's lower edge (and above captions' usual place on a tall video)
      doc.clips.push(c); made.lines++;
    }
  }
  if (plan.pops.length) {
    const tr = track('pops', 'Talking text · key words'), fx = plan.pops.some(p => p.emoji) ? track('emoji', 'Talking text · emoji') : null;
    for (const p of plan.pops) {
      const { name, content, ...L } = TITLE_LOOKS[p.look] || TITLE_LOOKS.lookBigPop; void name; void content;
      const c = newTextClip(tr.id, p.t, p.text);
      c.duration = p.dur; c.autoTalk = true; c.name = p.text.replace(/[*\n]/g, ' ').trim();
      c.text = { ...c.text, ...L, size: Math.round((L.size || 100) * (tall ? 0.8 : 0.85)), width: tall ? 0.86 : 0.7 };
      c.props.y = tall ? 0.38 : 0.4;
      doc.clips.push(c); made.pops++;
      if (p.emoji && fx) {
        const e = newElementClip(fx.id, p.t + 0.15, 'emojiPop', { x: 0.5, y: tall ? 0.24 : 0.16, scale: tall ? 0.7 : 0.5 }, Math.max(1, p.dur - 0.15)); // above the words, clear of them
        e.element = { kind: 'emojiPop', text: p.emoji }; e.autoTalk = true; e.name = `Emoji ${p.emoji}`;
        doc.clips.push(e); made.emoji++;
      }
    }
  }
  return made;
}

export async function openTalkingText(app) {
  if (!app.doc) return;
  const p = load(), sp = speechPrefs();
  const seg = (key, levels) => {
    const box = el('div', { class: 'seg ae-seg' });
    const draw = () => box.replaceChildren(...Object.entries(levels).map(([k, [label]]) => el('button', { class: p[key] === k ? 'on' : '', type: 'button', text: label, onclick: () => { p[key] = k; draw(); } })));
    draw(); return box;
  };
  const lang = el('select', {}, ...LANGS.map(([v, t]) => el('option', { value: v, text: t, selected: v === sp.locale })));
  const track = trackSelect(app.doc, sp.track);
  const status = el('p', { class: 'note', text: '' }), bar = el('div', { class: 'progress hidden' }, el('i'));
  const row = (label, ...kids) => el('div', { class: 'row' }, el('label', { text: label }), ...kids);
  let busy = false;
  const dlg = modal('💬 Talking text', el('div', { class: 'newdoc tt-dlg' },
    el('p', { class: 'note', text: 'Your words on screen as you say them, for videos where people hear you but don’t see you. Spoken words run along the bottom, each word lighting up as you say it; the key words (a question, a number, a tip, a “never”) pop up big in the middle, now and then with an emoji. Reel listens on this Mac.' }),
    row('Show', seg('mode', Object.fromEntries(Object.entries(TALK_MODES).filter(([k]) => k !== 'off')))),
    row('Spoken words', seg('look', TALK_LOOKS)),
    row('Key words', seg('amount', TALK_AMOUNTS)),
    row('Language', lang), row('Listen to', track),
    el('p', { class: 'note', text: 'They go on their own tracks at the top (Talking text…): every one is an ordinary title you can restyle, retime or delete. Run it again to make them fresh; ⌘Z takes them all off.' }),
    bar, status), [
    { label: 'Cancel', onClick: c => { if (!busy) c(); } },
    { label: 'Remove them', onClick: c => { if (busy) return; let n = 0; app.commit(d => { n = d.clips.filter(x => x.autoTalk).length; placeTalkingText(d, { lines: [], pops: [] }); }); c(); toast(n ? `Took off ${n} talking-text clip${n === 1 ? '' : 's'}. ⌘Z puts them back.` : 'There’s no talking text in this project.', 3500); } },
    { label: 'Add talking text', cls: 'hw amber', onClick: async (c, btn) => {
      if (busy) return; busy = true; btn.disabled = true; bar.classList.remove('hidden'); save(p);
      try {
        const words = await timelineWords(app, { locale: lang.value, track: track.value }, (msg, v) => { status.textContent = msg; bar.firstChild.style.width = Math.round((v || 0) * 100) + '%'; });
        if (!words.length) throw new Error('No speech found to put on screen.');
        const tall = app.doc.canvas.height > app.doc.canvas.width;
        const plan = planTalkingText(words, docDuration(app.doc), { mode: p.mode, amount: p.amount, tall });
        let made = null; app.commit(d => { made = placeTalkingText(d, plan, { look: p.look, tall }); });
        c(); app.renderAll?.();
        toast(`Talking text: ${[made.lines && `${made.lines} spoken line${made.lines === 1 ? '' : 's'}`, made.pops && `${made.pops} key word${made.pops === 1 ? '' : 's'}`, made.emoji && `${made.emoji} emoji`].filter(Boolean).join(', ') || 'nothing to show'}. ⌘Z takes it off.`, 6000);
      } catch (e) { status.textContent = e.message; busy = false; btn.disabled = false; }
    } },
  ]);
  return dlg;
}
