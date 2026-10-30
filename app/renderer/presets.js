// Project presets (New Document: size and frame rate) and built-in starter templates for the platforms
// people post to most. Every template has three sound tracks (Voice, Music, Sound FX), two picture
// tracks (Main video, B-roll / overlays) and a Titles track, an opening title card and an end card that
// fades the video out. The text is placeholder copy, ready to be replaced.
import { el, modal, toast } from './ui.js';
import { newTextClip, uid } from './model.js';

export const DOC_PRESETS = [
  ['1080 Vertical (TikTok, Reels, Shorts)', 1080, 1920],
  ['1080p HD 16:9', 1920, 1080],
  ['4K UHD 16:9', 3840, 2160],
  ['1440p QHD 16:9', 2560, 1440],
  ['720p HD 16:9', 1280, 720],
  ['Square 1:1', 1080, 1080],
  ['Portrait 4:5 (Instagram feed)', 1080, 1350],
  ['Mac screen 16:10', 1440, 900],
  ['Retina 16:10', 2880, 1800],
  ['Custom', 0, 0],
];
export const FRAME_RATES = [24, 25, 30, 50, 60];

/** Built-in starters. Times in seconds; text sizes are for the template's own canvas. */
export const STARTERS = [
  {
    id: 'youtube', name: 'YouTube video', sub: '16:9 · 1920×1080 · 30 fps', w: 1920, h: 1080, fps: 30, length: 60,
    title: 'YOUR VIDEO TITLE', tagline: 'Channel name · episode 1', end: 'THANKS FOR WATCHING', endSub: 'Subscribe for more',
    titleSize: 120, subSize: 44, anim: 'buildScale', accent: '#ffb02a',
  },
  {
    id: 'shorts', name: 'YouTube Shorts', sub: '9:16 · 1080×1920 · 30 fps', w: 1080, h: 1920, fps: 30, length: 45,
    title: 'WATCH THIS', tagline: '@yourchannel', end: 'SUBSCRIBE', endSub: 'for part 2',
    titleSize: 130, subSize: 52, anim: 'pop', accent: '#ff3b30',
  },
  {
    id: 'tiktok', name: 'TikTok', sub: '9:16 · 1080×1920 · 30 fps', w: 1080, h: 1920, fps: 30, length: 30,
    title: 'WAIT FOR IT…', tagline: '@yourhandle', end: 'FOLLOW FOR MORE', endSub: '@yourhandle',
    titleSize: 120, subSize: 50, anim: 'bounce', accent: '#25f4ee',
  },
  {
    id: 'reels', name: 'Instagram Reels', sub: '9:16 · 1080×1920 · 30 fps', w: 1080, h: 1920, fps: 30, length: 30,
    title: 'Your hook here', tagline: '@yourhandle', end: 'Save this for later', endSub: 'Follow @yourhandle',
    titleSize: 110, subSize: 48, anim: 'moveIntoPlace', accent: '#e1306c',
  },
  {
    id: 'instagram-feed', name: 'Instagram feed video', sub: '4:5 · 1080×1350 · 30 fps', w: 1080, h: 1350, fps: 30, length: 30,
    title: 'Your title', tagline: '@yourhandle', end: 'Thanks for watching', endSub: 'Follow @yourhandle',
    titleSize: 104, subSize: 44, anim: 'fadeChars', accent: '#e1306c',
  },
  {
    id: 'square', name: 'Square post', sub: '1:1 · 1080×1080 · 30 fps', w: 1080, h: 1080, fps: 30, length: 30,
    title: 'Your title', tagline: 'Subtitle', end: 'The end', endSub: 'yourwebsite.com',
    titleSize: 100, subSize: 42, anim: 'fade', accent: '#ffb02a',
  },
];

/**
 * A small picture of a starter: its frame shape, title card in its colours, and a hint of the platform's
 * own screen (YouTube's red progress bar, the right-hand buttons and caption of TikTok / Shorts / Reels).
 */
export function starterThumb(st, height = 120) {
  const k = Math.min(2, devicePixelRatio || 1), h = height, w = Math.round((h * st.w) / st.h);
  const c = document.createElement('canvas'); c.width = w * k; c.height = h * k; c.style.width = w + 'px'; c.style.height = h + 'px';
  const g = c.getContext('2d'); g.scale(k, k);
  const bg = g.createLinearGradient(0, 0, w, h); bg.addColorStop(0, '#16161a'); bg.addColorStop(1, '#2a1d14'); g.fillStyle = bg; g.fillRect(0, 0, w, h);
  // the video area, suggested by soft bands of light
  g.globalAlpha = 0.18; for (let i = 0; i < 5; i++) { g.fillStyle = i % 2 ? st.accent : '#ffffff'; g.beginPath(); g.ellipse(w * (0.2 + i * 0.17), h * (0.62 + (i % 2) * 0.12), w * 0.22, h * 0.09, -0.3, 0, Math.PI * 2); g.fill(); } g.globalAlpha = 1;
  // title card
  const ts = Math.max(9, Math.min(w * 0.15, h * 0.11));
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `900 ${ts}px "Avenir Next Condensed", "Arial Narrow", sans-serif`; g.fillStyle = '#fff'; g.shadowColor = 'rgba(0,0,0,.7)'; g.shadowBlur = 4;
  const words = st.title.split(' '), lines = []; let line = '';
  for (const wd of words) { const t = line ? line + ' ' + wd : wd; if (g.measureText(t).width > w * 0.84 && line) { lines.push(line); line = wd; } else line = t; }
  lines.push(line);
  lines.forEach((l, i) => g.fillText(l, w / 2, h * 0.42 + (i - (lines.length - 1) / 2) * ts * 1.05));
  g.font = `700 ${ts * 0.48}px "Avenir Next", sans-serif`; g.fillStyle = st.accent; g.shadowBlur = 0;
  g.fillText(st.tagline, w / 2, h * 0.42 + ((lines.length + 1) / 2) * ts * 1.05);
  // platform chrome
  if (st.w > st.h) { g.fillStyle = 'rgba(255,255,255,.25)'; g.fillRect(6, h - 6, w - 12, 2); g.fillStyle = '#ff2b2b'; g.fillRect(6, h - 6, (w - 12) * 0.35, 2); g.beginPath(); g.arc(6 + (w - 12) * 0.35, h - 5, 3, 0, Math.PI * 2); g.fill(); }
  else if (st.w / st.h < 0.7) {
    g.fillStyle = 'rgba(255,255,255,.55)'; for (let i = 0; i < 4; i++) { g.beginPath(); g.arc(w - 9, h * 0.5 + i * 13, 3.5, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = 'rgba(255,255,255,.4)'; g.fillRect(7, h - 22, w * 0.55, 3); g.fillRect(7, h - 15, w * 0.38, 3);
  } else { g.strokeStyle = 'rgba(255,255,255,.3)'; g.strokeRect(4.5, 4.5, w - 9, h - 9); }
  // the end card fades it out: a hint in the corner
  const fade = g.createLinearGradient(w * 0.72, 0, w, 0); fade.addColorStop(0, 'rgba(0,0,0,0)'); fade.addColorStop(1, 'rgba(0,0,0,.55)'); g.fillStyle = fade; g.fillRect(w * 0.72, 0, w * 0.28, h);
  return c;
}

/** Puts a starter's tracks and clips into an empty, freshly made document. */
export function applyStarter(doc, s) {
  doc.canvas = { ...doc.canvas, width: s.w, height: s.h, fps: s.fps, background: '#000000' };
  const T = (name, extra = {}) => ({ id: uid('t'), name, ...extra });
  const titles = T('Titles'), broll = T('B-roll / overlays'), main = T('Main video');
  const voice = T('Voice'), music = T('Music', { volume: 0.35 }), sfx = T('Sound FX', { volume: 0.8 });
  doc.tracks = [titles, broll, main, voice, music, sfx];
  doc.clips = [];
  const L = s.length;
  const text = (track, start, dur, content, o = {}) => {
    const c = newTextClip(track.id, start, content);
    c.duration = dur;
    Object.assign(c.text, { size: s.subSize, weight: 700, anim: 'fade', animDur: 0.4, ...o.text });
    Object.assign(c.props, { y: 0.5, ...o.props });
    c.transIn = o.transIn || { type: 'none', dur: 0.4 };
    c.transOut = o.transOut || { type: 'fade', dur: 0.4 };
    c.name = o.name || content;
    doc.clips.push(c);
    return c;
  };
  // opening title card
  text(titles, 0, 3, s.title, { name: 'Title card (replace the text)', text: { size: s.titleSize, weight: 900, anim: s.anim, animDur: 0.6, shadow: 18 }, props: { y: 0.45 }, transOut: { type: 'fade', dur: 0.5 } });
  text(titles, 0.4, 2.6, s.tagline, { name: 'Title card subtitle', text: { size: s.subSize, color: s.accent, anim: 'fade', animDur: 0.5 }, props: { y: 0.45 + (s.titleSize * 1.15) / s.h } , transOut: { type: 'fade', dur: 0.5 } });
  // placeholder where the main video goes
  text(main, 3, L - 7, 'DROP YOUR VIDEO ON THIS TRACK', {
    name: 'Placeholder: drop your video here, then delete this',
    text: { size: Math.round(s.subSize * 0.9), color: '#8a857c', weight: 700, bg: '#000000', bgOpacity: 0, stroke: 0, anim: 'none' },
    transOut: { type: 'none', dur: 0.4 },
  });
  // end card: fades the whole video out
  text(titles, L - 4, 4, s.end, { name: 'End card (replace the text)', text: { size: Math.round(s.titleSize * 0.8), weight: 900, anim: s.anim, animDur: 0.5 }, props: { y: 0.46 }, transIn: { type: 'fade', dur: 0.5 }, transOut: { type: 'fade', dur: 1.2 } });
  text(titles, L - 3.6, 3.6, s.endSub, { name: 'End card subtitle', text: { size: s.subSize, color: s.accent }, props: { y: 0.46 + (s.titleSize * 0.95) / s.h }, transIn: { type: 'fade', dur: 0.5 }, transOut: { type: 'fade', dur: 1.2 } });
  doc.markers = [{ id: uid('k'), t: 3, label: 'Video starts' }, { id: uid('k'), t: L - 4, label: 'End card' }];
  return doc;
}

/** New Document dialog (ScreenFlow's): a preset, width × height and frame rate, or a starter template. */
export function openNewDocument(app) {
  return new Promise(resolve => {
    let picked = null;
    const sel = el('select', {}, ...DOC_PRESETS.map(([n], i) => el('option', { value: String(i), text: n })));
    const w = el('input', { type: 'number', min: 160, max: 7680, step: 2, value: 1080 });
    const h = el('input', { type: 'number', min: 160, max: 7680, step: 2, value: 1920 });
    const fps = el('select', {}, ...FRAME_RATES.map(f => el('option', { value: String(f), text: `${f} fps` })));
    fps.value = '30';
    const syncFromPreset = () => { const p = DOC_PRESETS[Number(sel.value)]; if (p[1]) { w.value = p[1]; h.value = p[2]; } w.disabled = h.disabled = !!p[1]; };
    sel.addEventListener('change', syncFromPreset);
    // start from what you picked last time
    let lastDoc = null;
    try { lastDoc = JSON.parse(localStorage.getItem('reel.newDoc') || 'null'); } catch { /* defaults */ }
    if (lastDoc && DOC_PRESETS[lastDoc.preset]) sel.value = String(lastDoc.preset);
    syncFromPreset();
    if (lastDoc && !DOC_PRESETS[Number(sel.value)][1] && lastDoc.w && lastDoc.h) { w.value = lastDoc.w; h.value = lastDoc.h; }
    if (lastDoc && FRAME_RATES.includes(Number(lastDoc.fps))) fps.value = String(lastDoc.fps);
    const starters = el('div', { class: 'starter-grid' }, ...STARTERS.map(st => {
      const b = el('button', { class: 'starter', type: 'button', title: `${st.name}: Titles, B-roll, Main video, Voice, Music and Sound FX tracks, a title card and an end card that fades out` },
        el('span', { class: 'st-frame' }, starterThumb(st, 76)),
        el('b', { text: st.name }), el('small', { text: st.sub }));
      b.addEventListener('click', () => { picked = picked === st ? null : st; for (const x of starters.children) x.classList.toggle('lit', x === b && !!picked); });
      return b;
    }));
    const body = el('div', { class: 'newdoc' },
      el('div', { class: 'engr', text: 'Blank document' }),
      el('div', { class: 'row' }, el('label', { text: 'Preset' }), sel),
      el('div', { class: 'row' }, el('label', { text: 'Width' }), w, el('label', { text: 'Height' }), h),
      el('div', { class: 'row' }, el('label', { text: 'Frame rate' }), fps),
      el('div', { class: 'engr', text: 'Or start from a template' }),
      el('p', { class: 'note', text: 'Each has Voice, Music and Sound FX tracks, Main video and B-roll tracks, a title card and an end card that fades the video out.' }),
      starters);
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    modal('New Document', body, [
      { label: 'Cancel', onClick: c => { finish(null); c(); } },
      { label: 'Create', cls: 'hw amber', onClick: c => {
        const W = Math.round(Number(w.value) / 2) * 2, H = Math.round(Number(h.value) / 2) * 2;
        if (!picked && !(W >= 160 && H >= 160 && W <= 7680 && H <= 7680)) { toast('Width and height must be between 160 and 7680.'); return; }
        try { localStorage.setItem('reel.newDoc', JSON.stringify({ preset: Number(sel.value), w: W, h: H, fps: Number(fps.value) })); } catch { /* fine */ }
        finish(picked ? { starter: picked } : { width: W, height: H, fps: Number(fps.value) });
        c();
      } },
    ], { onClose: () => finish(null) });
    void app;
  });
}
