// Kitten voices in Speech from text: natural voices (KittenTTS 2, on this Mac), emotion and delivery, vocal beats
// (<laugh>, <sigh>…), emphasis, and voices cloned from a part of a clip (your own voice, to fix a line).
import { el, toast, promptText, ask } from './ui.js';
import { mediaById } from './model.js';
import { openAudio } from './lib/sources.js';

export const EMOTIONS = ['angry', 'contemplative', 'excited', 'joyful', 'mundane', 'nervous', 'sad', 'stern', 'surprised', 'tender'];
export const EVENTS = ['laugh', 'giggle', 'sigh', 'pause', 'um', 'gasp', 'gulp', 'scoff', 'sob', 'growl'];
const LANGUAGES = ['Arabic', 'Chinese', 'French', 'German', 'Hindi', 'Italian', 'Portuguese', 'Russian', 'Spanish', 'Japanese', 'Korean', 'Turkish', 'Dutch', 'Swedish', 'Danish', 'Finnish', 'Swahili', 'Greek', 'Hebrew'];
const CLASSIC = ['Bella', 'Jasper', 'Luna', 'Bruno', 'Rosie', 'Hugo', 'Kiki', 'Leo'];
// KittenML's own descriptions of its character voices
export const CHARACTERS = {
  Matthew: 'exhausted mechanic', Elliot: 'grieving, young', Willow: 'hushed, young', Dolores: 'southern, elderly', Victor: 'controlled fury, older',
  Dante: 'playful, smooth', Alfred: 'tender, older', Saoirse: 'joyful Irish', Claire: 'playful professional', Raven: 'controlled fury, young',
  Marcus: 'smooth radio DJ', Herbert: 'wise elderly professor', Diana: 'stern military officer', Laurence: 'dramatic stage actor',
  Maeve: 'cozy storyteller', Walter: 'warm grandfather', Edith: 'soft grandmother', Miles: 'gentle librarian', Grace: 'soothing nurse',
  Reginald: 'elderly diplomat', Iris: 'hushed museum guide', Frank: 'gravelly war veteran', Serena: 'gentle yoga instructor',
  Julian: 'dreamy poet', Eleanor: 'somber historian', Otis: 'rumbling blues musician', Vincent: 'hushed museum guide',
  Martha: 'weathered radio journalist', Sable: 'hushed conspirator', Victoria: 'regal narrator',
};

/** The voice list, grouped: saved voices first, then the classics, characters, the rest, and (greyed out unless
 *  `langs`) the voices that speak other languages. English is the default. */
export function voiceGroups(builtin, mine, langs = false) {
  const has = new Set(builtin);
  const take = names => names.filter(n => has.has(n));
  const used = new Set([...CLASSIC, ...Object.keys(CHARACTERS), ...LANGUAGES]);
  return [
    ['My voices', mine.map(v => ({ value: 'mine:' + v.id, text: `${v.name} (cloned)` }))],
    ['Voices', take(CLASSIC).map(n => ({ value: n, text: n }))],
    ['Characters', take(Object.keys(CHARACTERS)).map(n => ({ value: n, text: `${n} · ${CHARACTERS[n]}` }))],
    ['More voices', builtin.filter(n => !used.has(n)).sort().map(n => ({ value: n, text: n }))],
    [langs ? 'Other languages' : 'Other languages (tick “Other languages” to use)', take(LANGUAGES).map(n => ({ value: n, text: `${n} (speaks ${n})`, disabled: !langs }))],
  ].filter(([, list]) => list.length);
}

/** The text as the model reads it: an emotion tag at the start of every paragraph that hasn't got one. */
export function withEmotion(text, emotion) {
  if (!emotion || !EMOTIONS.includes(emotion)) return text.trim();
  return text.trim().split(/\n\s*\n/).map(p => (/^\s*\[[a-z]+\]/i.test(p) ? p : `[${emotion}] ${p.trim()}`)).join('\n\n');
}

/** Wraps the selection in (((emphasis))), or puts a <beat> at the caret. */
export function insertAt(area, before, after = '') {
  const a = area.selectionStart ?? area.value.length, b = area.selectionEnd ?? a;
  const sel = area.value.slice(a, b);
  const pad = s => (a > 0 && !/\s$/.test(area.value.slice(0, a)) && !after ? ' ' : '') + s;
  const ins = after ? `${before}${sel || 'word'}${after}` : pad(before) + (/^\s/.test(area.value.slice(b)) ? '' : ' ');
  area.setRangeText(ins, a, b, 'end');
  area.focus();
}

/** Mono samples of `seconds` of a clip's sound, from the playhead if it's inside the clip (else the clip's start). */
export async function clipSpeech(app, c, seconds = 15) {
  const m = mediaById(app.doc, c.media);
  if (!m || !(m.kind === 'audio' || m.hasAudio)) throw new Error('Pick a clip with someone speaking in it.');
  const sp = c.speed || 1, t = app.player.time;
  const inClip = t >= c.start && t < c.start + c.duration - 1;
  const from = (c.in || 0) + (inClip ? (t - c.start) * sp : 0), end = (c.in || 0) + c.duration * sp;
  const len = Math.min(seconds, end - from);
  if (len < 5) throw new Error('A voice needs at least 5 seconds of one person speaking. Pick a longer clip, or put the playhead earlier in it.');
  const audio = await openAudio(`app://reel/m/${app.token}/${encodeURIComponent(m.file)}`, m.file);
  if (!audio) throw new Error('That clip has no sound.');
  try {
    const rate = audio.rate, n = Math.round(len * rate);
    const chs = await audio.read(Math.round(from * rate), n);
    const mono = new Float32Array(n);
    for (const ch of chs) for (let i = 0; i < n; i++) mono[i] += ch[i] / chs.length;
    let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(mono[i]));
    if (peak < 0.003) throw new Error('That part is silent. Put the playhead where the person is talking.');
    return { media: m, from, to: from + len, rate, samples: mono };
  } finally { audio.close?.(); }
}

/** Saves a voice from the selected clip: its sound, and what's said in it (heard by the Mac's speech recognition). */
export async function cloneFromSelection(app, onStatus) {
  const c = app.doc.clips.find(x => app.selection.clips.includes(x.id) && x.type === 'media');
  if (!c) throw new Error('Select a clip of the person speaking first (5 to 30 seconds of just them, no music).');
  onStatus('Reading the clip…');
  const s = await clipSpeech(app, c);
  onStatus('Listening to what’s said…');
  let locale = 'en-US'; try { locale = JSON.parse(localStorage.getItem('reel.speech') || '{}').locale || locale; } catch { /* default */ }
  const r = await app.api.speechTranscribe(app.token, s.media.file, s.from, s.to, locale, 'kitten-clone');
  const text = (r?.words || []).map(w => w.w || w.text || '').join(' ').replace(/\s+/g, ' ').trim();
  if (text.split(' ').length < 4) throw new Error('No speech was heard in that part. Put the playhead where the person is talking.');
  onStatus('');
  const name = await promptText('Save this voice', `Heard: “${text.slice(0, 220)}${text.length > 220 ? '…' : ''}”\n\nName the voice:`, s.media.name?.replace(/\.[^.]+$/, '').slice(0, 30) || 'My voice', 'Save voice');
  if (!name) return null;
  return app.api.kittenSaveVoice(name, s.samples, s.rate, text);
}

const clean = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

/** The Kitten half of Speech from text. Returns { root, ready(), request(text) }. */
export function kittenPanel(app, { clone = false } = {}) {
  const root = el('div', { class: 'kit' });
  const note = el('p', { class: 'note' });
  const bar = el('div', { class: 'progress hidden' }, el('i'));
  let st = null, pick = null, emo = null, delivery = 'stable', busy = false;
  const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem('reel.kitten.' + k); localStorage.setItem('reel.kitten.' + k, v); } catch { /* fine */ } return null; };

  if (!app._kittenListen) {
    app._kittenListen = true;
    app.api.onAi?.(ev => {
      if (ev?.type !== 'kittenSetup') return;
      const b = document.querySelector('.kit .progress i'); if (b) b.style.width = Math.round(ev.f * 100) + '%';
      const n = document.querySelector('.kit .kit-setup-note'); if (n && ev.msg) n.textContent = ev.msg;
    });
  }

  const draw = async () => {
    st = await app.api.kittenStatus().catch(e => ({ allowed: false, reason: clean(e) }));
    root.replaceChildren();
    if (!st.allowed) { root.append(el('p', { class: 'note', text: st.reason })); return; }
    if (!st.ready) {
      const go = el('button', { class: 'hw amber', text: st.installed ? 'FINISH SETTING UP' : 'GET KITTEN VOICES' });
      const stopB = el('button', { class: 'tool hidden', text: 'Stop', onclick: () => app.api.kittenSetupCancel() });
      const sn = el('p', { class: 'note kit-setup-note', text: `One-time download, about ${st.gb} GB. It installs into Reel's own folder and then works offline.${st.tight ? ' On a Mac with 8 GB, close other big apps while it speaks.' : ''}` });
      go.onclick = async () => {
        go.disabled = true; stopB.classList.remove('hidden'); bar.classList.remove('hidden');
        try { await app.api.kittenSetup(); toast('Kitten voices are ready.'); }
        catch (e) { sn.textContent = clean(e) === 'Stopped' ? 'Stopped. Press GET again to carry on.' : `Couldn’t set up the voices: ${clean(e)}`; go.disabled = false; stopB.classList.add('hidden'); bar.classList.add('hidden'); return; }
        draw();
      };
      root.append(
        el('p', { class: 'kit-pitch', text: '115 natural voices, emotion and delivery, and your own voice cloned from a clip. Made by KittenTTS 2 on this Mac’s graphics chip: nothing is uploaded.' }),
        el('div', { class: 'btn-row' }, go, stopB), bar, sn);
      if (clone) sn.textContent = 'To clone your voice, first press GET KITTEN VOICES (one time). ' + sn.textContent;
      return;
    }
    // ready: voice, emotion, delivery, beats
    const langs = pref('langs') === '1';
    pick = el('select', {}, ...voiceGroups(st.voices, st.mine || [], langs).map(([label, list]) => el('optgroup', { label }, ...list.map(o => el('option', o)))));
    const saved = pref('voice');
    pick.value = saved && [...pick.options].some(o => o.value === saved && !o.disabled) ? saved : 'Bruno';
    const langBox = el('input', { type: 'checkbox', checked: langs });
    langBox.addEventListener('change', () => { pref('langs', langBox.checked ? '1' : ''); if (!langBox.checked && LANGUAGES.includes(pick.value)) pref('voice', 'Bruno'); draw(); });
    const forget = el('button', { class: 'mini', text: 'Remove', title: 'Move this saved voice’s recording to the Trash' });
    const syncForget = () => { forget.style.display = pick.value.startsWith('mine:') ? '' : 'none'; };
    forget.onclick = async () => {
      const id = pick.value.slice(5), v = (st.mine || []).find(x => x.id === id);
      if (!v || !(await ask('Remove saved voice', `Move “${v.name}” to the Trash? Speech already made with it stays.`, 'Remove'))) return;
      await app.api.kittenDeleteVoice(id); pref('voice', ''); draw();
    };
    pick.addEventListener('change', () => { pref('voice', pick.value); syncForget(); });
    syncForget();
    emo = el('select', {}, el('option', { value: '', text: 'Neutral' }), ...EMOTIONS.map(e => el('option', { value: e, text: e[0].toUpperCase() + e.slice(1) })));
    emo.value = pref('emotion') || '';
    emo.addEventListener('change', () => pref('emotion', emo.value));
    delivery = pref('delivery') === 'expressive' ? 'expressive' : 'stable';
    const seg = el('div', { class: 'seg' });
    for (const [v, t] of [['stable', 'Steady'], ['expressive', 'Expressive']]) seg.append(el('button', { 'data-v': v, text: t, class: v === delivery ? 'on' : '', onclick: () => { delivery = v; pref('delivery', v); for (const b of seg.children) b.classList.toggle('on', b.dataset.v === v); } }));
    const area = () => root.closest('.modal-body')?.querySelector('textarea');
    const beats = el('div', { class: 'kit-beats' },
      ...EVENTS.map(e => el('button', { class: 'mini', text: `<${e}>`, title: `Insert a ${e} where the cursor is`, onclick: () => area() && insertAt(area(), `<${e}>`) })),
      el('button', { class: 'mini', text: '(((stress)))', title: 'Stress the selected word', onclick: () => area() && insertAt(area(), '(((', ')))') }));
    const cloneB = el('button', { class: 'tool', text: '＋ Clone a voice from the selected clip', onclick: async () => {
      cloneB.disabled = true;
      try { const v = await cloneFromSelection(app, t => { note.textContent = t; }); if (v) { pref('voice', 'mine:' + v.id); toast(`Saved “${v.name}”. It’s first in the voice list.`); await draw(); } }
      catch (e) { note.textContent = clean(e); }
      cloneB.disabled = false;
    } });
    root.append(
      el('div', { class: 'row' }, el('label', { text: 'Voice' }), pick, forget),
      el('label', { class: 'row kit-langs', title: 'Voices that speak Arabic, Chinese, French, German, Hindi, Italian, Spanish and more. They come with the model (no extra download); off, the list stays English.' }, langBox, el('span', { text: 'Other languages (voices that speak French, Spanish, German, Chinese…)' })),
      el('div', { class: 'row' }, el('label', { text: 'Emotion' }), emo),
      el('div', { class: 'row' }, el('label', { text: 'Delivery' }), seg),
      el('div', { class: 'row' }, el('label', { text: 'Add' }), beats),
      el('div', { class: 'btn-row' }, cloneB),
      note,
      el('p', { class: 'note', text: 'Clone: select a clip of one person talking (no music) and put the playhead where they start; 15 seconds from there are used. Only clone voices you have permission to use. Language voices speak their own language: type in it.' }));
    if (clone) { clone = false; setTimeout(() => cloneB.click(), 50); }
  };
  draw();

  return {
    root,
    ready: () => !!st?.ready,
    async make(text) {
      if (busy) return null;
      busy = true;
      try {
        const v = pick.value, lang = LANGUAGES.includes(v);
        const req = { text: withEmotion(text, emo.value), preset: delivery, normalize: !lang };
        if (v.startsWith('mine:')) req.mine = v.slice(5); else req.voice = v;
        return await app.api.kittenSay(app.token, req);
      } finally { busy = false; }
    },
  };
}
