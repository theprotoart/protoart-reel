// Swearing in a podcast or interview, bleeped or muted: which timed words count, where the bleeps go, and the
// captions' words starred out. Pure functions, so they're tested in Node.
//
// A word counts when it's on the list (a * at the end of a list word also catches longer forms: fuck* is fucking,
// fucked…), or when the Mac's speech recognition has already starred it out itself (f***). The list has two levels:
// strong (swearing and slurs, the default) and all (the mild ones too: damn, hell, crap…). Your own words can be
// added, and any word allowed.

const STRONG = [
  'fuck*', 'motherfuck*', 'fck*', 'fuk*', 'shit*', 'bullshit*', 'horseshit', 'shite', 'cunt*', 'bitch*', 'asshole*', 'arsehole*',
  'bastard*', 'dick', 'dicks', 'dickhead*', 'cock', 'cocks', 'cocksucker*', 'pussy', 'pussies', 'prick', 'pricks', 'twat*', 'wanker*',
  'slut*', 'whore*', 'jackass', 'dumbass', 'goddamn*', 'goddam', 'bollocks', 'tits',
  // slurs
  'nigger*', 'nigga*', 'faggot*', 'fag', 'fags', 'retard', 'retards', 'retarded', 'spic', 'spics', 'chink', 'chinks', 'kike', 'kikes', 'tranny', 'trannies',
];
const MILD = ['damn', 'damned', 'dammit', 'damnit', 'hell', 'crap', 'crappy', 'ass', 'asses', 'piss*', 'arse', 'bloody', 'sucks', 'screw'];

export const LEVELS = { strong: STRONG, all: [...STRONG, ...MILD] };

const clean = s => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/^[^\p{L}\p{N}*]+|[^\p{L}\p{N}*]+$/gu, '');

/** A test for whether one word counts: (text) → true/false. extra: more words (same * rule); allow: words to leave. */
export function swearTest({ level = 'strong', extra = [], allow = [] } = {}) {
  const list = [...(LEVELS[level] || STRONG), ...extra.map(clean).filter(Boolean)];
  const exact = new Set(list.filter(w => !w.endsWith('*')));
  const stems = list.filter(w => w.endsWith('*')).map(w => w.slice(0, -1)).filter(Boolean);
  const ok = new Set(allow.map(clean).filter(Boolean));
  return text => {
    const w = clean(text);
    if (!w || ok.has(w)) return false;
    // starred out already by the speech recognition (f***, s**t)
    if (/^\p{L}+\*+\p{L}*$/u.test(w) || /^\*{2,}$/.test(w)) return true;
    const bare = w.replace(/'s$/, '');
    return exact.has(w) || exact.has(bare) || stems.some(s => w.startsWith(s));
  };
}

/**
 * Where to bleep: the swear words in words ([{ t, end, text, clip }] on the timeline) as [{ t, end, text, clips }], a little
 * wider than the word (pad s each side) so none of it slips through, and words close together joined into one.
 */
export function swearRanges(words, opts = {}, { pad = 0.04, join = 0.12 } = {}) {
  const is = swearTest(opts), out = [];
  for (const w of words) {
    if (!is(w.text)) continue;
    const t = Math.max(0, w.t - pad), end = w.end + pad, last = out[out.length - 1];
    if (last && t - last.end <= join) { last.end = Math.max(last.end, end); last.text += ' ' + w.text; if (w.clip) last.clips.add(w.clip); }
    else out.push({ t, end, text: String(w.text), clips: new Set(w.clip ? [w.clip] : []) });
  }
  return out;
}

/** A swear word as captions show it: its first letter, the rest starred (fucking → f******). */
export function starred(text) {
  const s = String(text);
  return s.replace(/\p{L}[\p{L}'’*]*/gu, w => w[0] + '*'.repeat(Math.max(2, w.length - 1)));
}

/** The words with every swear word starred, for captions and the talking text. */
export function cleanWords(words, opts = {}) {
  const is = swearTest(opts);
  return words.map(w => (is(w.text) ? { ...w, text: starred(w.text), bleeped: true } : w));
}

// ------------------------------------------------------------------ on the project

/** The tone a bleep is: 1 kHz, a little under full level, as mono 48 kHz samples, `secs` long. */
export function bleepTone(secs = 3, rate = 48000) {
  const n = Math.round(secs * rate), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.28 * Math.sin((2 * Math.PI * 1000 * i) / rate);
  return out;
}

const VOL = 'audio.volume', EDGE = 0.012;
const recOf = (doc, c) => { const m = doc.media.find(x => x.id === c.media); return m ? m.recording || m.id : null; };

/**
 * Puts the bleeps on the project (inside a commit): for each range, the voice is muted (its clip's volume dips to
 * nothing, with a very short ramp each side, on the clip the word was heard on and every other clip of the same
 * recording sounding then: the mic and the camera's own sound alike), and in bleep mode a tone clip plays over it on
 * a Bleeps track. Music and sound effects are left alone. Every point and clip it adds is marked, so taking the
 * bleeps out again (unbleep) leaves the rest as it was. tone: the tone media (bleep mode). Returns how many.
 */
export function applyBleeps(doc, ranges, { mode = 'bleep', tone = null, newClip, addTrack } = {}) {
  unbleep(doc);
  if (!ranges.length) return 0;
  let n = 0, tr = null;
  for (const r of ranges) {
    const recs = new Set([...r.clips].map(id => doc.clips.find(c => c.id === id)).filter(Boolean).map(c => recOf(doc, c)));
    const hit = doc.clips.filter(c => c.type === 'media' && recs.has(recOf(doc, c)) && c.start < r.end && c.start + c.duration > r.t);
    if (!hit.length) continue;
    for (const c of hit) dip(c, r.t - c.start, r.end - c.start);
    if (mode === 'bleep' && tone && newClip) {
      if (!tr) {
        tr = doc.tracks.find(t => t.bleeps) || null;
        if (!tr && addTrack) { tr = addTrack(doc, doc.tracks.length); tr.name = 'Bleeps'; tr.bleeps = true; }
      }
      if (tr) {
        const c = newClip(doc, tone, tr.id, r.t);
        c.duration = Math.min(r.end - r.t, tone.duration || 3);
        c.audio = { ...(c.audio || {}), volume: 0.8, fadeIn: 0.006, fadeOut: 0.006 };
        c.style = 'auto-bleep';
        c.name = 'Bleep';
        doc.clips.push(c);
      }
    }
    n++;
  }
  return n;
}

/** The clip's volume to nothing from local time a to b (clip seconds), its level either side kept. */
function dip(c, a, b) {
  a = Math.max(0, a); b = Math.min(c.duration, b);
  if (b <= a) return;
  c.keys ||= {};
  const list = (c.keys[VOL] ||= []);
  const base = c.audio?.volume ?? 1;
  const level = t => {
    if (!list.length) return base;
    if (t <= list[0].t) return list[0].v;
    const last = list[list.length - 1];
    if (t >= last.t) return last.v;
    let i = 0; while (list[i + 1].t <= t) i++;
    const p = list[i], q = list[i + 1];
    return p.v + ((q.v - p.v) * (t - p.t)) / Math.max(1e-9, q.t - p.t);
  };
  const before = level(a - EDGE), after = level(b + EDGE);
  // the points inside go quiet too (a level set there would let the word through)
  const add = [{ t: Math.max(0, a - EDGE), v: before }, { t: a, v: 0 }, { t: b, v: 0 }, { t: Math.min(c.duration, b + EDGE), v: after }]
    .map(k => ({ ...k, ease: 'linear', bleep: true }));
  c.keys[VOL] = [...list.filter(k => k.t < a - EDGE - 1e-6 || k.t > b + EDGE + 1e-6), ...add].sort((x, y) => x.t - y.t);
}

/** Takes out the bleeps (and mutes) put on before: the marked volume points and tone clips. Returns how many clips. */
export function unbleep(doc) {
  const before = doc.clips.length;
  doc.clips = doc.clips.filter(c => c.style !== 'auto-bleep');
  for (const c of doc.clips) {
    const l = c.keys?.[VOL];
    if (!l || !l.some(k => k.bleep)) continue;
    const rest = l.filter(k => !k.bleep);
    if (rest.length) c.keys[VOL] = rest; else { delete c.keys[VOL]; if (!Object.keys(c.keys).length) delete c.keys; }
  }
  return before - doc.clips.length;
}
