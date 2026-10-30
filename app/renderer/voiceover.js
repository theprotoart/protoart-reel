// Voice-over and punch-in (ScreenFlow's "Add Voice Over"): records your microphone while the edit plays
// from the playhead, and drops the take on a Voice-over track exactly where you said it. PUNCH IN
// re-records only between the In and Out marks: it plays a pre-roll of the old take, records, plays a
// little post-roll, and replaces just that part with short crossfades. Every take stays in the media list.
import { alignToGuide, guideUnder } from './clipops.js';
import { el, toast } from './ui.js';
import { audioDevices, fillSelect, permissionNote } from './devices.js';
import { uid, newMediaClip, split, clipEnd, duration, mediaById, isFree, addTrack } from './model.js';

const PREFS = 'reel.voiceover';
const readPrefs = () => { try { return { countdown: 3, preroll: 2, postroll: 1, mute: false, ...(JSON.parse(localStorage.getItem(PREFS) || '{}') || {}) }; } catch { return { countdown: 3, preroll: 2, postroll: 1, mute: false }; } };
const savePrefs = p => { try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch { /* fine */ } };
const recMic = () => { try { return (JSON.parse(localStorage.getItem('rec-settings') || '{}') || {}).micId || ''; } catch { return ''; } };
const FADE = 0.012; // seconds: enough to hide the splice, too short to hear

/** 32-bit float WAV header for `frames` samples of `ch` channels. */
export function wavHeader(frames, ch, rate) {
  const dataBytes = frames * ch * 4, h = new DataView(new ArrayBuffer(44));
  const str = (o, t) => { for (let i = 0; i < t.length; i++) h.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); h.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 3, true); h.setUint16(22, ch, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * ch * 4, true); h.setUint16(32, ch * 4, true); h.setUint16(34, 32, true);
  str(36, 'data'); h.setUint32(40, dataBytes, true);
  return new Uint8Array(h.buffer);
}

/**
 * Where a take goes and what it replaces. Pure, so it can be tested.
 * take: { start, skip, length } in seconds (skip = recorded audio before the take starts).
 * Returns the track id used. Punch: clears [start, start+length) on that track first.
 */
export function placeTake(doc, media, take, { punch = false, trackId = null } = {}) {
  let tr = trackId && doc.tracks.find(t => t.id === trackId) ? trackId : null;
  const s = take.start, e = take.start + take.length;
  if (!tr) tr = doc.tracks.find(t => /voice/i.test(t.name || '') && (punch || isFree(doc, t.id, s, take.length)))?.id || null;
  if (!tr) { const t = addTrack(doc); t.name = doc.tracks.some(x => x.name === 'Voice-over') ? `Voice-over ${doc.tracks.length}` : 'Voice-over'; tr = t.id; }
  if (punch) {
    // cut the old take at In and Out and lift the middle; the pieces either side get short fades
    for (const t of [s, e]) for (const c of doc.clips.filter(c => c.track === tr && c.start < t - 1e-6 && clipEnd(c) > t + 1e-6)) split(doc, t, [c.id]);
    const gone = new Set(doc.clips.filter(c => c.track === tr && c.start >= s - 1e-6 && clipEnd(c) <= e + 1e-6).map(c => c.id));
    doc.clips = doc.clips.filter(c => !gone.has(c.id));
    for (const c of doc.clips) {
      if (c.track !== tr || !c.audio) continue;
      if (Math.abs(clipEnd(c) - s) < 1e-3) c.audio.fadeOut = Math.max(c.audio.fadeOut || 0, FADE);
      if (Math.abs(c.start - e) < 1e-3) c.audio.fadeIn = Math.max(c.audio.fadeIn || 0, FADE);
    }
  } else if (!isFree(doc, tr, s, take.length)) {
    const t = addTrack(doc); t.name = `Voice-over ${doc.tracks.length}`; tr = t.id;
  }
  const c = newMediaClip(doc, media, tr, s);
  c.in = Math.max(0, take.skip);
  c.duration = Math.max(0.05, Math.min(take.length, (media.duration || take.length) - c.in));
  c.name = media.name;
  c.audio.voice = true;
  c.audio.fadeIn = punch ? FADE : 0; c.audio.fadeOut = punch ? FADE : 0;
  doc.clips.push(c);
  return { trackId: tr, clipId: c.id };
}

let open = null;
export function openVoiceOver(app, { punch = false } = {}) {
  if (!app.doc) return;
  if (open) { open.setMode(punch); return; }
  const prefs = readPrefs();
  let mode = punch ? 'punch' : 'normal', busy = false, cancelRec = null, stopRec = null;
  const micSel = el('select', { title: 'Microphone (the same choice as Settings and the Record window)' });
  const perm = permissionNote(() => fillMics().then(startMeter));
  const fillMics = async () => {
    const d = await audioDevices();
    perm.update(d);
    fillSelect(micSel, d.inputs, micSel.value || recMic(), d.defaultInput, 'Mac’s input');
  };
  micSel.addEventListener('change', () => { try { localStorage.setItem('rec-settings', JSON.stringify({ ...(JSON.parse(localStorage.getItem('rec-settings') || '{}') || {}), micId: micSel.value })); } catch { /* fine */ } startMeter(); });
  const meter = el('div', { class: 'vo-meter' }, el('i'));
  const status = el('div', { class: 'vo-status', text: '' });
  // after each take: listen, then keep it or throw it away (like ScreenFlow)
  const takeBar = el('div', { class: 'vo-take hidden' });
  let pendingTake = null;
  const settleTake = keepIt => {
    const t = pendingTake; pendingTake = null; takeBar.classList.add('hidden');
    if (!t) return;
    if (app.player.playing) app.player.toggle();
    if (keepIt) { status.textContent = `${t.label} kept. Record again for another take.`; return; }
    if (app.token === t.token) {
      app.commit(d => { for (const k of Object.keys(d)) delete d[k]; Object.assign(d, structuredClone(t.before)); });
      app.renderAll?.();
      app.api.deleteMedia?.(t.token, t.file).catch(() => {});
    }
    status.textContent = `${t.label} discarded. Press RECORD to try again.`;
  };
  const offerTake = t => {
    pendingTake = t;
    const play = el('button', { class: 'hw', text: '▶ PLAY TAKE', onclick: () => { app.seek(t.start); if (!app.player.playing) app.player.toggle(); } });
    takeBar.replaceChildren(el('span', { class: 'vo-take-q', text: `Keep ${t.label}?` }), play,
      el('button', { class: 'hw', text: 'DISCARD', title: 'Throw this take away (it’s removed from the timeline and the project)', onclick: () => settleTake(false) }),
      el('button', { class: 'hw role-export', text: 'KEEP', onclick: () => settleTake(true) }));
    takeBar.classList.remove('hidden');
  };
  const clock = el('div', { class: 'vo-clock led', text: '00:00.0' });
  const modeBtns = el('div', { class: 'vo-modes' },
    el('button', { class: 'tool', 'data-m': 'normal', text: '● FROM PLAYHEAD', title: 'Record from the playhead while the edit plays; stop when you’re done' }),
    el('button', { class: 'tool', 'data-m': 'punch', text: '⇥ PUNCH IN', title: 'Re-record only between In (I) and Out (O): pre-roll, record, post-roll, replace' }));
  modeBtns.addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (b && !busy) setMode(b.dataset.m === 'punch'); });
  const cd = el('select', {}, ...[[0, 'No countdown'], [3, '3-2-1'], [5, '5 s']].map(([v, t]) => el('option', { value: v, text: t, selected: Number(prefs.countdown) === v })));
  const pre = el('select', {}, ...[1, 2, 3, 5].map(v => el('option', { value: v, text: `${v} s pre-roll`, selected: Number(prefs.preroll) === v })));
  const mute = el('input', { type: 'checkbox', checked: !!prefs.mute });
  const adr = el('input', { type: 'checkbox', checked: !!prefs.adr });
  adr.addEventListener('change', () => { prefs.adr = adr.checked; savePrefs(prefs); });
  const keep = () => { prefs.countdown = Number(cd.value); prefs.preroll = Number(pre.value); prefs.mute = mute.checked; savePrefs(prefs); };
  for (const x of [cd, pre, mute]) x.addEventListener('change', keep);
  const recBtn = el('button', { class: 'rec-btn big vo-rec' }, el('span', { class: 'dot' }), el('span', { class: 'lbl', text: 'RECORD' }));
  const head = el('div', { class: 'vo-head' }, el('b', { text: 'VOICE OVER' }), el('span', { class: 'spacer' }), el('button', { class: 'mini', text: '×', title: 'Close (Esc while not recording)', onclick: () => close() }));
  const punchRow = el('div', { class: 'vo-row vo-punch' }, pre, el('span', { class: 'note', text: 'Mark In (I) and Out (O) on the timeline first.' }));
  const panel = el('div', { class: 'vo-panel' }, head,
    modeBtns,
    el('div', { class: 'vo-row' }, el('label', { text: 'Mic' }), micSel),
    el('div', { class: 'vo-row' }, el('label', { text: 'Level' }), meter),
    perm,
    el('div', { class: 'vo-row' }, cd, el('label', { class: 'chk', title: 'Turn the edit’s sound off while you record (when you’re not on headphones, so it doesn’t leak into the mic)' }, mute, el('span', { text: 'Mute the edit' }))),
    punchRow,
    el('label', { class: 'vo-row chk', title: 'For ADR (replacing dialogue): after each take, Reel lines it up syllable by syllable with the original line under it, so it matches the lips' }, adr, el('span', { text: 'ADR: align each take to the original dialogue' })),
    el('div', { class: 'vo-go' }, recBtn, clock),
    status, takeBar);
  document.body.append(panel);

  // drag by the header
  head.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const r = panel.getBoundingClientRect(), x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const mv = ev => { panel.style.left = Math.max(0, Math.min(innerWidth - r.width, ev.clientX - x0)) + 'px'; panel.style.top = Math.max(0, Math.min(innerHeight - 40, ev.clientY - y0)) + 'px'; panel.style.right = 'auto'; panel.style.bottom = 'auto'; };
    const up = () => { head.removeEventListener('pointermove', mv); head.removeEventListener('pointerup', up); };
    head.addEventListener('pointermove', mv); head.addEventListener('pointerup', up);
  });

  // live input level (also while recording, from the capture itself)
  let mStream = null, mCtx = null, mRaf = 0;
  const showLevel = p => { meter.firstChild.style.width = Math.min(100, Math.sqrt(p) * 100) + '%'; meter.classList.toggle('hot', p > 0.89); };
  const stopMeter = () => { cancelAnimationFrame(mRaf); mStream?.getTracks().forEach(t => t.stop()); mStream = null; mCtx?.close().catch(() => {}); mCtx = null; };
  const startMeter = async () => {
    stopMeter();
    if (busy) return;
    try {
      mStream = await navigator.mediaDevices.getUserMedia({ audio: micSel.value ? { deviceId: { exact: micSel.value }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } : { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      mCtx = new AudioContext(); const an = mCtx.createAnalyser(); an.fftSize = 1024; mCtx.createMediaStreamSource(mStream).connect(an);
      const buf = new Float32Array(1024);
      const tick = () => { an.getFloatTimeDomainData(buf); let p = 0; for (const v of buf) p = Math.max(p, Math.abs(v)); showLevel(p); mRaf = requestAnimationFrame(tick); };
      tick();
    } catch { status.textContent = 'The microphone isn’t available. Allow it in System Settings › Privacy & Security › Microphone.'; }
  };

  const range = () => { const r = app.doc?.range; return r && r.out > (r.in || 0) + 0.1 ? { in: r.in || 0, out: r.out } : null; };
  function setMode(p) {
    mode = p ? 'punch' : 'normal';
    for (const b of modeBtns.children) b.classList.toggle('lit', b.dataset.m === mode);
    punchRow.classList.toggle('hidden', mode !== 'punch');
    const r = range();
    status.textContent = mode === 'punch'
      ? (r ? `Punch in ${r.in.toFixed(1)} s → ${r.out.toFixed(1)} s. You’ll hear the pre-roll, then record until Out.` : 'Set In (I) and Out (O) around the part to redo.')
      : `Records from ${app.player.time.toFixed(1)} s while the edit plays. Space or STOP ends it, Esc throws it away.`;
  }

  const keys = e => {
    if (!busy) { if (e.key === 'Escape' && !e.target.closest('input,select,textarea')) { e.preventDefault(); close(); } return; }
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); stopRec?.(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancelRec?.(); }
  };
  window.addEventListener('keydown', keys, true);

  recBtn.addEventListener('click', () => { if (busy) stopRec?.(); else record(); });

  async function record() {
    const api = app.api, doc = app.doc, token = app.token;
    const r = range();
    if (mode === 'punch' && !r) { toast('Mark In (I) and Out (O) around the part to re-record first.'); return; }
    keep();
    busy = true; panel.classList.add('recording'); recBtn.querySelector('.lbl').textContent = 'STOP';
    stopMeter();
    const wasMuted = !!app.player.monitor?.mute;
    let stream = null, ctx = null, node = null, rid = null, frames = 0, finished = false, playFrom = 0, pCap = 0, pPlay = 0, aborted = false;
    stopRec = cancelRec = () => { aborted = true; }; // during set-up and the countdown either one cancels
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return; cleaned = true;
      try { node?.port.postMessage('stop'); } catch { /* gone */ }
      stream?.getTracks().forEach(t => t.stop()); ctx?.close().catch(() => {});
      if (app.player.playing) app.player.pause();
      if (prefs.mute && !wasMuted) app.player.setMonitor({ mute: false });
      busy = false; panel.classList.remove('recording'); recBtn.querySelector('.lbl').textContent = 'RECORD'; clock.classList.remove('count');
      stopRec = cancelRec = null;
    };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: micSel.value ? { exact: micSel.value } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
      ctx = new AudioContext({ sampleRate: 48000 });
      await ctx.audioWorklet.addModule('rec-worklet.js');
      const src = ctx.createMediaStreamSource(stream);
      node = new AudioWorkletNode(ctx, 'rec-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit', processorOptions: { channels: 1 } });
      const sink = ctx.createGain(); sink.gain.value = 0; src.connect(node); node.connect(sink); sink.connect(ctx.destination);
      const n = (doc.media.filter(m => m.voTake).length || 0) + 1;
      const label = `Voice-over ${n}`;
      rid = (await api.renderBegin(token, label, 'wav')).id;
      let stopped = null;
      const done = new Promise(res => { stopped = res; });
      node.port.onmessage = e => {
        const m = e.data;
        if (m.level !== undefined) showLevel(m.level);
        if (m.started !== undefined) pCap = performance.now();
        if (m.data) { frames += m.data.length; api.renderChunk(rid, new Uint8Array(m.data.buffer)); }
        if (m.stopped) stopped();
      };
      // countdown (normal) or straight into the pre-roll (punch: the pre-roll is the countdown)
      if (mode === 'normal' && Number(cd.value) > 0) {
        for (let i = Number(cd.value); i > 0; i--) { clock.textContent = String(i); clock.classList.add('count'); await new Promise(res => setTimeout(res, 1000)); if (aborted) break; }
        clock.classList.remove('count');
      }
      if (aborted) throw new Error('Cancelled');
      playFrom = mode === 'punch' ? Math.max(0, r.in - Number(pre.value)) : app.player.time;
      app.player.seek(playFrom);
      if (prefs.mute && !wasMuted) app.player.setMonitor({ mute: true });
      node.port.postMessage('start');
      await new Promise(res => { const t = setInterval(() => { if (pCap) { clearInterval(t); res(); } }, 5); setTimeout(() => { clearInterval(t); res(); }, 500); });
      if (!pCap) pCap = performance.now();
      const atEnd = playFrom >= duration(doc) - 0.05;
      if (!atEnd) app.player.play();
      pPlay = performance.now();
      status.textContent = mode === 'punch' ? 'Pre-roll…' : 'Recording. Space or STOP ends it, Esc throws it away.';
      // stop: by hand, or (punch) automatically after Out + post-roll
      const endAt = mode === 'punch' ? r.out + Number(prefs.postroll || 1) : Infinity;
      await new Promise(res => {
        stopRec = () => res('stop');
        cancelRec = () => { finished = 'cancel'; res('cancel'); };
        const t0 = performance.now();
        const tick = () => {
          if (!busy) return res('stop');
          const secs = (performance.now() - t0) / 1000;
          const now = playFrom + secs;
          clock.textContent = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${(secs % 60).toFixed(1).padStart(4, '0')}`;
          if (mode === 'punch') {
            const inPunch = now >= r.in && now < r.out;
            panel.classList.toggle('live', inPunch);
            status.textContent = now < r.in ? `Pre-roll… ${(r.in - now).toFixed(1)}` : inPunch ? `RECORDING · ${(r.out - now).toFixed(1)} s to Out` : 'Post-roll…';
            if (now >= endAt) return res('stop');
          } else panel.classList.add('live');
          requestAnimationFrame(tick);
        };
        tick();
      });
      panel.classList.remove('live');
      node.port.postMessage('stop');
      await Promise.race([done, new Promise(res => setTimeout(res, 1500))]);
      if (finished === 'cancel') { await api.renderCancel(rid); rid = null; cleanup(); status.textContent = 'Take thrown away.'; setTimeout(startMeter, 200); return; }
      cleanup();
      if (frames < 4800) { await api.renderCancel(rid); status.textContent = 'That take was too short.'; setTimeout(startMeter, 200); return; }
      const info = await api.renderFinish(rid, wavHeader(frames, 1, 48000));
      rid = null;
      if (app.token !== token) return;
      // the voice arrives late by the output + input latency; skip that, plus any audio before playback began
      const lat = (app.player.actx?.outputLatency || app.player.actx?.baseLatency || 0) + (ctx.baseLatency || 0);
      const lead = Math.max(0, (pPlay - pCap) / 1000) + (atEndFix(playFrom, doc) ? 0 : lat);
      const recorded = frames / 48000;
      const m = { id: uid('m'), ...info, name: `${label}${mode === 'punch' ? ' (punch)' : ''}`, role: 'mic', voTake: n };
      let placed = null;
      if (pendingTake) settleTake(true); // recording again keeps the last take
      const before = structuredClone(app.doc);
      const selTrack = mode === 'punch' ? (doc.clips.find(c => app.selection.clips.includes(c.id) && c.type === 'media' && (c.audioOnly || mediaById(doc, c.media)?.kind === 'audio'))?.track || null) : null;
      app.commit(d => {
        d.media.push(m);
        const take = mode === 'punch'
          ? { start: r.in, skip: lead + (r.in - playFrom), length: r.out - r.in }
          : { start: playFrom, skip: lead, length: Math.max(0.1, recorded - lead) };
        placed = placeTake(d, m, take, { punch: mode === 'punch', trackId: selTrack });
      });
      app.select([placed.clipId], null);
      if (adr.checked) {
        const takeClip = app.doc.clips.find(c => c.id === placed.clipId), guide = takeClip && guideUnder(app.doc, takeClip);
        if (guide) setTimeout(() => alignToGuide(app, { guide, take: takeClip }), 300);
        else toast('ADR: there’s no original dialogue under this take to align it to.', 5000);
      }
      status.textContent = mode === 'punch' ? `Punched in ${r.in.toFixed(1)}–${r.out.toFixed(1)} s.` : `${label} recorded (${recorded.toFixed(1)} s).`;
      offerTake({ before, token, file: m.file, label: mode === 'punch' ? 'this punch-in' : label, start: mode === 'punch' ? Math.max(0, r.in - 1) : playFrom });
      toast(mode === 'punch' ? 'Punch-in done.' : `${label} is on the timeline.`);
      setTimeout(startMeter, 200);
    } catch (e) {
      if (rid) api.renderCancel(rid).catch(() => {});
      cleanup();
      if (/Cancelled/.test(e.message || '')) status.textContent = 'Cancelled.';
      if (!/Cancelled/.test(e.message || '')) { status.textContent = e.message; toast(`Voice-over: ${e.message}`, 5000); }
      setTimeout(startMeter, 200);
    }
  }
  const atEndFix = (t, doc) => t >= duration(doc) - 0.05; // nothing played: no output latency to remove

  function close() {
    if (busy) { cancelRec?.(); return; }
    if (pendingTake) settleTake(true); // closing keeps the last take
    stopMeter(); window.removeEventListener('keydown', keys, true);
    navigator.mediaDevices.removeEventListener?.('devicechange', fillMics); window.removeEventListener('focus', fillMics);
    panel.remove(); open = null;
  }
  navigator.mediaDevices.addEventListener?.('devicechange', fillMics);
  window.addEventListener('focus', fillMics);
  open = { setMode, close };
  fillMics().then(startMeter);
  setMode(mode === 'punch');
}
export function closeVoiceOver() { open?.close(); }
