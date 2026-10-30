// Thumbnail Studio: thumbnails and covers in every common size (YouTube, Shorts/TikTok/Reels,
// Instagram, X, podcast covers, channel banners) from a video frame and/or ERNIE-Image art made on
// this Mac, with a big title, an optional framed screenshot, and channel-type looks and ideas.
import { el, modal, toast, slider } from './ui.js';
import { duration, fmtTime, clamp } from './model.js';
import { hexA } from './compositor.js';
import { SIZE_PRESETS, genreById } from './genres.js';
import { erniePanel } from './imagegen.js';
import { module, knob, buttonGroup, latch, tape } from './gear.js';

const SHORT_SIZE = { yt: 'YT', 'yt-hd': 'HD', shorts: 'Shorts', 'ig-square': '1:1', 'ig-portrait': '4:5', social: 'Link', x: 'X', podcast: 'Pod', banner: 'Banner' };

const FONTS = ['Avenir Next Condensed', 'Impact', 'Futura', 'Avenir Next', 'DIN Condensed', 'Helvetica Neue', 'Arial Black', 'Rockwell', 'Marker Felt', 'Poppins', 'SF Pro Display', 'Didot'];

export async function openThumbnailStudio(app) {
  const doc = app.doc;
  if (!doc) return;
  const saved = doc.thumbStudio || {};
  const st = {
    preset: saved.preset || 'yt',
    bg: saved.bg || 'frame', frameT: Math.min(saved.frameT ?? app.player.time, duration(doc)),
    strength: saved.strength ?? 0.55, title: saved.title ?? doc.name, subtitle: saved.subtitle || '',
    font: saved.font || 'Avenir Next Condensed', size: saved.size || 118, color: saved.color || '#ffffff', accent: saved.accent || '#ffb02a',
    accentLast: saved.accentLast ?? true, outline: saved.outline || '#000000', upper: saved.upper ?? true, pos: saved.pos || 'left',
    tx: saved.tx ?? 0.3, ty: saved.ty ?? 0.5, darken: saved.darken ?? 0.55, inset: saved.inset ?? false, insetSide: saved.insetSide || 'right', insetSize: saved.insetSize ?? 0.5,
    ai: { prompt: saved.prompt || '', style: saved.style || 'bold', variations: saved.variations || 2, genre: saved.genre || '', loras: saved.loras || [], ...(saved.ai || {}) },
  };
  const persist = () => app.commit(() => { doc.thumbStudio = structuredClone(st); }, { quiet: true });
  const dims = () => { const p = SIZE_PRESETS.find(x => x.id === st.preset) || SIZE_PRESETS[0]; return { w: p.w, h: p.h }; };
  let W = 0, H = 0;
  let frame = null, ai = null;

  const canvas = el('canvas');
  const ctx = canvas.getContext('2d');
  const resize = () => { ({ w: W, h: H } = dims()); canvas.width = W; canvas.height = H; canvas.style.aspectRatio = `${W}/${H}`; };
  resize();

  const draw = () => {
    ctx.save();
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const bgImg = st.bg !== 'frame' && ai ? ai : frame;
    if (bgImg) cover(ctx, bgImg, 0, 0, W, H);
    if (st.darken > 0) {
      let g;
      if (st.pos === 'left') g = ctx.createLinearGradient(0, 0, W * 0.75, 0);
      else if (st.pos === 'right') g = ctx.createLinearGradient(W, 0, W * 0.25, 0);
      else if (st.pos === 'bottom') g = ctx.createLinearGradient(0, H, 0, H * 0.35);
      if (g) { g.addColorStop(0, `rgba(0,0,0,${st.darken})`); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); }
      else { ctx.fillStyle = `rgba(0,0,0,${st.darken * 0.5})`; ctx.fillRect(0, 0, W, H); }
    }
    if (st.inset && frame) {
      const k = scaleOf(W, H);
      const iw = W * st.insetSize, ih = iw * frame.height / frame.width;
      const x = st.insetSide === 'right' ? W - iw - W * 0.05 : W * 0.05, y = (H - ih) / 2;
      ctx.save();
      ctx.translate(x + iw / 2, y + ih / 2); ctx.rotate((st.insetSide === 'right' ? 2.5 : -2.5) * Math.PI / 180);
      ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 40 * k; ctx.shadowOffsetY = 12 * k;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.roundRect(-iw / 2 - 8 * k, -ih / 2 - 8 * k, iw + 16 * k, ih + 16 * k, 18 * k); ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.beginPath(); ctx.roundRect(-iw / 2, -ih / 2, iw, ih, 12 * k); ctx.clip();
      cover(ctx, frame, -iw / 2, -ih / 2, iw, ih);
      ctx.restore();
    }
    drawTitle(ctx, st, W, H);
    ctx.restore();
  };

  // The frame is grabbed at the project's own shape, then cropped to fill the thumbnail.
  const loadFrame = async () => { frame = await app.player.still(st.frameT, doc.canvas.width, doc.canvas.height); draw(); };
  const frameBytes = async () => {
    if (!frame) await loadFrame();
    // ERNIE + frame: give ERNIE the frame already cropped to the thumbnail's shape.
    const c = el('canvas', { width: W, height: H });
    cover(c.getContext('2d'), frame, 0, 0, W, H);
    return new Uint8Array(await (await new Promise(r => c.toBlob(r, 'image/png'))).arrayBuffer());
  };

  // ---------------------------------------------------------------- controls (rack modules)
  const live = (label, key, opts) => slider(label, st[key], { ...opts, onInput: v => { st[key] = v; draw(); }, onCommit: persist });
  const setSlider = (row, v, fmt) => { row.querySelector('input').value = v; row.querySelector('.val').textContent = fmt(v); };
  const POS_IDS = ['left', 'center', 'right', 'bottom'], BG_IDS = ['frame', 'txt2img', 'img2img'];

  // FORMAT: a rotary selector through every size preset, with the size on an amber readout.
  const sizeMod = module('Format', { finish: 'slate', sub: 'Where it’s going' });
  const fmtName = el('div', { class: 'readout' });
  const showFmt = () => { const p = SIZE_PRESETS.find(x => x.id === st.preset) || SIZE_PRESETS[0]; fmtName.textContent = p.label.replace(' · ', ' — '); };
  const sizeRow = el('div', { class: 'ctrl-row' });
  let panel;
  knob(sizeRow, { title: 'Size', labels: SIZE_PRESETS.map(p => SHORT_SIZE[p.id]), index: Math.max(0, SIZE_PRESETS.findIndex(p => p.id === st.preset)), size: 46, radius: 50, labelSize: 8,
    onChange: i => { st.preset = SIZE_PRESETS[i].id; showFmt(); resize(); panel.updateSize(); panel.renderGallery(); draw(); persist(); } });
  sizeRow.append(el('div', { class: 'gauge' }, fmtName, tape('Turn for Shorts, Instagram, podcast…', { size: 12, angle: -1.4, seed: 5 })));
  sizeMod.body.append(sizeRow);
  showFmt();

  // BACKGROUND
  const strengthRow = slider('Keep frame', 1 - st.strength, { min: 0.05, max: 0.95, step: 0.01, fmt: v => Math.round(v * 100) + '%', onInput: v => { st.strength = 1 - v; }, onCommit: persist });
  strengthRow.title = 'How much of the video frame survives. Lower = more ERNIE.';
  strengthRow.style.display = st.bg === 'img2img' ? '' : 'none';
  const frameSlider = slider('Frame', st.frameT, { min: 0, max: Math.max(0.1, duration(doc)), step: 0.01, fmt: v => fmtTime(v), onCommit: v => { st.frameT = v; loadFrame(); persist(); } });
  const bgMod = module('Background', { finish: 'graphite', sub: 'Video frame or ERNIE art' });
  const bgGroup = buttonGroup(bgMod.body, { labels: ['Video frame', 'ERNIE art', 'ERNIE + frame'], index: BG_IDS.indexOf(st.bg), lamp: 'amber',
    onChange: i => { st.bg = BG_IDS[i]; strengthRow.style.display = st.bg === 'img2img' ? '' : 'none'; draw(); persist(); } });
  const setBg = v => { st.bg = v; bgGroup.set(BG_IDS.indexOf(v)); strengthRow.style.display = v === 'img2img' ? '' : 'none'; };
  bgMod.body.append(frameSlider, el('div', { class: 'btn-row' }, el('button', { class: 'tool', text: 'Use playhead', onclick: () => { st.frameT = app.player.time; setSlider(frameSlider, st.frameT, fmtTime); loadFrame(); persist(); } })));

  // TITLE
  const titleMod = module('Title', { finish: 'bone', sub: 'Words on the picture' });
  const titleInput = el('textarea', { class: 'big', value: st.title, style: { minHeight: '50px' } });
  titleInput.addEventListener('input', () => { st.title = titleInput.value; draw(); });
  titleInput.addEventListener('change', persist);
  const subInput = el('input', { type: 'text', value: st.subtitle, placeholder: 'Badge (optional), e.g. NEW, 5 MIN, EASY' });
  subInput.addEventListener('input', () => { st.subtitle = subInput.value; draw(); });
  subInput.addEventListener('change', persist);
  const badgeBox = el('div');
  const fontSel = el('select', {}, ...FONTS.map(f => el('option', { value: f, text: f, selected: f === st.font })));
  fontSel.addEventListener('change', () => { st.font = fontSel.value; draw(); persist(); });
  const colors = {};
  const colorIn = key => { const c = el('input', { type: 'color', value: st[key] }); c.addEventListener('input', () => { st[key] = c.value; draw(); }); c.addEventListener('change', persist); colors[key] = c; return c; };
  titleMod.body.append(titleInput, subInput, badgeBox,
    el('div', { class: 'row' }, el('label', { text: 'Font' }), fontSel),
    live('Size', 'size', { min: 40, max: 220, step: 1, fmt: v => v.toFixed(0) }),
    el('div', { class: 'row' }, el('label', { text: 'Colours' }), colorIn('color'), colorIn('accent'), colorIn('outline')));
  const latches = el('div', { class: 'ctrl-row' });
  const upperL = latch(latches, { label: 'Caps', title: 'All caps', on: st.upper, onChange: v => { st.upper = v; draw(); persist(); } });
  latch(latches, { label: 'Accent', title: 'Last line', on: st.accentLast, onChange: v => { st.accentLast = v; draw(); persist(); } });
  titleMod.body.append(latches);
  const posGroup = buttonGroup(titleMod.body, { title: 'Position', labels: ['Left', 'Center', 'Right', 'Bottom'], index: POS_IDS.indexOf(st.pos),
    onChange: i => { st.pos = POS_IDS[i]; const p = POS[st.pos]; st.tx = p.x; st.ty = p.y; draw(); persist(); } });
  titleMod.body.append(live('Darken', 'darken', { min: 0, max: 0.9, step: 0.01, fmt: v => Math.round(v * 100) + '%' }),
    el('p', { class: 'note', text: 'Drag the title on the picture to place it. Sizes are relative, so the look carries across every format.' }));

  // FRAMED SCREENSHOT
  const insetMod = module('Screenshot', { finish: 'graphite', sub: 'The video frame in a white frame', lampColor: 'green', cls: st.inset ? '' : 'off' });
  insetMod.lamp.classList.toggle('on', !!st.inset);
  const insetRow = el('div', { class: 'ctrl-row keep' });
  const setInset = v => { st.inset = v; insetMod.classList.toggle('off', !v); insetMod.lamp.classList.toggle('on', v); };
  const insetL = latch(insetRow, { label: 'In', lamp: 'green', round: true, title: 'Module in', on: st.inset, onChange: v => { setInset(v); draw(); persist(); } });
  buttonGroup(insetRow, { title: 'Side', labels: ['Left', 'Right'], index: st.insetSide === 'left' ? 0 : 1, onChange: i => { st.insetSide = i ? 'right' : 'left'; draw(); persist(); } });
  insetMod.body.append(insetRow, live('Size', 'insetSize', { min: 0.25, max: 0.7, step: 0.01, fmt: v => Math.round(v * 100) + '%' }));

  /** Channel type picked: apply its title look and offer its badges. */
  const applyGenre = g => {
    Object.assign(st, { font: FONTS.includes(g.style.font) ? g.style.font : st.font, color: g.style.color, accent: g.style.accent, outline: g.style.outline, upper: g.style.upper, pos: g.style.pos });
    const p = POS[st.pos]; st.tx = p.x; st.ty = p.y;
    fontSel.value = st.font; for (const k of ['color', 'accent', 'outline']) colors[k].value = st[k];
    upperL.set(st.upper); posGroup.set(POS_IDS.indexOf(st.pos));
    if (g.style.inset !== undefined) { setInset(g.style.inset); insetL.set(g.style.inset); }
    showBadges(g); draw(); persist();
  };
  const showBadges = g => {
    badgeBox.replaceChildren();
    if (!g) return;
    const list = g.badges;
    buttonGroup(badgeBox, { title: 'Badges', labels: list, index: list.indexOf(st.subtitle), lamp: 'amber',
      onChange: i => { st.subtitle = list[i]; subInput.value = list[i]; draw(); persist(); } });
  };

  panel = await erniePanel(app, st.ai, persist, {
    size: dims, mode: () => (st.bg === 'img2img' ? 'img2img' : 'txt2img'), startImage: frameBytes, strength: () => st.strength,
    topic: () => st.title.replace(/\n/g, ' '),
    onImage: img => { ai = img; if (st.bg === 'frame') setBg('txt2img'); draw(); },
    onPick: img => { ai = img; if (st.bg === 'frame') setBg('txt2img'); draw(); },
    onGenre: applyGenre, extra: strengthRow,
  });
  showBadges(genreById(st.ai.genre));

  const side = el('div', { class: 'ts-side' }, sizeMod, panel.channel, bgMod, panel.art, titleMod, insetMod);

  const body = el('div', { class: 'ts' }, el('div', {}, el('div', { class: 'ts-canvas-wrap' }, canvas), panel.galleryEl), side);
  const pngBytes = async () => new Uint8Array(await (await new Promise(r => canvas.toBlob(r, 'image/png'))).arrayBuffer());
  const save = async (type) => {
    const blob = await new Promise(r => canvas.toBlob(r, type, 0.92));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (st.preset.startsWith('yt') && bytes.length > 2 * 1024 * 1024) toast(`This file is ${(bytes.length / 1048576).toFixed(1)} MB; YouTube allows 2 MB — JPG is usually well under.`, 6000);
    const r = await app.api.saveThumbnail(app.token, bytes, `${doc.name}${st.preset === 'yt' ? '' : ' ' + W + 'x' + H}`);
    app.commit(() => { doc.thumbnail = r.kept; }, { quiet: true });
    toast(r.saved ? 'Thumbnail saved.' : 'Kept with the project.');
  };
  modal('Thumbnail Studio', body, [
    { label: 'Close', onClick: c => c() },
    { label: 'Add to project', cls: 'hw', onClick: async () => { try { await app.addAiImage(await pngBytes(), 'thumbnail', false); toast('Added to media — use it as an intro or end card.'); } catch (e) { toast(e.message); } } },
    { label: 'Save JPG', cls: 'hw', onClick: () => save('image/jpeg') },
    { label: 'Save PNG', cls: 'hw amber', onClick: () => save('image/png') },
  ], { wide: true, onClose: () => panel.dispose() });

  // ---------------------------------------------------------------- drag the title
  canvas.addEventListener('pointerdown', e => {
    const r = canvas.getBoundingClientRect();
    const x0 = e.clientX, y0 = e.clientY, tx0 = st.tx, ty0 = st.ty;
    const move = ev => { st.tx = clamp(tx0 + (ev.clientX - x0) / r.width, 0, 1); st.ty = clamp(ty0 + (ev.clientY - y0) / r.height, 0, 1); st.pos = 'custom'; posGroup.set(-1); draw(); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); persist(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });

  await loadFrame();
}

/** Text and decorations are authored for 1280×720 and scaled to the preset. */
const scaleOf = (W, H) => Math.min(W / 1280, H / 720) * (W < H ? 1.35 : 1); // vertical covers are seen small: bigger type

const POS = { left: { x: 0.3, y: 0.5 }, center: { x: 0.5, y: 0.5 }, right: { x: 0.7, y: 0.5 }, bottom: { x: 0.5, y: 0.8 }, custom: { x: 0.5, y: 0.5 } };

function cover(ctx, img, x, y, w, h) {
  const iw = img.width || img.naturalWidth, ih = img.height || img.naturalHeight;
  if (!iw || !ih) return;
  const s = Math.max(w / iw, h / ih);
  const sw = w / s, sh = h / s;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
}

function drawTitle(ctx, st, W, H) {
  let text = String(st.title || '').trim();
  if (!text && !st.subtitle) return;
  if (st.upper) text = text.toUpperCase();
  const k = scaleOf(W, H), size = st.size * k;
  ctx.font = `900 ${size}px "${st.font}", "Avenir Next Condensed", Impact, sans-serif`;
  const maxW = st.pos === 'center' || st.pos === 'bottom' || W / H < 1.2 ? W * 0.86 : W * 0.56;
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const test = line ? line + ' ' + word : word;
      if (line && ctx.measureText(test).width > maxW) { lines.push(line); line = word; } else line = test;
    }
    if (line) lines.push(line);
  }
  const lh = size * 1.0;
  const cx = st.tx * W, cy = st.ty * H;
  const align = st.pos === 'left' ? 'left' : st.pos === 'right' ? 'right' : 'center';
  const widest = Math.max(0, ...lines.map(l => ctx.measureText(l).width));
  const ax = align === 'left' ? cx - widest / 2 : align === 'right' ? cx + widest / 2 : cx;
  ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  const top = cy - (lh * lines.length) / 2 + lh / 2;
  lines.forEach((l, i) => {
    const y = top + i * lh;
    ctx.shadowColor = 'rgba(0,0,0,0.65)'; ctx.shadowBlur = 24 * k; ctx.shadowOffsetY = 6 * k;
    ctx.lineWidth = size * 0.14; ctx.strokeStyle = st.outline;
    ctx.strokeText(l, ax, y);
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = st.accentLast && lines.length > 1 && i === lines.length - 1 ? st.accent : st.color;
    ctx.fillText(l, ax, y);
  });
  if (st.subtitle) {
    const fs = Math.round(size * 0.36);
    ctx.font = `800 ${fs}px "${st.font}", "Avenir Next", sans-serif`;
    const tw = ctx.measureText(st.subtitle.toUpperCase()).width, pad = fs * 0.5;
    const bw = tw + pad * 2, bh = fs * 1.5;
    const by = top - lh / 2 - bh - 14 * k;
    const bx = align === 'left' ? ax : align === 'right' ? ax - bw : ax - bw / 2;
    ctx.fillStyle = st.accent;
    ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 12 * k;
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, bh / 2); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = hexA('#000000', 0.9);
    ctx.textAlign = 'center';
    ctx.fillText(st.subtitle.toUpperCase(), bx + bw / 2, by + bh / 2 + 1);
  }
}
