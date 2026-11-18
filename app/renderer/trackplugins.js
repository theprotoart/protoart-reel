// Your own plug-ins (Audio Units: Waves, iZotope, FabFilter…) as inserts on a track's channel strip. Plug-ins
// can't run live inside the preview, so Reel renders each clip on the track through the track's plug-ins (after
// the clip's own effects) in the background, and plays the rendered sound. Changing a plug-in's settings,
// bypassing, removing or undoing it, or moving a clip to another track, renders again. The strip shows the
// plug-in like any insert; click it to open its window.
import { toast, el } from './ui.js';
import { plainError } from './fx.js';
import { mediaById, uid } from './model.js';
import { renderClip, pickPlugin, ensureSource, pluginEdited, captureOpenPlugins } from './fx.js';
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
  catch (e) { app.fxEditing.delete(slot); toast(plainError(e), 7000); }
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
  await captureOpenPlugins(app); // use the settings in any plug-in window that's still open
  update(app);
  // a background render may already be going: wait for it, saying so (it used to sit on "Starting…")
  for (let waited = 0; busy; waited += 200) {
    onStatus?.(`Waiting for the plug-in render that’s already running… ${Math.round(waited / 1000)} s`, 0);
    await new Promise(r => setTimeout(r, 200));
  }
  const ids = pending(app, trackId);
  if (!ids.length) return 0;
  return renderList(app, ids, onStatus);
}

// A render running on its own (after a plug-in is added or changed) shows a strip over the timeline: which plug-in,
// which track, clip n of N, a bar, about how long is left, and STOP (what's left renders at export instead).
let strip = null, stopAsked = false;
export function showStrip(app, todo) {
  strip?.remove();
  const c0 = app.doc?.clips.find(x => x.id === todo[0]);
  const tr = c0 && app.doc.tracks.find(t => t.id === c0.track);
  const names = (tr?.fx || []).filter(isAu).map(f => f.name).join(' + ') || 'the track plug-ins';
  const fill = el('i'), text = el('span', { class: 'ps-text' });
  const stop = el('button', { class: 'hw ps-stop', type: 'button', text: 'STOP', title: 'Stop rendering now: the clips not done yet are rendered at export instead (or when you play them through the open plug-in)', onclick: () => { stopAsked = true; stop.disabled = true; stop.textContent = 'STOPPING…'; } });
  strip = el('div', { class: 'plug-strip', role: 'status' },
    el('b', { text: `🎛 Rendering ${names}${tr?.name ? ` on “${tr.name}”` : ''}` }), text,
    el('div', { class: 'ps-bar' }, fill), stop);
  document.body.append(strip);
  // over the top of the timeline, where the clips being rendered are
  const tl = document.getElementById('timeline')?.getBoundingClientRect();
  if (tl && tl.height) strip.style.top = `${Math.round(tl.top + 34)}px`;
  const t0 = performance.now();
  return (k, f) => {
    const v = Math.min(1, (k + f) / todo.length), secs = (performance.now() - t0) / 1000;
    const left = v > 0.03 && secs > 5 ? secs / v * (1 - v) : null;
    fill.style.width = `${Math.max(2, Math.round(v * 100))}%`;
    text.textContent = `clip ${Math.min(k + 1, todo.length)} of ${todo.length} · ${Math.round(v * 100)}%${left == null ? '' : left < 50 ? ' · under a minute left' : ` · about ${Math.round(left / 60)} min left`}`;
  };
}

async function renderList(app, todo, onStatus) {
  if (!todo.length) { app.timeline?.render(); return 0; }
  busy = true; stopAsked = false;
  let done = 0, failed = 0;
  const show = onStatus ? null : showStrip(app, todo);
  const say = (k, f) => { onStatus?.(`Your plug-ins: clip ${k + 1} of ${todo.length}…`, (k + f) / todo.length); show?.(k, f); };
  try {
    for (const [k, id] of todo.entries()) {
      if (stopAsked) break;
      const c = app.doc?.clips.find(x => x.id === id);
      if (!c || !c.fx?.dirty) continue;
      say(k, 0);
      try { await renderClip(app, c, f => say(k, f)); done++; }
      catch (e) {
        failed++; console.warn('track plug-in render', e);
        if (failed === 1) toast(`A plug-in couldn’t render: ${plainError(e)}`, 8000);
        // the same chain would fail the same way on every clip (and a crashing plug-in would crash again): stop here
        if (/host stopped|can’t process|didn’t respond/.test(e.message) || failed >= 3) break;
      }
    }
  } finally {
    busy = false;
    if (show) { strip?.remove(); strip = null; }
    if (!onStatus && (stopAsked || done)) toast(stopAsked ? `Stopped: ${done} clip${done === 1 ? '' : 's'} rendered; the rest render at export.` : `✓ Track plug-ins applied to ${done} clip${done === 1 ? '' : 's'}.`, stopAsked ? 5000 : 3000);
    if (stopAsked) { stopAsked = false; again = false; }
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
  banner.append(btn('RENDER INTO TRACK', 'Render this track through its plug-ins onto a new track below it (like Pro Tools): the original clips are muted and kept. A window shows the progress; ⌘Z undoes it', () => bakeTrack(app, trackId)));
  banner.append(btn('CLOSE PLUG-IN', 'Close the plug-in window (your settings are kept) and go back to normal playback', () => closeTrackWindows(app, trackId)));
  const help = document.createElement('small');
  help.textContent = 'Only this track is live; the others play as usual. Leave it on the strip and it’s rendered at export, or RENDER INTO TRACK to make a rendered copy on a new track below (the original is muted).';
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
 * RENDER INTO TRACK, the way Pro Tools commits a track: the track's sound is rendered through its plug-ins and effects
 * onto a NEW track right below it ("… rendered"), and the original clips are muted and greyed out (kept, with the
 * plug-in still on their strip, to go back to). A window shows how far it has got. ⌘Z, or right-click › Back to the
 * original sound, undoes it.
 */
export async function bakeTrack(app, trackId) {
  const doc = app.doc, tr = trOf(app, trackId);
  if (!doc || !tr) return;
  const plugs = (tr.fx || []).filter(isAu);
  if (!plugs.length) { toast('There’s no plug-in on this track to render.'); return; }
  if (!doc.clips.some(c => c.track === trackId && hasSound(doc, c))) { toast('There’s no sound on this track to render.'); return; }
  await closeTrackWindows(app, trackId);
  const { bounceTrack } = await import('./bounce.js');
  await bounceTrack(app, tr);
  lastSig = '';
}
