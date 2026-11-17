// Recorded cursor track: where the pointer was (0..1 of the recorded frame) at a media time.
// The recorder samples the pointer ~30 times a second in screen points; this maps it onto the
// recorded display and smooths it.

function sampleAt(pts, ms) {
  let lo = 0, hi = pts.length - 1;
  if (ms <= pts[0][0]) return [pts[0][1], pts[0][2]];
  if (ms >= pts[hi][0]) return [pts[hi][1], pts[hi][2]];
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid][0] <= ms) lo = mid; else hi = mid; }
  const a = pts[lo], b = pts[hi], k = (ms - a[0]) / Math.max(1, b[0] - a[0]);
  return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** data: cursor JSON; offset: seconds between cursor start and media time 0; smooth: seconds. */
/** Where the recorded window was at ms (a recording of one window): { x, y, width, height } in points, or null. */
function windowAt(w, ms) {
  const f = w && Array.isArray(w.frames) ? w.frames : null;
  if (!f || !f.length) return null;
  let i = 0;
  while (i + 1 < f.length && f[i + 1][0] <= ms) i++;
  const [, x, y, width, height] = f[i];
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

export function cursorAt(data, offset, t, smooth = 0) {
  if (!data || !data.points || !data.points.length) return null;
  const ms = (t + (offset || 0)) * 1000;
  // a screen recording: its display; one window: where that window was then
  const b = data.display ? data.display.bounds : windowAt(data.window, ms);
  if (!b) return null;
  let x = 0, y = 0;
  const n = smooth > 0 ? 7 : 1;
  for (let i = 0; i < n; i++) {
    const dt = n === 1 ? 0 : ((i / (n - 1)) - 0.5) * smooth * 1000;
    const [px, py] = sampleAt(data.points, ms + dt);
    x += px; y += py;
  }
  x /= n; y /= n;
  // the most recent click within 0.6 s: { age (s), button, down }
  let click = null;
  const cl = data.clicks;
  if (cl && cl.length) {
    let lo = 0, hi = cl.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (cl[mid][0] <= ms) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    for (let i = best; i >= 0 && ms - cl[i][0] < 600; i--) if (cl[i][1] !== 'u') { click = { age: (ms - cl[i][0]) / 1000, button: cl[i][1] }; break; }
  }
  return { x: (x - b.x) / b.width, y: (y - b.y) / b.height, pt: b.width, click: click ? click.age : null, button: click ? click.button : null };
}

/** Media times (s) of clicks between media times t0 and t1 (for click sounds). */
export function clicksBetween(data, offset, t0, t1) {
  const out = [];
  if (!data || !data.clicks) return out;
  const a = (t0 + (offset || 0)) * 1000, b = (t1 + (offset || 0)) * 1000;
  for (const c of data.clicks) { if (c[1] === 'u') continue; if (c[0] >= a && c[0] < b) out.push(c[0] / 1000 - (offset || 0)); if (c[0] >= b) break; }
  return out;
}

/**
 * What the keystroke display shows at media time t: typing within a second joins into one line
 * ("Hello"); shortcuts (⌘C) stand alone. Returns { text, age } or null. modsOnly: only shortcuts.
 */
export function keysAt(data, offset, t, { hold = 1.5, modsOnly = false } = {}) {
  const ks = data && data.keys;
  if (!ks || !ks.length) return null;
  const ms = (t + (offset || 0)) * 1000;
  let i = -1;
  for (let lo = 0, hi = ks.length - 1; lo <= hi;) { const mid = (lo + hi) >> 1; if (ks[mid][0] <= ms) { i = mid; lo = mid + 1; } else hi = mid - 1; }
  const isSpace = k => /^space$/i.test(k[2]);
  const combo = k => /[⌃⌥⌘]/.test(k[1]);
  // shortcuts and named keys (F5, ↩, ⎋…) stand alone; letters and spaces join into a typed line
  const shortcut = k => combo(k) || (k[2].length > 1 && !isSpace(k)) || /^[↩⌤⇥⌫⌦⎋←→↑↓↖↘⇞⇟]$/.test(k[2]);
  while (i >= 0 && modsOnly && !combo(ks[i])) i--;
  if (i < 0 || ms - ks[i][0] > hold * 1000) return null;
  const last = ks[i];
  if (shortcut(last)) return { text: last[1] + last[2], age: (ms - last[0]) / 1000 };
  // join plain typing that happened in quick succession
  let text = '', j = i;
  while (j >= 0 && !shortcut(ks[j]) && (j === i || ks[j + 1][0] - ks[j][0] < 1000) && text.length < 40) {
    text = (isSpace(ks[j]) ? ' ' : ks[j][1].includes('⇧') ? ks[j][2] : ks[j][2].toLowerCase()) + text; j--;
  }
  return { text, age: (ms - last[0]) / 1000 };
}

/**
 * Suggests zoom-and-pan actions for a screen clip: wherever the pointer settles in one area for a
 * while, zoom in there; zoom back out when it moves away. Returns actions in clip-local time.
 */
export function autoZoom(data, offset, clip, { zoom = 1.8, minHold = 1.2, transition = 0.6, fw = 1, fh = 1 } = {}) {
  if (!data || !data.points || data.points.length < 10) return [];
  const step = 0.25, out = [];
  const dur = clip.duration, speed = clip.speed || 1;
  let holdStart = null, anchor = null, zoomed = false, lastEnd = -Infinity;
  for (let lt = 0; lt <= dur; lt += step) {
    let p = cursorAt(data, offset, (clip.in || 0) + lt * speed, 0.3);
    if (!p) continue;
    // off the recorded picture (another screen, or outside the recorded window): nothing to zoom to here
    if (p.x < -0.02 || p.x > 1.02 || p.y < -0.02 || p.y > 1.02) p = { x: -9, y: -9 };
    const near = anchor && Math.hypot(p.x - anchor.x, p.y - anchor.y) < 0.12;
    if (near) {
      if (!zoomed && lt - holdStart >= minHold && holdStart - lastEnd > transition) {
        const t = Math.max(0, holdStart - transition * 0.5);
        out.push({ t, dur: transition, ease: 'ease', props: zoomProps(anchor, zoom, fw, fh) });
        zoomed = true;
      }
    } else {
      if (zoomed) {
        out.push({ t: lt, dur: transition, ease: 'ease', props: { x: 0.5, y: 0.5, scale: 1 } });
        lastEnd = lt + transition;
        zoomed = false;
      }
      anchor = p.x < -1 ? null : p; holdStart = lt;
    }
  }
  if (zoomed) out.push({ t: Math.max(0, dur - transition - 0.1), dur: transition, ease: 'ease', props: { x: 0.5, y: 0.5, scale: 1 } });
  return out;
}

/**
 * Position/scale that zooms into point (x, y) of the picture (0..1 of it) without showing past its edges. fw, fh: how
 * much of the canvas the picture fills unzoomed (a window recording that isn't 16:9 has bars beside it: fw < 1).
 */
export function zoomProps(pt, zoom, fw = 1, fh = 1) {
  // how much of the picture the canvas shows across, zoomed: its middle can go no nearer an edge than half that
  const hx = Math.min(0.5, 0.5 / (zoom * fw)), hy = Math.min(0.5, 0.5 / (zoom * fh));
  const fx = Math.min(1 - hx, Math.max(hx, pt.x)), fy = Math.min(1 - hy, Math.max(hy, pt.y));
  return { scale: zoom, x: 0.5 - (fx - 0.5) * fw * zoom, y: 0.5 - (fy - 0.5) * fh * zoom };
}
