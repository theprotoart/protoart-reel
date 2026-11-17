//! reel-core: ProtoArt Reel's native helper, the first step of moving Reel's heavy work from JavaScript to Rust.
//!
//! One job per run. Reel's main process (app/engine/core.js) starts it, writes the job to stdin and reads one
//! line of JSON from stdout. Jobs are binary, little-endian, so sound needs no conversion:
//!
//!   "RCORE1\n" then a command line ("version\n", "umfind\n", "analyze\n", "mix\n" or "mixloud\n"), then the command's body.
//!
//! analyze body: path (u32 length + UTF-8) of one media file, which it only reads. Answers the file's sample
//!   rate, waveform peaks (100 a second) and loudness profile (K-weighted mean square every 100 ms).
//!
//! umfind body: threshold f64 · words u32 · per word (name: u32 length + UTF-8, prints u32, per print a Print)
//!   · nots u32 + Prints · samples u32 + that many f32 (16 kHz mono).  A Print is frames u32 + frames × 12 f32.
//!
//! Every count is checked against what's left of the input, so a bad job is refused, never trusted.
//! mix body: rate f64 · total u64 · mix gain f64 · limiters u32 + (ceiling f64, release f64) each · soft limit u8 · codec u8 (0 WAV, 1 AAC) · bitrate u32 · output
//!   path · sources u32 + paths · plans u32, each: source u32 · first u64 · last u64 · s0 f64 · speed f64 ·
//!   envelope u32 + that many f32; then (0.7, optional) click sounds: export start f64 · block u32 · click sound u32 +
//!   f32s · clips u32, each start, in, speed, end, offset, gain (f64) · presses u32 + ms f64s. Writes the export's sound to the output path (a new file) and prints
//!   {"progress":…} lines on the way. Paths are u32 length + UTF-8.
//! mixloud body: target LUFS f64 · ceiling gain f64 · release f64 · look-ahead u32 · frames to measure u64, then a mix
//!   body. Measures the mix, turns it to the target and true-peak limits it (lib/master.js); answers the loudness.
//!
//! No network, and no files except the media files a job names (read only) and a mix job's one new output file:
//! all chosen by Reel's main process (the open project's media folder; the export's own temporary file).

mod analyze;
mod media;
mod mix;
mod stretch;
mod fx;
mod master;
mod umvoice;

use std::io::{Read, Write};
use umvoice::{Model, Print, Word, COEFS};

const MAX_INPUT: usize = 1 << 31; // 2 GB: about nine hours of 16 kHz sound

struct Input<'a> { b: &'a [u8], at: usize }

impl<'a> Input<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if n > self.b.len() - self.at { return Err("the job ended early".into()); }
        let s = &self.b[self.at..self.at + n];
        self.at += n;
        Ok(s)
    }
    fn u32(&mut self) -> Result<usize, String> { Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()) as usize) }
    fn f64(&mut self) -> Result<f64, String> { Ok(f64::from_le_bytes(self.take(8)?.try_into().unwrap())) }
    fn u64(&mut self) -> Result<u64, String> { Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap())) }
    fn u8(&mut self) -> Result<u8, String> { Ok(self.take(1)?[0]) }
    fn path(&mut self) -> Result<String, String> {
        let len = self.count(1)?;
        if len == 0 || len > 4096 { return Err("bad path".into()); }
        let p = std::str::from_utf8(self.take(len)?).map_err(|_| "bad path")?;
        if p.contains('\0') || !p.starts_with('/') { return Err("bad path".into()); }
        Ok(p.to_string())
    }
    fn line(&mut self) -> Result<&'a str, String> {
        let rest = &self.b[self.at..];
        let n = rest.iter().take(64).position(|&c| c == b'\n').ok_or("no command")?;
        self.at += n + 1;
        std::str::from_utf8(&rest[..n]).map_err(|_| "bad command".into())
    }
    fn count(&mut self, each: usize) -> Result<usize, String> {
        let n = self.u32()?;
        if n.saturating_mul(each) > self.b.len() - self.at { return Err("a count is larger than the job".into()); }
        Ok(n)
    }
    fn f32s(&mut self, n: usize) -> Result<Vec<f32>, String> {
        Ok(self.take(n * 4)?.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect())
    }
    fn print(&mut self) -> Result<Print, String> {
        let n = self.count(COEFS * 4)?;
        let v = self.f32s(n * COEFS)?;
        Ok(v.chunks_exact(COEFS).map(|c| { let mut f = [0f32; COEFS]; f.copy_from_slice(c); f }).collect())
    }
    fn prints(&mut self) -> Result<Vec<Print>, String> {
        let n = self.count(4)?;
        (0..n).map(|_| self.print()).collect()
    }
}

fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn umfind(inp: &mut Input) -> Result<String, String> {
    let threshold = inp.f64()?;
    if !(threshold > 0.0 && threshold.is_finite()) { return Err("bad threshold".into()); }
    let nw = inp.count(8)?;
    let mut words = Vec::with_capacity(nw);
    for _ in 0..nw {
        let len = inp.count(1)?;
        if len > 64 { return Err("word too long".into()); }
        let word = String::from_utf8(inp.take(len)?.to_vec()).map_err(|_| "bad word")?;
        words.push(Word { word, prints: inp.prints()? });
    }
    let nots = inp.prints()?;
    let n = inp.count(4)?;
    let x = inp.f32s(n)?;
    if x.iter().any(|v| !v.is_finite()) { return Err("the sound has invalid samples".into()); }
    let m = Model { words, nots, threshold };
    let hits = umvoice::find_in_samples(&m, &x);
    let body: Vec<String> = hits.iter().map(|h| format!(
        "{{\"t\":{},\"end\":{},\"word\":{},\"d\":{},\"sure\":{}}}",
        h.t, h.end, json_str(&m.words[h.word].word), h.d, h.sure)).collect();
    Ok(format!("{{\"ok\":true,\"hits\":[{}]}}", body.join(",")))
}

fn floats(v: &[f32]) -> String {
    let mut o = String::with_capacity(v.len() * 8);
    for (i, x) in v.iter().enumerate() { if i > 0 { o.push(','); } o.push_str(&format!("{}", if x.is_finite() { *x } else { 0.0 })); }
    o
}

fn analyze_job(inp: &mut Input) -> Result<String, String> {
    let len = inp.count(1)?;
    if len == 0 || len > 4096 { return Err("bad path".into()); }
    let path = std::str::from_utf8(inp.take(len)?).map_err(|_| "bad path")?;
    if path.contains('\0') { return Err("bad path".into()); }
    let mut src = media::open(path)?;
    let a = analyze::analyze(src.as_mut())?;
    Ok(format!("{{\"ok\":true,\"rate\":{},\"peaks\":[{}],\"steps\":[{}]}}", a.rate, floats(&a.peaks), floats(&a.steps)))
}

fn mix_job(inp: &mut Input, loudness: bool, mastered: bool) -> Result<String, String> {
    // mixloud: the loudness target first (target LUFS · ceiling gain · release · look-ahead u32 · frames measured u64)
    // mixmaster (1.0): whether there's a loudness target u8 first, and after the limiter numbers the built-in
    // master's numbers (u8 on · count u32 + f64s); mixloud (0.6): a target, no master
    let loud = if loudness || mastered {
        let has_target = if mastered { inp.u8()? != 0 } else { true };
        let (target, ceil, rel) = (inp.f64()?, inp.f64()?, inp.f64()?);
        let look = inp.u32()? as usize;
        let measure = inp.u64()?;
        let master = if mastered && inp.u8()? != 0 { let nv = inp.count(8)?; Some((0..nv).map(|_| inp.f64()).collect::<Result<Vec<_>, _>>()?) } else { None };
        if let Some(v) = &master { master::Master::new(v)?; }
        if (has_target && !(target > -70.0 && target < 0.0)) || !(ceil > 0.0 && ceil <= 1.0) || !(0.0..1.0).contains(&rel) || !(1..=4800).contains(&look) { return Err("bad loudness target".into()); }
        Some(mix::Loud { target: if has_target { Some(target) } else { None }, ceil, rel, look, measure, master })
    } else { None };
    let rate = inp.f64()?;
    let total = inp.u64()?;
    let mix_gain = inp.f64()?;
    let nl = inp.count(16)?;
    if nl > 16 { return Err("too many limiters".into()); }
    let mut limiters = Vec::with_capacity(nl);
    for _ in 0..nl {
        let (ceil, rel) = (inp.f64()?, inp.f64()?);
        if !(ceil > 0.0 && ceil <= 4.0 && (0.0..1.0).contains(&rel)) { return Err("bad limiter".into()); }
        limiters.push((ceil, rel));
    }
    let soft = inp.u8()? != 0;
    let codec = inp.u8()?;
    let bitrate = inp.u32()? as u32;
    if !(rate >= 8000.0 && rate <= 192000.0) || total > (rate as u64) * 60 * 60 * 24 || !mix_gain.is_finite() { return Err("bad mix settings".into()); }
    let out = inp.path()?;
    let ns = inp.count(4)?;
    let sources = (0..ns).map(|_| inp.path()).collect::<Result<Vec<_>, _>>()?;
    let np = inp.count(36)?;
    let mut plans = Vec::with_capacity(np);
    for _ in 0..np {
        let src = inp.u32()?;
        let (first, last) = (inp.u64()?, inp.u64()?);
        let (s0, speed) = (inp.f64()?, inp.f64()?);
        let ne = inp.count(4)?;
        let env = inp.f32s(ne)?;
        if src >= sources.len() || last < first || last > total || !s0.is_finite() || !(speed > 0.0 && speed < 100.0) { return Err("bad clip plan".into()); }
        if env.len() < ((last - first).div_ceil(256) as usize + 2) * 2 || env.iter().any(|v| !v.is_finite()) { return Err("a clip's volume plan is too short".into()); }
        plans.push(mix::Plan { src, first, last, s0, speed, env });
    }
    // click sounds (0.7): the export's start, the JavaScript's block size, the click sound, then each clip's clicks
    let mut clicks = mix::Clicks::default();
    if inp.at < inp.b.len() {
        clicks.start = inp.f64()?;
        clicks.block = inp.u32()? as u64;
        let nw = inp.count(4)?;
        clicks.wave = inp.f32s(nw)?;
        let nc = inp.count(56)?;
        for _ in 0..nc {
            let (start, inn, speed, end, offset, gain) = (inp.f64()?, inp.f64()?, inp.f64()?, inp.f64()?, inp.f64()?, inp.f64()?);
            let nm = inp.count(8)?;
            let ms = (0..nm).map(|_| inp.f64()).collect::<Result<Vec<_>, _>>()?;
            if !(speed > 0.0 && speed < 100.0) || ![start, inn, end, offset, gain].iter().all(|v| v.is_finite()) || ms.iter().any(|v| !v.is_finite()) { return Err("bad click plan".into()); }
            clicks.clips.push(mix::ClickClip { start, inn, speed, end, offset, gain, ms });
        }
        if !(1..=65536).contains(&clicks.block) || clicks.wave.len() > 48000 || clicks.wave.iter().any(|v| !v.is_finite()) || !clicks.start.is_finite() { return Err("bad click plan".into()); }
    }
    // clips that keep their pitch (0.8, after the click section): window f32s · tolerance u32 · clips u32, each
    //   source u32 · in f64 · source length f64 · speed f64 · cs f64 · ce f64 · start f64 ·
    //   gains u32 + (frame u64, gain f64, left f64, right f64) · then the order u32 + u32 indexes
    let (mut stretched, mut order, mut win, mut tol) = (Vec::new(), Vec::new(), Vec::new(), 0i64);
    if inp.at < inp.b.len() {
        let nw = inp.count(4)?;
        win = inp.f32s(nw)?;
        tol = inp.u32()? as i64;
        let ns = inp.count(56)?;
        for _ in 0..ns {
            let src = inp.u32()?;
            let (inn, src_len, speed, cs, ce, start) = (inp.f64()?, inp.f64()?, inp.f64()?, inp.f64()?, inp.f64()?, inp.f64()?);
            let ng = inp.count(32)?;
            let mut gains = Vec::with_capacity(ng);
            for _ in 0..ng { gains.push((inp.u64()?, inp.f64()?, inp.f64()?, inp.f64()?)); }
            if src >= sources.len() || !(inn >= 0.0 && inn.is_finite()) || !(src_len > 0.0 && src_len < 3.0 * 3600.0) || !(speed > 0.0 && speed < 100.0)
                || ![cs, ce, start].iter().all(|v| v.is_finite()) || gains.iter().any(|g| !(g.1.is_finite() && g.2.is_finite() && g.3.is_finite())) || gains.windows(2).any(|w| w[1].0 < w[0].0) { return Err("bad stretched clip".into()); }
            stretched.push(stretch::Stretched { src, inn, src_len, speed, cs, ce, start, gains, l: vec![], r: vec![], ready: false, map: vec![], dur: 0.0, tape: false });
        }
        let no = inp.count(4)?;
        for _ in 0..no { let k = inp.u32()?; if k >= plans.len() + stretched.len() { return Err("bad clip order".into()); } order.push(k); }
        if !(win.len() >= 16 && win.len() <= 48000) || win.iter().any(|v| !v.is_finite()) || !(1..=48000).contains(&tol) { return Err("bad stretch settings".into()); }
        if !stretched.is_empty() && clicks.block == 0 { return Err("bad stretch settings".into()); }
    }
    // effects (0.9, after the stretch section): chains u32, each units u32 + (type u8 · numbers u32 + f64s) · the bus:
    //   u8 (0 none, 1 a chain follows) · then for each clip in the order, its chain u32 (0xFFFFFFFF: none)
    let (mut chains, mut bus, mut chain_of) = (Vec::new(), None, Vec::new());
    if inp.at < inp.b.len() {
        let read_chain = |inp: &mut Input| -> Result<Vec<(u8, Vec<f64>)>, String> {
            let nu = inp.count(5)?;
            if nu > 64 { return Err("too many effects".into()); }
            (0..nu).map(|_| { let k = inp.u8()?; let nv = inp.count(8)?; let v = (0..nv).map(|_| inp.f64()).collect::<Result<Vec<_>, _>>()?; if v.iter().any(|x| !x.is_finite()) { return Err("bad effect settings".into()); } fx::Unit::new(k, &v)?; Ok((k, v)) }).collect()
        };
        let nc = inp.count(4)?;
        if nc > 256 { return Err("too many tracks with effects".into()); }
        for _ in 0..nc { chains.push(read_chain(inp)?); }
        if inp.u8()? != 0 { bus = Some(read_chain(inp)?); }
        let n_order = if order.is_empty() { plans.len() } else { order.len() };
        let no = inp.count(4)?;
        if no != n_order { return Err("bad effect routing".into()); }
        for _ in 0..no { let t = inp.u32()?; chain_of.push(if t == u32::MAX as usize { None } else if (t as usize) < chains.len() { Some(t as usize) } else { return Err("bad effect routing".into()) }); }
    }
    // time maps (1.1, after the effects section): for each stretched clip, points u32 (0: none) · then, with points,
    //   tape u8 · the clip's length f64 · points × (t f64, s f64): rising, from (0, 0), as lib/retime.js validRetime
    if inp.at < inp.b.len() {
        for s in stretched.iter_mut() {
            let np = inp.count(16)?;
            if np == 0 { continue; }
            let tape = inp.u8()? != 0;
            let dur = inp.f64()?;
            let pts = (0..np).map(|_| Ok((inp.f64()?, inp.f64()?))).collect::<Result<Vec<_>, String>>()?;
            let ok = np >= 2 && np <= 10000 && dur > 0.0 && dur < 3.0 * 3600.0 && pts.iter().all(|p| p.0.is_finite() && p.1.is_finite())
                && pts[0].0.abs() <= 1e-6 && pts[0].1.abs() <= 1e-6 && pts.windows(2).all(|w| w[1].0 - w[0].0 >= 0.01 && w[1].1 - w[0].1 > 1e-6)
                && (pts[np - 1].1 - s.src_len).abs() < 1e-6;
            if !ok { return Err("bad time map".into()); }
            s.map = pts; s.dur = dur; s.tape = tape;
        }
    }
    let mut job = mix::Job { rate, total, mix_gain, limiters, soft, sources, plans, clicks, stretched, order, win, tol, chain_of, chains, bus };
    job.prepare()?;
    let mut sink: Box<dyn mix::Sink> = match codec {
        0 => Box::new(mix::WavSink::create(&out, rate as u32)?),
        #[cfg(target_os = "macos")]
        1 => Box::new(mix::aac::AacSink::create(&out, rate, bitrate)?),
        _ => return Err(format!("this build can't write that kind of sound ({codec}, {bitrate})")),
    };
    if loud.as_ref().is_some_and(|l| l.measure > total + (rate as u64)) { return Err("bad loudness target".into()); }
    let report = |f: f64| { let mut so = std::io::stdout(); let _ = writeln!(so, "{{\"progress\":{f}}}"); let _ = so.flush(); };
    let result = match &loud { Some(l) => mix::run_loud(&job, l, sink.as_mut(), report).map(Some), None => mix::run(&job, sink.as_mut(), report).map(|_| None) };
    let finished = result.and_then(|m| sink.finish().map(|_| m));
    match finished {
        Err(e) => { let _ = std::fs::remove_file(&out); Err(e) }
        Ok(Some(lufs)) => Ok(format!("{{\"ok\":true,\"frames\":{total},\"loudness\":{}}}", if lufs.is_finite() { format!("{lufs}") } else { "null".into() })),
        Ok(None) => Ok(format!("{{\"ok\":true,\"frames\":{total}}}")),
    }
}

fn run(b: &[u8]) -> Result<String, String> {
    let mut inp = Input { b, at: 0 };
    if inp.take(7)? != b"RCORE1\n" { return Err("not a reel-core job".into()); }
    match inp.line()? {
        "version" => Ok(format!("{{\"ok\":true,\"version\":{}}}", json_str(env!("CARGO_PKG_VERSION")))),
        "umfind" => umfind(&mut inp),
        "analyze" => analyze_job(&mut inp),
        "mix" => mix_job(&mut inp, false, false),
        "mixloud" => mix_job(&mut inp, true, false),
        "mixmaster" => mix_job(&mut inp, false, true),
        other => Err(format!("unknown command {}", other.chars().take(20).collect::<String>())),
    }
}

fn main() {
    let mut b = Vec::new();
    let ok = std::io::stdin().take(MAX_INPUT as u64 + 1).read_to_end(&mut b).is_ok() && b.len() <= MAX_INPUT;
    let out = if ok { run(&b) } else { Err("the job is too large".into()) };
    let line = match out { Ok(s) => s, Err(e) => format!("{{\"ok\":false,\"error\":{}}}", json_str(&e)) };
    let mut so = std::io::stdout().lock();
    let _ = writeln!(so, "{}", line);
    let _ = so.flush();
}
