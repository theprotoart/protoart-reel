//! The built-in master (MasterChain in lib/master.js), sample for sample: input gain, balance, polarity and swap,
//! tape EQ, the tone bands, filters and presence, the compressor (with its side-chain high-pass, make-up, mix and
//! saturation), then the stereo spread and output fader. Reel sends what MasterChain worked out (coefficients, gains,
//! constants); the per-sample work runs here in the JavaScript's order and rounding.

#[derive(Clone)]
struct Bq { b0: f64, b1: f64, b2: f64, a1: f64, a2: f64, z: [[f64; 2]; 2] }
impl Bq {
    fn run(&mut self, x: &mut [f32], ch: usize) {
        let z = &mut self.z[ch];
        for v in x.iter_mut() {
            let x0 = *v as f64;
            let y = self.b0 * x0 + z[0];
            z[0] = self.b1 * x0 - self.a1 * y + z[1];
            z[1] = self.b2 * x0 - self.a2 * y;
            *v = y as f32;
        }
    }
}

pub struct Master {
    gl: f64, gr: f64, swap: bool, tape: Option<(Bq, Bq)>, order: Vec<u8>,
    tone_on: bool, tone: Vec<Bq>, filter_on: bool, hp: Vec<Bq>, pres: Option<Bq>, lp: Vec<Bq>,
    comp_on: bool, sc_hp: Vec<Bq>, atk: f64, rel: f64, ctype: u8, k: f64, make: f64, mix: f64, drive: f64,
    sg: f64, og: f64, env: f64, sc: Vec<f32>,
}

/// Reads numbers in order (the layout lib/mixplan.js masterNumbers writes).
struct Take<'a> { v: &'a [f64], at: usize }
impl Take<'_> {
    fn n(&mut self) -> Result<f64, String> { let x = *self.v.get(self.at).ok_or("bad master settings")?; self.at += 1; Ok(x) }
    fn bq(&mut self) -> Result<Bq, String> { Ok(Bq { b0: self.n()?, b1: self.n()?, b2: self.n()?, a1: self.n()?, a2: self.n()?, z: [[0.0; 2]; 2] }) }
    fn bqs(&mut self) -> Result<Vec<Bq>, String> { let c = self.n()? as usize; if c > 8 { return Err("bad master settings".into()); } (0..c).map(|_| self.bq()).collect() }
}

impl Master {
    pub fn new(v: &[f64]) -> Result<Master, String> {
        let mut t = Take { v, at: 0 };
        let (gl, gr, swap) = (t.n()?, t.n()?, t.n()? != 0.0);
        let tape = if t.n()? != 0.0 { Some((t.bq()?, t.bq()?)) } else { None };
        let no = t.n()? as usize;
        if no > 3 { return Err("bad master settings".into()); }
        let order = (0..no).map(|_| t.n().map(|x| x as u8)).collect::<Result<Vec<_>, _>>()?;
        let tone_on = t.n()? != 0.0;
        let tone = t.bqs()?;
        let filter_on = t.n()? != 0.0;
        let hp = t.bqs()?;
        let pres = { let p = t.bqs()?; p.into_iter().next() };
        let lp = t.bqs()?;
        let comp_on = t.n()? != 0.0;
        let sc_hp = t.bqs()?;
        let (atk, rel, ctype, k, make, mix, drive, sg, og) = (t.n()?, t.n()?, t.n()? as u8, t.n()?, t.n()?, t.n()?, t.n()?, t.n()?, t.n()?);
        if t.at != v.len() || v.iter().any(|x| !x.is_finite()) || ctype > 2 { return Err("bad master settings".into()); }
        Ok(Master { gl, gr, swap, tape, order, tone_on, tone, filter_on, hp, pres, lp, comp_on, sc_hp, atk, rel, ctype, k, make, mix, drive, sg, og, env: 0.0, sc: Vec::new() })
    }

    fn curve(&self, lv: f64) -> f64 {
        let mut gr = 0.0;
        match self.ctype {
            2 => { let t = -14.0; if lv > t { gr = (lv - t) * 0.95; } }
            1 => { let (t, knee) = (-26.0, 12.0); if lv > t - knee / 2.0 { let o = lv - (t - knee / 2.0); gr = if o < knee { (o * o) / (2.0 * knee) * 0.66 } else { (o - knee / 2.0) * 0.66 }; } }
            _ => { let (t, knee) = (-30.0, 18.0); if lv > t - knee / 2.0 { let o = lv - (t - knee / 2.0); gr = if o < knee { (o * o) / (2.0 * knee) * 0.5 } else { (o - knee / 2.0) * 0.5 }; } }
        }
        gr * self.k * 2.0
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let n = l.len();
        if self.swap { for i in 0..n { std::mem::swap(&mut l[i], &mut r[i]); } }
        for i in 0..n { l[i] = (l[i] as f64 * self.gl) as f32; r[i] = (r[i] as f64 * self.gr) as f32; }
        if let Some((lo, hi)) = self.tape.as_mut() { lo.run(l, 0); lo.run(r, 1); hi.run(l, 0); hi.run(r, 1); }
        for m in self.order.clone() {
            if m == 0 && self.tone_on { for b in self.tone.iter_mut() { b.run(l, 0); b.run(r, 1); } }
            if m == 2 && self.filter_on {
                for f in self.hp.iter_mut() { f.run(l, 0); f.run(r, 1); }
                if let Some(p) = self.pres.as_mut() { p.run(l, 0); p.run(r, 1); }
                for f in self.lp.iter_mut() { f.run(l, 0); f.run(r, 1); }
            }
            if m == 1 && self.comp_on { self.comp(l, r); }
        }
        for i in 0..n {
            let (a, b) = (l[i] as f64, r[i] as f64);
            let m = (a + b) * 0.5;
            let d = (a - b) * 0.5 * self.sg;
            l[i] = ((m + d) * self.og) as f32;
            r[i] = ((m - d) * self.og) as f32;
        }
    }

    fn comp(&mut self, l: &mut [f32], r: &mut [f32]) {
        let n = l.len();
        if self.sc.len() < n { self.sc.resize(n, 0.0); }
        let mut sc = std::mem::take(&mut self.sc);
        for i in 0..n { sc[i] = ((l[i] as f64 + r[i] as f64) * 0.5) as f32; }
        for f in self.sc_hp.iter_mut() { f.run(&mut sc[..n], 0); }
        let mut env = self.env;
        for i in 0..n {
            let v = (sc[i] as f64).abs();
            env = if v > env { self.atk * env + (1.0 - self.atk) * v } else { self.rel * env + (1.0 - self.rel) * v };
            let lv = 20.0 * (env + 1e-9).log10();
            let g = 10f64.powf(-self.curve(lv) / 20.0) * self.make;
            for ch in [&mut *l, &mut *r] {
                let dry = ch[i] as f64;
                let mut wet = dry * g;
                if self.drive > 1.0 { wet = (wet * self.drive).tanh() / self.drive; }
                ch[i] = (dry * (1.0 - self.mix) + wet * self.mix) as f32;
            }
        }
        self.env = env;
        self.sc = sc;
    }
}
