import test from 'node:test';
import assert from 'node:assert/strict';

// squareUpRecording lives in app.js (which needs a browser), so load just that function's source.
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../app/renderer/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('export function squareUpRecording'));
const squareUpRecording = new Function(body.replace('export function', 'return function'))();

const srcTime = (c, t) => c.in + (t - c.start) * (c.speed || 1);

test('recording clips are trimmed to start and end together, still in sync', () => {
  const screen = { start: 10.12, duration: 12.4, in: 0 };
  const mic = { start: 10.0, duration: 12.42, in: 0 };
  const before = [srcTime(screen, 15), srcTime(mic, 15)];
  squareUpRecording([screen, mic], 10);
  assert.equal(screen.start, mic.start);
  assert.ok(Math.abs((screen.start + screen.duration) - (mic.start + mic.duration)) < 1e-9);
  assert.equal(screen.start, 10);
  // sync: the same moment in each source still lines up (both moved by the same amount)
  const t = 15 - 0.12;
  assert.ok(Math.abs(srcTime(screen, t) - before[0]) < 1e-9);
  assert.ok(Math.abs(srcTime(mic, t) - before[1]) < 1e-9);
});

test('a clip that started much later is left alone', () => {
  const screen = { start: 0, duration: 20, in: 0 }, mic = { start: 0.05, duration: 19.9, in: 0 }, cam = { start: 5, duration: 15, in: 0 };
  squareUpRecording([screen, mic, cam], 0);
  assert.equal(cam.duration, 15);
  assert.equal(screen.start, mic.start);
});
