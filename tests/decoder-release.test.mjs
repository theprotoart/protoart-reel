import test from 'node:test';
import assert from 'node:assert/strict';

// A stand-in for the browser's VideoDecoder that counts how many are open at once, like macOS's small pool.
let open = 0, peak = 0;
globalThis.VideoDecoder = class {
  constructor({ output }) { this.output = output; this.state = 'configured'; this.decodeQueueSize = 0; open++; peak = Math.max(peak, open); }
  configure() {}
  decode(chunk) { const ts = chunk.timestamp; queueMicrotask(() => this.output({ timestamp: ts, close() {} })); }
  flush() { return Promise.resolve(); }
  close() { if (this.state !== 'closed') { this.state = 'closed'; open--; } }
  static isConfigSupported() { return Promise.resolve({ supported: true }); }
};
globalThis.EncodedVideoChunk = class { constructor(o) { Object.assign(this, o); } };

const { VideoSource } = await import('../app/renderer/lib/sources.js');

// one 30 fps recording, every frame a keyframe (keeps the stand-in simple)
const track = { timescale: 30, samples: Array.from({ length: 30 * 120 }, (_, i) => ({ offset: 0, size: 1, sync: true, duration: 1, dts: i, pts: i })) };
track.keyframes = track.samples.map((_, i) => i);
const reader = { read: async () => new Uint8Array(1) };

test('decoders of clips that have finished are released, so a long edit never runs out', async () => {
  // 40 clips cut from the same recording, played one after another (the export walks the timeline)
  const clips = Array.from({ length: 40 }, (_, i) => ({ id: 'c' + i, src: new VideoSource(reader, track), from: i * 2, len: 2 }));
  open = 0; peak = 0;
  for (const c of clips) {
    for (let k = 0; k < 4; k++) await c.src.frameAt(c.from + k * 0.5);
    for (const o of clips) if (o !== c) o.src.release(); // what the export does each frame
  }
  assert.ok(peak <= 2, `at most a couple of decoders open at once (was ${peak})`);
  for (const c of clips) c.src.close();
  assert.equal(open, 0);
});

test('a released clip that shows again decodes from the right place', async () => {
  const s = new VideoSource(reader, track);
  const f1 = await s.frameAt(10);
  s.release();
  const f2 = await s.frameAt(10.5);
  assert.ok(f1 && f2);
  assert.ok(Math.abs(f2.timestamp / 1e6 - 10.5) < 0.05, `frame at 10.5 s (got ${f2.timestamp / 1e6})`);
  s.close();
});
