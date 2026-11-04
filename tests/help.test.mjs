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
  assert.match(searchTopics('plug-in render').hits[0][0], /plug-in/);
  assert.equal(searchTopics('zzzz nothing').hits.length, 0);
  assert.ok(searchTopics('').hits.length > 10);
});

test('problems described in everyday words find their fix', () => {
  const top = q => searchTopics(q).hits[0]?.[0] || '';
  assert.match(top('export stuck on starting'), /Export seems frozen/);
  assert.match(top('audio not exporting by itself freezes'), /Export seems frozen/);
  assert.match(top('menu does nothing when i click'), /menu does nothing/);
  assert.match(top('cedar no difference'), /sounds the same/);
  assert.match(top('save plugin configuration as a preset'), /Effects presets/);
  assert.match(top('mouth clicks'), /De-click/);
  assert.match(top('wav'), /Exporting/);
  assert.match(top('music too loud'), /Music too loud/);
  assert.match(top('recording lost after pause'), /lost during a pause/);
  assert.match(top('callout not showing'), /don’t show/);
  assert.match(top('master bus plugin'), /master bus/);
});

test('every feature of this version has a help topic, and troubleshooting is its own group', () => {
  for (const q of ['auto mix', 'de-click', 'preset', 'tutorial', 'wav', 'end screen picture', 'close gaps', 'select forward', 'smooth every cut', 'marker', 'transitions every cut', 'speed', 'undo', 'new recording'])
    assert.ok(searchTopics(q).hits.length, `nothing for “${q}”`);
  const fixes = searchTopics('', 'fix').hits;
  assert.ok(fixes.length >= 10 && fixes.every(t => t[3] === 'fix'));
});
