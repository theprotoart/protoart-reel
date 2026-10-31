// Media readers for export: random-access file reading over the app's media URLs, frame-exact
// video decoding with WebCodecs, and audio decoding (WAV, AAC, PCM) to float samples.
import { demux, keyframeBefore, sampleTime } from './mp4.js';

/** Random-access reader over an app://reel/m/... URL using Range requests, with a block cache. */
export class HttpReader {
  constructor(url) { this.url = url; this.size = 0; this.blocks = new Map(); this.BLOCK = 1 << 20; }
  async open() {
    const r = await fetch(this.url, { headers: { Range: 'bytes=0-0' } });
    const cr = r.headers.get('Content-Range');
    const m = cr && /\/(\d+)$/.exec(cr);
    this.size = m ? Number(m[1]) : Number(r.headers.get('Content-Length') || 0);
    await r.arrayBuffer().catch(() => {});
    if (!this.size) throw new Error('Media file is empty or missing');
    return this;
  }
  async _block(i) {
    if (this.blocks.has(i)) { const b = this.blocks.get(i); this.blocks.delete(i); this.blocks.set(i, b); return b; }
    const start = i * this.BLOCK, end = Math.min(this.size, start + this.BLOCK) - 1;
    const r = await fetch(this.url, { headers: { Range: `bytes=${start}-${end}` } });
    if (!r.ok) throw new Error(`Couldn't read media (${r.status})`);
    const b = new Uint8Array(await r.arrayBuffer());
    this.blocks.set(i, b);
    if (this.blocks.size > 48) this.blocks.delete(this.blocks.keys().next().value);
    return b;
  }
  async read(offset, length) {
    length = Math.max(0, Math.min(length, this.size - offset));
    if (length > 4 * this.BLOCK) { // big reads go straight through
      const r = await fetch(this.url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
      return new Uint8Array(await r.arrayBuffer());
    }
    const out = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const pos = offset + done, i = Math.floor(pos / this.BLOCK), b = await this._block(i);
      const from = pos - i * this.BLOCK, n = Math.min(b.length - from, length - done);
      if (n <= 0) break;
      out.set(b.subarray(from, from + n), done);
      done += n;
    }
    return out;
  }
}

// ------------------------------------------------------------------ video

/** Decodes a video track and hands out the frame showing at any (mostly increasing) time. */
export class VideoSource {
  constructor(reader, track) {
    this.reader = reader; this.track = track; this.frames = []; this.next = 0; this.ended = true;
    this.decoder = null; this.wake = null; this.error = null; this.lastT = null;
  }
  static async supported(track) {
    if (!track.codec) return false;
    try {
      const r = await VideoDecoder.isConfigSupported({ codec: track.codec, description: track.description, codedWidth: track.width, codedHeight: track.height });
      return !!r.supported;
    } catch { return false; }
  }
  _make() {
    if (this.decoder && this.decoder.state !== 'closed') try { this.decoder.close(); } catch { /* closed */ }
    this.decoder = new VideoDecoder({
      output: f => { this.frames.push(f); this._poke(); },
      error: e => { this.error = e; this._poke(); },
    });
    this.decoder.configure({ codec: this.track.codec, description: this.track.description, codedWidth: this.track.width, codedHeight: this.track.height, hardwareAcceleration: 'prefer-hardware' });
  }
  _poke() { const w = this.wake; this.wake = null; if (w) w(); }
  _wait() { return new Promise(r => { this.wake = r; setTimeout(r, 2000); }); }
  _clear() { for (const f of this.frames) f.close(); this.frames = []; }
  async _seek(t) {
    this._clear();
    this._make();
    this.next = keyframeBefore(this.track, t);
    this.ended = false; this.flushed = false;
  }
  /** VideoFrame showing at file time t (seconds). Valid until the next call. */
  async frameAt(t) {
    const eps = 0.5 / 120;
    if (this.lastT === null || t < this.lastT - eps || (this.frames.length && t > this.frames[this.frames.length - 1].timestamp / 1e6 + 2.5 && this._keyBetween(t))) await this._seek(t);
    this.lastT = t;
    const s = this.track.samples;
    for (let guard = 0; guard < 100000; guard++) {
      if (this.error) throw new Error(`Video decoding failed: ${this.error.message || this.error}`);
      while (this.frames.length >= 2 && this.frames[1].timestamp / 1e6 <= t + eps) this.frames.shift().close();
      const last = this.frames[this.frames.length - 1];
      if (last && (last.timestamp / 1e6 > t + eps || this.ended)) return this.frames[0];
      if (this.ended && !last) return null;
      if (this.next >= s.length) {
        if (!this.flushed) { this.flushed = true; await this.decoder.flush().catch(() => {}); }
        this.ended = true;
        continue;
      }
      // keep the decoder fed but don't let frames pile up (hardware decoders have small pools)
      let fed = 0;
      while (this.next < s.length && this.decoder.decodeQueueSize < 6 && this.frames.length < 6 && fed < 12) {
        const smp = s[this.next++];
        const data = await this.reader.read(smp.offset, smp.size);
        this.decoder.decode(new EncodedVideoChunk({ type: smp.sync ? 'key' : 'delta', timestamp: Math.round(sampleTime(this.track, smp) * 1e6), duration: Math.round((smp.duration / this.track.timescale) * 1e6), data }));
        fed++;
      }
      if (!fed || this.decoder.decodeQueueSize > 0) await this._wait();
    }
    throw new Error('Video decoding stalled');
  }
  _keyBetween(t) {
    const k = keyframeBefore(this.track, t);
    return k > this.next;
  }
  close() { this._clear(); if (this.decoder && this.decoder.state !== 'closed') try { this.decoder.close(); } catch { /* closed */ } }
}

// ------------------------------------------------------------------ audio

/** Parses a WAV header; returns { format, channels, rate, bits, dataOffset, dataLength }. */
export function wavInfo(b, size) {
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  const tag = o => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let p = 12, fmt = null;
  while (p + 8 <= b.length) {
    const id = tag(p), len = dv.getUint32(p + 4, true);
    if (id === 'fmt ') {
      let format = dv.getUint16(p + 8, true);
      if (format === 0xfffe && len >= 26) format = dv.getUint16(p + 32, true);
      fmt = { format, channels: dv.getUint16(p + 10, true), rate: dv.getUint32(p + 12, true), bits: dv.getUint16(p + 22, true) };
    }
    if (id === 'data') {
      if (!fmt) throw new Error('Unreadable WAV');
      return { ...fmt, dataOffset: p + 8, dataLength: Math.min(len || size, size - p - 8) };
    }
    p += 8 + len + (len & 1);
  }
  throw new Error('Unreadable WAV');
}

/** Like wavInfo, but walks the chunks on disk, for files whose sound starts far in (big bext / iXML / JUNK). */
async function wavInfoFar(reader) {
  let p = 12, fmt = null;
  for (let guard = 0; guard < 4096 && p + 8 <= reader.size; guard++) {
    const h = await reader.read(p, 8), dv = new DataView(h.buffer, h.byteOffset, h.length);
    const id = String.fromCharCode(h[0], h[1], h[2], h[3]), len = dv.getUint32(4, true);
    if (id === 'fmt ') {
      const f = await reader.read(p + 8, Math.min(len, 40)), fv = new DataView(f.buffer, f.byteOffset, f.length);
      let format = fv.getUint16(0, true);
      if (format === 0xfffe && f.length >= 26) format = fv.getUint16(24, true);
      fmt = { format, channels: fv.getUint16(2, true), rate: fv.getUint32(4, true), bits: fv.getUint16(14, true) };
    }
    if (id === 'data') return fmt ? { ...fmt, dataOffset: p + 8, dataLength: Math.min(len || reader.size, reader.size - p - 8) } : null;
    p += 8 + len + (len & 1);
  }
  return null;
}

/** Sequential-ish PCM access: read(startFrame, count) -> [Float32Array per channel] at native rate. */
export class WavAudio {
  constructor(reader) { this.reader = reader; }
  async open() {
    try { this.info = wavInfo(await this.reader.read(0, Math.min(this.reader.size, 65536)), this.reader.size); }
    catch (e) { this.info = await wavInfoFar(this.reader); if (!this.info) throw e; } // sound starts past 64 KB
    const { format, bits } = this.info;
    if (!((format === 1 && [16, 24, 32].includes(bits)) || (format === 3 && bits === 32))) throw new Error('Unsupported WAV encoding');
    this.rate = this.info.rate; this.channels = this.info.channels;
    this.frameBytes = this.channels * bits / 8;
    this.frames = Math.floor(this.info.dataLength / this.frameBytes);
    return this;
  }
  async read(start, count) {
    const out = Array.from({ length: this.channels }, () => new Float32Array(count));
    const s0 = Math.max(0, start), s1 = Math.min(this.frames, start + count);
    if (s1 <= s0) return out;
    const b = await this.reader.read(this.info.dataOffset + s0 * this.frameBytes, (s1 - s0) * this.frameBytes);
    const dv = new DataView(b.buffer, b.byteOffset, b.length);
    const { format, bits } = this.info, ch = this.channels, bps = bits / 8;
    for (let i = 0; i < s1 - s0; i++) {
      for (let c = 0; c < ch; c++) {
        const o = (i * ch + c) * bps;
        let v;
        if (format === 3) v = dv.getFloat32(o, true);
        else if (bits === 16) v = dv.getInt16(o, true) / 32768;
        else if (bits === 24) v = ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) << 8 >> 8) / 8388608;
        else v = dv.getInt32(o, true) / 2147483648;
        out[c][i + s0 - start] = v;
      }
    }
    return out;
  }
  close() {}
}

/** AAC (or PCM) audio track inside an MP4/MOV, decoded on demand. */
export class Mp4Audio {
  constructor(reader, track) { this.reader = reader; this.track = track; this.rate = track.sampleRate; this.channels = Math.min(2, track.channels || 2); this.blocks = []; this.next = 0; this.decoder = null; }
  async open() {
    if (this.track.codec === 'pcm') return this;
    const cfg = { codec: this.track.codec, sampleRate: this.track.sampleRate, numberOfChannels: this.track.channels, description: this.track.description };
    const ok = await AudioDecoder.isConfigSupported(cfg).then(r => r.supported).catch(() => false);
    if (!ok) throw new Error(`Audio codec ${this.track.codec} can't be decoded`);
    this.cfg = cfg;
    return this;
  }
  _make() {
    if (this.decoder && this.decoder.state !== 'closed') try { this.decoder.close(); } catch { /* closed */ }
    this.decoder = new AudioDecoder({
      output: d => {
        const n = d.numberOfFrames, chs = [];
        for (let c = 0; c < this.channels; c++) {
          const a = new Float32Array(n);
          d.copyTo(a, { planeIndex: Math.min(c, d.numberOfChannels - 1), format: 'f32-planar' });
          chs.push(a);
        }
        this.blocks.push({ start: Math.round((d.timestamp / 1e6) * this.rate), chs });
        d.close();
      },
      error: e => { this.error = e; },
    });
    this.decoder.configure(this.cfg);
  }
  _sampleIndexFor(frame) {
    const s = this.track.samples, t = frame / this.rate;
    let i = 0;
    while (i + 1 < s.length && sampleTime(this.track, s[i + 1]) <= t) i++;
    return Math.max(0, i - 2); // a little pre-roll for the decoder
  }
  async read(start, count) {
    const out = Array.from({ length: this.channels }, () => new Float32Array(count));
    if (this.track.codec === 'pcm') return this._readPcm(start, count, out);
    const end = start + count;
    const have = () => this.blocks.length && this.blocks[0].start <= start && this.blocks[this.blocks.length - 1].start + this.blocks[this.blocks.length - 1].chs[0].length >= end;
    if (!this.decoder || (this.blocks.length && this.blocks[0].start > start) || (!this.blocks.length && this.next > 0 && this._sampleIndexFor(start) < this.next - 3)) {
      this.blocks = []; this._make(); this.next = this._sampleIndexFor(start);
    }
    const s = this.track.samples;
    while (!have() && this.next < s.length) {
      for (let k = 0; k < 16 && this.next < s.length; k++) {
        const smp = s[this.next++];
        const data = await this.reader.read(smp.offset, smp.size);
        this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(sampleTime(this.track, smp) * 1e6), duration: Math.round((smp.duration / this.track.timescale) * 1e6), data }));
      }
      await this.decoder.flush().catch(() => {});
      if (this.error) throw new Error(`Audio decoding failed: ${this.error.message || this.error}`);
    }
    for (const b of this.blocks) {
      const n = b.chs[0].length;
      const from = Math.max(start, b.start), to = Math.min(end, b.start + n);
      for (let f = from; f < to; f++) for (let c = 0; c < this.channels; c++) out[c][f - start] = b.chs[c][f - b.start];
    }
    // drop blocks that are fully behind us
    while (this.blocks.length > 1 && this.blocks[0].start + this.blocks[0].chs[0].length < start - this.rate) this.blocks.shift();
    return out;
  }
  async _readPcm(start, count, out) {
    // uncompressed audio in a MOV: samples are single frames
    const t = this.track, s = t.samples, bits = t.pcm.bits, ch = t.channels, bps = bits / 8;
    const little = t.pcm.fourcc === 'sowt' || t.pcm.fourcc === 'lpcm';
    const float = t.pcm.fourcc === 'fl32' || t.pcm.fourcc === 'fpcm';
    const from = Math.max(0, start), to = Math.min(s.length, start + count);
    if (to <= from) return out;
    // samples are contiguous within chunks; read the span and walk it
    const first = s[from], last = s[to - 1];
    const span = await this.reader.read(first.offset, last.offset + last.size - first.offset);
    const dv = new DataView(span.buffer, span.byteOffset, span.length);
    for (let i = from; i < to; i++) {
      const o0 = s[i].offset - first.offset;
      for (let c = 0; c < Math.min(ch, 2); c++) {
        const o = o0 + c * bps;
        let v = 0;
        if (float) v = dv.getFloat32(o, little);
        else if (bits === 16) v = dv.getInt16(o, little) / 32768;
        else if (bits === 24) { const raw = little ? (span[o] | (span[o + 1] << 8) | (span[o + 2] << 16)) : ((span[o] << 16) | (span[o + 1] << 8) | span[o + 2]); v = ((raw << 8) >> 8) / 8388608; }
        else if (bits === 32) v = dv.getInt32(o, little) / 2147483648;
        else if (bits === 8) v = (span[o] - 128) / 128;
        out[c][i - start] = v;
      }
    }
    return out;
  }
  close() { if (this.decoder && this.decoder.state !== 'closed') try { this.decoder.close(); } catch { /* closed */ } }
}

/** Opens whatever audio a media file has: WAV, or the first audio track of an MP4/MOV. */
export async function openAudio(url, file) {
  const reader = await new HttpReader(url).open();
  if (/\.wav$/i.test(file)) return new WavAudio(reader).open();
  const d = await demux(reader);
  const a = d.tracks.find(t => t.kind === 'audio' && t.codec);
  if (!a) return null;
  return new Mp4Audio(reader, a).open();
}

export async function openVideo(url) {
  const reader = await new HttpReader(url).open();
  const d = await demux(reader);
  const v = d.tracks.find(t => t.kind === 'video');
  if (!v) return null;
  if (!(await VideoSource.supported(v))) throw new Error(`This video's format (${v.codec || v.fourcc}) can't be decoded for export. Convert it to H.264 or HEVC first (ProtoArt Press can do that).`);
  return new VideoSource(reader, v);
}
