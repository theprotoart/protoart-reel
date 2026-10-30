// Validation for everything that crosses from the editor (renderer) into the main process.
'use strict';
const path = require('path');

const MAX_PROJECT_BYTES = 32 * 1024 * 1024;
const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v, lo, hi, dflt) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);

/** A safe file name stem from user text: no path separators, control characters or leading dots. */
function fileStem(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u001f\u007f/\\:]/g, ' ').replace(/^[.\s]+/, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** A plain file name inside a project's media folder. */
function mediaName(n) {
  return typeof n === 'string' && n.length > 0 && n.length <= 255 && !n.startsWith('.') && !/[\u0000-\u001f/\\]/.test(n) && !n.includes('..');
}

function newProject(name) {
  return {
    app: 'ProtoArt Reel', version: 1, name,
    canvas: { width: 1920, height: 1080, fps: 30, background: '#000000' },
    media: [], tracks: [{ id: 't1', name: 'Track 1' }, { id: 't2', name: 'Track 2' }, { id: 't3', name: 'Track 3' }],
    clips: [], markers: [], thumbnail: null, created: Date.now(),
  };
}

/** The project document is the editor's own data; check its shape and size before writing it. */
function project(doc) {
  if (!isPlainObject(doc)) throw new Error('Bad project');
  const json = JSON.stringify(doc);
  if (json.length > MAX_PROJECT_BYTES) throw new Error('Project too large');
  if (own(doc, 'version') !== 1 || !Array.isArray(own(doc, 'clips')) || !Array.isArray(own(doc, 'media'))) throw new Error('Bad project');
  for (const m of doc.media) if (!isPlainObject(m) || !mediaName(m.file)) throw new Error('Bad media entry');
  return JSON.parse(json);
}

function paths(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 200) return null;
  const out = [];
  for (const p of input) {
    if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0') || !path.isAbsolute(p)) return null;
    out.push(path.normalize(p));
  }
  return out;
}

const ROLES = ['screen', 'camera', 'mic', 'system'];
function recTracks(input) {
  if (!Array.isArray(input) || !input.length || input.length > 4) throw new Error('Bad tracks');
  const seen = new Set();
  return input.map(t => {
    if (!isPlainObject(t)) throw new Error('Bad track');
    const role = own(t, 'role'), format = own(t, 'format');
    if (!ROLES.includes(role) || seen.has(role)) throw new Error('Bad track role');
    seen.add(role);
    if (format !== 'mp4' && format !== 'wav') throw new Error('Bad track format');
    if (format === 'wav') {
      const sampleRate = own(t, 'sampleRate'), channels = own(t, 'channels');
      if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('Bad rate');
      if (channels !== 1 && channels !== 2) throw new Error('Bad channels');
      return { role, format, sampleRate, channels };
    }
    return { role, format };
  });
}

function offsets(meta) {
  const out = {};
  if (!isPlainObject(meta)) return out;
  for (const r of ROLES) { const v = own(meta, r); if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 30) out[r] = v; }
  return out;
}

const mult16 = (v, d) => { const n = Math.round(num(v, 256, 2048, d) / 16) * 16; return Math.min(2048, Math.max(256, n)); };
function aiJob(job) {
  if (!isPlainObject(job)) throw new Error('Bad job');
  const mode = own(job, 'mode') === 'img2img' ? 'img2img' : 'txt2img';
  const out = {
    mode, prompt: str(own(job, 'prompt'), 2000).trim(), negative: str(own(job, 'negative'), 1000).trim(),
    width: mult16(own(job, 'width'), 1280), height: mult16(own(job, 'height'), 720),
    steps: Math.round(num(own(job, 'steps'), 1, 50, 8)), seed: Math.floor(num(own(job, 'seed'), 0, 2 ** 31 - 1, 1)),
    strength: num(own(job, 'strength'), 0.05, 0.95, 0.6),
    engine: own(job, 'engine') === 'flux' ? 'flux' : 'ernie',
  };
  if (!out.prompt) throw new Error('Write a prompt first');
  const loras = own(job, 'loras');
  out.loras = Array.isArray(loras) ? loras.slice(0, 3).filter(l => isPlainObject(l) && typeof l.name === 'string' && /^[^/\\\u0000]{1,120}$/.test(l.name) && !l.name.startsWith('.'))
    .map(l => ({ name: l.name, scale: num(l.scale, 0, 2, 1) })) : [];
  if (mode === 'img2img') {
    const img = own(job, 'image');
    if (!(img instanceof Uint8Array) || img.length > 20 << 20 || img[0] !== 0x89 || img[1] !== 0x50) throw new Error('Bad start image');
    out.image = img;
  }
  return out;
}

function suggestRequest(r) {
  if (!isPlainObject(r)) throw new Error('Bad request');
  return { title: str(own(r, 'title'), 300), description: str(own(r, 'description'), 2000), style: str(own(r, 'style'), 100), mode: own(r, 'mode') === 'img2img' ? 'img2img' : 'txt2img' };
}

const appKey = k => typeof k === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(k);
function recApps(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > 12) throw new Error('Bad app list');
  return list.map(a => {
    if (!isPlainObject(a) || !appKey(own(a, 'key'))) throw new Error('Bad app');
    return { key: a.key, name: str(own(a, 'name'), 80) || a.key };
  });
}
function audioRule(r) {
  if (!isPlainObject(r)) throw new Error('Bad settings');
  const eq = Array.isArray(own(r, 'eq')) ? r.eq.slice(0, 10).map(v => num(v, -24, 24, 0)) : [];
  // channel strip: up to 6 filters [kind 0 peak | 1 low shelf | 2 high shelf | 3 high-pass, freq, gain dB, Q]
  const strip = Array.isArray(own(r, 'strip')) ? r.strip.slice(0, 6).filter(Array.isArray).map(f => [Math.round(num(f[0], 0, 3, 0)), num(f[1], 10, 22000, 1000), num(f[2], -24, 24, 0), num(f[3], 0.1, 10, 0.7)]) : [];
  return { volume: num(own(r, 'volume'), 0, 4, 1), mute: own(r, 'mute') === true, eq, strip, pan: num(own(r, 'pan'), -1, 1, 0), output: str(own(r, 'output'), 300) };
}

const pluginKey = k => typeof k === 'string' && /^[\x20-\x7e]{4}:[\x20-\x7e]{4}:[\x20-\x7e]{4}$/.test(k);
const VOICE_KEYS = { clean: [0, 1], process: [0, 1], reflections: [0, 1], gateMix: [0, 1], gateThreshold: [0, 1], gateAttack: [1, 1000], gateRelease: [5, 3000],
  dereverb: [0, 1], strength: [0.5, 3], room: [0.1, 4], tail: [0, 1], presence: [0, 1], width: [0, 1.5], gain: [-24, 24] };
function voiceParams(p) {
  if (!isPlainObject(p)) throw new Error('Bad voice settings');
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(VOICE_KEYS)) { const v = own(p, k); if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(hi, Math.max(lo, v)); }
  if (own(p, 'focus') === 'ambience') out.focus = 'ambience';
  const b = own(p, 'bands');
  if (Array.isArray(b) && b.length === 6) out.bands = b.map(v => num(v, 0, 1.5, 1));
  out.limit = own(p, 'limit') !== false;
  return out;
}
function fxChain(chain) {
  if (!Array.isArray(chain) || chain.length > 16) throw new Error('Bad effects chain');
  return chain.map(it => {
    if (!isPlainObject(it)) throw new Error('Bad effect');
    if (own(it, 'kind') === 'reel') return { kind: 'reel', params: voiceParams(own(it, 'params')), bypass: own(it, 'bypass') === true };
    if (own(it, 'kind') === 'au' && pluginKey(own(it, 'plugin'))) {
      const st = own(it, 'state');
      if (st !== undefined && st !== '' && (typeof st !== 'string' || st.length > 8 << 20 || !/^[A-Za-z0-9+/=]*$/.test(st))) throw new Error('Bad plug-in state');
      return { kind: 'au', plugin: it.plugin, state: st || '', bypass: own(it, 'bypass') === true };
    }
    throw new Error('Unknown effect');
  });
}

module.exports = { pluginKey, voiceParams, fxChain, appKey, recApps, audioRule, MAX_PROJECT_BYTES, fileStem, mediaName, newProject, project, paths, recTracks, offsets, aiJob, suggestRequest };
