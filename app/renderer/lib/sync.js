// Picture and sound from one recording, kept in sync. Every clip from a recording plays a stretch of that recording's
// own clock: at timeline time t, clip c plays recording time  c.in + (t - c.start) * speed + off(media), where off is
// when that file started in the recording (the screen, mic and camera files start a few hundredths apart).
// New recordings store off on each media (syncOff). For older ones it's worked out from the clips themselves: most
// pairs are still in sync, so the offset most of the overlapping time agrees on is the true one.
// No DOM here, so it's tested in Node.

const EPS = 0.02; // a frame at 50 fps: closer than this is in sync
const MAX_START = 2; // seconds: how far apart one recording's files can start

const mediaOf = (doc, c) => (c.type === 'media' ? doc.media.find(m => m.id === c.media) : null);
const isSound = (doc, c) => { const m = mediaOf(doc, c); return !!m && (c.audioOnly || m.kind === 'audio'); };
const isPicture = (doc, c) => { const m = mediaOf(doc, c); return !!m && !c.audioOnly && (m.kind === 'video' || m.kind === 'image'); };
const speed = c => c.speed || 1;
const end = c => c.start + c.duration;
/** in - start·speed: with the same speed, two clips are in sync when this (plus each file's offset) matches. */
const lead = c => (c.in || 0) - c.start * speed(c);

/** For each media of a recording, when its file starts in the recording (seconds, the first picture = 0). */
export function recordingOffsets(doc, recId) {
  const media = doc.media.filter(m => m.recording === recId);
  const out = new Map();
  if (media.every(m => Number.isFinite(m.syncOff))) { for (const m of media) out.set(m.id, m.syncOff); return out; }
  const ref = media.find(m => m.role === 'screen') || media.find(m => m.kind === 'video') || media[0];
  if (!ref) return out;
  out.set(ref.id, Number.isFinite(ref.syncOff) ? ref.syncOff : 0);
  const refClips = doc.clips.filter(c => c.media === ref.id && !c.reversed);
  for (const m of media) {
    if (m === ref) continue;
    if (Number.isFinite(m.syncOff) && Number.isFinite(ref.syncOff)) { out.set(m.id, m.syncOff); continue; }
    // votes: for every pair overlapping on the timeline at the same speed, the offset that would put them in sync,
    // weighted by how long they overlap
    const votes = [];
    for (const c of doc.clips) {
      if (c.media !== m.id || c.reversed) continue;
      for (const r of refClips) {
        const ov = Math.min(end(c), end(r)) - Math.max(c.start, r.start);
        if (ov <= 0 || Math.abs(speed(c) - speed(r)) > 1e-6) continue;
        votes.push({ v: (lead(r) - lead(c)) / speed(c), w: ov });
      }
    }
    // files of one recording start within a second or two of each other: a vote for more than that is a clip that
    // slipped, not the true offset (with one slipped pair and nothing else, it's assumed they started together)
    const ok = votes.filter(x => Math.abs(x.v) <= MAX_START);
    let best = { v: 0 }, bestW = -1;
    for (const a of ok) { const w = ok.reduce((k, b) => k + (Math.abs(b.v - a.v) <= EPS ? b.w : 0), 0); if (w > bestW) { bestW = w; best = a; } }
    out.set(m.id, out.get(ref.id) + best.v);
  }
  return out;
}

/** The recording time a clip plays at its start, or NaN. */
const recAt = (c, off) => (c.in || 0) + off;

/**
 * The picture a sound clip belongs with: from the same recording, at the same speed, the one whose stretch of the
 * recording overlaps the sound's most (and that's on the timeline nearby). { pic, shift } where shift is how far the
 * sound must move to be in sync (0 when it is), or null.
 */
export function syncPartner(doc, c, offs) {
  const m = mediaOf(doc, c);
  if (!m?.recording || c.reversed) return null;
  offs ||= recordingOffsets(doc, m.recording);
  if (!offs.has(m.id)) return null;
  const sound = isSound(doc, c);
  let best = null, bestOv = 0;
  for (const o of doc.clips) {
    if (o === c || o.reversed || Math.abs(speed(o) - speed(c)) > 1e-6) continue;
    const om = mediaOf(doc, o);
    if (!om || om.recording !== m.recording || om.id === m.id || !offs.has(om.id)) continue;
    if (sound ? !isPicture(doc, o) : !isSound(doc, o)) continue;
    // overlap in recording time (what each plays), and not miles apart on the timeline
    const a0 = recAt(c, offs.get(m.id)), a1 = a0 + c.duration * speed(c);
    const b0 = recAt(o, offs.get(om.id)), b1 = b0 + o.duration * speed(o);
    const ov = Math.min(a1, b1) - Math.max(a0, b0);
    if (ov <= 0.05) continue;
    const shift = (o.start + (a0 - b0) / speed(c)) - c.start;
    if (Math.abs(shift) > Math.max(600, c.duration * 2)) continue;
    if (ov > bestOv) { bestOv = ov; best = { pic: o, shift: Math.abs(shift) < EPS ? 0 : shift }; }
  }
  return best;
}

/** Every sound clip that's out of sync with its picture: [{ clip, pic, shift }]. */
export function outOfSync(doc) {
  const cache = new Map(), out = [];
  for (const c of doc.clips) {
    if (!isSound(doc, c)) continue;
    const rec = mediaOf(doc, c).recording;
    if (!rec) continue;
    if (!cache.has(rec)) cache.set(rec, recordingOffsets(doc, rec));
    const p = syncPartner(doc, c, cache.get(rec));
    if (p && p.shift) out.push({ clip: c, ...p });
  }
  return out;
}

/**
 * Puts sound clips back in sync with their pictures by moving the sound (the picture is what you cut to). ids: the
 * clips to fix (a picture fixes its sound), or all. The clips that move are lifted off first and put back one by one,
 * so a whole run of clips that slipped together goes back together. One that would land on another clip goes to a free
 * sound track, or a new one when `newTrack` is given (else it stays put, counted in `blocked`).
 */
export function resync(doc, ids = null, isFree = () => true, newTrack = null) {
  let list = outOfSync(doc);
  if (ids) {
    const want = new Set(ids);
    list = list.filter(x => want.has(x.clip.id) || want.has(x.pic.id));
  }
  if (!list.length) return { moved: 0, blocked: 0 };
  const lifting = new Set(list.map(x => x.clip));
  doc.clips = doc.clips.filter(c => !lifting.has(c));
  let moved = 0, blocked = 0;
  for (const { clip: c, shift } of [...list].sort((a, b) => (a.clip.start + a.shift) - (b.clip.start + b.shift))) {
    const to = Math.max(0, c.start + shift);
    let track = isFree(doc, c.track, to, c.duration, [c.id]) ? c.track
      : doc.tracks.find(t => t.id !== c.track && doc.clips.some(o => o.track === t.id && isSound(doc, o)) && isFree(doc, t.id, to, c.duration, [c.id]))?.id;
    if (!track && newTrack) track = newTrack(doc, c.track);
    if (track) { c.track = track; c.start = to; moved++; } else blocked++;
    doc.clips.push(c);
  }
  return { moved, blocked };
}

/**
 * Where a recording's picture is on the timeline but its sound isn't (or the sound with no picture): the stretches
 * missing, as new clips of the other file, in sync, ready to add. [{ media, start, in, duration, beside }] where
 * beside is a clip of that kind from the same recording (to copy its track and settings). Gaps under `min` s are left.
 */
export function missingHalves(doc, { min = 0.5, both = false } = {}) {
  const out = [];
  const recs = new Set(doc.media.map(m => m.recording).filter(Boolean));
  for (const r of recs) {
    const offs = recordingOffsets(doc, r), ms = doc.media.filter(m => m.recording === r && !m.hidden);
    const pics = ms.filter(m => m.kind === 'video'), snds = ms.filter(m => m.kind === 'audio' && m.role === 'mic');
    const pairs = [];
    for (const pm of pics) for (const sm of snds) pairs.push([pm, sm, false]);
    if (both) for (const pm of pics) for (const sm of snds) pairs.push([sm, pm, true]);
    for (const [from, want] of pairs) {
      if (!offs.has(from.id) || !offs.has(want.id)) continue;
      const have = doc.clips.filter(c => c.media === want.id && !c.reversed).map(c => { const a = (c.in || 0) + offs.get(want.id); return [a, a + c.duration * speed(c), c]; });
      for (const c of doc.clips) {
        if (c.media !== from.id || c.reversed || c.disabled || (c.speed && c.speed !== 1)) continue;
        const a0 = (c.in || 0) + offs.get(from.id), a1 = a0 + c.duration;
        // the parts of [a0, a1] (recording time) no clip of `want` plays
        let t = a0;
        const holes = [];
        for (const [x, y] of have.filter(([x, y]) => y > a0 && x < a1).sort((p, q) => p[0] - q[0])) { if (x > t) holes.push([t, x]); t = Math.max(t, y); }
        if (t < a1) holes.push([t, a1]);
        for (const [h0, h1] of holes) {
          const inn = h0 - offs.get(want.id);
          if (h1 - h0 < min || inn < 0 || (want.duration && inn >= want.duration)) continue;
          const dur = Math.min(h1 - h0, (want.duration || Infinity) - inn);
          out.push({ media: want.id, start: c.start + (h0 - a0), in: inn, duration: dur, beside: have[0]?.[2] || null, from: c });
        }
      }
    }
  }
  return out;
}
