// 💬 UMS: lists the "um"s, "uh"s and other fillers in the speech, like TAKES lists takes. Listen to each one,
// switch CUT / KEEP, remove one now with 🗑, or REMOVE every one marked CUT in one go (⌘Z brings them back).
// The list is kept in the project (doc.ums) and follows the edit as you cut.
import { el, toast, dragBy } from './ui.js';
import { removeRange, mediaById, uid } from './model.js';
import { mergeRanges } from './lib/words.js';
import { findUms, levelOnTimeline } from './lib/ums.js';
import { timelineWords, speechClips, speechPrefs, saveSpeechPrefs, trackSelect, LANGS } from './transcript.js';
import { peaksFor } from './peaks.js';
import { umModel, teachUms, findYourUms, teachFromTimeline, notAnUm } from './umvoice.js';

// the words on the timeline as last heard (the transcript is cached, so getting them again is quick): each um is
// shown in its sentence, the words either side, so you can tell what was picked up without playing it
let ctxWords = null, ctxLoading = false, ctxSig = '';
// the words move when the edit does: heard again (from the cache) after a cut or a move
const layoutSig = doc => (doc?.clips || []).map(c => `${c.id}:${c.start}:${c.in || 0}:${c.duration}:${c.speed || 1}`).join('|');
/** The words just before and after t..end (up to 6 each side, within 4 s), and the ones inside it. */
export function contextOf(words, t, end) {
  const before = [], inside = [], after = [];
  for (const w of words) {
    if (w.end <= t + 0.03) { if (w.t >= t - 4) before.push(w.text); }
    else if (w.t >= end - 0.03) { if (w.t <= end + 4 && after.length < 6) after.push(w.text); }
    else inside.push(w.text);
  }
  return { before: before.slice(-6).join(' '), inside: inside.join(' '), after: after.join(' ') };
}

const fmt = t => { const m = Math.floor(t / 60), s = t % 60; return `${m}:${s.toFixed(1).padStart(4, '0')}`; };
const umsOf = doc => (doc?.ums || []).slice().sort((a, b) => a.t - b.t);
export const umCount = doc => umsOf(doc).filter(u => u.cut).length;

/** The kind of an um, for the filters: um / uh, like / you know, a sound between words, your trained voice, a word you looked for. */
export const catOf = u => u.cat || (u.kind === 'sound' ? 'sound' : u.kind === 'voice' ? 'voice' : u.kind === 'find' ? 'find' : u.cut ? 'um' : 'phrase');
const CATS = [['all', 'All'], ['um', 'Um · uh'], ['phrase', 'Like · you know'], ['voice', 'Taught'], ['sound', 'Sounds']];

/**
 * Listens to the speech and replaces the project's list of ums (words you looked for stay). With ums you taught
 * Reel (🎙), it also listens for those in your voice, and the guessed "sounds between words" are left out.
 */
async function listen(app, { locale, track }, onStatus) {
  app.deck?.tally(0, 'filler words found', { done: false });
  const words = await timelineWords(app, { locale, track }, onStatus);
  ctxWords = words; ctxSig = layoutSig(app.doc);
  onStatus?.('Looking for ums between the words…', 1);
  const clips = speechClips(app.doc, track);
  const trained = !!umModel();
  let found = [];
  if (trained) {
    const heard = findUms(words, null);
    app.deck?.tally(heard.length, 'filler words found', { done: false });
    const yours = await findYourUms(app, clips, onStatus);
    found = [...heard, ...yours.filter(y => !heard.some(h => h.t < y.end && h.end > y.t)).map(y => ({ t: y.t, end: y.end, text: y.word === 'umm' ? 'um' : y.word, kind: 'voice', cut: y.sure }))]; // every sound you taught (ums, breaths, sneezes…) is marked CUT when Reel is sure
  } else {
    const sources = await Promise.all(clips.map(async clip => ({ clip, peaks: await peaksFor(app, mediaById(app.doc, clip.media)).catch(() => null) })));
    found = findUms(words, levelOnTimeline(sources));
  }
  const trackAt = t => clips.find(c => t >= c.start - 0.01 && t < c.start + c.duration)?.track;
  found = found.sort((a, b) => a.t - b.t).map(u => ({ id: uid('um'), t: +u.t.toFixed(3), end: +u.end.toFixed(3), text: u.text, kind: u.kind, cut: u.cut, track: trackAt(u.t) }));
  app.commit(d => { d.ums = [...found, ...(d.ums || []).filter(u => u.kind === 'find')]; });
  app.deck?.tally(found.length, 'filler words found');
  return found;
}

/** Every time a word (or a few words) is said, added to the list to keep or cut (CUT off at first). */
async function findWord(app, { locale, track }, query) {
  const q = query.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!q.length) return [];
  const words = await timelineWords(app, { locale, track });
  ctxWords = words; ctxSig = layoutSig(app.doc);
  const norm = w => String(w.text).toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');
  const clips = speechClips(app.doc, track);
  const trackAt = t => clips.find(c => t >= c.start - 0.01 && t < c.start + c.duration)?.track;
  const hits = [];
  for (let i = 0; i + q.length <= words.length; i++) {
    if (!q.every((x, k) => norm(words[i + k]) === x)) continue;
    const a = words[i], b = words[i + q.length - 1], next = words[i + q.length];
    hits.push({ id: uid('um'), t: +a.t.toFixed(3), end: +(b.end + (next ? Math.max(0, Math.min(0.1, (next.t - b.end) / 2)) : 0.05)).toFixed(3), text: q.join(' '), kind: 'find', cut: false, track: trackAt(a.t) });
  }
  app.commit(d => { d.ums = [...(d.ums || []).filter(u => !(u.kind === 'find' && u.text === q.join(' '))), ...hits].sort((x, y) => x.t - y.t); });
  return hits;
}

let panel = null;
export function openUms(app) {
  if (panel) { panel.refresh(true); panel.root.classList.add('flash'); setTimeout(() => panel?.root.classList.remove('flash'), 600); return; }
  const doc = app.doc; if (!doc) return;
  const p = speechPrefs();
  const lang = el('select', { title: 'Language spoken' }, ...LANGS.map(([v, t]) => el('option', { value: v, text: t, selected: v === p.locale })));
  const track = trackSelect(doc, p.track);
  track.title = 'Which track to listen to';
  const list = el('div', { class: 'takes-list ums-list' });
  const status = el('p', { class: 'note ums-status', text: '' });
  const listenBtn = el('button', { class: 'hw', text: '👂 LISTEN FOR FILLERS', title: 'Listen to the speech and list every um, uh and filler (the first time takes a little while; it runs on this Mac)' });
  const removeBtn = el('button', { class: 'hw amber', text: 'REMOVE' });
  const markBtn = el('button', { class: 'hw', text: '🏷 MARK', title: 'Put a marker on each one shown instead of cutting (to edit by hand). Click again to take the um markers off' });
  const allBtn = el('button', { class: 'mini ums-all', text: 'ALL CUT', title: 'Mark every one shown CUT (click again to KEEP them)' });
  // what's shown: a kind (or a word you looked for), the chosen track, and the selected clip
  let filter = 'all';
  const chips = el('div', { class: 'ums-chips' });
  const onlySel = el('input', { type: 'checkbox', checked: true });
  const selRow = el('label', { class: 'ums-sel', title: 'Show only the ums inside the clips selected on the timeline' }, onlySel, el('span', { text: 'Only the selected clip' }));
  const findIn = el('input', { type: 'search', placeholder: 'Find a word: the, like, so…', title: 'Every time this word (or these words) is said, added to the list to keep or cut' });
  const findBtn = el('button', { class: 'mini', text: 'FIND' });
  const teachBtn = el('button', { class: 'mini ums-teach' });
  const drawTeach = () => {
    const m = umModel();
    teachBtn.textContent = m ? '🎙 YOUR UMS ✓' : '🎙 TEACH REEL YOUR UMS';
    teachBtn.title = m ? `Reel knows your ${m.words.map(w => w.word).join(' and ')}: LISTEN AGAIN finds them in your voice. Click to record them again or forget them.` : 'Record your um and uh a few times: Reel learns them in your voice and finds them (even the ones speech recognition leaves out), here and in AUTO EDIT';
  };
  teachBtn.addEventListener('click', () => teachUms(app, { onDone: () => { drawTeach(); refresh(true); } }));
  drawTeach();
  const root = el('div', { class: 'vo-panel takes-panel ums-panel' },
    el('div', { class: 'vo-head' }, el('b', { text: '💬 FILLER WORDS' }), el('span', { class: 'spacer' }), el('button', { class: 'mini', text: '×', title: 'Close', onclick: () => close() })),
    el('p', { class: 'note takes-how' },
      el('b', { text: 'Ums, uhs, filler words and the sounds you taught Reel. ' }),
      'Reel lists them here. Um and uh are marked CUT; "like", "you know" and sounds are marked KEEP: play them first. 🗑 removes one now; REMOVE cuts the ones shown marked CUT.'),
    el('div', { class: 'row ums-opts' }, lang, track),
    el('div', { class: 'row ums-find' }, findIn, findBtn),
    el('div', { class: 'row ums-teach-row' }, teachBtn),
    chips, selRow,
    list, status,
    el('div', { class: 'takes-foot' }, listenBtn, markBtn, removeBtn));
  document.body.append(root);
  dragBy(root, root.querySelector('.vo-head'));

  let sig = '', busy = false;
  const cutOne = u => {
    let d = 0;
    app.commit(dd => { d = removeRange(dd, u.t, u.end); dd.ums = (dd.ums || []).filter(x => x.id !== u.id); });
    toast(`Removed “${u.text}” (${d.toFixed(2)} s). ⌘Z brings it back.`, 3000);
    const left = umsOf(app.doc).filter(x => x.kind !== 'find').length;
    app.deck?.tally(left, 'fillers left', { from: left + 1 }); // the counter rolls back one
    refresh(true);
  };
  // the ones shown: the kind picked, the track chosen, and the selected clip(s) when that's ticked
  const selClips = () => app.selection.clips.map(id => app.doc.clips.find(c => c.id === id)).filter(Boolean);
  const shownOf = ums => {
    const sel = onlySel.checked ? selClips() : [];
    return ums.filter(u => (filter === 'all' ? catOf(u) !== 'find' : filter.startsWith('find:') ? catOf(u) === 'find' && u.text === filter.slice(5) : catOf(u) === filter)
      && (!track.value || !u.track || u.track === track.value)
      && (!sel.length || sel.some(c => u.t >= c.start - 0.01 && u.t < c.start + c.duration)));
  };
  const refresh = (force = false) => {
    if (!app.doc) { close(); return; }
    const all = umsOf(app.doc);
    const selIds = onlySel.checked ? app.selection.clips.join() : '';
    const now = JSON.stringify(all.map(u => [u.id, u.t, u.cut])) + busy + filter + track.value + selIds + onlySel.checked + !!umModel();
    if (!force && now === sig) return;
    sig = now;
    let ums = shownOf(all);
    if (!ums.length && all.length && (filter !== 'all' || track.value || onlySel.checked)) {
      // what was found would all be hidden by the filter, track or selected clip: show everything instead
      filter = 'all'; track.value = ''; onlySel.checked = false; ums = shownOf(all);
    }
    if (!ums.length && all.length) ums = all; // only words you looked for: show those
    selRow.classList.toggle('hidden', !app.selection.clips.length);
    // the filter chips, with how many of each (in this track and clip)
    const counts = {};
    const inScope = all.filter(u => (!track.value || !u.track || u.track === track.value) && (!onlySel.checked || !selClips().length || selClips().some(c => u.t >= c.start - 0.01 && u.t < c.start + c.duration)));
    for (const u of inScope) { const k = catOf(u) === 'find' ? 'find:' + u.text : catOf(u); counts[k] = (counts[k] || 0) + 1; }
    counts.all = inScope.filter(u => catOf(u) !== 'find').length;
    const finds = [...new Set(inScope.filter(u => catOf(u) === 'find').map(u => u.text))];
    chips.replaceChildren(...[...CATS.filter(([k]) => k === 'all' || counts[k]), ...finds.map(w => ['find:' + w, `“${w}”`])].map(([k, label]) =>
      el('button', { class: 'ums-chip' + (filter === k ? ' on' : ''), title: k.startsWith('find:') ? 'Every time this is said · right-click to take it off the list' : '', onclick: () => { filter = k; refresh(true); },
        oncontextmenu: k.startsWith('find:') ? e => { e.preventDefault(); app.commit(d => { d.ums = (d.ums || []).filter(u => !(u.kind === 'find' && u.text === k.slice(5))); }); if (filter === k) filter = 'all'; refresh(true); } : null },
        el('span', { text: label }), el('i', { text: String(counts[k] || 0) }))));
    if (filter !== 'all' && !counts[filter]) { filter = 'all'; return refresh(true); }
    const n = ums.filter(u => u.cut).length;
    removeBtn.textContent = n ? `REMOVE ${n}` : 'REMOVE';
    const marked = (app.doc.markers || []).filter(k => k.ums).length;
    markBtn.textContent = marked ? `🏷 UNMARK ${marked}` : ums.length ? `🏷 MARK ${ums.length}` : '🏷 MARK';
    markBtn.disabled = busy || (!marked && !ums.length);
    removeBtn.title = n ? `Cut the ${n} shown marked CUT and close the gaps (⌘Z undoes)` : 'Mark some CUT first';
    removeBtn.disabled = !n || busy;
    listenBtn.disabled = busy;
    listenBtn.textContent = app.doc.ums ? '👂 LISTEN AGAIN' : '👂 LISTEN FOR FILLERS';
    allBtn.textContent = ums.length && ums.every(u => u.cut) ? 'ALL KEEP' : 'ALL CUT';
    if (!app.doc.ums) { list.replaceChildren(el('p', { class: 'takes-empty', text: 'Press LISTEN FOR FILLERS. Reel listens to the speech on the track you choose and lists every um, uh and filler it hears. 🎙 TEACH REEL YOUR UMS first and it finds them in your voice too.' })); return; }
    if (!ums.length) { list.replaceChildren(el('p', { class: 'takes-empty', text: all.length ? 'None here: pick another filter, track or clip.' : 'No ums found. Nice and clean.' })); return; }
    // the words around each one: fetched once (from the cached transcript), then the list is drawn again with them
    if (ctxWords && ctxSig !== layoutSig(app.doc)) ctxWords = null;
    if (!ctxWords && !ctxLoading) {
      ctxLoading = true;
      const sigNow = layoutSig(app.doc);
      timelineWords(app, { locale: lang.value, track: '' }).then(w => { ctxWords = w; ctxSig = sigNow; }, () => { ctxWords = []; ctxSig = sigNow; }).finally(() => { ctxLoading = false; refresh(true); });
    }
    list.replaceChildren(
      el('div', { class: 'engr takes-rec ums-sum' }, el('span', { text: `${ums.length} shown · ${n} marked CUT` }), allBtn),
      ...ums.map(u => {
        const cat = catOf(u);
        const play = el('button', { class: 'mini', text: '▶', title: 'Play it with a second either side', onclick: () => { app.seek(Math.max(0, u.t - 1)); if (!app.player.playing) app.player.toggle(); stopAt(u.end + 0.8); } });
        const toggle = el('button', { class: 'take-state ' + (u.cut ? 'drop' : 'keep'), text: u.cut ? 'CUT' : 'KEEP', title: u.cut ? 'Cut when you press REMOVE. Click to keep it' : 'Kept. Click to cut it when you press REMOVE', onclick: () => {
          app.commit(d => { const k = (d.ums || []).find(x => x.id === u.id); if (k) k.cut = !k.cut; });
          refresh(true);
        } });
        const del = el('button', { class: 'mini ums-del', text: '🗑', title: 'Remove this one now (closes the gap)', onclick: () => cutOne(u) });
        // teach Reel from this one (anyone's voice, a guest's too), or tell it a match isn't an um
        const teach = cat === 'voice'
          ? el('button', { class: 'mini ums-learn', text: '✗', title: 'Not an um: Reel won’t match this (or anything like it) again, and it comes off the list', onclick: async () => {
              try { await notAnUm(app, u.t, u.end, u.track || ''); app.commit(d => { d.ums = (d.ums || []).filter(x => x.id !== u.id); }); toast('Got it: that isn’t an um.'); } catch (e) { toast(e.message); }
            } })
          : cat !== 'find' ? el('button', { class: 'mini ums-learn', text: '✦', title: 'Teach Reel this is an um (in this voice, a guest’s too): LISTEN AGAIN then finds others like it', onclick: async () => {
              try { const m = await teachFromTimeline(app, u.t, u.end, cat === 'sound' ? 'umm' : u.text, u.track || ''); drawTeach(); toast(`Learned it. Reel now knows ${m.words.map(w => `${w.prints.length} ${w.word}`).join(', ')}; LISTEN AGAIN to find more like it.`, 5000); } catch (e) { toast(e.message); }
            } }) : null;
        const name = cat === 'sound' ? '(sound)' : cat === 'voice' ? `${u.text} ✦` : `“${u.text}”`;
        const tip = cat === 'sound' ? 'A short sound between words: often an um the speech recogniser left out. Play it to check.' : cat === 'voice' ? 'Sounds like the ums you taught Reel (in your voice)' : cat === 'find' ? 'A word you looked for' : 'Heard as a word';
        // the sentence it was said in: the words either side, the picked-up part lit
        const cx = ctxWords?.length ? contextOf(ctxWords, u.t, u.end) : null;
        const said = cx && (cx.inside || (cat === 'sound' || cat === 'voice' ? '(sound)' : u.text));
        const ctx = cx && (cx.before || cx.after || cx.inside) ? el('div', { class: 'ums-ctx', title: 'What was said around it (click to go there)', onclick: () => app.seek(Math.max(0, u.t - 1)) },
          cx.before ? el('span', { class: 'ums-ctx-side', text: '…' + cx.before + ' ' }) : null,
          el('mark', { text: said }),
          cx.after ? el('span', { class: 'ums-ctx-side', text: ' ' + cx.after + '…' }) : null) : null;
        return el('div', { class: 'take-row ums-row' + (u.cut ? ' dropped' : '') + (cat === 'sound' ? ' ums-sound' : '') + (cat === 'voice' ? ' ums-voice' : '') }, play,
          el('span', { class: 'take-name', text: name, title: tip }),
          el('span', { class: 'take-time', text: `${fmt(u.t)} · ${(u.end - u.t).toFixed(1)} s`, onclick: () => app.seek(u.t), title: 'Go there' }),
          toggle, teach, del, ctx);
      }));
  };
  track.addEventListener('change', () => { saveSpeechPrefs({ ...speechPrefs(), track: track.value }); refresh(true); });
  onlySel.addEventListener('change', () => refresh(true));
  const doFind = async () => {
    const q = findIn.value.trim();
    if (!q || busy) return;
    busy = true; refresh(true); status.textContent = `Looking for “${q}”…`;
    try {
      const hits = await findWord(app, { locale: lang.value, track: track.value }, q);
      filter = hits.length ? 'find:' + hits[0].text : filter;
      status.textContent = hits.length ? `“${hits[0].text}” is said ${hits.length} time${hits.length === 1 ? '' : 's'}. Mark the ones to cut, then REMOVE.` : `“${q}” isn’t said here.`;
    } catch (e) { status.textContent = e.message; }
    finally { busy = false; refresh(true); }
  };
  findBtn.addEventListener('click', doFind);
  findIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doFind(); } });
  let stopTimer = null;
  const stopAt = t1 => {
    clearInterval(stopTimer);
    stopTimer = setInterval(() => { if (!app.player.playing) { clearInterval(stopTimer); return; } if (app.player.time >= t1) { app.player.toggle(); clearInterval(stopTimer); } }, 40);
  };
  allBtn.addEventListener('click', () => {
    const shown = new Set(shownOf(umsOf(app.doc)).map(u => u.id));
    const to = !shownOf(umsOf(app.doc)).every(u => u.cut);
    app.commit(d => { for (const u of d.ums || []) if (shown.has(u.id)) u.cut = to; });
    refresh(true);
  });
  markBtn.addEventListener('click', () => {
    const marked = (app.doc.markers || []).filter(k => k.ums).length;
    if (marked) { app.commit(d => { d.markers = (d.markers || []).filter(k => !k.ums); }); toast(`Took off ${marked} um markers.`); refresh(true); return; }
    const shown = shownOf(umsOf(app.doc));
    app.commit(d => {
      d.markers ||= [];
      for (const u of shown) d.markers.push({ id: uid('k'), t: u.t, end: u.end, label: catOf(u) === 'sound' ? '💬 (sound)' : `💬 ${u.text}`, ums: true });
      d.markers.sort((a, b) => a.t - b.t);
    });
    toast(`Marked ${shown.length} on the ruler, to edit by hand. They aren’t chapters (they stay out of Export’s chapter list).`, 5000);
    refresh(true);
  });
  removeBtn.addEventListener('click', () => {
    const cuts = shownOf(umsOf(app.doc)).filter(u => u.cut);
    if (!cuts.length) return;
    const ids = new Set(cuts.map(u => u.id));
    let total = 0;
    app.commit(d => {
      for (const r of mergeRanges(cuts).reverse()) total += removeRange(d, r.t, r.end);
      d.ums = (d.ums || []).filter(u => !ids.has(u.id));
    });
    const left = umsOf(app.doc).filter(x => x.kind !== 'find').length;
    app.deck?.tally(left, 'fillers left', { from: left + cuts.length }); // rolls back down as they go
    toast(`Removed ${cuts.length} (${total.toFixed(1)} s). ⌘Z brings them back.`, 5000);
    refresh(true);
  });
  listenBtn.addEventListener('click', async () => {
    if (busy) return;
    busy = true; refresh(true);
    saveSpeechPrefs({ ...speechPrefs(), locale: lang.value, track: track.value });
    try {
      const found = await listen(app, { locale: lang.value, track: track.value }, t => { status.textContent = t; });
      const n = found.filter(u => u.cut).length;
      status.textContent = found.length ? `${found.length} found, ${n} marked CUT.${umModel() ? '' : ' 🎙 Teach Reel your ums to find the ones it can’t hear as words.'}` : '';
    } catch (e) { status.textContent = e.message; app.deck?.untally(); }
    finally { busy = false; refresh(true); }
  });
  const timer = setInterval(() => refresh(), 700);
  const close = () => { clearInterval(timer); clearInterval(stopTimer); root.remove(); panel = null; };
  panel = { root, refresh, close, drawTeach };
  refresh(true);
}
export function closeUms() { panel?.close(); }
/** Redraws the Ums panel if it's open (after you teach Reel your ums elsewhere). */
export function refreshUms() { panel?.refresh(true); panel?.drawTeach?.(); }
