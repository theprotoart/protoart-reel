import test from 'node:test';
import assert from 'node:assert/strict';
import { recordingOffsets, outOfSync, resync } from '../app/renderer/lib/sync.js';

const media = (extra = {}) => [
  { id: 'scr', kind: 'video', role: 'screen', recording: 'r1', ...extra.scr },
  { id: 'mic', kind: 'audio', role: 'mic', recording: 'r1', ...extra.mic },
];
const clip = (id, mediaId, track, start, dur, inn = 0) => ({ id, type: 'media', media: mediaId, track, start, duration: dur, in: inn });
// a recording cut into three pieces; the mic file started 0.04 s after the screen
const doc = () => ({
  tracks: [{ id: 'v' }, { id: 'a' }],
  media: media(),
  clips: [
    clip('v1', 'scr', 'v', 0, 10, 0), clip('a1', 'mic', 'a', 0, 10, -0.04 + 0.04), // in sync (mic in = 0 at start 0.04)
    clip('v2', 'scr', 'v', 10, 10, 15), clip('a2', 'mic', 'a', 10, 10, 15 - 0.04),
    clip('v3', 'scr', 'v', 20, 10, 40), clip('a3', 'mic', 'a', 20, 10, 40 - 0.04),
  ],
});
const fix = d => { d.clips[1].start = 0.04; d.clips[1].in = 0; d.clips[1].duration = 9.96; return d; };

test('the offset between the files is found from the clips that agree', () => {
  const d = fix(doc());
  const offs = recordingOffsets(d, 'r1');
  assert.ok(Math.abs(offs.get('mic') - 0.04) < 1e-9);
  assert.equal(outOfSync(d).length, 0);
});

test('a sound clip that slipped is spotted and put back', () => {
  const d = fix(doc());
  d.clips[3].start = 10.7; // a2 dragged 0.7 s late
  const bad = outOfSync(d);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].clip.id, 'a2');
  assert.ok(Math.abs(bad[0].shift + 0.7) < 1e-9);
  const r = resync(d);
  assert.equal(r.moved, 1);
  assert.ok(Math.abs(d.clips.find(c => c.id === 'a2').start - 10) < 1e-9);
  assert.equal(outOfSync(d).length, 0);
});

test('stored file offsets are used as they are', () => {
  const d = fix(doc());
  d.media = media({ scr: { syncOff: 0 }, mic: { syncOff: 0.04 } });
  for (const c of d.clips) if (c.media === 'mic') c.start += 1.5; // every sound clip late: no majority to go by
  assert.equal(outOfSync(d).length, 3);
  resync(d);
  assert.equal(outOfSync(d).length, 0);
});

test('only the clips asked for move; a picture fixes its own sound', () => {
  const d = fix(doc());
  d.clips[3].start = 10.5; d.clips[5].start = 19.5;
  const r = resync(d, ['v3']);
  assert.equal(r.moved, 1);
  assert.equal(d.clips.find(c => c.id === 'a2').start, 10.5);
  assert.ok(Math.abs(d.clips.find(c => c.id === 'a3').start - 20) < 1e-9);
});

const free = (doc, track, start, dur, ignore) => !doc.clips.some(c => c.track === track && !ignore.includes(c.id) && start < c.start + c.duration - 1e-6 && start + dur > c.start + 1e-6);
test('it moves back into its own place; a clip in the way stops it', () => {
  const d = fix(doc());
  d.clips[3].start = 10.5;
  assert.equal(resync(d, null, free).moved, 1);
  d.clips[3].start = 10.5;
  d.clips.push({ id: 'x', type: 'media', media: 'other', track: 'a', start: 10, duration: 0.3 });
  const r = resync(d, null, free);
  assert.deepEqual(r, { moved: 0, blocked: 1 });
});

test('a recording whose only pair slipped minutes apart is still caught (they started together)', () => {
  const d = { tracks: [{ id: 'v' }, { id: 'a' }], media: media(), clips: [clip('v1', 'scr', 'v', 0, 700, 0), clip('a1', 'mic', 'a', 169, 700, 0)] };
  const bad = outOfSync(d);
  assert.equal(bad.length, 1);
  assert.ok(Math.abs(bad[0].shift + 169) < 1e-9);
  resync(d);
  assert.equal(d.clips.find(c => c.id === 'a1').start, 0);
});

test('a run of sound clips that slipped together goes back together, and missing sound is found', async () => {
  const { missingHalves } = await import('../app/renderer/lib/sync.js');
  // three cuts of one recording; the sound track lost a 5 s piece and everything after slid 5 s early
  const d = { tracks: [{ id: 'v' }, { id: 'a' }], media: media({ scr: { duration: 60 }, mic: { duration: 60 } }),
    clips: [clip('v1', 'scr', 'v', 0, 10, 0), clip('v2', 'scr', 'v', 10, 10, 10), clip('v3', 'scr', 'v', 20, 10, 20),
      clip('a1', 'mic', 'a', 0, 5, 0), clip('a2', 'mic', 'a', 5, 10, 10), clip('a3', 'mic', 'a', 15, 10, 20)] };
  const free = (doc, track, start, dur, ignore) => !doc.clips.some(c => c.track === track && !ignore.includes(c.id) && start < c.start + c.duration - 1e-6 && start + dur > c.start + 1e-6);
  assert.equal(resync(d, null, free).moved, 2);
  assert.deepEqual(d.clips.filter(c => c.media === 'mic').map(c => c.start).sort((a, b) => a - b), [0, 10, 20]);
  const h = missingHalves(d);
  assert.equal(h.length, 1);
  assert.equal(h[0].start, 5); assert.equal(h[0].in, 5); assert.equal(h[0].duration, 5);
});
