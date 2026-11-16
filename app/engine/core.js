// reel-core: Reel's Rust helper (native/reel-core), the first step of moving the heavy work out of JavaScript.
// One job per run: the job goes in on stdin (binary, see native/reel-core/src/main.rs), one line of JSON comes
// back. When the helper isn't in this build (no Rust on the Mac that built it), callers fall back to JavaScript.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin', 'reel-core');
const COEFS = 12;
const MAX_SAMPLES = 16000 * 60 * 60 * 4; // four hours of 16 kHz sound per job

let binPath = BIN;
/** For tests: run a helper built somewhere else. */
function useBinary(p) { binPath = p; }
function available() { try { fs.accessSync(binPath, fs.constants.X_OK); return true; } catch { return false; } }

const finite = v => typeof v === 'number' && Number.isFinite(v);

/** A umfind job from a stored model ({ words: [{ word, prints }], nots, threshold }) and 16 kHz samples. */
function encodeUmFind(model, samples) {
  if (!model || !finite(model.threshold) || !(model.threshold > 0) || !Array.isArray(model.words)) throw new Error('No ums learned yet');
  if (!(samples instanceof Float32Array) || samples.length > MAX_SAMPLES) throw new Error('Bad sound');
  const parts = [Buffer.from('RCORE1\numfind\n')];
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); parts.push(b); };
  const print = p => {
    const rows = (Array.isArray(p) ? p : []).filter(f => f && f.length >= COEFS).slice(0, 2000);
    u32(rows.length);
    const b = Buffer.alloc(rows.length * COEFS * 4);
    rows.forEach((f, i) => { for (let k = 0; k < COEFS; k++) { const v = Number(f[k]); b.writeFloatLE(Number.isFinite(v) ? v : 0, (i * COEFS + k) * 4); } });
    parts.push(b);
  };
  const prints = list => { const l = (Array.isArray(list) ? list : []).slice(0, 500); u32(l.length); l.forEach(print); };
  const t = Buffer.alloc(8); t.writeDoubleLE(model.threshold); parts.push(t);
  const words = model.words.filter(w => w && typeof w.word === 'string').slice(0, 20);
  u32(words.length);
  for (const w of words) { const name = Buffer.from(w.word.slice(0, 20), 'utf8'); u32(name.length); parts.push(name); prints(w.prints); }
  prints(model.nots);
  u32(samples.length);
  parts.push(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  return Buffer.concat(parts);
}

/** Runs one job; resolves with the parsed answer or rejects with a plain reason. Lines {"progress": f} on the
 * way go to onProgress; the last other line is the answer. */
function run(job, { timeout = 120000, maxOut = 8e6, onProgress = null } = {}) {
  return new Promise((resolve, reject) => {
    if (!available()) { reject(new Error('reel-core isn’t part of this build')); return; }
    const proc = spawn(binPath, [], { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
    let buf = '', answer = '', size = 0, done = false;
    const finish = (err, v) => { if (done) return; done = true; clearTimeout(timer); if (err) { try { proc.kill(); } catch {} reject(err); } else resolve(v); };
    const timer = setTimeout(() => finish(new Error('reel-core took too long')), timeout);
    const line = l => {
      if (!l) return;
      if (l.startsWith('{"progress"')) { try { const f = JSON.parse(l).progress; if (onProgress && Number.isFinite(f)) onProgress(f); } catch {} return; }
      answer = l;
    };
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', d => {
      size += d.length;
      if (size > maxOut) { finish(new Error('reel-core answered too much')); return; }
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    proc.stderr.on('data', () => {});
    proc.on('error', e => finish(e));
    proc.on('close', () => {
      line(buf.trim());
      let m; try { m = JSON.parse(answer); } catch { finish(new Error('reel-core gave no answer')); return; }
      if (m && m.ok) finish(null, m); else finish(new Error((m && m.error) || 'reel-core failed'));
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(job);
  });
}

/** Your ums in 16 kHz samples, found by the Rust helper: [{ t, end, word, d, sure }]. */
async function umFind(model, samples) {
  const m = await run(encodeUmFind(model, samples));
  return (m.hits || []).filter(h => finite(h.t) && finite(h.end) && typeof h.word === 'string')
    .map(h => ({ t: h.t, end: h.end, word: h.word, d: h.d, sure: !!h.sure }));
}

/**
 * One pass over a media file's sound (the core reads the file itself: WAV in Rust, everything else through
 * Apple's decoder): { rate, peaks: Float32Array (100 a second), steps: Float32Array (K-weighted mean square
 * per 100 ms) }. `file` must be a path the main process chose (inside an open project's media folder).
 */
async function analyze(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0') || Buffer.byteLength(file) > 4096) throw new Error('Bad file');
  const name = Buffer.from(file, 'utf8'), len = Buffer.alloc(4); len.writeUInt32LE(name.length);
  const m = await run(Buffer.concat([Buffer.from('RCORE1\nanalyze\n'), len, name]), { timeout: 600000, maxOut: 256e6 });
  const nums = a => Float32Array.from(Array.isArray(a) ? a : [], v => (Number.isFinite(v) ? v : 0));
  if (!(m.rate > 0)) throw new Error('reel-core gave no sample rate');
  return { rate: m.rate, peaks: nums(m.peaks), steps: nums(m.steps) };
}

/**
 * The export's sound mixed by the core and written to `out` (a new file): job = { rate, total, mixGain, limiters, soft,
 * codec: 'wav' | 'aac', bitrate, sources: [absolute paths], plans: [{ src, first, last, s0, speed, env }] }
 * (env a Float32Array, from lib/mixplan.js), and with a loudness target `loud` = { target, ceil, rel, look, measure }
 * (needs reel-core 0.6). Paths must be ones the main process chose.
 */
async function mix(job, out, onProgress) {
  const parts = [Buffer.from(job.loud ? 'RCORE1\nmixloud\n' : 'RCORE1\nmix\n')];
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); parts.push(b); };
  const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(Math.max(0, Math.floor(n)))); parts.push(b); };
  const f64 = v => { const b = Buffer.alloc(8); b.writeDoubleLE(v); parts.push(b); };
  const u8 = v => parts.push(Buffer.from([v & 255]));
  const str = p => { if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) throw new Error('Bad file'); const b = Buffer.from(p, 'utf8'); u32(b.length); parts.push(b); };
  if (job.loud) { const L = job.loud; f64(+L.target); f64(+L.ceil); f64(+L.rel); u32(L.look); u64(L.measure); }
  f64(job.rate); u64(job.total); f64(job.mixGain);
  const lims = Array.isArray(job.limiters) ? job.limiters.slice(0, 16) : [];
  u32(lims.length); for (const l of lims) { f64(+l.ceil); f64(+l.rel); }
  u8(job.soft ? 1 : 0); u8(job.codec === 'aac' ? 1 : 0); u32(job.bitrate || 192000);
  str(out);
  u32(job.sources.length); job.sources.forEach(str);
  u32(job.plans.length);
  for (const p of job.plans) {
    if (!(p.env instanceof Float32Array)) throw new Error('Bad plan');
    u32(p.src); u64(p.first); u64(p.last); f64(p.s0); f64(p.speed); u32(p.env.length);
    parts.push(Buffer.from(p.env.buffer, p.env.byteOffset, p.env.byteLength));
  }
  if (job.clicks) { // click sounds (reel-core 0.7)
    const k = job.clicks;
    if (!(k.wave instanceof Float32Array)) throw new Error('Bad clicks');
    f64(k.start); u32(k.block); u32(k.wave.length); parts.push(Buffer.from(k.wave.buffer, k.wave.byteOffset, k.wave.byteLength));
    u32(k.clips.length);
    for (const c of k.clips) {
      for (const v of [c.start, c.in, c.speed, c.end, c.offset, c.gain]) f64(+v);
      const ms = c.ms instanceof Float64Array ? c.ms : Float64Array.from(c.ms || []);
      u32(ms.length); parts.push(Buffer.from(ms.buffer, ms.byteOffset, ms.byteLength));
    }
  }
  if (job.stretch) { // clips that keep their pitch (reel-core 0.8; needs the click section first)
    const st = job.stretch;
    if (!job.clicks || !(st.win instanceof Float32Array)) throw new Error('Bad stretch');
    u32(st.win.length); parts.push(Buffer.from(st.win.buffer, st.win.byteOffset, st.win.byteLength)); u32(st.tol);
    u32(st.clips.length);
    for (const c of st.clips) {
      u32(c.src); for (const v of [c.in, c.srcLen, c.speed, c.cs, c.ce, c.start]) f64(+v);
      u32(c.gains.length); for (const [fr, g, l, r] of c.gains) { u64(fr); f64(g); f64(l); f64(r); }
    }
    u32(st.order.length); for (const k of st.order) u32(k);
  }
  return run(Buffer.concat(parts), { timeout: 4 * 3600000, onProgress });
}

async function version() { try { return (await run(Buffer.from('RCORE1\nversion\n'), { timeout: 5000 })).version; } catch { return null; } }

module.exports = { available, umFind, analyze, mix, version, encodeUmFind, run, useBinary };
