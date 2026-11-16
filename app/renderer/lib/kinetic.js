// Kinetic titles for Auto Edit: finds the punchy things said (a question, a "never", a number, a big claim) and puts
// them on screen as bold animated words, the way short-form editors do, with a graphic to go with some of them (a
// starburst behind a question, a chart for a percentage, a light streak under a claim). Works from word timings; no
// DOM here, so it's tested in Node.

import { sentences } from './highlight.js';

/** How many: none, a few (one every ~25 s on a long video, ~8 s on a short) or lots. */
export const GFX_LEVELS = { off: ['Off'], few: ['A few'], lots: ['Lots'] };
/** The look: Bold (slam, smear, slice, starbursts), Clean (pill and serif accents) or Tech (neon, HUD, streaks). */
export const GFX_LOOKS = { bold: ['Bold'], clean: ['Clean'], tech: ['Tech'] };

const FILLER = /^(um+|uh+|erm|er|ah|hmm+|mm+|like|so|and|but|you know)$/i;
const PUNCH = /\b(never|always|no|not|nothing|every|everything|nobody|only|best|worst|biggest|fastest|easiest|free|secret|crazy|insane|huge|wrong|truth|stop|actually|literally|killed|perfect|instantly|zero|one)\b/i;
const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'or', 'in', 'on', 'at', 'for', 'is', 'it', 'that', 'this', 'with', 'i', 'you', 'we', 'so', 'just', 'be', 'was', 'are', 'my', 'your']);
const clean = w => w.replace(/^[^\p{L}\p{N}%$+-]+|[^\p{L}\p{N}%$!?.'’]+$/gu, '');

/** How punchy a short phrase is (higher is better), and what kind it is. */
export function phraseScore(text) {
  let v = 0, kind = 'claim';
  const n = text.split(/\s+/).length;
  if (/\?/.test(text)) { v += 1.2; kind = 'question'; }
  if (/\d+(\.\d+)?\s*(%|percent)/i.test(text)) { v += 1.4; kind = 'percent'; }
  else if (/[$€£]\s?\d|\d[\d,]*\s*(k|m|x|times|hours|minutes|seconds|dollars)\b/i.test(text)) { v += 1; kind = kind === 'question' ? kind : 'number'; }
  if (PUNCH.test(text)) v += 0.9;
  if (/!/.test(text)) v += 0.5;
  v -= Math.max(0, n - 6) * 0.25; // long ones don't read as a punch
  return { v, kind };
}

/** The word to accent: a number, else the last strong word (not a little word). */
function accentIndex(words) {
  const num = words.findIndex(w => /\d/.test(w));
  if (num >= 0) return num;
  const punch = words.findIndex(w => PUNCH.test(w));
  if (punch >= 0) return punch;
  for (let i = words.length - 1; i >= 0; i--) if (!STOP.has(words[i].toLowerCase().replace(/[^a-z']/g, ''))) return i;
  return words.length - 1;
}

/**
 * The plan: [{ t, dur, text, anim, accent, kind, element?, elementText? }] on the timeline, never overlapping,
 * at least `gap` seconds apart. words: [{ text, t, end }].
 */
export function planGraphics(words, total, { amount = 'few', look = 'bold', tall = false } = {}) {
  if (amount === 'off' || !words?.length || !(total > 4)) return [];
  const short = total < 120;
  const gap = amount === 'lots' ? (short ? 4 : 10) : (short ? 8 : 25);
  // candidate phrases: whole short sentences, or the punchy end of a longer one (2–5 words)
  const cands = [];
  for (const s of sentences(words)) {
    const ws = s.words.filter(w => !FILLER.test(clean(w.text)));
    if (!ws.length) continue;
    const pick = ws.length <= 5 ? ws : (() => {
      // the 3–5 word window with the best score
      let best = null;
      for (let len = 3; len <= 5; len++) for (let i = 0; i + len <= ws.length; i++) {
        const win = ws.slice(i, i + len), sc = phraseScore(win.map(w => w.text).join(' ')).v;
        if (!best || sc > best.sc) best = { win, sc };
      }
      return best.win;
    })();
    const text = pick.map(w => clean(w.text)).filter(Boolean).join(' ');
    if (text.length < 3) continue;
    const { v, kind } = phraseScore(text);
    if (v < 0.5) continue;
    cands.push({ t: pick[0].t, end: pick[pick.length - 1].end, text, v, kind });
  }
  cands.sort((a, b) => b.v - a.v || a.t - b.t);
  const out = [];
  for (const c of cands) {
    if (c.t < 1 || c.end > total - 0.5) continue;
    if (out.some(o => Math.abs(o.t - c.t) < gap)) continue;
    out.push(c);
    if (out.length >= Math.ceil(total / gap)) break;
  }
  out.sort((a, b) => a.t - b.t);
  const ROT = { bold: ['slam', 'smear', 'slice', 'slam', 'shatter'], clean: ['build', 'fade', 'blurIn', 'pop'], tech: ['neon', 'slice', 'scramble', 'smear'] }[look] || ['slam'];
  const ACCENT = { bold: 'color', clean: ['pill', 'serif', 'box'], tech: 'color' }[look];
  return out.map((c, i) => {
    const words = c.text.split(' '), ai = accentIndex(words);
    const marked = words.map((w, j) => (j === ai ? `*${w}*` : w));
    const upper = look !== 'clean';
    // slam stacks: break into lines of one or two words so each line fills the width
    let text = marked.join(' ');
    const anim = c.kind === 'question' && look === 'bold' ? 'slam' : ROT[i % ROT.length];
    if (anim === 'slam') { const lines = []; for (let j = 0; j < marked.length; j += marked[j].length > 6 ? 1 : 2) lines.push(marked.slice(j, j + (marked[j].length > 6 ? 1 : 2)).join(' ')); text = lines.join('\n'); }
    if (upper) text = text.toUpperCase();
    const dur = Math.min(3.5, Math.max(1.4, c.end - c.t + 0.8));
    const g = { t: Math.max(0, c.t - 0.05), dur, text, anim, accent: Array.isArray(ACCENT) ? ACCENT[i % ACCENT.length] : ACCENT, kind: c.kind, y: tall ? 0.36 : 0.42 };
    // a graphic with some of them
    if (c.kind === 'question' && look === 'bold') { g.element = 'starburst'; g.elementText = ''; }
    else if (c.kind === 'percent') { g.element = 'chart'; g.elementText = (c.text.match(/[+-]?\d+(\.\d+)?\s*%/) || [''])[0].replace(/\s/g, ''); }
    else if (look === 'tech' && i % 3 === 0) g.element = 'lightStreak';
    else if (look === 'bold' && i % 4 === 1) g.element = 'lightStreak';
    return g;
  });
}
