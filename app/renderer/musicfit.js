// 🎵 Fit the music: makes the selected music clip end exactly when you want (the end of the video, the In–Out, or a
// length you type) by repeating or skipping sections where the song sounds the same, so the joins can't be heard
// and the song keeps its real ending (lib/musicfit.js). The result is ordinary clips with crossfades: every seam
// can be moved, trimmed or undone.
import { el, modal, toast } from './ui.js';
import { mediaById, uid, clipEnd, duration as docDuration, addTrack, fmtTime } from './model.js';
import { analyseMusic, beatGrid, planFit } from './lib/musicfit.js';

const RATE = 22050;
const cache = new Map();
async function analyse(app, m, from, len, onStatus) {
  const key = `${m.file}|${from.toFixed(2)}|${len.toFixed(2)}`;
  if (cache.has(key)) return cache.get(key);
  onStatus?.('Listening to the music…');
  const bytes = await (await fetch(`app://reel/m/${app.token}/${encodeURIComponent(m.file)}`)).arrayBuffer();
  const buf = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(bytes);
  const a = Math.floor(from * RATE), n = Math.min(buf.length - a, Math.ceil(len * RATE));
  const mono = new Float32Array(Math.max(0, n));
  for (let ch = 0; ch < buf.numberOfChannels; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < mono.length; i++) mono[i] += d[a + i] / buf.numberOfChannels; }
  onStatus?.('Finding the beat and the sections that repeat…');
  await new Promise(r => setTimeout(r, 30)); // let the dialog say so before the work starts
  const an = analyseMusic(mono, RATE), grid = beatGrid(an);
  const out = { an, grid, length: mono.length / RATE };
  cache.set(key, out);
  return out;
}

/** The end of the picture: where the last video, picture or title ends. */
function videoEnd(doc) {
  let e = 0;
  for (const c of doc.clips) { const m = c.type === 'media' ? mediaById(doc, c.media) : null; if (c.type !== 'media' || (m && m.kind !== 'audio' && !c.audioOnly)) e = Math.max(e, clipEnd(c)); }
  return e || docDuration(doc);
}

/**
 * What a music clip was fitted from: a fitted song's sections (same group) and the original source range, or for a
 * plain clip, itself and the rest of the song from its In (so it keeps its real ending).
 */
export function fitSource(doc, c) {
  if (c.musicFit && c.fitSrc) {
    const members = doc.clips.filter(x => x.musicFit && x.group === c.group && x.media === c.media && x.fitSrc && x.fitSrc.in === c.fitSrc.in).sort((a, b) => a.start - b.start);
    return { first: members[0], members, srcIn: c.fitSrc.in, srcLen: c.fitSrc.len };
  }
  const m = mediaById(doc, c.media);
  const srcLen = c.retime ? c.retime[c.retime.length - 1].s : c.duration * (c.speed || 1);
  return { first: c, members: [c], srcIn: c.in || 0, srcLen: Math.max(srcLen, (m?.duration || srcLen) - (c.in || 0)) };
}
/** Is this clip music that the ♪ handle can re-fit? (a fitted song's last section, or a sound clip on a Music track) */
export function musicLike(doc, c) {
  const m = c.type === 'media' ? mediaById(doc, c.media) : null;
  if (!m || c.reversed || c.locked) return false;
  if (c.musicFit) { const f = fitSource(doc, c); return f.members[f.members.length - 1] === c; }
  const tr = doc.tracks.find(t => t.id === c.track);
  return (m.kind === 'audio' || c.audioOnly) && m.role !== 'mic' && (tr?.role === 'music' || /music|song|track|beat/i.test(m.name || '') || c.duration >= 20);
}

/** Re-fits a song (a plain music clip or a fitted one) to last `target` seconds from where it starts. */
export async function refitTo(app, c, target) {
  const f = fitSource(app.doc, c), m = mediaById(app.doc, f.first.media);
  const res = await analyse(app, m, f.srcIn, f.srcLen);
  const plan = planFit(res.an, res.grid, res.length, Math.max(3, target));
  place(app, f.first, plan, res.grid.period, { members: f.members, srcIn: f.srcIn, srcLen: res.length });
  return plan;
}

export function openMusicFit(app) {
  const doc = app.doc; if (!doc) return;
  const c = doc.clips.find(x => app.selection.clips.includes(x.id) && x.type === 'media' && (mediaById(doc, x.media)?.kind === 'audio' || mediaById(doc, x.media)?.hasAudio));
  if (!c) { toast('Select the music clip first (click it on the timeline).'); return; }
  const m = mediaById(doc, c.media);
  const srcLen = c.retime ? c.retime[c.retime.length - 1].s : c.duration * (c.speed || 1);
  const full = Math.max(srcLen, (m.duration || srcLen) - (c.in || 0)); // the rest of the song, past where the clip is trimmed
  const vEnd = videoEnd(doc), toEnd = Math.max(1, vEnd - c.start);
  const rg = doc.range && doc.range.out > (doc.range.in || 0) + 1 ? doc.range.out - Math.max(c.start, doc.range.in || 0) : 0;
  const mode = el('select', {},
    el('option', { value: 'end', text: `To the end of the video (${fmtTime(toEnd).replace(/\.\d$/, '')} from where it starts)` }),
    rg > 1 ? el('option', { value: 'range', text: `To the end of the In–Out (${fmtTime(rg).replace(/\.\d$/, '')})` }) : null,
    el('option', { value: 'custom', text: 'A length I type' }));
  const secs = el('input', { type: 'number', min: 3, max: 3600, step: 0.5, value: Math.round(toEnd), style: { width: '90px' } });
  const customRow = el('div', { class: 'row', style: { display: 'none' } }, el('label', { text: 'Length (s)' }), secs);
  mode.addEventListener('change', () => { customRow.style.display = mode.value === 'custom' ? '' : 'none'; });
  const whole = el('input', { type: 'checkbox', checked: full > srcLen + 1 });
  const note = el('p', { class: 'note', text: `The clip is ${fmtTime(srcLen).replace(/\.\d$/, '')} now${full > srcLen + 1 ? `; the whole song is ${fmtTime(full + (c.in || 0)).replace(/\.\d$/, '')}` : ''}. Reel finds where the song repeats itself on the beat and plays a section again (or skips one), joining them with short crossfades. The intro and the real ending stay.` });
  modal('🎵 Fit the music', el('div', { class: 'mf' },
    el('div', { class: 'row' }, el('label', { text: 'Make it fit' }), mode), customRow,
    full > srcLen + 1 ? el('label', { class: 'row' }, whole, el('span', { text: ' Use the whole song (from the clip’s start to the song’s real ending)' })) : null,
    note), [
    { label: 'Cancel', onClick: x => x() },
    { label: 'Fit', cls: 'hw amber', onClick: async close => {
      const target = mode.value === 'custom' ? Math.max(3, Number(secs.value) || toEnd) : mode.value === 'range' ? rg : toEnd;
      const len = whole.checked ? full : srcLen;
      try {
        const f = fitSource(app.doc, c);
        const from = c.musicFit ? f.srcIn : c.in || 0, span = c.musicFit ? f.srcLen : len;
        const res = await analyse(app, m, from, span, t => { note.textContent = t; });
        const plan = planFit(res.an, res.grid, res.length, target);
        note.textContent = 'Putting it on the timeline…';
        place(app, f.first, plan, res.grid.period, { members: c.musicFit ? f.members : [c], srcIn: from, srcLen: res.length });
        close();
        const seamless = plan.seams.every(s => s.likeness >= 0.55);
        const n = plan.segments.length - 1;
        toast(n ? `Music fitted to ${fmtTime(plan.length / plan.speed).replace(/\.\d$/, '')}: ${n} join${n === 1 ? '' : 's'}${seamless ? ' on the beat where the song repeats' : ' (no clean repeat found: check the join and nudge it if you hear it)'}${plan.speed !== 1 ? `, and ${Math.round(Math.abs(plan.speed - 1) * 1000) / 10}% ${plan.speed > 1 ? 'faster' : 'slower'} with the pitch kept to land exactly` : ''}. ⌘Z undoes it.` : 'The music already fits.', 8000);
      } catch (e) { note.textContent = `Couldn’t fit the music: ${e.message}`; }
    } },
  ], { wide: false });
}

/** Replaces the clip with the plan's sections, joined with crossfades (on a track of their own if they'd overlap). */
export function place(app, c0, plan, beat, { members = [c0], srcIn = c0.in || 0, srcLen = plan.length } = {}) {
  const xf = Math.max(0.12, Math.min(0.5, beat * 0.5)), sp = plan.speed || 1;
  app.commit(d => {
    const c = d.clips.find(x => x.id === c0.id); if (!c) return;
    const gone = new Set(members.map(x => x.id));
    const last = d.clips.filter(x => gone.has(x.id)).sort((a, b) => b.start - a.start)[0] || c;
    const total = plan.length / sp, end = c.start + total;
    let track = c.track;
    const blocked = d.clips.some(o => !gone.has(o.id) && o.track === c.track && o.start < end - 0.01 && clipEnd(o) > c.start + 0.01);
    if (blocked) { const idx = d.tracks.findIndex(t => t.id === c.track); const t = addTrack(d, idx + 1); t.name = 'Music (fitted)'; track = t.id; }
    d.clips = d.clips.filter(x => !gone.has(x.id));
    c.in = srcIn; // the sections are taken from the original source range
    const fadeOut = last.audio?.fadeOut || 0;
    let at = c.start;
    const group = c.group || uid('g');
    plan.segments.forEach((g, i) => {
      const dur = (g.b - g.a) / sp;
      const k = structuredClone(c);
      delete k.retime; delete k.keys; delete k.marks;
      Object.assign(k, { id: uid('c'), track, start: at, duration: dur, in: srcIn + g.a, speed: sp === 1 ? 1 : sp, group, musicFit: true, fitSrc: { in: srcIn, len: srcLen } });
      k.audio = { ...(k.audio || {}), keepPitch: true, fadeIn: i === 0 ? c.audio?.fadeIn || 0 : 0, fadeOut: i === plan.segments.length - 1 ? fadeOut : 0 };
      delete k.xfadeIn; delete k.xfadeOut; delete k.xfAuto;
      if (i === 0 && c.xfadeIn) k.xfadeIn = c.xfadeIn; // the crossfade from the clip before stays
      if (i > 0) k.xfadeIn = xf;
      if (i < plan.segments.length - 1) k.xfadeOut = xf;
      k.name = (c.name || 'Music').replace(/ \(\d+\)$/, '') + (i === 0 ? '' : ` (${i + 1})`);
      d.clips.push(k);
      at += dur;
    });
  });
}

// ---------------------------------------------------------------- the MUSIC tab in the panel on the right
const mmss = s => { const r = Math.max(0, Math.round(s)); return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`; };
/** A sound clip the MUSIC tab offers to fit (any sound-only clip; the ♪ handle is for the music-like ones). */
export function canFit(doc, c) {
  const m = c && c.type === 'media' ? mediaById(doc, c.media) : null;
  return !!(m && (m.kind === 'audio' || c.audioOnly) && !c.reversed && !c.locked);
}
/** The MUSIC tab's section: fit to the end of the video in one click, or the full Fit the music window. */
export function musicSection(app, c, section) {
  const doc = app.doc, toEnd = Math.max(1, videoEnd(doc) - c.start);
  const f = c.musicFit ? fitSource(doc, c) : null;
  const note = el('p', { class: 'note', text: f
    ? `Fitted: ${f.members.length} section${f.members.length === 1 ? '' : 's'} joined where the song repeats. Drag the ♪ on its end to re-fit it to another length.`
    : `${mmss(c.duration)} long. Make it end with the video (or any length), repeating or skipping sections where the song repeats on the beat, keeping its real ending.` });
  const fitB = el('button', { class: 'hw amber', text: `🎵 FIT TO THE VIDEO (${mmss(toEnd)})`, onclick: async () => {
    fitB.disabled = true; note.textContent = 'Listening to the music…';
    try {
      const plan = await refitTo(app, c, toEnd);
      const n = plan.segments.length - 1;
      toast(n ? `Music fitted to ${mmss(plan.length / plan.speed)} with ${n} join${n === 1 ? '' : 's'}. ⌘Z undoes it.` : 'The music already fits.', 6000);
    } catch (e) { note.textContent = `Couldn’t fit the music: ${e.message}`; fitB.disabled = false; }
  } });
  return section('Music length', note,
    el('div', { class: 'btn-row' }, fitB, el('button', { class: 'tool', text: 'Other length…', onclick: () => { app.select([c.id], null); openMusicFit(app); } })));
}
