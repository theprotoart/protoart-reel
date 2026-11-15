// 〰 FILLER: like ✚ CLIPS, but for the sounds you want Reel to learn. Press it, then drag across an um (or uh, or
// any filler sound) on the voice track. Each one becomes a red, zig-zagged band on that track that you can play,
// nudge and then send to 🎙 Teach Reel your ums, for a guest who can't read lines as easily as for yourself.
import { popMenu, toast } from './ui.js';
import { uid, removeRange } from './model.js';
import { teachFromTimeline, notAnUm } from './umvoice.js';

export const WORDS = [['umm', 'um'], ['uh', 'uh']];

/** A filler from t0 to t1 on a track (overlapping ones on the same track become one). */
export function addFiller(app, t0, t1, track) {
  if (t1 < t0) [t0, t1] = [t1, t0];
  t0 = Math.max(0, t0);
  if (!(t1 - t0 >= 0.08)) { toast('Drag across the um, from where it starts to where it ends.'); return null; }
  if (t1 - t0 > 3) { toast('That’s more than 3 seconds: drag across one um at a time.', 4000); return null; }
  let id = uid('fil');
  app.commit(d => {
    const list = d.fillers || (d.fillers = []);
    const over = list.find(f => f.track === track && f.t0 < t1 && f.t1 > t0);
    if (over) { over.t0 = Math.min(over.t0, t0); over.t1 = Math.max(over.t1, t1); delete over.taught; id = over.id; }
    else {
      // tie it to the clip it's on (its place in that recording), so it follows the clip around
      const mid = (t0 + t1) / 2, c = d.clips.find(x => x.track === track && x.type === 'media' && x.start <= mid && mid < x.start + x.duration);
      const src = t => (c.in || 0) + (t - c.start) * (c.speed || 1);
      list.push({ id, t0, t1, track, word: 'umm', ...(c ? { clip: c.id, media: c.media, s0: src(Math.max(t0, c.start)), s1: src(Math.min(t1, c.start + c.duration)) } : {}) });
    }
    list.sort((a, b) => a.t0 - b.t0);
  });
  const n = app.doc.fillers.length;
  toast(`Filler marked: ${n} so far. Click it to hear it. When you have a few, press 🎙 TEACH MY UMS and send them.`, 4500);
  playRange(app, t0, t1);
  return id;
}

export function removeFiller(app, id) {
  app.commit(d => { d.fillers = (d.fillers || []).filter(f => f.id !== id); if (!d.fillers.length) delete d.fillers; });
}
export function clearFillers(app) { app.commit(d => { delete d.fillers; }); }
/** Cuts fillers' sound out of the timeline (everything after closes up). What Reel learned from them stays. */
export function cutFillers(app, ids) {
  const cut = (app.doc.fillers || []).filter(f => ids.includes(f.id)).sort((a, b) => b.t0 - a.t0);
  if (!cut.length) return;
  app.commit(d => {
    for (const f of cut) removeRange(d, f.t0, f.t1);
    if (d.fillers) { d.fillers = d.fillers.filter(f => !ids.includes(f.id)); if (!d.fillers.length) delete d.fillers; }
  });
  toast(`Cut ${cut.length} filler${cut.length === 1 ? '' : 's'} from the recording. What Reel learned from them stays. (⌘Z puts them back.)`, 5000);
}
export function setFillerWord(app, id, word) {
  app.commit(d => { const f = (d.fillers || []).find(x => x.id === id); if (f) { f.word = word; delete f.taught; } });
}

let stopTimer = null;
/** Plays t0–t1 on the timeline (with a hair either side so the start isn't clipped), then stops. */
export function playRange(app, t0, t1) {
  const p = app.player;
  clearInterval(stopTimer);
  if (p.playing) p.toggle();
  app.seek(Math.max(0, t0 - 0.05));
  p.toggle();
  stopTimer = setInterval(() => {
    if (!p.playing) { clearInterval(stopTimer); return; }
    if (p.time >= t1 + 0.05) { p.toggle(); clearInterval(stopTimer); app.seek(t0); }
  }, 20);
}

/**
 * Sends fillers to the um trainer: each one's sound (with the speech before it, so Reel can tell it from ordinary
 * words) is added to what Reel knows. word 'not' teaches "this isn't an um" instead. Returns how many were learned.
 */
export async function teachFillers(app, fillers, onStatus) {
  let ok = 0, last = '';
  for (const [i, f] of fillers.entries()) {
    onStatus?.(`Learning ${i + 1} of ${fillers.length}…`);
    try {
      if (f.word === 'not') { if (await notAnUm(app, f.t0, f.t1, f.track)) ok++; }
      else { await teachFromTimeline(app, f.t0, f.t1, f.word || 'umm', f.track); ok++; }
    } catch (e) { last = e.message; }
  }
  const ids = new Set(fillers.map(f => f.id));
  if (ok) app.commit(d => { for (const f of d.fillers || []) if (ids.has(f.id)) f.taught = true; }, { quiet: true });
  if (last && !ok) throw new Error(last);
  return ok;
}

/** Right-click on a filler. */
export function fillerMenu(app, f, x, y) {
  const one = async word => {
    try {
      const n = await teachFillers(app, [{ ...f, word }]);
      if (word !== 'not' && word !== f.word) setFillerWord(app, f.id, word);
      toast(n ? (word === 'not' ? 'Reel won’t take that for an um again.' : `Learned that ${word === 'uh' ? 'uh' : 'um'}. 💬 UMS › LISTEN AGAIN uses it.`) : 'Nothing was learned (teach a few ums first for “not an um”).', 4500);
    } catch (e) { toast(e.message, 5000); }
  };
  popMenu(x, y, [
    ['▶ Play it', () => playRange(app, f.t0, f.t1)],
    null,
    ['🎙 Teach it as an um', () => one('umm')],
    ['🎙 Teach it as an uh', () => one('uh')],
    ['✗ Teach that this isn’t an um', () => one('not')],
    null,
    ['✂ Cut this filler from the recording', () => cutFillers(app, [f.id])],
    (app.doc.fillers || []).length > 1 ? [`✂ Cut all ${app.doc.fillers.length} fillers from the recording`, () => cutFillers(app, app.doc.fillers.map(x => x.id))] : null,
    null,
    ['Unmark this filler (keep the sound)', () => removeFiller(app, f.id)],
    (app.doc.fillers || []).length > 1 ? [`Unmark all ${app.doc.fillers.length} fillers (keep the sound)`, () => clearFillers(app)] : null,
  ]);
}
