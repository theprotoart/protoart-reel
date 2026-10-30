// Export dialog: built-in and saved presets, format (MP4 H.264 / HEVC, sound only, animated GIF or
// PNG), size, frame rate, quality, range; an estimate of size and time; a batch list that exports
// several versions in one go to one folder. Runs the export worker and streams the file to disk.
import { renderPending } from './trackplugins.js';
import { can } from './capability.js';
import { pref } from './prefs.js';
import { el, modal, toast, selectRow, promptText } from './ui.js';
import { duration, fmtTime, clipEnd, toSRT } from './model.js';
import { masterOf, openMaster, LOUDNESS, mixToFile } from './master-ui.js';
import { LOUDNESS_TARGETS } from './lib/master.js';

const FORMATS = [['avc', 'MP4 · H.264 (plays everywhere)'], ['hevc', 'MP4 · HEVC (smaller, newer devices)'], ['aac', 'Sound only · AAC (.m4a)'], ['gif', 'Animated GIF'], ['apng', 'Animated PNG']];
const ANIM = new Set(['gif', 'apng']);
const BUILT_IN = [
  { id: 'web', name: 'Web 1080p · H.264', codec: 'avc', height: 1080, mbps: 12 },
  { id: 'hq', name: 'High quality · HEVC at project size', codec: 'hevc', height: 0, mbps: 0 },
  { id: 'small', name: 'Small 720p · H.264 (email, chat)', codec: 'avc', height: 720, mbps: 4 },
  { id: 'uhd', name: '4K · HEVC', codec: 'hevc', height: 2160, mbps: 40 },
  { id: 'ipad', name: 'iPhone / iPad · H.264 1080p', codec: 'avc', height: 1080, mbps: 10 },
  { id: 'appstore', name: 'App Store preview · H.264 1080p 30 fps', codec: 'avc', height: 1080, mbps: 10, fps: 30 },
  { id: 'audio', name: 'Sound only · AAC (.m4a)', codec: 'aac', height: 0, mbps: 0 },
  { id: 'gif', name: 'Animated GIF · 640 wide, 12 fps', codec: 'gif', width: 640, fps: 12, dither: true },
  { id: 'gifsmall', name: 'Animated GIF · 480 wide, 10 fps (chat)', codec: 'gif', width: 480, fps: 10, dither: true },
  { id: 'apng', name: 'Animated PNG · 800 wide, 15 fps (sharp UI)', codec: 'apng', width: 800, fps: 15 },
];
const SIZES = [[0, 'Project size'], [2160, '2160p (4K)'], [1440, '1440p'], [1080, '1080p'], [720, '720p'], [540, '540p'], [480, '480p'], [360, '360p']];
const WIDTHS = [[0, 'Project width'], [1280, '1280 wide'], [960, '960 wide'], [800, '800 wide'], [640, '640 wide'], [480, '480 wide'], [320, '320 wide']];

const KEY = 'reel.exportPresets';
const loadCustom = () => { try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const saveCustom = list => { try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 50))); } catch { /* fine */ } };
const allPresets = () => [...BUILT_IN, ...loadCustom()];
const even = v => Math.max(2, Math.round(v / 2) * 2);

/** Output size for settings s on this canvas. */
export function sizeFor(s, canvas) {
  const cw = canvas.width, ch = canvas.height;
  if (ANIM.has(s.codec)) { const w = s.width && s.width < cw ? s.width : cw; return { w: even(w), h: even(ch * w / cw) }; }
  if (!s.height) return { w: even(cw), h: even(ch) };
  const k = s.height / Math.min(cw, ch);
  return { w: even(cw * k), h: even(ch * k) };
}

/** Rough size and time, from the bitrate (or measured GIF/APNG averages) and the M1's encoder speed. */
export function estimate(s, canvas, secs) {
  const { w, h } = sizeFor(s, canvas), fps = s.fps || 30;
  let mb;
  if (s.codec === 'aac') mb = (192e3 * secs) / 8 / 1e6;
  else if (s.codec === 'gif') mb = (w * h * fps * secs * 0.045) / 1e6; // screen content with frame differencing
  else if (s.codec === 'apng') mb = (w * h * fps * secs * 0.09) / 1e6;
  else mb = (((s.mbps ? s.mbps * 1e6 * (fps > 30 ? 1.5 : 1) : w * h * fps * 0.1) + 192e3) * secs) / 8 / 1e6;
  // frames per second the export manages on an 8 GB M1 (hardware encoder; drawing dominates)
  const px = w * h, rate = s.codec === 'aac' ? 0 : ANIM.has(s.codec) ? 4e7 / px : Math.min(120, 1.3e8 / px);
  const time = s.codec === 'aac' ? secs / 40 : (secs * fps) / Math.max(1, rate) * (s.motionBlur ? 4 : 1);
  return { w, h, mb, time };
}

export function openExport(app) {
  const doc = app.doc;
  if (!doc || !duration(doc)) { toast('Nothing on the timeline yet.'); return; }
  let last = null; try { last = JSON.parse(localStorage.getItem('reel.exportLast') || 'null'); } catch { /* fine */ }
  const st = { codec: 'avc', height: 1080, mbps: 12, fps: doc.canvas.fps || 30, width: 640, dither: true, loop: true, ...(last || {}), presetId: last?.presetId || 'web' };
  st.range = doc.range && doc.range.out > doc.range.in ? 'inout' : 'all';
  const sel = app.selection.clips.map(id => doc.clips.find(c => c.id === id)).filter(Boolean);
  const ranges = [['all', `Whole timeline (${fmtTime(duration(doc))})`]];
  if (sel.length) ranges.push(['sel', `Selected clips (${fmtTime(Math.min(...sel.map(c => c.start)))} – ${fmtTime(Math.max(...sel.map(clipEnd)))})`]);
  if ((doc.markers || []).length >= 2) ranges.push(['markers', 'Between the first two markers']);
  if (doc.range && doc.range.out > doc.range.in) ranges.unshift(['inout', `In to Out (${fmtTime(doc.range.in)} – ${fmtTime(doc.range.out)})`]);
  const rangeOf = r => {
    let from = 0, to = duration(doc);
    if (r === 'sel' && sel.length) { from = Math.min(...sel.map(c2 => c2.start)); to = Math.max(...sel.map(clipEnd)); }
    if (r === 'inout' && doc.range) { from = doc.range.in; to = doc.range.out; }
    if (r === 'markers') { const ms = doc.markers.slice().sort((a, b) => a.t - b.t); from = ms[0].t; to = ms[1].t; }
    return { from, to };
  };
  const remember = () => { try { localStorage.setItem('reel.exportLast', JSON.stringify({ codec: st.codec, height: st.height, mbps: st.mbps, fps: st.fps, width: st.width, dither: st.dither, loop: st.loop, presetId: st.presetId })); } catch { /* fine */ } };

  // ---------------------------------------------------------------- the form
  const info = el('p', { class: 'note export-est' });
  const settingsBox = el('div');
  const presetRow = el('div');
  const drawPresets = () => {
    const list = allPresets();
    const s = el('select', {}, ...list.map(p => el('option', { value: p.id, text: p.name + (p.custom ? '  ★' : ''), selected: p.id === st.presetId })),
      el('option', { value: '', text: 'Custom (as set below)', selected: !list.some(p => p.id === st.presetId) }));
    s.addEventListener('change', () => { const p = list.find(x => x.id === s.value); st.presetId = s.value; if (p) Object.assign(st, { height: 0, mbps: 0, fps: doc.canvas.fps || 30, ...p }); remember(); drawSettings(); drawPresets(); });
    const cur = list.find(p => p.id === st.presetId);
    presetRow.replaceChildren(el('div', { class: 'row' }, el('label', { text: 'Preset' }), s,
      el('button', { class: 'tool', text: 'Save as preset…', title: 'Keep these settings as a preset of your own', onclick: async () => {
        const name = await promptText('Save export preset', 'Name this preset:', describeShort(), 'Save');
        if (!name) return;
        const p = { id: 'u' + Date.now().toString(36), name: name.slice(0, 60), custom: true, codec: st.codec, height: st.height, width: st.width, mbps: st.mbps, fps: st.fps, dither: st.dither, loop: st.loop };
        saveCustom([...loadCustom(), p]); st.presetId = p.id; remember(); drawPresets(); toast('Preset saved.');
      } }),
      cur?.custom ? el('button', { class: 'mini', text: '×', title: 'Delete this preset', onclick: () => { saveCustom(loadCustom().filter(p => p.id !== cur.id)); st.presetId = ''; drawPresets(); } }) : null));
  };
  const custom = () => { st.presetId = ''; remember(); drawPresets(); describe(); };
  const describeShort = () => { const { w, h } = sizeFor(st, doc.canvas); return st.codec === 'aac' ? 'Sound only' : `${FORMATS.find(f => f[0] === st.codec)[1].split(' (')[0]} ${w}×${h} ${st.fps} fps`; };
  const drawSettings = () => {
    const anim = ANIM.has(st.codec), audioOnly = st.codec === 'aac';
    settingsBox.replaceChildren(...[
      selectRow('Format', st.codec, FORMATS, v => { st.codec = v; if (ANIM.has(v) && st.fps > 24) st.fps = v === 'gif' ? 12 : 15; custom(); drawSettings(); }),
      audioOnly ? null : anim
        ? selectRow('Width', st.width || 0, WIDTHS, v => { st.width = Number(v); custom(); })
        : selectRow('Size', st.height || 0, SIZES, v => { st.height = Number(v); custom(); }),
      audioOnly ? null : selectRow('Frame rate', st.fps, (anim ? [8, 10, 12, 15, 20, 24, 30] : [15, 24, 25, 30, 50, 60]).map(v => [v, String(v)]), v => { st.fps = Number(v); custom(); }),
      audioOnly || anim ? null : selectRow('Quality', st.mbps || 0, [[0, 'Automatic (by size)'], [2, 'Low · 2 Mbps'], [4, '4 Mbps'], [8, '8 Mbps'], [12, '12 Mbps'], [20, 'High · 20 Mbps'], [40, 'Very high · 40 Mbps']], v => { st.mbps = Number(v); custom(); }),
      st.codec === 'gif' ? checkbox('Dither', st.dither, v => { st.dither = v; custom(); }, 'smoother gradients, slightly larger') : null,
      anim ? checkbox('Loop', st.loop, v => { st.loop = v; custom(); }, 'play forever') : null,
      anim ? el('p', { class: 'note', text: 'Animated pictures have no sound. Pick a short range: In to Out (I / O) works well. Only the parts that change are stored, so screen recordings stay small.' }) : null].filter(Boolean));
    describe();
  };
  const checkbox = (label, value, on, note) => {
    const c = el('input', { type: 'checkbox', checked: !!value });
    c.addEventListener('change', () => on(c.checked));
    return el('div', { class: 'row' }, el('label', { text: label }), c, note ? el('span', { class: 'note', text: note }) : null);
  };
  const describe = () => {
    const { from, to } = rangeOf(st.range);
    const e = estimate(st, doc.canvas, to - from);
    const mb = e.mb < 1 ? `${Math.max(0.1, e.mb).toFixed(1)} MB` : e.mb < 1000 ? `${Math.round(e.mb)} MB` : `${(e.mb / 1000).toFixed(1)} GB`;
    const tm = e.time < 60 ? `${Math.max(1, Math.round(e.time))} s` : `${Math.round(e.time / 60)} min`;
    info.textContent = st.codec === 'aac' ? `AAC 192 kbps stereo, 48 kHz · about ${mb} · about ${tm} to export.`
      : `${e.w} × ${e.h}, ${st.fps} fps${ANIM.has(st.codec) ? '' : `, ${st.codec === 'hevc' ? 'HEVC' : 'H.264'} + AAC`} · about ${mb} · about ${tm} to export on an M1.`;
  };

  const progress = el('div', { class: 'progress hidden' }, el('i'));
  const status = el('p', { class: 'note' });
  const chapters = (doc.markers || []).length ? el('div', {},
    el('p', { class: 'note', text: 'YouTube chapters from your markers (paste into the description):' }),
    el('textarea', { class: 'big', readOnly: true, value: ['00:00 Intro', ...doc.markers.slice().sort((a, b) => a.t - b.t).filter(m => m.t > 0).map(m => `${fmtTime(m.t).replace(/\.\d$/, '')} ${m.label || 'Chapter'}`)].join('\n') })) : null;

  // ---------------------------------------------------------------- batch
  const batch = [];
  const batchBox = el('div', { class: 'batch' });
  const drawBatch = () => {
    batchBox.replaceChildren(...(batch.length ? [el('div', { class: 'engr', text: `Batch · ${batch.length}` }),
      ...batch.map((b, i) => el('div', { class: 'row batch-item' + (b.state ? ' ' + b.state : '') },
        el('span', { class: 'bname', text: `${b.label} · ${b.rangeLabel}` }),
        el('span', { class: 'note', text: b.state === 'done' ? 'done' : b.state === 'running' ? 'exporting…' : b.state === 'failed' ? 'failed' : '' }),
        b.state ? null : el('button', { class: 'mini', text: '×', title: 'Remove from the batch', onclick: () => { batch.splice(i, 1); drawBatch(); } })))] : []));
  };

  drawPresets(); drawSettings();
  const body = el('div', { class: 'export' },
    presetRow, settingsBox,
    selectRow('Range', st.range, ranges, v => { st.range = v; describe(); }),
    checkbox('Motion blur', st.motionBlur, v => { st.motionBlur = v; describe(); }, 'smoother zooms · ~4× slower'),
    (doc.captions || []).length ? checkbox('Captions file', st.srt = true, v => { st.srt = v; }, 'Save an .srt next to the movie') : null,
    el('div', { class: 'row' }, el('label', { text: 'Master' }), masterSummary(), el('button', { class: 'tool', text: 'MASTER…', onclick: () => openMaster(app) })),
    selectRow('Loudness', masterOf(doc).loudness, LOUDNESS, v => app.commit(d => { masterOf(d).loudness = v; }, { quiet: true })),
    info, batchBox, progress, status, chapters);
  function masterSummary() {
    const m = masterOf(doc);
    const plugs = m.plugins.filter(p => !p.bypass).map(p => p.name);
    return el('span', { class: 'note', style: { flex: 1 }, text: [m.on ? 'Built-in master on' : 'Built-in master off', ...plugs].join(' · ') });
  }

  let worker = null, handle = null, running = false, stopBatch = false;

  /** Runs one export into an open file handle. Resolves to the saved name, or throws. */
  const runOne = (s, from, to, h) => new Promise(async (resolve, reject) => {
    handle = h;
    const { w, h: hh } = sizeFor(s, doc.canvas);
    const started = performance.now();
    progress.classList.remove('hidden'); progress.firstChild.style.width = '0%';
    status.textContent = 'Starting…';
    // your plug-ins on tracks are rendered now, at the very end (unless they already are)
    try { await renderPending(app, { onStatus: (t, v) => { status.textContent = t; progress.firstChild.style.width = Math.round(v * 100) + '%'; } }); }
    catch (e) { toast(`A plug-in couldn’t render: ${e.message}`, 7000); }
    const m = masterOf(doc);
    const anim = ANIM.has(s.codec);
    const loud = anim ? null : LOUDNESS_TARGETS[m.loudness] ?? null;
    const plugChain = anim ? [] : m.plugins.filter(p => !p.bypass).map(p => ({ kind: 'au', plugin: p.plugin, state: p.state || '' }));
    let masterFile = null; const temps = [];
    const cleanup = () => { for (const t of temps) app.api.fxRemoveTemp(app.token, t); };
    if (!anim && (m.on || plugChain.length || loud != null)) {
      try {
        status.textContent = 'Mixing and mastering the sound…';
        const mix = await mixToFile(app, { from, to, master: m, onProgress: f => { progress.firstChild.style.width = (f * 30).toFixed(1) + '%'; } });
        temps.push(mix); masterFile = mix;
        if (plugChain.length) {
          status.textContent = `Running ${plugChain.length} plug-in${plugChain.length > 1 ? 's' : ''} on the master…`;
          const listener = p => { if (p.tag === 'master') progress.firstChild.style.width = (30 + p.f * 10).toFixed(1) + '%'; };
          app.fxListeners.add(listener);
          try { masterFile = await app.api.fxRenderFile(app.token, mix, plugChain); temps.push(masterFile); } finally { app.fxListeners.delete(listener); }
        }
      } catch (err) { cleanup(); app.api.exportCancel(h.id); reject(new Error(`Mastering failed: ${err.message}`)); return; }
    }
    worker = new Worker('export-worker.js', { type: 'module' });
    worker.onmessage = async e => {
      const msg = e.data;
      if (msg.type === 'chunk') app.api.exportChunk(h.id, msg.data);
      else if (msg.type === 'progress') {
        const k = msg.done / msg.total;
        progress.firstChild.style.width = (k * 100).toFixed(1) + '%';
        const left = ((performance.now() - started) / 1000) * (1 - k) / Math.max(k, 0.001);
        status.textContent = `Frame ${msg.done} of ${msg.total} · ${msg.fps.toFixed(0)} fps · about ${fmtTime(left).replace(/\.\d$/, '')} left`;
      } else if (msg.type === 'warn') toast(msg.message, 5000);
      else if (msg.type === 'status') status.textContent = msg.message;
      else if (msg.type === 'loudness') toast(`Loudness ${msg.measured.toFixed(1)} LUFS → ${msg.target} LUFS`, 4000);
      else if (msg.type === 'done') {
        status.textContent = 'Writing the file…';
        worker.terminate(); worker = null;
        try {
          const r = await app.api.exportFinish(h.id, msg.head);
          progress.firstChild.style.width = '100%';
          if (st.srt && (doc.captions || []).length && !anim && s.codec !== 'aac') {
            const caps = doc.captions.filter(c => c.end > from && c.t < to).map(c => ({ ...c, t: Math.max(0, c.t - from), end: Math.min(to, c.end) - from }));
            if (caps.length) await app.api.captionsBeside(r.name, toSRT(caps)).catch(() => {});
          }
          cleanup();
          resolve({ name: r.name, secs: (performance.now() - started) / 1000 });
        } catch (err) { cleanup(); reject(new Error(`Couldn’t save: ${err.message}`)); }
      } else if (msg.type === 'error') {
        cleanup();
        app.api.exportCancel(h.id);
        worker.terminate(); worker = null;
        reject(new Error(msg.message === 'Cancelled' ? 'Export cancelled.' : `Export failed: ${msg.message}`));
      }
    };
    const fps = s.fps || 30;
    worker.postMessage({ type: 'start', doc: JSON.parse(JSON.stringify(doc)), token: app.token, opts: { stretchMax: can('stretchLong').ok ? 1200 : 600,
      width: w, height: hh, fps, codec: s.codec, motionBlur: st.motionBlur && s.codec !== 'aac' ? 4 : 0, kind: s.codec === 'aac' ? 'm4a' : anim ? s.codec : 'mp4', from, to,
      bitrate: s.mbps ? s.mbps * 1e6 * (fps > 30 ? 1.5 : 1) : Math.round(w * hh * fps * 0.1), audioBitrate: Number(pref('audioBitrate')) || 192000, hardware: pref('encoder') !== 'software',
      masterFile, loudness: loud, ceiling: m.ceiling, dither: s.dither !== false, loop: s.loop !== false,
    } });
  });
  const kindOf = s => (s.codec === 'aac' ? 'm4a' : ANIM.has(s.codec) ? s.codec : 'mp4');
  const snapshot = () => ({ codec: st.codec, height: st.height, width: st.width, mbps: st.mbps, fps: st.fps, dither: st.dither, loop: st.loop });

  const exportBtn = { label: 'Export…', cls: 'hw amber', onClick: async (c, btn) => {
    if (running) return;
    const s = snapshot(), { from, to } = rangeOf(st.range);
    const h = await app.api.exportBegin(app.token, doc.name, kindOf(s));
    if (!h) return;
    running = true; btn.disabled = true;
    try { const r = await runOne(s, from, to, h); status.replaceChildren(`Saved “${r.name}” in ${fmtTime(r.secs)}. `, el('button', { class: 'mini', text: 'Show in Finder', onclick: () => app.api.exportReveal(r.name) })); }
    catch (err) { status.textContent = err.message; }
    running = false; btn.disabled = false; void c;
  } };
  const addBtn = { label: 'Add to batch', cls: 'hw', onClick: () => {
    const s = snapshot(), { from, to } = rangeOf(st.range);
    batch.push({ s, from, to, label: describeShort(), rangeLabel: ranges.find(r => r[0] === st.range)[1].replace(/ \(.*/, ''), suffix: st.presetId ? (allPresets().find(p => p.id === st.presetId)?.name || '') : describeShort() });
    drawBatch();
  } };
  const batchBtn = { label: 'Export batch…', cls: 'hw', onClick: async (c, btn) => {
    if (running) return;
    if (!batch.length) { toast('Add a few versions with “Add to batch” first: say a 1080p MP4, a 720p MP4 and a GIF of the intro.'); return; }
    const folder = await app.api.exportPickFolder();
    if (!folder) return;
    running = true; stopBatch = false; btn.disabled = true;
    let ok = 0;
    for (const b of batch) {
      if (stopBatch) break;
      if (b.state === 'done') continue;
      b.state = 'running'; drawBatch();
      try {
        const h = await app.api.exportBeginIn(app.token, folder.id, `${doc.name} - ${b.suffix}`.replace(/[·]/g, '-'), kindOf(b.s));
        await runOne(b.s, b.from, b.to, h);
        b.state = 'done'; ok++;
      } catch (err) { b.state = 'failed'; toast(err.message, 5000); }
      drawBatch();
    }
    status.textContent = `Batch finished: ${ok} of ${batch.length} saved in “${folder.name}”.`;
    running = false; btn.disabled = false; void c;
  } };

  const dlg = modal('Export', body, [
    { label: 'Close', onClick: c => { if (running) cancel(); c(); } },
    addBtn, batchBtn, exportBtn,
  ], { onClose: () => { if (running) cancel(); } });
  const cancel = () => {
    stopBatch = true;
    if (worker) { worker.postMessage({ type: 'cancel' }); setTimeout(() => { if (worker) { worker.terminate(); worker = null; } }, 1500); }
    if (handle) app.api.exportCancel(handle.id);
    running = false;
  };
  void dlg;
}
