// Recording: pick a screen or window, camera, microphone and computer audio; count down;
// record each source to its own file (like ScreenFlow), then lay them out on the timeline.
import { el, $, modal, toast } from './ui.js';
import { audioDevices, fillSelect, permissionNote } from './devices.js';
import { can, gate } from './capability.js';

const MP4_TYPES = ['video/mp4;codecs=avc1.640033,mp4a.40.2', 'video/mp4;codecs=avc1.640033', 'video/mp4;codecs=avc1.64002a', 'video/mp4;codecs=avc1', 'video/mp4'];
const pickType = () => MP4_TYPES.find(t => MediaRecorder.isTypeSupported(t)) || '';
const MAX = { native: [7680, 4320], '4k': [3840, 2160], '1440': [2560, 1440], '1080': [1920, 1080] };

export async function openRecorder(app) {
  const api = app.api;
  if (!MediaRecorder.isTypeSupported('video/mp4')) { toast('This system can’t record MP4 video.'); return; }
  const perms = await api.permissions();
  const st = { source: null, camera: false, cameraId: '', mic: true, micId: '', system: true, sysMode: 'all', apps: [], countdown: 3, hide: true, fps: 30, max: '4k', clicks: true, keys: false, stopAfter: 0 };
  try { Object.assign(st, JSON.parse(localStorage.getItem('rec-settings') || '{}'), { source: null }); } catch { /* defaults */ }

  let sources = [];
  const grid = el('div', { class: 'src-grid' }, el('div', { class: 'note', text: 'Looking for screens and windows…' }));
  const warn = el('div');
  if (perms.screen !== 'granted') {
    warn.append(el('div', { class: 'warn' }, 'macOS needs to allow ProtoArt Reel to record the screen. If nothing shows below, turn it on in System Settings › Privacy & Security › Screen & System Audio Recording, then reopen Reel. ',
      el('button', { class: 'mini', text: 'Open settings', onclick: () => api.openPrivacy('screen') })));
  }
  const camSel = el('select'), micSel = el('select');
  const camPrev = el('video', { muted: true, autoplay: true, playsInline: true, style: { width: '100%', borderRadius: '6px', background: '#000', aspectRatio: '16/9', display: st.camera ? 'block' : 'none', marginTop: '6px' } });
  const meter = el('div', { class: 'meter' }, el('i'));
  const sw = (key, label, onChange) => {
    const input = el('input', { type: 'checkbox', class: 'switch', checked: !!st[key] });
    input.addEventListener('change', () => { st[key] = input.checked; onChange && onChange(); });
    return el('div', { class: 'row' }, el('label', { text: label }), input);
  };
  let previewStreams = [];
  const stopPreviews = () => { for (const s of previewStreams) s.getTracks().forEach(t => t.stop()); previewStreams = []; };
  let meterCtx = null;
  const startPreviews = async () => {
    stopPreviews();
    if (meterCtx) { meterCtx.close(); meterCtx = null; }
    if (st.camera) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: st.cameraId ? { deviceId: { exact: st.cameraId } } : true });
        previewStreams.push(s); camPrev.srcObject = s; camPrev.style.display = 'block';
      } catch { camPrev.style.display = 'none'; toast('The camera isn’t available.'); }
    } else camPrev.style.display = 'none';
    if (st.mic) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: st.micId ? { deviceId: { exact: st.micId } } : true });
        previewStreams.push(s);
        meterCtx = new AudioContext();
        const an = meterCtx.createAnalyser(); an.fftSize = 1024;
        meterCtx.createMediaStreamSource(s).connect(an);
        const buf = new Float32Array(an.fftSize);
        const tick = () => {
          if (!meterCtx) return;
          an.getFloatTimeDomainData(buf);
          let p = 0; for (const v of buf) p = Math.max(p, Math.abs(v));
          meter.firstChild.style.width = Math.min(100, Math.sqrt(p) * 100) + '%';
          requestAnimationFrame(tick);
        };
        tick();
      } catch { toast('The microphone isn’t available.'); }
    }
  };
  // microphone / interface input, which input of it, sample rate, and where you hear Reel
  const chanSel = el('select', { title: 'An interface like a Scarlett Solo has input 1 (the mic socket) and input 2 (instrument). Recording one input as mono keeps your voice centred.' },
    ...[['auto', 'Input 1 (mono)'], ['2', 'Input 2 (mono)'], ['mix', 'Inputs 1 + 2 mixed (mono)'], ['stereo', 'Both, as stereo']].map(([v, t]) => el('option', { value: v, text: t, selected: (st.micInput || 'auto') === v })));
  chanSel.addEventListener('change', () => { st.micInput = chanSel.value; });
  const rateSel = el('select', {}, ...[[44100, '44.1 kHz'], [48000, '48 kHz (video standard)'], [96000, '96 kHz']].map(([v, t]) => el('option', { value: v, text: t, selected: Number(st.recRate || 48000) === v })));
  rateSel.addEventListener('change', () => { st.recRate = Number(rateSel.value); });
  const outSel = el('select', { title: 'Where you hear Reel: the Mac’s speakers, headphones, or an audio interface. The same as Settings › Audio Hardware and MONITOR OUT in the mixer.' });
  outSel.addEventListener('change', () => app.player.setMonitor({ sink: outSel.value, sinkLabel: (outSel.value ? outSel.selectedOptions[0]?.textContent : '') || '' }));
  const perm = permissionNote(() => fillDevices().then(startPreviews), { short: true });
  const fillDevices = async () => {
    const d = await audioDevices();
    perm.update(d);
    fillSelect(micSel, d.inputs, st.micId || '', d.defaultInput, 'Mac’s input');
    fillSelect(outSel, d.outputs, app.player.monitor?.sink || '', d.defaultOutput, 'Mac’s output');
    st.micId = micSel.value;
    const devs = await navigator.mediaDevices.enumerateDevices();
    camSel.replaceChildren(...devs.filter(x => x.kind === 'videoinput').map((x, i) => el('option', { value: x.deviceId, text: x.label || `Camera ${i + 1}`, selected: x.deviceId === st.cameraId })));
    if (!st.cameraId && camSel.value) st.cameraId = camSel.value;
  };
  camSel.addEventListener('change', () => { st.cameraId = camSel.value; startPreviews(); });
  micSel.addEventListener('change', () => { st.micId = micSel.value; startPreviews(); });

  // a few settings need more memory than an 8 GB Mac has: they stay visible, greyed out, with the reason
  if (!can('recFull').ok && st.max === 'native') st.max = '4k';
  const fpsSel = el('select', {}, el('option', { value: 30, text: '30 fps', selected: st.fps === 30 }), el('option', { value: 60, text: '60 fps', selected: st.fps === 60 }));
  fpsSel.addEventListener('change', () => { st.fps = Number(fpsSel.value); });
  const maxSel = el('select', {}, ...[['native', 'Full resolution'], ['4k', 'Up to 4K'], ['1440', 'Up to 1440p'], ['1080', 'Up to 1080p']].map(([v, t]) => {
    const o = el('option', { value: v, text: t, selected: st.max === v });
    return v === 'native' ? gate(o, 'recFull') : o;
  }));
  const fpsRule = () => {
    const big = st.max === 'native' || st.max === '4k', r = can('rec4k60'), o = fpsSel.options[1];
    o.disabled = big && !r.ok; o.textContent = o.disabled ? '60 fps — needs 16 GB at 4K (pick 1440p for 60)' : '60 fps'; o.title = o.disabled ? r.why : '';
    if (o.disabled && st.fps === 60) { st.fps = 30; fpsSel.value = '30'; }
  };
  maxSel.addEventListener('change', () => { st.max = maxSel.value; fpsRule(); });
  fpsRule();

  // Computer audio: everything (one track), or chosen apps (one track each, Loopback-style)
  const appList = el('div', { class: 'app-checks' });
  const sysNote = el('p', { class: 'note' });
  const perApp = await api.audioAvailable().catch(() => false);
  const modeSeg = el('div', { class: 'seg' });
  const setMode = m => {
    st.sysMode = m; st.system = m === 'all';
    for (const b of modeSeg.children) b.classList.toggle('on', b.dataset.v === m);
    appList.style.display = m === 'apps' ? '' : 'none';
    sysNote.textContent = m === 'off' ? 'No computer sound.' : m === 'all' ? 'Everything your Mac plays, on one track.' : 'Only the apps you tick, each on its own track. Notifications and other apps stay out.';
    if (m === 'apps') fillApps();
  };
  for (const [v, t] of [['off', 'Off'], ['all', 'All sound'], ...(perApp ? [['apps', 'Chosen apps']] : [])]) modeSeg.append(el('button', { 'data-v': v, text: t, onclick: () => setMode(v) }));
  const fillApps = async () => {
    appList.replaceChildren(el('p', { class: 'note', text: 'Looking for apps…' }));
    try {
      const { apps } = await api.audioList();
      appList.replaceChildren();
      if (!apps.length) appList.append(el('p', { class: 'note', text: 'No apps are using sound right now. Start playing something, then reopen this.' }));
      for (const a of apps) {
        const c = el('input', { type: 'checkbox', checked: st.apps.includes(a.key) });
        c.addEventListener('change', () => { st.apps = c.checked ? [...new Set([...st.apps, a.key])] : st.apps.filter(k => k !== a.key); st.appNames = { ...(st.appNames || {}), [a.key]: a.name }; });
        st.appNames = { ...(st.appNames || {}), [a.key]: a.name };
        appList.append(el('label', { class: 'row app-row' }, c, a.icon ? el('img', { src: a.icon, width: 18, height: 18 }) : el('span', { text: '♪' }), el('span', { text: a.name + (a.active ? '' : '  (quiet)') })));
      }
    } catch (e) { appList.replaceChildren(el('p', { class: 'note', text: e.message })); }
  };
  const sysBox = el('div', { class: 'opt' }, el('div', { class: 'row' }, el('label', { text: 'Computer audio' })), modeSeg, sysNote, appList);
  setMode(st.sysMode === 'apps' && !perApp ? 'all' : st.sysMode || (st.system ? 'all' : 'off'));

  const body = el('div', {},
    warn,
    el('div', { class: 'engr', text: 'What to record', style: { marginBottom: '8px' } }),
    grid,
    el('div', { class: 'rec-opts' },
      el('div', { class: 'opt' }, sw('camera', 'Camera', async () => { if (st.camera) await api.askAccess('camera'); await fillDevices(); startPreviews(); }), el('div', { class: 'row' }, camSel), camPrev),
      el('div', { class: 'opt' }, sw('mic', 'Microphone', async () => { if (st.mic) await api.askAccess('microphone'); await fillDevices(); startPreviews(); }), el('div', { class: 'row' }, micSel), meter, perm,
        el('div', { class: 'row' }, el('label', { text: 'Input' }), chanSel),
        el('div', { class: 'row' }, el('label', { text: 'Sample rate' }), rateSel),
        el('div', { class: 'row' }, el('label', { text: 'Monitor' }), outSel)),
      sysBox,
      el('div', { class: 'opt' },
        el('div', { class: 'row' }, el('label', { text: 'Frame rate' }), fpsSel),
        el('div', { class: 'row' }, el('label', { text: 'Size' }), maxSel),
        sw('hide', 'Hide Reel while recording'),
        el('p', { class: 'note', text: 'Messed up a line? Clap three times (or press ⌥⇧⌘M / MARK on the floating panel) and say it again: the recording is split into takes, to keep or drop in ✂ TAKES. Pause and resume with PAUSE on the panel that floats at the bottom of the screen, ⌥⇧⌘2, or the Reel icon in the menu bar. Stop with STOP there, or ⇧⌘2.' })),
      el('div', { class: 'opt' },
        sw('clicks', 'Record clicks', null),
        el('p', { class: 'note', text: 'For click sounds and click effects. macOS asks once for Input Monitoring.' }),
        sw('pointerSeparate', 'Keep the pointer editable', null),
        el('p', { class: 'note', text: 'Records the pointer separately so you can hide, enlarge or restyle it later.' }),
        sw('keys', 'Record keystrokes', null),
        el('p', { class: 'note', text: 'Only for the on-screen keystroke display, kept inside this project. Passwords typed into password fields are never seen (macOS hides them).' }),
        (() => {
          const sel = el('select', {}, ...[[0, 'Never'], [1, '1 minute'], [5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [120, '2 hours']].map(([v, t]) => el('option', { value: v, text: t, selected: Number(st.stopAfter) === v })));
          sel.addEventListener('change', () => { st.stopAfter = Number(sel.value); });
          return el('div', { class: 'row' }, el('label', { text: 'Stop after' }), sel);
        })()),
    ),
  );
  const dlg = modal('New recording', body, [
    { label: 'Cancel', onClick: c => c() },
    { label: 'Start recording', cls: 'hw amber', id: 'rec-start', onClick: async (c, btn) => {
      if (!st.source) { toast(sources.length ? 'Pick a screen or window first.' : 'Reel can’t see any screens yet: see the yellow note at the top of this window.', 6000); grid.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      btn.disabled = true;
      if (st.sysMode === 'apps' && !st.apps.length) { toast('Tick at least one app, or choose All sound.'); btn.disabled = false; return; }
      localStorage.setItem('rec-settings', JSON.stringify({ ...st, source: null, lastSource: { kind: st.source.kind, name: st.source.name, displayId: st.source.displayId || '' } }));
      stopPreviews();
      c();
      try { await record(app, st); } catch (e) { toast(`Recording failed: ${e.message}`, 6000); app.showWindowAfterFailure && app.showWindowAfterFailure(); }
    } },
  ], { wide: true, onClose: () => { stopPreviews(); if (meterCtx) { meterCtx.close(); meterCtx = null; } } });
  void dlg;

  // Screens first and on their own: a macOS permission prompt for the microphone or camera that nobody
  // has answered yet must not leave this window stuck on "Looking for screens…".
  const withTimeout = (p, ms, fallback) => Promise.race([p, new Promise(r => setTimeout(() => r(fallback), ms))]);
  (async () => {
    try {
      const asks = [];
      if (st.mic) asks.push(api.askAccess('microphone'));
      if (st.camera) asks.push(api.askAccess('camera'));
      const answered = await withTimeout(Promise.all(asks).then(() => true), 15000, false);
      if (!answered) toast('macOS is waiting for you to allow the microphone or camera: look for its window (it may be behind this one).', 8000);
      await fillDevices();
      startPreviews();
    } catch { /* fine */ }
  })();
  sources = await withTimeout(api.sources().catch(() => []), 10000, null);
  if (sources === null) {
    sources = [];
    grid.replaceChildren(el('div', { class: 'warn', style: { gridColumn: '1 / -1' } },
      'macOS didn’t answer when Reel asked for the list of screens. Usually that means Screen Recording permission is still waiting or belongs to an older build of Reel: open System Settings › Privacy & Security › Screen & System Audio Recording, remove ProtoArt Reel with −, quit and reopen Reel, and press Allow. ',
      el('button', { class: 'mini', text: 'Open settings', onclick: () => api.openPrivacy('screen') })));
    return;
  }
  grid.replaceChildren();
  // After every rebuild macOS treats Reel as a new app: Settings can still show it switched on while
  // the permission no longer applies, and then no screens come back. Say exactly how to fix that.
  const stale = () => el('div', { class: 'warn', style: { gridColumn: '1 / -1' } },
    'macOS isn’t letting Reel see the screen. This happens after Reel is rebuilt, even when Settings shows it switched on: open System Settings › Privacy & Security › Screen & System Audio Recording, select ProtoArt Reel, press − to remove it, then quit and reopen Reel and press Allow when macOS asks. ',
    el('button', { class: 'mini', text: 'Open settings', onclick: () => api.openPrivacy('screen') }));
  if (!sources.length) grid.append(stale());
  else if (!sources.some(x => x.thumbnail)) grid.append(stale()); // listed but blank pictures: same cause
  // what you recorded last time (the same screen, or the same app's window), else the first screen
  const last = st.lastSource;
  const wanted = last && (sources.find(x => x.kind === last.kind && x.name === last.name && (x.kind !== 'screen' || !last.displayId || x.displayId === last.displayId))
    || (last.kind === 'screen' && sources.find(x => x.kind === 'screen' && last.displayId && x.displayId === last.displayId)));
  for (const s of sources) {
    const card = el('div', { class: 'src', title: s.name },
      s.thumbnail ? el('img', { src: s.thumbnail }) : el('img'),
      el('div', {}, s.icon ? el('img', { src: s.icon }) : null, s.kind === 'screen' ? `🖥 ${s.name}` : s.name));
    card.addEventListener('click', () => { st.source = s; for (const x of grid.children) x.classList.remove('on'); card.classList.add('on'); });
    grid.append(card);
    if (wanted ? s === wanted : (!st.source && s.kind === 'screen')) { st.source = s; card.classList.add('on'); }
  }
  // no screen in the list (only windows): pick the first thing so START works
  if (!st.source && grid.querySelector('.src')) { st.source = sources[0]; grid.querySelector('.src').classList.add('on'); }
}

async function countdown(n) {
  const box = $('#countdown');
  box.classList.remove('hidden');
  for (let i = n; i > 0; i--) { box.textContent = String(i); await new Promise(r => setTimeout(r, 1000)); }
  box.classList.add('hidden');
}

/** One running recording. */
async function record(app, st) {
  const api = app.api;
  await api.selectSource(st.source.id, st.system);
  const streams = [];
  let ids = null, going = false;
  const stopAll = () => streams.forEach(s => s.getTracks().forEach(t => t.stop()));
  try {
    // ---- capture streams
    const screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: st.fps, max: st.fps }, cursor: st.pointerSeparate ? 'never' : 'always' }, audio: st.system });
    streams.push(screen);
    const vtrack = screen.getVideoTracks()[0];
    if (!vtrack) throw new Error('No screen picture');
    const [mw, mh] = MAX[st.max] || MAX['4k'];
    const s0 = vtrack.getSettings();
    if (s0.width > mw || s0.height > mh) {
      const k = Math.min(mw / s0.width, mh / s0.height);
      await vtrack.applyConstraints({ width: Math.round(s0.width * k / 2) * 2, height: Math.round(s0.height * k / 2) * 2, frameRate: st.fps }).catch(() => {});
    }
    // keep the pointer out of the picture only if macOS really did (then Reel draws it, editable)
    const pointerSeparate = !!st.pointerSeparate && vtrack.getSettings().cursor === 'never';
    if (st.pointerSeparate && !pointerSeparate) toast('This Mac records the pointer into the picture; pointer styles won’t be editable for this recording.', 6000);
    const sysTrack = screen.getAudioTracks()[0] || null;
    let cam = null, mic = null;
    if (st.camera) { cam = await navigator.mediaDevices.getUserMedia({ video: { deviceId: st.cameraId ? { exact: st.cameraId } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } }); streams.push(cam); }
    if (st.mic) { mic = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: st.micId ? { exact: st.micId } : undefined, channelCount: { ideal: 2 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); streams.push(mic); }

    const RATE = [44100, 48000, 96000].includes(Number(st.recRate)) ? Number(st.recRate) : 48000;
    const ctx = new AudioContext({ sampleRate: RATE });
    await ctx.audioWorklet.addModule('rec-worklet.js');
    const sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);

    // ---- files
    const specs = [{ role: 'screen', format: 'mp4' }];
    if (cam) specs.push({ role: 'camera', format: 'mp4' });
    // an interface like a Scarlett Solo is one stereo device: input 1 (the mic) on the left, input 2 on the
    // right. Recording just the chosen input as mono keeps a mic from sounding one-sided.
    const devCh = mic ? Math.min(2, mic.getAudioTracks()[0].getSettings().channelCount || 1) : 0;
    const micIn = devCh < 2 ? 'stereo' : (st.micInput || 'auto');
    const micCh = !mic ? 0 : micIn === 'stereo' ? devCh : 1; // auto: input 1, mono (a voice)
    if (mic) specs.push({ role: 'mic', format: 'wav', sampleRate: RATE, channels: micCh });
    if (sysTrack) specs.push({ role: 'system', format: 'wav', sampleRate: RATE, channels: 2 });

    await countdown(st.countdown || 3);
    if (st.hide) { await api.hideWindow(); await new Promise(r => setTimeout(r, 350)); }
    const apps = st.sysMode === 'apps' ? st.apps.map(k => ({ key: k, name: (st.appNames || {})[k] || k })) : [];
    const type = pickType();
    const vs = vtrack.getSettings();
    // the screen picture can end on its own (window closed, display unplugged): it ends whichever take is running
    let endTake = null, screenLost = false, paused = false;
    vtrack.addEventListener('ended', () => {
      screenLost = true;
      if (paused) { toast('The Mac stopped the screen capture during the pause (it may have locked). Everything recorded so far is safe: press RESUME or STOP to save it.', 12000); return; }
      toast('The screen capture stopped, so the recording was ended and saved.', 8000);
      endTake?.('stop');
    }, { once: true });
    let tBegin = 0, starts = {};
    // One take after another: RETAKE on the panel throws the current take away (its files are deleted) and starts
    // a fresh one with the same screen, camera and microphone, without going back to the editor.
    for (let take = 1; ; take++) {
      ids = await api.recBegin(app.token, specs, apps, { clicks: !!st.clicks, keys: !!st.keys });
      tBegin = performance.now();
      starts = {};
      const done = [], nodes = [];

      // ---- video recorders
      const recorders = [];
      const addVideo = (role, stream, bps) => {
        const mr = new MediaRecorder(new MediaStream(stream.getVideoTracks()), { mimeType: type.replace(/,mp4a.*$/, ''), videoBitsPerSecond: bps });
        let chain = Promise.resolve();
        const myIds = ids;
        mr.ondataavailable = e => { if (e.data && e.data.size) chain = chain.then(async () => api.recChunk(myIds[role], new Uint8Array(await e.data.arrayBuffer()))); };
        mr.onstart = () => { starts[role] = performance.now(); };
        done.push(new Promise(res => { mr.onstop = () => chain.then(res); }));
        recorders.push(mr);
      };
      addVideo('screen', screen, Math.min(45e6, Math.max(6e6, (vs.width || 1920) * (vs.height || 1080) * (st.fps || 30) * 0.14)));
      if (cam) addVideo('camera', cam, 8e6);

      // ---- audio capture
      const workers = [];
      const addAudio = (role, track, ch, pick) => {
        let src = ctx.createMediaStreamSource(new MediaStream([track]));
        nodes.push(src);
        if (pick) { // one input of a stereo interface (0 = input 1, 1 = input 2) or both summed, as mono
          const split = ctx.createChannelSplitter(2), g = ctx.createGain();
          src.connect(split);
          if (pick === 'mix') { split.connect(g, 0); split.connect(g, 1); g.gain.value = 0.5; } else split.connect(g, pick === '2' ? 1 : 0);
          g.channelCount = 1; g.channelCountMode = 'explicit';
          nodes.push(split, g);
          src = g;
        }
        const node = new AudioWorkletNode(ctx, 'rec-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: ch, channelCountMode: 'explicit', processorOptions: { channels: ch } });
        src.connect(node); node.connect(sink);
        nodes.push(node);
        let stopped;
        done.push(new Promise(r => { stopped = r; }));
        const myIds = ids;
        node.port.onmessage = e => {
          const m = e.data;
          if (m.started !== undefined) starts[role] = performance.now();
          if (m.data) api.recChunk(myIds[role], new Uint8Array(m.data.buffer));
          if (m.stopped) stopped();
        };
        workers.push(node);
      };
      if (mic) addAudio('mic', mic.getAudioTracks()[0], micCh, micCh === 1 && devCh === 2 ? (micIn === '2' ? '2' : micIn === 'mix' ? 'mix' : '1') : null);
      if (sysTrack) addAudio('system', sysTrack, 2);

      // ---- go
      for (const n of workers) n.port.postMessage('start');
      for (const r of recorders) r.start(1000);
      going = true; // from here on, what's been recorded is kept whatever happens (unless you press RETAKE)
      app.setRecording(true);
      if (take > 1) toast(`Take ${take}: recording.`, 2000);

      let timer = null, timerLeft = st.stopAfter > 0 ? st.stopAfter * 60000 : 0, timerFrom = 0;
      let busy = false;
      paused = false;
      const reason = await new Promise(resolve => {
        endTake = resolve;
        app.onStopRecording = () => resolve('stop');
        app.onDiscardRecording = () => { if (!busy) resolve('retake'); };
        // recording timer: counts recorded time, so a pause doesn't eat into it
        const arm = () => { if (timerLeft > 0) { timerFrom = performance.now(); timer = setTimeout(() => resolve('stop'), timerLeft); } };
        arm();
        // PAUSE / RESUME (the floating panel, ⌥⇧⌘2 or the menu-bar icon): every recorder pauses in the same
        // instant, so the files simply leave the pause out and stay in sync. Nothing is captured while paused.
        app.onPauseRecording = async () => {
          if (busy) return;
          busy = true;
          paused = !paused;
          if (paused) {
            for (const r of recorders) if (r.state === 'recording') r.pause();
            for (const n of workers) n.port.postMessage('pause');
            if (timer) { clearTimeout(timer); timer = null; timerLeft = Math.max(1000, timerLeft - (performance.now() - timerFrom)); }
          } else {
            if (screenLost) { busy = false; resolve('stop'); return; } // the picture is gone: save what was recorded
            for (const r of recorders) if (r.state === 'paused') r.resume();
            for (const n of workers) n.port.postMessage('resume');
            arm();
          }
          try { await api.recPause(paused); } catch { /* the recording carries on regardless */ }
          app.setRecordingPaused(paused);
          busy = false;
        };
      });
      clearTimeout(timer);
      endTake = null;
      app.onStopRecording = null;
      app.onPauseRecording = null;
      app.onDiscardRecording = null;
      for (const r of recorders) if (r.state !== 'inactive') r.stop();
      for (const n of workers) n.port.postMessage('stop');
      await Promise.race([Promise.all(done), new Promise(r => setTimeout(r, 5000))]);
      for (const n of nodes) { try { n.disconnect(); } catch { /* already */ } }
      if (reason !== 'retake' || screenLost) break;
      // ---- RETAKE: this take's files are deleted; a new take starts after a short count on the panel
      const old = ids; ids = null; going = false;
      if (paused) app.setRecordingPaused(false);
      await api.recDiscard(Object.values(old), 3);
      await new Promise(r => setTimeout(r, 3000));
    }
    stopAll();
    ctx.close();
    app.setRecording(false);
    const first = Math.min(...Object.values(starts));
    const offsets = {};
    for (const [k, v] of Object.entries(starts)) offsets[k] = (v - first) / 1000;
    toast('Finishing the recording…');
    const res = await api.recEnd(Object.values(ids), offsets);
    // pointer track starts when the files are opened; the screen picture a moment later
    const cursorOffset = ((starts.screen ?? first) - tBegin) / 1000;
    app.addRecording(res, { cursorOffset, appLead: (first - tBegin) / 1000, source: st.source, pointerSeparate, keys: !!st.keys, marks: res.marks || [] });
  } catch (e) {
    stopAll();
    app.setRecording(false);
    if (ids && going) {
      // the recording had started: never throw it away. Save what there is; if even that fails, keep the files.
      try {
        const res = await api.recEnd(Object.values(ids), {});
        if (res?.media?.some(r => !r.error)) { app.addRecording(res, { cursorOffset: 0, appLead: 0, marks: res.marks || [] }); toast(`The recording hit a problem (${e.message}), but everything recorded was saved.`, 9000); return; }
      } catch { /* fall through: the files stay in the project's media folder */ }
      toast(`The recording hit a problem (${e.message}). The recorded files were kept in the project's media folder.`, 10000);
      return;
    }
    await api.recCancel(ids ? Object.values(ids) : []).catch(() => {});
    throw e;
  }
}
