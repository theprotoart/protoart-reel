// 🎙 Teach Reel your ums: record "umm" and "uh" a few times (slow, normal, quick) and read one sentence; Reel learns
// what your fillers sound like (lib/umvoice.js) and then finds them in your recordings for 💬 UMS and AUTO EDIT,
// including the ones speech recognition doesn't write down. Everything stays on this Mac (the model is kept in
// Reel's own storage here, never uploaded).
import { el, modal, toast } from './ui.js';
import { train, findInSamples, packModel, unpackModel, to16k, RATE, addTake, addNot } from './lib/umvoice.js';
import { openAudio } from './lib/sources.js';
import { soundOf, speechClips } from './transcript.js';
import { fmtTime as fmt } from './model.js';
import { playRange, setFillerWord, teachFillers, soundWords, newSoundWord } from './fillers.js';

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

/** The trainer window. */
export function teachUms(app, { onDone } = {}) {
  const takes = STEPS.map(() => null);
  let cur = 0, stream = null, ctx = null, rec = null, chunks = [], timer = 0, raf = 0, t0 = 0;
  const list = el('div', { class: 'umt-list' });
  const meter = el('div', { class: 'vo-meter' }, el('i'));
  const status = el('p', { class: 'note umt-status' });
  const recB = el('button', { class: 'hw kit-rec-btn', text: '● RECORD' });
  const saveB = el('button', { class: 'hw amber', text: 'LEARN MY UMS', disabled: true });
  const draw = () => {
    list.replaceChildren(...STEPS.map((s, i) => el('div', { class: 'umt-step' + (i === cur ? ' on' : '') + (takes[i] ? ' done' : ''), onclick: () => { if (!rec) { cur = i; draw(); } } },
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
        el('span', { class: 'note', text: 'For a guest who can’t read lines (or ums you already said on camera): close this, press 〰 FILLER on the timeline tool bar, drag across each um on the voice track, then come back.' }),
        el('button', { class: 'hw role-filler', text: '〰 MARK FILLERS', onclick: () => { dlg?.close(); app.cmd('filler'); } })));
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
        el('span', { class: 'umt-fill-t', text: `${fmt(f.t0)} · ${(f.t1 - f.t0).toFixed(2)} s · ${tr?.name || 'track'}${f.taught ? ' · learned' : ''}` }), word);
    });
    fillBox.replaceChildren(el('div', { class: 'umt-fill-head' },
      el('span', { class: 'umt-fill-title', text: `〰 FROM YOUR RECORDING (${fs.length})` }),
      el('button', { class: 'hw role-filler', text: '〰 MARK MORE', title: 'Close this and mark more on the timeline', onclick: () => { dlg?.close(); if (!app.timeline.filling) app.cmd('filler'); } })),
      el('div', { class: 'umt-fill-list' }, ...rows), el('div', { class: 'btn-row' }, sendB));
    syncSend();
  };
  const syncSend = () => { const n = [...picked].filter(id => (app.doc?.fillers || []).some(f => f.id === id)).length; sendB.disabled = !n; sendB.textContent = n ? `SEND ${n} TO TRAINING` : 'TICK THE ONES TO SEND'; };
  sendB.onclick = async () => {
    const fs = (app.doc?.fillers || []).filter(f => picked.has(f.id));
    if (!fs.length) return;
    sendB.disabled = true;
    try {
      const n = await teachFillers(app, fs, msg => { status.textContent = msg; });
      for (const f of fs) picked.delete(f.id);
      status.textContent = n ? `Learned ${n} from your recording. 💬 FILLER WORDS › LISTEN AGAIN uses them.` : 'Nothing was learned.';
      onDone?.();
    } catch (e) { status.textContent = e.message; }
    drawFillers(); draw(); drawKnown();
  };
  drawFillers();
  const model = umModel();
  // what Reel knows, at the bottom: kept up to date after every send (and ↻ to read it again)
  const known = el('p', { class: 'note umt-known' });
  const SUGGEST = ['umm', 'uh', 'breath', 'lip smack', 'cough', 'sneeze'];
  const drawKnown = (reread = false) => {
    const m = reread ? reloadModel() : umModel(), name = w => (w === 'umm' ? 'um' : w);
    const words = m ? m.words : [];
    const few = words.filter(w => w.prints.length < 3);
    const missing = SUGGEST.filter(w => !words.some(x => x.word === w));
    known.replaceChildren(
      el('div', { class: 'umt-known-head' },
        el('b', { text: m ? 'WHAT REEL KNOWS' : 'Reel doesn’t know your ums yet.' }),
        el('button', { class: 'mini', text: '↻', title: 'Read what Reel knows again', onclick: () => drawKnown(true) })),
      words.length ? el('div', { class: 'umt-chips' }, ...words.map(w => el('span', { class: 'umt-chip' + (w.prints.length < 3 ? ' few' : ''), title: `${w.prints.length} take${w.prints.length === 1 ? '' : 's'} learned`, text: `${name(w.word)} · ${w.prints.length}` })),
        m.nots?.length ? el('span', { class: 'umt-chip not', title: 'Sounds you told Reel aren’t ums', text: `not an um · ${m.nots.length}` }) : null) : null,
      few.length ? el('div', { text: `Needs more takes (3 or more find them best): ${few.map(w => `${name(w.word)} (${3 - w.prints.length} more)`).join(', ')}.` }) : null,
      missing.length ? el('div', { text: `Not taught yet: ${missing.map(name).join(', ')}. Mark one with 〰 FILLER and send it, or record takes.` }) : null,
      el('div', { class: 'umt-tip', text: 'Particular words (curse words, “basically”, “actually”…) are found by their spelling, not by ear: type them in Find a word in 💬 FILLER WORDS. Everything you add here is added to what Reel knows; FORGET MY UMS starts over.' }));
  };
  drawKnown();
  // with something learned already, recording the takes again is optional: folded away
  const takesBox = el('details', { class: 'umt-takes', open: !model },
    el('summary', { text: model ? 'Record more takes (optional: Reel already knows your voice)' : 'Record your takes' }),
    list, el('div', { class: 'row kit-rec-row' }, recB, meter));
  const body = el('div', { class: 'umt' },
    el('p', { text: model
      ? 'Reel already knows how you say your ums. To teach it more (or other sounds, like breaths), mark them in your recording with 〰 FILLER and send them below, or record more takes.'
      : 'Record each one in a quiet room with the microphone you record with. Reel learns how your ums and uhs sound, then finds them in your videos for 💬 FILLER WORDS and AUTO EDIT, even the ones speech recognition leaves out. Nothing leaves this Mac.' }),
    takesBox, status, fillBox, known);
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
  dlg = modal('🎙 Teach Reel your ums', body, [
    model ? { label: 'FORGET MY UMS', onClick: close => { saveModel(null); toast('Reel forgot your ums.'); close(); onDone?.(); } } : null,
    { label: 'CLOSE', onClick: close => close() },
  ].filter(Boolean), { onClose: () => { stop(); release(); } });
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

const wordOf = text => (/^u+h+$|^uh/i.test(String(text).replace(/[^a-z]/gi, '')) ? 'uh' : /^e+r/i.test(String(text)) ? 'er' : 'umm');

/**
 * Teach Reel that t0–t1 on the timeline is an um (yours or a guest's): it learns from that sound, with the
 * speech a few seconds either side to tell it apart from ordinary words.
 */
export async function teachFromTimeline(app, t0, t1, text = 'umm', track = '') {
  const piece = await soundAt(app, Math.max(0, t0 - 0.12), t1 + 0.12, track);
  if (!piece) throw new Error('No sound there to learn from.');
  const around = await soundAt(app, Math.max(0, t0 - 4), t0 - 0.2, track).catch(() => null);
  const m = addTake(umModel(), wordOf(text), piece.samples, around?.samples);
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
export async function findYourUms(app, clips, onStatus) {
  const model = umModel();
  if (!model) return [];
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
    for (const h of hits || findInSamples(model, x)) out.push({ t: c.start + h.t / speed, end: c.start + h.end / speed, word: h.word, sure: h.sure, track: c.track });
  }
  return out.sort((a, b) => a.t - b.t);
}
export { RATE };
