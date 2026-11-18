import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTimecode } from '../app/renderer/model.js';

test('typing a time to jump the playhead to', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
  near(parseTimecode('02:48:21', 30), 2 * 60 + 48 + 21 / 30); // as the display shows it: MM:SS:FF
  near(parseTimecode('1:02:48:21', 30), 3600 + 2 * 60 + 48 + 21 / 30); // with the hour
  near(parseTimecode('2:48', 30), 168); // minutes and seconds
  near(parseTimecode('2:48.5', 30), 168.5);
  near(parseTimecode('168', 30), 168); // seconds
  near(parseTimecode(' 2 48 21 ', 30), 168.7); // spaces as colons
  near(parseTimecode('+5', 30, 100), 105); // from where it is
  near(parseTimecode('-1:00', 30, 100), 40);
  near(parseTimecode('-5', 30, 2), 0); // never before the start
  assert.equal(parseTimecode('02:48:30', 30), null, 'frame 30 is past the last of a second at 30 fps');
  assert.equal(parseTimecode('2.5:10', 30), null);
  assert.equal(parseTimecode('abc', 30), null);
  assert.equal(parseTimecode('', 30), null);
});
