// Converts WebM / Matroska (MKV, MKA) into something the editor can use, inside the editor (macOS can't read
// these): H.264 / HEVC and AAC are copied across untouched into an MP4 (fast, no quality loss); VP8, VP9 and
// AV1 are decoded and encoded again as H.264, and Opus, Vorbis, FLAC, MP3 and PCM sound becomes AAC. Files
// with no picture come out as a 32-bit float WAV.
import { Muxer } from './lib/mp4.js';
import { HttpReader } from './lib/sources.js';
import { openMatroska } from './lib/mkv.js';

let cancelled = false;
self.onmessage = async e => {
  const m = e.data;
  if (m.type === 'cancel') { cancelled = true; return; }
  if (m.type !== 'start') return;
  try {
    const r = await run(m);
    self.postMessage({ type: 'done', ...r }, [r.head.buffer]);
  } catch (err) { self.postMessage({ type: 'error', message: cancelled ? 'Cancelled' : String((err && err.message) || err) }); }
};
const check = () => { if (cancelled) throw new Error('Cancelled'); };
const idle = () => new Promise(r => setTimeout(r, 1));
const hex = b => b.toString(16).padStart(2, '0');

// ------------------------------------------------------------------ output
let pending = [], pendingBytes = 0;
const flush = force => {
  if (!pending.length || (!force && pendingBytes < (4 << 20))) return;
  const out = new Uint8Array(pendingBytes); let o = 0;
  for (const p of pending) { out.set(p, o); o += p.length; }
  pending = []; pendingBytes = 0;
  self.postMessage({ type: 'chunk', data: out }, [out.buffer]);
};
const emit = b => { pending.push(b); pendingBytes += b.length; flush(false); };

async function pickEncoder(width, height, fps) {
  const bitrate = Math.round(Math.min(40e6, Math.max(4e6, width * height * fps * 0.12)));
  for (const codec of [width * height > 1920 * 1088 ? 'avc1.640033' : 'avc1.640028', 'avc1.4d0033', 'avc1.640034']) {
    const cfg = { codec, avc: { format: 'avc' }, width, height, bitrate, framerate: fps, hardwareAcceleration: 'prefer-hardware', bitrateMode: 'variable', latencyMode: 'quality' };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch { /* next */ }
  }
  throw new Error('No video encoder is available for this size.');
}

/** Decoder settings for a Matroska video track, or null when it's copied across as it is. */
function videoDecoderConfig(t) {
  const desc = t.codecPrivate || undefined;
  switch (t.codecId) {
    case 'V_VP8': return [{ codec: 'vp8', codedWidth: t.width, codedHeight: t.height }];
    case 'V_VP9': return ['vp09.00.10.08', 'vp09.00.40.08', 'vp09.02.10.10', 'vp09.01.10.08'].map(codec => ({ codec, codedWidth: t.width, codedHeight: t.height }));
    case 'V_AV1': return ['av01.0.08M.08', 'av01.0.12M.10', 'av01.0.05M.08'].map(codec => ({ codec, codedWidth: t.width, codedHeight: t.height, description: desc }));
    default: return null;
  }
}
function audioDecoderConfig(t) {
  const desc = t.codecPrivate || undefined, sr = Math.round(t.sampleRate), ch = t.channels || 2;
  switch (t.codecId) {
    case 'A_OPUS': return { codec: 'opus', sampleRate: 48000, numberOfChannels: ch, description: desc };
    case 'A_VORBIS': return { codec: 'vorbis', sampleRate: sr, numberOfChannels: ch, description: desc };
    case 'A_FLAC': return { codec: 'flac', sampleRate: sr, numberOfChannels: ch, description: desc };
    case 'A_MPEG/L3': case 'A_MPEG/L2': return { codec: 'mp3', sampleRate: sr, numberOfChannels: ch };
    case 'A_AAC': case 'A_AAC/MPEG4/LC': case 'A_AAC/MPEG2/LC': return { codec: 'mp4a.40.2', sampleRate: sr, numberOfChannels: ch, description: desc };
    default: return null;
  }
}

async function run({ url }) {
  cancelled = false; pending = []; pendingBytes = 0;
  const reader = await new HttpReader(url).open();
  const mk = await openMatroska(reader);
  const vt = mk.tracks.find(t => t.type === 'video'), at = mk.tracks.find(t => t.type === 'audio');
  if (!vt && !at) throw new Error('No picture or sound in this file');
  self.postMessage({ type: 'format', ext: vt ? 'mp4' : 'wav' });
  const total = mk.duration || 0;
  const progress = t => { if (total > 0) self.postMessage({ type: 'progress', value: Math.min(1, t / total) }); };

  // ---------------- sound: copied (AAC into MP4) or decoded
  const copyAudio = !!vt && at && /^A_AAC/.test(at.codecId) && at.codecPrivate;
  let adec = null, aenc = null, aErr = null, aTrack = null;
  const pcm = []; let pcmFrames = 0; // sound-only output
  const outRate = at ? (Math.round(at.codecId === 'A_OPUS' ? 48000 : at.sampleRate) === 44100 ? 44100 : 48000) : 48000;
  const outCh = at ? Math.min(2, at.channels || 2) : 2;
  if (at) {
    if (copyAudio) aTrack = { codec: 'mp4a.40.2', sampleRate: Math.round(at.sampleRate), channels: at.channels || 2, description: at.codecPrivate };
    else {
      const pcmLE = /^A_PCM\/(INT\/LIT|FLOAT\/IEEE)/.test(at.codecId);
      const cfg = pcmLE ? null : audioDecoderConfig(at);
      if (!pcmLE && (!cfg || !(await AudioDecoder.isConfigSupported(cfg).then(r => r.supported).catch(() => false)))) throw new Error(`This file’s sound (${at.codecId}) can’t be read here.`);
      if (vt) {
        aTrack = { codec: 'mp4a.40.2', sampleRate: outRate, channels: outCh, description: null };
        const ecfg = { codec: 'mp4a.40.2', sampleRate: outRate, numberOfChannels: outCh, bitrate: 192000 };
        if (!(await AudioEncoder.isConfigSupported(ecfg).then(r => r.supported).catch(() => false))) throw new Error('This Mac can’t encode AAC sound here.');
        aenc = new AudioEncoder({
          output: (chunk, meta) => {
            if (meta?.decoderConfig?.description && !aTrack.description) aTrack.description = new Uint8Array(meta.decoderConfig.description);
            const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d);
            audioOut.push({ d, timestamp: chunk.timestamp, duration: chunk.duration });
          },
          error: err => { aErr = err; },
        });
        aenc.configure(ecfg);
      }
      if (!pcmLE) {
        adec = new AudioDecoder({ output: ad => { try { takePCM(ad); } finally { ad.close(); } }, error: err => { aErr = err; } });
        adec.configure(cfg);
      }
    }
  }
  // decoded sound → (resampled, ≤ 2 channels) → AAC encoder, or kept for the WAV
  let aPos = 0;
  const audioOut = [];
  function takePCM(ad) {
    const n = ad.numberOfFrames, ch = ad.numberOfChannels, sr = ad.sampleRate;
    const planes = [];
    for (let c = 0; c < ch; c++) { const p = new Float32Array(n); ad.copyTo(p, { planeIndex: c, format: 'f32-planar' }); planes.push(p); }
    pushPCM(planes, sr);
  }
  function pushPCM(planes, sr) {
    // down to the output channel count (average extras), then to the output rate (linear)
    const n = planes[0].length;
    let out = Array.from({ length: outCh }, (_, c) => planes[Math.min(c, planes.length - 1)]);
    if (planes.length > outCh && outCh === 2) { const l = new Float32Array(n), r = new Float32Array(n); for (let i = 0; i < n; i++) { let a = 0, b = 0; planes.forEach((p, k) => { if (k % 2) b += p[i]; else a += p[i]; }); l[i] = a / Math.ceil(planes.length / 2); r[i] = b / Math.floor(planes.length / 2); } out = [l, r]; }
    if (sr !== outRate) {
      const m = Math.round((n * outRate) / sr);
      out = out.map(p => { const q = new Float32Array(m); for (let i = 0; i < m; i++) { const x = (i * sr) / outRate, k = Math.floor(x), u = x - k; q[i] = (p[k] || 0) * (1 - u) + (p[Math.min(n - 1, k + 1)] || 0) * u; } return q; });
    }
    const m = out[0].length;
    if (aenc) {
      const data = new Float32Array(m * outCh); out.forEach((p, c) => data.set(p, c * m));
      const ad = new AudioData({ format: 'f32-planar', sampleRate: outRate, numberOfFrames: m, numberOfChannels: outCh, timestamp: Math.round((aPos / outRate) * 1e6), data });
      aenc.encode(ad); ad.close();
    } else { const inter = new Float32Array(m * outCh); for (let i = 0; i < m; i++) for (let c = 0; c < outCh; c++) inter[i * outCh + c] = out[c][i]; pcm.push(inter); pcmFrames += m; if (pcm.length > 32) drainPCM(); }
    aPos += m;
  }
  function drainPCM() { for (const p of pcm.splice(0)) emit(new Uint8Array(p.buffer)); }
  function pcmFromBlock(data) { // A_PCM: little-endian integers or floats
    const ch = at.channels || 1, bits = at.bitDepth || 16, float = /FLOAT/.test(at.codecId), bps = bits / 8, n = Math.floor(data.length / (bps * ch));
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength), planes = Array.from({ length: ch }, () => new Float32Array(n));
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
      const o = (i * ch + c) * bps;
      planes[c][i] = float ? (bits === 64 ? dv.getFloat64(o, true) : dv.getFloat32(o, true)) : bits === 16 ? dv.getInt16(o, true) / 32768 : bits === 24 ? (((dv.getUint8(o + 2) << 24) | (dv.getUint8(o + 1) << 16) | (dv.getUint8(o) << 8)) >> 8) / 8388608 : bits === 32 ? dv.getInt32(o, true) / 2147483648 : (dv.getUint8(o) - 128) / 128;
    }
    pushPCM(planes, Math.round(at.sampleRate));
  }

  // ---------------- picture: copied (H.264 / HEVC) or decoded and encoded again
  let vTrack = null, vdec = null, venc = null, vErr = null, mux = null;
  const videoOut = [];
  let fps = vt && vt.defaultDuration ? Math.round(1e9 / vt.defaultDuration) : 30;
  if (vt) {
    const p = vt.codecPrivate;
    if (vt.codecId === 'V_MPEG4/ISO/AVC' && p) vTrack = { codec: `avc1.${hex(p[1])}${hex(p[2])}${hex(p[3])}`, width: vt.width, height: vt.height, description: p };
    else if (vt.codecId === 'V_MPEGH/ISO/HEVC' && p) vTrack = { codec: 'hvc1.1.6.L120.90', width: vt.width, height: vt.height, description: p };
    else {
      const cfgs = videoDecoderConfig(vt);
      if (!cfgs) throw new Error(`This file’s picture (${vt.codecId.replace(/^V_/, '')}) can’t be read here. Export it as MP4 (H.264) first.`);
      let dcfg = null;
      for (const c of cfgs) { try { if ((await VideoDecoder.isConfigSupported(c)).supported) { dcfg = c; break; } } catch { /* next */ } }
      if (!dcfg) throw new Error(`This Mac can’t decode ${vt.codecId.replace(/^V_/, '')} video here.`);
      const W = vt.width & ~1, H = vt.height & ~1;
      fps = Math.max(1, Math.min(120, fps || 30));
      const ecfg = await pickEncoder(W, H, fps);
      vTrack = { codec: ecfg.codec, width: W, height: H, description: null };
      let made = 0;
      venc = new VideoEncoder({
        output: (chunk, meta) => {
          if (meta?.decoderConfig?.description && !vTrack.description) vTrack.description = new Uint8Array(meta.decoderConfig.description);
          const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d);
          videoOut.push({ d, timestamp: chunk.timestamp, duration: chunk.duration || 1e6 / fps, key: chunk.type === 'key' });
        },
        error: err => { vErr = err; },
      });
      venc.configure(ecfg);
      vdec = new VideoDecoder({
        output: f => { try { venc.encode(f, { keyFrame: made++ % (fps * 2) === 0 }); } catch (err) { vErr = err; } finally { f.close(); } },
        error: err => { vErr = err; },
      });
      vdec.configure(dcfg);
    }
    mux = new Muxer({ video: vTrack, audio: aTrack });
  }
  const drain = () => {
    if (!mux) return;
    for (const v of videoOut.splice(0)) emit(mux.addVideo(v.d, v));
    for (const a of audioOut.splice(0)) emit(mux.addAudio(a.d, { timestamp: a.timestamp, duration: a.duration, key: true }));
  };

  // ---------------- go through the file
  let n = 0;
  for await (const f of mk.frames()) {
    check();
    const ts = Math.round(f.time * 1e6);
    if (f.track === vt) {
      if (vdec) {
        vdec.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: ts, data: f.data }));
        while (vdec.decodeQueueSize > 6 || venc.encodeQueueSize > 6) await idle();
      } else videoOut.push({ d: f.data.slice(), timestamp: ts, duration: f.duration ? Math.round(f.duration * 1e6) : 0, key: f.key });
    } else if (f.track === at) {
      if (copyAudio) audioOut.push({ d: f.data.slice(), timestamp: ts, duration: Math.round((1024 / at.sampleRate) * 1e6) });
      else if (adec) { adec.decode(new EncodedAudioChunk({ type: 'key', timestamp: ts, data: f.data })); while (adec.decodeQueueSize > 16) await idle(); }
      else pcmFromBlock(f.data);
    }
    if (vErr) throw new Error(`Video: ${vErr.message || vErr}`);
    if (aErr) throw new Error(`Sound: ${aErr.message || aErr}`);
    drain();
    if (++n % 60 === 0) { progress(f.time); await idle(); }
  }
  if (vdec) { await vdec.flush(); vdec.close(); }
  if (venc) { await venc.flush(); venc.close(); }
  if (adec) { await adec.flush(); adec.close(); }
  if (aenc) { await aenc.flush(); aenc.close(); }
  if (vErr) throw new Error(`Video: ${vErr.message || vErr}`);
  if (aErr) throw new Error(`Sound: ${aErr.message || aErr}`);
  drain();
  if (!vt) { // sound only: a WAV
    drainPCM(); flush(true);
    const dataBytes = pcmFrames * outCh * 4, h = new DataView(new ArrayBuffer(44));
    const s = (o, t) => { for (let i = 0; i < t.length; i++) h.setUint8(o + i, t.charCodeAt(i)); };
    s(0, 'RIFF'); h.setUint32(4, 36 + dataBytes, true); s(8, 'WAVE'); s(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 3, true); h.setUint16(22, outCh, true);
    h.setUint32(24, outRate, true); h.setUint32(28, outRate * outCh * 4, true); h.setUint16(32, outCh * 4, true); h.setUint16(34, 32, true); s(36, 'data'); h.setUint32(40, dataBytes, true);
    return { head: new Uint8Array(h.buffer), ext: 'wav' };
  }
  if (!vTrack.description) throw new Error('No picture came out of this file');
  flush(true);
  return { head: mux.finish(), ext: 'mp4' };
}
