// 🩺 Check & repair: one look at the whole project. Every file it uses (and whether it's still there), every
// recording (its screen and mic, used or not), sound that has slipped out of sync with its picture, and picture that
// has lost its sound (or the other way round). REPAIR saves a backup of the edit, then puts every sound back under
// its picture and fills in the missing halves from the same recording, as one ⌘Z.
import { troubled, cleanCopy } from './picturefix.js';
import { el, modal, toast } from './ui.js';
import { outOfSync, resync, missingHalves } from './lib/sync.js';
import { scanSpelling } from './spelling.js';
import { isFree, addTrack, newMediaClip, fmtTime, mediaById } from './model.js';

const fmtLen = s => (s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${s.toFixed(1)} s`);

/** What's wrong with the project (no changes made). */
export async function checkProject(app) {
  const doc = app.doc;
  const media = doc.media.filter(m => !m.hidden && !(m.sfx));
  let missing = [];
  try { missing = (await app.api.missingMedia(app.token, media.map(m => m.file).filter(Boolean))) || []; } catch { /* can't tell */ }
  const gone = new Set(missing);
  const uses = new Map(); for (const c of doc.clips) if (c.media) uses.set(c.media, (uses.get(c.media) || 0) + 1);
  const recIds = [...new Set(media.map(m => m.recording).filter(Boolean))];
  const recordings = recIds.map((r, i) => {
    const ms = media.filter(m => m.recording === r);
    const stamp = ms[0].name.match(/\d{1,2}:\d{2}\s*[AP]M/i)?.[0] || '';
    return { id: r, n: i + 1, stamp, files: ms.map(m => ({ m, used: uses.get(m.id) || 0, gone: gone.has(m.file) })), length: Math.max(0, ...ms.map(m => m.duration || 0)) };
  });
  const others = media.filter(m => !m.recording).map(m => ({ m, used: uses.get(m.id) || 0, gone: gone.has(m.file) }));
  const slipped = outOfSync(doc);
  const holes = missingHalves(doc);
  const missingOnTimeline = media.filter(m => gone.has(m.file) && uses.get(m.id));
  let spelling = null; try { spelling = await scanSpelling(doc); } catch { /* can't tell */ }
  const dark = media.filter(m => !gone.has(m.file) && troubled(m));
  return { recordings, others, slipped, holes, missing: media.filter(m => gone.has(m.file)), missingOnTimeline, spelling, dark };
}

/** Puts it right: sound back under its picture, then the missing halves filled from the same recording. */
export function repairDoc(doc) {
  let made = 0;
  const newTrack = d => { const t = addTrack(d, d.tracks.length); t.name = 'Sound (repaired)'; made++; return t.id; };
  const r = resync(doc, null, isFree, newTrack);
  const holes = missingHalves(doc);
  let filled = 0, filledSecs = 0;
  for (const h of holes) {
    const m = mediaById(doc, h.media);
    if (!m) continue;
    const c = newMediaClip(doc, m, null, h.start);
    c.in = h.in; c.duration = h.duration; c.name = m.name;
    if (h.beside) { if (h.beside.audio) c.audio = { ...structuredClone(h.beside.audio), fadeIn: 0, fadeOut: 0 }; if (h.beside.fx) c.fx = structuredClone(h.beside.fx); }
    if (h.from?.group) c.group = h.from.group;
    const prefer = h.beside?.track;
    c.track = prefer && isFree(doc, prefer, c.start, c.duration) ? prefer
      : doc.tracks.find(t => doc.clips.some(o => o.track === t.id && o.media === h.media) && isFree(doc, t.id, c.start, c.duration))?.id
      || newTrack(doc);
    doc.clips.push(c); filled++; filledSecs += c.duration;
  }
  return { moved: r.moved, blocked: r.blocked, filled, filledSecs, tracks: made };
}

export async function openRepair(app) {
  if (!app.doc) return;
  const body = el('div', { class: 'rp' }, el('p', { class: 'note', text: 'Checking every file and every recording…' }));
  let dlg = null;
  const draw = async () => {
    const r = await checkProject(app);
    const problems = r.slipped.length + r.holes.length;
    const lateBy = r.slipped.length ? r.slipped.map(x => Math.abs(x.shift)).sort((a, b) => a - b)[Math.floor(r.slipped.length / 2)] : 0;
    const row = (ok, text, sub) => el('div', { class: 'rp-row ' + (ok ? 'ok' : 'bad') }, el('b', { text: ok ? '✓' : '!' }), el('div', {}, el('div', { text }), sub ? el('small', { text: sub }) : null));
    const status = f => (f.gone ? 'MISSING' : f.used ? `on timeline ×${f.used}` : 'not used');
    body.replaceChildren(
      el('div', { class: 'rp-sum' },
        row(!r.missing.length, r.missing.length ? `${r.missing.length} file${r.missing.length === 1 ? ' is' : 's are'} missing from the project folder` : 'Every file is in the project folder', r.missing.length ? r.missing.map(m => m.name).join(', ') + ' — media panel › right-click › Replace file… to point Reel at it.' : 'Nothing is lost: deleting or moving clips never deletes these files.'),
        row(!r.slipped.length, r.slipped.length ? `${r.slipped.length} sound clip${r.slipped.length === 1 ? ' is' : 's are'} out of sync with ${r.slipped.length === 1 ? 'its' : 'their'} picture` : 'All the sound is in sync with its picture', r.slipped.length ? `Most by about ${fmtLen(lateBy)}. REPAIR moves each one back under its picture.` : ''),
        row(!r.holes.length, r.holes.length ? `${fmtLen(r.holes.reduce((a, h) => a + h.duration, 0))} of picture ${r.holes.length === 1 ? 'has' : 'have'} no microphone under it (${r.holes.length} place${r.holes.length === 1 ? '' : 's'})` : 'Every picture has its microphone', r.holes.length ? 'REPAIR puts that sound back from the same recording, in sync.' : ''),
        el('div', { class: 'rp-row ' + (r.dark.length ? 'bad' : 'ok') }, el('b', { text: r.dark.length ? '!' : '✓' }), el('div', {},
          el('div', { text: r.dark.length ? `${r.dark.length} video${r.dark.length === 1 ? '' : 's'} may show black (or freeze) in the preview` : 'Every video shows its picture in the preview' }),
          el('small', {}, el('span', { text: r.dark.length ? r.dark.map(m => `“${m.name}”`).join(', ') + ': a clean preview copy fixes it (the original isn’t changed; export still uses it).  ' : 'If one ever shows black: right-click it › 🩹 Make a clean preview copy.' }),
            r.dark.length ? el('button', { class: 'tool', type: 'button', text: '🩹 MAKE CLEAN COPIES', onclick: async e => { e.currentTarget.disabled = true; for (const m of r.dark) await cleanCopy(app, m); draw(); } }) : null))),
        r.spelling ? el('div', { class: 'rp-row ' + (r.spelling.length ? 'bad' : 'ok') }, el('b', { text: r.spelling.length ? '!' : '✓' }), el('div', {},
          el('div', { text: r.spelling.length ? `${r.spelling.length} word${r.spelling.length === 1 ? '' : 's'} on screen may be misspelt` : 'Every word on screen is spelt right' }),
          r.spelling.length ? el('small', {}, el('span', { text: r.spelling.slice(0, 6).map(f => `“${f.word}”`).join(', ') + (r.spelling.length > 6 ? '…  ' : '  ') }), el('button', { class: 'tool', type: 'button', text: 'ABC✓ CHECK SPELLING', onclick: () => app.cmd('spelling') })) : null)) : null),
      el('div', { class: 'engr rp-h', text: `RECORDINGS (${r.recordings.length})` }),
      el('div', { class: 'rp-list' }, ...r.recordings.map(rec => {
        const unused = rec.files.every(f => !f.used);
        return el('div', { class: 'rp-rec' + (unused ? ' unused' : '') },
          el('b', { text: `Recording ${rec.n}${rec.stamp ? ` · ${rec.stamp}` : ''}` }), el('span', { class: 'rp-len', text: fmtTime(rec.length) }),
          el('span', { class: 'rp-files', text: rec.files.map(f => `${(f.m.role || f.m.kind).toUpperCase()} ${f.gone ? '✗ missing' : '✓'} (${status(f)})`).join('  ·  ') }),
          unused ? el('span', { class: 'rp-tag', text: 'NOT ON THE TIMELINE' }) : null);
      })),
      r.others.length ? el('div', { class: 'engr rp-h', text: `OTHER FILES (${r.others.length})` }) : null,
      r.others.length ? el('div', { class: 'rp-list' }, ...r.others.map(f => el('div', { class: 'rp-rec' + (f.used ? '' : ' unused') }, el('b', { text: f.m.name }), el('span', { class: 'rp-files', text: f.gone ? '✗ missing' : `✓ ${status(f)}` })))) : null,
      el('p', { class: 'note', text: problems ? 'REPAIR first saves a backup of this edit in the project’s Backups folder, then fixes it all as one step (⌘Z undoes it). Your media files are never changed. Recordings marked NOT ON THE TIMELINE are there for you to drag in (media panel › DRAG ALL).' : 'Nothing to repair. Recordings marked NOT ON THE TIMELINE are there for you to drag in (media panel › DRAG ALL).' }));
    if (dlg) { const rb = dlg.foot.querySelector('.rp-go'); if (rb) { rb.disabled = !problems; rb.textContent = problems ? `REPAIR ${problems} PROBLEM${problems === 1 ? '' : 'S'}` : 'NOTHING TO REPAIR'; } }
  };
  dlg = modal('🩺 Check & repair', body, [
    { label: 'CHECK AGAIN', onClick: () => draw() },
    { label: 'REPAIR', cls: 'hw amber rp-go', onClick: async (close, btn) => {
      btn.disabled = true; btn.textContent = 'REPAIRING…';
      try {
        await app.save();
        const b = await app.api.backupEdit(app.token, 'before repair');
        let res = null;
        app.commit(d => { res = repairDoc(d); });
        await app.save();
        toast(`Repaired: ${res.moved} sound clip${res.moved === 1 ? '' : 's'} back in sync${res.filled ? `, ${fmtLen(res.filledSecs)} of missing microphone put back (${res.filled} place${res.filled === 1 ? '' : 's'})` : ''}${res.blocked ? `; ${res.blocked} couldn’t move` : ''}. A backup of the edit before this is in ${b?.folder || 'the Backups folder'}. ⌘Z undoes it.`, 9000);
        await draw();
      } catch (e) { toast(e.message, 6000); btn.disabled = false; }
    } },
    { label: 'CLOSE', onClick: close => close() },
  ], { wide: true });
  await draw();
  return dlg;
}
