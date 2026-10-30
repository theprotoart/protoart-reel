// Clap markers in the editor: listens to a clip's sound for "clap, clap, clap" (see lib/claps.js) and
// turns each one into a marker, or cuts it out and leaves a cut there. Recordings are WAV files and are
// read as a stream, so even an hour of sound uses almost no memory on an 8 GB Mac; other files are decoded
// at a low sample rate (enough to hear a clap).
import { el, toast, modal } from './ui.js';
import { ClapDetector } from './lib/claps.js';
import { mediaById, removeRange, uid } from './model.js';

const urlOf = (app, m) => `app://reel/m/${app.token}/${encodeURIComponent(m.file)}`;

/** Streams a WAV file (PCM 16/24/32 or float 32) into the detector as mono. Returns false if it isn't one. */
async function scanWav(url, det, onProgress) {
  const res = await fetch(url);
  if (!res.ok || !res.body) return false;
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  let head = new Uint8Array(0), fmt = null, dataLeft = 0, carry = new Uint8Array(0), seen = 0;
  const cat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += value.length;
    if (total && onProgress) onProgress(Math.min(1, seen / total));
    let chunk = value;
    if (!fmt) {
      head = cat(head, chunk);
      if (head.length < 12) continue;
      const dv = new DataView(head.buffer);
      const tag = o => String.fromCharCode(head[o], head[o + 1], head[o + 2], head[o + 3]);
      if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') { reader.cancel(); return false; }
      let o = 12, f = null, start = -1;
      while (o + 8 <= head.length) {
        const id = tag(o), size = dv.getUint32(o + 4, true);
        if (id === 'fmt ' && o + 8 + 16 <= head.length) f = { code: dv.getUint16(o + 8, true), ch: dv.getUint16(o + 10, true), rate: dv.getUint32(o + 12, true), bits: dv.getUint16(o + 22, true) };
        if (id === 'data') { start = o + 8; dataLeft = size || Infinity; break; }
        o += 8 + size + (size & 1);
      }
      if (start < 0) { if (head.length > 1 << 20) { reader.cancel(); return false; } continue; }
      if (!f) { reader.cancel(); return false; }
      if (f.code === 0xfffe) f.code = f.bits === 32 ? 3 : 1; // extensible: assume the usual float / int
      if (!((f.code === 3 && f.bits === 32) || (f.code === 1 && [16, 24, 32].includes(f.bits)))) { reader.cancel(); return false; }
      fmt = f;
      if (det.rate !== f.rate) Object.assign(det, new ClapDetector(f.rate, det.o));
      chunk = head.subarray(start);
      // a header written before its sizes were patched says 0: read to the end
      if (dataLeft === 0 || dataLeft > 0xfffffff0) dataLeft = Infinity;
    }
    if (dataLeft !== Infinity) { chunk = chunk.subarray(0, Math.min(chunk.length, dataLeft)); dataLeft -= chunk.length; }
    const bytes = fmt.bits / 8, frame = bytes * fmt.ch;
    const buf = carry.length ? cat(carry, chunk) : chunk;
    const frames = Math.floor(buf.length / frame);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const mono = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (let c = 0; c < fmt.ch; c++) {
        const o = i * frame + c * bytes;
        s += fmt.code === 3 ? dv.getFloat32(o, true)
          : fmt.bits === 16 ? dv.getInt16(o, true) / 32768
          : fmt.bits === 24 ? (((buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16)) << 8) >> 8) / 8388608
          : dv.getInt32(o, true) / 2147483648;
      }
      mono[i] = s / fmt.ch;
    }
    det.push(mono);
    carry = buf.slice(frames * frame);
    if (dataLeft <= 0) { reader.cancel(); break; }
  }
  return !!fmt;
}

/** Any other file: decode at 16 kHz mono-ish (claps survive that easily). */
async function scanDecoded(url, det) {
  const data = await (await fetch(url)).arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, 16000);
  const ab = await ctx.decodeAudioData(data);
  Object.assign(det, new ClapDetector(ab.sampleRate, det.o));
  const n = ab.length, ch = ab.numberOfChannels, step = 16000 * 10;
  for (let i = 0; i < n; i += step) {
    const len = Math.min(step, n - i), mono = new Float32Array(len);
    for (let c = 0; c < ch; c++) { const d = ab.getChannelData(c).subarray(i, i + len); for (let k = 0; k < len; k++) mono[k] += d[k] / ch; }
    det.push(mono);
  }
}

/** Clap signals in a media file, in seconds of that file (cached per file). */
const cache = new Map();
export async function clapsInMedia(app, m, onProgress) {
  const key = app.token + '/' + m.file;
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      const det = new ClapDetector(48000);
      const ok = /\.wav$/i.test(m.file) && await scanWav(urlOf(app, m), det, onProgress);
      if (!ok) await scanDecoded(urlOf(app, m), det);
      return det.finish();
    })().catch(e => { cache.delete(key); throw e; }));
  }
  return cache.get(key);
}

/** Clap signals on the timeline, from the given clips' sound (each found once even if two clips share it). */
export async function clapsOnTimeline(app, clips, onProgress) {
  const doc = app.doc, out = [];
  let done = 0;
  for (const c of clips) {
    const m = mediaById(doc, c.media);
    if (!m || !m.file) { done++; continue; }
    const sigs = await clapsInMedia(app, m, v => onProgress?.((done + v) / clips.length));
    done++;
    const sp = c.speed || 1, a = c.in || 0, b = a + c.duration * sp;
    for (const s of sigs) {
      if (s.t0 < a - 0.05 || s.t1 > b + 0.05) continue; // trimmed away
      const t0 = c.start + (s.t0 - a) / sp, t1 = c.start + (s.t1 - a) / sp;
      if (!out.some(x => Math.abs(x.t0 - t0) < 0.3)) out.push({ t0: Math.max(0, t0 - 0.03), t1 });
    }
  }
  return out.sort((x, y) => x.t0 - y.t0);
}

/** The sound to listen to: the selected clips', else every microphone (or other sound) clip. */
function clipsToScan(app) {
  const doc = app.doc;
  const hasSound = c => { const m = c.type === 'media' && mediaById(doc, c.media); return m && (m.kind === 'audio' || m.hasAudio); };
  const sel = doc.clips.filter(c => app.selection.clips.includes(c.id) && hasSound(c));
  if (sel.length) return sel;
  const mics = doc.clips.filter(c => hasSound(c) && mediaById(doc, c.media).role === 'mic');
  return mics.length ? mics : doc.clips.filter(hasSound);
}

const LABEL = '✂ Clap';
export function addClapMarkers(doc, sigs) {
  let n = 0;
  for (const s of sigs) {
    if ((doc.markers || []).some(k => Math.abs(k.t - s.t0) < 0.3)) continue;
    doc.markers.push({ id: uid('k'), t: s.t0, label: LABEL, claps: true }); n++;
  }
  doc.markers.sort((a, b) => a.t - b.t);
  return n;
}

/** Edit › Find Clap Markers…: listen, then add markers, or cut the claps out and leave a cut there. */
export async function openClapFinder(app) {
  const clips = clipsToScan(app);
  if (!clips.length) { toast('There’s no sound on the timeline to listen to.'); return; }
  const bar = el('div', { class: 'progress' }, el('i')), what = el('p', { class: 'note', text: `Listening for three claps in a row in ${clips.length === 1 ? 'one clip' : clips.length + ' clips'}…` });
  const box = el('div', {}, what, bar);
  let cancelled = false, finished = false;
  const dlg = modal('Clap markers', box, [{ label: 'Cancel', onClick: c => c() }], { onClose: () => { if (!finished) cancelled = true; } });
  let sigs;
  try { sigs = await clapsOnTimeline(app, clips, v => { bar.firstChild.style.width = Math.round(v * 100) + '%'; }); }
  catch (e) { finished = true; dlg.close(); toast(`Couldn’t listen to the sound: ${e.message}`, 6000); return; }
  if (cancelled) return;
  finished = true; dlg.close();
  if (!sigs.length) {
    modal('Clap markers', el('p', { text: 'No clap signals found. Clap three times, evenly and about half a second apart, close enough to the microphone to be clearly louder than your voice.' }), [{ label: 'OK', cls: 'hw amber', onClick: c => c() }]);
    return;
  }
  const n = sigs.length, s = n === 1 ? '' : 's';
  modal('Clap markers', el('div', {},
    el('p', { text: `Found ${n} clap signal${s}, at ${sigs.map(x => fmt(x.t0)).join(', ')}.` }),
    el('p', { class: 'note', text: 'Markers show where they are; jump between them with the timeline’s marker keys. Cutting removes about a second of claps from every track and leaves a cut there, so you can trim back to the take you want. ⌘Z undoes either.' })), [
    { label: 'Cancel', onClick: c => c() },
    { label: `Add ${n} marker${s}`, onClick: c => { c(); app.commit(d => { addClapMarkers(d, sigs); }); toast(`${n} clap marker${s} added.`); } },
    { label: `Cut out the claps${n > 1 ? ` (${n})` : ''}`, cls: 'hw amber', onClick: c => {
      c();
      app.commit(d => {
        for (const x of [...sigs].reverse()) removeRange(d, x.t0, x.t1);
        let shift = 0;
        for (const x of sigs) { d.markers.push({ id: uid('k'), t: x.t0 - shift, label: LABEL, claps: true }); shift += x.t1 - x.t0; }
        d.markers.sort((a, b) => a.t - b.t);
      });
      toast(`Cut out ${n} clap signal${s}; a marker shows each cut.`);
    } },
  ]);
}

const fmt = t => { const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`; };
