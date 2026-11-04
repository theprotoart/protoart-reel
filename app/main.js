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
const audio = require('./engine/audio');
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
  active: false, sourceId: null, systemAudio: false, cursor: null, cursorTimer: null,
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
  recording.cursorTimer = null;
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
    skipTaskbar: true, hasShadow: true, alwaysOnTop: true, focusable: true, show: false, title: 'ProtoArt Reel recording',
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
    try {
      let batch = [], batchBytes = 0;
      for (const { t, s } of items) {
        const data = await r.read(s.offset, s.size);
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
/** The editor went back to the home screen: forget the token so the folder can be trashed. */
handle('project:close', async token => {
  const p = projects.get(token);
  if (p) { projects.delete(token); tokenFor.delete(p.dir); }
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
        out.push({ file: name, name: base, role: 'import', ...info });
        continue;
      }
      if (!audio.available()) throw new Error('Converting this format needs the media helper, which isn’t part of this build.');
      const stem = path.basename(await freeMediaName(p, path.basename(base, path.extname(base)) + (kind === 'image' ? '.jpg' : kind === 'audio' ? '.wav' : '.mp4')));
      const dstBase = path.join(mediaDir(p), stem.replace(/\.[^.]+$/, ''));
      progress(0);
      const r = await audio.conform(src, dstBase, kind, progress);
      const file = path.basename(r.dst);
      out.push({ file, name: base, role: 'import', convertedFrom: ext, ...(await probeMedia(r.dst)) });
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
handle('rec:pause', async paused => {
  if (!recording.active) return false;
  paused = !!paused;
  if (paused === recording.paused) return paused;
  if (paused) recording.pauseAt = Date.now();
  else recording.pausedMs += Date.now() - recording.pauseAt;
  recording.paused = paused;
  if (recording.apps && recording.apps.length) await audio.recPause(recording.stamp, paused).catch(() => {});
  if (hud && !hud.isDestroyed()) hud.webContents.send('hud:paused', paused, recordedMs(recording.started));
  recTrayMenu();
  return paused;
});

on('rec:chunk', (id, data) => {
  try {
    const h = handleOf(id, 'rec');
    if (!(data instanceof Uint8Array) || data.length > 64 << 20) return;
    appendTo(h, data).catch(() => {});
  } catch { /* ignore stray chunks */ }
});

handle('rec:end', async (ids, meta) => {
  setRecordingUi(false);
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
        results.push({ role: h.role, file: final, kind: 'video', ...info });
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
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
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
handle('export:cancel', async id => {
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
      { type: 'separator' },
      { label: 'Auto Captions…', click: m('auto-captions') },
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
  lockDownSession();
  buildMenu();
  createWindow();
});
app.on('activate', () => { if (!win) createWindow(); });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { globalShortcut.unregisterAll(); ai.stopAll(); audio.stop(); fx.stop(); });
