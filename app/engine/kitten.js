// Kitten voices: natural speech from text with KittenTTS 2 (KittenML, Apache 2.0) on this Mac's graphics chip.
// 115 built-in voices (characters and 20 languages), emotion and delivery control, and voices cloned from a
// recording the person makes (their own voice, to fix a line without re-recording).
//
// Unlike the picture engines (borrowed from Protoart Studio), this one is installed by Reel itself, once, when the
// person presses GET KITTEN VOICES: a Python environment of its own in Reel's Application Support folder (made
// from a Python 3.10+ already on the Mac, so Studio's environments are never touched), the package pinned to one
// reviewed commit, then the model into the shared Hugging Face cache. After that it runs offline.
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ai = require('./ai');

const COMMIT = 'b9517e3050adced306219f8bea5f117d87ecfaa7'; // KittenML/KittenTTS, Oct 26 2026 (kittenml 0.9.7)
const PACKAGE = `kittenml[mlx] @ https://github.com/KittenML/KittenTTS/archive/${COMMIT}.tar.gz`;
const MODEL_REPOS = ['KittenML/kitten-tts-2', 'ResembleAI/chatterbox-turbo'];
const SCRIPT = path.join(__dirname, '..', 'ai', 'reel_kitten.py');
const DOWNLOAD_GB = 3.2; // Python packages (~1.3 GB) and the model and its decoder (~1.9 GB)
const MIN_RAM_GB = 8;
const HOME = os.homedir();

let root = null; // <userData>/Kitten
const dirs = () => ({ root, venv: path.join(root, 'python'), voices: path.join(root, 'My Voices') });
function setUserData(dir) { root = path.join(dir, 'Kitten'); }
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const venvPython = () => path.join(dirs().venv, 'bin', 'python');
const marker = () => path.join(dirs().venv, '.reel-installed');
const ramGb = () => Math.round(os.totalmem() / 1024 ** 3);

/** A Python 3.10+ for Apple silicon already on this Mac to make the environment from (best versions first). */
function basePython() {
  const fw = '/Library/Frameworks/Python.framework/Versions';
  const cands = [
    ...['3.12', '3.11', '3.13', '3.10'].flatMap(v => [`/opt/homebrew/bin/python${v}`, `${fw}/${v}/bin/python3`, `/usr/local/bin/python${v}`]),
    ai.textPython(), ai.mlxPython(), '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3',
  ].filter(Boolean);
  const seen = new Set(), found = [];
  for (const p of cands) {
    let real; try { real = fs.realpathSync(p); } catch { continue; }
    if (seen.has(real)) continue; seen.add(real);
    const r = spawnSync(p, ['-I', '-c', 'import sys,platform;print(sys.version_info[0],sys.version_info[1],platform.machine())'],
      { timeout: 15000, encoding: 'utf8', env: { HOME, PATH: '/usr/bin:/bin' } });
    const m = /^(\d+) (\d+) (\S+)/.exec(String(r.stdout || '').trim());
    if (!m || r.status !== 0) continue;
    const ver = [Number(m[1]), Number(m[2])];
    if (m[3] !== 'arm64' || ver[0] !== 3 || ver[1] < 10) continue;
    found.push({ path: p, version: `${ver[0]}.${ver[1]}`, rank: [12, 11, 13, 10].indexOf(ver[1]) < 0 ? 9 : [12, 11, 13, 10].indexOf(ver[1]) });
  }
  found.sort((a, b) => a.rank - b.rank);
  return found[0] || null;
}

function installedInfo() { try { return JSON.parse(fs.readFileSync(marker(), 'utf8')); } catch { return null; } }
function modelReady() {
  return MODEL_REPOS.every(repo => {
    const snaps = path.join(ai.hubCache(), 'models--' + repo.replace('/', '--'), 'snapshots');
    try { return fs.readdirSync(snaps).length > 0; } catch { return false; }
  });
}

function status() {
  const ram = ramGb(), arm = process.arch === 'arm64';
  const info = root && installedInfo();
  const pyOk = !!(info && info.commit === COMMIT && exists(safeReal(venvPython())));
  const ready = !!(pyOk && info.model && modelReady());
  const reason = !arm ? 'Kitten voices need a Mac with Apple silicon (M1 or newer).'
    : ram < MIN_RAM_GB ? `Kitten voices need ${MIN_RAM_GB} GB of memory or more.` : '';
  return {
    ready, installed: pyOk, allowed: !reason, reason, setting: !!setupJob, gb: DOWNLOAD_GB, ram,
    tight: ram <= 8, // works, but close other apps; the model is unloaded soon after use
    voices: ready ? (info.voices || []) : [],
  };
}
function safeReal(p) { try { return fs.realpathSync(p); } catch { return '/nonexistent'; } }

// ---------------------------------------------------------------- one-time setup
let setupJob = null;
function run(cmd, args, { env, onLine, job }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (job) job.proc = proc;
    let tail = '', buf = '';
    const take = d => {
      tail = (tail + d).slice(-6000); buf += d;
      let i; while ((i = buf.search(/[\r\n]/)) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l && onLine) onLine(l); }
    };
    proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', take); proc.stderr.on('data', take);
    proc.on('error', reject);
    proc.on('exit', code => {
      if (job) job.proc = null;
      if (job && job.cancelled) return reject(new Error('Stopped'));
      if (code === 0) resolve(tail);
      else {
        const lines = tail.split('\n').map(l => l.trim()).filter(Boolean);
        const err = lines.reverse().find(l => /error|failed|no matching|could not|not found|Traceback/i.test(l)) || lines[0] || `exit ${code}`;
        reject(Object.assign(new Error(err.slice(0, 400)), { tail }));
      }
    });
  });
}

async function setup(onEvent) {
  const st = status();
  if (!st.allowed) throw new Error(st.reason);
  if (st.ready) return { ok: true };
  if (setupJob) throw new Error('Already setting up the Kitten voices.');
  const free = await fs.promises.statfs(HOME).then(x => x.bavail * x.bsize).catch(() => Infinity);
  if (free < 6e9) throw new Error(`Not enough free disk space: Kitten voices need about 5 GB while installing (${(free / 1e9).toFixed(0)} GB free now).`);
  const job = setupJob = { cancelled: false, proc: null };
  const say = (f, msg) => onEvent({ type: 'kittenSetup', f, msg });
  const { venv } = dirs();
  const env = { HOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1', HF_HUB_CACHE: ai.hubCache(), HF_HUB_DISABLE_TELEMETRY: '1', PYTORCH_ENABLE_MPS_FALLBACK: '1' };
  try {
    let info = installedInfo();
    if (!(info && info.commit === COMMIT && exists(safeReal(venvPython())))) {
      const base = basePython();
      if (!base) throw new Error('Kitten voices need Python 3.10 or newer, and none was found on this Mac. Install Protoart Studio, or Python from python.org (3.12), then press GET again.');
      say(0.02, `Making a Python ${base.version} environment for the voices…`);
      await fs.promises.rm(venv, { recursive: true, force: true });
      await fs.promises.mkdir(path.dirname(venv), { recursive: true });
      await run(base.path, ['-I', '-m', 'venv', venv], { env, job });
      say(0.05, 'Updating the installer…');
      await run(venvPython(), ['-I', '-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'], { env, job });
      // pip's own lines ("Collecting torch", "Downloading … 74.3 MB") drive the bar: about 45 packages in all
      let n = 0;
      await run(venvPython(), ['-I', '-m', 'pip', 'install', '--prefer-binary', PACKAGE], { env, job, onLine: l => {
        const m = /^(Collecting|Downloading|Installing collected packages|Building wheel)\s*(\S*)/.exec(l);
        if (!m) return;
        if (m[1] === 'Collecting') n++;
        const what = m[1] === 'Installing collected packages' ? 'Installing the packages (a minute or two)…'
          : m[1] === 'Building wheel' ? `Building ${m[2].replace(/[^\w.-]/g, '')}…` : `Getting ${m[2].replace(/[^\w.\-[\]]/g, '').slice(0, 40)}…`;
        say(0.06 + Math.min(0.5, n / 45 * 0.5), what);
      } });
      info = { commit: COMMIT, python: base.version, at: new Date().toISOString() };
      await fs.promises.writeFile(marker(), JSON.stringify(info));
    }
    // the model: downloaded by loading it once, then checked by speaking one line
    say(0.58, 'Downloading the voice model…');
    const repoDirs = MODEL_REPOS.map(r => path.join(ai.hubCache(), 'models--' + r.replace('/', '--')));
    const timer = setInterval(async () => {
      let b = 0; for (const d of repoDirs) b += await ai.folderBytes(d);
      say(0.58 + Math.min(0.37, b / 1.9e9 * 0.37), `Downloading the voice model… ${(b / 1e9).toFixed(1)} of about 1.9 GB`);
    }, 1500);
    const test = path.join(os.tmpdir(), `reel-kitten-test-${process.pid}.wav`);
    let out;
    try { out = await run(venvPython(), ['-I', SCRIPT, '--setup', test], { env, job }); }
    finally { clearInterval(timer); fs.promises.rm(test, { force: true }).catch(() => {}); }
    let ready = null;
    for (const l of out.split('\n')) { try { const m = JSON.parse(l); if (m.type === 'ready') ready = m; else if (m.type === 'error') throw new Error(m.msg); } catch (e) { if (!(e instanceof SyntaxError)) throw e; } }
    if (!ready) throw new Error('The voice model didn’t answer its test. Try again.');
    info.model = true; info.voices = ready.voices.filter(v => typeof v === 'string' && v.length < 60).slice(0, 400);
    await fs.promises.writeFile(marker(), JSON.stringify(info));
    say(1, 'Kitten voices are ready.');
    return { ok: true };
  } finally { setupJob = null; }
}
function cancelSetup() { if (setupJob) { setupJob.cancelled = true; try { setupJob.proc && setupJob.proc.kill('SIGTERM'); } catch { /* gone */ } } }

/** Removes the environment and the model (gets back ~5 GB). */
async function remove() {
  stop();
  await fs.promises.rm(dirs().venv, { recursive: true, force: true });
  for (const r of MODEL_REPOS) await fs.promises.rm(path.join(ai.hubCache(), 'models--' + r.replace('/', '--')), { recursive: true, force: true });
  return true;
}

// ---------------------------------------------------------------- speaking
let helper = null, idle = null, queue = Promise.resolve();
const IDLE_MS = ai.SMALL_MAC ? 90 * 1000 : 10 * 60 * 1000;
function stop() { clearTimeout(idle); if (helper) helper.stop(); helper = null; }
ai.onStop(stop);

/** Speaks `text` into `out` (a 48 kHz WAV). voice: a built-in name, or { file, text } for a saved voice. */
let cancelled = false;
/** Stops the speech being made (the model is unloaded; the next line loads it again). */
function cancel() { cancelled = true; stop(); }
function speak({ text, voice, mine, preset, normalize, out }, onEvent) {
  const job = queue.then(async () => {
    cancelled = false;
    const st = status();
    if (!st.ready) throw new Error('Kitten voices aren’t set up yet: press GET KITTEN VOICES.');
    if (!helper) helper = new ai.Helper('Kitten voices', venvPython(), SCRIPT);
    clearTimeout(idle);
    const req = { cmd: 'say', text, out, preset, normalize };
    if (mine) Object.assign(req, { reference: mine.file, reference_text: mine.text });
    else req.voice = st.voices.includes(voice) ? voice : 'Bruno';
    // the model stays loaded between lines (a while on big Macs), so only the first line waits for it
    onEvent({ type: 'progress', msg: helper.proc ? 'Speaking…' : 'Loading the voice model…', loading: !helper.proc });
    try { return await helper.request(req, onEvent, ['done']); }
    catch (e) { if (cancelled) throw new Error('Stopped'); throw e; }
    finally { cancelled = false; idle = setTimeout(stop, IDLE_MS); }
  });
  queue = job.catch(() => {});
  return job;
}

// ---------------------------------------------------------------- saved voices ("My Voices")
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'voice';
async function myVoices() {
  const dir = dirs().voices, out = [];
  let names = []; try { names = await fs.promises.readdir(dir); } catch { return out; }
  for (const n of names.filter(x => x.endsWith('.json'))) {
    try {
      const v = JSON.parse(await fs.promises.readFile(path.join(dir, n), 'utf8'));
      const id = n.replace(/\.json$/, '');
      if (exists(path.join(dir, id + '.wav'))) out.push({ id, name: String(v.name || id).slice(0, 60), text: String(v.text || ''), seconds: Number(v.seconds) || 0 });
    } catch { /* skip */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
async function myVoice(id) {
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,48}$/.test(id)) return null;
  const v = (await myVoices()).find(x => x.id === id);
  return v ? { ...v, file: path.join(dirs().voices, id + '.wav') } : null;
}
/** Saves a recording (mono float samples) and what it says as a voice to clone. */
async function saveVoice(name, samples, rate, text) {
  const nm = String(name || '').trim().slice(0, 60);
  if (!nm) throw new Error('Give the voice a name.');
  if (!(samples instanceof Float32Array)) throw new Error('Bad recording');
  const r = Math.round(Number(rate));
  if (!(r >= 8000 && r <= 192000)) throw new Error('Bad sample rate');
  const secs = samples.length / r;
  if (secs < 4 || secs > 31) throw new Error('A voice needs 5 to 30 seconds of one person speaking.');
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (t.split(' ').length < 4) throw new Error('No speech was heard in that part. Pick a part where the person is talking.');
  await fs.promises.mkdir(dirs().voices, { recursive: true });
  let id = slug(nm), k = 2;
  while (exists(path.join(dirs().voices, id + '.json'))) id = `${slug(nm)}-${k++}`;
  const wav = Buffer.alloc(44 + samples.length * 4);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples.length * 4, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(3, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(r, 24);
  wav.writeUInt32LE(r * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(32, 34); wav.write('data', 36); wav.writeUInt32LE(samples.length * 4, 40);
  Buffer.from(samples.buffer, samples.byteOffset, samples.length * 4).copy(wav, 44);
  await fs.promises.writeFile(path.join(dirs().voices, id + '.wav'), wav);
  await fs.promises.writeFile(path.join(dirs().voices, id + '.json'), JSON.stringify({ name: nm, text: t, seconds: Math.round(secs * 10) / 10, at: new Date().toISOString() }));
  return { id, name: nm, text: t, seconds: secs };
}
/** Moves a saved voice to the Trash (it's the person's own recording, so never deleted outright). */
async function deleteVoice(id, trash) {
  const v = await myVoice(id); if (!v) return false;
  for (const ext of ['.wav', '.json']) await trash(path.join(dirs().voices, id + ext));
  return true;
}

module.exports = { setUserData, status, setup, cancelSetup, remove, speak, cancel, stop, myVoices, myVoice, saveVoice, deleteVoice, COMMIT, basePython, run };
