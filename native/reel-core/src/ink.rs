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
fn poly_dist(pts: &[(f64, f64)], x: f64, y: f64) -> f64 {
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
fn over(o: &mut [f64; 3], c: &[f64; 4], k: f64) {
    let a = (c[3] * k).clamp(0.0, 1.0);
    if a <= 0.0 { return; }
    for ch in 0..3 { o[ch] = c[ch] * a + o[ch] * (1.0 - a); }
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
    // runs f(local u, v, canvas x, y) → (colour, cover) over the canvas pixels a part of the clip's space covers
    let paint = |acc: &mut [[f64; 3]], area: [f64; 4], f: &(dyn Fn(f64, f64) -> Option<([f64; 4], f64)> + Sync)| {
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
                let kk = cov * keep(cx, cy, u, v) * alpha;
                over(&mut row[x], &c, kk);
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
                paint(acc, area, &f);
            }
            Shape::Disc { x, y, r, c } => {
                let (x, y, r, c) = (*x, *y, *r, *c);
                paint(acc, [x - r, y - r, x + r, y + r], &move |u, v| Some((c, (0.5 - ((u - x).hypot(v - y) - r) * k).clamp(0.0, 1.0))));
            }
            Shape::Ring { x, y, r, w: lw, c } => {
                let (x, y, r, lw, c) = (*x, *y, *r, *lw, *c);
                let o = r + lw / 2.0;
                paint(acc, [x - o, y - o, x + o, y + o], &move |u, v| Some((c, (0.5 - (((u - x).hypot(v - y) - r).abs() - lw / 2.0) * k).clamp(0.0, 1.0))));
            }
            Shape::Poly { pts, fill, stroke, shadow } => {
                if pts.len() < 3 { continue; }
                let (mut a0, mut a1, mut b0, mut b1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
                for &(u, v) in pts { a0 = a0.min(u); a1 = a1.max(u); b0 = b0.min(v); b1 = b1.max(v); }
                let sw = stroke.map(|s| s.0).unwrap_or(0.0) / 2.0;
                let area = [a0 - sw, b0 - sw, a1 + sw, b1 + sw];
                if let Some((blur, dy, sc)) = shadow { soft_shadow(acc, w, h, ink, &im, k, pts, area, *blur, *dy, sc, alpha, &keep); }
                let fill = *fill;
                paint(acc, area, &|u, v| Some((fill, (0.5 - poly_dist(pts, u, v) * k).clamp(0.0, 1.0))));
                if let Some((lw, sc)) = stroke {
                    let (lw, sc) = (*lw, *sc);
                    paint(acc, area, &|u, v| Some((sc, (0.5 - (poly_dist(pts, u, v).abs() - lw / 2.0) * k).clamp(0.0, 1.0))));
                }
            }
        }
    }
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
