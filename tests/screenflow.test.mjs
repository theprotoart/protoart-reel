// ScreenFlow import: the readers (SQLite index, plists), the recording codecs (picture blocks against the
// reference decoder, sound Huffman round trip) and the project plan → Reel timeline.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { openSqlite } from '../app/renderer/lib/sqlite-lite.js';
import { parseBplist } from '../app/renderer/lib/bplist.js';
import { decodeTile, decodeAudioPacket } from '../app/renderer/lib/scc.js';
import { planScreenflow, fontFromPostScript } from '../app/renderer/lib/screenflow.js';
import { placeScreenflow } from '../app/renderer/screenflow-import.js';

const here = new URL('.', import.meta.url).pathname;

test('SQLite reader walks a multi-page table', () => {
  const db = openSqlite(new Uint8Array(fs.readFileSync(here + 'fixture-index.sqlite')));
  const rows = db.tables.blob.objects();
  assert.equal(rows.length, 300);
  assert.deepEqual(rows[7], { hostTime: 11168045541 + 7 * 16667, sampleTime: 7, streamID: 1, offset: 700, nbytes: 57, name: 'frame 7' });
});


test('binary plist: dictionaries, arrays, numbers, strings, UIDs', () => {
  const v = parseBplist(Uint8Array.from(Buffer.from('62706c6973743030d3010203040809516151625175a3050607100123400400000000000062006800e9098003080f111315191b24292a0000000000000101000000000000000a0000000000000000000000000000002c', 'hex')));
  assert.deepEqual(v, { a: [1, 2.5, 'hé'], b: true, u: { $uid: 3 } });
});

test('picture: 8×8 and 4×4 transform blocks match the reference decoder', () => {
  const f = JSON.parse(fs.readFileSync(here + 'fixtures-vv.json', 'utf8'));
  assert.deepEqual(Array.from(decodeTile(Uint8Array.from(f.coef8), 7, true)), f.out8);
  assert.deepEqual(Array.from(decodeTile(Uint8Array.from(f.coef4), 7, false)), f.out4);
});

/** A canonical Huffman encoder in the recording's packet layout, to round-trip the decoder. */
function encodePacket(bytes) {
  const freq = new Array(256).fill(1); for (const b of bytes) freq[b]++;
  // code lengths from a Huffman tree, capped at 15
  let nodes = freq.map((f, s) => ({ f, s }));
  while (nodes.length > 1) { nodes.sort((a, b) => a.f - b.f); const [a, b] = nodes.splice(0, 2); nodes.push({ f: a.f + b.f, kids: [a, b] }); }
  const lens = new Array(256).fill(0);
  (function walk(n, d) { if (n.kids) n.kids.forEach(k => walk(k, d + 1)); else lens[n.s] = Math.max(1, d); })(nodes[0], 0);
  assert.ok(Math.max(...lens) <= 16);
  const codes = new Array(256); let code = 0;
  for (let L = 1; L <= 16; L++) { for (let s = 0; s < 256; s++) if (lens[s] === L) codes[s] = code++; code <<= 1; }
  const bits = [];
  const put = (v, n) => { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); }; // LSB first
  const rev5 = v => ((v & 1) << 4) | ((v & 2) << 2) | (v & 4) | ((v & 8) >> 2) | ((v & 16) >> 4);
  for (let s = 0; s < 256; s++) put(rev5(lens[s]), 5);
  put(rev5(0), 5);
  for (const b of bytes) for (let i = lens[b] - 1; i >= 0; i--) bits.push((codes[b] >> i) & 1); // code MSB first
  const body = new Uint8Array(Math.ceil(bits.length / 8)); bits.forEach((v, i) => { body[i >> 3] |= v << (i & 7); });
  const out = new Uint8Array(9 + body.length + 4); out[0] = 0x48;
  new DataView(out.buffer).setUint32(1, bytes.length, true); new DataView(out.buffer).setUint32(5, bytes.length / 4, true);
  out.set(body, 9);
  return out;
}

test('sound: the packet Huffman decoder round-trips 16-bit PCM', () => {
  const pcm = new Int16Array(4410 * 2);
  for (let i = 0; i < 4410; i++) { pcm[2 * i] = Math.round(3000 * Math.sin(i / 7)); pcm[2 * i + 1] = Math.round(800 * Math.sin(i / 3)); }
  const back = decodeAudioPacket(encodePacket(new Uint8Array(pcm.buffer)));
  assert.equal(back.length, pcm.length);
  assert.deepEqual(Array.from(back.slice(0, 50)), Array.from(pcm.slice(0, 50)));
  assert.ok(back.every((v, i) => v === pcm[i]));
});

test('font names: PostScript names become family, weight and italic', () => {
  assert.deepEqual(fontFromPostScript('GillSans'), { family: 'Gill Sans', weight: 400, italic: false });
  assert.deepEqual(fontFromPostScript('HelveticaNeue-BoldItalic'), { family: 'Helvetica Neue', weight: 700, italic: true });
});

/** A small ScreenFlow-like project: two screen clips crossfading, a mic clip, a title, a callout and a zoom. */
function fakeDoc() {
  const o = [];
  const add = (id, entity, a, rel = {}) => o.push([id, { id, entity, a, rel }]);
  add(1, 'MediaSource', { type: 'screen', prettyName: 'Screen', filePath: '/x/p.screenflow/Media/r.scc', clutchVideoStreamID: 1, clutchAudioStreamID: 0, hasVideo: 1, videoWidth: 3840, videoHeight: 2160 });
  add(2, 'MediaSource', { type: 'camera', prettyName: 'Mic', filePath: '/x/p.screenflow/Media/r.scc', clutchAudioStreamID: 2, clutchVideoStreamID: 0, hasAudio: 1 });
  add(3, 'MediaSource', { type: 'text', prettyName: 'Text' });
  const clip = (a) => ({ alpha: 1, scaleX: 0.5, speed: 1, enabled: 1, volume: 1, contentsRectData: '[-1 -1 1 1]', inPoint: 0, ...a });
  add(10, 'ScreenMediaClip', clip({ startTime: 0, duration: 3000, zorder: 0, showMouseCursor: 1 }), { source: [1], actions: [20, 21], transitions: [30] });
  add(11, 'ScreenMediaClip', clip({ startTime: 2400, duration: 3000, zorder: 0, showMouseCursor: 1 }), { source: [1], transitions: [30] });
  add(12, 'MediaClip', clip({ startTime: 0, duration: 5400, zorder: 1, scaleX: 1 }), { source: [2], audioMix: [40] });
  add(13, 'TextClip', clip({ startTime: 600, duration: 1200, zorder: 2, scaleX: 1, positionX: 0.25, positionY: 0.25, contentSizeAsString: '{490, 112}',
    textString: { NSString: 'Hello', NSAttributes: { NSFont: { NSName: 'GillSans-Bold', NSSize: 96 }, NSParagraphStyle: { NSAlignment: 2 } } } }), { source: [3] });
  add(20, 'CalloutAction', { startTime: 300, duration: 600, alpha: 0.75, zoomUp: 2, highlightType: 'freehand', drawStream: { operations: [{ what: 1, additive: true, where: '{{960, 540}, {1920, 1080}}' }] } });
  add(21, 'VideoAction', { startTime: 1500, duration: 300, scaleX: 1, positionX: 0.1, positionY: 0, alpha: 1 });
  add(30, 'Transition', { provider: { SCTransitionProviderInternalName: 'SCTransitionFade' } }, { clips: [10, 11] });
  add(40, 'AudioChannelsMix', {}, { channels: [41, 42] });
  add(41, 'AudioChannelMix', { gain: 1, pan: 0.5, hidden: 0 });
  add(42, 'AudioChannelMix', { gain: 1, pan: 0.5, hidden: 1 });
  add(50, 'Marker', { startTime: 1500, name: 'Chapter' });
  return { timeScale: 600, canvas: { w: 1920, h: 1080 }, objects: new Map(o) };
}

test('plan: tracks by z-order, crossfade lane, transforms, text, callout, zoom, channel mix', () => {
  const p = planScreenflow(fakeDoc());
  assert.deepEqual(p.tracks.map(t => [t.z, t.lane]), [[2, 0], [1, 0], [0, 1], [0, 0]]);
  const [a, b] = p.clips.filter(c => c.entity === 'ScreenMediaClip').sort((x, y) => x.start - y.start);
  assert.equal(a.props.scale, 1); // 4K at 50 % in a 1080p canvas fills it, as Reel's scale 1 does
  assert.ok(Math.abs(b.transIn.dur - 1) < 1e-9 && b.transIn.type === 'fade' && b.lane === 1);
  const t = p.clips.find(c => c.entity === 'TextClip');
  assert.equal(t.text.font, 'Gill Sans'); assert.equal(t.text.weight, 700); assert.equal(t.props.x, 0.75); assert.equal(t.props.y, 0.25);
  const mic = p.clips.find(c => c.entity === 'MediaClip');
  assert.deepEqual(mic.audio.channels.map(c => c.on), [true, false]);
  assert.equal(a.actions.length, 2);
  assert.equal(p.markers[0].t, 2.5);
});

test('place: the plan becomes Reel tracks and clips, callouts on top, zoom as keyframes', () => {
  const plan = planScreenflow(fakeDoc());
  const media = new Map([[1, { picture: { file: 'r.mp4', name: 'Screen', kind: 'video', duration: 5, width: 3840, height: 2160, cursor: 'r-cursor.json' }, sound: null }],
    [2, { picture: null, sound: { file: 'r.wav', name: 'Mic', kind: 'audio', duration: 9 } }]]);
  const doc = { canvas: { width: 1280, height: 720 }, media: [], clips: [], tracks: [], markers: [] };
  const sum = placeScreenflow(doc, { plan, media, cursors: new Map() }, null);
  assert.equal(sum.placed, 4); assert.equal(sum.callouts, 1);
  assert.deepEqual([doc.canvas.width, doc.canvas.height], [1920, 1080]);
  assert.equal(doc.tracks[0].name, 'Callouts');
  const co = doc.clips.find(c => c.type === 'callout');
  assert.ok(Math.abs(co.callout.x - 0.5) < 1e-9 && Math.abs(co.callout.w - 0.5) < 1e-9 && co.callout.zoom === 2 && co.start === 0.5);
  assert.equal(co.callout.shape, 'rect'); // drawn with the square
  const scr = doc.clips.filter(c => c.type === 'media' && c.media === doc.media.find(m => m.file === 'r.mp4').id);
  assert.equal(scr.length, 2); assert.ok(scr[0].cursor && scr[0].cursor.show);
  assert.ok(scr.some(c => c.keys && c.keys.x && c.keys.x.length === 2));
  assert.equal(doc.markers[0].label, 'Chapter');
  assert.ok(!doc.tracks.some(t => /overlap/.test(t.name)), 'cross-transitions stay on one track');
});
