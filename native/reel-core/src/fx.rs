//! The track and mix-bus effects (lib/trackfx.js), sample for sample: EQ, compressor, de-esser, gate, reverb, delay,
//! limiter, Auto Level, gain and de-click. Reel works out each effect's settings and coefficients exactly as its
//! `update` does and sends the numbers, so only the per-sample work is done here, in the JavaScript's order and with
//! its rounding (every stored sample is a 32-bit float; state is 64-bit).

#[derive(Clone)]
pub struct Bq { b0: f64, b1: f64, b2: f64, a1: f64, a2: f64, flat: bool, z: [[f64; 2]; 2] }
impl Bq {
    fn from(v: &[f64]) -> Bq { Bq { flat: v[0] != 0.0, b0: v[1], b1: v[2], b2: v[3], a1: v[4], a2: v[5], z: [[0.0; 2]; 2] } }
    fn run(&mut self, x: &mut [f32], ch: usize) {
        let (b0, b1, b2, a1, a2) = (self.b0, self.b1, self.b2, self.a1, self.a2);
        let z = &mut self.z[ch];
        for v in x.iter_mut() {
            let x0 = *v as f64;
            let y = b0 * x0 + z[0];
            z[0] = b1 * x0 - a1 * y + z[1];
            z[1] = b2 * x0 - a2 * y;
            *v = y as f32;
        }
    }
}

#[inline] fn f(x: f64) -> f32 { x as f32 }
#[inline] fn dbg(d: f64) -> f64 { 10f64.powf(d / 20.0) }

pub struct Comb { buf: Vec<f32>, i: usize, store: f64 }

pub enum Unit {
    Eq { hp_on: bool, f: Vec<Bq> },
    Comp { t: f64, ratio: f64, at: f64, rel: f64, mk: f64, env: f64 },
    DeEss { bp: Bq, at: f64, rel: f64, t: f64, max: f64, env: f64, tmp: Vec<f32> },
    Gate { at: f64, rel: f64, floor: f64, lvc: f64, thr: f64, g: f64, lv: f64 },
    Reverb { c: [Vec<Comb>; 2], a: [Vec<Comb>; 2], fb: f64, damp: f64, mix: f64, width: f64 },
    Delay { buf: [Vec<f32>; 2], i: usize, n: usize, lp: [f64; 2], fb: f64, mix: f64 },
    Limiter { ceil: f64, rel: f64, g: f64 },
    Level { a: f64, target: f64, boost: f64, cut: f64, gate: f64, k: f64, env: f64, gdb: f64, prev: f64 },
    Gain { g: f64, mono: bool },
    DeClick { thr: f64, len: i64, bl: Vec<f32>, br: Vec<f32>, w: i64, env: f64, x1: f64, x2: f64, regions: std::collections::VecDeque<(i64, i64)> },
}

impl Unit {
    /// One effect from its type number and the numbers Reel sends for it (see fxUnitNumbers in lib/mixplan.js).
    pub fn new(kind: u8, v: &[f64]) -> Result<Unit, String> {
        let need = |n: usize| if v.len() == n { Ok(()) } else { Err(format!("bad effect settings ({kind})")) };
        Ok(match kind {
            0 => { need(1 + 5 * 6)?; Unit::Eq { hp_on: v[0] != 0.0, f: (0..5).map(|k| Bq::from(&v[1 + k * 6..7 + k * 6])).collect() } }
            1 => { need(5)?; Unit::Comp { t: v[0], ratio: v[1], at: v[2], rel: v[3], mk: v[4], env: 0.0 } }
            2 => { need(10)?; Unit::DeEss { bp: Bq::from(&v[0..6]), at: v[6], rel: v[7], t: v[8], max: v[9], env: 0.0, tmp: Vec::new() } }
            3 => { need(5)?; Unit::Gate { at: v[0], rel: v[1], floor: v[2], lvc: v[3], thr: v[4], g: 1.0, lv: 0.0 } }
            4 => {
                need(24 + 4)?;
                let len = |k: usize| -> Result<usize, String> { let n = v[k]; if n >= 1.0 && n <= 100000.0 { Ok(n as usize) } else { Err("bad reverb".into()) } };
                let mk = |n: usize| Comb { buf: vec![0.0; n], i: 0, store: 0.0 };
                let mut c: [Vec<Comb>; 2] = [Vec::new(), Vec::new()];
                let mut a: [Vec<Comb>; 2] = [Vec::new(), Vec::new()];
                for ch in 0..2 { for k in 0..8 { c[ch].push(mk(len(ch * 8 + k)?)); } for k in 0..4 { a[ch].push(mk(len(16 + ch * 4 + k)?)); } }
                Unit::Reverb { c, a, fb: v[24], damp: v[25], mix: v[26], width: v[27] }
            }
            5 => {
                need(4)?;
                let (big, n) = (v[0] as usize, v[1] as usize);
                if !(2..=1_000_000).contains(&big) || n < 1 || n >= big { return Err("bad delay".into()); }
                Unit::Delay { buf: [vec![0.0; big], vec![0.0; big]], i: 0, n, lp: [0.0; 2], fb: v[2], mix: v[3] }
            }
            6 => { need(2)?; Unit::Limiter { ceil: v[0], rel: v[1], g: 1.0 } }
            7 => { need(6)?; Unit::Level { a: v[0], target: v[1], boost: v[2], cut: v[3], gate: v[4], k: v[5], env: 0.0, gdb: 0.0, prev: -120.0 } }
            8 => { need(2)?; Unit::Gain { g: v[0], mono: v[1] != 0.0 } }
            9 => { need(2)?; Unit::DeClick { thr: v[0], len: v[1] as i64, bl: vec![0.0; 4096], br: vec![0.0; 4096], w: 0, env: 1e-4, x1: 0.0, x2: 0.0, regions: Default::default() } }
            _ => return Err(format!("unknown effect ({kind})")),
        })
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let n = l.len();
        match self {
            Unit::Eq { hp_on, f } => {
                for (k, q) in f.iter_mut().enumerate() { if if k == 0 { !*hp_on } else { q.flat } { continue; } q.run(l, 0); q.run(r, 1); }
            }
            Unit::Comp { t, ratio, at, rel, mk, env } => {
                let knee = 6.0;
                let mut e = *env;
                for i in 0..n {
                    let x = (l[i] as f64).abs().max((r[i] as f64).abs());
                    let xd = 20.0 * (x + 1e-9).log10();
                    let over = xd - *t;
                    let want = if over <= -knee / 2.0 { 0.0 } else if over >= knee / 2.0 { over * (1.0 - 1.0 / *ratio) } else { let q = over + knee / 2.0; (q * q / (2.0 * knee)) * (1.0 - 1.0 / *ratio) };
                    e = if want > e { *at * e + (1.0 - *at) * want } else { *rel * e + (1.0 - *rel) * want };
                    let g = dbg(-e) * *mk;
                    l[i] = f(l[i] as f64 * g); r[i] = f(r[i] as f64 * g);
                }
                *env = e;
            }
            Unit::DeEss { bp, at, rel, t, max, env, tmp } => {
                if tmp.len() < n { tmp.resize(n, 0.0); }
                for i in 0..n { tmp[i] = f((l[i] as f64 + r[i] as f64) / 2.0); }
                bp.run(&mut tmp[..n], 0);
                let mut e = *env;
                for i in 0..n {
                    let lv = 20.0 * ((tmp[i] as f64).abs() + 1e-9).log10();
                    let want = max.min((lv - *t).max(0.0) * 0.7);
                    e = if want > e { *at * e + (1.0 - *at) * want } else { *rel * e + (1.0 - *rel) * want };
                    let g = dbg(-e);
                    l[i] = f(l[i] as f64 * g); r[i] = f(r[i] as f64 * g);
                }
                *env = e;
            }
            Unit::Gate { at, rel, floor, lvc, thr, g, lv } => {
                let (mut gg, mut ll) = (*g, *lv);
                for i in 0..n {
                    let x = (l[i] as f64).abs().max((r[i] as f64).abs());
                    ll = if x > ll { x } else { *lvc * ll + (1.0 - *lvc) * x };
                    let want = if ll >= *thr { 1.0 } else { *floor };
                    gg = if want > gg { *at * gg + (1.0 - *at) * want } else { *rel * gg + (1.0 - *rel) * want };
                    l[i] = f(l[i] as f64 * gg); r[i] = f(r[i] as f64 * gg);
                }
                *g = gg; *lv = ll;
            }
            Unit::Reverb { c, a, fb, damp, mix, width } => {
                let (fb, d, mix) = (*fb, *damp, *mix);
                let (w1, w2) = ((1.0 + *width) / 2.0, (1.0 - *width) / 2.0);
                for i in 0..n {
                    let inp = (l[i] as f64 + r[i] as f64) * 0.015;
                    let mut out = [0.0f64; 2];
                    for ch in 0..2 {
                        let mut s = 0.0f64;
                        for cb in c[ch].iter_mut() {
                            let y = cb.buf[cb.i] as f64;
                            cb.store = y * (1.0 - d) + cb.store * d;
                            cb.buf[cb.i] = f(inp + cb.store * fb);
                            cb.i += 1; if cb.i >= cb.buf.len() { cb.i = 0; }
                            s += y;
                        }
                        for ap in a[ch].iter_mut() {
                            let y = ap.buf[ap.i] as f64;
                            let o = -s + y;
                            ap.buf[ap.i] = f(s + y * 0.5);
                            ap.i += 1; if ap.i >= ap.buf.len() { ap.i = 0; }
                            s = o;
                        }
                        out[ch] = s;
                    }
                    let wl = out[0] * w1 + out[1] * w2;
                    let wr = out[1] * w1 + out[0] * w2;
                    l[i] = f(l[i] as f64 * (1.0 - mix * 0.5) + wl * mix * 3.0);
                    r[i] = f(r[i] as f64 * (1.0 - mix * 0.5) + wr * mix * 3.0);
                }
            }
            Unit::Delay { buf, i: at, n: dn, lp, fb, mix } => {
                let big = buf[0].len();
                for k in 0..n {
                    let j = (*at + big - *dn) % big;
                    for ch in 0..2 {
                        let x = if ch == 1 { &mut r[k] } else { &mut l[k] };
                        let y = buf[ch][j] as f64;
                        lp[ch] = lp[ch] * 0.3 + y * 0.7;
                        buf[ch][*at] = f(*x as f64 + lp[ch] * *fb);
                        *x = f(*x as f64 + y * *mix);
                    }
                    *at += 1; if *at >= big { *at = 0; }
                }
            }
            Unit::Limiter { ceil, rel, g } => {
                let mut gg = *g;
                for i in 0..n {
                    let x = (l[i] as f64).abs().max((r[i] as f64).abs());
                    let want = if x * gg > *ceil { *ceil / x } else { 1.0 };
                    gg = if want < gg { want } else { *rel * gg + (1.0 - *rel) * want.min(1.0) };
                    l[i] = f(l[i] as f64 * gg); r[i] = f(r[i] as f64 * gg);
                }
                *g = gg;
            }
            Unit::Level { a, target, boost, cut, gate, k, env, gdb, prev } => {
                let (mut e, mut gd) = (*env, *gdb);
                let mut s = 0;
                while s < n {
                    let end = n.min(s + 64);
                    for i in s..end { let (x, y) = (l[i] as f64, r[i] as f64); let v = (x * x + y * y) * 0.5; e = *a * e + (1.0 - *a) * v; }
                    let lev = 10.0 * (e + 1e-12).log10();
                    let falling = lev < *prev - 0.004;
                    *prev = lev;
                    if lev > *gate && !falling {
                        let want = (-*cut).max(boost.min(*target - lev));
                        gd = *k * gd + (1.0 - *k) * want;
                    }
                    let g = 10f64.powf(gd / 20.0);
                    for i in s..end { l[i] = f(l[i] as f64 * g); r[i] = f(r[i] as f64 * g); }
                    s += 64;
                }
                *env = e; *gdb = gd;
            }
            Unit::Gain { g, mono } => {
                for i in 0..n {
                    if *mono { let m = (l[i] as f64 + r[i] as f64) / 2.0; l[i] = f(m); r[i] = f(m); }
                    l[i] = f(l[i] as f64 * *g); r[i] = f(r[i] as f64 * *g);
                }
            }
            Unit::DeClick { thr, len, bl, br, w, env, x1, x2, regions } => {
                const M: i64 = 4095; const D: i64 = 64;
                for i in 0..n {
                    let wv = *w;
                    bl[(wv & M) as usize] = l[i]; br[(wv & M) as usize] = r[i];
                    let x = (l[i] as f64 + r[i] as f64) * 0.5;
                    let d = (x - 2.0 * *x1 + *x2).abs();
                    *x2 = *x1; *x1 = x;
                    if d > *thr * *env && d > 2e-3 {
                        let (s, e) = (wv - 3, wv + *len);
                        match regions.back_mut() {
                            Some(last) if s <= last.1 + 2 => { last.1 = last.1.max(e).min(last.0 + 50); }
                            _ => regions.push_back((s, e)),
                        }
                    }
                    *env = *env * 0.998 + d.min(*thr * *env + 1e-4) * 0.002;
                    *w = wv + 1;
                    let o = wv - D;
                    if o < 0 { l[i] = 0.0; r[i] = 0.0; continue; }
                    while regions.front().is_some_and(|rg| rg.1 < o) { regions.pop_front(); }
                    match regions.front() {
                        Some(&(rs, re)) if o >= rs => {
                            let a0 = rs - 1;
                            let b0 = (re + 1).min(wv);
                            let t = if b0 > a0 { (o - a0) as f64 / (b0 - a0) as f64 } else { 0.0 };
                            l[i] = f(bl[(a0 & M) as usize] as f64 * (1.0 - t) + bl[(b0 & M) as usize] as f64 * t);
                            r[i] = f(br[(a0 & M) as usize] as f64 * (1.0 - t) + br[(b0 & M) as usize] as f64 * t);
                            bl[(o & M) as usize] = l[i]; br[(o & M) as usize] = r[i];
                        }
                        _ => { l[i] = bl[(o & M) as usize]; r[i] = br[(o & M) as usize]; }
                    }
                }
            }
        }
    }
}

/// A chain of effects, run in order over 512-sample pieces as the JavaScript export does.
pub struct Chain { pub units: Vec<Unit> }
impl Chain {
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let n = l.len();
        let mut p = 0;
        while p < n {
            let e = n.min(p + 512);
            for u in self.units.iter_mut() { u.process(&mut l[p..e], &mut r[p..e]); }
            p = e;
        }
    }
}
