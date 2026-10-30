// Core tests: MP4 mux/demux round trip, timeline editing, validation. Run: npm test
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { Muxer, demux, BufferReader, sampleTime, keyframeBefore } from '../app/renderer/lib/mp4.js';
import * as M from '../app/renderer/model.js';
import { zoomProps, cursorAt, autoZoom, keysAt, clicksBetween } from '../app/renderer/cursor.js';
import { clickSample } from '../app/renderer/lib/click.js';
const require = createRequire(import.meta.url);
const validate = require('../app/validate.js');

// A real avcC (High profile, level 4.0) and AAC-LC stereo 48 kHz AudioSpecificConfig
const AVCC = Uint8Array.from([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80]);
const ASC = Uint8Array.from([0x11, 0x90]);

function build({ frames = 90, fps = 30, audio = true } = {}) {
  const m = new Muxer({ video: { codec: 'avc1.640028', width: 1920, height: 1080, description: AVCC }, audio: audio ? { codec: 'mp4a.40.2', sampleRate: 48000, channels: 2, description: ASC } : null });
  const parts = [];
  let a = 0;
  for (let i = 0; i < frames; i++) {
    const data = new Uint8Array(100 + (i % 7)).fill(i & 255);
    parts.push(m.addVideo(data, { timestamp: (i * 1e6) / fps, duration: 1e6 / fps, key: i % 30 === 0 }));
    while (audio && a * 1024 / 48000 <= (i + 1) / fps) { parts.push(m.addAudio(new Uint8Array(20).fill(7), { timestamp: (a * 1024 * 1e6) / 48000, duration: (1024 * 1e6) / 48000, key: true })); a++; }
  }
  const head = m.finish();
  const total = head.length + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  out.set(head, 0);
  let o = head.length;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return { file: out, frames, audioFrames: a };
}

test('MP4: what the muxer writes, the demuxer reads back exactly', async () => {
  const { file, frames, audioFrames } = build();
  const d = await demux(new BufferReader(file));
  const v = d.tracks.find(t => t.kind === 'video'), a = d.tracks.find(t => t.kind === 'audio');
  assert.strictEqual(v.codec, 'avc1.640028');
  assert.strictEqual(v.width, 1920); assert.strictEqual(v.height, 1080);
  assert.deepStrictEqual(Array.from(v.description), Array.from(AVCC));
  assert.strictEqual(v.samples.length, frames);
  assert.strictEqual(v.samples.filter(s => s.sync).length, 3);
  assert.ok(Math.abs(sampleTime(v, v.samples[45]) - 1.5) < 1e-6);
  // sample bytes land where the tables say
  for (const i of [0, 1, 44, 89]) assert.ok(file.subarray(v.samples[i].offset, v.samples[i].offset + v.samples[i].size).every(b => b === (i & 255)));
  assert.strictEqual(a.codec, 'mp4a.40.2');
  assert.strictEqual(a.sampleRate, 48000);
  assert.strictEqual(a.samples.length, audioFrames);
  assert.ok(Math.abs(d.duration - 3) < 0.05);
  assert.strictEqual(keyframeBefore(v, 1.9), 30);
});

test('MP4: moov comes before the media data (fast start)', () => {
  const { file } = build({ audio: false });
  const type = o => String.fromCharCode(...file.subarray(o + 4, o + 8));
  const ftypSize = new DataView(file.buffer).getUint32(0);
  assert.strictEqual(type(0), 'ftyp');
  assert.strictEqual(type(ftypSize), 'moov');
});

test('MP4: hevc and aac codec strings are derived from their configs', async () => {
  const hvcc = Uint8Array.from([1, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 0x5d, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f, 0]);
  const m = new Muxer({ video: { codec: 'hvc1.1.6.L93.90', width: 640, height: 360, description: hvcc } });
  const p = m.addVideo(new Uint8Array(10), { timestamp: 0, duration: 33333, key: true });
  const head = m.finish();
  const f = new Uint8Array(head.length + p.length); f.set(head); f.set(p, head.length);
  const d = await demux(new BufferReader(f));
  assert.strictEqual(d.tracks[0].codec, 'hvc1.1.6.L93.90');
});

// ---------------------------------------------------------------- model
const doc0 = () => M.normalize({ version: 1, canvas: { width: 1920, height: 1080, fps: 30 }, media: [{ id: 'm1', file: 'a.mp4', kind: 'video', duration: 10, width: 1920, height: 1080, hasAudio: true }], tracks: [{ id: 't1', name: 'T1' }, { id: 't2', name: 'T2' }], clips: [], markers: [] });

test('Model: split keeps the source continuous and moves later actions right', () => {
  const doc = doc0();
  const c = M.newMediaClip(doc, doc.media[0], 't1', 2); doc.clips.push(c);
  c.actions.push({ id: 'a1', t: 1, dur: 0.5, props: { scale: 2 } }, { id: 'a2', t: 6, dur: 1, props: { scale: 1 } });
  const [rid] = M.split(doc, 5, null);
  const r = doc.clips.find(x => x.id === rid);
  assert.strictEqual(c.duration, 3);
  assert.strictEqual(r.start, 5); assert.strictEqual(r.in, 3); assert.strictEqual(r.duration, 7);
  assert.deepStrictEqual(c.actions.map(a => a.id), ['a1']);
  assert.strictEqual(r.actions[0].t, 3);
  assert.strictEqual(r.props.scale, 2); // state at the cut carries over
});

test('Model: actions animate between states with easing', () => {
  const doc = doc0();
  const c = M.newMediaClip(doc, doc.media[0], 't1', 0);
  c.actions.push({ id: 'a', t: 1, dur: 2, ease: 'linear', props: { scale: 3, x: 0.2 } });
  assert.strictEqual(M.propsAt(c, 0.5).scale, 1);
  assert.ok(Math.abs(M.propsAt(c, 2).scale - 2) < 1e-9);
  assert.ok(Math.abs(M.propsAt(c, 2).x - 0.35) < 1e-9);
  assert.strictEqual(M.propsAt(c, 5).scale, 3);
});

test('Model: trimming never runs past the media or into a neighbour', () => {
  const doc = doc0();
  const a = M.newMediaClip(doc, doc.media[0], 't1', 0); doc.clips.push(a);
  const b = M.newMediaClip(doc, doc.media[0], 't1', 12); doc.clips.push(b);
  M.trim(doc, a, 'end', 30, doc.media[0]);
  assert.strictEqual(a.duration, 10);
  M.trim(doc, b, 'start', 3, doc.media[0]);
  assert.strictEqual(b.start, 12); // its in-point is 0: can't extend left
  M.trim(doc, b, 'start', 14, doc.media[0]);
  assert.strictEqual(b.start, 14); assert.strictEqual(b.in, 2);
  M.trim(doc, b, 'start', 9, doc.media[0]);
  assert.strictEqual(b.start, 12); // back to the media start, not over clip a (ends at 10)
});

test('Model: ripple delete closes the gap on that track only', () => {
  const doc = doc0();
  const a = M.newMediaClip(doc, doc.media[0], 't1', 0), b = M.newMediaClip(doc, doc.media[0], 't1', 10), x = M.newMediaClip(doc, doc.media[0], 't2', 20);
  doc.clips.push(a, b, x);
  M.remove(doc, [a.id], true);
  assert.strictEqual(b.start, 0);
  assert.strictEqual(x.start, 20);
});

test('Model: fades and ducking shape the gain', () => {
  const doc = doc0();
  const music = M.newMediaClip(doc, doc.media[0], 't2', 0); music.audio.fadeIn = 2; music.audio.duck = 0.5;
  const voice = M.newMediaClip(doc, doc.media[0], 't1', 4); voice.audio.voice = true; voice.duration = 2;
  doc.clips.push(music, voice);
  assert.ok(Math.abs(M.gainAt(doc, music, 1) - 0.5) < 1e-9);
  assert.ok(Math.abs(M.gainAt(doc, music, 5) - 0.5) < 1e-9);
  assert.strictEqual(M.gainAt(doc, music, 7), 1);
  doc.tracks[1].muted = true;
  assert.strictEqual(M.gainAt(doc, music, 7), 0);
});

test('Model: undo and redo restore whole states', () => {
  const doc = doc0(), h = new M.History();
  h.push(doc); doc.clips.push(M.newMediaClip(doc, doc.media[0], 't1', 0));
  const back = h.undo(doc);
  assert.strictEqual(back.clips.length, 0);
  assert.strictEqual(h.redo(back).clips.length, 1);
});

test('Cursor: zoom keeps the frame covering the canvas', () => {
  const p = zoomProps({ x: 0.99, y: 0.01 }, 2);
  assert.strictEqual(p.scale, 2);
  assert.ok(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
  const data = { display: { bounds: { x: 0, y: 0, width: 1000, height: 500 } }, points: [[0, 100, 100], [1000, 900, 400]] };
  const c = cursorAt(data, 0, 0.5);
  assert.ok(Math.abs(c.x - 0.5) < 1e-9 && Math.abs(c.y - 0.5) < 1e-9);
  const still = { display: data.display, points: Array.from({ length: 200 }, (_, i) => [i * 33, i < 100 ? 200 : 800, 250]) };
  const acts = autoZoom(still, 0, { in: 0, duration: 6.6, speed: 1 });
  assert.ok(acts.length >= 2 && acts[0].props.scale > 1);
});

// ---------------------------------------------------------------- validation
test('Validate: names and paths can’t escape the project', () => {
  assert.strictEqual(validate.mediaName('../x.mp4'), false);
  assert.strictEqual(validate.mediaName('a/b.mp4'), false);
  assert.strictEqual(validate.mediaName('.hidden'), false);
  assert.strictEqual(validate.mediaName('rec-1-screen.mp4'), true);
  assert.strictEqual(validate.fileStem('../../etc/passwd'), 'etc passwd');
  assert.strictEqual(validate.paths(['relative/path']), null);
});

test('Validate: AI jobs are clamped and need a PNG start image', () => {
  const j = validate.aiJob({ prompt: 'a cat', width: 1290, height: 9999, steps: 500, seed: -4, strength: 3 });
  assert.strictEqual(j.width, 1296); assert.strictEqual(j.height, 2048);
  assert.strictEqual(j.steps, 50); assert.strictEqual(j.seed, 0); assert.strictEqual(j.strength, 0.95);
  assert.throws(() => validate.aiJob({ mode: 'img2img', prompt: 'x', image: new Uint8Array([1, 2, 3]) }));
  assert.throws(() => validate.aiJob({ prompt: '   ' }));
});

test('Validate: recording tracks only allow known roles and formats', () => {
  assert.throws(() => validate.recTracks([{ role: 'keylogger', format: 'mp4' }]));
  assert.throws(() => validate.recTracks([{ role: 'mic', format: 'wav', sampleRate: 1, channels: 2 }]));
  assert.deepStrictEqual(validate.recTracks([{ role: 'screen', format: 'mp4', extra: 1 }]), [{ role: 'screen', format: 'mp4' }]);
});

test('Validate: the project file must look like a project', () => {
  assert.throws(() => validate.project({ version: 1, clips: [], media: [{ file: '../../x' }] }));
  assert.throws(() => validate.project([]));
  assert.ok(validate.project(validate.newProject('x')));
});

test('Validate: per-app audio settings and app lists', () => {
  assert.deepStrictEqual(validate.audioRule({ volume: 9, mute: true, eq: [30, -30, 'x'], output: 'BuiltIn' }), { volume: 4, mute: true, eq: [24, -24, 0], strip: [], pan: 0, output: 'BuiltIn' });
  // channel strip: filter kinds, ranges and count are clamped; pan stays within L/R
  const r = validate.audioRule({ pan: -3, strip: [[3, 5, 0, 0.7], [9, 1e6, 99, 50], 'x', [0, 2500, -6, 1.2], [1], [2], [2], [2], [2]] });
  assert.strictEqual(r.pan, -1);
  assert.strictEqual(r.strip.length, 5);
  assert.deepStrictEqual(r.strip[0], [3, 10, 0, 0.7]);
  assert.deepStrictEqual(r.strip[1], [3, 22000, 24, 10]);
  assert.deepStrictEqual(r.strip[2], [0, 2500, -6, 1.2]);
  assert.throws(() => validate.recApps([{ key: '../../evil' }]));
  assert.deepStrictEqual(validate.recApps([{ key: 'com.spotify.client', name: 'Spotify' }]), [{ key: 'com.spotify.client', name: 'Spotify' }]);
  assert.strictEqual(validate.appKey('pid:123'), true);
});

test('MP4: negative frame offsets in a version-0 ctts don’t make a 397-hour file', async () => {
  // B-frame order: I P B B P B B … (presentation timestamps out of decode order)
  const m = new Muxer({ video: { codec: 'avc1.640028', width: 1920, height: 1080, description: AVCC }, audio: null });
  const fps = 30, order = [];
  for (let g = 0; g < 30; g++) { const b = g * 3; order.push(b, b + 2, b + 1); }
  const parts = order.map((f, i) => m.addVideo(new Uint8Array(50).fill(i & 255), { timestamp: (f * 1e6) / fps, duration: 1e6 / fps, key: i % 30 === 0 }));
  const head = m.finish();
  const file = new Uint8Array(head.length + parts.reduce((n, p) => n + p.length, 0));
  file.set(head, 0); let o = head.length; for (const p of parts) { file.set(p, o); o += p.length; }
  // Rewrite ctts as version 0, as Apple's writers do while still storing negative offsets.
  let at = -1;
  for (let i = 0; i < head.length - 4; i++) if (file[i] === 0x63 && file[i + 1] === 0x74 && file[i + 2] === 0x74 && file[i + 3] === 0x73) { at = i; break; }
  assert.ok(at > 0, 'muxer wrote a ctts box');
  file[at + 4] = 0;
  const d = await demux(new BufferReader(file));
  assert.ok(d.duration > 2.9 && d.duration < 3.2, `duration ${d.duration}`);
});

test('Keyframes: values interpolate, hold, and drive the drawn clip', () => {
  const c = M.newCalloutClip('t1', 0);
  M.putKey(c, 'callout.x', 1, 0.2); M.putKey(c, 'callout.x', 3, 0.6);
  assert.strictEqual(M.paramAt(c, 'callout.x', 0), 0.2);          // flat before the first key
  assert.ok(Math.abs(M.paramAt(c, 'callout.x', 2) - 0.4) < 1e-9); // linear in between
  assert.strictEqual(M.paramAt(c, 'callout.x', 9), 0.6);          // flat after the last
  c.keys['callout.x'][0].ease = 'hold';
  assert.strictEqual(M.paramAt(c, 'callout.x', 2.9), 0.2);
  assert.strictEqual(M.animated(c, 3).callout.x, 0.6);
  assert.strictEqual(c.callout.x, 0.5, 'the base value is untouched');
  // once animated, setting a value writes a key at that time
  M.setParam(c, 'callout.x', 2, 0.9);
  assert.strictEqual(c.keys['callout.x'].length, 3);
  M.removeKey(c, 'callout.x', 2); M.removeKey(c, 'callout.x', 1); M.removeKey(c, 'callout.x', 3);
  assert.strictEqual(c.keys, undefined);
});

test('Keyframes: split and trim keep the motion where it was on screen', () => {
  const doc = { tracks: [{ id: 't1' }], clips: [], media: [], markers: [] };
  const c = M.newCalloutClip('t1', 0); c.duration = 4; doc.clips.push(c);
  M.putKey(c, 'callout.x', 0, 0); M.putKey(c, 'callout.x', 4, 1);
  const [id] = M.split(doc, 2, [c.id]);
  const right = doc.clips.find(x => x.id === id);
  assert.ok(Math.abs(M.paramAt(c, 'callout.x', 1) - 0.25) < 1e-9);
  assert.ok(Math.abs(M.paramAt(right, 'callout.x', 0) - 0.5) < 1e-9);
  assert.ok(Math.abs(M.paramAt(right, 'callout.x', 1) - 0.75) < 1e-9);
  M.trim(doc, right, 'start', 3, null);
  assert.ok(Math.abs(M.paramAt(right, 'callout.x', 0) - 0.75) < 1e-9);
});

test('Tracks: volume automation, solo and pan shape the sound', () => {
  const tA = { id: 'a', volume: 1 }, tB = { id: 'b' };
  const doc = { tracks: [tA, tB], clips: [], media: [], markers: [] };
  const c = { id: 'c', type: 'media', track: 'a', start: 0, duration: 10, audio: { volume: 1 } };
  const d = { id: 'd', type: 'media', track: 'b', start: 0, duration: 10, audio: { volume: 1 } };
  doc.clips.push(c, d);
  tA.auto = { volume: [{ t: 0, v: 1, ease: 'linear' }, { t: 4, v: 0.5, ease: 'linear' }] };
  assert.ok(Math.abs(M.gainAt(doc, c, 2) - 0.75) < 1e-9);
  tA.autoMode = 'off'; tA.volume = 0.3;
  assert.ok(Math.abs(M.gainAt(doc, c, 2) - 0.3) < 1e-9);
  tB.solo = true;
  assert.strictEqual(M.gainAt(doc, c, 2), 0);
  assert.strictEqual(M.gainAt(doc, d, 2), 1);
  tB.pan = -0.5; d.audio.pan = -0.2;
  assert.ok(Math.abs(M.panAt(doc, d, 1) + 0.7) < 1e-9);
  assert.deepStrictEqual(M.panGains(0), [1, 1]);
  const [l, r] = M.panGains(-0.5); assert.strictEqual(l, 1); assert.strictEqual(r, 0.5);
  assert.ok(Math.abs(M.posToGain(M.gainToPos(0.5)) - 0.5) < 1e-9);
});

test('Editing: freeze-frame gaps keep every track in sync; locks and groups hold', () => {
  const doc = { tracks: [{ id: 't1' }, { id: 't2' }], clips: [], media: [], markers: [{ id: 'k', t: 5 }] };
  const v = { id: 'v', type: 'media', track: 't1', start: 0, duration: 10, in: 0, speed: 1, props: { ...M.DEFAULT_PROPS }, actions: [] };
  const a = { id: 'a', type: 'media', track: 't2', start: 0, duration: 10, in: 0, speed: 1, props: { ...M.DEFAULT_PROPS }, actions: [] };
  const later = { id: 'l', type: 'text', track: 't2', start: 12, duration: 2, props: { ...M.DEFAULT_PROPS }, actions: [] };
  doc.clips.push(v, a, later);
  M.insertTime(doc, 4, 2);
  const right = id => doc.clips.find(c => c.track === doc.clips.find(x => x.id === id).track && c.start === 6 && c.id !== id);
  assert.strictEqual(v.duration, 4); assert.strictEqual(a.duration, 4);
  assert.strictEqual(right('v').in, 4); assert.strictEqual(right('a').in, 4);
  assert.strictEqual(later.start, 14); assert.strictEqual(doc.markers[0].t, 7);
  // locked clips can't be deleted or split
  v.locked = true;
  M.remove(doc, ['v', 'l'], false);
  assert.ok(doc.clips.some(c => c.id === 'v')); assert.ok(!doc.clips.some(c => c.id === 'l'));
  assert.deepStrictEqual(M.split(doc, 2, ['v']), []);
  // groups select together
  v.group = 'g'; a.group = 'g';
  assert.deepStrictEqual(M.withGroups(doc, ['a']).sort(), ['a', 'v']);
  // SMPTE display
  M.timeFormat.smpte = true; M.timeFormat.fps = 30;
  assert.strictEqual(M.fmtTime(61.5), '01:01:15');
  M.timeFormat.smpte = false;
  assert.strictEqual(M.fmtTime(61.5), '01:01.5');
});

test('Pointer track: clicks, click sounds and the keystroke display', () => {
  const data = { display: { bounds: { x: 0, y: 0, width: 1000, height: 500 } }, points: [[0, 100, 100], [2000, 500, 250]],
    clicks: [[500, 0, 200, 125], [560, 'u', 200, 125], [1500, 1, 400, 200]],
    keys: [[100, '', 'H'], [250, '⇧', 'I'], [3000, '⌘', 'C'], [6000, '', 'SPACE'], [6100, '', 'A']] };
  const p = cursorAt(data, 0, 0.7);
  assert.ok(Math.abs(p.click - 0.2) < 1e-9); assert.strictEqual(p.button, 0); assert.strictEqual(p.pt, 1000);
  assert.strictEqual(cursorAt(data, 0, 1.3).click, null);
  assert.strictEqual(cursorAt(data, 0, 1.6).button, 1);
  assert.deepStrictEqual(clicksBetween(data, 0, 0, 2), [0.5, 1.5]);
  assert.deepStrictEqual(clicksBetween(data, 0.5, 0, 1), [0]);      // offset shifts media time
  assert.strictEqual(keysAt(data, 0, 0.3).text, 'hI');             // typing joins, shift keeps case
  assert.strictEqual(keysAt(data, 0, 3.2).text, '⌘C');             // shortcuts stand alone
  assert.strictEqual(keysAt(data, 0, 2.5), null);                  // nothing shown after the hold
  assert.strictEqual(keysAt(data, 0, 6.2, { modsOnly: true }), null);
  assert.strictEqual(keysAt(data, 0, 6.2).text, ' a');
  const cs = clickSample(48000);
  assert.ok(cs.length > 1000 && Math.max(...cs.map(Math.abs)) < 1.2 && Math.abs(cs[cs.length - 1]) < 0.02);
});

test('Captions: SRT and WebVTT round trip, tags dropped, and time inserts move them', () => {
  const srt = '1\r\n00:00:01,500 --> 00:00:03,000\r\nHello <i>there</i>\r\n\r\n2\r\n00:01:02,250 --> 00:01:04,000\r\nTwo lines\r\nof text\r\n';
  const caps = M.parseCaptions(srt);
  assert.strictEqual(caps.length, 2);
  assert.deepStrictEqual([caps[0].t, caps[0].end, caps[0].text], [1.5, 3, 'Hello there']);
  assert.strictEqual(caps[1].text, 'Two lines\nof text');
  const back = M.parseCaptions(M.toSRT(caps));
  assert.deepStrictEqual(back.map(c => [c.t, c.end, c.text]), caps.map(c => [c.t, c.end, c.text]));
  const vtt = M.toVTT(caps);
  assert.ok(vtt.startsWith('WEBVTT') && vtt.includes('00:01:02.250 --> 00:01:04.000'));
  assert.deepStrictEqual(M.parseCaptions(vtt).map(c => c.t), [1.5, 62.25]);
  assert.strictEqual(M.parseCaptions('WEBVTT\n\n00:05.000 --> 00:06.000\nShort form').at(0).t, 5);
  const doc = { tracks: [{ id: 't' }], clips: [], media: [], markers: [], captions: caps };
  M.insertTime(doc, 2, 1);
  assert.deepStrictEqual([caps[0].t, caps[0].end], [1.5, 4]);   // spans the gap: grows
  assert.deepStrictEqual([caps[1].t, caps[1].end], [63.25, 65]); // after: moves
  assert.strictEqual(M.captionAt(doc, 3.9).text, 'Hello there');
});

test('Filters: .cube LUTs load in the shader layout; stacks add up; bypass works', async () => {
  const { parseCube, filterParams, needsGl } = await import('../app/renderer/lib/glfx.js');
  // identity LUT, size 2, red fastest
  let txt = 'TITLE "id"\nLUT_3D_SIZE 2\n';
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) txt += `${r} ${g} ${b}\n`;
  const L = parseCube(txt);
  assert.strictEqual(L.size, 2);
  const at = (r, g, b) => { const i = ((g * 4) + b * 2 + r) * 3; return [...L.data2d.slice(i, i + 3)]; };
  assert.deepStrictEqual(at(1, 0, 0), [255, 0, 0]);
  assert.deepStrictEqual(at(0, 1, 1), [0, 255, 255]);
  assert.throws(() => parseCube('LUT_1D_SIZE 4\n0 0 0'));
  const u = filterParams([{ type: 'color', exposure: 0.5 }, { type: 'color', exposure: 0.25, off: true }, { type: 'look', look: 'warm', amount: 0.5 }, { type: 'blur', amount: 6 }]);
  assert.strictEqual(u.exposure, 0.5); assert.ok(Math.abs(u.temperature - 0.175) < 1e-9); assert.strictEqual(u.blur, 6);
  assert.ok(needsGl(u, false));
  assert.ok(!needsGl(filterParams([{ type: 'blur', amount: 4 }]), false)); // blur alone stays on the 2D canvas
  assert.ok(needsGl(filterParams([]), true)); // a matte needs the GPU pass
});

test('Gaps, ripple ranges and rolling edits', () => {
  const mk = (id, track, start, duration, extra = {}) => ({ id, type: 'media', media: 'm', track, start, duration, in: 0, speed: 1, props: {}, actions: [], ...extra });
  const doc = { tracks: [{ id: 'a' }, { id: 'b' }], media: [{ id: 'm', kind: 'video', duration: 100 }], markers: [{ t: 9 }], captions: [{ t: 9, end: 10, text: 'x' }],
    clips: [mk('1', 'a', 0, 4), mk('2', 'a', 6, 4), mk('3', 'b', 1, 2), mk('4', 'b', 8, 2)] };
  // a gap on one track only
  assert.deepStrictEqual(M.gapAt(doc, 5, 'a'), { a: 4, b: 6 });
  assert.deepStrictEqual(M.gapAt(doc, 5, null), { a: 4, b: 6 });
  assert.strictEqual(M.closeGap(doc, 5, 'a'), 2);
  assert.strictEqual(doc.clips.find(c => c.id === '2').start, 4);
  assert.strictEqual(doc.clips.find(c => c.id === '4').start, 8, 'other tracks stay');
  assert.strictEqual(doc.markers[0].t, 9, 'single-track close leaves markers');
  // every gap on track b
  assert.strictEqual(M.closeAllGaps(doc, 'b'), 6);
  assert.deepStrictEqual(doc.clips.filter(c => c.track === 'b').map(c => c.start), [0, 2]);
  // remove 1..3 across all tracks
  const d2 = { tracks: [{ id: 'a' }], media: doc.media, markers: [{ t: 2 }, { t: 5 }], captions: [{ t: 4, end: 5, text: 'y' }], clips: [mk('x', 'a', 0, 6)] };
  assert.strictEqual(M.removeRange(d2, 1, 3), 2);
  assert.deepStrictEqual(d2.clips.map(c => [c.start, c.duration, c.in]).sort((p, q) => p[0] - q[0]), [[0, 1, 0], [1, 3, 3]]);
  assert.deepStrictEqual(d2.markers.map(m => m.t), [3]);
  assert.deepStrictEqual([d2.captions[0].t, d2.captions[0].end], [2, 3]);
  // rolling edit
  const d3 = { tracks: [{ id: 'a' }], media: doc.media, clips: [mk('l', 'a', 0, 5), mk('r', 'a', 5, 5, { in: 10 })] };
  const [l, r] = d3.clips;
  assert.strictEqual(M.neighbour(d3, l, 'end'), r);
  assert.strictEqual(M.roll(d3, l, r, 6), 6);
  assert.deepStrictEqual([l.duration, r.start, r.duration, r.in], [6, 6, 4, 11]);
  M.roll(d3, l, r, -50); // can't go past the left clip's start
  assert.ok(l.duration >= 0.05 && Math.abs(r.start - l.duration) < 1e-9);
});

test('Console: fader law, strip EQ and system-sound filter', async () => {
  globalThis.document ||= undefined;
  const { faderDb, faderPos, stripFilters, stripVolume, STRIP_DEFAULT, isSystemSound } = await import('../app/renderer/mixer.js');
  for (const db of [-60, -40, -20, -10, -5, 0, 5, 10]) assert.ok(Math.abs(faderDb(faderPos(db)) - db) < 1e-6, `round trip ${db}`);
  assert.strictEqual(faderDb(0), -Infinity); assert.ok(Math.abs(faderPos(0) - 0.78) < 1e-9);
  for (let p = 0.01; p < 1; p += 0.01) assert.ok(faderDb(p) < faderDb(p + 0.01), 'monotonic');
  assert.deepStrictEqual(stripFilters({ ...STRIP_DEFAULT, eqIn: false }), []);
  const f = stripFilters({ ...STRIP_DEFAULT, hpf: 80, hf: 3 });
  assert.deepStrictEqual(f.map(x => x[0]), [3, 1, 0, 0, 2]);
  assert.strictEqual(stripVolume({ trim: 12, fader: 10 }), 4); // capped at +12 dB
  assert.ok(Math.abs(stripVolume({ trim: 0, fader: 0 }) - 1) < 1e-9);
  assert.ok(isSystemSound({ key: 'com.apple.audiomxd', name: 'com.apple.audiomxd' }));
  assert.ok(isSystemSound({ key: 'com.github.Electron.helper', name: 'com.github.Electron.helper' }));
  assert.ok(!isSystemSound({ key: 'com.apple.Music', name: 'Music', icon: 'x' }));
  assert.ok(!isSystemSound({ key: 'com.spotify.client', name: 'Spotify', icon: 'x' }));
});
