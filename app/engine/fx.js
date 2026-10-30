// Audio effects for ProtoArt Reel: built-in Voice Clean / DeReverb (native `reel-voice`) and the
// user's installed Audio Unit plug-ins (CEDAR, Waves, iZotope…) hosted by `reel-audio`.
// Clips (and the export master) are rendered through a chain into a new WAV in the project.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin');
const AUDIO = path.join(BIN, 'reel-audio');
const VOICE = path.join(BIN, 'reel-voice');
const exists = p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } };

// ------------------------------------------------------------------ plug-in host process

let host = null, hostBuf = '', seq = 1;
const waiting = new Map();
const listeners = new Set();

function startHost() {
  if (host) return;
  if (!exists(AUDIO)) throw new Error('Plug-in hosting isn’t part of this build.');
  host = spawn(AUDIO, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME || '' } });
  host.stdout.setEncoding('utf8');
  host.stdout.on('data', d => {
    hostBuf += d;
    let i;
    while ((i = hostBuf.indexOf('\n')) >= 0) {
      const line = hostBuf.slice(0, i); hostBuf = hostBuf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      const w = m.id != null && waiting.get(m.id);
      if (w) {
        if (m.type === 'error') { waiting.delete(m.id); w.reject(new Error(m.msg)); }
        else if (m.type === 'auProgress') w.progress && w.progress(m);
        else if (w.types.includes(m.type)) { waiting.delete(m.id); w.resolve(m); }
      }
      for (const l of listeners) l(m);
    }
  });
  host.stderr.on('data', () => {});
  host.on('exit', () => {
    host = null;
    for (const w of waiting.values()) w.reject(new Error('The plug-in host stopped (a plug-in may have crashed).'));
    waiting.clear();
  });
}
function hostRequest(msg, types, { timeout = 30000, progress } = {}) {
  startHost();
  const id = seq++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, types, progress });
    host.stdin.write(JSON.stringify({ ...msg, id }) + '\n');
    if (timeout) setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); reject(new Error('The plug-in didn’t respond. If it needs a licence (iLok, Waves Central), open that app and try again.')); } }, timeout);
  });
}

let pluginCache = null;
async function listPlugins() {
  if (pluginCache) return pluginCache;
  const m = await hostRequest({ cmd: 'auList' }, ['auList']);
  // Waves shells list mono, stereo and mono→stereo versions; Reel works in stereo
  pluginCache = m.plugins
    .filter(p => !/\((m|m->s)\)$/.test(p.name))
    .map(p => ({ id: p.id, name: p.name.replace(/\s*\(s\)$/, ''), maker: p.maker, version: p.version }))
    .sort((a, b) => a.maker.localeCompare(b.maker) || a.name.localeCompare(b.name));
  return pluginCache;
}

async function openEditor(slot, plugin, state, title) {
  await hostRequest({ cmd: 'auOpen', slot, plugin, state }, ['auOpened'], { timeout: 60000 });
  await hostRequest({ cmd: 'auShow', slot, title }, ['ok'], { timeout: 60000 });
}
async function closeEditor(slot) { const m = await hostRequest({ cmd: 'auClose', slot }, ['auState']); return m.state; }
async function getState(slot) { const m = await hostRequest({ cmd: 'auState', slot }, ['auState']); return m.state; }
async function previewThrough(slots, file, start, seconds, device = '', gain = 1) { await hostRequest({ cmd: 'auPreview', slots, in: file, start, seconds, device, gain }, ['ok']); }
async function stopPreview() { if (host) await hostRequest({ cmd: 'auPreviewStop' }, ['ok']).catch(() => {}); }
function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// ------------------------------------------------------------------ WAV helpers

function wavInfo(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(65536);
    const n = fs.readSync(fd, b, 0, b.length, 0);
    const size = fs.fstatSync(fd).size;
    if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') throw new Error('Not a WAV file');
    let p = 12, fmt = null;
    while (p + 8 <= n) {
      const id = b.toString('latin1', p, p + 4), len = b.readUInt32LE(p + 4);
      if (id === 'fmt ') {
        let format = b.readUInt16LE(p + 8);
        if (format === 0xfffe && len >= 26) format = b.readUInt16LE(p + 32);
        fmt = { format, channels: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
      }
      if (id === 'data') return { ...fmt, dataOffset: p + 8, dataLength: Math.min(len, size - p - 8) };
      p += 8 + len + (len & 1);
    }
  } finally { fs.closeSync(fd); }
  throw new Error('Unreadable WAV');
}

/** Runs reel-voice over a 48 kHz float WAV. */
function runVoice(inFile, outFile, params, onProgress) {
  return new Promise((resolve, reject) => {
    if (!exists(VOICE)) return reject(new Error('The built-in voice tools aren’t part of this build.'));
    const info = wavInfo(inFile);
    if (info.format !== 3 || info.bits !== 32 || info.rate !== 48000) return reject(new Error('Voice tools need 48 kHz float audio'));
    const args = ['--out', outFile, '--channels', String(Math.min(2, info.channels))];
    const num = (k, v) => { if (typeof v === 'number' && Number.isFinite(v)) args.push(k, String(v)); };
    const p = params || {};
    num('--clean', p.clean); num('--process', p.process); num('--reflections', p.reflections);
    num('--gate-mix', p.gateMix); num('--gate-threshold', p.gateThreshold); num('--gate-attack', p.gateAttack); num('--gate-release', p.gateRelease);
    num('--dereverb', p.dereverb); num('--strength', p.strength); num('--room', p.room); num('--tail', p.tail); num('--presence', p.presence);
    num('--width', p.width); num('--gain', p.gain);
    if (p.focus === 'ambience') args.push('--focus', 'ambience');
    if (Array.isArray(p.bands) && p.bands.length === 6) args.push('--bands', p.bands.map(v => Math.max(0, Math.min(1.5, Number(v) || 0))).join(','));
    args.push('--limit', p.limit === false ? '0' : '1');
    const proc = spawn(VOICE, args, { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
    const total = info.dataLength / (4 * info.channels);
    let out = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', d => {
      out += d;
      const m = /P (\d+)\s*$/.exec(out.split('\n').filter(Boolean).pop() || '');
      if (m && onProgress) onProgress(Math.min(1, Number(m[1]) / total));
    });
    let err = '';
    proc.stderr.on('data', d => { err += d; });
    proc.on('exit', code => code === 0 ? resolve() : reject(new Error(`Voice processing failed: ${err.trim().slice(-200) || code}`)));
    // stream the samples (data chunk only) into the processor
    const rs = fs.createReadStream(inFile, { start: info.dataOffset, end: info.dataOffset + info.dataLength - 1 });
    rs.pipe(proc.stdin);
    proc.stdin.on('error', () => {});
  });
}

/**
 * Renders a chain over a 48 kHz float WAV. chain: [{ kind: 'reel', params } | { kind: 'au', plugin, state }].
 * Consecutive plug-ins run in one pass. Returns when `outFile` is written.
 */
async function renderChain(inFile, outFile, chain, onProgress, tmpDir) {
  const groups = [];
  for (const item of chain) {
    if (item.bypass) continue;
    const last = groups[groups.length - 1];
    if (item.kind === 'au' && last && last.kind === 'au') last.items.push(item);
    else groups.push({ kind: item.kind, items: [item] });
  }
  if (!groups.length) { await fs.promises.copyFile(inFile, outFile); return; }
  let cur = inFile;
  for (let g = 0; g < groups.length; g++) {
    const next = g === groups.length - 1 ? outFile : path.join(tmpDir, `stage-${g}.wav`);
    const prog = f => onProgress && onProgress((g + f) / groups.length);
    if (groups[g].kind === 'reel') {
      await runVoice(cur, next, groups[g].items[0].params, prog);
    } else {
      await hostRequest({ cmd: 'auRender', in: cur, out: next, chain: groups[g].items.map(i => ({ plugin: i.plugin, state: i.state || '' })) },
        ['auRendered'], { timeout: 0, progress: m => prog(m.done / Math.max(1, m.total)) });
    }
    if (cur !== inFile) await fs.promises.rm(cur, { force: true });
    cur = next;
  }
}

function stop() { if (host) { try { host.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n'); } catch { /* gone */ } } }

module.exports = { listPlugins, openEditor, closeEditor, getState, previewThrough, stopPreview, onEvent, renderChain, runVoice, wavInfo, stop, available: () => ({ plugins: exists(AUDIO), voice: exists(VOICE) }) };
