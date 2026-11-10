// 🎵 Music length: extend or shorten a music clip to a length (or to the end of the video) without an audible seam.
// The clip gets a new rendered copy of the song (the original stays in the media list); Undo puts it back.
// The maths is in lib/musicfit.js.
import { el, modal, toast } from './ui.js';
import { uid, mediaById, isFree, addTrack } from './model.js';
import { analyse, planFit, render, mmss } from './lib/musicfit.js';

const clean = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
const urlOf = (app, m) => `app://reel/m/${app.token}/${encodeURIComponent(m.file)}`;
const parseLen = s => { const m = /^\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(String(s)); return m ? (Number(m[1] || 0) * 60 + Number(m[2])) : NaN; };

/** Is this clip something to extend? A sound-only clip (music, usually) at normal speed. */
export function canFit(doc, c) {
  const m = c && c.type === 'media' && mediaById(doc, c.media);
  return !!(m && (m.kind === 'audio' || c.audioOnly) && m.hasAudio !== false);
}
/** Where the rest of the edit ends (the video's length), measured from this clip's start. */
export function toEndOfVideo(doc, c) {
  const end = Math.max(0, ...doc.clips.filter(x => x.id !== c.id && !x.disabled).map(x => x.start + x.duration));
  return end - c.start;
}

/** Makes the clip last `target` seconds (about). onStatus(text, fraction). Returns { seconds, jumps } or null. */
export async function fitMusic(app, clipId, target, onStatus = () => {}) {
  const doc = app.doc, c = doc.clips.find(x => x.id === clipId), m = c && mediaById(doc, c.media);
  if (!c || !m) throw new Error('Pick a music clip first.');
  if ((c.speed || 1) !== 1 || c.reversed) throw new Error('Set the clip back to normal speed (and forwards) first.');
  if (!(target >= 3 && target <= 3 * 3600)) throw new Error('Pick a length between 3 seconds and 3 hours.');
  onStatus('Reading the music…', 0.02);
  const buf = await (await fetch(urlOf(app, m))).arrayBuffer();
  const ctx = new OfflineAudioContext(2, 1, 48000);
  let ab; try { ab = await ctx.decodeAudioData(buf); } catch { throw new Error('This sound file can’t be read.'); }
  const rate = ab.sampleRate; // 48 kHz: decodeAudioData resamples to the context's rate
  // the part of the song the clip plays (a trimmed intro stays trimmed)
  const a0 = Math.max(0, Math.round((c.in || 0) * rate)), a1 = Math.min(ab.length, a0 + Math.round(c.duration * rate));
  const chans = [0, Math.min(1, ab.numberOfChannels - 1)].map(k => ab.getChannelData(k).slice(a0, a1));
  const D = (a1 - a0) / rate;
  if (Math.abs(target - D) < 0.5) { toast('It’s already that long.'); return null; }
  const mono = new Float32Array(chans[0].length);
  for (let i = 0; i < mono.length; i++) mono[i] = (chans[0][i] + chans[1][i]) / 2;
  onStatus('Listening for the parts that repeat…', 0.08);
  const tick = f => new Promise(r => { onStatus('Listening for the parts that repeat…', 0.08 + f * 0.6); setTimeout(r, 0); });
  const { cands } = await analyse(mono, rate, { tick });
  if (!cands.length) throw new Error('No part of this music repeats closely enough to join without a seam (it may be very short, or always changing). Try a longer piece, or loop it by hand with a crossfade.');
  const plan = planFit(cands, D, target);
  if (!plan.jumps) throw new Error('Couldn’t find a seamless way to reach that length with this music. Try a length a little different.');
  onStatus('Joining it together…', 0.72);
  await new Promise(r => setTimeout(r, 0));
  const r = render(chans, rate, plan);
  // into the project as a new sound file (48 kHz float, stereo, interleaved), sent in pieces
  onStatus('Saving…', 0.8);
  const name = `${(m.name || 'Music').replace(/\.[^.]+$/, '').slice(0, 50)} (${mmss(r.seconds)})`;
  const up = await app.api.fxUpBegin(app.token, 'bounce', name, 2);
  const L = r.channels[0], R = r.channels[1], n = L.length, step = 1 << 18;
  for (let i = 0; i < n; i += step) {
    const k = Math.min(step, n - i), il = new Float32Array(k * 2);
    for (let j = 0; j < k; j++) { il[2 * j] = L[i + j]; il[2 * j + 1] = R[i + j]; }
    await app.api.fxChunk(up, new Uint8Array(il.buffer));
    onStatus('Saving…', 0.8 + 0.18 * (i + k) / n);
  }
  const file = await app.api.fxUpEnd(up);
  let moved = false;
  app.commit(d => {
    const cl = d.clips.find(x => x.id === clipId); if (!cl) return;
    const id = uid('m');
    d.media.push({ id, file, name, kind: 'audio', duration: r.seconds, hasAudio: true, musicOf: m.id });
    cl.media = id; cl.in = 0; cl.duration = r.seconds; cl.speed = 1;
    cl.musicFit = { from: m.id, target: Math.round(target * 10) / 10 };
    // longer now: if it runs into the next clip on its track, move it to a free track
    if (!isFree(d, cl.track, cl.start, cl.duration, [cl.id])) {
      cl.track = [...d.tracks].reverse().find(t => isFree(d, t.id, cl.start, cl.duration, [cl.id]))?.id || addTrack(d).id;
      moved = true;
    }
  });
  app.select([clipId], null);
  app.timeline?.reveal?.([clipId]);
  onStatus('Done', 1);
  return { seconds: r.seconds, jumps: plan.jumps, moved, longer: r.seconds > D };
}

/** The window: how long the music is, how long it should be, and MAKE IT. */
export function openMusicFit(app, clipId = app.selection.clips[0]) {
  const doc = app.doc, c = doc?.clips.find(x => x.id === clipId);
  if (!c || !canFit(doc, c)) { toast('Select a music clip first (a sound clip on the timeline), then choose Extend or shorten music.', 6000); return; }
  const now = c.duration, video = toEndOfVideo(doc, c);
  const len = el('input', { type: 'text', value: mmss(video > 5 ? video : now + 60), class: 'mf-len', title: 'minutes:seconds' });
  const note = el('p', { class: 'note' });
  const bar = el('div', { class: 'progress hidden' }, el('i'));
  const set = v => { len.value = mmss(Math.max(3, v)); };
  const quick = (t, v) => el('button', { class: 'mini', text: t, onclick: () => set((parseLen(len.value) || now) + v) });
  let busy = false;
  modal('Music length', el('div', { class: 'mf' },
    el('p', { text: `“${c.name || mediaById(doc, c.media)?.name || 'Music'}” is ${mmss(now)} long. Reel finds the parts of the music that repeat and joins them seamlessly, repeating a part to make it longer or skipping one to make it shorter. It keeps the song’s own start and ending.` }),
    el('div', { class: 'row' }, el('label', { text: 'Make it' }), len,
      video > 5 ? el('button', { class: 'tool', text: `To the end of the video (${mmss(video)})`, onclick: () => set(video) }) : null),
    el('div', { class: 'btn-row' }, quick('−30 s', -30), quick('+30 s', 30), quick('+1 min', 60), quick('+2 min', 120), quick('Double', now)),
    bar, note,
    el('p', { class: 'note', text: 'It lands within a second or two of the length (on a beat, not mid-note), so the ending stays the song’s real ending. The original stays in your media list, and ⌘Z undoes it.' })), [
    { label: 'Cancel', onClick: x => x() },
    { label: 'Make it', cls: 'hw amber', onClick: async (close, btn) => {
      if (busy) return;
      const T = parseLen(len.value);
      if (!(T > 0)) { note.textContent = 'Type a length as minutes:seconds, like 3:20.'; return; }
      busy = true; btn.disabled = true; bar.classList.remove('hidden');
      try {
        const r = await fitMusic(app, clipId, T, (t, f) => { note.textContent = t; bar.firstChild.style.width = Math.round(f * 100) + '%'; });
        if (r) {
          close();
          toast(`Music ${r.longer ? 'extended' : 'shortened'} to ${mmss(r.seconds)} (${r.jumps} seamless join${r.jumps === 1 ? '' : 's'}).${r.moved ? ' It ran into the next clip, so it moved to a free track.' : ''} Press PLAY to hear it; ⌘Z undoes it.`, 7000);
        } else close();
      } catch (e) { note.textContent = clean(e); bar.classList.add('hidden'); }
      busy = false; btn.disabled = false;
    } },
  ]);
  setTimeout(() => len.select(), 50);
}

/** The MUSIC tab's section in the inspector. */
export function musicSection(app, c, section) {
  const doc = app.doc, video = toEndOfVideo(doc, c);
  const note = el('p', { class: 'note', text: c.musicFit ? `Fitted with seamless joins (the original is ${mmss(mediaById(doc, c.musicFit.from)?.duration || 0)} long).` : `${mmss(c.duration)} long. Make it longer or shorter with no audible seam, keeping the song’s own ending.` });
  const fitB = el('button', { class: 'hw amber', text: video > 5 ? `🎵 FIT TO THE VIDEO (${mmss(video)})` : '🎵 EXTEND +1 MIN', onclick: async () => {
    fitB.disabled = true;
    try {
      const r = await fitMusic(app, c.id, video > 5 ? video : c.duration + 60, t => { note.textContent = t; });
      if (r) toast(`Music ${r.longer ? 'extended' : 'shortened'} to ${mmss(r.seconds)} (${r.jumps} seamless join${r.jumps === 1 ? '' : 's'}). ⌘Z undoes it.`, 6000);
    } catch (e) { note.textContent = clean(e); }
    fitB.disabled = false;
  } });
  return section('Music length',
    note,
    el('div', { class: 'btn-row' }, fitB, el('button', { class: 'tool', text: 'Other length…', onclick: () => openMusicFit(app, c.id) })));
}
