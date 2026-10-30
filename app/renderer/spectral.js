// SPECTRAL: Reel's spectral editor, built the way RX and Audition work. The clip's sound as a spectrogram;
// TIME, FREQ, BOX, LASSO and BRUSH selections (feathered, optionally repeated on harmonics, invertible);
// a playhead you click to place; PLAY / PLAY SEL / LOOP. Repairs are modules you pick and set up
// without anything happening: PREVIEW plays the selection with the fix (BYPASS flips to the original,
// in step), RENDER applies it. INSTANT (off by default) renders as soon as a selection is drawn.
// Rendered edits stack and can be removed one by one; APPLY TO CLIP writes a new WAV and keeps the original.
import { pref } from './prefs.js';
import { el, modal, toast } from './ui.js';
import { uid, mediaById } from './model.js';
import { fToY, yToF } from './spectral-dsp.js';
import * as ops from './clipops.js';

const TOOLS = [['time', 'T', 'TIME', 'Select a stretch of time, all frequencies'], ['freq', 'F', 'FREQ', 'Select a band of frequencies, all the way across'],
  ['rect', 'R', 'BOX', 'Select a box of time and frequency (Audition: Marquee)'], ['lasso', 'L', 'LASSO', 'Draw around a sound to select it'],
  ['brush', 'B', 'BRUSH', 'Paint over a sound to select it ([ and ] change the size)']];

const hz = v => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${v} Hz`);
const pct = v => Math.round(v * 100) + '%', sec = v => v.toFixed(2) + ' s', db = v => `${v > 0 ? '+' : ''}${v} dB`;
/** Repair modules. Picking one only shows its settings; PREVIEW hears it, RENDER applies it. */
const MODULES = [
  { id: 'attenuate', label: 'ATTENUATE', group: 'Spectral repair', sel: true, tip: 'Pulls the selection down to the level of the sound around it: coughs, chair squeaks, phone buzz, a loud breath (RX Spectral Repair › Attenuate)',
    params: [{ k: 'direction', label: 'Direction', options: [['h', 'Before / after'], ['v', 'Above / below'], ['both', 'Both']], def: 'h', tip: 'Learn from the sound before and after (most noises), the frequencies above and below (a steady whistle or tone), or both' },
      { k: 'surround', label: 'Surround', min: 0.05, max: 2, step: 0.05, def: 0.25, fmt: sec, tip: 'How much sound either side it learns from' },
      { k: 'tilt', label: 'Before ↔ after', min: -1, max: 1, step: 0.1, def: 0, fmt: v => (Math.abs(v) < 0.05 ? 'even' : v < 0 ? `before ${pct(-v)}` : `after ${pct(v)}`), tip: 'Lean on the sound before the selection, or after it' },
      { k: 'strength', label: 'Strength', min: 0.1, max: 1, step: 0.05, def: 1, fmt: pct }] },
  { id: 'heal', label: 'REPLACE', group: 'Spectral repair', sel: true, tip: 'Rebuilds the selection from the sound just before and after it: dropouts, a word cut short, a cough over a voice (RX Replace, Audition Spot Healing)',
    params: [{ k: 'surround', label: 'Surround', min: 0.05, max: 2, step: 0.05, def: 0.25, fmt: sec },
      { k: 'tilt', label: 'Before ↔ after', min: -1, max: 1, step: 0.1, def: 0, fmt: v => (Math.abs(v) < 0.05 ? 'even' : v < 0 ? `before ${pct(-v)}` : `after ${pct(v)}`) },
      { k: 'strength', label: 'Strength', min: 0.1, max: 1, step: 0.05, def: 1, fmt: pct }] },
  { id: 'volume', label: 'GAIN', group: 'Spectral repair', sel: true, tip: 'One level inside the selection and another outside it: pull a sound down, or turn everything else down to keep just it (CEDAR Retouch Volume)',
    params: [{ k: 'inside', label: 'Inside', min: -40, max: 12, step: 0.5, def: -12, fmt: db },
      { k: 'outside', label: 'Outside', min: -60, max: 12, step: 0.5, def: 0, fmt: v => (v <= -60 ? '−∞' : db(v)), tip: 'All the way down keeps only the selection' }] },
  { id: 'patch', label: 'PATCH', group: 'Spectral repair', sel: true, tip: 'Copies a stretch you choose over the selection, retuned if you like: select the good take, SET SOURCE, then select the bad spot (CEDAR Retouch Patch)',
    params: [{ k: 'source', kind: 'source' },
      { k: 'semitones', label: 'Retune', min: -12, max: 12, step: 0.5, def: 0, fmt: v => (v ? `${v > 0 ? '+' : ''}${v} st` : 'as is'), tip: 'Shift the borrowed sound’s pitch in semitones' },
      { k: 'strength', label: 'Strength', min: 0.1, max: 1, step: 0.05, def: 1, fmt: pct }] },
  { id: 'revert', label: 'REVERT', group: 'Spectral repair', sel: true, tip: 'Paints the selection back to the original sound, keeping every edit outside it (CEDAR Retouch Revert)', params: [] },
  { id: 'remove', label: 'REMOVE', group: 'Spectral repair', sel: true, tip: 'Silences the selection', params: [] },
  { id: 'isolate', label: 'KEEP ONLY', group: 'Spectral repair', sel: true, tip: 'Keeps the selection and silences everything else', params: [] },
  { id: 'denoise', label: 'DE-NOISE', group: 'Clean up', sel: false, useSel: true, learn: true, tip: 'Learns a noise (hiss, fan, room tone) from a stretch with only that noise, then takes it out of the selection or the whole clip (RX Spectral De-noise, Audition Noise Reduction)',
    params: [{ k: 'learn', kind: 'learn' },
      { k: 'reduction', label: 'Reduction', min: 3, max: 40, step: 1, def: 14, fmt: v => `${v} dB`, tip: 'How far the noise is turned down' },
      { k: 'threshold', label: 'Threshold', min: -10, max: 15, step: 0.5, def: 3, fmt: db, tip: 'How far above the learned noise a sound must be to be kept' },
      { k: 'smoothing', label: 'Smoothing', min: 0, max: 0.95, step: 0.05, def: 0.5, fmt: pct, tip: 'Steadier reduction: less of the "watery" sound' }] },
  { id: 'dehum', label: 'DE-HUM', group: 'Clean up', sel: false, useSel: true, tip: 'Takes out mains hum and its harmonics (the time selection, or the whole clip)',
    params: [{ k: 'hum', label: 'Base', options: [[0, 'Auto 50/60'], [50, '50 Hz'], [60, '60 Hz']], def: 0 },
      { k: 'harmonics', label: 'Harmonics', min: 1, max: 16, step: 1, def: 8, fmt: v => String(v) },
      { k: 'strength', label: 'Strength', min: 0.1, max: 1, step: 0.05, def: 1, fmt: pct }] },
  { id: 'declick', label: 'DE-CLICK', group: 'Clean up', sel: false, useSel: true, tip: 'Finds and repairs clicks, pops and crackle (the selection, or the whole clip)',
    params: [{ k: 'sensitivity', label: 'Sensitivity', min: 0, max: 1, step: 0.05, def: 0.5, fmt: pct }] },
  { id: 'dehiss', label: 'AUTO DEHISS', group: 'Clean up', sel: false, useSel: true, tip: 'Takes hiss and broadband noise down with no LEARN step: it tracks the noise as it goes (CEDAR Auto Dehiss)',
    params: [{ k: 'attenuation', label: 'Attenuation', min: 3, max: 30, step: 1, def: 12, fmt: v => `${v} dB`, tip: 'The most it turns the noise down' },
      { k: 'bias', label: 'Bias', min: -6, max: 12, step: 0.5, def: 0, fmt: db, tip: 'Higher treats more as noise' },
      { k: 'lfBias', label: 'LF bias', min: -6, max: 12, step: 0.5, def: 0, fmt: db, tip: 'The same, below 500 Hz only (rumble)' }] },
  { id: 'debuzz', label: 'DE-BUZZ', group: 'Clean up', sel: false, useSel: true, tip: 'Hum and buzz up to 500 Hz, following it when its pitch wanders (CEDAR Debuzz). DE-HUM is the quick fixed 50/60 Hz version.',
    params: [{ k: 'fundamental', label: 'Fundamental', min: 0, max: 500, step: 0.5, def: 0, fmt: v => (v ? `${v} Hz` : 'Auto 50/60'), tip: 'The buzz’s lowest note; 0 finds 50 or 60 Hz' },
      { k: 'bandwidth', label: 'Tracking', min: 0, max: 0.15, step: 0.005, def: 0.04, fmt: v => `±${(v * 100).toFixed(1)}%`, tip: 'How far the pitch may wander' },
      { k: 'threshold', label: 'Threshold', min: 0, max: 20, step: 0.5, def: 6, fmt: v => `${v} dB`, tip: 'Only peaks this far above their neighbours are treated' },
      { k: 'attenuation', label: 'Attenuation', min: 6, max: 60, step: 1, def: 40, fmt: v => `${v} dB` }] },
  { id: 'decrackle', label: 'DECRACKLE', group: 'Clean up', sel: false, useSel: true, tip: 'Low-level crackle and grit: many tiny ticks below what DE-CLICK catches (CEDAR Decrackle)',
    params: [{ k: 'sensitivity', label: 'Sensitivity', min: 0, max: 1, step: 0.05, def: 0.5, fmt: pct }] },
  { id: 'declip', label: 'DE-CLIP', group: 'Clean up', sel: false, useSel: true, tip: 'Redraws flattened, distorted peaks, even ones turned down by a compressor afterwards (CEDAR Declip)',
    params: [{ k: 'sensitivity', label: 'Sensitivity', min: 0, max: 1, step: 0.05, def: 0.5, fmt: pct, tip: 'Higher also catches softer, rounded clipping' },
      { k: 'gain', label: 'Output gain', min: -12, max: 0, step: 0.5, def: -3, fmt: db, tip: 'Room for the restored peaks' }] },
  { id: 'dethump', label: 'DETHUMP', group: 'Clean up', sel: false, useSel: true, tip: 'Bumps, handling noise and knocks: the thump is replaced with the low end that belongs there (CEDAR Dethump)',
    params: [{ k: 'sensitivity', label: 'Sensitivity', min: 0, max: 1, step: 0.05, def: 0.5, fmt: pct },
      { k: 'limit', label: 'Frequency limit', min: 40, max: 300, step: 5, def: 150, fmt: hz }] },
  { id: 'debark', label: 'DE-BARK', group: 'Clean up', sel: false, useSel: true, tip: 'Dog barks in the background: finds them and pulls just the bark down to the sound around it, keeping the voice. Most accurate in Example mode: select one bark and it finds the rest.',
    params: [{ k: 'mode', label: 'Find', options: [['auto', 'Automatically'], ['example', 'Like the selected bark']], def: 'auto' },
      { k: 'sensitivity', label: 'Sensitivity', min: 0, max: 1, step: 0.05, def: 0.5, fmt: pct, tip: 'Automatic: higher catches quieter barks' },
      { k: 'similarity', label: 'Match', min: 0.5, max: 0.95, step: 0.01, def: 0.75, fmt: pct, tip: 'Example mode: how alike a bark must be' },
      { k: 'strength', label: 'Strength', min: 0.1, max: 1, step: 0.05, def: 1, fmt: pct },
      { k: 'lowCut', label: 'Keep below', min: 100, max: 600, step: 10, def: 250, fmt: hz, tip: 'Leave everything under this frequency alone (the body of a voice)' }] },
  { id: 'dewind', label: 'DE-WIND', group: 'Clean up', sel: false, useSel: true, tip: 'Flattens wind gusts and mic buffeting: low rumble that comes and goes, while steady low sound stays (RX De-wind)',
    params: [{ k: 'cutoff', label: 'Cutoff', min: 80, max: 800, step: 10, def: 300, fmt: hz, tip: 'Wind is treated below this frequency' },
      { k: 'strength', label: 'Strength', min: 0.1, max: 1, step: 0.05, def: 0.8, fmt: pct },
      { k: 'smoothing', label: 'Smoothing', min: 0, max: 0.9, step: 0.05, def: 0.5, fmt: pct, tip: 'Steadier processing, fewer artefacts' }] },
  // voice
  { id: 'deplosive', label: 'DE-PLOSIVE', group: 'Voice', sel: false, useSel: true, tip: 'Takes the thump out of P and B sounds, pops and mic knocks, keeping the voice (RX De-plosive)',
    params: [{ k: 'sensitivity', label: 'Sensitivity', min: 0, max: 1, step: 0.05, def: 0.5, fmt: pct },
      { k: 'strength', label: 'Strength', min: 0.1, max: 1, step: 0.05, def: 1, fmt: pct },
      { k: 'limit', label: 'Frequency limit', min: 80, max: 400, step: 10, def: 200, fmt: hz, tip: 'Thumps are treated below this frequency' }] },
  { id: 'mouthdeclick', label: 'MOUTH DE-CLICK', group: 'Voice', sel: false, useSel: true, tip: 'Lip smacks, tongue clicks and saliva ticks in a voice (RX Mouth De-click)',
    params: [{ k: 'sensitivity', label: 'Sensitivity', min: 0, max: 1, step: 0.05, def: 0.5, fmt: pct },
      { k: 'skew', label: 'Frequency skew', min: -1, max: 1, step: 0.1, def: 0, fmt: v => (Math.abs(v) < 0.05 ? 'even' : v < 0 ? 'lower' : 'higher'), tip: 'Catch more clicks low down, or high up' },
      { k: 'widen', label: 'Click widening', min: 0, max: 5, step: 0.25, def: 1, fmt: v => `${v} ms`, tip: 'Repair a little either side of each click' }] },
  { id: 'deess', label: 'DE-ESS', group: 'Voice', sel: false, useSel: true, tip: 'Tames harsh S and SH sounds (RX De-ess)',
    params: [{ k: 'algorithm', label: 'Mode', options: [['classic', 'Classic'], ['spectral', 'Spectral']], def: 'classic', tip: 'Classic turns the whole ess band down; Spectral flattens only its harsh peaks, keeping the air' },
      { k: 'threshold', label: 'Threshold', min: -60, max: 0, step: 1, def: -30, fmt: v => `${v} dB`, tip: 'Esses louder than this are turned down to it' },
      { k: 'cutoff', label: 'Cutoff', min: 2000, max: 10000, step: 100, def: 5000, fmt: v => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${v} Hz`), tip: 'Sibilance is above this frequency' },
      { k: 'speed', label: 'Speed', options: [['fast', 'Fast'], ['slow', 'Slow']], def: 'fast' }] },
  { id: 'debreath', label: 'BREATH CONTROL', group: 'Voice', sel: false, useSel: true, tip: 'Finds breaths between words and turns them down, without cutting them (RX Breath Control)',
    params: [{ k: 'sensitivity', label: 'Sensitivity', min: 0, max: 1, step: 0.05, def: 0.5, fmt: pct },
      { k: 'mode', label: 'Mode', options: [['gain', 'Gain'], ['target', 'Target level']], def: 'gain' },
      { k: 'gain', label: 'Gain', min: -40, max: 0, step: 1, def: -12, fmt: db, tip: 'Gain mode: how far breaths are turned down' },
      { k: 'target', label: 'Target', min: -70, max: -20, step: 1, def: -45, fmt: v => `${v} dB`, tip: 'Target mode: the level every breath is brought to' }] },
  { id: 'dialogue', label: 'DIALOGUE ISOLATE', group: 'Voice', sel: false, useSel: true, tip: 'Keeps the voice and turns the background down: traffic, crowds, rooms (RX Dialogue Isolate)',
    params: [{ k: 'dialogue', label: 'Dialogue', min: -12, max: 6, step: 0.5, def: 0, fmt: db },
      { k: 'background', label: 'Background', min: -40, max: 0, step: 1, def: -18, fmt: db, tip: 'How far everything but the voice goes down' },
      { k: 'sensitivity', label: 'Sensitivity', min: 0, max: 1, step: 0.05, def: 0.5, fmt: pct, tip: 'Higher keeps quieter parts of the voice' },
      ...[['band1', 'Bass <150'], ['band2', '150–400'], ['band3', '400–1k'], ['band4', '1–2.5k'], ['band5', '2.5–6k'], ['band6', 'Air >6k']].map(([k, label]) =>
        ({ k, label, min: -20, max: 20, step: 1, def: 0, fmt: v => (v ? db(v) : '0'), tip: 'More (−) or less (+) background taken out in this band (like DNS’s band faders)' }))] },
  // restore
  { id: 'recovery', label: 'SPECTRAL RECOVERY', group: 'Restore', sel: false, useSel: true, tip: 'Brings back the top end lost to phone calls, Zoom and low-bitrate files: finds where the highs stop and rebuilds them (RX Spectral Recovery)',
    params: [{ k: 'amount', label: 'Amount', min: 0.1, max: 1, step: 0.05, def: 0.6, fmt: pct },
      { k: 'bandwidth', label: 'Rebuild up to', min: 6000, max: 22000, step: 500, def: 16000, fmt: v => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${v} Hz`) }] },
  { id: 'ambience', label: 'AMBIENCE MATCH', group: 'Restore', sel: false, useSel: true, learn: true, tip: 'LEARN a room tone, then fill the selection with it (a cut, a patched word) or fill every dead gap in the clip so the background never drops out (RX Ambience Match)',
    params: [{ k: 'learn', kind: 'learn' },
      { k: 'mode', label: 'Fill', options: [['fill', 'The selection'], ['gaps', 'Quiet gaps in the clip']], def: 'fill' },
      { k: 'level', label: 'Level', min: -20, max: 6, step: 0.5, def: 0, fmt: db }] },
];
// RX Spectral Repair's other two modes, in the same group as Attenuate and Replace
MODULES.splice(2, 0,
  { id: 'pattern', label: 'PATTERN', group: 'Spectral repair', sel: true, tip: 'Replaces the selection with the most similar stretch nearby: for music, rhythms and repeating sounds (RX Spectral Repair › Pattern)',
    params: [{ k: 'searchRange', label: 'Search range', min: 0.5, max: 10, step: 0.5, def: 4, fmt: sec, tip: 'How far either side it looks for a match' },
      { k: 'surround', label: 'Surround', min: 0.05, max: 1, step: 0.05, def: 0.25, fmt: sec, tip: 'How much around the hole is compared' },
      { k: 'strength', label: 'Strength', min: 0.1, max: 1, step: 0.05, def: 1, fmt: pct }] },
  { id: 'partials', label: 'PARTIALS + NOISE', group: 'Spectral repair', sel: true, tip: 'Rebuilds tones and harmonics straight across the gap (a sung note, a hum, a held chord) and fills the noise underneath (RX Spectral Repair › Partials + Noise)',
    params: [{ k: 'harmonicThreshold', label: 'Tone threshold', min: 3, max: 30, step: 1, def: 12, fmt: v => `${v} dB`, tip: 'How far above its surroundings a peak must stand to count as a tone' },
      { k: 'surround', label: 'Surround', min: 0.05, max: 1, step: 0.05, def: 0.25, fmt: sec },
      { k: 'strength', label: 'Strength', min: 0.1, max: 1, step: 0.05, def: 1, fmt: pct }] });
const FIXED = { declick: 'click', mouthdeclick: 'click', deplosive: 'plosive', deess: 'ess', debreath: 'breath', decrackle: 'crackle', declip: 'clipped peak', dethump: 'thump', debark: 'bark' };
const PREFS = 'reel.spectral';
const prefsGet = () => { const d = { log: true, palette: 'reel', floor: -96, N: 2048, wave: 0.35, feather: 0.3, brush: 18, module: 'attenuate', params: {}, loop: false };
  try { return { ...d, ...(JSON.parse(localStorage.getItem(PREFS) || '{}') || {}) }; } catch { return d; } };

export async function openSpectral(app, clip) {
  const doc = app.doc;
  let c = clip || doc.clips.find(x => app.selection.clips.includes(x.id) && x.type === 'media');
  if (!c || c.type !== 'media') { toast('Select an audio clip (or a video clip with sound) first.'); return; }
  const m = mediaById(doc, c.media);
  if (!m || m.kind === 'image') { toast('Pictures have no sound to edit.'); return; }
  if (c.locked) { toast('Unlock the clip first.'); return; }
  // a video clip's sound is detached first, so the picture stays as it is
  if (!c.audioOnly && m.kind === 'video') {
    if (!m.hasAudio) { toast('This video has no sound.'); return; }
    app.select([c.id], null); ops.detachAudio(app);
    c = doc.clips.find(x => x.id === app.selection.clips[0]);
    if (!c) return;
  }
  // reopening: start again from the original with the saved edits
  const srcMediaId = c.spectral ? c.spectral.media : c.media, srcIn = c.spectral ? c.spectral.in : (c.in || 0);
  const srcMedia = mediaById(doc, srcMediaId);
  if (!srcMedia) { toast('The original sound for this clip is missing.'); return; }
  const from = srcIn, to = from + c.duration * (c.speed || 1), dur = to - from;
  const P = prefsGet();
  const keepPrefs = () => { try { localStorage.setItem(PREFS, JSON.stringify(P)); } catch { /* fine */ } };

  // ---------------------------------------------------------------- worker
  const worker = new Worker(new URL('./spectral-worker.js', import.meta.url), { type: 'module' });
  const waits = new Map(); let seq = 1, onChunk = null, ovT = 0;
  worker.onmessage = e => {
    const r = e.data;
    if (r.type === 'progress') { loadBar.style.width = Math.round(r.value * 100) + '%'; return; }
    if (r.type === 'overview') { // a long fix being drawn into the picture in the background
      status.textContent = r.left > 0 ? `Updating the picture… ${Math.round((1 - r.left / r.total) * 100)}% (you can keep working)` : 'Picture up to date.';
      if (r.t1 > view.t0 && r.t0 < view.t1) { clearTimeout(ovT); ovT = setTimeout(() => refresh(), 250); }
      return;
    }
    if (r.type === 'chunk') { onChunk?.(r.data); return; }
    const w = waits.get(r.id); if (!w) return; waits.delete(r.id);
    if (r.type === 'error') w.reject(new Error(r.message)); else w.resolve(r);
  };
  const call = (type, data = {}) => new Promise((resolve, reject) => { const id = seq++; waits.set(id, { resolve, reject }); worker.postMessage({ type, id, ...data }); });

  // ---------------------------------------------------------------- top bar
  const loadBar = el('i');
  const canvas = el('canvas', { class: 'sp-canvas' }), over = el('canvas', { class: 'sp-over' });
  const fRuler = el('canvas', { class: 'sp-fruler' }), tRuler = el('canvas', { class: 'sp-truler', title: 'Click to move the playhead' });
  const plot = el('div', { class: 'sp-plot' }, canvas, over, el('div', { class: 'sp-loading' }, el('span', { text: 'Reading the sound…' }), el('div', { class: 'progress' }, loadBar)));
  const toolBtns = TOOLS.map(([id, key, label, tip]) => { const b = el('button', { class: 'tool', 'data-tool': id, title: `${tip} (${key})`, text: label }); b.addEventListener('click', () => setTool(id)); return b; });
  const harmBtn = el('button', { class: 'tool', title: 'Harmonics: repeat the selection on the overtones (2×, 3×…) of a voice or a hum (H)', text: 'HARMONICS ×1' });
  const invBtn = el('button', { class: 'tool', title: 'Invert the selection: everything except what you drew (⌘I)', text: 'INVERT' });
  const featherIn = el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: P.feather, title: 'Feather: soften the selection’s edges' });
  const brushIn = el('input', { type: 'range', min: 4, max: 80, step: 1, value: P.brush, title: 'Brush size ([ and ])' });
  const logBtn = el('button', { class: 'tool', text: P.log ? 'LOG' : 'LINEAR', title: 'Frequency scale: log (like hearing) or linear' });
  const palSel = el('select', { title: 'Colours' }, ...[['reel', 'Amber'], ['magma', 'Magma'], ['mono', 'Mono']].map(([v, t]) => el('option', { value: v, text: t, selected: P.palette === v })));
  const fftSel = el('select', { title: 'FFT size: bigger shows pitch more finely, smaller shows timing more sharply' }, ...[1024, 2048, 4096, 8192].map(v => el('option', { value: v, text: `FFT ${v}`, selected: P.N === v })));
  const floorIn = el('input', { type: 'range', min: -140, max: -50, step: 2, value: P.floor, title: 'Dynamic range: how quiet a sound still shows' });
  const waveIn = el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: P.wave, title: 'Waveform over the spectrogram (like RX’s opacity slider)' });
  const simBtn = el('button', { class: 'tool', text: 'FIND SIMILAR', title: 'Select one sound (a click, a cough, a beep), then find and select every other one like it (RX Find Similar Event) (⌘F)' });
  const simIn = el('input', { type: 'range', min: 0.5, max: 0.98, step: 0.01, value: P.similarity ?? 0.8, title: 'Similarity: how alike a sound must be to count' });
  const simPrev = el('button', { class: 'tool', text: '◀', title: 'Previous match' }), simNext = el('button', { class: 'tool', text: '▶', title: 'Next match' });
  const bar = el('div', { class: 'sp-bar' }, ...toolBtns, harmBtn, invBtn, simBtn, el('label', { class: 'sp-mini' }, 'Match', simIn), simPrev, simNext,
    el('label', { class: 'sp-mini' }, 'Feather', featherIn), el('label', { class: 'sp-mini' }, 'Brush', brushIn),
    el('span', { class: 'spacer' }), logBtn, palSel, fftSel, el('label', { class: 'sp-mini' }, 'Range', floorIn), el('label', { class: 'sp-mini' }, 'Wave', waveIn));

  // ---------------------------------------------------------------- module rack (right)
  const modBtns = new Map(), paramBox = el('div', { class: 'sp-params' }), modHelp = el('p', { class: 'note sp-help' });
  const learnState = el('span', { class: 'sp-learnstate' }), srcState = el('span', { class: 'sp-learnstate' });
  let profile = null, patchSrc = null;
  const groups = {};
  for (const md of MODULES) {
    const b = el('button', { class: 'hw sp-mod', text: md.label, title: md.tip });
    b.addEventListener('click', () => setModule(md.id));
    modBtns.set(md.id, b);
    (groups[md.group] ||= []).push(b);
  }
  const history = el('div', { class: 'sp-history' });
  // two columns: the chosen module's settings, and the rack of modules (each scrolls on its own)
  const side = el('div', { class: 'sp-side' },
    el('div', { class: 'sp-pcol' }, el('div', { class: 'sp-modpanel' }, paramBox, modHelp)),
    el('div', { class: 'sp-rcol' },
    ...Object.entries(groups).flatMap(([g, bs]) => [el('div', { class: 'engr', text: g }), el('div', { class: 'sp-modgrid' }, ...bs)]),
    el('div', { class: 'engr', text: 'Rendered edits' }), history));
  const pv = id => (P.params[id] ||= {});
  function setModule(id) {
    P.module = id; keepPrefs();
    for (const [k, b] of modBtns) b.classList.toggle('lit', k === id);
    const md = MODULES.find(x => x.id === id), vals = pv(id);
    modHelp.textContent = md.tip + (md.sel ? ' Needs a selection.' : '');
    paramBox.replaceChildren(el('div', { class: 'sp-modname', text: md.label }), ...md.params.map(p => {
      if (p.kind === 'learn') {
        const lb = el('button', { class: 'tool', text: 'LEARN', title: md.id === 'ambience' ? 'Select a stretch of just the room (no voice), then LEARN' : 'Select a stretch with only the noise (no voice), then LEARN' });
        lb.addEventListener('click', learn);
        return el('div', { class: 'sp-row' }, lb, learnState);
      }
      if (p.kind === 'source') {
        const sb = el('button', { class: 'tool', text: 'SET SOURCE', title: 'Select the good stretch to copy from, then SET SOURCE' });
        sb.addEventListener('click', () => {
          if (!sel.length) { toast('Select the stretch to copy from first.'); return; }
          const b = selBounds(); patchSrc = { t0: b[0], t1: b[1] }; srcState.textContent = `Source ${b[0].toFixed(2)}–${b[1].toFixed(2)} s ✓`;
          sel = []; inverted = false; invBtn.classList.remove('lit'); drawOver();
          status.textContent = 'Source set. Now select the spot to patch, PREVIEW, then RENDER.';
        });
        srcState.textContent = patchSrc ? `Source ${patchSrc.t0.toFixed(2)}–${patchSrc.t1.toFixed(2)} s ✓` : 'No source yet';
        return el('div', { class: 'sp-row' }, sb, srcState);
      }
      if (vals[p.k] === undefined) vals[p.k] = p.def;
      if (p.options) {
        const s = el('select', { title: p.tip || p.label }, ...p.options.map(([v, t]) => el('option', { value: String(v), text: t, selected: String(vals[p.k]) === String(v) })));
        s.addEventListener('change', () => { vals[p.k] = typeof p.def === 'number' ? Number(s.value) : s.value; keepPrefs(); });
        return el('div', { class: 'sp-row' }, el('label', { text: p.label }), s);
      }
      const out = el('span', { class: 'sp-val', text: p.fmt(vals[p.k]) });
      const r = el('input', { type: 'range', min: p.min, max: p.max, step: p.step, value: vals[p.k], title: p.tip || p.label });
      r.addEventListener('input', () => { vals[p.k] = Number(r.value); out.textContent = p.fmt(vals[p.k]); keepPrefs(); });
      r.addEventListener('dblclick', () => { r.value = vals[p.k] = p.def; out.textContent = p.fmt(p.def); keepPrefs(); });
      return el('div', { class: 'sp-row' }, el('label', { text: p.label }), r, out);
    }));
    learnState.textContent = profile ? `${md.id === 'ambience' ? 'Ambience' : 'Noise'} learned ✓` : 'Not learned yet';
  }

  // ---------------------------------------------------------------- footer: transport and processing
  const btn = (label, cls, tip, fn) => { const b = el('button', { class: cls, title: tip }, label); b.addEventListener('click', fn); return b; };
  const homeBtn = btn('|◀', 'tool', 'Playhead to the start (Home)', () => { setPlayhead(0); });
  const playBtn = btn('▶ PLAY', 'tool sp-play', 'Play from the playhead (Space)', () => (playing ? stopPlay() : playFrom()));
  const selBtn = btn('▶ SEL', 'tool', 'Play the selection (⇧Space)', () => (playing ? stopPlay() : playSel()));
  const loopBtn = btn('⟲ LOOP', 'tool' + (P.loop ? ' lit' : ''), 'Loop the selection while you listen and preview (⌘L)', () => { P.loop = !P.loop; keepPrefs(); loopBtn.classList.toggle('lit', P.loop); if (playing) { const k = playing.kind; stopPlay(); k === 'preview' ? preview() : k === 'sel' ? playSel() : playFrom(); } });
  const readout = el('span', { class: 'sp-readout led', text: '0.000 s' });
  const status = el('div', { class: 'sp-status' });
  const instBtn = btn('INSTANT', 'tool', 'Instant process: render the chosen fix as soon as you finish a selection (like RX)', () => { instant = !instant; instBtn.classList.toggle('lit', instant); status.textContent = instant ? `INSTANT on: every selection gets ${MODULES.find(x => x.id === P.module).label} straight away.` : 'INSTANT off: PREVIEW, then RENDER.'; });
  const prevBtn = btn('PREVIEW', 'hw sp-preview', 'Hear the fix on the selection without applying it (P). Loops when LOOP is on.', () => (playing?.kind === 'preview' ? stopPlay() : preview()));
  const bypassBtn = btn('BYPASS', 'tool', 'While previewing: hear the original instead of the fix (in step, so you can compare)', () => { bypass = !bypass; bypassBtn.classList.toggle('lit', bypass); applyBypass(); });
  let removed = false;
  const removedBtn = btn('Δ REMOVED', 'tool', 'While previewing: hear only what the fix takes out (RX “output … only”), to check it isn’t eating the voice', () => { removed = !removed; removedBtn.classList.toggle('lit', removed); if (playing?.kind === 'preview') preview(); });
  const renderBtn = btn('RENDER', 'hw amber sp-render', 'Apply the chosen fix (↩). Remove it again from Rendered edits.', () => render());
  const foot = el('div', { class: 'sp-foot' }, homeBtn, playBtn, selBtn, loopBtn, readout, status, instBtn, prevBtn, bypassBtn, removedBtn, renderBtn);

  const body = el('div', { class: 'sp-wrap' }, bar,
    el('div', { class: 'sp-main' }, el('div', { class: 'sp-graph' }, fRuler, plot, el('span'), tRuler), side), foot);

  let closed = false;
  const dlg = modal(`Spectral · ${c.name || m.name}`, body, [
    { label: 'Cancel', onClick: close => close() },
    { label: 'Apply to clip', cls: 'hw amber', onClick: () => commit() },
  ], { wide: true, onClose: () => { closed = true; stopPlay(); worker.terminate(); window.removeEventListener('keydown', keys, true); ro.disconnect(); clearInterval(antTimer); } });
  dlg.root.classList.add('spectral');

  // ---------------------------------------------------------------- state
  let nyq = 24000, view = { t0: 0, t1: dur, f0: 20, f1: 24000 };
  let tool = 'rect', harmonics = 1, sel = [], inverted = false, instant = false, bypass = false, playhead = 0;
  let edits = c.spectral ? structuredClone(c.spectral.edits || []) : [], src = 'work';
  let img = null, wave = null, drawing = null;

  const setTool = t => { tool = t; for (const b of toolBtns) b.classList.toggle('lit', b.dataset.tool === t); over.dataset.tool = t; };
  setTool('rect');
  harmBtn.addEventListener('click', () => { harmonics = harmonics >= 6 ? 1 : harmonics + 1; harmBtn.textContent = `HARMONICS ×${harmonics}`; harmBtn.classList.toggle('lit', harmonics > 1); drawOver(); });
  invBtn.addEventListener('click', () => { if (!sel.length) { toast('Draw a selection first, then invert it.'); return; } inverted = !inverted; invBtn.classList.toggle('lit', inverted); describeSel(); drawOver(); });
  featherIn.addEventListener('input', () => { P.feather = Number(featherIn.value); keepPrefs(); drawOver(); });
  brushIn.addEventListener('input', () => { P.brush = Number(brushIn.value); keepPrefs(); });
  logBtn.addEventListener('click', () => { P.log = !P.log; logBtn.textContent = P.log ? 'LOG' : 'LINEAR'; keepPrefs(); refresh(); });
  palSel.addEventListener('change', () => { P.palette = palSel.value; keepPrefs(); refresh(); });
  fftSel.addEventListener('change', () => { P.N = Number(fftSel.value); keepPrefs(); refresh(); });
  floorIn.addEventListener('change', () => { P.floor = Number(floorIn.value); keepPrefs(); refresh(); });
  waveIn.addEventListener('input', () => { P.wave = Number(waveIn.value); keepPrefs(); paint(); });
  setModule(MODULES.some(x => x.id === P.module) ? P.module : 'attenuate');

  // ---------------------------------------------------------------- drawing
  const size = () => { const r = plot.getBoundingClientRect(); return { w: Math.max(50, r.width), h: Math.max(50, r.height) }; };
  const dpr = () => Math.min(1.5, devicePixelRatio || 1);
  const tx = t => ((t - view.t0) / (view.t1 - view.t0)) * size().w;
  const fy = f => (1 - fToY(f, view.f0, view.f1, P.log)) * size().h;
  const xt = x => view.t0 + (x / size().w) * (view.t1 - view.t0);
  const yf = y => yToF(1 - y / size().h, view.f0, view.f1, P.log);
  let reqId = 0, pending = false, opened = false;
  async function refresh() {
    if (closed || !opened) return;
    if (pending) { pending = 'again'; return; }
    pending = true;
    const { w, h } = size(), k = dpr(), W = Math.round(w * k), Hh = Math.round(h * k);
    const my = ++reqId;
    try {
      const r = await call('view', { width: W, height: Hh, t0: view.t0, t1: view.t1, f0: view.f0, f1: view.f1, log: P.log, N: P.N, floor: P.floor, palette: P.palette, src });
      if (my === reqId) { img = new ImageData(r.img, r.width, r.height); wave = r.wave; paint(); rulers(); drawOver(); }
    } catch (e) { status.textContent = e.message; }
    const again = pending === 'again'; pending = false; if (again) refresh();
  }
  function paint() {
    if (!img) return;
    canvas.width = img.width; canvas.height = img.height;
    const g = canvas.getContext('2d'); g.putImageData(img, 0, 0);
    if (wave && P.wave > 0) {
      g.save(); g.globalAlpha = P.wave; g.strokeStyle = '#e8f6ff'; g.lineWidth = 1; g.beginPath();
      const H2 = img.height / 2;
      for (let x = 0; x < img.width; x++) { g.moveTo(x + 0.5, H2 - wave[x * 2 + 1] * H2 * 0.95); g.lineTo(x + 0.5, H2 - wave[x * 2] * H2 * 0.95); }
      g.stroke(); g.restore();
    }
  }
  function rulers() {
    const { w, h } = size(), k = dpr();
    fRuler.width = 46 * k; fRuler.height = h * k; tRuler.width = w * k; tRuler.height = 20 * k;
    const g = fRuler.getContext('2d'); g.scale(k, k); g.fillStyle = '#cfcabd'; g.font = '9px Menlo, monospace'; g.textAlign = 'right';
    for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      if (f < view.f0 || f > view.f1) continue;
      const y = fy(f); g.fillRect(40, y, 6, 1); g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), 38, y + 3);
    }
    const t = tRuler.getContext('2d'); t.scale(k, k); t.fillStyle = '#cfcabd'; t.font = '9px Menlo, monospace';
    const span = view.t1 - view.t0, step = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60].find(s => span / s < w / 70) || 120;
    for (let s = Math.ceil(view.t0 / step) * step; s <= view.t1; s += step) { const x = tx(s); t.fillRect(x, 0, 1, 5); t.fillText(s >= 60 ? `${Math.floor(s / 60)}:${(s % 60).toFixed(step < 1 ? 2 : 0).padStart(2, '0')}` : s.toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0) + 's', x + 2, 15); }
    // playhead marker on the ruler
    const px = tx(playhead); t.fillStyle = '#ffb02a'; t.beginPath(); t.moveTo(px - 5, 0); t.lineTo(px + 5, 0); t.lineTo(px, 7); t.fill();
  }
  function shapePath(g, s) {
    const { w, h } = size();
    g.beginPath();
    if (s.kind === 'time') g.rect(tx(s.t0), 0, tx(s.t1) - tx(s.t0), h);
    else if (s.kind === 'freq') g.rect(0, fy(s.f1), w, fy(s.f0) - fy(s.f1));
    else if (s.kind === 'rect') g.rect(tx(s.t0), fy(s.f1), tx(s.t1) - tx(s.t0), fy(s.f0) - fy(s.f1));
    else if (s.kind === 'poly') { s.pts.forEach(([t, f], i) => (i ? g.lineTo(tx(t), fy(f)) : g.moveTo(tx(t), fy(f)))); g.closePath(); }
    else if (s.kind === 'brush') for (const [t, f] of s.pts) { const rx = (s.rt / (view.t1 - view.t0)) * w, ry = Math.abs(fy(f * 2 ** s.ro) - fy(f)); g.moveTo(tx(t) + rx, fy(f)); g.ellipse(tx(t), fy(f), Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2); }
  }
  const harmCopies = s => { const out = [s]; if (harmonics > 1 && s.kind !== 'time' && s.kind !== 'freq') for (let k = 2; k <= harmonics; k++) out.push(s.kind === 'rect' ? { ...s, f0: s.f0 * k, f1: s.f1 * k } : { ...s, pts: s.pts.map(([t, f]) => [t, f * k]) }); return out; };
  let ants = 0;
  function drawOver() {
    const { w, h } = size(), k = dpr();
    over.width = w * k; over.height = h * k;
    const g = over.getContext('2d'); g.scale(k, k);
    const all = [...sel, ...(drawing ? [drawing.shape] : [])];
    if (inverted && sel.length) { // everything but the shapes
      g.fillStyle = 'rgba(255,176,42,0.14)'; g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'destination-out'; for (const base of sel) for (const s of harmCopies(base)) { shapePath(g, s); g.fill(); } g.globalCompositeOperation = 'source-over';
    }
    for (const base of all) for (const [n, s] of harmCopies(base).entries()) {
      shapePath(g, s);
      if (!inverted) { g.fillStyle = n ? 'rgba(127,208,255,0.12)' : 'rgba(255,176,42,0.16)'; g.fill(s.kind === 'brush' ? 'nonzero' : 'evenodd'); }
      g.setLineDash([5, 4]); g.lineDashOffset = -ants; g.lineWidth = 1.2; g.strokeStyle = n ? '#7fd0ff' : '#ffb02a'; if (s.kind !== 'brush') g.stroke();
    }
    // playhead (and the loop span while looping)
    const t = playing ? playT() : playhead, x = tx(t);
    if (playing?.loop) { g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(tx(playing.t0), 0, tx(playing.t1) - tx(playing.t0), h); }
    g.setLineDash([]); g.strokeStyle = playing ? '#ffffff' : 'rgba(255,255,255,0.75)'; g.lineWidth = playing ? 1.6 : 1.2;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    if (playing?.kind === 'preview') { g.fillStyle = bypass ? '#7fd0ff' : '#45ff5a'; g.font = '700 10px Menlo, monospace'; g.fillText(bypass ? 'BYPASS: ORIGINAL' : 'PREVIEW: FIXED', 8, 14); }
  }
  const antTimer = setInterval(() => { if (closed) return; if (sel.length || playing) { ants = (ants + 1) % 9; if (playing) follow(); drawOver(); if (playing) rulers(); } }, 60);
  function follow() { // keep the moving playhead on screen (page by page, like RX)
    const t = playT(), span = view.t1 - view.t0;
    if (t > view.t1 || t < view.t0) { view.t0 = Math.max(0, Math.min(dur - span, t - span * 0.05)); view.t1 = view.t0 + span; refresh(); }
  }
  function setPlayhead(t) { playhead = Math.max(0, Math.min(dur, t)); readout.textContent = `${playhead.toFixed(3)} s`; if (playing) { const k = playing.kind; stopPlay(); if (k === 'from') playFrom(); } rulers(); drawOver(); }

  // ---------------------------------------------------------------- mouse
  let down = null;
  over.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); over.setPointerCapture(e.pointerId);
    const r = over.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, t = xt(x), f = yf(y);
    down = { x, y, shift: e.shiftKey };
    const { w, h } = size();
    if (tool === 'time') drawing = { shape: { kind: 'time', t0: t, t1: t }, a: [t, f] };
    else if (tool === 'freq') drawing = { shape: { kind: 'freq', f0: f, f1: f }, a: [t, f] };
    else if (tool === 'rect') drawing = { shape: { kind: 'rect', t0: t, t1: t, f0: f, f1: f }, a: [t, f] };
    else if (tool === 'lasso') drawing = { shape: { kind: 'poly', pts: [[t, f]] } };
    else drawing = { shape: { kind: 'brush', pts: [[t, f]], rt: (P.brush / 2 / w) * (view.t1 - view.t0), ro: (P.brush / 2 / h) * Math.log2(view.f1 / Math.max(1, view.f0)) } };
  });
  over.addEventListener('pointermove', e => {
    const r = over.getBoundingClientRect(), t = Math.max(0, Math.min(dur, xt(e.clientX - r.left))), f = Math.max(1, Math.min(nyq, yf(e.clientY - r.top)));
    readout.textContent = `${t.toFixed(3)} s · ${f < 1000 ? Math.round(f) + ' Hz' : (f / 1000).toFixed(2) + ' kHz'}`;
    if (!drawing) return;
    if (down && Math.hypot(e.clientX - r.left - down.x, e.clientY - r.top - down.y) < 4 && !drawing.moved) return; // still a click
    drawing.moved = true;
    if (!down.shift && !drawing.cleared) { sel = []; inverted = false; invBtn.classList.remove('lit'); drawing.cleared = true; }
    const s = drawing.shape;
    if (s.kind === 'time') { s.t0 = Math.min(drawing.a[0], t); s.t1 = Math.max(drawing.a[0], t); }
    else if (s.kind === 'freq') { s.f0 = Math.min(drawing.a[1], f); s.f1 = Math.max(drawing.a[1], f); }
    else if (s.kind === 'rect') { s.t0 = Math.min(drawing.a[0], t); s.t1 = Math.max(drawing.a[0], t); s.f0 = Math.min(drawing.a[1], f); s.f1 = Math.max(drawing.a[1], f); }
    else { const last = s.pts[s.pts.length - 1]; if (Math.abs(tx(last[0]) - tx(t)) + Math.abs(fy(last[1]) - fy(f)) > 2) s.pts.push([t, f]); }
    drawOver();
  });
  over.addEventListener('pointerleave', () => { readout.textContent = `${playhead.toFixed(3)} s`; });
  const endDraw = () => {
    if (!drawing) return;
    const d = drawing; drawing = null;
    if (!d.moved) { // a click: move the playhead there (and drop the selection, like RX)
      if (!down?.shift) { sel = []; inverted = false; invBtn.classList.remove('lit'); }
      setPlayhead(xt(down.x)); describeSel(); down = null; return;
    }
    down = null;
    const s = d.shape;
    const ok = s.kind === 'time' ? s.t1 - s.t0 > 0.005 : s.kind === 'freq' ? s.f1 - s.f0 > 1 : s.kind === 'rect' ? s.t1 - s.t0 > 0.005 && s.f1 - s.f0 > 1 : s.kind === 'poly' ? s.pts.length > 2 : true;
    if (ok) sel.push(s);
    describeSel(); drawOver();
    if (ok && instant) render();
  };
  over.addEventListener('pointerup', endDraw); over.addEventListener('pointercancel', endDraw);
  tRuler.addEventListener('pointerdown', e => { const r = tRuler.getBoundingClientRect(); setPlayhead(xt(e.clientX - r.left)); });
  over.addEventListener('dblclick', () => { view = { t0: 0, t1: dur, f0: 20, f1: nyq }; refresh(); });
  over.addEventListener('wheel', e => {
    e.preventDefault();
    const r = over.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, k = Math.exp(e.deltaY * 0.0025);
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d = ((e.shiftKey ? e.deltaY : e.deltaX) / size().w) * (view.t1 - view.t0), span = view.t1 - view.t0;
      view.t0 = Math.max(0, Math.min(dur - span, view.t0 + d)); view.t1 = view.t0 + span;
    } else if (e.altKey) {
      const f = yf(y), lo = P.log ? Math.log2(view.f0) : view.f0, hi = P.log ? Math.log2(view.f1) : view.f1, at = P.log ? Math.log2(f) : f;
      let a = at - (at - lo) * k, b = at + (hi - at) * k;
      const minA = P.log ? Math.log2(20) : 0, maxB = P.log ? Math.log2(nyq) : nyq;
      a = Math.max(minA, a); b = Math.min(maxB, b); if (b - a < (P.log ? 0.3 : 50)) return;
      view.f0 = P.log ? 2 ** a : a; view.f1 = P.log ? 2 ** b : b;
    } else {
      const t = xt(x); let a = t - (t - view.t0) * k, b = t + (view.t1 - t) * k;
      a = Math.max(0, a); b = Math.min(dur, b); if (b - a < 0.02) return;
      view.t0 = a; view.t1 = b;
    }
    refresh();
  }, { passive: false });
  const ro = new ResizeObserver(() => refresh()); ro.observe(plot);

  const selBounds = () => sel.reduce((a, s) => {
    const pts = s.pts || [];
    const t0 = s.kind === 'freq' ? 0 : s.t0 ?? Math.min(...pts.map(p => p[0] - (s.rt || 0)));
    const t1 = s.kind === 'freq' ? dur : s.t1 ?? Math.max(...pts.map(p => p[0] + (s.rt || 0)));
    return [Math.max(0, Math.min(a[0], t0)), Math.min(dur, Math.max(a[1], t1))];
  }, [Infinity, -Infinity]);
  function describeSel() {
    if (!sel.length) { status.textContent = 'Click to place the playhead, drag to select (T time · F frequency · R box · L lasso · B brush, ⇧ adds). Pick a fix on the right, PREVIEW it, then RENDER.'; return; }
    const b = selBounds();
    status.textContent = `${inverted ? 'Everything except ' : ''}${sel.length} selection${sel.length > 1 ? 's' : ''} · ${b[0].toFixed(2)}–${b[1].toFixed(2)} s${harmonics > 1 ? ` · ×${harmonics} harmonics` : ''}. ⇧Space plays it, P previews the fix.`;
  }

  // ---------------------------------------------------------------- find similar event
  let hits = [], hitAt = -1;
  const moveShape = (sh, dt) => sh.kind === 'freq' ? sh : sh.kind === 'time' || sh.kind === 'rect' ? { ...sh, t0: sh.t0 + dt, t1: sh.t1 + dt } : { ...sh, pts: sh.pts.map(([t, f]) => [t + dt, f]) };
  async function findSimilar() {
    if (!sel.length) { toast('FIND SIMILAR: select one example of the sound first.'); return; }
    const one = sel[0], b = selBounds();
    if (b[1] - b[0] > 3) { toast('Select a single short sound (under 3 seconds) to find others like it.'); return; }
    status.textContent = 'Looking for similar sounds…';
    try {
      const r = await call('similar', { sel: { shapes: [structuredClone(one)] }, similarity: Number(simIn.value) });
      hits = r.hits; hitAt = -1;
      sel = [one, ...hits.map(h => moveShape(structuredClone(one), h.offset))]; inverted = false; invBtn.classList.remove('lit');
      status.textContent = hits.length ? `${hits.length} similar sound${hits.length > 1 ? 's' : ''} found and selected (${hits.length + 1} with yours). ◀ ▶ visit them; pick a fix and RENDER treats them all.` : 'No similar sounds found. Lower Match to be less strict.';
      drawOver();
    } catch (e) { status.textContent = e.message; }
  }
  function visitHit(step) {
    if (!hits.length) { toast('Use FIND SIMILAR first.'); return; }
    hitAt = (hitAt + step + hits.length) % hits.length;
    const s0 = sel[0], t = (s0?.t0 ?? s0?.pts?.[0]?.[0] ?? 0) + hits[hitAt].offset;
    const span = view.t1 - view.t0;
    if (t < view.t0 || t > view.t1) { view.t0 = Math.max(0, Math.min(dur - span, t - span * 0.3)); view.t1 = view.t0 + span; refresh(); }
    setPlayhead(t);
    status.textContent = `Match ${hitAt + 1} of ${hits.length} (${Math.round(hits[hitAt].score * 100)}% alike).`;
  }
  simBtn.addEventListener('click', findSimilar);
  simPrev.addEventListener('click', () => visitHit(-1));
  simNext.addEventListener('click', () => visitHit(1));
  simIn.addEventListener('change', () => { P.similarity = Number(simIn.value); keepPrefs(); });

  // ---------------------------------------------------------------- the chosen fix
  const selSpec = () => ({ shapes: structuredClone(sel), harmonics, featherT: P.feather * 0.05, featherOct: P.feather * 0.25, invert: inverted });
  function buildEdit() {
    const md = MODULES.find(x => x.id === P.module), vals = pv(md.id);
    if (md.sel && !sel.length) { toast(`${md.label} needs a selection: drag on the spectrogram first.`); return null; }
    if (md.learn && !profile) { toast(`${md.label}: select a stretch with only the ${md.id === 'ambience' ? 'room tone' : 'noise'} and press LEARN first.`); return null; }
    if (md.id === 'ambience' && vals.mode === 'fill' && !sel.length) { toast('AMBIENCE MATCH: select where the room tone should go (or choose “Quiet gaps in the clip”).'); return null; }
    // De-click and De-hum work on a stretch of time: any shape counts as the time it covers
    const span = () => { const b = selBounds(); return { shapes: [{ kind: 'time', t0: b[0], t1: b[1] }] }; };
    const ed = { op: md.id, label: md.label[0] + md.label.slice(1).toLowerCase(), ...vals, sel: md.sel ? selSpec() : md.useSel && sel.length ? (['declick', 'dehum'].includes(md.id) && !inverted ? span() : selSpec()) : null };
    if (md.id === 'attenuate' && vals.direction !== 'h') ed.label += vals.direction === 'v' ? ' (above/below)' : ' (both)';
    if (md.id === 'debark' && vals.mode === 'example' && !sel.length) { toast('DE-BARK: select one bark first (or switch Find to Automatically).'); return null; }
    if (md.id === 'patch') {
      if (!patchSrc) { toast('PATCH: select the good stretch to copy from and press SET SOURCE first.'); return null; }
      ed.sourceOffset = patchSrc.t0 - selBounds()[0];
    }
    if (md.id === 'volume') ed.label = `Gain ${db(vals.inside)}${vals.outside ? ` / outside ${vals.outside <= -60 ? '−∞' : db(vals.outside)}` : ''}`;
    if (md.learn) ed.profile = Array.from(profile);
    if (md.id === 'denoise') ed.label = `De-noise ${vals.reduction} dB`;
    return ed;
  }
  async function learn() {
    const b = sel.length ? selBounds() : null;
    if (!b || b[1] - b[0] < 0.25) { toast('Select at least a quarter second with only the noise (no voice), then LEARN.'); return; }
    try {
      const r = await call('learn', { t0: b[0], t1: b[1] }); profile = r.profile; learnState.textContent = `Learned ✓ (${(b[1] - b[0]).toFixed(1)} s)`;
      sel = []; inverted = false; invBtn.classList.remove('lit'); drawOver(); // ready to clean the whole clip
      status.textContent = P.module === 'ambience' ? 'Ambience learned. Select where it should go (or pick “Quiet gaps”), PREVIEW, then RENDER.' : 'Noise learned. RENDER now cleans the whole clip, or select just a part first. PREVIEW to hear it.';
    }
    catch (e) { toast(e.message); }
  }
  async function render() {
    const ed = buildEdit(); if (!ed) return;
    stopPlay();
    status.textContent = `${ed.label}…`;
    try {
      const r = await call('apply', { edit: ed });
      edits.push(ed); drawHistory();
      const noun = FIXED[ed.op];
      status.textContent = noun ? `${ed.label}: ${r.fixed || 0} ${noun}${r.fixed === 1 ? '' : 's'} fixed. ⌘Z undoes it.`
        : ed.op === 'recovery' ? (r.fixed ? `Spectral recovery: highs rebuilt above ${(r.cutoff / 1000).toFixed(1)} kHz.` : `Spectral recovery: nothing to rebuild (the sound already reaches ${(r.cutoff / 1000).toFixed(1)} kHz).`)
        : ed.op === 'debuzz' ? `De-buzz: tracked a ${r.fundamental} Hz buzz and its harmonics.`
        : ed.op === 'partials' && !r.partials ? 'Partials + noise: no tones found next to the selection, so only the noise was rebuilt.'
        : `${ed.label} rendered. ⌘Z undoes it; remove it any time under Rendered edits.`;
      if (src === 'orig') src = 'work';
      refresh();
    } catch (e) { status.textContent = e.message; }
  }
  function drawHistory() {
    history.replaceChildren(...(edits.length ? edits.map((ed, i) => el('div', { class: 'sp-h' }, el('span', { text: `${i + 1}. ${ed.label}` }),
      el('button', { class: 'mini', text: '×', title: 'Remove this edit', onclick: () => removeEdit(i) }))) : [el('p', { class: 'note', text: 'Nothing rendered yet.' })]));
  }
  async function removeEdit(i) { stopPlay(); edits.splice(i, 1); drawHistory(); status.textContent = 'Rebuilding…'; await call('rebuild', { edits }); status.textContent = 'Edit removed.'; refresh(); }

  // ---------------------------------------------------------------- listening
  // playing = { kind: 'from' | 'sel' | 'preview', t0, t1, loop, ctx, start, gFix, gOrig }
  let playing = null;
  const playT = () => { if (!playing) return playhead; const el2 = playing.ctx.currentTime - playing.start, len = playing.t1 - playing.t0; return playing.t0 + (playing.loop ? el2 % len : Math.min(el2, len)); };
  async function startBuffers(r, t0, t1, kind, loop, two) {
    const ctx = new AudioContext({ sampleRate: r.rate });
    const sink = app.player.monitor?.sink; if (sink && ctx.setSinkId) await ctx.setSinkId(sink).catch(() => {});
    const mk = chs => { const b = ctx.createBuffer(chs.length, Math.max(1, chs[0].length), r.rate); chs.forEach((d, i) => b.copyToChannel(d, i)); return b; };
    const srcs = [], gains = [];
    for (const chs of two ? [r.fixed, r.orig] : [r.chs]) {
      const s = ctx.createBufferSource(), g = ctx.createGain(); s.buffer = mk(chs); s.loop = loop; s.connect(g); g.connect(ctx.destination); srcs.push(s); gains.push(g);
    }
    const start = ctx.currentTime + 0.05;
    for (const s of srcs) s.start(start);
    srcs[0].onended = () => { if (playing && playing.ctx === ctx) stopPlay(); };
    playing = { kind, t0, t1, loop, ctx, start, srcs, gFix: gains[0], gOrig: gains[1] || null };
    applyBypass();
    playBtn.classList.toggle('lit', kind === 'from'); selBtn.classList.toggle('lit', kind === 'sel'); prevBtn.classList.toggle('lit', kind === 'preview');
  }
  function applyBypass() { if (playing?.gOrig) { const now = playing.ctx.currentTime; playing.gFix.gain.setTargetAtTime(bypass ? 0 : 1, now, 0.008); playing.gOrig.gain.setTargetAtTime(bypass ? 1 : 0, now, 0.008); } drawOver(); }
  async function playRange(t0, t1, kind) {
    stopPlay();
    if (t1 - t0 < 0.02) return;
    const r = await call('audio', { t0, t1, src });
    await startBuffers(r, t0, t1, kind, P.loop && kind !== 'from', false);
  }
  const playFrom = () => playRange(playhead, Math.min(dur, playhead + 90), 'from');
  const playSel = () => { const b = sel.length ? selBounds() : [view.t0, view.t1]; return playRange(b[0], b[1], 'sel'); };
  async function preview() {
    const ed = buildEdit(); if (!ed) return;
    stopPlay();
    // the selection (or, for whole-clip fixes with no selection, 12 s from the playhead)
    const b = sel.length ? selBounds() : [playhead, Math.min(dur, playhead + 12)];
    status.textContent = `Preview: ${ed.label}…`;
    try {
      const r = await call('preview', { edit: ed, t0: b[0], t1: b[1], removed });
      await startBuffers(r, b[0], b[1], 'preview', P.loop, true);
      status.textContent = `Previewing ${ed.label}${removed ? ' — only what it removes' : ''}${P.loop ? ' (looping)' : ''}. BYPASS compares with the original; RENDER applies it.`;
    } catch (e) { status.textContent = e.message; }
  }
  function stopPlay() {
    if (!playing) return;
    const p = playing; playing = null;
    for (const s of p.srcs) { try { s.stop(); } catch { /* done */ } }
    p.ctx.close().catch(() => {});
    playBtn.classList.remove('lit'); selBtn.classList.remove('lit'); prevBtn.classList.remove('lit');
    drawOver(); rulers();
  }

  // ---------------------------------------------------------------- keys (only while this window is open)
  const keys = e => {
    if (e.target.closest('input, select, textarea')) return;
    const k = e.key.toLowerCase(); let used = true;
    const t = TOOLS.find(x => x[1].toLowerCase() === k);
    if (t && !e.metaKey) setTool(t[0]);
    else if (k === 'h' && !e.metaKey) harmBtn.click();
    else if (k === ' ' && e.shiftKey) (playing ? stopPlay() : playSel());
    else if (k === ' ') (playing ? stopPlay() : playFrom());
    else if (k === 'p' && !e.metaKey) (playing?.kind === 'preview' ? stopPlay() : preview());
    else if (k === 'enter') render();
    else if (k === 'l' && e.metaKey) loopBtn.click();
    else if (k === 'i' && e.metaKey) invBtn.click();
    else if (k === 'f' && e.metaKey) findSimilar();
    else if (k === 'a' && e.metaKey) { sel = [{ kind: 'time', t0: 0, t1: dur }]; inverted = false; invBtn.classList.remove('lit'); describeSel(); drawOver(); }
    else if (k === 'home') setPlayhead(0);
    else if (k === 'escape' && (playing || sel.length)) { if (playing) stopPlay(); else { sel = []; inverted = false; invBtn.classList.remove('lit'); describeSel(); drawOver(); } }
    else if (k === 'escape') used = false;
    else if ((k === 'backspace' || k === 'delete') && sel.length) { setModule('remove'); render(); }
    else if (k === 'z' && e.metaKey && edits.length) removeEdit(edits.length - 1);
    else if (k === '[') { brushIn.value = P.brush = Math.max(4, P.brush - 4); keepPrefs(); }
    else if (k === ']') { brushIn.value = P.brush = Math.min(80, P.brush + 4); keepPrefs(); }
    else used = false;
    if (used) { e.preventDefault(); e.stopImmediatePropagation(); }
  };
  window.addEventListener('keydown', keys, true);

  // ---------------------------------------------------------------- apply to the clip
  async function commit() {
    stopPlay();
    const token = app.token, clipId = c.id;
    if (!edits.length) {
      if (c.spectral) app.commit(() => { c.media = c.spectral.media; c.in = c.spectral.in; delete c.spectral; });
      dlg.close(); toast(c.spectral ? 'Back to the original sound.' : 'Nothing rendered, so nothing to apply.'); return;
    }
    status.textContent = 'Writing the edited sound…';
    let rid = null;
    try {
      rid = (await app.api.renderBegin(token, `${srcMedia.name} spectral`, 'wav')).id;
      onChunk = data => app.api.renderChunk(rid, data);
      const r = await call('render');
      onChunk = null;
      const info = await app.api.renderFinish(rid, r.head); rid = null;
      if (app.token !== token) return;
      const nm = { id: uid('m'), ...info, name: `${srcMedia.name} (spectral)`, hidden: true, role: srcMedia.role };
      app.commit(d => {
        const live = d.clips.find(x => x.id === clipId); if (!live) return;
        d.media.push(nm);
        live.spectral = { media: srcMediaId, in: srcIn, edits: structuredClone(edits) };
        live.media = nm.id; live.in = 0;
      });
      dlg.close();
      toast(`${edits.length} spectral edit${edits.length > 1 ? 's' : ''} applied. Reopen Spectral to change or remove them.`);
    } catch (e) { if (rid) app.api.renderCancel(rid); status.textContent = e.message; toast(e.message, 5000); }
  }

  // ---------------------------------------------------------------- go
  drawHistory(); describeSel();
  try {
    const url = `app://reel/m/${app.token}/${encodeURIComponent(srcMedia.file)}`;
    const r = await call('open', { url, file: srcMedia.file, from, to, cacheMB: Number(pref('spectralCache')) || 384 });
    nyq = r.rate / 2; view.f1 = nyq;
    if (edits.length) { status.textContent = 'Re-applying your edits…'; await call('rebuild', { edits }); describeSel(); }
    plot.querySelector('.sp-loading')?.remove();
    opened = true;
    refresh();
  } catch (e) { plot.querySelector('.sp-loading span').textContent = e.message; }
}
