// Per-app audio (Loopback / SoundSource style) through the bundled native helper `reel-audio`,
// which uses Core Audio process taps: record chosen apps to their own tracks, and a live mixer
// with per-app volume/boost, mute, EQ and output device. Mixer settings are remembered.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin', 'reel-audio');
let proc = null, buf = '', seq = 1, ready = null;
const waiting = new Map();
const listeners = new Set();
let rulesFile = null, rules = {};

function available() { try { fs.accessSync(BIN, fs.constants.X_OK); return true; } catch { return false; } }

function start() {
  if (proc) return ready;
  if (!available()) return Promise.reject(new Error('The per-app audio helper isn’t part of this build.'));
  proc = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME || '' } });
  ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('The audio helper didn’t start')), 8000);
    listeners.add(function first(m) { if (m.type === 'ready') { clearTimeout(t); listeners.delete(first); resolve(); } });
  });
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && waiting.has(m.id) && !m.progress) {
        const w = waiting.get(m.id); waiting.delete(m.id);
        // a fatal error answers the request; soft warnings (an app that isn't playing) don't
        if (m.type === 'error' && m.fatal) w.reject(new Error(m.msg || 'The audio helper failed')); else if (m.type !== 'error') w.resolve(m); else waiting.set(m.id, w);
      }
      for (const l of listeners) l(m);
    }
  });
  proc.stderr.on('data', () => {});
  proc.on('exit', () => {
    proc = null; ready = null;
    for (const w of waiting.values()) w.reject(new Error('The audio helper stopped'));
    waiting.clear();
  });
  // put remembered mixer settings back
  return ready.then(() => { for (const [key, r] of Object.entries(rules)) send({ cmd: 'set', key, ...r }); });
}

function send(msg) { if (proc) proc.stdin.write(JSON.stringify(msg) + '\n'); }
async function request(msg, timeout = 10000) {
  await start();
  const id = seq++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    send({ ...msg, id });
    setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); reject(new Error('The audio helper didn’t answer')); } }, timeout);
  });
}

function loadRules(file) {
  rulesFile = file;
  try { const r = JSON.parse(fs.readFileSync(file, 'utf8')); if (r && typeof r === 'object') rules = r; } catch { rules = {}; }
  // Reel's own sound must never go through the per-app mixer: drop any saved rule for it (older builds allowed
  // one, and it sent Reel's playback to the Mac's default output, with a delayed copy)
  let dropped = false;
  for (const key of Object.keys(rules)) if (/^local\.protoart\.reel(\.|$)/.test(key) || /protoart reel/i.test(key)) { delete rules[key]; dropped = true; }
  if (dropped) saveRules();
  // only start the helper at launch when there's something to apply
  if (Object.keys(rules).length && available()) start().catch(() => {});
}
function saveRules() {
  if (!rulesFile) return;
  try { fs.writeFileSync(rulesFile + '.tmp', JSON.stringify(rules), { mode: 0o600 }); fs.renameSync(rulesFile + '.tmp', rulesFile); } catch { /* best effort */ }
}

async function list() {
  const m = await request({ cmd: 'list' });
  for (const a of m.apps) a.rule = rules[a.key] || null;
  return { apps: m.apps, outputs: m.outputs };
}

async function set(key, r) {
  const flat = f => (f[0] === 3 ? f[1] < 21 : Math.abs(f[2]) < 0.05);
  const neutral = r.volume === 1 && !r.mute && (!r.eq || r.eq.every(v => Math.abs(v) < 0.05)) && !r.output && !r.pan && (!r.strip || r.strip.every(flat));
  if (neutral) delete rules[key]; else rules[key] = r;
  saveRules();
  await request({ cmd: 'set', key, ...r });
}

async function resetAll() {
  for (const key of Object.keys(rules)) { await request({ cmd: 'set', key, volume: 1, mute: false, eq: [], strip: [], pan: 0, output: '' }).catch(() => {}); }
  rules = {}; saveRules();
}

/** Listen-only level meters for every playing app while the SOUND console is open. */
async function meter(on) { if (!available()) return false; if (!on && !proc) return true; await request({ cmd: 'meter', on: !!on }, 8000); return true; }

async function recStart(rec, apps) { return request({ cmd: 'recStart', rec, apps }, 20000); }
async function recStop(rec) { return request({ cmd: 'recStop', rec }, 20000); }
/** Clicks (and keys, only when asked) while recording, through a listen-only event tap. */
/** Background removal: a person mask video for a clip's media (Vision, on this Mac). */
async function matte(src, dst, quality) { return request({ cmd: 'matte', src, dst, quality }, 6 * 60 * 60 * 1000); }
/** Converts a file Reel can't use as it is (see FORMATS in main.js). kind: image | audio | video. */
async function conform(src, dstBase, kind, onProgress) {
  const off = onEvent(m => { if (m.type === 'conformProgress' && onProgress) onProgress(m.value); });
  try { return await request({ cmd: 'conform', src, dst: dstBase, kind }, 6 * 60 * 60 * 1000); } finally { off(); }
}
async function inputStart(keys) { if (!available()) return false; const r = await request({ cmd: 'inputStart', keys: !!keys }, 8000); return !!r.ok; }
async function inputStop() { if (proc) await request({ cmd: 'inputStop' }, 4000).catch(() => {}); }

function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function stop() { if (proc) { send({ cmd: 'quit' }); const p = proc; setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, 3000); } }

module.exports = { available, list, set, resetAll, meter, conform, recStart, recStop, inputStart, inputStop, matte, onEvent, stop, loadRules };
