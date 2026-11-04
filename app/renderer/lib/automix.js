// AUTO MIX: sets the levels of dialogue, music and sound effects against each other, the way a mixer would.
// Each sound track carries a role, shown as a colour (blue dialogue, orange music, green effects); any number of
// tracks can share a role. AUTO MIX measures every clip's loudness (ITU-R BS.1770, the same meter the export
// uses), turns each clip up or down to its role's level for the chosen style, dips music under dialogue with
// smooth fades, and evens out dialogue with Auto Level. "Tidy tracks" moves clips from plain tracks of the same
// role onto one track, to save room. Pure functions here; the panel is in ../automix.js.

export const ROLES = {
  dialogue: { label: 'DIALOGUE', short: 'DIALOGUE', color: '#3d8bfd', hint: 'Speech: voice-overs, interviews, mic recordings' },
  music: { label: 'MUSIC', short: 'MUSIC', color: '#ff8a1f', hint: 'Songs and music beds' },
  effects: { label: 'SOUND FX', short: 'SFX', color: '#2fbf71', hint: 'Whooshes, hits, clicks, ambience' },
};
export const ROLE_ORDER = ['dialogue', 'music', 'effects'];
/** The next role when the role button is clicked: none → dialogue → music → effects → none. */
export const nextRole = r => ({ undefined: 'dialogue', null: 'dialogue', '': 'dialogue', dialogue: 'music', music: 'effects', effects: null })[r ?? ''] ?? null;

/**
 * Styles: loudness each role is set to (LUFS, before the export's own loudness step), and how far music dips under
 * dialogue. Only the gaps between roles matter: the export brings the whole mix to its loudness target afterwards.
 */
export const STYLES = {
  podcast: { label: 'PODCAST', hint: 'Voices clearly on top; music a soft bed', dialogue: -16, music: -31, effects: -24, duck: 0.55 },
  youtube: { label: 'YOUTUBE', hint: 'Balanced: clear voices, music you notice', dialogue: -16, music: -26, effects: -21, duck: 0.45 },
  cinematic: { label: 'CINEMATIC', hint: 'Bigger music and effects; voices still clear', dialogue: -17, music: -22, effects: -18, duck: 0.3 },
};

const hasSound = (doc, c) => {
  if (c.type !== 'media' || c.disabled) return false;
  const m = doc.media.find(x => x.id === c.media);
  return !!m && (m.kind === 'audio' || m.hasAudio) && !c.audio?.mute;
};
const isPicture = (doc, c) => {
  if (c.type !== 'media') return c.type !== 'audio';
  const m = doc.media.find(x => x.id === c.media);
  return !!m && m.kind !== 'audio' && !c.audioOnly;
};
/** Tracks with sound on them (the ones that can have a role). */
export const soundTracks = doc => doc.tracks.filter(t => doc.clips.some(c => c.track === t.id && hasSound(doc, c)));

/**
 * A guess at a track's role, from its name and what's on it. Returns { role, why }.
 * The user's own choice (track.role) always wins; this only fills in tracks nobody has labelled.
 */
export function guessRole(doc, tr) {
  const name = (tr.name || '').toLowerCase();
  const clips = doc.clips.filter(c => c.track === tr.id && hasSound(doc, c));
  if (!clips.length) return { role: null, why: 'no sound' };
  if (/voice|dialog|vo\b|mic|narrat|interview|host|speech|talk/.test(name)) return { role: 'dialogue', why: 'its name' };
  if (/music|song|beat|bgm|score|bed\b|background/.test(name)) return { role: 'music', why: 'its name' };
  if (/sfx|sound ?fx|effect|whoosh|foley|hit|ambien/.test(name)) return { role: 'effects', why: 'its name' };
  const media = clips.map(c => doc.media.find(m => m.id === c.media)).filter(Boolean);
  if (clips.some(c => c.audio?.voice) || media.some(m => m.role === 'mic' || m.role === 'tts' || /^(rec-.*-mic|voice|vo[-_ ])/i.test(m.file || ''))) return { role: 'dialogue', why: 'microphone recordings' };
  if (media.some(m => /music|song|beat|track\d|instrumental|lofi|\.mp3$|\.m4a$/i.test(`${m.name || ''} ${m.file || ''}`))) return { role: 'music', why: 'music files' };
  const avg = clips.reduce((a, c) => a + c.duration, 0) / clips.length;
  if (avg < 4) return { role: 'effects', why: 'short sounds' };
  if (clips.some(c => isPicture(doc, c))) return { role: 'dialogue', why: 'video with its sound' };
  const longest = Math.max(...media.map(m => m.duration || 0));
  if (longest > 45) return { role: 'music', why: 'long sound files' };
  return { role: null, why: 'not sure' };
}
/** Role of a track: the user's label, else nothing (AUTO MIX shows its guesses for the user to confirm). */
export const roleOf = tr => (tr && ROLES[tr.role] ? tr.role : null);

// ------------------------------------------------------------------ loudness

/**
 * Loudness (LUFS) of a clip's sound from a file's loudness profile: `steps` are K-weighted mean squares per
 * 100 ms of the file (from levels-worker.js). The clip covers file time in .. in + duration × speed.
 * Gated like BS.1770 (−70 LUFS absolute, −10 LU relative), so pauses don't drag the number down.
 */
export function clipLoudness(profile, c) {
  if (!profile || !profile.steps?.length) return null;
  const step = profile.step || 0.1, sp = c.speed || 1;
  const a = Math.max(0, Math.floor((c.in || 0) / step)), b = Math.min(profile.steps.length, Math.ceil(((c.in || 0) + c.duration * sp) / step));
  return gatedLufs(profile.steps, a, b);
}
export function gatedLufs(steps, a = 0, b = steps.length) {
  const lufs = z => -0.691 + 10 * Math.log10(z + 1e-12);
  const blocks = [];
  for (let i = a; i + 4 <= b; i++) blocks.push((steps[i] + steps[i + 1] + steps[i + 2] + steps[i + 3]) / 4);
  if (!blocks.length && b > a) { let s = 0; for (let i = a; i < b; i++) s += steps[i]; blocks.push(s / (b - a)); }
  const abs = blocks.filter(z => lufs(z) > -70);
  if (!abs.length) return null; // silence
  const rel = lufs(abs.reduce((x, y) => x + y, 0) / abs.length) - 10;
  const g = abs.filter(z => lufs(z) > rel);
  return lufs(g.reduce((x, y) => x + y, 0) / g.length);
}

// ------------------------------------------------------------------ the plan

const dbToGain = db => 10 ** (db / 20);
const gainToDb = g => (g <= 0 ? -Infinity : 20 * Math.log10(g));

/**
 * Works out the new levels. roles: { trackId: role }. loud(c) → the clip's measured LUFS at volume 1, or null.
 * Returns { clips: [{ id, volume, fromDb, toDb, role }], tracks: [{ id, role, duck, level }], skipped }.
 * Track volume and the clip's current volume are both taken into account, so the result is what you hear.
 */
export function planMix(doc, roles, loud, { style = 'youtube', music = 0, effects = 0, duck = true, even = true, clean = [] } = {}) {
  const S = STYLES[style] || STYLES.youtube;
  const target = { dialogue: S.dialogue, music: S.music + music, effects: S.effects + effects };
  const out = { clips: [], tracks: [], skipped: 0 };
  for (const tr of doc.tracks) {
    const role = roles[tr.id];
    if (!ROLES[role]) continue;
    const trDb = gainToDb(tr.volume ?? 1);
    for (const c of doc.clips.filter(x => x.track === tr.id && hasSound(doc, x))) {
      const L = loud(c);
      if (L == null || !Number.isFinite(L)) { out.skipped++; continue; }
      // what the clip plays at now = L + clip volume + track volume; set the clip volume so it lands on target
      let db = target[role] - L - (Number.isFinite(trDb) ? trDb : 0);
      db = Math.max(-60, Math.min(18, db)); // low enough for "−30 dB" on a loud song
      const fromDb = gainToDb(c.audio?.volume ?? 1);
      out.clips.push({ id: c.id, role, volume: Number(dbToGain(db).toFixed(4)), fromDb, toDb: db });
    }
    out.tracks.push({ id: tr.id, role, duck: role === 'music' && duck ? S.duck : 0, level: role === 'dialogue' && even, clean: role === 'dialogue' ? CLEAN.filter(k => clean.includes(k)) : [] });
  }
  return out;
}

/** Puts a plan into the document (call inside a commit). */
const ROLE_NAME = { dialogue: 'Dialogue', music: 'Music', effects: 'Sound FX' };
export function applyMix(doc, plan, roles, makeLevel) {
  // remember how things were before the FIRST auto mix (running it again keeps that memory), so
  // "Remove Auto Mix" can put every clip back at its own level and on its own track at any time later
  const mem = doc.autoMix ||= { clips: {}, tracks: {}, removed: [] };
  for (const p of plan.clips) {
    const c = doc.clips.find(x => x.id === p.id);
    if (c && !(c.id in mem.clips)) mem.clips[c.id] = { volume: c.audio?.volume ?? 1, duck: c.audio?.duck || 0, track: c.track };
  }
  for (const id of Object.keys(roles)) {
    const t = doc.tracks.find(x => x.id === id);
    if (t && roles[id] && !(id in mem.tracks)) mem.tracks[id] = { name: t.name, duck: t.duck ?? null, level: (t.fx || []).some(f => f.type === 'level') };
  }
  for (const [id, role] of Object.entries(roles)) { const t = doc.tracks.find(x => x.id === id); if (t) { if (role) t.role = role; else delete t.role; } }
  // tracks still called "Track 3" get their role as a name ("Music", "Music 2"…), so the timeline reads at a glance
  for (const role of ROLE_ORDER) {
    const list = doc.tracks.filter(t => roles[t.id] === role);
    const taken = new Set(doc.tracks.map(t => t.name));
    let k = 0;
    for (const t of list) {
      if (!/^(track|audio|untitled)\s*\d*$/i.test((t.name || '').trim())) continue;
      let name;
      do { k++; name = k === 1 ? ROLE_NAME[role] : `${ROLE_NAME[role]} ${k}`; } while (taken.has(name));
      taken.add(name); t.name = name;
    }
  }
  for (const p of plan.clips) {
    const c = doc.clips.find(x => x.id === p.id); if (!c) continue;
    c.audio = { ...(c.audio || {}), volume: p.volume };
    // ducking now comes from the track (so new clips on a music track duck too)
    if (c.audio.duck && p.role === 'music') c.audio.duck = 0;
  }
  for (const t of plan.tracks) {
    const tr = doc.tracks.find(x => x.id === t.id); if (!tr) continue;
    if (t.duck) tr.duck = t.duck; else delete tr.duck;
    const has = (tr.fx || []).some(f => f.type === 'level');
    if (t.level && !has) { tr.fx = [...(tr.fx || []), { ...makeLevel(), autoMix: true }]; }
    if (t.level && has) for (const f of tr.fx) if (f.type === 'level') f.off = false;
    // dialogue clean-up (de-click, de-ess, gate) goes first in the chain, before the levelling
    const add = (t.clean || []).filter(k => !(tr.fx || []).some(f => f.type === k)).map(k => ({ ...makeLevel(), type: k, params: {}, autoMix: true }));
    if (add.length) tr.fx = [...add, ...(tr.fx || [])];
    for (const f of tr.fx || []) if ((t.clean || []).includes(f.type)) f.off = false;
  }
}
/** Dialogue clean-up AUTO MIX can add, in chain order. */
export const CLEAN = ['declick', 'deess', 'gate'];

// ------------------------------------------------------------------ ducking (used by gainAt)

const ATTACK = 0.25, RELEASE = 0.8;
/** 0..1: how far a music clip should be dipped at timeline time T, with smooth fades around dialogue. */
export function duckWeight(doc, c, T) {
  let w = 0;
  for (const o of doc.clips) {
    if (o === c || o.track === c.track || o.disabled || o.audio?.mute) continue;
    const s = o.start, e = o.start + o.duration;
    if (T < s - ATTACK || T > e + RELEASE) continue;
    if (!(o.audio?.voice || doc.tracks.find(t => t.id === o.track)?.role === 'dialogue')) continue;
    const tr = doc.tracks.find(t => t.id === o.track);
    if (tr?.muted) continue;
    const k = T < s ? 1 - (s - T) / ATTACK : T > e ? 1 - (T - e) / RELEASE : 1;
    const v = k * k * (3 - 2 * k); // smoothstep: no clicks at the edges
    if (v > w) { w = v; if (w >= 1) break; }
  }
  return w;
}

// ------------------------------------------------------------------ tidy tracks

const plain = t => !(t.fx || []).length && (t.volume ?? 1) === 1 && !(t.pan || 0) && !t.muted && !t.solo && !t.locked && !(t.auto && Object.values(t.auto).some(a => a?.length));
const free = (doc, trackId, c, moved) => !doc.clips.some(o => o !== c && o.track === trackId && !moved.has(o.id) && o.start < c.start + c.duration - 1e-3 && o.start + o.duration > c.start + 1e-3)
  && ![...moved.values()].some(m => m.track === trackId && m.c !== c && m.c.start < c.start + c.duration - 1e-3 && m.c.start + m.c.duration > c.start + 1e-3);

/**
 * Moves sound clips from plain tracks (no effects, volume, automation, mute or lock of their own) onto one track
 * per role, keeping every clip at its time. A clip only goes where nothing else plays then; if two play at once,
 * one stays on its own track. Tracks with picture, or with settings of their own, are left as they are.
 * Returns { moves: [{ id, from, to }], removed: [trackIds] } without changing doc; applyTidy does it.
 */
export function planTidy(doc, roles) {
  const moves = new Map(), removed = [];
  for (const role of ROLE_ORDER) {
    const tracks = doc.tracks.filter(t => roles[t.id] === role && plain(t) && !doc.clips.some(c => c.track === t.id && isPicture(doc, c)));
    if (tracks.length < 2) continue;
    // the home track: the one with the most sound on it
    const total = t => doc.clips.filter(c => c.track === t.id).reduce((a, c) => a + c.duration, 0);
    const home = [...tracks].sort((a, b) => total(b) - total(a))[0];
    for (const t of tracks) {
      if (t === home) continue;
      const clips = doc.clips.filter(c => c.track === t.id).sort((a, b) => a.start - b.start);
      let all = true;
      for (const c of clips) {
        if (free(doc, home.id, c, moves)) moves.set(c.id, { c, track: home.id, from: t.id });
        else all = false;
      }
      if (all) removed.push(t.id);
    }
  }
  return { moves: [...moves.values()].map(m => ({ id: m.c.id, from: m.from, to: m.track })), removed };
}
export function applyTidy(doc, tidy) {
  const mem = doc.autoMix ||= { clips: {}, tracks: {}, removed: [] };
  for (const m of tidy.moves) {
    const c = doc.clips.find(x => x.id === m.id); if (!c) continue;
    if (!(c.id in mem.clips)) mem.clips[c.id] = { volume: c.audio?.volume ?? 1, duck: c.audio?.duck || 0, track: m.from };
    c.track = m.to;
  }
  doc.tracks.forEach((t, index) => { if (tidy.removed.includes(t.id) && !doc.clips.some(c => c.track === t.id)) mem.removed.push({ index, track: JSON.parse(JSON.stringify(t)) }); });
  doc.tracks = doc.tracks.filter(t => !tidy.removed.includes(t.id) || doc.clips.some(c => c.track === t.id));
}

/**
 * Takes the auto mix off: every clip back at the level and on the track it had before the first AUTO MIX,
 * tidied-away tracks back in place, track names, the music dip and the Auto Level it added undone. Track
 * colours stay (they're your labels). Returns how many clips it restored, or 0 if there was no auto mix.
 */
export function removeMix(doc) {
  const mem = doc.autoMix; if (!mem) return 0;
  for (const r of [...(mem.removed || [])].sort((a, b) => a.index - b.index)) {
    if (!doc.tracks.some(t => t.id === r.track.id)) doc.tracks.splice(Math.min(r.index, doc.tracks.length), 0, r.track);
  }
  let n = 0;
  for (const [id, was] of Object.entries(mem.clips || {})) {
    const c = doc.clips.find(x => x.id === id); if (!c) continue;
    c.audio = { ...(c.audio || {}), volume: was.volume, duck: was.duck };
    if (doc.tracks.some(t => t.id === was.track)) c.track = was.track;
    n++;
  }
  for (const [id, was] of Object.entries(mem.tracks || {})) {
    const t = doc.tracks.find(x => x.id === id); if (!t) continue;
    t.name = was.name;
    if (was.duck == null) delete t.duck; else t.duck = was.duck;
    if (!was.level && t.fx) t.fx = t.fx.filter(f => !(f.type === 'level' && f.autoMix));
    if (t.fx) t.fx = t.fx.filter(f => !(f.autoMix && CLEAN.includes(f.type))); // the clean-up it added
  }
  delete doc.autoMix;
  return n || 1;
}
