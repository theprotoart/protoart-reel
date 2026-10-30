// TAKES: when a line goes wrong while recording, clap three times (or press MARK, ⌥⇧⌘M) and say it again.
// Every clap signal and MARK splits the recording into takes, like the takes of a voice-over: the take before
// each clap is the one that went wrong, so it's marked DROP, and the last take is kept. Listen to any take,
// switch KEEP / DROP, then REMOVE DROPPED TAKES cuts those (with their claps) and closes the gaps.
import { el, toast } from './ui.js';
import { mediaById, clipEnd, duration, removeRange } from './model.js';
import { openClapFinder } from './clapscan.js';

const isTakeMark = m => m.claps || m.mark;
const fmt = t => { const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${String(s).padStart(2, '0')}`; };

/** The project's takes, per recording: [{ name, takes: [{ t0, t1, cutTo, marker, keep, last }] }]. */
export function takesOf(doc) {
  const marks = (doc.markers || []).filter(isTakeMark).sort((a, b) => a.t - b.t);
  if (!marks.length) return [];
  // each recording's stretch of the timeline (its clips may have been cut up: the whole span counts)
  const spans = new Map();
  for (const c of doc.clips) {
    const m = c.type === 'media' && mediaById(doc, c.media);
    const key = m?.recording || null;
    if (!key) continue;
    const s = spans.get(key) || { t0: Infinity, t1: 0, name: (m.name || '').replace(/^(Screen|Microphone|Camera|Computer audio)\s*/, 'Recording ') };
    s.t0 = Math.min(s.t0, c.start); s.t1 = Math.max(s.t1, clipEnd(c));
    spans.set(key, s);
  }
  const groups = [...spans.values()].sort((a, b) => a.t0 - b.t0);
  // marks outside every recording (imported video): the whole timeline is one stretch
  if (marks.some(k => !groups.some(g => k.t >= g.t0 - 0.05 && k.t <= g.t1 + 0.05))) groups.push({ t0: 0, t1: duration(doc), name: 'Timeline', loose: true });
  const out = [];
  for (const g of groups) {
    const ks = marks.filter(k => k.t > g.t0 + 0.05 && k.t < g.t1 - 0.05 && (g.loose ? !groups.some(o => !o.loose && k.t >= o.t0 && k.t <= o.t1) : true));
    if (!ks.length) continue;
    const takes = [];
    let at = g.t0;
    for (const k of ks) {
      takes.push({ t0: at, t1: k.t, cutTo: Math.max(k.t, k.end || k.t), marker: k, keep: !!k.keepTake, last: false });
      at = Math.max(k.t, k.end || k.t);
    }
    takes.push({ t0: at, t1: g.t1, cutTo: g.t1, marker: null, keep: true, last: true });
    out.push({ name: g.name || 'Recording', takes: takes.filter(t => t.t1 - t.t0 > 0.05 || t.last) });
  }
  return out;
}
export const takeCount = doc => takesOf(doc).reduce((n, g) => n + g.takes.length, 0);

let panel = null;
export function openTakes(app) {
  if (panel) { panel.refresh(); panel.root.classList.add('flash'); setTimeout(() => panel?.root.classList.remove('flash'), 600); return; }
  const list = el('div', { class: 'takes-list' });
  const removeBtn = el('button', { class: 'hw amber', text: 'REMOVE DROPPED TAKES' });
  const findBtn = el('button', { class: 'hw', text: '👏 LISTEN FOR CLAPS', title: 'Listen to the selected clip (or every microphone recording) for three claps in a row, and mark each one' });
  const root = el('div', { class: 'vo-panel takes-panel' },
    el('div', { class: 'vo-head' }, el('b', { text: '✂ TAKES' }), el('span', { class: 'spacer' }), el('button', { class: 'mini', text: '×', title: 'Close', onclick: () => close() })),
    el('p', { class: 'note takes-how' },
      el('b', { text: 'Messed up a line? ' }),
      'Clap three times (or press ⌥⇧⌘M / MARK on the recording panel), pause, and say it again. Reel splits the recording at each clap into takes. The take before a clap is marked DROP; the last one is kept. Listen, switch any of them, then remove the dropped ones.'),
    list,
    el('div', { class: 'takes-foot' }, findBtn, removeBtn));
  document.body.append(root);
  let sig = '';
  const refresh = (force = false) => {
    const doc = app.doc;
    if (!doc) { close(); return; }
    const groups = takesOf(doc);
    const now = JSON.stringify(groups.map(g => g.takes.map(t => [t.t0.toFixed(2), t.t1.toFixed(2), t.keep])));
    if (!force && now === sig) return;
    sig = now;
    const dropped = groups.flatMap(g => g.takes.filter(t => !t.keep));
    removeBtn.textContent = dropped.length ? `REMOVE ${dropped.length} DROPPED TAKE${dropped.length === 1 ? '' : 'S'}` : 'REMOVE DROPPED TAKES';
    removeBtn.disabled = !dropped.length;
    if (!groups.length) {
      list.replaceChildren(el('p', { class: 'takes-empty', text: 'No takes yet. Record with REC and clap three times after a line that went wrong (Reel listens when the recording ends), or select a clip and press LISTEN FOR CLAPS.' }));
      return;
    }
    list.replaceChildren(...groups.flatMap(g => [
      el('div', { class: 'engr takes-rec', text: g.name }),
      ...g.takes.map((t, i) => {
        const play = el('button', { class: 'mini', text: '▶', title: 'Play this take', onclick: () => { app.seek(t.t0); if (!app.player.playing) app.player.toggle(); stopAt(t.t1); } });
        const toggle = t.last ? el('span', { class: 'take-state keep', text: 'KEEP', title: 'The last take is kept' })
          : el('button', { class: 'take-state ' + (t.keep ? 'keep' : 'drop'), text: t.keep ? 'KEEP' : 'DROP', title: t.keep ? 'Kept. Click to drop this take' : 'Dropped when you press REMOVE. Click to keep it', onclick: () => {
            app.commit(d => { const k = (d.markers || []).find(x => x.id === t.marker.id); if (k) k.keepTake = !t.keep || undefined; });
            refresh(true);
          } });
        return el('div', { class: 'take-row' + (t.keep ? '' : ' dropped') }, play,
          el('span', { class: 'take-name', text: `Take ${i + 1}` }),
          el('span', { class: 'take-time', text: `${fmt(t.t0)} – ${fmt(t.t1)} · ${Math.max(0, t.t1 - t.t0).toFixed(1)} s`, onclick: () => app.seek(t.t0), title: 'Go to this take' }),
          toggle);
      }),
    ]));
  };
  let stopTimer = null;
  const stopAt = t1 => {
    clearInterval(stopTimer);
    stopTimer = setInterval(() => { if (!app.player.playing) { clearInterval(stopTimer); return; } if (app.player.time >= t1) { app.player.toggle(); clearInterval(stopTimer); } }, 50);
  };
  removeBtn.addEventListener('click', () => {
    const cuts = takesOf(app.doc).flatMap(g => g.takes.filter(t => !t.keep)).map(t => [t.t0, t.cutTo]).sort((a, b) => b[0] - a[0]);
    if (!cuts.length) return;
    let total = 0;
    app.commit(d => { for (const [a, b] of cuts) total += removeRange(d, a, b); });
    toast(`Removed ${cuts.length} take${cuts.length === 1 ? '' : 's'} (${total.toFixed(1)} s), with their claps. ⌘Z brings them back.`, 5000);
    refresh(true);
  });
  findBtn.addEventListener('click', () => openClapFinder(app));
  const timer = setInterval(() => refresh(), 700);
  const close = () => { clearInterval(timer); clearInterval(stopTimer); root.remove(); panel = null; };
  panel = { root, refresh: () => refresh(true), close };
  refresh(true);
}
export function closeTakes() { panel?.close(); }

/** The ✂ TAKES key in the top bar shows how many takes the project has. */
export function initTakesButton(app) {
  const b = document.getElementById('btn-takes');
  if (!b) return;
  b.addEventListener('click', () => app.cmd('takes'));
  const badge = b.querySelector('.n');
  setInterval(() => {
    const n = app.doc ? takeCount(app.doc) : 0;
    if (badge) badge.textContent = n ? String(n) : '';
    b.classList.toggle('has', n > 0);
  }, 1000);
}
