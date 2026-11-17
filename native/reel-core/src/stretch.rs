//! Time stretching that keeps pitch (WSOLA), step for step as lib/stretch.js, and the export's way of playing a
//! stretched clip (export-worker.js, "keepsPitch"): the clip's sound read once, resampled to the output rate (linear),
//! stretched, then added block by block with its gain and pan, read every 256 samples.

/// Linear resampling exactly as export-worker.js does before stretching: o[i] from source position i × ratio.
pub fn resample(ch: &[f32], ratio: f64, out_n: usize) -> Vec<f32> {
    let get = |k: usize| -> Option<f64> { ch.get(k).map(|v| *v as f64) };
    (0..out_n).map(|i| {
        let p = i as f64 * ratio;
        let k = p.floor();
        let f = p - k;
        let k = k as usize;
        let a = get(k).unwrap_or(0.0);
        let b = get(k + 1).or(get(k)).unwrap_or(0.0);
        (a * (1.0 - f) + b * f) as f32
    }).collect()
}

/// lib/stretch.js `stretch`: the channels at `speed` (> 0), pitch kept. `win` is the window lib/stretch.js makes (sent
/// by Reel, so both use the very same numbers); `tol` its search range in samples.
pub fn stretch(chans: &[Vec<f32>], speed: f64, win: &[f32], tol: i64) -> Vec<Vec<f32>> {
    let len = chans[0].len();
    let out_len = ((len as f64 / speed) + 0.5).floor().max(1.0) as usize; // Math.max(1, Math.round(len / speed))
    if (speed - 1.0).abs() < 1e-4 { return chans.to_vec(); }
    warp(chans, &|o| (o as f64 * speed + 0.5).floor() as i64, out_len, win, tol) // Math.round(o * speed)
}

/// A time map (lib/retime.js `mapAt`): the source offset (seconds after In) played at clip time t. Points (t, s):
/// a straight line between them; past either end the nearest segment carries on.
pub fn map_at(pts: &[(f64, f64)], t: f64) -> f64 {
    let mut i = 0;
    while i + 2 < pts.len() && t > pts[i + 1].0 { i += 1; }
    let (a, b) = (pts[i], pts[i + 1]);
    a.1 + (t - a.0) * (b.1 - a.1) / (b.0 - a.0)
}

/// A clip with a time map, as export-worker.js stretchedOf plays it: `out_len` samples at `rate`, each from source
/// sample map(o) — read like tape (`tape`: faster parts sound higher) or with its pitch kept (WSOLA along the map).
pub fn follow_map(chans: &[Vec<f32>], pts: &[(f64, f64)], rate: f64, out_len: usize, tape: bool, win: &[f32], tol: i64) -> Vec<Vec<f32>> {
    let map = |o: usize| map_at(pts, o as f64 / rate) * rate;
    if tape {
        return chans.iter().map(|ch| (0..out_len).map(|i| {
            let p = map(i);
            let k = p.floor();
            let f = p - k;
            let get = |j: f64| -> Option<f64> { if j >= 0.0 && (j as usize) < ch.len() { Some(ch[j as usize] as f64) } else { None } };
            (get(k).unwrap_or(0.0) * (1.0 - f) + get(k + 1.0).or(get(k)).unwrap_or(0.0) * f) as f32
        }).collect()).collect();
    }
    warp(chans, &|o| (map(o) + 0.5).floor() as i64, out_len, win, tol) // Math.round(map(o))
}

fn warp(chans: &[Vec<f32>], ideal_at: &dyn Fn(usize) -> i64, out_len: usize, win: &[f32], tol: i64) -> Vec<Vec<f32>> {
    let len = chans[0].len() as i64;
    let n = win.len();
    let hs = n / 2;
    let mono: Vec<f32> = if chans.len() == 1 { chans[0].clone() } else {
        let mut m = vec![0f32; len as usize];
        let k = chans.len() as f64;
        for c in chans { for i in 0..len as usize { m[i] = (m[i] as f64 + c[i] as f64 / k) as f32; } }
        m
    };
    let at = |x: &[f32], i: i64| -> f64 { if i >= 0 && i < len { x[i as usize] as f64 } else { 0.0 } };
    let score = |p: i64, q: i64, step: usize| -> f64 { let mut s = 0.0; let mut i = 0; while i < n { s += at(&mono, p + i as i64) * at(&mono, q + i as i64); i += step; } s };
    let mut out: Vec<Vec<f32>> = chans.iter().map(|_| vec![0f32; out_len + n]).collect();
    let mut norm = vec![0f32; out_len + n];
    let mut prev: i64 = 0;
    let (mut k, mut o) = (0usize, 0usize);
    while o < out_len {
        let ideal = ideal_at(o); // Math.round(map(o))
        let mut best = ideal;
        if k > 0 {
            let want = prev + hs as i64;
            let (lo, hi) = ((ideal - tol).max(0), (ideal + tol).min(len - 1));
            let mut bs = f64::NEG_INFINITY;
            let mut p = lo;
            while p <= hi { let sc = score(p, want, 8); if sc > bs { bs = sc; best = p; } p += 4; }
            // as lib/stretch.js: the loop's end (best + 3) is checked anew each step, so it climbs on while it improves
            let mut p = lo.max(best - 3);
            while p <= hi.min(best + 3) { let sc = score(p, want, 2); if sc > bs { bs = sc; best = p; } p += 1; }
        }
        for (c, x) in chans.iter().enumerate() {
            let y = &mut out[c];
            for i in 0..n { y[o + i] = (y[o + i] as f64 + at(x, best + i as i64) * win[i] as f64) as f32; }
        }
        for i in 0..n { norm[o + i] = (norm[o + i] as f64 + win[i] as f64) as f32; }
        prev = best;
        k += 1; o += hs;
    }
    out.into_iter().map(|y| (0..out_len).map(|i| if norm[i] as f64 > 1e-3 { (y[i] as f64 / norm[i] as f64) as f32 } else { y[i] }).collect()).collect()
}

/// A clip whose sound keeps its pitch while sped up or slowed, as the export plays it.
pub struct Stretched {
    pub src: usize,
    /// where its sound starts in the source (seconds), how much of the source it plays (seconds), and its speed
    pub inn: f64, pub src_len: f64, pub speed: f64,
    /// the clip's span with crossfade handles (seconds), and its start
    pub cs: f64, pub ce: f64, pub start: f64,
    /// (output frame, gain, left pan gain, right pan gain): where the export reads the gain and pan anew
    pub gains: Vec<(u64, f64, f64, f64)>,
    pub l: Vec<f32>, pub r: Vec<f32>, pub ready: bool,
    /// a time map (Elastic Wave, a retime curve): its points (t, s), the clip's length, and whether it plays like tape
    pub map: Vec<(f64, f64)>, pub dur: f64, pub tape: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_time_map_reads_as_straight_lines_and_carries_on_past_its_ends() {
        let pts = [(0.0, 0.0), (1.0, 2.0), (3.0, 3.0)];
        assert_eq!(map_at(&pts, 0.5), 1.0);
        assert_eq!(map_at(&pts, 2.0), 2.5);
        assert_eq!(map_at(&pts, 4.0), 3.5);
        assert_eq!(map_at(&pts, -1.0), -2.0);
    }
    #[test]
    fn a_sped_up_tone_keeps_its_length_ratio_and_its_level() {
        let rate = 48000.0;
        let n = 1920; let win: Vec<f32> = (0..n).map(|i| (0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / n as f64).cos()) as f32).collect();
        let x: Vec<f32> = (0..48000).map(|i| (0.5 * (i as f64 * 0.05).sin()) as f32).collect();
        let y = stretch(&[x.clone()], 1.5, &win, (0.008f64 * rate).round() as i64);
        assert_eq!(y[0].len(), 32000);
        let peak = y[0][4000..28000].iter().fold(0f32, |m, v| m.max(v.abs()));
        assert!(peak > 0.4 && peak < 0.6, "{peak}");
    }
}
