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

const isSound = (doc, c) => !!c && c.type === 'media' && !c.disabled && (c.audioOnly || mediaById(doc, c.media)?.kind === 'audio');
/**
 * The sound that belongs with a picture clip: its detached sound, or (Reel's own recordings, where the microphone is a
 * clip of its own under the screen) a sound clip on another track lined up with it: same start and end, else the same
 * start (edge 'start') or the same end (edge 'end').
 */
export function partnerSound(doc, c, edge = 'start') {
  if (c.detached) return doc.clips.find(x => x.id === c.detached) || null;
  const list = doc.clips.filter(x => x !== c && x.track !== c.track && isSound(doc, x));
  const atStart = x => Math.abs(x.start - c.start) <= EPS, atEnd = x => Math.abs(clipEnd(x) - clipEnd(c)) <= EPS;
  return list.find(x => atStart(x) && atEnd(x)) || list.find(edge === 'start' ? atStart : atEnd) || list.find(edge === 'start' ? atEnd : atStart) || null;
}
const withSound = (doc, c) => hasSound(doc, c) || (isVideo(doc, c) && !!partnerSound(doc, c));

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
  // a dialogue track first (Voice, Dialogue…), then any free track from the bottom up
  const talk = doc.tracks.find(t => (t.role === 'dialogue' || /voice|dialog|vo\b|speech/i.test(t.name || '')) && isFree(doc, t.id, s0, s1 - s0, ids));
  if (talk) return talk.id;
  for (let i = doc.tracks.length - 1; i >= 0; i--) if (isFree(doc, doc.tracks[i].id, s0, s1 - s0, ids)) return doc.tracks[i].id;
  const t = addTrack(doc); t.name = 'Sound'; return t.id;
}

/**
 * L-cut or J-cut at the cut between a and b (touching, on one track): their sounds go on clips of their own and the
 * sound's edit point moves `lead` seconds after (L) or before (J) the picture's, with a short equal-power blend.
 */
export function splitEdit(doc, a, b, kind = 'l-cut', lead = 1) {
  if (Math.abs(b.start - clipEnd(a)) > EPS) return { error: 'The two clips need to touch (one ends where the next begins).' };
  // each picture's sound: its own (put on a clip of its own), or the microphone clip lined up under it
  const own = hasSound(doc, a) && hasSound(doc, b);
  // (a's sound is the one that ends at the cut, b's the one that starts there; after an L or J, the other ends of them)
  let sa = own ? soundOf(doc, a) : partnerSound(doc, a, 'end'), sb = own ? soundOf(doc, b) : partnerSound(doc, b, 'start');
  const cut = b.start;
  if (!own && sa && !sb) sb = doc.clips.find(x => x !== sa && x.track === sa.track && isSound(doc, x) && Math.abs(x.start - clipEnd(sa)) <= EPS) || null; // the sound that meets it
  if (!own && sb && !sa) sa = doc.clips.find(x => x !== sb && x.track === sb.track && isSound(doc, x) && Math.abs(clipEnd(x) - sb.start) <= EPS) || null;
  if (!sa || !sb || sa === sb) return { error: 'Both clips at the cut need sound: video with sound, or a sound clip under each one that’s cut at the same place.' };
  if (!own && sa.track !== sb.track) return { error: 'The sounds under these two clips are on different tracks; put them on one track first.' };
  const sbEnd0 = clipEnd(sb);
  delete sa.xfadeOut; delete sb.xfadeIn;
  if (Math.abs(sb.start - clipEnd(sa)) > EPS) return { error: 'The two sounds don’t meet any more; move them back together first.' };
  rollSound(sa, sb, cut); // back to a straight cut first (so it can be changed from L to J and back)
  const room = kind === 'j-cut' ? Math.min(headRoom(sb), sa.duration - 0.2) : Math.min(tailRoom(doc, sa), sb.duration - 0.2);
  let d = Math.min(lead, room), tight = false;
  if (d >= 0.1) rollSound(sa, sb, kind === 'j-cut' ? cut - d : cut + d);
  else {
    // no spare sound past the clips' ends (whole clips, as recorded): make the room from the pictures instead
    tight = true;
    const end = clipEnd(b);
    const later = new Set(doc.clips.filter(c => c.track === b.track && c !== b && c.start >= end - EPS));
    for (const c of [...later]) { const snd = c.detached && doc.clips.find(x => x.id === c.detached); if (snd) later.add(snd); }
    for (const c of doc.clips) if (c.track === sb.track && c !== sb && c !== sa && c.start >= sbEnd0 - EPS) later.add(c); // and the sound that follows
    const closeUp = () => { for (const c of later) c.start -= d; }; // what follows moves up to close the gap
    if (kind === 'j-cut') {
      d = Math.min(lead, b.duration - 0.3, sa.duration - 0.3);
      if (!(d >= 0.1)) return { error: 'These clips are too short for a J-cut.' };
      advanceStart(b, d); b.duration -= d; // the next shot's picture starts d into the shot, at the same place
      sb.start = cut - d; // its sound starts from the top of the shot, d early: in step with the picture
      setEnd(sa, sa.duration - d);
      closeUp();
    } else {
      d = Math.min(lead, a.duration - 0.3, b.duration - 0.3);
      if (!(d >= 0.1)) return { error: 'These clips are too short for an L-cut.' };
      setEnd(a, a.duration - d); b.start -= d; // the picture changes d earlier
      advanceStart(sb, d); sb.duration -= d; // the next sound stays at the old cut, in step with its picture
      closeUp();
    }
  }
  const xf = 0.24;
  if (tailRoom(doc, sa) >= xf / 2 && headRoom(sb) >= xf / 2) { sa.xfadeOut = xf; sb.xfadeIn = xf; }
  else { sa.audio = { ...sa.audio, fadeOut: 0.08 }; sb.audio = { ...sb.audio, fadeIn: 0.08 }; }
  if (own) sa.track = sb.track = soundTrack(doc, sa, sb);
  sa.filmCut = sb.filmCut = kind;
  return { lead: d, tight, own, sounds: [sa.id, sb.id] };
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
  const snd0 = partnerSound(doc, c, 'start');
  const end0 = clipEnd(c), later = new Set(doc.clips.filter(x => x.track === c.track && x !== c && x.start >= end0 - EPS));
  for (const x of [...later]) { const sd = x.detached && doc.clips.find(y => y.id === x.detached); if (sd) later.add(sd); }
  if (snd0) for (const x of doc.clips) if (x.track === snd0.track && x !== snd0 && x.start >= clipEnd(snd0) - EPS) later.add(x);
  const [rid] = split(doc, t, [c.id]); const r = doc.clips.find(x => x.id === rid); if (!r) return { error: 'Couldn’t cut there.' };
  // a moment is cut out: the rest of the shot starts `skip` later in its source and everything after moves up
  const s = Math.min(skip, r.duration - 0.2);
  if (s > 0.01) {
    advanceStart(r, s); r.duration -= s;
    for (const x of later) x.start -= s;
  }
  const base = c.props?.scale ?? 1;
  r.props.scale = base > 1.06 ? base / punch : base * punch;
  r.hardCut = true;
  if (snd0 && t > snd0.start + 0.05 && t < clipEnd(snd0) - 0.05) { // its sound jumps too
    const [sid] = split(doc, t, [snd0.id]); const sr = doc.clips.find(x => x.id === sid);
    if (sr && s > 0.01) { advanceStart(sr, s); sr.duration -= s; }
    if (c.detached) r.detached = sid;
  }
  return { ids: [rid], skipped: s };
}

/** Cut on action: the next shot starts a few frames earlier in its move, and a quick blur carries the eye across. */
export function cutOnAction(doc, a, b, overlap = 0.08) {
  const o = Math.min(overlap, headRoom(b));
  if (o > 0.01) {
    advanceStart(b, -o);
    const snd = partnerSound(doc, b, 'start');
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
    const out = [c]; const snd = partnerSound(doc, c, 'start');
    const lined = snd && Math.abs(snd.start - c.start) <= EPS && Math.abs(clipEnd(snd) - clipEnd(c)) <= EPS ? snd : null;
    const sounds = lined ? [lined] : [];
    let at = c.start;
    for (const L of piecesOf(c.duration, piece, faster).slice(0, -1)) {
      at += L;
      const last = out[out.length - 1], [rid] = split(doc, at, [last.id]);
      const r = doc.clips.find(x => x.id === rid); if (r) out.push(r);
      if (sounds.length) { const ls = sounds[sounds.length - 1]; const [sid] = split(doc, at, [ls.id]); const sr = doc.clips.find(x => x.id === sid); if (sr) { sounds.push(sr); if (r && c.detached) r.detached = sid; } }
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
  const list = doc.clips.filter(c => c.track === trackId && withSound(doc, c)).sort((a, b) => a.start - b.start);
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
