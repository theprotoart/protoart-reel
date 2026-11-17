// reel-frames: a video's frames, read by the Mac's own decoder (AVFoundation, on the media engine) as fast as it
// can go, made small and grey for Auto Edit and Smart Zoom to watch. Reel's main process pipes them straight into
// reel-core (vwatch), so watching a video no longer waits on the editor playing it at 8–16×.
//
//   reel-frames <file> <from s> <to s> <step s> <gw> <gh> <pw> <ph>
//
// Writes to stdout, for every frame from..to: time f64 · flags u8 (1: a sample frame, about every step seconds) ·
// gw × gh greyscale bytes · and on a sample frame, when pw > 0, pw × ph greyscale bytes (little-endian). The grey
// is the picture's own brightness (luma). Reads only the file it's given; writes nothing but stdout. Exits 0 when
// done, 2 with a reason on stderr when the file can't be read.
//
//   reel-frames --rgba <file> <from s> <to s> <w> <h>
//
// (1.10, exporting through reel-core) every frame from just before `from` to just after `to`, in colour, made w × h:
// time f64 · w × h × 4 bytes BGRA (straight, opaque for video), to the end. A still picture gives its one frame.
import AVFoundation
import Accelerate
import Foundation
import ImageIO

func die(_ msg: String) -> Never { FileHandle.standardError.write((msg + "\n").data(using: .utf8)!); exit(2) }

let a = CommandLine.arguments
signal(SIGPIPE, SIG_IGN) // Reel stopped listening: just stop

/// --rgba: each frame in colour at the size the export draws it from.
func rgbaFrames() -> Never {
    guard a.count == 7, a[2].hasPrefix("/"), let from = Double(a[3]), let to = Double(a[4]), let w = Int(a[5]), let h = Int(a[6]),
          from >= 0, to > from, (2...8192).contains(w), (2...8192).contains(h)
    else { die("usage: reel-frames --rgba file from to w h") }
    let asset = AVURLAsset(url: URL(fileURLWithPath: a[2]))
    // a still picture (a photo, a logo, a screenshot): one frame, the right way up, then done
    guard let track = asset.tracks(withMediaType: .video).first else { stillFrame(a[2], w, h) }
    guard let reader = try? AVAssetReader(asset: asset) else { die("this video can't be read") }
    // from a moment early, so the frame already showing at `from` comes too
    let start = max(0, from - 0.5)
    reader.timeRange = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 600), end: CMTime(seconds: to + 0.5, preferredTimescale: 600))
    let out = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    out.alwaysCopiesSampleData = false
    guard reader.canAdd(out) else { die("this video can't be read") }
    reader.add(out)
    guard reader.startReading() else { die(reader.error?.localizedDescription ?? "this video can't be read") }
    var px = [UInt8](repeating: 0, count: w * h * 4)
    var buf = Data(capacity: w * h * 4 + 8)
    let output = FileHandle.standardOutput
    var lastT = -Double.infinity
    while reader.status == .reading, let sb = out.copyNextSampleBuffer() {
        guard let ib = CMSampleBufferGetImageBuffer(sb) else { continue }
        let t = CMSampleBufferGetPresentationTimeStamp(sb).seconds
        if !t.isFinite || t <= lastT { continue } // in order, once each
        lastT = t
        CVPixelBufferLockBaseAddress(ib, .readOnly)
        var src = vImage_Buffer(data: CVPixelBufferGetBaseAddress(ib), height: vImagePixelCount(CVPixelBufferGetHeight(ib)),
                                width: vImagePixelCount(CVPixelBufferGetWidth(ib)), rowBytes: CVPixelBufferGetBytesPerRow(ib))
        px.withUnsafeMutableBytes { p in
            var d = vImage_Buffer(data: p.baseAddress, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: w * 4)
            _ = vImageScale_ARGB8888(&src, &d, nil, vImage_Flags(kvImageHighQualityResampling))
        }
        CVPixelBufferUnlockBaseAddress(ib, .readOnly)
        buf.removeAll(keepingCapacity: true)
        var tt = t
        withUnsafeBytes(of: &tt) { buf.append(contentsOf: $0) }
        buf.append(contentsOf: px)
        do { try output.write(contentsOf: buf) } catch { exit(0) }
        if t > to + 0.25 { break }
    }
    if reader.status == .failed { die(reader.error?.localizedDescription ?? "the video stopped reading part way") }
    exit(0)
}
/// --rgba on a picture: its one frame (time 0), w × h, BGRA with straight (not premultiplied) alpha, as the core takes it.
func stillFrame(_ path: String, _ w: Int, _ h: Int) -> Never {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { die("this picture can't be read") }
    let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                 kCGImageSourceThumbnailMaxPixelSize: max(w, h) * 2]
    guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { die("this picture can't be read") }
    var px = [UInt8](repeating: 0, count: w * h * 4)
    let ok = px.withUnsafeMutableBytes { p -> Bool in
        guard let ctx = CGContext(data: p.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return false }
        ctx.interpolationQuality = .high
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        var b = vImage_Buffer(data: p.baseAddress, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: w * 4)
        return vImageUnpremultiplyData_BGRA8888(&b, &b, vImage_Flags(kvImageNoFlags)) == kvImageNoError
    }
    if !ok { die("this picture can't be drawn") }
    var out = Data(capacity: w * h * 4 + 8)
    var t = 0.0
    withUnsafeBytes(of: &t) { out.append(contentsOf: $0) }
    out.append(contentsOf: px)
    do { try FileHandle.standardOutput.write(contentsOf: out) } catch { exit(0) }
    exit(0)
}
if a.count > 1 && a[1] == "--rgba" { rgbaFrames() }

guard a.count == 9, a[1].hasPrefix("/"),
      let from = Double(a[2]), let to = Double(a[3]), let step = Double(a[4]),
      let gw = Int(a[5]), let gh = Int(a[6]), let pw = Int(a[7]), let ph = Int(a[8]),
      from >= 0, to > from, step > 0, (3...256).contains(gw), (3...256).contains(gh), pw >= 0, pw <= 3840, ph >= 0, ph <= 2160
else { die("usage: reel-frames file from to step gw gh pw ph") }

let asset = AVURLAsset(url: URL(fileURLWithPath: a[1]))
// (the older synchronous call: a command-line tool has nothing else to do while it waits)
guard let track = asset.tracks(withMediaType: .video).first else { die("no video in this file") }
guard let reader = try? AVAssetReader(asset: asset) else { die("this video can't be read") }
reader.timeRange = CMTimeRange(start: CMTime(seconds: from, preferredTimescale: 600), end: CMTime(seconds: to, preferredTimescale: 600))
// the picture's brightness plane comes first in this format: no colour conversion at all
let out = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange])
out.alwaysCopiesSampleData = false
guard reader.canAdd(out) else { die("this video can't be read") }
reader.add(out)
guard reader.startReading() else { die(reader.error?.localizedDescription ?? "this video can't be read") }

var gridBuf = [UInt8](repeating: 0, count: gw * gh)
var bigBuf = [UInt8](repeating: 0, count: pw * ph)
var outBuf = Data(capacity: 4 << 20)
let output = FileHandle.standardOutput

func scale(_ src: inout vImage_Buffer, into dst: inout [UInt8], _ w: Int, _ h: Int) {
    dst.withUnsafeMutableBytes { p in
        var d = vImage_Buffer(data: p.baseAddress, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: w)
        _ = vImageScale_Planar8(&src, &d, nil, vImage_Flags(kvImageHighQualityResampling))
    }
}
func flush() {
    guard !outBuf.isEmpty else { return }
    do { try output.write(contentsOf: outBuf) } catch { exit(0) }
    outBuf.removeAll(keepingCapacity: true)
}

var next = from
while reader.status == .reading, let sb = out.copyNextSampleBuffer() {
    guard let px = CMSampleBufferGetImageBuffer(sb) else { continue }
    let t = CMSampleBufferGetPresentationTimeStamp(sb).seconds
    if !t.isFinite || t < from - 1e-3 { continue }
    if t > to + 1e-3 { break }
    let sample = t >= next - 1e-3
    if sample { next = t + step }
    CVPixelBufferLockBaseAddress(px, .readOnly)
    var y = vImage_Buffer(data: CVPixelBufferGetBaseAddressOfPlane(px, 0), height: vImagePixelCount(CVPixelBufferGetHeightOfPlane(px, 0)),
                          width: vImagePixelCount(CVPixelBufferGetWidthOfPlane(px, 0)), rowBytes: CVPixelBufferGetBytesPerRowOfPlane(px, 0))
    scale(&y, into: &gridBuf, gw, gh)
    if sample && pw > 0 { scale(&y, into: &bigBuf, pw, ph) }
    CVPixelBufferUnlockBaseAddress(px, .readOnly)
    var tt = t
    withUnsafeBytes(of: &tt) { outBuf.append(contentsOf: $0) }
    outBuf.append(sample ? 1 : 0)
    outBuf.append(contentsOf: gridBuf)
    if sample && pw > 0 { outBuf.append(contentsOf: bigBuf) }
    if outBuf.count > 2 << 20 { flush() }
}
flush()
if reader.status == .failed { die(reader.error?.localizedDescription ?? "the video stopped reading part way") }
exit(0)
