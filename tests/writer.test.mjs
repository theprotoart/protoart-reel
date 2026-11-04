import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWriter, writerPrompt, transcriptText } from '../app/renderer/writer.js';

const words = []; let t = 0;
for (const s of ['Today we set up the studio.', 'First the camera goes on the tripod.', 'Then we plug in the microphone.', 'Finally we test the levels.']) {
  for (const w of s.split(' ')) { words.push({ t, end: t + 0.3, text: w }); t += 0.4; }
  t += 30;
}

test('the request lists the chapters with their times and what is said there', () => {
  const p = writerPrompt(words, t, [{ t: 0, label: 'Intro' }, { t: 33, label: 'x' }]);
  assert.match(p, /TITLES:/); assert.match(p, /CHAPTERS:/);
  assert.match(p, /1\. 00:00: "Today we set up/);
  assert.match(p, /2\. 00:33:/);
  assert.ok(transcriptText(words).includes('[00:00] Today we set up the studio.'));
});

test('a long transcript is sampled evenly, not cut off at the start', () => {
  const many = []; for (let i = 0; i < 3000; i++) many.push({ t: i * 2, end: i * 2 + 0.5, text: `word${i}.` });
  const txt = transcriptText(many, 2000);
  assert.ok(txt.length <= 2000);
  assert.ok(/word2[0-9]{3}/.test(txt), 'reaches the end of the video');
});

test('reads the answer, even a messy one; chapter times stay ours', () => {
  const answer = `Here you go!\nTITLES:\n1. "Build a Home Studio in 10 Minutes"\n2. Studio Setup for Beginners\n- Camera, Mic, Levels: Done\n\nDESCRIPTION:\nA quick walk through setting up a small studio.\n\nIt covers the camera, the mic and levels.\nCHAPTERS:\n1. 0:00 – Setting up\n2) Camera on the tripod\n3. Plugging in the mic\n9. Out of range`;
  const r = parseWriter(answer, 3);
  assert.deepEqual(r.titles, ['Build a Home Studio in 10 Minutes', 'Studio Setup for Beginners', 'Camera, Mic, Levels: Done']);
  assert.match(r.description, /small studio/);
  assert.deepEqual(r.names, ['Setting up', 'Camera on the tripod', 'Plugging in the mic']);
  assert.deepEqual(parseWriter('nothing useful', 2), { titles: [], description: '', names: [] });
});
