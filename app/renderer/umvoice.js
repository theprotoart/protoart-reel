// 🎙 Teach Reel your ums: record "umm" and "uh" a few times (slow, normal, quick) and read one sentence; Reel learns
// what your fillers sound like (lib/umvoice.js) and then finds them in your recordings for 💬 UMS and AUTO EDIT,
// including the ones speech recognition doesn't write down. Everything stays on this Mac (the model is kept in
// Reel's own storage here, never uploaded).
import { el, modal, drawer, toast, ask, popMenu } from './ui.js';
import { train, findInSamples, findInSequence, packModel, unpackModel, to16k, RATE, addTake, addNot, dropTakes, fingerprint } from './lib/umvoice.js';
import { openAudio } from './lib/sources.js';
import { soundOf, speechClips } from './transcript.js';
import { fmtTime as fmt } from './model.js';
import { playRange, setFillerWord, teachFillers, soundWords, newSoundWord, cutFillers } from './fillers.js';

/** Takes of each sound Reel needs to find it well (fewer: it's marked as needing more). */
export const ENOUGH = 10;

const KEY = 'reel.umvoice';
let cached;
/** Your trained model, or null. */
export function umModel() {
  if (cached !== undefined) return cached;
  try { cached = unpackModel(localStorage.getItem(KEY)); } catch { cached = null; }
  return cached;
}
/** Reads what Reel knows from storage again (↻ in the trainer). */
export function reloadModel() { cached = undefined; return umModel(); }
function saveModel(m) { cached = m; try { if (m) localStorage.setItem(KEY, packModel(m)); else localStorage.removeItem(KEY); } catch { /* storage unavailable: kept for this session */ } }

const recMic = () => { try { return (JSON.parse(localStorage.getItem('rec-settings') || '{}') || {}).micId || ''; } catch { return ''; } };

/** What you record, in order. */
const STEPS = [
  { word: 'umm', say: '“Ummm…” slowly, the way you do when you’re thinking', max: 4 },
  { word: 'umm', say: '“Umm” at your normal pace', max: 3 },
  { word: 'umm', say: '“Um” quickly, as if you’re about to go on', max: 3 },
  { word: 'uh', say: '“Uhhh…” slowly', max: 4 },
  { word: 'uh', say: '“Uh” at your normal pace', max: 3 },
  { word: 'uh', say: '“Uh” quickly', max: 3 },
  { word: 'speech', say: 'Read this in your normal voice: “Today I want to show you how I set this up, step by step, and what I’d do differently next time.”', max: 12 },
];

/** The trainer: folds open under the 🎙 TEACH MY UMS key (a window when that key isn't showing). Again folds it away. */
let open = null;
export function teachUms(app, { onDone } = {}) {
  if (open?.root.isConnected) { open.close(); return null; }
  const takes = STEPS.map(() => null);
  let cur = 0, stream = null, ctx = null, rec = null, chunks = [], timer = 0, raf = 0, t0 = 0;
  const list = el('div', { class: 'umt-list' });
  const meter = el('div', { class: 'vo-meter' }, el('i'));
  const status = el('p', { class: 'note umt-status' });
  const recB = el('button', { class: 'hw kit-rec-btn', text: '● RECORD' });
  const saveB = el('button', { class: 'hw amber', text: 'LEARN MY UMS', disabled: true });
  const draw = () => {
    // a step is learned when you recorded it now, or Reel already has ENOUGH (10) or more takes of that sound (the sentence:
    // when it has heard your ordinary speech): solid green; still needed: yellow with a black zig-zag
    const m = umModel();
    // green: learned (ENOUGH or more takes, or recorded now); blue: started (fewer); yellow zig-zag: not taught yet
    const takesOf = i => (STEPS[i].word === 'speech' ? (m?.near ? 3 : 0) : (m?.words.find(w => w.word === STEPS[i].word)?.prints.length || 0));
    const state = i => (takes[i] || takesOf(i) >= ENOUGH ? 'known' : takesOf(i) > 0 ? 'started' : 'needed');
    const tip = { known: 'Learned', started: `Started: ${ENOUGH} or more takes find it best`, needed: 'Not taught yet' };
    list.replaceChildren(...STEPS.map((s, i) => el('div', { class: 'umt-step' + (i === cur ? ' on' : '') + (takes[i] ? ' done' : '') + ' ' + state(i), title: tip[state(i)], onclick: () => { if (!rec) { cur = i; draw(); } } },
      el('span', { class: 'umt-n', text: takes[i] ? '✓' : String(i + 1) }), el('span', { class: 'umt-say', text: s.say + (takes[i]?.from ? ' · from the timeline' : '') }),
      takes[i]?.blob ? el('button', { class: 'mini', text: '▶', title: 'Listen back', onclick: e => { e.stopPropagation(); new Audio(URL.createObjectURL(takes[i].blob)).play(); } }) : null,
      takes[i] ? el('button', { class: 'mini umt-redo', text: '↺', title: 'Record this one again', onclick: e => { e.stopPropagation(); if (rec) return; takes[i] = null; cur = i; draw(); start(); } }) : null)));
    recB.textContent = rec ? '■ STOP' : takes[cur] ? '● RECORD AGAIN' : '● RECORD';
    recB.classList.toggle('lit', !!rec);
    // enough to learn from: two ums (the sentence helps it tell ums from words, but a guest may only have ums)
    saveB.disabled = takes.filter(t => t && t.word !== 'speech').length < 2;
    saveB.textContent = umModel() ? 'ADD TO WHAT REEL KNOWS' : 'LEARN MY UMS';
  };
  const release = () => { cancelAnimationFrame(raf); clearTimeout(timer); stream?.getTracks().forEach(t => t.stop()); stream = null; ctx?.close().catch(() => {}); ctx = null; meter.firstChild.style.width = '0%'; };
  async function start() {
    try {
      const mic = recMic();
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(mic ? { deviceId: { exact: mic } } : {}), channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch { status.textContent = 'The microphone isn’t available. Allow Reel in System Settings › Privacy & Security › Microphone.'; return; }
    ctx = new AudioContext();
    const an = ctx.createAnalyser(); an.fftSize = 1024; ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(1024);
    rec = new MediaRecorder(stream); chunks = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = finish;
    rec.start(200); t0 = performance.now();
    status.textContent = `Recording… ${STEPS[cur].say.replace(/^Read this[^:]*: /, 'read: ')} then press STOP (it stops by itself after ${STEPS[cur].max} s).`;
    const tick = () => {
      if (!list.isConnected) { stop(); release(); return; }
      an.getFloatTimeDomainData(buf); let p = 0; for (const v of buf) p = Math.max(p, Math.abs(v));
      meter.firstChild.style.width = Math.min(100, Math.sqrt(p) * 100) + '%';
      raf = requestAnimationFrame(tick);
    };
    tick();
    timer = setTimeout(stop, STEPS[cur].max * 1000);
    draw();
  }
  function stop() { if (rec && rec.state !== 'inactive') rec.stop(); }
  async function finish() {
    release(); rec = null;
    try {
      const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
      const dec = await new AudioContext().decodeAudioData(await blob.arrayBuffer());
      const mono = new Float32Array(dec.length);
      for (let c = 0; c < dec.numberOfChannels; c++) { const d = dec.getChannelData(c); for (let i = 0; i < d.length; i++) mono[i] += d[i] / dec.numberOfChannels; }
      let pk = 0; for (const v of mono) pk = Math.max(pk, Math.abs(v));
      if (pk < 0.01) { status.textContent = 'Nothing was heard. Check the microphone (Settings › Recording) and record it again.'; draw(); return; }
      takes[cur] = { word: STEPS[cur].word, samples: to16k(mono, dec.sampleRate), blob };
      status.textContent = pk > 0.98 ? 'That was very loud: if it sounds distorted, move back a little and record it again.' : 'Got it.';
      const next = takes.findIndex((t, i) => !t && i > cur);
      cur = next >= 0 ? next : takes.findIndex(t => !t) >= 0 ? takes.findIndex(t => !t) : cur;
    } catch (e) { status.textContent = `Couldn’t read the recording: ${e.message}`; }
    draw();
  }
  recB.onclick = () => (rec ? stop() : start());
  // 〰 FILLERS: ums marked on the timeline with the FILLER tool (a guest's, or ones you already said on camera).
  // Listen to each, say whether it's an um or an uh (or not one at all), tick the ones to use and send them.
  const fillBox = el('div', { class: 'umt-fillers' });
  const picked = new Set((app.doc?.fillers || []).filter(f => !f.taught).map(f => f.id));
  const sendB = el('button', { class: 'hw amber' });
  const drawFillers = () => {
    const fs = app.doc?.fillers || [];
    if (!fs.length) {
      fillBox.replaceChildren(el('div', { class: 'umt-fill-head' },
        el('span', { class: 'umt-fill-title', text: '〰 FROM YOUR RECORDING' }),
        el('span', { class: 'note', text: 'For a guest who can’t read lines (or ums you already said on camera): press MARK FILLERS, drag across each um on the voice track, and they show up here to send.' }),
        el('button', { class: 'hw role-filler', text: '〰 MARK FILLERS', onclick: () => { if (!dlg?.inline) dlg?.close(); if (!app.timeline.filling) app.cmd('filler'); } })));
      return;
    }
    const rows = fs.map(f => {
      const tr = app.doc.tracks.find(t => t.id === f.track);
      const word = el('select', { class: 'umt-word', title: 'What this one is' },
        ...[...soundWords(), ['new', '＋ another sound…'], ['not', 'not an um']].map(([v, l]) => el('option', { value: v, text: l, selected: (f.word || 'umm') === v })));
      word.onchange = async () => {
        let w = word.value;
        if (w === 'new') { w = await newSoundWord(); if (!w) { drawFillers(); return; } }
        setFillerWord(app, f.id, w); picked.add(f.id); drawFillers();
      };
      const tick = el('input', { type: 'checkbox', checked: picked.has(f.id) });
      tick.onchange = () => { if (tick.checked) picked.add(f.id); else picked.delete(f.id); syncSend(); };
      return el('label', { class: 'umt-fill' + (f.taught ? ' taught' : '') }, tick,
        el('button', { class: 'mini', text: '▶', title: 'Play it', onclick: e => { e.preventDefault(); playRange(app, f.t0, f.t1); } }),
        el('span', { class: 'umt-fill-t', title: `${fmt(f.t0)} · ${(f.t1 - f.t0).toFixed(2)} s on ${tr?.name || 'the track'}${f.taught ? ' · already learned' : ''}`, text: `${fmt(f.t0)} · ${(f.t1 - f.t0).toFixed(2)} s${f.taught ? ' · learned ✓' : ''}` }), word,
        el('button', { class: 'mini umt-cut', text: '✂', title: 'Cut this one out of the recording (everything after closes up; ⌘Z puts it back). What Reel learned from it stays.', onclick: e => { e.preventDefault(); picked.delete(f.id); cutFillers(app, [f.id]); drawFillers(); } }));
    });
    fillBox.replaceChildren(el('div', { class: 'umt-fill-head' },
      el('span', { class: 'umt-fill-title', text: `〰 FROM YOUR RECORDING (${fs.length})` }),
      el('button', { class: 'hw role-filler', text: '〰 MARK MORE', title: 'Close this and mark more on the timeline', onclick: () => { if (!dlg?.inline) dlg?.close(); if (!app.timeline.filling) app.cmd('filler'); } })),
      el('div', { class: 'umt-fill-list' }, ...rows), el('div', { class: 'btn-row umt-fill-actions' }, sendB, cutB));
    syncSend();
  };
  // ✂ cut the ticked ones out of the recording, right here (no need to go to the timeline)
  const cutB = el('button', { class: 'hw umt-cut-all', title: 'Cut the ticked fillers out of the recording: everything after closes up, picture and sound together. ⌘Z puts them back. What Reel learned stays.' });
  cutB.onclick = () => {
    const ids = [...picked].filter(id => (app.doc?.fillers || []).some(f => f.id === id));
    if (!ids.length) return;
    for (const id of ids) picked.delete(id);
    cutFillers(app, ids); drawFillers();
  };
  const syncSend = () => {
    const n = [...picked].filter(id => (app.doc?.fillers || []).some(f => f.id === id)).length;
    sendB.disabled = !n; sendB.textContent = n ? `SEND ${n} TO TRAINING` : 'TICK THE ONES TO SEND';
    cutB.disabled = !n; cutB.textContent = n ? `✂ CUT ${n} FROM THE RECORDING` : '✂ CUT TICKED';
  };
  sendB.onclick = async () => {
    const fs = (app.doc?.fillers || []).filter(f => picked.has(f.id));
    if (!fs.length) return;
    sendB.disabled = true;
    try {
      const n = await teachFillers(app, fs, msg => { status.textContent = msg; });
      // they stay ticked: the next step is usually to cut them out of the recording (✂ CUT, right beside)
      status.textContent = n ? `Learned ${n} from your recording. Now ✂ CUT ${n === 1 ? 'it' : 'them'} out of the recording if you like; 💬 FILLER WORDS › LISTEN AGAIN finds more.` : 'Nothing was learned.';
      onDone?.();
    } catch (e) { status.textContent = e.message; }
    drawFillers(); draw(); drawKnown();
  };
  drawFillers();
  const model = umModel();
  // what Reel knows, at the bottom: kept up to date after every send (and ↻ to read it again)
  const known = el('p', { class: 'note umt-known' });
  const SUGGEST = ['umm', 'uh', 'breath', 'lip smack', 'cough', 'sneeze'];
  // take back what was learned by mistake (a yawn sent as an um): the newest takes first, or the whole sound
  const chipMenu = (e, word, n) => {
    const label = word === 'not' ? '“not an um” sound' : `${word === 'umm' ? 'um' : word} take`;
    const drop = async (k, sure) => {
      if (sure && !(await ask(sure[0], sure[1], sure[2]))) return;
      saveModel(dropTakes(umModel(), word, k));
      toast(k >= n ? (word === 'not' ? 'Reel forgot the sounds you said aren’t ums.' : `Reel forgot ${word === 'umm' ? 'your ums' : `“${word}”`}.`) : `Took back the last ${k === 1 ? label : `${k} ${label}s`}.`, 4000);
      drawKnown(); draw(); onDone?.();
    };
    const r = e.currentTarget.getBoundingClientRect();
    popMenu(r.left, r.bottom + 4, [
      [`Take back the last ${label} (the newest)`, () => drop(1)],
      n > 3 ? [`Take back the last 3 ${label}s`, () => drop(3)] : null,
      n > 5 ? [`Take back the last 5 ${label}s`, () => drop(5)] : null,
      null,
      [`Forget all ${n} ${label}${n === 1 ? '' : 's'}…`, () => drop(n, ['Forget them?', `Reel will forget all ${n} ${label}${n === 1 ? '' : 's'} (for every project). The rest it learned stays. This can’t be undone: you’d have to teach ${n === 1 ? 'it' : 'them'} again.`, 'FORGET THEM'])],
    ].filter(Boolean));
  };
  const drawKnown = (reread = false) => {
    const m = reread ? reloadModel() : umModel(), name = w => (w === 'umm' ? 'um' : w);
    const words = m ? m.words : [];
    const few = words.filter(w => w.prints.length < ENOUGH);
    const missing = SUGGEST.filter(w => !words.some(x => x.word === w));
    // in the dialog's bottom row: ↻ at the far left, then what Reel knows (FORGET MY UMS and CLOSE on the right)
    known.replaceChildren(
      el('button', { class: 'hw umt-refresh', text: '↻', title: 'Show what Reel knows now', onclick: () => drawKnown(true) }),
      el('div', { class: 'umt-known-text' },
      el('b', { text: m ? 'REEL KNOWS' : 'Reel doesn’t know your ums yet.' }),
      words.length ? el('div', { class: 'umt-chips' }, ...words.map(w => el('button', { class: 'umt-chip' + (w.prints.length < ENOUGH ? ' few' : ''), type: 'button', title: `${w.prints.length} take${w.prints.length === 1 ? '' : 's'} learned. Click to take some back (a sound taught by mistake).`, text: `${name(w.word)} · ${w.prints.length} ▾`, onclick: e => chipMenu(e, w.word, w.prints.length) })),
        m.nots?.length ? el('button', { class: 'umt-chip not', type: 'button', title: 'Sounds you told Reel aren’t ums. Click to take some back.', text: `not an um · ${m.nots.length} ▾`, onclick: e => chipMenu(e, 'not', m.nots.length) }) : null) : null,
      few.length ? el('div', { class: 'umt-few', text: `Needs more takes (${ENOUGH} or more of each find them best): ${few.map(w => `${name(w.word)} (${ENOUGH - w.prints.length} more)`).join(', ')}.` }) : null,
      missing.length ? el('div', { text: `Not taught yet: ${missing.map(name).join(', ')}.` }) : null));
  };
  drawKnown();
  // with something learned already, recording the takes again is optional: folded away
  const takesBox = el('details', { class: 'umt-takes', open: !model },
    el('summary', { text: model ? 'Record more takes (optional: Reel already knows your voice)' : 'Record your takes' }),
    list, el('div', { class: 'row kit-rec-row' }, recB, meter));
  const body = el('div', { class: 'umt' },
    el('p', { text: model
      ? `Reel already knows how you say your ums. To teach it more (or other sounds, like breaths), mark them in your recording with 〰 FILLER and send them below, or record more takes. Give Reel at least ${ENOUGH} of each sound, new ones too: the more it hears, the better it finds them.`
      : `Say each one at least ${ENOUGH} times (slow, normal, quick, the way you really say it), in a quiet room with the microphone you record with. A new sound you add later needs ${ENOUGH} too. Reel learns how your ums and uhs sound, then finds them in your videos for 💬 FILLER WORDS and AUTO EDIT, even the ones speech recognition leaves out. Nothing leaves this Mac.` }),
    takesBox, status, fillBox,
    el('p', { class: 'note umt-tip', text: 'Particular words (curse words, “basically”, “actually”…) are found by their spelling, not by ear: type them in Find a word in 💬 FILLER WORDS. Everything you add is added to what Reel knows; FORGET MY UMS starts over.' }));
  draw();
  let dlg = null;
  saveB.onclick = () => {
    try {
      const ums = takes.filter(t => t && t.word !== 'speech'), speech = takes[STEPS.length - 1]?.samples;
      // with something learned already, these are added to it (more voices, more ways of saying it); else start fresh
      let m = umModel();
      if (!m && speech && ums.filter(t => t.word === ums[0].word).length >= 2) m = train({ takes: ums, speech });
      else for (const t of ums) m = addTake(m, t.word, t.samples, speech);
      saveModel(m);
      toast(`Learned your ${m.words.map(w => w.word).join(' and ')}. 💬 FILLER WORDS › LISTEN AGAIN finds them; AUTO EDIT cuts them too.`, 6000);
      dlg?.close();
      onDone?.();
    } catch (e) { status.textContent = e.message; }
  };
  body.append(el('div', { class: 'btn-row umt-save' }, saveB));
  // under the TEACH MY UMS key when it's showing in the tool panel; else a window
  const key = document.getElementById('btn-teachums'), keyBody = key?.closest('#keypanel .kmod-body');
  const under = key && keyBody && key.offsetParent ? keyBody : null; // (folded or hidden group: a window)
  const make = (title, b, btns, opts) => (under ? drawer(under, title, b, btns, { ...opts, cls: 'umt-drawer' }) : modal(title, b, btns, opts));
  dlg = make('🎙 Teach Reel your ums', body, [
    model ? { label: 'FORGET MY UMS', cls: 'hw danger', onClick: async close => {
      const m = umModel(), n = m ? m.words.reduce((k, w) => k + w.prints.length, 0) : 0;
      const sure = await ask('Forget everything Reel learned?',
        `Reel will erase all ${n} takes it learned (${m.words.map(w => (w.word === 'umm' ? 'um' : w.word)).join(', ')}) and the sounds you said aren’t ums, for every project. This can’t be undone: you’d have to teach it again.`, 'YES, FORGET THEM');
      if (!sure) return;
      saveModel(null); toast('Reel forgot your ums.'); close(); onDone?.();
    } } : null,
    { label: 'CLOSE', onClick: close => close() },
  ].filter(Boolean), { onClose: () => { stop(); release(); key?.classList.remove('lit'); if (open === dlg) open = null; } });
  dlg.foot.prepend(known);
  if (dlg.inline) {
    key.classList.add('lit');
    // open while you mark fillers on the timeline: new ones appear (ticked) as you go
    let sig = (app.doc?.fillers || []).map(f => f.id + (f.taught ? '*' : '')).join();
    dlg.root._redraw = () => {
      const fs = app.doc?.fillers || [], now = fs.map(f => f.id + (f.taught ? '*' : '')).join();
      if (now === sig) return;
      const had = new Set(sig.split(',').map(x => x.replace('*', '')));
      for (const f of fs) if (!had.has(f.id) && !f.taught) picked.add(f.id);
      sig = now; drawFillers();
    };
  }
  open = dlg;
  return dlg;
}

/** A clip's sound as 16 kHz mono (the part the clip uses), or null. */
export async function clipSound(app, c) {
  const m = soundOf(app.doc, c);
  if (!m?.file) return null;
  const a = await openAudio(`app://reel/m/${app.token}/${encodeURIComponent(m.file)}`, m.file);
  if (!a) return null;
  const speed = c.speed || 1, from = Math.max(0, Math.floor((c.in || 0) * a.rate)), count = Math.floor(c.duration * speed * a.rate);
  const chs = await a.read(from, count);
  a.close?.();
  const mono = new Float32Array(count);
  for (const ch of chs) for (let i = 0; i < count; i++) mono[i] += ch[i] / chs.length;
  return to16k(mono, a.rate);
}

/**
 * The sound on the timeline from t0 to t1 (16 kHz mono), from the clip with speech there (on `track` if given):
 * { samples, clip } or null.
 */
export async function soundAt(app, t0, t1, track = '') {
  const c = speechClips(app.doc, track).find(x => t0 >= x.start - 0.01 && t0 < x.start + x.duration);
  if (!c) return null;
  const m = soundOf(app.doc, c);
  const a = await openAudio(`app://reel/m/${app.token}/${encodeURIComponent(m.file)}`, m.file);
  if (!a) return null;
  const speed = c.speed || 1;
  const s0 = Math.max(0, (c.in || 0) + (Math.max(t0, c.start) - c.start) * speed), s1 = (c.in || 0) + (Math.min(t1, c.start + c.duration) - c.start) * speed;
  const from = Math.floor(s0 * a.rate), count = Math.max(1, Math.floor((s1 - s0) * a.rate));
  const chs = await a.read(from, count);
  a.close?.();
  const mono = new Float32Array(count);
  for (const ch of chs) for (let i = 0; i < count; i++) mono[i] += ch[i] / chs.length;
  return { samples: to16k(mono, a.rate), clip: c };
}

// the name a sound is learned under: um / uh / er spelled any way, otherwise exactly the name you gave it (yawning, breath…)
const wordOf = text => {
  const t = String(text || '').toLowerCase().trim(), letters = t.replace(/[^a-z]/g, '');
  if (!letters || /^u+m+$/.test(letters)) return 'umm';
  if (/^u+h+$/.test(letters)) return 'uh';
  if (/^e+r+$/.test(letters)) return 'er';
  return t.replace(/[^a-z0-9 '-]/g, '').slice(0, 20) || 'umm';
};
export const _wordOf = wordOf; // for tests

/**
 * Teach Reel that t0–t1 on the timeline is an um (yours or a guest's): it learns from that sound, with the
 * speech a few seconds either side to tell it apart from ordinary words.
 */
export async function teachFromTimeline(app, t0, t1, text = 'umm', track = '') {
  // just what you marked (its quiet ends trimmed): an um said into the next word has no pause to find it by
  const piece = await soundAt(app, Math.max(0, t0), t1, track);
  if (!piece) throw new Error('No sound there to learn from.');
  const around = await soundAt(app, Math.max(0, t0 - 4), t0 - 0.2, track).catch(() => null);
  const m = addTake(umModel(), wordOf(text), piece.samples, around?.samples, { exact: true });
  saveModel(m);
  return m;
}
/** Teach Reel that t0–t1 isn't an um: it won't match it (or anything closer to it than to an um) again. */
export async function notAnUm(app, t0, t1, track = '') {
  const m = umModel();
  if (!m) return null;
  const piece = await soundAt(app, Math.max(0, t0 - 0.12), t1 + 0.12, track);
  if (!piece) throw new Error('No sound there.');
  saveModel(addNot(m, piece.samples));
  return m;
}

/** Your ums on the timeline, from the given clips: [{ t, end, word, sure }] in timeline seconds. */
/**
 * Sounds (um, uh, breath, cough…), found by ear; words and phrases you taught ("you know", "but yeah") are found by
 * what the speech recogniser wrote instead (umspanel.js), as by ear they look like any other speech.
 */
const SOUND_WORDS = /^(u+m+|u+h+m*|e+r+m*|a+h+|h+m+|m+h*m+|mhm|breath\w*|sigh\w*|lip ?smack|smack|click\w*|cough\w*|sneeze\w*|sniff\w*|laugh\w*|throat|swallow\w*|tsk|tut)$/i;
export const isSoundWord = w => SOUND_WORDS.test(String(w).trim());
/** How much a fingerprint changes from one frame to the next, on average: an um is steady, speech isn't. */
function flux(print) {
  if (!print || print.length < 2) return 0;
  let s = 0;
  for (let i = 1; i < print.length; i++) { let d = 0; for (let k = 0; k < print[i].length; k++) { const v = print[i][k] - print[i - 1][k]; d += v * v; } s += Math.sqrt(d); }
  return s / (print.length - 1);
}
export async function findYourUms(app, clips, onStatus) {
  const full = umModel();
  if (!full) return [];
  // by ear: only the sounds (words and phrases go by the transcript)
  const model = { ...full, words: full.words.filter(w => isSoundWord(w.word)) };
  if (!model.words.length) return [];
  // how steady each taught sound is (the most changeable of its takes, with room): a match that changes more is speech
  const steady = new Map(model.words.map(w => [w.word, Math.max(...w.prints.map(flux)) * 1.35 + 0.05]));
  const out = [];
  for (const [i, c] of clips.entries()) {
    onStatus?.(`Listening for your ums in “${c.name || 'clip'}” (${i + 1} of ${clips.length})…`, i / clips.length);
    let x = null;
    try { x = await clipSound(app, c); } catch { x = null; }
    if (!x) continue;
    const speed = c.speed || 1;
    // the Rust helper when this build has it (faster, and the editor doesn't stall); the same answers either way
    let hits = null;
    try { hits = await app.api.coreUmFind?.(JSON.parse(packModel(model)), x); } catch { hits = null; }
    const found = [...(hits || findInSamples(model, x))];
    // and the ones said straight into the next word (no pause around them, so never a "burst")
    onStatus?.(`Matching what you taught in “${c.name || 'clip'}” (${i + 1} of ${clips.length})…`, (i + 0.5) / clips.length);
    await new Promise(r => setTimeout(r, 0));
    for (const h of findInSequence(model, x)) if (!found.some(f => f.t < h.end && f.end > h.t)) found.push(h);
    for (const h of found) {
      // its shape: as steady as the takes you taught (a word said in passing changes much more than an "ummm")
      const a0 = Math.max(0, Math.floor(h.t * RATE)), a1 = Math.min(x.length, Math.ceil(h.end * RATE)), seg = x.subarray ? x.subarray(a0, a1) : x.slice(a0, a1);
      if (seg.length > 400 && flux(fingerprint(seg)) > (steady.get(h.word) ?? Infinity)) continue;
      out.push({ t: c.start + h.t / speed, end: c.start + h.end / speed, word: h.word, sure: h.sure, joined: !!h.joined, track: c.track });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
export { RATE };
