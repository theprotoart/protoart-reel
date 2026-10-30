// Picking the best moments of a long video for a short (TikTok, Reels, Shorts, a podcast clip), and chapter
// points for a long one. Works from what's said (word timings from speech recognition) and, when there's no
// speech, from how much the picture moves. Highlights start and end on sentence boundaries, so nobody is cut off
// mid-word, and the opening sentence is weighted as the hook.

const HOOKS = /\b(how|why|what|secret|never|always|best|worst|mistake|stop|need|must|biggest|easiest|fastest|free|new|first|only|trick|hack|truth|wrong|actually|imagine|watch|look|here's|this is|you)\b/i;
const FILLER = /^(um+|uh+|erm|er|ah|hmm+|mm+|like)$/i;

/** Groups word timings into sentences: a break at . ? ! or a pause of `pause` seconds. */
export function sentences(words, { pause = 0.65, maxLen = 14 } = {}) {
  const out = [];
  let cur = null;
  for (const w of words) {
    if (cur && (w.t - cur.end > pause || w.t - cur.t > maxLen)) { out.push(cur); cur = null; }
    if (!cur) cur = { t: w.t, end: w.end, words: [] };
    cur.words.push(w); cur.end = Math.max(cur.end, w.end);
    if (/[.?!]["”’)]*$/.test(w.text)) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  for (const s of out) s.text = s.words.map(w => w.text).join(' ');
  return out;
}

const meanIn = (samples, t0, t1) => {
  let s = 0, n = 0;
  for (const x of samples || []) if (x.t >= t0 && x.t < t1) { s += x.motion || 0; n++; }
  return n ? s / n : 0;
};

/** How strong one sentence is on its own: lively delivery, hooks, questions, numbers, movement on screen. */
export function sentenceScore(s, motion) {
  const dur = Math.max(0.3, s.end - s.t), n = s.words.length;
  const fill = s.words.filter(w => FILLER.test(w.text.replace(/[^\p{L}]/gu, ''))).length;
  const rate = n / dur;                                      // words per second; ~2.5 is lively
  let v = Math.min(1.2, rate / 2.6);
  if (HOOKS.test(s.text)) v += 0.35;
  if (/\?/.test(s.text)) v += 0.25;
  if (/!/.test(s.text)) v += 0.2;
  if (/\d/.test(s.text)) v += 0.15;
  v -= (fill / Math.max(1, n)) * 1.5;
  if (n < 3) v -= 0.3;
  if (motion) v += Math.min(0.5, meanIn(motion, s.t, s.end) * 6);
  return v;
}

/**
 * The best stretches of `length` seconds ({ min, ideal, max }), as [{ t0, t1, score, text }], best first.
 * count > 1 returns several that don't overlap (several Shorts from one video).
 * words: [{ t, end, text }] in timeline seconds; motion: [{ t, motion }] (optional); duration: of the edit.
 */
export function pickHighlights({ words = [], motion = null, duration, length, count = 1, pad = 0.12 }) {
  const { min, ideal, max } = length;
  if (!(duration > 0)) return [];
  if (duration <= max) return [{ t0: 0, t1: duration, score: 1, text: '' }];
  const ss = sentences(words);
  const out = [];
  if (ss.length >= 3) {
    const sc = ss.map(s => sentenceScore(s, motion));
    const cands = [];
    for (let i = 0; i < ss.length; i++) {
      let sum = 0;
      for (let j = i; j < ss.length; j++) {
        sum += sc[j] * (ss[j].end - ss[j].t);
        const len = ss[j].end - ss[i].t;
        if (len > max) break;
        if (len < min) continue;
        const talk = ss.slice(i, j + 1).reduce((a, s) => a + s.end - s.t, 0);
        let v = sum / len;                                     // average strength per second
        v += sc[i] * 0.35;                                     // the hook: the opening line matters most
        v -= Math.abs(len - ideal) / ideal * 0.4;              // near the length asked for
        v -= (1 - talk / len) * 0.5;                           // not much dead air
        if (/[.?!]["”’)]*$/.test(ss[j].words.at(-1).text)) v += 0.1; // ends on a finished sentence
        cands.push({ t0: Math.max(0, ss[i].t - pad), t1: Math.min(duration, ss[j].end + pad), score: v, text: ss[i].text });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    for (const c of cands) {
      if (out.some(o => c.t0 < o.t1 && c.t1 > o.t0)) continue;
      out.push(c);
      if (out.length >= count) break;
    }
    if (out.length) return out;
  }
  // no speech to go on: the stretch where the picture moves most
  if (motion && motion.length) {
    const step = Math.max(0.5, ideal / 20), cands = [];
    for (let t = 0; t + ideal <= duration; t += step) cands.push({ t0: t, t1: t + ideal, score: meanIn(motion, t, t + ideal), text: '' });
    cands.sort((a, b) => b.score - a.score);
    for (const c of cands) { if (out.some(o => c.t0 < o.t1 && c.t1 > o.t0)) continue; out.push(c); if (out.length >= count) break; }
    return out;
  }
  // nothing at all to go on: the opening
  return [{ t0: 0, t1: Math.min(duration, ideal), score: 0, text: '' }];
}

/**
 * Chapter points for a long video (YouTube chapters): the first at 0:00, then at the longest pauses, at least
 * `gap` seconds apart, each named after the first words that follow.
 */
export function chapters(words, duration, { every = 150, gap = 45, most = 12 } = {}) {
  const ss = sentences(words, { pause: 0.8 });
  if (duration < 3 * gap || ss.length < 4) return [];
  const want = Math.max(3, Math.min(most, Math.round(duration / every)));
  const name = s => {
    const w = s.text.replace(/[^\p{L}\p{N}' -]/gu, '').split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
    return w ? w[0].toUpperCase() + w.slice(1) : 'Chapter';
  };
  const breaks = [];
  for (let i = 1; i < ss.length; i++) breaks.push({ t: ss[i].t, gap: ss[i].t - ss[i - 1].end, s: ss[i] });
  breaks.sort((a, b) => b.gap - a.gap);
  const picked = [{ t: 0, label: 'Intro' }];
  for (const b of breaks) {
    if (picked.length >= want) break;
    if (b.t > duration - gap || picked.some(p => Math.abs(p.t - b.t) < gap)) continue;
    picked.push({ t: Math.max(0, b.t - 0.2), label: name(b.s) });
  }
  return picked.sort((a, b) => a.t - b.t);
}
