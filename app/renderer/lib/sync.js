// Picture and sound from one recording, kept in sync. Every clip from a recording plays a stretch of that recording's
// own clock: at timeline time t, clip c plays recording time  c.in + (t - c.start) * speed + off(media), where off is
// when that file started in the recording (the screen, mic and camera files start a few hundredths apart).
// New recordings store off on each media (syncOff). For older ones it's worked out from the clips themselves: most
// pairs are still in sync, so the offset most of the overlapping time agrees on is the true one.
// No DOM here, so it's tested in Node.

const EPS = 0.02; // a frame at 50 fps: closer than this is in sync

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
    if (!votes.length) continue; // nothing to tell from: leave it out (it can't be checked)
    let best = votes[0], bestW = -1;
    for (const a of votes) { const w = votes.reduce((k, b) => k + (Math.abs(b.v - a.v) <= EPS ? b.w : 0), 0); if (w > bestW) { bestW = w; best = a; } }
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
    if (Math.abs(shift) > Math.max(30, c.duration)) continue;
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
 * clips to fix (a picture fixes its sound), or all. Returns how many moved; a clip that would land on another on its
 * track goes to a free sound track, or stays put (counted in `blocked`).
 */
export function resync(doc, ids = null, isFree = () => true) {
  let list = outOfSync(doc);
  if (ids) {
    const want = new Set(ids);
    list = list.filter(x => want.has(x.clip.id) || want.has(x.pic.id));
  }
  let moved = 0, blocked = 0;
  for (const { clip: c, shift } of list) {
    const to = Math.max(0, c.start + shift);
    if (isFree(doc, c.track, to, c.duration, [c.id])) { c.start = to; moved++; continue; }
    const other = doc.tracks.find(t => t.id !== c.track && doc.clips.some(o => o.track === t.id && isSound(doc, o)) && isFree(doc, t.id, to, c.duration, [c.id]));
    if (other) { c.track = other.id; c.start = to; moved++; } else blocked++;
  }
  return { moved, blocked };
}
