//! Ink (1.11): the pointer effects compositor.js drawCursorFx paints over a screen recording, drawn here so an export
//! with them can still go through the core: a spotlight (the picture dimmed but for a soft circle round the
//! pointer), a highlight (a soft disc of colour under it), click rings, ripples and dots, and a pointer drawn from the
//! recorded track (an arrow, or a dot). The magnifier is an ordinary picture layer (a round box of the same video).
//!
//! An ink layer is a few shapes in the clip's own space (pixels from the middle of its box, before it's turned),
//! `m` taking them onto the canvas; `clip` keeps them inside a rectangle of that space, `cut` inside the clip's
//! rounded box. Colours are r, g, b 0..255 and a 0..1; edges are smooth (a pixel covered by how far its centre is
//! inside, as the browser's canvas anti-aliases).

use crate::frame::{par_rows, Look};

pub enum Shape {
    /// A radial gradient from c0 at r0 to c1 at r1 round (x, y), each colour kept beyond its end, as the canvas's
    /// createRadialGradient; filling the clip rectangle (or, when c1 is clear, just its circle).
    Grad { x: f64, y: f64, r0: f64, r1: f64, c0: [f64; 4], c1: [f64; 4] },
    Disc { x: f64, y: f64, r: f64, c: [f64; 4] },
    /// A circle's outline, w wide, centred on radius r.
    Ring { x: f64, y: f64, r: f64, w: f64, c: [f64; 4] },
    /// A closed outline, filled; with a soft shadow under it (blur as the canvas's shadowBlur and dy, canvas
    /// pixels: the canvas doesn't scale shadows) and an outline over it (w wide, round corners).
    Poly { pts: Vec<(f64, f64)>, fill: [f64; 4], stroke: Option<(f64, [f64; 4])>, shadow: Option<(f64, f64, [f64; 4])> },
    // 1.14: the transitions that paint over the picture (light leak, film burn, glitch bars, lens flare, a fast wipe's
    // streak, letterbox bars, the radial shutter's blades, film grain), as compositor.js draws them
    /// How the shapes after it are laid down: 0 over, 1 screen, 2 lighter (added), 3 overlay — the canvas's
    /// globalCompositeOperation.
    Mode(u8),
    /// A gradient with any number of stops (t 0..1, colour), as the canvas's createRadialGradient (two circles round
    /// one middle: a = [x, y, r0, r1]) or createLinearGradient (lin: a = [x0, y0, x1, y1]); each end colour kept
    /// beyond it. Fills the outline `area`.
    Stops { lin: bool, a: [f64; 4], stops: Vec<(f64, [f64; 4])>, area: Vec<(f64, f64)> },
    /// The shapes after it only outside this outline (the canvas's even-odd clip of the frame minus it); None: anywhere.
    Except(Option<Vec<(f64, f64)>>),
    /// Film grain (compositor.js filmGrain): its 256 × 256 noise tile, shifted (ox, oy), laid over in overlay mode at
    /// opacity a.
    Grain { ox: f64, oy: f64, a: f64 },
    /// A soft line just inside an outline (the shutter's rim): a stroke w wide along it, blurred (sigma), kept inside.
    Rim { pts: Vec<(f64, f64)>, w: f64, sigma: f64, c: [f64; 4] },
    /// Part of the frame so far (x, y, w, h, canvas pixels) drawn again dx to the side (glitch blocks: the canvas's
    /// drawImage of itself).
    Shift { x: f64, y: f64, w: f64, h: f64, dx: f64 },
    /// The vertigo ramp's hold: the frame so far, its middle 2·R·s across shrunk back into 2·R round (cx, cy),
    /// feathered from 0.55·R to R, laid over at opacity a.
    Vertigo { cx: f64, cy: f64, r: f64, s: f64, a: f64 },
}

pub struct Ink { pub m: [f64; 6], pub clip: Option<[f64; 4]>, pub cut: Option<Look>, pub shapes: Vec<Shape> }

fn invert(m: &[f64; 6]) -> Option<[f64; 6]> {
    let [a, b, c, d, e, f] = *m;
    let det = a * d - b * c;
    if det.abs() < 1e-12 { return None; }
    let (ia, ib, ic, id) = (d / det, -b / det, -c / det, a / det);
    Some([ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)])
}
fn rr_dist(x: f64, y: f64, w: f64, h: f64, r: f64) -> f64 {
    let r = r.max(0.0).min(w / 2.0).min(h / 2.0);
    let (qx, qy) = (x.abs() - (w / 2.0 - r), y.abs() - (h / 2.0 - r));
    (qx.max(0.0)).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - r
}
/// Signed distance from (x, y) to a closed outline: < 0 inside (even-odd, as the outlines here don't cross).
pub fn poly_dist(pts: &[(f64, f64)], x: f64, y: f64) -> f64 {
    let n = pts.len();
    let mut d = f64::MAX;
    let mut inside = false;
    for i in 0..n {
        let (a, b) = (pts[i], pts[(i + 1) % n]);
        let (ex, ey) = (b.0 - a.0, b.1 - a.1);
        let l2 = ex * ex + ey * ey;
        let t = if l2 > 0.0 { (((x - a.0) * ex + (y - a.1) * ey) / l2).clamp(0.0, 1.0) } else { 0.0 };
        d = d.min((x - a.0 - ex * t).hypot(y - a.1 - ey * t));
        if (a.1 > y) != (b.1 > y) && x < a.0 + (y - a.1) / (b.1 - a.1) * ex { inside = !inside; }
    }
    if inside { -d } else { d }
}

/// The canvas pixels (x0, x1, y0, y1) a part of the clip's space covers, with `pad` canvas pixels round it.
fn bounds(m: &[f64; 6], r: [f64; 4], pad: f64, w: usize, h: usize) -> (usize, usize, usize, usize) {
    let [a, b, c, d, e, f] = *m;
    let (mut x0, mut x1, mut y0, mut y1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for (u, v) in [(r[0], r[1]), (r[2], r[1]), (r[0], r[3]), (r[2], r[3])] {
        let (x, y) = (a * u + c * v + e, b * u + d * v + f);
        x0 = x0.min(x); x1 = x1.max(x); y0 = y0.min(y); y1 = y1.max(y);
    }
    let cl = |v: f64, n: usize| if v.is_finite() { v.max(0.0).min(n as f64) as usize } else { 0 };
    (cl((x0 - pad).floor(), w), cl((x1 + pad).ceil(), w), cl((y0 - pad).floor(), h), cl((y1 + pad).ceil(), h))
}

/// Lays colour c over a pixel, covering k of it.
#[inline]
fn over(o: &mut [f64; 3], c: &[f64; 4], k: f64) { blend(o, c, k, 0) }
/// Colour c onto a pixel, covering k of it, by the canvas's mode (Mode above; the frame under is opaque).
#[inline]
fn blend(o: &mut [f64; 3], c: &[f64; 4], k: f64, mode: u8) {
    let a = (c[3] * k).clamp(0.0, 1.0);
    if a <= 0.0 { return; }
    for ch in 0..3 {
        let (b, s) = (o[ch], c[ch]);
        o[ch] = match mode {
            1 => b + a * (s - s * b / 255.0),
            2 => (b + a * s).min(255.0),
            3 => { let (bb, ss) = (b / 255.0, s / 255.0); let m = if bb <= 0.5 { 2.0 * bb * ss } else { 1.0 - 2.0 * (1.0 - bb) * (1.0 - ss) }; b + a * (m * 255.0 - b) }
            _ => s * a + b * (1.0 - a),
        };
    }
}
/// The colour of a gradient at t (its stops sorted), mixed with opacity (premultiplied), as Grad.
fn stop_at(stops: &[(f64, [f64; 4])], t: f64) -> [f64; 4] {
    let n = stops.len();
    if t <= stops[0].0 { return stops[0].1; }
    if t >= stops[n - 1].0 { return stops[n - 1].1; }
    let mut i = 0;
    while i + 1 < n && stops[i + 1].0 < t { i += 1; }
    let ((t0, c0), (t1, c1)) = (stops[i], stops[i + 1]);
    let u = if t1 > t0 { (t - t0) / (t1 - t0) } else { 1.0 };
    let a = c0[3] * (1.0 - u) + c1[3] * u;
    if a <= 0.0 { return [0.0, 0.0, 0.0, 0.0]; }
    let mut c = [0.0, 0.0, 0.0, a];
    for ch in 0..3 { c[ch] = c0[ch] * (1.0 - u) + c1[ch] * u; }
    c
}
/// compositor.js filmGrain's tile: 256 × 256 greys from its seeded generator, as the canvas's ImageData keeps them.
fn grain_tile() -> &'static [u8] {
    static TILE: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    TILE.get_or_init(|| {
        let mut seed: u64 = 7;
        (0..256 * 256).map(|_| { seed = (seed * 16807) % 2147483647; let v = 128.0 + (seed as f64 / 2147483647.0 - 0.5) * 255.0; v.clamp(0.0, 255.0).round_ties_even() as u8 }).collect()
    })
}
/// erf, to within 1.5e-7 (Abramowitz and Stegun 7.1.26): a blurred edge's cover.
fn erf(x: f64) -> f64 {
    let t = 1.0 / (1.0 + 0.3275911 * x.abs());
    let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * (-x * x).exp();
    if x < 0.0 { -y } else { y }
}

/// Draws an ink layer onto acc (w × h, opaque RGB 0..255) at opacity alpha.
pub fn draw(acc: &mut [[f64; 3]], w: usize, h: usize, ink: &Ink, alpha: f64) {
    let Some(im) = invert(&ink.m) else { return };
    // canvas pixels per unit of the clip's space (the same both ways: it's only moved and turned, or scaled evenly)
    let k = (ink.m[0] * ink.m[3] - ink.m[1] * ink.m[2]).abs().sqrt().max(1e-9);
    let cut = ink.cut.as_ref().and_then(|lk| invert(&lk.b).map(|ib| (lk, ib)));
    let local = |cx: f64, cy: f64| (im[0] * cx + im[2] * cy + im[4], im[1] * cx + im[3] * cy + im[5]);
    // how much of a canvas pixel the clip rectangle and the rounded box let through
    let keep = |cx: f64, cy: f64, u: f64, v: f64| -> f64 {
        let mut c = 1.0;
        if let Some(r) = ink.clip { c *= ((u - r[0]) * k + 0.5).clamp(0.0, 1.0) * ((r[2] - u) * k + 0.5).clamp(0.0, 1.0) * ((v - r[1]) * k + 0.5).clamp(0.0, 1.0) * ((r[3] - v) * k + 0.5).clamp(0.0, 1.0); }
        if let Some((lk, ib)) = &cut {
            let (bu, bv) = (ib[0] * cx + ib[2] * cy + ib[4], ib[1] * cx + ib[3] * cy + ib[5]);
            c *= (0.5 - rr_dist(bu * lk.w, bv * lk.h, lk.w, lk.h, lk.radius)).clamp(0.0, 1.0);
        }
        c
    };
    // what the shapes are laid down with (Mode), and where they can't go (Except)
    let mut mode = 0u8;
    let mut except: Option<&Vec<(f64, f64)>> = None;
    // runs f(local u, v, canvas x, y) → (colour, cover) over the canvas pixels a part of the clip's space covers
    let paint = |acc: &mut [[f64; 3]], area: [f64; 4], mode: u8, except: Option<&Vec<(f64, f64)>>, f: &(dyn Fn(f64, f64) -> Option<([f64; 4], f64)> + Sync)| {
        let area = match ink.clip { Some(r) => [area[0].max(r[0]), area[1].max(r[1]), area[2].min(r[2]), area[3].min(r[3])], None => area };
        if area[2] <= area[0] || area[3] <= area[1] { return; }
        let (x0, x1, y0, y1) = bounds(&ink.m, area, 1.0, w, h);
        if x1 <= x0 || y1 <= y0 { return; }
        par_rows(&mut acc[y0 * w..y1 * w], w, |j, row| {
            let cy = (y0 + j) as f64 + 0.5;
            for x in x0..x1 {
                let cx = x as f64 + 0.5;
                let (u, v) = local(cx, cy);
                let Some((c, cov)) = f(u, v) else { continue };
                if cov <= 0.0 { continue; }
                let mut kk = cov * keep(cx, cy, u, v) * alpha;
                if let Some(ex) = except { kk *= (0.5 + poly_dist(ex, u, v) * k).clamp(0.0, 1.0); }
                blend(&mut row[x], &c, kk, mode);
            }
        });
    };
    for s in &ink.shapes {
        match s {
            Shape::Grad { x, y, r0, r1, c0, c1 } => {
                let (x, y, r0, r1) = (*x, *y, *r0, *r1);
                let reach = if c1[3] <= 0.0 { r1 } else { 1e7 };
                let area = [x - reach, y - reach, x + reach, y + reach];
                // in between: the two colours mixed with their opacity (premultiplied), as the canvas does
                let f = move |u: f64, v: f64| {
                    let d = (u - x).hypot(v - y);
                    let t = if r1 > r0 { ((d - r0) / (r1 - r0)).clamp(0.0, 1.0) } else if d < r0 { 0.0 } else { 1.0 };
                    let a = c0[3] * (1.0 - t) + c1[3] * t;
                    if a <= 0.0 { return None; }
                    let mut c = [0.0, 0.0, 0.0, a];
                    for ch in 0..3 { c[ch] = (c0[ch] * c0[3] * (1.0 - t) + c1[ch] * c1[3] * t) / a; }
                    Some((c, 1.0))
                };
                paint(acc, area, mode, except, &f);
            }
            Shape::Disc { x, y, r, c } => {
                let (x, y, r, c) = (*x, *y, *r, *c);
                paint(acc, [x - r, y - r, x + r, y + r], mode, except, &move |u, v| Some((c, (0.5 - ((u - x).hypot(v - y) - r) * k).clamp(0.0, 1.0))));
            }
            Shape::Ring { x, y, r, w: lw, c } => {
                let (x, y, r, lw, c) = (*x, *y, *r, *lw, *c);
                let o = r + lw / 2.0;
                paint(acc, [x - o, y - o, x + o, y + o], mode, except, &move |u, v| Some((c, (0.5 - (((u - x).hypot(v - y) - r).abs() - lw / 2.0) * k).clamp(0.0, 1.0))));
            }
            Shape::Poly { pts, fill, stroke, shadow } => {
                if pts.len() < 3 { continue; }
                let (mut a0, mut a1, mut b0, mut b1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
                for &(u, v) in pts { a0 = a0.min(u); a1 = a1.max(u); b0 = b0.min(v); b1 = b1.max(v); }
                let sw = stroke.map(|s| s.0).unwrap_or(0.0) / 2.0;
                let area = [a0 - sw, b0 - sw, a1 + sw, b1 + sw];
                if let Some((blur, dy, sc)) = shadow { soft_shadow(acc, w, h, ink, &im, k, pts, area, *blur, *dy, sc, alpha, &keep); }
                let fill = *fill;
                paint(acc, area, mode, except, &|u, v| Some((fill, (0.5 - poly_dist(pts, u, v) * k).clamp(0.0, 1.0))));
                if let Some((lw, sc)) = stroke {
                    let (lw, sc) = (*lw, *sc);
                    paint(acc, area, mode, except, &|u, v| Some((sc, (0.5 - (poly_dist(pts, u, v).abs() - lw / 2.0) * k).clamp(0.0, 1.0))));
                }
            }
            Shape::Mode(m) => mode = *m,
            Shape::Except(e) => except = e.as_ref(),
            Shape::Stops { lin, a, stops, area } => {
                if stops.is_empty() || area.len() < 3 { continue; }
                let (mut a0, mut a1, mut b0, mut b1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
                for &(u, v) in area { a0 = a0.min(u); a1 = a1.max(u); b0 = b0.min(v); b1 = b1.max(v); }
                let (lin, g) = (*lin, *a);
                let (dx, dy) = (g[2] - g[0], g[3] - g[1]);
                let l2 = dx * dx + dy * dy;
                paint(acc, [a0, b0, a1, b1], mode, except, &|u, v| {
                    let t = if lin { if l2 > 0.0 { ((u - g[0]) * dx + (v - g[1]) * dy) / l2 } else { 0.0 } }
                        else { let d = (u - g[0]).hypot(v - g[1]); if g[3] > g[2] { (d - g[2]) / (g[3] - g[2]) } else if d < g[2] { 0.0 } else { 1.0 } };
                    let c = stop_at(stops, t.clamp(0.0, 1.0));
                    if c[3] <= 0.0 { return None; }
                    Some((c, (0.5 - poly_dist(area, u, v) * k).clamp(0.0, 1.0)))
                });
            }
            Shape::Grain { ox, oy, a } => {
                let tile = grain_tile();
                let (ox, oy, ga) = (*ox as i64, *oy as i64, *a);
                let ex = except;
                par_rows(acc, w, |y, row| {
                    let ty = (((y as i64 + oy) % 256 + 256) % 256) as usize;
                    for (x, px) in row.iter_mut().enumerate() {
                        let tx = (((x as i64 + ox) % 256 + 256) % 256) as usize;
                        let g = tile[ty * 256 + tx] as f64;
                        let mut kk = alpha;
                        if let Some(e) = ex { let (u, v) = local(x as f64 + 0.5, y as f64 + 0.5); kk *= (0.5 + poly_dist(e, u, v) * k).clamp(0.0, 1.0); }
                        blend(px, &[g, g, g, ga], kk, 3);
                    }
                });
            }
            Shape::Shift { x, y, w: bw, h: bh, dx } => {
                let (x, y, bw, bh, dx) = (*x, *y, *bw, *bh, *dx);
                if bw <= 0.0 || bh <= 0.0 { continue; }
                let snap: Vec<[f64; 3]> = acc.to_vec();
                // the source rectangle, read with smoothing (its edges clamped, as drawImage keeps to its source)
                let sample = |u: f64, v: f64| -> [f64; 3] {
                    let u = u.clamp(x + 0.5, x + bw - 0.5).clamp(0.5, w as f64 - 0.5) - 0.5;
                    let v = v.clamp(y + 0.5, y + bh - 0.5).clamp(0.5, h as f64 - 0.5) - 0.5;
                    let (u0, v0) = (u.floor(), v.floor());
                    let (fu, fv) = (u - u0, v - v0);
                    let (i0, j0) = (u0 as usize, v0 as usize);
                    let (i1, j1) = ((i0 + 1).min(w - 1), (j0 + 1).min(h - 1));
                    let mut o = [0.0; 3];
                    for c in 0..3 { o[c] = (snap[j0 * w + i0][c] * (1.0 - fu) + snap[j0 * w + i1][c] * fu) * (1.0 - fv) + (snap[j1 * w + i0][c] * (1.0 - fu) + snap[j1 * w + i1][c] * fu) * fv; }
                    o
                };
                let (x0, x1) = (((x + dx).floor().max(0.0)) as usize, ((x + dx + bw).ceil().min(w as f64)) as usize);
                let (y0, y1) = ((y.floor().max(0.0)) as usize, ((y + bh).ceil().min(h as f64)) as usize);
                if x1 <= x0 || y1 <= y0 { continue; }
                par_rows(&mut acc[y0 * w..y1 * w], w, |j, row| {
                    let py = (y0 + j) as f64;
                    let cy = ((py + 1.0).min(y + bh) - py.max(y)).clamp(0.0, 1.0);
                    for px in x0..x1 {
                        let pxf = px as f64;
                        let cx = ((pxf + 1.0).min(x + dx + bw) - pxf.max(x + dx)).clamp(0.0, 1.0);
                        let cov = cx * cy * alpha;
                        if cov <= 0.0 { continue; }
                        let c = sample(pxf + 0.5 - dx, py + 0.5);
                        blend(&mut row[px], &[c[0], c[1], c[2], 1.0], cov, 0);
                    }
                });
            }
            Shape::Vertigo { cx, cy, r, s: sc, a } => {
                let (cx, cy, r, sc, a) = (*cx, *cy, *r, *sc, *a);
                if sc <= 1.001 || r <= 0.0 { continue; }
                let snap: Vec<[f64; 3]> = acc.to_vec();
                // each pixel of the hold: the average of the frame under its sc × sc footprint (a smooth shrink)
                let n = (sc.ceil() as usize).clamp(1, 8);
                let at = |u: f64, v: f64| -> [f64; 3] {
                    let (i, j) = ((u.max(0.0) as usize).min(w - 1), (v.max(0.0) as usize).min(h - 1));
                    snap[j * w + i]
                };
                let (x0, x1) = (((cx - r).floor().max(0.0)) as usize, ((cx + r).ceil().min(w as f64)) as usize);
                let (y0, y1) = (((cy - r).floor().max(0.0)) as usize, ((cy + r).ceil().min(h as f64)) as usize);
                if x1 <= x0 || y1 <= y0 { continue; }
                par_rows(&mut acc[y0 * w..y1 * w], w, |j, row| {
                    let py = (y0 + j) as f64 + 0.5;
                    for px in x0..x1 {
                        let pxf = px as f64 + 0.5;
                        let d = (pxf - cx).hypot(py - cy);
                        let feather = if d <= r * 0.55 { 1.0 } else if d >= r { 0.0 } else { 1.0 - (d - r * 0.55) / (r * 0.45) };
                        // the copy only reaches the square of the hold
                        let inside = ((pxf - (cx - r)).min(cx + r - pxf).min(py - (cy - r)).min(cy + r - py) + 0.5).clamp(0.0, 1.0);
                        let k = feather * inside * a * alpha;
                        if k <= 0.0 { continue; }
                        let (u, v) = (cx + (pxf - cx) * sc, cy + (py - cy) * sc);
                        let mut c = [0.0; 3];
                        for jj in 0..n { for ii in 0..n {
                            let q = at(u + ((ii as f64 + 0.5) / n as f64 - 0.5) * sc, v + ((jj as f64 + 0.5) / n as f64 - 0.5) * sc);
                            for ch in 0..3 { c[ch] += q[ch]; }
                        } }
                        let nn = (n * n) as f64;
                        blend(&mut row[px], &[c[0] / nn, c[1] / nn, c[2] / nn, 1.0], k, 0);
                    }
                });
            }
            Shape::Rim { pts, w: lw, sigma, c } => {
                if pts.len() < 3 { continue; }
                let (mut a0, mut a1, mut b0, mut b1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
                for &(u, v) in pts { a0 = a0.min(u); a1 = a1.max(u); b0 = b0.min(v); b1 = b1.max(v); }
                // a small opening (the shutter nearly shut): the blur reaches across it, so it's blurred for real
                if (a1 - a0).max(b1 - b0) * k < 12.0 * sigma * k + lw * k && ink.m == [1.0, 0.0, 0.0, 1.0, 0.0, 0.0] {
                    rim_small(acc, w, h, pts, *lw, *sigma, c, alpha, mode, except.map(|v| v.as_slice()));
                    continue;
                }
                let (hw, sg, c) = (lw / 2.0, sigma.max(0.01) * std::f64::consts::SQRT_2, *c);
                // a band hw either side of the edge, blurred: the gaussian's share of it at distance d
                paint(acc, [a0, b0, a1, b1], mode, except, &|u, v| {
                    let d = poly_dist(pts, u, v) * k;
                    if d > 0.5 { return None; }
                    let cov = 0.5 * (erf((hw - d) / sg) - erf((-hw - d) / sg));
                    Some((c, cov * (0.5 - d).clamp(0.0, 1.0)))
                });
            }
        }
    }
}

/// Rim (above) for a small outline, in canvas pixels: the stroke's cover blurred by a true Gaussian, kept inside.
#[allow(clippy::too_many_arguments)]
fn rim_small(acc: &mut [[f64; 3]], w: usize, h: usize, pts: &[(f64, f64)], lw: f64, sigma: f64, c: &[f64; 4], alpha: f64, mode: u8, except: Option<&[(f64, f64)]>) {
    let sigma = sigma.max(0.01);
    let pad = (sigma * 3.0).ceil() + lw;
    let (mut a0, mut a1, mut b0, mut b1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for &(u, v) in pts { a0 = a0.min(u); a1 = a1.max(u); b0 = b0.min(v); b1 = b1.max(v); }
    let cl = |v: f64, n: usize| v.max(0.0).min(n as f64) as usize;
    let (x0, x1, y0, y1) = (cl((a0 - pad).floor(), w), cl((a1 + pad).ceil(), w), cl((b0 - pad).floor(), h), cl((b1 + pad).ceil(), h));
    if x1 <= x0 || y1 <= y0 { return; }
    let (bw, bh) = (x1 - x0, y1 - y0);
    let mut m = vec![0f64; bw * bh];
    for y in 0..bh { for x in 0..bw {
        let d = poly_dist(pts, (x0 + x) as f64 + 0.5, (y0 + y) as f64 + 0.5);
        m[y * bw + x] = (0.5 - (d.abs() - lw / 2.0)).clamp(0.0, 1.0);
    } }
    let r = (sigma * 3.0).ceil() as i64;
    let kern: Vec<f64> = (-r..=r).map(|i| (-(i * i) as f64 / (2.0 * sigma * sigma)).exp()).collect();
    let ks: f64 = kern.iter().sum();
    let mut t = vec![0f64; bw * bh];
    for y in 0..bh { for x in 0..bw {
        let mut s = 0.0;
        for (j, kv) in kern.iter().enumerate() { let xx = x as i64 + j as i64 - r; if xx >= 0 && (xx as usize) < bw { s += m[y * bw + xx as usize] * kv; } }
        t[y * bw + x] = s / ks;
    } }
    for y in 0..bh { for x in 0..bw {
        let mut s = 0.0;
        for (j, kv) in kern.iter().enumerate() { let yy = y as i64 + j as i64 - r; if yy >= 0 && (yy as usize) < bh { s += t[yy as usize * bw + x] * kv; } }
        let (cx, cy) = ((x0 + x) as f64 + 0.5, (y0 + y) as f64 + 0.5);
        let mut k = s / ks * (0.5 - poly_dist(pts, cx, cy)).clamp(0.0, 1.0) * alpha;
        if let Some(e) = except { k *= (0.5 + poly_dist(e, cx, cy)).clamp(0.0, 1.0); }
        blend(&mut acc[(y0 + y) * w + x0 + x], c, k, mode);
    } }
}

/// A shape's shadow: its cover, softened (a Gaussian, sigma = blur / 2, as the canvas's shadowBlur), moved down dy
/// canvas pixels, in colour c.
#[allow(clippy::too_many_arguments)]
fn soft_shadow(acc: &mut [[f64; 3]], w: usize, h: usize, ink: &Ink, im: &[f64; 6], k: f64, pts: &[(f64, f64)], area: [f64; 4], blur: f64, dy: f64, c: &[f64; 4], alpha: f64, keep: &dyn Fn(f64, f64, f64, f64) -> f64) {
    let sigma = (blur / 2.0).max(0.01);
    let pad = (sigma * 3.0).ceil() + 2.0 + dy.abs().ceil();
    let (x0, x1, y0, y1) = bounds(&ink.m, area, pad, w, h);
    if x1 <= x0 || y1 <= y0 { return; }
    let (bw, bh) = (x1 - x0, y1 - y0);
    let mut m = vec![0f64; bw * bh];
    for y in 0..bh { for x in 0..bw {
        let (cx, cy) = ((x0 + x) as f64 + 0.5, (y0 + y) as f64 + 0.5 - dy);
        let (u, v) = (im[0] * cx + im[2] * cy + im[4], im[1] * cx + im[3] * cy + im[5]);
        m[y * bw + x] = (0.5 - poly_dist(pts, u, v) * k).clamp(0.0, 1.0);
    } }
    let r = (sigma * 3.0).ceil() as i64;
    let kern: Vec<f64> = (-r..=r).map(|i| (-(i * i) as f64 / (2.0 * sigma * sigma)).exp()).collect();
    let ks: f64 = kern.iter().sum();
    let mut t = vec![0f64; bw * bh];
    for y in 0..bh { for x in 0..bw {
        let mut s = 0.0;
        for (j, kv) in kern.iter().enumerate() { let xx = x as i64 + j as i64 - r; if xx >= 0 && (xx as usize) < bw { s += m[y * bw + xx as usize] * kv; } }
        t[y * bw + x] = s / ks;
    } }
    for y in 0..bh { for x in 0..bw {
        let mut s = 0.0;
        for (j, kv) in kern.iter().enumerate() { let yy = y as i64 + j as i64 - r; if yy >= 0 && (yy as usize) < bh { s += t[yy as usize * bw + x] * kv; } }
        let (cx, cy) = ((x0 + x) as f64 + 0.5, (y0 + y) as f64 + 0.5);
        let (u, v) = (im[0] * cx + im[2] * cy + im[4], im[1] * cx + im[3] * cy + im[5]);
        over(&mut acc[(y0 + y) * w + x0 + x], c, s / ks * keep(cx, cy, u, v) * alpha);
    } }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: [f64; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
    fn canvas(w: usize, h: usize) -> Vec<[f64; 3]> { vec![[100.0; 3]; w * h] }
    #[test]
    fn disc_and_ring() {
        let mut a = canvas(40, 40);
        let ink = Ink { m: ID, clip: None, cut: None, shapes: vec![Shape::Disc { x: 20.0, y: 20.0, r: 5.0, c: [255.0, 0.0, 0.0, 1.0] }, Shape::Ring { x: 20.0, y: 20.0, r: 12.0, w: 2.0, c: [0.0, 0.0, 255.0, 0.5] }] };
        draw(&mut a, 40, 40, &ink, 1.0);
        assert_eq!(a[20 * 40 + 20], [255.0, 0.0, 0.0], "inside the disc");
        let ring = a[20 * 40 + 32]; // 12 px right of the middle: on the ring, half see-through blue
        assert!((ring[2] - 177.5).abs() < 1.0 && (ring[0] - 50.0).abs() < 1.0, "{ring:?}");
        assert_eq!(a[0], [100.0; 3], "untouched outside");
    }
    #[test]
    fn spotlight_dims_outside_inside_the_clip() {
        let mut a = canvas(60, 20);
        let ink = Ink { m: [1.0, 0.0, 0.0, 1.0, 30.0, 10.0], clip: Some([-20.0, -10.0, 20.0, 10.0]), cut: None,
            shapes: vec![Shape::Grad { x: 0.0, y: 0.0, r0: 3.0, r1: 6.0, c0: [0.0, 0.0, 0.0, 0.0], c1: [0.0, 0.0, 0.0, 0.5] }] };
        draw(&mut a, 60, 20, &ink, 1.0);
        assert_eq!(a[10 * 60 + 30], [100.0; 3], "the pointer's circle stays clear");
        assert!((a[10 * 60 + 45][0] - 50.0).abs() < 1e-6, "dimmed by half further out");
        assert_eq!(a[10 * 60 + 5], [100.0; 3], "outside the picture: untouched");
    }
    #[test]
    fn grain_tile_is_the_editors() {
        // the first greys compositor.js filmGrain's tile gets (its generator, kept as ImageData keeps them)
        assert_eq!(&grain_tile()[..8], &[1, 235, 74, 54, 186, 136, 84, 192]);
    }
    #[test]
    fn blend_modes() {
        let mut o = [100.0, 200.0, 0.0];
        blend(&mut o, &[255.0, 0.0, 255.0, 1.0], 1.0, 1);
        assert_eq!(o, [255.0, 200.0, 255.0], "screen: white stays white, black changes nothing");
        let mut o = [200.0, 10.0, 0.0];
        blend(&mut o, &[100.0, 100.0, 100.0, 0.5], 1.0, 2);
        assert_eq!(o, [250.0, 60.0, 50.0], "lighter adds (and stops at white)");
        let mut o = [255.0, 0.0, 0.0];
        blend(&mut o, &[255.0, 255.0, 255.0, 1.0], 1.0, 2);
        assert_eq!(o, [255.0, 255.0, 255.0]);
        let mut o = [64.0, 191.25, 127.5];
        blend(&mut o, &[127.5, 127.5, 127.5, 1.0], 1.0, 3);
        assert!((o[0] - 64.0).abs() < 1e-9 && (o[1] - 191.25).abs() < 1e-9 && (o[2] - 127.5).abs() < 1e-9, "overlay with mid grey changes nothing");
    }
    #[test]
    fn stops_and_outside_only() {
        // a white-to-clear linear gradient, kept outside a square in the middle, screened over grey
        let mut a = canvas(40, 10);
        let full = vec![(0.0, 0.0), (40.0, 0.0), (40.0, 10.0), (0.0, 10.0)];
        let hole = vec![(15.0, 0.0), (25.0, 0.0), (25.0, 10.0), (15.0, 10.0)];
        let ink = Ink { m: ID, clip: None, cut: None, shapes: vec![Shape::Mode(1), Shape::Except(Some(hole)),
            Shape::Stops { lin: true, a: [0.0, 0.0, 40.0, 0.0], stops: vec![(0.0, [255.0, 255.0, 255.0, 1.0]), (1.0, [255.0, 255.0, 255.0, 0.0])], area: full }] };
        draw(&mut a, 40, 10, &ink, 1.0);
        assert!(a[5 * 40][0] > 250.0, "white at the start");
        assert_eq!(a[5 * 40 + 20], [100.0; 3], "nothing inside the hole");
        assert!(a[5 * 40 + 35][0] > 100.0 && a[5 * 40 + 35][0] < 140.0, "fading out towards the end");
    }
    #[test]
    fn arrow_with_shadow_and_outline() {
        let mut a = canvas(40, 40);
        let pts = vec![(10.0, 5.0), (10.0, 30.0), (25.0, 20.0)];
        let ink = Ink { m: ID, clip: None, cut: None, shapes: vec![Shape::Poly { pts, fill: [255.0, 255.0, 255.0, 1.0], stroke: Some((1.0, [0.0, 0.0, 0.0, 1.0])), shadow: Some((4.0, 2.0, [0.0, 0.0, 0.0, 0.5])) }] };
        draw(&mut a, 40, 40, &ink, 1.0);
        assert_eq!(a[18 * 40 + 14], [255.0; 3], "filled white");
        assert!(a[18 * 40 + 10][0] < 140.0, "its edge outlined in black (half the pixel)");
        assert!(a[33 * 40 + 11][0] < 100.0, "a shadow under it");
    }
}
