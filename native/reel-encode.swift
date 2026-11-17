// reel-encode: writes an export's MP4 with the Mac's own encoders (H.264 or HEVC on the media engine, AAC), from
// frames the Rust core drew (reel-core vexport) and the export's mixed sound. Reel's main process connects the core's
// output straight to this one's input, so the frames never pass through the editor.
//
//   reel-encode <out.mp4> <w> <h> <fps> <h264|hevc> <video bits/s> <audio bits/s> <sound.wav | ->
//
// Reads frames from stdin until it ends: w × h × 4 bytes BGRA each, frame n shown at n / fps. The sound (a WAV Reel
// mixed for this export, or - for none) is encoded alongside. Writes only the new file it's given (which mustn't
// exist yet); exits 0 when the file is complete, 2 with a reason on stderr otherwise.
import AVFoundation
import Foundation

func die(_ msg: String) -> Never { FileHandle.standardError.write((msg + "\n").data(using: .utf8)!); exit(2) }
signal(SIGPIPE, SIG_IGN)

let a = CommandLine.arguments
guard a.count == 9, a[1].hasPrefix("/"), a[1].hasSuffix(".mp4"),
      let w = Int(a[2]), let h = Int(a[3]), let fps = Double(a[4]), let vbr = Int(a[6]), let abr = Int(a[7]),
      (2...8192).contains(w), (2...8192).contains(h), w % 2 == 0, h % 2 == 0, fps > 0, fps <= 240,
      a[5] == "h264" || a[5] == "hevc", (100_000...400_000_000).contains(vbr), (32_000...512_000).contains(abr),
      a[8] == "-" || a[8].hasPrefix("/")
else { die("usage: reel-encode out.mp4 w h fps h264|hevc video-bps audio-bps sound.wav|-") }
let outURL = URL(fileURLWithPath: a[1])
if FileManager.default.fileExists(atPath: a[1]) { die("the file is already there") }
guard let writer = try? AVAssetWriter(outputURL: outURL, fileType: .mp4) else { die("can't write the file") }

// ---------------------------------------------------------------- picture
var compression: [String: Any] = [AVVideoAverageBitRateKey: vbr, AVVideoExpectedSourceFrameRateKey: fps, AVVideoMaxKeyFrameIntervalKey: max(1, Int((fps * 2).rounded()))]
if a[5] == "h264" { compression[AVVideoProfileLevelKey] = AVVideoProfileLevelH264HighAutoLevel }
let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: a[5] == "hevc" ? AVVideoCodecType.hevc : AVVideoCodecType.h264,
    AVVideoWidthKey: w, AVVideoHeightKey: h, AVVideoCompressionPropertiesKey: compression,
])
vIn.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: vIn, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h,
])
guard writer.canAdd(vIn) else { die("the encoder can't take this size") }
writer.add(vIn)

// ---------------------------------------------------------------- sound
var aIn: AVAssetWriterInput? = nil
var aReader: AVAssetReader? = nil
var aOut: AVAssetReaderTrackOutput? = nil
if a[8] != "-" {
    let asset = AVURLAsset(url: URL(fileURLWithPath: a[8]))
    guard let tr = asset.tracks(withMediaType: .audio).first, let r = try? AVAssetReader(asset: asset) else { die("the sound can't be read") }
    let o = AVAssetReaderTrackOutput(track: tr, outputSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMIsFloatKey: true, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsNonInterleaved: false,
        AVLinearPCMIsBigEndianKey: false, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2,
    ])
    guard r.canAdd(o) else { die("the sound can't be read") }
    r.add(o)
    let ai = AVAssetWriterInput(mediaType: .audio, outputSettings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: abr])
    ai.expectsMediaDataInRealTime = false
    guard writer.canAdd(ai) else { die("the sound encoder isn't available") }
    writer.add(ai)
    aIn = ai; aReader = r; aOut = o
}

guard writer.startWriting() else { die(writer.error?.localizedDescription ?? "can't write the file") }
writer.startSession(atSourceTime: .zero)
if let r = aReader, !r.startReading() { writer.cancelWriting(); die(r.error?.localizedDescription ?? "the sound can't be read") }

// ---------------------------------------------------------------- feeding both as the writer asks (it interleaves them)
let frameBytes = w * h * 4
let input = FileHandle.standardInput
/// Exactly n bytes from stdin, or nil at its end (a part-frame at the end counts as the end).
func readExact(_ n: Int) -> Data? {
    var d = Data(capacity: n)
    while d.count < n {
        let c = input.readData(ofLength: n - d.count)
        if c.isEmpty { return nil }
        d.append(c)
    }
    return d
}
let group = DispatchGroup()
let lock = NSLock()
var failure: String? = nil
func fail(_ msg: String) { lock.lock(); if failure == nil { failure = msg }; lock.unlock() }

var frame: Int64 = 0
var videoDone = false
group.enter()
vIn.requestMediaDataWhenReady(on: DispatchQueue(label: "reel.video")) {
    while vIn.isReadyForMoreMediaData && !videoDone {
        guard let d = readExact(frameBytes) else { videoDone = true; vIn.markAsFinished(); group.leave(); return }
        guard let pool = adaptor.pixelBufferPool else { fail("the encoder has no frames to fill"); videoDone = true; vIn.markAsFinished(); group.leave(); return }
        var pb: CVPixelBuffer? = nil
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb)
        guard let buf = pb else { fail("the encoder ran out of frames"); videoDone = true; vIn.markAsFinished(); group.leave(); return }
        CVPixelBufferLockBaseAddress(buf, [])
        let base = CVPixelBufferGetBaseAddress(buf)!, bpr = CVPixelBufferGetBytesPerRow(buf)
        d.withUnsafeBytes { src in
            for y in 0..<h { memcpy(base + y * bpr, src.baseAddress! + y * w * 4, w * 4) }
        }
        CVPixelBufferUnlockBaseAddress(buf, [])
        let t = CMTime(value: CMTimeValue((Double(frame) * 90000 / fps).rounded()), timescale: 90000)
        if !adaptor.append(buf, withPresentationTime: t) {
            fail(writer.error?.localizedDescription ?? "the encoder stopped"); videoDone = true; vIn.markAsFinished(); group.leave(); return
        }
        frame += 1
    }
}
if let ai = aIn, let o = aOut {
    var soundDone = false
    group.enter()
    ai.requestMediaDataWhenReady(on: DispatchQueue(label: "reel.sound")) {
        while ai.isReadyForMoreMediaData && !soundDone {
            guard let sb = o.copyNextSampleBuffer() else { soundDone = true; ai.markAsFinished(); group.leave(); return }
            if !ai.append(sb) { fail(writer.error?.localizedDescription ?? "the sound encoder stopped"); soundDone = true; ai.markAsFinished(); group.leave(); return }
        }
    }
}
group.wait()
if let f = failure { writer.cancelWriting(); try? FileManager.default.removeItem(at: outURL); die(f) }
if frame == 0 { writer.cancelWriting(); try? FileManager.default.removeItem(at: outURL); die("no frames came") }
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
if writer.status != .completed { try? FileManager.default.removeItem(at: outURL); die(writer.error?.localizedDescription ?? "the file couldn't be finished") }
exit(0)
