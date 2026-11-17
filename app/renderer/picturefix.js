// A black (or frozen) picture in the preview: when a video can't be shown (its file won't decode here, or Reel couldn't
// read it to make a preview copy), a strip on the preview says so and offers the fix in one click: a clean preview copy
// made by macOS itself (AVFoundation reads damaged or unusual recordings that the preview can't), which the preview
// plays from then on. Export still reads the original. The same fix is in PROXY ▾, in 🩺 Check & repair, and on a
// clip's right-click menu.
import { el, toast } from './ui.js';

const told = new Set(), trouble = new Map();
/** Videos found this session whose picture the preview can't show (media id → why), for Check & repair. */
export const troubled = m => m.kind === 'video' && !m.proxy?.clean && (trouble.has(m.id) || !!m.proxyFailed); // media told about this session (closing the strip means "not again for this one")
let strip = null;

/** Something's wrong with this video's picture. why: 'error' (won't play), 'nopicture' (plays with no picture), 'proxy' (no preview copy). */
export function pictureTrouble(app, m, why) {
  if (!m || m.kind !== 'video' || m.proxy?.clean) return;
  trouble.set(m.id, why); // for Check & repair
  if (told.has(m.id)) return;
  told.add(m.id);
  showStrip(app, m, why);
}

function showStrip(app, m, why) {
  strip?.remove();
  const stage = document.getElementById('stage');
  if (!stage) return;
  const say = why === 'proxy'
    ? `Reel couldn’t read “${m.name}” to make its preview copy, so its picture may show black or freeze here.`
    : `“${m.name}” won’t show its picture in the preview (the file may be damaged, or in a form the preview can’t play).`;
  const fixBtn = el('button', { class: 'hw pf-fix', type: 'button', text: '🩹 FIX: MAKE A CLEAN COPY', title: 'macOS makes a clean, smaller copy for the preview to play (a minute or two for a long recording). Your original isn’t changed, and export still uses it.' });
  strip = el('div', { class: 'pf-strip', role: 'alert' },
    el('b', { text: '⚠' }),
    el('div', { class: 'pf-say' }, el('div', { text: say }), el('small', { text: 'The fix doesn’t touch your recording; export still uses it. Also in PROXY ▾ and 🩺 Check & repair.' })),
    fixBtn,
    el('button', { class: 'hw pf-more', type: 'button', text: 'PROXY ▾', title: 'Proxy settings (preview copies)', onclick: e => app.proxyMenu(e.currentTarget) }),
    el('button', { class: 'pf-x', type: 'button', text: '×', title: 'Close', onclick: () => { strip?.remove(); strip = null; } }));
  fixBtn.addEventListener('click', async () => {
    fixBtn.disabled = true;
    const ok = await cleanCopy(app, m, p => { fixBtn.textContent = `MAKING THE COPY… ${Math.round(p * 100)}%`; });
    if (ok) { strip?.remove(); strip = null; } else { fixBtn.disabled = false; fixBtn.textContent = '🩹 TRY AGAIN'; }
  });
  stage.append(strip);
}

const busy = new Set();
/** Makes a clean preview copy of video m with the Mac's own converter, and plays that from now on. */
export async function cleanCopy(app, m, onProgress) {
  if (!m || m.kind !== 'video') { toast('Select a video clip first (the one that shows black).', 3500); return false; }
  if (busy.has(m.id)) { toast(`Already making a clean copy of “${m.name}”.`, 3000); return false; }
  if (!app.api.cleanProxy) { toast('This needs the newer Reel: run “Build ProtoArt Reel” and open it again.', 6000); return false; }
  busy.add(m.id);
  toast(`Making a clean preview copy of “${m.name}”… you can keep working.`, 4000);
  const off = app.api.onCleanProxyProgress?.((file, v) => { if (file === m.file) onProgress?.(v); });
  try {
    const token = app.token;
    const r = await app.api.cleanProxy(token, m.file);
    if (app.token !== token) return false;
    const live = app.doc.media.find(x => x.id === m.id);
    if (!live) return false;
    const div = Math.max(1, Math.round((live.height || r.height) / (r.height || 1)));
    live.proxy = { file: r.file, of: live.file, div, width: r.width, height: r.height, clean: true };
    delete live.proxyFailed; trouble.delete(live.id);
    app.setDirty(true);
    app.player.reloadMedia(live.id);
    toast(`“${m.name}”: the preview now plays its clean copy. Export still uses the original.`, 5000);
    return true;
  } catch (e) {
    const old = /unknown kind/i.test(e.message);
    toast(old ? 'Reel’s helper needs rebuilding for this: run “Build ProtoArt Reel”, open Reel again and try once more.' : `Couldn’t make a clean copy of “${m.name}”: ${e.message}`, 8000);
    return false;
  } finally { busy.delete(m.id); off?.(); }
}

/** The video to fix: the selected clip's, else the top one under the playhead. */
export function videoToFix(app) {
  const doc = app.doc; if (!doc) return null;
  const vid = c => { const m = doc.media.find(x => x.id === c?.media); return m?.kind === 'video' ? m : null; };
  for (const id of app.selection.clips) { const m = vid(doc.clips.find(c => c.id === id)); if (m) return m; }
  const t = app.player.time;
  const order = doc.tracks.map(tr => tr.id);
  const under = doc.clips.filter(c => vid(c) && t >= c.start && t < c.start + c.duration).sort((a, b) => order.indexOf(a.track) - order.indexOf(b.track));
  return vid(under[0]);
}
