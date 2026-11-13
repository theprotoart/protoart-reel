// Film cuts: the classic edits editors use on almost every film, as one-click operations on the timeline.
//   L-cut      the picture changes, the sound of the shot before carries on under the next shot
//   J-cut      the next shot's sound starts before its picture (you hear it coming)
//   Smash cut  a hard, sudden cut, with a hit
//   Jump cut   a jump forward in the same shot, with a punch-in so it reads as a choice
//   Cut on action  hides the cut inside a movement: a couple of frames of the move repeat, with a quick blur
//   Cutaway    a short insert shot over the main one while the main sound keeps playing
//   Cross-cut  two scenes cut together turn about (ever faster, if you like)
// Pure functions on the project (run inside app.commit); they return what they did, or { error }.
import { clipEnd, mediaById, uid, addTrack, isFree, advanceStart, setEnd, sourceSpan, applyCut, split } from '../model.js';

export const FILM_CUTS = [
  ['l-cut', 'L-cut', 'The picture changes first; the sound of the shot before carries on under the next one (a reaction, a voice that keeps talking).'],
  ['j-cut', 'J-cut', 'You hear the next shot before you see it: its sound starts under the end of this one.'],
  ['smash', 'Smash cut', 'A hard, sudden cut with a hit: from calm to chaos, or the other way.'],
  ['jump', 'Jump cut', 'Jumps forward in the same shot with a punch-in. Put the playhead where to jump.'],
  ['action', 'Cut on action', 'Hides the cut inside a movement: a few frames of the move repeat, with a quick motion blur.'],
  ['cutaway', 'Cutaway / insert', 'Lays the selected shot over the main one at the playhead (2.5 s), muted, so the main sound keeps playing.'],
  ['cross', 'Cross-cut', 'Cuts two clips that follow each other together turn about, each piece shorter than the last.'],
];

const EPS = 0.05;
const isVideo = (doc, c) => c?.type === 'media' && !c.audioOnly && mediaById(doc, c.media)?.kind === 'video';
const hasSound = (doc, c) => isVideo(doc, c) && !!mediaById(doc, c.media)?.hasAudio;
const visual = (doc, c) => c && c.type === 'media' && !c.audioOnly && mediaById(doc, c.media)?.kind !== 'audio';

/** Timeline seconds of source left after the clip's end (Infinity for pictures). */
export function tailRoom(doc, c) {
  const m = mediaById(doc, c.media);
  if (!m || m.kind === 'image' || !(m.duration > 0)) return Infinity;
  return Math.max(0, (m.duration - (c.in || 0) - sourceSpan(c, c.duration)) / (c.speed || 1));
}
/** Timeline seconds of source before the clip's start. */
export const headRoom = c => Math.max(0, (c.in || 0) / (c.speed || 1));

/** The clip's sound as a clip of its own (detached now if it isn't yet), grouped with the picture. */
function soundOf(doc, c) {
  const have = c.detached && doc.clips.find(x => x.id === c.detached);
  if (have) return have;
  const a = structuredClone(c);
  a.id = uid('c'); a.audioOnly = true; a.actions = []; a.name = `${c.name || mediaById(doc, c.media)?.name || 'Clip'} (audio)`;
  a.transIn = { type: 'none', dur: 0.5 }; a.transOut = { type: 'none', dur: 0.5 };
  delete a.xfadeIn; delete a.xfadeOut; delete a.xfAuto; delete a.detached;
  if (a.keys) for (const p of Object.keys(a.keys)) if (!p.startsWith('audio.')) delete a.keys[p];
  if (c.keys) for (const p of Object.keys(c.keys)) if (p.startsWith('audio.')) delete c.keys[p];
  c.group ||= uid('g'); a.group = c.group;
  c.audio = { ...(c.audio || {}), mute: true };
  c.detached = a.id;
  doc.clips.push(a);
  return a;
}
/** Moves the edit point between two sounds that touch to timeline time T (a roll edit). */
function rollSound(sa, sb, T) {
  const d = T - clipEnd(sa);
  setEnd(sa, sa.duration + d);
  advanceStart(sb, d); sb.start += d; sb.duration -= d;
}
/** A track where both sounds fit, from the bottom up (a new "Sound" track at the bottom if none). */
function soundTrack(doc, sa, sb) {
  const s0 = Math.min(sa.start, sb.start), s1 = Math.max(clipEnd(sa), clipEnd(sb)), ids = [sa.id, sb.id];
  if (sa.track === sb.track && isFree(doc, sa.track, s0, s1 - s0, ids)) return sa.track;
  for (let i = doc.tracks.length - 1; i >= 0; i--) if (isFree(doc, doc.tracks[i].id, s0, s1 - s0, ids)) return doc.tracks[i].id;
  const t = addTrack(doc); t.name = 'Sound'; return t.id;
}

/**
 * L-cut or J-cut at the cut between a and b (touching, on one track): their sounds go on clips of their own and the
 * sound's edit point moves `lead` seconds after (L) or before (J) the picture's, with a short equal-power blend.
 */
export function splitEdit(doc, a, b, kind = 'l-cut', lead = 1) {
  if (!hasSound(doc, a) || !hasSound(doc, b)) return { error: 'Both clips at the cut need to be video with sound.' };
  if (Math.abs(b.start - clipEnd(a)) > EPS) return { error: 'The two clips need to touch (one ends where the next begins).' };
  const sa = soundOf(doc, a), sb = soundOf(doc, b), cut = b.start;
  delete sa.xfadeOut; delete sb.xfadeIn;
  if (Math.abs(sb.start - clipEnd(sa)) > EPS) return { error: 'The two sounds don’t meet any more; move them back together first.' };
  rollSound(sa, sb, cut); // back to a straight cut first (so it can be changed from L to J and back)
  const room = kind === 'j-cut' ? Math.min(headRoom(sb), sa.duration - 0.2) : Math.min(tailRoom(doc, sa), sb.duration - 0.2);
  const d = Math.min(lead, room);
  if (!(d >= 0.1)) return { error: kind === 'j-cut' ? 'The next clip has no extra sound before its start to bring in early (trim its start later first).' : 'The first clip has no extra sound after its end to carry on (trim its end earlier first).' };
  rollSound(sa, sb, kind === 'j-cut' ? cut - d : cut + d);
  const xf = 0.24;
  if (tailRoom(doc, sa) >= xf / 2 && headRoom(sb) >= xf / 2) { sa.xfadeOut = xf; sb.xfadeIn = xf; }
  else { sa.audio = { ...sa.audio, fadeOut: 0.08 }; sb.audio = { ...sb.audio, fadeIn: 0.08 }; }
  sa.track = sb.track = soundTrack(doc, sa, sb);
  sa.filmCut = sb.filmCut = kind;
  return { lead: d, sounds: [sa.id, sb.id] };
}

/** A straight, hard cut (no transition, no crossfade) with a hit on it. */
export function smashCut(doc, a, b) {
  a.transOut = { type: 'none', dur: a.transOut?.dur || 0.5 }; b.transIn = { type: 'none', dur: b.transIn?.dur || 0.5 };
  delete a.xfadeOut; delete b.xfadeIn; delete a.xfAuto; delete b.xfAuto;
  b.hardCut = true;
  return { sfx: [{ id: 'hit', at: b.start }] };
}

/**
 * Jump cut at time t inside clip c: the rest of the clip skips `skip` seconds ahead in its source and punches in
 * (or back out, if the part before was punched in). Its sound jumps with it.
 */
export function jumpCut(doc, c, t, skip = 0.4, punch = 1.12) {
  if (!visual(doc, c) || t <= c.start + 0.2 || t >= clipEnd(c) - 0.2) return { error: 'Put the playhead inside a video clip, where it should jump.' };
  const [rid] = split(doc, t, [c.id]); const r = doc.clips.find(x => x.id === rid); if (!r) return { error: 'Couldn’t cut there.' };
  const s = Math.min(skip, tailRoom(doc, r));
  if (s > 0.01) advanceStart(r, s);
  const base = c.props?.scale ?? 1;
  r.props.scale = base > 1.06 ? base / punch : base * punch;
  r.hardCut = true;
  if (c.detached) { // its sound jumps too
    const snd = doc.clips.find(x => x.id === c.detached);
    if (snd && t > snd.start + 0.05 && t < clipEnd(snd) - 0.05) { const [sid] = split(doc, t, [snd.id]); const sr = doc.clips.find(x => x.id === sid); if (sr && s > 0.01) advanceStart(sr, s); r.detached = sid; }
  }
  return { ids: [rid], skipped: s };
}

/** Cut on action: the next shot starts a few frames earlier in its move, and a quick blur carries the eye across. */
export function cutOnAction(doc, a, b, overlap = 0.08) {
  const o = Math.min(overlap, headRoom(b));
  if (o > 0.01) {
    advanceStart(b, -o);
    const snd = b.detached && doc.clips.find(x => x.id === b.detached);
    if (snd && Math.abs(snd.start - b.start) < EPS && headRoom(snd) >= o) advanceStart(snd, -o);
  }
  applyCut(a, b, 'blur-through', 0.2);
  return { sfx: [{ id: 'swish', at: b.start }] };
}

/** Cutaway: a copy of `shot` laid over `main` at t (on a track above it), muted, `len` seconds, soft in and out. */
export function cutaway(doc, main, shot, t, len = 2.5) {
  if (!visual(doc, shot)) return { error: 'Select the shot to cut away to (a video or picture clip).' };
  const c = structuredClone(shot);
  c.id = uid('c'); c.start = Math.max(0, t); delete c.group; delete c.detached; delete c.xfadeIn; delete c.xfadeOut; delete c.xfAuto;
  setEnd(c, Math.min(c.duration, len));
  c.audio = { ...(c.audio || {}), mute: true };
  c.transIn = { type: 'fade', dur: 0.12 }; c.transOut = { type: 'fade', dur: 0.12 };
  c.cutaway = true; c.name = `Cutaway: ${shot.name || 'shot'}`;
  const mi = Math.max(0, doc.tracks.findIndex(x => x.id === (main?.track ?? shot.track)));
  let tr = null;
  for (let i = mi - 1; i >= 0; i--) if (isFree(doc, doc.tracks[i].id, c.start, c.duration)) { tr = doc.tracks[i]; break; }
  if (!tr) { tr = addTrack(doc, mi); tr.name = 'Cutaways'; }
  c.track = tr.id;
  doc.clips.push(c);
  return { ids: [c.id] };
}

/** Piece lengths for one clip of a cross-cut: `piece` seconds, each one shorter by `faster` (0..0.3). */
export function piecesOf(len, piece = 2.5, faster = 0.15, min = 0.7) {
  const out = []; let t = 0, i = 0;
  while (len - t > 1e-6) {
    let L = Math.max(min, piece * (1 - faster) ** i);
    if (len - t - L < Math.max(min, L * 0.5)) L = len - t;
    out.push(L); t += L; i++;
  }
  return out;
}

/** Cross-cut: a and b (touching, on one track) are cut into pieces and laid out turn about, a b a b…, in their place. */
export function crossCut(doc, a, b, piece = 2.5, faster = 0.15) {
  if (!visual(doc, a) || !visual(doc, b) || a.track !== b.track || Math.abs(b.start - clipEnd(a)) > EPS) return { error: 'Select two clips that follow each other on one track (scene A, then scene B).' };
  const t0 = a.start;
  const chop = c => {
    const out = [c]; const snd = c.detached && doc.clips.find(x => x.id === c.detached);
    const sounds = snd ? [snd] : [];
    let at = c.start;
    for (const L of piecesOf(c.duration, piece, faster).slice(0, -1)) {
      at += L;
      const last = out[out.length - 1], [rid] = split(doc, at, [last.id]);
      const r = doc.clips.find(x => x.id === rid); if (r) out.push(r);
      if (sounds.length) { const ls = sounds[sounds.length - 1]; const [sid] = split(doc, at, [ls.id]); const sr = doc.clips.find(x => x.id === sid); if (sr) { sounds.push(sr); if (r) r.detached = sid; } }
    }
    return out.map(p => ({ p, snd: sounds.find(s => Math.abs(s.start - p.start) < 1e-6) || null }));
  };
  const A = chop(a), B = chop(b), order = [];
  for (let i = 0; i < Math.max(A.length, B.length); i++) { if (A[i]) order.push(A[i]); if (B[i]) order.push(B[i]); }
  let at = t0;
  for (const { p, snd } of order) {
    const d = at - p.start; p.start = at; if (snd) snd.start += d;
    p.transIn = { type: 'none', dur: 0.5 }; p.transOut = { type: 'none', dur: 0.5 }; delete p.xfadeIn; delete p.xfadeOut;
    at += p.duration;
  }
  return { pieces: order.length };
}

/**
 * L- and J-cuts on every cut between clips with sound on the track (the way dialogue scenes are cut): they take
 * turns, J then L, `lead` seconds each, varied a little if `vary`. Cuts where there's no room are left as they are.
 */
export function autoSplitEdits(doc, trackId, lead = 1, vary = 0, rng = Math.random) {
  const pairs = []; // the cuts first: detaching changes the list
  const list = doc.clips.filter(c => c.track === trackId && hasSound(doc, c)).sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < list.length; i++) if (Math.abs(list[i + 1].start - clipEnd(list[i])) <= EPS) pairs.push([list[i].id, list[i + 1].id]);
  let n = 0, turn = 0;
  for (const [ai, bi] of pairs) {
    const a = doc.clips.find(c => c.id === ai), b = doc.clips.find(c => c.id === bi);
    const kind = turn % 2 ? 'l-cut' : 'j-cut', d = lead * (1 + (rng() * 2 - 1) * 0.35 * vary);
    const dc = structuredClone(doc), trial = splitEdit(dc, dc.clips.find(c => c.id === ai), dc.clips.find(c => c.id === bi), kind, d);
    if (trial.error) continue;
    if (!splitEdit(doc, a, b, kind, d).error) { n++; turn++; }
  }
  return n;
}
