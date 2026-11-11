// 👻 Isolate a sound: type what you hear ("dog barking", "keyboard typing", "music") and Reel pulls just that out of
// the clip, or takes it out and keeps everything else. Meta's SAM-Audio on this Mac's graphics chip (mlx-audio),
// the idea of AudioGhost AI. The result goes on a new track under the clip, in step with it, and the clip's own sound
// is muted (unmute it to compare); ⌘Z puts it all back.
import { el, modal, toast } from './ui.js';
import { mediaById, uid, addTrack } from './model.js';
import { ensureSource, plainError } from './fx.js';

export const IDEAS = ['voice', 'music', 'dog barking', 'keyboard typing', 'mouse clicks', 'traffic', 'wind', 'crowd chatter', 'footsteps', 'hum or buzz', 'siren', 'birds'];

/** A clip with sound to separate (sound-only or a video with sound), at any speed, not reversed. */
export function canSeparate(doc, c) {
  const m = c && c.type === 'media' ? mediaById(doc, c.media) : null;
  return !!(m && (m.kind === 'audio' || m.hasAudio) && !c.reversed);
}

/** Puts the separated sound (and, if asked, the rest) under the clip, in step with it, and mutes the clip's sound. */
export function placeSeparated(doc, clipId, r, { keep, both, prompt }) {
  const c = doc.clips.find(x => x.id === clipId); if (!c) return [];
  const idx = doc.tracks.findIndex(t => t.id === c.track);
  const made = [];
  const parts = keep ? [['target', `Only: ${prompt}`], ...(both ? [['residual', `Without: ${prompt}`]] : [])]
    : [['residual', `Without: ${prompt}`], ...(both ? [['target', `Only: ${prompt}`]] : [])];
  c.group ||= uid('g');
  let at = idx + 1;
  for (const [which, trackName] of parts) {
    const m = { id: uid('m'), ...r[which], kind: 'audio', hasAudio: true };
    doc.media.push(m);
    const tr = addTrack(doc, at++);
    tr.name = trackName.slice(0, 40);
    const n = { id: uid('c'), type: 'media', media: m.id, track: tr.id, start: c.start, duration: c.duration, in: 0, speed: c.speed || 1,
      audio: { volume: 1, pan: c.audio?.pan || 0, fadeIn: c.audio?.fadeIn || 0, fadeOut: c.audio?.fadeOut || 0, mute: false, voice: /voice|speech|talk|dialog/i.test(prompt) && which === 'target', duck: 0 },
      props: {}, audioOnly: true, group: c.group, separated: { from: c.id, which, prompt } };
    made.push(n.id);
    doc.clips.push(n);
  }
  c.audio = { ...(c.audio || {}), mute: true };
  return made;
}

let listen = null;
function hook(app, fn) {
  listen = fn;
  if (!app._ghostHooked) { app._ghostHooked = true; app.api.onAi?.(ev => listen?.(ev)); }
}

export async function openGhost(app, clipId = app.selection.clips[0]) {
  const doc = app.doc, c = doc?.clips.find(x => x.id === clipId);
  if (!c || !canSeparate(doc, c)) { toast('Select a clip with sound first (a voice, music, a recording…), then 👻 Isolate a sound.', 6000); return; }
  const m = mediaById(doc, c.media);
  const prompt = el('input', { type: 'text', class: 'gh-prompt', placeholder: 'What do you hear? e.g. dog barking, keyboard typing, music', maxlength: 200 });
  try { prompt.value = localStorage.getItem('reel.ghost.prompt') || ''; } catch { /* empty */ }
  const chips = el('div', { class: 'gh-chips' }, ...IDEAS.map(t => el('button', { class: 'mini', text: t, onclick: () => { prompt.value = t; prompt.focus(); } })));
  let keep = true, quality = 'fast', size = null, busy = false;
  const seg = (opts, get, set) => { const s = el('div', { class: 'seg' }); const draw = () => { for (const b of s.children) b.classList.toggle('on', b.dataset.v === get()); };
    for (const [v, t] of opts) s.append(el('button', { 'data-v': v, text: t, onclick: () => { set(v); draw(); } })); draw(); return s; };
  const mode = seg([['keep', 'Keep only this sound'], ['remove', 'Remove this sound']], () => (keep ? 'keep' : 'remove'), v => { keep = v === 'keep'; });
  const qual = seg([['fast', 'Fast'], ['best', 'Best (about 4× slower)']], () => quality, v => { quality = v; });
  const both = el('input', { type: 'checkbox' });
  const models = el('div', { class: 'wr-models' }), note = el('p', { class: 'note' }), bar = el('div', { class: 'progress hidden' }, el('i'));
  let st = await app.api.ghostStatus().catch(e => ({ allowed: false, reason: plainError(e), models: {} }));

  hook(app, ev => {
    if (ev?.type === 'ghostSetup' || ev?.type === 'ghostRun') { bar.firstChild.style.width = Math.round((ev.f || 0) * 100) + '%'; if (ev.msg) note.textContent = ev.msg; }
  });
  const drawModels = () => {
    if (!st.allowed) { models.replaceChildren(el('p', { class: 'note', text: st.reason })); return; }
    models.replaceChildren(...Object.entries(st.models).map(([k, md]) => {
      const card = el('div', { class: 'wr-model' + (md.allowed ? '' : ' off') + (size === k ? ' lit' : ''), title: md.reason || '' },
        el('b', { text: md.label }), el('small', { text: md.allowed ? (md.ready ? 'Ready' : `${md.gb} GB download`) : md.reason }));
      if (md.allowed && md.ready) card.addEventListener('click', () => { size = k; drawModels(); });
      if (md.allowed && !md.ready) card.append(el('button', { class: 'tool', text: 'GET', onclick: async ev => {
        ev.stopPropagation(); if (busy) return; busy = true; bar.classList.remove('hidden'); note.textContent = 'Setting up sound separation…';
        try { await app.api.ghostSetup(k); st = await app.api.ghostStatus(); size = k; note.textContent = 'Ready. Describe a sound and press SEPARATE.'; }
        catch (e) { note.textContent = plainError(e) === 'Stopped' ? 'Stopped. Press GET again to carry on.' : `Couldn’t set it up: ${plainError(e)}`; }
        busy = false; bar.classList.add('hidden'); drawModels();
      } }));
      return card;
    }));
  };
  drawModels();
  if (!st.ready && st.allowed) note.textContent = 'One-time setup: press GET on a model (Small suits any Apple silicon Mac). It installs into Reel’s own folder, then works offline; nothing is uploaded.';

  const sp = c.speed || 1, from = c.in || 0, to = from + c.duration * sp;
  modal('👻 Isolate a sound', el('div', { class: 'gh' },
    el('p', { text: `Type what you hear in “${c.name || m.name}” and Reel pulls just that sound out, or takes it out and keeps the rest. Like AudioGhost AI, using Meta’s SAM-Audio on this Mac.` }),
    prompt, chips,
    el('div', { class: 'row' }, el('label', { text: 'Do' }), mode),
    el('label', { class: 'row kit-langs' }, both, el('span', { text: 'Also put the other part on its own track' })),
    el('div', { class: 'row' }, el('label', { text: 'Quality' }), qual),
    el('div', { class: 'engr', text: 'Model' }), models,
    bar, note,
    el('p', { class: 'note', text: `The ${Math.round(to - from)} s this clip plays are separated (about as long as the clip takes to play, on the Small model). The result goes on a new track under the clip, and the clip’s own sound is muted; unmute it to compare, or ⌘Z.` })), [
    { label: 'Cancel', onClick: close => { if (busy) app.api.ghostCancel?.(); close(); } },
    { label: 'Separate', cls: 'hw amber', onClick: async (close, btn) => {
      if (busy) return;
      const p = prompt.value.replace(/\s+/g, ' ').trim();
      if (!p) { note.textContent = 'Type the sound to separate first (or tap one of the ideas).'; prompt.focus(); return; }
      if (!st.ready) { note.textContent = 'Set it up first: press GET on a model above.'; return; }
      try { localStorage.setItem('reel.ghost.prompt', p); } catch { /* fine */ }
      busy = true; btn.disabled = true; bar.classList.remove('hidden'); note.textContent = 'Preparing the sound…';
      try {
        const source = await ensureSource(app, m, f => { bar.firstChild.style.width = Math.round(f * 20) + '%'; });
        const r = await app.api.ghostSeparate(app.token, { source, from, to, prompt: p, size, quality });
        let ids = [];
        app.commit(d => { ids = placeSeparated(d, clipId, r, { keep, both: both.checked, prompt: p }); });
        app.select(ids.slice(0, 1), null);
        app.timeline?.reveal?.(ids);
        close();
        toast(`${keep ? `Only “${p}”` : `Everything but “${p}”`} is on a new track under the clip (its own sound is muted). Press PLAY to hear it; ⌘Z undoes it.`, 7000);
      } catch (e) {
        const msg = plainError(e);
        if (msg !== 'Stopped') note.textContent = `Couldn’t separate it: ${msg}`;
        bar.classList.add('hidden');
      }
      busy = false; btn.disabled = false;
    } },
  ], { wide: true });
  setTimeout(() => prompt.focus(), 50);
}
