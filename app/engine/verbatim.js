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
// pinned to versions that work together: the newest Transformers changed how Whisper keeps its cache, and setup
// failed with "'EncoderDecoderCache' object has no attribute 'layers'" (CrisperWhisper works with any 4.40 and up)
const PINS = ['transformers==4.49.0', 'torch==2.5.1', 'accelerate==1.2.1'];
const INSTALL = `${RELEASE}+${PINS.join(',')}`; // what an environment was made with: a change makes it again
const SCRIPT = path.join(__dirname, '..', 'ai', 'reel_verbatim.py');
// the best that fits: large on 16 GB and up, turbo (nearly as good, faster) below
const MODELS = {
  large: { repo: 'nyralabs/CrisperWhisper2.0_large', label: 'Large (most accurate)', gb: 6.2, minRamGb: 16 },
  turbo: { repo: 'nyralabs/CrisperWhisper2.0_turbo', label: 'Turbo (fast, nearly as accurate)', gb: 3.3, minRamGb: 8 },
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
  const installed = !!(i && i.release === INSTALL && exists(safeReal(py())));
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
    PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1', HF_HUB_CACHE: ai.hubCache(), HF_HUB_DISABLE_TELEMETRY: '1', PYTORCH_ENABLE_MPS_FALLBACK: '1',
    // a plain download into the model's own folder (Hugging Face's newer "Xet" one fills a cache elsewhere first, so
    // the bar sat at 0.0 GB until the very end, looking frozen)
    HF_HUB_DISABLE_XET: '1' };
  try {
    let i = info();
    if (!(i && i.release === INSTALL && exists(safeReal(py())))) {
      const base = kitten.basePython();
      if (!base) throw new Error('Word-for-word speech needs Python 3.10 or newer, and none was found on this Mac. Install Python from python.org (3.12), then press GET again.');
      say(0.02, `Making a Python ${base.version} environment…`);
      await fs.promises.rm(venv(), { recursive: true, force: true });
      await fs.promises.mkdir(root, { recursive: true });
      await kitten.run(base.path, ['-I', '-m', 'venv', venv()], { env, job });
      say(0.05, 'Updating the installer…');
      await kitten.run(py(), ['-I', '-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'], { env, job });
      let n = 0;
      await kitten.run(py(), ['-I', '-m', 'pip', 'install', '--prefer-binary', PACKAGE, ...PINS], { env, job, onLine: l => {
        const r = /^(Collecting|Downloading|Installing collected packages)\s*(\S*)/.exec(l); if (!r) return;
        if (r[1] === 'Collecting') n++;
        say(0.06 + Math.min(0.34, n / 40 * 0.34), r[1].startsWith('Installing') ? 'Installing the packages (PyTorch is the big one)…' : `Getting ${r[2].replace(/[^\w.\-[\]]/g, '').slice(0, 40)}…`);
      } });
      i = { release: INSTALL, python: base.version, models: {}, at: new Date().toISOString() };
      await fs.promises.writeFile(marker(), JSON.stringify(i));
    }
    say(0.42, `Downloading the ${m.label.split(' (')[0].toLowerCase()} model…`);
    const dir = path.join(ai.hubCache(), 'models--' + m.repo.replace('/', '--'));
    let last = -1, still = Date.now();
    const timer = setInterval(async () => {
      const b = await ai.folderBytes(dir);
      if (b !== last) { last = b; still = Date.now(); }
      // nothing new for three minutes: say so (it carries on where it left off when started again)
      const stuck = Date.now() - still > 180000;
      say(0.42 + Math.min(0.5, b / (m.gb * 1e9) * 0.5), stuck ? `The download hasn’t moved for a few minutes (${(b / 1e9).toFixed(1)} GB so far). Check the internet; STOP and GET again carries on from there.` : `Downloading the model… ${(b / 1e9).toFixed(1)} of about ${m.gb} GB`);
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
    if (!helper) {
      // on an 8 or 16 GB Mac, the other AI models out of memory first: short of memory, the speech model crawls
      ai.release();
      helper = new ai.Helper('Word-for-word speech', py(), SCRIPT);
    }
    clearTimeout(idle);
    try {
      const r = await helper.request({ cmd: 'transcribe', src, from, to, model: st.use, language: language || 'en' }, onEvent, ['done']);
      return { words: r.words || [], model: st.use, seconds: r.seconds, audio: r.audio, device: r.device };
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

// What's been written down of a recording, as seconds [[from, to]…] (sorted, merged): only the parts used get transcribed
const NEAR = 0.25; // gaps shorter than this count as done
function addRange(have, a, b) {
  const all = [...(have || []), [a, b]].filter(r => r[1] > r[0]).sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const r of all) { const l = out[out.length - 1]; if (l && r[0] <= l[1] + NEAR) l[1] = Math.max(l[1], r[1]); else out.push([r[0], r[1]]); }
  return out;
}
/** The parts of [a, b] not written down yet. */
function missing(have, a, b) {
  const gaps = []; let at = a;
  for (const [p, q] of have || []) { if (q <= at) continue; if (p >= b) break; if (p > at + NEAR) gaps.push([at, Math.min(p, b)]); at = Math.max(at, q); if (at >= b) break; }
  if (b > at + NEAR) gaps.push([at, b]);
  return gaps;
}

module.exports = { addRange, missing, setUserData, status, setup, cancelSetup, transcribe, cancel, stop, remove, MODELS, RELEASE };
