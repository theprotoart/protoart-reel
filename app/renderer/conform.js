// Finishing imports the editor converts itself (macOS can't read them): WebM / Matroska through the
// conform worker, Ogg / Opus sound through the browser's own audio decoder. Both become normal media
// (MP4 or WAV) in the project; the copied original is removed afterwards.
import { el, modal } from './ui.js';

/** entry: { file, kind, name } from main's import. Returns an import result ({ file, name, …info }) or { error }. */
export async function convertInEditor(app, entry, onProgress) {
  const api = app.api, token = app.token, url = `app://reel/m/${token}/${encodeURIComponent(entry.file)}`;
  const stem = entry.name.replace(/\.[^.]+$/, '');
  let rid = null;
  try {
    let res;
    if (entry.kind === 'audio' && !/\.(mka|weba)$/i.test(entry.file)) res = await viaWebAudio(api, token, url, stem, onProgress, id => { rid = id; });
    else res = await viaWorker(api, token, url, stem, onProgress, id => { rid = id; });
    rid = null;
    api.deleteMedia(token, entry.file).catch(() => {});
    return { ...res, name: entry.name, role: 'import', convertedFrom: entry.file.split('.').pop().toLowerCase() };
  } catch (e) {
    if (rid) api.renderCancel(rid);
    api.deleteMedia(token, entry.file).catch(() => {});
    return { error: `${entry.name}: ${e.message}` };
  }
}

async function viaWorker(api, token, url, stem, onProgress, setRid) {
  const worker = new Worker(new URL('./conform-worker.js', import.meta.url), { type: 'module' });
  try {
    let rid = null, queue = [];
    return await new Promise((resolve, reject) => {
      worker.onmessage = async e => {
        const m = e.data;
        if (m.type === 'format') { rid = (await api.renderBegin(token, stem, m.ext)).id; setRid(rid); for (const d of queue) api.renderChunk(rid, d); queue = []; }
        else if (m.type === 'chunk') { if (rid) api.renderChunk(rid, m.data); else queue.push(m.data); }
        else if (m.type === 'progress') onProgress?.(m.value);
        else if (m.type === 'done') { try { while (!rid) await new Promise(r => setTimeout(r, 20)); resolve(await api.renderFinish(rid, m.head)); } catch (err) { reject(err); } }
        else if (m.type === 'error') reject(new Error(m.message));
      };
      worker.onerror = e => reject(new Error(e.message || 'Conversion failed'));
      worker.postMessage({ type: 'start', url });
    });
  } finally { worker.terminate(); }
}

async function viaWebAudio(api, token, url, stem, onProgress, setRid) {
  const buf = await (await fetch(url)).arrayBuffer();
  onProgress?.(0.3);
  const ctx = new AudioContext();
  let ab;
  try { ab = await ctx.decodeAudioData(buf); } catch { throw new Error('This sound file can’t be read.'); } finally { ctx.close(); }
  onProgress?.(0.6);
  const ch = Math.min(2, ab.numberOfChannels), n = ab.length, rate = ab.sampleRate;
  const rid = (await api.renderBegin(token, stem, 'wav')).id; setRid(rid);
  const planes = Array.from({ length: ch }, (_, c) => ab.getChannelData(c)), B = rate * 4;
  for (let p = 0; p < n; p += B) {
    const m = Math.min(B, n - p), out = new Float32Array(m * ch);
    for (let i = 0; i < m; i++) for (let c = 0; c < ch; c++) out[i * ch + c] = planes[c][p + i];
    api.renderChunk(rid, new Uint8Array(out.buffer));
    onProgress?.(0.6 + 0.4 * ((p + m) / n));
  }
  const dataBytes = n * ch * 4, h = new DataView(new ArrayBuffer(44));
  const s = (o, t) => { for (let i = 0; i < t.length; i++) h.setUint8(o + i, t.charCodeAt(i)); };
  s(0, 'RIFF'); h.setUint32(4, 36 + dataBytes, true); s(8, 'WAVE'); s(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 3, true); h.setUint16(22, ch, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * ch * 4, true); h.setUint16(32, ch * 4, true); h.setUint16(34, 32, true); s(36, 'data'); h.setUint32(40, dataBytes, true);
  return api.renderFinish(rid, new Uint8Array(h.buffer));
}

/** A small "Converting…" window for imports that take a moment. Returns { set(name, value), close() }. */
export function conversionDialog() {
  const what = el('p', { class: 'note', text: 'Converting…' }), bar = el('div', { class: 'progress' }, el('i'));
  let dlg = null;
  return {
    set(name, value, i, count) {
      if (!dlg) dlg = modal('Adding media', el('div', {}, what, bar), []);
      what.textContent = `Converting “${name}”${count > 1 ? ` (${i + 1} of ${count})` : ''} so Reel can edit it… ${Math.round(value * 100)}%`;
      bar.firstChild.style.width = Math.round(value * 100) + '%';
    },
    close() { dlg?.close(); dlg = null; },
  };
}
