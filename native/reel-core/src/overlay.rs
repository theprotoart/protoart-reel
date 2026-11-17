//! What the editor draws over an export (1.12): titles, call-outs, graphics, shapes, drawings and burned captions
//! stay the editor's own drawing (so they look just as they do in the preview), and come to the core as pictures to
//! lay over each frame it draws. They arrive on a descriptor of their own, as the export runs, one entry for each
//! frame that has any:
//!
//!   how many steps u32 (0xffffffff: the same steps as the frame before), then each step: a kind u8 and
//!   0 · a picture: x, y, w, h u32 (where on the frame) · w × h × 4 bytes RGBA (straight alpha, as the canvas gives it)
//!   1 · a lens (a magnifying call-out): its middle cx, cy · zoom · shadow blur px · opacity f64 · its outline (how
//!       many points u32 · x, y f64 each, canvas pixels): what's under its middle, made zoom times bigger, inside
//!       the outline, with a soft shadow round it — as compositor.js drawCallout draws its magnifier
//!
//!   2 · a blur (a call-out that blurs what's round it, 1.13): its blur sigma px · opacity f64 · its outline (as the
//!       lens's): everything outside the outline blurred, as compositor.js drawCallout (the canvas's blur filter
//!       over a copy of the frame, the focus area put back sharp)
//!
//!   3 · a mark (1.13): which slot layer the steps after it belong to u32 (a background graphic's place in the
//!       stack, frame.rs SLOT), or 0xffffffff: over everything again. Steps before any mark go over everything.
//!
//! Pictures are laid down in order, so a lens or a blur sees what came before it.

use crate::frame::par_rows;
use std::io::Read;

pub enum Step {
    Picture { x: usize, y: usize, w: usize, h: usize, rgba: Vec<u8> },
    Lens { cx: f64, cy: f64, zoom: f64, blur: f64, alpha: f64, pts: Vec<(f64, f64)> },
    Blur { sigma: f64, alpha: f64, pts: Vec<(f64, f64)> },
    Mark(Option<usize>),
}

/// An outline: how many points u32, then x, y f64 each.
fn read_pts(r: &mut dyn Read, bad: &dyn Fn() -> String) -> Result<Vec<(f64, f64)>, String> {
    let (mut b4, mut b8) = ([0u8; 4], [0u8; 8]);
    r.read_exact(&mut b4).map_err(|_| bad())?;
    let np = u32::from_le_bytes(b4) as usize;
    if !(3..=1024).contains(&np) { return Err(bad()); }
    let mut pts = Vec::with_capacity(np);
    for _ in 0..np {
        let mut p = [0.0; 2];
        for v in p.iter_mut() { r.read_exact(&mut b8).map_err(|_| bad())?; *v = f64::from_le_bytes(b8); }
        if !p[0].is_finite() || !p[1].is_finite() || p[0].abs() > 1e6 || p[1].abs() > 1e6 { return Err(bad()); }
        pts.push((p[0], p[1]));
    }
    Ok(pts)
}

/// Reads one frame's steps (None at the end of the stream). `last`: the frame before's, for a repeat.
pub fn read(r: &mut dyn Read, fw: usize, fh: usize, last: &std::sync::Arc<Vec<Step>>) -> Result<std::sync::Arc<Vec<Step>>, String> {
    let bad = || "the editor's drawing over the frame came in wrong".to_string();
    let mut b4 = [0u8; 4];
    let mut b8 = [0u8; 8];
    let mut u32_ = |r: &mut dyn Read| -> Result<usize, String> { r.read_exact(&mut b4).map_err(|_| bad())?; Ok(u32::from_le_bytes(b4) as usize) };
    let n = u32_(r)?;
    if n == u32::MAX as usize { return Ok(last.clone()); }
    if n > 64 { return Err(bad()); }
    let mut steps = Vec::with_capacity(n);
    for _ in 0..n {
        let mut k = [0u8; 1];
        r.read_exact(&mut k).map_err(|_| bad())?;
        match k[0] {
            0 => {
                let (x, y, w, h) = (u32_(r)?, u32_(r)?, u32_(r)?, u32_(r)?);
                if w == 0 || h == 0 || x + w > fw || y + h > fh { return Err(bad()); }
                let mut rgba = vec![0u8; w * h * 4];
                r.read_exact(&mut rgba).map_err(|_| bad())?;
                steps.push(Step::Picture { x, y, w, h, rgba });
            }
            1 => {
                let mut f = [0.0; 5];
                for v in f.iter_mut() { r.read_exact(&mut b8).map_err(|_| bad())?; *v = f64::from_le_bytes(b8); }
                let np = u32_(r)?;
                if !(3..=1024).contains(&np) || f.iter().any(|v| !v.is_finite()) || f[2] < 1.0 || f[2] > 50.0 || !(0.0..=1.0).contains(&f[4]) || !(0.0..=1000.0).contains(&f[3]) { return Err(bad()); }
                let mut pts = Vec::with_capacity(np);
                for _ in 0..np {
                    let mut p = [0.0; 2];
                    for v in p.iter_mut() { r.read_exact(&mut b8).map_err(|_| bad())?; *v = f64::from_le_bytes(b8); }
                    if !p[0].is_finite() || !p[1].is_finite() || p[0].abs() > 1e6 || p[1].abs() > 1e6 { return Err(bad()); }
                    pts.push((p[0], p[1]));
                }
                steps.push(Step::Lens { cx: f[0], cy: f[1], zoom: f[2], blur: f[3], alpha: f[4], pts });
            }
            2 => {
                let mut f = [0.0; 2];
                for v in f.iter_mut() { r.read_exact(&mut b8).map_err(|_| bad())?; *v = f64::from_le_bytes(b8); }
                if f.iter().any(|v| !v.is_finite()) || !(0.0..=500.0).contains(&f[0]) || !(0.0..=1.0).contains(&f[1]) { return Err(bad()); }
                let pts = read_pts(r, &bad)?;
                steps.push(Step::Blur { sigma: f[0], alpha: f[1], pts });
            }
            3 => { let k = u32_(r)?; steps.push(Step::Mark(if k == u32::MAX as usize { None } else if k < 64 { Some(k) } else { return Err(bad()) })); }
            _ => return Err(bad()),
        }
    }
    Ok(std::sync::Arc::new(steps))
}

/// Lays the steps over acc (w × h, opaque RGB 0..255): those over everything.
#[allow(dead_code)]
pub fn apply(acc: &mut [[f64; 3]], w: usize, h: usize, steps: &[Step]) { apply_group(acc, w, h, steps, None) }
/// Lays the steps of one group over acc: slot layer k's (Some(k)), or those over everything (None).
pub fn apply_group(acc: &mut [[f64; 3]], w: usize, h: usize, steps: &[Step], group: Option<usize>) {
    let mut now = None;
    for s in steps {
        if let Step::Mark(g) = s { now = *g; continue; }
        if now != group { continue; }
        match s {
            Step::Mark(_) => {}
            Step::Picture { x, y, w: pw, h: ph, rgba } => {
                let (x, y, pw) = (*x, *y, *pw);
                par_rows(&mut acc[y * w..(y + ph) * w], w, |j, row| {
                    for i in 0..pw {
                        let o = (j * pw + i) * 4;
                        let a = rgba[o + 3] as f64 / 255.0;
                        if a <= 0.0 { continue; }
                        let px = &mut row[x + i];
                        for c in 0..3 { px[c] = rgba[o + c] as f64 * a + px[c] * (1.0 - a); }
                    }
                });
            }
            Step::Lens { cx, cy, zoom, blur, alpha, pts } => lens(acc, w, h, *cx, *cy, *zoom, *blur, *alpha, pts),
            Step::Blur { sigma, alpha, pts } => blur_outside(acc, w, h, *sigma, *alpha, pts),
        }
    }
}

/// The magnifier: the outline filled black with a soft shadow round it (rgba(0,0,0,0.5), the canvas's shadowBlur),
/// then what was under its middle, zoom times bigger, inside it; all at opacity alpha.
#[allow(clippy::too_many_arguments)]
fn lens(acc: &mut [[f64; 3]], w: usize, h: usize, cx: f64, cy: f64, zoom: f64, blur: f64, alpha: f64, pts: &[(f64, f64)]) {
    let (mut x0, mut x1, mut y0, mut y1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for &(x, y) in pts { x0 = x0.min(x); x1 = x1.max(x); y0 = y0.min(y); y1 = y1.max(y); }
    let sigma = (blur / 2.0).max(0.01);
    let pad = if blur > 0.0 { (sigma * 3.0).ceil() + 2.0 } else { 1.0 };
    let cl = |v: f64, n: usize| v.max(0.0).min(n as f64) as usize;
    let (bx0, bx1, by0, by1) = (cl((x0 - pad).floor(), w), cl((x1 + pad).ceil(), w), cl((y0 - pad).floor(), h), cl((y1 + pad).ceil(), h));
    if bx1 <= bx0 || by1 <= by0 { return; }
    let (bw, bh) = (bx1 - bx0, by1 - by0);
    // how much of each pixel the outline covers
    let mut cov = vec![0f64; bw * bh];
    par_rows(&mut cov, bw, |j, row| {
        for (i, v) in row.iter_mut().enumerate() {
            *v = (0.5 - crate::ink::poly_dist(pts, (bx0 + i) as f64 + 0.5, (by0 + j) as f64 + 0.5)).clamp(0.0, 1.0);
        }
    });
    // what's under its middle, taken before anything of the lens is drawn (only the part it shows)
    let (sx0, sx1) = (cl((cx + (x0 - cx) / zoom - 2.0).floor(), w), cl((cx + (x1 - cx) / zoom + 2.0).ceil(), w));
    let (sy0, sy1) = (cl((cy + (y0 - cy) / zoom - 2.0).floor(), h), cl((cy + (y1 - cy) / zoom + 2.0).ceil(), h));
    let sw = sx1.saturating_sub(sx0);
    let snap: Vec<[f64; 3]> = (sy0..sy1).flat_map(|y| acc[y * w + sx0..y * w + sx1].iter().copied()).collect();
    let sh = sy1.saturating_sub(sy0);
    // the shadow: the outline's cover, softened, darkening what's round it
    if blur > 0.0 {
        let r = (sigma * 3.0).ceil() as i64;
        let k: Vec<f64> = (-r..=r).map(|i| (-(i * i) as f64 / (2.0 * sigma * sigma)).exp()).collect();
        let ks: f64 = k.iter().sum();
        let mut t = vec![0f64; bw * bh];
        for y in 0..bh { for x in 0..bw {
            let mut s = 0.0;
            for (j, kv) in k.iter().enumerate() { let xx = x as i64 + j as i64 - r; if xx >= 0 && (xx as usize) < bw { s += cov[y * bw + xx as usize] * kv; } }
            t[y * bw + x] = s / ks;
        } }
        for y in 0..bh { for x in 0..bw {
            let mut s = 0.0;
            for (j, kv) in k.iter().enumerate() { let yy = y as i64 + j as i64 - r; if yy >= 0 && (yy as usize) < bh { s += t[yy as usize * bw + x] * kv; } }
            let a = (s / ks) * 0.5 * alpha;
            let o = &mut acc[(by0 + y) * w + bx0 + x];
            for c in 0..3 { o[c] *= 1.0 - a; }
        } }
    }
    // the black under it, then the picture made bigger
    let sample = |u: f64, v: f64| -> [f64; 3] {
        if sw == 0 || sh == 0 { return [0.0; 3]; }
        let (u, v) = ((u - sx0 as f64 - 0.5).clamp(0.0, (sw - 1) as f64), (v - sy0 as f64 - 0.5).clamp(0.0, (sh - 1) as f64));
        let (xa, ya) = (u.floor() as usize, v.floor() as usize);
        let (xb, yb) = ((xa + 1).min(sw - 1), (ya + 1).min(sh - 1));
        let (fx, fy) = (u - xa as f64, v - ya as f64);
        let p = |x: usize, y: usize| snap[y * sw + x];
        let (a, b, c, d) = (p(xa, ya), p(xb, ya), p(xa, yb), p(xb, yb));
        let mut o = [0.0; 3];
        for i in 0..3 { o[i] = (a[i] * (1.0 - fx) + b[i] * fx) * (1.0 - fy) + (c[i] * (1.0 - fx) + d[i] * fx) * fy; }
        o
    };
    for y in 0..bh { for x in 0..bw {
        let k = cov[y * bw + x] * alpha;
        if k <= 0.0 { continue; }
        let (px, py) = ((bx0 + x) as f64 + 0.5, (by0 + y) as f64 + 0.5);
        let s = sample(cx + (px - cx) / zoom, cy + (py - cy) / zoom);
        let o = &mut acc[(by0 + y) * w + bx0 + x];
        for c in 0..3 { let black = o[c] * (1.0 - k); o[c] = s[c] * k + black * (1.0 - k); }
    } }
}

/// Box widths for three box blurs that together make a Gaussian of `sigma` (as the canvas's own blur does it).
fn boxes(sigma: f64) -> [usize; 3] {
    let wi = (12.0 * sigma * sigma / 3.0 + 1.0).sqrt().floor() as i64;
    let wl = if wi % 2 == 0 { wi - 1 } else { wi }.max(1);
    let wu = wl + 2;
    let m = ((12.0 * sigma * sigma - 3.0 * (wl * wl) as f64 - 12.0 * wl as f64 - 9.0) / (-4.0 * wl as f64 - 4.0)).round() as i64;
    let mut out = [0usize; 3];
    for (i, o) in out.iter_mut().enumerate() { *o = (if (i as i64) < m { wl } else { wu }) as usize; }
    out
}
/// One box blur along each row (width d, odd), nothing beyond the edges (it counts as transparent).
fn box_rows(src: &[[f32; 3]], dst: &mut [[f32; 3]], w: usize, d: usize) {
    let r = d / 2;
    let k = 1.0 / d as f32;
    par_rows(dst, w, |y, out| {
        let row = &src[y * w..(y + 1) * w];
        let mut s = [0.0f32; 3];
        for p in row.iter().take(r.min(w.saturating_sub(1)) + 1) { for c in 0..3 { s[c] += p[c]; } }
        for x in 0..w {
            out[x] = [s[0] * k, s[1] * k, s[2] * k];
            if let Some(p) = row.get(x + r + 1) { for c in 0..3 { s[c] += p[c]; } }
            if x >= r { let p = row[x - r]; for c in 0..3 { s[c] -= p[c]; } }
        }
    });
}
/// How much of the picture the three boxes see at each of n places along a line (1 away from the ends).
fn edge_weights(n: usize, bx: &[usize; 3]) -> Vec<f32> {
    let mut a = vec![1.0f32; n];
    for &d in bx {
        let r = d / 2;
        let mut b = vec![0.0f32; n];
        let mut s: f32 = a.iter().take(r.min(n.saturating_sub(1)) + 1).sum();
        for x in 0..n {
            b[x] = s / d as f32;
            if let Some(v) = a.get(x + r + 1) { s += v; }
            if x >= r { s -= a[x - r]; }
        }
        a = b;
    }
    a
}
fn transpose(src: &[[f32; 3]], w: usize, h: usize) -> Vec<[f32; 3]> {
    let mut t = vec![[0.0; 3]; w * h];
    par_rows(&mut t, h, |x, col| { for y in 0..h { col[y] = src[y * w + x]; } });
    t
}

/// A call-out that blurs what's round it: the frame blurred (the edges fading as the canvas's blur does, over the
/// frame itself), at opacity alpha, everywhere outside the outline.
fn blur_outside(acc: &mut [[f64; 3]], w: usize, h: usize, sigma: f64, alpha: f64, pts: &[(f64, f64)]) {
    if sigma < 0.05 || alpha <= 0.0 || w == 0 || h == 0 { return; }
    let bx = boxes(sigma);
    let mut a: Vec<[f32; 3]> = acc.iter().map(|p| [p[0] as f32, p[1] as f32, p[2] as f32]).collect();
    let mut b = vec![[0.0; 3]; w * h];
    for &d in &bx { box_rows(&a, &mut b, w, d); std::mem::swap(&mut a, &mut b); }
    let mut t = transpose(&a, w, h);
    let mut tb = vec![[0.0; 3]; w * h];
    for &d in &bx { box_rows(&t, &mut tb, h, d); std::mem::swap(&mut t, &mut tb); }
    drop(tb);
    let blurred = transpose(&t, h, w);
    // how much of the frame the blur saw at each pixel (less by the edges): it's the same along each row and column
    let (wx, wy) = (edge_weights(w, &bx), edge_weights(h, &bx));
    // the outline's box: the focus area is only ever inside it
    let (mut x0, mut x1, mut y0, mut y1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for &(x, y) in pts { x0 = x0.min(x); x1 = x1.max(x); y0 = y0.min(y); y1 = y1.max(y); }
    let (a32, al) = (alpha as f32, alpha);
    par_rows(acc, w, |y, row| {
        let near_y = (y as f64 + 0.5) >= y0 - 1.0 && (y as f64 + 0.5) <= y1 + 1.0;
        for (x, px) in row.iter_mut().enumerate() {
            let cov = if near_y && (x as f64 + 0.5) >= x0 - 1.0 && (x as f64 + 0.5) <= x1 + 1.0 {
                (0.5 - crate::ink::poly_dist(pts, x as f64 + 0.5, y as f64 + 0.5)).clamp(0.0, 1.0)
            } else { 0.0 };
            if cov >= 1.0 { continue; }
            let q = blurred[y * w + x];
            let keep = 1.0 - (wx[x] * wy[y] * a32) as f64;
            for c in 0..3 {
                let o = q[c] as f64 * al + px[c] * keep;
                px[c] = px[c] * cov + o * (1.0 - cov);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pictures_laid_over_and_repeated() {
        let mut data = vec![];
        data.extend(1u32.to_le_bytes()); data.push(0);
        for v in [1u32, 1, 2, 1] { data.extend(v.to_le_bytes()); }
        data.extend([255, 0, 0, 255, 0, 0, 255, 128]);
        data.extend(u32::MAX.to_le_bytes());
        let mut r = std::io::Cursor::new(data);
        let none = std::sync::Arc::new(vec![]);
        let a = read(&mut r, 4, 4, &none).unwrap();
        let b = read(&mut r, 4, 4, &a).unwrap();
        assert!(std::sync::Arc::ptr_eq(&a, &b), "the same steps again");
        let mut acc = vec![[100.0; 3]; 16];
        apply(&mut acc, 4, 4, &b);
        assert_eq!(acc[5], [255.0, 0.0, 0.0]);
        assert!((acc[6][2] - (255.0 * 128.0 / 255.0 + 100.0 * (1.0 - 128.0 / 255.0))).abs() < 1e-9);
        assert_eq!(acc[0], [100.0; 3]);
    }
    #[test]
    fn a_blur_softens_outside_only() {
        // a sharp edge down the middle; a blur outside a box on the right
        let (w, h) = (60, 20);
        let mut acc: Vec<[f64; 3]> = (0..w * h).map(|i| if i % w < 20 { [0.0; 3] } else { [200.0; 3] }).collect();
        blur_outside(&mut acc, w, h, 3.0, 1.0, &[(40.0, 0.0), (60.0, 0.0), (60.0, 20.0), (40.0, 20.0)]);
        // by the edge (outside the box): softened both sides
        let (l, r) = (acc[10 * w + 19][0], acc[10 * w + 20][0]);
        assert!(l > 20.0 && l < 100.0 && r > 100.0 && r < 190.0, "{l} {r}");
        // far from the edge: as it was; inside the box: untouched
        assert!((acc[10 * w + 5][0]).abs() < 1.0);
        assert_eq!(acc[10 * w + 50], [200.0; 3]);
        // read back from the stream
        let mut data = vec![]; data.extend(1u32.to_le_bytes()); data.push(2);
        for v in [3.0f64, 0.5] { data.extend(v.to_le_bytes()); }
        data.extend(3u32.to_le_bytes()); for v in [0.0f64, 0.0, 5.0, 0.0, 0.0, 5.0] { data.extend(v.to_le_bytes()); }
        let s = read(&mut std::io::Cursor::new(data), 10, 10, &std::sync::Arc::new(vec![])).unwrap();
        assert!(matches!(s[0], Step::Blur { sigma, alpha, .. } if sigma == 3.0 && alpha == 0.5));
    }
    #[test]
    fn marked_steps_go_in_their_slot() {
        // a picture over everything, then a mark for slot 0 and a picture there, then a mark back to the top
        let mut data = vec![]; data.extend(4u32.to_le_bytes());
        data.push(0); for v in [0u32, 0, 1, 1] { data.extend(v.to_le_bytes()); } data.extend([255, 0, 0, 255]);
        data.push(3); data.extend(0u32.to_le_bytes());
        data.push(0); for v in [1u32, 0, 1, 1] { data.extend(v.to_le_bytes()); } data.extend([0, 255, 0, 255]);
        data.push(3); data.extend(u32::MAX.to_le_bytes());
        let s = read(&mut std::io::Cursor::new(data), 2, 1, &std::sync::Arc::new(vec![])).unwrap();
        let mut acc = vec![[0.0; 3]; 2];
        apply_group(&mut acc, 2, 1, &s, Some(0));
        assert_eq!(acc, vec![[0.0; 3], [0.0, 255.0, 0.0]], "only the slot's");
        apply_group(&mut acc, 2, 1, &s, None);
        assert_eq!(acc[0], [255.0, 0.0, 0.0], "then the top's");
        // and in a frame: the slot drawn where its layer is, under a fill laid over it at half
        let layers = vec![crate::frame::slot_layer(0), crate::frame::fill_layer([0, 0, 0], 0.5)];
        let px = crate::frame::draw_then(2, 1, [0, 0, 255], &[], &layers, |g, acc| apply_group(acc, 2, 1, &s, g));
        assert_eq!(&px[4..8], &[0, 128, 0, 255], "green in its slot (over the blue), halved by the fill over it");
        assert_eq!(&px[0..4], &[255, 0, 0, 255], "red over everything");
    }
    #[test]
    fn a_lens_shows_the_middle_bigger() {
        // a left half dark, right half light; a lens at the middle, twice as big, on a square outline
        let (w, h) = (40, 20);
        let mut acc: Vec<[f64; 3]> = (0..w * h).map(|i| if i % w < 20 { [0.0; 3] } else { [200.0; 3] }).collect();
        lens(&mut acc, w, h, 20.0, 10.0, 2.0, 0.0, 1.0, &[(10.0, 2.0), (30.0, 2.0), (30.0, 18.0), (10.0, 18.0)]);
        // 6 px right of the middle inside the lens shows what was 3 px right of it: light; 6 px left: dark
        assert_eq!(acc[10 * w + 26], [200.0; 3]);
        assert_eq!(acc[10 * w + 13], [0.0; 3]);
        // outside the lens: as it was
        assert_eq!(acc[10 * w + 5], [0.0; 3]);
        assert_eq!(acc[10 * w + 35], [200.0; 3]);
    }
}
#[cfg(test)]
mod bench {
    #[test]
    #[ignore]
    fn blur_1080p_speed() {
        let (w, h) = (1920, 1080);
        let mut acc: Vec<[f64; 3]> = (0..w * h).map(|i| [(i % 251) as f64, 100.0, 50.0]).collect();
        let t = std::time::Instant::now();
        for _ in 0..10 { super::blur_outside(&mut acc, w, h, 20.0, 1.0, &[(600.0, 300.0), (1200.0, 300.0), (1200.0, 700.0), (600.0, 700.0)]); }
        eprintln!("blur 1080p: {:.1} ms a frame", t.elapsed().as_secs_f64() * 100.0);
    }
}
