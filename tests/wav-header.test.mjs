import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WavAudio } from '../app/renderer/lib/sources.js';

// a 24-bit stereo WAV the way recorders and DAWs write it: a 200 KB bext/iXML chunk before the sound
function bigHeaderWav(frames = 4800) {
  const junk = 200 * 1024, fmt = 16, data = frames * 2 * 3;
  const b = Buffer.alloc(12 + 8 + junk + 8 + fmt + 8 + data);
  let p = 0;
  b.write('RIFF', p); b.writeUInt32LE(b.length - 8, p + 4); b.write('WAVE', p + 8); p = 12;
  b.write('iXML', p); b.writeUInt32LE(junk, p + 4); p += 8 + junk;
  b.write('fmt ', p); b.writeUInt32LE(fmt, p + 4); b.writeUInt16LE(1, p + 8); b.writeUInt16LE(2, p + 10); b.writeUInt32LE(48000, p + 12);
  b.writeUInt32LE(48000 * 6, p + 16); b.writeUInt16LE(6, p + 20); b.writeUInt16LE(24, p + 22); p += 8 + fmt;
  b.write('data', p); b.writeUInt32LE(data, p + 4); p += 8;
  for (let i = 0; i < frames; i++) { const v = Math.round(Math.sin(i / 10) * 4000000); for (let c = 0; c < 2; c++) { b.writeIntLE(v, p, 3); p += 3; } }
  return new Uint8Array(b.buffer, b.byteOffset, b.length);
}
const readerOf = bytes => ({ size: bytes.length, read: async (o, n) => bytes.subarray(o, Math.min(bytes.length, o + n)) });

test('a WAV whose sound starts far into the file opens and reads', async () => {
  const a = await new WavAudio(readerOf(bigHeaderWav())).open();
  assert.equal(a.rate, 48000); assert.equal(a.channels, 2); assert.equal(a.frames, 4800);
  const [l] = await a.read(10, 1);
  assert.ok(Math.abs(l[0] - Math.sin(1) * 4000000 / 8388608) < 1e-4);
});

test('the import reads that WAV too (main process)', async () => {
  const src = readFileSync(new URL('../app/main.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function wavInfoOf'), src.indexOf('\n}\n', src.indexOf('async function wavInfoOf')) + 3);
  const wavInfoOf = new Function('Buffer', fn + '\nreturn wavInfoOf;')(Buffer);
  const info = await wavInfoOf(readerOf(bigHeaderWav()));
  assert.equal(info.sampleRate, 48000); assert.ok(Math.abs(info.duration - 0.1) < 1e-9); assert.equal(info.playable, true);
});
