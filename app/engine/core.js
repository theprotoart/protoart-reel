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

/** Runs one job; resolves with the parsed answer or rejects with a plain reason. */
function run(job, { timeout = 120000, maxOut = 8e6 } = {}) {
  return new Promise((resolve, reject) => {
    if (!available()) { reject(new Error('reel-core isn’t part of this build')); return; }
    const proc = spawn(binPath, [], { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
    let out = '', done = false;
    const finish = (err, v) => { if (done) return; done = true; clearTimeout(timer); if (err) { try { proc.kill(); } catch {} reject(err); } else resolve(v); };
    const timer = setTimeout(() => finish(new Error('reel-core took too long')), timeout);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', d => { out += d; if (out.length > maxOut) finish(new Error('reel-core answered too much')); });
    proc.stderr.on('data', () => {});
    proc.on('error', e => finish(e));
    proc.on('close', () => {
      let m; try { m = JSON.parse(out.trim().split('\n').pop()); } catch { finish(new Error('reel-core gave no answer')); return; }
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

async function version() { try { return (await run(Buffer.from('RCORE1\nversion\n'), { timeout: 5000 })).version; } catch { return null; } }

module.exports = { available, umFind, analyze, version, encodeUmFind, run, useBinary };
