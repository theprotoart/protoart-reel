// A video export drawn by the Rust core (reel-core 1.10 vexport): the plan (lib/videoplan.js), and the whole chain
// (engine/videoexport.js), with ffmpeg standing in for the Mac's decoder and encoder helpers. Every frame the chain
// draws must be the frame the core's own frame job draws from the same pictures. Needs a reel-core of this source's
// version and ffmpeg; skipped where either is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { videoJob } from '../app/renderer/lib/videoplan.js';
import { framePlan, encodeFrame } from '../app/renderer/lib/frameplan.js';

const require = createRequire(import.meta.url);
const core = require('../app/engine/core.js');
const { videoExport } = require('../app/engine/videoexport.js');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const want = fs.readFileSync(path.join(root, 'native/reel-core/Cargo.toml'), 'utf8').match(/^version = "([^"]+)"/m)[1];
const bin = [process.env.REEL_CORE, path.join(root, 'native/reel-core/target/release/reel-core')].find(p => p && fs.existsSync(p));
if (bin) core.useBinary(bin);
const have = bin ? await core.version() : null;
let ffmpeg = null;
// (by its full path: the helpers run with a bare PATH, as the app runs them)
const which = n => { try { return execFileSync('sh', ['-c', `command -v ${n}`], { encoding: 'utf8' }).trim() || null; } catch { return null; } };
ffmpeg = which('ffmpeg');
const ffprobe = which('ffprobe');
if (!ffprobe) ffmpeg = null;
const skip = have !== want ? 'needs this source’s reel-core (build it with cargo)' : !ffmpeg ? 'needs ffmpeg to stand in for the Mac helpers' : false;

const props = o => ({ x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, crop: [0, 0, 0, 0], ...o });
const clip = (id, media, track, start, duration, p = {}, extra = {}) => ({ id, type: 'media', media, track, start, duration, in: 0, speed: 1, props: props(p), transIn: { type: 'none', dur: 0.5 }, transOut: { type: 'none', dur: 0.5 }, ...extra });
const docOf = clips => ({ canvas: { width: 320, height: 180, background: '#102030' }, media: [{ id: 'a', kind: 'video', file: 'a.mp4', width: 640, height: 360 }, { id: 'b', kind: 'video', file: 'b.mp4', width: 320, height: 240 }],
  tracks: [{ id: 't2' }, { id: 't1' }], clips });

test('a video export plan: each clip read once at the size it needs, or why not', () => {
  const doc = docOf([clip('c1', 'a', 't1', 0, 2, { scale: 0.5 }), clip('c2', 'b', 't2', 1, 1, { scale: 0.4, x: 0.75, y: 0.7, radius: 12 })]);
  const j = videoJob(doc, 0, 2, 320, 180, 10);
  assert.equal(j.frames, 20);
  assert.equal(j.sources.length, 2);
  const [a, b] = j.sources;
  assert.deepEqual([a.clip, a.file, a.w, a.h], ['c1', 'a.mp4', 168, 94], 'the 640×360 video shown at half of 320 wide: read at about 160');
  assert.ok(b.from >= 0 && b.to > b.from && b.w <= 320);
  // titles: the editor draws them over the frames they're on (1.12), the rest is the core's alone
  const t = videoJob({ ...doc, clips: [...doc.clips, { id: 'x', type: 'text', track: 't2', start: 1.5, duration: 0.2, props: props() }] }, 0, 2, 320, 180, 10);
  assert.ok(!t.why, t.why);
  assert.deepEqual(t.overlays, [15, 16]);
  assert.deepEqual(j.overlays, []);
  // a still picture is a source of its own (the decoder gives its one frame)
  const pic = videoJob({ ...doc, media: [...doc.media, { id: 'p', kind: 'image', file: 'logo.png', width: 400, height: 200 }], clips: [...doc.clips, { ...clip('c3', 'p', 't2', 0, 2, { scale: 0.3, x: 0.2, y: 0.2 }) }] }, 0, 2, 320, 180, 10);
  assert.ok(!pic.why, pic.why);
  assert.ok(pic.sources.some(s => s.file === 'logo.png' && s.w <= 400));
  assert.match(videoJob({ ...doc, media: [...doc.media, { id: 'g', kind: 'image', file: 'a.gif', width: 40, height: 40 }], clips: [clip('c4', 'g', 't1', 0, 2)] }, 0, 2, 320, 180, 10).why, /GIF/);
  // a vertigo ramp on the way in (1.14): it reads the picture, so those frames are the editor's, drawn whole; the
  // rest stays the core's
  const g = videoJob(docOf([{ ...clip('c1', 'a', 't1', 0, 2), transIn: { type: 'vertigo', dur: 0.5 } }]), 0, 2, 320, 180, 10);
  assert.ok(!g.why, g.why);
  assert.ok(g.whole.length >= 3 && g.whole.every(i => i < 5), `the half second of the ramp (${g.whole})`);
  assert.deepEqual(g.overlays, g.whole);
  assert.deepEqual(g.wholeWhy, ['a vertigo ramp']);
  // mostly the editor's: the usual export instead
  assert.match(videoJob(docOf([{ ...clip('c1', 'a', 't1', 0, 2), transIn: { type: 'vertigo', dur: 1.8 } }]), 0, 2, 320, 180, 10).why, /vertigo/);
  // a glitch, a light leak, a radial shutter (1.14): drawn by the core itself, as ink after the clip
  for (const type of ['glitch', 'light-leak', 'film-burn', 'shutter', 'flare-sweep', 'letterbox', 'fast-wipe', 'film-burn-vintage']) {
    // (a fast wipe rides on a crossfade between two clips)
    const j = videoJob(docOf([{ ...clip('c1', 'a', 't1', 0, 2), transIn: { type, dur: 0.5 }, ...(type === 'fast-wipe' ? { xfadeIn: 1 } : {}) }]), 0, 2, 320, 180, 10);
    assert.ok(!j.why && !j.whole.length, `${type}: ${j.why || j.whole}`);
    assert.equal(j.core, 14, `${type} needs the 1.14 core`);
  }
  // played backwards: a decoder reads forwards only
  const back = videoJob(docOf([clip('c1', 'a', 't1', 0, 2, {}, { retime: [{ t: 0, s: 2 }, { t: 2, s: 0 }] })]), 0, 2, 320, 180, 10);
  assert.ok(back.why == null || /backwards/.test(back.why));
});

test('pointer effects go to the core as ink layers (and a magnifier picture), given the recorded pointer', () => {
  const fx = { cursor: { spotlight: true, highlight: true, magnify: true, clickStyle: 'ripple' } };
  const doc = docOf([clip('c1', 'a', 't1', 0, 2, { scale: 0.8 }, fx)]);
  doc.media[0].cursor = 'a.json';
  assert.match(framePlan(doc, 1, 320, 180).why, /pointer/, 'without the recorded pointer: the editor draws it');
  const cur = { x: 0.5, y: 0.5, pt: 1440, click: 0.2, button: 0 };
  const p = framePlan(doc, 1, 320, 180, undefined, () => cur);
  assert.ok(!p.why, p.why);
  assert.deepEqual(p.layers.map(l => l.ink ? 'ink' : l.look ? 'lens' : 'picture'), ['picture', 'ink', 'lens', 'ink']);
  assert.deepEqual(p.layers[3].ink.shapes.map(s => s.kind), ['grad', 'ring', 'ring']);
  const j = videoJob(doc, 0, 2, 320, 180, 10, { cursor: () => cur });
  assert.ok(!j.why, j.why);
  assert.equal(j.sources.length, 1, 'the magnifier reads the same video');
  const none = framePlan(doc, 1, 320, 180, undefined, () => null);
  assert.equal(none.layers.length, 1, 'no pointer then: no effects, as the editor');
  doc.clips[0].props.border = 4;
  assert.match(framePlan(doc, 1, 320, 180, undefined, () => cur).why, /pointer/);
});

test('the Rust core draws a whole export, frame for frame as its frame job does', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vexp-'));
  try {
    // two test videos and a sound
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=3', '-pix_fmt', 'yuv420p', path.join(dir, 'a.mp4')]);
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'mandelbrot=s=320x240:r=30', '-t', '3', '-pix_fmt', 'yuv420p', path.join(dir, 'b.mp4')]);
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-ar', '48000', '-ac', '2', path.join(dir, 'mix.wav')]);
    // ffmpeg in the helpers' places: the decoder writes time + BGRA per frame, the encoder keeps the raw frames too
    const fakeFrames = path.join(dir, 'reel-frames'), fakeEncode = path.join(dir, 'reel-encode');
    fs.writeFileSync(fakeFrames, `#!${process.execPath}
const { spawn, execFileSync } = require('child_process');
const [, , mode, file, from, to, w, h] = process.argv;
if (mode !== '--rgba') process.exit(2);
const r = execFileSync('${ffprobe}', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', file]).toString().trim().split('/');
const fps = r[0] / (r[1] || 1), first = Math.max(0, Math.floor((+from - 0.5) * fps));
const f = spawn('${ffmpeg}', ['-v', 'error', '-i', file, '-vf', 'select=gte(n\\\\,' + first + '),scale=' + w + ':' + h + ':flags=area,format=bgra', '-vsync', '0', '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
const size = w * h * 4; let buf = Buffer.alloc(0), n = first;
process.stdout.on('error', () => process.exit(0));
f.stdout.on('data', d => { buf = Buffer.concat([buf, d]); while (buf.length >= size) { const t = Buffer.alloc(8); t.writeDoubleLE(n++ / fps); if (!process.stdout.write(Buffer.concat([t, buf.subarray(0, size)]))) f.stdout.pause(); buf = buf.subarray(size); if (n / fps > +to + 0.25) { f.kill(); process.stdout.end(() => process.exit(0)); return; } } });
process.stdout.on('drain', () => f.stdout.resume());
f.on('close', () => process.stdout.end(() => process.exit(0)));
`, { mode: 0o755 });
    fs.writeFileSync(fakeEncode, `#!${process.execPath}
const { spawn } = require('child_process'); const fs = require('fs');
const [, , out, w, h, fps, codec, vbr, abr, sound] = process.argv;
const args = ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', w + 'x' + h, '-r', fps, '-i', '-'];
if (sound !== '-') args.push('-i', sound);
args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-b:v', vbr);
if (sound !== '-') args.push('-c:a', 'aac', '-b:a', abr, '-shortest');
args.push(out);
const f = spawn('${ffmpeg}', args, { stdio: ['pipe', 'ignore', 'inherit'] });
const raw = fs.createWriteStream(out + '.raw');
process.stdin.on('data', d => { raw.write(d); if (!f.stdin.write(d)) { process.stdin.pause(); f.stdin.once('drain', () => process.stdin.resume()); } });
process.stdin.on('end', () => { raw.end(); f.stdin.end(); });
f.on('close', c => process.exit(c));
`, { mode: 0o755 });

    const W = 320, H = 180, fps = 10;
    const doc = docOf([
      clip('c1', 'a', 't1', 0, 2, { scale: 1.3, x: 0.45 }, { cursor: { spotlight: true, spotSize: 60, highlight: true, magnify: true, lensSize: 30, clickStyle: 'ripple' } }),
      clip('c2', 'b', 't2', 0.5, 1.2, { scale: 0.4, x: 0.75, y: 0.7, radius: 12, border: 3, shadow: 10, opacity: 0.9 }, { in: 0.7 }),
      // a title: the editor draws it, the core lays it over (1.12)
      { id: 'tt', type: 'text', track: 't2', start: 0.65, duration: 0.5, props: props(), text: { content: 'Hi' } },
    ]);
    doc.media[0].cursor = 'a.json';
    // the pointer drifting right, a click at 1 s (pointer effects, 1.11)
    const cursor = (c, st) => c.id === 'c1' ? { x: 0.3 + st * 0.15, y: 0.45, pt: 1440, click: st >= 1 && st < 1.6 ? st - 1 : null, button: 0 } : null;
    const job = videoJob(doc, 0, 2, W, H, fps, { cursor });
    assert.ok(!job.why, job.why);
    assert.ok(job.ink);
    assert.deepEqual(job.overlays, [7, 8, 9, 10, 11]);
    // what the editor would send: a half see-through red square, then the same again
    const square = (() => { const b = Buffer.alloc(4 + 1 + 16 + 12 * 12 * 4); b.writeUInt32LE(1, 0); b[4] = 0; [40, 30, 12, 12].forEach((v, i) => b.writeUInt32LE(v, 5 + i * 4)); for (let i = 0; i < 144; i++) b.set([230, 20, 20, 170], 21 + i * 4); return b; })();
    const again = Buffer.from([255, 255, 255, 255]);
    const out = path.join(dir, 'out.mp4');
    let last = 0;
    const r = await videoExport({ coreBin: bin, framesBin: fakeFrames, encodeBin: fakeEncode, sources: job.sources.map(s => ({ ...s, path: path.join(dir, s.file) })), body: job.body,
      out, w: W, h: H, fps, codec: 'h264', vbr: 2_000_000, abr: 128_000, sound: path.join(dir, 'mix.wav'), onProgress: f => { last = f; },
      overlay: true, onOverlay: w => { (async () => { for (const [k] of job.overlays.entries()) { if (!w.write(k ? again : square)) await new Promise(r => w.once('drain', r)); } w.end(); })(); } });
    assert.equal(r.frames, 20);
    void last;
    const streams = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out]).toString().trim().split('\n');
    assert.deepEqual(streams.sort(), ['audio', 'video'], 'an MP4 with its picture and sound');
    // every frame: the frame job, given the same pictures the decoders gave
    const raw = fs.readFileSync(out + '.raw');
    assert.equal(raw.length, 20 * W * H * 4);
    const decoded = new Map();
    const framesOf = s => {
      if (decoded.has(s.clip)) return decoded.get(s.clip);
      const d = execFileSync(fakeFrames, ['--rgba', path.join(dir, s.file), String(s.from), String(s.to), String(s.w), String(s.h)], { maxBuffer: 1e9 });
      const size = s.w * s.h * 4, list = [];
      for (let o = 0; o + 8 + size <= d.length; o += 8 + size) {
        const px = Buffer.from(d.subarray(o + 8, o + 8 + size));
        for (let i = 0; i < px.length; i += 4) { const b = px[i]; px[i] = px[i + 2]; px[i + 2] = b; }
        list.push({ t: d.readDoubleLE(o), px });
      }
      decoded.set(s.clip, list); return list;
    };
    const at = (list, st) => { let k = 0; while (k + 1 < list.length && list[k + 1].t <= st + 0.5 / 120) k++; return list[k].px; };
    const size = m => { const s = job.sources.find(x => x.file === m.file); return s ? { w: s.w, h: s.h } : { w: m.width, h: m.height }; };
    for (const i of [0, 7, 9, 12, 19]) {
      const t = i / fps, plan = framePlan(doc, t, W, H, size, cursor);
      const ids = [...new Set(plan.layers.filter(l => !l.fill && !l.ink).map(l => l.clip))];
      const pics = ids.map(cid => { const s = job.sources.find(x => x.clip === cid); const l = plan.layers.find(x => x.clip === cid); return { w: s.w, h: s.h, rgba: at(framesOf(s), l.st) }; });
      const plan2 = { ...plan, layers: plan.layers.map(l => (l.fill || l.ink ? l : { ...l, media: l.clip })) };
      const f = path.join(dir, `f${i}.rgba`);
      await core.run(Buffer.concat([Buffer.from('RCORE1\nframe\n'), Buffer.from(encodeFrame(plan2, W, H, ids, pics, f, plan.overlay ? square : null))]));
      const want = fs.readFileSync(f), got = raw.subarray(i * W * H * 4, (i + 1) * W * H * 4);
      let diff = 0;
      for (let p = 0; p < want.length; p += 4) if (want[p] !== got[p + 2] || want[p + 1] !== got[p + 1] || want[p + 2] !== got[p]) diff++;
      assert.equal(diff, 0, `frame ${i}: ${diff} pixels differ`);
    }

    // motion blur (1.13): each frame the average of four moments across half a frame, laid one over another as the
    // editor's export does (each at 1 / (s + 1), in 8 bits)
    const mb = videoJob(doc, 0, 2, W, H, fps, { cursor, samples: 4 });
    assert.ok(!mb.why, mb.why);
    assert.equal(mb.core, 13);
    assert.equal(mb.times.length, 80);
    const out2 = path.join(dir, 'blur.mp4');
    const r2 = await videoExport({ coreBin: bin, framesBin: fakeFrames, encodeBin: fakeEncode, sources: mb.sources.map(s => ({ ...s, path: path.join(dir, s.file) })), body: mb.body,
      out: out2, w: W, h: H, fps, codec: 'h264', vbr: 2_000_000, abr: 128_000, sound: path.join(dir, 'mix.wav'), onProgress: () => {},
      overlay: true, onOverlay: w => { (async () => { for (const [k] of mb.overlays.entries()) { if (!w.write(k ? again : square)) await new Promise(r => w.once('drain', r)); } w.end(); })(); } });
    assert.equal(r2.frames, 20, 'twenty frames, not eighty');
    const raw2 = fs.readFileSync(out2 + '.raw');
    const dec2 = new Map();
    const frames2 = s => {
      if (!dec2.has(s.clip)) {
        const d = execFileSync(fakeFrames, ['--rgba', path.join(dir, s.file), String(s.from), String(s.to), String(s.w), String(s.h)], { maxBuffer: 1e9 });
        const sz = s.w * s.h * 4, list = [];
        for (let o = 0; o + 8 + sz <= d.length; o += 8 + sz) { const px = Buffer.from(d.subarray(o + 8, o + 8 + sz)); for (let q = 0; q < px.length; q += 4) { const b = px[q]; px[q] = px[q + 2]; px[q + 2] = b; } list.push({ t: d.readDoubleLE(o), px }); }
        dec2.set(s.clip, list);
      }
      return dec2.get(s.clip);
    };
    const size2 = m => { const s = mb.sources.find(x => x.file === m.file); return s ? { w: s.w, h: s.h } : { w: m.width, h: m.height }; };
    for (const i of [0, 8, 19]) {
      let avg = null;
      for (let s = 0; s < 4; s++) {
        const t = mb.times[i * 4 + s], plan = framePlan(doc, t, W, H, size2, cursor);
        const ids = [...new Set(plan.layers.filter(l => !l.fill && !l.ink).map(l => l.clip))];
        const pics = ids.map(cid => { const src = mb.sources.find(x => x.clip === cid); const l = plan.layers.find(x => x.clip === cid); return { w: src.w, h: src.h, rgba: at(frames2(src), l.st) }; });
        const plan2 = { ...plan, layers: plan.layers.map(l => (l.fill || l.ink ? l : { ...l, media: l.clip })) };
        const f = path.join(dir, `m${i}_${s}.rgba`);
        await core.run(Buffer.concat([Buffer.from('RCORE1\nframe\n'), Buffer.from(encodeFrame(plan2, W, H, ids, pics, f, plan.overlay ? square : null))]));
        const px = fs.readFileSync(f);
        if (!avg) avg = Buffer.from(px); else { const a = 1 / (s + 1); for (let q = 0; q < avg.length; q++) avg[q] = Math.min(255, Math.max(0, Math.round(px[q] * a + avg[q] * (1 - a)))); }
      }
      const got = raw2.subarray(i * W * H * 4, (i + 1) * W * H * 4);
      let diff = 0;
      for (let p = 0; p < avg.length; p += 4) if (avg[p] !== got[p + 2] || avg[p + 1] !== got[p + 1] || avg[p + 2] !== got[p]) diff++;
      assert.equal(diff, 0, `motion-blurred frame ${i}: ${diff} pixels differ`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('frames the core can’t draw yet (a vertigo ramp) are the editor’s, whole, and the rest still the core’s (1.14)', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vexp-'));
  try {
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=3', '-pix_fmt', 'yuv420p', path.join(dir, 'a.mp4')]);
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-ar', '48000', '-ac', '2', path.join(dir, 'mix.wav')]);
    const helpers = fs.readFileSync(new URL(import.meta.url), 'utf8');
    void helpers;
    const fakeFrames = path.join(dir, 'reel-frames'), fakeEncode = path.join(dir, 'reel-encode');
    fs.writeFileSync(fakeFrames, `#!${process.execPath}
const { spawn, execFileSync } = require('child_process');
const [, , mode, file, from, to, w, h] = process.argv;
const r = execFileSync('${ffprobe}', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', file]).toString().trim().split('/');
const fps = r[0] / (r[1] || 1), first = Math.max(0, Math.floor((+from - 0.5) * fps));
const f = spawn('${ffmpeg}', ['-v', 'error', '-i', file, '-vf', 'select=gte(n\\\\,' + first + '),scale=' + w + ':' + h + ':flags=area,format=bgra', '-vsync', '0', '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
const size = w * h * 4; let buf = Buffer.alloc(0), n = first;
process.stdout.on('error', () => process.exit(0));
f.stdout.on('data', d => { buf = Buffer.concat([buf, d]); while (buf.length >= size) { const t = Buffer.alloc(8); t.writeDoubleLE(n++ / fps); if (!process.stdout.write(Buffer.concat([t, buf.subarray(0, size)]))) f.stdout.pause(); buf = buf.subarray(size); if (n / fps > +to + 0.25) { f.kill(); process.stdout.end(() => process.exit(0)); return; } } });
process.stdout.on('drain', () => f.stdout.resume());
f.on('close', () => process.stdout.end(() => process.exit(0)));
`, { mode: 0o755 });
    fs.writeFileSync(fakeEncode, `#!${process.execPath}
const { spawn } = require('child_process'); const fs = require('fs');
const [, , out, w, h, fps, codec, vbr, abr, sound] = process.argv;
const f = spawn('${ffmpeg}', ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', w + 'x' + h, '-r', fps, '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out], { stdio: ['pipe', 'ignore', 'inherit'] });
const raw = fs.createWriteStream(out + '.raw');
process.stdin.on('data', d => { raw.write(d); if (!f.stdin.write(d)) { process.stdin.pause(); f.stdin.once('drain', () => process.stdin.resume()); } });
process.stdin.on('end', () => { raw.end(); f.stdin.end(); });
f.on('close', c => process.exit(c));
`, { mode: 0o755 });
    const W = 320, H = 180, fps = 10;
    const doc = docOf([{ ...clip('c1', 'a', 't1', 0, 2), transIn: { type: 'vertigo', dur: 0.5 } }]);
    const job = videoJob(doc, 0, 2, W, H, fps);
    assert.ok(job.whole.length >= 3, `${job.whole}`);
    // what sendOverlays sends for an editor frame: the whole frame as one picture (here, one flat colour per frame)
    const editorFrame = k => { const b = Buffer.alloc(4 + 1 + 16 + W * H * 4); b.writeUInt32LE(1, 0); b[4] = 0; [0, 0, W, H].forEach((v, i) => b.writeUInt32LE(v, 5 + i * 4)); for (let i = 0; i < W * H; i++) b.set([10 + k * 40, 200 - k * 30, 77, 255], 21 + i * 4); return b; };
    const out = path.join(dir, 'out.mp4');
    const r = await videoExport({ coreBin: bin, framesBin: fakeFrames, encodeBin: fakeEncode, sources: job.sources.map(s => ({ ...s, path: path.join(dir, s.file) })), body: job.body,
      out, w: W, h: H, fps, codec: 'h264', vbr: 2_000_000, abr: 128_000, sound: path.join(dir, 'mix.wav'), onProgress: () => {},
      overlay: true, onOverlay: w => { (async () => { for (const [k] of job.overlays.entries()) { if (!w.write(editorFrame(k))) await new Promise(r => w.once('drain', r)); } w.end(); })(); } });
    assert.equal(r.frames, 20);
    const raw = fs.readFileSync(out + '.raw');
    for (const [k, fi] of job.whole.entries()) {
      const f = raw.subarray(fi * W * H * 4, (fi + 1) * W * H * 4);
      let diff = 0;
      for (let p = 0; p < f.length; p += 4) if (f[p] !== 77 || f[p + 1] !== 200 - k * 30 || f[p + 2] !== 10 + k * 40) diff++; // BGRA
      assert.equal(diff, 0, `editor frame ${fi}: ${diff} pixels differ`);
    }
    // after the glitch: the core's own drawing (the video, not a flat colour)
    const f10 = raw.subarray(10 * W * H * 4, 11 * W * H * 4), seen = new Set();
    for (let p = 0; p < f10.length; p += 4 * 97) seen.add(f10[p] + ',' + f10[p + 1]);
    assert.ok(seen.size > 20, 'frame 10 is the video');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
