// Export dialog: built-in and saved presets, format (MP4 H.264 / HEVC, sound only, animated GIF or
// PNG), size, frame rate, quality, range; an estimate of size and time; a batch list that exports
// several versions in one go to one folder. Runs the export worker and streams the file to disk.
import { renderPending } from './trackplugins.js';
import { can } from './capability.js';
import { pref } from './prefs.js';
import { el, modal, toast, selectRow, promptText } from './ui.js';
import { duration, fmtTime, clipEnd, toSRT } from './model.js';
import { masterOf, openMaster, LOUDNESS, mixToFile, addMasterPlugin } from './master-ui.js';
import { LOUDNESS_TARGETS } from './lib/master.js';
import { builtInPresets, GROUPS, QUALITY, SIZE_LIMITS, presetFps, videoBitrate, fromHandBrake } from './lib/exportpresets.js';

const SOUND = new Set(['aac', 'wav']); // sound-only formats
const FORMATS = [['avc', 'MP4 · H.264 (plays everywhere)'], ['hevc', 'MP4 · HEVC (smaller, newer devices)'], ['aac', 'Sound only · AAC (.m4a)'], ['wav', 'Sound only · WAV (uncompressed, 24-bit)'], ['gif', 'Animated GIF'], ['apng', 'Animated PNG']];
const ANIM = new Set(['gif', 'apng']);
const BUILT_IN = builtInPresets();
const SIZES = [[0, 'Project size'], [2160, '2160p (4K)'], [1440, '1440p'], [1080, '1080p'], [720, '720p'], [576, '576p'], [540, '540p'], [480, '480p'], [360, '360p']];
const WIDTHS = [[0, 'Project width'], [1280, '1280 wide'], [960, '960 wide'], [800, '800 wide'], [640, '640 wide'], [480, '480 wide'], [320, '320 wide']];

const KEY = 'reel.exportPresets';
const loadCustom = () => { try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const saveCustom = list => { try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 120))); } catch { /* fine */ } };
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
  if (s.codec === 'wav') mb = (48000 * 6 * secs) / 1e6;
  else if (s.codec === 'gif') mb = (w * h * fps * secs * 0.045) / 1e6; // screen content with frame differencing
  else if (s.codec === 'apng') mb = (w * h * fps * secs * 0.09) / 1e6;
  else mb = s.targetMB > 0 ? Math.min(s.targetMB, ((videoBitrate(s, w, h, fps, secs) + (s.abr || 192) * 1000) * secs) / 8 / 1e6) : ((videoBitrate(s, w, h, fps, secs) + (s.abr || 192) * 1000) * secs) / 8 / 1e6;
  // frames per second the export manages on an 8 GB M1 (hardware encoder; drawing dominates)
  const px = w * h, rate = SOUND.has(s.codec) ? 0 : ANIM.has(s.codec) ? 4e7 / px : Math.min(120, 1.3e8 / px);
  const time = SOUND.has(s.codec) ? secs / 40 : (secs * fps) / Math.max(1, rate) * (s.motionBlur ? 4 : 1);
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
  const remember = () => { try { localStorage.setItem('reel.exportLast', JSON.stringify({ codec: st.codec, height: st.height, mbps: st.mbps, q: st.q, targetMB: st.targetMB, abr: st.abr, hw: st.hw, fps: st.fps, width: st.width, dither: st.dither, loop: st.loop, presetId: st.presetId })); } catch { /* fine */ } };

  // ---------------------------------------------------------------- the form
  const info = el('p', { class: 'note export-est' });
  const settingsBox = el('div');
  const presetRow = el('div');
  const drawPresets = () => {
    const list = allPresets();
    const groupOf = p => p.custom ? (p.group || 'My presets') : p.group || 'Reel';
    const groups = [...GROUPS, 'Imported from HandBrake', 'My presets'].filter(g => list.some(p => groupOf(p) === g));
    const s = el('select', {}, ...groups.map(g => el('optgroup', { label: g === 'Reel' ? 'Reel' : g === 'General' || g === 'Web' || g === 'Devices' || g === 'Hardware' || g === 'Production' ? `HandBrake · ${g}` : g },
      ...list.filter(p => groupOf(p) === g).map(p => el('option', { value: p.id, text: p.name + (p.custom && g === 'My presets' ? '  ★' : ''), selected: p.id === st.presetId })))),
      el('option', { value: '', text: 'Custom (as set below)', selected: !list.some(p => p.id === st.presetId) }));
    s.addEventListener('change', () => {
      const p = list.find(x => x.id === s.value); st.presetId = s.value;
      if (p) { const { fpsMax, ...rest } = p; void fpsMax; Object.assign(st, { height: 0, mbps: 0, q: 1, targetMB: 0, abr: 0, hw: undefined, ...rest, fps: presetFps(p, doc.canvas.fps || 30) }); }
      remember(); drawSettings(); drawPresets();
    });
    const cur = list.find(p => p.id === st.presetId);
    const picker = el('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
    picker.addEventListener('change', async () => {
      const f = picker.files?.[0]; picker.value = '';
      if (!f) return;
      try {
        const { presets, notes } = fromHandBrake(await f.text());
        if (!presets.length) { toast('No presets found in that file. In HandBrake: Presets › choose one › Export…', 6000); return; }
        saveCustom([...loadCustom().filter(p => !presets.some(n => n.name === p.name && p.group === n.group)), ...presets]);
        st.presetId = presets[0].id; Object.assign(st, { height: 0, mbps: 0, q: 1, targetMB: 0, abr: 0, hw: undefined, ...presets[0], fps: presetFps(presets[0], doc.canvas.fps || 30) });
        remember(); drawSettings(); drawPresets();
        toast(`Imported ${presets.length} HandBrake preset${presets.length === 1 ? '' : 's'}.${notes.length ? ` Changed to what Reel can make: ${notes.slice(0, 3).join('; ')}${notes.length > 3 ? '…' : ''}.` : ''}`, 8000);
      } catch (e) { toast(`That isn’t a HandBrake preset file (${e.message}).`, 6000); }
    });
    presetRow.replaceChildren(el('div', { class: 'row' }, el('label', { text: 'Preset' }), s,
      el('button', { class: 'tool', text: 'Save as preset…', title: 'Keep these settings as a preset of your own', onclick: async () => {
        const name = await promptText('Save export preset', 'Name this preset:', describeShort(), 'Save');
        if (!name) return;
        const p = { id: 'u' + Date.now().toString(36), name: name.slice(0, 60), custom: true, codec: st.codec, height: st.height, width: st.width, mbps: st.mbps, q: st.q, targetMB: st.targetMB, abr: st.abr, hw: st.hw, fps: st.fps, dither: st.dither, loop: st.loop };
        saveCustom([...loadCustom(), p]); st.presetId = p.id; remember(); drawPresets(); toast('Preset saved.');
      } }),
      el('button', { class: 'tool', text: 'Import HandBrake…', title: 'Bring in presets from HandBrake: in HandBrake’s Presets window, choose a preset (or a folder) › Export…, then pick that .json file here', onclick: () => picker.click() }), picker,
      cur?.custom ? el('button', { class: 'mini', text: '×', title: 'Delete this preset', onclick: () => { saveCustom(loadCustom().filter(p => p.id !== cur.id)); st.presetId = ''; drawPresets(); } }) : null),
      cur?.hint ? el('p', { class: 'note', text: cur.hint }) : null);
  };
  const custom = () => { st.presetId = ''; remember(); drawPresets(); describe(); };
  const describeShort = () => { const { w, h } = sizeFor(st, doc.canvas); return SOUND.has(st.codec) ? (st.codec === 'wav' ? 'Sound only · WAV' : 'Sound only') : `${FORMATS.find(f => f[0] === st.codec)[1].split(' (')[0]} ${w}×${h} ${st.fps} fps`; };
  const drawSettings = () => {
    const anim = ANIM.has(st.codec), audioOnly = SOUND.has(st.codec);
    settingsBox.replaceChildren(...[
      selectRow('Format', st.codec, FORMATS, v => { st.codec = v; if (ANIM.has(v) && st.fps > 24) st.fps = v === 'gif' ? 12 : 15; custom(); drawSettings(); }),
      audioOnly ? null : anim
        ? selectRow('Width', st.width || 0, WIDTHS, v => { st.width = Number(v); custom(); })
        : selectRow('Size', st.height || 0, SIZES, v => { st.height = Number(v); custom(); }),
      audioOnly ? null : selectRow('Frame rate', st.fps, (anim ? [8, 10, 12, 15, 20, 24, 30] : [15, 24, 25, 30, 50, 60]).map(v => [v, String(v)]), v => { st.fps = Number(v); custom(); }),
      audioOnly || anim ? null : selectRow('Quality', st.mbps ? `m${st.mbps}` : `q${st.q || 1}`, [...QUALITY.map(([q, t]) => [`q${q}`, t]), [`m2`, 'Fixed · 2 Mbps'], ['m4', 'Fixed · 4 Mbps'], ['m8', 'Fixed · 8 Mbps'], ['m12', 'Fixed · 12 Mbps'], ['m20', 'Fixed · 20 Mbps'], ['m40', 'Fixed · 40 Mbps']],
        v => { if (v[0] === 'm') { st.mbps = Number(v.slice(1)); } else { st.mbps = 0; st.q = Number(v.slice(1)); } custom(); }),
      audioOnly || anim ? null : selectRow('File size limit', st.targetMB || 0, SIZE_LIMITS.some(([v]) => v === (st.targetMB || 0)) ? SIZE_LIMITS : [...SIZE_LIMITS, [st.targetMB, `${st.targetMB} MB`]], v => { st.targetMB = Number(v); custom(); }),
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
    info.textContent = st.codec === 'wav' ? `WAV 24-bit stereo, 48 kHz (uncompressed, for editing or mastering elsewhere) · about ${mb} · about ${tm} to export.` : st.codec === 'aac' ? `AAC 192 kbps stereo, 48 kHz · about ${mb} · about ${tm} to export.`
      : ANIM.has(st.codec) ? `${e.w} × ${e.h}, ${st.fps} fps · about ${mb} · about ${tm} to export on an M1.`
      : (() => {
        const vb = videoBitrate(st, e.w, e.h, st.fps, to - from), bpp = vb / (e.w * e.h * st.fps);
        const fit = st.targetMB > 0 ? ` · fits in ${st.targetMB} MB` : '';
        // a size limit on a long export can leave too few bits for the picture: say so, and what helps
        const thin = st.targetMB > 0 && bpp < 0.02 ? ` ⚠ That’s very little for ${e.h}p over ${fmtTime(to - from).replace(/\.\d$/, '')}: pick a smaller size, a shorter range or a bigger limit.` : '';
        return `${e.w} × ${e.h}, ${st.fps} fps, ${st.codec === 'hevc' ? 'HEVC' : 'H.264'} ${(vb / 1e6).toFixed(1)} Mbps + AAC ${st.abr || Math.round((Number(pref('audioBitrate')) || 192000) / 1000)} kbps${st.hw ? ' · Apple hardware encoder' : ''}${fit} · about ${mb} · about ${tm} to export on an M1.${thin}`;
      })();
  };

  const progress = el('div', { class: 'progress hidden' }, el('i'));
  const status = el('p', { class: 'note' });
  const chapters = (doc.markers || []).length ? el('div', {},
    el('div', { class: 'row' }, el('p', { class: 'note', style: { flex: 1 }, text: 'YouTube chapters from your markers (paste into the description):' }),
      el('button', { class: 'mini', text: '✍ Titles & description…', title: 'Qwen writes title ideas, a description and chapter names from what’s said', onclick: () => app.cmd('writer') })),
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
  const masterBox = el('span', { style: { flex: 1 } }, masterSummary());
  const body = el('div', { class: 'export' },
    presetRow, settingsBox,
    selectRow('Range', st.range, ranges, v => { st.range = v; describe(); }),
    checkbox('Motion blur', st.motionBlur, v => { st.motionBlur = v; describe(); }, 'smoother zooms · ~4× slower'),
    (doc.captions || []).length ? checkbox('Captions file', st.srt = true, v => { st.srt = v; }, 'Save an .srt next to the movie') : null,
    el('div', { class: 'row' }, el('label', { text: 'Master' }), masterBox,
      el('button', { class: 'tool', text: '+ PLUG-IN', title: 'Put one of your own plug-ins (CEDAR, Waves, iZotope, FabFilter…) on the whole mix for this export', onclick: async () => { if (await addMasterPlugin(app)) masterBox.replaceChildren(masterSummary()); } }),
      el('button', { class: 'tool', text: 'MASTER…', onclick: () => openMaster(app) })),
    selectRow('Loudness', masterOf(doc).loudness, LOUDNESS, v => app.commit(d => { masterOf(d).loudness = v; }, { quiet: true })),
    info, batchBox, progress, status, chapters);
  function masterSummary() {
    const m = masterOf(doc);
    const plugs = m.plugins.filter(p => !p.bypass).map(p => p.name);
    return el('span', { class: 'note', text: [m.on ? 'Built-in master on' : 'Built-in master off', ...(plugs.length ? [`plug-ins: ${plugs.join(' → ')}`] : ['no plug-ins'])].join(' · ') });
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
        status.textContent = msg.sound
          ? `Sound ${fmtTime(msg.secs).replace(/\.\d$/, '')} of ${fmtTime(msg.totalSecs).replace(/\.\d$/, '')} · ${msg.fps.toFixed(0)}× real time · about ${fmtTime(left).replace(/\.\d$/, '')} left`
          : `Frame ${msg.done} of ${msg.total} · ${msg.fps.toFixed(0)} fps · about ${fmtTime(left).replace(/\.\d$/, '')} left`;
      } else if (msg.type === 'warn') toast(msg.message, 5000);
      else if (msg.type === 'status') status.textContent = msg.message;
      else if (msg.type === 'loudness') toast(`Loudness ${msg.measured.toFixed(1)} LUFS → ${msg.target} LUFS`, 4000);
      else if (msg.type === 'done') {
        status.textContent = 'Writing the file…';
        worker.terminate(); worker = null;
        try {
          const r = await app.api.exportFinish(h.id, msg.head);
          progress.firstChild.style.width = '100%';
          if (st.srt && (doc.captions || []).length && !anim && !SOUND.has(s.codec)) {
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
      width: w, height: hh, fps, codec: s.codec, motionBlur: st.motionBlur && !SOUND.has(s.codec) ? 4 : 0, kind: s.codec === 'aac' ? 'm4a' : s.codec === 'wav' ? 'wav' : anim ? s.codec : 'mp4', from, to,
      bitrate: videoBitrate(s, w, hh, fps, to - from), audioBitrate: s.abr ? s.abr * 1000 : Number(pref('audioBitrate')) || 192000, hardware: s.hw ? true : pref('encoder') !== 'software',
      masterFile, loudness: loud, ceiling: m.ceiling, dither: s.dither !== false, loop: s.loop !== false,
    } });
  });
  const kindOf = s => (s.codec === 'aac' ? 'm4a' : s.codec === 'wav' ? 'wav' : ANIM.has(s.codec) ? s.codec : 'mp4');
  const snapshot = () => ({ codec: st.codec, height: st.height, width: st.width, mbps: st.mbps, q: st.q, targetMB: st.targetMB, abr: st.abr, hw: st.hw, fps: st.fps, dither: st.dither, loop: st.loop });

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
