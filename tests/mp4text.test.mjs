// Chapters and captions inside the movie (1.15): the editor's muxer writes them, and a finished movie (the Rust
// core's, from the Mac's encoder) gets them added at its end. The pictures and sound stay exactly as they were.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as mp4 from '../app/renderer/lib/mp4.js';
const require = createRequire(import.meta.url);
const { addTextTracks } = require('../app/engine/mp4text.js');

const AVCC = Uint8Array.from([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80]);
const ASC = Uint8Array.from([0x11, 0x90]);
const TEXT = { dur: 3, chapters: [{ t: 1, title: 'Second part' }, { t: 2.25, title: 'Ünïcode — end' }], captions: [{ t: 0.5, end: 1.5, text: 'Hello' }, { t: 1.2, end: 2, text: 'Overlaps' }, { t: 2.5, end: 9, text: 'Runs past' }] };

function build(text) {
  const m = new mp4.Muxer({ video: { codec: 'avc1.640028', width: 1920, height: 1080, description: AVCC }, audio: { codec: 'mp4a.40.2', sampleRate: 48000, channels: 2, description: ASC } });
  const parts = [];
  let a = 0;
  for (let i = 0; i < 90; i++) {
    parts.push(m.addVideo(new Uint8Array(100 + (i % 7)).fill(i & 255), { timestamp: (i * 1e6) / 30, duration: 1e6 / 30, key: i % 30 === 0 }));
    while (a * 1024 / 48000 <= (i + 1) / 30) { parts.push(m.addAudio(new Uint8Array(20).fill(a & 255), { timestamp: (a * 1024 * 1e6) / 48000, duration: (1024 * 1e6) / 48000, key: true })); a++; }
  }
  if (text) parts.push(m.addText(text));
  return Buffer.concat([m.finish(), ...parts]);
}
/** each track's samples' bytes, as the editor reads the file */
async function samples(buf) {
  const d = await mp4.demux(new mp4.BufferReader(buf));
  return d.tracks.map(t => t.kind + ':' + t.samples.map(s => Buffer.from(buf.subarray(s.offset, s.offset + s.size)).toString('hex')).join(','));
}
/** the Nero chapters: [[ms, title]] */
function chpl(buf) {
  const i = buf.indexOf('chpl'), n = buf[i + 12];
  const out = []; let p = i + 13;
  for (let k = 0; k < n; k++) { const t = Number(buf.readBigUInt64BE(p)) / 10000, l = buf[p + 8]; out.push([t, buf.toString('utf8', p + 9, p + 9 + l)]); p += 9 + l; }
  return out;
}
const WANT = [[0, 'Intro'], [1000, 'Second part'], [2250, 'Ünïcode — end']];
let ffprobe = true; try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); } catch { ffprobe = false; }
function probe(file) {
  const ch = JSON.parse(execFileSync('ffprobe', ['-v', 'quiet', '-show_chapters', '-show_streams', '-of', 'json', file]).toString());
  const srt = path.join(path.dirname(file), 'out.srt');
  execFileSync('ffmpeg', ['-v', 'quiet', '-y', '-i', file, '-map', '0:s', srt], { stdio: 'ignore' });
  return { chapters: ch.chapters.map(c => [Math.round(c.start_time * 1000), c.tags.title]), kinds: ch.streams.map(s => s.codec_type), srt: fs.readFileSync(srt, 'utf8') };
}
const SRT = '1\n00:00:00,500 --> 00:00:01,200\nHello\n\n2\n00:00:01,200 --> 00:00:02,000\nOverlaps\n\n3\n00:00:02,500 --> 00:00:03,000\nRuns past\n';

test('the editor’s muxer puts chapters and captions in the movie, the pictures and sound as they were', async () => {
  const plain = build(null), withText = build(TEXT);
  assert.deepEqual((await samples(withText)).slice(0, 2), await samples(plain));
  assert.deepEqual(chpl(withText), WANT);
  assert.equal(mp4.textSamples({ dur: 3 }).chap, null, 'none: nothing added');
  assert.equal(build({ dur: 3, chapters: [], captions: [] }).length, plain.length);
});

test('a finished movie gets them added at its end, and plays at every step', { skip: !ffprobe && 'ffprobe for the full check' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-text-'));
  try {
    for (const [name, buf] of [['muxed', build(TEXT)], ['added', build(null)]]) {
      const f = path.join(dir, name + '.mp4');
      fs.writeFileSync(f, buf);
      if (name === 'added') assert.equal(addTextTracks(f, TEXT, mp4), true);
      const out = fs.readFileSync(f);
      assert.deepEqual((await samples(out)).slice(0, 2), await samples(build(null)), name + ': pictures and sound unchanged');
      const p = probe(f);
      assert.deepEqual(p.chapters, WANT, name);
      assert.deepEqual(p.kinds, ['video', 'audio', 'data', 'subtitle'], name);
      assert.equal(p.srt.trim(), SRT.trim(), name);
    }
    // nothing to add, or a half-written file: left alone
    const f = path.join(dir, 'x.mp4'); fs.writeFileSync(f, build(null));
    assert.equal(addTextTracks(f, { dur: 3 }, mp4), false);
    fs.appendFileSync(f, Buffer.from([0, 0, 0, 40, 0x6d, 0x64]));
    const before = fs.readFileSync(f);
    assert.equal(addTextTracks(f, TEXT, mp4), false);
    assert.deepEqual(fs.readFileSync(f), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a movie saved as .mov or .m4v says so in its file type, nothing else moving', { skip: !ffprobe && 'ffprobe for the full check' }, async () => {
  const { setBrand } = require('../app/engine/mp4text.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-brand-'));
  try {
    for (const kind of ['mov', 'm4v']) {
      const f = path.join(dir, 'x.' + kind);
      fs.writeFileSync(f, build(TEXT));
      const before = fs.readFileSync(f);
      assert.equal(setBrand(f, kind), true);
      const after = fs.readFileSync(f);
      assert.equal(after.length, before.length);
      assert.deepEqual(after.subarray(32), before.subarray(32), 'only the first box changed');
      assert.equal(after.toString('latin1', 8, 12), kind === 'mov' ? 'qt  ' : 'M4V ');
      assert.deepEqual((await samples(after)).slice(0, 2), await samples(build(null)));
      const fmt = JSON.parse(execFileSync('ffprobe', ['-v', 'quiet', '-show_format', '-show_chapters', '-of', 'json', f]).toString());
      assert.equal(fmt.format.tags.major_brand.trim(), kind === 'mov' ? 'qt' : 'M4V');
      assert.equal(fmt.chapters.length, 3, kind + ': the chapters still read');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
