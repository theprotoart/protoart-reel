// Bounce in place (render effects to a new track), like a DAW's "Bounce in Place" / "Render in Place".
// The chosen sound clips are mixed, through everything that shapes them before the fader (the clip's own volume,
// fades, crossfades, pan, speed and effects, then the track's effects and plug-ins), into one new WAV per track.
// That WAV goes on a new track right under the original, cut into clips at exactly the original clips' times.
// The originals stay where they are, muted and greyed out, and can be switched back on at any time.
//
// The new track keeps the original's fader, pan and automation (those stay live), so the mix sounds the same.

const hasSound = (doc, c) => {
  if (c.type !== 'media' || c.disabled) return false;
  const m = (doc.media || []).find(x => x.id === c.media);
  return !!m && (m.kind === 'audio' || m.hasAudio);
};

/** The clips to bounce, per track: [{ track, clips, from, to }]. Clips already bounced are left out. */
export function planBounce(doc, clipIds) {
  const want = new Set(clipIds);
  const byTrack = new Map();
  for (const c of doc.clips) {
    if (!want.has(c.id) || !hasSound(doc, c) || c.bounced || c.audio?.mute) continue;
    const tr = doc.tracks.find(t => t.id === c.track);
    if (!tr) continue;
    if (!byTrack.has(tr.id)) byTrack.set(tr.id, { track: tr, clips: [] });
    byTrack.get(tr.id).clips.push(c);
  }
  return [...byTrack.values()].map(g => {
    g.clips.sort((a, b) => a.start - b.start);
    // crossfade handles reach past a clip's edges
    g.from = Math.max(0, Math.min(...g.clips.map(c => c.start - (c.xfadeIn || 0) / 2)));
    g.to = Math.max(...g.clips.map(c => c.start + c.duration + (c.xfadeOut || 0) / 2));
    return g;
  });
}

/**
 * The little project the export engine mixes for one track: only those clips, on a copy of the track whose
 * fader, pan, automation, mute and solo are neutral (they stay live on the new track) and whose plug-ins are
 * already in the clips' rendered files (so only its built-in effects run here).
 */
export function bounceDoc(doc, g) {
  const tr = g.track;
  const track = { id: tr.id, name: tr.name, fx: (tr.fx || []).filter(f => f.type !== 'au' && !f.off) };
  const ids = new Set(g.clips.map(c => c.id));
  const clips = doc.clips.filter(c => ids.has(c.id)).map(c => {
    const x = JSON.parse(JSON.stringify(c));
    delete x.cursor; delete x.keystrokes; delete x.group; // no click sounds from recorded clicks
    x.audio = { ...(x.audio || {}) };
    delete x.audio.duck; // ducking needs the dialogue on other tracks: it stays live on the new clips
    return x;
  });
  const used = new Set(clips.map(c => c.media));
  return { ...JSON.parse(JSON.stringify({ canvas: doc.canvas, name: doc.name })), media: (doc.media || []).filter(m => used.has(m.id)), tracks: [track], clips, markers: [], captions: [] };
}

/**
 * Puts a finished bounce in the project: the new media, a new track right under the original (or the one made by
 * an earlier bounce of that track, when the new clips fit on it), one clip per original at the same time and
 * length, and the originals muted and marked. file / seconds: the WAV that covers [g.from, g.to].
 * makeId(prefix) gives new ids. Returns { trackId, clipIds }.
 */
export function applyBounce(doc, g, { file, name, seconds }, makeId) {
  const tr = doc.tracks.find(t => t.id === g.track.id);
  const mediaId = makeId('m');
  doc.media.push({ id: mediaId, file, name, kind: 'audio', duration: seconds, hasAudio: true, bounceOf: tr.id });
  // the track for the rendered sound: reuse the earlier one when nothing overlaps there
  const fits = t => !doc.clips.some(c => c.track === t.id && g.clips.some(o => c.start < o.start + o.duration && c.start + c.duration > o.start));
  let nt = doc.tracks.find(t => t.bounceOf === tr.id && fits(t));
  if (!nt) {
    nt = {
      id: makeId('t'), name: `${tr.name || 'Track'} · rendered`, bounceOf: tr.id,
      volume: tr.volume ?? 1, pan: tr.pan || 0,
      ...(tr.auto ? { auto: JSON.parse(JSON.stringify(tr.auto)) } : {}),
      ...(tr.role ? { role: tr.role } : {}), ...(tr.duck ? { duck: tr.duck } : {}),
    };
    doc.tracks.splice(doc.tracks.indexOf(tr) + 1, 0, nt);
  }
  const clipIds = [];
  for (const o of g.clips) {
    const c = doc.clips.find(x => x.id === o.id); if (!c) continue;
    const id = makeId('c');
    const a = c.audio || {};
    doc.clips.push({
      id, type: 'media', media: mediaId, track: nt.id, start: c.start, duration: c.duration,
      in: c.start - g.from, speed: 1, name: `${c.name || (doc.media.find(m => m.id === c.media) || {}).name || 'Clip'} (rendered)`,
      // volume, fades, crossfades, pan and effects are in the file; only the dip under dialogue stays live
      audio: { volume: 1, ...(a.duck ? { duck: a.duck } : {}) },
      bounceOf: c.id,
      ...(c.label ? { label: c.label } : {}),
    });
    clipIds.push(id);
    c.bounced = { to: id, wasMuted: !!a.mute };
    c.audio = { ...a, mute: true };
  }
  return { trackId: nt.id, clipIds };
}

/**
 * Back to the original sound for these clips (originals or rendered ones): the rendered clips go, the originals
 * play again, and a rendered track or media entry left empty goes too (the WAV stays in the project folder).
 * Returns how many originals came back.
 */
export function revertBounce(doc, clipIds) {
  const ids = new Set(clipIds);
  const originals = doc.clips.filter(c => c.bounced && (ids.has(c.id) || ids.has(c.bounced.to)));
  const gone = new Set(originals.map(c => c.bounced.to));
  // a rendered clip whose original was deleted can still be removed on its own
  for (const c of doc.clips) if (ids.has(c.id) && c.bounceOf) gone.add(c.id);
  for (const c of originals) { c.audio = { ...(c.audio || {}), mute: c.bounced.wasMuted || undefined }; if (!c.audio.mute) delete c.audio.mute; delete c.bounced; }
  doc.clips = doc.clips.filter(c => !gone.has(c.id));
  doc.tracks = doc.tracks.filter(t => !t.bounceOf || doc.clips.some(c => c.track === t.id));
  doc.media = doc.media.filter(m => !m.bounceOf || doc.clips.some(c => c.media === m.id));
  return originals.length;
}
