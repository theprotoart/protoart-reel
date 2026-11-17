// What a sound is (dialogue, music or sound effects), set on it in the media bin before it's used, so it goes on a
// track of its own kind when it's dragged onto the timeline: never onto a track marked for something else. Pure
// functions on the project, tested in Node.
import { isFree, addTrack } from '../model.js';
import { ROLES } from './automix.js';

const NAMES = { dialogue: 'Dialogue', music: 'Music', effects: 'Sound FX' };

/** A sound's kind: the one set on it, else what Reel can tell (a mic recording is dialogue, its own effects are effects). */
export function soundRoleOf(m) {
  if (!m || !(m.kind === 'audio' || m.audioOnly)) return null;
  if (m.soundRole && ROLES[m.soundRole]) return m.soundRole;
  if (m.soundRole === '') return null; // set to none by hand: no guessing
  if (m.role === 'mic') return 'dialogue';
  if (m.sfx || m.bleepTone) return 'effects';
  return null;
}

/**
 * The track for a sound of this kind from start for dur s (inside a commit): the one it was dropped on when that's
 * free and not marked for something else; else a free track marked for this kind; else a new one, named for it and
 * marked, at the bottom. Returns { track: id, moved: true when it didn't go where it was dropped }.
 */
export function trackForRole(doc, role, start, dur, wanted = null) {
  const t = wanted && doc.tracks.find(x => x.id === wanted);
  if (t && (!t.role || t.role === role) && isFree(doc, t.id, start, dur)) return { track: t.id, moved: false };
  const same = doc.tracks.find(x => x.role === role && isFree(doc, x.id, start, dur));
  if (same) return { track: same.id, moved: !!wanted };
  const fresh = addTrack(doc, doc.tracks.length);
  const n = doc.tracks.filter(x => x.role === role).length;
  fresh.name = n ? `${NAMES[role]} ${n + 1}` : NAMES[role];
  fresh.role = role;
  return { track: fresh.id, moved: !!wanted };
}
