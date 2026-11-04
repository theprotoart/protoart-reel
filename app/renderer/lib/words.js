// Timed words (from speech recognition) → captions, and edits made by text: cut the words you delete, cut
// filler words, tighten pauses. Pure functions, so they can be tested.

export const FILLERS = ['um', 'umm', 'uh', 'uhh', 'erm', 'er', 'ah', 'hmm', 'mm', 'you know', 'i mean', 'sort of', 'kind of', 'like', 'basically', 'actually', 'literally', 'so yeah'];
const norm = s => String(s).toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, '').trim();

/**
 * Words of a media file (source seconds) as words on the timeline for one clip: only those the clip shows,
 * moved and scaled by the clip's start, in-point and speed. Each: { t, end, text, conf, clip }.
 */
export function wordsOnTimeline(words, clip) {
  const sp = clip.speed || 1, a = clip.in || 0, b = a + clip.duration * sp, out = [];
  for (const [t, d, text, conf] of words) {
    const mid = t + d / 2;
    if (mid < a || mid > b) continue;
    const ts = clip.start + (t - a) / sp, te = clip.start + (t + Math.max(0.05, d) - a) / sp;
    out.push({ t: Math.max(clip.start, ts), end: Math.min(clip.start + clip.duration, te), text: String(text), conf: conf ?? 1, clip: clip.id });
  }
  return out;
}

/** Words from several clips, in time order; the same word heard on two clips at once is kept once. */
export function mergeWords(lists) {
  const all = lists.flat().sort((p, q) => p.t - q.t), out = [];
  for (const w of all) {
    const prev = out[out.length - 1];
    if (prev && norm(prev.text) === norm(w.text) && Math.abs(prev.t - w.t) < 0.25) { if (w.conf > prev.conf) out[out.length - 1] = w; continue; }
    out.push(w);
  }
  return out;
}

/**
 * Captions from timed words: a new caption at a sentence end, a long pause, or when the line would pass
 * maxChars (two lines of half that) or maxDur seconds. Returns [{ t, end, text }].
 */
export function buildCaptions(words, { maxChars = 64, maxDur = 4.5, pause = 0.7, lines = 2 } = {}) {
  const caps = [];
  let cur = null;
  const close = () => {
    if (!cur) return;
    let text = cur.words.join(' ').replace(/\s+([,.!?;:])/g, '$1');
    if (lines === 2 && text.length > maxChars / 2) { // break into two balanced lines at a space
      const mid = text.length / 2; let best = -1;
      for (let i = 0; i < text.length; i++) if (text[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
      if (best > 0) text = text.slice(0, best) + '\n' + text.slice(best + 1);
    }
    caps.push({ t: cur.t, end: Math.max(cur.end, cur.t + 0.6), text });
    cur = null;
  };
  for (const w of words) {
    const txt = String(w.text).trim();
    if (!txt) continue;
    if (cur) {
      const len = cur.words.join(' ').length + 1 + txt.length;
      const lastWord = cur.words[cur.words.length - 1];
      if (w.t - cur.end > pause || len > maxChars || w.end - cur.t > maxDur || /[.!?]$/.test(lastWord)) close();
    }
    if (!cur) cur = { t: w.t, end: w.end, words: [] };
    cur.words.push(txt); cur.end = w.end;
  }
  close();
  // never let one caption run into the next
  for (let i = 0; i + 1 < caps.length; i++) caps[i].end = Math.min(caps[i].end, caps[i + 1].t);
  return caps;
}

/** Sorts and joins time ranges that touch or overlap (within `join` seconds). */
export function mergeRanges(ranges, join = 0.02) {
  const r = ranges.filter(x => x.end > x.t + 1e-3).map(x => ({ t: x.t, end: x.end })).sort((p, q) => p.t - q.t), out = [];
  for (const x of r) { const last = out[out.length - 1]; if (last && x.t <= last.end + join) last.end = Math.max(last.end, x.end); else out.push(x); }
  return out;
}

/** Filler words ("um", "uh", "you know"…) as ranges to cut, each with a little of its pause. */
export function fillerRanges(words, fillers = FILLERS) {
  const set = fillers.map(norm), out = [];
  for (let i = 0; i < words.length; i++) {
    for (const f of set) {
      const n = f.split(' ').length;
      if (i + n > words.length) continue;
      if (words.slice(i, i + n).map(w => norm(w.text)).join(' ') !== f) continue;
      // "like" and "so" are fillers only when they stand alone between pauses
      if ((f === 'like' || f === 'actually' || f === 'basically' || f === 'literally') && !(i === 0 || words[i].t - words[i - 1].end > 0.25)) continue;
      const a = words[i], b = words[i + n - 1];
      const after = words[i + n] ? Math.min(0.15, (words[i + n].t - b.end) / 2) : 0.05;
      out.push({ t: a.t, end: b.end + Math.max(0, after) });
    }
  }
  return mergeRanges(out);
}

/** Pauses longer than `longer` seconds, shortened so `keep` seconds of quiet stay. */
export function pauseRanges(words, { longer = 0.8, keep = 0.3, from = null, to = null } = {}) {
  const out = [];
  const gaps = [];
  if (from != null && words.length) gaps.push([from, words[0].t]);
  for (let i = 0; i + 1 < words.length; i++) gaps.push([words[i].end, words[i + 1].t]);
  if (to != null && words.length) gaps.push([words[words.length - 1].end, to]);
  for (const [a, b] of gaps) if (b - a > longer) out.push({ t: a + keep / 2, end: b - keep / 2 });
  return mergeRanges(out);
}

/**
 * Ranges minus the timeline spans to protect (e.g. sped-up clips, which are silent on purpose): what's left of
 * each range outside every span. Pieces shorter than `min` seconds are dropped.
 */
export function withoutSpans(ranges, spans, min = 0.05) {
  let out = ranges.map(r => ({ ...r }));
  for (const [a, b] of spans) {
    const next = [];
    for (const r of out) {
      if (r.end <= a || r.t >= b) { next.push(r); continue; }
      if (r.t < a) next.push({ ...r, end: a });
      if (r.end > b) next.push({ ...r, t: b });
    }
    out = next;
  }
  return out.filter(r => r.end - r.t >= min);
}

/** Removes ranges from the edit, last first, with `remove(doc, t0, t1)` (ripple). Returns seconds removed. */
export function cutRanges(doc, ranges, remove) {
  let total = 0;
  for (const r of mergeRanges(ranges).reverse()) total += remove(doc, r.t, r.end) || 0;
  return total;
}
