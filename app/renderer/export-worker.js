// Export engine (module Web Worker): decodes every source with WebCodecs, draws each output frame
// with the same compositor as the preview, encodes H.264/HEVC + AAC with Apple's hardware
// encoders (through Chromium), and muxes an MP4. Bytes are streamed to the main thread.
import { Muxer } from './lib/mp4.js';
import { openVideo, openAudio } from './lib/sources.js';
import { drawFrame } from './compositor.js';
import { FxChain } from './lib/trackfx.js';
import { mediaById, sourceTime, duration as docDuration, gainAt, panAt, panGains, clipEnd, activeClips, spanStart, spanEnd } from './model.js';
import { cursorAt, clicksBetween } from './cursor.js';
import { clickSample } from './lib/click.js';
import { GlFx, parseCube } from './lib/glfx.js';
import { MasterChain, LoudnessMeter, TruePeakLimiter } from './lib/master.js';
import { HttpReader, WavAudio } from './lib/sources.js';
import { GifEncoder, ApngEncoder } from './lib/anim.js';
import { stretch } from './lib/stretch.js';

let cancelled = false;
const RATE = 48000, BLOCK = 1024;

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

const urlFor = (token, file) => `app://reel/m/${token}/${encodeURIComponent(file)}`;

async function pickVideoCodec(kind, width, height, fps, bitrate, hardware = true) {
  const tries = kind === 'hevc'
    ? [{ codec: 'hvc1.1.6.L153.B0', hevc: { format: 'hevc' } }, { codec: 'hvc1.1.6.L150.90', hevc: { format: 'hevc' } }, { codec: 'hvc1.1.6.L123.90', hevc: { format: 'hevc' } }]
    : [];
  tries.push({ codec: width * height > 1920 * 1088 ? 'avc1.640033' : 'avc1.640028', avc: { format: 'avc' } }, { codec: 'avc1.4d0028', avc: { format: 'avc' } });
  for (const t of tries) {
    const cfg = { ...t, width, height, bitrate, framerate: fps, hardwareAcceleration: hardware ? 'prefer-hardware' : 'prefer-software', bitrateMode: 'variable', latencyMode: 'quality' };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch { /* try next */ }
  }
  throw new Error('No video encoder is available for this size. Try a smaller resolution.');
}

async function run({ doc, token, opts }) {
  cancelled = false;
  const fps = opts.fps || doc.canvas.fps || 30;
  const W = opts.width, H = opts.height;
  const start = Math.max(0, opts.from || 0);
  const end = Math.min(docDuration(doc), opts.to || Infinity);
  if (!(end > start)) throw new Error('Nothing to export: the timeline is empty');
  const frames = Math.max(1, Math.round((end - start) * fps));
  const withVideo = opts.kind !== 'm4a' && opts.mode !== 'mix';
  const anim = opts.kind === 'gif' || opts.kind === 'apng'; // silent animated picture: no sound, no MP4

  // ---------------- sources
  const used = doc.clips.filter(c => c.type === 'media' && !c.disabled && spanStart(c) < end && spanEnd(c) > start);
  const video = new Map(), images = new Map(), audio = new Map(), cursors = new Map(), mattes = new Map(), luts = new Map();
  for (const c of used) {
    const m = mediaById(doc, c.media);
    if (!m) continue;
    if (withVideo && m.kind === 'video' && !c.audioOnly) video.set(c.id, await openVideo(urlFor(token, m.file)));
    if (withVideo && m.kind === 'image' && !images.has(m.id)) images.set(m.id, await createImageBitmap(await (await fetch(urlFor(token, m.file))).blob()));
    if (!anim && (m.hasAudio || m.kind === 'audio') && !(c.audio && c.audio.mute) && !opts.masterFile) {
      // rendered effects (voice tools, plug-ins) replace the clip's original sound
      const file = c.fx && c.fx.file && !c.fx.bypass ? c.fx.file : m.file;
      try { const a = await openAudio(urlFor(token, file), file); if (a) audio.set(c.id, a); } catch (err) { self.postMessage({ type: 'warn', message: `${m.name}: ${err.message}` }); }
    }
    if (withVideo && c.matte && c.matte.file && !c.matte.off) {
      try { mattes.set(c.id, await openVideo(urlFor(token, c.matte.file))); } catch (err) { self.postMessage({ type: 'warn', message: `${m.name}: background removal skipped (${err.message})` }); }
    }
    if (withVideo) for (const f of c.filters || []) if (f.type === 'lut' && f.file && !luts.has(f.file)) {
      try { luts.set(f.file, parseCube(await (await fetch(urlFor(token, f.file))).text())); } catch { luts.set(f.file, null); }
    }
    if (m.cursor && (c.cursor || c.keystrokes?.show || m.pointerSeparate) && !cursors.has(m.id)) {
      try { cursors.set(m.id, await (await fetch(urlFor(token, m.cursor))).json()); } catch { /* no cursor fx */ }
    }
  }

  // ---------------- encoders + muxer
  let vcfg = null;
  const vTrack = withVideo ? { codec: '', width: W, height: H, description: null } : null;
  const aTrack = anim ? null : audio.size || !withVideo || opts.masterFile || used.some(c => c.cursor?.clickSound > 0) ? { codec: 'mp4a.40.2', sampleRate: RATE, channels: 2, description: null, bitrate: opts.audioBitrate || 192000 } : null;
  const mux = new Muxer({ video: vTrack, audio: aTrack });
  let pending = [], pendingBytes = 0, written = 0;
  const flush = (force) => {
    if (!pending.length || (!force && pendingBytes < (4 << 20))) return;
    const out = new Uint8Array(pendingBytes);
    let o = 0;
    for (const p of pending) { out.set(p, o); o += p.length; }
    pending = []; pendingBytes = 0; written += out.length;
    self.postMessage({ type: 'chunk', data: out }, [out.buffer]);
  };
  const emit = bytes => { pending.push(bytes); pendingBytes += bytes.length; flush(false); };
  let encErr = null;

  let venc = null;
  if (withVideo && !anim) {
    vcfg = await pickVideoCodec(opts.codec, W, H, fps, opts.bitrate || Math.round(W * H * fps * 0.12), opts.hardware !== false);
    vTrack.codec = vcfg.codec;
    venc = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta && meta.decoderConfig && meta.decoderConfig.description && !vTrack.description) vTrack.description = new Uint8Array(meta.decoderConfig.description);
        const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
        emit(mux.addVideo(data, { timestamp: chunk.timestamp, duration: chunk.duration || 1e6 / fps, key: chunk.type === 'key' }));
      },
      error: e => { encErr = e; },
    });
    venc.configure(vcfg);
  }
  let aenc = null;
  if (aTrack) {
    aenc = new AudioEncoder({
      output: (chunk, meta) => {
        if (meta && meta.decoderConfig && meta.decoderConfig.description && !aTrack.description) aTrack.description = new Uint8Array(meta.decoderConfig.description);
        const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
        emit(mux.addAudio(data, { timestamp: chunk.timestamp, duration: chunk.duration, key: true }));
      },
      error: e => { encErr = e; },
    });
    aenc.configure({ codec: 'mp4a.40.2', sampleRate: RATE, numberOfChannels: 2, bitrate: aTrack.bitrate });
  }

  // ---------------- audio: mix the clips (or read the mastered mix)
  const audioClips = used.filter(c => audio.has(c.id));
  const CLICK = clickSample(RATE);
  const clickClips = used.filter(c => c.cursor?.clickSound > 0 && !c.audio?.mute && cursors.has(mediaById(doc, c.media)?.id));
  /** Mixes clip audio for [t0, t0 + n/RATE) into stereo buffers. */
  // sped-up / slowed clips that keep their pitch: the clip's sound stretched once (WSOLA), at the output rate
  const stretched = new Map();
  // the stretched sound of a clip is held in memory: up to 10 minutes of it on 8 GB Macs, 20 with more
  const keepsPitch = c => (c.speed || 1) !== 1 && c.audio?.keepPitch !== false && c.duration <= (opts.stretchMax || 600);
  const stretchedOf = async (c, src) => {
    if (stretched.has(c.id)) return stretched.get(c.id);
    const speed = c.speed || 1, srcLen = c.duration * speed, a0 = Math.floor((c.in || 0) * src.rate), n = Math.ceil(srcLen * src.rate) + 4;
    const pcm = await src.read(a0, n), outN = Math.ceil(srcLen * RATE), ratio = src.rate / RATE;
    const res = pcm.slice(0, 2).map(ch => { const o = new Float32Array(outN); for (let i = 0; i < outN; i++) { const p = i * ratio, k = Math.floor(p), f = p - k; o[i] = (ch[k] ?? 0) * (1 - f) + (ch[k + 1] ?? ch[k] ?? 0) * f; } return o; });
    const out = stretch(res, speed, RATE);
    const v = { L: out[0], R: out[1] || out[0] };
    stretched.set(c.id, v);
    return v;
  };
  // tracks with effects (EQ, compressor, reverb…) are mixed on their own, run through the same effect code
  // the preview plays, then added to the mix; their tails carry on after the clips end
  const chains = new Map();
  for (const tr of doc.tracks) if ((tr.fx || []).some(f => !f.off)) chains.set(tr.id, new FxChain(RATE).setup(tr.fx));
  const mixChain = (doc.mixFx || []).some(f => !f.off) ? new FxChain(RATE).setup(doc.mixFx) : null;
  const mixBlock = async (t0, n) => {
    const L = new Float32Array(n), R = new Float32Array(n);
    const t1 = t0 + n / RATE;
    const tb = new Map();
    const bufFor = c => { if (!chains.has(c.track)) return [L, R]; let b = tb.get(c.track); if (!b) { b = [new Float32Array(n), new Float32Array(n)]; tb.set(c.track, b); } return b; };
    for (const c of audioClips) {
      if (spanEnd(c) <= t0 || spanStart(c) >= t1) continue;
      const src = audio.get(c.id);
      const cs = spanStart(c), ce = spanEnd(c); // crossfade handles play past the clip's edges
      const [TL, TR] = bufFor(c);
      const speed = c.speed || 1;
      if (keepsPitch(c)) {
        const st = await stretchedOf(c, src);
        const firstOut = Math.max(0, Math.ceil((cs - t0) * RATE)), lastOut = Math.min(n, Math.floor((ce - t0) * RATE));
        let g = 0, pg = [1, 1];
        for (let i = firstOut; i < lastOut; i++) {
          const lt = t0 + i / RATE - c.start, idx = Math.round(lt * RATE);
          if ((i - firstOut) % 256 === 0) { g = gainAt(doc, c, lt); pg = panGains(panAt(doc, c, lt)); } // gain and pan every 256 samples
          TL[i] += (st.L[idx] ?? 0) * g * pg[0]; TR[i] += (st.R[idx] ?? 0) * g * pg[1];
        }
        continue;
      }
      const s0 = Math.max(0, sourceTime(c, Math.max(t0, cs))), firstOut = Math.max(0, Math.ceil((cs - t0) * RATE));
      const lastOut = Math.min(n, Math.floor((ce - t0) * RATE));
      if (lastOut <= firstOut) continue;
      const ratio = (src.rate / RATE) * speed;
      const nativeStart = Math.floor(s0 * src.rate) - 2;
      const need = Math.ceil((lastOut - firstOut) * ratio) + 6;
      const pcm = await src.read(nativeStart, need);
      // gain and pan (volume, fades, keyframes, track automation) sampled every 256 samples
      const S = 256, segs = Math.ceil((lastOut - firstOut) / S) + 1;
      const GL = new Float32Array(segs + 1), GR = new Float32Array(segs + 1);
      for (let j = 0; j <= segs; j++) {
        const lt = t0 + Math.min(lastOut, firstOut + j * S) / RATE - c.start;
        const g = gainAt(doc, c, lt), [pl, pr] = panGains(panAt(doc, c, lt));
        GL[j] = g * pl; GR[j] = g * pr;
      }
      const stereo = pcm.length > 1;
      const base = s0 * src.rate - nativeStart;
      const a = pcm[0], b = stereo ? pcm[1] : pcm[0];
      for (let i = firstOut; i < lastOut; i++) {
        const pos = base + (i - firstOut) * ratio, k = Math.floor(pos), f = pos - k;
        const q = (i - firstOut) / S, j = q | 0, u = q - j;
        const gl = GL[j] + (GL[j + 1] - GL[j]) * u, gr = GR[j] + (GR[j + 1] - GR[j]) * u;
        // Catmull-Rom interpolation between native samples
        const p0 = a[k - 1] ?? a[k] ?? 0, p1 = a[k] ?? 0, p2 = a[k + 1] ?? p1, p3 = a[k + 2] ?? p2;
        const l = p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
        let r = l;
        if (stereo) { const q0 = b[k - 1] ?? b[k] ?? 0, q1 = b[k] ?? 0, q2 = b[k + 1] ?? q1, q3 = b[k + 2] ?? q2; r = q1 + 0.5 * f * (q2 - q0 + f * (2 * q0 - 5 * q1 + 4 * q2 - q3 + f * (3 * (q1 - q2) + q3 - q0))); }
        TL[i] += l * gl; TR[i] += r * gr;
      }
    }
    for (const [id, ch] of chains) {
      const [a, b] = tb.get(id) || [new Float32Array(n), new Float32Array(n)];
      for (let p = 0; p < n; p += 512) ch.process(a.subarray(p, Math.min(n, p + 512)), b.subarray(p, Math.min(n, p + 512)));
      for (let i = 0; i < n; i++) { L[i] += a[i]; R[i] += b[i]; }
    }
    // the mixer's mix bus fader
    if (doc.mixGain) { const g = 10 ** (doc.mixGain / 20); for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; } }
    // the mix bus's inserts (a limiter by default), as in the preview
    if (mixChain) for (let p = 0; p < n; p += 512) mixChain.process(L.subarray(p, Math.min(n, p + 512)), R.subarray(p, Math.min(n, p + 512)));
    // click sounds from the recorded clicks
    for (const c of clickClips) {
      if (clipEnd(c) <= t0 || c.start >= t1) continue;
      const m = mediaById(doc, c.media), data = cursors.get(m.id);
      const s0 = sourceTime(c, Math.max(t0 - 0.05, c.start)), s1 = sourceTime(c, Math.min(t1, clipEnd(c)));
      for (const st of clicksBetween(data, m.cursorOffset || 0, s0, s1)) {
        const at = Math.round((c.start + (st - (c.in || 0)) / (c.speed || 1) - t0) * RATE), g = c.cursor.clickSound;
        for (let i = Math.max(0, -at); i < CLICK.length && at + i < n; i++) { L[at + i] += CLICK[i] * g; R[at + i] += CLICK[i] * g; }
      }
    }
    return [L, R];
  };
  const softClip = (L, R) => {
    for (let i = 0; i < L.length; i++) {
      const l = L[i], r = R[i];
      L[i] = Math.abs(l) > 0.9 ? Math.sign(l) * (0.9 + 0.1 * Math.tanh((Math.abs(l) - 0.9) / 0.1)) : l;
      R[i] = Math.abs(r) > 0.9 ? Math.sign(r) * (0.9 + 0.1 * Math.tanh((Math.abs(r) - 0.9) / 0.1)) : r;
    }
  };

  // Mix-only pass (for mastering): mix + built-in master chain, streamed to the page as float PCM.
  if (opts.mode === 'mix') {
    const chain = opts.master && opts.master.on ? new MasterChain(opts.master, RATE) : null;
    const total = Math.round((end - start) * RATE);
    let pos = 0, out = [], outN = 0;
    while (pos < total) {
      if (cancelled) throw new Error('Cancelled');
      const n = Math.min(BLOCK * 8, total - pos);
      const [L, R] = await mixBlock(start + pos / RATE, n);
      if (chain) chain.process(L, R);
      const inter = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) { inter[i * 2] = L[i]; inter[i * 2 + 1] = R[i]; }
      out.push(inter); outN += inter.length;
      pos += n;
      if (outN >= RATE * 4 || pos >= total) {
        const buf = new Float32Array(outN); let o = 0;
        for (const x of out) { buf.set(x, o); o += x.length; }
        out = []; outN = 0;
        self.postMessage({ type: 'mix', data: new Uint8Array(buf.buffer), progress: pos / total }, [buf.buffer]);
      }
    }
    for (const a of audio.values()) a.close();
    return { head: new Uint8Array(0), bytes: 0, frames: 0, codec: 'mix' };
  }

  // The mastered mix, when there is one: measured for loudness, then gain + true-peak limiter.
  let master = null;
  if (opts.masterFile) {
    master = await new WavAudio(await new HttpReader(urlFor(token, opts.masterFile)).open()).open();
    let gain = 1;
    if (opts.loudness != null) {
      self.postMessage({ type: 'status', message: 'Measuring loudness…' });
      const meter = new LoudnessMeter(RATE);
      for (let p = 0; p < master.frames; p += RATE * 10) {
        const pcm = await master.read(p, Math.min(RATE * 10, master.frames - p));
        meter.push(pcm[0], pcm[pcm.length > 1 ? 1 : 0]);
      }
      const lufs = meter.integrated();
      if (Number.isFinite(lufs)) gain = Math.pow(10, Math.min(20, opts.loudness - lufs) / 20);
      self.postMessage({ type: 'loudness', measured: lufs, target: opts.loudness });
    }
    master.gain = gain;
    master.limiter = new TruePeakLimiter(opts.ceiling ?? -1, RATE);
  }

  let audioPos = 0; // output frames written
  const mixUntil = async (t) => {
    if (!aenc) return;
    const target = Math.floor((t - start) * RATE);
    while (audioPos + BLOCK <= target || (t >= end && audioPos < target)) {
      const n = BLOCK;
      let L, R;
      if (master) {
        const pcm = await master.read(audioPos, n);
        L = pcm[0]; R = pcm.length > 1 ? pcm[1] : Float32Array.from(pcm[0]);
        for (let i = 0; i < n; i++) { L[i] *= master.gain; R[i] *= master.gain; }
        master.limiter.process(L, R);
      } else {
        [L, R] = await mixBlock(start + audioPos / RATE, n);
        softClip(L, R);
      }
      const planar = new Float32Array(n * 2); planar.set(L, 0); planar.set(R, n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((audioPos / RATE) * 1e6), data: planar });
      aenc.encode(ad); ad.close();
      audioPos += n;
      while (aenc.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 1));
      if (encErr) throw encErr;
    }
  };

  // ---------------- video frames
  const canvas = withVideo ? new OffscreenCanvas(W, H) : null;
  const ctx = canvas ? canvas.getContext('2d', { alpha: false, willReadFrequently: anim }) : null;
  const animEnc = !anim ? null : opts.kind === 'gif' ? new GifEncoder(W, H, emit, { dither: opts.dither !== false, loop: opts.loop !== false }) : new ApngEncoder(W, H, emit, { loop: opts.loop !== false });
  if (ctx) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; }
  const current = new Map(); // clip id -> source for this frame
  const sources = {
    frame: (c) => current.get(c.id) || null,
    cursor: (c, st) => { const m = mediaById(doc, c.media); const data = m && cursors.get(m.id); return data ? cursorAt(data, m.cursorOffset || 0, st, c.cursor?.smooth || 0) : null; },
    input: c => { const m = mediaById(doc, c.media); return (m && cursors.get(m.id)) || null; },
    fx: () => { if (gl === undefined) { try { gl = new GlFx(); } catch (err) { gl = null; self.postMessage({ type: 'warn', message: `Filters skipped: ${err.message}` }); } } return gl; },
    lut: file => luts.get(file) || null,
    matte: c => currentMatte.get(c.id) || null,
  };
  let gl;
  const currentMatte = new Map();
  /** Loads every source frame showing at time t. */
  const gather = async t => {
    current.clear(); currentMatte.clear();
    for (const c of activeClips(doc, t)) {
      if (c.type !== 'media') continue;
      const m = mediaById(doc, c.media);
      if (!m) continue;
      const st = sourceTime(c, t);
      if (video.has(c.id)) {
        const f = await video.get(c.id).frameAt(st);
        if (f) current.set(c.id, { img: f, w: f.displayWidth, h: f.displayHeight, rot: m.rotation || 0 });
      } else if (images.has(m.id)) {
        const b = images.get(m.id);
        current.set(c.id, { img: b, w: b.width, h: b.height, rot: 0 });
      }
      if (mattes.has(c.id)) { const mf = await mattes.get(c.id).frameAt(st); if (mf) currentMatte.set(c.id, { img: mf }); }
    }
  };
  // motion blur: average a few moments across a half-frame shutter
  const mbSamples = opts.motionBlur ? Math.max(2, Math.min(8, opts.motionBlur | 0 || 4)) : 1;
  const sub = mbSamples > 1 ? new OffscreenCanvas(W, H) : null;
  const subCtx = sub ? sub.getContext('2d', { alpha: false }) : null;
  const keyEvery = Math.round(fps * 2);
  const t0 = performance.now();
  for (let i = 0; i < (withVideo ? frames : 0); i++) {
    if (cancelled) throw new Error('Cancelled');
    if (encErr) throw encErr;
    const t = start + i / fps;
    if (mbSamples === 1) { await gather(t); drawFrame(ctx, doc, t, sources); }
    else {
      for (let s = 0; s < mbSamples; s++) {
        const ts = Math.max(start, t + ((s / mbSamples) - 0.5) * 0.5 / fps);
        await gather(ts);
        drawFrame(subCtx, doc, ts, sources);
        ctx.globalAlpha = 1 / (s + 1); // running average of the samples
        ctx.drawImage(sub, 0, 0);
      }
      ctx.globalAlpha = 1;
    }
    if (animEnc) await animEnc.addFrame(ctx.getImageData(0, 0, W, H).data, 1 / fps);
    else {
      const vf = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      venc.encode(vf, { keyFrame: i % keyEvery === 0 });
      vf.close();
      while (venc.encodeQueueSize > 3) await new Promise(r => setTimeout(r, 1));
      await mixUntil(t + 1 / fps);
    }
    if (i % 10 === 0) {
      const el = (performance.now() - t0) / 1000;
      self.postMessage({ type: 'progress', done: i + 1, total: frames, fps: (i + 1) / Math.max(0.001, el) });
    }
  }
  await mixUntil(end);
  if (venc) await venc.flush();
  if (aenc) await aenc.flush();
  if (encErr) throw encErr;
  for (const v of video.values()) v && v.close();
  for (const v of mattes.values()) v && v.close();
  for (const a of audio.values()) a.close();
  if (master) master.close();
  for (const b of images.values()) b.close();
  if (animEnc) {
    const head = animEnc.finish();
    flush(true);
    return { head, bytes: written + head.length, frames, codec: opts.kind };
  }
  flush(true);
  if (vTrack && !vTrack.description) throw new Error('The video encoder produced no output');
  const head = mux.finish();
  return { head, bytes: written, frames, codec: vTrack ? vTrack.codec : 'aac' };
}
