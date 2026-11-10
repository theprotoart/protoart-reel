// Clap notes: clap, then say what should appear on screen ("Ingredients: two eggs, a cup of flour and a pinch
// of salt"). Each clap signal becomes a note card at that point in the video, holding what was said right after
// it (up to the first long pause), turned into a title and a list. The spoken note can stay in the video or be
// cut out, so it only shows as text. Times are timeline seconds; words are { t, end, text }.

const LEAD = /^(?:(?:a|an|the)\s+)?(?:on[-\s]?screen\s+)?(?:note|notes|text|caption|instruction|instructions)\b\s*[:,.-]?\s*/i;
const TITLES = /^((?:the\s+)?ingredients?|you(?:['’]ll| will) need|what you(?:['’]ll| will) need|equipment|tools?|utensils|step\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)|tip|pro tip|warning|careful|temperature|oven|timer|cook(?:ing)? time|prep(?:aration)? time|serves|method|garnish|sauce|marinade|dressing|for the \w+)\b\s*[:,.-]?\s*/i;

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const tidy = s => s.replace(/\s+/g, ' ').replace(/^[\s,;:.-]+|[\s,;:.]+$/g, '').trim();

/** The words said after time t, up to the first pause longer than maxPause (or maxDur seconds). */
export function spokenNote(words, t, { maxPause = 1.2, maxDur = 20, wait = 4 } = {}) {
  const after = words.filter(w => w.t >= t - 0.05 && w.t < t + wait + maxDur);
  if (!after.length || after[0].t > t + wait) return null; // nothing said soon after the clap
  const got = [after[0]];
  for (let i = 1; i < after.length; i++) {
    const w = after[i];
    if (w.t - got[got.length - 1].end > maxPause || w.t - got[0].t > maxDur) break;
    got.push(w);
  }
  return { t0: got[0].t, t1: got[got.length - 1].end, text: got.map(w => w.text).join(' ') };
}

/** A spoken note as a title and list items: "Ingredients: two eggs, flour and salt" → INGREDIENTS · 3 items. */
export function toNote(text) {
  let s = tidy(String(text || '')).replace(LEAD, '');
  let title = '';
  const m = TITLES.exec(s);
  if (m) { title = tidy(m[1]).replace(/^the\s+/i, '').toUpperCase(); s = s.slice(m[0].length); }
  s = tidy(s);
  let items = s.split(/\s*[;,\n]\s*|(?<=[.!?])\s+/).map(x => tidy(x.replace(/^(?:and|plus|then|also)\s+/i, ''))).filter(Boolean);
  // "eggs and flour and sugar": a short list said without commas
  if (items.length === 1 && / and /i.test(items[0]) && items[0].split(/\s+/).length <= 12) items = items[0].split(/\s+and\s+/i).map(tidy).filter(Boolean);
  // "eggs, flour and salt": the last "and" of a list separates two items as well
  else if (items.length >= 2 && (items[items.length - 1].match(/\s+and\s+/gi) || []).length === 1) items.splice(-1, 1, ...items[items.length - 1].split(/\s+and\s+/i).map(tidy).filter(Boolean));
  items = items.slice(0, 8).map(x => cap(x.length > 64 ? `${x.slice(0, 61).trim()}…` : x));
  return { title, items };
}

/**
 * Where the note cards go. times: where each clap signal was (after the claps were cut out). Returns
 * [{ t, dur, title, items, said: [t0, t1] | null }]; said is the spoken note (to cut it out, if asked).
 * Without words (no speech) every clap still gets a card, with a placeholder to type over.
 */
export function planNotes(words, times, { cutSpeech = false } = {}) {
  const out = [];
  const sorted = [...times].sort((a, b) => a - b);
  sorted.forEach((t, i) => {
    const next = sorted[i + 1] ?? Infinity;
    const said = spokenNote(words.filter(w => w.t < next - 0.1), t);
    const n = said ? toNote(said.text) : null;
    const items = n?.items.length ? n.items : said ? [cap(tidy(said.text))] : ['Type your note here'];
    const title = n?.title || '';
    const read = Math.min(14, Math.max(4, 2.2 + items.length * 1.3));
    const dur = cutSpeech || !said ? read : Math.min(16, Math.max(read, said.t1 - t + 2));
    out.push({ t, dur: Math.max(1, Math.min(dur, next - t - 0.2)), title, items, said: said ? [said.t0, said.t1] : null, placeholder: !said });
  });
  return out;
}

/** Words after cutting the ranges out (sorted [a, b] pairs): the words inside go, the ones after move up. */
export function shiftWords(words, cuts) {
  const cs = [...cuts].sort((a, b) => a[0] - b[0]);
  return words.filter(w => !cs.some(([a, b]) => w.t >= a - 0.02 && w.end <= b + 0.02)).map(w => {
    const d = cs.filter(([, b]) => b <= w.t + 0.02).reduce((s, [a, b]) => s + (b - a), 0);
    return d ? { ...w, t: w.t - d, end: w.end - d } : w;
  });
}

/** Note times after cutting the spoken notes out: each card moves up by what was cut before it. */
export function shiftTimes(times, cuts) {
  return times.map(t => t - cuts.filter(([, b]) => b <= t + 0.02).reduce((s, [a, b]) => s + (b - a), 0));
}
