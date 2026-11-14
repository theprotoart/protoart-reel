// Security checks for the audit in SECURITY.md: each test tries the attack, or pins down the setting that stops it,
// so a later change that weakens one fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const require = createRequire(import.meta.url);
const validate = require('../app/validate.js');
const main = read('app/main.js');

test('path traversal: media names cannot leave the project media folder', () => {
  for (const bad of ['../project.json', '..', '../../.ssh/id_rsa', '/etc/passwd', 'a/b.mp4', 'a\\b.mp4', '.hidden', 'x\u0000.mp4', '', 'a'.repeat(256), 'clip..mp4/..']) {
    assert.equal(validate.mediaName(bad), false, JSON.stringify(bad));
  }
  assert.equal(validate.mediaName('Screen 10.09 PM.mp4'), true);
});

test('path traversal: the app:// server only serves the editor’s own files by a strict pattern', () => {
  const src = /const EDITOR_FILES = (\/.+\/);/.exec(main)[1];
  const EDITOR_FILES = eval(src); // the pattern itself, copied from main.js
  for (const bad of ['/renderer/../main.js', '/main.js', '/preload.js', '/renderer/x.js.map', '/renderer/sub/x.js', '/../package.json', '/renderer/%2e%2e/main.js', '/ai/reel_text.py', '/renderer/index.html?x']) {
    assert.equal(EDITOR_FILES.test(bad), false, bad);
  }
  assert.equal(EDITOR_FILES.test('/renderer/index.html'), true);
  assert.equal(EDITOR_FILES.test('/renderer/lib/dynzoom.js'), true);
  // and a symlink or folder in the way is refused (lstat + isFile)
  assert.match(main, /st = await fs\.promises\.lstat\(file\);\s*if \(!st\.isFile\(\)\)/);
});

test('Electron: sandboxed, isolated, no Node in the page, no navigation, no new windows, no outside requests', () => {
  const prefs = main.slice(main.indexOf('win = new BrowserWindow'), main.indexOf('if (onScreen && last.maximized)'));
  for (const s of ['contextIsolation: true', 'sandbox: true', 'nodeIntegration: false', 'nodeIntegrationInWorker: false', 'webSecurity: true', 'allowRunningInsecureContent: false']) assert.ok(prefs.includes(s), s);
  assert.ok(!/webviewTag:\s*true|enableRemoteModule|nodeIntegration:\s*true|sandbox:\s*false|contextIsolation:\s*false/.test(main));
  for (const s of ["win.webContents.on('will-navigate', e => e.preventDefault())", "setWindowOpenHandler(() => ({ action: 'deny' }))", "will-attach-webview"]) assert.ok(main.includes(s), s);
  // every request that isn't the app's own files (or blob: / data:) is cancelled
  assert.match(main, /onBeforeRequest\(\(details, callback\) => \{\s*const u = details\.url;\s*callback\(\{ cancel: !\(u\.startsWith\(`\$\{APP_ORIGIN\}\/`\) \|\| u\.startsWith\('blob:'\) \|\| u\.startsWith\('data:'\)\) \}\);/);
  // the only link opened outside is a fixed System Settings pane
  const ext = main.match(/openExternal\([^)]*\)/g) || [];
  assert.deepEqual(ext, ['openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`)']);
});

test('injection: the page allows only its own scripts (no inline script, no eval)', () => {
  for (const f of ['app/renderer/index.html', 'app/renderer/hud.html']) {
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(read(f))[1];
    const script = /script-src ([^;]+)/.exec(csp)[1];
    assert.equal(script.trim(), "'self'", f);
    assert.ok(/object-src 'none'|default-src 'none'/.test(csp) && /base-uri 'none'/.test(csp), f);
  }
  // nothing in the editor builds code from text
  const js = fs.readdirSync(path.join(root, 'app/renderer')).filter(f => f.endsWith('.js')).map(f => read('app/renderer/' + f)).join('\n');
  assert.ok(!/\beval\(|new Function\(|document\.write\(/.test(js));
});

test('bridge: every message from the page is checked to come from the editor (or the recording panel)', () => {
  const raw = main.match(/ipcMain\.(handle|on)\(/g) || [];
  // the two wrappers (handle, on), the four HUD buttons, and nothing else talks to ipcMain directly
  assert.equal(raw.length, 6, `ipcMain used directly ${raw.length} times`);
  assert.match(main, /const handle = \(channel, fn\) => ipcMain\.handle\(channel, async \(event, \.\.\.args\) => \{\s*if \(!fromEditor\(event\)\) throw new Error\('Not allowed'\);/);
  assert.equal((main.match(/ipcMain\.on\('hud:[a-z]+', event => \{ if \(fromHud\(event\)\)/g) || []).length, 4);
});

test('commands: helpers are started without a shell, so text can’t become a command', () => {
  for (const f of ['app/main.js', ...fs.readdirSync(path.join(root, 'app/engine')).map(f => 'app/engine/' + f)]) {
    const s = read(f);
    assert.ok(!/shell:\s*true/.test(s), f);
    assert.ok(!/\bexecSync\(|child_process'\)\.exec\(|\bexec\(\s*[`'"]/.test(s), f);
  }
  // speech from text goes to `say` through a file, never as an argument it could read as an option
  assert.match(main, /\['-r', String\(r\), '-f', txt, '-o', out/);
});

test('AI downloads: only the listed models, the image model at one fixed revision, weights not pickles', () => {
  const py = read('app/ai/reel_fetch.py');
  assert.match(py, /if \(repo, rev\) not in ALLOWED:/);
  assert.match(py, /"ar9av\/FLUX\.2-klein-4B-mflux-4bit", "[0-9a-f]{40}"/);
  for (const p of /TEXT_PATTERNS = \[([^\]]+)\]/.exec(py)[1].split(',')) assert.ok(!/\.(bin|pt|pth|pkl|ckpt|py)"/.test(p), p);
  // models load from the cache only, and remote code is never run
  const ai = read('app/ai/reel_text.py');
  assert.ok(ai.includes('local_files_only=True') && !/trust_remote_code\s*=\s*True/.test(ai));
  assert.ok(!/torch\.load\(|pickle\.load|allow_pickle\s*=\s*True/.test(fs.readdirSync(path.join(root, 'app/ai')).filter(f => f.endsWith('.py')).map(f => read('app/ai/' + f)).join('\n')));
  // the voice and sound-separation packages come from reviewed commits
  assert.match(read('app/engine/kitten.js'), /archive\/\$\{COMMIT\}\.tar\.gz/);
  assert.match(read('app/engine/ghost.js'), /const RELEASE = '[0-9a-f]{40}'/);
});

test('build: Electron fuses switch off Node mode, NODE_OPTIONS, the inspector and extra file:// rights', () => {
  const b = read('Build ProtoArt Reel.command');
  for (const f of ['RunAsNode=off', 'EnableNodeOptionsEnvironmentVariable=off', 'EnableNodeCliInspectArguments=off', 'GrantFileProtocolExtraPrivileges=off']) assert.ok(b.includes(f), f);
  // and exact versions, never ranges
  const pkg = JSON.parse(read('package.json'));
  for (const [n, v] of Object.entries(pkg.devDependencies)) assert.match(v, /^\d+\.\d+\.\d+$/, n);
});

test('secrets: no keys, tokens, passwords or personal paths in the tracked files', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(f => f && !/\.(png|jpg|icns|sqlite|woff2)$/.test(f));
  const pats = [/sk-(ant-)?[A-Za-z0-9_-]{20,}/, /hf_[A-Za-z0-9]{30,}/, /(ghp|gho|ghu|ghs)_[A-Za-z0-9]{30,}|github_pat_\w{30,}/, /AKIA[0-9A-Z]{16}/, /AIza[\w-]{35}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /eyJ[\w-]{20,}\.[\w-]{20,}\./, /\/Users\/[a-z][\w.-]+\//i, /[\w.+-]+@(gmail|yahoo|hotmail|icloud|outlook)\.com/];
  for (const f of files) {
    if (f === 'tests/security.test.mjs') continue; // the patterns themselves
    const s = read(f);
    for (const p of pats) assert.ok(!p.test(s), `${f} matches ${p}`);
  }
});
