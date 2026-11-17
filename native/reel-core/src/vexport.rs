//! Exporting the picture (1.10): every frame of an export drawn here and handed straight to the Mac's encoder, so a
//! video export no longer goes through the editor's canvas. Reel's main process starts one decoder per clip
//! (native/reel-frames.swift --rgba: that clip's video, small enough for how big it's shown, as BGRA frames) and the
//! encoder (native/reel-encode.swift), and connects them to this: the decoders' frames come in on file descriptors
//! 3, 4, 5…, the drawn frames go out on stdout to the encoder, and progress and the answer go out on stderr.
//!
//! The job (stdin, all of it before the first frame): the canvas (W, H u32 · background r, g, b u8), the sources
//! (how many u32; each: its descriptor u32, its frames' width and height u32), how many frames u32, then each frame:
//! the sources it shows (how many u32; each: source u32 · the moment of it shown f64), and its layers as the frame
//! job has them (main.rs read_layer), each picture layer naming its source.
//!
//! A decoder's frames: time f64 · width × height × 4 bytes BGRA, to its end. The frame shown for a moment is the last
//! one starting by then (half a 120 fps frame's leeway), as the editor's own decoder picks it (lib/sources.js).

use crate::frame::{self, Picture};
use std::io::{BufReader, Read, Write};

const EPS: f64 = 0.5 / 120.0;

extern "C" { fn fcntl(fd: i32, cmd: i32, ...) -> i32; }
const F_GETFL: i32 = 3;
const F_SETFL: i32 = 4;
#[cfg(target_os = "macos")]
const O_NONBLOCK: i32 = 0x0004;
#[cfg(not(target_os = "macos"))]
const O_NONBLOCK: i32 = 0o4000;

/// Makes a descriptor wait for data instead of failing at once (Node hands its pipes over set not to wait).
pub fn blocking(fd: i32) {
    unsafe {
        let fl = fcntl(fd, F_GETFL);
        if fl >= 0 && fl & O_NONBLOCK != 0 { fcntl(fd, F_SETFL, fl & !O_NONBLOCK); }
    }
}

/// One clip's decoder. Its frames are read on a thread of their own (a few kept ready), so the decoder runs while the
/// frames before are drawn.
pub struct Source {
    rx: std::sync::mpsc::Receiver<Result<Option<(f64, Vec<u8>)>, String>>,
    w: usize,
    h: usize,
    have: bool,
    next: Option<(f64, Vec<u8>)>,
    ended: bool,
}

impl Source {
    pub fn new<R: Read + Send + 'static>(r: R, w: usize, h: usize) -> Source {
        let (tx, rx) = std::sync::mpsc::sync_channel(3);
        std::thread::spawn(move || {
            let mut r = BufReader::with_capacity(1 << 20, r);
            loop {
                let f = read_frame(&mut r, w, h);
                let end = !matches!(f, Ok(Some(_)));
                if tx.send(f).is_err() || end { break; }
            }
        });
        Source { rx, w, h, have: false, next: None, ended: false }
    }
    fn read(&mut self) -> Result<Option<(f64, Vec<u8>)>, String> {
        self.rx.recv().unwrap_or(Ok(None))
    }
    /// Puts the frame shown at moment `st` into `pic` (as RGBA). False when the decoder had no frames at all.
    pub fn frame_at(&mut self, st: f64, pic: &mut Picture) -> Result<bool, String> {
        if !self.have {
            let Some((_, px)) = self.read()? else { return Ok(false) };
            *pic = Picture { w: self.w, h: self.h, rgba: px };
            self.have = true;
        }
        loop {
            if self.next.is_none() && !self.ended {
                self.next = self.read()?;
                if self.next.is_none() { self.ended = true; }
            }
            match &self.next {
                Some((t, _)) if *t <= st + EPS => {
                    let (_, px) = self.next.take().unwrap();
                    *pic = Picture { w: self.w, h: self.h, rgba: px };
                }
                _ => break,
            }
        }
        Ok(true)
    }
}

/// One more moment laid over a motion-blurred frame at opacity a, kept in 8 bits as the canvas does.
fn blend_into(avg: &mut [u8], px: &[u8], a: f64) {
    for (o, &p) in avg.iter_mut().zip(px) { *o = (p as f64 * a + *o as f64 * (1.0 - a)).round().clamp(0.0, 255.0) as u8; }
}

/// A decoder's next frame (made RGBA), or None at its end.
fn read_frame<R: Read>(r: &mut R, w: usize, h: usize) -> Result<Option<(f64, Vec<u8>)>, String> {
    let mut tb = [0u8; 8];
    match r.read(&mut tb[..1]) {
        Ok(0) => return Ok(None),
        Ok(_) => {}
        Err(e) => return Err(format!("couldn't read a clip's frames: {e}")),
    }
    r.read_exact(&mut tb[1..]).map_err(|_| "a clip's frame ended early")?;
    let t = f64::from_le_bytes(tb);
    if !t.is_finite() { return Err("a clip's frame has no time".into()); }
    let mut px = vec![0u8; w * h * 4];
    r.read_exact(&mut px).map_err(|_| "a clip's frame ended early")?;
    for q in px.chunks_exact_mut(4) { q.swap(0, 2); }
    Ok(Some((t, px)))
}

/// One frame of the job: the (source, moment) pairs it shows, and its layers.
/// overlay (1.12): the editor's drawing over this frame comes next on the overlay stream.
pub struct FramePlan { pub uses: Vec<(usize, f64)>, pub layers: Vec<frame::Layer>, pub overlay: bool }

/// Draws every frame, pulling each source's frame from its decoder, and writes them (BGRA) to `out` on a thread of
/// its own (so the encoder takes one frame while the next is drawn). progress(done, total) now and then. Returns how
/// many frames were written.
/// samples (1.13, motion blur): each frame written is the running average of that many plans in a row, as the
/// editor's export lays them one over another (each at 1 / (s + 1), in 8 bits).
#[allow(clippy::too_many_arguments)]
pub fn run<W: Write + Send>(w: usize, h: usize, bg: [u8; 3], sources: &mut [Source], plans: impl Iterator<Item = Result<FramePlan, String>>, total: usize, samples: usize, out: &mut W, mut overlay: Option<&mut dyn Read>, mut progress: impl FnMut(usize, usize)) -> Result<usize, String> {
    let mut pics: Vec<Picture> = sources.iter().map(|_| Picture { w: 0, h: 0, rgba: vec![] }).collect();
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(2);
    std::thread::scope(|sc| {
        let writer = sc.spawn(move || -> Result<(), String> {
            for mut px in rx {
                for q in px.chunks_exact_mut(4) { q.swap(0, 2); } // the encoder takes BGRA
                out.write_all(&px).map_err(|_| "the encoder stopped taking frames")?;
            }
            out.flush().map_err(|_| "the encoder stopped taking frames".to_string())
        });
        let drawn = (|| -> Result<usize, String> {
            let (mut n, mut sub) = (0, 0usize);
            let mut avg: Vec<u8> = Vec::new();
            let mut prev = std::sync::Arc::new(Vec::new());
            let mut last = std::time::Instant::now();
            for plan in plans {
                let plan = plan?;
                for &(s, st) in &plan.uses {
                    if s >= sources.len() || !st.is_finite() { return Err("bad frame".into()); }
                    if !sources[s].frame_at(st, &mut pics[s])? { return Err("a clip's video gave no frames".into()); }
                }
                let steps = if plan.overlay {
                    let r: &mut dyn Read = overlay.as_deref_mut().ok_or_else(|| "no drawing from the editor came".to_string())?;
                    prev = crate::overlay::read(r, w, h, &prev)?;
                    Some(prev.clone())
                } else { None };
                let px = frame::draw_then(w, h, bg, &pics, &plan.layers, |g, acc| { if let Some(s) = &steps { crate::overlay::apply_group(acc, w, h, s, g); } });
                if samples > 1 {
                    if sub == 0 { avg = px; } else { blend_into(&mut avg, &px, 1.0 / (sub + 1) as f64); }
                    sub += 1;
                    if sub < samples { continue; }
                    sub = 0;
                    if tx.send(std::mem::take(&mut avg)).is_err() { break; }
                } else if tx.send(px).is_err() { break; } // the writer stopped: its reason follows
                n += 1;
                if last.elapsed().as_millis() > 400 { last = std::time::Instant::now(); progress(n, total); }
            }
            Ok(n)
        })();
        drop(tx);
        let wrote = writer.join().unwrap_or(Err("the writer stopped".into()));
        let n = drawn?;
        wrote?;
        Ok(n)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn stream(frames: &[(f64, [u8; 4])], w: usize, h: usize) -> Vec<u8> {
        let mut o = vec![];
        for (t, c) in frames { o.extend(t.to_le_bytes()); for _ in 0..w * h { o.extend(c); } }
        o
    }
    #[test]
    fn picks_the_frame_showing_as_the_editor_does() {
        // BGRA: blue, then green, then red frames at 0, 0.1, 0.2
        let data = stream(&[(0.0, [255, 0, 0, 255]), (0.1, [0, 255, 0, 255]), (0.2, [0, 0, 255, 255])], 2, 2);
        let mut s = Source::new(std::io::Cursor::new(data), 2, 2);
        let mut p = Picture { w: 0, h: 0, rgba: vec![] };
        assert!(s.frame_at(0.05, &mut p).unwrap());
        assert_eq!(&p.rgba[0..4], &[0, 0, 255, 255], "blue, as RGBA");
        s.frame_at(0.1 - EPS / 2.0, &mut p).unwrap();
        assert_eq!(&p.rgba[0..4], &[0, 255, 0, 255], "within the leeway: the next one");
        s.frame_at(5.0, &mut p).unwrap();
        assert_eq!(&p.rgba[0..4], &[255, 0, 0, 255], "past the end: the last one");
    }
    #[test]
    fn draws_and_writes_bgra() {
        let data = stream(&[(0.0, [0, 0, 255, 255])], 4, 4); // red
        let mut srcs = vec![Source::new(std::io::Cursor::new(data), 4, 4)];
        let layer = frame::Layer { src: 0, alpha: 1.0, m: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], rect: [0.0, 0.0, 4.0, 4.0], look: None, fill: None, filter: None, grade: None, ink: None, mask: None };
        let plans = vec![Ok(FramePlan { uses: vec![(0, 0.0)], layers: vec![layer], overlay: false })];
        let mut out = vec![];
        let n = run(4, 4, [0, 0, 0], &mut srcs, plans.into_iter(), 1, 1, &mut out, None, |_, _| {}).unwrap();
        assert_eq!(n, 1);
        assert_eq!(&out[0..4], &[0, 0, 255, 255], "red, as BGRA");
    }
    #[test]
    fn motion_blur_averages_the_moments() {
        // four moments a frame: black, white, white, white (fills), averaged as the canvas lays them one on another
        let fill = |v: u8| frame::fill_layer([v, v, v], 1.0);
        let plans: Vec<Result<FramePlan, String>> = [0u8, 255, 255, 255, 255, 255, 255, 255].iter().map(|&v| Ok(FramePlan { uses: vec![], layers: vec![fill(v)], overlay: false })).collect();
        let mut out = vec![];
        let n = run(2, 2, [0, 0, 0], &mut [], plans.into_iter(), 2, 4, &mut out, None, |_, _| {}).unwrap();
        assert_eq!(n, 2, "two frames written");
        // 0, then 255 at ½ → 128, at ⅓ → 170, at ¼ → 191
        assert_eq!(out[0], 191);
        assert_eq!(out[2 * 2 * 4], 255, "the second frame: all white");
    }
}
