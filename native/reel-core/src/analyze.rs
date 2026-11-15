//! A media file's sound in one pass: waveform peaks for the timeline (as app/renderer/peaks-worker.js) and the
//! loudness profile for AUTO MIX (as app/renderer/levels-worker.js: K-weighted mean square every 100 ms,
//! ITU-R BS.1770). Same arithmetic and the same f32 / f64 places as the JavaScript, so the answers match.

use crate::media::Source;

/// The JavaScript's Biquad (lib/master.js): RBJ cookbook coefficients, transposed direct form II.
pub struct Biquad { b0: f64, b1: f64, b2: f64, a1: f64, a2: f64, z0: f64, z1: f64 }

impl Biquad {
    pub fn new(kind: &str, f: f64, q: f64, gain_db: f64, rate: f64) -> Biquad {
        let f = f.min(rate * 0.45);
        let a = 10f64.powf(gain_db / 40.0);
        let w = (2.0 * std::f64::consts::PI * f) / rate;
        let (cs, sn) = (w.cos(), w.sin());
        let al = sn / (2.0 * q);
        let (b0, b1, b2, a0, a1, a2) = match kind {
            "highshelf" => {
                let s = 2.0 * a.sqrt() * al;
                (a * ((a + 1.0) + (a - 1.0) * cs + s), -2.0 * a * ((a - 1.0) + (a + 1.0) * cs), a * ((a + 1.0) + (a - 1.0) * cs - s),
                 (a + 1.0) - (a - 1.0) * cs + s, 2.0 * ((a - 1.0) - (a + 1.0) * cs), (a + 1.0) - (a - 1.0) * cs - s)
            }
            "highpass" => ((1.0 + cs) / 2.0, -(1.0 + cs), (1.0 + cs) / 2.0, 1.0 + al, -2.0 * cs, 1.0 - al),
            _ => (1.0, 0.0, 0.0, 1.0, 0.0, 0.0),
        };
        Biquad { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, z0: 0.0, z1: 0.0 }
    }
    /// In place, on f32 samples (the JavaScript runs it on a Float32Array).
    pub fn run(&mut self, x: &mut [f32]) {
        let (mut z0, mut z1) = (self.z0, self.z1);
        for v in x.iter_mut() {
            let s = *v as f64;
            let y = self.b0 * s + z0;
            z0 = self.b1 * s - self.a1 * y + z1;
            z1 = self.b2 * s - self.a2 * y;
            *v = y as f32;
        }
        self.z0 = z0; self.z1 = z1;
    }
}

pub struct Analysis { pub rate: f64, pub peaks: Vec<f32>, pub steps: Vec<f32> }

pub const PEAK_RATE: f64 = 100.0;

/// Peaks (100 a second, 0..1, square-rooted so quiet speech still shows) and the loudness profile.
pub fn analyze(src: &mut dyn Source) -> Result<Analysis, String> {
    let (rate, channels, total) = { let i = src.info(); (i.rate, i.channels, i.frames) };
    let per = ((rate / PEAK_RATE).round() as u64).max(1);
    let n = total.div_ceil(per) as usize;
    let mut peaks = vec![0f32; n];
    let step = (rate * 0.1).round() as u64;
    let lc = channels.min(2);
    let mut filters: Vec<(Biquad, Biquad)> = (0..lc).map(|_| (Biquad::new("highshelf", 1681.97, 0.7072, 3.9998, rate), Biquad::new("highpass", 38.135, 0.5003, 0.0, rate))).collect();
    let mut steps = vec![0f32; total.div_ceil(step.max(1)) as usize];
    let (mut acc, mut count, mut k) = (0f64, 0u64, 0usize);
    // peaks: groups of `per` frames, counted across chunks
    let (mut pk, mut pv, mut in_group) = (0usize, 0f64, 0u64);
    let chunk = (step.max(1) * 300) as usize; // the levels worker's chunk; peaks don't depend on it
    let mut seen = 0u64;
    loop {
        let pcm = src.read(chunk)?;
        let len = pcm.first().map_or(0, |c| c.len());
        if len == 0 || seen >= total { break; }
        let len = len.min((total - seen) as usize);
        // the waveform and each channel's K-weighting filters don't depend on each other: they run side by side
        let mut w: Vec<Vec<f32>> = (0..lc).map(|c| pcm.get(c).unwrap_or(&pcm[0])[..len].to_vec()).collect();
        std::thread::scope(|sc| {
            for (x, f) in w.iter_mut().zip(filters.iter_mut()) { sc.spawn(move || { f.0.run(x); f.1.run(x); }); }
            for i in 0..len {
                for c in &pcm { let x = (c[i] as f64).abs(); if x > pv { pv = x; } }
                in_group += 1;
                if in_group == per { if pk < n { peaks[pk] = 1f64.min(pv.sqrt()) as f32; } pk += 1; pv = 0.0; in_group = 0; }
            }
        });
        for i in 0..len {
            let mut s = 0f64;
            for x in &w { s += x[i] as f64 * x[i] as f64; }
            acc += s;
            count += 1;
            if count == step { if k < steps.len() { steps[k] = (acc / step as f64) as f32; k += 1; } acc = 0.0; count = 0; }
        }
        seen += len as u64;
    }
    if in_group > 0 && pk < n { peaks[pk] = 1f64.min(pv.sqrt()) as f32; }
    if count > 0 && k < steps.len() { steps[k] = (acc / count as f64) as f32; }
    Ok(Analysis { rate, peaks, steps })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::{self, tests::write_wav};

    #[test]
    fn a_full_scale_tone_peaks_at_one_and_measures_about_minus_three_lufs() {
        let p = std::env::temp_dir().join(format!("reel-core-an-{}.wav", std::process::id()));
        // 1 kHz sine at full scale in both channels: BS.1770 gives about +0.0 LUFS for stereo (−3.01 per channel + 3.01)
        write_wav(&p, 48000, 48000 * 3, |i, _| (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / 48000.0).sin() * 0.999);
        let mut src = media::open(p.to_str().unwrap()).unwrap();
        let a = analyze(src.as_mut()).unwrap();
        assert_eq!(a.peaks.len(), 300);
        assert!(a.peaks[150] > 0.99);
        assert_eq!(a.steps.len(), 30);
        let ms: f64 = a.steps[5..25].iter().map(|&v| v as f64).sum::<f64>() / 20.0;
        let lufs = -0.691 + 10.0 * ms.log10();
        assert!((lufs - 0.0).abs() < 0.3, "{lufs}");
        std::fs::remove_file(p).ok();
    }

    /// On the Mac: the same sound as AAC in an M4A (made by macOS's afconvert) reads through Apple's decoder with
    /// the same loudness (AAC is lossy, so close, not bit-exact) and the same waveform shape.
    #[cfg(target_os = "macos")]
    #[test]
    fn aac_through_apples_decoder_measures_like_the_wav() {
        let dir = std::env::temp_dir();
        let wav = dir.join(format!("reel-core-aac-{}.wav", std::process::id()));
        let m4a = dir.join(format!("reel-core-aac-{}.m4a", std::process::id()));
        write_wav(&wav, 48000, 48000 * 4, |i, c| {
            let t = i as f64 / 48000.0;
            let on = if t < 2.0 { 1.0 } else { 0.05 }; // loud for two seconds, then quiet
            on * 0.5 * (2.0 * std::f64::consts::PI * (220.0 + 110.0 * c as f64) * t).sin()
        });
        let ok = std::process::Command::new("/usr/bin/afconvert")
            .args(["-f", "m4af", "-d", "aac", "-b", "192000"]).arg(&wav).arg(&m4a).status().map(|s| s.success()).unwrap_or(false);
        assert!(ok, "afconvert couldn't make the test file");
        let a = analyze(media::open(wav.to_str().unwrap()).unwrap().as_mut()).unwrap();
        let b = analyze(media::open(m4a.to_str().unwrap()).unwrap().as_mut()).unwrap();
        assert_eq!(b.rate, 48000.0);
        let lufs = |s: &[f32]| -0.691 + 10.0 * (s.iter().map(|&v| v as f64).sum::<f64>() / s.len() as f64).log10();
        let n = a.steps.len().min(b.steps.len()) - 2;
        let (la, lb) = (lufs(&a.steps[2..n]), lufs(&b.steps[2..n]));
        assert!((la - lb).abs() < 0.5, "WAV {la:.2} LUFS, AAC {lb:.2} LUFS");
        // AAC adds a little delay at the start; compare the waveform's loud and quiet halves, not sample by sample
        let mean = |p: &[f32]| p.iter().map(|&v| v as f64).sum::<f64>() / p.len() as f64;
        assert!((mean(&a.peaks[20..180]) - mean(&b.peaks[20..180])).abs() < 0.05);
        assert!(mean(&b.peaks[220..380]) < 0.3 && mean(&b.peaks[20..180]) > 0.6);
        std::fs::remove_file(wav).ok(); std::fs::remove_file(m4a).ok();
    }
}
