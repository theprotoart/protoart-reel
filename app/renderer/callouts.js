// CALL-OUTS through a whole video: Like · Subscribe · Bell, a comment prompt, Follow… placed every few minutes
// on their own "Call-outs" track, at pauses in the speech when Reel can hear them, and an end screen to finish.
// For a finished edit (no Auto Edit needed); Auto Edit uses the same planner. Running it again replaces the ones
// it placed before (marked autoCta), so you can try another spacing.
import { el, modal, toast, popMenu } from './ui.js';
import { newElementClip, addTrack, duration as docDuration, uid } from './model.js';
import { ELEMENTS, elementHome } from './lib/elements.js';
import { timelineWords, LANGS } from './transcript.js';
import { sentences } from './lib/highlight.js';
import { openPresetBrowser } from './fxlibrary.js';

export const CTA_KINDS = {
  likeSubscribe: ['Like · Subscribe · Bell', 5],
  likeButton: ['Like', 3],
  subscribe: ['Subscribe', 3.5],
  bell: ['Notification bell', 3.6],
  commentPrompt: ['Comment prompt', 4.5],
  follow: ['Follow (Shorts / TikTok)', 3.2],
};

/**
 * Where the call-outs go: [{ kind, t, dur }]. total: the video's length; breaks: times where a sentence starts
 * (optional). Every `every` seconds from `startAfter`, taking the kinds in turn, each moved to the nearest break
 * within a quarter of the spacing; none in the last stretch, where the end screen (if any) goes.
 */
export function planCallouts(total, { kinds = ['likeSubscribe'], every = 180, startAfter = 30, endScreen = false, tall = false } = {}, breaks = []) {
  const out = [];
  if (!(total > 8) || !kinds.length) return out;
  const endDur = endScreen && !tall && total >= 30 ? Math.min(15, Math.max(5, total * 0.2)) : 0;
  const stopAt = total - Math.max(endDur, 0) - 4;
  const near = t => {
    let best = t, bd = every / 4;
    for (const b of breaks) { const d = Math.abs(b - t); if (d < bd) { bd = d; best = b; } }
    return best;
  };
  const first = Math.min(startAfter, Math.max(3, total * 0.25));
  let i = 0;
  for (let target = first; target < stopAt; target += every, i++) {
    const kind = kinds[i % kinds.length], dur = CTA_KINDS[kind]?.[1] ?? 4;
    const t = Math.max(0, near(target));
    if (t + dur > stopAt + 4) break;
    if (out.length && t < out[out.length - 1].t + out[out.length - 1].dur + 2) continue; // never on top of the last one
    out.push({ kind, t, dur });
  }
  if (endDur) out.push({ kind: 'endCard', t: total - endDur, dur: endDur });
  return out;
}

/** Puts a plan on the Call-outs track (made at the top if needed), replacing call-outs placed before. */
export function placeCallouts(app, plan, { tall = false } = {}) {
  let n = 0;
  app.commit(d => {
    d.clips = d.clips.filter(c => !c.autoCta);
    let tr = d.tracks.find(t => t.ctaTrack);
    if (!tr && plan.length) { tr = addTrack(d, 0); tr.name = 'Call-outs'; tr.ctaTrack = true; }
    for (const p of plan) {
      const home = p.kind === 'endCard' ? { x: 0.5, y: 0.5 } : tall ? { x: 0.5, y: 0.7 } : elementHome(p.kind);
      const c = newElementClip(tr.id, p.t, p.kind, home, p.dur);
      c.name = ELEMENTS[p.kind]?.name || 'Call-out'; c.autoCta = true; c.id = uid('c');
      d.clips.push(c); n++;
    }
    if (tr && !d.clips.some(c => c.track === tr.id)) d.tracks = d.tracks.filter(t => t !== tr);
  });
  return n;
}

/** Sentence starts on the timeline (when the speech can be heard), for placing call-outs between lines. */
async function breaksOf(app, locale) {
  try { return sentences(await timelineWords(app, { locale, track: '' })).map(s => Math.max(0, s.t - 0.1)); } catch { return []; }
}

const PREF = 'reel.calloutPlan';
const load = () => { try { return JSON.parse(localStorage.getItem(PREF) || '{}') || {}; } catch { return {}; } };

/** "Add call-outs through the video…": pick which, how often, an end screen; Reel places them all. */
export function openCalloutPlanner(app) {
  const doc = app.doc; if (!doc) return;
  const total = docDuration(doc);
  if (total < 8) { toast('Put your video on the timeline first: call-outs are spread through it.'); return; }
  const tall = doc.canvas.height > doc.canvas.width;
  const p = { kinds: tall ? ['follow'] : ['likeSubscribe', 'commentPrompt'], every: tall ? 20 : 180, startAfter: tall ? 4 : 30, endScreen: !tall, pauses: true, ...load() };
  const checks = Object.entries(CTA_KINDS).map(([k, [label]]) => {
    const cb = el('input', { type: 'checkbox', checked: p.kinds.includes(k) });
    cb.addEventListener('change', () => { p.kinds = cb.checked ? [...new Set([...p.kinds, k])] : p.kinds.filter(x => x !== k); draw(); });
    return el('label', { class: 'row cta-kind' }, cb, el('span', { text: label }));
  });
  const opts = tall ? [[10, '10 s'], [15, '15 s'], [20, '20 s'], [30, '30 s'], [45, '45 s']] : [[60, '1 min'], [120, '2 min'], [180, '3 min'], [300, '5 min'], [600, '10 min']];
  const every = el('select', {}, ...opts.map(([v, t]) => el('option', { value: v, text: `Every ${t}`, selected: Number(p.every) === v })));
  if (!opts.some(([v]) => v === Number(p.every))) every.value = String(opts[tall ? 2 : 2][0]);
  const start = el('select', {}, ...[[3, '3 s'], [10, '10 s'], [30, '30 s'], [60, '1 min'], [120, '2 min']].map(([v, t]) => el('option', { value: v, text: `First one after ${t}`, selected: Number(p.startAfter) === v })));
  const end = el('input', { type: 'checkbox', checked: !!p.endScreen, disabled: tall });
  const pauses = el('input', { type: 'checkbox', checked: p.pauses !== false });
  const lang = el('select', {}, ...LANGS.map(([v, t]) => el('option', { value: v, text: t, selected: v === (p.locale || 'en-US') })));
  const summary = el('p', { class: 'note' });
  const read = () => { p.every = Number(every.value); p.startAfter = Number(start.value); p.endScreen = end.checked && !tall; p.pauses = pauses.checked; p.locale = lang.value; };
  const draw = () => {
    read();
    const plan = planCallouts(total, p);
    const mid = plan.filter(x => x.kind !== 'endCard').length;
    summary.textContent = plan.length ? `${mid} call-out${mid === 1 ? '' : 's'} through the ${Math.round(total / 60) || '<1'}-minute video${plan.some(x => x.kind === 'endCard') ? ', and an end screen' : ''}. They go on a Call-outs track at the top: move, change or delete any of them afterwards. Running this again replaces them.` : 'Tick at least one call-out (or the end screen).';
  };
  for (const x of [every, start, end, pauses, lang]) x.addEventListener('change', draw);
  draw();
  const had = doc.clips.filter(c => c.autoCta).length;
  modal('Add call-outs through the video', el('div', { class: 'cta-plan' },
    el('p', { class: 'note', text: 'For a finished video: Reel spreads the call-outs you pick through it, so you don’t have to place them one by one.' }),
    el('div', { class: 'engr', text: 'Which (taken in turn)' }), ...checks,
    el('div', { class: 'row' }, every, start),
    tall ? el('p', { class: 'note', text: 'Vertical video: an end screen isn’t used on Shorts / TikTok.' }) : el('label', { class: 'row' }, end, el('span', { text: 'End screen at the end (Thanks for watching · Watch next · Subscribe)' })),
    el('label', { class: 'row' }, pauses, el('span', { text: 'Place them between sentences (Reel listens to the speech first)' }), lang),
    summary), [
    had ? { label: `Remove the ${had}`, onClick: c => { c(); placeCallouts(app, []); toast('Call-outs removed.'); } } : null,
    { label: 'Cancel', onClick: c => c() },
    { label: 'Add call-outs', cls: 'hw amber', onClick: async c => {
      read();
      try { localStorage.setItem(PREF, JSON.stringify(p)); } catch { /* fine */ }
      c();
      let breaks = [];
      if (p.pauses) { toast('Listening for pauses between sentences…', 3000); breaks = await breaksOf(app, p.locale); }
      const plan = planCallouts(docDuration(app.doc), p, breaks);
      const n = placeCallouts(app, plan, { tall });
      toast(n ? `Added ${n} call-out${n === 1 ? '' : 's'} on the Call-outs track${breaks.length ? ', between sentences' : ''}. ⌘Z undoes it.` : 'Nothing to add: the video is too short for that spacing.', 5000);
    } },
  ].filter(Boolean));
}

/** The 👍 CALL-OUTS key: one at the playhead, or spread through the whole video. */
export function calloutsMenu(app) {
  // the CALL-OUTS key lives in EFFECTS ▾ now: open by whichever of the two is on screen
  const vis = n => n && n.getBoundingClientRect().width > 0;
  const own = document.querySelector('#toolstrip .cta-btn'), grp = own?.closest('.tgroup')?.querySelector('.tgroup-btn');
  const b = vis(own) ? own : vis(grp) ? grp : null, r = b ? b.getBoundingClientRect() : { left: 200, bottom: 200 };
  popMenu(r.left, r.bottom + 4, [
    ['Add one at the playhead… (Like, Subscribe, Follow, lower thirds, arrows…)', () => openPresetBrowser(app, 'element')],
    ['Add call-outs through the whole video…', () => openCalloutPlanner(app)],
    app.doc?.clips.some(c => c.autoCta) ? ['Remove the call-outs Reel placed', () => { placeCallouts(app, []); toast('Call-outs removed.'); }] : null,
  ]);
}
