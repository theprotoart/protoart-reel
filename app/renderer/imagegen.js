// Shared ERNIE-Image hardware: a CHANNEL module (channel type, ideas on masking tape, title look) and
// an ERNIE ART module (prompt, style, your ERNIE LoRAs from Protoart Studio, pictures, generate), plus
// the gallery. Used by Thumbnail Studio and by AI Image, whose pictures go straight into the project.
import { el, modal, toast, slider } from './ui.js';
import { GENRES, SIZE_PRESETS, genreById, genreIdeas, genSize } from './genres.js';
import { module, knob, buttonGroup, pushButton, segDisplay, tape } from './gear.js';

export const STYLES = [['bold', 'Bold'], ['cinematic', 'Cinematic'], ['neon', 'Neon'], ['clean', 'Clean'], ['comic', 'Comic'], ['3d', '3D']];
export const NEGATIVE = 'text, letters, words, captions, watermark, logo, signature, blurry, low quality, distorted';
const MAX_LORAS = 3;
const SHORT = { art: 'Art', cooking: 'Cooking', gaming: 'Gaming', tech: 'Tech', fitness: 'Fitness', travel: 'Travel', music: 'Music', education: 'Learn',
  beauty: 'Beauty', finance: 'Money', diy: 'DIY', podcast: 'Podcast', kids: 'Kids', screencast: 'Tutorial' };
const LORA_STEPS = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

/**
 * s: persisted state object (prompt, style, variations, genre, topic, loras); save(): persist it.
 * opts.size() → {w, h} output size; opts.mode() → 'txt2img' | 'img2img'; opts.startImage() → PNG bytes;
 * opts.strength() → 0..1; opts.onImage(bitmap, png); opts.onPick(bitmap); opts.onGenre(genre);
 * opts.topic() → text the ideas are about (Thumbnail Studio uses the title; otherwise a topic box is shown).
 */
export async function erniePanel(app, s, save, opts) {
  s.prompt ??= ''; s.style ??= 'bold'; s.variations ??= 2; s.genre ??= ''; s.topic ??= ''; s.loras ??= []; s.fluxLoras ??= []; s.engine ??= 'ernie';
  let status = await app.api.aiStatus().catch(() => ({ ernie: { ready: false, reason: 'ERNIE status unavailable' }, text: { ready: false } }));
  status.flux ||= { ready: false, canSetup: false, reason: 'FLUX isn’t available in this build.' };
  // two picture engines, each with its own LoRA styles from Protoart Studio
  const loraLists = { ernie: await app.api.aiLoras('ernie').catch(() => []), flux: await app.api.aiLoras('flux').catch(() => []) };
  const key = () => (s.engine === 'flux' ? 'fluxLoras' : 'loras');
  s.loras = s.loras.filter(l => loraLists.ernie.some(x => x.name === l.name)).slice(0, MAX_LORAS);
  s.fluxLoras = s.fluxLoras.filter(l => loraLists.flux.some(x => x.name === l.name)).slice(0, MAX_LORAS);
  let loras = loraLists[s.engine] || [];
  const engineReady = () => (s.engine === 'flux' ? status.flux.ready : status.ernie.ready);
  const topic = () => (opts.topic ? opts.topic() : s.topic) || '';

  // ================================================================ CHANNEL
  const ideasEl = el('div', { class: 'ideas' });
  const promptBox = el('textarea', { class: 'big', value: s.prompt, placeholder: 'Describe the picture: subject, setting, lighting, style. Or pick a channel and press IDEAS.' });
  promptBox.addEventListener('input', () => { s.prompt = promptBox.value; });
  promptBox.addEventListener('change', save);
  const setPrompt = p => { s.prompt = p; promptBox.value = p; save(); promptBox.classList.add('flash'); setTimeout(() => promptBox.classList.remove('flash'), 500); };

  const ids = ['', ...GENRES.map(g => g.id)];
  const channel = module('Channel', { finish: 'oxblood', sub: 'Ideas · title look · badges' });
  buttonGroup(channel.body, {
    labels: ['Any', ...GENRES.map(g => SHORT[g.id] || g.label)], index: Math.max(0, ids.indexOf(s.genre)), cols: 5, lamp: 'amber',
    onChange: i => { s.genre = ids[i]; save(); const g = genreById(s.genre); if (g && opts.onGenre) opts.onGenre(g); showIdeas(); },
  });
  let topicIn = null;
  if (!opts.topic) {
    topicIn = el('input', { type: 'text', value: s.topic, placeholder: 'What is it about? e.g. lemon garlic pasta, Procreate brushes' });
    topicIn.addEventListener('input', () => { s.topic = topicIn.value; });
    topicIn.addEventListener('change', () => { save(); if (s.genre) showIdeas(); });
    channel.body.append(el('div', { class: 'row' }, el('label', { text: 'Topic' }), topicIn));
  }
  const ideasBtn = pushButton({ label: status.text.ready ? 'Ideas · AI' : 'Ideas', title: 'Picture ideas for this kind of channel. Click a note to use it.' });
  channel.body.append(el('div', { class: 'gen-row' }, ideasBtn, el('span', { class: 'engr small', text: 'Click a note to use it' })), ideasEl);

  let ideaRun = 0;
  const card = text => el('button', { class: 'idea', text, title: 'Use this prompt', onclick: () => setPrompt(text) });
  const showIdeas = async (withAi = false) => {
    const g = genreById(s.genre);
    if (!g) { ideasEl.replaceChildren(); return; }
    const run = ++ideaRun;
    ideasEl.replaceChildren(...genreIdeas(g, topic()).map(card));
    if (withAi && status.text.ready) {
      const wait = el('div', { class: 'idea wait', text: 'Writing a fresh idea…' });
      ideasEl.prepend(wait);
      try {
        const r = await app.api.aiSuggest({ title: topic() || g.label, description: `Channel type: ${g.label}. Example of the look: ${g.prompts[0].replaceAll('{topic}', topic() || 'the subject')}`, style: s.style, mode: opts.mode() });
        if (run === ideaRun) wait.replaceWith(card(r.prompt));
      } catch { wait.remove(); }
    }
  };
  ideasBtn.addEventListener('click', async () => {
    ideasBtn.disabled = true; ideasBtn.classList.add('lit', 'working');
    try {
      if (!s.genre) {
        if (!topic().trim()) toast('Pick a channel, or write what the picture is about.');
        else { const r = await app.api.aiSuggest({ title: topic(), description: '', style: s.style, mode: opts.mode() }); setPrompt(r.prompt); if (!r.smart) toast('Simple suggestion (Protoart Studio’s prompt enhancer isn’t set up).'); }
      } else await showIdeas(true);
    } catch (e) { toast(e.message); }
    ideasBtn.disabled = false; ideasBtn.classList.remove('lit', 'working');
  });

  // ================================================================ ERNIE ART
  const art = module('AI Art', { finish: 'graphite', sub: 'ERNIE · FLUX · on this Mac', lampColor: 'amber' });
  const note = el('p', { class: 'note' });
  const setNote = (t, warn = false) => { note.textContent = t; note.classList.toggle('warn', warn); };
  const engineNote = () => {
    if (s.engine === 'flux') setNote(status.flux.ready ? 'FLUX.2 [klein] 4B: follows long, detailed prompts closely. 4 steps, about 30–90 s a picture on an 8 GB M1.' : status.flux.reason, !status.flux.ready);
    else setNote(status.ernie.ready ? 'ERNIE-Image Turbo with Protoart Studio’s fast engine. About 20–60 s a picture.' : status.ernie.reason, !status.ernie.ready);
    setupBtn.classList.toggle('hidden', !(s.engine === 'flux' && status.flux.canSetup));
  };
  const setupBtn = pushButton({ label: 'Get FLUX', lamp: 'amber', cls: 'hidden', title: 'One time: download FLUX.2 [klein] 4-bit (4.6 GB), the same copy Protoart Studio uses' });
  setupBtn.addEventListener('click', () => openFluxSetup(app, async () => { status = await app.api.aiStatus().catch(() => status); status.flux ||= {}; engineNote(); reflectReady(); }));
  buttonGroup(art.body, { title: 'Engine', labels: ['ERNIE', 'FLUX'], subs: ['Turbo · 8 steps', 'klein 4B · 4 steps'], index: s.engine === 'flux' ? 1 : 0, cols: 2,
    onChange: i => {
      s.engine = i ? 'flux' : 'ernie'; save();
      loras = loraLists[s.engine] || []; fillLoraSel(); renderLoras(); engineNote(); reflectReady();
    } });
  art.body.append(note, setupBtn, promptBox);
  buttonGroup(art.body, { title: 'Look', labels: STYLES.map(x => x[1]), index: Math.max(0, STYLES.findIndex(x => x[0] === s.style)), cols: 3,
    onChange: i => { s.style = STYLES[i][0]; save(); } });

  // LoRA styles
  const loraList = el('div', { class: 'loras' });
  const loraSel = el('select');
  const fillLoraSel = () => {
    loraSel.replaceChildren(el('option', { value: '', text: loras.length ? '+ Add a LoRA style…' : `No ${s.engine === 'flux' ? 'FLUX.2 klein' : 'ERNIE'} LoRAs in Protoart Studio yet` }), ...loras.map(l => el('option', { value: l.name, text: l.label })));
    loraSel.disabled = !loras.length;
  };
  fillLoraSel();
  loraSel.addEventListener('change', () => {
    const name = loraSel.value; loraSel.value = '';
    if (!name || s[key()].some(l => l.name === name)) return;
    if (s[key()].length >= MAX_LORAS) { toast(`Up to ${MAX_LORAS} LoRAs at once.`); return; }
    s[key()].push({ name, scale: 1 }); save(); renderLoras();
  });
  const renderLoras = () => {
    loraList.replaceChildren(...s[key()].map(l => {
      const info = loras.find(x => x.name === l.name) || { label: l.name, trigger: '' };
      const row = el('div', { class: 'lora' });
      const text = el('div', { class: 'lora-text' },
        el('div', { class: 'row' }, el('b', { text: info.label }), el('button', { class: 'mini', text: '×', title: 'Remove', onclick: () => { s[key()] = s[key()].filter(x => x !== l); save(); renderLoras(); } })),
        info.trigger ? el('div', { class: 'note', text: `Trigger: ${info.trigger}` }) : el('div', { class: 'note', text: 'No trigger words' }));
      const nearest = LORA_STEPS.reduce((b, v, i) => (Math.abs(v - l.scale) < Math.abs(LORA_STEPS[b] - l.scale) ? i : b), 0);
      row.append(text);
      knob(row, { title: 'Strength', labels: LORA_STEPS.map(v => (v === 0 ? '0' : String(v).replace(/^0/, ''))), index: nearest, size: 34, radius: 30, labelSize: 7.5,
        onChange: i => { l.scale = LORA_STEPS[i]; save(); }, onReset: () => { l.scale = 1; save(); renderLoras(); } });
      return row;
    }));
  };
  renderLoras();
  art.body.append(el('div', { class: 'engr', text: 'LoRA styles' }), loraSel, loraList);
  const finalPrompt = () => {
    let p = s.prompt.trim();
    for (const l of s[key()]) {
      const t = loras.find(x => x.name === l.name)?.trigger;
      if (t && !p.toLowerCase().includes(t.toLowerCase())) p = `${t}, ${p}`;
    }
    return p;
  };

  if (opts.extra) art.body.append(...[].concat(opts.extra));

  // pictures + generate
  const ctrl = el('div', { class: 'ctrl-row' });
  knob(ctrl, { title: 'Pictures', labels: ['1', '2', '3', '4'], index: s.variations - 1, size: 40, radius: 32, sweep: 180, onChange: i => { s.variations = i + 1; save(); } });
  const readout = segDisplay('  0', { height: 22 });
  const sizeNote = el('div', { class: 'readout small' });
  // a small live preview of the picture as it forms (a rough underdrawing, sharper every step)
  const peek = el('div', { class: 'gen-peek', title: 'Live preview while the picture is being made' }, el('img', { alt: '' }), el('span', { class: 'engr', text: 'PREVIEW' }));
  ctrl.append(el('div', { class: 'gauge' }, el('div', { class: 'engr', text: 'Done %' }), readout, sizeNote), peek);
  art.body.append(ctrl);
  const progress = el('div', { class: 'progress hidden' }, el('i'));
  const genBtn = pushButton({ label: 'Generate', lamp: 'amber' });
  // why it can't paint yet, right under the button (the engine note can be scrolled out of sight)
  const why = el('p', { class: 'note warn gen-why hidden' });
  const reflectReady = () => {
    const ok = engineReady();
    genBtn.classList.toggle('not-ready', !ok);
    why.textContent = ok ? '' : (s.engine === 'flux' ? status.flux.reason || 'FLUX isn’t set up yet.' : status.ernie.reason || 'ERNIE isn’t ready yet.');
    why.classList.toggle('hidden', ok);
  };
  genBtn.disabled = false;
  engineNote();
  const stopBtn = pushButton({ label: 'Stop', lamp: 'red', cls: 'hidden' });
  art.body.append(el('div', { class: 'gen-row' }, genBtn, stopBtn), why, progress);
  reflectReady();
  const updateSize = () => { const o = opts.size(), g = genSize(o.w, o.h); sizeNote.textContent = `${g.w}×${g.h} → ${o.w}×${o.h}`; sizeNote.title = `ERNIE paints at ${g.w}×${g.h}; the picture is scaled to ${o.w}×${o.h}.`; };
  updateSize();

  let generating = false, stopRequested = false;
  const showPct = p => readout.set(String(Math.round(p)).padStart(3, ' '));
  const onAi = ev => {
    if (!generating) return;
    if (ev.type === 'progress') { const p = (ev.step / ev.steps) * 100; progress.firstChild.style.width = p + '%'; showPct(p); }
    if (ev.type === 'status') setNote(ev.msg);
    if (ev.type === 'preview' && ev.png) { peek.firstChild.src = 'data:image/png;base64,' + ev.png; peek.classList.add('on'); }
  };
  app.aiListeners.add(onAi);
  const working = on => { art.lamp.classList.toggle('on', on); art.lamp.classList.toggle('blink', on); app.setLamp?.('ernie', on); genBtn.light(on); genBtn.classList.toggle('working', on); };

  // ================================================================ gallery
  const gallery = []; // { img, png }
  let current = null;
  const galleryEl = el('div', { class: 'ts-gallery' });
  const renderGallery = () => {
    const o = opts.size();
    const gw = 256, gh = Math.round(256 * o.h / o.w);
    if (!opts.galleryCols) galleryEl.style.gridTemplateColumns = `repeat(${o.h > o.w ? 6 : 4}, 1fr)`;
    else galleryEl.style.gridTemplateColumns = `repeat(${opts.galleryCols(o)}, 1fr)`;
    galleryEl.replaceChildren(...gallery.map(g => {
      const c = el('canvas', { width: gw, height: gh, style: { width: '100%', cursor: 'pointer', outline: g === current ? '2px solid var(--amber)' : '' } });
      coverDraw(c.getContext('2d'), g.img, gw, gh);
      c.addEventListener('click', () => { current = g; renderGallery(); opts.onPick?.(g.img, g.png); });
      const add = el('button', { class: 'mini', text: '+ MEDIA', title: 'Add this picture to the project’s media', onclick: async e => { e.stopPropagation(); add.disabled = true; try { await app.addAiImage(g.png, s.genre || 'image', false); toast('Added to media.'); } catch (err) { toast(err.message); add.disabled = false; } } });
      return el('div', { class: 'gal-item' }, c, add);
    }));
  };

  stopBtn.addEventListener('click', () => { stopRequested = true; app.api.aiCancel(); });
  genBtn.addEventListener('click', async () => {
    if (generating) return;
    if (!engineReady()) {
      // maybe it became ready since the panel opened (Protoart Studio finished a download, say)
      status = await app.api.aiStatus().catch(() => status); status.flux ||= { ready: false };
      engineNote(); reflectReady();
      if (!engineReady()) {
        why.classList.add('flash'); setTimeout(() => why.classList.remove('flash'), 600);
        if (s.engine === 'flux' && status.flux.canSetup) toast('FLUX needs a one-time download first: press GET FLUX.');
        else if (s.engine === 'ernie' && status.flux.ready) toast('ERNIE isn’t ready on this Mac. Switch the engine to FLUX, or set ERNIE up in Protoart Studio.');
        else toast(why.textContent);
        return;
      }
    }
    if (!s.prompt.trim()) { toast('Write a prompt, or pick a channel and press IDEAS.'); return; }
    peek.classList.remove('on'); peek.firstChild.removeAttribute('src');
    generating = true; stopRequested = false; working(true);
    stopBtn.classList.remove('hidden'); progress.classList.remove('hidden');
    const mode = opts.mode();
    const image = mode === 'img2img' ? await opts.startImage() : undefined;
    const o = opts.size(), g = genSize(o.w, o.h);
    for (let i = 0; i < s.variations && !stopRequested; i++) {
      setNote(`Making picture ${i + 1} of ${s.variations}…` + (i === 0 ? (s.engine === 'flux' ? ' (FLUX)' : '') + (s[key()].length ? ' (loading LoRA styles)' : '') : ''));
      progress.firstChild.style.width = '0%'; showPct(0);
      try {
        const png = await app.api.aiGenerate(app.token, {
          mode, prompt: finalPrompt(), negative: NEGATIVE, width: g.w, height: g.h, steps: s.engine === 'flux' ? 4 : 8, engine: s.engine,
          seed: Math.floor(Math.random() * 2 ** 31), strength: opts.strength ? opts.strength() : 0.6, image, loras: s[key()],
        });
        const img = await createImageBitmap(new Blob([png], { type: 'image/png' }));
        peek.firstChild.src = URL.createObjectURL(new Blob([png], { type: 'image/png' })); peek.classList.add('on', 'final');
        current = { img, png };
        gallery.push(current);
        renderGallery(); showPct(100);
        opts.onImage?.(img, png);
      } catch (e) {
        if (!/Stopped/.test(e.message)) setNote(e.message, true);
        break;
      }
    }
    if (!stopRequested && gallery.length) setNote('Done. Click a picture to use it; + MEDIA adds it to the project.');
    generating = false; working(false);
    reflectReady(); stopBtn.classList.add('hidden'); progress.classList.add('hidden');
  });

  if (s.genre) showIdeas();
  return {
    channel, art, galleryEl, status, updateSize, renderGallery,
    current: () => current,
    dispose: () => { app.aiListeners.delete(onAi); if (generating) { app.api.aiCancel(); working(false); } },
  };
}

/** Fill w×h with the image, cropping the overflow (pictures made at another size never stretch). */
function coverDraw(ctx, img, w, h) {
  const k = Math.max(w / img.width, h / img.height), sw = w / k, sh = h / k;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, w, h);
}

// ------------------------------------------------------------------ AI Image generator
const IMAGE_SIZES = [
  { id: 'project', short: 'Project', label: 'Project canvas', w: 0, h: 0 },
  { id: '16x9', short: '16:9', label: 'Wide 16:9', w: 1920, h: 1080 },
  { id: '9x16', short: '9:16', label: 'Vertical 9:16', w: 1080, h: 1920 },
  { id: '1x1', short: '1:1', label: 'Square', w: 1080, h: 1080 },
  { id: '4x5', short: '4:5', label: 'Portrait 4:5', w: 1080, h: 1350 },
  ...SIZE_PRESETS.filter(p => ['yt', 'social', 'x', 'podcast', 'banner'].includes(p.id)),
];

/** Make pictures to use in the edit: backgrounds, B-roll stills, overlays, intro cards. */
export async function openImageGenerator(app) {
  const doc = app.doc;
  if (!doc) return;
  const s = structuredClone(doc.imageGen || {});
  s.size ??= 'project';
  const save = () => app.commit(() => { doc.imageGen = structuredClone(s); }, { quiet: true });
  const preset = () => IMAGE_SIZES.find(x => x.id === s.size) || IMAGE_SIZES[0];
  const size = () => { const p = preset(); return p.id === 'project' ? { w: doc.canvas.width, h: doc.canvas.height } : { w: p.w, h: p.h }; };
  const preview = el('canvas', { class: 'ig-preview' });
  const showImg = img => {
    const o = size();
    preview.width = o.w; preview.height = o.h; preview.style.aspectRatio = `${o.w}/${o.h}`;
    const ctx = preview.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, o.w, o.h);
    if (img) coverDraw(ctx, img, o.w, o.h);
  };
  showImg(null);

  // CANVAS module: format knob + size readout
  const fmtName = el('div', { class: 'readout' });
  const canvasMod = module('Canvas', { finish: 'slate', sub: 'Picture size' });
  const showFmt = () => { const p = preset(), o = size(); fmtName.textContent = `${p.id === 'project' ? 'Project' : p.label.replace(/ ·.*/, '')} · ${o.w}×${o.h}`; };
  // same lit-button grid as the CHANNEL module: one button per size, its pixels underneath
  let panel;
  const NAMES = { project: 'Project', '16x9': 'Wide 16:9', '9x16': 'Vertical 9:16', '1x1': 'Square 1:1', '4x5': 'Portrait 4:5',
    yt: 'YT thumbnail', social: 'Link card', x: 'X post', podcast: 'Podcast', banner: 'YT banner' };
  buttonGroup(canvasMod.body, {
    labels: IMAGE_SIZES.map(p => NAMES[p.id] || p.short || p.label),
    subs: IMAGE_SIZES.map(p => (p.id === 'project' ? `${doc.canvas.width}×${doc.canvas.height}` : `${p.w}×${p.h}`)),
    index: Math.max(0, IMAGE_SIZES.findIndex(p => p.id === s.size)), cols: 2, lamp: 'amber', cls: 'sizes',
    onChange: i => { s.size = IMAGE_SIZES[i].id; save(); showFmt(); panel.updateSize(); panel.renderGallery(); showImg(panel.current()?.img); },
  });
  canvasMod.body.append(el('div', { class: 'gauge' }, fmtName, tape('Backgrounds · B-roll · title cards', { size: 12, angle: -1.2, seed: 3 })));
  showFmt();

  panel = await erniePanel(app, s, save, { size, galleryCols: o => (o.h > o.w ? 3 : 2), mode: () => 'txt2img', onImage: img => showImg(img), onPick: img => showImg(img) });

  const addCurrent = async place => {
    const c = panel.current();
    if (!c) { toast('Generate a picture first.'); return; }
    try {
      const o = size();
      const out = el('canvas', { width: o.w, height: o.h });
      coverDraw(out.getContext('2d'), c.img, o.w, o.h);
      const png = new Uint8Array(await (await new Promise(r => out.toBlob(r, 'image/png'))).arrayBuffer());
      await app.addAiImage(png, s.genre || 'image', place);
      toast(place ? 'Added at the playhead.' : 'Added to media.');
    } catch (e) { toast(e.message); }
  };

  // Picture on top; below it the three modules stand side by side like a 500-series rack, each one a
  // tall vertical strip that scrolls on its own.
  const slot = m => el('div', { class: 'rack-slot' }, m);
  const body = el('div', { class: 'ig' },
    el('div', { class: 'ig-top' }, el('div', { class: 'ts-canvas-wrap' }, preview), el('div', { class: 'ig-gallery' }, el('div', { class: 'engr', text: 'Pictures' }), panel.galleryEl)),
    el('div', { class: 'rack-rail' }, slot(canvasMod), slot(panel.channel), slot(panel.art)));
  modal('AI Image', body, [
    { label: 'Close', onClick: c => c() },
    { label: 'Add to media', cls: 'hw', onClick: () => addCurrent(false) },
    { label: 'Add at playhead', cls: 'hw amber', onClick: () => addCurrent(true) },
  ], { wide: true, onClose: () => panel.dispose() });
}

/** One-time FLUX.2 [klein] download (4.6 GB) for Macs where Protoart Studio hasn't fetched it yet. */
export function openFluxSetup(app, onDone) {
  const bar = el('div', { class: 'progress' }, el('i'));
  const msg = el('p', { class: 'note', text: '' });
  let running = false;
  const listener = ev => {
    if (ev.type !== 'setup') return;
    if (ev.msg) msg.textContent = ev.msg;
    if (typeof ev.f === 'number') bar.firstChild.style.width = (ev.f * 100).toFixed(1) + '%';
  };
  app.aiListeners.add(listener);
  const body = el('div', { class: 'flux-setup' },
    el('p', { text: 'FLUX.2 [klein] 4B by Black Forest Labs (Apache 2.0). It follows long, detailed prompts very closely, in 4 steps.' }),
    el('ul', {},
      el('li', { text: 'Downloads the 4-bit copy Protoart Studio uses: 4.6 GB, one time. Studio and Reel then share it.' }),
      el('li', { text: 'Made for 8 GB Macs: only one picture engine is in memory at a time, and it unloads soon after use.' }),
      el('li', { text: 'After that FLUX runs offline, like ERNIE.' })),
    bar, msg);
  const dlg = modal('Get FLUX', body, [
    { label: 'Close', onClick: c => { if (running) app.api.aiFluxSetupCancel(); c(); } },
    { label: 'Download (4.6 GB)', cls: 'hw amber', onClick: async (c, btn) => {
      if (running) return;
      running = true; btn.disabled = true; msg.textContent = 'Starting…';
      try {
        const r = await app.api.aiFluxSetup({});
        msg.textContent = `FLUX.2 [klein] is ready (${(r.bytes / 1e9).toFixed(1)} GB). Pick FLUX and press Generate.`;
        bar.firstChild.style.width = '100%';
        onDone && onDone();
      } catch (e) { msg.textContent = e.message === 'Stopped' ? 'Stopped. Press Download again to carry on where it left off.' : e.message; }
      running = false; btn.disabled = false; void c;
    } },
  ], { onClose: () => { app.aiListeners.delete(listener); if (running) app.api.aiFluxSetupCancel(); } });
  void dlg;
}
