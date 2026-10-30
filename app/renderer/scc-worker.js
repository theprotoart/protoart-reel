// ScreenFlow recording converter (module Web Worker). A ScreenFlow .scc holds the screen as changed regions in
// its own codec, the sound in its own lossless coder and the pointer as a separate track. This turns the screen
// into an H.264 MP4 (the pointer left out: Reel draws it, from the track handed back), and the sound into a WAV,
// mixing the recording's input channels the way the ScreenFlow project had them.
import { Muxer } from './lib/mp4.js';
import { HttpReader } from './lib/sources.js';
import { openScc, VvDecoder, decodeAudioPacket, cursorTrack } from './lib/scc.js';

let cancelled = false;
self.onmessage = async e => {
  const m = e.data;
  if (m.type === 'cancel') { cancelled = true; return; }
  try {
    const reader = await new HttpReader(m.url).open();
    const scc = await openScc(reader);
    if (m.type === 'info') return self.postMessage({ type: 'done', streams: scc.streams });
    if (m.type === 'video') return await video(scc, m);
    if (m.type === 'audio') return await audio(scc, m);
  } catch (err) {
    self.postMessage({ type: 'error', message: cancelled ? 'Cancelled' : String((err && err.message) || err) });
  }
};
const check = () => { if (cancelled) throw new Error('Cancelled'); };
const idle = () => new Promise(r => setTimeout(r, 1));

/** zlib (with header) → bytes, by the browser's own decompressor. */
async function inflate(data, expect) {
  const ds = new DecompressionStream('deflate'), w = ds.writable.getWriter();
  w.write(data); w.close();
  const out = new Uint8Array(await new Response(ds.readable).arrayBuffer());
  if (expect && out.length !== expect) throw new Error('A ScreenFlow frame didn’t unpack to the right size');
  return out;
}
/** Start of the recording (µs host time): the earliest frame or packet of any stream. */
const startOf = scc => Math.min(...scc.streams.filter(s => s.kind === 'video' || s.kind === 'audio').map(s => scc.byStream(s.id)[0]?.hostTime ?? Infinity));

async function pickEncoder(width, height) {
  const bitrate = Math.round(Math.min(40e6, Math.max(4e6, width * height * 2)));
  for (const codec of ['avc1.640033', 'avc1.640034', 'avc1.4d0033', 'hvc1.1.6.L153.B0', 'hvc1.1.6.L156.B0']) {
    const cfg = { codec, width, height, bitrate, framerate: 60, hardwareAcceleration: 'prefer-hardware', bitrateMode: 'variable', latencyMode: 'quality' };
    if (codec.startsWith('avc1')) cfg.avc = { format: 'avc' }; else cfg.hevc = { format: 'hevc' };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch { /* next */ }
  }
  throw new Error('No video encoder is available for a recording this size.');
}

async function video(scc, { stream, testCodec, fps = 30 }) {
  const vs = scc.streams.find(s => s.id === stream && s.kind === 'video');
  if (!vs) throw new Error('That recording has no picture');
  if (vs.pixelFormat !== 0x34323076) throw new Error('This ScreenFlow recording uses a picture format Reel can’t read yet');
  const frames = scc.byStream(vs.id);
  if (!frames.length) throw new Error('That recording has no frames');
  const W = vs.width & ~1, H = vs.height & ~1, t0 = startOf(scc);
  // testCodec: only for automated checks in browsers without H.264 (the output isn't a usable MP4 then)
  const cfg = testCodec ? { codec: testCodec, width: W, height: H, bitrate: 8e6, framerate: 60 } : await pickEncoder(W, H);
  self.postMessage({ type: 'format', ext: 'mp4' });
  const vTrack = { codec: cfg.codec, width: W, height: H, description: null };
  const mux = new Muxer({ video: vTrack });
  let pending = [], pendingBytes = 0;
  const flush = force => {
    if (!pending.length || (!force && pendingBytes < (4 << 20))) return;
    const out = new Uint8Array(pendingBytes); let o = 0;
    for (const p of pending) { out.set(p, o); o += p.length; }
    pending = []; pendingBytes = 0;
    self.postMessage({ type: 'chunk', data: out }, [out.buffer]);
  };
  let encErr = null;
  const encoded = [];
  const enc = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig?.description && !vTrack.description) vTrack.description = new Uint8Array(meta.decoderConfig.description);
      const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
      encoded.push({ data, timestamp: chunk.timestamp, duration: chunk.duration, key: chunk.type === 'key' });
    },
    error: e => { encErr = e; },
  });
  enc.configure(cfg);
  const drain = () => { for (const c of encoded.splice(0)) { const d = mux.addVideo(c.data, c); pending.push(d); pendingBytes += d.length; } flush(false); };
  const dec = new VvDecoder(vs.width, vs.height, vs.codecFormat);
  const colorSpace = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
  // ScreenFlow stores full-range values (black 0, white 255) though the stream says '420v'. Players treat
  // H.264 as video range, so it is squeezed to 16–235 / 16–240 here; without this the picture came out
  // too dark and contrasty.
  const lutY = new Uint8Array(256), lutC = new Uint8Array(256);
  for (let i = 0; i < 256; i++) { lutY[i] = Math.round(16 + (i * 219) / 255); lutC[i] = Math.round(128 + ((i - 128) * 224) / 255); }
  const ysz = vs.width * vs.height, out = new Uint8Array(ysz + 2 * ((vs.width >> 1) * (vs.height >> 1)));
  const ranged = () => { const src = dec.i420(); for (let i = 0; i < ysz; i++) out[i] = lutY[src[i]]; for (let i = ysz; i < out.length; i++) out[i] = lutC[src[i]]; return out; };
  const audioEnd = Math.max(0, ...scc.streams.filter(s => s.kind === 'audio').map(s => { const p = scc.byStream(s.id).at(-1); return p ? p.hostTime + 1e6 : 0; }));
  // frames are kept until the next one arrives, so each gets its true duration (screen recordings are
  // variable frame rate: nothing is stored while nothing changes)
  let held = null, lastKey = -Infinity, made = 0, lastNote = 0;
  const send = (ts, dur) => {
    // VideoFrame copies the buffer, so the decoder can draw the next frame into it right after
    const vf = new VideoFrame(ranged(), { format: 'I420', codedWidth: vs.width, codedHeight: vs.height, visibleRect: { x: 0, y: 0, width: W, height: H }, displayWidth: W, displayHeight: H, timestamp: ts, duration: dur, colorSpace });
    const key = ts - lastKey >= 2e6;
    if (key) lastKey = ts;
    enc.encode(vf, { keyFrame: key });
    vf.close(); made++;
  };
  for (let i = 0; i < frames.length; i++) {
    check();
    const f = frames[i], ts = Math.max(0, f.hostTime - t0);
    // the frame on screen until now is finished: its length is known from this one's time
    // at most one encoded frame per frame of the project (fps): changes within one are folded into it
    const slot = v => Math.floor((v * fps) / 1e6);
    if (held !== null && ts > held && slot(ts) !== slot(held)) { send(held, ts - held); held = null; }
    await dec.frame(await scc.reader.read(f.offset, f.nbytes), inflate);
    if (held === null) held = ts;
    while (enc.encodeQueueSize > 2) await idle();
    if (encErr) throw encErr;
    drain();
    const now = Date.now();
    if (now - lastNote > 250) { lastNote = now; self.postMessage({ type: 'progress', value: i / frames.length, detail: `frame ${i + 1} of ${frames.length}` }); }
  }
  if (held !== null) send(held, Math.max(1e6 / 30, (audioEnd || held + 1e6 / 30) - t0 - held));
  await enc.flush(); enc.close();
  if (encErr) throw encErr;
  drain(); flush(true);
  if (!made) throw new Error('No frames came out of the recording');
  const cursor = scc.desktop.length ? cursorTrack(scc, vs, t0) : null;
  const head = mux.finish();
  self.postMessage({ type: 'done', head, cursor, width: W, height: H }, [head.buffer]);
}

async function audio(scc, { stream, mix }) {
  const as = scc.streams.find(s => s.id === stream && s.kind === 'audio');
  if (!as) throw new Error('That recording has no sound');
  const packets = scc.byStream(as.id), rate = Math.round(as.sampleRate || 44100), inCh = Math.max(1, as.codecFormat || 2), t0 = startOf(scc);
  // the project's channel mix (gain, pan, on/off per input) → stereo; without one, the channels as recorded
  const chans = Array.isArray(mix) && mix.length ? mix.slice(0, inCh) : null;
  const solo = chans && chans.some(c => c.solo);
  const gains = chans ? chans.map(c => (c.on && (!solo || c.solo) ? [c.gain * (c.pan > 0 ? 1 - c.pan : 1), c.gain * (c.pan < 0 ? 1 + c.pan : 1)] : [0, 0])) : null;
  const outCh = chans ? 2 : Math.min(2, inCh);
  self.postMessage({ type: 'format', ext: 'wav' });
  let frames = 0;
  const write = f32 => { frames += f32.length / outCh; self.postMessage({ type: 'chunk', data: new Uint8Array(f32.buffer) }, [f32.buffer]); }; // count before the buffer is handed over
  const silence = n => { for (let left = n; left > 0;) { const k = Math.min(left, rate); write(new Float32Array(k * outCh)); left -= k; } };
  for (let i = 0; i < packets.length; i++) {
    check();
    const p = packets[i];
    // place each one-second packet at its own time, so the sound stays in step with the picture
    const at = Math.round(((p.hostTime - t0) / 1e6) * rate);
    if (at > frames + rate / 100) silence(at - frames);
    const pcm = decodeAudioPacket(await scc.reader.read(p.offset, p.nbytes)), n = Math.floor(pcm.length / inCh);
    const out = new Float32Array(n * outCh);
    for (let k = 0; k < n; k++) {
      if (gains) {
        let l = 0, r = 0;
        for (let c = 0; c < gains.length; c++) { const s = pcm[k * inCh + c] / 32768; l += s * gains[c][0]; r += s * gains[c][1]; }
        out[k * 2] = l; out[k * 2 + 1] = r;
      } else for (let c = 0; c < outCh; c++) out[k * outCh + c] = pcm[k * inCh + c] / 32768;
    }
    write(out);
    self.postMessage({ type: 'progress', value: i / packets.length, detail: `${i + 1} of ${packets.length} s` });
    await idle();
  }
  const dataBytes = frames * outCh * 4, h = new DataView(new ArrayBuffer(44));
  const str = (o, t) => { for (let i = 0; i < t.length; i++) h.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); h.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE'); str(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 3, true);
  h.setUint16(22, outCh, true); h.setUint32(24, rate, true); h.setUint32(28, rate * outCh * 4, true); h.setUint16(32, outCh * 4, true); h.setUint16(34, 32, true);
  str(36, 'data'); h.setUint32(40, dataBytes, true);
  const head = new Uint8Array(h.buffer);
  self.postMessage({ type: 'done', head }, [head.buffer]);
}
