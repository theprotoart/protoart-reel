// Word-for-word speech ("verbatim"): nyra's CrisperWhisper 2.0, run on this Mac (PyTorch on the graphics chip), which
// writes down every um and uh with its timing to the word, where ordinary speech recognition leaves them out. Set up
// once by GET WORD-FOR-WORD SPEECH, the same way as sound separation: a Python environment of Reel's own with the
// CrisperWhisper package pinned to one reviewed commit, the model in the shared Hugging Face cache. Then offline.
// The model's weights are nyra health's, under their non-commercial licence (see THIRD_PARTY_NOTICES).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ai = require('./ai');
const kitten = require('./kitten');

const RELEASE = '9b9679a19018bcb64119a6ed867818fd930c6e9c'; // nyrahealth/CrisperWhisper 2.x
const PACKAGE = `crisperwhisper[transformers] @ https://github.com/nyrahealth/CrisperWhisper/archive/${RELEASE}.tar.gz`;
const SCRIPT = path.join(__dirname, '..', 'ai', 'reel_verbatim.py');
// the best that fits: large on 16 GB and up, turbo (nearly as good, faster) below
const MODELS = {
  large: { repo: 'nyralabs/CrisperWhisper2.0_large', label: 'Large (most accurate)', gb: 3.2, minRamGb: 16 },
  turbo: { repo: 'nyralabs/CrisperWhisper2.0_turbo', label: 'Turbo (fast, nearly as accurate)', gb: 1.7, minRamGb: 8 },
};
const HOME = os.homedir();
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
const safeReal = p => { try { return fs.realpathSync(p); } catch { return '/nonexistent'; } };
const ramGb = () => Math.round(os.totalmem() / 1024 ** 3);

let root = null;
function setUserData(dir) { root = path.join(dir, 'Verbatim Speech'); }
const venv = () => path.join(root, 'python');
const py = () => path.join(venv(), 'bin', 'python');
const marker = () => path.join(venv(), '.reel-installed');
function info() { try { return JSON.parse(fs.readFileSync(marker(), 'utf8')); } catch { return null; } }
const cached = repo => { try { return fs.readdirSync(path.join(ai.hubCache(), 'models--' + repo.replace('/', '--'), 'snapshots')).length > 0; } catch { return false; } };

/** The best model this Mac can run. */
function best() { const ram = ramGb(); return Object.keys(MODELS).find(k => ram >= MODELS[k].minRamGb) || null; }

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
  const reason = !arm ? 'Word-for-word speech needs a Mac with Apple silicon (M1 or newer).' : '';
  const use = Object.keys(MODELS).find(k => models[k].ready && models[k].allowed) || null;
  return { allowed: !reason, reason, installed, setting: !!job, ram, models, best: best(), use, ready: !!use };
}

let job = null;
async function setup(key, onEvent) {
  key = key && MODELS[key] ? key : best();
  const m = MODELS[key]; if (!m) throw new Error('This Mac hasn’t enough memory for word-for-word speech.');
  const st = status();
  if (!st.allowed) throw new Error(st.reason);
  if (!st.models[key].allowed) throw new Error(st.models[key].reason);
  if (st.models[key].ready) return { ok: true, model: key };
  if (job) throw new Error('Already setting up word-for-word speech.');
  const free = await fs.promises.statfs(HOME).then(x => x.bavail * x.bsize).catch(() => Infinity);
  if (free < (m.gb + 4) * 1e9) throw new Error(`Not enough free disk space: it needs about ${Math.ceil(m.gb + 3)} GB while installing (${(free / 1e9).toFixed(0)} GB free now).`);
  job = { cancelled: false, proc: null };
  const say = (f, msg) => onEvent({ type: 'verbatimSetup', f, msg });
  const env = { HOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1', HF_HUB_CACHE: ai.hubCache(), HF_HUB_DISABLE_TELEMETRY: '1', PYTORCH_ENABLE_MPS_FALLBACK: '1' };
  try {
    let i = info();
    if (!(i && i.release === RELEASE && exists(safeReal(py())))) {
      const base = kitten.basePython();
      if (!base) throw new Error('Word-for-word speech needs Python 3.10 or newer, and none was found on this Mac. Install Python from python.org (3.12), then press GET again.');
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
        say(0.06 + Math.min(0.34, n / 40 * 0.34), r[1].startsWith('Installing') ? 'Installing the packages (PyTorch is the big one)…' : `Getting ${r[2].replace(/[^\w.\-[\]]/g, '').slice(0, 40)}…`);
      } });
      i = { release: RELEASE, python: base.version, models: {}, at: new Date().toISOString() };
      await fs.promises.writeFile(marker(), JSON.stringify(i));
    }
    say(0.42, `Downloading the ${m.label.split(' (')[0].toLowerCase()} model…`);
    const dir = path.join(ai.hubCache(), 'models--' + m.repo.replace('/', '--'));
    const timer = setInterval(async () => {
      const b = await ai.folderBytes(dir);
      say(0.42 + Math.min(0.5, b / (m.gb * 1e9) * 0.5), `Downloading the model… ${(b / 1e9).toFixed(1)} of about ${m.gb} GB`);
    }, 1500);
    let out;
    try { out = await kitten.run(py(), ['-I', SCRIPT, '--setup', key], { env, job }); }
    finally { clearInterval(timer); }
    let ok = false;
    for (const l of out.split('\n')) { try { const x = JSON.parse(l); if (x.type === 'ready') ok = true; else if (x.type === 'error') throw new Error(x.msg); } catch (e) { if (!(e instanceof SyntaxError)) throw e; } }
    if (!ok) throw new Error('The speech model didn’t pass its test. Try again.');
    i.models = { ...(i.models || {}), [key]: true };
    await fs.promises.writeFile(marker(), JSON.stringify(i));
    say(1, 'Word-for-word speech is ready.');
    return { ok: true, model: key };
  } finally { job = null; }
}
function cancelSetup() { if (job) { job.cancelled = true; try { job.proc && job.proc.kill('SIGTERM'); } catch { /* gone */ } } }

let helper = null, idle = null, queue = Promise.resolve(), cancelled = false;
const IDLE_MS = ai.SMALL_MAC ? 90 * 1000 : 10 * 60 * 1000;
function stop() { clearTimeout(idle); if (helper) helper.stop(); helper = null; }
function cancel() { cancelled = true; stop(); }
ai.onStop(stop);

/** Every word said in [from, to] seconds of the WAV `src`: { words: [[start, end, word]…], model }. */
function transcribe({ src, from, to, language }, onEvent) {
  const run = queue.then(async () => {
    cancelled = false;
    const st = status();
    if (!st.use) throw new Error('Word-for-word speech isn’t set up yet: press GET WORD-FOR-WORD SPEECH.');
    if (!helper) helper = new ai.Helper('Word-for-word speech', py(), SCRIPT);
    clearTimeout(idle);
    try {
      const r = await helper.request({ cmd: 'transcribe', src, from, to, model: st.use, language: language || 'en' }, onEvent, ['done']);
      return { words: r.words || [], model: st.use, seconds: r.seconds };
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

module.exports = { setUserData, status, setup, cancelSetup, transcribe, cancel, stop, remove, MODELS, RELEASE };
