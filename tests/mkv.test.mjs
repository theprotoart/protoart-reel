// Matroska blocks: plain, Xiph-laced, EBML-laced and fixed-size laced frames come apart correctly.
import test from 'node:test';
import assert from 'node:assert';
import { parseBlock } from '../app/renderer/lib/mkv.js';

const frames = [new Uint8Array(300).fill(1), new Uint8Array(20).fill(2), new Uint8Array(7).fill(3)];
const head = (flags) => [0x81, 0x00, 0x10, flags]; // track 1, +16 ticks
test('plain block', () => {
  const b = Uint8Array.from([...head(0x80), 9, 9, 9]);
  const [f] = parseBlock(b, true);
  assert.strictEqual(f.track, 1); assert.strictEqual(f.rel, 16); assert.ok(f.key); assert.deepStrictEqual([...f.datas[0]], [9, 9, 9]);
});
test('negative relative time', () => { const [f] = parseBlock(Uint8Array.from([0x81, 0xff, 0xf0, 0x00, 1]), true); assert.strictEqual(f.rel, -16); assert.ok(!f.key); });
test('Xiph lacing', () => {
  const b = Uint8Array.from([...head(0x82), 2, 255, 45, 20, ...frames[0], ...frames[1], ...frames[2]]);
  const [f] = parseBlock(b, true);
  assert.deepStrictEqual(f.datas.map(d => d.length), [300, 20, 7]); assert.strictEqual(f.datas[2][0], 3);
});
test('EBML lacing', () => {
  // first size 300 as a 2-byte vint (0x412C), then the difference 20-300 = -280 as a signed 2-byte vint: -280 + 8191 = 7911 → 0x5EE7
  const b = Uint8Array.from([...head(0x86), 2, 0x41, 0x2c, 0x5e, 0xe7, ...frames[0], ...frames[1], ...frames[2]]);
  const [f] = parseBlock(b, true);
  assert.deepStrictEqual(f.datas.map(d => d.length), [300, 20, 7]);
});
test('fixed-size lacing', () => {
  const b = Uint8Array.from([...head(0x84), 2, ...new Uint8Array(30).fill(5)]);
  assert.deepStrictEqual(parseBlock(b, true)[0].datas.map(d => d.length), [10, 10, 10]);
});
