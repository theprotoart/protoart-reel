import test from 'node:test';
import assert from 'node:assert/strict';
import { etaText, leftText } from '../app/renderer/ui.js';

test('time left reads like a person would say it', () => {
  assert.equal(etaText(30, 0.25), 'about 1 min 30 s left');
  assert.equal(etaText(600, 0.5), 'about 10 min left');
  assert.equal(etaText(10, 0.9), 'a few seconds left');
  assert.equal(etaText(1, 0.5), ''); // too early to tell
  assert.equal(etaText(10, 0.01), '');
  assert.equal(leftText(2 * 3600 + 600), 'about 2 h 10 min left');
  assert.equal(leftText(45), 'about 45 s left');
});
