//! Your ums, found by ear: a line-for-line port of app/renderer/lib/umvoice.js (fingerprint, dynamic time
//! warping, bursts and matching). The JavaScript stays the reference: tests/rustcore.test.mjs runs both on the same
//! sound and checks they agree. Values are kept in f32 where the JavaScript keeps them in a Float32Array, and in
//! f64 where it uses plain numbers, so the two give the same answers.

pub const RATE: usize = 16000;
const FRAME: usize = 400;
const HOP: usize = 160;
const NFFT: usize = 512;
const BANDS: usize = 24;
pub const COEFS: usize = 12;

pub type Print = Vec<[f32; COEFS]>;

struct Tables {
    hann: Vec<f32>,
    mel: Vec<(usize, Vec<f32>)>,  // per band: first bin with a weight, then its weights (the rest are 0)
    dct: Vec<Vec<f32>>,  // COEFS+1 rows of BANDS
}

fn mel(f: f64) -> f64 { 2595.0 * (1.0 + f / 700.0).log10() }
fn imel(m: f64) -> f64 { 700.0 * (10f64.powf(m / 2595.0) - 1.0) }

fn tables() -> &'static Tables {
    use std::sync::OnceLock;
    static T: OnceLock<Tables> = OnceLock::new();
    T.get_or_init(|| {
        let hann = (0..FRAME).map(|i| (0.5 - 0.5 * ((2.0 * std::f64::consts::PI * i as f64) / (FRAME as f64 - 1.0)).cos()) as f32).collect();
        let (lo, hi) = (mel(60.0), mel(7600.0));
        let pts: Vec<f64> = (0..BANDS + 2).map(|i| imel(lo + ((hi - lo) * i as f64) / (BANDS as f64 + 1.0))).collect();
        let bin = |f: f64| (((NFFT as f64 + 1.0) * f) / RATE as f64).floor() as i64;
        let mel = (0..BANDS).map(|b| {
            let (a, c, d) = (bin(pts[b]), bin(pts[b + 1]), bin(pts[b + 2]));
            let mut w = vec![0f32; NFFT / 2 + 1];
            for i in a..c { w[i as usize] = ((i - a) as f64 / ((c - a).max(1)) as f64) as f32; }
            for i in c..=d { if (i as usize) < w.len() { w[i as usize] = ((d - i) as f64 / ((d - c).max(1)) as f64) as f32; } }
            // only the bins the band covers (a zero weight adds nothing, in either language)
            let first = w.iter().position(|&v| v != 0.0).unwrap_or(0);
            let last = w.iter().rposition(|&v| v != 0.0).map_or(first, |i| i + 1);
            (first, w[first..last.max(first)].to_vec())
        }).collect();
        let dct = (0..=COEFS).map(|k| (0..BANDS).map(|n| ((std::f64::consts::PI * k as f64 * (n as f64 + 0.5)) / BANDS as f64).cos() as f32).collect()).collect();
        Tables { hann, mel, dct }
    })
}

/// In-place radix-2 FFT, computing in f64 and storing in f32 like the JavaScript's Float32Arrays.
fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    let mut j = 0usize;
    for i in 1..n {
        let mut b = n >> 1;
        while j & b != 0 { j ^= b; b >>= 1; }
        j ^= b;
        if i < j { re.swap(i, j); im.swap(i, j); }
    }
    let mut len = 2;
    while len <= n {
        let a = (-2.0 * std::f64::consts::PI) / len as f64;
        let (wr, wi) = (a.cos(), a.sin());
        let h = len / 2;
        let mut i = 0;
        while i < n {
            let (mut cr, mut ci) = (1.0f64, 0.0f64);
            for j in 0..h {
                let (ur, ui) = (re[i + j] as f64, im[i + j] as f64);
                let (xr, xi) = (re[i + j + h] as f64, im[i + j + h] as f64);
                let vr = xr * cr - xi * ci;
                let vi = xr * ci + xi * cr;
                re[i + j] = (ur + vr) as f32; im[i + j] = (ui + vi) as f32;
                re[i + j + h] = (ur - vr) as f32; im[i + j + h] = (ui - vi) as f32;
                let t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
            }
            i += len;
        }
        len <<= 1;
    }
}

/// The fingerprint of 16 kHz samples: one row of COEFS numbers every 10 ms.
pub fn fingerprint(x: &[f32]) -> Print {
    let t = tables();
    let mut frames = Vec::new();
    let (mut re, mut im) = (vec![0f32; NFFT], vec![0f32; NFFT]);
    let mut pow = vec![0f32; NFFT / 2 + 1];
    let mut logm = [0f64; BANDS];
    let mut s = 0;
    while s + FRAME <= x.len() {
        re.iter_mut().for_each(|v| *v = 0.0); im.iter_mut().for_each(|v| *v = 0.0);
        for i in 0..FRAME {
            let prev = if i > 0 { 0.97 * x[s + i - 1] as f64 } else { 0.0 };
            re[i] = ((x[s + i] as f64 - prev) * t.hann[i] as f64) as f32;
        }
        fft(&mut re, &mut im);
        for i in 0..=NFFT / 2 { pow[i] = (re[i] as f64 * re[i] as f64 + im[i] as f64 * im[i] as f64) as f32; }
        for (b, (first, w)) in t.mel.iter().enumerate() {
            let mut e = 0f64;
            for (i, &wi) in w.iter().enumerate() { if wi != 0.0 { e += wi as f64 * pow[first + i] as f64; } }
            logm[b] = (e + 1e-9).ln();
        }
        let mut c = [0f32; COEFS];
        for k in 1..=COEFS {
            let mut v = 0f64;
            for n in 0..BANDS { v += logm[n] * t.dct[k][n] as f64; }
            c[k - 1] = v as f32;
        }
        frames.push(c);
        s += HOP;
    }
    frames
}

/// Dynamic time warping distance per step, inside a band.
pub fn dtw(a: &Print, b: &Print) -> f64 {
    let (n, m) = (a.len(), b.len());
    if n == 0 || m == 0 { return f64::INFINITY; }
    let band = (n as i64 - m as i64).unsigned_abs().max(((n.max(m) as f64) * 0.5).ceil() as u64) as i64;
    let mut prev = vec![f64::INFINITY; m + 1];
    let mut cur = vec![0f64; m + 1];
    prev[0] = 0.0;
    for i in 1..=n {
        cur.iter_mut().for_each(|v| *v = f64::INFINITY);
        let lo = 1.max(((i * m) as f64 / n as f64).floor() as i64 - band) as usize;
        let hi = (m as i64).min(((i * m) as f64 / n as f64).ceil() as i64 + band) as usize;
        let x = &a[i - 1];
        for j in lo..=hi {
            let y = &b[j - 1];
            let mut d = 0f64;
            for k in 0..COEFS { let e = x[k] as f64 - y[k] as f64; d += e * e; }
            cur[j] = d.sqrt() + prev[j].min(cur[j - 1]).min(prev[j - 1]);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[m] / (n + m) as f64
}

/// Bursts: louder than the room, min..max seconds, with a pause either side. Returns (a, b) in samples.
pub fn bursts(x: &[f32], min: f64, max: f64, gap: f64, soft: bool) -> Vec<(usize, usize)> {
    let rate = RATE as f64;
    let win = (rate * 0.01).round() as usize;
    let n = x.len() / win;
    let mut env = vec![0f32; n];
    for i in 0..n {
        let mut s = 0f64;
        for k in i * win..(i + 1) * win { s += x[k] as f64 * x[k] as f64; }
        env[i] = (s / win as f64).sqrt() as f32;
    }
    let mut sorted = env.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let at = |q: f64| sorted.get((n as f64 * q).floor() as usize).copied().unwrap_or(0.0) as f64;
    let (floor, loud) = (at(0.1), at(0.9));
    // soft: a much lower bar, for soft sounds you taught (breaths) that never reach the bar for words
    let on = if soft { (floor * 1.6).max(floor + (loud - floor) * 0.03).max(3e-5) } else { (floor * 3.0).max(floor + (loud - floor) * 0.12).max(1e-4) };
    let hold = ((gap * rate) / win as f64).round() as usize;
    let mut runs = Vec::new();
    let (mut s, mut quiet): (i64, usize) = (-1, 0);
    for i in 0..=n {
        let v = if i < n { env[i] as f64 } else { 0.0 };
        if v >= on { if s < 0 { s = i as i64; } quiet = 0; }
        else if s >= 0 { quiet += 1; if quiet >= hold { runs.push((s as usize, i + 1 - quiet)); s = -1; quiet = 0; } }
    }
    if s >= 0 { runs.push((s as usize, n - quiet.saturating_sub(1))); }
    runs.into_iter()
        .filter(|&(a, b)| { let l = ((b - a) * win) as f64; l >= min * rate && l <= max * rate })
        .map(|(a, b)| (a * win, b * win))
        .collect()
}

pub struct Word { pub word: String, pub prints: Vec<Print> }
pub struct Model { pub words: Vec<Word>, pub nots: Vec<Print>, pub threshold: f64 }

pub struct Hit { pub t: f64, pub end: f64, pub word: usize, pub d: f64, pub sure: bool }

/// The nearest take: (index of its word, distance).
pub fn score(m: &Model, fp: &Print) -> (Option<usize>, f64) {
    let mut best = (None, f64::INFINITY);
    for (wi, w) in m.words.iter().enumerate() {
        for p in &w.prints { let d = dtw(fp, p); if d < best.1 { best = (Some(wi), d); } }
    }
    best
}

/// Your ums in 16 kHz samples (see findInSamples in the JavaScript).
pub fn find_in_samples(m: &Model, x: &[f32]) -> Vec<Hit> {
    let all = bursts(x, 0.12, 1.6, 0.12, false);
    let one = |&(a, b): &(usize, usize)| -> Option<Hit> {
        let fp = fingerprint(&x[a..b]);
        if fp.len() < 8 { return None; }
        let (w, d) = score(m, &fp);
        let w = w?;
        let no = m.nots.iter().map(|p| dtw(&fp, p)).fold(f64::INFINITY, f64::min);
        (d <= m.threshold && !(no < d)).then(|| Hit { t: a as f64 / RATE as f64, end: b as f64 / RATE as f64, word: w, d, sure: d <= m.threshold * 0.85 })
    };
    // each burst is judged on its own, so the Mac's cores share them; the order stays the order in time
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get()).min(8);
    let mut out: Vec<Hit> = if cores < 2 || all.len() < 32 { all.iter().filter_map(one).collect() } else {
        let chunk = all.len().div_ceil(cores);
        std::thread::scope(|sc| {
            let jobs: Vec<_> = all.chunks(chunk).map(|part| sc.spawn(move || part.iter().filter_map(one).collect::<Vec<_>>())).collect();
            jobs.into_iter().flat_map(|j| j.join().unwrap_or_default()).collect()
        })
    };
    // your own sounds (breath, sneeze…) can be far quieter than words: listen again with a lower bar, for those only,
    // where nothing was found already (as findInSamples in the JavaScript)
    let own: Vec<usize> = (0..m.words.len()).filter(|&i| m.words[i].word != "umm" && m.words[i].word != "uh").collect();
    if !own.is_empty() {
        let rate = RATE as f64;
        for (a, b) in bursts(x, 0.12, 1.6, 0.12, true) {
            if out.iter().any(|h| h.t < b as f64 / rate && h.end > a as f64 / rate) { continue; }
            let fp = fingerprint(&x[a..b]);
            if fp.len() < 8 { continue; }
            let mut best = (None, f64::INFINITY);
            for &wi in &own { for p in &m.words[wi].prints { let d = dtw(&fp, p); if d < best.1 { best = (Some(wi), d); } } }
            let Some(w) = best.0 else { continue };
            let d = best.1;
            let no = m.nots.iter().map(|p| dtw(&fp, p)).fold(f64::INFINITY, f64::min);
            if d <= m.threshold && !(no < d) { out.push(Hit { t: a as f64 / rate, end: b as f64 / rate, word: w, d, sure: d <= m.threshold * 0.85 }); }
        }
        out.sort_by(|p, q| p.t.partial_cmp(&q.t).unwrap_or(std::cmp::Ordering::Equal));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A buzz at pitch f (a pulse train, like a voice's vocal folds): energy in every band.
    fn tone(sec: f64, f: f64, amp: f32) -> Vec<f32> {
        let n = (sec * RATE as f64) as usize;
        let mut ph = 0.0;
        (0..n).map(|_| { ph += f / RATE as f64; if ph >= 1.0 { ph -= 1.0; amp } else { 0.0 } }).collect()
    }

    #[test]
    fn a_quiet_and_a_loud_version_of_a_sound_have_the_same_print() {
        let a = fingerprint(&tone(0.3, 220.0, 0.1));
        let b = fingerprint(&tone(0.3, 220.0, 0.8));
        assert_eq!(a.len(), b.len());
        assert!(dtw(&a, &b) < 0.05, "{}", dtw(&a, &b));
        assert!(dtw(&a, &fingerprint(&tone(0.3, 900.0, 0.1))) > dtw(&a, &b));
    }

    #[test]
    fn a_sound_between_pauses_is_a_burst() {
        let mut x = vec![0f32; 8000];
        x.extend(tone(0.4, 200.0, 0.3));
        x.extend(vec![0f32; 8000]);
        let b = bursts(&x, 0.12, 1.6, 0.12, false);
        assert_eq!(b.len(), 1);
        assert!((b[0].0 as f64 / RATE as f64 - 0.5).abs() < 0.03);
    }

    #[test]
    fn dtw_of_nothing_is_infinite() {
        assert!(dtw(&vec![], &vec![[0f32; COEFS]]).is_infinite());
    }
}
