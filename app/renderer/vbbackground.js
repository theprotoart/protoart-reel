// Word-for-word speech in the background (1.11): a new recording's microphone is written down while you're not working
// (after 15 s without a click, never while playing), so 💬 FILLER WORDS on it is instant later. Once per recording
// (the transcript is kept beside it); stopped by a new recording or another project, and quiet unless it finishes.
// Settings › Processing turns it off.
import { toast } from './ui.js';
import { pref } from './prefs.js';
import { ensureSource } from './fx.js';
import { speechPrefs } from './transcript.js';

let lastActivity = Date.now();
if (typeof window !== 'undefined') for (const ev of ['pointerdown', 'keydown', 'wheel']) window.addEventListener(ev, () => { lastActivity = Date.now(); }, { capture: true, passive: true });
const QUIET = 15000;
const queue = [];
let running = false;

/** After a recording is added: its microphone (or other sound-only) media, to write down when Reel is quiet. */
export function transcribeLater(app, mediaIds) {
  if (pref('vbBackground') === false || !app.api.verbatimWords) return;
  for (const id of mediaIds) if (!queue.some(q => q.id === id)) queue.push({ id, token: app.token });
  run(app);
}

async function run(app) {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const st = await app.api.verbatimStatus?.().catch(() => null);
      if (!st?.ready) { queue.length = 0; return; } // not set up: nothing to do
      // wait for a quiet moment: no clicks for a while, not playing, not recording
      while (Date.now() - lastActivity < QUIET || app.player?.playing || document.body.classList.contains('recording')) await new Promise(r => setTimeout(r, 3000));
      const job = queue.shift();
      if (job.token !== app.token) continue; // another project now
      const m = app.doc?.media.find(x => x.id === job.id);
      if (!m || !(m.kind === 'audio' || m.hasAudio)) continue;
      try {
        const src = m.kind === 'audio' && /\.wav$/i.test(m.file) ? m.file : await ensureSource(app, m);
        if (job.token !== app.token) continue;
        const r = await app.api.verbatimWords(app.token, src, speechPrefs().locale, 0, m.duration || 1e9);
        if (r && !r.cached) toast(`✍ “${m.name}” is written down word for word: 💬 FILLER WORDS on it is instant now.`, 4000);
      } catch { /* stopped (a new recording frees the memory) or failed: FILLER WORDS does it when asked */ }
    }
  } finally { running = false; }
}
