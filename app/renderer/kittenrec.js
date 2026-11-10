// Speech from text › Kitten voices › ● Record my voice: clone your own voice without a clip on the timeline. You
// read a short passage aloud into the microphone (the one chosen for recording), listen back, and save it. The
// passage is what's said, so the voice is matched to the words exactly; nothing leaves this Mac.
import { el, promptText } from './ui.js';

const MIN = 6, MAX = 25; // seconds kept (the voice store takes 5 to 30)

/** What to read: about 15 seconds at an easy pace, with a mix of sounds. */
export const PASSAGES = [
  'The morning was bright and cold, so I made a pot of coffee and sat by the window. A small bird landed on the fence, looked around for a moment, then flew off toward the old oak tree across the road. It was the quietest start to a day I could remember.',
  'Thanks for watching today. In this video I will show you how I set everything up, what worked, what did not, and the one thing I would change if I started again. Grab a drink, get comfortable, and let us jump right in.',
  'Every recipe begins with a little patience. Measure the flour, warm the butter, and whisk the eggs until they turn pale and light. Then fold it all together slowly, pour it into the tin, and let the oven do the rest of the work.',
];

const recMic = () => { try { return (JSON.parse(localStorage.getItem('rec-settings') || '{}') || {}).micId || ''; } catch { return ''; } };

/** Trims silence at both ends (keeping a little air) and caps the length; peak-normalises to about −3 dB. */
export function tidy(samples, rate) {
  const win = Math.round(rate * 0.02), th = 0.02;
  let peak = 0; for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const gate = Math.max(0.004, peak * th);
  const loud = i => { let p = 0; for (let k = i; k < Math.min(samples.length, i + win); k++) p = Math.max(p, Math.abs(samples[k])); return p >= gate; };
  let a = 0; while (a < samples.length && !loud(a)) a += win;
  let b = samples.length; while (b > a && !loud(Math.max(a, b - win))) b -= win;
  a = Math.max(0, a - Math.round(rate * 0.25)); b = Math.min(samples.length, b + Math.round(rate * 0.35));
  b = Math.min(b, a + Math.round(MAX * rate));
  const out = samples.slice(a, b);
  const g = peak > 0 ? Math.min(8, 0.7 / peak) : 1;
  for (let i = 0; i < out.length; i++) out[i] *= g;
  return { samples: out, peak, seconds: out.length / rate };
}

/**
 * The recorder, shown inside the Kitten panel. onSaved(voice) after a voice is saved; onStatus(text) for messages.
 * Returns { root, stop() } (stop releases the microphone, e.g. when the dialog closes).
 */
export function voiceRecorder(app, { onSaved, onStatus = () => {} } = {}) {
  let idx = 0;
  const passage = el('textarea', { class: 'kit-read', rows: 3, spellcheck: false, title: 'Read this aloud. You can change the words first: what’s here must be what you say.' });
  passage.value = PASSAGES[idx];
  const other = el('button', { class: 'mini', text: 'Another passage', onclick: () => { idx = (idx + 1) % PASSAGES.length; passage.value = PASSAGES[idx]; } });
  const meter = el('div', { class: 'vo-meter' }, el('i'));
  const clock = el('span', { class: 'kit-rec-clock', text: '0:00' });
  const recB = el('button', { class: 'hw kit-rec-btn', text: '● RECORD' });
  const listenB = el('button', { class: 'tool hidden', text: '▶ Listen' });
  const saveB = el('button', { class: 'hw amber hidden', text: 'SAVE MY VOICE' });
  const root = el('div', { class: 'kit-rec' },
    el('p', { class: 'note', text: 'Read this aloud in your normal voice, in a quiet room (about 15 seconds). Reel uses the microphone chosen for recording.' }),
    passage, el('div', { class: 'btn-row' }, other),
    el('div', { class: 'row kit-rec-row' }, recB, meter, clock),
    el('div', { class: 'btn-row' }, listenB, saveB));

  let stream = null, ctx = null, rec = null, chunks = [], raf = 0, t0 = 0, took = null, player = null, timer = 0;
  const showLevel = p => { meter.firstChild.style.width = Math.min(100, Math.sqrt(p) * 100) + '%'; meter.classList.toggle('hot', p > 0.89); };
  const release = () => {
    cancelAnimationFrame(raf); clearTimeout(timer);
    stream?.getTracks().forEach(t => t.stop()); stream = null;
    ctx?.close().catch(() => {}); ctx = null; showLevel(0);
  };
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  async function start() {
    took = null; listenB.classList.add('hidden'); saveB.classList.add('hidden'); player?.pause();
    try {
      const mic = recMic();
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(mic ? { deviceId: { exact: mic } } : {}), channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch { onStatus('The microphone isn’t available. Allow Reel in System Settings › Privacy & Security › Microphone.'); return; }
    ctx = new AudioContext();
    const an = ctx.createAnalyser(); an.fftSize = 1024; ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(1024);
    rec = new MediaRecorder(stream); chunks = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = finish;
    rec.start(250); t0 = performance.now();
    recB.textContent = '■ STOP'; recB.classList.add('lit'); passage.readOnly = true; other.disabled = true;
    onStatus('Recording… read the passage, then press STOP.');
    const tick = () => {
      if (!root.isConnected) { stop(); release(); return; } // the dialog closed: let go of the microphone
      an.getFloatTimeDomainData(buf); let p = 0; for (const v of buf) p = Math.max(p, Math.abs(v)); showLevel(p);
      clock.textContent = fmt((performance.now() - t0) / 1000);
      raf = requestAnimationFrame(tick);
    };
    tick();
    timer = setTimeout(() => stop(), (MAX + 5) * 1000); // a forgotten STOP doesn't run on
  }
  function stop() { if (rec && rec.state !== 'inactive') rec.stop(); }

  async function finish() {
    const secs = (performance.now() - t0) / 1000;
    release(); rec = null;
    recB.textContent = '● RECORD AGAIN'; recB.classList.remove('lit'); passage.readOnly = false; other.disabled = false;
    if (secs < MIN) { onStatus(`That was ${secs.toFixed(0)} seconds. Read the whole passage (at least ${MIN} seconds).`); return; }
    try {
      const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
      const dec = await new AudioContext().decodeAudioData(await blob.arrayBuffer());
      const mono = new Float32Array(dec.length);
      for (let c = 0; c < dec.numberOfChannels; c++) { const d = dec.getChannelData(c); for (let i = 0; i < d.length; i++) mono[i] += d[i] / dec.numberOfChannels; }
      const t = tidy(mono, dec.sampleRate);
      if (t.peak < 0.01) { onStatus('Nothing was heard. Check the microphone (Settings › Recording) and try again.'); return; }
      if (t.seconds < MIN - 1) { onStatus('Only a few seconds of speech were heard. Read the whole passage and try again.'); return; }
      took = { samples: t.samples, rate: dec.sampleRate, blob };
      listenB.classList.remove('hidden'); saveB.classList.remove('hidden');
      onStatus(`${t.seconds.toFixed(0)} seconds recorded${t.peak > 0.98 ? ' (it was very loud: if it sounds distorted, move back a little and record again)' : ''}. Listen back, then save it.`);
    } catch (e) { onStatus(`Couldn’t read the recording: ${e.message}`); }
  }

  recB.onclick = () => (rec ? stop() : start());
  listenB.onclick = () => {
    if (!took) return;
    if (player && !player.paused) { player.pause(); listenB.textContent = '▶ Listen'; return; }
    player?.pause(); player = new Audio(URL.createObjectURL(took.blob));
    player.onended = () => { listenB.textContent = '▶ Listen'; };
    player.play(); listenB.textContent = '■ Stop';
  };
  saveB.onclick = async () => {
    if (!took) return;
    const words = passage.value.replace(/\s+/g, ' ').trim();
    if (words.split(' ').length < 4) { onStatus('The passage box is empty: put back the words you read.'); return; }
    const name = await promptText('Save your voice', 'Name the voice (for example, your own name):', 'My voice', 'Save voice');
    if (!name) return;
    saveB.disabled = true;
    try { const v = await app.api.kittenSaveVoice(name, took.samples, took.rate, words); player?.pause(); onSaved?.(v); }
    catch (e) { onStatus(String(e?.message || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')); }
    saveB.disabled = false;
  };

  return { root, stop: () => { stop(); release(); player?.pause(); } };
}
