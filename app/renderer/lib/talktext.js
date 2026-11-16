// Talking text: for videos where the viewer hears you but doesn't see you (screen tutorials), the words go on screen
// as you say them, the way the most-watched channels do it. Two layers:
//  · spoken lines: what you say, a few words at a time, each word lighting up as it's said (timed to your voice);
//  · key words: the punchy bits (a question, a number, a "never", a tip) popping up big in the middle in a mix of
//    eye-catching looks, now and then with an emoji.
// Works from word timings ([{ text, t, end }]); no DOM here, so it's tested in Node.
import { planGraphics } from './kinetic.js';

export const TALK_MODES = { off: ['Off'], spoken: ['Spoken words'], keywords: ['Key words'], both: ['Both'] };
/** How the spoken lines look (the word being said lit up). */
export const TALK_LOOKS = { green: ['Green word'], yellow: ['Yellow word'], box: ['Boxed word'], one: ['One word at a time'], clean: ['Clean'] };
export const TALK_AMOUNTS = { few: ['A few'], lots: ['Lots'] };

const FILLER = /^(um+|uh+|erm+|er|ah+|hmm+|mm+)$/i;
const bare = w => String(w).replace(/^[^\p{L}\p{N}$€£%+-]+|[^\p{L}\p{N}%!?.'’$€£]+$/gu, '');

/** What you say, cut into short lines: [{ t, dur, text, wordTimes }] (wordTimes: when each word is said, from t). */
export function spokenLines(words, total, { tall = false, maxWords, maxChars } = {}) {
  maxWords ??= tall ? 3 : 5; maxChars ??= tall ? 20 : 30;
  const ws = (words || []).map(w => ({ ...w, str: bare(w.text) })).filter(w => w.str && !FILLER.test(w.str) && w.t >= 0 && w.t < total);
  const groups = [];
  let g = [];
  const close = () => { if (g.length) groups.push(g); g = []; };
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i], prev = g[g.length - 1];
    const len = g.reduce((a, x) => a + x.str.length + 1, 0) + w.str.length;
    // a new line after a pause, at the end of a sentence, or when it's full
    if (prev && (w.t - prev.end > 0.45 || /[.?!]$/.test(prev.str) || g.length >= maxWords || len > maxChars)) close();
    g.push(w);
  }
  close();
  return groups.map((g, i) => {
    const t = Math.max(0, g[0].t - 0.05), next = groups[i + 1] ? Math.max(0, groups[i + 1][0].t - 0.05) : total;
    const end = Math.min(next - 0.03, g[g.length - 1].end + 0.35, total);
    return { t, dur: Math.max(0.35, end - t), text: g.map(w => w.str).join(' '), wordTimes: g.map(w => Math.max(0, +(w.t - t).toFixed(3))) };
  }).filter(l => l.dur > 0.2);
}

const EMOJI = [
  [/\b(money|dollars?|price|cost|cheap|paid|pay|budget|\$\d)/i, '💰'], [/\b(free)\b/i, '🎁'],
  [/\b(fast|faster|quick|quickly|instantly|seconds|speed)\b/i, '⚡'], [/\b(time|minutes|hours|days)\b/i, '⏱️'],
  [/\b(tip|trick|secret|hack|idea)\b/i, '💡'], [/\b(wrong|mistake|never|stop|don'?t|bad|worst)\b/i, '❌'],
  [/\b(right|correct|works|perfect|done|easy|simple)\b/i, '✅'], [/\b(crazy|insane|huge|best|amazing|wild)\b/i, '🔥'],
  [/\b(love)\b/i, '❤️'], [/\b(look|watch|see|notice)\b/i, '👀'], [/\b(grow|growth|more|increase|double|\d+%)/i, '📈'],
  [/\b(careful|warning|danger)\b/i, '⚠️'], [/\b(win|won|success|results?)\b/i, '🏆'], [/\?/, '🤔'],
];
export const emojiFor = text => (EMOJI.find(([re]) => re.test(text)) || [null, null])[1];

/**
 * The punchy bits as big pops: [{ t, dur, text, look, emoji? }]. look is a title look id (lookBigPop, lookQuestion,
 * lookNumber, lookSticker, lookMarker, lookUnderline, lookOneWord): a question gets the big question, a number the big
 * number, a short tip a sticker, the rest take turns so it never looks the same twice in a row.
 */
export function keyWordPops(words, total, { amount = 'few', tall = false } = {}) {
  const plan = planGraphics(words, total, { amount, look: 'bold', tall });
  const turn = ['lookBigPop', 'lookMarker', 'lookOneWord', 'lookUnderline', 'lookBigPop', 'lookSticker'];
  let k = 0;
  const LITTLE = /^\*?(the|a|an|to|of|and|or|in|on|at|for|is|it|its|it's|that|this|with|i|i'm|i'll|you|you're|we|so|just|be|was|are|my|your|but|will|then|than|by)\*?$/i;
  const tidy = text => {
    // little words at either end are left off ("IS 10X FASTER" → "10X FASTER"); a stray star is closed again
    let ws = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
    while (ws.length > 1 && LITTLE.test(ws[0].replace(/[’]/g, "'"))) ws.shift();
    while (ws.length > 1 && LITTLE.test(ws[ws.length - 1].replace(/[’?.!,]/g, ''))) ws.pop();
    let t = ws.join(' ');
    if ((t.match(/\*/g) || []).length % 2) t = t.replace(/\*/g, '');
    return t;
  };
  const content = t => t.replace(/\*/g, '').split(' ').filter(w => !LITTLE.test(w.replace(/[’]/g, "'").replace(/[?.!,]/g, ''))).length;
  return plan.map(g => ({ ...g, text: g.kind === 'question' ? g.text.replace(/\n/g, ' ') : tidy(g.text) }))
    // a pop has to say something: two real words at least (or a number, or a question)
    .filter(g => g.kind === 'question' || g.kind === 'number' || g.kind === 'percent' || content(g.text) >= 2)
    .map((g, i) => {
    const plain = g.text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    const nWords = plain.split(' ').length;
    let look;
    if (g.kind === 'question') look = 'lookQuestion';
    else if (g.kind === 'percent' || g.kind === 'number') look = 'lookNumber';
    else if (/\b(tip|trick|secret|hack)\b/i.test(plain) && nWords <= 4) look = 'lookSticker';
    else { look = turn[k++ % turn.length]; if (look === 'lookSticker' && nWords > 4) look = 'lookBigPop'; }
    // the pens and the clean looks read best in ordinary case; the big ones in capitals
    const soft = look === 'lookMarker' || look === 'lookUnderline';
    let text = soft ? plain.toLowerCase().replace(/^\p{L}/u, c => c.toUpperCase()).replace(/\*(\p{L})/gu, (m, c) => '*' + c) : plain.toUpperCase();
    if (!/\*[^*]+\*/.test(text) && soft) { const ws = text.split(' '); ws[ws.length - 1] = `*${ws[ws.length - 1]}*`; text = ws.join(' '); }
    const emoji = amount === 'lots' || i % 2 === 0 ? emojiFor(plain) : null;
    return { t: g.t, dur: Math.max(1.6, g.dur), text, look, emoji: emoji || undefined, kind: g.kind };
  });
}

/** Both layers (or one): { lines, pops }. */
export function planTalkingText(words, total, { mode = 'both', amount = 'few', tall = false } = {}) {
  if (mode === 'off' || !words?.length || !(total > 1)) return { lines: [], pops: [] };
  let lines = mode === 'spoken' || mode === 'both' ? spokenLines(words, total, { tall }) : [];
  const pops = mode === 'keywords' || mode === 'both' ? keyWordPops(words, total, { amount, tall }) : [];
  // while a key word is up, the line underneath would only say the same thing again: it steps aside
  const over = (l, p) => Math.max(0, Math.min(l.t + l.dur, p.t + p.dur) - Math.max(l.t, p.t));
  if (pops.length) lines = lines.filter(l => !pops.some(p => over(l, p) > l.dur * 0.5));
  return { lines, pops };
}
