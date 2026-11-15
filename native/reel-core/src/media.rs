//! Reading sound from a media file, without the browser. WAV is read here in plain Rust (the same way as
//! WavAudio in app/renderer/lib/sources.js, so the numbers match exactly). Everything else (AAC in MP4 / M4A /
//! MOV, MP3, AIFF, CAF…) goes through Apple's own decoder, AudioToolbox's ExtAudioFile, on the Mac.
//!
//! A source hands out the sound in chunks: one Vec<f32> per channel.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

pub struct Info { pub rate: f64, pub channels: usize, pub frames: u64 }

pub trait Source {
    fn info(&self) -> &Info;
    /// The next chunk (up to `max` frames per channel); empty when the sound is over.
    fn read(&mut self, max: usize) -> Result<Vec<Vec<f32>>, String>;
}

/// Opens a media file for its sound: WAV in Rust, anything else through Apple's decoder.
pub fn open(path: &str) -> Result<Box<dyn Source>, String> {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".wav") { return Ok(Box::new(Wav::open(path)?)); }
    #[cfg(target_os = "macos")]
    { return Ok(Box::new(apple::ExtAudio::open(path)?)); }
    #[cfg(not(target_os = "macos"))]
    { Err("only WAV can be read here (other formats use the Mac's decoder)".into()) }
}

// ---------------------------------------------------------------- WAV

pub struct Wav { f: File, info: Info, format: u16, bits: u16, next: u64 }

impl Wav {
    pub fn open(path: &str) -> Result<Wav, String> {
        let mut f = File::open(path).map_err(|e| format!("can't open the file: {e}"))?;
        let size = f.metadata().map_err(|e| e.to_string())?.len();
        let mut head = [0u8; 12];
        f.read_exact(&mut head).map_err(|_| "not a WAV file")?;
        if &head[0..4] != b"RIFF" || &head[8..12] != b"WAVE" { return Err("not a WAV file".into()); }
        let (mut p, mut fmt): (u64, Option<(u16, u16, u32, u16)>) = (12, None);
        for _ in 0..4096 {
            if p + 8 > size { break; }
            f.seek(SeekFrom::Start(p)).map_err(|e| e.to_string())?;
            let mut h = [0u8; 8];
            f.read_exact(&mut h).map_err(|_| "unreadable WAV")?;
            let len = u32::from_le_bytes([h[4], h[5], h[6], h[7]]) as u64;
            if &h[0..4] == b"fmt " {
                let mut b = vec![0u8; len.min(64) as usize];
                f.read_exact(&mut b).map_err(|_| "unreadable WAV")?;
                if b.len() < 16 { return Err("unreadable WAV".into()); }
                let mut format = u16::from_le_bytes([b[0], b[1]]);
                if format == 0xfffe && len >= 26 && b.len() >= 26 { format = u16::from_le_bytes([b[24], b[25]]); }
                fmt = Some((format, u16::from_le_bytes([b[2], b[3]]), u32::from_le_bytes([b[4], b[5], b[6], b[7]]), u16::from_le_bytes([b[14], b[15]])));
            }
            if &h[0..4] == b"data" {
                let (format, channels, rate, bits) = fmt.ok_or("unreadable WAV")?;
                if !((format == 1 && [16, 24, 32].contains(&bits)) || (format == 3 && bits == 32)) { return Err("unsupported WAV encoding".into()); }
                if channels == 0 || channels > 64 || rate == 0 { return Err("unreadable WAV".into()); }
                let data = p + 8;
                let length = if len == 0 { size - data } else { len.min(size - data) };
                let frame = channels as u64 * bits as u64 / 8;
                f.seek(SeekFrom::Start(data)).map_err(|e| e.to_string())?;
                return Ok(Wav { f, format, bits, next: 0, info: Info { rate: rate as f64, channels: channels as usize, frames: length / frame } });
            }
            p += 8 + len + (len & 1);
        }
        Err("unreadable WAV".into())
    }
}

impl Source for Wav {
    fn info(&self) -> &Info { &self.info }
    fn read(&mut self, max: usize) -> Result<Vec<Vec<f32>>, String> {
        let ch = self.info.channels;
        let n = (self.info.frames - self.next).min(max as u64) as usize;
        let mut out: Vec<Vec<f32>> = (0..ch).map(|_| vec![0f32; n]).collect();
        if n == 0 { return Ok(out); }
        let bps = self.bits as usize / 8;
        let mut b = vec![0u8; n * ch * bps];
        self.f.read_exact(&mut b).map_err(|_| "the WAV file ended early")?;
        self.next += n as u64;
        // one loop per encoding (the same conversions as WavAudio.read in lib/sources.js)
        let frames = b.chunks_exact(ch * bps);
        match (self.format, self.bits) {
            (3, _) => for (i, fr) in frames.enumerate() { for c in 0..ch { let p = c * 4; out[c][i] = f32::from_le_bytes([fr[p], fr[p + 1], fr[p + 2], fr[p + 3]]); } },
            (_, 16) => for (i, fr) in frames.enumerate() { for c in 0..ch { let p = c * 2; out[c][i] = (i16::from_le_bytes([fr[p], fr[p + 1]]) as f64 / 32768.0) as f32; } },
            (_, 24) => for (i, fr) in frames.enumerate() { for c in 0..ch { let p = c * 3; out[c][i] = ((((fr[p] as i32) | ((fr[p + 1] as i32) << 8) | ((fr[p + 2] as i32) << 16)) << 8 >> 8) as f64 / 8388608.0) as f32; } },
            _ => for (i, fr) in frames.enumerate() { for c in 0..ch { let p = c * 4; out[c][i] = (i32::from_le_bytes([fr[p], fr[p + 1], fr[p + 2], fr[p + 3]]) as f64 / 2147483648.0) as f32; } },
        }
        Ok(out)
    }
}

// ---------------------------------------------------------------- Apple's decoder (macOS)

#[cfg(target_os = "macos")]
mod apple {
    use super::{Info, Source};
    use std::ffi::c_void;

    type OSStatus = i32;
    type ExtAudioFileRef = *mut c_void;
    type CFURLRef = *const c_void;

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
        fn ExtAudioFileOpenURL(url: CFURLRef, out: *mut ExtAudioFileRef) -> OSStatus;
        fn ExtAudioFileGetProperty(f: ExtAudioFileRef, id: u32, size: *mut u32, data: *mut c_void) -> OSStatus;
        fn ExtAudioFileSetProperty(f: ExtAudioFileRef, id: u32, size: u32, data: *const c_void) -> OSStatus;
        fn ExtAudioFileRead(f: ExtAudioFileRef, frames: *mut u32, list: *mut AudioBufferList) -> OSStatus;
        fn ExtAudioFileDispose(f: ExtAudioFileRef) -> OSStatus;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFURLCreateFromFileSystemRepresentation(alloc: *const c_void, buf: *const u8, len: isize, is_dir: u8) -> CFURLRef;
        fn CFRelease(cf: *const c_void);
    }

    const fn code(s: &[u8; 4]) -> u32 { u32::from_be_bytes(*s) }
    const FILE_FORMAT: u32 = code(b"ffmt");
    const CLIENT_FORMAT: u32 = code(b"cfmt");
    const LENGTH_FRAMES: u32 = code(b"#frm");
    const LPCM: u32 = code(b"lpcm");
    const FLOAT_PACKED: u32 = 1 | 8; // kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked (interleaved)

    pub struct ExtAudio { f: ExtAudioFileRef, info: Info, file_channels: usize, done: bool }

    impl ExtAudio {
        pub fn open(path: &str) -> Result<ExtAudio, String> {
            let url = unsafe { CFURLCreateFromFileSystemRepresentation(std::ptr::null(), path.as_ptr(), path.len() as isize, 0) };
            if url.is_null() { return Err("bad path".into()); }
            let mut f: ExtAudioFileRef = std::ptr::null_mut();
            let st = unsafe { ExtAudioFileOpenURL(url, &mut f) };
            unsafe { CFRelease(url) };
            if st != 0 || f.is_null() { return Err(format!("macOS can't read sound from this file ({st})")); }
            let mut me = ExtAudio { f, info: Info { rate: 0.0, channels: 0, frames: 0 }, file_channels: 0, done: false };
            let mut ff = ASBD::default();
            let mut size = std::mem::size_of::<ASBD>() as u32;
            if unsafe { ExtAudioFileGetProperty(f, FILE_FORMAT, &mut size, &mut ff as *mut _ as *mut c_void) } != 0 || ff.mSampleRate <= 0.0 || ff.mChannelsPerFrame == 0 {
                return Err("macOS can't tell this file's sound format".into());
            }
            let ch = ff.mChannelsPerFrame as usize;
            // the decoded sound, at the file's own rate (nothing resampled), every channel, 32-bit float
            let client = ASBD { mSampleRate: ff.mSampleRate, mFormatID: LPCM, mFormatFlags: FLOAT_PACKED, mBytesPerPacket: 4 * ch as u32, mFramesPerPacket: 1, mBytesPerFrame: 4 * ch as u32, mChannelsPerFrame: ch as u32, mBitsPerChannel: 32, mReserved: 0 };
            if unsafe { ExtAudioFileSetProperty(f, CLIENT_FORMAT, std::mem::size_of::<ASBD>() as u32, &client as *const _ as *const c_void) } != 0 {
                return Err("macOS can't decode this file's sound".into());
            }
            let mut frames: i64 = 0;
            let mut fs = std::mem::size_of::<i64>() as u32;
            unsafe { ExtAudioFileGetProperty(f, LENGTH_FRAMES, &mut fs, &mut frames as *mut _ as *mut c_void) };
            // like the editor's MP4 reader: at most two channels (the first two)
            me.info = Info { rate: ff.mSampleRate, channels: ch.min(2), frames: frames.max(0) as u64 };
            me.file_channels = ch;
            Ok(me)
        }
    }

    impl Source for ExtAudio {
        fn info(&self) -> &Info { &self.info }
        fn read(&mut self, max: usize) -> Result<Vec<Vec<f32>>, String> {
            let (ch, keep) = (self.file_channels, self.info.channels);
            let mut out = vec![Vec::with_capacity(max); keep];
            if self.done { return Ok(out); }
            let mut buf = vec![0f32; max * ch];
            let mut got = 0usize;
            while got < max {
                let mut n = (max - got) as u32;
                let mut list = AudioBufferList { mNumberBuffers: 1, mBuffers: [AudioBuffer { mNumberChannels: ch as u32, mDataByteSize: n * 4 * ch as u32, mData: buf[got * ch..].as_mut_ptr() as *mut c_void }] };
                let st = unsafe { ExtAudioFileRead(self.f, &mut n, &mut list) };
                if st != 0 { return Err(format!("macOS stopped decoding this file ({st})")); }
                if n == 0 { self.done = true; break; }
                got += n as usize;
            }
            for i in 0..got { for (c, o) in out.iter_mut().enumerate() { o.push(buf[i * ch + c]); } }
            Ok(out)
        }
    }

    impl Drop for ExtAudio { fn drop(&mut self) { unsafe { ExtAudioFileDispose(self.f) }; } }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A 16-bit stereo WAV with a known signal, written to a temporary file.
    pub fn write_wav(path: &std::path::Path, rate: u32, frames: usize, f: impl Fn(usize, usize) -> f64) {
        let ch = 2u16;
        let data_len = (frames * ch as usize * 2) as u32;
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF"); b.extend_from_slice(&(36 + data_len).to_le_bytes()); b.extend_from_slice(b"WAVE");
        b.extend_from_slice(b"fmt "); b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes()); b.extend_from_slice(&ch.to_le_bytes()); b.extend_from_slice(&rate.to_le_bytes());
        b.extend_from_slice(&(rate * 4).to_le_bytes()); b.extend_from_slice(&4u16.to_le_bytes()); b.extend_from_slice(&16u16.to_le_bytes());
        b.extend_from_slice(b"data"); b.extend_from_slice(&data_len.to_le_bytes());
        for i in 0..frames { for c in 0..ch as usize { b.extend_from_slice(&((f(i, c) * 32767.0).round().clamp(-32768.0, 32767.0) as i16).to_le_bytes()); } }
        std::fs::write(path, b).unwrap();
    }

    #[test]
    fn a_wav_reads_back_what_was_written() {
        let p = std::env::temp_dir().join(format!("reel-core-test-{}.wav", std::process::id()));
        write_wav(&p, 48000, 4800, |i, c| if c == 0 { 0.5 } else { -(i as f64) / 4800.0 });
        let mut w = open(p.to_str().unwrap()).unwrap();
        assert_eq!((w.info().rate, w.info().channels, w.info().frames), (48000.0, 2, 4800));
        let a = w.read(1000).unwrap();
        assert!((a[0][10] - 0.5).abs() < 1e-4 && a[1][0] == 0.0);
        let mut total = 1000;
        loop { let c = w.read(1000).unwrap(); if c[0].is_empty() { break; } total += c[0].len(); }
        assert_eq!(total, 4800);
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn not_a_wav_is_refused() {
        let p = std::env::temp_dir().join(format!("reel-core-bad-{}.wav", std::process::id()));
        std::fs::write(&p, b"hello, not sound").unwrap();
        assert!(open(p.to_str().unwrap()).is_err());
        std::fs::remove_file(p).ok();
    }
}
