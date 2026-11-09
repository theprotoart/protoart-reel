// AI helpers for ProtoArt Reel, borrowed from Protoart Studio's installed engines (nothing is
// downloaded or installed by Reel itself):
//   * ERNIE-Image Turbo on Studio's fast engine (MLX) for thumbnail art, text-to-image and
//     image-to-image from a video frame;
//   * FLUX.2 [klein] 4B (Black Forest Labs, Apache 2.0) as a second picture engine: strong at
//     following the prompt. The same 4-bit copy Protoart Studio downloads (pinned revision);
//   * a small Qwen2.5 language model (Studio's prompt enhancer) to suggest thumbnail prompts.
// Each runs as a separate Python process speaking JSON lines; only fixed scripts from this
// app are run, with a minimal environment, and the network kept off (HF_HUB_OFFLINE).
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const STUDIO_HOME = process.env.PROTOART_HOME || path.join(HOME, '.protoartstudio');
const ERNIE_REPO = 'mflux-community/ernie-image-turbo-mflux-q4';
const QWEN_REPOS = ['Qwen/Qwen2.5-1.5B-Instruct', 'Qwen/Qwen2.5-0.5B-Instruct', 'Qwen/Qwen2.5-3B-Instruct'];
const SCRIPTS = path.join(__dirname, '..', 'ai');
// The 4-bit FLUX.2 [klein] conversion Protoart Studio uses (Studio's engine.py, pinned to one revision
// so the files can't change under us). Reel reads it from the shared Hugging Face cache.
const FLUX_REPO = 'ar9av/FLUX.2-klein-4B-mflux-4bit';
const FLUX_REVISION = '86214a1c1caaea43b7c25b452b74ec08cd33d3e7';
const FLUX_DOWNLOAD_BYTES = 4.6e9;
function setUserData() { /* kept for main.js; FLUX lives in the shared cache now */ }
function fluxReady() {
  const dir = path.join(hubCache(), 'models--' + FLUX_REPO.replace('/', '--'), 'snapshots', FLUX_REVISION);
  return exists(path.join(dir, 'transformer')) && exists(path.join(dir, 'text_encoder')) && exists(path.join(dir, 'vae')) ? dir : null;
}
/** Does Studio's fast engine know FLUX.2 klein? (a file check; no Python started) */
function mfluxHasFlux2() {
  const py = mlxPython();
  if (!py) return false;
  const venv = path.dirname(path.dirname(py));
  try {
    for (const v of fs.readdirSync(path.join(venv, 'lib'))) {
      if (exists(path.join(venv, 'lib', v, 'site-packages', 'mflux', 'models', 'flux2'))) return true;
    }
  } catch { /* none */ }
  return false;
}

const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };

/** Every place a Hugging Face cache may be: Studio's chosen folder first, then the usual ones. */
function hubCaches() {
  const out = [];
  try {
    const p = JSON.parse(fs.readFileSync(path.join(STUDIO_HOME, 'downloads_location.json'), 'utf8')).path;
    if (p) out.push(p, path.join(p, 'hub'));
  } catch { /* none */ }
  if (process.env.HF_HUB_CACHE) out.push(process.env.HF_HUB_CACHE);
  if (process.env.HF_HOME) out.push(path.join(process.env.HF_HOME, 'hub'));
  if (process.env.XDG_CACHE_HOME) out.push(path.join(process.env.XDG_CACHE_HOME, 'huggingface', 'hub'));
  out.push(path.join(HOME, '.cache', 'huggingface', 'hub'));
  return out.filter((x, i, a) => a.indexOf(x) === i);
}
function hubCache() {
  for (const d of hubCaches()) { try { if (fs.statSync(d).isDirectory()) return d; } catch { /* next */ } }
  return path.join(HOME, '.cache', 'huggingface', 'hub');
}

/** Why the last snapshot() lookup failed, per repo (shown in the AI window so a miss can be explained). */
const lookupNotes = new Map();

/**
 * The local snapshot folder of a downloaded Hugging Face repo, or null. Looks in every cache folder.
 * Accepts the plain layout (config.json / weights at the top) and mflux's (mflux_model_config.json or
 * manifest.json, with the weights in transformer/, text_encoder/, vae/ subfolders). refs/main wins.
 */
function snapshot(repo) {
  const notes = [];
  for (const hub of hubCaches()) {
    const r = snapshotIn(hub, repo, notes);
    if (r) { lookupNotes.delete(repo); return r; }
  }
  lookupNotes.set(repo, notes.join('; '));
  return null;
}
function snapshotIn(hub, repo, notes) {
  const base = path.join(hub, 'models--' + repo.replace('/', '--'));
  const dir = path.join(base, 'snapshots');
  const why = e => (e && e.code === 'EPERM' || e && e.code === 'EACCES' ? 'macOS blocked reading' : e && e.code === 'ENOENT' ? 'not there' : String(e && e.code || e));
  const weights = d => { try { return fs.readdirSync(d).some(f => f.endsWith('.safetensors') && !f.endsWith('.incomplete')); } catch (e) { notes.push(`${d}: ${why(e)}`); return false; } };
  const ok = full => {
    let files;
    try { files = fs.readdirSync(full); } catch (e) { notes.push(`${full}: ${why(e)}`); return false; }
    if (files.some(f => f.endsWith('.safetensors') || f === 'config.json' || f === 'model_index.json')) return true;
    if (files.includes('mflux_model_config.json') || files.includes('manifest.json') || files.includes('transformer')) {
      return weights(path.join(full, 'transformer')) || files.some(f => !f.includes('.') && weights(path.join(full, f)));
    }
    notes.push(`${full}: no model files`);
    return false;
  };
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { if (e.code !== 'ENOENT' || fs.existsSync(base)) notes.push(`${dir}: ${why(e)}`); return null; }
  let main = '';
  try { main = fs.readFileSync(path.join(base, 'refs', 'main'), 'utf8').trim(); } catch { /* no ref */ }
  for (const s of [main, ...names].filter((x, i, a) => x && a.indexOf(x) === i && names.includes(x))) {
    const full = path.join(dir, s);
    if (ok(full)) return full;
  }
  return null;
}

function mlxPython() {
  const candidates = [
    path.join(STUDIO_HOME, 'venv-mlx'),
    path.join(HOME, 'ProtoartStudio', 'backend', '.venv-mlx'),
  ];
  for (const v of candidates) {
    const py = path.join(v, 'bin', 'python');
    if (exists(path.join(v, '.protoart-installed')) && exists(py) && exists(safeReal(py))) return py;
  }
  return null;
}
function safeReal(p) { try { return fs.realpathSync(p); } catch { return '/nonexistent'; } }

function textPython() {
  const candidates = [
    '/Applications/Protoart Studio.app/Contents/Resources/python/bin/python3',
    path.join(HOME, 'Applications', 'Protoart Studio.app', 'Contents', 'Resources', 'python', 'bin', 'python3'),
    path.join(HOME, 'ProtoartStudio', 'backend', '.venv', 'bin', 'python'),
  ];
  return candidates.find(p => exists(p) && exists(safeReal(p))) || null;
}

// FLUX.2 LoRAs: Studio's "FLUX.2" folder (its "FLUX" folder holds FLUX.1 LoRAs, which don't fit klein)
const LORA_DIRS = { ernie: ['ERNIE'], flux: ['FLUX.2', 'FLUX2', 'Flux2', 'flux2 klein', 'Klein'] };
function loraDir(engine) {
  for (const d of LORA_DIRS[engine] || LORA_DIRS.ernie) { const full = path.join(STUDIO_HOME, 'loras', d); if (exists(full)) return full; }
  return path.join(STUDIO_HOME, 'loras', (LORA_DIRS[engine] || LORA_DIRS.ernie)[0]);
}
/** LoRAs from Protoart Studio's LoRA folder for this engine (styles like pencil, chibi…), minus any it marks as adult. */
function listLoras(engine = 'ernie') {
  const dir = loraDir(engine);
  let marked = {};
  try { marked = JSON.parse(fs.readFileSync(path.join(STUDIO_HOME, 'content_marks.json'), 'utf8')).loras || {}; } catch { /* none */ }
  const out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.safetensors$/i.test(f)) continue;
      const name = f.replace(/\.safetensors$/i, '');
      if (marked[name]) continue;
      let trigger = '';
      for (const ext of ['.txt', '.trigger.txt']) { try { trigger = fs.readFileSync(path.join(dir, name + ext), 'utf8').trim().slice(0, 200); break; } catch { /* none */ } }
      out.push({ name, label: name.replace(/_epoch_\d+$/i, '').replace(/[_-]+/g, ' ').trim(), trigger });
    }
  } catch { /* no folder */ }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
function loraPath(name, engine = 'ernie') {
  const dir = loraDir(engine), f = path.join(dir, name + '.safetensors');
  return exists(f) && path.dirname(f) === dir ? f : null;
}

function status() {
  const py = mlxPython(), model = snapshot(ERNIE_REPO);
  const tpy = textPython(), qwen = QWEN_REPOS.map(snapshot).find(Boolean);
  return {
    ernie: {
      ready: !!(py && model),
      reason: !py ? "Protoart Studio's fast engine isn't installed. Open Protoart Studio and make one ERNIE-Image Turbo (fast engine) picture first."
        : !model ? (lookupNotes.get(ERNIE_REPO)
          ? `Reel can't read ERNIE-Image Turbo: ${lookupNotes.get(ERNIE_REPO).slice(0, 300)}`
          : `ERNIE-Image Turbo (fast engine) isn't downloaded yet (looked in ${hubCaches().join(', ')}). Download it once in Protoart Studio's Models tab.`) : '',
    },
    flux: (() => {
      const has = mfluxHasFlux2(), dir = fluxReady();
      return {
        ready: !!(py && has && dir),
        canSetup: !!(py && has && !dir),
        setting: !!setupJob,
        reason: !py ? "Protoart Studio's fast engine isn't installed. Open Protoart Studio and make one fast-engine picture first."
          : !has ? "Protoart Studio's fast engine is too old for FLUX.2 [klein]. Update Protoart Studio, then come back."
          : !dir ? 'FLUX.2 [klein] isn’t downloaded yet. Download “FLUX.2 Klein 4B · 4-bit” in Protoart Studio’s Models tab, or press GET FLUX (4.6 GB, one time).' : '',
      };
    })(),
    text: { ready: !!(tpy && qwen), reason: tpy && qwen ? '' : 'Smart prompt suggestions use Protoart Studio\'s prompt enhancer; simple suggestions are used instead.' },
    lowRam: os.totalmem() < 20 * 1024 ** 3,
  };
}

class Helper {
  constructor(name, python, script) { this.name = name; this.python = python; this.script = script; this.proc = null; this.listeners = new Set(); this.err = ''; this.buf = ''; }
  start() {
    if (this.proc && this.proc.exitCode === null) return;
    const env = {
      HOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1',
      HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_CACHE: hubCache(), TOKENIZERS_PARALLELISM: 'false',
      PYTORCH_ENABLE_MPS_FALLBACK: '1',
    };
    this.proc = spawn(this.python, ['-I', this.script], { cwd: SCRIPTS, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', d => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        for (const l of this.listeners) l(msg);
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', d => { this.err = (this.err + d).slice(-4000); });
    this.proc.on('exit', () => { for (const l of this.listeners) l({ type: 'exit' }); this.proc = null; });
  }
  send(msg) { this.start(); this.proc.stdin.write(JSON.stringify(msg) + '\n'); }
  request(msg, onEvent, finish = ['done']) {
    return new Promise((resolve, reject) => {
      this.start();
      const l = ev => {
        if (finish.includes(ev.type)) { this.listeners.delete(l); resolve(ev); }
        else if (ev.type === 'error') { this.listeners.delete(l); reject(new Error(ev.cancelled ? 'Stopped' : ev.msg || `${this.name} error`)); }
        else if (ev.type === 'exit') { this.listeners.delete(l); reject(new Error(`${this.name} stopped unexpectedly${this.err ? ':\n' + this.err.split('\n').slice(-6).join('\n') : ''}`)); }
        else onEvent(ev);
      };
      this.listeners.add(l);
      this.proc.stdin.write(JSON.stringify(msg) + '\n');
    });
  }
  stop() {
    if (!this.proc) return;
    try { this.proc.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n'); } catch { /* gone */ }
    const p = this.proc;
    setTimeout(() => { if (p.exitCode === null) p.kill('SIGKILL'); }, 4000);
    this.proc = null;
  }
}

let ernie = null, flux = null, text = null, busy = Promise.resolve();

// Memory: the AI models take gigabytes. On Macs with 16 GB or less they're unloaded soon after the
// last picture or prompt (and right away before recording or exporting); bigger Macs keep them warm.
const SMALL_MAC = os.totalmem() <= 17 * 1024 ** 3;
const IDLE_MS = SMALL_MAC ? 90 * 1000 : 10 * 60 * 1000;
const idleTimers = new Map();
function touch(h) {
  clearTimeout(idleTimers.get(h));
  idleTimers.set(h, setTimeout(() => { if (h) h.stop(); }, IDLE_MS));
}
/** Free AI memory before heavy work (recording, export) on small Macs. */
function release(force = false) { if (SMALL_MAC || force) stopAll(); }

async function generate(job, onEvent) {
  if (job.engine === 'flux') return generateFlux(job, onEvent);
  const st = status();
  if (!st.ernie.ready) throw new Error(st.ernie.reason);
  if (flux) { flux.stop(); flux = null; } // one picture model in memory at a time
  if (!ernie) ernie = new Helper('ERNIE', mlxPython(), path.join(SCRIPTS, 'reel_ernie.py'));
  const run = async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'protoart-reel-'));
    try {
      let init = '';
      if (job.mode === 'img2img') { init = path.join(dir, 'start.png'); await fs.promises.writeFile(init, job.image); }
      const loras = (job.loras || []).map(l => [loraPath(l.name), l.scale]).filter(l => l[0]);
      await ernie.request({ cmd: 'load', path: snapshot(ERNIE_REPO), low_ram: st.lowRam, loras }, onEvent, ['loaded']);
      const out = path.join(dir, 'out.png');
      await ernie.request({
        cmd: 'generate', prompt: job.prompt, negative_prompt: job.negative, width: job.width, height: job.height,
        steps: job.steps, seed: job.seed, out, image: init || null, strength: job.mode === 'img2img' ? job.strength : null,
      }, onEvent, ['done']);
      // move the result out of the temp folder before cleaning it
      const keep = path.join(os.tmpdir(), `protoart-reel-${process.pid}-${Date.now()}.png`);
      await fs.promises.rename(out, keep);
      return keep;
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };
  const p = busy.then(run, run).finally(() => touch(ernie));
  busy = p.catch(() => {});
  return p;
}

async function generateFlux(job, onEvent) {
  const st = status();
  if (!st.flux.ready) throw new Error(st.flux.reason);
  if (setupJob) throw new Error('FLUX is still being set up.');
  if (ernie) { ernie.stop(); ernie = null; } // one picture model in memory at a time
  if (!flux) flux = new Helper('FLUX', mlxPython(), path.join(SCRIPTS, 'reel_flux.py'));
  const run = async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'protoart-reel-'));
    try {
      let init = '';
      if (job.mode === 'img2img') { init = path.join(dir, 'start.png'); await fs.promises.writeFile(init, job.image); }
      const loras = (job.loras || []).map(l => [loraPath(l.name, 'flux'), l.scale]).filter(l => l[0]);
      await flux.request({ cmd: 'load', path: fluxReady(), low_ram: st.lowRam, loras, variant: init ? 'edit' : 'txt' }, onEvent, ['loaded']);
      const out = path.join(dir, 'out.png');
      await flux.request({
        cmd: 'generate', prompt: job.prompt, width: job.width, height: job.height,
        steps: Math.min(job.steps, 8) || 4, seed: job.seed, out, image: init || null,
      }, onEvent, ['done']);
      const keep = path.join(os.tmpdir(), `protoart-reel-${process.pid}-${Date.now()}.png`);
      await fs.promises.rename(out, keep);
      return keep;
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };
  const p = busy.then(run, run).finally(() => touch(flux));
  busy = p.catch(() => {});
  return p;
}

// ---------------------------------------------------------------- one-time FLUX setup
let setupJob = null;
/** Disk use of a folder (follows the HF cache's blob files). */
async function folderBytes(dir) {
  let n = 0;
  const walk = async d => {
    let list; try { list = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) { const f = path.join(d, e.name); if (e.isDirectory()) await walk(f); else { try { n += (await fs.promises.stat(f)).size; } catch { /* gone */ } } }
  };
  await walk(dir);
  return n;
}
/** Download Studio's pinned 4-bit FLUX.2 [klein] (4.6 GB) into the shared cache, for Macs where Studio hasn't. */
async function setupFlux(_opts, onEvent) {
  if (setupJob) throw new Error('Already downloading FLUX.');
  const py = mlxPython();
  if (!py || !mfluxHasFlux2()) throw new Error(status().flux.reason);
  if (fluxReady()) return { ok: true, bytes: await folderBytes(fluxReady()) };
  const free = await fs.promises.statfs(os.homedir()).then(st => st.bavail * st.bsize).catch(() => Infinity);
  if (free < 6e9) throw new Error(`Not enough free disk space: FLUX needs about 5 GB (${(free / 1e9).toFixed(0)} GB free now).`);
  const repoDir = path.join(hubCache(), 'models--' + FLUX_REPO.replace('/', '--'));
  const job = setupJob = { cancelled: false, proc: null };
  try {
    onEvent({ type: 'setup', stage: 'download', f: 0, msg: 'Downloading FLUX.2 [klein] 4-bit (4.6 GB)…' });
    const env = { HOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1', HF_HUB_CACHE: hubCache(), HF_HUB_DISABLE_TELEMETRY: '1' };
    await new Promise((resolve, reject) => {
      const proc = job.proc = spawn(py, ['-I', path.join(SCRIPTS, 'reel_fetch.py'), hubCache(), FLUX_REPO, FLUX_REVISION], { cwd: SCRIPTS, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      proc.stdout.on('data', d => { out += d; });
      proc.stderr.on('data', d => { err = (err + d).slice(-3000); });
      const timer = setInterval(async () => {
        const n = await folderBytes(repoDir);
        onEvent({ type: 'setup', stage: 'download', f: Math.min(0.99, n / FLUX_DOWNLOAD_BYTES), msg: `Downloading FLUX.2 [klein]… ${(n / 1e9).toFixed(1)} of 4.6 GB` });
      }, 1500);
      proc.on('exit', code => {
        clearInterval(timer);
        if (job.cancelled) return reject(new Error('Stopped'));
        const last = out.trim().split('\n').pop() || '';
        let msg = null; try { msg = JSON.parse(last); } catch { /* none */ }
        if (code === 0 && msg && msg.type === 'fetched') return resolve();
        reject(new Error(`Download failed: ${(msg && msg.msg) || err.split('\n').filter(Boolean).pop() || 'unknown error'}`));
      });
    });
    if (!fluxReady()) throw new Error('The download finished but the model files are incomplete. Try again.');
    onEvent({ type: 'setup', stage: 'done', f: 1, msg: 'FLUX.2 [klein] is ready.' });
    return { ok: true, bytes: await folderBytes(fluxReady()) };
  } finally {
    setupJob = null;
  }
}
function cancelSetup() { if (setupJob) { setupJob.cancelled = true; try { setupJob.proc && setupJob.proc.kill('SIGTERM'); } catch { /* gone */ } } }

function cancel() { for (const h of [ernie, flux]) if (h && h.proc) h.proc.stdin.write(JSON.stringify({ cmd: 'cancel' }) + '\n'); }

const STYLE_WORDS = {
  bold: 'bold high-contrast YouTube thumbnail style, saturated colours, dramatic rim lighting',
  cinematic: 'cinematic lighting, shallow depth of field, film still, moody colour grade',
  neon: 'neon glow, synthwave colours, dark background with vivid magenta and cyan light',
  clean: 'clean minimal tech style, soft gradient background, studio lighting',
  comic: 'comic book illustration, halftone shading, thick ink outlines, pop art colours',
  '3d': '3D render, glossy materials, soft global illumination, playful',
};

/** Rule-based prompt when the language model isn't available. */
function simplePrompt(r) {
  const topic = (r.title || r.description || 'a screen recording tutorial').replace(/\s+/g, ' ').trim();
  const style = STYLE_WORDS[r.style] || STYLE_WORDS.bold;
  return `An eye-catching background image about ${topic}, with a clear focal subject on one side and open space on the other for a title, ${style}, no text, no letters, 16:9 composition.`;
}

async function suggest(r, onEvent) {
  const st = status();
  if (!st.text.ready) return { prompt: simplePrompt(r), smart: false };
  if (!text) text = new Helper('Prompt writer', textPython(), path.join(SCRIPTS, 'reel_text.py'));
  try {
    const repo = QWEN_REPOS.find(snapshot);
    const ev = await text.request({ cmd: 'suggest', model: snapshot(repo), title: r.title, description: r.description, style: STYLE_WORDS[r.style] || STYLE_WORDS.bold, mode: r.mode }, onEvent, ['done']);
    touch(text);
    const prompt = typeof ev.prompt === 'string' && ev.prompt.length > 10 ? ev.prompt.slice(0, 1500) : simplePrompt(r);
    return { prompt, smart: true };
  } catch {
    return { prompt: simplePrompt(r), smart: false };
  }
}

// ------------------------------------------------------------------ the writer: Qwen for titles, descriptions, chapters
// Three sizes of Qwen's own Qwen2.5 instruct model. The bigger ones write better but need more memory: a size this Mac
// can't run is offered greyed out with the reason. Downloaded into the shared Hugging Face cache (Studio's too).
const WRITER_MODELS = {
  small: { repo: 'Qwen/Qwen2.5-1.5B-Instruct', label: 'Qwen 2.5 · 1.5B (small, fast)', gb: 3.1, minRamGb: 8 },
  medium: { repo: 'Qwen/Qwen2.5-3B-Instruct', label: 'Qwen 2.5 · 3B (better)', gb: 6.2, minRamGb: 16 },
  large: { repo: 'Qwen/Qwen2.5-7B-Instruct', label: 'Qwen 2.5 · 7B (best)', gb: 15.3, minRamGb: 32 },
};
const ramGb = () => Math.round(os.totalmem() / 1024 ** 3);
function writerStatus() {
  const py = textPython(), ram = ramGb();
  const models = {};
  for (const [k, m] of Object.entries(WRITER_MODELS)) {
    const ready = !!snapshot(m.repo), fits = ram >= m.minRamGb;
    models[k] = { label: m.label, gb: m.gb, ready, allowed: fits,
      reason: fits ? '' : `Needs a Mac with ${m.minRamGb} GB of memory or more (this one has ${ram} GB): it would run out of memory and stall.` };
  }
  return { python: !!py, reason: py ? '' : 'The writer runs in Protoart Studio’s Python. Install Protoart Studio (or open it once) to use it.', ram, models };
}
let writerJob = null;
async function setupWriter(key, onEvent) {
  const m = WRITER_MODELS[key]; if (!m) throw new Error('Unknown model');
  const st = writerStatus();
  if (!st.python) throw new Error(st.reason);
  if (!st.models[key].allowed) throw new Error(st.models[key].reason);
  if (st.models[key].ready) return { ok: true };
  if (writerJob) throw new Error('Already downloading a writer model.');
  const free = await fs.promises.statfs(os.homedir()).then(x => x.bavail * x.bsize).catch(() => Infinity);
  if (free < m.gb * 1.2e9) throw new Error(`Not enough free disk space: it needs about ${m.gb} GB (${(free / 1e9).toFixed(0)} GB free now).`);
  const repoDir = path.join(hubCache(), 'models--' + m.repo.replace('/', '--'));
  const job = writerJob = { cancelled: false, proc: null };
  try {
    const env = { HOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1', HF_HUB_CACHE: hubCache(), HF_HUB_DISABLE_TELEMETRY: '1' };
    await new Promise((resolve, reject) => {
      const proc = job.proc = spawn(textPython(), ['-I', path.join(SCRIPTS, 'reel_fetch.py'), hubCache(), m.repo, 'main'], { cwd: SCRIPTS, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      proc.stdout.on('data', d => { out += d; });
      proc.stderr.on('data', d => { err = (err + d).slice(-3000); });
      const timer = setInterval(async () => {
        const n = await folderBytes(repoDir);
        onEvent({ type: 'writerSetup', key, f: Math.min(0.99, n / (m.gb * 1e9)), msg: `Downloading ${m.label}… ${(n / 1e9).toFixed(1)} of ${m.gb} GB` });
      }, 1500);
      proc.on('exit', code => {
        clearInterval(timer);
        if (job.cancelled) return reject(new Error('Stopped'));
        const last = out.trim().split('\n').pop() || '';
        let msg = null; try { msg = JSON.parse(last); } catch { /* none */ }
        if (code === 0 && msg && msg.type === 'fetched') return resolve();
        reject(new Error(`Download failed: ${(msg && msg.msg) || err.split('\n').filter(Boolean).pop() || 'unknown error'}`));
      });
    });
    if (!snapshot(m.repo)) throw new Error('The download finished but the model files are incomplete. Try again.');
    onEvent({ type: 'writerSetup', key, f: 1, msg: `${m.label} is ready.` });
    return { ok: true };
  } finally { writerJob = null; }
}
function cancelWriterSetup() { if (writerJob) { writerJob.cancelled = true; try { writerJob.proc && writerJob.proc.kill('SIGTERM'); } catch { /* gone */ } } }
/** Writes with the best writer model this Mac can run (or the size asked for). Returns { text, model }. */
async function write(r, onEvent) {
  const st = writerStatus();
  if (!st.python) throw new Error(st.reason);
  const order = r.size && WRITER_MODELS[r.size] ? [r.size, 'large', 'medium', 'small'] : ['large', 'medium', 'small'];
  const key = order.find(k => st.models[k].ready && st.models[k].allowed);
  if (!key) throw new Error('No writer model yet: choose a size and press GET to download it.');
  if (!text) text = new Helper('Prompt writer', textPython(), path.join(SCRIPTS, 'reel_text.py'));
  const ev = await text.request({ cmd: 'write', model: snapshot(WRITER_MODELS[key].repo), system: r.system, prompt: r.prompt, max_tokens: r.maxTokens, temperature: r.temperature }, onEvent, ['done']);
  touch(text);
  return { text: typeof ev.text === 'string' ? ev.text.slice(0, 20000) : '', model: WRITER_MODELS[key].label };
}

// other engines (the Kitten voices) stop with these, so recording and export get the memory back too
const stoppers = new Set();
function onStop(fn) { stoppers.add(fn); }
function stopAll() { for (const t of idleTimers.values()) clearTimeout(t); if (ernie) ernie.stop(); if (flux) flux.stop(); if (text) text.stop(); for (const f of stoppers) { try { f(); } catch { /* fine */ } } }

module.exports = { Helper, hubCache, textPython, mlxPython, folderBytes, onStop, listLoras, status, generate, cancel, suggest, stopAll, release, setupFlux, cancelSetup, setUserData, SMALL_MAC, simplePrompt, STYLE_WORDS, writerStatus, setupWriter, cancelWriterSetup, write, WRITER_MODELS };
