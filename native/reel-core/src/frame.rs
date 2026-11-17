//! Drawing a frame (picture export, step 5): the layers lib/frameplan.js works out (each a picture placed, scaled,
//! cropped, turned and faded on the canvas) drawn over the background, bottom first, the way the browser's canvas
//! draws them: source-over, smooth edges, and a picture made smaller averaged over each pixel's footprint rather
//! than sampled at one point (no shimmer on a scaled-down screen recording). Pixels are RGBA, 8 bits, the canvas
//! opaque.

pub struct Picture { pub w: usize, pub h: usize, pub rgba: Vec<u8> }

/// One picture on the canvas: `m` maps its pixels to the canvas's (x' = a x + c y + e, y' = b x + d y + f), `rect`
/// the part of it shown (x0, y0, x1, y1 in its pixels), `alpha` how solid.
pub struct Layer { pub src: usize, pub alpha: f64, pub m: [f64; 6], pub rect: [f64; 4], pub look: Option<Look>, pub fill: Option<[u8; 3]>, pub filter: Option<Filter>, pub grade: Option<crate::grade::Grade>, pub ink: Option<Box<crate::ink::Ink>>, pub mask: Option<Vec<MaskShape>> }

/// A transition's shape that a layer is seen through (compositor.js maskPath), canvas px: outlines (as many as a
/// blinds wipe has) and circles (the iris). Inside any of them, the layer shows.
pub enum MaskShape { Poly(Vec<(f64, f64)>), Circle { x: f64, y: f64, r: f64 } }

/// Keeps what a layer drew only inside its mask: everything else back as it was before it (smooth edges).
fn apply_mask(acc: &mut [[f64; 3]], before: &[[f64; 3]], w: usize, mask: &[MaskShape]) {
    par_rows(acc, w, |y, row| {
        let cy = y as f64 + 0.5;
        for (x, px) in row.iter_mut().enumerate() {
            let cx = x as f64 + 0.5;
            let mut cov: f64 = 0.0;
            for s in mask {
                let d = match s { MaskShape::Poly(p) => crate::ink::poly_dist(p, cx, cy), MaskShape::Circle { x, y, r } => (cx - x).hypot(cy - y) - r };
                cov = cov.max((0.5 - d).clamp(0.0, 1.0));
                if cov >= 1.0 { break; }
            }
            if cov >= 1.0 { continue; }
            let b = before[y * w + x];
            for c in 0..3 { px[c] = b[c] + (px[c] - b[c]) * cov; }
        }
    });
}

/// The canvas filter a picture is drawn with (1.6), as compositor.js sets it: `blur(blur px) brightness(bright)
/// saturate(sat)`, in that order (the CSS filter functions, on the picture before it's laid down at its opacity).
pub struct Filter { pub blur: f64, pub bright: f64, pub sat: f64 }

/// The filter on a picture drawn on its own layer (premultiplied RGBA, 0..255, bw wide): a Gaussian blur (sigma =
/// blur px, as CSS), then brightness (each colour times bright) and saturate (the CSS matrix), each kept within 0..255.
fn apply_filter(buf: &mut [[f64; 4]], bw: usize, bh: usize, f: &Filter) {
    if f.blur > 0.05 {
        let sigma = f.blur;
        let r = (sigma * 3.0).ceil() as i64;
        let k: Vec<f64> = (-r..=r).map(|i| (-(i * i) as f64 / (2.0 * sigma * sigma)).exp()).collect();
        let ks: f64 = k.iter().sum();
        let mut t = vec![[0f64; 4]; bw * bh];
        // along the rows, then down the columns: each pass's rows shared out over the cores
        let src: &[[f64; 4]] = buf;
        par_rows(&mut t, bw, |y, row| { for x in 0..bw {
            let mut acc = [0.0; 4];
            for (j, kv) in k.iter().enumerate() { let xx = x as i64 + j as i64 - r; if xx >= 0 && (xx as usize) < bw { let q = src[y * bw + xx as usize]; for c in 0..4 { acc[c] += q[c] * kv; } } }
            for c in 0..4 { row[x][c] = acc[c] / ks; }
        } });
        let t = &t;
        par_rows(buf, bw, |y, row| { for x in 0..bw {
            let mut acc = [0.0; 4];
            for (j, kv) in k.iter().enumerate() { let yy = y as i64 + j as i64 - r; if yy >= 0 && (yy as usize) < bh { let q = t[yy as usize * bw + x]; for c in 0..4 { acc[c] += q[c] * kv; } } }
            for c in 0..4 { row[x][c] = acc[c] / ks; }
        } });
    }
    let (b, s) = (f.bright, f.sat);
    if (b - 1.0).abs() < 1e-9 && (s - 1.0).abs() < 1e-9 { return; }
    let m = [
        [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
        [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
        [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
    ];
    for q in buf.iter_mut() {
        let a = q[3];
        if a <= 1e-9 { continue; }
        let mut c = [0.0; 3];
        for i in 0..3 { c[i] = (q[i] / a * b).clamp(0.0, 255.0); }
        let mut o = [0.0; 3];
        for i in 0..3 { o[i] = (m[i][0] * c[0] + m[i][1] * c[1] + m[i][2] * c[2]).clamp(0.0, 255.0); }
        for i in 0..3 { q[i] = o[i] * a; }
    }
}

/// A layer that's no picture but a colour over the whole canvas (1.5: a dip to black or white), `alpha` solid.
pub fn fill_layer(rgb: [u8; 3], alpha: f64) -> Layer { Layer { src: usize::MAX, alpha, m: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], rect: [0.0, 0.0, 1.0, 1.0], look: None, fill: Some(rgb), filter: None, grade: None, ink: None, mask: None } }

/// How the clip's box looks (1.4): the box (b maps -0.5..0.5 of it to the canvas, w × h canvas pixels), its rounded
/// corners (radius, px), a border drawn on its edge (border px wide, in border_rgb) and a soft shadow under it (blur
/// px as the canvas's shadowBlur, moved down dy px), as compositor.js drawMedia draws them; cut (1.5): the picture is
/// cut to the box even with square corners (a stabilized picture moves inside its box).
pub struct Look { pub b: [f64; 6], pub w: f64, pub h: f64, pub radius: f64, pub border: f64, pub border_rgb: [u8; 3], pub shadow: f64, pub dy: f64, pub cut: bool }

/// Signed distance (canvas px) from a point of the box (px from its middle) to its rounded edge: < 0 inside.
fn rr_dist(x: f64, y: f64, w: f64, h: f64, r: f64) -> f64 {
    let r = r.max(0.0).min(w / 2.0).min(h / 2.0);
    let (qx, qy) = (x.abs() - (w / 2.0 - r), y.abs() - (h / 2.0 - r));
    let out = (qx.max(0.0)).hypot(qy.max(0.0));
    out + qx.max(qy).min(0.0) - r
}
/// The box-local point (px from its middle) under canvas pixel centre (cx, cy).
fn box_at(lk: &Look, ib: &[f64; 6], cx: f64, cy: f64) -> (f64, f64) {
    let (u, v) = (ib[0] * cx + ib[2] * cy + ib[4], ib[1] * cx + ib[3] * cy + ib[5]);
    (u * lk.w, v * lk.h)
}
fn invert(m: &[f64; 6]) -> Option<[f64; 6]> {
    let [a, b, c, d, e, f] = *m;
    let det = a * d - b * c;
    if det.abs() < 1e-12 { return None; }
    let (ia, ib, ic, id) = (d / det, -b / det, -c / det, a / det);
    Some([ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)])
}
/// The canvas pixels the box covers (with `pad` more round it), clamped to the canvas: x0, x1, y0, y1.
fn box_bounds(lk: &Look, pad: f64, w: usize, h: usize) -> (usize, usize, usize, usize) {
    let [a, b, c, d, e, f] = lk.b;
    let pts = [(-0.5, -0.5), (0.5, -0.5), (-0.5, 0.5), (0.5, 0.5)];
    let (mut x0, mut x1, mut y0, mut y1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for (u, v) in pts { let (x, y) = (a * u + c * v + e, b * u + d * v + f); x0 = x0.min(x); x1 = x1.max(x); y0 = y0.min(y); y1 = y1.max(y); }
    let cl = |v: f64, n: usize| v.max(0.0).min(n as f64) as usize;
    (cl((x0 - pad).floor(), w), cl((x1 + pad).ceil(), w), cl((y0 - pad).floor(), h), cl((y1 + pad).ceil(), h))
}

/// The shadow under a box: its rounded shape, softened (a Gaussian, sigma = blur / 2, as the canvas's shadowBlur),
/// moved down dy, black at 55% of the layer's alpha, laid over acc.
fn shadow(acc: &mut [[f64; 3]], w: usize, h: usize, lk: &Look, alpha: f64) {
    let Some(ib) = invert(&lk.b) else { return };
    let sigma = (lk.shadow / 2.0).max(0.01);
    let pad = (sigma * 3.0).ceil() + 2.0;
    let (x0, x1, y0, y1) = box_bounds(lk, pad, w, h + lk.dy.abs().ceil() as usize + pad as usize);
    let (y0, y1) = ((y0 as f64 + lk.dy).max(0.0) as usize, ((y1 as f64 + lk.dy).min(h as f64)).max(0.0) as usize);
    if x1 <= x0 || y1 <= y0 { return; }
    let (bw, bh) = (x1 - x0, y1 - y0);
    // the shape (smooth edges), at its place before it moves down
    let mut m = vec![0f64; bw * bh];
    for y in 0..bh { for x in 0..bw {
        let (cx, cy) = ((x0 + x) as f64 + 0.5, (y0 + y) as f64 + 0.5 - lk.dy);
        let (bx, by) = box_at(lk, &ib, cx, cy);
        m[y * bw + x] = (0.5 - rr_dist(bx, by, lk.w, lk.h, lk.radius)).clamp(0.0, 1.0);
    } }
    // blurred: a Gaussian along each axis
    let r = (sigma * 3.0).ceil() as i64;
    let k: Vec<f64> = (-r..=r).map(|i| (-(i * i) as f64 / (2.0 * sigma * sigma)).exp()).collect();
    let ks: f64 = k.iter().sum();
    let mut t = vec![0f64; bw * bh];
    for y in 0..bh { for x in 0..bw {
        let mut s = 0.0;
        for (j, kv) in k.iter().enumerate() { let xx = x as i64 + j as i64 - r; if xx >= 0 && (xx as usize) < bw { s += m[y * bw + xx as usize] * kv; } }
        t[y * bw + x] = s / ks;
    } }
    for y in 0..bh { for x in 0..bw {
        let mut s = 0.0;
        for (j, kv) in k.iter().enumerate() { let yy = y as i64 + j as i64 - r; if yy >= 0 && (yy as usize) < bh { s += t[yy as usize * bw + x] * kv; } }
        let a = (s / ks) * 0.55 * alpha;
        let o = &mut acc[(y0 + y) * w + x0 + x];
        for ch in 0..3 { o[ch] *= 1.0 - a; }
    } }
}


/// Runs f(row index, row) over the rows of `data` (rows of `width`), shared out over the cores. Each row is only
/// ever touched by one thread, so the result is the same as going row by row.
pub fn par_rows<T: Send>(data: &mut [T], width: usize, f: impl Fn(usize, &mut [T]) + Sync) {
    if width == 0 || data.is_empty() { return; }
    let rows = data.len() / width;
    let n = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).min(16).min(rows).max(1);
    // small jobs aren't worth the threads
    if n == 1 || data.len() < 32_768 {
        for (y, row) in data.chunks_mut(width).enumerate() { f(y, row); }
        return;
    }
    let per = rows.div_ceil(n);
    std::thread::scope(|sc| {
        for (i, chunk) in data.chunks_mut(per * width).enumerate() {
            let f = &f;
            sc.spawn(move || { for (j, row) in chunk.chunks_mut(width).enumerate() { f(i * per + j, row); } });
        }
    });
}

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
#[cfg_attr(not(test), allow(dead_code))]
pub fn draw(w: usize, h: usize, bg: [u8; 3], pictures: &[Picture], layers: &[Layer]) -> Vec<u8> { draw_then(w, h, bg, pictures, layers, |_| {}) }
/// draw, with `then` laying more over the canvas (RGB 0..255) before it's made bytes (1.12: the editor's drawing).
pub fn draw_then(w: usize, h: usize, bg: [u8; 3], pictures: &[Picture], layers: &[Layer], then: impl FnOnce(&mut [[f64; 3]])) -> Vec<u8> {
    let mut acc: Vec<[f64; 3]> = vec![[bg[0] as f64, bg[1] as f64, bg[2] as f64]; w * h];
    for l in layers {
        // a transition's shape (1.13): what the layer draws is kept only inside it, as the canvas's clip
        let before = l.mask.as_ref().map(|_| acc.clone());
        'one: {
        // pointer effects (1.11): shapes over what's drawn so far
        if let Some(ink) = &l.ink { crate::ink::draw(&mut acc, w, h, ink, l.alpha.clamp(0.0, 1.0)); break 'one; }
        if let Some(rgb) = l.fill {
            let a = l.alpha.clamp(0.0, 1.0);
            if a > 0.0 { for o in acc.iter_mut() { for ch in 0..3 { o[ch] = rgb[ch] as f64 * a + o[ch] * (1.0 - a); } } }
            break 'one;
        }
        let Some(p) = pictures.get(l.src) else { break 'one };
        // its filters first (1.7), at the size it's shown, as the editor's GPU pass does
        let graded;
        let p = match &l.grade { Some(g) => { graded = crate::grade::grade(p, g); &graded } None => p };
        if p.w == 0 || p.h == 0 || l.alpha <= 0.0 { break 'one; }
        let [a, b, c, d, e, f] = l.m;
        let det = a * d - b * c;
        if det.abs() < 1e-12 { break 'one; }
        // canvas → source
        let (ia, ib, ic, id) = (d / det, -b / det, -c / det, a / det);
        let (ie, if_) = (-(ia * e + ic * f), -(ib * e + id * f));
        // how many canvas pixels one source pixel spans, along the source's two axes
        let (su, sv) = (a.hypot(b), c.hypot(d));
        let r = l.rect;
        // the box: its shadow and the black under it first (as the canvas fills the shape with the shadow on)
        let look = l.look.as_ref().and_then(|lk| invert(&lk.b).map(|ib| (lk, ib)));
        if let Some((lk, ib)) = &look {
            if lk.shadow > 0.0 {
                shadow(&mut acc, w, h, lk, l.alpha);
                let (x0, x1, y0, y1) = box_bounds(lk, 1.0, w, h);
                for y in y0..y1 { for x in x0..x1 {
                    let (bx, by) = box_at(lk, ib, x as f64 + 0.5, y as f64 + 0.5);
                    let cov = (0.5 - rr_dist(bx, by, lk.w, lk.h, lk.radius)).clamp(0.0, 1.0) * l.alpha;
                    let o = &mut acc[y * w + x];
                    for ch in 0..3 { o[ch] *= 1.0 - cov; }
                } }
            }
        }
        let clip = look.as_ref().filter(|(lk, _)| lk.radius > 0.0 || lk.border > 0.0 || lk.cut);
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
        // a filtered picture is drawn on a layer of its own first (with room round it for the blur to spread into)
        let filt = l.filter.as_ref().filter(|f| f.blur > 0.05 || (f.bright - 1.0).abs() > 1e-9 || (f.sat - 1.0).abs() > 1e-9);
        let pad = filt.map(|f| (f.blur * 3.0).ceil() as usize + 1).unwrap_or(0);
        let (bx0, bx1, by0, by1) = (px0.saturating_sub(pad), (px1 + pad).min(w), py0.saturating_sub(pad), (py1 + pad).min(h));
        let bw = bx1.saturating_sub(bx0);
        let mut buf: Vec<[f64; 4]> = if filt.is_some() { vec![[0.0; 4]; bw * by1.saturating_sub(by0)] } else { Vec::new() };
        // one pixel of the picture: its colour (premultiplied) and how much of the canvas pixel it covers. Every pixel
        // is worked out on its own, so the rows are shared out over the cores (1.9) and the answer is the same
        // a picture that's only moved and scaled (the usual case): where each column and each row samples the source
        // is the same all the way down and across, so it's worked out once per column and per row, not per pixel. The
        // same sums in the same order as sample(), so the same answer, several times faster (1.9)
        let sep = b == 0.0 && c == 0.0;
        let taps = |q: f64, n: usize, span: f64, lo: f64, hi: f64, size: usize| -> Vec<(usize, usize, f64)> {
            (0..n).map(|i| {
                let q = if n == 1 { q } else { q + at(i, n, span) };
                let qq = q.clamp(lo + 0.5, (hi - 0.5).max(lo + 0.5)) - 0.5;
                let q0 = qq.floor();
                let (i0, i1) = ((q0 as i64).clamp(0, size as i64 - 1) as usize, (q0 as i64 + 1).clamp(0, size as i64 - 1) as usize);
                (i0, i1, qq - q0)
            }).collect()
        };
        let (mut ucol, mut vrow, mut tu, mut tv) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        if sep {
            for x in px0..px1 { let u = ia * (x as f64 + 0.5) + ic * 0.5 + ie; ucol.push(u); tu.extend(taps(u, nu, wu, r[0], r[2], p.w)); }
            for y in py0..py1 { let v = ib * 0.5 + id * (y as f64 + 0.5) + if_; vrow.push(v); tv.extend(taps(v, nv, wv, r[1], r[3], p.h)); }
        }
        let fetch = |x: usize, y: usize| -> [f64; 4] {
            let o = (y * p.w + x) * 4;
            let a = p.rgba[o + 3] as f64 / 255.0;
            [p.rgba[o] as f64 * a, p.rgba[o + 1] as f64 * a, p.rgba[o + 2] as f64 * a, a]
        };
        let pixel = |x: usize, y: usize| -> Option<([f64; 4], f64)> {
                let (cx, cy) = (x as f64 + 0.5, y as f64 + 0.5);
                if sep {
                    let (u, v) = (ucol[x - px0], vrow[y - py0]);
                    if !(u >= r[0] && u < r[2] && v >= r[1] && v < r[3]) { return None; }
                    let cov = match &clip { Some((lk, ib)) => { let (bx, by) = box_at(lk, ib, cx, cy); (0.5 - rr_dist(bx, by, lk.w, lk.h, lk.radius)).clamp(0.0, 1.0) } None => 1.0 };
                    if cov <= 0.0 { return None; }
                    let mut s = [0.0; 4];
                    for j in 0..nv {
                        let (y0, y1, fy) = tv[(y - py0) * nv + j];
                        for i in 0..nu {
                            let (x0, x1, fx) = tu[(x - px0) * nu + i];
                            let (a, b, c, d) = (fetch(x0, y0), fetch(x1, y0), fetch(x0, y1), fetch(x1, y1));
                            for k in 0..4 { s[k] += (a[k] * (1.0 - fx) + b[k] * fx) * (1.0 - fy) + (c[k] * (1.0 - fx) + d[k] * fx) * fy; }
                        }
                    }
                    if nu * nv > 1 { let n = (nu * nv) as f64; for k in 0..4 { s[k] /= n; } }
                    return Some((s, cov));
                }
                let (u, v) = (ia * cx + ic * cy + ie, ib * cx + id * cy + if_);
                // how much of this canvas pixel the picture covers. Straight (not turned, or turned a quarter): a pixel is
                // in when its centre is, hard edges, as the browser's canvas draws it; turned: each edge smooth.
                let cov = if square {
                    if u >= r[0] && u < r[2] && v >= r[1] && v < r[3] { 1.0 } else { 0.0 }
                } else {
                    (0.5 + (u - r[0]) * su).clamp(0.0, 1.0) * (0.5 + (r[2] - u) * su).clamp(0.0, 1.0)
                        * (0.5 + (v - r[1]) * sv).clamp(0.0, 1.0) * (0.5 + (r[3] - v) * sv).clamp(0.0, 1.0)
                };
                // rounded corners (or a border): the picture is cut to the box with smooth edges
                let cov = match &clip { Some((lk, ib)) => { let (bx, by) = box_at(lk, ib, cx, cy); cov * (0.5 - rr_dist(bx, by, lk.w, lk.h, lk.radius)).clamp(0.0, 1.0) } None => cov };
                if cov <= 0.0 { return None; }
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
                Some((s, cov))
        };
        if filt.is_some() {
            if py1 > py0 && bw > 0 {
                let (r0, r1) = ((py0 - by0) * bw, (py1 - by0) * bw);
                par_rows(&mut buf[r0..r1], bw, |j, row| {
                    let y = py0 + j;
                    for x in px0..px1 { if let Some((s, cov)) = pixel(x, y) { row[x - bx0] = [s[0] * cov, s[1] * cov, s[2] * cov, s[3] * cov]; } }
                });
            }
        } else if py1 > py0 {
            let alpha = l.alpha;
            par_rows(&mut acc[py0 * w..py1 * w], w, |j, row| {
                let y = py0 + j;
                for x in px0..px1 {
                    let Some((s, cov)) = pixel(x, y) else { continue };
                    let k = cov * alpha;
                    let o = &mut row[x];
                    for ch in 0..3 { o[ch] = s[ch] * k + o[ch] * (1.0 - s[3] * k); }
                }
            });
        }
        // the filter, then the layer laid down at its opacity
        if let Some(fl) = filt {
            let bh = by1.saturating_sub(by0);
            apply_filter(&mut buf, bw, bh, fl);
            for y in 0..bh { for x in 0..bw {
                let q = buf[y * bw + x];
                if q[3] <= 0.0 { continue; }
                let o = &mut acc[(by0 + y) * w + bx0 + x];
                for ch in 0..3 { o[ch] = q[ch] * l.alpha + o[ch] * (1.0 - q[3] * l.alpha); }
            } }
        }
        // the border: a line border px wide along the box's edge, half in, half out
        if let Some((lk, ib)) = &look {
            if lk.border > 0.0 {
                let half = lk.border / 2.0;
                let (x0, x1, y0, y1) = box_bounds(lk, half + 2.0, w, h);
                for y in y0..y1 { for x in x0..x1 {
                    let (bx, by) = box_at(lk, ib, x as f64 + 0.5, y as f64 + 0.5);
                    let d = rr_dist(bx, by, lk.w, lk.h, lk.radius).abs();
                    let cov = (half - d + 0.5).clamp(0.0, 1.0).min(lk.border) * l.alpha;
                    if cov <= 0.0 { continue; }
                    let o = &mut acc[y * w + x];
                    for ch in 0..3 { o[ch] = lk.border_rgb[ch] as f64 * cov + o[ch] * (1.0 - cov); }
                } }
            }
        }
        }
        if let (Some(mask), Some(before)) = (&l.mask, before) { apply_mask(&mut acc, &before, w, mask); }
    }
    then(&mut acc);
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
        let out = draw(8, 8, [0, 0, 255], &[pic], &[Layer { src: 0, alpha: 0.5, m: [1.0, 0.0, 0.0, 1.0, 2.0, 2.0], rect: [0.0, 0.0, 4.0, 4.0], look: None, fill: None, filter: None, grade: None, ink: None, mask: None }]);
        let at = |x: usize, y: usize| &out[(y * 8 + x) * 4..(y * 8 + x) * 4 + 3];
        assert_eq!(at(3, 3), &[100, 50, 128]); // half the picture over half the blue
        assert_eq!(at(0, 0), &[0, 0, 255]);
        assert_eq!(at(6, 6), &[0, 0, 255]);
    }
    #[test]
    fn a_straight_picture_has_hard_edges_at_pixel_centres() {
        // placed from x 0.4 to 2.4: pixels 0 and 1 have their centres inside, pixel 2 (centre 2.5) doesn't
        let pic = solid(2, 2, [255, 255, 255, 255]);
        let out = draw(4, 1, [0, 0, 0], &[pic], &[Layer { src: 0, alpha: 1.0, m: [1.0, 0.0, 0.0, 1.0, 0.4, -0.5], rect: [0.0, 0.0, 2.0, 2.0], look: None, fill: None, filter: None, grade: None, ink: None, mask: None }]);
        assert_eq!((out[0], out[4], out[8], out[12]), (255, 255, 0, 0));
    }
    #[test]
    fn a_turned_picture_has_smooth_edges() {
        // a big square turned 45° about the middle of a 9 × 9 canvas: the pixels its edge crosses are partly covered
        let pic = solid(6, 6, [255, 255, 255, 255]);
        let (co, si) = (std::f64::consts::FRAC_1_SQRT_2, std::f64::consts::FRAC_1_SQRT_2);
        let m = [co, si, -si, co, 4.5 - (co * 3.0 - si * 3.0), 4.5 - (si * 3.0 + co * 3.0)];
        let out = draw(9, 9, [0, 0, 0], &[pic], &[Layer { src: 0, alpha: 1.0, m, rect: [0.0, 0.0, 6.0, 6.0], look: None, fill: None, filter: None, grade: None, ink: None, mask: None }]);
        assert_eq!(out[(4 * 9 + 4) * 4], 255);
        assert!((0..81).any(|i| out[i * 4] > 20 && out[i * 4] < 235), "some edge pixels are in between");
    }
    #[test]
    fn rounded_corners_cut_the_picture_and_a_border_goes_round_it() {
        // a 20 × 20 white picture filling a 20 × 20 box at (10, 10) on a black 40 × 40 canvas, corners 6 px, a red 2 px border
        let pic = solid(20, 20, [255, 255, 255, 255]);
        let lk = Look { b: [20.0, 0.0, 0.0, 20.0, 20.0, 20.0], w: 20.0, h: 20.0, radius: 6.0, border: 0.0, border_rgb: [255, 0, 0], shadow: 0.0, dy: 0.0, cut: false };
        let out = draw(40, 40, [0, 0, 0], &[pic], &[Layer { src: 0, alpha: 1.0, m: [1.0, 0.0, 0.0, 1.0, 10.0, 10.0], rect: [0.0, 0.0, 20.0, 20.0], look: Some(lk), fill: None, filter: None, grade: None, ink: None, mask: None }]);
        let at = |x: usize, y: usize| out[(y * 40 + x) * 4];
        assert_eq!(at(20, 20), 255);
        assert_eq!(at(10, 10), 0, "the corner is cut off");
        assert_eq!(at(20, 10), 255, "the straight edge isn't");
        let pic = solid(20, 20, [255, 255, 255, 255]);
        let lk = Look { b: [20.0, 0.0, 0.0, 20.0, 20.0, 20.0], w: 20.0, h: 20.0, radius: 0.0, border: 2.0, border_rgb: [255, 0, 0], shadow: 0.0, dy: 0.0, cut: false };
        let out = draw(40, 40, [0, 0, 0], &[pic], &[Layer { src: 0, alpha: 1.0, m: [1.0, 0.0, 0.0, 1.0, 10.0, 10.0], rect: [0.0, 0.0, 20.0, 20.0], look: Some(lk), fill: None, filter: None, grade: None, ink: None, mask: None }]);
        let px = |x: usize, y: usize| [out[(y * 40 + x) * 4], out[(y * 40 + x) * 4 + 1]];
        assert_eq!(px(9, 20), [255, 0], "the border outside the edge");
        assert_eq!(px(10, 20), [255, 0], "and inside it");
        assert_eq!(px(12, 20), [255, 255], "then the picture");
    }
    #[test]
    fn a_shadow_falls_below() {
        let pic = solid(10, 10, [255, 255, 255, 255]);
        let lk = Look { b: [10.0, 0.0, 0.0, 10.0, 20.0, 15.0], w: 10.0, h: 10.0, radius: 0.0, border: 0.0, border_rgb: [0, 0, 0], shadow: 8.0, dy: 2.0, cut: false };
        let out = draw(40, 40, [200, 200, 200], &[pic], &[Layer { src: 0, alpha: 1.0, m: [1.0, 0.0, 0.0, 1.0, 15.0, 10.0], rect: [0.0, 0.0, 10.0, 10.0], look: Some(lk), fill: None, filter: None, grade: None, ink: None, mask: None }]);
        let at = |x: usize, y: usize| out[(y * 40 + x) * 4];
        assert!(at(20, 22) < 170, "darker just under it: {}", at(20, 22));
        assert!(at(20, 7) > at(20, 22), "less above than below");
        assert_eq!(at(2, 2), 200, "nothing far away");
    }
    #[test]
    fn a_dip_lays_a_colour_over_everything() {
        let pic = solid(4, 4, [0, 0, 255, 255]);
        let out = draw(4, 4, [0, 0, 0], &[pic], &[Layer { src: 0, alpha: 1.0, m: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], rect: [0.0, 0.0, 4.0, 4.0], look: None, fill: None, filter: None, grade: None, ink: None, mask: None }, fill_layer([255, 255, 255], 0.25)]);
        assert_eq!(&out[0..3], &[64, 64, 255]);
    }
    #[test]
    fn a_stabilized_picture_is_cut_to_its_box() {
        // the picture drawn twice its size around the box's middle, but cut to the 10 × 10 box at (5, 5)
        let pic = solid(10, 10, [255, 255, 255, 255]);
        let lk = Look { b: [10.0, 0.0, 0.0, 10.0, 10.0, 10.0], w: 10.0, h: 10.0, radius: 0.0, border: 0.0, border_rgb: [0, 0, 0], shadow: 0.0, dy: 0.0, cut: true };
        let out = draw(20, 20, [0, 0, 0], &[pic], &[Layer { src: 0, alpha: 1.0, m: [2.0, 0.0, 0.0, 2.0, 0.0, 0.0], rect: [0.0, 0.0, 10.0, 10.0], look: Some(lk), fill: None, filter: None, grade: None, ink: None, mask: None }]);
        let at = |x: usize, y: usize| out[(y * 20 + x) * 4];
        assert_eq!(at(10, 10), 255);
        assert_eq!(at(2, 2), 0, "outside the box: cut");
        assert_eq!(at(17, 17), 0);
    }
    #[test]
    fn brightness_and_saturate_are_the_css_ones() {
        // brightness(2) then saturate(0): (100, 50, 0) → (200, 100, 0) → the CSS grey 0.213·200 + 0.715·100 = 114.1
        let pic = solid(4, 4, [100, 50, 0, 255]);
        let out = draw(4, 4, [0, 0, 0], &[pic], &[Layer { src: 0, alpha: 1.0, m: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], rect: [0.0, 0.0, 4.0, 4.0], look: None, fill: None, filter: Some(Filter { blur: 0.0, bright: 2.0, sat: 0.0 }), grade: None, ink: None, mask: None }]);
        assert_eq!(&out[4 * 5..4 * 5 + 3], &[114, 114, 114]);
    }
    #[test]
    fn a_blur_spreads_a_picture_softly() {
        let pic = solid(10, 10, [255, 255, 255, 255]);
        let out = draw(30, 30, [0, 0, 0], &[pic], &[Layer { src: 0, alpha: 1.0, m: [1.0, 0.0, 0.0, 1.0, 10.0, 10.0], rect: [0.0, 0.0, 10.0, 10.0], look: None, fill: None, filter: Some(Filter { blur: 2.0, bright: 1.0, sat: 1.0 }), grade: None, ink: None, mask: None }]);
        let at = |x: usize, y: usize| out[(y * 30 + x) * 4];
        assert!(at(15, 15) > 240, "the middle stays white: {}", at(15, 15));
        assert!((100..160).contains(&at(10, 15)), "half at the edge: {}", at(10, 15));
        assert!(at(6, 15) > 0 && at(6, 15) < 30, "a little spills out: {}", at(6, 15));
    }
    #[test]
    fn a_fine_pattern_made_smaller_averages_to_grey() {
        let mut pic = solid(64, 64, [0, 0, 0, 255]);
        for y in 0..64 { for x in 0..64 { if (x + y) % 2 == 0 { let o = (y * 64 + x) * 4; pic.rgba[o..o + 3].copy_from_slice(&[255, 255, 255]); } } }
        let out = draw(16, 16, [0, 0, 0], &[pic], &[Layer { src: 0, alpha: 1.0, m: [0.25, 0.0, 0.0, 0.25, 0.0, 0.0], rect: [0.0, 0.0, 64.0, 64.0], look: None, fill: None, filter: None, grade: None, ink: None, mask: None }]);
        for px in out.chunks(4) { assert!((px[0] as i32 - 128).abs() <= 8, "{}", px[0]); }
    }
}

#[cfg(test)]
mod bench {
    use super::*;
    /// cargo test --release bench_draw -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench_draw() {
        let (sw, sh) = (2880usize, 1800usize);
        let pic = Picture { w: sw, h: sh, rgba: (0..sw * sh).flat_map(|i| [(i * 7) as u8, (i >> 9) as u8, 128, 255]).collect() };
        let k = 1080.0 / sh as f64 * 1.4;
        let l = Layer { src: 0, alpha: 1.0, m: [k, 0.0, 0.0, k, 960.0 - sw as f64 * k / 2.0, 540.0 - sh as f64 * k / 2.0], rect: [0.0, 0.0, sw as f64, sh as f64], look: None, fill: None, filter: None, grade: None, ink: None, mask: None };
        let t = std::time::Instant::now();
        for _ in 0..5 { let _ = draw(1920, 1080, [0, 0, 0], std::slice::from_ref(&pic), std::slice::from_ref(&l)); }
        eprintln!("draw 1080p from 2880×1800 at 1.4×: {:.1} ms", t.elapsed().as_secs_f64() * 1000.0 / 5.0);
    }
}
