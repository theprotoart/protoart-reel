// Smart Zoom for any video: watches the picture (no pointer track needed), finds where things move,
// where the shots cut and where the detail is, then writes zoom/pan actions onto the clip, the same
// actions you'd add by hand, so every one can be adjusted or removed afterwards.
//
//   analyse() plays the clip silently at up to 16× on a hidden video element (the proxy when there is
//   one) and keeps a tiny greyscale grid every ~0.2 s of source time.
//   plan() is pure: it turns those samples into actions for a style.
import { clamp } from './model.js';
import { previewFile } from './proxies.js';

export const STYLES = {
  follow: { label: 'Follow the action', hint: 'Screen recordings and tutorials: zooms in where things happen and back out when the action spreads.', zoom: 1.8, transition: 0.6, minHold: 1.1, maxBox: 0.5, punch: 0, drift: 0 },
  punchy: { label: 'Punchy (social)', hint: 'Vlogs, Shorts, TikTok: quick punch-ins on the action and a jump zoom on every other cut.', zoom: 1.45, transition: 0.22, minHold: 0.7, maxBox: 0.6, punch: 1.18, drift: 0 },
  cinematic: { label: 'Cinematic (old footage)', hint: 'Home video and archive clips: slow Ken Burns pushes toward the detail in each shot and gentle zooms on movement.', zoom: 1.3, transition: 1.4, minHold: 2, maxBox: 0.55, punch: 0, drift: 1.12 },
};

const GW = 48; // analysis grid width (height follows the aspect)

/** Samples the part of the media a clip uses. Resolves to { samples, gw, gh, aspect }. */
export async function analyse(app, c, m, { onProgress, signal } = {}) {
  const speed = c.speed || 1, from = c.in || 0, to = from + c.duration * speed;
  const gh = Math.max(12, Math.round((GW * (m.height || 1080)) / (m.width || 1920)));
  const cv = document.createElement('canvas'); cv.width = GW; cv.height = gh;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  Object.assign(v.style, { position: 'fixed', left: '-10px', top: '-10px', width: '4px', height: '4px', opacity: '0', pointerEvents: 'none' });
  v.src = `app://reel/m/${app.token}/${encodeURIComponent(previewFile(m))}`;
  document.body.append(v);
  const samples = [];
  let prev = null, cuts = null;
  const grab = mt => {
    ctx.drawImage(v, 0, 0, GW, gh);
    const px = ctx.getImageData(0, 0, GW, gh).data, g = new Float32Array(GW * gh);
    for (let i = 0; i < g.length; i++) g[i] = px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114;
    samples.push({ t: (mt - from) / speed, ...measure(g, prev, GW, gh) });
    prev = g;
    onProgress?.(clamp((mt - from) / Math.max(0.01, to - from), 0, 1));
  };
  const step = 0.2 * speed; // source seconds between samples
  try {
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('This video can’t be read')); setTimeout(() => rej(new Error('The video took too long to open')), 15000); });
    if (v.requestVideoFrameCallback && to - from > 3) await playThrough(v, from, to, step, grab, signal);
    else await seekThrough(v, from, to, step, grab, signal);
    // samples are ~0.2–0.4 s apart: find each cut's exact frame by seeking between its two samples
    cuts = [];
    for (const ct of findCuts(samples)) {
      if (signal?.aborted) throw new Error('Cancelled');
      const i = samples.findIndex(x => x.t === ct);
      let lo = samples[i - 1].t * speed + from, hi = ct * speed + from;
      const look = async t => { await seekTo(v, t); ctx.drawImage(v, 0, 0, GW, gh); const px = ctx.getImageData(0, 0, GW, gh).data; let d = 0; for (let k = 0; k < px.length; k += 4) d += Math.abs(px[k] - before[k]); return d / (px.length / 4); };
      await seekTo(v, lo); ctx.drawImage(v, 0, 0, GW, gh); const before = ctx.getImageData(0, 0, GW, gh).data;
      for (let n = 0; n < 6 && hi - lo > 1 / 60; n++) { const mid = (lo + hi) / 2; if ((await look(mid)) > 20) hi = mid; else lo = mid; }
      cuts.push(Math.max(0, (hi - from) / speed - 0.035)); // a frame early: never a zoomed frame of the new shot
    }
  } finally { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); }
  return { samples, cuts, gw: GW, gh, aspect: (m.width || 1920) / (m.height || 1080) };
}

function playThrough(v, from, to, step, grab, signal) {
  return new Promise((resolve, reject) => {
    let next = from, lastFrame = performance.now(), done = false;
    const finish = err => { if (done) return; done = true; clearInterval(watch); v.pause(); err ? reject(err) : resolve(); };
    const onFrame = (_now, meta) => {
      if (done) return;
      if (signal?.aborted) return finish(new Error('Cancelled'));
      lastFrame = performance.now();
      const mt = meta.mediaTime;
      if (mt >= next - 1e-3) { grab(mt); next = mt + step; }
      if (mt >= to - 0.05 || v.ended) return finish();
      v.requestVideoFrameCallback(onFrame);
    };
    // a stalled decoder (rare, mostly long-GOP files at 16×): finish with seeks from where it got to
    const watch = setInterval(() => {
      if (done) return;
      if (signal?.aborted) return finish(new Error('Cancelled'));
      if (performance.now() - lastFrame > 4000) { done = true; clearInterval(watch); v.pause(); seekThrough(v, next, to, step, grab, signal).then(resolve, reject); }
    }, 500);
    v.currentTime = from;
    v.onseeked = () => {
      v.onseeked = null;
      v.playbackRate = 16;
      v.requestVideoFrameCallback(onFrame);
      v.play().catch(() => { done = true; clearInterval(watch); seekThrough(v, next, to, step, grab, signal).then(resolve, reject); });
    };
  });
}

const seekTo = (v, t) => new Promise(res => { let tm = 0; const ok = () => { clearTimeout(tm); v.removeEventListener('seeked', ok); res(); }; v.addEventListener('seeked', ok); v.currentTime = t; tm = setTimeout(ok, 2000); });
async function seekThrough(v, from, to, step, grab, signal) {
  for (let t = from; t < to; t += step * 1.5) {
    if (signal?.aborted) throw new Error('Cancelled');
    await seekTo(v, t);
    grab(t);
  }
}

/**
 * One sample: how much changed since the last one (motion), where it changed (weighted centre and
 * 10–90% box of the changed cells), and where the detail is (centre of edge energy, for still shots).
 */
export function measure(g, prev, gw, gh) {
  let ex = 0, ey = 0, ew = 0;
  for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++) {
    const i = y * gw + x;
    const e = Math.abs(g[i + 1] - g[i - 1]) + Math.abs(g[i + gw] - g[i - gw]);
    // detail near the middle counts a little more: subjects are usually framed there
    const w = e * (1.15 - Math.hypot(x / gw - 0.5, y / gh - 0.5));
    ex += w * x; ey += w * y; ew += w;
  }
  const detail = ew > 0 ? { x: (ex / ew + 0.5) / gw, y: (ey / ew + 0.5) / gh } : { x: 0.5, y: 0.5 };
  if (!prev) return { diff: 0, motion: 0, cx: 0.5, cy: 0.5, box: 1, detail };
  const n = g.length, d = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) { d[i] = Math.abs(g[i] - prev[i]); sum += d[i]; }
  const mean = sum / n, th = Math.max(10, mean * 2.2);
  let wx = 0, wy = 0, w = 0, cells = 0;
  const xs = [], ys = [];
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const v = d[y * gw + x] - th;
    if (v <= 0) continue;
    wx += v * x; wy += v * y; w += v; cells++;
    xs.push([x, v]); ys.push([y, v]);
  }
  if (!w) return { diff: mean, motion: 0, cx: 0.5, cy: 0.5, box: 1, detail };
  const span = (list, size) => {
    list.sort((a, b) => a[0] - b[0]);
    let acc = 0, lo = list[0][0], hi = list[list.length - 1][0], gotLo = false;
    for (const [p, v] of list) { acc += v; if (!gotLo && acc >= w * 0.1) { lo = p; gotLo = true; } if (acc >= w * 0.9) { hi = p; break; } }
    return (hi - lo + 1) / size;
  };
  return { diff: mean, motion: cells / n, cx: (wx / w + 0.5) / gw, cy: (wy / w + 0.5) / gh, box: Math.max(span(xs, gw), span(ys, gh)), detail };
}

/** Shot boundaries: a big jump in mean change compared with what's usual around it. */
export function findCuts(samples) {
  const cuts = [];
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    const around = samples.slice(Math.max(1, i - 6), i + 7).filter((_, k, a) => a[k] !== s).map(x => x.diff).sort((a, b) => a - b);
    const med = around.length ? around[Math.floor(around.length / 2)] : 0;
    if (s.diff > 28 && s.diff > med * 3.5 + 6 && (!cuts.length || s.t - cuts[cuts.length - 1] > 0.6)) cuts.push(s.t);
  }
  return cuts;
}

/**
 * Turns samples into actions. base: the clip's own x/y/scale/crop and how much of the canvas the media
 * fills (fw, fh) at scale 1, so zooms stay inside the clip's frame even for picture-in-picture.
 */
export function plan(samples, duration, { style = 'follow', strength = 1, base, cuts: exactCuts } = {}) {
  const S = STYLES[style] || STYLES.follow;
  const b = base || { x: 0.5, y: 0.5, scale: 1, crop: [0, 0, 0, 0], fw: 1, fh: 1 };
  const zoomOf = z => 1 + (z - 1) * strength;
  const out = [];
  const home = { x: b.x, y: b.y, scale: b.scale };
  const at = (pt, z) => {
    // pt in full-frame 0..1 → cropped frame, then clamp so the zoomed frame never shows its own edges
    const cw = 1 - b.crop[0] - b.crop[2], ch = 1 - b.crop[1] - b.crop[3];
    let fx = (pt.x - b.crop[0]) / Math.max(0.05, cw), fy = (pt.y - b.crop[1]) / Math.max(0.05, ch);
    const half = 0.5 / z;
    fx = clamp(fx, half, 1 - half); fy = clamp(fy, half, 1 - half);
    return { x: b.x - (fx - 0.5) * b.fw * b.scale * z, y: b.y - (fy - 0.5) * b.fh * b.scale * z, scale: b.scale * z };
  };
  const push = (t, dur, props, ease = 'ease') => {
    t = clamp(t, 0, Math.max(0, duration - 0.05));
    if (out.length && t < out[out.length - 1].t + out[out.length - 1].dur - 1e-3) t = out[out.length - 1].t + out[out.length - 1].dur; // never overlap
    if (t >= duration - 0.05) return;
    dur = Math.min(dur, Math.max(0.02, duration - t));
    out.push({ t: +t.toFixed(3), dur: +dur.toFixed(3), ease, props: { x: +props.x.toFixed(4), y: +props.y.toFixed(4), scale: +props.scale.toFixed(4) } });
  };

  const sampleCuts = findCuts(samples);
  const cuts = exactCuts && exactCuts.length === sampleCuts.length ? exactCuts : sampleCuts;
  const shots = [];
  { let s0 = 0; for (const c of [...cuts, duration]) { if (c - s0 > 0.05) shots.push([s0, c]); s0 = c; } }

  // smoothed motion focus: average over ~0.6 s, ignoring the cut samples themselves
  const cutSet = new Set(sampleCuts.map(t => t.toFixed(3)));
  const sm = samples.map((s, i) => {
    let wx = 0, wy = 0, w = 0, bx = 0, mo = 0, k = 0;
    for (let j = Math.max(0, i - 1); j <= Math.min(samples.length - 1, i + 1); j++) {
      const q = samples[j];
      if (cutSet.has(q.t.toFixed(3))) continue;
      const wt = q.motion; wx += q.cx * wt; wy += q.cy * wt; w += wt; bx += q.box; mo += q.motion; k++;
    }
    return { t: s.t, x: w ? wx / w : 0.5, y: w ? wy / w : 0.5, box: k ? bx / k : 1, motion: k ? mo / k : 0, detail: s.detail };
  });

  let shotIndex = 0;
  for (const [s0, s1] of shots) {
    const inShot = sm.filter(s => s.t >= s0 + 0.15 && s.t < s1 - 0.1);
    let state = 'home', anchor = null, holdStart = null, zoomedAt = null, lastMove = -Infinity, events = 0;
    // start of every shot after the first: snap back home (or a jump zoom, punchy style) right on the cut
    if (s0 > 0) {
      if (S.punch && shotIndex % 2 === 1) {
        const d = inShot.length ? avgDetail(inShot) : { x: 0.5, y: 0.5 };
        push(s0, 0.02, at(d, zoomOf(S.punch)), 'linear'); state = 'punch';
      } else push(s0, 0.02, home, 'linear');
    }
    for (const s of inShot) {
      const focused = s.motion > 0.004 && s.box <= S.maxBox;
      const near = anchor && Math.hypot(s.x - anchor.x, s.y - anchor.y) < 0.14;
      if (state !== 'zoom') {
        if (focused && near) {
          if (s.t - holdStart >= S.minHold && s1 - s.t > S.transition + 0.8) {
            const z = zoomOf(clamp(S.zoom * (0.45 / Math.max(0.2, s.box)) ** 0.35, 1.15, S.zoom * 1.25));
            push(Math.max(s0, holdStart - S.transition * 0.4), S.transition, at(anchor, z));
            state = 'zoom'; zoomedAt = s.t; lastMove = s.t; events++;
            anchor = { x: s.x, y: s.y, z };
          }
        } else if (focused) { anchor = { x: s.x, y: s.y }; holdStart = s.t; } else { anchor = null; }
      } else {
        const spread = s.motion > 0.004 && s.box > S.maxBox * 1.35;
        const moved = focused && Math.hypot(s.x - anchor.x, s.y - anchor.y) > 0.16;
        if (spread && s.t - zoomedAt > 1.2) { // the action spread out: back to the whole frame
          push(s.t, S.transition, home); state = 'home'; anchor = null;
        } else if (moved && s.t - lastMove > Math.max(1.2, S.transition * 1.5)) { // follow it: pan
          anchor = { x: s.x, y: s.y, z: anchor.z };
          push(s.t, S.transition * 1.2, at(anchor, anchor.z)); lastMove = s.t;
        }
      }
    }
    // a still shot with nothing to follow: a slow push toward the detail (cinematic)
    if (S.drift && !events && s1 - s0 > 2.5 && state === 'home') {
      push(s0 + 0.05, Math.max(1, s1 - s0 - 0.15), at(avgDetail(inShot.length ? inShot : sm), zoomOf(S.drift)), 'linear');
      state = 'drift';
    }
    // zoomed at the end of the clip: ease back out before it ends
    if (s1 >= duration - 1e-3 && state === 'zoom') push(Math.max(0, duration - S.transition - 0.3), S.transition, home);
    shotIndex++;
  }
  return out;
}

function avgDetail(list) {
  let x = 0, y = 0;
  for (const s of list) { x += s.detail.x; y += s.detail.y; }
  return { x: x / list.length, y: y / list.length };
}

/** How much of the canvas a media clip covers at scale 1 (before its own scale), as fractions. */
export function frameFraction(canvas, m, crop = [0, 0, 0, 0]) {
  const mw = (m.width || canvas.width) * (1 - crop[0] - crop[2]), mh = (m.height || canvas.height) * (1 - crop[1] - crop[3]);
  const fit = Math.min(canvas.width / mw, canvas.height / mh);
  return { fw: (mw * fit) / canvas.width, fh: (mh * fit) / canvas.height };
}
