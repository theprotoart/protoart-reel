// Your own plug-ins (Audio Units: Waves, iZotope, FabFilter…) as inserts on a track's channel strip. Plug-ins
// can't run live inside the preview, so Reel renders each clip on the track through the track's plug-ins (after
// the clip's own effects) in the background, and plays the rendered sound. Changing a plug-in's settings,
// bypassing, removing or undoing it, or moving a clip to another track, renders again. The strip shows the
// plug-in like any insert; click it to open its window.
import { toast } from './ui.js';
import { mediaById, uid } from './model.js';
import { renderClip, pickPlugin, ensureSource, pluginEdited } from './fx.js';
import { ask } from './ui.js';
import { sourceTime, clipEnd, trackGainAt } from './model.js';
import { pref } from './prefs.js';

const isAu = f => f && f.type === 'au';
const trOf = (app, id) => app.doc?.tracks.find(t => t.id === id) || null;

/** Picks an installed plug-in and puts it on the track's strip, then opens its window. */
export async function addTrackPlugin(app, tr, at) {
  const p = await pickPlugin(app);
  if (!p) return null;
  const f = { id: uid('fx'), type: 'au', plugin: p.id, name: p.name, maker: p.maker, state: '' };
  app.commit(() => {
    const t = trOf(app, tr.id); if (!t) return;
    t.fx ||= [];
    if (at == null || at >= t.fx.length) t.fx.push(f); else t.fx.splice(at, 0, f);
    t.fxOpen = true;
  }, { keepInspector: true });
  toast(`${p.name} is on “${tr.name || 'the track'}”. Press Space to hear it live while you adjust it.`, 5000);
  editTrackPlugin(app, tr, f);
  return f;
}

/** Opens a track plug-in's own window; its settings are saved when the window closes. */
export async function editTrackPlugin(app, tr, f) {
  const slot = `t${f.id}`;
  app.fxEditing.set(slot, { track: tr.id, item: f.id });
  try { await app.api.fxEdit(slot, f.plugin, f.state || '', `${f.name} — ${tr.name || 'track'}`); }
  catch (e) { app.fxEditing.delete(slot); toast(e.message, 6000); }
}

/** The track's plug-ins as items of a clip's effect chain (they follow the clip's own effects). */
function wanted(tr) {
  return (tr.fx || []).filter(isAu).map(f => ({ id: 'trk-' + f.id, kind: 'au', plugin: f.plugin, name: f.name, maker: f.maker, state: f.state || '', bypass: !!f.off, fromTrack: tr.id }));
}
const hasSound = (doc, c) => { const m = c.type === 'media' && mediaById(doc, c.media); return !!m && (m.kind === 'audio' || m.hasAudio); };

let timer = 0, busy = false, again = false, lastSig = '';
const live = () => pref('trackPlugins') === 'live';
/** Call after any change: brings clips in line with their tracks' plug-ins (quickly; renders in the background). */
export function syncTrackPlugins(app) {
  const doc = app.doc; if (!doc) return;
  const sig = JSON.stringify(doc.tracks.map(t => [t.id, wanted(t)])) + '|' + doc.clips.map(c => c.id + c.track + (c.fx?.chain?.some(x => x.fromTrack) ? '*' : '')).join(',');
  if (sig === lastSig) return;
  lastSig = sig;
  clearTimeout(timer);
  timer = setTimeout(() => run(app), 700);
}

/** Puts each track's plug-ins into its clips' effect chains (no rendering). Returns the clips that changed. */
function update(app) {
  const doc = app.doc; if (!doc) return [];
  const todo = [];
  for (const c of doc.clips) {
    if (!hasSound(doc, c)) continue;
    const tr = doc.tracks.find(t => t.id === c.track);
    const want = tr ? wanted(tr) : [];
    const cur = (c.fx?.chain || []).filter(x => x.fromTrack);
    if (JSON.stringify(cur) === JSON.stringify(want)) continue;
    const own = (c.fx?.chain || []).filter(x => !x.fromTrack);
    if (!own.length && !want.length) { if (c.fx) { delete c.fx; app.setDirty(true); } continue; }
    c.fx ||= { chain: [], file: null, dirty: true, bypass: false };
    c.fx.chain = [...own, ...want]; c.fx.dirty = true;
    todo.push(c.id);
  }
  if (todo.length) app.setDirty(true);
  return todo;
}

/** Clips whose track plug-ins aren't rendered yet (optionally on one track). */
const pending = (app, trackId) => (app.doc?.clips || []).filter(c => c.fx?.dirty && c.fx.chain?.some(x => x.fromTrack) && (!trackId || c.track === trackId)).map(c => c.id);

async function run(app) {
  if (busy) { again = true; return; }
  if (!app.doc) return;
  update(app);
  if (!live()) {
    return;
  }
  await renderList(app, pending(app));
}

/** Renders track plug-ins now: before an export, or "Hear it now" for one track. onStatus(text, fraction). */
export async function renderPending(app, { trackId = null, onStatus = null } = {}) {
  clearTimeout(timer);
  update(app);
  const ids = pending(app, trackId);
  if (!ids.length) return 0;
  while (busy) await new Promise(r => setTimeout(r, 200));
  return renderList(app, ids, onStatus);
}

async function renderList(app, todo, onStatus) {
  if (!todo.length) { app.timeline?.render(); return 0; }
  busy = true;
  let done = 0, failed = 0;
  if (!onStatus) toast(`Rendering ${todo.length} clip${todo.length === 1 ? '' : 's'} through the track plug-ins…`, 3000);
  try {
    for (const [k, id] of todo.entries()) {
      const c = app.doc?.clips.find(x => x.id === id);
      if (!c || !c.fx?.dirty) continue;
      onStatus?.(`Your plug-ins: clip ${k + 1} of ${todo.length}…`, k / todo.length);
      try { await renderClip(app, c, f => onStatus?.(`Your plug-ins: clip ${k + 1} of ${todo.length}…`, (k + f) / todo.length)); done++; } catch (e) { failed++; console.warn('track plug-in render', e); if (failed === 1) toast(`A plug-in couldn’t render: ${e.message}`, 7000); }
    }
  } finally {
    busy = false;
    if (done && !onStatus) toast(`Track plug-ins applied to ${done} clip${done === 1 ? '' : 's'}.`, 2500);
    app.player?.syncPaused?.();
    if (again) { again = false; lastSig = ''; syncTrackPlugins(app); }
  }
  return done;
}

// ------------------------------------------------------------------ live (like a DAW)
// While a track plug-in's window is open, playing runs that track live through the open plug-in(s) in Reel's
// audio helper, so every change is heard as you make it. The track is silenced in the normal preview meanwhile;
// the helper follows the playhead from clip to clip. Closing the window goes back to normal.
let liveOn = null, liveClip = null, liveEnd = 0, liveT = -1, liveBusy = false;
const openSlots = (app, trackId) => [...app.fxEditing.entries()].filter(([, e]) => e.track === trackId).map(([slot]) => slot);
const liveTrack = app => { for (const e of app.fxEditing.values()) if (e.track) return e.track; return null; };

async function stopLive(app) {
  if (liveOn) { app.player?.silenceTrack?.(liveOn, false); }
  liveOn = null; liveClip = null; liveEnd = 0;
  try { await app.api.fxPreviewStop(); } catch { /* fine */ }
}

async function startLive(app, trackId, t) {
  const doc = app.doc, tr = doc?.tracks.find(x => x.id === trackId);
  const slots = openSlots(app, trackId);
  const c = doc?.clips.filter(x => x.track === trackId && x.type === 'media' && !x.disabled && hasSound(doc, x)).find(x => t >= x.start - 0.01 && t < clipEnd(x) - 0.05);
  app.player.silenceTrack(trackId, true);
  liveOn = trackId; liveClip = c?.id || null; liveEnd = c ? clipEnd(c) : Infinity;
  try { await app.api.fxPreviewStop(); } catch { /* fine */ }
  if (!c || !slots.length || !app.player.playing) return;
  const m = mediaById(doc, c.media);
  const source = await ensureSource(app, m);
  if (!app.player.playing || liveOn !== trackId) return;
  const now = app.player.time, from = sourceTime(c, now), secs = (clipEnd(c) - now) * (c.speed || 1);
  const gain = (c.audio?.mute ? 0 : c.audio?.volume ?? 1) * trackGainAt(tr, now) * (tr.muted ? 0 : 1);
  const mon = app.player.monitor || {};
  await app.api.fxPreviewPlugins(app.token, source, slots, from, Math.min(600, secs), mon.sinkLabel || '', gain);
}

// The LIVE banner: says plainly what's happening and what to do next, so nobody has to guess.
//   window open, stopped  → "▶ Press Space to hear <track> through <plug-in> while you turn its knobs"
//   window open, playing  → "● LIVE: you're hearing <track> through <plug-in> right now"
let banner = null, bannerKey = '';
function drawBanner(app) {
  const trackId = liveTrack(app);
  const doc = app.doc, tr = trackId && doc?.tracks.find(t => t.id === trackId);
  const names = trackId ? [...app.fxEditing.values()].filter(e => e.track === trackId).map(e => tr?.fx?.find(f => f.id === e.item)?.name).filter(Boolean) : [];
  const state = !tr ? '' : app.player.playing && liveOn === trackId && liveClip ? 'live' : app.player.playing ? 'gap' : 'ready';
  for (const b of document.querySelectorAll('.cs-fx.live-now')) b.classList.remove('live-now');
  if (state) for (const e of app.fxEditing.values()) if (e.track === trackId) document.querySelector(`.cs-fx[data-fx="${e.item}"]`)?.classList.add('live-now');
  const key = state + trackId + names.join();
  if (key === bannerKey) return;
  bannerKey = key;
  if (!state) { banner?.remove(); banner = null; return; }
  if (!banner) { banner = document.createElement('div'); banner.id = 'live-banner'; document.body.append(banner); }
  const tn = `“${tr.name || 'this track'}”`, pn = names.length ? names.join(' + ') : 'your plug-in';
  banner.className = state;
  banner.replaceChildren();
  const btn = (text, title, fn, cls = '') => { const b = document.createElement('button'); b.className = 'lb-btn ' + cls; b.textContent = text; b.title = title; b.onclick = fn; return b; };
  const msg = document.createElement('span'); msg.className = 'lb-msg';
  const lamp = document.createElement('i'); lamp.className = 'lb-lamp';
  if (state === 'ready') {
    msg.innerHTML = `<b>LISTEN LIVE</b> Press <kbd>Space</kbd> to hear ${esc(tn)} through <b>${esc(pn)}</b>. Turn its knobs while it plays: you hear every change right away.`;
    banner.append(lamp, msg, btn('▶ PLAY', 'Play and listen through the plug-in', () => app.player.play(), 'go'));
  } else if (state === 'live') {
    msg.innerHTML = `<b>LIVE</b> You’re hearing ${esc(tn)} through <b>${esc(pn)}</b> right now. Adjust it as it plays.`;
    banner.append(lamp, msg);
  } else {
    msg.innerHTML = `<b>LIVE</b> Waiting for ${esc(tn)}: there’s no sound on that track at the playhead.`;
    banner.append(lamp, msg);
  }
  banner.append(btn('RENDER INTO TRACK', 'Apply the plug-in to this track’s sound for good: its clips are rendered through it, and it comes off the strip (⌘Z undoes it)', () => bakeTrack(app, trackId)));
  banner.append(btn('CLOSE PLUG-IN', 'Close the plug-in window (your settings are kept) and go back to normal playback', () => closeTrackWindows(app, trackId)));
  const help = document.createElement('small');
  help.textContent = 'Only this track is live; the others play as usual. Leave it on the strip and it’s rendered at export, or RENDER INTO TRACK to apply it now.';
  banner.append(help);
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Starts the watcher (once): hands a track with an open plug-in window to the live player while playing. */
export function watchLive(app) {
  if (app._liveWatch) return;
  app._liveWatch = setInterval(async () => {
    if (liveBusy || !app.doc || !app.player) return;
    const want = app.player.playing ? liveTrack(app) : null, t = app.player.time;
    const jumped = liveT >= 0 && Math.abs(t - liveT) > 0.6; // a seek while playing
    liveT = app.player.playing ? t : -1;
    liveBusy = true;
    try {
      if (!want) { if (liveOn) await stopLive(app); }
      else if (want !== liveOn || jumped || t >= liveEnd - 0.03 || (!liveClip && app.doc.clips.some(x => x.track === want && t >= x.start && t < x.start + 0.4))) await startLive(app, want, t);
    } catch (e) { console.warn('live plug-ins', e); } finally { liveBusy = false; try { drawBanner(app); } catch (e) { console.warn('live banner', e); } }
  }, 150);
}

/**
 * Closes a track's plug-in windows and keeps their settings. (Closing from Reel used to throw the settings the
 * plug-in sent back away and leave Reel thinking the window was still open, so the LISTEN LIVE bar stayed up.)
 */
export async function closeTrackWindows(app, trackId) {
  for (const [slot, e] of [...app.fxEditing]) {
    if (e.track !== trackId) continue;
    let state = null;
    try { state = await app.api.fxEditClose(slot); } catch { /* the window was already gone */ }
    if (typeof state === 'string' && state) pluginEdited(app, { slot, state });
    else app.fxEditing.delete(slot);
  }
  bannerKey = '';
  try { drawBanner(app); } catch { /* fine */ }
}

/**
 * RENDER INTO TRACK: the track's plug-ins are applied to its sound clips for good. Each clip is rendered through
 * its effects and the track's plug-ins, then plays the rendered sound as its own media; the plug-ins come off the
 * strip, so nothing renders again. The originals stay in the media list, and ⌘Z puts everything back.
 * (Clips with picture keep the plug-in on the strip, rendered at export: their picture and sound are one file.)
 */
export async function bakeTrack(app, trackId) {
  const doc = app.doc, tr = trOf(app, trackId);
  if (!doc || !tr) return;
  const plugs = (tr.fx || []).filter(isAu);
  if (!plugs.length) { toast('There’s no plug-in on this track to render.'); return; }
  const names = plugs.map(f => f.name).join(' + ');
  const clips = doc.clips.filter(c => c.track === trackId && hasSound(doc, c));
  const soundOnly = clips.filter(c => c.audioOnly || mediaById(doc, c.media)?.kind === 'audio');
  if (!soundOnly.length) { toast('This track’s clips have picture too, so the plug-in stays on the strip and is applied at export.', 6000); return; }
  if (!(await ask('Render into the track?', `${names} will be applied to the sound of ${soundOnly.length} clip${soundOnly.length === 1 ? '' : 's'} on “${tr.name || 'this track'}” for good, and come off the strip. The original recordings stay in the media list, and ⌘Z undoes it.`, 'Render into track'))) return;
  await closeTrackWindows(app, trackId);
  toast(`Rendering “${tr.name || 'the track'}” through ${names}…`, 4000);
  await renderPending(app, { trackId });
  const fresh = app.doc;
  const ready = fresh.clips.filter(c => soundOnly.some(s => s.id === c.id) && c.fx?.file && !c.fx.dirty);
  if (!ready.length) { toast('The plug-in couldn’t render, so nothing was changed.', 6000); return; }
  app.commit(d => {
    for (const c of d.clips) {
      if (!ready.some(r => r.id === c.id)) continue;
      const m = mediaById(d, c.media);
      const nm = { id: uid('m'), file: c.fx.file, kind: 'audio', hasAudio: true, duration: m?.duration, name: `${m?.name || c.name || 'Sound'} (${names})`, role: m?.role, rendered: true };
      d.media.push(nm);
      c.media = nm.id; c.audioOnly = false;
      delete c.fx;
    }
    const t = d.tracks.find(x => x.id === trackId);
    if (t) t.fx = (t.fx || []).filter(f => !isAu(f));
  });
  lastSig = '';
  toast(`${names} is now part of the sound of ${ready.length} clip${ready.length === 1 ? '' : 's'}. ⌘Z undoes it.`, 5000);
}
