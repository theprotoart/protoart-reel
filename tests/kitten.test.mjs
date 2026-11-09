import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// the pure parts of the Kitten voices panel (kitten.js needs a browser): the lists, voiceGroups and withEmotion
const src = readFileSync(new URL('../app/renderer/kitten.js', import.meta.url), 'utf8');
const part = src.slice(src.indexOf('export const EMOTIONS'), src.indexOf('/** Wraps the selection')).replaceAll('export const', 'const').replaceAll('export function', 'function');
const { voiceGroups, withEmotion, EMOTIONS } = new Function(part + '\nreturn { voiceGroups, withEmotion, EMOTIONS };')();

test('saved voices come first, then classics, characters, languages and the rest', () => {
  const g = voiceGroups(['Bruno', 'Victor', 'German', 'Zed', 'Luna'], [{ id: 'me', name: 'Me' }]);
  assert.deepEqual(g.map(x => x[0]), ['My voices', 'Voices', 'Characters', 'Languages', 'More voices']);
  assert.equal(g[0][1][0].value, 'mine:me');
  assert.deepEqual(g[1][1].map(o => o.value), ['Luna', 'Bruno']);
  assert.match(g[2][1][0].text, /Victor · controlled fury/);
  assert.deepEqual(g[4][1].map(o => o.value), ['Zed']);
});

test('empty groups are left out', () => {
  assert.deepEqual(voiceGroups(['Bruno'], []).map(x => x[0]), ['Voices']);
});

test('an emotion tags every paragraph that has no tag of its own', () => {
  assert.equal(withEmotion('  Hello there. ', ''), 'Hello there.');
  assert.equal(withEmotion('One.\n\n[sad] Two.\n\nThree.', 'joyful'), '[joyful] One.\n\n[sad] Two.\n\n[joyful] Three.');
  assert.equal(withEmotion('Hi', 'not-an-emotion'), 'Hi');
  assert.equal(EMOTIONS.length, 10);
});

test('the engine refuses bad saved voices and keeps a voice to 5-30 s with words', async () => {
  const require = createRequire(import.meta.url);
  const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
  const kitten = require('../app/engine/kitten.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-kitten-'));
  kitten.setUserData(dir);
  await assert.rejects(kitten.saveVoice('Me', new Float32Array(48000 * 2), 48000, 'one two three four five'), /5 to 30 seconds/);
  await assert.rejects(kitten.saveVoice('Me', new Float32Array(48000 * 10), 48000, 'hi'), /No speech/);
  const v = await kitten.saveVoice('My Voice!', new Float32Array(48000 * 10), 48000, 'this is me talking for a while');
  assert.equal(v.id, 'my-voice');
  const v2 = await kitten.saveVoice('My Voice!', new Float32Array(48000 * 10), 48000, 'this is me talking again');
  assert.equal(v2.id, 'my-voice-2');
  const list = await kitten.myVoices();
  assert.deepEqual(list.map(x => x.id).sort(), ['my-voice', 'my-voice-2']);
  const wav = fs.readFileSync(path.join(dir, 'Kitten', 'My Voices', 'my-voice.wav'));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt16LE(20), 3); assert.equal(wav.length, 44 + 480000 * 4);
  assert.equal(await kitten.myVoice('../etc'), null);
  const trashed = [];
  assert.equal(await kitten.deleteVoice('my-voice', async f => { trashed.push(path.basename(f)); fs.rmSync(f); }), true);
  assert.deepEqual(trashed, ['my-voice.wav', 'my-voice.json']);
  assert.equal(kitten.status().ready, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
