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
//! Pictures are laid down in order, so a lens sees what came before it.

use crate::frame::par_rows;
use std::io::Read;

pub enum Step {
    Picture { x: usize, y: usize, w: usize, h: usize, rgba: Vec<u8> },
    Lens { cx: f64, cy: f64, zoom: f64, blur: f64, alpha: f64, pts: Vec<(f64, f64)> },
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
            _ => return Err(bad()),
        }
    }
    Ok(std::sync::Arc::new(steps))
}

/// Lays the steps over acc (w × h, opaque RGB 0..255).
pub fn apply(acc: &mut [[f64; 3]], w: usize, h: usize, steps: &[Step]) {
    for s in steps {
        match s {
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
