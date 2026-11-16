//! The export's sound, mixed here instead of in the browser: each clip's source read (WAV in Rust, the rest through
//! Apple's decoder), resampled with the same Catmull-Rom interpolation, scaled by the gain envelope Reel worked out
//! (app/renderer/lib/mixplan.js: volume, fades, keyframes, automation, mute and solo), summed, then the mix bus
//! gain and the export's soft limit. Written as 24-bit WAV, or as AAC in an M4A by Apple's encoder.
//! The arithmetic follows mixClip / softClip / pcm24 in lib/mixplan.js step by step, so a WAV export matches.

use crate::media::{self, Source};

pub const SEG: f64 = 256.0;

pub struct Plan { pub src: usize, pub first: u64, pub last: u64, pub s0: f64, pub speed: f64, pub env: Vec<f32> }
/// The mix bus limiter (trackfx.js Limiter): no look-ahead, instant attack, smooth release. Reel sends its ceiling
/// (linear) and release coefficient, worked out on its side, so both use the very same numbers.
pub struct Limiter { pub ceil: f64, pub rel: f64, pub g: f64 }
impl Limiter {
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let mut g = self.g;
        for i in 0..l.len() {
            let x = (l[i] as f64).abs().max((r[i] as f64).abs());
            let want = if x * g > self.ceil { self.ceil / x } else { 1.0 };
            g = if want < g { want } else { self.rel * g + (1.0 - self.rel) * want.min(1.0) };
            l[i] = (l[i] as f64 * g) as f32; r[i] = (r[i] as f64 * g) as f32;
        }
        self.g = g;
    }
}

pub struct Job { pub rate: f64, pub total: u64, pub mix_gain: f64, pub limiters: Vec<(f64, f64)>, pub soft: bool, pub sources: Vec<String>, pub plans: Vec<Plan>, pub clicks: Clicks,
    /// clips that keep their pitch (0.8), and the order the clips are added in: an index below plans.len() is a
    /// plan, at or above it a stretched clip (the JavaScript adds them in the project's order; so does this)
    pub stretched: Vec<crate::stretch::Stretched>, pub order: Vec<usize>, pub win: Vec<f32>, pub tol: i64,
    /// track effects (0.9): which chain each clip in `order` goes through (None: straight into the mix), each chain's
    /// effects, and the mix bus's own chain (when it has more than limiters)
    pub chain_of: Vec<Option<usize>>, pub chains: Vec<Vec<(u8, Vec<f64>)>>, pub bus: Option<Vec<(u8, Vec<f64>)>> }

/// The live effects of a mix: one chain per track with effects, and the mix bus's.
pub struct Fx { pub tracks: Vec<crate::fx::Chain>, pub bus: Option<crate::fx::Chain> }
impl Job {
    pub fn fx(&self) -> Result<Fx, String> {
        let mk = |list: &Vec<(u8, Vec<f64>)>| -> Result<crate::fx::Chain, String> { Ok(crate::fx::Chain { units: list.iter().map(|(k, v)| crate::fx::Unit::new(*k, v)).collect::<Result<_, _>>()? }) };
        Ok(Fx { tracks: self.chains.iter().map(mk).collect::<Result<_, _>>()?, bus: self.bus.as_ref().map(mk).transpose()? })
    }
}

impl Job {
    /// Reads and stretches every clip that keeps its pitch, once, before mixing.
    pub fn prepare(&mut self) -> Result<(), String> {
        for s in self.stretched.iter_mut() {
            if s.ready { continue; }
            let path = self.sources.get(s.src).ok_or("a clip names no source")?;
            let mut lv = Live::open(path)?;
            // as export-worker.js: a0 = floor(in × source rate), n = ceil(length × source rate) + 4,
            // the resampled length ceil(length × output rate), ratio = source rate / output rate
            let sr = lv.rate;
            let a0 = (s.inn * sr).floor() as i64;
            let n = (s.src_len * sr).ceil() as i64 + 4;
            let out_n = (s.src_len * self.rate).ceil() as usize;
            if n > (sr as i64) * 60 * 60 * 3 || out_n > (self.rate as usize) * 60 * 60 * 3 { return Err("a stretched clip is too long".into()); }
            lv.start(a0)?;
            lv.cover(a0, a0 + n)?;
            let read = |x: &[f32]| -> Vec<f32> { (0..n).map(|k| Live::at(x, lv.from, a0 + k) as f32).collect() };
            let mut chans = vec![read(&lv.a)];
            if lv.stereo { chans.push(read(&lv.b)); }
            let res: Vec<Vec<f32>> = chans.iter().map(|c| crate::stretch::resample(c, sr / self.rate, out_n)).collect();
            let out = crate::stretch::stretch(&res, s.speed, &self.win, self.tol);
            s.l = out[0].clone();
            s.r = if out.len() > 1 { out[1].clone() } else { out[0].clone() };
            s.ready = true;
        }
        Ok(())
    }
}

/// Mouse-click sounds from the recorded clicks (export-worker.js mixBlock, "click sounds"): added after the mix bus,
/// before the soft limit. The JavaScript adds them block by block (`block` frames from the export's `start`, in
/// seconds), each block finding its clicks and placing them by its own rounding; this does the very same.
#[derive(Default)]
pub struct Clicks { pub start: f64, pub block: u64, pub wave: Vec<f32>, pub clips: Vec<ClickClip> }
/// One clip's clicks: its place (start, in, speed, end in seconds), the cursor file's offset, the loudness, and the
/// time of each press in the cursor file (milliseconds, in order).
pub struct ClickClip { pub start: f64, pub inn: f64, pub speed: f64, pub end: f64, pub offset: f64, pub gain: f64, pub ms: Vec<f64> }

impl Clicks {
    /// Adds the clicks that fall in frames [j0, j0 + l.len()).
    fn add(&self, rate: f64, j0: u64, l: &mut [f32], r: &mut [f32]) {
        if self.clips.is_empty() || self.wave.is_empty() || self.block == 0 { return; }
        let n = l.len() as u64;
        let mut p = j0 / self.block * self.block;
        while p < j0 + n {
            let t0 = self.start + p as f64 / rate;
            let t1 = t0 + self.block as f64 / rate;
            for c in &self.clips {
                if c.end <= t0 || c.start >= t1 { continue; }
                let s0 = c.inn + ((t0 - 0.05).max(c.start) - c.start) * c.speed;
                let s1 = c.inn + (t1.min(c.end) - c.start) * c.speed;
                let (a, b) = ((s0 + c.offset) * 1000.0, (s1 + c.offset) * 1000.0);
                for &ms in &c.ms {
                    if ms >= b { break; }
                    if ms < a { continue; }
                    let st = ms / 1000.0 - c.offset;
                    let at = ((c.start + (st - c.inn) / c.speed - t0) * rate + 0.5).floor() as i64; // Math.round
                    for (i, &w) in self.wave.iter().enumerate() {
                        let k = at + i as i64;
                        if k < 0 { continue; }
                        if k >= self.block as i64 { break; }
                        let g = p + k as u64;
                        if g < j0 || g >= j0 + n { continue; }
                        let x = (g - j0) as usize;
                        l[x] = (l[x] as f64 + w as f64 * c.gain) as f32;
                        r[x] = (r[x] as f64 + w as f64 * c.gain) as f32;
                    }
                }
            }
            p += self.block;
        }
    }
}

/// A clip being played: its own reader of the source and a window of source samples.
struct Live { src: Box<dyn Source>, rate: f64, stereo: bool, from: i64, a: Vec<f32>, b: Vec<f32>, eof: bool }

impl Live {
    fn open(path: &str) -> Result<Live, String> {
        let src = media::open(path)?;
        let (rate, ch) = (src.info().rate, src.info().channels);
        Ok(Live { src, rate, stereo: ch > 1, from: 0, a: Vec::new(), b: Vec::new(), eof: false })
    }
    /// Starts the window at source sample `at` (before the source starts there is silence).
    fn start(&mut self, at: i64) -> Result<(), String> {
        self.src.seek(at.max(0) as u64)?;
        let pre = (-at).max(0) as usize;
        self.from = at; self.a = vec![0.0; pre]; self.b = vec![0.0; pre]; self.eof = false;
        Ok(())
    }
    /// Makes the window cover source samples [lo, hi) (past the end: silence). The window always ends where the
    /// reader is, so what's read next follows on.
    fn cover(&mut self, lo: i64, hi: i64) -> Result<(), String> {
        let end = self.from + self.a.len() as i64;
        if lo < self.from || lo > end { return self.start(lo).and_then(|_| self.cover(lo, hi)); } // a jump: seek
        if lo > self.from {
            let drop = (lo - self.from) as usize;
            self.a.drain(..drop); self.b.drain(..drop);
            self.from = lo;
        }
        while !self.eof && self.from + (self.a.len() as i64) < hi {
            let want = (hi - self.from - self.a.len() as i64).max(0) as usize + 4096;
            let pcm = self.src.read(want)?;
            let n = pcm.first().map_or(0, |c| c.len());
            if n == 0 { self.eof = true; break; }
            self.a.extend_from_slice(&pcm[0]);
            self.b.extend_from_slice(if self.stereo { &pcm[1] } else { &pcm[0] });
        }
        Ok(())
    }
    #[inline]
    fn at(x: &[f32], from: i64, k: i64) -> f64 { let i = k - from; if i >= 0 && (i as usize) < x.len() { x[i as usize] as f64 } else { 0.0 } }
}

#[inline]
fn source_pos(p: &Plan, j: u64, rate: f64, src_rate: f64) -> f64 { (p.s0 + (j as f64 - p.first as f64) * (p.speed / rate)) * src_rate }

#[inline]
fn catmull(p0: f64, p1: f64, p2: f64, p3: f64, f: f64) -> f64 {
    p1 + 0.5 * f * (p2 - p0 + f * (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3 + f * (3.0 * (p1 - p2) + p3 - p0)))
}

/// The sound of output samples [j0, j0 + n), into l and r (zeroed by the caller).
/// A stretched clip's sound added for frames [j0, j0 + l.len()), block by block as export-worker.js does.
fn add_stretched(job: &Job, s: &crate::stretch::Stretched, j0: u64, l: &mut [f32], r: &mut [f32]) {
    let (b, rate, n) = (job.clicks.block.max(1), job.rate, l.len() as u64);
    let mut p = j0 / b * b;
    while p < j0 + n {
        let t0 = job.clicks.start + p as f64 / rate;
        let first = ((s.cs - t0) * rate).ceil().max(0.0) as i64;
        let last = ((s.ce - t0) * rate).floor().min(b as f64) as i64;
        let mut i = first;
        while i < last {
            let g = p + i as u64;
            if g >= j0 && g < j0 + n {
                let lt = t0 + i as f64 / rate - s.start;
                let idx = (lt * rate + 0.5).floor() as i64; // Math.round
                let e = s.gains.partition_point(|x| x.0 <= g);
                if e > 0 {
                    let (_, gain, pl, pr) = s.gains[e - 1];
                    let get = |v: &Vec<f32>| -> f64 { if idx >= 0 && (idx as usize) < v.len() { v[idx as usize] as f64 } else { 0.0 } };
                    let x = (g - j0) as usize;
                    l[x] = (l[x] as f64 + get(&s.l) * gain * pl) as f32;
                    r[x] = (r[x] as f64 + get(&s.r) * gain * pr) as f32;
                }
            }
            i += 1;
        }
        p += b;
    }
}

fn mix_block(job: &Job, live: &mut [Option<Live>], limiters: &mut [Limiter], fx: &mut Fx, j0: u64, l: &mut [f32], r: &mut [f32]) -> Result<(), String> {
    let n = l.len() as u64;
    let np = job.plans.len();
    let order: Vec<usize> = if job.order.is_empty() { (0..np).collect() } else { job.order.clone() };
    // a buffer per track with effects: its clips are mixed there, run through its chain, then added to the mix
    let mut tb: Vec<(Vec<f32>, Vec<f32>)> = (0..fx.tracks.len()).map(|_| (vec![0f32; l.len()], vec![0f32; l.len()])).collect();
    for (at, &oi) in order.iter().enumerate() {
        let (l, r): (&mut [f32], &mut [f32]) = match job.chain_of.get(at).copied().flatten() { Some(t) => { let b = &mut tb[t]; (&mut b.0, &mut b.1) } None => (&mut *l, &mut *r) };
        if oi >= np { add_stretched(job, &job.stretched[oi - np], j0, l, r); continue; }
        let (ci, p) = (oi, &job.plans[oi]);
        let (a0, b0) = (j0.max(p.first), (j0 + n).min(p.last));
        if b0 <= a0 {
            if j0 >= p.last { live[ci] = None; } // done with it: let its decoder go
            continue;
        }
        let path = job.sources.get(p.src).ok_or("a clip names no source")?;
        let fresh = live[ci].is_none();
        if fresh { live[ci] = Some(Live::open(path)?); }
        let lv = live[ci].as_mut().unwrap();
        let sr = lv.rate;
        let lo = source_pos(p, a0, job.rate, sr).floor() as i64 - 1;
        if fresh { lv.start(lo)?; }
        let hi = source_pos(p, b0 - 1, job.rate, sr).floor() as i64 + 3;
        lv.cover(lo, hi)?;
        let (fa, fb) = (lv.from, lv.from);
        let (a, b, stereo) = (&lv.a, &lv.b, lv.stereo);
        let env = &p.env;
        for j in a0..b0 {
            let pos = source_pos(p, j, job.rate, sr);
            let k = pos.floor();
            let f = pos - k;
            let k = k as i64;
            let q = (j - p.first) as f64 / SEG;
            let m = q.floor();
            let u = q - m;
            let m = m as usize * 2;
            if m + 3 >= env.len() { return Err("a clip's volume plan is too short".into()); }
            let gl = env[m] as f64 + (env[m + 2] as f64 - env[m] as f64) * u;
            let gr = env[m + 1] as f64 + (env[m + 3] as f64 - env[m + 1] as f64) * u;
            let lv_ = catmull(Live::at(a, fa, k - 1), Live::at(a, fa, k), Live::at(a, fa, k + 1), Live::at(a, fa, k + 2), f);
            let rv = if stereo { catmull(Live::at(b, fb, k - 1), Live::at(b, fb, k), Live::at(b, fb, k + 1), Live::at(b, fb, k + 2), f) } else { lv_ };
            let i = (j - j0) as usize;
            l[i] = (l[i] as f64 + lv_ * gl) as f32;
            r[i] = (r[i] as f64 + rv * gr) as f32;
        }
    }
    for (t, ch) in fx.tracks.iter_mut().enumerate() {
        let (a, b) = &mut tb[t];
        ch.process(a, b);
        for i in 0..l.len() { l[i] = (l[i] as f64 + a[i] as f64) as f32; r[i] = (r[i] as f64 + b[i] as f64) as f32; }
    }
    if job.mix_gain != 1.0 { for i in 0..l.len() { l[i] = (l[i] as f64 * job.mix_gain) as f32; r[i] = (r[i] as f64 * job.mix_gain) as f32; } }
    for lim in limiters.iter_mut() { lim.process(l, r); }
    if let Some(b) = fx.bus.as_mut() { b.process(l, r); }
    job.clicks.add(job.rate, j0, l, r);
    if job.soft {
        let sc = |v: f32| -> f32 { let x = v as f64; if x.abs() > 0.9 { (x.signum() * (0.9 + 0.1 * ((x.abs() - 0.9) / 0.1).tanh())) as f32 } else { v } };
        for i in 0..l.len() { l[i] = sc(l[i]); r[i] = sc(r[i]); }
    }
    Ok(())
}

/// A 24-bit sample, as lib/mixplan.js pcm24 (JavaScript's Math.round: halves round up).
#[inline]
pub fn pcm24(v: f32) -> i32 { ((v as f64).clamp(-1.0, 1.0) * 8388607.0 + 0.5).floor().clamp(-8388608.0, 8388607.0) as i32 }

pub trait Sink { fn write(&mut self, l: &[f32], r: &[f32]) -> Result<(), String>; fn finish(self: Box<Self>) -> Result<(), String>; }

/// 24-bit stereo WAV with the same 44-byte header as the export worker's wavHeader.
pub struct WavSink { f: std::io::BufWriter<std::fs::File>, rate: u32, bytes: u64 }
impl WavSink {
    pub fn create(path: &str, rate: u32) -> Result<WavSink, String> {
        use std::io::Write;
        let file = std::fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|e| format!("can't write the file: {e}"))?;
        let mut f = std::io::BufWriter::with_capacity(1 << 20, file);
        f.write_all(&[0u8; 44]).map_err(|e| e.to_string())?;
        Ok(WavSink { f, rate, bytes: 0 })
    }
}
impl Sink for WavSink {
    fn write(&mut self, l: &[f32], r: &[f32]) -> Result<(), String> {
        use std::io::Write;
        let mut out = Vec::with_capacity(l.len() * 6);
        for i in 0..l.len() { for v in [l[i], r[i]] { let x = pcm24(v); out.extend_from_slice(&x.to_le_bytes()[..3]); } }
        self.bytes += out.len() as u64;
        self.f.write_all(&out).map_err(|e| format!("couldn't write: {e}"))
    }
    fn finish(self: Box<Self>) -> Result<(), String> {
        use std::io::{Seek, SeekFrom, Write};
        let mut f = self.f;
        let (rate, bytes) = (self.rate, self.bytes);
        let mut h = Vec::with_capacity(44);
        h.extend_from_slice(b"RIFF"); h.extend_from_slice(&((36 + bytes).min(0xffff_ffff) as u32).to_le_bytes()); h.extend_from_slice(b"WAVE");
        h.extend_from_slice(b"fmt "); h.extend_from_slice(&16u32.to_le_bytes()); h.extend_from_slice(&1u16.to_le_bytes()); h.extend_from_slice(&2u16.to_le_bytes());
        h.extend_from_slice(&rate.to_le_bytes()); h.extend_from_slice(&(rate * 6).to_le_bytes()); h.extend_from_slice(&6u16.to_le_bytes()); h.extend_from_slice(&24u16.to_le_bytes());
        h.extend_from_slice(b"data"); h.extend_from_slice(&(bytes.min(0xffff_ffff) as u32).to_le_bytes());
        f.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        f.write_all(&h).map_err(|e| e.to_string())?;
        f.flush().map_err(|e| e.to_string())
    }
}

/// Mixes the whole job into the sink, in blocks; `progress` gets 0..1 now and then.
pub fn run(job: &Job, sink: &mut dyn Sink, mut progress: impl FnMut(f64)) -> Result<(), String> {
    const BLOCK: u64 = 8192;
    let mut live: Vec<Option<Live>> = (0..job.plans.len()).map(|_| None).collect();
    let mut limiters: Vec<Limiter> = job.limiters.iter().map(|&(ceil, rel)| Limiter { ceil, rel, g: 1.0 }).collect();
    let mut fx = job.fx()?;
    let (mut l, mut r) = (vec![0f32; BLOCK as usize], vec![0f32; BLOCK as usize]);
    let mut j0 = 0;
    let mut last_report = 0;
    while j0 < job.total {
        let n = BLOCK.min(job.total - j0) as usize;
        l[..n].iter_mut().for_each(|v| *v = 0.0); r[..n].iter_mut().for_each(|v| *v = 0.0);
        mix_block(job, &mut live, &mut limiters, &mut fx, j0, &mut l[..n], &mut r[..n])?;
        sink.write(&l[..n], &r[..n])?;
        j0 += n as u64;
        if j0 - last_report >= job.rate as u64 * 30 || j0 >= job.total { progress(j0 as f64 / job.total as f64); last_report = j0; }
    }
    Ok(())
}

// ---------------------------------------------------------------- loudness target (lib/master.js, export-worker.js)

/// A loudness target for the export: the mix is measured (BS.1770-4, gated), turned up or down to `target` LUFS,
/// then held under the ceiling by the true-peak limiter, exactly as the JavaScript master path does. `ceil` (gain),
/// `rel` and `look` come from Reel worked out the same way as there; `measure` is how many frames the JavaScript
/// mix pass measures (its own rounding of the length).
pub struct Loud { pub target: f64, pub ceil: f64, pub rel: f64, pub look: usize, pub measure: u64 }

/// One biquad (transposed direct form II) with f64 state; its output is stored as f32, like the JavaScript's
/// Float32Array in place.
struct Bq { b0: f64, b1: f64, b2: f64, a1: f64, a2: f64, z0: f64, z1: f64 }
impl Bq {
    fn shelf_or_hp(high_shelf: bool, f: f64, q: f64, gain_db: f64, rate: f64) -> Bq {
        let f = f.min(rate * 0.45);
        let a = 10f64.powf(gain_db / 40.0);
        let w = std::f64::consts::TAU * f / rate;
        let (cs, sn) = (w.cos(), w.sin());
        let al = sn / (2.0 * q);
        let (b0, b1, b2, a0, a1, a2) = if high_shelf {
            let s = 2.0 * a.sqrt() * al;
            (a * ((a + 1.0) + (a - 1.0) * cs + s), -2.0 * a * ((a - 1.0) + (a + 1.0) * cs), a * ((a + 1.0) + (a - 1.0) * cs - s),
             (a + 1.0) - (a - 1.0) * cs + s, 2.0 * ((a - 1.0) - (a + 1.0) * cs), (a + 1.0) - (a - 1.0) * cs - s)
        } else {
            ((1.0 + cs) / 2.0, -(1.0 + cs), (1.0 + cs) / 2.0, 1.0 + al, -2.0 * cs, 1.0 - al)
        };
        Bq { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, z0: 0.0, z1: 0.0 }
    }
    fn exact(b0: f64, b1: f64, b2: f64, a1: f64, a2: f64) -> Bq { Bq { b0, b1, b2, a1, a2, z0: 0.0, z1: 0.0 } }
    fn run(&mut self, x: &mut [f32]) {
        let (mut z0, mut z1) = (self.z0, self.z1);
        for v in x.iter_mut() {
            let vi = *v as f64;
            let y = self.b0 * vi + z0;
            z0 = self.b1 * vi - self.a1 * y + z1;
            z1 = self.b2 * vi - self.a2 * y;
            *v = y as f32;
        }
        self.z0 = z0; self.z1 = z1;
    }
}

/// Integrated loudness (BS.1770-4), the LoudnessMeter in lib/master.js.
pub struct Meter { pre: [Bq; 2], rlb: [Bq; 2], block: usize, acc: f64, count: usize, steps: Vec<f64>, l: Vec<f32>, r: Vec<f32> }
impl Meter {
    pub fn new(rate: f64) -> Meter {
        let (pre, rlb) = if rate == 48000.0 {
            // the exact coefficients published in ITU-R BS.1770
            let p = || Bq::exact(1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585);
            let h = || Bq::exact(1.0, -2.0, 1.0, -1.99004745483398, 0.99007225036621);
            ([p(), p()], [h(), h()])
        } else {
            let p = || Bq::shelf_or_hp(true, 1681.97, 0.7072, 3.9998, rate);
            let h = || Bq::shelf_or_hp(false, 38.135, 0.5003, 0.0, rate);
            ([p(), p()], [h(), h()])
        };
        Meter { pre, rlb, block: (rate * 0.1).round() as usize, acc: 0.0, count: 0, steps: Vec::new(), l: Vec::new(), r: Vec::new() }
    }
    pub fn push(&mut self, l: &[f32], r: &[f32]) {
        self.l.clear(); self.l.extend_from_slice(l); self.r.clear(); self.r.extend_from_slice(r);
        self.pre[0].run(&mut self.l); self.pre[1].run(&mut self.r); self.rlb[0].run(&mut self.l); self.rlb[1].run(&mut self.r);
        for i in 0..self.l.len() {
            let (a, b) = (self.l[i] as f64, self.r[i] as f64);
            self.acc += a * a + b * b;
            self.count += 1;
            if self.count == self.block { self.steps.push(self.acc / self.block as f64); self.acc = 0.0; self.count = 0; }
        }
    }
    pub fn integrated(&self) -> f64 {
        let lufs = |z: f64| -0.691 + 10.0 * (z + 1e-12).log10();
        let blocks: Vec<f64> = (0..self.steps.len().saturating_sub(3)).map(|i| (self.steps[i] + self.steps[i + 1] + self.steps[i + 2] + self.steps[i + 3]) / 4.0).collect();
        let abs: Vec<f64> = blocks.into_iter().filter(|&z| lufs(z) > -70.0).collect();
        if abs.is_empty() { return f64::NEG_INFINITY; }
        let rel = lufs(abs.iter().sum::<f64>() / abs.len() as f64) - 10.0;
        let g: Vec<f64> = abs.into_iter().filter(|&z| lufs(z) > rel).collect();
        lufs(g.iter().sum::<f64>() / g.len() as f64)
    }
}

/// The look-ahead true-peak limiter (TruePeakLimiter in lib/master.js), sample for sample.
pub struct TruePeak { ceil: f64, rel: f64, look: usize, buf_l: Vec<f32>, buf_r: Vec<f32>, hold: Vec<f32>, pos: usize, gain: f64, prev_l: f64, prev_r: f64 }
const SINES: [(f64, f64); 3] = [(0.25, 0.7071067811865475), (0.5, 1.0), (0.75, 0.7071067811865476)]; // Math.sin(Math.PI * t)
impl TruePeak {
    pub fn new(ceil: f64, rel: f64, look: usize) -> TruePeak {
        let look = look.max(1);
        TruePeak { ceil, rel, look, buf_l: vec![0.0; look], buf_r: vec![0.0; look], hold: vec![1.0; look], pos: 0, gain: 1.0, prev_l: 0.0, prev_r: 0.0 }
    }
    fn tp(prev: f64, cur: f64) -> f64 {
        let mut m = cur.abs();
        for (t, s) in SINES { let v = prev + (cur - prev) * t; let bulge = v.abs() + (cur - prev).abs() * 0.08 * s; if bulge > m { m = bulge; } }
        m
    }
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let (cl, cr) = (l[i] as f64, r[i] as f64);
            let pk = Self::tp(self.prev_l, cl).max(Self::tp(self.prev_r, cr));
            self.prev_l = cl; self.prev_r = cr;
            let need = if pk > self.ceil { self.ceil / pk } else { 1.0 };
            let mut target = need;
            for k in 0..self.look { let h = self.hold[k] as f64; if h < target { target = h; } }
            self.hold[self.pos] = need as f32;
            self.gain = if target < self.gain { target } else { self.rel * self.gain + (1.0 - self.rel) * target };
            let (ol, or) = (self.buf_l[self.pos], self.buf_r[self.pos]);
            self.buf_l[self.pos] = l[i]; self.buf_r[self.pos] = r[i];
            self.pos = (self.pos + 1) % self.look;
            l[i] = (ol as f64 * self.gain) as f32; r[i] = (or as f64 * self.gain) as f32;
        }
    }
}

/// Like `run`, with a loudness target: one pass to measure the mix, a second to write it turned to the target and
/// limited. Progress: the measuring pass is the first half. Returns the measured loudness (LUFS).
pub fn run_loud(job: &Job, loud: &Loud, sink: &mut dyn Sink, mut progress: impl FnMut(f64)) -> Result<f64, String> {
    const BLOCK: u64 = 8192;
    let (mut l, mut r) = (vec![0f32; BLOCK as usize], vec![0f32; BLOCK as usize]);
    // pass 1: measure (as long as the JavaScript's mix file)
    let mut meter = Meter::new(job.rate);
    {
        let mut live: Vec<Option<Live>> = (0..job.plans.len()).map(|_| None).collect();
        let mut limiters: Vec<Limiter> = job.limiters.iter().map(|&(ceil, rel)| Limiter { ceil, rel, g: 1.0 }).collect();
        let mut fx = job.fx()?;
        let (mut j0, mut last) = (0u64, 0u64);
        let measure = loud.measure.max(job.total);
        while j0 < measure {
            let n = BLOCK.min(measure - j0) as usize;
            l[..n].iter_mut().for_each(|v| *v = 0.0); r[..n].iter_mut().for_each(|v| *v = 0.0);
            mix_block(job, &mut live, &mut limiters, &mut fx, j0, &mut l[..n], &mut r[..n])?;
            meter.push(&l[..n], &r[..n]);
            j0 += n as u64;
            if j0 - last >= job.rate as u64 * 30 { progress(0.5 * j0 as f64 / measure as f64); last = j0; }
        }
    }
    let lufs = meter.integrated();
    let gain = if lufs.is_finite() { 10f64.powf((loud.target - lufs).min(20.0) / 20.0) } else { 1.0 };
    // pass 2: mix again, turn it to the target, limit, write
    let mut live: Vec<Option<Live>> = (0..job.plans.len()).map(|_| None).collect();
    let mut limiters: Vec<Limiter> = job.limiters.iter().map(|&(ceil, rel)| Limiter { ceil, rel, g: 1.0 }).collect();
    let mut fx = job.fx()?;
    let mut tp = TruePeak::new(loud.ceil, loud.rel, loud.look);
    let (mut j0, mut last) = (0u64, 0u64);
    while j0 < job.total {
        let n = BLOCK.min(job.total - j0) as usize;
        l[..n].iter_mut().for_each(|v| *v = 0.0); r[..n].iter_mut().for_each(|v| *v = 0.0);
        mix_block(job, &mut live, &mut limiters, &mut fx, j0, &mut l[..n], &mut r[..n])?;
        for i in 0..n { l[i] = (l[i] as f64 * gain) as f32; r[i] = (r[i] as f64 * gain) as f32; }
        tp.process(&mut l[..n], &mut r[..n]);
        sink.write(&l[..n], &r[..n])?;
        j0 += n as u64;
        if j0 - last >= job.rate as u64 * 30 || j0 >= job.total { progress(0.5 + 0.5 * j0 as f64 / job.total as f64); last = j0; }
    }
    Ok(lufs)
}

// ---------------------------------------------------------------- AAC through Apple's encoder (macOS)

#[cfg(target_os = "macos")]
pub mod aac {
    use std::ffi::c_void;
    type OSStatus = i32;
    type Ref = *mut c_void;
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    #[allow(non_snake_case)]
    struct ASBD { mSampleRate: f64, mFormatID: u32, mFormatFlags: u32, mBytesPerPacket: u32, mFramesPerPacket: u32, mBytesPerFrame: u32, mChannelsPerFrame: u32, mBitsPerChannel: u32, mReserved: u32 }
    #[repr(C)]
    #[allow(non_snake_case)]
    struct AudioBuffer { mNumberChannels: u32, mDataByteSize: u32, mData: *mut c_void }
    #[repr(C)]
    #[allow(non_snake_case)]
    struct AudioBufferList { mNumberBuffers: u32, mBuffers: [AudioBuffer; 1] }
    #[link(name = "AudioToolbox", kind = "framework")]
    extern "C" {
        fn ExtAudioFileCreateWithURL(url: *const c_void, file_type: u32, fmt: *const ASBD, layout: *const c_void, flags: u32, out: *mut Ref) -> OSStatus;
        fn ExtAudioFileSetProperty(f: Ref, id: u32, size: u32, data: *const c_void) -> OSStatus;
        fn ExtAudioFileGetProperty(f: Ref, id: u32, size: *mut u32, data: *mut c_void) -> OSStatus;
        fn ExtAudioFileWrite(f: Ref, frames: u32, list: *const AudioBufferList) -> OSStatus;
        fn ExtAudioFileDispose(f: Ref) -> OSStatus;
        fn AudioConverterSetProperty(c: *mut c_void, id: u32, size: u32, data: *const c_void) -> OSStatus;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFURLCreateFromFileSystemRepresentation(alloc: *const c_void, buf: *const u8, len: isize, is_dir: u8) -> *const c_void;
        fn CFRelease(cf: *const c_void);
    }
    const fn code(s: &[u8; 4]) -> u32 { u32::from_be_bytes(*s) }

    pub struct AacSink { f: Ref, inter: Vec<f32> }
    impl AacSink {
        pub fn create(path: &str, rate: f64, bitrate: u32) -> Result<AacSink, String> {
            if std::path::Path::new(path).exists() { return Err("the file is already there".into()); }
            let url = unsafe { CFURLCreateFromFileSystemRepresentation(std::ptr::null(), path.as_ptr(), path.len() as isize, 0) };
            if url.is_null() { return Err("bad path".into()); }
            let fmt = ASBD { mSampleRate: rate, mFormatID: code(b"aac "), mChannelsPerFrame: 2, mFramesPerPacket: 1024, ..Default::default() };
            let mut f: Ref = std::ptr::null_mut();
            let st = unsafe { ExtAudioFileCreateWithURL(url, code(b"m4af"), &fmt, std::ptr::null(), 0, &mut f) };
            unsafe { CFRelease(url) };
            if st != 0 || f.is_null() { return Err(format!("macOS couldn't start an AAC file ({st})")); }
            let me = AacSink { f, inter: Vec::new() };
            let client = ASBD { mSampleRate: rate, mFormatID: code(b"lpcm"), mFormatFlags: 1 | 8, mBytesPerPacket: 8, mFramesPerPacket: 1, mBytesPerFrame: 8, mChannelsPerFrame: 2, mBitsPerChannel: 32, mReserved: 0 };
            if unsafe { ExtAudioFileSetProperty(f, code(b"cfmt"), std::mem::size_of::<ASBD>() as u32, &client as *const _ as *const c_void) } != 0 {
                return Err("macOS's AAC encoder didn't take the sound format".into());
            }
            // the bitrate, set on the file's converter (then the converter is told to apply it)
            let mut conv: *mut c_void = std::ptr::null_mut();
            let mut size = std::mem::size_of::<*mut c_void>() as u32;
            if unsafe { ExtAudioFileGetProperty(f, code(b"acnv"), &mut size, &mut conv as *mut _ as *mut c_void) } == 0 && !conv.is_null() {
                let br: u32 = bitrate.clamp(64000, 320000);
                if unsafe { AudioConverterSetProperty(conv, code(b"brat"), 4, &br as *const _ as *const c_void) } == 0 {
                    let null: *const c_void = std::ptr::null();
                    unsafe { ExtAudioFileSetProperty(f, code(b"acfg"), std::mem::size_of::<*const c_void>() as u32, &null as *const _ as *const c_void) };
                }
            }
            Ok(me)
        }
    }
    impl super::Sink for AacSink {
        fn write(&mut self, l: &[f32], r: &[f32]) -> Result<(), String> {
            self.inter.clear();
            for i in 0..l.len() { self.inter.push(l[i]); self.inter.push(r[i]); }
            let list = AudioBufferList { mNumberBuffers: 1, mBuffers: [AudioBuffer { mNumberChannels: 2, mDataByteSize: (self.inter.len() * 4) as u32, mData: self.inter.as_mut_ptr() as *mut c_void }] };
            let st = unsafe { ExtAudioFileWrite(self.f, l.len() as u32, &list) };
            if st != 0 { return Err(format!("macOS's AAC encoder stopped ({st})")); }
            Ok(())
        }
        fn finish(self: Box<Self>) -> Result<(), String> {
            let st = unsafe { ExtAudioFileDispose(self.f) };
            std::mem::forget(self); // disposed above
            if st != 0 { return Err(format!("macOS couldn't finish the AAC file ({st})")); }
            Ok(())
        }
    }
    impl Drop for AacSink { fn drop(&mut self) { unsafe { ExtAudioFileDispose(self.f) }; } }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::tests::write_wav;

    #[test]
    fn a_clip_at_unity_gain_comes_through_unchanged_and_pcm24_rounds_like_javascript() {
        let dir = std::env::temp_dir();
        let src = dir.join(format!("reel-mix-src-{}.wav", std::process::id()));
        let out = dir.join(format!("reel-mix-out-{}.wav", std::process::id()));
        std::fs::remove_file(&out).ok();
        write_wav(&src, 48000, 48000, |i, c| if c == 0 { (i as f64 * 0.01).sin() * 0.5 } else { 0.25 });
        let n = 48000u64;
        let segs = n.div_ceil(256) as usize;
        let job = Job { rate: 48000.0, total: n, mix_gain: 1.0, limiters: vec![], soft: true, clicks: Clicks::default(), stretched: vec![], order: vec![], win: vec![], tol: 0, chain_of: vec![], chains: vec![], bus: None, sources: vec![src.to_str().unwrap().into()],
            plans: vec![Plan { src: 0, first: 0, last: n, s0: 0.0, speed: 1.0, env: vec![1.0; (segs + 2) * 2] }] };
        let mut sink: Box<dyn Sink> = Box::new(WavSink::create(out.to_str().unwrap(), 48000).unwrap());
        run(&job, sink.as_mut(), |_| {}).unwrap();
        sink.finish().unwrap();
        let b = std::fs::read(&out).unwrap();
        assert_eq!(b.len(), 44 + 48000 * 6);
        let s = |i: usize| { let o = 44 + i * 3; ((b[o] as i32) | ((b[o + 1] as i32) << 8) | ((b[o + 2] as i32) << 16)) << 8 >> 8 };
        // right channel: 0.25 in 16-bit (8192/32768 exactly) → 0.25 × 8388607 rounded
        assert_eq!(s(1001), (0.25f64 * 8388607.0 + 0.5).floor() as i32);
        assert_eq!(pcm24(-0.5 / 8388607.0), 0); // JavaScript rounds −0.5 up to −0
        assert_eq!(pcm24(2.0), 8388607);
        std::fs::remove_file(src).ok(); std::fs::remove_file(out).ok();
    }

    /// On the Mac: the same mix written as AAC by Apple's encoder reads back (through Apple's decoder) as long as the
    /// WAV and as loud, within what a lossy codec changes.
    #[cfg(target_os = "macos")]
    #[test]
    fn aac_written_by_apples_encoder_matches_the_wav() {
        let dir = std::env::temp_dir();
        let (src, wav, m4a) = (dir.join(format!("reel-aac-src-{}.wav", std::process::id())), dir.join(format!("reel-aac-out-{}.wav", std::process::id())), dir.join(format!("reel-aac-out-{}.m4a", std::process::id())));
        for f in [&wav, &m4a] { std::fs::remove_file(f).ok(); }
        write_wav(&src, 48000, 48000 * 5, |i, c| { let t = i as f64 / 48000.0; 0.4 * (2.0 * std::f64::consts::PI * (330.0 + 110.0 * c as f64) * t).sin() * if t < 2.5 { 1.0 } else { 0.2 } });
        let n = 48000u64 * 5;
        let job = Job { rate: 48000.0, total: n, mix_gain: 1.0, limiters: vec![(0.891, 0.9997)], soft: true, clicks: Clicks::default(), stretched: vec![], order: vec![], win: vec![], tol: 0, chain_of: vec![], chains: vec![], bus: None, sources: vec![src.to_str().unwrap().into()],
            plans: vec![Plan { src: 0, first: 0, last: n, s0: 0.0, speed: 1.0, env: vec![0.9; ((n.div_ceil(256) + 2) * 2) as usize] }] };
        let mut a: Box<dyn Sink> = Box::new(WavSink::create(wav.to_str().unwrap(), 48000).unwrap());
        run(&job, a.as_mut(), |_| {}).unwrap(); a.finish().unwrap();
        let mut b: Box<dyn Sink> = Box::new(aac::AacSink::create(m4a.to_str().unwrap(), 48000.0, 192000).unwrap());
        run(&job, b.as_mut(), |_| {}).unwrap(); b.finish().unwrap();
        let wa = crate::analyze::analyze(media::open(wav.to_str().unwrap()).unwrap().as_mut()).unwrap();
        let wb = crate::analyze::analyze(media::open(m4a.to_str().unwrap()).unwrap().as_mut()).unwrap();
        assert_eq!(wb.rate, 48000.0);
        assert!((wa.peaks.len() as i64 - wb.peaks.len() as i64).abs() <= 5, "{} vs {} peaks", wa.peaks.len(), wb.peaks.len());
        let lufs = |s: &[f32]| -0.691 + 10.0 * (s.iter().map(|&v| v as f64).sum::<f64>() / s.len() as f64).log10();
        let k = wa.steps.len().min(wb.steps.len()) - 1;
        let (la, lb) = (lufs(&wa.steps[1..k]), lufs(&wb.steps[1..k]));
        assert!((la - lb).abs() < 0.5, "WAV {la:.2} LUFS, AAC {lb:.2} LUFS");
        for f in [&src, &wav, &m4a] { std::fs::remove_file(f).ok(); }
    }
}
