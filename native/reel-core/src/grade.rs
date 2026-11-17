//! A clip's filters (1.7): the colour work lib/glfx.js does in one GPU pass, done here the same way, line for line:
//! colour match, levels, exposure, highlights and shadows, contrast, temperature and tint, the colour wheels,
//! saturation and vibrance, black and white, vignette, sharpen, chromatic aberration and green-screen keying. Like
//! the editor, the picture is first brought to the size it's shown at (`gw` × `gh`, sampled as the GPU samples a
//! texture: bilinear, edges held), and each pixel kept to 8 bits at the end. (A LUT file or a background-removal
//! matte isn't done here: those frames stay with the JavaScript.)

use crate::frame::Picture;

pub struct Grade {
    pub gw: usize, pub gh: usize,
    pub exposure: f64, pub contrast: f64, pub saturation: f64, pub vibrance: f64, pub temperature: f64, pub tint: f64,
    pub highlights: f64, pub shadows: f64,
    pub in_black: f64, pub in_white: f64, pub gamma_v: f64, pub out_black: f64, pub out_white: f64, pub brightness: f64,
    pub sharpen: f64, pub vignette: f64, pub bw: f64, pub aberr: f64,
    /// green screen: the key colour (0..1), tolerance, softness, spill
    pub key: Option<([f64; 3], f64, f64, f64)>,
    pub m_mul: [f64; 3], pub m_add: [f64; 3], pub lift: [f64; 3], pub gam: [f64; 3], pub gain: [f64; 3],
}

fn smoothstep(e0: f64, e1: f64, x: f64) -> f64 { let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0); t * t * (3.0 - 2.0 * t) }

/// texture(img, uv): RGBA 0..1 (not premultiplied, as the editor uploads it), bilinear, edges held.
fn tex(p: &Picture, u: f64, v: f64) -> [f64; 4] {
    let (x, y) = (u * p.w as f64 - 0.5, v * p.h as f64 - 0.5);
    let (x0, y0) = (x.floor(), y.floor());
    let (fx, fy) = (x - x0, y - y0);
    let at = |xi: f64, yi: f64| -> [f64; 4] {
        let (xi, yi) = ((xi as i64).clamp(0, p.w as i64 - 1) as usize, (yi as i64).clamp(0, p.h as i64 - 1) as usize);
        let o = (yi * p.w + xi) * 4;
        [p.rgba[o] as f64 / 255.0, p.rgba[o + 1] as f64 / 255.0, p.rgba[o + 2] as f64 / 255.0, p.rgba[o + 3] as f64 / 255.0]
    };
    let (a, b, c, d) = (at(x0, y0), at(x0 + 1.0, y0), at(x0, y0 + 1.0), at(x0 + 1.0, y0 + 1.0));
    let mut o = [0.0; 4];
    for k in 0..4 { o[k] = (a[k] * (1.0 - fx) + b[k] * fx) * (1.0 - fy) + (c[k] * (1.0 - fx) + d[k] * fx) * fy; }
    o
}

fn ycbcr(c: [f64; 3]) -> [f64; 3] {
    [0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2], -0.169 * c[0] - 0.331 * c[1] + 0.5 * c[2], 0.5 * c[0] - 0.419 * c[1] - 0.081 * c[2]]
}

/// The picture with its filters, at the size it's shown (RGBA, 8 bits, not premultiplied).
pub fn grade(p: &Picture, g: &Grade) -> Picture {
    let (w, h) = (g.gw.max(1), g.gh.max(1));
    let (tx, ty) = (1.0 / w as f64, 1.0 / h as f64);
    let mut out = vec![0u8; w * h * 4];
    let lum = |c: [f64; 3]| c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
    for y in 0..h {
        for x in 0..w {
            let (u, v) = ((x as f64 + 0.5) / w as f64, (y as f64 + 0.5) / h as f64);
            let src = tex(p, u, v);
            let mut c = [src[0], src[1], src[2]];
            let mut a = src[3];
            if g.aberr > 0.0 {
                let (dx, dy) = ((u - 0.5) * g.aberr * 0.025, (v - 0.5) * g.aberr * 0.025);
                c = [tex(p, u + dx, v + dy)[0], c[1], tex(p, u - dx, v - dy)[2]];
            }
            if g.sharpen > 0.0 {
                let (r, l, d, t) = (tex(p, u + tx, v), tex(p, u - tx, v), tex(p, u, v + ty), tex(p, u, v - ty));
                for i in 0..3 { let blur = (r[i] + l[i] + d[i] + t[i]) * 0.25; c[i] += (c[i] - blur) * g.sharpen * 2.0; }
            }
            if let Some((k, tol, soft, spill)) = g.key {
                let (yc, kc) = (ycbcr(c), ycbcr(k));
                let dist = (yc[1] - kc[1]).hypot(yc[2] - kc[2]);
                let alpha = smoothstep(tol, tol + soft.max(0.001), dist);
                let sp = (1.0 - dist / (tol * 2.5).max(0.001)).clamp(0.0, 1.0) * spill;
                let l = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
                for i in 0..3 { c[i] = c[i] + (l - c[i]) * sp; }
                a *= alpha;
            }
            for i in 0..3 {
                c[i] = c[i] * g.m_mul[i] + g.m_add[i];
                c[i] = ((c[i] - g.in_black) / (g.in_white - g.in_black).max(0.01)).clamp(0.0, 1.0);
                c[i] = c[i].powf(1.0 / g.gamma_v.max(0.05));
                c[i] = g.out_black + c[i] * (g.out_white - g.out_black) + g.brightness;
                c[i] *= g.exposure.exp2();
            }
            let l = lum(c);
            let (sh, hi) = (g.shadows * 0.5 * (1.0 - smoothstep(0.0, 0.5, l)) * (1.0 - l), g.highlights * 0.5 * smoothstep(0.5, 1.0, l) * l);
            for i in 0..3 { c[i] += sh + hi; c[i] = (c[i] - 0.5) * (1.0 + g.contrast) + 0.5; }
            c[0] += g.temperature * 0.12 + g.tint * 0.06;
            c[1] += -g.tint * 0.06;
            c[2] += -g.temperature * 0.12 + g.tint * 0.06;
            for i in 0..3 {
                c[i] = g.gain[i] * (c[i] + g.lift[i] * (1.0 - c[i]));
                c[i] = c[i].max(0.0).powf(1.0 / g.gam[i].max(0.05));
            }
            let gr = lum(c);
            let sat = c[0].max(c[1]).max(c[2]) - c[0].min(c[1]).min(c[2]);
            let k = 1.0 + g.saturation + g.vibrance * (1.0 - sat);
            for i in 0..3 { c[i] = gr + (c[i] - gr) * k; }
            if g.bw > 0.0 { let l = lum(c); for i in 0..3 { c[i] += (l - c[i]) * g.bw; } }
            if g.vignette > 0.0 {
                let d = ((u - 0.5).hypot(v - 0.5)) * 1.3;
                let f = 1.0 - g.vignette * smoothstep(0.25, 0.85, d);
                for i in 0..3 { c[i] *= f; }
            }
            let o = (y * w + x) * 4;
            for i in 0..3 { out[o + i] = (c[i].clamp(0.0, 1.0) * 255.0).round() as u8; }
            out[o + 3] = (a.clamp(0.0, 1.0) * 255.0).round() as u8;
        }
    }
    Picture { w, h, rgba: out }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn plain() -> Grade {
        Grade { gw: 2, gh: 2, exposure: 0.0, contrast: 0.0, saturation: 0.0, vibrance: 0.0, temperature: 0.0, tint: 0.0, highlights: 0.0, shadows: 0.0,
            in_black: 0.0, in_white: 1.0, gamma_v: 1.0, out_black: 0.0, out_white: 1.0, brightness: 0.0, sharpen: 0.0, vignette: 0.0, bw: 0.0, aberr: 0.0,
            key: None, m_mul: [1.0; 3], m_add: [0.0; 3], lift: [0.0; 3], gam: [1.0; 3], gain: [1.0; 3] }
    }
    fn solid(c: [u8; 4]) -> Picture { Picture { w: 2, h: 2, rgba: (0..4).flat_map(|_| c).collect() } }
    #[test]
    fn no_filter_changes_nothing() {
        let p = solid([200, 100, 50, 255]);
        assert_eq!(grade(&p, &plain()).rgba[0..4], [200, 100, 50, 255]);
    }
    #[test]
    fn one_stop_up_doubles_and_black_and_white_is_luma() {
        let p = solid([100, 50, 20, 255]);
        let g = Grade { exposure: 1.0, ..plain() };
        assert_eq!(grade(&p, &g).rgba[0..3], [200, 100, 40]);
        let g = Grade { bw: 1.0, ..plain() };
        let l = ((100.0 * 0.2126 + 50.0 * 0.7152 + 20.0 * 0.0722) as f64).round() as u8;
        assert_eq!(grade(&p, &g).rgba[0..3], [l, l, l]);
    }
    #[test]
    fn green_is_keyed_out() {
        let p = solid([0, 208, 0, 255]);
        let g = Grade { key: Some(([0.0, 208.0 / 255.0, 0.0], 0.12, 0.08, 0.6)), ..plain() };
        assert_eq!(grade(&p, &g).rgba[3], 0);
        let q = solid([200, 60, 60, 255]);
        assert_eq!(grade(&q, &g).rgba[3], 255, "red stays");
    }
}
