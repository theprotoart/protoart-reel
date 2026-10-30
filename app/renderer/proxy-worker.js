// Proxy maker (module Web Worker): a smaller H.264 copy of a video for smooth editing. The picture is
// decoded in order, drawn at half (or quarter) size and encoded again; the sound is copied across
// untouched, so what you hear while editing is exactly the original. Export always reads the original.
import { Muxer, demux, sampleTime } from './lib/mp4.js';
import { HttpReader } from './lib/sources.js';

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
const idle = () => new Promise(r => setTimeout(r, 1));

async function pickEncoder(width, height, fps) {
  const bitrate = Math.round(Math.min(12e6, Math.max(1.5e6, width * height * fps * 0.09)));
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.640033']) {
    const cfg = { codec, avc: { format: 'avc' }, width, height, bitrate, framerate: fps, hardwareAcceleration: 'prefer-hardware', bitrateMode: 'variable', latencyMode: 'realtime' };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch { /* next */ }
  }
  throw new Error('No video encoder is available for this size.');
}

async function run({ url, divisor }) {
  cancelled = false;
  const reader = await new HttpReader(url).open();
  const d = await demux(reader);
  const v = d.tracks.find(t => t.kind === 'video' && t.codec);
  if (!v || !v.samples.length) throw new Error('No picture to make a proxy of');
  if (v.rotation) throw new Error('Rotated video plays from the original');
  const a = d.tracks.find(t => t.kind === 'audio');
  if (a && !(a.codec && /^mp4a/.test(a.codec) && a.description)) throw new Error('This sound format plays from the original');
  const dec0 = { codec: v.codec, description: v.description, codedWidth: v.width, codedHeight: v.height, hardwareAcceleration: 'prefer-hardware' };
  if (!(await VideoDecoder.isConfigSupported(dec0).then(r => r.supported).catch(() => false))) throw new Error('Can’t decode this video here');

  const k = Math.max(2, divisor | 0);
  const W = Math.max(2, Math.round(v.width / k / 2) * 2), H = Math.max(2, Math.round(v.height / k / 2) * 2);
  const span = v.samples.length > 1 ? Math.max(1e-3, sampleTime(v, v.samples[v.samples.length - 1]) - sampleTime(v, v.samples[0])) : 1;
  const fps = Math.min(120, Math.max(1, Math.round((v.samples.length - 1) / span) || 30));
  const vCfg = await pickEncoder(W, H, fps);
  const vTrack = { codec: vCfg.codec, width: W, height: H, description: null };
  const aTrack = a ? { codec: a.codec, sampleRate: a.sampleRate, channels: a.channels || 2, description: a.description } : null;
  const mux = new Muxer({ video: vTrack, audio: aTrack });

  let pending = [], pendingBytes = 0;
  const flush = force => {
    if (!pending.length || (!force && pendingBytes < (4 << 20))) return;
    const out = new Uint8Array(pendingBytes); let o = 0;
    for (const p of pending) { out.set(p, o); o += p.length; }
    pending = []; pendingBytes = 0;
    self.postMessage({ type: 'chunk', data: out }, [out.buffer]);
  };
  const emit = b => { pending.push(b); pendingBytes += b.length; flush(false); };

  // sound: original AAC packets, interleaved with the picture about a second ahead of it
  let ai = 0;
  const audioUpTo = async tSec => {
    if (!a) return;
    while (ai < a.samples.length) {
      const s = a.samples[ai];
      const t = sampleTime(a, s);
      if (t > tSec) break;
      const data = await reader.read(s.offset, s.size);
      emit(mux.addAudio(data, { timestamp: Math.round(t * 1e6), duration: Math.round((s.duration / a.timescale) * 1e6), key: true }));
      ai++;
    }
  };

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'medium';
  let encErr = null, decErr = null, made = 0;
  const encoded = [];
  const enc = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta && meta.decoderConfig && meta.decoderConfig.description && !vTrack.description) vTrack.description = new Uint8Array(meta.decoderConfig.description);
      const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
      encoded.push({ data, timestamp: chunk.timestamp, duration: chunk.duration || 1e6 / fps, key: chunk.type === 'key' });
    },
    error: e => { encErr = e; },
  });
  enc.configure(vCfg);
  const total = v.samples.length;
  const dec = new VideoDecoder({
    output: f => {
      try {
        ctx.drawImage(f, 0, 0, W, H);
        const vf = new VideoFrame(canvas, { timestamp: f.timestamp, duration: f.duration || Math.round(1e6 / fps) });
        enc.encode(vf, { keyFrame: made % (fps * 2) === 0 }); // a keyframe every 2 s keeps scrubbing quick
        vf.close();
        made++;
      } catch (e) { encErr = e; } finally { f.close(); }
    },
    error: e => { decErr = e; },
  });
  dec.configure(dec0);
  const drain = async () => {
    for (const c of encoded.splice(0)) {
      await audioUpTo(c.timestamp / 1e6 + 1);
      emit(mux.addVideo(c.data, c));
    }
  };
  for (let n = 0; n < total; n++) {
    check();
    const s = v.samples[n];
    const data = await reader.read(s.offset, s.size);
    dec.decode(new EncodedVideoChunk({ type: s.sync ? 'key' : 'delta', timestamp: Math.round(sampleTime(v, s) * 1e6), duration: Math.round((s.duration / v.timescale) * 1e6), data }));
    while (dec.decodeQueueSize > 6 || enc.encodeQueueSize > 6) await idle();
    if (decErr) throw new Error(`Video decoding failed: ${decErr.message || decErr}`);
    if (encErr) throw encErr;
    await drain();
    if (n % 15 === 0) self.postMessage({ type: 'progress', value: n / total });
  }
  await dec.flush().catch(e => { decErr = decErr || e; });
  dec.close();
  await enc.flush();
  enc.close();
  if (decErr) throw new Error(`Video decoding failed: ${decErr.message || decErr}`);
  if (encErr) throw encErr;
  await drain();
  await audioUpTo(Infinity);
  if (!made) throw new Error('No frames came out of the decoder');
  flush(true);
  return { head: mux.finish(), width: W, height: H };
}
