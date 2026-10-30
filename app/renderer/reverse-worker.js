// Play in Reverse (module Web Worker): renders a reversed copy of the part of a media file a clip uses.
// Video is decoded in small windows from the nearest keyframe, copied out of the decoder, then encoded
// back to front, so memory stays at a few hundred MB even on an 8 GB Mac. Sound is reversed in blocks.
import { Muxer, demux, keyframeBefore, sampleTime } from './lib/mp4.js';
import { HttpReader, WavAudio, Mp4Audio } from './lib/sources.js';

let cancelled = false;
self.onmessage = async e => {
  const m = e.data;
  if (m.type === 'cancel') { cancelled = true; return; }
  if (m.type !== 'start') return;
  try {
    const res = await run(m);
    self.postMessage({ type: 'done', ...res }, [res.head.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: cancelled ? 'Cancelled' : String((err && err.message) || err) });
  }
};

const check = () => { if (cancelled) throw new Error('Cancelled'); };

async function pickEncoder(width, height, fps) {
  const bitrate = Math.round(Math.min(40e6, width * height * fps * 0.18));
  for (const codec of [width * height > 1920 * 1088 ? 'avc1.640033' : 'avc1.640028', 'avc1.4d0033', 'avc1.4d0028']) {
    const cfg = { codec, avc: { format: 'avc' }, width, height, bitrate, framerate: fps, hardwareAcceleration: 'prefer-hardware', bitrateMode: 'variable', latencyMode: 'quality' };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch { /* next */ }
  }
  throw new Error('No video encoder is available for this size.');
}

async function run({ url, file, from, to }) {
  cancelled = false;
  const reader = await new HttpReader(url).open();
  const isWav = /\.wav$/i.test(file);
  const d = isWav ? { tracks: [] } : await demux(reader);
  const v = d.tracks.find(t => t.kind === 'video' && t.codec);
  const aT = d.tracks.find(t => t.kind === 'audio' && t.codec);
  const audio = isWav ? await new WavAudio(reader).open() : aT ? await new Mp4Audio(reader, aT).open() : null;

  // ---------------- output
  let pending = [], pendingBytes = 0;
  const flush = force => {
    if (!pending.length || (!force && pendingBytes < (4 << 20))) return;
    const out = new Uint8Array(pendingBytes); let o = 0;
    for (const p of pending) { out.set(p, o); o += p.length; }
    pending = []; pendingBytes = 0;
    self.postMessage({ type: 'chunk', data: out }, [out.buffer]);
  };
  const emit = b => { pending.push(b); pendingBytes += b.length; flush(false); };

  // presentation-ordered video frames inside [from, to)
  let frames = [];
  if (v) {
    frames = v.samples.map((s, i) => ({ i, t: sampleTime(v, s), d: s.duration / v.timescale })).filter(f => f.t >= from - 1e-6 && f.t < to - 1e-6).sort((a, b) => a.t - b.t);
  }
  const fps = frames.length > 1 ? Math.min(120, Math.max(1, Math.round((frames.length - 1) / Math.max(1e-3, frames[frames.length - 1].t - frames[0].t)))) : 30;
  const vTrack = frames.length ? { codec: '', width: 0, height: 0, description: null } : null;
  const aRate = audio ? audio.rate : 48000, aCh = audio ? Math.min(2, audio.channels || 2) : 2;
  const aTrack = audio ? { codec: 'mp4a.40.2', sampleRate: aRate, channels: aCh, description: null } : null;
  if (!vTrack && !aTrack) throw new Error('Nothing to reverse');

  let encErr = null, venc = null, aenc = null, mux = null;
  // sound-only clips come back as a WAV (lossless, and no AAC encoder needed)
  const wavOut = !vTrack && !!audio;
  const aBlocks = audio ? Math.max(1, Math.ceil(((to - from) * aRate) / (aRate * 2))) : 0;
  const total = frames.length + aBlocks;
  let done = 0;
  const progress = () => self.postMessage({ type: 'progress', value: total ? done / total : 0 });

  // ---------------- video, window by window from the end
  if (vTrack) {
    const decoderCfg = { codec: v.codec, description: v.description, codedWidth: v.width, codedHeight: v.height, hardwareAcceleration: 'prefer-hardware' };
    // keep each window's copied frames to ~200 MB
    const frameBytes = Math.max(1, v.width * v.height * 1.5);
    const W = Math.max(8, Math.min(96, Math.floor((200 << 20) / frameBytes)));
    const decodeOrder = v.samples; // decode order
    const indexOfSample = new Map(frames.map((f, k) => [f.i, k]));
    let outIndex = 0;
    for (let hi = frames.length; hi > 0; hi -= W) {
      check();
      const lo = Math.max(0, hi - W);
      const want = new Map(); // timestamp µs -> window slot
      for (let k = lo; k < hi; k++) want.set(Math.round(frames[k].t * 1e6), k);
      const tFirst = frames[lo].t, tLast = frames[hi - 1].t;
      const copies = new Map(), copying = [];
      let decErr = null;
      const dec = new VideoDecoder({
        output: f => {
          const k = want.get(f.timestamp);
          if (k === undefined || copies.has(k)) { f.close(); return; }
          copies.set(k, null);
          const buf = new Uint8Array(f.allocationSize());
          const meta = { format: f.format, codedWidth: f.codedWidth, codedHeight: f.codedHeight, displayWidth: f.displayWidth, displayHeight: f.displayHeight, visibleRect: f.visibleRect };
          copying.push(f.copyTo(buf).then(layout => { copies.set(k, { buf, layout, ...meta }); }, e => { decErr = e; }).finally(() => f.close()));
        },
        error: e => { decErr = e; },
      });
      dec.configure(decoderCfg);
      // feed from the keyframe before the window until every frame of the window is out
      let n = keyframeBefore(v, tFirst);
      const lastSampleIdx = Math.max(...frames.slice(lo, hi).map(f => f.i));
      for (; n < decodeOrder.length; n++) {
        check();
        const s = decodeOrder[n];
        const data = await reader.read(s.offset, s.size);
        dec.decode(new EncodedVideoChunk({ type: s.sync ? 'key' : 'delta', timestamp: Math.round(sampleTime(v, s) * 1e6), duration: Math.round((s.duration / v.timescale) * 1e6), data }));
        while (dec.decodeQueueSize > 8) await new Promise(r => setTimeout(r, 1));
        if (n >= lastSampleIdx + 16 && sampleTime(v, s) > tLast) break; // past reorder depth
      }
      await dec.flush().catch(e => { decErr = decErr || e; });
      await Promise.all(copying);
      dec.close();
      if (decErr) throw new Error(`Video decoding failed: ${decErr.message || decErr}`);

      // encode the window back to front
      for (let k = hi - 1; k >= lo; k--) {
        check();
        const c = copies.get(k) || copies.get(k + 1) || copies.get(k - 1) || [...copies.values()].find(Boolean);
        if (!c) throw new Error('A frame could not be decoded');
        if (!venc) {
          const W2 = c.displayWidth & ~1, H2 = c.displayHeight & ~1;
          const cfg = await pickEncoder(W2, H2, fps);
          vTrack.codec = cfg.codec; vTrack.width = W2; vTrack.height = H2;
          mux = new Muxer({ video: vTrack, audio: aTrack });
          venc = new VideoEncoder({
            output: (chunk, meta) => {
              if (meta && meta.decoderConfig && meta.decoderConfig.description && !vTrack.description) vTrack.description = new Uint8Array(meta.decoderConfig.description);
              const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
              emit(mux.addVideo(data, { timestamp: chunk.timestamp, duration: chunk.duration || 1e6 / fps, key: chunk.type === 'key' }));
            },
            error: e => { encErr = e; },
          });
          venc.configure(cfg);
        }
        // output time: distance from the end of the range to the end of this source frame
        const f = frames[k];
        const ts = Math.max(0, Math.round((to - (f.t + f.d)) * 1e6));
        const vf = new VideoFrame(c.buf, { format: c.format, codedWidth: c.codedWidth, codedHeight: c.codedHeight, displayWidth: c.displayWidth, displayHeight: c.displayHeight, visibleRect: c.visibleRect, layout: c.layout, timestamp: ts, duration: Math.round(f.d * 1e6) });
        venc.encode(vf, { keyFrame: outIndex % Math.max(1, fps * 2) === 0 });
        vf.close();
        outIndex++;
        while (venc.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 1));
        if (encErr) throw encErr;
        done++;
        if (done % 10 === 0) progress();
      }
      copies.clear();
      void indexOfSample;
    }
    await venc.flush();
  }
  if (wavOut) return { head: await reverseWav(audio, from, to, aRate, aCh, emit, flush, () => { done++; progress(); }) };
  if (!mux) mux = new Muxer({ video: null, audio: aTrack });

  // ---------------- audio, block by block from the end
  if (audio && !(await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: aRate, numberOfChannels: aCh, bitrate: 192000 }).then(r => r.supported).catch(() => false))) {
    throw new Error('This Mac can’t encode AAC sound here. Detach the audio first (Edit › Detach Audio) and reverse the sound clip on its own.');
  }
  if (audio) {
    aenc = new AudioEncoder({
      output: (chunk, meta) => {
        if (meta && meta.decoderConfig && meta.decoderConfig.description && !aTrack.description) aTrack.description = new Uint8Array(meta.decoderConfig.description);
        const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
        emit(mux.addAudio(data, { timestamp: chunk.timestamp, duration: chunk.duration, key: true }));
      },
      error: e => { encErr = e; },
    });
    aenc.configure({ codec: 'mp4a.40.2', sampleRate: aRate, numberOfChannels: aCh, bitrate: 192000 });
    const s0 = Math.round(from * aRate), s1 = Math.round(to * aRate);
    const BLOCK = aRate * 2;
    let outPos = 0;
    for (let end = s1; end > s0; end -= BLOCK) {
      check();
      const start = Math.max(s0, end - BLOCK), n = end - start;
      const pcm = await audio.read(start, n);
      const planar = new Float32Array(n * aCh);
      for (let c = 0; c < aCh; c++) {
        const src = pcm[Math.min(c, pcm.length - 1)];
        for (let i = 0; i < n; i++) planar[c * n + i] = src[n - 1 - i];
      }
      const ad = new AudioData({ format: 'f32-planar', sampleRate: aRate, numberOfFrames: n, numberOfChannels: aCh, timestamp: Math.round((outPos / aRate) * 1e6), data: planar });
      aenc.encode(ad); ad.close();
      outPos += n;
      while (aenc.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 1));
      if (encErr) throw encErr;
      done++; progress();
    }
    await aenc.flush();
  }
  if (encErr) throw encErr;
  flush(true);
  const head = mux.finish();
  return { head };
}

/** Sound-only reverse: 32-bit float WAV, written block by block from the end. Returns the header. */
async function reverseWav(audio, from, to, rate, ch, emit, flush, tick) {
  const s0 = Math.round(from * rate), s1 = Math.round(to * rate), BLOCK = rate * 2;
  for (let end = s1; end > s0; end -= BLOCK) {
    check();
    const start = Math.max(s0, end - BLOCK), n = end - start;
    const pcm = await audio.read(start, n);
    const out = new Float32Array(n * ch);
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) out[i * ch + c] = pcm[Math.min(c, pcm.length - 1)][n - 1 - i];
    emit(new Uint8Array(out.buffer));
    tick();
  }
  flush(true);
  const frames = s1 - s0, dataBytes = frames * ch * 4;
  const h = new DataView(new ArrayBuffer(44));
  const str = (o, t) => { for (let i = 0; i < t.length; i++) h.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); h.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 3, true); h.setUint16(22, ch, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * ch * 4, true); h.setUint16(32, ch * 4, true); h.setUint16(34, 32, true);
  str(36, 'data'); h.setUint32(40, dataBytes, true);
  return new Uint8Array(h.buffer);
}
