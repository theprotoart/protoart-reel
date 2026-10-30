// ADR alignment worker: reads the guide (original production line) and the replacement take, works out how the
// take's timing differs, and writes the take re-timed onto the guide (pitch kept) as a 32-bit float WAV.
import { demux } from './lib/mp4.js';
import { HttpReader, WavAudio, Mp4Audio } from './lib/sources.js';
import { align } from './lib/align.js';
import { warp } from './lib/stretch.js';

const MAX_SECONDS = 300, MARGIN = 1.5;

self.onmessage = async e => {
  const m = e.data;
  if (m.type !== 'start') return;
  try { await run(m); } catch (err) { self.postMessage({ type: 'error', message: String((err && err.message) || err) }); }
};
const progress = (v, label) => self.postMessage({ type: 'progress', value: v, label });

async function openAudio({ url, file }) {
  const reader = await new HttpReader(url).open();
  if (/\.wav$/i.test(file)) return new WavAudio(reader).open();
  const d = await demux(reader), a = d.tracks.find(t => t.kind === 'audio' && t.codec);
  if (!a) throw new Error('One of the clips has no sound Reel can read');
  return new Mp4Audio(reader, a).open();
}

async function readRange(src, from, to, maxCh, p0, p1, label) {
  const rate = src.rate, start = Math.max(0, Math.round(from * rate)), len = Math.max(1, Math.round(to * rate) - start);
  const chs = Math.min(maxCh, src.channels || 1), out = Array.from({ length: chs }, () => new Float32Array(len)), B = rate * 4;
  for (let p = 0; p < len; p += B) {
    const n = Math.min(B, len - p), got = await src.read(start + p, n);
    for (let c = 0; c < chs; c++) out[c].set(got[Math.min(c, got.length - 1)].subarray(0, n), p);
    progress(p0 + ((p1 - p0) * (p + n)) / len, label);
  }
  return { chans: out, rate, start: start / rate };
}
const mono = ch => { if (ch.length === 1) return ch[0]; const m = new Float32Array(ch[0].length); for (const c of ch) for (let i = 0; i < m.length; i++) m[i] += c[i] / ch.length; return m; };

async function run({ guide, take, opts }) {
  const span = guide.to - guide.from;
  if (span > MAX_SECONDS) throw new Error('Align works on up to 5 minutes at a time. Split the guide into lines first.');
  progress(0, 'Reading the guide…');
  const g = await readRange(await openAudio(guide), guide.from, guide.to, 1, 0, 0.15, 'Reading the guide…');
  const tsrc = await openAudio(take);
  const t = await readRange(tsrc, take.from - MARGIN, take.to + MARGIN, 2, 0.15, 0.3, 'Reading the new take…');
  progress(0.32, 'Matching the two performances…');
  const r = align(mono(g.chans), g.rate, mono(t.chans), t.rate, opts);
  // the take's own offset inside its buffer: where the user placed it relative to the guide is the starting guess,
  // and alignment measures the rest
  progress(0.6, 'Re-timing the take…');
  const rate = t.rate, outLen = Math.max(1, Math.round(span * rate));
  const out = warp(t.chans, o => r.at(o / rate) * rate, outLen, rate);
  const fade = Math.round(0.005 * rate);
  for (const c of out) for (let i = 0; i < fade && i < c.length; i++) { const k = i / fade; c[i] *= k; c[c.length - 1 - i] *= k; }
  progress(0.9, 'Writing…');
  const ch = out.length, B = rate;
  for (let p = 0; p < outLen; p += B) {
    const n = Math.min(B, outLen - p), buf = new Float32Array(n * ch);
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) buf[i * ch + c] = out[c][p + i];
    const data = new Uint8Array(buf.buffer);
    self.postMessage({ type: 'chunk', data }, [data.buffer]);
  }
  const head = wavHeader(outLen, ch, rate);
  self.postMessage({ type: 'done', head, stats: { lag: r.lag - (take.from - t.start), meanShift: r.meanShift, maxShift: r.maxShift } }, [head.buffer]);
}

function wavHeader(frames, ch, rate) {
  const dataBytes = frames * ch * 4, h = new DataView(new ArrayBuffer(44));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) h.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); h.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 3, true); h.setUint16(22, ch, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * ch * 4, true); h.setUint16(32, ch * 4, true); h.setUint16(34, 32, true);
  str(36, 'data'); h.setUint32(40, dataBytes, true);
  return new Uint8Array(h.buffer);
}
