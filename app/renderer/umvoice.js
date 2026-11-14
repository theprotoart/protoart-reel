// 🎙 Teach Reel your ums: record "umm" and "uh" a few times (slow, normal, quick) and read one sentence; Reel learns
// what your fillers sound like (lib/umvoice.js) and then finds them in your recordings for 💬 UMS and AUTO EDIT,
// including the ones speech recognition doesn't write down. Everything stays on this Mac (the model is kept in
// Reel's own storage here, never uploaded).
import { el, modal, toast } from './ui.js';
import { train, findInSamples, packModel, unpackModel, to16k, RATE, addTake, addNot } from './lib/umvoice.js';
import { openAudio } from './lib/sources.js';
import { soundOf, speechClips } from './transcript.js';

const KEY = 'reel.umvoice';
let cached;
/** Your trained model, or null. */
export function umModel() {
  if (cached !== undefined) return cached;
  try { cached = unpackModel(localStorage.getItem(KEY)); } catch { cached = null; }
  return cached;
}
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
  // ＋ FROM TIMELINE: the In–Out range (or the selected clip's sound under the playhead, a second either side):
  // for a guest who can't read the lines, or an um you already said on camera
  const fromB = el('button', { class: 'hw', text: '＋ FROM TIMELINE', title: 'Use the sound between In and Out on the timeline for this step (set In and Out around one um with I and O): for a guest, or an um already in your recording' });
  fromB.onclick = async () => {
    if (rec) return;
    const r = app.doc?.range;
    const t0 = r?.in != null && r?.out != null ? r.in : Math.max(0, app.player.time - 0.6), t1 = r?.in != null && r?.out != null ? r.out : app.player.time + 0.6;
    if (STEPS[cur].word !== 'speech' && t1 - t0 > 3) { status.textContent = 'That’s more than 3 seconds: set In and Out (I, O) tightly around one um.'; return; }
    try {
      const piece = await soundAt(app, t0, t1);
      if (!piece) { status.textContent = 'There’s no sound there on the timeline.'; return; }
      takes[cur] = { word: STEPS[cur].word, samples: piece.samples, from: true };
      status.textContent = `Got it from the timeline (${(t1 - t0).toFixed(1)} s).`;
      const next = takes.findIndex(t => !t); if (next >= 0) cur = next;
    } catch (e) { status.textContent = e.message; }
    draw();
  };
  const model = umModel();
  const body = el('div', { class: 'umt' },
    el('p', { text: 'Record each one in a quiet room with the microphone you record with. Reel learns how your ums and uhs sound, then finds them in your videos for 💬 UMS and AUTO EDIT, even the ones speech recognition leaves out. Nothing leaves this Mac.' }),
    model ? el('p', { class: 'note', text: `Already learned: ${model.words.map(w => `${w.word} (${w.prints.length})`).join(', ')}${model.nots?.length ? `, and ${model.nots.length} that aren’t` : ''}. New takes are added to it (another voice, another way of saying it); FORGET MY UMS starts over.` }) : null,
    list, el('div', { class: 'row kit-rec-row' }, recB, fromB, meter), status);
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
      toast(`Learned your ${m.words.map(w => w.word).join(' and ')}. 💬 UMS › LISTEN AGAIN finds them; AUTO EDIT cuts them too.`, 6000);
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
    for (const h of findInSamples(model, x)) out.push({ t: c.start + h.t / speed, end: c.start + h.end / speed, word: h.word, sure: h.sure, track: c.track });
  }
  return out.sort((a, b) => a.t - b.t);
}
export { RATE };
