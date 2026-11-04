// Says in a few words what changed between two versions of a project, for "Undo: moved 2 clips" and the Edit
// menu's "Undo Move 2 Clips". Undo keeps whole snapshots, so instead of labelling every action, the two
// snapshots are compared when needed. describeChange(older, newer) → e.g. "moved 2 clips", or 'change'.

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b) => Math.abs((a || 0) - (b || 0)) < 1e-6;

/** What turned `a` into `b`, in a short phrase (lower case, no full stop). */
export function describeChange(a, b) {
  if (!a || !b) return 'change';
  // whole-project features first: they touch many clips at once
  if (!!a.autoMix !== !!b.autoMix) return b.autoMix ? 'Auto Mix' : 'Remove Auto Mix';
  const A = new Map((a.clips || []).map(c => [c.id, c])), B = new Map((b.clips || []).map(c => [c.id, c]));
  const added = [...B.keys()].filter(id => !A.has(id)), removed = [...A.keys()].filter(id => !B.has(id));
  const out = [];
  // splits: some clips got shorter and new pieces of the same media appeared
  const shortened = [...A].filter(([id, o]) => B.has(id) && B.get(id).duration < o.duration - 1e-6);
  const split = added.length > 0 && !removed.length && shortened.length > 0 && added.every(id => shortened.some(([, o]) => o.type === B.get(id).type && (o.media || null) === (B.get(id).media || null)));
  if (split) out.push(added.length === 1 ? 'split a clip' : `split ${plural(added.length + shortened.length - added.length, 'clip')}`);
  else if (added.length) out.push(`add ${plural(added.length, 'clip')}`);
  if (removed.length) out.push(`delete ${plural(removed.length, 'clip')}`);
  // changes to clips that are in both
  const kinds = { move: 0, trim: 0, volume: 0, speed: 0, transition: 0, effects: 0, look: 0, text: 0, fade: 0, keys: 0, zoom: 0, other: 0 };
  for (const [id, x] of A) {
    const y = B.get(id); if (!y || same(x, y)) continue;
    if (split && shortened.some(([sid]) => sid === id)) continue; // part of the split
    if (!near(x.start, y.start) || x.track !== y.track) {
      if (near(x.duration, y.duration)) { kinds.move++; continue; }
    }
    if (!near(x.duration, y.duration) || !near(x.in, y.in)) { (x.speed || 1) !== (y.speed || 1) ? kinds.speed++ : kinds.trim++; continue; }
    if ((x.speed || 1) !== (y.speed || 1) || !!x.reversed !== !!y.reversed) { kinds.speed++; continue; }
    const xa = x.audio || {}, ya = y.audio || {};
    if (!near(xa.volume ?? 1, ya.volume ?? 1) || !!xa.mute !== !!ya.mute || !near(xa.pan, ya.pan)) { kinds.volume++; continue; }
    if (!near(xa.fadeIn, ya.fadeIn) || !near(xa.fadeOut, ya.fadeOut)) { kinds.fade++; continue; }
    if (!same(x.transIn, y.transIn) || !same(x.transOut, y.transOut) || !near(x.xfadeIn, y.xfadeIn) || !near(x.xfadeOut, y.xfadeOut)) { kinds.transition++; continue; }
    if (!same(x.fx, y.fx) || !same(x.filters, y.filters) || !same(x.spectral, y.spectral)) { kinds.effects++; continue; }
    if (!same(x.actions, y.actions)) { kinds.zoom++; continue; }
    if (!same(x.keys, y.keys)) { kinds.keys++; continue; }
    if (!same(x.text, y.text) || !same(x.callout, y.callout)) { kinds.text++; continue; }
    if (!same(x.props, y.props)) { kinds.look++; continue; }
    kinds.other++;
  }
  const words = { move: ['move', 'clip'], trim: ['trim', 'clip'], volume: ['change the volume of', 'clip'], speed: ['change the speed of', 'clip'],
    transition: ['change the transition on', 'clip'], effects: ['change the effects on', 'clip'], look: ['change the position or size of', 'clip'],
    text: ['edit the text of', 'clip'], fade: ['change the fades on', 'clip'], keys: ['change the keyframes on', 'clip'], zoom: ['change the zooms on', 'clip'], other: ['change', 'clip'] };
  for (const [k, n] of Object.entries(kinds)) if (n) out.push(`${words[k][0]} ${plural(n, words[k][1])}`);
  // tracks
  const TA = new Map((a.tracks || []).map(t => [t.id, t])), TB = new Map((b.tracks || []).map(t => [t.id, t]));
  const tAdd = [...TB.keys()].filter(id => !TA.has(id)).length, tDel = [...TA.keys()].filter(id => !TB.has(id)).length;
  if (tAdd) out.push(`add ${plural(tAdd, 'track')}`);
  if (tDel) out.push(`delete ${plural(tDel, 'track')}`);
  if (!tAdd && !tDel && !same([...TA.keys()], [...TB.keys()])) out.push('reorder the tracks');
  for (const [id, x] of TA) {
    const y = TB.get(id); if (!y || same(x, y)) continue;
    const name = `“${y.name || 'track'}”`;
    if (x.name !== y.name) out.push(`rename a track to ${name}`);
    else if (x.role !== y.role) out.push(`label ${name} ${y.role ? ({ dialogue: 'Dialogue', music: 'Music', effects: 'Sound FX' })[y.role] : '(no label)'}`);
    else if (!!x.muted !== !!y.muted) out.push(`${y.muted ? 'mute' : 'unmute'} ${name}`);
    else if (!!x.solo !== !!y.solo) out.push(`${y.solo ? 'solo' : 'unsolo'} ${name}`);
    else if (!!x.locked !== !!y.locked) out.push(`${y.locked ? 'lock' : 'unlock'} ${name}`);
    else if (!!x.hidden !== !!y.hidden) out.push(`${y.hidden ? 'hide' : 'show'} ${name}`);
    else if (!same(x.fx, y.fx)) out.push(`change the effects on ${name}`);
    else if (!near(x.volume ?? 1, y.volume ?? 1) || !near(x.pan, y.pan) || !same(x.auto, y.auto)) out.push(`change the level of ${name}`);
  }
  // everything else in the project
  if (!same(a.captions, b.captions)) { const n = (b.captions || []).length - (a.captions || []).length; out.push(n > 0 ? `add ${plural(n, 'caption')}` : n < 0 ? `delete ${plural(-n, 'caption')}` : 'edit captions'); }
  if (!same(a.markers, b.markers)) out.push('change markers');
  if (!same(a.sections, b.sections)) out.push('change the parts');
  if (!same(a.canvas, b.canvas)) out.push('change the canvas');
  if (!same(a.mixFx, b.mixFx) || !same(a.master, b.master)) out.push('change the mix bus');
  if (!same(a.captionStyle, b.captionStyle)) out.push('change the caption look');
  if (!same(a.media, b.media) && !out.length) out.push('change the media');
  if (!out.length) return 'change';
  return out.length > 2 ? `${out[0]}, ${out[1]} and more` : out.join(' and ');
}

/** "move 2 clips" → "Move 2 Clips" for the Edit menu (short words stay small). */
export function menuCase(s) {
  const small = new Set(['a', 'an', 'and', 'the', 'of', 'on', 'to', 'or', 'in']);
  return s.replace(/[“”]/g, '"').split(' ').map((w, i) => (i && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}
