// Proxy maker: runs the real worker against an MP4 (picture + AAC sound) served over HTTP, with
// stand-in WebCodecs/OffscreenCanvas classes. Every frame comes out once, in order, at the smaller
// size, and the sound packets are copied across byte for byte.
import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { Muxer, demux, BufferReader } from '../app/renderer/lib/mp4.js';

const AVCC = Uint8Array.from([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80]);
const ASC = Uint8Array.from([0x11, 0x90]); // AAC-LC 48 kHz stereo

function buildFile(frames, fps, w, h, audioPackets) {
  const m = new Muxer({ video: { codec: 'avc1.640028', width: w, height: h, description: AVCC }, audio: { codec: 'mp4a.40.2', sampleRate: 48000, channels: 2, description: ASC } });
  const parts = [];
  for (let f = 0; f < frames; f++) {
    const data = new Uint8Array(8); new DataView(data.buffer).setUint32(0, f);
    parts.push(m.addVideo(data, { timestamp: (f * 1e6) / fps, duration: 1e6 / fps, key: f % 30 === 0 }));
  }
  for (let i = 0; i < audioPackets; i++) {
    const data = new Uint8Array(6); new DataView(data.buffer).setUint32(0, 0xa0000 + i);
    parts.push(m.addAudio(data, { timestamp: (i * 1024 * 1e6) / 48000, duration: (1024 * 1e6) / 48000, key: true }));
  }
  const head = m.finish();
  const out = new Uint8Array(head.length + parts.reduce((n, p) => n + p.length, 0));
  out.set(head, 0); let o = head.length; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function installFakes(log) {
  globalThis.self = globalThis;
  globalThis.EncodedVideoChunk = class { constructor(o) { Object.assign(this, o); } };
  globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; const c = this; this.ctx = { drawImage(f, x, y, dw, dh) { c.last = f.id; log.size = [dw, dh]; } }; } getContext() { return this.ctx; } };
  globalThis.VideoDecoder = class {
    static async isConfigSupported() { return { supported: true }; }
    constructor({ output }) { this.output = output; this.decodeQueueSize = 0; }
    configure(cfg) { log.decCfg = cfg; }
    decode(chunk) { const id = new DataView(chunk.data.buffer, chunk.data.byteOffset).getUint32(0); this.output({ id, timestamp: chunk.timestamp, duration: chunk.duration, close() {} }); }
    async flush() {}
    close() {}
  };
  globalThis.VideoFrame = class { constructor(canvas, o) { this.id = canvas.last; Object.assign(this, o); } close() {} };
  globalThis.VideoEncoder = class {
    static async isConfigSupported() { return { supported: true }; }
    constructor({ output }) { this.output = output; this.encodeQueueSize = 0; }
    configure(cfg) { log.encCfg = cfg; }
    encode(f) {
      log.out.push(f.id);
      this.output({ byteLength: 4, timestamp: f.timestamp, duration: f.duration, type: 'key', copyTo: d => new DataView(d.buffer).setUint32(0, f.id) }, { decoderConfig: { description: AVCC } });
    }
    async flush() {}
    close() {}
  };
}

test('Proxy: every frame once, in order, at half size; sound copied untouched', async () => {
  const fps = 30, frames = 90, packets = Math.ceil((3 * 48000) / 1024);
  const file = buildFile(frames, fps, 3840, 2160, packets);
  const log = { out: [] };
  installFakes(log);
  const srv = http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d+)?/.exec(req.headers.range || '');
    const a = m ? Number(m[1]) : 0, b = m && m[2] ? Math.min(Number(m[2]), file.length - 1) : file.length - 1;
    res.writeHead(m ? 206 : 200, { 'Content-Range': `bytes ${a}-${b}/${file.length}`, 'Content-Length': b - a + 1 });
    res.end(Buffer.from(file.subarray(a, b + 1)));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const chunks = [];
  const result = await new Promise((resolve, reject) => {
    globalThis.postMessage = msg => { if (msg.type === 'chunk') chunks.push(msg.data); if (msg.type === 'done') resolve(msg); if (msg.type === 'error') reject(new Error(msg.message)); };
    import('../app/renderer/proxy-worker.js?' + Math.random()).then(() => self.onmessage({ data: { type: 'start', url: `http://127.0.0.1:${srv.address().port}/x.mp4`, divisor: 2 } }));
  });
  srv.close();
  assert.deepStrictEqual(log.out, [...Array(frames).keys()]);
  assert.deepStrictEqual(log.size, [1920, 1080]);
  assert.strictEqual(result.width, 1920); assert.strictEqual(result.height, 1080);
  const body = chunks.reduce((n, c) => n + c.length, 0), all = new Uint8Array(result.head.length + body);
  all.set(result.head, 0); let o = result.head.length; for (const c of chunks) { all.set(c, o); o += c.length; }
  const d = await demux(new BufferReader(all));
  const v = d.tracks.find(t => t.kind === 'video'), a = d.tracks.find(t => t.kind === 'audio');
  assert.strictEqual(v.samples.length, frames); assert.strictEqual(v.width, 1920);
  assert.strictEqual(a.samples.length, packets); assert.strictEqual(a.codec, 'mp4a.40.2');
  for (let i = 0; i < packets; i += 37) {
    const s = a.samples[i];
    assert.strictEqual(new DataView(all.buffer, s.offset).getUint32(0), 0xa0000 + i, 'sound packet copied');
  }
  // interleaved: some sound lands before the last picture frame, not all at the end
  assert.ok(a.samples[0].offset < v.samples[v.samples.length - 1].offset);
});
