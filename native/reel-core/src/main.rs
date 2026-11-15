//! reel-core: ProtoArt Reel's native helper, the first step of moving Reel's heavy work from JavaScript to Rust.
//!
//! One job per run. Reel's main process (app/engine/core.js) starts it, writes the job to stdin and reads one
//! line of JSON from stdout. Jobs are binary, little-endian, so sound needs no conversion:
//!
//!   "RCORE1\n" then a command line ("version\n", "umfind\n" or "analyze\n"), then the command's body.
//!
//! analyze body: path (u32 length + UTF-8) of one media file, which it only reads. Answers the file's sample
//!   rate, waveform peaks (100 a second) and loudness profile (K-weighted mean square every 100 ms).
//!
//! umfind body: threshold f64 · words u32 · per word (name: u32 length + UTF-8, prints u32, per print a Print)
//!   · nots u32 + Prints · samples u32 + that many f32 (16 kHz mono).  A Print is frames u32 + frames × 12 f32.
//!
//! Every count is checked against what's left of the input, so a bad job is refused, never trusted.
//! No network, and no files except the one media file an analyze job names (read only, chosen by Reel's main
//! process from the open project's media folder).

mod analyze;
mod media;
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

fn run(b: &[u8]) -> Result<String, String> {
    let mut inp = Input { b, at: 0 };
    if inp.take(7)? != b"RCORE1\n" { return Err("not a reel-core job".into()); }
    match inp.line()? {
        "version" => Ok(format!("{{\"ok\":true,\"version\":{}}}", json_str(env!("CARGO_PKG_VERSION")))),
        "umfind" => umfind(&mut inp),
        "analyze" => analyze_job(&mut inp),
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
