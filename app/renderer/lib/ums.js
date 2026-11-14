// UMS: find the "um"s, "uh"s and other fillers in the speech, as a list to listen to, keep or cut (like TAKES).
// Two sources: filler words the speech recogniser wrote down, and short sounds between words that it skipped
// (macOS speech recognition often leaves "um" out of the text). Pure functions, so they can be tested.

// fillers that are almost never meant: cut by default
export const UM_WORDS = ['um', 'umm', 'ummm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'err', 'ah', 'ahh', 'hmm', 'hm', 'mm', 'mmm', 'eh'];
// fillers that are sometimes meant ("I like it"): listed, kept unless you switch them to CUT
export const MAYBE_WORDS = ['you know', 'i mean', 'sort of', 'kind of', 'like', 'basically', 'actually', 'literally', 'so yeah'];
const ALONE = new Set(['like', 'actually', 'basically', 'literally']); // only when they stand alone between pauses
const norm = s => String(s).toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, '').trim();
const isUm = s => /^(u+h*m+|u+h+|e+r+m*|a+h+|h+m+|m{2,}|e+h)$/.test(s) || UM_WORDS.includes(s);

/**
 * Filler words in timed words ({ t, end, text }, timeline seconds). Each hit:
 * { t, end, text, kind: 'word', cut } where cut is true for um / uh / er… and false for "like", "you know"…
 * end reaches a little into the pause after it, so the cut doesn't leave a breath of the filler.
 */
export function fillerHits(words) {
  const out = [], maybe = MAYBE_WORDS.map(f => f.split(' ')).sort((a, b) => b.length - a.length);
  for (let i = 0; i < words.length; i++) {
    const w = norm(words[i].text);
    let n = 0, cut = false;
    if (isUm(w)) { n = 1; cut = true; } else {
      for (const f of maybe) {
        if (i + f.length > words.length) continue;
        if (f.every((x, k) => norm(words[i + k].text) === x)) {
          if (f.length === 1 && ALONE.has(f[0]) && !(i === 0 || words[i].t - words[i - 1].end > 0.25)) continue;
          n = f.length; break;
        }
      }
    }
    if (!n) continue;
    const a = words[i], b = words[i + n - 1], next = words[i + n];
    const after = next ? Math.max(0, Math.min(0.15, (next.t - b.end) / 2)) : 0.05;
    out.push({ t: a.t, end: b.end + after, text: words.slice(i, i + n).map(x => String(x.text).replace(/[.,!?;:]+$/, '')).join(' '), kind: 'word', cut });
    i += n - 1;
  }
  return out;
}

/**
 * Short sounds between words: likely "um"s the recogniser didn't write down. level(t) gives the sound's
 * level (0..1, as the waveform shows it) at timeline time t; from / to bound the search.
 * A sound counts when it is louder than a breath (half the usual level of speech), lasts 0.18–1.2 s and
 * sits in a gap between words with room either side. Each: { t, end, text, kind: 'sound', cut: false }.
 */
export function soundHits(words, level, { from = 0, to = null, step = 0.01, min = 0.18, max = 1.2 } = {}) {
  if (!words.length) return [];
  // how loud speech usually is here, and the quiet floor
  const speech = [];
  for (const w of words) for (let t = w.t; t < w.end; t += step * 3) speech.push(level(t));
  speech.sort((a, b) => a - b);
  const loud = speech[Math.floor(speech.length / 2)] || 0;
  if (loud <= 0.02) return [];
  const gaps = [];
  if (words[0].t - from > 0.3) gaps.push([from, words[0].t]);
  for (let i = 0; i + 1 < words.length; i++) gaps.push([words[i].end, words[i + 1].t]);
  if (to != null && to - words[words.length - 1].end > 0.3) gaps.push([words[words.length - 1].end, to]);
  const quiet = [];
  for (const [a, b] of gaps) for (let t = a; t < b; t += step) quiet.push(level(t));
  quiet.sort((p, q) => p - q);
  const floor = quiet[Math.floor(quiet.length * 0.2)] || 0;
  const on = Math.max(loud * 0.5, floor + (loud - floor) * 0.35);
  const out = [];
  for (const [a0, b0] of gaps) {
    const a = a0 + 0.06, b = b0 - 0.06; // keep clear of the words either side
    if (b - a < min) continue;
    let start = null, peak = 0;
    const close = t => {
      if (start != null && t - start >= min && t - start <= max && peak >= on) out.push({ t: Math.max(a0 + 0.02, start - 0.04), end: Math.min(b0 - 0.02, t + 0.06), text: 'sound between words', kind: 'sound', cut: false });
      start = null; peak = 0;
    };
    for (let t = a; t <= b; t += step) {
      const v = level(t);
      if (v >= on * 0.7) { if (start == null) start = t; peak = Math.max(peak, v); } else close(t);
    }
    close(b);
  }
  return out;
}

/** Fillers heard as words plus sounds between words, in time order, without overlaps (a word wins). */
export function findUms(words, level, opts = {}) {
  const hits = fillerHits(words);
  const sounds = level ? soundHits(words, level, opts).filter(s => !hits.some(h => h.t < s.end && h.end > s.t)) : [];
  return [...hits, ...sounds].sort((a, b) => a.t - b.t);
}

/**
 * The level of the sound on the timeline at time t, from the waveform peaks of each clip:
 * sources = [{ clip, peaks: { rate, data } }]. The loudest clip under t wins.
 */
export function levelOnTimeline(sources) {
  return t => {
    let v = 0;
    for (const { clip: c, peaks } of sources) {
      if (!peaks || t < c.start || t >= c.start + c.duration) continue;
      const src = (c.in || 0) + (t - c.start) * (c.speed || 1);
      const k = Math.floor(src * peaks.rate);
      if (k >= 0 && k < peaks.data.length) v = Math.max(v, peaks.data[k]);
    }
    return v;
  };
}
