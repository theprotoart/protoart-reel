import test from 'node:test';
import assert from 'node:assert/strict';

// A stand-in VideoDecoder that fails on a broken stretch of the file (both hardware and software), like a recording
// with missing slices: before, the export stopped with "Video decoding failed: Decoding error".
const BAD = [20e6, 21e6]; // 20–21 s (microseconds) won't decode
globalThis.VideoDecoder = class {
  constructor({ output, error }) { this.output = output; this.error = error; this.state = 'configured'; this.decodeQueueSize = 0; }
  configure() {}
  decode(chunk) {
    // as the browser's: a closed decoder refuses more ("Cannot call 'decode' on a closed codec")
    if (this.state === 'closed') throw new Error("Failed to execute 'decode' on 'VideoDecoder': Cannot call 'decode' on a closed codec.");
    const ts = chunk.timestamp;
    queueMicrotask(() => {
      if (this.state === 'closed') return;
      // it closes at once, and says why only a moment later (more chunks can be fed in between)
      if (ts >= BAD[0] && ts < BAD[1]) { this.state = 'closed'; setTimeout(() => this.error(new Error('Decoding error')), 5); return; }
      this.output({ timestamp: ts, close() {} });
    });
  }
  flush() { return Promise.resolve(); }
  close() { this.state = 'closed'; }
};
globalThis.EncodedVideoChunk = class { constructor(o) { Object.assign(this, o); } };
const { VideoSource } = await import('../app/renderer/lib/sources.js');

// 30 fps, a keyframe every second
const track = { timescale: 30, samples: Array.from({ length: 30 * 40 }, (_, i) => ({ offset: 0, size: 1, sync: i % 30 === 0, duration: 1, dts: i, pts: i })) };
const reader = { read: async () => new Uint8Array(1) };

test('a damaged stretch holds the last good frame and the export carries on after it', async () => {
  const s = new VideoSource(reader, track);
  const bad = [];
  s.onBad = t => bad.push(t);
  const shown = [];
  for (let t = 18; t < 24; t += 1 / 30) {
    const f = await s.frameAt(t); // never throws
    shown.push([t, f ? f.timestamp / 1e6 : null]);
  }
  assert.ok(bad.length >= 1, 'the damaged part is reported');
  const inBad = shown.filter(([t]) => t >= 20.05 && t < 20.95);
  assert.ok(inBad.every(([, ft]) => ft !== null && ft < 20), 'the last good frame is held through the damage');
  const after = shown.filter(([t]) => t >= 21.1);
  assert.ok(after.length && after.every(([t, ft]) => Math.abs(ft - t) < 0.05), 'the picture moves again from the next good keyframe');
  s.close();
});
