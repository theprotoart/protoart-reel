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
  // titles aren't drawn by the core: the editor draws that export
  const t = videoJob({ ...doc, clips: [...doc.clips, { id: 'x', type: 'text', track: 't2', start: 1.5, duration: 0.2, props: props() }] }, 0, 2, 320, 180, 10);
  assert.match(t.why, /titles/);
  assert.ok(Math.abs(t.at - 1.5) < 1e-9);
  // played backwards: a decoder reads forwards only
  const back = videoJob(docOf([clip('c1', 'a', 't1', 0, 2, {}, { retime: [{ t: 0, s: 2 }, { t: 2, s: 0 }] })]), 0, 2, 320, 180, 10);
  assert.ok(back.why == null || /backwards/.test(back.why));
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
      clip('c1', 'a', 't1', 0, 2, { scale: 1.3, x: 0.45 }),
      clip('c2', 'b', 't2', 0.5, 1.2, { scale: 0.4, x: 0.75, y: 0.7, radius: 12, border: 3, shadow: 10, opacity: 0.9 }, { in: 0.7 }),
    ]);
    const job = videoJob(doc, 0, 2, W, H, fps);
    assert.ok(!job.why, job.why);
    const out = path.join(dir, 'out.mp4');
    let last = 0;
    const r = await videoExport({ coreBin: bin, framesBin: fakeFrames, encodeBin: fakeEncode, sources: job.sources.map(s => ({ ...s, path: path.join(dir, s.file) })), body: job.body,
      out, w: W, h: H, fps, codec: 'h264', vbr: 2_000_000, abr: 128_000, sound: path.join(dir, 'mix.wav'), onProgress: f => { last = f; } });
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
    for (const i of [0, 7, 12, 19]) {
      const t = i / fps, plan = framePlan(doc, t, W, H, size);
      const ids = plan.layers.filter(l => !l.fill).map(l => l.clip);
      const pics = ids.map(cid => { const s = job.sources.find(x => x.clip === cid); const l = plan.layers.find(x => x.clip === cid); return { w: s.w, h: s.h, rgba: at(framesOf(s), l.st) }; });
      const plan2 = { ...plan, layers: plan.layers.map(l => (l.fill ? l : { ...l, media: l.clip })) };
      const f = path.join(dir, `f${i}.rgba`);
      await core.run(Buffer.concat([Buffer.from('RCORE1\nframe\n'), Buffer.from(encodeFrame(plan2, W, H, ids, pics, f))]));
      const want = fs.readFileSync(f), got = raw.subarray(i * W * H * 4, (i + 1) * W * H * 4);
      let diff = 0;
      for (let p = 0; p < want.length; p += 4) if (want[p] !== got[p + 2] || want[p + 1] !== got[p + 1] || want[p + 2] !== got[p]) diff++;
      assert.equal(diff, 0, `frame ${i}: ${diff} pixels differ`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
