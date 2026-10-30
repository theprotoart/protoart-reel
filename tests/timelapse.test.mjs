// Time-lapse planning: lands on the target, quiet parts faster than busy ones, ramps, and the timeline rebuild.
import test from 'node:test';
import assert from 'node:assert';
import { plan, apply } from '../app/renderer/timelapse.js';

// 10 minutes: busy for the first 2 minutes, quiet (nothing changes) for 6, busy again for the last 2
const act = [];
for (let t = 0; t < 600; t += 0.2) act.push({ t, a: t < 120 || t >= 480 ? 0.5 + 0.3 * Math.sin(t) : 0.002 });
const len = segs => segs.reduce((m, s) => m + (s.s1 - s.s0) / s.speed, 0);
const speedAt = (segs, t) => segs.find(s => t >= s.s0 && t < s.s1).speed;

test('smart: lands on 60 s, races the quiet middle, keeps the action slower', () => {
  const segs = plan(act, 600, { mode: 'smart', target: 60 });
  assert.ok(Math.abs(len(segs) - 60) < 1, `length ${len(segs).toFixed(2)}`);
  assert.ok(speedAt(segs, 300) > speedAt(segs, 60) * 3, `quiet ${speedAt(segs, 300)} vs busy ${speedAt(segs, 60)}`);
  assert.equal(segs[0].s0, 0); assert.ok(Math.abs(segs.at(-1).s1 - 600) < 1e-6);
  for (let i = 1; i < segs.length; i++) assert.ok(Math.abs(segs[i].s0 - segs[i - 1].s1) < 1e-6, 'pieces join up');
  for (let i = 1; i < segs.length; i++) assert.ok(Math.abs(Math.log2(segs[i].speed / segs[i - 1].speed)) <= 1.5, 'speed changes are eased');
});

test('skip the waiting: busy stays at normal speed, quiet goes up to 8×', () => {
  const segs = plan(act, 600, { mode: 'skip' });
  assert.ok(speedAt(segs, 60) <= 1.2, `busy ${speedAt(segs, 60)}`);
  assert.ok(speedAt(segs, 300) >= 7, `quiet ${speedAt(segs, 300)}`);
});

test('even: one speed to the length', () => {
  const segs = plan(act, 600, { mode: 'even', target: 120 });
  assert.deepEqual(segs, [{ s0: 0, s1: 600, speed: 5 }]);
});

test('apply: pieces in a row, keys follow their moment, later clips move up, sound muted', () => {
  const c = { id: 'v', type: 'media', track: 't', start: 10, duration: 100, in: 5, speed: 1, keys: { scale: [{ t: 50, v: 2 }] }, actions: [], audio: { mute: false }, transIn: { type: 'fade', dur: 0.5 }, transOut: { type: 'fade', dur: 0.5 } };
  const after = { id: 'n', type: 'media', track: 't', start: 110, duration: 5 };
  const doc = { clips: [c, after], markers: [{ t: 120 }] };
  const segs = [{ s0: 0, s1: 40, speed: 1 }, { s0: 40, s1: 100, speed: 6 }];
  const r = apply(doc, c, segs, { sound: 'mute' });
  assert.equal(r.after, 50);
  const pieces = doc.clips.filter(k => k.lapse);
  assert.equal(pieces.length, 2);
  assert.deepEqual(pieces.map(p => [p.start, p.duration, p.in, p.speed]), [[10, 40, 5, 1], [50, 10, 45, 6]]);
  assert.ok(pieces.every(p => p.audio.mute));
  assert.ok(Math.abs(pieces[1].keys.scale[0].t - (50 - 40) / 6) < 1e-9); // the key at source 50 s, now in piece 2
  assert.equal(doc.clips.find(k => k.id === 'n').start, 60); assert.equal(doc.markers[0].t, 70);
  assert.equal(pieces[0].transOut.type, 'none'); assert.equal(pieces[1].transIn.type, 'none');
});
