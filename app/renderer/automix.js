// AUTO MIX and track roles. Every sound track gets a colour-coded role button: blue DIALOGUE, orange MUSIC, green
// SOUND FX (click to go round them; several tracks can share one). AUTO MIX reads those colours, measures every
// clip, and sets dialogue, music and effects against each other (see lib/automix.js). Preview first, then keep or
// discard; everything it sets is ordinary clip volume, track ducking and Auto Level, so it can be changed by hand.
import { el, modal, toast } from './ui.js';
import { uid, mediaById } from './model.js';
import { ROLES, ROLE_ORDER, STYLES, nextRole, roleOf, guessRole, soundTracks, clipLoudness, planMix, applyMix, planTidy, applyTidy, removeMix } from './lib/automix.js';

// ------------------------------------------------------------------ the role button
/** The colour-coded role button for a track header or mixer strip. Click: none → dialogue → music → sfx → none. */
export function roleButton(app, tr, { compact = false, dot = false } = {}) {
  const b = el('button', { type: 'button', 'data-track': tr.id, 'data-compact': dot ? 'dot' : compact ? '1' : '' });
  drawTag(b, roleOf(tr));
  b.addEventListener('click', e => { e.stopPropagation(); setRole(app, tr, nextRole(roleOf(tr))); });
  b.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); roleMenu(app, tr, e.clientX, e.clientY); });
  b.addEventListener('pointerdown', e => e.stopPropagation()); // not a track drag
  return b;
}
export function roleMenu(app, tr, x, y) {
  import('./ui.js').then(({ popMenu }) => popMenu(x, y, [
    ...ROLE_ORDER.map(r => [`${roleOf(tr) === r ? '✓ ' : ''}${ROLES[r].label} (${r === 'dialogue' ? 'blue' : r === 'music' ? 'orange' : 'green'})`, () => setRole(app, tr, r)]),
    [`${roleOf(tr) ? '' : '✓ '}No label`, () => setRole(app, tr, null)],
  ]));
}
export function roleMenuItems(app, tr) {
  return ROLE_ORDER.map(r => [`${roleOf(tr) === r ? '✓ ' : ''}Label: ${ROLES[r].label}`, () => setRole(app, tr, r)]);
}
const DOT = { dialogue: 'D', music: 'M', effects: 'FX' };
function drawTag(b, r) {
  const kind = b.dataset.compact; // '' full · '1' mixer · 'dot' timeline header
  b.className = 'role-tag' + (r ? ' ' + r : ' none') + (kind === '1' ? ' compact' : kind === 'dot' ? ' dot' : '');
  b.textContent = r ? (kind === 'dot' ? DOT[r] : kind === '1' ? ROLES[r].short : ROLES[r].label) : (kind === 'dot' ? '+' : '+ LABEL');
  b.title = `${r ? `${ROLES[r].label}: ${ROLES[r].hint}.` : 'What’s on this track? Label it so AUTO MIX can balance it.'} Click to change: blue DIALOGUE → orange MUSIC → green SOUND FX → none. Right-click for the list.`;
  b.style.setProperty('--role', r ? ROLES[r].color : '#8a8478');
}
export function setRole(app, tr, role) {
  app.commit(d => { const t = d.tracks.find(x => x.id === tr.id); if (!t) return; if (role) t.role = role; else delete t.role; }, { keepInspector: true });
  // update every tag and tint for this track at once (the mixer doesn't redraw for a label)
  const t = app.doc?.tracks.find(x => x.id === tr.id);
  for (const b of document.querySelectorAll(`.role-tag[data-track="${CSS.escape(tr.id)}"]`)) {
    drawTag(b, roleOf(t));
    const host = b.closest('.cs-strip, .tl-head');
    if (host && t) tint(host, t);
  }
}
/** A track header or strip tinted with its role colour. */
export function tint(node, tr) {
  const r = roleOf(tr);
  node.classList.toggle('has-role', !!r);
  if (r) node.style.setProperty('--role', ROLES[r].color); else node.style.removeProperty('--role');
}

// ------------------------------------------------------------------ the nudge to label
let nudged = '';
/** Once per project: when there are two or more sound tracks and some have no colour, say so and light their buttons. */
export function labelNudge(app, { force = false } = {}) {
  const doc = app.doc; if (!doc) return false;
  const sound = soundTracks(doc), unl = sound.filter(t => !roleOf(t));
  if (sound.length < 2 || !unl.length) return false;
  if (!force && nudged === app.token) return false;
  nudged = app.token;
  toast(`Label your sound tracks so AUTO MIX can balance them: click the tag on each track for blue DIALOGUE, orange MUSIC or green SOUND FX (${unl.length} of ${sound.length} not labelled yet).`, 9000);
  document.body.classList.add('role-nudge');
  setTimeout(() => document.body.classList.remove('role-nudge'), 9000);
  return true;
}

// ------------------------------------------------------------------ measuring
const profiles = new Map();
let worker = null, seq = 1;
const waiting = new Map();
function levelsWorker() {
  if (!worker) {
    worker = new Worker('levels-worker.js', { type: 'module' });
    worker.onmessage = e => { const w = waiting.get(e.data.id); waiting.delete(e.data.id); if (w) w(e.data.profile || null); };
  }
  return worker;
}
function profileFor(app, file) {
  const key = app.token + '/' + file;
  if (!profiles.has(key)) {
    profiles.set(key, new Promise(resolve => {
      const id = seq++;
      waiting.set(id, resolve);
      levelsWorker().postMessage({ id, url: `app://reel/m/${app.token}/${encodeURIComponent(file)}`, file });
    }));
  }
  return profiles.get(key);
}
/** The file a clip's sound plays from: its rendered effects if it has them (same timing as the source). */
const soundFile = (doc, c) => (c.fx && c.fx.file && !c.fx.bypass ? c.fx.file : mediaById(doc, c.media)?.file);

// ------------------------------------------------------------------ the panel
const KEY = 'reel.automix';
const saved = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
const save = o => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* fine */ } };

export function openAutoMix(app) {
  const doc = app.doc; if (!doc) return;
  const sound = soundTracks(doc);
  if (!sound.length) { toast('There’s no sound on the timeline yet: add a recording, a voice-over or music first.', 5000); return; }
  const o = { style: 'youtube', music: 0, effects: 0, duck: true, even: true, tidy: true, clean: ['declick'], ...saved() };
  if (!Array.isArray(o.clean)) o.clean = ['declick'];
  // roles: the user's labels, else a guess (marked so they can see it was guessed)
  const roles = {}, guessed = {};
  for (const t of sound) { const r = roleOf(t); if (r) roles[t.id] = r; else { const g = guessRole(doc, t); roles[t.id] = g.role; guessed[t.id] = g.why; } }

  const rows = el('div', { class: 'am-rows' });
  const drawRows = () => {
    rows.replaceChildren(...sound.map(t => {
      const n = doc.clips.filter(c => c.track === t.id).length;
      const seg = el('div', { class: 'seg am-roles' }, ...[...ROLE_ORDER, null].map(r => {
        const b = el('button', { type: 'button', class: 'am-role ' + (r || 'none') + (roles[t.id] === r ? ' on' : ''), text: r ? ROLES[r].label : 'LEAVE ALONE', title: r ? ROLES[r].hint : 'AUTO MIX doesn’t touch this track' });
        if (r) b.style.setProperty('--role', ROLES[r].color);
        b.addEventListener('click', () => { roles[t.id] = r; delete guessed[t.id]; drawRows(); });
        return b;
      }));
      const r = roles[t.id];
      const row = el('div', { class: 'am-row' + (r ? ' ' + r : '') },
        el('i', { class: 'am-dot' }),
        el('span', { class: 'am-name' }, el('b', { text: t.name || 'Track' }), el('small', { text: `${n} clip${n === 1 ? '' : 's'}${guessed[t.id] ? ` · guessed from ${guessed[t.id]}` : ''}` })),
        seg);
      if (r) row.style.setProperty('--role', ROLES[r].color);
      return row;
    }));
    const unl = sound.filter(t => !roles[t.id]).length;
    warn.textContent = unl ? `${unl} track${unl === 1 ? ' has' : 's have'} no colour and will be left as ${unl === 1 ? 'it is' : 'they are'}.` : '';
  };
  const warn = el('p', { class: 'note am-warn' });

  const styleSeg = el('div', { class: 'seg am-style' }, ...Object.entries(STYLES).map(([k, s]) => el('button', { type: 'button', class: o.style === k ? 'on' : '', text: s.label, title: s.hint, 'data-k': k })));
  const styleHint = el('span', { class: 'note' });
  const drawStyle = () => { for (const b of styleSeg.children) b.classList.toggle('on', b.dataset.k === o.style); styleHint.textContent = STYLES[o.style].hint; };
  for (const b of styleSeg.children) b.addEventListener('click', () => { o.style = b.dataset.k; drawStyle(); });
  const slider = (key, label) => {
    const val = el('span', { class: 'val' });
    // −30 dB (barely there) to +12 dB
    const s = el('input', { type: 'range', min: -30, max: 12, step: 1, value: o[key] });
    const show = () => { const v = Number(s.value); val.textContent = v === 0 ? 'as the style' : `${v > 0 ? '+' : '−'}${Math.abs(v)} dB ${v > 0 ? 'louder' : 'quieter'}`; };
    const steps = el('div', { class: 'seg am-steps' }, ...[-30, -20, -12, -6, -3, 0, 3, 6].map(v => el('button', { type: 'button', text: v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v)}`, title: v === 0 ? 'As the style' : `${Math.abs(v)} dB ${v > 0 ? 'louder' : 'quieter'}`, onclick: () => { s.value = v; o[key] = v; show(); } })));
    s.addEventListener('input', () => { o[key] = Number(s.value); show(); });
    s.addEventListener('dblclick', () => { s.value = 0; o[key] = 0; show(); });
    show();
    return el('div', { class: 'am-slider' }, el('div', { class: 'row' }, el('label', { text: label }), s, val), el('div', { class: 'row' }, el('label'), steps));
  };
  // dialogue clean-up: tick what the voices need (each goes on the dialogue tracks as an effect you can adjust)
  const cleanRow = () => {
    const opts = [['declick', 'De-click', 'Removes mouth clicks, lip smacks and pops'], ['deess', 'De-ess', 'Softens harsh “s” and “sh” sounds'], ['gate', 'Noise gate', 'Quiets room noise and breaths between sentences']];
    return el('div', { class: 'row am-clean' }, el('label', { text: 'Clean the dialogue' }),
      el('div', { class: 'am-clean-list' }, ...opts.map(([k, name, hint]) => {
        const c = el('input', { type: 'checkbox', checked: o.clean.includes(k) });
        c.addEventListener('change', () => { o.clean = c.checked ? [...new Set([...o.clean, k])] : o.clean.filter(x => x !== k); });
        return el('label', { class: 'am-check', title: hint }, c, el('span', { text: name }), el('small', { class: 'note', text: hint }));
      })));
  };
  const check = (key, label, hint) => { const c = el('input', { type: 'checkbox', checked: !!o[key] }); c.addEventListener('change', () => { o[key] = c.checked; }); return el('label', { class: 'row am-check', title: hint }, c, el('span', { text: label })); };
  const status = el('p', { class: 'note am-status' }), bar = el('div', { class: 'progress' }, el('i'));

  const onBanner = doc.autoMix ? el('div', { class: 'am-on' },
    el('span', { text: '⚖ AUTO MIX is on for this project. Run it again to change the style, or take it off: every clip goes back to its own level and track.' }),
    el('button', { class: 'hw', text: 'REMOVE AUTO MIX', onclick: () => { dlg.close(); removeAutoMix(app); } })) : null;
  const dlg = modal('⚖ AUTO MIX', el('div', { class: 'newdoc am' }, onBanner,
    el('p', { class: 'note', text: 'Sets dialogue, music and sound effects against each other, the way a mixer would: voices clear, music under them (dipping while someone talks), effects heard but not jumping out. You preview it first.' }),
    el('div', { class: 'engr', text: '1 · Label your sound tracks' }),
    el('p', { class: 'note', text: 'Give each sound track its colour: blue DIALOGUE, orange MUSIC, green SOUND FX. Several tracks can share a colour. The same tags are on the tracks and in the mixer.' }),
    rows, warn,
    el('div', { class: 'engr', text: '2 · How it should sound' }),
    el('div', { class: 'row' }, el('label', { text: 'Style' }), styleSeg), el('div', { class: 'row' }, el('label'), styleHint),
    slider('music', 'Music'), slider('effects', 'Sound FX'),
    check('duck', 'Dip the music while someone talks (smooth fades)', 'Music comes down under dialogue and back up in the gaps'),
    check('even', 'Even out the dialogue (Auto Level)', 'Quiet words up, loud ones down, on the dialogue tracks'),
    cleanRow(),
    check('tidy', 'Tidy tracks: put tracks of the same colour together to save space', 'Clips from plain tracks of the same colour move onto one track, keeping their time; empty tracks go. Tracks with their own effects or settings stay as they are'),
    el('p', { class: 'note am-promise', text: '▶ HEAR AUTO MIX sets the levels and plays the result. Nothing is kept until you press KEEP IT (DISCARD puts everything back).' }),
    bar, status),
  [{ label: 'Cancel', onClick: c => c() }, { label: '▶ HEAR AUTO MIX', cls: 'hw amber', onClick: async (close, btn) => {
    if (!Object.values(roles).some(Boolean)) { status.textContent = 'Give at least one track a colour first.'; return; }
    btn.disabled = true;
    save({ style: o.style, music: o.music, effects: o.effects, duck: o.duck, even: o.even, tidy: o.tidy, clean: o.clean });
    try { await run(app, roles, o, (t, f) => { status.textContent = t; bar.firstChild.style.width = Math.round(f * 100) + '%'; }); close(); }
    catch (e) { status.textContent = e.message; btn.disabled = false; }
  } }], { wide: true });
  void dlg;
  drawRows(); drawStyle();
}

async function run(app, roles, o, onStatus) {
  const doc = app.doc, before = structuredClone(doc);
  const startAt = app.player?.time || 0;
  const labelled = doc.tracks.filter(t => roles[t.id]);
  const clips = doc.clips.filter(c => roles[c.track] && c.type === 'media');
  const files = [...new Set(clips.map(c => soundFile(doc, c)).filter(Boolean))];
  const prof = new Map();
  for (const [i, f] of files.entries()) {
    onStatus(`Measuring the sound: file ${i + 1} of ${files.length}…`, i / files.length * 0.9);
    prof.set(f, await profileFor(app, f));
  }
  onStatus('Setting the levels…', 0.95);
  const loud = c => clipLoudness(prof.get(soundFile(doc, c)), c);
  const plan = planMix(doc, roles, loud, o);
  const tidy = o.tidy ? planTidy(doc, roles) : { moves: [], removed: [] };
  app.commit(d => {
    applyMix(d, plan, roles, () => ({ id: uid('fx'), type: 'level', params: {} }));
    applyTidy(d, tidy);
  });
  // what changed: per colour, how much it moved (shown as coloured chips)
  const S = STYLES[o.style];
  const chips = ROLE_ORDER.map(r => {
    const ps = plan.clips.filter(p => p.role === r);
    if (!ps.length) return null;
    const ch = ps.map(p => p.toDb - (Number.isFinite(p.fromDb) ? p.fromDb : 0));
    const lo = Math.min(...ch), hi = Math.max(...ch);
    const f = v => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(0)}`;
    const range = Math.round(lo) === Math.round(hi) ? `${f(lo)} dB` : `${f(lo)} to ${f(hi)} dB`;
    const arrow = hi + lo >= 0 ? '▲' : '▼';
    return { r, text: `${ROLES[r].label} ${arrow} ${range} · ${ps.length} clip${ps.length === 1 ? '' : 's'}` };
  }).filter(Boolean);
  const gap = Math.round(S.dialogue - (S.music + o.music));
  let summary = `Music sits ${gap} dB under the voices${o.duck ? ' and dips while they talk' : ''}.`;
  if (tidy.moves.length) summary += ` Tidied ${tidy.removed.length + (labelled.length - tidy.removed.length)} tracks into ${labelled.length - tidy.removed.length}.`;
  if (plan.skipped) summary += ` ${plan.skipped} silent clip${plan.skipped === 1 ? ' was' : 's were'} left alone.`;
  closeMixer();
  reviewBar(app, before, summary, chips, startAt);
  flash(plan.clips.map(p => p.id));
}

/** The mixer covers the editor; AUTO MIX's result is on the timeline and the preview bar, so close it. */
function closeMixer() {
  const desk = document.querySelector('.cs-desk');
  const modalBox = desk?.closest('.modal');
  modalBox?.querySelector('.modal-head .mini')?.click();
}
/** The clips AUTO MIX changed light up on the timeline for a few seconds. */
function flash(ids) {
  const go = () => {
    for (const id of ids) document.querySelector(`.clip[data-id="${CSS.escape(id)}"]`)?.classList.add('am-flash');
    setTimeout(() => document.querySelectorAll('.clip.am-flash').forEach(e => e.classList.remove('am-flash')), 3200);
  };
  requestAnimationFrame(() => requestAnimationFrame(go));
}

// ------------------------------------------------------------------ preview: keep or discard
function reviewBar(app, before, summary, chips = [], at = 0) {
  document.querySelector('.am-review')?.remove();
  let showing = 'mix', mixed = null;
  const restore = snap => { app.commit(d => { for (const k of Object.keys(d)) delete d[k]; Object.assign(d, structuredClone(snap)); }); app.renderAll?.(); };
  const ab = el('div', { class: 'seg', title: 'Flip between the auto mix and how it was' },
    el('button', { type: 'button', class: 'on', text: '⚖ AUTO MIX', 'data-v': 'mix' }), el('button', { type: 'button', text: 'BEFORE', 'data-v': 'orig' }));
  const show = v => {
    if (v === showing) return;
    if (v === 'orig') { mixed = structuredClone(app.doc); restore(before); } else restore(mixed);
    showing = v;
    for (const b of ab.children) b.classList.toggle('on', b.dataset.v === v);
    text.textContent = v === 'orig' ? 'How it was before (nothing changed)' : summary;
    chipRow.style.opacity = v === 'orig' ? '.35' : '';
    title.textContent = v === 'orig' ? 'BEFORE · LISTENING' : '✓ AUTO MIX DONE · LISTENING';
  };
  for (const b of ab.children) b.addEventListener('click', () => show(b.dataset.v));
  const close = () => bar.remove();
  const text = el('span', { class: 'ae-rv-sum', text: summary });
  const title = el('b', { class: 'ae-rv-title', text: '✓ AUTO MIX DONE · LISTENING' });
  const chipRow = el('div', { class: 'am-chips' }, ...chips.map(c => { const n = el('span', { class: 'am-chip ' + c.r, text: c.text }); n.style.setProperty('--role', ROLES[c.r].color); return n; }));
  const bar = el('div', { class: 'ae-review am-review' },
    el('div', { class: 'ae-rv-top' }, title, text),
    chipRow,
    el('div', { class: 'ae-rv-row' },
      el('button', { class: 'hw role-add', text: '▶ PLAY', onclick: () => { app.seek?.(at); if (!app.player.playing) app.player.toggle(); } }), ab,
      el('span', { class: 'ae-rv-gap' }),
      el('button', { class: 'hw', text: 'DISCARD', onclick: () => { if (showing !== 'orig') restore(before); close(); toast('Auto mix discarded: your levels are back as they were.'); } }),
      el('button', { class: 'hw', text: 'TRY ANOTHER…', onclick: () => { if (showing !== 'orig') restore(before); close(); openAutoMix(app); } }),
      el('button', { class: 'hw amber', text: 'KEEP IT', onclick: () => { show('mix'); close(); toast('Kept. Every level AUTO MIX set is an ordinary clip volume you can change, and ⌘Z steps back.', 5000); } })),
    el('span', { class: 'ae-rv-hint', text: 'Listen with A/B. Clip volumes, the music dip (on the orange tracks) and Auto Level (on the blue tracks) can all be changed by hand afterwards.' }));
  (document.getElementById('stage-wrap') || document.body).append(bar);
  // play it straight away from where you were, so you hear the change
  setTimeout(() => { app.seek?.(at); if (!app.player.playing) app.player.toggle(); }, 500);
}

/** Takes the auto mix off (undoable): your own levels and tracks come back. */
export function removeAutoMix(app) {
  if (!app.doc?.autoMix) { toast('There’s no auto mix on this project.'); return; }
  let n = 0;
  app.commit(d => { n = removeMix(d); });
  app.renderAll?.();
  toast(`Auto mix removed: ${n} clip${n === 1 ? ' is' : 's are'} back at your own level${n === 1 ? '' : 's'} and on ${n === 1 ? 'its' : 'their'} own track${n === 1 ? '' : 's'}. ⌘Z puts the mix back.`, 6000);
}

/** The AUTO MIX key lights while a project has an auto mix on it. */
export function watchMixKey(app) {
  let last = null;
  setInterval(() => {
    const b = document.getElementById('btn-automix'); if (!b) return;
    const on = !!app.doc?.autoMix;
    if (on === last) return;
    last = on;
    b.classList.toggle('lit', on);
    b.textContent = on ? '⚖ AUTO MIX ✓' : '⚖ AUTO MIX';
    b.title = on ? 'AUTO MIX is on: click to change it or take it off (⌥⌘M)' : 'AUTO MIX (⌥⌘M): sets dialogue, music and sound effects against each other. Colour your sound tracks first: blue dialogue, orange music, green sound FX';
  }, 700);
}
