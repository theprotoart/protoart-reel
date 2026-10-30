// Proxy editing: big or hard-to-decode videos get a small H.264 copy that the preview plays, so
// scrubbing and playback stay smooth. Export (and full-size stills for thumbnails) always use the
// originals. Settings are per Mac: mode auto | always | off, size half | quarter.
import { toast } from './ui.js';

const KEY = 'reel.proxy';
export function proxyPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { /* defaults */ }
  return { mode: ['auto', 'always', 'off'].includes(p.mode) ? p.mode : 'auto', size: p.size === 'quarter' ? 'quarter' : 'half' };
}
export function setProxyPrefs(next) {
  const p = { ...proxyPrefs(), ...next };
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* fine */ }
  return p;
}

/** Does this video want a proxy under the current mode? */
export function wantsProxy(m, prefs = proxyPrefs()) {
  if (!m || m.kind !== 'video' || m.rotation || prefs.mode === 'off' || m.proxyFailed) return false;
  const px = (m.width || 0) * (m.height || 0);
  if (prefs.mode === 'always') return px > 640 * 360;
  // automatic: more than 1080p, or HEVC / ProRes, which are slow to seek
  return px > 1920 * 1088 || /^(hvc1|hev1|apc|ap4)/i.test(m.videoCodec || '');
}
/** The file the preview should play for this media. */
export function previewFile(m, fullRes = false) {
  const p = proxyPrefs();
  if (fullRes || p.mode === 'off' || !m.proxy || m.proxy.of !== m.file) return m.file;
  return m.proxy.file;
}

export class ProxyQueue {
  constructor(app) { this.app = app; this.busy = null; this.worker = null; this.listeners = new Set(); this.done = 0; this.total = 0; }
  onChange(fn) { this.listeners.add(fn); }
  _emit() { for (const f of this.listeners) f(this.status()); }
  status() { return { busy: !!this.busy, done: this.done, total: this.total, name: this.busy?.name || '', progress: this.progress || 0 }; }

  /** Media in this project still waiting for a proxy at the current size. */
  needed() {
    const doc = this.app.doc, prefs = proxyPrefs();
    if (!doc) return [];
    const div = prefs.size === 'quarter' ? 4 : 2;
    return doc.media.filter(m => wantsProxy(m, prefs) && !(m.proxy && m.proxy.of === m.file && m.proxy.div === div));
  }
  /** Starts (or continues) making proxies in the background, one file at a time. */
  kick() {
    if (this.busy) return;
    const list = this.needed();
    if (!list.length) { if (this.total) { this.total = 0; this.done = 0; this._emit(); } return; }
    if (!this.total) { this.total = list.length; this.done = 0; }
    this._make(list[0]);
  }
  cancel() {
    if (this.worker) { this.worker.postMessage({ type: 'cancel' }); this.worker.terminate(); this.worker = null; }
    if (this.rid) this.app.api.renderCancel(this.rid).catch?.(() => {});
    this.busy = null; this.rid = null; this.total = 0; this.done = 0; this._emit();
  }

  async _existing(m, div) {
    const stem = String(m.file).replace(/\.[^.]+$/, ''), want = Math.round((m.height || 0) / div);
    for (const name of [`${stem} proxy.mp4`, `${stem} proxy-2.mp4`, `${stem} proxy-3.mp4`]) {
      const url = `app://reel/m/${this.app.token}/${encodeURIComponent(name)}`;
      const dims = await new Promise(res => {
        const v = document.createElement('video'); v.preload = 'metadata'; v.muted = true;
        const done = r => { v.removeAttribute('src'); v.load(); res(r); };
        v.onloadedmetadata = () => done(v.videoWidth ? { width: v.videoWidth, height: v.videoHeight, duration: v.duration } : null);
        v.onerror = () => done(null); setTimeout(() => done(null), 4000);
        v.src = url;
      });
      if (dims && Math.abs(dims.height - want) <= 2 && Math.abs(dims.duration - (m.duration || dims.duration)) < 1) return { file: name, ...dims };
    }
    return null;
  }
  async _make(m) {
    const app = this.app, token = app.token, div = proxyPrefs().size === 'quarter' ? 4 : 2;
    this.busy = m; this.progress = 0; this._emit();
    // a proxy made in an earlier session whose project wasn't saved afterwards is still on disk: use it
    // instead of making another copy (that left "proxy-2" files of several hundred MB each)
    const found = await this._existing(m, div);
    if (found && app.token === token) {
      const live = app.doc.media.find(x => x.id === m.id);
      if (live) { live.proxy = { file: found.file, of: m.file, div, width: found.width, height: found.height }; app.setDirty(true); app.player.reloadMedia?.(m.id); }
      if (this.busy === m) { this.busy = null; this.done++; this._emit(); setTimeout(() => this.kick(), 50); }
      return;
    }
    const worker = this.worker = new Worker(new URL('./proxy-worker.js', import.meta.url), { type: 'module' });
    let rid = null;
    try {
      const begin = await app.api.renderBegin(token, `${m.name} proxy`, 'mp4');
      rid = this.rid = begin.id;
      const res = await new Promise((resolve, reject) => {
        worker.onmessage = e => {
          const msg = e.data;
          if (msg.type === 'chunk') app.api.renderChunk(rid, msg.data);
          else if (msg.type === 'progress') { this.progress = msg.value; this._emit(); }
          else if (msg.type === 'done') resolve(msg);
          else if (msg.type === 'error') reject(new Error(msg.message));
        };
        worker.onerror = e => reject(new Error(e.message || 'Proxy failed'));
        worker.postMessage({ type: 'start', url: app.player.urlFor(m), divisor: div });
      });
      const info = await app.api.renderFinish(rid, res.head);
      this.rid = null;
      if (app.token !== token) return; // the project was closed meanwhile
      // not an undo step: proxies are housekeeping, not an edit
      const live = app.doc.media.find(x => x.id === m.id);
      if (live) { live.proxy = { file: info.file, of: m.file, div, width: res.width, height: res.height }; app.setDirty(true); app.player.reloadMedia?.(m.id); }
    } catch (e) {
      if (/Cancelled/.test(e.message)) return;
      if (rid) app.api.renderCancel(rid);
      const live = app.doc?.media.find(x => x.id === m.id);
      if (live) live.proxyFailed = true; // plays from the original from now on
      toast(`${m.name}: no proxy (${e.message}). It plays from the original.`, 5000);
    } finally {
      worker.terminate();
      if (this.worker === worker) this.worker = null;
      if (this.busy === m) { this.busy = null; this.done++; this._emit(); setTimeout(() => this.kick(), 300); }
    }
  }
}
