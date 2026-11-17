// Bleeping swearing: which words count, where the bleeps go, and what they do to the project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { swearTest, swearRanges, starred, cleanWords, applyBleeps, unbleep } from '../app/renderer/lib/profanity.js';
import { gainAt, newMediaClip, addTrack } from '../app/renderer/model.js';

test('the swear words, and the ordinary words that only look like them', () => {
  const is = swearTest();
  for (const w of ['fuck', 'Fucking,', 'motherfucker', 'shit.', 'bullshit', 'bitch', 'asshole', 'f***', 's**t', 'Goddamn']) assert.ok(is(w), w);
  for (const w of ['hello', 'class', 'assume', 'cockpit', 'spicy', 'shiitake', 'retardant', 'title', 'hell', 'damn', 'Dickens', 'scunthorpe']) assert.ok(!is(w), w);
  const all = swearTest({ level: 'all' });
  assert.ok(all('hell') && all('Damn!') && all('crap'));
  assert.ok(!swearTest({ allow: ['shit'] })('shit'), 'a word you allow is left in');
  assert.ok(swearTest({ extra: ['frick*'] })('fricking'), 'a word you add is bleeped');
});

test('bleep ranges cover the whole word, and words close together become one', () => {
  const words = [{ t: 1, end: 1.3, text: 'what', clip: 'm' }, { t: 1.35, end: 1.7, text: 'the', clip: 'm' }, { t: 1.75, end: 2.1, text: 'fuck', clip: 'm' }, { t: 2.12, end: 2.4, text: 'shit', clip: 'm' }, { t: 5, end: 5.4, text: 'damn', clip: 'm' }];
  const r = swearRanges(words);
  assert.equal(r.length, 1);
  assert.ok(r[0].t < 1.75 && r[0].end > 2.4, JSON.stringify(r));
  assert.deepEqual([...r[0].clips], ['m']);
  assert.equal(starred('fucking'), 'f******');
  assert.deepEqual(cleanWords(words).map(w => w.text), ['what', 'the', 'f***', 's***', 'damn']);
});

function project() {
  const media = [{ id: 'mic', kind: 'audio', hasAudio: true, recording: 'r1', duration: 60 }, { id: 'cam', kind: 'video', hasAudio: true, recording: 'r1', duration: 60, width: 1920, height: 1080 }, { id: 'song', kind: 'audio', hasAudio: true, duration: 60 }, { id: 'tone', kind: 'audio', hasAudio: true, bleepTone: true, duration: 3 }];
  const doc = { canvas: { width: 1920, height: 1080 }, media, tracks: [{ id: 'v' }, { id: 'a' }, { id: 'm' }], clips: [], markers: [] };
  const mk = (id, m, tr, start, dur, inn = 0) => { const c = newMediaClip(doc, media.find(x => x.id === m), tr, start); Object.assign(c, { id, duration: dur, in: inn }); doc.clips.push(c); return c; };
  mk('cam1', 'cam', 'v', 0, 20); mk('mic1', 'mic', 'a', 0, 10); mk('mic2', 'mic', 'a', 10, 10, 12); mk('song1', 'song', 'm', 0, 20);
  return doc;
}

test('bleeping mutes the voice on every clip of that recording, leaves the music, and puts a tone over it', () => {
  const doc = project();
  // a level the user set on the mic beforehand: kept either side
  doc.clips.find(c => c.id === 'mic1').keys = { 'audio.volume': [{ t: 0, v: 0.8, ease: 'linear' }, { t: 9, v: 0.8, ease: 'linear' }] };
  const n = applyBleeps(doc, [{ t: 4, end: 4.5, text: 'fuck', clips: new Set(['mic1']) }], { mode: 'bleep', tone: doc.media.find(m => m.bleepTone), newClip: newMediaClip, addTrack });
  assert.equal(n, 1);
  const g = (id, t) => { const c = doc.clips.find(x => x.id === id); return gainAt(doc, c, t - c.start); };
  assert.equal(g('mic1', 4.25), 0, 'the mic is muted mid-word');
  assert.equal(g('cam1', 4.25), 0, 'and the camera’s own sound of the same recording');
  assert.ok(g('song1', 4.25) > 0.9, 'the music carries on');
  assert.ok(Math.abs(g('mic1', 3) - 0.8) < 1e-9 && Math.abs(g('mic1', 6) - 0.8) < 1e-9, 'the level either side is as it was');
  assert.ok(g('mic2', 14) > 0.9, 'other clips of the voice aren’t touched');
  const tone = doc.clips.filter(c => c.style === 'auto-bleep');
  assert.equal(tone.length, 1);
  assert.ok(Math.abs(tone[0].start - 4) < 1e-9 && Math.abs(tone[0].duration - 0.5) < 1e-9);
  assert.ok(doc.tracks.find(t => t.id === tone[0].track)?.bleeps, 'on a Bleeps track');
  // running it again replaces it (no doubles); unbleep takes it all out
  applyBleeps(doc, [{ t: 4, end: 4.5, text: 'fuck', clips: new Set(['mic1']) }], { mode: 'mute', newClip: newMediaClip, addTrack });
  assert.equal(doc.clips.filter(c => c.style === 'auto-bleep').length, 0, 'mute mode: no tone');
  assert.equal(g('mic1', 4.25), 0);
  unbleep(doc);
  assert.ok(Math.abs(g('mic1', 4.25) - 0.8) < 1e-9, 'the user’s own level back');
  assert.equal(doc.clips.find(c => c.id === 'cam1').keys, undefined, 'nothing left behind');
});
