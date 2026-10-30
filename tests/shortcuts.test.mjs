import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// accelOf / pretty live in shortcuts.js (which needs a browser): load just those
const src = readFileSync(new URL('../app/renderer/shortcuts.js', import.meta.url), 'utf8');
const part = src.slice(src.indexOf('const CODE_KEYS'), src.indexOf('const modded')).replaceAll('export function', 'function');
const { accelOf, pretty } = new Function(part + '\nreturn { accelOf, pretty };')();
const ev = (code, mods = {}) => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test('a key press becomes an accelerator from the physical key', () => {
  assert.equal(accelOf(ev('KeyK', { metaKey: true, shiftKey: true })), 'Command+Shift+K');
  assert.equal(accelOf(ev('KeyX', { altKey: true })), 'Alt+X'); // ⌥X types ≈ on a Mac: the key still counts
  assert.equal(accelOf(ev('BracketLeft')), '[');
  assert.equal(accelOf(ev('Space')), 'Space');
  assert.equal(accelOf(ev('ShiftLeft', { shiftKey: true })), null);
});

test('shortcuts show the Mac way', () => {
  assert.equal(pretty('Command+Shift+K'), '⇧⌘K');
  assert.equal(pretty('Control+Alt+Backspace'), '⌃⌥⌫');
  assert.equal(pretty(''), '—');
});
