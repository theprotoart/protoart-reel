//! reel-core: ProtoArt Reel's native helper, the first step of moving Reel's heavy work from JavaScript to Rust.
//!
//! One job per run. Reel's main process (app/engine/core.js) starts it, writes the job to stdin and reads one
//! line of JSON from stdout. Jobs are binary, little-endian, so sound needs no conversion:
//!
//!   "RCORE1\n" then a command line ("version\n", "umfind\n", "analyze\n", "mp4info\n", "mix\n", "mixloud\n" or "mixmaster\n"), then the command's body.
//!
//! mp4info body (1.2): path (u32 length + UTF-8) of one video file, which it only reads. Answers its tracks and every
//!   sample's place and timing (the first part of picture export: the core reading video files itself).
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
mod mp4;
mod frame;
mod grade;
mod media;
mod mix;
mod stretch;
mod fx;
mod master;
mod umvoice;
mod watch;

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

/// mp4info (1.2): a video file's tracks and every sample's place and timing, as lib/mp4.js demux reads them.
fn mp4_job(inp: &mut Input) -> Result<String, String> {
    let len = inp.count(1)?;
    if len == 0 || len > 4096 { return Err("bad path".into()); }
    let path = std::str::from_utf8(inp.take(len)?).map_err(|_| "bad path")?;
    if path.contains('\0') { return Err("bad path".into()); }
    let mv = mp4::demux(path)?;
    let num = |x: f64| if x.is_finite() { format!("{}", x) } else { "null".into() };
    let hex = |v: &Vec<u8>| v.iter().map(|b| format!("{:02x}", b)).collect::<String>();
    let tracks: Vec<String> = mv.tracks.iter().map(|t| {
        let samples: Vec<String> = t.samples.iter().map(|s| format!("[{},{},{},{},{},{}]", s.offset, s.size, s.dts, s.pts, s.duration, s.sync as u8)).collect();
        format!("{{\"id\":{},\"kind\":\"{}\",\"timescale\":{},\"codec\":{},\"description\":{},\"supported\":{},\"rotation\":{},\"fourcc\":{},\"width\":{},\"height\":{},\"pixelAspect\":{},\"channels\":{},\"sampleSize\":{},\"sampleRate\":{},\"pcmBits\":{},\"mediaTime\":{},\"emptyLead\":{},\"startTime\":{},\"duration\":{},\"origin\":{},\"samples\":[{}]}}",
            t.id, if t.video { "video" } else { "audio" }, t.timescale, t.codec.as_deref().map(json_str).unwrap_or("null".into()), t.description.as_ref().map(|d| json_str(&hex(d))).unwrap_or("null".into()),
            t.supported, t.rotation, json_str(&t.fourcc), t.width, t.height, t.pixel_aspect.map(num).unwrap_or("null".into()), t.channels, t.sample_size, num(t.sample_rate),
            t.pcm_bits.map(|b| b.to_string()).unwrap_or("null".into()), t.media_time, num(t.empty_lead), num(t.start_time), num(t.duration), t.origin, samples.join(","))
    }).collect();
    Ok(format!("{{\"ok\":true,\"duration\":{},\"tracks\":[{}]}}", num(mv.duration), tracks.join(",")))
}

/// mp4head (1.2): the head (ftyp, moov, mdat header) the muxer writes for a list of encoded frames, as hex; how the
/// writer is checked against lib/mp4.js Muxer. Body: video u8 (codec · width u32 · height u32 · timescale u32 ·
/// description) · audio u8 (codec · sample rate u32 · channels u32 · bitrate u32 · description) · frames u32, each
/// video u8 · size u32 · timestamp f64 µs · duration f64 µs · key u8. Strings and descriptions are u32 length + bytes.
fn mp4head_job(inp: &mut Input) -> Result<String, String> {
    let text = |inp: &mut Input| -> Result<String, String> { let n = inp.count(1)?; if n > 64 { return Err("bad codec".into()); } String::from_utf8(inp.take(n)?.to_vec()).map_err(|_| "bad codec".into()) };
    let blob = |inp: &mut Input| -> Result<Vec<u8>, String> { let n = inp.count(1)?; if n > 65536 { return Err("bad description".into()); } Ok(inp.take(n)?.to_vec()) };
    let video = if inp.u8()? != 0 {
        let codec = text(inp)?; let (width, height, timescale) = (inp.u32()? as u32, inp.u32()? as u32, inp.u32()? as u32);
        if width == 0 || height == 0 || width > 16384 || height > 16384 { return Err("bad picture size".into()); }
        Some(mp4::VideoCfg { codec, width, height, timescale, description: blob(inp)? })
    } else { None };
    let audio = if inp.u8()? != 0 {
        let codec = text(inp)?; let (sample_rate, channels, bitrate) = (inp.u32()? as u32, inp.u32()? as u32, inp.u32()? as u32);
        if !(8000..=192000).contains(&sample_rate) || !(1..=8).contains(&channels) { return Err("bad sound settings".into()); }
        Some(mp4::AudioCfg { codec, sample_rate, channels, bitrate, description: blob(inp)? })
    } else { None };
    let mut m = mp4::Muxer::new(video, audio);
    let n = inp.count(22)?;
    for _ in 0..n {
        let v = inp.u8()? != 0; let size = inp.u32()? as u32; let (ts, dur) = (inp.f64()?, inp.f64()?); let key = inp.u8()? != 0;
        if !ts.is_finite() || !dur.is_finite() { return Err("bad frame time".into()); }
        m.add(v, size, ts, dur, key)?;
    }
    let head = m.finish();
    Ok(format!("{{\"ok\":true,\"head\":\"{}\"}}", head.iter().map(|b| format!("{:02x}", b)).collect::<String>()))
}

/// frame (1.3): draws one frame from lib/frameplan.js layers and writes its pixels (RGBA, row by row) to a new file.
/// Body: width u32 · height u32 · background r, g, b u8 · pictures u32, each width u32 · height u32 · RGBA bytes ·
/// layers u32, each picture u32 · alpha f64 · matrix 6 × f64 · shown part 4 × f64 · look u8 (1.4: 1, then the box's
/// matrix 6 × f64 · its width and height · corner radius · border width f64 · border colour r, g, b u8 · shadow blur ·
/// shadow drop f64 · cut to the box u8 (1.5); 0, none). A layer whose picture is 0xFFFFFFFF (1.5) is a colour over
/// the whole canvas: alpha, then r, g, b u8. After a picture's look, its filter (1.6): u8 1, then blur px, brightness,
/// saturation f64 (0: none). Then the output path.
fn frame_job(inp: &mut Input) -> Result<String, String> {
    let (w, h) = (inp.u32()?, inp.u32()?);
    if w == 0 || h == 0 || w > 8192 || h > 8192 { return Err("bad frame size".into()); }
    let bg = [inp.u8()?, inp.u8()?, inp.u8()?];
    let np = inp.count(8)?;
    if np > 64 { return Err("too many pictures".into()); }
    let mut pictures = Vec::with_capacity(np);
    for _ in 0..np {
        let (pw, ph) = (inp.u32()?, inp.u32()?);
        if pw == 0 || ph == 0 || pw > 16384 || ph > 16384 { return Err("bad picture size".into()); }
        pictures.push(frame::Picture { w: pw, h: ph, rgba: inp.take(pw * ph * 4)?.to_vec() });
    }
    let nl = inp.count(4 + 8 + 3)?;
    let mut layers = Vec::with_capacity(nl);
    for _ in 0..nl {
        let src = inp.u32()?;
        let alpha = inp.f64()?;
        // 1.5: a colour over the whole canvas (a dip to black or white): r, g, b u8 instead of a picture's place
        if src == u32::MAX as usize {
            let rgb = [inp.u8()?, inp.u8()?, inp.u8()?];
            if !(0.0..=1.0).contains(&alpha) { return Err("bad layer".into()); }
            layers.push(frame::fill_layer(rgb, alpha));
            continue;
        }
        let mut m = [0.0; 6]; for v in m.iter_mut() { *v = inp.f64()?; }
        let mut rect = [0.0; 4]; for v in rect.iter_mut() { *v = inp.f64()?; }
        if src >= pictures.len() || !(0.0..=1.0).contains(&alpha) || m.iter().chain(rect.iter()).any(|v| !v.is_finite()) || rect[2] <= rect[0] || rect[3] <= rect[1] { return Err("bad layer".into()); }
        // 1.4: how its box looks (rounded corners, border, shadow), when it has more than a plain picture
        let look = if inp.u8()? == 1 {
            let mut b = [0.0; 6]; for v in b.iter_mut() { *v = inp.f64()?; }
            let (bw, bh, radius, border) = (inp.f64()?, inp.f64()?, inp.f64()?, inp.f64()?);
            let border_rgb = [inp.u8()?, inp.u8()?, inp.u8()?];
            let (shadow, dy) = (inp.f64()?, inp.f64()?);
            let cut = inp.u8()? == 1;
            let ok = b.iter().chain([bw, bh, radius, border, shadow, dy].iter()).all(|v| v.is_finite()) && bw > 0.0 && bh > 0.0 && (0.0..=4096.0).contains(&radius) && (0.0..=512.0).contains(&border) && (0.0..=1024.0).contains(&shadow) && dy.abs() <= 1024.0;
            if !ok { return Err("bad layer look".into()); }
            Some(frame::Look { b, w: bw, h: bh, radius, border, border_rgb, shadow, dy, cut })
        } else { None };
        // 1.6: the canvas filter it's drawn with: u8 1, then blur px · brightness · saturation f64; 0, none
        let filter = if inp.u8()? == 1 {
            let (blur, bright, sat) = (inp.f64()?, inp.f64()?, inp.f64()?);
            if !(0.0..=500.0).contains(&blur) || !(0.0..=20.0).contains(&bright) || !(0.0..=20.0).contains(&sat) { return Err("bad layer filter".into()); }
            Some(frame::Filter { blur, bright, sat })
        } else { None };
        // 1.7: its filters (the GPU pass's colour work): u8 1, then the size it's graded at (w, h u32), exposure,
        // contrast, saturation, vibrance, temperature, tint, highlights, shadows, in black, in white, gamma, out black,
        // out white, brightness, sharpen, vignette, b&w, aberration f64, key u8 (1: r, g, b, tolerance, softness,
        // spill f64), colour match × 3, add × 3, lift × 3, gamma × 3, gain × 3 f64; 0, none
        let grade = if inp.u8()? == 1 {
            let (gw, gh) = (inp.u32()?, inp.u32()?);
            if gw == 0 || gh == 0 || gw > 16384 || gh > 16384 { return Err("bad grade size".into()); }
            let mut v = [0.0; 18]; for x in v.iter_mut() { *x = inp.f64()?; }
            let key = if inp.u8()? == 1 { let mut k = [0.0; 6]; for x in k.iter_mut() { *x = inp.f64()?; } Some(([k[0], k[1], k[2]], k[3], k[4], k[5])) } else { None };
            let mut t = [0.0; 15]; for x in t.iter_mut() { *x = inp.f64()?; }
            if v.iter().chain(t.iter()).any(|x| !x.is_finite()) { return Err("bad grade".into()); }
            let three = |i: usize| [t[i], t[i + 1], t[i + 2]];
            Some(grade::Grade { gw, gh, exposure: v[0], contrast: v[1], saturation: v[2], vibrance: v[3], temperature: v[4], tint: v[5], highlights: v[6], shadows: v[7],
                in_black: v[8], in_white: v[9], gamma_v: v[10], out_black: v[11], out_white: v[12], brightness: v[13], sharpen: v[14], vignette: v[15], bw: v[16], aberr: v[17],
                key, m_mul: three(0), m_add: three(3), lift: three(6), gam: three(9), gain: three(12) })
        } else { None };
        layers.push(frame::Layer { src, alpha, m, rect, look, fill: None, filter, grade });
    }
    let out = inp.path()?;
    let px = frame::draw(w, h, bg, &pictures, &layers);
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&out).map_err(|e| format!("can't write the file: {e}"))?;
    f.write_all(&px).map_err(|e| e.to_string())?;
    Ok("{\"ok\":true}".into())
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
        "mp4info" => mp4_job(&mut inp),
        "mp4head" => mp4head_job(&mut inp),
        "frame" => frame_job(&mut inp),
        "mix" => mix_job(&mut inp, false, false),
        "mixloud" => mix_job(&mut inp, true, false),
        "mixmaster" => mix_job(&mut inp, false, true),
        other => Err(format!("unknown command {}", other.chars().take(20).collect::<String>())),
    }
}

/// vwatch (1.8): read as it comes, frame by frame (a long video's frames are far too many to hold), so it streams
/// rather than reading the whole job first. Body: gw u32 · gh u32 · pw u32 · ph u32 · give up f64 (s; 0 never), then
/// frames to the end: t f64 · flags u8 (1: a sample frame) · gw × gh bytes · on a sample frame, pw × ph bytes.
/// Prints {"progress": t} now and then, and answers the samples and the pointer's track (watch.rs).
fn vwatch(r: &mut impl Read) -> Result<String, String> {
    let mut head = [0u8; 24];
    r.read_exact(&mut head).map_err(|_| "the job ended early")?;
    let u = |i: usize| u32::from_le_bytes(head[i..i + 4].try_into().unwrap()) as usize;
    let (gw, gh, pw, ph) = (u(0), u(4), u(8), u(12));
    let give_up = f64::from_le_bytes(head[16..24].try_into().unwrap());
    if !(3..=256).contains(&gw) || !(3..=256).contains(&gh) || pw > 3840 || ph > 2160 || (pw == 0) != (ph == 0) || (pw > 0 && (pw < 64 || ph < 64)) {
        return Err("bad watch job".into());
    }
    let mut w = watch::Watcher::new(watch::Watch { gw, gh, pw, ph, give_up: if give_up.is_finite() { give_up } else { 0.0 } });
    let (mut grid, mut big) = (vec![0u8; gw * gh], vec![0u8; pw * ph]);
    let mut fh = [0u8; 9];
    let mut last = std::time::Instant::now();
    let mut lt = f64::NEG_INFINITY;
    loop {
        // a clean end is between frames
        match r.read(&mut fh[..1]) { Ok(0) => break, Ok(_) => {}, Err(_) => return Err("couldn't read the frames".into()) }
        r.read_exact(&mut fh[1..]).map_err(|_| "a frame ended early")?;
        let t = f64::from_le_bytes(fh[0..8].try_into().unwrap());
        let sample = fh[8] & 1 != 0;
        if !t.is_finite() || t < lt - 1e-9 { return Err("frames out of order".into()); }
        lt = t;
        r.read_exact(&mut grid).map_err(|_| "a frame ended early")?;
        let p = if sample && pw > 0 { r.read_exact(&mut big).map_err(|_| "a frame ended early")?; Some(&big[..]) } else { None };
        w.frame(t, sample, &grid, p);
        if w.frames > 2_000_000 { return Err("too many frames".into()); }
        if last.elapsed().as_millis() > 400 {
            last = std::time::Instant::now();
            let mut so = std::io::stdout().lock();
            let _ = writeln!(so, "{{\"progress\":{t}}}");
            let _ = so.flush();
        }
    }
    Ok(w.answer())
}

fn main() {
    let mut stdin = std::io::stdin().lock();
    // the first line says the command; vwatch streams, the rest read their whole job first
    let mut head = Vec::new();
    let mut c = [0u8; 1];
    while head.len() < 7 + 64 && stdin.read(&mut c).map(|n| n == 1).unwrap_or(false) {
        head.push(c[0]);
        if head.len() > 7 && c[0] == b'\n' { break; }
    }
    let out = if head == b"RCORE1\nvwatch\n" { vwatch(&mut stdin) } else {
        let mut b = head;
        let ok = (&mut stdin).take(MAX_INPUT as u64 + 1).read_to_end(&mut b).is_ok() && b.len() <= MAX_INPUT;
        if ok { run(&b) } else { Err("the job is too large".into()) }
    };
    let line = match out { Ok(s) => s, Err(e) => format!("{{\"ok\":false,\"error\":{}}}", json_str(&e)) };
    let mut so = std::io::stdout().lock();
    let _ = writeln!(so, "{}", line);
    let _ = so.flush();
}
