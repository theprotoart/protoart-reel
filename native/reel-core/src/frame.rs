//! Drawing a frame (picture export, step 5): the layers lib/frameplan.js works out (each a picture placed, scaled,
//! cropped, turned and faded on the canvas) drawn over the background, bottom first, the way the browser's canvas
//! draws them: source-over, smooth edges, and a picture made smaller averaged over each pixel's footprint rather
//! than sampled at one point (no shimmer on a scaled-down screen recording). Pixels are RGBA, 8 bits, the canvas
//! opaque.

pub struct Picture { pub w: usize, pub h: usize, pub rgba: Vec<u8> }

/// One picture on the canvas: `m` maps its pixels to the canvas's (x' = a x + c y + e, y' = b x + d y + f), `rect`
/// the part of it shown (x0, y0, x1, y1 in its pixels), `alpha` how solid.
pub struct Layer { pub src: usize, pub alpha: f64, pub m: [f64; 6], pub rect: [f64; 4] }

/// Bilinear sample of premultiplied colour at (u, v) (pixel centres at .5), kept inside the shown part `r`.
fn sample(p: &Picture, r: &[f64; 4], u: f64, v: f64) -> [f64; 4] {
    let u = u.clamp(r[0] + 0.5, (r[2] - 0.5).max(r[0] + 0.5)) - 0.5;
    let v = v.clamp(r[1] + 0.5, (r[3] - 0.5).max(r[1] + 0.5)) - 0.5;
    let (x0, y0) = (u.floor(), v.floor());
    let (fx, fy) = (u - x0, v - y0);
    let (w, h) = (p.w as i64, p.h as i64);
    let px = |x: i64, y: i64| -> [f64; 4] {
        let (x, y) = (x.clamp(0, w - 1) as usize, y.clamp(0, h - 1) as usize);
        let o = (y * p.w + x) * 4;
        let a = p.rgba[o + 3] as f64 / 255.0;
        [p.rgba[o] as f64 * a, p.rgba[o + 1] as f64 * a, p.rgba[o + 2] as f64 * a, a]
    };
    let (x0, y0) = (x0 as i64, y0 as i64);
    let (a, b, c, d) = (px(x0, y0), px(x0 + 1, y0), px(x0, y0 + 1), px(x0 + 1, y0 + 1));
    let mut o = [0.0; 4];
    for k in 0..4 { o[k] = (a[k] * (1.0 - fx) + b[k] * fx) * (1.0 - fy) + (c[k] * (1.0 - fx) + d[k] * fx) * fy; }
    o
}

/// Draws the layers over `bg` onto a new w × h canvas (RGBA, opaque).
pub fn draw(w: usize, h: usize, bg: [u8; 3], pictures: &[Picture], layers: &[Layer]) -> Vec<u8> {
    let mut acc: Vec<[f64; 3]> = vec![[bg[0] as f64, bg[1] as f64, bg[2] as f64]; w * h];
    for l in layers {
        let Some(p) = pictures.get(l.src) else { continue };
        if p.w == 0 || p.h == 0 || l.alpha <= 0.0 { continue; }
        let [a, b, c, d, e, f] = l.m;
        let det = a * d - b * c;
        if det.abs() < 1e-12 { continue; }
        // canvas → source
        let (ia, ib, ic, id) = (d / det, -b / det, -c / det, a / det);
        let (ie, if_) = (-(ia * e + ic * f), -(ib * e + id * f));
        // how many canvas pixels one source pixel spans, along the source's two axes
        let (su, sv) = (a.hypot(b), c.hypot(d));
        let r = l.rect;
        let square = (b.abs() < 1e-9 && c.abs() < 1e-9) || (a.abs() < 1e-9 && d.abs() < 1e-9);
        let corners = [(r[0], r[1]), (r[2], r[1]), (r[0], r[3]), (r[2], r[3])];
        let xs = corners.iter().map(|&(u, v)| a * u + c * v + e);
        let ys = corners.iter().map(|&(u, v)| b * u + d * v + f);
        let (x0, x1) = xs.fold((f64::MAX, f64::MIN), |(lo, hi), x| (lo.min(x), hi.max(x)));
        let (y0, y1) = ys.fold((f64::MAX, f64::MIN), |(lo, hi), y| (lo.min(y), hi.max(y)));
        let (px0, px1) = ((x0.floor() - 1.0).max(0.0) as usize, ((x1.ceil() + 1.0).min(w as f64)).max(0.0) as usize);
        let (py0, py1) = ((y0.floor() - 1.0).max(0.0) as usize, ((y1.ceil() + 1.0).min(h as f64)).max(0.0) as usize);
        // a picture made smaller is averaged over each canvas pixel's footprint: bilinear samples spread over the part
        // of it that one bilinear sample doesn't already cover (1/s − 1 source pixels: none at full size, 1 at half
        // size, which makes an exact 2 × 2 average, 3 at a quarter, an exact 4 × 4)
        let spread = |s: f64| { let w = (1.0 / s - 1.0).max(0.0); if w < 1e-3 { (1usize, 0.0) } else { ((w.ceil() as usize + 1).min(9), w) } };
        let ((nu, wu), (nv, wv)) = (spread(su), spread(sv));
        let at = |i: usize, n: usize, w: f64| if n == 1 { 0.0 } else { -w / 2.0 + w * i as f64 / (n - 1) as f64 };
        for y in py0..py1 {
            for x in px0..px1 {
                let (cx, cy) = (x as f64 + 0.5, y as f64 + 0.5);
                let (u, v) = (ia * cx + ic * cy + ie, ib * cx + id * cy + if_);
                // how much of this canvas pixel the picture covers. Straight (not turned, or turned a quarter): a pixel is
                // in when its centre is, hard edges, as the browser's canvas draws it; turned: each edge smooth.
                let cov = if square {
                    if u >= r[0] && u < r[2] && v >= r[1] && v < r[3] { 1.0 } else { 0.0 }
                } else {
                    (0.5 + (u - r[0]) * su).clamp(0.0, 1.0) * (0.5 + (r[2] - u) * su).clamp(0.0, 1.0)
                        * (0.5 + (v - r[1]) * sv).clamp(0.0, 1.0) * (0.5 + (r[3] - v) * sv).clamp(0.0, 1.0)
                };
                if cov <= 0.0 { continue; }
                let mut s = [0.0; 4];
                if nu == 1 && nv == 1 { s = sample(p, &r, u, v); } else {
                    for j in 0..nv {
                        for i in 0..nu {
                            let q = sample(p, &r, u + at(i, nu, wu), v + at(j, nv, wv));
                            for k in 0..4 { s[k] += q[k]; }
                        }
                    }
                    let n = (nu * nv) as f64;
                    for k in 0..4 { s[k] /= n; }
                }
                let k = cov * l.alpha;
                let o = &mut acc[y * w + x];
                for ch in 0..3 { o[ch] = s[ch] * k + o[ch] * (1.0 - s[3] * k); }
            }
        }
    }
    let mut out = vec![255u8; w * h * 4];
    for (i, c) in acc.iter().enumerate() { for ch in 0..3 { out[i * 4 + ch] = c[ch].round().clamp(0.0, 255.0) as u8; } }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn solid(w: usize, h: usize, c: [u8; 4]) -> Picture { Picture { w, h, rgba: (0..w * h).flat_map(|_| c).collect() } }
    #[test]
    fn a_picture_placed_at_half_size_and_half_faded() {
        let pic = solid(4, 4, [200, 100, 0, 255]);
        let out = draw(8, 8, [0, 0, 255], &[pic], &[Layer { src: 0, alpha: 0.5, m: [1.0, 0.0, 0.0, 1.0, 2.0, 2.0], rect: [0.0, 0.0, 4.0, 4.0] }]);
        let at = |x: usize, y: usize| &out[(y * 8 + x) * 4..(y * 8 + x) * 4 + 3];
        assert_eq!(at(3, 3), &[100, 50, 128]); // half the picture over half the blue
        assert_eq!(at(0, 0), &[0, 0, 255]);
        assert_eq!(at(6, 6), &[0, 0, 255]);
    }
    #[test]
    fn a_straight_picture_has_hard_edges_at_pixel_centres() {
        // placed from x 0.4 to 2.4: pixels 0 and 1 have their centres inside, pixel 2 (centre 2.5) doesn't
        let pic = solid(2, 2, [255, 255, 255, 255]);
        let out = draw(4, 1, [0, 0, 0], &[pic], &[Layer { src: 0, alpha: 1.0, m: [1.0, 0.0, 0.0, 1.0, 0.4, -0.5], rect: [0.0, 0.0, 2.0, 2.0] }]);
        assert_eq!((out[0], out[4], out[8], out[12]), (255, 255, 0, 0));
    }
    #[test]
    fn a_turned_picture_has_smooth_edges() {
        // a big square turned 45° about the middle of a 9 × 9 canvas: the pixels its edge crosses are partly covered
        let pic = solid(6, 6, [255, 255, 255, 255]);
        let (co, si) = (std::f64::consts::FRAC_1_SQRT_2, std::f64::consts::FRAC_1_SQRT_2);
        let m = [co, si, -si, co, 4.5 - (co * 3.0 - si * 3.0), 4.5 - (si * 3.0 + co * 3.0)];
        let out = draw(9, 9, [0, 0, 0], &[pic], &[Layer { src: 0, alpha: 1.0, m, rect: [0.0, 0.0, 6.0, 6.0] }]);
        assert_eq!(out[(4 * 9 + 4) * 4], 255);
        assert!((0..81).any(|i| out[i * 4] > 20 && out[i * 4] < 235), "some edge pixels are in between");
    }
    #[test]
    fn a_fine_pattern_made_smaller_averages_to_grey() {
        let mut pic = solid(64, 64, [0, 0, 0, 255]);
        for y in 0..64 { for x in 0..64 { if (x + y) % 2 == 0 { let o = (y * 64 + x) * 4; pic.rgba[o..o + 3].copy_from_slice(&[255, 255, 255]); } } }
        let out = draw(16, 16, [0, 0, 0], &[pic], &[Layer { src: 0, alpha: 1.0, m: [0.25, 0.0, 0.0, 0.25, 0.0, 0.0], rect: [0.0, 0.0, 64.0, 64.0] }]);
        for px in out.chunks(4) { assert!((px[0] as i32 - 128).abs() <= 8, "{}", px[0]); }
    }
}
