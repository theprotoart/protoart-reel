// AUTO EDIT: one button from a raw video to a finished edit for a platform. Pick a recipe (TikTok / Reels,
// YouTube Shorts, several Shorts, a podcast clip, or a long YouTube video) and Reel runs its own tools in order:
// listen to the speech → pick the best moments (for shorts) → cut ums and dead air → reframe vertical →
// Smart Zoom with a transitions pack and sound effects → captions → chapters → loudness. Everything it makes is
// ordinary clips, actions, transitions and captions, so any of it can be changed afterwards, and UNDO AUTO EDIT
// puts the project back exactly as it was.
import { el, modal, toast } from './ui.js';
import { mediaById, removeRange, insertTime, uid, duration as docDuration, split, clipEnd, withGroups, newTextClip, newElementClip, addTrack, cutsOn, OVERLAP_CUTS } from './model.js';
import { planGraphics, GFX_LEVELS, GFX_LOOKS } from './lib/kinetic.js';
import { planTalkingText, TALK_MODES, TALK_LOOKS } from './lib/talktext.js';
import { bleepWords, bleepPrefs, swearOpts } from './bleep.js';
import { cleanWords, unbleep } from './lib/profanity.js';
import { placeTalkingText } from './talktext.js';
import { ELEMENTS, elementHome } from './lib/elements.js';
import { buildCaptions, fillerRanges, pauseRanges, cutRanges, withoutSpans } from './lib/words.js';
import { pickHighlights, chapters, sentences } from './lib/highlight.js';
import { FORMATS } from './lib/reframe.js';
import { analyse } from './autozoom.js';
import { timelineWords, speechClips, LANGS } from './transcript.js';
import { umModel, findYourUms } from './umvoice.js';
import { masterOf } from './master-ui.js';
import { PACKS, autoTransitions } from './fxlibrary.js';
import { planCallouts, placeCallouts } from './callouts.js';
import { clapsOnTimeline } from './clapscan.js';
import { placeClapNotes } from './clapnotes.js';
import { writerReady, nameChapters } from './writer.js';
import { allChains, chainById, applyChain } from './lib/chainpresets.js';

export const RECIPES = {
  tiktok: {
    name: 'TikTok · Reels', icon: '9:16', hint: 'The best moment of your video as a vertical short: a strong opening line, punchy zooms and transitions, big captions.',
    lengths: [[15, '15 s'], [30, '30 s'], [45, '45 s'], [60, '60 s']], length: 30,
    format: 'vertical', fit: 'follow', zoom: ['punchy', 1.5], pack: 'social', sounds: true, captions: 'big', loud: 'spotify', clean: 'tight', highlights: 1, talk: 'both', talkLook: 'green',
  },
  shorts: {
    name: 'YouTube Shorts', icon: '9:16', hint: 'Like TikTok, up to 60 seconds, mixed for YouTube.',
    lengths: [[30, '30 s'], [45, '45 s'], [58, 'Up to 60 s']], length: 45,
    format: 'vertical', fit: 'follow', zoom: ['punchy', 1.4], pack: 'punchy', sounds: true, captions: 'big', loud: 'youtube', clean: 'tight', highlights: 1, talk: 'both', talkLook: 'yellow',
  },
  multi: {
    name: 'Several Shorts', icon: '3×', hint: 'The 3 best moments, one after another, each marked. Export each one with In and Out (I / O).',
    lengths: [[20, '20 s each'], [30, '30 s each'], [45, '45 s each']], length: 30,
    format: 'vertical', fit: 'follow', zoom: ['punchy', 1.4], pack: 'punchy', sounds: true, captions: 'big', loud: 'spotify', clean: 'tight', highlights: 3, talk: 'both', talkLook: 'green',
  },
  podcast: {
    name: 'Podcast clip', icon: '9:16', hint: 'A highlight from a talk or podcast: the whole picture on a blurred background, gentle zooms, big captions.',
    lengths: [[30, '30 s'], [60, '60 s'], [90, '90 s']], length: 60,
    format: 'vertical', fit: 'blur', zoom: ['follow', 0.55], pack: 'clean', sounds: false, captions: 'big', loud: 'podcast', clean: 'tight', highlights: 1, talk: 'spoken', talkLook: 'box', bleep: 'bleep',
  },
  tutorial: {
    name: 'Tutorial', icon: '16:9', hint: 'A screen tutorial, tidied: clap signals cut out (your takes stay in ✂ TAKES), mouth clicks removed, the voice evened out, ums and long pauses cut, gentle zooms that follow your work, chapters.',
    lengths: null, format: null, zoom: ['kenburns', 0.8], pack: null, sounds: false, captions: 'file', loud: 'youtube', clean: 'gentle', chapters: true, highlights: 0,
    claps: 'cut', voice: 'tutorial', talk: 'both', talkLook: 'yellow',
  },
  youtube: {
    name: 'YouTube video', icon: '16:9', hint: 'The whole video, tidied: ums and long pauses cut, medium zooms, smooth transitions, chapters, YouTube loudness.',
    lengths: null, format: null, zoom: ['kenburns', 1], pack: 'smooth', sounds: false, captions: 'file', loud: 'youtube', clean: 'gentle', chapters: true, highlights: 0,
    claps: 'markers', voice: 'light', talk: 'keywords',
  },
};

const PREF = 'reel.autoedit';
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREF) || '{}') || {}; } catch { return {}; } };
const savePrefs = p => { try { localStorage.setItem(PREF, JSON.stringify(p)); } catch { /* fine */ } };

const isVideo = (doc, c) => c.type === 'media' && !c.audioOnly && !c.disabled && mediaById(doc, c.media)?.kind === 'video';

// how strong each part is: the recipe picks a starting point, the person can turn each one up or down
export const ZOOM_LEVELS = { off: ['Off', 0], subtle: ['Subtle', 0.55], medium: ['Medium', 1], heavy: ['Heavy', 1.5] };
export const TRANS_LEVELS = { off: ['Off', 0], few: ['A few', 1], some: ['Some', 2], lots: ['Lots', 3] };
export const CAPTION_LEVELS = { off: ['Off'], file: ['Subtitle file'], burned: ['In the video'], big: ['Big & bold'] };
export const CLEAN_LEVELS = { off: ['Off'], gentle: ['Gentle'], tight: ['Tight'] };
/** Sound effects with the transitions (whooshes, hits…): off, or how loud (the Sound FX track's level). */
/** Volume: even out the speech with an Auto Level on each track with sound. */
export const VOLUME_LEVELS = { off: ['Leave it'], even: ['Even it out'] };
/** Call-outs: none, a reminder now and then (Like · Subscribe · Bell, or Follow on a short), or that plus an end screen. */
/** Clap signals (clap, clap, clap before a retake): leave them, mark them, or cut them out. */
export const CLAP_LEVELS = { off: ['Leave them'], markers: ['Mark them'], cut: ['Cut them out'], notes: ['Show as notes'] };
/** Clap notes (clap, then say what goes on screen): keep the spoken note in the video, or cut it so it only shows as text. */
export const NOTE_SPEECH = { keep: ['Keep what I say'], cut: ['Cut what I say (text only)'] };
export const CTA_LEVELS = { off: ['Off'], remind: ['Reminders'], end: ['Reminders + end screen'] };
/** How mixed up the transitions are: the style's own few, a mix of the same feel, or anything. */
export const VARIETY_LEVELS = { same: ['Same few', 0], mixed: ['Mixed', 0.5], wild: ['Surprise me', 1] };
export const SFX_LEVELS = { off: ['Off', 0], quiet: ['Quiet', 0.4], normal: ['Normal', 1], loud: ['Loud', 1.6] };
/** How a wide video fills a tall frame. */
export const FIT_LEVELS = { follow: ['Crop, follow the action'], blur: ['Blurred copy'], zoom: ['Zoomed copy'], bars: ['Black bars'] };
/** Seconds between transitions for each amount (shorts are faster-paced than long videos). */
export const transGap = (level, short) => ({ few: short ? 10 : 45, some: short ? 5 : 20, lots: short ? 2 : 8 }[level] ?? Infinity);
const zoomLevelOf = r => (r.zoom[1] >= 1.3 ? 'heavy' : r.zoom[1] >= 0.9 ? 'medium' : 'subtle');
/** How the zooms move: the recipe's own, or one picked in the dialog. */
/** Swearing: left in, bleeped (a tone over the muted word), or muted. */
export const BLEEP_LEVELS = { off: ['Leave it'], bleep: ['📢 Bleep'], mute: ['🔇 Mute'] };
export const MOTION_STYLES = { punchy: ['Punchy: quick push-ins and push-outs'], follow: ['Follow the action'], kenburns: ['Ken Burns: slow, steady drifts'] };
const recipeDefaults = r => ({
  zoom: zoomLevelOf(r), trans: r.pack ? (r.highlights ? 'some' : 'few') : 'off', pack: r.pack || 'clean', sfx: r.sounds ? 'normal' : 'off', volume: 'even',
  captions: r.captions === 'big' ? 'big' : 'file', clean: r.clean || 'gentle', fit: r.fit || 'follow',
  cta: r.highlights ? 'remind' : 'end',
  gfx: r.highlights || r.format ? 'lots' : 'few', gfxLook: r.gfxLook || 'mix', variety: 'mixed',
  keepSped: true,
  motion: r.zoom[0] in MOTION_STYLES ? r.zoom[0] : 'follow',
  claps: r.claps || 'off', voice: r.voice || 'none', noteSpeech: 'keep',
  talk: r.talk || 'off', talkLook: r.talkLook || 'green',
  bleep: r.bleep || 'off',
});
/**
 * The parts to work on: the sections added with X (each an In–Out), plus the current In–Out if it isn't one of
 * them yet. Empty: the whole edit.
 */
export function sectionsOf(doc) {
  const list = (doc.sections || []).map(s => ({ t0: s.t0, t1: s.t1, id: s.id })).sort((a, b) => a.t0 - b.t0);
  const r = regionOf(doc);
  if (r && !list.some(s => r.t0 < s.t1 && r.t1 > s.t0)) list.push({ ...r, pending: true });
  return list.sort((a, b) => a.t0 - b.t0);
}
/** The In / Out region set on the timeline (I and O), if there is one smaller than the whole edit. */
export function regionOf(doc) {
  const total = docDuration(doc), a = doc.range?.in ?? 0, b = doc.range?.out ?? total;
  if (!doc.range || !(b > a + 1) || (a <= 0.01 && b >= total - 0.01)) return null;
  return { t0: Math.max(0, a), t1: Math.min(total, b) };
}

export function openAutoEdit(app) {
  const doc = app.doc; if (!doc) return;
  app.timeline?.setMarking?.(false);
  if (!doc.clips.some(c => isVideo(doc, c)) && !doc.media.some(m => m.kind === 'video')) {
    toast('Drop a video into Reel first (or ADD MEDIA), then AUTO EDIT it.', 5000); return;
  }
  const p = loadPrefs();
  let id = RECIPES[p.recipe] ? p.recipe : 'tiktok', len = null, o = null;
  let parts = sectionsOf(doc), useRegion = parts.length > 0;
  const cards = el('div', { class: 'ae-recipes' });
  const lenRow = el('div', { class: 'seg ae-len' }), detail = el('p', { class: 'ae-detail' });
  const steps = el('ul', { class: 'ae-steps' });
  const lang = el('select', {}, ...LANGS.map(([v, t]) => el('option', { value: v, text: t, selected: v === (p.locale || 'en-US') })));
  // a row of choices (Off / Subtle / Medium / Heavy …) for one setting
  const segs = {};
  const seg = (key, levels) => {
    const box = el('div', { class: 'seg ae-seg' });
    for (const [v, [t]] of Object.entries(levels)) box.append(el('button', { type: 'button', text: t, 'data-v': v, onclick: () => { o[key] = v; draw(); } }));
    segs[key] = box; return box;
  };
  const packSel = el('select', { title: 'The style of transition (the same packs as Presets and Smart Zoom)' }, ...Object.entries(PACKS).map(([k, pk]) => el('option', { value: k, text: `${pk.name} — ${pk.hint}` })));
  packSel.addEventListener('change', () => { o.pack = packSel.value; draw(); });
  const sfxNote = el('span', { class: 'note ae-sfx-note' });
  // cutting dead air leaves sped-up clips (time-lapses) alone: they're meant to be in the edit
  const keepSpedCb = el('input', { type: 'checkbox' });
  keepSpedCb.addEventListener('change', () => { o.keepSped = keepSpedCb.checked; draw(); });
  const keepSpedBox = el('label', { class: 'ae-check', title: 'Clips with a speed change (time-lapses, fast-forwards) are usually quiet on purpose. With this on, cutting dead air never cuts into them.' }, keepSpedCb, el('span', { text: 'Keep sped-up clips whole when cutting dead air' }));
  // the voice: any effects preset (built in, or one you saved from a track's PRESETS ▾), on the speech tracks
  const voiceSel = el('select', { title: 'Effects put on the speech tracks. Save your own from a track’s ƒx rack: PRESETS ▾ › Save this rack as a preset' },
    el('option', { value: 'none', text: 'Leave the voice as it is' }), ...allChains().map(c => el('option', { value: c.id, text: c.builtin ? `${c.name} — ${c.hint}` : `★ ${c.name} (yours)` })));
  voiceSel.addEventListener('change', () => { o.voice = voiceSel.value; draw(); });
  // the parts of the video to use: sections (X) and the current In–Out
  const regionRow = el('div', { class: 'ae-parts' });
  // REDO ONLY: make just some parts of an edit again (the zooms, the ums with newly taught words…), the rest kept
  let redoOn = false, body = null;
  const redoParts = new Set(Array.isArray(p.redoParts) && p.redoParts.length ? p.redoParts : ['zoom']);
  const redoCb = el('input', { type: 'checkbox' });
  redoCb.addEventListener('change', () => { redoOn = redoCb.checked; draw(); });
  const redoChips = el('div', { class: 'ae-redo-chips' });
  const redoRow = el('div', { class: 'ae-redo' },
    el('label', { class: 'ae-check', title: 'Already auto edited? Make only the parts you pick again, with the settings below. Nothing else changes: not the cuts, the shape, the best moments or anything you did by hand.' },
      redoCb, el('b', { text: 'REDO ONLY SOME PARTS' }), el('span', { class: 'note', text: ' of the edit already made; the rest stays as it is' })),
    redoChips);
  let dlg = null;
  const pickParts = () => { dlg?.close(); if (!app.timeline.marking) app.cmd('keep-part'); };
  const drawParts = () => {
    if (!parts.length) {
      regionRow.replaceChildren(el('div', { class: 'ae-keep-row' },
        el('button', { class: 'hw ae-keep-btn', text: '✚ CLIPS', title: 'Close this and drag across the timeline over each part you want', onclick: pickParts }),
        el('p', { class: 'ae-region off', text: 'Only want some parts of a long video (the first 10 minutes, a bit at 30:00…)? Press this and drag across the timeline over each part, then AUTO EDIT again. It blends them into one edit.' })));
      return;
    }
    const cb = el('input', { type: 'checkbox', checked: useRegion });
    cb.addEventListener('change', () => { useRegion = cb.checked; draw(); });
    const total = parts.reduce((a, q) => a + q.t1 - q.t0, 0);
    regionRow.replaceChildren(
      el('label', { class: 'row' }, cb, el('span', { text: parts.length > 1 ? `Use only these ${parts.length} parts (${fmt(total)} in all), blended into one edit` : `Use only ${fmt(parts[0].t0)} – ${fmt(parts[0].t1)} (${fmt(total)})` })),
      el('div', { class: 'ae-partlist' }, ...parts.map((q, i) => el('span', { class: 'ae-part' + (q.pending ? ' pending' : '') },
        el('b', { text: `PART ${i + 1}` }), ` ${fmt(q.t0)} – ${fmt(q.t1)}${q.pending ? ' (In–Out)' : ''}`,
        el('button', { class: 'mini', text: '×', title: q.pending ? 'Leave out the current In–Out' : 'Remove this section', onclick: () => {
          if (q.pending) app.commit(d => { delete d.range; }); else app.commit(d => { d.sections = (d.sections || []).filter(x => x.id !== q.id); });
          parts = sectionsOf(app.doc); useRegion = parts.length > 0; drawParts(); draw();
        } })))),
      el('div', { class: 'ae-keep-row' }, el('button', { class: 'mini ae-keep-btn', text: '✚ ANOTHER CLIP', title: 'Close this and drag across the timeline over another part', onclick: pickParts }),
        el('small', { class: 'note', text: 'Drag over it on the timeline, then AUTO EDIT again.' })));
  };
  drawParts();
  const fitRow = el('div', { class: 'row ae-row' }, el('label', { text: 'Fill the frame' }), seg('fit', FIT_LEVELS));
  const noteRow = el('div', { class: 'row ae-row', title: 'Clap, then say what should be on screen (“Ingredients: two eggs, a cup of flour and a pinch of salt”). Each clap becomes a note card with what you said, as a list you can edit.' },
    el('label', { text: 'Notes' }), seg('noteSpeech', NOTE_SPEECH));
  const loadRecipe = () => {
    o = { ...recipeDefaults(RECIPES[id]), ...(p.custom?.[id] || {}) };
    if (!SFX_LEVELS[o.sfx]) o.sfx = o.sounds === false ? 'off' : o.sounds ? 'normal' : recipeDefaults(RECIPES[id]).sfx; // settings saved by 1.4.6–1.4.7
    delete o.sounds;
  };
  const draw = () => {
    const r0 = RECIPES[id];
    redoChips.replaceChildren(...REDO_PARTS.map(([k, t]) => el('button', { type: 'button', class: 'ae-chip' + (redoParts.has(k) ? ' on' : ''), text: (redoParts.has(k) ? '✓ ' : '') + t,
      onclick: () => { if (redoParts.has(k)) { if (redoParts.size > 1) redoParts.delete(k); } else redoParts.add(k); draw(); } })));
    redoChips.classList.toggle('hidden', !redoOn);
    body?.classList.toggle('redoing', redoOn);
    const go = dlg?.foot?.querySelector('.ae-go'); if (go) go.textContent = redoOn ? 'REDO THESE PARTS' : 'AUTO EDIT';
    const view = redoOn ? redoSettings(r0, o, [...redoParts]) : null;
    const r = view ? view.r : r0;
    for (const b of cards.children) b.classList.toggle('lit', b.dataset.k === id);
    if (len == null || !r.lengths?.some(([v]) => v === len)) len = r.lengths ? (p.lengths?.[id] ?? r.length) : null;
    lenRow.replaceChildren(...(r.lengths || []).map(([v, t]) => el('button', { type: 'button', class: v === len ? 'on' : '', text: t, onclick: () => { len = v; draw(); } })));
    lenRow.parentElement && (lenRow.parentElement.style.display = r.lengths ? '' : 'none');
    for (const [k, box] of Object.entries(segs)) for (const b of box.children) b.classList.toggle('on', b.dataset.v === o[k]);
    fitRow.style.display = r.format ? '' : 'none';
    noteRow.style.display = o.claps === 'notes' ? '' : 'none';
    if (!NOTE_SPEECH[o.noteSpeech]) o.noteSpeech = 'keep';
    packSel.value = o.pack; packSel.disabled = o.trans === 'off';
    keepSpedCb.checked = o.keepSped !== false; keepSpedBox.style.opacity = o.clean === 'off' ? 0.45 : 1; keepSpedCb.disabled = o.clean === 'off';
    if (!chainById(o.voice)) o.voice = 'none';
    voiceSel.value = o.voice;
    segs.sfx.classList.toggle('dim', o.trans === 'off');
    sfxNote.textContent = o.trans === 'off' ? 'They play with transitions: turn Transitions on to hear them.' : '';
    detail.textContent = r.hint;
    const f = r.format && FORMATS[r.format];
    const many = useRegion && parts.length > 1, within = useRegion && parts.length ? (many ? ' from each part' : ' in that part') : '';
    const O = view ? view.o : o;
    steps.replaceChildren(...[
      redoOn ? `Leave the edit as it is, and make again only: ${REDO_PARTS.filter(([k]) => redoParts.has(k)).map(([, t]) => t.replace(/ \(.*\)$/, '').toLowerCase()).join(', ')}` : null,
      useRegion && parts.length ? `Work only on ${parts.map(q => `${fmt(q.t0)}–${fmt(q.t1)}`).join(', ')}; the rest is set aside` : null,
      O.claps === 'cut' ? 'Find clap signals and cut them out (each leaves a take marker)' : O.claps === 'markers' ? 'Find clap signals and mark them' : O.claps === 'notes' ? `Find clap signals, cut them out, and put what you say after each one on screen as a note card${O.noteSpeech === 'cut' ? ' (the spoken note is cut, so it only shows as text)' : ''}` : null,
      'Listen to the speech (on this Mac)',
      r.highlights ? (many && r.highlights === 1 ? `Pick the best moments${within}, about ${len} s in all, and join them in order` : `Pick the best ${many && r.highlights > 1 ? 'moment from each part (a short each)' : r.highlights > 1 ? `${r.highlights} moments` : 'moment'} of about ${len} s${many ? '' : within}, starting on a strong line`) : (many ? 'Join the parts in order' : null),
      O.clean !== 'off' ? (O.clean === 'tight' ? 'Cut ums and dead air (tight)' : 'Cut ums and tighten long pauses') + (redoOn ? ', with every word you’ve taught Reel so far' : '') + (O.keepSped !== false ? ', leaving sped-up clips whole' : '') : null,
      f ? `Reframe to ${f.w} × ${f.h}${{ blur: ' (whole picture on a blurred copy)', zoom: ' (whole picture on a zoomed copy)', bars: ' (whole picture, black bars)' }[O.fit] || ', cropped, following the action'}` : null,
      O.zoom !== 'off' ? `Smart Zoom, ${ZOOM_LEVELS[O.zoom][0].toLowerCase()}: ${{ punchy: 'quick push-ins and push-outs', follow: 'following the action', kenburns: 'slow Ken Burns drifts' }[O.motion || 'follow']}` : null,
      O.trans !== 'off' ? `${PACKS[O.pack].name} transitions${O.variety === 'wild' ? ', any kind' : O.variety === 'same' ? '' : ', mixed up'}, ${TRANS_LEVELS[O.trans][0].toLowerCase()} (about one every ${transGap(O.trans, !!r.highlights)} s at most)` : null,
      O.trans !== 'off' ? (O.sfx === 'off' ? 'No sound effects' : `Sound effects with the transitions (${SFX_LEVELS[O.sfx][0].toLowerCase()}), on their own Sound FX track`) : null,
      O.captions !== 'off' ? (['spoken', 'both'].includes(O.talk) && O.captions !== 'file' ? 'Captions as a subtitle file (the talking text puts the words in the video)' : { file: 'Captions as a subtitle file (.srt) beside the export', burned: 'Captions in the video', big: 'Big, bold captions in the video' }[O.captions]) : null,
      chainById(O.voice) ? `Voice: ${chainById(O.voice).name} (${chainById(O.voice).chain.map(f => f.type === 'au' ? f.name : ({ declick: 'De-click', deess: 'De-ess', level: 'Auto Level', eq: 'EQ', comp: 'Compressor', gate: 'Noise gate', limiter: 'Limiter', reverb: 'Reverb', delay: 'Delay', gain: 'Gain' })[f.type] || f.type).join(' → ')}) on the speech tracks` : null,
      O.volume === 'even' ? 'Even out the volume: an Auto Level on each track with sound (quiet parts up, loud parts down)' : null,
      (O.gfx || 'off') !== 'off' && !['keywords', 'both'].includes(O.talk) ? `Put the punchy lines on screen as ${{ bold: 'bold kinetic titles (slam, smear, slice), with starbursts and light streaks', clean: 'clean titles with pill, serif and highlighted words', tech: 'tech titles (neon, glitch) with light streaks', mix: 'a mix of every kinetic look (slam, smear, neon, slice, shatter, pills…), with starbursts, light streaks and charts' }[O.gfxLook || 'mix']}, ${O.gfx === 'lots' ? 'often' : 'now and then'}; a chart for a percentage` : null,
      (O.talk || 'off') !== 'off' ? `Talking text: ${{ spoken: 'what you say along the bottom, each word lighting up as you say it', keywords: 'the key words popping up big in the middle (questions, numbers, tips), with an emoji now and then', both: 'what you say along the bottom (each word lighting up as you say it), and the key words popping up big in the middle with an emoji now and then' }[O.talk]}` : null,
      (O.cta || 'off') !== 'off' ? (r.format ? 'A Follow call-out near the end' : `Like · Subscribe · Bell and comment call-outs between sentences${O.cta === 'end' ? ', and an end screen' : ''}`) : null,
      (O.bleep || 'off') !== 'off' ? `${O.bleep === 'mute' ? 'Mute' : 'Bleep'} the swearing (${bleepPrefs().level === 'all' ? 'mild words too' : 'swear words and slurs'}; AUDIO ▾ › Bleep swearing… sets the words); captions show it starred` : null,
      r.chapters ? 'Chapters as markers (they go in the export notes)' : null,
      redoOn && !redoParts.has('voice') ? null : `Loudness set for ${r.loud === 'spotify' ? 'TikTok / Reels' : r.loud === 'podcast' ? 'podcasts' : 'YouTube'}`,
    ].filter(Boolean).map(t => el('li', { text: t })));
  };
  for (const [k, r] of Object.entries(RECIPES)) {
    const b = el('button', { class: 'ae-card', type: 'button', 'data-k': k }, el('i', { class: 'ae-icon', text: r.icon }), el('b', { text: r.name }));
    b.addEventListener('click', () => { id = k; len = null; loadRecipe(); draw(); });
    cards.append(b);
  }
  loadRecipe();
  const row = (label, ...kids) => el('div', { class: 'row ae-row' }, el('label', { text: label }), ...kids);
  body = el('div', { class: 'ae' },
    el('p', { class: 'note', text: 'Pick what you’re making, and how strong each effect should be. Reel watches and listens to your video and edits it for you; you preview the result before you keep it, and everything stays editable.' }),
    redoRow,
    cards,
    el('div', { class: 'ae-cols' },
      el('div', {}, detail,
        regionRow,
        row('Length', lenRow),
        fitRow,
        row('Zooms', seg('zoom', ZOOM_LEVELS)),
        row('Motion', seg('motion', MOTION_STYLES)),
        row('Transitions', seg('trans', TRANS_LEVELS)),
        row('Style', packSel),
        row('Variety', seg('variety', VARIETY_LEVELS)),
        row('Sound effects', seg('sfx', SFX_LEVELS), sfxNote),
        row('Captions', seg('captions', CAPTION_LEVELS)),
        row('Clean up', seg('clean', CLEAN_LEVELS)),
        row('', keepSpedBox),
        row('Claps', seg('claps', CLAP_LEVELS)),
        noteRow,
        row('Voice', voiceSel),
        row('Volume', seg('volume', VOLUME_LEVELS)),
        row('Talking text', seg('talk', TALK_MODES)),
        row('Spoken words', seg('talkLook', TALK_LOOKS)),
        row('Graphics', seg('gfx', GFX_LEVELS)),
        row('Graphics look', seg('gfxLook', GFX_LOOKS)),
        row('Call-outs', seg('cta', CTA_LEVELS)),
        row('Swearing', seg('bleep', BLEEP_LEVELS)),
        row('Language', lang),
        el('button', { class: 'mini ae-reset', text: 'Back to this recipe’s settings', onclick: () => { o = recipeDefaults(RECIPES[id]); draw(); } })),
      el('div', {}, el('div', { class: 'engr', text: 'Reel will' }), steps)));
  draw();
  dlg = modal('Auto Edit', body, [
    { label: 'Cancel', onClick: c => c() },
    { label: 'Auto edit', cls: 'hw amber ae-go', onClick: c => {
      const prev = loadPrefs();
      savePrefs({ ...prev, recipe: id, locale: lang.value, lengths: { ...(prev.lengths || {}), [id]: len }, custom: { ...(prev.custom || {}), [id]: o }, redoParts: [...redoParts] });
      c(); runAutoEdit(app, id, { length: len, locale: lang.value, ...o, regions: useRegion && parts.length ? parts.map(q => ({ t0: q.t0, t1: q.t1 })) : null, redo: redoOn ? [...redoParts] : null });
    } },
  ]);
}

/** Runs a recipe on the open project. */
/** The parts of an edit Auto Edit can redo on their own (REDO ONLY): each one's setting, and what it's called. */
export const REDO_PARTS = [
  ['zoom', 'Zooms & motion'], ['clean', 'Ums & dead air (with the words you’ve taught since)'], ['trans', 'Transitions & their sounds'],
  ['captions', 'Captions'], ['talk', 'Talking text'], ['gfx', 'Graphics'], ['cta', 'Call-outs'], ['voice', 'Voice & volume'], ['bleep', 'Bleeps (swearing)'],
];
/**
 * REDO ONLY: the settings for redoing just these parts of an edit already made. The rest is left alone, and so is
 * what reshapes the edit (the best moments, the new shape, the claps, the parts set aside, the chapters).
 */
export function redoSettings(r, o, parts) {
  const want = new Set(parts);
  const oo = { ...o, regions: null, claps: 'off', redo: [...want] };
  if (!want.has('zoom')) oo.zoom = 'off';
  if (!want.has('clean')) oo.clean = 'off';
  if (!want.has('trans')) oo.trans = 'off';
  if (!want.has('captions')) oo.captions = 'off';
  if (!want.has('talk')) oo.talk = 'off';
  if (!want.has('gfx')) oo.gfx = 'off';
  if (!want.has('cta')) oo.cta = 'off';
  if (!want.has('bleep')) oo.bleep = 'off';
  if (!want.has('voice')) { oo.voice = 'none'; oo.volume = 'off'; }
  return { r: { ...r, highlights: 0, format: null, chapters: false }, o: oo };
}

export async function runAutoEdit(app, recipeId, o) {
  let r = RECIPES[recipeId];
  const token = app.token;
  const redo = Array.isArray(o.redo) && o.redo.length ? new Set(o.redo) : null;
  if (redo) ({ r, o } = redoSettings(r, o, [...redo]));
  if (app._autoEditing) { toast('Auto Edit is already working.'); return; }
  app._autoEditing = true;
  const before = structuredClone(app.doc);
  const list = el('ul', { class: 'ae-steps live' }), bar = el('div', { class: 'progress' }, el('i')), what = el('p', { class: 'note' });
  let stopped = false;
  const halt = new AbortController(); // STOP reaches the step that's working (the zooms, the listening), not just the next one
  const dlg = modal('Auto Edit', el('div', { class: 'ae-run' }, what, bar, list), [{ label: 'Stop', onClick: c => { stopped = true; halt.abort(); c(); } }]);
  const step = text => { for (const li of list.querySelectorAll('li.now')) { li.classList.remove('now'); li.classList.add('done'); } list.append(el('li', { class: 'now', text })); what.textContent = text + '…'; };
  const note = text => list.append(el('li', { class: 'skip', text }));
  let shown = 0; // the bar only goes forward, so its time left doesn't start over between steps
  const progress = v => { shown = Math.max(shown, v); bar.firstChild.style.width = (shown * 100).toFixed(1) + '%'; };
  const alive = () => !stopped && app.token === token && app.doc;
  const report = [];
  const only = o.only || null; // one clip on its own: the rest of the project is set aside, untouched
  try {
    if (only) {
      step('Setting the rest of the project aside');
      restore(app, isolate(app.doc, only.t0, only.t1));
      if (!app.doc.clips.some(c => isVideo(app.doc, c))) { o.zoom = 'off'; o.trans = 'off'; } // sound only
    }
    // 0 · the video: what's on the timeline, or the longest video in the media list
    let doc = app.doc;
    if (!only && !doc.clips.some(c => isVideo(doc, c))) {
      const m = [...doc.media].filter(x => x.kind === 'video').sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];
      app.addMediaClip(m.id, null, 0); doc = app.doc;
    }
    // In to Out: only that part is worked on (the rest is set aside; DISCARD or UNDO brings it back)
    // the parts (sections / In–Out): everything else is set aside, and the parts follow each other in order
    let parts = null;
    if (o.regions?.length) {
      const rs = [...o.regions].sort((a, b) => a.t0 - b.t0);
      step(rs.length > 1 ? `Taking the ${rs.length} parts you marked` : `Working on ${fmt(rs[0].t0)} – ${fmt(rs[0].t1)} only`);
      app.commit(d => {
        const end = docDuration(d), cuts = []; let at = 0;
        for (const q of rs) { if (q.t0 > at + 0.05) cuts.push([at, q.t0]); at = Math.max(at, q.t1); }
        if (end > at + 0.05) cuts.push([at, end]);
        for (const [a, b] of cuts.reverse()) removeRange(d, a, b);
        delete d.range; delete d.sections;
      });
      parts = []; let t = 0;
      for (const q of rs) { parts.push([t, t + (q.t1 - q.t0)]); t += q.t1 - q.t0; }
      report.push(rs.length > 1 ? `${rs.length} parts` : `from ${fmt(rs[0].t0)} – ${fmt(rs[0].t1)}`);
    }
    let joins = parts ? parts.slice(1).map(([a]) => a) : [];
    const noteTimes = []; // clap notes: where each clap was (after the claps were cut out)
    // ½ · clap signals: before anything listens to the words, so the claps don't count as speech
    if ((o.claps || 'off') !== 'off') {
      step('Listening for clap signals');
      const d0 = app.doc;
      const sound = d0.clips.filter(c => { const m = c.type === 'media' && !c.disabled && mediaById(d0, c.media); return m && (m.kind === 'audio' || m.hasAudio); });
      const mics = sound.filter(c => mediaById(d0, c.media).role === 'mic');
      let sigs = [];
      try { sigs = await clapsOnTimeline(app, mics.length ? mics : sound, v => progress(v * 0.02)); }
      catch (e) { note(`Couldn’t listen for claps (${e.message}).`); }
      if (!alive()) return;
      if (!sigs.length) note('No clap signals found');
      else if (o.claps === 'cut' || o.claps === 'notes') {
        app.commit(d => {
          for (const x of [...sigs].reverse()) removeRange(d, x.t0, x.t1);
          let shift = 0;
          for (const x of sigs) { if (o.claps === 'notes') noteTimes.push(x.t0 - shift); else d.markers.push({ id: uid('k'), t: x.t0 - shift, label: '✂ Clap', claps: true }); shift += x.t1 - x.t0; }
          d.markers.sort((a, b) => a.t - b.t);
        });
        // the parts' times move up by what was cut before them
        if (parts) parts = parts.map(([a, b]) => { const before = q => sigs.filter(x => x.t1 <= q).reduce((n, x) => n + x.t1 - x.t0, 0); return [a - before(a), b - before(b)]; });
        if (o.claps !== 'notes') report.push(`${sigs.length} clap signal${sigs.length === 1 ? '' : 's'} cut out (takes in ✂ TAKES)`);
      } else {
        app.commit(d => { for (const x of sigs) if (!(d.markers || []).some(k => Math.abs(k.t - x.t0) < 0.3)) d.markers.push({ id: uid('k'), t: x.t0, end: x.t1, label: '✂ Clap', claps: true }); d.markers.sort((a, b) => a.t - b.t); });
        report.push(`${sigs.length} clap marker${sigs.length === 1 ? '' : 's'}`);
      }
      joins = parts ? parts.slice(1).map(([a]) => a) : [];
    }
    // 1 · speech
    step('Listening to the speech'); progress(0.02);
    let words = [];
    try { words = await timelineWords(app, { locale: o.locale, track: '' }, (t, v) => { what.textContent = t; progress(0.02 + v * 0.25); }); }
    catch (e) { note(`No speech to work from (${e.message}). Going by the picture instead.`); }
    if (!alive()) return;
    // 1½ · clap notes: what was said after each clap goes on screen as a note card
    if (noteTimes.length) {
      step('Putting your notes on screen');
      const r2 = placeClapNotes(app, words, noteTimes, { cutSpeech: o.noteSpeech === 'cut' });
      words = r2.words;
      if (parts && r2.cuts.length) parts = parts.map(([a, b]) => { const before = q => r2.cuts.filter(([, y]) => y <= q).reduce((n, [x, y]) => n + y - x, 0); return [a - before(a), b - before(b)]; });
      joins = parts ? parts.slice(1).map(([a]) => a) : [];
      report.push(`${r2.n} note card${r2.n === 1 ? '' : 's'} from your claps${r2.placeholders ? ` (${r2.placeholders} with nothing said after the clap: type over “Type your note here”)` : ''}`);
    }

    // 2 · best moments
    if (r.highlights) {
      step(r.highlights > 1 ? `Finding the ${r.highlights} best moments` : 'Finding the best moment');
      const total = docDuration(app.doc);
      const ideal = o.length || r.length, length = { min: Math.max(8, ideal * 0.6), ideal, max: Math.max(ideal * 1.25, ideal + 5) };
      if (length.max > 60 && recipeId !== 'podcast') length.max = Math.max(ideal, 60);
      let motion = null;
      if (!words.length) {
        const c = app.doc.clips.filter(x => isVideo(app.doc, x)).sort((a, b) => b.duration - a.duration)[0];
        const res = await analyse(app, c, mediaById(app.doc, c.media), { onProgress: v => progress(0.3 + v * 0.15) });
        motion = res.samples.map(s => ({ t: c.start + s.t, motion: s.motion }));
      }
      if (!alive()) return;
      let hs;
      if (parts && parts.length > 1) {
        // several parts: the best moment of each, sized to the part (one short per part for Several Shorts)
        const sum = parts.reduce((a, [p0, p1]) => a + p1 - p0, 0);
        hs = parts.flatMap(([p0, p1]) => {
          const want = r.highlights > 1 ? ideal : Math.max(6, ideal * (p1 - p0) / sum);
          const lw = words.filter(w => w.t >= p0 && w.end <= p1 + 0.05).map(w => ({ ...w, t: w.t - p0, end: w.end - p0 }));
          const lm = motion && motion.filter(m => m.t >= p0 && m.t < p1).map(m => ({ ...m, t: m.t - p0 }));
          const [h] = pickHighlights({ words: lw, motion: lm, duration: p1 - p0, length: { min: Math.max(4, want * 0.6), ideal: want, max: Math.max(want * 1.3, want + 3) } });
          return h ? [{ ...h, t0: h.t0 + p0, t1: Math.min(p1, h.t1 + p0) }] : [];
        });
      } else hs = pickHighlights({ words, motion, duration: total, length, count: r.highlights });
      hs.sort((a, b) => a.t0 - b.t0);
      if (hs.length && !(hs.length === 1 && hs[0].t0 <= 0.01 && hs[0].t1 >= total - 0.01)) {
        const keep = hs.map(h => [h.t0, h.t1]);
        { let t = 0; joins = keep.slice(0, -1).map(([a, b]) => (t += b - a)); }
        app.commit(d => {
          // remove everything outside the kept stretches, last first
          const cuts = []; let at = 0;
          for (const [a, b] of keep) { if (a > at + 0.05) cuts.push([at, a]); at = b; }
          if (docDuration(d) > at + 0.05) cuts.push([at, docDuration(d)]);
          for (const [a, b] of cuts.reverse()) removeRange(d, a, b);
          if (keep.length > 1 && r.highlights > 1) {
            let t = 0;
            d.markers = (d.markers || []).filter(m => !/^Short \d/.test(m.label || ''));
            keep.forEach(([a, b], i) => { d.markers.push({ id: uid('k'), t, label: `Short ${i + 1}` }); t += b - a; });
            d.range = { in: 0, out: keep[0][1] - keep[0][0] };
          }
        });
        // the words that are left, on the new timeline
        const shift = []; let t = 0;
        for (const [a, b] of keep) { shift.push([a, b, t - a]); t += b - a; }
        words = words.flatMap(w => { const s = shift.find(([a, b]) => w.t >= a && w.end <= b + 0.05); return s ? [{ ...w, t: w.t + s[2], end: w.end + s[2] }] : []; });
        report.push(hs.length > 1 ? `${hs.length} moments of ${keep.map(([a, b]) => Math.round(b - a) + ' s').join(', ')}` : `the best ${Math.round(keep[0][1] - keep[0][0])} s`);
        if (hs[0].text) note(`Opens on: “${hs[0].text.slice(0, 90)}${hs[0].text.length > 90 ? '…' : ''}”`);
      } else report.push('the whole video (it’s already short)');
      progress(0.45);
    }
    if (!alive()) return;

    // where parts meet: kept as temporary markers so later cuts move them along
    if (joins.length) app.commit(d => { d.markers = [...(d.markers || []), ...joins.map(t => ({ id: uid('k'), t, label: '', autoJoin: true }))]; });

    // 4 · vertical
    if (r.format && app.doc.canvas.width > app.doc.canvas.height) {
      step(`Reframing to ${FORMATS[r.format].w} × ${FORMATS[r.format].h}`);
      await app._reframe(FORMATS[r.format], o.fit || r.fit);
      progress(0.65);
    }
    if (!alive()) return;

    // 5 · zooms, planned on the whole take: once the ums are cut out the pieces are mostly too short to zoom
    // in on, so the zooms come first and are cut along with the clips
    const zoomOn = o.zoom !== 'off', pack = o.trans !== 'off' ? o.pack : '';
    const bgTrack = id => /^background$/i.test(app.doc.tracks.find(t => t.id === id)?.name || '');
    if (zoomOn) {
      step('Adding zooms');
      const zids = app.doc.clips.filter(c => isVideo(app.doc, c) && !bgTrack(c.track)).map(c => c.id);
      // the bar moves as each clip is watched (this is the long part on a long recording), so the time left is real
      const z0 = parseFloat(bar.firstChild.style.width) / 100 || 0.27, z1 = Math.max(z0 + 0.05, 0.5);
      const made = await app.smartZoom(zids, { style: o.motion || r.zoom[0], strength: ZOOM_LEVELS[o.zoom][1], quiet: true, fallback: true, signal: halt.signal, onStatus: t => { what.textContent = t + '…'; }, onProgress: f => progress(z0 + (z1 - z0) * f) });
      report.push(made ? `${made} zoom${made === 1 ? '' : 's'}` : 'no zooms (the picture barely moves)');
      progress(0.5);
    }
    if (!alive()) return;

    // 3 · ums and dead air
    if (o.clean !== 'off' && words.length) {
      step('Cutting ums and dead air');
      const fillers = fillerRanges(words);
      app.deck?.tally(fillers.length, 'filler words found by Auto Edit', { done: !umModel() });
      let ranges = [...fillers, ...pauseRanges(words, o.clean === 'tight' ? { longer: 0.45, keep: 0.2 } : { longer: 0.9, keep: 0.35 })];
      // the ums you taught Reel (🎙 in UMS): found in your voice, including the ones speech recognition didn't write
      // down; only the sure matches are cut here
      if (umModel()) {
        try {
          const yours = (await findYourUms(app, speechClips(app.doc, ''), t => { what.textContent = t; })).filter(y => y.sure); // everything you taught Reel: ums, uhs and your own sounds (breaths, sneezes…)
          if (yours.length) { ranges.push(...yours.map(y => ({ t: y.t, end: y.end }))); report.push(`${yours.length} of your ums found by ear`); }
          app.deck?.tally(fillers.length + yours.length, 'filler words found by Auto Edit');
        } catch { app.deck?.tally(fillers.length, 'filler words found by Auto Edit'); /* listening for them failed: the words are still used */ }
      }
      // sped-up clips (time-lapses, fast-forwards) are quiet on purpose: they stay whole
      if (o.keepSped !== false) {
        const sped = app.doc.clips.filter(c => c.type === 'media' && !c.disabled && (c.speed || 1) !== 1).map(c => [c.start, c.start + c.duration]);
        const before = ranges.length;
        if (sped.length) { ranges = withoutSpans(ranges, sped); if (ranges.length < before || sped.length) report.push(`${sped.length} sped-up clip${sped.length === 1 ? '' : 's'} kept whole`); }
      }
      let cut = 0;
      if (ranges.length) app.commit(d => { cut = cutRanges(d, ranges, removeRange); });
      // words after the cuts: listen again (the transcript is cached, so it's quick)
      try { words = await timelineWords(app, { locale: o.locale, track: '' }); } catch { /* keep the old ones */ }
      if (cut > 0.5) report.push(`${cut.toFixed(1)} s of ums and pauses cut`);
      progress(0.6);
    }
    if (!alive()) return;

    // 5½ · transitions and sound effects, on the cuts that are left
    if (pack) {
      step('Adding transitions');
      if (redo) app.commit(d => {
        // the transitions from before go first (on every cut), and the sounds Auto Edit put with them
        for (const t of d.tracks) for (const [a, b] of cutsOn(d, t.id)) {
          if (b.transIn?.type && b.transIn.type !== 'none') { if (OVERLAP_CUTS.has(b.transIn.type) || b.transIn.type === 'text-reveal') { delete a.xfadeOut; delete b.xfadeIn; } a.transOut = { type: 'none', dur: 0.5 }; b.transIn = { type: 'none', dur: 0.5 }; }
        }
        d.clips = d.clips.filter(c => c.style !== 'auto-transitions');
      });
      let ids = app.doc.clips.filter(c => isVideo(app.doc, c) && !bgTrack(c.track)).map(c => c.id);
      // a long single take has no cuts for transitions to sit on: cut it between sentences (nothing is removed),
      // at about the spacing asked for, so the transitions land where the talk changes
      if (pack && words.length) {
        const g = transGap(o.trans, !!r.highlights), total = docDuration(app.doc);
        const existing = new Set();
        for (const id of ids) { const c = app.doc.clips.find(x => x.id === id); existing.add(c.start); existing.add(clipEnd(c)); }
        const near = t => [...existing].some(x => Math.abs(x - t) < Math.min(1.5, g / 2));
        const at = []; let last = 0;
        for (const s of sentences(words)) {
          const t = s.t - 0.05;
          if (t - last >= g && t > 1 && t < total - 1 && !near(t)) { at.push(t); last = t; }
          else if (near(t)) last = Math.max(last, t);
        }
        if (at.length) {
          app.commit(d => { for (const t of at.reverse()) split(d, t, d.clips.filter(c => isVideo(d, c) && !bgTrack(c.track) && c.start < t - 0.1 && clipEnd(c) > t + 0.1).map(c => c.id)); });
          ids = app.doc.clips.filter(c => isVideo(app.doc, c) && !bgTrack(c.track)).map(c => c.id);
        }
      }
      // cutting ums and pauses leaves many small jump cuts: a transition on every one would be too much, so they
      // are spaced out (a few seconds apart on a short, longer on a YouTube video); real shot changes still count
      const gap = transGap(o.trans, !!r.highlights);
      let last = -Infinity;
      joins = (app.doc.markers || []).filter(m => m.autoJoin).map(m => m.t);
      // where two parts meet there is always a transition; elsewhere they're spaced out
      const spaced = (a, b) => { const t = b.start; if (joins.some(j => Math.abs(j - t) < 0.15)) { last = t; return true; } if (t - last < gap) return false; last = t; return true; };
      const sounds = o.sfx !== 'off';
      const sfxBefore = new Set(app.doc.clips.map(c => c.id));
      await autoTransitions(app, pack, { sounds, clipIds: ids, filter: spaced, randomize: (VARIETY_LEVELS[o.variety] || VARIETY_LEVELS.mixed)[1] });
      // the sound effects' level: their track's volume (changeable later on its fader)
      if (sounds) {
        const sfxTracks = new Set(app.doc.clips.filter(c => !sfxBefore.has(c.id)).map(c => c.track).filter(tid => /sound ?fx|sfx/i.test(app.doc.tracks.find(t => t.id === tid)?.name || '')));
        if (sfxTracks.size) { app.commit(d => { for (const t of d.tracks) if (sfxTracks.has(t.id)) { t.volume = SFX_LEVELS[o.sfx][1]; t.muted = false; } }); report.push('sound effects'); }
      }
      progress(0.82);
    }
    if (!alive()) return;

    // 5¾ · swearing: bleeped or muted, and starred in the captions and talking text made after this
    if (redo?.has('bleep') && (o.bleep || 'off') === 'off') app.commit(d => { unbleep(d); d.tracks = d.tracks.filter(t => !t.bleeps || d.clips.some(c => c.track === t.id)); });
    if ((o.bleep || 'off') !== 'off' && words.length) {
      step(o.bleep === 'mute' ? 'Muting the swearing' : 'Bleeping the swearing');
      const bp = { ...bleepPrefs(), mode: o.bleep };
      const b = await bleepWords(app, words, bp);
      if (b.n) report.push(`${b.n} swear word${b.n === 1 ? '' : 's'} ${o.bleep === 'mute' ? 'muted' : 'bleeped'}`);
      words = cleanWords(words, swearOpts(bp));
    }
    if (!alive()) return;
    // 6 · captions
    if (o.captions !== 'off' && words.length) {
      step('Writing captions');
      // the talking text already shows what's said: captions burned in as well would say it twice, so they go in the
      // subtitle file instead (for people who turn subtitles on)
      const spokenOn = (['spoken', 'both'].includes(o.talk) || (redo && app.doc.clips.some(c => c.autoTalk && c.text?.wordTimes))) && !only; // (redoing captions alone: the talking text already there counts)
      const burnIt = o.captions !== 'file' && !spokenOn;
      const big = o.captions === 'big' && burnIt, vertical = app.doc.canvas.height > app.doc.canvas.width;
      const caps = buildCaptions(words, big ? { maxChars: 28, lines: 1, maxDur: 2.4 } : { maxChars: vertical ? 40 : 64, lines: 2 }).map(c => ({ id: uid('cap'), ...c }));
      app.commit(d => {
        d.captions = caps;
        d.captionStyle = { ...(d.captionStyle || {}), burn: burnIt, ...(big ? { size: 78, weight: 800, bgOpacity: 0.6, pos: 'bottom' } : burnIt && o.captions === 'burned' ? { size: vertical ? 52 : 46, weight: 700, bgOpacity: 0.72, pos: 'bottom' } : {}) };
      });
      app.showCaptionLane = true;
      report.push(`${caps.length} captions${spokenOn && o.captions !== 'file' ? ' (as a subtitle file: the talking text shows the words)' : ''}`);
    }

    // 6½ · talking text: the words on screen as they're said (and the key words big), on their own tracks
    const talk = o.talk || 'off';
    if (talk !== 'off' && words.length && !only) {
      step('Putting your words on screen');
      const tall = app.doc.canvas.height > app.doc.canvas.width;
      const plan = planTalkingText(words, docDuration(app.doc), { mode: talk, amount: o.gfx === 'lots' ? 'lots' : 'few', tall });
      let made = null; app.commit(d => { made = placeTalkingText(d, plan, { look: o.talkLook || 'green', tall }); });
      if (made.lines) report.push(`${made.lines} spoken lines`);
      if (made.pops) report.push(`${made.pops} key words`);
    }
    // 7 · motion graphics: the punchy lines as kinetic titles (and a graphic with some), on their own tracks
    // (not when the talking text already puts the key words up: they'd be the same lines twice)
    if ((o.gfx || 'off') !== 'off' && words.length && !only && !(talk === 'keywords' || talk === 'both')) {
      step('Adding motion graphics');
      const total = docDuration(app.doc), tall = app.doc.canvas.height > app.doc.canvas.width;
      const plan = planGraphics(words, total, { amount: o.gfx, look: o.gfxLook || 'bold', tall });
      const n = placeGraphics(app, plan, { tall });
      if (n) report.push(`${n} motion graphic${n === 1 ? '' : 's'}`);
    }

    // 7 · chapters
    // 7¼ · call-outs: reminders between sentences (and an end screen), on their own track
    if ((o.cta || 'off') !== 'off' && !only) {
      step('Adding call-outs');
      const total = docDuration(app.doc), tall = app.doc.canvas.height > app.doc.canvas.width;
      const breaks = sentences(words).map(s => Math.max(0, s.t - 0.1));
      const plan = planCallouts(total, tall
        ? { kinds: ['follow'], every: Math.max(15, total * 0.6), startAfter: Math.max(3, total * 0.6), endScreen: false, tall }
        : { kinds: ['likeSubscribe', 'commentPrompt'], every: total > 900 ? 300 : 180, startAfter: Math.min(60, Math.max(15, total * 0.12)), endScreen: o.cta === 'end', tall }, breaks);
      const n = placeCallouts(app, plan, { tall });
      if (n) report.push(`${n} call-out${n === 1 ? '' : 's'}`);
    }
    if (r.chapters && words.length && !only) {
      let ch = chapters(words, docDuration(app.doc));
      if (ch.length >= 3) {
        step('Marking chapters');
        // with a writer model (Qwen) on this Mac, the chapters get proper names from what's said in each
        if (await writerReady(app)) { what.textContent = 'Naming the chapters (Qwen, on this Mac)…'; ch = await nameChapters(app, words, ch); }
        app.commit(d => { d.markers = [...(d.markers || []).filter(m => !m.autoChapter), ...ch.map(c => ({ id: uid('k'), t: c.t, label: c.label, autoChapter: true }))].sort((a, b) => a.t - b.t); });
        report.push(`${ch.length} chapters`);
      }
    }

    // 7¼ · the voice: the chosen effects preset on each track with speech (microphone, or video with its sound)
    const chosen = chainById(o.voice);
    if (chosen && !only) {
      const d0 = app.doc, isSfx = t => /sound ?fx|sfx|^background$/i.test(t.name || '') || t.role === 'music' || t.role === 'effects';
      const speech = new Set(d0.clips.filter(c => { const m = c.type === 'media' && !c.disabled && !c.audio?.mute && mediaById(d0, c.media); return m && (m.role === 'mic' || (m.kind === 'video' && m.hasAudio && !c.audio?.mute)); }).map(c => c.track));
      let n = 0;
      app.commit(d => { for (const t of d.tracks) if (speech.has(t.id) && !isSfx(t)) { applyChain(t, chosen.chain, () => uid('fx'), { tag: 'autoEdit' }); n++; } });
      if (n) { step(`Voice: ${chosen.name}`); report.push(chosen.name.toLowerCase()); }
    }
    // 7½ · even volume: an Auto Level first in each track that has speech or music (not sound effects)
    if ((o.volume || 'even') === 'even' && !only) { // tracks are shared with the rest of the project
      const isSfx = t => /sound ?fx|sfx|^background$/i.test(t.name || '');
      const withSound = new Set(app.doc.clips.filter(c => c.type === 'media' && !c.disabled && !c.audio?.mute && (mediaById(app.doc, c.media)?.hasAudio || mediaById(app.doc, c.media)?.kind === 'audio')).map(c => c.track));
      let n = 0;
      app.commit(d => { for (const t of d.tracks) if (withSound.has(t.id) && !isSfx(t) && !(t.fx || []).some(f => f.type === 'level')) { t.fx = [{ id: uid('fx'), type: 'level', params: {} }, ...(t.fx || [])]; n++; } });
      if (n) { step('Evening out the volume'); report.push('even volume'); }
    }
    // 8 · loudness (and the temporary join markers go)
    app.commit(d => { if (!only && !(redo && !redo.has('voice'))) masterOf(d).loudness = r.loud; d.markers = (d.markers || []).filter(m => !m.autoJoin); });
    // one clip: put the result back in its place; everything after it moves to fit
    if (only) {
      const was = only.t1 - only.t0, now = docDuration(app.doc);
      restore(app, splice(before, app.doc, only.t0, only.t1));
      report.unshift(`one clip, ${fmt(was)} → ${fmt(now)}`);
    }
    for (const li of list.querySelectorAll('li.now')) { li.classList.remove('now'); li.classList.add('done'); }
    progress(1);
    dlg.close();
    app.renderAll?.(); app.timeline?.fit?.(); app.seek?.(only ? only.t0 : 0);
    const after = app.doc;
    const summary = only ? `Auto Edit, this clip only: ${report.join(' · ')}` : redo ? `Redone: ${REDO_PARTS.filter(([k]) => redo.has(k)).map(([, t]) => t.replace(/ \(.*\)$/, '').toLowerCase()).join(', ')} · ${report.join(' · ') || 'done'}` : `${RECIPES[recipeId].name}: ${report.join(' · ') || 'done'} · ${after.canvas.width} × ${after.canvas.height}, ${fmt(docDuration(after))}`;
    reviewBar(app, { before, summary, recipeId, multi: recipeId === 'multi', at: only ? only.t0 : 0 });
  } catch (e) {
    dlg.close();
    if (app.token === token) modal('Auto Edit stopped', el('p', { text: `Something went wrong: ${e.message}. What it did so far is still on the timeline.` }),
      [{ label: 'Undo Auto Edit', cls: 'hw amber', onClick: c => { c(); restore(app, before); } }, { label: 'Keep what it did', onClick: c => c() }]);
  } finally {
    app._autoEditing = false;
    if (stopped && app.token === token) { restore(app, before); toast('Auto Edit stopped; the project is as it was.'); }
  }
}

/**
 * The result plays straight away in the viewer, with a bar over it: watch it, flip between the auto edit and your
 * original (A/B), change anything by hand (the bar stays out of the way and the whole editor works), then KEEP IT,
 * DISCARD, TRY ANOTHER (back to the original with Auto Edit open again) or EXPORT.
 */
function reviewBar(app, { before, summary, multi, at = 0 }) {
  document.querySelector('.ae-review')?.remove();
  const token = app.token;
  let showing = 'edit', edited = null;
  const play = el('button', { class: 'hw role-add', text: '▶ PLAY', title: 'Play the result from the start (Space plays and pauses too)' });
  const ab = el('div', { class: 'seg ae-ab', title: 'Flip between the auto edit and your original video' },
    el('button', { type: 'button', class: 'on', text: '⚡ AUTO EDIT', 'data-v': 'edit' }), el('button', { type: 'button', text: 'ORIGINAL', 'data-v': 'orig' }));
  const status = el('span', { class: 'ae-rv-sum', text: summary });
  const hint = el('span', { class: 'ae-rv-hint', text: multi ? 'Each short starts at a “Short n” marker. You can edit anything now: drag clips, move zooms, fix a caption.' : 'Watch it, then keep it, or change anything first: trim or move clips, drag zooms, click a caption to fix a word.' });
  const close = () => { bar.remove(); clearInterval(watch); };
  const show = v => {
    if (v === showing) return;
    if (v === 'orig') { edited = structuredClone(app.doc); restore(app, before); }
    else { restore(app, edited); }
    showing = v;
    for (const b of ab.children) b.classList.toggle('on', b.dataset.v === v);
    status.textContent = v === 'orig' ? 'Your original video (nothing changed)' : summary;
    drawSfx();
    app.seek?.(at);
  };
  for (const b of ab.children) b.addEventListener('click', () => show(b.dataset.v));
  play.addEventListener('click', () => { app.seek?.(at); if (!app.player.playing) app.player.toggle(); });
  const keep = el('button', { class: 'hw amber', text: 'KEEP IT', title: 'Keep the auto edit (you can still change anything, and ⌘Z steps back)', onclick: () => { show('edit'); close(); toast('Kept. Everything Auto Edit added can still be changed: clips, zooms, transitions, captions.', 5000); } });
  const discard = el('button', { class: 'hw', text: 'DISCARD', title: 'Throw the auto edit away: back to your original', onclick: () => { app.player.playing && app.player.toggle(); if (showing !== 'orig') restore(app, before); close(); toast('Auto edit discarded: your original is back.'); } });
  const again = el('button', { class: 'hw', text: 'TRY ANOTHER…', title: 'Back to your original, and Auto Edit opens again to try a different recipe or length', onclick: () => { app.player.playing && app.player.toggle(); if (showing !== 'orig') restore(app, before); close(); openAutoEdit(app); } });
  // the sound effects Auto Edit added can be switched off (and on again) right here
  const sfxIds = () => app.doc.tracks.filter(t => /sound ?fx|sfx/i.test(t.name || '') && app.doc.clips.some(c => c.track === t.id)).map(t => t.id);
  const sfxBtn = el('button', { class: 'hw', title: 'Hear the sound effects (whooshes, hits) or not: mutes their Sound FX track' });
  const drawSfx = () => { const ids = sfxIds(); sfxBtn.style.display = ids.length ? '' : 'none'; const on = ids.some(id => !app.doc.tracks.find(t => t.id === id)?.muted); sfxBtn.textContent = on ? '🔊 SOUND FX ON' : '🔇 SOUND FX OFF'; sfxBtn.classList.toggle('lit', on); };
  sfxBtn.addEventListener('click', () => { const ids = sfxIds(), on = ids.some(id => !app.doc.tracks.find(t => t.id === id)?.muted); app.commit(d => { for (const t of d.tracks) if (ids.includes(t.id)) t.muted = on; }); drawSfx(); });
  const exp = el('button', { class: 'hw role-export', text: 'EXPORT…', onclick: () => { show('edit'); close(); app.cmd('export'); } });
  const bar = el('div', { class: 'ae-review' },
    el('div', { class: 'ae-rv-top' }, el('b', { class: 'ae-rv-title', text: '⚡ PREVIEW' }), status,
      el('button', { class: 'ae-rv-min', text: '▴', title: 'Make the bar small so you can see the whole picture (click again to open it)', onclick: e => { const small = bar.classList.toggle('small'); e.currentTarget.textContent = small ? '▾' : '▴'; } })),
    el('div', { class: 'ae-rv-row' }, play, ab, sfxBtn, el('span', { class: 'ae-rv-gap' }), discard, again, exp, keep),
    hint);
  (document.getElementById('stage-wrap') || document.body).append(bar);
  drawSfx();
  // the bar goes if the project closes
  const watch = setInterval(() => { if (app.token !== token || !app.doc) close(); }, 800);
  app.seek?.(at);
  setTimeout(() => { if (!app.player.playing) app.player.toggle(); }, 400);
}

function restore(app, before) {
  app.commit(d => { for (const k of Object.keys(d)) delete d[k]; Object.assign(d, structuredClone(before)); });
  app.renderAll?.(); app.player?.resize?.();
}
const fmt = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

// ------------------------------------------------------------------ one clip on its own
/** The project with only t0..t1 left in it, starting at 0 (what Auto Edit works on for one clip). */
export function isolate(doc, t0, t1) {
  const sub = structuredClone(doc);
  const end = Math.max(docDuration(sub), t1) + 1;
  removeRange(sub, t1, end);
  removeRange(sub, 0, t0);
  delete sub.sections; delete sub.range;
  return sub;
}
/** `full` with t0..t1 replaced by the edited part `sub`; what came after it moves to fit. */
export function splice(full, sub, t0, t1) {
  const out = structuredClone(full);
  removeRange(out, t0, t1);
  const len = docDuration(sub);
  if (len > 0) insertTime(out, t0, len);
  for (const t of sub.tracks) if (!out.tracks.some(x => x.id === t.id)) out.tracks.push(structuredClone(t)); // Sound FX…
  for (const m of sub.media) if (!out.media.some(x => x.id === m.id)) out.media.push(structuredClone(m));
  for (const c of sub.clips) out.clips.push({ ...structuredClone(c), start: c.start + t0 });
  out.markers = [...(out.markers || []), ...(sub.markers || []).map(m => ({ ...m, t: m.t + t0 }))].sort((a, b) => a.t - b.t);
  out.captions = [...(out.captions || []), ...(sub.captions || []).map(cp => ({ ...cp, t: cp.t + t0, end: cp.end + t0 }))].sort((a, b) => a.t - b.t);
  return out;
}

/** Right-click › Auto Edit This Clip: tidy one clip (and its group) without touching the rest of the project. */
export function openClipAutoEdit(app, clipId) {
  const doc = app.doc, ids = withGroups(doc, [clipId]), clips = doc.clips.filter(c => ids.includes(c.id));
  if (!clips.length) return;
  const t0 = Math.min(...clips.map(c => c.start)), t1 = Math.max(...clips.map(c => clipEnd(c)));
  const p = loadPrefs(), saved = p.clip || {};
  const o = { ...recipeDefaults(RECIPES.youtube), volume: 'off', captions: 'off', ...saved };
  const segs = {};
  const seg = (key, levels) => {
    const box = el('div', { class: 'seg ae-seg' });
    const paint = () => { for (const b of box.children) b.classList.toggle('on', b.dataset.v === o[key]); };
    for (const [v, [t]] of Object.entries(levels)) box.append(el('button', { type: 'button', text: t, 'data-v': v, onclick: () => { o[key] = v; paint(); } }));
    segs[key] = box; paint(); return box;
  };
  const lang = el('select', {}, ...LANGS.map(([v, t]) => el('option', { value: v, text: t, selected: v === (p.locale || 'en-US') })));
  const row = (label, ...kids) => el('div', { class: 'row ae-row' }, el('label', { text: label }), ...kids);
  const name = clips.find(c => c.id === clipId)?.name || 'this clip';
  modal('Auto Edit this clip', el('div', { class: 'ae' },
    el('p', { class: 'note', text: `Works on “${name}”${clips.length > 1 ? ` and the ${clips.length - 1} clip${clips.length > 2 ? 's' : ''} grouped with it` : ''} (${fmt(t0)} – ${fmt(t1)}) on its own. The rest of the project isn’t touched; what comes after moves to fit. You can compare and DISCARD it afterwards.` }),
    row('Clean up', seg('clean', CLEAN_LEVELS)),
    row('Zooms', seg('zoom', ZOOM_LEVELS)),
    row('Transitions', seg('trans', TRANS_LEVELS)),
    row('Captions', seg('captions', CAPTION_LEVELS)),
    row('Language', lang)), [
    { label: 'Cancel', onClick: c => c() },
    { label: '⚡ Auto edit this clip', cls: 'hw amber', onClick: c => {
      savePrefs({ ...loadPrefs(), locale: lang.value, clip: { clean: o.clean, zoom: o.zoom, trans: o.trans, captions: o.captions } });
      c(); runAutoEdit(app, 'youtube', { ...o, locale: lang.value, length: null, regions: null, only: { t0, t1 } });
    } },
  ]);
}

/**
 * Puts a motion-graphics plan on the timeline: the titles on a Graphics track at the top, their graphics (starburst,
 * chart, light streak) on a track just under it so they sit behind the words. Replaces graphics placed before.
 */
export function placeGraphics(app, plan, { tall = false } = {}) {
  let n = 0;
  app.commit(d => {
    d.clips = d.clips.filter(c => !c.autoGfx);
    d.tracks = d.tracks.filter(t => !t.gfxTrack || d.clips.some(c => c.track === t.id));
    if (!plan.length) return;
    let fxTr = d.tracks.find(t => t.gfxTrack === 'fx'), tTr = d.tracks.find(t => t.gfxTrack === 'titles');
    if (!fxTr) { fxTr = addTrack(d, 0); fxTr.name = 'Graphics FX'; fxTr.gfxTrack = 'fx'; }
    if (!tTr) { tTr = addTrack(d, 0); tTr.name = 'Graphics'; tTr.gfxTrack = 'titles'; }
    for (const g of plan) {
      const c = newTextClip(tTr.id, g.t, g.text);
      c.duration = g.dur; c.autoGfx = true; c.name = g.text.replace(/[*\n]/g, ' ').trim();
      c.text = { ...c.text, anim: g.anim, accent: g.accent, accentColor: g.anim === 'neon' ? '#ff6a1a' : '#ff2d3c', weight: g.accent === 'serif' || g.accent === 'pill' ? 700 : 900,
        size: tall ? 96 : 110, width: tall ? 0.86 : 0.7, animDur: 0.4, shadow: 18 };
      c.props.y = g.y;
      d.clips.push(c); n++;
      if (g.element && ELEMENTS[g.element]) {
        const home = g.element === 'chart' ? { x: 0.5, y: tall ? 0.62 : 0.6, scale: tall ? 0.7 : 0.55 } : g.element === 'lightStreak' ? { x: 0.5, y: g.y + (tall ? 0.09 : 0.12) } : { ...elementHome(g.element), y: g.y, scale: tall ? 1.1 : 1 };
        const e = newElementClip(fxTr.id, g.t, g.element, home, g.dur);
        e.autoGfx = true; e.name = ELEMENTS[g.element].name;
        if (g.elementText != null) e.element = { ...(e.element || {}), text: g.elementText };
        d.clips.push(e);
      }
    }
    if (!d.clips.some(c => c.track === fxTr.id)) d.tracks = d.tracks.filter(t => t !== fxTr);
  });
  return n;
}
