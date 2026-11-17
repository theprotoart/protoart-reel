// reel-speech: turns the speech in a media file into timed words, with macOS's own speech recogniser
// (on the Mac itself when the language supports it; nothing is uploaded then). Used for auto captions and
// for editing by transcript.
//
//   reel-speech <media file> <locale, e.g. en-US> [from seconds] [to seconds]
//
// Prints JSON lines: {"type":"progress","value":0..1}, {"type":"words","words":[[t, d, "text", conf], …]},
// {"type":"done","onDevice":true} or {"type":"error","message":"…"}.
import Foundation
import Speech
import AVFoundation

func out(_ o: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: o), let s = String(data: d, encoding: .utf8) { print(s); fflush(stdout) }
}
func fail(_ m: String, _ code: Int32 = 1) -> Never { out(["type": "error", "message": m]); exit(code) }

/// Runs the main run loop until `done()` is true (callbacks may arrive on the main queue).
func waitFor(_ done: () -> Bool, timeout: Double = 600) {
    let end = Date().addingTimeInterval(timeout)
    while !done() && Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
}

let args = CommandLine.arguments
guard args.count >= 3 else { fail("usage: reel-speech file locale [from] [to]", 2) }
let url = URL(fileURLWithPath: args[1])
let localeId = args[2]
let from = args.count > 3 ? max(0, Double(args[3]) ?? 0) : 0
let toArg = args.count > 4 ? Double(args[4]) ?? 0 : 0

// ---------------------------------------------------------------- permission
var status: SFSpeechRecognizerAuthorizationStatus = SFSpeechRecognizer.authorizationStatus()
if status == .notDetermined {
    var answered = false
    SFSpeechRecognizer.requestAuthorization { s in status = s; answered = true }
    waitFor({ answered }, timeout: 300)
}
if status != .authorized { fail("not-authorized", 3) }

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) ?? SFSpeechRecognizer() else { fail("No speech recogniser for \(localeId)") }
if !recognizer.isAvailable { fail("Speech recognition isn’t available right now (\(localeId)).") }
let onDevice = recognizer.supportsOnDeviceRecognition

// ---------------------------------------------------------------- audio, 16 kHz mono float
let asset = AVURLAsset(url: url)
guard let track = asset.tracks(withMediaType: .audio).first else { fail("That file has no sound.") }
let total = CMTimeGetSeconds(asset.duration)
let to = toArg > from ? min(toArg, total) : total
guard let reader = try? AVAssetReader(asset: asset) else { fail("Couldn’t read that file.") }
reader.timeRange = CMTimeRange(start: CMTime(seconds: from, preferredTimescale: 600), end: CMTime(seconds: to, preferredTimescale: 600))
let RATE = 16000.0
let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
    AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: RATE, AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false, AVLinearPCMIsBigEndianKey: false,
])
reader.add(output)
if !reader.startReading() { fail(reader.error?.localizedDescription ?? "Couldn’t read the sound.") }
guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: RATE, channels: 1, interleaved: false) else { fail("Audio format") }

/// Recognises one stretch of samples; returns words with times relative to its start.
func recognise(_ samples: [Float]) -> [[Any]] {
    guard !samples.isEmpty, let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)) else { return [] }
    buf.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { p in buf.floatChannelData![0].assign(from: p.baseAddress!, count: samples.count) }
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = false
    if onDevice { req.requiresOnDeviceRecognition = true }
    if #available(macOS 13, *) { req.addsPunctuation = true }
    req.append(buf)
    req.endAudio()
    var words: [[Any]] = [], finished = false
    let task = recognizer.recognitionTask(with: req) { result, error in
        if let r = result, r.isFinal {
            words = r.bestTranscription.segments.map { [$0.timestamp, $0.duration, $0.substring, Double($0.confidence)] }
            finished = true
        }
        if error != nil { finished = true }
    }
    waitFor({ finished }, timeout: 300)
    task.cancel()
    return words
}

/// The recogniser sometimes stops part way through a stretch (it hears an utterance end and gives up on the rest),
/// leaving many seconds of speech with no words. So whatever's after the last word it gave, when there's still
/// sound there, is listened to again on its own, until the stretch is done (a few goes at most).
func recogniseAll(_ samples: [Float]) -> [[Any]] {
    var all: [[Any]] = [], from = 0
    for _ in 0..<6 {
        let words = recognise(Array(samples[from...])).map { w -> [Any] in [(w[0] as! Double) + Double(from) / RATE, w[1], w[2], w[3]] }
        all += words
        let lastEnd = words.last.map { ($0[0] as! Double) + ($0[1] as! Double) } ?? Double(from) / RATE
        let next = Int((lastEnd + 0.15) * RATE)
        // less than 1.5 s left, or nothing but quiet in it: done
        if next >= samples.count - Int(RATE * 1.5) { break }
        var loud = 0, k = next
        let w = Int(RATE * 0.05)
        while k + w <= samples.count { var e: Float = 0; for i in k..<(k + w) { e += samples[i] * samples[i] }; if e / Float(w) > 1e-5 { loud += 1 }; k += w }
        if loud < 6 { break } // under 0.3 s of anything above a whisper
        if words.isEmpty && from > 0 { break } // it heard nothing more: don't go round again
        from = next
    }
    return all
}

// ---------------------------------------------------------------- go, in stretches of about half a minute,
// cut at the quietest moment near each minute so words aren't split
let span = max(0.01, to - from)
var pending: [Float] = [], base = from
let CHUNK = Int(RATE * 30), SEARCH = Int(RATE * 5)
func flush(_ final: Bool) {
    while pending.count >= CHUNK + SEARCH || (final && !pending.isEmpty) {
        var cut = min(pending.count, CHUNK)
        if !final || pending.count > CHUNK {
            // the quietest 50 ms window in the last 5 s of the stretch
            var best = cut, bestE = Float.greatestFiniteMagnitude, w = Int(RATE * 0.05)
            var i = max(w, CHUNK - SEARCH)
            while i + w < min(pending.count, CHUNK + SEARCH) {
                var e: Float = 0; for k in i..<(i + w) { e += pending[k] * pending[k] }
                if e < bestE { bestE = e; best = i + w / 2 }
                i += w / 2
            }
            cut = best
        }
        let part = Array(pending[0..<cut])
        pending.removeFirst(cut)
        let words = recogniseAll(part).map { w -> [Any] in [(w[0] as! Double) + base, w[1], w[2], w[3]] }
        if !words.isEmpty { out(["type": "words", "words": words]) }
        base += Double(cut) / RATE
        out(["type": "progress", "value": min(1, (base - from) / span)])
        if final && pending.isEmpty { break }
    }
}
while reader.status == .reading, let sb = output.copyNextSampleBuffer() {
    if let bb = CMSampleBufferGetDataBuffer(sb) {
        let n = CMBlockBufferGetDataLength(bb) / 4
        var chunk = [Float](repeating: 0, count: n)
        chunk.withUnsafeMutableBytes { p in _ = CMBlockBufferCopyDataBytes(bb, atOffset: 0, dataLength: n * 4, destination: p.baseAddress!) }
        pending.append(contentsOf: chunk)
    }
    flush(false)
}
if reader.status == .failed { fail(reader.error?.localizedDescription ?? "Reading the sound failed.") }
flush(true)
out(["type": "done", "onDevice": onDevice])
exit(0)
