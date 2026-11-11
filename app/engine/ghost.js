// Sound separation ("Isolate a sound"): describe a sound in words and pull it out of a clip, or take it out, with
// Meta's SAM-Audio run on this Mac's graphics chip by mlx-audio. The idea of AudioGhost AI, made for Apple silicon
// (AudioGhost itself needs an NVIDIA graphics card). Set up once by GET SOUND SEPARATION, the same way as the Kitten
// voices: a Python environment of Reel's own, mlx-audio pinned to one reviewed release, the model in the shared
// Hugging Face cache. Then offline.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ai = require('./ai');
const kitten = require('./kitten');

const RELEASE = '1157775c1999654b1ebde41ed03d88108e23f88b'; // Blaizzy/mlx-audio v0.6.5
const PACKAGE = `mlx-audio @ https://github.com/Blaizzy/mlx-audio/archive/${RELEASE}.tar.gz`;
const SCRIPT = path.join(__dirname, '..', 'ai', 'reel_ghost.py');
const T5 = 't5-base'; // SAM-Audio's text encoder, fetched by mlx-audio
// Meta's SAM-Audio, as converted for MLX by mlx-community (not gated). SAM License: see THIRD_PARTY_NOTICES.
const MODELS = {
  small: { repo: 'mlx-community/sam-audio-small-fp16', label: 'Small (fast, 1.2 GB)', gb: 2.2, minRamGb: 8 },
  large: { repo: 'mlx-community/sam-audio-large-fp16', label: 'Large (best, 6.1 GB)', gb: 7.0, minRamGb: 32 },
};
const HOME = os.homedir();
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const safeReal = p => { try { return fs.realpathSync(p); } catch { return '/nonexistent'; } };
const ramGb = () => Math.round(os.totalmem() / 1024 ** 3);

let root = null;
function setUserData(dir) { root = path.join(dir, 'Sound Separation'); }
const venv = () => path.join(root, 'python');
const py = () => path.join(venv(), 'bin', 'python');
const marker = () => path.join(venv(), '.reel-installed');
function info() { try { return JSON.parse(fs.readFileSync(marker(), 'utf8')); } catch { return null; } }
const cached = repo => { try { return fs.readdirSync(path.join(ai.hubCache(), 'models--' + repo.replace('/', '--'), 'snapshots')).length > 0; } catch { return false; } };

function status() {
  const ram = ramGb(), arm = process.arch === 'arm64';
  const i = root && info();
  const installed = !!(i && i.release === RELEASE && exists(safeReal(py())));
  const models = {};
  for (const [k, m] of Object.entries(MODELS)) {
    const fits = ram >= m.minRamGb;
    models[k] = { label: m.label, gb: m.gb, ready: installed && !!(i.models || {})[k] && cached(m.repo), allowed: fits,
      reason: fits ? '' : `Needs a Mac with ${m.minRamGb} GB of memory or more (this one has ${ram} GB).` };
  }
  const reason = !arm ? 'Sound separation needs a Mac with Apple silicon (M1 or newer).' : '';
  return { allowed: !reason, reason, installed, setting: !!job, ram, models,
    ready: Object.values(models).some(m => m.ready && m.allowed) };
}

let job = null;
async function setup(key, onEvent) {
  const m = MODELS[key]; if (!m) throw new Error('Unknown model');
  const st = status();
  if (!st.allowed) throw new Error(st.reason);
  if (!st.models[key].allowed) throw new Error(st.models[key].reason);
  if (st.models[key].ready) return { ok: true };
  if (job) throw new Error('Already setting up sound separation.');
  const free = await fs.promises.statfs(HOME).then(x => x.bavail * x.bsize).catch(() => Infinity);
  if (free < (m.gb + 3) * 1e9) throw new Error(`Not enough free disk space: it needs about ${Math.ceil(m.gb + 2)} GB while installing (${(free / 1e9).toFixed(0)} GB free now).`);
  job = { cancelled: false, proc: null };
  const say = (f, msg) => onEvent({ type: 'ghostSetup', f, msg });
  const env = { HOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1', HF_HUB_CACHE: ai.hubCache(), HF_HUB_DISABLE_TELEMETRY: '1' };
  try {
    let i = info();
    if (!(i && i.release === RELEASE && exists(safeReal(py())))) {
      const base = kitten.basePython();
      if (!base) throw new Error('Sound separation needs Python 3.10 or newer, and none was found on this Mac. Install Protoart Studio, or Python from python.org (3.12), then press GET again.');
      say(0.02, `Making a Python ${base.version} environment…`);
      await fs.promises.rm(venv(), { recursive: true, force: true });
      await fs.promises.mkdir(root, { recursive: true });
      await kitten.run(base.path, ['-I', '-m', 'venv', venv()], { env, job });
      say(0.05, 'Updating the installer…');
      await kitten.run(py(), ['-I', '-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'], { env, job });
      let n = 0;
      await kitten.run(py(), ['-I', '-m', 'pip', 'install', '--prefer-binary', PACKAGE], { env, job, onLine: l => {
        const r = /^(Collecting|Downloading|Installing collected packages)\s*(\S*)/.exec(l); if (!r) return;
        if (r[1] === 'Collecting') n++;
        say(0.06 + Math.min(0.34, n / 40 * 0.34), r[1].startsWith('Installing') ? 'Installing the packages…' : `Getting ${r[2].replace(/[^\w.\-[\]]/g, '').slice(0, 40)}…`);
      } });
      i = { release: RELEASE, python: base.version, models: {}, at: new Date().toISOString() };
      await fs.promises.writeFile(marker(), JSON.stringify(i));
    }
    say(0.42, `Downloading the ${m.label.split(' (')[0].toLowerCase()} model…`);
    const dirs = [m.repo, T5].map(r => path.join(ai.hubCache(), 'models--' + r.replace('/', '--')));
    const timer = setInterval(async () => {
      let b = 0; for (const d of dirs) b += await ai.folderBytes(d);
      say(0.42 + Math.min(0.5, b / (m.gb * 1e9) * 0.5), `Downloading the model… ${(b / 1e9).toFixed(1)} of about ${m.gb} GB`);
    }, 1500);
    const test = path.join(os.tmpdir(), `reel-ghost-test-${process.pid}.wav`);
    let out;
    try { out = await kitten.run(py(), ['-I', SCRIPT, '--setup', m.repo, test], { env, job }); }
    finally { clearInterval(timer); fs.promises.rm(test, { force: true }).catch(() => {}); }
    let ok = false;
    for (const l of out.split('\n')) { try { const x = JSON.parse(l); if (x.type === 'ready') ok = true; else if (x.type === 'error') throw new Error(x.msg); } catch (e) { if (!(e instanceof SyntaxError)) throw e; } }
    if (!ok) throw new Error('The separation model didn’t pass its test. Try again.');
    i.models = { ...(i.models || {}), [key]: true };
    await fs.promises.writeFile(marker(), JSON.stringify(i));
    say(1, 'Sound separation is ready.');
    return { ok: true };
  } finally { job = null; }
}
function cancelSetup() { if (job) { job.cancelled = true; try { job.proc && job.proc.kill('SIGTERM'); } catch { /* gone */ } } }

let helper = null, idle = null, queue = Promise.resolve(), cancelled = false;
const IDLE_MS = ai.SMALL_MAC ? 90 * 1000 : 10 * 60 * 1000;
function stop() { clearTimeout(idle); if (helper) helper.stop(); helper = null; }
function cancel() { cancelled = true; stop(); }
ai.onStop(stop);

/** Separates `prompt` out of [from, to] seconds of the WAV `src`, into `target` (the sound) and `residual` (the rest). */
function separate({ src, from, to, prompt, size, quality, target, residual }, onEvent) {
  const run = queue.then(async () => {
    cancelled = false;
    const st = status();
    const order = size && MODELS[size] ? [size, 'large', 'small'] : ['large', 'small'];
    const key = order.find(k => st.models[k]?.ready && st.models[k]?.allowed);
    if (!key) throw new Error('Sound separation isn’t set up yet: press GET SOUND SEPARATION.');
    if (!helper) helper = new ai.Helper('Sound separation', py(), SCRIPT);
    clearTimeout(idle);
    try {
      return { ...(await helper.request({ cmd: 'separate', src, from, to, prompt, model: MODELS[key].repo, quality, target, residual }, onEvent, ['done'])), model: MODELS[key].label };
    } catch (e) { if (cancelled) throw new Error('Stopped'); throw e; } finally { cancelled = false; idle = setTimeout(stop, IDLE_MS); }
  });
  queue = run.catch(() => {});
  return run;
}

async function remove() {
  stop();
  await fs.promises.rm(venv(), { recursive: true, force: true });
  for (const m of Object.values(MODELS)) await fs.promises.rm(path.join(ai.hubCache(), 'models--' + m.repo.replace('/', '--')), { recursive: true, force: true });
  return true;
}

module.exports = { setUserData, status, setup, cancelSetup, separate, cancel, stop, remove, MODELS, RELEASE };
