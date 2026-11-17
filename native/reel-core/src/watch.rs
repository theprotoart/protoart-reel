//! Watching a video for Auto Edit and Smart Zoom (1.8): the same two jobs the JavaScript does while it plays the
//! video in the editor, done here on frames the Mac's own decoder hands over (native/reel-frames.swift), so they no
//! longer wait on playback.
//!
//!   measure(): autozoom.js measure(), line for line: how much changed since the last sample, where it changed, and
//!   where the detail is, on a small greyscale grid.
//!   Tracker: lib/pointerfind.js PointerTracker, line for line: finds the Mac's arrow pointer frame after frame. Its
//!   big searches (the whole picture, when the pointer has been lost) are split over every core.
//!
//! Same arithmetic, same order, same ties as the JavaScript, so the answers are the same (tests/rustcore.test.mjs
//! checks them against it).

use std::collections::HashMap;
use std::sync::Arc;

// ------------------------------------------------------------------ measure (autozoom.js)

#[derive(Clone, Debug, PartialEq)]
pub struct Sample { pub diff: f64, pub motion: f64, pub cx: f64, pub cy: f64, pub bbox: f64, pub dx: f64, pub dy: f64 }

pub fn measure(g: &[u8], prev: Option<&[u8]>, gw: usize, gh: usize) -> Sample {
    let (mut ex, mut ey, mut ew) = (0.0f64, 0.0f64, 0.0f64);
    for y in 1..gh.saturating_sub(1) {
        for x in 1..gw.saturating_sub(1) {
            let i = y * gw + x;
            let e = (g[i + 1] as f64 - g[i - 1] as f64).abs() + (g[i + gw] as f64 - g[i - gw] as f64).abs();
            let w = e * (1.15 - hypot(x as f64 / gw as f64 - 0.5, y as f64 / gh as f64 - 0.5));
            ex += w * x as f64; ey += w * y as f64; ew += w;
        }
    }
    let (dx, dy) = if ew > 0.0 { ((ex / ew + 0.5) / gw as f64, (ey / ew + 0.5) / gh as f64) } else { (0.5, 0.5) };
    let none = |diff: f64| Sample { diff, motion: 0.0, cx: 0.5, cy: 0.5, bbox: 1.0, dx, dy };
    let Some(prev) = prev else { return none(0.0) };
    let n = g.len();
    let d: Vec<f64> = (0..n).map(|i| (g[i] as f64 - prev[i] as f64).abs()).collect();
    let sum: f64 = d.iter().fold(0.0, |a, v| a + v);
    let mean = sum / n as f64;
    let th = 10f64.max(mean * 2.2);
    let (mut wx, mut wy, mut w, mut cells) = (0.0, 0.0, 0.0, 0usize);
    let (mut xs, mut ys) = (Vec::new(), Vec::new());
    for y in 0..gh {
        for x in 0..gw {
            let v = d[y * gw + x] - th;
            if v <= 0.0 { continue; }
            wx += v * x as f64; wy += v * y as f64; w += v; cells += 1;
            xs.push((x, v)); ys.push((y, v));
        }
    }
    if w == 0.0 { return none(mean); }
    let span = |list: &mut Vec<(usize, f64)>, size: usize| -> f64 {
        list.sort_by_key(|a| a.0); // stable, as Array.prototype.sort
        let (mut acc, mut lo, mut hi, mut got_lo) = (0.0, list[0].0, list[list.len() - 1].0, false);
        for &(p, v) in list.iter() {
            acc += v;
            if !got_lo && acc >= w * 0.1 { lo = p; got_lo = true; }
            if acc >= w * 0.9 { hi = p; break; }
        }
        (hi as f64 - lo as f64 + 1.0) / size as f64
    };
    let bbox = span(&mut xs, gw).max(span(&mut ys, gh));
    Sample { diff: mean, motion: cells as f64 / n as f64, cx: (wx / w + 0.5) / gw as f64, cy: (wy / w + 0.5) / gh as f64, bbox, dx, dy }
}

/// Math.hypot for two numbers, as V8 does it (scaled by the larger, so it matches the JavaScript to the last bit).
fn hypot(a: f64, b: f64) -> f64 {
    let (a, b) = (a.abs(), b.abs());
    let max = a.max(b);
    if max == 0.0 { return 0.0; }
    // V8: sum of (x / max)² with Kahan compensation, then sqrt × max
    let mut sum = 0.0f64;
    let mut comp = 0.0f64;
    for x in [a, b] {
        let r = x / max;
        let s = r * r - comp;
        let p = sum + s;
        comp = (p - sum) - s;
        sum = p;
    }
    sum.sqrt() * max
}

// ------------------------------------------------------------------ the pointer (lib/pointerfind.js)

const ARROW: [[f64; 2]; 7] = [[0.0, 0.0], [0.0, 15.5], [3.6, 12.2], [6.3, 18.3], [8.4, 17.4], [5.8, 11.4], [10.8, 11.4]];
const ARROW_H: f64 = 18.3;
const RIM: f64 = 1.2;
pub const SIZES: [i32; 6] = [9, 12, 16, 21, 28, 37];
pub const MIN_SCORE: f64 = 0.88;
const PHASES: [[f64; 2]; 4] = [[0.0, 0.0], [0.5, 0.0], [0.0, 0.5], [0.5, 0.5]];

fn seg_dist(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let (dx, dy) = (bx - ax, by - ay);
    let l = dx * dx + dy * dy;
    let k = if l != 0.0 { 0f64.max(1f64.min(((px - ax) * dx + (py - ay) * dy) / l)) } else { 0.0 };
    hypot(px - ax - k * dx, py - ay - k * dy)
}
fn inside_poly(px: f64, py: f64, poly: &[[f64; 2]]) -> bool {
    let mut inn = false;
    let mut j = poly.len() - 1;
    for i in 0..poly.len() {
        let ([xi, yi], [xj, yj]) = (poly[i], poly[j]);
        if (yi > py) != (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi { inn = !inn; }
        j = i;
    }
    inn
}

pub struct Shape { px: Vec<(i32, i32, f64)>, key: Vec<(i32, i32)>, light_key: Vec<(i32, i32)>, w: i32, h: i32, m: i32 }

pub fn arrow_shape(h: i32, ox: f64, oy: f64) -> Shape {
    let k = h as f64 / ARROW_H;
    let poly: Vec<[f64; 2]> = ARROW.iter().map(|&[x, y]| [ox + x * k, oy + y * k]).collect();
    let rim_w = 0.9f64.max(RIM * k);
    let w = (11.0 * k + rim_w + 1.0).ceil() as i32;
    let hh = (h as f64 + rim_w + 1.0).ceil() as i32;
    let m = rim_w.ceil() as i32 + 1;
    let mut px = Vec::new();
    for dy in -m..=hh {
        for dx in -m..=w {
            let (mut body, mut rim) = (0, 0);
            for sy in 0..4 {
                for sx in 0..4 {
                    let (cx, cy) = (dx as f64 + (sx as f64 + 0.5) / 4.0, dy as f64 + (sy as f64 + 0.5) / 4.0);
                    if inside_poly(cx, cy, &poly) { body += 1; continue; }
                    let mut d = f64::INFINITY;
                    for i in 0..poly.len() {
                        let (a, b) = (poly[i], poly[(i + 1) % poly.len()]);
                        d = d.min(seg_dist(cx, cy, a[0], a[1], b[0], b[1]));
                    }
                    if d <= rim_w { rim += 1; }
                }
            }
            if body + rim == 16 { px.push((dx, dy, rim as f64 / 16.0)); }
        }
    }
    let mut key: Vec<(i32, i32, f64)> = px.iter().copied().filter(|q| q.2 <= 0.1).collect();
    key.sort_by_key(|a| a.0 + a.1);
    let key = key.into_iter().take(3).map(|q| (q.0, q.1)).collect();
    let rims: Vec<(i32, i32, f64)> = px.iter().copied().filter(|q| q.2 >= 0.75).collect();
    let pick = |f: &dyn Fn(&(i32, i32, f64)) -> f64| -> (i32, i32) {
        let mut a = rims[0];
        for b in &rims[1..] { if f(b) < f(&a) { a = *b; } }
        (a.0, a.1)
    };
    let light_key = if rims.is_empty() { vec![] } else {
        vec![
            pick(&|q| q.1 as f64 - q.0 as f64 * 0.2),
            pick(&|q| q.0 as f64 + (q.1 as f64 - hh as f64 * 0.5).abs()),
            pick(&|q| -(q.1 as f64) - q.0 as f64),
        ]
    };
    Shape { px, key, light_key, w, h: hh, m }
}

pub fn arrow_score(g: &[u8], ww: i32, hh: i32, x: i32, y: i32, s: &Shape) -> f64 {
    if x < s.m || y < s.m || x + s.w >= ww || y + s.h >= hh { return -1.0; }
    let at = |dx: i32, dy: i32| g[((y + dy) * ww + x + dx) as usize] as f64;
    let mut kd = 0.0f64;
    for &(dx, dy) in &s.key { let v = at(dx, dy); if v > 110.0 { return -1.0; } kd = kd.max(v); }
    let need = kd + if s.h < 14 { 35.0 } else { 70.0 };
    for &(dx, dy) in &s.light_key { if at(dx, dy) < need { return -1.0; } }
    let (mut n, mut sa, mut sb, mut saa, mut sbb, mut sab) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let (mut dark, mut light, mut nd, mut nl) = (0.0f64, 0.0f64, 0u32, 0u32);
    for &(dx, dy, v) in &s.px {
        let a = at(dx, dy);
        n += 1.0; sa += a; sb += v; saa += a * a; sbb += v * v; sab += a * v;
        if v <= 0.25 { dark += a; nd += 1; } else if v >= 0.75 { light += a; nl += 1; }
    }
    if nd == 0 || nl == 0 || light / (nl as f64) - dark / (nd as f64) < 90.0 { return -1.0; }
    let cov = sab - (sa * sb) / n;
    let va = saa - (sa * sa) / n;
    let vb = sbb - (sb * sb) / n;
    if va > 0.0 && vb > 0.0 { cov / (va * vb).sqrt() } else { -1.0 }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hit { pub x: f64, pub y: f64, pub size: i32, pub score: f64 }

/// Every arrow shape a search can ask for, made once (they're shared by every thread).
pub struct Shapes { map: HashMap<(i32, u64, u64), Arc<Shape>> }
impl Shapes {
    pub fn new() -> Shapes { Shapes { map: HashMap::new() } }
    pub fn get(&mut self, h: i32, ox: f64, oy: f64) -> Arc<Shape> {
        self.map.entry((h, ox.to_bits(), oy.to_bits())).or_insert_with(|| Arc::new(arrow_shape(h, ox, oy))).clone()
    }
}

fn phases(h: i32, rough: bool, step: i32) -> Vec<[f64; 2]> {
    if rough || step > 1 { return vec![[0.25, 0.25]]; }
    if h < 14 {
        let q = [0.0, 0.25, 0.5, 0.75];
        return q.iter().flat_map(|&y| q.iter().map(move |&x| [x, y])).collect();
    }
    PHASES.to_vec()
}

/// searchBox(): the best arrow with its tip in the box. Big boxes are split into bands of rows, one per core; the
/// bands are put back together in order, so the first best wins as it does going row by row.
#[allow(clippy::too_many_arguments)]
pub fn search_box(shapes: &mut Shapes, g: &[u8], ww: i32, hh: i32, x0: f64, y0: f64, x1: f64, y1: f64, sizes: &[i32], step: i32, floor: f64, rough: bool) -> Option<Hit> {
    let x0 = 1i32.max(x0.floor() as i32);
    let y0 = 1i32.max(y0.floor() as i32);
    let x1 = (ww - 2).min(x1.ceil() as i32);
    let y1 = (hh - 2).min(y1.ceil() as i32);
    let mut best: Option<Hit> = None;
    if x1 < x0 || y1 < y0 { return None; }
    let rows = ((y1 - y0) / step + 1) as usize;
    let cols = ((x1 - x0) / step + 1) as usize;
    let threads = if rows * cols >= 40_000 { cores().min(rows).max(1) } else { 1 };
    for &h in sizes {
        for [ox, oy] in phases(h, rough, step) {
            let s = shapes.get(h, ox, oy);
            let band = |r0: usize, r1: usize, floor: f64| -> Option<Hit> {
                let mut b: Option<Hit> = None;
                for r in r0..r1 {
                    let y = y0 + r as i32 * step;
                    let mut x = x0;
                    while x <= x1 {
                        let sc = arrow_score(g, ww, hh, x, y, &s);
                        if sc > b.map_or(floor, |b| b.score) { b = Some(Hit { x: x as f64 + ox, y: y as f64 + oy, size: h, score: sc }); }
                        x += step;
                    }
                }
                b
            };
            let cur = best.map_or(floor, |b| b.score);
            let found: Vec<Option<Hit>> = if threads == 1 { vec![band(0, rows, cur)] } else {
                let per = rows.div_ceil(threads);
                std::thread::scope(|sc| {
                    let hs: Vec<_> = (0..threads).map(|i| { let band = &band; sc.spawn(move || band(i * per, ((i + 1) * per).min(rows), cur)) }).collect();
                    hs.into_iter().map(|h| h.join().unwrap()).collect()
                })
            };
            for b in found.into_iter().flatten() {
                if b.score > best.map_or(floor, |x| x.score) { best = Some(b); }
            }
        }
    }
    best
}

fn cores() -> usize { std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).min(16) }

fn near(h: i32) -> Vec<i32> {
    let i = SIZES.iter().position(|&x| x == h).map(|i| i as i64).unwrap_or(-1);
    SIZES.iter().enumerate().filter(|(k, _)| (*k as i64 - i).abs() <= 1).map(|(_, &x)| x).collect()
}

struct Spot { x0: f64, y0: f64, x1: f64, y1: f64 }

pub struct Tracker {
    pub w: i32, pub h: i32,
    prev: Option<Vec<u8>>, last: Option<Hit>, size: Option<i32>,
    lost_for: u64, since_full: u64,
    pub found: Vec<(f64, f64, f64)>, pub frames: u64,
    shapes: Shapes,
}

const NEVER: u64 = u64::MAX / 4; // the JavaScript's Infinity

impl Tracker {
    pub fn new(w: i32, h: i32) -> Tracker {
        Tracker { w, h, prev: None, last: None, size: None, lost_for: NEVER, since_full: NEVER, found: vec![], frames: 0, shapes: Shapes::new() }
    }

    fn moved(&self, g: &[u8]) -> Vec<Spot> {
        let Some(prev) = &self.prev else { return vec![] };
        let (w, h) = (self.w as usize, self.h as usize);
        const C: usize = 8;
        let (cw, ch) = (w.div_ceil(C), h.div_ceil(C));
        let mut cells = vec![0u8; cw * ch];
        for y in (0..h).step_by(2) {
            for x in (0..w).step_by(2) {
                if (g[y * w + x] as i32 - prev[y * w + x] as i32).abs() > 28 { cells[(y / C) * cw + x / C] = 1; }
            }
        }
        let mut out = vec![];
        let mut seen = vec![0u8; cw * ch];
        for i in 0..cells.len() {
            if cells[i] == 0 || seen[i] != 0 { continue; }
            let (mut x0, mut y0, mut x1, mut y1, mut n) = (usize::MAX, usize::MAX, 0usize, 0usize, 0);
            let mut any = false;
            let mut st = vec![i];
            seen[i] = 1;
            while let Some(j) = st.pop() {
                let (cx, cy) = (j % cw, j / cw);
                n += 1; any = true;
                x0 = x0.min(cx); y0 = y0.min(cy); x1 = x1.max(cx); y1 = y1.max(cy);
                for (ax, ay) in [(1i64, 0i64), (-1, 0), (0, 1), (0, -1)] {
                    let (nx, ny) = (cx as i64 + ax, cy as i64 + ay);
                    if nx >= 0 && ny >= 0 && (nx as usize) < cw && (ny as usize) < ch {
                        let k = ny as usize * cw + nx as usize;
                        if cells[k] != 0 && seen[k] == 0 { seen[k] = 1; st.push(k); }
                    }
                }
                if n > 400 { break; }
            }
            if any && x1 - x0 < 7 && y1 - y0 < 7 {
                out.push(Spot { x0: (x0 * C) as f64, y0: (y0 * C) as f64, x1: ((x1 + 1) * C) as f64, y1: ((y1 + 1) * C) as f64 });
            }
        }
        out.truncate(24);
        out
    }

    fn find(&mut self, g: &[u8], x0: f64, y0: f64, x1: f64, y1: f64, sizes: &[i32]) -> Option<Hit> {
        let (w, h) = (self.w, self.h);
        let rough = search_box(&mut self.shapes, g, w, h, x0, y0, x1, y1, sizes, 1, 0.5, true)?;
        search_box(&mut self.shapes, g, w, h, rough.x - 3.0, rough.y - 3.0, rough.x + 2.0, rough.y + 2.0, &near(rough.size), 1, 0.0, false)
    }

    /// One frame (W × H greyscale) at media time t. Returns the tip (0..1 of the frame) or None.
    pub fn push(&mut self, t: f64, g: &[u8]) -> Option<(f64, f64)> {
        let (w, h) = (self.w, self.h);
        let sizes: Vec<i32> = match self.size { Some(s) => near(s), None => SIZES.to_vec() };
        let moved = self.moved(g);
        let mut best: Option<Hit> = None;
        let take = |best: &mut Option<Hit>, b: Option<Hit>| {
            if let Some(b) = b { if b.score >= MIN_SCORE && best.map_or(true, |x| b.score > x.score) { *best = Some(b); } }
        };
        let last = self.last;
        let r = last.map_or(0.0, |l| 6.0 + l.size as f64 * 1.2);
        if let (Some(l), Some(_)) = (last, &self.prev) {
            if !moved.iter().any(|b| b.x1 > l.x - r && b.x0 < l.x + r && b.y1 > l.y - r && b.y0 < l.y + r) {
                let sh = self.shapes.get(l.size, l.x % 1.0, l.y % 1.0);
                let sc = arrow_score(g, w, h, l.x.floor() as i32, l.y.floor() as i32, &sh);
                if sc >= MIN_SCORE { best = Some(Hit { score: sc, ..l }); }
            }
        }
        if best.is_none() {
            if let Some(l) = last { let b = self.find(g, l.x - r, l.y - r, l.x + r, l.y + r, &sizes); take(&mut best, b); }
            for b in &moved {
                let m = self.size.unwrap_or(37) as f64 + 2.0;
                let f = self.find(g, b.x0 - m, b.y0 - m, b.x1, b.y1, &sizes);
                take(&mut best, f);
            }
        }
        if best.is_none() && self.lost_for >= 3 && self.since_full >= 4 {
            self.since_full = 0;
            let f = self.find(g, 1.0, 1.0, (w - 2) as f64, (h - 2) as f64, &SIZES);
            take(&mut best, f);
        } else {
            self.since_full = self.since_full.saturating_add(1);
        }
        self.prev = Some(g.to_vec());
        self.frames += 1;
        let Some(b) = best else {
            self.lost_for = self.lost_for.saturating_add(1);
            if self.lost_for > 15 { self.size = None; }
            return None;
        };
        if let Some(l) = last { if l.size == b.size { self.size = Some(b.size); } }
        self.last = Some(b);
        self.lost_for = 0;
        self.found.push((t, b.x, b.y));
        Some((b.x / w as f64, b.y / h as f64))
    }
}

// ------------------------------------------------------------------ the stream

/// What a watch job asks for. Frames follow: t f64 · flags u8 (1: a sample frame) · gw × gh grid bytes · and, on a
/// sample frame when pw > 0, pw × ph bytes for the pointer.
pub struct Watch { pub gw: usize, pub gh: usize, pub pw: usize, pub ph: usize, pub give_up: f64 }

pub struct Watcher {
    pub job: Watch,
    prev_sample: Option<Vec<u8>>,
    last_sample_t: Option<f64>,
    jump: Option<f64>,
    pub samples: Vec<(f64, Sample, Option<f64>)>,
    pub tracker: Option<Tracker>,
    pub pointer_none: bool,
    pub frames: u64,
}

impl Watcher {
    pub fn new(job: Watch) -> Watcher {
        let tracker = if job.pw > 0 { Some(Tracker::new(job.pw as i32, job.ph as i32)) } else { None };
        Watcher { job, prev_sample: None, last_sample_t: None, jump: None, samples: vec![], tracker, pointer_none: false, frames: 0 }
    }
    /// One decoded frame. grid: gw × gh; pointer: the bigger picture on a sample frame (when asked for).
    pub fn frame(&mut self, t: f64, sample: bool, grid: &[u8], pointer: Option<&[u8]>) {
        self.frames += 1;
        // the first frame since the last sample that looks quite different from it: where a cut is, to the frame
        if self.jump.is_none() {
            if let Some(p) = &self.prev_sample {
                let d = grid.iter().zip(p).fold(0u64, |a, (x, y)| a + (*x as i32 - *y as i32).unsigned_abs() as u64) as f64 / grid.len() as f64;
                if d > 20.0 { self.jump = Some(t); }
            }
        }
        if !sample { return; }
        let s = measure(grid, self.prev_sample.as_deref(), self.job.gw, self.job.gh);
        self.samples.push((t, s, self.jump.take()));
        self.prev_sample = Some(grid.to_vec());
        self.last_sample_t = Some(t);
        if let (Some(tr), Some(p)) = (self.tracker.as_mut(), pointer) {
            tr.push(t, p);
            if self.job.give_up > 0.0 && t > self.job.give_up && tr.found.is_empty() { self.tracker = None; self.pointer_none = true; }
        }
    }
    pub fn answer(&self) -> String {
        let f = |v: f64| { let s = format!("{:.5}", v); let s = s.trim_end_matches('0').trim_end_matches('.').to_string(); if s == "-0" { "0".into() } else { s } };
        let mut o = String::with_capacity(self.samples.len() * 80 + 64);
        o.push_str(&format!("{{\"ok\":true,\"frames\":{},\"samples\":[", self.frames));
        for (i, (t, s, j)) in self.samples.iter().enumerate() {
            if i > 0 { o.push(','); }
            o.push_str(&format!("[{},{},{},{},{},{},{},{},{}]", f(*t), f(s.diff), f(s.motion), f(s.cx), f(s.cy), f(s.bbox), f(s.dx), f(s.dy), j.map_or("null".into(), f)));
        }
        o.push(']');
        if let Some(tr) = &self.tracker {
            o.push_str(&format!(",\"pointer\":{{\"frames\":{},\"found\":[", tr.frames));
            for (i, (t, x, y)) in tr.found.iter().enumerate() {
                if i > 0 { o.push(','); }
                o.push_str(&format!("[{},{},{}]", f(*t), x, y));
            }
            o.push_str("]}");
        } else if self.pointer_none {
            o.push_str(",\"pointer\":null");
        }
        o.push('}');
        o
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn draw(w: usize, h: usize, tip: (i32, i32), size: i32) -> Vec<u8> {
        let mut g = vec![200u8; w * h];
        let s = arrow_shape(size, 0.0, 0.0);
        for &(dx, dy, v) in &s.px {
            let (x, y) = (tip.0 + dx, tip.1 + dy);
            if x >= 0 && y >= 0 && (x as usize) < w && (y as usize) < h { g[y as usize * w + x as usize] = (20.0 + v * 225.0) as u8; }
        }
        g
    }
    #[test]
    fn hypot_is_v8s() {
        assert_eq!(hypot(3.0, 4.0), 5.0);
        assert_eq!(hypot(0.0, 0.0), 0.0);
    }
    #[test]
    fn finds_and_follows_the_arrow() {
        let (w, h) = (320, 200);
        let mut tr = Tracker::new(w as i32, h as i32);
        let mut seen = 0;
        for i in 0..8 {
            let g = draw(w, h, (40 + i * 20, 60 + i * 5), 16);
            if let Some((x, y)) = tr.push(i as f64 * 0.2, &g) {
                seen += 1;
                assert!((x * w as f64 - (40 + i * 20) as f64).abs() < 1.0 && (y * h as f64 - (60 + i * 5) as f64).abs() < 1.0, "frame {i}: {x} {y}");
            }
        }
        assert!(seen >= 6, "seen {seen}");
    }
    #[test]
    fn measure_finds_the_change() {
        let (gw, gh) = (48, 27);
        let a = vec![100u8; gw * gh];
        let mut b = a.clone();
        for y in 5..9 { for x in 30..36 { b[y * gw + x] = 220; } }
        let s = measure(&b, Some(&a), gw, gh);
        assert!(s.motion > 0.0 && s.cx > 0.6 && s.cy < 0.35, "{s:?}");
        assert_eq!(measure(&a, None, gw, gh).motion, 0.0);
    }
}
