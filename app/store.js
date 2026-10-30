// Small settings file in the app's user-data folder: the recent-projects list.
'use strict';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = () => path.join(app.getPath('userData'), 'recents.json');
let cache = null;

function load() {
  if (cache) return cache;
  try {
    const v = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    cache = Array.isArray(v.recents) ? v.recents.filter(x => typeof x === 'string' && path.isAbsolute(x)).slice(0, 20) : [];
  } catch { cache = []; }
  return cache;
}
function save() {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    const tmp = FILE() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ recents: cache }), { mode: 0o600 });
    fs.renameSync(tmp, FILE());
  } catch { /* best effort */ }
}
function recents() { return load().slice(); }
function addRecent(dir) {
  load();
  cache = [dir, ...cache.filter(d => d !== dir)].slice(0, 20);
  save();
}
function removeRecent(dir) {
  load();
  cache = cache.filter(d => d !== dir);
  save();
}

// Where new projects (and so their recordings and media) are saved; earlier folders stay listed.
const SFILE = () => path.join(app.getPath('userData'), 'storage.json');
let scache = null;
function storage() {
  if (scache) return scache;
  try { const v = JSON.parse(fs.readFileSync(SFILE(), 'utf8')); scache = { root: typeof v.root === 'string' && path.isAbsolute(v.root) ? v.root : '', roots: Array.isArray(v.roots) ? v.roots.filter(x => typeof x === 'string' && path.isAbsolute(x)).slice(0, 20) : [] }; }
  catch { scache = { root: '', roots: [] }; }
  return scache;
}
function setStorageRoot(dir) {
  const s = storage();
  s.root = dir || '';
  if (dir) s.roots = [dir, ...s.roots.filter(d => d !== dir)].slice(0, 20);
  try { fs.mkdirSync(path.dirname(SFILE()), { recursive: true }); fs.writeFileSync(SFILE(), JSON.stringify(s), { mode: 0o600 }); } catch { /* best effort */ }
}
// The editor window's last size and position (so Reel opens where you left it).
const WFILE = () => path.join(app.getPath('userData'), 'window.json');
function windowBounds() {
  try {
    const v = JSON.parse(fs.readFileSync(WFILE(), 'utf8'));
    const ok = n => Number.isFinite(n) && Math.abs(n) < 100000;
    if (![v.x, v.y, v.width, v.height].every(ok) || v.width < 400 || v.height < 300) return null;
    return { x: v.x, y: v.y, width: v.width, height: v.height, maximized: !!v.maximized };
  } catch { return null; }
}
function setWindowBounds(b) {
  try { fs.mkdirSync(path.dirname(WFILE()), { recursive: true }); fs.writeFileSync(WFILE(), JSON.stringify(b), { mode: 0o600 }); } catch { /* best effort */ }
}
// Keyboard shortcuts you chose: { command: 'Command+Shift+K' | '' (none) }.
const KFILE = () => path.join(app.getPath('userData'), 'shortcuts.json');
function shortcuts() {
  try { const v = JSON.parse(fs.readFileSync(KFILE(), 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
function setShortcuts(v) {
  try { fs.mkdirSync(path.dirname(KFILE()), { recursive: true }); fs.writeFileSync(KFILE(), JSON.stringify(v), { mode: 0o600 }); } catch { /* best effort */ }
}
module.exports = { recents, addRecent, removeRecent, storage, setStorageRoot, windowBounds, setWindowBounds, shortcuts, setShortcuts };
