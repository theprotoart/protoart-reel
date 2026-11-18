// ProtoArt Reel: Electron main process. Owns projects on disk, recording files, media serving,
// export files, the ERNIE / prompt helpers and every privileged call. The editor window is
// sandboxed and only talks to this process through the narrow API in preload.js.
'use strict';
const {
  app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, session, desktopCapturer, screen,
  systemPreferences, globalShortcut, Tray, nativeImage, powerSaveBlocker, nativeTheme,
} = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const validate = require('./validate');
const store = require('./store');
const ai = require('./engine/ai');
const kitten = require('./engine/kitten');
const ghost = require('./engine/ghost');
const verbatim = require('./engine/verbatim');
const audio = require('./engine/audio');
const core = require('./engine/core'); // reel-core: the Rust helper (falls back to JavaScript when missing)
const { videoExport } = require('./engine/videoexport.js');
const fx = require('./engine/fx');

const APP_ORIGIN = 'app://reel';
const EDITOR_URL = `${APP_ORIGIN}/renderer/index.html`;
const DEFAULT_ROOT = path.join(app.getPath('videos'), 'ProtoArt Reel');
// where new projects go: Movies › ProtoArt Reel unless the user picked another folder (an external drive…)
const projectsRoot = () => store.storage().root || DEFAULT_ROOT;
const libraryRoots = () => [...new Set([DEFAULT_ROOT, ...store.storage().roots, projectsRoot()])];
const PROJECT_EXT = '.reel';

app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false } },
]);

let win = null;
let tray = null;

// ------------------------------------------------------------------ projects

/** Open projects by token. The editor only ever sees tokens, never folder paths. */
const projects = new Map(); // token -> { dir, name }
const tokenFor = new Map(); // dir -> token

function registerProject(dir) {
  dir = path.resolve(dir);
  if (tokenFor.has(dir)) return tokenFor.get(dir);
  const token = crypto.randomBytes(9).toString('hex');
  projects.set(token, { dir, name: path.basename(dir, PROJECT_EXT) });
  tokenFor.set(dir, token);
  return token;
}
function projectOf(token) {
  if (typeof token !== 'string' || !projects.has(token)) throw new Error('Unknown project');
  return projects.get(token);
}
const mediaDir = p => path.join(p.dir, 'media');

async function isProjectDir(dir) {
  try {
    const st = await fs.promises.lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    await fs.promises.access(path.join(dir, 'project.json'));
    return true;
  } catch { return false; }
}

async function readProject(dir) {
  const raw = await fs.promises.readFile(path.join(dir, 'project.json'), 'utf8');
  if (raw.length > validate.MAX_PROJECT_BYTES) throw new Error('Project file is too large');
  return JSON.parse(raw);
}

async function openProject(dir) {
  if (!(await isProjectDir(dir))) throw new Error('Not a ProtoArt Reel project');
  const doc = await readProject(dir);
  await repairDurations(dir, doc);
  const token = registerProject(dir);
  await fs.promises.mkdir(mediaDir({ dir }), { recursive: true });
  store.addRecent(dir);
  return { token, name: path.basename(dir, PROJECT_EXT), doc };
}

/**
 * Projects made before Reel 1.1 could store a wildly long length (hundreds of hours) for MP4s with
 * negative frame-timing offsets. Re-measure those files and pull their clips back to the real end.
 */
async function repairDurations(dir, doc) {
  if (!doc || !Array.isArray(doc.media)) return;
  for (const m of doc.media) {
    if (!m || typeof m.file !== 'string' || !(m.duration > 12 * 3600) || !/\.(mp4|m4v|mov|m4a)$/i.test(m.file)) continue;
    try {
      const file = path.join(dir, 'media', path.basename(m.file));
      const info = await probeMedia(file);
      if (!(info.duration > 0) || info.duration >= m.duration) continue;
      m.duration = info.duration;
      for (const c of doc.clips || []) {
        if (c.media !== m.id) continue;
        const maxDur = Math.max(0.1, (info.duration - (c.in || 0)) / (c.speed || 1));
        if (c.duration > maxDur) c.duration = maxDur;
      }
    } catch { /* leave as is */ }
  }
}

async function freeProjectDir(base) {
  const root = projectsRoot();
  try { await fs.promises.mkdir(root, { recursive: true }); }
  catch { throw new Error(`STORAGE_MISSING|${root}`); } // the editor offers to choose another folder (or the default) and tries again
  const clean = validate.fileStem(base) || 'Untitled';
  for (let i = 1; i < 1000; i++) {
    const dir = path.join(root, (i === 1 ? clean : `${clean} ${i}`) + PROJECT_EXT);
    try { await fs.promises.mkdir(dir); return dir; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('Could not find a free project name');
}

/** Atomic write: temp file in the same folder, then rename. */
async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, data, { flag: 'wx', mode: 0o644 });
  await fs.promises.rename(tmp, file);
}

/** A name inside the project's media folder that isn't taken. */
async function freeMediaName(p, wanted) {
  const dir = mediaDir(p);
  await fs.promises.mkdir(dir, { recursive: true });
  const ext = path.extname(wanted).toLowerCase();
  const stem = validate.fileStem(path.basename(wanted, path.extname(wanted))) || 'media';
  for (let i = 1; i < 10000; i++) {
    const name = (i === 1 ? stem : `${stem}-${i}`) + ext;
    try { await fs.promises.access(path.join(dir, name)); } catch { return name; }
  }
  throw new Error('Too many files with that name');
}

// ------------------------------------------------------------------ media served to the editor

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg', '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  // read by the editor only while converting them on import
  '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mka': 'audio/x-matroska', '.ogv': 'video/ogg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.opus': 'audio/ogg', '.spx': 'audio/ogg', '.flac': 'audio/flac',
};
const EDITOR_FILES = /^\/(renderer\/[a-z0-9-]+\.(html|js|css)|renderer\/lib\/[a-z0-9-]+\.js|renderer\/fonts\/[A-Za-z0-9-]+\.woff2)$/;

const external = new Map(); // '<token>/<id>' → a recording inside a .screenflow package
let externalSeq = 1;

async function serve(request) {
  const url = new URL(request.url);
  if (url.host !== 'reel') return new Response('Not found', { status: 404 });
  const parts = url.pathname.split('/');
  // /m/<token>/<file>: a file in a project's media or thumbs folder, with Range support for seeking.
  if (parts[1] === 'm' && parts.length === 4) {
    let p;
    try { p = projectOf(parts[2]); } catch { return new Response('Not found', { status: 404 }); }
    const name = decodeURIComponent(parts[3]);
    if (!validate.mediaName(name)) return new Response('Not found', { status: 404 });
    return serveFile(path.join(mediaDir(p), name), request);
  }
  // /x/<token>/<id>: a ScreenFlow recording read where it is (registered by media:copyIn, read-only)
  if (parts[1] === 'x' && parts.length === 4) {
    const f = external.get(`${parts[2]}/${parts[3]}`);
    return f ? serveFile(f, request) : new Response('Not found', { status: 404 });
  }
  if (!EDITOR_FILES.test(url.pathname)) return new Response('Not found', { status: 404 });
  return serveFile(path.join(__dirname, url.pathname), request);
}

async function serveFile(file, request) {
  let st;
  try {
    st = await fs.promises.lstat(file);
    if (!st.isFile()) throw new Error('not a file');
  } catch { return new Response('Not found', { status: 404 }); }
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') || '');
  let start = 0, end = st.size - 1, status = 200;
  if (range) {
    if (range[1] === '' && range[2] !== '') { start = Math.max(0, st.size - Number(range[2])); }
    else { start = Number(range[1] || 0); if (range[2] !== '') end = Math.min(end, Number(range[2])); }
    if (start > end || start >= st.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } });
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = String(end - start + 1);
  if (st.size === 0) return new Response(new Uint8Array(0), { status: 200, headers });
  // Read only as fast as the editor takes it (pull, a few MB ahead). Pushing the whole rest of the file at once
  // (players ask for "from here to the end" on every seek) kept the main process so busy reading gigabytes into
  // memory that the Mac's menu bar couldn't get through to it, and it used memory an 8 GB Mac doesn't have.
  let fh;
  try { fh = await fs.promises.open(file, 'r'); } catch { return new Response('Not found', { status: 404 }); }
  let pos = start, closed = false;
  const done = async () => { if (!closed) { closed = true; await fh.close().catch(() => {}); } };
  const CHUNK = 1 << 20;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const n = Math.min(CHUNK, end + 1 - pos);
        if (n <= 0) { await done(); controller.close(); return; }
        const buf = Buffer.allocUnsafe(n);
        const { bytesRead } = await fh.read(buf, 0, n, pos);
        if (!bytesRead) { await done(); controller.close(); return; }
        pos += bytesRead;
        controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead));
      } catch (e) { await done(); controller.error(e); }
    },
    async cancel() { await done(); },
  }, { highWaterMark: 4 });
  return new Response(body, { status, headers });
}

// ------------------------------------------------------------------ writable files (recording, export)

const handles = new Map(); // id -> { fd, file, kind, bytes, project, extra }
let handleSeq = 1;

async function openHandle(file, kind, extra = {}) {
  const fh = await fs.promises.open(file, 'wx', 0o644);
  const id = handleSeq++;
  handles.set(id, { fh, file, kind, bytes: 0, queue: Promise.resolve(), ...extra });
  return id;
}
function handleOf(id, kind) {
  const h = handles.get(id);
  if (!h || (kind && h.kind !== kind)) throw new Error('Unknown file handle');
  return h;
}
function appendTo(h, data) {
  // Writes are chained so chunks land in order even if IPC delivers them close together.
  h.queue = h.queue.then(async () => {
    if (h.closed) return;
    await h.fh.write(data, 0, data.length, null);
    h.bytes += data.length;
  });
  return h.queue;
}
async function closeHandle(id) {
  const h = handles.get(id);
  if (!h) return null;
  handles.delete(id);
  await h.queue.catch(() => {});
  h.closed = true;
  await h.fh.close().catch(() => {});
  return h;
}

// ------------------------------------------------------------------ recording

const recording = {
  active: false, sourceId: null, systemAudio: false, cursor: null, cursorTimer: null, windowTimer: null,
  started: 0, blocker: null, project: null,
  marks: [], // ⌥⇧⌘M while recording: ms of recorded time
  paused: false, pausedMs: 0, pauseAt: 0, // pause: nothing is recorded, and the pointer track skips the gap
};
/** Time recorded so far, in ms, leaving out pauses (the pointer, clicks and keys use this clock). */
function recordedMs(t0) { return Date.now() - t0 - recording.pausedMs - (recording.paused ? Date.now() - recording.pauseAt : 0); }

async function listSources() {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: true });
  const displays = screen.getAllDisplays();
  return sources
    .filter(s => !/^ProtoArt Reel/.test(s.name))
    .map(s => {
      const d = s.display_id ? displays.find(x => String(x.id) === s.display_id) : null;
      return {
        id: s.id, name: s.name, kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : '',
        width: d ? Math.round(d.size.width * d.scaleFactor) : 0, height: d ? Math.round(d.size.height * d.scaleFactor) : 0,
        displayId: s.display_id || '',
      };
    });
}

function startCursorTrack(sourceId) {
  const displays = screen.getAllDisplays();
  const src = sourceId.startsWith('screen:') ? displays.find(d => sourceId.includes(String(d.id))) || screen.getPrimaryDisplay() : null;
  recording.cursor = { version: 2, display: src ? { bounds: src.bounds, scale: src.scaleFactor } : null, rate: 30, points: [], clicks: [], keys: [] };
  const t0 = Date.now();
  recording.cursorT0 = t0;
  recording.cursorTimer = setInterval(() => {
    if (recording.paused) return;
    const p = screen.getCursorScreenPoint();
    const pts = recording.cursor.points;
    if (pts.length < 30 * 60 * 60 * 4) pts.push([recordedMs(t0), p.x, p.y]);
  }, 33);
  // a single window: where it is on screen, so the pointer can be placed on its picture (Smart Zoom and Auto Edit
  // follow it). Checked twice a second; kept only when it moves or changes size: [ms, x, y, width, height].
  const wm = /^window:(\d+)/.exec(sourceId);
  if (wm) {
    const wid = Number(wm[1]), cur = recording.cursor;
    cur.window = { id: wid, frames: [] };
    let busy = false;
    const look = async () => {
      if (busy || recording.cursor !== cur || recording.paused) return;
      busy = true;
      try {
        const b = await audio.windowBounds(wid);
        const f = cur.window.frames, last = f[f.length - 1];
        if (b && recording.cursor === cur && f.length < 20000 && !(last && last[1] === b.x && last[2] === b.y && last[3] === b.width && last[4] === b.height))
          f.push([recordedMs(t0), b.x, b.y, b.width, b.height]);
      } finally { busy = false; }
    };
    look();
    recording.windowTimer = setInterval(look, 500);
  }
}
// clicks and keys from the audio helper's listen-only event tap land in the cursor track
let inputUnsub = null;
function startInputTrack(opts) {
  recording.inputError = '';
  if (!opts || (!opts.clicks && !opts.keys)) return;
  inputUnsub = audio.onEvent(ev => {
    const c = recording.cursor;
    if (!c || ev.type !== 'input' || !Array.isArray(ev.events) || recording.paused) return;
    const ms = recordedMs(recording.cursorT0);
    for (const e of ev.events.slice(0, 200)) {
      if ((e[0] === 'c' || e[0] === 'u') && opts.clicks && c.clicks.length < 200000) c.clicks.push([ms, e[0] === 'u' ? 'u' : e[1], +e[2], +e[3]]);
      if (e[0] === 'k' && opts.keys && c.keys.length < 200000) c.keys.push([ms, String(e[1]).slice(0, 8), String(e[2]).slice(0, 12)]);
    }
  });
  audio.inputStart(!!opts.keys).then(ok => { if (!ok) recording.inputError = 'Clicks and keystrokes need Input Monitoring permission for ProtoArt Reel (System Settings › Privacy & Security).'; }).catch(() => {});
}
function stopInputTrack() { if (inputUnsub) { inputUnsub(); inputUnsub = null; audio.inputStop(); } }
function stopCursorTrack() {
  stopInputTrack();
  clearInterval(recording.cursorTimer);
  clearInterval(recording.windowTimer);
  recording.cursorTimer = recording.windowTimer = null;
  const c = recording.cursor;
  recording.cursor = null;
  return c;
}

// A small floating panel while recording (REC lamp, timer, STOP), so stopping never depends on finding
// the menu-bar icon or remembering ⇧⌘2. Kept out of the recording where macOS allows it, always on top,
// draggable, on every Space.
let hud = null;
const HUD_URL = `${APP_ORIGIN}/renderer/hud.html`;
function showHud() {
  if (hud && !hud.isDestroyed()) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const w = 640, h = 48;
  hud = new BrowserWindow({
    width: w, height: h, x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + wa.height - h - 18),
    frame: false, transparent: true, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, hasShadow: true, alwaysOnTop: true, focusable: true, show: false,
    // the first click on the panel presses its button, even while you're working in another app (without this,
    // macOS spends that click bringing Reel forward, and RESUME or PAUSE seemed to do nothing)
    acceptFirstMouse: true, title: 'ProtoArt Reel recording',
    webPreferences: { preload: path.join(__dirname, 'hud-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: false },
  });
  hud.setAlwaysOnTop(true, 'screen-saver');
  // skipTransformProcessType: without it, Electron turns Reel into a background (menu-less) app and back to put the
  // panel on every Space, and macOS then leaves Reel's menu bar dead until you switch away and back (the
  // "ProtoArt Reel menu won't open" after a recording). The panel still floats above other windows.
  hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  beRegularApp();
  hud.setContentProtection(true); // ask macOS to leave it out of screen captures
  hud.webContents.on('will-navigate', e => e.preventDefault());
  hud.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  hud.loadURL(HUD_URL);
  hud.once('ready-to-show', () => { if (hud && !hud.isDestroyed()) hud.showInactive(); });
  hud.on('closed', () => { hud = null; });
}
function hideHud() { if (hud && !hud.isDestroyed()) hud.destroy(); hud = null; beRegularApp(); }
// Reel must stay a normal app (Dock icon, its own menu bar). If anything ever turns it into a background app,
// clicking its window no longer makes it the active app: the menu bar keeps showing another app's menus.
function beRegularApp() {
  if (process.platform !== 'darwin') return;
  try { app.setActivationPolicy?.('regular'); } catch { /* fine */ }
  try { if (app.dock && !app.dock.isVisible()) app.dock.show()?.catch?.(() => {}); } catch { /* fine */ }
}
app.on('browser-window-focus', () => beRegularApp()); // clicking a Reel window always makes Reel the active app again
const fromHud = event => hud && !hud.isDestroyed() && event.sender === hud.webContents && event.senderFrame?.url === HUD_URL;
ipcMain.on('hud:stop', event => { if (fromHud(event)) sendMenu('stop-recording'); });
ipcMain.on('hud:pause', event => { if (fromHud(event)) sendMenu('pause-recording'); });
ipcMain.on('hud:discard', event => { if (fromHud(event)) sendMenu('discard-recording'); });
ipcMain.on('hud:mark', event => { if (fromHud(event)) dropMark(); });
/** A marker at this moment of the recording (recorded time, so pauses don't push it later). */
function dropMark() {
  if (!recording.active || recording.marks.length > 5000) return;
  recording.marks.push(Math.max(0, recordedMs(recording.started)));
  if (hud && !hud.isDestroyed()) hud.webContents.send('hud:marked', recording.marks.length);
}
function recTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: recording.paused ? 'Resume Recording' : 'Pause Recording', accelerator: 'Command+Alt+Shift+2', click: () => sendMenu('pause-recording') },
    { label: 'Add Marker Here', accelerator: 'Command+Alt+Shift+M', click: () => dropMark() },
    { label: 'Stop Recording', accelerator: 'Command+Shift+2', click: () => sendMenu('stop-recording') },
    { type: 'separator' },
    { label: 'Discard This Take and Start Again', click: () => sendMenu('discard-recording') },
  ]));
  tray.setToolTip(recording.paused ? 'ProtoArt Reel: recording paused' : 'ProtoArt Reel is recording');
}

function setRecordingUi(on) {
  if (on) {
    if (!tray) {
      tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayRecTemplate.png')));
      tray.setToolTip('ProtoArt Reel is recording');
      // a click opens the menu (Pause / Resume, Stop…) rather than stopping at once: a paused recording was
      // easy to end by accident from the menu bar
      tray.on('click', () => { try { tray.popUpContextMenu(); } catch { /* the menu shows on its own */ } });
    }
    recTrayMenu();
    globalShortcut.register('Command+Shift+2', () => sendMenu('stop-recording'));
    globalShortcut.register('Command+Alt+Shift+2', () => sendMenu('pause-recording'));
    globalShortcut.register('Command+Alt+Shift+M', () => dropMark());
    if (recording.blocker == null || !powerSaveBlocker.isStarted(recording.blocker)) recording.blocker = powerSaveBlocker.start('prevent-display-sleep');
    showHud();
  } else {
    globalShortcut.unregister('Command+Shift+2');
    globalShortcut.unregister('Command+Alt+Shift+2');
    globalShortcut.unregister('Command+Alt+Shift+M');
    if (tray) { tray.destroy(); tray = null; }
    hideHud();
    if (recording.blocker !== null && powerSaveBlocker.isStarted(recording.blocker)) powerSaveBlocker.stop(recording.blocker);
    recording.blocker = null;
  }
}

/** WAV header for 32-bit float PCM (sizes patched on close). */
function wavHeader(sampleRate, channels, dataBytes) {
  const b = Buffer.alloc(58);
  b.write('RIFF', 0); b.writeUInt32LE(50 + dataBytes, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(18, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * channels * 4, 28); b.writeUInt16LE(channels * 4, 32);
  b.writeUInt16LE(32, 34); b.writeUInt16LE(0, 36);
  b.write('fact', 38); b.writeUInt32LE(4, 42); b.writeUInt32LE(Math.floor(dataBytes / (channels * 4)), 46);
  b.write('data', 50); b.writeUInt32LE(dataBytes, 54);
  return b;
}

let mp4lib = null;
const loadMp4 = async () => (mp4lib ||= await import(pathToFileURL(path.join(__dirname, 'renderer', 'lib', 'mp4.js')).href));

/** File reader for the demuxer. */
async function fileReader(file) {
  const fh = await fs.promises.open(file, 'r');
  const { size } = await fh.stat();
  return {
    size, fh,
    async read(offset, length) {
      const n = Math.max(0, Math.min(length, size - offset));
      const buf = Buffer.alloc(n);
      if (n) await fh.read(buf, 0, n, offset);
      return new Uint8Array(buf.buffer, buf.byteOffset, n);
    },
  };
}

/**
 * MediaRecorder writes fragmented MP4. Rewrites it as a regular MP4 (moov first, one sample
 * table) so every player, AVFoundation and the export engine can seek it quickly.
 */
async function remuxRecording(src, dst) {
  const { demux, Muxer, sampleTime } = await loadMp4();
  const r = await fileReader(src);
  try {
    const d = await demux(r);
    const v = d.tracks.find(t => t.kind === 'video' && t.supported);
    const a = d.tracks.find(t => t.kind === 'audio' && t.codec === 'mp4a.40.2');
    if (!v) throw new Error('No video in recording');
    const m = new Muxer({
      video: { codec: v.codec, width: v.width, height: v.height, description: v.description },
      audio: a ? { codec: a.codec, sampleRate: a.sampleRate, channels: a.channels, description: a.description } : null,
    });
    const items = [];
    for (const t of [v, a].filter(Boolean)) for (const s of t.samples) items.push({ t, s, at: s.dts / t.timescale });
    items.sort((x, y) => x.at - y.at);
    // first presented video frame becomes time 0 (MediaRecorder can start a little late)
    const t0 = Math.min(...[v, a].filter(Boolean).map(t => sampleTime(t, t.samples[0])));
    const body = path.join(path.dirname(dst), `.${path.basename(dst)}.body`);
    const out = await fs.promises.open(body, 'w', 0o644);
    // samples are read through a 32 MB window: frames and sound sit close together in the file, so a long recording
    // is read in a few hundred large reads instead of one small read per frame (minutes saved on a 40-minute take)
    const WIN = 32 << 20;
    let win0 = 0, win = Buffer.alloc(0);
    const readSample = async (offset, size) => {
      if (offset < win0 || offset + size > win0 + win.length) {
        const n = Math.max(size, Math.min(WIN, r.size - offset));
        win = Buffer.alloc(n); win0 = offset;
        if (n) await r.fh.read(win, 0, n, offset);
      }
      return win.subarray(offset - win0, offset - win0 + size);
    };
    try {
      let batch = [], batchBytes = 0;
      for (const { t, s } of items) {
        const data = await readSample(s.offset, s.size);
        const meta = { timestamp: (sampleTime(t, s) - t0) * 1e6, duration: (s.duration / t.timescale) * 1e6, key: s.sync };
        batch.push(Buffer.from(t === v ? m.addVideo(data, meta) : m.addAudio(data, meta)));
        batchBytes += s.size;
        if (batchBytes > 8 << 20) { await out.write(Buffer.concat(batch)); batch = []; batchBytes = 0; }
      }
      if (batch.length) await out.write(Buffer.concat(batch));
    } finally { await out.close(); }
    const head = m.finish();
    await joinFiles(dst, head, body);
    return { width: v.width, height: v.height, duration: v.duration, hasAudio: !!a };
  } finally { await r.fh.close(); }
}

/**
 * Whether the Mac's own decoder (reel-frames, AVFoundation) can play a video's picture: a moment at its start, in
 * the middle and near its end. null when it can (or there's no decoder to ask), else what went wrong.
 */
async function checkVideoPlays(file, duration) {
  try { await fs.promises.access(FRAMES_BIN, fs.constants.X_OK); } catch { return null; }
  const d = Number(duration) || 0;
  const at = [0, d / 2, Math.max(0, d - 2)].filter((t, i, a) => d > 0.5 && a.indexOf(t) === i);
  for (const t of at) {
    const r = await new Promise(resolve => {
      const dec = spawn(FRAMES_BIN, ['--rgba', file, String(t), String(t + 1), '16', '10'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let frames = 0, bytes = 0, err = '';
      const kill = setTimeout(() => { dec.kill(); resolve(frames ? null : 'it took too long to read'); }, 30000);
      dec.stdout.on('data', b => { bytes += b.length; frames = Math.floor(bytes / (8 + 16 * 10 * 4)); });
      dec.stderr.on('data', b => { err += b; });
      dec.on('error', () => { clearTimeout(kill); resolve(null); });
      dec.on('close', code => { clearTimeout(kill); resolve(code === 0 && frames > 0 ? null : (err.trim() || 'no picture came out').slice(0, 200)); });
    });
    if (r) return `${r} (at ${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')})`;
  }
  return null;
}

/** Writes `head` then the contents of `bodyFile` into `dst`, then removes the body file. */
async function joinFiles(dst, head, bodyFile) {
  const out = await fs.promises.open(dst, 'wx', 0o644);
  try {
    await out.write(Buffer.from(head));
    const src = await fs.promises.open(bodyFile, 'r');
    try {
      const buf = Buffer.alloc(8 << 20);
      for (;;) {
        const { bytesRead } = await src.read(buf, 0, buf.length, null);
        if (!bytesRead) break;
        await out.write(buf, 0, bytesRead);
      }
    } finally { await src.close(); }
  } finally { await out.close(); }
  await fs.promises.rm(bodyFile, { force: true });
}

async function probeMedia(file) {
  const ext = path.extname(file).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
    const img = nativeImage.createFromPath(file);
    const s = img.getSize();
    return { kind: 'image', width: s.width, height: s.height, duration: 5 };
  }
  if (ext === '.svg') {
    const t = (await fs.promises.readFile(file, 'utf8')).slice(0, 4000);
    const num = k => { const m = new RegExp(`\\b${k}="([\\d.]+)(px)?"`).exec(t); return m ? Number(m[1]) : 0; };
    const vb = /viewBox="[\d.\s-]+?\s([\d.]+)\s([\d.]+)"/.exec(t);
    const w = num('width') || (vb ? Number(vb[1]) : 1920), h = num('height') || (vb ? Number(vb[2]) : 1080);
    return { kind: 'image', width: Math.round(w), height: Math.round(h), duration: 5 };
  }
  if (ext === '.wav') {
    const r = await fileReader(file);
    try { return { kind: 'audio', ...(await wavInfoOf(r)) }; } finally { await r.fh.close(); }
  }
  if (['.mp4', '.m4v', '.mov', '.m4a'].includes(ext)) {
    const { demux } = await loadMp4();
    const r = await fileReader(file);
    try {
      const d = await demux(r);
      const v = d.tracks.find(t => t.kind === 'video');
      const a = d.tracks.find(t => t.kind === 'audio');
      return {
        kind: v ? 'video' : 'audio', duration: d.duration, width: v ? v.width : 0, height: v ? v.height : 0,
        rotation: v ? v.rotation : 0, hasAudio: !!a, videoCodec: v ? v.codec || v.fourcc : '', audioCodec: a ? a.codec : '',
        exportable: !!((!v || v.supported) && (!a || a.supported)),
      };
    } finally { await r.fh.close(); }
  }
  if (['.mp3', '.aif', '.aiff'].includes(ext)) return { kind: 'audio', duration: 0, hasAudio: true };
  throw new Error('Unsupported file type');
}

/**
 * A WAV's format and length, walking its chunks on disk: recorders and DAWs put large bext / iXML / JUNK chunks
 * before the sound, so it can start well past the first few KB (reading only those made such files fail).
 * playable: whether the editor plays and reads it as it is (16 / 24 / 32-bit PCM, 32-bit float).
 */
async function wavInfoOf(r) {
  const head = Buffer.from(await r.read(0, 12));
  if (head.length < 12 || head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') throw new Error('Not a WAV file');
  let p = 12, fmt = null;
  for (let guard = 0; guard < 4096 && p + 8 <= r.size; guard++) {
    const h = Buffer.from(await r.read(p, 8));
    const id = h.toString('latin1', 0, 4), len = h.readUInt32LE(4);
    if (id === 'fmt ') {
      const f = Buffer.from(await r.read(p + 8, Math.min(len, 40)));
      let format = f.readUInt16LE(0);
      if (format === 0xfffe && f.length >= 26) format = f.readUInt16LE(24); // extensible: the real format
      fmt = { format, channels: f.readUInt16LE(2), rate: f.readUInt32LE(4), bits: f.readUInt16LE(14) };
    }
    if (id === 'data') {
      if (!fmt) throw new Error('Unreadable WAV');
      const dataOff = p + 8, dataLen = Math.min(len || r.size, r.size - dataOff);
      const frame = Math.max(1, fmt.channels * (fmt.bits / 8));
      const playable = (fmt.format === 1 && [16, 24, 32].includes(fmt.bits)) || (fmt.format === 3 && fmt.bits === 32);
      return { duration: dataLen / frame / fmt.rate, sampleRate: fmt.rate, channels: fmt.channels, hasAudio: true, playable };
    }
    if (len === 0 && id !== 'data') { p += 8; continue; }
    p += 8 + len + (len & 1);
  }
  throw new Error('Unreadable WAV');
}


// ------------------------------------------------------------------ export

const exportedFiles = new Set(); // full paths exported this session (for Reveal)

// ------------------------------------------------------------------ IPC

function fromEditor(event) {
  return !!win && !win.isDestroyed() && event.sender === win.webContents && !!event.senderFrame && event.senderFrame.url === EDITOR_URL;
}
const handle = (channel, fn) => ipcMain.handle(channel, async (event, ...args) => {
  if (!fromEditor(event)) throw new Error('Not allowed');
  return fn(...args);
});
const on = (channel, fn) => ipcMain.on(channel, (event, ...args) => { if (fromEditor(event)) fn(...args); });

// ------------------------------------------------------------------ library: reveal, replace, Global Library
// ------------------------------------------------------------------ formats
// The editor itself works with MP4/MOV (H.264 or HEVC + AAC), WAV and M4A (AAC), and PNG / JPEG / GIF / WebP.
// Everything else is converted when it's added: by macOS (AVFoundation, ImageIO) through the helper, or,
// for WebM / Matroska / Ogg (which macOS can't read), inside the editor with the browser's own decoders.
const FORMATS = {
  imageNative: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
  imageConform: ['heic', 'heif', 'hif', 'avif', 'tif', 'tiff', 'bmp', 'psd', 'psb', 'jp2', 'j2k', 'jpf', 'jpx', 'tga', 'ico', 'icns', 'exr', 'hdr', 'pict', 'pct',
    'dng', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'rw2', 'pef', 'srw', 'x3f', '3fr', 'iiq', 'erf', 'kdc', 'mos', 'mrw', 'raw', 'rwl', 'dcr'],
  svg: ['svg'],
  audioNative: ['wav'],
  audioConform: ['mp3', 'mp2', 'mpa', 'aif', 'aiff', 'aifc', 'caf', 'flac', 'm4b', 'm4r', 'aac', 'adts', 'ac3', 'ec3', 'eac3', 'amr', 'au', 'snd', 'w64', 'rf64', 'alac', 'sd2'],
  videoNative: ['mp4', 'm4v', 'mov', 'm4a'],
  videoConform: ['avi', 'mpg', 'mpeg', 'mpe', 'm1v', 'm2v', 'mp2v', 'm2ts', 'mts', 'm2t', 'ts', 'tod', 'mod', 'vob', '3gp', '3g2', 'dv', 'dif', 'mxf', 'qt', 'f4v', 'mjpeg', 'mjpg', 'y4m'],
  // macOS can't read these; the editor converts them (WebCodecs / Web Audio)
  browserVideo: ['webm', 'mkv', 'ogv'],
  browserAudio: ['ogg', 'oga', 'opus', 'spx', 'mka', 'weba'],
  // nothing on a Mac reads these without extra software
  unsupported: ['wmv', 'asf', 'flv', 'rm', 'rmvb', 'divx', 'xvid', 'wma', 'ape', 'wv', 'mid', 'midi', 'swf'],
};
const MEDIA_EXT = [...FORMATS.imageNative, ...FORMATS.imageConform, ...FORMATS.svg, ...FORMATS.audioNative, ...FORMATS.audioConform, ...FORMATS.videoNative,
  ...FORMATS.videoConform, ...FORMATS.browserVideo, ...FORMATS.browserAudio, 'screenflow'];
handle('media:reveal', async (token, name) => {
  const p = projectOf(token);
  if (!validate.mediaName(name)) throw new Error('Bad name');
  shell.showItemInFolder(path.join(mediaDir(p), name));
});
/** Which of these media files are missing from the project folder (moved, deleted, or never copied in). */
// the Mac's spelling dictionary: "It's spelt right" adds a word to it (macOS keeps it, for every app)
handle('spell:add', async word => {
  const w = String(word || '').trim();
  if (!/^[\p{L}][\p{L}'’-]{0,59}$/u.test(w)) return false;
  return session.defaultSession.addWordToSpellCheckerDictionary(w);
});

handle('media:missing', async (token, names) => {
  const p = projectOf(token);
  if (!Array.isArray(names)) return [];
  const out = [];
  for (const n of names.slice(0, 5000)) { if (!validate.mediaName(n)) continue; try { await fs.promises.access(path.join(mediaDir(p), n)); } catch { out.push(n); } }
  return out;
});
/** Pick a new file to stand in for a media item (relink). The old file stays in the project. */
handle('media:replace', async (token, kind) => {
  const p = projectOf(token);
  const r = await dialog.showOpenDialog(win, { title: 'Replace with…', properties: ['openFile'], filters: [{ name: 'Media', extensions: MEDIA_EXT }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const [out] = await importFiles(p, [r.filePaths[0]]);
  if (!out || out.error) throw new Error(out?.error || 'Couldn’t read that file');
  void kind;
  return out;
});

/** The Global Library: media every project can use, kept in Reel's own folder on this Mac. */
const globalDir = () => path.join(app.getPath('userData'), 'Global Library');
const globalIndex = () => path.join(globalDir(), 'library.json');
async function readGlobal() { try { const j = JSON.parse(await fs.promises.readFile(globalIndex(), 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; } }
handle('global:list', async () => {
  const list = await readGlobal();
  const ok = [];
  for (const g of list) { try { await fs.promises.access(path.join(globalDir(), g.file)); ok.push(g); } catch { /* gone */ } }
  return ok;
});
handle('global:add', async (token, name, label) => {
  const p = projectOf(token);
  if (!validate.mediaName(name)) throw new Error('Bad name');
  await fs.promises.mkdir(globalDir(), { recursive: true });
  const list = await readGlobal();
  const ext = path.extname(name).toLowerCase();
  let file = (validate.fileStem(path.basename(name, path.extname(name))) || 'media') + ext;
  for (let i = 2; list.some(g => g.file === file); i++) file = `${validate.fileStem(path.basename(name, ext))}-${i}${ext}`;
  await fs.promises.copyFile(path.join(mediaDir(p), name), path.join(globalDir(), file), fs.constants.COPYFILE_FICLONE);
  list.push({ file, name: String(label || name).slice(0, 120), added: Date.now() });
  await writeAtomic(globalIndex(), JSON.stringify(list, null, 1));
  return true;
});
handle('global:import', async (token, file) => {
  const p = projectOf(token);
  if (!validate.mediaName(file)) throw new Error('Bad name');
  const list = await readGlobal();
  const g = list.find(x => x.file === file);
  if (!g) throw new Error('Not in the Global Library');
  const [out] = await importFiles(p, [path.join(globalDir(), file)]);
  if (!out || out.error) throw new Error(out?.error || 'Couldn’t read that file');
  out.name = g.name; out.role = 'global';
  return out;
});
handle('global:remove', async file => {
  if (!validate.mediaName(file)) throw new Error('Bad name');
  const list = (await readGlobal()).filter(g => g.file !== file);
  await writeAtomic(globalIndex(), JSON.stringify(list, null, 1));
  await shell.trashItem(path.join(globalDir(), file)).catch(() => {});
  return true;
});
handle('global:reveal', async () => { await fs.promises.mkdir(globalDir(), { recursive: true }); shell.openPath(globalDir()); });

/** Recent projects plus every project in Movies › ProtoArt Reel, newest first. */
async function knownProjectDirs() {
  const dirs = new Set(store.recents());
  for (const root of libraryRoots()) {
    try { for (const n of await fs.promises.readdir(root)) if (n.endsWith(PROJECT_EXT)) dirs.add(path.join(root, n)); }
    catch { /* no folder yet, or the drive isn't connected */ }
  }
  return [...dirs];
}
/** A home-screen key back to its folder, only if it's one of the projects we listed. */
async function dirOfKey(key) {
  if (typeof key !== 'string' || key.length > 2000) throw new Error('Bad key');
  const dir = Buffer.from(key, 'base64url').toString();
  if (!(await knownProjectDirs()).includes(dir) || !(await isProjectDir(dir))) throw new Error('Not one of your projects');
  return dir;
}
handle('projects:recent', async () => {
  const out = [];
  const recent = new Set(store.recents());
  for (const dir of (await knownProjectDirs()).slice(0, 300)) {
    if (await isProjectDir(dir)) {
      let thumb = '';
      try { const t = path.join(dir, 'poster.jpg'); await fs.promises.access(t); thumb = 'data:image/jpeg;base64,' + (await fs.promises.readFile(t)).toString('base64'); } catch { /* none */ }
      const st = await fs.promises.stat(path.join(dir, 'project.json'));
      out.push({ key: Buffer.from(dir).toString('base64url'), name: path.basename(dir, PROJECT_EXT), modified: st.mtimeMs, thumb, recent: recent.has(dir), inLibrary: libraryRoots().includes(path.dirname(dir)) });
    }
  }
  return out.sort((a, b) => b.modified - a.modified);
});
/**
 * A project renamed from its title (inside the project) gets its folder renamed to match once it's closed, so the
 * Projects screen (which shows folder names) and Finder agree. Skipped if that name is taken or can't be a folder.
 */
function folderForName(dir) {
  let name = '';
  try { name = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).name || ''; } catch { return null; }
  const clean = validate.fileStem(String(name).trim());
  if (!clean) return null;
  const dest = path.join(path.dirname(dir), clean + PROJECT_EXT);
  if (dest === dir || fs.existsSync(dest)) return null;
  return dest;
}
function syncFolderName(dir) {
  const dest = folderForName(dir);
  if (!dest) return dir;
  try { fs.renameSync(dir, dest); } catch { return dir; }
  const wasRecent = store.recents().includes(dir);
  store.removeRecent(dir); if (wasRecent) store.addRecent(dest);
  return dest;
}
/** The editor went back to the home screen: forget the token so the folder can be trashed, and match its name. */
handle('project:close', async token => {
  const p = projects.get(token);
  if (p) { projects.delete(token); tokenFor.delete(p.dir); syncFolderName(p.dir); }
  return true;
});
handle('project:forget', async key => { store.removeRecent(await dirOfKey(key)); return true; });
handle('project:revealKey', async key => { shell.showItemInFolder(path.join(await dirOfKey(key), 'project.json')); });
/** Moves a project folder (with its media) to the Trash. It can be put back from the Trash. */
handle('project:trash', async key => {
  const dir = await dirOfKey(key);
  for (const p of projects.values()) if (p.dir === dir) throw new Error('That project is open. Close it first.');
  await shell.trashItem(dir);
  store.removeRecent(dir);
  return true;
});
/** Renames a project (its folder, in place) from the Projects screen. */
handle('project:rename', async (key, name) => {
  const dir = await dirOfKey(key);
  for (const p of projects.values()) if (p.dir === dir) throw new Error('That project is open. Rename it from its title while it’s open, or close it first.');
  const clean = validate.fileStem(typeof name === 'string' ? name.trim() : '');
  if (!clean) throw new Error('Type a name');
  const dest = path.join(path.dirname(dir), clean + PROJECT_EXT);
  if (dest === dir) return Buffer.from(dir).toString('base64url');
  try { await fs.promises.access(dest); throw new Error('A project with that name is already there'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await fs.promises.rename(dir, dest);
  try {
    const f = path.join(dest, 'project.json'), doc = JSON.parse(await fs.promises.readFile(f, 'utf8'));
    doc.name = clean; await writeAtomic(f, JSON.stringify(doc));
  } catch { /* the folder name is what shows */ }
  const wasRecent = store.recents().includes(dir);
  store.removeRecent(dir); if (wasRecent) store.addRecent(dest);
  return Buffer.from(dest).toString('base64url');
});
/** A full copy of a project (all its media), next to the others, named "… copy". */
handle('project:duplicate', async key => {
  const dir = await dirOfKey(key);
  const dest = await freeProjectDir(path.basename(dir, PROJECT_EXT) + ' copy');
  try { await copyProject(dir, dest, { onlyUsed: false, rename: path.basename(dest, PROJECT_EXT) }); }
  catch (e) { await fs.promises.rm(dest, { recursive: true, force: true }).catch(() => {}); throw e; }
  store.addRecent(dest);
  return Buffer.from(dest).toString('base64url');
});

handle('project:create', async name => {
  const dir = await freeProjectDir(typeof name === 'string' ? name : 'Untitled');
  const doc = validate.newProject(path.basename(dir, PROJECT_EXT));
  await fs.promises.mkdir(path.join(dir, 'media'));
  await writeAtomic(path.join(dir, 'project.json'), JSON.stringify(doc, null, 1));
  return openProject(dir);
});

handle('project:openRecent', async key => {
  if (typeof key !== 'string') throw new Error('Bad key');
  return openProject(await dirOfKey(key));
});

handle('project:openDialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open a ProtoArt Reel project', defaultPath: projectsRoot(),
    properties: ['openFile', 'openDirectory', 'treatPackageAsDirectory'], filters: [{ name: 'ProtoArt Reel project', extensions: ['reel'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  let dir = r.filePaths[0];
  if (path.basename(dir) === 'project.json') dir = path.dirname(dir);
  return openProject(dir);
});

handle('project:save', async (token, doc, poster) => {
  const p = projectOf(token);
  const clean = validate.project(doc);
  await writeAtomic(path.join(p.dir, 'project.json'), JSON.stringify(clean));
  if (poster instanceof Uint8Array && poster.length < 2 << 20 && poster[0] === 0xff && poster[1] === 0xd8) {
    await writeAtomic(path.join(p.dir, 'poster.jpg'), Buffer.from(poster));
  }
  return true;
});

// ------------------------------------------------------------------ archive and templates
/** Every media-folder file a project needs: clip media plus pointer tracks, effects, mattes, LUTs… */
async function neededFiles(dir, doc, onlyUsed) {
  const usedIds = new Set((doc.clips || []).map(c => c.media).filter(Boolean));
  const media = onlyUsed ? (doc.media || []).filter(m => usedIds.has(m.id)) : (doc.media || []);
  const names = new Set();
  const walk = v => {
    if (typeof v === 'string') { if (validate.mediaName(v)) names.add(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k]);
  };
  walk(media); walk(doc.clips || []);
  const out = [];
  for (const n of names) { try { const st = await fs.promises.stat(path.join(dir, 'media', n)); if (st.isFile()) out.push(n); } catch { /* not a file */ } }
  return { files: out, media };
}
async function copyProject(srcDir, destDir, { onlyUsed = true, rename } = {}) {
  const doc = JSON.parse(await fs.promises.readFile(path.join(srcDir, 'project.json'), 'utf8'));
  const { files, media } = await neededFiles(srcDir, doc, onlyUsed);
  await fs.promises.mkdir(path.join(destDir, 'media'), { recursive: true });
  for (const f of files) await fs.promises.copyFile(path.join(srcDir, 'media', f), path.join(destDir, 'media', f), fs.constants.COPYFILE_FICLONE);
  doc.media = media;
  if (rename) doc.name = rename;
  await writeAtomic(path.join(destDir, 'project.json'), JSON.stringify(doc));
  try { await fs.promises.copyFile(path.join(srcDir, 'poster.jpg'), path.join(destDir, 'poster.jpg')); } catch { /* no poster */ }
  return { files: files.length };
}
handle('project:archive', async (token, onlyUsed) => {
  const p = projectOf(token);
  const r = await dialog.showSaveDialog(win, { title: 'Archive project', defaultPath: path.join(app.getPath('documents'), `${p.name} archive${PROJECT_EXT}`), filters: [{ name: 'ProtoArt Reel project', extensions: ['reel'] }] });
  if (r.canceled || !r.filePath) return null;
  const dest = r.filePath.endsWith(PROJECT_EXT) ? r.filePath : r.filePath + PROJECT_EXT;
  if (path.resolve(dest) === path.resolve(p.dir)) throw new Error('Pick a different place for the archive');
  try { await fs.promises.access(dest); throw new Error('Something with that name is already there'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const res = await copyProject(p.dir, dest, { onlyUsed: onlyUsed !== false });
  shell.showItemInFolder(dest);
  return { name: path.basename(dest), files: res.files };
});
/** A copy of the edit (project.json) in the project's own Backups folder, before a big change. Media isn't copied. */
handle('project:backupEdit', async (token, why) => {
  const p = projectOf(token);
  const dir = path.join(p.dir, 'Backups');
  await fs.promises.mkdir(dir, { recursive: true });
  const d = new Date(), pad = n => String(n).padStart(2, '0');
  const name = `${validate.fileStem(String(why || 'backup')) || 'backup'} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`;
  await fs.promises.copyFile(path.join(p.dir, 'project.json'), path.join(dir, name));
  return { name, folder: path.basename(p.dir) + '/Backups' };
});
const templatesDir = () => path.join(app.getPath('userData'), 'Templates');
handle('template:save', async (token, name) => {
  const p = projectOf(token);
  const clean = validate.fileStem(String(name || p.name)) || 'Template';
  await fs.promises.mkdir(templatesDir(), { recursive: true });
  let dest = path.join(templatesDir(), clean + PROJECT_EXT);
  for (let i = 2; fs.existsSync(dest) && i < 1000; i++) dest = path.join(templatesDir(), `${clean} ${i}${PROJECT_EXT}`);
  await copyProject(p.dir, dest, { onlyUsed: true, rename: clean });
  return { name: path.basename(dest, PROJECT_EXT) };
});
handle('template:list', async () => {
  try {
    const names = (await fs.promises.readdir(templatesDir())).filter(n => n.endsWith(PROJECT_EXT));
    return names.map(n => ({ id: n, name: path.basename(n, PROJECT_EXT) }));
  } catch { return []; }
});
handle('template:use', async id => {
  if (!validate.mediaName(id) || !id.endsWith(PROJECT_EXT)) throw new Error('Bad template');
  const src = path.join(templatesDir(), id);
  const dir = await freeProjectDir(path.basename(id, PROJECT_EXT));
  await copyProject(src, dir, { onlyUsed: false, rename: path.basename(dir, PROJECT_EXT) });
  return openProject(dir);
});
handle('template:remove', async id => {
  if (!validate.mediaName(id) || !id.endsWith(PROJECT_EXT)) throw new Error('Bad template');
  await shell.trashItem(path.join(templatesDir(), id));
  return true;
});

handle('project:reveal', async token => { shell.showItemInFolder(path.join(projectOf(token).dir, 'project.json')); });

handle('media:import', async token => {
  const p = projectOf(token);
  const r = await dialog.showOpenDialog(win, {
    title: 'Add media', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video, audio and images', extensions: MEDIA_EXT }],
  });
  if (r.canceled) return [];
  return importFiles(p, r.filePaths);
});

handle('media:importDropped', async (token, paths) => {
  const p = projectOf(token);
  const clean = validate.paths(paths);
  if (!clean) return [{ error: Array.isArray(paths) && paths.length ? 'Reel couldn’t read where those files are.' : 'macOS didn’t say where the dropped files are. Try dropping them again, or use ADD MEDIA.' }];
  return importFiles(p, clean);
});

/**
 * Copies a file into the project. On the same drive it's an instant clone (APFS); from another drive (an external
 * disk, a network share) it's a real copy, so it reports progress instead of leaving the drop looking stuck.
 */
async function copyWithProgress(src, dst, size, progress) {
  try { await fs.promises.copyFile(src, dst, fs.constants.COPYFILE_FICLONE_FORCE | fs.constants.COPYFILE_EXCL); return; } catch (e) { if (e.code === 'EEXIST') throw e; }
  progress?.(0);
  const tmp = dst + '.part';
  const from = fs.createReadStream(src, { highWaterMark: 8 << 20 }), to = fs.createWriteStream(tmp, { flags: 'wx' });
  let done = 0, last = 0;
  from.on('data', b => { done += b.length; const v = size ? done / size : 0; if (v - last >= 0.01) { last = v; progress?.(Math.min(0.99, v)); } });
  try { await require('stream/promises').pipeline(from, to); await fs.promises.rename(tmp, dst); }
  catch (e) { await fs.promises.rm(tmp, { force: true }).catch(() => {}); throw e; }
  progress?.(1);
}

async function importFiles(p, files) {
  const out = [];
  const list = files.slice(0, 200);
  for (const [i, src] of list.entries()) {
    const base = path.basename(src), ext = path.extname(src).slice(1).toLowerCase();
    const progress = v => { if (win && !win.isDestroyed()) win.webContents.send('import-progress', { name: base, index: i, count: list.length, value: v }); };
    try {
      // stat, not lstat: a symlink or a folder alias to a file brings in the file it points to
      const st = await fs.promises.stat(src);
      // a ScreenFlow project (a package folder): its document and recordings come in; the editor rebuilds it
      if (st.isDirectory() && ext === 'screenflow') { out.push(await importScreenflowPackage(p, src, base, progress)); continue; }
      if (st.isFile() && ext === 'screenflowf') throw new Error('This is a flattened ScreenFlow file. In ScreenFlow, use File › Save As and save it as a normal project, then drop that in.');
      if (!st.isFile()) { out.push({ error: `${base}: ${st.isDirectory() ? 'that’s a folder; drop the files inside it' : 'not a file Reel can read'}` }); continue; }
      if (FORMATS.unsupported.includes(ext)) throw new Error(`.${ext} files can't be read on a Mac without extra software. Export it as MP4, MOV or WAV first.`);
      const copyAs = async () => { const name = await freeMediaName(p, base); await copyWithProgress(src, path.join(mediaDir(p), name), st.size, progress); return name; };
      // WebM / Matroska / Ogg: the editor converts them (it can read them, macOS can't)
      if (FORMATS.browserVideo.includes(ext) || FORMATS.browserAudio.includes(ext)) {
        const name = await copyAs();
        out.push({ browserConvert: { file: name, kind: FORMATS.browserVideo.includes(ext) ? 'video' : 'audio', name: base } });
        continue;
      }
      let kind = null;
      if (FORMATS.imageConform.includes(ext)) kind = 'image';
      else if (FORMATS.audioConform.includes(ext)) kind = 'audio';
      else if (FORMATS.videoConform.includes(ext)) kind = 'video';
      let info = null;
      // a WAV the editor can't play as it is (8-bit, 64-bit float, compressed, unreadable header): converted
      if (ext === 'wav') {
        info = await probeMedia(src).catch(() => null);
        if (!info || info.playable === false) kind = 'audio';
        else delete info.playable;
      }
      if (!kind && !info) {
        info = await probeMedia(src).catch(() => null);
        // MP4 / MOV / M4A the editor can't export as they are (ProRes, Apple Lossless, MPEG-4 Part 2…)
        if (!info) { if (!['mp4', 'm4v', 'mov', 'm4a'].includes(ext)) throw new Error('Unsupported file type'); kind = ext === 'm4a' ? 'audio' : 'video'; }
        else if (info.exportable === false) kind = info.kind === 'audio' ? 'audio' : 'video';
      }
      if (!kind) {
        const name = await copyAs();
        out.push({ file: name, name: base, role: 'import', srcSize: st.size, ...info }); // srcSize: to spot the same file brought in twice
        continue;
      }
      if (!audio.available()) throw new Error('Converting this format needs the media helper, which isn’t part of this build.');
      const stem = path.basename(await freeMediaName(p, path.basename(base, path.extname(base)) + (kind === 'image' ? '.jpg' : kind === 'audio' ? '.wav' : '.mp4')));
      const dstBase = path.join(mediaDir(p), stem.replace(/\.[^.]+$/, ''));
      progress(0);
      const r = await audio.conform(src, dstBase, kind, progress);
      const file = path.basename(r.dst);
      out.push({ file, name: base, role: 'import', convertedFrom: ext, srcSize: st.size, ...(await probeMedia(r.dst)) });
    } catch (e) {
      out.push({ error: `${base}: ${e.message}` });
    }
  }
  return out;
}

/**
 * A .screenflow package: its document goes to the editor with a list of the media files inside. Nothing is
 * copied yet: the editor reads the project and asks only for what the timeline uses (media:copyIn, importPaths).
 */
async function importScreenflowPackage(p, src, base, progress) {
  const docFile = path.join(src, 'ScreenFlowDocument.dat');
  const st = await fs.promises.stat(docFile).catch(() => null);
  if (!st || st.size > 256 << 20) throw new Error('This ScreenFlow project has no document Reel can read.');
  progress(0.5);
  const doc = new Uint8Array(await fs.promises.readFile(docFile));
  const media = [];
  const mediaRoot = path.join(src, 'Media');
  for (const f of await fs.promises.readdir(mediaRoot, { withFileTypes: true }).catch(() => [])) {
    if (!f.isFile() || f.name.startsWith('.')) continue;
    const ext = path.extname(f.name).slice(1).toLowerCase();
    if (ext === 'scc' || MEDIA_EXT.includes(ext)) media.push({ path: path.join(mediaRoot, f.name), base: f.name, scc: ext === 'scc' });
  }
  progress(1);
  return { screenflow: { name: base.replace(/\.screenflow$/i, ''), path: src, doc, media } };
}

/**
 * A ScreenFlow recording (.scc inside a .screenflow package) made readable to the editor where it is, without
 * copying (they run to gigabytes, often on another drive). Returns the app:// URL to read it from.
 */
handle('media:copyIn', async (token, src) => {
  projectOf(token);
  const [file] = validate.paths([src]) || [];
  if (!file || !/\.scc$/i.test(file) || !/\.screenflow[\\/]/i.test(file)) throw new Error('Bad recording path');
  if (!(await fs.promises.stat(file).then(st => st.isFile(), () => false))) throw new Error('The recording isn’t there any more');
  const id = String(externalSeq++);
  external.set(`${token}/${id}`, file);
  return `app://reel/x/${token}/${id}`;
});

handle('media:importPaths', async (token, paths) => {
  const p = projectOf(token);
  const clean = validate.paths(paths);
  if (!clean) return [];
  const exist = [];
  for (const f of clean) if (await fs.promises.stat(f).then(s => s.isFile(), () => false)) exist.push(f);
  return exist.length ? importFiles(p, exist) : [];
});
handle('media:writeJson', async (token, stem, data) => {
  const p = projectOf(token);
  const raw = JSON.stringify(data);
  if (raw.length > 64 << 20) throw new Error('Too large');
  const name = await freeMediaName(p, `${validate.fileStem(String(stem || 'data')).slice(0, 60) || 'data'}.json`);
  await writeAtomic(path.join(mediaDir(p), name), raw);
  return name;
});

// ------------------------------------------------------------------ speech → timed words (auto captions, transcript editing)
const SPEECH_BIN = path.join(__dirname, 'bin', 'reel-speech');
const speechJobs = new Map();
handle('speech:transcribe', async (token, file, from, to, locale, jobId) => {
  const p = projectOf(token);
  if (!validate.mediaName(file)) throw new Error('Bad media');
  const src = path.join(mediaDir(p), file);
  await fs.promises.access(src);
  try { await fs.promises.access(SPEECH_BIN, fs.constants.X_OK); } catch { throw new Error('Auto captions need the speech helper, which wasn’t built (run Build ProtoArt Reel again with Xcode’s command line tools installed).'); }
  const loc = /^[a-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(String(locale || '')) ? String(locale) : 'en-US';
  const args = [src, loc, String(Math.max(0, Number(from) || 0)), String(Math.max(0, Number(to) || 0))];
  return new Promise((resolve, reject) => {
    const proc = spawn(SPEECH_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME || '' } });
    speechJobs.set(String(jobId || ''), proc);
    const words = []; let buf = '', err = '', onDevice = null;
    proc.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.type === 'words') { for (const w of m.words) words.push(w); win?.webContents.send('speech:progress', jobId, { words: m.words }); }
        else if (m.type === 'progress') win?.webContents.send('speech:progress', jobId, { value: m.value });
        else if (m.type === 'done') onDevice = m.onDevice;
        else if (m.type === 'error') err = m.message;
      }
    });
    proc.stderr.on('data', () => {});
    proc.on('error', e => { speechJobs.delete(String(jobId || '')); reject(e); });
    proc.on('close', code => {
      speechJobs.delete(String(jobId || ''));
      if (code === 0) return resolve({ words, onDevice });
      if (err === 'not-authorized') return reject(new Error('macOS hasn’t allowed ProtoArt Reel to use speech recognition. Turn it on in System Settings › Privacy & Security › Speech Recognition, then try again.'));
      reject(new Error(err || (code === null ? 'Cancelled' : `Speech recognition stopped (${code})`)));
    });
  });
});
handle('speech:cancel', async jobId => { speechJobs.get(String(jobId || ''))?.kill(); return true; });
// exact colour fix for ScreenFlow conversions made before 1.4 (see engine/fixrange.js)
handle('media:fixRange', async (token, file) => {
  const p = projectOf(token);
  if (!validate.mediaName(file)) throw new Error('Bad media');
  const { markFullRange } = require('./engine/fixrange');
  const r = markFullRange(path.join(mediaDir(p), file));
  // the proxies were made from the darkened picture: they go to the Trash and are made again
  const stem = file.replace(/\.[^.]+$/, ''), trashed = [];
  for (const n of await fs.promises.readdir(mediaDir(p))) {
    if (n.startsWith(`${stem} proxy`) && /\.mp4(\.\d+\.part)?$/.test(n)) { await shell.trashItem(path.join(mediaDir(p), n)).catch(() => {}); trashed.push(n); }
  }
  return { result: r, trashed };
});
handle('theme:set', async choice => {
  // the window's own chrome (title bar, menus, scroll bars) follows Reel's finish
  nativeTheme.themeSource = choice === 'light' || choice === 'dark' ? choice : 'system';
  return true;
});
handle('machine:info', async () => {
  const cpu = (os.cpus()[0] || {}).model || '';
  let macos = '';
  try { macos = process.getSystemVersion(); } catch { /* unknown */ }
  return { ram: os.totalmem() / 1024 ** 3, chip: cpu.replace(/\s+/g, ' ').trim(), cores: os.cpus().length, macos, arch: process.arch };
});
handle('storage:get', async () => {
  const root = projectsRoot();
  let free = null;
  try { const st = await fs.promises.statfs(fs.existsSync(root) ? root : path.dirname(root)); free = st.bavail * st.bsize; } catch { /* unknown */ }
  return { root, isDefault: root === DEFAULT_ROOT, free, external: root.startsWith('/Volumes/') };
});
handle('storage:choose', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Save new projects and recordings in…', defaultPath: projectsRoot(), buttonLabel: 'Use This Folder', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const dir = r.filePaths[0];
  await fs.promises.access(dir, fs.constants.W_OK).catch(() => { throw new Error('Reel can’t write to that folder.'); });
  store.setStorageRoot(dir === DEFAULT_ROOT ? '' : dir);
  return projectsRoot();
});
handle('storage:reset', async () => { store.setStorageRoot(''); return projectsRoot(); });
// The open project's cache (Settings › Media & Storage): proxies and rendered plug-in sound in its media folder
const PROXY_FILE = /\sproxy(-\d+)?\.mp4$/i, RENDER_FILE = /^fx-.*\.wav$/i;
handle('cache:info', async token => {
  const dir = mediaDir(projectOf(token)), out = { proxies: { n: 0, bytes: 0 }, renders: { n: 0, bytes: 0 }, media: { n: 0, bytes: 0 } };
  let names = [];
  try { names = await fs.promises.readdir(dir); } catch { return out; }
  for (const n of names) {
    let st; try { st = await fs.promises.stat(path.join(dir, n)); } catch { continue; }
    if (!st.isFile()) continue;
    const k = PROXY_FILE.test(n) ? 'proxies' : RENDER_FILE.test(n) ? 'renders' : 'media';
    out[k].n++; out[k].bytes += st.size;
  }
  return out;
});
handle('cache:clearProxies', async token => {
  const dir = mediaDir(projectOf(token));
  let n = 0;
  for (const name of await fs.promises.readdir(dir).catch(() => [])) {
    if (!PROXY_FILE.test(name)) continue;
    try { await shell.trashItem(path.join(dir, name)); n++; } catch { /* in use or gone */ }
  }
  return n;
});
handle('storage:reveal', async () => { await fs.promises.mkdir(projectsRoot(), { recursive: true }).catch(() => {}); shell.openPath(projectsRoot()); });
handle('rec:permissions', async () => ({
  screen: systemPreferences.getMediaAccessStatus('screen'),
  camera: systemPreferences.getMediaAccessStatus('camera'),
  microphone: systemPreferences.getMediaAccessStatus('microphone'),
}));
handle('rec:askAccess', async kind => {
  if (kind !== 'camera' && kind !== 'microphone') return false;
  return systemPreferences.askForMediaAccess(kind);
});
handle('rec:openPrivacy', async kind => {
  const pane = { screen: 'Privacy_ScreenCapture', camera: 'Privacy_Camera', microphone: 'Privacy_Microphone' }[kind];
  if (pane) await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
});
handle('rec:sources', listSources);
handle('rec:select', async (sourceId, systemAudio) => {
  if (typeof sourceId !== 'string' || !/^(screen|window):[\w:-]+$/.test(sourceId)) throw new Error('Bad source');
  recording.sourceId = sourceId;
  recording.systemAudio = !!systemAudio;
  return true;
});

handle('rec:begin', async (token, tracks, apps, input) => {
  ai.release(); // free AI memory for the recorder on 8–16 GB Macs
  const p = projectOf(token);
  const specs = validate.recTracks(tracks);
  const appList = validate.recApps(apps);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const out = {};
  for (const t of specs) {
    const ext = t.format === 'wav' ? '.wav' : '.mp4';
    const name = await freeMediaName(p, `rec-${stamp}-${t.role}${t.format === 'wav' ? '' : '-raw'}${ext}`);
    const id = await openHandle(path.join(mediaDir(p), name), 'rec', { role: t.role, format: t.format, name, project: p, rate: t.sampleRate, channels: t.channels });
    if (t.format === 'wav') await appendTo(handles.get(id), wavHeader(t.sampleRate, t.channels, 0));
    out[t.role] = id;
  }
  // chosen apps' sound, each to its own WAV, through the per-app audio helper
  recording.apps = [];
  if (appList.length) {
    const reqs = [];
    for (const a of appList) {
      const name = await freeMediaName(p, `rec-${stamp}-app-${validate.fileStem(a.name).replace(/\s+/g, '-') || 'app'}.wav`);
      reqs.push({ key: a.key, file: path.join(mediaDir(p), name) });
      recording.apps.push({ key: a.key, name: a.name, file: name });
    }
    try {
      const r = await audio.recStart(stamp, reqs);
      const ok = new Set((r.tracks || []).map(t => t.key));
      recording.apps = recording.apps.filter(a => ok.has(a.key));
    } catch (e) { recording.apps = []; recording.appError = e.message; }
  }
  recording.active = true;
  recording.paused = false; recording.pausedMs = 0; recording.pauseAt = 0; recording.marks = [];
  recording.project = p;
  recording.stamp = stamp;
  recording.started = Date.now();
  // a new take while the panel is up (RETAKE): its clock and marker count start again
  if (hud && !hud.isDestroyed()) { hud.webContents.send('hud:paused', false, 0); hud.webContents.send('hud:marked', 0); }
  if (recording.sourceId) { startCursorTrack(recording.sourceId); startInputTrack(input && typeof input === 'object' ? { clicks: input.clicks === true, keys: input.keys === true } : null); }
  setRecordingUi(true);
  return out;
});

/** Pause or resume: the editor pauses its recorders; here the pointer track, the apps' sound and the panel follow. */
// Your ums found by the Rust helper, off the editor's thread. Answers null when the helper isn't in this build
// (the editor then does it in JavaScript). The model is the stored one (plain numbers); samples are 16 kHz mono.
// A media file's waveform and loudness profile from the Rust core, which reads the file itself. Only a plain file
// (no link) in the open project's media folder, named the way every media name is checked. null → the editor
// uses its JavaScript workers instead.
handle('core:analyze', async (token, name) => {
  if (!core.available()) return null;
  const p = projectOf(token);
  if (!validate.mediaName(name)) return null;
  const file = path.join(mediaDir(p), name);
  try {
    const st = await fs.promises.lstat(file);
    if (!st.isFile() || st.size === 0) return null;
    return await core.analyze(file);
  } catch { return null; }
});

// Watching a video for Auto Edit and Smart Zoom without playing it (reel-core 1.8): the Mac's decoder reads its frames
// (reel-frames, small and grey) straight into the Rust core, which measures the motion and finds the pointer.
// Only a plain file in the open project's media folder. null → this build hasn't both helpers (or an older core):
// the editor watches by playing, as before. Cancelled with core:watchStop.
const FRAMES_BIN = path.join(__dirname, 'bin', 'reel-frames');
const coreWatches = new Map();
handle('core:watch', async (id, token, name, o) => {
  if (!core.available() || typeof id !== 'string' || id.length > 64) return null;
  try { await fs.promises.access(FRAMES_BIN, fs.constants.X_OK); } catch { return null; }
  coreVersion ??= core.version();
  const v = String((await coreVersion) || '0').split('.').map(Number);
  if ((v[0] || 0) < 1 || ((v[0] || 0) === 1 && (v[1] || 0) < 8)) return null;
  const p = projectOf(token);
  if (!validate.mediaName(name) || !o || typeof o !== 'object') return null;
  const num = (x, a, b) => typeof x === 'number' && Number.isFinite(x) && x >= a && x <= b;
  const int = (x, a, b) => Number.isInteger(x) && x >= a && x <= b;
  if (!num(o.from, 0, 1e6) || !num(o.to, 0, 1e6) || !(o.to > o.from) || !num(o.step, 0.01, 10) || !int(o.gw, 3, 256) || !int(o.gh, 3, 256)
    || !int(o.pw || 0, 0, 3840) || !int(o.ph || 0, 0, 2160) || !num(o.giveUp || 0, 0, 1e6)) throw new Error('Bad watch');
  const file = path.join(mediaDir(p), name);
  const st = await fs.promises.lstat(file);
  if (!st.isFile()) return null;
  const ctl = new AbortController();
  const dec = spawn(FRAMES_BIN, [file, String(o.from), String(o.to), String(o.step), String(o.gw), String(o.gh), String(o.pw || 0), String(o.ph || 0)],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME || '' } });
  let why = '';
  dec.stderr.setEncoding('utf8'); dec.stderr.on('data', d => { why = (why + d).slice(-400); });
  const ended = new Promise(res => dec.on('close', c => res(c)));
  coreWatches.set(id, () => { ctl.abort(); try { dec.kill(); } catch { /* gone */ } });
  const send = t => { if (win && !win.isDestroyed()) win.webContents.send('core:progress', id, t); };
  // a watchdog: a file the decoder gets stuck on (a damaged recording) mustn't hold everything up. 15 s without a
  // frame and it's stopped; the editor then watches that clip by playing it, which has its own time limit
  let last = Date.now(), stalled = false;
  dec.stdout.on('data', () => { last = Date.now(); });
  const dog = setInterval(() => { if (Date.now() - last > 15000) { stalled = true; ctl.abort(); try { dec.kill('SIGKILL'); } catch { /* gone */ } } }, 2000);
  try {
    const r = await core.watch({ gw: o.gw, gh: o.gh, pw: o.pw || 0, ph: o.ph || 0, giveUp: o.giveUp || 0 }, dec.stdout, { onProgress: send, signal: ctl.signal });
    const code = await ended;
    // the decoder gave up on the file: the editor watches it by playing instead
    if (code !== 0 || stalled) return null;
    return r;
  } catch (e) {
    if (stalled) { console.warn(`reel-frames stalled on ${name}; watching it by playing instead`); return null; }
    if (ctl.signal.aborted) throw new Error('Cancelled');
    if (why) return null;
    throw e;
  } finally { clearInterval(dog); coreWatches.delete(id); try { dec.kill(); } catch { /* gone */ } }
});
handle('core:watchStop', async id => { coreWatches.get(id)?.(); });

handle('core:umFind', async (model, samples) => {
  if (!core.available()) return null;
  if (!(samples instanceof Float32Array) || !model || typeof model !== 'object') return null;
  try { return await core.umFind(model, samples); } catch { return null; }
});

handle('rec:pause', async paused => {
  if (!recording.active) return false;
  paused = !!paused;
  if (paused === recording.paused) return paused;
  if (paused) recording.pauseAt = Date.now();
  else recording.pausedMs += Date.now() - recording.pauseAt;
  recording.paused = paused;
  // the panel and the menu-bar icon change at once; the apps' sound follows (it can take a moment)
  if (hud && !hud.isDestroyed()) hud.webContents.send('hud:paused', paused, recordedMs(recording.started));
  recTrayMenu();
  if (recording.apps && recording.apps.length) await audio.recPause(recording.stamp, paused).catch(() => {});
  return paused;
});

on('rec:chunk', (id, data) => {
  try {
    const h = handleOf(id, 'rec');
    if (!(data instanceof Uint8Array) || data.length > 64 << 20) return;
    appendTo(h, data).catch(() => {});
  } catch { /* ignore stray chunks */ }
});

handle('rec:end', async (ids, meta, stayHidden) => {
  setRecordingUi(false);
  // the editor comes back now, showing that the recording is being saved (a long take takes a little while)
  if (win && !win.isDestroyed() && stayHidden !== true) { win.show(); win.focus(); }
  const cursor = stopCursorTrack();
  recording.active = false;
  const p = recording.project;
  const results = [];
  if (!Array.isArray(ids)) ids = [];
  for (const id of ids) {
    const h = await closeHandle(id);
    if (!h) continue;
    try {
      if (h.format === 'wav') {
        const fh = await fs.promises.open(h.file, 'r+');
        try { await fh.write(wavHeader(h.rate, h.channels, h.bytes - 58), 0, 58, 0); } finally { await fh.close(); }
        results.push({ role: h.role, file: h.name, kind: 'audio', duration: (h.bytes - 58) / (h.rate * h.channels * 4), hasAudio: true });
      } else {
        const final = await freeMediaName(p, h.name.replace('-raw.mp4', '.mp4'));
        const info = await remuxRecording(h.file, path.join(mediaDir(p), final));
        await fs.promises.rm(h.file, { force: true });
        // straight away: can the Mac actually play its picture? (a take that came out damaged is said at once, while
        // it's easy to record again, not found an hour into editing)
        const damaged = await checkVideoPlays(path.join(mediaDir(p), final), info.duration).catch(() => null);
        results.push({ role: h.role, file: final, kind: 'video', ...info, ...(damaged ? { damaged } : {}) });
      }
    } catch (e) {
      results.push({ role: h.role, file: h.name, error: e.message });
    }
  }
  if (recording.apps && recording.apps.length) {
    try {
      const r = await audio.recStop(recording.stamp);
      for (const t of r.tracks || []) {
        const a = recording.apps.find(x => x.key === t.key);
        if (!a) continue;
        results.push({ role: 'app', appKey: a.key, appName: a.name, file: a.file, kind: 'audio', hasAudio: true, duration: t.rate ? t.frames / t.rate : 0 });
      }
    } catch (e) { results.push({ role: 'app', error: e.message }); }
    recording.apps = [];
  }
  if (recording.appError) { results.push({ role: 'app', error: recording.appError }); recording.appError = null; }
  let cursorFile = '';
  if (cursor && p && cursor.points.length) {
    cursorFile = await freeMediaName(p, `rec-${recording.stamp}-cursor.json`);
    await writeAtomic(path.join(mediaDir(p), cursorFile), JSON.stringify(cursor));
  }
  // stayHidden: the recording carries on in a new part straight away (see RESUME after the Mac ended the capture)
  if (win && !win.isDestroyed() && stayHidden !== true) { win.show(); win.focus(); }
  return { media: results, cursor: cursorFile, cursorClicks: cursor?.clicks?.length || 0, cursorKeys: cursor?.keys?.length || 0, inputError: recording.inputError || '', offsets: validate.offsets(meta), marks: recording.marks.slice() };
});

handle('rec:cancel', async ids => {
  setRecordingUi(false);
  stopCursorTrack();
  recording.active = false;
  if (recording.apps && recording.apps.length) {
    await audio.recStop(recording.stamp).catch(() => {});
    for (const a of recording.apps) await fs.promises.rm(path.join(mediaDir(recording.project), a.file), { force: true }).catch(() => {});
    recording.apps = [];
  }
  for (const id of Array.isArray(ids) ? ids : []) {
    const h = await closeHandle(id);
    if (h) await fs.promises.rm(h.file, { force: true });
  }
  if (win && !win.isDestroyed()) win.show();
});

// RETAKE on the recording panel: throw this take away (its files are deleted) but stay in recording mode, so the
// editor can start a fresh take straight away with the same screen, camera and microphone.
handle('rec:discard', async (ids, seconds) => {
  stopCursorTrack();
  recording.active = false;
  if (recording.apps && recording.apps.length) {
    await audio.recStop(recording.stamp).catch(() => {});
    for (const a of recording.apps) await fs.promises.rm(path.join(mediaDir(recording.project), a.file), { force: true }).catch(() => {});
    recording.apps = [];
  }
  for (const id of Array.isArray(ids) ? ids : []) {
    const h = await closeHandle(id);
    if (h) await fs.promises.rm(h.file, { force: true });
  }
  const n = Math.max(0, Math.min(10, Number(seconds) || 0));
  if (hud && !hud.isDestroyed()) hud.webContents.send('hud:retake', n);
  return true;
});

handle('rec:hideWindow', async () => { if (win) win.hide(); });

handle('media:readJson', async (token, name) => {
  const p = projectOf(token);
  if (!validate.mediaName(name) || !name.endsWith('.json')) throw new Error('Bad name');
  const raw = await fs.promises.readFile(path.join(mediaDir(p), name), 'utf8');
  if (raw.length > 64 << 20) throw new Error('Too large');
  return JSON.parse(raw);
});

// A copy Reel has just made of a file that turned out to be one already in the project (you chose to skip it): only
// Reel's own copy, in the project's media folder, goes; the file you brought in is never touched.
handle('media:discard', async (token, name) => {
  const p = projectOf(token);
  if (!validate.mediaName(name)) throw new Error('Bad name');
  const f = path.join(mediaDir(p), name);
  const st = await fs.promises.lstat(f).catch(() => null);
  if (!st || !st.isFile() || Date.now() - st.mtimeMs > 60 * 60 * 1000) return false; // only a copy made just now
  await fs.promises.unlink(f);
  return true;
});

handle('media:delete', async (token, name) => {
  const p = projectOf(token);
  if (!validate.mediaName(name)) throw new Error('Bad name');
  await shell.trashItem(path.join(mediaDir(p), name));
  return true;
});

handle('export:begin', async (token, suggested, kind) => {
  ai.release(); // free AI memory for the encoder on 8–16 GB Macs
  const p = projectOf(token);
  const ext = kind === 'm4a' ? 'm4a' : kind === 'wav' ? 'wav' : kind === 'gif' ? 'gif' : kind === 'apng' ? 'png' : 'mp4';
  const r = await dialog.showSaveDialog(win, {
    title: 'Export', defaultPath: path.join(app.getPath('videos'), `${validate.fileStem(suggested) || p.name}.${ext}`),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (r.canceled || !r.filePath) return null;
  const dst = r.filePath;
  const body = path.join(path.dirname(dst), `.${path.basename(dst)}.${process.pid}.part`);
  const id = await openHandle(body, 'export', { dst });
  return { id, name: path.basename(dst) };
});
/** Batch export: pick a folder once, then each item is written there without asking again. */
const batchFolders = new Map();
// an export left running (a batch): the Mac doesn't go to sleep under it (the screen still may)
let exportAwake = null;
handle('export:keepAwake', async on => {
  if (on && (exportAwake == null || !powerSaveBlocker.isStarted(exportAwake))) exportAwake = powerSaveBlocker.start('prevent-app-suspension');
  else if (!on && exportAwake != null) { if (powerSaveBlocker.isStarted(exportAwake)) powerSaveBlocker.stop(exportAwake); exportAwake = null; }
});
handle('export:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Export the batch to…', defaultPath: app.getPath('videos'), properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const id = crypto.randomUUID();
  batchFolders.set(id, r.filePaths[0]);
  return { id, name: path.basename(r.filePaths[0]) };
});
handle('export:beginIn', async (token, folderId, suggested, kind) => {
  ai.release();
  const p = projectOf(token);
  const dir = batchFolders.get(folderId);
  if (!dir) throw new Error('Pick the batch folder again');
  const ext = kind === 'm4a' ? 'm4a' : kind === 'wav' ? 'wav' : kind === 'gif' ? 'gif' : kind === 'apng' ? 'png' : 'mp4';
  const stem = validate.fileStem(String(suggested || p.name)) || 'Export';
  let dst = path.join(dir, `${stem}.${ext}`);
  for (let i = 2; fs.existsSync(dst) && i < 1000; i++) dst = path.join(dir, `${stem} ${i}.${ext}`);
  const body = path.join(dir, `.${path.basename(dst)}.${process.pid}.part`);
  const id = await openHandle(body, 'export', { dst });
  return { id, name: path.basename(dst) };
});
on('export:chunk', (id, data) => {
  try {
    const h = handleOf(id, 'export');
    if (data instanceof Uint8Array && data.length <= 256 << 20) appendTo(h, data).catch(() => {});
  } catch { /* ignore */ }
});
handle('export:finish', async (id, head) => {
  const h = await closeHandle(id);
  if (!h || h.kind !== 'export') throw new Error('Unknown export');
  if (!(head instanceof Uint8Array) || head.length > 512 << 20) throw new Error('Bad header');
  // Replace an existing file only after the new one is complete.
  const tmp = `${h.dst}.${process.pid}.tmp`;
  await joinFiles(tmp, head, h.file);
  await fs.promises.rename(tmp, h.dst);
  exportedFiles.add(h.dst);
  return { name: path.basename(h.dst) };
});
// A sound-only export mixed and written by the Rust core (the editor sends the clip plans, see lib/mixplan.js):
// sources are checked media names in this project (plain files, no links); the core writes a new temporary file
// beside the destination, which replaces the destination only once it's complete. Answers null when the core
// isn't in this build (the editor then exports in JavaScript); the export handle stays open for that.
const coreMixes = new Map();
let coreVersion = null; // asked once
/** Checks a core mix job from the editor (lib/mixplan.js): its media (checked names in project p, plain files), its
 * numbers. Returns { sources, codec }, or null when this core is too old for it. */
async function checkMix(p, job) {
  if (!job || typeof job !== 'object' || !Array.isArray(job.sources) || !Array.isArray(job.plans) || job.sources.length > 2000 || job.plans.length > 20000) throw new Error('Bad mix');
  const sources = [];
  for (const name of job.sources) {
    if (!validate.mediaName(name)) throw new Error('Bad media name');
    const f = path.join(mediaDir(p), name), st = await fs.promises.lstat(f);
    if (!st.isFile()) throw new Error('Not a media file');
    sources.push(f);
  }
  const codec = job.codec === 'aac' ? 'aac' : job.codec === 'wav' ? 'wav' : null;
  if (!codec || ![44100, 48000].includes(job.rate) || !(job.total > 0) || !Number.isFinite(job.mixGain)) throw new Error('Bad mix');
  if (!Array.isArray(job.limiters) || job.limiters.length > 16 || job.limiters.some(l => !(l && l.ceil > 0 && l.ceil <= 4 && l.rel >= 0 && l.rel < 1))) throw new Error('Bad limiter');
  for (const pl of job.plans) if (!(pl && Number.isInteger(pl.src) && pl.src >= 0 && pl.src < sources.length && pl.env instanceof Float32Array)) throw new Error('Bad clip plan');
  // what each newer part of the core needs: a loudness target 0.6, click sounds 0.7, keep-pitch 0.8, effects 0.9,
  // the built-in master 1.0, time maps 1.1; an older core isn't asked
  const needs = job.maps != null ? 11 : job.loud != null && (job.loud.master != null || job.loud.target == null) ? 10 : job.fx != null ? 9 : job.stretch != null ? 8 : job.clicks != null ? 7 : job.loud != null ? 6 : 0;
  if (job.maps != null) {
    const okMap = m => m == null || (m && typeof m.tape === 'boolean' && m.dur > 0 && m.dur < 3 * 3600 && Array.isArray(m.pts) && m.pts.length >= 2 && m.pts.length <= 10000 && m.pts.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)));
    if (!(Array.isArray(job.maps) && job.stretch && job.fx && job.maps.length === job.stretch.clips.length && job.maps.every(okMap))) throw new Error('Bad time maps');
  }
  if (job.fx != null) {
    const okChain = list => Array.isArray(list) && list.length <= 64 && list.every(u => Array.isArray(u) && Number.isInteger(u[0]) && u[0] >= 0 && u[0] <= 9 && Array.isArray(u[1]) && u[1].length <= 64 && u[1].every(Number.isFinite));
    const F = job.fx;
    if (!(F && Array.isArray(F.chains) && F.chains.length <= 256 && F.chains.every(okChain) && (F.bus == null || okChain(F.bus)) && Array.isArray(F.chainOf) && F.chainOf.every(t => Number.isInteger(t) && t >= -1 && t < F.chains.length))) throw new Error('Bad effects');
  }
  if (job.stretch != null) {
    const st = job.stretch;
    if (!(st && st.win instanceof Float32Array && st.win.length >= 16 && st.win.length <= 48000 && Number.isInteger(st.tol) && st.tol >= 1 && st.tol <= 48000 && Array.isArray(st.clips) && st.clips.length <= 2000
      && st.clips.every(c => c && Number.isInteger(c.src) && c.src >= 0 && c.src < sources.length && [c.in, c.srcLen, c.speed, c.cs, c.ce, c.start].every(Number.isFinite) && Array.isArray(c.gains) && c.gains.length <= 2e6)
      && Array.isArray(st.order) && st.order.every(k => Number.isInteger(k) && k >= 0 && k < job.plans.length + st.clips.length))) throw new Error('Bad stretch');
  }
  if (job.clicks != null) {
    const k = job.clicks;
    if (!(k && Number.isFinite(k.start) && Number.isInteger(k.block) && k.block >= 1 && k.block <= 65536 && k.wave instanceof Float32Array && k.wave.length <= 48000 && Array.isArray(k.clips) && k.clips.length <= 2000
      && k.clips.every(c => c && [c.start, c.in, c.end, c.offset, c.gain].every(Number.isFinite) && c.speed > 0 && c.speed < 100 && (c.ms instanceof Float64Array || Array.isArray(c.ms)) && c.ms.length <= 1e6))) throw new Error('Bad clicks');
  }
  if (needs) {
    coreVersion ??= core.version();
    const v = String((await coreVersion) || '0').split('.').map(Number);
    // needs 6–9: reel-core 0.6–0.9; 10: 1.0 (the built-in master); 11: 1.1 (time maps)
    const has = (v[0] || 0) >= 1 ? 10 + (v[1] || 0) : (v[1] || 0);
    if (has < needs) return null;
  }
  if (job.loud != null) {
    const L = job.loud;
    if (L.master != null && !(Array.isArray(L.master) && L.master.length <= 400 && L.master.every(Number.isFinite))) throw new Error('Bad master');
    if (!(L && (L.target == null || (L.target > -70 && L.target < 0)) && L.ceil > 0 && L.ceil <= 1 && L.rel >= 0 && L.rel < 1 && Number.isInteger(L.look) && L.look >= 1 && L.look <= 4800 && L.measure > 0)) throw new Error('Bad loudness target');
  }
  return { sources, codec };
}
// the sound of an export the Rust core draws, when it has a loudness target (1.12): the core mixes and masters it
// into a new WAV in the project's media folder (master-mix…, removed after), as the sound-only export does
handle('core:mixToMedia', async (token, job) => {
  if (!core.available()) return null;
  const p = projectOf(token);
  if (!job || job.codec !== 'wav') throw new Error('Bad mix');
  const checked = await checkMix(p, job);
  if (!checked) return null;
  const name = await freeMediaName(p, 'master-mix-core.wav'), out = path.join(mediaDir(p), name);
  try { await core.mix({ ...job, codec: 'wav', sources: checked.sources, bitrate: 192000 }, out, () => {}); }
  catch (e) { await fs.promises.rm(out, { force: true }).catch(() => {}); throw e; }
  return name;
});
handle('core:mixExport', async (id, token, job) => {
  if (!core.available()) return null;
  const h = handleOf(id, 'export');
  const p = projectOf(token);
  const checked = await checkMix(p, job);
  if (!checked) return null;
  const { sources, codec } = checked;
  const tmp = `${h.dst}.${process.pid}.core.tmp`;
  await fs.promises.rm(tmp, { force: true });
  const send = f => { if (win && !win.isDestroyed()) win.webContents.send('core:progress', id, f); };
  coreMixes.set(id, tmp);
  try {
    const res = await core.mix({ ...job, codec, sources, bitrate: Math.max(64000, Math.min(320000, job.bitrate | 0 || 192000)) }, tmp, send);
    if (!coreMixes.has(id)) throw new Error('Cancelled');
    await closeHandle(id);
    await fs.promises.rm(h.file, { force: true }); // the JavaScript export's part file, unused
    await fs.promises.rename(tmp, h.dst);
    exportedFiles.add(h.dst);
    return { name: path.basename(h.dst), loudness: Number.isFinite(res?.loudness) ? res.loudness : null };
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw e;
  } finally { coreMixes.delete(id); }
});

// A video export drawn by the Rust core (reel-core 1.10), when the editor sends it one (lib/videoplan.js made it, so
// every frame is one the core draws): the Mac's decoder reads each clip (reel-frames --rgba), the core draws the
// frames, the Mac's encoder writes them with the export's mixed sound (reel-encode). Only checked media names in this
// project and the mix Reel just made; a new temporary file beside the destination, which replaces it only once
// complete. null when this build hasn't all three, or has an older core: the editor then exports as before.
const ENCODE_BIN = path.join(__dirname, 'bin', 'reel-encode');
const coreVideos = new Map();
handle('core:videoExport', async (id, token, job) => {
  if (!core.available()) return null;
  for (const b of [FRAMES_BIN, ENCODE_BIN]) { try { await fs.promises.access(b, fs.constants.X_OK); } catch { return null; } }
  coreVersion ??= core.version();
  const v = String((await coreVersion) || '0').split('.').map(Number);
  // the job as 1.12 reads it (titles over the frames); a blurring call-out needs 1.13 (job.core: the minor version it needs)
  const need = Number.isInteger(job?.core) && job.core >= 12 && job.core < 100 ? job.core : 12;
  if ((v[0] || 0) < 1 || ((v[0] || 0) === 1 && (v[1] || 0) < need)) return null;
  const h = handleOf(id, 'export');
  const p = projectOf(token);
  if (!/\.mp4$/i.test(h.dst)) throw new Error('Bad export');
  const int = (x, a, b) => Number.isInteger(x) && x >= a && x <= b;
  const num = (x, a, b) => typeof x === 'number' && Number.isFinite(x) && x >= a && x <= b;
  if (!job || typeof job !== 'object' || !int(job.w, 2, 8192) || !int(job.h, 2, 8192) || job.w % 2 || job.h % 2 || !num(job.fps, 1, 240)
    || !['h264', 'hevc'].includes(job.codec) || !int(job.vbr, 100000, 400000000) || !int(job.abr, 32000, 512000)
    || !(job.body instanceof Uint8Array) || job.body.length > 1 << 30 || !Array.isArray(job.sources) || !job.sources.length || job.sources.length > 48) throw new Error('Bad export');
  const sources = [];
  for (const s of job.sources) {
    if (!s || !validate.mediaName(s.file) || !num(s.from, 0, 1e6) || !num(s.to, 0, 1e6) || s.to < s.from || !int(s.w, 2, 8192) || !int(s.h, 2, 8192)) throw new Error('Bad export source');
    const f = path.join(mediaDir(p), s.file), st = await fs.promises.lstat(f);
    if (!st.isFile()) throw new Error('Not a media file');
    sources.push({ path: f, from: s.from, to: Math.max(s.to, s.from + 0.001), w: s.w, h: s.h });
  }
  // the sound: the mix Reel wrote for this export (in the project's media folder), or none
  let sound = null;
  if (job.sound != null) {
    if (!validate.mediaName(job.sound) || !/^master-(mix|mastered)/.test(job.sound)) throw new Error('Bad export sound');
    sound = path.join(mediaDir(p), job.sound);
    if (!(await fs.promises.lstat(sound)).isFile()) throw new Error('Bad export sound');
  }
  const tmp = path.join(path.dirname(h.dst), `.${path.basename(h.dst, '.mp4')}.${process.pid}.core.mp4`);
  await fs.promises.rm(tmp, { force: true });
  const ctl = new AbortController();
  coreVideos.set(id, ctl);
  const send = f => { if (win && !win.isDestroyed()) win.webContents.send('core:progress', id, f); };
  try {
    const r = await videoExport({ coreBin: core.binary(), framesBin: FRAMES_BIN, encodeBin: ENCODE_BIN, sources, body: job.body, out: tmp, w: job.w, h: job.h, fps: job.fps,
      codec: job.codec, vbr: job.vbr, abr: job.abr, sound, onProgress: send, signal: ctl.signal, overlay: !!job.overlay, onOverlay: w => overlayPipe(id).set(w) });
    await closeHandle(id);
    await fs.promises.rm(h.file, { force: true }); // the JavaScript export's part file, unused
    await fs.promises.rename(tmp, h.dst);
    exportedFiles.add(h.dst);
    return { name: path.basename(h.dst), frames: r.frames };
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw e;
  } finally { coreVideos.delete(id); overlayPipe(id).set(null); coreOverlays.delete(id); }
});
// the editor's drawing over an export the core draws (titles, call-outs…): sent frame by frame as it's drawn, each
// written into the core's overlay descriptor before the next is taken (so the editor never runs far ahead)
const coreOverlays = new Map();
function overlayPipe(id) {
  let e = coreOverlays.get(id);
  if (!e) {
    let set; const ready = new Promise(r => { set = r; });
    e = { ready, set: w => { e.w = w; set(w); }, w: undefined };
    coreOverlays.set(id, e);
  }
  return e;
}
handle('core:overlay', async (id, data) => {
  if (typeof id !== 'string' || id.length > 64) throw new Error('Bad overlay');
  const e = overlayPipe(id);
  const w = e.w !== undefined ? e.w : await Promise.race([e.ready, new Promise(r => setTimeout(() => r(null), 60000))]);
  if (!w || w.destroyed) throw new Error('The export stopped');
  if (data == null) { w.end(); return; }
  if (!(data instanceof Uint8Array) || data.length > 64 << 20) throw new Error('Bad overlay');
  await new Promise((res, rej) => {
    const ok = w.write(Buffer.from(data.buffer, data.byteOffset, data.length), err => { if (err) rej(new Error('The export stopped')); });
    if (ok) res(); else { const done = () => { w.off('close', fail); res(); }; const fail = () => { w.off('drain', done); rej(new Error('The export stopped')); }; w.once('drain', done); w.once('close', fail); }
  });
});

handle('export:cancel', async id => {
  coreVideos.get(id)?.abort(); // a video the core is drawing stops
  coreMixes.delete(id); // a mix the core is still writing is thrown away when it ends
  const h = await closeHandle(id);
  if (h) await fs.promises.rm(h.file, { force: true });
});
handle('export:reveal', async name => {
  if (typeof name !== 'string') return;
  // Only reveal files we exported this session.
  for (const f of exportedFiles) if (path.basename(f) === name) shell.showItemInFolder(f);
});

handle('thumb:save', async (token, png, suggested) => {
  const p = projectOf(token);
  if (!(png instanceof Uint8Array) || png.length > 32 << 20) throw new Error('Bad image');
  const isPng = png[0] === 0x89 && png[1] === 0x50, isJpg = png[0] === 0xff && png[1] === 0xd8;
  if (!isPng && !isJpg) throw new Error('Bad image');
  const ext = isPng ? 'png' : 'jpg';
  // keep a copy with the project
  const keep = await freeMediaName(p, `thumbnail.${ext}`);
  await fs.promises.writeFile(path.join(mediaDir(p), keep), Buffer.from(png), { flag: 'wx' });
  const r = await dialog.showSaveDialog(win, {
    title: 'Save thumbnail', defaultPath: path.join(app.getPath('pictures'), `${validate.fileStem(suggested) || p.name} thumbnail.${ext}`),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (!r.canceled && r.filePath) await writeAtomic(r.filePath, Buffer.from(png));
  return { kept: keep, saved: !r.canceled };
});

// Stills and rendered media made inside Reel (freeze frames, reversed copies)
const isPng = b => b instanceof Uint8Array && b[0] === 0x89 && b[1] === 0x50;
handle('media:saveStill', async (token, png, label) => {
  const p = projectOf(token);
  if (!isPng(png) || png.length > 64 << 20) throw new Error('Bad image');
  const name = await freeMediaName(p, `${validate.fileStem(String(label || 'still')).slice(0, 60) || 'still'}.png`);
  const file = path.join(mediaDir(p), name);
  await fs.promises.writeFile(file, Buffer.from(png), { flag: 'wx' });
  return { file: name, name: name.replace(/\.png$/, ''), role: 'still', ...(await probeMedia(file)) };
});
handle('media:renderBegin', async (token, label, ext) => {
  const p = projectOf(token);
  const e = ['m4a', 'wav'].includes(ext) ? ext : 'mp4';
  const name = await freeMediaName(p, `${validate.fileStem(String(label || 'render')).slice(0, 60) || 'render'}.${e}`);
  const body = path.join(mediaDir(p), `.${name}.${process.pid}.part`);
  const id = await openHandle(body, 'render', { dst: path.join(mediaDir(p), name), name });
  return { id, name };
});
on('media:renderChunk', (id, data) => {
  try { const h = handleOf(id, 'render'); if (data instanceof Uint8Array && data.length <= 256 << 20) appendTo(h, data).catch(() => {}); } catch { /* ignore */ }
});
handle('media:renderFinish', async (id, head) => {
  const h = await closeHandle(id);
  if (!h || h.kind !== 'render') throw new Error('Unknown render');
  if (!(head instanceof Uint8Array) || head.length > 512 << 20) throw new Error('Bad header');
  try {
    await joinFiles(h.dst, head, h.file);
  } finally { await fs.promises.rm(h.file, { force: true }); }
  return { file: h.name, name: h.name.replace(/\.(mp4|m4a|wav)$/, ''), role: 'derived', ...(await probeMedia(h.dst)) };
});
handle('media:renderCancel', async id => {
  const h = await closeHandle(id);
  if (h) await fs.promises.rm(h.file, { force: true });
});
handle('still:save', async (token, png, suggested) => {
  projectOf(token);
  if (!isPng(png) || png.length > 64 << 20) throw new Error('Bad image');
  const r = await dialog.showSaveDialog(win, {
    title: 'Save frame', defaultPath: path.join(app.getPath('pictures'), `${validate.fileStem(suggested) || 'Frame'}.png`),
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (r.canceled || !r.filePath) return false;
  await writeAtomic(r.filePath, Buffer.from(png));
  return true;
});

// Background removal: a person mask video rendered by the native helper (Apple Vision)
handle('matte:make', async (token, mediaFile, quality) => {
  const p = projectOf(token);
  if (!validate.mediaName(mediaFile)) throw new Error('Bad media');
  if (!audio.available()) throw new Error('Background removal needs Reel’s built-in helper, which didn’t build on this Mac.');
  ai.release(); // the segmentation model and video coders need the memory on 8 GB Macs
  const src = path.join(mediaDir(p), path.basename(mediaFile));
  const name = await freeMediaName(p, `matte-${validate.fileStem(path.basename(mediaFile, path.extname(mediaFile))).replace(/\s+/g, '-')}.mp4`);
  const dst = path.join(mediaDir(p), name);
  const off = audio.onEvent(m => { if (m.type === 'matteProgress' && win && !win.isDestroyed()) win.webContents.send('matte-progress', m.value); });
  try {
    const r = await audio.matte(src, dst, ['fast', 'balanced', 'accurate'].includes(quality) ? quality : 'balanced');
    return { file: name, frames: r.frames };
  } finally { off(); }
});
// A clean preview copy (a proxy made by macOS): for a recording the preview shows black or can't read to make its own
// proxy. AVFoundation reads damaged or unusual files the preview can't. The original stays as it is; export uses it.
handle('media:cleanProxy', async (token, mediaFile) => {
  const p = projectOf(token);
  if (!validate.mediaName(mediaFile)) throw new Error('Bad media');
  if (!audio.available()) throw new Error('This needs Reel’s built-in helper, which didn’t build on this Mac.');
  const src = path.join(mediaDir(p), path.basename(mediaFile));
  const stem = path.basename(mediaFile, path.extname(mediaFile));
  const name = await freeMediaName(p, `${stem} proxy.mp4`);
  const dst = path.join(mediaDir(p), name);
  const send = v => { if (win && !win.isDestroyed()) win.webContents.send('clean-proxy-progress', mediaFile, v); };
  const r = await audio.conform(src, dst.replace(/\.mp4$/, ''), 'proxy', send);
  const info = await probeMedia(r.dst);
  if (!info || !info.width) { await fs.promises.rm(r.dst, { force: true }); throw new Error('the copy came out without a picture'); }
  return { file: path.basename(r.dst), width: info.width, height: info.height, duration: info.duration };
});
// LUTs: copy a .cube file into the project so it travels with it
handle('lut:import', async token => {
  const p = projectOf(token);
  const r = await dialog.showOpenDialog(win, { title: 'Choose a LUT', properties: ['openFile'], filters: [{ name: '3D LUT', extensions: ['cube'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const st = await fs.promises.stat(r.filePaths[0]);
  if (st.size > 32 << 20) throw new Error('That LUT file is too large');
  const name = await freeMediaName(p, `lut-${validate.fileStem(path.basename(r.filePaths[0], '.cube')).replace(/\s+/g, '-')}.cube`);
  await fs.promises.copyFile(r.filePaths[0], path.join(mediaDir(p), name), fs.constants.COPYFILE_EXCL);
  return { file: name, name: path.basename(r.filePaths[0], '.cube') };
});

// Captions: open / save SRT or VTT text files, and save an .srt beside an exported movie
handle('captions:open', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Import captions', properties: ['openFile'], filters: [{ name: 'Captions', extensions: ['srt', 'vtt'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const st = await fs.promises.stat(r.filePaths[0]);
  if (st.size > 8 << 20) throw new Error('That caption file is too large');
  return fs.promises.readFile(r.filePaths[0], 'utf8');
});
handle('captions:save', async (text, suggested, kind) => {
  if (typeof text !== 'string' || text.length > 16 << 20) throw new Error('Bad captions');
  const ext = kind === 'vtt' ? 'vtt' : 'srt';
  const r = await dialog.showSaveDialog(win, { title: 'Export captions', defaultPath: path.join(app.getPath('videos'), `${validate.fileStem(suggested) || 'Captions'}.${ext}`), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (r.canceled || !r.filePath) return false;
  await writeAtomic(r.filePath, Buffer.from(text, 'utf8'));
  return true;
});
handle('captions:beside', async (name, text) => {
  if (typeof text !== 'string' || text.length > 16 << 20 || typeof name !== 'string') throw new Error('Bad captions');
  // only next to a movie exported this session
  const dst = [...exportedFiles].find(f => path.basename(f) === name);
  if (!dst) throw new Error('Unknown export');
  const out = dst.replace(/\.[^.]+$/, '') + '.srt';
  await writeAtomic(out, Buffer.from(text, 'utf8'));
  return path.basename(out);
});

// Speech from text with macOS's own voices (the built-in `say` command; offline, nothing installed)
const { execFile, spawn } = require('child_process');
const runSay = args => new Promise((res, rej) => execFile('/usr/bin/say', args, { timeout: 120000, maxBuffer: 4 << 20 }, (e, out) => (e ? rej(e) : res(out))));
let voiceCache = null;
async function sayVoices() {
  if (voiceCache) return voiceCache;
  const out = await runSay(['-v', '?']);
  voiceCache = out.split('\n').map(l => /^(.+?)\s{2,}([a-z]{2}[_-][A-Z]{2})\s+#\s*(.*)$/.exec(l)).filter(Boolean)
    .map(m => ({ name: m[1].trim(), lang: m[2].replace('_', '-'), sample: m[3].trim().slice(0, 120) }));
  return voiceCache;
}
handle('tts:voices', async () => sayVoices().catch(() => []));
handle('tts:make', async (token, text, voice, rate) => {
  const p = projectOf(token);
  if (typeof text !== 'string' || !text.trim() || text.length > 20000) throw new Error('Write some text first (up to 20,000 characters).');
  const voices = await sayVoices();
  const v = voices.find(x => x.name === voice);
  const r = Math.round(Math.max(90, Math.min(400, Number(rate) || 180)));
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'protoart-reel-tts-'));
  try {
    const txt = path.join(tmp, 'text.txt');
    await fs.promises.writeFile(txt, text, 'utf8');
    const name = await freeMediaName(p, `speech-${validate.fileStem(text.slice(0, 30)).replace(/\s+/g, '-') || 'clip'}.wav`);
    const out = path.join(mediaDir(p), name);
    const args = ['-r', String(r), '-f', txt, '-o', out, '--file-format=WAVE', '--data-format=LEI16@48000'];
    if (v) args.unshift('-v', v.name);
    await runSay(args);
    return { file: name, name: `Speech: ${text.trim().slice(0, 40)}`, role: 'speech', ...(await probeMedia(out)) };
  } finally { await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
});

// Sound separation (SAM-Audio on this Mac, like AudioGhost AI): pull a described sound out of a clip, or take it out
handle('ghost:status', async () => ghost.status());
handle('ghost:setup', async key => ghost.setup(String(key || 'small'), kittenEvent));
handle('ghost:setupCancel', async () => ghost.cancelSetup());
handle('ghost:cancel', async () => ghost.cancel());
handle('ghost:separate', async (token, req) => {
  const p = projectOf(token);
  const r = req && typeof req === 'object' ? req : {};
  if (!validate.mediaName(r.source)) throw new Error('Bad source');
  const prompt = typeof r.prompt === 'string' ? r.prompt.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  if (!prompt) throw new Error('Describe the sound first (like “dog barking”).');
  const from = Math.max(0, Number(r.from) || 0), to = Number(r.to) || 0;
  if (!(to > from + 0.2)) throw new Error('That clip is too short.');
  const stem = validate.fileStem(prompt.slice(0, 30)).replace(/\s+/g, '-') || 'sound';
  const tName = await freeMediaName(p, `${stem}-only.wav`), rName = await freeMediaName(p, `without-${stem}.wav`);
  const target = path.join(mediaDir(p), tName), residual = path.join(mediaDir(p), rName);
  try {
    const out = await ghost.separate({ src: path.join(mediaDir(p), r.source), from, to, prompt, size: r.size, quality: r.quality === 'best' ? 'best' : 'fast', target, residual },
      ev => kittenEvent({ type: 'ghostRun', f: Number(ev.f) || 0, msg: typeof ev.msg === 'string' ? ev.msg.slice(0, 120) : '' }));
    return { model: out.model,
      target: { file: tName, name: `${prompt.slice(0, 40)} (only)`, role: 'separated', ...(await probeMedia(target)) },
      residual: { file: rName, name: `Without ${prompt.slice(0, 40)}`, role: 'separated', ...(await probeMedia(residual)) } };
  } catch (e) {
    for (const f of [target, residual]) await fs.promises.rm(f, { force: true }).catch(() => {});
    throw e;
  }
});

// Word-for-word speech (CrisperWhisper on this Mac): every word said, ums and uhs included, timed to the word. A
// sound file's words are worked out once and kept beside it (<file>-verbatim-<model>.json), as the transcripts are.
handle('verbatim:status', async () => verbatim.status());
handle('verbatim:setup', async key => verbatim.setup(key ? String(key) : null, kittenEvent));
handle('verbatim:setupCancel', async () => verbatim.cancelSetup());
handle('verbatim:cancel', async () => verbatim.cancel());
handle('verbatim:words', async (token, source, language, from, to) => {
  const p = projectOf(token);
  if (!validate.mediaName(source)) throw new Error('Bad source');
  const st = verbatim.status();
  if (!st.use) return null;
  const stem = path.basename(source, path.extname(source));
  const cache = path.join(mediaDir(p), `${stem}-verbatim-${st.use}.json`);
  // only the part asked for (the clip's stretch of the recording) is written down; what's done is kept for next time
  const a = Number.isFinite(from) ? Math.max(0, from) : 0, b = Number.isFinite(to) && to > a ? to : 1e9;
  let c = { model: st.use, words: [], have: [] };
  try { const x = JSON.parse(await fs.promises.readFile(cache, 'utf8')); if (Array.isArray(x.words)) c = { ...x, have: Array.isArray(x.have) ? x.have : [[0, 1e9]] }; } catch { /* not yet */ }
  const gaps = verbatim.missing(c.have, a, b);
  if (!gaps.length) return { words: c.words, model: st.use, cached: true };
  const lang = typeof language === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(language) ? language.slice(0, 2) : 'en';
  const total = gaps.reduce((n, [g, h]) => n + (h - g), 0) || 1;
  let done = 0, device = '';
  for (const [g, h] of gaps) {
    // a second either side so a word at the edge isn't cut in half; only the words starting inside are kept
    const r = await verbatim.transcribe({ src: path.join(mediaDir(p), path.basename(source)), from: Math.max(0, g - 1), to: h + 1, language: lang },
      ev => kittenEvent({ type: 'verbatimRun', f: (done + (h - g) * Math.min(1, Number(ev.f) || 0)) / total, loading: !!ev.loading, msg: typeof ev.msg === 'string' ? ev.msg.slice(0, 120) : '', source }));
    if (r.device) device = r.device;
    console.log(`verbatim: ${(h - g).toFixed(0)} s of talk in ${r.seconds} s on ${r.device}`);
    const fresh = (r.words || []).filter(w => w[0] >= g - 0.01 && w[0] < h);
    c.words = [...c.words.filter(w => w[0] < g - 0.01 || w[0] >= h), ...fresh].sort((x, y) => x[0] - y[0]);
    c.have = verbatim.addRange(c.have, g, h);
    done += h - g;
    await writeAtomic(cache, JSON.stringify({ model: st.use, words: c.words, have: c.have, at: new Date().toISOString() })); // kept even if stopped later
  }
  return { words: c.words, model: st.use, cached: false, device };
});

// Kitten voices (KittenTTS 2 on this Mac): natural speech, emotion, and voices cloned from the person's recordings
const kittenEvent = ev => { if (win && !win.isDestroyed()) win.webContents.send('ai-event', ev); };
handle('kitten:status', async () => ({ ...kitten.status(), mine: await kitten.myVoices() }));
handle('kitten:setup', async () => kitten.setup(kittenEvent));
handle('kitten:setupCancel', async () => kitten.cancelSetup());
handle('kitten:cancel', async () => kitten.cancel());
handle('kitten:remove', async () => kitten.remove());
handle('kitten:saveVoice', async (name, samples, rate, text) => kitten.saveVoice(name, samples, rate, text));
handle('kitten:deleteVoice', async id => kitten.deleteVoice(id, f => shell.trashItem(f).catch(() => fs.promises.rm(f, { force: true }))));
handle('kitten:say', async (token, req) => {
  const p = projectOf(token);
  const r = req && typeof req === 'object' ? req : {};
  const text = typeof r.text === 'string' ? r.text.trim() : '';
  if (!text || text.length > 20000) throw new Error('Write some text first (up to 20,000 characters).');
  let mine = null;
  if (typeof r.mine === 'string' && r.mine) { mine = await kitten.myVoice(r.mine); if (!mine) throw new Error('That saved voice is gone.'); }
  const voice = typeof r.voice === 'string' ? r.voice.slice(0, 60) : '';
  const name = await freeMediaName(p, `speech-${validate.fileStem(text.replace(/^\s*\[[a-z]+\]\s*/i, '').slice(0, 30)).replace(/\s+/g, '-') || 'clip'}.wav`);
  const out = path.join(mediaDir(p), name);
  try {
    await kitten.speak({ text, voice, mine, preset: r.preset === 'expressive' ? 'expressive' : 'stable', normalize: r.normalize !== false, out }, ev => kittenEvent({ type: 'kittenSay', msg: typeof ev.msg === 'string' ? ev.msg.slice(0, 200) : '', loading: !!ev.loading }));
  } catch (e) { await fs.promises.rm(out, { force: true }).catch(() => {}); throw e; }
  const who = mine ? mine.name : voice || 'Kitten';
  return { file: name, name: `Speech (${who}): ${text.replace(/^\s*\[[a-z]+\]\s*/i, '').slice(0, 40)}`, role: 'speech', ...(await probeMedia(out)) };
});

// AI helpers (ERNIE thumbnails, prompt suggestions)
handle('ai:status', async () => ai.status());
handle('ai:generate', async (token, job) => {
  const p = projectOf(token);
  const clean = validate.aiJob(job);
  const out = await ai.generate(clean, ev => {
    // a live preview is a small PNG as base64; anything else is dropped
    if (ev && ev.type === 'preview' && !(typeof ev.png === 'string' && ev.png.length < 300000 && /^[A-Za-z0-9+/]+=*$/.test(ev.png))) return;
    if (win && !win.isDestroyed()) win.webContents.send('ai-event', ev);
  });
  const png = await fs.promises.readFile(out);
  await fs.promises.rm(out, { force: true });
  void p;
  return new Uint8Array(png.buffer, png.byteOffset, png.length);
});
handle('ai:cancel', async () => ai.cancel());
handle('ai:loras', async engine => ai.listLoras(engine === 'flux' ? 'flux' : 'ernie'));
handle('ai:fluxSetup', async opts => ai.setupFlux({ keepDownload: !!(opts && opts.keepDownload) }, ev => { if (win && !win.isDestroyed()) win.webContents.send('ai-event', ev); }));
handle('ai:fluxSetupCancel', async () => ai.cancelSetup());
/** Saves a generated picture into the project's media (to use on the timeline). */
handle('ai:saveImage', async (token, png, label) => {
  const p = projectOf(token);
  if (!(png instanceof Uint8Array) || png.length > 40 << 20 || png[0] !== 0x89 || png[1] !== 0x50) throw new Error('Bad image');
  const name = await freeMediaName(p, `ai-${validate.fileStem(String(label || 'image')).replace(/\s+/g, '-').slice(0, 40) || 'image'}.png`);
  const file = path.join(mediaDir(p), name);
  await fs.promises.writeFile(file, Buffer.from(png), { flag: 'wx' });
  return { file: name, name: name.replace(/\.png$/, ''), role: 'ai', ...(await probeMedia(file)) };
});
handle('ai:suggest', async req => ai.suggest(validate.suggestRequest(req), ev => { if (win && !win.isDestroyed()) win.webContents.send('ai-event', ev); }));
// the writer (Qwen): titles, descriptions and chapter names from the transcript
handle('ai:writerStatus', async () => ai.writerStatus());
handle('ai:writerSetup', async key => ai.setupWriter(typeof key === 'string' ? key : '', ev => { if (win && !win.isDestroyed()) win.webContents.send('ai-event', ev); }));
handle('ai:writerSetupCancel', async () => ai.cancelWriterSetup());
handle('ai:write', async req => {
  const r = req && typeof req === 'object' ? req : {};
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  return ai.write({ system: str(r.system, 4000), prompt: str(r.prompt, 24000), maxTokens: Math.max(16, Math.min(1200, Number(r.maxTokens) || 400)), temperature: Math.max(0, Math.min(1.2, Number(r.temperature) || 0.6)), size: str(r.size, 10) },
    ev => { if (win && !win.isDestroyed()) win.webContents.send('ai-event', ev); });
});

// Per-app audio: mixer (SoundSource-style) and app list for recording (Loopback-style)
handle('audio:available', async () => audio.available());
handle('audio:list', async () => audio.list());
handle('audio:set', async (key, rule) => { if (!validate.appKey(key)) throw new Error('Bad app'); await audio.set(key, validate.audioRule(rule)); return true; });
handle('audio:reset', async () => audio.resetAll());
handle('audio:meter', async on => audio.meter(on === true));
audio.onEvent(m => { if (m.type === 'levels' && win && !win.isDestroyed()) win.webContents.send('audio-levels', m.levels); });

// ------------------------------------------------------------------ audio effects (voice tools + plug-ins)
const fxJobs = new Map(); // handle id -> { file, project, channels }
handle('fx:available', async () => fx.available());
handle('fx:plugins', async () => fx.listPlugins());
/** Names of the VST3 plug-ins installed on this Mac (only the bundle names: to show which have no Audio Unit). */
handle('fx:vst3', async () => {
  const out = new Set();
  for (const dir of ['/Library/Audio/Plug-Ins/VST3', path.join(app.getPath('home'), 'Library/Audio/Plug-Ins/VST3')]) {
    try { for (const n of await fs.promises.readdir(dir)) if (/\.vst3$/i.test(n)) out.add(n.replace(/\.vst3$/i, '')); } catch { /* not there */ }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
});
handle('fx:edit', async (slot, plugin, state, title) => {
  if (typeof slot !== 'string' || !/^[\w-]{1,64}$/.test(slot) || !validate.pluginKey(plugin)) throw new Error('Bad plug-in');
  const [it] = validate.fxChain([{ kind: 'au', plugin, state }]);
  await fx.openEditor(slot, plugin, it.state, typeof title === 'string' ? title.slice(0, 80) : undefined);
});
handle('fx:editClose', async slot => (typeof slot === 'string' ? fx.closeEditor(slot) : ''));
handle('fx:state', async slot => (typeof slot === 'string' ? fx.getState(slot) : ''));
fx.onEvent(m => { if (m.type === 'auEdited' && win && !win.isDestroyed()) win.webContents.send('fx-edited', { slot: m.slot, state: m.state }); });

/** The 48 kHz float WAV a clip's effects start from: the media itself when it already is one. */
async function fxSourceFor(p, mediaFile) {
  const full = path.join(mediaDir(p), mediaFile);
  if (/\.wav$/i.test(mediaFile)) {
    try { const i = fx.wavInfo(full); if (i.format === 3 && i.bits === 32 && i.rate === 48000 && i.channels <= 2) return mediaFile; } catch { /* convert */ }
  }
  const cached = `fxsrc-${validate.fileStem(path.basename(mediaFile, path.extname(mediaFile))).replace(/\s+/g, '-')}.wav`;
  try { await fs.promises.access(path.join(mediaDir(p), cached)); return cached; } catch { return null; }
}
handle('fx:source', async (token, mediaFile) => {
  const p = projectOf(token);
  if (!validate.mediaName(mediaFile)) throw new Error('Bad name');
  return fxSourceFor(p, mediaFile);
});
/** The editor decodes media to 48 kHz float and streams it here (begin / chunks / end). */
handle('fx:upBegin', async (token, purpose, mediaFile, channels) => {
  const p = projectOf(token);
  const ch = channels === 2 ? 2 : 1;
  let name;
  if (purpose === 'source' && validate.mediaName(mediaFile)) name = `fxsrc-${validate.fileStem(path.basename(mediaFile, path.extname(mediaFile))).replace(/\s+/g, '-')}.wav`;
  else if (purpose === 'master') name = await freeMediaName(p, 'master-mix.wav');
  // bounce in place: a track's clips rendered through their effects, kept in the project as new media
  else if (purpose === 'bounce') name = await freeMediaName(p, `${(validate.fileStem(String(mediaFile || '')) || 'Rendered').slice(0, 60)}.wav`);
  else throw new Error('Bad upload');
  const file = path.join(mediaDir(p), name);
  await fs.promises.rm(file, { force: true });
  const id = await openHandle(file, 'fxup', { project: p, name, channels: ch });
  await appendTo(handles.get(id), wavHeader(48000, ch, 0));
  return id;
});
on('fx:chunk', (id, data) => {
  try { const h = handleOf(id, 'fxup'); if (data instanceof Uint8Array && data.length <= 64 << 20) appendTo(h, data).catch(() => {}); } catch { /* ignore */ }
});
handle('fx:upEnd', async id => {
  const h = await closeHandle(id);
  if (!h || h.kind !== 'fxup') throw new Error('Unknown upload');
  const fh = await fs.promises.open(h.file, 'r+');
  try { await fh.write(wavHeader(48000, h.channels, h.bytes - 58), 0, 58, 0); } finally { await fh.close(); }
  return h.name;
});
handle('fx:render', async (token, job) => {
  const p = projectOf(token);
  if (!job || !validate.mediaName(job.source) || typeof job.tag !== 'string' || !/^[\w-]{1,40}$/.test(job.tag)) throw new Error('Bad render');
  const chain = validate.fxChain(job.chain);
  const outName = await freeMediaName(p, `fx-${job.tag}.wav`);
  const tmp = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'protoart-reel-fx-'));
  try {
    await fx.renderChain(path.join(mediaDir(p), job.source), path.join(mediaDir(p), outName), chain,
      f => { if (win && !win.isDestroyed()) win.webContents.send('fx-progress', { tag: job.tag, f }); }, tmp);
  } catch (e) {
    await fs.promises.rm(path.join(mediaDir(p), outName), { force: true });
    throw e;
  } finally { await fs.promises.rm(tmp, { recursive: true, force: true }); }
  const info = fx.wavInfo(path.join(mediaDir(p), outName));
  return { file: outName, duration: info.dataLength / (4 * info.channels * info.rate) };
});
/** A short before/after preview of the built-in voice tools, as a temporary file. */
handle('fx:previewVoice', async (token, source, params, start, seconds) => {
  const p = projectOf(token);
  if (!validate.mediaName(source)) throw new Error('Bad source');
  const prm = validate.voiceParams(params);
  const src = path.join(mediaDir(p), source), info = fx.wavInfo(src);
  const frame = 4 * info.channels;
  const from = Math.max(0, Math.floor((Number(start) || 0) * 48000)), n = Math.floor(Math.min(30, Math.max(2, Number(seconds) || 12)) * 48000);
  const tmpIn = path.join(app.getPath('temp'), `protoart-reel-prev-${process.pid}-${Date.now()}.wav`);
  const fdIn = await fs.promises.open(src, 'r');
  const len = Math.max(0, Math.min(n * frame, info.dataLength - from * frame));
  const buf = Buffer.alloc(len);
  await fdIn.read(buf, 0, len, info.dataOffset + from * frame); await fdIn.close();
  await fs.promises.writeFile(tmpIn, Buffer.concat([wavHeader(48000, info.channels, len), buf]));
  for (const f of await fs.promises.readdir(mediaDir(p))) if (/^fxprev-/.test(f)) await fs.promises.rm(path.join(mediaDir(p), f), { force: true });
  const outName = `fxprev-${Date.now()}.wav`;
  try { await fx.runVoice(tmpIn, path.join(mediaDir(p), outName), prm); } finally { await fs.promises.rm(tmpIn, { force: true }); }
  return outName;
});
handle('fx:previewPlugins', async (token, source, slots, start, seconds, device, gain) => {
  const p = projectOf(token);
  if (!validate.mediaName(source) || !Array.isArray(slots) || slots.some(s2 => typeof s2 !== 'string')) throw new Error('Bad preview');
  await fx.previewThrough(slots.slice(0, 16), path.join(mediaDir(p), source), Number(start) || 0, Math.max(0.1, Math.min(600, Number(seconds) || 30)), typeof device === 'string' ? device.slice(0, 200) : '', Number.isFinite(gain) ? gain : 1);
});
handle('fx:previewStop', async () => fx.stopPreview());
/** Master-bus plug-ins at export: render the mixed audio through the chain. */
handle('fx:renderFile', async (token, source, chain) => {
  const p = projectOf(token);
  if (!validate.mediaName(source)) throw new Error('Bad source');
  const ch = validate.fxChain(chain);
  const outName = await freeMediaName(p, 'master-mastered.wav');
  const tmp = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'protoart-reel-fx-'));
  try { await fx.renderChain(path.join(mediaDir(p), source), path.join(mediaDir(p), outName), ch, f => { if (win && !win.isDestroyed()) win.webContents.send('fx-progress', { tag: 'master', f }); }, tmp); }
  finally { await fs.promises.rm(tmp, { recursive: true, force: true }); }
  return outName;
});
handle('fx:removeTemp', async (token, name) => {
  const p = projectOf(token);
  if (validate.mediaName(name) && /^(master-mix|master-mastered|fxprev-)/.test(name)) await fs.promises.rm(path.join(mediaDir(p), name), { force: true });
});

on('dirty', d => { if (win) win.setDocumentEdited(!!d); });

// ------------------------------------------------------------------ menu

function sendMenu(cmd) { if (win && !win.isDestroyed()) win.webContents.send('menu', cmd); }

// ------------------------------------------------------------------ keyboard shortcuts you choose
// Every menu command can get your own shortcut (Settings › Keyboard Shortcuts). Your choices are kept in
// shortcuts.json and laid over the menus' own shortcuts each time the menus are built.
const ACCEL = /^((Command|Control|Alt|Shift)\+){0,4}([A-Z0-9]|F([1-9]|1[0-9]|20)|[\[\];',./`=\\-]|Space|Tab|Backspace|Delete|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Return)$/;
let menuCatalog = [];
function applyShortcuts(tpl) {
  const own = store.shortcuts();
  const catalog = [];
  const walk = (items, where) => {
    for (const it of items) {
      if (!it || it.type === 'separator') continue;
      if (Array.isArray(it.submenu)) walk(it.submenu, it.label || (it.role === 'appMenu' ? 'ProtoArt Reel' : where));
      if (typeof it.click === 'function' && it.click.cmd) {
        const cmd = it.click.cmd;
        if (!catalog.some(c => c.cmd === cmd)) catalog.push({ cmd, label: (it.label || cmd).replace(/\s+\(.*\)$/, '').replace(/\s{2,}.*/, ''), menu: where, def: it.accelerator || '' });
        // a plain key (no ⌘ ⌃ ⌥) isn't put on the menu, or typing that letter anywhere would set it off: the editor runs it
        if (Object.prototype.hasOwnProperty.call(own, cmd)) { if (own[cmd] && /(^|\+)(Command|Control|Alt)\+/.test(own[cmd])) it.accelerator = own[cmd]; else delete it.accelerator; }
      }
    }
  };
  walk(tpl, '');
  // a key you gave to one command is taken off any other menu item that had it by default
  const mine = new Set(Object.values(own).filter(Boolean));
  const strip = items => { for (const it of items) { if (!it) continue; if (Array.isArray(it.submenu)) strip(it.submenu); if (it.click?.cmd && it.accelerator && mine.has(it.accelerator) && own[it.click.cmd] !== it.accelerator) delete it.accelerator; } };
  strip(tpl);
  menuCatalog = catalog;
}
handle('shortcuts:get', async () => ({ menu: menuCatalog, own: store.shortcuts() }));
// while you press a new shortcut in Settings, the menus' own shortcuts don't fire (⌘N mustn't open a project)
handle('shortcuts:capture', async on => { if (win && !win.isDestroyed()) win.webContents.setIgnoreMenuShortcuts(!!on); return true; });
handle('shortcuts:set', async own => {
  const clean = {};
  if (own && typeof own === 'object') for (const [k, v] of Object.entries(own).slice(0, 400)) {
    if (typeof k !== 'string' || !/^[\w-]{1,40}$/.test(k) || typeof v !== 'string') continue;
    if (v === '' || ACCEL.test(v)) clean[k] = v;
  }
  store.setShortcuts(clean);
  buildMenu();
  return clean;
});

// what Undo and Redo will do, sent by the editor after each edit ("Undo Move 2 Clips")
const undoLabels = { undo: 'Undo', redo: 'Redo' };
const cleanLabel = (v, base) => (typeof v === 'string' && v.startsWith(base) ? v.replace(/[\u0000-\u001f]/g, '').slice(0, 80) : base);
handle('menu:undoLabels', async (u, r) => {
  const undo = cleanLabel(u, 'Undo'), redo = cleanLabel(r, 'Redo');
  if (undo === undoLabels.undo && redo === undoLabels.redo) return true;
  undoLabels.undo = undo; undoLabels.redo = redo;
  // The menu bar is NOT rebuilt for this any more: a rebuild that landed just as a menu was clicked made the click
  // do nothing ("sometimes the menu is unresponsive"). Electron can't change a label in place, so the Edit menu
  // keeps plain Undo / Redo and the editor shows what they'll do (toast and tooltips).
  return true;
});
// Rebuilding the menu bar while one of its menus is open closes that menu and swallows the click (Settings… looked
// dead). So the new Undo / Redo wording waits until no menu is open, and is applied a moment after.
let menusOpen = 0, relabelPending = false, relabelTimer = null;
function relabelSoon() {
  relabelPending = true;
  clearTimeout(relabelTimer);
  relabelTimer = setTimeout(() => { if (menusOpen > 0) return; relabelPending = false; buildMenu(); }, 600);
}
function watchMenus(menu) {
  for (const it of menu.items) if (it.submenu) {
    it.submenu.on('menu-will-show', () => { menusOpen++; clearTimeout(relabelTimer); });
    it.submenu.on('menu-will-close', () => { menusOpen = Math.max(0, menusOpen - 1); if (!menusOpen && relabelPending) relabelSoon(); });
    watchMenus(it.submenu);
  }
}

function buildMenu() {
  const m = cmd => { const f = () => sendMenu(cmd); f.cmd = cmd; return f; };
  const tpl = ([
    { role: 'appMenu', submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Settings…', accelerator: 'Command+,', click: m('settings') }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [
      { label: 'New Project', accelerator: 'Command+N', click: m('new') },
      { label: 'Open Project…', accelerator: 'Command+O', click: m('open') },
      { label: 'New from Template…', accelerator: 'Command+Shift+N', click: m('templates') },
      { label: 'Close Project', accelerator: 'Command+W', click: m('home') },
      { label: 'Home', accelerator: 'Command+Shift+H', click: m('home') },
      { type: 'separator' },
      { label: 'Save', accelerator: 'Command+S', click: m('save') },
      { label: 'Show Project in Finder', click: m('reveal') },
      { label: 'Save as Template…', click: m('save-template') },
      { label: 'Check & Repair Project…', click: m('repair') },
      { label: 'Check Spelling…', click: m('spelling') },
      { label: 'Archive Project…', click: m('archive') },
      { label: 'Save Frame…', accelerator: 'Command+Alt+F', click: m('save-frame') },
      { label: 'Delete Unused Media…', click: m('delete-unused') },
      { type: 'separator' },
      { label: 'Import Captions (SRT / VTT)…', click: m('captions-import') },
      { label: 'Delete All Captions…', click: m('captions-clear') },
      { label: 'Export Captions as SRT…', click: m('captions-export') },
      { label: 'Export Captions as WebVTT…', click: m('captions-export-vtt') },
      { type: 'separator' },
      { label: 'Add Media…', accelerator: 'Command+Shift+I', click: m('import') },
      { label: 'Global Library…', accelerator: 'Command+Alt+L', click: m('global-library') },
      { label: 'New Recording…', accelerator: 'Command+R', click: m('record') },
      { label: 'Pause / Resume Recording', click: m('pause-recording') },
      { label: 'Record Voice-Over…', accelerator: 'Shift+Command+R', click: m('voice-over') },
      { label: 'Punch In Voice-Over (between In and Out)…', accelerator: 'Shift+Command+P', click: m('punch-in') },
      { label: 'Spectral Editor…', accelerator: 'Command+Alt+S', click: m('spectral') },
      { label: 'Master Bus & Plug-ins…', click: m('master') },
      { type: 'separator' },
      { label: 'Speed Up', accelerator: 'Command+Alt+.', click: m('speed-up') },
      { label: 'Slow Down', accelerator: 'Command+Alt+,', click: m('speed-down') },
      { label: 'Speed…', click: m('speed-custom') },
      { label: 'Normal Speed', click: m('speed-normal') },
      { label: 'Time-lapse…', click: m('timelapse') },
      { label: 'Auto Edit…', accelerator: 'Alt+CmdOrCtrl+E', click: m('auto-edit') },
      { label: 'Auto Mix (dialogue, music, sound FX)…', accelerator: 'Alt+CmdOrCtrl+M', click: m('auto-mix') },
      { label: 'Remove Auto Mix', click: m('auto-mix-remove') },
      { label: 'Make Vertical…', click: m('make-vertical') },
      { label: 'Presets (transitions, titles, elements, sounds)…', accelerator: 'Command+Alt+P', click: m('presets') },
      { label: 'Style Packs (documentary, trailer, VHS…)…', click: m('styles') },
      { type: 'separator' },
      { label: 'Thumbnail Studio…', accelerator: 'Command+T', click: m('thumbnail') },
      { label: 'AI Image…', accelerator: 'Command+Alt+I', click: m('aiimage') },
      { label: 'Mixer…', accelerator: 'Command+Shift+M', click: m('sound') },
      { label: 'Export…', accelerator: 'Command+E', click: m('export') },
    ] },
    { label: 'Edit', submenu: [
      { label: 'Undo', accelerator: 'Command+Z', click: m('undo') },
      { label: 'Redo', accelerator: 'Command+Shift+Z', click: m('redo') },
      { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
      { label: 'Copy Style', accelerator: 'Command+Alt+C', click: m('copy-style') },
      { label: 'Paste Style', accelerator: 'Command+Alt+V', click: m('paste-style') },
      { label: 'Paste Properties', accelerator: 'Command+Shift+V', click: m('paste-properties') },
      { label: 'Delete  (⌫)', click: m('delete') },
      { label: 'Ripple Delete  (⇧⌫)', click: m('ripple-delete') },
      { label: 'Select All', accelerator: 'Command+A', click: m('select-all') },
      { label: 'Select Everything After Playhead', accelerator: 'Command+Shift+A', click: m('select-after') },
      { label: 'Nudge Selection Left  (⌥←)', click: m('nudge-left') },
      { label: 'Nudge Selection Right  (⌥→)', click: m('nudge-right') },
      { type: 'separator' },
      { label: 'Splice at Playhead  (S)', click: m('split') },
      { label: 'Add Marker  (M)', click: m('marker') },
      { label: 'Takes…', accelerator: 'Command+Alt+T', click: m('takes') },
      { label: 'Filler Words…', accelerator: 'Command+Alt+U', click: m('ums') },
      { label: 'Put Sound Back in Sync', click: m('resync') },
      { label: 'Check & Repair Project…', click: m('repair') },
      { label: 'Check Spelling…', click: m('spelling') },
      { label: 'Teach Reel Your Ums…', click: m('teach-ums') },
      { label: 'Find Clap Markers…', click: m('find-claps') },
      { type: 'separator' },
      { label: 'Mark In  (I)', click: m('mark-in') },
      { label: 'Mark Out  (O)', click: m('mark-out') },
      { label: 'Clear In & Out  (⌥X)', click: m('clear-inout') },
      { label: 'Add In–Out as an Auto Edit Section  (X)', click: m('add-section') },
      { label: 'Clear Auto Edit Sections', click: m('clear-sections') },
      { type: 'separator' },
      { label: 'Delete Between In & Out (ripple)', accelerator: 'Command+Shift+Backspace', click: m('delete-inout') },
      { label: 'Delete Between Markers (ripple)', click: m('delete-markers') },
      { label: 'Delete All Markers…', click: m('delete-all-markers') },
      { label: 'Close Gap on This Track', accelerator: 'Control+Alt+G', click: m('close-gap') },
      { label: 'Close Gap on All Tracks', accelerator: 'Control+Alt+Shift+G', click: m('close-gap-all') },
      { label: 'Close Every Gap on This Track', click: m('close-all-gaps') },
      { label: 'Insert 1 s Gap on All Tracks', click: m('insert-gap') },
    ] },
    { label: 'Clip', submenu: [
      { label: 'Trim Front to Playhead  ([)', click: m('trim-front') },
      { label: 'Trim End to Playhead  (])', click: m('trim-end') },
      { label: 'Add Freeze Frame  (⌥F)', click: m('freeze') },
      { label: 'Play in Reverse', accelerator: 'Command+Alt+R', click: m('reverse') },
      { label: 'Detach Audio', accelerator: 'Control+Shift+S', click: m('detach-audio') },
      { label: 'Align to Guide (ADR)…', accelerator: 'Command+Alt+A', click: m('adr-align') },
      { label: 'Dynamic Zoom…', accelerator: 'Command+Alt+Z', click: m('dynamic-zoom') },
      { label: 'Film Cuts', submenu: [
        { label: 'L-cut at the Playhead', click: m('l-cut') },
        { label: 'J-cut at the Playhead', click: m('j-cut') },
        { label: 'Smash Cut at the Playhead', click: m('smash-cut') },
        { label: 'Jump Cut at the Playhead', click: m('jump-cut') },
        { label: 'Cut on Action at the Playhead', click: m('cut-on-action') },
        { label: 'Cutaway (selected shot) at the Playhead', click: m('cutaway') },
        { label: 'Cross-cut the Two Selected Clips', click: m('cross-cut') },
        { type: 'separator' },
        { label: 'All Film Cuts…', click: m('film-cuts') },
      ] },
      { type: 'separator' },
      { label: 'Auto Captions…', click: m('auto-captions') },
      { label: 'Talking Text…', click: m('talking-text') },
      { label: 'Bleep Swearing…', click: m('bleep') },
      { label: 'Edit by Text…', accelerator: 'Control+Command+T', click: m('text-edit') },
      { type: 'separator' },
      { label: 'Auto Edit This Clip…', click: m('autoedit-clip') },
      { label: 'Rename Clip…', click: m('rename-clip') },
      { label: 'Add Clip Marker  (⇧M)', click: m('clip-marker') },
      { label: 'Label', submenu: ['none', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'].map(c => ({ label: c[0].toUpperCase() + c.slice(1), click: m('label-' + c) })) },
      { type: 'separator' },
      { label: 'Disable / Enable Clip  (V)', click: m('disable') },
      { label: 'Lock / Unlock', accelerator: 'Command+L', click: m('lock') },
      { label: 'Group', accelerator: 'Command+Alt+G', click: m('group') },
      { label: 'Ungroup', accelerator: 'Command+Alt+Shift+G', click: m('ungroup') },
    ] },
    { label: 'Insert', submenu: [
      { label: 'Call-out at the Playhead (Like, Subscribe, Follow…)…', click: m('callouts-browser') },
      { label: 'Call-outs Through the Whole Video…', click: m('callouts-plan') },
      { type: 'separator' },
      { label: 'Text', accelerator: 'Command+Shift+T', click: m('insert-text') },
      { label: 'Zoom & Pan Action', accelerator: 'Command+K', click: m('insert-action') },
      { label: 'Snapback Action', accelerator: 'Command+Shift+K', click: m('snapback') },
      { label: 'Caption at Playhead', accelerator: 'Control+Command+C', click: m('add-caption') },
      { label: 'Title…', accelerator: 'Command+Alt+T', click: m('titles') },
      { label: 'Annotation (draw)', accelerator: 'Command+Alt+D', click: m('annotate') },
      { label: 'Speech from Text…', click: m('tts') },
      { label: 'Kitten Voices (natural speech)…', click: m('voices') },
      { label: 'Clone My Voice from the Selected Clip…', click: m('clone-voice') },
      { label: 'Callout', accelerator: 'Command+Shift+C', click: m('insert-callout') },
      { label: 'Arrow / Shape', click: m('insert-shape') },
    ] },
    { label: 'View', submenu: [
      { label: 'Light / Dark', accelerator: 'Command+Shift+L', click: m('toggle-theme') },
      { type: 'separator' },
      { label: 'Explain Mode (hover to learn)', accelerator: 'Command+/', click: m('explain') },
      { type: 'separator' },
      { label: 'Play / Pause  (Space)', click: m('play') },
      { label: 'Zoom Timeline In', accelerator: 'Command+=', click: m('zoom-in') },
      { label: 'Zoom Timeline Out', accelerator: 'Command+-', click: m('zoom-out') },
      { label: 'Zoom Timeline All the Way Out', accelerator: 'Command+0', click: m('zoom-fit') },
      { label: 'Zoom Timeline All the Way In (frames)', accelerator: 'Shift+Command+=', click: m('zoom-max') },
      { label: 'Taller Tracks', accelerator: 'Alt+Command+=', click: m('tracks-taller') },
      { label: 'Shorter Tracks', accelerator: 'Alt+Command+-', click: m('tracks-shorter') },
      { label: 'Fit All Tracks in View', accelerator: 'Alt+Command+0', click: m('tracks-fit') },
      { label: 'Scrub Audio While Dragging', click: m('toggle-scrub') },
      { label: 'SMPTE Timecode (HH:MM:SS:FF)', click: m('toggle-smpte') },
      { label: 'Show Caption Track', click: m('toggle-caption-lane') },
      { label: 'Track Height', submenu: [
        { label: 'Small', click: m('track-small') }, { label: 'Regular', click: m('track-regular') }, { label: 'Large', click: m('track-large') },
      ] },
      { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [{ label: 'Search Help…', click: m('help-search') }, { label: 'How ProtoArt Reel Works', click: m('about') }, { label: 'Troubleshooting…', click: m('troubleshoot') }] },
  ]);
  applyShortcuts(tpl);
  const menu = Menu.buildFromTemplate(tpl);
  menusOpen = 0;
  watchMenus(menu);
  Menu.setApplicationMenu(menu);
}

// ------------------------------------------------------------------ session & window

function lockDownSession() {
  const ses = session.defaultSession;
  const ours = wc => !!wc && !!win && wc === win.webContents;
  // Camera, microphone and screen capture only for the editor page; nothing else.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const okOrigin = (details.requestingUrl || '').startsWith(`${APP_ORIGIN}/`);
    callback(ours(wc) && okOrigin && (permission === 'media' || permission === 'display-capture' || permission === 'speaker-selection'));
  });
  // Chromium hands the origin over as 'app://reel/' (with a slash) and sometimes no webContents (device
  // listing); a strict match here hid every device name, so only "Mac's input / output" showed.
  const fromUs = (wc, origin) => String(origin || '').replace(/\/+$/, '') === APP_ORIGIN && (!wc || ours(wc));
  ses.setPermissionCheckHandler((wc, permission, origin) => fromUs(wc, origin) && (permission === 'media' || permission === 'display-capture' || permission === 'speaker-selection'));
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const frameUrl = request.frame ? request.frame.url : '';
      if (frameUrl !== EDITOR_URL || !recording.sourceId) return callback({});
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const src = sources.find(s => s.id === recording.sourceId);
      if (!src) return callback({});
      callback({ video: src, audio: recording.systemAudio && request.audioRequested ? 'loopback' : undefined });
    } catch {
      callback({});
    }
  }, { useSystemPicker: false });
  ses.webRequest.onBeforeRequest((details, callback) => {
    const u = details.url;
    callback({ cancel: !(u.startsWith(`${APP_ORIGIN}/`) || u.startsWith('blob:') || u.startsWith('data:')) });
  });
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  // where you left it, if that spot is still on a connected screen
  const last = store.windowBounds();
  const onScreen = last && screen.getAllDisplays().some(d => { const a = d.workArea; return last.x < a.x + a.width - 80 && last.x + last.width > a.x + 80 && last.y >= a.y - 10 && last.y < a.y + a.height - 80; });
  const place = onScreen ? { x: last.x, y: last.y, width: Math.max(1100, last.width), height: Math.max(700, last.height) } : { width: Math.min(1560, width), height: Math.min(960, height) };
  win = new BrowserWindow({
    ...place, minWidth: 1100, minHeight: 700,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 }, backgroundColor: '#141416', show: false,
    title: 'ProtoArt Reel',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false,
      webSecurity: true, allowRunningInsecureContent: false, spellcheck: true, devTools: !app.isPackaged || !!process.env.REEL_DEVTOOLS,
      backgroundThrottling: false,
    },
  });
  if (onScreen && last.maximized) win.maximize();
  let boundsTimer = null;
  const keepBounds = () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(() => { if (win && !win.isDestroyed() && !win.isMinimized() && !win.isFullScreen()) store.setWindowBounds({ ...(win.isMaximized() ? win.getNormalBounds() : win.getBounds()), maximized: win.isMaximized() }); }, 400); };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, keepBounds);
  // right-click in a box you type in: the right spellings for a red-underlined word, then Cut / Copy / Paste
  win.webContents.on('context-menu', (e, p) => {
    if (!p.isEditable) return;
    const items = [];
    if (p.misspelledWord) {
      for (const s of (p.dictionarySuggestions || []).slice(0, 6)) items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) });
      if (!items.length) items.push({ label: 'No spelling suggestions', enabled: false });
      items.push({ label: `It’s spelt right: add “${p.misspelledWord}” to the dictionary`, click: () => session.defaultSession.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: 'separator' });
    }
    items.push({ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy }, { role: 'paste', enabled: p.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll' });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('will-redirect', e => e.preventDefault());
  win.webContents.on('will-attach-webview', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('close', e => {
    if (recording.active) { e.preventDefault(); sendMenu('stop-recording'); return; }
    if (!win.isDocumentEdited()) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Save', 'Cancel', "Don't Save"], defaultId: 0, cancelId: 1,
      message: 'Save changes to this project?', detail: 'Your recordings are already saved; this is about the edits.',
    });
    if (choice === 1) { e.preventDefault(); return; }
    if (choice === 0) { e.preventDefault(); sendMenu('save-and-close'); }
  });
  ipcMain.removeHandler('window:closeNow');
  handle('window:closeNow', async () => { win.setDocumentEdited(false); win.close(); });
  win.loadURL(EDITOR_URL);
  win.once('ready-to-show', () => { win.show(); for (const p of pendingOpen.splice(0)) openFromFinder(p); });
  win.on('closed', () => { win = null; ai.stopAll(); });
}

// A .reel project opened from Finder (double-click or dropped on the Dock icon)
const pendingOpen = [];
app.on('open-file', (e, p) => {
  e.preventDefault();
  if (!p.endsWith(PROJECT_EXT)) return;
  if (win && !win.webContents.isLoading()) openFromFinder(p); else pendingOpen.push(p);
});
async function openFromFinder(dir) {
  try {
    const r = await openProject(dir);
    win.webContents.send('open-project', r);
  } catch (err) { dialog.showErrorBox('Couldn’t open project', err.message); }
}

app.whenReady().then(() => {
  protocol.handle('app', serve);
  audio.loadRules(path.join(app.getPath('userData'), 'audio-rules.json'));
  ai.setUserData(app.getPath('userData'));
  kitten.setUserData(app.getPath('userData'));
  ghost.setUserData(app.getPath('userData'));
  verbatim.setUserData(app.getPath('userData'));
  lockDownSession();
  buildMenu();
  createWindow();
});
app.on('activate', () => { if (!win) createWindow(); });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { for (const p of projects.values()) syncFolderName(p.dir); globalShortcut.unregisterAll(); ai.stopAll(); audio.stop(); fx.stop(); });
