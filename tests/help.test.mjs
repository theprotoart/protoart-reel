import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// TOPICS / searchTopics live in about.js (which needs a browser): load just those
const src = readFileSync(new URL('../app/renderer/about.js', import.meta.url), 'utf8');
const part = src.slice(src.indexOf('export const TOPICS'), src.indexOf('export function showAbout')).replaceAll('export const', 'const').replaceAll('export function', 'function');
const { searchTopics } = new Function('el', part + '\nreturn { searchTopics };')(() => null);

test('questions find the topics that answer them', () => {
  assert.equal(searchTopics('how do I pause a recording').hits[0][0], 'Recording');
  assert.equal(searchTopics('claps').hits[0][0], 'Takes: clap when a line goes wrong');
  assert.equal(searchTopics('change keyboard shortcut').hits[0][0], 'Keyboard shortcuts');
  assert.match(searchTopics('plug-in render').hits[0][0], /plug-ins/);
  assert.equal(searchTopics('zzzz nothing').hits.length, 0);
  assert.ok(searchTopics('').hits.length > 10);
});
