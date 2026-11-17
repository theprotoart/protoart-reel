//! MP4 / MOV reading, step for step as lib/mp4.js `demux` (the first part of picture export, step 5: the core reading
//! video files itself, so it can decode them through VideoToolbox and, later, write the export). Reads the sample
//! tables of regular and fragmented MP4/MOV files: each track's codec in WebCodecs form (avc1.*, hvc1.*,
//! mp4a.40.*) with its decoder description, and every sample's position, timing and keyframe flag. Only the box
//! headers, the moov box and the moof boxes are read, so large files are never loaded whole.

use std::io::{Read, Seek, SeekFrom};

#[derive(Clone, Debug, PartialEq)]
pub struct Sample { pub offset: u64, pub size: u32, pub dts: i64, pub pts: i64, pub duration: u32, pub sync: bool }

#[derive(Clone, Debug, Default)]
pub struct Track {
    pub id: u32, pub video: bool, pub timescale: u32, pub codec: Option<String>, pub description: Option<Vec<u8>>,
    pub supported: bool, pub rotation: i32, pub fourcc: String,
    pub width: u32, pub height: u32, pub pixel_aspect: Option<f64>,
    pub channels: u32, pub sample_size: u32, pub sample_rate: f64, pub pcm_bits: Option<u32>,
    pub media_time: i64, pub empty_lead: f64, pub samples: Vec<Sample>,
    pub start_time: f64, pub duration: f64, pub origin: i64,
}

pub struct Movie { pub duration: f64, pub tracks: Vec<Track> }

const MAX_BOX: u64 = 1 << 30; // a moov or moof bigger than 1 GB isn't a real video

fn u16b(b: &[u8], o: usize) -> u32 { b.get(o..o + 2).map(|x| u16::from_be_bytes([x[0], x[1]]) as u32).unwrap_or(0) }
fn u32b(b: &[u8], o: usize) -> u32 { b.get(o..o + 4).map(|x| u32::from_be_bytes([x[0], x[1], x[2], x[3]])).unwrap_or(0) }
fn i32b(b: &[u8], o: usize) -> i32 { u32b(b, o) as i32 }
fn u64b(b: &[u8], o: usize) -> u64 { (u32b(b, o) as u64) << 32 | u32b(b, o + 4) as u64 }
fn byte(b: &[u8], o: usize) -> u8 { b.get(o).copied().unwrap_or(0) }
fn type4(b: &[u8], o: usize) -> [u8; 4] { let mut t = [0u8; 4]; if let Some(x) = b.get(o..o + 4) { t.copy_from_slice(x); } t }

#[derive(Clone, Copy)]
struct Bx { kind: [u8; 4], body: usize, end: usize }

/// Child boxes inside [start, end) of a buffer (stops at the first that doesn't fit, as the JavaScript does).
fn boxes(b: &[u8], start: usize, end: usize) -> Vec<Bx> {
    let mut out = vec![];
    let mut p = start;
    let end = end.min(b.len());
    while p + 8 <= end {
        let mut size = u32b(b, p) as u64;
        let kind = type4(b, p + 4);
        let mut header = 8u64;
        if size == 1 { size = u64b(b, p + 8); header = 16; } else if size == 0 { size = (end - p) as u64; }
        if size < header || p as u64 + size > end as u64 { break; }
        out.push(Bx { kind, body: p + header as usize, end: p + size as usize });
        p += size as usize;
    }
    out
}
fn child(b: &[u8], bx: Bx, kind: &[u8; 4]) -> Option<Bx> { boxes(b, bx.body, bx.end).into_iter().find(|c| &c.kind == kind) }
fn children(b: &[u8], bx: Bx, kind: &[u8; 4]) -> Vec<Bx> { boxes(b, bx.body, bx.end).into_iter().filter(|c| &c.kind == kind).collect() }

fn avc_codec(c: &[u8]) -> String { format!("avc1.{:02x}{:02x}{:02x}", byte(c, 1), byte(c, 2), byte(c, 3)) }

fn hevc_codec(h: &[u8], fourcc: &str) -> String {
    let (space, tier, profile) = (byte(h, 1) >> 6, (byte(h, 1) >> 5) & 1, byte(h, 1) & 31);
    let mut compat = u32b(h, 2);
    let mut rev: u32 = 0;
    for _ in 0..32 { rev = (rev << 1) | (compat & 1); compat >>= 1; }
    let mut cons: Vec<u8> = (6..12).map(|i| byte(h, i)).collect();
    while cons.last() == Some(&0) { cons.pop(); }
    let mut parts = vec![fourcc.to_string(), format!("{}{}", ["", "A", "B", "C"][space as usize], profile), format!("{:x}", rev), format!("{}{}", if tier == 1 { 'H' } else { 'L' }, byte(h, 12))];
    parts.extend(cons.iter().map(|c| format!("{:X}", c)));
    parts.join(".")
}

/// An MPEG-4 descriptor length (1–4 bytes of 7 bits): (length, bytes used).
fn desc_len(b: &[u8], p: usize) -> (usize, usize) {
    let (mut len, mut n) = (0usize, 0usize);
    loop { let c = byte(b, p + n); len = (len << 7) | (c & 0x7f) as usize; n += 1; if c & 0x80 == 0 || n == 4 { break; } }
    (len, n)
}

/// The AudioSpecificConfig out of an esds box body (after version and flags).
fn esds_config(b: &[u8], mut p: usize, end: usize) -> Option<Vec<u8>> {
    while p < end {
        let tag = byte(b, p);
        let (len, n) = desc_len(b, p + 1);
        let mut q = p + 1 + n;
        if tag == 3 { let fl = byte(b, q + 2); q += 3; if fl & 0x80 != 0 { q += 2; } if fl & 0x40 != 0 { q += 1 + byte(b, q) as usize; } if fl & 0x20 != 0 { q += 2; } p = q; continue; }
        if tag == 4 { let oti = byte(b, q); p = q + 13; if oti != 0x40 && oti != 0x66 && oti != 0x67 { return None; } continue; }
        if tag == 5 { return Some(b.get(q..(q + len).min(b.len())).unwrap_or(&[]).to_vec()); }
        p = q + len;
    }
    None
}

fn aac_codec(asc: &[u8]) -> String {
    let mut aot = (byte(asc, 0) >> 3) as u32;
    if aot == 31 { aot = 32 + ((((byte(asc, 0) & 7) as u32) << 3) | (byte(asc, 1) >> 5) as u32); }
    format!("mp4a.40.{}", aot)
}

/// Math.round
fn js_round(x: f64) -> f64 { (x + 0.5).floor() }

/// Opens an MP4/MOV and reads its tracks (only video and sound ones), as lib/mp4.js `demux`.
pub fn demux(path: &str) -> Result<Movie, String> {
    let mut f = std::fs::File::open(path).map_err(|e| format!("can’t open the file: {e}"))?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    let mut read = |at: u64, n: u64| -> Result<Vec<u8>, String> {
        let n = n.min(size.saturating_sub(at));
        let mut v = vec![0u8; n as usize];
        f.seek(SeekFrom::Start(at)).map_err(|e| e.to_string())?;
        f.read_exact(&mut v).map_err(|e| e.to_string())?;
        Ok(v)
    };
    let (mut p, mut moov, mut moofs) = (0u64, None, vec![]);
    while p + 8 <= size {
        let h = read(p, 16)?;
        let mut bsize = u32b(&h, 0) as u64;
        let kind = type4(&h, 4);
        if bsize == 1 { bsize = u64b(&h, 8); } else if bsize == 0 { bsize = size - p; }
        if bsize < 8 { break; }
        if &kind == b"moov" { if bsize > MAX_BOX { return Err("the file’s index is too big".into()); } moov = Some(read(p, bsize)?); }
        else if &kind == b"moof" { if bsize > MAX_BOX { return Err("the file’s index is too big".into()); } moofs.push((p, read(p, bsize)?)); }
        p += bsize;
    }
    let moov = moov.ok_or("Not a playable MP4/MOV file (no moov)")?;
    let b = &moov[..];
    let root = Bx { kind: *b"moov", body: 8, end: b.len() };
    let mv_timescale = match child(b, root, b"mvhd") { Some(h) => if byte(b, h.body) == 1 { u32b(b, h.body + 20) } else { u32b(b, h.body + 12) }, None => 1000 };
    let mut trex = std::collections::HashMap::new();
    if let Some(mvex) = child(b, root, b"mvex") {
        for t in children(b, mvex, b"trex") { let q = t.body + 4; trex.insert(u32b(b, q), (u32b(b, q + 8), u32b(b, q + 12), u32b(b, q + 16))); }
    }
    let mut tracks: Vec<Track> = children(b, root, b"trak").into_iter().filter_map(|t| read_trak(b, t, mv_timescale)).collect();
    if !moofs.is_empty() { add_fragments(&moofs, &mut tracks, &trex); }
    for t in tracks.iter_mut() { finish_track(t); }
    let duration = tracks.iter().map(|t| t.duration).fold(0.0, f64::max);
    Ok(Movie { duration, tracks })
}

fn read_trak(b: &[u8], trak: Bx, mv_timescale: u32) -> Option<Track> {
    let tkhd = child(b, trak, b"tkhd")?;
    let mdia = child(b, trak, b"mdia")?;
    let v = byte(b, tkhd.body);
    let id = u32b(b, tkhd.body + if v == 1 { 20 } else { 12 });
    let mdhd = child(b, mdia, b"mdhd");
    let handler = child(b, mdia, b"hdlr").map(|h| type4(b, h.body + 8)).unwrap_or([0; 4]);
    let video = &handler == b"vide";
    if !video && &handler != b"soun" { return None; }
    let mdhd = mdhd?;
    let timescale = if byte(b, mdhd.body) == 1 { u32b(b, mdhd.body + 20) } else { u32b(b, mdhd.body + 12) };
    let m = tkhd.body + if v == 1 { 52 } else { 40 };
    let (a, bb) = (i32b(b, m) as f64 / 65536.0, i32b(b, m + 4) as f64 / 65536.0);
    let rotation = (js_round(bb.atan2(a) * 180.0 / std::f64::consts::PI + 360.0) as i64 % 360) as i32;
    let mut t = Track { id, video, timescale, rotation, ..Default::default() };
    if let Some(elst) = child(b, trak, b"edts").and_then(|e| child(b, e, b"elst")) {
        let (ev, n) = (byte(b, elst.body), u32b(b, elst.body + 4));
        let (mut q, mut lead) = (elst.body + 8, 0.0);
        for _ in 0..n {
            let seg = if ev == 1 { u64b(b, q) as f64 } else { u32b(b, q) as f64 };
            let mt: i64 = if ev == 1 { u64b(b, q + 8) as i64 } else { i32b(b, q + 4) as i64 };
            q += if ev == 1 { 20 } else { 12 };
            if mt == -1 { lead += seg / mv_timescale as f64; continue; }
            t.media_time = mt; break;
        }
        t.empty_lead = lead;
    }
    let stbl = child(b, mdia, b"minf").and_then(|m| child(b, m, b"stbl"))?;
    if let Some(stsd) = child(b, stbl, b"stsd") { read_stsd(b, stsd, &mut t); }
    read_sample_tables(b, stbl, &mut t);
    Some(t)
}

fn read_stsd(b: &[u8], stsd: Bx, t: &mut Track) {
    let Some(entry) = boxes(b, stsd.body + 8, stsd.end).into_iter().next() else { return };
    t.fourcc = String::from_utf8_lossy(&entry.kind).into_owned();
    if t.video {
        t.width = u16b(b, entry.body + 24);
        t.height = u16b(b, entry.body + 26);
        for c in boxes(b, entry.body + 78, entry.end) {
            let body = b[c.body..c.end].to_vec();
            if &c.kind == b"avcC" { t.codec = Some(avc_codec(&body)); t.description = Some(body); }
            else if &c.kind == b"hvcC" { t.codec = Some(hevc_codec(&body, if &entry.kind == b"hev1" { "hev1" } else { "hvc1" })); t.description = Some(body); }
            else if &c.kind == b"pasp" { let d = u32b(b, c.body + 4); t.pixel_aspect = Some(u32b(b, c.body) as f64 / if d == 0 { 1.0 } else { d as f64 }); }
        }
    } else {
        let version = u16b(b, entry.body + 8);
        t.channels = u16b(b, entry.body + 16);
        t.sample_size = u16b(b, entry.body + 18);
        t.sample_rate = (u32b(b, entry.body + 24) >> 16) as f64;
        let mut inner = entry.body + 28;
        if version == 1 { inner += 16; } else if version == 2 {
            inner += 36;
            t.sample_rate = f64::from_bits(u64b(b, entry.body + 32));
            t.channels = u32b(b, entry.body + 40);
        }
        if &entry.kind == b"mp4a" {
            for c in boxes(b, inner, entry.end) {
                let esds = if &c.kind == b"esds" { Some(c) } else if &c.kind == b"wave" { child(b, c, b"esds") } else { None };
                if let Some(e) = esds {
                    if let Some(asc) = esds_config(b, e.body + 4, e.end) { if !asc.is_empty() { t.codec = Some(aac_codec(&asc)); t.description = Some(asc); } }
                }
            }
        } else if &entry.kind == b"Opus" { t.codec = Some("opus".into()); }
        else if [b"sowt", b"twos", b"lpcm", b"ipcm", b"fpcm", b"in24", b"in32", b"fl32", b"raw "].contains(&&entry.kind) {
            t.codec = Some("pcm".into());
            t.pcm_bits = Some(if &entry.kind == b"in24" { 24 } else if &entry.kind == b"in32" || &entry.kind == b"fl32" { 32 } else if t.sample_size != 0 { t.sample_size } else { 16 });
        }
    }
    t.supported = t.codec.is_some();
}

fn read_sample_tables(b: &[u8], stbl: Bx, t: &mut Track) {
    let mut sizes: Vec<u32> = vec![];
    if let Some(stsz) = child(b, stbl, b"stsz") {
        let (fixed, n) = (u32b(b, stsz.body + 4), u32b(b, stsz.body + 8) as usize);
        let n = if fixed != 0 { n.min(1 << 28) } else { n.min((stsz.end.saturating_sub(stsz.body + 12)) / 4) };
        for i in 0..n { sizes.push(if fixed != 0 { fixed } else { u32b(b, stsz.body + 12 + i * 4) }); }
    } else if let Some(stz2) = child(b, stbl, b"stz2") {
        let (bits, n) = (byte(b, stz2.body + 7), (u32b(b, stz2.body + 8) as usize).min(stz2.end.saturating_sub(stz2.body + 12) * 2));
        let q = stz2.body + 12;
        for i in 0..n { sizes.push(match bits { 16 => u16b(b, q + i * 2), 8 => byte(b, q + i) as u32, _ => ((byte(b, q + (i >> 1)) >> if i & 1 == 1 { 0 } else { 4 }) & 15) as u32 }); }
    }
    let n = sizes.len();
    if n == 0 { return; }
    let mut chunks: Vec<u64> = vec![];
    if let Some(stco) = child(b, stbl, b"stco") { let c = (u32b(b, stco.body + 4) as usize).min(stco.end.saturating_sub(stco.body + 8) / 4); for i in 0..c { chunks.push(u32b(b, stco.body + 8 + i * 4) as u64); } }
    if let Some(co64) = child(b, stbl, b"co64") { let c = (u32b(b, co64.body + 4) as usize).min(co64.end.saturating_sub(co64.body + 8) / 8); for i in 0..c { chunks.push(u64b(b, co64.body + 8 + i * 8)); } }
    let mut runs: Vec<(u64, u32)> = vec![];
    if let Some(stsc) = child(b, stbl, b"stsc") { let c = (u32b(b, stsc.body + 4) as usize).min(stsc.end.saturating_sub(stsc.body + 8) / 12); for i in 0..c { let q = stsc.body + 8 + i * 12; runs.push((u32b(b, q) as u64, u32b(b, q + 4))); } }
    let mut offsets: Vec<Option<u64>> = vec![None; n];
    let mut s = 0usize;
    'runs: for r in 0..runs.len() {
        if s >= n { break; }
        let last = if r + 1 < runs.len() { runs[r + 1].0 as i64 - 1 } else { chunks.len() as i64 };
        let mut c = runs[r].0 as i64;
        while c <= last && s < n {
            // a chunk the table doesn't have: the JavaScript's offsets go missing from here (and it stops there)
            let mut off = if c >= 1 { chunks.get((c - 1) as usize).copied() } else { None };
            for _ in 0..runs[r].1 {
                if s >= n { break; }
                offsets[s] = off; off = off.map(|o| o + sizes[s] as u64); s += 1;
            }
            c += 1;
            if c - runs[r].0 as i64 > 1 << 32 { break 'runs; }
        }
    }
    let mut durs: Vec<u32> = vec![];
    if let Some(stts) = child(b, stbl, b"stts") {
        let c = (u32b(b, stts.body + 4) as usize).min(stts.end.saturating_sub(stts.body + 8) / 8);
        for i in 0..c { let (cnt, d) = (u32b(b, stts.body + 8 + i * 8), u32b(b, stts.body + 12 + i * 8)); for _ in 0..cnt { if durs.len() >= n { break; } durs.push(d); } }
    }
    while durs.len() < n { let l = durs.last().copied().unwrap_or(1); durs.push(if l == 0 { 1 } else { l }); }
    let mut offs = vec![0i64; n];
    if let Some(ctts) = child(b, stbl, b"ctts") {
        let c = (u32b(b, ctts.body + 4) as usize).min(ctts.end.saturating_sub(ctts.body + 8) / 8);
        let mut k = 0;
        for i in 0..c {
            let cnt = u32b(b, ctts.body + 8 + i * 8);
            let o = i32b(b, ctts.body + 12 + i * 8) as i64; // signed in practice, even in version 0
            for _ in 0..cnt { if k >= n { break; } offs[k] = o; k += 1; }
        }
    }
    let sync: Option<std::collections::HashSet<i64>> = child(b, stbl, b"stss").map(|stss| {
        let c = (u32b(b, stss.body + 4) as usize).min(stss.end.saturating_sub(stss.body + 8) / 4);
        (0..c).map(|i| u32b(b, stss.body + 8 + i * 4) as i64 - 1).collect()
    });
    let mut dts = 0i64;
    for i in 0..n {
        let Some(off) = offsets[i] else { break };
        t.samples.push(Sample { offset: off, size: sizes[i], dts, pts: dts + offs[i], duration: durs[i], sync: sync.as_ref().map(|s| s.contains(&(i as i64))).unwrap_or(true) });
        dts += durs[i] as i64;
    }
}

fn add_fragments(moofs: &[(u64, Vec<u8>)], tracks: &mut [Track], trex: &std::collections::HashMap<u32, (u32, u32, u32)>) {
    let mut next: std::collections::HashMap<u32, i64> = tracks.iter().map(|t| (t.id, t.samples.last().map(|s| s.dts + s.duration as i64).unwrap_or(0))).collect();
    for (start, b) in moofs {
        let root = Bx { kind: *b"moof", body: 8, end: b.len() };
        for traf in children(b, root, b"traf") {
            let Some(tfhd) = child(b, traf, b"tfhd") else { continue };
            let fl = u32b(b, tfhd.body) & 0xffffff;
            let id = u32b(b, tfhd.body + 4);
            let Some(t) = tracks.iter_mut().find(|t| t.id == id) else { continue };
            let (mut d_dur, mut d_size, mut d_flags) = trex.get(&id).copied().unwrap_or((0, 0, 0));
            let (mut q, mut base) = (tfhd.body + 8, *start);
            if fl & 1 != 0 { base = u64b(b, q); q += 8; }
            if fl & 2 != 0 { q += 4; }
            if fl & 8 != 0 { d_dur = u32b(b, q); q += 4; }
            if fl & 0x10 != 0 { d_size = u32b(b, q); q += 4; }
            if fl & 0x20 != 0 { d_flags = u32b(b, q); }
            let mut dts = match child(b, traf, b"tfdt") { Some(x) => if byte(b, x.body) == 1 { u64b(b, x.body + 4) as i64 } else { u32b(b, x.body + 4) as i64 }, None => *next.get(&id).unwrap_or(&0) };
            for trun in children(b, traf, b"trun") {
                let (tf, cnt) = (u32b(b, trun.body) & 0xffffff, u32b(b, trun.body + 4) as usize);
                let (mut r, mut off) = (trun.body + 8, base as i64);
                if tf & 1 != 0 { off = base as i64 + i32b(b, r) as i64; r += 4; }
                let mut first = None;
                if tf & 4 != 0 { first = Some(u32b(b, r)); r += 4; }
                let per = [0x100, 0x200, 0x400, 0x800].iter().filter(|&&f| tf & f != 0).count() * 4;
                let cnt = if per > 0 { cnt.min(trun.end.saturating_sub(r) / per) } else { cnt.min(1 << 24) };
                for i in 0..cnt {
                    let (mut dur, mut size, mut flags, mut cto) = (d_dur, d_size, if i == 0 { first.unwrap_or(d_flags) } else { d_flags }, 0i64);
                    if tf & 0x100 != 0 { dur = u32b(b, r); r += 4; }
                    if tf & 0x200 != 0 { size = u32b(b, r); r += 4; }
                    if tf & 0x400 != 0 { flags = u32b(b, r); r += 4; }
                    if tf & 0x800 != 0 { cto = i32b(b, r) as i64; r += 4; } // signed, whatever the box version says
                    t.samples.push(Sample { offset: off.max(0) as u64, size, dts, pts: dts + cto, duration: dur, sync: (flags >> 16) & 1 == 0 });
                    off += size as i64; dts += dur as i64;
                }
            }
            next.insert(id, dts);
        }
    }
}

fn finish_track(t: &mut Track) {
    if t.samples.is_empty() { t.duration = 0.0; t.start_time = 0.0; return; }
    let (mut end, mut first) = (i64::MIN, i64::MAX);
    for x in &t.samples { end = end.max(x.pts + x.duration as i64); first = first.min(x.pts); }
    let end = end.max(0); // Math.max(0, …) as the JavaScript starts from 0
    let origin = t.media_time;
    let ts = if t.timescale == 0 { f64::NAN } else { t.timescale as f64 };
    t.start_time = t.empty_lead + (first - origin) as f64 / ts;
    t.duration = t.empty_lead + (end - origin) as f64 / ts;
    t.origin = origin;
}

// ------------------------------------------------------------------ writing (lib/mp4.js Muxer, byte for byte)

pub struct VideoCfg { pub codec: String, pub width: u32, pub height: u32, pub timescale: u32, pub description: Vec<u8> }
#[allow(dead_code)] // (the codec is always AAC, mp4a, as in the JavaScript)
pub struct AudioCfg { pub codec: String, pub sample_rate: u32, pub channels: u32, pub bitrate: u32, pub description: Vec<u8> }

struct MSample { offset: u64, size: u32, pts: i64, dur: i64, key: bool, dts: i64, cto: i64 }
struct MTrack { video: bool, id: u32, timescale: u32, samples: Vec<MSample> }

/// A standard (non-fragmented) MP4 for encoded frames: their data goes into the mdat body as it comes (in order), and
/// `finish` gives the head (ftyp, moov with 64-bit chunk offsets, the mdat header) that goes in front of it.
pub struct Muxer { video: Option<VideoCfg>, audio: Option<AudioCfg>, tracks: Vec<MTrack>, offset: u64 }

fn bx(kind: &[u8; 4], parts: &[&[u8]]) -> Vec<u8> {
    let size: usize = 8 + parts.iter().map(|p| p.len()).sum::<usize>();
    let mut o = Vec::with_capacity(size);
    o.extend_from_slice(&(size as u32).to_be_bytes()); o.extend_from_slice(kind);
    for p in parts { o.extend_from_slice(p); }
    o
}
fn fullbx(kind: &[u8; 4], version: u8, flags: u32, parts: &[&[u8]]) -> Vec<u8> {
    let head = [version, (flags >> 16) as u8, (flags >> 8) as u8, flags as u8];
    let mut all: Vec<&[u8]> = vec![&head]; all.extend_from_slice(parts);
    bx(kind, &all)
}
/// [bits, value] pairs as big-endian bytes; like the JavaScript, 32 and 16 bits keep the value's low bits (`>>>`)
fn be(vals: &[(u32, i64)]) -> Vec<u8> {
    let mut o = vec![];
    for &(bits, v) in vals {
        if bits == 64 { o.extend_from_slice(&(v as u64).to_be_bytes()); continue; }
        let u = v as u32;
        let mut sh = bits as i32 - 8;
        while sh >= 0 { o.push((u >> sh) as u8); sh -= 8; }
    }
    o
}
fn matrix() -> Vec<u8> { be(&[(32, 0x10000), (32, 0), (32, 0), (32, 0), (32, 0x10000), (32, 0), (32, 0), (32, 0), (32, 0x40000000)]) }
fn descriptor(tag: u8, body: &[u8]) -> Vec<u8> {
    let len = body.len();
    let mut o = vec![tag, 0x80 | ((len >> 21) & 127) as u8, 0x80 | ((len >> 14) & 127) as u8, 0x80 | ((len >> 7) & 127) as u8, (len & 127) as u8];
    o.extend_from_slice(body);
    o
}

impl Muxer {
    pub fn new(video: Option<VideoCfg>, audio: Option<AudioCfg>) -> Muxer {
        let mut tracks = vec![];
        if let Some(v) = &video { tracks.push(MTrack { video: true, id: 1, timescale: if v.timescale == 0 { 90000 } else { v.timescale }, samples: vec![] }); }
        if let Some(a) = &audio { tracks.push(MTrack { video: false, id: if video.is_some() { 2 } else { 1 }, timescale: a.sample_rate, samples: vec![] }); }
        Muxer { video, audio, tracks, offset: 0 }
    }
    /// One encoded frame (or block of sound): its size, timestamp and duration in µs, keyframe. Its bytes are the next
    /// ones in the mdat body.
    pub fn add(&mut self, video: bool, size: u32, timestamp: f64, duration: f64, key: bool) -> Result<(), String> {
        let off = self.offset;
        let t = self.tracks.iter_mut().find(|t| t.video == video).ok_or(if video { "No video track" } else { "No audio track" })?;
        let ts = t.timescale as f64;
        let pts = js_round(timestamp * ts / 1e6) as i64;
        let dur = if duration != 0.0 && !duration.is_nan() { js_round(duration * ts / 1e6) as i64 } else { 0 };
        t.samples.push(MSample { offset: off, size, pts, dur, key, dts: 0, cto: 0 });
        self.offset += size as u64;
        Ok(())
    }
    /// The head: ftyp, moov, and the mdat header (64-bit size) for the bytes added so far.
    pub fn finish(&mut self) -> Vec<u8> {
        let ftyp = bx(b"ftyp", &[b"isom", &be(&[(32, 0x200)]), b"isomiso2avc1mp41"]);
        let total = 16 + self.offset;
        let mut mdat = vec![0, 0, 0, 1]; mdat.extend_from_slice(b"mdat"); mdat.extend_from_slice(&total.to_be_bytes());
        let probe = self.moov(0);
        let base = (ftyp.len() + probe.len() + 16) as u64;
        let moov = self.moov(base);
        let mut head = ftyp; head.extend_from_slice(&moov); head.extend_from_slice(&mdat);
        head
    }
    fn timing(t: &mut MTrack) -> (i64, i64, i64) {
        let s = &mut t.samples;
        let mut sorted: Vec<i64> = s.iter().map(|x| x.pts).collect();
        sorted.sort();
        let mut shift = 0i64;
        for i in 0..s.len() { shift = shift.max(sorted[i] - s[i].pts); }
        for i in 0..s.len() {
            let d = sorted[i] - shift;
            s[i].dts = d; s[i].cto = s[i].pts - d;
            if s[i].dur == 0 { s[i].dur = if i + 1 < s.len() { (sorted[i + 1] - sorted[i]).max(1) } else if i > 0 { s[i - 1].dur } else { 1 }; }
        }
        if s.is_empty() { return (0, 0, 0); }
        let (mut min_pts, mut max_end) = (i64::MAX, 0i64);
        for x in s.iter() { min_pts = min_pts.min(x.pts); max_end = max_end.max(x.pts + x.dur); }
        let d0 = sorted[0] - shift;
        (max_end - d0, max_end - min_pts, min_pts - d0)
    }
    fn moov(&mut self, base: u64) -> Vec<u8> {
        const MOVIE_TS: i64 = 1000;
        let mut traks = vec![];
        let mut movie_dur = 0i64;
        for i in 0..self.tracks.len() {
            let (media_dur, pres_dur, start) = Muxer::timing(&mut self.tracks[i]);
            let ts = self.tracks[i].timescale as f64;
            let dur = js_round(pres_dur as f64 * MOVIE_TS as f64 / ts) as i64;
            movie_dur = movie_dur.max(dur);
            traks.push(self.trak(i, base, media_dur, dur, start));
        }
        let mvhd = fullbx(b"mvhd", 0, 0, &[&be(&[(32, 0), (32, 0), (32, MOVIE_TS), (32, movie_dur), (32, 0x10000), (16, 0x100), (16, 0), (32, 0), (32, 0)]),
            &matrix(), &[0u8; 24], &be(&[(32, self.tracks.len() as i64 + 1)])]);
        let mut parts: Vec<&[u8]> = vec![&mvhd];
        for t in &traks { parts.push(t); }
        bx(b"moov", &parts)
    }
    fn trak(&self, i: usize, base: u64, media_dur: i64, movie_dur: i64, start: i64) -> Vec<u8> {
        let t = &self.tracks[i];
        let (w, h) = self.video.as_ref().map(|v| (v.width as i64, v.height as i64)).unwrap_or((0, 0));
        let tkhd = fullbx(b"tkhd", 0, 3, &[&be(&[(32, 0), (32, 0), (32, t.id as i64), (32, 0), (32, movie_dur), (32, 0), (32, 0), (16, 0), (16, 0), (16, if t.video { 0 } else { 0x100 }), (16, 0)]),
            &matrix(), &be(&[(32, if t.video { w * 65536 } else { 0 }), (32, if t.video { h * 65536 } else { 0 })])]);
        let elst = fullbx(b"elst", 0, 0, &[&be(&[(32, 1), (32, movie_dur), (32, start), (16, 1), (16, 0)])]);
        let mdhd = fullbx(b"mdhd", 0, 0, &[&be(&[(32, 0), (32, 0), (32, t.timescale as i64), (32, media_dur), (16, 0x55c4), (16, 0)])]);
        let hdlr = fullbx(b"hdlr", 0, 0, &[&be(&[(32, 0)]), if t.video { b"vide" } else { b"soun" }, &[0u8; 12], if t.video { b"VideoHandler\0" as &[u8] } else { b"SoundHandler\0" }]);
        let xmhd = if t.video { fullbx(b"vmhd", 0, 1, &[&[0u8; 8]]) } else { fullbx(b"smhd", 0, 0, &[&[0u8; 4]]) };
        let dinf = bx(b"dinf", &[&fullbx(b"dref", 0, 0, &[&be(&[(32, 1)]), &fullbx(b"url ", 0, 1, &[])])]);
        let mut stbl_parts = vec![self.stsd(t)];
        stbl_parts.extend(Muxer::tables(t, base));
        let stbl = bx(b"stbl", &stbl_parts.iter().map(|x| x.as_slice()).collect::<Vec<_>>());
        let minf = bx(b"minf", &[&xmhd, &dinf, &stbl]);
        let mdia = bx(b"mdia", &[&mdhd, &hdlr, &minf]);
        bx(b"trak", &[&tkhd, &bx(b"edts", &[&elst]), &mdia])
    }
    fn stsd(&self, t: &MTrack) -> Vec<u8> {
        let entry = if t.video {
            let c = self.video.as_ref().unwrap();
            let hevc = c.codec.starts_with("hvc1") || c.codec.starts_with("hev1");
            let fields = be(&[(32, 0), (16, 0), (16, 1), (16, 0), (16, 0), (32, 0), (32, 0), (32, 0), (16, c.width as i64), (16, c.height as i64), (32, 0x480000), (32, 0x480000), (32, 0), (16, 1)]);
            let cfg = bx(if hevc { b"hvcC" } else { b"avcC" }, &[&c.description]);
            let mut colr = b"nclx".to_vec(); colr.extend(be(&[(16, 1), (16, 1), (16, 1), (8, 0)]));
            bx(if hevc { b"hvc1" } else { b"avc1" }, &[&fields, &[0u8; 32], &be(&[(16, 0x18), (16, 0xffff)]), &cfg, &bx(b"colr", &[&colr]), &bx(b"pasp", &[&be(&[(32, 1), (32, 1)])])])
        } else {
            let c = self.audio.as_ref().unwrap();
            let br = if c.bitrate == 0 { 192000 } else { c.bitrate } as i64;
            let dsi = descriptor(5, &c.description);
            let mut dcd_body = vec![0x40, 0x15, 0, 0, 0]; dcd_body.extend(be(&[(32, br), (32, br)])); dcd_body.extend(&dsi);
            let dcd = descriptor(4, &dcd_body);
            let mut esd_body = vec![0, 1, 0]; esd_body.extend(&dcd); esd_body.extend(descriptor(6, &[2]));
            let esd = descriptor(3, &esd_body);
            bx(b"mp4a", &[&be(&[(32, 0), (16, 0), (16, 1), (32, 0), (32, 0), (16, c.channels as i64), (16, 16), (16, 0), (16, 0), (32, (c.sample_rate as i64) << 16)]), &fullbx(b"esds", 0, 0, &[&esd])])
        };
        fullbx(b"stsd", 0, 0, &[&be(&[(32, 1)]), &entry])
    }
    fn tables(t: &MTrack, base: u64) -> Vec<Vec<u8>> {
        let s = &t.samples;
        let runs = |get: &dyn Fn(&MSample) -> i64| -> Vec<(u32, i64)> {
            let mut r: Vec<(u32, i64)> = vec![];
            for x in s { let v = get(x); match r.last_mut() { Some(l) if l.1 == v => l.0 += 1, _ => r.push((1, v)) } }
            r
        };
        let table = |rows: usize, fill: &mut dyn FnMut(&mut Vec<u8>, usize)| -> Vec<u8> { let mut o = (rows as u32).to_be_bytes().to_vec(); for i in 0..rows { fill(&mut o, i); } o };
        let mut out = vec![];
        let stts = runs(&|x| x.dur);
        out.push(fullbx(b"stts", 0, 0, &[&table(stts.len(), &mut |o, i| { o.extend((stts[i].0).to_be_bytes()); o.extend((stts[i].1 as u32).to_be_bytes()); })]));
        if s.iter().any(|x| x.cto != 0) {
            let ct = runs(&|x| x.cto);
            out.push(fullbx(b"ctts", 1, 0, &[&table(ct.len(), &mut |o, i| { o.extend((ct[i].0).to_be_bytes()); o.extend((ct[i].1 as i32).to_be_bytes()); })]));
        }
        if t.video && s.iter().any(|x| !x.key) {
            let keys: Vec<u32> = s.iter().enumerate().filter(|(_, x)| x.key).map(|(i, _)| i as u32 + 1).collect();
            out.push(fullbx(b"stss", 0, 0, &[&table(keys.len(), &mut |o, i| o.extend(keys[i].to_be_bytes()))]));
        }
        // one chunk per run of consecutive samples (interleaving splits runs)
        let mut chunks: Vec<(u64, u32, u64)> = vec![];
        for x in s { match chunks.last_mut() { Some(l) if l.2 == x.offset => { l.1 += 1; l.2 += x.size as u64; } _ => chunks.push((x.offset, 1, x.offset + x.size as u64)) } }
        let mut stsc: Vec<(u32, u32)> = vec![];
        for (i, c) in chunks.iter().enumerate() { if stsc.last().map(|l| l.1 != c.1).unwrap_or(true) { stsc.push((i as u32 + 1, c.1)); } }
        out.push(fullbx(b"stsc", 0, 0, &[&table(stsc.len(), &mut |o, i| { o.extend(stsc[i].0.to_be_bytes()); o.extend(stsc[i].1.to_be_bytes()); o.extend(1u32.to_be_bytes()); })]));
        out.push(fullbx(b"stsz", 0, 0, &[&be(&[(32, 0)]), &table(s.len(), &mut |o, i| o.extend(s[i].size.to_be_bytes()))]));
        out.push(fullbx(b"co64", 0, 0, &[&table(chunks.len(), &mut |o, i| o.extend((base + chunks[i].0).to_be_bytes()))]));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codec_strings_read_as_webcodecs_writes_them() {
        assert_eq!(avc_codec(&[1, 0x64, 0, 0x28]), "avc1.640028");
        // Main profile, level 4.0, constraint byte 0x90: hvc1.1.6.L120.90
        let h = [1u8, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 120];
        assert_eq!(hevc_codec(&h, "hvc1"), "hvc1.1.6.L120.90");
        assert_eq!(aac_codec(&[0x12, 0x10]), "mp4a.40.2");
    }
    #[test]
    fn what_the_muxer_writes_reads_back() {
        let avcc = vec![1u8, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80];
        let mut m = Muxer::new(Some(VideoCfg { codec: "avc1.640028".into(), width: 1920, height: 1080, timescale: 90000, description: avcc.clone() }),
            Some(AudioCfg { codec: "mp4a.40.2".into(), sample_rate: 48000, channels: 2, bitrate: 192000, description: vec![0x11, 0x90] }));
        let mut body = vec![];
        for i in 0..30u32 {
            let n = 100 + i * 7; m.add(true, n, i as f64 * 1e6 / 30.0, 1e6 / 30.0, i % 10 == 0).unwrap(); body.extend(vec![i as u8; n as usize]);
            let a = 20 + i; m.add(false, a, i as f64 * 1024.0 * 1e6 / 48000.0, 1024.0 * 1e6 / 48000.0, true).unwrap(); body.extend(vec![0xa0; a as usize]);
        }
        let mut file = m.finish(); file.extend(&body);
        let p = std::env::temp_dir().join(format!("reel-mux-{}.mp4", std::process::id()));
        std::fs::write(&p, &file).unwrap();
        let mv = demux(p.to_str().unwrap()).unwrap();
        let _ = std::fs::remove_file(&p);
        assert_eq!(mv.tracks.len(), 2);
        let v = &mv.tracks[0];
        assert_eq!((v.codec.as_deref(), v.width, v.height, v.samples.len()), (Some("avc1.640028"), 1920, 1080, 30));
        assert_eq!(v.description.as_ref().unwrap(), &avcc);
        assert_eq!(v.samples.iter().filter(|s| s.sync).count(), 3);
        // every frame's bytes are where the index says
        for (i, s) in v.samples.iter().enumerate() { assert_eq!(file[s.offset as usize], i as u8); assert_eq!(s.size, 100 + i as u32 * 7); }
        assert_eq!(mv.tracks[1].codec.as_deref(), Some("mp4a.40.2"));
        assert!((mv.duration - 1.0).abs() < 0.01, "{}", mv.duration);
    }
    #[test]
    fn a_file_that_isnt_an_mp4_is_refused() {
        let p = std::env::temp_dir().join(format!("reel-mp4-{}.bin", std::process::id()));
        std::fs::write(&p, b"hello, this is not a movie at all").unwrap();
        assert!(demux(p.to_str().unwrap()).is_err());
        let _ = std::fs::remove_file(p);
    }
}
