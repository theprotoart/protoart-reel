// Play in Reverse: runs the real worker against an MP4 served over HTTP, with stand-in WebCodecs
// classes that tag every frame, and checks frames come out back to front with the right timing.
import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { Muxer, demux, BufferReader } from '../app/renderer/lib/mp4.js';

const AVCC = Uint8Array.from([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80]);

function buildFile(frames, fps, gop, bframes, width = 64, height = 36) {
  const m = new Muxer({ video: { codec: 'avc1.640028', width, height, description: AVCC }, audio: null });
  // decode order with B-frames: I P B B P B B … (presentation index f)
  const order = [];
  if (bframes) { order.push(0); for (let b = 1; b < frames; b += 3) { if (b + 2 < frames) order.push(b + 2, b, b + 1); else for (let k = b; k < frames; k++) order.push(k); } }
  else for (let f = 0; f < frames; f++) order.push(f);
  const parts = order.map(f => {
    const data = new Uint8Array(8); new DataView(data.buffer).setUint32(0, f);
    return m.addVideo(data, { timestamp: (f * 1e6) / fps, duration: 1e6 / fps, key: f % gop === 0 && order.indexOf(f) >= 0 && f % gop === 0 });
  });
  const head = m.finish();
  const out = new Uint8Array(head.length + parts.reduce((n, p) => n + p.length, 0));
  out.set(head, 0); let o = head.length; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function installFakes(log) {
  globalThis.self = globalThis;
  globalThis.EncodedVideoChunk = class { constructor(o) { Object.assign(this, o); } };
  globalThis.VideoDecoder = class {
    constructor({ output }) { this.output = output; this.queue = []; this.decodeQueueSize = 0; }
    configure() {}
    decode(chunk) {
      const id = new DataView(chunk.data.buffer, chunk.data.byteOffset).getUint32(0);
      this.queue.push({ ts: chunk.timestamp, id });
      this.queue.sort((a, b) => a.ts - b.ts);
      while (this.queue.length > 3) this._out(this.queue.shift()); // reorder depth like a real decoder
    }
    _out({ ts, id }) {
      log.decoded++;
      this.output({ timestamp: ts, format: 'I420', codedWidth: 64, codedHeight: 36, displayWidth: 64, displayHeight: 36, visibleRect: null,
        allocationSize: () => 4, copyTo: async buf => { new DataView(buf.buffer).setUint32(0, id); return []; }, close() {} });
    }
    async flush() { while (this.queue.length) this._out(this.queue.shift()); }
    close() {}
  };
  globalThis.VideoFrame = class { constructor(buf, o) { this.id = new DataView(buf.buffer).getUint32(0); Object.assign(this, o); } close() {} };
  globalThis.VideoEncoder = class {
    static async isConfigSupported() { return { supported: true }; }
    constructor({ output }) { this.output = output; this.encodeQueueSize = 0; }
    configure() {}
    encode(f) {
      log.out.push({ id: f.id, ts: f.timestamp });
      this.output({ byteLength: 4, timestamp: f.timestamp, duration: f.duration, type: 'key', copyTo: d => new DataView(d.buffer).setUint32(0, f.id) }, { decoderConfig: { description: AVCC } });
    }
    async flush() {}
  };
}

async function serve(bytes) {
  const srv = http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d+)?/.exec(req.headers.range || '');
    const a = m ? Number(m[1]) : 0, b = m && m[2] ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1;
    res.writeHead(m ? 206 : 200, { 'Content-Range': `bytes ${a}-${b}/${bytes.length}`, 'Content-Length': b - a + 1 });
    res.end(Buffer.from(bytes.subarray(a, b + 1)));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return srv;
}

async function runReverse(file, from, to, name = 'x.mp4') {
  const log = { decoded: 0, out: [] };
  installFakes(log);
  const srv = await serve(file);
  const chunks = [];
  const result = await new Promise((resolve, reject) => {
    globalThis.postMessage = msg => {
      if (msg.type === 'chunk') chunks.push(msg.data);
      if (msg.type === 'done') resolve(msg);
      if (msg.type === 'error') reject(new Error(msg.message));
    };
    import('../app/renderer/reverse-worker.js?' + Math.random()).then(() => self.onmessage({ data: { type: 'start', url: `http://127.0.0.1:${srv.address().port}/${name}`, file: name, from, to } }));
  });
  srv.close();
  return { log, result, chunks };
}

test('Reverse: frames come out back to front, timed from the end, through B-frames and windows', async () => {
  const fps = 30, frames = 150;
  const file = buildFile(frames, fps, 30, true);
  const from = 1, to = 4; // frames 30 … 119
  const { log, result, chunks } = await runReverse(file, from, to);
  const ids = log.out.map(o => o.id);
  const expected = []; for (let f = 119; f >= 30; f--) expected.push(f);
  assert.deepStrictEqual(ids, expected);
  // the first output frame is at 0, the last ends at the range length
  assert.strictEqual(log.out[0].ts, 0);
  assert.ok(Math.abs(log.out[log.out.length - 1].ts - (to - from - 1 / fps) * 1e6) < 2);
  // the result is a readable MP4 with every frame
  const body = chunks.reduce((n, c) => n + c.length, 0), all = new Uint8Array(result.head.length + body);
  all.set(result.head, 0); let o = result.head.length; for (const c of chunks) { all.set(c, o); o += c.length; }
  const d = await demux(new BufferReader(all));
  assert.strictEqual(d.tracks[0].samples.length, 90);
  assert.ok(Math.abs(d.duration - 3) < 0.05);
  // windowed decoding stays bounded: well under decoding every GOP once per frame
  assert.ok(log.decoded < 90 * 4, `decoded ${log.decoded}`);
});

test('Reverse: big frames use small windows and still come out complete and in order', async () => {
  const fps = 30, frames = 120;
  const file = buildFile(frames, fps, 60, true, 3840, 2160); // ~12 MB a frame → windows of 16
  const { log } = await runReverse(file, 0.5, 3.5);
  const expected = []; for (let f = 104; f >= 15; f--) expected.push(f);
  assert.deepStrictEqual(log.out.map(o => o.id), expected);
  const ts = log.out.map(o => o.ts);
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] > ts[i - 1], 'timestamps increase');
});

test('Reverse: a sound-only WAV comes back as a reversed float WAV, with progress along the way', async () => {
  const rate = 8000, n = rate * 5, ch = 2;
  const pcm = new Int16Array(n * ch);
  for (let i = 0; i < n; i++) { pcm[i * 2] = i % 30000; pcm[i * 2 + 1] = -(i % 30000); }
  const h = new DataView(new ArrayBuffer(44)); const str = (o, t) => { for (let i = 0; i < t.length; i++) h.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); h.setUint32(4, 36 + pcm.byteLength, true); str(8, 'WAVE'); str(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, ch, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * ch * 2, true); h.setUint16(32, ch * 2, true); h.setUint16(34, 16, true); str(36, 'data'); h.setUint32(40, pcm.byteLength, true);
  const file = new Uint8Array(44 + pcm.byteLength); file.set(new Uint8Array(h.buffer), 0); file.set(new Uint8Array(pcm.buffer), 44);
  const progress = [];
  const origPost = globalThis.postMessage;
  const { result, chunks } = await runReverse(file, 1, 4, 'mic.wav');
  void origPost; void progress;
  assert.strictEqual(String.fromCharCode(...result.head.subarray(0, 4)), 'RIFF');
  const dv = new DataView(result.head.buffer, result.head.byteOffset);
  assert.strictEqual(dv.getUint16(20, true), 3); assert.strictEqual(dv.getUint32(24, true), rate);
  const body = new Uint8Array(chunks.reduce((k, c) => k + c.length, 0)); let o = 0; for (const c of chunks) { body.set(c, o); o += c.length; }
  const f = new Float32Array(body.buffer);
  assert.strictEqual(f.length / ch, 3 * rate);
  // first output sample = last input sample of the range (index 4*rate-1), last = first (rate)
  const near = (a, b) => Math.abs(a - b) < 1e-4;
  assert.ok(near(f[0], ((4 * rate - 1) % 30000) / 32768), `got ${f[0]}`);
  assert.ok(near(f[f.length - 2], (rate % 30000) / 32768));
  assert.ok(near(f[1], -((4 * rate - 1) % 30000) / 32768));
});
