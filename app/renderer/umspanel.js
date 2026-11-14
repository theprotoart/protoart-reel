// 💬 UMS: lists the "um"s, "uh"s and other fillers in the speech, like TAKES lists takes. Listen to each one,
// switch CUT / KEEP, remove one now with 🗑, or REMOVE every one marked CUT in one go (⌘Z brings them back).
// The list is kept in the project (doc.ums) and follows the edit as you cut.
import { el, toast, dragBy } from './ui.js';
import { removeRange, mediaById, uid } from './model.js';
import { mergeRanges } from './lib/words.js';
import { findUms, levelOnTimeline } from './lib/ums.js';
import { timelineWords, speechClips, speechPrefs, saveSpeechPrefs, trackSelect, LANGS } from './transcript.js';
import { peaksFor } from './peaks.js';

const fmt = t => { const m = Math.floor(t / 60), s = t % 60; return `${m}:${s.toFixed(1).padStart(4, '0')}`; };
const umsOf = doc => (doc?.ums || []).slice().sort((a, b) => a.t - b.t);
export const umCount = doc => umsOf(doc).filter(u => u.cut).length;

/** Listens to the speech and replaces the project's list of ums. Returns how many were found. */
async function listen(app, { locale, track }, onStatus) {
  const words = await timelineWords(app, { locale, track }, onStatus);
  onStatus?.('Looking for ums between the words…', 1);
  const clips = speechClips(app.doc, track);
  const sources = await Promise.all(clips.map(async clip => ({ clip, peaks: await peaksFor(app, mediaById(app.doc, clip.media)).catch(() => null) })));
  const to = Math.max(0, ...clips.map(c => c.start + c.duration));
  const found = findUms(words, levelOnTimeline(sources), { from: Math.min(...clips.map(c => c.start)), to })
    .map(u => ({ id: uid('um'), t: +u.t.toFixed(3), end: +u.end.toFixed(3), text: u.text, kind: u.kind, cut: u.cut }));
  app.commit(d => { d.ums = found; });
  return found;
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
  const listenBtn = el('button', { class: 'hw', text: '👂 LISTEN FOR UMS', title: 'Listen to the speech and list every um, uh and filler (the first time takes a little while; it runs on this Mac)' });
  const removeBtn = el('button', { class: 'hw amber', text: 'REMOVE UMS' });
  const allBtn = el('button', { class: 'mini ums-all', text: 'ALL CUT', title: 'Mark every one CUT (click again to KEEP them all)' });
  const root = el('div', { class: 'vo-panel takes-panel ums-panel' },
    el('div', { class: 'vo-head' }, el('b', { text: '💬 UMS' }), el('span', { class: 'spacer' }), el('button', { class: 'mini', text: '×', title: 'Close', onclick: () => close() })),
    el('p', { class: 'note takes-how' },
      el('b', { text: 'Ums, uhs and fillers. ' }),
      'Reel listens to the speech and lists them here. Um and uh are marked CUT. "Like", "you know" and short sounds between words are marked KEEP: play them first. 🗑 removes one now; REMOVE cuts every one marked CUT and closes the gaps.'),
    el('div', { class: 'row ums-opts' }, lang, track),
    list, status,
    el('div', { class: 'takes-foot' }, listenBtn, removeBtn));
  document.body.append(root);
  dragBy(root, root.querySelector('.vo-head'));

  let sig = '', busy = false;
  const cutOne = u => {
    let d = 0;
    app.commit(dd => { d = removeRange(dd, u.t, u.end); dd.ums = (dd.ums || []).filter(x => x.id !== u.id); });
    toast(`Removed “${u.text}” (${d.toFixed(2)} s). ⌘Z brings it back.`, 3000);
    refresh(true);
  };
  const refresh = (force = false) => {
    if (!app.doc) { close(); return; }
    const ums = umsOf(app.doc);
    const now = JSON.stringify(ums.map(u => [u.id, u.t, u.cut])) + busy;
    if (!force && now === sig) return;
    sig = now;
    const n = ums.filter(u => u.cut).length;
    removeBtn.textContent = n ? `REMOVE ${n} UM${n === 1 ? '' : 'S'}` : 'REMOVE UMS';
    removeBtn.disabled = !n || busy;
    listenBtn.disabled = busy;
    listenBtn.textContent = app.doc.ums ? '👂 LISTEN AGAIN' : '👂 LISTEN FOR UMS';
    allBtn.textContent = ums.length && ums.every(u => u.cut) ? 'ALL KEEP' : 'ALL CUT';
    if (!app.doc.ums) { list.replaceChildren(el('p', { class: 'takes-empty', text: 'Press LISTEN FOR UMS. Reel listens to the speech on the track you choose and lists every um, uh and filler it hears.' })); return; }
    if (!ums.length) { list.replaceChildren(el('p', { class: 'takes-empty', text: 'No ums found. Nice and clean.' })); return; }
    const words = ums.filter(u => u.kind === 'word').length;
    list.replaceChildren(
      el('div', { class: 'engr takes-rec ums-sum' }, el('span', { text: `${ums.length} found · ${words} heard as words · ${ums.length - words} sounds` }), allBtn),
      ...ums.map(u => {
        const play = el('button', { class: 'mini', text: '▶', title: 'Play it with a second either side', onclick: () => { app.seek(Math.max(0, u.t - 1)); if (!app.player.playing) app.player.toggle(); stopAt(u.end + 0.8); } });
        const toggle = el('button', { class: 'take-state ' + (u.cut ? 'drop' : 'keep'), text: u.cut ? 'CUT' : 'KEEP', title: u.cut ? 'Cut when you press REMOVE. Click to keep it' : 'Kept. Click to cut it when you press REMOVE', onclick: () => {
          app.commit(d => { const k = (d.ums || []).find(x => x.id === u.id); if (k) k.cut = !k.cut; });
          refresh(true);
        } });
        const del = el('button', { class: 'mini ums-del', text: '🗑', title: 'Remove this one now (closes the gap)', onclick: () => cutOne(u) });
        return el('div', { class: 'take-row' + (u.cut ? ' dropped' : '') + (u.kind === 'sound' ? ' ums-sound' : '') }, play,
          el('span', { class: 'take-name', text: u.kind === 'sound' ? '(sound)' : `“${u.text}”`, title: u.kind === 'sound' ? 'A short sound between words: often an um the speech recogniser left out. Play it to check.' : 'Heard as a word' }),
          el('span', { class: 'take-time', text: `${fmt(u.t)} · ${(u.end - u.t).toFixed(1)} s`, onclick: () => app.seek(u.t), title: 'Go there' }),
          toggle, del);
      }));
  };
  let stopTimer = null;
  const stopAt = t1 => {
    clearInterval(stopTimer);
    stopTimer = setInterval(() => { if (!app.player.playing) { clearInterval(stopTimer); return; } if (app.player.time >= t1) { app.player.toggle(); clearInterval(stopTimer); } }, 40);
  };
  allBtn.addEventListener('click', () => {
    const to = !umsOf(app.doc).every(u => u.cut);
    app.commit(d => { for (const u of d.ums || []) u.cut = to; });
    refresh(true);
  });
  removeBtn.addEventListener('click', () => {
    const cuts = umsOf(app.doc).filter(u => u.cut);
    if (!cuts.length) return;
    const ids = new Set(cuts.map(u => u.id));
    let total = 0;
    app.commit(d => {
      for (const r of mergeRanges(cuts).reverse()) total += removeRange(d, r.t, r.end);
      d.ums = (d.ums || []).filter(u => !ids.has(u.id));
    });
    toast(`Removed ${cuts.length} um${cuts.length === 1 ? '' : 's'} (${total.toFixed(1)} s). ⌘Z brings them back.`, 5000);
    refresh(true);
  });
  listenBtn.addEventListener('click', async () => {
    if (busy) return;
    busy = true; refresh(true);
    saveSpeechPrefs({ ...speechPrefs(), locale: lang.value, track: track.value });
    try {
      const found = await listen(app, { locale: lang.value, track: track.value }, t => { status.textContent = t; });
      const n = found.filter(u => u.cut).length;
      status.textContent = found.length ? `${found.length} found, ${n} marked CUT.` : '';
    } catch (e) { status.textContent = e.message; }
    finally { busy = false; refresh(true); }
  });
  const timer = setInterval(() => refresh(), 700);
  const close = () => { clearInterval(timer); clearInterval(stopTimer); root.remove(); panel = null; };
  panel = { root, refresh, close };
  refresh(true);
}
export function closeUms() { panel?.close(); }
