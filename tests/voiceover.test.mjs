// Voice-over: where takes land and what a punch-in replaces.
import test from 'node:test';
import assert from 'node:assert';
import { placeTake, wavHeader } from '../app/renderer/voiceover.js';
import { normalize, newMediaClip, clipEnd } from '../app/renderer/model.js';

const doc0 = () => normalize({ canvas: { width: 1920, height: 1080, fps: 30 }, tracks: [{ id: 't1', name: 'Track 1' }], clips: [], media: [{ id: 'mv', kind: 'video', duration: 30, file: 'v.mp4', name: 'v' }] });
const take = (id, dur) => ({ id, kind: 'audio', duration: dur, file: id + '.wav', name: id, role: 'mic' });

test('a voice-over lands on a new Voice-over track at the playhead, latency skipped', () => {
  const d = doc0();
  const m = take('vo1', 10); d.media.push(m);
  const r = placeTake(d, m, { start: 4, skip: 0.15, length: 9.85 });
  const tr = d.tracks.find(t => t.id === r.trackId);
  assert.strictEqual(tr.name, 'Voice-over');
  const c = d.clips.find(x => x.id === r.clipId);
  assert.strictEqual(c.start, 4); assert.strictEqual(c.in, 0.15); assert.ok(Math.abs(c.duration - 9.85) < 1e-9);
  assert.ok(c.audio.voice);
  // a second take that overlaps goes on another track instead of on top
  const m2 = take('vo2', 5); d.media.push(m2);
  const r2 = placeTake(d, m2, { start: 6, skip: 0, length: 5 });
  assert.notStrictEqual(r2.trackId, r.trackId);
  // one that fits after it reuses the voice track
  const m3 = take('vo3', 3); d.media.push(m3);
  assert.strictEqual(placeTake(d, m3, { start: 20, skip: 0, length: 3 }).trackId, r.trackId);
});

test('punch-in replaces only In→Out on the voice track, with crossfades', () => {
  const d = doc0();
  const m = take('vo1', 20); d.media.push(m);
  const { trackId } = placeTake(d, m, { start: 0, skip: 0, length: 20 });
  const p = take('punch', 6); d.media.push(p);
  // pre-roll 2 s: recording started at 3, In 5, Out 8
  const r = placeTake(d, p, { start: 5, skip: 0.1 + 2, length: 3 }, { punch: true });
  assert.strictEqual(r.trackId, trackId);
  const on = d.clips.filter(c => c.track === trackId).sort((a, b) => a.start - b.start);
  assert.deepStrictEqual(on.map(c => [c.media, +c.start.toFixed(3), +clipEnd(c).toFixed(3)]), [['vo1', 0, 5], ['punch', 5, 8], ['vo1', 8, 20]]);
  assert.strictEqual(on[1].in, 2.1);
  assert.ok(on[0].audio.fadeOut > 0 && on[1].audio.fadeIn > 0 && on[1].audio.fadeOut > 0 && on[2].audio.fadeIn > 0);
  assert.strictEqual(on[2].in, 8); // the old take carries on from where it was
  // the video on Track 1 is untouched
  assert.ok(!d.clips.some(c => c.track === 't1'));
});

test('WAV header for float mono 48 kHz', () => {
  const h = new DataView(wavHeader(48000, 1, 48000).buffer);
  assert.strictEqual(h.getUint16(20, true), 3); assert.strictEqual(h.getUint32(24, true), 48000); assert.strictEqual(h.getUint32(40, true), 192000);
});
