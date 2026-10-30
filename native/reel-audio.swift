// reel-audio: ProtoArt Reel's audio helper. Uses Core Audio process taps (macOS 14.2+) to
//   * record chosen apps' sound, each to its own WAV file (like Loopback, without a driver), and
//   * run a per-app mixer: volume/boost, mute, 10-band EQ and output device (like SoundSource).
// Talks JSON lines over stdin/stdout with the Reel main process. No network, no files other than
// the WAV paths Reel hands it.
import AppKit
import AudioToolbox
import AVFoundation
import CoreAudio
import CoreAudioKit
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

setvbuf(stdout, nil, _IOLBF, 0)
let outLock = NSLock()
func send(_ obj: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) else { return }
    outLock.lock(); print(s); fflush(stdout); outLock.unlock()
}
func fail(_ msg: String, _ id: Any? = nil) { var o: [String: Any] = ["type": "error", "msg": msg]; if let id { o["id"] = id }; send(o) }

// ------------------------------------------------------------------ Core Audio helpers

func addr(_ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}
func getArray<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, _ type: T.Type) -> [T] {
    var a = addr(sel, scope); var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(obj, &a, 0, nil, &size) == noErr, size > 0 else { return [] }
    let n = Int(size) / MemoryLayout<T>.stride
    let buf = UnsafeMutablePointer<T>.allocate(capacity: n); defer { buf.deallocate() }
    guard AudioObjectGetPropertyData(obj, &a, 0, nil, &size, buf) == noErr else { return [] }
    return Array(UnsafeBufferPointer(start: buf, count: n))
}
func getValue<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ dflt: T, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> T {
    var a = addr(sel, scope); var v = dflt; var size = UInt32(MemoryLayout<T>.size)
    return AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &v) == noErr ? v : dflt
}
func getString(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> String? {
    var a = addr(sel, scope); var cf: Unmanaged<CFString>?; var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &cf) == noErr, let s = cf?.takeRetainedValue() else { return nil }
    return s as String
}
let system = AudioObjectID(kAudioObjectSystemObject)

struct AudioProc { let object: AudioObjectID; let pid: pid_t; let bundle: String; let active: Bool }

/// Reel itself (the app that started this helper, and all of its helper processes). Its sound is never tapped:
/// Reel has its own monitor section, and tapping it would mute Reel's real output and replay a delayed copy
/// on the Mac's default output instead of the interface chosen in Reel.
let reelPID = getppid()
let reelBundle = NSRunningApplication(processIdentifier: reelPID)?.bundleIdentifier ?? "local.protoart.reel"
func parentPID(_ pid: pid_t) -> pid_t {
    var info = kinfo_proc(); var size = MemoryLayout<kinfo_proc>.stride; var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    return sysctl(&mib, 4, &info, &size, nil, 0) == 0 ? info.kp_eproc.e_ppid : -1
}
func isReel(_ pid: pid_t, _ bundle: String) -> Bool {
    if pid == reelPID || pid == getpid() { return true }
    if bundle == reelBundle || bundle.hasPrefix(reelBundle + ".") { return true }
    return parentPID(pid) == reelPID
}

func audioProcesses() -> [AudioProc] {
    getArray(system, kAudioHardwarePropertyProcessObjectList, kAudioObjectPropertyScopeGlobal, AudioObjectID.self).map { o in
        AudioProc(object: o, pid: getValue(o, kAudioProcessPropertyPID, pid_t(-1)), bundle: getString(o, kAudioProcessPropertyBundleID) ?? "",
                  active: getValue(o, kAudioProcessPropertyIsRunningOutput, UInt32(0)) != 0)
    }.filter { $0.pid > 0 && !isReel($0.pid, $0.bundle) }
}

/// Groups helper processes under the app the user knows (WebKit → Safari, Chrome helpers → Chrome…).
func appKey(for p: AudioProc, apps: [NSRunningApplication]) -> (key: String, name: String, icon: NSImage?) {
    if let app = NSRunningApplication(processIdentifier: p.pid), let b = app.bundleIdentifier, app.activationPolicy == .regular {
        return (b, app.localizedName ?? b, app.icon)
    }
    if p.bundle.hasPrefix("com.apple.WebKit"), let safari = apps.first(where: { $0.bundleIdentifier == "com.apple.Safari" }) {
        return ("com.apple.Safari", safari.localizedName ?? "Safari", safari.icon)
    }
    // longest running app bundle id that prefixes this helper's id
    if let owner = apps.filter({ a in guard let b = a.bundleIdentifier else { return false }; return p.bundle.hasPrefix(b + ".") || p.bundle == b })
        .max(by: { ($0.bundleIdentifier?.count ?? 0) < ($1.bundleIdentifier?.count ?? 0) }), let b = owner.bundleIdentifier {
        return (b, owner.localizedName ?? b, owner.icon)
    }
    let name = NSRunningApplication(processIdentifier: p.pid)?.localizedName ?? (p.bundle.isEmpty ? "pid \(p.pid)" : p.bundle)
    return (p.bundle.isEmpty ? "pid:\(p.pid)" : p.bundle, name, nil)
}

func iconData(_ img: NSImage?) -> String {
    guard let img else { return "" }
    let size = NSSize(width: 32, height: 32)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 32, pixelsHigh: 32, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    img.draw(in: NSRect(origin: .zero, size: size))
    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]) else { return "" }
    return "data:image/png;base64," + png.base64EncodedString()
}

struct OutputDevice { let id: AudioObjectID; let uid: String; let name: String }
func outputDevices() -> [OutputDevice] {
    getArray(system, kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal, AudioObjectID.self).compactMap { d in
        let streams = getArray(d, kAudioDevicePropertyStreams, kAudioObjectPropertyScopeOutput, AudioStreamID.self)
        guard !streams.isEmpty, let uid = getString(d, kAudioDevicePropertyDeviceUID), let name = getString(d, kAudioObjectPropertyName) else { return nil }
        if uid.hasPrefix("ProtoArtReel") { return nil } // our own private aggregates
        return OutputDevice(id: d, uid: uid, name: name)
    }
}
func defaultOutputUID() -> String {
    let id: AudioObjectID = getValue(system, kAudioHardwarePropertyDefaultOutputDevice, AudioObjectID(0))
    return getString(id, kAudioDevicePropertyDeviceUID) ?? ""
}

// ------------------------------------------------------------------ DSP: gain + 10-band EQ

let EQ_FREQS: [Double] = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

final class DSP {
    // Coefficients are swapped in whole from the control thread; the audio thread reads a pointer.
    // Filters: the 10 graphic bands, then the channel strip (high-pass, LF, LMF, HMF, HF; SSL layout).
    struct Biquad { var b0 = 1.0, b1 = 0.0, b2 = 0.0, a1 = 0.0, a2 = 0.0 }
    static let N = 16
    var bands = [Biquad](repeating: Biquad(), count: DSP.N)
    var active = [Bool](repeating: false, count: DSP.N)
    var z1 = [[Double]](repeating: [Double](repeating: 0, count: DSP.N), count: 8)
    var z2 = [[Double]](repeating: [Double](repeating: 0, count: DSP.N), count: 8)
    var gain: Float = 1
    var panL: Float = 1, panR: Float = 1
    var muted = false
    var peak: Float = 0
    var peaks = [Float](repeating: 0, count: 2)
    let lock = NSLock()

    /// RBJ cookbook filters. kind: 0 peak, 1 low shelf, 2 high shelf, 3 high-pass.
    static func biquad(kind: Int, f fIn: Double, db: Double, q: Double, rate: Double) -> Biquad {
        let f = max(10, min(fIn, rate * 0.45)), w = 2 * Double.pi * f / rate, cw = cos(w), sw = sin(w)
        let A = pow(10, db / 40)
        switch kind {
        case 3:
            let alpha = sw / (2 * 0.707), a0 = 1 + alpha
            return Biquad(b0: (1 + cw) / 2 / a0, b1: -(1 + cw) / a0, b2: (1 + cw) / 2 / a0, a1: -2 * cw / a0, a2: (1 - alpha) / a0)
        case 1, 2:
            let alpha = sw / 2 * sqrt(2.0), sa = 2 * sqrt(A) * alpha
            if kind == 1 {
                let a0 = (A + 1) + (A - 1) * cw + sa
                return Biquad(b0: A * ((A + 1) - (A - 1) * cw + sa) / a0, b1: 2 * A * ((A - 1) - (A + 1) * cw) / a0, b2: A * ((A + 1) - (A - 1) * cw - sa) / a0,
                              a1: -2 * ((A - 1) + (A + 1) * cw) / a0, a2: ((A + 1) + (A - 1) * cw - sa) / a0)
            }
            let a0 = (A + 1) - (A - 1) * cw + sa
            return Biquad(b0: A * ((A + 1) + (A - 1) * cw + sa) / a0, b1: -2 * A * ((A - 1) + (A + 1) * cw) / a0, b2: A * ((A + 1) + (A - 1) * cw - sa) / a0,
                          a1: 2 * ((A - 1) - (A + 1) * cw) / a0, a2: ((A + 1) - (A - 1) * cw - sa) / a0)
        default:
            let alpha = sw / (2 * max(0.1, q)), a0 = 1 + alpha / A
            return Biquad(b0: (1 + alpha * A) / a0, b1: -2 * cw / a0, b2: (1 - alpha * A) / a0, a1: -2 * cw / a0, a2: (1 - alpha / A) / a0)
        }
    }

    func set(gain g: Float, muted m: Bool, eq: [Double], strip: [[Double]] = [], pan: Float = 0, rate: Double) {
        var nb = [Biquad](repeating: Biquad(), count: DSP.N), na = [Bool](repeating: false, count: DSP.N)
        for i in 0..<10 {
            let db = i < eq.count ? max(-24, min(24, eq[i])) : 0
            if abs(db) < 0.05 { continue }
            nb[i] = DSP.biquad(kind: 0, f: EQ_FREQS[i], db: db, q: 1.41, rate: rate)
            na[i] = true
        }
        // strip: [kind, freq, gainDb, q] each
        for (j, s) in strip.prefix(DSP.N - 10).enumerated() where s.count >= 4 {
            let kind = Int(s[0]), f = s[1], db = max(-24, min(24, s[2])), q = s[3]
            if (kind == 3 && f < 21) || (kind != 3 && abs(db) < 0.05) { continue }
            nb[10 + j] = DSP.biquad(kind: kind, f: f, db: db, q: q, rate: rate)
            na[10 + j] = true
        }
        let p = max(-1, min(1, pan))
        lock.lock(); bands = nb; active = na; gain = g; muted = m; panL = p > 0 ? 1 - p : 1; panR = p < 0 ? 1 + p : 1; lock.unlock()
    }

    /// Processes one channel's samples in place (realtime thread; try-lock so it never waits).
    func process(_ x: UnsafeMutablePointer<Float>, _ n: Int, channel ch: Int) {
        guard lock.try() else { return }
        defer { lock.unlock() }
        let g = (muted ? 0 : gain) * (ch == 0 ? panL : ch == 1 ? panR : 1)
        let c = min(ch, 7)
        var pk: Float = 0
        for i in 0..<n {
            var v = Double(x[i])
            for b in 0..<DSP.N where active[b] {
                let q = bands[b]
                let y = q.b0 * v + z1[c][b]
                z1[c][b] = q.b1 * v - q.a1 * y + z2[c][b]
                z2[c][b] = q.b2 * v - q.a2 * y
                v = y
            }
            var s = Float(v) * g
            if g > 1 { s = tanhf(s) } // boost without hard clipping
            x[i] = s
            pk = max(pk, abs(s))
        }
        peak = max(pk, peak * 0.9)
        if c < 2 { peaks[c] = max(pk, peaks[c] * 0.9) }
    }
}

// ------------------------------------------------------------------ taps

/// One process tap + private aggregate device + IO proc.
final class TapRoute {
    let key: String
    var tapID = AudioObjectID(kAudioObjectUnknown)
    var aggID = AudioObjectID(kAudioObjectUnknown)
    var procID: AudioDeviceIOProcID?
    let dsp = DSP()
    var file: ExtAudioFileRef?
    var format = AudioStreamBasicDescription()
    var framesWritten: Int64 = 0
    var outputUID = ""
    // preallocated so the audio thread doesn't allocate
    var scratch = [[Float]](repeating: [Float](repeating: 0, count: 16384), count: 8)
    let pass: Bool          // true: mixer (tap is muted, processed audio goes to the output)
    var processes: [AudioObjectID]

    init(key: String, processes: [AudioObjectID], mixer: Bool) { self.key = key; self.processes = processes; self.pass = mixer }

    func start(outputUID: String, record path: String?) throws {
        let desc = CATapDescription(stereoMixdownOfProcesses: processes)
        desc.name = "ProtoArt Reel \(key)"
        desc.isPrivate = true
        let mute: CATapMuteBehavior = pass ? CATapMuteBehavior.mutedWhenTapped : CATapMuteBehavior.unmuted
        desc.muteBehavior = mute
        var st = AudioHardwareCreateProcessTap(desc, &tapID)
        guard st == noErr else { throw NSError(domain: "tap", code: Int(st), userInfo: [NSLocalizedDescriptionKey: "Couldn't tap \(key) (\(st)). Allow ProtoArt Reel under Privacy & Security › Screen & System Audio Recording."]) }
        format = getValue(tapID, kAudioTapPropertyFormat, AudioStreamBasicDescription())
        let out = outputUID.isEmpty ? defaultOutputUID() : outputUID
        let agg: [String: Any] = [
            kAudioAggregateDeviceNameKey: "ProtoArt Reel \(key)",
            kAudioAggregateDeviceUIDKey: "ProtoArtReel-\(UUID().uuidString)",
            kAudioAggregateDeviceMainSubDeviceKey: out,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: out]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: desc.uuid.uuidString]],
        ]
        st = AudioHardwareCreateAggregateDevice(agg as CFDictionary, &aggID)
        guard st == noErr else { stop(); throw NSError(domain: "agg", code: Int(st), userInfo: [NSLocalizedDescriptionKey: "Couldn't create the audio route (\(st))"]) }
        if let path {
            var fileFmt = AudioStreamBasicDescription(mSampleRate: format.mSampleRate, mFormatID: kAudioFormatLinearPCM,
                mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked, mBytesPerPacket: 4 * format.mChannelsPerFrame, mFramesPerPacket: 1,
                mBytesPerFrame: 4 * format.mChannelsPerFrame, mChannelsPerFrame: format.mChannelsPerFrame, mBitsPerChannel: 32, mReserved: 0)
            st = ExtAudioFileCreateWithURL(URL(fileURLWithPath: path) as CFURL, kAudioFileWAVEType, &fileFmt, nil, AudioFileFlags.eraseFile.rawValue, &file)
            guard st == noErr, let file else { stop(); throw NSError(domain: "file", code: Int(st), userInfo: [NSLocalizedDescriptionKey: "Couldn't create \(path) (\(st))"]) }
            var client = format
            ExtAudioFileSetProperty(file, kExtAudioFileProperty_ClientDataFormat, UInt32(MemoryLayout<AudioStreamBasicDescription>.size), &client)
            ExtAudioFileWriteAsync(file, 0, nil) // primes the async writer off the audio thread
        }
        let nonInterleaved = (format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
        st = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, nil) { [self] _, inData, _, outData, _ in
            let inList = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inData))
            let outList = UnsafeMutableAudioBufferListPointer(outData)
            // record the untouched tap audio
            if let f = self.file, inList.count > 0 {
                let frames = nonInterleaved ? Int(inList[0].mDataByteSize) / 4 : Int(inList[0].mDataByteSize) / (4 * Int(max(1, self.format.mChannelsPerFrame)))
                if frames > 0 { ExtAudioFileWriteAsync(f, UInt32(frames), inData); self.framesWritten += Int64(frames) }
            }
            // silence the outputs, then (mixer) add the processed app audio
            for b in outList { if let d = b.mData { memset(d, 0, Int(b.mDataByteSize)) } }
            if !self.pass && self.file == nil, inList.count > 0 {
                // meter only (SOUND console open): left/right peaks of the untouched app audio
                var pk: [Float] = [0, 0], c = 0
                for b in inList {
                    guard let d = b.mData?.assumingMemoryBound(to: Float.self) else { continue }
                    let ch = max(1, Int(b.mNumberChannels)), frames = Int(b.mDataByteSize) / 4 / ch
                    for k in 0..<ch where c + k < 2 { var m: Float = 0; for i in 0..<frames { m = max(m, abs(d[i * ch + k])) }; pk[c + k] = m }
                    c += ch
                }
                if c == 1 { pk[1] = pk[0] }
                self.dsp.peaks[0] = max(pk[0], self.dsp.peaks[0] * 0.9); self.dsp.peaks[1] = max(pk[1], self.dsp.peaks[1] * 0.9)
                self.dsp.peak = max(self.dsp.peaks[0], self.dsp.peaks[1])
                return
            }
            guard self.pass, inList.count > 0 else { return }
            var inCh: [(UnsafeMutablePointer<Float>, Int, Int)] = [] // (ptr, stride, frames)
            for b in inList {
                guard let d = b.mData?.assumingMemoryBound(to: Float.self) else { continue }
                let ch = Int(b.mNumberChannels), frames = Int(b.mDataByteSize) / 4 / max(1, ch)
                for c in 0..<ch { inCh.append((d + c, ch, frames)) }
            }
            if inCh.isEmpty { return }
            // process each input channel (deinterleaved into preallocated scratch buffers)
            let n = min(inCh[0].2, 16384), nch = min(inCh.count, 8)
            for i in 0..<nch {
                let (p, stride, frames) = inCh[i]
                self.scratch[i].withUnsafeMutableBufferPointer { buf in
                    for k in 0..<min(n, frames) { buf[k] = p[k * stride] }
                    self.dsp.process(buf.baseAddress!, n, channel: i)
                }
            }
            var oc = 0
            for b in outList {
                guard let d = b.mData?.assumingMemoryBound(to: Float.self) else { continue }
                let ch = Int(b.mNumberChannels), frames = Int(b.mDataByteSize) / 4 / max(1, ch)
                for c in 0..<ch {
                    self.scratch[(oc + c) % nch].withUnsafeBufferPointer { src in
                        for k in 0..<min(frames, n) { d[k * ch + c] = src[k] }
                    }
                }
                oc += ch
            }
        }
        guard st == noErr, let procID else { stop(); throw NSError(domain: "io", code: Int(st), userInfo: [NSLocalizedDescriptionKey: "Couldn't start audio (\(st))"]) }
        st = AudioDeviceStart(aggID, procID)
        guard st == noErr else { stop(); throw NSError(domain: "io", code: Int(st), userInfo: [NSLocalizedDescriptionKey: "Couldn't start audio (\(st))"]) }
    }

    func stop() {
        if let procID, aggID != kAudioObjectUnknown { AudioDeviceStop(aggID, procID); AudioDeviceDestroyIOProcID(aggID, procID) }
        procID = nil
        if aggID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggID); aggID = AudioObjectID(kAudioObjectUnknown) }
        if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID); tapID = AudioObjectID(kAudioObjectUnknown) }
        if let file { ExtAudioFileDispose(file) }
        file = nil
    }
}

// ------------------------------------------------------------------ state

struct Rule { var volume: Float = 1; var mute = false; var eq: [Double] = []; var strip: [[Double]] = []; var pan: Float = 0; var output = "" }
var rules: [String: Rule] = [:]          // app key -> mixer settings
var mixRoutes: [String: TapRoute] = [:]  // app key -> active mixer route
var recordings: [String: [TapRoute]] = [:]
var meterRoutes: [String: TapRoute] = [:] // listen-only taps while the SOUND console is open
var metering = false

/// While the console is open, every app that's playing (and isn't already on a mixer route) gets a
/// listen-only tap so its channel strip shows a level. They all go when the console closes.
func applyMeters() {
    let byKey = metering ? processesByKey() : [:]
    for (key, r) in meterRoutes where !metering || mixRoutes[key] != nil || byKey[key]?.procs.contains(where: { $0.active }) != true || Set(r.processes) != Set(byKey[key]?.procs.map(\.object) ?? []) {
        r.stop(); meterRoutes[key] = nil
    }
    guard metering else { return }
    for (key, v) in byKey where mixRoutes[key] == nil && meterRoutes[key] == nil && v.procs.contains(where: { $0.active }) {
        let r = TapRoute(key: key, processes: v.procs.map(\.object), mixer: false)
        do { try r.start(outputUID: "", record: nil); meterRoutes[key] = r } catch { /* that app can't be metered */ }
    }
}

func isNeutral(_ r: Rule) -> Bool {
    abs(r.volume - 1) < 0.001 && !r.mute && r.eq.allSatisfy { abs($0) < 0.05 } && r.output.isEmpty && abs(r.pan) < 0.005
        && r.strip.allSatisfy { $0.count < 4 || (Int($0[0]) == 3 ? $0[1] < 21 : abs($0[2]) < 0.05) }
}

func processesByKey() -> [String: (name: String, icon: NSImage?, procs: [AudioProc])] {
    let apps = NSWorkspace.shared.runningApplications
    var out: [String: (name: String, icon: NSImage?, procs: [AudioProc])] = [:]
    for p in audioProcesses() {
        let k = appKey(for: p, apps: apps)
        if out[k.key] == nil { out[k.key] = (k.name, k.icon, []) }
        out[k.key]!.procs.append(p)
    }
    return out
}

/// Makes the live mixer routes match the rules (called on changes and every 2 s for new processes).
func applyRules() {
    let byKey = processesByKey()
    for (key, rule) in rules {
        // never Reel's own sound (an old rule for it would hijack Reel's output)
        let procs = key == reelBundle || key.hasPrefix(reelBundle + ".") ? [] : byKey[key]?.procs.map(\.object) ?? []
        let existing = mixRoutes[key]
        if isNeutral(rule) || procs.isEmpty {
            existing?.stop(); mixRoutes[key] = nil; continue
        }
        if let e = existing, Set(e.processes) == Set(procs), e.outputUID == rule.output {
            e.dsp.set(gain: rule.volume, muted: rule.mute, eq: rule.eq, strip: rule.strip, pan: rule.pan, rate: e.format.mSampleRate > 0 ? e.format.mSampleRate : 48000)
            continue
        }
        existing?.stop()
        let r = TapRoute(key: key, processes: procs, mixer: true)
        r.outputUID = rule.output
        do {
            try r.start(outputUID: rule.output, record: nil)
            r.dsp.set(gain: rule.volume, muted: rule.mute, eq: rule.eq, strip: rule.strip, pan: rule.pan, rate: r.format.mSampleRate > 0 ? r.format.mSampleRate : 48000)
            mixRoutes[key] = r
        } catch { fail("\(key): \(error.localizedDescription)"); mixRoutes[key] = nil }
    }
}


func listMessage() -> [String: Any] {
    let byKey = processesByKey()
    let apps: [[String: Any]] = byKey.map { key, v in
        ["key": key, "name": v.name, "icon": iconData(v.icon), "active": v.procs.contains { $0.active }, "pids": v.procs.map { Int($0.pid) },
         "level": Double(mixRoutes[key]?.dsp.peak ?? 0)]
    }.sorted { ($0["active"] as! Bool) == ($1["active"] as! Bool) ? ($0["name"] as! String).localizedCaseInsensitiveCompare($1["name"] as! String) == .orderedAscending : ($0["active"] as! Bool) }
    let def = defaultOutputUID()
    return ["type": "list", "apps": apps, "outputs": outputDevices().map { ["uid": $0.uid, "name": $0.name, "default": $0.uid == def] }]
}

// ------------------------------------------------------------------ input monitor (clicks + keys)
// Listen-only: it can see clicks and key presses but can't change or block them. Used while
// recording for click sounds / click effects and, only when the user turns it on, the keystroke
// display. macOS hides keys typed into password fields from every event tap (Secure Input).

final class InputMonitor {
    var tap: CFMachPort?
    var source: CFRunLoopSource?
    var keys = false
    var pending: [[Any]] = []
    var flushTimer: Timer?

    static func label(_ e: CGEvent) -> String {
        let code = e.getIntegerValueField(.keyboardEventKeycode)
        let special: [Int64: String] = [36: "↩", 76: "⌤", 48: "⇥", 49: "Space", 51: "⌫", 117: "⌦", 53: "⎋", 123: "←", 124: "→", 125: "↓", 126: "↑",
            115: "↖", 119: "↘", 116: "⇞", 121: "⇟", 122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8",
            101: "F9", 109: "F10", 103: "F11", 111: "F12"]
        if let s = special[code] { return s }
        var len = 0; var chars = [UniChar](repeating: 0, count: 8)
        // the key's own character, ignoring modifiers (so ⌘C shows C, not a control code)
        if let copy = e.copy() {
            copy.flags = []
            copy.keyboardGetUnicodeString(maxStringLength: 8, actualStringLength: &len, unicodeString: &chars)
        }
        let s = String(utf16CodeUnits: chars, count: len).uppercased()
        return s.isEmpty ? "?" : s
    }
    static func mods(_ f: CGEventFlags) -> String {
        var s = ""
        if f.contains(.maskControl) { s += "⌃" }
        if f.contains(.maskAlternate) { s += "⌥" }
        if f.contains(.maskShift) { s += "⇧" }
        if f.contains(.maskCommand) { s += "⌘" }
        return s
    }

    func start(keys: Bool) -> Bool {
        stop()
        self.keys = keys
        if #available(macOS 10.15, *), !CGPreflightListenEventAccess() { _ = CGRequestListenEventAccess() }
        var mask: CGEventMask = (1 << CGEventType.leftMouseDown.rawValue) | (1 << CGEventType.rightMouseDown.rawValue) | (1 << CGEventType.leftMouseUp.rawValue)
        if keys { mask |= (1 << CGEventType.keyDown.rawValue) }
        let me = Unmanaged.passUnretained(self).toOpaque()
        guard let t = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly, eventsOfInterest: mask,
            callback: { _, type, event, refcon in
                guard let refcon else { return Unmanaged.passUnretained(event) }
                let mon = Unmanaged<InputMonitor>.fromOpaque(refcon).takeUnretainedValue()
                mon.record(type, event)
                return Unmanaged.passUnretained(event)
            }, userInfo: me) else { return false }
        tap = t
        source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, t, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: t, enable: true)
        flushTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in self?.flush() }
        return true
    }
    func record(_ type: CGEventType, _ e: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { if let t = tap { CGEvent.tapEnable(tap: t, enable: true) }; return }
        let loc = e.location
        switch type {
        case .leftMouseDown: pending.append(["c", 0, loc.x, loc.y])
        case .rightMouseDown: pending.append(["c", 1, loc.x, loc.y])
        case .leftMouseUp: pending.append(["u", 0, loc.x, loc.y])
        case .keyDown where keys:
            if e.getIntegerValueField(.keyboardEventAutorepeat) != 0 { return }
            pending.append(["k", InputMonitor.mods(e.flags), InputMonitor.label(e)])
        default: break
        }
        flush()
    }
    func flush() {
        if pending.isEmpty { return }
        send(["type": "input", "events": pending])
        pending = []
    }
    func stop() {
        flush()
        flushTimer?.invalidate(); flushTimer = nil
        if let t = tap { CGEvent.tapEnable(tap: t, enable: false) }
        if let s = source { CFRunLoopRemoveSource(CFRunLoopGetMain(), s, .commonModes) }
        tap = nil; source = nil
    }
}
let input = InputMonitor()

// ------------------------------------------------------------------ background removal (person matte)
// Reads a video, runs Apple's person segmentation (Vision; on the Neural Engine on Apple Silicon) on
// every frame and writes a small grey mask video with the same frame times. Reel uses it as alpha.

// ------------------------------------------------------------------ conform (import of any format)
// Files Reel's editor can't use directly are converted with macOS's own frameworks when they're added:
// photos (HEIC, TIFF, PSD, camera RAW, JPEG 2000, BMP…) → JPEG (PNG if they have transparency),
// sound (MP3, AIFF, CAF, FLAC, Apple Lossless, AC-3…) → 32-bit float WAV, and video (ProRes, AVCHD/MTS,
// MPEG-2, DV, AVI, 3GP… whatever AVFoundation can read) → MP4 (H.264, or HEVC above 1080p) with AAC.
func conformFail(_ msg: String, _ id: Any?) { var o: [String: Any] = ["type": "error", "fatal": true, "msg": msg]; if let id { o["id"] = id }; send(o) }
func conformProgress(_ id: Any?, _ v: Double) { send(["type": "conformProgress", "progress": true, "job": id ?? NSNull(), "value": max(0, min(1, v))]) }

func conformImage(src: String, dstBase: String, id: Any?) {
    guard let s = CGImageSourceCreateWithURL(URL(fileURLWithPath: src) as CFURL, nil), CGImageSourceGetCount(s) > 0 else { return conformFail("macOS can't read this picture.", id) }
    let props = CGImageSourceCopyPropertiesAtIndex(s, 0, nil) as? [CFString: Any] ?? [:]
    let w = (props[kCGImagePropertyPixelWidth] as? Int) ?? 0, h = (props[kCGImagePropertyPixelHeight] as? Int) ?? 0
    // a full-size "thumbnail" bakes in the camera's orientation; RAW files are developed by macOS
    let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                 kCGImageSourceThumbnailMaxPixelSize: max(w, h, 1), kCGImageSourceShouldCacheImmediately: true]
    guard let img = CGImageSourceCreateThumbnailAtIndex(s, 0, opts as CFDictionary) ?? CGImageSourceCreateImageAtIndex(s, 0, nil) else { return conformFail("macOS couldn't decode this picture.", id) }
    let alpha: Bool = { switch img.alphaInfo { case .none, .noneSkipFirst, .noneSkipLast: return false; default: return true } }()
    let dst = dstBase + (alpha ? ".png" : ".jpg")
    let type = (alpha ? UTType.png : UTType.jpeg).identifier as CFString
    guard let d = CGImageDestinationCreateWithURL(URL(fileURLWithPath: dst) as CFURL, type, 1, nil) else { return conformFail("Couldn't write the converted picture.", id) }
    CGImageDestinationAddImage(d, img, (alpha ? [:] : [kCGImageDestinationLossyCompressionQuality: 0.95]) as CFDictionary)
    guard CGImageDestinationFinalize(d) else { return conformFail("Couldn't write the converted picture.", id) }
    send(["type": "conformed", "id": id ?? NSNull(), "dst": dst, "width": img.width, "height": img.height])
}

func conformAudio(src: String, dst: String, id: Any?) {
    do {
        let inF = try AVAudioFile(forReading: URL(fileURLWithPath: src))
        let fmt = inF.processingFormat, ch = min(Int(fmt.channelCount), 8)
        guard let readFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: fmt.sampleRate, channels: AVAudioChannelCount(ch), interleaved: false) else { return conformFail("Unusual sound format.", id) }
        try? FileManager.default.removeItem(atPath: dst)
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: fmt.sampleRate, AVNumberOfChannelsKey: ch,
                                       AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false]
        let outF = try AVAudioFile(forWriting: URL(fileURLWithPath: dst), settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        let total = max(1, inF.length)
        guard let buf = AVAudioPCMBuffer(pcmFormat: readFmt, frameCapacity: 65536) else { return conformFail("Out of memory.", id) }
        var n = 0
        while inF.framePosition < inF.length {
            try inF.read(into: buf, frameCount: 65536)
            if buf.frameLength == 0 { break }
            try outF.write(from: buf)
            n += 1; if n % 16 == 0 { conformProgress(id, Double(inF.framePosition) / Double(total)) }
        }
        send(["type": "conformed", "id": id ?? NSNull(), "dst": dst, "duration": Double(inF.length) / fmt.sampleRate, "channels": ch, "rate": fmt.sampleRate])
    } catch { conformFail("macOS can't read this sound file (\(error.localizedDescription)).", id) }
}

func conformVideo(src: String, dst: String, id: Any?) {
    let asset = AVURLAsset(url: URL(fileURLWithPath: src))
    guard asset.isReadable, let track = asset.tracks(withMediaType: .video).first else { return conformFail("macOS can't read this video.", id) }
    let size = track.naturalSize.applying(track.preferredTransform)
    let big = max(abs(size.width), abs(size.height)) > 1920
    let presets = AVAssetExportSession.exportPresets(compatibleWith: asset)
    let preset = big && presets.contains(AVAssetExportPresetHEVCHighestQuality) ? AVAssetExportPresetHEVCHighestQuality : AVAssetExportPresetHighestQuality
    guard let ex = AVAssetExportSession(asset: asset, presetName: preset) else { return conformFail("macOS can't convert this video.", id) }
    try? FileManager.default.removeItem(atPath: dst)
    ex.outputURL = URL(fileURLWithPath: dst)
    ex.outputFileType = .mp4
    ex.shouldOptimizeForNetworkUse = true
    let timer = DispatchSource.makeTimerSource(queue: .global())
    timer.schedule(deadline: .now() + 0.5, repeating: 0.5)
    timer.setEventHandler { conformProgress(id, Double(ex.progress)) }
    timer.resume()
    conformJobs[String(describing: id ?? "")] = ex
    ex.exportAsynchronously {
        timer.cancel()
        conformJobs[String(describing: id ?? "")] = nil
        switch ex.status {
        case .completed: send(["type": "conformed", "id": id ?? NSNull(), "dst": dst])
        case .cancelled: conformFail("Cancelled", id)
        default: conformFail("Couldn't convert this video: \(ex.error?.localizedDescription ?? "unknown error").", id)
        }
    }
}
var conformJobs: [String: AVAssetExportSession] = [:]

func matteFail(_ msg: String, _ id: Any?) { var o: [String: Any] = ["type": "error", "fatal": true, "msg": msg]; if let id { o["id"] = id }; send(o) }

func runMatte(src: String, dst: String, quality: String, id: Any?) {
    guard #available(macOS 12.0, *) else { return matteFail("Background removal needs macOS 12 or newer.", id) }
    let asset = AVURLAsset(url: URL(fileURLWithPath: src))
    guard let track = asset.tracks(withMediaType: .video).first else { return matteFail("That clip has no picture.", id) }
    do {
        let reader = try AVAssetReader(asset: asset)
        let out = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        out.alwaysCopiesSampleData = false
        reader.add(out)
        let nat = track.naturalSize
        let ow = max(64, Int(min(1280, nat.width)) & ~1)
        let oh = max(64, Int((CGFloat(ow) * nat.height / max(1, nat.width)).rounded()) & ~1)
        try? FileManager.default.removeItem(atPath: dst)
        let writer = try AVAssetWriter(outputURL: URL(fileURLWithPath: dst), fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: ow, AVVideoHeightKey: oh,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 3_000_000, AVVideoMaxKeyFrameIntervalKey: 60]])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: ow, kCVPixelBufferHeightKey as String: oh])
        writer.add(input)
        guard reader.startReading(), writer.startWriting() else { return matteFail(writer.error?.localizedDescription ?? reader.error?.localizedDescription ?? "Couldn’t start", id) }
        writer.startSession(atSourceTime: .zero) // keep the source's frame times
        let req = VNGeneratePersonSegmentationRequest()
        req.qualityLevel = quality == "accurate" ? .accurate : quality == "fast" ? .fast : .balanced
        req.outputPixelFormat = kCVPixelFormatType_OneComponent8
        let ci = CIContext(options: [.cacheIntermediates: false])
        let total = max(0.001, CMTimeGetSeconds(asset.duration))
        var n = 0
        while let sb = out.copyNextSampleBuffer() {
            guard let pb = CMSampleBufferGetImageBuffer(sb) else { continue }
            let pts = CMSampleBufferGetPresentationTimeStamp(sb)
            try autoreleasepool {
                try VNImageRequestHandler(cvPixelBuffer: pb, options: [:]).perform([req])
                guard let mask = req.results?.first?.pixelBuffer, let pool = adaptor.pixelBufferPool else { return }
                var outBuf: CVPixelBuffer?
                CVPixelBufferPoolCreatePixelBuffer(nil, pool, &outBuf)
                guard let ob = outBuf else { return }
                let m = CIImage(cvPixelBuffer: mask)
                let sx = CGFloat(ow) / m.extent.width, sy = CGFloat(oh) / m.extent.height
                ci.render(m.transformed(by: CGAffineTransform(scaleX: sx, y: sy)), to: ob)
                while !input.isReadyForMoreMediaData { usleep(2000) }
                adaptor.append(ob, withPresentationTime: pts)
            }
            n += 1
            if n % 15 == 0 { send(["type": "matteProgress", "progress": true, "job": id ?? NSNull(), "value": min(1, CMTimeGetSeconds(pts) / total)]) }
        }
        input.markAsFinished()
        let done = DispatchSemaphore(value: 0)
        writer.finishWriting { done.signal() }
        done.wait()
        if writer.status != .completed { return matteFail(writer.error?.localizedDescription ?? "Couldn’t write the mask", id) }
        send(["type": "matteDone", "id": id ?? NSNull(), "frames": n, "width": ow, "height": oh])
    } catch {
        matteFail(error.localizedDescription, id)
    }
}

// ------------------------------------------------------------------ commands

func handle(_ m: [String: Any]) {
    let cmd = m["cmd"] as? String ?? ""
    let id = m["id"]
    switch cmd {
    case "list":
        var msg = listMessage(); if let id { msg["id"] = id }; send(msg)
    case "meter":
        metering = (m["on"] as? Bool) == true
        applyMeters()
        send(["type": "ok", "id": id ?? NSNull()])
    case "set":
        guard let key = m["key"] as? String, !key.isEmpty else { return fail("set: missing key", id) }
        var r = rules[key] ?? Rule()
        if let v = m["volume"] as? Double { r.volume = Float(max(0, min(4, v))) }
        if let v = m["mute"] as? Bool { r.mute = v }
        if let v = m["eq"] as? [Double] { r.eq = Array(v.prefix(10)) }
        if let v = m["strip"] as? [[Double]] { r.strip = Array(v.prefix(6)).map { Array($0.prefix(4)) } }
        if let v = m["pan"] as? Double { r.pan = Float(max(-1, min(1, v))) }
        if let v = m["output"] as? String { r.output = v }
        rules[key] = r
        applyRules()
        if metering { applyMeters() }
        send(["type": "ok", "id": id ?? NSNull()])
    case "recStart":
        guard let rid = m["rec"] as? String, let list = m["apps"] as? [[String: Any]] else { return fail("recStart: bad request", id) }
        let byKey = processesByKey()
        var routes: [TapRoute] = []
        var started: [[String: Any]] = []
        for a in list {
            guard let key = a["key"] as? String, let file = a["file"] as? String, file.hasPrefix("/"), file.hasSuffix(".wav") else { continue }
            let procs = byKey[key]?.procs.map(\.object) ?? []
            if procs.isEmpty { fail("\(key) isn't playing sound right now; it will be skipped", id); continue }
            let r = TapRoute(key: key, processes: procs, mixer: false)
            do { try r.start(outputUID: "", record: file); routes.append(r); started.append(["key": key, "file": file, "rate": r.format.mSampleRate, "channels": Int(r.format.mChannelsPerFrame)]) }
            catch { fail("\(key): \(error.localizedDescription)", id) }
        }
        recordings[rid] = routes
        send(["type": "recStarted", "id": id ?? NSNull(), "tracks": started])
    case "recStop":
        guard let rid = m["rec"] as? String else { return fail("recStop: bad request", id) }
        let routes = recordings.removeValue(forKey: rid) ?? []
        var files: [[String: Any]] = []
        for r in routes {
            let frames = r.framesWritten, rate = r.format.mSampleRate, ch = Int(r.format.mChannelsPerFrame)
            r.stop()
            files.append(["key": r.key, "frames": frames, "rate": rate, "channels": ch])
        }
        send(["type": "recStopped", "id": id ?? NSNull(), "tracks": files])
    case "matte":
        guard let src = m["src"] as? String, let dst = m["dst"] as? String, src.hasPrefix("/"), dst.hasPrefix("/"), dst.hasSuffix(".mp4") else { return matteFail("matte: bad request", id) }
        let q = (m["quality"] as? String) ?? "balanced"
        DispatchQueue.global(qos: .userInitiated).async { runMatte(src: src, dst: dst, quality: q, id: id) }
    case "conform":
        guard let src = m["src"] as? String, let dst = m["dst"] as? String, let kind = m["kind"] as? String, src.hasPrefix("/"), dst.hasPrefix("/") else { return conformFail("conform: bad request", id) }
        DispatchQueue.global(qos: .userInitiated).async {
            switch kind {
            case "image": conformImage(src: src, dstBase: dst, id: id)
            case "audio": conformAudio(src: src, dst: dst + ".wav", id: id)
            case "video": conformVideo(src: src, dst: dst + ".mp4", id: id)
            default: conformFail("conform: unknown kind", id)
            }
        }
    case "conformCancel":
        for ex in conformJobs.values { ex.cancelExport() }
        send(["type": "ok", "id": id ?? NSNull()])
    case "inputStart":
        let ok = input.start(keys: (m["keys"] as? Bool) ?? false)
        send(["type": "inputStarted", "id": id ?? NSNull(), "ok": ok])
    case "inputStop":
        input.stop()
        send(["type": "inputStopped", "id": id ?? NSNull()])
    case "auList", "auOpen", "auShow", "auState", "auClose", "auRender", "auPreview", "auPreviewStop":
        plugins.handle(cmd, m, id)
    case "quit":
        input.stop()
        for r in mixRoutes.values { r.stop() }
        for rs in recordings.values { for r in rs { r.stop() } }
        exit(0)
    default:
        fail("unknown command \(cmd)", id)
    }
}

// ------------------------------------------------------------------ Audio Unit host (CEDAR, Waves, …)
// Runs the user's installed effect plug-ins: lists them, opens their own editor windows, keeps their
// settings (as a full-state blob Reel stores in the project), renders files through a chain offline,
// and previews a file through a chain live.

func compKey(_ d: AudioComponentDescription) -> String {
    func fcc(_ v: OSType) -> String { String(bytes: [UInt8(v >> 24 & 255), UInt8(v >> 16 & 255), UInt8(v >> 8 & 255), UInt8(v & 255)], encoding: .macOSRoman) ?? "????" }
    return "\(fcc(d.componentType)):\(fcc(d.componentSubType)):\(fcc(d.componentManufacturer))"
}
func descFrom(_ key: String) -> AudioComponentDescription? {
    let parts = key.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
    guard parts.count == 3, parts.allSatisfy({ $0.utf8.count == 4 }) else { return nil }
    func code(_ s: String) -> OSType { s.data(using: .macOSRoman)!.reduce(0) { ($0 << 8) | OSType($1) } }
    return AudioComponentDescription(componentType: code(parts[0]), componentSubType: code(parts[1]), componentManufacturer: code(parts[2]), componentFlags: 0, componentFlagsMask: 0)
}
func stateBlob(_ au: AUAudioUnit) -> String {
    guard let st = au.fullState, let d = try? PropertyListSerialization.data(fromPropertyList: st, format: .binary, options: 0) else { return "" }
    return d.base64EncodedString()
}
func applyState(_ au: AUAudioUnit, _ b64: String?) {
    guard let b64, !b64.isEmpty, let d = Data(base64Encoded: b64),
          let st = try? PropertyListSerialization.propertyList(from: d, format: nil) as? [String: Any] else { return }
    au.fullState = st
}
func instantiate(_ key: String, completion: @escaping (AVAudioUnit?, String?) -> Void) {
    guard let desc = descFrom(key) else { return completion(nil, "Unknown plug-in \(key)") }
    // Out of process first: a plug-in that hangs (licence dialogs) or crashes can't take Reel's
    // helper down with it. Some older plug-ins only load in process.
    AVAudioUnit.instantiate(with: desc, options: [.loadOutOfProcess]) { unit, err in
        if let unit { return DispatchQueue.main.async { completion(unit, nil) } }
        AVAudioUnit.instantiate(with: desc, options: []) { unit2, err2 in
            DispatchQueue.main.async { completion(unit2, unit2 == nil ? ((err2 ?? err)?.localizedDescription ?? "The plug-in didn't load") : nil) }
        }
    }
}

final class PluginHost: NSObject, NSWindowDelegate {
    var slots: [String: AVAudioUnit] = [:]
    var windows: [String: NSWindow] = [:]
    var preview: AVAudioEngine?
    var previewNodes: [AVAudioNode] = []

    func handle(_ cmd: String, _ m: [String: Any], _ id: Any?) {
        let rid: Any = id ?? NSNull()
        switch cmd {
        case "auList":
            // Read the component registry only: nothing is loaded, so no licence checks or dialogs.
            var out: [[String: Any]] = []
            for type in [kAudioUnitType_Effect, kAudioUnitType_MusicEffect] {
                var d = AudioComponentDescription(componentType: type, componentSubType: 0, componentManufacturer: 0, componentFlags: 0, componentFlagsMask: 0)
                var comp = AudioComponentFindNext(nil, &d)
                while let c = comp {
                    var cd = AudioComponentDescription()
                    AudioComponentGetDescription(c, &cd)
                    var nameRef: Unmanaged<CFString>?
                    AudioComponentCopyName(c, &nameRef)
                    let full = (nameRef?.takeRetainedValue() as String?) ?? "?"
                    let parts = full.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
                    var ver: UInt32 = 0
                    AudioComponentGetVersion(c, &ver)
                    out.append(["id": compKey(cd), "name": parts.count > 1 ? parts[1] : full, "maker": parts.count > 1 ? parts[0] : "", "version": "\(ver >> 16).\((ver >> 8) & 255).\(ver & 255)"])
                    comp = AudioComponentFindNext(c, &d)
                }
            }
            send(["type": "auList", "id": rid, "plugins": out])
        case "auOpen":
            guard let slot = m["slot"] as? String, let key = m["plugin"] as? String else { return fail("auOpen: bad request", id) }
            instantiate(key) { unit, err in
                guard let unit else { return fail(err ?? "load failed", id) }
                self.close(slot)
                applyState(unit.auAudioUnit, m["state"] as? String)
                self.slots[slot] = unit
                send(["type": "auOpened", "id": rid, "slot": slot, "latency": unit.auAudioUnit.latency, "tail": unit.auAudioUnit.tailTime])
            }
        case "auShow":
            guard let slot = m["slot"] as? String, let unit = slots[slot] else { return fail("auShow: not open", id) }
            if let w = windows[slot] { NSApp.activate(ignoringOtherApps: true); w.makeKeyAndOrderFront(nil); return send(["type": "ok", "id": rid]) }
            unit.auAudioUnit.requestViewController { vc in
                DispatchQueue.main.async {
                    let title = (m["title"] as? String) ?? unit.name
                    let view: NSView
                    if let vc { view = vc.view } else {
                        // no custom editor: Apple's generic parameter view
                        let g = AUGenericView(audioUnit: unit.audioUnit); g.showsExpertParameters = true; view = g
                    }
                    var size = view.frame.size
                    if let vc, vc.preferredContentSize.width > 10 { size = vc.preferredContentSize }
                    if size.width < 200 || size.height < 100 { size = NSSize(width: max(size.width, 480), height: max(size.height, 320)) }
                    let w = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
                    w.title = title
                    w.isReleasedWhenClosed = false
                    if let vc { w.contentViewController = vc } else { w.contentView = view }
                    w.setContentSize(size)
                    w.center()
                    w.level = .floating
                    w.delegate = self
                    w.identifier = NSUserInterfaceItemIdentifier(slot)
                    self.windows[slot] = w
                    NSApp.activate(ignoringOtherApps: true)
                    w.makeKeyAndOrderFront(nil)
                    send(["type": "ok", "id": rid])
                }
            }
        case "auState":
            guard let slot = m["slot"] as? String, let unit = slots[slot] else { return fail("auState: not open", id) }
            send(["type": "auState", "id": rid, "slot": slot, "state": stateBlob(unit.auAudioUnit)])
        case "auClose":
            guard let slot = m["slot"] as? String else { return }
            var state = ""
            if let unit = slots[slot] { state = stateBlob(unit.auAudioUnit) }
            close(slot)
            send(["type": "auState", "id": rid, "slot": slot, "state": state])
        case "auRender":
            render(m, rid)
        case "auPreview":
            startPreview(m, rid)
        case "auPreviewStop":
            stopPreview(); send(["type": "ok", "id": rid])
        default: break
        }
    }

    func close(_ slot: String) {
        if let w = windows.removeValue(forKey: slot) { w.delegate = nil; w.close() }
        slots[slot] = nil
    }
    func windowWillClose(_ n: Notification) {
        guard let w = n.object as? NSWindow, let slot = w.identifier?.rawValue else { return }
        windows[slot] = nil
        if let unit = slots[slot] { send(["type": "auEdited", "slot": slot, "state": stateBlob(unit.auAudioUnit)]) }
    }

    /// Builds the chain's units (fresh instances with the given states, in order).
    func buildChain(_ chain: [[String: Any]], done: @escaping ([AVAudioUnit]?, String?) -> Void) {
        var units: [AVAudioUnit] = []
        func next(_ i: Int) {
            if i == chain.count { return done(units, nil) }
            guard let key = chain[i]["plugin"] as? String else { return done(nil, "bad chain") }
            instantiate(key) { u, err in
                guard let u else { return done(nil, err) }
                applyState(u.auAudioUnit, chain[i]["state"] as? String)
                units.append(u); next(i + 1)
            }
        }
        next(0)
    }

    /// Offline render: in.wav -> chain -> out.wav (same length; plug-in latency compensated).
    func render(_ m: [String: Any], _ rid: Any) {
        guard let inPath = m["in"] as? String, let outPath = m["out"] as? String, inPath.hasPrefix("/"), outPath.hasPrefix("/"), outPath.hasSuffix(".wav"),
              let chain = m["chain"] as? [[String: Any]] else { return fail("auRender: bad request", rid) }
        buildChain(chain) { units, err in
            guard let units else { return fail(err ?? "chain failed", rid) }
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let src = try AVAudioFile(forReading: URL(fileURLWithPath: inPath))
                    let fmt = AVAudioFormat(standardFormatWithSampleRate: src.processingFormat.sampleRate, channels: src.processingFormat.channelCount)!
                    let engine = AVAudioEngine()
                    let player = AVAudioPlayerNode()
                    engine.attach(player)
                    var last: AVAudioNode = player
                    for u in units { engine.attach(u); engine.connect(last, to: u, format: fmt); last = u }
                    engine.connect(last, to: engine.mainMixerNode, format: fmt)
                    try engine.enableManualRenderingMode(.offline, format: fmt, maximumFrameCount: 4096)
                    try engine.start()
                    player.scheduleFile(src, at: nil)
                    player.play()
                    let latency = units.reduce(0.0) { $0 + $1.auAudioUnit.latency }
                    let skip = AVAudioFramePosition(latency * fmt.sampleRate)
                    let total = src.length
                    let out = try AVAudioFile(forWriting: URL(fileURLWithPath: outPath), settings: [
                        AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: fmt.sampleRate, AVNumberOfChannelsKey: fmt.channelCount,
                        AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false,
                    ], commonFormat: .pcmFormatFloat32, interleaved: false)
                    let buf = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: engine.manualRenderingMaximumFrameCount)!
                    var rendered: AVAudioFramePosition = 0, written: AVAudioFramePosition = 0, lastP = Date()
                    while written < total {
                        let n = AVAudioFrameCount(min(Int64(buf.frameCapacity), total + skip - rendered))
                        if n == 0 { break }
                        let st = try engine.renderOffline(n, to: buf)
                        if st == .error { throw NSError(domain: "render", code: 1, userInfo: [NSLocalizedDescriptionKey: "A plug-in failed while rendering"]) }
                        let got = AVAudioFramePosition(buf.frameLength)
                        // drop the chain's latency from the start
                        var from: AVAudioFramePosition = 0
                        if rendered < skip { from = min(got, skip - rendered) }
                        rendered += got
                        let keep = min(got - from, total - written)
                        if keep > 0 {
                            let part = AVAudioPCMBuffer(pcmFormat: buf.format, frameCapacity: AVAudioFrameCount(keep))!
                            part.frameLength = AVAudioFrameCount(keep)
                            for c in 0..<Int(buf.format.channelCount) {
                                memcpy(part.floatChannelData![c], buf.floatChannelData![c] + Int(from), Int(keep) * 4)
                            }
                            try out.write(from: part)
                            written += keep
                        }
                        if Date().timeIntervalSince(lastP) > 0.5 { send(["type": "auProgress", "id": rid, "done": written, "total": total]); lastP = Date() }
                    }
                    engine.stop()
                    send(["type": "auRendered", "id": rid, "frames": written, "rate": fmt.sampleRate, "channels": Int(fmt.channelCount)])
                } catch {
                    fail("Plug-in render failed: \(error.localizedDescription)", rid)
                }
            }
        }
    }

    /// Live preview of a file through the open slots (so changes in the plug-in windows are heard).
    func startPreview(_ m: [String: Any], _ rid: Any) {
        stopPreview()
        guard let inPath = m["in"] as? String, inPath.hasPrefix("/"), let slotIds = m["slots"] as? [String] else { return fail("auPreview: bad request", rid) }
        do {
            let src = try AVAudioFile(forReading: URL(fileURLWithPath: inPath))
            let fmt = AVAudioFormat(standardFormatWithSampleRate: src.processingFormat.sampleRate, channels: src.processingFormat.channelCount)!
            let engine = AVAudioEngine()
            let player = AVAudioPlayerNode()
            engine.attach(player)
            var last: AVAudioNode = player
            for sid in slotIds { if let u = slots[sid] { engine.attach(u); engine.connect(last, to: u, format: fmt); last = u } }
            engine.connect(last, to: engine.mainMixerNode, format: fmt)
            // the output Reel plays through (Settings › Audio Hardware), found by its name; else the Mac's default
            if let want = m["device"] as? String, !want.isEmpty,
               let dev = outputDevices().first(where: { want == $0.name || want.hasPrefix($0.name) || $0.name.hasPrefix(want) }),
               let au = engine.outputNode.audioUnit {
                var devId = dev.id
                AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &devId, UInt32(MemoryLayout<AudioDeviceID>.size))
            }
            if let g = m["gain"] as? Double { player.volume = Float(max(0, min(4, g))) }
            let start = AVAudioFramePosition(max(0, (m["start"] as? Double ?? 0)) * fmt.sampleRate)
            let frames = AVAudioFrameCount(max(0, min(Int64(src.length) - start, Int64((m["seconds"] as? Double ?? 20) * fmt.sampleRate))))
            if frames > 0 { player.scheduleSegment(src, startingFrame: start, frameCount: frames, at: nil) }
            try engine.start()
            player.play()
            preview = engine; previewNodes = [player]
            send(["type": "ok", "id": rid])
        } catch { fail("Preview failed: \(error.localizedDescription)", rid) }
    }
    func stopPreview() {
        guard let e = preview else { return }
        e.stop()
        // detach the plug-ins so they can be used again elsewhere
        for n in e.attachedNodes where n !== e.mainMixerNode && n !== e.outputNode && n !== e.inputNode { e.detach(n) }
        preview = nil; previewNodes = []
    }
}
let plugins = PluginHost()

// stdin reader on a background thread; all work happens on the main queue
DispatchQueue.global().async {
    while let line = readLine() {
        guard let d = line.data(using: .utf8), let m = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { continue }
        DispatchQueue.main.async { handle(m) }
    }
    DispatchQueue.main.async { handle(["cmd": "quit"]) }
}
// pick up apps that start playing later, and send meters for active mixer routes
Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { _ in if !rules.isEmpty { applyRules() }; if metering { applyMeters() } }
Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
    if mixRoutes.isEmpty && meterRoutes.isEmpty { return }
    var levels: [String: [Double]] = [:]
    for (k, r) in mixRoutes { levels[k] = [Double(r.dsp.peaks[0]), Double(r.dsp.peaks[1]), Double(r.dsp.peak)] }
    for (k, r) in meterRoutes { r.dsp.peaks[0] *= 0.98; r.dsp.peaks[1] *= 0.98; levels[k] = [Double(r.dsp.peaks[0]), Double(r.dsp.peaks[1]), Double(r.dsp.peak)] }
    send(["type": "levels", "levels": levels])
}
send(["type": "ready", "version": 2])
// An accessory app: no Dock icon, but it can show plug-in windows.
let nsapp = NSApplication.shared
nsapp.setActivationPolicy(.accessory)
nsapp.run()
